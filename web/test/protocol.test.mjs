import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureMode, initialCallState, reduceCall } from '../public/call-state.js';
import { BargeIn, echoes, matchesEcho, acknowledgement } from '../public/barge-in.js';
import { splitSpeech } from '../public/chunker.js';
import { updateSpeech } from '../public/conversation-updates.js';
import { isBackchannel, readEvents } from '../public/responses.js';

test('reads an SSE stream with split CRLF, split UTF-8, comments and multiline data', async () => {
  const bytes = new TextEncoder().encode(': keepalive\r\ndata: {"type":"delta",\r\ndata: "delta":"你好"}\r\n\r\ndata: [DONE]\n\n');
  const stream = new ReadableStream({
    start(controller) {
      for (const value of bytes) controller.enqueue(Uint8Array.of(value));
      controller.close();
    },
  });
  const events = [];
  for await (const event of readEvents(stream)) events.push(event);
  assert.deepEqual(events, [{ type: 'delta', delta: '你好' }]);
});

test('segments Chinese output without stealing decimals or voicing fenced code', () => {
  let split = splitSpeech('版本是 1.2。再试一次');
  assert.deepEqual(split, { phrases: ['版本是 1.2。'], rest: '再试一次' });
  split = splitSpeech(split.rest + '！\n```js\nconsole.log(42);');
  assert.deepEqual(split, { phrases: ['再试一次！'], rest: '```js\nconsole.log(42);' });
  assert.deepEqual(splitSpeech(split.rest + '\n```\n好了。', true), { phrases: ['好了。'], rest: '' });
});

test('opens a streamed reply on a short clause or at fourteen spoken characters', () => {
  const thirteen = '一二三四五六七八九十一二三';
  assert.deepEqual(splitSpeech(thirteen, false, true), { phrases: [], rest: thirteen });
  assert.deepEqual(splitSpeech(thirteen + '四', false, true), { phrases: [thirteen + '四'], rest: '' });
  assert.deepEqual(splitSpeech('这是一句问候。还有', false, true), { phrases: ['这是一句问候。'], rest: '还有' });
  assert.deepEqual(splitSpeech('Three short words. More', false, true), { phrases: ['Three short words.'], rest: ' More' });
  assert.deepEqual(splitSpeech('你好。', true, true), { phrases: ['你好。'], rest: '' });
  const hidden = '\`\`\`js\nconst code = 42;\n\`\`\`\nhttps://example.test/a-very-long-path\n';
  assert.deepEqual(splitSpeech(hidden + thirteen, false, true).phrases, []);
  assert.deepEqual(splitSpeech(hidden + thirteen + '四', false, true).phrases, [thirteen + '四']);
});

test('keeps mixed-script model names and decimals intact across speech chunks', () => {
  const first = '国内：MiniMax 发布 H3 Family 系列模型，包含 H3、H3-Highspeed、H3-Lite 和图像模型等；';
  const second = '官方称 H3 开源百天已衍生出 1472 个模型，下载量超过 1.48 亿次。';
  assert.deepEqual(splitSpeech('1. ' + first + second, true).phrases, ['1. ' + first, second]);
  const prefix = '请'.repeat(62);
  const model = 'H3-Highspeed支持这些功能。';
  assert.deepEqual(splitSpeech(prefix + model, true).phrases, [prefix, model]);
});

