const fmsPlugin = require('eslint-plugin-fms');

module.exports = [
  {
    plugins: {
      fms: fmsPlugin
    },
    rules: {
      'fms/no-float-in-money-path': 'error'
    }
  }
];
