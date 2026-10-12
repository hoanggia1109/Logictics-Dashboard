// fix.salem.test.mjs — số liệu Sale / Head of Sale: giờ quay theo ngày thẻ thật sự ghi (bo_in → bo_out), chỉ xét chuẩn trên ngày đã nhập đủ thẻ,
// số kit theo lịch sử từng ngày, lịch sử tạm nghỉ, launch lại, cộng số thô rồi mới làm tròn, phân bố theo chuẩn, quota chỉ BO còn quay, onboard = ký.
// Mỗi nhóm chạy 2 lần: kho bộ nhớ và kho SQLite; sau mỗi bước chạy bộ kiểm bất biến.
import { mk, ok, eq, group, summary } from './harness.mjs';
import { checkInvariants } from './invariants.mjs';

const VN = (date, hm = '10:00') => Date.parse(`${date}T${hm}:00+07:00`);
const addD = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const localDay = (ts) => new Date(ts + 7 * 3600000).toISOString().slice(0, 10);
const GBH = 16.9;
const r1 = (x) => Math.round(Math.round(x * 1e6) / 1e5) / 10; // cùng cách gạt nhiễu dấu phẩy động với core/hub/report.js

async function world(kind, start) {
  const h = mk(kind, { t: VN(start, '07:00') });
  const U = {};
  for (const [u, role, name] of [['ad', 'admin', 'Quản trị'], ['ll', 'lead', 'Trưởng Logistics'], ['l1', 'logistic', 'Log Một'], ['tl', 'tech_lead', 'Trưởng Tech'], ['t1', 'tech', 'Tech Một'],
    ['sh', 'sale_head', 'Trưởng Sale'], ['s1', 'sale', 'Sale Một'], ['s2', 'sale', 'Sale Hai']]) U[u] = await h.user(u, role, { name });
  const go = async (who, method, path, body, query) => {
    const r = await h.call(who, method, path, body, query);
    if (r.status !== 200) throw new Error(`${who} ${method} ${path} → ${r.status} ${r.body.error}: ${r.body.message}`);
    return r.body;
  };
  const st = async (who, method, path, body, query) => (await h.call(who, method, path, body, query)).status;
  const inv = (label) => { const v = checkInvariants(h.store); ok(!v.length, `bất biến sau "${label}": ${v.join(' | ')}`); };
  const today = () => localDay(h.clock.now());
  const at = (d, hm) => h.clock.set(VN(d, hm));
  const tick = () => { h.core.tick(); h.clock.add(61000); h.core.tick(); };
  const site = (code) => h.store.sites.find({ code }, { limit: 1 })[0];
  const card = (code) => h.store.cards.find({ code }, { limit: 1 })[0];
  // Kho chỉ cần kit đủ thiết bị chính; Tech Lead tắt bước kiểm trước khi xuất để kiểm thử gọn (kit vẫn đi đúng vòng trạng thái).
  await go('tl', 'PUT', '/api/hub/config', { checkBeforeShip: false });
  let kn = 0, cn = 0;
  async function newKit() {
    const c = String(++kn).padStart(3, '0');
    await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: `MC${c}` });
    await go('ll', 'POST', '/api/hub/devices', { type: 'cm5', codes: `CM${c}` });
    return (await go('ll', 'POST', '/api/hub/kits', { code: `K${c}`, kind: 'multicam', devices: `MC${c} CM${c}` })).kit.id;
  }
  async function newCards(n) {
    const codes = [];
    for (let i = 0; i < n; i++) codes.push(`SD${String(++cn).padStart(4, '0')}`);
    await go('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: codes.join(' ') });
    return codes;
  }
  /** Sale gửi yêu cầu launch (BO mới hoặc BO có sẵn). */
  async function request(who, code, opt = {}) {
    const body = { need: { multicam: opt.kits || 1 }, launch_date: opt.launch || today() };
    if (opt.site) body.site_id = opt.site.id;
    else Object.assign(body, { outlet: { name: `BO ${code}`, code, lat: 10.78, lon: 106.69, contact: 'Chị Lan', phone: '0901000000', address: 'Quận 1' }, swap_days: opt.swap || '1,2,3,4,5,6,7', swap_from: '09:00', swap_to: '11:00' });
    return (await go(who, 'POST', '/api/hub/requests', body)).request;
  }
  /** Logistics gán kit, chuẩn bị xong, giao tay có biên bản: BO bắt đầu ghi hình. */
  async function deliver(req, n = 1) {
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(await newKit());
    await go('ll', 'POST', `/api/hub/requests/${req.id}/assign`, { kit_ids: ids });
    for (const id of ids) await go('ll', 'POST', `/api/hub/kits/${id}/submit`);
    const j = h.store.jobs.find({ type: 'deliver', request_id: req.id, status: ['open', 'doing'] })[0];
    if (!j) throw new Error('không có việc giao');
    await go('ll', 'POST', `/api/hub/jobs/${j.id}/done`, { result: { doc_code: 'BB-' + req.code } });
    return ids;
  }
  async function launch(who, code, opt = {}) { const req = await request(who, code, opt); const kits = await deliver(req, opt.kits || 1); return { req, kits, site: site(code) }; }
  /** Đổi thẻ hôm nay (việc do lịch sinh ra): n thẻ mới vào BO, thẻ đang ở BO được thu. Trả mã thẻ đã thu. */
  async function swap(code, n = 1) {
    const s = site(code);
    const j = h.store.jobs.find({ type: 'card_swap', site_id: s.id, date: today(), status: ['open', 'doing'] })[0];
    if (!j) throw new Error(`không có việc đổi thẻ ${code} ngày ${today()}`);
    const before = h.store.cards.find({ site_id: s.id, status: 'at_bo' }).map((c) => c.code);
    await go('ll', 'POST', `/api/hub/jobs/${j.id}/done`, { result: { cards_out: await newCards(n) } });
    return before;
  }
  /** Gửi Tech, Tech nhận đủ, nhập dung lượng (ngày quay để mặc định như màn hình nhập). gbOf(card) → GB. */
  async function upload(codes, gbOf) {
    if (!codes.length) return;
    const ho = (await go('l1', 'POST', '/api/hub/handovers', { dir: 'to_tech', codes })).handover;
    await go('t1', 'POST', `/api/hub/handovers/${ho.id}/receive`, { all: true });
    const records = codes.map((code) => { const c = card(code); const gb = gbOf(c); return gb ? { card_id: c.id, gb } : { card_id: c.id, gb: 0, zero_reason: 'BO không bật máy' }; });
    await go('t1', 'POST', '/api/hub/cards/records', { records });
  }
  /** Các ngày thẻ nằm ở BO: từ ngày đặt thẻ tới trước ngày thu thẻ. */
  const coverDays = (c) => { const a = localDay(c.bo_in), b = addD(localDay(c.bo_out), -1), out = []; for (let d = a; d <= (b < a ? a : b); d = addD(d, 1)) out.push(d); return out; };
  const hos = async (query, who = 'sh') => (await go(who, 'GET', '/api/hub/sale', null, query)).hos;
  const row = (hs, code) => hs.outlets.find((o) => o.code === code);
  return { h, U, go, st, inv, today, at, tick, site, card, newKit, newCards, request, deliver, launch, swap, upload, coverDays, hos, row };
}

