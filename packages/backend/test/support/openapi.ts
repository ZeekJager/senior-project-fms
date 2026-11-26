import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

// docs/openapi.yaml as the tests read it (FMS-65): the spec itself, the operations it lists, the comparison
// with the routes the API mounts, and a validator that checks a real response against its schema.

export const SPEC_PATH = join(__dirname, '..', '..', '..', '..', 'docs', 'openapi.yaml');
export const raw = readFileSync(SPEC_PATH, 'utf8');

export const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type Method = (typeof METHODS)[number];

/** The parts of an OpenAPI 3.1 document these tests read. */
export interface OpenApiDoc {
  openapi: string;
  servers: { url: string }[];
  tags: { name: string }[];
  security?: unknown[];
  paths: Record<string, PathItem>;
  components: {
    schemas: Record<string, unknown>;
    parameters: Record<string, { name: string; in: string }>;
    responses: Record<string, ResponseObject>;
    securitySchemes: Record<string, unknown>;
  };
}
export interface PathItem {
  servers?: { url: string }[];
  parameters?: ParameterRef[];
  [method: string]: unknown;
}
type ParameterRef = { $ref?: string; name?: string; in?: string };
export interface ResponseObject {
  $ref?: string;
  description?: string;
  content?: Record<string, { schema?: unknown }>;
}
export interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  security?: unknown[];
  parameters?: ParameterRef[];
  requestBody?: unknown;
  responses?: Record<string, ResponseObject>;
}

export const spec = parse(raw) as OpenApiDoc;

export interface Operation {
  path: string;
  method: Method;
  /** The server the path is under: /api/v1 unless the path says otherwise (the health probes are at the root). */
  base: string;
  item: PathItem;
  op: OperationObject;
}

export const operations: Operation[] = Object.entries(spec.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((method) => ({
    path,
    method,
    base: (item.servers?.[0]?.url ?? spec.servers[0].url).replace(/\/$/, ''),
    item,
    op: item[method] as OperationObject,
  })),
);

/** `GET /trips/{}`: a method and a path with every parameter (`:tripId` or `{trip_id}`) as `{}`; the /api/v1 prefix dropped. */
export const shape = (method: string, path: string) => `${method.toUpperCase()} ${path.replace(/^\/api\/v1(?=\/)/, '').replace(/(:[A-Za-z]\w*|\{[^}]*\})/g, '{}')}`;

/** What differs between the routes the API mounts and the operations the spec lists, each way. Both empty: they agree. */
export function drift(mounted: readonly string[], documented: readonly string[]) {
  const listed = new Set(documented);
  const served = new Set(mounted);
  return {
    undocumented: [...served].filter((route) => !listed.has(route)).sort(),
    unmounted: [...listed].filter((route) => !served.has(route)).sort(),
  };
}

export const documentedShapes = operations.map((o) => shape(o.method, o.path));

// ---------------------------------------------------------------------------------------------------------------------
// Response contract

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addFormat('binary', true);

const compiled = new Map<string, ReturnType<typeof ajv.compile>>();

/** A response object, with a $ref to components.responses resolved. */
function resolve(response: ResponseObject): ResponseObject {
  return response.$ref ? spec.components.responses[response.$ref.split('/').pop()!] : response;
}

/**
 * Checks a real JSON response body against what the spec says that operation returns with that status. Fails
 * with the validator's own words when the body does not match, and when the spec does not list the status at all.
 * `path` is the spec's path (`/trips/{trip_id}`), not the URL called.
 */
export function responseProblems(path: string, method: Method, status: number, body: unknown): string | null {
  const op = (spec.paths[path]?.[method] ?? null) as OperationObject | null;
  if (!op) return `${method.toUpperCase()} ${path} is not in the spec`;
  const listed = op.responses?.[String(status)];
  if (!listed) return `${method.toUpperCase()} ${path} lists no ${status} response (it lists ${Object.keys(op.responses ?? {}).join(', ')})`;
  const schema = resolve(listed).content?.['application/json']?.schema;
  if (!schema) return null; // a 204, or a body that is not JSON: nothing to validate
  const key = `${method} ${path} ${status}`;
  let validate = compiled.get(key);
  if (!validate) {
    // The schema carries the document's components so its $refs (#/components/schemas/...) resolve.
    validate = ajv.compile({ ...(schema as object), components: spec.components });
    compiled.set(key, validate);
  }
  return validate(body) ? null : JSON.stringify(validate.errors?.slice(0, 5));
}

