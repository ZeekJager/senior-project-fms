// Reference data the seed draws from: Ethiopian depots and cities, names,
// vehicle models and spare parts. Plausible, not real: no real people.

export interface Place {
  city: string;
  latitude: number;
  longitude: number;
}

/** Depot sites, in the order profiles take them. */
export const DEPOT_SITES: readonly (Place & { name: string; code: string })[] = [
  { name: 'Addis Ababa Central', code: 'ADD-01', city: 'Addis Ababa', latitude: 9.0108, longitude: 38.7613 },
  { name: 'Adama Logistics Hub', code: 'ADM-01', city: 'Adama', latitude: 8.5408, longitude: 39.2716 },
  { name: 'Hawassa Depot', code: 'HWS-01', city: 'Hawassa', latitude: 7.0621, longitude: 38.4764 },
  { name: 'Bahir Dar Depot', code: 'BDR-01', city: 'Bahir Dar', latitude: 11.5936, longitude: 37.3908 },
  { name: 'Dire Dawa Yard', code: 'DIR-01', city: 'Dire Dawa', latitude: 9.6009, longitude: 41.8501 },
  { name: 'Mekelle Depot', code: 'MEK-01', city: 'Mekelle', latitude: 13.4967, longitude: 39.4753 },
  { name: 'Gondar Depot', code: 'GDR-01', city: 'Gondar', latitude: 12.6, longitude: 37.4667 },
  { name: 'Jimma Depot', code: 'JIM-01', city: 'Jimma', latitude: 7.6667, longitude: 36.8333 },
];

/** Route destinations. */
export const CITIES: readonly Place[] = [
  { city: 'Addis Ababa', latitude: 9.0108, longitude: 38.7613 },
  { city: 'Adama', latitude: 8.5408, longitude: 39.2716 },
  { city: 'Hawassa', latitude: 7.0621, longitude: 38.4764 },
  { city: 'Bahir Dar', latitude: 11.5936, longitude: 37.3908 },
  { city: 'Dire Dawa', latitude: 9.6009, longitude: 41.8501 },
  { city: 'Mekelle', latitude: 13.4967, longitude: 39.4753 },
  { city: 'Gondar', latitude: 12.6, longitude: 37.4667 },
  { city: 'Jimma', latitude: 7.6667, longitude: 36.8333 },
  { city: 'Debre Birhan', latitude: 9.6797, longitude: 39.5322 },
  { city: 'Bishoftu', latitude: 8.7525, longitude: 38.9781 },
  { city: 'Dessie', latitude: 11.1333, longitude: 39.6333 },
  { city: 'Harar', latitude: 9.3126, longitude: 42.1227 },
  { city: 'Shashemene', latitude: 7.2, longitude: 38.6 },
  { city: 'Nekemte', latitude: 9.0833, longitude: 36.55 },
  { city: 'Arba Minch', latitude: 6.0333, longitude: 37.55 },
  { city: 'Woldia', latitude: 11.8333, longitude: 39.6 },
  { city: 'Ambo', latitude: 8.9833, longitude: 37.85 },
  { city: 'Debre Markos', latitude: 10.35, longitude: 37.7333 },
  { city: 'Kombolcha', latitude: 11.0833, longitude: 39.7333 },
  { city: 'Modjo', latitude: 8.5872, longitude: 39.1214 },
];

export const FIRST_NAMES: readonly string[] = [
  'Abebe', 'Almaz', 'Amanuel', 'Aster', 'Bereket', 'Bethlehem', 'Biniam', 'Dawit', 'Eden', 'Elias',
  'Eyob', 'Feven', 'Genet', 'Getachew', 'Hanna', 'Henok', 'Hiwot', 'Kalkidan', 'Kebede', 'Lemlem',
  'Liya', 'Mahlet', 'Mekdes', 'Meron', 'Mulugeta', 'Nahom', 'Rahel', 'Ruth', 'Samuel', 'Selam',
  'Senait', 'Solomon', 'Tadesse', 'Tigist', 'Tsion', 'Yared', 'Yohannes', 'Yonas', 'Zelalem', 'Zewdu',
];

