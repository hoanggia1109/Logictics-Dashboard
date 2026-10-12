// fix.perf.test.mjs — sửa lỗi "lag khi bấm gửi việc": số liệu tổng hợp (giờ quay cả lịch sử thẻ, bảng hiệu suất, xu hướng, thống kê sự cố,
// tra tên người / BO) được nhớ và dùng lại giữa các yêu cầu cho tới khi có lệnh ghi đổi dữ liệu nó đã đọc.
//  1) Phiên bản dữ liệu của kho (core/store-ver.js): mọi lệnh ghi tăng phiên bản đúng bảng / phần bảng; không nhớ kết quả tính trong giao dịch
//     hay khi có lệnh ghi xen giữa; giao dịch hoàn tác không để lại kết quả đã thấy dữ liệu chưa ghi.
//  2) Không bao giờ cũ: người vừa gửi xong mở lại thấy ngay thay đổi của mình; phạm vi người xem khác nhau không dùng chung kết quả.
//  3) Sau mỗi bước của kịch bản ngẫu nhiên (hub.fuzz), mọi màn hình đọc qua bộ nhớ đệm phải khớp hệt số tính lại từ đầu (lõi không có bộ nhớ đệm).
//  4) Giờ quay không phụ thuộc màn hình nào mở trước: bản ghi thẻ cộng theo một thứ tự cố định (mã bản ghi) dù đọc thẳng hay lọc lại từ lượt
//     đọc rộng hơn của cùng yêu cầu, nên số đã nhớ (dùng chung cho mọi màn hình) và mọi màn hình cùng một số tới chữ số cuối.
//  5) Dữ liệu mẫu nhiều tuần (PERF_DEMO_SCALE, mặc định 1): mọi tài khoản, mọi màn hình, mở theo hai thứ tự ngược nhau trên hai lõi có bộ nhớ đệm
//     và trên lõi tính lại từ đầu: cùng kết quả tới từng byte.
import crypto from 'node:crypto';
import { mk, ok, eq, group, summary } from './harness.mjs';
import { SCHEMA } from '../core/schema.js';
import { createMemoryStore } from '../core/store-memory.js';
import { createSqliteStore } from '../core/store-sqlite.js';
import { createCore } from '../core/core.js';
import { seedDemo } from '../core/demo.js';
import { seedHubDemo } from '../core/hub/demo.js';
import { run } from './hub.fuzz.mjs';

const HOUR = 3600000;

