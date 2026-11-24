/**
 * The parameter types of the settings registry (FMS-157, docs/settings.md): what each type's value is, the rules a
 * definition may give it, and the one validator the API and the Settings screen both run.
 *
 * This file is copied, byte for byte, to packages/frontend/src/lib/parameterTypes.ts: the screen checks a value as
 * it is typed with the same code the API checks it with on save. A backend test fails when the two copies differ,
 * so change this one and copy it over. It imports nothing, for that reason.
 */

export const PARAMETER_TYPES = ['text', 'number', 'integer', 'boolean', 'dropdown', 'multi_select', 'duration', 'email', 'url', 'json'] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];

/** One choice of a dropdown or multi-select: the value stored, and what the screen shows. */
export interface ParameterOption {
  value: string;
  label: string;
}

/**
 * A JSON Schema, of the keywords listed in JSON_SCHEMA_KEYWORDS. A schema with any other keyword is refused when
 * the parameter is defined, so no part of a schema is ever silently ignored.
 */
export interface JsonSchema {
  [keyword: string]: unknown;
}

/** The rules of a definition. Which apply depends on the type (RULES_BY_TYPE); `unit` is for display only. */
export interface ParameterRules {
  /** number, integer and duration (in seconds): the smallest and largest value allowed. */
  min?: number;
  max?: number;
  /** number: at most this many decimal places. */
  decimals?: number;
  /** text: length in characters, and a regular expression the whole value must match. */
  min_length?: number;
  max_length?: number;
  pattern?: string;
  /** dropdown and multi_select: the choices. */
  options?: ParameterOption[];
  /** multi_select: how many may be chosen. */
  min_items?: number;
  max_items?: number;
  /** json: the schema the value must satisfy. */
  schema?: JsonSchema;
  /** What a number counts, for the screen: `percent`, `km/h`, `minutes`. */
  unit?: string;
}

/** Why a value was refused. The API's 400 carries it as `reason`. */
export type ValueProblem = 'wrong_type' | 'out_of_range' | 'not_an_option' | 'invalid_format';

export type ValueCheck = { ok: true } | { ok: false; reason: ValueProblem; message: string };

/** Why a definition's rules were refused. */
export interface RulesProblem {
  field: string;
  reason: 'invalid_rules' | 'unsupported_schema_keyword' | 'invalid_default';
  message: string;
}

/** The rules each type takes. Any other rule in a definition is refused. */
export const RULES_BY_TYPE: Record<ParameterType, readonly (keyof ParameterRules)[]> = {
  text: ['min_length', 'max_length', 'pattern'],
  number: ['min', 'max', 'decimals', 'unit'],
  integer: ['min', 'max', 'unit'],
  boolean: [],
  dropdown: ['options'],
  multi_select: ['options', 'min_items', 'max_items'],
  duration: ['min', 'max'],
  email: [],
  url: [],
  json: ['schema'],
};

/** The JSON Schema keywords the json type checks; the annotations among them (title, description...) check nothing. */
export const JSON_SCHEMA_KEYWORDS = [
  '$schema',
  'title',
  'description',
  'default',
  'examples',
  'type',
  'enum',
  'const',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'properties',
  'required',
  'additionalProperties',
] as const;

