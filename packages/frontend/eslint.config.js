// ESLint flat config for the frontend (FMS-08).
//
// This package pins ESLint 9: eslint-plugin-react does not support ESLint 10
// yet. The repo root (backend) stays on ESLint 10 and ignores this package.
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import tseslint from 'typescript-eslint';
// FMS-04 money/fuel rule. Imported by path because it is a local workspace
// package, not published to npm.
import fms from '../eslint-plugin-fms/index.js';

export default defineConfig(
  { ignores: ['dist'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat['jsx-runtime'],
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    settings: {
      react: { version: 'detect' },
    },
    plugins: { fms },
    rules: {
      'fms/no-float-in-money-path': 'error',
    },
  },
  {
    files: ['*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
);
