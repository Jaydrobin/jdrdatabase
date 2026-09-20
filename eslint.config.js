// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Worker에서 실행되는 코드. DOM·메인 스레드 전용 API에 접근하면 린트가 막는다(CLAUDE.md 4장). */
const WORKER_SIDE = ['src/db/**/*.js', 'src/import/**/*.js', 'src/export/**/*.js'];
/** 메인 스레드 코드. */
const MAIN_SIDE = ['src/main.js', 'src/app/**/*.js', 'src/ui/**/*.js', 'src/io/**/*.js'];
/** 양쪽에서 쓰는 순수 함수. 어느 쪽 전역에도 기대지 않는다. */
const SHARED = ['src/util/**/*.js', 'src/i18n/**/*.js'];
/** Node.js에서 실행되는 도구·테스트. */
const NODE_SIDE = [
  'build/**/*.mjs',
  'scripts/**/*.mjs',
  'test/**/*.js',
  'playwright.config.js',
  'eslint.config.js',
];

const BUILD_CONSTANTS = { __JDR_TEST__: 'readonly', __JDR_VERSION__: 'readonly' };

export default defineConfig([
  {
    ignores: ['node_modules/**', 'dist/**', 'vendor/**', 'test-results/**', 'playwright-report/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // node:test의 test()/describe()는 Promise를 돌려주지만 러너가 관리한다.
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['test', 'describe', 'it'] },
          ],
        },
      ],
      '@typescript-eslint/await-thenable': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-implicit-globals': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='require']",
          message: 'CommonJS 금지. ES 모듈 import를 쓴다 (CLAUDE.md 5.1).',
        },
      ],
    },
  },
  {
    files: WORKER_SIDE,
    languageOptions: { globals: { ...globals.worker, ...BUILD_CONSTANTS } },
    rules: {
      'no-restricted-globals': [
        'error',
        ...['window', 'document', 'DOMParser', 'localStorage', 'sessionStorage', 'alert'].map(
          (name) => ({
            name,
            message: `Worker 코드에서 ${name}에 접근하지 않는다 (CLAUDE.md 4장).`,
          }),
        ),
      ],
    },
  },
  {
    files: MAIN_SIDE,
    languageOptions: { globals: { ...globals.browser, ...BUILD_CONSTANTS } },
  },
  {
    files: SHARED,
    languageOptions: { globals: { ...BUILD_CONSTANTS } },
  },
  {
    files: NODE_SIDE,
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['test/e2e/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
]);
