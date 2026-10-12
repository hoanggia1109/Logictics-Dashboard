// route.test.mjs — đường đi thực tế (deps.route giả, không gọi mạng) và SLA theo đường (mô hình v2):
// lấy đường sau khi giao dịch ghi xong, SLA tính từ đường (lịch từng chặng theo khung giờ, dừng P50 / P85 từng điểm, dự phòng theo độ bất định),
// hệ số không tính kẹt xe hai lần, task đang chạy chỉ nới hạn, điểm đổi / task đóng trong lúc chờ thì bỏ kết quả, dịch vụ lỗi thì giữ ước tính,
// quyền xem đường, link BO chỉ lộ đường FO → BO (kèm cảnh báo đường xe máy đang thử nghiệm), dự kiến xong khi đang chạy, chuyến Ops Hub / tuyến định kỳ,
// dọn đường cũ, hiệu chỉnh theo lịch sử (thời gian dừng, hệ số đi, γ của dự phòng, tỉ lệ kịp hạn), cấu hình gửi giao diện.
// Mỗi nhóm chạy 2 lần: kho bộ nhớ và kho SQLite.
import crypto from 'node:crypto';
import { SCHEMA } from '../core/schema.js';
import { createMemoryStore } from '../core/store-memory.js';
import { createSqliteStore } from '../core/store-sqlite.js';
import { createCore } from '../core/core.js';
import { quantile, calibService, calibTravel, calibGamma, zOf, routeSla } from '../core/tasks.js';
import { distM, pathM, atTime, decodePolyline, encodePolyline, projectOnPath, slicePath } from '../core/util.js';
import { boDevice, ok, eq, group, summary, JPEG, MON_10H } from './harness.mjs';

const MIN = 60000, OFF = 420;
const VP = { name: 'Văn phòng Atlas', type: 'office', lat: 10.7769, lon: 106.7009 };
const A = { name: 'BO A', type: 'bo', lat: 10.795, lon: 106.7218 };
const B = { name: 'BO B', type: 'bo', lat: 10.803, lon: 106.737 };
const BETA = 'Đường xe máy của Google đang thử nghiệm (beta): vài đoạn có thể chưa sát thực tế.';
const Z85 = 1.0364333894937898, Z90 = 1.2815515655446004; // z tra bảng (lõi tính xấp xỉ, sai số cỡ 1e-9)

/** Hình chặng giả "theo phố": đi qua một điểm lệch khỏi đường thẳng (không trùng toạ độ điểm nào). */
const legPath = (a, b) => [[a.lat, a.lon], [+(a.lat + (b.lat - a.lat) / 2 + 0.003).toFixed(6), +(a.lon + (b.lon - a.lon) / 2 - 0.003).toFixed(6)], [b.lat, b.lon]];
const pathLen = (p) => p.slice(1).reduce((s, q, i) => s + distM(p[i][0], p[i][1], q[0], q[1]), 0);
/** Một chặng giả: chạy speed m/giây khi thông thoáng, kẹt xe chậm thêm theo slow. */
function fakeLeg(a, b, { speed = 6, slow = 1.2 } = {}) {
  const same = a.lat === b.lat && a.lon === b.lon, path = same ? [[a.lat, a.lon]] : legPath(a, b);
  const d = Math.round(pathLen(path)), st = Math.round(d / speed);
  return { distance_m: d, duration_s: Math.round(st * slow), static_s: st, polyline: same ? '' : encodePolyline(path), jams: same ? [] : [[0, 1, 1]] };
}
/** Dịch vụ đường đi giả, điều khiển được: lỗi, giữ câu trả lời (chờ), trả dữ liệu hỏng, ném lỗi ngay, phương tiện / cảnh báo trả về. */
function fakeRoute(h) {
  const ctl = { calls: [], held: [], hold: false, fail: null, bad: false, sync: false, speed: 6, slow: 1.2, traffic: true, provider: 'google', mode: 'TWO_WHEELER', warnings: [] };
  ctl.fn = (points, opts) => {
    ctl.calls.push({ points, opts, inTx: h.store.inTx() });
    if (ctl.sync) throw new Error('Lỗi đồng bộ');
    const make = () => {
      if (ctl.fail) throw ctl.fail;
      if (ctl.bad) return { provider: 'google', legs: [] };
      const legs = points.slice(1).map((p, i) => fakeLeg(points[i], p, ctl)), sum = (k) => legs.reduce((s, l) => s + l[k], 0);
      return { provider: ctl.provider, mode: ctl.mode, traffic: ctl.traffic, depart_at: opts.departAt, at: h.clock.now(), distance_m: sum('distance_m'), duration_s: sum('duration_s'), static_s: sum('static_s'), legs, warnings: ctl.warnings };
    };
    if (ctl.hold) return new Promise((res, rej) => ctl.held.push(() => { try { res(make()); } catch (e) { rej(e); } }));
    return Promise.resolve().then(make);
  };
  return ctl;
}
/** Phút dừng mặc định (chưa có lịch sử): điểm thường P50 6 / P85 10; BO cần xác nhận P50 8 / P85 16 (thêm thời gian chờ BO). */
const SVC = (s) => (s.type === 'bo' ? { p50: 8, p85: 16 } : { p50: 6, p85: 10 });
/** Giờ cao điểm như lõi: T2–T7, 6:30–9:00 và 16:30–19:30 giờ Việt Nam. */
const isPeak = (ts) => { const d = new Date(ts + OFF * MIN), m = d.getUTCHours() * 60 + d.getUTCMinutes(), wd = d.getUTCDay(); return wd >= 1 && wd <= 6 && ((m >= 390 && m < 540) || (m >= 990 && m < 1170)); };
/**
 * SLA mong đợi (mô hình v2) theo đường giả qua các điểm; rt: điểm cuối là chặng quay về (không dừng).
 * Lịch từng chặng: rời điểm đầu lúc depart, đi T = phút theo bản đồ × k(lúc rời), chặng sau rời lúc tới + P50 dừng ở điểm đó.
 * P50 = ΣT + Σ P50 dừng; U = √(XT² + XS²), XT = ΣT (e^(zσT) − 1), σT = √(σday² + σleg² / Leff), Leff = (ΣT)² / ΣT², XS = √Σ(P85 − P50)²;
 * dự phòng = max(floor, base + γU); làm tròn từng phần rồi cộng, làm tròn lên bội 5.
 */
function expectPlan(points, { speed = 6, slow = 1.2, k = 1, depart = MON_10H, rt = false, svc = SVC, z = Z85, base = 3, floor = 5, gamma = 1, sLeg = 0.3, sDay = 0.12 } = {}) {
  const legs = points.slice(1).map((p, i) => fakeLeg(points[i], p, { speed, slow })), sv = points.map((p, i) => (rt && i === points.length - 1 ? null : svc(p)));
  const kf = typeof k === 'function' ? k : () => k, T = [];
  let dep = depart;
  for (let i = 0; i < legs.length; i++) { T.push((legs[i].duration_s / 60) * kf(dep)); dep += (T[i] + (sv[i + 1] ? sv[i + 1].p50 : 0)) * MIN; }
  const sumT = T.reduce((s, x) => s + x, 0), sumT2 = T.reduce((s, x) => s + x * x, 0), on = sv.filter(Boolean);
  const xt = sumT * (Math.exp(z * Math.sqrt(sDay ** 2 + sLeg ** 2 / (sumT2 > 0 ? sumT ** 2 / sumT2 : 1))) - 1), xs = Math.sqrt(on.reduce((s, v) => s + (v.p85 - v.p50) ** 2, 0)) * (z / Z85), u = Math.sqrt(xt ** 2 + xs ** 2);
  const travel = Math.round(sumT), service = Math.round(on.reduce((s, v) => s + v.p50, 0)), buffer = Math.round(Math.max(floor, base + gamma * u)), sum = (key) => legs.reduce((s, l) => s + l[key], 0);
  return { plan_km: +(sum('distance_m') / 1000).toFixed(2), travel_min: travel, service_min: service, buffer_min: buffer, traffic_min: Math.max(0, Math.round((sum('duration_s') - sum('static_s')) / 60)), base_min: Math.ceil((travel + service + buffer) / 5) * 5, p50_min: travel + service, unc_min: Math.round(u), T, u };
}
/** Các cột SLA theo đường của một task (để so một lần). */
const slaCols = (x) => [x.plan_km, x.travel_min, x.service_min, x.buffer_min, x.base_min, x.p50_min, x.unc_min];
const slaWant = (w) => [w.plan_km, w.travel_min, w.service_min, w.buffer_min, w.base_min, w.p50_min, w.unc_min];
/** SLA ước tính đường chim bay (planOf) như trước khi có đường thực tế. */
const estOf = (pts, work) => { const km = (pathM(pts) / 1000) * 1.35; return { plan_km: +km.toFixed(2), base_min: Math.ceil(((km / 22) * 60 + work * 6 + 10) / 5) * 5 }; };

/** Dựng lõi như test/harness.mjs (đồng hồ giả) nhưng có thêm deps.route giả. opt.noRoute: không có dịch vụ đường đi. */
function mkR(kind, opt = {}) {
  let t = opt.t ?? MON_10H;
  const files = new Map(), notes = [];
  const store = kind === 'sqlite' ? createSqliteStore(SCHEMA, ':memory:') : createMemoryStore(SCHEMA);
  const h = { store, files, notes, clock: { now: () => t, set: (v) => { t = v; }, add: (ms) => { t += ms; } } };
  const deps = {
    store, now: () => t, cfg: opt.cfg || {},
    hashPassword: async (p) => 'h:' + p,
    verifyPassword: async (p, x) => x === 'h:' + p,
    token: (n) => crypto.randomBytes(n).toString('base64url'),
    sha: (s) => crypto.createHash('sha256').update(s).digest('hex'),
    files: { put: (id, bytes, mime) => files.set(id, { bytes, mime }), remove: (id) => files.delete(id) },
    notify: (text) => notes.push(text),
  };
  if (!opt.noRoute) { h.route = fakeRoute(h); deps.route = (pts, o) => h.route.fn(pts, o); }
  h.core = createCore(deps);
  h.byName = (username) => store.users.find({ username }, { limit: 1 })[0] || null;
  h.call = (who, method, path, body, query) => h.core.api({ user: who ? h.byName(who) : null, ip: '10.0.0.1', ua: 'test-agent' }, method, path, query || {}, body || {});
  h.user = async (username, role, extra = {}) => {
    const r = await h.core.createUser({ username, name: extra.name || username, role, password: 'matkhau-' + username, must_change: false, ...extra }, null);
    if (role === 'fo') store.users.update(r.user.id, { consent_version: h.core.terms().version, consent_at: t });
    return h.byName(username);
  };
  h.idle = () => h.core.tasks.routeIdle();
  return h;
}
async function world(kind, opt) {
  const h = mkR(kind, opt);
  for (const [u, role, name] of [['ad', 'admin', 'Quản trị'], ['lead1', 'lead', 'Chị Lead'], ['log1', 'logistic', 'Anh Log'], ['fo1', 'fo', 'FO Một'], ['fo2', 'fo', 'FO Hai'], ['sale1', 'sale', 'Sale Một'], ['tech1', 'tech', 'Tech Một']]) await h.user(u, role, { name });
  const site = async (s) => (await h.call('log1', 'POST', '/api/sites', s)).body.site;
  return { h, vp: await site(VP), a: await site(A), b: await site(B) };
}
const mkTask = (h, body) => h.call('log1', 'POST', '/api/tasks', body);
const flush = () => new Promise((r) => setImmediate(r));
const at = (h, uname, lat, lon) => h.core.ingest(h.byName(uname).id, { ts: h.clock.now(), lat, lon, acc: 5 });
const pts = (...ss) => ss.map((s) => ({ lat: s.lat, lon: s.lon }));
const mid = (p) => ({ lat: +((p[0][0] + p[1][0]) / 2).toFixed(6), lon: +((p[0][1] + p[1][1]) / 2).toFixed(6) }); // giữa đoạn đầu của chặng
/** Hiệu chỉnh v2 ghi sẵn vào kho (trước lần đọc đầu tiên): thay số tính từ lịch sử để kiểm từng phần. */
const calib = (h, o = {}) => h.store.settings.insert({ id: 'sla_calib', value: { v: 2, at: h.clock.now(), travel: { k: 1, n: 0, peak: { k: 1, n: 0 }, off: { k: 1, n: 0 } }, service: { default: { min: 6, min50: null, min85: null, n: 0 }, sites: [] }, buffer: { gamma: 1, n: 0, target_pct: 85, coverage: null, n_cov: 0 }, ...o } });
let pastSeq = 0;
/** Chuyến đã xong ghi thẳng vào kho (lịch sử để hiệu chỉnh γ): a = số phút thực tế (bắt đầu → xong) chia hệ số điều kiện; ontime: xong trước hạn. */
function past(store, o) {
  const date = o.date || '2026-10-01', st = atTime(date, '09:00', OFF), f = o.factor ?? 1, fin = st + Math.round(o.a * f * MIN);
  return store.tasks.insert({
    code: `H${++pastSeq}`, title: 'Lịch sử', date, start_at: st, started_at: st, finished_at: fin, due_at: o.ontime ? fin : fin - MIN, factor: f, base_min: 60, status: o.status || 'completed',
    round_trip: 0, plan_km: 5, km: 5, late: o.ontime ? 0 : 1, partial: 0, created_at: st, route_src: o.src === undefined ? 'google' : o.src, p50_min: o.p50 === undefined ? 40 : o.p50, unc_min: o.unc === undefined ? 10 : o.unc,
  });
}

