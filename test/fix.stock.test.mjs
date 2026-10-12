// fix.stock.test.mjs — kiểm hồi quy cụm kho: đổi kit hỏng làm tay, kit thu hồi khi tắt bước Tech kiểm, Lead điều chỉnh kit ở ngoài,
// sổ phụ kiện qua nhập file, sự cố cũ, giao thiếu phụ kiện, thiết bị "đang sửa", nhập kit / thiết bị từ file, trùng mã thiết bị và thẻ.
// Mỗi nhóm chạy 2 lần: kho bộ nhớ và kho SQLite; sau mỗi bước chạy bộ kiểm bất biến.
import { mk, boDevice, ok, eq, group, summary, JPEG } from './harness.mjs';
import { checkInvariants } from './invariants.mjs';
import { buildXlsx } from './xlsx-build.mjs';

const MIN = 60000;
const VN = (date, hm) => Date.parse(`${date}T${hm}:00+07:00`);

async function world(kind) {
  const h = mk(kind);
  h.clock.set(VN('2026-10-05', '08:30'));
  const U = {};
  for (const [u, role] of [['ad', 'admin'], ['tl', 'tech_lead'], ['t1', 'tech'], ['ll', 'lead'], ['l1', 'logistic'], ['fo1', 'fo'], ['sh', 'sale_head'], ['s1', 'sale']]) U[u] = await h.user(u, role, { name: u.toUpperCase() });
  const call = (who, m, p, b, q) => h.call(who, m, p, b, q);
  const go = async (who, m, p, b, q) => { const r = await h.call(who, m, p, b, q); if (r.status !== 200) throw new Error(`${who} ${m} ${p} → ${r.status} ${r.body.error}: ${r.body.message}`); return r.body; };
  const S = h.store;
  const kit = (code) => S.kits.find({ code }, { limit: 1 })[0];
  const dev = (code) => S.devices.find({ code }, { limit: 1 })[0];
  const job = (where) => S.jobs.find(where, { order: 'id', desc: true, limit: 1 })[0] || null;
  const recon = (where = {}) => S.recon.find({ status: 'open', ...where });
  const inv = (label) => { const v = checkInvariants(S); ok(!v.length, `bất biến sau "${label}": ${v.join(' | ')}`); return v; };
  const acc = async (id) => (await go('ll', 'GET', '/api/hub/acc')).acc.find((a) => a.id === id);
  return { h, U, call, go, S, kit, dev, job, recon, inv, acc };
}

let siteSeq = 0;
/** Kho, văn phòng và một BO mới với `kits` kit Multicam đã kiểm đạt, gán cho yêu cầu launch (extra: kit dự phòng sẵn sàng). */
async function setupBo(W, { kits = 1, extra = 0, code = 'Q3', acc = { hub_sac: 1 }, accIn = 20 } = {}) {
  const { go, S, kit, job } = W;
  if (!S.sites.find({ type: 'office' }).length) await go('ll', 'POST', '/api/sites', { name: 'VP', type: 'office', lat: 10.7769, lon: 106.7009 });
  const n = kits + extra, mcs = [], cms = [], codes = [];
  for (let i = 1; i <= n; i++) { mcs.push(`MC${code}${i}`); cms.push(`CM${code}${i}`); }
  await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: mcs.join(' ') });
  await go('ll', 'POST', '/api/hub/devices', { type: 'cm5', codes: cms.join(' ') });
  if (!S.cards.count({})) await go('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: Array.from({ length: 30 }, (_, i) => 'SD' + (i + 1)).join(' ') });
  for (const id of Object.keys(acc)) if (!S.dev_types.get(id).total) await go('l1', 'POST', `/api/hub/acc/${id}/move`, { kind: 'in', qty: accIn, reason: 'Tồn đầu kỳ' });
  for (let i = 1; i <= n; i++) { const c = `K${code}${i}`; codes.push(c); await go('l1', 'POST', '/api/hub/kits', { code: c, kind: 'multicam', devices: `${mcs[i - 1]} ${cms[i - 1]}`, acc }); }
  siteSeq++;
  const req = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: kits }, launch_date: '2026-10-05', outlet: { name: 'Quán ' + code, code, lat: 10.70 + siteSeq / 100, lon: 106.60 + siteSeq / 100, phone: '0901' + String(siteSeq).padStart(6, '0'), contact: 'X' }, swap_days: [1, 2, 3, 4, 5, 6, 7], swap_from: '09:00', swap_to: '23:00' })).request;
  await go('l1', 'POST', `/api/hub/requests/${req.id}/assign`, { kit_ids: codes.slice(0, kits).map((c) => kit(c).id) });
  for (const c of codes) await go('l1', 'POST', `/api/hub/kits/${kit(c).id}/submit`);
  for (const c of codes) await go('t1', 'POST', `/api/hub/jobs/${job({ type: 'check_kit', kit_id: kit(c).id }).id}/done`, { result: { pass: true } });
  return { req, site: S.sites.find({ code }, { limit: 1 })[0], codes };
}
async function deliverManual(W, req) {
  const dj = W.job({ type: 'deliver', request_id: req.id });
  await W.go('l1', 'POST', `/api/hub/jobs/${dj.id}/done`, { result: { doc_code: 'BB' + dj.id } });
}

