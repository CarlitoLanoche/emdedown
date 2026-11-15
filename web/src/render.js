// Markdown -> sanitized HTML, plus lazy enhancements (math, diagrams, copy buttons, callouts).
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import { full as emoji } from 'markdown-it-emoji';
import deflist from 'markdown-it-deflist';
import mark from 'markdown-it-mark';
import sub from 'markdown-it-sub';
import sup from 'markdown-it-sup';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import { fileUrl } from './host.js';
import { resolve, isBlockedRemote } from './paths.js';

/**
 * Every `id` (and every `<a name>`) in document content is rewritten to ID_PREFIX + original, so a
 * heading such as "## Slides" can never shadow the app's own #slides, #modal, #start ... elements.
 * `href="#x"` links stay unprefixed; whoever resolves an anchor adds the prefix.
 * The `headings` array returned by render() carries the unprefixed slug.
 */
export const ID_PREFIX = 'mdv-';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- markdown-it setup ----------
const md = new MarkdownIt({ html: true, linkify: true, typographer: true });
md.use(footnote).use(emoji).use(deflist).use(mark).use(sub).use(sup);
md.use(mathPlugin).use(wikiLinkPlugin);
md.linkify.set({ fuzzyEmail: false });

// Source line numbers on block elements (used for sync-scroll, search jumps, task toggles).
let lineOffset = 0;
const LINE_TOKENS = ['paragraph_open', 'heading_open', 'blockquote_open', 'list_item_open', 'table_open', 'tr_open', 'hr', 'dl_open', 'bullet_list_open', 'ordered_list_open', 'html_block'];
md.core.ruler.push('source_lines', (state) => {
  for (const t of state.tokens) {
    if (t.map && t.level <= 3 && LINE_TOKENS.includes(t.type)) t.attrSet('data-line', String(t.map[0] + lineOffset));
  }
});

// Heading ids + outline.
let headings = [];
md.core.ruler.push('heading_ids', (state) => {
  const next = new Map(); // base slug -> next suffix to try
  const used = new Set(); // every id emitted so far, so "Foo", "Foo", "Foo-1" get foo, foo-1, foo-1-1
  const toks = state.tokens;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].type !== 'heading_open') continue;
    const inline = toks[i + 1];
    const text = inline.children ? inline.children.filter((c) => c.type === 'text' || c.type === 'code_inline' || c.type === 'emoji').map((c) => c.content).join('') : inline.content;
    const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
    let slug = base;
    let n = next.get(base) || 0;
    if (used.has(slug)) { do { n = n || 1; slug = base + '-' + n++; } while (used.has(slug)); }
    next.set(base, n);
    used.add(slug);
    toks[i].attrSet('id', slug);
    headings.push({ level: Number(toks[i].tag.slice(1)), text, id: slug, line: toks[i].map ? toks[i].map[0] + lineOffset : 0 });
  }
});

// GitHub-style task lists: "- [ ] item" -> checkbox (clickable; toggles the source line).
// The renderer's own boxes carry TASK_KEY, a random value made fresh in every session. A document cannot know it,
// so a hand-written <input class="task" data-task-line="N"> in raw HTML loses its line number in the sanitizer
// and is shown disabled: it can never tick (and autosave) some other line.
const TASK_KEY = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
md.core.ruler.push('task_lists', (state) => {
  const toks = state.tokens;
  for (let i = 2; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== 'inline' || toks[i - 1].type !== 'paragraph_open' || toks[i - 2].type !== 'list_item_open') continue;
    const m = /^\[([ xX])\]\s+/.exec(t.content);
    if (!m || !t.children.length || t.children[0].type !== 'text') continue;
    t.children[0].content = t.children[0].content.replace(/^\[[ xX]\]\s+/, '');
    const box = new state.Token('html_inline', '', 0);
    const line = toks[i - 2].map ? toks[i - 2].map[0] + lineOffset : -1;
    box.content = `<input type="checkbox" class="task" data-task-line="${line}" data-task-key="${TASK_KEY}"${m[1] === ' ' ? '' : ' checked'}>`;
    t.children.unshift(box);
    toks[i - 2].attrJoin('class', 'task-item');
  }
});

