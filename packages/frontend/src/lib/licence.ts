// Ethiopian driving licence classes (docs/driving-licences.md), as a driver holds them and as the screens name them.
// The API checks what each class covers; the limits shown here are its LICENCE_LIMITS.

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
] as const
export type LicenseCategory = (typeof LICENSE_CATEGORIES)[number]

export const LICENSE_CATEGORY_LABELS: Record<LicenseCategory, string> = {
  motorcycle: 'Motorcycle',
  automobile: 'Automobile',
  taxi_1: 'Taxi 1',
  taxi_2: 'Taxi 2',
  public_1: 'Public 1',
  public_2: 'Public 2',
  dry_cargo_1: 'Dry cargo 1',
  dry_cargo_2: 'Dry cargo 2',
  dry_cargo_3: 'Dry cargo 3',
  liquid_cargo_1: 'Liquid cargo 1',
  liquid_cargo_2: 'Liquid cargo 2',
  special: 'Special equipment',
}

/** What each class covers, in a few words, for the form. */
export const LICENSE_CATEGORY_SCOPES: Record<LicenseCategory, string> = {
  motorcycle: 'Motorcycles',
  automobile: 'Up to 8 seats, 3.5 t',
  taxi_1: 'Three-wheelers',
  taxi_2: 'Up to 12 seats',
  public_1: 'Up to 24 seats',
  public_2: 'Any bus',
  dry_cargo_1: 'Up to 7.5 t',
  dry_cargo_2: 'Up to 18 t',
  dry_cargo_3: 'Any truck',
  liquid_cargo_1: 'Tankers up to 18 t',
  liquid_cargo_2: 'Any tanker',
  special: 'Special machinery',
}

/** Grouped as the form shows them. */
export const LICENSE_CATEGORY_GROUPS: { label: string; categories: LicenseCategory[] }[] = [
  { label: 'Two and three wheels', categories: ['motorcycle', 'taxi_1'] },
  { label: 'Cars and minibuses', categories: ['automobile', 'taxi_2'] },
  { label: 'Public transport', categories: ['public_1', 'public_2'] },
  { label: 'Dry cargo', categories: ['dry_cargo_1', 'dry_cargo_2', 'dry_cargo_3'] },
  { label: 'Liquid cargo', categories: ['liquid_cargo_1', 'liquid_cargo_2'] },
  { label: 'Special', categories: ['special'] },
]

export const licenceLabel = (category: string) => LICENSE_CATEGORY_LABELS[category as LicenseCategory] ?? category

/** A driver's classes in words: "Automobile, Dry cargo 2". */
export const licenceText = (categories: readonly string[]) => categories.map(licenceLabel).join(', ')

/** What a vehicle is built to carry (the licence check reads it with its seats and gross weight). */
export const VEHICLE_BODIES = ['passenger', 'dry_cargo', 'tanker', 'special'] as const
export type VehicleBody = (typeof VEHICLE_BODIES)[number]

export const VEHICLE_BODY_LABELS: Record<VehicleBody, string> = {
  passenger: 'Passengers',
  dry_cargo: 'Dry cargo',
  tanker: 'Tanker (liquid)',
  special: 'Special equipment',
}
