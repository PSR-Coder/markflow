import JSZip from 'jszip';
import type { Asset, Doc, Snapshot } from './storage';

export const BACKUP_FORMAT = 'markflow-backup';
export const BACKUP_SCHEMA = 1;

export interface BackupDocumentEntry {
  sourceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  path: string;
  snapshotPaths: string[];
}

export interface BackupSnapshotEntry {
  sourceDocId: string;
  label: string;
  words: number;
  ts: number;
  path: string;
}

export interface BackupAssetEntry {
  sourceId: string;
  name: string;
  type: string;
  path: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  schema: typeof BACKUP_SCHEMA;
  exportedAt: string;
  documents: BackupDocumentEntry[];
  snapshots: BackupSnapshotEntry[];
  assets: BackupAssetEntry[];
}

export interface BackupInput {
  docs: Doc[];
  snapshots: Snapshot[];
  assets: Asset[];
}

export interface ParsedBackupDocument extends BackupDocumentEntry {
  content: string;
  snapshots: Array<BackupSnapshotEntry & { content: string }>;
}

export interface ParsedBackupAsset extends BackupAssetEntry {
  blob: Blob;
}

export interface ParsedBackup {
  manifest: BackupManifest;
  documents: ParsedBackupDocument[];
  assets: ParsedBackupAsset[];
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

export async function buildBackupZip(input: BackupInput): Promise<Blob> {
  const zip = new JSZip();
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    schema: BACKUP_SCHEMA,
    exportedAt: new Date().toISOString(),
    documents: [],
    snapshots: [],
    assets: [],
  };
  const usedDocPaths = new Set<string>();
  const usedSnapshotPaths = new Set<string>();
  const usedAssetPaths = new Set<string>();
  const docById = new Map(input.docs.map((doc) => [doc.id, doc]));

  for (const doc of input.docs) {
    const base = `docs/${safePathPart(doc.title)}-${safePathPart(doc.id.slice(0, 8))}`;
    let path = `${base}.md`;
    let suffix = 2;
    while (usedDocPaths.has(path)) path = `${base}-${suffix++}.md`;
    usedDocPaths.add(path);
    zip.file(path, doc.content);
    const snapshotPaths: string[] = [];
    for (const snapshot of input.snapshots.filter((item) => item.docId === doc.id)) {
      const snapshotBase = `snapshots/${safePathPart(doc.id.slice(0, 8))}-${safePathPart(snapshot.label)}-${snapshot.ts}`;
      let snapshotPath = `${snapshotBase}.md`;
      let snapshotSuffix = 2;
      while (usedSnapshotPaths.has(snapshotPath)) snapshotPath = `${snapshotBase}-${snapshotSuffix++}.md`;
      usedSnapshotPaths.add(snapshotPath);
      zip.file(snapshotPath, snapshot.content);
      snapshotPaths.push(snapshotPath);
      manifest.snapshots.push({ sourceDocId: snapshot.docId, label: snapshot.label, words: snapshot.words, ts: snapshot.ts, path: snapshotPath });
    }
    manifest.documents.push({
      sourceId: doc.id,
      title: doc.title,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      path,
      snapshotPaths,
    });
  }

  const referenced = new Set<string>();
  for (const doc of input.docs) {
    for (const match of doc.content.matchAll(/attachment:([A-Za-z0-9._-]+)/g)) referenced.add(match[1]);
  }
  for (const snapshot of input.snapshots) {
    for (const match of snapshot.content.matchAll(/attachment:([A-Za-z0-9._-]+)/g)) referenced.add(match[1]);
  }
  for (const asset of input.assets) {
    if (!referenced.has(asset.id)) continue;
    const base = `assets/${safePathPart(asset.id)}`;
    let path = base;
    let suffix = 2;
    while (usedAssetPaths.has(path)) path = `${base}-${suffix++}`;
    usedAssetPaths.add(path);
    zip.file(path, asset.blob);
    manifest.assets.push({ sourceId: asset.id, name: asset.name, type: asset.type, path });
  }

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('README.txt', [
    'MarkFlow backup package.',
    'Import this ZIP in MarkFlow to restore documents, snapshots, and referenced attachments.',
    'The manifest schema is versioned so future versions can reject incompatible packages safely.',
  ].join('\n'));
  return zip.generateAsync({ type: 'blob' });
}

export async function readBackupZip(blob: Blob): Promise<ParsedBackup> {
  const zip = await JSZip.loadAsync(blob);
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) throw new Error('This ZIP does not contain a MarkFlow manifest.');
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await manifestFile.async('text')) as BackupManifest;
  } catch {
    throw new Error('The MarkFlow manifest is not valid JSON.');
  }
  if (manifest.format !== BACKUP_FORMAT || manifest.schema !== BACKUP_SCHEMA) {
    throw new Error(`Unsupported MarkFlow backup format or schema (${String(manifest.schema)}).`);
  }
  if (!Array.isArray(manifest.documents) || !Array.isArray(manifest.snapshots) || !Array.isArray(manifest.assets)) {
    throw new Error('The MarkFlow manifest is missing required collections.');
  }

  const readText = async (path: string): Promise<string> => {
    const file = zip.file(path);
    if (!file) throw new Error(`The backup is missing ${path}.`);
    return file.async('text');
  };
  const readBlob = async (path: string): Promise<Blob> => {
    const file = zip.file(path);
    if (!file) throw new Error(`The backup is missing ${path}.`);
    const bytes = await file.async('uint8array');
    return new Blob([bytes.slice().buffer as ArrayBuffer]);
  };

  const snapshotsByDoc = new Map<string, Array<BackupSnapshotEntry & { content: string }>>();
  for (const snapshot of manifest.snapshots) {
    const list = snapshotsByDoc.get(snapshot.sourceDocId) ?? [];
    list.push({ ...snapshot, content: await readText(snapshot.path) });
    snapshotsByDoc.set(snapshot.sourceDocId, list);
  }
  const documents = [];
  for (const entry of manifest.documents) {
    documents.push({ ...entry, content: await readText(entry.path), snapshots: snapshotsByDoc.get(entry.sourceId) ?? [] });
  }
  const assets = [];
  for (const entry of manifest.assets) assets.push({ ...entry, blob: await readBlob(entry.path) });
  return { manifest, documents, assets };
}

/** Import-friendly fallback for ordinary ZIPs that contain one or more .md files. */
export async function readMarkdownZip(blob: Blob): Promise<ParsedBackup> {
  const zip = await JSZip.loadAsync(blob);
  const files = Object.values(zip.files).filter((file) => !file.dir && file.name.toLowerCase().endsWith('.md'));
  if (!files.length) throw new Error('This ZIP contains no Markdown files and no MarkFlow manifest.');
  const documents = await Promise.all(files.map(async (file, index) => {
    const path = file.name.replaceAll('\\', '/');
    const filename = path.split('/').pop() || `document-${index + 1}.md`;
    const title = filename.replace(/\.md$/i, '') || `Imported document ${index + 1}`;
    return {
      sourceId: `external-${index + 1}`,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      path,
      snapshotPaths: [],
      content: await file.async('text'),
      snapshots: [],
    };
  }));
  return {
    manifest: { format: BACKUP_FORMAT, schema: BACKUP_SCHEMA, exportedAt: new Date().toISOString(), documents: documents.map(({ content: _content, snapshots: _snapshots, ...entry }) => entry), snapshots: [], assets: [] },
    documents,
    assets: [],
  };
}
