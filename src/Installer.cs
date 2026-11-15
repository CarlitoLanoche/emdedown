using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Emdedown
{
    /// <summary>Per-user install (no admin): copies the exe, adds shortcuts, file associations and an "Apps" entry.</summary>
    static class Installer
    {
        const string ProgId = "Emdedown.md";
        static readonly string[] Exts = { ".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdx", ".mdwn" };
        const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Emdedown";

        public static string InstallDir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Emdedown"); }
        }
        public static string InstalledExe { get { return Path.Combine(InstallDir, "Emdedown.exe"); } }
        static string StartMenuLink { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Emdedown.lnk"); } }
        static string DesktopLink { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Emdedown.lnk"); } }

        public static bool IsInstalled { get { return File.Exists(InstalledExe); } }
        public static bool HasDesktopShortcut { get { return File.Exists(DesktopLink); } }

        /// <summary>Add or remove the desktop shortcut of the installed copy.</summary>
        public static void SetDesktopShortcut(bool on)
        {
            if (on) { if (!IsInstalled) throw new InvalidOperationException("Emdedown is not installed."); Shortcut(DesktopLink, InstalledExe); }
            else TryDelete(DesktopLink);
        }

        public static bool RunningInstalled
        {
            get { return string.Equals(Path.GetFullPath(Application.ExecutablePath), Path.GetFullPath(InstalledExe), StringComparison.OrdinalIgnoreCase); }
        }

        public static void Install(bool desktopShortcut)
        {
            Directory.CreateDirectory(InstallDir);
            if (!RunningInstalled)
            {
                try { File.Copy(Application.ExecutablePath, InstalledExe, true); }
                catch (IOException) { throw new IOException("The installed copy of Emdedown is in use. Close other Emdedown windows and try again."); }
            }
            Shortcut(StartMenuLink, InstalledExe);
            // The desktop shortcut is optional: the user picks it in the install dialog.
            if (desktopShortcut) Shortcut(DesktopLink, InstalledExe); else TryDelete(DesktopLink);
            Register(InstalledExe);

            using (var k = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                k.SetValue("DisplayName", "Emdedown");
                k.SetValue("DisplayVersion", Program.Version);
                k.SetValue("Publisher", "Emdedown");
                k.SetValue("DisplayIcon", InstalledExe + ",0");
                k.SetValue("InstallLocation", InstallDir);
                k.SetValue("UninstallString", "\"" + InstalledExe + "\" --uninstall");
                // No QuietUninstallString: --uninstall always asks for confirmation. Remove one left by older versions.
                k.DeleteValue("QuietUninstallString", false);
                k.SetValue("EstimatedSize", (int)(new FileInfo(InstalledExe).Length / 1024), RegistryValueKind.DWord);
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            }
            Native.SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
        }

        /// <summary>Registers Emdedown as a handler for Markdown files (shows in "Open with" and Default Apps).</summary>
        public static void Register(string exe)
        {
            string cmd = "\"" + exe + "\" \"%1\"";
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\" + ProgId))
            {
                k.SetValue("", "Markdown Document");
                k.SetValue("FriendlyTypeName", "Markdown Document");
                using (var i = k.CreateSubKey("DefaultIcon")) i.SetValue("", exe + ",0");
                using (var c = k.CreateSubKey(@"shell\open\command")) c.SetValue("", cmd);
                using (var c = k.CreateSubKey(@"shell\edit")) c.SetValue("", "Edit with Emdedown");
                using (var c = k.CreateSubKey(@"shell\edit\command")) c.SetValue("", "\"" + exe + "\" --edit \"%1\"");
            }
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Applications\Emdedown.exe"))
            {
                k.SetValue("FriendlyAppName", "Emdedown");
                using (var c = k.CreateSubKey(@"shell\open\command")) c.SetValue("", cmd);
                using (var s = k.CreateSubKey("SupportedTypes")) foreach (var e in Exts) s.SetValue(e, "");
                using (var i = k.CreateSubKey("DefaultIcon")) i.SetValue("", exe + ",0");
            }
            foreach (var e in Exts)
            {
                using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\" + e + @"\OpenWithProgids")) k.SetValue(ProgId, new byte[0], RegistryValueKind.None);
            }
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Emdedown\Capabilities"))
            {
                k.SetValue("ApplicationName", "Emdedown");
                k.SetValue("ApplicationDescription", "Fast, beautiful Markdown reader and editor");
                k.SetValue("ApplicationIcon", exe + ",0");
                using (var f = k.CreateSubKey("FileAssociations")) foreach (var e in Exts) f.SetValue(e, ProgId);
            }
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\RegisteredApplications")) k.SetValue("Emdedown", @"Software\Emdedown\Capabilities");
            Native.SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
        }

        /// <summary>The ProgId the user picked for .md in Explorer (hash-protected by Windows), or null if never picked.</summary>
        static string UserChoice()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice"))
                return k != null ? k.GetValue("ProgId") as string : null;
        }

        public static bool IsDefault
        {
            get
            {
                string c = UserChoice();
                if (c != null) return c == ProgId || c.EndsWith("Emdedown.exe", StringComparison.OrdinalIgnoreCase);
                using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Classes\.md"))
                    return k != null && (k.GetValue("") as string) == ProgId;
            }
        }

        /// <summary>
        /// Makes Emdedown the default .md app. Returns "set" when done, or "settings" after opening
        /// Settings > Default apps, where the user must make the change (Windows protects an existing UserChoice;
        /// pickers opened by an app hide "Always use this app" on Windows 10 — see docs/ARCHITECTURE.md §6.3).
        /// owner and docPath are unused (left over from the picker approach).
        /// When not installed, this registers the portable exe's current path; moving that exe breaks the association.
        /// </summary>
        public static string SetDefault(IntPtr owner, string docPath)
        {
            string exe = IsInstalled ? InstalledExe : Application.ExecutablePath;
            Register(exe);
            if (IsDefault) return "set";
            if (UserChoice() == null)
            {
                foreach (var e in Exts)
                    using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\" + e)) k.SetValue("", ProgId);
                Native.SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
                if (IsDefault) return "set";
            }
            // Another app was chosen before. Windows 10 only lets the user change that in Settings
            // (pickers opened by an app hide the "Always use this app" box), so open the Default apps page.
            try { Process.Start("ms-settings:defaultapps"); } catch { }
            return "settings";
        }

        public static void Uninstall()
        {
            // registry
            DeleteKey(@"Software\Classes\" + ProgId);
            DeleteKey(@"Software\Classes\Applications\Emdedown.exe");
            DeleteKey(@"Software\Emdedown");
            DeleteKey(UninstallKey);
            using (var k = Registry.CurrentUser.OpenSubKey(@"Software\RegisteredApplications", true)) if (k != null) k.DeleteValue("Emdedown", false);
            foreach (var e in Exts)
            {
                using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Classes\" + e + @"\OpenWithProgids", true)) if (k != null) k.DeleteValue(ProgId, false);
                using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Classes\" + e, true))
                    if (k != null && (k.GetValue("") as string) == ProgId) k.DeleteValue("", false);
            }
            Native.SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
            // shortcuts
            TryDelete(StartMenuLink);
            TryDelete(DesktopLink);
            // files: the running exe and the WebView2 data are locked until this process (and its browser processes) exit.
            // A hidden PowerShell waits for this process to exit however long that takes (e.g. while the "uninstalled"
            // message is still open), then retries the deletion for up to two minutes.
            Process.Start(CleanupAfterExit(Process.GetCurrentProcess().Id, new[] { InstallDir, Program.DataDir }));
        }

        static ProcessStartInfo CleanupAfterExit(int pid, string[] dirs)
        {
            var quoted = new List<string>();
            foreach (var d in dirs) quoted.Add("'" + d.Replace("'", "''") + "'");
            string ps =
                "$ErrorActionPreference = 'SilentlyContinue'\n" +
                "Wait-Process -Id " + pid + "\n" +
                "$dirs = @(" + string.Join(", ", quoted.ToArray()) + ")\n" +
                "for ($i = 0; $i -lt 120; $i++) {\n" +
                "  foreach ($d in $dirs) { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force } }\n" +
                "  if (-not ($dirs | Where-Object { Test-Path -LiteralPath $_ })) { break }\n" +
                "  Start-Sleep -Seconds 1\n" +
                "}\n";
            string encoded = Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes(ps));
            return new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"), "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand " + encoded)
            {
                CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden, WorkingDirectory = Path.GetTempPath()
            };
        }

        static void DeleteKey(string path) { try { Registry.CurrentUser.DeleteSubKeyTree(path, false); } catch { } }
        static void TryDelete(string f) { try { if (File.Exists(f)) File.Delete(f); } catch { } }

        static void Shortcut(string lnk, string target)
        {
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(t);
            try
            {
                object sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
                Type st = sc.GetType();
                st.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { target });
                st.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { Path.GetDirectoryName(target) });
                st.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { target + ",0" });
                st.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { "Markdown reader and editor" });
                st.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
                System.Runtime.InteropServices.Marshal.ReleaseComObject(sc);
            }
            finally { System.Runtime.InteropServices.Marshal.ReleaseComObject(shell); }
        }
    }
}
