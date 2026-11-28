import { createHash } from 'node:crypto';
import { toBirr, toLitres } from '../../../lib/units';
import { SEVERITIES, type AlertSeverity } from './alert';

// The alert rules (FMS-92, §34): which events become alerts, how severe, about what, de-duplicated on
// which key and window, and who is told first. One rule per event type; an event without a rule (or that
// its rule's `when` turns down) is not an alert. Events of cards not built yet (fuel anomalies, the
// telemetry rules, maintenance risk, EV battery) have their rules here already: their payloads are the
// contract those cards publish (CONVENTIONS.md, Events).

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
  /** Whether this event is an alert at all; without it, every event of the type is. */
  when?: (payload: Payload) => boolean;
  /** A repeat within this many minutes of the last occurrence updates the active alert; after it, a new one opens. */
  windowMinutes: number;
  title: (payload: Payload, names: Names) => string;
  message: (payload: Payload, names: Names) => string;
  /** Roles told when it opens (tier 0). Escalation then tells ESCALATION_TIERS in turn. Each holds alert:read. */
  audience: readonly string[];
  /**
   * A repeat that raises the active alert's severity tells the audience again, on the new severity's channels.
   * Without it a repeat notifies nobody: the alert they already have just changes.
   */
  renotifyWhenRaised?: boolean;
  /**
   * FMS-149: a driver who is told too, in their own words, in the app and by push only (PERSONAL_CHANNELS): `driver`,
   * the alert's driver (their own licence); `vehicle_driver`, the driver of the vehicle's trip under way, else its next
   * assigned one. Told when the alert opens and again when it grows more severe (amber to red, due to overdue). It is
   * information: the alert stays the audience's to act on.
   */
  personal?: PersonalNotice;
  /**
   * FMS-163: also posted to the channels with no recipient (a Teams channel) when it opens, and again when it resolves.
   * For the monitoring alerts, which an operations channel follows.
   */
  channelPost?: boolean;
}

/** What a driver is told of an alert about them or their vehicle (FMS-149). */
export interface PersonalNotice {
  who: 'driver' | 'vehicle_driver';
  title: (payload: Payload, names: Names) => string;
  message: (payload: Payload, names: Names) => string;
}

/** The notification type of what a driver is told of their own (FMS-149): it opens their own screen, not the alert's. */
export const PERSONAL_NOTIFICATION_TYPE = 'alert_personal';

/** Who a critical alert goes to when nobody acknowledges it: fleet managers, then administrators. */
export const ESCALATION_TIERS: readonly (readonly string[])[] = [['fleet_manager'], ['admin']];

/** Tier 0 (the rule's audience), then the escalation tiers. */
export const tiersOf = (rule: AlertRule): readonly (readonly string[])[] => [rule.audience, ...ESCALATION_TIERS];

const str = (p: Payload, key: string): string | null => (typeof p[key] === 'string' && (p[key] as string) !== '' ? (p[key] as string) : null);
const num = (p: Payload, key: string): number | null => (typeof p[key] === 'number' ? (p[key] as number) : null);
const severityOr = (p: Payload, key: string, fallback: AlertSeverity): AlertSeverity =>
  SEVERITIES.includes(p[key] as AlertSeverity) ? (p[key] as AlertSeverity) : fallback;
