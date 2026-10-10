import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { AppError } from '../errors/app-error';
import { parseInput, rejectFractionalMoney } from './validate';

const schema = rejectFractionalMoney(
  z.strictObject({ total_cost_cents: z.number().int(), labour_hours: z.number(), parts: z.array(z.strictObject({ unit_cost_cents: z.number().int() })) }),
);

function errorOf(input: unknown): AppError {
  try {
    parseInput(schema, input);
  } catch (err) {
    return err as AppError;
  }
  throw new Error('expected a validation error');
}

describe('rejectFractionalMoney', () => {
  test('a fraction in any money-like field, by any name or depth, is VALIDATION_FLOAT_IN_MONEY_PATH', () => {
    for (const [input, field] of [
      [{ totalCost: 1500.5 }, 'totalCost'],
      [{ total_cost_cents: 10.25 }, 'total_cost_cents'],
      [{ parts: [{ unit_cost_cents: 1 }, { unitPrice: 0.5 }] }, 'parts.1.unitPrice'],
      [{ fuel_ml: 12.5 }, 'fuel_ml'],
    ] as const) {
      const err = errorOf(input);
      expect(err.code, field).toBe('VALIDATION_FLOAT_IN_MONEY_PATH');
      expect(err.details).toEqual([{ field, reason: 'float_in_money_path' }]);
    }
  });

  test('other decimals and whole money pass through to the schema', () => {
    expect(parseInput(schema, { total_cost_cents: 150000, labour_hours: 2.5, parts: [{ unit_cost_cents: 4500 }] })).toEqual({
      total_cost_cents: 150000,
      labour_hours: 2.5,
      parts: [{ unit_cost_cents: 4500 }],
    });
    expect(errorOf({ total_cost_cents: 1, labour_hours: 1, parts: [], extra: true }).code).toBe('VALIDATION_FAILED');
  });
});
