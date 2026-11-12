# Ethiopian driving licence classes (SE-198)

A driver may only be assigned a vehicle their licence covers. This is safety rule BR-8: an assignment that breaks it is refused, never held for approval (FMS-151). Drivers record the **domestic Ethiopian licence classes**. Before SE-198 they recorded European categories (B, C, D…), which Ethiopian licences don't use. Each class is checked against what the vehicle is, not only its type.

## The classes

Ethiopian licences are issued by the regional states and the two city administrations. They come in seven classes, some with grades. A higher grade covers what the lower grades of its class cover.

| Class (API value) | Covers |
|---|---|
| Motorcycle (`motorcycle`) | Motorcycles, three-wheelers included |
| Automobile (`automobile`) | A car or other light vehicle: up to 8 passenger seats and 3,500 kg gross weight, for people or goods (not a bus) |
| Taxi 1 (`taxi_1`) | Three-wheelers |
| Taxi 2 (`taxi_2`) | Cars, SUVs and vans carrying up to 12 passengers |
| Public 1 (`public_1`) | Passenger vehicles up to 24 seats, buses included |
| Public 2 (`public_2`) | Any passenger vehicle |
| Dry cargo 1 (`dry_cargo_1`) | Dry-cargo vehicles up to 7,500 kg gross* |
| Dry cargo 2 (`dry_cargo_2`) | Dry-cargo vehicles up to 18,000 kg gross* |
| Dry cargo 3 (`dry_cargo_3`) | Any dry-cargo vehicle |
| Liquid cargo 1 (`liquid_cargo_1`) | Tankers up to 18,000 kg gross* |
| Liquid cargo 2 (`liquid_cargo_2`) | Any tanker |
| Special equipment (`special`) | Special mobile equipment |

\* **Placeholders to confirm with the client.**
- The sources name the dry and liquid cargo grades but not their weight limits.
- 7,500 kg is the federal code 3 limit.
- The regulation states the liquid cargo 1 limit as 18,000 litres. Vehicles don't record a tank volume, so the gross weight stands in for it.

The seat limits of taxi and public transport are the regulation's (training classes Taxi 2: 1–12 seats, Public 1: 1–24, Public 2: 25 or more). The automobile's limits are the federal code 2's. All of them are `LICENCE_LIMITS` in `packages/backend/src/modules/fleet/domain/licence.ts`, in one place.

Sources: Tripartite Transport and Transit Facilitation Programme, *Ethiopia country report*, Rev 1.1 (2017), §1.1.5: the domestic classes, the federal codes 1–5, and the training classes with their seats. The legal basis is the Road Transport Authority's driver licensing regulation.

## What a vehicle records

The check reads three optional vehicle fields (migration 072), beside the type:

| Field | Values |
|---|---|
| `body` | `passenger`, `dry_cargo`, `tanker` (liquid cargo) or `special` |
| `seats` | Passenger seats, the driver not counted (0–120) |
| `gross_weight_kg` | Gross vehicle weight as registered (1–100,000 kg) |

They are set on `POST`/`PATCH /vehicles` and on the vehicle form, under *For the driver's licence*.

**Details not recorded are not held against the driver.** Without them, the vehicle is checked by its type:

| Type | Taken as |
|---|---|
| Truck | Dry cargo, any grade |
| Bus | Passengers, public 1 or 2 |
| Car, SUV | Passengers |
| Van | Passengers or dry cargo |
| Motorcycle | Motorcycle |
| Other | Special equipment |

A tanker must have `body: tanker` recorded to need a liquid cargo class. So record the details of trucks, tankers and buses: that is where the grades matter.

## The check

- **Assignment:** `POST /trips/{id}/assign` checks the driver's classes against the vehicle, along with the other eligibility rules. It checks again when the trip starts, and when a held assignment is approved (FMS-151). None of these can be overridden.
- **Refusal:** a class that doesn't cover the vehicle is `409 CONFLICT_DRIVER_NOT_ELIGIBLE`, `{ field: "driver_id", reason: "license_category_not_valid_for_vehicle" }`. No class recorded is `license_category_missing`.
- **Dispatch board:** `GET /dispatch/availability` gives each driver `vehicle_types`: the types their classes may cover for a vehicle with nothing else recorded. The console warns about a pair outside them before *Assign*. The assignment then checks the vehicle itself, grades included.

## Recording classes

- **Field:** `license_categories` on `POST`/`PATCH /drivers` takes the API values above. They are stored without duplicates in the table's order. A European code, or anything else, is `400 VALIDATION_INVALID_ENUM`.
- **Driver form:** the drivers screen (S-05) groups the classes, with what each covers under its name.
- **CSV import:** `POST /drivers/import` takes the classes in one cell, separated by commas, semicolons or bars. It accepts the API value or the name in any case: `dry_cargo_2`, `Dry cargo 2` and `Special equipment` are all fine.

## Existing data

Migration 072 converts every driver's European categories to the nearest Ethiopian class. Its down converts them back.

| European | Ethiopian |
|---|---|
| AM, A1, A2, A | motorcycle |
| B, BE, B1 | automobile |
| C1, C1E | dry cargo 1 |
| C | dry cargo 2 |
| CE | dry cargo 3 |
| D1, D1E | public 1 |
| D, DE | public 2 |

Check the converted classes against the drivers' actual licences, since the two systems don't line up exactly.

## Seed

- **Drivers:** every seeded driver holds automobile. Most also hold dry cargo 2, a quarter of those dry cargo 3, and some public 2.
- **Vehicles:** every seeded vehicle has its model's body, seats and gross weight. For example, an Isuzu FSR is dry cargo at 11 t, a HOWO 371 dry cargo at 40 t, and a Coaster has 29 seats.
- **Pairings:** a driver only gets a vehicle their classes cover.

## Tests

- **`src/modules/fleet/domain/licence.test.ts`:** what each class covers by body, seats and weight, the type-only fallback, and the console's types.
- **`test/integration/driving-licences.test.ts`:**
  - dry cargo grades on a 25 t truck;
  - tankers need liquid cargo;
  - buses by their seats;
  - a truck with nothing recorded;
  - European codes refused;
  - the vehicle fields.
- **Also:** `drivers.test.ts` (the CSV import by name) and `scripts/seed/plan.test.ts` (every seeded pairing covered).
