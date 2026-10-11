import { describe, expect, test } from 'vitest';
import { expiryLevel } from './expiry';

describe('expiryLevel', () => {
  test('amber within 30 days, red within 7 (the expiry day included), nothing outside the window', () => {
    expect([31, 30, 15, 8, 7, 1, 0, -1].map(expiryLevel)).toEqual([null, 'amber', 'amber', 'amber', 'red', 'red', 'red', null]);
  });
});
