#Requires -Version 5.1
<#
  gc-launcher.ps1 — the window behind "Start GC-4.bat".

  This is a front end for exactly one thing:

      node server/index.js --driver=... --port=... [flags]

  It exists because the people who launch GC-4 at the pad are not always the
  people who wrote it, and a command line typed from memory in the cold is a
  way to start the wrong driver against the wrong config. Every control below
  maps to one documented flag, the assembled command is shown verbatim before
  it runs, and the choices are remembered for next time — so the window is
  also how somebody learns what the flags are.

  Nothing here talks to the stand. It picks arguments and hands off to
  server/index.js, which stays the single authority on everything else.
#>
param([string]$Root)

$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = (Resolve-Path -LiteralPath $Root).Path

# Crisp text on the high-DPI laptops this runs on. Best effort: a shell that
# cannot reach the entry point just gets the blurry-but-working default.
try {
  Add-Type -Name Dpi -Namespace Gc -MemberDefinition `
    '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
  [void][Gc.Dpi]::SetProcessDPIAware()
} catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

function Show-Problem {
  param([string]$Text, [string]$Caption = 'ERPL GC-4', [string]$Icon = 'Warning')
  [void][System.Windows.Forms.MessageBox]::Show(
    $Text, $Caption,
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]$Icon)
}

# This script runs with its console hidden, so an error that reaches the top
# would otherwise be a double-click that does nothing at all. Say what broke,
# and say how to start the software without the launcher.
trap {
  Show-Problem @"
The launcher could not start.

$($_.Exception.Message)

GC-4 itself is unaffected. Open a terminal in this folder and run:

    node server\index.js
"@ 'ERPL GC-4' 'Error'
  exit 1
}

# ------------------------------------------------------------------ node ----

# Checked before the window opens: a launcher that collects ten settings and
# only then says "Node is not installed" has wasted the operator's time.
$node = Get-Command 'node.exe' -ErrorAction SilentlyContinue
if (-not $node) { $node = Get-Command 'node' -ErrorAction SilentlyContinue }
if (-not $node) {
  Show-Problem @"
Node.js was not found on this computer.

GC-4 runs on Node 18 or newer. Install it from https://nodejs.org (the LTS
build is fine), then double-click Start GC-4.bat again.
"@ 'ERPL GC-4 — Node.js required' 'Error'
  exit 1
}

$nodeVersion = ''
try { $nodeVersion = (& $node.Source --version 2>$null | Select-Object -First 1) } catch { }
if ($nodeVersion -match '^v(\d+)\.' -and [int]$Matches[1] -lt 18) {
  Show-Problem @"
Node $nodeVersion is too old — GC-4 needs Node 18 or newer.

Install a current release from https://nodejs.org and try again.
"@ 'ERPL GC-4 — Node.js too old' 'Error'
  exit 1
}

# -------------------------------------------------------------- settings ----

# Remembered between launches, because the same stand gets started the same
# way a hundred times. Untracked by git, and deliberately never holding a
# PIN — see the access controls further down.
$SettingsFile = Join-Path $Root 'config\launcher.settings.json'

$settings = @{
  driver         = 'simulator'
  port           = '8080'
  config         = 'config/stand.json'
  allowRemote    = $false
  bind           = '0.0.0.0'
  spectator      = $true
  spectatorPort  = ''
  udpHost        = '192.168.1.50'
  udpPort        = '5000'
  udpListenPort  = '5001'
  comPort        = ''
  baud           = '921600'
  hardwareConfig = ''
  pandaTap       = $false
  openBrowser    = $true
}

if (Test-Path -LiteralPath $SettingsFile) {
  try {
    $saved = Get-Content -LiteralPath $SettingsFile -Raw | ConvertFrom-Json
    foreach ($key in @($settings.Keys)) {
      $value = $saved.$key
      if ($null -eq $value) { continue }
      if ($settings[$key] -is [bool]) { $settings[$key] = [bool]$value }
      else { $settings[$key] = [string]$value }
    }
  } catch {
    # A corrupt settings file is never a reason not to launch.
  }
}

function Save-Settings {
  try {
    $settings | ConvertTo-Json | Set-Content -LiteralPath $SettingsFile -Encoding UTF8
  } catch { }
}

# --------------------------------------------------------------- helpers ----

$FONT      = New-Object System.Drawing.Font('Segoe UI', 9)
$FONT_BOLD = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$FONT_HEAD = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$FONT_NOTE = New-Object System.Drawing.Font('Segoe UI', 8)
$FONT_MONO = New-Object System.Drawing.Font('Consolas', 9)
$GREY      = [System.Drawing.Color]::FromArgb(110, 110, 110)
$WARN      = [System.Drawing.Color]::FromArgb(176, 74, 0)

function Add-Label {
  param($Parent, [string]$Text, [int]$X, [int]$Y, [int]$W, [int]$H = 19, $Font, $Color)
  $l = New-Object System.Windows.Forms.Label
  # Text is shown as written: a stand subtitle like "Vehicle & GSE" must not
  # lose its ampersand to a keyboard-mnemonic underline.
  $l.UseMnemonic = $false
  $l.Text = $Text
  $l.Location = New-Object System.Drawing.Point($X, $Y)
  $l.Size = New-Object System.Drawing.Size($W, $H)
  if ($Font) { $l.Font = $Font } else { $l.Font = $FONT }
  if ($Color) { $l.ForeColor = $Color }
  $Parent.Controls.Add($l)
  return $l
}

function Add-Note {
  param($Parent, [string]$Text, [int]$X, [int]$Y, [int]$W, [int]$H = 16)
  return (Add-Label -Parent $Parent -Text $Text -X $X -Y $Y -W $W -H $H -Font $FONT_NOTE -Color $GREY)
}

function Add-TextBox {
  param($Parent, [string]$Text, [int]$X, [int]$Y, [int]$W)
  $t = New-Object System.Windows.Forms.TextBox
  $t.Text = $Text
  $t.Location = New-Object System.Drawing.Point($X, $Y)
  $t.Size = New-Object System.Drawing.Size($W, 23)
  $t.Font = $FONT
  $Parent.Controls.Add($t)
  return $t
}

function Add-Combo {
  param($Parent, [string[]]$Items, [int]$X, [int]$Y, [int]$W, [string]$Style = 'DropDownList')
  $c = New-Object System.Windows.Forms.ComboBox
  $c.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]$Style
  $c.Location = New-Object System.Drawing.Point($X, $Y)
  $c.Size = New-Object System.Drawing.Size($W, 23)
  $c.Font = $FONT
  foreach ($i in $Items) { [void]$c.Items.Add($i) }
  $Parent.Controls.Add($c)
  return $c
}

function Add-Check {
  param($Parent, [string]$Text, [int]$X, [int]$Y, [int]$W, [bool]$Checked = $false)
  $k = New-Object System.Windows.Forms.CheckBox
  $k.Text = $Text
  $k.Location = New-Object System.Drawing.Point($X, $Y)
  $k.Size = New-Object System.Drawing.Size($W, 21)
  $k.Font = $FONT
  $k.Checked = $Checked
  $Parent.Controls.Add($k)
  return $k
}

function Add-Button {
  param($Parent, [string]$Text, [int]$X, [int]$Y, [int]$W, [int]$H = 25)
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $Text
  $b.Location = New-Object System.Drawing.Point($X, $Y)
  $b.Size = New-Object System.Drawing.Size($W, $H)
  $b.Font = $FONT
  $Parent.Controls.Add($b)
  return $b
}

function Add-Group {
  param($Parent, [string]$Text, [int]$X, [int]$Y, [int]$W, [int]$H)
  $g = New-Object System.Windows.Forms.GroupBox
  $g.Text = $Text
  $g.Location = New-Object System.Drawing.Point($X, $Y)
  $g.Size = New-Object System.Drawing.Size($W, $H)
  $g.Font = $FONT_BOLD
  $Parent.Controls.Add($g)
  return $g
}

function Add-Panel {
  param($Parent, [int]$X, [int]$Y, [int]$W, [int]$H)
  $p = New-Object System.Windows.Forms.Panel
  $p.Location = New-Object System.Drawing.Point($X, $Y)
  $p.Size = New-Object System.Drawing.Size($W, $H)
  $p.Font = $FONT
  $p.Visible = $false
  $Parent.Controls.Add($p)
  return $p
}

function Get-SerialPorts {
  try { return @([System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object) } catch { return @() }
}

# Restore a remembered choice as a real selection rather than as loose text:
# an editable combo drops text assigned before its handle exists, which would
# leave the preview claiming a COM port the box no longer shows. A remembered
# port that is not plugged in right now is added to the list, because "COM7,
# and it is not there" is the more useful thing to see than a silent reset.
function Set-ComboValue {
  param($Combo, [string]$Value)
  if (-not $Value) { return }
  if (-not $Combo.Items.Contains($Value)) { [void]$Combo.Items.Add($Value) }
  $Combo.SelectedItem = $Value
}

function Get-ConfigFiles {
  $dir = Join-Path $Root 'config'
  $files = @()
  if (Test-Path -LiteralPath $dir) {
    $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File |
      Where-Object {
        $_.Name -notlike '*.schema.json' -and
        $_.Name -notlike 'hardware*' -and
        $_.Name -ne 'launcher.settings.json'
      } |
      ForEach-Object { 'config/' + $_.Name })
  }
  if (-not $files) { $files = @('config/stand.json') }
  return $files
}

# Keep browsed paths repo-relative when they live here, so the preview stays
# readable and a copied command still works on another machine's checkout.
function Get-RelativeToRoot {
  param([string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  $base = $Root.TrimEnd('\') + '\'
  if ($full.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $full.Substring($base.Length).Replace('\', '/')
  }
  return $full
}

function Resolve-RootPath {
  param([string]$Path)
  if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
  return (Join-Path $Root $Path)
}

# meta.standName of a config file, or '' if it has none or will not parse.
function Get-ConfigStand {
  param([string]$RelativePath)
  try {
    $file = Resolve-RootPath $RelativePath
    if (-not (Test-Path -LiteralPath $file)) { return '' }
    $cfg = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if ($cfg.meta.standName) { return [string]$cfg.meta.standName }
  } catch { }
  return ''
}

# The `stand` a hardware wiring file declares it belongs to, or ''.
function Get-HardwareStand {
  param([string]$RelativePath)
  try {
    $file = Resolve-RootPath $RelativePath
    if (-not (Test-Path -LiteralPath $file)) { return '' }
    $hw = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if ($hw.stand) { return [string]$hw.stand }
  } catch { }
  return ''
}

# Every stand this checkout can run, found rather than listed: each config
# file in config/ names its stand in meta.standName, and each wiring file
# names the stand it belongs to in `stand`. Adding a stand is adding its two
# files; nothing here needs to learn its name.
function Get-WiringFiles {
  $wiring = @{}
  $dir = Join-Path $Root 'config'
  if (Test-Path -LiteralPath $dir) {
    foreach ($f in @(Get-ChildItem -LiteralPath $dir -Filter 'hardware*.json' -File)) {
      $rel = 'config/' + $f.Name
      $stand = Get-HardwareStand $rel
      if ($stand -and -not $wiring.ContainsKey($stand.ToLower())) { $wiring[$stand.ToLower()] = $rel }
    }
  }
  return $wiring
}

function Get-Stands {
  $found = @()
  foreach ($cfg in Get-ConfigFiles) {
    $name = Get-ConfigStand $cfg
    if ($name) { $found += [pscustomobject]@{ Name = $name; Config = $cfg } }
  }
  # By name, and the first file wins for a stand two files claim.
  $stands = [ordered]@{}
  foreach ($s in ($found | Sort-Object Name)) {
    if (-not $stands.Contains($s.Name)) { $stands[$s.Name] = $s.Config }
  }
  return $stands
}

# The wiring file the stand driver will actually load for this config: the
# one typed in the Wiring file box if there is one, otherwise the file that
# declares the config's stand, otherwise the server's own default.
function Get-EffectiveWiring {
  param([string]$ConfigPath)
  $typed = $txtHardware.Text.Trim()
  if ($typed) { return $typed }
  $name = Get-ConfigStand $ConfigPath
  if ($name -and $WIRING.ContainsKey($name.ToLower())) { return [string]$WIRING[$name.ToLower()] }
  return 'config/hardware.json'
}

# The stand a config file describes, for the window's subtitle: the one thing
# always worth confirming before a launch is that this is the right stand.
function Get-StandName {
  param([string]$RelativePath)
  try {
    if (-not $RelativePath) { return '' }
    $file = if ([System.IO.Path]::IsPathRooted($RelativePath)) { $RelativePath } else { Join-Path $Root $RelativePath }
    if (-not (Test-Path -LiteralPath $file)) { return '' }
    $cfg = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    $parts = @($cfg.meta.organization, $cfg.meta.standName) | Where-Object { $_ }
    $line = ($parts -join ' ')
    if ($cfg.meta.subtitle) { $line = (@($line, $cfg.meta.subtitle) | Where-Object { $_ }) -join '  —  ' }
    if ($line) { return $line }
  } catch { }
  return ''
}

# --------------------------------------------------------------- the form ----

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Start ERPL GC-4'
$form.ClientSize = New-Object System.Drawing.Size(600, 746)
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.Font = $FONT
$form.BackColor = [System.Drawing.Color]::White

try {
  $iconPng = Join-Path $Root 'public\img\draco-icon.png'
  if (Test-Path -LiteralPath $iconPng) {
    $bmp = New-Object System.Drawing.Bitmap($iconPng)
    $form.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  }
} catch { }

Add-Label -Parent $form -Text 'Ground Control 4' -X 18 -Y 14 -W 420 -H 28 -Font $FONT_HEAD | Out-Null
$subtitle = Add-Note $form '' 20 44 560

# ---- hardware -------------------------------------------------------------

$gHw = Add-Group $form 'Hardware' 16 68 568 182

$DRIVERS = [ordered]@{
  'simulator' = 'Simulator — physics model of the stand, no hardware needed'
  'stand'     = 'The stand — NI cDAQ instrumentation and PANDA actuation'
  'panda'     = 'PANDA board alone — actuation and the board''s own transducers'
  'serial'    = 'A serial-attached device speaking the GC frame protocol'
  'udp'       = 'A networked device speaking the GC frame protocol over UDP'
}

Add-Label $gHw 'Driver' 12 30 90 | Out-Null
$cbDriver = Add-Combo $gHw @($DRIVERS.Keys) 108 27 170
$lblDriver = Add-Note $gHw '' 12 54 544

# One panel per driver, all built up front and swapped by visibility: fields
# a driver does not use should not be on screen at all, because an empty COM
# port box beside "simulator" reads as something left unfilled.
$pSim    = Add-Panel $gHw 12 76 544 96
$pStand  = Add-Panel $gHw 12 76 544 96
$pPanda  = Add-Panel $gHw 12 76 544 96
$pSerial = Add-Panel $gHw 12 76 544 96
$pUdp    = Add-Panel $gHw 12 76 544 96

Add-Note $pSim 'Nothing reaches real hardware, so this is the safe way to rehearse a test or train a new operator.' 0 4 540 32 | Out-Null

$ports = Get-SerialPorts
$portHint = if ($ports.Count) { 'Detected: ' + ($ports -join ', ') } else { 'No serial ports detected — check the USB cable and the board''s drivers.' }

Add-Label $pStand 'PANDA port' 0 4 90 | Out-Null
$cbStandPort = Add-Combo $pStand (@('(from hardware.json)') + $ports) 96 1 150 'DropDown'
$chkTapStand = Add-Check $pStand 'Raw serial tap window' 262 1 220 ([bool]$settings.pandaTap)
Add-Note $pStand $portHint 96 28 440 | Out-Null
Add-Label $pStand 'Wiring file' 0 51 90 | Out-Null
$txtHardware = Add-TextBox $pStand $settings.hardwareConfig 96 48 316
$btnHardware = Add-Button $pStand 'Browse' 418 47 64 24
Add-Note $pStand 'Channel maps and the chassis name. Blank uses the chosen stand''s own wiring file.' 96 76 440 | Out-Null

Add-Label $pPanda 'PANDA port' 0 4 90 | Out-Null
$cbPandaPort = Add-Combo $pPanda (@('(from hardware.json)') + $ports) 96 1 150 'DropDown'
$chkTapPanda = Add-Check $pPanda 'Raw serial tap window' 262 1 220 ([bool]$settings.pandaTap)
Add-Note $pPanda $portHint 96 28 440 | Out-Null
Add-Note $pPanda 'Actuation and the board''s own pressure transducers, with no NI DAQ instrumentation behind them.' 0 52 540 30 | Out-Null

Add-Label $pSerial 'Serial port' 0 4 90 | Out-Null
$cbSerialPort = Add-Combo $pSerial $ports 96 1 150 'DropDown'
Add-Label $pSerial 'Baud' 262 4 40 | Out-Null
$cbBaud = Add-Combo $pSerial @('115200', '230400', '460800', '921600') 306 1 100 'DropDown'
Add-Note $pSerial $portHint 96 27 440 | Out-Null

Add-Label $pUdp 'Device host' 0 4 90 | Out-Null
$txtUdpHost = Add-TextBox $pUdp $settings.udpHost 96 1 150
Add-Label $pUdp 'Device port' 262 4 80 | Out-Null
$txtUdpPort = Add-TextBox $pUdp $settings.udpPort 346 1 70
Add-Label $pUdp 'Reply port' 0 36 90 | Out-Null
$txtUdpListen = Add-TextBox $pUdp $settings.udpListenPort 96 33 70
Add-Note $pUdp 'The port this computer listens on for telemetry coming back.' 176 37 366 | Out-Null

# ---- network --------------------------------------------------------------

$gNet = Add-Group $form 'Network' 16 258 568 162

Add-Label $gNet 'Web port' 12 30 90 | Out-Null
$txtPort = Add-TextBox $gNet $settings.port 108 27 70
$lblPort = Add-Note $gNet '' 186 31 370

$chkRemote = Add-Check $gNet 'Let other computers act as operator stations' 12 58 420 ([bool]$settings.allowRemote)
$lblRemote = Add-Note $gNet '' 30 80 526 18

$chkSpectator = Add-Check $gNet 'Spectator view — read-only, safe to share' 12 102 300 ([bool]$settings.spectator)
Add-Label $gNet 'Port' 320 104 34 | Out-Null
$txtSpectatorPort = Add-TextBox $gNet $settings.spectatorPort 356 101 70
Add-Note $gNet '(blank = one above)' 432 105 124 | Out-Null

Add-Label $gNet 'Interface' 12 132 90 | Out-Null
$txtBind = Add-TextBox $gNet $settings.bind 108 129 150
Add-Note $gNet 'Which network card to serve on. 0.0.0.0 is all of them.' 266 133 290 | Out-Null

# ---- stand config ---------------------------------------------------------

$gCfg = Add-Group $form 'Stand configuration' 16 428 568 146

# Which stand, first: it chooses the config file and, on the real hardware,
# the wiring file to go with it. The config file stays editable underneath
# for a config that is not one of the stands found here.
$STANDS = Get-Stands
$WIRING = Get-WiringFiles
Add-Label $gCfg 'Stand' 12 30 90 | Out-Null
$cbStand = Add-Combo $gCfg @($STANDS.Keys) 108 27 180
$lblStand = Add-Note $gCfg '' 296 31 258

Add-Label $gCfg 'Config file' 12 62 90 | Out-Null
$cbConfig = Add-Combo $gCfg (Get-ConfigFiles) 108 59 366 'DropDown'
$btnConfig = Add-Button $gCfg 'Browse' 480 58 74 24

Add-Label $gCfg 'Control PIN' 12 94 90 | Out-Null
$cbPin = Add-Combo $gCfg @('From the config file', 'Set one for this run', 'No PIN') 108 91 180
$txtPin = Add-TextBox $gCfg '' 296 91 100
$txtPin.UseSystemPasswordChar = $true
$lblPin = Add-Note $gCfg '' 12 120 544

# ---- options and preview --------------------------------------------------

$chkBrowser = Add-Check $form 'Open the operator page in a browser once the server is listening' 18 584 500 ([bool]$settings.openBrowser)

Add-Note $form 'The command this will run:' 20 612 400 | Out-Null
$preview = New-Object System.Windows.Forms.TextBox
$preview.Multiline = $true
$preview.ReadOnly = $true
$preview.WordWrap = $true
$preview.Font = $FONT_MONO
$preview.BackColor = [System.Drawing.Color]::FromArgb(246, 246, 246)
$preview.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$preview.Location = New-Object System.Drawing.Point(18, 630)
$preview.Size = New-Object System.Drawing.Size(566, 58)
$form.Controls.Add($preview)

$btnUpdate = Add-Button $form 'Check for update' 18 700 150 32
$btnCancel = Add-Button $form 'Cancel' 340 700 100 32
$btnLaunch = Add-Button $form 'Launch' 452 700 132 32
$btnLaunch.Font = $FONT_BOLD
$form.AcceptButton = $btnLaunch
$form.CancelButton = $btnCancel

# ------------------------------------------------------------ the command ----

# The single place that turns the window into flags. The preview, the
# validation and the launch itself all read this, so what is shown and what
# runs cannot drift apart.
function Get-LaunchArgs {
  $a = @('server\index.js')
  $driver = [string]$cbDriver.SelectedItem
  $a += "--driver=$driver"

  switch ($driver) {
    'stand' {
      $p = $cbStandPort.Text.Trim()
      if ($p -and -not $p.StartsWith('(')) { $a += "--port-name=$p" }
      # Draco's wiring is the server's default, so it is left off the line.
      $hw = Get-EffectiveWiring $cbConfig.Text.Trim()
      if ($hw -and $hw -ne 'config/hardware.json') { $a += "--hardware-config=$hw" }
      if ($chkTapStand.Checked) { $a += '--panda-tap' }
    }
    'panda' {
      $p = $cbPandaPort.Text.Trim()
      if ($p -and -not $p.StartsWith('(')) { $a += "--port-name=$p" }
      if ($chkTapPanda.Checked) { $a += '--panda-tap' }
    }
    'serial' {
      $p = $cbSerialPort.Text.Trim()
      if ($p) { $a += "--port-name=$p" }
      $b = $cbBaud.Text.Trim()
      if ($b) { $a += "--baud=$b" }
    }
    'udp' {
      $h = $txtUdpHost.Text.Trim()
      if ($h) { $a += "--host=$h" }
      $dp = $txtUdpPort.Text.Trim()
      if ($dp) { $a += "--driver-port=$dp" }
      $lp = $txtUdpListen.Text.Trim()
      if ($lp) { $a += "--listen-port=$lp" }
    }
  }

  $a += "--port=$($txtPort.Text.Trim())"

  $cfg = $cbConfig.Text.Trim()
  if ($cfg -and $cfg -ne 'config/stand.json') { $a += "--config=$cfg" }

  if ($chkRemote.Checked) { $a += '--allow-remote-control' }

  $bind = $txtBind.Text.Trim()
  if ($bind -and $bind -ne '0.0.0.0') { $a += "--bind=$bind" }

  if (-not $chkSpectator.Checked) {
    $a += '--no-spectator'
  } else {
    $sp = $txtSpectatorPort.Text.Trim()
    if ($sp) { $a += "--spectator-port=$sp" }
  }

  switch ($cbPin.SelectedIndex) {
    1 { $a += "--pin=$($txtPin.Text.Trim())" }
    2 { $a += '--pin=' }
  }

  return $a
}

# A path with a space in it still has to survive the trip through cmd, and
# the quotes belong around the value rather than the whole `--flag=value`.
function Format-Arg {
  param([string]$Value)
  if ($Value -notmatch '\s') { return $Value }
  if ($Value -match '^(--[^=]+)=(.*)$') { return ('{0}="{1}"' -f $Matches[1], $Matches[2]) }
  return ('"{0}"' -f $Value)
}

function Get-Problems {
  $problems = @()

  $portText = $txtPort.Text.Trim()
  if ($portText -notmatch '^\d+$' -or [int]$portText -lt 1 -or [int]$portText -gt 65535) {
    $problems += 'The web port must be a whole number between 1 and 65535.'
  }

  $sp = $txtSpectatorPort.Text.Trim()
  if ($chkSpectator.Checked -and $sp) {
    if ($sp -notmatch '^\d+$' -or [int]$sp -lt 1 -or [int]$sp -gt 65535) {
      $problems += 'The spectator port must be a whole number between 1 and 65535.'
    } elseif ($portText -match '^\d+$' -and [int]$sp -eq [int]$portText) {
      $problems += 'The spectator port and the web port have to be different.'
    }
  }

  if ($cbPin.SelectedIndex -eq 1 -and $txtPin.Text.Trim() -notmatch '^\d{4,12}$') {
    $problems += 'A control PIN is 4 to 12 digits. Pick "No PIN" to run without one.'
  }

  $cfg = $cbConfig.Text.Trim()
  if (-not $cfg) {
    $problems += 'Choose a stand config file.'
  } else {
    $file = if ([System.IO.Path]::IsPathRooted($cfg)) { $cfg } else { Join-Path $Root $cfg }
    if (-not (Test-Path -LiteralPath $file)) { $problems += "Config file not found: $cfg" }
  }

  $driver = [string]$cbDriver.SelectedItem
  if ($driver -eq 'serial' -and -not $cbSerialPort.Text.Trim()) {
    $problems += 'Choose the serial port the device is on.'
  }
  if ($driver -eq 'udp' -and -not $txtUdpHost.Text.Trim()) {
    $problems += 'Enter the address of the device to talk to.'
  }

  if ($driver -eq 'stand') {
    $hw = Get-EffectiveWiring $cfg
    if (-not (Test-Path -LiteralPath (Resolve-RootPath $hw))) {
      $problems += "Hardware wiring file not found: $hw"
    } else {
      # The server refuses this too; saying it here costs the operator a
      # click instead of a console window that opens and dies.
      $hwStand = Get-HardwareStand $hw
      $cfgStand = Get-ConfigStand $cfg
      if ($hwStand -and $cfgStand -and $hwStand -ne $cfgStand) {
        $problems += "The wiring file $hw is for $hwStand, but the config is for $cfgStand. Clear the Wiring file box to use $cfgStand's own."
      }
    }
  }

  return $problems
}

# ------------------------------------------------------------- reactivity ----

$script:refreshing = $false

function Update-Form {
  # Several handlers fire for one keystroke, and this function edits controls
  # itself; the guard is against re-entrancy, not against the extra calls.
  if ($script:refreshing) { return }
  $script:refreshing = $true
  try {
    $driver = [string]$cbDriver.SelectedItem
    $lblDriver.Text = [string]$DRIVERS[$driver]
    $pSim.Visible    = ($driver -eq 'simulator')
    $pStand.Visible  = ($driver -eq 'stand')
    $pPanda.Visible  = ($driver -eq 'panda')
    $pSerial.Visible = ($driver -eq 'serial')
    $pUdp.Visible    = ($driver -eq 'udp')

    $portText = $txtPort.Text.Trim()
    if ($portText -match '^\d+$') { $lblPort.Text = "The operator pages — http://localhost:$portText" }
    else { $lblPort.Text = 'The operator pages.' }

    # Control is local unless it is turned on here, every launch. The window
    # says which of the two it is rather than leaving it to be inferred.
    if ($chkRemote.Checked) {
      $lblRemote.Text = 'Anyone who can reach this computer on the network, and knows the PIN, can command the stand.'
      $lblRemote.ForeColor = $WARN
    } else {
      $lblRemote.Text = 'Control stays on this computer only. The spectator view is still shared.'
      $lblRemote.ForeColor = $GREY
    }

    $txtSpectatorPort.Enabled = $chkSpectator.Checked
    $txtPin.Enabled = ($cbPin.SelectedIndex -eq 1)
    if (-not $txtPin.Enabled -and $txtPin.Text) { $txtPin.Text = '' }

    switch ($cbPin.SelectedIndex) {
      0 { $lblPin.Text = 'Whatever safety.controlPin says, and it follows that value when the Config page saves.'; $lblPin.ForeColor = $GREY }
      1 { $lblPin.Text = 'Used for this run only. It overrides the config file until the server stops, and is not saved to disk.'; $lblPin.ForeColor = $GREY }
      2 { $lblPin.Text = 'No PIN: anyone who can reach the control port can command the stand.'; $lblPin.ForeColor = $WARN }
    }

    $subtitle.Text = Get-StandName $cbConfig.Text.Trim()

    # The Stand box follows the config file, so a file picked by hand or
    # restored from last time still shows which stand it is -- and shows
    # nothing when it is not one of the stands found.
    $cfgStand = Get-ConfigStand $cbConfig.Text.Trim()
    if ($cfgStand -and $cbStand.Items.Contains($cfgStand)) {
      if ([string]$cbStand.SelectedItem -ne $cfgStand) { $cbStand.SelectedItem = $cfgStand }
    } elseif ($cbStand.SelectedIndex -ne -1) {
      $cbStand.SelectedIndex = -1
    }
    if ($driver -eq 'stand') {
      $lblStand.Text = 'Wiring: ' + (Get-EffectiveWiring $cbConfig.Text.Trim())
    } elseif ($cfgStand) {
      $lblStand.Text = ''
    } else {
      $lblStand.Text = 'This config file names no stand.'
    }

    $shown = @(Get-LaunchArgs) | ForEach-Object { Format-Arg $_ }
    $preview.Text = 'node ' + ($shown -join ' ')
  } finally {
    $script:refreshing = $false
  }
}

foreach ($c in @($cbDriver, $cbPin, $cbConfig, $cbBaud, $cbStandPort, $cbPandaPort, $cbSerialPort)) {
  $c.Add_SelectedIndexChanged({ Update-Form })
  $c.Add_TextChanged({ Update-Form })
}
foreach ($c in @($chkRemote, $chkSpectator, $chkBrowser, $chkTapStand, $chkTapPanda)) {
  $c.Add_CheckedChanged({ Update-Form })
}
foreach ($c in @($txtPort, $txtSpectatorPort, $txtBind, $txtPin, $txtHardware, $txtUdpHost, $txtUdpPort, $txtUdpListen)) {
  $c.Add_TextChanged({ Update-Form })
}

# The two tap checkboxes are one setting wearing two hats; keep them agreed
# so changing driver never quietly changes what the flag will be.
$chkTapStand.Add_CheckedChanged({ if ($chkTapPanda.Checked -ne $chkTapStand.Checked) { $chkTapPanda.Checked = $chkTapStand.Checked } })
$chkTapPanda.Add_CheckedChanged({ if ($chkTapStand.Checked -ne $chkTapPanda.Checked) { $chkTapStand.Checked = $chkTapPanda.Checked } })

# Picking a stand picks its config file; Update-Form (via the config box's
# change events) does the rest. Ignored while Update-Form is itself moving
# the Stand box to match a config file, which would otherwise loop.
$cbStand.Add_SelectedIndexChanged({
  if ($script:refreshing) { return }
  $name = [string]$cbStand.SelectedItem
  if ($name -and $STANDS.Contains($name)) { Set-ComboValue $cbConfig ([string]$STANDS[$name]) }
})

$btnConfig.Add_Click({
  $dlg = New-Object System.Windows.Forms.OpenFileDialog
  $dlg.InitialDirectory = Join-Path $Root 'config'
  $dlg.Filter = 'Stand config (*.json)|*.json|All files (*.*)|*.*'
  if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $cbConfig.Text = Get-RelativeToRoot $dlg.FileName
  }
})

$btnHardware.Add_Click({
  $dlg = New-Object System.Windows.Forms.OpenFileDialog
  $dlg.InitialDirectory = Join-Path $Root 'config'
  $dlg.Filter = 'Hardware wiring (*.json)|*.json|All files (*.*)|*.*'
  if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $txtHardware.Text = Get-RelativeToRoot $dlg.FileName
  }
})

$btnCancel.Add_Click({ $form.Close() })

# ---------------------------------------------------------------- update ----

# Runs git with its output captured. Not `& git ... 2>&1`: under
# ErrorActionPreference=Stop, Windows PowerShell turns git's ordinary progress
# chatter on stderr into a terminating error.
function Invoke-Git {
  param([string[]]$GitArgs)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'git'
  $psi.Arguments = ($GitArgs | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join ' '
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  # Never hang the window on a credential prompt nobody can see.
  $psi.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
  $proc = [System.Diagnostics.Process]::Start($psi)
  $errTask = $proc.StandardError.ReadToEndAsync()
  $out = $proc.StandardOutput.ReadToEnd()
  $proc.WaitForExit()
  [pscustomobject]@{ Code = $proc.ExitCode; Out = $out.Trim(); Err = $errTask.Result.Trim() }
}

# Checks GitHub's main for commits this copy does not have, and on a yes
# fast-forwards to them. Fast-forward only: this never merges, rebases or
# discards anything, so local edits either survive the pull or stop it with
# git's own explanation.
$btnUpdate.Add_Click({
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Show-Problem "Git is not installed or not on PATH, so the launcher cannot check for updates."
    return
  }
  $form.UseWaitCursor = $true
  $btnUpdate.Enabled = $false
  try {
    $branch = (Invoke-Git @('rev-parse', '--abbrev-ref', 'HEAD')).Out
    $fetch = Invoke-Git @('fetch', 'origin', 'main')
    if ($fetch.Code -ne 0) {
      Show-Problem "Could not reach GitHub to check for updates.`r`n`r`n$($fetch.Err)"
      return
    }
    $behind = [int](Invoke-Git @('rev-list', '--count', 'HEAD..origin/main')).Out
    if ($behind -eq 0) {
      Show-Problem 'GC-4 is up to date with main on GitHub.' 'Check for update' 'Information'
      return
    }
    $log = (Invoke-Git @('log', '--oneline', '--no-decorate', '-n', '15', 'HEAD..origin/main')).Out
    if ($behind -gt 15) { $log += "`r`n... and $($behind - 15) more" }
    if ($branch -ne 'main') {
      Show-Problem "There are $behind new commit(s) on main, but this copy is on branch '$branch'.`r`n`r`nSwitch to main to update from the launcher."
      return
    }
    $answer = [System.Windows.Forms.MessageBox]::Show(
      "An update is available: $behind new commit(s) on main.`r`n`r`n$log`r`n`r`nUpdate now?",
      'Update available',
      [System.Windows.Forms.MessageBoxButtons]::YesNo,
      [System.Windows.Forms.MessageBoxIcon]::Question)
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }

    $before = (Invoke-Git @('rev-parse', 'HEAD')).Out
    $pull = Invoke-Git @('pull', '--ff-only', 'origin', 'main')
    if ($pull.Code -ne 0) {
      Show-Problem "The update did not apply. Nothing was changed.`r`n`r`n$($pull.Err)`r`n`r`nLocal edits to the same files are the usual cause. Commit or stash them, then try again." 'Update failed' 'Error'
      return
    }
    $changed = (Invoke-Git @('diff', '--name-only', $before, 'HEAD')).Out -split "`n"
    $notes = @()
    if ($changed -match '^package(-lock)?\.json$') { $notes += 'Dependencies changed: run  npm install  in this folder before launching.' }
    if ($changed -match '^tools/gc-launcher\.ps1$') { $notes += 'The launcher itself was updated: close this window and start it again to use the new version.' }
    Show-Problem ((@("Updated to the latest main ($behind commit(s)).") + $notes) -join "`r`n`r`n") 'Update complete' 'Information'
    Update-Form
  } finally {
    $form.UseWaitCursor = $false
    $btnUpdate.Enabled = $true
  }
})

