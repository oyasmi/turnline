import { listConversationItems, splitSpeech } from './responses.js';

export function updateSpeech(text) {
  const [heading, ...lines] = text.split('\n');
  if (/^\*\*.+\*\*$/u.test(heading.trim())) {
    const paragraph = lines.find(line => line.trim() && !/^\s*[-*+]\s/u.test(line));
    text = paragraph ?? heading.trim().replace(/`[^`]*`\s*/gu, '').replace(/^[^\p{L}\p{N}]+/u, '');
  }
  return splitSpeech(text, true).phrases[0];
}

// Follow a Pipiclaw conversation from its first item. Foreground SSE messages
// already have a place in the transcript and must never be spoken twice.
export class ConversationUpdates {
  constructor(settings, conversation, canRead, onMessage) {
    this.settings = settings;
    this.conversation = conversation;
    this.canRead = canRead;
    this.onMessage = onMessage;
    this.controller = new AbortController();
    this.foreground = new Set();
    this.schedule(0);
  }

  track(id) {
    if (id) this.foreground.add(id);
  }

  interrupted() {
    // A disconnected stream may have missed its last item id. Show any
    // unmatched messages until the cursor catches up, without autoplay.
    this.uncertain = true;
  }

  stop() {
    this.controller.abort();
    clearTimeout(this.timer);
  }

  schedule(delay) {
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  async poll() {
    const { signal } = this.controller;
    let delay = 1500;
    try {
      if (!this.canRead()) return;
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      const page = await listConversationItems(this.settings, this.conversation, this.after, deadline);
      if (signal.aborted || !this.canRead()) return;
      for (const item of page.data) {
        if (item.status === 'in_progress') return;
        this.after = item.id;
        if (this.foreground.delete(item.id)) continue;
        if (item.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed' || item.phase !== 'final_answer') continue;
        const text = item.content.filter(part => part.type === 'output_text').map(part => part.text).join('\n').trim();
        if (text) this.onMessage(text, !this.uncertain);
      }
      if (page.has_more && page.data.length) delay = 0;
      else this.uncertain = false;
    } catch {
      delay = 5000;
    } finally {
      if (!signal.aborted) this.schedule(delay);
    }
  }
}
