import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pcmChunks } from '../public/audio.js';
import { VoiceTurn } from '../public/voice-turn.js';
import { updateSpeech } from '../public/conversation-updates.js';
import { isBackchannel, readEvents, speechText, splitSpeech } from '../public/responses.js';

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

test('opens a streamed reply at 21 speakable characters without waiting for a sentence', () => {
  const twenty = '一二三四五六七八九十一二三四五六七八九十';
  assert.deepEqual(splitSpeech(twenty, false, true), { phrases: [], rest: twenty });
  assert.deepEqual(splitSpeech(twenty + '一', false, true), { phrases: [twenty + '一'], rest: '' });
  assert.deepEqual(splitSpeech('你好。', true, true), { phrases: ['你好。'], rest: '' });
  const code = '\x60\x60\x60js\nconst onlyCode = "never speak these characters";\n\x60\x60\x60\n';
  const protectedText = code + 'https://example.test/a-very-long-path\n' + twenty;
  assert.deepEqual(splitSpeech(protectedText, false, true), { phrases: [], rest: protectedText });
  assert.deepEqual(splitSpeech(protectedText + '一', false, true), { phrases: [twenty + '一'], rest: '' });
});

test('keeps mixed-script model names and decimals intact across speech chunks', () => {
  const first = '国内：MiniMax 发布 H3 Family 系列模型，包含 H3、H3-Highspeed、H3-Lite 和图像模型等；';
  const second = '官方称 H3 开源百天已衍生出 1472 个模型，下载量超过 1.48 亿次。';
  assert.deepEqual(splitSpeech('1. ' + first + second, true).phrases, [first, second]);
  const prefix = '请'.repeat(62);
  const model = 'H3-Highspeed支持这些功能。';
  assert.deepEqual(splitSpeech(prefix + model, true).phrases, [prefix, model]);
});

test('preserves PCM samples across arbitrary HTTP chunks and reports a truncated last sample', async () => {
  const bytes = new Uint8Array(Float32Array.of(0.5, -0.75, 0.25).buffer);
  const stream = end => new ReadableStream({
    start(controller) {
      for (const [begin, stop] of [[0, 3], [3, 9], [9, end]]) controller.enqueue(bytes.subarray(begin, stop));
      controller.close();
    },
  });
  const collect = async body => {
    const samples = [];
    for await (const chunk of pcmChunks(body)) samples.push(...chunk);
    return samples;
  };
  assert.deepEqual(await collect(stream(12)), [0.5, -0.75, 0.25]);
  await assert.rejects(collect(stream(11)), /不完整/);
});

test('speaks capacity and hidden paths while leaving punctuation out of unsupported phones', () => {
  assert.equal(speechText('《红楼梦》。占用 37%，`~/.cache` 约 6.5GB。'),
    '红楼梦。占用 百分之37，家目录的点 cache 约 6.5吉字节。');
  assert.equal(speechText('Disk is at 37%. Cache takes 6.5GB.'), 'Disk is at 37 percent. Cache takes 6.5 gigabytes.');
});

test('holds an unfinished sentence, joins its continuation, and releases it on timeout', () => {
  const sent = [];
  let scheduled;
  const buffer = new VoiceTurn((...args) => sent.push(args), () => {}, callback => {
    scheduled = callback;
    return 1;
  }, () => { scheduled = undefined; });
  const start = { endpointAt: 100, asrMs: 20 };
  const end = { endpointAt: 400, asrMs: 30 };
  buffer.accept('你帮我看一下，现在。', start);
  assert.equal(sent.length, 0);
  assert.equal(typeof scheduled, 'function');
  buffer.started();
  assert.equal(scheduled, undefined);
  buffer.accept('磁盘占用率怎么样？', end);
  assert.deepEqual(sent.shift(), ['你帮我看一下，现在，磁盘占用率怎么样？', { endpointAt: 400, asrMs: 50 }]);
  buffer.accept('我想问一下。', start);
  scheduled();
  assert.deepEqual(sent, [['我想问一下。', start]]);
  buffer.accept('我想问一下。', start);
  buffer.reset();
  assert.equal(scheduled, undefined);
  assert.equal(buffer.waiting, false);
});

test('acknowledgement filtering leaves questions, confirmations and corrections actionable', () => {
  for (const text of ['嗯。', '嗯，嗯。', '哦。', 'うん。', '嗯ん。']) assert.equal(isBackchannel(text), true, text);
  for (const text of ['嗯？', '嗯，等一下。', 'うん、待って。', '好。', '取消。']) assert.equal(isBackchannel(text), false, text);
});

test('speaks the result of a task report and keeps its internal identifier on screen', () => {
  assert.equal(updateSpeech('**任务 `check-1` 汇报**\n检查完成。详细结果已记录。'), '检查完成。');
  assert.equal(updateSpeech('**✅ 任务 `check-1` 已完成**\n- 历时：两秒'), '任务 已完成');
});
