// core.test.mjs — kiểm thử lõi nghiệp vụ. Mỗi nhóm chạy 2 lần: kho bộ nhớ (bản xem thử) và kho SQLite (máy chủ).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mk, boDevice, ok, eq, group, summary, JPEG, PNG, MON_10H } from './harness.mjs';
import { distM, optimizeOrder, csvCell, decodeDataUrl, isDate, isHM, weekday, addDays, localDate, atTime, pathM } from '../core/util.js';

const MIN = 60000, OFF = 420;
const VP = { name: 'Văn phòng Atlas', type: 'office', lat: 10.7769, lon: 106.7009 };
const A = { name: 'BO A', type: 'bo', lat: 10.795, lon: 106.7218, phone: '0281234567' };
const B = { name: 'BO B', type: 'bo', lat: 10.803, lon: 106.737 };

async function world(kind, opt) {
  const h = mk(kind, opt);
  await h.user('lead1', 'lead', { name: 'Chị Lead' });
  await h.user('log1', 'logistic', { name: 'Anh Log' });
  const site = async (s) => (await h.call('log1', 'POST', '/api/sites', s)).body.site;
  const vp = await site(VP), a = await site(A), b = await site(B);
  await h.user('fo1', 'fo', { name: 'Trần Văn Một', vehicle: '59-A1 111.11', phone: '0900000001' });
  await h.user('fo2', 'fo', { name: 'Lê Thị Hai' });
  return { h, vp, a, b };
}
/** Cho FO "chạy" tới một toạ độ: gửi điểm GPS đều đặn, đồng hồ tiến theo. */
function drive(h, uname, toLat, toLon, { kmh = 30, stepSec = 10 } = {}) {
  const u = h.byName(uname), l = h.core.live.get(u.id);
  const start = l.last;
  const d = distM(start.lat, start.lon, toLat, toLon);
  const n = Math.max(1, Math.ceil(d / ((kmh / 3.6) * stepSec)));
  let good = 0;
  for (let i = 1; i <= n; i++) {
    h.clock.add(stepSec * 1000);
    if (h.core.ingest(u.id, { ts: h.clock.now(), lat: start.lat + ((toLat - start.lat) * i) / n, lon: start.lon + ((toLon - start.lon) * i) / n, acc: 8 }) === 'ok') good++;
  }
  return { n, good, d };
}
const at = (h, uname, p) => h.core.ingest(h.byName(uname).id, { ts: h.clock.now(), lat: p.lat, lon: p.lon, acc: 5 });
const events = (h, type) => h.store.events.find({ type });
const taskOf = async (h, id) => (await h.call('log1', 'GET', `/api/tasks/${id}`)).body.task;

