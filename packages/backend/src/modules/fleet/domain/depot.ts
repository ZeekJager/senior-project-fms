import { AppError } from '../../../shared/errors/app-error';

/** A depot as the API returns it (api-contract §6.1). Public id only. */
export interface DepotView {
  id: string;
  name: string;
  /** Short code, trimmed and upper case (e.g. ADD-01); unique. */
  code: string | null;
  /** Display location, e.g. "Addis Ababa". */
  location: string;
  address: string | null;
  city: string | null;
  country: string | null;
  /** IANA zone, e.g. Africa/Addis_Ababa. */
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Vehicles the yard holds. */
  capacity: number | null;
  /** False once deleted (soft): its records stay, it leaves lists and pickers. */
  is_active: boolean;
  /** Bumped on every change; also the ETag. */
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** Event types this module publishes for depots (CONVENTIONS.md, Events). */
export const DEPOT_EVENTS = {
  created: 'DepotCreated',
  updated: 'DepotUpdated',
  deactivated: 'DepotDeactivated',
  reactivated: 'DepotReactivated',
} as const;

/** What still belongs to a depot; any of it blocks deletion. */
export interface DepotOccupancy {
  vehicles: number;
  drivers: number;
  users: number;
}

export const depotNotFoundById = () => new AppError(404, 'NOT_FOUND', 'Depot not found.');

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** DELETE /depots/{id} while active vehicles, drivers or user accounts still belong to it. */
export function depotNotEmpty(o: DepotOccupancy): AppError {
  const parts = [
    o.vehicles && plural(o.vehicles, 'active vehicle', 'active vehicles'),
    o.drivers && plural(o.drivers, 'active driver', 'active drivers'),
    o.users && plural(o.users, 'active user account', 'active user accounts'),
  ].filter(Boolean);
  return new AppError(
    409,
    'CONFLICT_DEPOT_NOT_EMPTY',
    `The depot still has ${parts.join(', ')}. Move or retire them first.`,
    (['vehicles', 'drivers', 'users'] as const).filter((k) => o[k] > 0).map((k) => ({ field: k, reason: 'still_active' })),
  );
}

export const depotInactive = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'A deleted depot cannot be changed. Reactivate it first.');

/** Listing deleted depots is for those who manage depots. */
export const inactiveDepotsForbidden = () =>
  new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'Listing deleted depots needs depot:write.');
