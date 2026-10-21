import { defineConfig } from 'vitest/config';

process.env['ALLURE_LABEL_epic'] ??= 'server';

// Allure only in CI: locally it writes hundreds of result files per run and nothing cleans them.
const allure = !!process.env.CI;

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    include: ['__tests__/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts', ...(allure ? ['allure-vitest/setup'] : [])],
    reporters: allure
      ? [
          'default',
          [
            'allure-vitest/reporter',
            {
              resultsDir: '../allure-results/server',
            },
          ],
        ]
      : ['default'],
  },
});