export const LAST_NAMES: readonly string[] = [
  'Abera', 'Alemu', 'Assefa', 'Ayele', 'Bekele', 'Belay', 'Desta', 'Fikre', 'Gebre', 'Girma',
  'Haile', 'Kassa', 'Lemma', 'Mekonnen', 'Mengistu', 'Negash', 'Shiferaw', 'Tadesse', 'Tefera', 'Tesfaye',
  'Wolde', 'Worku', 'Yilma', 'Yohannes', 'Zewde',
];

export type SeedVehicleType = 'car' | 'suv' | 'van' | 'truck' | 'bus';

export interface VehicleModel {
  make: string;
  model: string;
  type: SeedVehicleType;
  fuel: 'diesel' | 'petrol' | 'electric' | 'hybrid';
  /** Typical consumption; null for electric. */
  mlPerKm: number | null;
}

export const VEHICLE_MODELS: readonly VehicleModel[] = [
  { make: 'Isuzu', model: 'FSR', type: 'truck', fuel: 'diesel', mlPerKm: 320 },
  { make: 'Isuzu', model: 'NPR', type: 'truck', fuel: 'diesel', mlPerKm: 180 },
  { make: 'Sino', model: 'HOWO 371', type: 'truck', fuel: 'diesel', mlPerKm: 420 },
  { make: 'Mitsubishi', model: 'Fuso Canter', type: 'truck', fuel: 'diesel', mlPerKm: 170 },
  { make: 'Toyota', model: 'Hiace', type: 'van', fuel: 'diesel', mlPerKm: 110 },
  { make: 'Hyundai', model: 'H-1', type: 'van', fuel: 'diesel', mlPerKm: 105 },
  { make: 'Toyota', model: 'Land Cruiser 79', type: 'suv', fuel: 'diesel', mlPerKm: 130 },
  { make: 'Toyota', model: 'Hilux', type: 'suv', fuel: 'diesel', mlPerKm: 95 },
  { make: 'Toyota', model: 'Corolla', type: 'car', fuel: 'petrol', mlPerKm: 70 },
  { make: 'Toyota', model: 'Corolla Cross Hybrid', type: 'car', fuel: 'hybrid', mlPerKm: 48 },
  { make: 'Toyota', model: 'Coaster', type: 'bus', fuel: 'diesel', mlPerKm: 160 },
  { make: 'Higer', model: 'KLQ6129', type: 'bus', fuel: 'diesel', mlPerKm: 280 },
];

/** Electric models: the fleet's EVs (no fuel efficiency, no fuel logs). */
export const EV_MODELS: readonly VehicleModel[] = [
  { make: 'BYD', model: 'e6', type: 'car', fuel: 'electric', mlPerKm: null },
  { make: 'BYD', model: 'T3', type: 'van', fuel: 'electric', mlPerKm: null },
  { make: 'Volkswagen', model: 'ID.4', type: 'suv', fuel: 'electric', mlPerKm: null },
  { make: 'Yutong', model: 'E12', type: 'bus', fuel: 'electric', mlPerKm: null },
];

/** The licence categories that cover each seeded vehicle type (LICENSE_CATEGORY_VEHICLE_TYPES). */
export const CATEGORY_FOR: Readonly<Record<SeedVehicleType, string>> = { car: 'B', suv: 'B', van: 'B', truck: 'C', bus: 'D' };

/** What a part renews when a repair uses it (maintenance.service_item, FMS-52); none for the rest. */
export type ServiceItem =
  | 'engine_oil'
  | 'air_filter'
  | 'fuel_filter'
  | 'coolant'
  | 'brake_pads'
  | 'brake_fluid'
  | 'clutch_fluid'
  | 'tyres'
  | 'battery'
  | 'gearbox_oil'
  | 'belts';

