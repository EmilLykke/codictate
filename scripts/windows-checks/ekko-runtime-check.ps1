# Windows check for the Danish models map (issue #72).
# Does onnxruntime-node (ekko-pnc) and sherpa-onnx-offline (ekko-v1-tiny) run on
# Windows x64 under the Bun Codictate ships (Electrobun 1.18.1 -> Bun 1.3.13 baseline)?
#
# Run from a PowerShell prompt:
#   powershell -ExecutionPolicy Bypass -File scripts\windows-checks\ekko-runtime-check.ps1
# Optional: -Wav C:\path\to\real-danish-16k-mono.wav   -WorkDir C:\somewhere
#
# Everything lands in $WorkDir; the summary is written to $WorkDir\report.md.

param(
	[string]$WorkDir = (Join-Path $env:TEMP "ekko-win-check"),
	[string]$Wav = (Join-Path $PSScriptRoot "da-sample.wav"),
	[int]$Runs = 10,
	[int]$Iterations = 200
)

# Continue, not Stop: Windows PowerShell 5.1 turns native stderr under 2>&1 into terminating errors.
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

$BunVersion = "1.3.13"
$SherpaVersion = "1.13.8"
$SherpaAsset = "sherpa-onnx-v$SherpaVersion-win-x64-static-MT-Release-no-tts"
$PncRepo = "https://huggingface.co/RyeAI/ekko-pnc/resolve/main"
$TinyRepo = "https://huggingface.co/RyeAI/ekko-v1-tiny/resolve/main/onnx-sherpa"

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$Report = Join-Path $WorkDir "report.md"
Set-Content -Path $Report -Value "# ekko Windows runtime check`n`n$(Get-Date -Format s)`n"
function Log([string]$line) { Write-Host $line; Add-Content -Path $Report -Value $line }

function Fetch([string]$url, [string]$dest) {
	if (-not (Test-Path $dest)) {
		Write-Host "downloading $url"
		Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -ErrorAction Stop
	}
}

# --- Bun -------------------------------------------------------------------
# Prefer the exact bun.exe an Electrobun dev build bundles, if this runs from a checkout.
$RepoBun = Join-Path $PSScriptRoot "..\..\node_modules\electrobun\dist-win-x64\bun.exe"
if (Test-Path $RepoBun) {
	$Bun = (Resolve-Path $RepoBun).Path
	$BunSource = "Electrobun dist-win-x64"
} else {
	$BunZip = Join-Path $WorkDir "bun-windows-x64-baseline.zip"
	Fetch "https://github.com/oven-sh/bun/releases/download/bun-v$BunVersion/bun-windows-x64-baseline.zip" $BunZip
	Expand-Archive -Path $BunZip -DestinationPath $WorkDir -Force
	$Bun = Join-Path $WorkDir "bun-windows-x64-baseline\bun.exe"
	$BunSource = "GitHub release bun-v$BunVersion baseline"
}
Log "## Environment`n"
Log "- OS: $((Get-CimInstance Win32_OperatingSystem).Caption) $((Get-CimInstance Win32_OperatingSystem).Version)"
Log "- CPU: $((Get-CimInstance Win32_Processor | Select-Object -First 1).Name)"
Log "- Bun: $(& $Bun --version) ($BunSource)"
Log "- Wav: $Wav`n"