/** Text values are at most this long whatever the rules say, and a JSON value at most this many characters as JSON. */
export const MAX_TEXT_LENGTH = 10_000;
export const MAX_JSON_LENGTH = 16_384;
const MAX_EMAIL_LENGTH = 254;
const MAX_URL_LENGTH = 2_048;
const MAX_OPTIONS = 100;

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const ok: ValueCheck = { ok: true };
const refuse = (reason: ValueProblem, message: string): ValueCheck => ({ ok: false, reason, message });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function decimalsOf(n: number): number {
  const text = String(n);
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

function compiled(pattern: string): RegExp | null {
  try {
    return new RegExp(`^(?:${pattern})$`, 'u');
  } catch {
    return null;
  }
}

function range(value: number, rules: ParameterRules, what: string): ValueCheck {
  const { min, max } = rules;
  if (min !== undefined && max !== undefined && (value < min || value > max)) return refuse('out_of_range', `${what} from ${min} to ${max}.`);
  if (min !== undefined && value < min) return refuse('out_of_range', `${what} of at least ${min}.`);
  if (max !== undefined && value > max) return refuse('out_of_range', `${what} of at most ${max}.`);
  return ok;
}

/** Whether `value` is a valid value of a parameter of this type and these rules. `null` (the default) is checked by the caller. */
export function checkValue(type: ParameterType, rules: ParameterRules, value: unknown): ValueCheck {
  switch (type) {
    case 'text': {
      if (typeof value !== 'string') return refuse('wrong_type', 'Text is expected.');
      const length = [...value].length;
      if (length > MAX_TEXT_LENGTH) return refuse('out_of_range', `At most ${MAX_TEXT_LENGTH} characters.`);
      if (rules.min_length !== undefined && length < rules.min_length) return refuse('out_of_range', `At least ${rules.min_length} characters.`);
      if (rules.max_length !== undefined && length > rules.max_length) return refuse('out_of_range', `At most ${rules.max_length} characters.`);
      if (rules.pattern !== undefined && !compiled(rules.pattern)?.test(value)) return refuse('invalid_format', 'Not in the expected format.');
      return ok;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return refuse('wrong_type', 'A number is expected.');
      if (rules.decimals !== undefined && decimalsOf(value) > rules.decimals) {
        return refuse('invalid_format', rules.decimals === 0 ? 'A whole number is expected.' : `At most ${rules.decimals} decimal places.`);
      }
      return range(value, rules, 'A number');
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return refuse('wrong_type', 'A whole number is expected.');
      return range(value, rules, 'A whole number');
    }
    case 'duration': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return refuse('wrong_type', 'A duration in whole seconds is expected.');
      return range(value, rules, 'A duration in seconds');
    }
    case 'boolean':
      return typeof value === 'boolean' ? ok : refuse('wrong_type', 'True or false is expected.');
    case 'dropdown': {
      if (typeof value !== 'string') return refuse('wrong_type', 'One of the options is expected.');
      return (rules.options ?? []).some((o) => o.value === value) ? ok : refuse('not_an_option', 'Not one of the options.');
    }
    case 'multi_select': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return refuse('wrong_type', 'A list of options is expected.');
      const allowed = new Set((rules.options ?? []).map((o) => o.value));
      if (value.some((v) => !allowed.has(v as string))) return refuse('not_an_option', 'Not one of the options.');
      if (new Set(value).size !== value.length) return refuse('invalid_format', 'Each option at most once.');
      if (rules.min_items !== undefined && value.length < rules.min_items) return refuse('out_of_range', `Choose at least ${rules.min_items}.`);
      if (rules.max_items !== undefined && value.length > rules.max_items) return refuse('out_of_range', `Choose at most ${rules.max_items}.`);
      return ok;
    }
    case 'email': {
      if (typeof value !== 'string') return refuse('wrong_type', 'An email address is expected.');
      return value.length <= MAX_EMAIL_LENGTH && EMAIL.test(value) ? ok : refuse('invalid_format', 'Not an email address.');
    }
    case 'url': {
      if (typeof value !== 'string') return refuse('wrong_type', 'A web address is expected.');
      if (value.length > MAX_URL_LENGTH) return refuse('invalid_format', `At most ${MAX_URL_LENGTH} characters.`);
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return refuse('invalid_format', 'Not a web address: it starts with https:// or http://.');
      }
      return url.protocol === 'https:' || url.protocol === 'http:' ? ok : refuse('invalid_format', 'Only https:// and http:// addresses.');
    }
    case 'json': {
      if (value === undefined) return refuse('wrong_type', 'A JSON value is expected.');
      let text: string;
      try {
        text = JSON.stringify(value);
      } catch {
        return refuse('wrong_type', 'A JSON value is expected.');
      }
      if (text.length > MAX_JSON_LENGTH) return refuse('out_of_range', `At most ${MAX_JSON_LENGTH} characters as JSON.`);
      if (!rules.schema) return ok;
      const problem = schemaProblem(rules.schema, value, '');
      return problem ? refuse('invalid_format', problem) : ok;
    }
  }
}

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(want: unknown, v: unknown): boolean {
  const actual = jsonType(v);
  const wanted = Array.isArray(want) ? want : [want];
  return wanted.some((t) => t === actual || (t === 'number' && actual === 'integer'));
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && sameJson(a[k], b[k]));
  }
  return false;
}

