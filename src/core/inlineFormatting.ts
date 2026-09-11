export type InlineMark = 'bold' | 'italic' | 'strike' | 'code';
export type InlineMarker = '**' | '*' | '~~' | '`';
export type MarkAction = 'toggle' | 'add' | 'remove';
export type MarkState = 'inactive' | 'active' | 'mixed';

interface LinkInfo {
  destination: string;
}

interface InlineChar {
  char: string;
  raw: string;
  from: number;
  to: number;
  marks: Set<InlineMark>;
  protected: boolean;
  link?: LinkInfo;
  outputFrom?: number;
  outputTo?: number;
}

export interface ToggleResult {
  next: string;
  selectionStart: number;
  selectionEnd: number;
  changed: boolean;
}

interface ToggleOptions {
  scope?: 'selection' | 'all';
  action?: MarkAction;
}

function markFor(marker: InlineMarker): InlineMark {
  if (marker === '**') return 'bold';
  if (marker === '*') return 'italic';
  if (marker === '~~') return 'strike';
  return 'code';
}

function copyMarks(marks: Set<InlineMark>, add?: InlineMark): Set<InlineMark> {
  const next = new Set(marks);
  if (add) next.add(add);
  return next;
}

function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function findClosing(source: string, start: number, end: number, delimiter: string): number {
  for (let i = start; i <= end - delimiter.length; i++) {
    if (!isEscaped(source, i) && source.startsWith(delimiter, i)) return i;
  }
  return -1;
}

function findTagEnd(source: string, start: number, end: number): number {
  for (let i = start; i < end; i++) {
    if (source[i] === '>' && !isEscaped(source, i)) return i;
  }
  return -1;
}

function findLink(source: string, start: number, end: number): { labelEnd: number; close: number; destination: string } | null {
  let labelEnd = -1;
  for (let i = start + 1; i < end; i++) {
    if (source[i] === ']' && !isEscaped(source, i)) { labelEnd = i; break; }
    if (source[i] === '\n') return null;
  }
  if (labelEnd < 0 || source[labelEnd + 1] !== '(') return null;
  let depth = 1;
  for (let i = labelEnd + 2; i < end; i++) {
    if (isEscaped(source, i)) continue;
    if (source[i] === '(') depth++;
    if (source[i] === ')' && --depth === 0) {
      return { labelEnd, close: i, destination: source.slice(labelEnd + 2, i) };
    }
  }
  return null;
}

function pushChar(
  chars: InlineChar[],
  source: string,
  from: number,
  to: number,
  marks: Set<InlineMark>,
  protectedText: boolean,
  link?: LinkInfo,
): void {
  chars.push({
    char: source.slice(from, to),
    raw: source.slice(from, to),
    from,
    to,
    marks: new Set(marks),
    protected: protectedText,
    link,
  });
}

