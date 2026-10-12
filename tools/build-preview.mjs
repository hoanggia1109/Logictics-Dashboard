#!/usr/bin/env node
// build-preview.mjs — gộp giao diện + lõi nghiệp vụ + "máy chủ trong trình duyệt" thành MỘT file HTML xem thử.
// Bản xem thử chạy đúng lõi nghiệp vụ của máy chủ (core/*.js) trên kho bộ nhớ, nên hành vi giống bản cài thật;
// khác biệt: không có máy chủ, không lưu gì, GPS của vai FO là giả lập, nền bản đồ là sơ đồ ô lưới.
//   node tools/build-preview.mjs [đường-dẫn-ra] [--inline-leaflet]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const inlineLeaflet = args.includes('--inline-leaflet'); // để kiểm thử không cần mạng
const outFile = args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'preview', 'atlas-ops-hub-demo.html');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const noScriptEnd = (s) => s.replace(/<\/script/gi, '<\\/script');

// 1) Lõi nghiệp vụ: mỗi module chạy trong khối riêng (không trùng tên giữa các module), import/export đổi thành bảng tra __ex.
//    Hàm được import qua lớp gọi trễ (vòng phụ thuộc core ↔ hub chỉ dùng hàm lúc chạy); hằng số cần module nguồn chạy trước.
const MODULES = ['core/util', 'core/terms', 'core/schema', 'core/store-ver', 'core/store-memory', 'core/tasks', 'core/core',
  'core/hub/defs', 'core/hub/period', 'core/hub/stock', 'core/hub/outlets', 'core/hub/jobs', 'core/hub/cards', 'core/hub/incidents', 'core/hub/people', 'core/hub/report', 'core/hub/importer', 'core/hub/index',
  'core/demo-assets', 'core/demo', ...(fs.existsSync(path.join(ROOT, 'core/hub/demo.js')) ? ['core/hub/demo'] : [])];
function bundleCore(mods) {
  const srcs = new Map(mods.map((m) => [m, read(`${m}.js`)]));
  const exportsOf = new Map();
  for (const [m, src] of srcs) {
    const fns = new Set(), all = [];
    for (const x of src.matchAll(/^export\s+(async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm)) { fns.add(x[2]); all.push(x[2]); }
    for (const x of src.matchAll(/^export\s+(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) all.push(x[1]);
    if (/^export\s+(default|\{|\*)/m.test(src)) throw new Error(`${m}.js dùng kiểu export công cụ gộp chưa hỗ trợ`);
    exportsOf.set(m, { fns, all });
  }
  const resolveSpec = (from, spec) => path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)).replace(/\.js$/, '');
  let out = 'const __ex = Object.create(null);\n';
  const done = new Set();
  for (const [m, src0] of srcs) {
    let src = src0.replace(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?[ \t]*$/gm, (_, list, spec) => {
      const t = resolveSpec(m, spec);
      if (!exportsOf.has(t)) throw new Error(`${m}.js import '${spec}' không có trong bản gộp`);
      return list.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
        const [name, alias] = x.split(/\s+as\s+/);
        if (!exportsOf.get(t).all.includes(name)) throw new Error(`${t}.js không export ${name} (cần cho ${m}.js)`);
        if (exportsOf.get(t).fns.has(name)) return `const ${alias || name} = (...a) => __ex['${t}'].${name}(...a);`;
        if (!done.has(t)) throw new Error(`${m}.js cần hằng số ${name} của ${t}.js, nhưng ${t}.js đứng sau trong thứ tự gộp`);
        return `const ${alias || name} = __ex['${t}'].${name};`;
      }).join(' ');
    });
    if (/^import\s/m.test(src)) throw new Error(`${m}.js còn lệnh import công cụ gộp chưa hiểu (import nhiều dòng hoặc import thư viện ngoài)`);
    src = src.replace(/^export\s+(?=(async\s+)?(function|const|let|class)\b)/gm, '');
    out += `\n// ── ${m}.js ──\n{\n${src}\n__ex['${m}'] = { ${exportsOf.get(m).all.join(', ')} };\n}\n`;
    done.add(m);
  }
  return out;
}
let coreSrc = bundleCore(MODULES);
const pick = (m, n) => `__ex['${m}'].${n}`;
coreSrc = `(() => {\n'use strict';\n${coreSrc}\nwindow.ARL_CORE = { createCore: ${pick('core/core', 'createCore')}, createMemoryStore: ${pick('core/store-memory', 'createMemoryStore')}, SCHEMA: ${pick('core/schema', 'SCHEMA')}, seedDemo: ${pick('core/demo', 'seedDemo')}, createDemoDriver: ${pick('core/demo', 'createDemoDriver')}, DEMO_PASSWORD: ${pick('core/demo', 'DEMO_PASSWORD')}, seedHubDemo: __ex['core/hub/demo'] ? __ex['core/hub/demo'].seedHubDemo : null };\n})();`;
// Chạy thử ngay khi gộp: lỗi cú pháp hoặc thiếu hàm sẽ lộ ra ở đây chứ không phải trên máy người xem.
{
  const sandbox = { window: {}, atob, btoa, console, setTimeout, clearTimeout, TextEncoder, TextDecoder, URLSearchParams };
  vm.runInNewContext(coreSrc, sandbox, { filename: 'core-bundle.js' });
  const C = sandbox.window.ARL_CORE;
  if (!C || typeof C.createCore !== 'function' || typeof C.seedDemo !== 'function') throw new Error('Gộp lõi xong nhưng thiếu hàm cần dùng');
  const store = C.createMemoryStore(C.SCHEMA);
  const core = C.createCore({ store, now: () => Date.parse('2026-10-05T03:00:00Z'), hashPassword: async (p) => p, verifyPassword: async (p, h) => p === h, token: () => Math.random().toString(36).slice(2).padEnd(24, 'x'), sha: (x) => x, files: { put() {}, remove() {} } });
  if (!core.hub || typeof core.api !== 'function') throw new Error('Gộp lõi xong nhưng Ops Hub không khởi tạo được');
}

