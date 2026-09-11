/* ===== 오캔스픽 데스크톱 — Electron 메인 ===== */
'use strict';
const { app, BrowserWindow, ipcMain, session, utilityProcess, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const models = require('./models');

let win = null, engine = null, engineReady = false;
const pending = new Map();      // tts id → resolve
const modelsDir = () => path.join(app.getPath('userData'), 'models');

/* 단일 인스턴스 */
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 860, minWidth: 900, minHeight: 640,
    backgroundColor: '#0f1115',
    title: '오캔스픽',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

/* 마이크 권한: 한 번 허용하면 끝 (OS 권한은 별도) */
function setupPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb) => { cb(['media', 'audioCapture', 'clipboard-read', 'clipboard-sanitized-write', 'notifications'].includes(permission)); });
  ses.setPermissionCheckHandler((wc, permission) => ['media', 'audioCapture', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
}

/* ---------- 엔진 프로세스 ---------- */
function startEngine() {
  if (engine) return;
  engine = utilityProcess.fork(path.join(__dirname, 'engine.js'), [], { serviceName: 'ocanspic-speech' });
  engine.on('message', (m) => {
    if (m.type === 'ready') { engineReady = true; sendR('engine:ready', { speakers: m.speakers, sampleRate: m.sampleRate, ms: m.ms }); return; }
    if (m.type === 'tts') { const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } return; }
    if (m.type && m.type.indexOf('stt-') === 0) { sendR('engine:stt', m); return; }
    if (m.type === 'error') { console.error('[engine]', m.at, m.error); sendR('engine:error', m); }
  });
  engine.on('exit', (code) => { engine = null; engineReady = false; sendR('engine:exit', { code }); });
  engine.postMessage({ type: 'init', dir: modelsDir() });
}
function sendR(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

/* ---------- IPC ---------- */
ipcMain.handle('models:status', () => models.status(modelsDir()));
let downloading = null;
ipcMain.handle('models:ensure', async () => {
  if (downloading) return downloading;
  downloading = models.ensure(modelsDir(), (p) => sendR('models:progress', p))
    .then((st) => { downloading = null; if (st.ready) startEngine(); return st; })
    .catch((e) => { downloading = null; throw e; });
  return downloading;
});
ipcMain.handle('engine:status', () => ({ ready: engineReady, running: !!engine }));
ipcMain.handle('engine:start', () => { if (models.status(modelsDir()).ready) startEngine(); return { running: !!engine }; });
let ttsSeq = 0;
ipcMain.handle('tts:speak', (e, { text, sid, speed }) => new Promise((resolve) => {
  if (!engine || !engineReady) return resolve({ error: 'engine-not-ready' });
  const id = ++ttsSeq;
  pending.set(id, resolve);
  engine.postMessage({ type: 'tts', id, text, sid: sid | 0, speed: speed || 1 });
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: 'timeout' }); } }, 60000);
}));
ipcMain.on('stt:start', (e, sid) => { if (engine && engineReady) engine.postMessage({ type: 'stt-start', sid }); else sendR('engine:stt', { type: 'stt-error', sid, error: 'engine-not-ready' }); });
ipcMain.on('stt:push', (e, sid, pcm) => { if (engine) engine.postMessage({ type: 'stt-push', sid, pcm }); });
ipcMain.on('stt:stop', (e, sid) => { if (engine) engine.postMessage({ type: 'stt-stop', sid }); });
ipcMain.on('stt:abort', (e, sid) => { if (engine) engine.postMessage({ type: 'stt-abort', sid }); });
ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, modelsDir: modelsDir(), userData: app.getPath('userData') }));
ipcMain.handle('app:openModels', () => shell.openPath(modelsDir()));
ipcMain.handle('app:resetModels', () => { try { fs.rmSync(modelsDir(), { recursive: true, force: true }); } catch (e) {} if (engine) { engine.kill(); engine = null; engineReady = false; } return true; });

/* ---------- 자동 업데이트 (GitHub Releases) ---------- */
function setupUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.on('update-downloaded', (info) => {
      sendR('app:update-ready', { version: info.version });
    });
    ipcMain.handle('app:installUpdate', () => autoUpdater.quitAndInstall());
    if (app.isPackaged) autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch (e) {}
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  setupPermissions();
  createWindow();
  if (models.status(modelsDir()).ready) startEngine();
  setupUpdater();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (engine) { try { engine.kill(); } catch (e) {} } });
