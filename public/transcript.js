import { appendMarkdown } from './markdown.js';

const ns = 'http://www.w3.org/2000/svg';

export class Transcript {
  constructor(messages, empty, actions, scrollButton) {
    this.messages = messages;
    this.empty = empty;
    this.actions = actions;
    this.scrollButton = scrollButton;
    this.hasUnread = false;
    this.timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });
    this.messages.addEventListener('scroll', () => this.syncScrollButton(), { passive: true });
    this.scrollButton?.addEventListener('click', () => this.scroll());
  }

  syncScrollButton() {
    if (!this.scrollButton) return;
    const atBottom = this.following();
    if (atBottom) this.hasUnread = false;
    const scrollable = this.messages.scrollHeight - this.messages.clientHeight > 60;
    this.scrollButton.hidden = atBottom || !scrollable;
    this.scrollButton.querySelector('span').textContent = this.hasUnread ? '有新回复' : '回到底部';
  }

  button(label, icon, action) {
    const button = document.createElement('button');
    button.className = 'button subtle';
    button.type = 'button';
    const image = document.createElementNS(ns, 'svg');
    image.classList.add('icon');
    image.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '/assets/icons.svg#' + icon);
    image.append(use);
    const caption = document.createElement('span');
    caption.textContent = label;
    button.append(image, caption);
    button.onclick = () => action(button, caption);
    return button;
  }

  copyButton(label, getText, className) {
    const button = this.button(label, 'copy', async (_button, caption) => {
      try {
        await navigator.clipboard.writeText(getText());
        caption.textContent = '已复制';
        setTimeout(() => { caption.textContent = label; }, 1400);
      } catch {
        this.actions.error('复制失败。可以选中文字后手动复制。');
      }
    });
    if (className) button.classList.add(className);
    return button;
  }

  add(role, text = '', timestamp = new Date()) {
    const follow = role === 'user' || this.following();
    this.empty.hidden = true;
    const row = document.createElement('article');
    const header = document.createElement('header');
    const who = document.createElement('span');
    const content = document.createElement('div');
    const time = document.createElement('time');
    row.className = 'entry ' + role;
    who.className = 'who';
    who.textContent = role === 'user' ? '你' : role === 'update' ? '会话更新' : '助手';
    content.className = 'content';
    if (Number.isFinite(timestamp?.getTime())) {
      time.dateTime = timestamp.toISOString();
      time.textContent = this.timeFormat.format(timestamp);
      time.hidden = this.lastMinute === time.textContent;
      this.lastMinute = time.textContent;
    } else time.hidden = true;
    header.append(who, time);
    row.append(header, content);
    const display = { row, who, content, text: '', role };
    if (role === 'user') content.textContent = text;
    else {
      const actions = document.createElement('div');
      actions.className = 'entry-actions';
      actions.hidden = true;
      const copy = this.copyButton('复制', () => display.text);
      const replay = this.button('重播', 'play', () => this.actions.replay(display));
      const retry = this.button('重新回答', 'replay', () => this.actions.retry());
      retry.hidden = true;
      actions.append(copy, replay, retry);
      row.append(actions);
      Object.assign(display, { actions, retry });
    }
    this.messages.append(row);
    if (text && role !== 'user') this.update(display, text, false, true);
    if (follow) this.scroll();
    else {
      this.hasUnread = true;
      this.syncScrollButton();
    }
    return display;
  }

  delivery(display, message) {
    if (!display) return;
    if (!message) {
      display.delivery?.remove();
      display.delivery = undefined;
      return;
    }
    if (!display.delivery) {
      display.delivery = document.createElement('span');
      display.delivery.className = 'delivery';
      display.delivery.setAttribute('role', 'status');
      display.who.parentElement.append(display.delivery);
    }
    display.delivery.textContent = message;
  }

  update(display, text, commentary = false, done = false, { level, keepExpanded = false } = {}) {
    const follow = this.following();
    const collapsible = commentary && !keepExpanded && level !== 'error' && level !== 'warning';
    const changed = display.text !== text || display.commentary !== collapsible || display.level !== level;
    display.text = text;
    display.done = done;
    display.commentary = collapsible;
    display.level = level;
    display.row.classList.toggle('commentary', collapsible);
    if (level) display.row.dataset.level = level;
    else delete display.row.dataset.level;
    display.who.textContent = level === 'error'
      ? '提示 · 错误'
      : level === 'warning'
        ? '提示 · 警告'
        : commentary
          ? (keepExpanded ? '过程播报' : '进度')
          : display.role === 'update' ? '会话更新' : '助手';
    display.actions.hidden = collapsible || !text || !done;
    if (changed) this.renderText(display);
    if (collapsible && display.summary) display.summary.textContent = done ? '进度 · 已完成' : '进度 · 进行中';
    if (follow) this.scroll();
    else if (changed) {
      this.hasUnread = true;
      this.syncScrollButton();
    }
  }

  notice(level, text) {
    if (!text?.trim()) return;
    const display = this.add('assistant');
    this.update(display, text, false, true, { level });
    return display;
  }

  renderText(display) {
    const fragment = document.createDocumentFragment();
    display.positions = appendMarkdown(fragment, display.text, (...args) => this.copyButton(...args), display.interruptAt);
    if (display.commentary) {
      if (!display.details) {
        display.details = document.createElement('details');
        display.summary = document.createElement('summary');
        display.details.append(display.summary, display.content);
        display.row.prepend(display.details);
      }
      display.who.parentElement.hidden = true;
    } else if (display.details) {
      display.details.remove();
      display.row.insertBefore(display.content, display.actions);
      display.who.parentElement.hidden = false;
      display.details = undefined;
    }
    display.content.replaceChildren(fragment);
    if (this.active?.display === display) this.highlight(this.active);
  }

  highlight(range) {
    this.active = range;
    if (!window.Highlight || !CSS.highlights) return;
    const spans = [];
    if (range && range.display?.positions) {
      const { start, end, display } = range;
      for (const { node, start: from, end: to } of display.positions) {
        if (to <= start || from >= end) continue;
        const mark = new Range();
        mark.setStart(node, Math.max(0, start - from));
        mark.setEnd(node, Math.min(to, end) - from);
        spans.push(mark);
      }
    }
    if (spans.length) CSS.highlights.set('spoken', new Highlight(...spans));
    else CSS.highlights.delete('spoken');
  }

  interrupted(display, position) {
    if (!display || display.commentary) return;
    display.row.dataset.interrupted = 'true';
    display.interruptAt = position;
    display.actions.hidden = false;
    this.renderText(display);
  }

  retryFor(display) {
    if (this.latest) this.latest.retry.hidden = true;
    this.latest = display;
    if (display) display.retry.hidden = false;
  }

  scroll() {
    this.messages.scrollTop = this.messages.scrollHeight;
    this.hasUnread = false;
    this.syncScrollButton();
  }

  following() {
    return this.messages.scrollHeight - this.messages.clientHeight - this.messages.scrollTop < 40;
  }

  clear() {
    this.retryFor(undefined);
    this.highlight(undefined);
    this.lastMinute = undefined;
    this.hasUnread = false;
    for (const row of this.messages.querySelectorAll('.entry')) row.remove();
    this.empty.hidden = false;
    this.syncScrollButton();
  }
}
