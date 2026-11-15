// Bridge between the web UI and the C# host (WebView2 postMessage).
const wv = window.chrome && window.chrome.webview;
let nextId = 1;
const pending = new Map();
const listeners = new Map();

if (wv) {
  wv.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.replyTo) {
      const p = pending.get(msg.replyTo);
      if (p) {
        pending.delete(msg.replyTo);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      }
      return;
    }
    const fns = listeners.get(msg.type);
    if (fns) fns.forEach((fn) => { try { fn(msg); } catch (err) { console.error(err); } });
  });
}

export const isHosted = !!wv;

/** Call a host method and await its result. */
export function call(method, args = {}) {
  if (!wv) return Promise.reject(new Error('Not running inside Emdedown host'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    wv.postMessage({ id, method, args });
  });
}

/** Send files dropped onto the page to the host (gives the host their real paths). */
export function sendDroppedFiles(files) {
  if (!wv || !wv.postMessageWithAdditionalObjects) return false;
  wv.postMessageWithAdditionalObjects({ method: 'dropFiles' }, files);
  return true;
}

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
}

// URL used to load a local file (images etc.) through the host.
export function fileUrl(absPath) {
  const norm = absPath.replace(/\\/g, '/');
  return 'https://file.emdedown/' + norm.split('/').map(encodeURIComponent).join('/');
}
