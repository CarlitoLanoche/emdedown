using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.IO.Pipes;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Emdedown
{
    class MainForm : Form
    {
        readonly WebView2 web;
        readonly List<string> startupFiles;
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 256 };
        readonly Dictionary<string, byte[]> resCache = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
        CoreWebView2Environment env;
        bool allowClose, ready;
        string SettingsPath { get { return Path.Combine(Program.DataDir, "settings.json"); } }
        string WindowPath { get { return Path.Combine(Program.DataDir, "window.txt"); } }
        string ThemesDir { get { return Path.Combine(Program.DataDir, "themes"); } }

        // fullscreen bookkeeping
        bool fullscreen;
        FormWindowState preFsState;
        Rectangle preFsBounds;
        FormWindowState lastNonMinState = FormWindowState.Normal;

        // "openFiles" deliveries that arrive before the page has called "ready"
        readonly List<Dictionary<string, object>> pendingOpen = new List<Dictionary<string, object>>();
        // set once the window handle exists, so the pipe thread can BeginInvoke safely
        readonly ManualResetEvent handleReady = new ManualResetEvent(false);

        // close watchdog: the page must answer "closeRequested" (by calling any host method) within a few seconds
        System.Windows.Forms.Timer closeTimer;
        bool closePending, closing;

        // true while the Markdown editor has keyboard focus (reported by the page); adds formatting items to the right-click menu
        bool editorFocused;

        // renderer crash bookkeeping
        readonly List<DateTime> reloadTimes = new List<DateTime>();
        bool rendererGaveUp;

        CancellationTokenSource searchCts;

        public MainForm(List<string> files)
        {
            startupFiles = files;
            foreach (var f in files) TrustUserPath(f);
            TrustFromSettings();
            Text = "Emdedown";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            MinimumSize = new Size(480, 360);
            KeyPreview = false;
            StartPosition = FormStartPosition.Manual;
            RestoreWindow();
            Color bg = ReadBackColor();
            BackColor = bg;

            web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = bg };
            Controls.Add(web);
            Load += async (s, e) => await InitWebView();
            FormClosing += OnClosing;
            StartPipeServer();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try { Native.SetDarkTitleBar(Handle, BackColor.GetBrightness() < 0.5f); } catch { }
            handleReady.Set();
        }

        // ---------------- path policy (UNC / network paths) ----------------
        // Plain drive-letter paths are always allowed. UNC paths are allowed only below folders the user picked
        // or opened themselves (startup files, pipe, drag and drop, dialogs, watched files, the saved session),
        // so a document cannot make Windows connect and authenticate to an arbitrary server.
        readonly HashSet<string> trustedRoots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        bool IsAllowedPath(string p)
        {
            if (string.IsNullOrEmpty(p)) return false;
            if (FileService.IsLocalDrivePath(p)) return true;
            string n = FileService.NormalizeUnc(p);
            if (n == null) return false;
            lock (trustedRoots)
            {
                foreach (var r in trustedRoots) if (FileService.IsUnder(n, r)) return true;
            }
            return false;
        }

        void RequireAllowed(string p)
        {
            if (!IsAllowedPath(p)) throw new UnauthorizedAccessException(FileService.NetworkBlocked);
        }

        /// <summary>Trusts a UNC folder (isDir) or the folder containing a UNC file. Local paths need no trust.</summary>
        void TrustPath(string p, bool isDir)
        {
            string n = FileService.NormalizeUnc(p);
            if (n == null) return;
            if (!isDir)
            {
                int cut = n.LastIndexOf('\\');
                // keep at least \\server\share
                if (cut <= 2 || n.IndexOf('\\', 2) >= cut) return;
                n = n.Substring(0, cut);
            }
            lock (trustedRoots) trustedRoots.Add(n);
        }

        /// <summary>A path the user handed us (command line, pipe, drop): trust it, and its folder if it is a file.</summary>
        void TrustUserPath(string p)
        {
            if (FileService.NormalizeUnc(p) == null) return; // local (or blocked device path): nothing to do, no I/O
            bool dir = false;
            try { dir = Directory.Exists(p); } catch { }
            TrustPath(p, true);
            if (!dir) TrustPath(p, false);
        }

        /// <summary>Recent files, the open folder and the restored session were all opened by the user in an earlier run.</summary>
        void TrustFromSettings()
        {
            try
            {
                if (!File.Exists(SettingsPath)) return;
                var d = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(SettingsPath, Encoding.UTF8));
                if (d == null) return;
                object v;
                if (d.TryGetValue("recent", out v) && v is IEnumerable && !(v is string))
                    foreach (var p in (IEnumerable)v) { var s = p as string; if (s != null) TrustPath(s, false); }
                if (d.TryGetValue("folder", out v) && v is string) TrustPath((string)v, true);
                var session = d.TryGetValue("session", out v) ? v as Dictionary<string, object> : null;
                if (session != null && session.TryGetValue("tabs", out v) && v is IEnumerable)
                    foreach (var t in (IEnumerable)v)
                    {
                        var td = t as Dictionary<string, object>;
                        object tp;
                        if (td != null && td.TryGetValue("path", out tp) && tp is string) TrustPath((string)tp, false);
                    }
            }
            catch { }
        }

        // ---------------- window state ----------------
        void RestoreWindow()
        {
            var wa = Screen.PrimaryScreen.WorkingArea;
            var b = new Rectangle(wa.X + wa.Width / 10, wa.Y + wa.Height / 12, Math.Min(1280, wa.Width * 8 / 10), Math.Min(900, wa.Height * 10 / 12));
            bool max = false;
            try
            {
                if (File.Exists(WindowPath))
                {
                    var p = File.ReadAllText(WindowPath).Split(',');
                    var r = new Rectangle(int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2]), int.Parse(p[3]));
                    max = p.Length > 4 && p[4] == "1";
                    if (Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(r)) && r.Width >= 400 && r.Height >= 300) b = r;
                }
            }
            catch { }
            Bounds = b;
            if (max) WindowState = FormWindowState.Maximized;
        }

        void SaveWindow()
        {
            try
            {
                var r = fullscreen ? preFsBounds : (WindowState == FormWindowState.Normal ? Bounds : RestoreBounds);
                bool max = fullscreen ? preFsState == FormWindowState.Maximized
                    : WindowState == FormWindowState.Maximized || (WindowState == FormWindowState.Minimized && lastNonMinState == FormWindowState.Maximized);
                string bg = ColorTranslator.ToHtml(BackColor);
                File.WriteAllText(WindowPath, r.X + "," + r.Y + "," + r.Width + "," + r.Height + "," + (max ? "1" : "0") + "," + bg);
            }
            catch { }
        }

        Color ReadBackColor()
        {
            try
            {
                if (File.Exists(WindowPath))
                {
                    var p = File.ReadAllText(WindowPath).Split(',');
                    if (p.Length > 5) return ColorTranslator.FromHtml(p[5]);
                }
            }
            catch { }
            return Color.White;
        }

        void SetFullscreen(bool on)
        {
            if (on == fullscreen) return;
            if (on)
            {
                preFsState = WindowState;
                preFsBounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                fullscreen = true;
                WindowState = FormWindowState.Normal;
                FormBorderStyle = FormBorderStyle.None;
                Bounds = Screen.FromControl(this).Bounds;
            }
            else
            {
                fullscreen = false;
                FormBorderStyle = FormBorderStyle.Sizable;
                Bounds = preFsBounds;
                WindowState = preFsState;
            }
            Post("fullscreenChanged", new Dictionary<string, object> { { "on", on } });
        }

        // ---------------- WebView2 setup ----------------
        async Task InitWebView()
        {
            try
            {
                // Documents don't need the GPU: software rendering is just as smooth here and saves ~100 MB.
                // Users can turn GPU rendering back on in Settings (takes effect after a restart).
                string args = "--disable-features=msSmartScreenProtection --disable-background-networking --disable-component-update";
                if (!ReadSettingBool("gpu")) args += " --disable-gpu --in-process-gpu";
                var opts = new CoreWebView2EnvironmentOptions(args);
                opts.AreBrowserExtensionsEnabled = false;
                env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.DataDir, "WebView2"), opts);
                await web.EnsureCoreWebView2Async(env);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Emdedown could not start its renderer (Microsoft Edge WebView2).\n\n" + ex.Message, "Emdedown", MessageBoxButtons.OK, MessageBoxIcon.Error);
                allowClose = true;
                Close();
                return;
            }
            var core = web.CoreWebView2;
            var st = core.Settings;
            st.AreDevToolsEnabled = Environment.GetEnvironmentVariable("EMDEDOWN_DEVTOOLS") == "1";
            st.AreDefaultContextMenusEnabled = true;
            st.IsZoomControlEnabled = false;
            st.IsStatusBarEnabled = false;
            st.AreBrowserAcceleratorKeysEnabled = false;
            st.IsGeneralAutofillEnabled = false;
            st.IsPasswordAutosaveEnabled = false;
            st.IsBuiltInErrorPageEnabled = false;
            try { st.IsSwipeNavigationEnabled = false; } catch { }

            core.AddWebResourceRequestedFilter("https://app.emdedown/*", CoreWebView2WebResourceContext.All);
            core.AddWebResourceRequestedFilter("https://file.emdedown/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += OnResource;
            core.WebMessageReceived += OnMessage;
            core.ContextMenuRequested += OnContextMenu;
            core.NavigationStarting += (s, e) =>
            {
                if (e.Uri.StartsWith("https://app.emdedown/", StringComparison.OrdinalIgnoreCase)) return;
                e.Cancel = true;
                OpenExternalUrl(e.Uri);
            };
            core.NewWindowRequested += (s, e) => { e.Handled = true; OpenExternalUrl(e.Uri); };
            core.ContainsFullScreenElementChanged += (s, e) => SetFullscreen(core.ContainsFullScreenElement);
            core.ProcessFailed += (s, e) =>
            {
                var kind = e.ProcessFailedKind;
                if (kind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
                    BeginInvoke(new Action(OnBrowserProcessExited));
                else if (kind == CoreWebView2ProcessFailedKind.RenderProcessExited)
                    BeginInvoke(new Action(OnRenderProcessExited));
            };
            core.Navigate("https://app.emdedown/index.html");
        }

        void OnRenderProcessExited()
        {
            if (allowClose || closing || IsDisposed) return;
            ready = false; // the reloaded page calls "ready" again; until then openFiles deliveries are queued
            CancelCloseWatchdog();
            if (rendererGaveUp) return;
            var now = DateTime.UtcNow;
            reloadTimes.RemoveAll(t => (now - t).TotalSeconds > 60);
            if (reloadTimes.Count >= 3)
            {
                rendererGaveUp = true;
                MessageBox.Show(this, "The Emdedown window keeps crashing, so it will not be reloaded again.\n\nPlease close Emdedown and open it again. Unsaved changes may be lost.",
                    "Emdedown", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            reloadTimes.Add(now);
            try { web.Reload(); } catch { }
        }

        void OnBrowserProcessExited()
        {
            if (allowClose || closing || IsDisposed) return;
            ready = false;
            CancelCloseWatchdog();
            allowClose = true;
            MessageBox.Show(this, "The renderer used by Emdedown (Microsoft Edge WebView2) stopped unexpectedly, so Emdedown has to close.\n\nUnsaved changes may be lost.",
                "Emdedown", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }

        bool ReadSettingBool(string key)
        {
            try
            {
                if (!File.Exists(SettingsPath)) return false;
                var d = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(SettingsPath, Encoding.UTF8));
                object v;
                return d != null && d.TryGetValue(key, out v) && v is bool && (bool)v;
            }
            catch { return false; }
        }

        // Free memory while minimized; back to normal when restored.
        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (WindowState != FormWindowState.Minimized && !fullscreen) lastNonMinState = WindowState;
            try
            {
                if (web == null || web.CoreWebView2 == null) return;
                var level = WindowState == FormWindowState.Minimized ? CoreWebView2MemoryUsageTargetLevel.Low : CoreWebView2MemoryUsageTargetLevel.Normal;
                if (web.CoreWebView2.MemoryUsageTargetLevel != level) web.CoreWebView2.MemoryUsageTargetLevel = level;
            }
            catch { }
        }

        static void OpenExternalUrl(string uri)
        {
            if (uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase))
            {
                if (uri.StartsWith("https://app.emdedown", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("https://file.emdedown", StringComparison.OrdinalIgnoreCase)) return;
                try { System.Diagnostics.Process.Start(uri); } catch { }
            }
        }

        static readonly Dictionary<string, string> Mime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { ".html", "text/html; charset=utf-8" }, { ".htm", "text/html; charset=utf-8" }, { ".js", "text/javascript; charset=utf-8" }, { ".mjs", "text/javascript; charset=utf-8" },
            { ".css", "text/css; charset=utf-8" }, { ".json", "application/json" }, { ".svg", "image/svg+xml" }, { ".png", "image/png" },
            { ".jpg", "image/jpeg" }, { ".jpeg", "image/jpeg" }, { ".gif", "image/gif" }, { ".webp", "image/webp" }, { ".bmp", "image/bmp" },
            { ".ico", "image/x-icon" }, { ".avif", "image/avif" }, { ".woff2", "font/woff2" }, { ".woff", "font/woff" }, { ".ttf", "font/ttf" },
            { ".mp4", "video/mp4" }, { ".webm", "video/webm" }, { ".mp3", "audio/mpeg" }, { ".wav", "audio/wav" }, { ".pdf", "application/pdf" }, { ".txt", "text/plain; charset=utf-8" },
        };

        /// <summary>
        /// What file.emdedown serves as raw bytes: images, audio/video, and the CSS/fonts of custom themes.
        /// Anything else (text, config, documents) is refused, so a document cannot pull an arbitrary local file into the
        /// page (and from there into an HTML/Word export) by naming it as an image. Documents are read through ?read=1.
        /// </summary>
        static readonly Dictionary<string, string> RawFileMime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { ".svg", "image/svg+xml" }, { ".png", "image/png" }, { ".apng", "image/apng" }, { ".jpg", "image/jpeg" }, { ".jpeg", "image/jpeg" },
            { ".jfif", "image/jpeg" }, { ".gif", "image/gif" }, { ".webp", "image/webp" }, { ".bmp", "image/bmp" }, { ".ico", "image/x-icon" },
            { ".avif", "image/avif" },
            { ".mp4", "video/mp4" }, { ".m4v", "video/mp4" }, { ".webm", "video/webm" }, { ".ogv", "video/ogg" }, { ".mov", "video/quicktime" },
            { ".mp3", "audio/mpeg" }, { ".m4a", "audio/mp4" }, { ".wav", "audio/wav" }, { ".ogg", "audio/ogg" }, { ".oga", "audio/ogg" },
            { ".opus", "audio/ogg" }, { ".flac", "audio/flac" },
            { ".css", "text/css; charset=utf-8" }, { ".woff2", "font/woff2" }, { ".woff", "font/woff" }, { ".ttf", "font/ttf" },
        };

        void OnResource(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            try
            {
                var uri = new Uri(e.Request.Uri);
                if (uri.Host == "app.emdedown")
                {
                    string rel = Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/');
                    if (rel.Length == 0) rel = "index.html";
                    byte[] data = GetResource(rel);
                    if (data == null) { e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", ""); return; }
                    string mime;
                    if (!Mime.TryGetValue(Path.GetExtension(rel), out mime)) mime = "application/octet-stream";
                    string cache = rel.StartsWith("chunks/") || rel.StartsWith("fonts/") ? "max-age=31536000, immutable" : "no-cache";
                    e.Response = env.CreateWebResourceResponse(new MemoryStream(data, false), 200, "OK", "Content-Type: " + mime + "\r\nCache-Control: " + cache + "\r\nAccess-Control-Allow-Origin: *");
                }
                else if (uri.Host == "file.emdedown")
                {
                    string p = Uri.UnescapeDataString(uri.AbsolutePath);
                    if (p.StartsWith("/")) p = p.Substring(1);
                    p = p.Replace('/', '\\');
                    // Before any file system call: a UNC/device path would make Windows contact another machine.
                    if (!IsAllowedPath(p)) { e.Response = env.CreateWebResourceResponse(null, 403, "Forbidden", "Access-Control-Allow-Origin: *"); return; }
                    if (!File.Exists(p)) { e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "Access-Control-Allow-Origin: *"); return; }
                    if (uri.Query == "?read=1")
                    {
                        // Decoded, newline-normalized document text (fast path for opening files).
                        // Read on a background thread (it may retry and sleep); respond on the UI thread.
                        var deferral = e.GetDeferral();
                        string path = p;
                        Task.Run(() =>
                        {
                            FileService.TextFile tf = null;
                            string full = null;
                            try { tf = FileService.Read(path); full = Path.GetFullPath(path); } catch { tf = null; }
                            Action respond = () =>
                            {
                                try
                                {
                                    if (tf == null) e.Response = env.CreateWebResourceResponse(null, 500, "Error", "");
                                    else
                                    {
                                        var bytes = new UTF8Encoding(false).GetBytes(tf.Text);
                                        e.Response = env.CreateWebResourceResponse(new MemoryStream(bytes, false), 200, "OK",
                                            "Content-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: X-Eol, X-MTime, X-Path, X-Enc\r\nX-Eol: " + tf.Eol + "\r\nX-MTime: " + Ticks(tf.MTime) + "\r\nX-Enc: " + tf.Enc + "\r\nX-Path: " + Uri.EscapeDataString(full));
                                    }
                                }
                                catch { }
                                finally { try { deferral.Complete(); } catch { } }
                            };
                            try { BeginInvoke(respond); }
                            catch { try { deferral.Complete(); } catch { } }
                        });
                        return;
                    }
                    string mime;
                    if (!RawFileMime.TryGetValue(Path.GetExtension(p), out mime)) { e.Response = env.CreateWebResourceResponse(null, 403, "Forbidden", "Access-Control-Allow-Origin: *"); return; }
                    var fs = new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    e.Response = env.CreateWebResourceResponse(fs, 200, "OK", "Content-Type: " + mime + "\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-cache\r\nAccess-Control-Allow-Origin: *");
                }
            }
            catch
            {
                try { e.Response = env.CreateWebResourceResponse(null, 500, "Error", ""); } catch { }
            }
        }

        byte[] GetResource(string rel)
        {
            lock (resCache)
            {
                byte[] data;
                if (resCache.TryGetValue(rel, out data)) return data;
                using (var s = Program.Resource("web/" + rel + ".gz"))
                {
                    if (s == null) return null;
                    using (var gz = new GZipStream(s, CompressionMode.Decompress))
                    using (var ms = new MemoryStream())
                    {
                        gz.CopyTo(ms);
                        data = ms.ToArray();
                    }
                }
                if (data.Length < 4 * 1024 * 1024) resCache[rel] = data;
                return data;
            }
        }

        // ---------------- messaging ----------------
        void Post(string type, Dictionary<string, object> payload)
        {
            try
            {
                if (web.IsDisposed || web.CoreWebView2 == null) return;
                var d = payload ?? new Dictionary<string, object>();
                d["type"] = type;
                web.CoreWebView2.PostWebMessageAsJson(json.Serialize(d));
            }
            catch { }
        }

        /// <summary>File times go to the page as decimal strings: .NET ticks exceed 2^53 and lose precision as JS numbers.</summary>
        static string Ticks(long t) { return t.ToString(System.Globalization.CultureInfo.InvariantCulture); }

        /// <summary>Hands files to the page, or queues them until the page has called "ready". UI thread only.</summary>
        void DeliverOpenFiles(Dictionary<string, object> payload)
        {
            if (!ready || web.IsDisposed || web.CoreWebView2 == null) { pendingOpen.Add(payload); return; }
            Post("openFiles", payload);
        }

        void FlushPendingOpen()
        {
            if (pendingOpen.Count == 0) return;
            var q = pendingOpen.ToList();
            pendingOpen.Clear();
            foreach (var p in q) Post("openFiles", p);
        }

        void Reply(object id, object result, string error)
        {
            if (web.CoreWebView2 == null) return;
            var d = new Dictionary<string, object>();
            d["replyTo"] = id;
            if (error != null) d["error"] = error; else d["result"] = result;
            try { web.CoreWebView2.PostWebMessageAsJson(json.Serialize(d)); } catch { }
        }

        void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!e.Source.StartsWith("https://app.emdedown/", StringComparison.OrdinalIgnoreCase)) return;
            // Any message after "closeRequested" means the page is alive (it may be showing its own save prompt).
            if (closePending) CancelCloseWatchdog();
            Dictionary<string, object> msg;
            try { msg = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson); } catch { return; }
            object id = msg.ContainsKey("id") ? msg["id"] : null;
            string method = msg.ContainsKey("method") ? msg["method"] as string : null;
            var args = msg.ContainsKey("args") ? msg["args"] as Dictionary<string, object> : null;
            if (args == null) args = new Dictionary<string, object>();

            if (method == "dropFiles")
            {
                var paths = new List<object>();
                try
                {
                    var objs = e.AdditionalObjects;
                    for (int i = 0; i < objs.Count; i++)
                    {
                        var f = objs[i] as CoreWebView2File;
                        if (f != null && !string.IsNullOrEmpty(f.Path)) { paths.Add(f.Path); TrustUserPath(f.Path); }
                    }
                }
                catch { }
                if (paths.Count > 0) DeliverOpenFiles(new Dictionary<string, object> { { "paths", paths } });
                return;
            }
            HandleCall(id, method, args);
        }

        static string S(Dictionary<string, object> a, string k)
        {
            object v;
            return a.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null;
        }
        static bool B(Dictionary<string, object> a, string k)
        {
            object v;
            return a.TryGetValue(k, out v) && v is bool && (bool)v;
        }

        // Runs work on a background thread and replies on the UI thread.
        void Background(object id, Func<object> work)
        {
            Task.Run(() =>
            {
                object result = null; string error = null;
                try { result = work(); }
                catch (OperationCanceledException) { error = "CANCELLED"; }
                catch (AggregateException ex)
                {
                    var flat = ex.Flatten();
                    error = flat.InnerExceptions.Count > 0 && flat.InnerExceptions.All(x => x is OperationCanceledException) ? "CANCELLED"
                        : (flat.InnerExceptions.Count > 0 ? flat.InnerExceptions[0].Message : ex.Message);
                }
                catch (Exception ex) { error = ex.Message; }
                try { BeginInvoke(new Action(() => Reply(id, result, error))); } catch { }
            });
        }

        // Embedded by build.ps1 from samples\ as resources named guide/<path>.
        static readonly string[] GuideFiles = { "Guide.md", "Welcome.md", "images/emdedown-logo.svg" };

        string testPath; // automated tests only (EMDEDOWN_DEVTOOLS=1): skip the save dialog
        async void HandleCall(object id, string method, Dictionary<string, object> a)
        {
            if (Environment.GetEnvironmentVariable("EMDEDOWN_DEVTOOLS") == "1" && a.ContainsKey("testPath")) testPath = S(a, "testPath");
            try
            {
                switch (method)
                {
                    case "init":
                    {
                        var r = new Dictionary<string, object>();
                        r["settings"] = File.Exists(SettingsPath) ? File.ReadAllText(SettingsPath, Encoding.UTF8) : "{}";
                        r["files"] = startupFiles.Cast<object>().ToList();
                        r["edit"] = Program.StartInEditMode;
                        r["installed"] = Installer.IsInstalled;
                        r["isDefault"] = Installer.IsDefault;
                        r["desktopShortcut"] = Installer.HasDesktopShortcut;
                        r["runningInstalled"] = Installer.RunningInstalled;
                        r["version"] = Program.Version;
                        r["themesDir"] = ThemesDir;
                        r["themes"] = Directory.Exists(ThemesDir) ? Directory.GetFiles(ThemesDir, "*.css").Select(Path.GetFileName).Cast<object>().ToList() : new List<object>();
                        try { r["recovery"] = File.Exists(RecoveryPath) ? File.ReadAllText(RecoveryPath, Encoding.UTF8) : null; } catch { r["recovery"] = null; }
                        Reply(id, r, null);
                        return;
                    }
                    case "sessionFlush":
                    {
                        // Sent by the page in answer to "sessionEnding": its settings (with the session) and every unsaved text.
                        string settingsJson = S(a, "settings");
                        string recoveryJson = S(a, "recovery");
                        try { if (!string.IsNullOrEmpty(recoveryJson)) FileService.WriteBytesAtomic(RecoveryPath, new UTF8Encoding(false).GetBytes(recoveryJson)); } catch { }
                        try { if (!string.IsNullOrEmpty(settingsJson)) FileService.WriteBytesAtomic(SettingsPath, new UTF8Encoding(false).GetBytes(settingsJson)); } catch { }
                        sessionFlushed = true;
                        Reply(id, true, null);
                        return;
                    }
                    case "clearRecovery":
                        try { if (File.Exists(RecoveryPath)) File.Delete(RecoveryPath); } catch { }
                        Reply(id, true, null);
                        return;
                    case "closeAck": Reply(id, true, null); return; // the page got "closeRequested" and is handling it (watchdog already cancelled above)
                    case "editorFocus": editorFocused = B(a, "on"); Reply(id, true, null); return;
                    case "unwatchFolder": DisposeFolderWatchers(); watchedFolder = null; Reply(id, true, null); return;
                    case "setDesktopShortcut": Installer.SetDesktopShortcut(B(a, "on")); Reply(id, Installer.HasDesktopShortcut, null); return;
                    case "ready": ready = true; Reply(id, true, null); FlushPendingOpen(); return;
                    case "saveSettings":
                    {
                        string text = S(a, "json") ?? "{}";
                        FileService.WriteBytesAtomic(SettingsPath, new UTF8Encoding(false).GetBytes(text));
                        Reply(id, true, null);
                        return;
                    }
                    case "readFile":
                    {
                        string path = S(a, "path");
                        RequireAllowed(path);
                        Background(id, () =>
                        {
                            var f = FileService.Read(path);
                            return new Dictionary<string, object> { { "path", Path.GetFullPath(path) }, { "text", f.Text }, { "eol", f.Eol }, { "enc", f.Enc }, { "mtime", Ticks(f.MTime) } };
                        });
                        return;
                    }
                    case "saveFile":
                    {
                        string path = S(a, "path");
                        RequireAllowed(path);
                        // Conflict check: the page sends the mtime it last read; refuse to overwrite a file changed since.
                        string expect = S(a, "mtime");
                        if (!string.IsNullOrEmpty(expect) && !B(a, "force") && File.Exists(path) && Ticks(FileService.MTimeOf(path)) != expect)
                        {
                            Reply(id, null, "CONFLICT");
                            return;
                        }
                        string enc = S(a, "enc");
                        if (string.IsNullOrEmpty(enc)) enc = "utf8";
                        long mt = FileService.Write(path, S(a, "text") ?? "", S(a, "eol") ?? "CRLF", ref enc);
                        Reply(id, new Dictionary<string, object> { { "mtime", Ticks(mt) }, { "enc", enc } }, null);
                        return;
                    }
                    case "pathKind":
                    {
                        string p = S(a, "path");
                        RequireAllowed(p);
                        Reply(id, Directory.Exists(p) ? "dir" : File.Exists(p) ? "file" : "missing", null);
                        return;
                    }
                    case "listFolder":
                    {
                        string dir = S(a, "dir");
                        RequireAllowed(dir);
                        Background(id, () => FileService.ListFolder(dir));
                        WatchFolder(dir);
                        return;
                    }
                    case "searchFolder":
                    {
                        string dir = S(a, "dir"), q = S(a, "query");
                        RequireAllowed(dir);
                        bool mc = B(a, "matchCase");
                        // A new search cancels the previous one (which then replies "CANCELLED").
                        if (searchCts != null) searchCts.Cancel();
                        var cts = new CancellationTokenSource();
                        searchCts = cts;
                        var token = cts.Token;
                        Background(id, () => FileService.Search(dir, q, mc, token));
                        return;
                    }
                    case "watch":
                    {
                        var list = new List<string>();
                        object v;
                        if (a.TryGetValue("paths", out v) && v is IEnumerable)
                            foreach (var p in (IEnumerable)v) if (p != null) list.Add(Convert.ToString(p));
                        foreach (var p in list) TrustPath(p, false);
                        SetWatched(list);
                        Reply(id, true, null);
                        return;
                    }
                    case "openDialog":
                    {
                        using (var d = new OpenFileDialog())
                        {
                            if (S(a, "filter") == "image")
                            {
                                d.Title = "Insert image";
                                d.Filter = "Images|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp;*.svg;*.avif|All files|*.*";
                            }
                            else
                            {
                                d.Title = "Open Markdown file";
                                d.Filter = "Markdown files|*.md;*.markdown;*.mdown;*.mkd;*.mkdn;*.mdx;*.mdwn|Text files|*.txt|All files|*.*";
                            }
                            d.Multiselect = true;
                            string dir = S(a, "dir");
                            if (!string.IsNullOrEmpty(dir) && IsAllowedPath(dir) && Directory.Exists(dir)) d.InitialDirectory = dir;
                            bool ok = d.ShowDialog(this) == DialogResult.OK;
                            if (ok) foreach (var f in d.FileNames) TrustPath(f, false);
                            Reply(id, ok ? d.FileNames.Cast<object>().ToList() : null, null);
                        }
                        return;
                    }
                    case "folderDialog":
                    {
                        string initial = S(a, "dir");
                        string picked = Native.PickFolder(Handle, IsAllowedPath(initial) ? initial : null);
                        if (picked != null) TrustPath(picked, true);
                        Reply(id, picked, null);
                        return;
                    }
                    case "saveDialog":
                    {
                        string filter = S(a, "filter");
                        Reply(id, SaveDialog(S(a, "name"), filter, S(a, "dir")), null);
                        return;
                    }
                    case "saveText":
                    {
                        string path = SaveDialog(S(a, "name"), S(a, "filter"), S(a, "dir"));
                        if (path != null) FileService.WriteBytesAtomic(path, new UTF8Encoding(false).GetBytes(S(a, "text") ?? ""));
                        Reply(id, path, null);
                        return;
                    }
                    case "exportPdf":
                    {
                        string path = SaveDialog(S(a, "name"), "pdf", S(a, "dir"));
                        if (path == null) { Reply(id, null, null); return; }
                        var ps = env.CreatePrintSettings();
                        ps.ShouldPrintBackgrounds = true;
                        ps.ShouldPrintHeaderAndFooter = false;
                        ps.MarginTop = ps.MarginBottom = 0.7;
                        ps.MarginLeft = ps.MarginRight = 0.75;
                        bool ok = await web.CoreWebView2.PrintToPdfAsync(path, ps);
                        if (!ok) throw new IOException("Could not write the PDF (is it open in another program?)");
                        Reply(id, path, null);
                        return;
                    }
                    case "exportDocx":
                    {
                        string path = SaveDialog(S(a, "name"), "docx", S(a, "dir"));
                        if (path == null) { Reply(id, null, null); return; }
                        string html = S(a, "html") ?? "";
                        Background(id, () => { FileService.WriteDocx(path, html); return path; });
                        return;
                    }
                    case "saveImage":
                        RequireAllowed(S(a, "docPath"));
                        Reply(id, FileService.SaveImage(S(a, "docPath"), S(a, "name") ?? "image.png", S(a, "base64")), null);
                        return;
                    case "openExternal":
                    {
                        string url = S(a, "url");
                        if (url != null) OpenExternalUrl(url);
                        else FileService.OpenPath(S(a, "path"), IsAllowedPath);
                        Reply(id, true, null);
                        return;
                    }
                    case "reveal": RequireAllowed(S(a, "path")); FileService.Reveal(S(a, "path")); Reply(id, true, null); return;
                    case "setTitle": Text = S(a, "title") ?? "Emdedown"; Reply(id, true, null); return;
                    case "setChrome":
                    {
                        bool dark = B(a, "dark");
                        try
                        {
                            var c = ColorTranslator.FromHtml(S(a, "bg") ?? "#ffffff");
                            BackColor = c;
                            web.DefaultBackgroundColor = c;
                        }
                        catch { }
                        Native.SetDarkTitleBar(Handle, dark);
                        SaveWindow();
                        Reply(id, true, null);
                        return;
                    }
                    case "setFullscreen": SetFullscreen(B(a, "on")); Reply(id, true, null); return;
                    case "install":
                    {
                        Installer.Install(B(a, "desktop"));
                        Reply(id, new Dictionary<string, object> { { "relaunch", !Installer.RunningInstalled } }, null);
                        return;
                    }
                    case "relaunchInstalled":
                    {
                        var files = new List<string>();
                        object v;
                        if (a.TryGetValue("files", out v) && v is IEnumerable) foreach (var p in (IEnumerable)v) files.Add("\"" + p + "\"");
                        Reply(id, true, null);
                        SaveWindow();
                        StopPipeServer();
                        Program.ReleaseInstance();
                        System.Diagnostics.Process.Start(Installer.InstalledExe, string.Join(" ", files.ToArray()));
                        allowClose = true;
                        Close();
                        return;
                    }
                    case "setDefault": Reply(id, Installer.SetDefault(Handle, S(a, "docPath")), null); return;
                    case "isDefault": Reply(id, Installer.IsDefault, null); return;
                    case "uninstall":
                    {
                        Reply(id, true, null);
                        SaveWindow();
                        StopPipeServer();
                        allowClose = true;
                        Installer.Uninstall();
                        Close();
                        return;
                    }
                    case "guidePath":
                    {
                        // The user guide ships inside the exe. It is written to the data folder (when missing or
                        // different from the built-in copy) and opened from there like any other document.
                        string dir = Path.Combine(Program.DataDir, "guide");
                        foreach (var rel in GuideFiles)
                        {
                            using (var s = Program.Resource("guide/" + rel))
                            {
                                if (s == null) throw new FileNotFoundException("The built-in guide is missing from this build.");
                                string target = Path.Combine(dir, rel.Replace('/', '\\'));
                                if (File.Exists(target) && new FileInfo(target).Length == s.Length) continue;
                                var buf = new byte[s.Length];
                                int read = 0;
                                while (read < buf.Length) read += s.Read(buf, read, buf.Length - read);
                                FileService.WriteBytesAtomic(target, buf);
                            }
                        }
                        Reply(id, Path.Combine(dir, S(a, "name") == "Welcome.md" ? "Welcome.md" : "Guide.md"), null);
                        return;
                    }
                    case "openThemesFolder":
                    {
                        Directory.CreateDirectory(ThemesDir);
                        string readme = Path.Combine(ThemesDir, "README.txt");
                        if (!File.Exists(readme))
                            File.WriteAllText(readme, "Put .css files here to add your own themes (Settings > Theme).\r\nOverride variables such as --bg, --fg, --accent, --link, --code-bg on :root, or style .markdown-body directly.\r\nInclude \"dark\" in the file name for dark themes.\r\n");
                        System.Diagnostics.Process.Start("explorer.exe", "\"" + ThemesDir + "\"");
                        Reply(id, true, null);
                        return;
                    }
                    case "quit":
                        Reply(id, true, null);
                        allowClose = true;
                        BeginInvoke(new Action(Close));
                        return;
                    default:
                        Reply(id, null, "Unknown method: " + method);
                        return;
                }
            }
            catch (Exception ex)
            {
                Reply(id, null, ex.Message);
            }
        }

        // ---------------- right-click menu ----------------
        // Browser items that make no sense in this app (or do nothing in the editor, like "Writing direction").
        static readonly string[] HiddenMenuItems = { "back", "forward", "reload", "saveAs", "print", "createQrCode", "inspectElement", "writingDirection", "openLinkInNewWindow", "saveLinkAs", "saveImageAs", "copyImageLocation", "share", "webCapture", "readAloud", "translate" };

        void OnContextMenu(object sender, CoreWebView2ContextMenuRequestedEventArgs e)
        {
            try
            {
                var items = e.MenuItems;
                for (int i = items.Count - 1; i >= 0; i--)
                {
                    var it = items[i];
                    string n = it.Name ?? "", l = (it.Label ?? "").Replace("&", "");
                    bool hide = l.IndexOf("Writing direction", StringComparison.OrdinalIgnoreCase) >= 0;
                    foreach (var h in HiddenMenuItems) if (string.Equals(n, h, StringComparison.OrdinalIgnoreCase) || n.IndexOf("writingDirection", StringComparison.OrdinalIgnoreCase) >= 0) { hide = true; break; }
                    if (n == "inspectElement" && web.CoreWebView2.Settings.AreDevToolsEnabled) hide = false;
                    if (hide) items.RemoveAt(i);
                }
                if (e.ContextMenuTarget.IsEditable && editorFocused && env != null)
                {
                    items.Add(env.CreateContextMenuItem("", null, CoreWebView2ContextMenuItemKind.Separator));
                    items.Add(FormatItem("Bold", "bold"));
                    items.Add(FormatItem("Italic", "italic"));
                    items.Add(FormatItem("Strikethrough", "strike"));
                    items.Add(FormatItem("Inline code", "code"));
                    items.Add(FormatItem("Link", "link"));
                    var sub = env.CreateContextMenuItem("Paragraph", null, CoreWebView2ContextMenuItemKind.Submenu);
                    sub.Children.Add(FormatItem("Heading 1", "h1"));
                    sub.Children.Add(FormatItem("Heading 2", "h2"));
                    sub.Children.Add(FormatItem("Heading 3", "h3"));
                    sub.Children.Add(FormatItem("Bullet list", "bullet"));
                    sub.Children.Add(FormatItem("Numbered list", "numbered"));
                    sub.Children.Add(FormatItem("Checklist", "check"));
                    sub.Children.Add(FormatItem("Quote", "quote"));
                    items.Add(sub);
                    items.Add(FormatItem("Insert image…", "image"));
                    items.Add(FormatItem("Insert table", "table"));
                }
                // tidy separators: none first/last, never two in a row
                for (int i = items.Count - 1; i >= 0; i--)
                {
                    bool sep = items[i].Kind == CoreWebView2ContextMenuItemKind.Separator;
                    if (sep && (i == 0 || i == items.Count - 1 || items[i - 1].Kind == CoreWebView2ContextMenuItemKind.Separator)) items.RemoveAt(i);
                }
                if (items.Count == 0) e.Handled = true; // nothing useful left: show no menu
            }
            catch { }
        }

        CoreWebView2ContextMenuItem FormatItem(string label, string cmd)
        {
            var it = env.CreateContextMenuItem(label, null, CoreWebView2ContextMenuItemKind.Command);
            it.CustomItemSelected += (s, a) => BeginInvoke(new Action(() => Post("format", new Dictionary<string, object> { { "cmd", cmd } })));
            return it;
        }

        string SaveDialog(string name, string filter, string dir)
        {
            if (testPath != null) { var p = testPath; testPath = null; return p; }
            using (var d = new SaveFileDialog())
            {
                d.FileName = name ?? "document";
                d.OverwritePrompt = true;
                d.AddExtension = true;
                switch (filter)
                {
                    case "pdf": d.Filter = "PDF document|*.pdf"; d.DefaultExt = "pdf"; break;
                    case "html": d.Filter = "Web page|*.html"; d.DefaultExt = "html"; break;
                    case "docx": d.Filter = "Word document|*.docx"; d.DefaultExt = "docx"; break;
                    default: d.Filter = "Markdown|*.md|Text|*.txt|All files|*.*"; d.DefaultExt = "md"; break;
                }
                if (!string.IsNullOrEmpty(dir) && IsAllowedPath(dir) && Directory.Exists(dir)) d.InitialDirectory = dir;
                if (d.ShowDialog(this) != DialogResult.OK) return null;
                TrustPath(d.FileName, false);
                return d.FileName;
            }
        }

        // ---------------- Windows shutdown / sign-out ----------------
        // Windows gives only a few seconds and no prompt can be shown, so the page hands over every unsaved text and
        // the host writes it to recovery.json itself (browser storage may not reach the disk before the process dies).
        // The next start restores it (init → "recovery"; the page calls "clearRecovery" once it has the drafts).
        const int WM_QUERYENDSESSION = 0x0011, WM_ENDSESSION = 0x0016;
        string RecoveryPath { get { return Path.Combine(Program.DataDir, "recovery.json"); } }
        bool sessionFlushed;

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_QUERYENDSESSION && ready && !allowClose && web.CoreWebView2 != null) FlushForShutdown();
            // Shutdown cancelled (another app refused): Emdedown keeps running and its live drafts are newer than the
            // snapshot, which must not be "recovered" over them at the next start.
            if (m.Msg == WM_ENDSESSION && m.WParam == IntPtr.Zero) { try { if (File.Exists(RecoveryPath)) File.Delete(RecoveryPath); } catch { } }
            base.WndProc(ref m);
        }

        void FlushForShutdown()
        {
            sessionFlushed = false;
            CancelCloseWatchdog();
            Post("sessionEnding", null);
            // Keep pumping messages (WebView2 delivers the page's answer through the message loop) for at most 2.5 s.
            var clock = System.Diagnostics.Stopwatch.StartNew();
            while (!sessionFlushed && clock.ElapsedMilliseconds < 2500 && !IsDisposed)
            {
                Application.DoEvents();
                Thread.Sleep(10);
            }
            // The close that follows has CloseReason.WindowsShutDown, which OnClosing lets through without the save prompt.
        }

        // ---------------- closing ----------------
        void OnClosing(object sender, FormClosingEventArgs e)
        {
            // TaskManagerClosing = a WM_CLOSE from another program (Task Manager "End task", taskbar previews): ask about unsaved changes too.
            if (!allowClose && ready && (e.CloseReason == CloseReason.UserClosing || e.CloseReason == CloseReason.TaskManagerClosing) && web.CoreWebView2 != null)
            {
                e.Cancel = true;
                Post("closeRequested", null);
                StartCloseWatchdog();
                return;
            }
            closing = true;
            CancelCloseWatchdog();
            if (searchCts != null) searchCts.Cancel();
            SaveWindow();
            StopPipeServer();
            foreach (var w in watchers.Values) w.Dispose();
            DisposeFolderWatchers();
            lock (notifyLock) { if (folderNotifyTimer != null) { folderNotifyTimer.Dispose(); folderNotifyTimer = null; } }
        }

        void StartCloseWatchdog()
        {
            if (closeTimer == null)
            {
                closeTimer = new System.Windows.Forms.Timer { Interval = 4000 };
                closeTimer.Tick += OnCloseTimeout;
            }
            closeTimer.Stop();
            closePending = true;
            closeTimer.Start();
        }

        void CancelCloseWatchdog()
        {
            closePending = false;
            if (closeTimer != null) closeTimer.Stop();
        }

        void OnCloseTimeout(object sender, EventArgs e)
        {
            bool wasPending = closePending;
            CancelCloseWatchdog();
            if (!wasPending || allowClose || closing || IsDisposed) return;
            var r = MessageBox.Show(this, "Emdedown is not responding to the close request.\n\nClose anyway? Unsaved changes may be lost.",
                "Emdedown", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
            if (r == DialogResult.Yes)
            {
                allowClose = true;
                Close();
            }
        }

        // ---------------- file watching ----------------
        readonly Dictionary<string, FileSystemWatcher> watchers = new Dictionary<string, FileSystemWatcher>(StringComparer.OrdinalIgnoreCase);
        readonly HashSet<string> watched = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        readonly Dictionary<string, System.Threading.Timer> pendingChanges = new Dictionary<string, System.Threading.Timer>(StringComparer.OrdinalIgnoreCase);
        FileSystemWatcher folderWatcher;
        string watchedFolder;

        void SetWatched(List<string> paths)
        {
            lock (watched)
            {
                watched.Clear();
                foreach (var p in paths) watched.Add(Path.GetFullPath(p));
            }
            var dirs = new HashSet<string>(paths.Select(p => Path.GetDirectoryName(Path.GetFullPath(p))), StringComparer.OrdinalIgnoreCase);
            foreach (var d in watchers.Keys.ToList())
                if (!dirs.Contains(d)) { watchers[d].Dispose(); watchers.Remove(d); }
            foreach (var d in dirs)
            {
                if (watchers.ContainsKey(d) || !Directory.Exists(d)) continue;
                try
                {
                    var w = new FileSystemWatcher(d) { NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size, IncludeSubdirectories = false };
                    string dir = d;
                    w.Changed += (s, e) => Touch(e.FullPath);
                    w.Created += (s, e) => Touch(e.FullPath);
                    w.Deleted += (s, e) => Touch(e.FullPath);
                    w.Renamed += (s, e) => { Touch(e.OldFullPath); Touch(e.FullPath); };
                    w.Error += (s, e) => OnFileWatcherError(dir, (FileSystemWatcher)s);
                    w.EnableRaisingEvents = true;
                    watchers[d] = w;
                }
                catch { }
            }
        }

        /// <summary>A watcher failed (buffer overflow, network hiccup): recreate it after a moment and recheck its files.</summary>
        void OnFileWatcherError(string dir, FileSystemWatcher failed)
        {
            Task.Delay(1000).ContinueWith(_ =>
            {
                try
                {
                    BeginInvoke(new Action(() =>
                    {
                        if (closing || IsDisposed) return;
                        FileSystemWatcher cur;
                        if (!watchers.TryGetValue(dir, out cur) || cur != failed) return; // already replaced or no longer needed
                        cur.Dispose();
                        watchers.Remove(dir);
                        List<string> list;
                        lock (watched) list = watched.ToList();
                        SetWatched(list);
                        foreach (var p in list)
                            if (string.Equals(Path.GetDirectoryName(p), dir, StringComparison.OrdinalIgnoreCase)) Touch(p);
                    }));
                }
                catch { }
            });
        }

        void Touch(string path)
        {
            lock (watched) { if (!watched.Contains(path)) return; }
            lock (pendingChanges)
            {
                System.Threading.Timer t;
                if (pendingChanges.TryGetValue(path, out t)) { t.Change(180, Timeout.Infinite); return; }
                pendingChanges[path] = new System.Threading.Timer(_ => FireChange(path), null, 180, Timeout.Infinite);
            }
        }

        void FireChange(string path)
        {
            lock (pendingChanges)
            {
                System.Threading.Timer t;
                if (pendingChanges.TryGetValue(path, out t)) { t.Dispose(); pendingChanges.Remove(path); }
            }
            Dictionary<string, object> payload;
            string type;
            if (File.Exists(path))
            {
                try
                {
                    var f = FileService.Read(path);
                    payload = new Dictionary<string, object> { { "path", path }, { "text", f.Text }, { "mtime", Ticks(f.MTime) }, { "enc", f.Enc } };
                    type = "fileChanged";
                }
                catch { return; }
            }
            else
            {
                Thread.Sleep(400); // editors often delete + rename on save
                if (File.Exists(path)) { FireChange(path); return; }
                payload = new Dictionary<string, object> { { "path", path } };
                type = "fileDeleted";
            }
            try { BeginInvoke(new Action(() => Post(type, payload))); } catch { }
        }

        // Two watchers on the open folder: with NotifyFilters.FileName only file events are raised, with
        // NotifyFilters.DirectoryName only directory events. That tells files and folders apart even for
        // deleted paths, which can no longer be checked on disk.
        FileSystemWatcher folderDirWatcher;
        readonly object notifyLock = new object();
        System.Threading.Timer folderNotifyTimer;

        void WatchFolder(string dir) { WatchFolder(dir, false); }

        void WatchFolder(string dir, bool force)
        {
            if (!force && string.Equals(dir, watchedFolder, StringComparison.OrdinalIgnoreCase)) return;
            DisposeFolderWatchers();
            watchedFolder = dir;
            try
            {
                var fw = new FileSystemWatcher(dir) { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.FileName };
                FileSystemEventHandler fh = (s, e) => { if (FileService.IsMarkdown(e.FullPath) && !Skipped(dir, e.FullPath)) Notify(); };
                fw.Created += fh;
                fw.Deleted += fh;
                fw.Renamed += (s, e) =>
                {
                    if ((FileService.IsMarkdown(e.FullPath) && !Skipped(dir, e.FullPath)) || (FileService.IsMarkdown(e.OldFullPath) && !Skipped(dir, e.OldFullPath))) Notify();
                };
                fw.Error += (s, e) => OnFolderWatcherError(dir);
                fw.EnableRaisingEvents = true;
                folderWatcher = fw;

                var dw = new FileSystemWatcher(dir) { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.DirectoryName };
                FileSystemEventHandler dh = (s, e) => { if (!Skipped(dir, e.FullPath)) Notify(); };
                dw.Created += dh;
                dw.Deleted += dh;
                dw.Renamed += (s, e) => { if (!Skipped(dir, e.FullPath) || !Skipped(dir, e.OldFullPath)) Notify(); };
                dw.Error += (s, e) => OnFolderWatcherError(dir);
                dw.EnableRaisingEvents = true;
                folderDirWatcher = dw;
            }
            catch { }
        }

        void DisposeFolderWatchers()
        {
            if (folderWatcher != null) { folderWatcher.Dispose(); folderWatcher = null; }
            if (folderDirWatcher != null) { folderDirWatcher.Dispose(); folderDirWatcher = null; }
        }

        /// <summary>Changes inside folders the listing skips (.git, node_modules, ...) don't need a refresh.</summary>
        static bool Skipped(string root, string full)
        {
            if (full == null || root == null || !full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) return false;
            return FileService.IsSkippedRelative(full.Substring(root.Length));
        }

        void OnFolderWatcherError(string dir)
        {
            Task.Delay(1000).ContinueWith(_ =>
            {
                try
                {
                    BeginInvoke(new Action(() =>
                    {
                        if (closing || IsDisposed || !string.Equals(dir, watchedFolder, StringComparison.OrdinalIgnoreCase)) return;
                        WatchFolder(dir, true);
                        Notify(); // events may have been lost
                    }));
                }
                catch { }
            });
        }

        // Debounced: a burst of file system events produces one refresh.
        void Notify()
        {
            lock (notifyLock)
            {
                if (closing) return;
                if (folderNotifyTimer == null)
                    folderNotifyTimer = new System.Threading.Timer(_ => { try { BeginInvoke(new Action(() => Post("folderChanged", null))); } catch { } }, null, 250, Timeout.Infinite);
                else
                    folderNotifyTimer.Change(250, Timeout.Infinite);
            }
        }

        // ---------------- single instance pipe ----------------
        Thread pipeThread;
        volatile bool pipeStop;

        void StartPipeServer()
        {
            pipeThread = new Thread(PipeLoop) { IsBackground = true, Name = "Emdedown pipe" };
            pipeThread.Start();
        }

        void StopPipeServer()
        {
            pipeStop = true;
            try
            {
                using (var c = new NamedPipeClientStream(".", Program.PipeName, PipeDirection.Out)) { c.Connect(200); }
            }
            catch { }
        }

        void PipeLoop()
        {
            while (!pipeStop)
            {
                try
                {
                    using (var server = new NamedPipeServerStream(Program.PipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte))
                    {
                        server.WaitForConnection();
                        if (pipeStop) return;
                        using (var ms = new MemoryStream())
                        {
                            server.CopyTo(ms);
                            var lines = Encoding.UTF8.GetString(ms.ToArray()).Split('\n');
                            var files = lines.Skip(1).Where(l => l.Trim().Length > 0).Cast<object>().ToList();
                            bool edit = lines.Length > 0 && lines[0] == "edit";
                            foreach (var f in files) TrustUserPath((string)f); // off the UI thread: may touch the share
                            RunOnUi(() =>
                            {
                                if (Native.IsIconic(Handle)) Native.ShowWindow(Handle, 9);
                                Activate();
                                Native.SetForegroundWindow(Handle);
                                if (files.Count > 0) DeliverOpenFiles(new Dictionary<string, object> { { "paths", files }, { "edit", edit } });
                            });
                        }
                    }
                }
                catch (Exception)
                {
                    if (pipeStop) return;
                    Thread.Sleep(200);
                }
            }
        }

        /// <summary>From a background thread: waits until the window handle exists, then BeginInvokes.
        /// Retries briefly if the handle is being recreated; gives up when the window is closing.</summary>
        void RunOnUi(Action a)
        {
            for (int i = 0; i < 50; i++)
            {
                while (!handleReady.WaitOne(250)) { if (pipeStop || IsDisposed) return; }
                if (pipeStop || IsDisposed || closing) return;
                try { BeginInvoke(a); return; }
                catch (ObjectDisposedException) { return; }
                catch (InvalidOperationException) { Thread.Sleep(100); }
            }
        }
    }
}