export const PARTS: readonly { number: string; name: string; costCents: number; renews?: ServiceItem }[] = [
  { number: 'FLT-OIL-200', name: 'Oil filter', costCents: 85_000, renews: 'engine_oil' },
  { number: 'FLT-AIR-310', name: 'Air filter', costCents: 120_000, renews: 'air_filter' },
  { number: 'FLT-FUEL-115', name: 'Fuel filter', costCents: 95_000, renews: 'fuel_filter' },
  { number: 'BRK-PAD-F40', name: 'Brake pad set (front)', costCents: 380_000, renews: 'brake_pads' },
  { number: 'BRK-PAD-R40', name: 'Brake pad set (rear)', costCents: 340_000, renews: 'brake_pads' },
  { number: 'BRK-DSC-280', name: 'Brake disc', costCents: 610_000 },
  { number: 'TYR-295-80', name: 'Tyre 295/80 R22.5', costCents: 2_450_000, renews: 'tyres' },
  { number: 'TYR-195-15', name: 'Tyre 195/70 R15', costCents: 980_000, renews: 'tyres' },
  { number: 'BAT-12V-100', name: 'Battery 12V 100Ah', costCents: 1_150_000, renews: 'battery' },
  { number: 'BLT-ALT-06', name: 'Alternator belt', costCents: 145_000, renews: 'belts' },
  { number: 'WPR-BLD-24', name: 'Wiper blade 24"', costCents: 42_000 },
  { number: 'LMP-HDL-H4', name: 'Headlamp bulb H4', costCents: 28_000 },
  { number: 'CLT-KIT-430', name: 'Clutch kit', costCents: 3_800_000 },
  { number: 'SHK-ABS-F2', name: 'Shock absorber (front)', costCents: 720_000 },
  { number: 'OIL-15W40-5', name: 'Engine oil 15W-40, 5 L', costCents: 310_000, renews: 'engine_oil' },
  { number: 'CLN-50-5L', name: 'Coolant, 5 L', costCents: 160_000, renews: 'coolant' },
];

/**
 * What failed on a corrective repair (FMS-125), from the catalogues in docs/maintenance.md, and the
 * share of such failures that are unplanned (a breakdown or found in service, not at planned work).
 */
export interface RepairFailure {
  component: 'engine' | 'brakes' | 'tyres' | 'transmission' | 'electrical' | 'suspension' | 'fuel_system';
  failure_mode: 'wear' | 'breakage' | 'electrical_fault' | 'other';
  unplanned: number;
}

export const REPAIRS: readonly {
  description: string;
  type: 'preventive' | 'corrective' | 'inspection';
  parts: string[];
  hours: number;
  failure?: RepairFailure;
}[] = [
  { description: 'Scheduled service: engine oil and filters', type: 'preventive', parts: ['OIL-15W40-5', 'FLT-OIL-200', 'FLT-AIR-310'], hours: 2 },
  { description: 'Front brake pads worn below limit', type: 'corrective', parts: ['BRK-PAD-F40'], hours: 1.5, failure: { component: 'brakes', failure_mode: 'wear', unplanned: 0.2 } },
  {
    description: 'Rear brakes: pads and discs replaced',
    type: 'corrective',
    parts: ['BRK-PAD-R40', 'BRK-DSC-280'],
    hours: 3,
    failure: { component: 'brakes', failure_mode: 'wear', unplanned: 0.3 },
  },
  { description: 'Tyre replaced after sidewall damage', type: 'corrective', parts: ['TYR-295-80'], hours: 1, failure: { component: 'tyres', failure_mode: 'breakage', unplanned: 0.9 } },
  {
    description: 'Battery failed load test',
    type: 'corrective',
    parts: ['BAT-12V-100'],
    hours: 0.5,
    failure: { component: 'electrical', failure_mode: 'electrical_fault', unplanned: 0.4 },
  },
  { description: 'Squealing belt replaced', type: 'corrective', parts: ['BLT-ALT-06'], hours: 1, failure: { component: 'engine', failure_mode: 'wear', unplanned: 0.3 } },
  { description: 'Annual roadworthiness inspection', type: 'inspection', parts: [], hours: 1.5 },
  { description: 'Clutch slipping under load', type: 'corrective', parts: ['CLT-KIT-430'], hours: 6, failure: { component: 'transmission', failure_mode: 'wear', unplanned: 0.8 } },
  { description: 'Front suspension knock', type: 'corrective', parts: ['SHK-ABS-F2'], hours: 2.5, failure: { component: 'suspension', failure_mode: 'wear', unplanned: 0.6 } },
  {
    description: 'Fuel filter clogged, engine losing power',
    type: 'corrective',
    parts: ['FLT-FUEL-115'],
    hours: 1,
    failure: { component: 'fuel_system', failure_mode: 'other', unplanned: 0.9 },
  },
  { description: 'Coolant top-up and leak check', type: 'preventive', parts: ['CLN-50-5L'], hours: 0.5 },
];

