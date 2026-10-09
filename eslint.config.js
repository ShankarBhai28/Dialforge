// ESLint flat config. `npm run lint` from the repo root checks everything below.
const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');
const prettier = require('eslint-config-prettier');

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'backend/web-dist/**',
      'Credentials-Dialforge/**',
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
  // React app (web/): TypeScript + the rules of hooks.
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ['web/**/*.{ts,tsx}'] })),
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      eqeqeq: ['error', 'smart'],
    },
  },
  prettier,
];
