// hub.demo.test.mjs — dữ liệu mẫu Ops Hub (seedDemo + seedHubDemo) trên cả hai kho: bất biến sạch, mọi dashboard có số tuần này / tuần trước, tháng này / tháng trước.
// Chạy: node --disable-warning=ExperimentalWarning test/hub.demo.test.mjs   (HUB_DEMO_SCALE=0.5 để chạy nhỏ hơn)
import { mk, ok, eq, group, summary } from './harness.mjs';
import { checkInvariants } from './invariants.mjs';
import { seedDemo } from '../core/demo.js';
import { seedHubDemo } from '../core/hub/demo.js';
import { periodOf, compareOf } from '../core/hub/period.js';

const END = Date.parse('2026-10-08T09:00:00Z'); // Thứ Năm 08/10/2026, 16:00 giờ Việt Nam
const SCALE = Number(process.env.HUB_DEMO_SCALE) || 1;
const countBy = (rows, k) => rows.reduce((a, r) => { a[r[k]] = (a[r[k]] || 0) + 1; return a; }, {});

for (const kind of ['memory', 'sqlite']) {
  await group(`Dữ liệu mẫu Ops Hub, tỉ lệ ${SCALE} (${kind})`, async () => {
    const h = mk(kind, { t: END, cfg: { demo: true } });
    eq(await seedDemo(h.core), true, 'seedDemo tạo dữ liệu Rider Live');
    const st = await seedHubDemo(h.core, { setNow: (t) => h.clock.set(t ?? END), scale: SCALE });
    ok(st && typeof st === 'object', 'seedHubDemo trả về số liệu lần tạo');
    if (!st) return;
    console.log(`    ${kind}: ${st.ms} ms, ${st.calls} lệnh API, ${st.ticks} lần tick, ${st.trips} chuyến FO, ${st.days} ngày (${st.from} → ${st.to})`);
    const missN = Object.values(st.misses).reduce((a, b) => a + b, 0);
    if (missN) console.log('    lệnh bị từ chối:', JSON.stringify(st.misses));
    eq(st.errors, [], 'không có lỗi ngoài dự kiến khi tạo');
    ok(missN <= st.calls * 0.02, `lệnh bị từ chối ít (${missN} / ${st.calls})`);
    eq(h.clock.now(), END, 'đồng hồ trả về giờ thật sau khi tạo');
    eq(await seedHubDemo(h.core, { setNow: (t) => h.clock.set(t ?? END) }), false, 'gọi lần 2 không tạo trùng');
    eq(checkInvariants(h.store), [], 'bất biến của kho sạch');
    const S = h.store;
    console.log('    BO:', JSON.stringify(countBy(S.sites.find({ type: 'bo', active: 1 }), 'ops_status')), ' kit:', JSON.stringify(countBy(S.kits.find({}), 'status')));
    console.log('    việc mở:', JSON.stringify(countBy(S.jobs.find({ status: ['open', 'doing'] }), 'team')), ' sự cố:', S.incidents.count({}), `(mở ${S.incidents.count({ status: ['open', 'ack'] })})`, ' bản ghi thẻ:', S.card_records.count({}), ' thẻ:', JSON.stringify(countBy(S.cards.find({}), 'status')));

    // Tổng quan: xu hướng 12 tuần có số, tuần này / tuần trước đều có giờ quay.
    for (const who of ['lead', 'techlead', 'admin']) {
      for (const period of ['week', 'month']) {
        const r = await h.call(who, 'GET', '/api/hub/overview', null, { period });
        eq(r.status, 200, `tổng quan ${period} (${who})`);
        const o = r.body;
        ok(o.kpi.hours.cur > 0 && o.kpi.hours.prev > 0, `tổng quan ${period} (${who}): giờ quay kỳ này ${o.kpi.hours.cur}, kỳ trước ${o.kpi.hours.prev}`);
        ok(o.kpi.cards.cur > 0 && o.kpi.cards.prev > 0, `tổng quan ${period} (${who}): thẻ kỳ này / kỳ trước`);
        ok(o.trend.length === 12 && o.trend.filter((w) => w.hours > 0).length >= 7 && o.trend.filter((w) => w.incidents > 0).length >= 7, `tổng quan ${period} (${who}): xu hướng 12 tuần có số`);
        ok(o.trend.filter((w) => w.tech_points > 0 && w.log_points > 0).length >= 7, `tổng quan ${period} (${who}): điểm hai team theo tuần`);
        ok(o.incidents_top.length >= 5, `tổng quan ${period} (${who}): top lỗi ≥ 5 nhãn (${o.incidents_top.length})`);
        ok(o.kpi.queue.tech && o.kpi.queue.logistics, `tổng quan ${period} (${who}): hàng việc hai team`);
        if (who === 'admin') ok(o.top3.tech && o.top3.tech.list.length >= 2 && o.top3.logistics && o.top3.logistics.list.length >= 2, `tổng quan ${period}: top người làm tốt của cả hai team`);
        if (who === 'lead') ok(o.top3.logistics && o.top3.logistics.list.length >= 2 && !o.top3.tech, `tổng quan ${period}: Logistic Lead chỉ thấy top của team mình`);
        if (who === 'techlead') ok(o.top3.tech && o.top3.tech.list.length >= 2 && !o.top3.logistics, `tổng quan ${period}: Tech Lead chỉ thấy top của team mình`);
      }
    }
    const ov = (await h.call('lead', 'GET', '/api/hub/overview')).body;
    ok(ov.kpi.queue.logistics.overdue > 0 || ov.kpi.queue.tech.overdue > 0, 'có việc trễ hạn hôm nay');
    // Việc để cho cả đội được giao ngay cho người đang trong ca (không treo ở "chưa ai nhận" khi team có người trong ca); việc đổi thẻ của ngày sau chờ sẵn chưa ai nhận.
    const fin = S.jobs.find({ title: ['Sắp xếp lại kệ kit sẵn sàng theo mã', 'Cập nhật firmware cho lô CM5 mới nhập'] });
    ok(fin.length === 2 && fin.every((j) => j.assignee_id && j.assign_by === 'auto' && h.core.hub.jobs.onShift(S.users.get(j.assignee_id))), 'việc Lead để cho cả đội: hệ thống giao cho người đang trong ca');
    ok(S.jobs.count({ team: 'logistics', type: 'card_swap', assignee_id: null, status: 'open', show_date: { gt: st.to } }) > 0, 'việc đổi thẻ của ngày sau chờ sẵn, chưa ai nhận');
    ok(ov.kpi.queue.logistics.blocked > 0 && ov.kpi.queue.tech.blocked > 0, 'mỗi team có việc đang vướng');
    ok(ov.kpi.incidents.open > 0, 'có sự cố đang mở');
    ok(ov.kpi.recon.open > 0, 'có dòng đối chiếu chờ xử lý');
    ok(ov.incidents_spikes.length >= 1, `có lỗi tăng vọt tuần này (${ov.incidents_spikes.map((x) => x.label).join(', ')})`);

    // Bảng Sale: Head of Sale thấy mọi BO, Sale thấy BO của mình; tuần / tháng đều có số.
    for (const who of ['salehead', 'sale']) {
      for (const period of ['week', 'month']) {
        const r = await h.call(who, 'GET', '/api/hub/sale', null, { period });
        eq(r.status, 200, `bảng Sale ${period} (${who})`);
        const b = r.body, k = b.hos.kpi;
        ok(b.totals.hours > 0 && b.totals.prev_hours > 0, `bảng Sale ${period} (${who}): giờ quay kỳ này ${b.totals.hours}, kỳ trước ${b.totals.prev_hours}`);
        ok(b.trend.filter((w) => w.hours > 0).length >= 6, `bảng Sale ${period} (${who}): xu hướng theo tuần có số`);
        ok(k.per_kit_day.cur > 0 && k.per_kit_day.prev > 0, `bảng Sale ${period} (${who}): giờ / kit / ngày kỳ này ${k.per_kit_day.cur}, kỳ trước ${k.per_kit_day.prev}`);
        ok(k.onboard_month.cur + k.onboard_month.prev > 0, `bảng Sale ${period} (${who}): onboard tháng này / tháng trước`);
        if (who === 'salehead') {
          ok(b.hos.by_sale.filter((x) => x.sale.id).length >= 3, `bảng Sale ${period}: đủ 3 Sale Lead`);
          for (const s of ['prospect', 'waiting', 'live', 'paused', 'ending', 'ended']) ok(k[s] > 0, `bảng Sale ${period}: có BO ở nhóm ${s} (${k[s]})`);
          ok(k.quota.near >= 1 && k.quota.over >= 1, `bảng Sale ${period}: có BO sát / vượt quota (sát ${k.quota.near}, vượt ${k.quota.over})`);
          ok(k.below_std.count >= 1, `bảng Sale ${period}: có BO dưới chuẩn giờ / kit / ngày (${k.below_std.count})`);
          ok(k.onboard.cur > 0 && k.onboard.prev > 0, `bảng Sale ${period}: onboard kỳ này ${k.onboard.cur}, kỳ trước ${k.onboard.prev}`);
          ok(b.hos.waiting_list.length >= 3, 'bảng Sale: có BO chờ active');
        } else ok(b.scope === 'mine' && b.outlets.every((o) => o.sale && o.sale.id === h.byName('sale').id), `bảng Sale ${period}: Sale chỉ thấy BO của mình`);
      }
    }
    // Hiệu suất: tuần và tháng, hai team, có kỳ trước để so; người làm tốt rõ ràng hơn người làm yếu.
    for (const [who, team] of [['lead', 'logistics'], ['techlead', 'tech']]) {
      for (const period of ['week', 'month']) {
        const r = await h.call(who, 'GET', '/api/hub/perf', null, { team, period });
        eq(r.status, 200, `hiệu suất ${team} ${period}`);
        const p = r.body;
        ok(p.rows.length >= 3 && p.summary.points > 0 && p.summary.prev && p.summary.prev.points > 0, `hiệu suất ${team} ${period}: kỳ này ${p.summary.points} điểm, kỳ trước ${p.summary.prev && p.summary.prev.points}`);
        ok(p.top3.length >= 2, `hiệu suất ${team} ${period}: có top người làm tốt (${p.top3.length})`);
        if (team === 'logistics') ok(p.fo && p.fo.rows.some((x) => x.points > 0), `hiệu suất ${period}: có số FO`);
      }
      const m = (await h.call(who, 'GET', '/api/hub/perf', null, { team, period: 'month', key: '2026-09' })).body; // tháng trước, đủ tháng (đã chốt)
      const by = Object.fromEntries(m.rows.map((x) => [x.user.name, x]));
      const strong = team === 'tech' ? 'Ngô Thanh Tâm' : 'Trương Mỹ Linh', weak = team === 'tech' ? 'Huỳnh Gia Bảo' : 'Lý Quốc Thịnh';
      ok(m.locked && by[strong] && by[weak] && by[strong].points > by[weak].points && by[strong].score > by[weak].score, `hiệu suất ${team} T9 (đã chốt): người làm tốt (${by[strong] && by[strong].points} điểm, ${by[strong] && by[strong].score}) hơn người làm yếu (${by[weak] && by[weak].points} điểm, ${by[weak] && by[weak].score})`);
    }
    // Sự cố theo tuần / tháng.
    for (const period of ['week', 'month']) {
      const r = await h.call('techlead', 'GET', '/api/hub/incidents/stats', null, { period });
      eq(r.status, 200, `thống kê sự cố ${period}`);
      ok(r.body.top.length >= 5 && r.body.total > 0 && r.body.prev_total > 0, `thống kê sự cố ${period}: ${r.body.top.length} nhãn, kỳ này ${r.body.total}, kỳ trước ${r.body.prev_total}`);
    }
    // WoW / MoM khi tuần, tháng đang chạy: so cùng kỳ, không so nửa kỳ với cả kỳ (đếm lại thẳng từ kho để đối chiếu).
    {
      const r1 = (x) => Math.round(Math.round(x * 1e6) / 1e5) / 10; // cùng cách gạt nhiễu dấu phẩy động với core/hub/report.js
      // Giờ của mỗi thẻ chia đều cho các ngày thẻ ghi (ngày quay → cover_to), trừ ngày tạm nghỉ và ngày BO ngoài đợt ghi hình.
      const nextDay = (d) => new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
      const siteOf = new Map(S.sites.find({}).map((s) => [s.id, s]));
      const inSp = (d, sp) => sp.some(([a, b]) => d >= a && (!b || d <= b));
      const daysOf = (x) => {
        const all = [];
        for (let d = x.shoot_date; d <= (x.cover_to && x.cover_to > x.shoot_date ? x.cover_to : x.shoot_date); d = nextDay(d)) all.push(d);
        const s = siteOf.get(x.site_id);
        if (all.length < 2 || !s) return all;
        const live = s.live_periods || [], off = [...(s.pauses || []), ...(s.pause_from && s.pause_to ? [[s.pause_from, s.pause_to]] : [])];
        const on = all.filter((d) => !inSp(d, off) && (!live.length || inSp(d, live)));
        return on.length ? on : all;
      };
      const recs = S.card_records.find({}).map((x) => ({ h: x.hours || 0, days: daysOf(x) }));
      const hoursIn = (from, to) => r1(recs.reduce((a, x) => a + (x.h / x.days.length) * x.days.filter((d) => d >= from && d <= to).length, 0));
      const lag = (await h.call('admin', 'GET', '/api/hub/config')).body.values.evalLagDays;
      for (const period of ['week', 'month']) {
        const o = (await h.call('admin', 'GET', '/api/hub/overview', null, { period })).body;
        const P = periodOf(period, null, '2026-10-08'), C = compareOf(P, '2026-10-08', END, 420, lag);
        ok(o.cmp && o.cmp.running && o.cmp.day_to === '2026-10-08' && o.cmp.prev_day_to === C.day.prev.to, `${period} đang chạy: so tới hôm nay với cùng kỳ (tới ${o.cmp && o.cmp.prev_day_to})`);
        eq([o.cmp.data_to, o.cmp.prev_data_to], [C.data.cur.to, C.data.prev.to], `${period}: giờ quay so tới hết ${C.data.cur.to}, bỏ ${lag} ngày thẻ chưa nhập đủ`);
        eq([o.kpi.hours.cur, o.kpi.hours.cmp, o.kpi.hours.prev], [hoursIn(P.from, P.to), hoursIn(C.data.cur.from, C.data.cur.to), hoursIn(C.data.prev.from, C.data.prev.to)], `${period}: giờ quay hiển thị tổng tới hôm nay, so cùng khoảng ngày đủ dữ liệu`);
        eq(o.kpi.hours.delta_pct, Math.round(((o.kpi.hours.cmp - o.kpi.hours.prev) / o.kpi.hours.prev) * 1000) / 10, `${period}: % thay đổi giờ quay tính trên khoảng so cùng kỳ (${o.kpi.hours.delta_pct}%)`);
        if (period === 'week') ok(Math.abs(o.kpi.hours.delta_pct) < 60, `tuần: WoW giờ quay không còn lệch giả do so nửa tuần với cả tuần (${o.kpi.hours.delta_pct}%, trước khi sửa khoảng −75%)`);
        const incPrev = S.incidents.find({ created_at: { gte: C.ts.prev.t0, lt: C.ts.prev.t1 } }).filter((i) => i.status !== 'cancelled').length;
        eq(o.kpi.incidents.prev, incPrev, `${period}: sự cố kỳ trước đếm tới cùng mốc giờ (${incPrev})`);
        const full = (await h.call('admin', 'GET', '/api/hub/overview', null, { period, key: P.prev })).body;
        ok(o.kpi.incidents.prev <= full.kpi.incidents.cur && o.kpi.sla.tech.prev.n <= full.kpi.sla.tech.cur.n, `${period}: số kỳ trước khi so cùng kỳ không vượt số cả kỳ trước`);
        const p = (await h.call('techlead', 'GET', '/api/hub/perf', null, { team: 'tech', period })).body;
        const pf = (await h.call('techlead', 'GET', '/api/hub/perf', null, { team: 'tech', period, key: P.prev })).body;
        ok(p.cmp && p.cmp.running && p.summary.prev.points > 0 && p.summary.prev.points < pf.summary.points, `${period}: điểm team Tech kỳ trước tính cùng kỳ (${p.summary.prev.points} < cả kỳ ${pf.summary.points})`);
        const rosterTo = (uid) => S.roster.find({ user_id: uid, status: 'approved', date: { gte: P.from, lte: '2026-10-08' } }).filter((x) => x.kind !== 'leave').length;
        ok(p.rows.every((x) => x.scheduled <= rosterTo(x.user.id)), `${period}: ca chưa tới không bị tính là ca phải làm (chuyên cần không bị trừ oan)`);
        const sb = (await h.call('salehead', 'GET', '/api/hub/sale', null, { period })).body;
        ok(sb.cmp && sb.hos.kpi.hours.cmp !== null && sb.hos.kpi.hours.delta_pct === (sb.hos.kpi.hours.prev ? Math.round(((sb.hos.kpi.hours.cmp - sb.hos.kpi.hours.prev) / sb.hos.kpi.hours.prev) * 1000) / 10 : null), `${period}: Dashboard Kinh doanh so giờ quay cùng kỳ (${sb.hos.kpi.hours.delta_pct}%)`);
        const st = (await h.call('techlead', 'GET', '/api/hub/incidents/stats', null, { period })).body;
        eq(st.prev_total, incPrev, `${period}: thống kê sự cố so cùng kỳ`);
      }
      const past = (await h.call('admin', 'GET', '/api/hub/overview', null, { period: 'week', key: '2026-W40' })).body;
      ok(!past.cmp.running && !past.cmp.data_partial && past.kpi.hours.cmp === past.kpi.hours.cur, 'tuần đã qua và thẻ đã nhập đủ: so cả tuần với cả tuần');
    }
    // Tên BO mẫu đã bắt đầu bằng "BO": thông báo, nhật ký, đối chiếu, cảnh báo không được thành "BO BO …".
    const dup = ['hub_log', 'inbox', 'recon', 'events'].flatMap((t) => S[t].find({}).filter((x) => /\bBO BO\b/.test(x.text || '')).map((x) => `${t}: ${x.text.slice(0, 80)}`));
    eq(dup.slice(0, 3), [], `không có chữ "BO BO" trong nhật ký, thông báo, đối chiếu, cảnh báo (${dup.length})`);
    const wl = (await h.call('salehead', 'GET', '/api/hub/overview')).body.watch.filter((x) => /\bBO BO\b/.test(x.text));
    eq(wl.length, 0, 'danh sách theo dõi không có "BO BO"');
    // Trạng thái "hôm nay": FO đang chạy chuyến, yêu cầu chờ, hộp thư chưa đọc.
    ok(S.tasks.count({ status: 'in_progress' }) >= 1, 'có chuyến FO đang chạy');
    ok(S.requests.count({ status: ['submitted', 'preparing', 'ready'] }) >= 3, 'có yêu cầu launch đang chờ');
    ok(S.inbox.count({ read_at: null }) > 0, 'hộp thư còn tin chưa đọc');
    ok(S.attendance.find({}).some((a) => a.status === 'late') && S.attendance.find({}).some((a) => a.status === 'absent'), 'chấm công có đi trễ và vắng');
    ok(S.acc_moves.count({}) > 8, 'sổ phụ kiện có biến động');
    const zero = S.card_records.find({}).filter((r) => !r.gb);
    ok(zero.length >= 5 && zero.every((r) => r.zero_reason), `có thẻ 0 giờ, đều có lý do (${zero.length})`);
  });
}
summary('hub.demo');
