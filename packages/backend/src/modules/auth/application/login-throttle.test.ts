import { describe, expect, test } from 'vitest';
import { InMemoryLoginThrottle } from './login-throttle';

const MINUTE = 60_000;

function throttleAt(start = 0) {
  const clock = { now: start };
  return { clock, throttle: new InMemoryLoginThrottle(5, 15 * 60, () => clock.now) };
}

describe('InMemoryLoginThrottle', () => {
  test('allows five failures and blocks the sixth attempt', () => {
    const { throttle } = throttleAt();
    for (let i = 0; i < 5; i++) {
      expect(throttle.retryAfter('a|1.1.1.1')).toBe(0);
      throttle.recordFailure('a|1.1.1.1');
    }
    expect(throttle.retryAfter('a|1.1.1.1')).toBe(15 * 60);
  });

  test('unblocks when the oldest counted failure leaves the 15-minute window', () => {
    const { clock, throttle } = throttleAt();
    for (let i = 0; i < 5; i++) {
      throttle.recordFailure('k');
      clock.now += MINUTE;
    }
    // Failures at minutes 0..4; now minute 5. The first expires at minute 15.
    expect(throttle.retryAfter('k')).toBe(10 * 60);
    clock.now = 15 * MINUTE;
    expect(throttle.retryAfter('k')).toBe(0);
  });

  test('keys are independent: another account or IP is not blocked', () => {
    const { throttle } = throttleAt();
    for (let i = 0; i < 5; i++) throttle.recordFailure('a@x|1.1.1.1');
    expect(throttle.retryAfter('a@x|2.2.2.2')).toBe(0);
    expect(throttle.retryAfter('b@x|1.1.1.1')).toBe(0);
  });

  test('reset clears the count after a successful login', () => {
    const { throttle } = throttleAt();
    for (let i = 0; i < 4; i++) throttle.recordFailure('k');
    throttle.reset('k');
    throttle.recordFailure('k');
    expect(throttle.retryAfter('k')).toBe(0);
  });
});
