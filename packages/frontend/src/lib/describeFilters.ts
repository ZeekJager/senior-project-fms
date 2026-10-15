/**
 * Which filters are narrowing a list, in words: for a "nothing matches" message
 * that names the culprit. Returns an empty string when none apply.
 */
export function describeFilters(parts: { search?: string; depot?: string; view?: string }): string {
  const named: string[] = []
  if (parts.search?.trim()) named.push(`search “${parts.search.trim()}”`)
  if (parts.depot) named.push(`depot ${parts.depot}`)
  if (parts.view) named.push(`view ${parts.view}`)
  return named.length ? `Filtered by ${named.join(' · ')}.` : ''
}