// ───────── 1) Phiên bản dữ liệu của kho ─────────
for (const kind of ['memory', 'sqlite']) {
  await group(`phiên bản dữ liệu: lệnh ghi đổi đúng bảng / phần bảng đã đọc (${kind})`, async () => {
    const S = kind === 'sqlite' ? createSqliteStore(SCHEMA, ':memory:') : createMemoryStore(SCHEMA);
    const T = (fn) => S.track(fn);
    const v0 = S.version();
    const site = S.sites.insert({ name: 'BO A', type: 'bo', active: 1 });
    ok(S.version() > v0, 'lệnh ghi tăng số phiên bản');
    const a = T(() => S.sites.find({ active: 1 }));
    ok(a.ok && a.value.length === 1 && S.fresh(a.deps), 'kết quả vừa tính còn đúng');
    S.kits.insert({ code: 'K1', kind: 'multicam', status: 'ready' });
    ok(S.fresh(a.deps), 'ghi bảng khác không làm mất kết quả');
    S.sites.update(site, { name: 'BO A1' });
    ok(!S.fresh(a.deps), 'sửa dòng của bảng đã đọc: kết quả cũ không dùng được nữa');
    const g = T(() => S.sites.get(site));
    S.sites.remove(S.sites.insert({ name: 'BO B', type: 'bo', active: 1 }));
    ok(!S.fresh(g.deps), 'đọc theo mã cũng phụ thuộc cả bảng');

    // Việc chia theo trạng thái: bảng hiệu suất chỉ đọc việc đã xong.
    const job = (status) => S.jobs.insert({ code: 'J' + Math.random(), type: 'manual', team: 'tech', title: 'x', status });
    const j1 = job('open');
    job('done');
    const d = T(() => S.jobs.find({ status: 'done' }));
    const all = T(() => S.jobs.find({ team: 'tech' }));
    S.jobs.update(j1, { title: 'y' });
    ok(S.fresh(d.deps), 'sửa việc đang mở: số liệu việc đã xong vẫn dùng được');
    ok(!S.fresh(all.deps), 'đọc việc không lọc trạng thái: mọi lệnh ghi việc đều tính');
    S.jobs.update(j1, { status: 'doing' });
    ok(S.fresh(d.deps), 'việc đang mở chuyển sang đang làm: chưa đụng tới việc đã xong');
    S.jobs.update(j1, { status: 'done' });
    ok(!S.fresh(d.deps), 'việc xong: số liệu việc đã xong phải tính lại');
    const d2 = T(() => S.jobs.count({ status: ['done', 'cancelled'] }));
    S.jobs.update(j1, { status: 'open' });
    ok(!S.fresh(d2.deps), 'việc đã xong mở lại: cũng phải tính lại');
    const d3 = T(() => S.jobs.find({ status: 'done' }));
    S.jobs.removeWhere({ team: 'logistics' });
    ok(S.fresh(d3.deps), 'xoá hàng loạt không trúng dòng nào: không đổi phiên bản');
    S.jobs.removeWhere({ title: 'x' });
    ok(!S.fresh(d3.deps), 'xoá hàng loạt: mọi phần của bảng phải tính lại');

    // Nhật ký chia theo loại đối tượng; cài đặt theo khoá.
    const k = T(() => S.hub_log.find({ entity: 'kit', action: 'status' }));
    S.hub_log.insert({ ts: 1, entity: 'acc', entity_id: 1, action: 'in', text: '' });
    ok(S.fresh(k.deps), 'nhật ký phụ kiện không làm mất số kit theo ngày (đọc nhật ký kit)');
    S.hub_log.insert({ ts: 2, entity: 'kit', entity_id: 1, action: 'status', text: '' });
    ok(!S.fresh(k.deps), 'nhật ký kit mới: tính lại');
    const st = T(() => S.settings.get('hub_cfg'));
    S.settings.insert({ id: 'seq:J', value: 1 });
    ok(S.fresh(st.deps), 'số thứ tự mã không làm mất số liệu dùng cấu hình');
    S.settings.insert({ id: 'hub_cfg', value: { dailyStdHours: 9 } });
    ok(!S.fresh(st.deps), 'đổi cấu hình: tính lại');

    // Không nhớ kết quả tính trong giao dịch hoặc có lệnh ghi xen giữa.
    S.tx(() => { S.sites.insert({ name: 'BO C', type: 'bo', active: 1 }); ok(!T(() => S.sites.find({})).ok, 'trong giao dịch: không nhớ (dữ liệu chưa ghi xong)'); });
    ok(!T(() => { S.sites.find({}); S.kits.insert({ code: 'K2', kind: 'multicam', status: 'ready' }); }).ok, 'có lệnh ghi xen giữa lúc tính: không nhớ');
    const before = T(() => S.sites.count({}));
    try { S.tx(() => { S.sites.insert({ name: 'BO D', type: 'bo', active: 1 }); throw new Error('hoàn tác'); }); } catch { /* hoàn tác */ }
    ok(!S.fresh(before.deps), 'giao dịch hoàn tác: kết quả trước đó tính lại (không giữ thứ giao dịch đã thấy)');
    eq(S.sites.count({}), before.value, 'tính lại sau hoàn tác: đúng dữ liệu đã ghi');

    // Lượt tính lồng nhau: lượt ngoài phụ thuộc cả bảng lượt trong đã đọc (kể cả khi lượt trong lấy từ bộ nhớ đệm: adopt).
    const inner = T(() => S.kits.find({}));
    const outer = T(() => { S.adopt(inner.deps); return S.sites.find({}); });
    S.kits.insert({ code: 'K3', kind: 'multicam', status: 'ready' });
    ok(!S.fresh(outer.deps), 'lượt ngoài dùng kết quả lượt trong: kit đổi thì lượt ngoài cũng tính lại');
    if (S.close) S.close();
  });
}

