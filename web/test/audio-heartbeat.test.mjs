import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaptureResampler, resample } from '../public/resampler.js';
import { VoiceSession } from '../public/voice-session.js';

const oscillator = (rate, frequency) =>
  Float32Array.from({ length: rate / 10 }, (_, i) => Math.sin(2 * Math.PI * frequency * i / rate));

function amplitude(samples, rate, frequency) {
  let cosine = 0;
  let sine = 0;
  for (let i = 100; i < samples.length - 100; i++) {
    const angle = 2 * Math.PI * frequency * i / rate;
    cosine += samples[i] * Math.cos(angle);
    sine += samples[i] * Math.sin(angle);
  }
  return 2 * Math.hypot(cosine, sine) / (samples.length - 200);
}

test('playback FIR preserves speech and rejects an upsampling image at both device rates', () => {
  for (const rate of [44100, 48000]) {
    const output = resample(oscillator(16000, 5000), 16000, rate);
    assert.equal(output.length, rate / 10);
    assert.ok(amplitude(output, rate, 5000) > .95);
    assert.ok(amplitude(output, rate, 11000) < .012);
  }
});

test('capture FIR preserves speech while removing high-frequency aliases', () => {
  for (const rate of [44100, 48000, 96000]) {
    const down = (frequency) => {
      const filter = new CaptureResampler(rate, 16000);
      const output = [];
      for (const input of oscillator(rate, frequency)) filter.push(input, value => output.push(value));
      assert.equal(output.length, Math.ceil((rate / 10 - filter.radius) * 16000 / rate));
      return output;
    };
    assert.ok(amplitude(down(2400), 16000, 2400) > .95);
    assert.ok(amplitude(down(12000), 16000, 4000) < .02);
  }
});

test('a minute-long background timer gap probes before closing a connection', context => {
  let tick;
  let now = 0;
  let closed = 0;
  const probes = [];
  context.mock.method(performance, 'now', () => now);
  context.mock.method(globalThis, 'setInterval', callback => { tick = callback; });
  const voice = new VoiceSession(() => {});
  voice.send = event => probes.push(event.type);
  voice.lastMessage = 0;
  voice.startHeartbeat({ close: () => closed++ });
  now = 5000;
  tick();
  now = 65000;
  tick();
  assert.equal(closed, 0);
  assert.deepEqual(probes, ['ping', 'ping']);
  // A peer that stays silent after foreground ticks resumes should time out.
  now = 70000;
  tick();
  assert.equal(closed, 0);
  now = 75000;
  tick();
  assert.equal(closed, 1);
});

test('hold release sends buffered audio before force commit', context => {
  const pending = [];
  context.mock.method(globalThis, 'setTimeout', callback => { pending.push(callback); return pending.length; });
  const voice = new VoiceSession(() => {});
  const sent = [];
  voice.ready = true;
  voice.mode = 'listen';
  voice.frameCount = 0;
  voice.socket = {
    bufferedAmount: 32 * 1024,
    readyState: WebSocket.OPEN,
    send: event => sent.push(event),
  };
  const audio = new Int16Array(512);
  voice.frame(audio, 0, true);
  voice.releaseInput();
  assert.deepEqual(sent, []);
  assert.equal(pending.length, 1);
  voice.socket.bufferedAmount = 0;
  pending[0]();
  assert.equal(sent[0], audio);
  assert.deepEqual(JSON.parse(sent[1]), { type: 'force-commit', release: true });
});