function parseRange(
  source: string,
  start: number,
  end: number,
  inherited: Set<InlineMark>,
  link: LinkInfo | undefined,
  chars: InlineChar[],
): void {
  let i = start;
  while (i < end) {
    if (source[i] === '\\' && i + 1 < end) {
      pushChar(chars, source, i + 1, i + 2, inherited, inherited.has('code'), link);
      chars[chars.length - 1].raw = source.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (source[i] === '`' && !isEscaped(source, i)) {
      let run = 1;
      while (source[i + run] === '`') run++;
      const delimiter = '`'.repeat(run);
      const close = findClosing(source, i + run, end, delimiter);
      if (close >= 0) {
        const codeMarks = copyMarks(inherited, 'code');
        for (let p = i + run; p < close; p++) pushChar(chars, source, p, p + 1, codeMarks, true, link);
        i = close + run;
        continue;
      }
    }

    if (source[i] === '<' && !isEscaped(source, i)) {
      const close = source.startsWith('<!--', i) ? source.indexOf('-->', i + 4) + 2 : findTagEnd(source, i + 1, end);
      if (close >= i) {
        pushChar(chars, source, i, close + 1, inherited, true, link);
        i = close + 1;
        continue;
      }
    }

    if (source[i] === '$' && !isEscaped(source, i)) {
      const run = source[i + 1] === '$' ? 2 : 1;
      const delimiter = '$'.repeat(run);
      const close = findClosing(source, i + run, end, delimiter);
      if (close > i + run) {
        pushChar(chars, source, i, close + run, inherited, true, link);
        i = close + run;
        continue;
      }
    }

    const imageMatch = source[i] === '!' && source[i + 1] === '[' && !isEscaped(source, i)
      ? findLink(source, i + 1, end)
      : null;
    if (imageMatch) {
      pushChar(chars, source, i, imageMatch.close + 1, inherited, true, link);
      i = imageMatch.close + 1;
      continue;
    }

    const linkMatch = source[i] === '[' && !isEscaped(source, i) ? findLink(source, i, end) : null;
    if (linkMatch) {
      const nestedLink = { destination: linkMatch.destination };
      parseRange(source, i + 1, linkMatch.labelEnd, inherited, nestedLink, chars);
      i = linkMatch.close + 1;
      continue;
    }

    let delimiter: string | null = null;
    let marks: InlineMark[] = [];
    if (source.startsWith('***', i) || source.startsWith('___', i)) {
      delimiter = source.slice(i, i + 3);
      marks = ['bold', 'italic'];
    } else if (source.startsWith('~~', i)) {
      delimiter = '~~';
      marks = ['strike'];
    } else if (source.startsWith('**', i) || source.startsWith('__', i)) {
      delimiter = source.slice(i, i + 2);
      marks = ['bold'];
    } else if ((source[i] === '*' || source[i] === '_') && source[i + 1] !== source[i]) {
      delimiter = source[i];
      marks = ['italic'];
    }
    if (delimiter && !isEscaped(source, i)) {
      const close = findClosing(source, i + delimiter.length, end, delimiter);
      if (close > i + delimiter.length) {
        const nested = new Set(inherited);
        marks.forEach((mark) => nested.add(mark));
        parseRange(source, i + delimiter.length, close, nested, link, chars);
        i = close + delimiter.length;
        continue;
      }
    }

    pushChar(chars, source, i, i + 1, inherited, inherited.has('code'), link);
    i++;
  }
}

function structuralRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines = source.split('\n');
  let offset = 0;
  let fence: { char: string; length: number } | null = null;
  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      ranges.push([offset, offset + line.length]);
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length) fence = null;
    } else if (fenceMatch) {
      ranges.push([offset, offset + line.length]);
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
    } else {
      const prefix = /^\s{0,3}(?:#{1,6}\s+|>\s?|(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/.exec(line);
      if (prefix) ranges.push([offset, offset + prefix[0].length]);
      if (/^\s{0,3}(?:(?:-{3,})|(?:\*{3,})|(?:_{3,}))\s*$/.test(line)) ranges.push([offset, offset + line.length]);
      if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line)) ranges.push([offset, offset + line.length]);
    }
    offset += line.length + 1;
  }
  return ranges;
}

function fencedRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines = source.split('\n');
  let offset = 0;
  let start = -1;
  let fence: { char: string; length: number } | null = null;
  for (const line of lines) {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!fence && match) {
      start = offset;
      fence = { char: match[1][0], length: match[1].length };
    } else if (fence && match && match[1][0] === fence.char && match[1].length >= fence.length) {
      ranges.push([start, offset + line.length]);
      start = -1;
      fence = null;
    }
    offset += line.length + 1;
  }
  if (fence && start >= 0) ranges.push([start, source.length]);
  return ranges;
}

function pushProtectedRange(chars: InlineChar[], source: string, start: number, end: number): void {
  for (let i = start; i < end; i++) pushChar(chars, source, i, i + 1, new Set(), true);
}

function parse(source: string): InlineChar[] {
  const chars: InlineChar[] = [];
  let cursor = 0;
  for (const [start, end] of fencedRanges(source)) {
    parseRange(source, cursor, start, new Set(), undefined, chars);
    pushProtectedRange(chars, source, start, end);
    cursor = end;
  }
  parseRange(source, cursor, source.length, new Set(), undefined, chars);
  for (const [start, end] of structuralRanges(source)) {
    for (const char of chars) {
      if (char.from < end && char.to > start) {
        char.protected = true;
        char.marks.clear();
      }
    }
  }
  for (const char of chars) {
    if (char.char === '|') {
      char.protected = true;
      char.marks.clear();
    }
  }
  return chars;
}

function sameMarks(a: Set<InlineMark>, b: Set<InlineMark>): boolean {
  if (a.size !== b.size) return false;
  for (const mark of a) if (!b.has(mark)) return false;
  return true;
}

