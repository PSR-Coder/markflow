import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { getInlineMarkState, toggleInlineMarkup, type InlineMarker } from '../src/core/inlineFormatting';
import { findAllTables, findTableAtLine, parseRow, serializeTable, type Align } from '../src/core/tables';

const markerArb = fc.constantFrom<InlineMarker>('**', '*', '~~', '`');
const markdownTextArb = fc.string({ maxLength: 120 });
const safeCellArb = fc.array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'), { maxLength: 16 })
  .map((chars) => chars.join(''));
const safeRowsArb = fc.array(
  fc.array(safeCellArb, { minLength: 1, maxLength: 5 }),
  { minLength: 1, maxLength: 6 },
);

const paddedRows = (rows: string[][]): string[][] => {
  const width = Math.max(...rows.map((row) => row.length));
  return rows.map((row) => [...row, ...Array.from({ length: width - row.length }, () => '')]);
};

describe('property contracts', () => {
  it('never throws on arbitrary inline Markdown input', () => {
    fc.assert(fc.property(markdownTextArb, markerArb, (source, marker) => {
      const result = toggleInlineMarkup(source, 0, 0, marker, { scope: 'all' });
      expect(typeof result.next).toBe('string');
      expect(result.selectionStart).toBeGreaterThanOrEqual(0);
      expect(result.selectionEnd).toBeGreaterThanOrEqual(result.selectionStart);
      expect(() => getInlineMarkState(result.next, 0, result.next.length, 'selection', marker)).not.toThrow();
    }), { numRuns: 250 });
  });

  it('keeps inline selection bounds valid after arbitrary formatting', () => {
    fc.assert(fc.property(markdownTextArb, markerArb, (source, marker) => {
      const start = Math.floor(source.length / 3);
      const end = Math.min(source.length, start + Math.floor(source.length / 2));
      const result = toggleInlineMarkup(source, start, end, marker, { scope: 'selection' });
      expect(result.selectionStart).toBeGreaterThanOrEqual(0);
      expect(result.selectionEnd).toBeLessThanOrEqual(result.next.length);
      expect(result.selectionStart).toBeLessThanOrEqual(result.selectionEnd);
    }), { numRuns: 250 });
  });

  it('round-trips safe ragged table matrices through Markdown', () => {
    fc.assert(fc.property(safeRowsArb, (rows) => {
      const width = Math.max(...rows.map((row) => row.length));
      const aligns: Align[] = Array.from({ length: width }, (_, index) => (index % 3 === 0 ? 'left' : index % 3 === 1 ? 'center' : 'right'));
      const serialized = serializeTable(rows, aligns);
      const parsed = findTableAtLine(serialized.split('\n'), 0);
      expect(parsed).not.toBeNull();
      expect(parsed?.rows).toEqual(paddedRows(rows));
      expect(parsed?.aligns).toEqual(aligns);
    }), { numRuns: 150 });
  });

  it('never throws while scanning arbitrary lines for tables', () => {
    fc.assert(fc.property(fc.array(markdownTextArb, { maxLength: 30 }), (lines) => {
      expect(() => findAllTables(lines)).not.toThrow();
      expect(() => lines.forEach((line) => parseRow(line))).not.toThrow();
    }), { numRuns: 150 });
  });
});
