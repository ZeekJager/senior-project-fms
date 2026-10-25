import {
  CATEGORY_FOR,
  CITIES,
  DEPOT_SITES,
  EV_MODELS,
  FIRST_NAMES,
  FUEL_PRICE_CENTS,
  FUEL_STATIONS,
  LAST_NAMES,
  PARTS,
  REPAIRS,
  VEHICLE_MODELS,
  WORKSHOPS,
  type Place,
  type SeedVehicleType,
  type ServiceItem,
} from './catalog';
import { Rng } from './random';

// The whole dataset as plain data, from (profile, seed, anchor) alone: no
// clock, no database. The same inputs always give the same plan, which is
// what makes a seed run reproducible (FMS-113). apply.ts writes it.

export type ProfileName = 'small' | 'budget';

export interface Profile {
  depots: number;
  vehicles: number;
  /** Share of vehicles that are electric. */
  evShare: number;
  drivers: number;
  routesPerDepot: number;
  trips: number;
  maintenance: number;
  /** Days of attendance up to the anchor day. */
  attendanceDays: number;
  /** Depot-scoped staff (dispatcher, depot admin, technician, finance clerk) in every depot, or only the first. */
  staffInEveryDepot: boolean;
  /** Opening stock multiplier for spare parts. */
  stockFactor: number;
}

/** small: a laptop demo. budget: the scale CFG-3's performance budgets assume (200 vehicles, 300 drivers, 1,000 trips). */
export const PROFILES: Readonly<Record<ProfileName, Profile>> = {
  small: { depots: 3, vehicles: 24, evShare: 0.125, drivers: 30, routesPerDepot: 3, trips: 80, maintenance: 20, attendanceDays: 3, staffInEveryDepot: false, stockFactor: 1 },
  budget: { depots: 8, vehicles: 200, evShare: 0.08, drivers: 300, routesPerDepot: 6, trips: 1000, maintenance: 150, attendanceDays: 1, staffInEveryDepot: true, stockFactor: 4 },
};

export const UNSCOPED_ROLES = ['admin', 'fleet_manager', 'fleet_owner', 'compliance_officer'] as const;
export const DEPOT_ROLES = ['dispatcher', 'depot_admin', 'technician', 'finance_clerk'] as const;

export type TripStatus = 'draft' | 'scheduled' | 'assigned' | 'en_route' | 'completed' | 'cancelled';

export interface PlannedDepot {
  name: string;
  code: string;
  city: string;
  latitude: number;
  longitude: number;
  capacity: number;
}

export interface PlannedPerson {
  full_name: string;
  email: string;
  phone: string;
}

export interface PlannedStaff extends PlannedPerson {
  role: string;
  depot: number | null;
}

export interface PlannedVehicle {
  registration_number: string;
  vin: string;
  make: string;
  model: string;
  year: number;
  vehicle_type: SeedVehicleType;
  fuel_type: 'diesel' | 'petrol' | 'electric' | 'hybrid';
  fuel_efficiency_ml_per_km: number | null;
  depot: number;
  /** The odometer now: the base reading plus every completed trip. */
  odometer_km: number;
}

export interface PlannedDriver extends PlannedPerson {
  depot: number;
  license_number: string;
  license_categories: string[];
  license_expiry: string;
  hire_date: string;
  emergency_phone: string;
}

export interface PlannedPart {
  part_number: string;
  name: string;
  unit_cost_cents: number;
  stock_quantity: number;
  reorder_threshold: number;
  service_item: ServiceItem | null;
}

export interface PlannedMaintenance {
  vehicle: number;
  description: string;
  maintenance_type: 'preventive' | 'corrective' | 'inspection';
  status: 'scheduled' | 'open' | 'in_progress' | 'completed';
  priority: 'low' | 'normal' | 'high' | 'critical';
  labour_hours: number;
  total_cost_cents: number;
  parts: { part: number; quantity: number }[];
  scheduled_at: string | null;
  completed_at: string | null;
  odometer_km: number;
  workshop: string;
  /** What failed (FMS-125): on corrective repairs that are under way or done. */
  failures: PlannedFailure[];
}

