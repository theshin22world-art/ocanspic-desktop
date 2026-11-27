/* ===== 오캔스픽 데스크톱 브리지 — 브라우저 음성 API 를 내장 엔진(Kokoro · Whisper)으로 바꿔 끼운다 =====
   앱 스크립트보다 먼저 로드된다. */
(function () {
  'use strict';
  if (!window.ocan || !window.ocan.desktop) return;
  var O = window.ocan;
  window.IS_DESKTOP = true;

  /* ---------- 엔진 준비 상태 ---------- */
  var engineReady = false, readyWaiters = [];
  function whenEngine() { return engineReady ? Promise.resolve() : new Promise(function (r) { readyWaiters.push(r); }); }
  O.engine.onReady(function () {
    engineReady = true; readyWaiters.splice(0).forEach(function (f) { f(); }); paintSetup();
    setTimeout(function () { try { var v = chosen(); O.tts.speak('Hi, welcome back.', v.sid, 1).catch(function () {}); } catch (e) {} }, 400);   // 워밍업
  });
  O.engine.onExit(function () { engineReady = false; setTimeout(function () { O.engine.start(); }, 1500); });   // 죽으면 다시 띄운다
  O.engine.status().then(function (s) { if (s.ready) { engineReady = true; readyWaiters.splice(0).forEach(function (f) { f(); }); } });

  /* ---------- 음성 인식: SpeechRecognition 호환 셸 ---------- */
  var micStream = null, micCtx = null, seq = 0, live = {};
  function getMic() {
    if (micStream && micStream.active) return Promise.resolve(micStream);
    return navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(function (s) { micStream = s; return s; });
  }
  O.stt.on(function (m) {
    var r = live[m.sid]; if (!r) return;
    if (m.type === 'stt-started') { r._started = true; r.onstart && r.onstart({}); }
    else if (m.type === 'stt-result') {
      if (!m.text) return;
      var alt = { transcript: m.text, confidence: 0.92 };
      var res = [alt]; res.isFinal = true; res.length = 1;
      var list = [res]; list.length = 1;
      r.onresult && r.onresult({ resultIndex: 0, results: list });
    }
    else if (m.type === 'stt-speech') { r.onspeechstart && m.speaking && r.onspeechstart({}); }
    else if (m.type === 'stt-ended') { r._teardown(); delete live[m.sid]; r.onend && r.onend({}); }
    else if (m.type === 'stt-error') { r.onerror && r.onerror({ error: 'audio-capture', message: m.error }); r._teardown(); delete live[m.sid]; r.onend && r.onend({}); }
  });
  function NativeSR() {
    this.lang = 'en-US'; this.continuous = true; this.interimResults = true; this.maxAlternatives = 1;
    this._sid = 0; this._node = null; this._src = null; this._started = false; this._stopping = false;
  }
  NativeSR.prototype.start = function () {
    var self = this;
    if (self._sid) throw new DOMException('already started', 'InvalidStateError');
    self._sid = ++seq; live[self._sid] = self; self._stopping = false;
    whenEngine().then(getMic).then(function (stream) {
      if (!live[self._sid]) return;
      micCtx = micCtx || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      if (micCtx.state === 'suspended') micCtx.resume();
      self._src = micCtx.createMediaStreamSource(stream);
      self._node = micCtx.createScriptProcessor(4096, 1, 1);
      var sid = self._sid;
      self._node.onaudioprocess = function (e) {
        if (!live[sid] || self._stopping) return;
        var ch = e.inputBuffer.getChannelData(0);
        O.stt.push(sid, new Float32Array(ch));
      };
      self._src.connect(self._node); self._node.connect(micCtx.destination);   // destination 연결이 있어야 콜백이 돈다 (출력은 0)
      O.stt.start(sid);
    }).catch(function (e) {
      var err = (e && e.name === 'NotAllowedError') ? 'not-allowed' : 'audio-capture';
      self.onerror && self.onerror({ error: err, message: String(e && e.message || e) });
      delete live[self._sid]; self._sid = 0;
      self.onend && self.onend({});
    });
  };
  NativeSR.prototype._teardown = function () {
    try { if (this._node) { this._node.disconnect(); this._node.onaudioprocess = null; } if (this._src) this._src.disconnect(); } catch (e) {}
    this._node = null; this._src = null; this._sid = 0; this._started = false;
    /* 살아 있는 인식 세션이 하나도 없으면 마이크를 실제로 반납한다 (정답 화면에서 마이크 표시가 꺼지도록) */
    var self = this;
    setTimeout(function () {
      if (Object.keys(live).length) return;
      try { if (micStream) micStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      micStream = null;
    }, 50);
  };
  NativeSR.prototype.stop = function () { if (!this._sid) return; this._stopping = true; O.stt.stop(this._sid); };
  NativeSR.prototype.abort = function () { if (!this._sid) return; var sid = this._sid; this._stopping = true; O.stt.abort(sid); };
  window.SpeechRecognition = NativeSR;
  window.webkitSpeechRecognition = NativeSR;

  /* ---------- TTS: Kokoro ---------- */
  var VOICES = [
    { sid: 3, name: 'Kokoro · Sarah', lang: 'en-US', d: '미국 여성 · 차분' },
    { sid: 1, name: 'Kokoro · Bella', lang: 'en-US', d: '미국 여성 · 밝음' },
    { sid: 2, name: 'Kokoro · Nicole', lang: 'en-US', d: '미국 여성 · 부드러움' },
    { sid: 4, name: 'Kokoro · Sky', lang: 'en-US', d: '미국 여성' },
    { sid: 0, name: 'Kokoro · Default', lang: 'en-US', d: '미국 여성 · 기본 혼합' },
    { sid: 5, name: 'Kokoro · Adam', lang: 'en-US', d: '미국 남성' },
    { sid: 6, name: 'Kokoro · Michael', lang: 'en-US', d: '미국 남성 · 낮음' },
    { sid: 7, name: 'Kokoro · Emma', lang: 'en-GB', d: '영국 여성' },
    { sid: 8, name: 'Kokoro · Isabella', lang: 'en-GB', d: '영국 여성' },
    { sid: 9, name: 'Kokoro · George', lang: 'en-GB', d: '영국 남성' },
    { sid: 10, name: 'Kokoro · Lewis', lang: 'en-GB', d: '영국 남성' }
  ].map(function (v) { v.voiceURI = 'kokoro:' + v.sid; v.localService = true; v.default = v.sid === 3; return v; });
  var outCtx = null, curSrc = null, curToken = 0;
  function ctx() { outCtx = outCtx || new (window.AudioContext || window.webkitAudioContext)(); if (outCtx.state === 'suspended') outCtx.resume(); return outCtx; }
  function chosen() {
    var want = window.store ? (window.store.s().voiceURI || '') : '';
    return VOICES.find(function (v) { return v.voiceURI === want; }) || VOICES[0];
  }
  function splitSentences(t) {
    var parts = String(t).replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [t];
    // 너무 짧은 조각은 앞과 합친다
    var out = []; parts.forEach(function (p) { p = p.trim(); if (!p) return; if (out.length && p.split(' ').length < 3) out[out.length - 1] += ' ' + p; else out.push(p); });
    return out;
  }
  function decodePcm16(b64) {
    var bin = atob(b64), n = bin.length >> 1, out = new Float32Array(n);
    for (var i = 0; i < n; i++) { var v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8); if (v & 0x8000) v -= 0x10000; out[i] = v / 32768; }
    return out;
  }
  function playBuf(samples, sr, token) {
    return new Promise(function (res) {
      if (token !== curToken) return res(false);
      var c = ctx(), b = c.createBuffer(1, samples.length, sr);
      b.getChannelData(0).set(samples);
      var s = c.createBufferSource(); s.buffer = b; s.connect(c.destination);
      curSrc = s; s.onended = function () { if (curSrc === s) curSrc = null; res(true); }; s.start();
    });
  }
  function installTts() {
    window.ttsVoices = function () { return VOICES.slice(); };
    window.ttsVoice = chosen;
    window.ttsRank = function () { return 100; };
    window.ttsLabel = function (v) { return { name: v.name + ' (' + (v.d || v.lang) + ')', tag: '신경망 · 오프라인', q: 100 }; };
    window.ttsStatus = function () { return { supported: true, ready: engineReady, count: VOICES.length, voice: chosen(), usable: true }; };
    window.ttsAdvice = function () { return ['<b>오캔스픽 데스크톱은 내장 신경망 음성(Kokoro)을 씁니다.</b> 인터넷이 없어도 재생되고, 위 목록에서 목소리를 고를 수 있습니다. 브라우저·OS 음성 설정은 필요 없습니다.']; };
    window.ttsCancel = function () { curToken++; try { if (curSrc) curSrc.stop(); } catch (e) {} curSrc = null; window.__ttsBusy = false; };
    window.ttsRelease = function () { window.__ttsBusy = false; };
    /* 미리 합성 — 엔진 캐시에만 넣고 재생하지 않는다 */
    window.ttsPrefetch = function (text) {
      if (!text) return;
      var v = chosen(), rate = window.store ? (window.store.s().rate || 0.95) : 0.95;
      whenEngine().then(function () { splitSentences(text).forEach(function (s) { O.tts.speak(s, v.sid, rate).catch(function () {}); }); });
    };
    window.ttsSpeak = function (text, opts) {
      opts = opts || {};
      var v = chosen(), rate = opts.rate || (window.store ? (window.store.s().rate || 0.95) : 0.95);
      window.ttsCancel();
      var token = ++curToken;
      window.__ttsBusy = true;
      var sents = splitSentences(text);
      // 다음 문장을 미리 합성해 두고 현재 문장을 재생한다
      var reqs = sents.map(function () { return null; });
      function req(i) { if (i < sents.length && !reqs[i]) reqs[i] = O.tts.speak(sents[i], v.sid, rate); return reqs[i]; }
      return whenEngine().then(function () {
        req(0);
        var chain = Promise.resolve(true);
        sents.forEach(function (s, i) {
          chain = chain.then(function (ok) {
            if (!ok || token !== curToken) return false;
            req(i + 1);
            return req(i).then(function (r) {
              if (!r || r.error || token !== curToken) return false;
              return playBuf(decodePcm16(r.pcm16), r.sampleRate, token);
            });
          });
        });
        return chain;
      }).then(function (ok) { if (token === curToken) window.__ttsBusy = false; return !!ok; })
        .catch(function () { window.__ttsBusy = false; return false; });
    };
  }
  /* 앱 스크립트가 모두 실행된 뒤 덮어쓴다 */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installTts); else installTts();
  setTimeout(installTts, 0);

  /* ---------- 음성 엔진 준비 화면 (최초 1회 내려받기 · 실행 때 잠깐 준비) ----------
     2026-11-27 9월 어두운 박스를 오캔스픽 라이트 디자인으로 교체. 데스크톱 전용 마이크 점검 화면은 삭제
     (마이크 확인은 앱 공통 동의 · 마이크 관문 79k_consent 하나로) */
  var setupEl = null, lastP = null, setupErr = null, setupDone = false;
  function fmtMB(b) { return (b / 1048576).toFixed(b > 100e6 ? 0 : 1) + 'MB'; }
  function paintSetup() {
    if (!setupEl) return;
    if (setupDone && engineReady) { setupEl.remove(); setupEl = null; return; }
    var h = '<div class="ocs-box"><div class="ocs-mk">오캔스픽<i></i></div>';
    if (!setupDone) {
      h += '<h2>처음 한 번, 음성 엔진을 내려받습니다</h2>'
        + '<p>영어 음성(Kokoro)과 음성 인식(Whisper)을 이 PC에 설치합니다. 약 530MB, 한 번만 받으면 이후엔 인터넷 없이도 동작합니다.</p>';
      if (setupErr) h += '<p class="ocs-err">내려받기에 실패했습니다: ' + esc(setupErr) + '</p><button class="ocs-btn" id="ocsRetry">다시 시도</button>';
      else if (lastP) {
        var pct = Math.round(lastP.overall * 100);
        h += '<div class="ocs-bar"><i style="width:' + pct + '%"></i></div>'
          + '<div class="ocs-row"><span>' + esc(lastP.name) + (lastP.phase === 'done' ? ' 완료' : '') + '</span><span>' + fmtMB(lastP.received) + ' / ' + fmtMB(lastP.total) + ' · 전체 ' + pct + '%</span></div>'
          + '<p class="ocs-dim">받으면서 바로 풀기 때문에 마지막에 잠시 멈춘 것처럼 보일 수 있습니다. 창을 닫지 마세요.</p>';
      } else h += '<div class="ocs-bar"><i style="width:0"></i></div><div class="ocs-row"><span>연결 중…</span><span></span></div>';
    } else {
      h += '<h2>음성 엔진을 준비하고 있습니다</h2><p>처음 켤 때 몇 초 걸립니다.</p><div class="ocs-bar ind"><i></i></div>';
    }
    h += '</div>';
    setupEl.innerHTML = h;
    var rb = document.getElementById('ocsRetry'); if (rb) rb.onclick = function () { setupErr = null; lastP = null; paintSetup(); runSetup(); };
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '"': '&quot;', '>': '&gt;' }[c]; }); }
  function runSetup() {
    O.models.ensure().then(function (st) { setupDone = true; paintSetup(); O.engine.start(); }).catch(function (e) { setupErr = (e && e.message) || String(e); paintSetup(); });
  }
  var cssDone = false;
  function addCss() {
    if (cssDone) return; cssDone = true;
    var css = document.createElement('style');
    css.textContent = '.ocs{position:fixed;inset:0;z-index:9000;background:#FFFFFF;color:#20213B;display:flex;align-items:center;justify-content:center;padding:24px;font-family:inherit;word-break:keep-all;letter-spacing:-.02em}'
      + '.ocs-box{max-width:460px;width:100%}'
      + '.ocs-mk{display:inline-flex;align-items:flex-end;gap:3px;margin-bottom:22px;font-size:15px;font-weight:800;color:#6E62B4;letter-spacing:-.04em}'
      + '.ocs-mk i{width:6px;height:6px;border-radius:50%;background:#D9EDB6;margin-bottom:4px}'
      + '.ocs h2{margin:0 0 8px;font-size:21px;font-weight:800;line-height:1.35;letter-spacing:-.04em;color:#20213B}'
      + '.ocs p{margin:0 0 22px;color:#5E6075;font-size:14px;line-height:1.65}'
      + '.ocs-bar{height:4px;background:#EEEFF3;border-radius:0;overflow:hidden}.ocs-bar i{display:block;height:100%;background:#6E62B4;border-radius:0;transition:width .3s}'
      + '.ocs-bar.ind i{width:28%;animation:ocsind 1.2s ease-in-out infinite}@keyframes ocsind{0%{transform:translateX(-100%)}100%{transform:translateX(360%)}}'
      + '.ocs-row{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;color:#8B8FA3;margin-top:10px;font-variant-numeric:tabular-nums}'
      + '.ocs-dim{color:#8B8FA3!important;font-size:12px!important;margin:14px 0 0!important}'
      + '.ocs-err{color:#E5484D!important;font-size:13px!important;margin:0 0 14px!important}'
      + '.ocs-btn{height:44px;padding:0 22px;background:#20213B;color:#fff;border:0;border-radius:999px;font:inherit;font-size:15px;font-weight:700;letter-spacing:-.02em;cursor:pointer}'
      + '@media (prefers-reduced-motion:reduce){.ocs-bar.ind i{animation:none;width:100%}}'
      /* 바탕화면 바로가기 안내 배너 (Windows 첫 실행 1회) */
      + '.ocsc{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:8000;width:min(480px,calc(100vw - 32px));box-sizing:border-box;display:flex;align-items:center;gap:14px;padding:14px 12px 14px 18px;background:#FFFFFF;border:1px solid #E6E7EE;border-radius:14px;box-shadow:0 10px 30px rgba(32,33,59,.14);font-family:inherit;color:#20213B;word-break:keep-all;letter-spacing:-.02em}'
      + '.ocsc .t{flex:1;min-width:0;font-size:13px;line-height:1.5;color:#5E6075}.ocsc .t b{display:block;font-size:14.5px;font-weight:800;color:#20213B;letter-spacing:-.03em}'
      + '.ocsc .go{flex:none;height:38px;padding:0 16px;border:0;border-radius:999px;background:#20213B;color:#fff;font:inherit;font-size:13.5px;font-weight:700;cursor:pointer}'
      + '.ocsc .x{flex:none;width:30px;height:30px;border:0;background:none;color:#8B8FA3;display:grid;place-items:center;cursor:pointer;padding:0}.ocsc .x svg{width:16px;height:16px}';
    document.head.appendChild(css);
  }
  function mountSetup() {
    addCss();
    setupEl = document.createElement('div'); setupEl.className = 'ocs'; document.body.appendChild(setupEl);
    paintSetup();
  }
  O.models.onProgress(function (p) { lastP = p; paintSetup(); });
  O.engine.status().then(function (s) { if (s.ready) paintSetup(); });   /* 준비 화면을 띄운 뒤 엔진이 이미 켜져 있었으면 바로 닫는다 */
  function boot() {
    O.models.status().then(function (st) {
      if (st.ready) { setupDone = true; if (!engineReady) mountSetup(); }
      else { mountSetup(); runSetup(); }
      shortcutBoot();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  /* ---------- 바탕화면 바로가기 (Windows) 2026-11-27 ----------
     설정 › 편의 에 「바탕화면에 바로가기 만들기」, 첫 실행 때 한 번 안내 배너 */
  function sayToast(m) { if (window.toast) window.toast(m); }
  function makeShortcut() {
    return O.shortcut.create().then(function (r) {
      if (r && r.ok) { sayToast('바탕화면에 오캔스픽 아이콘을 만들었어요!'); return true; }
      sayToast('바로가기를 만들지 못했어요. 잠시 뒤 다시 시도해 주세요.'); return false;
    }, function () { sayToast('바로가기를 만들지 못했어요. 잠시 뒤 다시 시도해 주세요.'); return false; });
  }
  function addSettingsRow() {
    if (document.getElementById('setShortcut')) return;
    var pane = document.querySelector('.setpane[data-pane="conv"]'); if (!pane) return;
    var caps = pane.querySelectorAll('.setcap'), before = caps.length ? caps[caps.length - 1] : null;
    var cap = document.createElement('div'); cap.className = 'setcap'; cap.textContent = '바탕화면';
    var row = document.createElement('div'); row.className = 'set';
    row.innerHTML = '<button type="button" class="setlink" id="setShortcut">바탕화면에 바로가기 만들기<i></i></button>';
    if (before) { pane.insertBefore(cap, before); pane.insertBefore(row, before); } else { pane.appendChild(cap); pane.appendChild(row); }
    document.getElementById('setShortcut').onclick = function () { makeShortcut(); };
  }
  var TIP = 'ocan_shortcut_tip_v1';
  function showTip() {
    /* 음성 엔진 준비 화면 · 약관/마이크 관문 · 팝업이 모두 닫히고 홈 화면일 때만 (첫 실행 흐름을 가리지 않게) */
    var home = document.querySelector('section.screen.on');
    var obOn = window.quest && window.quest.obDone && !window.quest.obDone();   /* 첫날 온보딩 안내 중이면 끝난 뒤에 */
    if (setupEl || obOn || document.querySelector('#cgGate.on, .mask.on') || !home || home.id !== 'sc-title') { setTimeout(showTip, 3000); return; }
    try { if (localStorage.getItem(TIP)) return; localStorage.setItem(TIP, '1'); } catch (e) { return; }
    addCss();
    var b = document.createElement('div'); b.className = 'ocsc'; b.setAttribute('role', 'region'); b.setAttribute('aria-label', '바탕화면 바로가기 안내');
    b.innerHTML = '<div class="t"><b>바탕화면에 오캔스픽 아이콘을 만들어 둘까요?</b>다음부터 바탕화면에서 바로 실행할 수 있어요.</div>'
      + '<button type="button" class="go">만들기</button>'
      + '<button type="button" class="x" aria-label="닫기"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m3.5 3.5 9 9M12.5 3.5l-9 9"/></svg></button>';
    document.body.appendChild(b);
    b.querySelector('.x').onclick = function () { b.remove(); };
    b.querySelector('.go').onclick = function () { b.remove(); makeShortcut(); };
  }
  function shortcutBoot() {
    if (!O.shortcut) return;
    O.shortcut.status().then(function (st) {
      if (!st || !st.supported) return;   /* Windows 만 */
      addSettingsRow();
      if (!st.exists) setTimeout(showTip, 4000);
    }).catch(function () {});
  }

  /* ---------- 업데이트 ---------- */
  O.update.onReady(function (info) {
    if (window.toast) window.toast('새 버전 ' + info.version + '이(가) 준비됐습니다. 앱을 다시 시작하면 적용됩니다.');
  });
})();
