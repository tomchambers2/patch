// Flat ESLint config for the Patch monorepo.
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/release/**',
      '**/.turbo/**',
      '**/.vite/**',
      'design/**',
      'apps/mobile/.expo/**',
      'apps/mobile/android/**',
      'apps/mobile/dist/**',
      'firmware/**',
      'packages/voice-firmware/**',
      'packages/web/public/**',
      '**/*.config.js',
      '**/*.config.mjs',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // `ignoreRestSiblings` is for the omit-a-key idiom —
      // `const { outcome: _o, ...rest } = x` — where the named key exists only so
      // the rest object does not carry it. Without it the lint gate rejects code
      // that has no unused value in it at all.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
