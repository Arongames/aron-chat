// Сборка «лёгкой» версии без офлайн-голосов Piper.
// Запуск: node tools/build-lite.js
//
// Скрипт временно убирает assets/piper, собирает portable-EXE
// в dist-lite и возвращает папку на место.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const piper = path.join(root, 'assets', 'piper');
const backup = path.join(root, 'piper.__lite_backup');
const builder = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const node = process.execPath;

let moved = false;

try {
  if (fs.existsSync(piper)) {
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
    fs.renameSync(piper, backup);
    moved = true;
    console.log('Piper voices temporarily disabled');
  }

  const args = [
    builder,
    '--win',
    'portable',
    '--config.directories.output=dist-lite',
    '--config.productName=Aron Chat Lite',
    '--config.win.artifactName=Aron Chat Lite ${version}.exe',
  ];

  const result = spawnSync(node, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });

  if (result.status !== 0) process.exitCode = result.status || 1;
} finally {
  if (moved && fs.existsSync(backup)) {
    if (fs.existsSync(piper)) fs.rmSync(piper, { recursive: true, force: true });
    fs.renameSync(backup, piper);
    console.log('Piper voices restored');
  }
}
