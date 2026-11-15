// Emdedown — main UI.
import { call, on, isHosted, sendDroppedFiles, fileUrl } from './host.js';
import { render, patch, stampKeys, enhance, rerenderDiagrams, loadCss, setScrollRoot, renderAllPending, ID_PREFIX } from './render.js';
import { dirname, basename, stripExt, resolve, relative, MD_EXT, isBlockedRemote } from './paths.js';
import { fuzzy } from './fuzzy.js';
import { startSlides } from './slides.js';
import { exportHtml, exportDocx } from './export.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
};
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------- state ----------------
const DEFAULTS = {
  theme: 'github', appearance: 'system', font: 'sans', fontSize: 16, width: 'medium', lineHeight: 1.65,
  sidebar: true, sidebarPanel: 'outline', sidebarWidth: 270, splitRatio: 0.5,
  defaultMode: 'preview', autosave: false, lineNumbers: true, lineWrap: true, syncScroll: true,
  restoreSession: true, recent: [], session: null, folder: null, welcomeDone: false,
};
let S = { ...DEFAULTS };
let env = { installed: false, runningInstalled: false, version: '1.0.0', themes: [], themesDir: '' };
const tabs = [];
let active = null;
let editor = null; // lazy CodeMirror wrapper
let editorLoading = null;
let folderFiles = []; // flat list of {name, path}
let folderTree = null;
let suppressEditorChange = false;

const app = $('#app');
const docsEl = $('#docs');
const previewPane = $('#preview-pane');
const editorPane = $('#editor-pane');

// App chrome that lives after #docs in index.html. Resolved once, before any document is rendered,
// so ids inside rendered documents can never shadow these lookups.
const startEl = $('#start');
const findbarEl = $('#findbar');
const findInput = $('#find-input');
const findCount = $('#find-count');
const findPrevBtn = $('#find-prev');
const findNextBtn = $('#find-next');
const findCloseBtn = $('#find-close');
const stPath = $('#st-path');
const stCursor = $('#st-cursor');
const stWords = $('#st-words');
const stEol = $('#st-eol');
const stZoom = $('#st-zoom');
const paletteEl = $('#palette');
const paletteInput = $('#palette-input');
const paletteList = $('#palette-list');
const modalEl = $('#modal');
const modalBox = $('#modal-box');
const lightboxEl = $('#lightbox');
const slidesEl = $('#slides');
const toastEl = $('#toast');
const dropzoneEl = $('#dropzone');

// Only a folder the user chose explicitly is persisted; an automatically loaded one lives in S.folder only.
let explicitFolder = null;
const serializeSettings = () => JSON.stringify({ ...S, folder: explicitFolder });
const saveSettings = debounce(() => { call('saveSettings', { json: serializeSettings() }).catch(() => {}); }, 400);
function setSetting(k, v) { S[k] = v; saveSettings(); }

// ---------------- theme & typography ----------------
// Every theme has a light and a dark version. S.theme is the theme (or 'custom:<file>.css'); S.appearance is
// 'light', 'dark' or 'system' (follow Windows). The version shown is the theme's light or dark half, set as
// <html data-theme="..."> (ids match theme.css). bg/accent/fg are only used to draw the swatches.
const THEMES = [
  { id: 'github', name: 'GitHub', light: { id: 'light', bg: '#ffffff', accent: '#0969da', fg: '#1f2328' }, dark: { id: 'dark', bg: '#0d1117', accent: '#4493f8', fg: '#e6edf3' } },
  { id: 'sepia', name: 'Sepia', light: { id: 'sepia', bg: '#f6efe1', accent: '#a0522d', fg: '#3b3024' }, dark: { id: 'sepia-dark', bg: '#241d16', accent: '#d9935f', fg: '#e8dcc6' } },
  { id: 'solarized', name: 'Solarized', light: { id: 'solarized', bg: '#fdf6e3', accent: '#268bd2', fg: '#3d4f57' }, dark: { id: 'solarized-dark', bg: '#002b36', accent: '#268bd2', fg: '#a7b4b4' } },
  { id: 'nord', name: 'Nord', light: { id: 'nord-light', bg: '#eceff4', accent: '#5e81ac', fg: '#2e3440' }, dark: { id: 'nord', bg: '#2e3440', accent: '#88c0d0', fg: '#e5e9f0' } },
  { id: 'dracula', name: 'Dracula', light: { id: 'dracula-light', bg: '#fffbeb', accent: '#644ac9', fg: '#1f1f1f' }, dark: { id: 'dracula', bg: '#22212c', accent: '#bd93f9', fg: '#f8f8f2' } },
  { id: 'paper', name: 'Paper (serif)', light: { id: 'paper', bg: '#fcfcfa', accent: '#b5452a', fg: '#222222' }, dark: { id: 'paper-dark', bg: '#1c1b19', accent: '#e07b5f', fg: '#e4e1d8' } },
];
const APPEARANCES = [['light', 'Light'], ['dark', 'Dark'], ['system', 'Follow Windows']];
// Settings saved before themes had two versions stored one id per version in S.theme.
const OLD_THEME_IDS = { system: ['github', 'system'], light: ['github', 'light'], dark: ['github', 'dark'], sepia: ['sepia', 'light'],
  nord: ['nord', 'dark'], solarized: ['solarized', 'light'], dracula: ['dracula', 'dark'], paper: ['paper', 'light'] };
// No saved appearance = settings from before; e.g. old 'nord' meant Nord dark, old 'light' meant GitHub light.
function migrateThemeSetting(saved) {
  if (!saved.appearance) {
    const old = OLD_THEME_IDS[S.theme];
    S.appearance = old ? old[1] : 'system';
    if (old) S.theme = old[0];
  }
  if (!['light', 'dark', 'system'].includes(S.appearance)) S.appearance = 'system';
  if (typeof S.theme !== 'string' || (!S.theme.startsWith('custom:') && !THEMES.some((t) => t.id === S.theme))) S.theme = 'github';
}
const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
const themeOf = (id = S.theme) => THEMES.find((t) => t.id === id) || THEMES[0];
const wantsDark = () => (S.appearance === 'system' ? darkMQ.matches : S.appearance === 'dark');
/** The data-theme id currently shown, e.g. 'nord-light'. Custom themes sit on GitHub light/dark. */
function resolvedTheme() {
  if (S.theme.startsWith('custom:')) return S.theme;
  return themeOf()[wantsDark() ? 'dark' : 'light'].id;
}
function isDark() {
  if (S.theme.startsWith('custom:')) return /dark|night|black/i.test(S.theme);
  return wantsDark();
}
/** Little two-tone square for a theme: its light half and its dark half. */
function swatchStyle(t) {
  const L = t.light;
  const D = t.dark;
  return `background:linear-gradient(135deg, ${L.bg} 0 38%, ${L.accent} 38% 50%, ${D.accent} 50% 62%, ${D.bg} 62% 100%)`;
}
let lastDark = null;
function applyTheme() {
  const t = resolvedTheme();
  const custom = t.startsWith('custom:');
  document.documentElement.dataset.theme = custom ? (isDark() ? 'dark' : 'light') : t;
  let link = $('#custom-theme');
  if (custom) {
    const file = t.slice(7);
    if (!link) { link = el('link', { rel: 'stylesheet', id: 'custom-theme' }); document.head.appendChild(link); }
    link.href = fileUrl(env.themesDir + '\\' + file) + '?v=' + Date.now();
  } else if (link) link.remove();
  const dark = isDark();
  document.documentElement.classList.toggle('dark', dark);
  requestAnimationFrame(() => {
    const bg = getComputedStyle(document.body).getPropertyValue('--bg').trim() || (dark ? '#0d1117' : '#ffffff');
    call('setChrome', { dark, bg }).catch(() => {});
  });
  if (lastDark !== null && lastDark !== dark) tabs.forEach((tb) => tb.article && rerenderDiagrams(tb.article, dark ? 'dark' : 'light'));
  lastDark = dark;
}
darkMQ.addEventListener('change', () => { if (S.appearance === 'system') applyTheme(); });

function applyTypography() {
  const r = document.documentElement.style;
  r.setProperty('--doc-size', S.fontSize + 'px');
  r.setProperty('--doc-lh', S.lineHeight);
  const widths = { narrow: '680px', medium: '860px', wide: '1100px', full: '100%' };
  r.setProperty('--doc-width', widths[S.width] || widths.medium);
  const fonts = {
    sans: 'var(--font-sans)',
    serif: 'var(--font-serif)',
    mono: 'var(--font-mono)',
  };
  r.setProperty('--doc-font', fonts[S.font] || fonts.sans);
  stZoom.textContent = Math.round((S.fontSize / 16) * 100) + '%';
}

// ---------------- tabs ----------------
function makeTab({ path = null, text = '', eol = 'CRLF', mtime = null, enc = 'utf8' }) {
  const tab = {
    id: Math.random().toString(36).slice(2),
    // mtime is an opaque decimal string from the host (exceeds 2^53): never convert it to a number.
    path, text, savedText: path ? text : '', eol, mtime: mtime == null || mtime === '' ? null : String(mtime), enc: enc || 'utf8',
    title: path ? basename(path) : `Untitled-${nextUntitledNumber()}`,
    mode: S.defaultMode,
    article: el('article', { class: 'markdown-body' }),
    edState: null, edScroll: 0, scroll: 0,
    headings: [], rendered: false, renderedText: null,
  };
  if (!path) tab.mode = 'split';
  tab.article.hidden = true;
  docsEl.appendChild(tab.article);
  return tab;
}
/** Lowest number not used by an open untitled tab, so closing Untitled-2 frees "2" again. */
function nextUntitledNumber() {
  const used = new Set(tabs.filter((t) => !t.path).map((t) => +(/^Untitled-(\d+)$/.exec(t.title) || [])[1]).filter(Boolean));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}
const isDirty = (t) => t.text !== t.savedText || (!t.path && t.text.length > 0);

function renderTabs() {
  const box = $('#tabs');
  box.textContent = '';
  for (const t of tabs) {
    const b = el('div', {
      class: 'tab' + (t === active ? ' active' : '') + (isDirty(t) ? ' dirty' : ''),
      role: 'tab', title: t.path || t.title, draggable: 'true', 'data-id': t.id,
      onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t); } },
      onclick: () => activate(t),
      ondragstart: (e) => { e.dataTransfer.setData('text/x-tab', t.id); },
      ondragover: (e) => { if (e.dataTransfer.types.includes('text/x-tab')) e.preventDefault(); },
      ondrop: (e) => {
        const id = e.dataTransfer.getData('text/x-tab');
        if (!id) return;
        e.preventDefault(); e.stopPropagation();
        const from = tabs.findIndex((x) => x.id === id);
        const to = tabs.indexOf(t);
        if (from < 0 || from === to) return;
        const [m] = tabs.splice(from, 1);
        tabs.splice(to, 0, m);
        renderTabs(); saveSession();
      },
    },
    el('span', { class: 'tab-title' }, t.title),
    el('button', { class: 'tab-close', title: 'Close (Ctrl+W)', onclick: (e) => { e.stopPropagation(); closeTab(t); } }, el('span', { class: 'x' }, '×'), el('span', { class: 'dot' }, '●')));
    box.appendChild(b);
  }
  const act = box.querySelector('.tab.active');
  if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  updateChrome();
  updateTabsBar();
}

/** Fade out toolbar controls that do nothing right now (no document, nothing to save, nothing to undo). */
const modeSwitch = $('#mode-switch');
const btnSave = $('#btn-save');
const btnUndo = $('#btn-undo');
const btnRedo = $('#btn-redo');
const formatBar = $('#format-bar');
const btnSync = $('#btn-sync');
function updateChrome() {
  const t = active;
  modeSwitch.classList.toggle('disabled', !t);
  $$('button', modeSwitch).forEach((b) => { b.disabled = !t; });
  modeSwitch.title = t ? 'View mode (Ctrl+E)' : 'Open a document to switch between Read, Split and Edit';
  btnSave.disabled = !t || (!!t.path && !isDirty(t));
  const editing = !!(t && editor && t.mode !== 'preview' && editor.currentTab === t);
  const h = editing ? editor.history() : { undo: 0, redo: 0 };
  btnUndo.disabled = !h.undo;
  btnRedo.disabled = !h.redo;
  formatBar.hidden = !t || t.mode === 'preview';
  btnSync.hidden = !t || t.mode !== 'split';
  btnSync.classList.toggle('on', !!S.syncScroll);
  btnSync.title = S.syncScroll ? 'Sync scrolling is on: editor and preview follow each other (click to turn off)' : 'Sync scrolling is off (click to turn on)';
}

function activate(t) {
  if (!t) return;
  if (active && active !== t) {
    active.scroll = previewPane.scrollTop;
    if (editor && active.edState && editor.currentTab === active) { active.edState = editor.getState(); active.edScroll = editor.scrollTop(); }
    active.article.hidden = true;
    flushDraft(active);
  }
  active = t;
  recordVisit(t);
  t.article.hidden = false;
  startEl.hidden = true;
  if (!t.rendered || t.renderedText !== t.text) renderTab(t, true);
  setMode(t.mode, true);
  previewPane.scrollTop = t.scroll;
  renderTabs();
  updateOutline();
  updateStatus();
  highlightTreeActive();
  document.title = (isDirty(t) ? '● ' : '') + t.title + ' — Emdedown';
  call('setTitle', { title: document.title }).catch(() => {});
  if (t.path && S.folder == null && !folderClosed && !isBroadDir(dirname(t.path))) loadFolder(dirname(t.path));
  closeFind();
  showBanner(t.banner || null, t);
}

async function closeTab(t, force = false) {
  // Loop: if the user typed while the save was being written, the tab is dirty again; ask again.
  while (!force && isDirty(t)) {
    const r = await ask(`Save changes to “${t.title}”?`, 'Your changes will be lost if you don\'t save them.', [
      { label: 'Save', value: 'save', primary: true }, { label: "Don't save", value: 'discard' }, { label: 'Cancel', value: 'cancel' }]);
    if (r === 'cancel' || r == null) return false;
    if (r === 'save' && !(await saveTab(t))) return false;
    if (r === 'discard') { t.discarded = true; clearDraft(t); break; }
  }
  flushDraft(t); // no-op when the draft was just cleared (clearDraft cancels the pending write)
  cancelAutosave(t);
  const i = tabs.indexOf(t);
  if (i < 0) return true;
  tabs.splice(i, 1);
  t.article.remove();
  if (t.path) closedTabs.push(t.path);
  if (active === t) {
    active = null;
    if (tabs.length) activate(tabs[Math.min(i, tabs.length - 1)]);
    else showStart();
  }
  renderTabs();
  syncWatch();
  saveSession();
  return true;
}

/** Close several tabs; each unsaved one asks Save / Don't save / Cancel, and Cancel stops the rest. */
async function closeTabs(list) {
  for (const t of list) if (tabs.includes(t) && !(await closeTab(t))) return false;
  return true;
}

// Right-click a tab (or the empty part of the tab strip).
function tabMenu(t, x, y) {
  const i = t ? tabs.indexOf(t) : -1;
  const others = t ? tabs.filter((o) => o !== t) : [];
  const right = t ? tabs.slice(i + 1) : [];
  const saved = tabs.filter((o) => !isDirty(o));
  const items = [];
  if (t) {
    items.push({ label: 'Close', key: t === active ? 'Ctrl+W' : '', run: () => closeTab(t) });
    if (others.length) items.push({ label: 'Close other tabs', run: () => closeTabs(others) });
    if (right.length) items.push({ label: 'Close tabs to the right', run: () => closeTabs(right) });
  }
  if (saved.length) items.push({ label: 'Close saved tabs', run: () => closeTabs(saved) });
  if (tabs.length) items.push({ label: 'Close all tabs', run: () => closeTabs(tabs.slice()) });
  if (t && t.path) {
    items.push('sep',
      { label: 'Copy file path', run: () => { navigator.clipboard.writeText(t.path); toast('Path copied'); } },
      { label: 'Show in Explorer', run: () => call('reveal', { path: t.path }).catch((e) => toast(e.message, 'error')) });
  }
  if (t) items.push('sep', { label: 'Save', key: t === active ? 'Ctrl+S' : '', run: () => saveTab(t) });
  items.push('sep', { label: 'New document', key: 'Ctrl+N', run: () => newDoc() });
  if (closedTabs.length) items.push({ label: 'Reopen closed tab', key: 'Ctrl+Shift+T', run: () => cmd('reopen') });
  showMenu(x, y, items[0] === 'sep' ? items.slice(1) : items);
}

