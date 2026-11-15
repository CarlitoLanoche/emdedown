// CodeMirror 6 markdown editor (loaded lazily the first time Edit/Split mode is used).
import { EditorState, EditorSelection, Compartment, StateEffect, StateField, MapMode } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700', fontSize: '1.35em', color: 'var(--ed-heading)' },
  { tag: t.heading2, fontWeight: '700', fontSize: '1.2em', color: 'var(--ed-heading)' },
  { tag: t.heading3, fontWeight: '700', fontSize: '1.1em', color: 'var(--ed-heading)' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700', color: 'var(--ed-heading)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--ed-link)' },
  { tag: t.monospace, color: 'var(--ed-code)', fontFamily: 'var(--font-mono)' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--ed-mark)' },
  { tag: t.quote, color: 'var(--ed-quote)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--ed-mark)' },
  { tag: [t.keyword, t.operator], color: 'var(--ed-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--ed-string)' },
  { tag: t.comment, color: 'var(--ed-quote)' },
]);

function wrap(view, before, after = before, placeholder = '') {
  view.dispatch(view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to) || placeholder;
    // toggle off if already wrapped
    const pre = view.state.sliceDoc(range.from - before.length, range.from);
    const post = view.state.sliceDoc(range.to, range.to + after.length);
    if (range.from !== range.to && pre === before && post === after) {
      return {
        changes: [{ from: range.from - before.length, to: range.from }, { from: range.to, to: range.to + after.length }],
        range: EditorSelection.range(range.from - before.length, range.to - before.length),
      };
    }
    return {
      changes: { from: range.from, to: range.to, insert: before + text + after },
      range: EditorSelection.range(range.from + before.length, range.from + before.length + text.length),
    };
  }));
  return true;
}

// Line formats (heading levels, list types, quote). Each line has at most one heading marker and one list
// marker: choosing another level/type replaces the existing marker instead of stacking ("## # Title");
// choosing the one a line already has removes it (toggle). With several lines selected, they all get the
// format unless they all have it already; blank lines in a multi-line selection are left alone.
const HEADING_RE = /^#{1,6}[ \t]+/;
const LIST_RE = /^([ \t]*)([-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d+[.)][ \t]+)/;
const QUOTE_RE = /^>[ \t]?/;
const LINE_FORMATS = {
  h1: { group: 'heading', marker: () => '# ' },
  h2: { group: 'heading', marker: () => '## ' },
  h3: { group: 'heading', marker: () => '### ' },
  bullet: { group: 'list', marker: () => '- ' },
  numbered: { group: 'list', marker: (n) => `${n}. ` },
  check: { group: 'list', marker: () => '- [ ] ' },
  quote: { group: 'quote', marker: () => '> ' },
};
function listKind(m) { if (!m) return null; if (/\[[ xX]\]/.test(m)) return 'check'; return /^\d/.test(m) ? 'numbered' : 'bullet'; }
/** The existing marker of this format's group on a line: { from, to, kind } relative to the line start, or null. */
function currentMarker(text, group) {
  if (group === 'heading') { const m = HEADING_RE.exec(text); return m && { from: 0, to: m[0].length, kind: 'h' + m[0].trim().length }; }
  if (group === 'list') { const m = LIST_RE.exec(text); return m && { from: m[1].length, to: m[0].length, kind: listKind(m[2]) }; }
  const m = QUOTE_RE.exec(text); return m && { from: 0, to: m[0].length, kind: 'quote' };
}
function lineFormat(view, kind) {
  const fmt = LINE_FORMATS[kind];
  const { state } = view;
  const lines = [];
  const seen = new Set();
  for (const r of state.selection.ranges) {
    for (let pos = r.from; pos <= r.to;) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.number)) { seen.add(line.number); lines.push(line); }
      pos = line.to + 1;
    }
  }
  const targets = lines.length > 1 ? lines.filter((l) => l.text.trim()) : lines;
  if (!targets.length) return true;
  const all = targets.every((l) => { const m = currentMarker(l.text, fmt.group); return m && m.kind === kind; });
  const changes = [];
  let n = 1;
  for (const l of targets) {
    const m = currentMarker(l.text, fmt.group);
    if (all) { changes.push({ from: l.from + m.from, to: l.from + m.to }); continue; }
    const indent = fmt.group === 'list' && !m ? /^[ \t]*/.exec(l.text)[0].length : 0;
    const at = m ? m.from : indent;
    changes.push({ from: l.from + at, to: l.from + (m ? m.to : at), insert: fmt.marker(n++) });
  }
  view.dispatch({ changes });
  return true;
}

