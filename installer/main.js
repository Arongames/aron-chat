// ============================================================
// Установщик Aron Chat на Electron.
//
// Распаковывает payload.7z во выбранную папку, создаёт ярлыки,
// запись в «Приложения и возможности» и uninstaller.
// Полностью в стиле приложения: тёмное окно, свои шрифты и кнопки.
// ============================================================

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Самая ранняя точка: если этого файла нет, код приложения не запускался
try {
  fs.appendFileSync(path.join(os.tmpdir(), 'aron-setup-boot.log'), `boot ${new Date().toISOString()}\n`, 'utf8');
} catch { /* ничего */ }

const APP_NAME = 'Aron Chat';
const EXE_NAME = 'Aron Chat.exe';
const UNINSTALL_KEY = 'AronChat';

// Тихий режим для автообновления:
//   --silent --dir "<папка>" [--launch]
const ARGV = process.argv.slice(1);
const SILENT = ARGV.includes('--silent');
const SILENT_LAUNCH = ARGV.includes('--launch');

function argValue(name) {
  const direct = ARGV.find((a) => a.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = ARGV.indexOf(name);
  if (index !== -1 && ARGV[index + 1]) return ARGV[index + 1];
  return '';
}

// Диагностика запуска: установщик должен работать даже если что-то падает
const LOG_FILE = path.join(os.tmpdir(), 'aron-setup.log');
function trace(message) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch { /* лог не критичен */ }
}

trace(`start packaged=${app.isPackaged} resources=${process.resourcesPath}`);
process.on('uncaughtException', (err) => trace(`uncaught: ${err.stack || err.message}`));
process.on('unhandledRejection', (err) => trace(`rejection: ${err && (err.stack || err.message)}`));

let mainWindow = null;

function resourcePath(name) {
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(__dirname, name);
}

// terms.txt лежит внутри app.asar, остальные файлы — в resources
function appFile(name) {
  return path.join(app.getAppPath(), name);
}

function defaultInstallDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Programs', 'Aron Chat');
}

