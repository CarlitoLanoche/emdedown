param([int]$Flags = 7)
$file = Join-Path $env:TEMP 'emdedown-probe.md'
Set-Content $file '# probe' -Encoding utf8
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class OW {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct OPENASINFO { public string f; public string c; public int flags; }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern int SHOpenWithDialog(IntPtr h, ref OPENASINFO i);
}
"@
$i = New-Object OW+OPENASINFO
$i.f = $file; $i.flags = $Flags
"hr=" + [OW]::SHOpenWithDialog([IntPtr]::Zero, [ref]$i)
