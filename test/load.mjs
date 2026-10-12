// load.mjs — kiểm thử tải: N FO cùng gửi vị trí (qua WebSocket như trang web, rồi qua /osmand như app Traccar) vào một máy chủ thật.
//   node test/load.mjs [số FO, mặc định 300] [số giây mỗi pha, mặc định 30]
import { spawn, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { SCHEMA } from '../core/schema.js';
import { createSqliteStore } from '../core/store-sqlite.js';
import { createCore } from '../core/core.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +process.argv[2] || 300, SECS = +process.argv[3] || 30, EVERY_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pct = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-load-'));
const PORT = 18900 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${PORT}`;
let failed = 0;
const ok = (c, msg) => { console.log(`  ${c ? '✓' : '✗'} ${msg}`); if (!c) failed++; };

// 1) Chuẩn bị nhanh N tài khoản FO (đã đồng ý điều khoản, có sẵn phiên đăng nhập) bằng cách ghi thẳng vào kho trước khi bật máy chủ.
const fos = [];
{
  const store = createSqliteStore(SCHEMA, path.join(dir, 'atlas.db'));
  const core = createCore({ store, hashPassword: async () => 'x', verifyPassword: async () => false, token: (n) => crypto.randomBytes(n).toString('base64url'), sha, files: { put() {}, remove() {} } });
  const t = Date.now();
  for (let i = 0; i < N; i++) {
    const r = await core.createUser({ username: `tai${i}`, name: `FO Tải ${i}`, role: 'fo', password: 'khong-dung-toi', must_change: false }, null);
    store.users.update(r.user.id, { consent_version: core.terms().version, consent_at: t });
    const token = crypto.randomBytes(32).toString('base64url');
    store.sessions.insert({ id: sha(token), user_id: r.user.id, created_at: t, seen_at: t, expires_at: t + 86400000, ua: 'load' });
    fos.push({ id: r.user.id, cookie: `arl_sid=${token}`, device: store.users.get(r.user.id).device_token, lat: 10.72 + Math.random() * 0.12, lon: 106.62 + Math.random() * 0.14, hdg: Math.random() * 360 });
  }
  core.shutdown(); store.close();
}

// 2) Bật máy chủ thật
const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, TILE_URL: '', DEMO: '0', LEAD_PASS: 'Khoitao-12345' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 150 && !log.includes('[http]'); i++) await sleep(50);
if (!log.includes('[http]')) { console.error('Máy chủ không khởi động:\n' + log); process.exit(1); }
const rss = () => Math.round(+execSync(`ps -o rss= -p ${proc.pid}`).toString().trim() / 1024);
const req = async (method, p, body, cookie) => {
  const r = await fetch(BASE + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, cookie: (/arl_sid=[^;]*/.exec(r.headers.get('set-cookie') || '') || [''])[0], json: await r.json().catch(() => null) };
};
const lg = await req('POST', '/api/login', { username: 'admin', password: 'Khoitao-12345' });
await req('POST', '/api/password', { old: 'Khoitao-12345', new: 'Matkhau-lead-moi' }, lg.cookie);
const move = (f) => { // mỗi nhịp đi ~25 m theo hướng hiện tại, thỉnh thoảng rẽ
  if (Math.random() < 0.15) f.hdg += (Math.random() - 0.5) * 90;
  f.lat += (Math.cos((f.hdg * Math.PI) / 180) * 25) / 111320; f.lon += (Math.sin((f.hdg * Math.PI) / 180) * 25) / (111320 * Math.cos((f.lat * Math.PI) / 180));
  return { ts: Date.now(), lat: +f.lat.toFixed(6), lon: +f.lon.toFixed(6), acc: 8, spd: 8.3, hdg: Math.round(((f.hdg % 360) + 360) % 360), bat: 0.8 };
};
console.log(`Kiểm thử tải: ${N} FO, mỗi FO 1 điểm / ${EVERY_MS / 1000} giây (≈ ${Math.round(N / (EVERY_MS / 1000))} điểm/giây), mỗi pha ${SECS} giây. RSS máy chủ lúc đầu: ${rss()} MB`);

// 3) Màn hình điều phối đang mở: đếm xem mỗi giây thấy bao nhiêu FO
const seen = new Set(); let posMsgs = 0, posBytes = 0;
const ops = new WebSocket(BASE.replace('http', 'ws') + '/ws', { headers: { Cookie: lg.cookie } });
ops.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.t === 'pos') { posMsgs++; posBytes += d.length; for (const u of m.u) seen.add(u.id); } });
await new Promise((r) => ops.on('open', r));

// ── Pha 1: WebSocket (trang web của FO) ──
{
  const lat = [], conns = [];
  let acks = 0, sent = 0, bad = 0;
  await Promise.all(fos.map((f) => new Promise((resolve) => {
    const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws', { headers: { Cookie: f.cookie } });
    const pending = new Map(); let seq = 0;
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.t === 'ack') { const t0 = pending.get(m.seq); if (t0) { lat.push(performance.now() - t0); pending.delete(m.seq); } acks++; if (m.ok !== 1) bad++; } });
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'shift', on: true })); conns.push({ ws, f, pending, next: () => ++seq }); resolve(); });
    ws.on('error', () => { bad++; resolve(); });
  })));
  ok(conns.length === N, `mở được ${conns.length}/${N} kết nối WebSocket cùng lúc`);
  const t0 = Date.now();
  const timers = conns.map((c, i) => setTimeout(function tick() {
    if (Date.now() - t0 > SECS * 1000) return;
    const s = c.next(); c.pending.set(s, performance.now()); sent++;
    c.ws.send(JSON.stringify({ t: 'loc', seq: s, pts: [move(c.f)] }));
    timers[i] = setTimeout(tick, EVERY_MS);
  }, (i / N) * EVERY_MS));
  await sleep(SECS * 1000 + 1500);
  timers.forEach(clearTimeout);
  ok(acks === sent && bad === 0, `WebSocket: gửi ${sent} điểm, nhận đủ ${acks} xác nhận, ${bad} lỗi`);
  ok(pct(lat, 0.99) < 500, `độ trễ xác nhận: trung vị ${pct(lat, 0.5).toFixed(1)} ms, p95 ${pct(lat, 0.95).toFixed(1)} ms, p99 ${pct(lat, 0.99).toFixed(1)} ms (ngưỡng p99 < 500 ms)`);
  ok(seen.size === N, `màn hình điều phối thấy đủ ${seen.size}/${N} FO; nhận ${posMsgs} gói (≈ ${(posBytes / posMsgs / 1024).toFixed(1)} KB/gói, ${(posBytes / SECS / 1024).toFixed(0)} KB/giây)`);
  for (const c of conns) c.ws.close();
  console.log(`    RSS máy chủ sau pha WebSocket: ${rss()} MB`);
}
// ── Pha 2: /osmand (app Traccar Client) ──
{
  const lat = []; let sent = 0, okN = 0, bad = 0;
  const t0 = Date.now(), jobs = [];
  const timers = fos.map((f, i) => setTimeout(function tick() {
    if (Date.now() - t0 > SECS * 1000) return;
    const p = move(f), s = performance.now(); sent++;
    jobs.push(fetch(`${BASE}/osmand?id=${f.device}&lat=${p.lat}&lon=${p.lon}&timestamp=${Math.floor(p.ts / 1000)}&speed=16&bearing=${p.hdg}&batt=80&accuracy=8`).then(async (r) => { const t = await r.text(); lat.push(performance.now() - s); if (r.status === 200 && (t === 'ok' || t === 'dup')) okN++; else bad++; }).catch(() => { bad++; }));
    timers[i] = setTimeout(tick, EVERY_MS);
  }, (i / N) * EVERY_MS));
  await sleep(SECS * 1000 + 500);
  timers.forEach(clearTimeout);
  await Promise.all(jobs);
  ok(okN === sent && bad === 0, `Traccar: gửi ${sent} yêu cầu, ${okN} thành công, ${bad} lỗi`);
  ok(pct(lat, 0.99) < 500, `độ trễ phản hồi: trung vị ${pct(lat, 0.5).toFixed(1)} ms, p95 ${pct(lat, 0.95).toFixed(1)} ms, p99 ${pct(lat, 0.99).toFixed(1)} ms (ngưỡng p99 < 500 ms)`);
}
// 4) Sau cùng: máy chủ còn khoẻ, dữ liệu đủ
const live = (await req('GET', '/api/live', null, lg.cookie)).json;
const fresh = live.fos.filter((f) => f.onShift && f.last && Date.now() - f.last.ts < 15000).length;
ok(fresh === N, `sau khi chạy: ${fresh}/${N} FO đang trong ca với vị trí mới`);
const t1 = performance.now();
const stats = (await req('GET', `/api/stats?from=${new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10)}`, null, lg.cookie)).json;
ok(stats && stats.totals.km > 0, `thống kê ngày vẫn tính được trong ${(performance.now() - t1).toFixed(0)} ms (tổng ${stats ? stats.totals.km : '?'} km)`);
const db = fs.statSync(path.join(dir, 'atlas.db')).size + (fs.existsSync(path.join(dir, 'atlas.db-wal')) ? fs.statSync(path.join(dir, 'atlas.db-wal')).size : 0);
console.log(`    RSS máy chủ cuối cùng: ${rss()} MB · cơ sở dữ liệu: ${(db / 1048576).toFixed(1)} MB cho ~${Math.round((2 * SECS * N) / (EVERY_MS / 1000))} điểm`);
ops.close();
proc.kill('SIGTERM');
await new Promise((r) => proc.on('exit', r));
ok(!/\[(ws|timer|http)\] (?!Atlas)/.test(log.replace(/\[http\] Atlas[^\n]*/g, '')) && !/Error/.test(log), 'nhật ký máy chủ không có lỗi');
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\nKiểm thử tải: KHÔNG ĐẠT (${failed} mục).` : '\nKiểm thử tải: đạt.');
process.exit(failed ? 1 : 0);