function showStart() {
  active = null;
  setMode('preview', true);
  const start = startEl;
  start.hidden = false;
  const recent = S.recent.slice(0, 10);
  start.innerHTML = '';
  start.append(
    el('div', { class: 'start-inner' },
      el('div', { class: 'logo', html: LOGO }),
      el('h1', {}, 'Emdedown'),
      el('p', { class: 'muted' }, 'A fast, beautiful Markdown reader & editor.'),
      el('div', { class: 'start-actions' },
        el('button', { class: 'btn primary', onclick: () => cmd('open') }, 'Open file…'),
        el('button', { class: 'btn', onclick: () => cmd('openFolder') }, 'Open folder…'),
        el('button', { class: 'btn', onclick: () => cmd('new') }, 'New document')),
      recent.length ? el('div', { class: 'recent' },
        el('div', { class: 'recent-head' }, el('h3', {}, 'Recent'), el('button', { class: 'link-btn', title: 'Remove all files from this list', onclick: () => clearRecent() }, 'Clear list')),
        ...recent.map((p) => el('div', { class: 'recent-row' },
          el('a', { href: '#', class: 'recent-item', title: p, onclick: (e) => { e.preventDefault(); openFile(p); } },
            el('b', {}, basename(p)), el('span', { class: 'muted' }, dirname(p))),
          el('button', { class: 'icon-btn small recent-x', title: 'Remove from list', 'aria-label': 'Remove ' + basename(p) + ' from recent files', onclick: () => removeRecent(p) }, '×')))) : null,
      el('p', { class: 'muted small hint' }, 'Tip: drag a .md file here · Ctrl+P quick open · Ctrl+Shift+P all commands · F1 shortcuts'),
      el('p', {}, el('a', { href: '#', class: 'install-link', onclick: (e) => { e.preventDefault(); openGuide(); } }, 'New to Emdedown or Markdown? Open the guide')),
      !env.runningInstalled ? el('p', {}, el('a', { href: '#', class: 'install-link', onclick: (e) => { e.preventDefault(); showWelcome(true); } }, env.installed ? 'Installed copy available — open settings' : 'Install Emdedown on this PC…')) : null,
    ));
  document.title = 'Emdedown';
  call('setTitle', { title: 'Emdedown' }).catch(() => {});
  updateOutline();
  updateStatus();
  updateChrome();
}

// ---------------- rendering ----------------
let renderSeq = 0;
function renderTab(t, full = false) {
  const base = t.path ? dirname(t.path) : (S.folder || '');
  const t0 = performance.now();
  const whole = full || !t.rendered;
  const r = render(t.text, base, whole);
  let changed;
  if (whole) {
    t.article.replaceChildren(r.fragment);
    // Keys for patch(); skipped for huge files (serializing them costs more than the occasional full rebuild).
    if (t.text.length < 3e6) stampKeys(t.article);
    changed = [t.article];
  }
  else changed = patch(t.article, r.html);
  t.timing = { parse: Math.round(r.parseMs), sanitize: Math.round(r.sanitizeMs) };
  t.headings = r.headings;
  t.article.classList.toggle('big', t.article.childElementCount > 1200);
  t.rendered = true;
  t.renderedText = t.text;
  t.lineEls = null;
  t.renderMs = performance.now() - t0;
  const seq = ++renderSeq;
  enhance(changed, isDark() ? 'dark' : 'light').then(() => { if (seq === renderSeq && t === active) updateProgress(); });
  if (t === active) { updateOutline(); updateStatus(); }
}

/** Pull the editor's latest text and re-render if the article/headings are stale (Edit mode has no live render). */
function ensureFresh(t = active) {
  if (!t) return;
  if (editor && t === active && t.edState && editor.currentTab === t) t.text = editor.getText();
  if (!t.rendered || t.renderedText !== t.text) {
    const s = t === active ? previewPane.scrollTop : null;
    renderTab(t);
    if (s != null) previewPane.scrollTop = s;
  }
}

/** Keep the editor in sync after a tab's text was replaced from outside the editor (reload, fileChanged). */
function syncEditorText(t) {
  if (!editor || !t.edState) return;
  if (t === active) { loadEditorState(t, true); return; }
  // Background tab: drop its stale editor state; a fresh one is built from t.text when it is shown again.
  t.edState = null;
  if (editor.currentTab === t) editor.currentTab = null;
}

// ---------------- opening / saving ----------------
async function openFile(path, opts = {}) {
  const existing = tabs.find((t) => t.path && t.path.toLowerCase() === path.toLowerCase());
  if (existing) { activate(existing); if (opts.anchor) scrollToAnchor(opts.anchor); if (opts.line != null) scrollToLine(opts.line); return existing; }
  let f;
  try { f = await readText(path); } catch (e) {
    toast('Could not open file: ' + e.message, 'error');
    S.recent = S.recent.filter((p) => p !== path); saveSettings();
    return null;
  }
  const t = makeTab(f);
  if (opts.mode) t.mode = opts.mode;
  const idx = active ? tabs.indexOf(active) + 1 : tabs.length;
  tabs.splice(idx, 0, t);
  const draft = loadDraft(t);
  if (draft != null && draft !== t.text) {
    t.text = draft;
    t.banner = { kind: 'info', text: 'Recovered unsaved changes from your last session.', actions: [
      { label: 'Keep', run: () => hideBanner(t) },
      { label: 'Discard', run: () => { t.text = t.savedText; clearDraft(t); renderTab(t, true); syncEditorText(t); renderTabs(); hideBanner(t); } }] };
  }
  addRecent(path);
  activate(t);
  syncWatch();
  saveSession();
  if (opts.anchor) setTimeout(() => scrollToAnchor(opts.anchor), 30);
  if (opts.line != null) setTimeout(() => scrollToLine(opts.line), 30);
  return t;
}

function removeRecent(path) {
  S.recent = S.recent.filter((p) => p.toLowerCase() !== path.toLowerCase());
  saveSettings();
  if (!active) showStart();
}
async function clearRecent() {
  if (!S.recent.length) { toast('The recent files list is already empty'); return; }
  const r = await ask('Clear recent files?', 'The list of recently opened files is emptied. The files themselves are not touched.', [
    { label: 'Clear list', value: 'yes', primary: true }, { label: 'Cancel', value: 'no' }]);
  if (r !== 'yes') return;
  S.recent = [];
  saveSettings();
  if (!active) showStart();
  toast('Recent files cleared');
}
function addRecent(path) {
  if (IMG_EXT.test(path)) return;
  S.recent = [path, ...S.recent.filter((p) => p.toLowerCase() !== path.toLowerCase())].slice(0, 20);
  saveSettings();
}

function newDoc(text = '') {
  const t = makeTab({ text });
  tabs.splice(active ? tabs.indexOf(active) + 1 : tabs.length, 0, t);
  activate(t);
  ensureEditor().then(() => editor && editor.focus());
  // List the new tab in the saved session right away: its draft is only recoverable through that list,
  // so a crash before the next session save would otherwise orphan it. (No-op while restoring a session.)
  saveSession();
  return t;
}

/**
 * Save a tab. opts.auto: called by autosave (a conflict sets a banner instead of prompting);
 * opts.force: overwrite even if the file changed on disk since we last read/saved it.
 * Saves of one tab run one after another (a second save waits for the first), so a slow write can never
 * be overtaken by a later one and each save sees the result of the previous.
 */
function saveTab(t, saveAs = false, opts = {}) {
  if (!t) return Promise.resolve(false);
  const run = () => saveTabNow(t, saveAs, opts);
  const p = (t.saving || Promise.resolve()).then(run, run);
  t.saving = p.catch(() => false);
  return p;
}

async function saveTabNow(t, saveAs = false, opts = {}) {
  if (editor && t === active && t.edState && editor.currentTab === t) t.text = editor.getText();
  let path = t.path;
  if (!path || saveAs) {
    const suggested = t.path ? basename(t.path) : (guessTitle(t.text) || t.title) + '.md';
    path = await call('saveDialog', { name: suggested, filter: 'md', dir: t.path ? dirname(t.path) : S.folder });
    if (!path) return false;
  }
  const samePath = !!t.path && path.toLowerCase() === t.path.toLowerCase();
  // Snapshot what is sent: the user may keep typing while the host writes the file.
  const sent = t.text;
  const args = { path, text: sent, eol: t.eol, enc: t.enc || 'utf8', force: !!opts.force };
  if (samePath && t.mtime != null) args.mtime = t.mtime;
  // Draft key before the path changes (Save As / first save of an untitled tab).
  const oldDraftKey = draftKey(t);
  try {
    const r = await call('saveFile', args);
    const wasUntitled = !t.path;
    t.path = path;
    t.title = basename(path);
    // Only what reached the disk counts as saved. Text typed during the write stays dirty.
    t.savedText = sent;
    if (r && r.mtime != null) t.mtime = String(r.mtime);
    if (r && r.enc) t.enc = r.enc;
    // The host falls back to UTF-8 when the text no longer fits the file's ANSI code page. t.enc now
    // follows the reply, so this shows once, when the encoding actually changes (not on every autosave).
    if (r && r.enc === 'utf8' && args.enc !== 'utf8') toast("Saved as UTF-8: some characters don't fit the file's old encoding");
    if (t.conflict) { t.conflict = false; hideBanner(t); }
    if (t.missing) { t.missing = false; hideBanner(t); } // saved by hand: the file exists again, autosave resumes
    // The edits now live in the saved file: drop the draft stored under the old key (old path or untitled id).
    if (oldDraftKey !== draftKey(t)) { try { localStorage.removeItem(oldDraftKey); } catch { /* ignore */ } }
    if (wasUntitled) { try { localStorage.removeItem('draft:untitled:' + t.id); } catch { /* ignore */ } }
    if (isDirty(t)) { cancelDraft(t); writeDraft(t); autosave(t); } // newer edits: keep them safe right away
    else clearDraft(t);
    addRecent(path);
    if (wasUntitled) renderTab(t, true);
    renderTabs(); updateStatus(); syncWatch(); saveSession();
    if (t === active) { document.title = (isDirty(t) ? '● ' : '') + t.title + ' — Emdedown'; call('setTitle', { title: document.title }).catch(() => {}); }
    if (S.folder && path.toLowerCase().startsWith(S.folder.toLowerCase())) refreshFolder();
    return true;
  } catch (e) {
    if (e && e.message === 'CONFLICT') return handleSaveConflict(t, path, saveAs, opts);
    toast('Save failed: ' + e.message, 'error');
    return false;
  }
}

async function handleSaveConflict(t, path, saveAs, opts) {
  if (opts.auto) { setConflictBanner(t); return false; }
  const r = await ask('This file was changed by another program', `“${basename(path)}” was modified on disk after you opened it. Overwrite it with your version, or reload it and discard your changes?`, [
    { label: 'Overwrite', value: 'overwrite', primary: true }, { label: 'Reload from disk', value: 'reload' }, { label: 'Cancel', value: 'cancel' }]);
  if (r === 'overwrite') {
    // Retry the same target path (no second Save dialog).
    const keepPath = t.path;
    if (saveAs) t.path = path;
    // saveTabNow, not saveTab: we are inside this tab's queued save, which saveTab would wait for (deadlock).
    const ok = await saveTabNow(t, false, { ...opts, force: true });
    if (!ok && saveAs) t.path = keepPath;
    return ok;
  }
  if (r === 'reload' && t.path && path.toLowerCase() === t.path.toLowerCase()) await reloadTab(t);
  return false;
}

function setConflictBanner(t) {
  t.conflict = true; // pauses autosave for this tab until resolved
  t.banner = { kind: 'warn', text: 'This file was changed by another program. Autosave is paused.', actions: [
    { label: 'Overwrite', run: () => saveTab(t, false, { force: true }).then((ok) => ok && hideBanner(t)) },
    { label: 'Reload from disk', run: () => reloadTab(t) }] };
  if (t === active) showBanner(t.banner, t);
}

/** Replace a tab's content with the file on disk (discarding unsaved changes). */
async function reloadTab(t) {
  if (!t || !t.path) return false;
  if (editor && t === active && t.edState && editor.currentTab === t) t.text = editor.getText();
  // What the user agreed to discard is the text as it is now. Anything typed while the file is being read is
  // newer work: ask before throwing it away.
  const path = t.path;
  const textAtRequest = t.text;
  let f;
  try { f = await readText(path); } catch (e) { toast('Could not reload: ' + e.message, 'error'); return false; }
  if (!tabs.includes(t) || !samePath(t.path, path)) return false;
  if (t.text !== textAtRequest) {
    const r = await ask('Discard your newest changes?', `You edited “${t.title}” while it was being reloaded. Reload anyway and lose those edits?`, [
      { label: 'Keep my changes', value: 'keep', primary: true }, { label: 'Reload from disk', value: 'reload' }]);
    if (r !== 'reload' || !tabs.includes(t) || !samePath(t.path, path)) return false;
  }
  t.text = t.savedText = f.text;
  if (f.eol) t.eol = f.eol;
  if (f.enc) t.enc = f.enc;
  if (f.mtime != null) t.mtime = String(f.mtime);
  t.conflict = false;
  clearDraft(t);
  cancelAutosave(t);
  const s = t === active ? previewPane.scrollTop : null;
  renderTab(t, true);
  if (s != null) previewPane.scrollTop = s;
  syncEditorText(t);
  hideBanner(t);
  renderTabs(); updateStatus();
  return true;
}
function guessTitle(text) {
  const m = /^#\s+(.+)$/m.exec(text);
  return m ? m[1].replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60) : '';
}

// Drafts (crash/close safety for unsaved edits)
const draftKey = (t) => 'draft:' + (t.path ? t.path.toLowerCase() : 'untitled:' + t.id);
// One pending draft write per tab, so typing in tab B never cancels tab A's write.
const draftTimers = new Map(); // tab id -> timeout id
function writeDraft(t) { try { if (isDirty(t)) localStorage.setItem(draftKey(t), t.text); else localStorage.removeItem(draftKey(t)); } catch { /* ignore */ } }
function saveDraft(t) {
  clearTimeout(draftTimers.get(t.id));
  draftTimers.set(t.id, setTimeout(() => { draftTimers.delete(t.id); writeDraft(t); }, 1500));
}
function cancelDraft(t) { if (draftTimers.has(t.id)) { clearTimeout(draftTimers.get(t.id)); draftTimers.delete(t.id); } }
/** Write a tab's pending draft now (if one is pending). */
function flushDraft(t) { if (t && draftTimers.has(t.id)) { cancelDraft(t); writeDraft(t); } }
function flushAllDrafts() { for (const t of tabs) flushDraft(t); }
function loadDraft(t) { try { return localStorage.getItem(draftKey(t)); } catch { return null; } }
function clearDraft(t, untitledToo) {
  cancelDraft(t);
  try {
    localStorage.removeItem(draftKey(t));
    if (untitledToo) localStorage.removeItem('draft:untitled:' + t.id);
  } catch { /* ignore */ }
}

let restoringSession = false; // while boot() restores tabs, keep the persisted session untouched
function saveSession() {
  if (!S.restoreSession || restoringSession) return;
  // Untitled tabs the user chose "Don't save" for are gone for good: not listed, no draft written back.
  const kept = tabs.filter((t) => t.path || !t.discarded);
  const list = kept.map((t) => (t.path ? { path: t.path, mode: t.mode } : { untitled: t.id, mode: t.mode, title: t.title }));
  kept.filter((t) => !t.path).forEach((t) => { try { localStorage.setItem('draft:untitled:' + t.id, t.text); } catch { /* ignore */ } });
  S.session = { tabs: list, active: active ? (active.path || active.id) : null };
  saveSettings();
}

