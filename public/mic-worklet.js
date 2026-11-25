import { CaptureResampler } from './resampler.js';

class MicrophoneFrames extends AudioWorkletProcessor {
  frame = new Int16Array(512);
  index = 0;
  squares = 0;
  voiceFrames = 0;
  noise = 0.004;
  resampler = new CaptureResampler(sampleRate, 16000);

  collect = (value, position) => {
    this.squares += value * value;
    this.frame[this.index++] = Math.max(-32768, Math.min(32767, Math.round(value * 32768)));
    if (this.index !== this.frame.length) return;
    const rms = Math.sqrt(this.squares / this.frame.length);
    const voiced = rms > Math.max(0.014, this.noise * 3);
    if (!voiced) this.noise = 0.97 * this.noise + 0.03 * rms;
    this.voiceFrames = voiced ? this.voiceFrames + 1 : 0;
    this.port.postMessage({
      samples: this.frame, rms, fastStart: this.voiceFrames === 2,
      time: (this.origin + position) / sampleRate,
    }, [this.frame.buffer]);
    this.frame = new Int16Array(512);
    this.index = this.squares = 0;
  };

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    if (this.origin === undefined || currentFrame !== this.origin + this.resampler.input) {
      this.origin = currentFrame;
      if (this.resampler.input) this.resampler = new CaptureResampler(sampleRate, 16000);
      this.index = this.squares = this.voiceFrames = 0;
    }
    for (const sample of input) this.resampler.push(sample, this.collect);
    return true;
  }
}
registerProcessor('microphone-frames', MicrophoneFrames);
