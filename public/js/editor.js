import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';

// Markdown stays visible as written (no reformatting); styling just makes the
// structure easy to read. Colors come from CSS variables so dark mode works.
const markdownStyle = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: '700', fontSize: '1.4em', color: 'var(--md-heading)' },
  { tag: tags.heading2, fontWeight: '700', fontSize: '1.2em', color: 'var(--md-heading)' },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: '700', color: 'var(--md-heading)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--md-link)' },
  { tag: tags.quote, color: 'var(--md-quote)', fontStyle: 'italic' },
  { tag: tags.monospace, fontFamily: 'var(--mono-font)', fontSize: '0.9em' },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: 'var(--md-mark)' },
]);

// Set through CodeMirror's theme so it takes precedence over its base styles
// (always-visible vertical scrollbar, prose font).
const proseTheme = EditorView.theme({
  '&': { height: '100%' },
  '.cm-scroller': { overflowY: 'scroll', fontFamily: 'var(--prose-font)', fontSize: '17px', lineHeight: '1.7' },
});

// One CodeMirror view, reused for every file. Opening a file swaps in a fresh
// state, so undo history never leaks between files.
export class Editor {
  constructor(host, { onChange, onSave }) {
    this.onChange = onChange;
    this.onSave = onSave;
    this.savedContent = '';
    this.extensions = [
      history(),
      drawSelection(),
      search({ top: true }),
      highlightSelectionMatches(),
      markdown(),
      syntaxHighlighting(markdownStyle),
      EditorView.lineWrapping,
      proseTheme,
      EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences' }),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { this.onSave(); return true; } },
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) this.onChange();
      }),
    ];
    this.view = new EditorView({ parent: host, state: EditorState.create({ doc: '', extensions: this.extensions }) });
  }

  load(content, { keepSelection = false } = {}) {
    const selection = keepSelection ? this.view.state.selection : undefined;
    const scrollTop = this.view.scrollDOM.scrollTop;
    const state = EditorState.create({ doc: content, extensions: this.extensions });
    this.view.setState(state);
    if (selection) {
      const max = state.doc.length;
      const head = Math.min(selection.main.head, max);
      this.view.dispatch({ selection: { anchor: head } });
      this.view.scrollDOM.scrollTop = scrollTop;
    }
    this.savedContent = content;
  }

  get content() {
    return this.view.state.doc.toString();
  }

  get dirty() {
    return this.content !== this.savedContent;
  }

  markSaved(content) {
    this.savedContent = content;
  }

  focus() {
    this.view.focus();
  }
}
