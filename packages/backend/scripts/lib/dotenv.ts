import fs from 'node:fs';

/**
 * The KEY=value lines of a .env file (comments and blank lines skipped, values taken as written). A missing file is an
 * empty map. Used where a script or the tests take the repository's .env as defaults (`make env` creates it).
 */
export function readDotEnv(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    values[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return values;
}
