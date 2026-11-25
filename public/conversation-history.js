import {
  deleteConversation, getConversation, isConversationId, listConversationIds, listConversationItems,
} from './responses.js';
import { store, stored } from './settings.js';

const PAGE_SIZE = 12;
const storageKey = settings => 'turnline.direct-conversations.v1:' + settings.url;
const titleCache = new Map();

function directIds(settings) {
  try {
    const ids = JSON.parse(stored(storageKey(settings)));
    if (Array.isArray(ids)) return ids.filter(isConversationId);
  } catch {}
  return [];
}

export function rememberConversation(settings, id) {
  if (settings.mode !== 'direct' || !isConversationId(id)) return;
  const ids = directIds(settings);
  if (ids[0] !== id) store(storageKey(settings), JSON.stringify([id, ...ids.filter(other => other !== id)]));
}

export function forgetConversation(settings, id) {
  titleCache.delete(id);
  if (settings.mode !== 'direct' || !isConversationId(id)) return;
  const ids = directIds(settings).filter(other => other !== id);
  store(storageKey(settings), JSON.stringify(ids));
}

export function cacheConversationTitle(id, title) {
  if (isConversationId(id) && typeof title === 'string' && title.trim()) {
    titleCache.set(id, title.trim());
  }
}

export function conversationText(item) {
  return Array.isArray(item?.content)
    ? item.content.map(part => part?.text).filter(text => typeof text === 'string' && text.trim()).join('\n')
    : '';
}

async function historyPage({ settings, after, ids }, signal) {
  if (!ids) return listConversationIds(settings, after, signal);
  const start = after ? ids.indexOf(after) + 1 : 0;
  const end = start + PAGE_SIZE;
  return { data: ids.slice(start, end), has_more: ids.length > end };
}

async function preview(settings, id, signal) {
  const cached = titleCache.get(id);
  if (cached) return cached;
  try {
    const conv = await getConversation(settings, id, signal).catch(error => {
      if ([401, 403, 404].includes(error.status)) throw error;
      return null;
    });
    const metaTitle = conv?.metadata?.title;
    if (typeof metaTitle === 'string' && metaTitle.trim()) {
      titleCache.set(id, metaTitle.trim());
      return metaTitle.trim();
    }
    const { data } = await listConversationItems(settings, id, undefined, signal, 'asc', 4);
    const user = data.find(item => item?.type === 'message' && item.role === 'user' && conversationText(item));
    const text = conversationText(user ?? data.find(item => item?.type === 'message' && conversationText(item)));
    const characters = Array.from(text.replace(/\s+/gu, ' ').trim());
    const title = characters.length > 60 ? characters.slice(0, 60).join('') + '…'
      : characters.join('') || '空白对话 · ' + id.slice(-8);
    if (characters.length) titleCache.set(id, title);
    return title;
  } catch (error) {
    if (signal.aborted || [401, 403, 404].includes(error.status)) return;
    return '会话 · ' + id.slice(-8);
  }
}

export function bindConversationHistory({ settings, current, select, onDeleteCurrent }) {
  const dialog = document.getElementById('conversation-history');
  const list = document.getElementById('conversation-list');
  const status = document.getElementById('conversation-status');
  const more = document.getElementById('more-conversations');
  let activeView;

  function close() {
    activeView?.controller.abort();
    activeView = undefined;
    dialog.close();
  }

  async function choose(view, id) {
    if (view.busy) return;
    view.busy = true;
    more.disabled = true;
    list.inert = true;
    status.textContent = '正在打开会话…';
    try {
      await select(id, view.controller.signal);
      if (!view.controller.signal.aborted) close();
    } catch (error) {
      if (!view.controller.signal.aborted) status.textContent = error.message;
    } finally {
      if (view === activeView) {
        view.busy = false;
        more.disabled = false;
        list.inert = false;
      }
    }
  }

  async function remove(view, id, row) {
    if (view.busy) return;
    view.busy = true;
    more.disabled = true;
    list.inert = true;
    status.textContent = '正在删除会话…';
    try {
      const deadline = AbortSignal.any([view.controller.signal, AbortSignal.timeout(5_000)]);
      await deleteConversation(view.settings, id, deadline);
      if (view.controller.signal.aborted) return;
      forgetConversation(view.settings, id);
      row.remove();
      if (id === current()) onDeleteCurrent?.();
      status.textContent = list.childElementCount ? '' : '暂无可打开的会话。';
    } catch (error) {
      if (!view.controller.signal.aborted) status.textContent = error.message;
    } finally {
      if (view === activeView) {
        view.busy = false;
        more.disabled = false;
        list.inert = false;
      }
    }
  }

  async function load(view) {
    if (!view || view.busy) return;
    view.busy = true;
    more.disabled = true;
    const { signal } = view.controller;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
    status.textContent = '正在加载历史会话…';
    try {
      const { data, has_more: hasMore } = await historyPage(view, deadline);
      const titles = await Promise.all(data.map(id => preview(view.settings, id, deadline)));
      if (signal.aborted) return;
      if (deadline.aborted) throw new Error('加载历史会话超时，请重试。');
      for (const [index, title] of titles.entries()) {
        if (!title) continue;
        const id = data[index];
        const row = document.createElement('li');
        row.className = 'conversation-row';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button ghost conversation-choice';
        const label = document.createElement('span');
        label.textContent = title;
        button.append(label);
        if (id === current()) {
          button.disabled = true;
          button.setAttribute('aria-current', 'true');
          const active = document.createElement('small');
          active.textContent = '当前';
          button.append(active);
        } else {
          button.onclick = () => void choose(view, id);
        }
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'button subtle conversation-delete';
        del.textContent = '删除';
        del.setAttribute('aria-label', '删除会话 ' + title);
        let confirmTimer;
        del.onclick = () => {
          if (!confirmTimer) {
            del.textContent = '确认？';
            del.classList.add('confirming');
            confirmTimer = setTimeout(() => {
              confirmTimer = undefined;
              del.textContent = '删除';
              del.classList.remove('confirming');
            }, 3000);
            return;
          }
          clearTimeout(confirmTimer);
          confirmTimer = undefined;
          void remove(view, id, row);
        };
        row.append(button, del);
        list.append(row);
      }
      view.after = data.at(-1) ?? view.after;
      status.textContent = list.childElementCount ? '' : '暂无可打开的会话。';
      more.textContent = '加载更多';
      more.hidden = !hasMore;
    } catch (error) {
      if (signal.aborted) return;
      status.textContent = error.message;
      more.textContent = '重试';
      more.hidden = false;
    } finally {
      if (view === activeView) {
        view.busy = false;
        more.disabled = false;
      }
    }
  }

  document.getElementById('open-conversations').onclick = () => {
    activeView?.controller.abort();
    const connection = settings();
    activeView = { settings: connection, controller: new AbortController(),
      ids: connection.mode === 'direct' ? directIds(connection) : undefined };
    list.replaceChildren();
    list.inert = false;
    more.hidden = true;
    dialog.showModal();
    void load(activeView);
  };
  document.getElementById('close-conversations').onclick = close;
  more.onclick = () => void load(activeView);
  dialog.oncancel = event => {
    event.preventDefault();
    close();
  };
}
