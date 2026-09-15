import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { addSnapshotIfChanged, createRestoreCheckpoint, db, listSnapshots } from '../src/core/storage';

describe('snapshot persistence policy', () => {
  beforeEach(async () => {
    await db.docs.clear();
    await db.snaps.clear();
    await db.assets.clear();
  });

  it('deduplicates ordinary snapshots against the newest persisted content', async () => {
    await expect(addSnapshotIfChanged('doc-1', 'manual', 'A', 1)).resolves.toBe(true);
    await expect(addSnapshotIfChanged('doc-1', 'auto', 'A', 1)).resolves.toBe(false);
    await expect(listSnapshots('doc-1')).resolves.toHaveLength(1);
  });

  it('allows a return to an older version when it differs from the newest snapshot', async () => {
    await addSnapshotIfChanged('doc-1', 'manual', 'A', 1);
    await addSnapshotIfChanged('doc-1', 'manual', 'B', 1);
    await expect(addSnapshotIfChanged('doc-1', 'manual', 'A', 1)).resolves.toBe(true);
    expect((await listSnapshots('doc-1')).map((snapshot) => snapshot.content)).toEqual(['A', 'B', 'A']);
  });

  it('deduplicates a pre-restore checkpoint only when newest content is already safe', async () => {
    await addSnapshotIfChanged('doc-1', 'manual', 'A', 1);
    await expect(createRestoreCheckpoint('doc-1', 'A', 1)).resolves.toBe(false);
    await addSnapshotIfChanged('doc-1', 'manual', 'B', 1);
    await expect(createRestoreCheckpoint('doc-1', 'A', 1)).resolves.toBe(true);
    expect((await listSnapshots('doc-1')).filter((snapshot) => snapshot.label === 'pre-restore')).toHaveLength(1);
  });
});