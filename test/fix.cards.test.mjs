// fix.cards.test.mjs — vòng thẻ nhớ và bản ghi dung lượng: đổi thẻ tay chỉ thu thẻ đang ở đúng BO, nhận phiếu theo dòng của
// chính phiếu, thẻ không rõ BO, sửa bản ghi theo cùng quy tắc lúc nhập, thẻ 0 giờ, chiều trả thẻ Tech → Logistics,
// thẻ hỏng / thất lạc báo Sale và Đối chiếu, ngưỡng thẻ trong Cài đặt. Sau mỗi bước chạy bộ kiểm bất biến.
// Mỗi nhóm chạy 2 lần: kho bộ nhớ và kho SQLite.
import { mk, ok, eq, group, summary, JPEG } from './harness.mjs';
import { checkInvariants } from './invariants.mjs';

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const VN = (date, hm) => Date.parse(`${date}T${hm}:00+07:00`);
const Q3 = { name: 'BO Quận 3', code: 'Q3', lat: 10.7835, lon: 106.6869, contact: 'Chị Hoa', phone: '0901111222', address: '12 Võ Văn Tần, Quận 3' };
const TD = { name: 'BO Thủ Đức', code: 'TD', lat: 10.8494, lon: 106.7537, contact: 'Anh Nam', phone: '0903333444', address: 'Thủ Đức' };
const SD = (n) => 'SD' + String(n).padStart(2, '0');

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
  const site = (code) => h.store.sites.find({ code }, { limit: 1 })[0];
  const uname = (id) => h.store.users.get(id).username;
  const doJob = async (j, result = {}, who) => go(who || uname(j.assignee_id), 'POST', `/api/hub/jobs/${j.id}/done`, { result });
  const recs = (code) => h.store.card_records.find({ code }, { order: 'id' });
  // Ca cả ngày đã duyệt cho Logistics và Tech trong các ngày của kịch bản: không có ca đã duyệt thì không vào ca, không được tự giao việc.
  const days = Array.from({ length: 8 }, (_, i) => `2026-10-${String(5 + i).padStart(2, '0')}`);
  for (const [ld, us] of [['ll', ['l1', 'l2']], ['tl', ['t1', 't2']]]) await go(ld, 'PUT', '/api/hub/roster', { rows: us.flatMap((u) => days.map((date) => ({ user_id: U[u].id, date }))) });
  return { h, U, go, call, st, seen, tick, inv, job, jobs, kit, card, site, uname, doJob, recs };
}

