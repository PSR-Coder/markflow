// Minimal, well-guarded KaTeX plugin for markdown-it.
// $...$ inline math, $$...$$ display math. Guards against currency false-positives.
import type MarkdownIt from 'markdown-it';
import katex from 'katex';

function isValidInline(src: string, start: number, end: number): boolean {
  // no space right after opening $ or right before closing $
  if (src[start] === ' ' || src[end - 1] === ' ') return false;
  // opening $ must not be immediately followed by a digit (currency: $5)
  if (/\d/.test(src[start])) return false;
  return true;
}

export default function katexPlugin(md: MarkdownIt): void {
  md.inline.ruler.after('escape', 'math_inline', (state: any, silent: boolean) => {
    const start = state.pos;
    const src = state.src;
    if (src.charCodeAt(start) !== 0x24 /* $ */) return false;
    if (src.charCodeAt(start + 1) === 0x24) return false; // $$ handled elsewhere
    if (start > 0 && src[start - 1] === '\\') return false;

    let pos = start + 1;
    let found = -1;
    while (pos < state.posMax) {
      if (src.charCodeAt(pos) === 0x24 && src[pos - 1] !== '\\') { found = pos; break; }
      pos++;
    }
    if (found === -1 || found === start + 1) return false;
    const tex = src.slice(start + 1, found);
    if (!isValidInline(tex, 0, tex.length)) return false;

    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.content = tex;
      token.markup = '$';
    }
    state.pos = found + 1;
    return true;
  });

  md.block.ruler.after('blockquote', 'math_block', (state: any, startLine: number, endLine: number, silent: boolean) => {
    const startPos = state.bMarks[startLine] + state.tShift[startLine];
    const maxPos = state.eMarks[startLine];
    const src = state.src;
    if (src.slice(startPos, startPos + 2) !== '$$') return false;

    // Single-line form: $$ ... $$
    const firstLine = src.slice(startPos, maxPos);
    if (firstLine.length > 2 && firstLine.endsWith('$$')) {
      if (silent) return true;
      state.line = startLine + 1;
      const token = state.push('math_block', 'math', 0);
      token.block = true;
      token.content = firstLine.slice(2, -2).trim();
      return true;
    }

    // Multi-line form
    let nextLine = startLine;
    let endPos = -1;
    for (;;) {
      nextLine++;
      if (nextLine >= endLine) break;
      const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineEnd = state.eMarks[nextLine];
      if (src.slice(lineStart, lineEnd).trim() === '$$') { endPos = lineStart; state.line = nextLine + 1; break; }
      if (lineStart < lineEnd && state.sCount[nextLine] < state.blkIndent) break;
    }
    if (endPos === -1) return false;
    if (silent) return true;
    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.content = src.slice(startPos + 2, endPos).trim();
    return true;
  });

  md.renderer.rules.math_inline = (tokens: any[], idx: number) => {
    try {
      return katex.renderToString(tokens[idx].content, { displayMode: false, throwOnError: false });
    } catch {
      return `<code class="math-error">${md.utils.escapeHtml(tokens[idx].content)}</code>`;
    }
  };
  md.renderer.rules.math_block = (tokens: any[], idx: number) => {
    try {
      return `<div class="katex-display">${katex.renderToString(tokens[idx].content, { displayMode: true, throwOnError: false })}</div>`;
    } catch {
      return `<pre class="math-error">${md.utils.escapeHtml(tokens[idx].content)}</pre>`;
    }
  };
}
