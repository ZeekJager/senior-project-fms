import { describe, expect, test } from 'vitest';
import { LICENSE_CATEGORIES, categoryAllows, categoryCovers, drivableTypes, normalizeCategories, type LicensedVehicle, type LicenseCategory } from './licence';
import { VEHICLE_TYPES, type VehicleType } from './vehicle';

/** A vehicle with only what is given recorded. */
const vehicle = (type: VehicleType, more: Partial<LicensedVehicle> = {}): LicensedVehicle => ({ type, body: null, seats: null, grossWeightKg: null, ...more });

/** The classes, of all of them, that cover the vehicle. */
const covering = (v: LicensedVehicle) => LICENSE_CATEGORIES.filter((c) => categoryCovers(c, v));

describe('Ethiopian licence classes (docs/driving-licences.md)', () => {
  test('a motorcycle or three-wheeler: the motorcycle class or taxi 1', () => {
    expect(covering(vehicle('motorcycle'))).toEqual(['motorcycle', 'taxi_1']);
  });

  test('a private car: automobile up to 8 seats and 3,500 kg; taxi 2 and the public classes carry passengers too', () => {
    expect(covering(vehicle('car', { seats: 4, grossWeightKg: 1_600 }))).toEqual(['automobile', 'taxi_2', 'public_1', 'public_2']);
    // A minibus (van, 11 seats): past the automobile's 8.
    expect(covering(vehicle('van', { body: 'passenger', seats: 11 }))).toEqual(['taxi_2', 'public_1', 'public_2']);
  });

  test('public transport by seats: public 1 up to 24, public 2 any; a bus is never an automobile or taxi', () => {
    expect(covering(vehicle('bus', { seats: 24 }))).toEqual(['public_1', 'public_2']);
    expect(covering(vehicle('bus', { seats: 25 }))).toEqual(['public_2']);
  });

  test('dry cargo by gross weight: grade 1 up to 7,500 kg, grade 2 up to 18,000 kg, grade 3 any', () => {
    expect(covering(vehicle('truck', { grossWeightKg: 7_500 }))).toEqual(['dry_cargo_1', 'dry_cargo_2', 'dry_cargo_3']);
    expect(covering(vehicle('truck', { grossWeightKg: 18_000 }))).toEqual(['dry_cargo_2', 'dry_cargo_3']);
    expect(covering(vehicle('truck', { grossWeightKg: 40_000 }))).toEqual(['dry_cargo_3']);
    // A light truck up to 3,500 kg is a light commercial vehicle: an automobile licence covers it.
    expect(covering(vehicle('truck', { grossWeightKg: 3_500 }))).toEqual(['automobile', 'dry_cargo_1', 'dry_cargo_2', 'dry_cargo_3']);
  });

  test('a tanker needs a liquid cargo class: grade 1 up to 18,000 kg, grade 2 any; dry cargo does not cover it', () => {
    expect(covering(vehicle('truck', { body: 'tanker', grossWeightKg: 18_000 }))).toEqual(['liquid_cargo_1', 'liquid_cargo_2']);
    expect(covering(vehicle('truck', { body: 'tanker', grossWeightKg: 26_000 }))).toEqual(['liquid_cargo_2']);
  });

  test('special mobile equipment: the special class only', () => {
    expect(covering(vehicle('other'))).toEqual(['special']);
    expect(covering(vehicle('truck', { body: 'special' }))).toEqual(['special']);
  });

  test('details not recorded are not held against the driver: the vehicle is checked by its type', () => {
    // A truck with no weight: any dry cargo grade (not an automobile licence: it is not known to be light).
    expect(covering(vehicle('truck'))).toEqual(['dry_cargo_1', 'dry_cargo_2', 'dry_cargo_3']);
    // A van with no body may carry passengers or goods.
    expect(covering(vehicle('van'))).toEqual(['automobile', 'taxi_2', 'public_1', 'public_2', 'dry_cargo_1', 'dry_cargo_2', 'dry_cargo_3']);
    expect(covering(vehicle('bus'))).toEqual(['public_1', 'public_2']);
  });

  test('a vehicle is allowed when any class held covers it; none held, or an unknown one, covers nothing', () => {
    const heavy = vehicle('truck', { grossWeightKg: 25_000 });
    expect(categoryAllows(['automobile', 'dry_cargo_3'], heavy)).toBe(true);
    expect(categoryAllows(['automobile', 'dry_cargo_2'], heavy)).toBe(false);
    expect(categoryAllows([], vehicle('car'))).toBe(false);
    expect(categoryAllows(['B'], vehicle('car'))).toBe(false);
  });

  test('every vehicle type is covered by some class', () => {
    for (const type of VEHICLE_TYPES) expect(covering(vehicle(type)).length, type).toBeGreaterThan(0);
  });

  test('the console pairs drivers with the types their classes may cover', () => {
    expect(drivableTypes(['automobile'])).toEqual(['car', 'suv', 'van']);
    expect(drivableTypes(['dry_cargo_1', 'public_2'])).toEqual(['car', 'suv', 'van', 'truck', 'bus']);
    expect(drivableTypes(['liquid_cargo_2'])).toEqual([]);
    expect(drivableTypes(['special'])).toEqual(['other']);
  });

  test('classes are kept in order without duplicates', () => {
    const held: LicenseCategory[] = ['dry_cargo_2', 'automobile', 'motorcycle', 'automobile'];
    expect(normalizeCategories(held)).toEqual(['motorcycle', 'automobile', 'dry_cargo_2']);
  });
});