// Code fences: syntax highlight, mermaid & math placeholders.
md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx];
  const info = (t.info || '').trim();
  const lang = info.split(/\s+/)[0].toLowerCase();
  const line = t.map ? ` data-line="${t.map[0] + lineOffset}"` : '';
  const code = t.content;
  if (lang === 'mermaid') return `<div class="mermaid-block"${line}><pre class="mermaid-src">${esc(code)}</pre></div>`;
  if (lang === 'math' || lang === 'latex' || lang === 'katex') return `<div class="math-block"${line}>${esc(code)}</div>`;
  let body;
  if (lang && hljs.getLanguage(lang)) {
    try { body = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch { body = esc(code); }
  } else body = esc(code);
  const label = lang ? `<span class="code-lang">${esc(lang)}</span>` : '';
  return `<div class="code-block"${line}>${label}<pre><code class="hljs${lang ? ' language-' + esc(lang) : ''}">${body}</code></pre></div>`;
};
md.renderer.rules.code_block = (tokens, idx) => {
  const t = tokens[idx];
  const line = t.map ? ` data-line="${t.map[0] + lineOffset}"` : '';
  return `<div class="code-block"${line}><pre><code class="hljs">${esc(t.content)}</code></pre></div>`;
};

// Tables get a scroll wrapper.
md.renderer.rules.table_open = (tokens, idx, opts, env, self) => '<div class="table-wrap">' + self.renderToken(tokens, idx, opts);
md.renderer.rules.table_close = (tokens, idx, opts, env, self) => self.renderToken(tokens, idx, opts) + '</div>';

// ---------- inline/block math: $..$ and $$..$$ ----------
function mathPlugin(mdi) {
  mdi.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    const src = state.src;
    let pos = state.pos;
    if (src[pos] !== '$') return false;
    if (src[pos + 1] === '$') { // inline $$..$$ display
      const end = src.indexOf('$$', pos + 2);
      if (end < 0) return false;
      if (!silent) { const tk = state.push('math_display_inline', 'span', 0); tk.content = src.slice(pos + 2, end); }
      state.pos = end + 2;
      return true;
    }
    const next = src[pos + 1];
    if (!next || /\s/.test(next)) return false;
    let end = pos + 1;
    while ((end = src.indexOf('$', end)) >= 0) {
      if (src[end - 1] === '\\') { end++; continue; }
      break;
    }
    if (end < 0 || /\s/.test(src[end - 1]) || /\d/.test(src[end + 1] || '')) return false;
    if (!silent) { const tk = state.push('math_inline', 'span', 0); tk.content = src.slice(pos + 1, end); }
    state.pos = end + 1;
    return true;
  });
  mdi.block.ruler.after('blockquote', 'math_block', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    const first = state.src.slice(start, max);
    if (!first.startsWith('$$')) return false;
    if (silent) return true;
    let content;
    let line = startLine;
    const rest = first.slice(2);
    if (rest.trim().endsWith('$$') && rest.trim().length >= 2) {
      content = rest.trim().slice(0, -2);
    } else {
      const lines = [rest];
      let found = false;
      for (line = startLine + 1; line < endLine; line++) {
        const l = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
        if (l.trim().endsWith('$$')) { lines.push(l.trim().slice(0, -2)); found = true; break; }
        lines.push(l);
      }
      if (!found) return false;
      content = lines.join('\n');
    }
    const tk = state.push('math_block', 'div', 0);
    tk.block = true;
    tk.content = content;
    tk.map = [startLine, line + 1];
    state.line = line + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  mdi.renderer.rules.math_inline = (t, i) => `<span class="math-inline">${esc(t[i].content)}</span>`;
  mdi.renderer.rules.math_display_inline = (t, i) => `<span class="math-inline display">${esc(t[i].content)}</span>`;
  mdi.renderer.rules.math_block = (t, i) => `<div class="math-block" data-line="${t[i].map[0] + lineOffset}">${esc(t[i].content)}</div>`;
}

