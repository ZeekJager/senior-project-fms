import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../shared/errors/app-error';
import { policyOf } from '../../../shared/authz/route-policy';
import type { RequestUser } from '../../../types/express';
import { authenticatedWith, authorizeWith } from './authorize';

function user(permissions: string[], roles: string[] = ['dispatcher']): RequestUser {
  return { id: '1', publicId: 'p', roles, permissions, depotId: '1' };
}

/** Runs the handlers in order with a request that `authenticate` would have filled in. */
async function run(handlers: RequestHandler[], caller: RequestUser | undefined): Promise<unknown> {
  const req = { user: caller } as Request;
  let outcome: unknown = 'passed';
  for (const handler of handlers.slice(1)) {
    const next: NextFunction = (err?: unknown) => {
      if (err) outcome = err;
    };
    handler(req, {} as Response, next);
    if (outcome !== 'passed') break;
  }
  return outcome;
}

const authenticate: RequestHandler = (_req, _res, next) => next();
const authorize = authorizeWith(authenticate);

describe('authorize', () => {
  it('lets a caller holding the permission through', async () => {
    expect(await run(authorize('vehicle:read'), user(['vehicle:read']))).toBe('passed');
  });

  it('answers 403 FORBIDDEN_INSUFFICIENT_ROLE when the permission is missing', async () => {
    const err = await run(authorize('vehicle:write'), user(['vehicle:read']));
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 403, code: 'FORBIDDEN_INSUFFICIENT_ROLE' });
  });

  it('answers 401, never 403, when nobody is signed in', async () => {
    for (const caller of [undefined, { ...user([]), id: null }]) {
      expect(await run(authorize('vehicle:read'), caller)).toMatchObject({ status: 401, code: 'AUTH_TOKEN_INVALID' });
    }
  });

  it('accepts any one of several codes', async () => {
    expect(await run(authorize('alert:resolve', 'alert:ack'), user(['alert:ack']))).toBe('passed');
    expect(await run(authorize('alert:resolve', 'alert:ack'), user(['alert:read']))).toMatchObject({ status: 403 });
  });

  it('decides on permission codes, so a role called admin with no grants gets nothing', async () => {
    expect(await run(authorize('users:write'), user([], ['admin']))).toMatchObject({ status: 403 });
  });

  it('matches whole codes, not prefixes or substrings', async () => {
    expect(await run(authorize('vehicle:read'), user(['vehicle:readonly', 'vehicle']))).toMatchObject({ status: 403 });
  });

  it('runs authenticate first and declares its policy for the startup guard', () => {
    const handlers = authorize('fuel:write');
    expect(handlers[0]).toBe(authenticate);
    expect(policyOf(handlers[1])).toEqual({ kind: 'permission', codes: ['fuel:write'] });
  });
});

describe('authenticated', () => {
  const authenticated = authenticatedWith(authenticate);

  it('declares the authenticated policy and runs authenticate first', () => {
    const handlers = authenticated();
    expect(handlers[0]).toBe(authenticate);
    expect(policyOf(handlers[1])).toEqual({ kind: 'authenticated' });
  });
});
