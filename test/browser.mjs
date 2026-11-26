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
  browser = await chromium.launch({ channel: process.env.TURNLINE_TEST_BROWSER_CHANNEL });
  const page = await browser.newPage({ colorScheme: 'dark' });
  page.setDefaultTimeout(20_000);
  const failures = new Set();
  const synthesisRequests = [];
  page.on('pageerror', error => failures.add(error.message));
  let holdRest = false;
  let voiceSocket;
  let dropUntil = 0;
  const voiceEvents = [];
  await page.routeWebSocket(url => url.pathname === '/speech/voice', socket => {
    if (performance.now() < dropUntil) {
      socket.close();
      return;
    }
    voiceSocket = socket;
    const upstream = socket.connectToServer();
    socket.onMessage(message => {
      if (typeof message === 'string') {
        const event = JSON.parse(message);
        if (event.type === 'say') {
          synthesisRequests.push(event.text);
          if (holdRest && event.text === '你接着说。') return;
        }
      }
      upstream.send(message);
    });
    upstream.onMessage(message => {
      if (typeof message === 'string') voiceEvents.push(JSON.parse(message));
      socket.send(message);
    });
  });
  await page.addInitScript(() => {
    let input;
    let fixtureContext;
    const fixtures = new Map();
    const basic = '你好，今天天气怎么样？';
    const Worklet = AudioWorkletNode;
    let nearTail;
    let playEcho;
    let continuousEcho = false;
    window.enableEchoTest = enabled => { continuousEcho = enabled; };
    window.testAtTail = sequence => new Promise(resolve => { nearTail = { sequence, resolve }; });
    window.testEcho = sequence => new Promise(resolve => { playEcho = { sequence, resolve }; });
    window.testPlayback = [];
    window.testMicrophoneOpens = 0;
    window.AudioWorkletNode = class extends Worklet {
      constructor(context, name, options) {
        super(context, name, options);
        if (name !== 'speech-output') return;
        const chunks = new Map();
        const echoBuffers = new Map();
        const post = this.port.postMessage.bind(this.port);
        this.port.postMessage = (data, ...transfer) => {
          if (data.type === 'audio') {
            chunks.set(data.turn + ':' + data.seq, data.end);
            if (continuousEcho) {
              const echo = fixtureContext.createBuffer(1, data.audio.length - data.start, context.sampleRate);
              echo.copyToChannel(data.audio.subarray(data.start), 0);
              echoBuffers.set(data.turn + ':' + data.seq, echo);
            }
            if (playEcho?.sequence === data.seq) {
              const { resolve } = playEcho;
              playEcho = undefined;
              const buffer = fixtureContext.createBuffer(1, data.audio.length, context.sampleRate);
              buffer.copyToChannel(data.audio, 0);
              resolve(buffer);
            }
          }
          post(data, ...transfer);
        };
        this.port.addEventListener('message', ({ data }) => {
          if (['audible', 'voice-end', 'played', 'gain'].includes(data.type)) window.testPlayback.push(data);
          if (data.type === 'audible' && continuousEcho) {
            const key = data.turn + ':' + data.seq;
            const echo = echoBuffers.get(key);
            if (echo) playInput(echo, 0.06, 0.1);
            echoBuffers.delete(key);
          }
          if (data.type === 'head' && nearTail?.sequence === data.seq) {
            const end = chunks.get(data.turn + ':' + data.seq);
            if (end && data.offset >= end - context.sampleRate * 0.18 && data.offset < end) {
              void window.speakTestUtterance();
              nearTail.resolve();
              nearTail = undefined;
            }
          }
          if (data.type === 'played') chunks.delete(data.turn + ':' + data.seq);
        });
      }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      fixtureContext = new AudioContext();
      input = fixtureContext.createMediaStreamDestination();
      await fixtureContext.resume();
      window.testMicrophoneOpens++;
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
    window.speakTestUtterance = async (text = basic, seconds = Infinity, delay = 0, volume = 1) => {
      const fixture = fixtures.get(text);
      await fixtureContext.resume();
      const samples = fixture.samples.subarray(0, seconds * fixture.sampleRate);
      const buffer = fixtureContext.createBuffer(1, samples.length, fixture.sampleRate);
      buffer.copyToChannel(samples, 0);
      playInput(buffer, delay, volume);
      return samples.length / fixture.sampleRate;
    };
    function playInput(buffer, delay, volume) {
      const source = fixtureContext.createBufferSource();
      source.buffer = buffer;
      const gain = fixtureContext.createGain();
      gain.gain.value = volume;
      source.connect(gain).connect(input);
      source.start(fixtureContext.currentTime + delay);
    }
    window.loopTestUtterance = async (seconds, gap = 0.07) => {
      const fixture = fixtures.get(basic);
      const copy = fixture.samples.slice(0, fixture.samples.findLastIndex(sample => Math.abs(sample) > 0.006) + 1);
      const step = copy.length + Math.round(gap * fixture.sampleRate);
      const repeats = Math.ceil(seconds * fixture.sampleRate / step);
      const buffer = fixtureContext.createBuffer(1, step * repeats, fixture.sampleRate);
      for (let i = 0; i < repeats; i++) buffer.copyToChannel(copy, 0, i * step);
      playInput(buffer, 0, 1);
      return buffer.duration;
    };
    window.injectEcho = async sequence => playInput(await window.testEcho(sequence), 0.10, 0.1);
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
  const newConversation = async () => {
    await page.getByRole('button', { name: '新对话' }).click();
    const confirm = page.getByRole('button', { name: '确认清空？' });
    if (await confirm.isVisible()) await confirm.click();
  };
  const configure = async (reading, duplex, minVoiceSeconds) => {
    await page.getByRole('button', { name: '通话设置' }).click();
    await page.locator('#reading').selectOption(reading);
    await page.locator('#duplex').setChecked(duplex);
    if (minVoiceSeconds !== undefined) {
      await page.locator('#min-voice-seconds').selectOption(String(minVoiceSeconds));
    }
    await page.getByRole('button', { name: '保存设置' }).click();
  };

  await page.goto(base);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.locator('#composer').isVisible(), true);
  assert.equal(await page.locator('#diagnostics').isVisible(), false);
  await page.getByRole('button', { name: '使用浅色主题' }).click();
  await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.getByRole('button', { name: '使用深色主题' }).click();
  await page.getByRole('button', { name: '通话设置' }).click();
  assert.equal(await page.locator('#speed').inputValue(), 'balanced');
  assert.equal(await page.locator('#reading').inputValue(), 'live');
  assert.equal(await page.locator('#rate').inputValue(), '1');
  assert.equal(await page.locator('#min-voice-seconds').inputValue(), '2');
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
  await page.getByRole('button', { name: '停止工作', exact: true }).click();
  await waitForText('#work-status > details > summary', /已停止工作/);
  await newConversation();
  assert.equal(await page.locator('.entry').count(), 0);
  console.log('Responses SSE, history, new conversation, and explicit cancellation passed.');

  await page.evaluate(() => window.prepareTestSpeech());
  await page.evaluate(() => window.prepareTestSpeech('嗯，对。'));
  await page.evaluate(() => window.prepareTestSpeech('我想问一下'));
  await page.evaluate(() => window.prepareTestSpeech('明天北京天气怎么样？'));
  await configure('confirmed', false);
  await page.getByRole('button', { name: '开始通话' }).click();
  try {
    await waitForText('#status', /正在聆听/, 60_000);
  } catch (error) {
    throw new Error('Call not ready. Status: ' + await page.locator('#status').textContent() + ', error: ' + await page.locator('#error').textContent(), { cause: error });
  }
  const beforeShortVoice = voiceEvents.length;
  await page.evaluate(() => window.speakTestUtterance());
  await waitForText('#status', /正在听你说/);
  await waitForText('#status', /正在聆听/);
  const shortVoice = voiceEvents.slice(beforeShortVoice);
  assert.equal(shortVoice.some(event => event.type === 'partial' || event.type === 'tentative'), false);
  assert.ok(shortVoice.some(event => event.type === 'commit' && !event.text && event.voicedMs < 2000));
  assert.equal(await page.locator('.entry.user').count(), 0);

  const longVoice = '你好，请帮我看看明天北京的天气怎么样，出门需要带伞吗？';
  await page.evaluate(text => window.prepareTestSpeech(text), longVoice);
  await page.evaluate(text => window.speakTestUtterance(text), longVoice);
  await waitForText('.entry.user:not(.draft) .content', /天气/);
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

  await configure('live', false, 0);
  const sampleCount = Number(process.env.TURNLINE_TEST_LATENCY_SAMPLES ?? 0);
  if (!Number.isInteger(sampleCount) || sampleCount < 0) throw new Error('Invalid latency sample count');
  if (sampleCount) {
    const metrics = ['perceived', 'silence-wait', 'partial-lag', 'audio', 'asr', 'text', 'speakable', 'text-wait', 'queue', 'synthesis', 'pcm', 'gaps'];
    const durations = Object.fromEntries(metrics.map(name => [name, []]));
    for (let index = 0; index < sampleCount; index++) {
      const expected = 1 + await page.locator('.entry.user:not(.draft)').count();
      await page.evaluate(() => window.speakTestUtterance());
      await page.waitForFunction(count => document.querySelectorAll('.entry.user:not(.draft)').length === count, expected);
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
    assert.ok(stats.perceived.median <= 1100, 'Perceived latency P50 exceeded 1100 ms');
    assert.ok(stats.perceived.p95 <= 1500, 'Perceived latency P95 exceeded 1500 ms');
    assert.ok(stats['partial-lag'].p95 <= 1200, 'First partial P95 exceeded 1200 ms');
  }

  const inputs = () => page.locator('.entry.user:not(.draft)').count();
  const echoSeconds = Number(process.env.TURNLINE_TEST_ECHO_SECONDS ?? 0);
  if (!Number.isInteger(echoSeconds) || echoSeconds < 0) throw new Error('Invalid echo duration');
  if (echoSeconds) {
    await configure('live', true);
    await page.evaluate(() => window.enableEchoTest(true));
    const beforeEcho = await inputs();
    const beforeInterrupted = await page.locator('.entry[data-interrupted="true"]').count();
    const deadline = performance.now() + echoSeconds * 1000;
    let rounds = 0;
    while (performance.now() < deadline) {
      await sendText('回声测试。');
      rounds++;
      await waitForText('#metric-audio', /\d+ ms/);
      await waitForText('#status', /正在聆听/);
      const interrupted = await page.locator('.entry[data-interrupted="true"]').count() - beforeInterrupted;
      const unexpected = await inputs() - beforeEcho - rounds;
      assert.ok(interrupted <= 1 && unexpected <= 1,
        'Injected echo produced ' + interrupted + ' false interruptions and ' + unexpected + ' extra turns');
    }
    await page.evaluate(() => window.enableEchoTest(false));
    await configure('live', false);
    console.log('Echo injection soak passed', { seconds: echoSeconds, rounds,
      interrupted: await page.locator('.entry[data-interrupted="true"]').count() - beforeInterrupted,
      unexpected: await inputs() - beforeEcho - rounds });
  }

  const hesitationSamples = Number(process.env.TURNLINE_TEST_HESITATION_SAMPLES ?? 1);
  if (!Number.isInteger(hesitationSamples) || hesitationSamples < 1) throw new Error('Invalid hesitation sample count');
  let merged = 0;
  for (let sample = 0; sample < hesitationSamples; sample++) {
    const beforePause = voiceEvents.length;
    const beforeInputs = await inputs();
    const leadDuration = await page.evaluate(() => window.speakTestUtterance('我想问一下'));
    // The HTTP fixture includes an unpunctuated 60 ms tail.
    await page.evaluate(duration => window.speakTestUtterance('明天北京天气怎么样？', Infinity, duration + 0.84), leadDuration);
    await page.waitForFunction(count => document.querySelectorAll('.entry.user:not(.draft)').length > count, beforeInputs);
    await waitForText('.entry.user:not(.draft) .content', /明天北京天气/);
    await waitForText('#status', /正在聆听/);
    const committed = await page.locator('.entry.user:not(.draft) .content').last().textContent();
    if (await inputs() === beforeInputs + 1 && /我想问一下.*明天北京天气/.test(committed) &&
        voiceEvents.slice(beforePause).some(event => event.type === 'resumed')) merged++;
  }
  assert.ok(merged / hesitationSamples >= 0.95, 'Hesitation merge rate fell below 95%');
  if (hesitationSamples > 1) console.log('Hesitation merges', { merged, samples: hesitationSamples });
  const afterHesitation = await inputs();

  const beforeDictation = voiceEvents.length;
  const duration = await page.evaluate(() => window.loopTestUtterance(22));
  assert.ok(duration > 20, 'Long dictation fixture must exceed twenty seconds');
  await waitForText('#stage-caption', /天气/);
  await waitForText('#status', /正在聆听/, 45_000);
  assert.equal(voiceEvents.slice(beforeDictation).filter(event => event.type === 'commit').length, 1);
  assert.equal(await inputs(), afterHesitation + 1);

  const tailActivated = page.evaluate(() => window.testAtTail(1));
  await sendText('测试播报尾部接话');
  await tailActivated;
  await waitForText('.entry.user:not(.draft) .content', /你好.*今天天气/);
  assert.equal(await inputs(), afterHesitation + 3);
  await waitForText('#status', /正在聆听/);

  dropUntil = performance.now() + 5_000;
  await voiceSocket.close({ code: 1012, reason: 'test disconnect' });
  await waitForText('#status', /正在重连/);
  assert.equal(await page.getByRole('button', { name: '挂断' }).isEnabled(), true);
  await waitForText('#status', /正在聆听/, 15_000);
  await page.evaluate(() => window.speakTestUtterance());
  await page.waitForFunction(count => document.querySelectorAll('.entry.user:not(.draft)').length === count, afterHesitation + 4);
  await waitForText('#metric-perceived', /\d+ ms/);
  await waitForText('#status', /正在聆听/);
  const originalMicrophones = await page.evaluate(() => window.testMicrophoneOpens);
  await page.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event('devicechange')));
  await page.waitForFunction(count => window.testMicrophoneOpens === count + 1, originalMicrophones);
  const beforeForce = await inputs();
  const fixtureStart = performance.now();
  const fixtureDuration = await page.evaluate(() => window.speakTestUtterance('我想问一下'));
  await waitForText('#status', /正在听你说|等你继续说/);
  const untilTail = fixtureStart + fixtureDuration * 1000 + 90 - performance.now();
  if (untilTail > 0) await page.waitForTimeout(untilTail);
  await page.getByRole('button', { name: '立即发送语音' }).click();
  await page.waitForFunction(count => document.querySelectorAll('.entry.user:not(.draft)').length === count + 1, beforeForce);
  await waitForText('#metric-silence-wait', /\d{1,3} ms/);
  await waitForText('#status', /正在聆听/);
  console.log('Hesitation, long dictation, half-duplex tail capture, reconnect and microphone replacement passed.');

  for (const reading of ['confirmed', 'live']) {
    await configure(reading, reading === 'live');
    const requestsBeforeProgress = synthesisRequests.length;
    await sendText('告诉我进度');
    await waitForText('#metric-audio', /\d+ ms/);
    await waitForText('#status', /正在聆听/);
    assert.deepEqual(synthesisRequests.slice(requestsBeforeProgress), ['处理完了。', '详细结果可以在屏幕上看。']);
  }
  assert.equal(await page.locator('.entry.commentary').count(), 2);

  await newConversation();
  // Hold the second phrase while the first plays. Interrupt after SSE completion
  // to catch a full UI transcript leaking into the next model request.
  holdRest = true;
  try {
    const beforePlayed = await page.evaluate(() => window.testPlayback.filter(event => event.type === 'played').length);
    await sendText('你好');
    await waitForText('.entry.assistant:last-child .content', /你接着说/);
    await page.waitForFunction(count => window.testPlayback.filter(event => event.type === 'played').length > count, beforePlayed);
    await page.getByRole('button', { name: '停播', exact: true }).click();
  } finally {
    holdRest = false;
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
  await newConversation();

  const echoInjected = page.evaluate(() => window.injectEcho(0));
  await sendText('说慢一点');
  await waitForText('#status', /正在播报/);
  assert.match(await page.locator('.entry.assistant:last-child .content').textContent(), /打断测试/);
  await waitForText('#metric-audio', /\d+ ms/);
  assert.doesNotMatch(await page.locator('.entry.assistant:last-child .content').textContent(), /你可以现在开始说话|最后一句/);
  await echoInjected;
  const beforeBackchannel = await inputs();
  await page.waitForTimeout(1200);
  assert.equal(await inputs(), beforeBackchannel, 'Injected −20 dB playback echo submitted as user speech');
  await page.evaluate(() => window.speakTestUtterance(undefined, 0.22));
  await page.waitForTimeout(1000);
  assert.equal(await inputs(), beforeBackchannel);
  assert.equal(await page.locator('.entry[data-interrupted="true"]').count(), 0);

  const countPlayback = (type, event) => page.evaluate(([type, event]) =>
    window.testPlayback.filter(record => record.type === type && (!event || record.event === event)).length, [type, event]);
  const waitPlayback = (type, count, event) => page.waitForFunction(([type, count, event]) =>
    window.testPlayback.filter(record => record.type === type && (!event || record.event === event)).length > count, [type, count, event]);
  let audible = await countPlayback('audible');
  await waitPlayback('audible', audible);
  const restores = await countPlayback('gain', 'restore');
  await page.evaluate(() => window.speakTestUtterance('嗯，对。'));
  await waitPlayback('gain', restores, 'restore');
  assert.equal(await inputs(), beforeBackchannel);
  assert.equal(await page.locator('.entry[data-interrupted="true"]').count(), 0);

  audible = await countPlayback('audible');
  await waitPlayback('audible', audible);
  const pauses = await countPlayback('gain', 'pause');
  await page.evaluate(() => window.speakTestUtterance());
  await waitPlayback('gain', pauses, 'pause');
  await waitForText('#metric-interruption', /\d+ ms/);
  await waitForText('.entry.user:not(.draft) .content', /天气/);
  assert.equal(await page.locator('.entry[data-interrupted="true"]').count(), 1);
  const bargeSamples = Number(process.env.TURNLINE_TEST_BARGE_SAMPLES ?? 0);
  if (!Number.isInteger(bargeSamples) || bargeSamples < 0) throw new Error('Invalid interruption sample count');
  if (bargeSamples) {
    const timings = [];
    await waitForText('#status', /正在聆听/);
    for (let index = 0; index < bargeSamples; index++) {
      const before = await inputs();
      const beforeAudio = await countPlayback('audible');
      await sendText('说慢一点');
      await waitPlayback('audible', beforeAudio);
      await page.evaluate(() => window.speakTestUtterance());
      await page.waitForFunction(count => document.querySelectorAll('.entry.user:not(.draft)').length === count, before + 2);
      const stopReply = page.getByRole('button', { name: '停播', exact: true });
      if (await stopReply.isEnabled()) await stopReply.click();
      await waitForText('#status', /正在聆听/);
      timings.push(await page.evaluate(() => {
        const turns = JSON.parse(localStorage.getItem('turnline.call-timing.v1')).turns;
        return turns.findLast(turn => turn.source === 'text').timing_ms;
      }));
    }
    const p95 = metric => {
      const values = timings.map(timing => timing[metric]);
      assert.ok(values.every(Number.isFinite), 'Missing metric ' + metric);
      values.sort((a, b) => a - b);
      return values[Math.ceil(values.length * 0.95) - 1];
    };
    const profile = { samples: bargeSamples, duckP95: p95('bargeDuck'), pauseP95: p95('bargePause') };
    console.log('Interruption latency in ms', profile);
    assert.ok(profile.duckP95 <= 150, 'Interruption duck P95 exceeded 150 ms');
    assert.ok(profile.pauseP95 <= 400, 'Interruption pause P95 exceeded 400 ms');
  }
  await page.getByRole('button', { name: '通话设置' }).click();
  await page.locator('#input-mode').selectOption('hold');
  await page.getByRole('button', { name: '保存设置' }).click();
  await waitForText('#status', /等待你说话/);
  await page.locator('#messages').focus();
  const beforeHold = await inputs();
  await page.keyboard.down('Space');
  await page.evaluate(() => window.speakTestUtterance());
  await waitForText('#stage-caption', /天气/);
  await page.waitForTimeout(1500);
  assert.equal(await inputs(), beforeHold, 'Holding past a pause must keep the input open');
  await page.keyboard.up('Space');
  await page.waitForFunction(count => document.querySelectorAll('.entry.user').length === count + 1, beforeHold);
  await waitForText('#status', /等待你说话/);
  await page.getByRole('button', { name: '通话设置' }).click();
  await page.locator('#input-mode').selectOption('auto');
  await page.getByRole('button', { name: '保存设置' }).click();
  await waitForText('#status', /正在聆听/);
  console.log('Hold-to-talk kept a real recognition turn open until key release.');

  await page.getByRole('button', { name: '挂断' }).click();
  assert.equal(await page.getByRole('button', { name: '开始通话' }).isEnabled(), true);

  // The items endpoint repeats foreground replies and can show a pending item
  // before completion. Follow its cursor without speaking either twice.
  const fixtureBase = base + '/api/pipiclaw/v1';
  const fixtureConversation = 'conv_' + 'a'.repeat(32);
  await page.route(base + '/api/session', route => route.fulfill({ json: { connection: 'ready' } }));
  const items = [];
  const requests = [];
  let yieldFirstResponse;
  const heldResponse = new Promise(resolve => { yieldFirstResponse = resolve; });
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
    if (!pathname.endsWith('/responses')) {
      await route.fulfill({ json: { id: fixtureConversation, metadata: request.postDataJSON()?.metadata } });
      return;
    }
    const body = request.postDataJSON();
    requests.push(body);
    const key = requests.length;
    if (body.input === '等待前一轮结束') await heldResponse;
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
  await waitForText('#backend-label', /PipiClaw 已连接/);
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
  await page.evaluate(() => window.prepareTestSpeech());
  await configure('live', false);
  await page.getByRole('button', { name: '开始通话' }).click();
  await waitForText('#status', /正在聆听/);
  await sendText('等待前一轮结束');
  await waitForText('#status', /等待回复|正在思考|正在查询/);
  await page.evaluate(() => window.speakTestUtterance());
  await waitForText('.entry.user:not(.draft) .content', /今天天气/);
  assert.equal(requests.length, 3, 'A continuation must wait for the previous stored response');
  yieldFirstResponse();
  await waitForText('#metric-perceived', /\d+ ms/);
  await waitForText('#status', /正在聆听/);
  assert.equal(requests.length, 4);
  assert.equal(requests[3].conversation, requests[2].conversation);
  assert.match(requests[3].input, /今天天气/);
  await page.getByRole('button', { name: '挂断' }).click();
  await page.reload();
  await waitForText('#backend-label', /PipiClaw 已连接/);
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
  assert.ok(timing.turns.some(turn => Number.isFinite(turn.timing_ms.perceived) &&
    turn.timing_ms.perceived >= turn.timing_ms.silenceWait));
  assert.doesNotMatch(JSON.stringify(timing), /帮我后台检查|已收到/);
  assert.deepEqual([...failures], []);
  console.log('Confirmed output, backchannel resume, speech interruption, session recovery and timing export passed.');
} catch (error) {
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    console.error('Browser state', await page?.locator('#backend-label, #status, #error, #messages').allTextContents());
  }
  throw error;
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    server.kill();
    await once(server, 'exit');
  }
}
