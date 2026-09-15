import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getStorageHealth, requestPersistentStorage } from '../src/core/storage';

describe('storage health', () => {
  beforeEach(async () => {
    await db.docs.clear();
    await db.snaps.clear();
    await db.assets.clear();
    vi.stubGlobal('navigator', {
      storage: {
        estimate: vi.fn().mockResolvedValue({ usage: 1024, quota: 4096 }),
        persisted: vi.fn().mockResolvedValue(false),
        persist: vi.fn().mockResolvedValue(true),
      },
    });
  });

  it('reports counts and browser quota state', async () => {
    await db.docs.add({ id: 'doc-1', title: 'One', content: '# One', createdAt: 1, updatedAt: 1 });
    const health = await getStorageHealth();
    expect(health.documents).toBe(1);
    expect(health.snapshots).toBe(0);
    expect(health.assets).toBe(0);
    expect(health.usage).toBe(1024);
    expect(health.quota).toBe(4096);
    expect(health.persistent).toBe(false);
    expect(health.persistenceAvailable).toBe(true);
  });

  it('requests persistent storage through the browser API', async () => {
    await expect(requestPersistentStorage()).resolves.toBe(true);
  });
});