// ───────── 2) Không bao giờ cũ sau lệnh ghi; phạm vi người xem ─────────
for (const kind of ['memory', 'sqlite']) {
  await group(`người vừa gửi mở lại thấy ngay; Sale chỉ thấy số của BO mình (${kind})`, async () => {
    const r = await run(kind, 250, 7);
    ok(!r.broken, r.broken || '');
    const { h } = r;
    const S = h.store;
    const live = S.sites.find({ type: 'bo', active: 1, ops_status: 'live' });
    ok(live.length > 0, `có BO đang ghi hình (${live.length})`);
    if (!live.length) return;
    const sale = async (who) => (await h.call(who, 'GET', '/api/hub/sale', null, { period: 'week' })).body;
    const sh0 = await sale('sh');
    eq(JSON.stringify(await sale('sh')), JSON.stringify(sh0), 'mở lại khi chưa có gì đổi: cùng số');
    // Tech nhập dung lượng một thẻ cho BO (ghi thẳng vào kho như dữ liệu nhập): giờ quay đổi ngay ở lần mở kế tiếp.
    const bo = live[0], d = new Date(h.clock.now() + 7 * HOUR).toISOString().slice(0, 10);
    S.card_records.insert({ card_id: null, code: 'PERF-1', site_id: bo.id, kit_id: null, handover_id: null, shoot_date: d, cover_to: d, gb: 169, hours: 10, zero_reason: null, photos: null, by_id: null, at: h.clock.now(), edited_by: null, edited_at: null, src: 'test' });
    const sh1 = await sale('sh');
    const row = (b) => b.outlets.find((o) => o.id === bo.id) || { hours: 0 };
    ok(Math.abs(row(sh1).hours - row(sh0).hours - 10) < 0.051, `giờ quay của BO tăng ngay 10 giờ (${row(sh0).hours} → ${row(sh1).hours})`);
    // Sale Lead gửi yêu cầu hỗ trợ / báo sự cố rồi mở lại danh sách: thấy ngay.
    const mine = S.sites.find({ type: 'bo', active: 1, ops_status: 'live', sale_id: S.users.find({ username: 's1' })[0].id });
    if (mine.length) {
      const n0 = (await h.call('s1', 'GET', '/api/hub/incidents')).body.incidents.length;
      const label = Object.values(h.core.hub.labels()).flat()[0];
      const cr = await h.call('s1', 'POST', '/api/hub/incidents', { site_id: mine[0].id, label, text: 'Kiểm thử bộ nhớ đệm' });
      ok(cr.status === 200, 'Sale báo sự cố');
      const after = (await h.call('s1', 'GET', '/api/hub/incidents')).body.incidents;
      ok(cr.body.duplicate || after.length === n0 + 1, 'mở lại danh sách sự cố: thấy ngay sự cố vừa báo');
      ok(after.some((i) => i.id === (cr.body.incident || {}).id), 'sự cố vừa báo nằm trong danh sách');
    }
    // Hai Sale Lead và Head of Sale: mỗi người một phạm vi, không dùng chung kết quả đã nhớ.
    const s1 = await sale('s1'), s2 = await sale('s2');
    const own = (who) => new Set(S.sites.find({ type: 'bo', active: 1, sale_id: S.users.find({ username: who })[0].id }).map((s) => s.id));
    ok(s1.outlets.every((o) => own('s1').has(o.id)) && s2.outlets.every((o) => own('s2').has(o.id)), 'Sale Lead chỉ thấy BO của mình trên Dashboard Kinh doanh');
    // Sale Lead xem BO của mình: bảng theo Sale chỉ có chính mình; Sale Lead chỉ xem (mọi BO): không có số theo từng Sale Lead.
    const s1id = S.users.find({ username: 's1' })[0].id;
    ok(s1.scope === 'mine' ? (s1.by_sale || []).every((x) => !x.sale.id || x.sale.id === s1id) : s1.scope === 'view' && !s1.by_sale, `Sale Lead không thấy số của Sale Lead khác (phạm vi ${s1.scope})`);
    ok(sh1.outlets.length >= s1.outlets.length + s2.outlets.length - 0 && sh1.by_sale, 'Head of Sale thấy mọi BO và số theo từng Sale Lead');
    // Đổi cấu hình (chuẩn giờ quay): bảng Head of Sale đổi ngay.
    const std = sh1.hos.eval.std_hours;
    const put = await h.call('sh', 'PUT', '/api/hub/config', { dailyStdHours: std + 1 });
    if (put.status === 200) eq((await sale('sh')).hos.eval.std_hours, std + 1, 'đổi chuẩn giờ quay: bảng Head of Sale dùng chuẩn mới ngay');
    // Lead hoàn thành việc: bảng hiệu suất của team đổi ngay (việc đã xong là một phần riêng của bảng việc).
    const p0 = (await h.call('tl', 'GET', '/api/hub/perf')).body;
    const tech = S.users.find({ username: 't1' })[0];
    S.jobs.insert({ code: 'PERF-J1', type: 'manual', team: 'tech', title: 'Việc kiểm thử', status: 'done', assignee_id: tech.id, done_by: tech.id, std_min: 600, due_at: h.clock.now() + HOUR, done_at: h.clock.now(), created_at: h.clock.now() - HOUR });
    const p1 = (await h.call('tl', 'GET', '/api/hub/perf')).body;
    const pts = (p) => (p.rows.find((x) => x.user.id === tech.id) || { points: 0 }).points;
    ok(Math.abs(pts(p1) - pts(p0) - 100) < 0.051, `điểm khối lượng của người vừa xong việc tăng ngay (${pts(p0)} → ${pts(p1)})`);
  });
}

