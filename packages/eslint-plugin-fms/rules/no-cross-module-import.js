const path = require('node:path');
const { moduleOfFile, sharedSrcOfFile, toPosix } = require('../lib/module-boundaries');

const INDEX_FILE = /^index(\.(ts|mts|cts|js|mjs|cjs))?$/;

/**
 * System Design §32, rule 1 (CONVENTIONS.md, Modules): code in
 * src/modules/<a>/ reaches module <b> only through <b>'s index.ts, and code
 * in src/shared/ never imports a module. Covers import/export ... from,
 * dynamic import(), require() and `import x = require()`, type-only imports
 * included: a type that other modules need is exported from index.ts.
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: "Import another backend module only through its index.ts; shared code imports no module.",
    },
    schema: [],
    messages: {
      deepImport:
        "Module '{{from}}' imports '{{spec}}' from inside module '{{to}}'. Import from '{{to}}' (its index.ts) instead, and export what you need there (CONVENTIONS.md, Modules rule 1).",
      sharedImportsModule:
        "src/shared imports '{{spec}}' from module '{{to}}'. Shared code never depends on a module; move the code into the module or pass it in.",
    },
  },

  create(context) {
    const filename = toPosix(context.filename ?? context.getFilename());
    const own = moduleOfFile(filename);
    const sharedSrc = own ? null : sharedSrcOfFile(filename);
    if (!own && !sharedSrc) return {};

    const modulesRoot = own ? own.modulesRoot : `${sharedSrc}/modules`;

    function check(node, spec) {
      if (typeof spec !== 'string' || !spec.startsWith('.')) return;
      const target = path.posix.resolve(path.posix.dirname(filename), spec);
      const rel = path.posix.relative(modulesRoot, target);
      if (rel === '' || rel.startsWith('..') || path.posix.isAbsolute(rel)) return;

      const [to, ...rest] = rel.split('/');
      if (own) {
        if (to === own.module) return;
        if (rest.length === 0 || (rest.length === 1 && INDEX_FILE.test(rest[0]))) return;
        context.report({ node, messageId: 'deepImport', data: { from: own.module, spec, to } });
      } else {
        context.report({ node, messageId: 'sharedImportsModule', data: { spec, to } });
      }
    }

    const fromSource = (node) => {
      if (node.source && node.source.type === 'Literal') check(node.source, node.source.value);
    };

    return {
      ImportDeclaration: fromSource,
      ExportNamedDeclaration: fromSource,
      ExportAllDeclaration: fromSource,
      ImportExpression: fromSource,
      CallExpression(node) {
        const [arg] = node.arguments;
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && arg && arg.type === 'Literal') {
          check(arg, arg.value);
        }
      },
      TSImportEqualsDeclaration(node) {
        const ref = node.moduleReference;
        if (ref && ref.type === 'TSExternalModuleReference' && ref.expression.type === 'Literal') {
          check(ref.expression, ref.expression.value);
        }
      },
      TSImportType(node) {
        const arg = node.argument;
        const literal = arg && arg.type === 'TSLiteralType' ? arg.literal : arg;
        if (literal && literal.type === 'Literal') check(literal, literal.value);
      },
    };
  },
};