/** Fluids the service history renews (FMS-55): stocked after the parts above, so their draws come last. */
export const FLUID_PARTS: readonly { number: string; name: string; costCents: number; renews: ServiceItem }[] = [
  { number: 'FLD-BRK-DOT4', name: 'Brake fluid DOT 4, 1 L', costCents: 45_000, renews: 'brake_fluid' },
  { number: 'FLD-CLT-1L', name: 'Clutch fluid, 1 L', costCents: 40_000, renews: 'clutch_fluid' },
  { number: 'OIL-GBX-75W90', name: 'Gearbox oil 75W-90, 5 L', costCents: 420_000, renews: 'gearbox_oil' },
];

/** The tyre a vehicle type runs on: `TYRES` in a service's parts. */
export const TYRE_FOR: Readonly<Record<SeedVehicleType, string>> = { car: 'TYR-195-15', suv: 'TYR-195-15', van: 'TYR-195-15', truck: 'TYR-295-80', bus: 'TYR-295-80' };

/**
 * Planned work that keeps a vehicle running (FMS-55): every wearing part and fluid the predictive model
 * reads (feature_spec.json), grouped as a workshop does it, with the interval it is usually done at.
 * The seed gives each vehicle the last time each was done, so its health score has a history to read.
 */
export const SERVICE_SCHEDULE: readonly { description: string; parts: string[]; intervalDays: number; hours: number; combustionOnly: boolean }[] = [
  { description: 'Scheduled service: engine oil and filters', parts: ['OIL-15W40-5', 'FLT-OIL-200', 'FLT-AIR-310'], intervalDays: 120, hours: 2, combustionOnly: true },
  { description: 'Fuel filter replaced at its interval', parts: ['FLT-FUEL-115'], intervalDays: 365, hours: 1, combustionOnly: true },
  { description: 'Coolant and brake fluid changed', parts: ['CLN-50-5L', 'FLD-BRK-DOT4'], intervalDays: 730, hours: 1.5, combustionOnly: false },
  { description: 'Brake pads replaced at the wear limit', parts: ['BRK-PAD-F40', 'BRK-PAD-R40'], intervalDays: 540, hours: 2, combustionOnly: false },
  { description: 'Tyres replaced at the tread limit', parts: ['TYRES'], intervalDays: 1460, hours: 2, combustionOnly: false },
  { description: 'Battery replaced at the end of its service life', parts: ['BAT-12V-100'], intervalDays: 1460, hours: 0.5, combustionOnly: false },
  { description: 'Drive belt, gearbox oil and clutch fluid changed', parts: ['BLT-ALT-06', 'OIL-GBX-75W90', 'FLD-CLT-1L'], intervalDays: 1095, hours: 3, combustionOnly: true },
];

export const WORKSHOPS: readonly string[] = ['Depot workshop', 'Moenco service centre', 'Nyala Motors workshop', 'Roadside repair'];

export const FUEL_STATIONS: readonly string[] = ['Total Energies', 'NOC', 'Kobil', 'Oilibya', 'Yetebaberut', 'Gomeju Oil'];

/** Pump prices per litre in cents (ETB), by fuel. */
export const FUEL_PRICE_CENTS: Readonly<Record<'diesel' | 'petrol' | 'hybrid', number>> = { diesel: 10_855, petrol: 11_270, hybrid: 11_270 };
