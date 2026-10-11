// Creates .env from .env.example, replacing every `change-me` value with a
// random secret. An existing .env keeps every value it has; keys added to
// .env.example since it was made (e.g. REDIS_PASSWORD, FMS-72) are appended
// with generated values. Secrets are never printed.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, '.env');

const template = readFileSync(join(root, '.env.example'), 'utf8');
const randomValue = () => randomBytes(32).toString('base64url');

if (existsSync(target)) {
  const current = readFileSync(target, 'utf8');
  const present = new Set([...current.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]));
  // `\r?` keeps CRLF checkouts (git autocrlf on Windows) working.
  const missing = [...template.matchAll(/^([A-Z0-9_]+)=(.*?)\r?$/gm)].filter((m) => !present.has(m[1]));
  if (missing.length === 0) {
    console.log('.env already exists and has every key; leaving it unchanged.');
    process.exit(0);
  }
  const added = missing.map((m) => `${m[1]}=${m[2] === 'change-me' ? randomValue() : m[2]}`);
  const block = ['', '# Added by init-env (new in .env.example)', ...added, ''].join('\n');
  writeFileSync(target, `${current.replace(/\s*$/, '')}\n${block}`, { mode: 0o600 });
  console.log(`.env already exists; added ${missing.length} new key(s): ${missing.map((m) => m[1]).join(', ')}.`);
  process.exit(0);
}

let generated = 0;
// `\r?` keeps CRLF checkouts (git autocrlf on Windows) working.
const output = template.replace(/^([A-Z0-9_]+)=change-me(\r?)$/gm, (_line, key, cr) => {
  generated += 1;
  return `${key}=${randomValue()}${cr}`;
});

writeFileSync(target, output, { mode: 0o600 });
console.log(`Created .env with ${generated} generated secret(s).`);
