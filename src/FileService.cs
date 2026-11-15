using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Emdedown
{
    static class FileService
    {
        public static readonly string[] MarkdownExts = { ".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdx", ".mdwn" };
        static readonly HashSet<string> SkipDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "node_modules", "bower_components", "$RECYCLE.BIN", "System Volume Information", "__pycache__", "venv", ".venv" };
        const int MaxFiles = 5000;

        public static bool IsMarkdown(string path)
        {
            string ext = Path.GetExtension(path);
            return MarkdownExts.Any(e => string.Equals(e, ext, StringComparison.OrdinalIgnoreCase));
        }

        // ---------- path policy ----------
        // Only plain drive-letter paths are allowed by default: UNC (\\server\share), \\?\ and \\.\ paths
        // would make Windows contact (and authenticate to) another machine. Callers may allow UNC paths
        // that lie under roots the user chose themselves (see MainForm.IsAllowedPath).
        static readonly Regex LocalDrive = new Regex(@"^[A-Za-z]:\\", RegexOptions.CultureInvariant);
        public const string NetworkBlocked = "Network paths are blocked for links in documents";

        public static bool IsLocalDrivePath(string path)
        {
            return !string.IsNullOrEmpty(path) && LocalDrive.IsMatch(path.Replace('/', '\\'));
        }

        /// <summary>UNC path normalized as a string only (no file system access), or null if it is not a plain UNC path
        /// or contains "." / ".." segments. Device paths (\\?\, \\.\) return null.</summary>
        public static string NormalizeUnc(string path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            string p = path.Replace('/', '\\');
            if (!p.StartsWith(@"\\") || p.StartsWith(@"\\?\") || p.StartsWith(@"\\.\")) return null;
            var parts = p.Substring(2).Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2) return null;
            foreach (var s in parts) if (s == "." || s == ".." || s.Trim().Length == 0) return null;
            return @"\\" + string.Join(@"\", parts);
        }

        /// <summary>True when the (normalized) path equals root or lies below it.</summary>
        public static bool IsUnder(string path, string root)
        {
            if (path == null || root == null) return false;
            if (string.Equals(path, root, StringComparison.OrdinalIgnoreCase)) return true;
            string r = root.EndsWith(@"\") ? root : root + @"\";
            return path.StartsWith(r, StringComparison.OrdinalIgnoreCase);
        }

        public class TextFile { public string Text; public string Eol; public string Enc; public long MTime; }

        public static TextFile Read(string path)
        {
            var fi = new FileInfo(path);
            if (!fi.Exists) throw new FileNotFoundException("File not found: " + path);
            if (fi.Length > 64L * 1024 * 1024) throw new IOException("File is too large to open (over 64 MB).");
            long mtime = fi.LastWriteTimeUtc.Ticks; // taken before reading: a change in between shows up as a (safe) conflict
            byte[] bytes = null;
            for (int i = 0; ; i++)
            {
                try { bytes = File.ReadAllBytes(path); break; }
                catch (IOException) { if (i >= 5) throw; System.Threading.Thread.Sleep(60); }
            }
            string enc;
            string text = Decode(bytes, out enc);
            var r = new TextFile();
            r.Eol = text.Contains("\r\n") ? "CRLF" : "LF";
            r.Text = text.Replace("\r\n", "\n").Replace("\r", "\n");
            r.Enc = enc;
            r.MTime = mtime;
            return r;
        }

        public static long MTimeOf(string path)
        {
            return new FileInfo(path).LastWriteTimeUtc.Ticks;
        }

        static string Decode(byte[] b)
        {
            string enc;
            return Decode(b, out enc);
        }

        static string Decode(byte[] b, out string enc)
        {
            if (b.Length >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF) { enc = "utf8bom"; return Encoding.UTF8.GetString(b, 3, b.Length - 3); }
            if (b.Length >= 2 && b[0] == 0xFF && b[1] == 0xFE) { enc = "utf16le"; return Encoding.Unicode.GetString(b, 2, b.Length - 2); }
            if (b.Length >= 2 && b[0] == 0xFE && b[1] == 0xFF) { enc = "utf16be"; return Encoding.BigEndianUnicode.GetString(b, 2, b.Length - 2); }
            try { enc = "utf8"; return new UTF8Encoding(false, true).GetString(b); }
            catch (DecoderFallbackException) { enc = "ansi"; return Encoding.Default.GetString(b); }
        }

        /// <summary>Encodes text as enc ("utf8", "utf8bom", "utf16le", "utf16be", "ansi"), including its BOM.
        /// If the text cannot be represented in the ANSI code page, falls back to "utf8" (enc is updated) instead of losing characters.</summary>
        public static byte[] Encode(string text, ref string enc)
        {
            byte[] body, bom;
            switch (enc)
            {
                case "utf8bom": bom = new byte[] { 0xEF, 0xBB, 0xBF }; body = new UTF8Encoding(false).GetBytes(text); break;
                case "utf16le": bom = new byte[] { 0xFF, 0xFE }; body = new UnicodeEncoding(false, false).GetBytes(text); break;
                case "utf16be": bom = new byte[] { 0xFE, 0xFF }; body = new UnicodeEncoding(true, false).GetBytes(text); break;
                case "ansi":
                    try
                    {
                        var strict = Encoding.GetEncoding(Encoding.Default.CodePage, EncoderFallback.ExceptionFallback, DecoderFallback.ReplacementFallback);
                        bom = new byte[0]; body = strict.GetBytes(text);
                    }
                    catch (EncoderFallbackException)
                    {
                        enc = "utf8"; bom = new byte[0]; body = new UTF8Encoding(false).GetBytes(text);
                    }
                    break;
                default: enc = "utf8"; bom = new byte[0]; body = new UTF8Encoding(false).GetBytes(text); break;
            }
            if (bom.Length == 0) return body;
            var all = new byte[bom.Length + body.Length];
            Buffer.BlockCopy(bom, 0, all, 0, bom.Length);
            Buffer.BlockCopy(body, 0, all, bom.Length, body.Length);
            return all;
        }

        public static long Write(string path, string text, string eol, ref string enc)
        {
            if (eol == "CRLF") text = text.Replace("\r\n", "\n").Replace("\n", "\r\n");
            var bytes = Encode(text, ref enc);
            WriteBytesAtomic(path, bytes);
            return MTimeOf(path);
        }

        public static void WriteBytesAtomic(string path, byte[] bytes)
        {
            string dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            string stem = Path.Combine(dir ?? ".", "." + Path.GetFileName(path) + "." + Guid.NewGuid().ToString("N").Substring(0, 8));
            string tmp = stem + ".tmp";
            // The original is never opened for writing: every failure leaves it as it was and is reported to the caller.
            // (No in-place "last resort" write: on a full disk that would truncate the document and then fail.)
            try
            {
                File.WriteAllBytes(tmp, bytes);
                if (!File.Exists(path)) { File.Move(tmp, path); return; }
                try { File.Replace(tmp, path, null, true); return; }
                catch (IOException)
                {
                    // A half-finished Replace can leave the destination missing: put the new file there rather than lose both.
                    if (!File.Exists(path)) { if (File.Exists(tmp)) { File.Move(tmp, path); return; } throw; }
                    if (!File.Exists(tmp)) throw;
                }
                catch (PlatformNotSupportedException) { }
                // File.Replace is unsupported on some file systems (FAT, some network shares). Swap by renaming instead:
                // the original is moved aside, the new file moved in, and the original restored if that fails.
                string bak = stem + ".bak";
                File.Move(path, bak);
                try { File.Move(tmp, path); }
                catch
                {
                    try { if (!File.Exists(path)) File.Move(bak, path); } catch { }
                    throw;
                }
                try { File.Delete(bak); } catch { }
            }
            finally
            {
                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
            }
        }

        // ---------- folder listing ----------
        const int MaxDirs = 20000;
        const int WalkBudgetMs = 3000;

        /// <summary>Limits for a folder walk: Markdown files found, directories visited, time spent, cancellation.</summary>
        class Walk
        {
            public int Files, Dirs;
            public bool Truncated;
            public readonly Stopwatch Clock = Stopwatch.StartNew();
            public CancellationToken Token;
            /// <summary>Call once per directory about to be visited; false = stop walking.</summary>
            public bool EnterDir()
            {
                Token.ThrowIfCancellationRequested();
                if (Files >= MaxFiles || Dirs >= MaxDirs || Clock.ElapsedMilliseconds > WalkBudgetMs) { Truncated = true; return false; }
                Dirs++;
                return true;
            }
        }

        /// <summary>True if a path relative to a watched folder lies in (or is) a folder that listings skip.</summary>
        public static bool IsSkippedRelative(string rel)
        {
            if (string.IsNullOrEmpty(rel)) return false;
            foreach (var s in rel.Split(new[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries))
                if (s.StartsWith(".") || SkipDirs.Contains(s)) return true;
            return false;
        }

        public static Dictionary<string, object> ListFolder(string dir)
        {
            if (!Directory.Exists(dir)) throw new DirectoryNotFoundException("Folder not found: " + dir);
            var w = new Walk();
            var root = ListDir(new DirectoryInfo(dir), 0, w);
            if (root == null) root = Node(new DirectoryInfo(dir), new List<object>());
            root["name"] = new DirectoryInfo(dir).Name;
            root["truncated"] = w.Truncated;
            return root;
        }

        static Dictionary<string, object> Node(DirectoryInfo d, List<object> children)
        {
            var n = new Dictionary<string, object>();
            n["name"] = d.Name; n["path"] = d.FullName; n["dir"] = true; n["children"] = children;
            return n;
        }

        static Dictionary<string, object> ListDir(DirectoryInfo d, int depth, Walk w)
        {
            var children = new List<object>();
            if (depth > 12) return null;
            if (!w.EnterDir()) return null;
            DirectoryInfo[] subdirs;
            FileInfo[] files;
            try { subdirs = d.GetDirectories(); files = d.GetFiles(); }
            catch { return null; }
            foreach (var s in subdirs.OrderBy(x => x.Name, NaturalComparer.Instance))
            {
                if (w.Files >= MaxFiles) { w.Truncated = true; break; }
                if (s.Name.StartsWith(".") || SkipDirs.Contains(s.Name)) continue;
                if ((s.Attributes & (FileAttributes.Hidden | FileAttributes.System)) != 0) continue;
                if ((s.Attributes & FileAttributes.ReparsePoint) != 0) continue;
                var sub = ListDir(s, depth + 1, w);
                if (sub != null && ((List<object>)sub["children"]).Count > 0) children.Add(sub);
            }
            foreach (var f in files.OrderBy(x => x.Name, NaturalComparer.Instance))
            {
                if (w.Files >= MaxFiles) { w.Truncated = true; break; }
                if (!IsMarkdown(f.Name)) continue;
                var n = new Dictionary<string, object>();
                n["name"] = f.Name; n["path"] = f.FullName; n["dir"] = false;
                children.Add(n);
                w.Files++;
            }
            return Node(d, children);
        }

        static List<string> AllMarkdown(string dir, Walk w)
        {
            var list = new List<string>();
            var stack = new Stack<KeyValuePair<string, int>>();
            stack.Push(new KeyValuePair<string, int>(dir, 0));
            while (stack.Count > 0)
            {
                if (list.Count >= MaxFiles) { w.Truncated = true; break; }
                var cur = stack.Pop();
                if (!w.EnterDir()) break;
                try
                {
                    foreach (var f in Directory.EnumerateFiles(cur.Key)) { if (IsMarkdown(f)) { list.Add(f); w.Files++; } if (list.Count >= MaxFiles) { w.Truncated = true; break; } }
                    if (cur.Value < 12)
                        foreach (var s in Directory.EnumerateDirectories(cur.Key))
                        {
                            string name = Path.GetFileName(s);
                            if (name.StartsWith(".") || SkipDirs.Contains(name)) continue;
                            var attr = File.GetAttributes(s);
                            if ((attr & (FileAttributes.Hidden | FileAttributes.System | FileAttributes.ReparsePoint)) != 0) continue;
                            stack.Push(new KeyValuePair<string, int>(s, cur.Value + 1));
                        }
                }
                catch { }
            }
            return list;
        }

        // ---------- full-text search ----------
        /// <summary>Full-text search. Throws OperationCanceledException when ct is cancelled.</summary>
        public static Dictionary<string, object> Search(string dir, string query, bool matchCase, CancellationToken ct)
        {
            if (string.IsNullOrEmpty(query)) throw new ArgumentException("Empty search");
            var sw = Stopwatch.StartNew();
            var cmp = matchCase ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
            var walk = new Walk { Token = ct };
            var files = AllMarkdown(dir, walk);
            var results = new System.Collections.Concurrent.ConcurrentBag<Dictionary<string, object>>();
            int total = 0;
            Parallel.ForEach(files, new ParallelOptions { MaxDegreeOfParallelism = Math.Max(2, Environment.ProcessorCount), CancellationToken = ct }, (path, loop) =>
            {
                if (ct.IsCancellationRequested) { loop.Stop(); return; }
                string text;
                try
                {
                    var fi = new FileInfo(path);
                    if (fi.Length > 16 * 1024 * 1024) return;
                    text = Decode(File.ReadAllBytes(path));
                }
                catch { return; }
                string name = Path.GetFileName(path);
                bool nameHit = name.IndexOf(query, cmp) >= 0;
                int count = 0;
                var matches = new List<object>();
                int lineNo = 0, start = 0;
                while (start <= text.Length)
                {
                    int end = text.IndexOf('\n', start);
                    if (end < 0) end = text.Length;
                    int idx = text.IndexOf(query, start, end - start, cmp);
                    if (idx >= 0)
                    {
                        string line = text.Substring(start, end - start).TrimEnd('\r');
                        int p = line.IndexOf(query, cmp);
                        while (p >= 0) { count++; p = line.IndexOf(query, p + query.Length, cmp); }
                        if (matches.Count < 8)
                        {
                            int col = idx - start;
                            int from = Math.Max(0, col - 40);
                            string snippet = (from > 0 ? "…" : "") + line.Substring(from, Math.Min(line.Length - from, 160)).Trim();
                            var m = new Dictionary<string, object>();
                            m["line"] = lineNo; m["text"] = snippet; m["col"] = col;
                            matches.Add(m);
                        }
                    }
                    lineNo++;
                    start = end + 1;
                }
                if (count == 0 && !nameHit) return;
                System.Threading.Interlocked.Add(ref total, count);
                var r = new Dictionary<string, object>();
                r["path"] = path; r["name"] = name; r["count"] = count; r["matches"] = matches;
                r["score"] = count + (nameHit ? 50 : 0);
                results.Add(r);
            });
            ct.ThrowIfCancellationRequested();
            var sorted = results.OrderByDescending(r => (int)r["score"]).ThenBy(r => (string)r["name"], StringComparer.OrdinalIgnoreCase).ToList();
            var res = new Dictionary<string, object>();
            res["truncated"] = sorted.Count > 150 || walk.Truncated;
            res["results"] = sorted.Take(150).ToList();
            res["total"] = total;
            res["ms"] = sw.ElapsedMilliseconds;
            return res;
        }

        // ---------- pasted images ----------
        public static string SaveImage(string docPath, string name, string base64)
        {
            string docDir = Path.GetDirectoryName(docPath);
            string imgDir = Path.Combine(docDir, "images");
            Directory.CreateDirectory(imgDir);
            string ext = Path.GetExtension(name);
            if (string.IsNullOrEmpty(ext)) ext = ".png";
            string stem = Path.GetFileNameWithoutExtension(name);
            stem = Regex.Replace(stem, @"[^\w\-. ]+", "").Trim();
            if (stem.Length == 0 || stem.Equals("image", StringComparison.OrdinalIgnoreCase))
                stem = Path.GetFileNameWithoutExtension(docPath) + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss");
            stem = stem.Replace(' ', '-');
            string file = Path.Combine(imgDir, stem + ext);
            int i = 1;
            while (File.Exists(file)) file = Path.Combine(imgDir, stem + "-" + (i++) + ext);
            File.WriteAllBytes(file, Convert.FromBase64String(base64));
            return "images/" + Path.GetFileName(file);
        }

        // ---------- DOCX (Word) export via an embedded MHTML "altChunk" ----------
        public static void WriteDocx(string path, string html)
        {
            var parts = new List<KeyValuePair<string, KeyValuePair<string, byte[]>>>();
            int n = 0;
            html = Regex.Replace(html, "src=\"data:(image/[a-zA-Z0-9.+-]+);base64,([^\"]+)\"", m =>
            {
                string mime = m.Groups[1].Value;
                string ext = mime.Contains("png") ? "png" : mime.Contains("jpeg") || mime.Contains("jpg") ? "jpg" : mime.Contains("gif") ? "gif" : mime.Contains("svg") ? "svg" : mime.Contains("webp") ? "webp" : "bin";
                string loc = "file:///C:/emdedown/image" + (++n).ToString("000") + "." + ext;
                byte[] data;
                try { data = Convert.FromBase64String(m.Groups[2].Value); } catch { return m.Value; }
                parts.Add(new KeyValuePair<string, KeyValuePair<string, byte[]>>(loc, new KeyValuePair<string, byte[]>(mime, data)));
                return "src=\"" + loc + "\"";
            });

            var mht = new StringBuilder();
            const string boundary = "----=_NextPart_Emdedown_7F3A";
            mht.Append("MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=\"" + boundary + "\"; type=\"text/html\"\r\n\r\n");
            mht.Append("--" + boundary + "\r\nContent-Type: text/html; charset=\"utf-8\"\r\nContent-Transfer-Encoding: quoted-printable\r\nContent-Location: file:///C:/emdedown/document.html\r\n\r\n");
            mht.Append(QuotedPrintable(Encoding.UTF8.GetBytes(html)));
            mht.Append("\r\n");
            foreach (var p in parts)
            {
                mht.Append("\r\n--" + boundary + "\r\nContent-Location: " + p.Key + "\r\nContent-Transfer-Encoding: base64\r\nContent-Type: " + p.Value.Key + "\r\n\r\n");
                mht.Append(Convert.ToBase64String(p.Value.Value, Base64FormattingOptions.InsertLineBreaks));
                mht.Append("\r\n");
            }
            mht.Append("\r\n--" + boundary + "--\r\n");

            bool metric = true;
            try { metric = System.Globalization.RegionInfo.CurrentRegion.IsMetric; } catch { }
            string pg = metric ? "<w:pgSz w:w=\"11906\" w:h=\"16838\"/>" : "<w:pgSz w:w=\"12240\" w:h=\"15840\"/>";

            using (var ms = new MemoryStream())
            {
                using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, true))
                {
                    Add(zip, "[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Default Extension=\"mht\" ContentType=\"message/rfc822\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>");
                    Add(zip, "_rels/.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>");
                    Add(zip, "word/_rels/document.xml.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"chunk1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk\" Target=\"afchunk.mht\"/></Relationships>");
                    Add(zip, "word/document.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><w:body><w:altChunk r:id=\"chunk1\"/><w:sectPr>" + pg + "<w:pgMar w:top=\"1134\" w:right=\"1134\" w:bottom=\"1134\" w:left=\"1134\" w:header=\"709\" w:footer=\"709\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>");
                    Add(zip, "word/afchunk.mht", mht.ToString());
                }
                WriteBytesAtomic(path, ms.ToArray());
            }
        }

        static void Add(ZipArchive zip, string name, string content)
        {
            var e = zip.CreateEntry(name, CompressionLevel.Optimal);
            using (var s = e.Open())
            {
                var b = new UTF8Encoding(false).GetBytes(content);
                s.Write(b, 0, b.Length);
            }
        }

        static string QuotedPrintable(byte[] data)
        {
            var sb = new StringBuilder(data.Length * 11 / 10);
            int lineLen = 0;
            for (int i = 0; i < data.Length; i++)
            {
                byte b = data[i];
                string token;
                if (b == '\r') continue;
                if (b == '\n') { sb.Append("\r\n"); lineLen = 0; continue; }
                if ((b >= 33 && b <= 126 && b != '=') || (b == ' ' && i + 1 < data.Length && data[i + 1] != '\n' && data[i + 1] != '\r')) token = ((char)b).ToString();
                else token = "=" + b.ToString("X2");
                if (lineLen + token.Length > 75) { sb.Append("=\r\n"); lineLen = 0; }
                sb.Append(token);
                lineLen += token.Length;
            }
            return sb.ToString();
        }

        // ---------- shell helpers ----------
        // Only passive formats are launched with their default app. Anything that can run code or carry
        // active content (scripts, source files whose default handler may be an interpreter, HTML/XML/SVG,
        // archives, legacy macro-enabled Office formats) is revealed in Explorer instead.
        static readonly HashSet<string> SafeOpenExts = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tif", ".tiff",
            ".pdf", ".txt", ".csv", ".log", ".json", ".yaml", ".yml", ".toml", ".ini",
            ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".rtf",
            ".mp3", ".wav", ".mp4", ".mov", ".mkv", ".webm", ".avi" };

        /// <summary>Opens a path linked from a document. allowed decides whether a non-local (UNC) path may be touched.</summary>
        public static void OpenPath(string path, Func<string, bool> allowed)
        {
            if (string.IsNullOrEmpty(path)) throw new ArgumentException("No path given");
            if (!allowed(path)) throw new UnauthorizedAccessException(NetworkBlocked);
            if (Directory.Exists(path)) { Process.Start("explorer.exe", "\"" + path + "\""); return; }
            if (!File.Exists(path)) throw new FileNotFoundException("Linked file not found: " + Path.GetFileName(path));
            // Never launch programs/scripts from a document link: show them in Explorer instead.
            if (SafeOpenExts.Contains(Path.GetExtension(path))) Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            else Reveal(path);
        }

        public static void Reveal(string path)
        {
            Process.Start("explorer.exe", "/select,\"" + path + "\"");
        }
    }

    class NaturalComparer : IComparer<string>
    {
        public static readonly NaturalComparer Instance = new NaturalComparer();
        [System.Runtime.InteropServices.DllImport("shlwapi.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        static extern int StrCmpLogicalW(string a, string b);
        public int Compare(string a, string b) { return StrCmpLogicalW(a, b); }
    }
}
