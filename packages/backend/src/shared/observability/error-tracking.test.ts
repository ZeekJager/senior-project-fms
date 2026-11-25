import type { Request, Response } from 'express';
import { describe, expect, test, vi } from 'vitest';
import { errorHandler } from '../../middleware/errorHandler';
import { AppError } from '../errors/app-error';
import { flushErrorTracking, initErrorTracking, scrubEvent, scrubText } from './error-tracking';

// FMS-109: a thrown error appears in error tracking with the request id, and nothing personal goes with it.

describe('error tracking', () => {
  test('an error the API answers 500 for is sent with its request id, method and route; masked', async () => {
    const sent: unknown[] = [];
    initErrorTracking({
      dsn: 'https://public@glitchtip.example/1',
      environment: 'test',
      transport: () => ({
        send: async (envelope: unknown) => {
          sent.push(envelope);
          return {};
        },
        flush: async () => true,
      }),
    });

    const req = {
      correlationId: 'req-7f3a',
      method: 'POST',
      baseUrl: '/api/v1',
      route: { path: '/trips/:tripId/complete' },
      user: { publicId: 'u-public-1' },
    } as unknown as Request;
    const res = { headersSent: false, locals: {}, set: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    errorHandler(new Error('Could not complete the trip of abebe@example.com (+251 911 234 567), token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc'), req, res, () => {});
    expect(res.status).toHaveBeenCalledWith(500);
    await flushErrorTracking();

    const items = (sent as [unknown, [{ type: string }, Record<string, unknown>][]][]).flatMap(([, list]) => list);
    const event = items.find(([h]) => h.type === 'event')?.[1] as { tags: Record<string, string>; exception: { values: { value: string }[] }; user?: { id: string } };
    expect(event).toBeDefined();
    expect(event.tags).toMatchObject({ request_id: 'req-7f3a', method: 'POST', route: '/api/v1/trips/:tripId/complete' });
    expect(event.user).toEqual({ id: 'u-public-1' });
    const text = JSON.stringify(event);
    expect(text).not.toContain('abebe@example.com');
    expect(text).not.toContain('911 234 567');
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(event.exception.values[0].value).toContain('[email]');
  });

  test('a 4xx is not an error to track', async () => {
    const before = vi.fn();
    const res = { headersSent: false, locals: {}, set: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    errorHandler(new AppError(404, 'NOT_FOUND', 'No such trip.'), { correlationId: 'r', method: 'GET', baseUrl: '' } as unknown as Request, res, before);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('the scrubbing keeps the method and path only, and masks what identifies a person', () => {
    expect(scrubText('Bearer abc.def-ghi failed for x@y.io at 0911234567')).toBe('Bearer [Filtered] failed for [email] at [number]');
    const out = scrubEvent({
      type: undefined,
      request: { method: 'GET', url: 'https://fms.example/api/v1/drivers?email=x@y.io', headers: { cookie: 'fms_session=1' }, data: '{"password":"p"}' },
      user: { id: 'u-1', email: 'x@y.io', ip_address: '10.0.0.1' },
      extra: { password: 'p', note: 'call 0911 234 567' },
      server_name: 'host-1',
    });
    expect(out.request).toEqual({ method: 'GET', url: 'https://fms.example/api/v1/drivers' });
    expect(out.user).toEqual({ id: 'u-1' });
    expect(out.extra).toEqual({ password: '[Filtered]', note: 'call [number]' });
    expect(out.server_name).toBeUndefined();
  });
});
