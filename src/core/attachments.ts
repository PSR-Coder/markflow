const ATTACHMENT_RE = /attachment:([A-Za-z0-9._-]+)/g;

export function attachmentIds(markdown: string): string[] {
  return [...new Set(Array.from(markdown.matchAll(ATTACHMENT_RE), (match) => match[1]))];
}

export function rewriteAttachmentIds(markdown: string, ids: ReadonlyMap<string, string>): string {
  return markdown.replace(ATTACHMENT_RE, (_full, id: string) => `attachment:${ids.get(id) ?? id}`);
}
