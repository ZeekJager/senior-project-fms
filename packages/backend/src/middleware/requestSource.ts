import type { NextFunction, Request, Response } from 'express';
import { withRequestSource, type Channel, type RequestSource } from '../shared/infrastructure/request-source';

/** The browser app sends `X-Client-Channel: pwa` when installed (display-mode standalone). */
export const CLIENT_CHANNEL_HEADER = 'X-Client-Channel';

/**
 * Records where the request came from for every audit row it writes (FMS-27):
 * the channel, the IP and the user agent. A client can only say web or pwa;
 * job and webhook are set by the server (scheduler, webhook routes), never
 * taken from a header. Mounted after the body parsers, which would otherwise
 * drop the async context; asyncHandler re-enters it from `req.requestSource`
 * for handlers that run after a streaming parser (multipart uploads).
 */
export function requestSource(req: Request, _res: Response, next: NextFunction): void {
  const channel: Channel = req.get(CLIENT_CHANNEL_HEADER)?.trim().toLowerCase() === 'pwa' ? 'pwa' : 'web';
  req.requestSource = { channel, ip: req.ip ?? null, user_agent: req.get('user-agent') ?? null };
  withRequestSource(req.requestSource, next);
}

/** For routes called by other systems (FMS integration webhooks): their channel is webhook. */
export function webhookChannel(req: Request, _res: Response, next: NextFunction): void {
  req.requestSource = { ...(req.requestSource as RequestSource), channel: 'webhook' };
  withRequestSource(req.requestSource, next);
}
