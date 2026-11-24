import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const seconds = Number(process.env.TURNLINE_TEST_BACKGROUND_SECONDS ?? 605);
assert.ok(Number.isInteger(seconds) && seconds > 0);
const profile = await mkdtemp(join(tmpdir(), 'turnline-background-'));
const server = spawn('uv', ['run', '--no-sync', 'python', 'server.py', '--port', '0', '--demo'], {
  cwd: new URL('..', import.meta.url),
  stdio: ['ignore', 'pipe', 'inherit'],
});
let chrome;
let browser;
try {
  const base = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('exit', code => reject(new Error('Turnline server exited with ' + code)));
    server.stdout.once('data', chunk => resolve(String(chunk).trim().split(' ').at(-1)));
  });
  await fetch(base + '/api/session', { signal: AbortSignal.timeout(30_000) }).catch(async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      await delay(200);
      if ((await fetch(base + '/api/session').catch(() => null))?.ok) return;
    }
    throw new Error('Turnline demo did not start');
  });

  // Run Chrome with its normal background policies outside Playwright's launch defaults.
  chrome = spawn(process.env.TURNLINE_CHROME ?? chromium.executablePath(), [
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', 'about:blank',
  ], { stdio: 'ignore' });
  chrome.on('error', error => console.error(error.message));
  let port;
  for (let attempt = 0; !port && attempt < 50 && chrome.exitCode === null && chrome.signalCode === null; attempt++) {
    const endpoint = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    port = endpoint.split('\n')[0];
    if (!port) await delay(200);
  }
  assert.ok(port, 'Chrome did not start. On Linux use a display or xvfb-run.');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { noDefaults: true });
  const [context] = browser.contexts();
  const [page] = context.pages();
  let openedSockets = 0;
  page.on('websocket', socket => { if (socket.url().endsWith('/speech/voice')) openedSockets++; });
  await page.goto(base);
  await page.getByRole('button', { name: '开始通话' }).click();
  await page.locator('#status').getByText('正在聆听', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.maxBackgroundTimerInterval = 0;
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (document.hidden) window.maxBackgroundTimerInterval = Math.max(window.maxBackgroundTimerInterval, now - last);
      last = now;
    }, 5000);
  });
  const foreground = await context.newPage();
  await foreground.goto('data:text/html,Foreground tab');
  await foreground.bringToFront();
  await page.waitForFunction(() => document.hidden, undefined, { timeout: 5000 });
  const socketsBefore = openedSockets;
  console.log('Call tab hidden for ' + seconds + ' seconds.');
  await delay(seconds * 1000);
  const hidden = await page.evaluate(() => ({
    visibility: document.visibilityState,
    maxTimerIntervalMs: Math.round(window.maxBackgroundTimerInterval),
  }));
  assert.equal(hidden.visibility, 'hidden');
  await page.bringToFront();
  await page.locator('#status').getByText('正在聆听', { exact: true }).waitFor();
  const reconnects = openedSockets - socketsBefore;
  console.log({ ...hidden, reconnects });
  assert.equal(reconnects, 0, 'Expected the original voice socket to stay open.');
} finally {
  await browser?.close();
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill();
    await once(chrome, 'exit');
  }
  if (server.pid && server.exitCode === null && server.signalCode === null) {
    server.kill();
    await once(server, 'exit');
  }
  await rm(profile, { force: true, recursive: true, maxRetries: 3 });
}