export interface PlannedFailure {
  component: string;
  failure_mode: string;
  unplanned: boolean;
  detected_by: 'driver_report' | 'dvir' | 'technician' | 'telematics' | 'breakdown';
  occurred_at: string;
}

/** A vehicle paper uploaded through POST /documents; its expiry drives the expiry warnings (FMS-26). */
export interface PlannedDocument {
  vehicle: number;
  document_type: 'insurance' | 'registration';
  expires_on: string;
  original_filename: string;
}

export interface PlannedAttendance {
  driver: number;
  date: string;
  status: 'present' | 'late' | 'absent' | 'on_leave' | 'sick';
}

export interface PlannedRoute {
  depot: number;
  name: string;
  origin: Place;
  destination: Place;
  distance_km: number;
  duration_seconds: number;
}

export interface PlannedTrip {
  route: number;
  status: TripStatus;
  vehicle: number | null;
  driver: number | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
  planned_distance_km: number;
  actual_distance_km: number | null;
  planned_duration_seconds: number;
  actual_duration_seconds: number | null;
}

export interface PlannedFuelLog {
  trip: number;
  vehicle: number;
  driver: number;
  fuel_type: 'diesel' | 'petrol' | 'hybrid';
  quantity_ml: number;
  unit_price_cents: number;
  total_cost_cents: number;
  odometer_km: number;
  station_name: string;
  source: 'pump' | 'fuel_card' | 'manual';
  recorded_at: string;
  latitude: number;
  longitude: number;
}

