import { z } from 'zod';

/** Placeholder used in `.env.example`; never valid outside development. */
export const PLACEHOLDER = 'change-me';

const port = z.coerce
  .number({ error: 'must be a port number (1-65535)' })
  .int('must be a port number (1-65535)')
  .min(1, 'must be a port number (1-65535)')
  .max(65535, 'must be a port number (1-65535)');
const required = z.string({ error: 'is required' }).trim().min(1, 'is required');

const dbConnection = {
  DB_HOST: required,
  DB_PORT: port.default(5432),
  DB_NAME: required,
};

const appSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: port.default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    ...dbConnection,
    DB_USER: required,
    DB_PASSWORD: required,
    JWT_SECRET: z.string({ error: 'is required' }).min(32, 'must be at least 32 characters'),
    // Document files (FMS-17): local disk in development, S3-compatible elsewhere.
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_DIR: z.string().trim().min(1).default('storage'),
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().trim().min(1).default('us-east-1'),
    S3_BUCKET: z.string().trim().min(1).optional(),
    S3_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
    // Redis (FMS-72): cache, login throttle, job locks. Optional outside
    // production: without it the API reads PostgreSQL directly.
    REDIS_HOST: z.string().trim().min(1).optional(),
    REDIS_PORT: port.default(6379),
    REDIS_PASSWORD: z.string().min(1).optional(),
    REDIS_KEY_PREFIX: z.string().trim().regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and hyphens').default('fms'),
    // Trip assignment (FMS-31): minutes a driver or vehicle needs after an
    // en-route trip before the next one; less raises an overrun warning.
    TRIP_OVERRUN_GRACE_MINUTES: z.coerce.number().int().min(0).max(1440).default(0),
    // Real-time (FMS-43): page origins other than the API's own that may open
    // a socket (the Vite dev server, a separate web host). Comma-separated.
    REALTIME_ALLOWED_ORIGINS: z
      .string()
      .default('')
      .transform((v) => v.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean))
      .pipe(z.array(z.url({ protocol: /^https?$/, error: 'must be http(s) origins, comma-separated' }))),
    // The legacy client->server `location_update` socket event (api-contract §11.2). Off unless a legacy client needs it.
    REALTIME_LEGACY_LOCATION: z.enum(['true', 'false']).default('false'),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'is required when STORAGE_DRIVER=s3' });
      }
    }
    if (env.REDIS_HOST && !env.REDIS_PASSWORD) {
      ctx.addIssue({ code: 'custom', path: ['REDIS_PASSWORD'], message: 'is required when REDIS_HOST is set' });
    }
    if (env.NODE_ENV !== 'production') return;
    if (!env.REDIS_HOST) ctx.addIssue({ code: 'custom', path: ['REDIS_HOST'], message: 'is required in production' });
    for (const key of ['DB_PASSWORD', 'JWT_SECRET'] as const) {
      if (env[key].includes(PLACEHOLDER)) {
        ctx.addIssue({ code: 'custom', path: [key], message: `still contains the '${PLACEHOLDER}' placeholder` });
      }
    }
  });

const migrationSchema = z.object({
  ...dbConnection,
  DB_ADMIN_USER: required,
  DB_ADMIN_PASSWORD: required,
});

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  db: DbConfig;
  jwtSecret: string;
  storage: StorageConfig;
  /** Null when REDIS_HOST is not set (development and tests may run without Redis). */
  redis: RedisConfig | null;
  trips: { overrunGraceMinutes: number };
  realtime: RealtimeConfig;
  integrations: IntegrationsConfig;
}

/** Provider secrets (FMS-85), by provider code. Never stored in the database, never returned by the API. */
export interface IntegrationsConfig {
  secrets: Record<string, ProviderSecrets>;
}

export interface ProviderSecrets {
  /** HMAC key the provider signs its webhooks with. */
  webhookSecret?: string;
  /** Credential the adapter sends on outbound calls. */
  apiKey?: string;
}

export interface RealtimeConfig {
  /** Origins besides the API's own host allowed to open a socket. */
  allowedOrigins: string[];
  /** Accept the legacy `location_update` event (api-contract §11.2). */
  legacyLocation: boolean;
}

