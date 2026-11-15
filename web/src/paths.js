// Small Windows-friendly path helpers (the host always gives us absolute Windows paths).

export function dirname(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i <= 0 ? p : p.slice(0, i);
}

export function basename(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i < 0 ? p : p.slice(i + 1);
}

export function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function isAbsolute(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/** Resolve a relative (URL-style) reference against a base directory. */
export function resolve(baseDir, rel) {
  let r = rel;
  try { r = decodeURIComponent(rel); } catch { /* keep raw */ }
  r = r.replace(/\//g, '\\');
  if (r.startsWith('file:\\\\\\')) r = r.slice(8);
  if (isAbsolute(r)) return normalize(r);
  return normalize(baseDir.replace(/[\\/]+$/, '') + '\\' + r);
}

export function normalize(p) {
  const unc = p.startsWith('\\\\');
  const parts = p.replace(/\//g, '\\').split('\\');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (out.length > 1) out.pop(); continue; }
    out.push(part);
  }
  return (unc ? '\\\\' : '') + out.join('\\');
}

/** Path of `target` relative to directory `fromDir`, with forward slashes (for markdown links). */
export function relative(fromDir, target) {
  const a = normalize(fromDir).toLowerCase().split('\\');
  const bOrig = normalize(target).split('\\');
  const b = bOrig.map((s) => s.toLowerCase());
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === 0) return target.replace(/\\/g, '/');
  const ups = a.slice(i).map(() => '..');
  return ups.concat(bOrig.slice(i)).join('/');
}

// \\server\share root of a UNC path (lower-cased), or null for a local path.
function uncRoot(p) {
  const m = /^\\\\([^\\]+)\\([^\\]+)/.exec(p);
  return m ? (m[1] + '\\' + m[2]).toLowerCase() : null;
}

/**
 * True when a document reference points at a network location the document's own folder is not on:
 * a UNC or protocol-relative path ("//server/share", "\\\\server\\share", "file://server/share", or
 * anything that resolves to a path starting with two backslashes), unless the base directory is
 * itself a UNC path with the same \\server\share root. Relative paths under a UNC base stay allowed.
 */
export function isBlockedRemote(baseDir, ref) {
  if (!ref) return false;
  let r = String(ref);
  try { r = decodeURIComponent(r); } catch { /* keep raw */ }
  r = r.trim().replace(/\//g, '\\');
  let target;
  if (/^file:\\\\(?!\\)/i.test(r)) target = normalize('\\\\' + r.slice(7)); // file://server/share
  else if (r.startsWith('\\\\')) target = normalize(r); // //server/share, \\server\share, \\?\..., \\.\...
  else target = resolve(baseDir || '', ref); // relative: may still climb out of a UNC share
  if (!target.startsWith('\\\\')) return false;
  const root = uncRoot(target);
  const baseRoot = uncRoot(normalize(baseDir || ''));
  return !(root && baseRoot && root === baseRoot);
}

// Same Markdown extensions the host recognises, plus plain text.
export const MD_EXT = /\.(md|markdown|mdown|mkd|mkdn|mdx|mdwn|txt)$/i;