// ---------- [[Wiki Links]] ----------
function wikiLinkPlugin(mdi) {
  mdi.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const src = state.src;
    if (!src.startsWith('[[', state.pos)) return false;
    const end = src.indexOf(']]', state.pos + 2);
    if (end < 0) return false;
    const inner = src.slice(state.pos + 2, end);
    if (!inner || inner.includes('\n')) return false;
    if (!silent) {
      const [target, label] = inner.split('|');
      const tk = state.push('wikilink', 'a', 0);
      tk.meta = { target: target.trim(), label: (label || target).trim() };
    }
    state.pos = end + 2;
    return true;
  });
  mdi.renderer.rules.wikilink = (t, i) => {
    const { target, label } = t[i].meta;
    return `<a class="wikilink" href="#" data-wiki="${esc(target)}">${esc(label)}</a>`;
  };
}

// ---------- front matter ----------
const FM = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
function parseFrontMatter(text) {
  const m = FM.exec(text);
  if (!m) return { meta: null, body: text, lines: 0 };
  const meta = [];
  let cur = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const kv = /^([\w .-]+):\s*(.*)$/.exec(raw);
    if (kv) { cur = { key: kv[1].trim(), value: kv[2].replace(/^["']|["']$/g, '') }; meta.push(cur); }
    else if (cur && /^\s*-\s+/.test(raw)) cur.value += (cur.value ? ', ' : '') + raw.replace(/^\s*-\s+/, '').replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length), lines: m[0].split('\n').length - 1 };
}

// ---------- sanitize (and rewrite local URLs) ----------
let currentBase = '';

// Class names the renderer (and its plugins) emit before sanitizing and that doc.css styles.
// Anything else (e.g. the app's own .overlay) is removed, so a document cannot borrow UI styling.
// Classes added after sanitizing by enhance() (callout, copy-btn, anchor, katex...) are unaffected.
const CLASS_ALLOW = new Set([
  'hljs', 'code-block', 'code-lang', 'mermaid-block', 'mermaid-src', 'math-inline', 'math-block', 'display',
  'task', 'task-item', 'table-wrap', 'front-matter', 'wikilink',
  'footnote-ref', 'footnote-backref', 'footnotes', 'footnotes-sep', 'footnotes-list', 'footnote-item',
]);
// hljs-*, language-*, and highlight.js sub-scope classes such as "function_", "class_", "inherited__".
const CLASS_ALLOW_RE = /^(?:hljs-[\w-]+|language-[\w+#.-]+|[a-z]+_+)$/;
const ALIGN_VALUES = new Set(['left', 'right', 'center']);

/** Keep only a `text-align: left|right|center` declaration (markdown-it's table alignment). */
function cleanStyle(value) {
  let align = null;
  for (const decl of value.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim().toLowerCase();
    if (prop === 'text-align' && ALIGN_VALUES.has(val)) align = val;
  }
  return align ? 'text-align:' + align : null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_URL_REF = /url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g;
const MEDIA_SRC_TAGS =new Set(['IMG', 'VIDEO', 'AUDIO', 'SOURCE']);
const FILE_HOST = /^https:\/\/file\.emdedown\//i;

/** Rewrite a local media reference to a file.emdedown URL; returns false if it is a blocked network path. */
function rewriteMedia(node, attr) {
  const val = node.getAttribute(attr) || '';
  if (!val) return true;
  if (FILE_HOST.test(val)) {
    // A document pointing at the file host directly: still apply the network-path rule.
    let p = val.replace(FILE_HOST, '').split(/[?#]/)[0];
    try { p = decodeURIComponent(p); } catch { /* keep raw */ }
    if (isBlockedRemote(currentBase, p)) { node.removeAttribute(attr); return false; }
    return true;
  }
  if (/^(https?:|data:|blob:)/i.test(val)) return true;
  const ref = val.split(/[?#]/)[0];
  if (isBlockedRemote(currentBase, ref)) { node.removeAttribute(attr); node.removeAttribute('data-orig-src'); return false; }
  if (attr === 'src') node.setAttribute('data-orig-src', val);
  node.setAttribute(attr, fileUrl(resolve(currentBase, ref)));
  return true;
}

// A private DOMPurify instance: mermaid sanitizes its own SVG output (and labels) with the shared
// default instance, and these document hooks (id prefixing, class/style filtering) must not touch that.
const purify = DOMPurify(window);

// Only the renderer's own task checkbox survives as an <input>; every other input is dropped.
purify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName !== 'input') return;
  const ok = (node.getAttribute('type') || '').toLowerCase() === 'checkbox' && node.classList.contains('task');
  if (!ok) { node.remove(); return; }
  if (node.getAttribute('data-task-key') !== TASK_KEY) {
    // Written by the document, not by the task-list rule: show it, but it controls nothing.
    node.removeAttribute('data-task-line');
    node.setAttribute('disabled', '');
  }
  node.removeAttribute('data-task-key');
});

purify.addHook('afterSanitizeAttributes', (node) => {
  // Namespace ids so document content can never collide with the app's element ids.
  const id = node.getAttribute('id');
  if (id) node.setAttribute('id', ID_PREFIX + id);
  if (node.tagName === 'A') {
    const name = node.getAttribute('name');
    if (name) node.setAttribute('name', ID_PREFIX + name);
  }
  // Inline SVG refers to its own ids (fill="url(#grad)", <textPath href="#p">): keep those pointing at the
  // prefixed ids. Links (<a>) are left alone; the app's click handler resolves them.
  if (node.namespaceURI === SVG_NS && node.localName !== 'a') {
    for (const at of Array.from(node.attributes)) {
      let v = at.value;
      if (at.localName === 'href') { if (v.startsWith('#')) v = '#' + ID_PREFIX + v.slice(1); }
      else if (v.includes('url(')) v = v.replace(SVG_URL_REF, (m, q, ref) => `url(#${ID_PREFIX}${ref})`);
      if (v !== at.value) at.value = v;
    }
  }
  // Inline styles: only table-cell alignment.
  if (node.hasAttribute('style')) {
    const st = cleanStyle(node.getAttribute('style') || '');
    if (st) node.setAttribute('style', st); else node.removeAttribute('style');
  }
  // Classes: allowlist only.
  if (node.hasAttribute('class')) {
    const keep = (node.getAttribute('class') || '').split(/\s+/).filter((c) => c && (CLASS_ALLOW.has(c) || CLASS_ALLOW_RE.test(c)));
    if (keep.length) node.setAttribute('class', keep.join(' ')); else node.removeAttribute('class');
  }
  // Local media through the file host; UNC / protocol-relative network paths are blocked.
  if (MEDIA_SRC_TAGS.has(node.tagName)) {
    if (node.tagName === 'IMG' || node.tagName === 'SOURCE') node.removeAttribute('srcset');
    const ok = rewriteMedia(node, 'src');
    if (node.tagName === 'VIDEO') rewriteMedia(node, 'poster');
    if (!ok) {
      node.setAttribute('title', node.tagName === 'IMG' ? 'Blocked network image' : 'Blocked network media');
      if (node.tagName === 'IMG') node.setAttribute('alt', 'Blocked network image');
    }
  }
  if (node.tagName === 'IMG') {
    node.setAttribute('loading', 'lazy');
    node.setAttribute('decoding', 'async');
  }
  if (node.tagName === 'A' && node.hasAttribute('href')) node.removeAttribute('target');
});
const PURIFY = {
  ADD_ATTR: ['data-line', 'data-wiki', 'data-task-line', 'data-orig-src'],
  // 'input' stays allowed: the uponSanitizeElement hook keeps only the task checkbox.
  // 'area'/'map' are dropped too: image-map links would bypass the app's link click handler.
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'dialog', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'area', 'map'],
  ADD_TAGS: [],
};

/**
 * Render markdown text.
 * @returns {{html:string, headings:Array, meta:Array|null, hasMath:boolean, hasMermaid:boolean}}
 */
export function render(text, baseDir, asFragment = false) {
  const t0 = performance.now();
  const fm = parseFrontMatter(text);
  lineOffset = fm.lines;
  headings = [];
  currentBase = baseDir || '';
  let html = md.render(fm.body);
  if (fm.meta && fm.meta.length) {
    const rows = fm.meta.map((r) => `<tr><th>${esc(r.key)}</th><td>${esc(r.value)}</td></tr>`).join('');
    html = `<div class="front-matter" data-line="0"><table>${rows}</table></div>` + html;
  }
  const t1 = performance.now();
  // A fragment avoids serializing + re-parsing the whole document (big win for large files).
  const clean = purify.sanitize(html, asFragment ? { ...PURIFY, RETURN_DOM_FRAGMENT: true } : PURIFY);
  return { html: asFragment ? null : clean, fragment: asFragment ? clean : null, headings, meta: fm.meta, parseMs: t1 - t0, sanitizeMs: performance.now() - t1 };
}

// ---------- incremental DOM update ----------
const LINE_ATTR = / data-(?:task-)?line="-?\d+"/g;
/**
 * Replace only the top-level blocks that changed. Returns the list of new/changed nodes.
 * Blocks are matched from the start and from the end, so adding or removing a paragraph replaces just the
 * blocks around the edit. (Matching by position would rebuild every block after it: images reload and
 * diagrams re-render at placeholder height, which shrinks the page and makes the preview jump.)
 */
export function patch(container, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const keep = (n) => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim());
  const next = Array.from(tpl.content.childNodes).filter(keep);
  // A full render leaves whitespace text and comments between blocks; drop them so both lists line up.
  for (const n of Array.from(container.childNodes)) if (!keep(n)) n.remove();
  const prev = Array.from(container.childNodes);
  const keyOf = (n) => (n._key !== undefined ? n._key : (n._key = (n.outerHTML || n.textContent).replace(LINE_ATTR, '')));
  for (const b of next) b._key = (b.outerHTML || b.textContent).replace(LINE_ATTR, '');
  let start = 0;
  while (start < prev.length && start < next.length && keyOf(prev[start]) === next[start]._key) { syncLines(prev[start], next[start]); start++; }
  let endP = prev.length - 1;
  let endN = next.length - 1;
  while (endP >= start && endN >= start && keyOf(prev[endP]) === next[endN]._key) { syncLines(prev[endP], next[endN]); endP--; endN--; }
  const anchor = prev[endP + 1] || null; // first unchanged block after the edit (stays in place)
  for (let i = start; i <= endP; i++) prev[i].remove();
  const changed = [];
  for (let i = start; i <= endN; i++) { container.insertBefore(next[i], anchor); changed.push(next[i]); }
  return changed;
}
/**
 * After a full render, before enhance(): remember each block's rendered HTML as its patch key. enhance() adds
 * anchors, copy buttons and drawn diagrams, so a key taken later from the live DOM would never match a fresh
 * render, and the first edit would rebuild the whole document.
 */
export function stampKeys(container) {
  for (const n of Array.from(container.childNodes)) {
    if (n.nodeType === 1) n._key = n.outerHTML.replace(LINE_ATTR, '');
    else if (n.nodeType === 3 && n.textContent.trim()) n._key = n.textContent;
    else n.remove();
  }
}
function syncLines(a, b) {
  if (a.nodeType !== 1) return;
  const la = a.querySelectorAll('[data-line],[data-task-line]');
  const lb = b.querySelectorAll('[data-line],[data-task-line]');
  if (a.hasAttribute('data-line')) a.setAttribute('data-line', b.getAttribute('data-line'));
  for (let i = 0; i < la.length && i < lb.length; i++) {
    if (lb[i].hasAttribute('data-line')) la[i].setAttribute('data-line', lb[i].getAttribute('data-line'));
    if (lb[i].hasAttribute('data-task-line')) la[i].setAttribute('data-task-line', lb[i].getAttribute('data-task-line'));
  }
}

// ---------- post-render enhancements ----------
const CALLOUTS = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };
const ICONS = {
  NOTE: '<svg viewBox="0 0 16 16"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>',
  TIP: '<svg viewBox="0 0 16 16"><path d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z"/></svg>',
  IMPORTANT: '<svg viewBox="0 0 16 16"><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>',
  WARNING: '<svg viewBox="0 0 16 16"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>',
  CAUTION: '<svg viewBox="0 0 16 16"><path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>',
};

let katexMod = null;
let mermaidMod = null;
let mermaidCount = 0;
const MERMAID_ID = 'mdvmmd-';

// Math and diagrams are rendered lazily, when they come near the viewport (keeps huge documents fast).
let currentTheme = 'light';
let observer = null;
const pendingMath = new Set();
const pendingDiagrams = new Set();
let flushQueued = false;

export function setScrollRoot(rootEl) {
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      observer.unobserve(e.target);
      if (e.target.classList.contains('mermaid-block')) pendingDiagrams.add(e.target);
      else pendingMath.add(e.target);
    }
    queueFlush();
  }, { root: rootEl, rootMargin: '1500px 0px' });
}
function queueFlush() {
  if (flushQueued) return;
  flushQueued = true;
  requestAnimationFrame(async () => {
    flushQueued = false;
    const m = Array.from(pendingMath); pendingMath.clear();
    const d = Array.from(pendingDiagrams); pendingDiagrams.clear();
    if (m.length) await renderMath(m);
    if (d.length) await renderDiagrams(d, currentTheme);
  });
}

