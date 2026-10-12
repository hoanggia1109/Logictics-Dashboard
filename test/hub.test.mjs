// hub.test.mjs — kiểm sâu Ops Hub: một vòng đời đầy đủ giữa Sale, Logistics (kèm FO qua Rider Live) và Tech,
// sau MỖI bước chạy bộ kiểm bất biến (invariants.mjs) để bắt mọi chỗ lệch giữa kit, thẻ, việc, yêu cầu, BO, chuyến và sổ kho.
// Thêm: bảo mật giữa 3 team, chống tạo trùng khi bấm hai lần hoặc nhịp định kỳ chạy lặp, phân ca và vắng ca, sổ phụ kiện,
// bảng Head of Sale, đánh giá hiệu suất theo team, nhập dữ liệu từ Excel (chạy thử không để lại dấu vết).
// Mỗi nhóm chạy 2 lần: kho bộ nhớ (bản xem thử) và kho SQLite (máy chủ).
import { mk, boDevice, ok, eq, group, summary, JPEG } from './harness.mjs';
import { checkInvariants } from './invariants.mjs';
import { buildXlsx } from './xlsx-build.mjs';
import { periodOf, compareOf } from '../core/hub/period.js';

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const VN = (date, hm) => Date.parse(`${date}T${hm}:00+07:00`);
const VP = { name: 'Văn phòng Atlas', type: 'office', lat: 10.7769, lon: 106.7009 };
const Q3 = { name: 'BO Quận 3', code: 'Q3', lat: 10.7835, lon: 106.6869, contact: 'Chị Hoa', phone: '0901111222', address: '12 Võ Văn Tần, Quận 3' };
const TD = { name: 'BO Thủ Đức', code: 'TD', lat: 10.8494, lon: 106.7537, contact: 'Anh Nam', phone: '0903333444', address: 'Thủ Đức' };

async function world(kind) {
  const h = mk(kind);
  h.clock.set(VN('2026-10-05', '08:30')); // Thứ Hai, W41
  const people = [['ad', 'admin', 'Quản trị'], ['tl', 'tech_lead', 'Trưởng Tech'], ['t1', 'tech', 'Tech Một'], ['t2', 'tech', 'Tech Hai'], ['ll', 'lead', 'Trưởng Logistics'],
    ['l1', 'logistic', 'Log Một'], ['l2', 'logistic', 'Log Hai'], ['fo1', 'fo', 'FO Một'], ['sh', 'sale_head', 'Trưởng Sale'], ['s1', 'sale', 'Sale Một'], ['s2', 'sale', 'Sale Hai']];
  const U = {};
  for (const [u, role, name] of people) U[u] = await h.user(u, role, { name });
  const go = async (who, method, path, body, query) => {
    const r = await h.call(who, method, path, body, query);
    if (r.status !== 200) throw new Error(`${who} ${method} ${path} → ${r.status} ${r.body.error}: ${r.body.message}`);
    return r.body;
  };
  const call = (who, method, path, body, query) => h.call(who, method, path, body, query);
  const st = async (who, method, path, body, query) => (await h.call(who, method, path, body, query)).status;
  const seen = (...us) => { for (const u of us) h.core.hub.K.hooks.onSeen(h.byName(u), h.clock.now()); };
  const tick = () => { h.clock.add(61000); h.core.tick(); };
  const inv = (label) => { const v = checkInvariants(h.store); ok(!v.length, `bất biến sau "${label}": ${v.join(' | ')}`); return v; };
  const job = (where) => h.store.jobs.find(where, { order: 'id', desc: true, limit: 1 })[0] || null;
  const jobs = (where) => h.store.jobs.find(where, { order: 'id' });
  const kit = (code) => h.store.kits.find({ code }, { limit: 1 })[0];
  const card = (code) => h.store.cards.find({ code }, { limit: 1 })[0];
  const dev = (code) => h.store.devices.find({ code }, { limit: 1 })[0];
  const site = (code) => h.store.sites.find({ code }, { limit: 1 })[0];
  const uname = (id) => h.store.users.get(id).username;
  /** Người đang giữ việc làm xong việc (đúng như ngoài đời: ai nhận thì người đó bấm). */
  const doJob = async (j, result = {}, who) => go(who || uname(j.assignee_id), 'POST', `/api/hub/jobs/${j.id}/done`, { result });
  /** Lead xếp ca cả ngày (không ghi giờ) cho các ngày: chỉ người có ca đã duyệt mới vào ca và được tự giao việc. */
  const dayShift = async (dates, users = ['l1', 'l2', 't1', 't2']) => {
    for (const [ld, team] of [['ll', ['l1', 'l2']], ['tl', ['t1', 't2']]]) {
      const rows = users.filter((u) => team.includes(u)).flatMap((u) => dates.map((date) => ({ user_id: U[u].id, date })));
      if (rows.length) await go(ld, 'PUT', '/api/hub/roster', { rows });
    }
  };
  return { h, U, go, call, st, seen, tick, inv, job, jobs, kit, card, dev, site, uname, doJob, dayShift };
}

/** FO chạy hết một chuyến: nhận, bắt đầu, xác nhận từng điểm; BO xác nhận qua link (counts: số BO báo, mặc định khớp FO). */
async function runTrip(W, taskId, perStop = {}, opt = {}) {
  const { h, go } = W;
  if (!opt.started) {
    await go('fo1', 'POST', `/api/tasks/${taskId}/accept`);
    await go('fo1', 'POST', `/api/tasks/${taskId}/start`);
  }
  const stops = h.store.stops.find({ task_id: taskId }, { order: 'seq' });
  for (const s of stops) {
    h.clock.add(15 * MIN);
    const c = perStop[s.seq] || {};
    const counts = { cards_out: c.cards_out ?? s.exp_cards_out, cards_in: c.cards_in ?? s.exp_cards_in, dev_out: c.dev_out ?? s.exp_dev_out, dev_in: c.dev_in ?? s.exp_dev_in };
    if (c.fail) { await go('fo1', 'POST', `/api/stops/${s.id}/fail`, { reason: c.fail, lat: s.lat, lon: s.lon }); continue; }
    await go('fo1', 'POST', `/api/stops/${s.id}/proof`, { photos: s.is_return ? [] : [JPEG], ...counts, lat: s.lat, lon: s.lon });
    const fresh = h.store.stops.get(s.id);
    if (fresh.bo_status === 'pending') {
      const { token } = await go('l1', 'POST', `/api/stops/${s.id}/bo-link`);
      const bo = boDevice(h);
      await bo.call('POST', '/api/bo-link/view', { token });
      const b = c.bo || {};
      const r = await bo.call('POST', '/api/bo-link/confirm', { token, photos: [JPEG], cards_recv: b.cards_recv ?? counts.cards_out, cards_given: b.cards_given ?? counts.cards_in, dev_recv: b.dev_recv ?? counts.dev_out, dev_given: b.dev_given ?? counts.dev_in });
      if (r.status !== 200) throw new Error('BO xác nhận lỗi: ' + JSON.stringify(r.body));
    }
  }
  return h.store.tasks.get(taskId);
}

