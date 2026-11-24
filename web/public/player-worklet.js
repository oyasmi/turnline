class SpeechOutput extends AudioWorkletProcessor {
  queue = [];
  tones = [];
  gain = 1;
  target = 1;
  ramp = 0;
  freeze = false;
  clear = false;
  reporting = false;
  level = 0;
  missing = 0;
  nextReport = 0;

  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data.type === 'audio') {
        this.queue.push({ ...data, offset: 0 });
        this.turn = data.turn;
        this.reporting = true;
      } else if (data.type === 'tone') {
        this.tones.push({ audio: data.audio, offset: 0 });
      } else if (data.type === 'gain') {
        this.target = data.value;
        this.ramp = Math.max(1, Math.round(sampleRate * data.ms / 1000));
        this.freeze = data.freeze;
        this.gainEvent = data.event;
      } else if (data.type === 'stop') {
        this.queue = this.queue.filter(chunk => chunk.turn > data.turn || chunk === this.queue[0] && chunk.offset);
        this.clear = this.queue[0]?.turn <= data.turn;
        this.target = this.clear ? 0 : 1;
        this.ramp = this.clear ? Math.round(sampleRate * 0.015) : 0;
        if (!this.clear) this.gain = 1;
        this.freeze = false;
        this.gainEvent = undefined;
        this.missing = 0;
        this.reporting = false;
      } else if (data.type === 'idle') {
        this.gain = this.target = 1;
        this.freeze = false;
        this.ramp = 0;
        this.gainEvent = undefined;
        this.reporting = false;
        this.missing = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];
    let squares = 0;
    for (let i = 0; i < output.length; i++) {
      if (this.ramp) {
        this.gain += (this.target - this.gain) / this.ramp--;
        if (!this.ramp) {
          if (this.gainEvent) this.port.postMessage({ type: 'gain', event: this.gainEvent, frame: currentFrame + i });
          this.gainEvent = undefined;
          if (this.clear) {
            this.queue.shift();
            this.clear = false;
            this.gain = this.target = 1;
          }
        }
      }
      const chunk = this.queue[0];
      const frozen = this.freeze && this.gain <= 0.0001;
      let voice = 0;
      if (chunk && !frozen) {
        if (chunk.offset === 0 && this.missing) {
          this.port.postMessage({ type: 'gap', turn: chunk.turn, frames: this.missing });
          this.missing = 0;
        }
        if (chunk.offset === chunk.start && !this.clear) {
          this.port.postMessage({ type: 'audible', turn: chunk.turn, seq: chunk.seq, frame: currentFrame + i });
        }
        voice = chunk.audio[chunk.offset++] * this.gain;
        if (chunk.offset === chunk.end && !this.clear) {
          this.port.postMessage({ type: 'voice-end', turn: chunk.turn, seq: chunk.seq, frame: currentFrame + i + 1 });
        }
        if (chunk.offset >= chunk.audio.length) {
          this.queue.shift();
          if (this.clear) {
            this.clear = false;
            this.ramp = 0;
            this.gain = this.target = 1;
          } else {
            this.port.postMessage({ type: 'played', turn: chunk.turn, seq: chunk.seq });
          }
        }
      } else if (!chunk && !frozen && this.reporting) {
        this.missing++;
        if (this.missing === Math.round(sampleRate * 0.3)) {
          this.port.postMessage({ type: 'quiet', turn: this.turn });
        }
      }
      squares += voice * voice;
      let tone = 0;
      for (const entry of this.tones) tone += entry.audio[entry.offset++] ?? 0;
      if (this.tones[0]?.offset >= this.tones[0]?.audio.length) this.tones.shift();
      output[i] = voice + tone;
    }
    if (currentFrame >= this.nextReport) {
      const chunk = this.queue[0];
      this.port.postMessage({
        type: 'head', frame: currentFrame + output.length, turn: chunk?.turn, seq: chunk?.seq, offset: chunk?.offset,
        rms: Math.sqrt(squares / output.length),
      });
      this.nextReport = currentFrame + sampleRate * 0.032;
    }
    return true;
  }
}
registerProcessor('speech-output', SpeechOutput);