function syncWatch() {
  call('watch', { paths: tabs.filter((t) => t.path).map((t) => t.path) }).catch(() => {});
}

// File changed on disk
on('fileChanged', (m) => {
  const t = tabs.find((x) => x.path && x.path.toLowerCase() === m.path.toLowerCase());
  if (!t) return;
  if (t.missing) {
    // The file is back (restored, or the move was undone). Treat it like a file changed by another program:
    // the edits stay and the "changed by another program" choice below replaces the "deleted" banner.
    // (Its mtime is still the old one, so a save before that choice hits the CONFLICT check.)
    t.missing = false;
    hideBanner(t);
  }
  const diskMtime = m.mtime == null ? null : String(m.mtime);
  const accept = () => {
    if (diskMtime != null) t.mtime = diskMtime;
    if (m.enc) t.enc = m.enc;
  };
  if (m.text === t.savedText) { accept(); if (t === active) updateStatus(); return; }
  if (!isDirty(t)) {
    t.text = t.savedText = m.text;
    accept();
    cancelAutosave(t);
    if (t === active) {
      const s = previewPane.scrollTop;
      renderTab(t);
      previewPane.scrollTop = s;
      syncEditorText(t);
      flashLive();
    } else { t.rendered = false; syncEditorText(t); }
  } else {
    // Unsaved edits: keep t.mtime at the version the user started from until they decide, so a plain
    // save still hits the host's CONFLICT check instead of silently overwriting the other program's change.
    t.banner = { kind: 'warn', text: 'This file was changed by another program.', actions: [
      { label: 'Reload from disk', run: () => { t.text = t.savedText = m.text; accept(); t.conflict = false; clearDraft(t); renderTab(t); syncEditorText(t); renderTabs(); updateStatus(); hideBanner(t); } },
      { label: 'Keep my version', run: () => { t.savedText = m.text; accept(); t.conflict = false; renderTabs(); hideBanner(t); } }] };
    if (t === active) showBanner(t.banner, t);
  }
});
on('fileDeleted', (m) => {
  const t = tabs.find((x) => x.path && x.path.toLowerCase() === m.path.toLowerCase());
  if (!t) return;
  t.savedText = '\u0000deleted';
  // Autosave must not quietly recreate a file that was deleted or moved on purpose: it is paused for this tab
  // until the user saves by hand (Save, the banner button) or the file appears again (fileChanged).
  t.missing = true;
  cancelAutosave(t);
  writeDraft(t); // the tab is now "dirty": keep its text recoverable
  t.banner = { kind: 'warn', text: 'This file was deleted or moved. Autosave is paused. Save to keep it.', actions: [{ label: 'Save', run: () => saveTab(t).then((ok) => ok && hideBanner(t)) }, { label: 'Close tab', run: () => closeTab(t, true) }] };
  renderTabs();
  if (t === active) showBanner(t.banner, t);
});
on('openFiles', (m) => { openPaths(m.paths, m.edit); });
on('folderChanged', debounce(() => refreshFolder(), 300));
on('closeRequested', () => {
  call('closeAck').catch(() => {}); // tell the host we are alive; it may wait for the user to answer our save prompt
  quit();
});
// Windows is shutting down or signing out: no prompt is possible and the process may be killed within seconds.
// Hand every unsaved text to the host, which writes it to disk itself; boot() brings it back next time.
on('sessionEnding', () => {
  try {
    if (active && editor && active.edState && editor.currentTab === active) { active.text = editor.getText(); active.edState = editor.getState(); }
    flushAllDrafts();
    const unsaved = tabs.filter((t) => isDirty(t) && !t.discarded);
    const drafts = {};
    for (const t of unsaved) drafts[draftKey(t)] = t.text;
    // Tabs to reopen if "Reopen tabs on launch" is off (when it is on, the saved session covers all tabs).
    const recovery = {
      at: Date.now(), drafts,
      session: { tabs: unsaved.map((t) => (t.path ? { path: t.path, mode: t.mode } : { untitled: t.id, mode: t.mode, title: t.title })), active: active ? (active.path || active.id) : null },
    };
    saveSession();
    call('sessionFlush', { settings: serializeSettings(), recovery: unsaved.length ? JSON.stringify(recovery) : '' }).catch(() => {});
  } catch (e) { console.error(e); call('sessionFlush', {}).catch(() => {}); }
});
on('format', (m) => formatCmd(m.cmd));
on('fullscreenChanged', (m) => app.classList.toggle('fullscreen', !!m.on));

async function openPaths(paths, edit) {
  for (const p of paths) {
    const kind = await call('pathKind', { path: p }).catch(() => 'file');
    if (kind === 'dir') { loadFolder(p, true); setSidebarPanel('files'); setSidebar(true); }
    else if (IMG_EXT.test(p)) {
      // An image is not a document: put it into the document being edited, otherwise just show it.
      if (active && active.mode !== 'preview') await insertImageRef(p);
      else { openLightbox(fileUrl(p)); if (active) toast('To put this image in the document, switch to Split or Edit and drop it again'); }
    } else {
      const t = await openFile(p);
      if (t && edit && t.mode === 'preview') setMode('split');
    }
  }
}

let flashTimer;
function flashLive() {
  const s = stPath;
  s.classList.add('live');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => s.classList.remove('live'), 900);
}

// ---------------- banner ----------------
function showBanner(b, t) {
  const box = $('#banner');
  if (!b || t !== active) { box.hidden = true; return; }
  box.className = 'banner-' + b.kind;
  box.innerHTML = '';
  box.append(el('span', {}, b.text), ...b.actions.map((a) => el('button', { class: 'btn small', onclick: a.run }, a.label)));
  box.hidden = false;
}
function hideBanner(t) { t.banner = null; if (t === active) $('#banner').hidden = true; }

// ---------------- modes & editor ----------------
function setMode(mode, silent) {
  const t = active;
  if (t) t.mode = mode;
  app.classList.remove('mode-preview', 'mode-split', 'mode-edit');
  app.classList.add('mode-' + mode);
  $$('#mode-switch button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  if (mode !== 'preview' && t) {
    ensureEditor().then(() => {
      if (active !== t) return;
      if (!editor.currentTab || editor.currentTab !== t) loadEditorState(t);
      updateChrome();
      if (!silent) editor.focus();
      if (mode === 'split' && S.syncScroll) syncPreviewToEditor();
    });
  }
  if (mode === 'preview' && t && t.renderedText !== t.text) renderTab(t);
  if (!silent) saveSession();
  updateStatus();
  updateChrome();
}

function loadEditorState(t, replaceText = false) {
  if (!editor) return;
  if (!t.edState) t.edState = editor.makeState(t.text);
  else if (replaceText && t.edState.doc.toString() !== t.text) {
    editor.setState(t.edState);
    suppressEditorChange = true;
    editor.setText(t.text);
    suppressEditorChange = false;
    t.edState = editor.getState();
  }
  editor.setState(t.edState);
  editor.currentTab = t;
  requestAnimationFrame(() => editor.setScrollTop(t.edScroll || 0));
}

function ensureEditor() {
  if (editor) return Promise.resolve(editor);
  if (editorLoading) return editorLoading;
  editorPane.classList.add('loading');
  editorLoading = import('./editor.js').then(({ createEditor }) => {
    editor = createEditor({
      parent: editorPane,
      doc: active ? active.text : '',
      lineNumbers: S.lineNumbers,
      lineWrap: S.lineWrap,
      onChange: onEditorChange,
      onScroll: () => { if (S.syncScroll && scrollDriver === 'editor' && app.classList.contains('mode-split')) syncPreviewToEditor(); },
      onPasteImage: pasteImage,
    });
    editor.view.dom.addEventListener('keyup', updateStatus);
    // The host adds Bold / Italic / ... to the right-click menu only while the editor has focus.
    editorPane.addEventListener('focusin', () => call('editorFocus', { on: true }).catch(() => {}));
    editorPane.addEventListener('focusout', () => call('editorFocus', { on: false }).catch(() => {}));
    editor.view.dom.addEventListener('mouseup', updateStatus);
    editorPane.classList.remove('loading');
    if (active) { active.edState = editor.getState(); editor.currentTab = active; }
    return editor;
  });
  return editorLoading;
}

const liveRender = (() => {
  let timer = null;
  return (t) => {
    clearTimeout(timer);
    const delay = Math.min(450, 40 + t.text.length / 4000 + (t.renderMs || 0) * 1.5);
    timer = setTimeout(() => {
      if (t !== active) return;
      const s = previewPane.scrollTop;
      renderTab(t);
      previewPane.scrollTop = s;
      if (S.syncScroll && app.classList.contains('mode-split')) syncPreviewToEditor();
    }, delay);
  };
})();

// Edit mode has no live preview; keep the visible outline from going stale with a slower, idle re-render.
const outlineRefresh = (() => {
  let timer = null;
  return (t) => {
    clearTimeout(timer);
    const delay = Math.max(800, Math.min(3000, (t.renderMs || 0) * 4));
    timer = setTimeout(() => { if (t === active && app.classList.contains('mode-edit')) ensureFresh(t); }, delay);
  };
})();

// One pending autosave per tab, so typing in tab B never cancels tab A's autosave.
const autosaveTimers = new Map(); // tab id -> timeout id
function autosave(t) {
  clearTimeout(autosaveTimers.get(t.id));
  autosaveTimers.set(t.id, setTimeout(() => {
    autosaveTimers.delete(t.id);
    if (S.autosave && t.path && !t.conflict && !t.missing && isDirty(t) && tabs.includes(t)) saveTab(t, false, { auto: true });
  }, 1200));
}
function cancelAutosave(t) { if (autosaveTimers.has(t.id)) { clearTimeout(autosaveTimers.get(t.id)); autosaveTimers.delete(t.id); } }

function onEditorChange(text) {
  if (suppressEditorChange) return;
  const t = editor.currentTab;
  if (!t) return;
  const wasDirty = isDirty(t);
  t.text = text;
  t.discarded = false; // new typing is new work, even after a "Don't save"
  t.edState = editor.getState();
  if (wasDirty !== isDirty(t)) { renderTabs(); document.title = (isDirty(t) ? '● ' : '') + t.title + ' — Emdedown'; call('setTitle', { title: document.title }).catch(() => {}); }
  if (app.classList.contains('mode-split')) liveRender(t);
  else if (S.sidebar && S.sidebarPanel === 'outline') outlineRefresh(t);
  saveDraft(t);
  autosave(t);
  updateStatusSoon();
  updateChrome();
}

/**
 * An image was pasted or dropped into the editor. The editor has marked the spot (pendingId) in the document it
 * showed at that moment; the image is saved next to *that* document and its link goes into *that* document,
 * even if the user switches tabs or keeps typing while the image is being written.
 */
async function pasteImage(file, pendingId, suffix = '') {
  const t = editor && editor.currentTab;
  if (!t) return;
  const give = (msg, kind) => { cancelPendingInsert(t, pendingId); if (msg) toast(msg, kind); };
  if (!t.path) {
    toast('Save the document first — images are stored next to it.', 'warn');
    if (!(await saveTab(t))) { give(); return; }
  }
  if (!tabs.includes(t)) { give(); return; }
  const docPath = t.path;
  const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(file); });
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  const name = file.name && !/^image\.\w+$/.test(file.name) ? file.name : `image.${ext}`;
  let rel;
  try { rel = await call('saveImage', { docPath, name, base64: b64 }); } catch (e) { give('Could not save image: ' + e.message, 'error'); return; }
  const link = `![${stripExt(basename(rel))}](${rel.replace(/ /g, '%20')})`;
  // The link is relative to docPath: if the tab was closed or saved elsewhere meanwhile, do not insert it.
  if (!tabs.includes(t) || !samePath(t.path, docPath) || !applyPendingInsert(t, pendingId, link + suffix)) {
    give(`Image saved to ${rel}, but its document was closed or changed, so no link was inserted.`, 'warn');
    return;
  }
  toast('Image saved to ' + rel);
}

/** Put text at a spot the editor marked in tab t (shown or in the background). False if the spot is gone. */
function applyPendingInsert(t, id, text) {
  if (!editor) return false;
  if (editor.currentTab === t && t === active) return editor.insertPending(id, text); // goes through onEditorChange
  if (!t.edState) return false;
  const st = editor.insertPendingIn(t.edState, id, text);
  if (!st) return false;
  const wasDirty = isDirty(t);
  t.edState = st;
  t.text = st.doc.toString();
  t.discarded = false;
  saveDraft(t);
  autosave(t);
  if (wasDirty !== isDirty(t)) renderTabs();
  return true;
}
function cancelPendingInsert(t, id) {
  if (!editor) return;
  if (editor.currentTab === t && t === active) editor.cancelPending(editor.getState(), id);
  else if (t.edState) t.edState = editor.cancelPending(t.edState, id);
}

/** Put a link to an image file on disk into the active document (relative to the document when possible). */
async function insertImageRef(p) {
  const t = active;
  if (!t) return false;
  if (!t.path) {
    toast('Save the document first so the image can be linked relative to it.', 'warn');
    if (!(await saveTab(t))) return false;
  }
  const rel = relative(dirname(t.path), p).replace(/\\/g, '/');
  const alt = stripExt(basename(p)).replace(/[[\]]/g, '');
  if (t.mode === 'preview') setMode('split');
  await ensureEditor();
  if (active !== t) return false;
  editor.insertText(`![${alt}](${encodeURI(rel)})\n`);
  return true;
}

// Formatting commands used by the right-click menu (the host sends "format") and the command palette.
const FORMAT_KEYS = { bold: 'Mod-b', italic: 'Mod-i', strike: 'Mod-Shift-x', code: 'Mod-`', link: 'Mod-k', h1: 'Mod-1', h2: 'Mod-2', h3: 'Mod-3',
  bullet: 'Mod-Shift-8', numbered: 'Mod-Shift-7', check: 'Mod-Shift-c', quote: 'Mod-Shift-.' };
function formatCmd(name) {
  if (name === 'image') { cmd('insertImage'); return; }
  if (name === 'table') { cmd('insertTable'); return; }
  const key = FORMAT_KEYS[name];
  if (!key || !active) return;
  if (active.mode === 'preview') { setMode('split'); }
  ensureEditor().then(() => { if (editor && editor.currentTab === active) editor.format(key); });
}

// ---------------- sync scroll ----------------
// The pane the user last scrolled, clicked or typed in drives the other one; scrolling caused by the sync never
// drives back. (A short time lock alone let late scroll events from one pane bounce the other one around.)
let scrollDriver = 'editor';
for (const [pane, who] of [[editorPane, 'editor'], [previewPane, 'preview']]) {
  for (const type of ['wheel', 'pointerdown', 'keydown', 'touchstart']) pane.addEventListener(type, () => { scrollDriver = who; }, { capture: true, passive: true });
}
let scrollLock = 0;
function lineElements(t) {
  if (!t.lineEls) t.lineEls = $$('[data-line]', t.article).map((e) => ({ el: e, line: +e.dataset.line })).filter((x) => x.el.offsetParent !== null || x.el.getClientRects().length);
  return t.lineEls;
}
function syncPreviewToEditor() {
  const t = active;
  if (!t || !editor || Date.now() < scrollLock) return;
  const line = editor.topLine();
  const els = lineElements(t);
  if (!els.length) return;
  let prev = els[0];
  let next = null;
  for (const x of els) { if (x.line <= line) prev = x; else { next = x; break; } }
  const top = (e) => e.getBoundingClientRect().top - previewPane.getBoundingClientRect().top + previewPane.scrollTop;
  let y = top(prev.el);
  if (next && next.line > prev.line) y += (top(next.el) - y) * Math.min(1, (line - prev.line) / (next.line - prev.line));
  scrollLock = Date.now() + 80;
  previewPane.scrollTop = Math.max(0, y - 12);
}
function syncEditorToPreview() {
  const t = active;
  if (!t || !editor || Date.now() < scrollLock) return;
  const els = lineElements(t);
  const paneTop = previewPane.getBoundingClientRect().top;
  const hit = els.find((x) => x.el.getBoundingClientRect().bottom > paneTop + 8);
  if (!hit) return;
  scrollLock = Date.now() + 80;
  editor.scrollToLine(hit.line);
}

