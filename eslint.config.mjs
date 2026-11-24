// ESLint: поиск ошибок и подозрительного кода (`npm run lint`). Проверка идёт в CI; предупреждения считаются ошибками.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['data/**', 'node_modules/**', 'logo/**'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-unused-vars': ['error', { args: 'all', argsIgnorePattern: '^_' }],
      complexity: ['warn', { max: 60 }],
    },
  },
];