async function suite(kind) {
  console.log(`\n── Kho ${kind === 'sqlite' ? 'SQLite' : 'bộ nhớ'} ──`);

  await group('Tạo task: lưu ngay với SLA ước tính; đường thực tế lấy sau khi ghi xong, SLA tính lại theo đường (mô hình v2)', async () => {
    const { h, vp, a, b } = await world(kind);
    eq((await h.call('log1', 'GET', '/api/me')).body.cfg.routing, true, 'giao diện biết máy chủ có đường thực tế (cfg.routing)');
    const ops = [], mine = [];
    h.core.subscribe(h.byName('log1'), (m) => ops.push(m));
    h.core.subscribe(h.byName('fo1'), (m) => mine.push(m));
    const r = await mkTask(h, { fo_id: h.byName('fo1').id, start_time: '10:30', round_trip: true, stops: [{ site_id: vp.id }, { site_id: a.id }, { site_id: b.id }] });
    const t = r.body.task, est = estOf([vp, a, b, vp], 3);
    ok(r.status === 200 && t.route_src === null && t.base_min === est.base_min && t.due_at === t.start_at + est.base_min * MIN, `tạo xong ngay với SLA ước tính đường chim bay (${est.base_min} phút), chưa chờ dịch vụ`);
    ok(t.p50_min === null && t.unc_min === null && t.sla_q === null && t.route_mode === null, 'chưa có đường: chưa có các số của mô hình theo đường');
    await h.idle();
    eq(h.route.calls.length, 1, 'gọi dịch vụ đường đi đúng 1 lần');
    const c0 = h.route.calls[0];
    eq(c0.inTx, false, 'chỉ gọi dịch vụ sau khi giao dịch ghi xong');
    eq(c0.points, pts(vp, a, b, vp), 'chỉ gửi toạ độ các điểm giao nhận theo thứ tự (chặng về = điểm đầu), không gửi vị trí FO');
    eq(c0.opts.departAt, t.start_at, 'giờ xuất phát = giờ bắt đầu của task (10:30)');
    const cur = h.store.tasks.get(t.id), want = expectPlan([vp, a, b, vp], { rt: true, depart: t.start_at });
    eq([cur.route_src, cur.route_traffic, cur.route_mode, cur.traffic_min, cur.sla_q, ...slaCols(cur)], ['google', 1, 'TWO_WHEELER', want.traffic_min, 85, ...slaWant(want)],
      `SLA gốc = đi ${want.travel_min} + dừng ${want.service_min} (văn phòng 6, BO A 8, BO B 8) + dự phòng ${want.buffer_min} (3 + U ${want.u.toFixed(1)}), làm tròn lên bội 5 → ${want.base_min} phút`);
    ok(want.service_min === 22 && want.p50_min === want.travel_min + 22 && want.buffer_min > 5, 'đối chứng: dừng 22 phút (BO cần xác nhận thêm 2 phút chờ), dự phòng trên mức tối thiểu');
    ok(cur.factor === 1 && cur.due_at === cur.start_at + want.base_min * MIN && cur.route_err === null && cur.route_at === MON_10H, 'hạn theo SLA mới (trời tạnh, ngoài giờ cao điểm: ×1)');
    const rows = h.store.routes.find({ task_id: t.id });
    ok(rows.length === 1 && rows[0].legs.length === 3 && rows[0].provider === 'google' && rows[0].traffic === 1 && rows[0].mode === 'TWO_WHEELER', 'lưu 1 dòng đường đi, 3 chặng');
    const ev = h.store.events.find({ type: 'route_ready', task_id: t.id });
    ok(ev.length === 1 && ev[0].level === 'info' && ev[0].text.includes('Đã có đường đi thực tế') && ev[0].text.includes(`ước tính trước: ${est.base_min} phút`), 'ghi vết: đã có đường thực tế, SLA mới so với ước tính');
    const last = (list) => list.filter((m) => m.t === 'task' && m.task.id === t.id).pop();
    ok(last(ops).task.route_src === 'google' && last(mine).task.base_min === want.base_min && last(ops).task.route_mode === 'TWO_WHEELER', 'điều phối và FO nhận ngay task đã cập nhật (kèm phương tiện của đường)');
    const view = (await h.call('log1', 'GET', `/api/tasks/${t.id}`)).body.task;
    ok(view.travel_min === want.travel_min && view.service_min === 22 && view.p50_min === want.p50_min && view.unc_min === want.unc_min && view.sla_q === 85 && view.route_mode === 'TWO_WHEELER' && !JSON.stringify(view).includes('polyline') && !JSON.stringify(last(ops)).includes('polyline'), 'task trả về có phần tách SLA (P50, độ bất định, % nhắm tới, phương tiện), không kèm hình đường');
    h.core.tick();
    const cal = h.store.settings.get('sla_calib');
    ok(cal && cal.value.v === 2 && cal.value.at === h.clock.now() && cal.value.travel.k === 1 && cal.value.buffer.gamma === 1, 'nhịp định kỳ tính hiệu chỉnh theo lịch sử (chưa có dữ liệu: hệ số đi 1, γ = 1)');
  });

  await group('Hệ số điều kiện: đường đã tính kẹt xe không nhân thêm giờ cao điểm tự động; thời tiết và giao thông chỉnh tay vẫn nhân', async () => {
    const { h, a, b } = await world(kind);
    h.clock.set(atTime('2026-10-05', '17:00', OFF));
    await h.call('log1', 'PUT', '/api/conditions', { weather: 'rain' });
    const c = (await h.call('log1', 'GET', '/api/conditions')).body;
    ok(c.traffic === 'peak' && c.factor === 1.5 && c.weatherF === 1.2 && c.trafficF === 1.25, 'mưa + giờ cao điểm tự động: hệ số chung 1,5 (1,2 × 1,25), kèm từng hệ số riêng');
    const tA = (await mkTask(h, { start_time: '17:30', stops: [{ site_id: a.id }, { site_id: b.id }] })).body.task;
    eq(tA.factor, 1.5, 'mới tạo, chưa có đường: hệ số chung như cũ');
    await h.idle();
    const A1 = h.store.tasks.get(tA.id);
    ok(A1.route_traffic === 1 && A1.factor === 1.2 && A1.due_at === A1.start_at + Math.round(A1.base_min * 1.2) * MIN, 'có đường đã tính kẹt xe → chỉ nhân thời tiết (×1,2), không nhân thêm giờ cao điểm');
    h.route.traffic = false; h.route.provider = 'osrm'; h.route.mode = 'driving';
    const tB = (await mkTask(h, { start_time: '17:30', stops: [{ site_id: b.id }, { site_id: a.id }] })).body.task;
    await h.idle();
    h.route.traffic = true; h.route.provider = 'google'; h.route.mode = 'TWO_WHEELER';
    const B1 = h.store.tasks.get(tB.id);
    ok(B1.route_src === 'osrm' && B1.route_traffic === 0 && B1.factor === 1.5 && B1.route_mode === 'driving', 'đường không tính kẹt xe (OSRM) → vẫn nhân hệ số chung 1,5');
    await h.call('log1', 'PUT', '/api/conditions', { trafficMode: 'manual', traffic: 'jam' });
    eq([h.store.tasks.get(tA.id).factor, h.store.tasks.get(tB.id).factor], [1.8, 1.8], 'Logistic chỉnh tay "kẹt xe nặng" → nhân cho cả task có đường thực tế (1,2 × 1,5)');
    await h.call('log1', 'PUT', '/api/conditions', { trafficMode: 'auto' });
    const A2 = h.store.tasks.get(tA.id);
    eq([A2.factor, h.store.tasks.get(tB.id).factor], [1.2, 1.5], 'về giờ cao điểm tự động: task có đường thực tế lại chỉ nhân thời tiết');
    eq(A2.due_at, A2.start_at + Math.round(A2.base_min * 1.2) * MIN, 'hạn tính lại đúng theo hệ số');
    const n = h.store.events.count({ type: 'sla_adjust', task_id: tA.id });
    h.clock.set(atTime('2026-10-05', '19:31', OFF)); h.core.tick();
    eq([h.store.tasks.get(tA.id).factor, h.store.events.count({ type: 'sla_adjust', task_id: tA.id })], [1.2, n], 'hết giờ cao điểm: task có đường thực tế giữ nguyên hạn, không ghi điều chỉnh');
    eq(h.store.tasks.get(tB.id).factor, 1.2, 'task đường không tính kẹt xe: hết cao điểm về ×1,2');
  });

  await group('Task đang chạy: tính lại đường chỉ nới hạn, không rút; bắt đầu khi đường đã cũ thì lấy lại', async () => {
    const { h, a, b } = await world(kind);
    const t = (await mkTask(h, { fo_id: h.byName('fo1').id, stops: [{ site_id: a.id }, { site_id: b.id }] })).body.task;
    await h.idle();
    const n0 = h.route.calls.length;
    eq((await h.call('fo1', 'POST', `/api/tasks/${t.id}/start`)).status, 200, 'FO bắt đầu');
    await h.idle();
    eq(h.route.calls.length, n0, 'đường vừa tính (dưới 10 phút): bắt đầu không gọi lại dịch vụ');
    const s0 = h.store.tasks.get(t.id);
    h.route.slow = 2;
    const r1 = await h.call('log1', 'POST', `/api/tasks/${t.id}/reroute`);
    const s1 = h.store.tasks.get(t.id), w1 = expectPlan([a, b], { slow: 2 });
    ok(r1.status === 200 && r1.body.task.base_min === w1.base_min && s1.base_min > s0.base_min && s1.due_at === s1.start_at + w1.base_min * MIN, `kẹt hơn → SLA tăng ${s0.base_min} → ${s1.base_min} phút, hạn được nới`);
    eq(h.route.calls.at(-1).opts.departAt, h.clock.now(), 'task đang chạy: tính theo giao thông lúc này');
    h.route.slow = 1;
    await h.call('log1', 'POST', `/api/tasks/${t.id}/reroute`);
    const s2 = h.store.tasks.get(t.id);
    ok(s2.base_min === expectPlan([a, b], { slow: 1 }).base_min && s2.base_min < s1.base_min && s2.due_at === s1.due_at && s2.factor === s1.factor, 'đường thông hơn → SLA gốc giảm nhưng hạn của task đang chạy giữ nguyên');
    h.route.slow = 0.5;
    await h.call('log1', 'POST', `/api/tasks/${t.id}/reroute`);
    const s2b = h.store.tasks.get(t.id), nAdj = h.store.events.count({ type: 'sla_adjust', task_id: t.id });
    h.route.slow = 1.2;
    await h.call('log1', 'PUT', '/api/conditions', { weather: 'rain' });
    const s3 = h.store.tasks.get(t.id);
    ok(s3.factor === 1.2 && s2b.start_at + Math.round(s2b.base_min * 1.2) * MIN < s2b.due_at && s3.due_at === s2b.due_at && h.store.events.count({ type: 'sla_adjust', task_id: t.id }) === nAdj, 'mưa → hệ số 1,2 nhưng hạn tính lại sớm hơn hạn đang có: giữ hạn cũ, không ghi điều chỉnh');
    await h.call('log1', 'PUT', '/api/conditions', { weather: 'storm' });
    const s4 = h.store.tasks.get(t.id);
    ok(s4.factor === 1.6 && s4.due_at === s4.start_at + Math.round(s2b.base_min * 1.6) * MIN && s4.due_at > s3.due_at, 'giông bão → hạn được nới theo hệ số 1,6');
    await h.call('log1', 'PUT', '/api/conditions', { weather: 'clear' });
    const s5 = h.store.tasks.get(t.id);
    ok(s5.factor === 1.6 && s5.due_at === s4.due_at, 'tạnh mưa → task đang chạy giữ hệ số và hạn');
    const t2 = (await h.call('log1', 'POST', '/api/tasks', { fo_id: h.byName('fo2').id, stops: [{ site_id: b.id }, { site_id: a.id }] })).body.task;
    await h.idle();
    const n1 = h.route.calls.length;
    h.clock.add(11 * MIN);
    await h.call('fo2', 'POST', `/api/tasks/${t2.id}/start`);
    await h.idle();
    ok(h.route.calls.length === n1 + 1 && h.route.calls[n1].opts.departAt === h.clock.now() && h.store.tasks.get(t2.id).route_at === h.clock.now(), 'bắt đầu khi đường đã cũ hơn 10 phút → lấy lại đường theo giao thông lúc xuất phát');
  });

  await group('Làm mới đường: gần giờ đi (≤ 45 phút) mà đường đã quá 1 giờ, đổi giờ bắt đầu; lỗi thì không thử lại liên tục', async () => {
    const { h, a, b } = await world(kind);
    const t = (await mkTask(h, { start_time: '14:00', stops: [{ site_id: a.id }, { site_id: b.id }] })).body.task;
    await h.idle();
    const n0 = h.route.calls.length;
    h.clock.set(atTime('2026-10-05', '12:00', OFF)); h.core.tick(); await h.idle();
    eq(h.route.calls.length, n0, 'còn 2 giờ mới tới giờ đi: chưa làm mới');
    h.clock.set(atTime('2026-10-05', '13:20', OFF)); h.core.tick(); await h.idle();
    ok(h.route.calls.length === n0 + 1 && h.route.calls.at(-1).opts.departAt === t.start_at && h.store.tasks.get(t.id).route_at === h.clock.now(), 'còn 40 phút, đường đã cũ hơn 3 giờ → lấy lại theo giờ đi 14:00');
    h.clock.add(5 * MIN); h.core.tick(); h.core.tick(); await h.idle();
    eq(h.route.calls.length, n0 + 1, 'đường vừa làm mới: không gọi lại');
    await h.call('log1', 'PATCH', `/api/tasks/${t.id}`, { start_time: '15:00' });
    await h.idle();
    const cur = h.store.tasks.get(t.id);
    ok(h.route.calls.length === n0 + 2 && h.route.calls.at(-1).opts.departAt === atTime('2026-10-05', '15:00', OFF) && cur.route_src === 'google' && cur.due_at === cur.start_at + cur.base_min * MIN, 'đổi giờ bắt đầu → lấy lại đường theo giờ đi mới, hạn theo giờ mới');
    h.route.fail = new Error('Mất mạng');
    const t2 = (await mkTask(h, { start_time: '14:30', stops: [{ site_id: b.id }, { site_id: a.id }] })).body.task;
    await h.idle();
    const n1 = h.route.calls.length;
    h.clock.add(20 * MIN); h.core.tick(); h.core.tick(); await h.idle();
    ok(h.route.calls.length === n1 && h.store.tasks.get(t2.id).route_err === 'Mất mạng', 'lần thử vừa lỗi chưa quá 1 giờ: nhịp định kỳ không gọi lại liên tục');
    h.route.fail = null;
  });

  await group('Ops Hub bỏ điểm khỏi chuyến chưa chạy: SLA về ước tính ngay, rồi tính lại đường cho các điểm còn lại', async () => {
    const { h, vp, a, b } = await world(kind);
    const t = (await mkTask(h, { stops: [{ site_id: vp.id }, { site_id: a.id }, { site_id: b.id }] })).body.task;
    await h.idle();
    h.core.tasks.dropStops(t.id, [t.stops[1].id], 'không còn việc tại điểm này');
    let cur = h.store.tasks.get(t.id);
    ok(cur.route_src === null && cur.base_min === estOf([vp, b], 2).base_min && cur.travel_min === null && cur.p50_min === null && cur.route_mode === null, 'bỏ điểm: đường cũ hết đúng, SLA về ước tính ngay');
    await h.idle();
    cur = h.store.tasks.get(t.id);
    const want = expectPlan([vp, b]);
    ok(cur.route_src === 'google' && cur.base_min === want.base_min && cur.plan_km === want.plan_km && cur.service_min === 14 && h.route.calls.at(-1).points.length === 2, 'tính lại đường cho 2 điểm còn lại (dừng: văn phòng 6 + BO B 8)');
  });

  await group('Điểm đổi hoặc task đóng trong lúc chờ dịch vụ: bỏ kết quả cũ, tính lại theo điểm mới; tối đa 2 lượt cùng lúc', async () => {
    const { h, vp, a, b } = await world(kind);
    h.route.hold = true;
    const t = (await mkTask(h, { stops: [{ site_id: vp.id }, { site_id: a.id }, { site_id: b.id }] })).body.task;
    await flush();
    eq(h.route.held.length, 1, 'đang chờ dịch vụ trả lời');
    eq((await h.call('log1', 'PATCH', `/api/tasks/${t.id}`, { stops: [{ site_id: vp.id }, { site_id: b.id }] })).status, 200, 'sửa điểm không phải chờ dịch vụ');
    await flush();
    eq(h.route.calls.length, 1, 'mỗi task một lượt đang tính; lượt mới chờ lượt cũ xong');
    h.route.held.shift()(); // trả kết quả của danh sách điểm cũ; lượt mới bắt đầu và cũng đang chờ
    await flush();
    eq(h.route.calls.length, 2, 'tính lại theo danh sách điểm mới');
    eq(h.route.calls[1].points, pts(vp, b), 'lượt sau gửi đúng điểm mới');
    ok(h.store.routes.count({ task_id: t.id }) === 0 && h.store.tasks.get(t.id).route_src === null && h.store.tasks.get(t.id).base_min === estOf([vp, b], 2).base_min, 'kết quả của danh sách điểm cũ bị bỏ: không lưu đường, SLA vẫn ước tính theo điểm mới');
    h.route.hold = false; h.route.held.shift()();
    await h.idle();
    const cur = h.store.tasks.get(t.id), want = expectPlan([vp, b]), v = (await h.call('log1', 'GET', `/api/tasks/${t.id}/route`)).body;
    ok(cur.plan_km === want.plan_km && cur.base_min === want.base_min && v.stale === false && v.route.legs.length === 1, 'kết quả của danh sách điểm cũ bị bỏ; SLA và đường theo điểm mới');
    eq(h.store.events.count({ type: 'route_ready', task_id: t.id }), 1, 'chỉ ghi 1 lần "đã có đường"');
    h.route.hold = true;
    const t2 = (await mkTask(h, { stops: [{ site_id: a.id }, { site_id: b.id }] })).body.task;
    await flush();
    await h.call('log1', 'POST', `/api/tasks/${t2.id}/cancel`, { reason: 'Không cần nữa' });
    h.route.hold = false; h.route.held.shift()();
    await h.idle();
    ok(h.store.routes.count({ task_id: t2.id }) === 0 && h.store.tasks.get(t2.id).route_src === null, 'task huỷ trong lúc chờ: bỏ kết quả');
    h.route.hold = true;
    for (let i = 0; i < 3; i++) await mkTask(h, { stops: [{ site_id: a.id }, { site_id: b.id }] });
    await flush();
    eq(h.route.held.length, 2, 'tối đa 2 lượt gọi dịch vụ cùng lúc');
    h.route.hold = false;
    while (h.route.held.length) h.route.held.shift()();
    await h.idle();
    eq(h.store.routes.count({}), 4, 'xong hết hàng đợi (lượt thứ 3 chạy khi có chỗ)');
  });

  await group('Dịch vụ đường đi lỗi: giữ SLA ước tính, ghi lỗi, cảnh báo tối đa 1 lần mỗi giờ, không chặn thao tác', async () => {
    const { h, a, b } = await world(kind);
    h.route.fail = new Error('Google không trả lời kịp');
    const r = await mkTask(h, { fo_id: h.byName('fo1').id, stops: [{ site_id: a.id }, { site_id: b.id }] });
    eq(r.status, 200, 'tạo task vẫn thành công khi dịch vụ lỗi');
    const t = r.body.task, est = estOf([a, b], 2);
    await h.idle();
    let cur = h.store.tasks.get(t.id);
    ok(cur.route_err === 'Google không trả lời kịp' && cur.route_src === null && cur.base_min === est.base_min && cur.travel_min === null && cur.p50_min === null && cur.sla_q === null, 'giữ SLA ước tính, ghi lỗi để điều phối thấy');
    const fails = () => h.store.events.find({ type: 'route_fail' });
    ok(fails().length === 1 && fails()[0].level === 'warn' && fails()[0].text.includes('Google không trả lời kịp'), 'cảnh báo cho điều phối');
    ok((await h.call('log1', 'GET', '/api/alerts')).body.alerts.some((e) => e.type === 'route_fail'), 'cảnh báo nằm trong danh sách cảnh báo');
    let rr = await h.call('log1', 'POST', `/api/tasks/${t.id}/reroute`);
    ok(rr.status === 200 && rr.body.task.route_err === 'Google không trả lời kịp' && fails().length === 1, 'bấm tính lại vẫn lỗi: trả task kèm lỗi, không báo trùng trong 1 giờ');
    h.clock.add(61 * MIN);
    await h.call('log1', 'POST', `/api/tasks/${t.id}/reroute`);
    eq(fails().length, 2, 'quá 1 giờ vẫn lỗi → báo lại');
    h.route.fail = null;
    rr = await h.call('log1', 'POST', `/api/tasks/${t.id}/reroute`);
    ok(rr.body.task.route_src === 'google' && rr.body.task.route_err === null, 'dịch vụ chạy lại → có đường thực tế, xoá lỗi');
    h.route.fail = new Error('Vượt hạn mức gọi Google');
    h.clock.add(11 * MIN);
    await h.call('fo1', 'POST', `/api/tasks/${t.id}/start`);
    await h.idle();
    cur = h.store.tasks.get(t.id);
    ok(h.route.calls.length === 5 && cur.route_src === 'google' && cur.route_err === null && fails().length === 2, 'làm mới lúc bắt đầu bị lỗi: giữ đường đang dùng, không báo');
    rr = await h.call('log1', 'POST', `/api/tasks/${t.id}/reroute`);
    ok(rr.body.task.route_err === 'Vượt hạn mức gọi Google' && rr.body.task.route_src === 'google' && fails().length === 2, 'Logistic bấm tính lại bị lỗi: thấy lỗi, vẫn dùng đường cũ');
    h.route.fail = null; h.route.sync = true;
    const t2 = (await mkTask(h, { stops: [{ site_id: a.id }, { site_id: b.id }] })).body.task;
    await h.idle();
    h.route.sync = false; h.route.bad = true;
    const t3 = (await mkTask(h, { stops: [{ site_id: b.id }, { site_id: a.id }] })).body.task;
    await h.idle();
    h.route.bad = false;
    ok(h.store.tasks.get(t2.id).route_err === 'Lỗi đồng bộ' && h.store.tasks.get(t3.id).route_err.includes('không hợp lệ') && h.store.tasks.get(t3.id).route_src === null, 'dịch vụ ném lỗi ngay hoặc trả dữ liệu hỏng: ghi lỗi, không sập');
    // Logistic bấm tính lại đúng lúc task đang được làm mới tự động: lượt của họ không bị gộp thành lượt tự động, lỗi vẫn hiện
    const t4 = (await mkTask(h, { start_time: '15:00', stops: [{ site_id: a.id }, { site_id: b.id }] })).body.task;
    await h.idle();
    h.route.hold = true;
    await h.call('log1', 'PATCH', `/api/tasks/${t4.id}`, { start_time: '16:00' });
    await flush();
    const pending = h.call('log1', 'POST', `/api/tasks/${t4.id}/reroute`);
    await flush();
    await h.call('log1', 'PATCH', `/api/tasks/${t4.id}`, { start_time: '16:30' });
    h.route.fail = new Error('Google không trả lời kịp');
    h.route.held.shift()();
    await flush();
    h.route.hold = false; h.route.held.shift()();
    const r4 = await pending;
    h.route.fail = null;
    ok(r4.status === 200 && r4.body.task.route_err === 'Google không trả lời kịp' && r4.body.task.route_src === 'google', 'bấm tính lại khi đang làm mới tự động: vẫn thấy lỗi của lượt mình bấm');
  });

  await group('Xem trước SLA (/api/plan): có dịch vụ thì kèm đường thực tế; số ước tính và gợi ý thứ tự giữ như cũ', async () => {
    const { h, vp, a, b } = await world(kind);
    const body = { stops: [{ site_id: vp.id }, { site_id: a.id }], round_trip: true, date: '2026-10-05', start_time: '17:00' };
    const p = (await h.call('log1', 'POST', '/api/plan', body)).body, est = estOf([vp, a, vp], 2), want = expectPlan([vp, a, vp], { rt: true, depart: atTime('2026-10-05', '17:00', OFF) });
    ok(p.src === 'google' && p.traffic === true && p.route && p.route.legs.length === 2 && typeof p.route.legs[0].polyline === 'string' && p.route_err === null && p.route.mode === 'TWO_WHEELER', 'kèm đường thực tế (2 chặng, có hình đường, phương tiện)');
    eq(p.est, est, 'est: số ước tính đường chim bay như trước');
    eq([p.plan_km, p.base_min, p.travel_min, p.service_min, p.buffer_min, p.traffic_min, p.factor, p.sla_min, p.p50_min, p.unc_min, p.sla_q], [want.plan_km, want.base_min, want.travel_min, 14, want.buffer_min, want.traffic_min, 1, want.base_min, want.p50_min, want.unc_min, 85], 'SLA xem trước theo đường thực tế (mô hình v2: dừng văn phòng 6 + BO 8)');
    eq(h.route.calls.at(-1).opts.departAt, atTime('2026-10-05', '17:00', OFF), 'giờ xuất phát theo ngày + giờ bắt đầu đang soạn');
    const W0 = await world(kind, { noRoute: true });
    const ob = (w) => ({ stops: [{ site_id: w.vp.id }, { site_id: w.b.id }, { site_id: w.a.id }], optimize: true });
    const o1 = (await h.call('log1', 'POST', '/api/plan', ob({ vp, a, b }))).body, o0 = (await W0.h.call('log1', 'POST', '/api/plan', ob(W0))).body;
    eq([o1.order, o1.best_km, o1.best_min], [o0.order, o0.best_km, o0.best_min], 'gợi ý thứ tự ghé (order, best_km, best_min) giống hệt bản không có dịch vụ');
    eq(Object.keys(o0), ['plan_km', 'base_min', 'factor', 'sla_min', 'order', 'best_km', 'best_min'], 'không có dịch vụ: đúng các trường như trước');
    eq((await W0.h.call('log1', 'POST', '/api/plan', { ...body, stops: [{ site_id: W0.vp.id }, { site_id: W0.a.id }] })).body, { ...est, factor: 1, sla_min: est.base_min }, 'không có dịch vụ: số như cũ, không thêm trường');
    h.route.fail = new Error('Không gọi được dịch vụ');
    const pf = (await h.call('log1', 'POST', '/api/plan', body)).body;
    h.route.fail = null;
    ok(pf.src === 'estimate' && pf.route === null && pf.route_err === 'Không gọi được dịch vụ' && pf.base_min === est.base_min && pf.sla_min === est.base_min && pf.p50_min === null && pf.unc_min === null && pf.sla_q === null, 'dịch vụ lỗi → số ước tính, kèm lỗi');
    const n = h.route.calls.length, p1 = (await h.call('log1', 'POST', '/api/plan', { stops: [{ site_id: a.id }] })).body;
    ok(p1.src === 'estimate' && p1.route === null && h.route.calls.length === n, 'một điểm: không có chặng, không gọi dịch vụ');
    eq((await h.call('log1', 'POST', '/api/plan', { stops: [] })).body.error, 'no_stops', 'không có điểm → 400 như cũ');
    eq((await h.call('sale1', 'POST', '/api/plan', body)).status, 403, 'Sale không dùng được');
  });

  await group('Xem đường đi của task: Logistics xem mọi task, FO chỉ task của mình, Sale / Tech bị chặn', async () => {
    const { h, a, b } = await world(kind);
    const t = (await mkTask(h, { fo_id: h.byName('fo1').id, stops: [{ site_id: a.id }, { site_id: b.id }] })).body.task;
    await h.idle();
    const st = async (who) => (await h.call(who, 'GET', `/api/tasks/${t.id}/route`)).status;
    eq([await st('lead1'), await st('log1'), await st('ad'), await st('fo1')], [200, 200, 200, 200], 'Logistic Lead, Logistic, Quản trị, FO của task xem được');
    eq([await st('fo2'), await st('sale1'), await st('tech1'), await st(null)], [404, 403, 403, 401], 'FO khác: không thấy task (404); Sale, Tech: bị chặn; chưa đăng nhập: 401');
    const v = (await h.call('fo1', 'GET', `/api/tasks/${t.id}/route`)).body;
    ok(v.stale === false && v.route.provider === 'google' && v.route.traffic === true && v.route.legs.length === 1 && v.route.legs[0].polyline === encodePolyline(legPath(a, b)) && v.route.legs[0].jams.length === 1, 'trả hình đường từng chặng và đoạn kẹt xe');
    eq(Object.keys(v.route), ['provider', 'mode', 'traffic', 'at', 'depart_at', 'distance_m', 'duration_s', 'static_s', 'legs', 'warnings'], 'đúng các trường đã thống nhất');
    h.route.fail = new Error('Mất mạng');
    await h.call('log1', 'PATCH', `/api/tasks/${t.id}`, { stops: [{ site_id: b.id }, { site_id: a.id }] });
    await h.idle();
    h.route.fail = null;
    const v2 = (await h.call('log1', 'GET', `/api/tasks/${t.id}/route`)).body, cur = h.store.tasks.get(t.id);
    ok(v2.stale === true && v2.route !== null && cur.route_src === null && cur.base_min === estOf([b, a], 2).base_min && cur.route_err === 'Mất mạng', 'đổi điểm mà chưa tính được đường mới: đường cũ bị đánh dấu cũ, SLA về ước tính');
    ok(cur.route_mode === null && cur.p50_min === null && cur.unc_min === null && cur.sla_q === null && cur.buffer_min === null, 'các số của SLA theo đường và phương tiện cũng về trống');
    eq((await h.call('log1', 'GET', '/api/tasks/99999/route')).status, 404, 'task không tồn tại → 404');
    const one = (await mkTask(h, { stops: [{ site_id: a.id }] })).body.task;
    await h.idle();
    eq((await h.call('log1', 'GET', `/api/tasks/${one.id}/route`)).body, { route: null, stale: false }, 'task một điểm: không có đường');
  });

  await group('Tính lại đường (POST /api/tasks/:id/reroute): quyền, task đã đóng, task một điểm', async () => {
    const { h, a, b } = await world(kind);
    const t = (await mkTask(h, { fo_id: h.byName('fo1').id, stops: [{ site_id: a.id }, { site_id: b.id }] })).body.task;
    await h.idle();
    h.clock.add(5 * MIN);
    const r = await h.call('lead1', 'POST', `/api/tasks/${t.id}/reroute`);
    ok(r.status === 200 && r.body.task.id === t.id && r.body.task.route_at === h.clock.now() && Array.isArray(r.body.task.stops), 'Logistic Lead bấm tính lại → chờ xong, trả task đã cập nhật');
    eq([(await h.call('log1', 'POST', `/api/tasks/${t.id}/reroute`)).status, (await h.call('ad', 'POST', `/api/tasks/${t.id}/reroute`)).status], [200, 200], 'Logistic, Quản trị bấm được');
    eq([(await h.call('fo1', 'POST', `/api/tasks/${t.id}/reroute`)).status, (await h.call('sale1', 'POST', `/api/tasks/${t.id}/reroute`)).status, (await h.call('tech1', 'POST', `/api/tasks/${t.id}/reroute`)).status], [403, 403, 403], 'FO, Sale, Tech không bấm được');
    await h.call('log1', 'POST', `/api/tasks/${t.id}/cancel`, { reason: 'x' });
    eq((await h.call('log1', 'POST', `/api/tasks/${t.id}/reroute`)).status, 409, 'task đã kết thúc → 409');
    const one = (await mkTask(h, { stops: [{ site_id: a.id }] })).body.task;
    eq((await h.call('log1', 'POST', `/api/tasks/${one.id}/reroute`)).body.error, 'one_stop', 'task một điểm → báo không có chặng nào');
  });

  await group('Link BO: chỉ khi BO là điểm kế tiếp mới thấy đường FO → BO theo đường thực tế; không lộ điểm khác', async () => {
    const { h, vp, a, b } = await world(kind);
    const fo1 = h.byName('fo1');
    at(h, 'fo1', vp.lat, vp.lon);
    const t = (await mkTask(h, { fo_id: fo1.id, stops: [{ site_id: vp.id }, { site_id: a.id }, { site_id: b.id }] })).body.task;
    await h.idle();
    const [s1, s2, s3] = t.stops;
    await h.call('fo1', 'POST', `/api/tasks/${t.id}/start`);
    eq((await h.call('fo1', 'POST', `/api/stops/${s1.id}/proof`, { photos: [JPEG], lat: vp.lat, lon: vp.lon })).status, 200, 'FO xong điểm 1 (văn phòng)');
    const tokA = (await h.call('log1', 'POST', `/api/stops/${s2.id}/bo-link`)).body.token, tokB = (await h.call('log1', 'POST', `/api/stops/${s3.id}/bo-link`)).body.token;
    const phoneA = boDevice(h, '10.0.0.21'), phoneB = boDevice(h, '10.0.0.22');
    const legs = (await h.call('log1', 'GET', `/api/tasks/${t.id}/route`)).body.route.legs;
    const pos1 = mid(legPath(vp, a));
    h.clock.add(3 * MIN); at(h, 'fo1', pos1.lat, pos1.lon);
    const vA = (await phoneA.call('POST', '/api/bo-link/view', { token: tokA })).body;
    const pr = projectOnPath(decodePolyline(legs[0].polyline), pos1.lat, pos1.lon), left = pr.totalM - pr.distAlongM;
    ok(vA.state === 'coming' && vA.before === 0 && vA.eta_src === 'route' && typeof vA.path === 'string', 'BO A là điểm kế tiếp: có phần đường còn lại FO → BO');
    eq([vA.dist_km, vA.eta_min], [+(left / 1000).toFixed(1), Math.max(1, Math.ceil(((left / pr.totalM) * legs[0].duration_s) / 60))], 'km và phút theo phần đường còn lại của chặng');
    eq(vA.route_warn, BETA, 'đường xe máy của Google: kèm cảnh báo đang thử nghiệm (đường không có câu riêng → câu chuẩn)');
    const ptsA = decodePolyline(vA.path);
    ok(distM(ptsA[0][0], ptsA[0][1], pos1.lat, pos1.lon) < 5 && distM(ptsA.at(-1)[0], ptsA.at(-1)[1], a.lat, a.lon) < 5, 'đường bắt đầu ở vị trí FO, kết thúc ở BO A');
    ok(ptsA.every(([la, lo]) => distM(la, lo, vp.lat, vp.lon) > 300 && distM(la, lo, b.lat, b.lon) > 300), 'đường không đi qua toạ độ điểm khác của chuyến (văn phòng, BO B)');
    const vB = (await phoneB.call('POST', '/api/bo-link/view', { token: tokB })).body;
    ok(vB.state === 'coming' && vB.before === 1 && vB.path === undefined && vB.eta_src === undefined && vB.route_warn === undefined && vB.dist_km > 0, 'BO B còn 1 điểm phía trước: không có đường, chỉ số ước tính như cũ');
    const nums = (o) => JSON.stringify(o).match(/-?\d+\.\d+/g) || [];
    ok(![vp.lat, vp.lon, a.lat, a.lon].some((x) => nums(vB).includes(String(x))), 'phản hồi cho BO B không chứa toạ độ văn phòng / BO A');
    const off = { lat: +(pos1.lat + 0.01).toFixed(6), lon: pos1.lon };
    h.clock.add(2 * MIN); at(h, 'fo1', off.lat, off.lon);
    const vOff = (await phoneA.call('POST', '/api/bo-link/view', { token: tokA })).body;
    ok(vOff.path === undefined && vOff.eta_src === undefined && vOff.route_warn === undefined && vOff.dist_km === +((distM(off.lat, off.lon, a.lat, a.lon) / 1000) * 1.35).toFixed(1), 'FO lệch đường hơn 300 m: không vẽ đường, km theo đường chim bay như cũ');
    const pos2 = mid(legPath(a, b));
    h.clock.add(3 * MIN); at(h, 'fo1', pos2.lat, pos2.lon);
    const vB1 = (await phoneB.call('POST', '/api/bo-link/view', { token: tokB })).body;
    ok(vB1.before === 1 && vB1.path === undefined && vB1.eta_src === undefined, 'FO đi ngang chặng BO A → BO B khi chưa ghé BO A: BO B chưa phải điểm kế tiếp, không thấy đường');
    h.clock.add(3 * MIN); at(h, 'fo1', a.lat, a.lon);
    eq(h.store.stops.get(s2.id).status, 'arrived', 'FO tới BO A (tự ghi đã đến)');
    await h.call('fo1', 'POST', `/api/stops/${s2.id}/proof`, { photos: [JPEG], lat: a.lat, lon: a.lon });
    eq((await phoneA.call('POST', '/api/bo-link/confirm', { token: tokA, photos: [JPEG], cards_recv: 0, cards_given: 0, dev_recv: 0, dev_given: 0 })).body.state, 'done', 'BO A xác nhận');
    h.clock.add(3 * MIN); at(h, 'fo1', pos2.lat, pos2.lon);
    const vB2 = (await phoneB.call('POST', '/api/bo-link/view', { token: tokB })).body, ptsB = vB2.path ? decodePolyline(vB2.path) : [];
    ok(vB2.before === 0 && vB2.eta_src === 'route' && vB2.route_warn === BETA && ptsB.length >= 2 && distM(ptsB.at(-1)[0], ptsB.at(-1)[1], b.lat, b.lon) < 5, 'BO B thành điểm kế tiếp: có đường FO → BO B (kèm cảnh báo)');
    ok(ptsB.every(([la, lo]) => distM(la, lo, a.lat, a.lon) > 300 && distM(la, lo, vp.lat, vp.lon) > 300) && ![vp.lat, vp.lon, a.lat, a.lon].some((x) => nums(vB2).includes(String(x))), 'chỉ phần đường từ vị trí FO tới BO B: không kèm đoạn từ BO A, không lộ toạ độ điểm khác');
    h.clock.add(3 * MIN); at(h, 'fo1', b.lat, b.lon);
    const vB3 = (await phoneB.call('POST', '/api/bo-link/view', { token: tokB })).body;
    ok(vB3.state === 'arrived' && vB3.path === undefined && vB3.route_warn === undefined, 'FO đã tới BO B: không còn đường cần vẽ');
    // BO là điểm đầu của chuyến: không có chặng nào tới BO (FO đi từ đâu thì không gửi cho dịch vụ) → số đường chim bay như cũ
    at(h, 'fo2', pos2.lat, pos2.lon);
    const t2 = (await mkTask(h, { fo_id: h.byName('fo2').id, stops: [{ site_id: a.id }, { site_id: b.id }] })).body.task;
    await h.idle();
    await h.call('fo2', 'POST', `/api/tasks/${t2.id}/start`);
    const tok2 = (await h.call('log1', 'POST', `/api/stops/${t2.stops[0].id}/bo-link`)).body.token;
    const v2 = await boDevice(h, '10.0.0.23').call('POST', '/api/bo-link/view', { token: tok2 });
    ok(v2.status === 200 && v2.body.state === 'coming' && v2.body.before === 0 && v2.body.path === undefined && v2.body.dist_km > 0, 'BO là điểm đầu: không có đường để vẽ, giữ số ước tính');
  });

  await group('Phương tiện của đường (route_mode) và cảnh báo đường xe máy đang thử nghiệm trên link BO (route_warn)', async () => {
    const { h, vp, a } = await world(kind);
    let ip = 40;
    /** FO xong văn phòng rồi đang đi giữa chặng tới BO A; BO A mở link. Xong thì huỷ chuyến để FO nhận chuyến sau. */
    const run = async (o) => {
      Object.assign(h.route, o);
      h.clock.add(2 * MIN); at(h, 'fo1', vp.lat, vp.lon);
      const t = (await mkTask(h, { fo_id: h.byName('fo1').id, stops: [{ site_id: vp.id }, { site_id: a.id }] })).body.task;
      await h.idle();
      await h.call('fo1', 'POST', `/api/tasks/${t.id}/start`);
      await h.call('fo1', 'POST', `/api/stops/${t.stops[0].id}/proof`, { photos: [JPEG], lat: vp.lat, lon: vp.lon });
      const tok = (await h.call('log1', 'POST', `/api/stops/${t.stops[1].id}/bo-link`)).body.token, p = mid(legPath(vp, a));
      h.clock.add(2 * MIN); at(h, 'fo1', p.lat, p.lon);
      const v = (await boDevice(h, `10.0.0.${ip++}`).call('POST', '/api/bo-link/view', { token: tok })).body, task = h.store.tasks.get(t.id);
      await h.call('log1', 'POST', `/api/tasks/${t.id}/cancel`, { reason: 'Kiểm thử xong' });
      return { v, task };
    };
    let r = await run({});
    ok(r.task.route_src === 'google' && r.task.route_mode === 'TWO_WHEELER' && r.v.eta_src === 'route' && r.v.route_warn === BETA, 'Google xe máy: task lưu route_mode TWO_WHEELER; BO thấy đường kèm câu cảnh báo chuẩn');
    const gw = 'Tuyến xe hai bánh của Google đang ở giai đoạn thử nghiệm (beta).';
    r = await run({ warnings: ['Tuyến có đoạn thu phí.', gw, BETA] });
    eq(r.v.route_warn, gw, 'đường có sẵn câu cảnh báo thử nghiệm của Google → dùng đúng câu đó');
    r = await run({ mode: 'DRIVE', warnings: ['Google chưa hỗ trợ đường xe máy cho các điểm này nên đã tính theo đường ô tô.'] });
    ok(r.task.route_mode === 'DRIVE' && typeof r.v.path === 'string' && r.v.route_warn === undefined, 'Google tính theo đường ô tô (DRIVE): có đường nhưng không kèm cảnh báo xe máy');
    r = await run({ provider: 'osrm', mode: 'driving', traffic: false, warnings: [] });
    ok(r.task.route_src === 'osrm' && r.task.route_mode === 'driving' && typeof r.v.path === 'string' && r.v.route_warn === undefined, 'OSRM: route_mode driving, không kèm cảnh báo');
    Object.assign(h.route, { provider: 'google', mode: 'TWO_WHEELER', traffic: true, warnings: [] });
  });

  await group('Dự kiến xong khi đang chạy: tính tại chỗ theo đường đã lưu (không gọi dịch vụ), báo trước khi dự kiến trễ', async () => {
    const { h, vp, a, b } = await world(kind);
    at(h, 'fo1', vp.lat, vp.lon);
    const t = (await mkTask(h, { fo_id: h.byName('fo1').id, stops: [{ site_id: vp.id }, { site_id: a.id }, { site_id: b.id }] })).body.task;
    await h.idle();
    await h.call('fo1', 'POST', `/api/tasks/${t.id}/start`);
    await h.call('fo1', 'POST', `/api/stops/${t.stops[0].id}/proof`, { photos: [JPEG], lat: vp.lat, lon: vp.lon });
    const legs = (await h.call('log1', 'GET', `/api/tasks/${t.id}/route`)).body.route.legs, n0 = h.route.calls.length;
    const pos = mid(legPath(vp, a)), pr = projectOnPath(decodePolyline(legs[0].polyline), pos.lat, pos.lon);
    const expectEta = (now) => now + (1 - pr.distAlongM / pr.totalM) * legs[0].duration_s * 1000 + 8 * MIN + legs[1].duration_s * 1000 + 8 * MIN;
    h.clock.add(2 * MIN); at(h, 'fo1', pos.lat, pos.lon); h.core.tick();
    const e1 = h.store.tasks.get(t.id).eta_at;
    ok(Math.abs(e1 - expectEta(h.clock.now())) < 1000, 'dự kiến xong = phần còn lại của chặng đang đi + chặng sau + dừng 2 điểm còn lại (P50: BO 8 phút)');
    eq(h.route.calls.length, n0, 'nhịp định kỳ không gọi dịch vụ đường đi');
    h.clock.add(30000); at(h, 'fo1', pos.lat, pos.lon); h.core.tick();
    eq(h.store.tasks.get(t.id).eta_at, e1, 'dự kiến lệch dưới 2 phút: không ghi lại');
    h.clock.add(3 * MIN); at(h, 'fo1', pos.lat, pos.lon); h.core.tick();
    ok(Math.abs(h.store.tasks.get(t.id).eta_at - expectEta(h.clock.now())) < 1000, 'lệch từ 2 phút: cập nhật');
    let cur = h.store.tasks.get(t.id);
    h.clock.set(cur.due_at - expectEta(0) + 3 * MIN); at(h, 'fo1', pos.lat, pos.lon); h.core.tick();
    eq(h.store.events.count({ type: 'sla_predict' }), 0, 'dự kiến trễ chưa quá 5 phút: chưa báo');
    h.clock.set(cur.due_at - 10 * MIN); at(h, 'fo1', pos.lat, pos.lon); h.core.tick(); h.core.tick();
    const pred = h.store.events.find({ type: 'sla_predict' }), late = Math.round((expectEta(h.clock.now()) - cur.due_at) / MIN);
    ok(late > 5 && pred.length === 1 && pred[0].level === 'warn' && pred[0].text.includes(`dự kiến trễ ~${late} phút`) && h.store.tasks.get(t.id).al_predict === 1, `FO đứng yên gần tới hạn → báo trước dự kiến trễ ~${late} phút, đúng 1 lần`);
    await h.call('log1', 'PUT', '/api/conditions', { weather: 'storm' });
    cur = h.store.tasks.get(t.id);
    ok(cur.factor === 1.6 && cur.al_predict === 0, 'giông bão nới hạn → bỏ cờ dự kiến trễ');
    h.core.tick();
    eq(h.store.events.count({ type: 'sla_predict' }), 1, 'kịp hạn mới → không báo thêm');
    h.clock.add(MIN); at(h, 'fo1', a.lat, a.lon);
    h.clock.add(2 * MIN); at(h, 'fo1', a.lat, a.lon); h.core.tick();
    ok(h.store.stops.get(t.stops[1].id).status === 'arrived' && Math.abs(h.store.tasks.get(t.id).eta_at - (h.clock.now() + 6 * MIN + legs[1].duration_s * 1000 + 8 * MIN)) < 1000, 'đang ở BO A: dự kiến = thời gian dừng còn lại + chặng sau + dừng điểm cuối');
    await h.call('fo1', 'POST', `/api/stops/${t.stops[1].id}/proof`, { photos: [JPEG], lat: a.lat, lon: a.lon });
    h.clock.add(10 * MIN); at(h, 'fo1', a.lat, a.lon); h.core.tick();
    ok(h.store.stops.get(t.stops[1].id).bo_status === 'pending' && Math.abs(h.store.tasks.get(t.id).eta_at - (h.clock.now() + MIN + legs[1].duration_s * 1000 + 8 * MIN)) < 1000, 'đang chờ BO A xác nhận quá P50 dừng: còn chờ ít nhất 1 phút + cả chặng sau + dừng điểm cuối');
  });

  await group('Chuyến Ops Hub, tuyến định kỳ: lấy đường sau khi ghi xong; giao dịch hoàn tác thì không gọi dịch vụ', async () => {
    const { h, vp, a, b } = await world(kind);
    const job = (await h.call('lead1', 'POST', '/api/hub/jobs', { team: 'logistics', title: 'Ghé BO A lấy biên bản', site_id: a.id })).body.job;
    const d = await h.call('lead1', 'POST', '/api/hub/dispatch', { job_ids: [job.id], fo_id: h.byName('fo1').id, office_site_id: vp.id, round_trip: true });
    eq(d.status, 200, 'gom việc Ops Hub thành chuyến FO');
    await h.idle();
    const tk = h.store.tasks.get(d.body.task.id), want = expectPlan([vp, a, vp], { rt: true });
    ok(tk.route_src === 'google' && tk.base_min === want.base_min && tk.plan_km === want.plan_km && tk.service_min === 14, 'chuyến Ops Hub có đường thực tế, SLA theo đường');
    ok(h.route.calls.length === 1 && h.route.calls.every((c) => c.inTx === false), 'gọi dịch vụ 1 lần, sau khi giao dịch tạo chuyến ghi xong');
    const tpl = (await h.call('log1', 'POST', '/api/templates', { name: 'Tuyến chiều', fo_id: h.byName('fo2').id, days: [1, 2, 3, 4, 5, 6, 7], start_time: '15:00', stops: [{ site_id: a.id }, { site_id: b.id }] })).body.template;
    await h.idle();
    const gen = h.store.tasks.find({ template_id: tpl.id })[0];
    ok(gen && gen.route_src === 'google' && gen.base_min === expectPlan([a, b], { depart: atTime('2026-10-05', '15:00', OFF) }).base_min && h.route.calls.at(-1).opts.departAt === atTime('2026-10-05', '15:00', OFF), 'task sinh từ tuyến định kỳ có đường thực tế, tính theo giờ chạy 15:00');
    const n0 = h.route.calls.length, nt = h.store.tasks.count({});
    try { h.store.tx(() => { h.core.tasks.createTask({ stops: [{ site_id: a.id }, { site_id: b.id }] }, h.byName('log1')); throw new Error('hoàn tác'); }); } catch { /* chờ lỗi */ }
    await flush(); await h.idle();
    ok(h.route.calls.length === n0 && h.store.tasks.count({}) === nt, 'tạo chuyến trong giao dịch bị hoàn tác → không có chuyến, không gọi dịch vụ');
  });

  await group('Dọn đường đi đã lưu của task đã kết thúc sau routeRetentionDays ngày', async () => {
    const { h, a, b } = await world(kind);
    const t1 = (await mkTask(h, { stops: [{ site_id: a.id }, { site_id: b.id }] })).body.task;
    const t2 = (await mkTask(h, { stops: [{ site_id: b.id }, { site_id: a.id }] })).body.task;
    await h.idle();
    await h.call('log1', 'POST', `/api/tasks/${t1.id}/cancel`, { reason: 'Dời lịch' });
    eq(h.store.routes.count({}), 2, 'mỗi task một dòng đường đi');
    h.clock.add(29 * 86400000);
    eq(h.core.maintenance().routes, 0, 'chưa quá 30 ngày: giữ');
    h.clock.add(2 * 86400000);
    const out = h.core.maintenance();
    ok(out.routes === 1 && h.store.routes.count({ task_id: t1.id }) === 0 && h.store.routes.count({ task_id: t2.id }) === 1, 'quá 30 ngày: xoá đường của task đã kết thúc, giữ task còn mở');
    const W = await world(kind, { cfg: { routeRetentionDays: 0 } });
    const t3 = (await mkTask(W.h, { stops: [{ site_id: W.a.id }, { site_id: W.b.id }] })).body.task;
    await W.h.idle();
    await W.h.call('log1', 'POST', `/api/tasks/${t3.id}/cancel`, { reason: 'x' });
    W.h.clock.add(400 * 86400000);
    ok(W.h.core.maintenance().routes === 0 && W.h.store.routes.count({}) === 1, 'routeRetentionDays = 0: giữ mãi');
  });

  await group('SLA v2: hệ số thời gian đi theo khung giờ lúc rời từng điểm (chặng sau có thể rơi vào giờ cao điểm)', async () => {
    const { h, vp, a, b } = await world(kind, { t: atTime('2026-10-05', '05:00', OFF) });
    calib(h, { travel: { k: 1, n: 99, peak: { k: 1.5, n: 40 }, off: { k: 1, n: 59 } } });
    const t = (await mkTask(h, { start_time: '06:20', stops: [{ site_id: vp.id }, { site_id: a.id }, { site_id: b.id }] })).body.task;
    await h.idle();
    const depart = atTime('2026-10-05', '06:20', OFF), want = expectPlan([vp, a, b], { depart, k: (ts) => (isPeak(ts) ? 1.5 : 1) }), flat = expectPlan([vp, a, b], { depart, k: 1 });
    const dep2 = depart + (want.T[0] + 8) * MIN, cur = h.store.tasks.get(t.id);
    ok(!isPeak(depart) && isPeak(dep2), 'đối chứng: chặng 1 rời văn phòng 06:20 (ngoài giờ), chặng 2 rời BO A sau 06:30 (giờ cao điểm)');
    ok(Math.abs(want.T[1] - (fakeLeg(a, b).duration_s / 60) * 1.5) < 1e-9 && want.travel_min > flat.travel_min, `chặng 2 nhân hệ số giờ cao điểm 1,5: đi ${want.travel_min} phút (cả tuyến theo khung giờ lúc xuất phát: ${flat.travel_min} phút)`);
    eq(slaCols(cur), slaWant(want), 'SLA của task tính theo lịch từng chặng');
    const late = (await mkTask(h, { start_time: '09:30', stops: [{ site_id: vp.id }, { site_id: a.id }, { site_id: b.id }] })).body.task;
    await h.idle();
    eq(h.store.tasks.get(late.id).travel_min, expectPlan([vp, a, b], { depart: atTime('2026-10-05', '09:30', OFF), k: 1 }).travel_min, 'xuất phát 09:30 (đã hết cao điểm sáng): mọi chặng dùng hệ số ngoài giờ');
  });

  await group('SLA v2: điểm BO cần xác nhận, dự phòng tối thiểu, % chuyến kịp hạn nhắm tới (targetPct)', async () => {
    const { h, vp, a, b } = await world(kind);
    const t = (await mkTask(h, { stops: [{ site_id: vp.id }, { site_id: a.id }] })).body.task;
    await h.idle();
    const cur = h.store.tasks.get(t.id), want = expectPlan([vp, a]);
    eq(slaCols(cur), slaWant(want), 'văn phòng 6 / P85 10 + BO cần xác nhận 8 / P85 16 (thêm thời gian chờ BO)');
    ok(cur.service_min === 14 && cur.unc_min === Math.round(Math.sqrt((want.T[0] * (Math.exp(Z85 * Math.sqrt(0.12 ** 2 + 0.3 ** 2)) - 1)) ** 2 + 4 ** 2 + 8 ** 2)), 'một chặng (Leff = 1): U = √(XT² + 4² + 8²)');
    const W = await world(kind, { cfg: { boConfirm: false } });
    const tw = (await mkTask(W.h, { stops: [{ site_id: W.vp.id }, { site_id: W.a.id }] })).body.task;
    await W.h.idle();
    const cw = W.h.store.tasks.get(tw.id), ww = expectPlan([W.vp, W.a], { svc: () => ({ p50: 6, p85: 10 }) });
    ok(cw.service_min === 12 && cw.base_min === ww.base_min && cw.unc_min === ww.unc_min && cw.unc_min < cur.unc_min, 'tắt BO xác nhận (BO_CONFIRM=0): BO dừng như điểm thường 6 / 10');
    // Điểm có lịch sử: đủ 8 lượt mới dùng số riêng; ít hơn thì theo mặc định của chính lượt ghé (BO A từng ghé khi chưa cần xác nhận: số cũ 6 / 10 không dùng)
    const S8 = await world(kind);
    calib(S8.h, { service: { default: { min: 6, min50: null, min85: null, n: 11 }, sites: [{ site_id: S8.a.id, name: 'BO A', min: 6, min50: 6, min85: 10, n: 3 }, { site_id: S8.b.id, name: 'BO B', min: 20, min50: 20, min85: 30, n: 8 }] } });
    const t8 = (await mkTask(S8.h, { stops: [{ site_id: S8.a.id }, { site_id: S8.b.id }] })).body.task;
    await S8.h.idle();
    const c8 = S8.h.store.tasks.get(t8.id), w8 = expectPlan([S8.a, S8.b], { svc: (s) => (s.id === S8.b.id ? { p50: 20, p85: 30 } : SVC(s)) });
    ok(c8.service_min === 28 && c8.unc_min === w8.unc_min && c8.base_min === w8.base_min, 'BO B đủ 8 lượt: 20 / 30 phút của chính điểm; BO A mới 3 lượt: mặc định BO cần xác nhận 8 / 16');
    const F = await world(kind, { cfg: { sla: { bufferFloor: 30 } } });
    const tf = (await mkTask(F.h, { stops: [{ site_id: F.vp.id }, { site_id: F.a.id }] })).body.task;
    await F.h.idle();
    const cf = F.h.store.tasks.get(tf.id), wf = expectPlan([F.vp, F.a], { floor: 30 });
    ok(wf.u + 3 < 30 && cf.buffer_min === 30 && cf.base_min === wf.base_min && cf.unc_min === want.unc_min, `3 + U (${(3 + wf.u).toFixed(1)}) dưới mức tối thiểu: dự phòng = bufferFloor 30 phút`);
    const Q = await world(kind, { cfg: { sla: { targetPct: 90 } } });
    const tq = (await mkTask(Q.h, { round_trip: true, stops: [{ site_id: Q.vp.id }, { site_id: Q.a.id }, { site_id: Q.b.id }] })).body.task;
    const t85 = (await mkTask(h, { round_trip: true, stops: [{ site_id: vp.id }, { site_id: a.id }, { site_id: b.id }] })).body.task;
    await Q.h.idle(); await h.idle();
    const c90 = Q.h.store.tasks.get(tq.id), c85 = h.store.tasks.get(t85.id), w90 = expectPlan([Q.vp, Q.a, Q.b, Q.vp], { rt: true, z: Z90 });
    eq([c90.sla_q, c85.sla_q], [90, 85], 'task ghi % kịp hạn nhắm tới lúc tính (sla_q)');
    ok(c90.buffer_min === w90.buffer_min && c90.unc_min === w90.unc_min && c90.buffer_min > c85.buffer_min && c90.travel_min === c85.travel_min && c90.service_min === c85.service_min, `nhắm 90 % (z = 1,2816): dự phòng ${c90.buffer_min} phút > ${c85.buffer_min} phút khi nhắm 85 %`);
  });

  await group('Hiệu chỉnh SLA từ lịch sử trong kho; SLA theo đường dùng số đã hiệu chỉnh', async () => {
    const { h, a, b } = await world(kind, { cfg: { boConfirm: false }, t: atTime('2026-10-05', '09:10', OFF) });
    const done = [], dA = [], dB = [];
    for (let i = 0; i < 9; i++) {
      const t = (await mkTask(h, { fo_id: h.byName('fo1').id, stops: [{ site_id: a.id }, { site_id: b.id }] })).body.task;
      await h.idle();
      const leg = h.store.routes.find({ task_id: t.id })[0].legs[0], arrive = i < 8; // chuyến thứ 9: FO không ghi "đã đến", xác nhận luôn → không rõ lúc đến, không tính
      const wa = 9 + (i % 3), wb = 14 + (i % 2) * 4;
      if (arrive) { dA.push(wa); dB.push(wb); }
      await h.call('fo1', 'POST', `/api/tasks/${t.id}/start`);
      if (arrive) await h.call('fo1', 'POST', `/api/stops/${t.stops[0].id}/arrive`, { lat: a.lat, lon: a.lon });
      h.clock.add(wa * MIN);
      await h.call('fo1', 'POST', `/api/stops/${t.stops[0].id}/proof`, { photos: [JPEG], lat: a.lat, lon: a.lon });
      h.clock.add(leg.duration_s * 1500); // thực tế chậm gấp 1,5 lần thời gian theo bản đồ
      if (arrive) await h.call('fo1', 'POST', `/api/stops/${t.stops[1].id}/arrive`, { lat: b.lat, lon: b.lon });
      h.clock.add(wb * MIN);
      done.push((await h.call('fo1', 'POST', `/api/stops/${t.stops[1].id}/proof`, { photos: [JPEG], lat: b.lat, lon: b.lon })).body.task.status);
      h.clock.add(2 * MIN);
    }
    eq(done, Array(9).fill('completed'), 'đối chứng: 9 chuyến hoàn thành (chuyến cuối FO xác nhận luôn, không ghi "đã đến")');
    ok(!isPeak(h.clock.now()), 'đối chứng: mọi chặng đi ngoài giờ cao điểm');
    const r = await h.call('lead1', 'GET', '/api/stats/sla', null, { refresh: '1' }), cal = r.body;
    const sa = cal.service.sites.find((x) => x.site_id === a.id), sb = cal.service.sites.find((x) => x.site_id === b.id), q = (xs, p) => Math.round(quantile(xs, p));
    ok(r.status === 200 && cal.v === 2 && cal.enabled === true && cal.routing === true && cal.at === h.clock.now(), 'Logistic Lead xem hiệu chỉnh (vừa tính)');
    eq([sa.n, sa.min50, sa.min85, sa.min, sa.name], [8, q(dA, 0.5), q(dA, 0.85), q(dA, 0.5), 'BO A'], `BO A: 8 lượt → P50 ${q(dA, 0.5)} / P85 ${q(dA, 0.85)} phút của chính điểm này (min = min50)`);
    eq([sb.n, sb.min50, sb.min85, sb.min], [8, q(dB, 0.5), q(dB, 0.85), q(dB, 0.5)], `BO B: P50 ${q(dB, 0.5)} / P85 ${q(dB, 0.85)} phút`);
    eq(cal.service.default, { min: 6, min50: null, min85: null, n: 16 }, 'chưa đủ 20 lượt chung: điểm ít lượt dùng số mặc định');
    const k = +((8 * 1.5 + 20) / 28).toFixed(2);
    eq([cal.travel.n, cal.travel.k, cal.travel.off, cal.travel.peak], [8, k, { k, n: 8 }, { k, n: 0 }], `hệ số thời gian đi: thực tế chậm 1,5 lần, ít mẫu nên co về 1 (${k})`);
    const all = h.store.tasks.find({ status: 'completed' }), hit = all.filter((x) => x.finished_at <= x.due_at).length;
    eq(cal.buffer, { gamma: 1, n: 9, target_pct: 85, coverage: +(hit / 9).toFixed(3), n_cov: 9 }, `dự phòng: chưa đủ 100 chuyến nên γ = 1; ${hit}/9 chuyến xong trước hạn`);
    eq([(await h.call('log1', 'GET', '/api/stats/sla')).status, (await h.call('fo1', 'GET', '/api/stats/sla')).status, (await h.call('sale1', 'GET', '/api/stats/sla')).status, (await h.call('ad', 'GET', '/api/stats/sla')).status], [403, 403, 403, 200], 'chỉ Logistic Lead và Quản trị xem hiệu chỉnh');
    const t6 = (await mkTask(h, { stops: [{ site_id: a.id }, { site_id: b.id }] })).body.task;
    await h.idle();
    const c6 = h.store.tasks.get(t6.id), w6 = expectPlan([a, b], { k, svc: (s) => (s.id === a.id ? { p50: q(dA, 0.5), p85: q(dA, 0.85) } : { p50: q(dB, 0.5), p85: q(dB, 0.85) }) });
    eq(slaCols(c6), slaWant(w6), `task mới: thời gian đi × ${k}, dừng P50 / P85 theo từng điểm`);
    const W = await world(kind, { cfg: { sla: { calibrate: false } } });
    calib(W.h, { travel: { k: 1.5, n: 99, peak: { k: 1.5, n: 50 }, off: { k: 1.5, n: 49 } }, service: { default: { min: 20, min50: 20, min85: 40, n: 99 }, sites: [] }, buffer: { gamma: 3, n: 200, target_pct: 85, coverage: 0.9, n_cov: 200 } });
    const tw = (await mkTask(W.h, { stops: [{ site_id: W.a.id }, { site_id: W.b.id }] })).body.task;
    await W.h.idle();
    ok(W.h.store.tasks.get(tw.id).base_min === expectPlan([W.a, W.b]).base_min && (await W.h.call('lead1', 'GET', '/api/stats/sla')).body.enabled === false, 'tắt hiệu chỉnh (SLA_CALIBRATE=0): SLA theo đường dùng số mặc định');
    const O = await world(kind);
    O.h.store.settings.insert({ id: 'sla_calib', value: { at: O.h.clock.now(), travel: { k: 1.5, n: 99, peak: { k: 1.5, n: 50 }, off: { k: 1.5, n: 49 } }, service: { default: { min: 20, n: 99 }, sites: [] } } });
    const to = (await mkTask(O.h, { stops: [{ site_id: O.a.id }, { site_id: O.b.id }] })).body.task;
    await O.h.idle();
    const so = (await O.h.call('lead1', 'GET', '/api/stats/sla')).body;
    ok(O.h.store.tasks.get(to.id).base_min === expectPlan([O.a, O.b]).base_min && so.v === 2 && so.travel.k === 1 && so.buffer.gamma === 1 && so.service.default.min50 === null, 'còn bản hiệu chỉnh cũ (trước mô hình v2): không dùng, tính lại ngay khi xem');
  });

  await group('Hiệu chỉnh γ của dự phòng từ ≥ 100 chuyến hoàn thành có SLA theo đường; tỉ lệ kịp hạn (coverage)', async () => {
    const { h, a, b } = await world(kind);
    // 120 chuyến: s = (a − 40 − 3) / 10 = 1,5; 1,51; …; 2,69 (thứ tự xáo); nửa số chuyến trời mưa (hệ số 1,2: phút thực tế được chia lại); 90 chuyến xong trước hạn
    const S = Array.from({ length: 120 }, (_, i) => (i * 37) % 120);
    S.forEach((i, j) => past(h.store, { a: 58 + i / 10, factor: j % 2 ? 1.2 : 1, ontime: j < 90 }));
    past(h.store, { a: 999, p50: null, unc: null, ontime: true }); // có đường nhưng SLA kiểu cũ: chỉ tính vào tỉ lệ kịp hạn
    past(h.store, { a: 999, src: null }); // không có đường thực tế: không tính
    past(h.store, { a: 999, status: 'cancelled' }); // huỷ: không tính
    past(h.store, { a: 999, date: '2026-08-20' }); // quá 30 ngày: không tính
    const cal = (await h.call('lead1', 'GET', '/api/stats/sla', null, { refresh: '1' })).body;
    eq(cal.buffer, { gamma: 2.52, n: 120, target_pct: 85, coverage: +(91 / 121).toFixed(3), n_cov: 121 }, 'γ = phần tử thứ ⌈121 × 0,85⌉ = 103 của s đã xếp (2,52); coverage = 91 / 121 chuyến có đường xong trước hạn');
    const t = (await mkTask(h, { stops: [{ site_id: a.id }, { site_id: b.id }] })).body.task;
    await h.idle();
    const cur = h.store.tasks.get(t.id), want = expectPlan([a, b], { gamma: 2.52 }), w1 = expectPlan([a, b]);
    ok(cur.buffer_min === want.buffer_min && cur.base_min === want.base_min && Math.round(3 + 2.52 * want.u) === want.buffer_min && cur.buffer_min > w1.buffer_min, `task mới: dự phòng = 3 + 2,52 × U = ${want.buffer_min} phút (γ = 1: ${w1.buffer_min} phút)`);
    const Q = await world(kind, { cfg: { sla: { targetPct: 90 } } });
    S.forEach((i) => past(Q.h.store, { a: 58 + i / 10, ontime: true }));
    const c90 = (await Q.h.call('lead1', 'GET', '/api/stats/sla', null, { refresh: '1' })).body.buffer;
    eq([c90.gamma, c90.n, c90.target_pct, c90.coverage, c90.n_cov], [2.58, 120, 90, 1, 120], 'nhắm 90 %: γ = phần tử thứ ⌈121 × 0,9⌉ = 109 (2,58)');
    const W = await world(kind);
    for (let i = 0; i < 100; i++) past(W.h.store, { a: 200 + i });
    eq((await W.h.call('lead1', 'GET', '/api/stats/sla', null, { refresh: '1' })).body.buffer.gamma, 3, 'chuyến thực tế rất chậm so với P50: γ kẹp ở 3');
  });

  await group('Cấu hình gửi giao diện: dịch vụ đường đi (routingProvider), nền bản đồ Google chính thức (mapTiles đọc lúc gọi)', async () => {
    const { h, a } = await world(kind, { cfg: { routingProvider: 'google' } });
    const me = async () => (await h.call('log1', 'GET', '/api/me')).body.cfg;
    const c = await me();
    ok(c.routing === true && c.routingProvider === 'google' && c.mapTiles === null, 'có dịch vụ Google: routingProvider = google; chưa có nền Google chính thức: mapTiles = null');
    eq([c.sla.targetPct, c.sla.sigmaLeg, c.sla.sigmaDay, c.sla.bufferBase, c.sla.bufferFloor, c.sla.stopMin, c.sla.bufferMin], [85, 0.3, 0.12, 3, 5, 6, 10], 'thông số SLA gửi giao diện có thêm các số của mô hình theo đường');
    const tiles = { provider: 'google', roadmap: 'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=S1&key=K1', satellite: 'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=S2&key=K1', maxZoom: 22, attribution: 'map-attribution' };
    h.core.cfg.mapTiles = tiles; // server.js làm mới phiên nền bản đồ ngay trên core.cfg
    eq((await me()).mapTiles, tiles, 'đổi core.cfg.mapTiles → /api/me trả ngay bản mới (cùng một đối tượng cấu hình)');
    eq((await h.call('log1', 'GET', '/api/live')).body.cfg.mapTiles, tiles, 'ảnh chụp bản đồ trực tiếp (/api/live) cũng vậy');
    const tok = (await h.call('log1', 'POST', `/api/stops/${(await mkTask(h, { stops: [{ site_id: a.id }] })).body.task.stops[0].id}/bo-link`)).body.token;
    const bo = (await boDevice(h, '10.0.0.31').call('POST', '/api/bo-link/view', { token: tok })).body;
    ok(bo.cfg.routingProvider === 'google' && JSON.stringify(bo.cfg.mapTiles) === JSON.stringify(tiles), 'trang của BO (không đăng nhập) cũng nhận nền bản đồ Google để vẽ đường của Google');
    h.core.cfg.mapTiles = { ...tiles, roadmap: tiles.roadmap.replace('S1', 'S3') };
    ok((await me()).mapTiles.roadmap.includes('session=S3'), 'phiên mới thay phiên cũ');
    h.core.cfg.mapTiles = null;
    eq((await me()).mapTiles, null, 'tắt nền chính thức → null');
    const O = await world(kind, { cfg: { routingProvider: 'osrm' } }), W0 = await world(kind, { noRoute: true });
    const co = (await O.h.call('log1', 'GET', '/api/me')).body.cfg, c0 = (await W0.h.call('log1', 'GET', '/api/me')).body.cfg;
    eq([co.routingProvider, c0.routingProvider, c0.mapTiles, c0.routing], ['osrm', null, null, false], 'OSRM → osrm; không cấu hình → null');
  });

  await group('Không bật dịch vụ đường đi: mọi thứ như cũ', async () => {
    const { h, a, b } = await world(kind, { noRoute: true });
    eq((await h.call('log1', 'GET', '/api/me')).body.cfg.routing, false, 'giao diện biết máy chủ không có đường thực tế');
    const t = (await mkTask(h, { fo_id: h.byName('fo1').id, stops: [{ site_id: a.id }, { site_id: b.id }] })).body.task;
    await h.idle(); h.core.tick();
    const cur = h.store.tasks.get(t.id);
    ok(cur.route_src === null && cur.base_min === estOf([a, b], 2).base_min && cur.route_err === null && h.store.routes.count({}) === 0, 'task giữ SLA ước tính, không có đường');
    ok(cur.p50_min === null && cur.unc_min === null && cur.sla_q === null && cur.route_mode === null, 'không có số của mô hình theo đường');
    eq((await h.call('log1', 'GET', `/api/tasks/${t.id}/route`)).body, { route: null, stale: false }, 'xem đường: chưa có');
    eq((await h.call('log1', 'POST', `/api/tasks/${t.id}/reroute`)).body.error, 'no_routing', 'tính lại đường: báo máy chủ chưa bật dịch vụ');
    eq(h.store.settings.get('sla_calib'), null, 'nhịp định kỳ không tính hiệu chỉnh khi không có dịch vụ');
    const lead = await h.call('lead1', 'GET', '/api/stats/sla');
    ok(lead.status === 200 && lead.body.routing === false && lead.body.travel.k === 1 && lead.body.service.default.min === 6, 'vẫn xem được hiệu chỉnh (chưa có dữ liệu: hệ số 1, dừng 6 phút)');
    eq(lead.body.buffer, { gamma: 1, n: 0, target_pct: 85, coverage: null, n_cov: 0 }, 'dự phòng: γ = 1, chưa có chuyến nào để tính tỉ lệ kịp hạn');
  });
}

