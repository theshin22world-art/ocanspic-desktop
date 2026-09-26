/* dist2/opic-simulator.html → renderer/index.html (브리지 스크립트를 앱 스크립트보다 앞에 끼워 넣는다) */
const fs = require('fs'), path = require('path');
const src = path.join(__dirname, '..', 'dist2', 'opic-simulator.html');
const out = path.join(__dirname, 'renderer', 'index.html');
if (!fs.existsSync(src)) { if (fs.existsSync(out)) { console.log('renderer/index.html 그대로 사용 (dist2 없음)'); process.exit(0); } throw new Error('dist2/opic-simulator.html 이 없습니다'); }
let html = fs.readFileSync(src, 'utf8');
const tag = '<script src="native-bridge.js"></script>';
if (html.indexOf(tag) < 0) {
  const i = html.indexOf('<script');
  if (i < 0) throw new Error('no <script> in app html');
  html = html.slice(0, i) + tag + '\n' + html.slice(i);
}
fs.mkdirSync(path.join(__dirname, 'renderer'), { recursive: true });
fs.writeFileSync(out, html);
console.log('renderer/index.html', (html.length / 1024 | 0) + 'KB');
