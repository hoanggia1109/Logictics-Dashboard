// fix.integration.test.mjs — kiểm hồi quy cho đợt rà soát chéo sau khi gộp các nhánh sửa:
// kết thúc BO khi kit giao dở / kit còn trên đường, việc chờ Lead đối chiếu sau chuyến (không huỷ kết thúc, không huỷ đổi kit, không tự giao, không bắt đầu),
// Sale xem mọi BO chỉ được xem, một điểm không thu cùng kit hai lần, nhận sự cố tính hạn riêng như nhận việc, thống kê FO chỉ Lead,
// trả việc khi vắng giữ việc của Lead / việc vướng, dời launch kéo theo hạn riêng, thẻ do Quản trị nhập tách khỏi điểm team,
// đúng hạn một nguồn số, định mức việc giao tay theo team, nhật ký thẻ không lộ người nhập, đếm BO chờ launch, quota BO đang thu hồi, giờ theo kit.
// Mỗi nhóm chạy 2 lần: kho bộ nhớ và kho SQLite; sau các bước chính chạy bộ kiểm bất biến.
import { mk, boDevice, ok, eq, group, summary, JPEG } from './harness.mjs';
import { checkInvariants } from './invariants.mjs';

const MIN = 60000;
const VN = (date, hm) => Date.parse(`${date}T${hm}:00+07:00`);
const VP = { name: 'Văn phòng Atlas', type: 'office', lat: 10.7769, lon: 106.7009 };
const Q3 = { name: 'BO Quận 3', code: 'Q3', lat: 10.7835, lon: 106.6869, contact: 'Chị Hoa', phone: '0901111222', address: '12 Võ Văn Tần, Quận 3' };
const DAYS = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];

async function world(kind, opt = {}) {
  const h = mk(kind);
  h.clock.set(opt.t ?? VN('2026-10-05', '08:30')); // thứ Hai W41
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
  const at = (date, hm) => h.clock.set(VN(date, hm));
  const seen = (...us) => { for (const u of us) h.core.hub.K.hooks.onSeen(h.byName(u), h.clock.now()); };
  const tickAt = (date, hm) => { at(date, hm); h.core.tick(); };
  const inv = (label) => { const v = checkInvariants(h.store); ok(!v.length, `bất biến sau "${label}": ${v.join(' | ')}`); return v; };
  const job = (where) => h.store.jobs.find(where, { order: 'id', desc: true, limit: 1 })[0] || null;
  const kit = (code) => h.store.kits.find({ code }, { limit: 1 })[0];
  const site = (code) => h.store.sites.find({ code }, { limit: 1 })[0];
  const uname = (id) => (id ? h.store.users.get(id).username : null);
  const req = (id) => h.store.requests.get(id);
  const openRecon = (prefix) => h.store.recon.find({ status: 'open' }).filter((r) => String(r.ref).startsWith(prefix));
  if (opt.roster) {
    for (const [ld, us] of [['ll', ['l1', 'l2']], ['tl', ['t1', 't2']]]) await go(ld, 'PUT', '/api/hub/roster', { rows: us.flatMap((u) => DAYS.map((date) => ({ user_id: U[u].id, date, shift: 'HC' }))) });
  }
  return { h, U, go, call, st, at, seen, tickAt, inv, job, kit, site, uname, req, openRecon };
}

/** FO chạy chuyến: nhận, bắt đầu, xác nhận từng điểm; BO xác nhận qua link (bo: số BO báo, mặc định khớp FO). */
async function runTrip(W, taskId, perStop = {}, opt = {}) {
  const { h, go } = W;
  if (!opt.started) { await go('fo1', 'POST', `/api/tasks/${taskId}/accept`); await go('fo1', 'POST', `/api/tasks/${taskId}/start`); }
  for (const s of h.store.stops.find({ task_id: taskId }, { order: 'seq' })) {
    if (!['pending', 'arrived'].includes(h.store.stops.get(s.id).status)) continue;
    h.clock.add(15 * MIN);
    const c = perStop[s.seq] || {};
    const counts = { cards_out: c.cards_out ?? s.exp_cards_out, cards_in: c.cards_in ?? s.exp_cards_in, dev_out: c.dev_out ?? s.exp_dev_out, dev_in: c.dev_in ?? s.exp_dev_in };
    await go('fo1', 'POST', `/api/stops/${s.id}/proof`, { photos: s.is_return ? [] : [JPEG], ...counts, lat: s.lat, lon: s.lon });
    if (h.store.stops.get(s.id).bo_status === 'pending') {
      const { token } = await go('ll', 'POST', `/api/stops/${s.id}/bo-link`);
      const bo = boDevice(h);
      await bo.call('POST', '/api/bo-link/view', { token });
      const b = c.bo || {};
      const r = await bo.call('POST', '/api/bo-link/confirm', { token, photos: [JPEG], cards_recv: b.cards_recv ?? counts.cards_out, cards_given: b.cards_given ?? counts.cards_in, dev_recv: b.dev_recv ?? counts.dev_out, dev_given: b.dev_given ?? counts.dev_in });
      if (r.status !== 200) throw new Error('BO xác nhận lỗi: ' + JSON.stringify(r.body));
    }
  }
  return h.store.tasks.get(taskId);
}
/** Văn phòng, n kit đủ thiết bị (K01…), thẻ SD001…; trả về điểm văn phòng. */
async function stock(W, n, cards = 0) {
  const { go } = W;
  const vp = (await go('ll', 'POST', '/api/sites', VP)).site;
  const ids = Array.from({ length: n }, (_, i) => String(i + 1).padStart(2, '0'));
  await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: ids.map((i) => 'MC' + i).join(' ') });
  await go('ll', 'POST', '/api/hub/devices', { type: 'cm5', codes: ids.map((i) => 'CM' + i).join(' ') });
  for (const i of ids) await go('ll', 'POST', '/api/hub/kits', { code: 'K' + i, kind: 'multicam', devices: `MC${i} CM${i}` });
  if (cards) await go('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: Array.from({ length: cards }, (_, i) => 'SD' + String(i + 1).padStart(3, '0')).join(' ') });
  return vp;
}
/** Gán kit cho yêu cầu, gửi kiểm, Tech Lead kiểm đạt. */
async function prep(W, reqId, codes) {
  const { go, kit, job } = W;
  await go('ll', 'POST', `/api/hub/requests/${reqId}/assign`, { kit_ids: codes.map((c) => kit(c).id) });
  for (const c of codes) {
    await go('ll', 'POST', `/api/hub/kits/${kit(c).id}/submit`);
    await go('tl', 'POST', `/api/hub/jobs/${job({ type: 'check_kit', kit_id: kit(c).id }).id}/done`, { result: { pass: true } });
  }
}
/** Kit đã kiểm, chưa gán yêu cầu (sẵn sàng tại VP). */
async function ready(W, codes) {
  for (const c of codes) {
    await W.go('ll', 'POST', `/api/hub/kits/${W.kit(c).id}/submit`);
    await W.go('tl', 'POST', `/api/hub/jobs/${W.job({ type: 'check_kit', kit_id: W.kit(c).id }).id}/done`, { result: { pass: true } });
  }
}
const launchReq = async (W, n, date = '2026-10-05') => (await W.go('s1', 'POST', '/api/hub/requests', { need: { multicam: n }, launch_date: date, outlet: Q3, swap_days: '1,2,3,4,5,6,7', swap_from: '09:00', swap_to: '11:00' })).request;
/** BO Q3 ghi hình với K01 (thẻ SD001–002), K02 / K03 sẵn sàng. */
async function liveBO(W) {
  const vp = await stock(W, 3, 40);
  const r = await launchReq(W, 1);
  await prep(W, r.id, ['K01']);
  await W.go('ll', 'POST', `/api/hub/jobs/${W.job({ type: 'deliver', request_id: r.id }).id}/done`, { result: { doc_code: 'BB-01', cards_out: ['SD001', 'SD002'] } });
  await ready(W, ['K02', 'K03']);
  return { vp, req: r, q3: W.site('Q3') };
}
/** Việc đổi kit hỏng K01 → K02 qua chuyến; BO báo đưa FO 0 thiết bị → việc đổi kit chờ Logistic Lead đối chiếu. */
async function heldSwap(W, vp, q3) {
  const { go, job, kit, U } = W;
  const sup = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'swap_device', kit_id: kit('K01').id, label: 'Không ghi hình', note: 'Máy không ghi' })).request;
  const sw = job({ type: 'swap_faulty', kit_id: kit('K01').id });
  const t = (await go('ll', 'POST', '/api/hub/dispatch', { job_ids: [sw.id], fo_id: U.fo1.id, office_site_id: vp.id, swap_kits: { [sw.id]: kit('K02').id } })).task;
  await runTrip(W, t.id, { 2: { bo: { dev_given: 0 } } });
  return { sup, sw: W.h.store.jobs.get(sw.id) };
}

