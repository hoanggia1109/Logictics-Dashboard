// demo.js — dữ liệu mẫu và "diễn viên" giả lập: FO mô phỏng tự nhận task, chạy tới từng điểm, chụp ảnh, xác nhận;
// BO mô phỏng tự xác nhận bàn giao. Mọi thao tác đi qua đúng API của lõi, nên bản mô phỏng chạy cùng logic với bản thật.
import { distM, bearingDeg, localDate, dayStart, addDays, weekday } from './util.js';
import { DEMO_PHOTO_FO, DEMO_PHOTO_BO, DEMO_PHOTO_KIT } from './demo-assets.js';

export const DEMO_PASSWORD = 'demo1234';
// Toạ độ gần đúng quanh TP.HCM, chỉ để mô phỏng. Tên BO là tên đặt cho dễ hình dung, không phải khách hàng thật.
export const DEMO_SITES = [
  ['Văn phòng (mô phỏng)', 'office', 10.8021, 106.6436],
  ['BO Bến Thành', 'bo', 10.7725, 106.698],
  ['BO Landmark 81', 'bo', 10.795, 106.7218],
  ['BO Thảo Điền', 'bo', 10.803, 106.737],
  ['BO Phú Mỹ Hưng', 'bo', 10.7287, 106.7188],
  ['BO Bình Tây', 'bo', 10.7497, 106.651],
  ['BO Quận 10', 'bo', 10.7705, 106.67],
  ['BO Hàng Xanh', 'bo', 10.8015, 106.7112],
  ['BO Gò Vấp', 'bo', 10.8387, 106.6653],
  ['BO Cộng Hoà', 'bo', 10.8019, 106.64],
  ['BO Phú Nhuận', 'bo', 10.799, 106.68],
  ['BO Quận 4', 'bo', 10.759, 106.704],
  ['BO Thủ Đức', 'bo', 10.8494, 106.7537],
];
const FO_NAMES = ['Nguyễn Minh Tuấn', 'Trần Quốc Bảo', 'Lê Hoàng Phúc', 'Phạm Thanh Sơn', 'Võ Đức Huy', 'Đặng Văn Khoa', 'Bùi Anh Kiệt'];

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const RADD = Math.PI / 180;

