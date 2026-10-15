import { describe, expect, it, vi } from 'vitest'
import { downloadCsv, toCsv } from './csv'

describe('toCsv', () => {
  it('writes a header row and CRLF line ends', () => {
    expect(toCsv(['Plate', 'Year'], [['AA 3-1', 2020], ['AA 3-2', 2021]])).toBe('Plate,Year\r\nAA 3-1,2020\r\nAA 3-2,2021')
  })

  it('quotes commas, quotes and line breaks', () => {
    expect(toCsv(['A'], [['a,b'], ['say "hi"'], ['two\nlines']])).toBe('A\r\n"a,b"\r\n"say ""hi"""\r\n"two\nlines"')
  })

  it('leaves empty cells empty and writes booleans in words', () => {
    expect(toCsv(['A', 'B', 'C'], [[null, undefined, true], [false, '', 0]])).toBe('A,B,C\r\n,,Yes\r\nNo,,0')
  })

  it('defuses a cell a spreadsheet would run as a formula', () => {
    expect(toCsv(['A'], [['=HYPERLINK("x")'], ['+1'], ['-2'], ['@cmd']])).toBe('A\r\n"\'=HYPERLINK(""x"")"\r\n\'+1\r\n\'-2\r\n\'@cmd')
  })

  it('keeps negative numbers as numbers, not formulas', () => {
    expect(toCsv(['A'], [[-5]])).toBe('A\r\n-5')
  })

  it('keeps Amharic text as it is', () => {
    expect(toCsv(['ዲፖ'], [['አዲስ አበባ']])).toBe('ዲፖ\r\nአዲስ አበባ')
  })
})

describe('downloadCsv', () => {
  it('saves a file with a byte-order mark and the name given, then tidies up', async () => {
    const blobs: Blob[] = []
    const create = vi.fn((b: Blob) => (blobs.push(b), 'blob:x'))
    const revoke = vi.fn()
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    downloadCsv('fleet.csv', 'A\r\n1')
    expect(click).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledWith('blob:x')
    expect(document.querySelector('a[download]')).toBeNull()
    expect(blobs[0].type).toContain('text/csv')
    // text() drops the byte-order mark when decoding, so read the raw bytes: EF BB BF, then the text.
    const bytes = new Uint8Array(await blobs[0].arrayBuffer())
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    expect(await blobs[0].text()).toBe('A\r\n1')
    click.mockRestore()
  })
})
