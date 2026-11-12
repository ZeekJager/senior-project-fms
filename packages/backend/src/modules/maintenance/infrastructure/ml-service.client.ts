import { z } from 'zod';
import type { ServedModel } from '../domain/ml-model';
import { RISK_LEVELS, type MlPrediction, type PredictRequest } from '../domain/scoring';

/** The ML service is on the stack's own network (FMS-54): a model description or a batch of 100 takes well under a second. */
export const ML_SERVICE_TIMEOUT_MS = 10_000;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** GET /model's `data` (FMS-54, docs/ml-service.md): what the registry needs of it. Extra fields are ignored. */
const modelSchema = z.object({
  name: z.string().trim().min(1).max(100),
  model_version: z.string().trim().min(1).max(100),
  algorithm: z.string().trim().min(1),
  features: z.array(z.string().min(1)).min(1),
  feature_spec_version: z.number().int().positive(),
  feature_spec_hash: sha256,
  artefact_sha256: sha256,
  trained_at: z.iso.datetime({ offset: true }),
  training_data: z.record(z.string(), z.unknown()),
  metrics: z.record(z.string(), z.unknown()),
});

/** One `Prediction` of POST /internal/ml/predict-maintenance/batch (api-contract §10.3). */
const predictionSchema = z.object({
  vehicle_id: z.string(),
  failure_probability: z.number().min(0).max(1),
  health_score: z.number().int().min(0).max(100),
  risk_level: z.enum(RISK_LEVELS),
  prediction_horizon_days: z.number().int().positive(),
  model_version: z.string().min(1),
  factors: z.array(z.string().min(1)).max(3),
});

/** One answer of POST /internal/ml/predict-trip-risk (FMS-155, docs/ml-trip-risk.md). */
const factorSchema = z.object({ feature: z.string().min(1), value: z.number() });
const tripRiskSchema = z.object({
  trip_id: z.string(),
  driver_id: z.string(),
  late_probability: z.number().min(0).max(1),
  safety_event_probability: z.number().min(0).max(1),
  factors: z.object({ late: z.array(factorSchema).max(2), safety_event: z.array(factorSchema).max(2) }),
  model_version: z.string().min(1),
  demonstration: z.boolean(),
});

/** One driver on one trip, as the trip risk model takes it: the inputs of trip_risk_spec.json, in its order. */
export interface TripRiskRequest {
  trip_id: string;
  driver_id: string;
  features: Record<string, number>;
}

/** The trip risk model's answer for one driver on one trip. */
export interface TripRiskPrediction {
  tripId: string;
  driverId: string;
  lateProbability: number;
  safetyEventProbability: number;
  /** The inputs that raise each chance most, at most two each, with the value sent. */
  factors: { late: { feature: string; value: number }[]; safety_event: { feature: string; value: number }[] };
  modelVersion: string;
  demonstration: boolean;
}

/** The ML service could not be asked, or answered something the core cannot use. */
export class MlServiceError extends Error {
  constructor(
    message: string,
    /** The service's HTTP status, when it answered with an error. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MlServiceError';
  }
}

export interface MlServiceClient {
  /** The model the service serves now. Throws MlServiceError when it cannot say. */
  servedModel(correlationId: string): Promise<ServedModel>;
  /** One prediction per request, in the same order. Throws MlServiceError when the batch cannot be scored. */
  predictBatch(items: readonly PredictRequest[], correlationId: string): Promise<MlPrediction[]>;
  /** The trip risk model the service serves (FMS-155), or null when it runs without one. Throws MlServiceError otherwise. */
  servedTripRiskModel(correlationId: string): Promise<ServedModel | null>;
  /** One prediction per driver, in the same order. Throws MlServiceError when they cannot be scored. */
  predictTripRisk(items: readonly TripRiskRequest[], correlationId: string): Promise<TripRiskPrediction[]>;
}

/** An HTTP call through the integration gateway (FMS-85): its errors carry a safe message. */
export interface GatewayClient {
  call<T = unknown>(request: { method: 'GET' | 'POST'; path: string; headers?: Record<string, string>; body?: unknown; idempotent?: boolean }): Promise<{ body: T }>;
}

/**
 * The ML service over HTTP, with its internal token (X-Internal-Token), through the integration gateway:
 * a timeout on each attempt, retries with jitter, and the service's circuit breaker (architecture §28.3).
 */
export class HttpMlServiceClient implements MlServiceClient {
  constructor(
    private readonly token: string,
    /** The gateway's client for the ML service, for one run (its correlation id). */
    private readonly gateway: (correlationId: string) => GatewayClient,
  ) {}

