import type { z } from 'zod';
import { validationFailed } from '../errors/app-error';

/**
 * Parses a request body or query with a zod schema, or throws 400
 * VALIDATION_FAILED naming each bad field. Input values are never echoed,
 * since they may be passwords.
 */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  throw validationFailed(
    result.error.issues.map((issue) => ({
      ...(issue.path.length ? { field: issue.path.join('.') } : {}),
      reason: issue.code,
    })),
  );
}
