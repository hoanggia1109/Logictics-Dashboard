// fix.incid.test.mjs — kiểm hồi quy cho nhóm lỗi sự cố, Điểm nghẽn và Tổng quan:
// Sale không thấy tên FO (người xử lý sự cố, mục theo dõi); sự cố từ yêu cầu đổi máy đóng / huỷ thì việc đổi kit, cờ lỗi và yêu cầu đi theo;
// bắt đầu / nhận việc sự cố là nhận sự cố; chỉ người giữ việc hoặc Tech Lead nhận; yêu cầu đổi máy gộp vào sự cố đang mở;
// đổi QR theo từng lần đổi kit; Top 10 gộp theo nhãn lỗi, gắn kit cho sự cố chưa có kit; "Không phải sự cố" đếm riêng;
// ngưỡng theo dõi đọc từ Cài đặt; ô Đối chiếu theo team; danh sách sự cố lọc theo kỳ, dòng kit khớp số thống kê;
// phụ kiện dư khi thu hồi vào Đối chiếu; thông báo nhập dữ liệu không lặp chữ "BO".
// Mỗi nhóm chạy 2 lần: kho bộ nhớ và kho SQLite; sau các bước chính chạy bộ kiểm bất biến.
import { mk, boDevice, ok, eq, group, summary, JPEG } from './harness.mjs';
import { checkInvariants } from './invariants.mjs';
import { buildXlsx } from './xlsx-build.mjs';

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const VN = (date, hm) => Date.parse(`${date}T${hm}:00+07:00`);
const VP = { name: 'Văn phòng Atlas', type: 'office', lat: 10.7769, lon: 106.7009 };

async function world(kind) {
  const h = mk(kind);
  h.clock.set(VN('2026-10-05', '08:30')); // Thứ Hai, W41
  const people = [['ad', 'admin', 'Quản trị'], ['tl', 'tech_lead', 'Trưởng Tech'], ['t1', 'tech', 'Tech Một'], ['t2', 'tech', 'Tech Hai'], ['ll', 'lead', 'Trưởng Logistics'],
    ['l1', 'logistic', 'Log Một'], ['l2', 'logistic', 'Log Hai'], ['fo1', 'fo', 'FO Một'], ['sh', 'sale_head', 'Trưởng Sale'], ['s1', 'sale', 'Sale Một'], ['s2', 'sale', 'Sale Hai']];
  const U = {};
  for (const [u, role, name] of people) U[u] = await h.user(u, role, { name });
  const S = h.store;
  const go = async (who, method, path, body, query) => {
    const r = await h.call(who, method, path, body, query);
    if (r.status !== 200) throw new Error(`${who} ${method} ${path} → ${r.status} ${r.body.error}: ${r.body.message}`);
    return r.body;
  };
  const call = (who, method, path, body, query) => h.call(who, method, path, body, query);
  const st = async (who, method, path, body, query) => (await h.call(who, method, path, body, query)).status;
  const seen = (...us) => { for (const u of us) h.core.hub.K.hooks.onSeen(h.byName(u), h.clock.now()); };
  const inv = (label) => { const v = checkInvariants(S); ok(!v.length, `bất biến sau "${label}": ${v.join(' | ')}`); return v; };
  const job = (where) => S.jobs.find(where, { order: 'id', desc: true, limit: 1 })[0] || null;
  const kit = (code) => S.kits.find({ code }, { limit: 1 })[0];
  const dev = (code) => S.devices.find({ code }, { limit: 1 })[0];
  const site = (code) => S.sites.find({ code }, { limit: 1 })[0];
  const uname = (id) => S.users.get(id).username;
  /** Người đang giữ việc bấm xong; việc để chung thì Lead của team làm. */
  const doJob = async (j, result = {}, who) => go(who || (j.assignee_id ? uname(j.assignee_id) : (j.team === 'tech' ? 'tl' : 'll')), 'POST', `/api/hub/jobs/${j.id}/done`, { result });

  // ── Kho: 6 kit Multicam, 1 kit iPhone, thẻ nhớ, phụ kiện ──
  await go('ll', 'POST', '/api/sites', VP);
  const mcs = Array.from({ length: 6 }, (_, i) => 'MC0' + (i + 1)), cms = Array.from({ length: 6 }, (_, i) => 'CM0' + (i + 1));
  await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: mcs.join(' ') });
  await go('ll', 'POST', '/api/hub/devices', { type: 'cm5', codes: cms.join(' ') });
  await go('ll', 'POST', '/api/hub/devices', { type: 'iphone', codes: 'IP01 IP02' });
  await go('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: Array.from({ length: 30 }, (_, i) => 'SD' + String(i + 1).padStart(2, '0')).join(' ') });
  for (const id of ['hub_sac', 'day_gan', 'headstrap']) await go('ll', 'POST', `/api/hub/acc/${id}/move`, { kind: 'in', qty: 20, reason: 'Tồn đầu kỳ' });
  for (let i = 0; i < 6; i++) await go('l1', 'POST', '/api/hub/kits', { code: 'K0' + (i + 1), kind: 'multicam', devices: `${mcs[i]} ${cms[i]}`, acc: { hub_sac: 1, day_gan: 1 } });
  await go('l1', 'POST', '/api/hub/kits', { code: 'P01', kind: 'iphone', devices: 'IP01', acc: { headstrap: 1 } });
  // ── Phân ca: việc chỉ tự giao cho người đã có ca ──
  await go('ll', 'PUT', '/api/hub/roster', { rows: [U.l1, U.l2].map((u) => ({ user_id: u.id, date: '2026-10-05', shift: 'HC' })) });
  await go('tl', 'PUT', '/api/hub/roster', { rows: [U.t1, U.t2].map((u) => ({ user_id: u.id, date: '2026-10-05', shift: 'HC' })) });
  seen('l1', 'l2', 't1', 't2', 'tl', 'll');

  /** Sale mở BO với các kit cho sẵn; Logistics giao tay (biên bản), không qua FO. */
  async function launch(who, code, kitCodes) {
    const today = new Date(h.clock.now() + 7 * HOUR).toISOString().slice(0, 10);
    const outlet = { name: 'BO ' + code, code, lat: 10.78 + kitCodes.length / 1000 + code.charCodeAt(0) / 10000, lon: 106.69 + code.charCodeAt(1) / 10000, contact: 'Chị ' + code, phone: '09' + String(10000000 + code.charCodeAt(0) * 1000 + code.charCodeAt(1)), address: 'Địa chỉ ' + code };
    const req = (await go(who, 'POST', '/api/hub/requests', { need: { multicam: kitCodes.length }, launch_date: today, outlet, swap_days: [1, 2, 3, 4, 5, 6, 7], swap_from: '09:00', swap_to: '11:00' })).request;
    await go('l1', 'POST', `/api/hub/requests/${req.id}/assign`, { kit_ids: kitCodes.map((c) => kit(c).id) });
    for (const c of kitCodes) await go('l1', 'POST', `/api/hub/kits/${kit(c).id}/submit`);
    for (const c of kitCodes) await doJob(job({ type: 'check_kit', kit_id: kit(c).id }), { pass: true });
    await doJob(job({ type: 'deliver', request_id: req.id }), { doc_code: 'BB-' + code });
    return site(code);
  }
  async function readyKit(code) { await go('l1', 'POST', `/api/hub/kits/${kit(code).id}/submit`); await doJob(job({ type: 'check_kit', kit_id: kit(code).id }), { pass: true }); return kit(code); }
  const report = async (who, s, kitCode, label, text = 'Máy báo lỗi') => (await go(who, 'POST', '/api/hub/incidents', { site_id: s.id, kit_id: kitCode ? kit(kitCode).id : null, label, text })).incident;
  const support = async (who, s, kitCode, label, note = 'Máy chập chờn, xin đổi', extra = {}) => (await go(who, 'POST', `/api/hub/outlets/${s.id}/support`, { kind: 'swap_device', kit_id: kit(kitCode).id, label, note, ...extra })).request;
  const watch = async (who) => (await go(who, 'GET', '/api/hub/overview')).watch;
  return { h, S, U, go, call, st, seen, inv, job, kit, dev, site, uname, doJob, launch, readyKit, report, support, watch };
}

