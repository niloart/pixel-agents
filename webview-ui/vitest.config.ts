import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

process.env['ALLURE_LABEL_epic'] ??= 'webview';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
// Allure only in CI: locally it writes hundreds of result files per run and nothing cleans them.
const allure = !!process.env.CI;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/*.test.ts'],
    testTimeout: 30_000,
    // Tests bind fixed ports (Vite dev server, vite preview) and share the
    // global `window.postMessage` listener in browser-transport. Serial run
    // avoids port collisions and listener crosstalk.
    fileParallelism: false,
    setupFiles: allure ? ['allure-vitest/setup'] : [],
    reporters: allure
      ? [
          'default',
          [
            'allure-vitest/reporter',
            {
              resultsDir: path.resolve(rootDir, '../allure-results/webview'),
            },
          ],
        ]
      : ['default'],
  },
});