test('listens through thinking, monitors a whole spoken reply and drains only when idle', () => {
  let state = initialCallState;
  const events = [
    ['connect', 'off', 'off', false],
    ['ready', 'listen', 'listen', true],
    ['request-started', 'listen', 'listen', false],
    ['speech-start', 'listen', 'listen', false],
    ['tentative', 'listen', 'listen', false],
    ['resumed', 'listen', 'listen', false],
    ['commit', 'listen', 'listen', false],
    ['playback-started', 'monitor', 'barge', false],
    ['duck', 'monitor', 'barge', false],
    ['pause', 'monitor', 'barge', false],
    ['restore', 'monitor', 'barge', false],
    ['playback-ended', 'listen', 'listen', true],
    ['reconnecting', 'listen', 'listen', false],
    ['mute', 'off', 'off', false],
    ['hangup', 'off', 'off', false],
  ];
  for (const [type, half, full, drain] of events) {
    const [next, effects] = reduceCall(state, {
      type, ...(type === 'speech-start' || type === 'tentative' || type === 'resumed' || type === 'commit' ? { input: 1 } : {}),
      ...(type === 'restore' ? { playing: true } : {}),
    });
    state = next;
    assert.equal(captureMode(state, false), half, type);
    assert.equal(captureMode(state, true), full, type);
    assert.equal(effects.includes('drain'), drain, type);
  }
});

test('finds a partial or slightly mistranscribed echo and preserves a real interruption', () => {
  const output = '第一句播报时你可以自然地开口插话。';
  assert.equal(echoes('可以自然地开口', output), true);
  assert.equal(echoes('第一句播放时', output), true);
  assert.equal(echoes('帮我查今天天气', output), false);
  const recent = ['我记得我们刚才聊过。', '你接着说。'];
  assert.equal(matchesEcho('聊过。', recent), true);
  assert.equal(matchesEcho('我记得我们刚才聊过，你接着说。', recent), true);
  assert.equal(acknowledgement('嗯，对。'), true);
  assert.equal(acknowledgement('对？'), false);
  assert.equal(acknowledgement('对，对。'), true);
});

test('restores volume while slow ASR keeps the interruption candidate', async () => {
  const events = [];
  const player = { echoReferences: [], gain() {} };
  const barge = new BargeIn(player, event => events.push(event.type));
  barge.pause({ input: 1 }, 100);
  try {
    await new Promise(resolve => setTimeout(resolve, 780));
    assert.deepEqual(events, ['duck', 'pause', 'barge-waiting']);
    barge.transcript({ type: 'partial', input: 1, text: '帮我查天气' });
    assert.deepEqual(events, ['duck', 'pause', 'barge-waiting', 'barge-confirmed']);
  } finally {
    barge.clear();
  }
});

test('recovers from a short clipped transcript and accepts an explicit stop', () => {
  const events = [];
  const player = { echoReferences: [], gain() {} };
  const barge = new BargeIn(player, event => events.push(event.type));
  barge.pause({ input: 1 }, 100);
  barge.transcript({ type: 'tentative', input: 1, text: '你。', voicedMs: 210 });
  assert.equal(events.at(-1), 'restore');
  barge.pause({ input: 2 }, 800);
  barge.transcript({ type: 'tentative', input: 2, text: '停。', voicedMs: 210 });
  assert.equal(events.at(-1), 'barge-confirmed');
});

test('server confirmation preserves an early local pause and its playhead', () => {
  const events = [];
  const player = { echoReferences: [], gain() {} };
  const barge = new BargeIn(player, event => events.push(event.type));
  barge.duck(100, []);
  barge.provisionalPause();
  barge.pause({ input: 1 }, 95);
  assert.deepEqual(events, ['duck', 'pause']);
  barge.clear();
});

test('acknowledgement filtering leaves questions, confirmations and corrections actionable', () => {
  for (const text of ['嗯。', '嗯，嗯。', '哦。', 'うん。', '嗯ん。']) assert.equal(isBackchannel(text), true, text);
  for (const text of ['嗯？', '嗯，等一下。', 'うん、待って。', '好。', '取消。']) assert.equal(isBackchannel(text), false, text);
});

test('speaks the result of a task report and keeps its internal identifier on screen', () => {
  assert.equal(updateSpeech('**任务 `check-1` 汇报**\n检查完成。详细结果已记录。'), '检查完成。');
  assert.equal(updateSpeech('**✅ 任务 `check-1` 已完成**\n- 历时：两秒'), '任务 已完成');
});
