/** Joins class names, skipping the falsy ones: `cn('a', open && 'b')`. */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}
