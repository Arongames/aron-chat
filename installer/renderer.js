// ============================================================
// Логика окна установщика.
// ============================================================

const { ipcRenderer } = require('electron');

const $ = (id) => document.getElementById(id);

const state = {
  step: 1,
  info: null,
  dir: '',
  installing: false,
  installed: false,
};

const HINTS = {
  1: 'Прочитайте условия и примите их',
  2: 'Проверьте папку и нажмите «Установить»',
  3: 'Идёт установка…',
  4: 'Можно запускать',
};

function showStep(step) {
  state.step = step;

  document.querySelectorAll('.page').forEach((page) => {
    page.classList.toggle('active', Number(page.dataset.page) === step);
  });

  document.querySelectorAll('.step').forEach((el) => {
    const n = Number(el.dataset.step);
    el.classList.toggle('active', n === step);
    el.classList.toggle('done', n < step);
  });

  const accepted = $('acceptTerms').checked;
  $('btnNext').hidden = step !== 1;
  $('btnInstall').hidden = step !== 2;
  $('btnBack').hidden = !(step === 2);
  $('btnLaunch').hidden = step !== 4;
  $('btnFinish').hidden = step !== 4;

  $('btnNext').disabled = step === 1 && !accepted;
  $('btnInstall').disabled = step === 2 && !state.dir;

  $('footerHint').textContent = HINTS[step] || '';

  if (step === 2 && !state.dir) {
    state.dir = state.info.defaultDir;
    $('installDir').value = state.dir;
  }
}

function setError(message) {
  const el = $('dirError');
  el.textContent = message || '';
  el.hidden = !message;
}

function setProgress(percent, text) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  $('progressBar').style.width = `${value}%`;
  $('progressPercent').textContent = `${Math.round(value)}%`;
  if (text) $('progressText').textContent = text;
}

async function startInstall() {
  if (state.installing) return;
  const dir = $('installDir').value.trim();
  if (!dir) {
    setError('Укажите папку установки');
    return;
  }

  state.installing = true;
  state.dir = dir;
  setError('');
  showStep(3);
  setProgress(0, 'Подготовка…');

  const result = await ipcRenderer.invoke('setup:install', dir);
  state.installing = false;

  if (!result.ok) {
    showStep(2);
    setError(result.error || 'Не удалось установить приложение');
    return;
  }

  state.installed = true;
  $('donePath').textContent = result.dir;
  showStep(4);
}

// ---------- события ----------
$('acceptTerms').addEventListener('change', () => {
  $('btnNext').disabled = !$('acceptTerms').checked;
});

$('btnNext').addEventListener('click', () => {
  if (state.step === 1) {
    if (!$('acceptTerms').checked) return;
    showStep(2);
  }
});

$('btnBack').addEventListener('click', () => {
  if (state.step === 2) {
    setError('');
    showStep(1);
  }
});

$('btnInstall').addEventListener('click', startInstall);

$('btnBrowse').addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('setup:pick');
  if (res.ok) {
    state.dir = res.dir;
    $('installDir').value = res.dir;
    $('btnInstall').disabled = false;
    setError('');
  }
});

$('installDir').addEventListener('input', () => {
  state.dir = $('installDir').value.trim();
  $('btnInstall').disabled = !state.dir;
  setError('');
});

$('btnLaunch').addEventListener('click', async () => {
  await ipcRenderer.invoke('setup:launch', state.dir);
  ipcRenderer.send('setup:close');
});

$('btnFinish').addEventListener('click', () => ipcRenderer.send('setup:close'));

$('btnMin').addEventListener('click', () => ipcRenderer.send('setup:minimize'));
$('btnClose').addEventListener('click', () => ipcRenderer.send('setup:close'));

ipcRenderer.on('setup:progress', (_e, payload) => {
  setProgress(payload.percent, payload.text);
});

// ---------- старт ----------
ipcRenderer.invoke('setup:info').then((info) => {
  state.info = info;
  state.dir = info.defaultDir;

  $('version').textContent = info.version;
  $('sumVersion').textContent = info.version;
  $('termsBox').textContent = info.terms;
  $('installDir').value = info.defaultDir;

  showStep(1);
});
