import { clock } from './audio.js';

function resample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const output = new Float32Array(Math.max(1, Math.round(input.length / ratio)));
  for (let index = 0; index < output.length; index++) {
    const position = index * ratio;
    const left = Math.floor(position);
    const sample = input[Math.min(left, input.length - 1)];
    output[index] = sample + ((input[left + 1] ?? sample) - sample) * (position - left);
  }
  return output;
}

function earcon(rate, kind) {
  const notes = { connect: [520, 680], commit: [570], disconnect: [540, 390] }[kind];
  const audio = new Float32Array(Math.round(rate * (notes.length === 1 ? 0.080 : 0.14)));
  for (let i = 0; i < audio.length; i++) {
    const progress = i / audio.length;
    const window = Math.sin(Math.PI * progress) ** 2;
    audio[i] = 0.052 * window * Math.sin(2 * Math.PI * notes[Math.floor(progress * notes.length)] * i / rate);
  }
  return audio;
}

export class SpeechPlayer {
  constructor(session, onEvent) {
    this.session = session;
    this.onEvent = onEvent;
    this.number = 0;
  }

  async open(context) {
    this.context = context;
    await context.audioWorklet.addModule(new URL('./player-worklet.js', import.meta.url));
    if (this.context !== context || context.state === 'closed') return;
    this.node = new AudioWorkletNode(context, 'speech-output', { numberOfInputs: 0, outputChannelCount: [1] });
    this.node.port.onmessage = ({ data }) => this.receive(data);
    this.node.connect(context.destination);
    this.tones = new Map(['connect', 'commit', 'disconnect'].map(kind => [kind, earcon(context.sampleRate, kind)]));
  }

  begin() {
    const group = { id: ++this.number, seq: 0, next: 0, entries: new Map(), pending: [], recent: [], inFlight: 0, buffered: 0 };
    this.group = group;
    return group;
  }

  get playing() { return Boolean(this.group?.started); }
  get active() { return Boolean(this.group?.entries.size); }

  enqueue(group, entry) {
    if (this.group !== group || group.sealed) return;
    const seq = group.seq++;
    group.entries.set(seq, entry);
    group.pending.push(seq);
    this.pump(group);
  }

  pump(group) {
    while (this.group === group && group.pending.length && group.inFlight < 4 &&
        group.buffered < this.context.sampleRate * 12) {
      const seq = group.pending.shift();
      const entry = group.entries.get(seq);
      group.inFlight++;
      void this.session.say(group.id, seq, entry.text, entry.speed, entry.onPcm).then(data => {
        if (this.group !== group) return;
        const rate = this.context.sampleRate;
        const audio = resample(data.audio, data.rate, rate);
        const start = Math.min(audio.length - 1, Math.round(data.start * rate / data.rate));
        const end = Math.max(start + 1, Math.min(audio.length, Math.round(data.end * rate / data.rate)));
        Object.assign(entry, { chunk: { type: 'audio', turn: group.id, seq, audio, start, end }, start, end, size: audio.length });
        group.buffered += audio.length;
      }).catch(error => {
        if (this.group !== group) return;
        entry.failed = true;
        this.onEvent({ type: 'playback-error', message: error.message });
      }).finally(() => {
        if (this.group !== group) return;
        group.inFlight--;
        this.flush(group);
        this.pump(group);
        this.complete(group);
      });
    }
  }

  flush(group) {
    while (group.entries.has(group.next)) {
      const seq = group.next;
      const entry = group.entries.get(seq);
      if (!entry.chunk && !entry.failed) break;
      group.next++;
      if (entry.failed) {
        group.entries.delete(seq);
        continue;
      }
      if (!group.started) {
        group.started = true;
        this.onEvent({ type: 'playback-started' });
      }
      this.node.port.postMessage(entry.chunk, [entry.chunk.audio.buffer]);
      entry.chunk = undefined;
      entry.scheduled = true;
    }
  }

  seal(group) {
    if (this.group !== group) return;
    group.sealed = true;
    this.complete(group);
  }

  complete(group) {
    if (!group.sealed || group.entries.size || this.group !== group) return;
    this.group = undefined;
    this.node?.port.postMessage({ type: 'idle' });
    this.onEvent({ type: 'playback-ended', tailAt: group.tailAt, references: group.recent });
  }

  outputTime(frame) {
    const seconds = frame / this.context.sampleRate;
    const output = this.context.getOutputTimestamp?.();
    if (output?.performanceTime) {
      return performance.timeOrigin + output.performanceTime + (seconds - output.contextTime) * 1000;
    }
    return clock() + (seconds - this.context.currentTime + this.context.baseLatency + (this.context.outputLatency || 0)) * 1000;
  }

  receive(message) {
    const group = this.group;
    if (message.type === 'head') {
      if (group && group.id === message.turn) {
        group.head = message;
      } else if (group) {
        group.head = undefined;
      }
      this.onEvent({ type: 'playback-level', rms: message.rms });
      return;
    }
    if (message.type === 'gain') {
      this.onEvent({ type: 'playback-gain', event: message.event, at: this.outputTime(message.frame) });
      return;
    }
    if (!group || message.turn !== group.id) return;
    if (message.type === 'quiet') {
      if (group.started && ![...group.entries.values()].some(entry => entry.scheduled)) {
        group.started = false;
        this.onEvent({ type: 'playback-silent', tailAt: group.tailAt, references: group.recent });
      }
      return;
    }
    const entry = group.entries.get(message.seq);
    if (message.type === 'audible') {
      if (entry) {
        group.recent.push(entry.text);
        if (group.recent.length > 3) group.recent.shift();
      }
      entry?.onStart?.(this.outputTime(message.frame));
    } else if (message.type === 'voice-end') {
      group.tailAt = this.outputTime(message.frame);
    } else if (message.type === 'gap' && message.frames > this.context.sampleRate * 0.03) {
      this.onEvent({ type: 'playback-gap', ms: message.frames / this.context.sampleRate * 1000 });
    } else if (message.type === 'played' && entry) {
      group.buffered -= entry.size;
      group.entries.delete(message.seq);
      entry.onEnd?.();
      this.pump(group);
      this.complete(group);
    }
  }

  get echoReferences() {
    return this.group?.recent.slice() ?? [];
  }

  get heardFragment() {
    const group = this.group;
    const head = group?.head;
    const entry = group?.entries.get(head?.seq);
    if (!entry) return '';
    const ahead = Math.max(0, this.outputTime(head.frame) - clock());
    const offset = head.offset - Math.round(ahead * this.context.sampleRate / 1000);
    if (offset <= entry.start) return '';
    const ratio = Math.min(1, (offset - entry.start) / (entry.end - entry.start));
    const text = Array.from(entry.text);
    return text.slice(0, Math.max(1, Math.round(text.length * ratio))).join('');
  }

  gain(value, ms, freeze = false, event) {
    this.node?.port.postMessage({ type: 'gain', value, ms, freeze, event });
  }

  tone(kind) {
    const audio = this.tones?.get(kind);
    if (audio) this.node?.port.postMessage({ type: 'tone', audio });
  }

  stop() {
    if (!this.group) return;
    const { id, tailAt, recent } = this.group;
    this.group = undefined;
    this.session.cancel(id);
    this.node?.port.postMessage({ type: 'stop', turn: id });
    this.onEvent({ type: 'playback-ended', tailAt, references: recent });
  }

  close(delay = 0) {
    this.stop();
    const node = this.node;
    const release = () => {
      node?.port.close();
      node?.disconnect();
    };
    if (delay) setTimeout(release, delay);
    else release();
    this.node = this.context = this.tones = undefined;
  }
}
