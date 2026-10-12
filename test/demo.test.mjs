// demo.test.mjs — chạy chế độ mô phỏng 5 giờ "ảo" trên cả hai kho, soát các bất biến của hệ thống.
import { mk, ok, eq, group, summary, MON_10H } from './harness.mjs';
import { seedDemo, createDemoDriver } from '../core/demo.js';
import { OPEN_STATUS } from '../core/tasks.js';

for (const kind of ['memory', 'sqlite']) {
  await group(`Mô phỏng 5 giờ (${kind})`, async () => {
    const h = mk(kind, { cfg: { demo: true } });
    eq(await seedDemo(h.core), true, 'tạo dữ liệu mẫu');
    eq(await seedDemo(h.core), false, 'gọi lần 2 không tạo trùng');
    const msgs = { pos: 0, task: 0, alert: 0 };
    h.core.subscribe(h.byName('lead'), (m) => { if (msgs[m.t] !== undefined) msgs[m.t]++; JSON.stringify(m); });
    const driver = createDemoDriver(h.core);
    const errors = [];
    for (let i = 0; i < 9000; i++) { // 9000 × 2 giây = 5 giờ
      h.clock.add(2000);
      try { await driver.step(h.clock.now()); } catch (e) { errors.push(e); break; }
      h.core.flushPositions();
      if (i % 8 === 0) h.core.tick();
    }
    eq(errors.map((e) => String(e.stack || e)), [], 'không có lỗi nào trong lúc chạy');
    const today = h.core.snapshot() && (await h.call('lead', 'GET', '/api/tasks')).body.tasks;
    const sims = today.filter((t) => t.fo && /^(Nguyễn|Trần|Lê|Phạm|Võ|Đặng|Bùi)/.test(t.fo.name));
    ok(sims.length >= 14, `có task hôm nay cho FO mô phỏng (${sims.length})`);
    ok(sims.every((t) => !OPEN_STATUS.includes(t.status)), `sau 5 giờ mọi task của FO mô phỏng đã kết thúc (còn mở: ${sims.filter((t) => OPEN_STATUS.includes(t.status)).map((t) => t.code + ':' + t.status).join(', ') || 'không'})`);
    for (const t of sims) {
      if (t.status !== 'completed') continue;
      ok(t.finished_at >= t.started_at && t.km > 0 && t.stops.every((s) => s.status === 'done' || s.status === 'failed'), `${t.code}: thời gian và km hợp lệ, mọi điểm đã chốt`);
      ok(t.stops.every((s) => s.status !== 'done' || s.is_return || s.photos.some((p) => p.by === 'fo')), `${t.code}: điểm đã xong đều có ảnh FO`);
      ok(t.stops.every((s) => s.status !== 'done' || s.arrived_at <= s.done_at), `${t.code}: đến trước, xác nhận sau`);
      const bird = t.plan_km / 1.35; // kế hoạch tính từ điểm đầu; km thực còn gồm đoạn FO chạy tới điểm đầu
      ok(t.km >= bird * 0.9 - 0.3 && t.km <= bird + 16, `${t.code}: km thực (${t.km}) không ít hơn quãng chim bay của kế hoạch (${bird.toFixed(1)})`);
    }
    const mine = today.find((t) => t.fo && t.fo.name === 'FO Dùng Thử');
    ok(mine && mine.status === 'assigned', 'task của tài khoản dùng thử vẫn chờ người thật thao tác');
    const st = (await h.call('lead', 'GET', '/api/stats', null, { from: '2026-09-29', to: '2026-10-05' })).body;
    ok(st.fos.length >= 7 && st.totals.completed >= 100 && st.totals.km > 500 && st.totals.ontime_pct > 50, `thống kê 7 ngày có số liệu (${st.totals.completed} task xong, ${st.totals.km} km, đúng hạn ${st.totals.ontime_pct}%)`);
    const todayRow = st.days.filter((d) => d.date === '2026-10-05');
    ok(todayRow.every((d) => d.km >= 0 && d.km < 120 && d.stops_done <= 12), 'số liệu hôm nay nằm trong khoảng hợp lý');
    const sum = todayRow.reduce((a, d) => a + d.stops_done, 0), stopsDone = today.reduce((a, t) => a + t.stops.filter((s) => s.status === 'done').length, 0);
    eq(sum, stopsDone, 'tổng điểm xong trong thống kê khớp với bảng task');
    const cards = todayRow.reduce((a, d) => a + d.cards_in, 0), cardsReal = today.reduce((a, t) => a + t.stops.reduce((b, s) => b + (s.status === 'done' ? s.cards_in : 0), 0), 0);
    eq(cards, cardsReal, 'tổng thẻ thu trong thống kê khớp với bảng task');
    const pend = h.store.stops.find({ bo_status: 'pending' });
    eq(pend.length, 0, 'BO mô phỏng đã xác nhận hết qua link; không lượt nào còn treo');
    const boStops = today.flatMap((t) => (t.status === 'completed' ? t.stops : [])).filter((s) => s.bo_req && s.status === 'done');
    ok(boStops.length >= 20 && boStops.every((s) => (s.bo_status === 'confirmed' || s.bo_status === 'mismatch') && s.bo_at >= s.done_at && s.photos.some((p) => p.by === 'bo')), `mọi lượt giao nhận tại BO của task đã xong đều có BO xác nhận kèm ảnh (${boStops.length} lượt)`);
    ok(h.store.events.count({ type: 'bo_no_link' }) === 0 && h.store.events.count({ type: 'bo_link_opened' }) >= boStops.length, 'Logistic mô phỏng đã gửi link trước khi FO tới; BO mở link rồi mới xác nhận');
    ok(!JSON.stringify(today).includes('bo_link_hash') && !JSON.stringify(today).includes('bo_link_dev'), 'dữ liệu task trả về không chứa mã link / mã thiết bị của BO');
    const al = (await h.call('lead', 'GET', '/api/alerts')).body;
    ok(al.alerts.length > 0 && al.alerts.every((e) => typeof e.text === 'string' && e.text.length > 10 && !/undefined|NaN|null/.test(e.text)), `cảnh báo có nội dung đầy đủ (${al.alerts.length} cảnh báo)`);
    ok(msgs.pos > 1000 && msgs.task > 50, `điều phối nhận được luồng trực tiếp (${msgs.pos} nhịp vị trí, ${msgs.task} cập nhật task)`);
    ok(h.store.events.find({}).every((e) => !/undefined|NaN/.test(e.text)), 'không sự kiện nào có chữ undefined/NaN');
    // Ngày hôm sau: tuyến định kỳ tự sinh task (thứ Ba)
    h.clock.set(Date.parse('2026-10-05T17:01:00Z')); h.core.tick();
    const tmr = (await h.call('lead', 'GET', '/api/tasks', null, { date: '2026-10-06' })).body.tasks;
    eq(tmr.filter((t) => t.template_id).length, 2, 'sang ngày mới: 2 tuyến định kỳ tự sinh task');
    if (kind === 'sqlite') h.store.close();
  });
}
summary('Mô phỏng');
