import { createHash } from 'node:crypto';
import { AppError } from '../../../shared/errors/app-error';
import type { ModelFeedbackStats } from './prediction-feedback';

/** As in maintenance.ml_model_status (migration 039): seen, allowed to score, replaced. */
export const ML_MODEL_STATUSES = ['registered', 'active', 'retired'] as const;
export type MlModelStatus = (typeof ML_MODEL_STATUSES)[number];

/**
 * Why the scoring job may not score with the model the ML service serves: its inputs are not the ones the
 * core computes; its version was registered with another artefact (a version names one model); it is not
 * the active model.
 */
export const SCORING_BLOCKED_REASONS = ['feature_spec_mismatch', 'artefact_mismatch', 'not_active'] as const;
export type ScoringBlockedReason = (typeof SCORING_BLOCKED_REASONS)[number];

export const ML_MODEL_EVENTS = { scoringBlocked: 'MlScoringBlocked' } as const;

/** The models the registry holds, by name: the nightly maintenance scoring's (FMS-55), and the trip risk model (FMS-155). */
export const MAINTENANCE_MODEL = 'predictive-maintenance';
export const TRIP_RISK_MODEL = 'trip-risk';

/**
 * Why the dispatch console may not ask the trip risk model (FMS-155): no ML service configured; the service serves none;
 * or as for scoring. The console then keeps the rules.
 */
export const TRIP_RISK_BLOCKED_REASONS = ['service_off', 'no_model', 'unavailable', ...SCORING_BLOCKED_REASONS] as const;
export type TripRiskBlockedReason = (typeof TRIP_RISK_BLOCKED_REASONS)[number];

/** The trip risk model the service serves, when the console may ask it. */
export type TripRiskCheck =
  | { ok: true; version: string; demonstration: boolean }
  | { ok: false; reason: TripRiskBlockedReason; version: string | null };

/**
 * Whether a trip risk model beat the rules on held-out drivers (metrics.decision.beats_rules, written by
 * train_trip_risk.py): only one that did may be activated. Anything else, or nothing, is no.
 */
export function beatsRules(metrics: Record<string, unknown>): boolean {
  const decision = metrics.decision as { beats_rules?: unknown } | undefined;
  return decision?.beats_rules === true;
}

/** A model trained on generated trips (train_trip_risk.py: training_data.source), shown as a demonstration everywhere. */
export function isDemonstration(trainingData: Record<string, unknown>): boolean {
  return trainingData.source === 'generated';
}

/** What the ML service says about the model it serves (GET /model, FMS-54), as the registry records it. */
export interface ServedModel {
  name: string;
  version: string;
  algorithm: string;
  features: string[];
  featureSpecVersion: number;
  featureSpecHash: string;
  metrics: Record<string, unknown>;
  trainingData: Record<string, unknown>;
  trainedAt: Date;
  artefactSha256: string;
}

/** A registered model, internal id included, for the scoring job. */
export interface RegisteredModel {
  id: string;
  publicId: string;
  name: string;
  version: string;
  status: MlModelStatus;
  featureSpecHash: string;
}

/** A registered model as the API returns it. Public ids only. */
export interface MlModelView {
  id: string;
  name: string;
  version: string;
  status: MlModelStatus;
  algorithm: string;
  features: string[];
  feature_spec_version: number;
  feature_spec_hash: string;
  /** Whether its inputs are the ones the core's extractor computes now: false means it can never score. */
  features_match: boolean;
  /** Trained on generated data (a trip risk demonstration, FMS-155): labelled so wherever it shows. */
  demonstration: boolean;
  metrics: Record<string, unknown>;
  training_data: Record<string, unknown>;
  trained_at: Date;
  artefact_sha256: string;
  first_seen_at: Date;
  activated_at: Date | null;
  activated_by: string | null;
  retired_at: Date | null;
  /** How its high-risk predictions fared when technicians inspected the vehicles (FMS-128). */
  feedback: ModelFeedbackStats;
}

/** The scoring job's answer: score with this model, or do not score, and why. */
export type ScoringCheck =
  | { ok: true; model: RegisteredModel; registered: boolean }
  | { ok: false; reason: ScoringBlockedReason; model: RegisteredModel; registered: boolean };

/** Code points, as Python compares strings (sort_keys). */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0)!);
  const y = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** JSON.stringify's string, with everything outside printable ASCII escaped as Python's ensure_ascii does. */
const asciiString = (s: string) => JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * The text Python's `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)` writes
 * (ml/spec.py), so both sides hash the same bytes. Numbers must be integers or plain decimals: Python
 * writes 1e-05 and 1e+16 where JavaScript does not, so those are refused rather than hashed differently.
 * (A whole float written `5.0` reads back as 5 here and stays 5.0 in Python: the spec writes `5`.)
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    const text = String(value);
    const tiny = !Number.isInteger(value) && Math.abs(value) < 1e-4;
    if (!Number.isFinite(value) || /e/i.test(text) || tiny || (Number.isInteger(value) && Math.abs(value) >= 1e16)) {
      throw new Error(`canonicalJson: ${text} has no shared canonical form`);
    }
    return text;
  }
  if (typeof value === 'string') return asciiString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => byCodePoint(a, b));
    return `{${entries.map(([k, v]) => `${asciiString(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: cannot encode a ${typeof value}`);
}

/**
 * SHA-256 of the inputs and label of a feature spec (feature_spec.json): names, order, types, ranges,
 * windows and formulas. The same as the ML service's `spec_hash()` (ml/spec.py): a model whose hash is
 * not the extractor's was trained on other inputs than the core computes.
 */
export function featureSpecHash(spec: { features: unknown; target: unknown }): string {
  return createHash('sha256').update(canonicalJson({ features: spec.features, target: spec.target }), 'utf8').digest('hex');
}

export const mlModelNotFound = () => new AppError(404, 'NOT_FOUND', 'Model not found.');

export const mlModelNotBetterThanRules = (why: unknown) =>
  new AppError(
    409,
    'CONFLICT_INVALID_STATE_TRANSITION',
    `This trip risk model did not beat the rules on drivers it had not seen, so the console keeps the rules${Array.isArray(why) && why.length > 0 ? `: ${why.join('; ')}` : ''}.`,
    [{ field: 'metrics', reason: 'does_not_beat_rules' }],
  );

export const mlModelFeaturesMismatch = () =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', "This model's inputs are not the ones the core computes: it cannot score.", [
    { field: 'feature_spec_hash', reason: 'feature_spec_mismatch' },
  ]);
