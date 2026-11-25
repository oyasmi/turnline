import { AxeBuilder } from '@axe-core/playwright';
import { devices, expect, test } from '@playwright/test';

const conversation = {
  id: 'answer_example', role: 'assistant', type: 'message', phase: 'final_answer',
  content: [{ type: 'output_text', text: '下载目录约剩 **40 GB**。\n\n- 查看目录的大小\n- 清理确认可删除的文件\n\n```bash\ndu -sh ~/Downloads\n```\n\n[查看帮助](https://example.com/help)' }],
};

function reply(text = conversation.content[0].text) {
  const item = { ...conversation, content: [{ type: 'output_text', text }] };
  return [
    { type: 'response.created', response: { id: 'sample', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { output: [item] } },
  ].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('');
}

async function fixture(page, respond = route => route.fulfill({ contentType: 'text/event-stream', body: reply() })) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const input = new AudioContext();
      return input.createMediaStreamDestination().stream;
    };
    const Worklet = AudioWorkletNode;
    window.fixtureTones = [];
    window.AudioWorkletNode = class extends Worklet {
      constructor(...args) {
        super(...args);
        if (args[1] !== 'speech-output') return;
        const post = this.port.postMessage.bind(this.port);
        this.port.postMessage = (data, ...transfer) => {
          if (data.type === 'tone' || data.type === 'stop-tone') window.fixtureTones.push(data.type + ':' + data.kind);
          post(data, ...transfer);
        };
      }
    };
  });
  let socket;
  let epoch;
  let capture;
  const requests = [];
  let binaryFrames = 0;
  await page.routeWebSocket('**/speech/voice', connection => {
    socket = connection;
    connection.onMessage(message => {
      if (typeof message !== 'string') {
        binaryFrames++;
        return;
      }
      const event = JSON.parse(message);
      requests.push(event);
      if (event.type === 'reset') epoch = event.epoch;
      if (event.type === 'capture') capture = event.mode;
      if (event.type === 'ping') connection.send(JSON.stringify({ type: 'pong' }));
    });
    connection.send(JSON.stringify({ type: 'ready' }));
  });
  await page.route('**/demo/v1/responses', respond);
  await page.goto('/');
  await expect(page.locator('#backend-label')).toHaveText('离线演示');
  return {
    get frames() { return binaryFrames; },
    binary(data) { socket.send(data); },
    get capture() { return capture; },
    get requests() { return requests; },
    send(type, fields = {}) { socket.send(JSON.stringify({ type, epoch, input: 1, ...fields })); },
    drop() { socket.close(); },
  };
}

async function startCall(page) {
  await page.getByRole('button', { name: '开始通话' }).click();
  const allow = page.getByRole('button', { name: '继续通话' });
  if (await allow.isVisible()) await allow.click();
  await expect(page.locator('#status')).toHaveText(/正在聆听|等待你说话/);
}

async function send(page, content) {
  await page.getByRole('textbox', { name: '文字消息' }).fill(content);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}

