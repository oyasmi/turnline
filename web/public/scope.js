const TAU = Math.PI * 2;

export class CallScope {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.motion = matchMedia('(prefers-reduced-motion: reduce)');
    this.phase = 'idle';
    this.levels = { input: 0, output: 0 };
    this.smoothed = { input: 0, output: 0 };
    this.refresh = () => {
      const style = getComputedStyle(canvas);
      this.colors = Object.fromEntries(['tick', 'idle', 'user', 'assistant', 'wait', 'error', 'call-bg', 'call-glow']
        .map(name => [name, style.getPropertyValue('--' + (name.startsWith('call-') ? name : 'scope-' + name)).trim()]));
      this.schedule();
    };
    new MutationObserver(this.refresh).observe(document.documentElement, { attributeFilter: ['data-theme'] });
    new ResizeObserver(() => this.schedule()).observe(canvas);
    this.motion.addEventListener('change', () => this.schedule());
    this.refresh();
  }

  update(phase, yielded, waiting) {
    this.phase = phase;
    this.yielded = yielded;
    this.waiting = waiting;
    this.schedule();
  }

  level(channel, rms) {
    this.levels[channel] = Math.min(1, Math.sqrt(rms * 5));
    this.schedule();
  }

  countdown(remaining) {
    this.remaining = remaining > 0 ? { until: performance.now() + remaining, total: remaining } : undefined;
    this.schedule();
  }

  schedule() {
    if (!this.frame && this.context) this.frame = requestAnimationFrame(time => this.draw(time));
  }

  draw(time) {
    this.frame = undefined;
    const { canvas, context: ctx, colors, phase, yielded, waiting } = this;
    const size = Math.round(canvas.clientWidth * Math.min(2, devicePixelRatio));
    if (!size) return;
    if (canvas.width !== size || canvas.height !== size) canvas.width = canvas.height = size;
    ctx.setTransform(size / 240, 0, 0, size / 240, size / 2, size / 2);
    ctx.clearRect(-120, -120, 240, 240);
    const motion = !this.motion.matches;
    const dt = Math.min(100, time - (this.previous ?? time - 16));
    this.previous = time;
    for (const name of ['input', 'output']) {
      const target = motion ? this.levels[name] : 0;
      const current = this.smoothed[name];
      this.smoothed[name] += (target - current) * (1 - Math.exp(-dt / (target > current ? 30 : 155)));
    }
    const mic = phase === 'recognizing' || phase === 'pausing' || yielded;
    const speaking = phase === 'speaking';
    const role = phase === 'reconnecting' || phase === 'error' ? colors.error :
      phase === 'thinking' || phase === 'preparing' ? colors.wait :
      mic || phase === 'listening' ? colors.user : speaking ? colors.assistant : colors.idle;
    const stroke = (radius, color, width = 1, from = 0, to = TAU) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.arc(0, 0, radius, from, to);
      ctx.stroke();
    };
    const fill = ctx.createRadialGradient(-22, -29, 5, 6, 6, 78);
    fill.addColorStop(0, colors['call-glow']);
    fill.addColorStop(1, colors['call-bg']);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(0, 0, 71, 0, TAU);
    ctx.fill();
    stroke(111, colors.tick, .7);
    stroke(89, colors.tick);
    stroke(70, role, mic ? 1.7 : 1);
    stroke(64, colors.tick, .8);
    ctx.lineCap = 'round';
    for (let index = 0; index < 72; index++) {
      const angle = index * TAU / 72;
      const major = index % 6 === 0;
      const ripple = speaking && motion ? (.35 + .65 * Math.sin(index * .83 + time / 120) ** 2) * this.smoothed.output : 0;
      const begin = 96 - 8 * ripple;
      const end = (major ? 106 : 101) + 8 * ripple;
      ctx.strokeStyle = speaking && (major || ripple > .12) ? colors.assistant : colors.tick;
      ctx.lineWidth = major ? 1.7 : .95;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * begin, Math.sin(angle) * begin);
      ctx.lineTo(Math.cos(angle) * end, Math.sin(angle) * end);
      ctx.stroke();
    }
    const remaining = Math.max(0, this.remaining?.until - time || 0);
    if (remaining && phase === 'pausing') {
      stroke(85, colors.user, 2.5, -Math.PI / 2, (motion ? remaining / this.remaining.total : 1) * TAU - Math.PI / 2);
    } else if (phase === 'thinking' || phase === 'preparing') {
      const angle = motion && (waiting || phase === 'preparing') ? time / (waiting >= 3 ? 310 : 530) : -Math.PI / 2;
      stroke(85, role, 2, angle, angle + Math.PI * .54);
    } else {
      for (const angle of [-Math.PI / 4, 3 * Math.PI / 4]) stroke(85, role, 1.35, angle, angle + .32);
    }
    ctx.strokeStyle = role;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    const level = mic || phase === 'listening' ? this.smoothed.input : speaking ? this.smoothed.output * .35 : 0;
    const shape = [0, 0, 0, -.23, .25, -.78, .79, -.43, .18, 0, 0, 0];
    for (const [index, height] of shape.entries()) {
      const x = (index - 5.5) * 7;
      const y = height * (22 + 30 * level) * (1 + level * .27 * Math.sin(time / 90 + index));
      if (!index) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (motion && (remaining || phase === 'preparing' || phase === 'thinking' && waiting || speaking || mic || level > .02)) this.schedule();
  }
}
