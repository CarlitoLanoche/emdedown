// Drive a running Emdedown over the Chrome DevTools Protocol (needs the app started via relaunch.ps1).
// usage:  node tools/dev/cdp.mjs eval "<js expression or (async()=>{...})()>"
//         node tools/dev/cdp.mjs shot out.png
// In page JS, `window.MDV` exposes: tabs, active, S (settings), openFile, cmd(id), call(hostMethod,args),
// exportHtml, exportDocx, editor, loadFolder, setMode, saveTab.
const [, , mode, arg] = process.argv;
const port = process.env.MDV_CDP_PORT || 9333;
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith('https://app.emdedown'));
if (!page) { console.error('Emdedown page not found on port ' + port); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
if (mode === 'eval') {
  const r = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result.result ? (r.result.result.value ?? r.result.result.description) : r, null, 1));
  if (r.result.exceptionDetails) console.log('EXC', JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
} else if (mode === 'shot') {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  (await import('node:fs')).writeFileSync(arg, Buffer.from(r.result.data, 'base64'));
  console.log('saved', arg);
}
ws.close();
process.exit(0);
