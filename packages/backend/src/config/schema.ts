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
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'is required when STORAGE_DRIVER=s3' });
      }
    }
    if (env.NODE_ENV !== 'production') return;
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
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    db: { host: e.DB_HOST, port: e.DB_PORT, database: e.DB_NAME, user: e.DB_USER, password: e.DB_PASSWORD },
    jwtSecret: e.JWT_SECRET,
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
  };
}

/** Settings for `npm run migrate`, which connects as the schema owner. */
export function loadMigrationConfig(env: Env): DbConfig {
  const e = parse(migrationSchema, env);
  return { host: e.DB_HOST, port: e.DB_PORT, database: e.DB_NAME, user: e.DB_ADMIN_USER, password: e.DB_ADMIN_PASSWORD };
}