/** A UUID that is the same for the same text: entity ids are UUIDs, and an alert from outside has none. */
const uuidOf = (text: string): string => {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const vehicleName = (names: Names) => names.plate ?? 'a vehicle';
const daysLabel = (days: number | null) => (days === null ? 'soon' : days <= 0 ? 'today' : days === 1 ? 'in 1 day' : `in ${days} days`);
const humanize = (s: string | null) => (s ?? 'item').replace(/_/g, ' ');
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Litres and birr for a sentence, from whole ml and whole cents. */
const litres = (ml: number) => `${toLitres(ml)} L`;
const birr = (cents: number) => `${toBirr(cents)} birr`;
/** What a fill-up anomaly (FMS-82) is called in a title; any other type is a reconciliation's. */
const FILL_UP_TITLES: Record<string, string> = {
  tank_capacity_exceeded: 'Fill-up above the tank',
  refuel_interval_too_short: 'Refuelled too soon',
  price_per_litre_out_of_range: 'Fuel price out of range',
  fill_up_away_from_vehicle: 'Fill-up away from the vehicle',
};
const HOUR = 60;
const DAY = 24 * HOUR;
/** What a BackupAtRisk (FMS-108) is called, by its condition. */
const BACKUP_RISK_TITLES: Record<string, string> = {
  archiving_failing: 'WAL archiving is failing',
  repository_unreachable: 'Backup repository unreachable',
  offsite_behind: 'Off-site backup copy behind',
  status_stale: 'Backup status not reported',
  base_backup_missing: 'No recent base backup',
  drill_failed: 'Restore drill failed',
  drill_overdue: 'Restore drill overdue',
};
/** Flag types alerted from events of their own (FMS-90), not from TelemetryFlagRaised. */
const LOCATION_FLAG_TYPES = ['geofence_violation', 'route_deviation'];

const km = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })} km`;
/** "14:35", Addis Ababa. */
const addisClock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Africa/Addis_Ababa' });
const minutesLabel = (n: number) => (n >= 120 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n} minute${n === 1 ? '' : 's'}`);
const addisDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Addis_Ababa' });

/** What a ServiceDue or ServiceOverdue says of the measures that made it so, against the vehicle's readings. */
function serviceMeasures(p: Payload): string {
  const measures = Array.isArray(p.due_by) ? p.due_by.filter((m): m is string => typeof m === 'string') : [];
  const parts = measures.flatMap((m) => {
    const nextKm = num(p, 'next_due_km');
    const odometer = num(p, 'odometer_km');
    const nextAt = str(p, 'next_due_at');
    const nextHours = num(p, 'next_due_engine_hours');
    const hours = num(p, 'engine_hours');
    if (m === 'km' && nextKm !== null) return [`${km(nextKm)}${odometer !== null ? ` (odometer ${km(odometer)})` : ''}`];
    if (m === 'days' && nextAt !== null) return [addisDate(nextAt)];
    if (m === 'engine_hours' && nextHours !== null) return [`${nextHours} engine hours${hours !== null ? ` (now ${hours})` : ''}`];
    return [];
  });
  return parts.join(', ');
}

/**
 * Preventive service programs (FMS-129): `vehicle_id`, `depot_id`, `program_id`, `program_name`, `status`,
 * `previous_status`, `due_by`, `next_due_km`, `next_due_at`, `next_due_engine_hours`, `odometer_km`,
 * `engine_hours`. Due and overdue share one source per vehicle and program: falling overdue raises the
 * alert of its coming due to high instead of opening a second one.
 */
function serviceRule(overdue: boolean): AlertRule {
  return {
    type: () => 'service_due',
    module: 'maintenance',
    facts: (p) => ({
      severity: overdue ? 'high' : 'medium',
      vehicleId: str(p, 'vehicle_id'),
      driverId: null,
      tripId: null,
      depotId: str(p, 'depot_id'),
      entity: str(p, 'vehicle_id') ? { type: 'vehicle', id: str(p, 'vehicle_id')! } : null,
      dedupKey: `service_due:${str(p, 'vehicle_id')}:${str(p, 'program_id')}`,
    }),
    windowMinutes: 31 * DAY,
    title: (p, n) => `${str(p, 'program_name') ?? 'Service'} ${overdue ? 'overdue' : 'due'}: ${vehicleName(n)}`,
    message: (p, n) => {
      const measures = serviceMeasures(p);
      return overdue
        ? `${vehicleName(n)} is past its service${measures ? `, which fell due at ${measures}` : ''}. Book it into the workshop before its next trip.`
        : `${vehicleName(n)} is due for service${measures ? ` at ${measures}` : ''}. Book it into the workshop.`;
    },
    audience: ['technician', 'depot_admin'],
    // FMS-149: the driver of its next trip knows; the workshop still books it.
    personal: {
      who: 'vehicle_driver',
      title: (p, n) => `${str(p, 'program_name') ?? 'Service'} ${overdue ? 'overdue' : 'due'}: ${vehicleName(n)}`,
      message: (p, n) => {
        const measures = serviceMeasures(p);
        return overdue
          ? `${vehicleName(n)}, the vehicle you drive next, is past its service${measures ? `, which fell due at ${measures}` : ''}. The workshop books it in; tell the depot of anything you notice on it.`
          : `${vehicleName(n)}, the vehicle you drive next, is due for service${measures ? ` at ${measures}` : ''}. The workshop books it in; there is nothing for you to do.`;
      },
    },
  };
}