/** Upgrade freshly inserted nodes. `theme` is 'dark' or 'light' (for diagrams). */
export async function enhance(nodes, theme) {
  currentTheme = theme;
  const math = [];
  const diagrams = [];
  for (const root of nodes) {
    if (root.nodeType !== 1) continue;
    const q = (sel) => (root.matches(sel) ? [root] : []).concat(Array.from(root.querySelectorAll(sel)));
    q('blockquote').forEach(callout);
    q('.code-block').forEach(addCopyButton);
    q('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]').forEach(addAnchor);
    math.push(...q('.math-inline,.math-block'));
    diagrams.push(...q('.mermaid-block'));
  }
  if (observer) {
    for (const n of math) observer.observe(n);
    for (const n of diagrams) observer.observe(n);
    return;
  }
  if (math.length) await renderMath(math);
  if (diagrams.length) await renderDiagrams(diagrams, theme);
}

/** Render everything that is still waiting (before export, print or slides). */
export async function renderAllPending(container) {
  const math = Array.from(container.querySelectorAll('.math-inline:not([data-done]),.math-block:not([data-done])'));
  const diagrams = Array.from(container.querySelectorAll('.mermaid-block')).filter((b) => !b.querySelector('svg') && b.querySelector('.mermaid-src') && !b.querySelector('.diagram-error'));
  if (observer) [...math, ...diagrams].forEach((n) => observer.unobserve(n));
  if (math.length) await renderMath(math);
  if (diagrams.length) await renderDiagrams(diagrams, currentTheme);
}