async function suite(kind) {
  console.log(`\n── Kho ${kind === 'sqlite' ? 'SQLite' : 'bộ nhớ'} ──`);

  // ───────── F1: kết thúc BO khi kit giao dở ─────────
  await group('F1: launch giao 1/2 kit rồi kết thúc ngay — kit chưa giao về kho, việc giao phần còn lại huỷ, thu hồi xong BO kết thúc sạch', async () => {
    const W = await world(kind);
    const { h, go, inv, job, kit, site, req } = W;
    await stock(W, 2);
    const r = await launchReq(W, 2);
    await prep(W, r.id, ['K01', 'K02']);
    await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'deliver', request_id: r.id }).id}/done`, { result: { doc_code: 'BB-01', kit_ids: [kit('K01').id], skip_cards: true } });
    const rest = job({ type: 'deliver', request_id: r.id, status: 'open' });
    ok(!!rest, 'có việc giao phần còn lại');
    eq(req(r.id).status, 'delivering', 'yêu cầu launch đang giao dở');
    inv('giao 1/2 kit');
    const end = (await go('s1', 'POST', `/api/hub/outlets/${site('Q3').id}/end`, { note: 'Hết hợp đồng' })).request;
    eq([kit('K02').status, kit('K02').request_id], ['ready', null], 'kit chưa giao trả về sẵn sàng tại VP, bỏ gán yêu cầu');
    eq(h.store.jobs.get(rest.id).status, 'cancelled', 'việc giao phần còn lại huỷ');
    eq(req(r.id).status, 'ending', 'yêu cầu launch sang đang thu hồi');
    inv('kết thúc khi giao dở');
    await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'recover', request_id: end.id }).id}/done`, { result: {} });
    eq([site('Q3').ops_status, req(r.id).status, req(end.id).status], ['ended', 'closed', 'closed'], 'thu hồi xong: BO kết thúc, các yêu cầu đóng');
    eq(h.store.jobs.count({ type: 'deliver', status: ['open', 'doing'] }), 0, 'không còn việc giao nào treo');
    inv('thu hồi xong');
  });

  await group('F1: huỷ kết thúc sau khi giao dở — trạng thái yêu cầu tính lại từ kit, không còn kit giữ chỗ', async () => {
    const W = await world(kind);
    const { h, go, inv, job, kit, site, req } = W;
    await stock(W, 2);
    const r = await launchReq(W, 2);
    await prep(W, r.id, ['K01', 'K02']);
    await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'deliver', request_id: r.id }).id}/done`, { result: { doc_code: 'BB-01', kit_ids: [kit('K01').id], skip_cards: true } });
    const end = (await go('s1', 'POST', `/api/hub/outlets/${site('Q3').id}/end`, { note: 'Hết hợp đồng' })).request;
    await go('s1', 'POST', `/api/hub/requests/${end.id}/cancel`, { reason: 'Khách đổi ý' });
    eq([site('Q3').ops_status, req(r.id).status], ['live', 'live'], 'BO ghi hình tiếp, yêu cầu launch tính lại = đang ghi hình (mọi kit còn gán đều ở BO)');
    eq(kit('K02').status, 'ready', 'kit chưa giao vẫn ở kho');
    eq(h.store.jobs.count({ type: 'deliver', request_id: r.id, status: ['open', 'doing'] }), 0, 'không còn việc giao treo');
    ok(h.store.hub_log.find({ entity: 'request', entity_id: r.id, action: 'status' }).some((l) => l.data && l.data.from === 'ending' && l.data.to === 'live'), 'nhật ký yêu cầu ghi bước tính lại');
    inv('huỷ kết thúc');
  });

  await group('F1: thêm kit giao dở rồi kết thúc — yêu cầu thêm kit đóng, kit chưa giao về kho, không giao tiếp tới BO đã kết thúc', async () => {
    const W = await world(kind);
    const { h, go, call, inv, job, kit, req } = W;
    const { q3 } = await liveBO(W);
    const ak = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'add_kit', need: { multicam: 2 }, launch_date: '2026-10-05', note: 'Thêm hai máy' })).request;
    await go('ll', 'POST', `/api/hub/requests/${ak.id}/assign`, { kit_ids: [kit('K02').id, kit('K03').id] });
    await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'deliver', request_id: ak.id }).id}/done`, { result: { doc_code: 'BB-02', kit_ids: [kit('K02').id], skip_cards: true } });
    const rest = job({ type: 'deliver', request_id: ak.id, status: 'open' });
    eq(req(ak.id).status, 'delivering', 'yêu cầu thêm kit đang giao dở');
    const end = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, { note: 'Hết hợp đồng' })).request;
    eq(req(ak.id).status, 'closed', 'yêu cầu thêm kit đóng khi BO kết thúc');
    eq([kit('K03').status, kit('K03').request_id], ['ready', null], 'kit chưa giao về sẵn sàng');
    eq(h.store.jobs.get(rest.id).status, 'cancelled', 'việc giao phần còn lại huỷ');
    inv('kết thúc khi thêm kit dở');
    await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'recover', request_id: end.id }).id}/done`, { result: {} });
    eq(W.site('Q3').ops_status, 'ended', 'thu hồi xong BO kết thúc');
    eq((await call('ll', 'POST', `/api/hub/jobs/${rest.id}/done`, { result: { doc_code: 'BB-03', skip_cards: true } })).status, 409, 'việc giao đã huỷ không giao tới BO đã kết thúc được');
    eq(W.site('Q3').ops_status, 'ended', 'BO vẫn kết thúc');
    inv('sau thu hồi');
  });

  await group('F1: kit còn trên chuyến FO khi kết thúc — giữ việc, Đối chiếu cho Logistics; BO chưa kết thúc tới khi kit có chỗ thật', async () => {
    const W = await world(kind);
    const { h, U, go, inv, job, kit, site, req, openRecon } = W;
    const vp = await stock(W, 2);
    const r = await launchReq(W, 2);
    await prep(W, r.id, ['K01', 'K02']);
    await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'deliver', request_id: r.id }).id}/done`, { result: { doc_code: 'BB-01', kit_ids: [kit('K01').id], skip_cards: true } });
    const rest = job({ type: 'deliver', request_id: r.id, status: 'open' });
    const t = (await go('ll', 'POST', '/api/hub/dispatch', { job_ids: [rest.id], fo_id: U.fo1.id, office_site_id: vp.id })).task;
    await go('fo1', 'POST', `/api/tasks/${t.id}/accept`); await go('fo1', 'POST', `/api/tasks/${t.id}/start`);
    eq(kit('K02').status, 'delivering', 'K02 đang theo FO');
    const end = (await go('s1', 'POST', `/api/hub/outlets/${site('Q3').id}/end`, { note: 'Hết hợp đồng' })).request;
    eq(h.store.jobs.get(rest.id).status, 'doing', 'việc giao trên chuyến đang chạy giữ nguyên');
    eq(req(r.id).status, 'delivering', 'yêu cầu launch còn kit trên đường: giữ "đang giao"');
    eq(openRecon(`endkit:${r.id}`).length, 1, 'Đối chiếu cho Logistics: kit còn trên đường khi BO kết thúc');
    inv('kết thúc khi kit trên đường');
    await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'recover', request_id: end.id }).id}/done`, { result: {} });
    eq(site('Q3').ops_status, 'ending', 'thu hồi K01 xong nhưng K02 chưa rõ chỗ: BO chưa kết thúc');
    inv('thu hồi phần ở BO');
    await runTrip(W, t.id, {}, { started: true });
    eq([kit('K02').status, site('Q3').ops_status, req(r.id).status], ['at_bo', 'ending', 'ending'], 'FO giao K02 tới BO đang thu hồi: ghi theo thực tế, yêu cầu đang thu hồi');
    const rec2 = job({ type: 'recover', site_id: site('Q3').id, status: 'open' });
    ok(!!rec2, 'có việc thu hồi phần vừa giao tới');
    inv('kit tới BO đang thu hồi');
    await go('ll', 'POST', `/api/hub/jobs/${rec2.id}/done`, { result: {} });
    eq([site('Q3').ops_status, req(r.id).status], ['ended', 'closed'], 'thu hồi hết: BO kết thúc, yêu cầu đóng');
    inv('kết thúc');
  });

  // ───────── F2: việc thu hồi chờ đối chiếu ─────────
  await group('F2: FO đã thu một phần (việc thu hồi chờ Lead đối chiếu) — Sale không huỷ kết thúc được, Lead làm tay theo thực tế', async () => {
    const W = await world(kind);
    const { h, U, go, call, inv, job, kit, site } = W;
    const vp = await stock(W, 2, 10);
    const r = await launchReq(W, 2);
    await prep(W, r.id, ['K01', 'K02']);
    await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'deliver', request_id: r.id }).id}/done`, { result: { doc_code: 'BB-01', skip_cards: true } });
    const end = (await go('s1', 'POST', `/api/hub/outlets/${site('Q3').id}/end`, { note: 'Hết hợp đồng' })).request;
    const rec = job({ type: 'recover', request_id: end.id });
    const t = (await go('ll', 'POST', '/api/hub/dispatch', { job_ids: [rec.id], fo_id: U.fo1.id, office_site_id: vp.id })).task;
    await runTrip(W, t.id, { 2: { dev_in: 1 } });
    ok(!!h.core.hub.jobs.heldRecon(rec.id), 'việc thu hồi chờ Lead đối chiếu');
    eq((await go('s1', 'GET', `/api/hub/requests/${end.id}`)).can_cancel, false, 'nút huỷ kết thúc ẩn');
    const c = await call('s1', 'POST', `/api/hub/requests/${end.id}/cancel`, { reason: 'Khách đổi ý' });
    eq([c.status, c.body.error], [409, 'bad_state'], 'Sale huỷ kết thúc → 409');
    eq([site('Q3').ops_status, h.store.jobs.get(rec.id).status], ['ending', 'open'], 'BO vẫn đang thu hồi, việc thu hồi còn để Lead làm tay');
    inv('chặn huỷ kết thúc');
    await go('ll', 'POST', `/api/hub/jobs/${rec.id}/done`, { result: { kit_ids: [kit('K01').id] } });
    ok(!h.core.hub.jobs.heldRecon(rec.id), 'Lead làm tay xong, dòng đối chiếu không còn giữ việc');
    eq([kit('K01').status, kit('K02').status], ['returned', 'at_bo'], 'chỉ kit thật đã thu về kho');
    inv('Lead làm tay');
  });

  await group('F2: BO kết thúc khi việc đổi kit đang chờ đối chiếu — việc giữ lại, Lead ghi đúng lần đổi thật', async () => {
    const W = await world(kind);
    const { h, go, inv, job, kit } = W;
    const { vp, q3 } = await liveBO(W);
    const { sw } = await heldSwap(W, vp, q3);
    ok(!!h.core.hub.jobs.heldRecon(sw.id), 'việc đổi kit chờ đối chiếu');
    const end = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, { note: 'Hết hợp đồng' })).request;
    eq(h.store.jobs.get(sw.id).status, 'open', 'kết thúc BO không huỷ việc đổi kit đang chờ đối chiếu');
    ok(!!kit('K01').fault, 'cờ lỗi của kit hỏng giữ nguyên');
    inv('kết thúc khi đổi kit chờ đối chiếu');
    await go('ll', 'POST', `/api/hub/jobs/${sw.id}/done`, { result: { new_kit_id: kit('K02').id } });
    eq([kit('K01').status, kit('K02').status, kit('K02').site_id], ['at_tech', 'at_bo', q3.id], 'Lead ghi lần đổi thật ở BO đang thu hồi');
    ok(!h.core.hub.jobs.heldRecon(sw.id), 'dòng đối chiếu tự đóng');
    await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'recover', request_id: end.id }).id}/done`, { result: {} });
    eq(W.site('Q3').ops_status, 'ended', 'thu hồi xong');
    inv('thu hồi xong');
  });

  // ───────── F3: việc đổi kit chờ đối chiếu ─────────
  await group('F3: việc đổi kit chờ đối chiếu — không kết luận "không phải sự cố", không huỷ sự cố / yêu cầu đổi máy; Lead làm tay được', async () => {
    const W = await world(kind);
    const { h, go, call, inv, kit, req } = W;
    const { vp, q3 } = await liveBO(W);
    const { sup, sw } = await heldSwap(W, vp, q3);
    const r1 = await call('tl', 'POST', `/api/hub/incidents/${sw.incident_id}/resolve`, { resolution: 'invalid' });
    eq([r1.status, r1.body.error], [409, 'held'], 'Tech Lead kết luận "không phải sự cố" khi việc đổi kit chờ đối chiếu → 409');
    const r2 = await call('s1', 'POST', `/api/hub/requests/${sup.id}/cancel`, { reason: 'Máy chạy lại rồi' });
    eq([r2.status, r2.body.error], [409, 'held'], 'Sale huỷ yêu cầu đổi máy → 409');
    const r3 = await call('tl', 'POST', `/api/hub/incidents/${sw.incident_id}/cancel`, { reason: 'Báo nhầm' });
    eq([r3.status, r3.body.error], [409, 'held'], 'Tech Lead huỷ sự cố → 409');
    eq([h.store.jobs.get(sw.id).status, !!kit('K01').fault, kit('K02').status, req(sup.id).status], ['open', true, 'ready', 'preparing'], 'việc, cờ lỗi, kit thay, yêu cầu giữ nguyên');
    inv('chặn khi chờ đối chiếu');
    await go('ll', 'POST', `/api/hub/jobs/${sw.id}/done`, { result: { new_kit_id: kit('K02').id } });
    eq([kit('K01').status, kit('K02').status, req(sup.id).status], ['at_tech', 'at_bo', 'closed'], 'Lead làm tay theo thực tế; yêu cầu đóng');
    inv('Lead làm tay');
  });

  // ───────── F4 ─────────
  await group('F4: Sale Lead xem mọi BO chỉ được xem — không báo sự cố ở BO của Sale khác', async () => {
    const W = await world(kind);
    const { h, go, call, kit } = W;
    const { q3 } = await liveBO(W);
    await go('ad', 'PUT', '/api/hub/config', { saleSeesAll: true });
    const body = { site_id: q3.id, kit_id: kit('K01').id, label: 'Không ghi hình', text: 'Máy không ghi' };
    const r = await call('s2', 'POST', '/api/hub/incidents', body);
    eq(r.status, 403, 'Sale khác báo sự cố ở BO không phải của mình → 403');
    eq(h.store.incidents.count({}), 0, 'không có sự cố nào được tạo');
    eq((await call('s1', 'POST', '/api/hub/incidents', body)).status, 200, 'Sale phụ trách báo được');
  });

  // ───────── F5 ─────────
  await group('F5: một điểm dừng không được thu cùng một kit hai lần (đổi kit hỏng + thu hồi)', async () => {
    const W = await world(kind);
    const { h, U, go, call, inv, job, kit } = W;
    const { vp, q3 } = await liveBO(W);
    const end = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, { date: '2026-10-09', note: 'Hết hợp đồng' })).request;
    await go('l1', 'POST', `/api/hub/kits/${kit('K01').id}/faulty`, { reason: 'Không lên nguồn' });
    const sw = job({ type: 'swap_faulty', kit_id: kit('K01').id }), rec = job({ type: 'recover', request_id: end.id });
    const d = await call('ll', 'POST', '/api/hub/dispatch', { job_ids: [sw.id, rec.id], fo_id: U.fo1.id, office_site_id: vp.id, swap_kits: { [sw.id]: kit('K02').id } });
    eq([d.status, d.body.error], [409, 'same_kit'], 'xếp đổi kit hỏng và thu hồi cùng kit ở một điểm → 409');
    eq(h.store.tasks.count({}), 0, 'không tạo chuyến');
    eq((await call('ll', 'POST', '/api/hub/dispatch', { job_ids: [rec.id], fo_id: U.fo1.id, office_site_id: vp.id })).status, 200, 'chỉ xếp việc thu hồi thì được');
    inv('sau khi xếp');
  });

  // ───────── PEOPLE-2 ─────────
  await group('PEOPLE-2: nhận sự cố bằng nút "Nhận xử lý" tính hạn riêng như nhận việc', async () => {
    const out = {};
    for (const path of ['claim', 'ack']) {
      const W = await world(kind, { t: VN('2026-10-05', '06:00') });
      const { h, U, go, at, seen } = W;
      await go('tl', 'PUT', '/api/hub/roster', { rows: [{ user_id: U.t1.id, date: '2026-10-05', shift: 'HC' }, { user_id: U.t1.id, date: '2026-10-06', shift: 'HC' }, { user_id: U.t2.id, date: '2026-10-06', shift: 'C' }] });
      const s = (await go('ll', 'POST', '/api/sites', { name: 'BO Quận 3', type: 'bo', lat: 10.7835, lon: 106.6869 })).site;
      at('2026-10-05', '08:35'); seen('t1');
      at('2026-10-05', '09:00');
      const inc = (await go('ll', 'POST', '/api/hub/incidents', { site_id: s.id, label: 'Khác', text: 'Máy không lên' })).incident;
      const j = h.store.jobs.find({ incident_id: inc.id })[0];
      at('2026-10-06', '08:35'); seen('t1');
      at('2026-10-06', '08:40');
      await go('t1', 'POST', `/api/hub/jobs/${j.id}/release`, { reason: 'Không kịp làm, nhờ người khác' });
      at('2026-10-06', '08:45');
      if (path === 'ack') await go('t2', 'POST', `/api/hub/incidents/${inc.id}/ack`);
      else { await go('t2', 'POST', `/api/hub/jobs/${j.id}/claim`); await go('t2', 'POST', `/api/hub/jobs/${j.id}/start`); }
      const held = h.store.jobs.get(j.id);
      at('2026-10-06', '10:00');
      await go('t2', 'POST', `/api/hub/incidents/${inc.id}/resolve`, { resolution: 'no_recover', note: 'Đã xử lý tại chỗ' });
      const b = (await go('t2', 'GET', `/api/hub/jobs/${j.id}`)).job;
      at('2026-10-12', '09:00');
      const p = await go('tl', 'GET', '/api/hub/perf', null, { team: 'tech', period: 'week', key: '2026-W41' });
      const r = p.rows.find((x) => x.user.id === U.t2.id);
      out[path] = { assign_by: held.assign_by, due_mine: held.due_mine, assigned_at: held.assigned_at, late_mine: b.late_mine, on_time: r.on_time, with_due: r.with_due };
    }
    eq(out.ack, out.claim, 'hai đường nhận cho cùng kết quả (người nhận, hạn riêng, đúng hạn)');
    eq([out.ack.assign_by, out.ack.late_mine, out.ack.on_time], ['self', false, 1], 'người nhận sau không bị tính trễ phần trước khi có việc');
  });

  // ───────── PEOPLE-3 ─────────
  await group('PEOPLE-3: việc chờ Lead đối chiếu không tự giao, nhân viên không bắt đầu / nhận được, không tính vào tải', async () => {
    const W = await world(kind, { roster: true });
    const { h, U, go, call, seen, job, kit, site } = W;
    const vp = await stock(W, 2, 10);
    seen('l1', 'l2', 't1', 't2');
    const r = await launchReq(W, 2);
    await prep(W, r.id, ['K01', 'K02']);
    const dlv = job({ type: 'deliver', request_id: r.id });
    const t = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [dlv.id], fo_id: U.fo1.id, office_site_id: vp.id })).task;
    await runTrip(W, t.id, { 2: { dev_out: 1 } });
    const held = h.store.jobs.get(dlv.id);
    ok(!!h.core.hub.jobs.heldRecon(held.id) && held.status === 'open', 'việc giao chờ đối chiếu');
    const holder = W.uname(held.assignee_id), other = holder === 'l1' ? 'l2' : 'l1';
    const s1 = await call(holder, 'POST', `/api/hub/jobs/${held.id}/start`);
    eq([s1.status, s1.body.error], [403, 'held'], 'người đang giữ việc không bắt đầu được việc chờ Lead');
    eq(h.store.jobs.get(held.id).status, 'open', 'việc vẫn chờ làm');
    eq(h.core.hub.jobs.loadOf(U[holder].id), 0, 'việc chờ Lead không tính vào tải của người đang giữ');
    await go(holder, 'POST', `/api/hub/jobs/${held.id}/release`, { reason: 'Chờ Lead đối chiếu' });
    eq(h.store.jobs.get(held.id).assignee_id, null, 'trả về: hệ thống không tự giao việc chờ Lead cho người khác');
    W.h.clock.add(2 * MIN); W.h.core.tick();
    eq(h.store.jobs.get(held.id).assignee_id, null, 'nhịp định kỳ cũng không tự giao');
    eq(h.store.inbox.count({ user_id: U[other].id, link: `job:${held.id}` }), 0, 'nhân viên khác không nhận "Việc mới" cho việc không làm được');
    const c = await call(other, 'POST', `/api/hub/jobs/${held.id}/claim`);
    eq([c.status, c.body.error], [403, 'held'], 'nhân viên không nhận việc chờ Lead');
    eq((await call('ll', 'POST', `/api/hub/jobs/${held.id}/claim`)).status, 200, 'Logistic Lead nhận được');
    void site; void kit;
  });

  // ───────── PEOPLE-4 ─────────
  await group('PEOPLE-4: thống kê từng FO ở Rider Live chỉ Logistic Lead và Quản trị xem', async () => {
    const W = await world(kind);
    const { st } = W;
    const q = { from: '2026-10-05', to: '2026-10-05' };
    eq(await st('l1', 'GET', '/api/stats', null, q), 403, 'Logistic Executive không xem thống kê từng FO');
    eq(await st('l1', 'GET', '/api/stats.csv', null, q), 403, 'Logistic Executive không xuất CSV thống kê FO');
    eq(await st('ll', 'GET', '/api/stats', null, q), 200, 'Logistic Lead xem được');
    eq(await st('ad', 'GET', '/api/stats.csv', null, q), 200, 'Quản trị xuất được');
  });

  // ───────── PEOPLE-5 ─────────
  await group('PEOPLE-5: ghi vắng không trả việc Lead tự giữ và việc đang vướng (giống trả việc hết ca)', async () => {
    const W = await world(kind, { t: VN('2026-10-05', '06:00') });
    const { h, U, go, at, seen, tickAt } = W;
    await go('tl', 'PUT', '/api/hub/roster', { rows: ['tl', 't1', 't2'].flatMap((u) => ['2026-10-05', '2026-10-06'].map((date) => ({ user_id: U[u].id, date, shift: 'HC' }))) });
    at('2026-10-05', '08:35'); seen('tl', 't1', 't2');
    const mine = (await go('tl', 'POST', '/api/hub/jobs', { team: 'tech', title: 'Việc Tech Lead tự giữ', assignee_id: 'me', due_hours: 48 })).job;
    const blk = (await go('tl', 'POST', '/api/hub/jobs', { team: 'tech', title: 'Việc của t1 đang vướng', assignee_id: U.t1.id, due_hours: 48 })).job;
    await go('t1', 'POST', `/api/hub/jobs/${blk.id}/block`, { reason: 'Chờ linh kiện' });
    const plain = (await go('tl', 'POST', '/api/hub/jobs', { team: 'tech', title: 'Việc thường của t1', assignee_id: U.t1.id, due_hours: 48 })).job;
    at('2026-10-06', '08:35'); seen('t2');
    tickAt('2026-10-06', '09:31');
    eq([h.store.attendance.get(`${U.tl.id}:2026-10-06`).status, h.store.attendance.get(`${U.t1.id}:2026-10-06`).status], ['absent', 'absent'], 'Tech Lead và t1 bị ghi vắng');
    eq(W.uname(h.store.jobs.get(mine.id).assignee_id), 'tl', 'việc Lead tự giữ không bị trả về');
    eq([W.uname(h.store.jobs.get(blk.id).assignee_id), h.store.jobs.get(blk.id).blocked], ['t1', 'Chờ linh kiện'], 'việc đang vướng giữ người giữ, Lead quyết định');
    eq(W.uname(h.store.jobs.get(plain.id).assignee_id), 't2', 'việc chưa bắt đầu thường vẫn chuyển cho người trong ca');
    ok(h.store.inbox.find({ user_id: U.tl.id }).some((m) => m.text.includes('vướng')), 'Tech Lead được báo việc đang vướng của người vắng');
  });

  // ───────── PEOPLE-6 ─────────
  await group('PEOPLE-6: dời launch sớm hơn — hạn riêng của người đang giữ việc chuẩn bị đi theo hạn mới', async () => {
    const W = await world(kind, { roster: true });
    const { h, U, go, seen, job, kit, at } = W;
    await stock(W, 1);
    seen('l1', 'l2', 't1', 't2');
    const r = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-09', outlet: Q3, swap_days: '1,2,3,4,5', swap_from: '09:00', swap_to: '11:00' })).request;
    let p = job({ type: 'prep_kit', request_id: r.id });
    ok(!!p.assignee_id && p.due_mine === p.due_at, 'việc chuẩn bị có người giữ, hạn riêng = hạn việc');
    at('2026-10-05', '10:00');
    await go('s1', 'PATCH', `/api/hub/requests/${r.id}`, { launch_date: '2026-10-06' });
    p = h.store.jobs.get(p.id);
    eq(p.due_mine, p.due_at, 'hạn riêng theo hạn mới (không giữ hạn cũ muộn hơn)');
    at('2026-10-06', '07:00'); seen('l1', 'l2', 't1', 't2');
    const holder = W.uname(p.assignee_id);
    await go(holder, 'POST', `/api/hub/requests/${r.id}/assign`, { kit_ids: [kit('K01').id] });
    await go(holder, 'POST', `/api/hub/kits/${kit('K01').id}/submit`);
    await go('tl', 'POST', `/api/hub/jobs/${job({ type: 'check_kit', kit_id: kit('K01').id }).id}/done`, { result: { pass: true } });
    p = h.store.jobs.get(p.id);
    eq([p.status, p.done_by], ['done', U[holder].id], 'việc chuẩn bị đóng khi kit sẵn sàng, tính cho người giữ');
    const b = (await go('ll', 'GET', `/api/hub/jobs/${p.id}`)).job;
    eq([b.late, b.late_mine], [true, true], 'xong sau hạn mới: trễ theo team và theo cá nhân như nhau');
  });

  // ───────── PEOPLE-7 ─────────
  await group('PEOPLE-7: thẻ do Quản trị nhập giúp tính vào "người khác làm giúp", không cộng vào điểm team', async () => {
    const W = await world(kind, { t: VN('2026-10-05', '06:00') });
    const { h, U, go, at, seen, tickAt } = W;
    await go('tl', 'PUT', '/api/hub/roster', { rows: ['t1', 't2'].flatMap((u) => DAYS.map((date) => ({ user_id: U[u].id, date, shift: 'HC' }))) });
    const day = (d) => { at(d, '08:35'); seen('t1', 't2'); tickAt(d, '09:31'); };
    day(DAYS[0]);
    const codes = ['SD01', 'SD02', 'SD03', 'SD04'];
    await go('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: codes.join(' ') });
    for (const c of codes) { const cd = h.store.cards.find({ code: c }, { limit: 1 })[0]; h.store.cards.update(cd.id, { status: 'returned' }); }
    const ho = (await go('l1', 'POST', '/api/hub/handovers', { dir: 'to_tech', codes: codes.join(' ') })).handover;
    await go('t2', 'POST', `/api/hub/handovers/${ho.id}/receive`, { all: true });
    const cards = codes.map((c) => h.store.cards.find({ code: c }, { limit: 1 })[0]);
    await go('t1', 'POST', '/api/hub/cards/records', { records: cards.slice(0, 2).map((c) => ({ card_id: c.id, gb: 40, shoot_date: '2026-10-04' })) });
    await go('ad', 'POST', '/api/hub/cards/records', { records: cards.slice(2).map((c) => ({ card_id: c.id, gb: 40, shoot_date: '2026-10-04' })) });
    for (const d of DAYS.slice(1)) day(d);
    at('2026-10-12', '09:00');
    const p = await go('tl', 'GET', '/api/hub/perf', null, { team: 'tech', period: 'week', key: '2026-W41' });
    const rowsSum = Math.round(p.rows.reduce((a, x) => a + x.points, 0) * 10) / 10;
    const per = h.core.hub.jobs.uploadStd() / 6;
    eq(p.summary.points, rowsSum, 'điểm team = tổng điểm từng người');
    eq(p.summary.other_points, Math.round(2 * per * 10) / 10, 'thẻ Quản trị nhập vào "người khác làm giúp"');
    eq(p.summary.uploads, 2, 'số thẻ đã nhập của team chỉ tính thành viên');
    const daily = Math.round(p.summary.daily.reduce((a, x) => a + x.points, 0) * 10) / 10;
    eq(daily, p.summary.points, 'điểm theo ngày cộng lại bằng điểm team');
    const tr = await go('tl', 'GET', '/api/hub/perf/trend', null, { team: 'tech', weeks: 4, key: '2026-W41' });
    eq(tr.weeks[tr.weeks.length - 1].points, p.summary.points, 'xu hướng tuần cùng số với bảng hiệu suất');
  });

  // ───────── PEOPLE-1 / M1 ─────────
  await group('PEOPLE-1 / M1: ô "Đúng hạn Logistics" cùng nguồn với đường xu hướng, Top 3 và bảng hiệu suất', async () => {
    const W = await world(kind);
    const { U, go, at, job } = W;
    const vp = await stock(W, 1);
    const r = await launchReq(W, 1);
    await prep(W, r.id, ['K01']);
    const dlv = job({ type: 'deliver', request_id: r.id });
    const t = (await go('ll', 'POST', '/api/hub/dispatch', { job_ids: [dlv.id], fo_id: U.fo1.id, office_site_id: vp.id })).task;
    await runTrip(W, t.id); // FO giao đúng hạn qua chuyến
    const m = (await go('ll', 'POST', '/api/hub/jobs', { team: 'logistics', title: 'Việc có hạn 1 giờ', assignee_id: U.l1.id, due_hours: 1 })).job;
    W.h.clock.add(2 * 3600000);
    await go('l1', 'POST', `/api/hub/jobs/${m.id}/done`, { result: {} }); // Logistics làm trễ
    at('2026-10-09', '18:00');
    const ov = await go('ll', 'GET', '/api/hub/overview', null, { period: 'week', key: '2026-W41' });
    const p = await go('ll', 'GET', '/api/hub/perf', null, { team: 'logistics', period: 'week', key: '2026-W41' });
    const tile = ov.kpi.sla.logistics.cur, last = ov.trend[ov.trend.length - 1];
    eq(tile.pct, p.summary.sla_pct, 'ô Đúng hạn = bảng hiệu suất');
    eq(tile.pct, last.log_sla, 'ô Đúng hạn = điểm cuối đường xu hướng của chính ô đó');
    eq(tile.pct, ov.top3.logistics.summary.sla_pct, 'ô Đúng hạn = Top 3 Logistics');
    eq([tile.n, tile.ok], [p.summary.with_due, p.summary.on_time], 'cùng số việc có hạn và số việc đúng hạn');
    const tt = ov.kpi.sla.tech.cur, tp = await go('tl', 'GET', '/api/hub/perf', null, { team: 'tech', period: 'week', key: '2026-W41' });
    eq(tt.pct, tp.summary.sla_pct, 'Tech cũng cùng nguồn');
  });

  // ───────── SEC-1 ─────────
  await group('SEC-1: định mức việc giao tay theo team — Tech Lead chốt phần Tech, Logistic Lead không sửa được; sửa phần không thuộc mình → 403', async () => {
    const W = await world(kind);
    const { h, go, call } = W;
    eq((await call('tl', 'PUT', '/api/hub/config', { jobStd: { manual_tech: 30 }, jobSla: { manual_tech: 120 } })).status, 200, 'Tech Lead đặt định mức việc giao tay của Tech');
    const v = (await go('ad', 'GET', '/api/hub/config')).values;
    eq([v.jobStd.manual_tech, v.jobSla.manual_tech], [30, 120], 'đã lưu');
    const r1 = await call('ll', 'PUT', '/api/hub/config', { jobStd: { manual_tech: 0 } });
    eq([r1.status, r1.body.error], [403, 'forbidden'], 'Logistic Lead sửa phần Tech → 403 (không im lặng bỏ qua)');
    const r2 = await call('ll', 'PUT', '/api/hub/config', { jobStd: { manual: 300 } });
    eq(r2.status, 403, 'mục chung (không team) chỉ Quản trị sửa');
    const r3 = await call('tl', 'PUT', '/api/hub/config', { jobStd: { cards_upload: 2 } });
    eq(r3.status, 200, 'Tech Lead sửa loại việc của Tech');
    const cur = (await go('ll', 'GET', '/api/hub/config')).values.jobStd;
    eq((await call('ll', 'PUT', '/api/hub/config', { jobStd: { ...cur, manual_logistics: 12 } })).status, 200, 'Logistic Lead gửi cả bảng (phần Tech giữ nguyên) và sửa phần mình được');
    eq((await go('ad', 'GET', '/api/hub/config')).values.jobStd, { manual_tech: 30, cards_upload: 2, manual_logistics: 12 }, 'mỗi phần đúng của team');
    const j = (await go('t1', 'POST', '/api/hub/jobs', { title: 'Cài lại QR', team: 'tech', self: true })).job;
    await go('t1', 'POST', `/api/hub/jobs/${j.id}/done`, { result: {} });
    eq(h.store.jobs.get(j.id).std_min, 30, 'việc Tech tự tạo tính theo định mức Tech Lead đặt');
    const k = (await go('l1', 'POST', '/api/hub/jobs', { title: 'Dọn kho', team: 'logistics', self: true })).job;
    await go('l1', 'POST', `/api/hub/jobs/${k.id}/done`, { result: {} });
    eq(h.store.jobs.get(k.id).std_min, 12, 'việc Logistics tự tạo theo định mức Logistic Lead');
  });

  // ───────── SEC-2 ─────────
  await group('SEC-2: chi tiết thẻ không lộ ai nhập / sửa dung lượng qua nhật ký thẻ', async () => {
    const W = await world(kind);
    const { h, go } = W;
    const codes = ['SD01', 'SD02'];
    await go('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: codes.join(' ') });
    for (const c of codes) { const cd = h.store.cards.find({ code: c }, { limit: 1 })[0]; h.store.cards.update(cd.id, { status: 'returned' }); }
    const ho = (await go('l1', 'POST', '/api/hub/handovers', { dir: 'to_tech', codes: codes.join(' ') })).handover;
    await go('t1', 'POST', `/api/hub/handovers/${ho.id}/receive`, { all: true });
    const c = h.store.cards.find({ code: 'SD01' }, { limit: 1 })[0];
    await go('t1', 'POST', '/api/hub/cards/records', { records: [{ card_id: c.id, gb: 40, shoot_date: '2026-10-04' }] });
    const rec = h.store.card_records.find({ card_id: c.id })[0];
    await go('t1', 'PATCH', `/api/hub/cards/records/${rec.id}`, { gb: 41.5 });
    ok(h.store.hub_log.count({ entity: 'card', entity_id: c.id, action: 'record_edit' }) >= 1, 'có nhật ký sửa dung lượng');
    for (const who of ['l1', 'll', 't2']) {
      const d = await go(who, 'GET', `/api/hub/cards/${c.id}`);
      eq(d.log.filter((l) => ['record_edit', 'upload'].includes(l.action)).length, 0, `${who}: nhật ký thẻ không có dòng nhập / sửa dung lượng của người khác`);
      ok(!JSON.stringify(d.log).includes('Tech Một'), `${who}: không lộ tên người nhập`);
    }
    for (const who of ['tl', 't1', 'ad']) {
      const d = await go(who, 'GET', `/api/hub/cards/${c.id}`);
      eq(d.log.filter((l) => l.action === 'record_edit').length, 1, `${who}: thấy dòng sửa dung lượng`);
    }
  });

  // ───────── M2 ─────────
  await group('M2: BO tạo ở Rider Live tính là "chờ launch" ở mọi nơi (Tổng quan, Head of Sale, danh sách BO)', async () => {
    const W = await world(kind);
    const { h, go } = W;
    await go('ll', 'POST', '/api/hub/outlets', { name: 'BO Hub', lat: 10.78, lon: 106.69 });
    const b = (await go('ll', 'POST', '/api/sites', { name: 'BO Rider', type: 'bo', lat: 10.79, lon: 106.70 })).site;
    eq(h.store.sites.get(b.id).ops_status, 'planned', 'BO tạo ở Rider Live có trạng thái chờ launch');
    // Dữ liệu cũ: BO chưa có trạng thái vẫn tính là chờ launch.
    h.store.sites.insert({ name: 'BO Cũ', type: 'bo', lat: 10.8, lon: 106.7, radius: 150, active: 1, created_at: h.clock.now(), updated_at: h.clock.now(), ops_status: null });
    const ov = (await go('sh', 'GET', '/api/hub/overview')).kpi;
    const hs = (await go('sh', 'GET', '/api/hub/sale')).hos.kpi;
    const list = (await go('sh', 'GET', '/api/hub/outlets', null, { status: 'planned' })).outlets;
    eq([ov.bo_planned, hs.prospect + hs.waiting, list.length], [3, 3, 3], 'Tổng quan, Head of Sale, danh sách BO cùng đếm 3 BO chờ launch');
  });

  // ───────── M3 ─────────
  await group('M3: BO đang thu hồi vượt quota có trong danh sách theo dõi như ở Head of Sale', async () => {
    const W = await world(kind, { t: VN('2026-09-28', '08:30') });
    const { h, go, inv } = W;
    const { q3 } = await liveBO(W);
    await go('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: 'SDQ1 SDQ2' });
    const cid = h.store.cards.find({ code: 'SDQ1' }, { limit: 1 })[0].id;
    W.at('2026-10-08', '09:00');
    for (const [d, hr] of [['2026-09-29', 40], ['2026-10-01', 40]]) h.store.card_records.insert({ card_id: cid, code: 'SDQ1', site_id: q3.id, kit_id: W.kit('K01').id, handover_id: null, shoot_date: d, cover_to: d, gb: hr * 16.9, hours: hr, zero_reason: null, photos: null, by_id: W.U.t1.id, at: h.clock.now(), edited_by: null, edited_at: null, std_min: null, src: null });
    await go('sh', 'PATCH', `/api/hub/outlets/${q3.id}`, { quota_hours: 50 });
    await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, { note: 'Hết hợp đồng' });
    eq(W.site('Q3').ops_status, 'ending', 'BO đang thu hồi');
    const hs = (await go('sh', 'GET', '/api/hub/sale')).hos;
    const row = hs.outlets.find((o) => o.id === q3.id);
    eq(row && row.quota_status, 'over', 'Head of Sale: BO vượt quota');
    const ov = await go('sh', 'GET', '/api/hub/overview');
    ok(ov.watch.some((x) => x.kind === 'quota_over' && x.link === `outlet:${q3.id}`), 'danh sách theo dõi cũng có BO này');
    inv('quota');
  });

  // ───────── M4 ─────────
  await group('M4: giờ quay theo kit trên trang BO cùng cách chia với biểu đồ theo ngày', async () => {
    const W = await world(kind, { t: VN('2026-09-28', '08:30') });
    const { h, go } = W;
    const { q3 } = await liveBO(W);
    await go('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: 'SDK1 SDK2' });
    const c1 = h.store.cards.find({ code: 'SDK1' }, { limit: 1 })[0].id, c2 = h.store.cards.find({ code: 'SDK2' }, { limit: 1 })[0].id;
    W.at('2026-10-09', '09:00');
    const k1 = W.kit('K01').id;
    // Thẻ quay từ trước khung 7 ngày, ghi tới giữa khung (10 ngày, 5 giờ/ngày); thẻ quay trong khung.
    h.store.card_records.insert({ card_id: c1, code: 'SDK1', site_id: q3.id, kit_id: k1, handover_id: null, shoot_date: '2026-09-28', cover_to: '2026-10-07', gb: 50 * 16.9, hours: 50, zero_reason: null, photos: null, by_id: W.U.t1.id, at: h.clock.now(), edited_by: null, edited_at: null, std_min: null, src: null });
    h.store.card_records.insert({ card_id: c2, code: 'SDK2', site_id: q3.id, kit_id: k1, handover_id: null, shoot_date: '2026-10-08', cover_to: '2026-10-08', gb: 6 * 16.9, hours: 6, zero_reason: null, photos: null, by_id: W.U.t1.id, at: h.clock.now(), edited_by: null, edited_at: null, std_min: null, src: null });
    const d = await go('sh', 'GET', `/api/hub/outlets/${q3.id}`, null, { days: '7' });
    const series = Math.round(d.series.reduce((a, x) => a + x.hours, 0) * 100) / 100;
    const byKit = Math.round(d.hours_by_kit.reduce((a, x) => a + x.hours, 0) * 100) / 100;
    eq(series, 31, 'biểu đồ 7 ngày: 5 ngày × 5 giờ của thẻ cũ + 6 giờ thẻ mới');
    eq(byKit, series, 'bảng giờ theo kit cùng tổng với biểu đồ');
  });
}

await suite('memory');
await suite('sqlite');
summary('fix.integration');
