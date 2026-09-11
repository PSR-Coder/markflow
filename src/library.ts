// Sidebar document list rendering.
import type { Doc } from './core/storage';
import { timeAgo, countWords } from './ui';

export interface LibraryHandlers {
  onSelect: (doc: Doc) => void;
  onRename: (doc: Doc) => void;
  onDuplicate: (doc: Doc) => void;
  onDelete: (doc: Doc) => void;
}

export function renderDocList(
  container: HTMLElement,
  docs: Doc[],
  currentId: string,
  filter: string,
  handlers: LibraryHandlers,
): void {
  container.innerHTML = '';
  const q = filter.trim().toLowerCase();
  const visible = q
    ? docs.filter((d) => d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q))
    : docs;

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'doc-list-empty';
    empty.textContent = q ? `No documents match “${filter}”.` : 'No documents yet — create your first one.';
    container.appendChild(empty);
    return;
  }

  for (const doc of visible) {
    const item = document.createElement('div');
    item.className = 'doc-item' + (doc.id === currentId ? ' active' : '');
    item.setAttribute('role', 'listitem');
    item.tabIndex = 0;

    const title = document.createElement('div');
    title.className = 'doc-item-title';
    title.textContent = doc.title || 'Untitled';
    const meta = document.createElement('div');
    meta.className = 'doc-item-meta';
    meta.textContent = `${timeAgo(doc.updatedAt)} · ${countWords(doc.content).toLocaleString()} words`;

    const actions = document.createElement('div');
    actions.className = 'doc-item-actions';
    const mk = (label: string, fn: (d: Doc) => void, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.className = cls;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(doc); });
      actions.appendChild(b);
    };
    mk('Rename', handlers.onRename);
    mk('Copy', handlers.onDuplicate);
    mk('Delete', handlers.onDelete, 'del');

    item.append(title, meta, actions);
    item.addEventListener('click', () => handlers.onSelect(doc));
    item.addEventListener('keydown', (e) => { if (e.key === 'Enter') handlers.onSelect(doc); });
    container.appendChild(item);
  }
}
