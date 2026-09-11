'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const listeners = { stt: new Set(), progress: new Set(), ready: new Set(), update: new Set(), exit: new Set() };
ipcRenderer.on('engine:stt', (e, m) => listeners.stt.forEach(f => f(m)));
ipcRenderer.on('models:progress', (e, p) => listeners.progress.forEach(f => f(p)));
ipcRenderer.on('engine:ready', (e, m) => listeners.ready.forEach(f => f(m)));
ipcRenderer.on('engine:exit', (e, m) => listeners.exit.forEach(f => f(m)));
ipcRenderer.on('app:update-ready', (e, m) => listeners.update.forEach(f => f(m)));

contextBridge.exposeInMainWorld('ocan', {
  desktop: true,
  info: () => ipcRenderer.invoke('app:info'),
  models: {
    status: () => ipcRenderer.invoke('models:status'),
    ensure: () => ipcRenderer.invoke('models:ensure'),
    onProgress: (f) => { listeners.progress.add(f); return () => listeners.progress.delete(f); },
    open: () => ipcRenderer.invoke('app:openModels'),
    reset: () => ipcRenderer.invoke('app:resetModels')
  },
  engine: {
    status: () => ipcRenderer.invoke('engine:status'),
    start: () => ipcRenderer.invoke('engine:start'),
    onReady: (f) => { listeners.ready.add(f); return () => listeners.ready.delete(f); },
    onExit: (f) => { listeners.exit.add(f); return () => listeners.exit.delete(f); }
  },
  tts: { speak: (text, sid, speed) => ipcRenderer.invoke('tts:speak', { text, sid, speed }) },
  stt: {
    start: (sid) => ipcRenderer.send('stt:start', sid),
    push: (sid, pcm) => ipcRenderer.send('stt:push', sid, pcm),
    stop: (sid) => ipcRenderer.send('stt:stop', sid),
    abort: (sid) => ipcRenderer.send('stt:abort', sid),
    on: (f) => { listeners.stt.add(f); return () => listeners.stt.delete(f); }
  },
  update: { onReady: (f) => { listeners.update.add(f); return () => listeners.update.delete(f); }, install: () => ipcRenderer.invoke('app:installUpdate') }
});