function wrapText(text: string, marks: Set<InlineMark>): string {
  const meaningful = text.trim();
  if (!meaningful || marks.size === 0) return text;
  const leading = text.slice(0, text.indexOf(meaningful));
  const trailing = text.slice(text.indexOf(meaningful) + meaningful.length);
  let out = meaningful;
  if (marks.has('code')) out = '`' + out + '`';
  const bold = marks.has('bold');
  const italic = marks.has('italic');
  if (bold && italic) out = '***' + out + '***';
  else if (bold) out = '**' + out + '**';
  else if (italic) out = '*' + out + '*';
  if (marks.has('strike')) out = '~~' + out + '~~';
  return leading + out + trailing;
}

function serializeGroup(chars: InlineChar[], outputOffset = 0): string {
  let out = '';
  let i = 0;
  while (i < chars.length) {
    let j = i + 1;
    while (j < chars.length && sameMarks(chars[i].marks, chars[j].marks)) j++;
    const rawText = chars.slice(i, j).map((char) => char.raw).join('');
    const text = chars.slice(i, j).map((char) => char.char).join('');
    const marked = chars[i].marks.size ? wrapText(rawText, chars[i].marks) : rawText;
    const leadingLength = marked.length - rawText.length;
    const prefixLength = leadingLength > 0 ? Math.max(0, marked.indexOf(rawText)) : 0;
    out += marked;
    const start = out.length - marked.length;
    let cursor = outputOffset + start + prefixLength;
    for (const char of chars.slice(i, j)) {
      const rawLength = char.raw.length;
      char.outputFrom = cursor;
      char.outputTo = cursor + rawLength;
      cursor += rawLength;
    }
    i = j;
  }
  return out;
}

function serialize(chars: InlineChar[]): string {
  let output = '';
  let i = 0;
  while (i < chars.length) {
    const link = chars[i].link;
    let j = i + 1;
    while (j < chars.length && chars[j].link === link) j++;
    const group = chars.slice(i, j);
    const label = serializeGroup(group, output.length + (link ? 1 : 0));
    if (link) output += `[${label}](${link.destination})`;
    else output += label;
    i = j;
  }
  return output;
}

function eligible(chars: InlineChar[], from: number, to: number, scope: 'selection' | 'all'): InlineChar[] {
  return chars.filter((char) => {
    if (char.protected || char.char.trim() === '') return false;
    if (scope === 'all') return true;
    return char.from < to && char.to > from;
  });
}

export function getInlineMarkState(
  source: string,
  selectionStart = 0,
  selectionEnd = 0,
  scope: 'selection' | 'all' = 'all',
  marker: InlineMarker,
): MarkState {
  const chars = eligible(parse(source), selectionStart, selectionEnd, scope);
  if (!chars.length) return 'inactive';
  const mark = markFor(marker);
  const count = chars.filter((char) => char.marks.has(mark)).length;
  return count === 0 ? 'inactive' : count === chars.length ? 'active' : 'mixed';
}

export function toggleInlineMarkup(
  source: string,
  selectionStart: number,
  selectionEnd: number,
  marker: InlineMarker,
  options: ToggleOptions = {},
): ToggleResult {
  const scope = options.scope ?? (selectionStart === selectionEnd ? 'all' : 'selection');
  const chars = parse(source);
  const targets = eligible(chars, selectionStart, selectionEnd, scope);
  if (!targets.length) return { next: source, selectionStart, selectionEnd, changed: false };
  const mark = markFor(marker);
  const state = targets.every((char) => char.marks.has(mark)) ? 'active' : 'inactive';
  const action = options.action ?? 'toggle';
  const shouldAdd = action === 'add' || (action === 'toggle' && state !== 'active');
  let changed = false;
  for (const char of targets) {
    const has = char.marks.has(mark);
    if (shouldAdd && !has) { char.marks.add(mark); changed = true; }
    if (!shouldAdd && has) { char.marks.delete(mark); changed = true; }
  }
  if (!changed) return { next: source, selectionStart, selectionEnd, changed: false };
  const next = serialize(chars);
  const first = targets[0];
  const last = targets[targets.length - 1];
  return {
    next,
    selectionStart: first.outputFrom ?? selectionStart,
    selectionEnd: last.outputTo ?? selectionEnd,
    changed: true,
  };
}
