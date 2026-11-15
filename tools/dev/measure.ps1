# Measures Emdedown's process tree: memory and idle CPU.
param([int]$IdleSeconds = 10, [string]$Label = '')
$root = Get-Process Emdedown -ErrorAction Stop | Select-Object -First 1
$all = Get-CimInstance Win32_Process
function Kids($id) { $all | Where-Object { $_.ParentProcessId -eq $id } | ForEach-Object { $_.ProcessId; Kids $_.ProcessId } }
$ids = @($root.Id) + @(Kids $root.Id)
$procs = Get-Process -Id $ids -ErrorAction SilentlyContinue
$cpu0 = 0; foreach ($p in $procs) { $cpu0 += $p.TotalProcessorTime.TotalMilliseconds }
Start-Sleep $IdleSeconds
$procs = Get-Process -Id $ids -ErrorAction SilentlyContinue
$cpu1 = 0; foreach ($p in $procs) { $cpu1 += $p.TotalProcessorTime.TotalMilliseconds }
$rows = foreach ($p in $procs) {
  $cmd = ($all | Where-Object ProcessId -eq $p.Id).CommandLine
  $type = if ($p.Id -eq $root.Id) { 'host (C#)' } elseif ($cmd -match '--type=([\w-]+)') { $Matches[1] + $(if ($cmd -match '--utility-sub-type=([\w.]+)') { ' ' + ($Matches[1] -replace '\.mojom\..*','') }) } else { 'browser' }
  [pscustomobject]@{ Process = $type; WorkingSetMB = [math]::Round($p.WorkingSet64 / 1MB, 1); PrivateMB = [math]::Round($p.PrivateMemorySize64 / 1MB, 1) }
}
"== $Label =="
$rows | Sort-Object PrivateMB -Descending | Format-Table -AutoSize | Out-String -Width 200
"processes: {0}   total working set: {1:N0} MB   total private: {2:N0} MB   idle CPU: {3:N2}% of one core over {4}s" -f $procs.Count, (($rows | Measure-Object WorkingSetMB -Sum).Sum), (($rows | Measure-Object PrivateMB -Sum).Sum), (($cpu1 - $cpu0) / ($IdleSeconds * 10)), $IdleSeconds
