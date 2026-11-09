param(
  [Parameter(Mandatory=$true)][string]$PrinterName,
  [Parameter(Mandatory=$true)][string]$Manifest,
  # on = khung nhỏ: máy DNP cắt đôi tờ 1200 x 1800 thành 2 dải 5 x 15 cm ("2inch cut" chỉ cho lệnh này);
  # off = khung to: in nguyên tờ 10 x 15; keep = giữ cài đặt sẵn của hàng in.
  [ValidateSet('on', 'off', 'keep')][string]$Cut = 'keep'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$pages = @(Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json)
$document = New-Object System.Drawing.Printing.PrintDocument
$document.PrinterSettings.PrinterName = $PrinterName
if (-not $document.PrinterSettings.IsValid) { throw 'Configured printer is not installed.' }
$document.PrintController = New-Object System.Drawing.Printing.StandardPrintController

# Tuỳ chọn "2inch cut" (Enable / Disable) của driver DNP, đặt riêng cho lệnh in này qua PrintTicket →
# DEVMODE: không đổi cài đặt mặc định của hàng in, không cần hàng in thứ hai hay quyền quản trị.
function Set-CutForJob($document, [string]$queueName, [bool]$enable) {
  Add-Type -AssemblyName System.Printing, ReachFramework
  $psf = 'http://schemas.microsoft.com/windows/2003/08/printing/printschemaframework'
  $queue = (New-Object System.Printing.LocalPrintServer).GetPrintQueue($queueName)
  $caps = New-Object System.Xml.XmlDocument
  $caps.LoadXml((New-Object System.IO.StreamReader($queue.GetPrintCapabilitiesAsXml())).ReadToEnd())
  $ns = New-Object System.Xml.XmlNamespaceManager($caps.NameTable)
  $ns.AddNamespace('psf', $psf)
  $label = {
    param($node)
    $text = $node.GetAttribute('name')
    foreach ($child in $node.ChildNodes) {
      if ($child.LocalName -eq 'Property' -and $child.GetAttribute('name') -match 'DisplayName$') { $text += ' ' + $child.InnerText }
    }
    $text
  }
  foreach ($feature in $caps.SelectNodes('//psf:Feature', $ns)) {
    if ((& $label $feature) -notmatch '(?i)cut') { continue }
    foreach ($option in $feature.SelectNodes('psf:Option', $ns)) {
      $text = & $label $option
      $wanted = if ($enable) { $text -match '(?i)enable|2\s*-?\s*inch|\bon\b' } else { $text -match '(?i)disable|standard|normal|\boff\b' }
      if (-not $wanted -or -not $feature.GetAttribute('name').Contains(':') -or -not $option.GetAttribute('name').Contains(':')) { continue }
      $fPrefix, $fLocal = $feature.GetAttribute('name').Split(':', 2)
      $oPrefix, $oLocal = $option.GetAttribute('name').Split(':', 2)
      $xml = "<psf:PrintTicket xmlns:psf=`"$psf`" xmlns:f=`"$($feature.GetNamespaceOfPrefix($fPrefix))`" " +
        "xmlns:o=`"$($option.GetNamespaceOfPrefix($oPrefix))`" version=`"1`"><psf:Feature name=`"f:$fLocal`">" +
        "<psf:Option name=`"o:$oLocal`"/></psf:Feature></psf:PrintTicket>"
      $delta = New-Object System.Printing.PrintTicket(New-Object System.IO.MemoryStream(, [Text.Encoding]::UTF8.GetBytes($xml)))
      $ticket = $queue.MergeAndValidatePrintTicket($queue.UserPrintTicket, $delta).ValidatedPrintTicket
      $converter = New-Object System.Printing.Interop.PrintTicketConverter($queueName, $queue.ClientPrintSchemaVersion)
      try { $bytes = $converter.ConvertPrintTicketToDevMode($ticket, [System.Printing.Interop.BaseDevModeType]::UserDefault) }
      finally { $converter.Dispose() }
      $handle = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
      try {
        [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $handle, $bytes.Length)
        $document.PrinterSettings.SetHdevmode($handle)
        $document.DefaultPageSettings.SetHdevmode($handle)
      } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($handle) }
      return $true
    }
  }
  return $false
}
if ($Cut -ne 'keep') {
  # Không đặt được tuỳ chọn cắt thì vẫn in (theo cài đặt của hàng in) thay vì bỏ lệnh in của khách.
  try {
    if (-not (Set-CutForJob $document $PrinterName ($Cut -eq 'on'))) { Write-Output 'CUT:unsupported' }
    else { Write-Output "CUT:$Cut" }
  } catch { Write-Output "CUT:unsupported $($_.Exception.Message)" }
}

# DNP DS-RX1: giấy PR (4x6) = 4 x 6 inch (400 x 600 phần trăm inch); driver có thể khai báo dọc hoặc ngang.
# Khổ 4x6 có thể lớn hơn một chút vì phần tràn lề (DNP: vd. 4,13 x 6,15 inch); không thấy thì dùng khổ
# đang đặt sẵn của hàng in (driver DNP mặc định 4x6) thay vì bỏ lệnh in.
$paper = @($document.PrinterSettings.PaperSizes | Where-Object {
  $short = [Math]::Min($_.Width, $_.Height); $long = [Math]::Max($_.Width, $_.Height)
  $short -ge 380 -and $short -le 440 -and $long -ge 580 -and $long -le 650
}) | Sort-Object @{ Expression = { [bool]($_.PaperName -match 'x ?2|2x6|strip|cut') } },
  @{ Expression = { [Math]::Abs([Math]::Min($_.Width, $_.Height) - 400) + [Math]::Abs([Math]::Max($_.Width, $_.Height) - 600) } } |
  Select-Object -First 1
if ($paper) { $document.DefaultPageSettings.PaperSize = $paper }
$document.DefaultPageSettings.Landscape = $false
$document.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0,0,0,0)
$script:pageIndex = 0
$document.add_PrintPage({
  param($sender, $event)
  $photo = [System.Drawing.Image]::FromFile($pages[$script:pageIndex], $true)
  try {
    # Tờ khác chiều với trang của máy in (vd. tờ ngang 15 x 10 trên trang dọc) thì xoay 90 độ cho kín khổ.
    $pageLandscape = $event.PageBounds.Width -gt $event.PageBounds.Height
    if (($photo.Width -gt $photo.Height) -ne $pageLandscape) { $photo.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }
    $g = $event.Graphics
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.TranslateTransform(-$event.PageSettings.HardMarginX, -$event.PageSettings.HardMarginY)
    # Phủ kín trang mà giữ tỉ lệ (không kéo giãn méo), mép tràn lề máy xén như thường.
    $b = $event.PageBounds
    $scale = [Math]::Max($b.Width / $photo.Width, $b.Height / $photo.Height)
    $w = $photo.Width * $scale; $h = $photo.Height * $scale
    $dest = New-Object System.Drawing.Rectangle([int][Math]::Round($b.X + ($b.Width - $w) / 2)), ([int][Math]::Round($b.Y + ($b.Height - $h) / 2)), ([int][Math]::Ceiling($w)), ([int][Math]::Ceiling($h))
    $attrs = New-Object System.Drawing.Imaging.ImageAttributes
    $attrs.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    try { $g.DrawImage($photo, $dest, 0, 0, $photo.Width, $photo.Height, [System.Drawing.GraphicsUnit]::Pixel, $attrs) }
    finally { $attrs.Dispose() }
  } finally { $photo.Dispose() }
  $script:pageIndex++
  $event.HasMorePages = $script:pageIndex -lt $pages.Count
})
try { $document.Print() } finally { $document.Dispose() }
