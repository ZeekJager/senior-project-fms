import { createTransport } from 'nodemailer';
import { z } from 'zod';
import { DeliveryRefused, ProviderCallError, type AdapterContext, type DeliveryReceipt, type OutboundMessage, type ProviderAdapter } from '../domain/adapter';
import { encryptPushPayload, MAX_PAYLOAD_BYTES, PUSH_SERVICE_HOSTS, pushEndpointProblem, pushTopic, vapidAuthorization } from '../domain/web-push';

// Notification providers (FMS-93, docs/notification-channels.md): every integration.external_providers row of
// type `notification` without an adapter of its own uses this one. Its `configuration.channel` says what it
// delivers, and the rest of `configuration` how:
//
//   email  SMTP: host, port (587), tls (starttls | implicit | none), username, from. The password is the API key.
//   sms    The FMS SMS format, over HTTP: POST <base_url><path> (/messages) with { to, text, sender, reference },
//          Authorization: Bearer <api key> and Idempotency-Key: <reference>; answers 2xx with { id } (or
//          { message_id }). An SMS vendor with another API gets an adapter of its own, registered by its code.
//   push   Web Push with VAPID: vapid_public_key, subject (mailto: or https:). The VAPID private key is the API key.

const emailSettings = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(587),
  tls: z.enum(['starttls', 'implicit', 'none']).default('starttls'),
  username: z.string().min(1).optional(),
  from: z.string().min(3),
});
const smsSettings = z.object({ path: z.string().startsWith('/').default('/messages'), sender: z.string().min(1).max(20).optional() });
const pushSettings = z.object({ vapid_public_key: z.string().min(80).max(100), subject: z.string().regex(/^(mailto:|https:)/) });
const smsAnswer = z.object({ id: z.union([z.string(), z.number()]).optional(), message_id: z.union([z.string(), z.number()]).optional() });

export interface NotificationAdapterOptions {
  /** Hosts a push endpoint may be on (the browsers' push services unless given: tests use a local server). */
  pushHosts?: readonly string[];
  /** Allow http push endpoints (tests only). */
  allowHttpPush?: boolean;
}

/** Settings a row must have; a row without them is a configuration mistake, retried until it is fixed. */
function settings<T>(schema: z.ZodType<T>, ctx: AdapterContext): T {
  const parsed = schema.safeParse(ctx.provider.configuration);
  if (!parsed.success) {
    const field = parsed.error.issues[0].path.join('.');
    throw new ProviderCallError('network', `${ctx.provider.code} is not set up: configuration.${field} is missing or wrong.`);
  }
  return parsed.data;
}

const short = (id: string | number | undefined | null) => (id === undefined || id === null ? null : String(id).slice(0, 255));

export function notificationAdapter(code: string, options: NotificationAdapterOptions = {}): ProviderAdapter {
  const pushHosts = options.pushHosts ?? PUSH_SERVICE_HOSTS;
  const destinationProblem = (configuration: Record<string, unknown>, to: OutboundMessage['to']): string | null => {
    if (configuration.channel === 'push') return to.push ? pushEndpointProblem(to.push.endpoint, pushHosts, options.allowHttpPush) : 'no_subscription';
    if (configuration.channel === 'sms') return to.phone ? null : 'no_phone';
    if (configuration.channel === 'email') return to.email ? null : 'no_email';
    return 'unknown_channel';
  };
  return {
    code,

    async healthCheck(ctx) {
      if (ctx.provider.configuration.channel === 'email') {
        const transport = smtpTransport(ctx);
        try {
          await ctx.guard(() => smtp(() => transport.verify()));
        } finally {
          transport.close();
        }
      } else if (ctx.provider.configuration.channel === 'sms') {
        await ctx.client.call({ method: 'GET', path: '/health' });
      }
    },

    destinationProblem,

    async deliver(ctx, message) {
      const channel = ctx.provider.configuration.channel;
      if (channel !== message.channel) throw new ProviderCallError('network', `${ctx.provider.code} delivers ${String(channel)}, not ${message.channel}.`);
      const problem = destinationProblem(ctx.provider.configuration, message.to);
      if (problem) throw new DeliveryRefused('invalid_destination', `The ${message.channel} address cannot be used (${problem}).`);
      if (channel === 'email') return sendEmail(ctx, message);
      if (channel === 'sms') return sendSms(ctx, message);
      return sendPush(ctx, message);
    },
  };
}

