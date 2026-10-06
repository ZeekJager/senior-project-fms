const fmsPlugin = require('eslint-plugin-fms');

module.exports = [
  // The frontend has its own ESLint 9 config (eslint-plugin-react does not
  // support ESLint 10); lint it with `npm run lint -w fms-frontend`.
  { ignores: ['packages/frontend/**'] },
  {
    plugins: {
      fms: fmsPlugin
    },
    rules: {
      'fms/no-float-in-money-path': 'error'
    }
  }
];
