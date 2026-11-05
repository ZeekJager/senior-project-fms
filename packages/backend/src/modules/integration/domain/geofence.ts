import { AppError, notFound, validationFailed } from '../../../shared/errors/app-error';
import type { Polygon, PolygonProblem } from './geometry';
import type { GeofenceApplies, GeofenceKind } from './location-rules';

// Geofences (FMS-90, docs/geofences.md): a depot's polygons that its vehicles must stay inside or out of.

/** Active fences a depot may have: each ping is checked against all of its depot's. */
export const MAX_GEOFENCES_PER_DEPOT = 50;

export const GEOFENCE_EVENTS = {
  /** A geofence was drawn, changed, removed or restored (`change`). */
  changed: 'GeofenceChanged',
  /** A vehicle left a keep-in fence or entered a keep-out one (a geofence_violation flag opened); the alert engine makes it an alert. */
  violated: 'GeofenceViolated',
  /** A vehicle on a trip was off its route's road for the consecutive pings the threshold asks (a route_deviation flag opened). */
  routeDeviationDetected: 'RouteDeviationDetected',
} as const;

/** A geofence as the API returns it (api-contract §11.1). */
export interface GeofenceView {
  geofence_id: string;
  depot_id: string;
  name: string;
  description: string | null;
  kind: GeofenceKind;
  applies: GeofenceApplies;
  polygon: Polygon;
  area_m2: number;
  is_active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  updated_by_name: string | null;
}

export const geofenceNotFound = () => notFound('Geofence not found.');

export const geofenceInactive = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', 'The geofence has been removed: restore it before changing it.', [
    { reason: 'geofence_removed', allowed_transitions: ['reactivate'] },
  ]);

export const duplicateGeofenceName = () =>
  new AppError(409, 'CONFLICT_DUPLICATE', 'The depot already has an active geofence with this name.', [{ field: 'name', reason: 'already_exists' }]);

export const tooManyGeofences = () =>
  validationFailed([{ field: 'depot_id', reason: 'geofence_limit' }], `A depot may have at most ${MAX_GEOFENCES_PER_DEPOT} active geofences.`);

const POLYGON_MESSAGES: Record<PolygonProblem, string> = {
  too_few_points: 'A geofence needs at least 3 corners.',
  too_many_points: 'A geofence may have at most 500 corners.',
  out_of_range: 'Every corner needs a latitude between -90 and 90 and a longitude between -180 and 180.',
  self_intersecting: 'The geofence’s edges cross: draw its corners in order around it.',
  too_small: 'The geofence is too small: draw it at least 20 m across.',
  too_large: 'The geofence is too large: draw it at most 500 km across.',
};

export const invalidPolygon = (problem: PolygonProblem) => validationFailed([{ field: 'polygon', reason: problem }], POLYGON_MESSAGES[problem]);