// ───────── 3) Số đã nhớ luôn khớp số tính lại, sau mỗi bước của kịch bản ngẫu nhiên ─────────
/**
 * Lõi thứ hai trên cùng kho, với bộ nhớ đệm riêng (cached) hoặc không có bộ nhớ đệm (store.track ẩn đi: mọi số tính lại từ đầu, như trước khi có H.memo).
 * Trả về { core, get(who, path, query) }.
 */
function coreOn(h, cached = false) {
  const store = Object.create(h.store);
  if (!cached) store.track = undefined;
  const core = createCore({ store, now: () => h.clock.now(), cfg: {}, hashPassword: async (p) => 'h:' + p, verifyPassword: async () => false, token: (n) => crypto.randomBytes(n).toString('base64url'), sha: (s) => crypto.createHash('sha256').update(s).digest('hex'), files: { put() {}, remove() {} } });
  return { core, get: (who, path, query) => core.api({ user: h.byName(who), ip: '10.0.0.1', ua: 'test-agent' }, 'GET', path, query || {}, {}) };
}
const bareCore = (h) => coreOn(h).get;
function views(h) {
  const bos = h.store.sites.find({ type: 'bo', active: 1 }, { limit: 2 }).map((s) => s.id);
  return [
    ['ad', '/api/hub/overview'], ['ad', '/api/hub/overview', { period: 'month' }], ['ll', '/api/hub/overview'], ['tl', '/api/hub/overview'], ['sh', '/api/hub/overview'],
    ['ad', '/api/hub/sale'], ['sh', '/api/hub/sale'], ['sh', '/api/hub/sale', { period: 'month' }], ['s1', '/api/hub/sale'], ['s2', '/api/hub/sale'],
    ['ll', '/api/hub/outlets', { metrics: '1' }], ['sh', '/api/hub/outlets', { metrics: '1' }], ['s1', '/api/hub/outlets', { metrics: '1' }], ['l1', '/api/hub/outlets'], ['s2', '/api/hub/outlets'],
    ...bos.flatMap((id) => [['ll', `/api/hub/outlets/${id}`, { metrics: '1' }], ['sh', `/api/hub/outlets/${id}`]]),
    ['tl', '/api/hub/perf'], ['ll', '/api/hub/perf'], ['ad', '/api/hub/perf', { team: 'logistics', period: 'month' }], ['t1', '/api/hub/perf/me'], ['l2', '/api/hub/perf/me'], ['ll', '/api/hub/perf/trend'],
    ['tl', '/api/hub/incidents'], ['s1', '/api/hub/incidents'], ['ad', '/api/hub/incidents/stats'], ['t1', '/api/hub/incidents/stats', { period: 'month' }],
    ['t1', '/api/hub/home'], ['l1', '/api/hub/home'], ['ll', '/api/hub/home'], ['tl', '/api/hub/home'],
    ['l1', '/api/hub/kits'], ['l1', '/api/hub/cards'], ['s1', '/api/hub/requests'], ['l1', '/api/hub/requests'], ['t1', '/api/hub/cards/upload-queue'], ['l1', '/api/hub/handovers'],
    ['tl', '/api/hub/jobs', { view: 'team' }], ['t1', '/api/hub/jobs'], ['ad', '/api/hub/log'], ['ll', '/api/hub/acc'],
  ];
}
// So tới từng byte, kể cả số thô chưa làm tròn: bản ghi thẻ luôn cộng theo cùng một thứ tự nên số đã nhớ và số tính lại phải giống hệt.
const norm = (r) => JSON.stringify([r.status, r.body]);
for (const [kind, steps, seed, every] of [['sqlite', 500, 3, 4], ['memory', 300, 5, 6]]) {
  await group(`số đã nhớ khớp số tính lại sau mỗi bước ngẫu nhiên (${kind}, ${steps} bước)`, async () => {
    let checks = 0;
    const t0 = Date.now();
    const r = await run(kind, steps, seed, {
      async onStep(i, a, { h }) {
        if (i % every && a !== 'time') return null;
        const fresh = bareCore(h);
        for (const [who, path, query] of views(h)) {
          const c1 = await h.call(who, 'GET', path, null, query);
          const c2 = await h.call(who, 'GET', path, null, query); // lần hai: lấy từ bộ nhớ đệm
          const f = await fresh(who, path, query);
          const q = query ? '?' + new URLSearchParams(query) : '';
          if (norm(c1) !== norm(f)) return `${who} GET ${path}${q}: số đã nhớ khác số tính lại`;
          if (norm(c2) !== norm(f)) return `${who} GET ${path}${q} (mở lại): số đã nhớ khác số tính lại`;
          checks++;
        }
        return null;
      },
    });
    ok(!r.broken, r.broken || '');
    console.log(`    ${checks} lần so màn hình (đã nhớ / tính lại), ${r.stats.calls} lệnh API ngẫu nhiên, ${Date.now() - t0} ms`);
    ok(checks > 1000, `đủ số lần so (${checks})`);
  });
}

