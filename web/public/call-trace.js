const STORAGE = 'turnline.call-timing.v1';
const MAX_TURNS = 200;
const rounded = value => Math.max(0, Math.round(value));

export class CallTrace {
  constructor(storage, output) {
    this.storage = storage;
    this.output = output;
    try {
      const saved = JSON.parse(storage.getItem(STORAGE));
      if (saved?.version === 1 && Array.isArray(saved.turns)) this.trace = saved;
    } catch {}
  }

  start(at) {
    this.trace = { version: 1, started_at: new Date().toISOString(), turns: [] };
    this.started = at;
    this.save();
  }

  callMetric(name, value) {
    if (this.started === undefined) return;
    this.trace[name] = rounded(value);
    this.save();
  }

  reconnect() {
    if (this.started === undefined) return;
    this.trace.reconnects = (this.trace.reconnects ?? 0) + 1;
    this.save();
  }

  begin(at, source) {
    if (this.started === undefined) return;
    const item = { offset_ms: rounded(at - this.started), source, outcome: 'pending', timing_ms: {} };
    if (this.trace.turns.length >= MAX_TURNS) this.trace.turns.shift();
    this.trace.turns.push(item);
    this.save();
    return item;
  }

  metric(item, name, value) {
    if (!item || !Number.isFinite(value)) return;
    item.timing_ms[name] = rounded(value);
    if (['audio', 'perceived', 'bargeDuck', 'bargePause', 'bargeStop'].includes(name)) this.save();
  }

  finish(item, outcome, duration) {
    if (!item || item.outcome !== 'pending') return;
    item.outcome = outcome;
    item.duration_ms = rounded(duration);
    this.save();
  }

  stop(at) {
    if (this.started === undefined) return;
    this.trace.duration_ms = rounded(at - this.started);
    this.started = undefined;
    this.save();
  }

  save() {
    if (this.trace) {
      try { this.storage.setItem(STORAGE, JSON.stringify(this.trace)); } catch {}
    }
    this.output(this.trace?.turns.length ?? 0, this.available);
  }

  get available() {
    return Boolean(this.trace?.turns.length || this.trace?.click_to_ready_ms !== undefined);
  }

  download() {
    if (!this.available) return;
    this.save();
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.trace, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'turnline-' + this.trace.started_at.replace(/[:.]/g, '-') + '.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
