// Phase interpolation is quantized to 1/96 source sample. The Blackman window
// limits aliasing and imaging with a small, fixed convolution per output sample.
const PHASES = 96;

function kernel(sourceRate, targetRate, radius) {
  const cutoff = .46 * Math.min(1, targetRate / sourceRate);
  return Array.from({ length: PHASES + 1 }, (_, phase) => {
    const weights = new Float32Array(2 * radius);
    let sum = 0;
    for (let n = 0; n < weights.length; n++) {
      const x = n - radius + 1 - phase / PHASES;
      const angle = 2 * Math.PI * cutoff * x;
      const window = .42 + .5 * Math.cos(Math.PI * x / radius) + .08 * Math.cos(2 * Math.PI * x / radius);
      weights[n] = 2 * cutoff * (angle ? Math.sin(angle) / angle : 1) * window;
      sum += weights[n];
    }
    for (let n = 0; n < weights.length; n++) weights[n] /= sum;
    return weights;
  });
}

const outputKernels = new Map();
export function resample(input, sourceRate, targetRate) {
  if (sourceRate === targetRate || !input.length) return input;
  const radius = Math.max(16, Math.ceil(12 * sourceRate / targetRate));
  const key = sourceRate + ':' + targetRate;
  if (!outputKernels.has(key)) outputKernels.set(key, kernel(sourceRate, targetRate, radius));
  const table = outputKernels.get(key);
  const output = new Float32Array(Math.max(1, Math.round(input.length * targetRate / sourceRate)));
  for (let index = 0; index < output.length; index++) {
    const at = index * sourceRate / targetRate;
    const center = Math.floor(at);
    const weights = table[Math.round((at - center) * PHASES)];
    let sample = 0;
    for (let n = 0; n < weights.length; n++) {
      const offset = Math.max(0, Math.min(input.length - 1, center - radius + 1 + n));
      sample += input[offset] * weights[n];
    }
    output[index] = sample;
  }
  return output;
}

export class CaptureResampler {
  constructor(sourceRate, targetRate) {
    this.sourceRate = sourceRate;
    this.targetRate = targetRate;
    this.radius = sourceRate === targetRate ? 0 : Math.max(16, Math.ceil(12 * sourceRate / targetRate));
    this.table = this.radius ? kernel(sourceRate, targetRate, this.radius) : null;
    this.ring = new Float32Array(2 * this.radius + 1);
    this.input = 0;
    this.output = 0;
  }

  push(sample, emit) {
    const at = this.input++;
    if (!this.table) {
      emit(sample, at + 1);
      return;
    }
    const { ring, radius } = this;
    ring[at % ring.length] = sample;
    while (true) {
      const position = this.output * this.sourceRate / this.targetRate;
      const center = Math.floor(position);
      if (center + radius > at) break;
      const weights = this.table[Math.round((position - center) * PHASES)];
      let value = 0;
      for (let n = 0; n < weights.length; n++) {
        const offset = Math.max(0, center - radius + 1 + n);
        value += ring[offset % ring.length] * weights[n];
      }
      this.output++;
      emit(value, position + this.sourceRate / this.targetRate);
    }
  }
}
