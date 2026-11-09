import { AppError } from '../../../shared/errors/app-error';
import type { FailureComponent } from './failure';

// Warranties, warranty claims and manufacturer recalls (FMS-133, docs/warranties-recalls.md).

/** Where the fleet operates: a warranty's dates and a repair's work date are days there. */
const OPERATING_TIME_ZONE = 'Africa/Addis_Ababa';

/** The day of `at` where the fleet operates, `YYYY-MM-DD`. */
export function operatingDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: OPERATING_TIME_ZONE }).format(at);
}

/** Days from `from` to `to` (YYYY-MM-DD). */
export function daysFrom(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** As the expiry job's default window (FMS-26): within this many days of its end, a warranty is expiring. */
export const WARRANTY_EXPIRING_DAYS = 30;

export const WARRANTY_STATUSES = ['active', 'expiring', 'expired', 'not_started', 'void'] as const;
export type WarrantyStatus = (typeof WARRANTY_STATUSES)[number];

export const CLAIM_STATUSES = ['claimable', 'submitted', 'approved', 'rejected'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** What a claim can be moved to, from where it is (PATCH .../warranty-claim). */
export const CLAIM_TRANSITIONS: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> = {
  claimable: ['submitted'],
  submitted: ['approved', 'rejected'],
  approved: [],
  // A rejected claim can be sent again, with more evidence.
  rejected: ['submitted'],
};

export const RECALL_VEHICLE_STATUSES = ['open', 'scheduled', 'completed'] as const;
export type RecallVehicleStatus = (typeof RECALL_VEHICLE_STATUSES)[number];

/** A warranty, as the rules see it. */
export interface WarrantyTerms {
  id: string;
  component: FailureComponent | null;
  startsOn: string;
  endsOn: string | null;
  endsKm: number | null;
  isActive: boolean;
}

/** A repair, as a warranty claim sees it. */
export interface RepairFacts {
  /** The day the work was done: completed, else started, else entered (YYYY-MM-DD, Addis Ababa). */
  workDay: string;
  /** The odometer on the repair; null: not entered, so an end odometer cannot be judged. */
  odometerKm: number | null;
  /** The components its failures name (FMS-125). None: nothing failed, so nothing to claim. */
  components: readonly FailureComponent[];
}

/** Whether `w` covered the repair: live on its work day, under its end odometer, and on the whole vehicle or a component that failed. */
export function covers(w: WarrantyTerms, repair: RepairFacts): boolean {
  if (!w.isActive || repair.components.length === 0) return false;
  if (repair.workDay < w.startsOn) return false;
  if (w.endsOn !== null && repair.workDay > w.endsOn) return false;
  if (w.endsKm !== null && repair.odometerKm !== null && repair.odometerKm > w.endsKm) return false;
  return w.component === null || repair.components.includes(w.component);
}

/**
 * The warranty a repair is claimed under, among the vehicle's: one on a component that failed before
 * one on the whole vehicle (the narrower cover is the one the provider pays), then the one ending last,
 * then the oldest. Null: none covered it.
 */
export function coveringWarranty<W extends WarrantyTerms>(warranties: readonly W[], repair: RepairFacts): W | null {
  const covering = warranties.filter((w) => covers(w, repair));
  covering.sort(
    (a, b) =>
      Number(a.component === null) - Number(b.component === null) ||
      (b.endsOn ?? '9999-12-31').localeCompare(a.endsOn ?? '9999-12-31') ||
      Number(a.id) - Number(b.id),
  );
  return covering[0] ?? null;
}

/** A warranty's state today, with the vehicle's odometer now (null: unknown). */
export function warrantyStatus(w: WarrantyTerms, today: string, odometerKm: number | null, expiringDays = WARRANTY_EXPIRING_DAYS): WarrantyStatus {
  if (!w.isActive) return 'void';
  if (today < w.startsOn) return 'not_started';
  if (w.endsOn !== null && today > w.endsOn) return 'expired';
  if (w.endsKm !== null && odometerKm !== null && odometerKm > w.endsKm) return 'expired';
  if (w.endsOn !== null && daysFrom(today, w.endsOn) <= expiringDays) return 'expiring';
  return 'active';
}

/** A recall's target, as matching sees it. */
export interface RecallTarget {
  make: string;
  model: string;
  yearFrom: number;
  yearTo: number;
}

/** A vehicle, as recall matching sees it. */
export interface RecallCandidate {
  make: string;
  model: string;
  /** Null: not recorded, so no recall can be matched to it. */
  modelYear: number | null;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Whether a recall applies to a vehicle: its make and model (ignoring case), and a model year in the range. */
export function recallMatches(recall: RecallTarget, vehicle: RecallCandidate): boolean {
  if (vehicle.modelYear === null) return false;
  return same(recall.make, vehicle.make) && same(recall.model, vehicle.model) && vehicle.modelYear >= recall.yearFrom && vehicle.modelYear <= recall.yearTo;
}

/** A warranty as the API returns it (api-contract §10.5). Public ids only. */
export interface WarrantyView {
  id: string;
  vehicle_id: string;
  registration_number: string;
  /** Null: the whole vehicle. */
  component: FailureComponent | null;
  provider: string;
  coverage: string | null;
  starts_on: string;
  ends_on: string | null;
  ends_km: number | null;
  terms: string | null;
  is_active: boolean;
  status: WarrantyStatus;
  /** Days to `ends_on`; null without one. */
  days_left: number | null;
  /** Kilometres to `ends_km` from the vehicle's odometer now; null without one, or with no odometer. */
  km_left: number | null;
  /** The repairs claimed under it, by claim status. */
  claims: Record<ClaimStatus, number> & { recovered_cents: number };
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** The warranty claim on a repair (`warranty_claim` on a maintenance record). */
export interface WarrantyClaimView {
  warranty_id: string;
  provider: string;
  /** The warranty's component; null: the whole vehicle. */
  component: FailureComponent | null;
  status: ClaimStatus;
  /** Recovered, in cents (ETB): on an approved claim. */
  amount_cents: number | null;
  reference: string | null;
  /** The warranty's end odometer; null: it ends by date only. */
  ends_km: number | null;
  /** False: the warranty has an end odometer and the repair none, so the distance is not checked yet; submitting the claim needs the reading. */
  km_checked: boolean;
  updated_at: Date | null;
  updated_by: string | null;
}

/** A recall as the API returns it. */
export interface RecallView {
  id: string;
  campaign_code: string;
  make: string;
  model: string;
  year_from: number;
  year_to: number;
  description: string;
  remedy: string | null;
  issued_on: string | null;
  /** Its vehicles in the caller's depots, by status. */
  vehicles: { total: number } & Record<RecallVehicleStatus, number>;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** One vehicle a recall matched. */
export interface RecallVehicleView {
  recall_id: string;
  campaign_code: string;
  description: string;
  remedy: string | null;
  vehicle_id: string;
  registration_number: string;
  status: RecallVehicleStatus;
  /** The work order that carries out the remedy. */
  maintenance_record_id: string | null;
  completed_at: Date | null;
  notes: string | null;
  matched_at: Date;
  updated_at: Date;
}

/** Events. Payloads carry public ids only. */
export const WARRANTY_EVENTS = {
  /** `recall_id`, `campaign_code`, `make`, `model`, `year_from`, `year_to`, `vehicles` (how many it matched now) */
  recallIssued: 'RecallIssued',
  /** `recall_id`, `campaign_code`, `vehicle_id`, `description`: one vehicle a recall matched (on issue, an edit, or a vehicle registered or changed) */
  vehicleRecalled: 'VehicleRecallOpened',
  /** `recall_id`, `campaign_code`, `vehicle_id`, `maintenance_record_id`, `completed_at` */
  recallCompleted: 'VehicleRecallCompleted',
} as const;

export const warrantyNotFound = () => new AppError(404, 'NOT_FOUND', 'Warranty not found.');
export const recallNotFound = () => new AppError(404, 'NOT_FOUND', 'Recall not found.');
export const recallVehicleNotFound = () => new AppError(404, 'NOT_FOUND', 'That vehicle is not under this recall, or is outside your depots.');

export const warrantyVehicleNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The vehicle does not exist or is outside your depots.', [{ field: 'vehicle_id', reason: 'references_missing_record' }]);

export const warrantyEndRequired = () =>
  new AppError(400, 'VALIDATION_FAILED', 'A warranty ends on a date, at an odometer reading, or both.', [{ field: 'ends_on', reason: 'end_required' }]);

export const warrantyEndsBeforeStart = () =>
  new AppError(400, 'VALIDATION_INVALID_DATE_RANGE', 'A warranty cannot end before it starts.', [{ field: 'ends_on', reason: 'before_starts_on' }]);

export const recallYearsReversed = () =>
  new AppError(400, 'VALIDATION_INVALID_DATE_RANGE', 'The last model year comes before the first.', [{ field: 'year_to', reason: 'before_year_from' }]);

export const recallCodeTaken = () =>
  new AppError(409, 'CONFLICT_DUPLICATE', 'A recall with that campaign code is already on record.', [{ field: 'campaign_code', reason: 'duplicate' }]);

export const recallFleetWideOnly = () =>
  new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'A recall applies to the whole fleet: only a user who sees every depot can issue or change one.', [
    { reason: 'fleet_wide_not_allowed' },
  ]);

export const notClaimable = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'No warranty covered this repair, so there is nothing to claim.', [
    { reason: 'not_claimable', allowed_transitions: [] },
  ]);

export const claimTransitionNotAllowed = (from: ClaimStatus) =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', `The claim is ${from} and cannot move there.`, [
    { field: 'status', reason: 'invalid_transition', allowed_transitions: [...CLAIM_TRANSITIONS[from]] },
  ]);

export const claimAmountRequired = () =>
  new AppError(400, 'VALIDATION_FAILED', 'An approved claim needs the amount recovered.', [{ field: 'amount_cents', reason: 'required' }]);

export const claimAmountNotApproved = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Only an approved claim has an amount recovered.', [{ field: 'amount_cents', reason: 'only_when_approved' }]);

export const claimOdometerRequired = (endsKm: number) =>
  new AppError(
    400,
    'VALIDATION_FAILED',
    `The warranty ends at ${endsKm.toLocaleString('en-US')} km and this repair has no odometer reading: give the odometer at the repair to submit the claim.`,
    [{ field: 'odometer_km', reason: 'odometer_required' }],
  );

export const claimOdometerRecorded = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The repair already has its odometer reading.', [{ field: 'odometer_km', reason: 'odometer_recorded' }]);

export const claimOverKmLimit = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', "At that odometer reading the repair is past the warranty's limit: there is nothing to claim.", [
    { field: 'odometer_km', reason: 'over_km_limit', allowed_transitions: [] },
  ]);

export const recallCompletedFinal = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'The recall work on this vehicle is completed and can no longer change.', [
    { reason: 'recall_completed', allowed_transitions: [] },
  ]);

export const recallRecordNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', "The work order does not exist, is cancelled, or is another vehicle's.", [
    { field: 'maintenance_record_id', reason: 'references_missing_record' },
  ]);

export const recallScheduleNeedsRecord = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Scheduling recall work links the work order that carries it out.', [
    { field: 'maintenance_record_id', reason: 'required' },
  ]);

export const recallCompletedInFuture = () =>
  new AppError(400, 'VALIDATION_FAILED', 'Recall work cannot be completed in the future.', [{ field: 'completed_at', reason: 'in_future' }]);
