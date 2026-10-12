// hub.load.mjs — kiểm thử tải Ops Hub trên máy chủ thật: dữ liệu mẫu nhiều tuần (quy mô lớn), nhiều người dùng của cả 3 team
// cùng mở dashboard, danh sách và bấm gửi việc; đo độ trễ từng loại yêu cầu và độ trễ cập nhật tức thời sang màn hình người khác.
//   node test/hub.load.mjs [số người dùng ảo, mặc định 40] [số giây, mặc định 45] [quy mô dữ liệu 0,25–3, mặc định 3]
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
import { seedDemo, DEMO_PASSWORD } from '../core/demo.js';
import { seedHubDemo } from '../core/hub/demo.js';
import { addDays } from '../core/util.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VU = +process.argv[2] || 40, SECS = +process.argv[3] || 45, SCALE = +process.argv[4] || 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-hubload-'));
const PORT = 19000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`;
let failed = 0;
const ok = (c, msg) => { console.log(`  ${c ? '✓' : '✗'} ${msg}`); if (!c) failed++; };

// 1) Dữ liệu: lịch sử Ops Hub nhiều tuần, băm mật khẩu đúng kiểu máy chủ (scrypt) để đăng nhập được qua HTTP.
const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (e, k) => (e ? rej(e) : res(k))));
const hashPassword = async (pw) => { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('base64url')}$${(await scrypt(pw, salt)).toString('base64url')}`; };
let seedInfo;
{
  const store = createSqliteStore(SCHEMA, path.join(dir, 'atlas.db'));
  let fake = null;
  const core = createCore({ store, now: () => fake ?? Date.now(), cfg: { demo: true }, hashPassword, verifyPassword: async () => false, token: (n) => crypto.randomBytes(n).toString('base64url'), sha: (s) => crypto.createHash('sha256').update(s).digest('hex'), files: { put() {}, remove() {} } });
  const t0 = performance.now();
  await seedDemo(core);
  seedInfo = await seedHubDemo(core, { setNow: (t) => { fake = t; }, scale: SCALE });
  fake = null;
  const n = (t) => store[t].count();
  console.log(`Dữ liệu (quy mô ${SCALE}, tạo trong ${((performance.now() - t0) / 1000).toFixed(1)} s, ${seedInfo.calls} lệnh API, ${seedInfo.errors ? Object.keys(seedInfo.errors).length : 0} loại lỗi): ${n('sites')} điểm/BO, ${n('kits')} kit, ${n('devices')} thiết bị, ${n('cards')} thẻ, ${n('card_records')} bản ghi dung lượng, ${n('jobs')} việc, ${n('incidents')} sự cố, ${n('tasks')} chuyến FO, ${n('users')} tài khoản`);
  core.shutdown(); store.close();
}

// 2) Máy chủ thật trên dữ liệu đó
const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, TILE_URL: '', DEMO: '0', BACKUP_KEEP: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 300 && !log.includes('[http]'); i++) await sleep(50);
if (!log.includes('[http]')) { console.error('Máy chủ không khởi động:\n' + log); process.exit(1); }
const rss = () => Math.round(+execSync(`ps -o rss= -p ${proc.pid}`).toString().trim() / 1024);
const req = async (method, p, body, cookie) => {
  const r = await fetch(BASE + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, cookie: (/arl_sid=[^;]*/.exec(r.headers.get('set-cookie') || '') || [''])[0], json: await r.json().catch(() => null) };
};

