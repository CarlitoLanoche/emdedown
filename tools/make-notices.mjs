// Regenerates THIRD-PARTY-NOTICES.md from what the web bundle actually contains: run `node tools/make-notices.mjs` after `npm ci` in web/ and after every dependency change.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web');
const nm = path.join(web, 'node_modules');
const esbuild = createRequire(path.join(web, 'package.json'))('esbuild');
const WV_VERSION = '1.0.4129.50'; // keep in sync with $wvVersion in build.ps1
const wvPkg = path.join(root, '.deps/webview2/pkg');

// Per-package decisions that package.json alone does not express.
const OVERRIDES = {
  dompurify: { license: 'Apache-2.0', files: ['LICENSE'], note: 'DOMPurify is dual-licensed (MPL-2.0 OR Apache-2.0). Emdedown uses it under the Apache License 2.0.' },
  elkjs: { license: 'EPL-2.0', note: 'elkjs is dual-licensed (EPL-2.0 OR GPL-3.0-or-later). Emdedown uses it under the Eclipse Public License 2.0. Emdedown distributes elkjs in object code form only (bundled and minified inside Emdedown.exe); its Source Code is available from the elkjs repository: https://github.com/kieler/elkjs' },
  khroma: { license: 'MIT', note: 'package.json has no "license" field; the MIT License is stated in the package\'s own license file, reproduced below.' },
};

// ---- 1. Which npm packages end up in the bundle (same esbuild options as web/build.mjs) ----
const common = { bundle: true, write: false, metafile: true, logLevel: 'warning', target: ['chrome120'], absWorkingDir: web };
const js = await esbuild.build({ ...common, entryPoints: ['src/app.js'], outdir: 'dist', splitting: true, format: 'esm', define: { 'process.env.NODE_ENV': '"production"' } });
const css = await esbuild.build({ ...common, entryPoints: { app: 'src/styles/app.css', export: 'src/styles/export.css' }, outdir: 'dist' });
const dirs = new Set(['node_modules/katex']); // katex.css and fonts are also copied by build.mjs directly
for (const m of [js.metafile, css.metafile]) {
  for (const input of Object.keys(m.inputs)) {
    const p = input.replace(/\\/g, '/');
    const re = /node_modules\/(?:@[^/]+\/)?[^/]+/g;
    let last = null; let x;
    while ((x = re.exec(p))) last = x;
    if (last) dirs.add(p.slice(0, last.index + last[0].length));
  }
}

const read = (f) => fs.readFileSync(f, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
const LICENSE_FILE = /^(licen[cs]e|copying)(-[\w]+)?(\.(md|txt|markdown|rst))?$/i;
const NOTICE_FILE = /^notice(\.(md|txt))?$/i;

function repoUrl(pj) {
  let r = pj.repository;
  if (r && typeof r === 'object') r = r.url;
  if (typeof r === 'string' && r) {
    r = r.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/^git@([^:]+):/, 'https://$1/');
    const short = /^(github|gitlab|bitbucket):(.+)$/.exec(r);
    if (short) r = `https://${short[1] === 'bitbucket' ? 'bitbucket.org' : short[1] + '.com'}/${short[2]}`;
    else if (/^[\w.-]+\/[\w.-]+$/.test(r)) r = 'https://github.com/' + r;
    return r;
  }
  return pj.homepage || '';
}

function licenseOf(pj) {
  if (typeof pj.license === 'string') return pj.license;
  if (pj.license && pj.license.type) return pj.license.type;
  if (Array.isArray(pj.licenses)) return pj.licenses.map((l) => l.type || l).join(' OR ');
  return '';
}

const pkgs = [];
for (const d of dirs) {
  const dir = path.join(web, d);
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const o = OVERRIDES[pj.name] || {};
  const declared = licenseOf(pj);
  const names = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort();
  const licFiles = o.files || names.filter((f) => LICENSE_FILE.test(f));
  const noticeFiles = names.filter((f) => NOTICE_FILE.test(f));
  pkgs.push({
    name: pj.name, version: pj.version, declared, license: o.license || declared, url: repoUrl(pj), note: o.note || '',
    texts: [...licFiles, ...noticeFiles].map((f) => ({ file: f, text: read(path.join(dir, f)) })),
  });
}
pkgs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1));
const missing = pkgs.filter((p) => !p.license);
if (missing.length) throw new Error('No licence known for: ' + missing.map((p) => p.name).join(', ') + ' (add an entry to OVERRIDES)');

