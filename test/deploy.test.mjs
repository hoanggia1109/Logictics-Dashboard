// deploy.test.mjs — kiểm gói triển khai: mọi tệp máy chủ cần (theo chuỗi import từ server.js) đều được Dockerfile chép vào ảnh,
// và mọi tệp giao diện public/index.html gọi tới đều có thật. Lỗi kiểu này chỉ lộ ra khi bật container trên máy chủ thật.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from './harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

await group('Dockerfile chép đủ mọi module máy chủ cần', async () => {
  const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const copied = [...docker.matchAll(/^COPY\s+(.+?)\s+\S+\s*$/gm)].flatMap((m) => m[1].split(/\s+/)).map((s) => s.replace(/^\.\//, '').replace(/\/$/, ''));
  const seen = new Set(), queue = [path.join(ROOT, 'server.js')];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/^import\s[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) queue.push(path.resolve(path.dirname(f), m[1]));
  }
  ok(seen.size > 15, `lần theo được chuỗi import (${seen.size} tệp)`);
  for (const f of seen) {
    const r = rel(f);
    ok(fs.existsSync(f), `tệp có thật: ${r}`);
    ok(copied.some((c) => r === c || r.startsWith(c + '/')), `Dockerfile có chép ${r}`);
  }
  ok(copied.includes('public'), 'Dockerfile có chép thư mục giao diện public');
});

await group('Mọi CSS / JS mà trang chính gọi tới đều có thật', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css))"/g)].map((m) => m[1]);
  ok(refs.length > 20, `đọc được danh sách tệp (${refs.length})`);
  for (const r of refs) ok(fs.existsSync(path.join(ROOT, 'public', r)), `public/${r} có thật`);
});

summary('Gói triển khai');
