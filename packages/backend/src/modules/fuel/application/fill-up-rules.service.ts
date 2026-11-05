import type { PoolClient } from 'pg';
import { aggregateKey, createEvent, deterministicEventId, type DomainEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { FUEL_EVENTS } from '../domain/fuel-log';
import { LOCATION_WINDOW_MS, judgeFillUp, type FillUpRules, type FillUpVehicle, type VehiclePosition } from '../domain/fuel-rules';
import type { FuelAnomalyRepository } from '../infrastructure/fuel-anomaly.repository';
import type { FuelLogRepository } from '../infrastructure/fuel-log.repository';

/** A vehicle as the rules need it: the facts they judge on, and its ids. */
export interface RuleVehicle extends FillUpVehicle {
  id: string;
  publicId: string;
}

export interface FillUpRulesDeps {
  anomalies: Pick<FuelAnomalyRepository, 'existsForFillUp' | 'insertForFillUp'>;
  logs: Pick<FuelLogRepository, 'idOfPublic'>;
  vehicles: { forFillUpRules(db: Queryable, publicId: string): Promise<RuleVehicle | null> };
  /** Where a vehicle (internal id) was around a time, from its GPS pings, or null (the integration module). */
  positions: { positionNear(db: Queryable, vehicleId: string, at: Date, windowMs: number): Promise<VehiclePosition | null> };
  rules: FillUpRules;
  events: EventBus;
}

const num = (p: Record<string, unknown>, key: string): number | null => (typeof p[key] === 'number' ? (p[key] as number) : null);
const str = (p: Record<string, unknown>, key: string): string | null => (typeof p[key] === 'string' ? (p[key] as string) : null);

/**
 * The per-fill-up anomaly rules (FMS-82, docs/fuel-anomaly-rules.md): the consumer of FuelLogged. A fill-up that
 * is impossible or suspicious on its own gets an anomaly (audited as the system) and a FuelAnomalyDetected,
 * the alert engine's input, in the transaction of the delivery. The relay delivers within a second, so a fill-up
 * above the tank is flagged well inside a minute. Delivery is at least once: a rule that already flagged this
 * fill-up adds nothing, and the event id is fixed per fill-up and rule.
 */
export class FillUpRulesService {
  constructor(private readonly deps: FillUpRulesDeps) {}

  async onFuelLogged(event: DomainEvent, tx: PoolClient): Promise<void> {
    const p = event.payload;
    const fuelLogPublicId = str(p, 'fuel_log_id');
    const vehiclePublicId = str(p, 'vehicle_id');
    const recordedAt = str(p, 'recorded_at');
    const quantityMl = num(p, 'quantity_ml');
    const totalCostCents = num(p, 'total_cost_cents');
    if (!fuelLogPublicId || !vehiclePublicId || !recordedAt || quantityMl === null || totalCostCents === null) return;

    const { anomalies, logs, vehicles, positions, rules } = this.deps;
    const fuelLogId = await logs.idOfPublic(tx, fuelLogPublicId);
    const vehicle = await vehicles.forFillUpRules(tx, vehiclePublicId);
    if (!fuelLogId || !vehicle) return;

    const latitude = num(p, 'latitude');
    const longitude = num(p, 'longitude');
    const position = latitude !== null && longitude !== null ? await positions.positionNear(tx, vehicle.id, new Date(recordedAt), LOCATION_WINDOW_MS) : null;
    const findings = judgeFillUp(
      { quantityMl, totalCostCents, odometerKm: num(p, 'odometer_km'), previousOdometerKm: num(p, 'previous_odometer_km'), latitude, longitude },
      vehicle,
      position,
      rules,
    );

    const detected: DomainEvent[] = [];
    for (const finding of findings) {
      if (await anomalies.existsForFillUp(tx, fuelLogId, finding.type)) continue;
      const row = await anomalies.insertForFillUp(
        { userId: null, correlationId: event.correlation_id },
        {
          fuel_log_id: fuelLogId,
          vehicle_id: vehicle.id,
          anomaly_type: finding.type,
          severity: finding.severity,
          expected_ml: finding.expectedMl,
          actual_ml: finding.actualMl,
          distance_km: finding.distanceKm,
          deviation_percentage: finding.deviationPct,
          details: JSON.stringify(finding.details),
        },
        tx,
      );
      detected.push(
        createEvent(
          FUEL_EVENTS.anomalyDetected,
          {
            anomaly_id: row.public_id as string,
            vehicle_id: vehiclePublicId,
            driver_id: str(p, 'driver_id'),
            trip_id: str(p, 'trip_id'),
            fuel_log_id: fuelLogPublicId,
            anomaly_type: finding.type,
            severity: finding.severity,
            recorded_at: recordedAt,
            deviation_pct: finding.deviationPct,
            distance_km: finding.distanceKm,
            expected_ml: finding.expectedMl,
            actual_ml: finding.actualMl,
            // The figures the rule judged on, flat: the alert's words read them (alert/domain/rules.ts).
            ...finding.details,
          },
          { actor: null, correlationId: event.correlation_id },
          // One fact per fill-up and rule, however many times the fill-up is delivered.
          { id: deterministicEventId(`fuel-fill-up:${fuelLogPublicId}:${finding.type}`), aggregate: aggregateKey('vehicle', vehiclePublicId) },
        ),
      );
    }
    if (detected.length > 0) await this.deps.events.publish(tx, detected);
  }
}
