export interface PendingSaveDraft {
  docId: string;
  title: string;
  content: string;
  savedAt: number;
}

export function parsePendingSaves(raw: string | null): PendingSaveDraft[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) return value.filter(isPendingSaveDraft);
    return isPendingSaveDraft(value) ? [value] : [];
  } catch {
    return [];
  }
}

export function serializePendingSaves(drafts: readonly PendingSaveDraft[]): string {
  return JSON.stringify(drafts);
}

export function upsertPendingSave(drafts: readonly PendingSaveDraft[], draft: PendingSaveDraft): PendingSaveDraft[] {
  return [...drafts.filter((item) => item.docId !== draft.docId), draft];
}

export function removePendingSave(drafts: readonly PendingSaveDraft[], docId: string): PendingSaveDraft[] {
  return drafts.filter((draft) => draft.docId !== docId);
}

function isPendingSaveDraft(value: unknown): value is PendingSaveDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<PendingSaveDraft>;
  return typeof draft.docId === 'string'
    && typeof draft.title === 'string'
    && typeof draft.content === 'string'
    && typeof draft.savedAt === 'number';
}