$script:launch = $false
$btnLaunch.Add_Click({
  $problems = @(Get-Problems)
  if ($problems.Count) {
    Show-Problem (($problems | ForEach-Object { "•  $_" }) -join "`r`n`r`n") 'Check these first'
    return
  }
  $script:launch = $true
  $form.Close()
})

# ---------------------------------------------------------------- restore ----

if ($cbDriver.Items.Contains([string]$settings.driver)) { $cbDriver.SelectedItem = [string]$settings.driver }
else { $cbDriver.SelectedIndex = 0 }
Set-ComboValue $cbConfig ([string]$settings.config)
Set-ComboValue $cbBaud ([string]$settings.baud)
$cbStandPort.SelectedIndex = 0
$cbPandaPort.SelectedIndex = 0
if ($settings.comPort) {
  Set-ComboValue $cbStandPort ([string]$settings.comPort)
  Set-ComboValue $cbPandaPort ([string]$settings.comPort)
  Set-ComboValue $cbSerialPort ([string]$settings.comPort)
}
$cbPin.SelectedIndex = 0
Update-Form

[void]$form.ShowDialog()

if (-not $script:launch) { exit 0 }

# ----------------------------------------------------------------- launch ----

$settings.driver         = [string]$cbDriver.SelectedItem
$settings.port           = $txtPort.Text.Trim()
$settings.config         = $cbConfig.Text.Trim()
$settings.allowRemote    = [bool]$chkRemote.Checked
$settings.bind           = $txtBind.Text.Trim()
$settings.spectator      = [bool]$chkSpectator.Checked
$settings.spectatorPort  = $txtSpectatorPort.Text.Trim()
$settings.udpHost        = $txtUdpHost.Text.Trim()
$settings.udpPort        = $txtUdpPort.Text.Trim()
$settings.udpListenPort  = $txtUdpListen.Text.Trim()
$settings.baud           = $cbBaud.Text.Trim()
$settings.hardwareConfig = $txtHardware.Text.Trim()
$settings.pandaTap       = [bool]$chkTapStand.Checked
$settings.openBrowser    = [bool]$chkBrowser.Checked
# The PIN is the one choice deliberately not remembered.
switch ($settings.driver) {
  'stand'  { $settings.comPort = if ($cbStandPort.Text.StartsWith('(')) { '' } else { $cbStandPort.Text.Trim() } }
  'panda'  { $settings.comPort = if ($cbPandaPort.Text.StartsWith('(')) { '' } else { $cbPandaPort.Text.Trim() } }
  'serial' { $settings.comPort = $cbSerialPort.Text.Trim() }
}
Save-Settings

$launchArgs = @(Get-LaunchArgs) | ForEach-Object { Format-Arg $_ }

# A console of its own, so the operator gets the startup banner with the
# addresses on it and Ctrl+C still ends the run the way the software expects.
# `|| pause` holds the window open when node exits non-zero: a bad config or
# an absent board prints its reason and quits, and a window that disappears
# takes the reason with it.
$nodeExe = Format-Arg $node.Source
$command = "title ERPL GC-4 & $nodeExe $($launchArgs -join ' ') || pause"

Start-Process -FilePath $env:ComSpec -ArgumentList "/s /c `"$command`"" -WorkingDirectory $Root

if (-not $chkBrowser.Checked) { exit 0 }

# Wait for the listener instead of guessing at a sleep: on a cold start the
# NI DAQ sidecar and the PANDA handshake can take several seconds, and a
# browser opened too early just shows a connection error.
$port = [int]$txtPort.Text.Trim()
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $client.Connect('127.0.0.1', $port)
    $client.Close()
    Start-Process "http://localhost:$port/"
    break
  } catch {
    Start-Sleep -Milliseconds 400
  } finally {
    $client.Dispose()
  }
}
