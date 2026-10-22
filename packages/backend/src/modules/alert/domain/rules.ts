import { SEVERITIES, type AlertSeverity } from './alert';

// The alert rules (FMS-92, §34): which events become alerts, how severe, about what, de-duplicated on
// which key and window, and who is told first. One rule per event type; an event without a rule is not
// an alert. Events of cards not built yet (fuel anomalies, the telemetry rules, maintenance risk, EV
// battery, incidents) have their rules here already: their payloads are the contract those cards publish
// (CONVENTIONS.md, Events).

/** An event's payload, as the outbox delivers it. */
export type Payload = Record<string, unknown>;

/** What an event says, in the terms of an alert. Ids are public ids; the engine resolves them. */
export interface AlertFacts {
  severity: AlertSeverity;
  vehicleId: string | null;
  driverId: string | null;
  tripId: string | null;
  /** A depot named by the event itself, when no vehicle or driver gives one. */
  depotId: string | null;
  entity: { type: string; id: string } | null;
  /** The source: a repeat of the same key within the window updates the active alert. */
  dedupKey: string;
}

/** What the title and message may name. Never a person's name: AlertCreated goes out to sockets with the message. */
export interface Names {
  plate: string | null;
}

export interface AlertRule {
  /** `alert_type`. */
  type: (payload: Payload) => string;
  /** The module that publishes the event (`source_module`). */
  module: string;
  facts: (payload: Payload) => AlertFacts;
  /** A repeat within this many minutes of the last occurrence updates the active alert; after it, a new one opens. */
  windowMinutes: number;
  title: (payload: Payload, names: Names) => string;
  message: (payload: Payload, names: Names) => string;
  /** Roles told when it opens (tier 0). Escalation then tells ESCALATION_TIERS in turn. Each holds alert:read. */
  audience: readonly string[];
}

/** Who a critical alert goes to when nobody acknowledges it: fleet managers, then administrators. */
export const ESCALATION_TIERS: readonly (readonly string[])[] = [['fleet_manager'], ['admin']];

/** Tier 0 (the rule's audience), then the escalation tiers. */
export const tiersOf = (rule: AlertRule): readonly (readonly string[])[] => [rule.audience, ...ESCALATION_TIERS];

const str = (p: Payload, key: string): string | null => (typeof p[key] === 'string' && (p[key] as string) !== '' ? (p[key] as string) : null);
const num = (p: Payload, key: string): number | null => (typeof p[key] === 'number' ? (p[key] as number) : null);
const severityOr = (p: Payload, key: string, fallback: AlertSeverity): AlertSeverity =>
  SEVERITIES.includes(p[key] as AlertSeverity) ? (p[key] as AlertSeverity) : fallback;
const vehicleName = (names: Names) => names.plate ?? 'a vehicle';
const daysLabel = (days: number | null) => (days === null ? 'soon' : days <= 0 ? 'today' : days === 1 ? 'in 1 day' : `in ${days} days`);
const humanize = (s: string | null) => (s ?? 'item').replace(/_/g, ' ');
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const HOUR = 60;
const DAY = 24 * HOUR;