/** The first way `value` fails `schema`, as a sentence naming where (`at /a/0`), or null when it passes. */
function schemaProblem(schema: JsonSchema, value: unknown, at: string): string | null {
  const where = at ? ` at ${at}` : '';
  const s = schema;
  if (s.type !== undefined && !typeMatches(s.type, value)) return `Expected ${Array.isArray(s.type) ? s.type.join(' or ') : String(s.type)}${where}.`;
  if (Array.isArray(s.enum) && !s.enum.some((e) => sameJson(e, value))) return `Not one of the allowed values${where}.`;
  if ('const' in s && !sameJson(s.const, value)) return `Not the required value${where}.`;
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) return `At least ${s.minimum}${where}.`;
    if (typeof s.maximum === 'number' && value > s.maximum) return `At most ${s.maximum}${where}.`;
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) return `Above ${s.exclusiveMinimum}${where}.`;
    if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) return `Below ${s.exclusiveMaximum}${where}.`;
    if (typeof s.multipleOf === 'number' && s.multipleOf > 0 && Math.abs(value / s.multipleOf - Math.round(value / s.multipleOf)) > 1e-9) {
      return `A multiple of ${s.multipleOf}${where}.`;
    }
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof s.minLength === 'number' && length < s.minLength) return `At least ${s.minLength} characters${where}.`;
    if (typeof s.maxLength === 'number' && length > s.maxLength) return `At most ${s.maxLength} characters${where}.`;
    if (typeof s.pattern === 'string') {
      let re: RegExp;
      try {
        re = new RegExp(s.pattern, 'u');
      } catch {
        return `The schema's pattern is not a regular expression${where}.`;
      }
      if (!re.test(value)) return `Not in the expected format${where}.`;
    }
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) return `At least ${s.minItems} items${where}.`;
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) return `At most ${s.maxItems} items${where}.`;
    if (s.uniqueItems === true && value.some((v, i) => value.findIndex((w) => sameJson(v, w)) !== i)) return `Items must differ${where}.`;
    if (isObject(s.items)) {
      for (let i = 0; i < value.length; i++) {
        const problem = schemaProblem(s.items, value[i], `${at}/${i}`);
        if (problem) return problem;
      }
    }
  }
  if (isObject(value)) {
    if (Array.isArray(s.required)) {
      const missing = s.required.find((k) => typeof k === 'string' && !(k in value));
      if (missing !== undefined) return `${String(missing)} is required${where}.`;
    }
    const properties = isObject(s.properties) ? s.properties : {};
    for (const [key, v] of Object.entries(value)) {
      const own = properties[key];
      if (isObject(own)) {
        const problem = schemaProblem(own, v, `${at}/${key}`);
        if (problem) return problem;
      } else if (s.additionalProperties === false) {
        return `${key} is not allowed${where}.`;
      } else if (isObject(s.additionalProperties)) {
        const problem = schemaProblem(s.additionalProperties, v, `${at}/${key}`);
        if (problem) return problem;
      }
    }
  }
  return null;
}

/** The keywords of `schema` and its sub-schemas the json type does not check, as `path: keyword`. */
function unsupportedKeywords(schema: unknown, at: string): string[] {
  if (!isObject(schema)) return [`${at || '/'}: not a schema`];
  const known: readonly string[] = JSON_SCHEMA_KEYWORDS;
  const found = Object.keys(schema)
    .filter((k) => !known.includes(k))
    .map((k) => `${at || '/'}: ${k}`);
  if (schema.items !== undefined) found.push(...unsupportedKeywords(schema.items, `${at}/items`));
  if (isObject(schema.properties)) {
    for (const [k, sub] of Object.entries(schema.properties)) found.push(...unsupportedKeywords(sub, `${at}/properties/${k}`));
  }
  if (isObject(schema.additionalProperties)) found.push(...unsupportedKeywords(schema.additionalProperties, `${at}/additionalProperties`));
  return found;
}

const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * The problems with a definition's rules and default for its type: rules the type does not take, ranges the wrong
 * way round, options missing or repeated, a pattern that is not a regular expression, a schema with keywords the
 * json type does not check, and a default that fails the rules. Empty when the definition is sound.
 */