/** Một BO đang ghi hình với 1 kit, đổi thẻ mọi ngày 09:00–11:00, Sale s1 phụ trách (hoặc người khác). */
async function liveBO(W, outlet, kitCode, mc, cm, sale = 's1') {
  const { go, kit, job, site, doJob } = W;
  await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: mc });
  await go('ll', 'POST', '/api/hub/devices', { type: 'cm5', codes: cm });
  await go('l1', 'POST', '/api/hub/kits', { code: kitCode, kind: 'multicam', devices: `${mc} ${cm}` });
  const req = (await go(sale, 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-05', outlet, swap_days: '1,2,3,4,5,6,7', swap_from: '09:00', swap_to: '11:00' })).request;
  await go('l1', 'POST', `/api/hub/requests/${req.id}/assign`, { kit_ids: [kit(kitCode).id] });
  await go('l1', 'POST', `/api/hub/kits/${kit(kitCode).id}/submit`);
  await doJob(job({ type: 'check_kit', kit_id: kit(kitCode).id }), { pass: true });
  await doJob(job({ type: 'deliver', request_id: req.id }), { doc_code: 'BB-' + kitCode });
  return site(outlet.code);
}

/** Hai BO đang ghi hình (Q3 của s1, TD của s2) và 30 thẻ ở VP. */
async function twoBO(kind) {
  const W = await world(kind);
  W.seen('l1', 'l2', 't1', 't2');
  await W.go('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: Array.from({ length: 30 }, (_, i) => SD(i + 1)).join(' ') });
  const q3 = await liveBO(W, Q3, 'K01', 'MC01', 'CM01', 's1');
  const td = await liveBO(W, TD, 'K02', 'MC02', 'CM02', 's2');
  W.inv('hai BO đang ghi hình');
  return { W, q3, td };
}
/** Sang ngày mới 08:40, mọi người vào ca, nhịp định kỳ sinh việc đổi thẻ của ngày. */
function nextDay(W, date) {
  W.h.clock.set(VN(date, '08:40'));
  W.seen('l1', 'l2', 't1', 't2');
  W.tick();
}
const swapJob = (W, s, date) => W.job({ type: 'card_swap', site_id: s.id, date });
const swap = (W, s, date, result) => W.go('ll', 'POST', `/api/hub/jobs/${swapJob(W, s, date).id}/done`, { result });

/** Gửi Tech các thẻ đã thu về, Tech nhận đủ. */
async function toTech(W, codes) {
  const ho = (await W.go('l1', 'POST', '/api/hub/handovers', { dir: 'to_tech', codes })).handover;
  await W.go('t1', 'POST', `/api/hub/handovers/${ho.id}/receive`, { all: true });
  return ho;
}

async function suite(kind) {
  console.log(`\n── Kho ${kind === 'sqlite' ? 'SQLite' : 'bộ nhớ'} ──`);

  await group('Đổi thẻ tay chỉ thu thẻ đang ở đúng BO; thẻ lạ, thẻ đang ở phiếu hay ở BO khác thì từ chối cả lượt', async () => {
    const { W, q3, td } = await twoBO(kind);
    const { h, go, call, card, inv, st } = W;
    nextDay(W, '2026-10-06');
    await swap(W, q3, '2026-10-06', { cards_out: [SD(1), SD(2)] });
    await swap(W, td, '2026-10-06', { cards_out: [SD(3), SD(4)] });
    nextDay(W, '2026-10-07');
    await swap(W, q3, '2026-10-07', { cards_out: [SD(5), SD(6)] });
    eq([card(SD(1)).status, card(SD(2)).status], ['returned', 'returned'], 'đổi Q3 không ghi thẻ thu → thu mọi thẻ hệ thống ghi ở Q3');
    await go('l1', 'POST', '/api/hub/handovers', { dir: 'to_tech', codes: [SD(1)] });
    inv('SD01 vào phiếu gửi Tech');

    // Trang cũ / gõ nhầm: SD01 đang trong phiếu, SD05 ở Q3, SD02 đã thu về VP, SDXX không có.
    const jTd = swapJob(W, td, '2026-10-07');
    const recon0 = h.store.recon.count({});
    const r = await call('ll', 'POST', `/api/hub/jobs/${jTd.id}/done`, { result: { cards_out: [SD(7), SD(8)], cards_in: [SD(1), SD(5), SD(2), 'SDXX'] } });
    eq([r.status, r.body.error], [409, 'bad_cards'], 'thẻ thu không ở BO của việc → 409 bad_cards');
    ok(['SD01', 'SD05', 'SD02', 'SDXX'].every((c) => (r.body.message || '').includes(c)), `lời báo liệt kê đủ mã sai: ${r.body.message}`);
    ok(/tải lại/i.test(r.body.message || ''), 'lời báo nhắc tải lại trang');
    eq([card(SD(1)).status, card(SD(5)).status, card(SD(5)).site_id, card(SD(2)).status], ['to_tech', 'at_bo', q3.id, 'returned'], 'không thẻ nào bị kéo khỏi phiếu, khỏi BO khác hay khỏi VP');
    eq([card(SD(3)).status, card(SD(4)).status, card(SD(7)).status], ['at_bo', 'at_bo', 'office'], 'cả lượt hoàn tác: thẻ của TD vẫn ở TD, thẻ mới vẫn ở VP');
    eq([h.store.jobs.get(jTd.id).status, h.store.recon.count({})], ['open', recon0], 'việc vẫn mở, không sinh dòng đối chiếu');
    eq(h.store.handover_lines.count({ card_id: card(SD(1)).id }), 1, 'SD01 chỉ nằm trên một phiếu');
    inv('từ chối thẻ thu sai');

    // Thu thiếu so với hệ thống: chỉ chuyển thẻ đã thu; thẻ còn lại giữ ở BO và vào Đối chiếu cho Logistics.
    await go('ll', 'POST', `/api/hub/jobs/${jTd.id}/done`, { result: { cards_out: [SD(7), SD(8)], cards_in: [SD(3)] } });
    eq([card(SD(3)).status, card(SD(4)).status, card(SD(4)).site_id], ['returned', 'at_bo', td.id], 'chỉ thẻ đã thu về VP; thẻ không thu vẫn ghi ở BO');
    const rc = h.store.recon.find({ ref: `swapleft:${jTd.id}`, status: 'open' })[0];
    ok(rc && rc.team === 'logistics' && rc.text.includes('SD04'), 'thẻ hệ thống ghi ở BO mà không thu → vào Đối chiếu của Logistics');
    ok(h.store.inbox.count({ user_id: W.U.ll.id, kind: 'recon' }) >= 1, 'Logistic Lead được báo');
    eq(await st('ll', 'POST', '/api/hub/handovers', { dir: 'to_tech', codes: [SD(1)] }), 409, 'thẻ đang trong phiếu không vào phiếu thứ hai');
    inv('thu thiếu thẻ');
  });

  await group('Nhận phiếu theo dòng: chỉ nhận dòng của chính phiếu; không có thẻ nào về Tech thì không sinh việc nhập', async () => {
    const { W, q3 } = await twoBO(kind);
    const { h, go, call, card, inv, job } = W;
    nextDay(W, '2026-10-06');
    await swap(W, q3, '2026-10-06', { cards_out: [SD(1), SD(2), SD(3), SD(4)] });
    nextDay(W, '2026-10-07');
    await swap(W, q3, '2026-10-07', { cards_out: [SD(5), SD(6)] });
    const h1 = (await go('l1', 'POST', '/api/hub/handovers', { dir: 'to_tech', codes: [SD(1), SD(2)] })).handover;
    const h2 = (await go('l1', 'POST', '/api/hub/handovers', { dir: 'to_tech', codes: [SD(3)] })).handover;
    const h3 = (await go('l1', 'POST', '/api/hub/handovers', { dir: 'to_tech', codes: [SD(4)] })).handover;
    const line = (ho, code) => h.store.handover_lines.find({ handover_id: ho.id, code })[0].id;
    let r = await call('t1', 'POST', `/api/hub/handovers/${h1.id}/receive`, { line_ids: [line(h2, SD(3))], missing_reason: 'không thấy' });
    eq([r.status, r.body.error], [409, 'not_in_ticket'], 'dòng của phiếu khác → 409');
    r = await call('t1', 'POST', `/api/hub/handovers/${h1.id}/receive`, { line_ids: [line(h1, SD(1)), 9991], missing_reason: 'không thấy' });
    eq([r.status, r.body.error], [409, 'not_in_ticket'], 'mã dòng lạ → 409');
    ok(/tải lại/i.test(r.body.message || ''), 'lời báo nhắc tải lại phiếu');
    eq([h.store.handovers.get(h1.id).status, card(SD(1)).status, card(SD(3)).status], ['sent', 'to_tech', 'to_tech'], 'phiếu và thẻ giữ nguyên');
    inv('từ chối dòng lạ');
    const ok1 = (await go('t1', 'POST', `/api/hub/handovers/${h1.id}/receive`, { line_ids: [line(h1, SD(1))], missing_reason: 'Túi chỉ có 1 thẻ' })).handover;
    eq([ok1.recv, ok1.lines, ok1.missing], [1, 2, 1], 'nhận 1/2 thẻ');
    const up = job({ type: 'cards_upload', handover_id: h1.id });
    eq([up.units, up.title.includes('1 thẻ')], [1, true], 'việc nhập dung lượng đúng 1 thẻ');
    eq(job({ type: 'cards_receive', handover_id: h1.id }).result.summary, 'Nhận 1/2 thẻ', 'tóm tắt việc nhận đúng số');
    const none = (await go('t1', 'POST', `/api/hub/handovers/${h3.id}/receive`, { line_ids: [], missing_reason: 'Không có thẻ nào trong túi' })).handover;
    eq([none.recv, card(SD(4)).status], [0, 'returned'], 'không nhận được thẻ nào → thẻ về bên gửi');
    eq(job({ type: 'cards_upload', handover_id: h3.id }), null, 'không có thẻ ở Tech → không sinh việc nhập dung lượng');
    inv('nhận phiếu theo dòng');
  });

  await group('Thẻ không rõ BO: Tech chọn BO và ngày quay, hoặc bản ghi vào Đối chiếu của Tech; tổng giờ các bảng khớp nhau', async () => {
    const { W, q3, td } = await twoBO(kind);
    const { h, go, call, card, inv, recs, st } = W;
    nextDay(W, '2026-10-06');
    await swap(W, q3, '2026-10-06', { cards_out: [SD(1)] });
    await swap(W, td, '2026-10-06', { cards_out: [SD(2)] });
    nextDay(W, '2026-10-07');
    await swap(W, q3, '2026-10-07', { cards_out: [SD(3)] });
    await swap(W, td, '2026-10-07', { cards_out: [SD(4)] });
    // Lead ghi hai thẻ tìm thấy ở VP là "đã thu về" (không biết BO).
    for (const c of [SD(20), SD(21), SD(22)]) await go('ll', 'PATCH', `/api/hub/cards/${card(c).id}`, { status: 'returned', reason: 'Tìm thấy trong túi kit ở kho' });
    await toTech(W, [SD(1), SD(2), SD(20), SD(21), SD(22)]);
    const q = await go('t1', 'GET', '/api/hub/cards/upload-queue');
    const qc = q.cards.find((c) => c.code === SD(20));
    eq([qc.site, qc.shoot_date], [null, null], 'hàng chờ: thẻ không rõ BO không có BO và không đoán ngày quay');
    ok(Array.isArray(q.sites) && q.sites.some((s) => s.id === q3.id), 'hàng chờ kèm danh sách BO để Tech chọn');
    // 1,04 giờ mỗi BO: tổng làm tròn sau khi cộng (2,1), không cộng số đã làm tròn từng BO (2,0).
    await go('t1', 'POST', '/api/hub/cards/records', { records: [{ card_id: card(SD(1)).id, gb: 17.58, shoot_date: '2026-10-06' }, { card_id: card(SD(2)).id, gb: 17.58, shoot_date: '2026-10-06' }] });
    let r = await call('t1', 'POST', '/api/hub/cards/records', { records: [{ card_id: card(SD(20)).id, gb: 33.8 }] });
    eq([r.status, r.body.error], [400, 'date_required'], 'thẻ không rõ thời gian ở BO → phải nhập ngày quay');
    r = await call('t1', 'POST', '/api/hub/cards/records', { records: [{ card_id: card(SD(20)).id, gb: 33.8, shoot_date: '2026-10-06', site_id: 999 }] });
    eq(r.status, 404, 'BO không có → 404');
    r = await call('t1', 'POST', '/api/hub/cards/records', { records: [{ card_id: card(SD(1)).id, gb: 1, shoot_date: '2026-10-06', site_id: td.id }] });
    eq(r.status, 409, 'thẻ đã nhập không nhập lại');
    // Tech chọn BO cho SD20.
    await go('t1', 'POST', '/api/hub/cards/records', { records: [{ card_id: card(SD(20)).id, gb: 33.8, shoot_date: '2026-10-06', site_id: q3.id }] });
    eq(recs(SD(20))[0].site_id, q3.id, 'Tech chọn BO → bản ghi tính cho BO đó');
    ok(h.store.hub_log.find({ entity: 'card', action: 'upload' }).some((l) => l.text.includes('chọn BO')), 'nhật ký ghi việc Tech chọn BO');
    // Không chọn BO: vẫn lưu (việc nhập đóng được) nhưng vào Đối chiếu của Tech, không tính vào BO nào.
    await go('t1', 'POST', '/api/hub/cards/records', { records: [{ card_id: card(SD(21)).id, gb: 16.9, shoot_date: '2026-10-06' }] });
    const rec21 = recs(SD(21))[0];
    eq(rec21.site_id, null, 'không chọn BO → bản ghi chưa rõ BO');
    const rc = h.store.recon.find({ team: 'tech', status: 'open' }).find((x) => x.text.includes(SD(21)));
    ok(!!rc, 'bản ghi chưa rõ BO vào Đối chiếu của Tech');
    ok(h.store.inbox.count({ user_id: W.U.tl.id, kind: 'recon' }) >= 1, 'Tech Lead được báo');
    const ov = await go('sh', 'GET', '/api/hub/overview');
    const sale = await go('sh', 'GET', '/api/hub/sale');
    eq([ov.kpi.hours.cur, ov.sale.totals.hours, sale.hos.kpi.hours.cur, sale.totals.hours], [4.1, 4.1, 4.1, 4.1], 'tổng quan, Sale, Head of Sale cùng một số (không tính giờ chưa rõ BO, làm tròn sau khi cộng)');
    eq(ov.kpi.hours_nosite, { hours: 1, cards: 1 }, 'tổng quan báo riêng giờ chưa rõ BO');
    // Gán BO sau: người nhập (trong hạn sửa) hoặc Tech Lead.
    eq(await st('t2', 'PATCH', `/api/hub/cards/records/${rec21.id}`, { site_id: q3.id }), 403, 'Tech khác không sửa bản ghi của người khác');
    await go('t1', 'PATCH', `/api/hub/cards/records/${rec21.id}`, { site_id: q3.id });
    eq(h.store.card_records.get(rec21.id).site_id, q3.id, 'người nhập chọn BO cho bản ghi chưa rõ BO');
    eq(await st('t1', 'PATCH', `/api/hub/cards/records/${rec21.id}`, { site_id: td.id }), 403, 'bản ghi đã có BO: chỉ Tech Lead đổi BO');
    await go('tl', 'PATCH', `/api/hub/cards/records/${rec21.id}`, { site_id: td.id });
    eq(h.store.card_records.get(rec21.id).site_id, td.id, 'Tech Lead đổi BO của bản ghi');
    ok(h.store.hub_log.find({ entity: 'card', action: 'record_edit' }).some((l) => l.text.includes('BO')), 'đổi BO có nhật ký');
    const ov2 = await go('sh', 'GET', '/api/hub/overview');
    eq([ov2.kpi.hours.cur, ov2.sale.totals.hours, ov2.kpi.hours_nosite.cards], [5.1, 5.1, 0], 'gán BO xong: hai bảng cùng tăng');
    // Thẻ có BO mà Tech chọn BO khác thì không nhận (đổi BO của thẻ là việc của Lead).
    r = await call('t1', 'POST', '/api/hub/cards/records', { records: [{ card_id: card(SD(22)).id, gb: 1, shoot_date: '2026-10-06', site_id: q3.id }] });
    eq(r.status, 200, 'thẻ không rõ BO chọn được BO');
    inv('thẻ không rõ BO');
    await go('ll', 'PATCH', `/api/hub/cards/${card(SD(3)).id}`, { status: 'returned', reason: 'Logistics tự đi thu thẻ' });
    await toTech(W, [SD(3)]);
    r = await call('t1', 'POST', '/api/hub/cards/records', { records: [{ card_id: card(SD(3)).id, gb: 1, site_id: td.id }] });
    eq([r.status, r.body.error], [409, 'site_mismatch'], 'thẻ đã ghi BO thì không chọn BO khác khi nhập');
  });

  await group('Sửa bản ghi theo cùng quy tắc lúc nhập: ngày quay, ảnh, lý do 0 giờ, hạn sửa; mỗi lần sửa có nhật ký', async () => {
    const { W, q3 } = await twoBO(kind);
    const { h, go, call, card, inv, recs, st } = W;
    nextDay(W, '2026-10-06');
    await swap(W, q3, '2026-10-06', { cards_out: [SD(1), SD(2)] });
    nextDay(W, '2026-10-07');
    await swap(W, q3, '2026-10-07', { cards_out: [SD(3), SD(4)] });
    await toTech(W, [SD(1), SD(2)]);
    await go('tl', 'PUT', '/api/hub/config', { uploadPhotoRequired: true });
    await go('t1', 'POST', '/api/hub/cards/records', { records: [{ card_id: card(SD(1)).id, gb: 84.5, shoot_date: '2026-10-06' }, { card_id: card(SD(2)).id, gb: 50, shoot_date: '2026-10-06' }], photos: [JPEG] });
    const r1 = recs(SD(1))[0];
    const logs0 = h.store.hub_log.count({ action: 'record_edit' });
    let r = await call('t1', 'PATCH', `/api/hub/cards/records/${r1.id}`, { gb: 300 });
    eq([r.status, r.body.error], [400, 'photo_required'], 'đổi GB khi bắt buộc ảnh → cần ảnh mới');
    r = await call('t1', 'PATCH', `/api/hub/cards/records/${r1.id}`, { shoot_date: '2025-01-01' });
    eq([r.status, r.body.error], [400, 'bad_date'], 'ngày quay ngoài khoảng cho phép → chặn như lúc nhập');
    r = await call('t1', 'PATCH', `/api/hub/cards/records/${r1.id}`, { shoot_date: '2026-10-09' });
    eq([r.status, r.body.error], [400, 'bad_date'], 'ngày quay ở tương lai → chặn');
    eq(h.store.hub_log.count({ action: 'record_edit' }), logs0, 'lần sửa bị chặn không ghi nhật ký');
    const ed = (await go('t1', 'PATCH', `/api/hub/cards/records/${r1.id}`, { gb: 101.4, photos: [JPEG] })).record;
    eq([ed.gb, ed.hours, ed.photos.length], [101.4, 6, 2], 'đổi GB kèm ảnh mới → giờ tính lại, ảnh mới thêm vào bằng chứng');
    r = await call('t1', 'PATCH', `/api/hub/cards/records/${r1.id}`, { gb: 0.05, photos: [JPEG] });
    eq([r.status, r.body.error], [400, 'zero_reason'], 'GB ra 0 giờ mà không có lý do → chặn');
    r = await call('t1', 'PATCH', `/api/hub/cards/records/${r1.id}`, { gb: 0.05, photos: [JPEG], zero_reason: 'abc' });
    eq([r.status, r.body.error], [400, 'zero_reason'], 'lý do 0 giờ vô nghĩa → chặn');
    const z = (await go('t1', 'PATCH', `/api/hub/cards/records/${r1.id}`, { gb: 0.05, photos: [JPEG], zero_reason: 'Máy không ghi' })).record;
    eq([z.hours, z.zero_reason], [0, 'Máy không ghi'], 'lý do hợp lệ → lưu');
    const lg = h.store.hub_log.find({ action: 'record_edit' }, { order: 'id', desc: true, limit: 1 })[0];
    ok(lg && lg.text.includes('Máy không ghi'), 'nhật ký sửa ghi lý do 0 giờ');
    eq(h.store.hub_log.count({ action: 'record_edit' }), logs0 + 2, 'mỗi lần sửa thành công một dòng nhật ký');
    // Hạn sửa của người nhập là cài đặt của Tech.
    await go('tl', 'PUT', '/api/hub/config', { recordEditHours: 2 });
    h.clock.add(3 * HOUR);
    eq(await st('t1', 'PATCH', `/api/hub/cards/records/${recs(SD(2))[0].id}`, { shoot_date: '2026-10-05' }), 403, 'quá hạn sửa (cài đặt 2 giờ) → người nhập không sửa được');
    eq(await st('tl', 'PATCH', `/api/hub/cards/records/${recs(SD(2))[0].id}`, { shoot_date: '2026-10-05' }), 200, 'Tech Lead vẫn sửa được');
    // Khoảng ngày quay cũng là cài đặt.
    await go('tl', 'PUT', '/api/hub/config', { shootWindowDays: 7 });
    eq(await st('tl', 'PATCH', `/api/hub/cards/records/${recs(SD(2))[0].id}`, { shoot_date: '2026-09-28' }), 400, 'ngày quay quá 7 ngày (cài đặt) → chặn');
    const rows = (await go('t1', 'GET', '/api/hub/cards/records', null, { from: '2026-10-01', to: '2026-10-07' }));
    eq([rows.edit_hours, rows.shoot_window_days], [2, 7], 'giao diện nhận hạn sửa và khoảng ngày quay từ máy chủ');
    inv('sửa bản ghi');
  });

  await group('Thẻ 0 giờ: GB ra 0 giờ cần lý do có nghĩa; mỗi lượt nhập báo Sale; nhật ký ghi lý do', async () => {
    const { W, q3 } = await twoBO(kind);
    const { h, go, call, card, inv, recs } = W;
    nextDay(W, '2026-10-06');
    await swap(W, q3, '2026-10-06', { cards_out: [SD(1), SD(2), SD(3), SD(4)] });
    nextDay(W, '2026-10-07');
    await swap(W, q3, '2026-10-07', { cards_out: [SD(5), SD(6)] });
    await toTech(W, [SD(1), SD(2), SD(3), SD(4)]);
    const up = (c, gb, zero) => call('t1', 'POST', '/api/hub/cards/records', { records: [{ card_id: card(c).id, gb, shoot_date: '2026-10-06', ...(zero !== undefined ? { zero_reason: zero } : {}) }] });
    let r = await up(SD(1), 0.004);
    eq([r.status, r.body.error], [400, 'zero_reason'], '0,004 GB (lưu thành 0) mà không có lý do → chặn');
    r = await up(SD(1), 0.08);
    eq([r.status, r.body.error], [400, 'zero_reason'], '0,08 GB ra 0 giờ mà không có lý do → chặn');
    r = await up(SD(1), 0, 'abc');
    eq([r.status, r.body.error], [400, 'zero_reason'], 'lý do tự gõ quá ngắn → chặn');
    r = await up(SD(1), 0, 'Khác');
    eq([r.status, r.body.error], [400, 'zero_reason'], 'chọn "Khác" mà không ghi rõ → chặn');
    await up(SD(1), 0.08, 'BO không bật máy');
    eq([recs(SD(1))[0].hours, recs(SD(1))[0].zero_reason], [0, 'BO không bật máy'], 'lý do trong danh sách → lưu');
    eq(h.store.inbox.count({ user_id: W.U.s1.id, kind: 'zero_hour' }), 1, 'Sale phụ trách được báo thẻ 0 giờ');
    await up(SD(2), 0, 'Khác: BO dời giờ mở cửa cả ngày');
    eq(recs(SD(2))[0].zero_reason, 'Khác: BO dời giờ mở cửa cả ngày', '"Khác" kèm mô tả → lưu');
    eq(h.store.inbox.count({ user_id: W.U.s1.id, kind: 'zero_hour' }), 2, 'lượt nhập sau cùng BO cùng ngày vẫn báo Sale');
    ok(h.store.hub_log.find({ action: 'upload' }).some((l) => l.text.includes('BO không bật máy')), 'nhật ký nhập ghi lý do 0 giờ');
    const sale = await go('s1', 'GET', '/api/hub/cards/records', null, { from: '2026-10-06', to: '2026-10-06', zero: '1' });
    eq(sale.records.map((x) => x.zero_reason).sort(), ['BO không bật máy', 'Khác: BO dời giờ mở cửa cả ngày'], 'Sale thấy lý do của mọi thẻ 0 giờ');
    inv('thẻ 0 giờ');
  });

  await group('Chiều trả thẻ: nhập xong phiếu thì Tech có việc trả thẻ, theo dõi thẻ chờ trả, báo Logistics khi thẻ ở VP xuống thấp', async () => {
    const { W, q3 } = await twoBO(kind);
    const { h, go, card, inv, job, jobs, st, tick } = W;
    nextDay(W, '2026-10-06');
    await swap(W, q3, '2026-10-06', { cards_out: [SD(1), SD(2)] });
    nextDay(W, '2026-10-07');
    await swap(W, q3, '2026-10-07', { cards_out: [SD(3), SD(4)] });
    const ho = await toTech(W, [SD(1), SD(2)]);
    await go('t1', 'POST', '/api/hub/cards/records', { records: [{ card_id: card(SD(1)).id, gb: 50, shoot_date: '2026-10-06' }] });
    eq(job({ type: 'cards_return', handover_id: ho.id }), null, 'phiếu còn thẻ chờ nhập → chưa có việc trả');
    await go('t1', 'POST', '/api/hub/cards/records', { records: [{ card_id: card(SD(2)).id, gb: 40, shoot_date: '2026-10-06' }] });
    const ret = job({ type: 'cards_return', handover_id: ho.id });
    ok(ret && ret.status === 'open' && ret.team === 'tech' && ret.title.includes('2 thẻ'), 'nhập đủ phiếu → Tech có việc trả 2 thẻ về Logistics');
    tick(); tick();
    eq(jobs({ type: 'cards_return', handover_id: ho.id }).length, 1, 'không tạo trùng việc trả cho cùng phiếu');
    eq(await st('tl', 'POST', `/api/hub/jobs/${ret.id}/cancel`, { reason: 'thử huỷ' }), 409, 'việc trả thẻ không huỷ tay');
    eq(await st('tl', 'POST', `/api/hub/jobs/${ret.id}/done`, { result: {} }), 409, 'việc trả thẻ không bấm xong chung');
    inv('có việc trả thẻ');
    // Thẻ đã nhập chờ trả quá lâu → mục theo dõi của Tech.
    h.clock.add(25 * HOUR);
    let tlw = (await go('tl', 'GET', '/api/hub/overview')).watch;
    ok(tlw.some((w) => w.kind === 'cards_uploaded'), 'thẻ đã nhập chờ trả quá 24 giờ → Tech Lead thấy trong mục theo dõi');
    await go('tl', 'PUT', '/api/hub/config', { cardsUploadedHours: 48 });
    tlw = (await go('tl', 'GET', '/api/hub/overview')).watch;
    ok(!tlw.some((w) => w.kind === 'cards_uploaded'), 'ngưỡng theo cài đặt của Tech');
    // Trả một phần: việc còn mở; trả hết: việc tự đóng, điểm cho người lập phiếu trả.
    const b1 = (await go('t2', 'POST', '/api/hub/handovers', { dir: 'to_log', codes: [SD(1)] })).handover;
    eq(h.store.jobs.get(ret.id).status, 'open', 'mới trả 1/2 thẻ → việc trả còn mở');
    await go('t2', 'PATCH', `/api/hub/handovers/${b1.id}`, { add: [SD(2)] });
    const retDone = h.store.jobs.get(ret.id);
    eq([retDone.status, retDone.done_by], ['done', W.U.t2.id], 'mọi thẻ của phiếu đã vào phiếu trả → việc tự đóng, tính cho người trả');
    await go('l2', 'POST', `/api/hub/handovers/${b1.id}/receive`, { all: true });
    eq([card(SD(1)).status, card(SD(2)).status], ['office', 'office'], 'Logistics nhận lại thẻ');
    inv('trả thẻ về Logistics');
    // Thẻ ở VP xuống dưới ngưỡng → báo Logistics (một lần mỗi ngày).
    await go('ll', 'PUT', '/api/hub/config', { officeCardsMin: 40 });
    tick(); tick();
    eq(h.store.inbox.count({ user_id: W.U.ll.id, kind: 'cards_low' }), 1, 'thẻ sẵn sàng ở VP dưới ngưỡng → báo Logistic Lead đúng 1 lần');
    ok(h.store.inbox.count({ user_id: W.U.l1.id, kind: 'cards_low' }) === 1, 'nhân viên Logistics cũng được báo');
    eq(h.store.inbox.count({ user_id: W.U.t1.id, kind: 'cards_low' }), 0, 'Tech không nhận báo kho thẻ');
    ok((await go('ll', 'GET', '/api/hub/overview')).watch.some((w) => w.kind === 'cards_low'), 'Logistic Lead thấy trong mục theo dõi');
    await go('ll', 'PUT', '/api/hub/config', { officeCardsMin: 0 });
    ok(!(await go('ll', 'GET', '/api/hub/overview')).watch.some((w) => w.kind === 'cards_low'), 'ngưỡng 0 = tắt');
    inv('báo kho thẻ thấp');
  });

  await group('Thẻ hỏng / thất lạc khi chưa nhập: báo Sale phụ trách BO có thể thiếu giờ quay, vào Đối chiếu của Tech, không tự đặt giờ', async () => {
    const { W, q3, td } = await twoBO(kind);
    const { h, go, card, inv, recs } = W;
    nextDay(W, '2026-10-06');
    await swap(W, q3, '2026-10-06', { cards_out: [SD(1), SD(2)] });
    await swap(W, td, '2026-10-06', { cards_out: [SD(3)] });
    nextDay(W, '2026-10-07');
    await swap(W, q3, '2026-10-07', { cards_out: [SD(4), SD(5)] });
    await swap(W, td, '2026-10-07', { cards_out: [SD(6)] });
    await toTech(W, [SD(1), SD(2)]);
    await go('t1', 'PATCH', `/api/hub/cards/${card(SD(1)).id}`, { status: 'bad', reason: 'Đầu đọc không nhận thẻ' });
    eq(recs(SD(1)).length, 0, 'không tự tạo bản ghi giờ quay');
    const msg = h.store.inbox.find({ user_id: W.U.s1.id, kind: 'card_gap' })[0];
    ok(msg && msg.text.includes('Quận 3') && /06\/10/.test(msg.text), 'Sale phụ trách BO được báo giờ quay khoảng đó có thể thiếu');
    ok(msg && !msg.text.includes('FO') && !msg.text.includes('Tech Một'), 'lời báo cho Sale không có tên người');
    eq(h.store.inbox.count({ user_id: W.U.s2.id, kind: 'card_gap' }), 0, 'Sale khác không được báo');
    const rc = h.store.recon.find({ team: 'tech', status: 'open' }).find((x) => x.text.includes(SD(1)));
    ok(!!rc, 'vào Đối chiếu của Tech');
    // Lead ghi thất lạc thẻ đang ở BO.
    await go('ll', 'PATCH', `/api/hub/cards/${card(SD(6)).id}`, { status: 'lost', reason: 'BO báo làm rơi mất thẻ' });
    ok(h.store.inbox.count({ user_id: W.U.s2.id, kind: 'card_gap' }) === 1, 'thẻ thất lạc tại BO → báo Sale của BO đó');
    // Thẻ đã nhập dung lượng rồi mới hỏng: giờ quay đã có, không báo Sale.
    await go('t1', 'POST', '/api/hub/cards/records', { records: [{ card_id: card(SD(2)).id, gb: 30, shoot_date: '2026-10-06' }] });
    const n0 = h.store.inbox.count({ kind: 'card_gap' });
    await go('t1', 'PATCH', `/api/hub/cards/${card(SD(2)).id}`, { status: 'bad', reason: 'Thẻ nứt khi rút ra' });
    eq(h.store.inbox.count({ kind: 'card_gap' }), n0, 'thẻ đã nhập rồi mới hỏng → không báo thiếu giờ');
    inv('thẻ hỏng / thất lạc');
  });

  await group('Phiếu trả bị huỷ, gỡ thẻ, hay Logistics không nhận được thẻ: việc trả thẻ mở lại cho Tech, không giữ điểm', async () => {
    const { W, q3 } = await twoBO(kind);
    const { h, go, card, inv, job, jobs } = W;
    nextDay(W, '2026-10-06');
    await swap(W, q3, '2026-10-06', { cards_out: [SD(1), SD(2), SD(3)] });
    nextDay(W, '2026-10-07');
    await swap(W, q3, '2026-10-07', { cards_out: [SD(4), SD(5), SD(6)] });
    const ho = await toTech(W, [SD(1), SD(2), SD(3)]);
    await go('t1', 'POST', '/api/hub/cards/records', { records: [SD(1), SD(2), SD(3)].map((c) => ({ card_id: card(c).id, gb: 40, shoot_date: '2026-10-06' })) });
    const ret = job({ type: 'cards_return', handover_id: ho.id });
    // Huỷ phiếu trả: thẻ về "Đã nhập", gắn lại phiếu gửi Tech, việc trả mở lại và bỏ điểm đã tính.
    const b1 = (await go('t1', 'POST', '/api/hub/handovers', { dir: 'to_log', codes: [SD(1), SD(2), SD(3)] })).handover;
    eq(h.store.jobs.get(ret.id).status, 'done', 'lập phiếu trả đủ thẻ → việc trả đóng');
    await go('t1', 'POST', `/api/hub/handovers/${b1.id}/cancel`, { reason: 'Lập nhầm phiếu' });
    const re = h.store.jobs.get(ret.id);
    eq([re.status, re.done_by, re.std_min || 0], ['open', null, 0], 'huỷ phiếu trả → việc trả mở lại, không còn điểm');
    eq([card(SD(1)).status, card(SD(1)).handover_id], ['uploaded', ho.id], 'thẻ về "Đã nhập", gắn lại phiếu gửi Tech');
    ok(re.title.includes('3 thẻ'), `tiêu đề việc theo số thẻ còn chờ trả: ${re.title}`);
    ok(h.store.hub_log.find({ entity: 'job', entity_id: ret.id, action: 'reopen' }).length === 1, 'mở lại việc có nhật ký');
    eq(jobs({ type: 'cards_return', handover_id: ho.id, status: ['open', 'doing'] }).length, 1, 'không sinh việc trả thứ hai');
    inv('huỷ phiếu trả');
    // Gỡ thẻ khỏi phiếu trả: thẻ đó về "Đã nhập", việc trả mở lại cho phần còn lại.
    const b2 = (await go('t1', 'POST', '/api/hub/handovers', { dir: 'to_log', codes: [SD(1), SD(2), SD(3)] })).handover;
    eq(h.store.jobs.get(ret.id).status, 'done', 'lập lại phiếu trả → việc đóng lại');
    await go('t1', 'PATCH', `/api/hub/handovers/${b2.id}`, { remove: [SD(3)] });
    const re2 = h.store.jobs.get(ret.id);
    eq([re2.status, card(SD(3)).status, card(SD(3)).handover_id], ['open', 'uploaded', ho.id], 'gỡ thẻ khỏi phiếu trả → việc trả mở lại, thẻ gắn lại phiếu gửi Tech');
    ok(re2.title.includes('1 thẻ'), `tiêu đề còn 1 thẻ: ${re2.title}`);
    inv('gỡ thẻ khỏi phiếu trả');
    await go('t1', 'PATCH', `/api/hub/handovers/${b2.id}`, { add: [SD(3)] });
    eq(h.store.jobs.get(ret.id).status, 'done', 'thêm lại thẻ → việc đóng');
    // Logistics không nhận được một thẻ: thẻ về Tech, việc trả mở lại cho thẻ đó.
    const l3 = h.store.handover_lines.find({ handover_id: b2.id }).filter((l) => l.code !== SD(3)).map((l) => l.id);
    await go('l1', 'POST', `/api/hub/handovers/${b2.id}/receive`, { line_ids: l3, missing_reason: 'Không thấy thẻ trong hộp' });
    const re3 = h.store.jobs.get(ret.id);
    eq([re3.status, card(SD(3)).status, card(SD(3)).handover_id, card(SD(1)).status], ['open', 'uploaded', ho.id, 'office'], 'thẻ Logistics không nhận được → về Tech, việc trả mở lại');
    inv('Logistics thiếu thẻ khi nhận');
    const b3 = (await go('t2', 'POST', '/api/hub/handovers', { dir: 'to_log', codes: [SD(3)] })).handover;
    const fin = h.store.jobs.get(ret.id);
    eq([fin.status, fin.done_by], ['done', W.U.t2.id], 'trả nốt thẻ → việc đóng, tính cho người lập phiếu trả cuối');
    await go('l1', 'POST', `/api/hub/handovers/${b3.id}/receive`, { all: true });
    eq(jobs({ type: 'cards_return', handover_id: ho.id }).length, 1, 'cả vòng chỉ một việc trả cho phiếu');
    inv('trả nốt thẻ');
  });

  await group('BO ngừng hoạt động: tổng giờ quay vẫn khớp giữa tổng quan, Sale, Head of Sale; thẻ 0 giờ theo số giờ', async () => {
    const { W, q3, td } = await twoBO(kind);
    const { go, card, inv } = W;
    nextDay(W, '2026-10-06');
    await swap(W, q3, '2026-10-06', { cards_out: [SD(1), SD(2)] });
    await swap(W, td, '2026-10-06', { cards_out: [SD(3)] });
    nextDay(W, '2026-10-07');
    await swap(W, q3, '2026-10-07', { cards_out: [SD(4), SD(5)] });
    await swap(W, td, '2026-10-07', { cards_out: [SD(6)] });
    await toTech(W, [SD(1), SD(2), SD(3)]);
    await go('t1', 'POST', '/api/hub/cards/records', { records: [
      { card_id: card(SD(1)).id, gb: 0.05, shoot_date: '2026-10-06', zero_reason: 'Khác: BO mất điện cả ngày' },
      { card_id: card(SD(2)).id, gb: 50.7, shoot_date: '2026-10-06' }, { card_id: card(SD(3)).id, gb: 33.8, shoot_date: '2026-10-06' }] });
    const od = await go('ll', 'GET', `/api/hub/outlets/${q3.id}`);
    eq(od.zero_cards.map((z) => [z.code, z.reason]), [[SD(1), 'Khác: BO mất điện cả ngày']], 'GB nhỏ ra 0 giờ có trong danh sách thẻ 0 giờ của BO');
    eq(od.series.reduce((a, d) => a + d.zero, 0), od.zero_cards.length, 'chuỗi theo ngày và danh sách thẻ 0 giờ cùng một số');
    // BO đang dùng không xoá được ở Rider Live: kết thúc ghi hình, Logistics thu hồi kit, BO "đã kết thúc" rồi mới xoá (ngừng hoạt động).
    const endReq = (await go('s2', 'POST', `/api/hub/outlets/${td.id}/end`, { note: 'Hết hợp đồng' })).request;
    await go('ll', 'POST', `/api/hub/jobs/${W.job({ type: 'recover', request_id: endReq.id }).id}/done`, { result: {} });
    eq(W.site('TD').ops_status, 'ended', 'đối chứng: TD đã thu hồi xong');
    await go('ll', 'DELETE', `/api/sites/${td.id}`);
    const ov = await go('sh', 'GET', '/api/hub/overview');
    const sale = await go('sh', 'GET', '/api/hub/sale');
    eq([ov.kpi.hours.cur, ov.sale.totals.hours, sale.hos.kpi.hours.cur, sale.totals.hours], [3, 3, 3, 3], 'BO ngừng hoạt động: tổng quan không tính giờ của BO đó, khớp Sale và Head of Sale');
    eq(ov.kpi.hours_offbo, { hours: 2, cards: 1 }, 'tổng quan báo riêng giờ quay của BO đã ngừng hoạt động');
    inv('BO ngừng hoạt động');
  });

  await group('Ngưỡng của vòng thẻ nằm trong Cài đặt, mỗi mục có team chốt', async () => {
    const { W, q3 } = await twoBO(kind);
    const { h, go, st, card } = W;
    const c = await go('ad', 'GET', '/api/hub/config');
    // Thẻ ở BO, thẻ thu về, thẻ ở Tech dùng chung ngưỡng với Điểm nghẽn (một mục cho một số): cardsStaleDays, cardsReturnedH, uploadLateH.
    const want = { cardsStaleDays: ['Logistics', 3], cardsReturnedH: ['Logistics', 12], officeCardsMin: ['Logistics', 10], uploadLateH: ['Tech', 24], cardsUploadedHours: ['Tech', 24], shootWindowDays: ['Tech', 60], recordEditHours: ['Tech', 48] };
    for (const [k, [owner, def]] of Object.entries(want)) {
      eq([c.owners[k], c.defaults[k], !!c.labels[k]], [owner, def, true], `cài đặt ${k}: team chốt, mặc định, nhãn`);
    }
    eq(await st('ll', 'PUT', '/api/hub/config', { shootWindowDays: 30 }), 403, 'Logistic Lead không sửa mục của Tech');
    eq(await st('tl', 'PUT', '/api/hub/config', { cardsStaleDays: 5 }), 403, 'Tech Lead không sửa mục của Logistics');
    eq(await st('tl', 'PUT', '/api/hub/config', { shootWindowDays: 0 }), 400, 'giá trị ngoài khoảng → chặn');
    // Thẻ ở BO quá lâu theo cài đặt.
    nextDay(W, '2026-10-06');
    await swap(W, q3, '2026-10-06', { cards_out: [SD(1)] });
    h.clock.set(VN('2026-10-09', '12:00'));
    let w = (await go('ll', 'GET', '/api/hub/overview')).watch;
    ok(w.some((x) => x.kind === 'cards_stale'), 'thẻ ở BO hơn 3 ngày → Logistics thấy');
    await go('ll', 'PUT', '/api/hub/config', { cardsStaleDays: 5 });
    w = (await go('ll', 'GET', '/api/hub/overview')).watch;
    ok(!w.some((x) => x.kind === 'cards_stale'), 'ngưỡng 5 ngày → chưa báo');
    // Thẻ đã thu về chờ gửi Tech quá lâu theo cài đặt.
    await go('ll', 'PATCH', `/api/hub/cards/${card(SD(1)).id}`, { status: 'returned', reason: 'Logistics tự đi thu thẻ' });
    h.clock.add(13 * HOUR);
    ok((await go('ll', 'GET', '/api/hub/overview')).watch.some((x) => x.kind === 'cards_returned'), 'thẻ đã thu về hơn 12 giờ → Logistics thấy');
    await go('ll', 'PUT', '/api/hub/config', { cardsReturnedH: 24 });
    ok(!(await go('ll', 'GET', '/api/hub/overview')).watch.some((x) => x.kind === 'cards_returned'), 'ngưỡng 24 giờ → chưa báo');
    // Thẻ ở Tech chờ nhập quá lâu theo cài đặt.
    await toTech(W, [SD(1)]);
    h.clock.add(25 * HOUR);
    ok((await go('tl', 'GET', '/api/hub/overview')).watch.some((x) => x.kind === 'upload_late'), 'thẻ ở Tech hơn 24 giờ chưa nhập → Tech Lead thấy');
    await go('tl', 'PUT', '/api/hub/config', { uploadLateH: 48 });
    ok(!(await go('tl', 'GET', '/api/hub/overview')).watch.some((x) => x.kind === 'upload_late'), 'ngưỡng 48 giờ → chưa báo');
    const q = await go('t1', 'GET', '/api/hub/cards/upload-queue');
    eq(q.shoot_window_days, 60, 'hàng chờ nhập nhận khoảng ngày quay từ cài đặt');
    W.inv('ngưỡng thẻ');
  });
}

await suite('memory');
await suite('sqlite');
summary('Vòng thẻ nhớ và bản ghi dung lượng');