export const ALERT_RULES: Readonly<Record<string, AlertRule>> = {
  // A DVIR with defects (FMS-36), later a telematics fault code. FMS-118's technician alert.
  VehicleFaultDetected: {
    type: () => 'vehicle_fault',
    module: 'fleet',
    facts: (p) => ({
      severity: severityOr(p, 'severity', 'high'),
      vehicleId: str(p, 'vehicle_id'),
      driverId: str(p, 'driver_id'),
      tripId: str(p, 'trip_id'),
      depotId: null,
      entity: str(p, 'dvir_report_id') ? { type: 'dvir_report', id: str(p, 'dvir_report_id')! } : str(p, 'vehicle_id') ? { type: 'vehicle', id: str(p, 'vehicle_id')! } : null,
      dedupKey: `vehicle_fault:${str(p, 'vehicle_id')}`,
    }),
    windowMinutes: HOUR,
    title: (_p, n) => `Defects reported on ${vehicleName(n)}`,
    message: (p) => {
      const defects = Array.isArray(p.defects) ? (p.defects as unknown[]).filter((d) => typeof d === 'string') : [];
      const count = num(p, 'defect_count') ?? defects.length;
      const inspection = str(p, 'inspection_type');
      return `${count} defect${count === 1 ? '' : 's'}${inspection ? ` on the ${inspection.replace('_', '-')} inspection` : ''}${defects.length ? `: ${defects.join(', ')}` : ''}.`;
    },
    audience: ['technician', 'depot_admin'],
  },

  // FMS-26: a vehicle's or driver's document expiring within 30 days (amber), 7 (red).
  DocumentExpiring: {
    type: () => 'document_expiring',
    module: 'fleet',
    facts: (p) => ({
      severity: str(p, 'level') === 'red' ? 'high' : 'medium',
      vehicleId: str(p, 'owner_type') === 'vehicle' ? str(p, 'owner_id') : null,
      driverId: str(p, 'owner_type') === 'driver' ? str(p, 'owner_id') : null,
      tripId: null,
      depotId: null,
      entity: str(p, 'document_id') ? { type: 'document', id: str(p, 'document_id')! } : null,
      dedupKey: `document_expiring:${str(p, 'document_id')}:${str(p, 'expires_on')}`,
    }),
    windowMinutes: 31 * DAY,
    title: (p) => `${capitalize(humanize(str(p, 'document_type')))} expires ${daysLabel(num(p, 'days_left'))}`,
    message: (p, n) =>
      `The ${humanize(str(p, 'document_type'))} of ${str(p, 'owner_type') === 'vehicle' ? vehicleName(n) : 'a driver'} expires on ${str(p, 'expires_on') ?? 'its expiry date'}.`,
    audience: ['depot_admin'],
  },

  // FMS-26: a driving licence expiring.
  LicenceExpiring: {
    type: () => 'licence_expiring',
    module: 'fleet',
    facts: (p) => ({
      severity: str(p, 'level') === 'red' ? 'high' : 'medium',
      vehicleId: null,
      driverId: str(p, 'driver_id'),
      tripId: null,
      depotId: str(p, 'depot_id'),
      entity: str(p, 'driver_id') ? { type: 'driver', id: str(p, 'driver_id')! } : null,
      dedupKey: `licence_expiring:${str(p, 'driver_id')}:${str(p, 'license_expiry')}`,
    }),
    windowMinutes: 31 * DAY,
    title: (p) => `Driving licence expires ${daysLabel(num(p, 'days_left'))}`,
    message: (p) => `A driver's licence expires on ${str(p, 'license_expiry') ?? 'its expiry date'}. Renew it before their next trip.`,
    audience: ['depot_admin'],
  },

  // Fuel reconciliation (FMS-82): `anomaly_id`, `vehicle_id`, `driver_id`, `fuel_log_id`, `anomaly_type`, `severity`.
  FuelAnomalyDetected: {
    type: () => 'fuel_anomaly',
    module: 'fuel',
    facts: (p) => ({
      severity: severityOr(p, 'severity', 'high'),
      vehicleId: str(p, 'vehicle_id'),
      driverId: str(p, 'driver_id'),
      tripId: str(p, 'trip_id'),
      depotId: null,
      entity: str(p, 'anomaly_id') ? { type: 'fuel_anomaly', id: str(p, 'anomaly_id')! } : null,
      dedupKey: `fuel_anomaly:${str(p, 'vehicle_id')}:${str(p, 'anomaly_type') ?? 'any'}`,
    }),
    windowMinutes: DAY,
    title: (_p, n) => `Unexpected fuel use on ${vehicleName(n)}`,
    message: (p) => `${capitalize(humanize(str(p, 'anomaly_type') ?? 'fuel anomaly'))} detected. Check the fill-up against the trip.`,
    audience: ['depot_admin', 'fleet_manager'],
  },

  // The telemetry rules (FMS-46): `flag_id`, `vehicle_id`, `driver_id`, `trip_id`, `depot_id`, `flag_type`, `severity`, `observed_at`.
  TelemetryFlagRaised: {
    type: (p) => (str(p, 'flag_type') === 'geofence_violation' ? 'geofence_violation' : 'unsafe_driving'),
    module: 'integration',
    facts: (p) => ({
      severity: severityOr(p, 'severity', str(p, 'flag_type') === 'speeding' ? 'high' : 'medium'),
      vehicleId: str(p, 'vehicle_id'),
      driverId: str(p, 'driver_id'),
      tripId: str(p, 'trip_id'),
      depotId: str(p, 'depot_id'),
      entity: str(p, 'flag_id') ? { type: 'telemetry_flag', id: str(p, 'flag_id')! } : null,
      dedupKey: `telemetry:${str(p, 'vehicle_id')}:${str(p, 'flag_type') ?? 'other'}`,
    }),
    windowMinutes: 30,
    title: (p, n) => `${capitalize(humanize(str(p, 'flag_type') ?? 'unsafe driving'))}: ${vehicleName(n)}`,
    message: (p, n) => `${vehicleName(n)} was flagged for ${humanize(str(p, 'flag_type') ?? 'unsafe driving')}. Contact the driver.`,
    audience: ['dispatcher', 'depot_admin'],
  },

  // Predictive maintenance (FMS-55): `prediction_id`, `vehicle_id`, `risk_level`, `failure_probability`, `component`.
  MaintenanceRiskDetected: {
    type: () => 'maintenance_risk',
    module: 'maintenance',
    facts: (p) => ({
      severity: severityOr(p, 'risk_level', 'medium'),
      vehicleId: str(p, 'vehicle_id'),
      driverId: null,
      tripId: null,
      depotId: null,
      entity: str(p, 'prediction_id') ? { type: 'maintenance_prediction', id: str(p, 'prediction_id')! } : null,
      dedupKey: `maintenance_risk:${str(p, 'vehicle_id')}`,
    }),
    windowMinutes: DAY,
    title: (_p, n) => `Maintenance risk on ${vehicleName(n)}`,
    message: (p) => {
      const probability = num(p, 'failure_probability');
      const component = str(p, 'component');
      return `${component ? `${capitalize(humanize(component))}: ` : ''}failure likely${probability !== null ? ` (${Math.round(probability * 100)}%)` : ''}. Schedule an inspection.`;
    },
    audience: ['technician', 'depot_admin'],
  },

  // EV battery monitoring (FMS-96): `vehicle_id`, `metric`, `value`, `threshold`, `severity`.
  BatteryThresholdExceeded: {
    type: () => 'battery',
    module: 'ev',
    facts: (p) => ({
      severity: severityOr(p, 'severity', 'high'),
      vehicleId: str(p, 'vehicle_id'),
      driverId: null,
      tripId: str(p, 'trip_id'),
      depotId: null,
      entity: str(p, 'vehicle_id') ? { type: 'vehicle', id: str(p, 'vehicle_id')! } : null,
      dedupKey: `battery:${str(p, 'vehicle_id')}:${str(p, 'metric') ?? 'any'}`,
    }),
    windowMinutes: HOUR,
    title: (_p, n) => `Battery alert on ${vehicleName(n)}`,
    message: (p) => `${capitalize(humanize(str(p, 'metric') ?? 'battery'))} is past its limit${num(p, 'value') !== null && num(p, 'threshold') !== null ? ` (${num(p, 'value')} against ${num(p, 'threshold')})` : ''}.`,
    audience: ['dispatcher', 'depot_admin'],
  },

  // Incident reports (FMS-38): `incident_id`, `depot_id`, `vehicle_id`, `trip_id`, `severity`, `incident_type`.
  IncidentReported: {
    type: () => 'incident',
    module: 'incident',
    facts: (p) => ({
      severity: severityOr(p, 'severity', 'high'),
      vehicleId: str(p, 'vehicle_id'),
      driverId: str(p, 'driver_id'),
      tripId: str(p, 'trip_id'),
      depotId: str(p, 'depot_id'),
      entity: str(p, 'incident_id') ? { type: 'incident', id: str(p, 'incident_id')! } : null,
      dedupKey: `incident:${str(p, 'incident_id')}`,
    }),
    windowMinutes: DAY,
    title: (p, n) => `${capitalize(humanize(str(p, 'incident_type') ?? 'incident'))} reported${n.plate ? ` on ${n.plate}` : ''}`,
    message: () => 'A driver reported an incident. Review it and follow up.',
    audience: ['dispatcher', 'depot_admin'],
  },
};
