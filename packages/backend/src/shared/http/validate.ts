import type { z } from 'zod';
import { AppError, type ErrorDetail } from '../errors/app-error';

/**
 * Reason a schema puts in a custom issue's `params` for a fractional value in
 * a money or fuel field (see `integerFuelOrMoney`). It turns the response into
 * 400 VALIDATION_FLOAT_IN_MONEY_PATH (api-contract §17).
 */
export const FLOAT_IN_MONEY_PATH = 'float_in_money_path';

function detailsOf(issue: z.core.$ZodIssue): ErrorDetail[] {
  const field = issue.path.length ? { field: issue.path.join('.') } : {};
  if (issue.code === 'unrecognized_keys') {
    // One entry per field the API does not accept (contract §17: only
    // documented writable fields are accepted).
    return issue.keys.map((key) => ({ field: [...issue.path, key].join('.'), reason: 'not_writable' }));
  }
  if (issue.code === 'custom' && typeof issue.params?.reason === 'string') {
    return [{ ...field, reason: issue.params.reason }];
  }
  if (issue.code === 'invalid_value') return [{ ...field, reason: 'invalid_enum' }];
  return [{ ...field, reason: issue.code }];
}

/**
 * Parses a request body or query with a zod schema, or throws 400 naming each
 * bad field. The code is VALIDATION_FLOAT_IN_MONEY_PATH when any money or fuel
 * field had a fraction, VALIDATION_INVALID_ENUM when every problem is a value
 * outside its allowed set, and VALIDATION_FAILED otherwise. Input values are
 * never echoed, since they may be passwords.
 */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;

  const details = result.error.issues.flatMap(detailsOf);
  if (details.some((d) => d.reason === FLOAT_IN_MONEY_PATH)) {
    throw new AppError(400, 'VALIDATION_FLOAT_IN_MONEY_PATH', 'Money and fuel values must be whole numbers of their minor unit.', details);
  }
  if (details.every((d) => d.reason === 'invalid_enum')) {
    throw new AppError(400, 'VALIDATION_INVALID_ENUM', 'A value is not one of the allowed values.', details);
  }
  throw new AppError(400, 'VALIDATION_FAILED', 'The request is invalid.', details);
}