// ---------------- preview interactions ----------------
previewPane.addEventListener('scroll', () => {
  updateProgress();
  outlineSpy();
  if (S.syncScroll && scrollDriver === 'preview' && app.classList.contains('mode-split')) syncEditorToPreview();
}, { passive: true });

docsEl.addEventListener('click', async (e) => {
  const t = active;
  if (!t) return;
  const box = e.target.closest('input.task');
  if (box) { toggleTask(t, +box.dataset.taskLine, box.checked, box); return; }
  const img = e.target.closest('img');
  const a = e.target.closest('a');
  if (img && !a) { openLightbox(img.src); return; }
  if (!a) return;
  e.preventDefault();
  if (a.classList.contains('wikilink')) { openWiki(a.dataset.wiki, t); return; }
  const href = a.getAttribute('href') || '';
  if (!href) return;
  if (href.startsWith('#')) { scrollToAnchor(decodeURIComponent(href.slice(1))); return; }
  if (/^(https?:|mailto:|tel:)/i.test(href)) { call('openExternal', { url: href }).catch(() => {}); return; }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return; // unknown scheme: ignore
  const [p, anchor] = href.split('#');
  const base = t.path ? dirname(t.path) : (S.folder || '');
  if (isBlockedRemote(base, p)) { toast('Network links are blocked', 'warn'); return; }
  const target = resolve(base, p);
  if (MD_EXT.test(target)) {
    const opened = await openFile(target, { anchor: anchor ? decodeURIComponent(anchor) : null });
    if (!opened) toast('Linked file not found: ' + p, 'warn');
  } else if (/\.svg$/i.test(target)) {
    // Shown as an image inside the app: an SVG opened in a browser could run embedded script.
    openLightbox(fileUrl(target));
  } else call('openExternal', { path: target }).catch((err) => toast(err.message, 'error'));
});

function openWiki(target, t) {
  const want = target.toLowerCase().replace(/\.md$/, '');
  const [name, anchor] = want.split('#');
  const hit = folderFiles.find((f) => stripExt(f.name).toLowerCase() === name) || folderFiles.find((f) => f.path.toLowerCase().replace(/\\/g, '/').endsWith('/' + name + '.md'));
  if (hit) { openFile(hit.path, { anchor }); return; }
  const base = t.path ? dirname(t.path) : S.folder;
  if (!base) return;
  const ref = target.split('#')[0] + '.md';
  if (isBlockedRemote(base, ref)) { toast('Network links are blocked', 'warn'); return; }
  openFile(resolve(base, ref)).then((r) => { if (!r) toast(`No note named “${target}” in this folder`, 'warn'); });
}

async function toggleTask(t, line, checked, box) {
  const revert = () => { if (box) box.checked = !checked; };
  if (!(line >= 0)) { revert(); return; }
  const lines = t.text.split('\n');
  if (!lines[line]) { revert(); return; }
  const updated = lines[line].replace(/\[( |x|X)\]/, checked ? '[x]' : '[ ]');
  if (updated === lines[line] && !/\[( |x|X)\]/.test(lines[line])) { revert(); return; }
  lines[line] = updated;
  const wasDirty = isDirty(t);
  t.text = lines.join('\n');
  syncEditorText(t);
  t.renderedText = t.text; // DOM already reflects the checkbox
  if (!wasDirty && t.path) { await saveTab(t); toast(checked ? 'Task done ✓' : 'Task reopened'); }
  else renderTabs();
}

function scrollToAnchor(id) {
  const t = active;
  if (!t || !id) return;
  // Rendered document ids (and <a name>) carry ID_PREFIX; links and the headings list use the bare slug.
  const target = t.article.querySelector('#' + CSS.escape(ID_PREFIX + id))
    || t.article.querySelector('#' + CSS.escape(ID_PREFIX + id.toLowerCase()))
    || t.article.querySelector(`a[name="${CSS.escape(ID_PREFIX + id)}"]`);
  if (target) {
    previewPane.scrollTo({ top: target.getBoundingClientRect().top - previewPane.getBoundingClientRect().top + previewPane.scrollTop - 16, behavior: 'smooth' });
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1200);
  }
}
function scrollToLine(line) {
  const t = active;
  if (!t) return;
  if (app.classList.contains('mode-edit') && editor) { editor.gotoLine(line); return; }
  const els = lineElements(t);
  let best = null;
  for (const x of els) { if (x.line <= line) best = x; else break; }
  if (best) {
    previewPane.scrollTop = best.el.getBoundingClientRect().top - previewPane.getBoundingClientRect().top + previewPane.scrollTop - 40;
    best.el.classList.add('flash');
    setTimeout(() => best.el.classList.remove('flash'), 1400);
  }
  if (editor && app.classList.contains('mode-split')) editor.gotoLine(line);
}

// ---------------- outline & progress ----------------
function updateOutline() {
  const box = $('#outline');
  box.textContent = '';
  const t = active;
  if (!t || !t.headings.length) { box.append(el('p', { class: 'muted pad' }, t ? 'No headings in this document.' : 'Open a document to see its outline.')); return; }
  const min = Math.min(...t.headings.map((h) => h.level));
  for (const h of t.headings) {
    box.append(el('a', { href: '#', class: 'ol-item', 'data-id': h.id, style: `padding-left:${10 + (h.level - min) * 14}px`, onclick: (e) => {
      e.preventDefault();
      ensureFresh(t); // Edit mode: headings may be stale
      const cur = (t.headings.find((x) => x.id === h.id)) || h;
      scrollToAnchor(cur.id);
      if (editor && app.classList.contains('mode-edit')) editor.gotoLine(cur.line);
    } }, h.text));
  }
  outlineSpy();
}
const outlineSpy = (() => {
  let raf = 0;
  return () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const t = active;
      if (!t || !t.headings.length) return;
      const paneTop = previewPane.getBoundingClientRect().top;
      let cur = null;
      for (const h of t.headings) {
        const n = t.article.querySelector('#' + CSS.escape(ID_PREFIX + h.id));
        if (!n) continue;
        if (n.getBoundingClientRect().top - paneTop < 90) cur = h.id; else break;
      }
      $$('#outline .ol-item').forEach((a) => a.classList.toggle('current', a.dataset.id === cur));
      const c = $('#outline .ol-item.current');
      if (c && S.sidebarPanel === 'outline') c.scrollIntoView({ block: 'nearest' });
    });
  };
})();
function updateProgress() {
  const max = previewPane.scrollHeight - previewPane.clientHeight;
  $('#progress').style.transform = `scaleX(${max > 0 ? previewPane.scrollTop / max : 0})`;
}

// ---------------- status bar ----------------
const updateStatusSoon = debounce(() => updateStatus(), 250);
function updateStatus() {
  const t = active;
  stPath.textContent = t ? (t.path || 'Not saved yet') : '';
  if (!t) { stWords.textContent = ''; stCursor.textContent = ''; stEol.textContent = ''; return; }
  const words = (t.text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
  const mins = Math.max(1, Math.round(words / 230));
  stWords.textContent = `${words.toLocaleString()} words · ${mins} min read`;
  stEol.textContent = `${ENC_LABELS[t.enc] || 'UTF-8'} · ${t.eol}`;
  if (editor && !app.classList.contains('mode-preview') && editor.currentTab === t) {
    const s = editor.stats();
    stCursor.textContent = `Ln ${s.line}, Col ${s.col}`;
  } else stCursor.textContent = '';
}
const ENC_LABELS = { utf8: 'UTF-8', utf8bom: 'UTF-8 with BOM', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', ansi: 'ANSI' };
stPath.addEventListener('click', () => { if (active && active.path) call('reveal', { path: active.path }); });
stZoom.addEventListener('click', () => zoom(0));

// ---------------- folder / files ----------------
async function loadFolder(dir, explicit = false) {
  if (!dir) return;
  if (explicit) folderClosed = false;
  else if (folderClosed) return;
  S.folder = dir;
  if (explicit) { explicitFolder = dir; saveSettings(); }
  $('#btn-close-folder').hidden = false;
  $('#btn-refresh').hidden = false;
  await refreshFolder();
}
// Set when the user closes the folder: stops the sidebar from re-opening the active file's folder by itself.
let folderClosed = false;
function closeFolder() {
  if (!S.folder) return;
  folderGen++; // drop any listing still on its way
  S.folder = null; explicitFolder = null; folderTree = null; folderFiles = [];
  expanded.clear();
  folderClosed = true;
  const name = $('#folder-name');
  name.textContent = 'No folder'; name.title = '';
  $('#btn-close-folder').hidden = true;
  $('#btn-refresh').hidden = true;
  $('#file-filter').value = '';
  $('#search-results').textContent = '';
  renderTree();
  call('unwatchFolder').catch(() => {});
  saveSettings();
}
/** Too broad to load automatically: a drive root (D:\), anything with <= 2 segments (C:\Users), or a user-profile root. */
function isBroadDir(dir) {
  if (!dir) return true;
  const d = dir.replace(/[\\/]+$/, '');
  if (/^[a-z]:$/i.test(d)) return true;
  const segs = d.split(/[\\/]+/).filter(Boolean);
  if (segs.length <= 2) return true;
  return /^[a-z]:[\\/]users[\\/][^\\/]+$/i.test(d);
}
// Bumped on every listing request and on Close folder: a slow listing that comes back after the folder was
// closed or changed (or after a newer listing was started) is ignored.
let folderGen = 0;
async function refreshFolder() {
  if (!S.folder) return;
  const gen = ++folderGen;
  const dir = S.folder;
  try {
    const tree = await call('listFolder', { dir });
    if (gen !== folderGen || S.folder !== dir) return;
    folderTree = tree;
    folderFiles = [];
    const walk = (n) => { if (n.dir) (n.children || []).forEach(walk); else folderFiles.push({ name: n.name, path: n.path }); };
    walk(folderTree);
    $('#folder-name').textContent = folderTree.name;
    $('#folder-name').title = dir;
    renderTree();
  } catch (e) {
    if (gen !== folderGen || S.folder !== dir) return;
    $('#file-tree').innerHTML = `<p class="muted pad">${escHtml(e.message)}</p>`;
  }
}
const expanded = new Set();
function renderTree() {
  const box = $('#file-tree');
  box.textContent = '';
  if (!folderTree) {
    return; // the panel head says "No folder" and has the Open folder button
  }
  const filter = $('#file-filter').value.trim().toLowerCase();
  if (filter) {
    const hits = folderFiles.map((f) => ({ f, s: fuzzy(filter, f.name) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 200);
    for (const { f } of hits) box.append(treeFile(f, 0, true));
    if (!hits.length) box.append(el('p', { class: 'muted pad' }, 'No matching files.'));
    highlightTreeActive();
    return;
  }
  const build = (node, depth) => {
    for (const c of node.children || []) {
      if (c.dir) {
        const open = expanded.has(c.path);
        box.append(el('div', { class: 'tree-row dir' + (open ? ' open' : ''), style: `padding-left:${8 + depth * 14}px`, onclick: () => { if (open) expanded.delete(c.path); else expanded.add(c.path); renderTree(); } },
          el('span', { class: 'chev' }, '›'), el('span', { class: 'name' }, c.name)));
        if (open) build(c, depth + 1);
      } else box.append(treeFile(c, depth));
    }
  };
  build(folderTree, 0);
  if (!(folderTree.children || []).length) box.append(el('p', { class: 'muted pad' }, 'No Markdown files in this folder.'));
  if (folderTree.truncated) box.append(el('p', { class: 'muted pad small' }, 'Showing the first 5,000 files.'));
  highlightTreeActive();
}
function treeFile(f, depth, showDir) {
  return el('div', { class: 'tree-row file', 'data-path': f.path, title: f.path, style: `padding-left:${22 + depth * 14}px`, onclick: () => openFile(f.path) },
    el('span', { class: 'name' }, f.name),
    showDir ? el('span', { class: 'muted small' }, ' ' + relative(S.folder, dirname(f.path))) : null);
}
function highlightTreeActive() {
  const p = active && active.path ? active.path.toLowerCase() : '';
  $$('#file-tree .tree-row.file').forEach((r) => r.classList.toggle('active', r.dataset.path.toLowerCase() === p));
  if (p && S.folder && p.startsWith(S.folder.toLowerCase() + '\\')) {
    // expand ancestors
    let d = dirname(active.path);
    let changed = false;
    while (d.length > S.folder.length) { if (!expanded.has(d) && findNode(d)) { expanded.add(d); changed = true; } d = dirname(d); }
    if (changed && !$('#file-filter').value) renderTree();
  }
}
function findNode(path) {
  const lp = path.toLowerCase();
  const walk = (n) => { if (n.path && n.path.toLowerCase() === lp) return n; for (const c of n.children || []) { const r = c.dir && walk(c); if (r) return r; } return null; };
  return folderTree ? walk(folderTree) : null;
}
$('#file-filter').addEventListener('input', debounce(renderTree, 80));
$('#btn-open-folder').addEventListener('click', () => cmd('openFolder'));
$('#btn-refresh').addEventListener('click', () => refreshFolder());
$('#btn-close-folder').addEventListener('click', () => closeFolder());

// ---------------- folder search ----------------
let searchSeq = 0;
const runSearch = debounce(async () => {
  const q = $('#search-input').value;
  const box = $('#search-results');
  if (!q.trim()) { box.textContent = ''; return; }
  if (!S.folder) { box.innerHTML = '<p class="muted pad">Open a folder to search it.</p>'; return; }
  const seq = ++searchSeq;
  box.innerHTML = '<p class="muted pad">Searching…</p>';
  try {
    const res = await call('searchFolder', { dir: S.folder, query: q, matchCase: $('#search-case').checked });
    if (seq !== searchSeq) return;
    box.textContent = '';
    if (!res.results.length) { box.innerHTML = '<p class="muted pad">No results.</p>'; return; }
    box.append(el('p', { class: 'muted small pad' }, `${res.total} matches in ${res.results.length} files${res.truncated ? ' (showing top results)' : ''} · ${res.ms} ms`));
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $('#search-case').checked ? 'g' : 'gi');
    for (const r of res.results) {
      const group = el('div', { class: 'sr-file' },
        el('div', { class: 'sr-head', title: r.path, onclick: () => openFile(r.path) }, el('b', {}, r.name), el('span', { class: 'muted small' }, ` ${r.count} · ${relative(S.folder, dirname(r.path)) || '.'}`)));
      for (const m of r.matches) {
        // Split the raw line on matches and add each piece as a text node (never match inside escaped entities).
        const row = el('div', { class: 'sr-line', onclick: () => openFile(r.path, { line: m.line }).then(() => { setTimeout(() => { scrollToLine(m.line); openFind(q, true); }, 60); }) },
          el('span', { class: 'ln' }, String(m.line + 1)));
        const text = String(m.text);
        const rx = new RegExp(re.source, re.flags);
        let last = 0;
        let mm;
        while ((mm = rx.exec(text))) {
          if (!mm[0].length) { rx.lastIndex++; continue; }
          if (mm.index > last) row.append(document.createTextNode(text.slice(last, mm.index)));
          row.append(el('mark', {}, mm[0]));
          last = mm.index + mm[0].length;
        }
        if (last < text.length) row.append(document.createTextNode(text.slice(last)));
        group.append(row);
      }
      box.append(group);
    }
  } catch (e) {
    if (e && e.message === 'CANCELLED') return; // superseded by a newer search
    if (seq !== searchSeq) return;
    box.innerHTML = `<p class="muted pad">${escHtml(e.message)}</p>`;
  }
}, 220);
$('#search-input').addEventListener('input', runSearch);
$('#search-case').addEventListener('change', runSearch);

// ---------------- sidebar ----------------
function setSidebar(on) { S.sidebar = on; app.classList.toggle('no-sidebar', !on); saveSettings(); }
function setSidebarPanel(p) {
  S.sidebarPanel = p;
  $$('#side-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.panel === p));
  $$('#sidebar .panel').forEach((x) => x.classList.toggle('on', x.id === 'panel-' + p));
  if (p === 'files' && !folderTree) {
    if (S.folder) loadFolder(S.folder);
    else if (active && active.path && !folderClosed && !isBroadDir(dirname(active.path))) loadFolder(dirname(active.path));
    else renderTree();
  }
  if (p === 'outline' && active) ensureFresh(active);
  saveSettings();
}
$$('#side-tabs button').forEach((b) => b.addEventListener('click', () => setSidebarPanel(b.dataset.panel)));
$('#btn-sidebar').addEventListener('click', () => setSidebar(!S.sidebar));
dragResize($('#sidebar-resizer'), (x) => { const w = Math.max(180, Math.min(520, x)); S.sidebarWidth = w; document.documentElement.style.setProperty('--sidebar-w', w + 'px'); }, saveSettings);
// Editor share of the split view: 10–90% (each pane stays usable; Edit mode gives the editor the full width).
// Snaps to the middle when dragged close to it.
function applySplit(r) {
  S.splitRatio = Math.max(0.1, Math.min(0.9, Math.abs(r - 0.5) < 0.015 ? 0.5 : r));
  document.documentElement.style.setProperty('--split', S.splitRatio);
  if (editor) editor.view.requestMeasure();
}
function setSplit(r) { applySplit(r); saveSettings(); }
dragResize($('#split-resizer'), (x) => {
  const r = $('#panes').getBoundingClientRect();
  applySplit((x - r.left) / r.width);
}, saveSettings);
function dragResize(handle, onMove, onEnd) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    const move = (ev) => onMove(ev.clientX);
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('resizing'); onEnd && onEnd(); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

// ---------------- find in document ----------------
let findHits = [];
let findIdx = -1;
function openFind(q, keep) {
  if (!active) return;
  if (!app.classList.contains('mode-preview') && editor && document.activeElement && editorPane.contains(document.activeElement) && !keep) return false;
  const bar = findbarEl;
  bar.hidden = false;
  const input = findInput;
  if (typeof q === 'string') input.value = q;
  else { const sel = String(window.getSelection() || '').trim(); if (sel && sel.length < 100) input.value = sel; }
  input.focus(); input.select();
  doFind();
  return true;
}
function closeFind() {
  findbarEl.hidden = true;
  clearFindMarks();
}
function clearFindMarks() {
  for (const m of findHits) {
    const p = m.parentNode;
    if (!p) continue;
    p.replaceChild(document.createTextNode(m.textContent), m);
    p.normalize();
  }
  findHits = []; findIdx = -1;
  findCount.textContent = '';
}
function doFind() {
  clearFindMarks();
  const q = findInput.value;
  if (!q || !active) return;
  const lower = q.toLowerCase();
  const walker = document.createTreeWalker(active.article, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('.katex,.mermaid-block svg,.copy-btn,.anchor,script,style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const text = n.nodeValue;
    const lt = text.toLowerCase();
    let i = lt.indexOf(lower);
    if (i < 0) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    while (i >= 0 && findHits.length < 5000) {
      frag.append(text.slice(last, i));
      const m = el('mark', { class: 'find-hit' }, text.slice(i, i + q.length));
      frag.append(m); findHits.push(m);
      last = i + q.length;
      i = lt.indexOf(lower, last);
    }
    frag.append(text.slice(last));
    n.parentNode.replaceChild(frag, n);
  }
  findIdx = -1;
  findStep(1);
}
function findStep(dir) {
  if (!findHits.length) { findCount.textContent = findInput.value ? 'No results' : ''; return; }
  if (findIdx >= 0) findHits[findIdx].classList.remove('current');
  if (findIdx < 0) {
    // first hit below current scroll position
    const top = previewPane.getBoundingClientRect().top;
    findIdx = findHits.findIndex((m) => m.getBoundingClientRect().top >= top);
    if (findIdx < 0) findIdx = 0;
  } else findIdx = (findIdx + dir + findHits.length) % findHits.length;
  const m = findHits[findIdx];
  m.classList.add('current');
  m.scrollIntoView({ block: 'center' });
  findCount.textContent = `${findIdx + 1} of ${findHits.length}`;
}
findInput.addEventListener('input', debounce(doFind, 120));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); previewPane.focus(); }
});
findNextBtn.addEventListener('click', () => findStep(1));
findPrevBtn.addEventListener('click', () => findStep(-1));
findCloseBtn.addEventListener('click', closeFind);

// ---------------- lightbox ----------------
function openLightbox(src) {
  const lb = lightboxEl;
  const img = $('img', lb);
  img.src = src;
  img.style.transform = '';
  lb.hidden = false;
  let scale = 1;
  lb.onwheel = (e) => { e.preventDefault(); scale = Math.max(0.2, Math.min(8, scale * (e.deltaY < 0 ? 1.15 : 0.87))); img.style.transform = `scale(${scale})`; };
  lb.onclick = () => { lb.hidden = true; };
}

// ---------------- toast ----------------
let toastTimer;
function toast(msg, kind = 'ok') {
  const t = toastEl;
  t.className = 'toast-' + kind;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 5000 : 2600);
}