// Ищем уже установленную копию, чтобы при обновлении подставить её папку.
// Источники: записи Uninstall в реестре, запущенный процесс, типовые пути.
async function detectInstallDir() {
  const fallback = defaultInstallDir();
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$paths = New-Object System.Collections.Generic.List[string]
$keys = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
foreach ($k in $keys) {
  Get-ItemProperty $k | Where-Object { $_.DisplayName -like 'Aron Chat*' -and $_.InstallLocation } | ForEach-Object {
    $paths.Add([string]$_.InstallLocation)
  }
}
Get-CimInstance Win32_Process -Filter "Name='Aron Chat.exe' OR Name='Aron Chat Lite.exe'" | ForEach-Object {
  if ($_.ExecutablePath) { $paths.Add((Split-Path -Parent $_.ExecutablePath)) }
}
$paths.Add(${psQuote(fallback)})
$paths.Add('C:\\Program Files\\Aron Chat')
$paths.Add('C:\\Program Files (x86)\\Aron Chat')
foreach ($p in $paths) {
  if ($p -and (Test-Path (Join-Path $p 'Aron Chat.exe'))) { Write-Output $p; break }
}
`;
  try {
    const res = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    const dir = (res.stdout || '').trim().split(/\r?\n/).pop().trim();
    if (dir && fs.existsSync(path.join(dir, EXE_NAME))) return dir;
  } catch {
    // остаётся путь по умолчанию
  }
  return fallback;
}

let cachedInstallDir = null;

async function installDirForUpdate() {
  if (!cachedInstallDir) cachedInstallDir = await detectInstallDir();
  return cachedInstallDir;
}

function canWriteDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.aron-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

async function relaunchElevated(dir) {
  const setupExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const script = `
Start-Process -FilePath ${psQuote(setupExe)} -Verb RunAs -ArgumentList @('--silent','--launch')
`;
  await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

function silentTargetDir() {
  const candidates = [];
  const fromEnv = String(process.env.ARON_UPDATE_DIR || '').trim();
  if (fromEnv) candidates.push(fromEnv);
  const fromArg = String(argValue('--dir') || '').trim();
  if (fromArg) candidates.push(fromArg);
  try {
    const file = path.join(os.tmpdir(), 'aron-update-target.txt');
    const value = fs.readFileSync(file, 'utf8').trim();
    if (value) candidates.push(value);
  } catch { /* файла нет */ }

  // Берём только путь, где уже лежит приложение. Иначе при обновлении
  // со старой версии кривой --dir (например, "C:\Program") уводит установку.
  for (const value of candidates) {
    if (value && fs.existsSync(path.join(value, EXE_NAME))) return value;
  }
  return '';
}

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => reject(new Error(`${path.basename(cmd)}: ${err.message}`)));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// ---------- Распаковка ----------
function extractPayload(dest, onProgress) {
  return new Promise((resolve, reject) => {
    const archive = resourcePath('payload.7z');
    const sevenZip = resourcePath('7za.exe');

    if (!fs.existsSync(archive)) return reject(new Error('payload.7z не найден в установщике'));
    if (!fs.existsSync(sevenZip)) return reject(new Error('7za.exe не найден в установщике'));

    const child = spawn(sevenZip, ['x', archive, `-o${dest}`, '-y', '-bsp1'], {
      windowsHide: true,
    });

    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const matches = [...buffer.matchAll(/(\d{1,3})%/g)];
      if (matches.length) {
        const percent = Math.min(95, Math.max(1, parseInt(matches[matches.length - 1][1], 10)));
        onProgress(percent);
      }
      if (buffer.length > 8000) buffer = buffer.slice(-2000);
    });
    child.stderr.on('data', () => { /* 7za пишет прогресс в stdout */ });

    child.on('error', (err) => reject(new Error(`Не удалось запустить 7-Zip: ${err.message}`)));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`7-Zip завершился с кодом ${code}`));
    });
  });
}

// ---------- Ярлыки и запись в системе ----------
async function createShortcuts(dir) {
  const exe = path.join(dir, EXE_NAME);
  const script = `
$ErrorActionPreference = 'Stop'
$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
foreach ($folder in @($desktop, $programs)) {
  $lnk = Join-Path $folder '${APP_NAME}.lnk'
  $s = $ws.CreateShortcut($lnk)
  $s.TargetPath = ${psQuote(exe)}
  $s.WorkingDirectory = ${psQuote(dir)}
  $s.IconLocation = ${psQuote(`${exe},0`)}
  $s.Description = 'Aron Chat'
  $s.Save()
}
`;
  const res = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  if (res.code !== 0) throw new Error(`Ярлыки: ${res.stderr.trim() || 'ошибка PowerShell'}`);
}

async function writeRegistry(dir, version) {
  const exe = path.join(dir, EXE_NAME);
  const uninstallCmd = path.join(dir, 'Uninstall Aron Chat.cmd');
  const script = `
$ErrorActionPreference = 'Stop'
$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_KEY}'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name DisplayName -Value '${APP_NAME}'
Set-ItemProperty -Path $key -Name DisplayVersion -Value ${psQuote(version)}
Set-ItemProperty -Path $key -Name Publisher -Value 'SGR (StreamRateGame)'
Set-ItemProperty -Path $key -Name URLInfoAbout -Value 'https://arongames.by/'
Set-ItemProperty -Path $key -Name HelpLink -Value 'https://arongames.by/'
Set-ItemProperty -Path $key -Name InstallLocation -Value ${psQuote(dir)}
Set-ItemProperty -Path $key -Name DisplayIcon -Value ${psQuote(exe)}
Set-ItemProperty -Path $key -Name UninstallString -Value ${psQuote(`"${uninstallCmd}"`)}
Set-ItemProperty -Path $key -Name QuietUninstallString -Value ${psQuote(`"${uninstallCmd}"`)}
Set-ItemProperty -Path $key -Name NoModify -Value 1 -Type DWord
Set-ItemProperty -Path $key -Name NoRepair -Value 1 -Type DWord
`;
  const res = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  if (res.code !== 0) throw new Error(`Запись в реестр: ${res.stderr.trim() || 'ошибка PowerShell'}`);
}

function writeUninstaller(dir, version) {
  const uninstallPs1 = `# Удаление Aron Chat
$ErrorActionPreference = 'SilentlyContinue'
$dir = ${psQuote(dir)}

Get-Process 'Aron Chat' | Stop-Process -Force
Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Aron Chat.lnk') -Force
Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'Aron Chat.lnk') -Force
Remove-Item 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_KEY}' -Recurse -Force

