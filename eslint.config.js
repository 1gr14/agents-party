import prettier from 'eslint-config-prettier'
import { defineConfig } from 'eslint/config'
import noOnlyTests from 'eslint-plugin-no-only-tests'
import tseslint from 'typescript-eslint'

export default defineConfig([
  // Global ignores to keep linting fast and avoid vendor/build dirs
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-npm/**',
      '**/.husky/**',
      '**/.git/**',
      'tsdown.config.ts',
      'eslint.config.js',
      '.commitlintrc.js',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/only-throw-error': [
        'error',
        {
          allow: [{ from: 'package', name: 'Error0', package: '@1gr14/error0' }],
        },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
      curly: ['error', 'all'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-unnecessary-condition': ['error'], // slow rule
      '@typescript-eslint/restrict-template-expressions': ['error'], // slow rule
      '@typescript-eslint/switch-exhaustiveness-check': ['error'],
      // overrides for enabled recommended rules
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/*.test.{js,jsx,ts,tsx}'],
    plugins: {
      'no-only-tests': noOnlyTests,
    },
    rules: {
      'no-only-tests/no-only-tests': 'error',
    },
  },
  prettier,
])
