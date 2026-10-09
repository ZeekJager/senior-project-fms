import { describe, expect, test } from 'vitest';
import { AppError } from '../errors/app-error';
import { parseCsv } from './csv';

describe('parseCsv', () => {
  test('plain records, CRLF or LF, trailing newline, blank lines skipped', () => {
    expect(parseCsv('a,b\r\n1,2\n\n3,4\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  test('quoted fields keep commas, line breaks and doubled quotes', () => {
    expect(parseCsv('name,note\n"Kebede, Abebe","says ""hi""\nbye"')).toEqual([
      ['name', 'note'],
      ['Kebede, Abebe', 'says "hi"\nbye'],
    ]);
  });

  test('empty fields and a leading byte-order mark', () => {
    expect(parseCsv('﻿a,b,c\n1,,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });

  test('an unterminated quote is a 400', () => {
    expect(() => parseCsv('a\n"open')).toThrow(AppError);
  });
});
