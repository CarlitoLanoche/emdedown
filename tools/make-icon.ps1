# Generates src\app.ico (multi-size, PNG-compressed) using System.Drawing.
# The artwork matches samples\images\emdedown-logo.svg: a blue rounded square with a lowercase "md".
param([string]$Out = "$PSScriptRoot\..\src\app.ico")
Add-Type -AssemblyName System.Drawing

function New-RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function Render([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.PixelOffsetMode = 'HighQuality'
    $g.Clear([System.Drawing.Color]::Transparent)
    $s = $size / 64.0
    # Small sizes use the whole square and a heavier stroke so the letters stay readable.
    $small = $size -le 24
    $rect = if ($small) { New-RoundRect 0 0 $size $size (12 * $s) } else { New-RoundRect (4 * $s) (4 * $s) (56 * $s) (56 * $s) (14 * $s) }
    $blue = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 37, 99, 235))
    $g.FillPath($blue, $rect)

    # Lowercase "md" drawn as round-capped strokes on a 64 grid.
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ($(if ($small) { 6.5 } else { 5 }) * $s)
    $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
    function P([float]$x, [float]$y) { New-Object System.Drawing.PointF ($x * $s), ($y * $s) }
    $m = New-Object System.Drawing.Drawing2D.GraphicsPath
    $m.AddLine((P 14 43), (P 14 27))
    $m.StartFigure()
    $m.AddBezier((P 14 32), (P 14 25), (P 24 25), (P 24 32))
    $m.AddLine((P 24 32), (P 24 43))
    $m.StartFigure()
    $m.AddBezier((P 24 32), (P 24 25), (P 34 25), (P 34 32))
    $m.AddLine((P 34 32), (P 34 43))
    $m.StartFigure()
    $m.AddEllipse((38 * $s), (31 * $s), (12 * $s), (12 * $s))
    $m.StartFigure()
    $m.AddLine((P 50 19), (P 50 43))
    $g.DrawPath($pen, $m)
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return ,$ms.ToArray()
}

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$images = foreach ($sz in $sizes) { ,(Render $sz) }
$fs = [System.IO.File]::Create($Out)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $sz = $sizes[$i]; $data = $images[$i]
    $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz }))); $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))
    $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$data.Length); $bw.Write([UInt32]$offset)
    $offset += $data.Length
}
foreach ($d in $images) { $bw.Write($d) }
$bw.Close()
Write-Host "Wrote $Out"