// ───────── 4) Giờ quay không phụ thuộc màn hình nào mở trước ─────────
// Ba bản ghi của một BO, cộng theo thứ tự khác nhau ra số khác nhau ở chữ số cuối: thẻ quay Chủ Nhật tuần trước còn ghi tới Thứ Ba (3 giờ chia
// 3 ngày, tuần này có 2 giờ; nhập trước nên mã nhỏ nhất), thẻ quay Thứ Hai 2,1 giờ, thẻ quay Thứ Ba 4,05 giờ. Theo mã bản ghi: 1 + 1 + 2,1 + 4,05
// = 8,149999… (hiển thị 8,1). Đọc thẳng tuần này trả thẻ quay trong tuần trước rồi mới tới thẻ quay từ tuần trước: 2,1 + 4,05 + 1 + 1 = 8,15
// (hiển thị 8,2). Trước khi sửa, Tổng quan (đọc 12 tuần một lượt rồi lọc lại) và màn hình BO (đọc thẳng tuần này) cho hai số khác nhau, và số
// đã nhớ là số của màn hình nào mở trước kể từ lần ghi cuối.
const VN = (date, hm = '10:00') => Date.parse(`${date}T${hm}:00+07:00`);
for (const kind of ['memory', 'sqlite']) {
  await group(`giờ quay giống hệt dù màn hình nào mở trước, mọi màn hình cùng một số (${kind})`, async () => {
    const h = mk(kind, { t: VN('2026-10-08') }); // Thứ Năm; tuần này 05/10 – 11/10
    for (const [u, role] of [['ad', 'admin'], ['sh', 'sale_head'], ['s1', 'sale'], ['ll', 'lead'], ['tl', 'tech_lead']]) await h.user(u, role);
    const S = h.store, s1 = h.byName('s1');
    const bo = S.sites.insert({ name: 'BO Thứ Tự', code: 'BOTT', type: 'bo', active: 1, ops_status: 'live', sale_id: s1.id, launch_date: '2026-09-21', live_periods: [['2026-09-21', null]] });
    let n = 0;
    const rec = (shoot, to, hours) => S.card_records.insert({ card_id: null, code: `ORD-${++n}`, site_id: bo, kit_id: null, handover_id: null, shoot_date: shoot, cover_to: to, gb: +(hours * 16.9).toFixed(2), hours, zero_reason: null, photos: null, by_id: null, at: h.clock.now(), edited_by: null, edited_at: null, src: 'test' });
    rec('2026-10-04', '2026-10-06', 3);
    rec('2026-10-05', '2026-10-05', 2.1);
    rec('2026-10-06', '2026-10-06', 4.05);
    const idOrder = 1 + 1 + 2.1 + 4.05;

    // Hàm nguồn trên lõi không có bộ nhớ đệm: đọc thẳng tuần này và lọc lại từ lượt đọc 12 tuần (memoRead) cho đúng cùng số thô.
    const O = coreOn(h).core.hub.outlets;
    const direct = O.hoursBySite([bo], '2026-10-05', '2026-10-11').get(bo).total;
    const viaWide = O.memoRead(() => { O.hoursBySite(null, '2026-07-20', null); return O.hoursBySite([bo], '2026-10-05', '2026-10-11').get(bo).total; });
    eq(direct, idOrder, `đọc thẳng: cộng theo mã bản ghi (${direct})`);
    eq(viaWide, direct, `lọc lại từ lượt đọc rộng hơn: cùng số thô (${viaWide})`);
    const series = O.memoRead(() => { O.hoursBySite(null, '2026-07-20', null); return O.hoursSeries([bo], [{ from: '2026-09-28', to: '2026-10-04' }, { from: '2026-10-05', to: '2026-10-11' }]); });
    eq(series[1].total, O.hoursSeries([bo], [{ from: '2026-09-28', to: '2026-10-04' }, { from: '2026-10-05', to: '2026-10-11' }])[1].total, 'chuỗi theo tuần: cùng số thô dù đọc thẳng hay lọc lại');

    // Các màn hình có giờ quay tuần này của BO, mở theo hai thứ tự ngược nhau trên hai lõi mới (bộ nhớ đệm trống) và trên lõi tính lại từ đầu.
    const screens = [
      ['ad', '/api/hub/overview', null, (b) => b.sale.outlets.find((o) => o.id === bo).hours],
      ['sh', '/api/hub/outlets', { metrics: '1' }, (b) => b.outlets.find((o) => o.id === bo).week.hours],
      ['sh', '/api/hub/sale', null, (b) => b.outlets.find((o) => o.id === bo).hours],
      ['sh', '/api/hub/sale', null, (b) => b.hos.outlets.find((o) => o.id === bo).hours],
      ['s1', '/api/hub/sale', null, (b) => b.outlets.find((o) => o.id === bo).hours],
      ['s1', '/api/hub/outlets', { metrics: '1' }, (b) => b.outlets.find((o) => o.id === bo).week.hours],
      ['ll', '/api/hub/outlets', { metrics: '1' }, (b) => b.outlets.find((o) => o.id === bo).week.hours],
      ['sh', `/api/hub/outlets/${bo}`, { metrics: '1' }, (b) => b.outlet.week.hours],
      ['ll', '/api/hub/overview', null, null],
      ['tl', '/api/hub/overview', null, null],
      ['ad', '/api/hub/sale', { period: 'month' }, null],
    ];
    const label = ([who, path, query]) => `${who} GET ${path}${query ? '?' + new URLSearchParams(query) : ''}`;
    const open = async (get, list) => { const out = new Map(); for (const sc of list) { const r = await get(sc[0], sc[1], sc[2]); out.set(label(sc), r); } return out; };
    const fwd = await open(coreOn(h, true).get, screens);
    const rev = await open(coreOn(h, true).get, [...screens].reverse());
    const bare = await open(bareCore(h), screens);
    const again = await open(coreOn(h, true).get, [...screens.slice(3), ...screens.slice(0, 3)]);
    let same = 0;
    for (const sc of screens) {
      const k = label(sc), f = norm(fwd.get(k));
      eq(fwd.get(k).status, 200, `${k}: 200`);
      if (norm(rev.get(k)) !== f) ok(false, `${k}: mở theo thứ tự ngược lại cho kết quả khác`);
      else if (norm(again.get(k)) !== f) ok(false, `${k}: mở sau màn hình khác cho kết quả khác`);
      else if (norm(bare.get(k)) !== f) ok(false, `${k}: số đã nhớ khác số tính lại từ đầu`);
      else same++;
    }
    eq(same, screens.length, `mọi màn hình giống hệt nhau theo mọi thứ tự mở và khi tính lại (${same}/${screens.length})`);
    const shown = screens.filter((sc) => sc[3]).map((sc) => [label(sc), sc[3](fwd.get(label(sc)).body)]);
    eq([...new Set(shown.map(([, v]) => v))], [Math.round(Math.round(idOrder * 1e6) / 1e5) / 10], `giờ quay tuần này của BO cùng một số ở mọi màn hình: ${shown.map(([k, v]) => `${k} → ${v}`).join('; ')}`); // cùng cách gạt nhiễu dấu phẩy động với core/hub/report.js
  });
}

