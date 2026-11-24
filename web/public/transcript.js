export class Transcript {
  constructor(messages, empty) {
    this.messages = messages;
    this.empty = empty;
  }

  add(role, text = '', draft = false) {
    const follow = role === 'user' && !draft || this.following();
    this.empty.hidden = true;
    const row = document.createElement('article');
    const who = document.createElement('span');
    const content = document.createElement('p');
    const flag = document.createElement('span');
    row.className = 'entry ' + role + (draft ? ' draft' : '');
    if (draft) row.setAttribute('aria-hidden', 'true');
    who.className = 'who';
    who.textContent = role === 'user' ? '你' : role === 'update' ? '会话更新' : '助手';
    content.className = 'content';
    content.textContent = text;
    flag.className = 'flag';
    flag.textContent = '已打断';
    row.append(who, content, flag);
    this.messages.append(row);
    if (follow) this.scroll();
    return { row, who, content };
  }

  scroll() {
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  following() {
    return this.messages.scrollHeight - this.messages.clientHeight - this.messages.scrollTop < 40;
  }

  clearDraft() {
    this.draft?.row.remove();
    this.draft = undefined;
    this.empty.hidden = Boolean(this.messages.querySelector('.entry'));
  }

  showDraft(text, remaining) {
    if (!text) return;
    const follow = this.following();
    this.draft ??= this.add('user', '', true);
    this.draft.content.textContent = text;
    this.draft.row.classList.toggle('tentative', remaining !== undefined);
    if (remaining !== undefined) {
      this.draft.content.style.setProperty('--wait', Math.max(0, remaining) + 'ms');
      const progress = this.draft.progress ??= document.createElement('span');
      progress.className = 'draft-progress';
      progress.setAttribute('aria-hidden', 'true');
      progress.remove();
      this.draft.content.append(progress);
    }
    if (follow) this.scroll();
  }

  finalizeDraft(text) {
    const display = this.draft ?? this.add('user');
    this.draft = undefined;
    display.row.className = 'entry user';
    display.row.removeAttribute('aria-hidden');
    display.content.textContent = text;
    return display;
  }

  resumeDraft() {
    this.draft?.row.classList.remove('tentative');
    this.draft?.progress?.remove();
  }

  clear() {
    this.draft = undefined;
    for (const row of this.messages.querySelectorAll('.entry')) row.remove();
    this.empty.hidden = false;
  }
}
