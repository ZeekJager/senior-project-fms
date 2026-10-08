const noFloatInMoneyPath = require('./rules/no-float-in-money-path');
const noCrossModuleImport = require('./rules/no-cross-module-import');
const noCrossSchemaSql = require('./rules/no-cross-schema-sql');

module.exports = {
  rules: {
    'no-float-in-money-path': noFloatInMoneyPath,
    'no-cross-module-import': noCrossModuleImport,
    'no-cross-schema-sql': noCrossSchemaSql
  }
};