function callout(bq) {
  const p = bq.firstElementChild;
  if (!p || p.tagName !== 'P') return;
  const m = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(p.innerHTML);
  if (!m) return;
  const kind = m[1].toUpperCase();
  p.innerHTML = p.innerHTML.slice(m[0].length).replace(/^<br>\s*/, '');
  if (!p.innerHTML.trim()) p.remove();
  bq.classList.add('callout', 'callout-' + kind.toLowerCase());
  const title = document.createElement('p');
  title.className = 'callout-title';
  title.innerHTML = ICONS[kind] + CALLOUTS[kind];
  bq.prepend(title);
}

function addCopyButton(block) {
  if (block.querySelector('.copy-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.title = 'Copy code';
  btn.textContent = 'Copy';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const code = block.querySelector('code');
    navigator.clipboard.writeText(code ? code.innerText : '').then(() => {
      btn.textContent = 'Copied!';
      btn.classList.add('ok');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('ok'); }, 1200);
    });
  });
  block.appendChild(btn);
}

function addAnchor(h) {
  if (h.querySelector('.anchor')) return;
  const a = document.createElement('a');
  a.className = 'anchor';
  // h.id carries ID_PREFIX; in-document links use the unprefixed slug.
  a.href = '#' + (h.id.startsWith(ID_PREFIX) ? h.id.slice(ID_PREFIX.length) : h.id);
  a.setAttribute('aria-label', 'Link to this section');
  a.textContent = '#';
  h.prepend(a);
}

