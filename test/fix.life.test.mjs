// fix.life.test.mjs — kiểm hồi quy vòng đời BO và luồng yêu cầu của Sale: hẹn ngày kết thúc, huỷ kết thúc, tạm nghỉ,
// kết thúc đóng yêu cầu hỗ trợ, huỷ mở lại BO đã kết thúc, yêu cầu lùi về "chuẩn bị", thêm kit cho BO đang ghi hình,
// quyền "Sale Lead xem mọi BO" chỉ là quyền xem, lọc phạm vi Sale trước khi cắt số dòng, việc định kỳ Lead đã huỷ,
// nhật ký yêu cầu gửi Sale và "đang chờ ai". Sau mỗi bước chạy bộ kiểm bất biến (invariants.mjs).
// Mỗi nhóm chạy 2 lần: kho bộ nhớ và kho SQLite.
import { mk, boDevice, ok, eq, group, summary, JPEG } from './harness.mjs';
import { checkInvariants } from './invariants.mjs';

const MIN = 60000;
const VN = (date, hm) => Date.parse(`${date}T${hm}:00+07:00`);
const VP = { name: 'Văn phòng Atlas', type: 'office', lat: 10.7769, lon: 106.7009 };
const Q3 = { name: 'BO Quận 3', code: 'Q3', lat: 10.7835, lon: 106.6869, contact: 'Chị Hoa', phone: '0901111222', address: '12 Võ Văn Tần, Quận 3' };
const TD = { name: 'BO Thủ Đức', code: 'TD', lat: 10.8494, lon: 106.7537, contact: 'Anh Nam', phone: '0903333444', address: 'Thủ Đức' };
const OPEN = ['open', 'doing'];

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

