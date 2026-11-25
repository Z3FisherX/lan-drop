'use strict';

const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');

const run = promisify(execFile);
let pickerOpen = false;

const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
$dialog.Description = '选择接收文件的目录'
$dialog.ShowNewFolderButton = $true
$owner = [System.Windows.Forms.Form]::new()
$owner.Text = 'LAN Drop'
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$owner.Size = [System.Drawing.Size]::new(320, 90)
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$initial = $env:LAN_DROP_PICKER_START
if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) {
    $dialog.SelectedPath = $initial
}
try {
    $owner.Show()
    $owner.Activate()
    if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::Write($dialog.SelectedPath)
    }
} finally {
    $dialog.Dispose()
    $owner.Dispose()
}
`;

async function chooseDirectory(initialDirectory) {
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('请手动输入接收目录的绝对路径'), { status: 501 });
  }
  if (pickerOpen) {
    throw Object.assign(new Error('目录选择窗口已打开'), { status: 409 });
  }

  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = Buffer.from(script, 'utf16le').toString('base64');
  pickerOpen = true;
  try {
    const { stdout } = await run(powershell, ['-NoProfile', '-STA', '-EncodedCommand', command], {
      encoding: 'utf8',
      env: { ...process.env, LAN_DROP_PICKER_START: initialDirectory || '' },
      timeout: 5 * 60 * 1000,
      windowsHide: true,
    });
    return stdout || null;
  } catch {
    throw Object.assign(new Error('无法打开目录选择窗口，请输入目录的绝对路径'), { status: 503 });
  } finally {
    pickerOpen = false;
  }
}

module.exports = { chooseDirectory };
