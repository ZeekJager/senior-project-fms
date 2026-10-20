import { describe, expect, test } from 'vitest';
import { pool } from '../../src/db';
import { TripRepository } from '../../src/modules/trip/infrastructure/trip.repository';
import { createDepot, createDriver, createTrip, createVehicle } from '../support/factories';

/**
 * The interval arithmetic behind BR-1 (driver) and BR-3 (vehicle): the query
 * the assignment asks "is this driver or vehicle on another trip in this
 * window?". It is SQL, so it is tested on the database. The service's use of
 * the answer is unit-tested in trip.service.assign.test.ts; the same rule is
 * enforced again by the exclusion constraints (trip-assignment.test.ts).
 */

const repo = new TripRepository(pool);

/** A time on one fixed day, `h:mm`, in UTC. */
const at = (hhmm: string) => new Date(`2031-03-04T${hhmm}:00Z`);

const COLUMNS = [
  ['BR-1', 'driver_id'],
  ['BR-3', 'vehicle_id'],
] as const;

describe.each(COLUMNS)('%s: overlapping trips of one %s', (_rule, column) => {
  /** One assigned trip 09:00-10:00 for a fresh driver and vehicle; the query is about `column`'s id. */
  async function existing(status = 'assigned', start = '09:00', end = '10:00') {
    const depot = await createDepot();
    const [vehicle, { driver }] = [await createVehicle({ depot }), await createDriver({ depot })];
    const trip = await createTrip({ vehicle, driver, status, scheduled_start: at(start).toISOString(), scheduled_end: at(end).toISOString() });
    const subject = column === 'driver_id' ? driver : vehicle;
    return { trip, subject, depot, vehicle, driver };
  }

  const clash = async (subject: { id: string }, start: string, end: string, except = '0') => repo.overlapping(pool, column, subject.id, at(start), at(end), except);

  test.each([
    ['the same window', '09:00', '10:00'],
    ['a partial overlap (09:30-11:00)', '09:30', '11:00'],
    ['an overlap at the other end (08:00-09:30)', '08:00', '09:30'],
    ['a trip inside it (09:15-09:45)', '09:15', '09:45'],
    ['a trip around it (08:00-12:00)', '08:00', '12:00'],
    ['starting the moment it ends (10:00-11:00): a 0-minute gap is an overlap', '10:00', '11:00'],
    ['ending the moment it starts (08:00-09:00): a 0-minute gap is an overlap', '08:00', '09:00'],
  ])('blocks %s', async (_label, start, end) => {
    const { trip, subject } = await existing();
    expect(await clash(subject, start, end)).toBe(trip.public_id);
  });

  test.each([
    ['one minute after it ends (10:01-11:00)', '10:01', '11:00'],
    ['one minute before it starts (08:00-08:59)', '08:00', '08:59'],
    ['hours later (12:00-13:00)', '12:00', '13:00'],
    ['hours earlier (06:00-07:00)', '06:00', '07:00'],
  ])('allows %s', async (_label, start, end) => {
    const { subject } = await existing();
    expect(await clash(subject, start, end)).toBeNull();
  });

  test('a trip around it blocks, and so does it around a trip: both ways round', async () => {
    const wide = await existing('assigned', '09:00', '12:00');
    expect(await clash(wide.subject, '10:00', '11:00')).toBe(wide.trip.public_id);
    const narrow = await existing('assigned', '10:00', '11:00');
    expect(await clash(narrow.subject, '09:00', '12:00')).toBe(narrow.trip.public_id);
  });

  test('an en-route trip counts like an assigned one', async () => {
    const { trip, subject } = await existing('en_route');
    expect(await clash(subject, '09:30', '10:30')).toBe(trip.public_id);
  });

  test.each(['scheduled', 'completed', 'cancelled'])('a %s trip does not count: it holds nobody', async (status) => {
    const { subject } = await existing(status);
    expect(await clash(subject, '09:30', '10:30')).toBeNull();
  });

  test('the trip being assigned does not clash with itself', async () => {
    const { trip, subject } = await existing();
    expect(await clash(subject, '09:30', '10:30', trip.id as string)).toBeNull();
  });

  test("another driver's or vehicle's trip does not count", async () => {
    const { subject } = await existing();
    const stranger = await existing();
    expect(await clash({ id: stranger.subject.id }, '11:00', '12:00')).toBeNull();
    expect(await clash(subject, '09:30', '10:30')).not.toBeNull();
  });
});

describe('with several trips in the way', () => {
  test('the earliest one is named', async () => {
    const depot = await createDepot();
    const [vehicle, { driver }] = [await createVehicle({ depot }), await createDriver({ depot })];
    const [first, second] = [
      await createTrip({ vehicle, driver, scheduled_start: at('09:00').toISOString(), scheduled_end: at('10:00').toISOString() }),
      await createTrip({ vehicle, driver, scheduled_start: at('11:00').toISOString(), scheduled_end: at('12:00').toISOString() }),
    ];
    expect(await repo.overlapping(pool, 'driver_id', driver.id, at('08:00'), at('13:00'), '0')).toBe(first.public_id);
    expect(await repo.overlapping(pool, 'driver_id', driver.id, at('10:30'), at('13:00'), '0')).toBe(second.public_id);
  });

  test("a driver's trips do not block the vehicle, nor the reverse", async () => {
    const depot = await createDepot();
    const [vehicle, { driver }] = [await createVehicle({ depot }), await createDriver({ depot })];
    await createTrip({ vehicle, driver, scheduled_start: at('09:00').toISOString(), scheduled_end: at('10:00').toISOString() });
    const [otherVehicle, { driver: otherDriver }] = [await createVehicle({ depot }), await createDriver({ depot })];
    expect(await repo.overlapping(pool, 'driver_id', otherDriver.id, at('09:00'), at('10:00'), '0')).toBeNull();
    expect(await repo.overlapping(pool, 'vehicle_id', otherVehicle.id, at('09:00'), at('10:00'), '0')).toBeNull();
  });
});
