import { AlertCircle, ClipboardCheck, Gauge } from 'lucide-react'
import { useState } from 'react'
import { EmptyState } from '@/components/shared'
import { Button } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useMaintenanceRisk } from '@/features/health/api'
import { HealthDetail, HealthSkeleton } from '@/features/health/HealthDrawer'
import { LogRepairDrawer, type RepairPreset } from '@/pages/Maintenance'
import { inspectionDescription } from '@/pages/PredictiveMaintenance/HealthPanel'
import type { Vehicle } from '@/pages/Vehicles/types'

/**
 * The health score and what drives it (FMS-56), as on the Vehicle health screen, on the vehicle's own page
 * (FMS-136). prediction:read only; Schedule inspection opens the job card as an inspection (maintenance:write).
 */
export function HealthSection({ vehicle }: { vehicle: Vehicle }) {
  const { hasPermission } = useAuth()
  const risk = useMaintenanceRisk(vehicle.id)
  const [preset, setPreset] = useState<RepairPreset | null>(null)
  const view = risk.data
  const scored = view?.health_score != null

  return (
    <section aria-labelledby="health-heading" className="max-w-2xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="health-heading" className="text-base font-semibold text-ink">
            Health
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">Its chance of a breakdown in the next 30 days, scored every night.</p>
        </div>
        {hasPermission('maintenance:write') && view && scored && vehicle.status !== 'retired' && (
          <Button
            variant="secondary"
            leadingIcon={<ClipboardCheck className="h-4 w-4" />}
            onClick={() => setPreset({ vehicle: { id: vehicle.id, registration_number: vehicle.registration_number }, type: 'inspection', description: inspectionDescription(view) })}
          >
            Schedule inspection
          </Button>
        )}
      </div>
      {risk.isError ? (
        <p role="alert" className="flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          The health score could not be loaded. Reload the page to try again.
        </p>
      ) : !view ? (
        <HealthSkeleton />
      ) : !scored ? (
        <EmptyState icon={<Gauge />} heading="Not scored yet" description="The nightly scoring gives every vehicle in service a score at 02:00. This one has none yet." headingLevel="h3" />
      ) : (
        <HealthDetail view={view} />
      )}
      {preset && <LogRepairDrawer open onClose={() => setPreset(null)} canInventory={hasPermission('inventory:read')} preset={preset} />}
    </section>
  )
}
