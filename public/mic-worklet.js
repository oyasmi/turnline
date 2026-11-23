class MicrophoneFrames extends AudioWorkletProcessor {
  frame = new Float32Array(512);
  index = 0;

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      this.frame[this.index++] = sample;
      if (this.index === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(512);
        this.index = 0;
      }
    }
    // The output remains silent. Connecting the node keeps capture running.
    return true;
  }
}
registerProcessor('microphone-frames', MicrophoneFrames);