await group('Tiện ích đường đi: mã hoá / giải mã polyline, chiếu vị trí lên đường, phần đường còn lại', async () => {
  const g = '_p~iF~ps|U_ulLnnqC_mqNvxq`@', p3 = [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]];
  eq(decodePolyline(g), p3, 'giải mã đúng ví dụ của Google');
  eq([encodePolyline(p3), encodePolyline(p3.map(([lat, lon]) => ({ lat, lon })))], [g, g], 'mã hoá đúng ví dụ của Google (nhận cả dạng { lat, lon })');
  const rnd = Array.from({ length: 50 }, (_, i) => [+(10.7 + Math.sin(i) * 0.1).toFixed(5), +(106.7 + Math.cos(i * 1.3) * 0.1).toFixed(5)]);
  eq(decodePolyline(encodePolyline(rnd)), rnd, 'mã hoá rồi giải mã: giữ nguyên 50 điểm (5 chữ số)');
  const r6 = [[10.123456, 106.654321], [-33.868, 151.209]];
  eq(decodePolyline(encodePolyline(r6, 6), 6), r6, 'độ chính xác 6 chữ số (polyline6 của OSRM)');
  eq([decodePolyline(''), decodePolyline(null), decodePolyline('_p~iF~ps|U_ulL'), decodePolyline('!!!')], [[], [], [[38.5, -120.2]], []], 'chuỗi rỗng / hỏng: không lỗi, dừng ở điểm cuối đọc được');
  const path = [[10.77, 106.7], [10.77, 106.71], [10.78, 106.71]];
  const seg1 = distM(10.77, 106.7, 10.77, 106.71), total = seg1 + distM(10.77, 106.71, 10.78, 106.71);
  const p = projectOnPath(path, 10.7705, 106.705);
  ok(p.idx === 0 && Math.abs(p.t - 0.5) < 1e-6 && Math.abs(p.offM - 55.6) < 0.5 && Math.abs(p.distAlongM - seg1 / 2) < 1 && Math.abs(p.totalM - total) < 1, 'chiếu lên đoạn gần nhất: vị trí trên đoạn, quãng đã đi, cách đường ~56 m');
  eq(slicePath(path, p.idx, p.t), [[10.77, 106.705], [10.77, 106.71], [10.78, 106.71]], 'phần đường còn lại bắt đầu ở điểm chiếu');
  const q = projectOnPath(path, 10.775, 106.7102);
  ok(q.idx === 1 && Math.abs(q.t - 0.5) < 1e-6 && Math.abs(q.distAlongM - (seg1 + (total - seg1) / 2)) < 1 && Math.abs(q.offM - 21.8) < 0.5, 'điểm gần đoạn thứ hai');
  eq(slicePath(path, q.idx, q.t), [[10.775, 106.71], [10.78, 106.71]], 'phần còn lại trên đoạn thứ hai');
  const e = projectOnPath(path, 10.79, 106.71);
  ok(e.idx === 1 && e.t === 1 && Math.abs(e.distAlongM - e.totalM) < 1e-6 && Math.abs(e.offM - 1112) < 2, 'quá cuối đường: chiếu vào điểm cuối');
  ok(projectOnPath([], 10, 106) === null && projectOnPath([[10.77, 106.7]], 10.771, 106.7).totalM === 0 && Math.abs(projectOnPath([[10.77, 106.7]], 10.771, 106.7).offM - 111.2) < 0.5, 'đường rỗng → null; một điểm → khoảng cách tới điểm đó');
  eq([slicePath(path, 0, 1), slicePath(path, 9, 0.5), slicePath([], 0, 0)], [[[10.77, 106.71], [10.78, 106.71]], [[10.78, 106.71]], []], 'cắt đường ở biên: cuối đoạn, quá chỉ số, đường rỗng');
});

