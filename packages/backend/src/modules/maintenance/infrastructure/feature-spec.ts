import { readFileSync } from 'node:fs';
import path from 'node:path';
import { featureSpecHash } from '../domain/ml-model';
import type { FeatureInput } from '../domain/scoring';

/** What the core reads of feature_spec.json (packages/ai-service, FMS-52): the inputs it computes, and their hash. */
export interface FeatureSpec {
  version: number;
  features: string[];
  /** Each input's type, range and rounding, in order: the extractor caps and rounds to them (FMS-55). */
  inputs: FeatureInput[];
  hash: string;
}

/**
 * The feature spec shared with the ML service: one file, packages/ai-service/feature_spec.json, read here
 * through ML_FEATURE_SPEC_PATH (docker-compose.yml mounts it next to the backend). Read once.
 */
export function featureSpecLoader(file: string): () => FeatureSpec {
  let spec: FeatureSpec | null = null;
  return () => {
    if (spec) return spec;
    const raw = JSON.parse(readFileSync(path.resolve(file), 'utf8')) as { spec_version: number; features: FeatureInput[]; target: unknown };
    spec = {
      version: raw.spec_version,
      features: raw.features.map((f) => f.name),
      inputs: raw.features.map(({ name, type, min, max, decimals }) => ({ name, type, min, max, decimals })),
      hash: featureSpecHash(raw),
    };
    return spec;
  };
}
