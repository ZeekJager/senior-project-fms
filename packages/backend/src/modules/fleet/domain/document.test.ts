import { describe, expect, test } from 'vitest';
import { cleanFilename, sniffContentType } from './document';

describe('sniffContentType', () => {
  test('recognises JPEG, PNG and PDF by their first bytes', () => {
    expect(sniffContentType(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]))).toBe('image/jpeg');
    expect(sniffContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe('image/png');
    expect(sniffContentType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
  });

  test.each([
    ['text renamed .pdf', Buffer.from('hello, this is text')],
    ['empty', Buffer.alloc(0)],
    ['a truncated PNG signature', Buffer.from([0x89, 0x50, 0x4e])],
    ['GIF', Buffer.from('GIF89a')],
    ['HTML', Buffer.from('<html><script>alert(1)</script>')],
    ['PDF marker not at the start', Buffer.from(' %PDF-1.7')],
  ])('rejects %s', (_name, bytes) => {
    expect(sniffContentType(bytes)).toBeNull();
  });
});

describe('cleanFilename', () => {
  test('keeps only the name, without control characters, at most 255 characters', () => {
    expect(cleanFilename('C:\\Users\\a\\licence.pdf')).toBe('licence.pdf');
    expect(cleanFilename('../../etc/passwd')).toBe('passwd');
    expect(cleanFilename('ins\u0000ur\u001fance.pdf')).toBe('insurance.pdf');
    expect(cleanFilename(`${'a'.repeat(300)}.pdf`)).toHaveLength(255);
    expect(cleanFilename('Ré gistration.pdf')).toBe('Ré gistration.pdf');
  });

  test('nothing usable gives null', () => {
    expect(cleanFilename(undefined)).toBeNull();
    expect(cleanFilename('')).toBeNull();
    expect(cleanFilename('dir/')).toBeNull();
  });
});