# --- 1-2. ekko-pnc under Bun ------------------------------------------------
$Pnc = Join-Path $WorkDir "pnc-test"
New-Item -ItemType Directory -Force -Path $Pnc | Out-Null
Copy-Item (Join-Path $PSScriptRoot "pnc-loop.ts") $Pnc -Force
Push-Location $Pnc
try {
	if (-not (Test-Path "package.json")) { & $Bun init -y | Out-Null }
	& $Bun add onnxruntime-node@1.30.0 onnxruntime-web@1.30.0 @huggingface/tokenizers@0.2.0
	foreach ($f in "pnc.int8.onnx", "tokenizer.json", "tokenizer_config.json") { Fetch "$PncRepo/$f" (Join-Path $Pnc $f) }

	function Run-Pnc([string]$backend, [int]$runs, [string]$label) {
		Log "### $label`n"
		$crashes = 0
		for ($i = 1; $i -le $runs; $i++) {
			$out = & $Bun pnc-loop.ts $backend $Pnc $Iterations 2>&1 | Out-String
			$code = $LASTEXITCODE
			if ($code -ne 0) { $crashes++ }
			$json = ($out -split "`n" | Where-Object { $_ -like "{*" } | Select-Object -Last 1)
			Log "- run $i exit=$code $("$json".Trim())"
			if ($code -ne 0) { Log ('  ```' + "`n" + $out.Trim() + "`n" + '  ```') }
		}
		Log "`n$label crashes: $crashes / $runs`n"
	}

	Log "## ekko-pnc`n"
	Run-Pnc "node" $Runs "onnxruntime-node ($Runs x $Iterations inferences)"

	# Packaging question: does the CPU path need the ~40 MB of DirectML DLLs next to onnxruntime.dll?
	$OrtBin = Join-Path $Pnc "node_modules\onnxruntime-node\bin\napi-v6\win32\x64"
	Log "onnxruntime-node win32/x64 files: $((Get-ChildItem $OrtBin | ForEach-Object { "$($_.Name) ($([math]::Round($_.Length / 1MB, 1)) MB)" }) -join ', ')`n"
	$Aside = Join-Path $WorkDir "directml-aside"
	New-Item -ItemType Directory -Force -Path $Aside | Out-Null
	foreach ($dll in "DirectML.dll", "dxcompiler.dll", "dxil.dll") {
		if (Test-Path (Join-Path $OrtBin $dll)) { Move-Item (Join-Path $OrtBin $dll) $Aside -Force }
	}
	try { Run-Pnc "node" 2 "onnxruntime-node without DirectML.dll / dxcompiler.dll / dxil.dll" }
	finally { Get-ChildItem $Aside | Move-Item -Destination $OrtBin -Force }

	Run-Pnc "web" 3 "onnxruntime-web WASM, 1 thread (fallback candidate, no native addon)"
} finally { Pop-Location }

# --- 3-4. ekko-v1-tiny via sherpa-onnx-offline ------------------------------
Log "## ekko-v1-tiny (sherpa-onnx-offline $SherpaVersion, static MT)`n"
$Tiny = Join-Path $WorkDir "tiny-test"
New-Item -ItemType Directory -Force -Path $Tiny | Out-Null
$Tarball = Join-Path $Tiny "$SherpaAsset.tar.bz2"
Fetch "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$SherpaVersion/$SherpaAsset.tar.bz2" $Tarball
if (-not (Test-Path (Join-Path $Tiny $SherpaAsset))) { tar -xjf $Tarball -C $Tiny }
if (-not (Test-Path (Join-Path $Tiny "$SherpaAsset\bin\sherpa-onnx-offline.exe"))) { throw "tar could not extract $Tarball; extract it into $Tiny with 7-Zip and re-run" }
$SherpaBin = Join-Path $Tiny "$SherpaAsset\bin"
Log "bin/ contents: $((Get-ChildItem $SherpaBin | ForEach-Object { "$($_.Name) ($([math]::Round($_.Length / 1MB, 1)) MB)" }) -join ', ')`n"

# Prove which DLLs it needs: run the exe alone in an otherwise empty folder.
$Lonely = Join-Path $Tiny "exe-alone"
New-Item -ItemType Directory -Force -Path $Lonely | Out-Null
Copy-Item (Join-Path $SherpaBin "sherpa-onnx-offline.exe") $Lonely -Force
$Exe = Join-Path $Lonely "sherpa-onnx-offline.exe"

foreach ($f in "encoder.onnx", "decoder.onnx", "joiner.onnx", "encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt") {
	Fetch "$TinyRepo/$f" (Join-Path $Tiny $f)
}

foreach ($variant in @(@{ Name = "fp32"; Suffix = "" }, @{ Name = "int8"; Suffix = ".int8" })) {
	Log "### $($variant.Name)`n"
	for ($i = 1; $i -le 3; $i++) {
		$sw = [Diagnostics.Stopwatch]::StartNew()
		$out = & $Exe `
			"--encoder=$(Join-Path $Tiny "encoder$($variant.Suffix).onnx")" `
			"--decoder=$(Join-Path $Tiny "decoder$($variant.Suffix).onnx")" `
			"--joiner=$(Join-Path $Tiny "joiner$($variant.Suffix).onnx")" `
			"--tokens=$(Join-Path $Tiny "tokens.txt")" `
			"--model-type=nemo_transducer" `
			"$Wav" 2>&1 | Out-String
		$sw.Stop()
		$code = $LASTEXITCODE
		$elapsed = ($out -split "`n" | Where-Object { $_ -like "Elapsed seconds*" -or $_ -like "Real time factor*" }) -join " | "
		$text = if ($out -match '"text": "([^"]*)"') { $Matches[1] } else { "<no text>" }
		Log "- run $i exit=$code wall=$([math]::Round($sw.Elapsed.TotalSeconds, 2))s $($elapsed.Trim()) text=`"$text`""
		if ($code -ne 0) { Log ('  ```' + "`n" + $out.Trim() + "`n" + '  ```') }
	}
	Log ""
}

Log "Done. Paste report.md into the ticket: $Report"