export const ALERT_RULES: Readonly<Record<string, AlertRule>> = {
  // A DVIR with defects (FMS-36), or a diagnostic trouble code from telematics (FMS-132, source `telematics`). FMS-118's
  // technician alert. A code is its own alert (its dedup key names it), which its clear closes (ALERT_RESOLVERS).
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
      dedupKey: isTelematicsFault(p) ? faultCodeKey(p) : `vehicle_fault:${str(p, 'vehicle_id')}`,
    }),
    windowMinutes: HOUR,
    title: (p, n) => (isTelematicsFault(p) ? `Fault code ${str(p, 'code') ?? ''} on ${vehicleName(n)}` : `Defects reported on ${vehicleName(n)}`),
    message: (p, n) => {
      if (isTelematicsFault(p)) {
        const what = str(p, 'description');
        return `${vehicleName(n)}'s telematics reports ${str(p, 'protocol') === 'j1939' ? 'J1939' : 'OBD-II'} code ${str(p, 'code') ?? ''}${what ? ` (${what})` : ''}. Check it in the workshop; the alert closes by itself when the code clears.`;
      }
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
    // FMS-149: and the driver whose licence it is, only them.
    personal: {
      who: 'driver',
      title: (p) => `Your driving licence expires ${daysLabel(num(p, 'days_left'))}`,
      message: (p) =>
        `Your driving licence expires on ${str(p, 'license_expiry') ?? 'its expiry date'}. Renew it and show the new one at the depot office: without a valid licence you cannot be given trips.`,
    },
  },

  // FMS-133: a vehicle's warranty ending within 30 days (amber), 7 (red), raised by the expiry job (FMS-26).
  WarrantyExpiring: {
    type: () => 'warranty_expiring',
    module: 'fleet',
    facts: (p) => ({
      severity: str(p, 'level') === 'red' ? 'high' : 'medium',
      vehicleId: str(p, 'vehicle_id'),
      driverId: null,
      tripId: null,
      depotId: null,
      entity: str(p, 'warranty_id') ? { type: 'warranty', id: str(p, 'warranty_id')! } : null,
      dedupKey: `warranty_expiring:${str(p, 'warranty_id')}:${str(p, 'ends_on')}`,
    }),
    windowMinutes: 31 * DAY,
    title: (p, n) => `Warranty ends ${daysLabel(num(p, 'days_left'))}: ${vehicleName(n)}`,
    message: (p, n) => {
      const component = str(p, 'component');
      const what = component ? `${humanize(component)} warranty` : 'warranty';
      return `The ${what} of ${vehicleName(n)} from ${str(p, 'provider') ?? 'its provider'} ends on ${str(p, 'ends_on') ?? 'its end date'}. Have anything it covers inspected and claimed before then.`;
    },
    audience: ['technician', 'depot_admin'],
  },

  // FMS-133: a manufacturer's recall now applies to a vehicle. `recall_id`, `campaign_code`, `vehicle_id`, `description`.
  VehicleRecallOpened: {
    type: () => 'vehicle_recall',
    module: 'maintenance',
    facts: (p) => ({
      severity: 'high',
      vehicleId: str(p, 'vehicle_id'),
      driverId: null,
      tripId: null,
      depotId: null,
      entity: str(p, 'vehicle_id') ? { type: 'vehicle', id: str(p, 'vehicle_id')! } : null,
      dedupKey: `vehicle_recall:${str(p, 'vehicle_id')}:${str(p, 'recall_id')}`,
    }),
    windowMinutes: 31 * DAY,
    title: (p, n) => `Recall ${str(p, 'campaign_code') ?? ''}: ${vehicleName(n)}`.replace('Recall :', 'Recall:'),
    message: (p, n) => `${vehicleName(n)} is under a manufacturer's recall: ${str(p, 'description') ?? 'see the recall'}. Book the remedy into the workshop.`,
    audience: ['technician', 'depot_admin'],
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
    title: (p, n) => {
      const fillUp = FILL_UP_TITLES[str(p, 'anomaly_type') ?? ''];
      return fillUp ? `${fillUp}: ${vehicleName(n)}` : `Unexpected fuel use on ${vehicleName(n)}`;
    },
    message: (p) => {
      // The monthly reconciliation (FMS-41): a month's fuel against what its trips needed.
      const deviation = num(p, 'deviation_pct');
      const km = num(p, 'distance_km');
      const from = str(p, 'period_from');
      if (deviation !== null && km !== null && from !== null) {
        const month = new Date(from).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'Africa/Addis_Ababa' });
        const driven = `${Math.round(km).toLocaleString('en-US')} km`;
        return deviation > 0
          ? `Fuel logged in ${month} was ${deviation}% more than its ${driven} of trips needed. Check its fill-ups against its trips.`
          : `Fuel logged in ${month} was ${-deviation}% less than its ${driven} of trips needed: fill-ups may be missing. Check them against its trips.`;
      }
      // One fill-up judged on its own (FMS-82): the figures it was judged on are in the payload.
      const quantity = num(p, 'quantity_ml');
      switch (str(p, 'anomaly_type')) {
        case 'tank_capacity_exceeded': {
          const over = num(p, 'over_ml');
          const tank = num(p, 'tank_capacity_ml');
          if (quantity !== null && over !== null && tank !== null) return `A fill-up of ${litres(quantity)} was logged, ${litres(over)} more than the ${litres(tank)} tank holds. Check the fill-up.`;
          break;
        }
        case 'refuel_interval_too_short': {
          const used = num(p, 'used_ml');
          if (quantity !== null && km !== null && used !== null) return `${litres(quantity)} was added after only ${km} km since the last fill-up, which needed about ${litres(used)}. Check whether the tank was filled.`;
          break;
        }
        case 'price_per_litre_out_of_range': {
          const price = num(p, 'price_cents_per_litre');
          const min = num(p, 'band_min_cents_per_litre');
          const max = num(p, 'band_max_cents_per_litre');
          if (price !== null && min !== null && max !== null) return `Fuel was bought at ${birr(price)} a litre, outside the usual ${birr(min)} to ${birr(max)}. Check the receipt.`;
          break;
        }
        case 'fill_up_away_from_vehicle':
          if (km !== null) return `A fill-up was logged ${km} km from where the vehicle's GPS had it then. Check the fill-up.`;
          break;
      }
      return `${capitalize(humanize(str(p, 'anomaly_type') ?? 'fuel anomaly'))} detected. Check the fill-up against the trip.`;
    },
    audience: ['depot_admin', 'fleet_manager'],
  },

  // The telemetry rules (FMS-46): `flag_id`, `vehicle_id`, `driver_id`, `trip_id`, `depot_id`, `flag_type`, `severity`, `observed_at`.
  // A geofence or route deviation flag (FMS-90) is alerted from its own event below, with the fence or the distance.
  TelemetryFlagRaised: {
    type: () => 'unsafe_driving',
    module: 'integration',
    when: (p) => !LOCATION_FLAG_TYPES.includes(str(p, 'flag_type') ?? ''),
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

  // Geofences (FMS-90): a vehicle left a keep-in fence or entered a keep-out one. `flag_id`, `vehicle_id`, `driver_id`, `trip_id`,
  // `depot_id`, `geofence_id`, `geofence_name`, `kind`, `observed_at`, `lat`, `lng`. Each fence is its own source.
  GeofenceViolated: {
    type: () => 'geofence_violation',
    module: 'integration',
    facts: (p) => ({
      severity: 'high',
      vehicleId: str(p, 'vehicle_id'),
      driverId: str(p, 'driver_id'),
      tripId: str(p, 'trip_id'),
      depotId: str(p, 'depot_id'),
      entity: str(p, 'flag_id') ? { type: 'telemetry_flag', id: str(p, 'flag_id')! } : null,
      dedupKey: `geofence:${str(p, 'vehicle_id')}:${str(p, 'geofence_id') ?? 'unknown'}`,
    }),
    windowMinutes: 30,
    title: (p, n) => `${str(p, 'kind') === 'keep_out' ? 'Entered' : 'Left'} ${str(p, 'geofence_name') ?? 'a geofence'}: ${vehicleName(n)}`,
    message: (p, n) =>
      str(p, 'kind') === 'keep_out'
        ? `${vehicleName(n)} entered ${str(p, 'geofence_name') ?? 'a no-go zone'}, a zone it must keep out of. Contact the driver.`
        : `${vehicleName(n)} left ${str(p, 'geofence_name') ?? 'its geofence'}, an area it must stay inside. Check it is authorised to.`,
    audience: ['dispatcher', 'depot_admin'],
  },

  // Route deviation (FMS-90): a vehicle on a trip was off its route's road for the consecutive pings the threshold asks.
  // `flag_id`, `vehicle_id`, `driver_id`, `trip_id`, `depot_id`, `route_id`, `distance_m`, `route_deviation_m`, `consecutive_pings`.
  RouteDeviationDetected: {
    type: () => 'route_deviation',
    module: 'integration',
    facts: (p) => ({
      severity: 'medium',
      vehicleId: str(p, 'vehicle_id'),
      driverId: str(p, 'driver_id'),
      tripId: str(p, 'trip_id'),
      depotId: str(p, 'depot_id'),
      entity: str(p, 'flag_id') ? { type: 'telemetry_flag', id: str(p, 'flag_id')! } : null,
      dedupKey: `route_deviation:${str(p, 'vehicle_id')}:${str(p, 'trip_id') ?? 'none'}`,
    }),
    windowMinutes: 60,
    title: (_p, n) => `Off route: ${vehicleName(n)}`,
    message: (p, n) => {
      const metres = num(p, 'distance_m');
      const pings = num(p, 'consecutive_pings');
      const how = metres !== null ? `${metres.toLocaleString('en-US')} m from its route` : 'off its route';
      return `${vehicleName(n)} was ${how}${pings !== null ? ` for ${pings} pings in a row` : ''}. Contact the driver.`;
    },
    audience: ['dispatcher', 'depot_admin'],
  },

  // Predictive maintenance (FMS-55): `prediction_id`, `vehicle_id`, `risk_level`, `failure_probability`, `health_score`,
  // `factors` (the inputs raising the risk most), `component` (null: the model names none).
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
      const score = num(p, 'health_score');
      const component = str(p, 'component');
      const factors = Array.isArray(p.factors) ? p.factors.filter((f): f is string => typeof f === 'string') : [];
      const chance = probability !== null ? `a ${Math.round(probability * 100)}% chance of a breakdown within 30 days` : 'a breakdown is likely';
      return [
        component ? `${capitalize(humanize(component))}: ` : '',
        score !== null ? `health score ${score}, ` : '',
        chance,
        factors.length ? `, mostly from ${factors.map(humanize).join(', ')}` : '',
        '. Schedule an inspection.',
      ]
        .join('')
        .replace(/^./, (c) => c.toUpperCase());
    },
    audience: ['technician', 'depot_admin'],
  },

  // Preventive service programs (FMS-129): a vehicle's service under a program coming due, and falling overdue.
  ServiceDue: serviceRule(false),
  ServiceOverdue: serviceRule(true),

  // The model registry (FMS-127): the nightly scoring did not score. `model_id`, `model_version`, `reason`
  // (feature_spec_mismatch, artefact_mismatch, not_active). Fleet-wide: for administrators.
  MlScoringBlocked: {
    type: () => 'ml_scoring_blocked',
    module: 'maintenance',
    facts: (p) => ({
      severity: str(p, 'reason') === 'not_active' ? 'medium' : 'high',
      vehicleId: null,
      driverId: null,
      tripId: null,
      depotId: null,
      entity: str(p, 'model_id') ? { type: 'ml_model', id: str(p, 'model_id')! } : null,
      dedupKey: `ml_scoring_blocked:${str(p, 'model_id')}:${str(p, 'reason')}`,
    }),
    windowMinutes: DAY,
    title: (p) => `Maintenance scoring paused: model ${str(p, 'model_version') ?? 'unknown'}`,
    message: (p) => {
      const version = str(p, 'model_version') ?? 'unknown';
      switch (str(p, 'reason')) {
        case 'not_active':
          return `Model ${version} is registered but not active. Review it and activate it to resume scoring.`;
        case 'artefact_mismatch':
          return `The ML service serves another model under version ${version}, which names a registered model. No vehicle is scored until it serves a new version.`;
        default:
          return `Model ${version} was trained on other inputs than the core computes. No vehicle is scored until a matching model is served.`;
      }
    },
    audience: ['admin'],
  },

  // Backups (FMS-108, docs/backups.md): recovery at risk, from the backup-monitor job. `condition` (archiving_failing,
  // repository_unreachable, offsite_behind, status_stale, base_backup_missing, drill_failed, drill_overdue), `severity`
  // (critical: email, SMS and push; high: push), `repo`, `since`, `message`. Published once per risk; for administrators.
  BackupAtRisk: {
    type: () => 'backup_at_risk',
    module: 'backup',
    facts: (p) => ({
      severity: severityOr(p, 'severity', 'high'),
      vehicleId: null,
      driverId: null,
      tripId: null,
      depotId: null,
      entity: null,
      dedupKey: `backup_at_risk:${str(p, 'condition')}:${num(p, 'repo') ?? 'all'}`,
    }),
    windowMinutes: DAY,
    title: (p) => BACKUP_RISK_TITLES[str(p, 'condition') ?? ''] ?? 'Backups at risk',
    message: (p) => str(p, 'message') ?? 'Point-in-time recovery is at risk. See the Backups screen.',
    audience: ['admin'],
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
    // FMS-98's metrics read as what they mean; any other as before.
    message: (p) => {
      const value = num(p, 'value');
      const threshold = num(p, 'threshold');
      const metric = str(p, 'metric');
      if (value !== null && threshold !== null) {
        if (metric === 'state_of_charge') return `Charge is down to ${value}%, below ${threshold}%.`;
        if (metric === 'battery_health') return `Battery health is ${value}%, below ${threshold}%: the battery is wearing out.`;
        if (metric === 'range') return `Range of ${value} km is short of the ${threshold} km left on its trip.`;
      }
      return `${capitalize(humanize(metric ?? 'battery'))} is past its limit${value !== null && threshold !== null ? ` (${value} against ${threshold})` : ''}.`;
    },
    audience: ['dispatcher', 'depot_admin'],
  },

  // The trip delay alert (FMS-147, trip): a trip under way expected past its scheduled end by the depot's margin.
  // `trip_id`, `depot_id`, `vehicle_id`, `driver_id`, `level` (late, urgent), `episode`, `late_minutes`, `margin_minutes`,
  // `scheduled_end`, `arrival_at`, `destination`. Each time the trip falls late is its own source; becoming urgent raises
  // that alert to critical, which tells the dispatchers again by email, SMS and push.
  TripDelayed: {
    type: () => 'trip_delayed',
    module: 'trip',
    facts: (p) => ({
      severity: str(p, 'level') === 'urgent' ? 'critical' : 'medium',
      vehicleId: str(p, 'vehicle_id'),
      driverId: str(p, 'driver_id'),
      tripId: str(p, 'trip_id'),
      depotId: str(p, 'depot_id'),
      entity: str(p, 'trip_id') ? { type: 'trip', id: str(p, 'trip_id')! } : null,
      dedupKey: `trip_delayed:${str(p, 'trip_id')}:${num(p, 'episode') ?? 0}`,
    }),
    windowMinutes: DAY,
    title: (p, n) => `${str(p, 'level') === 'urgent' ? 'Trip far behind schedule' : 'Trip running late'}${n.plate ? `: ${n.plate}` : ''}`,
    message: (p, n) => {
      const late = num(p, 'late_minutes');
      const arrival = str(p, 'arrival_at');
      const end = str(p, 'scheduled_end');
      const where = str(p, 'destination') ?? 'its destination';
      const who = n.plate ?? 'The vehicle';
      if (late === null || arrival === null || end === null) return `${who} is expected past its trip's scheduled end. Contact the driver.`;
      return `${who} is expected at ${where} at ${addisClock(arrival)}, ${minutesLabel(late)} after the trip's scheduled end at ${addisClock(end)}. Contact the driver or tell the customer.`;
    },
    audience: ['dispatcher'],
    renotifyWhenRaised: true,
  },

  // Score appeals (FMS-159, docs/score-appeals.md): `appeal_id`, `driver_id`, `depot_id` (the driver's when they
  // appealed), `due_at`, `status`. An appeal undecided past its review deadline goes to its depot's admins, once.
  AppealOverdue: {
    type: () => 'appeal_overdue',
    module: 'analytics',
    facts: (p) => ({
      severity: 'medium',
      vehicleId: null,
      // Not the driver: the alert is the reviewers' to act on, and its message never names them.
      driverId: null,
      tripId: null,
      depotId: str(p, 'depot_id'),
      entity: str(p, 'appeal_id') ? { type: 'appeal', id: str(p, 'appeal_id')! } : null,
      dedupKey: `appeal_overdue:${str(p, 'appeal_id')}`,
    }),
    windowMinutes: 31 * DAY,
    title: () => 'Score appeal overdue',
    message: (p) =>
      `A driver's score appeal has waited past its review deadline${str(p, 'due_at') ? ` (${addisDate(str(p, 'due_at')!)} ${addisClock(str(p, 'due_at')!)})` : ''}. Claim it in Appeals and decide it.`,
    audience: ['depot_admin'],
  },

  // Assignment exceptions (FMS-151, docs/assignment-exceptions.md): `exception_id`, `trip_id`, `depot_id` (the
  // route's), `proposed_driver_id`, `proposed_vehicle_id`, `warnings`, `reason`, `route_name`, `scheduled_start`.
  // An assignment held for approval: the depot's fleet managers decide.
  AssignmentExceptionRequested: {
    type: () => 'assignment_exception',
    module: 'trip',
    facts: (p) => ({
      severity: 'medium',
      vehicleId: null,
      driverId: null,
      tripId: str(p, 'trip_id'),
      depotId: str(p, 'depot_id'),
      entity: str(p, 'trip_id') ? { type: 'trip_assignment', id: str(p, 'trip_id')! } : null,
      dedupKey: `assignment_exception:${str(p, 'exception_id')}`,
    }),
    windowMinutes: DAY,
    title: (p) => `Assignment needs approval${str(p, 'route_name') ? `: ${str(p, 'route_name')}` : ''}`,
    message: (p) => {
      const warnings = Array.isArray(p.warnings) ? (p.warnings as unknown[]) : [];
      const what = [
        warnings.includes('DRIVER_ATTENDANCE') ? 'the driver is marked absent, on leave or sick that day' : null,
        warnings.includes('PREVIOUS_TRIP_OVERRUN') ? 'a trip still under way runs into it' : null,
      ].filter(Boolean);
      const start = str(p, 'scheduled_start');
      return `A dispatcher asks to assign the trip${start ? ` of ${addisClock(start)}` : ''} although ${what.join(' and ') || 'it raises a warning'}. Reason given: ${str(p, 'reason') ?? 'none'}. Approve or refuse it on the dispatch console.`;
    },
    audience: ['fleet_manager'],
  },

  // A held assignment refused (FMS-151): the depot's dispatchers are told why. An approval assigns the trip, which
  // the console shows; it is not an alert.
  AssignmentExceptionDecided: {
    type: () => 'assignment_exception_refused',
    module: 'trip',
    when: (p) => p.decision === 'refused',
    facts: (p) => ({
      severity: 'low',
      vehicleId: null,
      driverId: null,
      tripId: str(p, 'trip_id'),
      depotId: str(p, 'depot_id'),
      entity: str(p, 'trip_id') ? { type: 'trip_assignment', id: str(p, 'trip_id')! } : null,
      dedupKey: `assignment_exception_refused:${str(p, 'exception_id')}`,
    }),
    windowMinutes: DAY,
    title: (p) => `Assignment refused${str(p, 'route_name') ? `: ${str(p, 'route_name')}` : ''}`,
    message: (p) => `A fleet manager refused the assignment you asked for. Why: ${str(p, 'reason') ?? 'no reason given'}. Choose another driver or vehicle.`,
    audience: ['dispatcher'],
  },

  // Incident reports (FMS-38): `incident_id`, `depot_id`, `vehicle_id`, `driver_id`, `trip_id`, `severity`,
  // `incident_type`. Only a critical incident is an alert; every one reaches the command center's incident list.
  IncidentReported: {
    type: () => 'incident',
    module: 'alert',
    when: (p) => p.severity === 'critical',
    facts: (p) => ({
      severity: 'critical',
      vehicleId: str(p, 'vehicle_id'),
      driverId: str(p, 'driver_id'),
      tripId: str(p, 'trip_id'),
      depotId: str(p, 'depot_id'),
      entity: str(p, 'incident_id') ? { type: 'incident', id: str(p, 'incident_id')! } : null,
      dedupKey: `incident:${str(p, 'incident_id')}`,
    }),
    windowMinutes: DAY,
    title: (p, n) => `${capitalize(humanize(str(p, 'incident_type') ?? 'incident'))} reported${n.plate ? ` on ${n.plate}` : ''}`,
    message: (p) => `A critical incident was reported${p.maintenance_flag_set === true ? ' and the vehicle is flagged for maintenance' : ''}. Review it and follow up.`,
    audience: ['dispatcher', 'depot_admin'],
  },

  // Monitoring (FMS-109, FMS-163, docs/observability.md): an alert Prometheus fired, through Alertmanager's webhook
  // (POST /system/alerts/webhook): `fingerprint`, `alert_name`, `severity` (critical or warning), `host`, `summary`,
  // `description`, `started_at`. Fleet-wide: the administrators. Critical by email, SMS and push too; a warning in the
  // app; both posted to Teams. MonitoringAlertResolved (Alertmanager's resolved) closes it by itself (ALERT_RESOLVERS).
  MonitoringAlertFiring: {
    type: (p) => `monitoring_${(str(p, 'alert_name') ?? 'alert').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 80)}`,
    module: 'system',
    facts: (p) => ({
      severity: p.severity === 'critical' ? 'critical' : 'medium',
      vehicleId: null,
      driverId: null,
      tripId: null,
      depotId: null,
      // The link opens the resources (System health); the id is the alert's, stable for its fingerprint.
      entity: { type: 'monitoring', id: uuidOf(`monitoring:${str(p, 'fingerprint')}`) },
      dedupKey: `monitoring:${str(p, 'fingerprint')}`,
    }),
    windowMinutes: 7 * DAY,
    title: (p) => `${p.severity === 'critical' ? 'Critical' : 'Warning'}: ${str(p, 'summary') ?? humanize(str(p, 'alert_name'))}${str(p, 'host') ? ` (${str(p, 'host')})` : ''}`,
    message: (p) => str(p, 'description') ?? 'A monitored limit was passed. Open System health to see the resource.',
    audience: ['admin'],
    renotifyWhenRaised: true,
    channelPost: true,
  },
};

/**
 * Events that close an active alert by themselves (FMS-163): the event's dedup key, as its firing rule made it. The
 * alert is resolved with no person (resolved_by null), its queued messages are dropped, and its channels told.
 */
export const ALERT_RESOLVERS: Record<string, (payload: Payload) => string | null> = {
  MonitoringAlertResolved: (p) => (str(p, 'fingerprint') ? `monitoring:${str(p, 'fingerprint')}` : null),
  // FMS-132: the provider cleared the code.
  VehicleFaultCleared: (p) => (isTelematicsFault(p) ? faultCodeKey(p) : null),
};

/** A fault from a vehicle's telematics (FMS-132), not a DVIR. */
function isTelematicsFault(p: Payload): boolean {
  return str(p, 'source') === 'telematics' && Boolean(str(p, 'vehicle_id')) && Boolean(str(p, 'code'));
}

/** One alert per vehicle and code: what VehicleFaultDetected opens and VehicleFaultCleared closes. */
function faultCodeKey(p: Payload): string {
  return `vehicle_fault:${str(p, 'vehicle_id')}:${str(p, 'protocol') ?? 'obd2'}:${str(p, 'code')}`;
}