// ---------------- modal ----------------
let modalResolve = null; // resolver of the ask() currently shown, if any
function settleModal(value) { if (modalResolve) { const r = modalResolve; modalResolve = null; r(value); } }
function openModal(content, { wide = false, onClose } = {}) {
  const m = modalEl;
  const box = modalBox;
  if (!m.hidden) {
    // Replacing an open dialog: close it properly so its onClose runs and a pending ask() settles as cancelled.
    const prev = m._onClose; m._onClose = null;
    if (prev) prev();
  }
  settleModal(undefined);
  box.className = 'modal-box' + (wide ? ' wide' : '');
  box.textContent = '';
  box.append(content);
  m.hidden = false;
  m.onmousedown = (e) => { if (e.target === m) closeModal(); };
  m._onClose = onClose;
  const f = box.querySelector('[autofocus], .btn.primary, input, select, button');
  if (f) setTimeout(() => f.focus(), 0);
}
/** Close the dialog. `owner` (an ask() resolver) makes the call a no-op unless that ask() is the one shown. */
function closeModal(value, owner) {
  const m = modalEl;
  if (m.hidden) return;
  if (owner && owner !== modalResolve) return;
  m.hidden = true;
  const oc = m._onClose; m._onClose = null;
  if (oc) oc();
  settleModal(value);
}
function ask(title, text, buttons, extra = null) {
  return new Promise((res) => {
    // openModal settles any previous ask() with undefined (= cancel) before this one takes the slot.
    openModal(el('div', {},
      el('h2', {}, title),
      text ? el('p', { class: 'muted' }, text) : null,
      extra,
      el('div', { class: 'modal-actions' }, ...buttons.map((b) => el('button', { class: 'btn' + (b.primary ? ' primary' : ''), onclick: () => closeModal(b.value, res) }, b.label)))));
    modalResolve = res;
  });
}

// ---------------- command palette ----------------
const COMMANDS = [];
function command(id, title, key, run, opts = {}) { COMMANDS.push({ id, title, key, run, ...opts }); }
function cmd(id, ...args) { const c = COMMANDS.find((x) => x.id === id); if (c) return c.run(...args); }

// Section order and the order of commands inside each section.
const SECTIONS = [
  ['File', ['new', 'open', 'openFolder', 'closeFolder', 'save', 'saveAs', 'saveAll', 'reload', 'close', 'closeOthers', 'reopen', 'reveal', 'copyPath', 'clearRecent']],
  ['Edit', ['undo', 'redo', 'cycleMode', 'modeRead', 'modeSplit', 'modeEdit', 'bold', 'italic', 'strike', 'inlineCode', 'link', 'insertImage', 'insertTable', 'insertToc']],
  ['Go to', ['quickOpen', 'gotoHeading', 'find', 'searchFolder', 'nextTab', 'prevTab']],
  ['View', ['changeTheme', 'toggleDark', 'appearanceLight', 'appearanceDark', 'appearanceSystem', 'toggleSidebar', 'showFiles', 'showOutline', 'zoomIn', 'zoomOut', 'zoomReset', 'focus', 'present']],
  ['Export & share', ['exportPdf', 'exportDocx', 'exportHtml', 'copyHtml', 'print']],
  ['App', ['settings', 'guide', 'shortcuts', 'about', 'setDefault', 'install', 'desktopShortcut', 'uninstall', 'quit']],
];
const SECTION_OF = new Map();
SECTIONS.forEach(([name, ids], si) => ids.forEach((id, i) => SECTION_OF.set(id, { name, order: si * 100 + i })));

let paletteMode = 'commands';
let paletteItems = [];
let paletteSel = 0;
let themeBeforePreview = null;

function openPalette(mode = 'commands', initial = '') {
  paletteMode = mode;
  const p = paletteEl;
  p.hidden = false;
  const input = paletteInput;
  input.value = initial;
  input.placeholder = {
    commands: 'Search commands…',
    files: 'Go to file…   (type > for commands, # for headings)',
    headings: 'Go to heading…',
    themes: 'Choose a theme (↑↓ to preview, Enter to keep) · Ctrl+Shift+L switches light / dark',
  }[mode];
  if (mode === 'themes') themeBeforePreview = S.theme;
  input.focus();
  updatePalette();
}
function closePalette(cancelled) {
  paletteEl.hidden = true;
  if (cancelled && paletteMode === 'themes' && themeBeforePreview !== null) { S.theme = themeBeforePreview; applyTheme(); }
  themeBeforePreview = null;
}

function keyChips(key) {
  if (!key) return null;
  return el('span', { class: 'pal-keys' }, ...key.split(' / ')[0].split('+').map((k) => el('kbd', {}, k.replace('Ctrl', 'Ctrl'))));
}

function commandItems(q) {
  const avail = COMMANDS.filter((c) => !c.hidden && (!c.when || c.when()));
  const mk = (c) => ({ id: c.id, label: c.title, key: c.key, section: (SECTION_OF.get(c.id) || { name: 'Other' }).name, run: c.run });
  if (q) {
    return avail.map((c) => ({ ...mk(c), s: Math.max(fuzzy(q, c.title), fuzzy(q, (SECTION_OF.get(c.id) || { name: '' }).name + ' ' + c.title) * 0.5) }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 60).map((x) => ({ ...x, showSection: true }));
  }
  const out = [];
  const recentIds = (S.recentCommands || []).filter((id) => avail.some((c) => c.id === id)).slice(0, 4);
  if (recentIds.length) {
    out.push({ header: 'Recently used' });
    recentIds.forEach((id) => out.push(mk(avail.find((c) => c.id === id))));
  }
  for (const [name] of SECTIONS) {
    const cs = avail.filter((c) => (SECTION_OF.get(c.id) || {}).name === name).sort((a, b) => SECTION_OF.get(a.id).order - SECTION_OF.get(b.id).order);
    if (!cs.length) continue;
    out.push({ header: name });
    cs.forEach((c) => out.push(mk(c)));
  }
  const other = avail.filter((c) => !SECTION_OF.has(c.id));
  if (other.length) { out.push({ header: 'Other' }); other.forEach((c) => out.push(mk(c))); }
  return out;
}

function updatePalette() {
  let q = paletteInput.value;
  let mode = paletteMode;
  if (mode !== 'themes') {
    if (q.startsWith('>')) { mode = 'commands'; q = q.slice(1); }
    else if (q.startsWith('#')) { mode = 'headings'; q = q.slice(1); }
  }
  q = q.trim();
  let rows = [];
  if (mode === 'commands') {
    rows = commandItems(q);
  } else if (mode === 'themes') {
    const all = THEMES.map((t) => ({ id: t.id, name: t.name, swatch: swatchStyle(t) })).concat(env.themes.map((f) => ({ id: 'custom:' + f, name: f.replace(/\.css$/i, '') + ' (custom)', swatch: '' })));
    rows = all.map((t) => ({ label: t.name, themeId: t.id, swatch: t.swatch, hint: t.id === themeBeforePreview ? 'current' : '', s: q ? fuzzy(q, t.name) : 1, run: () => { setSetting('theme', t.id); applyTheme(); } }))
      .filter((x) => x.s > 0);
  } else if (mode === 'headings') {
    ensureFresh(); // no-op unless Edit mode left the headings stale
    rows =(active ? active.headings : []).map((h) => ({ label: '  '.repeat(h.level - 1) + h.text, hint: 'H' + h.level, run: () => scrollToAnchor(h.id), s: q ? fuzzy(q, h.text) : 1 }))
      .filter((x) => x.s > 0);
    if (q) rows.sort((a, b) => b.s - a.s);
  } else {
    const seen = new Set();
    const src = [];
    tabs.forEach((t) => { if (t.path) { seen.add(t.path.toLowerCase()); src.push({ name: t.title, path: t.path, tag: 'open' }); } });
    S.recent.forEach((p) => { if (!seen.has(p.toLowerCase())) { seen.add(p.toLowerCase()); src.push({ name: basename(p), path: p, tag: 'recent' }); } });
    folderFiles.forEach((f) => { if (!seen.has(f.path.toLowerCase())) { seen.add(f.path.toLowerCase()); src.push({ ...f, tag: '' }); } });
    rows = src.map((f, i) => ({
      label: f.name, sub: S.folder && f.path.toLowerCase().startsWith(S.folder.toLowerCase()) ? relative(S.folder, dirname(f.path)) : dirname(f.path),
      hint: f.tag, run: () => openFile(f.path),
      s: q ? Math.max(fuzzy(q, f.name) * 1.5, fuzzy(q, f.path) * 0.6) : 1000 - i,
    })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 80);
  }

  paletteItems = rows.filter((r) => !r.header);
  paletteSel = 0;
  if (mode === 'themes' && !q) { const cur = paletteItems.findIndex((r) => r.themeId === themeBeforePreview); if (cur > 0) paletteSel = cur; }
  const list = paletteList;
  list.textContent = '';
  let idx = 0;
  for (const r of rows) {
    if (r.header) { list.append(el('div', { class: 'pal-group' }, r.header)); continue; }
    const i = idx++;
    list.append(el('div', { class: 'pal-item' + (i === paletteSel ? ' sel' : ''), onmousemove: () => { if (paletteSel !== i) selPalette(i); }, onclick: () => runPalette(i) },
      r.themeId ? el('span', { class: 'pal-swatch', 'data-t': r.themeId, style: r.swatch || '' }) : null,
      el('span', { class: 'pal-label' }, r.label),
      r.sub ? el('span', { class: 'pal-sub' }, r.sub) : el('span', { class: 'pal-fill' }),
      r.showSection ? el('span', { class: 'pal-section' }, r.section) : null,
      r.key ? keyChips(r.key) : (r.hint ? el('span', { class: 'pal-hint' }, r.hint) : null)));
  }
  if (!paletteItems.length) list.append(el('div', { class: 'pal-empty' }, mode === 'files' && !folderFiles.length && !S.recent.length ? 'Open a folder to quickly jump between its files.' : 'No matches'));
  const sel = list.querySelector('.pal-item.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function selPalette(i) {
  const rows = $$('.pal-item', paletteList);
  if (!rows.length) return;
  paletteSel = (i + rows.length) % rows.length;
  rows.forEach((r, j) => r.classList.toggle('sel', j === paletteSel));
  rows[paletteSel].scrollIntoView({ block: 'nearest' });
  const it = paletteItems[paletteSel];
  if (paletteMode === 'themes' && it && it.themeId) { S.theme = it.themeId; applyTheme(); } // live preview
}
function runPalette(i) {
  const it = paletteItems[i];
  themeBeforePreview = null;
  closePalette();
  if (!it) return;
  if (it.id) setSetting('recentCommands', [it.id, ...(S.recentCommands || []).filter((x) => x !== it.id)].slice(0, 6));
  setTimeout(() => it.run(), 0);
}
paletteInput.addEventListener('input', updatePalette);
paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); selPalette(paletteSel + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); selPalette(paletteSel - 1); }
  else if (e.key === 'PageDown') { e.preventDefault(); selPalette(Math.min(paletteItems.length - 1, paletteSel + 8)); }
  else if (e.key === 'PageUp') { e.preventDefault(); selPalette(Math.max(0, paletteSel - 8)); }
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(paletteSel); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(true); }
});
paletteEl.addEventListener('mousedown', (e) => { if (e.target === paletteEl) closePalette(true); });

