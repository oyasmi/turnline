export const clock = () => performance.timeOrigin + performance.now();

export class RecognizerConnection {
  constructor(onEvent) {
    this.onEvent = onEvent;
  }

  connect() {
    const url = new URL('./speech/listen', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      let ready = false;
      let reported = false;
      const fail = message => {
        if (reported) return;
        reported = true;
        clearTimeout(timeout);
        if (ready && this.socket === socket) this.onEvent({ type: 'fatal', message });
        else reject(new Error(message));
      };
      const timeout = setTimeout(() => {
        fail('SenseVoice 准备超时，请检查 Python 服务后重试。');
        socket.close();
      }, 60_000);
      socket.onmessage = ({ data }) => {
        if (this.socket !== socket) return;
        const event = JSON.parse(data);
        if (event.type === 'ready') {
          ready = true;
          clearTimeout(timeout);
          resolve();
        } else if (event.type === 'fatal') {
          fail(event.message);
        } else {
          this.onEvent(event);
        }
      };
      socket.onclose = () => fail('麦克风连接已关闭，请重新开始通话。');
      socket.onerror = () => fail('无法连接语音服务，请检查 Python 服务。');
    });
  }

  get connected() { return this.socket?.readyState === WebSocket.OPEN; }

  reset(epoch, silence) {
    if (this.connected) this.socket.send(JSON.stringify({ type: 'reset', epoch, silence }));
  }

  frame(samples) {
    if (this.connected && this.socket.bufferedAmount < 131_072) this.socket.send(samples);
  }

  close() {
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }
}

async function requestSpeech(path, body, signal) {
  const options = { method: 'POST', signal };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch('./speech/' + path, options);
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.error?.message ?? '语音服务请求失败，请检查 Python 服务。');
  }
  return response;
}

export const speechServer = {
  async prepare(signal) { return (await requestSpeech('prepare', undefined, signal)).json(); },
  async *synthesize(text, speaker, signal) {
    const response = await requestSpeech('synthesize', { text, speaker }, signal);
    const sampleRate = Number(response.headers.get('X-Sample-Rate'));
    if (!Number.isInteger(sampleRate) || sampleRate <= 0 || !response.body) {
      throw new Error('语音服务返回了无效的音频。');
    }
    const timing = Object.fromEntries(Array.from(
      (response.headers.get('Server-Timing') ?? '').matchAll(/(tts-queue|tts-first-pcm);dur=([\d.]+)/g),
      ([, name, value]) => [name, Number(value)],
    ));
    for await (const samples of pcmChunks(response.body)) yield { samples, sampleRate, timing };
  },
};

export async function* pcmChunks(stream) {
  const reader = stream.getReader();
  let tail = new Uint8Array(0);
  let received = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let bytes = value;
      if (tail.length || value.byteOffset % 4) {
        bytes = new Uint8Array(tail.length + value.length);
        bytes.set(tail);
        bytes.set(value, tail.length);
      }
      const aligned = bytes.length - bytes.length % 4;
      tail = bytes.slice(aligned);
      if (aligned) {
        received = true;
        yield new Float32Array(bytes.buffer, bytes.byteOffset, aligned / 4);
      }
    }
    if (!received || tail.length) throw new Error('语音服务返回了不完整的音频。请重试。');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function captureMicrophone(onFrame) {
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioContext) {
    throw new Error('当前页面无法使用麦克风。请用 localhost 或 HTTPS 在 Chrome / Edge 里打开。');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  let context;
  try {
    context = new AudioContext({ sampleRate: 16_000, latencyHint: 'interactive' });
    await context.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url));
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, 'microphone-frames', { channelCount: 1 });
    worklet.port.onmessage = ({ data }) => onFrame(data);
    source.connect(worklet).connect(context.destination);
    return {
      setEnabled(enabled) {
        for (const track of stream.getAudioTracks()) track.enabled = enabled;
      },
      stop() {
        worklet.port.onmessage = null;
        worklet.port.close();
        source.disconnect();
        worklet.disconnect();
        for (const track of stream.getTracks()) track.stop();
        void context.close().catch(() => {});
      },
    };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    await context?.close().catch(() => {});
    throw error;
  }
}

