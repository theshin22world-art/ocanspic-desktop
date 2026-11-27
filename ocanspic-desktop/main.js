/* ===== 오캔스픽 데스크톱 — Electron 메인 ===== */
'use strict';
const { app, BrowserWindow, ipcMain, session, utilityProcess, shell, dialog, Menu, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const models = require('./models');

let win = null, engine = null, engineReady = false;
const pending = new Map();      // tts id → resolve
const modelsDir = () => path.join(app.getPath('userData'), 'models');

/* 단일 인스턴스 + 딥링크 (ocanspic://auth?...) */
const PROTO = 'ocanspic';
if (process.defaultApp) { if (process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTO, process.execPath, [path.resolve(process.argv[1])]); }
else app.setAsDefaultProtocolClient(PROTO);
let pendingUrl = null;
function handleDeepLink(url) {
  if (!url || url.indexOf(PROTO + '://') !== 0) return;
  if (win && !win.isDestroyed()) { win.webContents.send('auth:callback', url); if (win.isMinimized()) win.restore(); win.focus(); }
  else pendingUrl = url;
}
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', (e, argv) => {
  const u = argv.find(a => a.indexOf(PROTO + '://') === 0); if (u) handleDeepLink(u);
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.on('open-url', (e, url) => { e.preventDefault(); handleDeepLink(url); });   // macOS

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 860, minWidth: 900, minHeight: 640,
    backgroundColor: '#FFFFFF',
    title: '오캔스픽',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  /* 2026-11-27 창 제목은 항상 「오캔스픽」 (페이지 <title> 이 바뀌어도 타이틀 바는 그대로) */
  win.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle('오캔스픽'); });
  win.on('closed', () => { win = null; });
  win.webContents.on('did-finish-load', () => { if (pendingUrl) { win.webContents.send('auth:callback', pendingUrl); pendingUrl = null; } const u = process.argv.find(a => a.indexOf(PROTO + '://') === 0); if (u) { win.webContents.send('auth:callback', u); } });
}
ipcMain.handle('app:openExternal', (e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return true; });

/* 마이크 권한: 한 번 허용하면 끝 (OS 권한은 별도) */
function setupPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const ok = ['media', 'audioCapture', 'clipboard-read', 'clipboard-sanitized-write', 'notifications'].includes(permission);
    /* 2026-11-27 macOS: 앱의 마이크 관문(79k_consent)이 처음 마이크를 열 때 macOS 마이크 허용 창을 한 번만 띄우고 그 결과를 그대로 쓴다 (이중 창 없음) */
    const wantsMic = permission === 'media' && (!details || !details.mediaTypes || details.mediaTypes.indexOf('audio') >= 0);
    if (ok && wantsMic && process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      systemPreferences.askForMediaAccess('microphone').then((g) => cb(!!g)).catch(() => cb(false));
      return;
    }
    cb(ok);
  });
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

/* ---------- 바탕화면 바로가기 (Windows) 2026-11-27 ----------
   Microsoft Store(MSIX/AppX) 설치본은 설치 때 바탕화면 아이콘이 생기지 않는다 → 앱에서 만들어 준다.
   · 스토어 설치본: explorer.exe shell:AppsFolder\<패키지 패밀리 이름>!<앱 ID> 로 연다 (설치 폴더가 업데이트마다 바뀌어도 동작)
   · 일반 설치본(NSIS 등): 실행 파일을 직접 가리킨다 */
const lnkPath = () => path.join(app.getPath('desktop'), '오캔스픽.lnk');
function storeAumid() {
  const m = process.execPath.match(/^(.*\\WindowsApps\\([^\\]+))\\/i);
  if (!m) return null;
  const parts = m[2].split('_');   /* 이름_버전_아키텍처_리소스ID_게시자ID */
  if (parts.length < 5) return null;
  let appId = 'OCansPic';   /* package.json build.appx.applicationId */
  try { const x = fs.readFileSync(path.join(m[1], 'AppxManifest.xml'), 'utf8').match(/<Application\b[^>]*\bId="([^"]+)"/); if (x) appId = x[1]; } catch (e) {}
  return parts[0] + '_' + parts[parts.length - 1] + '!' + appId;
}
function writeShortcut(op) {
  if (process.platform !== 'win32') return { ok: false, reason: 'platform' };
  let opts;
  if (process.windowsStore) {
    const id = storeAumid(); if (!id) return { ok: false, reason: 'store-id' };
    opts = { target: path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), args: 'shell:AppsFolder\\' + id, icon: process.execPath, iconIndex: 0, description: '오캔스픽' };
  } else {
    opts = { target: process.execPath, cwd: path.dirname(process.execPath), icon: process.execPath, iconIndex: 0, description: '오캔스픽' };
  }
  return { ok: shell.writeShortcutLink(lnkPath(), op, opts), store: !!process.windowsStore };
}
ipcMain.handle('shortcut:status', () => ({ supported: process.platform === 'win32', exists: process.platform === 'win32' && fs.existsSync(lnkPath()), store: !!process.windowsStore }));
ipcMain.handle('shortcut:create', () => { try { return writeShortcut(fs.existsSync(lnkPath()) ? 'replace' : 'create'); } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; } });
/* 스토어 업데이트로 설치 폴더가 바뀌면 바로가기 아이콘 경로도 새로 맞춘다 (이미 만든 바로가기가 있을 때만) */
function refreshShortcut() { try { if (process.platform === 'win32' && process.windowsStore && fs.existsSync(lnkPath())) writeShortcut('replace'); } catch (e) {} }

/* ---------- 자동 업데이트 (GitHub Releases) ---------- */
function setupUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.on('update-downloaded', (info) => {
      sendR('app:update-ready', { version: info.version });
    });
    ipcMain.handle('app:installUpdate', () => autoUpdater.quitAndInstall());
    /* Microsoft Store(appx) 설치본은 스토어가 업데이트를 맡는다 — GitHub 릴리스 확인 안 함 */
    if (app.isPackaged && !process.windowsStore) autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch (e) {}
}

app.whenReady().then(() => {
  /* 2026-11-27 macOS 는 메뉴가 있어야 Cmd+C · V · X · A · Z(편집), Cmd+Q(종료), Cmd+W(창 닫기)가 동작한다. Windows 는 메뉴 없음 그대로 */
  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  else Menu.setApplicationMenu(null);
  setupPermissions();
  createWindow();
  if (models.status(modelsDir()).ready) startEngine();
  setupUpdater();
  refreshShortcut();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (engine) { try { engine.kill(); } catch (e) {} } });