// 3) Người dùng ảo: mỗi người một phiên và một kết nối thời gian thực như trình duyệt thật.
const ACCOUNTS = ['admin', 'techlead', 'tech', 'tech2', 'tech3', 'lead', 'log', 'log2', 'log3', 'salehead', 'sale', 'sale2', 'sale3'];
const vus = [];
for (let i = 0; i < VU; i++) {
  const username = ACCOUNTS[i % ACCOUNTS.length];
  const r = await req('POST', '/api/login', { username, password: DEMO_PASSWORD });
  if (r.status !== 200) { console.error(`Không đăng nhập được ${username}: ${r.status} ${JSON.stringify(r.json)}`); process.exit(1); }
  const v = { username, uid: r.json.user.id, role: r.json.user.role, cookie: r.cookie, hubMsgs: 0 };
  v.ws = new WebSocket(BASE.replace('http', 'ws') + '/ws', { headers: { Cookie: v.cookie } });
  v.ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.t === 'hub') v.hubMsgs++; });
  await new Promise((res) => { v.ws.on('open', res); v.ws.on('error', res); });
  vus.push(v);
}
// Người dùng ảo cùng một tài khoản (như một người mở nhiều tab) chia nhau việc theo mã: không hai tab cùng bấm nhận / trả một việc.
// Không chia thì tab này trả việc tab kia vừa trả (đúng luật: 403 "Bạn không giữ việc này"), không phải lỗi tải.
for (const v of vus) { const same = vus.filter((x) => x.username === v.username); v.slot = same.indexOf(v); v.of = same.length; }
// Ca làm và cách nhận việc của hai team, như team thật (ca đã duyệt cả ngày hôm nay, thêm ngày mai phòng khi chạy qua nửa đêm):
//  - Logistics tự giao việc theo ca: hệ thống giao việc cho người trong ca; nhân viên trả việc chưa bắt đầu thì hệ thống giao lại cho người khác
//    trong ca (đo trả việc có giao lại).
//  - Tech Lead tắt tự giao việc: việc nằm ở hàng chung, nhân viên tự nhận rồi trả lại (đo nhận việc và trả việc về hàng chung). Nếu Tech cũng
//    tự giao thì lần trả việc đầu tiên đã giao hết hàng chung cho người trong ca, không còn việc nào để nhận và hai đường ghi này không được đo.
{
  const tl = vus.find((v) => v.username === 'techlead');
  const c = await req('PUT', '/api/hub/config', { autoAssign: false }, tl.cookie);
  if (c.status !== 200) { console.error(`techlead không tắt được tự giao việc: ${c.status} ${JSON.stringify(c.json)}`); process.exit(1); }
  const today = (await req('GET', '/api/hub/me', null, vus[0].cookie)).json.today;
  const days = [today, addDays(today, 1)];
  for (const leadName of ['techlead', 'lead']) {
    const lv = vus.find((v) => v.username === leadName);
    const team = (await req('GET', '/api/hub/roster', null, lv.cookie)).json;
    const rows = team.users.flatMap((u) => days.map((date) => ({ user_id: u.id, date, kind: 'shift', note: 'Kiểm thử tải' })));
    const r = await req('PUT', '/api/hub/roster', { rows }, lv.cookie);
    if (r.status !== 200) { console.error(`${leadName} không xếp được ca: ${r.status} ${JSON.stringify(r.json)}`); process.exit(1); }
  }
  // Mọi người mở ứng dụng một lần trước pha tải: vào ca, hệ thống giao việc và san việc cho người vừa vào ca. Xong hết rồi mới đo, để việc
  // không đổi người giữ giữa lúc người dùng ảo xem danh sách việc của mình và lúc bấm trả việc.
  for (const v of vus) await req('GET', '/api/hub/me', null, v.cookie);
}
console.log(`Kiểm thử tải Ops Hub: ${VU} người dùng ảo (${[...new Set(vus.map((v) => v.role))].join(', ')}), ${SECS} giây, nghỉ 300–900 ms giữa hai thao tác. RSS máy chủ lúc đầu: ${rss()} MB`);

// Dữ liệu cần để bấm gửi việc thật
const sale = vus.find((v) => v.role === 'sale');
const saleBos = ((await req('GET', '/api/hub/outlets', null, sale.cookie)).json.outlets || []).filter((o) => o.ops_status === 'live').map((o) => o.id);
const labels = [...new Set(Object.values((await req('GET', '/api/hub/labels', null, sale.cookie)).json.labels || {}).flat())];
const accTypes = ((await req('GET', '/api/hub/acc', null, vus.find((v) => v.role === 'lead').cookie)).json.acc || []).map((t) => t.id);
ok(saleBos.length && labels.length && accTypes.length, `có dữ liệu để gửi việc: ${saleBos.length} BO của Sale, ${labels.length} nhãn lỗi, ${accTypes.length} loại phụ kiện`);