function smtpTransport(ctx: AdapterContext) {
  const s = settings(emailSettings, ctx);
  return createTransport({
    host: s.host,
    port: s.port,
    secure: s.tls === 'implicit',
    requireTLS: s.tls === 'starttls',
    ignoreTLS: s.tls === 'none',
    auth: s.username ? { user: s.username, pass: ctx.apiKey ?? '' } : undefined,
    connectionTimeout: ctx.timeoutMs,
    greetingTimeout: ctx.timeoutMs,
    socketTimeout: ctx.timeoutMs,
  });
}

/**
 * An SMTP call, its failures in the gateway's terms: a 5xx about the recipient is refused for good; a timeout,
 * a connection or TLS failure, a 4xx or a rejected login is the provider (or its set-up) and worth a retry.
 * Messages never hold the address or the server's reply text.
 */
async function smtp<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    const e = err as { code?: string; responseCode?: number };
    if (e.code === 'EENVELOPE' && (e.responseCode ?? 0) >= 500) throw new DeliveryRefused('recipient_rejected', `The mail server refused the recipient (${e.responseCode}).`);
    if (e.code === 'ETIMEDOUT') throw new ProviderCallError('timeout', 'The mail server timed out.');
    if (e.code === 'EAUTH') throw new ProviderCallError('http', 'The mail server refused the login.', 503);
    if (e.responseCode) throw new ProviderCallError('http', `The mail server answered ${e.responseCode}.`, e.responseCode >= 500 ? 502 : 503);
    throw new ProviderCallError('network', `The mail server could not be reached (${e.code ?? 'error'}).`);
  }
}

async function sendEmail(ctx: AdapterContext, message: OutboundMessage): Promise<DeliveryReceipt> {
  const { from } = settings(emailSettings, ctx);
  const transport = smtpTransport(ctx);
  try {
    const info = await ctx.guard(() =>
      smtp(() =>
        transport.sendMail({
          from,
          to: message.to.name ? { name: message.to.name, address: message.to.email! } : message.to.email!,
          subject: message.subject,
          text: message.text,
          headers: { 'X-FMS-Reference': message.reference, 'Auto-Submitted': 'auto-generated' },
        }),
      ),
    );
    return { messageId: short(info.messageId) };
  } finally {
    transport.close();
  }
}

async function sendSms(ctx: AdapterContext, message: OutboundMessage): Promise<DeliveryReceipt> {
  const s = settings(smsSettings, ctx);
  const res = await ctx.client.call({
    method: 'POST',
    path: s.path,
    headers: { ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}), 'idempotency-key': message.reference },
    body: { to: message.to.phone, text: message.text, sender: s.sender ?? null, reference: message.reference },
    // The provider de-duplicates on the Idempotency-Key, so a retry of the same message is safe.
    idempotent: true,
  });
  const body = smsAnswer.safeParse(res.body);
  return { messageId: body.success ? short(body.data.id ?? body.data.message_id) : null };
}

async function sendPush(ctx: AdapterContext, message: OutboundMessage): Promise<DeliveryReceipt> {
  const s = settings(pushSettings, ctx);
  if (!ctx.apiKey) throw new ProviderCallError('network', `${ctx.provider.code} is not set up: its VAPID private key (API key) is missing.`);
  const target = message.to.push!;
  const payload = Buffer.from(JSON.stringify({ title: message.subject, body: message.text, data: message.data ?? {} }));
  if (payload.length > MAX_PAYLOAD_BYTES) throw new DeliveryRefused('payload_too_large', 'The push message is too long.');
  const url = new URL(target.endpoint);
  const authorization = await vapidAuthorization(target.endpoint, { publicKey: s.vapid_public_key, privateKey: ctx.apiKey }, s.subject);
  try {
    const res = await ctx.clientFor(url.origin).call({
      method: 'POST',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: {
        authorization,
        'content-type': 'application/octet-stream',
        'content-encoding': 'aes128gcm',
        ttl: String(message.ttlSeconds),
        urgency: message.urgency,
        topic: pushTopic(message.reference),
      },
      bytes: encryptPushPayload(target, payload),
      // The Topic makes a resend replace the first if it is still waiting at the push service.
      idempotent: true,
    });
    const location = res.headers.get('location');
    return { messageId: short(location ? location.split('/').filter(Boolean).at(-1) : null) };
  } catch (err) {
    // 404 and 410: the browser unsubscribed, or the subscription expired. It never comes back.
    if (err instanceof ProviderCallError && (err.status === 404 || err.status === 410)) throw new DeliveryRefused('subscription_expired', 'The push subscription has expired.');
    if (err instanceof ProviderCallError && err.status === 413) throw new DeliveryRefused('payload_too_large', 'The push service refused the message size.');
    throw err;
  }
}
