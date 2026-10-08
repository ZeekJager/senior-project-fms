const fmsPlugin = require('eslint-plugin-fms');
const tseslint = require('typescript-eslint');

const backendTs = ['packages/backend/**/*.ts', 'packages/backend/**/*.mts'];

module.exports = [
  // The frontend has its own ESLint 9 config (eslint-plugin-react does not
  // support ESLint 10); lint it with `npm run lint -w fms-frontend`.
  { ignores: ['packages/frontend/**', '**/dist/**'] },

  // Backend TypeScript (ADR-06): parser + recommended rules, scoped so they
  // never apply to plain JS such as the ESLint plugin itself.
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: backendTs })),

  // Application code logs through pino (src/shared/logging); CLI scripts may print.
  {
    files: ['packages/backend/src/**/*.ts'],
    rules: { 'no-console': 'error' }
  },

  {
    plugins: {
      fms: fmsPlugin
    },
    rules: {
      'fms/no-float-in-money-path': 'error'
    }
  },

  // Module boundaries (FMS-12, System Design §32 rules 1 and 3): another
  // module only through its index.ts, and SQL only on the module's own
  // schemas. The schema ownership map is in eslint-plugin-fms/lib/module-boundaries.js.
  {
    files: ['packages/backend/src/**/*.ts'],
    rules: {
      'fms/no-cross-module-import': 'error',
      'fms/no-cross-schema-sql': 'error'
    }
  }
];
