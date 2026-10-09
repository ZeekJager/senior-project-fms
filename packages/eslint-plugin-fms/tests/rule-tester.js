const test = require('node:test');
const { RuleTester } = require('eslint');
const tseslint = require('typescript-eslint');

// RuleTester reports through describe/it; use node:test's.
RuleTester.describe = test.describe;
RuleTester.it = test.it;
RuleTester.itOnly = test.it.only;

/** A RuleTester that parses TypeScript, as the rules run on backend .ts files. */
function tsRuleTester() {
  return new RuleTester({ languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' } });
}

/** An absolute-looking path to a file in the backend, for `filename`. */
const backend = (rel) => `/repo/packages/backend/${rel}`;

module.exports = { tsRuleTester, backend };