export interface RedisConfig {
  host: string;
  port: number;
  password: string;
  /** First segment of every key: `fms:fleet:vehicle:<id>` (CONVENTIONS.md, Redis). */
  keyPrefix: string;
}

export type StorageConfig =
  | { driver: 'local'; localDir: string }
  | {
      driver: 's3';
      /** Omit for AWS; set for MinIO or another S3-compatible service. */
      endpoint?: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    };

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}\nSee .env.example for every setting.`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

/**
 * `INTEGRATION_<CODE>_WEBHOOK_SECRET` and `INTEGRATION_<CODE>_API_KEY`: a provider's secrets, where
 * <CODE> is its `external_providers.code` in upper case with `_` for `-` (`mock-telematics` is
 * `INTEGRATION_MOCK_TELEMATICS_WEBHOOK_SECRET`). Any number of providers, so read by pattern.
 */
const PROVIDER_SECRET = /^INTEGRATION_([A-Z0-9]+(?:_[A-Z0-9]+)*)_(WEBHOOK_SECRET|API_KEY)$/;
/** A webhook HMAC key shorter than this is guessable. */
export const MIN_WEBHOOK_SECRET_LENGTH = 32;

/** The env-var stem of a provider code: `mock-telematics` is `MOCK_TELEMATICS`. */
export const providerEnvName = (code: string) => code.toUpperCase().replace(/-/g, '_');

function integrationSecrets(env: Env, production: boolean): { secrets: Record<string, ProviderSecrets>; problems: string[] } {
  const secrets: Record<string, ProviderSecrets> = {};
  const problems: string[] = [];
  for (const [key, raw] of Object.entries(env)) {
    const match = PROVIDER_SECRET.exec(key);
    const value = raw?.trim();
    if (!match || !value) continue;
    const code = match[1].toLowerCase().replace(/_/g, '-');
    const entry = (secrets[code] ??= {});
    if (match[2] === 'WEBHOOK_SECRET') {
      if (value.length < MIN_WEBHOOK_SECRET_LENGTH) problems.push(`${key}: must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`);
      entry.webhookSecret = value;
    } else {
      entry.apiKey = value;
    }
    if (production && value.includes(PLACEHOLDER)) problems.push(`${key}: still contains the '${PLACEHOLDER}' placeholder`);
  }
  return { secrets, problems };
}

function parse<S extends z.ZodType>(schema: S, env: Env): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`));
  }
  return result.data;
}

/** Settings for the API server. Pure: pass the environment explicitly. */
export function loadAppConfig(env: Env): AppConfig {
  const e = parse(appSchema, env);
  const integrations = integrationSecrets(env, e.NODE_ENV === 'production');
  if (integrations.problems.length > 0) throw new ConfigError(integrations.problems);
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    db: { host: e.DB_HOST, port: e.DB_PORT, database: e.DB_NAME, user: e.DB_USER, password: e.DB_PASSWORD },
    jwtSecret: e.JWT_SECRET,
    redis: e.REDIS_HOST ? { host: e.REDIS_HOST, port: e.REDIS_PORT, password: e.REDIS_PASSWORD!, keyPrefix: e.REDIS_KEY_PREFIX } : null,
    storage:
      e.STORAGE_DRIVER === 's3'
        ? {
            driver: 's3',
            endpoint: e.S3_ENDPOINT,
            region: e.S3_REGION,
            bucket: e.S3_BUCKET!,
            accessKeyId: e.S3_ACCESS_KEY_ID!,
            secretAccessKey: e.S3_SECRET_ACCESS_KEY!,
          }
        : { driver: 'local', localDir: e.STORAGE_LOCAL_DIR },
    trips: { overrunGraceMinutes: e.TRIP_OVERRUN_GRACE_MINUTES },
    realtime: { allowedOrigins: e.REALTIME_ALLOWED_ORIGINS, legacyLocation: e.REALTIME_LEGACY_LOCATION === 'true' },
    integrations: { secrets: integrations.secrets },
  };
}

/** Settings for `npm run migrate`, which connects as the schema owner. */
export function loadMigrationConfig(env: Env): DbConfig {
  const e = parse(migrationSchema, env);
  return { host: e.DB_HOST, port: e.DB_PORT, database: e.DB_NAME, user: e.DB_ADMIN_USER, password: e.DB_ADMIN_PASSWORD };
}
