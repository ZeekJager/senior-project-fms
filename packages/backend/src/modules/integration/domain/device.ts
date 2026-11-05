import { AppError, notFound, validationFailed } from '../../../shared/errors/app-error';

// The device registry (FMS-138, docs/telematics.md): which tracker reports for which vehicle.

/** Unknown device ids kept per provider: past this the service stops adding (the daily counts still count them). */
export const MAX_UNKNOWN_DEVICES_PER_PROVIDER = 1_000;

export type DeviceStatus = 'active' | 'inactive' | 'faulty' | 'removed';

/** A device as GET /integrations/devices returns it. Never its token or the token's hash. */
export interface DeviceView {
  id: string;
  device_identifier: string;
  device_model: string | null;
  /** The telematics provider whose webhooks name it; null for a device with its own token. */
  provider: { id: string; code: string; name: string } | null;
  /** How it reports: `provider` webhooks, or `token` (POST /tracking/gps-pings with its own token). */
  credential: 'provider' | 'token';
  vehicle: { id: string; registration_number: string };
  status: DeviceStatus;
  installed_at: Date | null;
  removed_at: Date | null;
  last_seen_at: Date | null;
  /** Why its last refused position was refused, and when. */
  last_error: { reason: string; at: Date } | null;
}

/** A device id a provider's signed deliveries named that is linked to no vehicle. */
export interface UnknownDeviceView {
  provider: { id: string; code: string; name: string };
  device_identifier: string;
  first_seen_at: Date;
  last_seen_at: Date;
  /** Positions refused for it so far. */
  positions: number;
}

export const deviceNotFound = () => notFound('Device not found.');

export const providerNotTelematics = (reason: 'references_missing_record' | 'not_telematics') =>
  validationFailed([{ field: 'provider_id', reason }], reason === 'not_telematics' ? 'Devices are linked to telematics providers only.' : 'No such provider.');

export const vehicleNotLinkable = (reason: 'references_missing_record' | 'vehicle_retired') =>
  validationFailed([{ field: 'vehicle_id', reason }], reason === 'vehicle_retired' ? 'The vehicle has been retired.' : 'No such vehicle.');

/** The identifier is another provider's device, or a device with its own token: identifiers are unique across the fleet. */
export const identifierTaken = () =>
  new AppError(409, 'CONFLICT_DUPLICATE', 'This device id is already registered to another provider or as a token device.', [
    { field: 'device_identifier', reason: 'already_exists' },
  ]);

/** The vehicle already has another active device: linking with `replace` takes that one out of service. */
export const vehicleHasDevice = (identifier: string, devicePublicId: string) =>
  new AppError(409, 'CONFLICT_DUPLICATE', `The vehicle already has device ${identifier}. Link with replace to take it out of service.`, [
    { field: 'vehicle_id', reason: 'vehicle_has_device', record_id: devicePublicId },
  ]);
