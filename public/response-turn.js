import { clock } from './audio.js';
import { splitSpeech } from './chunker.js';

const TOOL_LABELS = {
  bash: '正在执行命令',
  read: '正在读取文件',
  write: '正在写入文件',
  edit: '正在编辑文件',
  grep: '正在检索内容',
  glob: '正在查找文件',
  find: '正在查找文件',
  web_search: '正在搜索网页',
  web_fetch: '正在读取网页',
  memory_manage: '正在检索记忆',
  session_search: '正在搜索历史',
  subagent: '正在委派子任务',
  event_manage: '正在管理事件',
};

export function describeTool(name) {
  if (!name || typeof name !== 'string') return '正在查询';
  return TOOL_LABELS[name] ?? '正在调用工具';
}

export class ResponseTurn {
  constructor(options, handlers) {
    Object.assign(this, options);
    this.handlers = handlers;
    this.controller = new AbortController();
    this.items = new Map();
    this.tools = new Map();
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
    if (!this.voice || entry.phase === 'commentary') return;
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
    this.handlers.track(item.id);
    if (item.type === 'mcp_call') {
      if (item.status === 'failed' && item.pipiclaw_failure) {
        this.handlers.notice?.('error', item.pipiclaw_failure);
      }
      return;
    }
    if (item.type !== 'message' || item.role !== 'assistant') return;
    const entry = this.entry(key);
    if (entry.done) return;
    entry.done = true;
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

  latestToolLabel() {
    let label;
    for (const value of this.tools.values()) label = value;
    return label;
  }

  event(event) {
    if (typeof event.sequence_number === 'number') this.lastSequence = event.sequence_number;
    const rawKey = event.output_index ?? event.item?.id ?? event.item_id;
    const key = this.generation && rawKey !== undefined ? `${this.generation}:${rawKey}` : rawKey;
    const item = event.item;
    if (event.type === 'response.created') {
      this.measure('created');
      if (event.response?.id) {
        this.responseId = event.response.id;
        if (this.traceItem) this.traceItem.response_id = event.response.id;
      }
    }
    if (event.type.startsWith('response.reasoning') || item?.type === 'reasoning') this.measure('reasoning');
    if (event.type === 'response.queued' || (event.type === 'response.created' && event.response?.status === 'queued')) {
      this.backendQueuedAt ??= clock();
    } else if (event.type === 'response.in_progress' || (event.type === 'response.created' && event.response?.status === 'in_progress')) {
      this.measure('backendQueue', this.backendQueuedAt === undefined ? 0 : clock() - this.backendQueuedAt);
    } else if (event.type === 'response.output_item.added') {
      if (item.type === 'mcp_call' || item.type === 'function_call') {
        this.measure('firstTool');
        const label = describeTool(item.name);
        this.tools.set(key, label);
        this.handlers.tool(true, label);
      }
      if (item.type === 'message' && item.role === 'assistant') {
        this.measure('firstMessage');
        this.handlers.track(item.id);
        const entry = this.entry(key);
        entry.phase = item.phase;
        if (item.pipiclaw_level) entry.level = item.pipiclaw_level;
      }
    } else if (event.type === 'response.output_text.delta') {
      const entry = this.entry(key);
      entry.text += event.delta;
      entry.pendingSpeech += event.delta;
      this.update(entry);
      if (this.settings.reading === 'live') this.drain(entry, false);
    } else if (event.type === 'response.output_item.done') {
      if (this.tools.delete(key)) this.handlers.tool(this.tools.size > 0, this.latestToolLabel());
      this.output(key, item);
    } else if (event.type === 'response.completed') {
      if (event.response?.usage) this.handlers.usage?.(event.response.usage);
      for (const [index, final] of (event.response.output ?? []).entries()) {
        this.output(this.generation ? `${this.generation}:${index}` : index, final);
      }
      return true;
    } else if (event.type === 'response.incomplete' && event.response?.incomplete_details?.reason === 'steered') {
      this.steered = true;
      this.generation += 1;
      this.tools.clear();
      this.handlers.tool(false, undefined);
      this.handlers.steered?.(event.response);
      return false;
    } else if (['error', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type)) {
      throw new Error(event.error?.message ?? event.response?.error?.message ?? '后端在回复完成前结束了请求。');
    }
    return false;
  }

  get answer() {
    return Array.from(this.items.values()).filter(entry => entry.phase !== 'commentary' && entry.text.trim());
  }
}
