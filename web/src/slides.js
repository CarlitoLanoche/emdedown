// Presentation mode: split the rendered document into slides.
// A new slide starts at every horizontal rule (---, which is not shown) and at every H1/H2 heading.
// A slide that is still too tall continues on the next slide(s), so nothing is cut off.
import { call } from './host.js';

const SLIDE_H = 640; // usable height inside the 1280×720 stage
const BASE_PX = 30; // normal slide text size
const MIN_PX = 22; // pages are cut so text never has to shrink below this; a single huge block may still shrink further

export function startSlides(article, dark) {
  const blocks = Array.from(article.children).filter((n) => !n.classList.contains('front-matter'));
  let sections = [];
  let cur = [];
  for (const b of blocks) {
    const hr = b.tagName === 'HR';
    if ((hr || /^H[12]$/.test(b.tagName)) && cur.length) { sections.push(cur); cur = []; }
    if (!hr) cur.push(b);
  }
  if (cur.length) sections.push(cur);
  sections = sections.filter((s) => s.some((n) => n.textContent.trim() || n.querySelector('img,svg')));
  if (!sections.length) return;

  const root = document.getElementById('slides');
  const stage = document.getElementById('slide-stage');
  const slideEl = document.getElementById('slide');
  const counter = document.getElementById('slide-count');
  let i = 0;
  root.hidden = false;
  root.classList.toggle('dark', dark);
  call('setFullscreen', { on: true }).catch(() => {});

  const fill = (nodes, px) => {
    slideEl.className = 'markdown-body';
    slideEl.innerHTML = '';
    slideEl.style.fontSize = px + 'px';
    nodes.forEach((node) => slideEl.appendChild(node.cloneNode(true)));
    slideEl.querySelectorAll('.copy-btn,.anchor').forEach((x) => x.remove());
  };
  // Measure in the real slide element (layout size is not affected by the stage's scale transform).
  const fits = (nodes) => { fill(nodes, MIN_PX); return slideEl.scrollHeight <= SLIDE_H; };
  // A table or list too tall for a whole slide on its own is cut into pieces that fit (tables repeat their header).
  const splitBlock = (b) => {
    const table = b.tagName === 'TABLE' ? b : b.querySelector(':scope > table');
    const rows = table ? Array.from(table.querySelectorAll(':scope > tbody > tr')) : null;
    const items = /^(UL|OL)$/.test(b.tagName) ? Array.from(b.children) : null;
    const parts = rows || items;
    if (!parts || parts.length < 2) return null;
    const make = (chunk, start) => {
      const c = b.cloneNode(false);
      if (table) {
        const t = table.cloneNode(false);
        const head = table.querySelector(':scope > thead');
        if (head) t.appendChild(head.cloneNode(true));
        const body = document.createElement('tbody');
        chunk.forEach((r) => body.appendChild(r.cloneNode(true)));
        t.appendChild(body);
        if (b === table) return t;
        c.appendChild(t);
      } else {
        chunk.forEach((li) => c.appendChild(li.cloneNode(true)));
        if (b.tagName === 'OL') c.setAttribute('start', String((+b.getAttribute('start') || 1) + start));
      }
      return c;
    };
    const out = [];
    let chunk = [];
    let start = 0;
    for (const p of parts) {
      if (chunk.length && !fits([make([...chunk, p], start)])) { out.push(make(chunk, start)); start += chunk.length; chunk = []; }
      chunk.push(p);
    }
    if (chunk.length) out.push(make(chunk, start));
    return out.length > 1 ? out : null;
  };
  const slides = [];
  for (const raw of sections) {
    if (fits(raw)) { slides.push(raw); continue; }
    const sec = raw.flatMap((b) => (fits([b]) ? [b] : (splitBlock(b) || [b])));
    let page = [];
    for (const b of sec) {
      if (page.length && !fits([...page, b])) {
        // Keep a heading with the block after it rather than leaving it alone at the bottom of a slide.
        const last = page[page.length - 1];
        if (page.length > 1 && /^H[1-6]$/.test(last.tagName)) { page.pop(); slides.push(page); page = [last, b]; } else { slides.push(page); page = [b]; }
      } else page.push(b);
    }
    if (page.length) slides.push(page);
  }

  const fit = () => {
    const s = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
    stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  };
  const show = (n) => {
    i = Math.max(0, Math.min(slides.length - 1, n));
    let size = BASE_PX;
    fill(slides[i], size);
    const only = slideEl.children.length === 1 && /^H[12]$/.test(slideEl.firstElementChild.tagName);
    slideEl.classList.toggle('title-slide', only || (i === 0 && slideEl.children.length <= 3));
    // Shrink the text only as far as needed (pages were cut to fit at MIN_PX; one oversized block may go lower).
    while (slideEl.scrollHeight > SLIDE_H && size > 14) { size -= 2; slideEl.style.fontSize = size + 'px'; }
    counter.textContent = `${i + 1} / ${slides.length}`;
  };
  const key = (e) => {
    const k = e.key;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n'].includes(k)) { e.preventDefault(); show(i + 1); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p'].includes(k)) { e.preventDefault(); show(i - 1); }
    else if (k === 'Home') show(0);
    else if (k === 'End') show(slides.length - 1);
    else if (k === 'Escape' || k === 'F5' || k === 'q') { e.preventDefault(); stop(); }
  };
  // #slide sits outside #docs, so the app's link handler never sees these clicks: never let a link
  // navigate the WebView itself. Web and mail links open externally; everything else is ignored.
  const click = (e) => {
    const a = e.target.closest('a');
    if (a) {
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      if (/^(https?:|mailto:)/i.test(href)) call('openExternal', { url: href }).catch(() => {});
      return;
    }
    show(e.clientX < window.innerWidth / 3 ? i - 1 : i + 1);
  };
  function stop() {
    root.hidden = true;
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('resize', fit);
    root.removeEventListener('click', click);
    call('setFullscreen', { on: false }).catch(() => {});
  }
  window.addEventListener('keydown', key, true);
  window.addEventListener('resize', fit);
  root.addEventListener('click', click);
  fit();
  show(0);
  setTimeout(fit, 150);
}