export function checkDefinition(type: ParameterType, rules: ParameterRules, defaultValue: unknown): RulesProblem[] {
  const problems: RulesProblem[] = [];
  const bad = (field: string, message: string, reason: RulesProblem['reason'] = 'invalid_rules') => problems.push({ field, reason, message });
  const allowed: readonly string[] = RULES_BY_TYPE[type];
  for (const key of Object.keys(rules)) {
    if (!allowed.includes(key)) bad(`rules.${key}`, `A ${type.replace('_', '-')} parameter takes no ${key}.`);
  }
  const numeric = (key: 'min' | 'max') => {
    const v = rules[key];
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || ((type === 'integer' || type === 'duration') && !Number.isSafeInteger(v))) {
      bad(`rules.${key}`, type === 'number' ? 'A number.' : 'A whole number.');
    } else if (type === 'duration' && v < 0) bad(`rules.${key}`, 'A duration is never negative.');
  };
  numeric('min');
  numeric('max');
  if (typeof rules.min === 'number' && typeof rules.max === 'number' && rules.min > rules.max) bad('rules.max', 'The largest value is below the smallest.');
  if (rules.decimals !== undefined && (!isWhole(rules.decimals) || rules.decimals > 10)) bad('rules.decimals', 'From 0 to 10 decimal places.');
  for (const key of ['min_length', 'max_length', 'min_items', 'max_items'] as const) {
    if (rules[key] !== undefined && !isWhole(rules[key])) bad(`rules.${key}`, 'A whole number, 0 or more.');
  }
  if (isWhole(rules.min_length) && isWhole(rules.max_length) && rules.min_length > rules.max_length) bad('rules.max_length', 'The longest is below the shortest.');
  if (rules.max_length !== undefined && isWhole(rules.max_length) && rules.max_length > MAX_TEXT_LENGTH) bad('rules.max_length', `At most ${MAX_TEXT_LENGTH}.`);
  if (rules.pattern !== undefined && (typeof rules.pattern !== 'string' || compiled(rules.pattern) === null)) bad('rules.pattern', 'Not a regular expression.');
  if (rules.unit !== undefined && (typeof rules.unit !== 'string' || rules.unit.length > 20)) bad('rules.unit', 'At most 20 characters.');

  if (type === 'dropdown' || type === 'multi_select') {
    const options = rules.options;
    if (!Array.isArray(options) || options.length < (type === 'dropdown' ? 2 : 1)) {
      bad('rules.options', type === 'dropdown' ? 'A dropdown needs at least 2 options.' : 'A multi-select needs at least 1 option.');
    } else if (options.length > MAX_OPTIONS) {
      bad('rules.options', `At most ${MAX_OPTIONS} options.`);
    } else {
      const values = new Set<string>();
      options.forEach((o, i) => {
        const option = o as unknown;
        if (!isObject(option) || typeof option.value !== 'string' || typeof option.label !== 'string' || !option.value.trim() || !option.label.trim()) {
          bad(`rules.options.${i}`, 'Each option has a value and a label.');
        } else if (option.value.length > 100 || option.label.length > 120) {
          bad(`rules.options.${i}`, 'A value of at most 100 characters and a label of at most 120.');
        } else if (values.has(option.value)) {
          bad(`rules.options.${i}`, `The value ${option.value} is used twice.`);
        } else values.add(option.value);
      });
      if (type === 'multi_select' && isWhole(rules.max_items) && rules.max_items > options.length) bad('rules.max_items', 'More than there are options.');
    }
    if (type === 'multi_select' && isWhole(rules.min_items) && isWhole(rules.max_items) && rules.min_items > rules.max_items) bad('rules.max_items', 'Fewer than the least.');
  }

  if (type === 'json' && rules.schema !== undefined) {
    const unsupported = unsupportedKeywords(rules.schema, '');
    if (unsupported.length) bad('rules.schema', `Keywords not checked: ${unsupported.join(', ')}.`, 'unsupported_schema_keyword');
  }

  if (problems.length === 0) {
    const check = defaultValue === null || defaultValue === undefined ? refuse('wrong_type', 'A default value is required.') : checkValue(type, rules, defaultValue);
    if (!check.ok) bad('default_value', check.message, 'invalid_default');
  }
  return problems;
}

/** A duration in seconds as the screen writes it: `1 h 30 min`, `45 s`, `0 s`. */
export function formatDuration(seconds: number): string {
  if (seconds === 0) return '0 s';
  const parts: string[] = [];
  const units: [number, string][] = [
    [86_400, 'd'],
    [3_600, 'h'],
    [60, 'min'],
    [1, 's'],
  ];
  let rest = seconds;
  for (const [size, name] of units) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)} ${name}`);
      rest %= size;
    }
  }
  return parts.join(' ');
}

/** A duration typed on the screen (`90`, `1h 30m`, `2 d`, `45s`) in seconds, or null when it is not one. A bare number is minutes. */
export function parseDuration(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  if (/^\d{1,7}$/.test(trimmed)) return Number(trimmed) * 60;
  const re = /(\d{1,7})\s*(d|h|min|m|s)(?![a-z])/g;
  let total = 0;
  let consumed = '';
  for (const match of trimmed.matchAll(re)) {
    const n = Number(match[1]);
    total += match[2] === 'd' ? n * 86_400 : match[2] === 'h' ? n * 3_600 : match[2] === 's' ? n : n * 60;
    consumed += match[0];
  }
  return consumed && consumed.replace(/\s/g, '') === trimmed.replace(/\s/g, '') ? total : null;
}
