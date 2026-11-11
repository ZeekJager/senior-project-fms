/**
 * Scenario 2 (FMS-61): users working the API at once. Each signed-in user, in a loop until the time is up, lists trips
 * (40%), lists vehicles (40%) or logs a fill-up for their own vehicle (20%), pausing between actions. Each user logs
 * fuel for a vehicle no other user touches, its odometer rising each time, since a reading never goes down (FMS-39).
 *
 * Before the timed window every user does each action once, all at the same moment: the warm-up. A server just started
 * answers its first requests from cold caches and connections; the warm-up's numbers are reported apart, not held to
 * the budgets, which are about the steady load the card describes.
 */
import type { FuelVehicle } from '../fixtures';
import type { UserWorkload } from '../profiles';
import { think, type Session } from '../session';
import { Recorder } from '../stats';

export interface ApiResult {
  workload: UserWorkload;
  seconds: number;
  requests: ReturnType<Recorder['table']>;
  warmup: ReturnType<Recorder['table']>;
  errors: Record<string, Record<string, number>>;
  warmupErrors: Record<string, Record<string, number>>;
  /** Failed requests, warm-up included: a failure is a failure whenever it happens. */
  errorCount: number;
}

/** 11,000 cents a litre, as the seed's diesel: within the fuel price bounds. */
const CENTS_PER_ML = 11;

type Action = (session: Session, into: Recorder) => Promise<void>;

function actionsFor(vehicle: FuelVehicle): { trips: Action; vehicles: Action; fuel: Action } {
  let odometer = vehicle.odometerKm;
  return {
    trips: async (session, into) => {
      const r = await session.request('GET', '/trips?page=1&page_size=25');
      into.record('GET /trips', r.ms, r.ok, r.outcome);
    },
    vehicles: async (session, into) => {
      const r = await session.request('GET', '/vehicles?page=1&page_size=25');
      into.record('GET /vehicles', r.ms, r.ok, r.outcome);
    },
    fuel: async (session, into) => {
      odometer = Math.round((odometer + 40 + Math.random() * 20) * 10) / 10;
      const quantity = 35_000 + Math.floor(Math.random() * 10_000);
      const r = await session.request('POST', '/fuel-logs', {
        vehicle_id: vehicle.publicId,
        quantity_ml: quantity,
        total_cost_cents: quantity * CENTS_PER_ML,
        odometer_km: odometer,
        station_name: 'Load test',
      });
      into.record('POST /fuel-logs', r.ms, r.ok, r.outcome);
    },
  };
}

export async function runApi(sessions: Session[], vehicles: FuelVehicle[], w: UserWorkload): Promise<ApiResult> {
  const recorder = new Recorder();
  const warm = new Recorder();
  const actions = sessions.map((_, i) => actionsFor(vehicles[i]));

  await Promise.all(sessions.map(async (s, i) => {
    for (const act of [actions[i].trips, actions[i].vehicles, actions[i].fuel]) await act(s, warm);
  }));

  const started = performance.now();
  const deadline = started + w.durationS * 1000;
  const user = async (session: Session, a: ReturnType<typeof actionsFor>) => {
    while (performance.now() < deadline) {
      const pick = Math.random();
      await (pick < 0.4 ? a.trips : pick < 0.8 ? a.vehicles : a.fuel)(session, recorder);
      await think(w.thinkMs);
    }
  };
  await Promise.all(sessions.map((s, i) => user(s, actions[i])));
  const seconds = (performance.now() - started) / 1000;
  return {
    workload: w,
    seconds: Math.round(seconds),
    requests: recorder.table(seconds),
    warmup: warm.table(seconds),
    errors: recorder.errors(),
    warmupErrors: warm.errors(),
    errorCount: warm.errorCount() + recorder.errorCount(),
  };
}
