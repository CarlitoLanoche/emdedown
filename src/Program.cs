using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Emdedown")]
[assembly: AssemblyProduct("Emdedown")]
[assembly: AssemblyDescription("Fast, beautiful Markdown reader and editor")]
[assembly: AssemblyCompany("Emdedown")]
[assembly: AssemblyCopyright("Copyright (c) 2026 Emdedown contributors")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
[assembly: AssemblyInformationalVersion("1.0.0")]

namespace Emdedown
{
    static class Program
    {
        public const string Version = "1.0.0";
        public static string DataDir;
        public static Mutex InstanceMutex;
        public static string PipeName;
        public static bool StartInEditMode;
        static readonly Dictionary<string, Assembly> loaded = new Dictionary<string, Assembly>();

        [STAThread]
        static int Main(string[] args)
        {
            AppDomain.CurrentDomain.AssemblyResolve += ResolveEmbedded;
            DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Emdedown");
            Directory.CreateDirectory(DataDir);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            return Run(args);
        }

        // Kept separate so the JIT doesn't need WebView2 types before AssemblyResolve is hooked up.
        [MethodImpl(MethodImplOptions.NoInlining)]
        static int Run(string[] args)
        {
            var files = new List<string>();
            bool uninstall = false;
            foreach (var a in args)
            {
                if (a == "--uninstall") { uninstall = true; continue; }
                if (a == "--edit") { StartInEditMode = true; continue; }
                if (a.StartsWith("--")) continue;
                try { files.Add(Path.GetFullPath(a)); } catch { }
            }

            PipeName = "Emdedown-" + Environment.UserName + "-" + System.Diagnostics.Process.GetCurrentProcess().SessionId;
            bool created;
            InstanceMutex = new Mutex(true, "Local\\Emdedown.SingleInstance." + Environment.UserName, out created);

            if (uninstall)
            {
                if (!created)
                {
                    MessageBox.Show("Please close Emdedown first, then try uninstalling again.", "Emdedown", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return 1;
                }
                if (MessageBox.Show("Remove Emdedown from this PC?\n\nYour documents will not be touched.", "Uninstall Emdedown", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
                {
                    Installer.Uninstall();
                    MessageBox.Show("Emdedown has been uninstalled.", "Emdedown", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                return 0;
            }

            if (!created)
            {
                // Another window is already open: hand our files to it and exit. Never start a second window while
                // that one still owns the mutex (two instances would share settings.json and the WebView2 profile).
                // A slow first start (or a window closing right now) gets more time; if it exits, we take over.
                var clock = System.Diagnostics.Stopwatch.StartNew();
                while (true)
                {
                    if (SendToRunningInstance(files)) return 0;
                    if (TryTakeOwnership()) break;
                    if (clock.ElapsedMilliseconds > 20000)
                    {
                        MessageBox.Show("Emdedown is already running but is not responding, so " + (files.Count > 0 ? "the file could not be handed to it." : "a new window was not opened.") +
                            "\n\nWait a moment and try again, or close Emdedown (Task Manager) if it stays unresponsive.", "Emdedown", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        return 3;
                    }
                }
            }

            if (!WebViewRuntime.EnsureAvailable()) return 2;
            Application.Run(new MainForm(files));
            return 0;
        }

        static bool SendToRunningInstance(List<string> files)
        {
            try
            {
                Native.AllowSetForegroundWindow(-1);
                using (var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out))
                {
                    client.Connect(2500);
                    var bytes = Encoding.UTF8.GetBytes((StartInEditMode ? "edit" : "open") + "\n" + string.Join("\n", files.ToArray()));
                    client.Write(bytes, 0, bytes.Length);
                    client.Flush();
                }
                return true;
            }
            catch { return false; }
        }

        /// <summary>Wait briefly for the single-instance mutex; true once this process owns it (the other instance exited).</summary>
        static bool TryTakeOwnership()
        {
            try { return InstanceMutex.WaitOne(500); }
            catch (AbandonedMutexException) { return true; } // previous owner died without releasing: we own it now
        }

        /// <summary>Stop being the single instance (before relaunching another copy).</summary>
        public static void ReleaseInstance()
        {
            try { if (InstanceMutex != null) { InstanceMutex.ReleaseMutex(); InstanceMutex.Dispose(); InstanceMutex = null; } } catch { }
        }

        static Assembly ResolveEmbedded(object sender, ResolveEventArgs e)
        {
            var name = new AssemblyName(e.Name).Name;
            lock (loaded)
            {
                Assembly asm;
                if (loaded.TryGetValue(name, out asm)) return asm;
                using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("lib/" + name + ".dll"))
                {
                    if (s == null) return null;
                    var buf = new byte[s.Length];
                    int read = 0;
                    while (read < buf.Length) read += s.Read(buf, read, buf.Length - read);
                    asm = Assembly.Load(buf);
                    loaded[name] = asm;
                    return asm;
                }
            }
        }

        public static Stream Resource(string name)
        {
            return Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        }
    }

    static class WebViewRuntime
    {
        public static bool EnsureAvailable()
        {
            // Extract the matching native WebView2 loader (embedded) to the data folder.
            string arch = (Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "AMD64").ToUpperInvariant();
            string folder = arch == "ARM64" ? "arm64" : (Environment.Is64BitProcess ? "x64" : "x86");
            string dir = Path.Combine(Program.DataDir, "runtime", Program.Version, folder);
            string dll = Path.Combine(dir, "WebView2Loader.dll");
            try
            {
                using (var s = Program.Resource("native/" + folder + "/WebView2Loader.dll"))
                {
                    if (s == null) throw new Exception("Embedded loader missing for " + folder);
                    if (!File.Exists(dll) || new FileInfo(dll).Length != s.Length)
                    {
                        Directory.CreateDirectory(dir);
                        string tmp = dll + "." + Guid.NewGuid().ToString("N") + ".tmp";
                        using (var f = File.Create(tmp)) s.CopyTo(f);
                        try { if (File.Exists(dll)) File.Delete(dll); File.Move(tmp, dll); }
                        catch { try { File.Delete(tmp); } catch { } }
                    }
                }
                SetLoaderPath(dir);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Emdedown could not start:\n\n" + ex.Message, "Emdedown", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }

            string version = null;
            try { version = GetVersion(); } catch { }
            if (string.IsNullOrEmpty(version))
            {
                var r = MessageBox.Show(
                    "Emdedown needs the Microsoft Edge WebView2 Runtime, which is part of Windows 10/11 but seems to be missing on this PC.\n\nOpen Microsoft's download page now? (It's free and takes a minute.)",
                    "Emdedown", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                if (r == DialogResult.Yes)
                {
                    try { System.Diagnostics.Process.Start("https://developer.microsoft.com/microsoft-edge/webview2/#download"); } catch { }
                }
                return false;
            }
            return true;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        static void SetLoaderPath(string dir)
        {
            Microsoft.Web.WebView2.Core.CoreWebView2Environment.SetLoaderDllFolderPath(dir);
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        static string GetVersion()
        {
            return Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString();
        }
    }
}
