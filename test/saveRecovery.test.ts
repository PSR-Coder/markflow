import { describe, expect, it } from 'vitest';
import {
  parsePendingSaves,
  removePendingSave,
  serializePendingSaves,
  upsertPendingSave,
  type PendingSaveDraft,
} from '../src/core/saveRecovery';

const draft = (docId: string, savedAt: number): PendingSaveDraft => ({
  docId,
  title: docId,
  content: `content-${docId}`,
  savedAt,
});

describe('durable save recovery queue', () => {
  it('migrates the previous single-draft format', () => {
    expect(parsePendingSaves(JSON.stringify(draft('one', 1)))).toEqual([draft('one', 1)]);
    expect(parsePendingSaves(serializePendingSaves([draft('one', 1), draft('two', 2)]))).toEqual([draft('one', 1), draft('two', 2)]);
  });

  it('replaces a document entry without dropping other failed drafts', () => {
    const next = upsertPendingSave([draft('one', 1), draft('two', 2)], draft('one', 3));
    expect(next).toEqual([draft('two', 2), draft('one', 3)]);
  });

  it('removes only the successfully recovered document', () => {
    expect(removePendingSave([draft('one', 1), draft('two', 2)], 'one')).toEqual([draft('two', 2)]);
  });

  it('ignores malformed persisted values', () => {
    expect(parsePendingSaves('{broken')).toEqual([]);
    expect(parsePendingSaves(JSON.stringify([{ docId: 'missing-fields' }]))).toEqual([]);
  });
});
