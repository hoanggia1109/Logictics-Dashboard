// fix.people.test.mjs — kiểm hồi quy cho cụm "nhân sự": bảng phân ca, chấm công, đánh giá hiệu suất kiểu HRIS, cấu hình riêng
// của từng team. Mỗi nhóm dựng thế giới riêng qua API thật và chạy 2 lần: kho bộ nhớ (bản xem thử) và kho SQLite (máy chủ).
import { mk, boDevice, ok, eq, group, summary, JPEG } from './harness.mjs';

const MIN = 60000, HOUR = 60 * MIN;
const VN = (date, hm) => Date.parse(`${date}T${hm}:00+07:00`);
const W41 = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']; // thứ Hai → thứ Sáu của W41
const BO = { name: 'BO Quận 3', type: 'bo', lat: 10.7835, lon: 106.6869 };

async function world(kind, extra = []) {
  const h = mk(kind);
  h.clock.set(VN('2026-10-05', '06:00')); // thứ Hai W41, trước giờ ca
  const people = [['ad', 'admin', 'Quản trị'], ['tl', 'tech_lead', 'Trưởng Tech'], ['t1', 'tech', 'Tech Một'], ['t2', 'tech', 'Tech Hai'], ['ll', 'lead', 'Trưởng Logistics'],
    ['l1', 'logistic', 'Log Một'], ['l2', 'logistic', 'Log Hai'], ['fo1', 'fo', 'FO Một'], ['sh', 'sale_head', 'Trưởng Sale'], ['s1', 'sale', 'Sale Một'], ...extra];
  const U = {};
  for (const [u, role, name] of people) U[u] = await h.user(u, role, { name });
  const call = (who, method, path, body, query) => h.call(who, method, path, body, query);
  const go = async (who, method, path, body, query) => {
    const r = await h.call(who, method, path, body, query);
    if (r.status !== 200) throw new Error(`${who} ${method} ${path} → ${r.status} ${r.body.error}: ${r.body.message}`);
    return r.body;
  };
  const st = async (who, method, path, body, query) => (await h.call(who, method, path, body, query)).status;
  const at = (date, hm) => h.clock.set(VN(date, hm));
  const seen = (...us) => { for (const u of us) h.core.hub.K.hooks.onSeen(h.byName(u), h.clock.now()); };
  const tickAt = (date, hm) => { at(date, hm); h.core.tick(); };
  const lead = (u) => (['t1', 't2', 't3', 't4', 'tl'].includes(u) ? 'tl' : 'll');
  /** Lead xếp ca (mặc định ca HC 08:30–17:30) cho các người trong danh sách, các ngày trong danh sách. */
  const roster = (users, dates, row = { shift: 'HC' }) => go(lead(users[0]), 'PUT', '/api/hub/roster', { rows: users.flatMap((u) => dates.map((date) => ({ user_id: U[u].id, date, ...row }))) });
  /** Một ngày làm việc: những người trong danh sách mở ứng dụng lúc 08:35 (đúng giờ ca HC); nhịp định kỳ chạy lúc 09:31 (ghi vắng). */
  const workDay = (date, who) => { at(date, '08:35'); seen(...who); tickAt(date, '09:31'); };
  /** Lead giao việc tay có phút chuẩn cho một người, người đó làm xong ngay. */
  const doneJob = async (who, std, extraBody = {}) => {
    const team = ['t1', 't2', 't3', 't4'].includes(who) ? 'tech' : 'logistics';
    const j = (await go(lead(who), 'POST', '/api/hub/jobs', { team, title: 'Việc kiểm thử', assignee_id: U[who].id, std_min: std, ...extraBody })).job;
    await go(who, 'POST', `/api/hub/jobs/${j.id}/done`, { result: {} });
    return j;
  };
  const perf = (who, team, key = '2026-W41', period = 'week') => go(who, 'GET', '/api/hub/perf', null, { team, period, key });
  const me = (who, key = '2026-W41', period = 'week') => go(who, 'GET', '/api/hub/perf/me', null, { period, key });
  const row = (p, u) => p.rows.find((r) => r.user.id === U[u].id);
  const att = (u, date) => h.store.attendance.get(`${U[u].id}:${date}`);
  const cfgv = async (who = 'ad') => (await go(who, 'GET', '/api/hub/config')).values;
  const logs = (where) => h.store.hub_log.find(where);
  return { h, U, call, go, st, at, seen, tickAt, roster, workDay, doneJob, perf, me, row, att, cfgv, logs };
}

