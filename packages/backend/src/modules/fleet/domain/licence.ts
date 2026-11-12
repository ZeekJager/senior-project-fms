import { VEHICLE_TYPES, type VehicleType } from './vehicle';

/**
 * Ethiopian driving licence classes (docs/driving-licences.md), as a driver holds them
 * (fleet.drivers.license_categories, e.g. automobile and dry_cargo_2). A vehicle is allowed when any class held
 * covers it.
 *
 * The domestic classes, issued by the regional states and the two city administrations: motorcycle, automobile, taxi
 * (1: three-wheelers, 2: up to 12 seats), public transport (1: up to 24 seats, 2: more), dry cargo (1, 2, 3), liquid
 * cargo (1, 2) and special mobile equipment (Road Transport Authority; Tripartite Transport and Transit Facilitation
 * Programme, Ethiopia country report, 2017). Within a class a higher grade covers the lower ones.
 *
 * A class is graded by what the vehicle is (its body), its passenger seats and its gross weight. The seat limits of
 * taxi and public transport are the regulation's. The automobile's (8 seats, 3,500 kg) are the federal code 2's. The
 * weight limits of dry cargo 1 and 2 and liquid cargo 1 are PLACEHOLDERS to confirm with the client: the sources
 * name the grades without the weights. They are LICENCE_LIMITS, in one place.
 */
export const LICENSE_CATEGORIES = [
  'motorcycle',
  'automobile',
  'taxi_1',
  'taxi_2',
  'public_1',
  'public_2',
  'dry_cargo_1',
  'dry_cargo_2',
  'dry_cargo_3',
  'liquid_cargo_1',
  'liquid_cargo_2',
  'special',
] as const;
export type LicenseCategory = (typeof LICENSE_CATEGORIES)[number];

/** What a vehicle is built to carry (fleet.vehicles.body, migration 072): passengers, dry goods, liquid (a tanker), or special equipment. */
export const VEHICLE_BODIES = ['passenger', 'dry_cargo', 'tanker', 'special'] as const;
export type VehicleBody = (typeof VEHICLE_BODIES)[number];

/** The limits of each graded class: passenger seats (the driver's not counted) and gross vehicle weight, kg. */
export const LICENCE_LIMITS = {
  automobile: { seats: 8, grossKg: 3_500 },
  taxi_2: { seats: 12 },
  public_1: { seats: 24 },
  /** Placeholder (federal code 3's 7,500 kg); confirm with the client. */
  dry_cargo_1: { grossKg: 7_500 },
  /** Placeholder; confirm with the client. */
  dry_cargo_2: { grossKg: 18_000 },
  /** Placeholder for the regulation's 18,000 litres (no trailer); confirm with the client. */
  liquid_cargo_1: { grossKg: 18_000 },
} as const;

/** A vehicle as the licence check reads it. Each detail is optional: an unknown one is not held against the driver. */
export interface LicensedVehicle {
  type: VehicleType;
  body: VehicleBody | null;
  seats: number | null;
  grossWeightKg: number | null;
}

/** Types that carry passengers under an automobile or taxi licence: not buses, trucks or motorcycles. */
const LIGHT_TYPES: readonly VehicleType[] = ['car', 'suv', 'van'];

/** What a vehicle with no body recorded is taken to be, from its type. A van may be either. */
function bodiesOf(v: LicensedVehicle): readonly VehicleBody[] {
  if (v.body) return [v.body];
  switch (v.type) {
    case 'truck':
      return ['dry_cargo'];
    case 'van':
      return ['passenger', 'dry_cargo'];
    case 'other':
      return ['special'];
    case 'motorcycle':
      return [];
    default:
      return ['passenger'];
  }
}

/** At most `limit`; an unknown value passes (the vehicle record decides how exact the check is). */
const within = (value: number | null, limit: number) => value === null || value <= limit;

/** Whether one class covers the vehicle. */
export function categoryCovers(category: LicenseCategory, v: LicensedVehicle): boolean {
  const bodies = bodiesOf(v);
  const passenger = bodies.includes('passenger');
  const dry = bodies.includes('dry_cargo');
  const light = LIGHT_TYPES.includes(v.type);
  switch (category) {
    case 'motorcycle':
    case 'taxi_1':
      // A three-wheeler is recorded as a motorcycle.
      return v.type === 'motorcycle';
    case 'automobile':
      // A private car with up to 8 seats, or a light commercial vehicle up to 3,500 kg.
      return (passenger || dry) && (light || (v.grossWeightKg !== null && v.type !== 'bus')) && within(v.seats, LICENCE_LIMITS.automobile.seats) && within(v.grossWeightKg, LICENCE_LIMITS.automobile.grossKg);
    case 'taxi_2':
      return passenger && light && within(v.seats, LICENCE_LIMITS.taxi_2.seats);
    case 'public_1':
      return passenger && v.type !== 'motorcycle' && within(v.seats, LICENCE_LIMITS.public_1.seats);
    case 'public_2':
      return passenger && v.type !== 'motorcycle';
    case 'dry_cargo_1':
      return dry && within(v.grossWeightKg, LICENCE_LIMITS.dry_cargo_1.grossKg);
    case 'dry_cargo_2':
      return dry && within(v.grossWeightKg, LICENCE_LIMITS.dry_cargo_2.grossKg);
    case 'dry_cargo_3':
      return dry;
    case 'liquid_cargo_1':
      return bodies.includes('tanker') && within(v.grossWeightKg, LICENCE_LIMITS.liquid_cargo_1.grossKg);
    case 'liquid_cargo_2':
      return bodies.includes('tanker');
    case 'special':
      return bodies.includes('special');
  }
}

/** Whether any class a driver holds covers the vehicle. */
export function categoryAllows(categories: readonly string[], v: LicensedVehicle): boolean {
  return categories.some((c) => (LICENSE_CATEGORIES as readonly string[]).includes(c) && categoryCovers(c as LicenseCategory, v));
}

/** Classes without duplicates, in LICENSE_CATEGORIES order. */
export function normalizeCategories(categories: readonly LicenseCategory[]): LicenseCategory[] {
  return LICENSE_CATEGORIES.filter((c) => categories.includes(c));
}

/**
 * The vehicle types a driver's classes cover for some vehicle of that type with nothing else recorded, in
 * VEHICLE_TYPES order: the console's first pairing of drivers with vehicles. The assignment checks the vehicle itself.
 */
export function drivableTypes(categories: readonly string[]): VehicleType[] {
  return VEHICLE_TYPES.filter((type) => categoryAllows(categories, { type, body: null, seats: null, grossWeightKg: null }));
}
