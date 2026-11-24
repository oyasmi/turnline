const hiddenSpeech = /`{3}[\s\S]*?(?:`{3}|$)|!\[[^\]\n]*\]\([^)]*(?:\)|$)|(?<=\])\([^)]*(?:\)|$)|https?:\/\/[^\s，。！？]+/gu;

function visibleSpeech(text) {
  return text.replace(hiddenSpeech, match => ' '.repeat(match.length))
    .replace(/^[ \t]*\d+\.\s/gm, match => ' '.repeat(match.length));
}

function openingEnd(text) {
  const visible = visibleSpeech(text);
  const tokens = /\p{Script=Han}|[A-Za-z][A-Za-z0-9]*(?:[.'’_-][A-Za-z0-9]+)*|\d+(?:[.,]\d+)*(?:[ \t]*(?:[%％]|[KMGT]B\b))?|[\p{L}\p{N}]/gu;
  const words = [...visible.matchAll(tokens)];
  let characters = 0;
  let han = 0;
  let latin = 0;
  let previousEnd = 0;
  for (const [index, match] of words.entries()) {
    const end = match.index + match[0].length;
    characters += (match[0].match(/[\p{L}\p{N}]/gu) ?? []).length;
    if (/\p{Script=Han}/u.test(match[0])) han++;
    else if (/^[A-Za-z]/u.test(match[0])) latin++;
    const gap = visible.slice(end, words[index + 1]?.index ?? visible.length);
    const complete = /[。！？!?；;]|\.(?=\s)/u.exec(gap);
    if (complete && words[index + 1]) return end + complete.index + complete[0].length;
    if (han >= 6 || latin >= 3) {
      const pause = /[。！？!?；;\n，、：]+|,(?!\d)|\.(?=\s|$)/u.exec(gap);
      if (pause && !(pause[0] === '.' && /\d$/.test(match[0]) && !gap.slice(pause.index + 1))) {
        return end + pause.index + pause[0].length;
      }
    }
    if (characters >= 14) {
      // A final Latin token, number, or dangling decimal can still grow in a later delta.
      if (/^[.'’_-]?$/u.test(gap) && /[A-Za-z0-9]$/u.test(match[0])) return previousEnd;
      return end;
    }
    if (han >= 6 || latin >= 3) previousEnd = end;
  }
  return 0;
}

function appendSpeech(phrases, ranges, source, offset) {
  // Track the source offsets even when links, code blocks, or whitespace are omitted.
  let raw = '';
  const positions = [];
  let cursor = 0;
  const append = (text, start) => {
    raw += text;
    if (ranges) for (let index = 0; index < text.length; index++) positions.push(offset + start + index);
  };
  for (const match of source.matchAll(hiddenSpeech)) {
    append(source.slice(cursor, match.index), cursor);
    if (!(source[match.index - 1] === ']' && match[0].startsWith('('))) append(' ', match.index);
    cursor = match.index + match[0].length;
  }
  append(source.slice(cursor), cursor);
  const paragraph = raw.endsWith('\n\n');
  let from = raw.length - raw.trimStart().length;
  const last = raw.trimEnd().length;
  const push = (end, suffix = '') => {
    const phrase = raw.slice(from, end);
    if (!/[\p{L}\p{N}]/u.test(phrase)) return;
    phrases.push(phrase + suffix);
    ranges?.push({ start: positions[from], end: positions[end - 1] + 1, offsets: positions.slice(from, end) });
  };
  while (last - from > (paragraph ? 126 : 128)) {
    const space = raw.lastIndexOf(' ', from + 128);
    let end = space >= from + 64 ? space : from + 128;
    if (/[\uD800-\uDBFF]/u.test(raw[end - 1])) end--;
    push(end);
    from = end + (/^\s*/u.exec(raw.slice(end))[0].length);
  }
  if (from < last) push(last, paragraph ? '\n\n' : '');
}

export function splitSpeech(text, flush = false, opening = false, mapped = false) {
  const phrases = [];
  const ranges = mapped ? [] : undefined;
  const result = () => mapped ? { phrases, rest, ranges } : { phrases, rest };
  let rest = text;
  if (opening && !flush) {
    const end = openingEnd(rest);
    if (!end) return result();
    appendSpeech(phrases, ranges, rest.slice(0, end), text.length - rest.length);
    rest = rest.slice(end);
  }
  while (rest) {
    const visible = visibleSpeech(rest);
    const sentence = /[。！？!?；;\n]+|\.\s+/u.exec(visible);
    let end = sentence ? sentence.index + sentence[0].length : 0;
    if ((!end || end > 80) && visible.trimStart().length >= 64) {
      const start = visible.length - visible.trimStart().length;
      const soft = Math.max(visible.lastIndexOf('，', start + 63), visible.lastIndexOf('、', start + 63),
        visible.lastIndexOf(' ', start + 63));
      end = soft >= start + 24 ? soft + 1 : start + 64;
      if (end === start + 64 && /[A-Za-z0-9._-]/u.test(visible[end] ?? '')) {
        const name = /[A-Za-z0-9]+(?:['’._-][A-Za-z0-9]+)*['’._-]?$/u.exec(visible.slice(start, end));
        if (name && name.index >= 24) end = start + name.index;
      }
    }
    const fence = rest.indexOf('```');
    if (fence >= 0 && (!end || fence < end)) {
      const close = rest.indexOf('```', fence + 3);
      if (close < 0 && !flush) break;
      if (end && close >= end) end = close + 3;
    }
    if (!end && flush) end = rest.length;
    if (!end) break;
    appendSpeech(phrases, ranges, rest.slice(0, end), text.length - rest.length);
    rest = rest.slice(end);
  }
  return result();
}
