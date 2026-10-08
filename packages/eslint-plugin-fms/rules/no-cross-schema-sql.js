const {
  MODULE_SCHEMAS,
  PLATFORM_OWNED_SCHEMAS,
  PLATFORM_SCHEMAS,
  moduleOfFile,
  toPosix,
} = require('../lib/module-boundaries');

// A string is treated as SQL when it contains one of these words.
const SQL_KEYWORD = /\b(select|insert|update|delete|from|join|into|with|merge|truncate|alter|create|drop|copy|returning)\b/i;

// `schema.table`, optionally double-quoted, not preceded by a word char or a
// dot (so `a.b.c` and `t.col` aliases are judged by their first part only).
const QUALIFIED = /(^|[^\w.$"])"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\.\s*"?[A-Za-z_][A-Za-z0-9_]*/g;

// Calls whose table-name argument is a plain 'schema.table' string, e.g.
// req.dbMutate('fleet.depots', 'INSERT', ...) or auditedMutation(c, ctx, 'fleet.depots', ...).
const TABLE_ARG_CALLEES = new Set(['dbMutate', 'mutate', 'auditedMutation']);
const TABLE_NAME = /^([a-z_][a-z0-9_]*)\.[a-z_][a-z0-9_]*$/;

/** Removes SQL comments and quoted string literals, so data such as 'fleet.depots' in a VALUES list is not read as a table. */
function stripSqlNoise(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return null;
}

/**
 * System Design §32, rule 3 (CONVENTIONS.md, Modules): SQL written inside
 * src/modules/<x>/ may reference only the schemas module x owns (plus the
 * platform `shared` schema of types and functions). Reading another module's
 * tables, even for one join, goes through that module's index.ts.
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: "SQL in a backend module may reference only the schemas that module owns.",
    },
    schema: [
      {
        type: 'object',
        properties: {
          moduleSchemas: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
          platformSchemas: { type: 'array', items: { type: 'string' } },
          platformOwnedSchemas: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      crossSchema:
        "SQL in module '{{module}}' references '{{schema}}.*', owned by {{owner}}. Ask that module through its index.ts or react to its events (CONVENTIONS.md, Modules rule 3).",
    },
  },

  create(context) {
    const own = moduleOfFile(toPosix(context.filename ?? context.getFilename()));
    if (!own) return {};

    const options = context.options[0] ?? {};
    const moduleSchemas = options.moduleSchemas ?? MODULE_SCHEMAS;
    const platform = new Set(options.platformSchemas ?? PLATFORM_SCHEMAS);
    const platformOwned = new Set(options.platformOwnedSchemas ?? PLATFORM_OWNED_SCHEMAS);

    const ownerOf = new Map();
    for (const [mod, schemas] of Object.entries(moduleSchemas)) for (const s of schemas) ownerOf.set(s, `module '${mod}'`);
    for (const s of platformOwned) ownerOf.set(s, 'platform code in src/shared');
    const allowed = new Set([...(moduleSchemas[own.module] ?? []), ...platform]);

    function reportSchema(node, schema) {
      context.report({ node, messageId: 'crossSchema', data: { module: own.module, schema, owner: ownerOf.get(schema) } });
    }

    function checkSql(node, text) {
      if (!SQL_KEYWORD.test(text)) return;
      const seen = new Set();
      for (const match of stripSqlNoise(text).matchAll(QUALIFIED)) {
        const schema = match[2].toLowerCase();
        if (ownerOf.has(schema) && !allowed.has(schema) && !seen.has(schema)) {
          seen.add(schema);
          reportSchema(node, schema);
        }
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') checkSql(node, node.value);
      },
      TemplateLiteral(node) {
        // Interpolations become a placeholder; a dynamic `${table}` cannot be checked.
        checkSql(node, node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(' $x '));
      },
      CallExpression(node) {
        if (!TABLE_ARG_CALLEES.has(calleeName(node.callee))) return;
        for (const arg of node.arguments) {
          if (arg.type !== 'Literal' || typeof arg.value !== 'string') continue;
          const match = TABLE_NAME.exec(arg.value);
          if (match && ownerOf.has(match[1]) && !allowed.has(match[1])) reportSchema(arg, match[1]);
        }
      },
    };
  },
};
