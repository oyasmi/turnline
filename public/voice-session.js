import { clock } from './audio.js';

const FRAME_SAMPLES = 512;
const BUFFER_FRAMES = 62;
const HIGH_WATER = 24 * 1024;
const RETRY = [500, 1_000, 2_000, 4_000];

export class VoiceSession {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.pending = new Map();
    this.buffer = [];
    this.times = new Map();
  }

  connect() {
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.close();
    this.controller = new AbortController();
    this.epoch = 0;
    this.mode = 'off';
    const connection = this.open(this.controller.signal, 60_000).finally(() => {
      if (this.connecting === connection) this.connecting = undefined;
    });
    this.connecting = connection;
    return connection;
  }

  open(signal, limit) {
    const url = new URL('/speech/voice', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.ready = false;
    return new Promise((resolve, reject) => {
      let accepted = false;
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => {
        finish(signal.reason);
        socket.close();
      };
      const timeout = setTimeout(() => socket.close(), limit);
      signal.addEventListener('abort', abort, { once: true });
      socket.onmessage = ({ data }) => {
        if (this.socket !== socket || signal.aborted) return;
        this.lastMessage = performance.now();
        if (typeof data !== 'string') {
          this.pcm(data);
          return;
        }
        const event = JSON.parse(data);
        if (event.type === 'ready') {
          accepted = this.ready = true;
          this.frameCount = 0;
          this.times.clear();
          this.send({ type: 'reset', epoch: this.epoch });
          if (this.options) this.send(this.options);
          this.send({ type: 'capture', mode: this.mode });
          for (const job of this.pending.values()) {
            job.parts = [];
            job.size = 0;
            job.last = false;
            this.send(job.request);
          }
          this.flush();
          this.startHeartbeat(socket);
          finish();
        } else if (event.type === 'pong') {
          if (this.pingSent !== undefined) this.onEvent({ type: 'rtt', ms: this.lastMessage - this.pingSent });
          this.pingSent = undefined;
        } else if (event.type === 'fatal') {
          finish(new Error(event.message));
          this.close();
          if (accepted) this.onEvent(event);
        } else if (event.type.startsWith('say-')) {
          this.speechEvent(event);
        } else {
          this.onEvent(event);
        }
      };
      socket.onclose = () => {
        finish(new Error('无法连接语音服务，请检查网络后重试。'));
        if (this.socket !== socket || signal.aborted) return;
        this.ready = false;
        clearInterval(this.heartbeat);
        if (accepted && !this.reconnecting) {
          if (this.inCall) void this.reconnect(signal);
          else this.onEvent({ type: 'warm-disconnected' });
        }
      };
      socket.onerror = () => socket.close();
    });
  }

  async reconnect(signal) {
    this.reconnecting = true;
    this.epoch++;
    this.onEvent({ type: 'reconnecting' });
    const deadline = performance.now() + 15_000;
    try {
      for (let index = 0; !signal.aborted; index++) {
        const delay = RETRY[Math.min(index, RETRY.length - 1)];
        if (performance.now() + delay >= deadline) break;
        await new Promise(resolve => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, delay);
          signal.addEventListener('abort', done, { once: true });
        });
        if (signal.aborted) return;
        try {
          await this.open(signal, Math.min(4_000, deadline - performance.now()));
          if (!signal.aborted) this.onEvent({ type: 'reconnected' });
          return;
        } catch {
          if (signal.aborted) return;
        }
      }
      if (!signal.aborted) this.onEvent({ type: 'fatal', message: '语音连接恢复超时，请重新开始通话。' });
    } finally {
      if (!signal.aborted) this.reconnecting = false;
    }
  }

  startHeartbeat(socket) {
    clearInterval(this.heartbeat);
    this.pingSent = undefined;
    let lastTick = performance.now();
    this.heartbeat = setInterval(() => {
      const now = performance.now();
      const delayed = now - lastTick > 7_500;
      lastTick = now;
      // A delayed callback cannot distinguish a dead peer from a suspended tab.
      // Give the socket a fresh probe before timing out again.
      if (!delayed && this.pingSent !== undefined && now - Math.max(this.pingSent, this.lastMessage) >= 10_000) {
        socket.close();
      } else if (delayed || this.pingSent === undefined) {
        this.pingSent = now;
        this.send({ type: 'ping' });
      }
    }, 5_000);
  }

  send(event) {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event));
  }

  configure(speed, expectingAnswer, manual = false, minVoiceSeconds) {
    this.options = { type: 'configure', speed, expectingAnswer, manual, minVoiceSeconds };
    this.send(this.options);
  }

  capture(mode, tailAt) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'off') this.buffer.length = 0;
    let tailSample;
    if (Number.isFinite(tailAt)) {
      for (const [sample, time] of this.times) {
        if (time > tailAt) break;
        tailSample = sample;
      }
    }
    this.send({ type: 'capture', mode, tailSample });
  }

  reset() {
    this.clearRelease();
    this.epoch++;
    this.lostFrames = this.lostSpeech = false;
    this.buffer.length = 0;
    this.frameCount = 0;
    this.times.clear();
    this.send({ type: 'reset', epoch: this.epoch });
  }

  frame(samples, at, voiced) {
    if (this.mode === 'off') return;
    this.buffer.push({ samples, at, voiced });
    if (this.buffer.length > BUFFER_FRAMES) {
      this.lostSpeech ||= Boolean(this.buffer[0].voiced);
      this.buffer.shift();
      this.lostFrames = true;
    }
    this.flush();
  }

  releaseInput() {
    this.releaseAt = performance.now();
    this.flush();
  }

  clearRelease() {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = this.releaseAt = undefined;
  }

  flush() {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.lostFrames) {
      // A gap invalidates the open input turn. Start a new epoch and keep the recent audio.
      this.lostFrames = false;
      this.frameCount = 0;
      this.times.clear();
      this.send({ type: 'reset', epoch: ++this.epoch });
      this.onEvent({ type: 'input-gap', voiced: this.lostSpeech });
      this.lostSpeech = false;
    }
    while (this.buffer.length && this.socket.bufferedAmount < HIGH_WATER) {
      const { samples, at } = this.buffer.shift();
      this.socket.send(samples);
      this.frameCount += FRAME_SAMPLES;
      this.times.set(this.frameCount, at);
      this.times.delete(this.frameCount - 192 * FRAME_SAMPLES);
    }
    const congested = this.buffer.length > 0;
    if (congested !== this.congested) {
      this.congested = congested;
      this.onEvent({ type: 'congestion', congested });
    }
    if (this.releaseAt === undefined) return;
    if (!congested) {
      this.clearRelease();
      this.send({ type: 'force-commit', release: true });
    } else if (performance.now() - this.releaseAt >= 1500) {
      this.reset();
      this.onEvent({ type: 'input-gap', voiced: true });
    } else if (!this.releaseTimer) {
      this.releaseTimer = setTimeout(() => {
        this.releaseTimer = undefined;
        this.flush();
      }, 32);
    }
  }

  captureTime(sample) {
    const edge = Math.max(FRAME_SAMPLES, Math.ceil(sample / FRAME_SAMPLES) * FRAME_SAMPLES);
    const at = this.times.get(edge);
    return at === undefined ? undefined : at - (edge - sample) / 16;
  }

  say(turn, seq, text, speed, onPcm) {
    const request = { type: 'say', turn, seq, text, speed };
    const key = turn + ':' + seq;
    const result = new Promise((resolve, reject) => {
      this.pending.set(key, { request, onPcm, resolve, reject, parts: [], size: 0 });
    });
    this.send(request);
    return result;
  }

  pcm(data) {
    if (data.byteLength < 9 || data.byteLength % 2 !== 1) return;
    const view = new DataView(data);
    const job = this.pending.get(view.getUint32(0) + ':' + view.getUint16(4));
    if (!job?.rate || job.last) return;
    const samples = new Float32Array((data.byteLength - 7) / 2);
    for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(7 + index * 2, true) / 32768;
    if (!job.size) job.onPcm?.(clock(), job.timing);
    job.size += samples.length;
    job.parts.push(samples);
    job.last = Boolean(view.getUint8(6) & 1);
  }

  speechEvent(event) {
    const key = event.turn + ':' + event.seq;
    const job = this.pending.get(key);
    if (!job) return;
    if (event.type === 'say-start') {
      Object.assign(job, { rate: event.rate, timing: event.timing, parts: [], size: 0, last: false });
      return;
    }
    this.pending.delete(key);
    if (event.type === 'say-error' || !job.last || job.size !== event.samples) {
      job.reject(new Error(event.message ?? '语音服务返回了不完整的音频。'));
      return;
    }
    const audio = new Float32Array(job.size);
    let offset = 0;
    for (const part of job.parts) {
      audio.set(part, offset);
      offset += part.length;
    }
    job.resolve({ audio, rate: job.rate, ...event.textMap });
  }

  cancel(turn) {
    this.send({ type: 'cancel', turn });
    for (const [key, job] of this.pending) {
      if (job.request.turn > turn) continue;
      this.pending.delete(key);
      job.reject(new DOMException('Playback cancelled', 'AbortError'));
    }
  }

  close() {
    this.controller?.abort();
    this.socket?.close();
    this.socket = this.connecting = undefined;
    this.ready = this.reconnecting = this.congested = this.lostFrames = this.lostSpeech = false;
    clearInterval(this.heartbeat);
    this.clearRelease();
    this.cancel(Infinity);
    this.buffer.length = 0;
    this.times.clear();
  }
}
