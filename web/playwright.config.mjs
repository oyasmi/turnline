import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test',
  testMatch: 'interface.spec.mjs',
  timeout: 25_000,
  workers: 1,
  snapshotPathTemplate: '{testDir}/screenshots/{arg}{ext}',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: .012 } },
  use: {
    baseURL: 'http://127.0.0.1:18687',
    headless: true,
    viewport: { width: 1280, height: 720 },
    reducedMotion: 'reduce',
  },
  webServer: {
    command: 'uv run --no-sync python server.py --demo --port 18687',
    url: 'http://127.0.0.1:18687/api/session',
    timeout: 20_000,
  },
});
