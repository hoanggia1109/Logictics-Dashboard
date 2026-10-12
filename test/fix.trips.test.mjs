// fix.trips.test.mjs — chuyến FO và những gì một điểm đã chốt làm với kho:
// số FO / BO báo khác kế hoạch thì không tự chuyển kit / thẻ (giữ việc lại, Đối chiếu cho Logistic Lead, Lead làm tay với mã thực tế),
// không huỷ việc trong chuyến đã chạy, không xếp cùng kit / thẻ vào hai chuyến, đổi thẻ phải có mã, thẻ đi trong kit lúc launch được ghi ở BO,
// phụ kiện FO mang đi được giữ chỗ, điểm hết việc thì bỏ khỏi chuyến, việc đổi kit của BO đã kết thúc tự huỷ khi chuyến huỷ, dời ngày launch khi việc giao đã lên chuyến.
// Mỗi nhóm chạy 2 lần: kho bộ nhớ và kho SQLite; kiểm bất biến sau từng bước.
import { mk, boDevice, ok, eq, group, summary, JPEG } from './harness.mjs';
import { checkInvariants } from './invariants.mjs';

const MIN = 60000;
const VN = (date, hm) => Date.parse(`${date}T${hm}:00+07:00`);
const VP = { name: 'Văn phòng Atlas', type: 'office', lat: 10.7769, lon: 106.7009 };
const Q3 = { name: 'BO Quận 3', code: 'Q3', lat: 10.7835, lon: 106.6869, contact: 'Chị Hoa', phone: '0901111222', address: '12 Võ Văn Tần, Quận 3' };
const TD = { name: 'BO Thủ Đức', code: 'TD', lat: 10.8494, lon: 106.7537, contact: 'Anh Nam', phone: '0903333444', address: 'Thủ Đức' };
const SD = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => 'SD' + String(from + i).padStart(2, '0'));

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
  // Ca cả ngày đã duyệt cho Logistics và Tech trong các ngày của kịch bản: không có ca đã duyệt thì không vào ca, không được tự giao việc.
  const days = Array.from({ length: 4 }, (_, i) => `2026-10-${String(5 + i).padStart(2, '0')}`);
  for (const [ld, us] of [['ll', ['l1', 'l2']], ['tl', ['t1', 't2']]]) await go(ld, 'PUT', '/api/hub/roster', { rows: us.flatMap((u) => days.map((date) => ({ user_id: U[u].id, date }))) });
  return { h, U, go, call, st, seen, tick, inv, job, jobs, kit, card, dev, site, uname, doJob };
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
    if (!['pending', 'arrived'].includes(h.store.stops.get(s.id).status)) continue; // điểm đã được bỏ qua
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

// ───────── Dựng nhanh: kho, kit đã kiểm, BO đang ghi hình ─────────
async function stockUp(W) {
  const { go, seen } = W;
  const vp = (await go('ll', 'POST', '/api/sites', VP)).site;
  await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: 'MC01 MC02 MC03 MC04 MC05 MC06' });
  await go('ll', 'POST', '/api/hub/devices', { type: 'cm5', codes: 'CM01 CM02 CM03 CM04 CM05 CM06' });
  await go('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: SD(1, 30).join(' ') });
  await go('l1', 'POST', '/api/hub/acc/hub_sac/move', { kind: 'in', qty: 12, reason: 'Khai báo tồn đầu kỳ' });
  for (let i = 1; i <= 6; i++) await go('l1', 'POST', '/api/hub/kits', { code: `K0${i}`, kind: 'multicam', devices: `MC0${i} CM0${i}`, acc: { hub_sac: 1 } });
  seen('l1', 'l2', 't1', 't2');
  return vp;
}
async function checkKits(W, codes) {
  for (const c of codes) {
    await W.go('l1', 'POST', `/api/hub/kits/${W.kit(c).id}/submit`);
    await W.doJob(W.job({ type: 'check_kit', kit_id: W.kit(c).id }), { pass: true });
  }
}
async function launch(W, outlet, codes, launchDate = '2026-10-05') {
  const req = (await W.go('s1', 'POST', '/api/hub/requests', { need: { multicam: codes.length }, launch_date: launchDate, outlet, swap_days: '1,2,3,4,5,6,7', swap_from: '09:00', swap_to: '11:00' })).request;
  await W.go('l1', 'POST', `/api/hub/requests/${req.id}/assign`, { kit_ids: codes.map((c) => W.kit(c).id) });
  await checkKits(W, codes);
  return req;
}
/** BO ghi hình với các kit đã giao tay; thẻ trong kit ghi luôn mã (cards). */
async function liveBO(W, outlet, codes, cards) {
  const req = await launch(W, outlet, codes);
  await W.go('ll', 'POST', `/api/hub/jobs/${W.job({ type: 'deliver', request_id: req.id }).id}/done`, { result: { doc_code: 'BB-01', cards_out: cards } });
  return req;
}
const countRecon = (W, stopId) => W.h.store.recon.find({ ref: `count:${stopId}` })[0] || null;

