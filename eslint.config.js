// ESLint flat config. `npm run lint` from the repo root checks everything below.
const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'Credentials-Dialforge/**',
      // Legacy pages, being replaced by web/ - see docs/APP_REBUILD_PLAN.md.
      'backend/public/**',
      'phase0/**',
      'ari-hello-world/**',
    ],
  },
  js.configs.recommended,
  {
    // Node services: backend API, dialer engine, bot service.
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  prettier,
];