/** Compiles every schema of components.schemas: a schema that is not valid JSON Schema fails here. */
export function schemaProblems(): { name: string; problem: string }[] {
  const problems: { name: string; problem: string }[] = [];
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    try {
      ajv.compile({ ...(schema as object), components: spec.components });
    } catch (err) {
      problems.push({ name, problem: (err as Error).message });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// Closed schemas (FMS-100): a response may carry only the fields the spec names.

type Json = Record<string, unknown>;

/** Schemas used as a member of an allOf or oneOf: their properties are counted by the composing schema, which is closed. */
function compositionMembers(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => compositionMembers(n, found));
  else if (node && typeof node === 'object') {
    const o = node as Json;
    for (const key of ['allOf', 'oneOf', 'anyOf']) {
      for (const member of (o[key] as Json[] | undefined) ?? []) {
        if (typeof member.$ref === 'string') found.add(member.$ref.split('/').pop()!);
      }
    }
    Object.values(o).forEach((v) => compositionMembers(v, found));
  }
  return found;
}

/** An object the spec describes field by field. `type: object` alone is a free-form map, open on purpose. */
const isObjectSchema = (o: Json) => 'properties' in o || 'allOf' in o || 'oneOf' in o || 'anyOf' in o;

/**
 * The schema with every object closed: `unevaluatedProperties: false` (JSON Schema 2020-12), which, unlike
 * additionalProperties, counts the properties an allOf or oneOf member names. A member of a composition is left open
 * (its composing schema closes it); so is a schema that already says what else it allows.
 */
export function closeSchema(node: unknown, composed = false): unknown {
  if (Array.isArray(node)) return node.map((n) => closeSchema(n, composed));
  if (!node || typeof node !== 'object') return node;
  const o = { ...(node as Json) };
  for (const key of ['properties', 'patternProperties', '$defs']) {
    if (o[key] && typeof o[key] === 'object') o[key] = Object.fromEntries(Object.entries(o[key] as Json).map(([k, v]) => [k, closeSchema(v)]));
  }
  for (const key of ['items', 'not']) if (o[key] && typeof o[key] === 'object') o[key] = closeSchema(o[key]);
  if (o.additionalProperties && typeof o.additionalProperties === 'object') o.additionalProperties = closeSchema(o.additionalProperties);
  for (const key of ['allOf', 'oneOf', 'anyOf']) if (Array.isArray(o[key])) o[key] = (o[key] as unknown[]).map((m) => closeSchema(m, true));
  if (!composed && typeof o.$ref !== 'string' && isObjectSchema(o) && !('additionalProperties' in o) && !('unevaluatedProperties' in o)) {
    o.unevaluatedProperties = false;
  }
  return o;
}

const members = compositionMembers(spec);
const closedComponents = {
  ...spec.components,
  schemas: Object.fromEntries(Object.entries(spec.components.schemas).map(([name, schema]) => [name, closeSchema(schema, members.has(name))])),
};
const strictAjv = new Ajv2020({ strict: false, allErrors: true });
addFormats(strictAjv);
strictAjv.addFormat('binary', true);
const strictCompiled = new Map<string, ReturnType<typeof strictAjv.compile>>();

/**
 * Answers any route may give whatever the operation lists (api-contract §3: no session, no permission, a body too large,
 * rate limited, a failure): when the operation does not list one, its body must still be the error envelope.
 */
export const CROSS_CUTTING_STATUSES = [401, 403, 413, 429, 500, 503];

/** As responseProblems, with every object closed: a field the spec does not name is a problem. */
export function strictResponseProblems(path: string, method: Method, status: number, body: unknown): string | null {
  const op = (spec.paths[path]?.[method] ?? null) as OperationObject | null;
  if (!op) return `${method.toUpperCase()} ${path} is not in the spec`;
  let listed = op.responses?.[String(status)];
  if (!listed && CROSS_CUTTING_STATUSES.includes(status)) listed = { content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } } } as ResponseObject;
  if (!listed) return `${method.toUpperCase()} ${path} lists no ${status} response`;
  const schema = resolve(listed).content?.['application/json']?.schema;
  // No JSON body (a file, an image, a 204): the status is all there is to check.
  if (!schema || body === undefined) return null;
  const key = `${method} ${path} ${status}`;
  let validate = strictCompiled.get(key);
  if (!validate) {
    validate = strictAjv.compile({ ...(closeSchema(schema) as object), components: closedComponents });
    strictCompiled.set(key, validate);
  }
  return validate(body) ? null : JSON.stringify(validate.errors?.slice(0, 5));
}

/** The spec operation a request path (`/api/v1/trips/<uuid>?x=1`) is, preferring literal segments over parameters. */
const matchers = operations
  .map((o) => {
    const segments = o.path.split('/').filter(Boolean);
    // Literal segments are letters, digits, '-', '_' and '.': only the dot needs escaping.
    const regex = new RegExp(`^/${segments.map((s) => (s.startsWith('{') ? '[^/]+' : s.replace(/\./g, '\\.'))).join('/')}$`);
    return { op: o, regex, literals: segments.filter((s) => !s.startsWith('{')).length };
  })
  .sort((a, b) => b.literals - a.literals);

export function operationFor(method: string, url: string): Operation | null {
  const full = new URL(url, 'http://local').pathname;
  return (
    matchers.find((m) => m.op.method === method.toLowerCase() && full.startsWith(`${m.op.base}/`) && m.regex.test(full.slice(m.op.base.length)))?.op ?? null
  );
}
