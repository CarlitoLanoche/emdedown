// Export helpers: self-contained HTML, Word-friendly HTML (for .docx and rich-text copy).
import { ID_PREFIX } from './render.js';

let docCss = null;
async function getDocCss() {
  if (docCss == null) docCss = await fetch('export.css').then((r) => r.text()).catch(() => '');
  return docCss;
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
}

// Image types an export may embed, each with a check of the file's first bytes. Only bytes that really are an
// image of the claimed type are copied into an export, never "whatever the path points at" (a document could
// otherwise name a private text file as an image and have its contents end up in the exported file).
const startsWith = (b, sig, at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b, at, s) => startsWith(b, Array.from(s, (c) => c.charCodeAt(0)), at);
const IMAGE_SNIFF = {
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/apng': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/gif': (b) => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'),
  'image/webp': (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'),
  'image/bmp': (b) => ascii(b, 0, 'BM'),
  'image/x-icon': (b) => startsWith(b, [0, 0, 1, 0]) || startsWith(b, [0, 0, 2, 0]),
  'image/avif': (b) => ascii(b, 4, 'ftyp') && (ascii(b, 8, 'avif') || ascii(b, 8, 'avis')),
};
const MAX_EMBED = 50 * 1024 * 1024;

/** The response as a data: URL if it is a genuine image, else null. */
async function imageDataUrl(r) {
  const type = (r.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const blob = await r.blob();
  if (!blob.size || blob.size > MAX_EMBED) return null;
  if (type === 'image/svg+xml') {
    // Must parse as an SVG document; it is shown through <img>, where SVG scripts never run.
    const doc = new DOMParser().parseFromString(await blob.text(), 'image/svg+xml');
    if (doc.querySelector('parsererror') || !doc.documentElement || doc.documentElement.localName !== 'svg') return null;
  } else {
    const sniff = IMAGE_SNIFF[type];
    if (!sniff || !sniff(new Uint8Array(await blob.slice(0, 16).arrayBuffer()))) return null;
  }
  return blobToDataUrl(new Blob([blob], { type }));
}

async function inlineImages(root) {
  await Promise.all(Array.from(root.querySelectorAll('img')).map(async (img) => {
    const src = img.getAttribute('src') || '';
    if (!src || src.startsWith('data:')) return;
    try {
      const r = await fetch(src);
      const url = r.ok ? await imageDataUrl(r) : null;
      if (url) img.setAttribute('src', url);
      else if (src.startsWith('https://file.emdedown/')) {
        // Not embeddable: keep the document's own relative reference rather than an app-internal URL.
        const orig = img.getAttribute('data-orig-src');
        if (orig) img.setAttribute('src', orig);
      }
    } catch { /* leave remote URL */ }
    img.removeAttribute('loading');
    img.removeAttribute('data-orig-src');
  }));
}

function cleanClone(article) {
  const c = article.cloneNode(true);
  c.removeAttribute('hidden');
  // A task ticked in the reader changes the box's live state, not its "checked" attribute, and serializing
  // (innerHTML) writes only attributes. Copy the live state across before anything is removed.
  const liveBoxes = article.querySelectorAll('input.task');
  c.querySelectorAll('input.task').forEach((box, i) => {
    const on = liveBoxes[i] ? liveBoxes[i].checked : box.checked;
    box.checked = on;
    box.toggleAttribute('checked', on);
  });
  c.querySelectorAll('.copy-btn,.anchor').forEach((x) => x.remove());
  c.querySelectorAll('mark.find-hit').forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
  c.querySelectorAll('[data-line]').forEach((x) => x.removeAttribute('data-line'));
  // Inside the app, document ids carry ID_PREFIX; exported files stand alone, so restore the plain
  // ids that the document's own "#x" links and footnote links point at.
  const unprefix = (v) => (v && v.startsWith(ID_PREFIX) ? v.slice(ID_PREFIX.length) : v);
  c.querySelectorAll(`[id^="${ID_PREFIX}"]`).forEach((x) => { x.id = unprefix(x.id); });
  c.querySelectorAll(`a[name^="${ID_PREFIX}"]`).forEach((x) => x.setAttribute('name', unprefix(x.getAttribute('name'))));
  // Same for references inside inline SVG (fill="url(#grad)", href="#path").
  c.querySelectorAll('svg, svg *').forEach((x) => {
    for (const at of Array.from(x.attributes)) {
      if (!at.value.includes('#' + ID_PREFIX)) continue;
      at.value = at.value.split('#' + ID_PREFIX).join('#');
    }
  });
  // Math: keep MathML only (renders natively, no fonts needed).
  c.querySelectorAll('.math-inline,.math-block').forEach((m) => {
    const ml = m.querySelector('.katex-mathml math');
    if (ml) { m.innerHTML = ''; m.appendChild(ml); }
  });
  return c;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export async function exportHtml(article, title, dark) {
  const c = cleanClone(article);
  await inlineImages(c);
  c.querySelectorAll('input.task').forEach((i) => i.setAttribute('disabled', ''));
  const css = await getDocCss();
  const theme = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Emdedown">
<title>${esc(title.replace(/\.\w+$/, ''))}</title>
<style>
${css}
body{margin:0;background:var(--bg);color:var(--fg)}
.markdown-body{max-width:860px;margin:0 auto;padding:48px 32px 96px}
</style>
</head>
<body>
<article class="markdown-body">
${c.innerHTML}
</article>
</body>
</html>`;
}

async function svgToPng(svg) {
  const xml = new XMLSerializer().serializeToString(svg);
  const box = svg.getBoundingClientRect();
  const w = Math.max(1, Math.round(box.width || svg.viewBox.baseVal.width || 600));
  const h = Math.max(1, Math.round(box.height || svg.viewBox.baseVal.height || 400));
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = w * 2; canvas.height = h * 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { url: canvas.toDataURL('image/png'), w, h };
}

/** HTML tuned for Word (inline styles, PNG diagrams, no CSS variables). */
export async function exportDocx(article, title, forClipboard = false) {
  const c = cleanClone(article);
  // Image sizes come from the live document (the clone is detached, so it has no layout).
  // cleanClone keeps every <img>, so the two lists line up; check anyway.
  const liveImgs = Array.from(article.querySelectorAll('img'));
  const cloneImgs = Array.from(c.querySelectorAll('img'));
  const imgPairs = liveImgs.length === cloneImgs.length ? cloneImgs.map((img, i) => [img, liveImgs[i]]) : cloneImgs.map((img) => [img, null]);
  // Diagrams -> PNG (Word cannot render inline SVG from HTML). Pair each cloned block with the live
  // block at the same position, so a diagram that failed to render does not shift the others.
  const liveBlocks = Array.from(article.querySelectorAll('.mermaid-block'));
  const cloneBlocks = Array.from(c.querySelectorAll('.mermaid-block'));
  for (let i = 0; i < cloneBlocks.length; i++) {
    const svg = liveBlocks[i] && liveBlocks[i].querySelector('svg');
    if (!svg) continue;
    try {
      const { url, w, h } = await svgToPng(svg);
      const scale = Math.min(1, 620 / w);
      cloneBlocks[i].innerHTML = `<img src="${url}" width="${Math.round(w * scale)}" height="${Math.round(h * scale)}">`;
    } catch { /* keep as is */ }
  }
  await inlineImages(c);
  // Size images for the page: Word ignores max-width, so give images without an explicit width
  // their natural size capped at the text width (620px, same as the diagrams).
  for (const [img, live] of imgPairs) {
    if (img.getAttribute('width')) continue;
    const w = live ? live.naturalWidth : 0;
    const h = live ? live.naturalHeight : 0;
    if (w && h) {
      const scale = Math.min(1, 620 / w);
      img.setAttribute('width', String(Math.round(w * scale)));
      img.setAttribute('height', String(Math.round(h * scale)));
    }
    img.style.maxWidth = '100%';
  }
  c.querySelectorAll('input.task').forEach((i) => i.replaceWith(document.createTextNode(i.checked ? '☑ ' : '☐ ')));
  c.querySelectorAll('.code-lang').forEach((x) => x.remove());
  c.querySelectorAll('.callout-title svg').forEach((x) => x.remove());
  const css = `
body{font-family:Calibri,'Segoe UI',sans-serif;font-size:11pt;line-height:1.45;color:#1f2328}
h1{font-size:22pt;color:#1f2328;border-bottom:1px solid #d0d7de;padding-bottom:4pt}
h2{font-size:16pt;color:#1f2328;border-bottom:1px solid #d0d7de;padding-bottom:3pt}
h3{font-size:13pt} h4,h5,h6{font-size:11pt}
a{color:#0969da}
code{font-family:Consolas,monospace;font-size:10pt;background:#f2f4f7}
pre{font-family:Consolas,monospace;font-size:9.5pt;background:#f6f8fa;border:1px solid #d0d7de;padding:8pt;white-space:pre-wrap}
pre code{background:transparent}
blockquote{border-left:3pt solid #d0d7de;margin-left:0;padding-left:10pt;color:#59636e}
table{border-collapse:collapse} th,td{border:1px solid #d0d7de;padding:4pt 8pt} th{background:#f6f8fa}
.callout{border-left:3pt solid #0969da} .callout-warning{border-color:#9a6700} .callout-caution{border-color:#d1242f} .callout-tip{border-color:#1a7f37} .callout-important{border-color:#8250df}
.callout-title{font-weight:bold}
.hljs-keyword,.hljs-selector-tag,.hljs-built_in{color:#cf222e} .hljs-string,.hljs-attr{color:#0a3069} .hljs-comment{color:#6e7781;font-style:italic} .hljs-number,.hljs-literal{color:#0550ae} .hljs-title,.hljs-function{color:#8250df}
.front-matter th{text-align:left}
li.task-item{list-style:none}
`;
  const body = c.innerHTML;
  if (forClipboard) return `<html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
  return `<html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>${body}</body></html>`;
}
