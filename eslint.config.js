import js from '@eslint/js'
import globals from 'globals'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'
import { strippedImportPatterns, strippedImportSelectors, strippedBoundaryExemptFiles } from './src/config/stripRegistry.js'

// LL-7 strip boundary message, shared by both halves of the rule (static
// imports and dynamic import() expressions).
const STRIP_BOUNDARY_MESSAGE = 'This module belongs to a STRIPPED premium plugin (see src/config/stripRegistry.js). Importing it from the free build puts the paid code back into dist/assets and breaks the LL-7 dist scan. The bundle registers its own route on activation; use the locked stub in src/config/premiumRouteStubs.js if you need the path to resolve.'

export default defineConfig([
  globalIgnores([
    'dist',
    'scripts',
    'services/orchestrator',
    'playwright.config.js',
    'tests',
    'src/test'
  ]),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { varsIgnorePattern: '^[A-Z_]|^_', argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-escape': 'warn',
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // fleet #382: server-side code was being linted with BROWSER globals, so
    // every `process`, `require`, `module`, `Buffer` and `__dirname` raised a
    // bogus no-undef. That was 7,731 false positives across services/ —
    // enough noise that nobody could run lint here, which is why a real
    // `'existing' is not defined` (a destructive route throwing AFTER its
    // transaction committed, skipping the audit record) shipped unnoticed
    // even though no-undef flagged it correctly.
    //
    // Giving these files Node globals makes `npm run lint` meaningful for
    // services/ and surfaces the genuine undefined-variable bugs that were
    // buried underneath.
    files: ['services/**/*.js', 'cli/**/*.js', 'scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // LICENSE-LAUNCH LL-7 increment 2: the strip boundary.
    //
    // Once a plugin's code has been rehomed into a signed bundle, ONE static
    // import from the free build drags the whole view tree back into
    // dist/assets and quietly un-does the strip. The dist scan catches that,
    // but only after a build; this rule catches it while someone is typing.
    //
    // Scoped to ALREADY-STRIPPED plugins only, driven by
    // src/config/stripRegistry.js. The ~38 plugins still awaiting their strip
    // increment are deliberately absent: their imports are correct code today,
    // so listing them would either break the build (error) or add dozens of
    // permanent warnings, and a lint rule nobody can get to zero is a lint
    // rule nobody reads. The pattern list GROWS as strips land — flipping one
    // status field to 'stripped' arms that plugin's patterns, in the same
    // commit that deletes its route edge.
    //
    // Exemptions are the stripped modules themselves (QuoxBoxView legitimately
    // imports its own hook; they ship together inside the bundle) and
    // plugins-src/, which exists precisely to import them.
    files: ['src/**/*.{js,jsx}'],
    ignores: strippedBoundaryExemptFiles(),
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: strippedImportPatterns(), message: STRIP_BOUNDARY_MESSAGE }],
      }],
      // The dynamic half. no-restricted-imports does not see import()
      // expressions, and lazy(() => import('./pages/views/X')) is exactly the
      // edge a strip deletes — so without this the rule would police every
      // shape except the one the mistake actually takes.
      'no-restricted-syntax': ['error',
        ...strippedImportSelectors().map((selector) => ({ selector, message: STRIP_BOUNDARY_MESSAGE })),
      ],
    },
  },
])
