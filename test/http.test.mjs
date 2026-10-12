// http.test.mjs — dựng máy chủ thật (tiến trình riêng, SQLite trên đĩa) rồi kiểm thử qua HTTP và WebSocket như trình duyệt/điện thoại sẽ làm.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { ok, eq, group, summary, JPEG } from './harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let portSeq = 18200 + Math.floor(Math.random() * 500);

function startServer(dataDir, env = {}) {
  const port = ++portSeq;
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, TILE_URL: '', DEMO: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const ready = new Promise((resolve, reject) => {
    const t = setInterval(() => { if (out.includes('[http]')) { clearInterval(t); resolve(); } }, 30);
    proc.on('exit', (c) => { clearInterval(t); reject(new Error('máy chủ thoát sớm, mã ' + c + '\n' + out)); });
    setTimeout(() => { clearInterval(t); reject(new Error('máy chủ không khởi động kịp\n' + out)); }, 15000);
  });
  const stop = () => new Promise((resolve) => { if (proc.exitCode !== null) return resolve(proc.exitCode); proc.on('exit', (c) => resolve(c)); proc.kill('SIGTERM'); });
  return { port, base: `http://127.0.0.1:${port}`, ready, stop, log: () => out };
}
/** "Trình duyệt" tối giản có lọ cookie. */
function client(base) {
  let cookie = '', bl = ''; // bl: cookie thiết bị của BO (arl_bl)
  const c = {
    get bl() { return bl; },
    set bl(v) { bl = v; },
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    async req(method, p, body, headers = {}) {
      const h = { ...headers };
      if (cookie || bl) h.Cookie = [cookie, bl].filter(Boolean).join('; ');
      let payload;
      if (body !== undefined) { payload = typeof body === 'string' ? body : JSON.stringify(body); if (!h['Content-Type']) h['Content-Type'] = 'application/json'; }
      const r = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' });
      const set = r.headers.get('set-cookie');
      if (set) { c.lastSetCookie = set; const d = /arl_bl=([^;]*)/.exec(set); if (d) bl = `arl_bl=${d[1]}`; const m = /arl_sid=([^;]*)/.exec(set); if (m) cookie = /Max-Age=0/.test(set) ? '' : `arl_sid=${m[1]}`; }
      const buf = Buffer.from(await r.arrayBuffer());
      let json = null;
      try { json = JSON.parse(buf.toString('utf8')); } catch { /* không phải JSON */ }
      return { status: r.status, json, buf, text: buf.toString('utf8'), headers: r.headers };
    },
    ws(extraHeaders = {}) {
      return new Promise((resolve) => {
        const msgs = [];
        const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders } });
        const api = { ws, msgs, send: (o) => ws.send(JSON.stringify(o)), close: () => ws.close(), wait: async (pred, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = msgs.find(pred); if (m) return m; await sleep(25); } return null; } };
        ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
        ws.on('open', () => resolve({ ...api, opened: true }));
        ws.on('unexpected-response', (_rq, res) => resolve({ ...api, opened: false, status: res.statusCode }));
        ws.on('error', () => resolve({ ...api, opened: false, status: 0 }));
      });
    },
  };
  return c;
}
const login = async (base, username, password) => { const c = client(base); const r = await c.req('POST', '/api/login', { username, password }); return { c, r }; };
/** Tạo tài khoản qua Lead rồi đăng nhập, đổi mật khẩu, (FO) đồng ý điều khoản — đúng các bước người thật phải làm. */
async function onboard(base, lead, u) {
  const made = await lead.req('POST', '/api/users', u);
  if (made.status !== 200) throw new Error('không tạo được tài khoản: ' + made.text);
  const { c } = await login(base, u.username, made.json.tempPassword);
  await c.req('POST', '/api/password', { old: made.json.tempPassword, new: 'matkhau-' + u.username });
  if (u.role === 'fo') { const me = (await c.req('GET', '/api/me')).json; await c.req('POST', '/api/consent', { version: me.terms.version, checked: me.terms.items.map((_, i) => i) }); }
  return { c, id: made.json.user.id };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-http-'));
let S = startServer(dir, { LEAD_PASS: 'Khoitao-12345' });
await S.ready;
let lead, fo, boPhone, boToken, siteA, office, task, photoId;

await group('Khởi tạo, cookie phiên, đổi mật khẩu lần đầu', async () => {
  const anon = client(S.base);
  let r = await anon.req('GET', '/api/me');
  ok(r.status === 200 && r.json.user === null, 'chưa đăng nhập: /api/me trả user null (không báo lỗi đỏ trên trình duyệt)');
  eq((await anon.req('GET', '/api/sites')).status, 401, 'API khác → 401');
  ok(!fs.existsSync(path.join(dir, 'first-login.txt')), 'có LEAD_PASS thì không ghi mật khẩu ra file');
  const L = await login(S.base, 'admin', 'Khoitao-12345');
  lead = L.c;
  eq(L.r.status, 200, 'đăng nhập bằng tài khoản Lead đầu tiên');
  ok(/HttpOnly/.test(lead.lastSetCookie) && /SameSite=Lax/.test(lead.lastSetCookie) && /Path=\//.test(lead.lastSetCookie) && !/Secure/.test(lead.lastSetCookie), 'cookie phiên: HttpOnly, SameSite=Lax; không gắn Secure khi chạy http');
  ok(!JSON.stringify(L.r.json).includes('__session') && !L.r.text.includes(lead.cookie.slice(8)), 'mã phiên không nằm trong nội dung trả về');
  eq((await lead.req('GET', '/api/sites')).json.error, 'password_change_required', 'bắt đổi mật khẩu trước khi dùng');
  eq((await lead.req('POST', '/api/password', { old: 'Khoitao-12345', new: 'Matkhau-lead-moi' })).status, 200, 'đổi mật khẩu');
  eq((await lead.req('GET', '/api/sites')).status, 200, 'đổi xong dùng được');
  const hz = await anon.req('GET', '/healthz');
  ok(hz.status === 200 && hz.json.ok === true, '/healthz hoạt động');
});

await group('Chống giả mạo yêu cầu (CSRF), kiểm tra dữ liệu gửi lên', async () => {
  eq((await lead.req('POST', '/api/sites', { name: 'X', lat: 10, lon: 106 }, { Origin: 'https://trang-la.example' })).json.error, 'bad_origin', 'trang lạ mượn cookie → bị chặn');
  eq((await lead.req('POST', '/api/sites', 'name=X', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415, 'gửi dạng form → 415');
  eq((await lead.req('POST', '/api/sites', '{"name":', {})).json.error, 'bad_json', 'JSON hỏng → 400');
  eq((await lead.req('POST', '/api/sites', { name: 'x'.repeat(300 * 1024), lat: 10, lon: 106 })).status, 413, 'thân yêu cầu 300 KB ở API thường → 413');
  const r = await lead.req('POST', '/api/sites', { name: 'Văn phòng', type: 'office', lat: 10.7769, lon: 106.7009 }, { Origin: S.base });
  eq(r.status, 200, 'cùng nguồn gốc → được');
  office = r.json.site;
  siteA = (await lead.req('POST', '/api/sites', { name: 'BO A', type: 'bo', lat: 10.795, lon: 106.7218 })).json.site;
  const page = await client(S.base).req('GET', '/');
  ok(page.status === 200 && /default-src 'self'/.test(page.headers.get('content-security-policy') || '') && page.headers.get('x-frame-options') === 'DENY' && page.headers.get('x-content-type-options') === 'nosniff', 'trang chính có CSP, chặn nhúng khung, chặn đoán kiểu tệp');
  for (const f of ['/app.css', '/js/common.js', '/js/auth.js', '/js/ops.js', '/js/ops-dialogs.js', '/js/ops-pages.js', '/js/fo.js', '/js/bolink.js', '/js/main.js', '/vendor/leaflet.js', '/vendor/leaflet.css', '/fonts.css']) eq((await client(S.base).req('GET', f)).status, 200, `tệp tĩnh ${f}`);
  for (const p of ['/../server.js', '/..%2f..%2fserver.js', '/%2e%2e/package.json', '/js/../../server.js', '/data/atlas.db', '/%zz']) ok([400, 404].includes((await client(S.base).req('GET', p)).status), `không lấy được tệp ngoài thư mục public (${p})`);
  eq((await client(S.base).req('POST', '/')).status, 405, 'POST vào trang tĩnh → 405');
});

await group('Tài khoản FO: đăng nhập, đổi mật khẩu, đồng ý điều khoản', async () => {
  fo = await onboard(S.base, lead, { name: 'Trần Văn Một', username: 'fo1', role: 'fo', phone: '0900000001' });
  eq((await lead.req('POST', '/api/users', { name: 'Chị Lan', username: 'bo.a', role: 'bo' })).json.error, 'bad_role', 'không tạo tài khoản cho BO nữa (BO dùng link)');
  const me = (await fo.c.req('GET', '/api/me')).json;
  ok(me.user.role === 'fo' && me.needConsent === false && typeof me.deviceToken === 'string' && me.deviceToken.length >= 20, 'FO sẵn sàng, có mã thiết bị');
  fo.device = me.deviceToken;
  const c = (await lead.req('GET', '/api/consents')).json.consents[0];
  ok(c.action === 'agree' && c.ip && c.ua, 'vết đồng ý có IP và thiết bị thật');
});

await group('WebSocket: xác thực bằng cookie, vị trí trực tiếp', async () => {
  const anon = await client(S.base).ws();
  ok(!anon.opened && anon.status === 401, 'không cookie → từ chối bắt tay (401)');
  const evil = await lead.ws({ Origin: 'https://trang-la.example' });
  ok(!evil.opened && evil.status === 403, 'trang lạ mở WebSocket bằng cookie của người dùng → 403');
  const ops = await lead.ws();
  ok(ops.opened && (await ops.wait((m) => m.t === 'hello')) && (await ops.wait((m) => m.t === 'snapshot')), 'điều phối: nhận hello + snapshot');
  const snap = ops.msgs.find((m) => m.t === 'snapshot');
  ok(snap.fos.length === 1 && !JSON.stringify(snap).includes(fo.device), 'snapshot có 1 FO, không lộ mã thiết bị');
  const fws = await fo.c.ws();
  ok(fws.opened && (await fws.wait((m) => m.t === 'hello')) && !fws.msgs.some((m) => m.t === 'snapshot'), 'FO: nhận hello, không nhận snapshot của điều phối');
  const now = Date.now();
  fws.send({ t: 'shift', on: true });
  fws.send({ t: 'loc', seq: 1, pts: [{ ts: now - 2000, lat: 10.7769, lon: 106.7009, acc: 8 }, { ts: now, lat: 10.777, lon: 106.701, acc: 8 }, { ts: now, lat: 99, lon: 1 }] });
  const ack = await fws.wait((m) => m.t === 'ack' && m.seq === 1);
  ok(ack && ack.ok === 2 && ack.drop === 1, 'FO gửi 3 điểm: nhận 2, loại 1 điểm sai');
  const pos = await ops.wait((m) => m.t === 'pos');
  ok(pos && pos.u[0].id === fo.id && pos.u[0].lat === 10.777, 'điều phối thấy vị trí mới trong vòng ~1 giây');
  ok(await ops.wait((m) => m.t === 'shift' && m.on === true), 'điều phối thấy FO vào ca');
  fws.send({ t: 'ping' });
  ok(await fws.wait((m) => m.t === 'pong'), 'ping/pong');
  fws.ws.send('không phải json'); fws.ws.send(JSON.stringify({ t: 'loc', pts: 'sai' })); fws.ws.send(Buffer.from([1, 2, 3]));
  await sleep(150);
  ok(fws.ws.readyState === 1, 'thông điệp rác không làm rớt kết nối');
  ops.msgs.length = 0;
  S.ops = ops; S.fws = fws;
});

await group('Task qua HTTP: tạo, FO chạy, ảnh thật, BO theo dõi và xác nhận qua link dùng một lần', async () => {
  let r = await lead.req('POST', '/api/tasks', { fo_id: fo.id, round_trip: true, stops: [{ site_id: office.id, cards_in: 2 }, { site_id: siteA.id, cards_out: 2, cards_in: 2 }] });
  eq(r.status, 200, 'Lead tạo task');
  task = r.json.task;
  ok(await S.fws.wait((m) => m.t === 'task' && m.task.id === task.id), 'FO nhận task qua WebSocket ngay');
  // Link cho BO: Logistic tạo, gửi cho BO; BO mở trên điện thoại (không đăng nhập)
  r = await lead.req('POST', `/api/stops/${task.stops[1].id}/bo-link`);
  boToken = r.json.token;
  ok(r.status === 200 && /^[A-Za-z0-9_-]{30,}$/.test(boToken), 'Lead tạo link cho BO A');
  const preview = await client(S.base).req('GET', `/?b=${boToken}`);
  ok(preview.status === 200 && /<div id="root">/.test(preview.text) && !preview.headers.get('set-cookie') && (await lead.req('GET', `/api/tasks/${task.id}`)).json.task.stops[1].bo_link.opened_at === null, 'ứng dụng chat tải trước đường link để hiện xem trước → KHÔNG làm mất lượt dùng của link');
  eq((await client(S.base).req('POST', '/api/bo-link/view', { token: boToken }, { Origin: 'https://trang-la.example' })).json.error, 'bad_origin', 'trang lạ không gọi hộ được');
  boPhone = client(S.base);
  r = await boPhone.req('POST', '/api/bo-link/view', { token: boToken });
  ok(r.status === 200 && r.json.state === 'waiting' && r.json.fo.name === 'Trần Văn Một' && r.json.__dev === undefined && /arl_bl=[A-Za-z0-9_-]{30,}; Path=\/; HttpOnly; SameSite=Lax/.test(boPhone.lastSetCookie), 'BO mở link: thấy lượt giao nhận sắp tới; thiết bị được ghi nhớ bằng cookie HttpOnly');
  eq((await client(S.base).req('POST', '/api/bo-link/view', { token: boToken })).json.error, 'link_used', 'máy khác mở lại cùng link → bị từ chối');
  ok(await S.ops.wait((m) => m.t === 'task' && m.task.stops[1].bo_link && m.task.stops[1].bo_link.opened_at), 'điều phối thấy ngay BO đã mở link');
  eq((await fo.c.req('POST', `/api/tasks/${task.id}/start`)).json.task.status, 'in_progress', 'FO bắt đầu');
  const photo = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'photo.jpg')).toString('base64');
  eq((await fo.c.req('POST', `/api/stops/${task.stops[0].id}/proof`, { photos: ['data:image/jpeg;base64,' + Buffer.alloc(3 * 1024 * 1024 + 10, 1).toString('base64')] })).json.error, 'bad_photo', 'tệp 3 MB không phải ảnh → từ chối');
  eq((await fo.c.req('POST', `/api/stops/${task.stops[0].id}/proof`, { pad: 'x'.repeat(19 * 1024 * 1024) })).status, 413, 'thân yêu cầu 19 MB → 413');
  r = await fo.c.req('POST', `/api/stops/${task.stops[0].id}/proof`, { photos: [photo], cards_in: 2 });
  eq(r.status, 200, 'FO xác nhận điểm 1 kèm ảnh JPEG thật');
  photoId = r.json.task.stops[0].photos[0].id;
  const img = await lead.req('GET', `/api/photo/${photoId}`);
  ok(img.status === 200 && img.headers.get('content-type') === 'image/jpeg' && img.buf.length === Buffer.from(photo.split(',')[1], 'base64').length && img.buf[0] === 0xff && img.buf[1] === 0xd8 && /private/.test(img.headers.get('cache-control')), 'điều phối tải lại đúng ảnh đã gửi (đúng kiểu, đúng kích thước)');
  eq((await client(S.base).req('GET', `/api/photo/${photoId}`)).status, 401, 'chưa đăng nhập không xem được ảnh');
  eq((await boPhone.req('GET', `/api/photo/${photoId}`)).status, 401, 'BO cầm link cũng không xem được ảnh qua đường của người đăng nhập');
  const files = fs.readdirSync(path.join(dir, 'photos'), { recursive: true }).filter((f) => f.endsWith('.jpg'));
  eq(files.length, 1, 'tệp ảnh nằm trong thư mục dữ liệu');
  r = await fo.c.req('POST', `/api/stops/${task.stops[1].id}/proof`, { photos: [JPEG], cards_out: 2, cards_in: 2, lat: siteA.lat, lon: siteA.lon });
  eq(r.json.task.stops[1].bo_status, 'pending', 'điểm BO: chờ BO xác nhận');
  eq((await fo.c.req('POST', `/api/stops/${task.stops[2].id}/proof`, {})).json.error, 'wait_bo', 'BO chưa xác nhận → FO chưa đi tiếp / kết thúc được');
  r = await boPhone.req('POST', '/api/bo-link/view', { token: boToken });
  ok(r.json.state === 'confirm' && r.json.photos.length === 1 && r.json.fo_counts.cards_out === 2, 'BO thấy lượt chờ xác nhận kèm ảnh và số FO báo');
  const viaLink = await boPhone.req('GET', `/api/bo-link/photo/${r.json.photos[0].id}?t=${boToken}`);
  ok(viaLink.status === 200 && viaLink.headers.get('content-type') === 'image/jpeg' && viaLink.buf[0] === 0xff, 'BO xem được ảnh FO chụp tại điểm mình qua link');
  eq((await boPhone.req('GET', `/api/bo-link/photo/${photoId}?t=${boToken}`)).status, 404, 'BO không xem được ảnh ở điểm khác');
  eq((await client(S.base).req('GET', `/api/bo-link/photo/${r.json.photos[0].id}?t=${boToken}`)).status, 403, 'máy khác có link cũng không xem được ảnh');
  eq((await boPhone.req('POST', '/api/bo-link/confirm', { token: boToken, cards_recv: 2, cards_given: 2 })).json.error, 'photo_required', 'BO xác nhận bắt buộc có ảnh');
  r = await boPhone.req('POST', '/api/bo-link/confirm', { token: boToken, photos: [photo], cards_recv: 2, cards_given: 2 });
  ok(r.status === 200 && r.json.state === 'done' && r.json.bo.status === 'confirmed', 'BO xác nhận kèm ảnh thật qua link');
  ok(await S.fws.wait((m) => m.t === 'task' && m.task.stops[1].bo_status === 'confirmed'), 'FO được báo ngay qua WebSocket là BO đã xác nhận');
  r = await fo.c.req('POST', `/api/stops/${task.stops[2].id}/proof`, {});
  eq(r.json.task.status, 'completed', 'về tới nơi → task hoàn thành');
  ok(await S.ops.wait((m) => m.t === 'task' && m.task.status === 'completed'), 'điều phối thấy task hoàn thành qua WebSocket');
  const csv = await lead.req('GET', `/api/stats.csv?from=${task.date}&to=${task.date}`);
  ok(csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type')) && /attachment; filename="thong-ke-fo_/.test(csv.headers.get('content-disposition')) && csv.buf[0] === 0xef && csv.text.includes('Trần Văn Một'), 'tải CSV thống kê');
  const st = (await lead.req('GET', `/api/stats?from=${task.date}&to=${task.date}`)).json;
  ok(st.totals.completed === 1 && st.totals.cards_in === 4 && st.totals.bo_confirmed === 1 && st.totals.photos === 2, 'thống kê khớp');
});

await group('Traccar Client (/osmand)', async () => {
  const anon = client(S.base);
  const t = Math.floor(Date.now() / 1000) + 30;
  eq((await anon.req('GET', `/osmand?id=${fo.device}&lat=10.7801&lon=106.7033&timestamp=${t}&speed=10&bearing=90&batt=77&accuracy=6`)).text, 'ok', 'dạng query (tốc độ tính bằng knots)');
  const last = (await lead.req('GET', '/api/live')).json.fos[0].last;
  ok(last.lat === 10.7801 && Math.abs(last.spd - 5.14) < 0.02 && last.hdg === 90 && last.bat === 0.77, 'điểm được ghi đúng: 10 knots ≈ 5,14 m/s, pin 77%');
  const body = { device_id: fo.device, location: { timestamp: new Date(Date.now() + 60000).toISOString(), coords: { latitude: 10.7805, longitude: 106.704, accuracy: 5, speed: 3, heading: 45 }, battery: { level: 0.5 } } };
  eq((await anon.req('POST', '/osmand', body)).text, 'ok', 'dạng JSON của Traccar Client bản mới');
  eq((await anon.req('POST', `/osmand`, `id=${fo.device}&lat=10.781&lon=106.705&timestamp=${t + 80}`, { 'Content-Type': 'application/x-www-form-urlencoded' })).text, 'ok', 'dạng form');
  eq((await anon.req('GET', `/osmand?id=${fo.device}&lat=abc&lon=1`)).status, 400, 'toạ độ sai → 400');
  eq((await anon.req('PUT', '/osmand')).status, 405, 'sai phương thức → 405');
  const fo2 = await lead.req('POST', '/api/users', { name: 'FO Hai', username: 'fo2', role: 'fo' });
  const dev2 = (await lead.req('GET', `/api/users/${fo2.json.user.id}/device`)).json.deviceToken;
  eq((await anon.req('GET', `/osmand?id=${dev2}&lat=10.78&lon=106.7`)).status, 403, 'FO chưa đồng ý điều khoản → Traccar bị từ chối');
  const rot = (await lead.req('POST', `/api/users/${fo2.json.user.id}/device`)).json.deviceToken;
  ok(rot !== dev2 && (await anon.req('GET', `/osmand?id=${dev2}&lat=10.78&lon=106.7`)).status === 400, 'đổi mã thiết bị → mã cũ thành "thiết bị lạ"');
  let code = 0;
  for (let i = 0; i < 31; i++) code = (await anon.req('GET', `/osmand?id=thiet-bi-la-${i}-xxxxxxxx&lat=10.7&lon=106.7`)).status;
  eq(code, 429, 'dò mã thiết bị 30 lần → khoá IP tạm');
  eq((await anon.req('GET', `/osmand?id=${fo.device}&lat=10.7811&lon=106.7051`)).status, 429, 'đang bị khoá thì mã đúng cũng chờ');
});

await group('Khởi động lại máy chủ: phiên, task, ảnh, vị trí còn nguyên', async () => {
  S.ops.close(); S.fws.close();
  eq(await S.stop(), 0, 'tắt êm (mã thoát 0)');
  S = startServer(dir, { LEAD_PASS: 'Khoitao-12345' });
  await S.ready;
  lead = Object.assign(client(S.base), { cookie: lead.cookie }); fo.c = Object.assign(client(S.base), { cookie: fo.c.cookie }); boPhone = Object.assign(client(S.base), { bl: boPhone.bl });
  eq((await lead.req('GET', '/api/me')).json.user.username, 'admin', 'phiên đăng nhập cũ vẫn dùng được');
  eq((await boPhone.req('POST', '/api/bo-link/view', { token: boToken })).json.state, 'done', 'link của BO (đã xác nhận) vẫn xem lại được trên đúng thiết bị đó');
  const t = (await lead.req('GET', `/api/tasks/${task.id}`)).json;
  ok(t.task.status === 'completed' && t.task.stops[1].bo_status === 'confirmed' && t.events.length >= 5, 'task, điểm, nhật ký còn nguyên');
  eq((await lead.req('GET', `/api/photo/${photoId}`)).status, 200, 'ảnh vẫn xem được');
  const live = (await lead.req('GET', '/api/live')).json;
  ok(live.fos.find((f) => f.id === fo.id).last.lat === 10.781 && live.fos.find((f) => f.id === fo.id).onShift, 'vị trí cuối và ca đang mở được khôi phục');
  eq((await login(S.base, 'admin', 'Khoitao-12345')).r.status, 401, 'LEAD_PASS không tạo lại / ghi đè tài khoản Lead đã có');
});

await group('Đăng xuất, chặn dò mật khẩu qua HTTP', async () => {
  const { c } = await login(S.base, 'admin', 'Matkhau-lead-moi');
  const r = await c.req('POST', '/api/logout');
  ok(r.status === 200 && /Max-Age=0/.test(c.lastSetCookie) && c.cookie === '', 'đăng xuất xoá cookie');
  let code = 0;
  for (let i = 0; i < 9; i++) code = (await client(S.base).req('POST', '/api/login', { username: 'fo1', password: 'sai' + i })).status;
  eq(code, 429, 'sai mật khẩu 8 lần → 429');
  eq((await client(S.base).req('POST', '/api/login', { username: 'fo1', password: 'matkhau-fo1' })).status, 429, 'đang khoá thì mật khẩu đúng cũng phải chờ');
  eq((await fo.c.req('GET', '/api/my/tasks')).status, 200, 'người đang đăng nhập sẵn không bị ảnh hưởng');
});
await S.stop();

await group('Thời tiết tự động và cảnh báo ra Slack (máy chủ giả)', async () => {
  const got = { slack: [], weather: 0 };
  let weather = { current: { time: '2026-10-05T10:00', interval: 900, precipitation: 2.5, weather_code: 63 } };
  const mock = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      if (req.url.startsWith('/slack')) { got.slack.push(JSON.parse(b)); res.end('ok'); } else if (req.url.startsWith('/weather')) { got.weather++; if (weather === 'fail') { res.statusCode = 500; return res.end('x'); } res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(weather)); } else { res.statusCode = 404; res.end(); }
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port, d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-http2-'));
  const s2 = startServer(d2, { LEAD_PASS: 'Khoitao-12345', WEATHER_URL: `http://127.0.0.1:${mp}/weather`, SLACK_WEBHOOK_URL: `http://127.0.0.1:${mp}/slack` });
  await s2.ready;
  const { c } = await login(s2.base, 'admin', 'Khoitao-12345');
  await c.req('POST', '/api/password', { old: 'Khoitao-12345', new: 'Matkhau-lead-moi' });
  let cond = (await c.req('GET', '/api/conditions')).json;
  ok(cond.canAutoWeather === true && cond.weatherMode === 'manual', 'máy chủ có nguồn thời tiết, mặc định vẫn chỉnh tay');
  await c.req('PUT', '/api/conditions', { weatherMode: 'auto', trafficMode: 'manual', traffic: 'normal' });
  await sleep(400);
  cond = (await c.req('GET', '/api/conditions')).json;
  ok(cond.weather === 'heavy' && cond.factor === 1.4 && got.weather >= 1, 'bật tự động → đọc dịch vụ thời tiết: 2,5 mm / 15 phút = mưa to, hệ số 1.4');
  weather = 'fail';
  await c.req('PUT', '/api/conditions', { weatherMode: 'auto' });
  await sleep(400);
  cond = (await c.req('GET', '/api/conditions')).json;
  ok(cond.weather === 'heavy' && /HTTP 500/.test(cond.weatherErr), 'dịch vụ thời tiết lỗi → giữ mức cũ, báo lỗi cho điều phối');
  const f = await onboard(s2.base, c, { name: 'FO Ba', username: 'fo3', role: 'fo' });
  await f.c.req('POST', '/api/issues', { kind: 'tai_nan', note: 'Va quẹt nhẹ' });
  await sleep(400);
  ok(got.slack.length === 1 && got.slack[0].text.includes('FO Ba') && got.slack[0].text.includes('Tai nạn'), 'cảnh báo khẩn được đẩy sang Slack');
  await s2.stop(); mock.close();
  fs.rmSync(d2, { recursive: true, force: true });
});

await group('Chế độ mô phỏng (DEMO=1) và tài khoản đầu tiên tự sinh', async () => {
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-http3-'));
  const s3 = startServer(d3, { DEMO: '1' });
  await s3.ready;
  const { c, r } = await login(s3.base, 'lead', 'demo1234');
  eq(r.status, 200, 'đăng nhập tài khoản mẫu');
  const tasks = (await c.req('GET', '/api/tasks')).json.tasks;
  ok(tasks.length >= 15, `có task mẫu hôm nay (${tasks.length})`);
  const ws = await c.ws();
  ok(await ws.wait((m) => m.t === 'pos', 8000), 'FO mô phỏng đang phát vị trí');
  ok(await ws.wait((m) => m.t === 'task', 8000), 'task mô phỏng đang chuyển trạng thái');
  ws.close();
  eq((await login(s3.base, 'fo', 'demo1234')).r.json.user.consent_ok, false, 'tài khoản FO dùng thử chưa đồng ý điều khoản (để tự trải nghiệm)');
  await s3.stop();
  const s3b = startServer(d3, { DEMO: '1' });
  await s3b.ready;
  ok(!s3b.log().includes('Đã tạo dữ liệu mẫu'), 'chạy lại không tạo trùng dữ liệu mẫu');
  await s3b.stop();
  fs.rmSync(d3, { recursive: true, force: true });
  const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-http4-'));
  const s4 = startServer(d4, { TRUST_PROXY: '1' });
  await s4.ready;
  const txt = fs.readFileSync(path.join(d4, 'first-login.txt'), 'utf8'), pw = /Mật khẩu tạm: (\S+)/.exec(txt)[1];
  ok(/^[A-Za-z2-9]{10}$/.test(pw) && s4.log().includes(pw), 'không đặt LEAD_PASS → tự sinh mật khẩu tạm dễ gõ, in ra màn hình và lưu file');
  eq((fs.statSync(path.join(d4, 'first-login.txt')).mode & 0o077), 0, 'file mật khẩu chỉ chủ máy đọc được');
  eq((await login(s4.base, 'admin', pw)).r.json.user.must_change, true, 'đăng nhập được và bị bắt đổi mật khẩu');
  // Sau proxy ngược (TRUST_PROXY=1): cookie có Secure khi proxy báo https; IP lấy từ mục CUỐI của X-Forwarded-For (mục đầu người gửi tự khai được).
  const px = { 'X-Forwarded-For': '6.6.6.6, 203.0.113.9', 'X-Forwarded-Proto': 'https' };
  const a = client(s4.base);
  await a.req('POST', '/api/login', { username: 'admin', password: pw }, px);
  ok(/Secure/.test(a.lastSetCookie), 'sau proxy https: cookie phiên có cờ Secure');
  await a.req('POST', '/api/password', { old: pw, new: 'Matkhau-lead-moi' }, px);
  const made = await a.req('POST', '/api/users', { name: 'FO Proxy', username: 'fo.px', role: 'fo' }, px);
  const f = client(s4.base);
  await f.req('POST', '/api/login', { username: 'fo.px', password: made.json.tempPassword }, px);
  await f.req('POST', '/api/password', { old: made.json.tempPassword, new: 'matkhau-fo-px' }, px);
  const me = (await f.req('GET', '/api/me', undefined, px)).json;
  await f.req('POST', '/api/consent', { version: me.terms.version, checked: me.terms.items.map((_, i) => i) }, px);
  eq((await a.req('GET', '/api/consents', undefined, px)).json.consents[0].ip, '203.0.113.9', 'vết đồng ý ghi IP do proxy báo, không phải IP người gửi tự khai');
  await s4.stop();
  fs.rmSync(d4, { recursive: true, force: true });
});

fs.rmSync(dir, { recursive: true, force: true });
summary('HTTP / WebSocket');
