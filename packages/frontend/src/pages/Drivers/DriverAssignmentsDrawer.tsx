import { Drawer } from '@/components/ui'
import { AssignmentsPanel } from '@/features/assignments'
import type { Driver } from './types'

/** A driver's regular vehicles (FMS-77): the current one and the history, and with assignment:write, assign or end one. */
export function DriverAssignmentsDrawer({ driver, onClose }: { driver: Driver | null; onClose: () => void }) {
  return (
    <Drawer open={driver !== null} onClose={onClose} title={driver ? `${driver.full_name}: vehicles` : 'Vehicles'} description="What this driver normally drives, apart from trips.">
      {driver && <AssignmentsPanel key={driver.id} subject={{ kind: 'driver', id: driver.id }} depotId={driver.depot_id} name={driver.full_name} />}
    </Drawer>
  )
}
