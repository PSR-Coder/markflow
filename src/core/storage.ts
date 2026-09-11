// Storage layer — IndexedDB via Dexie. Documents NEVER live in bare localStorage
// (browser cleanup wipes that; this was pain point #3.5 in the research).
import Dexie, { type Table } from 'dexie';
import { attachmentIds } from './attachments';

export interface Doc {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface Snapshot {
  sid?: number;
  docId: string;
  label: string;
  content: string;
  words: number;
  ts: number;
}

export interface Asset {
  id: string;
  name: string;
  type: string;
  blob: Blob;
  ts: number;
}

class MarkFlowDB extends Dexie {
  docs!: Table<Doc, string>;
  snaps!: Table<Snapshot, number>;
  assets!: Table<Asset, string>;

  constructor() {
    super('markflow');
    this.version(1).stores({
      docs: 'id, updatedAt',
      snaps: '++sid, docId, ts',
      assets: 'id',
    });
  }
}

export const db = new MarkFlowDB();

export function uid(): string {
  if ('randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const SNAPSHOT_KEEP = 40;

export async function listDocs(): Promise<Doc[]> {
  return db.docs.orderBy('updatedAt').reverse().toArray();
}

export async function createDoc(title: string, content = ''): Promise<Doc> {
  const now = Date.now();
  const doc: Doc = { id: uid(), title, content, createdAt: now, updatedAt: now };
  await db.docs.add(doc);
  return doc;
}

export async function saveDoc(doc: Doc): Promise<void> {
  doc.updatedAt = Date.now();
  await db.docs.put(doc);
}

export async function deleteDoc(id: string): Promise<void> {
  await db.transaction('rw', db.docs, db.snaps, db.assets, async () => {
    await db.docs.delete(id);
    await db.snaps.where('docId').equals(id).delete();
    const docs = await db.docs.toArray();
    const snapshots = await db.snaps.toArray();
    const referenced = new Set<string>();
    for (const doc of docs) attachmentIds(doc.content).forEach((assetId) => referenced.add(assetId));
    for (const snapshot of snapshots) attachmentIds(snapshot.content).forEach((assetId) => referenced.add(assetId));
    const assets = await db.assets.toArray();
    await db.assets.bulkDelete(assets.filter((asset) => !referenced.has(asset.id)).map((asset) => asset.id));
  });
}

export async function duplicateDoc(doc: Doc): Promise<Doc> {
  return createDoc(`${doc.title} (copy)`, doc.content);
}

// ---------- snapshots ----------

export async function addSnapshot(docId: string, label: string, content: string, words: number): Promise<void> {
  await db.snaps.add({ docId, label, content, words, ts: Date.now() });
  // prune: keep newest SNAPSHOT_KEEP per doc
  const all = await db.snaps.where('docId').equals(docId).sortBy('ts');
  if (all.length > SNAPSHOT_KEEP) {
    const excess = all.slice(0, all.length - SNAPSHOT_KEEP);
    await db.snaps.bulkDelete(excess.map((s) => s.sid!));
  }
}

export async function addImportedSnapshot(snapshot: Omit<Snapshot, 'sid'>): Promise<void> {
  await db.snaps.add(snapshot);
}

export async function listSnapshots(docId: string): Promise<Snapshot[]> {
  const all = await db.snaps.where('docId').equals(docId).sortBy('ts');
  return all.reverse();
}

// ---------- assets ----------

export async function putAsset(blob: Blob, name: string): Promise<Asset> {
  const asset: Asset = { id: uid() + extOf(name), name, type: blob.type || 'image/png', blob, ts: Date.now() };
  await db.assets.put(asset);
  return asset;
}

export async function getAsset(id: string): Promise<Asset | undefined> {
  return db.assets.get(id);
}

export async function listOrphanAssets(): Promise<Asset[]> {
  const docs = await db.docs.toArray();
  const snapshots = await db.snaps.toArray();
  const referenced = new Set<string>();
  for (const doc of docs) attachmentIds(doc.content).forEach((assetId) => referenced.add(assetId));
  for (const snapshot of snapshots) attachmentIds(snapshot.content).forEach((assetId) => referenced.add(assetId));
  return (await db.assets.toArray()).filter((asset) => !referenced.has(asset.id));
}

export async function deleteAssets(ids: string[]): Promise<void> {
  if (ids.length) await db.assets.bulkDelete(ids);
}

function extOf(name: string): string {
  const m = /\.[a-z0-9]{1,8}$/i.exec(name);
  return m ? m[0].toLowerCase() : '.png';
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
