// Tiny UI primitives: toasts + modals. No framework.

type ToastKind = 'info' | 'ok' | 'err';

export function toast(message: string, kind: ToastKind = 'info', ms = 2600): void {
  const root = document.getElementById('toastRoot')!;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, ms - 300);
  setTimeout(() => el.remove(), ms);
}

export interface ModalHandle {
  el: HTMLElement;
  body: HTMLElement;
  close: () => void;
}

// Stack of open modal backdrops (top last) — Escape/backdrop only ever close
// the TOP dialog, so nested dialogs (link-in-table-editor, promote-to-header)
// can't vaporise the editor session beneath them.
const modalStack: HTMLElement[] = [];

export function openModal(opts: {
  title: string;
  body: HTMLElement | string;
  foot?: HTMLElement[];
  wide?: boolean;
  onClose?: () => void;
}): ModalHandle {
  const root = document.getElementById('modalRoot')!;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal' + (opts.wide ? ' wide' : '');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-label', opts.title);

  const head = document.createElement('div');
  head.className = 'modal-head';
  const h = document.createElement('h2');
  h.textContent = opts.title;
  const x = document.createElement('button');
  x.className = 'modal-x';
  x.innerHTML = '&times;';
  x.setAttribute('aria-label', 'Close');
  head.append(h, x);

  const body = document.createElement('div');
  body.className = 'modal-body';
  if (typeof opts.body === 'string') body.innerHTML = opts.body;
  else body.appendChild(opts.body);

  modal.append(head, body);

  if (opts.foot?.length) {
    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    foot.append(...opts.foot);
    modal.appendChild(foot);
  }

  const close = () => {
    const i = modalStack.indexOf(backdrop);
    if (i >= 0) modalStack.splice(i, 1);
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && modalStack[modalStack.length - 1] === backdrop) { e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey);
  x.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && modalStack[modalStack.length - 1] === backdrop) close();
  });

  backdrop.appendChild(modal);
  root.appendChild(backdrop);
  modalStack.push(backdrop);
  return { el: modal, body, close };
}

/** Small labeled form-dialog helper. Returns handle; the submit button calls onSubmit with input values. */
export function formDialog(opts: {
  title: string;
  submitLabel: string;
  fields: { key: string; label: string; type?: 'text' | 'url'; placeholder?: string; value?: string }[];
  onSubmit: (values: Record<string, string>) => void;
}): ModalHandle {
  const wrap = document.createElement('form');
  wrap.noValidate = true;
  const formId = `fd-form-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  wrap.id = formId;
  const inputs: Record<string, HTMLInputElement> = {};
  for (const f of opts.fields) {
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.textContent = f.label;
    label.htmlFor = `fd-${f.key}`;
    const input = document.createElement('input');
    input.type = f.type ?? 'text';
    input.id = `fd-${f.key}`;
    input.placeholder = f.placeholder ?? '';
    input.value = f.value ?? '';
    inputs[f.key] = input;
    field.append(label, input);
    wrap.appendChild(field);
  }

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn ghost';
  cancel.textContent = 'Cancel';
  const ok = document.createElement('button');
  ok.type = 'submit';
  ok.setAttribute('form', formId); // footer buttons live outside the <form>; bind explicitly
  ok.className = 'btn primary';
  ok.textContent = opts.submitLabel;

  const handle = openModal({ title: opts.title, body: wrap, foot: [cancel, ok] });
  cancel.addEventListener('click', handle.close);
  wrap.addEventListener('submit', (e) => {
    e.preventDefault();
    const values: Record<string, string> = {};
    for (const [k, inp] of Object.entries(inputs)) values[k] = inp.value.trim();
    handle.close();
    opts.onSubmit(values);
  });
  setTimeout(() => Object.values(inputs)[0]?.focus(), 30);
  return handle;
}

export function confirmDialog(title: string, message: string, okLabel = 'Delete'): Promise<boolean> {
  return new Promise((resolve) => {
    const p = document.createElement('p');
    p.className = 'muted-note';
    p.textContent = message;
    const cancel = document.createElement('button');
    cancel.className = 'btn ghost';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.className = 'btn primary danger';
    ok.textContent = okLabel;
    const h = openModal({
      title, body: p, foot: [cancel, ok],
      onClose: () => resolve(false),
    });
    cancel.addEventListener('click', () => h.close());
    ok.addEventListener('click', () => { resolve(true); h.close(); });
  });
}

/** Simple anchored popover menu. */
export function popMenu(anchor: HTMLElement, items: { label: string; note?: string; onClick: () => void }[], note?: string): void {
  document.querySelectorAll('.menu-pop').forEach((m) => m.remove());
  const menu = document.createElement('div');
  menu.className = 'menu-pop';
  for (const item of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = item.label;
    b.addEventListener('click', () => { menu.remove(); item.onClick(); });
    menu.appendChild(b);
  }
  if (note) {
    const n = document.createElement('div');
    n.className = 'menu-note';
    n.textContent = note;
    menu.appendChild(n);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  const onDoc = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node) && e.target !== anchor) { menu.remove(); document.removeEventListener('mousedown', onDoc); }
  };
  document.addEventListener('mousedown', onDoc);
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d} d ago`;
  return new Date(ts).toLocaleDateString();
}

export function countWords(text: string): number {
  const m = text.replace(/[`*_~#[\]()>|-]/g, ' ').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return m ? m.length : 0;
}