export interface SeedPlan {
  profile: ProfileName;
  seed: number;
  anchor: string;
  depots: PlannedDepot[];
  staff: PlannedStaff[];
  vehicles: PlannedVehicle[];
  drivers: PlannedDriver[];
  parts: PlannedPart[];
  maintenance: PlannedMaintenance[];
  attendance: PlannedAttendance[];
  documents: PlannedDocument[];
  routes: PlannedRoute[];
  trips: PlannedTrip[];
  fuelLogs: PlannedFuelLog[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Addis Ababa is UTC+3 all year. */
const ADDIS_OFFSET = 3 * HOUR;
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
const WMI: Record<string, string> = { Isuzu: 'JAL', Sino: 'LZZ', Mitsubishi: 'JLF', Toyota: 'JTD', Hyundai: 'KMH', Higer: 'LKL', BYD: 'LGX', Volkswagen: 'WVW', Yutong: 'LZY' };
/** Trip start times (hours after local midnight); a trip over four hours takes the whole day. */
const SLOT_STARTS = [6, 10.5, 15];
const FULL_DAY_START = 5.5;

/** Local midnight of `anchor` (YYYY-MM-DD) in Addis Ababa, as epoch ms. */
export function anchorMidnight(anchor: string): number {
  const [y, m, d] = anchor.split('-').map(Number);
  return Date.UTC(y, m - 1, d) - ADDIS_OFFSET;
}

const iso = (ms: number) => new Date(ms).toISOString();
const dateOf = (ms: number) => new Date(ms + ADDIS_OFFSET).toISOString().slice(0, 10);
const round1 = (n: number) => Math.round(n * 10) / 10;

function haversineKm(a: Place, b: Place): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Keeps generated keys (emails, plates, VINs, licence numbers) unique. */
function uniqueFrom(make: () => string): () => string {
  const seen = new Set<string>();
  return () => {
    for (let i = 0; i < 1000; i++) {
      const value = make();
      if (!seen.has(value)) {
        seen.add(value);
        return value;
      }
    }
    throw new Error('Could not generate a unique value');
  };
}

export function buildPlan(profileName: ProfileName, seed: number, anchor: string): SeedPlan {
  const profile = PROFILES[profileName];
  const rng = new Rng(seed);
  const midnight = anchorMidnight(anchor);
  const at = (dayOffset: number, hours: number) => midnight + dayOffset * DAY + Math.round(hours * HOUR);

  // People: unique emails like hanna.tesfaye@fleet.demo, then hanna.tesfaye2@...
  const emailCount = new Map<string, number>();
  const phone = uniqueFrom(() => `+251 9${rng.int(10, 99)} ${rng.int(100, 999)} ${rng.int(100, 999)}`);
  function person(): PlannedPerson {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const local = `${first}.${last}`.toLowerCase();
    const n = (emailCount.get(local) ?? 0) + 1;
    emailCount.set(local, n);
    return { full_name: `${first} ${last}`, email: `${local}${n > 1 ? n : ''}@fleet.demo`, phone: phone() };
  }

  const depots: PlannedDepot[] = DEPOT_SITES.slice(0, profile.depots).map((site) => ({
    name: site.name,
    code: site.code,
    city: site.city,
    latitude: site.latitude,
    longitude: site.longitude,
    capacity: rng.int(4, 8) * 10,
  }));
  // The first depot is the main one: it gets the largest share.
  const depotWeights = Object.fromEntries(depots.map((_, i) => [String(i), i === 0 ? 3 : 1])) as Record<string, number>;
  const pickDepot = () => Number(rng.weighted(depotWeights));

  const staff: PlannedStaff[] = [];
  for (const role of UNSCOPED_ROLES) staff.push({ ...person(), role, depot: null });
  for (const role of DEPOT_ROLES) {
    const sites = profile.staffInEveryDepot ? depots.map((_, i) => i) : [0];
    for (const depot of sites) staff.push({ ...person(), role, depot });
  }

  // Vehicles.
  const plate = uniqueFrom(() => `AA 3-${rng.int(10000, 99999)}`);
  const vinOf = (make: string) => uniqueFrom(() => WMI[make] + Array.from({ length: 14 }, () => rng.pick([...VIN_CHARS])).join(''))();
  const evCount = Math.round(profile.vehicles * profile.evShare);
  const vehicles: PlannedVehicle[] = [];
  for (let i = 0; i < profile.vehicles; i++) {
    const model = i < evCount ? rng.pick(EV_MODELS) : rng.pick(VEHICLE_MODELS);
    const year = rng.int(model.fuel === 'electric' ? 2020 : 2012, 2025);
    vehicles.push({
      registration_number: plate(),
      vin: vinOf(model.make),
      make: model.make,
      model: model.model,
      year,
      vehicle_type: model.type,
      fuel_type: model.fuel,
      fuel_efficiency_ml_per_km: model.mlPerKm === null ? null : Math.round(model.mlPerKm * rng.between(0.92, 1.1)),
      depot: pickDepot(),
      odometer_km: rng.int(5, 40) * 1000 * (2026 - year + 1) / 4,
    });
  }
  // Per depot: trips are crewed from their own depot only.
  const vehiclesIn = depots.map((_, d) => vehicles.map((v, i) => ({ v, i })).filter(({ v }) => v.depot === d));

  // Drivers: every one holds B; most also C, some D. A fifth of the
  // licences need attention: expired, or expiring within 30 days.
  const licence = uniqueFrom(() => `ET-${rng.int(1, 14).toString().padStart(2, '0')}-${rng.int(100000, 999999)}`);
  const drivers: PlannedDriver[] = [];
  for (let i = 0; i < profile.drivers; i++) {
    const categories = ['B'];
    if (rng.chance(0.65)) categories.push('C');
    if (categories.includes('C') && rng.chance(0.25)) categories.push('CE');
    if (rng.chance(0.2)) categories.push('D');
    const expiryKind = rng.weighted({ expired: 6, soon: 9, valid: 85 });
    const expiry =
      expiryKind === 'expired' ? at(-rng.int(1, 120), 0) : expiryKind === 'soon' ? at(rng.int(1, 30), 0) : at(rng.int(60, 1800), 0);
    drivers.push({
      ...person(),
      depot: pickDepot(),
      license_number: licence(),
      license_categories: categories,
      license_expiry: dateOf(expiry),
      hire_date: dateOf(at(-rng.int(30, 3650), 0)),
      emergency_phone: phone(),
    });
  }
  const driversIn = depots.map((_, d) => drivers.map((x, i) => ({ x, i })).filter(({ x }) => x.depot === d));

  // Spare parts: one shared catalogue. Two are deliberately low and out of
  // stock so the console has something to flag.
  const parts: PlannedPart[] = PARTS.map((p) => ({
    part_number: p.number,
    name: p.name,
    unit_cost_cents: p.costCents,
    stock_quantity: p.number === 'WPR-BLD-24' ? 3 : p.number === 'LMP-HDL-H4' ? 0 : rng.int(40, 120) * profile.stockFactor,
    reorder_threshold: rng.int(5, 15),
    service_item: p.renews ?? null,
  }));
  const partIndex = new Map(parts.map((p, i) => [p.part_number, i]));

  // Routes from each depot to other cities.
  const routes: PlannedRoute[] = [];
  depots.forEach((depot, d) => {
    const origin: Place = { city: depot.city, latitude: depot.latitude, longitude: depot.longitude };
    const destinations = rng.shuffle(CITIES.filter((c) => c.city !== depot.city)).slice(0, profile.routesPerDepot);
    for (const destination of destinations) {
      const distance = Math.round(haversineKm(origin, destination) * 1.25);
      routes.push({
        depot: d,
        name: `${depot.city} – ${destination.city}`,
        origin,
        destination,
        distance_km: distance,
        duration_seconds: Math.round((distance / 55) * 3600),
      });
    }
  });

  // Trips. Drivers and vehicles are never double-booked: each day has three
  // slots, and a trip longer than four hours takes the whole day.
  const busy = new Set<string>();
  const slotsOf = (fullDay: boolean, slot: number) => (fullDay ? [0, 1, 2] : [slot]);
  const free = (who: string, day: number, slots: number[]) => slots.every((s) => !busy.has(`${who}:${day}:${s}`));
  const book = (who: string, day: number, slots: number[]) => slots.forEach((s) => busy.add(`${who}:${day}:${s}`));
  const DAYS: Record<TripStatus, [number, number]> = {
    completed: [-45, -1],
    cancelled: [-30, 10],
    en_route: [0, 0],
    assigned: [1, 14],
    scheduled: [1, 21],
    draft: [2, 30],
  };
  const routesByDepot = depots.map((_, d) => routes.map((r, i) => ({ r, i })).filter(({ r }) => r.depot === d));
  const trips: PlannedTrip[] = [];
  for (let t = 0; t < profile.trips; t++) {
    let status = rng.weighted<TripStatus>({ completed: 55, cancelled: 7, en_route: 3, assigned: 15, scheduled: 12, draft: 8 });
    const depot = pickDepot();
    const { r: route, i: routeIndex } = rng.pick(routesByDepot[depot]);
    const fullDay = route.duration_seconds > 4 * 3600;
    const crewed = status === 'completed' || status === 'assigned' || status === 'en_route' || (status === 'cancelled' && rng.chance(0.5));

    let day = rng.int(...DAYS[status]);
    let slot = rng.int(0, 2);
    let vehicle: number | null = null;
    let driver: number | null = null;
    if (crewed && driversIn[depot].length > 0) {
      for (let attempt = 0; attempt < 30 && driver === null; attempt++) {
        if (attempt > 0) {
          day = rng.int(...DAYS[status]);
          slot = rng.int(0, 2);
        }
        const tripEnd = at(day + 1, 0);
        const candidate = rng.pick(driversIn[depot]);
        if (anchorMidnight(candidate.x.license_expiry) < tripEnd) continue;
        const allowed = vehiclesIn[depot].filter(({ v }) => candidate.x.license_categories.includes(CATEGORY_FOR[v.vehicle_type]));
        if (allowed.length === 0) continue;
        const choice = rng.pick(allowed);
        const slots = slotsOf(fullDay, slot);
        if (!free(`d${candidate.i}`, day, slots) || !free(`v${choice.i}`, day, slots)) continue;
        book(`d${candidate.i}`, day, slots);
        book(`v${choice.i}`, day, slots);
        driver = candidate.i;
        vehicle = choice.i;
      }
    }
    // No free crew in this depot at any tried time: the trip waits for one.
    if (crewed && driver === null && status !== 'cancelled') status = 'scheduled';

    const unscheduled = status === 'draft' && rng.chance(0.5);
    const startMs = at(day, fullDay ? FULL_DAY_START : SLOT_STARTS[slot]);
    const endMs = startMs + route.duration_seconds * 1000;
    let actualStart: number | null = null;
    let actualEnd: number | null = null;
    let actualDistance: number | null = null;
    if (status === 'completed' || status === 'en_route') actualStart = startMs + rng.int(-10, 40) * 60_000;
    if (status === 'completed') {
      actualEnd = actualStart! + Math.round(route.duration_seconds * rng.between(0.9, 1.25)) * 1000;
      actualDistance = round1(route.distance_km * rng.between(0.97, 1.12));
    }
    trips.push({
      route: routeIndex,
      status,
      vehicle,
      driver,
      scheduled_start: unscheduled ? null : iso(startMs),
      scheduled_end: unscheduled ? null : iso(endMs),
      actual_start: actualStart === null ? null : iso(actualStart),
      actual_end: actualEnd === null ? null : iso(actualEnd),
      planned_distance_km: route.distance_km,
      actual_distance_km: actualDistance,
      planned_duration_seconds: route.duration_seconds,
      actual_duration_seconds: actualStart !== null && actualEnd !== null ? Math.round((actualEnd - actualStart) / 1000) : null,
    });
  }

  // Fuel: one fill-up after every completed trip of a combustion vehicle,
  // in time order so each vehicle's odometer only goes up. About 3% are
  // well above what the distance explains, for the reconciliation screen.
  const odometer = vehicles.map((v) => v.odometer_km);
  const baseOdometer = [...odometer];
  const fuelLogs: PlannedFuelLog[] = [];
  const completed = trips.map((trip, i) => ({ trip, i })).filter(({ trip }) => trip.status === 'completed').sort((a, b) => a.trip.actual_end!.localeCompare(b.trip.actual_end!) || a.i - b.i);
  for (const { trip, i } of completed) {
    const v = vehicles[trip.vehicle!];
    odometer[trip.vehicle!] = round1(odometer[trip.vehicle!] + trip.actual_distance_km!);
    if (v.fuel_type === 'electric') continue;
    const fuel = v.fuel_type;
    const variance = rng.chance(0.03) ? rng.between(1.5, 1.8) : rng.between(0.95, 1.15);
    const quantity = Math.round(trip.actual_distance_km! * v.fuel_efficiency_ml_per_km! * variance);
    const price = FUEL_PRICE_CENTS[fuel];
    const destination = routes[trip.route].destination;
    fuelLogs.push({
      trip: i,
      vehicle: trip.vehicle!,
      driver: trip.driver!,
      fuel_type: fuel,
      quantity_ml: quantity,
      unit_price_cents: price,
      total_cost_cents: Math.round((quantity / 1000) * price),
      odometer_km: odometer[trip.vehicle!],
      station_name: `${rng.pick(FUEL_STATIONS)} ${destination.city}`,
      source: rng.weighted({ pump: 6, fuel_card: 3, manual: 1 }),
      recorded_at: iso(Date.parse(trip.actual_end!) - rng.int(10, 50) * 60_000),
      latitude: destination.latitude,
      longitude: destination.longitude,
    });
  }
  vehicles.forEach((v, i) => (v.odometer_km = odometer[i]));

  /** A vehicle's odometer at a time: its base reading plus its trips completed by then (a repair's reading, FMS-126). */
  const odometerAt = (vehicle: number, time: number) =>
    round1(baseOdometer[vehicle] + completed.filter(({ trip }) => trip.vehicle === vehicle && Date.parse(trip.actual_end!) <= time).reduce((km, { trip }) => km + trip.actual_distance_km!, 0));

  // Maintenance history: mostly completed work, some open and scheduled.
  const maintenance: PlannedMaintenance[] = [];
  for (let m = 0; m < profile.maintenance; m++) {
    const vehicle = rng.int(0, vehicles.length - 1);
    const repair = rng.pick(REPAIRS);
    const status = rng.weighted({ completed: 70, in_progress: 8, open: 10, scheduled: 12 });
    const used = repair.parts.map((number) => ({ part: partIndex.get(number)!, quantity: number.startsWith('TYR') ? rng.int(1, 2) : 1 }));
    const hours = round1(repair.hours * rng.between(0.8, 1.4));
    const partsCost = used.reduce((sum, u) => sum + parts[u.part].unit_cost_cents * u.quantity, 0);
    const day = status === 'completed' ? -rng.int(1, 180) : status === 'scheduled' ? rng.int(1, 30) : -rng.int(0, 5);
    const completedAt = status === 'completed' ? at(day, rng.int(9, 17)) : null;
    // The odometer when the vehicle came in; scheduled work has not happened yet.
    const slack = rng.int(0, 400);
    maintenance.push({
      vehicle,
      description: repair.description,
      maintenance_type: repair.type,
      status,
      priority: repair.type === 'corrective' ? rng.weighted({ normal: 5, high: 3, critical: 1 }) : 'low',
      labour_hours: hours,
      total_cost_cents: partsCost + Math.round(hours * 60_000),
      // Scheduled work takes its parts when it is done, not now.
      parts: status === 'scheduled' ? [] : used,
      scheduled_at: status === 'scheduled' ? iso(at(day, 8)) : null,
      completed_at: completedAt === null ? null : iso(completedAt),
      odometer_km: status === 'scheduled' ? round1(Math.max(0, vehicles[vehicle].odometer_km - slack)) : odometerAt(vehicle, completedAt ?? at(day, 9)),
      workshop: rng.pick(WORKSHOPS),
      failures: [],
    });
  }

  // Attendance for the last days up to the anchor.
  const attendance: PlannedAttendance[] = [];
  for (let d = profile.attendanceDays - 1; d >= 0; d--) {
    drivers.forEach((_, driver) => {
      attendance.push({ driver, date: dateOf(at(-d, 12)), status: rng.weighted({ present: 82, late: 6, absent: 4, on_leave: 5, sick: 3 }) });
    });
  }

  // Insurance and registration for every vehicle, drawn last so nothing above
  // changes. Most run for months; some expire within 30 days (amber) or 7
  // (red) of the anchor, so the expiry warnings have something to show. At
  // least one of each, even in the small profile.
  const documents: PlannedDocument[] = [];
  const expiringDay = { red: () => rng.int(0, 7), amber: () => rng.int(8, 30), valid: () => rng.int(45, 365) };
  vehicles.forEach((v, vehicle) => {
    for (const document_type of ['insurance', 'registration'] as const) {
      const kind = rng.weighted({ red: 4, amber: 8, valid: 88 });
      documents.push({
        vehicle,
        document_type,
        expires_on: dateOf(at(expiringDay[kind](), 12)),
        original_filename: `${document_type}-${v.registration_number.replace(/\s+/g, '-')}.pdf`,
      });
    }
  });
  const daysLeft = (d: PlannedDocument) => Math.round((anchorMidnight(d.expires_on) - midnight) / DAY);
  for (const level of ['red', 'amber'] as const) {
    const inLevel = (d: PlannedDocument) => (level === 'red' ? daysLeft(d) <= 7 : daysLeft(d) > 7 && daysLeft(d) <= 30);
    const valid = documents.find((d) => daysLeft(d) > 30);
    if (!documents.some(inLevel) && valid) valid.expires_on = dateOf(at(expiringDay[level](), 12));
  }

  // What failed on each corrective repair under way or done (FMS-125), drawn last so nothing above
  // changes: the repair's component and mode; unplanned ones mostly reported by the driver or a
  // breakdown, the rest found by the technician at planned work. A completed repair's failure came
  // hours to days before it was finished.
  for (const m of maintenance) {
    const failure = REPAIRS.find((r) => r.description === m.description)?.failure;
    if (!failure || m.status === 'scheduled') continue;
    const unplanned = rng.chance(failure.unplanned);
    const detected_by = unplanned ? rng.weighted({ driver_report: 4, breakdown: 3, dvir: 2, telematics: 1 }) : 'technician';
    const occurred = m.completed_at ? Date.parse(m.completed_at) - rng.int(2, 72) * HOUR : at(-rng.int(1, 6), rng.int(6, 18));
    m.failures.push({ component: failure.component, failure_mode: failure.failure_mode, unplanned, detected_by, occurred_at: iso(occurred) });
  }

  return { profile: profileName, seed, anchor, depots, staff, vehicles, drivers, parts, maintenance, attendance, documents, routes, trips, fuelLogs };
}