/** Tạo dữ liệu mẫu nếu kho còn trống. Trả về true nếu vừa tạo. */
export async function seedDemo(core, opt = {}) {
  const { store } = core;
  if (store.sites.count() || store.users.count()) return false;
  const now = core.now(), off = core.cfg.tzOffsetMin, today = localDate(now, off);
  const rnd = mulberry32(opt.seed || 20261003);
  const mkUser = async (username, name, role, extra = {}) => (await core.createUser({ username, name, role, password: DEMO_PASSWORD, must_change: false, demo: true, ...extra }, null)).user;
  const lead = await mkUser('lead', 'Lead Dùng Thử', 'lead', { phone: '0900 000 100' });
  await mkUser('log', 'Logistic Dùng Thử', 'logistic', { phone: '0900 000 101' });
  const asLead = { user: store.users.get(lead.id), ip: 'demo', ua: 'demo' };
  const call = async (method, path, body) => {
    const r = await core.api(asLead, method, path, {}, body);
    if (r.status !== 200) throw new Error(`seed ${method} ${path}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const sites = [];
  for (const [name, type, lat, lon] of DEMO_SITES) sites.push((await call('POST', '/api/sites', { name, type, lat, lon, address: type === 'office' ? 'Tân Bình, TP.HCM (mô phỏng)' : 'TP.HCM (mô phỏng)', contact: type === 'bo' ? 'Quản lý cửa hàng' : '', phone: type === 'bo' ? `028 0000 ${String(1000 + sites.length).slice(1)}` : '' })).site);
  const office = sites[0], bos = sites.slice(1);
  const fos = [];
  for (let i = 0; i < FO_NAMES.length; i++) {
    const u = await mkUser(`fo${i + 1}`, FO_NAMES[i], 'fo', { phone: `0900 000 ${String(i + 1).padStart(3, '0')}`, vehicle: `59-X${i + 1} ${String(100 + ((i * 37) % 900))}.${String(10 + ((i * 53) % 90))}` });
    store.users.update(u.id, { consent_version: core.terms().version, consent_at: now - 86400000 });
    store.consents.insert({ user_id: u.id, version: core.terms().version, action: 'agree', ts: now - 86400000, ip: 'demo', ua: 'demo', items: core.terms().items });
    fos.push(u);
  }
  // FO "dùng thử" chưa đồng ý điều khoản: để người xem tự trải nghiệm màn hình đồng ý.
  const me = await mkUser('fo', 'FO Dùng Thử', 'fo', { phone: '0900 000 200', vehicle: '59-T1 000.01' });

  // Lịch sử 6 ngày trước để bảng thống kê có số liệu.
  for (let d = 6; d >= 1; d--) {
    const date = addDays(today, -d);
    if (weekday(date) === 7) continue;
    const t0 = dayStart(date, off);
    fos.forEach((fo, fi) => {
      const km = 24 + rnd() * 34, nTasks = 3 + Math.floor(rnd() * 2);
      store.daily.insert({ id: `${fo.id}:${date}`, user_id: fo.id, date, km: +km.toFixed(2), move_sec: Math.round((km / 24) * 3600), pts: Math.round(km * 40), first_ts: t0 + 8 * 3600000, last_ts: t0 + 17 * 3600000 });
      for (let k = 0; k < nTasks; k++) {
        const startAt = t0 + (8 + k * 2.2) * 3600000 + fi * 300000, base = 60 + Math.floor(rnd() * 6) * 5;
        const late = rnd() < 0.14, dur = (late ? base + 6 + rnd() * 20 : base * (0.55 + rnd() * 0.4)) * 60000;
        const picks = [bos[(fi + k * 3 + d) % bos.length], bos[(fi + k * 3 + d + 5) % bos.length]];
        const failed = rnd() < 0.04;
        const id = store.tasks.insert({
          code: `T${date.slice(2).replace(/-/g, '')}-${String(fi * 5 + k + 1).padStart(3, '0')}`, title: `${picks[0].name} +1 điểm`, fo_id: fo.id, created_by: lead.id, template_id: null, date, start_at: startAt, base_min: base, factor: 1,
          due_at: startAt + base * 60000, status: 'completed', accepted_at: startAt - 600000, started_at: startAt, finished_at: startAt + dur, round_trip: 0, plan_km: +(km / nTasks).toFixed(1), km: +(km / nTasks).toFixed(2),
          note: '', late: late ? 1 : 0, partial: failed ? 1 : 0, al_nostart: 0, al_risk: late ? 1 : 0, al_late: late ? 1 : 0, cancel_reason: '', created_at: t0 + 6 * 3600000,
        });
        picks.forEach((site, si) => {
          const out = 2 + Math.floor(rnd() * 3), isFail = failed && si === 1, hasBo = true;
          store.stops.insert({
            task_id: id, seq: si + 1, site_id: site.id, name: site.name, address: site.address, phone: site.phone, lat: site.lat, lon: site.lon, radius: site.radius, is_return: 0,
            exp_cards_out: out, exp_cards_in: out, exp_dev_out: 0, exp_dev_in: 0, note: '', status: isFail ? 'failed' : 'done', arrived_at: startAt + (si + 1) * dur * 0.3, arrive_mode: 'auto', done_at: startAt + (si + 1) * dur * 0.45,
            cards_out: isFail ? null : out, cards_in: isFail ? null : out, dev_out: isFail ? null : 0, dev_in: isFail ? null : 0, fo_note: '', fail_reason: isFail ? 'BO đóng cửa' : '', proof_dist: 12,
            bo_status: isFail || !hasBo ? 'none' : rnd() < 0.06 ? 'mismatch' : 'confirmed', bo_user: null, bo_at: isFail || !hasBo ? null : startAt + dur, bo_cards_recv: out, bo_cards_given: out, bo_dev_recv: 0, bo_dev_given: 0, bo_note: '', bo_reminded: 1,
          });
        });
      }
    });
  }

  // Tuyến định kỳ + task hôm nay.
  const dayEnd = dayStart(today, off) + 86400000 - 5 * 60000;
  const clamp = (t) => Math.max(dayStart(today, off), Math.min(dayEnd, Math.round(t)));
  const stop = (site, o = {}) => ({ site_id: site.id, cards_out: o.out ?? 2, cards_in: o.in ?? 2, dev_out: o.devOut ?? 0, dev_in: o.devIn ?? 0, note: o.note || '' });
  await call('POST', '/api/templates', { name: 'Swap thẻ sáng – cụm Đông', fo_id: fos[0].id, days: [1, 2, 3, 4, 5, 6], start_time: '08:00', round_trip: true, stops: [stop(office, { out: 0, in: 6 }), stop(bos[1]), stop(bos[2]), stop(bos[6])], active: true });
  await call('POST', '/api/templates', { name: 'Swap thẻ chiều – cụm Tây', fo_id: fos[1].id, days: [1, 2, 3, 4, 5, 6], start_time: '14:00', round_trip: true, stops: [stop(office, { out: 0, in: 4 }), stop(bos[4]), stop(bos[5])], active: true });
  for (let i = 0; i < fos.length; i++) {
    const a = bos[(i * 2 + 1) % bos.length], b = bos[(i * 2 + 4) % bos.length], c = bos[(i * 3 + 7) % bos.length];
    await call('POST', '/api/tasks', { fo_id: fos[i].id, start_at: clamp(now - i * 3 * 60000), round_trip: true, stops: [stop(office, { out: 0, in: 4 + (i % 3) * 2 }), stop(a), stop(b, i % 3 === 0 ? { devOut: 1, note: 'Giao thêm 1 bộ kit thay thế' } : {})] });
    await call('POST', '/api/tasks', { fo_id: fos[i].id, start_at: clamp(now + (70 + i * 12) * 60000), stops: [stop(c, { out: 3, in: 3 }), stop(a, { out: 0, in: 0, devIn: i % 2, note: i % 2 ? 'Thu hồi 1 thiết bị lỗi' : 'Kiểm tra dây nguồn' })] });
  }
  await call('POST', '/api/tasks', { title: 'Dùng thử: swap thẻ BO Bến Thành', fo_id: me.id, start_at: clamp(now + 2 * 60000), round_trip: true, note: 'Task dành cho tài khoản “fo” để anh/chị tự thao tác thử.', stops: [stop(office, { out: 0, in: 4, note: 'Nhận 4 thẻ trống' }), stop(bos[0], { out: 4, in: 4, note: 'Gặp quản lý cửa hàng' })] });
  await call('POST', '/api/tasks', { title: 'Chưa giao: thu hồi thiết bị BO Thủ Đức', start_at: clamp(now + 45 * 60000), stops: [stop(bos[11], { out: 0, in: 0, devIn: 2, note: 'Thu hồi 2 bộ kit' })] });
  return true;
}

/** "Diễn viên" mô phỏng. Gọi step(now) đều đặn (khoảng 2 giây một lần). */
export function createDemoDriver(core, opt = {}) {
  const { store } = core;
  const rnd = mulberry32(opt.seed || 7);
  const sims = new Map();
  let last = 0;
  const office = () => store.sites.find({ type: 'office', active: 1 }, { limit: 1 })[0] || { lat: DEMO_SITES[0][2], lon: DEMO_SITES[0][3] };
  const act = async (uid, method, path, body) => {
    const user = store.users.get(uid);
    if (!user || !user.active) return null;
    const r = await core.api({ user, ip: 'demo', ua: 'demo' }, method, path, {}, body || {});
    return r.status === 200 ? r.body : null;
  };

  async function stepFo(u, now, dt) {
    let s = sims.get(u.id);
    if (!s) {
      const o = office();
      s = { lat: o.lat + (rnd() - 0.5) * 0.003, lon: o.lon + (rnd() - 0.5) * 0.003, cruise: 7 + rnd() * 4, hdg: 0, bat: 0.5 + rnd() * 0.5, dwellUntil: 0, silentUntil: 0, lastEmit: 0 };
      const l0 = core.live.get(u.id);
      if (l0 && l0.last) { s.lat = l0.last.lat; s.lon = l0.last.lon; }
      sims.set(u.id, s);
    }
    s.bat = Math.max(0.08, s.bat - dt * 0.000015);
    const l = core.live.get(u.id);
    let cur = l && l.cur;
    if (!cur) {
      const next = store.tasks.find({ fo_id: u.id, status: ['assigned', 'accepted'] }, { order: 'start_at', limit: 1 })[0];
      if (next && next.start_at <= now) {
        if (next.status === 'assigned') await act(u.id, 'POST', `/api/tasks/${next.id}/accept`);
        await act(u.id, 'POST', `/api/tasks/${next.id}/start`);
        cur = core.live.get(u.id) && core.live.get(u.id).cur;
      }
    }
    let spd = 0;
    const waitBo = !!cur && cur.stops.some((x) => x.status === 'done' && x.bo === 'pending'); // BO chưa xác nhận: đứng chờ tại điểm
    if (cur && !waitBo) {
      const st = cur.stops.find((x) => x.status === 'pending' || x.status === 'arrived');
      if (st && st.status === 'pending') {
        const d = distM(s.lat, s.lon, st.lat, st.lon);
        if (d < 30) { s.lat = st.lat; s.lon = st.lon; } else {
          spd = s.cruise * (0.55 + rnd() * 0.75); // kẹt xe, đèn đỏ
          const go = Math.min(d, spd * dt);
          s.hdg = bearingDeg(s.lat, s.lon, st.lat, st.lon);
          s.lat += (go * Math.cos(s.hdg * RADD)) / 111320;
          s.lon += (go * Math.sin(s.hdg * RADD)) / (111320 * Math.cos(s.lat * RADD));
        }
        s.dwellUntil = 0;
      } else if (st && st.status === 'arrived') {
        if (!s.dwellUntil) s.dwellUntil = now + (35 + rnd() * 70) * 1000; // thời gian giao nhận tại điểm
        else if (now >= s.dwellUntil) {
          s.dwellUntil = 0;
          const row = store.stops.get(st.id);
          if (!row.is_return && rnd() < 0.03) await act(u.id, 'POST', `/api/stops/${st.id}/fail`, { reason: 'BO đóng cửa, gọi không ai nghe máy' });
          else {
            const short = !row.is_return && row.exp_cards_in > 0 && rnd() < 0.07 ? 1 : 0; // thỉnh thoảng BO đưa thiếu thẻ
            await act(u.id, 'POST', `/api/stops/${st.id}/proof`, {
              photos: row.is_return ? [] : [row.exp_dev_out + row.exp_dev_in > 0 ? DEMO_PHOTO_KIT : DEMO_PHOTO_FO],
              cards_out: row.exp_cards_out, cards_in: row.exp_cards_in - short, dev_out: row.exp_dev_out, dev_in: row.exp_dev_in, note: short ? 'BO đưa thiếu 1 thẻ' : '',
            });
          }
        }
      }
    }
    // Thỉnh thoảng rớt sóng 1–2,5 phút để thấy trạng thái "mất sóng".
    if (now >= s.silentUntil && rnd() < dt / 1500) s.silentUntil = now + (60 + rnd() * 90) * 1000;
    if (now < s.silentUntil) return;
    if (!cur && !(l && l.onShift) && !store.tasks.count({ fo_id: u.id, status: ['assigned', 'accepted'] })) return; // hết việc, đã hết ca: không phát nữa
    if (spd === 0 && now - s.lastEmit < 15000) return; // đứng yên: 15 giây báo 1 lần
    s.lastEmit = now;
    const noise = spd ? 0 : (rnd() - 0.5) * 0.00002;
    core.ingest(u.id, { ts: now, lat: +(s.lat + noise).toFixed(6), lon: +(s.lon + noise).toFixed(6), acc: Math.round(4 + rnd() * 10), spd: +spd.toFixed(2), hdg: Math.round(s.hdg), bat: +s.bat.toFixed(2) }, now);
  }

  // Logistic và BO mô phỏng: khi task của FO mô phỏng bắt đầu chạy, "Logistic" tạo link cho từng BO; sau khi FO giao nhận xong,
  // "BO" mở link và xác nhận kèm ảnh. Task của tài khoản "fo" (người xem tự thao tác) thì để người xem tự tạo link và xác nhận.
  const links = new Map(); // stop id → mã link
  const BO_DEV = 'demo-bo-device-0000000000000000';
  async function stepBo(now) {
    const logi = store.users.find({ username: 'log' }, { limit: 1 })[0];
    if (!logi) return;
    for (const task of store.tasks.find({ status: 'in_progress' })) {
      const fo = store.users.get(task.fo_id);
      if (!fo || !fo.demo || !/^fo\d+$/.test(fo.username)) continue;
      for (const st of store.stops.find({ task_id: task.id }, { order: 'seq' })) {
        if (!st.bo_req || st.status === 'failed' || st.bo_status === 'confirmed' || st.bo_status === 'mismatch' || st.bo_status === 'waived') continue;
        if (!links.has(st.id)) {
          const r = await act(logi.id, 'POST', `/api/stops/${st.id}/bo-link`);
          if (r) links.set(st.id, r.token);
          continue;
        }
        if (st.bo_status !== 'pending' || now - st.done_at < (20 + ((st.id * 37) % 70)) * 1000) continue;
        const lost = st.cards_out > 0 && (st.id * 13) % 12 === 0 ? 1 : 0; // thỉnh thoảng BO đếm thiếu → cảnh báo lệch
        await core.api({ user: null, ip: 'demo', ua: 'demo', dev: BO_DEV }, 'POST', '/api/bo-link/confirm', {}, { token: links.get(st.id), photos: [DEMO_PHOTO_BO], cards_recv: st.cards_out - lost, cards_given: st.cards_in, dev_recv: st.dev_out, dev_given: st.dev_in, note: lost ? 'Đếm lại chỉ thấy thiếu 1 thẻ' : '' });
        links.delete(st.id);
      }
    }
  }

  return {
    async step(now) {
      const dt = last ? Math.max(0, Math.min(10, (now - last) / 1000)) : 2;
      last = now;
      for (const u of store.users.find({ role: 'fo', active: 1, demo: 1 })) {
        if (!/^fo\d+$/.test(u.username) || !core.canTrack(u)) continue;
        await stepFo(u, now, dt);
      }
      await stepBo(now);
    },
  };
}
