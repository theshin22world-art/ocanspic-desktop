# 오캔스픽 데스크톱 (OCansPic Desktop)

Electron 으로 감싼 오캔스픽. 음성은 내장 엔진으로 처리한다 — 브라우저·OS 음성 설정이 필요 없다.

- 영어 음성(TTS): **Kokoro** (신경망, 11개 목소리, 24kHz)
- 음성 인식(STT): **Whisper base.en** + Silero VAD (오프라인)
- 모델(약 530MB)은 **최초 실행 때 한 번** 내려받아 `userData/models` 에 둔다. 이후 인터넷 없이 동작.

## 폴더

| 파일 | 역할 |
|---|---|
| `main.js` | Electron 메인. 창, 마이크 권한, 엔진 프로세스, IPC, 자동 업데이트 |
| `engine.js` | 유틸리티 프로세스. Kokoro·Whisper·VAD 를 여기서만 돌린다 (UI 안 막힘) |
| `models.js` | 모델 내려받기·풀기 (k2-fsa/sherpa-onnx 릴리스에서 직접) |
| `preload.js` | `window.ocan` 브리지 |
| `renderer/native-bridge.js` | 브라우저 `SpeechRecognition` / `ttsSpeak` 을 내장 엔진으로 바꿔 끼움 + 최초 설치 화면 |
| `renderer/index.html` | 앱 본체 (`../dist2/opic-simulator.html` 을 `sync.js` 가 복사) |
| `.github/workflows/release.yml` | 태그를 올리면 Windows·Mac 설치 파일을 만들어 GitHub Release 에 올림 |

## 로컬 실행

```bash
npm install
npm start          # 처음엔 모델 내려받기 화면이 뜬다
```

## 배포 (설치 파일 만들기)

1. GitHub 에 `ocanspic-desktop` 저장소를 만들고 이 폴더를 올린다 (`node_modules/`, `models/`, `release/` 제외 — .gitignore 에 있음).
2. 저장소 **Settings → Secrets and variables → Actions** 에 Mac 서명용 값을 넣는다 (없으면 Mac 은 서명 없이 빌드되고 사용자가 «확인되지 않은 개발자» 경고를 본다).

   | Secret | 값 |
   |---|---|
   | `MAC_CERT_P12_BASE64` | Developer ID Application 인증서(.p12)를 base64 로: `base64 -i cert.p12 \| pbcopy` |
   | `MAC_CERT_PASSWORD` | .p12 내보낼 때 정한 비밀번호 |
   | `APPLE_ID` | Apple 개발자 계정 이메일 |
   | `APPLE_APP_SPECIFIC_PASSWORD` | appleid.apple.com → 앱 암호 생성 |
   | `APPLE_TEAM_ID` | developer.apple.com → Membership 의 Team ID |

3. 버전을 올리고 태그를 푸시하면 자동으로 빌드·릴리스된다.
   ```bash
   npm version 1.0.0        # package.json 버전 = 태그
   git push && git push --tags
   ```
   Actions 가 끝나면 Releases 에 다음 파일이 생긴다.
   - `OCansPic-win-x64.exe` (Windows 설치 파일)
   - `OCansPic-mac-universal.dmg` (Intel·Apple Silicon 공용)
   - `latest.yml`, `latest-mac.yml` (자동 업데이트용 — 지우지 말 것)

4. 홈페이지 다운로드 버튼은 항상 최신 릴리스를 가리킨다.
   - `https://github.com/theshin22world-art/ocanspic-desktop/releases/latest/download/OCansPic-win-x64.exe`
   - `https://github.com/theshin22world-art/ocanspic-desktop/releases/latest/download/OCansPic-mac-universal.dmg`

## 앱 본체를 고쳤을 때

`../dist2/opic-simulator.html` 을 새로 빌드한 뒤 `node sync.js` → `renderer/index.html` 갱신 → 커밋 → 버전 올려 태그. 설치된 앱은 다음 실행 때 자동으로 새 버전을 받는다.

## 알아 둘 것

- Windows 는 코드 서명이 없어서 처음 실행 때 SmartScreen 경고가 뜬다 («추가 정보 → 실행»). 없애려면 EV/OV 코드 서명 인증서가 필요하다.
- 모델 저장 위치: Windows `%APPDATA%\ocanspic-desktop\models`, Mac `~/Library/Application Support/ocanspic-desktop/models`. 지우면 다음 실행 때 다시 받는다.
- 음성 인식 정확도를 올리고 싶으면 `models.js` 의 whisper 팩을 `small.en` 으로 바꾸면 된다 (다운로드 +430MB, 채점 2배 느림).