async function suite(kind) {
  console.log(`\n── Kho ${kind === 'sqlite' ? 'SQLite' : 'bộ nhớ'} ──`);

  await group('Sale không thấy tên FO: người xử lý sự cố, việc của sự cố, mục theo dõi kit lỗi', async () => {
    const { h, S, U, go, inv, job, kit, launch, readyKit, report, support, watch } = await world(kind);
    const q3 = await launch('s1', 'Q3', ['K01']);
    await readyKit('K03');
    await support('s1', q3, 'K01', 'Không ghi hình');
    const inc = S.incidents.find({ kit_id: kit('K01').id })[0];
    const sw = job({ type: 'swap_faulty', kit_id: kit('K01').id });
    // Việc đổi kit nằm trên chuyến A khi Sale kết thúc BO; chuyến A huỷ; FO thu hồi ở chuyến B → việc đổi kit bị huỷ với người thao tác là FO.
    const tA = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [sw.id], fo_id: U.fo1.id, swap_kits: { [sw.id]: kit('K03').id } })).task;
    await go('s1', 'POST', `/api/hub/outlets/${q3.id}/end`, { date: '2026-10-05', note: 'Đóng cửa' });
    await go('l1', 'POST', `/api/tasks/${tA.id}/cancel`, { reason: 'FO bận' });
    const rec = S.jobs.find({ type: 'recover', site_id: q3.id, status: ['open', 'doing'] })[0];
    const tB = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [rec.id], fo_id: U.fo1.id })).task;
    await go('fo1', 'POST', `/api/tasks/${tB.id}/accept`);
    await go('fo1', 'POST', `/api/tasks/${tB.id}/start`);
    const s = S.stops.find({ task_id: tB.id }, { order: 'seq' })[0];
    h.clock.add(40 * MIN);
    await go('fo1', 'POST', `/api/stops/${s.id}/proof`, { photos: [JPEG], cards_out: s.exp_cards_out, cards_in: s.exp_cards_in, dev_out: s.exp_dev_out, dev_in: s.exp_dev_in, lat: s.lat, lon: s.lon });
    const { token } = await go('l1', 'POST', `/api/stops/${s.id}/bo-link`);
    const bo = boDevice(h);
    await bo.call('POST', '/api/bo-link/view', { token });
    await bo.call('POST', '/api/bo-link/confirm', { token, photos: [JPEG], cards_recv: s.exp_cards_out, cards_given: s.exp_cards_in, dev_recv: s.exp_dev_out, dev_given: s.exp_dev_in });
    eq(S.jobs.get(sw.id).status, 'cancelled', 'thu hồi qua FO huỷ việc đổi kit còn treo');
    const i2 = S.incidents.get(inc.id);
    ok(i2.status === 'resolved' && i2.resolved_by !== U.fo1.id, 'sự cố đóng nhưng không ghi FO là người xử lý');
    const det = await go('s1', 'GET', `/api/hub/incidents/${inc.id}`);
    ok(!JSON.stringify(det).includes('FO Một'), 'Sale mở sự cố: không có tên FO');
    const lst = await go('s1', 'GET', '/api/hub/incidents', null, { status: 'all' });
    ok(!JSON.stringify(lst).includes('FO Một'), 'danh sách sự cố của Sale: không có tên FO');
    inv('FO thu hồi, việc đổi kit huỷ');
    // Phòng thủ thêm: dữ liệu cũ ghi FO là người xử lý / người giữ việc của sự cố → Sale chỉ thấy vai "FO", Logistics thấy tên.
    S.incidents.update(inc.id, { resolved_by: U.fo1.id });
    eq((await go('s1', 'GET', `/api/hub/incidents/${inc.id}`)).incident.resolved_by, 'FO', 'Sale thấy người xử lý là "FO"');
    eq((await go('sh', 'GET', '/api/hub/incidents', null, { status: 'all' })).incidents.find((x) => x.id === inc.id).resolved_by, 'FO', 'Head of Sale thấy "FO" trong danh sách');
    const op = (await go('s1', 'GET', `/api/hub/outlets/${q3.id}`)).incidents.find((x) => x.id === inc.id);
    eq(op.resolved_by, 'FO', 'trang BO của Sale: người xử lý là "FO"');
    eq((await go('ll', 'GET', `/api/hub/incidents/${inc.id}`)).incident.resolved_by, 'FO Một', 'Logistics vẫn thấy tên FO');

    // Mục theo dõi "kit lỗi tại BO" của Head of Sale không kèm tên FO giữ việc đổi kit.
    const td = await launch('s1', 'TD', ['K02']);
    await support('s1', td, 'K02', 'Không ghi hình', 'Máy chập chờn');
    const sw2 = job({ type: 'swap_faulty', kit_id: kit('K02').id });
    S.jobs.update(sw2.id, { assignee_id: U.fo1.id }); // dữ liệu có FO giữ việc (đường giao việc thẳng qua API)
    const wsh = (await watch('sh')).filter((w) => w.kind === 'kit_fault' && w.link === `kit:${kit('K02').id}`);
    ok(wsh.length === 1 && !wsh[0].text.includes('FO Một') && wsh[0].text.includes('(FO)'), `Head of Sale: kit lỗi tại BO ghi "FO", không ghi tên — ${JSON.stringify(wsh.map((w) => w.text))}`);
    ok((await watch('ll')).some((w) => w.kind === 'kit_fault' && w.text.includes('FO Một')), 'Logistic Lead vẫn thấy tên người giữ việc');
    // Việc xử lý sự cố đang ở FO (dữ liệu cũ): Sale thấy "FO".
    const i3 = await report('s1', td, 'K02', 'Quá nhiệt', 'Máy nóng');
    S.jobs.update(i3.job.id, { assignee_id: U.fo1.id });
    eq((await go('s1', 'GET', `/api/hub/incidents/${i3.id}`)).incident.job.assignee, 'FO', 'Sale thấy việc sự cố do "FO" giữ, không thấy tên');
    S.jobs.update(i3.job.id, { assignee_id: null });
    inv('mục theo dõi của Head of Sale');
  });

  await group('Sự cố từ yêu cầu đổi máy: Tech kết luận không phải sự cố / không cần đổi, hoặc huỷ sự cố → huỷ việc đổi kit, gỡ cờ lỗi, đóng yêu cầu', async () => {
    const { S, U, go, inv, job, kit, dev, launch, support, watch } = await world(kind);
    const q3 = await launch('s1', 'Q3', ['K01', 'K02', 'K03']);
    // K01: Tech kết luận "Không phải sự cố".
    const r1 = await support('s1', q3, 'K01', 'Không ghi hình', 'Máy chập chờn, xin đổi', { device_id: dev('MC01').id });
    const i1 = S.incidents.find({ kit_id: kit('K01').id })[0];
    const sw1 = job({ type: 'swap_faulty', kit_id: kit('K01').id });
    eq([kit('K01').fault, dev('MC01').cond, sw1.status], ['Máy chập chờn, xin đổi', 'faulty', sw1.status], 'trước: kit mang cờ lỗi, thiết bị ghi hỏng, có việc đổi kit');
    await go('t1', 'POST', `/api/hub/incidents/${i1.id}/resolve`, { resolution: 'invalid', note: 'BO quên bật nguồn' });
    eq([S.incidents.get(i1.id).status, S.incidents.get(i1.id).resolution], ['resolved', 'invalid'], 'sự cố đóng: không phải sự cố');
    eq(S.jobs.get(sw1.id).status, 'cancelled', 'việc đổi kit được huỷ');
    eq([kit('K01').fault, dev('MC01').cond], [null, 'ok'], 'cờ lỗi của kit và thiết bị do lần báo này đặt được gỡ');
    eq(S.requests.get(r1.id).status, 'closed', 'yêu cầu hỗ trợ đóng lại');
    ok(S.inbox.count({ user_id: U.s1.id, ref: `support_cancel:${r1.id}` }) === 1, 'Sale được báo yêu cầu đóng mà không đổi máy');
    inv('Tech kết luận không phải sự cố');
    // K02: Tech Lead kết luận "Xử lý tại chỗ, không cần đổi".
    const r2 = await support('s1', q3, 'K02', 'Không ghi hình');
    const i2 = S.incidents.find({ kit_id: kit('K02').id })[0];
    const sw2 = job({ type: 'swap_faulty', kit_id: kit('K02').id });
    await go('tl', 'POST', `/api/hub/incidents/${i2.id}/resolve`, { resolution: 'no_recover', note: 'Khởi động lại máy, ghi bình thường' });
    eq([S.jobs.get(sw2.id).status, kit('K02').fault, S.requests.get(r2.id).status], ['cancelled', null, 'closed'], 'không cần đổi: việc đổi kit huỷ, gỡ cờ lỗi, yêu cầu đóng');
    inv('Tech xử lý tại chỗ');
    // K03: người báo huỷ sự cố trong thời gian cho phép.
    const r3 = await support('s1', q3, 'K03', 'Không ghi hình');
    const i3 = S.incidents.find({ kit_id: kit('K03').id })[0];
    const sw3 = job({ type: 'swap_faulty', kit_id: kit('K03').id });
    await go('s1', 'POST', `/api/hub/incidents/${i3.id}/cancel`, { reason: 'Báo nhầm kit' });
    eq([S.incidents.get(i3.id).status, S.jobs.get(sw3.id).status, kit('K03').fault, S.requests.get(r3.id).status], ['cancelled', 'cancelled', null, 'closed'], 'huỷ sự cố: việc đổi kit huỷ, gỡ cờ lỗi, yêu cầu đóng');
    const kf = (await watch('ll')).filter((w) => w.kind === 'kit_fault');
    eq(kf.length, 0, 'không còn dòng "kit lỗi tại BO" nào');
    inv('huỷ sự cố từ yêu cầu đổi máy');
  });

  await group('Huỷ yêu cầu đổi máy: gỡ cờ lỗi do yêu cầu đặt; kit còn báo lỗi khác hoặc việc đã lên chuyến thì giữ việc và đưa vào Đối chiếu', async () => {
    const { h, S, U, go, call, inv, job, kit, launch, readyKit, support, watch } = await world(kind);
    const td = await launch('s2', 'TD', ['K04', 'K05']);
    const r4 = await support('s2', td, 'K04', 'Không ghi hình');
    const i4 = S.incidents.find({ kit_id: kit('K04').id })[0];
    const sw4 = job({ type: 'swap_faulty', kit_id: kit('K04').id });
    await go('s2', 'POST', `/api/hub/requests/${r4.id}/cancel`, { reason: 'BO tự khắc phục' });
    eq([S.jobs.get(sw4.id).status, kit('K04').status, kit('K04').fault], ['cancelled', 'at_bo', null], 'huỷ yêu cầu: việc đổi kit huỷ, kit ở BO hết cờ lỗi');
    eq([S.incidents.get(i4.id).status, S.incidents.get(i4.id).resolution], ['resolved', 'no_recover'], 'sự cố đóng là "không cần đổi", không phải "mang về sửa"');
    eq(S.requests.get(r4.id).status, 'cancelled', 'yêu cầu ở trạng thái đã huỷ');
    ok(!(await watch('ll')).some((w) => w.kind === 'kit_fault' && w.link === `kit:${kit('K04').id}`), 'không còn dòng "kit lỗi tại BO" cho K04');
    inv('huỷ yêu cầu đổi máy');
    // K05: sau yêu cầu, Tech còn báo lỗi khác trên chính kit này → không rõ kit đã ổn: giữ việc, bỏ liên kết yêu cầu, Đối chiếu cho Logistics.
    const r5 = await support('s2', td, 'K05', 'Không ghi hình');
    const sw5 = job({ type: 'swap_faulty', kit_id: kit('K05').id });
    await go('tl', 'POST', `/api/hub/kits/${kit('K05').id}/faulty`, { reason: 'CM5 mất kết nối' });
    await go('s2', 'POST', `/api/hub/requests/${r5.id}/cancel`, { reason: 'Sale đổi ý' });
    const k5 = S.jobs.get(sw5.id);
    eq([k5.status, k5.request_id, !!kit('K05').fault], ['open', null, true], 'kit còn lỗi khác: giữ việc đổi kit (bỏ liên kết yêu cầu đã huỷ) và cờ lỗi');
    const rc = S.recon.find({ ref: `swapkeep:${sw5.id}`, status: 'open' });
    ok(rc.length === 1 && rc[0].team === 'logistics', 'đưa vào Đối chiếu của Logistics để người quyết định');
    ok(S.inbox.find({ user_id: U.ll.id, kind: 'recon' }).length >= 1, 'Logistic Lead được báo');
    inv('huỷ yêu cầu khi kit còn lỗi khác');
    // Việc đổi kit đã lên chuyến FO: Sale vẫn huỷ được yêu cầu (Sale không gỡ được việc khỏi chuyến);
    // không rõ kit đã ổn chưa → giữ việc trên chuyến, bỏ liên kết yêu cầu, Đối chiếu cho Logistics quyết định.
    const bt = await launch('s2', 'BT', ['K06']);
    await readyKit('K01');
    const r6 = await support('s2', bt, 'K06', 'Không ghi hình');
    const i6 = S.incidents.find({ kit_id: kit('K06').id })[0];
    const sw6 = job({ type: 'swap_faulty', kit_id: kit('K06').id });
    const t6 = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [sw6.id], fo_id: U.fo1.id, swap_kits: { [sw6.id]: kit('K01').id } })).task;
    const c6 = await call('s2', 'POST', `/api/hub/requests/${r6.id}/cancel`, { reason: 'Sale đổi ý' });
    eq([c6.status, S.requests.get(r6.id).status], [200, 'cancelled'], 'việc đổi kit đang trên chuyến FO → Sale vẫn huỷ được yêu cầu');
    const j6 = S.jobs.get(sw6.id);
    eq([['open', 'doing'].includes(j6.status), j6.task_id, j6.request_id, !!kit('K06').fault], [true, t6.id, null, true], 'giữ việc đổi kit trên chuyến (bỏ liên kết yêu cầu đã huỷ) và cờ lỗi');
    const rc6 = S.recon.find({ ref: `swapkeep:${sw6.id}`, status: 'open' });
    ok(rc6.length === 1 && rc6[0].team === 'logistics' && rc6[0].source === 'swap', 'đưa vào Đối chiếu của Logistics');
    ok(!(c6.body.message || '').includes('Gỡ việc khỏi chuyến'), 'Sale không nhận lời nhắn bảo gỡ việc khỏi chuyến');
    inv('huỷ yêu cầu khi việc đổi kit trên chuyến');
    // FO vẫn đi đổi kit như đã xếp: kit thay ở BO, kit lỗi về kho, sự cố đóng, kho khớp.
    await go('fo1', 'POST', `/api/tasks/${t6.id}/accept`);
    await go('fo1', 'POST', `/api/tasks/${t6.id}/start`);
    for (const s6 of S.stops.find({ task_id: t6.id }, { order: 'seq' })) {
      h.clock.add(15 * MIN);
      await go('fo1', 'POST', `/api/stops/${s6.id}/proof`, { photos: s6.is_return ? [] : [JPEG], cards_out: s6.exp_cards_out, cards_in: s6.exp_cards_in, dev_out: s6.exp_dev_out, dev_in: s6.exp_dev_in, lat: s6.lat, lon: s6.lon });
      if (S.stops.get(s6.id).bo_status !== 'pending') continue;
      const { token } = await go('l1', 'POST', `/api/stops/${s6.id}/bo-link`);
      const bo = boDevice(h);
      await bo.call('POST', '/api/bo-link/view', { token });
      await bo.call('POST', '/api/bo-link/confirm', { token, photos: [JPEG], cards_recv: s6.exp_cards_out, cards_given: s6.exp_cards_in, dev_recv: s6.exp_dev_out, dev_given: s6.exp_dev_in });
    }
    eq([S.jobs.get(sw6.id).status, kit('K01').status, kit('K01').site_id, kit('K06').status], ['done', 'at_bo', bt.id, 'recovering'], 'FO đổi kit xong: kit thay ở BO, kit lỗi đang mang về');
    eq(S.incidents.get(i6.id).status, 'resolved', 'sự cố của kit đóng khi đổi kit xong');
    inv('FO đổi kit sau khi yêu cầu đã huỷ');
  });

  await group('Bắt đầu hoặc nhận việc sự cố là Tech nhận sự cố (đồng hồ "Tech nhận sau" đúng)', async () => {
    const { h, S, U, go, inv, kit, launch, report, watch } = await world(kind);
    const q3 = await launch('s1', 'Q3', ['K01']);
    h.clock.add(5 * MIN);
    const i1 = await report('s1', q3, 'K01', 'Không lên nguồn');
    await go('tl', 'POST', `/api/hub/jobs/${i1.job.id}/assign`, { user_id: U.t1.id });
    h.clock.add(5 * MIN);
    const tStart = h.clock.now();
    await go('t1', 'POST', `/api/hub/jobs/${i1.job.id}/start`);
    eq([S.incidents.get(i1.id).status, S.incidents.get(i1.id).ack_at], ['ack', tStart], 'bấm "Bắt đầu" việc sự cố → sự cố "Tech đang xử lý", giờ nhận là lúc bắt đầu');
    ok(S.inbox.count({ user_id: U.s1.id, ref: `inc_ack:${i1.id}` }) === 1, 'người báo được báo Tech đang xử lý');
    ok(S.hub_log.count({ entity: 'incident', entity_id: i1.id, action: 'ack' }) === 1, 'nhật ký sự cố ghi lúc nhận');
    const i2 = await report('s1', q3, 'K01', 'Quá nhiệt', 'Máy nóng');
    // Để chung khi team bật tự giao thì hệ thống giao ngay cho người khác trong ca; Tech Lead tắt tự giao để việc chờ người tự nhận.
    await go('tl', 'PUT', '/api/hub/config', { autoAssign: false });
    await go('tl', 'POST', `/api/hub/jobs/${i2.job.id}/assign`, { user_id: null });
    h.clock.add(3 * MIN);
    const tClaim = h.clock.now();
    await go('t2', 'POST', `/api/hub/jobs/${i2.job.id}/claim`);
    eq([S.incidents.get(i2.id).status, S.incidents.get(i2.id).ack_at], ['ack', tClaim], 'bấm "Nhận việc" sự cố → sự cố được nhận');
    h.clock.add(75 * MIN);
    ok(!(await watch('tl')).some((w) => w.kind === 'incident_unacked'), 'Tech Lead không thấy "chưa có Tech nhận" cho sự cố đã bắt đầu / đã nhận');
    h.clock.add(120 * MIN);
    await go('t1', 'POST', `/api/hub/incidents/${i1.id}/resolve`, { resolution: 'no_recover', note: 'Cắm lại nguồn' });
    eq(S.incidents.get(i1.id).ack_at, tStart, 'xử lý xong không ghi đè giờ nhận');
    const stt = await go('tl', 'GET', '/api/hub/incidents/stats');
    eq(stt.avg_ack_min, Math.round(((tStart - i1.created_at) + (tClaim - i2.created_at)) / 2 / MIN), '"Tech nhận sau" tính theo lúc bắt đầu / nhận việc');
    ok(kit('K01'), 'kit còn');
    inv('bắt đầu / nhận việc sự cố');
  });

  await group('Sự cố từ yêu cầu đổi máy: không báo "chưa có Tech nhận", không thổi phồng thời gian nhận', async () => {
    const { h, S, go, inv, job, kit, launch, readyKit, support, watch, doJob } = await world(kind);
    const q3 = await launch('s1', 'Q3', ['K01']);
    await support('s1', q3, 'K01', 'Không ghi hình');
    const inc = S.incidents.find({ kit_id: kit('K01').id })[0];
    h.clock.add(61 * MIN);
    for (const who of ['tl', 'll', 'sh']) ok(!(await watch(who)).some((w) => w.link === `incident:${inc.id}` && w.kind === 'incident_unacked'), `${who}: không có dòng "chưa có Tech nhận" cho sự cố chỉ chờ Logistics đổi kit`);
    h.clock.add(24 * HOUR);
    const old = (await watch('ll')).filter((w) => w.link === `incident:${inc.id}`);
    ok(old.length === 1 && old[0].kind === 'incident_old' && old[0].team === 'logistics', `sự cố mở lâu chờ đổi kit thuộc team Logistics — ${JSON.stringify(old)}`);
    await readyKit('K02');
    await doJob(job({ type: 'swap_faulty', kit_id: kit('K01').id }), { new_kit_id: kit('K02').id });
    const i2 = S.incidents.get(inc.id);
    eq([i2.status, i2.resolution, i2.ack_at], ['resolved', 'swap', null], 'đổi kit xong: sự cố đóng, không ghi giờ đổi kit là giờ Tech nhận');
    eq((await go('tl', 'GET', '/api/hub/incidents/stats')).avg_ack_min, null, '"Tech nhận sau" không tính sự cố Tech không nhận');
    inv('đổi kit xong cho sự cố từ yêu cầu');
  });

  await group('Chỉ người giữ việc hoặc Tech Lead nhận sự cố; nhận sự cố chưa ai giữ thì nhận luôn việc', async () => {
    const { S, U, go, call, inv, launch, report } = await world(kind);
    const q3 = await launch('s1', 'Q3', ['K01']);
    const i1 = await report('s1', q3, 'K01', 'Không lên nguồn');
    await go('tl', 'POST', `/api/hub/jobs/${i1.job.id}/assign`, { user_id: U.t1.id });
    const r = await call('t2', 'POST', `/api/hub/incidents/${i1.id}/ack`);
    ok(r.status === 409 && String(r.body.message).includes('Tech Một'), `Tech khác bấm nhận → từ chối, nêu người đang giữ — ${r.status} ${r.body.message}`);
    eq(S.incidents.get(i1.id).status, 'open', 'sự cố vẫn chờ nhận');
    ok(!S.inbox.count({ user_id: U.s1.id, ref: `inc_ack:${i1.id}` }), 'người báo không nhận thông báo sai người');
    const d2 = await go('t2', 'GET', `/api/hub/incidents/${i1.id}`);
    eq([d2.can_ack, d2.can_handle], [false, false], 'Tech khác không thấy nút nhận / báo đã xử lý');
    const d1 = await go('t1', 'GET', `/api/hub/incidents/${i1.id}`);
    eq([d1.can_ack, d1.can_handle], [true, true], 'người giữ việc thấy nút nhận / báo đã xử lý');
    await go('t1', 'POST', `/api/hub/incidents/${i1.id}/ack`);
    const j1 = S.jobs.get(i1.job.id);
    eq([j1.status, j1.assignee_id, S.incidents.get(i1.id).status], ['doing', U.t1.id, 'ack'], 'người giữ nhận: việc đang làm, sự cố đang xử lý');
    ok(S.inbox.find({ user_id: U.s1.id, ref: `inc_ack:${i1.id}` }).some((m) => m.text.includes('Tech Một')), 'người báo được báo đúng người đang xử lý');
    // Sự cố chưa ai giữ: Tech nhận thì nhận luôn việc, sau đó báo xử lý được.
    const i2 = await report('s1', q3, 'K01', 'Quá nhiệt', 'Máy nóng');
    // Để chung khi team bật tự giao thì hệ thống giao ngay cho người khác trong ca; Tech Lead tắt tự giao để việc chờ người tự nhận.
    await go('tl', 'PUT', '/api/hub/config', { autoAssign: false });
    await go('tl', 'POST', `/api/hub/jobs/${i2.job.id}/assign`, { user_id: null });
    await go('t2', 'POST', `/api/hub/incidents/${i2.id}/ack`);
    eq([S.jobs.get(i2.job.id).assignee_id, S.jobs.get(i2.job.id).status], [U.t2.id, 'doing'], 'nhận sự cố chưa ai giữ → nhận luôn việc');
    eq(await (async () => (await call('t2', 'POST', `/api/hub/incidents/${i2.id}/resolve`, { resolution: 'no_recover', note: 'Cho máy nghỉ' })).status)(), 200, 'người vừa nhận báo xử lý được');
    // Tech Lead nhận giúp sự cố đang do người khác giữ: việc vẫn của người giữ, thông báo nêu người giữ.
    const i3 = await report('s1', q3, 'K01', 'Mất tiếng', 'Không có tiếng');
    await go('tl', 'POST', `/api/hub/jobs/${i3.job.id}/assign`, { user_id: U.t1.id });
    await go('tl', 'POST', `/api/hub/incidents/${i3.id}/ack`);
    eq(S.jobs.get(i3.job.id).assignee_id, U.t1.id, 'Tech Lead nhận: việc vẫn do người giữ làm');
    const m3 = S.inbox.find({ user_id: U.s1.id, ref: `inc_ack:${i3.id}` });
    ok(m3.length === 1 && m3[0].text.includes('Tech Một') && !m3[0].text.includes('Trưởng Tech'), 'thông báo nêu người đang giữ việc');
    inv('nhận sự cố theo người giữ việc');
  });

  await group('Yêu cầu đổi máy trùng sự cố đang mở (cùng BO, kit, lỗi) thì gộp vào sự cố cũ', async () => {
    const { S, go, inv, job, kit, launch, readyKit, report, support, doJob } = await world(kind);
    const q3 = await launch('s1', 'Q3', ['K01']);
    const i1 = await report('s1', q3, 'K01', 'Không lên nguồn', 'Máy không lên nguồn');
    await support('s1', q3, 'K01', 'Không lên nguồn', 'Xin đổi máy');
    const open = S.incidents.find({ kit_id: kit('K01').id, status: ['open', 'ack'] });
    eq(open.map((i) => i.id), [i1.id], 'chỉ một sự cố đang mở cho cùng kit và lỗi');
    eq(job({ type: 'swap_faulty', kit_id: kit('K01').id }).incident_id, i1.id, 'việc đổi kit gắn với sự cố cũ');
    ok(S.hub_log.count({ entity: 'incident', entity_id: i1.id, action: 'dup' }) === 1, 'nhật ký sự cố cũ ghi lần báo lại');
    eq((await go('tl', 'GET', '/api/hub/incidents/stats')).total, 1, 'một lỗi thật chỉ đếm một lần');
    inv('gộp yêu cầu đổi máy vào sự cố');
    await readyKit('K02');
    await doJob(job({ type: 'swap_faulty', kit_id: kit('K01').id }), { new_kit_id: kit('K02').id });
    ok(['open', 'ack'].includes(S.incidents.get(i1.id).status), 'đổi kit xong nhưng Tech còn việc xử lý → sự cố chờ Tech kết luận');
    inv('đổi kit xong khi Tech còn việc');
  });

  await group('Đổi QR theo từng lần đổi kit (đổi qua lại cùng hai kit vẫn có việc đổi QR mới)', async () => {
    const { S, go, inv, kit, launch, readyKit, doJob } = await world(kind);
    const q1 = await launch('s1', 'Q1', ['K05']);
    await readyKit('K06');
    async function swap(oldC, newC) {
      await go('tl', 'POST', `/api/hub/kits/${kit(oldC).id}/faulty`, { reason: 'Không lên nguồn' });
      await doJob(S.jobs.find({ type: 'swap_faulty', kit_id: kit(oldC).id, status: ['open', 'doing'] })[0], { new_kit_id: kit(newC).id });
      await doJob(S.jobs.find({ type: 'repair', kit_id: kit(oldC).id, status: ['open', 'doing'] })[0], { note: 'Sửa xong' });
      await doJob(S.jobs.find({ type: 'receive_back', kit_id: kit(oldC).id, status: ['open', 'doing'] })[0]);
      const n = S.jobs.count({ type: 'qr_change', site_id: q1.id });
      for (const j of S.jobs.find({ type: 'qr_change', site_id: q1.id, status: ['open', 'doing'] })) await doJob(j, { note: 'Đã đổi QR' });
      return n;
    }
    const n = [await swap('K05', 'K06'), await swap('K06', 'K05'), await swap('K05', 'K06')];
    eq(n, [1, 2, 3], 'mỗi lần đổi kit làm đổi CM5 tại BO đều có một việc đổi QR');
    inv('đổi QR theo lần đổi kit');
  });

  await group('Top 10 gộp theo nhãn lỗi (mọi dòng kit), tăng vọt tính trên tổng; gắn kit cho sự cố chưa có kit mà không đếm hai lần', async () => {
    const { S, go, st, inv, job, kit, launch, report } = await world(kind);
    const q3 = await launch('s1', 'Q3', ['K01']), td = await launch('s1', 'TD', ['K02']), bt = await launch('s2', 'BT', ['K03']), gv = await launch('s2', 'GV', ['K04']);
    const L = 'Không lên nguồn';
    await report('s1', q3, 'K01', L); await report('s1', td, 'K02', L); await report('s2', bt, null, L); await report('s2', gv, null, L);
    let stt = await go('tl', 'GET', '/api/hub/incidents/stats');
    const rows = stt.top.filter((x) => x.label === L);
    eq(rows.map((x) => [x.count, x.spike]), [[4, true]], 'một dòng cho nhãn lỗi: 4 lần, tăng vọt');
    eq(rows[0].kinds.map((k) => `${k.kind || 'none'}:${k.count}`).sort(), ['multicam:2', 'none:2'], 'chia nhỏ theo dòng kit bên trong dòng');
    ok((await go('tl', 'GET', '/api/hub/overview')).incidents_spikes.some((x) => x.label === L), 'Tổng quan: lỗi tăng vọt hiện ra');
    // Gắn kit cho sự cố chưa có kit.
    const kb = S.incidents.find({ site_id: bt.id, kit_id: null })[0];
    eq(await st('s2', 'POST', `/api/hub/incidents/${kb.id}/kit`, { kit_id: kit('K03').id }), 403, 'Sale không gắn kit cho sự cố');
    eq(await st('tl', 'POST', `/api/hub/incidents/${kb.id}/kit`, { kit_id: kit('K01').id }), 409, 'kit không ở BO của sự cố → từ chối');
    const r = await go('tl', 'POST', `/api/hub/incidents/${kb.id}/kit`, { kit_id: kit('K03').id });
    ok(!r.merged && r.incident.kit && r.incident.kit.id === kit('K03').id, 'gắn kit vào sự cố');
    eq(job({ type: 'incident', incident_id: kb.id }).kit_id, kit('K03').id, 'việc xử lý sự cố cũng gắn kit');
    stt = await go('tl', 'GET', '/api/hub/incidents/stats');
    eq([stt.total, stt.top.find((x) => x.label === L).count], [4, 4], 'gắn kit không làm đếm hai lần');
    await go('tl', 'POST', `/api/hub/incidents/${kb.id}/resolve`, { resolution: 'swap', note: 'Kit hỏng nguồn, cần đổi' });
    ok(job({ type: 'swap_faulty', kit_id: kit('K03').id }), 'sau khi gắn kit, chọn đổi máy được (có việc đổi kit)');
    inv('gắn kit cho sự cố');
    // Gắn kit trùng với sự cố đang mở cùng kit và lỗi → gộp, không đếm hai lần.
    const kg = S.incidents.find({ site_id: gv.id, kit_id: null })[0];
    const kgJob = job({ type: 'incident', incident_id: kg.id });
    const i4 = await report('s2', gv, 'K04', L, 'Máy GV không lên nguồn');
    eq((await go('tl', 'GET', '/api/hub/incidents/stats')).total, 5, 'trước khi gộp: 5 lần báo');
    const m = await go('tl', 'POST', `/api/hub/incidents/${kg.id}/kit`, { kit_id: kit('K04').id });
    ok(m.merged && m.incident.id === i4.id, 'gắn kit trùng sự cố đang mở → gộp vào sự cố đó');
    eq([S.incidents.get(kg.id).status, S.jobs.get(kgJob.id).status], ['cancelled', 'cancelled'], 'sự cố gộp và việc của nó được huỷ');
    eq((await go('tl', 'GET', '/api/hub/incidents/stats')).total, 4, 'sau khi gộp: một lỗi thật chỉ đếm một lần');
    inv('gộp khi gắn kit');
  });

  await group('"Không phải sự cố" không vào Top 10 và lỗi tăng vọt; đếm riêng', async () => {
    const { S, go, inv, launch, report } = await world(kind);
    const q3 = await launch('s1', 'Q3', ['K01']), td = await launch('s1', 'TD', ['K02']), bt = await launch('s2', 'BT', ['K03']);
    for (const [s, k, who] of [[q3, 'K01', 's1'], [td, 'K02', 's1'], [bt, 'K03', 's2']]) {
      const i = await report(who, s, k, 'BO tắt máy', 'BO tắt máy qua đêm');
      await go('tl', 'POST', `/api/hub/incidents/${i.id}/resolve`, { resolution: 'invalid', note: '' });
    }
    const stt = await go('tl', 'GET', '/api/hub/incidents/stats');
    ok(!stt.top.some((x) => x.label === 'BO tắt máy') && !stt.all.some((x) => x.spike), 'không vào Top 10, không thành lỗi tăng vọt');
    eq([stt.invalid, stt.total], [3, 3], 'đếm riêng 3 lần "không phải sự cố" (tổng số lần báo vẫn giữ)');
    ok(!stt.sites.length, '"BO có nhiều sự cố" không tính lần báo không phải sự cố');
    const ov = await go('sh', 'GET', '/api/hub/overview');
    eq([ov.kpi.incidents.invalid, ov.incidents_spikes.length, ov.sale.totals.incidents], [3, 0, 3], 'Tổng quan: số riêng, không tăng vọt; bảng Kinh doanh vẫn đếm lần báo');
    eq((await go('tl', 'GET', '/api/hub/incidents', null, { status: 'counted' })).incidents.length, 0, 'lọc "tính vào thống kê" bỏ qua "không phải sự cố"');
    ok(S.incidents.count({ resolution: 'invalid' }) === 3, 'dữ liệu gốc giữ nguyên');
    inv('không phải sự cố');
  });

  await group('Ngưỡng theo dõi và thời gian người báo tự huỷ đọc từ Cài đặt (đề xuất, team chốt)', async () => {
    const { h, S, U, go, call, st, inv, launch, report, watch } = await world(kind);
    const keys = { incidentAckMin: 'Tech', incidentOldH: 'Tech', incidentCancelMin: 'Tech', uploadLateH: 'Tech', reqLateDays: 'Logistics', cardsStaleDays: 'Logistics', cardsReturnedH: 'Logistics' };
    const cfg = await go('tl', 'GET', '/api/hub/config');
    for (const [k, o] of Object.entries(keys)) ok(cfg.defaults[k] !== undefined && cfg.owners[k] === o && cfg.labels[k], `mục cài đặt ${k}: có mặc định, ${o} chốt, có tên`);
    eq([cfg.defaults.incidentAckMin, cfg.defaults.incidentOldH, cfg.defaults.incidentCancelMin, cfg.defaults.uploadLateH, cfg.defaults.reqLateDays, cfg.defaults.cardsStaleDays, cfg.defaults.cardsReturnedH], [60, 24, 30, 24, 2, 3, 12], 'mặc định giữ đúng con số đang dùng');
    eq(await st('ll', 'PUT', '/api/hub/config', { incidentAckMin: 30 }), 403, 'Logistic Lead không sửa mục Tech chốt');
    eq(await st('tl', 'PUT', '/api/hub/config', { incidentAckMin: 1 }), 400, 'giá trị ngoài khoảng → từ chối');
    eq(await st('tl', 'PUT', '/api/hub/config', { reqLateDays: 3 }), 403, 'Tech Lead không sửa mục Logistics chốt');
    const q3 = await launch('s1', 'Q3', ['K01']);
    // Sự cố chưa có Tech nhận.
    const i1 = await report('s1', q3, 'K01', 'Không lên nguồn');
    h.clock.add(31 * MIN);
    ok(!(await watch('tl')).some((w) => w.link === `incident:${i1.id}`), 'mặc định 60 phút: chưa báo sau 31 phút');
    await go('tl', 'PUT', '/api/hub/config', { incidentAckMin: 30 });
    ok((await watch('tl')).some((w) => w.link === `incident:${i1.id}` && w.kind === 'incident_unacked'), 'Tech Lead đổi còn 30 phút → báo');
    // Người báo tự huỷ.
    const i2 = await report('s1', q3, 'K01', 'Quá nhiệt', 'Máy nóng');
    h.clock.add(20 * MIN);
    await go('tl', 'PUT', '/api/hub/config', { incidentCancelMin: 10 });
    eq((await go('s1', 'GET', `/api/hub/incidents/${i2.id}`)).can_cancel, false, 'quá thời gian tự huỷ → không hiện nút huỷ');
    const c = await call('s1', 'POST', `/api/hub/incidents/${i2.id}/cancel`, { reason: 'Báo nhầm' });
    ok(c.status === 403 && String(c.body.message).includes('10 phút'), `quá 10 phút → người báo không tự huỷ — ${c.body.message}`);
    await go('tl', 'PUT', '/api/hub/config', { incidentCancelMin: 30 });
    eq((await go('s1', 'GET', `/api/hub/incidents/${i2.id}`)).can_cancel, true, 'trong thời gian tự huỷ → có nút huỷ');
    eq(await st('s1', 'POST', `/api/hub/incidents/${i2.id}/cancel`, { reason: 'Báo nhầm' }), 200, 'trong 30 phút → người báo tự huỷ được');
    // Việc quá hạn: dùng chung mục "Báo Lead khi việc quá hạn quá (phút)".
    const mj = (await go('ll', 'POST', '/api/hub/jobs', { title: 'Sắp xếp kệ phụ kiện', assignee_id: U.l1.id })).job;
    S.jobs.update(mj.id, { due_at: h.clock.now() - 70 * MIN });
    ok(!(await watch('ll')).some((w) => w.link === `job:${mj.id}`), 'mặc định 120 phút: quá hạn 70 phút chưa vào Điểm nghẽn');
    await go('ll', 'PUT', '/api/hub/config', { leadOverdueMin: 60 });
    ok((await watch('ll')).some((w) => w.link === `job:${mj.id}` && w.kind === 'job_overdue'), 'Lead đổi còn 60 phút → việc quá hạn vào Điểm nghẽn');
    // Yêu cầu launch sắp tới mà kit chưa sẵn sàng.
    const req = (await go('s2', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-08', outlet: { name: 'BO Thủ Đức', code: 'TD', lat: 10.85, lon: 106.75, contact: 'Anh Nam', phone: '0903333444', address: 'Thủ Đức' } })).request;
    ok(!(await watch('ll')).some((w) => w.link === `request:${req.id}`), 'mặc định 2 ngày: launch sau 3 ngày chưa báo');
    await go('ll', 'PUT', '/api/hub/config', { reqLateDays: 3 });
    ok((await watch('ll')).some((w) => w.link === `request:${req.id}` && w.kind === 'request_late'), 'Logistics đổi còn 3 ngày → báo');
    // Thẻ: nằm ở BO lâu, Tech chưa nhập, đã thu về chưa gửi Tech.
    const sd = (c) => S.cards.find({ code: c }, { limit: 1 })[0];
    const now = h.clock.now();
    // BO đổi thẻ hằng ngày: thẻ được nằm ở BO tới lịch đổi kế tiếp + 1 ngày (2 ngày), nên đặt 2,5 ngày để vượt cả ngưỡng mới (1 ngày) lẫn lịch đổi, mà vẫn dưới mặc định 3 ngày.
    S.cards.update(sd('SD28').id, { status: 'at_bo', site_id: q3.id, bo_in: now - 60 * HOUR, since: now - 60 * HOUR });
    S.cards.update(sd('SD29').id, { status: 'at_tech', since: now - 5 * HOUR });
    S.cards.update(sd('SD30').id, { status: 'returned', since: now - 5 * HOUR });
    let kinds = (await watch('ad')).map((w) => w.kind);
    ok(!kinds.includes('cards_stale') && !kinds.includes('upload_late') && !kinds.includes('cards_returned'), 'mặc định: thẻ chưa quá ngưỡng thì chưa báo');
    await go('ll', 'PUT', '/api/hub/config', { cardsStaleDays: 1, cardsReturnedH: 4 });
    await go('tl', 'PUT', '/api/hub/config', { uploadLateH: 4 });
    kinds = (await watch('ad')).map((w) => w.kind);
    ok(['cards_stale', 'upload_late', 'cards_returned'].every((k) => kinds.includes(k)), `đổi ngưỡng → thẻ quá ngưỡng được báo — ${kinds.join(',')}`);
    // Sự cố mở lâu.
    await go('tl', 'PUT', '/api/hub/config', { incidentAckMin: 1440, incidentOldH: 1 });
    h.clock.add(15 * MIN); // sự cố i1 đã mở hơn 1 giờ
    ok((await watch('tl')).some((w) => w.link === `incident:${i1.id}` && w.kind === 'incident_old'), 'Tech Lead đổi "sự cố mở quá" còn 1 giờ → báo');
    inv('ngưỡng từ Cài đặt');
  });

  await group('Ô "Đối chiếu đang mở" trên Tổng quan đếm đúng phần người xem thấy trong danh sách', async () => {
    const { h, go } = await world(kind);
    const H = h.core.hub;
    H.recon('test', 'logistics', 'high', 'kit', 't:log:1', 'Lệch thử của Logistics');
    H.recon('test', 'logistics', 'mid', 'kit', 't:log:2', 'Lệch thử thứ hai của Logistics');
    H.recon('test', 'tech', 'mid', 'kit', 't:tech:1', 'Lệch thử của Tech');
    for (const who of ['tl', 'll', 'sh', 'ad']) {
      const ov = await go(who, 'GET', '/api/hub/overview');
      const rl = await go(who, 'GET', '/api/hub/recon');
      eq([ov.kpi.recon.open, ov.kpi.recon.high], [rl.items.length, rl.items.filter((r) => r.level === 'high').length], `${who}: ô Đối chiếu khớp danh sách mở ra`);
    }
    eq((await go('ad', 'GET', '/api/hub/overview')).kpi.recon.open, 3, 'Quản trị thấy mọi team');
  });

  await group('Danh sách sự cố lọc theo kỳ, dòng kit và "tính vào thống kê": khớp số Top 10 và "BO có nhiều sự cố"', async () => {
    const { h, S, go, inv, launch, report } = await world(kind);
    const q3 = await launch('s1', 'Q3', ['K01']), td = await launch('s1', 'TD', ['K02']);
    const L = 'Không lên nguồn';
    const old = await report('s1', td, 'K02', L, 'Tuần trước');
    await go('tl', 'POST', `/api/hub/incidents/${old.id}/resolve`, { resolution: 'no_recover', note: 'Đã xử lý tuần trước' });
    S.incidents.update(old.id, { created_at: h.clock.now() - 7 * DAY });
    await report('s1', q3, 'K01', L);
    await report('s1', td, null, L, 'Không rõ kit nào');
    const bad = await report('s1', q3, 'K01', 'Quá nhiệt', 'Máy nóng');
    await go('tl', 'POST', `/api/hub/incidents/${bad.id}/resolve`, { resolution: 'invalid', note: '' });
    const stt = await go('tl', 'GET', '/api/hub/incidents/stats');
    const row = stt.top.find((x) => x.label === L);
    const list = async (q) => (await go('tl', 'GET', '/api/hub/incidents', null, { status: 'counted', from: stt.from, to: stt.to, ...q })).incidents;
    eq((await list({ label: L })).length, row.count, 'dòng Top 10 mở ra danh sách đúng số');
    eq((await list({ label: L, kind: 'multicam' })).length, 1, 'lọc theo dòng kit');
    eq((await list({ label: L, kind: 'none' })).length, 1, 'lọc sự cố chưa gắn kit');
    for (const x of stt.sites) eq((await list({ site: x.site.id })).length, x.count, `"BO có nhiều sự cố" ${x.site.name}: danh sách đúng số`);
    eq((await list({})).length, stt.total - stt.invalid, 'tính vào thống kê = tổng lần báo trừ "không phải sự cố"');
    eq((await go('tl', 'GET', '/api/hub/incidents', null, { status: 'all', from: stt.from, to: stt.to })).incidents.length, stt.total, 'mọi trạng thái trong kỳ (trừ đã huỷ không có)');
    eq((await go('s1', 'GET', '/api/hub/incidents', null, { status: 'counted', from: stt.from, to: stt.to, kind: 'multicam' })).incidents.length, 1, 'Sale lọc được trong phạm vi BO của mình');
    eq((await go('tl', 'GET', '/api/hub/incidents', null, { status: 'all', from: 'không-phải-ngày' })).incidents.length, 4, 'ngày không hợp lệ thì bỏ qua bộ lọc');
    inv('lọc danh sách sự cố');
  });

  await group('Thu hồi kit dư phụ kiện so với sổ: cộng vào kho và đưa vào Đối chiếu cho Logistics', async () => {
    const { S, go, inv, kit, launch, doJob } = await world(kind);
    const td = await launch('s2', 'TD', ['K02']);
    await go('s2', 'POST', `/api/hub/outlets/${td.id}/end`, { date: '2026-10-05', note: 'Đóng' });
    const rec = S.jobs.find({ type: 'recover', site_id: td.id, status: ['open', 'doing'] })[0];
    const before = (await go('ll', 'GET', '/api/hub/acc')).acc.find((a) => a.id === 'hub_sac');
    await doJob(rec, { acc_by_kit: { [kit('K02').id]: { hub_sac: 3, day_gan: 1 } } });
    const after = (await go('ll', 'GET', '/api/hub/acc')).acc.find((a) => a.id === 'hub_sac');
    eq(after.total - before.total, 2, 'tổng hub sạc tăng đúng số dư (sổ kho chính xác)');
    const rc = S.recon.find({ source: 'acc_recover', status: 'open' }).filter((r) => String(r.ref).startsWith(`accextra:${kit('K02').id}:`));
    ok(rc.length === 1 && rc[0].team === 'logistics' && rc[0].text.includes('dư'), 'dư phụ kiện → một dòng Đối chiếu cho Logistics');
    inv('thu hồi dư phụ kiện');
  });

  await group('Nhập dữ liệu: thông báo tên BO không lặp chữ "BO"', async () => {
    const { go } = await world(kind);
    await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-07', outlet: { name: 'BO Quận 3', code: 'Q3', lat: 10.7835, lon: 106.6869, contact: 'Chị Hoa', phone: '0901111222', address: 'Quận 3' } });
    const buf = buildXlsx([
      { name: 'Kit', rows: [['Mã kit', 'Loại kit', 'Trạng thái', 'BO', 'Multicam'], ['K10', 'Multicam KIT', 'Đang sửa', 'BO Quận 3', 'MC10']] },
      { name: 'Dung lượng', rows: [['Mã thẻ', 'BO', 'Ngày quay', 'GB'], ['SD90', 'BO Hậu Giang', { date: '2026-10-01' }, 33.8]] },
      { name: 'Sự cố', rows: [['Ngày', 'BO', 'Mã kit', 'Nhãn lỗi', 'Trạng thái', 'Cách xử lý'], [{ date: '2026-09-20' }, 'BO Hậu Giang', '', 'Không lên nguồn', '', '']] },
    ]);
    const parsed = await go('ad', 'POST', '/api/hub/import/parse', { data: buf.toString('base64'), name: 'du-lieu.xlsx' });
    const plan = parsed.sheets.map((s) => ({ sheet: s.index, target: s.guess.target, header_row: s.header_row, mapping: s.guess.mapping }));
    eq(plan.map((p) => p.target), ['kits', 'records', 'incidents'], 'đoán đúng loại dữ liệu');
    const dry = await go('ad', 'POST', '/api/hub/import/run', { token: parsed.token, plan, commit: false });
    const texts = [...dry.recon_sample.map((x) => x.text), ...dry.report.flatMap((r) => r.errors.map((e) => e.msg))];
    ok(texts.some((t) => t.includes('"BO Quận 3"')) && texts.filter((t) => t.includes('"BO Hậu Giang"')).length === 2, `thông báo nêu đúng tên BO — ${JSON.stringify(texts)}`);
    ok(!texts.some((t) => /BO "BO /.test(t)), 'không còn "BO "BO ..."');
  });
}

await suite('memory');
await suite('sqlite');
summary('Sự cố, Điểm nghẽn, Tổng quan');