const formatKeys = [
  { key: 'Mod-b', run: (v) => wrap(v, '**', '**', 'bold') },
  { key: 'Mod-i', run: (v) => wrap(v, '*', '*', 'italic') },
  { key: 'Mod-`', run: (v) => wrap(v, '`', '`', 'code') },
  { key: 'Mod-Shift-x', run: (v) => wrap(v, '~~', '~~', 'text') },
  { key: 'Mod-k', run: (v) => {
    const r = v.state.selection.main;
    const text = v.state.sliceDoc(r.from, r.to) || 'link text';
    const insert = `[${text}](https://)`;
    v.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: EditorSelection.range(r.from + text.length + 3, r.from + insert.length - 1) });
    return true;
  } },
  { key: 'Mod-Shift-.', run: (v) => lineFormat(v, 'quote') },
  { key: 'Mod-Shift-8', run: (v) => lineFormat(v, 'bullet') },
  { key: 'Mod-Shift-7', run: (v) => lineFormat(v, 'numbered') },
  { key: 'Mod-Shift-c', run: (v) => lineFormat(v, 'check') },
  { key: 'Mod-1', run: (v) => lineFormat(v, 'h1') },
  { key: 'Mod-2', run: (v) => lineFormat(v, 'h2') },
  { key: 'Mod-3', run: (v) => lineFormat(v, 'h3') },
];

// Where a pasted/dropped image's link will go while the image is still being saved. Kept inside each
// document's own EditorState and mapped through every edit, so the link lands in the document (and at the spot)
// the image was pasted into, even if the user types meanwhile or switches to another tab.
const addPending = StateEffect.define();
const dropPending = StateEffect.define();
const pendingField = StateField.define({
  create: () => [],
  update(list, tr) {
    let out = list;
    if (tr.docChanged && out.length) {
      out = out.map((p) => {
        const point = p.from === p.to;
        const from = tr.changes.mapPos(p.from, point ? 1 : -1, MapMode.TrackDel);
        const to = point ? from : tr.changes.mapPos(p.to, 1, MapMode.TrackDel);
        return from == null || to == null ? null : { ...p, from, to: Math.max(from, to) };
      }).filter(Boolean); // the spot itself was deleted (e.g. the whole text was replaced by a reload): give up
    }
    for (const e of tr.effects) {
      if (e.is(addPending)) out = [...out, e.value];
      else if (e.is(dropPending)) out = out.filter((p) => p.id !== e.value);
    }
    return out;
  },
});
let pendingSeq = 0;

/** A transaction that puts text where pending insert `id` is, or null if that spot no longer exists. */
function pendingInsertSpec(state, id, text) {
  const list = state.field(pendingField, false) || [];
  const p = list.find((x) => x.id === id);
  if (!p) return null;
  const sel = state.selection.main;
  const cursorThere = sel.empty && sel.head === p.from;
  return {
    changes: { from: p.from, to: p.to, insert: text },
    effects: dropPending.of(id),
    ...(cursorThere ? { selection: { anchor: p.from + text.length } } : {}),
  };
}

/**
 * Create an editor.
 * opts: { parent, doc, onChange(text), onScroll(topLine), onPasteImage(file, pendingId), lineWrap }
 * onPasteImage saves the image and later calls insertPending(state-owner, pendingId, link) or cancelPending.
 */
