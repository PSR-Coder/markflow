import { describe, expect, it } from 'vitest';
import { getInlineMarkState, toggleInlineMarkup } from '../src/core/inlineFormatting';

describe('inline formatting', () => {
  const toggleSelected = (source: string, word: string, marker: '**' | '*' | '~~' | '`') => {
    const start = source.indexOf(word);
    return toggleInlineMarkup(source, start, start + word.length, marker).next;
  };

  it('adds marks without replacing existing marks', () => {
    expect(toggleSelected('**text**', 'text', '*')).toBe('***text***');
    expect(toggleSelected('***text***', 'text', '~~')).toBe('~~***text***~~');
  });

  it('removes and reapplies each nested mark independently', () => {
    expect(toggleSelected('~~***text***~~', 'text', '~~')).toBe('***text***');
    expect(toggleSelected('~~***text***~~', 'text', '**')).toBe('~~*text*~~');
    expect(toggleSelected('~~***text***~~', 'text', '*')).toBe('~~**text**~~');
    expect(toggleSelected('***text***', 'text', '~~')).toBe('~~***text***~~');
  });

  it('splits partial visible selections while preserving surrounding text', () => {
    expect(toggleSelected('hello world', 'hello', '**')).toBe('**hello** world');
    expect(toggleSelected('plain **bold** words', 'words', '~~')).toBe('plain **bold** ~~words~~');
  });

  it('handles whole-cell and bulk add/remove semantics', () => {
    expect(toggleInlineMarkup('plain text', 0, 0, '**', { scope: 'all' }).next).toBe('**plain** **text**');
    expect(toggleInlineMarkup('**bold** *italic*', 0, 0, '**', { scope: 'all', action: 'remove' }).next)
      .toBe('bold *italic*');
    expect(toggleInlineMarkup('**bold** *italic*', 0, 0, '**', { scope: 'all', action: 'add' }).next)
      .toBe('**bold** ***italic***');
  });

  it('reports active, inactive, and mixed mark states', () => {
    expect(getInlineMarkState('~~***text***~~', 4, 8, 'selection', '~~')).toBe('active');
    expect(getInlineMarkState('plain **bold**', 0, 5, 'selection', '**')).toBe('inactive');
    expect(getInlineMarkState('plain **bold**', 0, 14, 'selection', '**')).toBe('mixed');
  });

  it('protects links, URLs, code, math, images, HTML, and escapes', () => {
    expect(toggleInlineMarkup('[link](https://example.test)', 1, 5, '**', { scope: 'selection' }).next)
      .toBe('[**link**](https://example.test)');
    expect(toggleInlineMarkup('`code`', 0, 0, '**', { scope: 'all' }).next).toBe('`code`');
    expect(toggleInlineMarkup('$x$ ![alt](image.png) <span>x</span>', 0, 0, '**', { scope: 'all' }).next)
      .toBe('$x$ ![alt](image.png) <span>**x**</span>');
    expect(toggleInlineMarkup('\\*escaped\\*', 0, 0, '**', { scope: 'all' }).next)
      .toBe('**\\*escaped\\***');
  });

  it('protects Markdown block structure while formatting content', () => {
    const source = '# Heading\n\n- item\n\n```js\nconst x = 1;\n```';
    expect(toggleInlineMarkup(source, 0, 0, '**', { scope: 'all' }).next)
      .toBe('# **Heading**\n\n- **item**\n\n```js\nconst x = 1;\n```');
  });
});
