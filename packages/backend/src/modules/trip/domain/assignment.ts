import type { AssignmentWarning } from './trip';

/**
 * Fleet's availability answer for one vehicle or driver (FMS-76), as the trip
 * module reads it through FleetRefs. Structural: trip does not import fleet's
 * types, only its index.ts at wiring time.
 */
export interface AvailabilityAnswer {
  availability: 'available' | 'unavailable' | 'available_with_warning';
  reasons: { code: string; severity: 'block' | 'warning'; trip_id?: string }[];
}

/** Why fleet's availability refuses an assignment, before the trip's own rules (eligibility, BR-1, BR-3). */
export type AvailabilityRefusal =
  | { kind: 'depot'; field: 'vehicle_id' | 'driver_id' }
  | { kind: 'vehicle_not_active'; status: 'retired' | 'inactive' }
  | { kind: 'vehicle_flagged' };

const ATTENDANCE: Record<string, 'absent' | 'on_leave' | 'sick'> = {
  driver_absent: 'absent',
  driver_on_leave: 'on_leave',
  driver_sick: 'sick',
};

/**
 * The assignment's reading of fleet availability (FMS-31 on FMS-76), first
 * refusal wins, in this order: the vehicle belongs to another depot; it is
 * retired or out of service; it is flagged or in the workshop (BR-2); the
 * driver belongs to another depot. Attendance (absent, on leave, sick) is a
 * warning, never a refusal.
 *
 * Not read from here: overlapping trips, which the trip module checks on its
 * own table (BR-1, BR-3), and the driver's retirement, account and licence,
 * which fleet's eligibility check reports with the licence class it needs
 * the vehicle for. Both appear in the availability answer too; the trip
 * module's own checks give the same answer with the conflicting record.
 */
export function readAvailability(vehicle: AvailabilityAnswer, driver: AvailabilityAnswer): { refusal: AvailabilityRefusal | null; warnings: AssignmentWarning[] } {
  const v = new Set(vehicle.reasons.map((r) => r.code));
  const d = new Set(driver.reasons.map((r) => r.code));
  const warnings: AssignmentWarning[] = driver.reasons.flatMap((r) =>
    ATTENDANCE[r.code] ? [{ warning: 'DRIVER_ATTENDANCE' as const, field: 'driver_id' as const, attendance: ATTENDANCE[r.code] }] : [],
  );
  let refusal: AvailabilityRefusal | null = null;
  if (v.has('vehicle_other_depot')) refusal = { kind: 'depot', field: 'vehicle_id' };
  else if (v.has('vehicle_retired')) refusal = { kind: 'vehicle_not_active', status: 'retired' };
  else if (v.has('vehicle_out_of_service')) refusal = { kind: 'vehicle_not_active', status: 'inactive' };
  else if (v.has('maintenance_flag') || v.has('vehicle_in_maintenance')) refusal = { kind: 'vehicle_flagged' };
  else if (d.has('driver_other_depot')) refusal = { kind: 'depot', field: 'driver_id' };
  return { refusal, warnings };
}
