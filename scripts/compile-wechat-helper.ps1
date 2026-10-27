param([Parameter(Mandatory=$true)][string]$SourcePath,[Parameter(Mandatory=$true)][string]$TargetPath)
$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSHOME 'Microsoft.CodeAnalysis.dll')
Add-Type -Path (Join-Path $PSHOME 'Microsoft.CodeAnalysis.CSharp.dll')
$framework=Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319'
$references=[System.Collections.Generic.List[Microsoft.CodeAnalysis.MetadataReference]]::new()
foreach($name in @('mscorlib.dll','System.dll','System.Core.dll','System.Web.dll','System.Web.Extensions.dll','WPF/UIAutomationClient.dll','WPF/UIAutomationTypes.dll','WPF/WindowsBase.dll')){
 $references.Add([Microsoft.CodeAnalysis.MetadataReference]::CreateFromFile((Join-Path $framework $name)))
}
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$source=if($SourcePath -eq '-'){[Console]::In.ReadToEnd()}else{[IO.File]::ReadAllText($SourcePath)}
if($source.StartsWith('%TSD-Header')){throw 'Source is not readable in this compiler process; no executable was replaced'}
$tree=[Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText($source)
$options=[Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions]::new([Microsoft.CodeAnalysis.OutputKind]::ConsoleApplication)
$compilation=[Microsoft.CodeAnalysis.CSharp.CSharpCompilation]::Create('FengshaWeChatArticles',[Microsoft.CodeAnalysis.SyntaxTree[]]@($tree),$references,$options)
$stream=[IO.MemoryStream]::new()
try{
 $result=$compilation.Emit($stream)
 if(!$result.Success){throw (($result.Diagnostics | Select-Object -First 8 | ForEach-Object {$_.ToString()}) -join "`n")}
 $temporary=$TargetPath+'.building.exe'
 [IO.File]::WriteAllBytes($temporary,$stream.ToArray())
 [IO.File]::Move($temporary,$TargetPath,$true)
}finally{$stream.Dispose()}