const READS = {
  admin: ['/api/hub/overview', '/api/hub/perf?team=tech', '/api/hub/perf/trend?team=logistics', '/api/hub/sale', '/api/hub/log', '/api/hub/incidents/stats'],
  tech_lead: ['/api/hub/overview', '/api/hub/home', '/api/hub/jobs?view=team', '/api/hub/perf', '/api/hub/kits', '/api/hub/incidents', '/api/hub/recon'],
  tech: ['/api/hub/home', '/api/hub/jobs', '/api/hub/cards/upload-queue', '/api/hub/kits', '/api/hub/incidents', '/api/hub/perf/me', '/api/hub/inbox'],
  lead: ['/api/hub/overview', '/api/hub/home', '/api/hub/jobs?view=team', '/api/hub/perf', '/api/hub/acc', '/api/hub/outlets?metrics=1', '/api/hub/roster', '/api/hub/attendance'],
  logistic: ['/api/hub/home', '/api/hub/jobs', '/api/hub/kits', '/api/hub/cards', '/api/hub/handovers', '/api/hub/outlets', '/api/hub/requests'],
  sale_head: ['/api/hub/sale', '/api/hub/overview', '/api/hub/outlets?metrics=1', '/api/hub/requests', '/api/hub/incidents'],
  sale: ['/api/hub/sale', '/api/hub/outlets?metrics=1', '/api/hub/requests', '/api/hub/incidents', '/api/hub/inbox'],
};
const stat = new Map(); // nhãn → [ms]
let errors5xx = 0, unexpected = 0;
const rec = (label, ms, status) => { if (!stat.has(label)) stat.set(label, []); stat.get(label).push(ms); if (status >= 500) errors5xx++; };
async function timed(label, method, p, body, cookie, okStatus = [200]) {
  const s = performance.now();
  const r = await req(method, p, body, cookie);
  rec(label, performance.now() - s, r.status);
  if (!okStatus.includes(r.status)) { unexpected++; if (unexpected <= 5) console.log(`    (không mong đợi) ${method} ${p} → ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`); }
  return r;
}
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
async function act(v) {
  const roll = Math.random();
  if (v.role === 'sale' && roll < 0.12 && saleBos.length) { // Sale báo sự cố → Tech có việc mới, mọi màn hình liên quan tự cập nhật
    const mine = ((await req('GET', '/api/hub/outlets', null, v.cookie)).json.outlets || []).filter((o) => o.ops_status === 'live');
    if (mine.length) return timed('GHI báo sự cố (Sale)', 'POST', '/api/hub/incidents', { site_id: rnd(mine).id, label: rnd(labels), text: 'Kiểm thử tải: máy báo lỗi' }, v.cookie);
  }
  if ((v.role === 'tech' || v.role === 'logistic') && roll < 0.15) {
    const mine = (j) => j.id % v.of === v.slot; // phần việc của tab này (người dùng ảo cùng tài khoản chia nhau)
    // Nhận việc ở hàng chung rồi trả lại (Tech; Logistics khi hàng chung còn việc không ai trong ca nhận được).
    const jobs = (await req('GET', '/api/hub/jobs?view=team&pool=1', null, v.cookie)).json.jobs || [];
    const j = jobs.find((x) => x.status === 'open' && !x.assignee && !x.task_id && mine(x));
    if (j) {
      const c = await timed('GHI nhận việc', 'POST', `/api/hub/jobs/${j.id}/claim`, {}, v.cookie, [200, 409]);
      if (c.status === 200) await timed('GHI trả việc', 'POST', `/api/hub/jobs/${j.id}/release`, { reason: 'Kiểm thử tải trả lại' }, v.cookie, [200, 409]);
      return;
    }
    // Hàng chung trống (team tự giao việc theo ca): trả một việc chưa bắt đầu mình đang giữ, hệ thống giao lại cho người khác trong ca.
    const held = (await req('GET', '/api/hub/jobs?view=mine', null, v.cookie)).json.jobs || [];
    const k = held.find((x) => x.status === 'open' && x.assignee && x.assignee.id === v.uid && !x.task_id && !x.started_at && !x.blocked && mine(x));
    if (k) return timed('GHI trả việc, hệ thống giao lại', 'POST', `/api/hub/jobs/${k.id}/release`, { reason: 'Kiểm thử tải trả lại cho người khác trong ca' }, v.cookie, [200, 409]);
  }
  if ((v.role === 'lead' || v.role === 'logistic') && roll < 0.25 && accTypes.length) { // nhập thêm rồi ghi giảm phụ kiện
    const id = rnd(accTypes);
    await timed('GHI nhập phụ kiện', 'POST', `/api/hub/acc/${id}/move`, { kind: 'in', qty: 1, reason: 'Kiểm thử tải nhập' }, v.cookie);
    return timed('GHI ghi giảm phụ kiện', 'POST', `/api/hub/acc/${id}/move`, { kind: 'out', qty: 1, reason: 'Kiểm thử tải ghi giảm' }, v.cookie, [200, 409]);
  }
  const p = rnd(READS[v.role]);
  return timed('ĐỌC ' + p.replace(/\?.*$/, ''), 'GET', p, null, v.cookie);
}

