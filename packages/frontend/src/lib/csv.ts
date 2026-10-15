export type CsvCell = string | number | boolean | null | undefined

/** A cell as CSV: quoted when it holds a comma, quote or line break, and defused when a spreadsheet would read it as a formula. */
function cell(value: CsvCell): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return String(value)
  let text = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value
  // A leading = + - @ (or a tab or return) makes Excel and Sheets run the cell as a formula.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Rows as CSV text, with a header row and CRLF line ends (what spreadsheets expect). */
export function toCsv(headers: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return [headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')
}

/** Saves CSV text as a file. The byte-order mark lets Excel read Amharic and other non-Latin text correctly. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
