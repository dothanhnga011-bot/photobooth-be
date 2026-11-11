param(
  [Parameter(Mandatory=$true)][string]$PrinterName,
  [Parameter(Mandatory=$true)][string]$Manifest,
  # on = khung nhỏ: máy DNP cắt đôi tờ 1200 x 1800 thành 2 dải 5 x 15 cm ("2inch cut" chỉ cho lệnh này);
  # off = khung to: in nguyên tờ 10 x 15; keep = giữ cài đặt sẵn của hàng in.
  [ValidateSet('on', 'off', 'keep')][string]$Cut = 'keep',
  [string]$OutputSettingsPath = ''
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

# Output compensation belongs to the printer only; camera files and QR downloads stay untouched.
# sharpen: độ nét bản in 0–4 (0 = không làm nét); cấu hình cũ chưa có thì dùng mức 2.
function ConvertTo-Rx1Sharpen($value) {
  if ($null -eq $value -or $value -is [bool] -or $value -is [string]) { throw 'sharpen must be a whole number from 0 to 4' }
  $number = [double]$value
  if ([double]::IsNaN($number) -or $number -ne [Math]::Floor($number) -or $number -lt 0 -or $number -gt 4) {
    throw 'sharpen must be a whole number from 0 to 4'
  }
  return [int]$number
}
function Get-Rx1OutputSettings([string]$settingsPath = (Join-Path $env:LOCALAPPDATA 'NXC-Printer\rx1-output.json')) {
  $defaults = @{ gamma = 1.50; maxResolution = $true; sharpen = 2; warning = '' }
  if (-not (Test-Path -LiteralPath $settingsPath)) { return $defaults }
  try {
    $profile = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $gammaValue = $defaults.gamma
    $maximum = $true
    $sharpen = $defaults.sharpen
    if ($null -ne $profile.PSObject.Properties['gamma']) {
      if ($profile.gamma -is [bool]) { throw 'gamma must be a number' }
      $gammaValue = [double]$profile.gamma
    }
    if ([double]::IsNaN($gammaValue) -or [double]::IsInfinity($gammaValue) -or $gammaValue -lt 1.00 -or $gammaValue -gt 2.20) { throw 'gamma must be between 1.00 and 2.20' }
    if ($null -ne $profile.PSObject.Properties['maxResolution']) {
      if ($profile.maxResolution -isnot [bool]) { throw 'maxResolution must be true or false' }
      $maximum = $profile.maxResolution
    }
    if ($null -ne $profile.PSObject.Properties['sharpen']) { $sharpen = ConvertTo-Rx1Sharpen $profile.sharpen }
    return @{ gamma = $gammaValue; maxResolution = $maximum; sharpen = $sharpen; warning = '' }
  } catch {
    $defaults.warning = "Invalid rx1-output.json; using gamma $($defaults.gamma) and maximum supported DPI, sharpness $($defaults.sharpen): $($_.Exception.Message)"
    return $defaults
  }
}

# ── Tờ in đúng lưới điểm của máy in + làm nét cho in nhiệt ──────────────────────────────────────────
# Tờ in (vd. 2400 × 3600) được co MỘT lần bằng Lanczos3 (bộ lọc giữ chi tiết sắc nhất; dự phòng: bicubic
# của GDI+) về đúng số điểm thật của trang máy in ở độ phân giải đang dùng (300 × 300 dpi: ~1240 × 1845;
# 300 × 600: ~1240 × 3690) rồi vẽ 1:1, để driver DNP không phải co giãn nữa (co giãn của driver làm ảnh mềm /
# răng cưa). Sau đó làm nét trên độ sáng (unsharp mask: không đổi màu, bỏ qua chênh lệch rất nhỏ để không
# làm nổi hạt) vì mực in nhiệt loang nhẹ trên giấy. Mức 0 = không làm nét. Khi máy chụp gửi kèm vị trí các ô
# ảnh, phần ảnh được làm nét đủ mức, chữ / khung chỉ một nửa (không bị quầng sáng quanh nét chữ).
function Get-Rx1SharpenAmount([int]$level) {
  return @(0.0, 0.35, 0.6, 0.9, 1.25)[[Math]::Max(0, [Math]::Min(4, $level))]
}
function Initialize-Rx1Sharpen {
  if ('NxcRx1Sharpen' -as [type]) { return $true }
  if ($script:Rx1SharpenError) { return $false }
  try {
    Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class NxcRx1Sharpen {
  // amounts: một mức cho cả tờ, hoặc nhiều mức cho các dải dọc bằng nhau (tờ in thử độ nét).
  // sigmaX / sigmaY: bán kính làm mờ tính bằng điểm của máy in từng chiều (điểm có thể không vuông).
  // photos: các ô ảnh (x0, y0, x1, y1 theo điểm của trang); có thì ngoài ô ảnh chỉ làm nét outside × mức.
  public static void Apply(Bitmap image, double[] amounts, double sigmaX, double sigmaY, int threshold, int[] photos, double outside) {
    int w = image.Width, h = image.Height, bands = amounts.Length;
    bool[] inPhoto = null;
    if (photos != null && photos.Length >= 4) {
      inPhoto = new bool[w * h];
      for (int i = 0; i + 3 < photos.Length; i += 4) {
        int x0 = Math.Max(0, photos[i]), y0 = Math.Max(0, photos[i + 1]);
        int x1 = Math.Min(w, photos[i + 2]), y1 = Math.Min(h, photos[i + 3]);
        for (int r = y0; r < y1; r++) for (int c = x0; c < x1; c++) inPhoto[r * w + c] = true;
      }
    }
    BitmapData data = image.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
    try {
      int stride = data.Stride;
      byte[] px = new byte[stride * h];
      Marshal.Copy(data.Scan0, px, 0, px.Length);
      float[] luma = new float[w * h];
      for (int r = 0; r < h; r++) {
        int o = r * stride;
        for (int c = 0; c < w; c++, o += 4) luma[r * w + c] = 0.114f * px[o] + 0.587f * px[o + 1] + 0.299f * px[o + 2];
      }
      float[] blurred = Blur(luma, w, h, sigmaX, sigmaY);
      for (int r = 0; r < h; r++) {
        int o = r * stride;
        for (int c = 0; c < w; c++, o += 4) {
          double amount = amounts[bands == 1 ? 0 : Math.Min(bands - 1, (int)((long)c * bands / w))];
          if (inPhoto != null && !inPhoto[r * w + c]) amount *= outside;
          if (amount <= 0) continue;
          float diff = luma[r * w + c] - blurred[r * w + c];
          if (Math.Abs(diff) <= threshold) continue;
          float delta = (float)(amount * diff);
          px[o] = Clamp(px[o] + delta);
          px[o + 1] = Clamp(px[o + 1] + delta);
          px[o + 2] = Clamp(px[o + 2] + delta);
        }
      }
      Marshal.Copy(px, 0, data.Scan0, px.Length);
    } finally { image.UnlockBits(data); }
  }
  static byte Clamp(float value) { return value <= 0 ? (byte)0 : value >= 255 ? (byte)255 : (byte)(value + 0.5f); }
  // Co / giãn bằng Lanczos3 (tách hai chiều; khi thu nhỏ, bộ lọc nới theo tỉ lệ để không răng cưa) phần
  // (srcX, srcY, srcW, srcH) của ảnh nguồn về đúng width × height điểm; bù gamma trên ảnh nguồn như GDI+.
  public static Bitmap Resample(Bitmap source, int width, int height, double srcX, double srcY, double srcW, double srcH, double gamma) {
    int sw = source.Width, sh = source.Height;
    float[] lut = new float[256];
    for (int v = 0; v < 256; v++) lut[v] = (float)(255.0 * Math.Pow(v / 255.0, gamma));
    int[][] xi, yi; float[][] xw, yw;
    Contributions(width, sw, srcX, srcW, out xi, out xw);
    Contributions(height, sh, srcY, srcH, out yi, out yw);
    int rowMin = sh - 1, rowMax = 0;
    foreach (int[] list in yi) foreach (int r in list) { if (r < rowMin) rowMin = r; if (r > rowMax) rowMax = r; }
    float[] across = new float[(rowMax - rowMin + 1) * width * 3];
    BitmapData data = source.LockBits(new Rectangle(0, 0, sw, sh), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      byte[] line = new byte[data.Stride];
      for (int r = rowMin; r <= rowMax; r++) {
        Marshal.Copy(new IntPtr(data.Scan0.ToInt64() + (long)r * data.Stride), line, 0, line.Length);
        int o = (r - rowMin) * width * 3;
        for (int c = 0; c < width; c++) {
          int[] idx = xi[c]; float[] wt = xw[c];
          float b = 0, g = 0, red = 0;
          for (int k = 0; k < idx.Length; k++) {
            int p = idx[k] * 4;
            b += wt[k] * lut[line[p]]; g += wt[k] * lut[line[p + 1]]; red += wt[k] * lut[line[p + 2]];
          }
          across[o + c * 3] = b; across[o + c * 3 + 1] = g; across[o + c * 3 + 2] = red;
        }
      }
    } finally { source.UnlockBits(data); }
    Bitmap result = new Bitmap(width, height, PixelFormat.Format32bppArgb);
    BitmapData output = result.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    try {
      byte[] row = new byte[output.Stride];
      for (int r = 0; r < height; r++) {
        int[] idx = yi[r]; float[] wt = yw[r];
        for (int c = 0; c < width; c++) {
          float b = 0, g = 0, red = 0;
          for (int k = 0; k < idx.Length; k++) {
            int o = ((idx[k] - rowMin) * width + c) * 3;
            b += wt[k] * across[o]; g += wt[k] * across[o + 1]; red += wt[k] * across[o + 2];
          }
          int p = c * 4;
          row[p] = Clamp(b); row[p + 1] = Clamp(g); row[p + 2] = Clamp(red); row[p + 3] = 255;
        }
        Marshal.Copy(row, 0, new IntPtr(output.Scan0.ToInt64() + (long)r * output.Stride), row.Length);
      }
    } finally { result.UnlockBits(output); }
    return result;
  }
  static double Sinc(double x) { if (Math.Abs(x) < 1e-9) return 1; x *= Math.PI; return Math.Sin(x) / x; }
  static double Lanczos3(double x) { return Math.Abs(x) < 3 ? Sinc(x) * Sinc(x / 3) : 0; }
  // Trọng số của các điểm nguồn (lặp điểm ở mép ảnh) cho từng điểm đích; tổng trọng số = 1.
  static void Contributions(int outSize, int inSize, double start, double span, out int[][] index, out float[][] weight) {
    double scale = span / outSize, filter = Math.Max(1.0, scale), support = 3 * filter;
    index = new int[outSize][]; weight = new float[outSize][];
    for (int i = 0; i < outSize; i++) {
      double center = start + (i + 0.5) * scale;
      int lo = (int)Math.Floor(center - support), n = (int)Math.Ceiling(center + support) - lo + 1;
      int[] idx = new int[n]; double[] w = new double[n]; double sum = 0;
      for (int k = 0; k < n; k++) {
        w[k] = Lanczos3((lo + k + 0.5 - center) / filter); sum += w[k];
        idx[k] = Math.Min(inSize - 1, Math.Max(0, lo + k));
      }
      float[] wf = new float[n];
      for (int k = 0; k < n; k++) wf[k] = (float)(w[k] / sum);
      index[i] = idx; weight[i] = wf;
    }
  }
  static float[] Kernel(double sigma) {
    if (sigma < 0.05) return new float[] { 1f };
    int radius = Math.Max(1, (int)Math.Ceiling(sigma * 3));
    float[] k = new float[radius * 2 + 1];
    double sum = 0;
    for (int i = -radius; i <= radius; i++) { double v = Math.Exp(-(i * i) / (2 * sigma * sigma)); k[i + radius] = (float)v; sum += v; }
    for (int i = 0; i < k.Length; i++) k[i] = (float)(k[i] / sum);
    return k;
  }
  static float[] Blur(float[] source, int w, int h, double sigmaX, double sigmaY) {
    float[] kx = Kernel(sigmaX), ky = Kernel(sigmaY);
    int rx = kx.Length / 2, ry = ky.Length / 2;
    float[] across = new float[w * h], result = new float[w * h];
    for (int r = 0; r < h; r++)
      for (int c = 0; c < w; c++) {
        float s = 0;
        for (int i = -rx; i <= rx; i++) { int x = Math.Min(w - 1, Math.Max(0, c + i)); s += kx[i + rx] * source[r * w + x]; }
        across[r * w + c] = s;
      }
    for (int r = 0; r < h; r++)
      for (int c = 0; c < w; c++) {
        float s = 0;
        for (int i = -ry; i <= ry; i++) { int y = Math.Min(h - 1, Math.Max(0, r + i)); s += ky[i + ry] * across[y * w + c]; }
        result[r * w + c] = s;
      }
    return result;
  }
}
'@
    return $true
  } catch {
    $script:Rx1SharpenError = $_.Exception.Message
    return $false
  }
}
# Nhãn của tờ in thử: vạch trắng giữa 5 dải, số mức 0–4 ở đầu mỗi dải (mức đang dùng: ô đậm), một
# dòng hướng dẫn ở cuối tờ. Chữ đặt lùi vào trong, tránh phần tràn lề bị máy xén.
function Add-Rx1TestLabels([Drawing.Bitmap]$bitmap, [int]$current) {
  $g = [Drawing.Graphics]::FromImage($bitmap)
  $white = New-Object Drawing.SolidBrush([Drawing.Color]::White)
  $ink = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(255, 45, 30, 24))
  $font = New-Object Drawing.Font('Arial', 22, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Point)
  $small = New-Object Drawing.Font('Arial', 8, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Point)
  $center = New-Object Drawing.StringFormat
  try {
    $center.Alignment = [Drawing.StringAlignment]::Center
    $center.LineAlignment = [Drawing.StringAlignment]::Center
    $g.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $dpiX = [double]$bitmap.HorizontalResolution; $dpiY = [double]$bitmap.VerticalResolution
    $band = $bitmap.Width / 5
    $line = [Math]::Max(1.0, $dpiX / 150)
    for ($i = 1; $i -lt 5; $i++) { $g.FillRectangle($white, [single]($i * $band - $line / 2), [single]0, [single]$line, [single]$bitmap.Height) }
    for ($i = 0; $i -lt 5; $i++) {
      $box = New-Object Drawing.RectangleF([single]($i * $band + $band * 0.2), [single](0.22 * $dpiY), [single]($band * 0.6), [single](0.42 * $dpiY))
      $fill = if ($i -eq $current) { $ink } else { $white }
      $text = if ($i -eq $current) { $white } else { $ink }
      $g.FillRectangle($fill, $box)
      $g.DrawString([string]$i, $font, $text, $box, $center)
    }
    $caption = New-Object Drawing.RectangleF([single]0, [single]($bitmap.Height - 0.5 * $dpiY), [single]$bitmap.Width, [single](0.26 * $dpiY))
    $g.FillRectangle($white, $caption)
    $g.DrawString('In thử độ nét 0 → 4 · ô đậm: mức đang dùng', $small, $ink, $caption, $center)
  } finally { $center.Dispose(); $small.Dispose(); $font.Dispose(); $ink.Dispose(); $white.Dispose(); $g.Dispose() }
}
# Một trang in đúng lưới điểm của máy in: tờ in phủ kín trang (giữ tỉ lệ, căn giữa; phần tràn lề máy xén
# như cũ), co bằng Lanczos3, bù gamma, rồi làm nét. $pageWidth / $pageHeight: PageBounds (1/100 inch);
# $dpiX / $dpiY: độ phân giải máy in. $testCurrent ≥ 0: tờ in thử — 5 dải độ nét 0–4, dải mức đang dùng có
# nhãn đậm. $photos: các ô ảnh trên tờ in (x, y, rộng, cao theo tỉ lệ 0–1 của tờ, nối tiếp nhau).
function New-Rx1PageBitmap([Drawing.Image]$photo, [double]$pageWidth, [double]$pageHeight, [double]$dpiX, [double]$dpiY,
    [double]$gamma, [int]$sharpen, [int]$testCurrent = -1, [double[]]$photos = @()) {
  $width = [Math]::Max(1, [int][Math]::Round($pageWidth * $dpiX / 100))
  $height = [Math]::Max(1, [int][Math]::Round($pageHeight * $dpiY / 100))
  # Phủ kín trang theo inch (điểm của máy in có thể không vuông), giữ tỉ lệ tờ in, căn giữa.
  $inch = [Math]::Max(($pageWidth / 100) / $photo.Width, ($pageHeight / 100) / $photo.Height)
  $w = $photo.Width * $inch * $dpiX; $h = $photo.Height * $inch * $dpiY
  $left = ($width - $w) / 2; $top = ($height - $h) / 2
  $bitmap = $null
  $done = $false
  try {
    if (Initialize-Rx1Sharpen) {
      # Vùng ảnh nguồn thấy được trên trang (phần tràn lề ngoài trang bị cắt).
      $kx = $photo.Width / $w; $ky = $photo.Height / $h
      $bitmap = [NxcRx1Sharpen]::Resample([Drawing.Bitmap]$photo, $width, $height, -$left * $kx, -$top * $ky, $width * $kx, $height * $ky, $gamma)
      $script:Rx1Resampler = 'lanczos3'
    } else {
      $bitmap = New-Object Drawing.Bitmap($width, $height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $g = [Drawing.Graphics]::FromImage($bitmap)
      try {
        $g.Clear([Drawing.Color]::White)
        $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
        $dest = New-Object Drawing.Rectangle([int][Math]::Round($left)), ([int][Math]::Round($top)), ([int][Math]::Ceiling($w)), ([int][Math]::Ceiling($h))
        $attrs = New-Rx1ImageAttributes $gamma
        try { $g.DrawImage($photo, $dest, 0, 0, $photo.Width, $photo.Height, [Drawing.GraphicsUnit]::Pixel, $attrs) }
        finally { $attrs.Dispose() }
      } finally { $g.Dispose() }
      $script:Rx1Resampler = 'gdi-bicubic'
    }
    $bitmap.SetResolution([single]$dpiX, [single]$dpiY)
    $amounts = if ($testCurrent -ge 0) { @(0..4 | ForEach-Object { Get-Rx1SharpenAmount $_ }) } else { @(Get-Rx1SharpenAmount $sharpen) }
    if (@($amounts | Where-Object { $_ -gt 0 }).Count) {
      # Ô ảnh theo điểm của trang (làm tròn ra ngoài).
      $rects = New-Object 'System.Collections.Generic.List[int]'
      for ($i = 0; $i + 3 -lt $photos.Count; $i += 4) {
        $rects.Add([int][Math]::Floor($left + $photos[$i] * $w)); $rects.Add([int][Math]::Floor($top + $photos[$i + 1] * $h))
        $rects.Add([int][Math]::Ceiling($left + ($photos[$i] + $photos[$i + 2]) * $w)); $rects.Add([int][Math]::Ceiling($top + ($photos[$i + 1] + $photos[$i + 3]) * $h))
      }
      if (Initialize-Rx1Sharpen) { [NxcRx1Sharpen]::Apply($bitmap, [double[]]$amounts, 0.7 * $dpiX / 300, 0.7 * $dpiY / 300, 2, $rects.ToArray(), 0.5) }
      elseif ($testCurrent -ge 0) { throw "Máy này không làm nét được ảnh: $($script:Rx1SharpenError)" }
    }
    if ($testCurrent -ge 0) { Add-Rx1TestLabels $bitmap $testCurrent }
    $done = $true
    return $bitmap
  } finally { if (-not $done -and $bitmap) { $bitmap.Dispose() } }
}
# Vẽ một tờ in lên trang của máy in: đúng lưới điểm, 1:1 (điểm ảnh = điểm máy in, driver không co giãn).
# Trả về kích thước lưới "rộng x cao" để ghi nhật ký.
function Write-Rx1Page($event, [Drawing.Image]$photo, [double]$gamma, [int]$sharpen, [int]$testCurrent = -1, [double[]]$photos = @()) {
  # Tờ khác chiều với trang của máy in (vd. tờ ngang trên trang dọc): xoay 90 độ (chiều kim đồng hồ) cho kín
  # khổ, ô ảnh xoay theo: (x, y, rộng, cao) → (1 - y - cao, x, cao, rộng).
  $pageLandscape = $event.PageBounds.Width -gt $event.PageBounds.Height
  if (($photo.Width -gt $photo.Height) -ne $pageLandscape) {
    $photo.RotateFlip([Drawing.RotateFlipType]::Rotate90FlipNone)
    $turned = New-Object 'System.Collections.Generic.List[double]'
    for ($i = 0; $i + 3 -lt $photos.Count; $i += 4) {
      $turned.Add(1 - $photos[$i + 1] - $photos[$i + 3]); $turned.Add($photos[$i]); $turned.Add($photos[$i + 3]); $turned.Add($photos[$i + 2])
    }
    $photos = $turned.ToArray()
  }
  $g = $event.Graphics
  $dpiX = [double]$g.DpiX; $dpiY = [double]$g.DpiY
  $page = New-Rx1PageBitmap $photo $event.PageBounds.Width $event.PageBounds.Height $dpiX $dpiY $gamma $sharpen $testCurrent $photos
  try {
    $g.ResetTransform()
    $g.PageUnit = [Drawing.GraphicsUnit]::Pixel
    $g.TranslateTransform([single](-$event.PageSettings.HardMarginX * $dpiX / 100), [single](-$event.PageSettings.HardMarginY * $dpiY / 100))
    $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::Half
    $g.DrawImage($page, (New-Object Drawing.Rectangle(0, 0, $page.Width, $page.Height)), 0, 0, $page.Width, $page.Height, [Drawing.GraphicsUnit]::Pixel)
    return ('{0}x{1}' -f $page.Width, $page.Height)
  } finally { $page.Dispose() }
}
function Set-Rx1MaximumResolution($settings, $page) {
  # Use only positive DPI pairs advertised by this driver; never invent a 600 DPI mode.
  $current = $page.PrinterResolution
  try {
    $best = @($settings.PrinterResolutions | Where-Object { $_.X -gt 0 -and $_.Y -gt 0 } |
      Sort-Object @{ Expression = { [long]$_.X * $_.Y }; Descending = $true }, @{ Expression = { $_.X }; Descending = $true } |
      Select-Object -First 1)
    if ($best.Count -and ([long]$best[0].X * $best[0].Y -gt [long]$current.X * $current.Y -or $current.X -le 0 -or $current.Y -le 0)) {
      $page.PrinterResolution = $best[0]
    }
  } catch { $page.PrinterResolution = $current }
}
function New-Rx1ImageAttributes([double]$gamma) {
  $attributes = New-Object System.Drawing.Imaging.ImageAttributes
  $attributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
  # Gamma > 1 darkens midtones while pure white/black stay white/black.
  # Apply exactly once at DrawImage, before Windows/driver ICM.
  if ([Math]::Abs($gamma - 1.0) -gt 0.00001) { $attributes.SetGamma([single]$gamma) }
  return $attributes
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
$outputSettings = if ($OutputSettingsPath) { Get-Rx1OutputSettings $OutputSettingsPath } else { Get-Rx1OutputSettings }
if ($outputSettings.warning) { Write-Output $outputSettings.warning }
if ($outputSettings.maxResolution) { Set-Rx1MaximumResolution $document.PrinterSettings $document.DefaultPageSettings }
$script:printGamma = $outputSettings.gamma
$script:printSharpen = $outputSettings.sharpen
$script:pageIndex = 0
$document.add_PrintPage({
  param($sender, $event)
  $photo = [System.Drawing.Image]::FromFile($pages[$script:pageIndex], $true)
  # Đúng lưới điểm của máy in, vẽ 1:1, bù gamma và làm nét (xem New-Rx1PageBitmap).
  try { [void](Write-Rx1Page $event $photo $script:printGamma $script:printSharpen) }
  finally { $photo.Dispose() }
  $script:pageIndex++
  $event.HasMorePages = $script:pageIndex -lt $pages.Count
})
try { $document.Print() } finally { $document.Dispose() }
if ($script:Rx1SharpenError) { Write-Output "Printed without sharpening (cannot compile the sharpening filter): $($script:Rx1SharpenError)" }