// 2) Giao diện
const leafletCss = read('public/vendor/leaflet.css').replace(/^[^\n]*url\((?:images\/|#default#VML)[^\n]*$/gm, ''); // bỏ ảnh/VML không dùng (bản xem thử không tải được tệp ngoài)
// Danh sách CSS và JS lấy đúng theo public/index.html (một nguồn duy nhất, bản xem thử không lệch bản thật).
const indexHtml = read('public/index.html');
const cssFiles = [...indexHtml.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]).filter((f) => !f.startsWith('vendor/') && f !== 'fonts.css' && !f.startsWith('http'));
const jsFiles = [...indexHtml.matchAll(/<script src="(js\/[^"]+)"><\/script>/g)].map((m) => m[1]);
if (!jsFiles.length || jsFiles[jsFiles.length - 1] !== 'js/main.js') throw new Error('public/index.html: không đọc được danh sách script (main.js phải đứng cuối)');
const appCss = cssFiles.map((f) => `/* ── public/${f} ── */\n` + read(`public/${f}`)).join('\n');
const UI = jsFiles.map((f) => `// ── public/${f} ──\n` + read(`public/${f}`));
const backend = read('tools/preview-backend.js');
const bar = `
(() => {
  // Thanh chọn vai trò: bấm để xem ứng dụng dưới góc nhìn từng người. "BO" = mở link dùng một lần như BO thật sẽ nhận.
  const ROLES = [['admin', 'Quản trị'], ['salehead', 'Head of Sale'], ['sale', 'Sale Lead'], ['lead', 'Logistic Lead'], ['log', 'Logistic'], ['techlead', 'Tech Lead'], ['tech', 'Tech'], ['fo', 'FO (điện thoại)'], ['bo', 'BO (mở link)']];
  const bar = document.createElement('div');
  bar.className = 'demo-bar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Chọn vai trò để xem thử');
  bar.innerHTML = '<b>Bản xem thử</b><span>Xem với vai:</span>' + ROLES.map(([u, l]) => '<button type="button" data-u="' + u + '" aria-pressed="false">' + l + '</button>').join('');
  document.body.prepend(bar);
  document.body.classList.add('has-demo-bar');
  let busy = false, user = null;
  const mark = () => { const cur = window.ARL.boToken ? 'bo' : user; for (const b of bar.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.u === cur)); };
  bar.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-u]');
    if (!b || busy || b.getAttribute('aria-pressed') === 'true') return;
    busy = true;
    try {
      if (b.dataset.u === 'bo') {
        const tk = await window.ARL_BACKEND.demoBoToken();
        if (!tk) window.ARL.toast('Chưa có lượt giao nhận nào tại BO do bạn điều khiển. Vào vai Lead tạo task cho “FO Dùng Thử” để thử.', true);
        else { window.ARL.boToken = tk; window.ARL.reboot(); }
      } else { window.ARL.boToken = null; await window.ARL_BACKEND.switchTo(b.dataset.u); window.ARL.reboot(); }
    } catch (err) { console.error(err); }
    busy = false; mark();
  });
  window.ARL_BACKEND.onAuth((name) => { user = name; mark(); });
  setInterval(mark, 1000); // vai BO cũng có thể được mở từ hộp thoại "Link cho BO" của Lead
})();`;

const leafletTag = inlineLeaflet
  ? `<script>${noScriptEnd(read('public/vendor/leaflet.js'))}</script>`
  : `<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js"></script>\n<script>window.L || document.write('<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"><\\/script>')</script>`;

const html = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Atlas Ops Hub – Bản xem thử</title>
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700&display=swap">
<style>
${leafletCss}
${appCss}
</style>
</head>
<body>
<div id="root"><p class="boot">Đang dựng dữ liệu mẫu…</p></div>
<div id="toast" class="toast" role="status" hidden></div>
${leafletTag}
<script>
${noScriptEnd(coreSrc)}
</script>
<script>
${noScriptEnd(backend)}
</script>
<script>
${noScriptEnd(UI.slice(0, -1).join('\n'))}
${noScriptEnd(bar)}
${noScriptEnd(UI[UI.length - 1])}
</script>
</body>
</html>
`;
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`Đã tạo ${outFile} (${(html.length / 1024).toFixed(0)} KB)${inlineLeaflet ? ' — Leaflet nhúng sẵn' : ''}`);
