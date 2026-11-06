import { AlertCircle, Link2, RadioTower, SatelliteDish, Unlink } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ConfirmDialog, DataTable, EmptyState, type Column } from '@/components/shared'
import { Badge, Button, Card, FilterSelect, Skeleton, ViewTabs, useToast } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { ApiError } from '@/lib/api/errors'
import { useDevices, useTelematicsProviders, useUnknownDevices, useUnlinkDevice, type GpsDevice } from './api'
import { ago, reasonLabel, when } from './describe'
import { LinkDeviceDrawer, type LinkPreset } from './LinkDeviceDrawer'
import { ProviderPanel } from './ProviderPanel'

type View = 'active' | 'removed'

/**
 * S-34 Telematics (FMS-138): the providers that send vehicles' positions, with how today's deliveries went; the
 * device registry, which tracker reports for which vehicle; and the device ids a provider is sending that are linked
 * to no vehicle yet. integration:read sees it (admin, fleet manager); integration:execute links and unlinks.
 */
export function TelematicsPage() {
  const { hasPermission } = useAuth()
  const canEdit = hasPermission('integration:execute')
  const { toast } = useToast()
  const [params, setParams] = useSearchParams()
  const view: View = params.get('view') === 'removed' ? 'removed' : 'active'
  const providerFilter = params.get('provider') ?? ''

  const providers = useTelematicsProviders()
  const devices = useDevices()
  const unknown = useUnknownDevices()
  const unlink = useUnlinkDevice()

  const [drawer, setDrawer] = useState<{ preset: LinkPreset | null } | null>(null)
  const [unlinking, setUnlinking] = useState<GpsDevice | null>(null)
  const [unlinkError, setUnlinkError] = useState<string | null>(null)
  const now = providers.dataUpdatedAt || Date.now()

  const all = devices.data ?? []
  const counts = useMemo(() => ({ active: all.filter((d) => d.status !== 'removed').length, removed: all.filter((d) => d.status === 'removed').length }), [all])
  const shown = useMemo(
    () =>
      all.filter(
        (d) =>
          (view === 'removed') === (d.status === 'removed') &&
          (!providerFilter || (providerFilter === 'token' ? d.credential === 'token' : d.provider?.id === providerFilter)),
      ),
    [all, view, providerFilter],
  )

  function setParam(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    setParams(next, { replace: true })
  }

  async function confirmUnlink() {
    if (!unlinking) return
    setUnlinkError(null)
    try {
      await unlink.mutateAsync(unlinking.id)
      toast({ title: 'Device unlinked', description: `${unlinking.device_identifier} no longer reports for ${unlinking.vehicle.registration_number}.` })
      setUnlinking(null)
    } catch (err) {
      setUnlinkError(err instanceof ApiError ? `It could not be unlinked (${err.code}).` : 'Could not reach the server. Try again.')
    }
  }

  const columns: Column<GpsDevice>[] = [
    {
      key: 'device',
      header: 'Device',
      cell: (d) => (
        <span className="block min-w-0">
          <span className="block truncate font-mono text-sm font-medium text-ink">{d.device_identifier}</span>
          {d.device_model && <span className="block truncate text-xs text-ink-subtle">{d.device_model}</span>}
        </span>
      ),
    },
    { key: 'vehicle', header: 'Vehicle', width: '9rem', cell: (d) => <span className="font-medium text-ink">{d.vehicle.registration_number}</span> },
    {
      key: 'provider',
      header: 'Reports through',
      width: '12rem',
      hideBelow: 'md',
      cell: (d) => (d.provider ? <span className="truncate text-ink-muted">{d.provider.name}</span> : <Badge tone="neutral">Own token</Badge>),
    },
    {
      key: 'seen',
      header: view === 'removed' ? 'Unlinked' : 'Last seen',
      width: '9rem',
      cell: (d) => {
        const at = view === 'removed' ? d.removed_at : d.last_seen_at
        return (
          <span className={at ? 'text-ink' : 'text-ink-subtle'} title={at ? when(at) : undefined}>
            {ago(at, now)}
          </span>
        )
      },
    },
    {
      key: 'error',
      header: 'Last refused',
      width: '13rem',
      hideBelow: 'lg',
      cell: (d) =>
        d.last_error ? (
          <span className="block min-w-0" title={when(d.last_error.at)}>
            <span className="block truncate text-danger">{reasonLabel(d.last_error.reason)}</span>
            <span className="block text-xs text-ink-subtle">{ago(d.last_error.at, now)}</span>
          </span>
        ) : (
          <span className="text-ink-subtle">—</span>
        ),
    },
    ...(canEdit && view === 'active'
      ? [
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            label: 'Actions',
            width: '7rem',
            align: 'right' as const,
            cell: (d: GpsDevice) => (
              <Button variant="ghost" size="sm" leadingIcon={<Unlink className="h-3.5 w-3.5" />} onClick={() => setUnlinking(d)} aria-label={`Unlink ${d.device_identifier}`}>
                Unlink
              </Button>
            ),
          },
        ]
      : []),
  ]

  const providerList = providers.data ?? []
  const filterOptions = [
    { value: '', label: 'All' },
    ...providerList.map((p) => ({ value: p.id, label: p.name })),
    ...(all.some((d) => d.credential === 'token') ? [{ value: 'token', label: 'Own token' }] : []),
  ]

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-3 border-b border-line pb-5 sm:items-center">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Telematics</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            The providers that send your vehicles’ positions, and which tracker reports for which vehicle. A linked device’s positions appear on the live map.
          </p>
        </div>
        {canEdit && (
          <Button leadingIcon={<Link2 className="h-4 w-4" />} onClick={() => setDrawer({ preset: null })} disabled={providerList.length === 0} className="self-start sm:self-auto">
            Link device
          </Button>
        )}
      </header>

      <section aria-labelledby="providers-heading" className="space-y-3">
        <h2 id="providers-heading" className="text-sm font-semibold text-ink">
          Providers
        </h2>
        {providers.isPending ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Loading providers">
            {[0, 1].map((i) => (
              <Card key={i} className="space-y-3 p-5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
                <Skeleton className="h-16 w-full" />
              </Card>
            ))}
          </div>
        ) : providers.isError ? (
          <Card>
            <EmptyState
              icon={<AlertCircle />}
              heading="Providers could not be loaded"
              description="Check your connection, then try again."
              action={
                <Button variant="secondary" onClick={() => void providers.refetch()}>
                  Try again
                </Button>
              }
            />
          </Card>
        ) : providerList.length === 0 ? (
          <Card>
            <EmptyState
              icon={<RadioTower />}
              heading="No telematics provider yet"
              description="A provider is added on the server, with its webhook secret in the environment. docs/telematics.md walks through it."
            />
          </Card>
        ) : (
          <ul aria-label="Telematics providers" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {providerList.map((p) => (
              <li key={p.id}>
                <ProviderPanel provider={p} now={now} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {(unknown.data?.length ?? 0) > 0 && (
        <section aria-labelledby="unknown-heading" className="space-y-3">
          <div>
            <h2 id="unknown-heading" className="text-sm font-semibold text-ink">
              Sending, not linked
            </h2>
            <p className="mt-0.5 text-sm text-ink-muted">A provider is sending these devices’ positions, and they are refused until each is linked to its vehicle.</p>
          </div>
          <Card className="p-0">
            <ul aria-label="Unlinked devices" className="divide-y divide-line">
              {unknown.data!.map((u) => (
                <li key={`${u.provider.id}:${u.device_identifier}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <SatelliteDish className="h-4 w-4 shrink-0 text-warning" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-sm font-medium text-ink">{u.device_identifier}</span>
                    <span className="block text-xs text-ink-subtle">
                      {u.provider.name} · {u.positions.toLocaleString('en-GB')} {u.positions === 1 ? 'position' : 'positions'} refused · last {ago(u.last_seen_at, now)}
                    </span>
                  </span>
                  {canEdit && (
                    <Button variant="secondary" size="sm" onClick={() => setDrawer({ preset: { providerId: u.provider.id, identifier: u.device_identifier } })} aria-label={`Link ${u.device_identifier}`}>
                      Link
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      <section aria-labelledby="devices-heading" className="space-y-3">
        <h2 id="devices-heading" className="text-sm font-semibold text-ink">
          Devices
        </h2>
        <DataTable
          caption="Devices"
          columns={columns}
          data={shown}
          rowKey={(d) => d.id}
          isLoading={devices.isPending}
          error={devices.error}
          onRetry={() => void devices.refetch()}
          toolbar={
            <div className="flex flex-wrap items-center justify-between gap-3">
              <ViewTabs
                label="Device views"
                value={view}
                onChange={(v) => setParam({ view: v === 'removed' ? 'removed' : null })}
                options={[
                  { value: 'active', label: 'Linked', count: counts.active, isLoading: devices.isPending, hint: 'Reporting for a vehicle' },
                  { value: 'removed', label: 'Unlinked', count: counts.removed, archived: true, hint: 'Kept with their positions' },
                ]}
              />
              {filterOptions.length > 2 && <FilterSelect label="Reports through" value={providerFilter} emptyValue="" onChange={(v) => setParam({ provider: v || null })} options={filterOptions} />}
            </div>
          }
          emptyState={
            view === 'removed' ? (
              <EmptyState icon={<Unlink />} heading="No unlinked devices" description="A device you unlink is kept here with its positions." />
            ) : (
              <EmptyState
                icon={<SatelliteDish />}
                heading={providerFilter ? 'No device reports through this' : 'No devices linked yet'}
                description={canEdit ? 'Link a tracker’s id to the vehicle it is installed in, and its provider’s positions become that vehicle’s.' : 'An administrator links trackers to vehicles.'}
              />
            )
          }
        />
      </section>

      <LinkDeviceDrawer open={drawer !== null} onClose={() => setDrawer(null)} providers={providerList} preset={drawer?.preset ?? null} />

      <ConfirmDialog
        open={unlinking !== null}
        onClose={() => {
          setUnlinking(null)
          setUnlinkError(null)
        }}
        title={`Unlink ${unlinking?.device_identifier ?? 'device'}?`}
        message={`Its positions stop counting for ${unlinking?.vehicle.registration_number ?? 'the vehicle'} and are refused from now on${unlinking?.credential === 'token' ? '; its token stops working' : ''}. Its past positions stay, and you can link it again.`}
        action="Unlink device"
        onConfirm={confirmUnlink}
        error={unlinkError}
        busy={unlink.isPending}
      />
    </div>
  )
}
