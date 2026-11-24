// Silence detection yields segments; a short unfinished lead-in gets one chance to continue.
export class VoiceTurn {
  constructor(deliver, changed, schedule = (task, delay) => setTimeout(task, delay), cancel = timer => clearTimeout(timer)) {
    Object.assign(this, { deliver, changed, schedule, cancel });
  }

  get waiting() { return Boolean(this.pending); }

  started() {
    if (this.pending) this.cancel(this.timer);
  }

  accept(text, timing) {
    const previous = this.pending;
    this.reset();
    if (previous) {
      this.deliver(previous.text.replace(/[。．.，,、… ]+$/u, '') + '，' + text, {
        ...timing, asrMs: previous.timing.asrMs + timing.asrMs,
      });
      return;
    }
    if (text.length <= 18 && /(?:现在|然后|比如|就是|就是说|也就是说|我想问一下|帮我看一下)[。．，,、… ]*$/u.test(text)) {
      this.pending = { text, timing };
      this.timer = this.schedule(() => this.finish(), 620);
      this.changed();
      return;
    }
    this.deliver(text, timing);
  }

  finish() {
    const pending = this.pending;
    this.reset();
    if (pending) this.deliver(pending.text, pending.timing);
  }

  reset() {
    this.cancel(this.timer);
    this.pending = undefined;
    this.timer = undefined;
  }
}
