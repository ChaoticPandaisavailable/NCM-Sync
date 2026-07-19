const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' }
});
