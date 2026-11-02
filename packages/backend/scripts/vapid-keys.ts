/**
 * Makes a VAPID key pair for Web Push (FMS-93, docs/notification-channels.md) and prints where each half goes:
 *
 *   npm run push:keys -- --code web-push
 *
 * The public key goes in the push provider's configuration (`vapid_public_key`); the private key is a secret,
 * for the environment only (INTEGRATION_<CODE>_API_KEY), never the database. Changing the pair later makes every
 * browser subscribe again, so make it once per environment.
 */
import { parseArgs } from 'node:util';
import { generateVapidKeys } from '../src/modules/integration/domain/web-push';

const { values } = parseArgs({ options: { code: { type: 'string', default: 'web-push' } } });
const code = values.code!;
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(code)) throw new Error('--code is the provider code: lowercase letters, digits and hyphens.');

const keys = generateVapidKeys();
const env = `INTEGRATION_${code.toUpperCase().replace(/-/g, '_')}_API_KEY`;
process.stdout.write(
  [
    `Provider configuration (integration.external_providers, code '${code}'):`,
    `  { "channel": "push", "vapid_public_key": "${keys.publicKey}", "subject": "mailto:<operations address>" }`,
    '',
    `Secret, for the backend's environment only:`,
    `  ${env}=${keys.privateKey}`,
    '',
  ].join('\n'),
);
