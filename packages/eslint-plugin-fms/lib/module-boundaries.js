const path = require('node:path');

/**
 * Which backend module owns which PostgreSQL schema (CONVENTIONS.md, Schema
 * ownership; CFG-5 / SE-107 in Jira). A module's SQL may use only its own
 * schemas plus PLATFORM_SCHEMAS. A module that owns no schema (command-center)
 * reads everything through other modules' index.ts.
 *
 * tests/ownership-map.test.js fails when a migration creates a schema that is
 * not listed here, or when a folder under src/modules has no entry.
 */
const MODULE_SCHEMAS = {
  auth: ['auth'],
  fleet: ['fleet', 'document'],
  trip: ['trip'],
  fuel: ['fuel'],
  maintenance: ['maintenance'],
  alert: ['alert'],
  ev: ['ev'],
  integration: ['integration', 'tracking'],
  analytics: ['analytics'],
  audit: ['audit'],
  'command-center': [],
};

/** Usable from any module: enum types and trigger functions only, no tables. */
const PLATFORM_SCHEMAS = ['shared'];

/**
 * Owned by platform code in src/shared, not by a module: `api` holds the
 * Idempotency-Key table. Modules never query it directly.
 */
const PLATFORM_OWNED_SCHEMAS = ['api'];

const toPosix = (file) => file.split(path.sep).join('/');

/**
 * `{ modulesRoot, module }` for a file under `<...>/src/modules/<module>/`,
 * or null. `src/modules/index.ts` itself (the composition root) is in no module.
 */
function moduleOfFile(filename) {
  const match = /^(.*\/src\/modules)\/([^/]+)\/./.exec(toPosix(filename));
  return match ? { modulesRoot: match[1], module: match[2] } : null;
}

/** `<...>/src` for a file under `<...>/src/shared/`, or null. */
function sharedSrcOfFile(filename) {
  const match = /^(.*\/src)\/shared\//.exec(toPosix(filename));
  return match ? match[1] : null;
}

module.exports = { MODULE_SCHEMAS, PLATFORM_SCHEMAS, PLATFORM_OWNED_SCHEMAS, moduleOfFile, sharedSrcOfFile, toPosix };