// ---------------- settings dialog ----------------
function showSettings() {
  const sel = (label, key, options, after) => el('label', { class: 'row' }, el('span', {}, label),
    el('select', { onchange: (e) => { setSetting(key, isNaN(+e.target.value) || e.target.value === '' ? e.target.value : +e.target.value); after && after(); } },
      ...options.map(([v, n]) => el('option', { value: v, selected: String(S[key]) === String(v) }, n))));
  const chk = (label, key, after) => el('label', { class: 'row' }, el('span', {}, label),
    el('input', { type: 'checkbox', checked: !!S[key], onchange: (e) => { setSetting(key, e.target.checked); after && after(); } }));
  const themeOpts = THEMES.map((t) => [t.id, t.name]).concat(env.themes.map((f) => ['custom:' + f, f.replace(/\.css$/i, '') + ' (custom)']));
  const content = el('div', { class: 'settings' },
    el('h2', {}, 'Settings'),
    el('h3', {}, 'Appearance'),
    // Each card shows both versions of a theme: light on the left, dark on the right.
    el('div', { class: 'theme-grid' }, ...THEMES.map((t) => el('button', {
      class: 'theme-swatch' + (S.theme === t.id ? ' on' : ''), 'data-t': t.id, title: t.name + ' (light and dark)',
      onclick: (e) => { setSetting('theme', t.id); applyTheme(); $$('.theme-swatch', modalBox).forEach((b) => b.classList.toggle('on', b === e.currentTarget)); const ts = $('#set-theme', modalBox); if (ts) ts.value = t.id; },
    }, el('span', { class: 'sw-pair' }, ...['light', 'dark'].map((half) => el('span', { class: 'sw-bg', style: `background:${t[half].bg}` },
      el('span', { class: 'sw-a', style: `background:${t[half].accent}` }), el('span', { class: 'sw-b', style: `background:${t[half].fg}` })))), t.name))),
    el('div', { class: 'row' }, el('span', {}, 'Appearance'),
      el('div', { class: 'segmented', id: 'set-appearance' }, ...APPEARANCES.map(([a, label]) => el('button', {
        class: S.appearance === a ? 'on' : '', 'data-a': a, onclick: () => setAppearance(a) }, label)))),
    el('label', { class: 'row' }, el('span', {}, 'Theme'), el('select', { id: 'set-theme', onchange: (e) => { setSetting('theme', e.target.value); applyTheme(); } }, ...themeOpts.map(([v, n]) => el('option', { value: v, selected: S.theme === v }, n)))),
    sel('Font', 'font', [['sans', 'Sans-serif (Segoe UI)'], ['serif', 'Serif (Georgia / Cambria)'], ['mono', 'Monospace']], applyTypography),
    el('label', { class: 'row' }, el('span', {}, 'Text size'), el('input', { type: 'range', min: 11, max: 28, step: 1, value: S.fontSize, oninput: (e) => { setSetting('fontSize', +e.target.value); applyTypography(); } })),
    sel('Line spacing', 'lineHeight', [[1.4, 'Compact'], [1.65, 'Comfortable'], [1.9, 'Relaxed']], applyTypography),
    sel('Page width', 'width', [['narrow', 'Narrow'], ['medium', 'Medium'], ['wide', 'Wide'], ['full', 'Full window']], applyTypography),
    el('h3', {}, 'Editing'),
    sel('Open files in', 'defaultMode', [['preview', 'Read mode'], ['split', 'Split (edit + preview)'], ['edit', 'Edit mode']]),
    chk('Sync scrolling in split view', 'syncScroll'),
    chk('Save automatically', 'autosave'),
    chk('Line numbers', 'lineNumbers', () => editor && editor.setLineNumbers(S.lineNumbers)),
    chk('Wrap long lines', 'lineWrap', () => editor && editor.setLineWrap(S.lineWrap)),
    chk('Reopen tabs on launch', 'restoreSession', saveSession),
    chk('Use graphics card (GPU) — uses ~100 MB more memory; restart to apply', 'gpu', () => toast('Restart Emdedown to apply')),
    el('h3', {}, 'System'),
    el('div', { class: 'sys-actions' },
      env.runningInstalled
        ? el('span', { class: 'muted' }, 'Installed for this user ✓')
        : el('button', { class: 'btn primary', onclick: () => { closeModal(); installPrompt(); } }, env.installed ? 'Update installed copy' : 'Install on this PC'),
      env.isDefault ? el('span', { class: 'muted' }, 'Opens .md files ✓') : el('button', { class: 'btn', onclick: () => { closeModal(); makeDefault(); } }, 'Open .md files with Emdedown'),
      el('button', { class: 'btn', onclick: () => call('openThemesFolder') }, 'Custom themes folder'),
      env.installed ? el('button', { class: 'btn danger', onclick: () => { closeModal(); doUninstall(); } }, 'Uninstall') : null),
    env.installed ? el('label', { class: 'row' }, el('span', {}, 'Shortcut on the desktop'),
      el('input', { type: 'checkbox', checked: !!env.desktopShortcut, onchange: (e) => setDesktopShortcut(e.target.checked, e.target) })) : null,
    el('p', { class: 'muted small' }, `Emdedown ${env.version} · everything works offline · settings are stored in your user profile · `,
      el('a', { href: '#', class: 'install-link', onclick: (e) => { e.preventDefault(); showAbout(); } }, 'About')),
    el('div', { class: 'modal-actions' }, el('button', { class: 'btn primary', onclick: () => closeModal() }, 'Done')));
  openModal(content, { wide: true });
}

/** Opens the user guide that ships inside the exe (the host writes it to the data folder first). */
async function openGuide(name = 'Guide.md') {
  try { await openFile(await call('guidePath', { name })); }
  catch (e) { toast('Could not open the guide: ' + e.message, 'error'); }
}

function showShortcuts() {
  const groups = [
    ['Files', [['Ctrl+O', 'Open file'], ['Ctrl+Shift+O', 'Open folder'], ['Ctrl+N', 'New document'], ['Ctrl+S', 'Save'], ['Ctrl+Shift+S', 'Save as'], ['Ctrl+W', 'Close tab'], ['Ctrl+Tab', 'Next tab'], ['Ctrl+Shift+Tab', 'Previous tab'], ['Ctrl+Shift+T', 'Reopen closed tab']]],
    ['Navigate', [['Ctrl+P', 'Quick open file'], ['Ctrl+Shift+P', 'Command palette'], ['Ctrl+R', 'Go to heading'], ['Ctrl+F', 'Find in document'], ['Ctrl+Shift+F', 'Search all files'], ['Ctrl+Shift+E', 'Show files'], ['Ctrl+\\', 'Toggle sidebar'], ['Alt+←', 'Back']]],
    ['View', [['Ctrl+E', 'Read / Split / Edit'], ['Ctrl+= / Ctrl+-', 'Text size'], ['Ctrl+0', 'Reset size'], ['Ctrl+Shift+L', 'Light / dark'], ['F11', 'Focus mode'], ['F5', 'Present as slides'], ['Ctrl+Alt+P', 'Print'], ['Ctrl+,', 'Settings']]],
    ['Editing', [['Ctrl+B / Ctrl+I', 'Bold / italic'], ['Ctrl+Shift+X', 'Strikethrough'], ['Ctrl+K', 'Insert link'], ['Ctrl+`', 'Inline code'], ['Ctrl+1/2/3', 'Heading'], ['Ctrl+Shift+8', 'Bullet list'], ['Ctrl+Shift+7', 'Numbered list'], ['Ctrl+Shift+C', 'Checklist'], ['Ctrl+Shift+.', 'Quote'], ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],['Ctrl+V', 'Paste image → saved to ./images']]],
  ];
  openModal(el('div', {}, el('h2', {}, 'Keyboard shortcuts'),
    el('div', { class: 'kbd-grid' }, ...groups.map(([g, rows]) => el('div', {}, el('h3', {}, g), ...rows.map(([k, d]) => el('div', { class: 'kbd-row' }, el('kbd', {}, k), el('span', {}, d)))))),
    el('div', { class: 'modal-actions' }, el('button', { class: 'btn primary', onclick: () => closeModal() }, 'Close'))), { wide: true });
}

function showAbout() {
  const where = env.runningInstalled ? 'Installed for this user' : (env.installed ? 'Portable copy (an installed copy also exists)' : 'Portable (not installed)');
  openModal(el('div', { class: 'about' },
    el('div', { class: 'logo big', html: LOGO }),
    el('h2', {}, 'Emdedown'),
    el('p', { class: 'muted ver' }, 'Version ' + env.version),
    el('p', {}, 'A fast, offline Markdown reader and editor for Windows. Free, a single file, and nothing you open is sent anywhere.'),
    el('ul', { class: 'facts' },
      el('li', {}, el('span', {}, 'This copy'), el('span', {}, where)),
      el('li', {}, el('span', {}, 'Settings and data'), el('span', {}, '%LOCALAPPDATA%\\Emdedown')),
      el('li', {}, el('span', {}, 'Renderer'), el('span', {}, 'Microsoft Edge WebView2')),
      el('li', {}, el('span', {}, 'Built with'), el('span', {}, 'markdown-it, CodeMirror, highlight.js, KaTeX, Mermaid, DOMPurify')),
      el('li', {}, el('span', {}, 'License'), el('span', {}, 'MIT'))),
    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn', onclick: () => showLicenses() }, 'Third-party licenses'),
      el('button', { class: 'btn', onclick: () => showShortcuts() }, 'Keyboard shortcuts'),
      el('button', { class: 'btn primary', onclick: () => closeModal() }, 'Close'))));
}

/** Emdedown's licence and the third-party notices (web/dist/licenses.txt, built from THIRD-PARTY-NOTICES.md). */
async function showLicenses() {
  let text;
  try {
    const r = await fetch('licenses.txt');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    text = await r.text();
  } catch (e) { toast('Could not load the licenses: ' + e.message, 'error'); return; }
  openModal(el('div', {}, el('h2', {}, 'Licenses'),
    el('pre', { class: 'licenses-text', tabindex: '0' }, text),
    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn', onclick: () => showAbout() }, 'Back'),
      el('button', { class: 'btn primary', onclick: () => closeModal() }, 'Close'))), { wide: true });
}

// ---------------- install / welcome ----------------
function showWelcome(fromMenu) {
  const desk = el('input', { type: 'checkbox' });
  openModal(el('div', { class: 'welcome' },
    el('div', { class: 'logo big', html: LOGO }),
    el('h2', {}, 'Welcome to Emdedown'),
    el('p', {}, 'Read and write Markdown beautifully — tabs, live preview, diagrams, math, search and more. 100% offline.'),
    el('button', { class: 'btn primary huge', onclick: () => { const d = desk.checked; closeModal(); doInstall(d); } }, 'Install Emdedown'),
    el('label', { class: 'check-row' }, desk, 'Also add a shortcut to my desktop'),
    el('p', { class: 'muted small' }, 'Installs just for you — no admin rights needed. Adds Emdedown to the Start menu and opens .md files with a double-click. Uninstall anytime from Windows Settings.'),
    el('a', { href: '#', class: 'muted', onclick: (e) => { e.preventDefault(); closeModal(); } }, fromMenu ? 'Not now' : 'Just run it this time (portable)')), {
    onClose: () => { if (!S.welcomeDone) setSetting('welcomeDone', true); },
  });
}
/** Install (or update) from the Settings dialog or the command list: asks about the desktop shortcut first. */
async function installPrompt() {
  const desk = el('input', { type: 'checkbox', checked: !!env.desktopShortcut });
  const r = await ask(env.installed ? 'Update Emdedown?' : 'Install Emdedown?',
    'Installs just for you — no admin rights needed. Emdedown is added to the Start menu.',
    [{ label: env.installed ? 'Update' : 'Install', value: 'go', primary: true }, { label: 'Cancel', value: 'no' }],
    el('label', { class: 'check-row' }, desk, 'Also add a shortcut to my desktop'));
  if (r === 'go') doInstall(desk.checked);
}
async function setDesktopShortcut(on, box) {
  try {
    env.desktopShortcut = await call('setDesktopShortcut', { on });
    toast(env.desktopShortcut ? 'Desktop shortcut added' : 'Desktop shortcut removed');
  } catch (e) { toast('Could not change the desktop shortcut: ' + e.message, 'error'); }
  if (box) box.checked = !!env.desktopShortcut;
}
async function doInstall(desktop = false) {
  try {
    const r = await call('install', { desktop: !!desktop });
    env.installed = true;
    env.desktopShortcut = !!desktop;
    const where = desktop ? 'in the Start menu and on your desktop' : 'in the Start menu';
    const res = await ask('Emdedown is installed 🎉', `You can find it ${where}. Make it the app that opens .md files when you double-click them?`, [
      { label: 'Yes, open .md files with Emdedown', value: 'yes', primary: true }, { label: 'Not now', value: 'no' }]);
    if (res === 'yes') await makeDefault();
    if (r && r.relaunch) {
      // Switching to the installed copy closes this window. Only saved files are handed over, and with
      // "Reopen tabs on launch" off nothing else comes back, so settle unsaved work first, as Quit does.
      // Cancel (or a failed save) keeps this window open; the installed copy is used from the next start.
      if (!(await settleDirtyTabs())) { toast('Installed. Emdedown keeps running from this copy for now.'); return; }
      if (active && editor && active.edState && editor.currentTab === active) active.edState = editor.getState();
      flushAllDrafts();
      await saveAllSettingsNow();
      call('relaunchInstalled', { files: tabs.filter((t) => t.path).map((t) => t.path) }).catch(() => {});
    }
  } catch (e) { toast('Install failed: ' + e.message, 'error'); }
}
/**
 * Make Emdedown open .md files. If no app was ever chosen for .md, the host sets it directly.
 * Otherwise Windows 10 only allows the change in Settings > Default apps, so we open it and guide the user.
 */
async function makeDefault() {
  const r = await call('setDefault', { docPath: active && active.path ? active.path : null }).catch((e) => { toast(e.message, 'error'); return null; });
  if (r === 'set') { env.isDefault = true; toast('Done — double-clicking a .md file now opens Emdedown ✓'); return; }
  if (r !== 'settings') return;
  const done = await ask('Finish in Windows Settings', 'Windows asks you to confirm this yourself. Settings is now open:', [
    { label: 'I’ve done it', value: 'check', primary: true }, { label: 'Later', value: 'later' }],
  el('ol', { class: 'steps' },
    el('li', {}, 'Scroll down and click ', el('b', {}, 'Choose default apps by file type'), ' (the list takes a few seconds to load).'),
    el('li', {}, 'Find ', el('b', {}, '.md'), ' in the left column.'),
    el('li', {}, 'Click the app shown next to it and pick ', el('b', {}, 'Emdedown'), '.')));
  if (done !== 'check') return;
  env.isDefault = await call('isDefault').catch(() => false);
  if (env.isDefault) toast('Done — double-clicking a .md file now opens Emdedown ✓');
  else toast('Windows still lists another app for .md — try the steps again.', 'warn');
}
async function doUninstall() {
  const r = await ask('Uninstall Emdedown?', 'This removes the app, its shortcuts, file associations and settings from this PC. Your documents are not touched. If you have unsaved changes, you will be asked about them first.', [
    { label: 'Uninstall', value: 'yes', primary: true }, { label: 'Cancel', value: 'no' }]);
  if (r !== 'yes') return;
  // Uninstall deletes the app data folder (including recovery drafts) and closes the window without the
  // usual quit prompt, so unsaved work must be settled first. Cancel or a failed save stops the uninstall.
  if (!(await settleDirtyTabs())) return;
  call('uninstall').catch((e) => toast(e.message, 'error'));
}
function saveAllSettingsNow() { saveSession(); return call('saveSettings', { json: serializeSettings() }).catch(() => {}); }

