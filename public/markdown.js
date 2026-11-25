const inlineSyntax = /`+[^`\n]+`+|!?\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu;
const listItem = /^(\s*)([-+*]|\d+[.)])\s+/;
const fence = /^ {0,3}(`{3,}|~{3,})([^\s`~]*)\s*$/;

function safeLink(value) {
  try {
    const url = new URL(value);
    if (['https:', 'http:', 'mailto:'].includes(url.protocol)) return url.href;
  } catch {}
}

export function appendMarkdown(parent, source, copy, interruptAt) {
  const positions = [];
  let marked = false;
  function marker(target) {
    const flag = document.createElement('span');
    flag.className = 'flag';
    flag.textContent = '在此打断';
    target.append(flag);
    marked = true;
  }
  function text(target, value, start) {
    if (!value) return;
    const end = start + value.length;
    const before = !marked && interruptAt !== undefined ? Math.max(0, Math.min(value.length, interruptAt - start)) : value.length;
    function append(value, start, dim) {
      if (!value) return;
      const node = document.createTextNode(value);
      if (dim) {
        const quiet = document.createElement('span');
        quiet.className = 'unheard';
        quiet.append(node);
        target.append(quiet);
      } else target.append(node);
      positions.push({ node, start, end: start + value.length });
    }
    if (interruptAt === undefined || marked || end < interruptAt) {
      append(value, start, marked);
    } else {
      append(value.slice(0, before), start, false);
      marker(target);
      append(value.slice(before), start + before, true);
    }
  }
  function inline(target, value, start, depth = 0) {
    if (depth >= 5) {
      text(target, value, start);
      return;
    }
    let cursor = 0;
    for (const match of value.matchAll(inlineSyntax)) {
      const [token, label, href, strong, underscoreStrong, emphasis, underscoreEmphasis] = match;
      const at = match.index;
      text(target, value.slice(cursor, at), start + cursor);
      if (token.startsWith('`')) {
        const opening = /^`+/.exec(token)[0].length;
        const closing = /`+$/.exec(token)[0].length;
        if (opening === closing) {
          const code = document.createElement('code');
          text(code, token.slice(opening, -closing), start + at + opening);
          target.append(code);
        } else text(target, token, start + at);
      } else if (label) {
        const url = token.startsWith('!') ? undefined : safeLink(href);
        const link = url ? document.createElement('a') : document.createElement('span');
        if (url) {
          link.href = url;
          link.rel = 'noopener noreferrer';
          link.target = '_blank';
        }
        inline(link, label, start + at + (token.startsWith('!') ? 2 : 1), depth + 1);
        target.append(link);
      } else {
        const bold = strong ?? underscoreStrong;
        const styled = document.createElement(bold ? 'strong' : 'em');
        inline(styled, bold ?? emphasis ?? underscoreEmphasis, start + at + (bold ? 2 : 1), depth + 1);
        target.append(styled);
      }
      cursor = at + token.length;
    }
    text(target, value.slice(cursor), start + cursor);
  }

  let offset = 0;
  const lines = source.split('\n').map(line => {
    const item = { line, offset };
    offset += line.length + 1;
    return item;
  });
  let paragraph;
  let list;
  let quote;
  let code;
  for (const { line, offset } of lines) {
    const opening = fence.exec(line);
    if (code) {
      if (opening && opening[1][0] === code.fence[0] && opening[1].length >= code.fence.length && !opening[2]) {
        code = undefined;
      } else {
        if (code.lines.length) text(code.body, '\n', offset - 1);
        text(code.body, line, offset);
        code.lines.push(line);
      }
      continue;
    }
    const bullet = listItem.exec(line);
    const quoted = /^ {0,3}>\s?/.exec(line);
    if (!bullet) list = undefined;
    if (!quoted) quote = undefined;
    if (!line.trim() || opening || bullet || quoted) paragraph = undefined;
    if (opening) {
      const block = document.createElement('div');
      block.className = 'code-block';
      const header = document.createElement('div');
      header.className = 'code-header';
      const label = document.createElement('span');
      label.textContent = opening[2] || '代码';
      const pre = document.createElement('pre');
      const body = document.createElement('code');
      const raw = [];
      code = { fence: opening[1], body, lines: raw };
      const button = copy('复制代码', () => raw.join('\n'), 'code-copy');
      header.append(label, button);
      pre.append(body);
      block.append(header, pre);
      parent.append(block);
    } else if (bullet) {
      const ordered = /^\d/.test(bullet[2]);
      if (list?.tagName !== (ordered ? 'OL' : 'UL')) {
        list = document.createElement(ordered ? 'ol' : 'ul');
        if (ordered) list.start = Number.parseInt(bullet[2], 10);
        parent.append(list);
      }
      const item = document.createElement('li');
      inline(item, line.slice(bullet[0].length), offset + bullet[0].length);
      list.append(item);
    } else if (quoted) {
      if (!quote) {
        quote = document.createElement('blockquote');
        parent.append(quote);
      }
      const item = document.createElement('p');
      inline(item, line.slice(quoted[0].length), offset + quoted[0].length);
      quote.append(item);
    } else if (line.trim()) {
      if (paragraph) text(paragraph, ' ', offset - 1);
      else {
        paragraph = document.createElement('p');
        parent.append(paragraph);
      }
      inline(paragraph, line, offset);
    }
  }
  if (!marked && interruptAt !== undefined) marker(parent);
  return positions;
}