export function createEditor(opts) {
  const wrapComp = new Compartment();
  const numbersComp = new Compartment();
  const extensions = [
        numbersComp.of(opts.lineNumbers === false ? [] : [lineNumbers(), highlightActiveLineGutter()]),
        highlightSpecialChars(),
        pendingField,
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(mdHighlight),
        wrapComp.of(opts.lineWrap === false ? [] : EditorView.lineWrapping),
        EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on', autocapitalize: 'on' }),
        keymap.of([...formatKeys, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => { if (u.docChanged) opts.onChange(u.state.doc.toString()); }),
        EditorView.domEventHandlers({
          scroll: () => { if (opts.onScroll) opts.onScroll(topLine()); },
          paste: (e) => {
            const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
            const img = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
            if (!img || !opts.onPasteImage) return false;
            e.preventDefault();
            const file = img.getAsFile();
            const r = view.state.selection.main;
            opts.onPasteImage(file, markPending(r.from, r.to), '');
            return true;
          },
          drop: (e) => {
            const files = e.dataTransfer ? Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/')) : [];
            if (!files.length || !opts.onPasteImage) return false;
            e.preventDefault();
            const at = view.posAtCoords({ x: e.clientX, y: e.clientY });
            const pos = at != null ? at : view.state.selection.main.head;
            view.dispatch({ selection: { anchor: pos } });
            // One spot per image, all at the drop point; a point spot moves past text inserted at it, so the links
            // end up in drop order. Saved one after another.
            const ids = files.map(() => markPending(pos, pos));
            files.reduce((p, f, i) => p.then(() => opts.onPasteImage(f, ids[i], '\n')), Promise.resolve());
            return true;
          },
        }),
      ];
  const makeState = (doc) => EditorState.create({ doc, extensions });
  const view = new EditorView({ parent: opts.parent, state: makeState(opts.doc) });

  function topLine() {
    const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop + 4);
    return view.state.doc.lineAt(block.from).number - 1; // 0-based
  }

  function markPending(from, to) {
    const id = ++pendingSeq;
    view.dispatch({ effects: addPending.of({ id, from, to }) });
    return id;
  }

  function insertText(text) {
    const r = view.state.selection.main;
    view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length } });
    view.focus();
  }

  return {
    view,
    getText: () => view.state.doc.toString(),
    setText(text, keepScroll = true) {
      const top = view.scrollDOM.scrollTop;
      const sel = view.state.selection.main.head;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: Math.min(sel, text.length) } });
      if (keepScroll) view.scrollDOM.scrollTop = top;
    },
    focus: () => view.focus(),
    makeState,
    getState: () => view.state,
    setState: (st) => view.setState(st),
    scrollTop: () => view.scrollDOM.scrollTop,
    setScrollTop: (v) => { view.scrollDOM.scrollTop = v; },
    topLine,
    scrollToLine(line0) {
      const n = Math.max(1, Math.min(view.state.doc.lines, line0 + 1));
      const block = view.lineBlockAt(view.state.doc.line(n).from);
      view.scrollDOM.scrollTop = block.top;
    },
    gotoLine(line0) {
      const n = Math.max(1, Math.min(view.state.doc.lines, line0 + 1));
      const l = view.state.doc.line(n);
      view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
      view.focus();
    },
    insertText,
    /** Pending image spots (see pendingField). `state` is a document's EditorState: the one shown, or a stored one. */
    hasPending: (state, id) => !!(state.field(pendingField, false) || []).find((x) => x.id === id),
    /** Insert into the document shown in the view. False if the spot is gone. */
    insertPending(id, text) {
      const spec = pendingInsertSpec(view.state, id, text);
      if (!spec) return false;
      view.dispatch(spec);
      return true;
    },
    /** Insert into a stored (background) state; returns the new state, or null if the spot is gone. */
    insertPendingIn(state, id, text) {
      const spec = pendingInsertSpec(state, id, text);
      return spec ? state.update(spec).state : null;
    },
    cancelPending(state, id) {
      if (state === view.state) { view.dispatch({ effects: dropPending.of(id) }); return view.state; }
      return state.update({ effects: dropPending.of(id) }).state;
    },
    format(cmd) {
      const k = formatKeys.find((f) => f.key === cmd);
      if (k) { k.run(view); view.focus(); }
    },
    undo() { undo(view); view.focus(); },
    redo() { redo(view); view.focus(); },
    history: () => ({ undo: undoDepth(view.state), redo: redoDepth(view.state) }),
    stats() {
      const s = view.state;
      const head = s.selection.main.head;
      const line = s.doc.lineAt(head);
      return { line: line.number, col: head - line.from + 1, lines: s.doc.lines };
    },
    setLineWrap(on) { view.dispatch({ effects: wrapComp.reconfigure(on ? EditorView.lineWrapping : []) }); },
    setLineNumbers(on) { view.dispatch({ effects: numbersComp.reconfigure(on ? [lineNumbers(), highlightActiveLineGutter()] : []) }); },
    destroy: () => view.destroy(),
  };
}
