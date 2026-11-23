import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pcmChunks } from '../public/audio.js';
import { updateSpeech } from '../public/conversation-updates.js';
import { backendUrl, isBackchannel, readEvents, splitSpeech } from '../public/responses.js';

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

test('uses the supplied Responses base URL and keeps credentials out of it', () => {
  assert.equal(backendUrl('http://127.0.0.1:8787/v1/responses/'), 'http://127.0.0.1:8787/v1');
  assert.equal(backendUrl('', 'http://localhost:4173'), 'http://localhost:4173/demo/v1');
  assert.throws(() => backendUrl('https://name:secret@example.com/v1'));
  assert.throws(() => backendUrl('http://example.com/v1'));
});

test('acknowledgement filtering leaves questions, confirmations and corrections actionable', () => {
  for (const text of ['嗯。', '嗯，嗯。', '哦。', 'うん。']) assert.equal(isBackchannel(text), true, text);
  for (const text of ['嗯？', '嗯，等一下。', 'うん、待って。', '好。', '取消。']) assert.equal(isBackchannel(text), false, text);
});

test('speaks the result of a task report and keeps its internal identifier on screen', () => {
  assert.equal(updateSpeech('**任务 `check-1` 汇报**\n检查完成。详细结果已记录。'), '检查完成。');
  assert.equal(updateSpeech('**✅ 任务 `check-1` 已完成**\n- 历时：两秒'), '任务 已完成');
});
