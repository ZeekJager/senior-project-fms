import { z } from 'zod';
import type { ServedModel } from '../domain/ml-model';

/** The ML service is on the stack's own network (FMS-54); a model description is small. */
const TIMEOUT_MS = 10_000;

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

/** The ML service could not be asked, or answered something the registry cannot use. */
export class MlServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MlServiceError';
  }
}

export interface MlServiceClient {
  /** The model the service serves now. Throws MlServiceError when it cannot say. */
  servedModel(correlationId: string): Promise<ServedModel>;
}

/** The ML service over HTTP, with its internal token (X-Internal-Token). */
export class HttpMlServiceClient implements MlServiceClient {
  constructor(
    private readonly service: { url: string; token: string },
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async servedModel(correlationId: string): Promise<ServedModel> {
    let res: Response;
    let text: string;
    try {
      // The signal covers reading the body too.
      res = await this.fetchImpl(`${this.service.url}/model`, {
        headers: {
          accept: 'application/json',
          'x-internal-token': this.service.token,
          'x-request-id': correlationId,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
      text = await res.text();
    } catch (err) {
      const name = (err as { name?: string }).name;
      throw new MlServiceError(name === 'TimeoutError' || name === 'AbortError' ? `GET /model timed out after ${TIMEOUT_MS} ms` : 'GET /model could not reach the ML service');
    }
    if (!res.ok) throw new MlServiceError(`GET /model answered ${res.status}`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new MlServiceError('GET /model answered with JSON that could not be read');
    }
    const parsed = modelSchema.safeParse((body as { data?: unknown } | null)?.data);
    if (!parsed.success) {
      throw new MlServiceError(`GET /model answered without ${parsed.error.issues.map((i) => i.path.join('.') || '(data)').join(', ')}`);
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
}
