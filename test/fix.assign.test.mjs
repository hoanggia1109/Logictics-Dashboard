// fix.assign.test.mjs — bộ giao việc: hết ca / không có ca thì việc chưa bắt đầu trả về cho người trong ca, việc tồn chia đều khi vào ca
// và san lại khi đồng đội vào ca, hạn riêng của người nhận sau, người trả việc chỉ bị bỏ qua trong ngày, khoá / đổi vai trò thì trả việc,
// chỉ giao cho thành viên của team, đưa việc đang làm về hàng chung, tải của việc nhập thẻ, đổi thẻ trễ đóng luôn lượt hôm nay.
// Sau mỗi bước chạy bộ kiểm bất biến. Mỗi nhóm chạy 2 lần: kho bộ nhớ và kho SQLite.
import { mk, ok, eq, group, summary } from './harness.mjs';
import { checkInvariants } from './invariants.mjs';

const MIN = 60000;
const VN = (date, hm) => Date.parse(`${date}T${hm}:00+07:00`);

async function world(kind) {
  const h = mk(kind);
  h.clock.set(VN('2026-10-05', '07:00')); // Thứ Hai, W41
  const people = [['ad', 'admin', 'Quản trị'], ['tl', 'tech_lead', 'Trưởng Tech'], ['t1', 'tech', 'Tech Một'], ['t2', 'tech', 'Tech Hai'], ['ll', 'lead', 'Trưởng Logistics'],
    ['l1', 'logistic', 'Log Một'], ['l2', 'logistic', 'Log Hai'], ['fo1', 'fo', 'FO Một'], ['sh', 'sale_head', 'Trưởng Sale'], ['s1', 'sale', 'Sale Một']];
  const U = {};
  for (const [u, role, name] of people) U[u] = await h.user(u, role, { name });
  const go = async (who, method, path, body, query) => {
    const r = await h.call(who, method, path, body, query);
    if (r.status !== 200) throw new Error(`${who} ${method} ${path} → ${r.status} ${r.body.error}: ${r.body.message}`);
    return r.body;
  };
  const call = (who, method, path, body, query) => h.call(who, method, path, body, query);
  const at = (date, hm) => h.clock.set(VN(date, hm));
  const seen = (...us) => { for (const u of us) h.core.hub.K.hooks.onSeen(h.byName(u), h.clock.now()); };
  const tick = () => { h.clock.add(61000); h.core.tick(); };
  const inv = (label) => { const v = checkInvariants(h.store); ok(!v.length, `bất biến sau "${label}": ${v.join(' | ')}`); };
  const job = (where) => h.store.jobs.find(where, { order: 'id', desc: true, limit: 1 })[0] || null;
  const jobs = (where) => h.store.jobs.find(where, { order: 'id' });
  const kit = (code) => h.store.kits.find({ code }, { limit: 1 })[0];
  const card = (code) => h.store.cards.find({ code }, { limit: 1 })[0];
  const uname = (id) => (id ? h.store.users.get(id).username : null);
  const holder = (j) => uname(h.store.jobs.get(j.id).assignee_id);
  const roster = (who, rows) => go(who, 'PUT', '/api/hub/roster', { rows });
  /** Ca cả ngày đã duyệt (Lead xếp) cho các ngày: không có ca đã duyệt thì không vào ca, không được tự giao việc. */
  const dayShift = async (dates, users = ['l1', 'l2', 't1', 't2']) => {
    for (const [ld, team] of [['ll', ['l1', 'l2']], ['tl', ['t1', 't2']]]) {
      const rows = users.filter((u) => team.includes(u)).flatMap((u) => dates.map((date) => ({ user_id: U[u].id, date })));
      if (rows.length) await roster(ld, rows);
    }
  };
  /** Tạo n kit Multicam (mỗi kit 1 Multicam + 1 CM5) ở trạng thái đang chuẩn bị. */
  let nKit = 0;
  const kits = async (n) => {
    const codes = [];
    for (let i = 0; i < n; i++) {
      const k = ++nKit, p = String(k).padStart(2, '0');
      await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: `MC${p}` });
      await go('ll', 'POST', '/api/hub/devices', { type: 'cm5', codes: `CM${p}` });
      await go('l1', 'POST', '/api/hub/kits', { code: `K${p}`, kind: 'multicam', devices: `MC${p} CM${p}` });
      codes.push(`K${p}`);
    }
    return codes;
  };
  /** Logistics gửi kit đi kiểm → việc "Kiểm kit" của Tech. */
  const submit = async (code) => { await go('l1', 'POST', `/api/hub/kits/${kit(code).id}/submit`); return job({ type: 'check_kit', kit_id: kit(code).id }); };
  return { h, U, go, call, at, seen, tick, inv, job, jobs, kit, card, uname, holder, roster, dayShift, kits, submit };
}