await group('Hiệu chỉnh (hàm thuần): P50 / P85 thời gian dừng từng điểm, hệ số thời gian đi co về 1, γ của dự phòng', async () => {
  eq([quantile([1, 2, 3, 4], 0.5), quantile([4, 5, 6, 7, 8, 9], 0.75), quantile([5], 0.75), quantile([], 0.5)], [2.5, 7.75, 5, null], 'phân vị nội suy tuyến tính');
  const rows = [...[4, 5, 6, 7, 8, 9, 10, 11, 12].map((min) => ({ site_id: 1, name: 'BO A', min, bo: true })), ...[20, 22, 24].map((min) => ({ site_id: 2, name: 'BO B', min, bo: true })), ...[3, 5].map((min) => ({ site_id: 3, name: 'Văn phòng', min, bo: false }))];
  eq(calibService(rows, 6), { default: { min: 6, min50: null, min85: null, n: 14 }, sites: [
    { site_id: 1, name: 'BO A', min: 8, min50: 8, min85: 11, n: 9 }, { site_id: 2, name: 'BO B', min: 8, min50: 8, min85: 16, n: 3 }, { site_id: 3, name: 'Văn phòng', min: 6, min50: 6, min85: 10, n: 2 },
  ] }, 'điểm đủ 8 lượt: P50 / P85 riêng (8 / 10,8 → 11); điểm ít lượt, chung chưa đủ 20 lượt: mặc định (BO cần xác nhận 8 / 16, điểm thường 6 / 10)');
  const more = [...rows, ...Array.from({ length: 10 }, (_, i) => ({ site_id: null, min: 10 + (i % 4) }))];
  const s = calibService(more, 6), all = more.map((r) => r.min), g50 = Math.round(quantile(all, 0.5)), g85 = Math.round(quantile(all, 0.85));
  ok(s.default.n === 24 && s.default.min50 === g50 && s.default.min85 === g85 && s.default.min === g50 && s.sites.find((x) => x.site_id === 2).min50 === g50 && s.sites.find((x) => x.site_id === 2).min85 === g85 && s.sites.find((x) => x.site_id === 1).min85 === 11, `đủ 20 lượt chung: điểm ít lượt dùng P50 / P85 chung (${g50} / ${g85} phút)`);
  eq(calibService([...Array(8).fill({ site_id: 3, min: 90 }), ...Array(8).fill({ site_id: 4, min: 0.5 })], 6).sites.map((x) => [x.site_id, x.min50, x.min85]), [[3, 60, 60], [4, 2, 2]], 'kẹp trong 2–60 phút');
  eq(calibTravel(Array(10).fill({ r: 1.5, peak: false })), { k: 1.17, n: 10, peak: { k: 1.17, n: 0 }, off: { k: 1.17, n: 10 } }, '10 mẫu chậm 1,5 lần: co về 1 → 1,17; nhóm chưa đủ 30 mẫu dùng hệ số chung');
  eq(calibTravel([...Array(40).fill({ r: 1.5, peak: false }), ...Array(35).fill({ r: 2, peak: true }), { r: 0.1, peak: false }, { r: 9, peak: true }]), { k: 1.39, n: 75, peak: { k: 1.6, n: 35 }, off: { k: 1.33, n: 40 } }, 'đủ 30 mẫu: giờ cao điểm / ngoài giờ có hệ số riêng (kẹp 1,6); bỏ mẫu ngoài 0,3–4');
  eq([calibTravel(Array(100).fill({ r: 0.4, peak: false })).k, calibTravel([])], [0.7, { k: 1, n: 0, peak: { k: 1, n: 0 }, off: { k: 1, n: 0 } }], 'nhanh bất thường: kẹp 0,7; chưa có dữ liệu: hệ số 1');
  const G = (n, f) => Array.from({ length: n }, (_, i) => ({ a: 43 + f(i) * 10, p50: 40, unc: 10 })); // s = f(i)
  eq(calibGamma(G(100, (i) => i / 100), 85, 3), { gamma: 0.85, n: 100 }, '100 chuyến, s = 0; 0,01; …; 0,99: phần tử thứ ⌈101 × 0,85⌉ = 86 → γ = 0,85');
  eq(calibGamma(G(99, (i) => i / 100), 85, 3), { gamma: 1, n: 99 }, 'dưới 100 chuyến: γ = 1');
  eq([calibGamma(G(150, (i) => 5 + i / 100), 85, 3).gamma, calibGamma(G(150, (i) => -1 + i / 1000), 85, 3).gamma], [3, 0.5], 'kẹp 0,5–3');
  eq(calibGamma([...G(100, (i) => i / 100), { a: NaN, p50: 40, unc: 10 }, { a: 50, p50: 40, unc: 0 }, { a: 50, p50: null, unc: 10 }], 90, 3), { gamma: 0.9, n: 100 }, 'bỏ dòng thiếu số hoặc độ bất định 0; nhắm 90 %: phần tử thứ ⌈101 × 0,9⌉ = 91 (s = 0,9)');
});

