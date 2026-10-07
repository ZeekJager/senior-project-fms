// Creates .env from .env.example, replacing every `change-me` value with a
// random secret. Leaves an existing .env untouched.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, '.env');

if (existsSync(target)) {
  console.log('.env already exists; leaving it unchanged.');
  process.exit(0);
}

const template = readFileSync(join(root, '.env.example'), 'utf8');
let generated = 0;
// `\r?` keeps CRLF checkouts (git autocrlf on Windows) working.
const output = template.replace(/^([A-Z0-9_]+)=change-me(\r?)$/gm, (_line, key, cr) => {
  generated += 1;
  return `${key}=${randomBytes(32).toString('base64url')}${cr}`;
});

writeFileSync(target, output, { mode: 0o600 });
console.log(`Created .env with ${generated} generated secret(s).`);