// ---- 2. KaTeX fonts: copyright and licence from the font files' own name tables ----
// build.mjs copies the .woff2 files; katex ships the same fonts as .ttf, whose name table is uncompressed.
function nameTable(file) {
  const b = fs.readFileSync(file);
  const out = {};
  for (let i = 0; i < b.readUInt16BE(4); i++) {
    const o = 12 + i * 16;
    if (b.toString('latin1', o, o + 4) !== 'name') continue;
    const off = b.readUInt32BE(o + 8); const strings = off + b.readUInt16BE(off + 4);
    for (let j = 0; j < b.readUInt16BE(off + 2); j++) {
      const r = off + 6 + j * 12;
      const platform = b.readUInt16BE(r); const id = b.readUInt16BE(r + 6);
      if (platform !== 3 || out[id] !== undefined) continue; // Windows platform, UTF-16BE
      const raw = b.subarray(strings + b.readUInt16BE(r + 10), strings + b.readUInt16BE(r + 10) + b.readUInt16BE(r + 8));
      let s = ''; for (let k = 0; k + 1 < raw.length; k += 2) s += String.fromCharCode(raw.readUInt16BE(k));
      out[id] = s.replace(/\r\n?/g, '\n');
    }
  }
  return out;
}
const fontDir = path.join(nm, 'katex/dist/fonts');
const woff2 = fs.readdirSync(fontDir).filter((f) => f.endsWith('.woff2')).sort();
const copyrights = new Set(); const reserved = new Set();
for (const f of woff2) {
  const ttf = path.join(fontDir, f.replace(/\.woff2$/, '.ttf'));
  if (!fs.existsSync(ttf)) throw new Error('No .ttf next to ' + f + ' to read its licence from');
  const n = nameTable(ttf);
  if (!/SIL Open Font License, Version 1\.1/.test(n[13] || '')) throw new Error(f + ': font licence is not OFL 1.1 any more, review THIRD-PARTY-NOTICES by hand');
  copyrights.add(n[0]);
  const rfn = /Reserved Font Name ([^.\n]+)/.exec(n[13]); if (rfn) reserved.add(rfn[1].trim());
}
const katexVersion = JSON.parse(fs.readFileSync(path.join(nm, 'katex/package.json'), 'utf8')).version;

// ---- 3. Write ----
const fence = (t) => { let f = '```'; while (t.includes(f)) f += '`'; return f + 'text\n' + t + '\n' + f; };
const L = [];
L.push('# Third-party notices', '');
L.push('Emdedown.exe contains the third-party components listed below. Their licence comments are removed from the minified', 'bundle, so their notices are reproduced here. This file is generated by `tools/make-notices.mjs`; do not edit it by hand.', '');
L.push('The same text is built into Emdedown.exe and shown under **About → Third-party licenses**.', '');
L.push('## Contents', '');
L.push('- [JavaScript packages](#javascript-packages) (' + pkgs.length + ' npm packages bundled into the web UI)');
L.push('- [KaTeX fonts](#katex-fonts)');
L.push('- [highlight.js](#highlightjs)');
L.push('- [Microsoft.Web.WebView2 SDK](#microsoftwebwebview2-sdk)');
L.push('- [Microsoft Edge WebView2 Runtime](#microsoft-edge-webview2-runtime)', '');
L.push('## JavaScript packages', '');
L.push('Only packages that are actually part of the bundle are listed (determined from the esbuild metafile).', '');
L.push('| Package | Version | Licence |', '| --- | --- | --- |');
for (const p of pkgs) L.push(`| ${p.name} | ${p.version} | ${p.license}${p.license !== p.declared ? ' (declared: ' + (p.declared || 'none') + ')' : ''} |`);
L.push('');
for (const p of pkgs) {
  L.push(`### ${p.name} ${p.version}`, '');
  L.push(`- Licence: ${p.license}`);
  if (p.url) L.push(`- Source: ${p.url}`);
  if (p.note) L.push(`- Note: ${p.note}`);
  L.push('');
  if (!p.texts.length) L.push(`No licence file is included in the npm package. Licence: ${p.license} (SPDX), see https://spdx.org/licenses/${p.license}.html`, '');
  for (const t of p.texts) L.push(`${t.file}:`, '', fence(t.text), '');
}
L.push('## KaTeX fonts', '');
L.push(`Emdedown embeds the ${woff2.length} KaTeX fonts (.woff2, unmodified) from the katex ${katexVersion} npm package. The KaTeX`,
  'code is MIT-licensed (see katex above), but the fonts are licensed separately under the SIL Open Font License,',
  'Version 1.1, as stated in the fonts\' own metadata (name table, read from the .ttf copies katex ships alongside):', '');
L.push(fence([...copyrights].sort().join('\n')), '');
L.push('Reserved Font Names: ' + [...reserved].sort().join(', ') + '.', '');
L.push('Source: https://github.com/KaTeX/katex-fonts', '');
L.push(fence(read(path.join(root, 'tools/notices/OFL-1.1.txt'))), '');
L.push('## highlight.js', '');
const hl = pkgs.find((p) => p.name === 'highlight.js');
L.push(`highlight.js ${hl.version} (${hl.license}) is bundled as \`highlight.js/lib/common\` (the core and its common languages).`,
  'Only its JavaScript is bundled; none of the package\'s theme stylesheets are. Its full licence text is in the',
  'JavaScript packages section above.', '');
L.push('## Microsoft.Web.WebView2 SDK', '');
L.push(`Emdedown.exe embeds Microsoft.Web.WebView2.Core.dll, Microsoft.Web.WebView2.WinForms.dll and WebView2Loader.dll`,
  `(x64, x86, arm64) from the Microsoft.Web.WebView2 NuGet package ${WV_VERSION}, unmodified.`, '');
L.push('- Source: https://www.nuget.org/packages/Microsoft.Web.WebView2/' + WV_VERSION, '');
L.push('LICENSE.txt:', '', fence(read(path.join(wvPkg, 'LICENSE.txt'))), '');
L.push('NOTICE.txt (shipped with the package):', '', fence(read(path.join(wvPkg, 'NOTICE.txt'))), '');
L.push('## Microsoft Edge WebView2 Runtime', '');
L.push('Emdedown renders with the Microsoft Edge WebView2 Runtime that is part of Windows (or installed separately by the', 'user). The runtime is not included in or redistributed with Emdedown.', '');

fs.writeFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), L.join('\n'));
console.log(`THIRD-PARTY-NOTICES.md: ${pkgs.length} packages, ${woff2.length} fonts`);