// 4) Pha tải: mọi người dùng cùng thao tác liên tục
const t0 = Date.now();
await Promise.all(vus.map(async (v, i) => {
  await sleep((i / VU) * 900);
  while (Date.now() - t0 < SECS * 1000) { await act(v).catch(() => { unexpected++; }); await sleep(300 + Math.random() * 600); }
}));
const all = [...stat.values()].flat();
const writes = [...stat.entries()].filter(([k]) => k.startsWith('GHI')).flatMap(([, v]) => v);
const reads = [...stat.entries()].filter(([k]) => k.startsWith('ĐỌC')).flatMap(([, v]) => v);
console.log(`\n  Loại yêu cầu${' '.repeat(30)}số lượt   trung vị     p95     p99     tối đa (ms)`);
for (const [k, v] of [...stat.entries()].sort((a, b) => pct(b[1], 0.95) - pct(a[1], 0.95))) console.log(`  ${k.padEnd(42)} ${String(v.length).padStart(6)} ${pct(v, 0.5).toFixed(0).padStart(9)} ${pct(v, 0.95).toFixed(0).padStart(7)} ${pct(v, 0.99).toFixed(0).padStart(7)} ${Math.max(...v).toFixed(0).padStart(8)}`);
console.log(`  Tổng: ${all.length} yêu cầu trong ${SECS} giây (≈ ${(all.length / SECS).toFixed(0)}/giây), ${writes.length} lượt ghi`);
ok(errors5xx === 0, `không có lỗi máy chủ (5xx): ${errors5xx}`);
ok(unexpected === 0, `mọi yêu cầu trả đúng mã mong đợi (${unexpected} bất thường)`);
// Nhận / trả việc là các lệnh ghi nặng nhất (đọc tải và ca của cả team): phải có đủ lượt đo, không để p95 lệnh ghi chỉ còn phụ kiện và sự cố.
{
  const n = (k) => (stat.get(k) || []).length, need = Math.max(3, Math.floor((VU * SECS) / 100));
  const got = [['nhận việc', n('GHI nhận việc')], ['trả việc về hàng chung', n('GHI trả việc')], ['trả việc, hệ thống giao lại', n('GHI trả việc, hệ thống giao lại')]];
  ok(got.every(([, x]) => x >= need), `đo đủ lượt nhận / trả việc (tối thiểu ${need} mỗi loại): ${got.map(([k, x]) => `${k} ${x}`).join(', ')}`);
}
ok(pct(writes, 0.95) < 300, `bấm gửi việc: trung vị ${pct(writes, 0.5).toFixed(0)} ms, p95 ${pct(writes, 0.95).toFixed(0)} ms (ngưỡng p95 < 300 ms)`);
ok(pct(reads, 0.95) < 800, `mở dashboard, danh sách: trung vị ${pct(reads, 0.5).toFixed(0)} ms, p95 ${pct(reads, 0.95).toFixed(0)} ms (ngưỡng p95 < 800 ms)`);
console.log(`    RSS máy chủ sau pha tải: ${rss()} MB`);

// 5) Độ trễ cập nhật tức thời: Sale báo sự cố → màn hình của Tech nhận tín hiệu cập nhật bao lâu sau khi bấm gửi
{
  const tech = vus.find((v) => v.role === 'tech');
  const lat = [];
  let sent = 0, dup = 0;
  for (let i = 0; i < 15; i++) {
    const mine = ((await req('GET', '/api/hub/outlets', null, sale.cookie)).json.outlets || []).filter((o) => o.ops_status === 'live');
    const got = new Promise((res) => { const f = (d) => { const m = JSON.parse(d.toString()); if (m.t === 'hub' && (m.ent || []).includes('incidents')) { tech.ws.off('message', f); res(performance.now()); } }; tech.ws.on('message', f); setTimeout(() => { tech.ws.off('message', f); res(null); }, 3000); });
    const s = performance.now();
    const r = await req('POST', '/api/hub/incidents', { site_id: rnd(mine).id, label: labels[i % labels.length], text: 'Đo cập nhật tức thời ' + i }, sale.cookie);
    const e = await got;
    if (r.json && r.json.duplicate) { dup++; continue; } // trùng sự cố đang mở: không có gì mới để đẩy
    sent++;
    if (e) lat.push(e - s);
    await sleep(400);
  }
  ok(sent > 0 && lat.length === sent && pct(lat, 0.95) < 600, `màn hình Tech tự cập nhật sau khi Sale báo sự cố: ${lat.length}/${sent} lần (bỏ ${dup} lần trùng sự cố đang mở), trung vị ${pct(lat, 0.5).toFixed(0)} ms, p95 ${pct(lat, 0.95).toFixed(0)} ms (đã gồm 150 ms gộp tín hiệu; ngưỡng p95 < 600 ms)`);
}

for (const v of vus) v.ws.close();
proc.kill('SIGTERM');
await new Promise((r) => proc.on('exit', r));
ok(!/Error|\[timer\]|\[http\] (?!Atlas)/.test(log.replace(/\[http\] Atlas[^\n]*/g, '')), 'nhật ký máy chủ không có lỗi');
if (failed) console.log(log.split('\n').filter((l) => /Error|\[timer\]/.test(l)).slice(0, 10).join('\n'));
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\nKiểm thử tải Ops Hub: KHÔNG ĐẠT (${failed} mục).` : '\nKiểm thử tải Ops Hub: đạt.');
process.exit(failed ? 1 : 0);