await group('SLA theo đường (hàm thuần): z theo % nhắm tới, ví dụ tính tay, dự phòng tối thiểu, khung giờ từng chặng', async () => {
  ok(Math.abs(zOf(0.85) - Z85) < 1e-8 && Math.abs(zOf(0.9) - Z90) < 1e-8 && zOf(0.5) === 0 && Math.abs(zOf(0.99) - 2.326347874) < 1e-8 && Math.abs(zOf(0.01) + zOf(0.99)) < 1e-12, 'z của phân phối chuẩn: 85 % → 1,0364; 90 % → 1,2816; 50 % → 0; 99 % → 2,3263 (đối xứng)');
  const o = { departAt: MON_10H, z: zOf(0.85), sigmaLeg: 0.3, sigmaDay: 0.12, bufferBase: 3, bufferFloor: 5, gamma: 1 };
  const legs = [{ duration_s: 900 }, { duration_s: 1200 }, { duration_s: 600 }], svc = [{ p50: 6, p85: 10 }, { p50: 8, p85: 16 }, { p50: 8, p85: 16 }, null];
  // ΣT = 45, ΣT² = 725 → Leff = 2,793; σT = √(0,12² + 0,3² / 2,793) = 0,2159; XT = 45 × (e^(1,0364 × 0,2159) − 1) = 11,29; XS = √(4² + 8² + 8²) = 12; U = 16,47
  eq(routeSla(legs, svc, () => 1, o), { travel_min: 45, service_min: 22, buffer_min: 19, base_min: 90, p50_min: 67, unc_min: 16 }, 'ví dụ: đi 15 + 20 + 10 phút, văn phòng → BO A → BO B → quay về: dự phòng max(5, 3 + 16,47) = 19, SLA gốc 45 + 22 + 19 = 86 → 90 phút');
  // Nhắm 90 %: XT = 45 × (e^(1,2816 × 0,2159) − 1) = 14,35; XS = 12 × 1,2816 / 1,0364 = 14,84; U = 20,64
  eq(routeSla(legs, svc, () => 1, { ...o, z: zOf(0.9) }), { travel_min: 45, service_min: 22, buffer_min: 24, base_min: 95, p50_min: 67, unc_min: 21 }, 'nhắm 90 %: cả phần đi lẫn phần dừng nới theo z → U 20,6, dự phòng 24 phút, SLA gốc 95');
  eq(routeSla(legs, svc, () => 1, { ...o, gamma: 2 }).buffer_min, Math.round(3 + 2 * 16.47362799414423), 'γ = 2: dự phòng = 3 + 2U');
  eq(routeSla([{ duration_s: 120 }], [{ p50: 6, p85: 6 }, { p50: 6, p85: 6 }], () => 1, o), { travel_min: 2, service_min: 12, buffer_min: 5, base_min: 20, p50_min: 14, unc_min: 1 }, 'tuyến ngắn, thời gian dừng ổn định: 3 + U dưới 5 → dự phòng tối thiểu 5 phút');
  eq(routeSla([{ duration_s: 0 }], [{ p50: 6, p85: 10 }, { p50: 6, p85: 10 }], () => 1, o), { travel_min: 0, service_min: 12, buffer_min: 9, base_min: 25, p50_min: 12, unc_min: 6 }, 'chặng dài 0 (hai điểm trùng chỗ): không lỗi chia cho 0, U = XS');
  const seen = [], kOf = (ts) => { seen.push(ts); return ts >= MON_10H + 20 * MIN ? 2 : 1; };
  const r = routeSla([{ duration_s: 900 }, { duration_s: 600 }], [{ p50: 6, p85: 10 }, { p50: 8, p85: 16 }, { p50: 6, p85: 10 }], kOf, o);
  eq(seen, [MON_10H, MON_10H + 23 * MIN], 'khung giờ từng chặng: chặng 1 rời lúc xuất phát, chặng 2 rời lúc tới BO A (15 phút) + dừng 8 phút');
  eq([r.travel_min, r.service_min], [35, 20], 'chặng 2 rời sau mốc nên nhân hệ số 2: đi 15 + 10 × 2 = 35 phút');
});

await suite('memory');
await suite('sqlite');
summary('Đường đi thực tế & SLA theo đường');
