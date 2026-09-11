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

  /* ---------- 최초 1회: 모델 내려받기 화면 ---------- */
  var setupEl = null, lastP = null, setupErr = null, setupDone = false;
  function fmtMB(b) { return (b / 1048576).toFixed(b > 100e6 ? 0 : 1) + 'MB'; }
  var micChecked = false; try { micChecked = localStorage.getItem('ocan_mic_ok') === '1'; } catch (e) {}
  var micStage = null;   // null | 'ask' | 'listen' | 'ok' | 'fail'
  function paintSetup() {
    if (!setupEl) return;
    if (setupDone && engineReady && !micChecked) { paintMic(); return; }
    if (setupDone && engineReady) { setupEl.remove(); setupEl = null; return; }
    var h = '<div class="ocs-box"><div class="ocs-k">FIRST RUN · SPEECH ENGINE</div>';
    if (!setupDone) {
      h += '<h2>처음 한 번, 음성 엔진을 내려받습니다</h2>'
        + '<p>영어 음성(Kokoro)과 음성 인식(Whisper)을 이 PC에 설치합니다. 약 530MB, 한 번만 받으면 이후엔 인터넷 없이도 동작합니다.</p>';
      if (setupErr) h += '<div class="ocs-err">내려받기에 실패했습니다: ' + esc(setupErr) + '</div><button class="ocs-btn" id="ocsRetry">다시 시도</button>';
      else if (lastP) {
        var pct = Math.round(lastP.overall * 100);
        h += '<div class="ocs-bar"><i style="width:' + pct + '%"></i></div>'
          + '<div class="ocs-row"><span>' + esc(lastP.name) + (lastP.phase === 'done' ? ' ✓' : '') + '</span><span>' + fmtMB(lastP.received) + ' / ' + fmtMB(lastP.total) + ' · 전체 ' + pct + '%</span></div>'
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
  /* ---- 첫 실행 마이크 점검 ---- */
  var micTimer = null, micPeak = 0;
  function paintMic() {
    if (!setupEl) return;
    if (!micStage) micStage = 'ask';
    var h = '<div class="ocs-box"><div class="ocs-k">FIRST RUN · MICROPHONE</div>';
    if (micStage === 'ask') h += '<h2>마이크를 한 번만 확인할게요</h2><p>말하기 채점과 녹음에 마이크가 필요합니다. 아래 버튼을 누르면 권한 창이 한 번 뜨고, 3초 동안 아무 말이나 해 보세요.</p><button class="ocs-btn" id="ocsMic">🎙 마이크 확인 시작</button>';
    else if (micStage === 'listen') h += '<h2>지금 말해 보세요</h2><p>"Hello, my name is…" 정도면 충분합니다.</p><div class="ocs-bar"><i id="ocsLvl" style="width:0;transition:width .08s"></i></div><div class="ocs-row"><span>입력 레벨</span><span id="ocsLvlTxt">듣는 중…</span></div>';
    else if (micStage === 'ok') h += '<h2>잘 들립니다 ✓</h2><p>준비 끝. 이제 시작합니다.</p><button class="ocs-btn" id="ocsGo">시작하기</button>';
    else h += '<h2>소리가 잡히지 않았습니다</h2><p>Windows 설정 → 개인 정보 → 마이크에서 앱 접근이 켜져 있는지, 헤드셋이 기본 장치인지 확인한 뒤 다시 시도하세요. 지금은 건너뛰고 나중에 설정 → 마이크 진단에서 확인해도 됩니다.</p><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><button class="ocs-btn" id="ocsMic">다시 시도</button><button class="ocs-btn" id="ocsSkip" style="background:#2a3140">건너뛰기</button></div>';
    h += '</div>'; setupEl.innerHTML = h;
    var b = document.getElementById('ocsMic'); if (b) b.onclick = startMicCheck;
    var g = document.getElementById('ocsGo'); if (g) g.onclick = finishMic;
    var sk = document.getElementById('ocsSkip'); if (sk) sk.onclick = finishMic;
  }
  function finishMic() { micChecked = true; try { localStorage.setItem('ocan_mic_ok', '1'); } catch (e) {} if (setupEl) { setupEl.remove(); setupEl = null; } }
  function startMicCheck() {
    micStage = 'listen'; micPeak = 0; paintMic();
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var c = new (window.AudioContext || window.webkitAudioContext)(); var src = c.createMediaStreamSource(stream); var an = c.createAnalyser(); an.fftSize = 1024; src.connect(an);
      var buf = new Float32Array(an.fftSize), t0 = Date.now();
      micTimer = setInterval(function () {
        an.getFloatTimeDomainData(buf); var s = 0; for (var i = 0; i < buf.length; i++) s += buf[i] * buf[i]; var rms = Math.sqrt(s / buf.length);
        micPeak = Math.max(micPeak, rms);
        var el = document.getElementById('ocsLvl'); if (el) el.style.width = Math.min(100, rms * 900) + '%';
        var tx = document.getElementById('ocsLvlTxt'); if (tx) tx.textContent = Math.max(0, 3 - Math.floor((Date.now() - t0) / 1000)) + '초';
        if (Date.now() - t0 > 3200) { clearInterval(micTimer); stream.getTracks().forEach(function (t) { t.stop(); }); try { c.close(); } catch (e) {} micStage = micPeak > 0.01 ? 'ok' : 'fail'; paintMic(); }
      }, 80);
    }).catch(function () { micStage = 'fail'; paintMic(); });
  }
  function runSetup() {
    O.models.ensure().then(function (st) { setupDone = true; paintSetup(); O.engine.start(); }).catch(function (e) { setupErr = (e && e.message) || String(e); paintSetup(); });
  }
  function mountSetup() {
    var css = document.createElement('style');
    css.textContent = '.ocs{position:fixed;inset:0;z-index:9000;background:#0f1115;color:#e8ebf2;display:flex;align-items:center;justify-content:center;padding:24px;font-family:inherit}'
      + '.ocs-box{max-width:520px;width:100%;background:#161a21;border:1px solid #272d39;border-radius:18px;padding:28px 28px 24px}'
      + '.ocs-k{font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.14em;color:#5b8cff;margin-bottom:10px}'
      + '.ocs h2{margin:0 0 8px;font-size:20px}.ocs p{margin:0 0 16px;color:#98a1b2;font-size:14px;line-height:1.6}'
      + '.ocs-bar{height:8px;background:#1c212a;border-radius:4px;overflow:hidden}.ocs-bar i{display:block;height:100%;background:#5b8cff;transition:width .3s}'
      + '.ocs-bar.ind i{width:30%;animation:ocsind 1.2s ease-in-out infinite}@keyframes ocsind{0%{transform:translateX(-100%)}100%{transform:translateX(340%)}}'
      + '.ocs-row{display:flex;justify-content:space-between;font-size:12.5px;color:#98a1b2;margin-top:8px;font-family:ui-monospace,Menlo,monospace}'
      + '.ocs-dim{color:#6b7484!important;font-size:12px!important;margin-top:12px!important}'
      + '.ocs-err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.4);border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:12px}'
      + '.ocs-btn{background:#5b8cff;color:#fff;border:0;border-radius:10px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}';
    document.head.appendChild(css);
    setupEl = document.createElement('div'); setupEl.className = 'ocs'; document.body.appendChild(setupEl);
    paintSetup();
  }
  O.models.onProgress(function (p) { lastP = p; paintSetup(); });
  function boot() {
    O.models.status().then(function (st) {
      if (st.ready) { setupDone = true; if (!engineReady || !micChecked) { mountSetup(); } return; }
      mountSetup(); runSetup();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  /* ---------- 업데이트 ---------- */
  O.update.onReady(function (info) {
    if (window.toast) window.toast('새 버전 ' + info.version + '이(가) 준비됐습니다. 앱을 다시 시작하면 적용됩니다.');
  });
})();