async function suite(kind) {
  console.log(`\n── Kho ${kind === 'sqlite' ? 'SQLite' : 'bộ nhớ'} ──`);

  await group('Đăng nhập, phiên, chặn dò mật khẩu', async () => {
    const h = mk(kind);
    const lead = await h.user('lead1', 'lead');
    eq((await h.call(null, 'POST', '/api/login', { username: 'lead1', password: 'sai' })).status, 401, 'sai mật khẩu → 401');
    eq((await h.call(null, 'POST', '/api/login', { username: 'khong-co', password: 'x' })).status, 401, 'không có tài khoản → 401 (không lộ là tài khoản không tồn tại)');
    let r = await h.call(null, 'POST', '/api/login', { username: ' LEAD1 ', password: 'matkhau-lead1' });
    eq(r.status, 200, 'đăng nhập đúng (không phân biệt hoa thường, bỏ khoảng trắng)');
    const token = r.body.__session;
    ok(typeof token === 'string' && token.length >= 40, 'trả về mã phiên');
    ok(!('pass_hash' in r.body.user) && !('device_token' in r.body.user), 'không lộ mật khẩu băm / mã thiết bị');
    eq(h.core.authToken(token).id, lead.id, 'mã phiên → đúng người');
    eq(h.core.authToken('x'.repeat(43)), null, 'mã phiên bịa → null');
    eq(h.core.authToken(undefined), null, 'thiếu mã phiên → null');
    ok(!h.store.sessions.get(token), 'máy chủ chỉ lưu bản băm của mã phiên');
    h.core.logout(token);
    eq(h.core.authToken(token), null, 'đăng xuất → mã phiên hết hiệu lực');

    for (let i = 0; i < 8; i++) await h.call(null, 'POST', '/api/login', { username: 'lead1', password: 'sai' + i });
    eq((await h.call(null, 'POST', '/api/login', { username: 'lead1', password: 'matkhau-lead1' })).status, 429, 'sai 8 lần → khoá tạm kể cả khi nhập đúng');
    h.clock.add(10 * MIN + 1000);
    r = await h.call(null, 'POST', '/api/login', { username: 'lead1', password: 'matkhau-lead1' });
    eq(r.status, 200, 'hết 10 phút → đăng nhập lại được');
    const t2 = r.body.__session;
    h.clock.add(29 * 86400000);
    ok(h.core.authToken(t2), 'phiên còn hạn sau 29 ngày');
    h.clock.add(29 * 86400000);
    ok(h.core.authToken(t2), 'dùng đều thì phiên tự gia hạn');
    h.clock.add(31 * 86400000);
    eq(h.core.authToken(t2), null, 'bỏ 31 ngày → phiên hết hạn');
  });

  await group('Tạo tài khoản, phân quyền, đổi mật khẩu lần đầu', async () => {
    const { h, a } = await world(kind);
    let r = await h.call('lead1', 'POST', '/api/users', { name: 'Nguyễn Văn A', username: 'Fo.A', role: 'fo', phone: '0901', vehicle: '59-X1' });
    eq(r.status, 200, 'Lead tạo FO');
    const temp = r.body.tempPassword;
    ok(temp.length === 10 && r.body.user.must_change === true && r.body.user.username === 'fo.a', 'có mật khẩu tạm, bắt đổi lần đầu, tên đăng nhập về chữ thường');
    eq((await h.call('lead1', 'POST', '/api/users', { name: 'X', username: 'fo.a', role: 'fo' })).status, 409, 'trùng tên đăng nhập → 409');
    eq((await h.call('lead1', 'POST', '/api/users', { name: 'X', username: 'a b', role: 'fo' })).status, 400, 'tên đăng nhập có khoảng trắng → 400');
    eq((await h.call('lead1', 'POST', '/api/users', { name: 'X', username: 'boss', role: 'boss' })).status, 400, 'vai trò lạ → 400');
    eq((await h.call('lead1', 'POST', '/api/users', { name: '', username: 'noname', role: 'fo' })).status, 400, 'thiếu họ tên → 400');
    eq((await h.call('lead1', 'POST', '/api/users', { name: 'BO X', username: 'bo.x', role: 'bo' })).body.error, 'bad_role', 'không còn tài khoản BO (BO dùng link) → vai trò "bo" bị từ chối');
    eq((await h.call('log1', 'POST', '/api/users', { name: 'X', username: 'hack', role: 'lead' })).status, 403, 'Logistic thường không tạo được tài khoản');
    eq((await h.call(null, 'GET', '/api/users')).status, 401, 'chưa đăng nhập → 401');
    eq((await h.call('fo1', 'GET', '/api/tasks')).status, 403, 'FO không xem được bảng task của điều phối');
    eq((await h.call('fo1', 'GET', '/api/users')).status, 403, 'FO không xem được danh sách tài khoản');
    eq((await h.call(null, 'GET', '/api/live')).status, 401, 'chưa đăng nhập (kể cả BO cầm link) không xem được bản đồ vị trí chung');
    ok((await h.call('log1', 'GET', '/api/users')).body.users.every((u) => u.role === 'fo'), 'Logistic chỉ thấy danh sách FO');
    eq((await h.call('lead1', 'GET', '/api/nope')).status, 404, 'đường dẫn lạ → 404');
    eq((await h.call('lead1', 'DELETE', '/api/users')).status, 405, 'sai phương thức → 405');

    eq((await h.call('fo.a', 'GET', '/api/my/tasks')).body.error, 'password_change_required', 'chưa đổi mật khẩu → bị chặn');
    r = await h.call('fo.a', 'GET', '/api/me');
    ok(r.status === 200 && r.body.needConsent === true && r.body.terms.items.length >= 5 && r.body.deviceToken === null, '/api/me vẫn dùng được, kèm điều khoản, chưa lộ mã thiết bị');
    eq((await h.call('fo.a', 'POST', '/api/password', { old: 'x', new: '12345678' })).body.error, 'bad_old_password', 'sai mật khẩu cũ');
    eq((await h.call('fo.a', 'POST', '/api/password', { old: temp, new: 'ngan' })).body.error, 'weak_password', 'mật khẩu ngắn');
    eq((await h.call('fo.a', 'POST', '/api/password', { old: temp, new: temp })).body.error, 'same_password', 'mật khẩu mới trùng cũ');
    eq((await h.call('fo.a', 'POST', '/api/consent', { version: r.body.terms.version, checked: r.body.terms.items.map((_, i) => i) })).body.error, 'password_change_required', 'chưa đổi mật khẩu thì chưa đồng ý điều khoản được');
    eq((await h.call('fo.a', 'POST', '/api/password', { old: temp, new: 'matkhau-moi' })).status, 200, 'đổi mật khẩu');
    eq((await h.call(null, 'POST', '/api/login', { username: 'fo.a', password: temp })).status, 401, 'mật khẩu tạm hết dùng được');
    eq((await h.call('fo.a', 'GET', '/api/my/tasks')).body.error, 'consent_required', 'đổi mật khẩu xong vẫn phải đồng ý điều khoản');

    // Khoá tài khoản, cấp lại mật khẩu
    const tok = (await h.call(null, 'POST', '/api/login', { username: 'fo1', password: 'matkhau-fo1' })).body.__session;
    const got = []; let closed = false;
    h.core.subscribe(h.byName('fo1'), (m) => got.push(m), () => { closed = true; });
    eq((await h.call('lead1', 'PATCH', `/api/users/${h.byName('lead1').id}`, { active: false })).body.error, 'self_lock', 'Lead không tự khoá mình');
    eq((await h.call('lead1', 'PATCH', `/api/users/${h.byName('fo1').id}`, { active: false })).status, 200, 'khoá FO');
    ok(h.core.authToken(tok) === null && closed && got.some((m) => m.t === 'kick'), 'khoá → phiên chết, kết nối bị ngắt');
    ok(!h.core.snapshot().fos.some((f) => f.id === h.byName('fo1').id), 'FO bị khoá biến khỏi bản đồ');
    eq((await h.call(null, 'POST', '/api/login', { username: 'fo1', password: 'matkhau-fo1' })).status, 401, 'tài khoản bị khoá không đăng nhập được');
    eq((await h.call('lead1', 'PATCH', `/api/users/${h.byName('fo1').id}`, { active: true, name: 'Trần Một' })).body.user.name, 'Trần Một', 'mở lại + đổi tên');
    r = await h.call('lead1', 'POST', `/api/users/${h.byName('fo2').id}/reset`);
    ok(r.status === 200 && r.body.tempPassword.length === 10, 'cấp lại mật khẩu');
    eq((await h.call(null, 'POST', '/api/login', { username: 'fo2', password: 'matkhau-fo2' })).status, 401, 'mật khẩu cũ hết hiệu lực');
    eq((await h.call(null, 'POST', '/api/login', { username: 'fo2', password: r.body.tempPassword })).body.user.must_change, true, 'mật khẩu mới dùng được và bắt đổi');
  });

  await group('Đồng ý điều khoản: bắt buộc, có ghi vết, rút lại, đổi bản', async () => {
    const { h } = await world(kind);
    const fo = await h.user('fo9', 'fo', { noConsent: true, name: 'FO Chín' });
    eq(h.core.canTrack(fo), false, 'chưa đồng ý → không được ghi vị trí');
    eq(h.core.ingestDevice(fo.device_token, { lat: 10.77, lon: 106.7 }), 'not_allowed', 'Traccar cũng bị từ chối khi chưa đồng ý');
    eq(h.store.positions.count({ user_id: fo.id }), 0, 'không điểm nào được lưu');
    eq((await h.call('fo9', 'POST', '/api/loc', { pts: [{ lat: 10.77, lon: 106.7 }] })).body.error, 'consent_required', 'gửi vị trí qua HTTP bị chặn');
    eq((await h.call('fo9', 'POST', '/api/shift', { on: true })).body.error, 'consent_required', 'bắt đầu ca bị chặn');
    const tm = (await h.call('fo9', 'GET', '/api/terms')).body;
    eq((await h.call('fo9', 'POST', '/api/consent', { version: tm.version, checked: [0, 1] })).body.error, 'not_all_checked', 'thiếu mục → không nhận');
    eq((await h.call('fo9', 'POST', '/api/consent', { version: 'cu', checked: tm.items.map((_, i) => i) })).body.error, 'terms_changed', 'sai phiên bản → không nhận');
    eq((await h.call('log1', 'POST', '/api/consent', { version: tm.version, checked: [] })).status, 403, 'chỉ FO mới có bước này');
    eq((await h.call('fo9', 'POST', '/api/consent', { version: tm.version, checked: tm.items.map((_, i) => i) })).status, 200, 'đồng ý đủ mục');
    const rec = h.store.consents.find({ user_id: fo.id })[0];
    ok(rec.action === 'agree' && rec.version === tm.version && rec.ip === '10.0.0.1' && rec.ua === 'test-agent' && rec.items.length === tm.items.length && rec.ts === h.clock.now(), 'lưu vết: ai, lúc nào, IP, thiết bị, nguyên văn điều khoản');
    eq((await h.call('fo9', 'GET', '/api/my/tasks')).status, 200, 'đồng ý xong dùng được');
    ok((await h.call('fo9', 'GET', '/api/me')).body.deviceToken, 'đồng ý xong mới thấy mã thiết bị Traccar');
    eq(h.core.ingestDevice(h.byName('fo9').device_token, { lat: 10.77, lon: 106.7 }), 'ok', 'Traccar được nhận');
    ok(h.core.live.get(fo.id).onShift, 'điểm đầu tiên tự mở ca');

    eq((await h.call('fo9', 'POST', '/api/consent/withdraw')).status, 200, 'rút lại đồng ý');
    ok(!h.core.live.get(fo.id).onShift && !h.core.canTrack(h.byName('fo9')), 'rút → đóng ca, ngừng ghi vị trí');
    eq(h.core.ingestDevice(h.byName('fo9').device_token, { lat: 10.78, lon: 106.7 }), 'not_allowed', 'sau khi rút, điểm mới bị từ chối');
    ok(events(h, 'consent_withdrawn').length === 1 && h.notes.length === 1, 'điều phối nhận cảnh báo (kèm kênh ngoài)');
    eq((await h.call('fo9', 'GET', '/api/my/tasks')).body.error, 'consent_required', 'rút xong không dùng tiếp được');
    eq(h.store.consents.find({ user_id: fo.id }).map((c) => c.action), ['agree', 'withdraw'], 'cả 2 lần đều có vết');

    at(h, 'fo1', VP);
    ok(h.core.live.get(h.byName('fo1').id).onShift, 'fo1 đang trong ca');
    const got = [];
    h.core.subscribe(h.byName('fo1'), (m) => got.push(m));
    eq((await h.call('log1', 'PUT', '/api/terms', { items: ['x'] })).status, 403, 'Logistic thường không sửa được điều khoản');
    eq((await h.call('lead1', 'PUT', '/api/terms', { items: [] })).status, 400, 'điều khoản rỗng → 400');
    const next = (await h.call('lead1', 'PUT', '/api/terms', { intro: 'Bản mới', items: ['Mục một', 'Mục hai'] })).body;
    ok(next.version !== tm.version && next.items.length === 2, 'Lead sửa điều khoản → phiên bản mới');
    ok(h.core.needConsent(h.byName('fo1')) && !h.core.live.get(h.byName('fo1').id).onShift && got.some((m) => m.t === 'kick' && m.reason === 'terms'), 'đổi điều khoản → mọi FO phải đồng ý lại, ca đóng, app được báo');
    eq((await h.call('lead1', 'GET', '/api/consents', null, { user: String(fo.id) })).body.consents.length, 2, 'Lead xem được lịch sử đồng ý');
  });

  await group('Điểm giao nhận', async () => {
    const { h, a, b } = await world(kind);
    eq((await h.call('log1', 'POST', '/api/sites', { name: 'Sai', lat: 91, lon: 106 })).body.error, 'bad_coord', 'vĩ độ > 90 → 400');
    eq((await h.call('log1', 'POST', '/api/sites', { name: 'Sai', lat: 0, lon: 0 })).body.error, 'bad_coord', 'toạ độ 0,0 → 400');
    eq((await h.call('log1', 'POST', '/api/sites', { name: '', lat: 10, lon: 106 })).body.error, 'bad_name', 'thiếu tên → 400');
    eq((await h.call('log1', 'POST', '/api/sites', { name: 'R', lat: 10, lon: 106, radius: 5 })).body.error, 'bad_radius', 'bán kính quá nhỏ → 400');
    eq(a.radius, 120, 'bán kính mặc định 120 m');
    const p = await h.call('log1', 'PATCH', `/api/sites/${b.id}`, { name: 'BO B (mới)', radius: 200 });
    ok(p.body.site.name === 'BO B (mới)' && p.body.site.radius === 200 && p.body.site.lat === b.lat, 'sửa tên + bán kính, giữ toạ độ');
    eq((await h.call('fo1', 'GET', '/api/sites')).status, 403, 'FO không xem danh sách điểm');
    eq((await h.call('log1', 'DELETE', `/api/sites/${b.id}`)).status, 200, 'xoá điểm không còn dùng');
    eq((await h.call('log1', 'GET', '/api/sites')).body.sites.length, 2, 'danh sách còn 2 điểm');
    eq((await h.call('log1', 'POST', '/api/tasks', { stops: [{ site_id: b.id }] })).body.error, 'bad_site', 'không tạo task tới điểm đã xoá');
  });

  await group('Nhận vị trí: lọc điểm rác, tự tính tốc độ/hướng, quãng đường thực', async () => {
    const { h } = await world(kind);
    const fo = h.byName('fo1'), ing = (p) => h.core.ingest(fo.id, p);
    const t0 = h.clock.now();
    eq(ing({ ts: t0, lat: 10.7769, lon: 106.7009, acc: 10, bat: 0.8 }), 'ok', 'điểm đầu');
    eq(ing({ ts: t0, lat: 10.7769, lon: 106.7009, acc: 10 }), 'dup', 'trùng thời điểm');
    eq(ing({ ts: t0 + 5000, lat: 10.7769, lon: 106.7009, acc: 900 }), 'low_accuracy', 'sai số 900 m');
    eq(ing({ ts: t0 + 5000, lat: 95, lon: 106 }), 'bad_coord', 'vĩ độ 95');
    eq(ing({ ts: t0 + 5000, lat: 0, lon: 0 }), 'bad_coord', 'toạ độ 0,0');
    eq(ing({ ts: t0 + 5000, lat: 'abc', lon: 106 }), 'bad_coord', 'toạ độ không phải số');
    eq(ing(null), 'bad_point', 'điểm rỗng');
    eq(ing({ ts: t0 - 49 * 3600000, lat: 10.7, lon: 106.7 }), 'too_old', 'cũ hơn 48 giờ');
    eq(ing({ ts: t0 + 5000, lat: 11.5, lon: 107.5 }), 'jump', 'nhảy cóc 100+ km trong 5 giây');
    h.clock.add(10000);
    eq(ing({ ts: (t0 + 10000) / 1000, lat: 10.7778, lon: 106.7009, acc: 10 }), 'ok', 'mốc thời gian dạng giây vẫn nhận');
    const last = h.core.live.get(fo.id).last;
    ok(Math.abs(last.spd - 10) < 0.3 && last.hdg === 0 && last.bat === 0.8, `tự tính tốc độ ≈ 10 m/s, hướng Bắc, giữ mức pin (nhận spd=${last.spd}, hdg=${last.hdg}, bat=${last.bat})`);
    // GPS rung khi đứng yên không được cộng km
    const kmBefore = h.core.live.get(fo.id).day.km;
    for (let i = 1; i <= 20; i++) { h.clock.add(3000); ing({ ts: h.clock.now(), lat: 10.7778 + (i % 2 ? 0.00004 : -0.00004), lon: 106.7009, acc: 10 }); }
    ok(Math.abs(h.core.live.get(fo.id).day.km - kmBefore) < 0.001, 'đứng yên 1 phút (GPS rung ±4 m) → không cộng km');
    const leg = drive(h, 'fo1', A.lat, A.lon);
    const day = h.core.live.get(fo.id).day;
    ok(leg.good === leg.n && Math.abs(day.km - (0.1 + leg.d / 1000)) < 0.05, `chạy ${(leg.d / 1000).toFixed(2)} km → km trong ngày ${day.km.toFixed(2)}`);
    // Phát cho điều phối: gom theo nhịp, không lộ bí mật
    const got = [];
    h.core.subscribe(h.byName('log1'), (m) => got.push(m));
    h.clock.add(5000); ing({ ts: h.clock.now(), lat: A.lat + 0.001, lon: A.lon, acc: 9 });
    h.core.flushPositions(); h.core.flushPositions();
    const pos = got.filter((m) => m.t === 'pos');
    ok(pos.length === 1 && pos[0].u.length === 1 && pos[0].u[0].id === fo.id, 'vị trí mới phát 1 lần cho điều phối');
    const snap = JSON.stringify(h.core.snapshot());
    ok(!snap.includes(fo.device_token) && !snap.includes('pass_hash') && !snap.includes('username'), 'snapshot không chứa mã thiết bị / mật khẩu / tên đăng nhập');
    // Lịch sử
    const hist = await h.call('log1', 'GET', '/api/history', null, { fo: String(fo.id), date: localDate(h.clock.now(), OFF) });
    ok(hist.status === 200 && hist.body.pts.length === h.store.positions.count({ user_id: fo.id }) && hist.body.shifts.length === 1, 'lịch sử theo ngày + ca');
    eq((await h.call('fo2', 'GET', '/api/history', null, { fo: String(fo.id), date: localDate(h.clock.now(), OFF) })).body.pts.length, 0, 'FO chỉ xem được lịch sử của chính mình');
    eq((await h.call('log1', 'GET', '/api/history', null, { fo: String(fo.id), from: '0', to: String(30 * 86400000) })).status, 400, 'khoảng quá 8 ngày → 400');
    // Hết ca tự động + km được ghi xuống
    h.clock.add(11 * MIN); h.core.tick();
    ok(!h.core.live.get(fo.id).onShift, '10 phút không tín hiệu → tự đóng ca');
    ok(Math.abs(h.store.daily.get(`${fo.id}:${localDate(t0, OFF)}`).km - day.km) < 0.001, 'km trong ngày đã ghi xuống kho');
    eq(h.store.shifts.find({ user_id: fo.id })[0].end_reason, 'timeout', 'ca ghi lý do đóng');
  });

  await group('Task nhiều điểm, hai chiều, SLA', async () => {
    const { h, vp, a, b } = await world(kind);
    const mkTask = (body) => h.call('log1', 'POST', '/api/tasks', body);
    eq((await mkTask({ stops: [] })).body.error, 'no_stops', 'không có điểm → 400');
    eq((await mkTask({ stops: [{ site_id: a.id }], round_trip: true })).body.error, 'round_trip_needs_two', 'hai chiều mà chỉ 1 điểm → 400');
    eq((await mkTask({ stops: Array.from({ length: 16 }, () => ({ site_id: a.id })) })).body.error, 'too_many_stops', '16 điểm → 400');
    eq((await mkTask({ stops: [{ site_id: a.id, cards_out: -1 }] })).body.error, 'bad_count', 'số thẻ âm → 400');
    eq((await mkTask({ stops: [{ site_id: a.id, cards_out: 1.5 }] })).body.error, 'bad_count', 'số thẻ lẻ → 400');
    eq((await mkTask({ stops: [{ site_id: a.id }], fo_id: h.byName('log1').id })).body.error, 'bad_fo', 'giao cho người không phải FO → 400');
    eq((await mkTask({ stops: [{ site_id: a.id }], date: '2026-13-01' })).body.error, 'bad_date', 'ngày sai → 400');
    eq((await mkTask({ stops: [{ site_id: a.id }], date: '2026-09-01' })).body.error, 'bad_date', 'ngày quá khứ xa → 400');
    eq((await mkTask({ stops: [{ site_id: a.id }], start_time: '25:00' })).body.error, 'bad_time', 'giờ sai → 400');
    eq((await mkTask({ stops: [{ name: 'Điểm lẻ', lat: 200, lon: 1 }] })).body.error, 'bad_coord', 'điểm tự nhập sai toạ độ → 400');
    eq((await h.call('fo1', 'POST', '/api/tasks', { stops: [{ site_id: a.id }] })).status, 403, 'FO không tự tạo task');

    const r = await mkTask({ fo_id: h.byName('fo1').id, start_time: '10:30', round_trip: true, stops: [{ site_id: vp.id, cards_in: 4 }, { site_id: a.id, cards_out: 2, cards_in: 2, note: 'Gặp chị Lan' }, { site_id: b.id, cards_out: 2, cards_in: 2, dev_out: 1 }] });
    eq(r.status, 200, 'tạo task 3 điểm, hai chiều');
    const t = r.body.task;
    ok(t.stops.length === 4 && t.stops[3].is_return === 1 && t.stops[3].name === 'Quay về Văn phòng Atlas' && t.stops[3].lat === vp.lat, 'tự thêm chặng quay về điểm xuất phát');
    eq(t.title, 'BO A +1 điểm', 'tên task mặc định theo điểm đến');
    ok(/^T261005-\d{3}$/.test(t.code), `mã task theo ngày (${t.code})`);
    const km = (pathM([vp, a, b, vp]) / 1000) * 1.35, base = Math.ceil(((km / 22) * 60 + 3 * 6 + 10) / 5) * 5;
    ok(Math.abs(t.plan_km - km) < 0.02 && t.base_min === base, `quãng đường dự kiến ${t.plan_km} km, SLA gốc ${t.base_min} phút`);
    eq(t.start_at, atTime('2026-10-05', '10:30', OFF), 'giờ bắt đầu theo giờ Việt Nam');
    eq(t.due_at, t.start_at + base * MIN, 'hạn = bắt đầu + SLA gốc × 1.0');
    ok(t.status === 'assigned' && t.fo.name === 'Trần Văn Một', 'đã giao cho FO');
    const t2 = (await mkTask({ stops: [{ name: 'Điểm lẻ', lat: 10.78, lon: 106.69, cards_out: 1 }] })).body.task;
    ok(t2.status === 'unassigned' && t2.fo === null && t2.stops[0].site_id === null && t2.start_at === h.clock.now(), 'task tới điểm tự nhập, chưa giao ai, bắt đầu ngay');
    ok(t2.code !== t.code, 'mã task không trùng');
    const plan = await h.call('log1', 'POST', '/api/plan', { stops: [{ site_id: vp.id }, { site_id: a.id }], round_trip: true });
    ok(plan.body.base_min > 0 && plan.body.factor === 1 && plan.body.sla_min === plan.body.base_min, 'xem trước SLA khi soạn task');
    const opt = (await h.call('log1', 'POST', '/api/plan', { stops: [{ site_id: vp.id }, { site_id: b.id }, { site_id: a.id }], round_trip: false, optimize: true })).body;
    ok(JSON.stringify(opt.order) === '[0,2,1]' && opt.best_km < opt.plan_km, `gợi ý thứ tự ghé ngắn hơn (${opt.plan_km} → ${opt.best_km} km)`);

    // Điều kiện thời tiết / giao thông
    let c = (await h.call('log1', 'PUT', '/api/conditions', { weather: 'rain' })).body;
    eq(c.factor, 1.2, 'mưa → hệ số 1.2');
    eq((await taskOf(h, t.id)).due_at, t.start_at + Math.round(base * 1.2) * MIN, 'hạn của task chưa chạy được nới theo hệ số');
    ok(events(h, 'sla_adjust').length >= 1, 'có ghi vết điều chỉnh SLA');
    eq((await h.call('fo1', 'PUT', '/api/conditions', { weather: 'clear' })).status, 403, 'FO không chỉnh được điều kiện');
    eq((await h.call('log1', 'PUT', '/api/conditions', { weather: 'bao' })).status, 400, 'giá trị lạ → 400');
    await h.call('fo1', 'POST', `/api/tasks/${t.id}/start`);
    c = (await h.call('log1', 'PUT', '/api/conditions', { weather: 'clear', trafficMode: 'manual', traffic: 'jam' })).body;
    eq(c.factor, 1.5, 'kẹt xe nặng → 1.5');
    eq((await taskOf(h, t.id)).due_at, t.start_at + Math.round(base * 1.5) * MIN, 'task đang chạy: hạn được nới thêm');
    c = (await h.call('log1', 'PUT', '/api/conditions', { traffic: 'normal' })).body;
    eq(c.factor, 1, 'hết kẹt → 1.0');
    eq((await taskOf(h, t.id)).due_at, t.start_at + Math.round(base * 1.5) * MIN, 'task đang chạy: hạn không bị rút lại');
    eq((await taskOf(h, t2.id)).factor, 1, 'task chưa chạy: hạn trở về bình thường');
    // Giờ cao điểm tự động
    await h.call('log1', 'PUT', '/api/conditions', { trafficMode: 'auto' });
    h.clock.set(atTime('2026-10-05', '17:00', OFF)); h.core.tick();
    eq(h.core.conditions().traffic, 'peak', '17:00 thứ Hai → giờ cao điểm');
    eq((await taskOf(h, t2.id)).factor, 1.25, 'sang giờ cao điểm → task mở tự nới hạn');
    h.clock.set(atTime('2026-10-11', '17:00', OFF));
    eq(h.core.conditions().traffic, 'normal', 'Chủ nhật 17:00 → bình thường');
    // Thời tiết tự động
    h.clock.set(atTime('2026-10-05', '20:00', OFF));
    await h.call('log1', 'PUT', '/api/conditions', { weatherMode: 'auto' });
    h.setWeather({ precip: 3, code: 63, intervalSec: 900 }); eq(await h.core.refreshWeather(), 'heavy', '3 mm / 15 phút → mưa to');
    h.setWeather({ precip: 0.3, code: 61, intervalSec: 900 }); eq(await h.core.refreshWeather(), 'rain', '0,3 mm / 15 phút → mưa');
    h.setWeather({ precip: 0, code: 96, intervalSec: 900 }); eq(await h.core.refreshWeather(), 'storm', 'mã 96 → giông');
    h.setWeather(new Error('mat mang')); eq(await h.core.refreshWeather(), null, 'nguồn thời tiết lỗi → không đổi');
    ok(h.core.conditions().weather === 'storm' && h.core.conditions().weatherErr === 'mat mang', 'giữ mức cũ và báo lỗi nguồn');
    h.setWeather({ precip: 0, code: 1, intervalSec: 900 }); eq(await h.core.refreshWeather(), 'clear', 'tạnh');
    const h2 = mk(kind, { noWeather: true }); await h2.user('lead1', 'lead');
    eq((await h2.call('lead1', 'PUT', '/api/conditions', { weatherMode: 'auto' })).body.error, 'no_weather_source', 'máy chủ không bật nguồn thời tiết → báo rõ');
  });

  await group('FO thực hiện task: nhận, bắt đầu, tự nhận diện đã đến, ảnh, không giao được', async () => {
    const { h, vp, a, b } = await world(kind);
    const fo1 = h.byName('fo1');
    const mkTask = (body) => h.call('log1', 'POST', '/api/tasks', body);
    const t = (await mkTask({ fo_id: fo1.id, start_time: '10:05', round_trip: true, stops: [{ site_id: vp.id, cards_in: 4 }, { site_id: a.id, cards_out: 2, cards_in: 2 }, { site_id: b.id, cards_out: 2, cards_in: 2, dev_out: 1 }] })).body.task;
    const tB = (await mkTask({ fo_id: fo1.id, start_time: '13:00', stops: [{ site_id: b.id, cards_out: 1 }] })).body.task;
    const [s1, s2, s3, s4] = t.stops;
    const ops = [], mine = [], other = [], boMsg = [];
    h.core.subscribe(h.byName('log1'), (m) => ops.push(m));
    h.core.subscribe(fo1, (m) => mine.push(m));
    h.core.subscribe(h.byName('fo2'), (m) => other.push(m));

    eq((await h.call('fo1', 'GET', '/api/my/tasks')).body.tasks.length, 2, 'FO thấy 2 task của mình');
    eq((await h.call('fo2', 'GET', '/api/my/tasks')).body.tasks.length, 0, 'FO khác không thấy');
    eq((await h.call('fo2', 'POST', `/api/tasks/${t.id}/accept`)).body.error, 'not_yours', 'FO khác không nhận hộ được');
    eq((await h.call('fo2', 'GET', `/api/tasks/${t.id}`)).status, 403, 'FO khác không xem được chi tiết');
    eq((await h.call('fo1', 'POST', `/api/stops/${s1.id}/proof`, { photos: [JPEG] })).body.error, 'task_not_running', 'chưa bắt đầu thì chưa xác nhận điểm được');
    eq((await h.call('fo1', 'POST', `/api/tasks/${t.id}/accept`)).body.task.status, 'accepted', 'nhận task');
    eq((await h.call('fo1', 'POST', `/api/tasks/${t.id}/accept`)).body.error, 'bad_state', 'nhận 2 lần → báo lỗi rõ');
    at(h, 'fo1', vp); // đang đứng ở văn phòng
    h.core.setShift(fo1, false);
    let r = await h.call('fo1', 'POST', `/api/tasks/${t.id}/start`);
    ok(r.body.task.status === 'in_progress' && h.core.live.get(fo1.id).onShift, 'bắt đầu task → tự vào ca');
    ok(r.body.task.stops[0].status === 'arrived' && r.body.task.stops[0].arrive_mode === 'auto', 'đang đứng sẵn ở điểm đầu → tự ghi "đã đến"');
    eq(r.body.task.stops[3].status, 'pending', 'chặng quay về (cùng chỗ với điểm xuất phát) KHÔNG bị ghi "đã đến" ngay lúc xuất phát');
    eq((await h.call('fo1', 'POST', `/api/tasks/${tB.id}/start`)).body.error, 'busy', 'đang chạy 1 task thì không bắt đầu task khác');
    eq((await h.call('fo1', 'POST', `/api/stops/${s4.id}/proof`, {})).body.error, 'not_yet', 'chưa chốt các điểm khác thì chưa xác nhận "đã về" được');
    eq((await h.call('fo1', 'POST', `/api/stops/${s4.id}/arrive`, {})).body.error, 'not_yet', 'cũng chưa bấm "đã đến" cho chặng quay về được');
    eq((await h.call('log1', 'PATCH', `/api/tasks/${t.id}`, { stops: [{ site_id: a.id }] })).body.error, 'task_running', 'task đang chạy: không đổi danh sách điểm');

    eq((await h.call('fo1', 'POST', `/api/stops/${s1.id}/proof`, { cards_in: 4 })).body.error, 'photo_required', 'thiếu ảnh → không nhận');
    eq((await h.call('fo1', 'POST', `/api/stops/${s1.id}/proof`, { photos: ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='] })).body.error, 'bad_photo', 'SVG → không nhận');
    eq((await h.call('fo1', 'POST', `/api/stops/${s1.id}/proof`, { photos: [JPEG.replace('image/jpeg', 'image/png')] })).body.error, 'bad_photo', 'khai PNG nhưng nội dung là JPEG → không nhận');
    eq((await h.call('fo1', 'POST', `/api/stops/${s1.id}/proof`, { photos: [JPEG, JPEG, JPEG, JPEG, JPEG] })).body.error, 'too_many_photos', '5 ảnh → không nhận');
    eq((await h.call('fo1', 'POST', `/api/stops/${s1.id}/proof`, { photos: [JPEG], cards_in: 1000 })).body.error, 'bad_count', 'số lượng 1000 → không nhận');
    eq(h.files.size, 0, 'các lần bị từ chối không để lại tệp ảnh');
    r = await h.call('fo1', 'POST', `/api/stops/${s1.id}/proof`, { photos: [JPEG, PNG], cards_in: 4, note: 'Đủ thẻ' });
    ok(r.status === 200 && r.body.task.stops[0].status === 'done' && r.body.task.stops[0].photos.length === 2 && r.body.task.stops[0].bo_status === 'none', 'xác nhận điểm 1 (văn phòng) với 2 ảnh, không cần BO xác nhận');
    ok(r.body.task.stops[0].proof_dist <= 5, 'ghi khoảng cách tới điểm lúc xác nhận');
    eq(h.files.size, 2, 'tệp ảnh đã lưu');
    eq((await h.call('fo1', 'POST', `/api/stops/${s1.id}/proof`, { photos: [JPEG] })).body.error, 'bad_state', 'xác nhận 2 lần → báo lỗi rõ');

    // Link dùng một lần cho BO A
    eq((await h.call('fo1', 'POST', `/api/stops/${s2.id}/bo-link`)).status, 403, 'FO không tự tạo link cho BO được');
    eq((await h.call('log1', 'POST', `/api/stops/${s1.id}/bo-link`)).body.error, 'no_bo', 'điểm văn phòng không cần BO xác nhận → không có link');
    const lk = (await h.call('log1', 'POST', `/api/stops/${s2.id}/bo-link`)).body;
    ok(/^[A-Za-z0-9_-]{30,}$/.test(lk.token) && lk.task.stops[1].bo_link.opened_at === null && !JSON.stringify(lk.task).includes(lk.token) && !('bo_link_hash' in lk.task.stops[1]) && !JSON.stringify(h.store.stops.get(s2.id)).includes(lk.token), 'Logistic tạo link: mã chỉ trả về một lần, máy chủ chỉ giữ bản băm');
    const phoneA = boDevice(h), phoneX = boDevice(h, '10.0.0.66');
    eq((await phoneA.call('POST', '/api/bo-link/view', { token: 'x'.repeat(32) })).body.error, 'link_invalid', 'mã link sai → báo link hết hiệu lực');
    // Trên đường tới BO A: BO mở link, thấy FO đang đến
    drive(h, 'fo1', (vp.lat + a.lat) / 2, (vp.lon + a.lon) / 2);
    let v = (await phoneA.call('POST', '/api/bo-link/view', { token: lk.token })).body;
    ok(v.state === 'coming' && v.fo.name === 'Trần Văn Một' && !!v.pos && v.dist_km > 0.5 && v.eta_min >= 1 && v.before === 0 && v.photos === undefined && !!phoneA.dev, `BO mở link: thấy FO đang đến, vị trí, còn ~${v.dist_km} km, ~${v.eta_min} phút`);
    ok((await taskOf(h, t.id)).stops[1].bo_link.opened_at === h.clock.now() && events(h, 'bo_link_opened').length === 1, 'Logistic thấy BO đã mở link');
    eq((await phoneX.call('POST', '/api/bo-link/view', { token: lk.token })).body.error, 'link_used', 'thiết bị khác mở cùng link → bị từ chối (link chỉ dùng trên một thiết bị)');
    eq((await phoneA.call('POST', '/api/bo-link/view', { token: lk.token })).body.state, 'coming', 'thiết bị đã mở link tải lại trang vẫn xem tiếp được');
    eq((await phoneA.call('POST', '/api/bo-link/confirm', { token: lk.token, photos: [JPEG] })).body.error, 'bad_state', 'FO chưa giao nhận thì BO chưa xác nhận được');
    const lk2 = (await h.call('log1', 'POST', `/api/stops/${s2.id}/bo-link`)).body;
    eq((await phoneA.call('POST', '/api/bo-link/view', { token: lk.token })).body.error, 'link_invalid', 'Logistic tạo link mới → link cũ hết hiệu lực ngay');
    eq((await phoneX.call('POST', '/api/bo-link/view', { token: lk2.token })).body.state, 'coming', 'link mới mở được trên thiết bị khác');
    drive(h, 'fo1', a.lat, a.lon);
    let cur = await taskOf(h, t.id);
    ok(cur.stops[1].status === 'arrived' && cur.stops[1].arrive_mode === 'auto' && cur.stops[2].status === 'pending', 'vào vùng 120 m của BO A → tự ghi "đã đến"');
    eq((await phoneX.call('POST', '/api/bo-link/view', { token: lk2.token })).body.state, 'arrived', 'BO thấy FO đã tới nơi');
    ok(mine.some((m) => m.t === 'task' && m.task.id === t.id) && ops.some((m) => m.t === 'task') && !other.some((m) => m.t === 'task'), 'thay đổi được đẩy cho đúng FO và điều phối, không đẩy cho FO khác');
    r = await h.call('fo1', 'POST', `/api/stops/${s2.id}/proof`, { photos: [JPEG], cards_out: 2, cards_in: 1 });
    ok(r.body.task.stops[1].bo_status === 'pending' && events(h, 'bo_no_link').length === 0, 'giao nhận xong tại BO A → chờ BO xác nhận (đã có link nên không báo thiếu link)');
    eq(events(h, 'count_diff').length, 1, 'thu 1 thẻ thay vì 2 → cảnh báo lệch kế hoạch');

    // BO chưa xác nhận thì FO chưa đi tiếp được
    eq((await h.call('fo1', 'POST', `/api/stops/${s3.id}/arrive`)).body.error, 'wait_bo', 'BO chưa xác nhận → chưa bấm "đã đến" điểm kế tiếp được');
    eq((await h.call('fo1', 'POST', `/api/stops/${s3.id}/proof`, { photos: [JPEG] })).body.error, 'wait_bo', '…chưa xác nhận điểm kế tiếp được');
    eq((await h.call('fo1', 'POST', `/api/stops/${s3.id}/fail`, { reason: 'BO đóng cửa' })).body.error, 'wait_bo', '…chưa báo "không giao được" ở điểm kế tiếp được');
    drive(h, 'fo1', b.lat, b.lon);
    eq((await taskOf(h, t.id)).stops[2].status, 'pending', 'cứ chạy tới điểm kế tiếp khi BO chưa xác nhận → không tự ghi "đã đến"');
    v = (await phoneX.call('POST', '/api/bo-link/view', { token: lk2.token })).body;
    ok(v.state === 'confirm' && v.pos === undefined && v.fo_counts.cards_out === 2 && v.photos.length === 1, 'BO thấy lượt chờ xác nhận kèm số FO báo và ảnh FO chụp; không còn thấy vị trí FO');
    eq((await phoneX.call('POST', '/api/bo-link/confirm', { token: lk2.token, cards_recv: 2, cards_given: 1 })).body.error, 'photo_required', 'BO xác nhận phải có ảnh');
    eq((await phoneA.call('POST', '/api/bo-link/confirm', { token: lk2.token, photos: [JPEG], cards_recv: 2, cards_given: 1 })).body.error, 'link_used', 'thiết bị khác không xác nhận hộ được');
    eq((await h.call('log1', 'POST', '/api/bo-link/confirm', { token: lk2.token, photos: [JPEG] })).body.error, 'link_used', 'điều phối cũng không dùng link đó để xác nhận thay BO');
    const nMine = mine.length;
    v = (await phoneX.call('POST', '/api/bo-link/confirm', { token: lk2.token, photos: [JPEG], cards_recv: 2, cards_given: 1, note: 'Đủ' })).body;
    ok(v.state === 'done' && v.bo.status === 'confirmed' && v.bo.cards_recv === 2 && mine.length > nMine, 'số BO khớp số FO → đã xác nhận; FO được báo ngay');
    eq((await phoneX.call('POST', '/api/bo-link/confirm', { token: lk2.token, photos: [JPEG], cards_recv: 2, cards_given: 1 })).body.error, 'already_confirmed', 'link đã dùng để xác nhận → không xác nhận lần 2 được');
    eq((await h.call('log1', 'POST', `/api/stops/${s2.id}/bo-link`)).body.error, 'bad_state', 'lượt đã chốt → không tạo thêm link');
    h.clock.add(10000); at(h, 'fo1', b);
    cur = await taskOf(h, t.id);
    ok(cur.stops[2].status === 'arrived' && cur.stops[2].arrive_mode === 'auto', 'BO xác nhận xong → điểm kế tiếp được tính "đã đến"');
    eq((await h.call('fo1', 'POST', `/api/stops/${s3.id}/fail`, { reason: 'x' })).body.error, 'reason_required', 'không giao được phải có lý do');
    r = await h.call('fo1', 'POST', `/api/stops/${s3.id}/fail`, { reason: 'BO đóng cửa', photos: [JPEG] });
    ok(r.body.task.stops[2].status === 'failed' && r.body.task.status === 'in_progress' && events(h, 'stop_failed').length === 1, 'ghi nhận không giao được + cảnh báo điều phối; task vẫn chạy');

    // Quay về: tự đến, xác nhận không cần ảnh → task xong
    drive(h, 'fo1', vp.lat, vp.lon);
    eq((await taskOf(h, t.id)).stops[3].status, 'arrived', 'các điểm khác đã chốt, về tới nơi → chặng quay về tự ghi "đã đến"');
    r = await h.call('fo1', 'POST', `/api/stops/${s4.id}/proof`, {});
    cur = r.body.task;
    ok(cur.status === 'completed' && cur.partial === 1 && cur.finished_at === h.clock.now(), 'điểm quay về không cần ảnh; task hoàn thành một phần');
    const driven = (distM(vp.lat, vp.lon, a.lat, a.lon) + distM(a.lat, a.lon, b.lat, b.lon) + distM(b.lat, b.lon, vp.lat, vp.lon)) / 1000;
    ok(Math.abs(cur.km - driven) < 0.15, `km thực tế của task ${cur.km} ≈ quãng đã chạy ${driven.toFixed(2)}`);
    eq(cur.late, h.clock.now() > cur.due_at ? 1 : 0, 'cờ trễ hạn khớp với đồng hồ');
    eq(h.core.live.get(fo1.id).cur, null, 'FO hết task đang chạy');
    eq((await h.call('fo1', 'POST', `/api/stops/${s4.id}/proof`, {})).body.error, 'task_not_running', 'task xong rồi thì không xác nhận thêm được');
    eq((await h.call('log1', 'PATCH', `/api/tasks/${t.id}`, { title: 'x' })).body.error, 'task_closed', 'task đã kết thúc không sửa được');
    eq((await h.call('log1', 'POST', `/api/tasks/${t.id}/cancel`)).body.error, 'task_closed', 'task đã kết thúc không huỷ được');
    r = await h.call('fo1', 'POST', `/api/tasks/${tB.id}/start`);
    eq(r.body.task.status, 'in_progress', 'xong task trước → bắt đầu được task sau');

    // Quyền xem ảnh
    const foPhoto = cur.stops[0].photos[0].id, boSitePhoto = (await taskOf(h, t.id)).stops[1].photos.find((p) => p.by === 'bo').id;
    eq((await h.call('log1', 'GET', `/api/photo/${foPhoto}`)).body.__photo.mime, 'image/jpeg', 'điều phối xem được ảnh');
    eq((await h.call('fo1', 'GET', `/api/photo/${boSitePhoto}`)).status, 200, 'FO xem được ảnh thuộc task của mình');
    eq((await h.call('fo2', 'GET', `/api/photo/${foPhoto}`)).status, 403, 'FO khác không xem được');
    eq((await phoneX.call('GET', `/api/bo-link/photo/${boSitePhoto}`, null, { t: lk2.token })).status, 200, 'BO xem được ảnh của lượt giao nhận tại điểm mình qua link');
    eq((await phoneX.call('GET', `/api/bo-link/photo/${foPhoto}`, null, { t: lk2.token })).status, 404, 'BO không xem được ảnh ở điểm khác');
    eq((await phoneA.call('GET', `/api/bo-link/photo/${boSitePhoto}`, null, { t: lk2.token })).status, 403, 'thiết bị khác không xem được ảnh qua link');
    eq((await h.call('log1', 'GET', '/api/photo/../../etc/passwd')).status, 404, 'mã ảnh lạ → 404');
    eq((await h.call(null, 'GET', `/api/photo/${foPhoto}`)).status, 401, 'chưa đăng nhập không xem được ảnh');

    // Task một điểm tại BO B: bấm "đã đến" khi còn xa; BO chưa có link; BO báo lệch; task chỉ xong khi BO xác nhận
    const t3 = (await mkTask({ fo_id: h.byName('fo2').id, stops: [{ site_id: b.id, cards_out: 3, dev_in: 1 }] })).body.task;
    await h.call('fo2', 'POST', `/api/tasks/${t3.id}/start`);
    at(h, 'fo2', vp);
    r = await h.call('fo2', 'POST', `/api/stops/${t3.stops[0].id}/arrive`);
    ok(r.body.task.stops[0].status === 'arrived' && r.body.task.stops[0].arrive_mode === 'manual' && events(h, 'far_arrive').length === 1, 'bấm tay "đã đến" khi còn cách xa → vẫn ghi nhưng gắn cờ cho điều phối');
    eq((await h.call('fo2', 'POST', `/api/stops/${t3.stops[0].id}/arrive`)).body.error, 'bad_state', 'bấm "đã đến" lần 2 → báo lỗi rõ');
    drive(h, 'fo2', b.lat, b.lon);
    let nNotes = h.notes.length;
    r = await h.call('fo2', 'POST', `/api/stops/${t3.stops[0].id}/proof`, { photos: [JPEG], cards_out: 3, dev_in: 1 });
    ok(r.body.task.status === 'in_progress' && r.body.task.stops[0].bo_status === 'pending' && events(h, 'bo_no_link').length === 1 && h.notes.length === nNotes + 1, 'điểm cuối là BO: BO chưa xác nhận thì task chưa xong; BO chưa có link → báo khẩn cho Logistic');
    const lk3 = (await h.call('log1', 'POST', `/api/stops/${t3.stops[0].id}/bo-link`)).body, phoneB = boDevice(h, '10.0.0.77');
    nNotes = h.notes.length;
    v = (await phoneB.call('POST', '/api/bo-link/confirm', { token: lk3.token, photos: [JPEG], cards_recv: 2, dev_given: 1 })).body;
    ok(v.state === 'done' && v.bo.status === 'mismatch' && events(h, 'bo_mismatch').length === 1 && h.notes.length === nNotes + 1, 'BO báo nhận 2 thẻ, FO báo giao 3 → cảnh báo lệch (kèm kênh ngoài)');
    const t3done = await taskOf(h, t3.id);
    ok(t3done.status === 'completed' && t3done.partial === 0 && t3done.late === 0 && t3done.finished_at === h.clock.now(), 'BO xác nhận (dù lệch số) → task hoàn thành, đúng hạn');

    // Thống kê trong ngày
    const st = (await h.call('lead1', 'GET', '/api/stats', null, { from: '2026-10-05', to: '2026-10-05' })).body;
    const f1 = st.fos.find((f) => f.fo.id === fo1.id), f2 = st.fos.find((f) => f.fo.id === h.byName('fo2').id);
    ok(f1.tasks === 2 && f1.completed === 1 && f1.open === 1 && f1.stops_done === 3 && f1.stops_failed === 1, `fo1: 2 task (1 xong, 1 đang chạy), 3 điểm xong, 1 không giao được (nhận ${JSON.stringify({ t: f1.tasks, c: f1.completed, o: f1.open, d: f1.stops_done, f: f1.stops_failed })})`);
    ok(f1.cards_in === 5 && f1.cards_out === 2 && f1.photos === 4 && f1.bo_confirmed === 1, `fo1: thu 5 thẻ, giao 2 thẻ, 4 ảnh, 1 lượt BO xác nhận (nhận in=${f1.cards_in} out=${f1.cards_out} ảnh=${f1.photos} bo=${f1.bo_confirmed})`);
    ok(Math.abs(f1.km - h.core.live.get(fo1.id).day.km) < 0.06 && f1.km > driven - 0.2, `fo1: km trong ngày ${f1.km}`);
    ok(f2.completed === 1 && f2.ontime === 1 && f2.ontime_pct === 100 && f2.cards_out === 3 && f2.dev_in === 1 && f2.bo_mismatch === 1, 'fo2: 1 task đúng hạn, 1 lượt BO báo lệch');
    eq(st.totals.completed, 2, 'tổng số task hoàn thành');
    const csv = (await h.call('lead1', 'GET', '/api/stats.csv', null, { from: '2026-10-05', to: '2026-10-05' })).body.__csv;
    ok(csv.text.startsWith('\ufeffNgày,FO,Km thực tế') && csv.text.split('\r\n').length === 4 && csv.text.includes('Trần Văn Một') && csv.name.endsWith('.csv'), 'xuất CSV (có BOM để Excel đọc đúng tiếng Việt)');
    eq((await h.call('lead1', 'GET', '/api/stats', null, { from: '2026-10-05', to: '2026-10-01' })).status, 400, 'khoảng ngày ngược → 400');
    eq((await h.call('lead1', 'GET', '/api/stats', null, { from: '2026-01-01', to: '2026-10-05' })).status, 400, 'khoảng quá 93 ngày → 400');
    eq((await h.call('log1', 'GET', '/api/stats', null, { from: '2026-10-05', to: '2026-10-05' })).status, 403, 'Logistics Executive không xem thống kê từng FO (chỉ Lead và Quản trị)');
    const sum = (await h.call('fo1', 'GET', '/api/my/summary')).body;
    ok(sum.row.completed === 1 && sum.row.km === f1.km && sum.onShift === true, 'FO xem được tổng kết ngày của chính mình');
    eq((await h.call('fo1', 'GET', '/api/stats')).status, 403, 'FO không xem được thống kê của người khác');
  });

  await group('Giao lại, từ chối, huỷ, gợi ý FO gần nhất, báo sự cố', async () => {
    const { h, a, b } = await world(kind);
    const fo1 = h.byName('fo1'), fo2 = h.byName('fo2');
    const t = (await h.call('log1', 'POST', '/api/tasks', { fo_id: fo1.id, stops: [{ site_id: a.id, cards_out: 1 }, { site_id: b.id, cards_out: 1 }] })).body.task;
    const m1 = [], m2 = [];
    h.core.subscribe(fo1, (m) => m1.push(m)); h.core.subscribe(fo2, (m) => m2.push(m));
    eq((await h.call('fo1', 'POST', `/api/tasks/${t.id}/decline`, { reason: '' })).body.error, 'reason_required', 'từ chối phải có lý do');
    eq((await h.call('fo1', 'POST', `/api/tasks/${t.id}/decline`, { reason: 'Xe hỏng' })).status, 200, 'FO từ chối');
    let cur = await taskOf(h, t.id);
    ok(cur.status === 'unassigned' && cur.fo === null && events(h, 'task_declined')[0].level === 'alert' && m1.some((m) => m.t === 'task_gone' && m.id === t.id), 'task về trạng thái chưa giao, điều phối được báo, app FO gỡ task');
    at(h, 'fo2', { lat: a.lat + 0.002, lon: a.lon });
    at(h, 'fo1', { lat: a.lat + 0.05, lon: a.lon });
    const sg = (await h.call('log1', 'GET', '/api/suggest', null, { lat: String(a.lat), lon: String(a.lon) })).body.fos;
    ok(sg[0].id === fo2.id && sg[0].km < 0.5 && sg[1].id === fo1.id && sg[1].km > 5, 'gợi ý FO gần điểm đầu nhất lên trước');
    cur = (await h.call('log1', 'PATCH', `/api/tasks/${t.id}`, { fo_id: fo2.id, start_time: '11:00', title: 'Chuyến sáng' })).body.task;
    ok(cur.status === 'assigned' && cur.fo.id === fo2.id && cur.title === 'Chuyến sáng' && cur.start_at === atTime('2026-10-05', '11:00', OFF) && cur.due_at === cur.start_at + cur.base_min * MIN && m2.some((m) => m.t === 'task'), 'giao lại cho FO khác + đổi giờ → hạn tính lại, FO mới nhận được');
    cur = (await h.call('log1', 'PATCH', `/api/tasks/${t.id}`, { round_trip: true })).body.task;
    ok(cur.stops.length === 3 && cur.stops[2].is_return === 1 && cur.stops[0].exp_cards_out === 1, 'đổi sang hai chiều: giữ nguyên điểm, thêm chặng về');
    cur = (await h.call('log1', 'PATCH', `/api/tasks/${t.id}`, { stops: [{ site_id: b.id, dev_in: 2 }], round_trip: false })).body.task;
    ok(cur.stops.length === 1 && cur.stops[0].exp_dev_in === 2 && cur.plan_km === 0, 'thay danh sách điểm khi task chưa chạy');
    await h.call('fo2', 'POST', `/api/tasks/${t.id}/start`);
    cur = (await h.call('log1', 'PATCH', `/api/tasks/${t.id}`, { fo_id: fo1.id })).body.task;
    ok(cur.status === 'assigned' && cur.started_at === null && h.core.live.get(fo2.id).cur === null && m2.some((m) => m.t === 'task_gone'), 'giao lại khi đang chạy: FO cũ được gỡ, FO mới nhận lại từ đầu');
    eq((await h.call('fo2', 'POST', `/api/stops/${cur.stops[0].id}/proof`, { photos: [JPEG] })).body.error, 'not_yours', 'FO cũ không xác nhận được nữa');
    const sg2 = (await h.call('log1', 'GET', '/api/suggest', null, { lat: String(a.lat), lon: String(a.lon) })).body.fos;
    eq(sg2.find((f) => f.id === fo1.id).open, 1, 'gợi ý có tính số task đang mở của từng FO');
    eq((await h.call('fo1', 'POST', '/api/issues', { kind: 'bay', note: '' })).body.error, 'bad_kind', 'loại sự cố lạ → 400');
    eq((await h.call('fo1', 'POST', '/api/issues', { kind: 'hong_xe', note: 'Thủng lốp', task_id: t.id })).status, 200, 'FO báo sự cố');
    ok(events(h, 'issue')[0].text.includes('Hỏng xe') && events(h, 'issue')[0].text.includes(t.code), 'cảnh báo sự cố có loại và mã task');
    cur = (await h.call('log1', 'POST', `/api/tasks/${t.id}/cancel`, { reason: 'Dời sang mai' })).body.task;
    ok(cur.status === 'cancelled' && cur.cancel_reason === 'Dời sang mai' && m1.some((m) => m.t === 'task' && m.task.status === 'cancelled'), 'huỷ task, FO được báo');
    eq((await h.call('fo1', 'POST', `/api/tasks/${t.id}/start`)).body.error, 'bad_state', 'task đã huỷ không bắt đầu được');
    // Cảnh báo: xem, đánh dấu đã xử lý
    let al = (await h.call('log1', 'GET', '/api/alerts')).body;
    ok(al.open >= 2 && al.alerts.every((e) => e.level !== 'info'), 'danh sách cảnh báo chỉ gồm mức cần chú ý');
    await h.call('log1', 'POST', `/api/alerts/${al.alerts[0].id}/ack`);
    eq((await h.call('log1', 'GET', '/api/alerts')).body.open, al.open - 1, 'đánh dấu đã xử lý 1 cảnh báo');
    await h.call('log1', 'POST', '/api/alerts/ack-all');
    eq((await h.call('log1', 'GET', '/api/alerts')).body.open, 0, 'đánh dấu đã xử lý tất cả');
    eq((await h.call('fo1', 'GET', '/api/alerts')).status, 403, 'FO không xem được cảnh báo điều phối');
  });

  await group('Cảnh báo tự động: chưa bắt đầu, sắp trễ, trễ hạn, mất tín hiệu, BO chậm xác nhận, cho qua', async () => {
    const { h, a } = await world(kind);
    const fo1 = h.byName('fo1');
    const t = (await h.call('log1', 'POST', '/api/tasks', { fo_id: fo1.id, start_time: '10:10', stops: [{ site_id: a.id, cards_out: 1 }] })).body.task;
    const n = (type) => events(h, type).length;
    h.core.tick();
    eq(n('task_not_started') + n('sla_risk') + n('sla_late'), 0, 'chưa tới giờ → không cảnh báo');
    h.clock.set(t.start_at + 11 * MIN); h.core.tick(); h.core.tick();
    eq(n('task_not_started'), 1, 'quá giờ bắt đầu 10 phút → cảnh báo đúng 1 lần');
    at(h, 'fo1', { lat: a.lat + 0.01, lon: a.lon });
    await h.call('fo1', 'POST', `/api/tasks/${t.id}/start`);
    h.clock.set(t.due_at - 5 * MIN); at(h, 'fo1', { lat: a.lat + 0.009, lon: a.lon }); h.core.tick(); h.core.tick();
    ok(n('sla_risk') === 1 && n('sla_late') === 0, 'còn 5 phút tới hạn → cảnh báo sắp trễ 1 lần');
    h.clock.set(t.due_at + MIN); at(h, 'fo1', { lat: a.lat + 0.008, lon: a.lon }); h.core.tick(); h.core.tick();
    eq(n('sla_late'), 1, 'quá hạn → cảnh báo trễ 1 lần');
    await h.call('log1', 'PUT', '/api/conditions', { weather: 'storm' });
    const cur = await taskOf(h, t.id);
    ok(cur.due_at > h.clock.now() && cur.al_late === 0, 'giông bão nới hạn → task hết bị coi là trễ');
    h.clock.add(4 * MIN); h.core.tick(); h.core.tick();
    eq(n('lost_signal'), 1, '3 phút không có vị trí khi đang làm task → cảnh báo mất tín hiệu 1 lần');
    at(h, 'fo1', { lat: a.lat + 0.007, lon: a.lon });
    h.clock.add(4 * MIN); h.core.tick();
    eq(n('lost_signal'), 2, 'có tín hiệu lại rồi mất tiếp → cảnh báo lần mới');
    h.clock.add(7 * MIN); h.core.tick();
    ok(n('lost_long') === 1 && !h.core.live.get(fo1.id).onShift, 'mất tín hiệu quá 10 phút → ca tự đóng + cảnh báo gọi FO');
    h.clock.add(10000); at(h, 'fo1', a);
    ok(h.core.live.get(fo1.id).onShift && (await taskOf(h, t.id)).stops[0].status === 'arrived', 'có sóng lại → tự mở ca, tự ghi đã đến');
    await h.call('fo1', 'POST', `/api/stops/${t.stops[0].id}/proof`, { photos: [JPEG], cards_out: 1 });
    eq(n('bo_no_link'), 1, 'giao nhận xong mà BO chưa có link → báo khẩn ngay');
    h.clock.add(4 * MIN); h.core.tick();
    eq(n('bo_slow'), 0, 'BO chưa quá 5 phút → chưa nhắc');
    h.clock.add(2 * MIN); h.core.tick(); h.core.tick();
    ok(n('bo_slow') === 1 && events(h, 'bo_slow')[0].level === 'alert' && events(h, 'bo_slow')[0].text.includes('BO chưa có link'), 'BO quá 5 phút chưa xác nhận → nhắc khẩn 1 lần, nói rõ BO chưa có link');
    eq((await h.call('fo1', 'POST', `/api/stops/${t.stops[0].id}/bo-waive`, { reason: 'tự cho qua' })).status, 403, 'FO không tự cho qua xác nhận của BO được');
    eq((await h.call('log1', 'POST', `/api/stops/${t.stops[0].id}/bo-waive`, { reason: '' })).body.error, 'reason_required', 'cho qua phải có lý do');
    const wl = (await h.call('log1', 'POST', `/api/stops/${t.stops[0].id}/bo-link`)).body.token;
    const w = await h.call('log1', 'POST', `/api/stops/${t.stops[0].id}/bo-waive`, { reason: 'BO hết pin, đã gọi điện xác nhận' });
    ok(w.body.task.status === 'completed' && w.body.task.stops[0].bo_status === 'waived' && n('bo_waived') === 1, 'Logistic cho qua (có lý do) → task hoàn thành, có ghi vết');
    eq((await boDevice(h).call('POST', '/api/bo-link/view', { token: wl })).body.error, 'link_invalid', 'đã cho qua → link của BO hết hiệu lực');
    h.core.setShift(fo1, true);
    const t2 = (await h.call('log1', 'POST', '/api/tasks', { fo_id: fo1.id, stops: [{ site_id: a.id }] })).body.task;
    await h.call('fo1', 'POST', `/api/tasks/${t2.id}/start`);
    h.core.setShift(fo1, false);
    eq(n('shift_end_in_task'), 1, 'FO kết thúc ca khi task chưa xong → điều phối được báo');
  });

  await group('Link BO: chỉ lộ vị trí khi FO đang làm đúng task đó, task huỷ, hết hạn 48 giờ, chặn dò mã', async () => {
    const { h, a } = await world(kind);
    const fo1 = h.byName('fo1');
    const mk1 = async () => (await h.call('log1', 'POST', '/api/tasks', { fo_id: fo1.id, stops: [{ site_id: a.id, cards_out: 1 }] })).body.task;
    const t = await mk1();
    const lk = (await h.call('log1', 'POST', `/api/stops/${t.stops[0].id}/bo-link`)).body.token, phone = boDevice(h);
    let v = (await phone.call('POST', '/api/bo-link/view', { token: lk })).body;
    ok(v.state === 'waiting' && v.fo.name === 'Trần Văn Một' && v.pos === undefined && v.site.name === 'BO A' && v.exp.cards_out === 1, 'task chưa bắt đầu: BO thấy tên FO, kế hoạch giao nhận; chưa thấy vị trí');
    h.core.setShift(fo1, true); at(h, 'fo1', a);
    eq((await phone.call('POST', '/api/bo-link/view', { token: lk })).body.pos, undefined, 'FO đang trong ca nhưng chưa bắt đầu task này → BO không thấy vị trí');
    await h.call('log1', 'POST', `/api/tasks/${t.id}/cancel`, { reason: 'Đổi lịch' });
    v = (await phone.call('POST', '/api/bo-link/view', { token: lk })).body;
    ok(v.state === 'closed' && v.fo === null && v.pos === undefined, 'task bị huỷ → link báo lượt giao nhận đã đóng, không còn thông tin FO');
    eq((await h.call('log1', 'POST', `/api/stops/${t.stops[0].id}/bo-link`)).body.error, 'bad_state', 'task đã huỷ → không tạo link nữa');
    const t2 = await mk1();
    const lk2 = (await h.call('log1', 'POST', `/api/stops/${t2.stops[0].id}/bo-link`)).body.token;
    eq((await phone.call('POST', '/api/bo-link/view', { token: lk2 })).status, 200, 'cùng điện thoại mở link của lượt khác → được (mỗi lượt một link)');
    h.clock.add(47 * 3600000);
    eq((await phone.call('POST', '/api/bo-link/view', { token: lk2 })).status, 200, 'sau 47 giờ link còn dùng được');
    h.clock.add(2 * 3600000);
    eq((await phone.call('POST', '/api/bo-link/view', { token: lk2 })).body.error, 'link_invalid', 'quá 48 giờ → link hết hạn');
    const bad = boDevice(h, '10.0.0.200');
    let code = 0;
    for (let i = 0; i < 31; i++) code = (await bad.call('POST', '/api/bo-link/view', { token: 'ma-link-doan-mo-'.padEnd(30, 'x') + i })).status;
    eq(code, 429, 'dò mã link 30 lần từ một IP → khoá tạm IP đó');
    const lk3 = (await h.call('log1', 'POST', `/api/stops/${t2.stops[0].id}/bo-link`)).body.token;
    eq((await bad.call('POST', '/api/bo-link/view', { token: lk3 })).status, 429, 'đang bị khoá thì link đúng cũng phải chờ');
    eq((await boDevice(h, '10.0.0.201').call('POST', '/api/bo-link/view', { token: lk3 })).status, 200, 'IP khác không bị ảnh hưởng');
  });

  await group('Tuyến định kỳ: tự sinh task theo lịch', async () => {
    const { h, vp, a, b } = await world(kind);
    const fo1 = h.byName('fo1');
    const body = { name: 'Swap thẻ sáng', fo_id: fo1.id, days: [1, 3, 5], start_time: '14:00', round_trip: true, stops: [{ site_id: vp.id, cards_in: 4 }, { site_id: a.id, cards_out: 2, cards_in: 2 }, { site_id: b.id, cards_out: 2, cards_in: 2 }] };
    eq((await h.call('log1', 'POST', '/api/templates', { ...body, days: [] })).body.error, 'bad_days', 'không chọn ngày → 400');
    eq((await h.call('log1', 'POST', '/api/templates', { ...body, start_time: '7h' })).body.error, 'bad_time', 'giờ sai → 400');
    eq((await h.call('log1', 'POST', '/api/templates', { ...body, stops: [{ name: 'Lẻ', lat: 10, lon: 106 }] })).body.error, 'bad_stop', 'điểm của tuyến phải lấy từ danh sách Điểm');
    eq((await h.call('fo1', 'POST', '/api/templates', body)).status, 403, 'FO không tạo tuyến');
    const tpl = (await h.call('log1', 'POST', '/api/templates', body)).body.template;
    eq(tpl.days, [1, 3, 5], 'lưu lịch T2-T4-T6');
    const day = async (d) => (await h.call('log1', 'GET', '/api/tasks', null, { date: d })).body.tasks;
    let ts = await day('2026-10-05');
    ok(ts.length === 1 && ts[0].template_id === tpl.id && ts[0].title === 'Swap thẻ sáng' && ts[0].stops.length === 4 && ts[0].start_at === atTime('2026-10-05', '14:00', OFF) && ts[0].fo.id === fo1.id, 'tạo tuyến trước giờ chạy hôm nay (thứ Hai) → có task ngay');
    h.core.tick(); h.core.tick();
    eq((await day('2026-10-05')).length, 1, 'không sinh trùng');
    eq((await h.call('log1', 'POST', `/api/templates/${tpl.id}/run`, {})).body.error, 'already_generated', 'bấm tạo tay khi đã có → báo rõ');
    h.clock.set(atTime('2026-10-06', '00:01', OFF)); h.core.tick();
    eq((await day('2026-10-06')).length, 0, 'thứ Ba không có trong lịch → không sinh');
    h.clock.set(atTime('2026-10-07', '00:01', OFF)); h.core.tick(); h.core.tick();
    eq((await day('2026-10-07')).length, 1, 'sang thứ Tư → tự sinh');
    // Tuyến tạo sau giờ chạy → hôm nay không tự sinh, bấm tay thì được
    h.clock.set(atTime('2026-10-07', '15:00', OFF));
    const tpl2 = (await h.call('log1', 'POST', '/api/templates', { ...body, name: 'Tuyến chiều', days: [3], start_time: '09:00', round_trip: false })).body.template;
    eq((await day('2026-10-07')).length, 1, 'tuyến tạo sau giờ chạy → hôm nay không tự sinh');
    const run = await h.call('log1', 'POST', `/api/templates/${tpl2.id}/run`, {});
    ok(run.status === 200 && run.body.task.stops.length === 3, 'bấm "Tạo task hôm nay" → có task');
    // FO của tuyến bị khoá; điểm bị xoá
    eq((await h.call('log1', 'DELETE', `/api/sites/${b.id}`)).body.error, 'site_in_use', 'điểm đang nằm trong tuyến → không xoá');
    await h.call('lead1', 'PATCH', `/api/users/${fo1.id}`, { active: false });
    await h.call('log1', 'PATCH', `/api/templates/${tpl.id}`, { days: [4] });
    h.clock.set(atTime('2026-10-08', '00:01', OFF)); h.core.tick();
    ts = await day('2026-10-08');
    ok(ts.length === 1 && ts[0].status === 'unassigned' && events(h, 'template_warn').some((e) => e.level === 'alert'), 'FO của tuyến bị khoá → task vẫn sinh, chưa giao, có cảnh báo');
    eq((await h.call('log1', 'PATCH', `/api/templates/${tpl.id}`, { active: false })).body.template.active, false, 'tạm dừng tuyến');
    h.clock.set(atTime('2026-10-15', '00:01', OFF)); h.core.tick();
    eq((await day('2026-10-15')).length, 0, 'tuyến tạm dừng → không sinh');
    eq((await h.call('log1', 'DELETE', `/api/templates/${tpl.id}`)).status, 200, 'xoá tuyến');
    eq((await h.call('log1', 'GET', '/api/templates')).body.templates.length, 1, 'còn 1 tuyến');
  });

  await group('Dọn dữ liệu hết hạn lưu', async () => {
    const { h, a } = await world(kind, { cfg: { retentionDays: 30, photoRetentionDays: 60 } });
    const fo1 = h.byName('fo1');
    at(h, 'fo1', a);
    const t = (await h.call('log1', 'POST', '/api/tasks', { fo_id: fo1.id, stops: [{ site_id: a.id }] })).body.task;
    await h.call('fo1', 'POST', `/api/tasks/${t.id}/start`);
    await h.call('fo1', 'POST', `/api/stops/${t.stops[0].id}/proof`, { photos: [JPEG] });
    await h.call(null, 'POST', '/api/login', { username: 'fo1', password: 'matkhau-fo1' });
    h.clock.add(31 * 86400000);
    let out = h.core.maintenance();
    ok(out.positions >= 1 && out.photos === 0 && out.sessions === 1 && h.store.positions.count() === 0 && h.files.size === 1, 'sau 31 ngày: xoá vị trí và phiên hết hạn, ảnh còn');
    h.clock.add(30 * 86400000);
    out = h.core.maintenance();
    ok(out.photos === 1 && h.files.size === 0 && h.store.photos.count() === 0, 'sau 61 ngày: xoá cả ảnh lẫn tệp');
    ok((await taskOf(h, t.id)).stops[0].status === 'done', 'hồ sơ task vẫn còn');
  });
}

await group('Tiện ích: tối ưu thứ tự điểm, CSV, ảnh, ngày giờ', async () => {
  const pts = [{ lat: 10.77, lon: 106.7 }, { lat: 10.85, lon: 106.75 }, { lat: 10.78, lon: 106.71 }, { lat: 10.84, lon: 106.74 }, { lat: 10.79, lon: 106.72 }];
  eq(optimizeOrder(pts), [0, 2, 4, 3, 1], 'thứ tự ngắn nhất, giữ điểm đầu');
  eq(optimizeOrder(pts.slice(0, 2)), [0, 1], '2 điểm giữ nguyên');
  const many = Array.from({ length: 14 }, (_, i) => ({ lat: 10.7 + ((i * 7) % 14) * 0.01, lon: 106.7 + ((i * 5) % 14) * 0.01 }));
  const ord = optimizeOrder(many, true), len = (o) => o.reduce((s, x, i) => s + (i ? distM(many[o[i - 1]].lat, many[o[i - 1]].lon, many[x].lat, many[x].lon) : 0), 0);
  ok(ord[0] === 0 && new Set(ord).size === 14 && len(ord) <= len(many.map((_, i) => i)), '14 điểm: đủ điểm, không dài hơn thứ tự gốc');
  eq([csvCell('a,b'), csvCell('x"y'), csvCell('=1+1'), csvCell(-5), csvCell(null), csvCell('-5')], ['"a,b"', '"x""y"', "'=1+1", '-5', '', "'-5"], 'CSV: thoát dấu phẩy, nháy kép, chặn công thức');
  ok(decodeDataUrl(JPEG, 1000) && decodeDataUrl(PNG, 1000) && !decodeDataUrl(JPEG, 5) && !decodeDataUrl('data:text/html;base64,PGI+', 1000) && !decodeDataUrl('data:image/jpeg;base64,AAAA', 1000) && !decodeDataUrl(12, 1000), 'ảnh: nhận JPEG/PNG thật, từ chối quá cỡ, sai loại, sai chữ ký');
  ok(isDate('2026-02-28') && !isDate('2026-02-30') && !isDate('26-2-1') && isHM('07:05') && !isHM('24:00') && !isHM('7:5'), 'kiểm tra ngày, giờ');
  ok(weekday('2026-10-05') === 1 && weekday('2026-10-11') === 7 && addDays('2026-12-31', 1) === '2027-01-01' && localDate(Date.parse('2026-10-04T17:30:00Z'), 420) === '2026-10-05', 'thứ trong tuần, cộng ngày, ngày theo giờ Việt Nam');
});

await suite('memory');
await suite('sqlite');

await group('SQLite: khởi động lại giữ nguyên trạng thái', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-core-')), file = path.join(dir, 'atlas.db');
  const { h, a } = await world('sqlite', { file });
  const fo1 = h.byName('fo1');
  at(h, 'fo1', { lat: a.lat + 0.02, lon: a.lon });
  const t = (await h.call('log1', 'POST', '/api/tasks', { fo_id: fo1.id, stops: [{ site_id: a.id, cards_out: 1 }, { name: 'Lẻ', lat: 10.9, lon: 106.8 }] })).body.task;
  await h.call('fo1', 'POST', `/api/tasks/${t.id}/start`);
  drive(h, 'fo1', a.lat + 0.005, a.lon);
  const before = { km: h.core.live.get(fo1.id).day.km, taskKm: h.core.live.get(fo1.id).cur.km, last: h.core.live.get(fo1.id).last };
  await h.call('log1', 'PUT', '/api/conditions', { weather: 'rain' });
  h.core.shutdown(); h.store.close();
  const h2 = mk('sqlite', { file, t: h.clock.now() + 30000 });
  const l = h2.core.live.get(fo1.id);
  ok(l.onShift && l.last.ts === before.last.ts && l.trail.length > 3, 'ca đang mở, vị trí cuối và vệt đường được khôi phục');
  ok(Math.abs(l.day.km - before.km) < 0.001 && l.cur && l.cur.taskId === t.id && Math.abs(l.cur.km - before.taskKm) < 0.001, 'km trong ngày và task đang chạy được khôi phục');
  eq(h2.core.conditions().weather, 'rain', 'điều kiện thời tiết được giữ');
  eq((await h2.call('fo1', 'GET', '/api/my/tasks')).body.tasks[0].status, 'in_progress', 'FO vẫn thấy task đang chạy');
  h2.clock.add(10000);
  h2.core.ingest(fo1.id, { ts: h2.clock.now(), lat: a.lat, lon: a.lon, acc: 5 });
  eq((await h2.call('log1', 'GET', `/api/tasks/${t.id}`)).body.task.stops[0].status, 'arrived', 'sau khởi động lại vẫn tự nhận diện "đã đến"');
  h2.store.close();
  // Khởi động lại sau khi nghỉ lâu: ca cũ được đóng đúng lúc mất tín hiệu
  const h3 = mk('sqlite', { file, t: h2.clock.now() + 3 * 3600000 });
  ok(!h3.core.live.get(fo1.id).onShift && h3.store.shifts.find({ user_id: fo1.id })[0].end_reason === 'timeout', 'máy chủ nghỉ 3 giờ → ca cũ được đóng lại');
  h3.store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

summary('Lõi nghiệp vụ');
