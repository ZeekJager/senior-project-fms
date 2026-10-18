import { AppError } from '../../../shared/errors/app-error';

/** A point on the map. Both parts or neither. */
export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** A planned stop between origin and destination, in travel order. */
export interface RouteStop {
  name: string;
  latitude: number | null;
  longitude: number | null;
}

/** A route as the API returns it (api-contract §7.1). Public ids only. */
export interface RouteView {
  id: string;
  name: string;
  depot_id: string;
  origin_name: string | null;
  origin: Coordinates | null;
  destination_name: string | null;
  destination: Coordinates | null;
  stops: RouteStop[];
  /** Entered by hand until the mapping adapter (FMS-84) measures it. */
  distance_km: number | null;
  estimated_duration_seconds: number | null;
  /** False once retired: kept for the trips that used it, not offered for new ones. */
  is_active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export const ROUTE_EVENTS = {
  created: 'RouteCreated',
  /** Any change, retiring (is_active false) included; changed_fields says what. */
  updated: 'RouteUpdated',
} as const;

export const routeNotFound = () => new AppError(404, 'NOT_FOUND', 'Route not found.');

export const routeDepotNotFound = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The depot does not exist or is outside your depots.', [
    { field: 'depot_id', reason: 'references_missing_record' },
  ]);

export const duplicateRouteName = () =>
  new AppError(409, 'CONFLICT_DUPLICATE', 'The depot already has an active route with this name.', [
    { field: 'name', reason: 'already_exists' },
  ]);
