class MicrophoneFrames extends AudioWorkletProcessor {
  frame = new Int16Array(512);
  index = 0;
  phase = 0;
  sum = 0;
  squares = 0;
  voiceFrames = 0;
  noise = 0.004;

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const stride = sampleRate / 16000;
    for (let i = 0; i < input.length; i++) {
      const sample = input[i];
      let remaining = 1;
      while (remaining > 1e-8) {
        const width = Math.min(remaining, stride - this.phase);
        this.sum += sample * width;
        this.phase += width;
        remaining -= width;
        if (this.phase + 1e-8 < stride) break;

        const value = this.sum / stride;
        this.sum = this.phase = 0;
        this.squares += value * value;
        this.frame[this.index++] = Math.max(-32768, Math.min(32767, Math.round(value * 32768)));
        if (this.index !== this.frame.length) continue;
        const rms = Math.sqrt(this.squares / this.frame.length);
        const voiced = rms > Math.max(0.014, this.noise * 3);
        if (!voiced) this.noise = 0.97 * this.noise + 0.03 * rms;
        this.voiceFrames = voiced ? this.voiceFrames + 1 : 0;
        this.port.postMessage({
          samples: this.frame, rms, fastStart: this.voiceFrames === 2,
          time: (currentFrame + i + 1 - remaining) / sampleRate,
        }, [this.frame.buffer]);
        this.frame = new Int16Array(512);
        this.index = this.squares = 0;
      }
    }
    return true;
  }
}
registerProcessor('microphone-frames', MicrophoneFrames);