async function suite(kind) {
  console.log(`\n── Kho ${kind === 'sqlite' ? 'SQLite' : 'bộ nhớ'} ──`);

  await group('Vòng đời đầy đủ giữa 3 team, kiểm bất biến sau từng bước', async () => {
    const W = await world(kind);
    const { h, U, go, st, seen, tick, inv, job, jobs, kit, card, dev, site, doJob } = W;

    // ── Chuẩn bị kho ──
    const vp = (await go('ll', 'POST', '/api/sites', VP)).site;
    await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: 'MC01 MC02 MC03 MC04 MC05 MC06' });
    await go('ll', 'POST', '/api/hub/devices', { type: 'cm5', codes: 'CM01 CM02 CM03 CM04 CM05 CM06' });
    const sdCodes = Array.from({ length: 24 }, (_, i) => 'SD' + String(i + 1).padStart(2, '0'));
    await go('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: sdCodes.join(' ') });
    eq((await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: 'MC01 MC07' })).duplicates, ['MC01'], 'mã thiết bị đã có thì bỏ qua và báo lại');
    for (const [id, qty] of [['hub_sac', 10], ['day_gan', 10], ['cap_c_c', 10], ['headstrap', 6]]) await go('l1', 'POST', `/api/hub/acc/${id}/move`, { kind: 'in', qty, reason: 'Khai báo tồn đầu kỳ' });
    const acc1 = { hub_sac: 1, day_gan: 1, cap_c_c: 1 };
    for (const [code, m, c] of [['K01', 'MC01', 'CM01'], ['K02', 'MC02', 'CM02'], ['K03', 'MC03', 'CM03'], ['K04', 'MC04', 'CM04']]) await go('l1', 'POST', '/api/hub/kits', { code, kind: 'multicam', devices: `${m} ${c}`, acc: acc1 });
    eq((await go('l1', 'GET', '/api/hub/acc')).acc.find((a) => a.id === 'hub_sac').free, 6, 'hub sạc: 10 tổng − 4 trong kit = 6 rảnh');
    eq(await st('l1', 'POST', '/api/hub/kits', { code: 'K05', kind: 'multicam', acc: { hub_sac: 7 } }), 409, 'tạo kit lấy nhiều phụ kiện hơn số rảnh → chặn');
    inv('chuẩn bị kho');

    // ── Phân ca, chấm công, vắng ca ──
    eq(await st('tl', 'PUT', '/api/hub/roster', { rows: [{ user_id: U.l1.id, date: '2026-10-05', shift: 'HC' }] }), 403, 'Tech Lead không xếp ca cho Logistics');
    eq(await st('s1', 'PUT', '/api/hub/roster', { rows: [] }), 403, 'Sale không xếp ca');
    await go('ll', 'PUT', '/api/hub/roster', { rows: [{ user_id: U.l1.id, date: '2026-10-05', shift: 'HC' }, { user_id: U.l2.id, date: '2026-10-05', shift: 'HC' }] });
    await go('tl', 'PUT', '/api/hub/roster', { rows: [{ user_id: U.t1.id, date: '2026-10-05', shift: 'HC' }, { user_id: U.t2.id, date: '2026-10-05', shift: 'HC' }] });
    h.clock.set(VN('2026-10-05', '08:35'));
    seen('l1', 't1', 't2'); // l2 không mở ứng dụng
    eq(h.store.attendance.get(`${U.l1.id}:2026-10-05`).status, 'present', 'vào ca đúng giờ khi mở ứng dụng trong giờ ca');
    const manual = (await go('ll', 'POST', '/api/hub/jobs', { title: 'Sắp xếp kệ phụ kiện', assignee_id: U.l2.id })).job;
    eq(manual.assignee.id, U.l2.id, 'Lead giao việc tay cho l2');
    h.clock.set(VN('2026-10-05', '09:31'));
    h.core.tick();
    eq(h.store.attendance.get(`${U.l2.id}:2026-10-05`).status, 'absent', 'quá 60 phút chưa vào ca → ghi vắng');
    eq(h.store.jobs.get(manual.id).assignee_id, U.l1.id, 'việc chưa bắt đầu của người vắng tự chuyển cho người đang trong ca');
    ok(h.store.inbox.count({ user_id: U.ll.id, kind: 'absent' }) === 1, 'Logistic Lead được báo người vắng');
    await doJob(h.store.jobs.get(manual.id), { note: 'Đã xếp xong' });
    inv('phân ca và vắng ca');

    // ── Sale gửi yêu cầu mở BO mới ──
    h.clock.set(VN('2026-10-05', '09:40'));
    const req = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 2 }, launch_date: '2026-10-07', outlet: Q3, swap_days: [1, 3, 5], swap_from: '09:00', swap_to: '11:00' })).request;
    const q3 = site('Q3');
    eq([q3.ops_status, q3.sale_id], ['planned', U.s1.id], 'BO mới ở trạng thái chờ launch, giao cho Sale tạo');
    const prep = job({ type: 'prep_kit', request_id: req.id });
    eq(prep.assignee_id, U.l1.id, 'việc chuẩn bị tự giao cho người đang trong ca (không giao cho người vắng)');
    eq(await st('s1', 'POST', '/api/hub/requests', { site_id: q3.id, need: { multicam: 1 }, launch_date: '2026-10-08' }), 409, 'BO đã có yêu cầu launch đang xử lý → không tạo trùng');
    eq(await st('s2', 'GET', `/api/hub/requests/${req.id}`), 403, 'Sale Lead khác không xem được yêu cầu của người khác');
    ok(!(await go('s2', 'GET', '/api/hub/outlets')).outlets.some((o) => o.id === q3.id), 'Sale Lead khác không thấy BO của người khác');
    ok((await go('sh', 'GET', '/api/hub/outlets')).outlets.some((o) => o.id === q3.id), 'Head of Sale thấy mọi BO');
    const req2 = (await go('s2', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-20', outlet: TD, swap_days: '2,5', swap_from: '14:00', swap_to: '16:00' })).request;
    inv('Sale gửi yêu cầu');

    // ── Logistics gán kit, gửi Tech kiểm ──
    await go('l1', 'POST', `/api/hub/requests/${req.id}/assign`, { kit_ids: [kit('K01').id, kit('K02').id] });
    eq(h.store.requests.get(req.id).status, 'preparing', 'gán kit → yêu cầu "đang chuẩn bị"');
    eq(await st('l1', 'POST', `/api/hub/requests/${req.id}/assign`, { kit_ids: [kit('K03').id] }), 409, 'gán quá số kit cần → chặn');
    eq(await st('t1', 'POST', `/api/hub/requests/${req.id}/assign`, { kit_ids: [kit('K03').id] }), 403, 'Tech không gán kit cho yêu cầu');
    await go('l1', 'POST', `/api/hub/kits/${kit('K01').id}/submit`);
    await go('l1', 'POST', `/api/hub/kits/${kit('K02').id}/submit`);
    const ck1 = job({ type: 'check_kit', kit_id: kit('K01').id }), ck2 = job({ type: 'check_kit', kit_id: kit('K02').id });
    ok(ck1.assignee_id && ck2.assignee_id && ck1.assignee_id !== ck2.assignee_id, 'hai việc kiểm kit chia cho hai Tech (ít tải nhất)');
    eq(await st('l1', 'PATCH', `/api/hub/kits/${kit('K01').id}`, { acc: { hub_sac: 2 } }), 409, 'kit đang chờ Tech kiểm thì khoá sửa thành phần');
    inv('gửi Tech kiểm');

    // Tech kiểm: K01 không đạt (Multicam hỏng) → kit sang Tech, tự gỡ khỏi yêu cầu; K02 đạt.
    await doJob(ck1, { pass: false, devices: [{ id: dev('MC01').id, ok: false, note: 'Không lên nguồn' }] });
    const k1 = kit('K01');
    eq([k1.status, k1.request_id], ['at_tech', null], 'kiểm không đạt → kit sang Tech và rời yêu cầu');
    ok(job({ type: 'repair', kit_id: k1.id }).status === 'open', 'tự sinh việc sửa cho Tech');
    ok(h.store.inbox.find({ user_id: U.l1.id, kind: 'kit_faulty' }).length >= 1, 'Logistics được báo cần gán kit khác');
    await doJob(ck2, { pass: true });
    eq(kit('K02').status, 'reserved', 'kiểm đạt → kit chờ giao');
    eq(h.store.requests.get(req.id).status, 'preparing', 'mới 1/2 kit sẵn sàng → yêu cầu vẫn đang chuẩn bị');
    eq(await st(W.uname(ck2.assignee_id), 'POST', `/api/hub/jobs/${ck2.id}/done`, { result: { pass: true } }), 409, 'bấm "xong" lần hai → báo việc đã đóng');
    inv('Tech kiểm kit');

    await go('l1', 'POST', `/api/hub/requests/${req.id}/assign`, { kit_ids: [kit('K03').id] });
    await go('l1', 'POST', `/api/hub/kits/${kit('K03').id}/submit`);
    await doJob(job({ type: 'check_kit', kit_id: kit('K03').id }), { pass: true });
    eq(h.store.requests.get(req.id).status, 'ready', 'đủ 2 kit đạt → yêu cầu sẵn sàng');
    const prepDone = h.store.jobs.get(prep.id);
    eq([prepDone.status, prepDone.done_by, prepDone.units], ['done', U.l1.id, 2], 'việc chuẩn bị tự đóng, tính điểm 2 kit cho người chuẩn bị');
    const dlv = job({ type: 'deliver', request_id: req.id });
    ok(dlv && dlv.status === 'open' && dlv.show_date === '2026-10-05', 'tự sinh việc giao và setup, hiện trước ngày launch 2 ngày');
    ok(h.store.inbox.count({ user_id: U.s1.id, ref: `req_ready:${req.id}` }) === 1, 'Sale được báo kit đã sẵn sàng');
    inv('yêu cầu sẵn sàng');

    // Tech sửa K01: thay Multicam rồi báo xong; Logistics nhận lại → sẵn sàng.
    eq(await st('l1', 'POST', `/api/hub/jobs/${job({ type: 'repair', kit_id: k1.id }).id}/done`, {}), 403, 'Logistics không làm việc sửa của Tech');
    eq(await st(W.uname(job({ type: 'repair', kit_id: k1.id }).assignee_id), 'POST', `/api/hub/jobs/${job({ type: 'repair', kit_id: k1.id }).id}/done`, { result: {} }), 409, 'kit còn thiết bị hỏng → chưa báo sửa xong được');
    await go('t1', 'PATCH', `/api/hub/kits/${k1.id}`, { remove: [dev('MC01').id], add: 'MC05' });
    await doJob(job({ type: 'repair', kit_id: k1.id }), { note: 'Thay Multicam', cause: 'Hỏng nguồn' });
    eq(kit('K01').status, 'tech_done', 'sửa xong → chờ Logistics nhận lại');
    await doJob(job({ type: 'receive_back', kit_id: k1.id }));
    eq(kit('K01').status, 'ready', 'Logistics nhận lại → kit sẵn sàng');
    eq(dev('MC01').cond, 'faulty', 'Multicam hỏng đã gỡ ra vẫn ghi hỏng (không tự sửa trạng thái)');
    inv('sửa kit');

    // ── Giao qua chuyến FO, BO xác nhận ──
    eq(await st('t1', 'POST', '/api/hub/dispatch', { job_ids: [dlv.id], fo_id: U.fo1.id }), 403, 'Tech không tạo chuyến FO');
    eq(await st('s1', 'POST', '/api/hub/dispatch', { job_ids: [dlv.id], fo_id: U.fo1.id }), 403, 'Sale không tạo chuyến FO');
    const trip1 = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [dlv.id], fo_id: U.fo1.id, office_site_id: vp.id, round_trip: true })).task;
    eq([h.store.jobs.get(dlv.id).status, h.store.jobs.get(dlv.id).task_id], ['doing', trip1.id], 'việc giao vào chuyến → đang làm');
    eq(await st('l1', 'POST', `/api/hub/jobs/${dlv.id}/done`, { result: { doc_code: 'BB01' } }), 409, 'việc đang trong chuyến FO thì không bấm xong tay');
    eq(await st('l1', 'POST', '/api/hub/dispatch', { job_ids: [dlv.id], fo_id: U.fo1.id }), 409, 'một việc không nằm trong hai chuyến');
    inv('tạo chuyến');
    const t1done = await runTrip(W, trip1.id);
    eq(t1done.status, 'completed', 'chuyến hoàn thành');
    const dlvDone = h.store.jobs.get(dlv.id);
    eq([dlvDone.status, dlvDone.done_by, dlvDone.std_min], ['done', U.fo1.id, 45], 'việc giao tự đóng sau khi BO xác nhận, điểm tính cho FO');
    eq([kit('K02').status, kit('K03').status, kit('K02').site_id], ['at_bo', 'at_bo', q3.id], 'kit đang quay tại BO');
    const q3b = site('Q3');
    eq([q3b.ops_status, q3b.onboard_date], ['live', '2026-10-05'], 'BO bắt đầu ghi hình, ghi ngày onboard');
    eq(h.store.requests.get(req.id).status, 'live', 'yêu cầu chuyển "đang ghi hình"');
    inv('giao xong qua FO');

    // ── Lịch đổi thẻ: thứ Sáu ──
    await W.dayShift(['2026-10-09', '2026-10-12']); // không có ca đã duyệt thì không vào ca, không được tự giao việc
    h.clock.set(VN('2026-10-09', '08:40'));
    seen('l1', 'l2', 't1', 't2');
    tick(); tick(); tick();
    eq(jobs({ type: 'card_swap', site_id: q3.id, date: '2026-10-09' }).length, 1, 'nhịp định kỳ chạy 3 lần vẫn chỉ 1 việc đổi thẻ');
    eq(jobs({ type: 'stock_check', date: '2026-10-09' }).length, 1, 'thứ Sáu: 1 việc kiểm kho (không trùng)');
    eq(jobs({ type: 'card_swap', site_id: q3.id, date: '2026-10-07' }).length, 0, 'không đổi thẻ vào ngày launch');
    const sw1 = job({ type: 'card_swap', site_id: q3.id, date: '2026-10-09' });
    eq(sw1.due_at, VN('2026-10-09', '11:00'), 'hạn đổi thẻ = cuối khung giờ của BO');
    await doJob(sw1, { cards_out: ['SD01', 'SD02', 'SD03', 'SD04'], cards_in: [] });
    eq(['SD01', 'SD02', 'SD03', 'SD04'].map((c) => card(c).status), ['at_bo', 'at_bo', 'at_bo', 'at_bo'], 'thẻ mới sang "đang ở BO"');
    eq(await st(W.uname(sw1.assignee_id), 'POST', `/api/hub/jobs/${job({ type: 'stock_check' }).id}/done`, { result: { diff: 'Thiếu 1 hub sạc ở kệ' } }), 200, 'kiểm kho có chênh lệch');
    ok(h.store.recon.count({ source: 'stock_check', status: 'open' }) === 1, 'chênh lệch kiểm kho vào Đối chiếu, không tự sửa');
    inv('đổi thẻ thứ Sáu');

    // ── Sự cố do Sale báo → Tech xử lý → Logistics đổi kit ──
    eq(await st('s2', 'POST', '/api/hub/incidents', { site_id: q3.id, kit_id: kit('K02').id, label: 'Không ghi hình', text: 'Máy không lên hình' }), 403, 'Sale Lead khác không báo sự cố ở BO không thuộc mình');
    const inc = (await go('s1', 'POST', '/api/hub/incidents', { site_id: q3.id, kit_id: kit('K02').id, label: 'Không ghi hình', text: 'Máy không lên hình từ sáng' })).incident;
    const dupInc = await go('s1', 'POST', '/api/hub/incidents', { site_id: q3.id, kit_id: kit('K02').id, label: 'Không ghi hình', text: 'Vẫn chưa lên hình' });
    eq([dupInc.duplicate, jobs({ type: 'incident' }).length], [true, 1], 'báo lại cùng lỗi cùng kit → gộp vào sự cố cũ, không tạo việc mới');
    const incJob = job({ type: 'incident', incident_id: inc.id });
    eq(await st('l1', 'POST', `/api/hub/incidents/${inc.id}/ack`), 403, 'Logistics không nhận xử lý sự cố của Tech');
    const techU = W.uname(incJob.assignee_id);
    await go(techU, 'POST', `/api/hub/incidents/${inc.id}/ack`);
    await go(techU, 'POST', `/api/hub/incidents/${inc.id}/resolve`, { resolution: 'swap', note: 'Cần đổi kit, mang về sửa' });
    eq(h.store.incidents.get(inc.id).status, 'resolved', 'Tech xử lý xong sự cố');
    const swf = job({ type: 'swap_faulty', kit_id: kit('K02').id });
    ok(swf && swf.status === 'open' && swf.incident_id === inc.id, 'tự sinh việc đổi kit hỏng cho Logistics');
    ok(h.store.inbox.count({ user_id: U.s1.id, ref: `inc_done:${inc.id}` }) === 1, 'Sale được báo sự cố đã xử lý');
    inv('xử lý sự cố');

    // ── Thứ Hai tuần sau: một chuyến FO vừa đổi thẻ vừa đổi kit hỏng; BO báo lệch số thẻ ──
    h.clock.set(VN('2026-10-12', '08:40'));
    seen('l1', 'l2', 't1', 't2');
    tick();
    const sw2 = job({ type: 'card_swap', site_id: q3.id, date: '2026-10-12' });
    ok(sw2 && sw2.status === 'open', 'việc đổi thẻ thứ Hai được tạo');
    eq(await st('l1', 'POST', '/api/hub/dispatch', { job_ids: [sw2.id, swf.id], fo_id: U.fo1.id, office_site_id: vp.id, round_trip: true, swap_kits: { [swf.id]: kit('K04').id }, cards_out: { [q3.id]: ['SD05', 'SD06', 'SD07', 'SD08'] } }), 409, 'kit thay thế chưa kiểm đạt → không cho vào chuyến');
    eq(await st('l1', 'POST', '/api/hub/dispatch', { job_ids: [sw2.id, swf.id], fo_id: U.fo1.id, office_site_id: vp.id, round_trip: true, swap_kits: { [swf.id]: kit('K01').id } }), 400, 'chuyến đổi thẻ không có mã thẻ mới → không cho vào chuyến');
    const trip2 = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [sw2.id, swf.id], fo_id: U.fo1.id, office_site_id: vp.id, round_trip: true, swap_kits: { [swf.id]: kit('K01').id }, cards_out: { [q3.id]: ['SD05', 'SD06', 'SD07', 'SD08'] } })).task;
    const boStop = h.store.stops.find({ task_id: trip2.id, site_id: q3.id }, { limit: 1 })[0];
    eq([boStop.exp_cards_out, boStop.exp_cards_in, boStop.exp_dev_out, boStop.exp_dev_in], [4, 4, 1, 1], 'điểm BO: giao 4 thẻ, thu 4 thẻ, giao 1 kit, thu 1 kit');
    inv('tạo chuyến đổi thẻ + đổi kit');
    await W.go('fo1', 'POST', `/api/tasks/${trip2.id}/accept`);
    await W.go('fo1', 'POST', `/api/tasks/${trip2.id}/start`);
    eq([kit('K01').status, card('SD05').status], ['delivering', 'with_fo'], 'FO bắt đầu chuyến → kit thay và thẻ mới đang đi');
    inv('FO bắt đầu chuyến');
    const t2done = await runTrip(W, trip2.id, { [boStop.seq]: { bo: { cards_given: 3 } } }, { started: true });
    eq(t2done.status, 'completed', 'chuyến 2 hoàn thành');
    // BO báo lệch số thẻ: kit đổi khớp số nên tự đóng; việc đổi thẻ giữ lại, thẻ chưa chuyển cho tới khi Logistic Lead đối chiếu.
    eq([h.store.jobs.get(sw2.id).status, h.store.jobs.get(swf.id).status], ['open', 'done'], 'việc đổi kit tự đóng; việc đổi thẻ (số thẻ lệch) giữ lại');
    eq([kit('K01').status, kit('K01').site_id, kit('K02').status], ['at_bo', q3.id, 'recovering'], 'kit thay đang quay tại BO, kit hỏng đang được mang về');
    eq(['SD05', 'SD08', 'SD01', 'SD04'].map((c) => card(c).status), ['office', 'office', 'at_bo', 'at_bo'], 'số thẻ lệch → không tự chuyển thẻ');
    ok(h.store.recon.count({ source: 'bo_confirm', status: 'open' }) === 1, 'BO báo lệch số → vào Đối chiếu của Logistics');
    eq(await st('l1', 'POST', `/api/hub/jobs/${sw2.id}/done`, { result: { cards_out: ['SD05', 'SD06', 'SD07', 'SD08'], cards_in: ['SD01', 'SD02', 'SD03', 'SD04'] } }), 403, 'việc chờ đối chiếu chỉ Logistic Lead chốt');
    await go('ll', 'POST', `/api/hub/jobs/${sw2.id}/done`, { result: { cards_out: ['SD05', 'SD06', 'SD07', 'SD08'], cards_in: ['SD01', 'SD02', 'SD03', 'SD04'] }, credit_assignee: true }); // gọi BO đếm lại: BO đếm thiếu; điểm vẫn tính cho người giữ việc
    eq(['SD05', 'SD08'].map((c) => card(c).status), ['at_bo', 'at_bo'], 'Lead chốt: thẻ mới ở BO');
    eq(['SD01', 'SD04'].map((c) => card(c).status), ['returned', 'returned'], 'Lead chốt: thẻ cũ về văn phòng');
    eq(h.store.recon.count({ source: 'bo_confirm', status: 'open' }), 0, 'Lead làm tay xong → dòng Đối chiếu tự đóng');
    ok(job({ type: 'qr_change', site_id: q3.id }) && job({ type: 'qr_change', site_id: q3.id }).status === 'open', 'đổi kit làm đổi mã CM5 → tự sinh việc đổi QR cho Tech');
    ok(job({ type: 'receive_field', kit_id: kit('K02').id }).status === 'open', 'tự sinh việc nhận kit hỏng về kho');
    inv('chuyến đổi thẻ + đổi kit');

    // Nhận kit hỏng về kho: thiếu 1 hub sạc → trừ tổng kho, vào Đối chiếu; kit có lỗi → sang Tech sửa.
    const hubBefore = h.store.dev_types.get('hub_sac').total;
    await doJob(job({ type: 'receive_field', kit_id: kit('K02').id }), { acc: { hub_sac: 0, day_gan: 1, cap_c_c: 1 } });
    eq(h.store.dev_types.get('hub_sac').total, hubBefore - 1, 'thiếu khi thu hồi → tổng hub sạc giảm 1 (sổ kho ghi "mất")');
    eq(kit('K02').acc.hub_sac || 0, 0, 'phụ kiện của kit cập nhật theo số thực nhận');
    ok(h.store.recon.count({ source: 'acc_recover', status: 'open' }) === 1, 'thiếu phụ kiện vào Đối chiếu để làm việc với BO');
    eq(kit('K02').status, 'at_tech', 'kit đang có lỗi → sang Tech sửa');
    inv('nhận kit hỏng');
    await doJob(job({ type: 'repair', kit_id: kit('K02').id }), { note: 'Vệ sinh cảm biến' });
    await doJob(job({ type: 'receive_back', kit_id: kit('K02').id }));
    await doJob(job({ type: 'qr_change', site_id: q3.id }), { note: 'Đã đổi QR' });
    eq(kit('K02').status, 'ready', 'kit sửa xong về kho sẵn sàng');
    inv('sửa kit hỏng');

    // ── Thẻ: Logistics gửi Tech, Tech nhận thiếu 1 thẻ, nhập dung lượng, trả về ──
    eq(await st('t1', 'POST', '/api/hub/handovers', { dir: 'to_tech', codes: ['SD01'] }), 403, 'phiếu gửi Tech do Logistics lập');
    const ho = (await go('l1', 'POST', '/api/hub/handovers', { dir: 'to_tech', codes: ['SD01', 'SD02', 'SD03', 'SD04'] })).handover;
    eq(card('SD01').status, 'to_tech', 'thẻ vào phiếu → đang bàn giao');
    eq(await st('l1', 'POST', `/api/hub/handovers/${ho.id}/receive`, { all: true }), 403, 'bên gửi không tự xác nhận nhận phiếu');
    eq(await st('t1', 'POST', `/api/hub/handovers/${ho.id}/receive`, { codes: ['SD01', 'SD02', 'SD03'] }), 400, 'nhận thiếu thẻ mà không ghi lý do → chặn');
    await go('t1', 'POST', `/api/hub/handovers/${ho.id}/receive`, { codes: ['SD01', 'SD02', 'SD03'], missing_reason: 'Túi thẻ chỉ có 3 thẻ' });
    eq([card('SD03').status, card('SD04').status], ['at_tech', 'returned'], 'thẻ thiếu trả về bên gửi');
    ok(h.store.recon.count({ source: 'handover', status: 'open', team: 'logistics' }) === 1, 'thẻ thiếu vào Đối chiếu của Logistics');
    eq(await st('t1', 'POST', `/api/hub/handovers/${ho.id}/receive`, { all: true }), 409, 'phiếu đã xác nhận thì khoá');
    const up = job({ type: 'cards_upload', handover_id: ho.id });
    eq([up.assignee_id, up.units], [U.t1.id, 3], 'việc nhập dung lượng giao cho người nhận phiếu, 3 thẻ');
    eq(await st('l1', 'POST', '/api/hub/cards/records', { records: [{ card_id: card('SD01').id, gb: 10 }] }), 403, 'Logistics không nhập dung lượng');
    await go('t1', 'POST', '/api/hub/cards/records', { records: [
      { card_id: card('SD01').id, gb: 84.5, shoot_date: '2026-10-10' },
      { card_id: card('SD02').id, gb: 0, shoot_date: '2026-10-10', zero_reason: 'BO không bật máy' },
      { card_id: card('SD03').id, gb: 50.7, shoot_date: '2026-10-11' },
    ] });
    eq(h.store.jobs.get(up.id).status, 'done', 'nhập đủ thẻ của phiếu → việc nhập tự đóng');
    eq(h.store.card_records.find({ code: 'SD01' })[0].hours, 5, '84,5 GB ÷ 16,9 GB/giờ = 5 giờ quay');
    ok(h.store.inbox.count({ user_id: U.s1.id, kind: 'zero_hour' }) === 1, 'Sale phụ trách được báo thẻ 0 giờ');
    eq(await st('t1', 'POST', '/api/hub/cards/records', { records: [{ card_id: card('SD01').id, gb: 1 }] }), 409, 'thẻ đã nhập thì không nhập lại');
    const back = (await go('t1', 'POST', '/api/hub/handovers', { dir: 'to_log', codes: ['SD01', 'SD02', 'SD03'] })).handover;
    await go('l2', 'POST', `/api/hub/handovers/${back.id}/receive`, { all: true });
    eq([card('SD01').status, card('SD01').site_id], ['office', null], 'Tech trả thẻ → thẻ sẵn sàng tại VP');
    inv('vòng thẻ nhớ');

    // ── Hỗ trợ: bổ sung phụ kiện (đủ kho, rồi thiếu kho) ──
    const sup = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'extra_acc', acc: { headstrap: 2 }, kit_id: kit('K03').id, note: 'Thiếu headstrap' })).request;
    const da = job({ type: 'deliver_acc', request_id: sup.id });
    ok(da && da.status === 'open', 'tự sinh việc giao phụ kiện cho Logistics');
    await doJob(da);
    eq([kit('K03').acc.headstrap, h.store.requests.get(sup.id).status], [2, 'closed'], 'giao xong → phụ kiện cộng vào kit, yêu cầu tự đóng');
    const sup2 = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'extra_acc', acc: { headstrap: 50 }, kit_id: kit('K03').id, note: 'Đổi toàn bộ headstrap' })).request;
    ok(h.store.inbox.count({ user_id: U.ll.id, kind: 'acc_short' }) === 1, 'kho thiếu → báo Logistic Lead ngay khi Sale gửi');
    const da2 = job({ type: 'deliver_acc', request_id: sup2.id });
    eq(await st(W.uname(da2.assignee_id), 'POST', `/api/hub/jobs/${da2.id}/done`, { result: {} }), 409, 'kho không đủ → không cho báo đã giao (số tồn không âm)');
    await go('ll', 'POST', '/api/hub/acc/headstrap/move', { kind: 'in', qty: 50, reason: 'Mua thêm 50 headstrap' });
    await doJob(da2);
    eq(kit('K03').acc.headstrap, 52, 'nhập thêm rồi giao được');
    inv('hỗ trợ phụ kiện');

    // ── Sổ phụ kiện ──
    eq(await st('l1', 'POST', '/api/hub/acc/headstrap/move', { kind: 'out', qty: 100000, reason: 'Thử ghi giảm quá tổng' }), 409, 'ghi giảm quá tổng → chặn');
    const free = (await go('l1', 'GET', '/api/hub/acc')).acc.find((a) => a.id === 'headstrap').free;
    eq(await st('l1', 'POST', '/api/hub/acc/headstrap/move', { kind: 'out', qty: free + 1, reason: 'Thử ghi giảm phần đang trong kit' }), 409, 'ghi giảm phần đang nằm trong kit → chặn');
    eq(await st('l1', 'POST', '/api/hub/acc/headstrap/move', { kind: 'out', qty: 1 }), 400, 'ghi giảm phải có lý do');
    eq(await st('s1', 'POST', '/api/hub/acc/headstrap/move', { kind: 'in', qty: 1, reason: 'Sale thử' }), 403, 'Sale không sửa kho');
    eq(await st('t1', 'POST', '/api/hub/acc/headstrap/move', { kind: 'in', qty: 1, reason: 'Tech thử' }), 403, 'Tech không sửa sổ phụ kiện');
    await go('l1', 'POST', '/api/hub/acc/headstrap/move', { kind: 'count', free_counted: free - 1, reason: 'Kiểm kê cuối tuần' });
    eq((await go('l1', 'GET', '/api/hub/acc')).acc.find((a) => a.id === 'headstrap').free, free - 1, 'kiểm kê: số rảnh bằng số đếm được');
    await go('l1', 'PATCH', `/api/hub/kits/${kit('K04').id}`, { acc: { day_gan: 1, cap_c_c: 1 }, acc_writeoff: true, acc_reason: 'Hub sạc hỏng, thanh lý' });
    const lastMove = h.store.acc_moves.find({ type_id: 'hub_sac' }, { order: 'id', desc: true, limit: 1 })[0];
    eq([lastMove.kind, lastMove.delta, lastMove.kit_id], ['out', -1, kit('K04').id], 'bớt phụ kiện hỏng khỏi kit → ghi giảm tổng, có kit và lý do');
    const moves = (await go('l1', 'GET', '/api/hub/acc/hub_sac/moves')).moves;
    ok(moves.length >= 3 && moves.every((m) => m.kind_label && m.by), 'sổ hub sạc có đủ dòng, có loại và người ghi');
    inv('sổ phụ kiện');

    // ── Head of Sale: quota, dashboard ──
    eq(await st('s2', 'PATCH', `/api/hub/outlets/${q3.id}`, { quota_hours: 5 }), 403, 'Sale Lead khác không sửa BO của người khác');
    await go('sh', 'PATCH', `/api/hub/outlets/${q3.id}`, { quota_hours: 9, lat: 1, lon: 1 });
    eq([site('Q3').quota_hours, site('Q3').lat], [9, Q3.lat], 'Head of Sale sửa quota; toạ độ (của Logistics) không đổi');
    const hs = await go('sh', 'GET', '/api/hub/sale');
    eq(hs.hos.kpi.live, 1, 'HoS: 1 BO đang ghi hình');
    eq(hs.hos.kpi.quota.near, 1, 'HoS: BO dùng 88% quota → sắp chạm');
    ok(hs.hos.by_sale.some((r) => r.sale.id === U.s1.id && r.live === 1) && hs.hos.by_sale.some((r) => r.sale.id === U.s2.id && r.waiting === 1), 'HoS: theo từng Sale Lead (BO đang quay, BO chờ active)');
    ok(hs.hos.onboard_by_month.length === 12, 'HoS: onboard 12 tháng');
    const s2v = await go('s2', 'GET', '/api/hub/sale');
    ok(!s2v.hos.outlets.some((o) => o.id === q3.id), 'Sale Lead chỉ thấy BO của mình trên bảng Sale');
    await go('sh', 'PATCH', `/api/hub/outlets/${q3.id}`, { quota_hours: 7 });
    const ovSh = await go('sh', 'GET', '/api/hub/overview');
    ok(ovSh.watch.some((w) => w.kind === 'quota_over'), 'HoS thấy BO vượt quota trong danh sách theo dõi');
    eq(Object.keys(ovSh.top3), [], 'HoS không thấy top 3 / hiệu suất cá nhân của Tech và Logistics');
    const ovTl = await go('tl', 'GET', '/api/hub/overview');
    ok(!ovTl.watch.some((w) => w.team === 'sale' || w.team === 'logistics' && w.kind !== 'kit_fault'), 'Tech Lead chỉ thấy việc cần theo dõi của Tech');
    eq(Object.keys(ovTl.top3), ['tech'], 'Tech Lead chỉ thấy top 3 của Tech');
    const ovLl = await go('ll', 'GET', '/api/hub/overview');
    eq(Object.keys(ovLl.top3), ['logistics'], 'Logistic Lead chỉ thấy top 3 của Logistics');
    ok(!ovLl.watch.some((w) => w.kind === 'quota_over' || w.kind === 'quota_near'), 'quota là số của Sale, Logistics không thấy');
    inv('bảng Head of Sale');

    // ── Kết thúc ghi hình, thu hồi ──
    const endReq = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, {})).request;
    eq(site('Q3').ops_status, 'ending', 'BO đang thu hồi');
    ok(!jobs({ type: 'card_swap', site_id: q3.id, status: 'open' }).length, 'việc đổi thẻ còn lại của BO tự huỷ');
    const rec = job({ type: 'recover', request_id: endReq.id });
    await doJob(rec, { acc_by_kit: { [kit('K01').id]: acc1, [kit('K03').id]: { ...acc1, headstrap: 52 } } });
    eq([kit('K01').status, kit('K03').status, kit('K01').site_id], ['returned', 'returned', null], 'kit thu về → chờ Tech check-in');
    eq(site('Q3').ops_status, 'ended', 'thu hết kit → BO kết thúc');
    eq([h.store.requests.get(req.id).status, h.store.requests.get(endReq.id).status], ['closed', 'closed'], 'yêu cầu launch và kết thúc đều đóng');
    eq(card('SD05').status, 'returned', 'thẻ còn ở BO được thu về');
    inv('thu hồi');
    for (const code of ['K01', 'K03']) { await doJob(job({ type: 'checkin', kit_id: kit(code).id }), { pass: true }); await doJob(job({ type: 'receive_back', kit_id: kit(code).id })); }
    eq([kit('K01').status, kit('K03').status], ['ready', 'ready'], 'check-in đạt, Logistics nhận lại → sẵn sàng');
    inv('check-in sau thu hồi');

    // ── Hiệu suất: chỉ Lead của team xem bảng team; nhân viên xem dòng của mình ──
    const pl = await go('ll', 'GET', '/api/hub/perf', null, { period: 'week', key: '2026-W42' });
    ok(pl.rows.some((r) => r.user.id === U.l1.id && r.points > 0), 'Logistic Lead thấy điểm của Log Một tuần W42');
    ok(pl.fo && pl.fo.rows.some((r) => r.user.id === U.fo1.id && r.stops_done >= 1), 'bảng Logistics có phần FO (điểm giao nhận xong)');
    eq(await st('ll', 'GET', '/api/hub/perf', null, { team: 'tech' }), 403, 'Logistic Lead không xem bảng Tech');
    eq(await st('tl', 'GET', '/api/hub/perf', null, { team: 'logistics' }), 403, 'Tech Lead không xem bảng Logistics');
    eq(await st('t1', 'GET', '/api/hub/perf'), 403, 'Tech Executive không xem bảng cả team');
    eq(await st('sh', 'GET', '/api/hub/perf'), 403, 'Head of Sale không xem hiệu suất cá nhân của team khác');
    const me = await go('t1', 'GET', '/api/hub/perf/me', null, { period: 'week', key: '2026-W42' });
    ok(me.me && me.me.user.id === U.t1.id && !('rows' in me), 'Tech Executive chỉ thấy dòng của mình');
    ok(Number.isInteger(me.members) && typeof me.in_top3 === 'boolean', 'hiệu suất của tôi gửi số người trong team và cờ Top 3');
    ok(me.members >= 3 ? !!me.team_avg : me.team_avg === null, `team ${me.members} người: ${me.members >= 3 ? 'có' : 'không gửi'} trung bình team (dưới 3 người thì trung bình làm lộ số của người kia)`);
    const pt = await go('tl', 'GET', '/api/hub/perf', null, { period: 'week', key: '2026-W42' });
    ok(pt.rows.find((r) => r.user.id === U.t1.id).uploads === 3, 'Tech: 3 thẻ đã nhập được tính điểm cho người nhập');
    inv('hiệu suất');
  });

  await group('Bảo mật giữa 3 team: vị trí FO, việc, kho, ảnh', async () => {
    const W = await world(kind);
    const { h, U, go, st } = W;
    const vp = (await go('ll', 'POST', '/api/sites', VP)).site;
    await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-07', outlet: Q3 });
    for (const who of ['s1', 'sh']) {
      for (const [m, p] of [['GET', '/api/live'], ['GET', '/api/history'], ['GET', '/api/tasks'], ['GET', '/api/sites'], ['GET', '/api/stats'], ['GET', '/api/hub/jobs'], ['GET', '/api/hub/kits'], ['GET', '/api/hub/cards'], ['GET', '/api/hub/handovers'], ['GET', '/api/hub/roster'], ['POST', '/api/hub/dispatch']]) {
        eq(await st(who, m, p, {}), 403, `${who === 's1' ? 'Sale Lead' : 'Head of Sale'} bị chặn ${m} ${p}`);
      }
    }
    for (const [m, p] of [['GET', '/api/live'], ['GET', '/api/history'], ['GET', '/api/tasks']]) eq(await st('t1', m, p), 403, `Tech bị chặn ${p} (vị trí FO chỉ Logistics thấy)`);
    eq(await st('fo1', 'GET', '/api/hub/ping'), 403, 'FO không vào Ops Hub');
    // Kênh thời gian thực: Sale và Tech không nhận vị trí FO.
    const got = { s1: [], t1: [], l1: [] };
    for (const u of Object.keys(got)) h.core.subscribe(h.byName(u), (m) => got[u].push(m));
    await go('fo1', 'POST', '/api/shift', { on: true });
    h.core.ingest(U.fo1.id, { ts: h.clock.now(), lat: 10.78, lon: 106.69, acc: 5 });
    h.clock.add(20000);
    h.core.ingest(U.fo1.id, { ts: h.clock.now(), lat: 10.781, lon: 106.691, acc: 5 });
    h.core.flushPositions && h.core.flushPositions();
    const posMsg = (list) => list.filter((m) => ['pos', 'fo', 'shift'].includes(m.t)).length;
    ok(posMsg(got.l1) > 0, 'Logistics nhận vị trí FO theo thời gian thực');
    eq([posMsg(got.s1), posMsg(got.t1)], [0, 0], 'Sale và Tech không nhận gói vị trí FO nào');
    ok(!JSON.stringify(got.s1).includes('10.78'), 'không gói nào gửi Sale có toạ độ FO');
    // Sale xem BO / yêu cầu của mình: không có việc, chuyến, người làm.
    const o = await go('s1', 'GET', `/api/hub/outlets/${W.site('Q3').id}`);
    eq(o.jobs, [], 'Sale xem BO: không kèm danh sách việc nội bộ');
    const r = h.store.requests.find({})[0];
    const rv = await go('s1', 'GET', `/api/hub/requests/${r.id}`);
    eq([rv.jobs, rv.candidates], [[], []], 'Sale xem yêu cầu: không kèm việc và kit trong kho');
    eq(await st('s1', 'GET', `/api/hub/jobs/${h.store.jobs.find({})[0].id}`), 403, 'Sale không mở chi tiết việc');
    // Tech chỉ thấy hàng việc của Tech.
    const tj = await go('t1', 'GET', '/api/hub/jobs', null, { view: 'team' });
    ok(tj.jobs.every((j) => j.team === 'tech'), 'Tech chỉ thấy việc của team Tech');
    const lj = await go('ll', 'GET', '/api/hub/jobs', null, { view: 'team' });
    ok(lj.jobs.every((j) => j.team === 'logistics'), 'Logistics chỉ thấy việc của team Logistics');
    // Ảnh giao nhận của FO (có thể lộ nơi chụp) chỉ Logistics xem.
    await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: 'MC01' });
    const task = (await go('l1', 'POST', '/api/tasks', { fo_id: U.fo1.id, stops: [{ site_id: vp.id }] })).task;
    await go('fo1', 'POST', `/api/tasks/${task.id}/start`);
    const stop = h.store.stops.find({ task_id: task.id })[0];
    await go('fo1', 'POST', `/api/stops/${stop.id}/proof`, { photos: [JPEG] });
    const ph = h.store.photos.find({ stop_id: stop.id })[0];
    eq([await st('s1', 'GET', `/api/photo/${ph.id}`), await st('t1', 'GET', `/api/photo/${ph.id}`), await st('l1', 'GET', `/api/photo/${ph.id}`)], [403, 403, 200], 'ảnh giao nhận: Sale 403, Tech 403, Logistics xem được');
    // Đổi vai trò / khoá: tài khoản Sale không tạo được tài khoản Logistics.
    eq(await st('s1', 'POST', '/api/users', { username: 'x1', name: 'X', role: 'logistic' }), 403, 'Sale không tạo tài khoản');
    eq(await st('ll', 'POST', '/api/users', { username: 'x2', name: 'X', role: 'tech' }), 403, 'Logistic Lead không tạo tài khoản Tech');
  });

  await group('Chuyến FO không giao được, chuyến bị huỷ: việc và kit trở về đúng chỗ', async () => {
    const W = await world(kind);
    const { h, U, go, st, seen, inv, job, kit, card, site } = W;
    const vp = (await go('ll', 'POST', '/api/sites', VP)).site;
    await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: 'MC01 MC02' });
    await go('ll', 'POST', '/api/hub/devices', { type: 'cm5', codes: 'CM01 CM02' });
    await go('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: 'SD01 SD02' });
    await go('l1', 'POST', '/api/hub/kits', { code: 'K01', kind: 'multicam', devices: 'MC01 CM01' });
    await W.dayShift(['2026-10-05'], ['l1', 't1']);
    seen('l1', 't1');
    const req = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-06', outlet: Q3 })).request;
    await go('l1', 'POST', `/api/hub/requests/${req.id}/assign`, { kit_ids: [kit('K01').id] });
    await go('l1', 'POST', `/api/hub/kits/${kit('K01').id}/submit`);
    await W.doJob(job({ type: 'check_kit' }), { pass: true });
    const dlv = job({ type: 'deliver', request_id: req.id });
    // Chuyến 1: FO không giao được.
    const tA = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [dlv.id], fo_id: U.fo1.id })).task;
    const stopA = h.store.stops.find({ task_id: tA.id })[0];
    await runTrip(W, tA.id, { [stopA.seq]: { fail: 'BO đóng cửa' } });
    eq([h.store.jobs.get(dlv.id).status, h.store.jobs.get(dlv.id).task_id, kit('K01').status], ['open', null, 'reserved'], 'không giao được → việc trở lại chờ, kit về "chờ giao"');
    eq(site('Q3').ops_status, 'planned', 'BO chưa ghi hình');
    inv('điểm không giao được');
    // Chuyến 2: huỷ giữa chừng (FO đã bắt đầu, kit đang đi).
    const tB = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [dlv.id], fo_id: U.fo1.id })).task;
    await go('fo1', 'POST', `/api/tasks/${tB.id}/start`);
    eq(kit('K01').status, 'delivering', 'kit đang đi');
    await go('l1', 'POST', `/api/tasks/${tB.id}/cancel`, { reason: 'Xe hỏng giữa đường' });
    eq([h.store.jobs.get(dlv.id).status, kit('K01').status], ['open', 'reserved'], 'huỷ chuyến → việc trở lại chờ, kit về kho');
    inv('huỷ chuyến đang chạy');
    // Chuyến 3: huỷ trước khi FO bắt đầu, có thẻ đã chọn.
    await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-20', outlet: TD });
    h.store.sites.update(site('Q3').id, { ops_status: 'live', swap_days: '1,2,3,4,5,6,7', launch_date: '2026-10-01' });
    h.store.kits.update(kit('K01').id, { status: 'at_bo', site_id: site('Q3').id });
    h.store.requests.update(req.id, { status: 'live' });
    h.store.jobs.update(dlv.id, { status: 'done', done_at: h.clock.now() });
    W.tick();
    const sw = job({ type: 'card_swap', site_id: site('Q3').id });
    const tC = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [sw.id], fo_id: U.fo1.id, cards_out: { [site('Q3').id]: ['SD01'] } })).task;
    eq(card('SD01').task_id, tC.id, 'thẻ đã chọn gắn với chuyến');
    await go('l1', 'POST', `/api/tasks/${tC.id}/cancel`, { reason: 'Đổi lịch' });
    eq([card('SD01').status, card('SD01').task_id, h.store.jobs.get(sw.id).status], ['office', null, 'open'], 'huỷ trước khi đi → thẻ rời chuyến, việc trở lại chờ');
    inv('huỷ chuyến chưa bắt đầu');
    // Gỡ việc khỏi chuyến (Logistics tự làm) rồi làm tay.
    eq(await st('l1', 'POST', '/api/hub/dispatch', { job_ids: [sw.id], fo_id: U.fo1.id }), 400, 'chuyến đổi thẻ phải có mã thẻ mới');
    const tD = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [sw.id], fo_id: U.fo1.id, cards_out: { [site('Q3').id]: ['SD02'] } })).task;
    eq(await st('l1', 'POST', `/api/hub/jobs/${sw.id}/release`, { reason: 'Tự đi' }), 409, 'việc đang trong chuyến thì không trả việc');
    await go('l1', 'POST', `/api/tasks/${tD.id}/cancel`, { reason: 'Logistics tự đi' });
    await W.doJob(h.store.jobs.get(sw.id), { cards_out: ['SD01', 'SD02'] });
    eq(card('SD02').status, 'at_bo', 'làm tay sau khi huỷ chuyến');
    inv('làm tay sau khi huỷ chuyến');
  });

  await group('Hạn xử lý: tính từ lúc nhận, báo vướng tạm dừng, cảnh báo Lead không lặp', async () => {
    const W = await world(kind);
    const { h, U, go, st, seen, inv, job, kit } = W;
    await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: 'MC01' });
    await go('ll', 'POST', '/api/hub/devices', { type: 'cm5', codes: 'CM01' });
    await go('l1', 'POST', '/api/hub/kits', { code: 'K01', kind: 'multicam', devices: 'MC01 CM01' });
    await go('l1', 'POST', `/api/hub/kits/${kit('K01').id}/submit`);
    const ck = job({ type: 'check_kit' });
    eq([ck.assignee_id, ck.due_at], [null, null], 'chưa ai trong ca → việc để chung, chưa tính hạn');
    await W.dayShift(['2026-10-05', '2026-10-06'], ['t1']); // t1 có ca cả hai ngày: việc chưa bắt đầu không bị trả về khi sang ngày
    h.clock.add(30 * MIN);
    seen('t1');
    const ck2 = h.store.jobs.get(ck.id);
    eq(ck2.assignee_id, U.t1.id, 'có người vào ca → tự giao');
    eq(ck2.due_at, h.clock.now() + 24 * HOUR, 'hạn tính từ lúc có người nhận');
    await go('t1', 'POST', `/api/hub/jobs/${ck.id}/block`, { reason: 'Chờ cáp thay thế' });
    eq(await st('t1', 'POST', `/api/hub/jobs/${ck.id}/block`, { reason: 'lặp' }), 409, 'báo vướng lần hai → chặn');
    h.clock.add(3 * HOUR);
    await go('t1', 'POST', `/api/hub/jobs/${ck.id}/unblock`, {});
    eq(h.store.jobs.get(ck.id).due_at, ck2.due_at + 3 * HOUR, 'gỡ vướng → hạn cộng thêm thời gian vướng');
    h.clock.add(30 * HOUR);
    seen('t1'); // hôm sau t1 vào ca, vẫn giữ việc
    for (let i = 0; i < 5; i++) W.tick();
    eq(h.store.inbox.count({ user_id: U.t1.id, ref: `due:${ck.id}` }), 1, 'quá hạn: báo người làm đúng 1 lần dù nhịp chạy nhiều lần');
    eq(h.store.inbox.count({ user_id: U.tl.id, ref: `lead:${ck.id}` }), 1, 'quá hạn lâu: báo Tech Lead đúng 1 lần');
    await W.doJob(h.store.jobs.get(ck.id), { pass: true });
    const done = h.store.jobs.get(ck.id);
    ok(done.done_at > done.due_at, 'việc xong trễ hạn được ghi nhận trễ');
    inv('hạn xử lý');
  });

  await group('Tạm nghỉ theo lịch Sale: BO tự chuyển tạm nghỉ rồi quay lại; không mở yêu cầu launch khi máy còn ở BO', async () => {
    const W = await world(kind);
    const { h, go, st, seen, tick, inv, job, jobs, kit, site } = W;
    await go('ll', 'POST', '/api/sites', VP);
    await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: 'MC01' });
    await go('ll', 'POST', '/api/hub/devices', { type: 'cm5', codes: 'CM01' });
    await go('l1', 'POST', '/api/hub/kits', { code: 'K01', kind: 'multicam', devices: 'MC01 CM01' });
    await W.dayShift(['2026-10-05'], ['l1', 't1']);
    seen('l1', 't1');
    const req = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-05', outlet: Q3, swap_days: '1,2,3,4,5,6', swap_from: '09:00', swap_to: '11:00' })).request;
    await go('l1', 'POST', `/api/hub/requests/${req.id}/assign`, { kit_ids: [kit('K01').id] });
    await go('l1', 'POST', `/api/hub/kits/${kit('K01').id}/submit`);
    await W.doJob(job({ type: 'check_kit' }), { pass: true });
    await W.doJob(job({ type: 'deliver', request_id: req.id }), { doc_code: 'BB-01' });
    tick();
    eq([site('Q3').ops_status, jobs({ type: 'card_swap', status: 'open' }).map((j) => j.date)], ['live', ['2026-10-06', '2026-10-07']], 'BO đang ghi hình, có việc đổi thẻ 2 ngày tới');
    await go('s1', 'PATCH', `/api/hub/outlets/${site('Q3').id}`, { pause_from: '2026-10-07', pause_to: '2026-10-08' });
    eq(jobs({ type: 'card_swap', status: 'open' }).map((j) => j.date), ['2026-10-06'], 'Sale đặt lịch tạm nghỉ → việc đổi thẻ trong khoảng tạm nghỉ huỷ');
    h.clock.set(Date.parse('2026-10-07T01:00:00Z')); tick();
    eq(site('Q3').ops_status, 'paused', 'tới ngày tạm nghỉ → BO tự chuyển "tạm nghỉ"');
    eq(jobs({ type: 'card_swap', status: ['open', 'doing'] }).length, 0, 'tạm nghỉ → việc đổi thẻ còn treo (kể cả lượt trễ hôm trước) huỷ');
    eq(kit('K01').status, 'at_bo', 'máy vẫn ở BO khi tạm nghỉ');
    inv('BO tự chuyển tạm nghỉ');
    eq(await st('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-09', site_id: site('Q3').id }), 409, 'BO tạm nghỉ (máy còn ở BO) → không mở yêu cầu launch mới');
    eq([site('Q3').ops_status, h.store.requests.count({ kind: 'launch' })], ['paused', 1], 'BO giữ trạng thái tạm nghỉ, không sinh yêu cầu thừa');
    h.clock.set(Date.parse('2026-10-09T01:00:00Z')); tick(); tick();
    eq(site('Q3').ops_status, 'live', 'hết khoảng tạm nghỉ → BO ghi hình lại');
    ok(jobs({ type: 'card_swap', status: 'open' }).some((j) => j.date === '2026-10-09'), 'ghi hình lại → việc đổi thẻ sinh lại');
    inv('BO hết tạm nghỉ');
  });

  await group('Nhật ký cho Head of Sale: yêu cầu FO đóng qua chuyến hiện vai "FO", không lộ tên FO', async () => {
    const W = await world(kind);
    const { h, go, seen, job, kit, site, U } = W;
    const vp = (await go('ll', 'POST', '/api/sites', VP)).site;
    await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: 'MC01' });
    await go('ll', 'POST', '/api/hub/devices', { type: 'cm5', codes: 'CM01' });
    await go('l1', 'POST', '/api/hub/kits', { code: 'K01', kind: 'multicam', devices: 'MC01 CM01' });
    await W.dayShift(['2026-10-05'], ['l1', 't1']);
    seen('l1', 't1');
    const req = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-05', outlet: Q3 })).request;
    await go('l1', 'POST', `/api/hub/requests/${req.id}/assign`, { kit_ids: [kit('K01').id] });
    await go('l1', 'POST', `/api/hub/kits/${kit('K01').id}/submit`);
    await W.doJob(job({ type: 'check_kit' }), { pass: true });
    await W.doJob(job({ type: 'deliver', request_id: req.id }), { doc_code: 'BB-01' });
    await go('ll', 'POST', '/api/hub/acc/cap_c_c/move', { kind: 'in', qty: 5, reason: 'Nhập kho' });
    await go('s1', 'POST', `/api/hub/outlets/${site('Q3').id}/support`, { kind: 'extra_acc', acc: { cap_c_c: 1 }, note: 'BO thiếu 1 dây' });
    const trip = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [job({ type: 'deliver_acc' }).id], fo_id: U.fo1.id, office_site_id: vp.id, round_trip: true })).task;
    await runTrip(W, trip.id);
    ok(h.store.hub_log.find({ entity: 'request', actor_id: U.fo1.id }).length > 0, 'đối chứng: yêu cầu hỗ trợ đóng qua chuyến, nhật ký ghi người làm là FO');
    const sh = JSON.stringify((await go('sh', 'GET', '/api/hub/log')).items), ll = JSON.stringify((await go('ll', 'GET', '/api/hub/log')).items);
    ok(!sh.includes('FO Một') && sh.includes('"actor":"FO"'), 'Head of Sale thấy vai "FO", không thấy tên FO');
    ok(ll.includes('FO Một'), 'Logistic Lead vẫn thấy tên FO');
  });

  await group('Mỗi lệnh ghi là một giao dịch: lỗi giữa chừng không để lại nửa chừng', async () => {
    const W = await world(kind);
    const j = (await W.go('ll', 'POST', '/api/hub/jobs', { team: 'logistics', title: 'Kiểm tra giao dịch', assignee_id: W.U.l1.id })).job;
    const before = W.h.store.jobs.get(j.id), logs = W.h.store.hub_log.count({}), inbox = W.h.store.inbox.count({});
    const orig = W.h.store.hub_log.insert;
    W.h.store.hub_log.insert = () => { throw new Error('giả lập lỗi ghi nhật ký'); }; // lỗi xảy ra SAU khi việc đã được trả về hàng chờ
    let threw = false;
    try { await W.call('l1', 'POST', `/api/hub/jobs/${j.id}/release`, { reason: 'thử lỗi giữa chừng' }); } catch { threw = true; }
    W.h.store.hub_log.insert = orig;
    const after = W.h.store.jobs.get(j.id);
    ok(threw, 'lỗi không lường trước được báo ra ngoài (máy chủ trả 500)');
    eq([after.assignee_id, after.status, after.skip_uid ?? null], [before.assignee_id, before.status, before.skip_uid ?? null], 'việc vẫn ở người đang giữ, không bị trả về nửa chừng');
    eq([W.h.store.hub_log.count({}), W.h.store.inbox.count({})], [logs, inbox], 'không có nhật ký hay thông báo mồ côi');
    eq((await W.call('l1', 'POST', `/api/hub/jobs/${j.id}/release`, { reason: 'trả việc thật' })).status, 200, 'thử lại sau khi hết lỗi thì trả việc được');
    W.inv('sau lệnh ghi bị lỗi giữa chừng');
  });

  await group('Nhập dữ liệu từ Excel: đọc file, đoán cột, chạy thử không để lại dấu vết, nhập thật', async () => {
    const W = await world(kind);
    const { h, U, go, st, inv } = W;
    await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: 'MC01' });
    await go('l1', 'POST', '/api/hub/kits', { code: 'K01', kind: 'multicam', devices: 'MC01' });
    await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-07', outlet: Q3 });
    const buf = buildXlsx([
      { name: 'Danh sách BO', rows: [
        ['DANH SÁCH BO THÁNG 10'],
        [],
        ['Mã BO', 'Tên BO', 'SĐT', 'Sale phụ trách', 'Trạng thái', 'Link Google Maps', 'Ngày đổi thẻ', 'Khung giờ đổi thẻ', 'Quota giờ quay', 'Ngày launch'],
        ['GV', 'BO Gò Vấp', '0912 345 678', 'Sale Một', 'Đang quay', 'https://www.google.com/maps/place/x/@10.8381,106.6655,17z', 'T2, T4, T6', '8h - 10h', 600, { date: '2026-09-15' }],
        ['Q3', 'BO Quận 3', '0909999999', 'Sale Một', 'Chờ launch', '', '', '', '', ''],
        ['', 'BO Bình Thạnh', '', 'Người Lạ', 'Đang quay', '10.80, 106.71', '1', '', '', '2026-09-01'],
      ] },
      { name: 'Kit', rows: [
        ['Mã kit', 'Loại kit', 'Trạng thái', 'BO', 'Multicam', 'CM5', 'Hub sạc'],
        ['K10', 'Multicam KIT', 'Tại BO', 'BO Gò Vấp', 'MC10', 'CM10', 2],
        ['K11', 'Multicam KIT', 'Đang sửa', '', 'MC11', 'CM11', 0],
        ['K12', 'Multicam KIT', 'Tại BO', 'BO Không Có', 'MC01', '', 0],
      ] },
      { name: 'Thẻ nhớ', rows: [['Mã thẻ', 'Trạng thái', 'BO'], ['SD90', 'Tại BO', 'BO Gò Vấp'], ['SD91', 'Văn phòng', '']] },
      { name: 'Dung lượng', rows: [['Mã thẻ', 'BO', 'Ngày quay', 'GB'], ['SD90', 'BO Gò Vấp', { date: '2026-10-01' }, 33.8], ['SD90', 'BO Gò Vấp', { date: '2026-10-01' }, 33.8], ['SD91', 'BO Gò Vấp', '02/10/2026', 0]] },
      { name: 'Sự cố', rows: [['Ngày', 'BO', 'Mã kit', 'Nhãn lỗi', 'Trạng thái', 'Cách xử lý'], [{ date: '2026-09-20' }, 'BO Gò Vấp', 'K10', 'Không lên nguồn', 'Đã xử lý', 'Đổi máy'], [{ date: '2026-10-03' }, 'GV', 'K10', 'Quá nhiệt', '', '']] },
    ]);
    const data = buf.toString('base64');
    eq(await st('s1', 'POST', '/api/hub/import/parse', { data, name: 'du-lieu.xlsx' }), 403, 'Sale không nhập dữ liệu');
    eq(await st('l1', 'POST', '/api/hub/import/parse', { data, name: 'du-lieu.xlsx' }), 403, 'Logistic Executive không nhập dữ liệu');
    // File có dung lượng thẻ và sự cố (dữ liệu của Tech): Logistic Lead đọc được nhưng không nhập; Tech Lead nhập cả file.
    const byLl = await go('ll', 'POST', '/api/hub/import/parse', { data, name: 'du-lieu.xlsx' });
    eq(await st('ll', 'POST', '/api/hub/import/run', { token: byLl.token, plan: byLl.sheets.map((s) => ({ sheet: s.index, target: s.guess.target, header_row: s.header_row, mapping: s.guess.mapping })), commit: false }), 403, 'Logistic Lead không nhập dung lượng thẻ, sự cố của Tech');
    const parsed = await go('tl', 'POST', '/api/hub/import/parse', { data, name: 'du-lieu.xlsx' });
    eq(parsed.sheets.map((s) => s.guess.target), ['outlets', 'kits', 'cards', 'records', 'incidents'], 'đoán đúng loại dữ liệu từng sheet');
    eq(parsed.sheets[0].header_row, 2, 'tìm được dòng tiêu đề nằm dưới dòng tên bảng');
    eq(parsed.sheets[3].sample[0][2], '2026-10-01', 'ô ngày kiểu Excel đọc thành ngày');
    ok(parsed.sheets[1].guess.mapping['acc:hub_sac'] === 6, 'cột phụ kiện của kit được nhận theo tên loại phụ kiện');
    const plan = parsed.sheets.map((s) => ({ sheet: s.index, target: s.guess.target, header_row: s.header_row, mapping: s.guess.mapping }));
    const snap = () => JSON.stringify(['sites', 'kits', 'devices', 'cards', 'card_records', 'incidents', 'jobs', 'recon', 'inbox', 'dev_types', 'acc_moves', 'hub_log', 'settings'].map((t) => h.store[t].find({})));
    const before = snap();
    const dry = await go('tl', 'POST', '/api/hub/import/run', { token: parsed.token, plan, commit: false });
    eq(snap(), before, 'chạy thử: dữ liệu trên hệ thống không đổi chút nào');
    const rep = Object.fromEntries(dry.report.map((r) => [r.target, r]));
    eq([rep.outlets.created, rep.outlets.unchanged], [2, 1], 'chạy thử: 2 BO mới, 1 BO đã có (khớp theo mã)');
    ok(dry.recon_sample.some((x) => x.text.includes('SĐT trên hệ thống')), 'SĐT khác nhau → đưa vào Đối chiếu, không ghi đè');
    ok(dry.recon_sample.some((x) => x.text.includes('Người Lạ')), 'Sale chưa có tài khoản → Đối chiếu');
    ok(rep.outlets.notes.some((n) => n.includes('ngày đổi thẻ')), 'ngày đổi thẻ ghi "1" (không rõ) → để trống và báo lại');
    eq(rep.kits.created, 3, 'chạy thử: 3 kit');
    ok(dry.recon_sample.some((x) => x.text.includes('MC01') && x.text.includes('K01')), 'thiết bị đang thuộc kit khác → Đối chiếu, không chuyển');
    eq([rep.records.created, rep.records.unchanged], [2, 1], 'dòng dung lượng trùng trong file chỉ nhập 1 lần');
    const real = await go('tl', 'POST', '/api/hub/import/run', { token: parsed.token, plan, commit: true });
    eq(real.report.map((r) => r.created), dry.report.map((r) => r.created), 'nhập thật cho đúng kết quả chạy thử');
    const gv = W.site('GV');
    eq([gv.ops_status, gv.swap_days, gv.swap_from, gv.swap_to, gv.lat, gv.quota_hours, gv.onboard_date, gv.sale_id], ['live', '1,3,5', '08:00', '10:00', 10.8381, 600, '2026-09-15', U.s1.id], 'BO Gò Vấp nhập đủ: trạng thái, lịch đổi thẻ, toạ độ từ link, quota, onboard, Sale');
    eq(W.site('Q3').phone, Q3.phone, 'BO đã có: không ghi đè SĐT');
    eq([W.kit('K10').status, W.kit('K10').site_id, W.kit('K10').acc.hub_sac], ['at_bo', gv.id, 2], 'kit K10 ở BO Gò Vấp, có 2 hub sạc');
    eq(W.kit('K12').status, 'returned', 'kit ghi "tại BO" nhưng không rõ BO → nhập là "đã về VP", có việc check-in');
    ok(W.job({ type: 'repair', kit_id: W.kit('K11').id }), 'kit đang sửa → có việc sửa cho Tech');
    ok(W.job({ type: 'checkin', kit_id: W.kit('K12').id }), 'kit chưa rõ vị trí → có việc check-in');
    const recs = h.store.card_records.find({ site_id: gv.id });
    ok(recs.length === 2 && recs.every((r) => r.src === 'import' && r.by_id === null), 'lịch sử dung lượng ghi nguồn "nhập file", không gắn người nhập');
    eq(recs.find((r) => r.code === 'SD90').hours, 2, '33,8 GB → 2 giờ quay');
    const pt = await go('tl', 'GET', '/api/hub/perf', null, { period: 'month', key: '2026-10' });
    ok(pt.rows.every((r) => !r.uploads), 'lịch sử nhập từ file không tính điểm cho ai');
    const st1 = await go('tl', 'GET', '/api/hub/incidents/stats', null, { period: 'month', key: '2026-10' });
    ok(st1.top.some((x) => x.label === 'Quá nhiệt'), 'sự cố lịch sử vào thống kê top lỗi');
    ok(h.store.recon.count({ source: 'import', status: 'open' }) >= 5, 'các chỗ lệch đã vào Đối chiếu');
    const ui = h.store.inbox.count({});
    eq(await st('tl', 'POST', '/api/hub/import/run', { token: parsed.token, plan, commit: true }), 410, 'phiên đọc file đã dùng → hết hạn, không nhập lần hai');
    const again = await go('tl', 'POST', '/api/hub/import/parse', { data, name: 'du-lieu.xlsx' });
    const r2 = await go('tl', 'POST', '/api/hub/import/run', { token: again.token, plan: again.sheets.map((s) => ({ sheet: s.index, target: s.guess.target, header_row: s.header_row, mapping: s.guess.mapping })), commit: true });
    eq(r2.report.reduce((a, r) => a + r.created, 0), 0, 'nhập lại cùng file: không tạo trùng bản ghi nào');
    ok(h.store.inbox.count({}) >= ui, 'nhập lại không làm lỗi hộp thư');
    inv('nhập dữ liệu');
    // CSV, file hỏng, file .xls
    const csv = Buffer.from('﻿Mã thẻ;Trạng thái\nSD95;Văn phòng\n', 'utf8').toString('base64');
    const pc = await go('ll', 'POST', '/api/hub/import/parse', { data: csv, name: 'the.csv' });
    eq(pc.sheets[0].guess.target, 'cards', 'CSV dấu chấm phẩy, có BOM: đọc được và đoán đúng');
    eq(await st('ll', 'POST', '/api/hub/import/parse', { data: Buffer.from('PK\u0003\u0004rác').toString('base64'), name: 'hong.xlsx' }), 400, 'file hỏng → báo lỗi dễ hiểu, không làm sập máy chủ');
    const xls = await h.call('ll', 'POST', '/api/hub/import/parse', { data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]).toString('base64'), name: 'cu.xls' });
    ok(xls.status === 400 && /xlsx/.test(xls.body.message), 'file .xls cũ → hướng dẫn lưu lại thành .xlsx');
  });
}