async function suite(kind) {
  console.log(`\n── Kho ${kind === 'sqlite' ? 'SQLite' : 'bộ nhớ'} ──`);

  await group('Giao qua chuyến: FO giao thiếu kit → việc giao giữ lại, kit không tự sang BO, Đối chiếu cho Logistic Lead; Lead làm tay đúng kit thật', async () => {
    const W = await world(kind);
    const { h, U, go, st, inv, job, jobs, kit, card, site } = W;
    await stockUp(W);
    const req = await launch(W, Q3, ['K01', 'K02']);
    const dlv = job({ type: 'deliver', request_id: req.id });
    const q3 = site('Q3');
    const trip = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [dlv.id], fo_id: U.fo1.id, cards_out: { [q3.id]: SD(1, 4) } })).task;
    const s = h.store.stops.find({ task_id: trip.id })[0];
    eq([s.exp_dev_out, s.exp_cards_out], [2, 4], 'điểm giao launch: 2 kit, 4 thẻ đi trong kit');
    eq(card('SD01').task_id, trip.id, 'thẻ đi trong kit gắn với chuyến');
    inv('tạo chuyến giao');
    await runTrip(W, trip.id, { [s.seq]: { dev_out: 1, cards_out: 2 } }); // FO chỉ giao 1 kit (2 thẻ), BO xác nhận đúng số FO
    eq(h.store.stops.get(s.id).bo_status, 'confirmed', 'đối chứng: BO xác nhận khớp số FO');
    const d1 = h.store.jobs.get(dlv.id);
    eq([d1.status, d1.task_id], ['open', null], 'FO giao 1/2 kit → việc giao không tự đóng, trở về Logistics');
    eq([kit('K01').status, kit('K02').status], ['reserved', 'reserved'], 'không kit nào tự sang "ở BO" khi số chưa khớp kế hoạch');
    eq(site('Q3').ops_status, 'planned', 'BO chưa tính là bắt đầu ghi hình');
    eq(SD(1, 4).map((c) => card(c).status), ['office', 'office', 'office', 'office'], 'thẻ trong kit chưa ghi là ở BO');
    const rc = countRecon(W, s.id);
    ok(rc && rc.status === 'open' && rc.level === 'high' && rc.team === 'logistics', 'một dòng Đối chiếu mức cao cho Logistics');
    ok(rc && rc.text.includes('kế hoạch') && rc.text.includes(dlv.code) && !rc.text.includes('BO BO'), `nội dung có số kế hoạch / FO / BO và mã việc: ${rc && rc.text}`);
    ok(h.store.inbox.count({ user_id: U.ll.id, kind: 'recon' }) >= 1, 'Logistic Lead được báo');
    eq(h.store.recon.count({ source: 'bo_confirm', status: 'open' }), 0, 'BO khớp FO thì không có dòng "BO báo lệch"');
    inv('FO giao thiếu');
    eq(await st('l1', 'POST', `/api/hub/jobs/${dlv.id}/done`, { result: { kit_ids: [kit('K01').id], doc_code: 'BB-9' } }), 403, 'nhân viên không tự chốt việc đang chờ Lead đối chiếu');
    eq(await st('l1', 'POST', '/api/hub/dispatch', { job_ids: [dlv.id], fo_id: U.fo1.id }), 409, 'việc đang chờ đối chiếu không xếp lại vào chuyến');
    eq(await st('l1', 'POST', `/api/hub/requests/${req.id}/unassign`, { kit_id: kit('K02').id }), 409, 'kit của việc đang chờ đối chiếu không gỡ khỏi yêu cầu được');
    await go('ll', 'POST', `/api/hub/jobs/${dlv.id}/done`, { result: { kit_ids: [kit('K01').id], cards_out: ['SD01', 'SD02'] } });
    eq([kit('K01').status, kit('K01').site_id, kit('K02').status], ['at_bo', q3.id, 'reserved'], 'Lead chốt đúng kit thật đã giao; kit còn lại vẫn chờ giao');
    eq(site('Q3').ops_status, 'live', 'BO bắt đầu ghi hình');
    eq(['SD01', 'SD02'].map((c) => [card(c).status, card(c).site_id, !!card(c).bo_in]), [['at_bo', q3.id, true], ['at_bo', q3.id, true]], 'thẻ trong kit ghi ở BO, có giờ vào BO');
    eq(h.store.recon.get(rc.id).status, 'resolved', 'Lead làm tay xong → dòng Đối chiếu tự đóng');
    const rest = jobs({ type: 'deliver', request_id: req.id, status: ['open', 'doing'] });
    eq(rest.length, 1, 'còn đúng 1 việc giao cho kit chưa giao');
    eq(h.store.requests.get(req.id).status, 'delivering', 'yêu cầu đang giao (1/2 kit ở BO)');
    inv('Lead chốt tay');
    await go('l1', 'POST', `/api/hub/jobs/${rest[0].id}/done`, { result: { doc_code: 'BB-02' } });
    eq([kit('K02').status, h.store.requests.get(req.id).status], ['at_bo', 'live'], 'giao nốt kit còn lại → yêu cầu đang ghi hình');
    const lc = h.store.recon.find({ ref: `launchcards:${rest[0].id}`, status: 'open' })[0];
    ok(lc && lc.team === 'logistics', 'giao kit mà không ghi mã thẻ trong kit → vào Đối chiếu (không chặn launch)');
    inv('giao nốt kit còn lại');
  });

  await group('Thu hồi qua chuyến: FO thu thiếu kit → không ghi thu hết, BO chưa kết thúc; Lead chốt tay kit thật', async () => {
    const W = await world(kind);
    const { h, U, go, inv, job, jobs, kit, card, site } = W;
    await stockUp(W);
    await liveBO(W, Q3, ['K01', 'K02'], SD(1, 4));
    const q3 = site('Q3');
    const end = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, {})).request;
    const rec = job({ type: 'recover', request_id: end.id });
    const trip = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [rec.id], fo_id: U.fo1.id })).task;
    const s = h.store.stops.find({ task_id: trip.id })[0];
    eq([s.exp_dev_in, s.exp_cards_in], [2, 4], 'điểm thu hồi: thu 2 kit và 4 thẻ đang ở BO');
    await runTrip(W, trip.id, { [s.seq]: { dev_in: 1 } }); // BO giữ lại 1 kit; BO xác nhận đưa 1 kit
    eq([kit('K01').status, kit('K02').status], ['at_bo', 'at_bo'], 'không kit nào tự sang "đang thu hồi" khi số chưa khớp');
    eq(site('Q3').ops_status, 'ending', 'BO chưa kết thúc');
    eq([h.store.jobs.get(rec.id).status, h.store.jobs.get(rec.id).task_id], ['open', null], 'việc thu hồi trở về Logistics');
    eq(jobs({ type: 'receive_field' }).length, 0, 'không sinh việc nhận kit về kho cho kit còn ở BO');
    ok(!h.store.inbox.find({ user_id: U.s1.id }).some((m) => m.text.includes('thu hồi xong')), 'Sale không bị báo nhầm "đã thu hồi xong"');
    const rc = countRecon(W, s.id);
    ok(rc && rc.status === 'open' && rc.level === 'high', 'Đối chiếu mức cao cho Logistics');
    inv('FO thu thiếu');
    await go('ll', 'POST', `/api/hub/jobs/${rec.id}/done`, { result: { kit_ids: [kit('K01').id] } });
    eq([kit('K01').status, kit('K02').status], ['returned', 'at_bo'], 'Lead chốt đúng kit đã thu; kit còn lại vẫn ở BO');
    eq(jobs({ type: 'recover', site_id: q3.id, status: ['open', 'doing'] }).length, 1, 'còn việc thu hồi phần còn lại');
    eq(h.store.recon.get(rc.id).status, 'resolved', 'dòng Đối chiếu tự đóng');
    inv('Lead chốt tay thu hồi');
    // BO đếm khác FO (FO báo đủ, BO báo đưa 0): cũng giữ lại.
    const rest = job({ type: 'recover', site_id: q3.id, status: 'open' });
    const t2 = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [rest.id], fo_id: U.fo1.id })).task;
    const s2 = h.store.stops.find({ task_id: t2.id })[0];
    await runTrip(W, t2.id, { [s2.seq]: { bo: { dev_given: 0 } } });
    eq(h.store.stops.get(s2.id).bo_status, 'mismatch', 'đối chứng: BO báo lệch với FO');
    eq([kit('K02').status, h.store.jobs.get(rest.id).status], ['at_bo', 'open'], 'BO báo khác FO → không tự thu');
    const rc2 = countRecon(W, s2.id);
    ok(rc2 && rc2.source === 'bo_confirm' && rc2.status === 'open', 'dòng Đối chiếu nguồn "BO xác nhận giao nhận"');
    inv('BO báo lệch khi thu hồi');
  });

  await group('Đổi thẻ: chuyến bắt buộc có mã thẻ; thẻ trong kit lúc launch được thu ở lượt đầu; số FO / BO khác kế hoạch → giữ việc', async () => {
    const W = await world(kind);
    const { h, U, go, st, inv, tick, job, card, site } = W;
    const vp = await stockUp(W);
    await liveBO(W, Q3, ['K01'], ['SD01', 'SD02']);
    const q3 = site('Q3');
    eq([card('SD01').status, card('SD01').site_id], ['at_bo', q3.id], 'giao launch ghi thẻ trong kit ở BO');
    eq(h.store.recon.count({ status: 'open' }), 0, 'đủ mã thẻ → không có dòng Đối chiếu');
    tick();
    const sw = job({ type: 'card_swap', site_id: q3.id, date: '2026-10-06' });
    ok(sw && sw.status === 'open', 'việc đổi thẻ ngày mai');
    eq(await st('l1', 'POST', '/api/hub/dispatch', { job_ids: [sw.id], fo_id: U.fo1.id }), 400, 'chuyến đổi thẻ không có mã thẻ mới → chặn');
    const trip = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [sw.id], fo_id: U.fo1.id, office_site_id: vp.id, cards_out: { [q3.id]: ['SD03', 'SD04'] } })).task;
    const s = h.store.stops.find({ task_id: trip.id, site_id: q3.id })[0];
    eq([s.exp_cards_out, s.exp_cards_in], [2, 2], 'kế hoạch: giao 2 thẻ, thu 2 thẻ đang ở BO');
    eq(s.hub.cards_in, ['SD01', 'SD02'], 'lượt đổi đầu tiên thu đúng thẻ đi trong kit lúc launch');
    inv('tạo chuyến đổi thẻ');
    await runTrip(W, trip.id, { [s.seq]: { cards_out: 1 } }); // FO chỉ để lại 1 thẻ, BO cũng đếm 1
    eq(h.store.stops.get(s.id).bo_status, 'confirmed', 'đối chứng: BO khớp FO');
    eq([h.store.jobs.get(sw.id).status, h.store.jobs.get(sw.id).task_id], ['open', null], 'số thẻ khác kế hoạch → việc đổi thẻ giữ lại');
    eq(['SD01', 'SD02', 'SD03', 'SD04'].map((c) => card(c).status), ['at_bo', 'at_bo', 'office', 'office'], 'không thẻ nào tự chuyển khi số chưa khớp');
    eq([card('SD03').task_id, card('SD04').task_id], [null, null], 'thẻ mang đi không còn gắn chuyến đã xong');
    const rc = countRecon(W, s.id);
    ok(rc && rc.status === 'open' && rc.level === 'high', 'Đối chiếu mức cao cho Logistics');
    inv('FO để lại thiếu thẻ');
    await go('ll', 'POST', `/api/hub/jobs/${sw.id}/done`, { result: { cards_out: ['SD03'], cards_in: ['SD01', 'SD02'] } });
    eq(['SD01', 'SD02', 'SD03', 'SD04'].map((c) => card(c).status), ['returned', 'returned', 'at_bo', 'office'], 'Lead chốt theo thẻ thật');
    eq(h.store.recon.get(rc.id).status, 'resolved', 'dòng Đối chiếu tự đóng');
    inv('Lead chốt đổi thẻ');
    // Lượt sau khớp kế hoạch: tự đóng, không thêm dòng Đối chiếu.
    h.clock.set(VN('2026-10-07', '08:30')); W.seen('l1', 'l2', 't1', 't2'); tick();
    const sw2 = job({ type: 'card_swap', site_id: q3.id, date: '2026-10-07' });
    const t2 = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [sw2.id], fo_id: U.fo1.id, cards_out: { [q3.id]: ['SD05', 'SD06'] } })).task;
    const s2 = h.store.stops.find({ task_id: t2.id })[0];
    eq([s2.exp_cards_out, s2.exp_cards_in], [2, 1], 'kế hoạch thu đúng số thẻ hệ thống ghi ở BO (không đoán theo số kit)');
    const openBefore = h.store.recon.count({ status: 'open' });
    await runTrip(W, t2.id);
    eq(h.store.jobs.get(sw2.id).status, 'done', 'số khớp → tự đóng');
    eq(['SD03', 'SD05', 'SD06'].map((c) => card(c).status), ['returned', 'at_bo', 'at_bo'], 'thẻ chuyển đúng');
    eq(h.store.recon.count({ status: 'open' }), openBefore, 'không thêm dòng Đối chiếu');
    inv('đổi thẻ khớp');
    // Làm tay: không mã, không số → chặn; chỉ báo số (không mã) → vào Đối chiếu.
    h.clock.set(VN('2026-10-08', '08:30')); W.seen('l1', 'l2', 't1', 't2'); tick();
    const sw3 = job({ type: 'card_swap', site_id: q3.id, date: '2026-10-08' });
    eq(await st('l1', 'POST', `/api/hub/jobs/${sw3.id}/done`, { result: {} }), 400, 'đổi thẻ tay không ghi mã thẻ mới → chặn');
    await go('l1', 'POST', `/api/hub/jobs/${sw3.id}/done`, { result: { count_out: 2 } });
    const so = h.store.recon.find({ ref: `swapout:${sw3.id}`, status: 'open' })[0];
    ok(so && so.team === 'logistics', 'để lại thẻ không có mã → vào Đối chiếu để ghi mã');
    inv('đổi thẻ chỉ báo số');
  });

  await group('Huỷ việc trong chuyến đã bắt đầu bị chặn; BO báo lệch khi đổi kit → giữ việc, kit thay về kho', async () => {
    const W = await world(kind);
    const { h, U, go, st, inv, job, kit, site } = W;
    await stockUp(W);
    await liveBO(W, Q3, ['K01'], ['SD01', 'SD02']);
    await checkKits(W, ['K02']);
    const q3 = site('Q3');
    await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'swap_device', kit_id: kit('K01').id, label: 'Không lên nguồn', note: 'Máy tắt liên tục' });
    const sw = job({ type: 'swap_faulty', kit_id: kit('K01').id });
    const trip = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [sw.id], fo_id: U.fo1.id, swap_kits: { [sw.id]: kit('K02').id } })).task;
    await go('fo1', 'POST', `/api/tasks/${trip.id}/accept`);
    await go('fo1', 'POST', `/api/tasks/${trip.id}/start`);
    eq(kit('K02').status, 'delivering', 'kit thay đang đi');
    const r = await W.call('ll', 'POST', `/api/hub/jobs/${sw.id}/cancel`, { reason: 'Tech báo kit đã ổn' });
    eq([r.status, r.body.error], [409, 'trip_running'], 'huỷ việc trong chuyến đã bắt đầu → chặn');
    ok(/Không giao được|huỷ chuyến/.test(r.body.message || ''), `lời báo chỉ cách làm: ${r.body.message}`);
    eq([kit('K02').status, !!kit('K01').fault, h.store.jobs.get(sw.id).status], ['delivering', true, 'doing'], 'kit, cờ lỗi và việc giữ nguyên');
    inv('chặn huỷ trong chuyến');
    const s = h.store.stops.find({ task_id: trip.id })[0];
    await runTrip(W, trip.id, { [s.seq]: { bo: { dev_recv: 0 } } }, { started: true });
    eq(h.store.stops.get(s.id).bo_status, 'mismatch', 'đối chứng: BO báo khác FO');
    eq([kit('K01').status, kit('K02').status, h.store.jobs.get(sw.id).status], ['at_bo', 'ready', 'open'], 'BO báo lệch → không tự đổi kit; kit thay về kho');
    const rc = countRecon(W, s.id);
    ok(rc && rc.source === 'bo_confirm' && rc.status === 'open', 'dòng Đối chiếu "BO xác nhận giao nhận"');
    eq(h.store.recon.count({ ref: `bo:${s.id}` }), 0, 'chỉ một dòng Đối chiếu cho điểm này');
    inv('BO báo lệch khi đổi kit');
    await go('ll', 'POST', `/api/hub/jobs/${sw.id}/done`, { result: { new_kit_id: kit('K02').id } });
    eq([kit('K02').status, kit('K02').site_id, kit('K01').status], ['at_bo', q3.id, 'at_tech'], 'Lead chốt tay đổi kit');
    eq(h.store.recon.get(rc.id).status, 'resolved', 'dòng Đối chiếu tự đóng');
    inv('Lead chốt đổi kit');
  });

  await group('Không xếp cùng kit / thẻ vào hai chuyến đang mở', async () => {
    const W = await world(kind);
    const { h, U, go, call, inv, tick, job, kit, site } = W;
    await stockUp(W);
    await liveBO(W, Q3, ['K01', 'K02'], SD(1, 4));
    await checkKits(W, ['K03']);
    const q3 = site('Q3');
    tick();
    // Thẻ: hai lượt đổi thẻ cùng BO, hai chuyến khác nhau, cùng thu một bộ thẻ.
    const swA = job({ type: 'card_swap', site_id: q3.id, date: '2026-10-06' }), swB = job({ type: 'card_swap', site_id: q3.id, date: '2026-10-07' });
    const tA = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [swA.id], fo_id: U.fo1.id, cards_out: { [q3.id]: SD(5, 8) } })).task;
    const rB = await call('l1', 'POST', '/api/hub/dispatch', { job_ids: [swB.id], fo_id: U.fo1.id, cards_out: { [q3.id]: SD(9, 12) } });
    eq(rB.status, 409, 'thẻ đang ở BO đã được chuyến khác lên kế hoạch thu → chặn');
    ok((rB.body.message || '').includes(tA.code), `lời báo nêu chuyến kia: ${rB.body.message}`);
    const rC = await call('l1', 'POST', '/api/hub/dispatch', { job_ids: [swB.id], fo_id: U.fo1.id, cards_out: { [q3.id]: ['SD05', 'SD09'] } });
    eq(rC.status, 409, 'thẻ mới đã chọn cho chuyến khác → chặn');
    await go('l1', 'POST', `/api/tasks/${tA.id}/cancel`, { reason: 'Đổi lịch' });
    inv('chặn trùng thẻ');
    // Kit: đổi kit hỏng nằm ở chuyến 1, BO kết thúc, chuyến thu hồi không được thu cùng kit.
    await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'swap_device', kit_id: kit('K01').id, label: 'Không lên nguồn', note: 'Máy tắt liên tục' });
    const sw = job({ type: 'swap_faulty', kit_id: kit('K01').id });
    const t1 = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [sw.id], fo_id: U.fo1.id, swap_kits: { [sw.id]: kit('K03').id } })).task;
    const end = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, {})).request;
    const rec = job({ type: 'recover', request_id: end.id });
    eq(h.store.jobs.get(sw.id).status, 'doing', 'đối chứng: việc đổi kit trong chuyến không tự huỷ khi BO kết thúc');
    const r2 = await call('l1', 'POST', '/api/hub/dispatch', { job_ids: [rec.id], fo_id: U.fo1.id });
    eq(r2.status, 409, 'kit đã nằm trong chuyến khác (đổi kit) → không xếp thu hồi cùng kit');
    ok((r2.body.message || '').includes(t1.code), `lời báo nêu chuyến kia: ${r2.body.message}`);
    eq(h.store.tasks.count({ status: ['assigned', 'accepted', 'in_progress', 'unassigned'] }), 1, 'không tạo chuyến thứ hai');
    inv('chặn trùng kit');
  });

  await group('Phụ kiện FO mang đi giao bổ sung được giữ chỗ từ lúc chuyến chạy', async () => {
    const W = await world(kind);
    const { h, U, go, st, inv, job, kit, site } = W;
    const vp = await stockUp(W);
    await liveBO(W, Q3, ['K01'], ['SD01', 'SD02']);
    const q3 = site('Q3');
    const free = async () => (await go('l1', 'GET', '/api/hub/acc')).acc.find((a) => a.id === 'hub_sac').free;
    eq(await free(), 6, 'đối chứng: 12 tổng − 6 trong kit = 6 rảnh');
    await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'extra_acc', acc: { hub_sac: 3 }, kit_id: kit('K01').id, note: 'BO thiếu hub sạc' });
    const da = job({ type: 'deliver_acc' });
    const trip = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [da.id], fo_id: U.fo1.id, office_site_id: vp.id, round_trip: true })).task;
    eq(await free(), 6, 'chuyến chưa chạy: phụ kiện vẫn ở kệ');
    await go('fo1', 'POST', `/api/tasks/${trip.id}/accept`);
    await go('fo1', 'POST', `/api/tasks/${trip.id}/start`);
    eq(await free(), 3, 'FO mang 3 hub sạc đi → còn 3 rảnh trên kệ');
    const total0 = h.store.dev_types.get('hub_sac').total;
    await go('l1', 'POST', '/api/hub/acc/hub_sac/move', { kind: 'count', free_counted: 3, reason: 'Kiểm kê giữa tuần' });
    eq(h.store.dev_types.get('hub_sac').total, total0, 'kiểm kê đếm đúng 3 trên kệ → tổng không đổi (không trừ hai lần)');
    eq(await st('l1', 'POST', '/api/hub/kits', { code: 'K09', kind: 'multicam', acc: { hub_sac: 4 } }), 409, 'không lấy phần FO đang mang cho kit khác');
    inv('FO đang mang phụ kiện');
    await runTrip(W, trip.id, {}, { started: true });
    eq([h.store.jobs.get(da.id).status, kit('K01').acc.hub_sac], ['done', 4], 'giao xong → cộng vào kit');
    eq([h.store.dev_types.get('hub_sac').total, await free()], [12, 3], 'tổng 12, rảnh 3 — đúng thực tế');
    inv('giao phụ kiện xong');
    await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'extra_acc', acc: { hub_sac: 2 }, kit_id: kit('K01').id, note: 'Thêm hub sạc' });
    const da2 = job({ type: 'deliver_acc' });
    const t2 = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [da2.id], fo_id: U.fo1.id })).task;
    await go('fo1', 'POST', `/api/tasks/${t2.id}/accept`);
    await go('fo1', 'POST', `/api/tasks/${t2.id}/start`);
    eq(await free(), 1, 'chuyến 2 chạy: giữ 2');
    await go('l1', 'POST', `/api/tasks/${t2.id}/cancel`, { reason: 'Xe hỏng' });
    eq(await free(), 3, 'huỷ chuyến → phụ kiện về lại rảnh');
    inv('huỷ chuyến giao phụ kiện');
  });

  await group('Gỡ việc cuối cùng của một điểm: chuyến chưa chạy bỏ điểm đó, hết việc thì huỷ chuyến', async () => {
    const W = await world(kind);
    const { h, U, go, inv, tick, job, card, site } = W;
    const vp = await stockUp(W);
    await liveBO(W, Q3, ['K01'], ['SD01', 'SD02']);
    await liveBO(W, TD, ['K02'], ['SD03', 'SD04']);
    tick();
    const a = job({ type: 'card_swap', site_id: site('Q3').id, date: '2026-10-06' }), b = job({ type: 'card_swap', site_id: site('TD').id, date: '2026-10-06' });
    const trip = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [a.id, b.id], fo_id: U.fo1.id, office_site_id: vp.id, round_trip: true, cards_out: { [site('Q3').id]: ['SD05', 'SD06'], [site('TD').id]: ['SD07', 'SD08'] } })).task;
    const before = h.store.tasks.get(trip.id);
    eq(h.store.stops.count({ task_id: trip.id }), 4, 'văn phòng, 2 BO, quay về');
    await go('l1', 'POST', `/api/hub/jobs/${a.id}/untrip`);
    const stops = h.store.stops.find({ task_id: trip.id }, { order: 'seq' });
    eq(stops.map((s) => [s.seq, s.name]), [[1, 'Văn phòng Atlas'], [2, 'BO Thủ Đức'], [3, 'Quay về Văn phòng Atlas']], 'BO không còn việc bị bỏ khỏi chuyến, số thứ tự đánh lại');
    ok(h.store.tasks.get(trip.id).plan_km < before.plan_km, 'km dự kiến tính lại');
    eq([card('SD05').status, card('SD05').task_id], ['office', null], 'thẻ của việc đã gỡ rời chuyến');
    inv('gỡ việc của một BO');
    await go('ll', 'POST', `/api/hub/jobs/${b.id}/cancel`, { reason: 'BO xin dời lượt' }); // chuyến chưa chạy: huỷ việc vẫn được
    eq(h.store.jobs.get(b.id).status, 'cancelled', 'huỷ việc trong chuyến chưa chạy được');
    eq(h.store.tasks.get(trip.id).status, 'cancelled', 'chuyến không còn việc nào → tự huỷ');
    eq([card('SD07').status, card('SD07').task_id], ['office', null], 'thẻ về kho, rời chuyến');
    inv('hết việc trong chuyến');
  });

  await group('Chuyến đang chạy: điểm hết việc (Logistics tự thu hồi kit) được bỏ qua, FO không phải ghé, chuyến không tính thiếu điểm', async () => {
    const W = await world(kind);
    const { h, U, go, inv, job, kit, site } = W;
    const vp = await stockUp(W);
    await liveBO(W, Q3, ['K01'], ['SD01', 'SD02']);
    const q3 = site('Q3');
    await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'extra_acc', acc: { hub_sac: 2 }, kit_id: kit('K01').id, note: 'BO thiếu hub sạc' });
    const da = job({ type: 'deliver_acc' });
    const trip = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [da.id], fo_id: U.fo1.id, office_site_id: vp.id, round_trip: true })).task;
    await go('fo1', 'POST', `/api/tasks/${trip.id}/accept`);
    await go('fo1', 'POST', `/api/tasks/${trip.id}/start`);
    const end = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, {})).request;
    await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'recover', request_id: end.id }).id}/done`, { result: { kit_ids: [kit('K01').id] } });
    eq(h.store.jobs.get(da.id).status, 'cancelled', 'kit đã rời BO → việc giao phụ kiện tự huỷ');
    const boStop = h.store.stops.find({ task_id: trip.id, site_id: q3.id })[0];
    eq([boStop.status, h.store.tasks.get(trip.id).status], ['skipped', 'in_progress'], 'điểm hết việc được bỏ qua, chuyến vẫn chạy');
    inv('bỏ qua điểm hết việc');
    const t = await runTrip(W, trip.id, {}, { started: true });
    eq([t.status, t.partial], ['completed', 0], 'chuyến hoàn thành, không tính là thiếu điểm');
    const perf = await go('ll', 'GET', '/api/hub/perf', null, { period: 'week', key: '2026-W41' });
    const foRow = perf.fo && perf.fo.rows.find((r) => r.user.id === U.fo1.id);
    ok(!foRow || !foRow.stops_failed, 'điểm bỏ qua không tính là FO không giao được');
    inv('chuyến xong sau khi bỏ qua điểm');
  });

  await group('BO kết thúc khi việc đổi kit đang trong chuyến: huỷ chuyến thì việc đổi kit tự huỷ', async () => {
    const W = await world(kind);
    const { h, U, go, inv, job, kit, site } = W;
    await stockUp(W);
    await liveBO(W, Q3, ['K01'], ['SD01', 'SD02']);
    await checkKits(W, ['K02']);
    const q3 = site('Q3');
    const sup = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'swap_device', kit_id: kit('K01').id, label: 'Không lên nguồn', note: 'Máy tắt liên tục' })).request;
    const sw = job({ type: 'swap_faulty', kit_id: kit('K01').id });
    const trip = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [sw.id], fo_id: U.fo1.id, swap_kits: { [sw.id]: kit('K02').id } })).task;
    await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, {});
    eq(site('Q3').ops_status, 'ending', 'BO đang thu hồi');
    await go('l1', 'POST', `/api/tasks/${trip.id}/cancel`, { reason: 'BO kết thúc' });
    eq(h.store.jobs.get(sw.id).status, 'cancelled', 'việc đổi kit của BO đang thu hồi tự huỷ khi chuyến huỷ');
    eq(h.store.requests.get(sup.id).status, 'closed', 'yêu cầu hỗ trợ đi kèm đóng lại');
    eq([kit('K02').status, kit('K01').status], ['ready', 'at_bo'], 'kit thay về kho, kit lỗi về cùng đợt thu hồi');
    inv('huỷ chuyến sau khi BO kết thúc');
  });

  await group('Dời ngày launch khi việc giao đã lên chuyến: chuyến chưa chạy thì gỡ việc và báo Logistics; chuyến đã chạy thì chặn', async () => {
    const W = await world(kind);
    const { h, U, go, call, inv, job, kit, card, site } = W;
    await stockUp(W);
    const req = await launch(W, Q3, ['K01']);
    const dlv = job({ type: 'deliver', request_id: req.id });
    const t1 = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [dlv.id], fo_id: U.fo1.id, cards_out: { [site('Q3').id]: ['SD01', 'SD02'] } })).task;
    const inbox0 = h.store.inbox.count({ user_id: U.ll.id });
    await go('s1', 'PATCH', `/api/hub/requests/${req.id}`, { launch_date: '2026-10-20' });
    const d1 = h.store.jobs.get(dlv.id);
    eq([d1.status, d1.task_id], ['open', null], 'chuyến chưa chạy: việc giao được gỡ khỏi chuyến');
    eq(h.store.tasks.get(t1.id).status, 'cancelled', 'chuyến chỉ có việc này → huỷ');
    eq([card('SD01').status, card('SD01').task_id], ['office', null], 'thẻ rời chuyến');
    ok(h.store.inbox.count({ user_id: U.ll.id }) > inbox0, 'Logistic Lead được báo');
    inv('dời launch khi chuyến chưa chạy');
    await go('s1', 'PATCH', `/api/hub/requests/${req.id}`, { launch_date: '2026-10-05' });
    const t2 = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [dlv.id], fo_id: U.fo1.id, cards_out: { [site('Q3').id]: ['SD01', 'SD02'] } })).task;
    await go('fo1', 'POST', `/api/tasks/${t2.id}/accept`);
    await go('fo1', 'POST', `/api/tasks/${t2.id}/start`);
    const r = await call('s1', 'PATCH', `/api/hub/requests/${req.id}`, { launch_date: '2026-10-20' });
    eq(r.status, 409, 'chuyến giao đã chạy → không dời ngày launch');
    ok(!/FO Một/.test(r.body.message || ''), 'lời báo cho Sale không lộ tên FO');
    eq(h.store.requests.get(req.id).launch_date, '2026-10-05', 'ngày launch giữ nguyên');
    await runTrip(W, t2.id, {}, { started: true });
    eq([kit('K01').status, site('Q3').ops_status, card('SD01').status, card('SD02').site_id], ['at_bo', 'live', 'at_bo', site('Q3').id], 'giao qua chuyến khớp số → kit và thẻ trong kit ở BO');
    eq(h.store.recon.count({ status: 'open' }), 0, 'không có dòng Đối chiếu');
    inv('giao launch qua chuyến');
  });

  await group('Huỷ yêu cầu hỗ trợ khi việc đổi kit / giao phụ kiện đang trong chuyến đã bắt đầu bị chặn; chuyến chưa chạy thì huỷ được', async () => {
    for (const kindReq of ['swap_device', 'extra_acc']) {
      const W = await world(kind);
      const { h, U, go, call, inv, job, kit, site } = W;
      const vp = await stockUp(W);
      await liveBO(W, Q3, ['K01'], ['SD01', 'SD02']);
      await checkKits(W, ['K02']);
      const q3 = site('Q3');
      const body = kindReq === 'swap_device' ? { kind: 'swap_device', kit_id: kit('K01').id, label: 'Không lên nguồn', note: 'Máy tắt liên tục' } : { kind: 'extra_acc', acc: { hub_sac: 2 }, kit_id: kit('K01').id, note: 'BO thiếu hub sạc' };
      const sup = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, body)).request;
      const j = job({ type: kindReq === 'swap_device' ? 'swap_faulty' : 'deliver_acc' });
      let sup2 = sup, j2 = j;
      if (kindReq === 'extra_acc') {
        // Chuyến chưa chạy: huỷ yêu cầu thì việc rời chuyến, chuyến hết việc tự huỷ.
        const t0 = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [j.id], fo_id: U.fo1.id, office_site_id: vp.id })).task;
        await go('s1', 'POST', `/api/hub/requests/${sup.id}/cancel`, { reason: 'BO tự xử lý được' });
        eq([h.store.jobs.get(j.id).status, h.store.tasks.get(t0.id).status], ['cancelled', 'cancelled'], 'chuyến chưa chạy → huỷ yêu cầu được, chuyến hết việc tự huỷ');
        inv('huỷ yêu cầu khi chuyến chưa chạy');
        sup2 = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, body)).request;
        j2 = job({ type: 'deliver_acc', status: 'open' });
      }
      // Chuyến đã chạy: chặn, việc và kit giữ nguyên, FO làm xong thì ghi đúng.
      const trip = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [j2.id], fo_id: U.fo1.id, office_site_id: vp.id, swap_kits: kindReq === 'swap_device' ? { [j2.id]: kit('K02').id } : undefined })).task;
      await go('fo1', 'POST', `/api/tasks/${trip.id}/accept`);
      await go('fo1', 'POST', `/api/tasks/${trip.id}/start`);
      for (const who of ['s1', 'sh', 'll']) {
        const r = await call(who, 'POST', `/api/hub/requests/${sup2.id}/cancel`, { reason: 'BO tự xử lý được' });
        eq([r.status, r.body.error], [409, 'trip_running'], `${kindReq}: ${who} huỷ yêu cầu khi chuyến đã chạy → chặn`);
        ok(/Không giao được|huỷ chuyến/.test(r.body.message || '') && !/FO Một/.test(r.body.message || ''), `${kindReq}: lời báo chỉ cách làm, không lộ tên FO: ${r.body.message}`);
      }
      eq([h.store.jobs.get(j2.id).status, h.store.requests.get(sup2.id).status !== 'cancelled'], ['doing', true], `${kindReq}: việc và yêu cầu giữ nguyên`);
      inv(`${kindReq}: chặn huỷ yêu cầu`);
      await runTrip(W, trip.id, {}, { started: true });
      if (kindReq === 'swap_device') eq([kit('K01').status !== 'at_bo', kit('K02').status, kit('K02').site_id], [true, 'at_bo', q3.id], 'FO đổi kit xong → ghi đúng thực tế (kit hỏng FO mang về)');
      else eq(kit('K01').acc.hub_sac, 3, 'FO giao phụ kiện xong → kit có thêm phụ kiện');
      eq(h.store.jobs.get(j2.id).status, 'done', `${kindReq}: việc đóng theo chuyến`);
      inv(`${kindReq}: chuyến xong`);
    }
  });

  await group('Chuyến đang chạy chỉ có điểm bị bỏ qua (không có điểm văn phòng): chuyến huỷ, không tính FO không hoàn thành', async () => {
    const W = await world(kind);
    const { h, U, go, inv, job, kit, site } = W;
    await stockUp(W);
    await liveBO(W, Q3, ['K01'], ['SD01', 'SD02']);
    const q3 = site('Q3');
    await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'extra_acc', acc: { hub_sac: 2 }, kit_id: kit('K01').id, note: 'BO thiếu hub sạc' });
    const da = job({ type: 'deliver_acc' });
    const trip = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [da.id], fo_id: U.fo1.id })).task;
    await go('fo1', 'POST', `/api/tasks/${trip.id}/accept`);
    await go('fo1', 'POST', `/api/tasks/${trip.id}/start`);
    const end = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, {})).request;
    await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'recover', request_id: end.id }).id}/done`, { result: { kit_ids: [kit('K01').id] } });
    const t = h.store.tasks.get(trip.id);
    eq([h.store.stops.find({ task_id: trip.id }).map((s) => s.status), t.status, t.partial], [['skipped'], 'cancelled', 0], 'mọi điểm bị bỏ qua → chuyến huỷ, không phải "không hoàn thành"');
    eq(h.store.events.count({ task_id: trip.id, type: 'task_failed' }), 0, 'không báo động "không hoàn thành được điểm nào"');
    const perf = await go('ll', 'GET', '/api/hub/perf', null, { period: 'week', key: '2026-W41' });
    const foRow = perf.fo && perf.fo.rows.find((r) => r.user.id === U.fo1.id);
    ok(!foRow || !foRow.failed, 'hiệu suất FO không tính chuyến thất bại');
    const stats = await go('ll', 'GET', '/api/stats', null, {});
    const fs = (stats.fos || []).find((r) => r.fo.id === U.fo1.id);
    ok(!fs || !fs.failed, 'thống kê Rider Live không tính chuyến thất bại');
    inv('chuyến chỉ còn điểm bỏ qua');
  });

  await group('Cùng điểm có giao kit còn lại và đổi thẻ: mã thẻ trong kit ghi riêng; FO / BO báo đúng kế hoạch thì không có Đối chiếu', async () => {
    for (const withLaunch of [true, false]) {
      const W = await world(kind);
      const { h, U, go, inv, job, jobs, kit, card, site, seen, tick } = W;
      const vp = await stockUp(W);
      const req = await launch(W, Q3, ['K01', 'K02']);
      const dl = job({ type: 'deliver', request_id: req.id });
      await go('ll', 'POST', `/api/hub/jobs/${dl.id}/done`, { result: { doc_code: 'BB-1', kit_ids: [kit('K01').id], cards_out: ['SD01', 'SD02'] } });
      const q3 = site('Q3');
      h.clock.set(VN('2026-10-06', '08:00')); seen('l1', 'l2', 't1', 't2'); tick();
      const sw = job({ type: 'card_swap', site_id: q3.id });
      const rest = jobs({ type: 'deliver', request_id: req.id, status: ['open', 'doing'] })[0];
      ok(sw && rest, 'có lượt đổi thẻ và việc giao kit còn lại');
      const body = { job_ids: [sw.id, rest.id], fo_id: U.fo1.id, office_site_id: vp.id, cards_out: { [q3.id]: ['SD03', 'SD04'] } };
      if (withLaunch) body.launch_cards = { [q3.id]: ['SD05', 'SD06'] };
      const tk = (await go('l1', 'POST', '/api/hub/dispatch', body)).task;
      const bs = h.store.stops.find({ task_id: tk.id, site_id: q3.id })[0];
      eq([bs.exp_cards_out, bs.exp_cards_in, bs.exp_dev_out], [4, 2, 1], 'kế hoạch điểm: 2 thẻ đổi + 2 thẻ trong kit, thu 2, giao 1 kit');
      if (withLaunch) eq(card('SD05').task_id, tk.id, 'thẻ trong kit gắn với chuyến');
      inv('xếp chuyến giao + đổi thẻ');
      await runTrip(W, tk.id);
      eq([h.store.jobs.get(sw.id).status, h.store.jobs.get(rest.id).status, kit('K02').status], ['done', 'done', 'at_bo'], 'cả hai việc đóng theo chuyến');
      eq(['SD01', 'SD02'].map((c) => card(c).status), ['returned', 'returned'], 'thẻ cũ được thu về');
      eq(['SD03', 'SD04'].map((c) => card(c).status), ['at_bo', 'at_bo'], 'thẻ đổi ở BO');
      const open = h.store.recon.find({ status: 'open' }).map((r) => r.ref);
      ok(!open.some((r) => r.startsWith('swapout:') || r.startsWith('swapcount:')), `đổi thẻ không bị báo lệch giả: ${open.join(', ')}`);
      if (withLaunch) {
        eq(['SD05', 'SD06'].map((c) => [card(c).status, card(c).site_id]), [['at_bo', q3.id], ['at_bo', q3.id]], 'thẻ trong kit ghi ở BO, không bị lượt đổi thẻ thu nhầm');
        eq(open, [], 'không có dòng Đối chiếu');
      } else eq(open, [`launchcards:${rest.id}`], 'thiếu mã thẻ trong kit → chỉ một dòng Đối chiếu đúng');
      inv('giao + đổi thẻ cùng điểm');
    }
  });
}

await suite('memory');
await suite('sqlite');
summary('fix.trips');