/** Văn phòng + BO Q3 đang ghi hình với 1 kit, đổi thẻ mọi ngày (hoặc theo swap_days). */
async function liveBO(W, swapDays = [1, 2, 3, 4, 5, 6, 7]) {
  const { go, kit, job } = W;
  await go('ll', 'POST', '/api/sites', { name: 'Văn phòng', type: 'office', lat: 10.7769, lon: 106.7009 });
  await go('tl', 'PUT', '/api/hub/config', { checkBeforeShip: false });
  await go('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: Array.from({ length: 16 }, (_, i) => 'SD' + String(i + 1).padStart(2, '0')).join(' ') });
  const [code] = await W.kits(1);
  const req = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-05', outlet: { name: 'BO Quận 3', code: 'Q3', lat: 10.78, lon: 106.68, contact: 'C', phone: '0901111222', address: 'Q3' }, swap_days: swapDays, swap_from: '09:00', swap_to: '11:00' })).request;
  await go('l1', 'POST', `/api/hub/requests/${req.id}/assign`, { kit_ids: [kit(code).id] });
  await go('l1', 'POST', `/api/hub/kits/${kit(code).id}/submit`);
  const dl = job({ type: 'deliver', request_id: req.id });
  await go(W.uname(dl.assignee_id) || 'l1', 'POST', `/api/hub/jobs/${dl.id}/done`, { result: { doc_code: 'BB-Q3' } });
  return W.h.store.sites.find({ code: 'Q3' }, { limit: 1 })[0];
}

async function suite(kind) {
  console.log(`\n── Kho ${kind === 'sqlite' ? 'SQLite' : 'bộ nhớ'} ──`);

  await group('Hết ca: việc chưa bắt đầu trả về cho người trong ca sau thời gian chờ; việc đang làm giữ, Lead được báo', async () => {
    const W = await world(kind);
    const { h, U, go, at, seen, tick, inv, holder, roster, kits, submit } = W;
    await roster('tl', [{ user_id: U.t1.id, date: '2026-10-05', shift: 'S' }, { user_id: U.t2.id, date: '2026-10-05', shift: 'C' }]); // 07:00–15:00 và 14:00–22:00
    at('2026-10-05', '08:00'); seen('t1');
    await kits(3);
    const a = await submit('K01'), b = await submit('K02');
    eq([holder(a), holder(b)], ['t1', 't1'], 'chỉ t1 trong ca → hai việc kiểm giao cho t1');
    await go('tl', 'POST', `/api/hub/jobs/${a.id}/assign`, { user_id: U.t1.id }); // Lead giao tay
    await go('t1', 'POST', `/api/hub/jobs/${b.id}/start`);
    at('2026-10-05', '14:05'); seen('t2');
    eq([holder(a), holder(b)], ['t1', 't1'], 't2 vào ca: việc Lead giao tay và việc đang làm không bị san');
    at('2026-10-05', '15:20'); tick();
    eq(holder(a), 't1', '15:21: chưa quá 30 phút sau giờ ra ca → việc còn ở t1');
    at('2026-10-05', '15:31'); tick();
    eq(holder(a), 't2', '15:32: t1 hết ca quá 30 phút → việc chưa bắt đầu chuyển cho t2 đang trong ca');
    eq([holder(b), h.store.jobs.get(b.id).status], ['t1', 'doing'], 'việc t1 đang làm giữ nguyên');
    ok(h.store.hub_log.count({ entity: 'job', entity_id: a.id, action: 'release' }) === 1, 'có nhật ký trả việc');
    const note = h.store.inbox.find({ user_id: U.tl.id, kind: 'offshift' });
    ok(note.length === 1 && /hết ca/.test(note[0].text) && /1 việc chưa bắt đầu/.test(note[0].text) && /1 việc đang làm/.test(note[0].text), `Tech Lead được báo một lần: ${note.map((n) => n.text).join(' | ')}`);
    inv('hết ca');
    at('2026-10-05', '16:00');
    const c = await submit('K03');
    eq(holder(c), 't2', 'việc mới giao cho người trong ca');
    await go('tl', 'POST', `/api/hub/jobs/${c.id}/assign`, { user_id: U.t1.id });
    at('2026-10-05', '16:10'); tick(); tick();
    eq(holder(c), 't1', 'Lead giao tay cho người đã hết ca (sau giờ hết ca) → hệ thống không tự chuyển');
    ok(h.store.inbox.count({ user_id: U.tl.id, kind: 'offshift' }) === 1, 'không báo lặp mỗi phút');
    inv('Lead giao tay sau hết ca');
  });

  await group('Không có ca hôm sau: việc của ngày trước trả về; người trong ca hôm sau nhận', async () => {
    const W = await world(kind);
    const { h, U, go, at, seen, tick, inv, holder, roster, kits, submit } = W;
    await roster('tl', [{ user_id: U.t1.id, date: '2026-10-05', shift: 'HC' }, { user_id: U.t2.id, date: '2026-10-06', shift: 'HC' }]);
    at('2026-10-05', '09:00'); seen('t1');
    await kits(2);
    const a = await submit('K01');
    eq(holder(a), 't1', 'việc kiểm giao cho t1');
    at('2026-10-05', '18:05'); tick();
    eq(holder(a), null, 't1 hết ca 17:30 quá 30 phút → việc chưa bắt đầu về hàng chung (không ai trong ca)');
    at('2026-10-05', '18:10');
    const b = await submit('K02');
    await go('tl', 'POST', `/api/hub/jobs/${b.id}/assign`, { user_id: U.t1.id });
    at('2026-10-05', '18:20'); tick();
    eq(holder(b), 't1', 'Lead giao tay lúc t1 đã hết ca → giữ trong ngày');
    at('2026-10-06', '00:05'); tick();
    eq(holder(b), null, 'sang ngày mới t1 không có ca → việc trả về hàng chung');
    inv('không có ca hôm sau');
    at('2026-10-06', '08:35'); seen('t2');
    eq([holder(a), holder(b)], ['t2', 't2'], 't2 vào ca → nhận cả hai việc');
    inv('người trong ca hôm sau nhận');
  });

  await group('Ca chỉ ghi ngày: chưa vào ca sau giờ vào ca sớm nhất + thời gian ghi vắng thì việc trả về', async () => {
    const W = await world(kind);
    const { U, at, seen, tick, inv, holder, roster, kits, submit } = W;
    await roster('tl', [{ user_id: U.t1.id, date: '2026-10-05' }, { user_id: U.t1.id, date: '2026-10-06' }, { user_id: U.t2.id, date: '2026-10-06' }]);
    at('2026-10-05', '10:00'); seen('t1');
    await kits(1);
    const a = await submit('K01');
    eq(holder(a), 't1', 'việc kiểm giao cho t1');
    at('2026-10-06', '07:30'); seen('t2'); tick();
    eq(holder(a), 't1', '06/10 07:31: chưa tới giờ coi là vắng (ca sớm nhất 07:00 + 60 phút) → giữ');
    at('2026-10-06', '08:05'); tick();
    eq(holder(a), 't2', '06/10 08:06: t1 có ca chỉ ghi ngày mà chưa vào → việc chuyển cho t2 đang trong ca');
    inv('ca chỉ ghi ngày');
  });

  await group('Việc tồn qua đêm chia đều cho người đang và sắp vào ca, không dồn hết cho người đến trước', async () => {
    const W = await world(kind);
    const { h, U, at, seen, tick, inv, jobs, roster, kits, submit, uname } = W;
    await roster('tl', [{ user_id: U.t1.id, date: '2026-10-06', shift: 'HC' }, { user_id: U.t2.id, date: '2026-10-06', shift: 'HC' }]);
    const codes = await kits(6);
    at('2026-10-05', '21:00');
    for (const c of codes) await submit(c);
    const split = () => { const o = {}; for (const j of jobs({ type: 'check_kit', status: ['open', 'doing'] })) { const k = uname(j.assignee_id) || 'chung'; o[k] = (o[k] || 0) + 1; } return o; };
    eq(split(), { chung: 6 }, 'đêm 05/10 không ai trong ca → 6 việc chờ');
    at('2026-10-06', '08:16'); seen('t1');
    eq(split(), { t1: 3, chung: 3 }, '08:16 t1 vào ca, t2 sắp vào → t1 nhận phần chia đều 3 việc');
    tick();
    ok(!h.store.inbox.count({ user_id: U.tl.id, kind: 'pool' }), 'việc đang chờ người sắp vào ca không báo Lead là "chưa ai nhận"');
    at('2026-10-06', '08:26'); seen('t2');
    eq(split(), { t1: 3, t2: 3 }, '08:26 t2 vào ca → nhận 3 việc còn lại');
    inv('chia đều việc tồn');
  });

  await group('Đồng đội vào ca: việc hệ thống đã giao mà chưa bắt đầu được san lại; việc Lead giao tay giữ nguyên', async () => {
    const W = await world(kind);
    const { h, U, go, at, seen, inv, jobs, roster, kits, submit, uname, holder } = W;
    await roster('tl', [{ user_id: U.t1.id, date: '2026-10-06', shift: 'HC' }, { user_id: U.t2.id, date: '2026-10-06', shift: 'C' }]);
    const codes = await kits(7);
    at('2026-10-05', '21:00');
    for (const c of codes.slice(0, 6)) await submit(c);
    at('2026-10-06', '08:20'); seen('t1');
    eq(jobs({ type: 'check_kit', assignee_id: U.t1.id }).length, 6, 't2 vào ca chiều (chưa sắp vào) → t1 nhận cả 6 việc');
    const started = jobs({ type: 'check_kit', assignee_id: U.t1.id })[0];
    await go('t1', 'POST', `/api/hub/jobs/${started.id}/start`);
    at('2026-10-06', '10:00');
    const byHand = await submit(codes[6]);
    await go('tl', 'POST', `/api/hub/jobs/${byHand.id}/assign`, { user_id: U.t1.id });
    at('2026-10-06', '14:00'); seen('t2');
    const mine = (u) => jobs({ type: 'check_kit', status: ['open', 'doing'] }).filter((j) => uname(j.assignee_id) === u);
    eq([mine('t1').length, mine('t2').length], [4, 3], 't2 vào ca → 3 việc chưa bắt đầu chuyển sang t2 (tải 60 / 45 phút chuẩn)');
    eq([holder(started), holder(byHand)], ['t1', 't1'], 'việc đang làm và việc Lead giao tay không bị chuyển');
    ok(mine('t2').every((j) => h.store.hub_log.count({ entity: 'job', entity_id: j.id, action: 'auto_assign' }) === 2), 'mỗi lần chuyển có nhật ký');
    ok(h.store.inbox.count({ user_id: U.t1.id, kind: 'job' }) >= 1 && h.store.inbox.count({ user_id: U.t2.id, kind: 'job' }) === 3, 't2 được báo từng việc mới, t1 được báo việc đã chuyển');
    inv('san việc khi vào ca');
  });

  await group('Hạn riêng của người nhận sau: team vẫn tính theo hạn gốc, người nhận sau không bị tính trễ', async () => {
    const W = await world(kind);
    const { h, U, go, at, seen, tick, inv, roster, kits, submit, holder } = W;
    await roster('tl', [{ user_id: U.t1.id, date: '2026-10-05', shift: 'HC' }, { user_id: U.t1.id, date: '2026-10-06', shift: 'HC' }, { user_id: U.t2.id, date: '2026-10-06', shift: 'HC' }]);
    at('2026-10-05', '10:00'); seen('t1');
    await kits(1);
    const a = await submit('K01');
    const due = h.store.jobs.get(a.id).due_at;
    eq(due, VN('2026-10-06', '10:00'), 'hạn kiểm kit: 24 giờ từ lúc t1 nhận');
    at('2026-10-06', '08:35'); seen('t2');
    at('2026-10-06', '09:31'); tick();
    eq(holder(a), 't2', 't1 vắng → việc chuyển cho t2 lúc 09:32');
    const j = h.store.jobs.get(a.id);
    eq(j.due_at, due, 'hạn của việc (hạn team) giữ nguyên');
    ok(j.assigned_at >= VN('2026-10-06', '09:31') && j.due_mine === j.assigned_at + 24 * 60 * MIN, 'ghi lúc t2 nhận và hạn riêng = lúc nhận + 24 giờ');
    at('2026-10-06', '11:00');
    await go('t2', 'POST', `/api/hub/jobs/${a.id}/done`, { result: { pass: true } });
    const pt = await go('tl', 'GET', '/api/hub/perf', null, { period: 'week', key: '2026-W41' });
    const r2 = pt.rows.find((r) => r.user.id === U.t2.id);
    eq([r2.with_due, r2.on_time, r2.sla_pct], [1, 1, 100], 't2 làm xong trong hạn riêng → đúng hạn cá nhân');
    eq(pt.summary.sla_pct, 0, 'tỉ lệ đúng hạn của team vẫn theo hạn gốc (trễ)');
    const ov = await go('tl', 'GET', '/api/hub/overview');
    eq([ov.kpi.sla.tech.cur.n, ov.kpi.sla.tech.cur.ok], [1, 0], 'tổng quan: việc tính trễ với hạn gốc');
    inv('hạn riêng');
  });

  await group('Người trả việc chỉ bị bỏ qua trong ngày, hoặc tới khi họ vào ca lại', async () => {
    const W = await world(kind);
    const { h, U, go, at, seen, tick, inv, holder, roster, kits, submit } = W;
    await W.dayShift(['2026-10-05', '2026-10-06'], ['t1']);
    at('2026-10-05', '09:00'); seen('t1');
    await kits(1);
    const a = await submit('K01');
    await go('t1', 'POST', `/api/hub/jobs/${a.id}/release`, { reason: 'Cần linh kiện ở kho khác' });
    tick();
    eq(holder(a), null, 't1 vừa trả việc, chỉ mình t1 trong ca → việc không tự giao lại cho t1 trong ngày');
    at('2026-10-06', '15:00'); seen('t1'); tick();
    eq(holder(a), 't1', 'hôm sau t1 trong ca (một mình) → việc tự giao cho t1');
    inv('bỏ qua người trả việc theo ngày');

    // Người bị trả việc vì vắng rồi vào ca trễ: được giao lại.
    await roster('ll', [{ user_id: U.l1.id, date: '2026-10-07', shift: 'HC' }]);
    at('2026-10-07', '08:00');
    const m = (await go('ll', 'POST', '/api/hub/jobs', { title: 'Sắp xếp kệ', assignee_id: U.l1.id })).job;
    at('2026-10-07', '09:31'); tick();
    eq(holder(m), null, 'l1 vắng → việc về hàng chung (không ai trong ca)');
    eq(h.store.jobs.get(m.id).skip_uid, U.l1.id, 'ghi người vừa trả việc');
    at('2026-10-07', '10:00'); seen('l1');
    eq(holder(m), 'l1', 'l1 vào ca trễ sau lúc trả việc → không còn bị bỏ qua, việc giao lại cho l1');
    inv('vào ca lại sau khi bị trả việc');
  });

  await group('Khoá tài khoản hoặc đổi vai trò: việc đang giữ trả về cho cả đội và tự giao lại', async () => {
    const W = await world(kind);
    const { h, U, go, at, seen, inv, holder, kits, submit } = W;
    await W.dayShift(['2026-10-05'], ['t1', 't2']);
    at('2026-10-05', '09:00'); seen('t1', 't2');
    await kits(3);
    const a = await submit('K01'), b = await submit('K02');
    for (const j of [a, b]) await go('tl', 'POST', `/api/hub/jobs/${j.id}/assign`, { user_id: U.t1.id });
    await go('t1', 'POST', `/api/hub/jobs/${b.id}/start`);
    await go('ad', 'PATCH', `/api/users/${U.t1.id}`, { active: false });
    eq([holder(a), holder(b)], ['t2', 't2'], 'khoá t1 → cả việc chờ làm và việc đang làm chuyển cho t2 đang trong ca');
    eq(h.store.jobs.get(b.id).status, 'open', 'việc đang làm dở trở về chờ làm');
    ok(h.store.hub_log.count({ entity: 'job', entity_id: b.id, action: 'release' }) === 1, 'có nhật ký trả việc');
    ok(h.store.inbox.find({ user_id: U.tl.id, kind: 'release' }).some((n) => /bị khoá/.test(n.text)), 'Tech Lead được báo');
    const mine = (await go('t2', 'GET', '/api/hub/jobs', null, { view: 'mine' })).jobs.map((j) => j.id);
    ok(mine.includes(a.id) && mine.includes(b.id), 't2 thấy cả hai việc trong "Việc của tôi"');
    eq((await h.call('t2', 'POST', `/api/hub/jobs/${b.id}/done`, { result: { pass: true } })).status, 200, 't2 làm xong việc được');
    inv('khoá tài khoản');
    await go('ad', 'PATCH', `/api/users/${U.t2.id}`, { role: 'logistic' });
    eq(holder(a), null, 't2 đổi sang Logistics → việc Tech trả về hàng chung (không còn Tech trong ca)');
    inv('đổi vai trò');
  });

  await group('Chỉ giao việc cho thành viên đang hoạt động của team giữ việc (không FO, không team khác)', async () => {
    const W = await world(kind);
    const { U, go, call, at, seen, inv, holder, kits, submit } = W;
    await W.dayShift(['2026-10-05'], ['t1']);
    at('2026-10-05', '09:00'); seen('t1');
    await kits(1);
    const a = await submit('K01');
    const r1 = await call('ll', 'POST', '/api/hub/jobs', { title: 'Đi lấy hàng', assignee_id: U.fo1.id });
    ok(r1.status === 400 && r1.body.error === 'bad_user' && /FO/.test(r1.body.message), `Lead tạo việc giao cho FO → 400 (${r1.body.message})`);
    eq((await call('tl', 'POST', `/api/hub/jobs/${a.id}/assign`, { user_id: U.fo1.id })).status, 400, 'giao việc Tech cho FO → 400');
    eq((await call('tl', 'POST', `/api/hub/jobs/${a.id}/assign`, { user_id: U.l1.id })).status, 400, 'giao việc Tech cho người Logistics → 400');
    eq((await call('tl', 'POST', '/api/hub/jobs/bulk-assign', { job_ids: [a.id], user_id: U.fo1.id })).status, 400, 'giao hàng loạt cho FO → 400');
    eq(holder(a), 't1', 'việc giữ nguyên');
    const me = await call('ll', 'POST', '/api/hub/jobs', { title: 'Việc Lead tự làm', assignee_id: 'me' });
    eq([me.status, me.body.job && me.body.job.assignee && me.body.job.assignee.id], [200, U.ll.id], 'Lead chọn "Tôi tự làm" → việc của Lead');
    eq((await call('ll', 'POST', '/api/hub/jobs', { title: 'Việc cho Log Hai', assignee_id: U.l2.id })).status, 200, 'giao cho thành viên Logistics → được');
    eq((await call('tl', 'POST', `/api/hub/jobs/${a.id}/assign`, { user_id: U.tl.id })).status, 200, 'Lead tự nhận việc của team → được');
    inv('giao đúng người');
  });

  await group('Đưa việc đang làm về hàng chung: trở lại chờ làm, tự giao được; số "chưa ai nhận" khớp giữa các màn', async () => {
    const W = await world(kind);
    const { h, U, go, at, seen, inv, holder, kits, submit } = W;
    await W.dayShift(['2026-10-05'], ['t1', 't2']);
    at('2026-10-05', '09:00'); seen('t1');
    await kits(1);
    const a = await submit('K01');
    await go('t1', 'POST', `/api/hub/jobs/${a.id}/start`);
    await go('tl', 'POST', `/api/hub/jobs/${a.id}/assign`, { user_id: null });
    const j = h.store.jobs.get(a.id);
    eq([j.status, j.assignee_id], ['open', null], 'việc đang làm để chung → trở lại chờ làm, chưa ai nhận');
    eq((await go('tl', 'GET', '/api/hub/jobs')).counts.pool, 1, 'Tech Lead: 1 việc chưa ai nhận');
    eq((await go('ad', 'GET', '/api/hub/jobs')).counts.pool, 1, 'Quản trị (mọi team): 1 việc chưa ai nhận');
    eq((await go('tl', 'GET', '/api/hub/overview')).kpi.queue.tech.pool, 1, 'tổng quan cùng số');
    at('2026-10-05', '09:10'); seen('t2');
    eq([holder(a), h.store.jobs.get(a.id).status], ['t2', 'open'], 't2 vào ca → hệ thống tự giao việc (không giao lại cho t1 vừa bị gỡ)');
    inv('đưa việc đang làm về hàng chung');
  });

  await group('Tải của việc nhập dung lượng thẻ chỉ tính số thẻ còn ở Tech', async () => {
    const W = await world(kind);
    const { U, go, at, seen, inv, job, card } = W;
    await W.dayShift(['2026-10-05', '2026-10-06', '2026-10-07']);
    at('2026-10-05', '08:30'); seen('l1', 'l2', 't1', 't2');
    const site = await liveBO(W);
    at('2026-10-06', '08:30'); seen('l1', 'l2', 't1', 't2'); W.tick();
    const sw1 = job({ type: 'card_swap', site_id: site.id, date: '2026-10-06' });
    await go(W.uname(sw1.assignee_id), 'POST', `/api/hub/jobs/${sw1.id}/done`, { result: { cards_out: ['SD01', 'SD02', 'SD03', 'SD04'] } });
    at('2026-10-07', '08:30'); seen('l1', 'l2', 't1', 't2'); W.tick();
    const sw2 = job({ type: 'card_swap', site_id: site.id, date: '2026-10-07' });
    await go(W.uname(sw2.assignee_id), 'POST', `/api/hub/jobs/${sw2.id}/done`, { result: { cards_out: ['SD05', 'SD06', 'SD07', 'SD08'] } });
    eq(['SD01', 'SD04'].map((c) => card(c).status), ['returned', 'returned'], 'thẻ cũ đã thu về VP');
    const ho = (await go('l1', 'POST', '/api/hub/handovers', { dir: 'to_tech', codes: ['SD01', 'SD02', 'SD03', 'SD04'] })).handover;
    await go('t1', 'POST', `/api/hub/handovers/${ho.id}/receive`, { all: true });
    const up = job({ type: 'cards_upload', handover_id: ho.id });
    eq([W.uname(up.assignee_id), up.units], ['t1', 4], 'việc nhập 4 thẻ giao cho t1 (người nhận phiếu)');
    const board = async () => Object.fromEntries((await go('tl', 'GET', '/api/hub/jobs')).members.map((m) => [m.id, m.load_min]));
    eq((await board())[U.t1.id], 24, 'tải của t1: 4 thẻ × 6 phút chuẩn');
    await go('t2', 'POST', '/api/hub/cards/records', { records: ['SD01', 'SD02', 'SD03'].map((c) => ({ card_id: card(c).id, gb: 30, shoot_date: '2026-10-06' })) });
    eq((await board())[U.t1.id], 6, 't2 nhập giúp 3 thẻ → tải của t1 còn 1 thẻ × 6 phút');
    await go('tl', 'POST', '/api/hub/jobs', { title: 'Dọn bàn kiểm', assignee_id: U.t2.id }); // t2 giữ 10 phút
    const n = (await go('tl', 'POST', '/api/hub/jobs', { title: 'Sắp lại tủ linh kiện' })).job; // để chung: hệ thống giao người ít tải
    eq(n.assignee && n.assignee.id, U.t1.id, 'việc mới giao cho người ít tải thật (t1: 6 phút, t2: 10 phút)');
    inv('tải việc nhập thẻ');
  });

  await group('Đổi thẻ trễ làm vào ngày đổi kế tiếp: đóng luôn lượt của hôm nay, lượt ngày sau vẫn chờ', async () => {
    const W = await world(kind);
    const { h, go, at, seen, inv, job, jobs } = W;
    await W.dayShift(['2026-10-05']);
    await W.dayShift(['2026-10-07', '2026-10-14'], ['l1', 'l2']);
    at('2026-10-05', '08:30'); seen('l1', 'l2', 't1', 't2');
    const site = await liveBO(W, [3, 5]); // Thứ Tư, Thứ Sáu
    at('2026-10-07', '08:30'); seen('l1', 'l2'); W.tick();
    const wed = job({ type: 'card_swap', site_id: site.id, date: '2026-10-07' });
    await go(W.uname(wed.assignee_id), 'POST', `/api/hub/jobs/${wed.id}/done`, { result: { cards_out: ['SD01', 'SD02'] } });
    at('2026-10-14', '08:30'); seen('l1', 'l2'); W.tick();
    const fri = job({ type: 'card_swap', site_id: site.id, date: '2026-10-09' });
    eq(fri.status, 'open', 'lượt thứ Sáu 09/10 bị lỡ, còn mở');
    at('2026-10-14', '09:30');
    await go(W.uname(fri.assignee_id) || 'l1', 'POST', `/api/hub/jobs/${fri.id}/done`, { result: { cards_out: ['SD03', 'SD04'] } });
    const st = Object.fromEntries(jobs({ type: 'card_swap', site_id: site.id }).map((j) => [j.date, j.status]));
    eq([st['2026-10-09'], st['2026-10-14'], st['2026-10-16']], ['done', 'done', 'open'], 'lượt hôm nay (14/10) đóng chung; lượt 16/10 vẫn chờ');
    at('2026-10-14', '13:30'); W.tick();
    eq(h.store.jobs.get(job({ type: 'card_swap', site_id: site.id, date: '2026-10-14' }).id).al_due, 0, 'không còn cảnh báo quá hạn cho lượt hôm nay');
    inv('đổi thẻ trễ');
  });

  await group('Trả việc / để chung: người vừa trả không được tính vào phần chia đều, đồng đội trong ca nhận ngay dù đang nhiều tải hơn', async () => {
    const W = await world(kind);
    const { h, U, go, at, seen, tick, inv, holder, roster, kits, submit } = W;
    await roster('tl', [{ user_id: U.t1.id, date: '2026-10-05', shift: 'HC' }, { user_id: U.t2.id, date: '2026-10-05', shift: 'HC' }]);
    at('2026-10-05', '08:35'); seen('t1', 't2');
    await kits(5);
    const list = [];
    for (const k of ['K01', 'K02', 'K03']) list.push(await submit(k));
    const n = (u) => list.filter((j) => holder(j) === u).length;
    eq([n('t1'), n('t2')].sort(), [1, 2], 'ba việc kiểm chia 2 / 1');
    const low = n('t1') === 1 ? 't1' : 't2', hi = low === 't1' ? 't2' : 't1';
    const mine = list.find((j) => holder(j) === low);
    await go(low, 'POST', `/api/hub/jobs/${mine.id}/release`, { reason: 'Bận việc khác gấp' });
    eq([holder(mine), h.store.jobs.get(mine.id).status], [hi, 'open'], `${low} trả việc → ${hi} (đang trong ca, nhiều tải hơn) nhận ngay`);
    inv('trả việc khi đồng đội nhiều tải hơn');

    // Lead đưa việc đang làm của người ít tải về hàng chung: người còn lại trong ca nhận ngay.
    const b = await submit('K04');
    eq(holder(b), low, `việc mới giao cho ${low} (ít tải nhất)`);
    await go(low, 'POST', `/api/hub/jobs/${b.id}/start`);
    await go('tl', 'POST', `/api/hub/jobs/${b.id}/assign`, { user_id: null });
    eq([holder(b), h.store.jobs.get(b.id).status], [hi, 'open'], `để chung việc đang làm của ${low} → ${hi} nhận, trở lại chờ làm`);
    for (let i = 0; i < 3; i++) tick();
    eq((await go('tl', 'GET', '/api/hub/jobs')).counts.pool, 0, 'không còn việc nào chưa ai nhận');
    ok(!h.store.inbox.find({ user_id: U.tl.id, kind: 'pool' }).length, 'Lead không phải nhận cảnh báo việc chưa ai nhận');
    inv('để chung việc đang làm');
  });

  await group('Trả việc rồi tự nhận / bắt đầu lại không làm mới hạn riêng: việc đã trễ vẫn tính trễ', async () => {
    const W = await world(kind);
    const { h, U, go, at, seen, tick, inv, roster, kits, submit } = W;
    await roster('tl', [{ user_id: U.t1.id, date: '2026-10-05', shift: 'HC' }, { user_id: U.t1.id, date: '2026-10-06', shift: 'HC' }]);
    at('2026-10-05', '08:35'); seen('t1');
    await kits(2);
    const a = await submit('K01');
    const due = h.store.jobs.get(a.id).due_at;
    at('2026-10-06', '08:30'); seen('t1');
    h.clock.set(due + 3 * 60 * MIN); tick();
    await go('t1', 'POST', `/api/hub/jobs/${a.id}/release`, { reason: 'Nhầm, để nhận lại' });
    await go('t1', 'POST', `/api/hub/jobs/${a.id}/claim`);
    let j = h.store.jobs.get(a.id);
    eq([j.due_at, j.due_mine], [due, due], 'tự nhận lại việc vừa trả: hạn riêng giữ như cũ');
    await go('t1', 'POST', `/api/hub/jobs/${a.id}/done`, { result: { pass: true } });
    const me = (await go('t1', 'GET', '/api/hub/perf/me', null, { period: 'week', key: '2026-W41' })).me;
    eq([me.with_due, me.on_time, me.late_jobs], [1, 0, 1], 'Hiệu suất của tôi: việc vẫn tính trễ');
    inv('trả rồi nhận lại');

    // Lead để chung rồi chính người đó bắt đầu làm từ hàng chung: cũng giữ hạn riêng cũ.
    const b = await submit('K02');
    const dueB = h.store.jobs.get(b.id).due_mine;
    h.clock.set(h.store.jobs.get(b.id).due_at + 60 * MIN);
    await go('tl', 'POST', `/api/hub/jobs/${b.id}/assign`, { user_id: null });
    eq(W.holder(b), null, 'chỉ t1 trong ca, vừa bị gỡ → việc để chung');
    await go('t1', 'POST', `/api/hub/jobs/${b.id}/start`);
    j = h.store.jobs.get(b.id);
    eq([W.holder(b), j.due_mine], ['t1', dueB], 'bắt đầu lại việc của chính mình từ hàng chung: hạn riêng cũ');
    // Lead giao tay lại: Lead quyết, hạn riêng tính từ lúc giao.
    await go('tl', 'POST', `/api/hub/jobs/${b.id}/assign`, { user_id: U.tl.id });
    await go('tl', 'POST', `/api/hub/jobs/${b.id}/assign`, { user_id: U.t1.id });
    ok(h.store.jobs.get(b.id).due_mine === h.clock.now() + 24 * 60 * MIN, 'Lead giao tay cho t1: hạn riêng mới từ lúc giao');
    inv('để chung rồi bắt đầu lại');
  });

  await group('Hiệu suất của tôi: danh sách "Việc vừa xong" đánh dấu trễ theo cùng hạn riêng với chỉ số Đúng hạn', async () => {
    const W = await world(kind);
    const { h, U, go, at, seen, tick, roster, kits, submit, holder } = W;
    await roster('tl', [{ user_id: U.t1.id, date: '2026-10-05', shift: 'HC' }, { user_id: U.t1.id, date: '2026-10-06', shift: 'HC' }, { user_id: U.t2.id, date: '2026-10-06', shift: 'HC' }]);
    at('2026-10-05', '10:00'); seen('t1');
    await kits(1);
    const a = await submit('K01');
    at('2026-10-06', '08:35'); seen('t2');
    at('2026-10-06', '09:31'); tick();
    eq(holder(a), 't2', 't1 vắng → t2 nhận');
    at('2026-10-06', '11:00');
    await go('t2', 'POST', `/api/hub/jobs/${a.id}/done`, { result: { pass: true } });
    const me = (await go('t2', 'GET', '/api/hub/perf/me', null, { period: 'week', key: '2026-W41' })).me;
    const x = (await go('t2', 'GET', '/api/hub/jobs', null, { status: 'done', view: 'mine' })).jobs.find((r) => r.id === a.id);
    eq([me.late_jobs, x.late, x.late_mine], [0, true, false], 'trễ theo hạn team, đúng hạn riêng; trang cá nhân dùng late_mine');
  });

  await group('Việc FO đang giữ từ trước (dữ liệu cũ): nhịp quét trả việc về cho thành viên team, Lead được báo', async () => {
    const W = await world(kind);
    const { h, U, go, at, seen, tick, inv, holder, roster } = W;
    await roster('ll', [{ user_id: U.l1.id, date: '2026-10-05', shift: 'HC' }]);
    at('2026-10-05', '08:35'); seen('l1');
    const j = (await go('ll', 'POST', '/api/hub/jobs', { title: 'Dọn kho phụ kiện', assignee_id: U.l2.id })).job;
    const own = (await go('ll', 'POST', '/api/hub/jobs', { title: 'Việc Lead tự làm', assignee_id: 'me' })).job;
    h.store.jobs.update(j.id, { assignee_id: U.fo1.id }); // dòng cũ: giao cho FO trước khi có kiểm người nhận
    tick();
    eq(holder(j), 'l1', 'việc FO đang giữ trả về, l1 trong ca nhận');
    ok(h.store.inbox.find({ user_id: U.ll.id, kind: 'offshift' }).some((n) => /FO Một/.test(n.text)), 'Logistic Lead được báo');
    eq(holder(own), 'll', 'việc Lead tự giữ vẫn của Lead');
    inv('việc FO giữ từ trước');
  });

  await group('Cài đặt: thời gian chờ sau khi hết ca là đề xuất, Lead sửa được, có kiểm giá trị', async () => {
    const W = await world(kind);
    const { go, call } = W;
    const c = await go('tl', 'GET', '/api/hub/config');
    eq([c.defaults.releaseGraceMin, c.owners.releaseGraceMin, c.editable.includes('releaseGraceMin')], [30, 'Lead', true], 'mặc định 30 phút, Lead chốt');
    eq((await call('ll', 'PUT', '/api/hub/config', { releaseGraceMin: 999 })).status, 400, 'ngoài khoảng 0–240 → 400');
    // Mục ca làm có giá trị riêng từng team (TEAM_CFG): Logistic Lead đổi phần của Logistics, phần của Tech giữ đề xuất.
    eq((await go('ll', 'PUT', '/api/hub/config', { releaseGraceMin: 15 })).values.releaseGraceMin, { tech: 30, logistics: 15 }, 'Logistic Lead đổi được phần của Logistics');
    eq((await call('s1', 'PUT', '/api/hub/config', { releaseGraceMin: 20 })).status, 403, 'Sale không đổi được');
  });
}

await suite('memory');
await suite('sqlite');
summary('Bộ giao việc');
