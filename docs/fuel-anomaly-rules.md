# Fuel anomaly rules on one fill-up (FMS-82)

A month's fuel against its trips is the reconciliation's job (FMS-41, `docs/fuel-reconciliation.md`). These rules
judge a single fill-up the moment it is logged, so an impossible or suspicious entry is flagged within seconds
instead of at the end of the month.

## How it runs

`POST /fuel-logs` publishes `FuelLogged` in its transaction. The `fuel.fill-up-rules` consumer reads it, loads the
vehicle (fuel type, rated `fuel_efficiency_ml_per_km`, `tank_capacity_ml`) and, when the fill-up carries a position,
the vehicle's nearest GPS ping within 15 minutes of `recorded_at`. For each rule broken it writes a
`fuel.fuel_anomalies` row (status `open`, audited as the system, the figures in `details`) and publishes
`FuelAnomalyDetected`, which the alert engine turns into an alert.

Delivery is at least once. There is one anomaly per fill-up and rule (unique index, migration 058, and a pre-check),
and the event id is derived from the fill-up and rule, so a redelivery adds nothing. A rule without what it needs
judges nothing: no tank size, no position, no previous odometer reading, no rating, an electric vehicle.

## The rules

| `anomaly_type` | Flagged when | Severity |
|---|---|---|
| `tank_capacity_exceeded` | `quantity_ml` is above the vehicle's `tank_capacity_ml` (exactly the tank is fine) | high |
| `refuel_interval_too_short` | the fill-up is more than `FUEL_REFUEL_EXCESS_PCT` (default 50) above what the distance since the vehicle's previous fill-up needed at its rating, **and** by at least 20 L | medium; high beyond twice the excess |
| `price_per_litre_out_of_range` | cost per litre (total over quantity, whole cents) is outside `FUEL_PRICE_MIN_CENTS_PER_LITRE`..`FUEL_PRICE_MAX_CENTS_PER_LITRE` (3000..20000, edges inside) | medium; high under half the minimum or over twice the maximum |
| `fill_up_away_from_vehicle` | the fill-up's `latitude`/`longitude` are more than `FUEL_LOCATION_MAX_KM` (default 2) from the vehicle's GPS position then | high |

All arithmetic is on integers (ml, cents, tenths of a km), percentages rounded half away from zero.
`deviation_pct` is the percent over what was expected (tank, fuel the distance needed, nearest edge of the price band).

## API

- `POST /fuel-logs` takes optional `latitude` and `longitude` (both or neither, in range, at most 6 decimals);
  `FuelLog` returns them.
- Vehicles take and return `tank_capacity_ml` (whole ml, 1..2,000,000, nullable) on create and update.
- `FuelAnomaly` carries `details`, the figures a rule judged on (null for a reconciliation anomaly).

## Configuration

`FUEL_REFUEL_EXCESS_PCT`, `FUEL_PRICE_MIN_CENTS_PER_LITRE`, `FUEL_PRICE_MAX_CENTS_PER_LITRE`, `FUEL_LOCATION_MAX_KM`
(see `.env.example`). The minimum price must be below the maximum.
