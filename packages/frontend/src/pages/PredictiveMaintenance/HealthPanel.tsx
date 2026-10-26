import { useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import { HealthDrawer, type HealthVehicle } from '@/features/health/HealthDrawer'
import { BAND_LABELS, bandOf, featureLabel, type MaintenanceRisk } from '@/features/health/health'
import { LogRepairDrawer, type RepairPreset } from '@/pages/Maintenance'

/** The repair form's description for an inspection a health score asked for: the score and what drives it. */
export function inspectionDescription(risk: MaintenanceRisk): string {
  const score = risk.health_score ?? 0
  const drivers = risk.factors.map((f) => featureLabel(f.feature).toLowerCase())
  return `Inspection: health score ${score} (${BAND_LABELS[bandOf(score)].toLowerCase()})${drivers.length ? `, mostly ${drivers.join(', ')}` : ''}.`
}

/**
 * A vehicle's health breakdown (S-19, FMS-56) and, with maintenance:write, "Schedule inspection": the
 * repair form, opened on that vehicle as an inspection whose description says why. Used by Vehicle health
 * and Vehicles. Needs prediction:read; callers render it only for those who hold it.
 */
export function HealthPanel({ vehicle, onClose }: { vehicle: HealthVehicle | null; onClose: () => void }) {
  const { hasPermission } = useAuth()
  const [preset, setPreset] = useState<RepairPreset | null>(null)
  return (
    <>
      <HealthDrawer
        vehicle={preset ? null : vehicle}
        onClose={onClose}
        onSchedule={
          hasPermission('maintenance:write')
            ? (v, risk) => setPreset({ vehicle: v, type: 'inspection', description: inspectionDescription(risk) })
            : undefined
        }
      />
      <LogRepairDrawer
        open={preset !== null}
        preset={preset}
        canInventory={hasPermission('inventory:read')}
        onClose={() => {
          setPreset(null)
          onClose()
        }}
      />
    </>
  )
}