$cmd = 'timeout /t 2 >nul & rmdir /s /q "' + $dir + '"'
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -WindowStyle Hidden
`;
  fs.writeFileSync(path.join(dir, 'uninstall.ps1'), uninstallPs1, 'utf8');

  const cmd = `@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"\r\n`;
  fs.writeFileSync(path.join(dir, 'Uninstall Aron Chat.cmd'), cmd, 'utf8');

  fs.writeFileSync(
    path.join(dir, 'version.txt'),
    `${APP_NAME} ${version}\r\nУстановлено: ${new Date().toLocaleString('ru-RU')}\r\n`,
    'utf8'
  );
}

// ---------- Установка ----------
async function install(dir, send) {
  const version = app.getVersion();
  const target = path.resolve(dir);

  send({ stage: 'prepare', percent: 0, text: 'Подготовка…' });
  fs.mkdirSync(target, { recursive: true });

  // Проверка прав: пробуем записать файл
  try {
    const probe = path.join(target, '.aron-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err) {
    throw new Error('Нет прав на запись в выбранную папку. Выберите папку в профиле пользователя.');
  }

  // Закрываем запущенное приложение, чтобы файлы не были заняты
  await run('taskkill.exe', ['/IM', EXE_NAME, '/F']).catch(() => {});

  send({ stage: 'extract', percent: 2, text: 'Распаковка приложения…' });
  await extractPayload(target, (percent) => {
    send({
      stage: 'extract',
      percent: Math.min(90, 2 + Math.round(percent * 0.88)),
      text: 'Распаковка приложения…',
    });
  });

  send({ stage: 'finish', percent: 92, text: 'Создание ярлыков…' });
  await createShortcuts(target);

  send({ stage: 'finish', percent: 96, text: 'Регистрация в системе…' });
  await writeRegistry(target, version);
  writeUninstaller(target, version);

  send({ stage: 'done', percent: 100, text: 'Готово' });
  return { ok: true, dir: target, version };
}

// ---------- Окно ----------
function createWindow() {
  trace('createWindow');
  mainWindow = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 760,
    minHeight: 640,
    resizable: false,
    frame: false,
    show: false,
    backgroundColor: '#0b0d11',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html')).catch((err) => {
    trace(`loadFile error: ${err.message}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    trace(`renderer gone: ${JSON.stringify(details)}`);
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { trace('window closed'); mainWindow = null; });
}

// ---------- IPC ----------
ipcMain.handle('setup:info', async () => {
  const defaultDir = await installDirForUpdate();
  return {
    version: app.getVersion(),
    defaultDir,
    terms: fs.readFileSync(appFile('terms.txt'), 'utf8'),
    appName: APP_NAME,
  };
});

ipcMain.handle('setup:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Куда установить Aron Chat',
    defaultPath: await installDirForUpdate(),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Выбрать папку',
  });
  if (res.canceled || !res.filePaths[0]) return { ok: false };
  return { ok: true, dir: res.filePaths[0] };
});

ipcMain.handle('setup:install', async (_event, dir) => {
  try {
    const result = await install(dir, (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('setup:progress', payload);
      }
    });
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('setup:launch', async (_event, dir) => {
  const exe = path.join(dir, EXE_NAME);
  if (fs.existsSync(exe)) {
    spawn(exe, [], { detached: true, stdio: 'ignore', cwd: dir }).unref();
    return { ok: true };
  }
  return { ok: false, error: 'исполняемый файл не найден' };
});

ipcMain.handle('setup:open-folder', (_event, dir) => shell.openPath(dir));

ipcMain.on('setup:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('setup:close', () => app.quit());
ipcMain.handle('setup:open-external', (_event, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
});

app.whenReady().then(async () => {
  trace('app ready');

  if (SILENT) {
    const dir = silentTargetDir() || await installDirForUpdate();
    trace(`silent install dir=${dir}`);
    try {
      if (!canWriteDir(dir)) {
        trace('silent: no write access, elevating');
        await relaunchElevated(dir);
        app.exit(0);
        return;
      }
      await install(dir, () => {});
      if (SILENT_LAUNCH) {
        const exe = path.join(dir, EXE_NAME);
        if (fs.existsSync(exe)) {
          spawn(exe, [], { detached: true, stdio: 'ignore', cwd: dir }).unref();
        }
      }
      app.exit(0);
    } catch (err) {
      trace(`silent error: ${err.stack || err.message}`);
      app.exit(1);
    }
    return;
  }

  createWindow();
}).catch((err) => trace(`whenReady error: ${err.stack || err.message}`));

app.on('child-process-gone', (_e, details) => trace(`child gone: ${JSON.stringify(details)}`));
app.on('window-all-closed', () => { trace('all windows closed'); app.quit(); });
