$ErrorActionPreference = 'Stop'
$documentPath = (Resolve-Path -LiteralPath 'docs/设计交付-2026-09-30/风沙全平台视频下载器-需求与设计说明书.docx').Path
$pdfPath = [IO.Path]::ChangeExtension($documentPath, '.pdf')
if (Get-Process WINWORD -ErrorAction SilentlyContinue) { throw '已有 Word 正在使用，跳过自动渲染以免干扰其他文档。' }
$word = $null
$document = $null
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $document = $word.Documents.Open($documentPath, $false, $true, $false)
    $document.ExportAsFixedFormat($pdfPath, 17)
    $pageCount = $document.ComputeStatistics(2)
    [PSCustomObject]@{ PDF = $pdfPath; Pages = $pageCount; Exists = (Test-Path -LiteralPath $pdfPath) } | ConvertTo-Json
} finally {
    if ($document) { $document.Close(0); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($document) }
    if ($word) { $word.Quit(0); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word) }
}