async function suite(kind) {
  console.log(`\n── Kho ${kind === 'sqlite' ? 'SQLite' : 'bộ nhớ'} ──`);

  await group('BO quay đều: giờ/kit/ngày ổn định bất kể thứ trong tuần, nhịp đổi thẻ, độ trễ nhập; ngày chưa nhập đủ thẻ không tính 0 giờ', async () => {
    const W = await world(kind, '2026-09-14');
    const { h, at, tick, inv, swap, upload, coverDays, hos, row } = W;
    // A 5 giờ/ngày, B 4 giờ/ngày (dưới chuẩn 5), C 6 giờ/ngày đổi thứ 2 và 5; E nhập trễ một ngày; F không nhập thẻ nào.
    const P = { A: { rate: 5, swap: '1,3,5' }, B: { rate: 4, swap: '1,3,5' }, C: { rate: 6, swap: '1,4' }, E: { rate: 5, swap: '1,3,5', lag: 1 }, F: { rate: 5, swap: '1,3,5', never: true } };
    at('2026-09-14', '08:00');
    for (const [code, p] of Object.entries(P)) await W.launch('s1', code, { swap: p.swap });
    inv('launch 5 BO');
    const late = [];
    const gb = (code) => (c) => +(P[code].rate * coverDays(c).length * GBH).toFixed(2);
    const seen = { below: [], wrong: [], zero: [] };
    for (let d = '2026-09-15'; d <= '2026-10-13'; d = addD(d, 1)) {
      at(d, '07:00'); tick();
      at(d, '09:30');
      const got = {};
      for (const code of Object.keys(P)) if (h.store.jobs.count({ type: 'card_swap', site_id: W.site(code).id, date: d, status: 'open' })) got[code] = await swap(code);
      at(d, '15:00');
      for (const code of ['A', 'B', 'C']) if (got[code]) await upload(got[code], gb(code));
      for (const x of late.splice(0)) await upload(x.codes, gb('E'));
      if (got.E) late.push({ codes: got.E });
      at(d, '20:00');
      if (d >= '2026-10-05') {
        const hs = await hos({ period: 'week' });
        for (const code of Object.keys(P)) {
          const r = row(hs, code), want = P[code].never ? null : P[code].rate;
          if (r.per_kit_day !== null && r.per_kit_day !== want) seen.wrong.push(`${d} ${code} ${r.per_kit_day}`);
          if (r.prev_per_kit_day !== want) seen.wrong.push(`${d} ${code} kỳ trước ${r.prev_per_kit_day}`);
          if (r.below_std !== (r.per_kit_day !== null && r.per_kit_day < 5)) seen.wrong.push(`${d} ${code} cờ dưới chuẩn lệch số`);
          if (r.below_std && code !== 'B') seen.below.push(`${d} ${code} ${r.per_kit_day}`);
          if (r.per_kit_day === 0) seen.zero.push(`${d} ${code}`);
        }
        const rated = hs.outlets.filter((o) => o.per_kit_day !== null);
        const kd = rated.reduce((a, o) => a + o.eval_kits * o.eval_days, 0), kh = rated.reduce((a, o) => a + o.per_kit_day * o.eval_kits * o.eval_days, 0);
        if (kd && hs.kpi.per_kit_day.cur !== r1(kh / kd)) seen.wrong.push(`${d} cả team ${hs.kpi.per_kit_day.cur} ≠ ${r1(kh / kd)}`);
        if (d === '2026-10-11') {
          eq(['A', 'B', 'C', 'E'].map((c) => row(hs, c).per_kit_day), [5, 4, 6, 5], 'Chủ nhật: mỗi BO đúng nhịp quay thật (không tụt vì thẻ thứ Sáu còn ở BO)');
          eq([row(hs, 'A').below_std, row(hs, 'B').below_std], [false, true], 'Chủ nhật: BO đạt chuẩn không bị đánh dấu, BO thật sự dưới chuẩn vẫn bị đánh dấu');
        }
        if (d === '2026-10-12') eq(['A', 'B', 'C', 'E'].map((c) => row(hs, c).prev_per_kit_day), [5, 4, 6, 5], 'thứ Hai: tuần trước đúng nhịp thật (không 5,8 vì thẻ thứ Sáu dồn vào thứ Sáu)');
      }
      inv(`ngày ${d}`);
    }
    eq(seen.below, [], 'BO đạt chuẩn không bao giờ bị đánh dấu dưới chuẩn, ngày nào trong tuần cũng vậy');
    eq(seen.wrong, [], 'giờ/kit/ngày luôn là "chưa đủ số liệu" hoặc đúng nhịp thật; cờ dưới chuẩn khớp số hiển thị');
    eq(seen.zero, [], 'không có BO nào bị tính 0 giờ vì thẻ chưa nhập');
    const hs = await hos({ period: 'week' });
    eq([row(hs, 'F').per_kit_day, row(hs, 'F').below_std, row(hs, 'F').eval_days], [null, false, 0], 'BO chưa nhập thẻ nào: chưa đủ số liệu, không dưới chuẩn');
    // Tháng: giờ của thẻ vắt qua cuối tháng chia theo ngày thẻ ghi.
    const sep = await hos({ period: 'month', key: '2026-09' });
    eq([row(sep, 'A').hours, row(sep, 'C').hours], [75, 84], 'T9: A 15 ngày × 5 giờ, C 14 ngày × 6 giờ (thẻ 30/09 của A chia sang 01/10)');
    const oct = await hos({ period: 'month', key: '2026-10' });
    ok(oct.outlets.find((o) => o.code === 'A').hours >= 5 * 11, 'T10: A có cả phần 01/10 của thẻ đặt ngày 30/09');
    // Chuỗi giờ theo ngày của BO: phẳng trên những ngày thẻ đã nhập.
    const det = await W.go('sh', 'GET', `/api/hub/outlets/${W.site('A').id}`, null, { days: '21' });
    const flat = det.series.filter((x) => x.date >= '2026-09-23' && x.date <= '2026-10-11').map((x) => x.hours);
    ok(flat.length === 19 && flat.every((v) => v === 5), `chuỗi giờ theo ngày của A phẳng 5 giờ (nhận ${flat.join(',')})`);
    ok(det.series.find((x) => x.date === '2026-10-12').hours === 0, 'ngày thẻ còn ở BO: chưa có giờ');
  });

  await group('BO 2 kit: giờ/kit/ngày của tuần cũ chia theo số kit thật ở BO hôm đó, không theo số kit còn lại hôm nay', async () => {
    const W = await world(kind, '2026-09-21');
    const { at, tick, inv, swap, upload, coverDays, hos, row } = W;
    at('2026-09-21', '08:00');
    const { kits } = await W.launch('s1', 'T2', { kits: 2 });
    const gb = (c) => +(5 * coverDays(c).length * GBH).toFixed(2);
    for (let d = '2026-09-22'; d <= '2026-10-06'; d = addD(d, 1)) {
      at(d, '07:00'); tick();
      at(d, '09:30'); const got = await swap('T2', 2);
      at(d, '15:00'); await upload(got, gb);
      inv(`ngày ${d}`);
    }
    const w40 = async () => row(await hos({ period: 'week', key: '2026-W40' }), 'T2');
    eq([(await w40()).per_kit_day, (await w40()).eval_kits, (await w40()).eval_days], [5, 2, 7], 'W40 khi còn đủ 2 kit: 5 giờ/kit/ngày');
    at('2026-10-06', '16:00');
    await W.go('s1', 'POST', `/api/hub/outlets/${W.site('T2').id}/end`, {});
    inv('kết thúc');
    at('2026-10-07', '10:00'); tick();
    const rec = W.h.store.jobs.find({ type: 'recover', site_id: W.site('T2').id, status: ['open', 'doing'] })[0];
    const atBo = W.h.store.cards.find({ site_id: W.site('T2').id, status: 'at_bo' }).map((c) => c.code);
    await W.go('ll', 'POST', `/api/hub/jobs/${rec.id}/done`, { result: { kit_ids: [kits[0]] } });
    await upload(atBo, gb);
    inv('thu 1 kit');
    eq([(await w40()).per_kit_day, (await w40()).eval_kits], [5, 2], 'thu 1 kit: W40 vẫn 5 giờ/kit/ngày với 2 kit (không thành 10)');
    at('2026-10-08', '10:00'); tick();
    const rest = W.h.store.jobs.find({ type: 'recover', site_id: W.site('T2').id, status: ['open', 'doing'] })[0];
    await W.go('ll', 'POST', `/api/hub/jobs/${rest.id}/done`, {});
    inv('thu nốt kit');
    eq(W.site('T2').ops_status, 'ended', 'BO đã kết thúc');
    const after = await w40();
    eq([after.per_kit_day, after.eval_kits, after.below_std], [5, 2, false], 'BO đã kết thúc: W40 vẫn 5 giờ/kit/ngày với 2 kit (không mất xếp hạng)');
    const k41 = row(await hos({ period: 'week', key: '2026-W41' }), 'T2');
    eq([k41.per_kit_day, k41.eval_days], [5, 2], 'W41: chỉ xét 05–06/10 (ngày kết thúc là 06/10)');
  });

  await group('Launch lại BO đã kết thúc: tuần nghỉ không tính, quota tính lại từ lần launch mới, lịch sử các đợt còn nguyên', async () => {
    const W = await world(kind, '2026-09-14');
    const { h, at, tick, inv, swap, upload, coverDays, hos, row, go } = W;
    at('2026-09-14', '08:00');
    await W.launch('s1', 'R', {});
    const R = W.site('R');
    await go('sh', 'PATCH', `/api/hub/outlets/${R.id}`, { quota_hours: 30 });
    const gb = (c) => +(6 * coverDays(c).length * GBH).toFixed(2);
    for (let d = '2026-09-15'; d <= '2026-09-18'; d = addD(d, 1)) {
      at(d, '07:00'); tick();
      at(d, '09:30'); const got = await swap('R');
      at(d, '15:00'); await upload(got, gb);
    }
    at('2026-09-18', '16:00');
    await go('s1', 'POST', `/api/hub/outlets/${R.id}/end`, {});
    at('2026-09-19', '10:00'); tick();
    const left = h.store.cards.find({ site_id: R.id, status: 'at_bo' }).map((c) => c.code);
    const rj = h.store.jobs.find({ type: 'recover', site_id: R.id, status: ['open', 'doing'] })[0];
    await go('ll', 'POST', `/api/hub/jobs/${rj.id}/done`, {});
    await upload(left, gb);
    eq(W.site('R').ops_status, 'ended', 'đợt 1 kết thúc 18/09');
    inv('kết thúc đợt 1');
    at('2026-10-05', '09:00'); tick();
    const req2 = await W.request('s1', 'R', { site: W.site('R'), launch: '2026-10-08' });
    eq([W.site('R').ops_status, W.site('R').signed_date], ['planned', '2026-09-14'], 'gửi yêu cầu launch lại: ngày onboard (ký) giữ nguyên');
    inv('yêu cầu launch lại');
    at('2026-10-08', '10:00'); tick();
    await W.deliver(req2);
    inv('giao lại');
    at('2026-10-09', '07:00'); tick();
    at('2026-10-09', '20:00');
    const cur = await hos({ period: 'week' });
    const r = row(cur, 'R');
    eq([r.used_hours, r.quota_status], [0, 'ok'], 'launch lại: quota tính từ lần launch mới (0 giờ), không "sắp chạm" từ ngày đầu');
    eq([r.per_kit_day, r.below_std, r.prev_per_kit_day], [null, false, null], 'tuần launch lại: chưa có ngày đủ thẻ; tuần trước BO không ghi hình → không xét');
    eq(cur.kpi.below_std.prev, 0, 'tuần BO nghỉ không bị tính dưới chuẩn ở kỳ trước');
    ok(!(await go('sh', 'GET', '/api/hub/overview')).watch.some((x) => x.kind.startsWith('quota') && x.link === `outlet:${R.id}`), 'danh sách theo dõi không báo quota cho BO vừa launch lại');
    for (const wk of ['2026-W39', '2026-W40']) { const x = row(await hos({ period: 'week', key: wk }), 'R'); eq([x.per_kit_day, x.below_std, x.eval_days], [null, false, 0], `${wk}: BO không ghi hình → không xét chuẩn`); }
    const w38 = row(await hos({ period: 'week', key: '2026-W38' }), 'R');
    eq([w38.per_kit_day, w38.eval_days, w38.hours], [6, 4, 24], 'W38: chỉ xét 4 ngày có thẻ trong đợt ghi hình (15–18/09)');
    const det = (await go('sh', 'GET', `/api/hub/outlets/${R.id}`)).outlet;
    eq(det.periods, [{ from: '2026-09-14', to: '2026-09-18', hours: 24 }, { from: '2026-10-08', to: null, hours: 0 }], 'BO giữ lịch sử các đợt ghi hình kèm giờ quay từng đợt');
    eq([det.onboard_date, det.active_date, det.quota_from], ['2026-09-14', '2026-09-14', '2026-10-08'], 'ngày onboard, ngày active, quota tính từ lần launch gần nhất');
  });

  await group('Tạm nghỉ đã qua vẫn được trừ khi xét tuần cũ, sau khi Sale đặt lịch tạm nghỉ mới', async () => {
    const W = await world(kind, '2026-09-21');
    const { at, tick, inv, swap, upload, coverDays, hos, row, go } = W;
    at('2026-09-21', '08:00');
    await W.launch('s1', 'D', {});
    const D = W.site('D');
    const pause = (d) => d >= '2026-09-28' && d <= '2026-10-01';
    const gb = (c) => +(6 * coverDays(c).filter((d) => !pause(d)).length * GBH).toFixed(2);
    for (let d = '2026-09-22'; d <= '2026-10-05'; d = addD(d, 1)) {
      at(d, '07:00'); tick();
      if (d === '2026-09-24') await go('s1', 'PATCH', `/api/hub/outlets/${D.id}`, { pause_from: '2026-09-28', pause_to: '2026-10-01' });
      if (!pause(d)) { at(d, '09:30'); const got = await swap('D'); at(d, '15:00'); await upload(got, gb); }
      inv(`ngày ${d}`);
    }
    eq(W.site('D').ops_status, 'live', 'hết tạm nghỉ, BO ghi hình lại');
    const w40 = async () => row(await hos({ period: 'week', key: '2026-W40' }), 'D');
    eq([(await w40()).per_kit_day, (await w40()).eval_days, (await w40()).hours], [6, 3, 18], 'W40: 18 giờ / 3 ngày ghi hình = 6');
    at('2026-10-06', '10:00');
    await go('s1', 'PATCH', `/api/hub/outlets/${D.id}`, { pause_from: '2026-10-20', pause_to: '2026-10-22' });
    inv('đặt lịch tạm nghỉ mới');
    const x = await w40();
    eq([x.per_kit_day, x.eval_days, x.below_std], [6, 3, false], 'đặt lịch tạm nghỉ mới: W40 vẫn trừ 4 ngày nghỉ cũ (không thành 2,6)');
    eq(row(await hos({ period: 'week', key: '2026-W39' }), 'D').hours, 36, 'thẻ nằm qua kỳ nghỉ: giờ tính vào ngày ghi hình (27/09), không rải vào ngày nghỉ');
    eq(W.site('D').pauses, [['2026-09-28', '2026-10-01']], 'lịch tạm nghỉ cũ được lưu lại');
  });

  await group('Tổng giờ: cộng số thô rồi mới làm tròn — Tổng quan, Sale, Head of Sale cùng một số', async () => {
    const W = await world(kind, '2026-10-05');
    const { at, tick, inv, swap, upload, go } = W;
    at('2026-10-05', '08:00');
    for (const c of ['X1', 'X2', 'X3']) await W.launch('s1', c, {});
    at('2026-10-06', '07:00'); tick(); at('2026-10-06', '09:30');
    for (const c of ['X1', 'X2', 'X3']) await swap(c);
    at('2026-10-07', '07:00'); tick(); at('2026-10-07', '09:30');
    const got = [];
    for (const c of ['X1', 'X2', 'X3']) got.push(...(await swap(c)));
    await upload(got, () => 17.58); // 1,04 giờ mỗi thẻ
    inv('nhập 3 thẻ');
    at('2026-10-08', '20:00');
    const ov = await go('sh', 'GET', '/api/hub/overview');
    const sale = await go('sh', 'GET', '/api/hub/sale');
    eq([ov.kpi.hours.cur, ov.sale.totals.hours, sale.totals.hours, sale.hos.kpi.hours.cur], [3.1, 3.1, 3.1, 3.1], 'cùng một tổng 3,1 giờ ở Tổng quan, bảng Sale và Head of Sale');
    eq([ov.sale.by_sale[0].hours, sale.hos.by_sale.find((x) => x.sale.id === W.U.s1.id).hours], [3.1, 3.1], 'theo Sale Lead cũng 3,1 giờ');
  });

  await group('Phân bố giờ/kit/ngày: mốc theo chuẩn, không chồng nhau, cùng một giá trị với cờ dưới chuẩn', async () => {
    const W = await world(kind, '2026-10-05');
    const { at, tick, inv, swap, upload, go, hos, row } = W;
    const RATE = { G1: 2.7, G2: 3.5, G3: 6, G4: 4.96 };
    at('2026-10-05', '08:00');
    for (const c of Object.keys(RATE)) await W.launch('s1', c, {});
    at('2026-10-06', '07:00'); tick(); at('2026-10-06', '09:30');
    for (const c of Object.keys(RATE)) await swap(c);
    at('2026-10-07', '07:00'); tick(); at('2026-10-07', '09:30');
    for (const c of Object.keys(RATE)) await upload(await swap(c), () => +(RATE[c] * GBH).toFixed(2));
    inv('nhập thẻ');
    at('2026-10-08', '20:00');
    const want = { 5: 2, 3: 1, 2.5: 0, 1.8: 0 };
    for (const std of [5, 2.5, 3, 1.8]) {
      await go('sh', 'PUT', '/api/hub/config', { dailyStdHours: std });
      const hs = await hos({ period: 'week' });
      const dist = hs.distribution, rated = hs.outlets.filter((o) => o.per_kit_day !== null);
      eq(rated.length, 4, `chuẩn ${std}: 4 BO được xét`);
      eq(dist.reduce((a, x) => a + x.count, 0), 4, `chuẩn ${std}: tổng các cột phân bố = số BO được xét`);
      eq(dist.filter((x) => !x.ok).reduce((a, x) => a + x.count, 0), hs.kpi.below_std.count, `chuẩn ${std}: cột dưới chuẩn = số BO dưới chuẩn`);
      eq(hs.kpi.below_std.count, want[std], `chuẩn ${std}: số BO dưới chuẩn`);
      ok(rated.every((o) => o.below_std === o.per_kit_day < std), `chuẩn ${std}: cờ dưới chuẩn khớp số hiển thị`);
      ok(dist.every((x, i) => !i || x.from > dist[i - 1].from) && dist[dist.length - 1].label === `≥${String(std).replace('.', ',')} giờ` && dist.some((x) => x.ok && x.from === std), `chuẩn ${std}: mốc tăng dần, mốc chuẩn là ranh giới (${dist.map((x) => x.label).join(' | ')})`);
    }
    await go('sh', 'PUT', '/api/hub/config', { dailyStdHours: 5 });
    const hs = await hos({ period: 'week' });
    eq([row(hs, 'G4').per_kit_day, row(hs, 'G4').below_std], [5, false], '4,96 giờ hiển thị 5,0 thì không bị tính dưới chuẩn 5');
    eq(hs.below_list.map((o) => o.code), ['G1', 'G2'], 'danh sách dưới chuẩn khớp cờ');
  });

  await group('Quota: chỉ tính BO còn ghi hình; 99,96% là "sắp chạm", giống danh sách theo dõi', async () => {
    const W = await world(kind, '2026-09-21');
    const { h, at, tick, inv, swap, upload, go, hos, row } = W;
    const USED = { QE: 120, QE2: 83, QF: 99.96 };
    at('2026-09-21', '08:00');
    for (const c of Object.keys(USED)) await W.launch('s1', c, {});
    at('2026-09-22', '07:00'); tick(); at('2026-09-22', '09:30');
    for (const c of Object.keys(USED)) await swap(c);
    at('2026-09-23', '07:00'); tick(); at('2026-09-23', '09:30');
    for (const c of Object.keys(USED)) await upload(await swap(c), () => +(USED[c] * GBH).toFixed(2));
    for (const c of Object.keys(USED)) await go('sh', 'PATCH', `/api/hub/outlets/${W.site(c).id}`, { quota_hours: 100 });
    at('2026-09-23', '16:00');
    for (const c of ['QE', 'QE2']) await go('s1', 'POST', `/api/hub/outlets/${W.site(c).id}/end`, {});
    at('2026-09-24', '07:00'); tick(); at('2026-09-24', '10:00');
    for (const c of ['QE', 'QE2']) {
      const s = W.site(c), left = h.store.cards.find({ site_id: s.id, status: 'at_bo' }).map((x) => x.code);
      await go('ll', 'POST', `/api/hub/jobs/${h.store.jobs.find({ type: 'recover', site_id: s.id, status: ['open', 'doing'] })[0].id}/done`, {});
      await upload(left, () => 0);
    }
    await upload(await swap('QF'), () => 0);
    inv('2 BO kết thúc, 1 BO còn quay');
    at('2026-09-25', '20:00');
    const hs = await hos({ period: 'week' });
    eq([row(hs, 'QE').bucket, row(hs, 'QE2').bucket], ['ended', 'ended'], 'QE, QE2 đã kết thúc');
    eq([row(hs, 'QE').quota_status, row(hs, 'QE2').quota_status], [null, null], 'BO đã kết thúc không còn mức quota');
    eq(row(hs, 'QF').quota_status, 'near', 'BO còn quay dùng 99,96/100 giờ: "sắp chạm", không làm tròn thành vượt');
    eq([hs.kpi.quota.with_quota, hs.kpi.quota.near, hs.kpi.quota.over], [1, 1, 0], 'ô quota chỉ đếm BO còn ghi hình');
    const s1 = hs.by_sale.find((x) => x.sale.id === W.U.s1.id);
    eq([s1.near_quota, s1.over_quota], [1, 0], 'theo Sale Lead: chỉ BO còn ghi hình');
    eq(hs.quota_list.map((o) => o.code), ['QF'], 'danh sách quota chỉ có BO còn ghi hình');
    const watch = (await go('sh', 'GET', '/api/hub/overview')).watch.filter((x) => x.kind.startsWith('quota'));
    eq(watch.map((x) => x.kind), ['quota_near'], 'danh sách theo dõi cùng mức "sắp chạm"');
    const wk = (await go('sh', 'GET', '/api/hub/outlets', null, { metrics: '1' })).outlets.find((o) => o.code === 'QF');
    eq(wk.week.quota_status, 'near', 'màn hình BO cùng mức "sắp chạm"');
  });

  await group('Onboard = BO đã ký (yêu cầu launch đầu tiên không huỷ): ghi cho Sale Lead gửi, theo tháng gửi, không đổi khi giao lại BO', async () => {
    const W = await world(kind, '2026-09-14');
    const { h, at, tick, inv, go, hos, row, U } = W;
    at('2026-09-14', '08:00');
    const r1q = await W.request('s1', 'O1', { launch: '2026-09-16' });
    at('2026-09-16', '09:00'); tick();
    await W.deliver(r1q);
    inv('O1 active');
    at('2026-10-01', '09:00'); tick();
    const rx = await W.request('s2', 'X', { launch: '2026-10-20' });
    eq(W.site('X').signed_date, '2026-10-01', 'gửi yêu cầu launch: BO tính là đã ký (onboard)');
    at('2026-10-02', '09:00');
    await go('s2', 'POST', `/api/hub/requests/${rx.id}/cancel`, { reason: 'Khách đổi ý, chưa ký' });
    eq([W.site('X').signed_date, W.site('X').signed_by], [null, null], 'huỷ yêu cầu đầu tiên trước khi có máy: không còn tính onboard');
    at('2026-10-03', '09:00');
    const ry = await W.request('s2', 'Y', { launch: '2026-10-20' });
    await go('s2', 'POST', `/api/hub/requests/${ry.id}/cancel`, { reason: 'Khách đổi ý, chưa ký' });
    inv('huỷ yêu cầu');
    at('2026-10-05', '09:00'); tick();
    await go('sh', 'PATCH', `/api/hub/outlets/${W.site('O1').id}`, { sale_id: U.s2.id });
    for (const [d, c] of [['2026-10-05', 'O2'], ['2026-10-06', 'O3'], ['2026-10-07', 'O4']]) { at(d, '10:00'); await W.request('s2', c, { launch: '2026-10-20' }); }
    await W.request('s2', 'X', { site: W.site('X'), launch: '2026-10-21' });
    inv('s2 gửi 4 yêu cầu');
    at('2026-10-08', '20:00');
    const sep = await hos({ period: 'month', key: '2026-09' });
    eq(sep.kpi.onboard.cur, 1, 'T9: 1 BO onboard');
    eq(sep.onboard_by_month.find((m) => m.key === '2026-09').by_sale, { [U.s1.id]: 1 }, 'T9 vẫn ghi cho s1 sau khi BO giao cho s2');
    const s1row = sep.by_sale.find((x) => x.sale.id === U.s1.id);
    ok(s1row && s1row.onboard_cur === 1, 's1 vẫn có dòng và 1 BO onboard trong T9 dù không còn BO nào');
    eq((await hos({ period: 'month', key: '2026-09' }, 's1')).kpi.onboard.cur, 1, 's1 tự xem T9: vẫn 1 BO onboard');
    const oct = await hos({ period: 'month', key: '2026-10' });
    eq(oct.kpi.onboard.cur, 4, 'T10: s2 ký 4 BO (O2, O3, O4, X), Y đã huỷ không tính');
    const s2row = oct.by_sale.find((x) => x.sale.id === U.s2.id);
    eq([s2row.onboard_cur, s2row.waiting], [4, 4], 's2: 4 BO onboard trong T10, 4 BO chờ active');
    eq(oct.onboard_by_month.find((m) => m.key === '2026-10').by_sale, { [U.s2.id]: 4 }, 'biểu đồ T10: 4 BO của s2');
    eq(oct.kpi.waiting, 4, '4 BO chờ active');
    eq([row(oct, 'O1').onboard_date, row(oct, 'O1').active_date, row(oct, 'O2').onboard_date, row(oct, 'O2').active_date, W.site('X').signed_date], ['2026-09-14', '2026-09-16', '2026-10-05', null, '2026-10-07'], 'ngày onboard (ký) và ngày active tách riêng');
    eq([sep.kpi.activated.cur, oct.kpi.activated.cur, oct.kpi.active_now], [1, 0, 1], 'active: lần đầu có máy; đang active = đang ghi hình hoặc tạm nghỉ');
    eq((await hos({ period: 'month', key: '2026-08' })).kpi.onboard_month.key, '2026-08', 'xem T8: ô tháng theo T8, không theo tháng hiện tại');
    eq((await hos({ period: 'week' })).kpi.onboard_month.key, '2026-10', 'xem tuần: ô tháng theo tháng của tuần');
    // Dữ liệu cũ chưa có ngày ký: khởi động lại thì điền từ yêu cầu launch đầu tiên không huỷ.
    h.store.sites.update(W.site('O1').id, { signed_date: null, signed_by: null });
    h.store.sites.update(W.site('X').id, { signed_date: null, signed_by: null });
    const h2 = mk(kind, { store: h.store, t: h.clock.now() });
    const s = (code) => h2.store.sites.find({ code }, { limit: 1 })[0];
    eq([s('O1').signed_date, s('O1').signed_by, s('X').signed_date, s('X').signed_by], ['2026-09-14', U.s1.id, '2026-10-07', U.s2.id], 'khởi động lại: điền ngày ký và người ký từ yêu cầu launch đầu tiên không huỷ');
    ok(h2.store.hub_log.count({ entity: 'outlet', action: 'backfill' }) === 1, 'việc điền bù có ghi nhật ký');
    const v = checkInvariants(h2.store); ok(!v.length, `bất biến sau khởi động lại: ${v.join(' | ')}`);
  });

  await group('Thẻ mất / hỏng ngay tại BO: chỉ những ngày thẻ đó ghi là chưa đủ dữ liệu, các tuần sau vẫn xét chuẩn', async () => {
    const W = await world(kind, '2026-09-21');
    const { h, at, tick, inv, swap, upload, coverDays, hos, row, go } = W;
    at('2026-09-21', '08:00');
    await W.launch('s1', 'A', { swap: '1,3,5' });
    await W.launch('s1', 'B', { swap: '1,3,5' });
    const RATE = { A: 5, B: 3 }; // B thật sự dưới chuẩn 5
    const lost = {}, lostAt = {};
    for (let d = '2026-09-22'; d <= '2026-10-16'; d = addD(d, 1)) {
      at(d, '07:00'); tick();
      for (const code of ['A', 'B']) {
        at(d, '09:30');
        const got = h.store.jobs.count({ type: 'card_swap', site_id: W.site(code).id, date: d, status: 'open' }) ? await swap(code) : null;
        at(d, '15:00');
        if (got) await upload(got, (c) => +(RATE[code] * coverDays(c).length * GBH).toFixed(2));
      }
      // Thẻ đang ở BO B được Lead ghi là mất (23/09) và hỏng (07/10): thẻ không có ngày thu, không có bản ghi.
      for (const [day, status] of [['2026-09-23', 'lost'], ['2026-10-07', 'bad']]) if (d === day) {
        const c = h.store.cards.find({ site_id: W.site('B').id, status: 'at_bo' })[0];
        await go('ll', 'PATCH', `/api/hub/cards/${c.id}`, { status, reason: status === 'lost' ? 'BO làm mất thẻ' : 'Thẻ hỏng, không đọc được' });
        lost[status] = c.code; lostAt[status] = h.clock.now();
      }
      inv(`ngày ${d}`);
    }
    // Vòng thẻ nhớ ghi lúc thẻ rời BO (bo_out) khi Lead đổi trạng thái tại BO: đó là lúc ghi mất / hỏng, không phải một lần thu thẻ.
    eq([W.card(lost.lost).status, W.card(lost.lost).bo_out, W.card(lost.bad).status, W.card(lost.bad).bo_out], ['lost', lostAt.lost, 'bad', lostAt.bad], 'thẻ mất / hỏng ngay tại BO: không có lần thu, rời BO lúc ghi mất / hỏng');
    at('2026-10-16', '20:00');
    for (const key of ['2026-W40', '2026-W41', '2026-W42']) {
      const hs = await hos({ period: 'week', key }), b = row(hs, 'B');
      ok(b.eval_days > 0 && b.per_kit_day === 3 && b.below_std, `${key}: B vẫn được xét (3 giờ/kit/ngày, dưới chuẩn) dù có thẻ mất / hỏng trước đó — nhận ${b.per_kit_day}, ${b.eval_days} ngày`);
      ok(hs.kpi.below_std.count === 1 && hs.kpi.below_std.rated === 2, `${key}: ô dưới chuẩn đếm B (${JSON.stringify(hs.kpi.below_std)})`);
    }
    const w39 = await hos({ period: 'week', key: '2026-W39' }), w41 = await hos({ period: 'week', key: '2026-W41' });
    eq([row(w39, 'B').per_kit_day, row(w39, 'A').eval_days - row(w39, 'B').eval_days], [3, 2], 'W39: hai ngày thẻ mất nằm ở BO (23–24/09) là chưa đủ dữ liệu, các ngày khác vẫn xét');
    eq(row(w39, 'A').eval_days - row(w39, 'B').eval_days, 2, 'W39: chỉ trừ đúng 2 ngày của thẻ mất');
    eq(row(w41, 'A').eval_days - row(w41, 'B').eval_days, 2, 'W41: chỉ trừ đúng 2 ngày của thẻ hỏng (07–08/10)');
    // Biểu đồ: chuỗi 12 tuần và 12 tháng cùng số với bảng của từng kỳ.
    const sale = await go('sh', 'GET', '/api/hub/sale');
    for (const key of ['2026-W39', '2026-W40', '2026-W41']) eq(sale.trend.find((x) => x.key === key).hours, (await hos({ period: 'week', key })).kpi.hours.cur, `xu hướng tuần ${key} cùng số với bảng tuần`);
    eq(sale.hos.onboard_by_month.find((m) => m.key === '2026-09').hours, (await hos({ period: 'month', key: '2026-09' })).kpi.hours.cur, 'biểu đồ tháng 9 cùng số với bảng tháng');
    const ov = await go('ad', 'GET', '/api/hub/overview');
    eq(ov.trend.find((x) => x.key === '2026-W40').hours, (await hos({ period: 'week', key: '2026-W40' })).kpi.hours.cur, 'xu hướng ở Tổng quan cùng số với bảng tuần');
  });

  await group('Tech sửa nhầm ngày quay rồi sửa lại: giờ của thẻ trở về đúng các ngày thẻ ghi', async () => {
    const W = await world(kind, '2026-09-28');
    const { h, at, tick, inv, swap, upload, coverDays, hos, row, go } = W;
    at('2026-09-28', '08:00');
    await W.launch('s1', 'A', { swap: '1,3,5' });
    for (let d = '2026-09-29'; d <= '2026-10-12'; d = addD(d, 1)) {
      at(d, '07:00'); tick(); at(d, '09:30');
      const got = h.store.jobs.count({ type: 'card_swap', site_id: W.site('A').id, date: d, status: 'open' }) ? await swap('A') : null;
      at(d, '15:00');
      if (got) await upload(got, (c) => +(5 * coverDays(c).length * GBH).toFixed(2));
    }
    const r = h.store.card_records.find({ site_id: W.site('A').id, shoot_date: '2026-09-30' })[0];
    eq([r.cover_to, r.hours], ['2026-10-01', 10], 'thẻ đặt 30/09, thu 02/10: ghi 30/09–01/10, 10 giờ');
    await go('tl', 'PATCH', `/api/hub/cards/records/${r.id}`, { shoot_date: '2026-10-06' });
    await go('tl', 'PATCH', `/api/hub/cards/records/${r.id}`, { shoot_date: '2026-09-30' });
    inv('sửa ngày quay');
    eq([h.store.card_records.get(r.id).shoot_date, h.store.card_records.get(r.id).cover_to], ['2026-09-30', '2026-10-01'], 'sửa lại ngày quay: khoảng thẻ ghi trở về 30/09–01/10');
    at('2026-10-12', '20:00');
    for (const key of ['2026-W40', '2026-W41']) { const x = row(await hos({ period: 'week', key }), 'A'); eq([x.per_kit_day, x.below_std], [5, false], `${key}: vẫn 5 giờ/kit/ngày, không bị đánh dấu dưới chuẩn`); }
  });

  await group('Dữ liệu cũ (bản ghi chưa có khoảng ngày ghi, nhật ký kit chưa ghi BO) và lịch sử nhập từ file: không thổi phồng giờ/kit/ngày', async () => {
    const W = await world(kind, '2026-09-21');
    const { h, at, tick, inv, swap, upload, coverDays, hos, row, go } = W;
    at('2026-09-21', '08:00');
    await W.launch('s1', 'L', { swap: '1,3,5' });
    const { kits } = await W.launch('s1', 'M', { kits: 2 });
    for (let d = '2026-09-22'; d <= '2026-10-06'; d = addD(d, 1)) {
      at(d, '07:00'); tick();
      for (const [code, n] of [['L', 1], ['M', 2]]) {
        at(d, '09:30');
        const got = h.store.jobs.count({ type: 'card_swap', site_id: W.site(code).id, date: d, status: 'open' }) ? await swap(code, n) : null;
        at(d, '15:00');
        if (got) await upload(got, (c) => +(5 * coverDays(c).length * GBH).toFixed(2));
      }
    }
    at('2026-10-06', '16:00');
    await go('s1', 'POST', `/api/hub/outlets/${W.site('M').id}/end`, {});
    at('2026-10-07', '10:00'); tick();
    const left = h.store.cards.find({ site_id: W.site('M').id, status: 'at_bo' }).map((c) => c.code);
    await go('ll', 'POST', `/api/hub/jobs/${h.store.jobs.find({ type: 'recover', site_id: W.site('M').id, status: ['open', 'doing'] })[0].id}/done`, { result: { kit_ids: [kits[0]] } });
    await upload(left, (c) => +(5 * coverDays(c).length * GBH).toFixed(2));
    inv('thu 1 kit của M');
    const w40 = async (hh = W) => { const hs = (await hh.go('sh', 'GET', '/api/hub/sale', null, { period: 'week', key: '2026-W40' })).hos; return ['L', 'M'].map((c) => { const x = hs.outlets.find((o) => o.code === c); return [x.per_kit_day, x.eval_kits]; }); };
    eq(await w40(), [[5, 1], [5, 2]], 'W40: L 5 giờ/kit/ngày, M 5 giờ/kit/ngày với 2 kit');
    // Giả lập dữ liệu trước bản sửa: bản ghi chưa có cover_to, nhật ký kit chưa ghi BO.
    const before = new Map(h.store.card_records.find({}).map((r) => [r.id, r.cover_to]));
    for (const id of before.keys()) h.store.card_records.update(id, { cover_to: null });
    for (const l of h.store.hub_log.find({ entity: 'kit', action: 'status' })) { const { site_id, ...rest } = l.data || {}; h.store.hub_log.update(l.id, { data: rest }); }
    const legacy = await w40();
    ok(legacy.every(([v]) => v === null || v === 5), `dữ liệu cũ chưa điền: chưa đủ dữ liệu hoặc đúng 5, không thổi phồng (nhận ${JSON.stringify(legacy)})`);
    // Khởi động lại: điền khoảng ngày ghi cho bản ghi cũ (có ghi nhật ký); BO của kit đã rời đi lấy từ việc thu hồi.
    const h2 = mk(kind, { store: h.store, t: h.clock.now() });
    const go2 = async (who, method, path, body, query) => { const r = await h2.call(who, method, path, body, query); if (r.status !== 200) throw new Error(`${path} → ${r.status} ${r.body.message}`); return r.body; };
    const diff = [...before].filter(([id, c]) => h2.store.card_records.get(id).cover_to !== c);
    eq(diff.length, 0, `khởi động lại: khoảng ngày ghi của bản ghi cũ điền lại đúng như lúc nhập (${diff.length}/${before.size} lệch)`);
    ok(h2.store.hub_log.count({ entity: 'card', action: 'backfill' }) === 1, 'việc điền khoảng ngày ghi có ghi nhật ký');
    eq(await w40({ go: go2 }), [[5, 1], [5, 2]], 'sau khi điền: W40 lại đúng 5 giờ/kit/ngày, M vẫn 2 kit (kit đã thu về tính cho BO từ việc thu hồi)');
    const v = checkInvariants(h2.store); ok(!v.length, `bất biến sau khởi động lại: ${v.join(' | ')}`);
    // Lịch sử nhập từ file (chỉ có ngày quay): giờ của thẻ chia tới lần đổi thẻ kế tiếp của BO; dòng cuối không rõ thì không xét chuẩn.
    h2.clock.set(VN('2026-10-08', '09:00'));
    await go2('ll', 'POST', '/api/hub/outlets', { name: 'BO IM', code: 'IM', lat: 10.78, lon: 106.69, contact: 'Chị Lan', phone: '0901000000', address: 'Quận 1', swap_days: '1,3,5', swap_from: '09:00', swap_to: '11:00' }).catch(() => null);
    const im = h2.store.sites.find({ code: 'IM' }, { limit: 1 })[0];
    ok(!!im, 'tạo BO IM');
    const csv = Buffer.from('Mã thẻ;BO;Ngày quay;Giờ quay\nSDX1;IM;2026-09-21;10\nSDX2;IM;2026-09-23;10\nSDX3;IM;2026-09-25;15\nSDX4;IM;2026-09-28;10\n', 'utf8').toString('base64');
    // Lịch sử dung lượng thẻ là số của Tech: Tech Lead nhập (phân quyền nhập file).
    const parsed = await go2('tl', 'POST', '/api/hub/import/parse', { data: csv, name: 'gio.csv' });
    eq(parsed.sheets[0].guess.target, 'records', 'đoán đúng sheet dung lượng thẻ');
    await go2('tl', 'POST', '/api/hub/import/run', { token: parsed.token, plan: parsed.sheets.map((s) => ({ sheet: s.index, target: 'records', header_row: s.header_row, mapping: s.guess.mapping })), commit: true });
    const recs = h2.store.card_records.find({ site_id: im.id }, { order: 'shoot_date' });
    eq(recs.map((r) => r.cover_to), ['2026-09-22', '2026-09-24', '2026-09-27', null], 'nhập từ file: thẻ ghi tới hôm trước lần đổi thẻ kế tiếp; dòng cuối chưa rõ');
    const series = (await go2('sh', 'GET', `/api/hub/outlets/${im.id}`, null, { days: '21' })).series.filter((x) => x.date >= '2026-09-21' && x.date <= '2026-09-28').map((x) => x.hours);
    eq(series, [5, 5, 5, 5, 5, 5, 5, 10], 'chuỗi giờ theo ngày của lịch sử nhập: 5 giờ mỗi ngày, dòng cuối vào ngày quay');
  });
}

await suite('memory');
await suite('sqlite');
summary('fix.salem');
