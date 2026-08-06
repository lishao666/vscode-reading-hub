param([Parameter(Mandatory = $true)][string]$InputPath)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

$asTaskMethods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
}

function Await-WinRt([object]$Operation, [Type]$ResultType) {
  $method = $asTaskMethods | Select-Object -First 1
  $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}

$language = New-Object Windows.Globalization.Language("zh-Hans")
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if ($null -eq $engine) { throw "Windows OCR 不可用，请在系统语言设置中安装中文简体语言功能" }

$files = if (Test-Path -LiteralPath $InputPath -PathType Container) {
  Get-ChildItem -LiteralPath $InputPath -Filter "*.png" -File | Sort-Object Name
} else {
  Get-Item -LiteralPath $InputPath
}

foreach ($file in $files) {
  $storageFile = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($file.FullName)) ([Windows.Storage.StorageFile])
  $stream = Await-WinRt ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    try {
      $result = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      $text = (($result.Lines | ForEach-Object { $_.Text }) -join "") -replace "[\r\n\t]", " "
      if (-not [string]::IsNullOrWhiteSpace($text)) {
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        Write-Output (([IO.Path]::GetFileNameWithoutExtension($file.Name)) + "`t" + $text.Trim())
      }
    } finally {
      if ($null -ne $bitmap) { $bitmap.Dispose() }
    }
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }
}
