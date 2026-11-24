import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';

const server = spawn('uv', ['run', '--no-sync', 'python', 'server.py', '--port', '0', '--demo'], {
  cwd: new URL('..', import.meta.url),
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
    const fixtures = new Map();
    const basic = '你好，今天天气怎么样？';
    const suspend = AudioContext.prototype.suspend;
    AudioContext.prototype.suspend = function () {
      window.testPausedPlayback = this;
      return suspend.call(this);
    };
    navigator.mediaDevices.getUserMedia = async () => {
      fixtureContext = new AudioContext();
      input = fixtureContext.createMediaStreamDestination();
      await fixtureContext.resume();
      return input.stream;
    };
    window.prepareTestSpeech = async (text = basic) => {
      const ready = await fetch('./speech/prepare', { method: 'POST' });
      if (!ready.ok) throw new Error(await ready.text());
      const { voices } = await ready.json();
      const response = await fetch('./speech/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, speaker: voices[0].id }),
      });
      if (!response.ok) throw new Error(await response.text());
      fixtures.set(text, {
        sampleRate: Number(response.headers.get('X-Sample-Rate')),
        samples: new Float32Array(await response.arrayBuffer()),
      });
    };
    window.speakTestUtterance = async (text = basic, seconds = Infinity) => {
      const fixture = fixtures.get(text);
      await fixtureContext.resume();
      const samples = fixture.samples.subarray(0, seconds * fixture.sampleRate);
      const buffer = fixtureContext.createBuffer(1, samples.length, fixture.sampleRate);
      buffer.copyToChannel(samples, 0);
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
    if (!await page.locator('#composer').isVisible()) await page.getByRole('button', { name: '文字输入' }).click();
    await page.getByRole('textbox', { name: '文字消息' }).fill(text);
    await page.getByRole('button', { name: '发送', exact: true }).click();
  };
  const configure = async (reading, duplex) => {
    await page.getByRole('button', { name: '通话设置' }).click();
    await page.locator('#reading').selectOption(reading);
    await page.locator('#duplex').setChecked(duplex);
    await page.getByRole('button', { name: '保存设置' }).click();
  };

  await page.goto(base);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.locator('#composer').isVisible(), false);
  assert.equal(await page.locator('#diagnostics').isVisible(), false);
  await page.getByRole('button', { name: '使用浅色主题' }).click();
  await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.getByRole('button', { name: '使用深色主题' }).click();
  await page.getByRole('button', { name: '通话设置' }).click();
  assert.equal(await page.locator('#silence').inputValue(), '2.2');
  assert.equal(await page.locator('#reading').inputValue(), 'live');
  assert.equal(await page.locator('#duplex').isChecked(), false);
  await page.locator('#close-settings').click();
  const [plainRequest] = await Promise.all([
    page.waitForRequest(request => request.url() === base + '/demo/v1/responses'),
    sendText('你好'),
  ]);
  assert.equal('instructions' in plainRequest.postDataJSON(), false);
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
  await page.evaluate(() => window.prepareTestSpeech('嗯。'));
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
  for (const metric of ['speakable', 'text-wait', 'queue', 'synthesis', 'pcm', 'gaps']) {
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
    const metrics = ['audio', 'asr', 'text', 'speakable', 'text-wait', 'queue', 'synthesis', 'pcm', 'gaps'];
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
  assert.match(followup.instructions, /正在和用户实时通话/);
  await page.getByRole('button', { name: '新对话' }).click();

  await sendText('说慢一点');
  await waitForText('#status', /正在播报/);
  assert.match(await page.locator('.entry.assistant:last-child .content').textContent(), /打断测试/);
  await waitForText('#metric-audio', /\d+ ms/);
  assert.doesNotMatch(await page.locator('.entry.assistant:last-child .content').textContent(), /你可以现在开始说话|最后一句/);
  const beforeBackchannel = await page.locator('.entry.user').count();
  await page.evaluate(() => window.speakTestUtterance(undefined, 0.22));
  await page.waitForTimeout(2700);
  assert.equal(await page.locator('#metric-interruption').textContent(), '—');
  await page.evaluate(() => window.speakTestUtterance('嗯。'));
  await page.waitForTimeout(3000);
  await page.waitForFunction(() => !window.testPausedPlayback || window.testPausedPlayback.state === 'running');
  assert.equal(await page.locator('.entry.user').count(), beforeBackchannel);
  assert.equal(await page.locator('.entry[data-interrupted="true"]').count(), 0);
  await page.evaluate(() => window.speakTestUtterance());
  await waitForText('#metric-interruption', /\d+ ms/);
  await waitForText('.entry.user .content', /天气/);
  assert.equal(await page.locator('.entry[data-interrupted="true"]').count(), 1);
  await page.getByRole('button', { name: '挂断' }).click();
  assert.equal(await page.getByRole('button', { name: '开始通话' }).isEnabled(), true);

  // The items endpoint repeats foreground replies and can show a pending item
  // before completion. Follow its cursor without speaking either twice.
  const fixtureBase = base + '/api/pipiclaw/v1';
  const fixtureConversation = 'conv_' + 'a'.repeat(32);
  await page.route(base + '/api/session', route => route.fulfill({ json: { connection: 'ready' } }));
  const items = [];
  const requests = [];
  const message = (id, text, status = 'completed') => ({
    id, type: 'message', role: 'assistant', phase: 'final_answer', status,
    content: [{ type: 'output_text', text }],
  });
  await page.route(fixtureBase + '/**', async route => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());
    if (pathname.endsWith('/items')) {
      const after = searchParams.get('after');
      const start = after ? items.findIndex(item => item.id === after) + 1 : 0;
      const data = items.slice(start);
      if (searchParams.get('order') === 'desc') data.reverse();
      await route.fulfill({ json: { data, has_more: false } });
      return;
    }
    if (pathname.endsWith('/conversations')) {
      await route.fulfill({ json: { id: fixtureConversation } });
      return;
    }
    const body = request.postDataJSON();
    requests.push(body);
    const key = requests.length;
    const answer = message('answer_' + key, '已收到。');
    items.push({ id: 'input_' + key, type: 'message', role: 'user', content: [] }, answer);
    await route.fulfill({ contentType: 'text/event-stream', body: [
      { type: 'response.created', response: { status: 'queued' } },
      { type: 'response.in_progress' },
      { type: 'response.output_item.done', output_index: 0, item: answer },
      { type: 'response.completed', response: { output: [answer] } },
    ].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') });
  });
  await page.reload();
  await waitForText('#backend-label', /Pipiclaw 已连接/);
  await page.getByRole('button', { name: '通话设置' }).click();
  await page.locator('#instructions').fill('每次只说一个步骤。');
  await page.getByRole('button', { name: '保存设置' }).click();
  await page.getByRole('button', { name: '开始通话' }).click();
  await waitForText('#status', /正在聆听/);
  const beforeReceipt = synthesisRequests.length;
  await sendText('帮我后台检查。');
  await waitForText('#metric-backend-queue', /\d+ ms/);
  await waitForText('#metric-audio', /\d+ ms/);
  await waitForText('#status', /正在聆听/);
  assert.match(requests[0].instructions, /每次只说一个步骤/);
  items.push(message('task_1', '**任务 `check-1` 汇报**\n检查完成。详细结果已记录。', 'in_progress'));
  await page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/items') && response.ok());
  assert.equal(await page.locator('.entry.update').count(), 0);
  items.at(-1).status = 'completed';
  await waitForText('.entry.update .content', /详细结果已记录/);
  await waitForText('#status', /正在聆听/);
  assert.equal(await page.locator('.entry.update').count(), 1);
  assert.deepEqual(synthesisRequests.slice(beforeReceipt), ['已收到。', '检查完成。']);
  await page.getByRole('button', { name: '挂断' }).click();
  items.push(message('task_2', '挂断后送到。'));
  await waitForText('.entry.update .content', /挂断后送到/);
  await sendText('继续用文字。');
  await waitForText('#status', /准备通话/);
  assert.equal(requests[1].conversation, requests[0].conversation);
  assert.equal('instructions' in requests[1], false);
  assert.deepEqual(synthesisRequests.slice(beforeReceipt), ['已收到。', '检查完成。']);
  await page.reload();
  await waitForText('#backend-label', /Pipiclaw 已连接/);
  await waitForText('.entry.assistant .content', /已收到/);
  await page.getByRole('button', { name: '通话诊断' }).click();
  const [report] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出逐轮计时' }).click(),
  ]);
  const samples = [];
  for await (const chunk of await report.createReadStream()) samples.push(chunk);
  const timing = JSON.parse(Buffer.concat(samples));
  assert.ok(timing.turns.some(turn => Number.isFinite(turn.timing_ms.audio)));
  assert.doesNotMatch(JSON.stringify(timing), /帮我后台检查|已收到/);
  assert.deepEqual(failures, []);
  console.log('Confirmed output, backchannel resume, speech interruption, session recovery and timing export passed.');
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
