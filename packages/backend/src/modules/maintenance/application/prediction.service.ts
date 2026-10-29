import { depotScope, type Scope } from '../../../shared/authz/scope';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { maintenanceVehicleMissing } from '../domain/maintenance';
import { PREDICTION_TYPE, type MaintenanceRiskView } from '../domain/scoring';
import type { FeatureSpec } from '../infrastructure/feature-spec';
import type { ScoringRepository } from '../infrastructure/scoring.repository';
import type { Caller } from './maintenance.service';
import type { PredictionFeedbackService } from './prediction-feedback.service';

export interface PredictionServiceDeps {
  predictions: ScoringRepository;
  vehicles: { findInScope(db: Queryable, by: { publicId: string }, scope: Scope): Promise<{ id: string; publicId: string } | null> };
  spec: () => FeatureSpec;
  /** The feedback on a prediction (FMS-128). */
  feedback: Pick<PredictionFeedbackService, 'forPrediction'>;
  /** A score older than this is stale (fleet's HEALTH_BANDS). */
  staleAfterHours: number;
  now?: () => Date;
}

/** The health score screen's reads (FMS-56, docs/ml-scoring.md): what the nightly scoring stored, never a new model call. */
export class PredictionService {
  constructor(private readonly deps: PredictionServiceDeps) {}

  /** GET /vehicles/{vehicle_id}/maintenance-risk: a vehicle in the caller's depots (404 otherwise). */
  async risk(caller: Caller, vehiclePublicId: string): Promise<MaintenanceRiskView> {
    const { predictions, vehicles } = this.deps;
    return predictions.inTransaction(async (client) => {
      const vehicle = await vehicles.findInScope(client, { publicId: vehiclePublicId }, depotScope(caller.user));
      if (!vehicle) throw maintenanceVehicleMissing();
      const p = await predictions.latest(client, vehicle.id, PREDICTION_TYPE);
      if (!p) {
        return {
          vehicle_id: vehicle.publicId,
          prediction_id: null,
          health_score: null,
          risk_level: null,
          failure_probability: null,
          prediction_horizon_days: null,
          factors: [],
          model_name: null,
          model_version: null,
          as_of: null,
          scored_at: null,
          stale: false,
          feedback: null,
        };
      }
      const units = new Map(this.deps.spec().inputs.map((i) => [i.name, i.unit]));
      const now = this.deps.now?.() ?? new Date();
      return {
        vehicle_id: vehicle.publicId,
        prediction_id: p.publicId,
        health_score: p.healthScore,
        risk_level: p.riskLevel,
        failure_probability: p.failureProbability,
        prediction_horizon_days: p.horizonDays,
        factors: p.factors.map((feature) => ({ feature, value: p.features?.[feature] ?? null, unit: units.get(feature) ?? null })),
        model_name: p.modelName,
        model_version: p.modelVersion,
        as_of: p.asOf,
        scored_at: p.scoredAt,
        stale: now.getTime() - p.scoredAt.getTime() > this.deps.staleAfterHours * 3_600_000,
        feedback: await this.deps.feedback.forPrediction(client, caller, p.id),
      };
    });
  }
}
