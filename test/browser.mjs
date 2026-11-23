import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';

const engine = process.env.TURNLINE_TEST_TTS_ENGINE ?? 'auto';
const server = spawn('uv', ['run', '--no-sync', 'python', 'server.py', '--port', '0', '--tts-engine', engine], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
let browser;
try {
  const base = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('exit', code => reject(new Error('Turnline server exited with ' + code)));
    server.stdout.once('data', chunk => resolve(String(chunk).trim().split(' ').at(-1)));
  });
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  const failures = [];
  const synthesisRequests = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && request.url() === base + '/speech/synthesize') {
      synthesisRequests.push(request.postDataJSON().text);
    }
  });
  await page.addInitScript(() => {
    let input;
    let fixtureContext;
    let fixture;
    navigator.mediaDevices.getUserMedia = async () => {
      fixtureContext = new AudioContext();
      input = fixtureContext.createMediaStreamDestination();
      await fixtureContext.resume();
      return input.stream;
    };
    window.prepareTestSpeech = async () => {
      const ready = await fetch('./speech/prepare', { method: 'POST' });
      if (!ready.ok) throw new Error(await ready.text());
      const { voices } = await ready.json();
      const response = await fetch('./speech/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '你好，今天天气怎么样？', speaker: voices[0].id }),
      });
      if (!response.ok) throw new Error(await response.text());
      fixture = {
        sampleRate: Number(response.headers.get('X-Sample-Rate')),
        samples: new Float32Array(await response.arrayBuffer()),
      };
    };
    window.speakTestUtterance = async () => {
      await fixtureContext.resume();
      const buffer = fixtureContext.createBuffer(1, fixture.samples.length, fixture.sampleRate);
      buffer.copyToChannel(fixture.samples, 0);
      const source = fixtureContext.createBufferSource();
      source.buffer = buffer;
      source.connect(input);
      source.start();
    };
  });
  const waitForText = async (selector, pattern, timeout = 20_000) => {
    await page.waitForFunction(
      ({ selector, source }) => new RegExp(source).test([...document.querySelectorAll(selector)].at(-1)?.textContent),
      { selector, source: pattern.source }, { timeout },
    );
  };
  const sendText = async text => {
    await page.getByRole('textbox', { name: '文字消息' }).fill(text);
    await page.getByRole('button', { name: '发送', exact: true }).click();
  };
  const configure = async (reading, duplex) => {
    await page.getByRole('button', { name: '连接设置' }).click();
    await page.locator('#reading').selectOption(reading);
    await page.locator('#duplex').setChecked(duplex);
    await page.getByRole('button', { name: '保存设置' }).click();
  };

  await page.goto(base);
  await sendText('你好');
  await waitForText('.entry.assistant:last-child', /你接着说/);
  await waitForText('#status', /准备通话/);
  await sendText('我们刚才聊到哪里');
  await waitForText('.entry.assistant:last-child', /我记得/);
  await waitForText('#status', /准备通话/);
  await sendText('说慢一点');
  await waitForText('.entry.assistant:last-child', /打断测试/);
  await page.getByRole('button', { name: '打断', exact: true }).click();
  assert.equal(await page.locator('.entry.assistant:last-child').getAttribute('data-interrupted'), 'true');
  await page.getByRole('button', { name: '新对话' }).click();
  assert.equal(await page.locator('.entry').count(), 0);
  console.log('Responses SSE, history, new conversation, and manual interruption passed.');

  await page.evaluate(() => window.prepareTestSpeech());
  await configure('confirmed', false);
  await page.getByRole('button', { name: '开始通话' }).click();
  try {
    await waitForText('#status', /正在聆听/, 60_000);
  } catch (error) {
    throw new Error('Call not ready. Status: ' + await page.locator('#status').textContent() + ', error: ' + await page.locator('#error').textContent(), { cause: error });
  }
  await page.evaluate(() => window.speakTestUtterance());
  await waitForText('.entry.user .content', /天气/);
  await waitForText('#metric-asr', /\d+ ms/);
  await waitForText('#metric-audio', /\d+ ms/);
  for (const metric of ['speakable', 'queue', 'synthesis', 'pcm', 'gaps']) {
    await waitForText('#metric-' + metric, /\d+ ms/);
  }
  console.log('Python microphone loop passed', {
    models: await page.locator('#models').textContent(),
    asr: await page.locator('#metric-asr').textContent(),
    text: await page.locator('#metric-text').textContent(),
    audio: await page.locator('#metric-audio').textContent(),
    synthesis: await page.locator('#metric-synthesis').textContent(),
  });
  await waitForText('#status', /正在聆听/);

  const sampleCount = Number(process.env.TURNLINE_TEST_LATENCY_SAMPLES ?? 0);
  if (!Number.isInteger(sampleCount) || sampleCount < 0) throw new Error('Invalid latency sample count');
  if (sampleCount) {
    const metrics = ['audio', 'asr', 'text', 'speakable', 'queue', 'synthesis', 'pcm', 'gaps'];
    const durations = Object.fromEntries(metrics.map(name => [name, []]));
    for (let index = 0; index < sampleCount; index++) {
      const expected = 1 + await page.locator('.entry.user').count();
      await page.evaluate(() => window.speakTestUtterance());
      await page.waitForFunction(count => document.querySelectorAll('.entry.user').length === count, expected);
      await waitForText('#metric-audio', /\d+ ms/);
      await waitForText('#status', /正在聆听/);
      for (const name of metrics) {
        const value = Number.parseInt(await page.locator('#metric-' + name).textContent(), 10);
        assert.ok(Number.isFinite(value), 'Missing latency metric ' + name);
        durations[name].push(value);
      }
    }
    const stats = Object.fromEntries(metrics.map(name => {
      const sorted = durations[name].sort((a, b) => a - b);
      const middle = (sorted.length - 1) / 2;
      return [name, {
        median: (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2,
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
        max: sorted.at(-1),
      }];
    }));
    console.log('Warm latency in ms', { samples: sampleCount, ...stats });
  }

  for (const reading of ['confirmed', 'live']) {
    await configure(reading, reading === 'live');
    const requestsBeforeProgress = synthesisRequests.length;
    await sendText('告诉我进度');
    await waitForText('#metric-audio', /\d+ ms/);
    await waitForText('#status', /正在聆听/);
    assert.deepEqual(synthesisRequests.slice(requestsBeforeProgress), ['处理完了。', '详细结果可以在屏幕上看。']);
  }
  assert.equal(await page.locator('.entry.commentary').count(), 2);

  await page.getByRole('button', { name: '新对话' }).click();
  // Hold the second phrase while the first plays. Interrupt after SSE completion
  // to catch a full UI transcript leaking into the next model request.
  let holdRest = true;
  let releaseRest;
  const restReleased = new Promise(resolve => { releaseRest = resolve; });
  const routeRest = async route => {
    if (!holdRest || route.request().postDataJSON().text !== '你接着说。') return route.continue();
    await restReleased;
    await route.abort().catch(() => {});
  };
  const synthesisUrl = base + '/speech/synthesize';
  await page.route(synthesisUrl, routeRest);
  try {
    await Promise.all([
      page.waitForRequest(request => request.url() === synthesisUrl && request.postDataJSON()?.text === '你接着说。'),
      sendText('你好'),
    ]);
    await waitForText('.entry.assistant:last-child .content', /你接着说/);
    await waitForText('#status', /正在合成/);
    await page.getByRole('button', { name: '打断', exact: true }).click();
  } finally {
    holdRest = false;
    releaseRest();
    await page.unroute(synthesisUrl, routeRest);
  }
  const [followupRequest] = await Promise.all([
    page.waitForRequest(request => request.url() === base + '/demo/v1/responses'),
    sendText('刚刚说了什么'),
  ]);
  const followup = followupRequest.postDataJSON();
  assert.deepEqual(followup.input.filter(message => message.role === 'assistant'), [
    { role: 'assistant', content: '你好，我在听。' },
  ]);
  assert.match(followup.instructions, /最后完整播完的一句是「你好，我在听。」/);
  await page.getByRole('button', { name: '新对话' }).click();

  await sendText('说慢一点');
  await waitForText('#status', /正在播报/);
  assert.match(await page.locator('.entry.assistant:last-child .content').textContent(), /打断测试/);
  assert.doesNotMatch(await page.locator('.entry.assistant:last-child .content').textContent(), /最后一句/);
  await page.evaluate(() => window.speakTestUtterance());
  await waitForText('#metric-interruption', /\d+ ms/);
  await waitForText('.entry.user .content', /天气/);
  assert.equal(await page.locator('.entry[data-interrupted="true"]').count(), 1);
  await page.getByRole('button', { name: '挂断' }).click();
  assert.equal(await page.getByRole('button', { name: '开始通话' }).isEnabled(), true);
  assert.deepEqual(failures, []);
  console.log('Confirmed output, live audio before completion, speech interruption, and hang-up passed.');
} catch (error) {
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    console.error('Browser state', await page?.locator('#status, #error, #messages').allTextContents());
  }
  throw error;
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    server.kill();
    await once(server, 'exit');
  }
}
