import { AlertCircle, Download, History, Lock, RotateCcw, Trash2, Undo2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { ConfirmDialog, ErrorState } from '@/components/shared'
import { Badge, Button, Drawer, Skeleton, TextField, useToast } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { ApiError } from '@/lib/api/errors'
import { downloadCsv, toCsv } from '@/lib/csv'
import { formatDateTime } from '@/pages/VehicleHistory/format'
import { ValueInput } from './ValueInput'
import {
  formatValue,
  fromDraft,
  toDraft,
  TYPE_LABELS,
  useDeleteParameter,
  useParameterHistory,
  useUpdateParameter,
  type Draft,
  type HistoryEntry,
  type Parameter,
} from './registry'

const CHANGE_LABELS: Record<HistoryEntry['change'], string> = {
  value: 'Value changed',
  defined: 'Added',
  edited: 'Definition edited',
  enabled: 'Enabled',
  disabled: 'Disabled',
  deleted: 'Deleted',
}

/** Why a save failed, in the screen's words; a change made meanwhile says so and offers to reload. */
function saveError(err: unknown): { message: string; stale: boolean } {
  if (err instanceof ApiError && err.status === 412) return { message: 'Someone else changed this parameter since you opened it. Reload to see their change, then save yours again.', stale: true }
  if (err instanceof ApiError) return { message: `Not saved: ${err.message}`, stale: false }
  return { message: 'Could not reach the server. Check your connection and try again.', stale: false }
}

interface ParameterDrawerProps {
  parameter: Parameter | null
  onClose: () => void
  /** Reload the list: after a 412, to show the other change. */
  onReload: () => void
}

/**
 * One parameter (S-27, FMS-157): its value in an editor that fits its type, Reset to default, Enable and Disable,
 * Delete for a custom one, and its history (who, when and why) with Restore this value and a CSV export.
 */
export function ParameterDrawer({ parameter: p, onClose, onReload }: ParameterDrawerProps) {
  const { hasPermission } = useAuth()
  const canWrite = hasPermission('settings:write') && (!p?.required_permission || hasPermission(p.required_permission))
  const canDefine = hasPermission('settings:define')
  const update = useUpdateParameter()
  const remove = useDeleteParameter()
  const history = useParameterHistory(p?.key ?? null)
  const { toast } = useToast()
  const [draft, setDraft] = useState<Draft>('')
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<{ value?: string; reason?: string }>({})
  const [failure, setFailure] = useState<{ message: string; stale: boolean } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const key = p?.key
  const version = p?.version
  // The editor starts from the value shown, and again whenever the parameter changes (a save, a reload).
  useEffect(() => {
    if (!p) return
    setDraft(p.is_secret ? '' : toDraft(p.type, p.value))
    setReason('')
    setErrors({})
    setFailure(null)
  }, [key, version]) // p itself changes on every list refetch; only a new parameter or version resets the editor.

  if (!p) return null

  const parsed = p.is_secret && draft === '' ? null : fromDraft(p.type, p.rules, draft)
  const dirty = p.is_secret ? draft !== '' : parsed?.ok === true && JSON.stringify(parsed.value) !== JSON.stringify(p.value)

  async function save(value: unknown, why: string, done: string) {
    if (!p) return
    setFailure(null)
    try {
      await update.mutateAsync({ key: p.key, version: p.version, patch: { value, ...(why ? { reason: why } : {}) } })
      toast({ title: done, description: 'Every server uses it within seconds.' })
    } catch (err) {
      setFailure(saveError(err))
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!p || update.isPending) return
    const found: typeof errors = {}
    if (!parsed || !parsed.ok) found.value = parsed && !parsed.ok ? parsed.error : 'Type the new value.'
    if (p.is_system && !reason.trim()) found.reason = 'Say why: it changes how FMS works for everyone.'
    setErrors(found)
    if (found.value || found.reason || !parsed?.ok) return
    await save(parsed.value, reason.trim(), `${p.label} saved`)
  }

  async function onReset() {
    if (!p) return
    if (p.is_system && !reason.trim()) {
      setErrors({ reason: 'Say why you put it back to the default.' })
      return
    }
    await save(null, reason.trim(), `${p.label} back to its default`)
  }

  async function onToggle() {
    if (!p) return
    setFailure(null)
    try {
      await update.mutateAsync({ key: p.key, version: p.version, patch: { is_enabled: !p.is_enabled } })
      toast({ title: p.is_enabled ? `${p.label} disabled` : `${p.label} enabled`, description: p.is_enabled ? 'It answers with its default until enabled again.' : 'Its own value applies again.' })
    } catch (err) {
      setFailure(saveError(err))
    }
  }

  async function onDelete() {
    if (!p) return
    try {
      await remove.mutateAsync({ key: p.key, version: p.version })
      toast({ title: `${p.label} deleted`, description: 'Code reading it now gets nothing; the audit log keeps its history.' })
      setConfirmDelete(false)
      onClose()
    } catch (err) {
      setConfirmDelete(false)
      setFailure(saveError(err))
    }
  }

  function exportHistory() {
    if (!p || !history.data) return
    const rows = history.data.map((h) => [
      h.at,
      CHANGE_LABELS[h.change],
      h.change === 'value' ? formatValue(p, h.old_value) : h.fields.join(' '),
      h.change === 'value' ? formatValue(p, h.new_value) : '',
      h.reason,
      h.by_name,
    ])
    downloadCsv(`${p.key}-history.csv`, toCsv(['When (UTC)', 'Change', 'Before', 'After', 'Why', 'Who'], rows))
  }

  const shown = formatValue(p, p.value, p.has_value)
  return (
    <Drawer
      open
      onClose={onClose}
      title={p.label}
      description={
        <span className="font-mono text-xs">
          {p.key} · {TYPE_LABELS[p.type]}
        </span>
      }
    >
      <div className="space-y-6">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={p.is_system ? 'neutral' : 'brand'}>{p.is_system ? 'System' : 'Custom'}</Badge>
            {!p.is_enabled && <Badge tone="warning">Disabled</Badge>}
            {p.is_secret && (
              <Badge tone="neutral" icon={<Lock className="h-3 w-3" />}>
                Secret
              </Badge>
            )}
            {!p.is_default && p.is_enabled && <Badge tone="info">Changed from default</Badge>}
          </div>
          {p.description && <p className="text-sm text-ink-muted">{p.description}</p>}
          <dl className="grid grid-cols-2 gap-3 rounded-control bg-surface-sunken px-4 py-3 text-sm">
            <div>
              <dt className="text-xs text-ink-subtle">Answers with</dt>
              <dd className="tabular mt-0.5 break-words font-medium text-ink">{shown}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-subtle">Default</dt>
              <dd className="tabular mt-0.5 break-words text-ink">{p.is_secret ? 'Hidden' : formatValue(p, p.default_value)}</dd>
            </div>
          </dl>
          {!p.is_enabled && <p className="text-sm text-warning">Disabled: it answers with its default until it is enabled again. Its own value is kept.</p>}
          {p.storage === 'rule_thresholds' && <p className="text-xs text-ink-subtle">The fleet’s value. A depot with its own driving rules keeps its own.</p>}
        </div>

        {failure && (
          <div role="alert" className="flex items-start gap-2.5 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="space-y-2">
              <p>{failure.message}</p>
              {failure.stale && (
                <Button size="sm" variant="secondary" onClick={onReload}>
                  Reload
                </Button>
              )}
            </div>
          </div>
        )}

        {canWrite ? (
          <form onSubmit={onSubmit} noValidate className="space-y-4" aria-label={`Change ${p.label}`}>
            <ValueInput
              id={`value-${p.key}`}
              label={p.is_secret ? (p.has_value ? 'New value' : 'Value') : 'Value'}
              type={p.type}
              rules={p.rules}
              draft={draft}
              onChange={(d) => {
                setDraft(d)
                if (errors.value) setErrors((e) => ({ ...e, value: undefined }))
              }}
              error={errors.value ?? (parsed && !parsed.ok && draft !== toDraft(p.type, p.value) ? parsed.error : null)}
              hint={p.is_secret ? 'Never shown again once saved.' : undefined}
              secret={p.is_secret}
            />
            <TextField
              id={`reason-${p.key}`}
              label={p.is_system ? 'Why' : 'Why (optional)'}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value)
                if (errors.reason) setErrors((er) => ({ ...er, reason: undefined }))
              }}
              error={errors.reason}
              hint="Kept with the change in its history and the audit log."
              maxLength={500}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button type="button" variant="ghost" size="sm" leadingIcon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => void onReset()} disabled={p.is_default || update.isPending}>
                Reset to default
              </Button>
              <Button type="submit" loading={update.isPending} disabled={!dirty}>
                Save value
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-ink-subtle">{p.required_permission ? `Changing it needs the ${p.required_permission} permission.` : 'You can read it, not change it.'}</p>
        )}

        {canDefine && (
          <div className="space-y-3 border-t border-line pt-5">
            <ValueInput
              id={`enabled-${p.key}`}
              label="Enabled"
              type="boolean"
              rules={{}}
              draft={p.is_enabled ? 'true' : 'false'}
              onChange={() => void onToggle()}
              hint={p.is_enabled ? 'Disable it and it answers with its default.' : 'Enable it and its own value applies again.'}
              disabled={update.isPending}
            />
            {!p.is_system && (
              <Button variant="ghost" size="sm" className="text-danger hover:bg-danger-soft" leadingIcon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirmDelete(true)}>
                Delete parameter
              </Button>
            )}
          </div>
        )}

        <section aria-labelledby={`history-${p.key}`} className="space-y-3 border-t border-line pt-5">
          <div className="flex items-center justify-between gap-3">
            <h3 id={`history-${p.key}`} className="flex items-center gap-2 text-sm font-semibold text-ink">
              <History className="h-4 w-4 text-ink-subtle" aria-hidden="true" />
              History
            </h3>
            <Button variant="secondary" size="sm" leadingIcon={<Download className="h-3.5 w-3.5" />} onClick={exportHistory} disabled={!history.data?.length}>
              Export CSV
            </Button>
          </div>
          {history.isError ? (
            <ErrorState error={history.error} onRetry={() => void history.refetch()} />
          ) : !history.data ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : history.data.length === 0 ? (
            <p className="text-sm text-ink-subtle">Never changed.</p>
          ) : (
            <ol className="space-y-2">
              {history.data.map((h, i) => (
                <HistoryRow
                  key={`${h.at}-${i}`}
                  parameter={p}
                  entry={h}
                  onRestore={canWrite && !p.is_secret && h.change === 'value' && JSON.stringify(h.new_value ?? p.default_value) !== JSON.stringify(p.value) ? () => void save(h.new_value, `Restored the value of ${formatDateTime(h.at)}`, `${p.label} restored`) : undefined}
                  busy={update.isPending}
                />
              ))}
            </ol>
          )}
        </section>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${p.label}?`}
        message={
          <>
            Code reading <span className="font-mono">{p.key}</span> gets nothing from now on. Its history stays in the audit log, and the key can be added again later.
          </>
        }
        action="Delete parameter"
        onConfirm={onDelete}
        busy={remove.isPending}
      />
    </Drawer>
  )
}

function HistoryRow({ parameter: p, entry: h, onRestore, busy }: { parameter: Parameter; entry: HistoryEntry; onRestore?: () => void; busy: boolean }) {
  return (
    <li className="rounded-control border border-line px-3.5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{CHANGE_LABELS[h.change]}</p>
          {h.change === 'value' && (
            <p className="tabular mt-0.5 break-words text-sm text-ink-muted">
              {formatValue(p, h.old_value)} <span aria-label="to">→</span> <span className="text-ink">{formatValue(p, h.new_value)}</span>
            </p>
          )}
          {h.change === 'edited' && h.fields.length > 0 && <p className="mt-0.5 text-sm text-ink-muted">{h.fields.map((f) => f.replace('_', ' ')).join(', ')}</p>}
          {h.reason && <p className="mt-1 text-sm text-ink">“{h.reason}”</p>}
          <p className="mt-1 text-xs text-ink-subtle">
            {h.by_name ?? 'The system'} · {formatDateTime(h.at)}
          </p>
        </div>
        {onRestore && (
          <Button size="sm" variant="ghost" leadingIcon={<Undo2 className="h-3.5 w-3.5" />} onClick={onRestore} disabled={busy}>
            Restore this value
          </Button>
        )}
      </div>
    </li>
  )
}
