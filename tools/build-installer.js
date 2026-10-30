// ============================================================
// Сборка кастомного установщика Aron Chat.
//
//   1. собирает распакованное приложение (win-unpacked);
//   2. пакует его в installer/payload.7z;
//   3. собирает установщик на Electron в dist-setup.
//
// Запуск: node tools/build-installer.js [--skip-app]
// ============================================================

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const BUILDER = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const SEVEN_ZIP = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const UNPACKED = path.join(ROOT, 'dist-new', 'win-unpacked');
const INSTALLER = path.join(ROOT, 'installer');
const PAYLOAD = path.join(INSTALLER, 'payload.7z');

const skipApp = process.argv.includes('--skip-app');

function step(title) {
  console.log(`\n=== ${title} ===`);
}

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  if (res.status !== 0) {
    throw new Error(`Команда завершилась с кодом ${res.status}: ${cmd} ${args.join(' ')}`);
  }
}

try {
  if (!skipApp) {
    step('Сборка приложения (win-unpacked)');
    run(NODE, [BUILDER, '--win', 'dir'], { cwd: ROOT });
  }

  if (!fs.existsSync(path.join(UNPACKED, 'Aron Chat.exe'))) {
    throw new Error('Нет dist-new\\win-unpacked — сначала соберите приложение');
  }

  step('Упаковка payload.7z');
  if (fs.existsSync(PAYLOAD)) fs.unlinkSync(PAYLOAD);
  run(SEVEN_ZIP, ['a', '-t7z', '-mx=9', '-mmt=on', PAYLOAD, '*'], { cwd: UNPACKED });
  console.log(`payload: ${(fs.statSync(PAYLOAD).size / 1024 / 1024).toFixed(1)} МБ`);

  step('Сборка установщика');
  run(NODE, [BUILDER, '--projectDir', INSTALLER, '--win', 'portable'], { cwd: ROOT });

  const out = path.join(ROOT, 'dist-setup');
  const files = fs.readdirSync(out).filter((f) => f.endsWith('.exe'));
  console.log('\nГотово:');
  for (const file of files) {
    const full = path.join(out, file);
    console.log(`  ${file} — ${(fs.statSync(full).size / 1024 / 1024).toFixed(1)} МБ`);
  }
} catch (err) {
  console.error('\nОШИБКА:', err.message);
  process.exit(1);
}
