const fmsPlugin = require('eslint-plugin-fms');
const tseslint = require('typescript-eslint');

const backendTs = ['packages/backend/**/*.ts'];

module.exports = [
  // The frontend has its own ESLint 9 config (eslint-plugin-react does not
  // support ESLint 10); lint it with `npm run lint -w fms-frontend`.
  { ignores: ['packages/frontend/**', '**/dist/**'] },

  // Backend TypeScript (ADR-06): parser + recommended rules, scoped so they
  // never apply to plain JS such as the ESLint plugin itself.
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: backendTs })),

  {
    plugins: {
      fms: fmsPlugin
    },
    rules: {
      'fms/no-float-in-money-path': 'error'
    }
  }
];