// ───────── 5) Dữ liệu mẫu nhiều tuần: mọi tài khoản, mọi màn hình, hai thứ tự mở và tính lại từ đầu ─────────
// Thế giới ngẫu nhiên của hub.fuzz quá nhỏ để cộng số thực lệch thứ tự; dữ liệu mẫu có hàng nghìn bản ghi thẻ, thẻ ghi qua nhiều ngày và nhiều tuần.
const DEMO_SCALE = Number(process.env.PERF_DEMO_SCALE) || 1;
const DEMO_END = Date.parse('2026-10-08T09:00:00Z'); // Thứ Năm 08/10/2026, 16:00 giờ Việt Nam
function demoViews(S) {
  const last = (t, w, n) => S[t].find(w, { order: 'id', desc: true, limit: n }).map((x) => x.id);
  return [
    ['/api/hub/overview'], ['/api/hub/overview', { period: 'month' }], ['/api/hub/overview', { key: '2026-W40' }], ['/api/hub/sale'], ['/api/hub/sale', { period: 'month' }], ['/api/hub/sale', { key: '2026-W40' }],
    ['/api/hub/outlets'], ['/api/hub/outlets', { metrics: '1' }], ['/api/hub/perf'], ['/api/hub/perf', { team: 'tech' }], ['/api/hub/perf', { team: 'logistics', period: 'month' }], ['/api/hub/perf/me'],
    ['/api/hub/perf/trend'], ['/api/hub/perf/trend', { team: 'logistics' }], ['/api/hub/incidents'], ['/api/hub/incidents/stats'], ['/api/hub/incidents/stats', { period: 'month' }],
    ['/api/hub/home'], ['/api/hub/kits'], ['/api/hub/cards'], ['/api/hub/requests'], ['/api/hub/cards/upload-queue'], ['/api/hub/handovers'], ['/api/hub/jobs'], ['/api/hub/jobs', { view: 'team' }],
    ['/api/hub/acc'], ['/api/hub/recon'], ['/api/hub/inbox'], ['/api/hub/export/outlets.csv'],
    ...last('sites', { type: 'bo', active: 1, ops_status: 'live' }, 3).map((id) => [`/api/hub/outlets/${id}`, { metrics: '1' }]),
  ];
}
for (const kind of ['memory', 'sqlite']) {
  await group(`dữ liệu mẫu tỉ lệ ${DEMO_SCALE}: mọi tài khoản và màn hình giống hệt dù mở theo thứ tự nào (${kind})`, async () => {
    const t0 = Date.now();
    const h = mk(kind, { t: DEMO_END, cfg: { demo: true } });
    await seedDemo(h.core);
    await seedHubDemo(h.core, { setNow: (t) => h.clock.set(t ?? DEMO_END), scale: DEMO_SCALE });
    const S = h.store, users = S.users.find({ active: 1 }, { order: 'id' }).map((u) => u.username), views = demoViews(S);
    const label = (who, [path, query]) => `${who} GET ${path}${query ? '?' + new URLSearchParams(query) : ''}`;
    const fwd = coreOn(h, true).get, rev = coreOn(h, true).get, bare = bareCore(h);
    const seen = new Map();
    for (const who of users) for (const v of views) { const r = await fwd(who, v[0], v[1]); seen.set(label(who, v), [norm(r), r.status]); }
    let checks = 0, ok200 = 0;
    const bad = [];
    for (const who of [...users].reverse()) {
      for (const v of [...views].reverse()) {
        const k = label(who, v), [want, status] = seen.get(k);
        const got = [['mở ngược thứ tự', await rev(who, v[0], v[1])], ['mở lại', await fwd(who, v[0], v[1])], ['tính lại từ đầu', await bare(who, v[0], v[1])]];
        for (const [how, r] of got) if (norm(r) !== want) bad.push(`${k} (${how})`);
        checks++; if (status === 200) ok200++;
      }
    }
    console.log(`    ${users.length} tài khoản × ${views.length} màn hình (${ok200} lượt 200), ${S.card_records.count({})} bản ghi thẻ, ${Date.now() - t0} ms`);
    ok(ok200 > 200, `đủ màn hình có số để so (${ok200})`);
    eq(bad.slice(0, 5), [], `${checks} màn hình × 3 cách mở: giống hệt lần mở đầu (${bad.length} khác)`);
  });
}

summary('fix.perf');