async function suite(kind) {
  console.log(`\n── Kho ${kind === 'sqlite' ? 'SQLite' : 'bộ nhớ'} ──`);

  await group('Đổi kit hỏng làm tay: cùng loại, kit sẵn sàng ở VP, không lấy kit đang giao cho BO khác', async () => {
    const W = await world(kind);
    const { go, call, S, kit, job, U, h, inv } = W;
    const A = await setupBo(W, { kits: 1, code: 'AA' });
    await deliverManual(W, A.req);
    // Kit iPhone sẵn sàng: khác loại với kit hỏng.
    await go('ll', 'POST', '/api/hub/devices', { type: 'iphone', codes: 'IP1' });
    await go('l1', 'POST', '/api/hub/kits', { code: 'P1', kind: 'iphone', devices: 'IP1' });
    await go('l1', 'POST', `/api/hub/kits/${kit('P1').id}/submit`);
    await go('t1', 'POST', `/api/hub/jobs/${job({ type: 'check_kit', kit_id: kit('P1').id }).id}/done`, { result: { pass: true } });
    await go('t1', 'POST', `/api/hub/kits/${kit('KAA1').id}/faulty`, { reason: 'Không lên nguồn' });
    const sj = job({ type: 'swap_faulty', kit_id: kit('KAA1').id });
    const r1 = await call('l1', 'POST', `/api/hub/jobs/${sj.id}/done`, { result: { new_kit_id: kit('P1').id } });
    eq(r1.status, 409, 'đổi bằng kit khác loại → chặn');
    eq([kit('P1').status, kit('KAA1').status], ['ready', 'at_bo'], 'kit không đổi chỗ khi bị chặn');
    // BO BB: FO đã giao kit KBB1 (có ảnh) nhưng BO chưa xác nhận → kit vẫn "đang giao", điểm dừng chờ BO.
    const B = await setupBo(W, { kits: 1, code: 'BB' });
    const dj = job({ type: 'deliver', request_id: B.req.id });
    const t = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [dj.id], fo_id: U.fo1.id })).task;
    await go('fo1', 'POST', `/api/tasks/${t.id}/accept`);
    await go('fo1', 'POST', `/api/tasks/${t.id}/start`);
    const st = S.stops.find({ task_id: t.id }, { order: 'seq' })[0];
    h.clock.add(10 * MIN);
    await go('fo1', 'POST', `/api/stops/${st.id}/proof`, { photos: [JPEG], cards_out: st.exp_cards_out, cards_in: st.exp_cards_in, dev_out: st.exp_dev_out, dev_in: st.exp_dev_in, lat: st.lat, lon: st.lon });
    eq([kit('KBB1').status, S.stops.get(st.id).status, S.stops.get(st.id).bo_status], ['delivering', 'done', 'pending'], 'FO đã giao, BO chưa xác nhận');
    ok(h.core.hub.jobs.kitTrip(kit('KBB1').id), 'điểm dừng đã giao nhưng chờ BO xác nhận vẫn tính là kit đang trong chuyến');
    const r2 = await call('l1', 'POST', `/api/hub/jobs/${sj.id}/done`, { result: { new_kit_id: kit('KBB1').id } });
    eq(r2.status, 409, 'đổi bằng kit đang giao cho BO khác → chặn');
    eq([kit('KBB1').status, kit('KBB1').site_id], ['delivering', null], 'kit đang giao giữ nguyên');
    // BO BB xác nhận: launch của BB đi đúng như bình thường.
    const { token } = await go('l1', 'POST', `/api/stops/${st.id}/bo-link`);
    const bo = boDevice(h);
    await bo.call('POST', '/api/bo-link/view', { token });
    const s2 = S.stops.get(st.id);
    eq((await bo.call('POST', '/api/bo-link/confirm', { token, photos: [JPEG], cards_recv: s2.cards_out, cards_given: s2.cards_in, dev_recv: s2.dev_out, dev_given: s2.dev_in })).status, 200, 'BO BB xác nhận');
    eq([S.jobs.get(dj.id).status, kit('KBB1').status, B.site && S.sites.get(B.site.id).ops_status], ['done', 'at_bo', 'live'], 'việc giao của BB đóng, kit ở BB, BB đang ghi hình');
    inv('đổi kit bị chặn');
    // Danh sách kit thay chỉ có kit cùng loại, sẵn sàng; màn đổi kit có ô đếm phụ kiện.
    await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: 'MCCC1' });
    await go('ll', 'POST', '/api/hub/devices', { type: 'cm5', codes: 'CMCC1' });
    await go('l1', 'POST', '/api/hub/kits', { code: 'KCC1', kind: 'multicam', devices: 'MCCC1 CMCC1', acc: { hub_sac: 2 } });
    await go('l1', 'POST', `/api/hub/kits/${kit('KCC1').id}/submit`);
    await go('t1', 'POST', `/api/hub/jobs/${job({ type: 'check_kit', kit_id: kit('KCC1').id }).id}/done`, { result: { pass: true } });
    const d = await go('l1', 'GET', `/api/hub/jobs/${sj.id}`);
    eq(d.replacements.map((k) => k.code), ['KCC1'], 'kit thay đề xuất: cùng loại, sẵn sàng, không trong chuyến');
    ok((d.acc_types || []).some((x) => x.id === 'hub_sac'), 'màn đổi kit có danh mục phụ kiện để đếm');
    eq(await call('l1', 'POST', `/api/hub/jobs/${sj.id}/done`, { result: { new_kit_id: kit('KCC1').id, acc: { hub_sac: 0 } } }).then((r) => r.status), 200, 'đổi bằng kit cùng loại sẵn sàng tại VP');
    eq([kit('KCC1').status, kit('KCC1').site_id, kit('KAA1').status], ['at_bo', A.site.id, 'at_tech'], 'kit thay ở BO AA, kit hỏng về Tech');
    eq(kit('KAA1').acc, {}, 'kit hỏng ghi đúng phụ kiện thực nhận');
    eq(S.acc_moves.find({ kind: 'lost', kit_id: kit('KAA1').id }).map((m) => [m.type_id, m.delta]), [['hub_sac', -1]], 'thiếu 1 hub sạc ghi mất trong sổ kho');
    const rc = W.recon({ source: 'acc_recover' });
    eq(rc.map((x) => [x.team, x.level]), [['logistics', 'high']], 'thiếu phụ kiện khi đổi kit → Đối chiếu cho Logistics');
    ok(S.inbox.count({ user_id: U.ll.id, kind: 'recon' }) >= 1, 'Logistic Lead được báo');
    inv('đổi kit hỏng làm tay');
  });

  await group('Tắt bước Tech kiểm: gửi kit thu hồi đi thì việc check-in đóng theo', async () => {
    const W = await world(kind);
    const { go, call, S, kit, job, inv } = W;
    const { req, site, codes } = await setupBo(W, { kits: 1 });
    await deliverManual(W, req);
    await go('s1', 'POST', `/api/hub/outlets/${site.id}/end`, {});
    await go('l1', 'POST', `/api/hub/jobs/${job({ type: 'recover', site_id: site.id }).id}/done`, { result: {} });
    const k = kit(codes[0]);
    const ck = job({ type: 'checkin', kit_id: k.id });
    eq([k.status, ck.status], ['returned', 'open'], 'kit thu hồi chờ Tech check-in');
    await go('tl', 'PUT', '/api/hub/config', { checkBeforeShip: false });
    await go('l1', 'POST', `/api/hub/kits/${k.id}/submit`);
    eq(kit(codes[0]).status, 'ready', 'kit sẵn sàng ngay (không cần Tech kiểm)');
    eq(S.jobs.get(ck.id).status, 'cancelled', 'việc check-in không còn treo');
    eq((await call('t1', 'GET', '/api/hub/jobs', null, { view: 'mine' })).body.jobs.filter((j) => j.type === 'checkin').length, 0, 'không còn trong danh sách việc của Tech');
    inv('gửi kit thu hồi khi tắt bước kiểm');
  });

  await group('Lead điều chỉnh kit đang ở BO: phần gỡ ra không về kho rảnh', async () => {
    const W = await world(kind);
    const { go, call, S, kit, dev, job, acc, inv } = W;
    const { req, codes } = await setupBo(W, { kits: 1, extra: 1, acc: { hub_sac: 2 } });
    await deliverManual(W, req);
    const k = kit(codes[0]);
    const a0 = await acc('hub_sac');
    eq([a0.total, a0.outside, a0.free], [20, 2, 16], 'trước: 20 tổng, 2 ở BO, 16 rảnh');
    const r = await call('ll', 'PATCH', `/api/hub/kits/${k.id}`, { acc: { hub_sac: 1 }, remove: [dev('CMQ31').id], reason: 'FO báo BO đã tự tháo 1 hub sạc và CM5' });
    eq(r.status, 200, 'Lead điều chỉnh cho khớp thực tế');
    const a1 = await acc('hub_sac');
    eq([a1.total, a1.outside, a1.free], [19, 1, 16], 'hub sạc bớt ra ghi thiếu (tổng giảm), số rảnh không tăng');
    eq([dev('CMQ31').cond, dev('CMQ31').kit_id], ['lost', null], 'CM5 gỡ ra ghi thất lạc, không thành thiết bị rảnh');
    const sum = await go('ll', 'GET', '/api/hub/stock/summary');
    eq(sum.devices.find((d) => d.id === 'cm5').free, 0, 'tồn kho không đếm CM5 đó là rảnh');
    const rc = W.recon({ source: 'kit_adjust' });
    eq(rc.map((x) => [x.team, x.level]), [['logistics', 'high'], ['logistics', 'high']], 'thiết bị và phụ kiện thiếu vào Đối chiếu cho Logistics');
    eq(S.jobs.count({ type: 'swap_faulty', kit_id: k.id, status: ['open', 'doing'] }), 1, 'kit ở BO thiếu thiết bị chính → việc đổi kit');
    const spare = kit(codes[1]);
    await go('l1', 'POST', `/api/hub/kits/${spare.id}/reopen`, { reason: 'Thử gắn' });
    eq((await call('l1', 'PATCH', `/api/hub/kits/${spare.id}`, { add: 'CMQ31' })).status, 409, 'không gắn được CM5 đang thất lạc vào kit ở VP');
    inv('điều chỉnh không ghi giảm');
    // Ghi giảm có lý do: không vào Đối chiếu, thiết bị ghi ngừng dùng.
    const W2 = await world(kind);
    const B = await setupBo(W2, { kits: 1, acc: { hub_sac: 2 } });
    await deliverManual(W2, B.req);
    const k2 = W2.kit(B.codes[0]);
    const r2 = await W2.call('ll', 'PATCH', `/api/hub/kits/${k2.id}`, { acc: { hub_sac: 1 }, acc_writeoff: true, acc_reason: 'Hub sạc cháy, BO đã bỏ', remove: [W2.dev('MCQ31').id], dev_writeoff: true, reason: 'Multicam rơi vỡ tại BO' });
    eq(r2.status, 200, 'Lead ghi giảm có lý do');
    const b1 = await W2.acc('hub_sac');
    eq([b1.total, b1.free], [19, 18], 'ghi giảm 1 hub sạc, số rảnh giữ nguyên');
    eq([W2.dev('MCQ31').cond, W2.dev('MCQ31').kit_id], ['retired', null], 'multicam ghi ngừng dùng');
    eq(W2.recon({ source: 'kit_adjust' }).length, 0, 'đã ghi giảm có lý do thì không vào Đối chiếu');
    W2.inv('điều chỉnh có ghi giảm');
    // Kit đang trên đường giao: không gỡ thiết bị.
    const W3 = await world(kind);
    const C = await setupBo(W3, { kits: 1 });
    const dj = W3.job({ type: 'deliver', request_id: C.req.id });
    const t = (await W3.go('l1', 'POST', '/api/hub/dispatch', { job_ids: [dj.id], fo_id: W3.U.fo1.id })).task;
    await W3.go('fo1', 'POST', `/api/tasks/${t.id}/accept`);
    await W3.go('fo1', 'POST', `/api/tasks/${t.id}/start`);
    eq(W3.kit(C.codes[0]).status, 'delivering', 'kit đang giao');
    eq((await W3.call('ll', 'PATCH', `/api/hub/kits/${W3.kit(C.codes[0]).id}`, { remove: [W3.dev('CMQ31').id], reason: 'Thử gỡ' })).status, 409, 'kit đang giao: không gỡ thiết bị');
    W3.inv('kit đang giao');
  });

  await group('Sổ phụ kiện: Tech Lead không nhập số lượng phụ kiện qua file', async () => {
    const W = await world(kind);
    const { go, call, S, U } = W;
    const buf = buildXlsx([{ name: 'Phụ kiện', rows: [['Tên phụ kiện', 'Số lượng'], ['Hub sạc', 30]] }]);
    for (const who of ['tl', 'll']) {
      const parsed = await go(who, 'POST', '/api/hub/import/parse', { data: buf.toString('base64'), name: 'pk.xlsx' });
      const plan = parsed.sheets.map((s) => ({ sheet: s.index, target: s.guess.target, header_row: s.header_row, mapping: s.guess.mapping }));
      eq(plan.map((p) => p.target), ['acc'], 'nhận ra sheet phụ kiện');
      const r = await call(who, 'POST', '/api/hub/import/run', { token: parsed.token, plan, commit: true });
      eq(r.status, who === 'tl' ? 403 : 200, who === 'tl' ? 'Tech Lead nhập sheet phụ kiện → chặn' : 'Logistic Lead nhập sheet phụ kiện');
    }
    eq(S.acc_moves.count({ by_id: U.tl.id }), 0, 'sổ kho không có dòng của Tech Lead');
    eq(S.dev_types.get('hub_sac').total, 30, 'tổng hub sạc theo lượt nhập của Logistics');
    W.inv('nhập phụ kiện');
  });

  await group('Sự cố cũ: kit đã rời BO của sự cố thì không đổi / không báo hỏng, đưa vào Đối chiếu', async () => {
    const W = await world(kind);
    const { go, call, S, kit, job, inv, h } = W;
    const A = await setupBo(W, { kits: 1, code: 'AA' });
    await deliverManual(W, A.req);
    const k = kit('KAA1');
    const inc = (await go('s1', 'POST', '/api/hub/incidents', { site_id: A.site.id, kit_id: k.id, label: 'Quá nhiệt', text: 'Máy nóng' })).incident;
    await go('s1', 'POST', `/api/hub/outlets/${A.site.id}/end`, {});
    await go('l1', 'POST', `/api/hub/jobs/${job({ type: 'recover', site_id: A.site.id }).id}/done`, { result: {} });
    await go('t1', 'POST', `/api/hub/jobs/${job({ type: 'checkin', kit_id: k.id }).id}/done`, { result: { pass: true } });
    await go('l1', 'POST', `/api/hub/jobs/${job({ type: 'receive_back', kit_id: k.id }).id}/done`, { result: {} });
    h.clock.add(MIN);
    const rB = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-05', outlet: { name: 'Quán BB', code: 'BB', lat: 10.9, lon: 106.9, phone: '0909999888' }, swap_days: [1, 2, 3, 4, 5, 6, 7] })).request;
    await go('l1', 'POST', `/api/hub/requests/${rB.id}/assign`, { kit_ids: [k.id] });
    await deliverManual(W, rB);
    const bb = S.sites.find({ code: 'BB' }, { limit: 1 })[0];
    eq([kit('KAA1').status, kit('KAA1').site_id], ['at_bo', bb.id], 'kit KAA1 giờ ở BO BB');
    const r = await call('t1', 'POST', `/api/hub/incidents/${inc.id}/resolve`, { resolution: 'swap', note: 'Đã đổi máy hôm trước' });
    eq(r.status, 200, 'Tech đóng sự cố cũ');
    eq(S.incidents.get(inc.id).status, 'resolved', 'sự cố đã đóng');
    eq(kit('KAA1').fault || null, null, 'kit ở BO BB không bị gắn cờ lỗi');
    eq(S.jobs.count({ type: 'swap_faulty', status: ['open', 'doing'] }), 0, 'không sinh việc đổi kit ở BO BB');
    eq(W.recon({ source: 'incident' }).map((x) => [x.team, x.level]), [['tech', 'high']], 'đưa vào Đối chiếu cho Tech Lead');
    inv('đóng sự cố cũ');
    // Kit còn ở BO của sự cố: đổi máy như cũ.
    const inc2 = (await go('s1', 'POST', '/api/hub/incidents', { site_id: bb.id, kit_id: k.id, label: 'Quá nhiệt', text: 'Máy nóng lần nữa' })).incident;
    eq((await call('t1', 'POST', `/api/hub/incidents/${inc2.id}/resolve`, { resolution: 'swap', note: 'Cần đổi máy' })).status, 200, 'đóng sự cố mới bằng đổi máy');
    eq(S.jobs.count({ type: 'swap_faulty', kit_id: k.id, status: ['open', 'doing'] }), 1, 'kit còn ở BO của sự cố → việc đổi kit');
    inv('đổi máy đúng BO');
  });

  await group('Giao thiếu phụ kiện: yêu cầu hỗ trợ còn mở, việc giao phần còn lại', async () => {
    const W = await world(kind);
    const { go, call, S, job, U, inv } = W;
    const { req, site } = await setupBo(W, { kits: 1 });
    await deliverManual(W, req);
    await go('l1', 'POST', '/api/hub/acc/headstrap/move', { kind: 'in', qty: 1, reason: 'Có 1' });
    const r = (await go('s1', 'POST', `/api/hub/outlets/${site.id}/support`, { kind: 'extra_acc', note: 'Cần 3 headstrap', acc: { headstrap: 3 } })).request;
    const aj = job({ type: 'deliver_acc', request_id: r.id });
    eq((await call('l1', 'POST', `/api/hub/jobs/${aj.id}/done`, { result: { acc: { headstrap: 1 } } })).status, 200, 'giao 1 trên 3');
    ok(S.requests.get(r.id).status !== 'closed', 'yêu cầu hỗ trợ chưa đóng');
    const rest = S.jobs.find({ type: 'deliver_acc', request_id: r.id, status: ['open', 'doing'] });
    eq(rest.length, 1, 'có việc giao phần còn lại');
    eq(S.requests.get(r.id).need.acc, { headstrap: 2 }, 'yêu cầu còn cần 2 headstrap');
    ok(!S.inbox.find({ user_id: U.s1.id }).some((x) => x.text.includes('đã xử lý xong')), 'Sale chưa được báo xong');
    inv('giao thiếu phụ kiện');
    await go('l1', 'POST', '/api/hub/acc/headstrap/move', { kind: 'in', qty: 2, reason: 'Mua thêm' });
    await go('l1', 'POST', `/api/hub/jobs/${rest[0].id}/done`, { result: {} });
    eq(S.requests.get(r.id).status, 'closed', 'giao đủ phần còn lại thì yêu cầu đóng');
    eq(S.kits.find({ site_id: site.id, status: 'at_bo' })[0].acc.headstrap, 3, 'kit nhận đủ 3 headstrap');
    inv('giao đủ phụ kiện');
  });

  await group('Thiết bị "Đang sửa" được báo đã sửa từ màn sửa kit', async () => {
    const W = await world(kind);
    const { go, call, kit, dev, job, inv } = W;
    await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: 'MCR2' });
    await go('ll', 'POST', '/api/hub/devices', { type: 'cm5', codes: 'CMR2' });
    await go('l1', 'POST', '/api/hub/kits', { code: 'KR2', kind: 'multicam', devices: 'MCR2 CMR2' });
    await go('t1', 'POST', `/api/hub/kits/${kit('KR2').id}/faulty`, { reason: 'Không ghi hình', device_id: dev('MCR2').id });
    await go('t1', 'PATCH', `/api/hub/devices/${dev('MCR2').id}`, { cond: 'repairing' });
    eq(dev('MCR2').cond, 'repairing', 'thiết bị đang sửa');
    const rj = job({ type: 'repair', kit_id: kit('KR2').id });
    const r = await call('t1', 'POST', `/api/hub/jobs/${rj.id}/done`, { result: { devices: [{ id: dev('MCR2').id, ok: true }], note: 'Đã thay cáp' } });
    eq(r.status, 200, 'báo sửa xong');
    eq([dev('MCR2').cond, kit('KR2').status], ['ok', 'tech_done'], 'thiết bị về Tốt, kit chờ Logistics nhận lại');
    inv('sửa thiết bị đang sửa');
  });

  await group('Nhập file: kit ngừng dùng không giữ thiết bị, thiết bị mất / ngừng dùng không gắn vào kit', async () => {
    const W = await world(kind);
    const { go, call, S, kit, dev, inv } = W;
    const buf = buildXlsx([
      { name: 'Thiết bị', rows: [['Mã thiết bị', 'Loại', 'Tình trạng', 'Kit'], ['MC50', 'Multicam', 'Mất', ''], ['CM50', 'CM5', 'Ngừng dùng', ''], ['MC51', 'Multicam', 'Tốt', ''], ['CM51', 'CM5', 'Tốt', ''], ['MC52', 'Multicam', 'Mất', 'K52'], ['CM52', 'CM5', 'Tốt', 'K52']] },
      { name: 'Kit', rows: [['Mã kit', 'Loại kit', 'Trạng thái', 'Multicam', 'CM5'], ['K50', 'Multicam KIT', 'Sẵn sàng', 'MC50', 'CM50'], ['K51', 'Multicam KIT', 'Ngừng dùng', 'MC51', 'CM51'], ['K52', 'Multicam KIT', 'Sẵn sàng', '', '']] },
    ]);
    const parsed = await go('ll', 'POST', '/api/hub/import/parse', { data: buf.toString('base64'), name: 'kho.xlsx' });
    const plan = parsed.sheets.map((s) => ({ sheet: s.index, target: s.guess.target, header_row: s.header_row, mapping: s.guess.mapping }));
    eq(plan.map((p) => p.target), ['devices', 'kits'], 'nhận ra sheet thiết bị và sheet kit');
    await go('ll', 'POST', '/api/hub/import/run', { token: parsed.token, plan, commit: true });
    const devs = (c) => S.devices.find({ kit_id: kit(c).id }).map((d) => d.code).sort();
    eq([kit('K51').status, devs('K51')], ['retired', []], 'kit ngừng dùng không giữ thiết bị');
    eq(devs('K50'), [], 'thiết bị mất / ngừng dùng không gắn vào kit');
    eq(kit('K50').status, 'preparing', 'kit ghi sẵn sàng mà không có thiết bị dùng được → đang chuẩn bị');
    eq([kit('K52').status, devs('K52')], ['preparing', ['CM52']], 'thiết bị mất ở cột kit của sheet thiết bị cũng không gắn');
    const texts = W.recon().map((x) => x.text).join(' | ');
    for (const c of ['MC50', 'CM50', 'MC51', 'CM51', 'MC52', 'K50']) ok(texts.includes(c), `Đối chiếu có nhắc ${c}`);
    const sum = await go('ll', 'GET', '/api/hub/stock/summary');
    const mc = sum.devices.find((d) => d.id === 'multicam');
    eq([mc.free, mc.lost], [1, 2], 'MC51 rảnh thật, 2 multicam thất lạc');
    await go('l1', 'POST', '/api/hub/kits', { code: 'K60', kind: 'multicam' });
    eq((await call('l1', 'PATCH', `/api/hub/kits/${kit('K60').id}`, { add: 'MC51' })).status, 200, 'MC51 rảnh thì gắn được vào kit mới');
    eq(dev('MC50').kit_id, null, 'MC50 không nằm trong kit nào');
    inv('nhập kit và thiết bị');
  });

  await group('Mã thiết bị không trùng mã thẻ nhớ (thêm và đổi mã)', async () => {
    const W = await world(kind);
    const { go, call, dev, inv } = W;
    await go('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: 'A100 A101' });
    const a = await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: 'A100 MC9' });
    eq([a.added, a.duplicates], [1, ['A100']], 'thêm multicam trùng mã thẻ → bỏ qua và báo lại');
    await go('ll', 'POST', '/api/hub/devices', { type: 'cm5', codes: 'C200' });
    eq((await call('l1', 'PATCH', `/api/hub/devices/${dev('C200').id}`, { code: 'A101' })).status, 409, 'đổi mã thiết bị thành mã thẻ → chặn');
    eq(dev('C200').code, 'C200', 'mã thiết bị giữ nguyên');
    // Sheet kit tự tạo thiết bị chưa có trong kho: không tạo khi mã đang là mã thẻ.
    const buf = buildXlsx([{ name: 'Kit', rows: [['Mã kit', 'Loại kit', 'Trạng thái', 'Multicam', 'CM5'], ['K70', 'Multicam KIT', 'Đang chuẩn bị', 'A100', 'A101']] }]);
    const parsed = await go('ll', 'POST', '/api/hub/import/parse', { data: buf.toString('base64'), name: 'kit.xlsx' });
    const plan = parsed.sheets.map((s) => ({ sheet: s.index, target: s.guess.target, header_row: s.header_row, mapping: s.guess.mapping }));
    eq(plan.map((p) => p.target), ['kits'], 'nhận ra sheet kit');
    await go('ll', 'POST', '/api/hub/import/run', { token: parsed.token, plan, commit: true });
    eq(W.S.devices.find({ kit_id: W.kit('K70').id }).map((d) => d.code), [], 'sheet kit không tạo thiết bị trùng mã thẻ');
    eq(W.S.devices.count({ code: 'A100' }) + W.S.devices.count({ code: 'A101' }), 0, 'không có thiết bị mang mã thẻ');
    const texts = W.recon().map((x) => x.text).join(' | ');
    ok(texts.includes('A100') && texts.includes('A101'), 'Đối chiếu có nhắc mã trùng');
    inv('trùng mã');
  });
}

await suite('memory');
await suite('sqlite');
summary('fix.stock');
