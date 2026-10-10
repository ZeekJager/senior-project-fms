/** A permission code, a list of which any one is enough, or `{ all }` of which every one is needed. */
export type PermissionRule = string | readonly string[] | { all: readonly string[] }

/** Whether `permissions` (from /auth/me) satisfy `rule`. Codes only, never role names. */
export function permits(permissions: readonly string[], rule: PermissionRule): boolean {
  if (typeof rule === 'object' && 'all' in rule) return rule.all.every((code) => permissions.includes(code))
  const wanted = typeof rule === 'string' ? [rule] : rule
  return wanted.some((code) => permissions.includes(code))
}
