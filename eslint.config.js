// Hybrid setup: oxlint owns most rules incl. type-aware (see .oxlintrc.json).
// ESLint covers only what oxlint doesn't yet: import/order, sonarjs.
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import sonarjsPlugin from 'eslint-plugin-sonarjs';

export default [
  {
    ignores: [
      'node_modules/',
      'out/',
      'dist/',
      'build/',
      '*.config.js',
      '*.config.ts',
      'resources/',
      'remote-web/',
      'src/mcp-server/',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      import: importPlugin,
      sonarjs: sonarjsPlugin,
    },
    settings: {
      'import/resolver': {
        typescript: {
          project: ['./tsconfig.node.json', './tsconfig.web.json', './tsconfig.test.json'],
        },
      },
    },
    rules: {
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'sonarjs/cognitive-complexity': ['warn', 20],
    },
  },
  {
    // Cyclomatic complexity for logic-heavy main/shared code.
    // Renderer components are excluded because JSX branches inflate the metric.
    files: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      complexity: ['warn', 20],
    },
  },
];