  async servedModel(correlationId: string): Promise<ServedModel> {
    return this.described(await this.call(correlationId, { method: 'GET', path: '/model' }), 'GET /model');
  }

  async servedTripRiskModel(correlationId: string): Promise<ServedModel | null> {
    try {
      return this.described(await this.call(correlationId, { method: 'GET', path: '/models/trip-risk' }), 'GET /models/trip-risk');
    } catch (err) {
      // The service runs without a trip risk model: it says so with 404.
      if (err instanceof MlServiceError && err.status === 404) return null;
      throw err;
    }
  }

  async predictTripRisk(items: readonly TripRiskRequest[], correlationId: string): Promise<TripRiskPrediction[]> {
    const path = '/internal/ml/predict-trip-risk';
    const body = await this.call(correlationId, { method: 'POST', path, body: { items }, idempotent: true });
    const parsed = z.array(tripRiskSchema).safeParse((body as { data?: unknown } | null)?.data);
    if (!parsed.success) throw new MlServiceError(`POST ${path} answered without ${parsed.error.issues.map((i) => i.path.join('.') || '(data)').join(', ')}`);
    if (parsed.data.length !== items.length || parsed.data.some((p, i) => p.driver_id !== items[i].driver_id)) {
      throw new MlServiceError(`POST ${path} answered for other drivers than it was asked`);
    }
    return parsed.data.map((p) => ({
      tripId: p.trip_id,
      driverId: p.driver_id,
      lateProbability: p.late_probability,
      safetyEventProbability: p.safety_event_probability,
      factors: p.factors,
      modelVersion: p.model_version,
      demonstration: p.demonstration,
    }));
  }

  private described(body: unknown, what: string): ServedModel {
    const parsed = modelSchema.safeParse((body as { data?: unknown } | null)?.data);
    if (!parsed.success) {
      throw new MlServiceError(`${what} answered without ${parsed.error.issues.map((i) => i.path.join('.') || '(data)').join(', ')}`);
    }
    const m = parsed.data;
    return {
      name: m.name,
      version: m.model_version,
      algorithm: m.algorithm,
      features: m.features,
      featureSpecVersion: m.feature_spec_version,
      featureSpecHash: m.feature_spec_hash,
      metrics: m.metrics,
      trainingData: m.training_data,
      trainedAt: new Date(m.trained_at),
      artefactSha256: m.artefact_sha256,
    };
  }

  async predictBatch(items: readonly PredictRequest[], correlationId: string): Promise<MlPrediction[]> {
    const path = '/internal/ml/predict-maintenance/batch';
    // A prediction changes nothing on the service, so a retried batch is safe.
    const body = await this.call(correlationId, { method: 'POST', path, body: { items }, idempotent: true });
    const parsed = z.array(predictionSchema).safeParse((body as { data?: unknown } | null)?.data);
    if (!parsed.success) throw new MlServiceError(`POST ${path} answered without ${parsed.error.issues.map((i) => i.path.join('.') || '(data)').join(', ')}`);
    const predictions = parsed.data;
    if (predictions.length !== items.length || predictions.some((p, i) => p.vehicle_id !== items[i].vehicle_id)) {
      throw new MlServiceError(`POST ${path} answered for other vehicles than it was asked`);
    }
    return predictions.map((p) => ({
      vehicleId: p.vehicle_id,
      failureProbability: p.failure_probability,
      healthScore: p.health_score,
      riskLevel: p.risk_level,
      horizonDays: p.prediction_horizon_days,
      modelVersion: p.model_version,
      factors: p.factors,
    }));
  }

  private async call(correlationId: string, request: Parameters<GatewayClient['call']>[0]): Promise<unknown> {
    try {
      const headers = {
        'x-internal-token': this.token,
      };
      const res = await this.gateway(correlationId).call({ ...request, headers });
      return res.body;
    } catch (err) {
      // The gateway's messages name the method, path, status or time, never a body or the token.
      const status = (err as { status?: unknown } | null)?.status;
      throw new MlServiceError(err instanceof Error ? err.message.replace(/\.$/, '') : `${request.method} ${request.path} failed`, typeof status === 'number' ? status : undefined);
    }
  }
}
