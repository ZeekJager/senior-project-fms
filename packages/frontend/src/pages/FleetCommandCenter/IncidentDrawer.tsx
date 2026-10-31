import { Crosshair, Save, UserMinus, UserPlus } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Badge, Button, Drawer, SelectField, TextAreaField, useToast } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { ApiError } from '@/lib/api/errors'
import { SEVERITY } from './AlertsPanel'
import { useUpdateIncident } from './api'
import { INCIDENT_STATUS } from './IncidentsPanel'
import { INCIDENT_NEXT, incidentTypeLabel, type IncidentStatus, type OverviewIncident } from './overview'

const addisTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-3 py-2 text-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  )
}

/**
 * One incident (FMS-89): what was reported, and handling it. A user with incident:manage changes its status (as
 * INCIDENT_NEXT allows), takes it on or lets it go, and writes what was found and done, which resolving or closing
 * requires. Each save is one audited change, and every other open console sees it (incident.updated).
 */
export function IncidentDrawer({
  incident,
  depotId,
  canManage,
  onClose,
  onShowVehicle,
}: {
  incident: OverviewIncident | null
  depotId: string
  canManage: boolean
  onClose: () => void
  /** Offered when the incident's vehicle is on the map. */
  onShowVehicle?: (vehicleId: string) => void
}) {
  const { session } = useAuth()
  const update = useUpdateIncident(depotId)
  const { toast } = useToast()
  const [status, setStatus] = useState<IncidentStatus>('open')
  const [notes, setNotes] = useState('')
  const [notesError, setNotesError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setStatus(incident?.status ?? 'open')
    setNotes(incident?.notes ?? '')
    setNotesError(null)
    setError(null)
    // A new incident chosen, or this one saved: start from what is stored.
  }, [incident?.id, incident?.status, incident?.notes])

  if (!incident) return null
  const me = session?.user.id ?? null
  const mine = incident.assigned_to?.id === me
  const options = [incident.status, ...INCIDENT_NEXT[incident.status]].map((s) => ({ value: s, label: INCIDENT_STATUS[s].label }))
  const done = status === 'resolved' || status === 'closed'
  const dirty = status !== incident.status || notes.trim() !== (incident.notes ?? '')

  async function save(change: { status?: IncidentStatus; assigned_to?: string | null; notes?: string | null }, success: string) {
    if (!incident) return
    setError(null)
    try {
      const saved = await update.mutateAsync({ id: incident.id, change })
      toast({ title: success, description: `${incidentTypeLabel(saved.incident_type)}${incident.registration_number ? `, ${incident.registration_number}` : ''}.` })
      if (saved.status === 'resolved' || saved.status === 'closed') onClose()
    } catch (err) {
      if (err instanceof ApiError && err.details.some((d) => d.field === 'notes')) setNotesError('Say what was found and done before resolving it.')
      else if (err instanceof ApiError && err.code === 'CONFLICT_INVALID_STATE_TRANSITION') setError('Someone else changed it a moment ago. Close this panel to see where it stands.')
      else if (err instanceof ApiError && err.details.some((d) => d.field === 'assigned_to')) setError('That person cannot take on incidents for this depot.')
      else setError('It could not be saved. Check your connection and try again.')
    }
  }

  function submit() {
    if (done && !notes.trim()) {
      setNotesError('Say what was found and done before resolving it.')
      return
    }
    setNotesError(null)
    const change: { status?: IncidentStatus; notes?: string | null } = {}
    if (status !== incident!.status) change.status = status
    if (notes.trim() !== (incident!.notes ?? '')) change.notes = notes.trim() || null
    void save(change, status !== incident!.status ? `Incident ${INCIDENT_STATUS[status].label.toLowerCase()}` : 'Notes saved')
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={`${incidentTypeLabel(incident.incident_type)}${incident.registration_number ? `: ${incident.registration_number}` : ''}`}
      description={`Reported ${addisTime.format(new Date(incident.occurred_at))}`}
      footer={
        canManage ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={update.isPending} disabled={!dirty} onClick={submit} leadingIcon={<Save className="h-4 w-4" />}>
              Save
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={SEVERITY[incident.severity].tone} dot>
            {SEVERITY[incident.severity].label}
          </Badge>
          <Badge tone={INCIDENT_STATUS[incident.status].tone}>{INCIDENT_STATUS[incident.status].label}</Badge>
          {onShowVehicle && incident.vehicle_id && (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onShowVehicle(incident.vehicle_id!)} leadingIcon={<Crosshair className="h-3.5 w-3.5" />}>
              Show on map
            </Button>
          )}
        </div>

        <p className="whitespace-pre-line rounded-card border border-line bg-surface-muted p-4 text-sm text-ink [overflow-wrap:anywhere]">{incident.description}</p>

        <dl className="divide-y divide-line">
          {incident.registration_number && <Fact label="Vehicle">{<span className="plate">{incident.registration_number}</span>}</Fact>}
          {incident.driver_id && <Fact label="Driver">{incident.driver_name ?? 'A driver outside this view'}</Fact>}
          {incident.latitude !== null && incident.longitude !== null && (
            <Fact label="Where">
              <span className="tabular">
                {incident.latitude.toFixed(5)}, {incident.longitude.toFixed(5)}
              </span>
            </Fact>
          )}
          <Fact label="Taken on by">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span className={incident.assigned_to ? undefined : 'italic text-ink-subtle'}>{incident.assigned_to ? (mine ? `${incident.assigned_to.full_name} (you)` : incident.assigned_to.full_name) : 'Nobody yet'}</span>
              {canManage && me && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={update.isPending}
                  onClick={() => void save({ assigned_to: mine ? null : me }, mine ? 'Incident let go' : 'Incident taken on')}
                  leadingIcon={mine ? <UserMinus className="h-3.5 w-3.5" /> : <UserPlus className="h-3.5 w-3.5" />}
                >
                  {mine ? 'Let it go' : incident.assigned_to ? 'Take it over' : 'Take it on'}
                </Button>
              )}
            </span>
          </Fact>
          {!canManage && incident.notes && <Fact label="Notes">{<span className="whitespace-pre-line [overflow-wrap:anywhere]">{incident.notes}</span>}</Fact>}
        </dl>

        {error && (
          <p className="rounded-control border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
            {error}
          </p>
        )}

        {canManage && (
          <section aria-labelledby="handle-incident" className="space-y-3">
            <h3 id="handle-incident" className="text-sm font-semibold text-ink">
              Handle this incident
            </h3>
            <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value as IncidentStatus)} options={options} />
            <TextAreaField
              label="What was found and done"
              rows={4}
              value={notes}
              maxLength={4000}
              onChange={(e) => {
                setNotes(e.target.value)
                if (notesError) setNotesError(null)
              }}
              error={notesError ?? undefined}
              hint={done ? 'Required to resolve or close: it stays on the record.' : 'Kept on the record with who changed it.'}
              optional={!done}
            />
          </section>
        )}
      </div>
    </Drawer>
  )
}
