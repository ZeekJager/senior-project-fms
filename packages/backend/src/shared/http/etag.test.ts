import { describe, expect, test } from 'vitest';
import { AppError } from '../errors/app-error';
import { etagFor, ifMatchVersion } from './etag';

describe('ETag / If-Match', () => {
  test('a version round-trips through the ETag', () => {
    expect(etagFor(3)).toBe('"3"');
    expect(ifMatchVersion(etagFor(3))).toBe(3);
    expect(ifMatchVersion('W/"12"')).toBe(12);
  });

  test('no header or * means no precondition', () => {
    expect(ifMatchVersion(undefined)).toBeNull();
    expect(ifMatchVersion('')).toBeNull();
    expect(ifMatchVersion('*')).toBeNull();
  });

  test.each(['3', '"abc"', '"1", "2"', '"-1"'])('rejects %j with 400', (value) => {
    expect(() => ifMatchVersion(value)).toThrow(AppError);
    try {
      ifMatchVersion(value);
    } catch (err) {
      expect((err as AppError).details).toEqual([{ field: 'If-Match', reason: 'invalid_format' }]);
    }
  });
});