export class SpeechPlayer {
  constructor(engine, onState, onError) {
    this.engine = engine;
    this.onState = onState;
    this.onError = onError;
    this.queue = [];
    this.sources = new Set();
    this.phrases = new Set();
    this.generation = 0;
    this.nextStart = 0;
    this.paused = false;
  }

  resume() {
    this.context ??= new AudioContext({ latencyHint: 'interactive' });
    return this.context.resume();
  }

  get active() { return this.queue.length > 0 || this.sources.size > 0 || this.generating === this.generation; }
  get playing() { return !this.paused && this.sources.size > 0; }

  enqueue(entry) {
    this.queue.push(entry);
    this.onState();
    void this.pump();
  }

  pause() {
    this.paused = true;
    for (const source of this.sources) clearTimeout(source.timer);
    const suspended = this.context.suspend();
    this.onState();
    return suspended;
  }

  unpause() {
    if (!this.paused) return;
    this.paused = false;
    const generation = this.generation;
    void this.context.resume().then(() => {
      if (this.paused || this.generation !== generation) return;
      for (const source of this.sources) this.armStart(source);
      this.onState();
      void this.pump();
    }).catch(this.onError);
  }

  stop() {
    this.generation++;
    this.queue.length = 0;
    this.request?.abort();
    for (const { source, timer } of this.sources) {
      clearTimeout(timer);
      source.onended = null;
      try { source.stop(); } catch {}
      source.disconnect();
    }
    this.sources.clear();
    this.phrases.clear();
    this.nextStart = 0;
    this.unpause();
    this.onState();
  }

  async pump() {
    if (this.paused || this.generating !== undefined || this.phrases.size >= 2 || !this.queue.length) return;
    const generation = this.generation;
    this.generating = generation;
    const entry = this.queue.shift();
    const phrase = { entry, pending: 0, finished: false, complete: false, started: false };
    this.phrases.add(phrase);
    const controller = new AbortController();
    this.request = controller;
    try {
      for await (const audio of this.engine.synthesize(entry.text, entry.voice, controller.signal)) {
        if (this.generation !== generation) return;
        if (!phrase.started) entry.onPcm?.(clock(), audio.timing);
        this.schedule(phrase, audio);
        phrase.started = true;
      }
      phrase.complete = true;
    } catch (error) {
      if (this.generation === generation) this.onError(error);
    } finally {
      this.generating = undefined;
      this.request = undefined;
      phrase.finished = true;
      this.finishPhrase(phrase);
      this.onState();
      void this.pump();
    }
  }

  finishPhrase(phrase) {
    if (!phrase.finished || phrase.pending || !this.phrases.delete(phrase)) return;
    if (phrase.complete) phrase.entry.onEnd?.();
  }

  armStart(record) {
    if (!record.onStart || this.paused || this.context.state !== 'running') return;
    clearTimeout(record.timer);
    record.timer = setTimeout(() => {
      const onStart = record.onStart;
      record.onStart = undefined;
      onStart(clock());
    }, Math.max(0, (record.start - this.context.currentTime) * 1000));
  }

  schedule(phrase, { samples, sampleRate }) {
    const context = this.context;
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const start = Math.max(context.currentTime + 0.012, this.nextStart);
    const gap = (start - this.nextStart) * 1000;
    if (this.nextStart && gap > 30) phrase.entry.onGap?.(gap);
    this.nextStart = start + buffer.duration;
    const record = { source, start, onStart: phrase.started ? undefined : phrase.entry.onStart };
    this.sources.add(record);
    phrase.pending++;
    this.onState();
    source.onended = () => {
      clearTimeout(record.timer);
      record.onStart?.(clock());
      this.sources.delete(record);
      source.disconnect();
      phrase.pending--;
      this.finishPhrase(phrase);
      this.onState();
      void this.pump();
    };
    source.start(start);
    this.armStart(record);
  }
}
