import { clock } from './audio.js';
import { splitSpeech } from './chunker.js';
import { WorkActivity } from './work-activity.js';

export { describeTool } from './work-activity.js';

export class ResponseTurn {
  constructor(options, handlers) {
    Object.assign(this, options);
    this.handlers = handlers;
    this.controller = new AbortController();
    this.items = new Map();
    this.activity = new WorkActivity();
    this.heard = [];
    this.gaps = 0;
    this.ended = false;
    this.responseId = undefined;
    this.lastSequence = undefined;
    this.generation = 0;
  }

  entry(key) {
    if (!this.items.has(key)) this.items.set(key, { text: '', pendingSpeech: '' });
    return this.items.get(key);
  }

  measure(name, value = clock() - this.sentAt) {
    this.milestones ??= new Set();
    if (this.milestones.has(name)) return;
    this.milestones.add(name);
    this.handlers.metric(name, value);
  }

  update(entry) {
    if (!entry.text.trim()) return;
    entry.firstTextAt ??= clock();
    if (entry.phase !== 'commentary') this.measure('text', entry.firstTextAt - this.sentAt);
    this.handlers.text(entry);
  }

  drain(entry, finish) {
    if (!this.voice || this.speechSuppressed || entry.phase === 'commentary') return;
    const offset = entry.text.length - entry.pendingSpeech.length;
    const split = splitSpeech(entry.pendingSpeech, finish, !this.firstSpeakable, true);
    entry.pendingSpeech = split.rest;
    for (const [index, phrase] of split.phrases.entries()) {
      entry.spoken = true;
      const range = split.ranges[index];
      this.handlers.enqueue(phrase, {
        display: entry.display, start: range.start + offset, end: range.end + offset,
        offsets: range.offsets.map(position => position + offset),
      }, entry.firstTextAt);
    }
  }

  output(key, item) {
    if (item.type === 'mcp_call' || item.type === 'function_call') {
      this.updateTool(key, item);
      return;
    }
    if (item.type === 'reasoning') {
      this.activity.summary(item.id ?? key, item.summary?.map(part => part.text).join('\n'));
      this.handlers.activity?.();
      return;
    }
    this.handlers.track(item.id);
    if (item.type !== 'message' || item.role !== 'assistant') return;
    const entry = this.entry(key);
    if (entry.done) return;
    entry.done = true;
    entry.id ??= item.id;
    entry.phase = item.phase ?? entry.phase;
    entry.level = item.pipiclaw_level ?? entry.level;
    if (entry.phase === 'commentary' && entry.spoken) entry.spokenAsCommentary = true;
    const spokenPrefix = entry.text.slice(0, entry.text.length - entry.pendingSpeech.length);
    const finalText = item.content?.filter(part => part.type === 'output_text').map(part => part.text).join('\n');
    entry.text = finalText || entry.text;
    this.update(entry);
    if (this.settings.reading === 'confirmed' || !entry.spoken) entry.pendingSpeech = entry.text;
    else if (entry.text.startsWith(spokenPrefix)) entry.pendingSpeech = entry.text.slice(spokenPrefix.length);
    else entry.pendingSpeech = '';
    this.drain(entry, true);
  }

  updateTool(key, item) {
    this.measure('firstTool');
    const record = this.activity.tool(item.id ?? key, item, this.activityClock ?? clock());
    if (item.pipiclaw_failure && !record.noticed) {
      this.handlers.notice?.('error', item.pipiclaw_failure);
      record.noticed = true;
    }
    this.updateActivity();
  }

  updateActivity() {
    const running = this.activity.running;
    this.handlers.tool(Boolean(running), running?.label);
    this.handlers.activity?.();
  }

  event(event) {
    this.activityClock = Number.isFinite(event.turnline_elapsed_ms)
      ? this.startedAt + event.turnline_elapsed_ms
      : clock();
    if (typeof event.sequence_number === 'number') this.lastSequence = event.sequence_number;
    const rawKey = event.output_index ?? event.item?.id ?? event.item_id;
    const key = this.generation && rawKey !== undefined ? `${this.generation}:${rawKey}` : rawKey;
    const item = event.item;
    if (event.type === 'response.created') {
      this.responseStatus = event.response?.status;
      this.measure('created');
      if (event.response?.id) {
        this.responseId = event.response.id;
        if (this.traceItem) this.traceItem.response_id = event.response.id;
      }
    }
    if (event.type.startsWith('response.reasoning') || item?.type === 'reasoning') this.measure('reasoning');
    if (event.type === 'response.queued' || (event.type === 'response.created' && event.response?.status === 'queued')) {
      this.responseStatus = 'queued';
      this.backendQueuedAt ??= clock();
    } else if (event.type === 'response.in_progress' || (event.type === 'response.created' && event.response?.status === 'in_progress')) {
      this.responseStatus = 'in_progress';
      this.measure('backendQueue', this.backendQueuedAt === undefined ? 0 : clock() - this.backendQueuedAt);
    } else if (event.type === 'response.output_item.added') {
      if (item.type === 'mcp_call' || item.type === 'function_call') {
        this.updateTool(key, item);
      }
      if (item.type === 'message' && item.role === 'assistant') {
        this.measure('firstMessage');
        const entry = this.entry(key);
        entry.id = item.id;
        entry.phase = item.phase;
        if (item.pipiclaw_level) entry.level = item.pipiclaw_level;
      }
    } else if (event.type === 'response.output_text.delta') {
      const entry = this.entry(key);
      entry.text += event.delta;
      entry.pendingSpeech += event.delta;
      this.update(entry);
      if (this.settings.reading === 'live') this.drain(entry, false);
    } else if (event.type === 'response.mcp_call_arguments.done') {
      this.updateTool(key, { id: event.item_id, arguments: event.arguments });
    } else if (event.type.startsWith('response.mcp_call.')) {
      this.updateTool(key, { id: event.item_id, status: event.type.split('.').at(-1) });
    } else if (event.type === 'response.reasoning_summary_text.done') {
      this.activity.summary(event.item_id ?? key, event.text);
      this.handlers.activity?.();
    } else if (event.type === 'response.output_item.done') {
      this.output(key, item);
    } else if (event.type === 'response.completed' || event.turnline_continues) {
      if (event.response?.usage) this.handlers.usage?.(event.response.usage);
      for (const [index, final] of (event.response?.output ?? []).entries()) {
        this.output(this.generation ? `${this.generation}:${index}` : index, final);
      }
      if (!event.turnline_continues) return true;
      this.advance();
      return false;
    } else if (event.type === 'response.incomplete' && event.response?.incomplete_details?.reason === 'steered') {
      this.advance();
      return false;
    } else if (['error', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type)) {
      const error = new Error(event.error?.message ?? event.message ?? event.response?.error?.message ?? '后端在回复完成前结束了请求。');
      error.status = event.status;
      error.code = event.error?.code;
      throw error;
    }
    return false;
  }

  advance() {
    this.generation += 1;
    this.responseStatus = undefined;
    this.activity.finish(this.activityClock ?? clock());
    this.updateActivity();
  }

  get answer() {
    return Array.from(this.items.values()).filter(entry => entry.phase !== 'commentary' && entry.text.trim());
  }
}
