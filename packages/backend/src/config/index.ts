import { ConfigError, loadAppConfig, type AppConfig } from './schema';

function load(): AppConfig {
  try {
    return loadAppConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      // Fail fast with the list of problems instead of a stack trace. The
      // logger needs this config, so write to stderr directly.
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

/** Validated settings, loaded once. Read this instead of `process.env`. */
export const config: AppConfig = load();
