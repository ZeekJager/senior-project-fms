import { describe, expect, test } from 'vitest';
import { expiryLevel } from './expiry';

describe('expiryLevel', () => {
  test('amber within 30 days, red within 7 (the expiry day included), nothing outside the window', () => {
    expect([31, 30, 15, 8, 7, 1, 0, -1].map((d) => expiryLevel(d))).toEqual([null, 'amber', 'amber', 'amber', 'red', 'red', 'red', null]);
  });

  test('the amber window is the expiry_warning_days setting (FMS-80); red stays at 7', () => {
    expect([61, 60, 45, 8, 7].map((d) => expiryLevel(d, 60))).toEqual([null, 'amber', 'amber', 'amber', 'red']);
  });
});