/**
 * Ask Save / Don't save / Cancel for every tab with unsaved changes. Returns true when nothing unsaved is left
 * (saved, or explicitly discarded), false on Cancel or a failed save. Re-checks after saving, because text typed
 * while a save was being written makes a tab dirty again.
 */
async function settleDirtyTabs() {
  for (;;) {
    const dirty = tabs.filter((t) => isDirty(t) && !t.discarded);
    if (!dirty.length) return true;
    const r = await ask(dirty.length === 1 ? `Save changes to “${dirty[0].title}”?` : `Save changes to ${dirty.length} documents?`, dirty.map((t) => t.title).join(', '), [
      { label: dirty.length === 1 ? 'Save' : 'Save all', value: 'save', primary: true }, { label: "Don't save", value: 'discard' }, { label: 'Cancel', value: 'cancel' }]);
    if (r === 'cancel' || r == null) return false;
    if (r === 'discard') {
      // Marked so saveSession() neither re-lists these untitled tabs nor writes their drafts back.
      dirty.forEach((t) => { t.discarded = true; clearDraft(t, true); });
      return true;
    }
    for (const t of dirty) { activate(t); if (!(await saveTab(t))) return false; }
  }
}

// ---------------- quit ----------------
let quitting = false;
async function quit() {
  if (quitting) return;
  if (!(await settleDirtyTabs())) return;
  quitting = true;
  if (active && editor && active.edState && editor.currentTab === active) active.edState = editor.getState();
  flushAllDrafts();
  await saveAllSettingsNow();
  call('quit');
}

// Paper is white: print and PDF always use a light version (a dark version switches to its theme's light version).
let themeBeforePrint = null;
function printTheme(on) {
  const root = document.documentElement;
  if (on) {
    if (themeBeforePrint !== null) return;
    themeBeforePrint = root.dataset.theme;
    // The light version of the same theme (custom themes: GitHub light).
    if (isDark()) root.dataset.theme = S.theme.startsWith('custom:') ? 'light' : themeOf().light.id;
  } else if (themeBeforePrint !== null) {
    root.dataset.theme = themeBeforePrint;
    themeBeforePrint = null;
  }
}
window.addEventListener('beforeprint', () => printTheme(true));
window.addEventListener('afterprint', () => printTheme(false));

// ---------------- zoom ----------------
function zoom(d) {
  S.fontSize = d === 0 ? 16 : Math.max(10, Math.min(32, S.fontSize + d));
  applyTypography();
  saveSettings();
}

// ---------------- history (Alt+Left) ----------------
const closedTabs = [];

// ---------------- commands ----------------
command('open', 'Open file…', 'Ctrl+O', async () => {
  const paths = await call('openDialog', { dir: active && active.path ? dirname(active.path) : S.folder });
  if (paths && paths.length) for (const p of paths) await openFile(p);
});
command('openFolder', 'Open folder…', 'Ctrl+Shift+O', async () => {
  const dir = await call('folderDialog', { dir: S.folder });
  if (dir) { await loadFolder(dir, true); setSidebar(true); setSidebarPanel('files'); }
});
command('closeFolder', 'Close folder', '', () => closeFolder(), { when: () => !!S.folder });
command('clearRecent', 'Clear recent files…', '', () => clearRecent(), { when: () => S.recent.length > 0 });
command('new', 'New document', 'Ctrl+N', () => newDoc());
command('save', 'Save', 'Ctrl+S', () => saveTab(active), { when: () => !!active });
command('saveAs', 'Save as…', 'Ctrl+Shift+S', () => saveTab(active, true), { when: () => !!active });
command('saveAll', 'Save all', '', async () => { for (const t of tabs.filter(isDirty)) await saveTab(t); });
command('close', 'Close tab', 'Ctrl+W', () => active && closeTab(active), { when: () => !!active });
command('closeOthers', 'Close other tabs', '', () => closeTabs(tabs.filter((x) => x !== active)), { when: () => tabs.length > 1 });
command('closeRight', 'Close tabs to the right', '', () => closeTabs(tabs.slice(tabs.indexOf(active) + 1)), { when: () => !!active && tabs.indexOf(active) < tabs.length - 1 });
command('closeSaved', 'Close saved tabs', '', () => closeTabs(tabs.filter((x) => !isDirty(x))), { when: () => tabs.some((x) => !isDirty(x)) });
command('closeAll', 'Close all tabs', '', () => closeTabs(tabs.slice()), { when: () => tabs.length > 0 });
command('reopen', 'Reopen closed tab', 'Ctrl+Shift+T', () => { const p = closedTabs.pop(); if (p) openFile(p); });
command('nextTab', 'Next tab', 'Ctrl+Tab', () => { if (tabs.length > 1) activate(tabs[(tabs.indexOf(active) + 1) % tabs.length]); });
command('prevTab', 'Previous tab', 'Ctrl+Shift+Tab', () => { if (tabs.length > 1) activate(tabs[(tabs.indexOf(active) - 1 + tabs.length) % tabs.length]); });
command('quickOpen', 'Go to file…', 'Ctrl+P', () => openPalette('files'));
command('palette', 'Show all commands', 'Ctrl+Shift+P', () => openPalette('commands'), { hidden: true });
command('gotoHeading', 'Go to heading…', 'Ctrl+R', () => { ensureFresh(); openPalette('headings'); }, { when: () => !!active });
command('find', 'Find in document', 'Ctrl+F', () => openFind(), { when: () => !!active });
command('searchFolder', 'Search in folder', 'Ctrl+Shift+F', () => { setSidebar(true); setSidebarPanel('search'); const i = $('#search-input'); i.focus(); i.select(); });
command('toggleSidebar', 'Show / hide sidebar', 'Ctrl+\\', () => setSidebar(!S.sidebar));
command('showFiles', 'Show files', 'Ctrl+Shift+E', () => { setSidebar(true); setSidebarPanel('files'); });
command('showOutline', 'Show outline', '', () => { setSidebar(true); setSidebarPanel('outline'); });
command('modeRead', 'Read mode (preview only)', '', () => setMode('preview'), { when: () => !!active });
command('modeSplit', 'Split mode (edit + preview)', '', () => setMode('split'), { when: () => !!active });
command('modeEdit', 'Edit mode', '', () => setMode('edit'), { when: () => !!active });
command('cycleMode', 'Switch Read / Split / Edit', 'Ctrl+E', () => { if (!active) return; const order = ['preview', 'split', 'edit']; setMode(order[(order.indexOf(active.mode) + 1) % 3]); }, { when: () => !!active });
// Light/dark switches between the two versions of the current theme (it no longer jumps to GitHub).
command('toggleDark', 'Switch light / dark', 'Ctrl+Shift+L', () => setAppearance(isDark() ? 'light' : 'dark'));
command('changeTheme', 'Change theme…', '', () => openPalette('themes'));
command('appearanceLight', 'Appearance: Light', '', () => setAppearance('light'));
command('appearanceDark', 'Appearance: Dark', '', () => setAppearance('dark'));
command('appearanceSystem', 'Appearance: Follow Windows', '', () => setAppearance('system'));
for (const t of THEMES) command('theme-' + t.id, 'Theme: ' + t.name, '', () => { setSetting('theme', t.id); applyTheme(); }, { hidden: true });
function setAppearance(a) {
  setSetting('appearance', a);
  applyTheme();
  const box = modalEl.hidden ? null : $('#set-appearance', modalBox);
  if (box) $$('button', box).forEach((b) => b.classList.toggle('on', b.dataset.a === a));
}
command('zoomIn', 'Bigger text', 'Ctrl+=', () => zoom(1));
command('zoomOut', 'Smaller text', 'Ctrl+-', () => zoom(-1));
command('zoomReset', 'Reset text size', 'Ctrl+0', () => zoom(0));
command('focus', 'Focus mode', 'F11', () => toggleFocus());
/**
 * Output commands wait for diagrams, images and dialogs, during which the user can switch or close tabs.
 * Everything is taken from the tab that was active when the command started: its article, title and folder.
 * Commands that show the live page (print, PDF, slides) stop if that tab is no longer the one on screen.
 */
function outputSource() {
  const t = active;
  if (!t) return null;
  ensureFresh(t);
  return { t, article: t.article, title: t.title, name: stripExt(t.title), dir: t.path ? dirname(t.path) : null };
}
const stillShowing = (src) => {
  if (active === src.t && tabs.includes(src.t)) return true;
  toast('Cancelled: you switched to another document', 'warn');
  return false;
};
command('present', 'Present as slides', 'F5', async () => {
  const src = outputSource(); if (!src) return;
  await renderAllPending(src.article);
  if (stillShowing(src)) startSlides(src.article, isDark());
}, { when: () => !!active });
command('print', 'Print…', 'Ctrl+Alt+P', async () => {
  const src = outputSource(); if (!src) return;
  await renderAllPending(src.article);
  if (stillShowing(src)) window.print();
}, { when: () => !!active });
command('exportPdf', 'Export as PDF…', '', async () => {
  const src = outputSource(); if (!src) return;
  await renderAllPending(src.article);
  printTheme(true);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // The host prints the page as it is on screen, so the document must still be the one showing.
  const r = stillShowing(src) ? await call('exportPdf', { name: src.name + '.pdf', dir: src.dir }).catch((e) => toast(e.message, 'error')) : null;
  printTheme(false);
  if (r) toast('Saved ' + basename(r));
}, { when: () => !!active });
command('exportHtml', 'Export as HTML…', '', async () => {
  const src = outputSource(); if (!src) return;
  await renderAllPending(src.article);
  const html = await exportHtml(src.article, src.title, isDark());
  const r = await call('saveText', { name: src.name + '.html', filter: 'html', text: html, dir: src.dir }).catch((e) => toast(e.message, 'error'));
  if (r) toast('Saved ' + basename(r));
}, { when: () => !!active });
command('exportDocx', 'Export as Word (.docx)…', '', async () => {
  const src = outputSource(); if (!src) return;
  await renderAllPending(src.article);
  const html = await exportDocx(src.article, src.title);
  const r = await call('exportDocx', { name: src.name + '.docx', html, dir: src.dir }).catch((e) => toast(e.message, 'error'));
  if (r) toast('Saved ' + basename(r));
}, { when: () => !!active });
command('copyHtml', 'Copy as HTML (rich text)', '', async () => {
  const src = outputSource(); if (!src) return;
  await renderAllPending(src.article);
  const html = await exportDocx(src.article, src.title, true);
  const text = src.article.innerText || src.article.textContent;
  await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
  toast('Copied — paste into Word, Outlook, Gmail…');
}, { when: () => !!active });
command('reveal', 'Show file in Explorer', '', () => active && active.path && call('reveal', { path: active.path }), { when: () => !!(active && active.path) });
command('copyPath', 'Copy file path', '', () => { if (active && active.path) { navigator.clipboard.writeText(active.path); toast('Path copied'); } }, { when: () => !!(active && active.path) });
command('reload', 'Reload from disk', '', async () => {
  if (!active || !active.path) return;
  await reloadTab(active);
}, { when: () => !!(active && active.path) });
command('settings', 'Settings…', 'Ctrl+,', () => showSettings());
command('guide', 'Open the guide', '', () => openGuide());
command('shortcuts', 'Keyboard shortcuts', 'F1', () => showShortcuts());
command('install', 'Install Emdedown', '', () => installPrompt(), { when: () => !env.runningInstalled });
command('desktopShortcut', 'Add / remove desktop shortcut', '', () => setDesktopShortcut(!env.desktopShortcut), { when: () => env.installed });
command('about', 'About Emdedown', '', () => showAbout());
command('setDefault', 'Open .md files with Emdedown', '', () => makeDefault(), { when: () => !env.isDefault });
command('uninstall', 'Uninstall Emdedown', '', () => doUninstall(), { when: () => env.installed });
command('bold', 'Bold', 'Ctrl+B', () => editor && editor.format('Mod-b'), { when: () => !!active && active.mode !== 'preview' });
command('italic', 'Italic', 'Ctrl+I', () => editor && editor.format('Mod-i'), { when: () => !!active && active.mode !== 'preview' });
command('link', 'Insert link', 'Ctrl+K', () => editor && editor.format('Mod-k'), { when: () => !!active && active.mode !== 'preview' });
command('strike', 'Strikethrough', 'Ctrl+Shift+X', () => formatCmd('strike'), { when: () => !!active && active.mode !== 'preview' });
command('inlineCode', 'Inline code', 'Ctrl+`', () => formatCmd('code'), { when: () => !!active && active.mode !== 'preview' });
command('undo', 'Undo', 'Ctrl+Z', () => { if (!btnUndo.disabled) editor.undo(); updateChrome(); }, { when: () => !btnUndo.disabled });
command('redo', 'Redo', 'Ctrl+Y', () => { if (!btnRedo.disabled) editor.redo(); updateChrome(); }, { when: () => !btnRedo.disabled });
command('insertImage', 'Insert image…', '', async () => {
  if (!active) return;
  const t = active;
  const paths = await call('openDialog', { filter: 'image', dir: t.path ? dirname(t.path) : S.folder });
  if (paths && paths.length) for (const p of paths) if (active === t) await insertImageRef(p);
}, { when: () => !!active });
command('insertTable', 'Insert table', '', () => { if (!active) return; setMode(active.mode === 'preview' ? 'split' : active.mode); ensureEditor().then(() => editor.insertText('\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n')); });
command('insertToc', 'Insert table of contents', '', () => {
  if (!active) return;
  ensureFresh();
  if (!active.headings.length) { toast('No headings in this document', 'warn'); return; }
  const min = Math.min(...active.headings.map((h) => h.level));
  const toc = active.headings.map((h) => '  '.repeat(h.level - min) + `- [${h.text}](#${h.id})`).join('\n');
  setMode(active.mode === 'preview' ? 'split' : active.mode);
  ensureEditor().then(() => editor.insertText(toc + '\n'));
}, { when: () => !!(active && active.headings.length) });
command('quit', 'Exit Emdedown', 'Alt+F4', () => quit());


// ---------------- keyboard ----------------
const KEYMAP = {
  'ctrl+o': 'open', 'ctrl+shift+o': 'openFolder', 'ctrl+n': 'new', 'ctrl+s': 'save', 'ctrl+shift+s': 'saveAs', 'ctrl+w': 'close', 'ctrl+f4': 'close',
  'ctrl+tab': 'nextTab', 'ctrl+shift+tab': 'prevTab', 'ctrl+pagedown': 'nextTab', 'ctrl+pageup': 'prevTab', 'ctrl+shift+t': 'reopen',
  'ctrl+p': 'quickOpen', 'ctrl+shift+p': 'palette', 'ctrl+r': 'gotoHeading', 'ctrl+shift+f': 'searchFolder', 'ctrl+\\': 'toggleSidebar', 'ctrl+shift+e': 'showFiles',
  'ctrl+e': 'cycleMode', 'ctrl+shift+l': 'toggleDark', 'ctrl+=': 'zoomIn', 'ctrl++': 'zoomIn', 'ctrl+-': 'zoomOut', 'ctrl+0': 'zoomReset',
  f11: 'focus', f5: 'present', 'ctrl+alt+p': 'print', 'ctrl+,': 'settings', f1: 'shortcuts',
};
window.addEventListener('keydown', (e) => {
  if (!slidesEl.hidden) return; // slides handle their own keys
  const k = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase()].filter(Boolean).join('+');
  if (e.key === 'Escape') {
    if (!paletteEl.hidden) { closePalette(true); return; }
    if (!modalEl.hidden) { closeModal(); return; }
    if (!lightboxEl.hidden) { lightboxEl.hidden = true; return; }
    if (!findbarEl.hidden) { closeFind(); return; }
    if (app.classList.contains('focus')) { toggleFocus(); return; }
  }
  if (!modalEl.hidden && k !== 'ctrl+,') return;
  if (k === 'ctrl+f') {
    const inEditor = editorPane.contains(document.activeElement) && !app.classList.contains('mode-preview');
    if (!inEditor) { e.preventDefault(); openFind(); }
    return;
  }
  if (k === 'alt+arrowleft') { e.preventDefault(); goBack(); return; }
  const id = KEYMAP[k];
  if (id) { e.preventDefault(); e.stopPropagation(); cmd(id); }
}, true);
window.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1 : -1); } }, { passive: false });