async function renderMath(els) {
  if (!katexMod) {
    const [k] = await Promise.all([import('katex'), loadCss('katex.css')]);
    katexMod = k.default || k;
  }
  for (const el of els) {
    if (el.dataset.done) continue;
    const tex = el.textContent;
    el.dataset.tex = tex;
    try {
      katexMod.render(tex, el, { displayMode: el.classList.contains('math-block') || el.classList.contains('display'), throwOnError: false, output: 'htmlAndMathml' });
    } catch (e) { el.classList.add('math-error'); el.title = String(e.message || e); }
    el.dataset.done = '1';
  }
}

async function renderDiagrams(els, theme) {
  if (!mermaidMod) {
    const m = await import('mermaid');
    mermaidMod = m.default || m;
  }
  // htmlLabels:false -> plain SVG text, so diagrams can also be rasterized for Word export.
  mermaidMod.initialize({ startOnLoad: false, theme: theme === 'dark' ? 'dark' : 'default', securityLevel: 'strict', fontFamily: 'Segoe UI, sans-serif', htmlLabels: false, flowchart: { htmlLabels: false } });
  for (const el of els) {
    const srcEl = el.querySelector('.mermaid-src');
    if (!srcEl) continue;
    const src = srcEl.textContent;
    try {
      // Render ids live in their own "mdvmmd-" namespace: app ids never use it, and every document
      // id starts with ID_PREFIX ("mdv-"), so neither can collide with a diagram (or its marker ids).
      const { svg } = await mermaidMod.render(MERMAID_ID + (++mermaidCount), src);
      // securityLevel 'strict' makes mermaid sanitize labels itself (it uses DOMPurify internally);
      // a second generic pass would strip the HTML labels inside <foreignObject>.
      el.innerHTML = svg;
      el.dataset.src = src;
    } catch (e) {
      el.innerHTML = `<div class="diagram-error"><b>Diagram error:</b> ${esc(String(e.message || e))}</div><pre class="mermaid-src">${esc(src)}</pre>`;
    }
    // mermaid leaves temp nodes behind on errors
    document.querySelectorAll(`body > [id^="d${MERMAID_ID}"]`).forEach((n) => n.remove());
  }
}

/** Re-render all diagrams (theme change). */
export async function rerenderDiagrams(container, theme) {
  currentTheme = theme;
  const blocks = Array.from(container.querySelectorAll('.mermaid-block')).filter((b) => b.dataset.src);
  for (const b of blocks) {
    b.innerHTML = `<pre class="mermaid-src">${esc(b.dataset.src)}</pre>`;
    if (observer) observer.observe(b);
  }
  if (!observer && blocks.length) await renderDiagrams(blocks, theme);
}

const loadedCss = new Set();
export function loadCss(href) {
  if (loadedCss.has(href)) return Promise.resolve();
  loadedCss.add(href);
  return new Promise((res) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onload = l.onerror = () => res();
    document.head.appendChild(l);
  });
}

export function highlightLanguages() { return hljs.listLanguages(); }
