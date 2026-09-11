// CodeMirror 6 editor setup — the right surface for prose-sized documents:
// real undo, proper selection model, mobile-tolerant, ~20x lighter than Monaco.
import { EditorView, keymap, placeholder, highlightActiveLine, highlightActiveLineGutter, lineNumbers, drawSelection } from '@codemirror/view';
import { EditorState, Prec } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, openSearchPanel, highlightSelectionMatches } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { languages as codeLanguages } from '@codemirror/language-data';
import { classHighlighter } from '@lezer/highlight';

export interface EditorHooks {
  onChange: (text: string) => void;
  onCursor: (line: number, col: number) => void;
  onSave: () => void;
  onScroll: (fraction: number) => void;
}

export function createEditor(parent: HTMLElement, initial: string, hooks: EditorHooks): EditorView {
  const state = EditorState.create({
    doc: initial,
    extensions: [
      lineNumbers(),
      drawSelection(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSelectionMatches(),
      history(),
      EditorView.lineWrapping,
      placeholder('Start writing Markdown…  (Ctrl+/ for shortcuts)'),
      Prec.high(keymap.of([
        { key: 'Mod-s', run: () => { hooks.onSave(); return true; } },
      ])),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      markdown({ base: markdownLanguage, codeLanguages, addKeymap: true }),
      syntaxHighlighting(classHighlighter),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) hooks.onChange(update.state.doc.toString());
        if (update.selectionSet || update.docChanged) {
          const pos = update.state.selection.main.head;
          const line = update.state.doc.lineAt(pos);
          hooks.onCursor(line.number, pos - line.from + 1);
        }
      }),
      EditorView.contentAttributes.of({ spellcheck: 'true', 'aria-label': 'Markdown source editor' }),
    ],
  });

  const view = new EditorView({ state, parent });

  // Fraction-based scroll sync source. rAF-throttled.
  let ticking = false;
  view.scrollDOM.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const el = view.scrollDOM;
      const max = el.scrollHeight - el.clientHeight;
      hooks.onScroll(max > 0 ? el.scrollTop / max : 0);
    });
  }, { passive: true });

  return view;
}

/** Replace the whole document (used when switching docs / restoring snapshots). */
export function setEditorText(view: EditorView, text: string): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: 0 },
  });
}

/** Insert text at the cursor, replacing any selection. */
export function insertAtCursor(view: EditorView, text: string): void {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
  view.focus();
}

export function openSearch(view: EditorView): void {
  openSearchPanel(view);
}