// Back navigation between opened docs
const visitStack = [];
const samePath = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
function recordVisit(t) { if (t.path && !samePath(visitStack[visitStack.length - 1], t.path)) visitStack.push(t.path); if (visitStack.length > 50) visitStack.shift(); }
function goBack() { visitStack.pop(); const p = visitStack.pop(); if (p) { const t = tabs.find((x) => samePath(x.path, p)); if (t) activate(t); else openFile(p); } }

function toggleFocus() {
  const on = !app.classList.contains('focus');
  app.classList.toggle('focus', on);
  call('setFullscreen', { on }).catch(() => {});
  if (on) toast('Focus mode — press Esc or F11 to exit');
}

// ---------------- toolbar wiring ----------------
$$('#mode-switch button').forEach((b) => b.addEventListener('click', () => { if (active) setMode(b.dataset.mode); }));
$('#btn-theme').addEventListener('click', () => cmd('toggleDark'));
$('#btn-palette').addEventListener('click', () => openPalette('commands'));
$('#btn-settings').addEventListener('click', () => showSettings());
$('#btn-new').addEventListener('click', () => newDoc());
$('#btn-open').addEventListener('click', () => cmd('open'));
btnSave.addEventListener('click', () => { if (active) saveTab(active); });
btnUndo.addEventListener('click', () => cmd('undo'));
btnRedo.addEventListener('click', () => cmd('redo'));
$('#tabs').addEventListener('dblclick', (e) => { if (e.target.id === 'tabs') newDoc(); });
$('#tabs-wrap').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const b = e.target.closest('.tab');
  tabMenu(b ? tabs.find((x) => x.id === b.dataset.id) : null, e.clientX + 2, e.clientY + 2);
});

// Tooltips for the app's own buttons. The browser's built-in tooltip is unreliable here: it does not come
// back after a click until the mouse leaves, and it skips buttons the mouse just slid onto. This one shows
// after a short pause, follows the mouse from button to button at once, and also works on faded buttons.
const tipEl = $('#tip');
const TIP_AREAS = '#toolbar, #side-tabs, #sidebar .panel-head, #statusbar, #findbar';
let tipFor = null;
let tipTimer = 0;
let tipHiddenAt = 0;
function hideTip() {
  clearTimeout(tipTimer);
  if (!tipEl.hidden) tipHiddenAt = Date.now();
  tipEl.hidden = true;
  tipFor = null;
}
function placeTip(target) {
  if (!target.isConnected || !target.dataset.tip) return;
  tipEl.textContent = target.dataset.tip;
  tipEl.hidden = false;
  const r = target.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const below = r.bottom + 6 + h < innerHeight;
  tipEl.style.left = Math.max(4, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 4)) + 'px';
  tipEl.style.top = (below ? r.bottom + 6 : r.top - h - 6) + 'px';
}
document.addEventListener('mouseover', (e) => {
  const target = e.target.closest && e.target.closest('[title],[data-tip]');
  if (!target || !target.closest(TIP_AREAS) || !menuEl.hidden) { if (tipFor) hideTip(); return; }
  // Take over the text so the browser's own tooltip never shows as well (code may set .title again later).
  if (target.hasAttribute('title')) { target.dataset.tip = target.getAttribute('title'); target.removeAttribute('title'); }
  if (target === tipFor) return;
  const quick = !tipEl.hidden || Date.now() - tipHiddenAt < 500;
  hideTip();
  tipFor = target;
  tipTimer = setTimeout(() => placeTip(target), quick ? 40 : 450);
}, true);
document.addEventListener('mouseout', (e) => { if (tipFor && !tipFor.contains(e.relatedTarget)) hideTip(); }, true);
for (const type of ['mousedown', 'wheel', 'keydown']) window.addEventListener(type, () => { if (tipFor) { hideTip(); tipHiddenAt = 0; } }, { capture: true, passive: true });
window.addEventListener('blur', hideTip);
$('#tabs').addEventListener('wheel', (e) => { if (!e.ctrlKey) { e.currentTarget.scrollLeft += e.deltaY; } }, { passive: true });

// Formatting buttons (Split/Edit). mousedown is cancelled so the editor keeps focus and its selection.
formatBar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
formatBar.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-fmt]');
  if (!b || !active) return;
  if (b.dataset.fmt === 'heading') {
    const r = b.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, [
      { label: 'Heading 1', key: 'Ctrl+1', run: () => formatCmd('h1') },
      { label: 'Heading 2', key: 'Ctrl+2', run: () => formatCmd('h2') },
      { label: 'Heading 3', key: 'Ctrl+3', run: () => formatCmd('h3') },
    ]);
    return;
  }
  formatCmd(b.dataset.fmt);
});
btnSync.addEventListener('click', () => {
  setSetting('syncScroll', !S.syncScroll);
  updateChrome();
  if (S.syncScroll) { scrollDriver = 'editor'; syncPreviewToEditor(); }
  toast(S.syncScroll ? 'Sync scrolling on' : 'Sync scrolling off');
});

// Small popup menu (heading picker, split divider). items: { label, key?, checked?, run } or 'sep'.
const menuEl = $('#menu');
function showMenu(x, y, items) {
  menuEl.textContent = '';
  for (const it of items) {
    if (it === 'sep') { menuEl.append(el('div', { class: 'menu-sep' })); continue; }
    menuEl.append(el('button', { class: 'menu-item' + (it.checked ? ' checked' : ''), role: 'menuitem',
      onmousedown: (e) => e.preventDefault(), // keep the editor's focus and selection
      onclick: () => { hideMenu(); it.run(); } },
    el('span', { class: 'menu-check' }, it.checked ? '✓' : ''), el('span', { class: 'menu-label' }, it.label), el('span', { class: 'menu-key' }, it.key || '')));
  }
  menuEl.hidden = false;
  const w = menuEl.offsetWidth;
  const h = menuEl.offsetHeight;
  menuEl.style.left = Math.max(4, Math.min(x, innerWidth - w - 4)) + 'px';
  menuEl.style.top = Math.max(4, Math.min(y, innerHeight - h - 4)) + 'px';
}
function hideMenu() { menuEl.hidden = true; }
window.addEventListener('mousedown', (e) => { if (!menuEl.hidden && !menuEl.contains(e.target)) hideMenu(); }, true);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menuEl.hidden) { e.stopPropagation(); hideMenu(); } }, true);
window.addEventListener('blur', hideMenu);
window.addEventListener('resize', hideMenu);

// Split divider: right-click for preset sizes, double-click to reset to the middle.
const splitResizer = $('#split-resizer');
splitResizer.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const cur = Math.round(S.splitRatio * 100);
  const preset = (ed) => ({ label: `Editor ${ed}% · Preview ${100 - ed}%`, checked: cur === ed, run: () => setSplit(ed / 100) });
  showMenu(e.clientX + 2, e.clientY, [{ label: 'Reset to the middle', key: 'Double-click', run: () => setSplit(0.5) }, 'sep',
    preset(80), preset(70), preset(60), preset(50), preset(40), preset(30), preset(20)]);
});
// Detected on the second press: a drag starts on mousedown and disables pointer events everywhere until the
// button is released, so the divider itself never receives click or dblclick events.
splitResizer.addEventListener('mousedown', (e) => { if (e.button === 0 && e.detail === 2) setSplit(0.5); });

// Tab strip scroll bar: a thin bar under the tabs, shown only when they don't all fit. Drag it, or use the wheel.
const tabsBox = $('#tabs');
const tabsTrack = $('#tabs-track');
const tabsThumb = $('#tabs-thumb');
function updateTabsBar() {
  const { scrollWidth: sw, clientWidth: cw, scrollLeft: sl } = tabsBox;
  const over = sw > cw + 1;
  tabsTrack.hidden = !over;
  if (!over) return;
  const w = Math.max(24, (cw / sw) * cw);
  tabsThumb.style.width = w + 'px';
  tabsThumb.style.transform = `translateX(${(sl / (sw - cw)) * (cw - w)}px)`;
}
tabsBox.addEventListener('scroll', updateTabsBar, { passive: true });
new ResizeObserver(updateTabsBar).observe(tabsBox);
tabsTrack.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const { scrollWidth: sw, clientWidth: cw } = tabsBox;
  const thumbW = tabsThumb.offsetWidth;
  const r = tabsTrack.getBoundingClientRect();
  const onThumb = e.target === tabsThumb;
  const grab = onThumb ? e.clientX - tabsThumb.getBoundingClientRect().left : thumbW / 2;
  const to = (x) => { tabsBox.scrollLeft = ((x - r.left - grab) / Math.max(1, cw - thumbW)) * (sw - cw); };
  to(e.clientX);
  const move = (ev) => to(ev.clientX);
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});

// ---------------- drag & drop files ----------------
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; if (!editorPane.contains(e.target)) dropzoneEl.hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropzoneEl.hidden = true; } });
window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  dragDepth = 0;
  dropzoneEl.hidden = true;
  if (e.defaultPrevented || !e.dataTransfer.files.length) return;
  e.preventDefault();
  sendDroppedFiles(Array.from(e.dataTransfer.files));
});

// Context menu: keep native menu in editor (spellcheck suggestions) but hide "back/reload" elsewhere
window.addEventListener('contextmenu', (e) => {
  if (editorPane.contains(e.target) || e.target.closest('input,textarea')) return;
  const sel = String(window.getSelection() || '');
  if (!sel) e.preventDefault();
});

// ---------------- boot ----------------
const LOGO = '<svg viewBox="0 0 64 64"><rect x="4" y="4" width="56" height="56" rx="14" fill="var(--accent)"/><g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 43V27M14 32c0-7 10-7 10 0v11M24 32c0-7 10-7 10 0v11M50 19v24"/><circle cx="44" cy="37" r="6"/></g></svg>';

setScrollRoot(previewPane);

// Read a file through the host's streaming endpoint (much faster than JSON for big files).
async function readText(path) {
  try {
    const r = await fetch(fileUrl(path) + '?read=1');
    if (!r.ok) throw new Error(r.status === 404 ? 'File not found' : 'HTTP ' + r.status);
    const text = await r.text();
    const xp = r.headers.get('X-Path');
    // X-MTime is a decimal tick string beyond 2^53: keep it as a string.
    return { path: xp ? decodeURIComponent(xp) : path, text, eol: r.headers.get('X-Eol') || 'LF', mtime: r.headers.get('X-MTime') || null, enc: r.headers.get('X-Enc') || 'utf8' };
  } catch (e) {
    if (!isHosted) throw e;
    return call('readFile', { path });
  }
}

async function boot() {
  let init = { settings: '{}', files: [], installed: false, runningInstalled: false, version: 'dev', themes: [], themesDir: '' };
  if (isHosted) { try { init = await call('init'); } catch (e) { console.error(e); } }
  let saved = {};
  try { saved = JSON.parse(init.settings || '{}') || {}; } catch { saved = {}; }
  S = { ...DEFAULTS, ...saved };
  migrateThemeSetting(saved);
  explicitFolder = S.folder || null;
  S.recent = (S.recent || []).filter((p) => !IMG_EXT.test(p));
  env = init;
  document.documentElement.style.setProperty('--sidebar-w', S.sidebarWidth + 'px');
  document.documentElement.style.setProperty('--split', S.splitRatio);
  applyTheme();
  applyTypography();
  app.classList.toggle('no-sidebar', !S.sidebar);
  setSidebarPanel(S.sidebarPanel);

  const files = init.files || [];
  // Unsaved work handed to the host when Windows last shut down (see 'sessionEnding'): put the drafts back where
  // the normal restore looks for them. They are the newest copy, so they replace older drafts of the same tab.
  let recovery = null;
  try { recovery = init.recovery ? JSON.parse(init.recovery) : null; } catch { recovery = null; }
  if (recovery && recovery.drafts) {
    for (const [k, v] of Object.entries(recovery.drafts)) {
      if (typeof v === 'string' && k.startsWith('draft:')) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
    }
  }
  // Restore the previous session first, even when launched with files (double-click in Explorer):
  // replacing it would orphan its untitled drafts, which are only reachable through the session list.
  // The launch files are then opened on top and become the active tab.
  // With "Reopen tabs on launch" off, the tabs that had unsaved work at shutdown still come back.
  const toRestore = S.restoreSession && S.session && S.session.tabs ? S.session
    : (recovery && recovery.session && Array.isArray(recovery.session.tabs) ? recovery.session : null);
  if (toRestore) {
    const session = toRestore; // openFile/newDoc would otherwise rewrite S.session mid-restore
    const oldKeys = [];
    let wantTab = null;
    restoringSession = true;
    try {
      for (const st of session.tabs) {
        if (st.path) {
          const t = await openFile(st.path, { mode: st.mode });
          if (t) { t.mode = st.mode || t.mode; if (samePath(st.path, session.active)) wantTab = t; }
        } else {
          const oldKey = 'draft:untitled:' + st.untitled;
          let text = null;
          try { text = localStorage.getItem(oldKey); } catch { /* ignore */ }
          if (text) {
            const t = newDoc(text);
            t.mode = st.mode || 'split';
            // Keep the content safe at every moment: write it under the new tab id first;
            // the old key is removed only after the new session has been persisted.
            try { localStorage.setItem('draft:untitled:' + t.id, text); } catch { /* ignore */ }
            if (st.untitled === session.active) wantTab = t;
          }
          oldKeys.push(oldKey);
        }
      }
    } finally { restoringSession = false; }
    if (wantTab) activate(wantTab);
    saveSession();
    let persisted = false;
    if (isHosted) persisted = await call('saveSettings', { json: serializeSettings() }).then(() => true, () => false);
    if (persisted) {
      const live = new Set(tabs.filter((x) => !x.path).map((x) => 'draft:untitled:' + x.id));
      for (const k of oldKeys) if (!live.has(k)) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
    }
  }
  if (recovery && isHosted) {
    // The drafts are in browser storage again and the tabs are open: the snapshot has done its job.
    saveSession();
    await call('saveSettings', { json: serializeSettings() }).catch(() => {});
    call('clearRecovery').catch(() => {});
    if (recovery.drafts && Object.keys(recovery.drafts).length) toast('Recovered unsaved changes from when Windows shut down');
  }
  if (files.length) await openPaths(files, init.edit);
  if (S.folder) loadFolder(S.folder);
  else { renderTree(); $('#btn-refresh').hidden = true; }
  if (!tabs.length) showStart();
  updateChrome();
  if (isHosted) call('ready').catch(() => {});
  if (!env.installed && !S.welcomeDone && isHosted) setTimeout(() => showWelcome(false), 350);

  // remember visits for Alt+Left
}

boot();

// Expose for debugging
window.MDV = { tabs, get active() { return active; }, get S() { return S; }, openFile, cmd, call, exportHtml, exportDocx, get editor() { return editor; }, loadFolder, closeFolder, setMode, saveTab, newDoc, closeTab, formatCmd, showStart };