await group('Khung so sánh WoW / MoM: kỳ đang chạy so cùng kỳ, giờ quay bỏ ngày thẻ chưa nhập đủ', async () => {
  const T = (date, hm) => VN(date, hm), C = (per, key, today, hm, lag) => compareOf(periodOf(per, key, today), today, T(today, hm), 420, lag);
  const w = C('week', null, '2026-10-08', '16:00', 2);
  ok(w.running, 'tuần chứa hôm nay là tuần đang chạy');
  eq([w.day.cur, w.day.prev], [{ from: '2026-10-05', to: '2026-10-08' }, { from: '2026-09-28', to: '2026-10-01' }], 'T2–T5 tuần này so với T2–T5 tuần trước');
  eq([w.ts.cur.t1 - w.ts.cur.t0, w.ts.prev.t1 - w.ts.prev.t0], [3 * DAY + 16 * HOUR, 3 * DAY + 16 * HOUR], 'theo thời điểm: cắt kỳ trước ở đúng T5 16:00');
  eq([w.data.cur, w.data.prev], [{ from: '2026-10-05', to: '2026-10-06' }, { from: '2026-09-28', to: '2026-09-29' }], 'giờ quay: bỏ 2 ngày gần nhất ở cả hai bên');
  eq(C('week', null, '2026-10-05', '09:00', 2).data, null, 'thứ Hai: chưa có ngày nào đủ dữ liệu thẻ để so');
  const m = C('month', null, '2026-10-31', '10:00', 0);
  eq(m.day.prev, { from: '2026-09-01', to: '2026-09-30' }, '31/10 so với cả tháng 9 (tháng 9 chỉ có 30 ngày)');
  const p = C('week', '2026-W40', '2026-10-08', '16:00', 2);
  ok(!p.running && !p.info.data_partial && p.ts.prev.t1 - p.ts.prev.t0 === 7 * DAY, 'tuần đã qua, thẻ đã nhập đủ: so cả tuần với cả tuần');
  const q = C('week', '2026-W40', '2026-10-05', '09:00', 2);
  eq([q.data.cur.to, q.data.prev.to], ['2026-10-03', '2026-09-26'], 'thứ Hai xem tuần trước: CN chưa nhập đủ thẻ nên so T2–T7 với T2–T7');
});

await suite('memory');
await suite('sqlite');
summary('Ops Hub');