/** FO chạy hết một chuyến: nhận, bắt đầu, xác nhận từng điểm; BO xác nhận qua link. */
async function runTrip(W, taskId) {
  const { h, go } = W;
  await go('fo1', 'POST', `/api/tasks/${taskId}/accept`);
  await go('fo1', 'POST', `/api/tasks/${taskId}/start`);
  for (const s of h.store.stops.find({ task_id: taskId }, { order: 'seq' })) {
    h.clock.add(15 * MIN);
    await go('fo1', 'POST', `/api/stops/${s.id}/proof`, { photos: s.is_return ? [] : [JPEG], cards_out: s.exp_cards_out, cards_in: s.exp_cards_in, dev_out: s.exp_dev_out, dev_in: s.exp_dev_in, lat: s.lat, lon: s.lon });
    if (h.store.stops.get(s.id).bo_status === 'pending') {
      const { token } = await go('l1', 'POST', `/api/stops/${s.id}/bo-link`);
      const bo = boDevice(h);
      await bo.call('POST', '/api/bo-link/view', { token });
      const r = await bo.call('POST', '/api/bo-link/confirm', { token, photos: [JPEG], cards_recv: s.exp_cards_out, cards_given: s.exp_cards_in, dev_recv: s.exp_dev_out, dev_given: s.exp_dev_in });
      if (r.status !== 200) throw new Error('BO xác nhận lỗi: ' + JSON.stringify(r.body));
    }
  }
  return h.store.tasks.get(taskId);
}
/** Thẻ đã thu về VP, Logistics lập phiếu gửi Tech, người nhận (who) xác nhận đủ. Trả về danh sách thẻ. */
async function cardsAtTech(W, codes, who) {
  const { h, go } = W;
  await go('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: codes.join(' ') });
  for (const c of codes) { const cd = h.store.cards.find({ code: c }, { limit: 1 })[0]; h.store.cards.update(cd.id, { status: 'returned' }); }
  const ho = (await go('l1', 'POST', '/api/hub/handovers', { dir: 'to_tech', codes: codes.join(' ') })).handover;
  await go(who, 'POST', `/api/hub/handovers/${ho.id}/receive`, { all: true });
  return { ho, cards: codes.map((c) => h.store.cards.find({ code: c }, { limit: 1 })[0]) };
}

async function suite(kind) {
  console.log(`\n── Kho ${kind === 'sqlite' ? 'SQLite' : 'bộ nhớ'} ──`);

  await group('Hiệu suất của tôi: team nhỏ không lộ số của đồng nghiệp (qua điểm khối lượng hay trung bình team)', async () => {
    // C1: Tech có đúng 2 nhân viên. t1 biết số của mình; nếu biết thêm s_vol = 80 × ppd ÷ TB team thì giải ra được ppd của t2.
    let W = await world(kind);
    await W.roster(['t1', 't2'], W41);
    for (const d of W41) {
      W.workDay(d, ['t1', 't2']);
      if (d === W41[0]) { await W.doneJob('t1', 300); await W.doneJob('t2', 360); } // 10 và 12 điểm/công
    }
    W.at('2026-10-12', '09:00');
    const board = await W.perf('tl', 'tech');
    ok(W.row(board, 't1').s_vol !== null && W.row(board, 't1').score !== null, 'đối chứng: Tech Lead vẫn thấy đủ điểm thành phần của t1');
    let m = await W.me('t1');
    eq([m.me.ppd, m.me.points], [10, 50], 'C1: t1 vẫn thấy số của chính mình (điểm, điểm/công)');
    eq([m.me.s_vol, m.me.score, m.me.rating, m.me.prev_score], [null, null, null, null], 'C1: team chỉ còn 1 người khác → không gửi điểm khối lượng / tổng hợp / mức (đều suy ra được TB team)');
    eq(m.team_avg, null, 'C1: không gửi trung bình team');
    ok(!JSON.stringify(m).includes('72.7'), 'C1: phản hồi không chứa điểm khối lượng (suy ra được ppd của t2)');

    // C2: thêm t3 chỉ có tài khoản (không công, không việc): trung bình "3 người" thật ra chỉ của t2.
    W = await world(kind, [['t3', 'tech', 'Tech Ba']]);
    await W.roster(['t1', 't2'], W41);
    for (const d of W41) {
      W.workDay(d, ['t1', 't2']);
      if (d === W41[0]) { await W.doneJob('t1', 300); await W.doneJob('t2', 360); }
    }
    W.at('2026-10-12', '09:00');
    m = await W.me('t1');
    const a = m.team_avg || {};
    ok(!m.team_avg || ['points', 'ppd', 'sla_pct', 'score'].every((k) => a[k] === null || a[k] === undefined), `C2: tài khoản không làm gì không được tính là người góp vào trung bình (nhận ${JSON.stringify(m.team_avg)})`);
    eq([m.me.s_vol, m.me.score], [null, null], 'C2: điểm khối lượng / tổng hợp của t1 vẫn ẩn (chỉ 1 người khác đủ điều kiện)');

    // C3: đủ 2 người khác cùng làm: trung bình loại chính người xem, chỉ tính người có số.
    W = await world(kind, [['t3', 'tech', 'Tech Ba']]);
    await W.roster(['t1', 't2', 't3'], W41);
    for (const d of W41) {
      W.workDay(d, ['t1', 't2', 't3']);
      if (d === W41[0]) { await W.doneJob('t1', 300); await W.doneJob('t2', 360); await W.doneJob('t3', 240); } // t3: 8 điểm/công
    }
    W.at('2026-10-12', '09:00');
    m = await W.me('t1');
    ok(m.team_avg && m.team_avg.ppd === 10 && m.team_avg.points === 50, `C3: trung bình của 2 người khác (không gồm người xem): ppd ${m.team_avg && m.team_avg.ppd}, điểm ${m.team_avg && m.team_avg.points}`);
    ok(m.me.score !== null && m.me.rating !== null && m.me.s_vol !== null, 'C3: đủ người thì có điểm tổng hợp và mức của chính mình');

    // C4: t4 chỉ làm 1 ngày (dưới số công tối thiểu): không góp vào TB điểm/công dùng cho điểm khối lượng. Nếu trung bình team gửi
    // cho t1 vẫn tính t4 thì 3 × TB team − (tổng ppd suy từ điểm khối lượng) ra đúng ppd của t4.
    W = await world(kind, [['t3', 'tech', 'Tech Ba'], ['t4', 'tech', 'Tech Bốn']]);
    await W.roster(['t1', 't2', 't3'], W41);
    await W.roster(['t4'], [W41[0]]);
    for (const d of W41) {
      W.workDay(d, d === W41[0] ? ['t1', 't2', 't3', 't4'] : ['t1', 't2', 't3']);
      if (d === W41[0]) { await W.doneJob('t1', 300); await W.doneJob('t2', 360); await W.doneJob('t3', 240); await W.doneJob('t4', 90); } // t4: 15 điểm/công
    }
    W.at('2026-10-12', '09:00');
    eq(W.row(await W.perf('tl', 'tech'), 't4').ppd, 15, 'đối chứng: Tech Lead thấy t4 có 15 điểm/công');
    m = await W.me('t1');
    eq([m.team_avg && m.team_avg.ppd, m.team_avg && m.team_avg.points, m.avg_n], [10, 50, 2], 'C4: trung bình team chỉ gồm đúng những người góp vào TB điểm/công (bỏ người dưới số công tối thiểu)');
    const teamPpd = (80 * m.me.ppd) / m.me.s_vol; // TB điểm/công dùng cho điểm khối lượng của t1 (gồm t1)
    ok(Math.abs(teamPpd * 3 - m.me.ppd - m.team_avg.ppd * m.avg_n) < 0.5, `C4: hai con số khớp cùng một nhóm người, không suy ra được ai khác (TB ${teamPpd.toFixed(2)}, TB người khác ${m.team_avg.ppd})`);
  });

  await group('Cấu hình riêng từng team: mỗi Lead chốt ngưỡng xếp loại của team mình, không đổi được của team kia', async () => {
    const W = await world(kind);
    const { go, st, cfgv } = W;
    const cl = await go('ll', 'GET', '/api/hub/config');
    ok(['minDaysWeek', 'minDaysMonth', 'scoreWeights', 'scoreBands', 'shifts', 'autoAssign'].every((k) => cl.editable.includes(k)), 'Logistic Lead sửa được phần của Logistics trong các mục xếp loại, ca, giao việc');
    eq([cl.my_teams, cl.team_keys.includes('minDaysWeek'), (await go('ad', 'GET', '/api/hub/config')).my_teams], [['logistics'], true, ['tech', 'logistics']], 'giao diện Cài đặt biết mục nào riêng theo team và người xem sửa được phần của team nào');
    eq((await cfgv()).minDaysWeek, { tech: 3, logistics: 3 }, 'giá trị đề xuất hiện theo từng team');
    eq(await st('ll', 'PUT', '/api/hub/config', { minDaysWeek: 2 }), 200, 'Logistic Lead chốt số công tối thiểu của Logistics');
    eq(await st('tl', 'PUT', '/api/hub/config', { minDaysWeek: 5 }), 200, 'Tech Lead chốt số công tối thiểu của Tech');
    eq((await cfgv()).minDaysWeek, { tech: 5, logistics: 2 }, 'mỗi team giữ giá trị của mình');
    eq(await st('tl', 'PUT', '/api/hub/config', { minDaysWeek: { logistics: 7 } }), 403, 'Tech Lead không sửa được phần của Logistics');
    eq(await st('ll', 'PUT', '/api/hub/config', { scoreWeights: { tech: { vol: 100, sla: 0, quality: 0, att: 0 } } }), 403, 'Logistic Lead không sửa được trọng số của Tech');
    await go('tl', 'PUT', '/api/hub/config', { scoreWeights: { vol: 100, sla: 0, quality: 0, att: 0 } });
    await go('ad', 'PUT', '/api/hub/config', { scoreBands: { logistics: [95, 85, 70, 55] } });
    await go('ad', 'PUT', '/api/hub/config', { lateAfterMin: 20 });
    const v = await cfgv();
    eq([v.scoreWeights.tech.vol, v.scoreWeights.logistics.vol, v.scoreBands.tech[0], v.scoreBands.logistics[0], v.lateAfterMin], [100, 50, 90, 95, { tech: 20, logistics: 20 }], 'Quản trị sửa được từng team hoặc cả hai (một giá trị chung áp cho cả hai)');
    ok(W.logs({ entity: 'config' }).some((l) => /Logistics/.test(l.text) && /Số công tối thiểu/.test(l.text)), 'nhật ký cấu hình ghi rõ phần của team nào');

    // Bảng Logistics không đổi khi Tech Lead đổi ngưỡng của Tech.
    await W.roster(['l1', 'l2'], W41.slice(0, 3));
    for (const d of W41.slice(0, 3)) W.workDay(d, ['l1', 'l2']);
    await W.doneJob('l1', 120); await W.doneJob('l2', 90);
    W.at('2026-10-12', '09:00');
    const pl = await W.perf('ll', 'logistics'), pt = await W.perf('tl', 'tech');
    eq([pl.min_days, pt.min_days, pl.weights.vol, pt.weights.vol, pl.bands[0], pt.bands[0]], [2, 5, 50, 100, 95, 90], 'bảng hiệu suất dùng ngưỡng của đúng team');
    ok(W.row(pl, 'l1').rated && W.row(pl, 'l2').rated, 'Logistics 3 công vẫn được xếp loại dù Tech Lead đặt tối thiểu 5 công cho Tech');

    // Giá trị cũ lưu dạng chung (trước khi tách theo team) vẫn đọc được và áp cho cả hai team.
    const W2 = await world(kind);
    W2.h.core.hub.K.setSetting('hub_cfg', { minDaysWeek: 4, shifts: [{ id: 'X', name: 'Ca X', start: '09:00', end: '18:00' }] });
    eq((await W2.cfgv()).minDaysWeek, { tech: 4, logistics: 4 }, 'giá trị chung cũ áp cho cả hai team');
    eq([await W2.st('tl', 'PUT', '/api/hub/roster', { rows: [{ user_id: W2.U.t1.id, date: '2026-10-06', shift: 'X' }] }), await W2.st('ll', 'PUT', '/api/hub/roster', { rows: [{ user_id: W2.U.l1.id, date: '2026-10-06', shift: 'X' }] })], [200, 200], 'ca mẫu chung cũ dùng được ở cả hai team');
    await W2.go('ll', 'PUT', '/api/hub/config', { minDaysWeek: { logistics: 2 } });
    eq(W2.h.core.hub.K.getSetting('hub_cfg').minDaysWeek, { tech: 4, logistics: 2 }, 'Lead đổi phần của mình: phần của team kia giữ giá trị đang dùng');
  });

  await group('Cấu hình riêng từng team: giao việc, chấm công, ca mẫu, tự duyệt ca, cảnh báo Lead theo team', async () => {
    const W = await world(kind);
    const { h, U, go, st, at, seen, tickAt, att } = W;
    await W.roster(['t1', 't2'], ['2026-10-05', '2026-10-06']);
    await W.roster(['l1', 'l2'], ['2026-10-05', '2026-10-06']);
    await go('ll', 'PUT', '/api/hub/config', { autoAssign: false, absentAfterMin: 120 });
    await go('tl', 'PUT', '/api/hub/config', { lateAfterMin: 30, leadOverdueMin: 10 });
    at('2026-10-05', '08:35');
    seen('t1', 'l1');
    const jt = (await go('tl', 'POST', '/api/hub/jobs', { team: 'tech', title: 'Việc Tech chưa giao', due_hours: 1 })).job;
    const jl = (await go('ll', 'POST', '/api/hub/jobs', { team: 'logistics', title: 'Việc Logistics chưa giao', due_hours: 1 })).job;
    eq([jt.assignee && jt.assignee.id, jl.assignee], [U.t1.id, null], 'Logistics tắt tự giao việc: việc Tech vẫn tự giao cho người trong ca, việc Logistics để chung');
    tickAt('2026-10-05', '09:31');
    eq([att('t2', '2026-10-05').status, att('l2', '2026-10-05')], ['absent', null], 'ghi vắng theo ngưỡng của từng team (Tech 60 phút, Logistics 120 phút)');
    tickAt('2026-10-05', '09:50'); // cả hai việc đã quá hạn 15 phút
    eq([h.store.inbox.count({ user_id: U.tl.id, kind: 'lead_overdue' }), h.store.inbox.count({ user_id: U.ll.id, kind: 'lead_overdue' })], [1, 0], 'báo Lead việc quá hạn theo ngưỡng của từng team (Tech 10 phút, Logistics 120 phút)');
    at('2026-10-06', '08:50'); // trễ 20 phút
    seen('t1', 'l1');
    eq([att('t1', '2026-10-06').status, att('l1', '2026-10-06').status], ['present', 'late'], 'tính trễ theo ngưỡng của từng team (Tech 30 phút, Logistics 10 phút)');
    await go('ll', 'PUT', '/api/hub/config', { shifts: [{ id: 'L', name: 'Ca Logistics', start: '08:00', end: '17:00' }] });
    eq([await st('tl', 'PUT', '/api/hub/roster', { rows: [{ user_id: U.t1.id, date: '2026-10-07', shift: 'HC' }] }), await st('ll', 'PUT', '/api/hub/roster', { rows: [{ user_id: U.l1.id, date: '2026-10-07', shift: 'HC' }] })], [200, 400], 'Logistics đổi ca mẫu không làm mất ca mẫu của Tech');
    eq([(await go('tl', 'GET', '/api/hub/roster')).shifts.map((s) => s.id), (await go('ll', 'GET', '/api/hub/roster')).shifts.map((s) => s.id)], [['HC', 'S', 'C'], ['L']], 'bảng phân ca của mỗi team hiện ca mẫu của team đó');
    await go('tl', 'PUT', '/api/hub/config', { rosterSelfApprove: true });
    eq([(await go('t2', 'POST', '/api/hub/roster/register', { rows: [{ date: '2026-10-08', shift: 'HC' }] })).pending, (await go('l2', 'POST', '/api/hub/roster/register', { rows: [{ date: '2026-10-08', shift: 'L' }] })).pending], [false, true], 'Tech cho tự duyệt ca không làm Logistics tự duyệt');
  });

  await group('Mở lại kỳ đã chốt: thiếu lý do thì không mở, số đã chốt còn nguyên; mở được thì nhật ký giữ bản đã chốt', async () => {
    const W = await world(kind);
    const { h, go, call } = W;
    await go('tl', 'POST', '/api/hub/perf/lock', { team: 'tech', period: 'week', key: '2026-W40' });
    for (const reason of [undefined, '  a ']) {
      const r = await call('ad', 'POST', '/api/hub/perf/unlock', { team: 'tech', period: 'week', key: '2026-W40', reason });
      eq([r.status, r.body.error], [400, 'reason_required'], `mở lại với lý do ${JSON.stringify(reason)} → cần lý do`);
      ok(!!h.store.perf_lock.get('tech:week:2026-W40'), 'kỳ vẫn đang chốt sau lần mở lại bị từ chối');
    }
    eq(W.logs({ entity: 'perf', action: 'unlock' }).length, 0, 'không có nhật ký mở lại khi bị từ chối');
    await go('ad', 'POST', '/api/hub/perf/unlock', { team: 'tech', period: 'week', key: '2026-W40', reason: 'Sửa chấm công quên ghi' });
    const l = W.logs({ entity: 'perf', action: 'unlock' });
    ok(!h.store.perf_lock.get('tech:week:2026-W40') && l.length === 1, 'mở lại có lý do: bỏ chốt, có nhật ký');
    eq(l[0].data, { team: 'tech', period: 'week', key: '2026-W40', locked_by: W.U.tl.id }, 'nhật ký chỉ ghi kỳ nào, của team nào (không chứa bảng điểm từng người)');
    const snap = await go('tl', 'GET', '/api/hub/perf', null, { period: 'week', key: '2026-W40', snapshot: 1 });
    ok(snap.locked && snap.snapshot && snap.snapshot.reason === 'Sửa chấm công quên ghi' && snap.label === 'W40', 'bản số liệu đã chốt vẫn xem được qua bảng hiệu suất của team');
    eq((await go('tl', 'GET', '/api/hub/perf', null, { period: 'week', key: '2026-W40' })).reopened.reason, 'Sửa chấm công quên ghi', 'bảng hiện tại cho biết kỳ đã được mở lại và lý do');
  });

  await group('Nhật ký thao tác: Lead team kia không đọc được bảng điểm, chấm công của team này', async () => {
    const W = await world(kind);
    const { U, go, call } = W;
    await W.roster(['t1', 't2'], W41);
    await W.roster(['l1'], W41);
    for (const d of W41) {
      W.workDay(d, d === W41[3] ? ['t2', 'l1'] : ['t1', 't2', 'l1']); // t1 vắng thứ Năm
      if (d === W41[0]) { await W.doneJob('t1', 300); await W.doneJob('t2', 360); }
    }
    W.at('2026-10-12', '09:00');
    await go('tl', 'POST', '/api/hub/perf/lock', { team: 'tech', period: 'week', key: '2026-W41' });
    await go('ad', 'POST', '/api/hub/perf/unlock', { team: 'tech', period: 'week', key: '2026-W41', reason: 'Kiểm lại chấm công' });
    await go('t1', 'POST', '/api/hub/roster/register', { rows: [{ date: '2026-10-20', kind: 'leave', note: 'Việc gia đình' }] });
    eq((await call('ll', 'GET', '/api/hub/perf', null, { team: 'tech', snapshot: 1, key: '2026-W41' })).status, 403, 'đối chứng: Logistic Lead không xem bảng Tech, kể cả bản đã chốt');
    const ll = (await go('ll', 'GET', '/api/hub/log', null, { limit: 1000 })).items;
    // Nhật ký việc (job) theo bảng việc chung, không thuộc phần này; chỉ xét chấm công, bảng ca, chốt kỳ.
    const leak = ll.filter((x) => ['attendance', 'roster', 'perf'].includes(x.entity) && (JSON.stringify(x).includes('Tech Một') || JSON.stringify(x).includes('Tech Hai') || (x.data && x.data.rows)));
    ok(!leak.length, `Logistic Lead không thấy tên, điểm, chấm công của người Tech trong nhật ký (${leak.map((x) => x.entity + ':' + x.action + ':' + x.text).join(' | ')})`);
    ok(ll.some((x) => x.entity === 'attendance' && x.entity_id === U.l1.id), 'Logistic Lead vẫn thấy chấm công của team mình');
    ok(!ll.some((x) => x.entity === 'perf' && x.data && x.data.team === 'tech'), 'Logistic Lead không thấy nhật ký chốt / mở lại kỳ của Tech');
    const tl = (await go('tl', 'GET', '/api/hub/log', null, { limit: 1000 })).items;
    ok(tl.some((x) => x.entity === 'attendance' && x.entity_id === U.t1.id && x.action === 'absent') && tl.some((x) => x.entity === 'perf' && x.action === 'unlock'), 'Tech Lead thấy chấm công và chốt / mở lại kỳ của team mình');
    ok(!tl.some((x) => x.entity === 'attendance' && x.entity_id === U.l1.id), 'Tech Lead không thấy chấm công của Logistics');
    const ad = (await go('ad', 'GET', '/api/hub/log', null, { limit: 1000 })).items;
    ok(ad.some((x) => x.entity === 'attendance' && x.entity_id === U.l1.id) && ad.some((x) => x.entity === 'attendance' && x.entity_id === U.t1.id), 'Quản trị thấy nhật ký của cả hai team');
  });

  await group('Chuyên cần: nghỉ phép không trừ hai lần, có mặt ngoài ca không bù cho ngày vắng trong ca', async () => {
    const W = await world(kind);
    const { at, tickAt } = W;
    await W.roster(['t1', 't2'], W41.slice(0, 4));
    await W.roster(['t1'], ['2026-10-09'], { kind: 'leave', note: 'Nghỉ phép năm' });
    for (const d of W41.slice(0, 3)) W.workDay(d, ['t1', 't2']);
    tickAt('2026-10-08', '09:31'); // thứ Năm cả hai không vào ca → vắng
    tickAt('2026-10-09', '09:31'); // thứ Sáu: t1 nghỉ phép đã duyệt
    eq(W.att('t1', '2026-10-09').status, 'leave', 'đối chứng: ngày nghỉ phép được ghi vào chấm công');
    W.at('2026-10-10', '10:00');
    await W.go('tl', 'PATCH', `/api/hub/attendance/${W.U.t2.id}/2026-10-10`, { status: 'present', checkin: '09:00', reason: 'Làm bù thứ Bảy theo yêu cầu' });
    at('2026-10-12', '09:00');
    const p = await W.perf('tl', 'tech');
    const t1 = W.row(p, 't1'), t2 = W.row(p, 't2');
    eq([t1.scheduled, t1.absent, t1.leave, t1.s_att], [4, 1, 1, 75], 't1 đi 3/4 ca đã xếp (ngày phép không nằm trong ca phải làm, không trừ thêm lần nữa)');
    eq([t2.scheduled, t2.absent, t2.workdays, t2.s_att], [4, 1, 4, 75], 't2 làm thêm thứ Bảy (ngoài ca) vẫn tính công nhưng không bù cho ngày vắng trong ca');
  });

  await group('Chuyên cần giữa kỳ: ca chưa tới không tính là ca vắng', async () => {
    const W = await world(kind);
    await W.roster(['t1'], W41);
    await W.roster(['t2'], W41.slice(0, 3));
    for (const d of W41.slice(0, 3)) W.workDay(d, ['t1', 't2']);
    W.at('2026-10-07', '10:00');
    await W.doneJob('t1', 120); await W.doneJob('t2', 120);
    W.at('2026-10-07', '18:00');
    const p = await W.perf('tl', 'tech', null);
    const t1 = W.row(p, 't1'), t2 = W.row(p, 't2');
    eq([t1.scheduled, t1.s_att, t1.score], [3, 100, t2.score], 'thứ Tư: ca thứ Năm, thứ Sáu của t1 chưa tới nên chưa tính; t1 và t2 bằng điểm');
    const m = await W.me('t1', null);
    eq(m.me.s_att, 100, 'hiệu suất của tôi giữa tuần: chuyên cần 100');
  });

  await group('Không có ca đã duyệt thì không chấm công và không tự giao việc', async () => {
    const W = await world(kind);
    const { h, U, go, at, seen, att } = W;
    at('2026-10-11', '22:00'); // Chủ nhật, team Tech không xếp ca
    seen('t1');
    eq(att('t1', '2026-10-11'), null, 'mở ứng dụng ngoài ca (Chủ nhật 22:00) không thành ngày công');
    ok(!h.core.hub.jobs.onShift(h.byName('t1')), 'người không có ca không được coi là trong ca');
    const j = (await go('tl', 'POST', '/api/hub/jobs', { team: 'tech', title: 'Việc tối Chủ nhật' })).job;
    eq(j.assignee, null, 'việc mới không tự giao cho người không có ca');
    at('2026-10-12', '06:05'); // thứ Hai, Lead chưa xếp ca
    seen('t2');
    eq([att('t2', '2026-10-12'), h.store.jobs.get(j.id).assignee_id], [null, null], 'sáng sớm chưa có bảng ca: không chấm công, không giao việc');
    await W.roster(['t2'], ['2026-10-12']);
    at('2026-10-12', '08:35');
    seen('t2');
    eq([att('t2', '2026-10-12').status, h.store.jobs.get(j.id).assignee_id], ['present', U.t2.id], 'có ca đã duyệt: vào ca và nhận việc đang chờ');
    at('2026-10-12', '10:00');
    await go('tl', 'PATCH', `/api/hub/attendance/${U.t1.id}/2026-10-11`, { status: 'present', checkin: '20:00', reason: 'Trực tối Chủ nhật theo lịch riêng' });
    eq(att('t1', '2026-10-11').status, 'present', 'Lead vẫn ghi được công thật ngoài bảng ca');
  });

  await group('Chất lượng: chuyến FO bị huỷ (hệ thống mở lại việc) không tính là làm lại của người hoàn thành sau', async () => {
    const W = await world(kind);
    const { h, U, go } = W;
    const bo = (await go('ll', 'POST', '/api/sites', BO)).site;
    await W.roster(['l1', 'l2'], W41);
    W.workDay(W41[0], ['l1', 'l2']);
    W.at('2026-10-05', '10:00');
    const j1 = (await go('ll', 'POST', '/api/hub/jobs', { team: 'logistics', title: 'Mang phụ kiện ra BO', site_id: bo.id, assignee_id: U.l1.id, std_min: 30 })).job;
    const j2 = (await go('ll', 'POST', '/api/hub/jobs', { team: 'logistics', title: 'Mang phụ kiện ra BO', site_id: bo.id, assignee_id: U.l2.id, std_min: 30 })).job;
    const task = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [j1.id], fo_id: U.fo1.id })).task;
    await go('fo1', 'POST', `/api/tasks/${task.id}/accept`);
    await go('fo1', 'POST', `/api/tasks/${task.id}/start`);
    await go('ll', 'POST', `/api/tasks/${task.id}/cancel`, { reason: 'Xe hỏng giữa đường' });
    ok(W.logs({ entity: 'job', entity_id: j1.id }).some((l) => l.action === 'reopen'), 'đối chứng: hệ thống ghi "mở lại" khi chuyến bị huỷ');
    await go('l1', 'POST', `/api/hub/jobs/${j1.id}/done`, { result: {} });
    await go('l2', 'POST', `/api/hub/jobs/${j2.id}/done`, { result: {} });
    for (const d of W41.slice(1)) W.workDay(d, ['l1', 'l2']);
    W.at('2026-10-12', '09:00');
    const p = await W.perf('ll', 'logistics');
    const l1 = W.row(p, 'l1'), l2 = W.row(p, 'l2');
    eq([l1.rework, l1.quality, l1.score], [0, 100, l2.score], 'l1 không bị tính làm lại; điểm bằng l2 làm việc giống hệt');
  });

  await group('Đúng hạn của việc nhập dung lượng tính cho người nhập, không cho người nhận phiếu', async () => {
    const W = await world(kind);
    const { h, U, go } = W;
    await W.roster(['t1', 't2'], W41);
    W.workDay(W41[0], ['t1', 't2']);
    const { cards } = await cardsAtTech(W, ['SD01', 'SD02'], 't2');
    const up = h.store.jobs.find({ type: 'cards_upload' })[0];
    eq(up.assignee_id, U.t2.id, 'đối chứng: việc nhập dung lượng giao cho người nhận phiếu');
    W.workDay(W41[1], ['t1', 't2']);
    W.at('2026-10-06', '15:40'); // 30 giờ sau, quá hạn 24 giờ
    await go('t1', 'POST', '/api/hub/cards/records', { records: cards.map((c) => ({ card_id: c.id, gb: 40, shoot_date: '2026-10-04' })) });
    const done = h.store.jobs.get(up.id);
    eq([done.status, done.done_by, done.done_at > done.due_at], ['done', U.t1.id, true], 'việc đóng khi nhập đủ thẻ, người làm là người nhập');
    for (const d of W41.slice(2)) W.workDay(d, ['t1', 't2']);
    W.at('2026-10-12', '09:00');
    const p = await W.perf('tl', 'tech');
    eq([W.row(p, 't1').uploads, W.row(p, 't1').late_jobs, W.row(p, 't2').late_jobs], [2, 1, 0], 'trễ hạn tính cho t1 (người nhập), t2 không bị trừ');
  });

  await group('Việc nhập dung lượng đóng do Logistic Lead ghi mất thẻ cuối: vẫn tính cho người nhập của Tech', async () => {
    const W = await world(kind);
    const { h, U, go } = W;
    await W.roster(['t1', 't2'], W41);
    W.workDay(W41[0], ['t1', 't2']);
    const { cards } = await cardsAtTech(W, ['SD11', 'SD12'], 't2');
    const up = h.store.jobs.find({ type: 'cards_upload' })[0];
    await go('t2', 'POST', '/api/hub/cards/records', { records: [{ card_id: cards[0].id, gb: 40, shoot_date: '2026-10-04' }] });
    W.workDay(W41[1], ['t1', 't2']);
    W.at('2026-10-06', '15:40'); // 30 giờ sau, quá hạn 24 giờ
    await go('ll', 'PATCH', `/api/hub/cards/${cards[1].id}`, { status: 'lost', reason: 'Không tìm thấy thẻ ở Tech' });
    const done = h.store.jobs.get(up.id);
    eq([done.status, done.done_by, done.done_at > done.due_at], ['done', U.t2.id, true], 'việc đóng; người làm là người nhập thẻ cuối của Tech, không phải Logistic Lead');
    for (const d of W41.slice(2)) W.workDay(d, ['t1', 't2']);
    W.at('2026-10-12', '09:00');
    const p = await W.perf('tl', 'tech');
    eq([p.summary.with_due, p.summary.sla_pct, W.row(p, 't2').late_jobs, p.summary.other_points], [2, 50, 1, 0], 'trễ hạn vẫn vào tỉ lệ đúng hạn của Tech và của người nhập');
  });

  await group('Kỳ đã chốt: xếp nghỉ phép trên bảng ca không đổi chấm công đã ghi, mà đưa vào Đối chiếu', async () => {
    const W = await world(kind);
    const { h, U, go, att } = W;
    await W.roster(['t1', 't2'], W41);
    for (const d of W41) W.workDay(d, d === W41[3] ? ['t2'] : ['t1', 't2']); // t1 bị ghi vắng thứ Năm 08/10
    W.at('2026-10-12', '09:00');
    eq(att('t1', '2026-10-08').status, 'absent', 'đối chứng: t1 vắng 08/10');
    await go('tl', 'POST', '/api/hub/perf/lock', { team: 'tech', period: 'week', key: '2026-W41' });
    const r = await W.call('tl', 'PATCH', `/api/hub/attendance/${U.t1.id}/2026-10-08`, { status: 'leave', reason: 'Nghỉ phép báo muộn' });
    eq(r.status, 409, 'đối chứng: sửa chấm công trong kỳ đã chốt bị chặn');
    await go('tl', 'PUT', '/api/hub/roster', { rows: [{ user_id: U.t1.id, date: '2026-10-08', kind: 'leave', note: 'Nghỉ phép báo muộn' }] });
    eq(att('t1', '2026-10-08').status, 'absent', 'chấm công trong kỳ đã chốt giữ nguyên khi xếp nghỉ phép trên bảng ca');
    const rc = h.store.recon.find({ status: 'open', team: 'tech' }).filter((x) => x.source === 'attendance');
    ok(rc.length === 1 && rc[0].text.includes('Tech Một'), 'có dòng Đối chiếu để người có quyền quyết định sau khi mở lại kỳ');
  });

  await group('Tắt xếp loại Logistics thì Field Ops (thuộc Logistics) cũng không xếp loại', async () => {
    const W = await world(kind);
    const { U, go } = W;
    const bo = (await go('ll', 'POST', '/api/sites', BO)).site;
    await go('ll', 'PUT', '/api/hub/config', { minDaysWeek: 1 });
    W.at('2026-10-06', '10:00');
    const j = (await go('ll', 'POST', '/api/hub/jobs', { team: 'logistics', title: 'Mang phụ kiện ra BO', site_id: bo.id, assignee_id: U.l1.id, std_min: 30 })).job;
    const task = (await go('l1', 'POST', '/api/hub/dispatch', { job_ids: [j.id], fo_id: U.fo1.id })).task;
    eq((await runTrip(W, task.id)).status, 'completed', 'đối chứng: FO chạy xong chuyến');
    W.at('2026-10-12', '09:00');
    let p = await W.perf('ll', 'logistics');
    ok(p.fo.rows.find((r) => r.user.id === U.fo1.id).rated && p.fo.top3.length === 1, 'đối chứng: FO đủ ngày chạy được xếp loại khi Logistics bật xếp loại');
    await go('ll', 'PUT', '/api/hub/config', { rateLogistics: false });
    p = await W.perf('ll', 'logistics');
    const f = p.fo.rows.find((r) => r.user.id === U.fo1.id);
    eq([f.rated, f.rating, f.not_rated_reason, p.fo.top3.length], [false, null, 'Chưa xếp loại Logistics (Cài đặt)', 0], 'tắt xếp loại Logistics: FO không xếp loại, không có Top 3 FO');
    const ov = await go('ll', 'GET', '/api/hub/overview', null, { period: 'week', key: '2026-W41' });
    eq(ov.top3.logistics.fo.list.length, 0, 'tổng quan: không có Top 3 FO');
  });

  await group('Đổi phút chuẩn nhập thẻ không viết lại điểm của kỳ đã qua', async () => {
    const W = await world(kind);
    const { h, go } = W;
    await W.roster(['t1', 't2'], W41);
    W.workDay(W41[0], ['t1', 't2']);
    await W.doneJob('t1', 18);
    const { cards } = await cardsAtTech(W, ['SD01', 'SD02', 'SD03'], 't2');
    await go('t2', 'POST', '/api/hub/cards/records', { records: cards.map((c) => ({ card_id: c.id, gb: 40, shoot_date: '2026-10-04' })) });
    for (const d of W41.slice(1)) W.workDay(d, ['t1', 't2']);
    W.at('2026-10-12', '09:00');
    const upPts = (p) => W.row(p, 't2').by_type.find((x) => x.type === 'cards_upload').points;
    const w41 = async () => (await go('tl', 'GET', '/api/hub/perf/trend', null, { weeks: 4, key: '2026-W41' })).weeks.find((x) => x.key === '2026-W41').points;
    const before = await W.perf('tl', 'tech'), trendBefore = await w41();
    eq(upPts(before), 3, 'đối chứng: 3 thẻ × 6 phút chuẩn = 3 điểm nhập thẻ');
    await go('tl', 'PUT', '/api/hub/config', { jobStd: { cards_upload: 12 } });
    const after = await W.perf('tl', 'tech');
    eq([upPts(after), W.row(after, 't2').points, after.summary.points, await w41(), after.summary.daily[0].points], [3, W.row(before, 't2').points, before.summary.points, trendBefore, before.summary.daily[0].points], 'W41 giữ nguyên điểm sau khi đổi phút chuẩn (người nhập, tổng team, xu hướng, theo ngày)');
    ok(h.store.card_records.find({}).every((r) => r.std_min === 6), 'mỗi bản ghi lưu phút chuẩn lúc nhập');
  });

  await group('Cả team không có khối lượng thì không ai được xếp "Xuất sắc" hay vào Top 3', async () => {
    const W = await world(kind);
    await W.roster(['l1', 'l2'], W41);
    for (const d of W41) W.workDay(d, ['l1', 'l2']);
    W.at('2026-10-12', '09:00');
    const p = await W.perf('ll', 'logistics');
    const l1 = W.row(p, 'l1');
    eq([l1.points, l1.s_vol, l1.s_att], [0, 0, 100], 'khối lượng 0 là số thật (điểm thành phần 0), không bị bỏ như "chưa có số"');
    ok(l1.rating !== 5 && l1.score < 50, `không xếp "Xuất sắc" khi không làm việc nào (điểm ${l1.score}, mức ${l1.rating})`);
    eq(p.top3.length, 0, 'Top 3 trống khi không ai có khối lượng');
  });

  await group('Chép ca sang tuần khác: chỉ chép ca làm, không chép nghỉ phép, không chép vào ngày đã qua', async () => {
    const W = await world(kind);
    const { h, U, go, st } = W;
    const W42 = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'];
    await W.roster(['t1'], W42);
    await go('t1', 'POST', '/api/hub/roster/register', { rows: [{ date: '2026-10-16', kind: 'leave', note: 'Đám cưới' }] });
    await go('tl', 'POST', '/api/hub/roster/review', { ids: [`req:${U.t1.id}:2026-10-16`] });
    eq(h.store.roster.get(`${U.t1.id}:2026-10-16`).kind, 'leave', 'đối chứng: nghỉ phép thứ Sáu W42 đã duyệt');
    eq((await go('tl', 'POST', '/api/hub/roster/copy-week', { from_week: '2026-W42', to_week: '2026-W43', team: 'tech' })).count, 4, 'chép 4 ca làm');
    eq(h.store.roster.get(`${U.t1.id}:2026-10-23`), null, 'không chép ngày nghỉ phép sang tuần sau');
    eq(await st('tl', 'POST', '/api/hub/roster/copy-week', { from_week: '2026-W42', to_week: '2027-W30', team: 'tech' }), 400, 'không chép ra ngoài khoảng được xếp ca');
    W.at('2026-10-07', '10:00'); // thứ Tư W41
    const r = await go('tl', 'POST', '/api/hub/roster/copy-week', { from_week: '2026-W42', to_week: '2026-W41', team: 'tech' });
    eq([r.count, r.skipped_past, h.store.roster.get(`${U.t1.id}:2026-10-05`), !!h.store.roster.get(`${U.t1.id}:2026-10-08`)], [2, 2, null, true], 'chép vào tuần đang chạy: bỏ thứ Hai, thứ Ba đã qua; chép từ hôm nay');
  });

  await group('Chấm công Lead ghi trước (tăng ca) không chặn việc tự vào ca và ghi vắng', async () => {
    const W = await world(kind);
    const { h, U, go, at, seen, tickAt, att } = W;
    await W.roster(['t1', 't2'], ['2026-10-05']);
    at('2026-10-05', '07:00');
    await go('tl', 'PATCH', `/api/hub/attendance/${U.t1.id}/2026-10-05`, { ot_min: 60, reason: 'Tăng ca tối nay theo kế hoạch' });
    await go('tl', 'PATCH', `/api/hub/attendance/${U.t2.id}/2026-10-05`, { ot_min: 30, reason: 'Tăng ca tối nay theo kế hoạch' });
    ok((await go('tl', 'GET', '/api/hub/attendance')).rows.some((a) => a.user_id === U.t1.id), 'đối chứng: dòng chấm công ghi trước có trong bảng chấm công');
    at('2026-10-05', '08:25');
    seen('t1');
    eq([att('t1', '2026-10-05').status, att('t1', '2026-10-05').ot_min, h.core.hub.jobs.onShift(h.byName('t1'))], ['present', 60, true], 't1 mở ứng dụng: vào ca, giữ tăng ca Lead đã ghi, được tính trong ca');
    tickAt('2026-10-05', '10:00');
    eq([att('t1', '2026-10-05').status, att('t2', '2026-10-05').status, att('t2', '2026-10-05').ot_min], ['present', 'absent', 30], 't2 không vào ca thì vẫn bị ghi vắng (giữ tăng ca đã ghi)');
  });

  await group('Sửa chấm công: Lead không tự sửa của mình; về "đúng giờ" thì bỏ phút trễ', async () => {
    const W = await world(kind);
    const { U, go, st, at } = W;
    await W.roster(['t2'], ['2026-10-05']);
    at('2026-10-05', '10:00');
    eq(await st('tl', 'PATCH', `/api/hub/attendance/${U.tl.id}/2026-10-05`, { status: 'present', checkin: '08:00', ot_min: 720, reason: 'tự ghi' }), 403, 'Tech Lead không tự sửa chấm công / tăng ca của mình');
    eq(await st('ll', 'PATCH', `/api/hub/attendance/${U.ll.id}/2026-10-05`, { ot_min: 120, reason: 'tự ghi' }), 403, 'Logistic Lead không tự sửa chấm công của mình');
    eq(await st('ad', 'PATCH', `/api/hub/attendance/${U.tl.id}/2026-10-05`, { status: 'present', checkin: '08:00', reason: 'Quản trị xác nhận' }), 200, 'Quản trị sửa được chấm công của Lead');
    const a1 = (await go('tl', 'PATCH', `/api/hub/attendance/${U.t2.id}/2026-10-05`, { checkin: '09:00', reason: 'Quên mở ứng dụng' })).attendance;
    eq([a1.status, a1.late_min], ['late', 30], 'đối chứng: vào 09:00 → trễ 30 phút');
    const a2 = (await go('tl', 'PATCH', `/api/hub/attendance/${U.t2.id}/2026-10-05`, { status: 'present', reason: 'Đã báo trước, đi họp' })).attendance;
    eq([a2.status, a2.late_min], ['present', 0], 'đổi sang đúng giờ thì bỏ phút trễ');
    const s = (await go('tl', 'GET', '/api/hub/attendance')).summary.find((x) => x.user.id === U.t2.id);
    eq([s.present, s.late, s.late_min], [1, 0, 0], 'tổng chấm công không còn phút trễ');
  });

  await group('Chấm công tự động có nhật ký; nghỉ phép duyệt sau khi đã ghi vắng thì chấm công thành nghỉ phép', async () => {
    const W = await world(kind);
    const { U, go, at, seen, tickAt, att, logs } = W;
    await W.roster(['t1', 't2'], ['2026-10-05']);
    await W.roster(['tl'], ['2026-10-05'], { kind: 'leave', note: 'Nghỉ phép năm' });
    await W.roster(['l2'], ['2026-10-05']);
    at('2026-10-05', '08:55');
    seen('t1');
    tickAt('2026-10-05', '09:31');
    eq([att('t1', '2026-10-05').status, att('t2', '2026-10-05').status, att('tl', '2026-10-05').status, att('l2', '2026-10-05').status], ['late', 'absent', 'leave', 'absent'], 'đối chứng: vào trễ, vắng, nghỉ phép');
    const a = (u, action) => logs({ entity: 'attendance', entity_id: U[u].id, action }).length;
    eq([a('t1', 'checkin'), a('t2', 'absent'), a('tl', 'leave')], [1, 1, 1], 'mỗi lần hệ thống ghi chấm công đều có nhật ký');
    at('2026-10-05', '09:40');
    await go('ll', 'PUT', '/api/hub/roster', { rows: [{ user_id: U.l2.id, date: '2026-10-05', kind: 'leave', note: 'Gọi báo ốm' }] });
    eq(att('l2', '2026-10-05').status, 'leave', 'Lead duyệt nghỉ phép sau khi hệ thống ghi vắng → chấm công thành nghỉ phép');
    ok(a('l2', 'leave') === 1, 'có nhật ký đổi vắng thành nghỉ phép');
    at('2026-10-12', '09:00');
    const l2 = W.row(await W.perf('ll', 'logistics'), 'l2');
    eq([l2.absent, l2.leave], [0, 1], 'bảng hiệu suất: không còn ngày vắng');
  });

  await group('Điểm của team: việc Quản trị làm không bị tính là việc FO; dòng Lead không có điểm tổng hợp', async () => {
    const W = await world(kind);
    const { go } = W;
    await W.roster(['t1', 't2'], W41);
    W.workDay(W41[0], ['t1', 't2']);
    for (const team of ['logistics', 'tech']) {
      const j = (await go('ad', 'POST', '/api/hub/jobs', { team, title: 'Quản trị làm giúp', std_min: 60 })).job;
      await go('ad', 'POST', `/api/hub/jobs/${j.id}/done`, { result: {} });
    }
    await W.doneJob('t1', 60);
    for (const d of W41.slice(1)) W.workDay(d, ['t1', 't2']);
    W.at('2026-10-12', '09:00');
    const pl = await W.perf('ll', 'logistics'), pt = await W.perf('tl', 'tech');
    eq([pl.summary.fo_points, pl.summary.other_points, pl.fo.summary.points], [0, 10, 0], 'Logistics: việc Quản trị làm tách riêng, không vào "Việc FO làm qua chuyến"');
    eq([pt.summary.points, pt.summary.other_points], [10, 10], 'Tech: việc Quản trị làm hiện riêng, không mất dấu');
    const tlRow = W.row(pt, 'tl');
    eq([tlRow.score, tlRow.s_vol, tlRow.rated], [null, null, false], 'dòng Tech Lead không có điểm tổng hợp (Lead không xếp loại)');
    eq((await W.me('tl')).me.score, null, 'Hiệu suất của tôi (Lead): không có điểm tổng hợp');
  });
}

await suite('memory');
await suite('sqlite');
summary('fix.people');