/** Kho: văn phòng và n kit Multicam (K01…Kn), kit mới ở "đang chuẩn bị". */
async function stock(W, n) {
  const { go } = W;
  const vp = (await go('ll', 'POST', '/api/sites', VP)).site;
  const ids = Array.from({ length: n }, (_, i) => String(i + 1).padStart(2, '0'));
  await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: ids.map((i) => 'MC' + i).join(' ') });
  await go('ll', 'POST', '/api/hub/devices', { type: 'cm5', codes: ids.map((i) => 'CM' + i).join(' ') });
  for (const i of ids) await go('l1', 'POST', '/api/hub/kits', { code: 'K' + i, kind: 'multicam', devices: `MC${i} CM${i}` });
  W.seen('l1', 't1');
  return vp;
}
/** Logistics gán kit cho yêu cầu, gửi Tech kiểm; Tech Lead kiểm đạt. */
async function prepKits(W, reqId, codes) {
  const { go, kit, job } = W;
  await go('ll', 'POST', `/api/hub/requests/${reqId}/assign`, { kit_ids: codes.map((c) => kit(c).id) });
  for (const c of codes) {
    await go('ll', 'POST', `/api/hub/kits/${kit(c).id}/submit`);
    await go('tl', 'POST', `/api/hub/jobs/${job({ type: 'check_kit', kit_id: kit(c).id }).id}/done`, { result: { pass: true } });
  }
}
/** BO Q3 của s1 đang ghi hình từ 05/10 với n kit, đổi thẻ mọi ngày 09:00–11:00. */
async function live(W, n = 1, opt = {}) {
  const { go, job, site } = W;
  const vp = await stock(W, opt.total || Math.max(n, 2));
  const req = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: n }, launch_date: '2026-10-05', outlet: Q3, swap_days: '1,2,3,4,5,6,7', swap_from: '09:00', swap_to: '11:00' })).request;
  await prepKits(W, req.id, Array.from({ length: n }, (_, i) => 'K' + String(i + 1).padStart(2, '0')));
  await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'deliver', request_id: req.id }).id}/done`, { result: { doc_code: 'BB-01' } });
  return { vp, q3: site('Q3'), req };
}
const openSwaps = (W, siteId) => W.jobs({ type: 'card_swap', site_id: siteId, status: OPEN }).map((j) => j.date);

async function suite(kind) {
  console.log(`\n── Kho ${kind === 'sqlite' ? 'SQLite' : 'bộ nhớ'} ──`);

  await group('Hẹn ngày kết thúc: BO vẫn ghi hình, đổi thẻ, nhận hỗ trợ tới ngày đó; tới ngày thì chuyển thu hồi', async () => {
    const W = await world(kind);
    const { h, go, tick, inv, job, jobs, site } = W;
    const { q3 } = await live(W);
    tick();
    eq(openSwaps(W, q3.id), ['2026-10-06', '2026-10-07'], 'đối chứng: BO ghi hình, có việc đổi thẻ 2 ngày tới');
    const endReq = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, { date: '2026-10-09', note: 'Hết hợp đồng' })).request;
    eq([endReq.status, site('Q3').ops_status, site('Q3').end_date], ['scheduled', 'live', '2026-10-09'], 'hẹn kết thúc 09/10: BO vẫn ghi hình, yêu cầu ở trạng thái đã hẹn');
    eq(openSwaps(W, q3.id), ['2026-10-06', '2026-10-07'], 'việc đổi thẻ trước ngày kết thúc giữ nguyên');
    const rec = job({ type: 'recover', request_id: endReq.id });
    eq([rec && rec.status, rec && rec.show_date], ['open', '2026-10-09'], 'việc thu hồi đã lên lịch, hiện từ ngày kết thúc');
    const w = (await go('s1', 'GET', `/api/hub/requests/${endReq.id}`)).request.waiting;
    ok(w && /09\/10/.test(w.text), 'Sale thấy ngày đã hẹn kết thúc');
    eq((await go('sh', 'GET', '/api/hub/sale')).hos.kpi.live, 1, 'Head of Sale: BO vẫn tính là đang ghi hình');
    inv('hẹn kết thúc');
    h.clock.set(VN('2026-10-07', '08:00')); tick();
    eq(openSwaps(W, q3.id), ['2026-10-06', '2026-10-07', '2026-10-08'], 'nhịp định kỳ sinh tiếp việc đổi thẻ tới trước ngày kết thúc');
    const sup = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'bad_card', note: 'Một thẻ báo lỗi đọc' })).request;
    eq(sup.status, 'preparing', 'trước ngày kết thúc vẫn gửi được yêu cầu hỗ trợ');
    inv('hỗ trợ trong thời gian báo trước');
    h.clock.set(VN('2026-10-09', '00:30')); tick();
    eq([site('Q3').ops_status, h.store.requests.get(endReq.id).status], ['ending', 'ending'], 'tới ngày kết thúc: BO chuyển "đang thu hồi"');
    ok(h.store.hub_log.find({ entity: 'request', entity_id: endReq.id, action: 'status' }).some((e) => e.data && e.data.to === 'ending'), 'nhật ký ghi bước chuyển sang thu hồi');
    eq(openSwaps(W, q3.id), [], 'việc đổi thẻ chưa lên chuyến huỷ khi bắt đầu thu hồi');
    const s = h.store.requests.get(sup.id);
    ok(s.status === 'closed' && /^Huỷ/.test(s.reason || ''), 'yêu cầu hỗ trợ còn mở được đóng khi BO bắt đầu thu hồi');
    eq(jobs({ request_id: sup.id, status: OPEN }).length, 0, 'việc của yêu cầu hỗ trợ đó được huỷ');
    inv('tới ngày kết thúc');
    await go('ll', 'POST', `/api/hub/jobs/${rec.id}/done`, { result: {} });
    eq([site('Q3').ops_status, h.store.requests.get(endReq.id).status], ['ended', 'closed'], 'thu hồi xong: BO kết thúc, yêu cầu đóng');
    inv('thu hồi xong');
  });

  await group('Thu hồi sớm trước ngày hẹn: BO chuyển thu hồi rồi kết thúc, không kẹt "đang ghi hình" không máy', async () => {
    const W = await world(kind);
    const { h, go, inv, job, site } = W;
    const { q3 } = await live(W);
    const endReq = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, { date: '2026-10-12', note: 'Hết hợp đồng' })).request;
    await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'recover', request_id: endReq.id }).id}/done`, { result: {} });
    eq([site('Q3').ops_status, h.store.requests.get(endReq.id).status], ['ended', 'closed'], 'Logistics thu sớm: BO kết thúc, yêu cầu đóng');
    inv('thu hồi sớm');
  });

  await group('Huỷ kết thúc ghi hình: Sale phụ trách, Head of Sale huỷ được khi FO chưa đi thu; lời báo chỉ đúng thao tác có thật', async () => {
    const W = await world(kind);
    const { h, U, go, call, st, tick, inv, job, jobs, kit, site } = W;
    const { vp, q3, req } = await live(W);
    tick();
    const e1 = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, { date: '2026-10-10', note: 'Hết hợp đồng' })).request;
    eq(await st('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, { date: '2026-10-12', note: 'Đổi ngày' }), 409, 'đã hẹn kết thúc thì không tạo thêm yêu cầu kết thúc');
    eq(await st('s2', 'POST', `/api/hub/requests/${e1.id}/cancel`, { reason: 'Thử huỷ' }), 403, 'Sale Lead khác không huỷ');
    eq(await st('ll', 'POST', `/api/hub/requests/${e1.id}/cancel`, { reason: 'Thử huỷ' }), 403, 'Logistics không huỷ yêu cầu kết thúc của Sale');
    eq(await st('s1', 'POST', `/api/hub/requests/${e1.id}/cancel`, {}), 400, 'huỷ cần lý do');
    await go('s1', 'POST', `/api/hub/requests/${e1.id}/cancel`, { reason: 'BO gia hạn hợp đồng' });
    eq([h.store.requests.get(e1.id).status, site('Q3').ops_status, site('Q3').end_date], ['cancelled', 'live', null], 'huỷ kết thúc đã hẹn: BO tiếp tục ghi hình, bỏ ngày kết thúc');
    eq(jobs({ type: 'recover', status: OPEN }).length, 0, 'việc thu hồi được huỷ');
    inv('huỷ kết thúc đã hẹn');

    // Đã chuyển thu hồi (kết thúc hôm nay) mà FO chưa đi: vẫn huỷ được; kit còn lỗi tại BO có lại việc đổi kit.
    await go('l1', 'POST', `/api/hub/kits/${kit('K01').id}/faulty`, { reason: 'Máy nóng bất thường' });
    eq(jobs({ type: 'swap_faulty', kit_id: kit('K01').id, status: OPEN }).length, 1, 'đối chứng: kit lỗi tại BO có việc đổi kit');
    const e2 = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, { note: 'BO đóng cửa' })).request;
    eq([site('Q3').ops_status, h.store.requests.get(req.id).status, e2.status], ['ending', 'ending', 'ending'], 'kết thúc hôm nay: BO đang thu hồi');
    eq(jobs({ type: 'swap_faulty', status: OPEN }).length, 0, 'đối chứng: việc đổi kit hỏng chưa lên chuyến bị huỷ');
    inv('kết thúc hôm nay');
    await go('sh', 'POST', `/api/hub/requests/${e2.id}/cancel`, { reason: 'Chủ BO đổi ý' });
    eq([site('Q3').ops_status, site('Q3').end_date, h.store.requests.get(req.id).status, h.store.requests.get(e2.id).status], ['live', null, 'live', 'cancelled'], 'Head of Sale huỷ kết thúc: BO và yêu cầu mở BO về "đang ghi hình"');
    eq(jobs({ type: 'swap_faulty', kit_id: kit('K01').id, status: OPEN }).length, 1, 'kit còn lỗi tại BO: việc đổi kit được tạo lại');
    ok(jobs({ type: 'card_swap', site_id: q3.id, status: 'open' }).length > 0, 'việc đổi thẻ được tạo lại');
    ok(h.store.hub_log.find({ entity: 'outlet', entity_id: q3.id, action: 'end_cancel' }).length === 2, 'mỗi lần huỷ kết thúc đều ghi nhật ký BO');
    inv('huỷ khi đang thu hồi');

    // FO đã bắt đầu chuyến thu hồi: không huỷ được nữa.
    const e3 = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, { note: 'BO đóng cửa hẳn' })).request;
    const rec = job({ type: 'recover', request_id: e3.id });
    const trip = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [rec.id], fo_id: U.fo1.id, office_site_id: vp.id, round_trip: true })).task;
    await go('fo1', 'POST', `/api/tasks/${trip.id}/accept`);
    await go('fo1', 'POST', `/api/tasks/${trip.id}/start`);
    const r409 = await call('s1', 'POST', `/api/hub/requests/${e3.id}/cancel`, { reason: 'Đổi ý' });
    ok(r409.status === 409 && !/Lead sửa trạng thái/.test(r409.body.message), 'FO đã đi thu hồi: không huỷ kết thúc được, lời báo không chỉ tới thao tác không có');
    const rc = await call('ll', 'POST', `/api/hub/jobs/${rec.id}/cancel`, { reason: 'Thử huỷ' });
    ok(rc.status === 409 && /huỷ yêu cầu kết thúc/.test(rc.body.message) && !/Lead sửa trạng thái/.test(rc.body.message), 'việc thu hồi không huỷ tay; lời báo chỉ đúng cách huỷ kết thúc');
    const lr = await call('s1', 'POST', '/api/hub/requests', { site_id: q3.id, need: { multicam: 1 }, launch_date: '2026-10-12' });
    ok(lr.status === 409 && /thu hồi/.test(lr.body.message) && !/yêu cầu hỗ trợ/.test(lr.body.message), 'gửi yêu cầu mở BO khi đang thu hồi: lời báo nói đúng tình trạng, không chỉ sang hỗ trợ');
    inv('chuyến thu hồi đã bắt đầu');
    await runTrip(W, trip.id, {}, { started: true });
    eq(site('Q3').ops_status, 'ended', 'thu hồi xong: BO kết thúc');
    eq(await st('s1', 'POST', `/api/hub/requests/${e3.id}/cancel`, { reason: 'Đổi ý' }), 409, 'BO đã kết thúc: không huỷ kết thúc');
    inv('sau thu hồi');
  });

  await group('Tạm nghỉ: xoá hoặc dời khi đang nghỉ thì BO ghi hình lại ngay; kiểm ngày; ghi lùi cần quyền và lý do', async () => {
    const W = await world(kind);
    const { h, go, st, tick, inv, jobs, site } = W;
    const { q3 } = await live(W);
    await go('s1', 'PATCH', `/api/hub/outlets/${q3.id}`, { pause_from: '2026-10-07', pause_to: '2026-10-10' });
    h.clock.set(VN('2026-10-07', '08:00')); tick();
    eq(site('Q3').ops_status, 'paused', 'đối chứng: tới ngày tạm nghỉ BO tự chuyển tạm nghỉ');
    await go('s1', 'PATCH', `/api/hub/outlets/${q3.id}`, { pause_from: '', pause_to: '' });
    eq(site('Q3').ops_status, 'live', 'xoá lịch tạm nghỉ khi đang nghỉ: BO ghi hình lại ngay');
    eq(h.store.hub_log.find({ entity: 'outlet', entity_id: q3.id, action: 'resumed' }).length, 1, 'nhật ký ghi BO ghi hình lại');
    ok(jobs({ type: 'card_swap', site_id: q3.id, status: 'open' }).some((j) => j.date === '2026-10-07'), 'việc đổi thẻ hôm nay sinh lại ngay');
    inv('xoá tạm nghỉ');
    await go('s1', 'PATCH', `/api/hub/outlets/${q3.id}`, { pause_from: '2026-10-07', pause_to: '2026-10-12' });
    eq(site('Q3').ops_status, 'paused', 'đặt tạm nghỉ từ hôm nay: BO tạm nghỉ ngay');
    inv('tạm nghỉ từ hôm nay');
    await go('s1', 'PATCH', `/api/hub/outlets/${q3.id}`, { pause_from: '2026-10-15', pause_to: '2026-10-20' });
    eq(site('Q3').ops_status, 'live', 'dời tạm nghỉ sang tuần sau khi đang nghỉ: BO ghi hình lại ngay');
    ok(jobs({ type: 'card_swap', site_id: q3.id, status: 'open' }).some((j) => j.date === '2026-10-08'), 'việc đổi thẻ những ngày tới sinh lại');
    eq(h.store.hub_log.find({ entity: 'outlet', entity_id: q3.id, action: 'resumed' }).length, 2, 'mỗi lần ghi hình lại đều có nhật ký');
    inv('dời tạm nghỉ');
    eq(await st('s1', 'PATCH', `/api/hub/outlets/${q3.id}`, { pause_from: '2026-10-16', pause_to: '' }), 400, 'chỉ có ngày bắt đầu tạm nghỉ → chặn');
    eq(await st('s1', 'PATCH', `/api/hub/outlets/${q3.id}`, { pause_to: '' }), 400, 'xoá một nửa khoảng tạm nghỉ → chặn');
    eq(await st('s1', 'PATCH', `/api/hub/outlets/${q3.id}`, { pause_from: '2026-10-20', pause_to: '2026-10-15' }), 400, 'ngày kết thúc trước ngày bắt đầu → chặn');
    eq(await st('s1', 'PATCH', `/api/hub/outlets/${q3.id}`, { pause_from: '2026-10-05', pause_to: '2026-10-06' }), 400, 'Sale Lead không đặt tạm nghỉ bắt đầu trong quá khứ');
    eq(await st('l1', 'PATCH', `/api/hub/outlets/${q3.id}`, { pause_from: '2026-10-05', pause_to: '2026-10-06', pause_reason: 'Ghi bù' }), 400, 'Logistics không ghi lùi tạm nghỉ');
    eq(await st('sh', 'PATCH', `/api/hub/outlets/${q3.id}`, { pause_from: '2026-10-05', pause_to: '2026-10-06' }), 400, 'Head of Sale ghi lùi phải có lý do');
    eq([site('Q3').pause_from, site('Q3').pause_to], ['2026-10-15', '2026-10-20'], 'các lần bị chặn không đổi dữ liệu');
    await go('sh', 'PATCH', `/api/hub/outlets/${q3.id}`, { pause_from: '2026-10-05', pause_to: '2026-10-06', pause_reason: 'BO báo nghỉ hai ngày, quên ghi' });
    const bl = h.store.hub_log.find({ entity: 'outlet', entity_id: q3.id, action: 'pause_backdate' });
    ok(bl.length === 1 && /quên ghi/.test(bl[0].text), 'ghi lùi được lưu nhật ký kèm lý do');
    eq(site('Q3').ops_status, 'live', 'khoảng ghi lùi đã qua: BO vẫn ghi hình');
    await go('s1', 'PATCH', `/api/hub/outlets/${q3.id}`, { contact: 'Chị Lan', pause_from: '2026-10-05', pause_to: '2026-10-06' });
    eq(site('Q3').contact, 'Chị Lan', 'gửi lại khoảng tạm nghỉ cũ không đổi thì sửa trường khác không bị chặn');
    inv('ghi lùi');
  });

  await group('Kết thúc ghi hình đóng các yêu cầu hỗ trợ đang mở, không để treo', async () => {
    const W = await world(kind);
    const { h, go, inv, job, jobs, kit, site } = W;
    const { q3 } = await live(W);
    await go('ll', 'POST', '/api/hub/acc/cap_c_c/move', { kind: 'in', qty: 5, reason: 'Nhập kho' });
    const a = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'swap_device', kit_id: kit('K01').id, label: 'Không lên nguồn', note: 'Máy chập chờn' })).request;
    const b = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'bad_card', note: 'Thẻ lỗi đọc' })).request;
    const c = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'extra_acc', acc: { cap_c_c: 1 }, note: 'Thiếu dây' })).request;
    inv('gửi 3 yêu cầu hỗ trợ');
    await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, { note: 'BO đóng cửa' });
    for (const [r, label] of [[a, 'đổi máy hư'], [b, 'thẻ hư'], [c, 'bổ sung phụ kiện']]) {
      const x = h.store.requests.get(r.id);
      ok(x.status === 'closed' && /^Huỷ/.test(x.reason || ''), `yêu cầu ${label} được đóng khi BO kết thúc`);
      eq(jobs({ request_id: r.id, status: OPEN }).length, 0, `việc của yêu cầu ${label} được huỷ`);
    }
    inv('kết thúc ghi hình');
    await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'recover' }).id}/done`, { result: {} });
    eq(site('Q3').ops_status, 'ended', 'thu hồi xong');
    eq(h.store.requests.find({ site_id: q3.id, kind: 'support', status: { ne: 'closed' } }).length, 0, 'không yêu cầu hỗ trợ nào còn treo sau khi BO kết thúc');
    inv('BO kết thúc');
  });

  await group('Huỷ yêu cầu mở lại BO đã kết thúc: BO về "Đã kết thúc", không thành BO tiềm năng', async () => {
    const W = await world(kind);
    const { go, inv, job, site } = W;
    const { q3 } = await live(W);
    await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, { note: 'Hết hợp đồng' });
    await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'recover' }).id}/done`, { result: {} });
    const before = site('Q3');
    eq(before.ops_status, 'ended', 'đối chứng: BO đã kết thúc');
    const rl = (await go('s1', 'POST', '/api/hub/requests', { site_id: q3.id, need: { multicam: 1 }, launch_date: '2026-10-12' })).request;
    eq(site('Q3').ops_status, 'planned', 'đối chứng: gửi mở lại → BO chờ launch');
    await go('s1', 'POST', `/api/hub/requests/${rl.id}/cancel`, { reason: 'BO chưa ký lại' });
    const after = site('Q3');
    eq([after.ops_status, after.end_date, after.launch_date], ['ended', before.end_date, before.launch_date], 'huỷ yêu cầu mở lại: BO về đã kết thúc như trước');
    const hs = await go('sh', 'GET', '/api/hub/sale');
    eq([hs.hos.kpi.ended, hs.hos.kpi.prospect], [1, 0], 'bảng Head of Sale: BO tính là đã kết thúc, không phải tiềm năng');
    inv('huỷ mở lại');
    const nr = (await go('s2', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-12', outlet: TD })).request;
    await go('s2', 'POST', `/api/hub/requests/${nr.id}/cancel`, { reason: 'Khách đổi ý' });
    eq([site('TD').ops_status, site('TD').launch_date], ['planned', null], 'BO mới huỷ yêu cầu đầu tiên: vẫn chờ launch');
    inv('huỷ BO mới');
  });

  await group('Yêu cầu lùi từ "sẵn sàng" về "chuẩn bị": Logistics luôn có việc chuẩn bị', async () => {
    const W = await world(kind);
    const { h, go, call, inv, jobs, kit } = W;
    await stock(W, 3);
    const r = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-12', outlet: Q3 })).request;
    const openPrep = (id = r.id) => jobs({ type: 'prep_kit', request_id: id, status: OPEN });
    await prepKits(W, r.id, ['K01']);
    eq([h.store.requests.get(r.id).status, openPrep().length], ['ready', 0], 'đối chứng: kit đã kiểm → sẵn sàng, việc chuẩn bị tự đóng');
    await go('s1', 'PATCH', `/api/hub/requests/${r.id}`, { need: { multicam: 2 } });
    eq(h.store.requests.get(r.id).status, 'preparing', 'tăng số kit → yêu cầu về "đang chuẩn bị"');
    eq(openPrep().length, 1, 'Logistics có việc chuẩn bị thêm kit');
    ok(/thêm/.test((openPrep()[0] || {}).title || ''), 'tiêu đề việc nói rõ cần chuẩn bị thêm');
    eq(jobs({ type: 'deliver', request_id: r.id, status: OPEN }).length, 0, 'việc giao chưa lên chuyến được huỷ');
    inv('tăng số kit');
    eq((await call('ll', 'POST', `/api/hub/jobs/${openPrep()[0].id}/done`, { result: {} })).status, 409, 'chưa gán đủ kit thì không báo xong việc chuẩn bị');
    await prepKits(W, r.id, ['K02']);
    eq([h.store.requests.get(r.id).status, openPrep().length], ['ready', 0], 'gán và kiểm đủ → sẵn sàng, việc chuẩn bị tự đóng');
    inv('đủ kit');
    await go('l1', 'POST', `/api/hub/kits/${kit('K02').id}/faulty`, { reason: 'Rơi vỡ vỏ' });
    eq(h.store.requests.get(r.id).status, 'preparing', 'kit đã giữ bị báo hỏng → yêu cầu về "đang chuẩn bị"');
    eq(openPrep().length, 1, 'Logistics lại có việc chuẩn bị kit thay');
    inv('kit giữ bị hỏng');
    const r2 = (await go('s2', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-14', outlet: TD })).request;
    await go('ll', 'POST', `/api/hub/requests/${r2.id}/assign`, { kit_ids: [kit('K03').id] });
    eq((await call('ll', 'POST', `/api/hub/jobs/${openPrep(r2.id)[0].id}/done`, { result: {} })).status, 409, 'kit đã gán nhưng chưa gửi kiểm thì chưa báo xong việc chuẩn bị');
    inv('kit chưa gửi kiểm');
  });

  await group('Thêm kit cho BO đang ghi hình hoặc tạm nghỉ: chuẩn bị, kiểm, giao như mở BO', async () => {
    const W = await world(kind);
    const { h, go, call, st, tick, inv, job, jobs, kit, site } = W;
    const { q3, req } = await live(W, 1, { total: 4 });
    const lr = await call('s1', 'POST', '/api/hub/requests', { site_id: q3.id, need: { multicam: 1 }, launch_date: '2026-10-07' });
    ok(lr.status === 409 && /Thêm kit/.test(lr.body.message), 'gửi yêu cầu mở BO cho BO đang ghi hình: chỉ sang loại hỗ trợ "Thêm kit"');
    eq(await st('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'add_kit', need: { multicam: 1 }, note: 'Thiếu ngày giao' }), 400, 'thêm kit cần ngày giao');
    const ak = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'add_kit', need: { multicam: 1 }, launch_date: '2026-10-07', note: 'BO mở thêm quầy' })).request;
    eq([ak.kind, ak.need.kind, ak.status], ['support', 'add_kit', 'preparing'], 'yêu cầu hỗ trợ "Thêm kit" ở bước chuẩn bị');
    eq(jobs({ type: 'prep_kit', request_id: ak.id, status: OPEN }).length, 1, 'Logistics có việc chuẩn bị kit');
    eq(await st('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'add_kit', need: { multicam: 1 }, launch_date: '2026-10-08', note: 'Gửi trùng' }), 409, 'đang có yêu cầu thêm kit chưa giao → không tạo trùng');
    inv('gửi thêm kit');
    await prepKits(W, ak.id, ['K02']);
    eq(h.store.requests.get(ak.id).status, 'ready', 'kit đã kiểm → sẵn sàng giao');
    const dj = job({ type: 'deliver', request_id: ak.id });
    ok(dj && dj.status === 'open', 'Logistics có việc giao kit');
    inv('thêm kit sẵn sàng');
    await go('ll', 'POST', `/api/hub/jobs/${dj.id}/done`, { result: { doc_code: 'BB-02' } });
    eq([kit('K02').status, kit('K02').site_id, h.store.requests.get(ak.id).status], ['at_bo', q3.id, 'closed'], 'giao xong: kit ở BO, yêu cầu đóng');
    eq([site('Q3').ops_status, site('Q3').launch_date, h.store.requests.get(req.id).status], ['live', '2026-10-05', 'live'], 'BO vẫn ghi hình; ngày launch và yêu cầu mở BO giữ nguyên');
    h.clock.set(VN('2026-10-06', '08:00')); tick();
    const sw = jobs({ type: 'card_swap', site_id: q3.id, date: '2026-10-08' })[0];
    ok(sw && /^2 kit/.test(sw.note), 'việc đổi thẻ mới tính theo 2 kit');
    inv('giao thêm kit');
    await go('s1', 'PATCH', `/api/hub/outlets/${q3.id}`, { pause_from: '2026-10-06', pause_to: '2026-10-09' });
    eq(site('Q3').ops_status, 'paused', 'đối chứng: BO tạm nghỉ');
    const ak2 = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'add_kit', need: { multicam: 1 }, launch_date: '2026-10-08', note: 'Chuẩn bị cho đợt sau nghỉ' })).request;
    await prepKits(W, ak2.id, ['K03']);
    await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'deliver', request_id: ak2.id }).id}/done`, { result: { doc_code: 'BB-03' } });
    eq([site('Q3').ops_status, kit('K03').status, h.store.requests.get(ak2.id).status], ['paused', 'at_bo', 'closed'], 'giao thêm kit lúc tạm nghỉ: BO vẫn tạm nghỉ');
    inv('thêm kit lúc tạm nghỉ');
    const ak3 = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'add_kit', need: { multicam: 1 }, launch_date: '2026-10-12', note: 'Thêm nữa' })).request;
    await prepKits(W, ak3.id, ['K04']);
    await go('s1', 'POST', `/api/hub/requests/${ak3.id}/cancel`, { reason: 'BO đổi ý' });
    eq([kit('K04').status, kit('K04').request_id, h.store.requests.get(ak3.id).status], ['ready', null, 'cancelled'], 'huỷ yêu cầu thêm kit: kit đã kiểm về sẵn sàng');
    eq(jobs({ request_id: ak3.id, status: OPEN }).length, 0, 'việc đi kèm được huỷ');
    inv('huỷ thêm kit');
    const bc = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'bad_card', note: 'Thẻ lỗi' })).request;
    eq(await st('s1', 'POST', `/api/hub/requests/${bc.id}/cancel`, { reason: 'Thử huỷ' }), 409, 'yêu cầu hỗ trợ khác không huỷ ở đây (Lead huỷ việc đi kèm)');
    inv('hỗ trợ khác');
  });

  await group('BO tạm nghỉ không có ngày (nhập từ file): nhịp định kỳ và sửa thông tin khác không tự cho ghi hình lại', async () => {
    const W = await world(kind);
    const { h, go, tick, inv, site } = W;
    const { q3 } = await live(W);
    h.store.sites.update(q3.id, { ops_status: 'paused', pause_from: null, pause_to: null }); // như dòng "Tạm nghỉ" nhập từ Excel: không có cột ngày
    h.core.hub.jobs.syncSwaps(site('Q3'), null);
    const before = openSwaps(W, q3.id);
    const resumed = () => h.store.hub_log.find({ entity: 'outlet', entity_id: q3.id, action: 'resumed' }).length;
    tick(); h.clock.set(VN('2026-10-06', '08:00')); tick();
    eq([site('Q3').ops_status, resumed()], ['paused', 0], 'nhịp định kỳ không tự đưa BO tạm nghỉ không ngày về ghi hình');
    eq(openSwaps(W, q3.id), before, 'không sinh thêm việc đổi thẻ cho BO đang tạm nghỉ');
    await go('s1', 'PATCH', `/api/hub/outlets/${q3.id}`, { contact: 'Chị Lan', phone: '0905555666' });
    await go('ll', 'PATCH', `/api/hub/outlets/${q3.id}`, { lat: 10.7836, lon: 106.687 });
    eq([site('Q3').ops_status, resumed()], ['paused', 0], 'sửa liên hệ, toạ độ: BO vẫn tạm nghỉ');
    await go('s1', 'PATCH', `/api/hub/outlets/${q3.id}`, { pause_from: null, pause_to: null });
    eq([site('Q3').ops_status, resumed()], ['paused', 0], 'gửi lại lịch trống như cũ: không đổi gì');
    inv('tạm nghỉ không ngày');
    await go('s1', 'PATCH', `/api/hub/outlets/${q3.id}`, { pause_from: '2026-10-06', pause_to: '2026-10-08' });
    eq(site('Q3').ops_status, 'paused', 'Sale đặt lịch tạm nghỉ phủ hôm nay: BO vẫn tạm nghỉ');
    h.clock.set(VN('2026-10-09', '08:00')); tick();
    eq([site('Q3').ops_status, resumed()], ['live', 1], 'hết lịch tạm nghỉ đã đặt: BO ghi hình lại, có nhật ký');
    inv('hết tạm nghỉ');
  });

  await group('Kit thêm đi trên chuyến tới BO đã kết thúc: BO không tự ghi hình lại, quay về thu hồi và vào Đối chiếu', async () => {
    const W = await world(kind);
    const { h, U, go, inv, job, jobs, kit, site } = W;
    const { vp, q3, req } = await live(W, 1, { total: 3 });
    const ak = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'add_kit', need: { multicam: 1 }, launch_date: '2026-10-06', note: 'BO mở thêm quầy' })).request;
    await prepKits(W, ak.id, ['K02']);
    const dj = job({ type: 'deliver', request_id: ak.id });
    const trip = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [dj.id], fo_id: U.fo1.id, office_site_id: vp.id, round_trip: true })).task;
    const endReq = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, { note: 'BO đóng cửa' })).request;
    await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'recover', request_id: endReq.id }).id}/done`, { result: {} });
    eq([site('Q3').ops_status, h.store.requests.get(endReq.id).status, h.store.requests.get(ak.id).status, kit('K02').status], ['ended', 'closed', 'ready', 'reserved'], 'đối chứng: BO kết thúc trong khi việc giao kit thêm đã lên chuyến');
    inv('kết thúc khi kit thêm đang trên chuyến');
    await runTrip(W, trip.id);
    const s = site('Q3');
    eq([s.ops_status, s.end_date, kit('K02').status, kit('K02').site_id], ['ending', endReq.need.end_date, 'at_bo', q3.id], 'FO giao tới BO đã kết thúc: BO về "đang thu hồi", không thành đang ghi hình');
    eq(h.store.requests.get(req.id).status, 'closed', 'yêu cầu mở BO đã đóng giữ nguyên');
    const rec = jobs({ type: 'recover', site_id: q3.id, status: OPEN });
    eq(rec.length, 1, 'có việc thu hồi phần kit vừa giao');
    ok(h.store.recon.find({ ref: `deliver_ending:${q3.id}` }).length === 1, 'đưa vào Đối chiếu cho Logistics');
    ok(h.store.hub_log.find({ entity: 'outlet', entity_id: q3.id, action: 'ending' }).length === 1, 'nhật ký BO ghi bước quay lại thu hồi');
    eq(openSwaps(W, q3.id), [], 'không sinh việc đổi thẻ cho BO đang thu hồi');
    inv('kit tới BO đã kết thúc');
    await go('ll', 'POST', `/api/hub/jobs/${rec[0].id}/done`, { result: {} });
    eq(site('Q3').ops_status, 'ended', 'thu xong phần này: BO kết thúc lại');
    inv('thu phần kit thêm');
  });

  await group('FO thu sớm trước ngày hẹn: nhật ký BO Head of Sale đọc không có tên FO', async () => {
    const W = await world(kind);
    const { h, U, go, inv, job, site } = W;
    const { vp, q3 } = await live(W);
    const endReq = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, { date: '2026-10-12', note: 'Hết hợp đồng' })).request;
    const trip = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [job({ type: 'recover', request_id: endReq.id }).id], fo_id: U.fo1.id, office_site_id: vp.id, round_trip: true })).task;
    await runTrip(W, trip.id);
    eq(site('Q3').ops_status, 'ended', 'đối chứng: FO thu sớm, BO kết thúc');
    const items = (await go('sh', 'GET', '/api/hub/log', null, { entity: 'outlet', id: q3.id })).items;
    ok(items.some((l) => l.action === 'end'), 'đối chứng: có nhật ký chuyển thu hồi');
    ok(!items.some((l) => /FO Một/.test(l.text) || /FO Một/.test(l.actor)), 'không lộ tên FO trong nhật ký BO');
    inv('FO thu sớm');
  });

  await group('Sale Lead xem mọi BO (saleSeesAll) chỉ là quyền xem: không sửa, không huỷ, không kết thúc BO của người khác', async () => {
    const W = await world(kind);
    const { go, st, inv, site } = W;
    const { q3 } = await live(W);
    const pend = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-12', outlet: TD })).request;
    await go('ad', 'PUT', '/api/hub/config', { saleSeesAll: true });
    const o = await go('s2', 'GET', `/api/hub/outlets/${q3.id}`);
    eq([o.outlet.id, o.can_write], [q3.id, false], 'Sale Lead khác xem được BO, máy chủ báo không sửa được');
    eq((await go('s1', 'GET', `/api/hub/outlets/${q3.id}`)).can_write, true, 'Sale phụ trách sửa được BO của mình');
    eq(await st('s2', 'PATCH', `/api/hub/outlets/${q3.id}`, { quota_hours: 1 }), 403, 'không sửa quota BO người khác');
    eq(await st('s2', 'POST', `/api/hub/outlets/${q3.id}/end`, { note: 'Thử kết thúc' }), 403, 'không kết thúc BO người khác');
    eq(await st('s2', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'bad_card', note: 'Thử hỗ trợ' }), 403, 'không gửi hỗ trợ cho BO người khác');
    eq((await go('s2', 'GET', `/api/hub/requests/${pend.id}`)).can_write, false, 'xem được yêu cầu, máy chủ báo không sửa được');
    eq(await st('s2', 'PATCH', `/api/hub/requests/${pend.id}`, { note: 'Sửa thử' }), 403, 'không sửa yêu cầu người khác');
    eq(await st('s2', 'POST', `/api/hub/requests/${pend.id}/cancel`, { reason: 'Huỷ thử' }), 403, 'không huỷ yêu cầu người khác');
    eq(await st('s2', 'POST', '/api/hub/requests', { site_id: site('TD').id, need: { multicam: 1 }, launch_date: '2026-10-12' }), 403, 'không gửi yêu cầu cho BO người khác');
    const sv = await go('s2', 'GET', '/api/hub/sale');
    eq([sv.scope, sv.can_edit_quota], ['view', 'own'], 'bảng Sale: phạm vi chỉ xem, chỉ sửa quota BO của mình');
    ok(!sv.by_sale && !sv.hos.by_sale && !sv.hos.sale_names && sv.hos.onboard_by_month.every((m) => !m.by_sale), 'không có số theo từng Sale Lead (chỉ Head of Sale)');
    ok(sv.hos.outlets.some((x) => x.id === q3.id), 'vẫn xem được BO của người khác');
    await go('s1', 'PATCH', `/api/hub/outlets/${q3.id}`, { quota_hours: 50 });
    eq(site('Q3').quota_hours, 50, 'chủ BO vẫn sửa được');
    const hs = await go('sh', 'GET', '/api/hub/sale');
    ok(hs.scope === 'all' && hs.hos.by_sale.length > 0 && hs.can_edit_quota === true, 'Head of Sale giữ bảng theo Sale Lead và quyền sửa quota');
    inv('saleSeesAll');
  });

  await group('Danh sách của Sale lọc theo phạm vi trước khi cắt số dòng', async () => {
    const W = await world(kind);
    const { h, U, go, site } = W;
    await go('ll', 'POST', '/api/sites', VP);
    const mine = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-12', outlet: Q3 })).request;
    await go('s2', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-12', outlet: TD });
    const td = site('TD'), t0 = h.clock.now();
    for (let i = 0; i < 520; i++) h.store.requests.insert({ code: `YX-${i}`, kind: 'support', site_id: td.id, parent_id: null, sale_id: U.s2.id, created_by: U.s2.id, status: 'closed', need: { kind: 'other' }, launch_date: null, kit_id: null, note: 'Cũ', reason: '', created_at: t0 + 1000 + i, updated_at: t0 + 1000 + i, closed_at: t0 + 1000 + i });
    ok((await go('s1', 'GET', '/api/hub/requests')).requests.some((r) => r.id === mine.id), 'Sale Lead vẫn thấy yêu cầu của mình dù có hơn 500 yêu cầu mới hơn của người khác');
    ok((await go('ll', 'GET', '/api/hub/requests')).requests.some((r) => r.id === mine.id), 'Logistics thấy mọi yêu cầu đang mở dù có hơn 500 yêu cầu đã đóng mới hơn');
    const rec = (siteId, date, i) => ({ card_id: null, code: `SDX${i}`, site_id: siteId, kit_id: null, handover_id: null, shoot_date: date, gb: 16.9, hours: 1, zero_reason: null, photos: null, by_id: U.t1.id, at: t0, edited_by: null, edited_at: null, src: 'import' });
    h.store.card_records.insert(rec(site('Q3').id, '2026-10-04', 0));
    for (let i = 1; i <= 5001; i++) h.store.card_records.insert(rec(td.id, '2026-10-05', i));
    eq((await go('s1', 'GET', '/api/hub/cards/records')).total, 1, 'Sale Lead thấy bản ghi dung lượng BO của mình dù có hơn 5000 bản ghi mới hơn của BO khác');
  });

  await group('Lead huỷ việc đổi thẻ hoặc kiểm kho: nhịp định kỳ không tạo lại cho cùng BO và ngày', async () => {
    const W = await world(kind);
    const { h, go, tick, inv, job, jobs } = W;
    const { q3 } = await live(W);
    tick();
    const s06 = jobs({ type: 'card_swap', site_id: q3.id, date: '2026-10-06' })[0];
    await go('ll', 'POST', `/api/hub/jobs/${s06.id}/cancel`, { reason: 'BO xin bỏ lượt đổi thẻ ngày này' });
    tick(); tick();
    eq(jobs({ type: 'card_swap', site_id: q3.id, date: '2026-10-06', status: OPEN }).length, 0, 'lượt đổi thẻ Lead đã huỷ không bị tạo lại');
    await go('s1', 'PATCH', `/api/hub/outlets/${q3.id}`, { swap_from: '09:30' });
    eq(jobs({ type: 'card_swap', site_id: q3.id, date: '2026-10-06', status: OPEN }).length, 0, 'đổi khung giờ đổi thẻ cũng không tạo lại lượt Lead đã huỷ');
    eq(jobs({ type: 'card_swap', site_id: q3.id, date: '2026-10-07', status: OPEN }).length, 1, 'lượt khác vẫn còn');
    inv('huỷ lượt đổi thẻ');
    h.clock.set(VN('2026-10-09', '08:00')); tick();
    const sc = job({ type: 'stock_check', date: '2026-10-09' });
    ok(sc && sc.status === 'open', 'đối chứng: thứ Sáu có việc kiểm kho');
    await go('ll', 'POST', `/api/hub/jobs/${sc.id}/cancel`, { reason: 'Kho đóng cửa kiểm kê năm' });
    tick(); tick();
    eq(jobs({ type: 'stock_check', date: '2026-10-09', status: OPEN }).length, 0, 'việc kiểm kho Lead đã huỷ không bị tạo lại');
    inv('huỷ kiểm kho');
  });

  await group('Nhật ký yêu cầu gửi Sale: không kèm mã người làm và dữ liệu thô, FO hiện vai "FO"', async () => {
    const W = await world(kind);
    const { U, go, job } = W;
    const { vp, q3 } = await live(W);
    await go('ll', 'POST', '/api/hub/acc/cap_c_c/move', { kind: 'in', qty: 5, reason: 'Nhập kho' });
    const sup = (await go('s1', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'extra_acc', acc: { cap_c_c: 1 }, note: 'BO thiếu 1 dây' })).request;
    const trip = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [job({ type: 'deliver_acc' }).id], fo_id: U.fo1.id, office_site_id: vp.id, round_trip: true })).task;
    await runTrip(W, trip.id);
    const d = await go('s1', 'GET', `/api/hub/requests/${sup.id}`);
    ok(d.log.length > 0 && d.log.every((e) => !('actor_id' in e) && !('entity_id' in e)), 'nhật ký gửi Sale không kèm mã người làm');
    ok(d.log.some((e) => e.actor === 'FO'), 'bước FO làm hiện vai "FO"');
    ok(!JSON.stringify(d.log).includes('FO Một'), 'không lộ tên FO');
    ok(d.log.every((e) => e.action === 'status' || !e.data), 'không kèm dữ liệu thô');
    ok((await go('ll', 'GET', `/api/hub/requests/${sup.id}`)).log.some((e) => e.actor_id === U.fo1.id), 'Logistics vẫn thấy đầy đủ');
  });

  await group('"Đang chờ" chỉ đúng team: kit thu hồi chờ Tech check-in, Tech xong chờ Logistics nhận lại', async () => {
    const W = await world(kind);
    const { go, inv, job, kit, site } = W;
    const { q3 } = await live(W, 1, { total: 2 });
    await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, { note: 'Hết hợp đồng' });
    await go('ll', 'POST', `/api/hub/jobs/${job({ type: 'recover' }).id}/done`, { result: {} });
    eq(kit('K01').status, 'returned', 'đối chứng: kit thu hồi chờ check-in');
    const r = (await go('s2', 'POST', '/api/hub/requests', { need: { multicam: 2 }, launch_date: '2026-10-20', outlet: TD })).request;
    await go('ll', 'POST', `/api/hub/requests/${r.id}/assign`, { kit_ids: [kit('K01').id, kit('K02').id] });
    await go('ll', 'POST', `/api/hub/kits/${kit('K02').id}/submit`);
    let w = (await go('s2', 'GET', `/api/hub/requests/${r.id}`)).request.waiting;
    ok(w && w.who === 'Tech' && /check-in/.test(w.text) && /K01/.test(w.text), 'kit thu hồi đã gán: đang chờ Tech check-in');
    ok(w && /K02/.test(w.text) && /Tech kiểm/.test(w.text), 'kit đã gửi kiểm: chờ Tech kiểm');
    await go('tl', 'POST', `/api/hub/jobs/${job({ type: 'checkin', kit_id: kit('K01').id }).id}/done`, { result: { pass: true } });
    await go('tl', 'POST', `/api/hub/jobs/${job({ type: 'check_kit', kit_id: kit('K02').id }).id}/done`, { result: { pass: true } });
    eq(kit('K01').status, 'tech_done', 'đối chứng: Tech check-in xong');
    w = (await go('s2', 'GET', `/api/hub/requests/${r.id}`)).request.waiting;
    ok(w && w.who === 'Logistics' && /nhận lại/.test(w.text), 'Tech xong: đang chờ Logistics nhận lại kit');
    const row = (await go('sh', 'GET', '/api/hub/sale')).hos.waiting_list.find((x) => x.id === site('TD').id);
    ok(row && row.request.waiting && row.request.waiting.who === 'Logistics', 'bảng Head of Sale "Chờ launch" nói đúng đang chờ ai');
    ok(row && !/Logistics/.test(row.request.status_label), 'nhãn trạng thái "đang chuẩn bị" không đổ cho riêng Logistics');
    inv('đang chờ ai');
  });
}

for (const kind of ['memory', 'sqlite']) await suite(kind);
summary('Vòng đời BO và yêu cầu (sửa lỗi)');
