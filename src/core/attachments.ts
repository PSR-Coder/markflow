const ATTACHMENT_RE = /attachment:([A-Za-z0-9._-]+)/g;

export interface AttachmentName {
  id: string;
  name: string;
}

export function attachmentIds(markdown: string): string[] {
  return [...new Set(Array.from(markdown.matchAll(ATTACHMENT_RE), (match) => match[1]))];
}

export function rewriteAttachmentIds(markdown: string, ids: ReadonlyMap<string, string>): string {
  return markdown.replace(ATTACHMENT_RE, (_full, id: string) => `attachment:${ids.get(id) ?? id}`);
}

function safeFilename(name: string, fallback: string): string {
  const leaf = name.split(/[\\/]/).pop() || fallback;
  return leaf.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

export function buildPortableAttachmentPaths(assets: readonly AttachmentName[]): Map<string, string> {
  const paths = new Map<string, string>();
  const used = new Set<string>();
  for (const asset of assets) {
    const base = safeFilename(asset.name, asset.id);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const extension = dot > 0 ? base.slice(dot) : '';
    let filename = base;
    let suffix = 2;
    while (used.has(filename.toLowerCase())) filename = `${stem}-${suffix++}${extension}`;
    used.add(filename.toLowerCase());
    paths.set(asset.id, `assets/${filename}`);
  }
  return paths;
}

export function rewriteAttachmentPaths(markdown: string, paths: ReadonlyMap<string, string>): string {
  return markdown.replace(ATTACHMENT_RE, (full, id: string) => paths.get(id) ?? full);
}
