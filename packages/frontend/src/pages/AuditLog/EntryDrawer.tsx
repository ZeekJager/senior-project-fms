import { ArrowRight, Fingerprint, History, Link2, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge, Button, Drawer } from '@/components/ui'
import type { AuditFilters } from './api'
import { actionLabel, actorName, changedFields, fieldLabel, formatInstant, formatValue, isStructured, recordName, tableLabel, type AuditEntry, type ChangedField } from './describe'

/** "Updated vehicle AA 3-12345", "Signed in". */
export function entryTitle(entry: AuditEntry): string {
  const table = tableLabel(entry.entity_type)
  const name = recordName(entry)
  const isRecordAction = ['INSERT', 'UPDATE', 'DELETE', 'ROLE_CHANGE'].includes(entry.action)
  if (!isRecordAction || !table) return actionLabel(entry.action)
  return `${actionLabel(entry.action)} ${table.toLowerCase()}${name ? ` ${name}` : ''}`
}

function Value({ field, value, tone }: { field: string; value: unknown; tone: 'before' | 'after' }) {
  const text = formatValue(field, value)
  const color = text === '—' || text === 'Hidden' ? 'text-ink-subtle' : tone === 'before' ? 'text-ink-muted' : 'text-ink'
  if (isStructured(value)) {
    return <pre className={`max-h-48 overflow-auto whitespace-pre-wrap rounded-md [overflow-wrap:anywhere] bg-surface-sunken p-2 font-mono text-xs ${color}`}>{text}</pre>
  }
  return <span className={`[overflow-wrap:anywhere] ${text === 'Hidden' ? 'italic' : ''} ${color}`}>{text}</span>
}

function Diff({ entry, fields }: { entry: AuditEntry; fields: ChangedField[] }) {
  const created = !entry.old_values
  const deleted = !entry.new_values
  const single = created || deleted
  return (
    <table className="w-full table-fixed border-collapse text-sm">
      <caption className="sr-only">Fields changed</caption>
      <thead>
        <tr className="border-b border-line text-left text-xs font-medium uppercase tracking-wide text-ink-subtle">
          <th scope="col" className={`py-2 pr-3 font-medium ${single ? 'w-[40%]' : 'w-[28%]'}`}>
            Field
          </th>
          {single ? (
            <th scope="col" className="py-2 font-medium">
              {created ? 'Set to' : 'Value before'}
            </th>
          ) : (
            <>
              <th scope="col" className="py-2 pr-3 font-medium">
                Before
              </th>
              <th scope="col" className="w-5 py-2">
                <span className="sr-only">changed to</span>
              </th>
              <th scope="col" className="py-2 font-medium">
                After
              </th>
            </>
          )}
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => (
          <tr key={f.key} className="border-b border-line align-top last:border-0">
            <th scope="row" className="py-2.5 pr-3 text-left font-medium text-ink-muted">
              {f.label}
            </th>
            {single ? (
              <td className="py-2.5">
                <Value field={f.key} value={created ? f.after : f.before} tone="after" />
              </td>
            ) : (
              <>
                <td className="py-2.5 pr-3">
                  <Value field={f.key} value={f.before} tone="before" />
                </td>
                <td className="py-2.5 text-ink-subtle">
                  <ArrowRight className="mt-0.5 h-3.5 w-3.5" aria-hidden="true" />
                </td>
                <td className="py-2.5">
                  <Value field={f.key} value={f.after} tone="after" />
                </td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">{title}</h3>
      {children}
    </section>
  )
}

function Row({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1 py-2 text-sm sm:grid-cols-[9rem_1fr_auto]">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
      {action && <dd className="col-start-2 sm:col-start-auto">{action}</dd>}
    </div>
  )
}

const source = (entry: AuditEntry, key: string) => {
  const value = entry.request_source?.[key]
  return typeof value === 'string' && value ? value : null
}

/**
 * One audit entry in full (S-10, FMS-29): the fields it changed and nothing else, before and after, in their
 * units; its details; and who, from where, in which request. Each lead opens the list on what it names.
 */
export function EntryDrawer({ entry, onClose, onFilter }: { entry: AuditEntry | null; onClose: () => void; onFilter: (patch: Partial<AuditFilters>) => void }) {
  if (!entry) return null
  const fields = changedFields(entry)
  const details = Object.entries(entry.details ?? {})
  const actor = entry.actor
  const table = tableLabel(entry.entity_type)
  const lead = (label: string, icon: ReactNode, patch: Partial<AuditFilters>) => (
    <Button size="sm" variant="ghost" leadingIcon={icon} onClick={() => onFilter(patch)}>
      {label}
    </Button>
  )

  return (
    <Drawer
      open
      onClose={onClose}
      className="sm:!max-w-[640px]"
      title={entryTitle(entry)}
      description={
        <>
          {formatInstant(entry.occurred_at)} · {actorName(actor, entry.action)}
        </>
      }
    >
      <div className="space-y-6">
        {entry.result && entry.result !== 'success' && (
          <Badge tone="danger">{entry.result === 'denied' ? 'Denied: nothing was changed' : 'Failed: nothing was changed'}</Badge>
        )}

        {(entry.old_values || entry.new_values) && (
          <Section title={entry.old_values && entry.new_values ? `Changed fields (${fields.length})` : 'Fields'}>
            {fields.length ? <Diff entry={entry} fields={fields} /> : <p className="text-sm text-ink-muted">No field changed: the record was saved as it was.</p>}
          </Section>
        )}

        {details.length > 0 && (
          <Section title="Details">
            <dl className="divide-y divide-line">
              {details.map(([key, value]) => (
                <Row key={key} label={fieldLabel(key)}>
                  <Value field={key} value={value} tone="after" />
                </Row>
              ))}
            </dl>
          </Section>
        )}

        <Section title="Context">
          <dl className="divide-y divide-line">
            <Row
              label="Who"
              action={actor.type === 'user' && actor.id ? lead('Everything they did', <UserRound className="h-3.5 w-3.5" />, { user: actor.id }) : undefined}
            >
              {actorName(actor, entry.action)}
              {actor.type === 'user' && actor.email && actor.full_name && <span className="block text-xs text-ink-subtle">{actor.email}</span>}
            </Row>
            {entry.entity_id && (
              <Row label={table ?? 'Record'} action={lead('Its full history', <History className="h-3.5 w-3.5" />, { record: entry.entity_id, table: '', view: 'all' })}>
                <span className="font-mono text-xs">{entry.entity_id}</span>
              </Row>
            )}
            <Row label="Request" action={lead('Everything in it', <Link2 className="h-3.5 w-3.5" />, { request: entry.correlation_id, view: 'all' })}>
              <span className="font-mono text-xs">{entry.correlation_id}</span>
            </Row>
            {source(entry, 'channel') && <Row label="Through">{source(entry, 'channel')}</Row>}
            {source(entry, 'ip') && <Row label="IP address">{source(entry, 'ip')}</Row>}
            {source(entry, 'user_agent') && (
              <Row label="Device">
                <span className="line-clamp-2 text-xs text-ink-muted" title={source(entry, 'user_agent')!}>
                  {source(entry, 'user_agent')}
                </span>
              </Row>
            )}
          </dl>
          <p className="flex items-center gap-1.5 pt-1 text-xs text-ink-subtle">
            <Fingerprint className="h-3.5 w-3.5" aria-hidden="true" />
            The audit log is read-only: entries are written with each change and never edited.
          </p>
        </Section>
      </div>
    </Drawer>
  )
}