for (const [width, height] of [[1440, 900], [1280, 720], [390, 844], [360, 640]]) {
  for (const theme of ['dark', 'light']) {
    test(`layout ${width}×${height} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme });
      const voice = await fixture(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page).toHaveScreenshot(`${width}x${height}-${theme}-idle.png`);
      await send(page, '下载目录还有多少空间？');
      await expect(page.locator('.entry.assistant strong')).toHaveText('40 GB');
      await startCall(page);
      voice.send('speech-start', { startSample: 0 });
      voice.send('partial', { text: '可以帮我看看哪个文件占用最多吗？' });
      voice.send('tentative', { text: '可以帮我看看哪个文件占用最多吗？', waitMs: 1700 });
      await expect(page.locator('#stage-progress')).toBeVisible();
      await expect(page.locator('#stage-caption')).toBeInViewport();
      await expect(page.locator('#stage-progress')).toBeInViewport();
      await expect(page).toHaveScreenshot(`${width}x${height}-${theme}-call.png`);
    });
  }
}

test('mobile call stays inline and composer fits a resized keyboard viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const voice = await fixture(page);
  await startCall(page);
  await expect(page.locator('.transcript')).toBeInViewport();
  await expect(page.locator('#message')).toBeInViewport();
  await page.getByRole('button', { name: '展开对话记录' }).click();
  await expect(page.getByRole('button', { name: '收起对话记录' })).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '展开对话记录' })).toHaveAttribute('aria-expanded', 'false');
  voice.send('speech-start', { startSample: 0 });
  voice.send('input-error', { message: '识别失败，请再说一遍。' });
  await expect(page.getByRole('alert')).toBeInViewport();
  await page.getByRole('button', { name: '文字输入' }).click();
  await page.setViewportSize({ width: 360, height: 350 });
  await expect(page.locator('#message')).toBeFocused();
  await expect(page.locator('#message')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
});

test('safe Markdown, waiting audio, playback range and interruption', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  let flush;
  const pause = new Promise(resolve => { flush = resolve; });
  const voice = await fixture(page, async route => {
    await pause;
    const text = '**第一句**，已经收到。第二句用于继续播报。\n\n[恶意链接](javascript:alert%281%29) [帮助](https://example.com) <script>test</script>\n\n```bash\necho ok\n```';
    await route.fulfill({ contentType: 'text/event-stream', body: reply(text) });
  });
  await startCall(page);
  await send(page, '请慢一点回复。');
  await expect(page.locator('#status')).toHaveText('正在思考');
  await expect.poll(() => page.evaluate(() => window.fixtureTones.includes('tone:waiting'))).toBeTruthy();
  expect(voice.requests.filter(event => event.type === 'say')).toHaveLength(0);
  flush();
  await expect(page.locator('.entry.assistant strong')).toHaveText('第一句');
  await expect(page.locator('.entry.assistant a')).toHaveCount(1);
  await expect(page.locator('.entry.assistant script')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '帮助' })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect.poll(() => voice.requests.filter(event => event.type === 'say').length).toBeGreaterThan(0);
  const say = voice.requests.find(event => event.type === 'say');
  const { seq, turn } = say;
  voice.send('say-start', { seq, turn, rate: 16000, timing: { queue: 0, synthesis: 0 } });
  const samples = 16000 * 3;
  // A valid synthesis packet drives the real AudioWorklet, including its playback head.
  const pcm = Buffer.alloc(samples * 2 + 7);
  pcm.writeUInt32BE(turn);
  pcm.writeUInt16BE(seq, 4);
  pcm[6] = 1;
  for (let index = 0; index < samples; index++) {
    pcm.writeInt16LE(Math.round(1000 * Math.sin(index * .12)), 7 + index * 2);
  }
  voice.binary(pcm);
  voice.send('say-done', { seq, turn, samples, textMap: { start: 0, end: samples } });
  await expect(page.locator('#status')).toHaveText('正在播报');
  await expect.poll(() => page.evaluate(() => CSS.highlights.has('spoken'))).toBeTruthy();
  await expect(page.locator('#stage-caption')).toContainText('第一句');
  await expect(page.locator('#stage-caption')).not.toContainText('**');
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '打断', exact: true }).click();
  await expect(page.locator('.entry.assistant .flag')).toHaveText('在此打断');
  await expect(page.locator('.entry.assistant .unheard').first()).toBeVisible();
  expect(await page.evaluate(() => CSS.highlights.has('spoken'))).toBe(false);
  await page.getByRole('button', { name: '复制代码' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('echo ok');
  await page.getByRole('button', { name: '重播', exact: true }).click();
  await expect.poll(() => voice.requests.some(event => event.type === 'say' && event.turn > turn)).toBeTruthy();
  await page.getByRole('button', { name: '打断', exact: true }).click();
  await expect(page.locator('.entry.user')).toHaveCount(1);
});

test('minimum speech duration is saved and sent when the voice connection opens', async ({ page }) => {
  const voice = await fixture(page);
  const minimum = page.getByLabel('最短有效语音');
  await page.getByRole('button', { name: '通话设置' }).click();
  await expect(minimum).toHaveValue('2');
  expect(await minimum.locator('option').evaluateAll(options => options.map(option => option.value)))
    .toEqual(['0', '1', '2', '3', '5']);
  await minimum.selectOption('0');
  await page.getByRole('button', { name: '保存设置' }).click();
  await page.reload();
  await page.getByRole('button', { name: '通话设置' }).click();
  await expect(minimum).toHaveValue('0');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await startCall(page);
  await expect.poll(() => voice.requests.findLast(event => event.type === 'configure')?.minVoiceSeconds).toBe(0);
});

test('hold-to-talk gates microphone frames and release commits once', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const voice = await fixture(page);
  await page.getByRole('button', { name: '通话设置' }).click();
  await page.locator('#input-mode').selectOption('hold');
  await page.getByRole('button', { name: '保存设置' }).click();
  await startCall(page);
  const orb = page.getByRole('button', { name: '按住说话' });
  const box = await orb.boundingBox();
  expect(voice.frames).toBe(0);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect.poll(() => voice.frames).toBeGreaterThan(0);
  voice.send('speech-start', { startSample: 0 });
  voice.send('partial', { text: '这是按住说话。' });
  await expect(page.locator('#stage-caption')).toHaveText('这是按住说话。');
  await expect(page.locator('#stage-progress')).toBeHidden();
  await page.mouse.up();
  await expect.poll(() => voice.requests.filter(event => event.type === 'force-commit').length).toBe(1);
  voice.send('commit', { text: '这是按住说话。', voiceEndSample: 512, silenceWaitMs: 0, asrMs: 20 });
  await expect(page.locator('.entry.user .content')).toHaveText('这是按住说话。');
  const released = voice.frames;
  await page.waitForTimeout(150);
  expect(voice.frames).toBe(released);
});

test.describe('Android touch emulation', () => {
  const { deviceScaleFactor, hasTouch, isMobile, viewport, userAgent } = devices['Pixel 7'];
  test.use({ deviceScaleFactor, hasTouch, isMobile, viewport, userAgent });

  test('swipe the transcript control to expand and collapse', async ({ page, context }) => {
    await fixture(page);
    await startCall(page);
    const toggle = page.locator('#expand-transcript');
    const cdp = await context.newCDPSession(page);
    const drag = async delta => {
      const box = await toggle.boundingBox();
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y + delta }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await drag(-60);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await drag(60);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});

test('idle, calling and settings have no serious axe violations', async ({ page }) => {
  await fixture(page);
  for (const state of ['idle', 'call', 'settings']) {
    if (state === 'call') await startCall(page);
    if (state === 'settings') await page.getByRole('button', { name: '通话设置' }).click();
    const audit = await new AxeBuilder({ page }).analyze();
    expect(audit.violations.filter(issue => ['serious', 'critical'].includes(issue.impact))).toEqual([]);
  }
});

test('UX enhancements: mode badge, quick prompts, speaker toggle and new-session guard', async ({ page }) => {
  await fixture(page);
  await expect(page.locator('#duration')).toBeHidden();
  await expect(page.locator('#mode-badge')).toHaveText('自动断句');
  await expect(page.locator('#text-only')).toBeHidden();

  // Clicking a quick prompt sends a message and hides empty state.
  await page.locator('.prompt-chip').first().click();
  await expect(page.locator('.entry.assistant strong')).toHaveText('40 GB');

  // First click on new-session enters confirmation state; second click clears.
  const newSession = page.locator('#new-session');
  await newSession.click();
  await expect(newSession).toContainText('确认清空？');
  await expect(page.locator('.entry.assistant')).toHaveCount(1);
  await newSession.click();
  await expect(page.locator('#empty')).toBeVisible();
  await expect(newSession).toContainText('新对话');

  // Clicking orb in idle starts a call and reveals duration & speaker toggle.
  await page.getByRole('button', { name: '开启语音通话' }).click();
  await expect(page.locator('#status')).toHaveText('正在聆听');
  await expect(page.locator('#duration')).toBeVisible();
  await expect(page.locator('#mode-badge')).toBeHidden();
  const speaker = page.locator('#text-only');
  await expect(speaker).toBeVisible();
  await expect(speaker).toHaveAttribute('aria-pressed', 'false');
  await speaker.click();
  await expect(speaker).toHaveAttribute('aria-pressed', 'true');
});
