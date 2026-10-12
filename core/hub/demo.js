// hub/demo.js — dữ liệu mẫu cho Ops Hub: tua đồng hồ về khoảng 9 tuần trước rồi cho Sale, Logistics (kèm FO, BO), Tech làm việc từng ngày qua đúng
// API của lõi (như seedDemo), nên mọi màn hình, dashboard và chỉ số đều sinh ra từ cùng logic với bản thật và khớp nhau: giờ quay, quota, điểm hiệu suất,
// chấm công, sự cố, đối chiếu. Chỉ đọc kho để quyết định bước kế tiếp, không ghi thẳng. Không dùng thư viện riêng của Node để chạy được cả trong bản xem thử.
// Gọi ngay sau seedDemo, trước lần core.tick() đầu tiên. Tên người, BO, mã thiết bị là tên đặt cho dễ hình dung, không phải nhân sự hay khách hàng thật.
import { localDate, localHM, atTime, addDays, weekday, distM, bearingDeg } from '../util.js';
import { DEMO_PASSWORD } from '../demo.js';
import { DEMO_PHOTO_FO, DEMO_PHOTO_BO, DEMO_PHOTO_KIT } from '../demo-assets.js';

// [tên đăng nhập, họ tên, vai trò, hồ sơ làm việc]. lead, log, fo1…fo7 có sẵn từ seedDemo.
const HD_PEOPLE = [
  ['admin', 'Quản Trị Dùng Thử', 'admin', null], ['techlead', 'Tech Lead Dùng Thử', 'tech_lead', 'lead'], ['tech', 'Tech Dùng Thử', 'tech', 'avg'],
  ['tech2', 'Ngô Thanh Tâm', 'tech', 'strong'], ['tech3', 'Huỳnh Gia Bảo', 'tech', 'weak'], ['log2', 'Trương Mỹ Linh', 'logistic', 'strong'], ['log3', 'Lý Quốc Thịnh', 'logistic', 'weak'],
  ['salehead', 'Head of Sale Dùng Thử', 'sale_head', null], ['sale', 'Sale Dùng Thử', 'sale', null], ['sale2', 'Mai Phương Thảo', 'sale', null], ['sale3', 'Đỗ Khánh Duy', 'sale', null],
];
// Hồ sơ làm việc: tốc độ (hệ số thời gian làm), tỉ lệ ngồi chơi, đi trễ, vắng không báo, độ trễ nhận phiếu (phút), số thẻ mỗi lượt nhập.
const HD_PROF = {
  strong: { speed: 0.7, idle: 0.02, late: 0, absent: 0, lag: [1, 6], batch: 14 }, avg: { speed: 1, idle: 0.12, late: 0.12, absent: 0.015, lag: [4, 16], batch: 10 },
  weak: { speed: 1.45, idle: 0.35, late: 0.4, absent: 0.06, lag: [12, 50], batch: 6 }, lead: { speed: 0.9, idle: 0.1, late: 0.04, absent: 0, lag: [5, 20], batch: 10 },
};
// Ca mẫu theo tuần chẵn / lẻ, để luôn có người trong ca từ 07:00 tới 22:00.
const HD_PAT = { lead: ['HC', 'HC'], techlead: ['HC', 'HC'], log: ['S', 'C'], log2: ['C', 'HC'], log3: ['HC', 'S'], tech: ['HC', 'HC'], tech2: ['C', 'HC'], tech3: ['HC', 'S'] };
// BO mới quanh TP.HCM (toạ độ gần đúng, chỉ để mô phỏng): [tên, lat, lon, khu vực].
const HD_NEW_BOS = [
  ['BO Quận 7', 10.734, 106.7215, 'Quận 7'], ['BO Nguyễn Trãi', 10.759, 106.685, 'Quận 5'], ['BO Chợ Lớn', 10.753, 106.66, 'Quận 5'], ['BO Tân Định', 10.7895, 106.6905, 'Quận 3'],
  ['BO Võ Văn Tần', 10.7768, 106.689, 'Quận 3'], ['BO Bàu Cát', 10.792, 106.644, 'Tân Bình'], ['BO Sân Bay', 10.812, 106.665, 'Tân Bình'], ['BO Tân Phú', 10.79, 106.628, 'Tân Phú'],
  ['BO Bình Thạnh', 10.81, 106.705, 'Bình Thạnh'], ['BO Văn Thánh', 10.799, 106.716, 'Bình Thạnh'], ['BO An Phú', 10.802, 106.75, 'TP Thủ Đức'], ['BO Hiệp Bình', 10.842, 106.723, 'TP Thủ Đức'],
  ['BO Linh Trung', 10.87, 106.775, 'TP Thủ Đức'], ['BO Quang Trung', 10.84, 106.645, 'Gò Vấp'], ['BO Phan Văn Trị', 10.827, 106.688, 'Gò Vấp'], ['BO Tân Sơn Nhì', 10.798, 106.632, 'Tân Phú'],
  ['BO Bình Phú', 10.742, 106.633, 'Quận 6'], ['BO Hậu Giang', 10.748, 106.645, 'Quận 6'], ['BO Quận 8', 10.74, 106.665, 'Quận 8'], ['BO Nhà Bè', 10.695, 106.74, 'Nhà Bè'],
  ['BO Bình Tân', 10.765, 106.603, 'Bình Tân'], ['BO Quận 12', 10.863, 106.654, 'Quận 12'], ['BO Sư Vạn Hạnh', 10.77, 106.668, 'Quận 10'], ['BO Khánh Hội', 10.76, 106.698, 'Quận 4'],
  ['BO Ba Tháng Hai', 10.768, 106.66, 'Quận 11'], ['BO Lạc Long Quân', 10.772, 106.648, 'Quận 11'], ['BO Thủ Thiêm', 10.786, 106.728, 'TP Thủ Đức'], ['BO Hóc Môn', 10.885, 106.595, 'Hóc Môn'],
];
const HD_AREA = { 'BO Bến Thành': 'Quận 1', 'BO Landmark 81': 'Bình Thạnh', 'BO Thảo Điền': 'TP Thủ Đức', 'BO Phú Mỹ Hưng': 'Quận 7', 'BO Bình Tây': 'Quận 6', 'BO Quận 10': 'Quận 10', 'BO Hàng Xanh': 'Bình Thạnh', 'BO Gò Vấp': 'Gò Vấp', 'BO Cộng Hoà': 'Tân Bình', 'BO Phú Nhuận': 'Phú Nhuận', 'BO Quận 4': 'Quận 4', 'BO Thủ Đức': 'TP Thủ Đức' };
const HD_BIZ = ['Cà phê', 'Trà sữa', 'Nhà hàng', 'Quán nhậu', 'Bánh mì', 'Lẩu nướng', 'Cơm văn phòng', 'Tiệm bánh'];
const HD_SWAP_WIN = [['08:30', '11:30'], ['09:00', '12:00'], ['13:30', '16:30'], ['14:00', '17:00'], ['15:00', '18:00']];
// Trọng số nhãn lỗi theo dòng máy (lỗi hay gặp nặng hơn). Mười ngày gần nhất "Quá nhiệt" và "CM5 mất kết nối" tăng lên.
const HD_LABEL_W = {
  multicam: { 'Không lên nguồn': 8, 'Không ghi hình': 7, 'CM5 mất kết nối': 9, 'Lỗi thẻ nhớ': 6, 'Thẻ đầy': 3, 'Powerbank không sạc': 6, 'Cáp lỏng hoặc đứt': 7, 'Quá nhiệt': 4, 'Lệch góc quay': 5, 'Ống kính bẩn hoặc mờ': 3, 'Mất tiếng': 2, 'Đèn báo lỗi': 2, 'Hub sạc hỏng': 3, 'Dây gắn hỏng': 3, 'Rơi hoặc va đập': 2, 'BO tắt máy': 5, 'BO tháo thiết bị': 2, 'Mất thiết bị': 0.4, 'Khác': 2 },
  iphone: { 'Không lên nguồn': 3, 'Không ghi hình': 3, 'Hết bộ nhớ': 4, 'Pin chai hoặc không sạc': 4, 'Sạc hỏng': 3, 'Headstrap hỏng': 2, 'Quá nhiệt': 4, 'Ứng dụng lỗi': 4, 'Rơi hoặc va đập': 1, 'Mất thiết bị': 0.3, 'Khác': 1 },
};
const HD_INC_TEXT = {
  'Không lên nguồn': 'BO báo máy không lên nguồn từ sáng, đã thử cắm lại sạc.', 'Không ghi hình': 'Đèn ghi không sáng, BO kiểm tra thấy máy không ghi.',
  'CM5 mất kết nối': 'CM5 mất kết nối với Multicam, ứng dụng báo ngoại tuyến.', 'Lỗi thẻ nhớ': 'Máy báo lỗi thẻ nhớ, không ghi tiếp được.', 'Thẻ đầy': 'Máy báo thẻ đầy trước giờ đổi thẻ.',
  'Powerbank không sạc': 'Powerbank không vào điện, máy tắt giữa ca.', 'Cáp lỏng hoặc đứt': 'Cáp nối bị lỏng, máy chập chờn.', 'Quá nhiệt': 'Máy nóng và tự tắt vào giờ cao điểm buổi trưa.',
  'Lệch góc quay': 'Góc quay bị lệch sau khi BO lau dọn quầy.', 'Ống kính bẩn hoặc mờ': 'Hình bị mờ, ống kính dính dầu mỡ.', 'BO tắt máy': 'BO tắt máy khi đóng cửa sớm, quên bật lại.',
  'Hết bộ nhớ': 'iPhone báo đầy bộ nhớ, ứng dụng dừng ghi.', 'Ứng dụng lỗi': 'Ứng dụng ghi hình bị văng liên tục.', 'Pin chai hoặc không sạc': 'iPhone tụt pin nhanh, sạc không lên.',
};
const HD_FIX = {
  no_recover: ['Hướng dẫn BO khởi động lại, máy ghi bình thường', 'Cắm lại cáp và chỉnh góc qua cuộc gọi video', 'Thay dây sạc dự phòng có sẵn tại BO'],
  swap: ['Lỗi phần cứng, cần đổi kit tại BO'], office_repair: ['Cần mang kit về văn phòng kiểm tra kỹ'], invalid: ['BO báo nhầm, máy vẫn ghi bình thường'],
};
const HD_ZERO = { 'BO không bật máy': 40, 'Máy không ghi': 20, 'Thẻ lỗi': 10, 'BO đóng cửa / nghỉ': 15, 'Thẻ chưa dùng': 10, 'Khác: BO mất điện cả buổi': 5 };

/**
 * Tạo 9 tuần lịch sử vận hành cho Ops Hub nếu chưa có (kho đã có dữ liệu của seedDemo, chưa có tài khoản salehead).
 * opt: { setNow(ts | null) — đặt đồng hồ giả của lõi (null: trả về giờ thật), weeks = 9, seed, scale = 1 }.
 * Trả về số liệu lần tạo (số lệnh API, thời gian, các lệnh bị từ chối theo loại) hoặc false nếu không tạo.
 */
export async function seedHubDemo(core, opt = {}) {
  const { store } = core, H = core.hub;
  if (!H || store.users.count({ username: 'salehead' })) return false;
  const K = H.K, off = core.cfg.tzOffsetMin;
  const office = store.sites.find({ type: 'office', active: 1 }, { order: 'id', limit: 1 })[0];
  const fos = store.users.find({ role: 'fo', active: 1, demo: 1 }, { order: 'username' }).filter((u) => /^fo\d+$/.test(u.username) && core.canTrack(u));
  if (!office || !store.users.count({ username: 'lead' }) || !store.users.count({ username: 'log' }) || !fos.length) return false;
  const started = Date.now();
  const setNow = typeof opt.setNow === 'function' ? opt.setNow : () => {};
  const S = Math.min(3, Math.max(0.25, Number(opt.scale) || 1));
  const WEEKS = Math.min(12, Math.max(3, Math.round(Number(opt.weeks) || 9)));
  let seedA = (Number(opt.seed) || 20261008) | 0;
  const rnd = () => { seedA = (seedA + 0x6d2b79f5) | 0; let x = Math.imul(seedA ^ (seedA >>> 15), 1 | seedA); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const rr = (a, b) => a + rnd() * (b - a), ri = (a, b) => Math.floor(rr(a, b + 1)), chance = (p) => rnd() < p, pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const wpick = (w) => { const ks = Object.keys(w); let x = rnd() * ks.reduce((a, k) => a + w[k], 0); for (const k of ks) { x -= w[k]; if (x <= 0) return k; } return ks[ks.length - 1]; };
  const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  const poisson = (l) => { let n = 0, p = Math.exp(-l), F = p; const x = rnd(); while (x > F && n < 50) { n++; p *= l / n; F += p; } return n; };
  const MIN = 60000, HOUR = 3600000, OPEN = ['open', 'doing'];
  const FIELD = ['card_swap', 'deliver', 'recover', 'swap_faulty', 'deliver_acc'];
  const DESK = ['cards_receive', 'cards_back', 'incident', 'check_kit', 'prep_kit', 'receive_field', 'receive_back', 'checkin', 'qr_change', 'repair', 'manual', 'stock_check', 'cards_upload']; // việc làm tại văn phòng

  // ───────── Đồng hồ giả và hàng sự kiện (đống nhị phân theo thời điểm) ─────────
  const REAL = core.now(), END = REAL - 2 * MIN, TODAY = localDate(END, off);
  const endMin = Math.floor(((((END + off * MIN) % 86400000) + 86400000) % 86400000) / MIN);
  const back = addDays(TODAY, -7 * WEEKS), D0 = addDays(back, 1 - weekday(back)); // thứ Hai
  const dateAt = (i) => addDays(D0, i);
  let LAST = 0; while (dateAt(LAST) < TODAY) LAST++;
  const weekOf = (i) => Math.floor(i / 7), CW = weekOf(LAST);
  const at = (d, hm) => atTime(d, hm, off);
  const hmOf = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
  let T = at(D0, '05:00');
  setNow(T);
  // BO mẫu được thêm ở Rider Live (seedDemo) lúc đồng hồ thật; lịch sử Ops Hub bắt đầu từ D0, nên dòng nhật ký "thêm BO" đặt về đầu lịch sử.
  store.tx(() => { for (const r of store.hub_log.find({ entity: 'outlet', action: 'create', ts: { gt: T } })) store.hub_log.update(r.id, { ts: T }); });
  const clock = (t) => { const v = Math.min(Math.round(t), END); if (v > T) { T = v; setNow(T); } };
  const heap = [];
  let seq = 0;
  const less = (a, b) => a.t < b.t || (a.t === b.t && a.s < b.s);
  function push(t, fn) {
    const e = { t: Math.max(Math.round(t), T), s: seq++, fn };
    heap.push(e);
    for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (!less(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; }
  }
  function pop() {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && less(heap[l], heap[m])) m = l; if (r < heap.length && less(heap[r], heap[m])) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; }
    }
    return top;
  }
  const stat = { calls: 0, misses: {}, errors: [] };
  async function runTo(limit) {
    while (heap.length && heap[0].t <= limit) {
      const e = pop();
      clock(e.t);
      try { await e.fn(); } catch (err) { if (stat.errors.length < 20) stat.errors.push(String((err && err.stack) || err)); }
    }
    clock(limit);
  }

  // ───────── Gọi API như người dùng thật ─────────
  const ids = {}; // tên đăng nhập → id
  for (const u of store.users.find({})) ids[u.username] = u.id;
  const miss = (k) => { stat.misses[k] = (stat.misses[k] || 0) + 1; };
  async function api(who, method, path, body) {
    stat.calls++;
    const user = store.users.get(typeof who === 'number' ? who : ids[who]);
    const r = await core.api({ user, ip: 'demo', ua: 'demo' }, method, path, {}, body || {});
    if (r.status === 200) return r.body;
    miss(`${method} ${path.replace(/\/\d+/g, '/:id')} → ${r.status} ${(r.body && r.body.error) || ''}`);
    return null;
  }
  // Điện thoại của BO: mở link xác nhận không cần tài khoản, mỗi BO một mã thiết bị.
  async function boApi(siteId, path, body) {
    stat.calls++;
    const r = await core.api({ user: null, ip: 'demo-bo-' + siteId, ua: 'demo-bo', dev: 'demoBO' + String(siteId).padStart(10, '0') + 'device' }, 'POST', path, {}, body);
    if (r.status === 200) return r.body;
    miss(`POST ${path} → ${r.status} ${(r.body && r.body.error) || ''}`);
    return null;
  }
  const user = (u) => store.users.get(typeof u === 'number' ? u : ids[u]);
  const onShift = (u) => { const x = user(u); return !!x && H.jobs.onShift(x, T); };
  const MEMBERS = { logistics: ['log', 'log2', 'log3'], tech: ['tech', 'tech2', 'tech3'] };
  const TEAM = { log: 'logistics', log2: 'logistics', log3: 'logistics', tech: 'tech', tech2: 'tech', tech3: 'tech', lead: 'logistics', techlead: 'tech' };
  const PROFN = { log: 'avg', lead: 'lead' };
  for (const [u, , , p] of HD_PEOPLE) if (p) PROFN[u] = p;
  const prof = (u) => HD_PROF[PROFN[u] || 'avg'];
  /** Người trong ca của team (thành viên trước, Lead sau); không ai thì null. */
  function shiftOf(team) {
    const list = MEMBERS[team].filter(onShift);
    if (list.length) return pick(list);
    const ld = team === 'tech' ? 'techlead' : 'lead';
    return onShift(ld) ? ld : null;
  }

  // ───────── Ngày đầu: tài khoản, bảng ca, BO có sẵn, kho ─────────
  clock(at(D0, '05:30'));
  for (const [username, name, role] of HD_PEOPLE) {
    if (ids[username]) continue;
    const r = await core.createUser({ username, name, role, password: DEMO_PASSWORD, must_change: false, demo: true, phone: `0900 000 ${String(300 + Object.keys(ids).length).slice(-3)}` }, null);
    ids[username] = r.user.id;
  }
  // Thẻ đổi 2–3 ngày một lần rồi mới về Tech nhập: Tech Lead đặt so giờ quay WoW / MoM tới trước 3 ngày gần nhất (mặc định 2 thì phần so cùng kỳ bị thấp giả).
  await api('techlead', 'PUT', '/api/hub/config', { evalLagDays: 3 });
  const tpls = store.templates.find({ active: 1 });
  for (const tp of tpls) await api('lead', 'PATCH', `/api/templates/${tp.id}`, { active: false }); // tuyến định kỳ tạm tắt khi tua lại lịch sử

  // Kế hoạch từng BO: trạng thái cuối, Sale phụ trách, ngày gửi yêu cầu, ngày launch, nhịp quay, quota.
  const exist = shuffle(store.sites.find({ type: 'bo', active: 1 }, { order: 'id' }));
  const N = Math.max(12, Math.round(36 * S));
  const cnt = { paused: Math.max(1, Math.round(2 * S)), ending: Math.max(1, Math.round(2 * S)), ended: Math.max(1, Math.round(3 * S)), waiting: Math.max(3, Math.round(4 * S)), prospect: Math.max(1, Math.round(2 * S)) };
  cnt.live = Math.max(3, N - cnt.paused - cnt.ending - cnt.ended - cnt.waiting - cnt.prospect);
  const kinds = [];
  for (let k = 0; k < cnt.live; k++) kinds.push('live');
  for (let k = 0; k < cnt.paused; k++) kinds.push('paused');
  for (let k = 0; k < cnt.ending; k++) kinds.push(k % 2 ? 'ending2' : 'ending1');
  for (let k = 0; k < cnt.ended; k++) kinds.push('ended');
  for (let k = 0; k < cnt.waiting; k++) kinds.push(['w_submitted', 'w_preparing', 'w_ready'][k] || 'w_ready');
  for (let k = 1; k < cnt.prospect; k++) kinds.push('p_cancel');
  shuffle(kinds).unshift('p_none'); // một BO có sẵn đã giao Sale nhưng chưa gửi yêu cầu
  const SALES = ['sale', 'sale2', 'sale3'];
  const usedNames = new Set(store.sites.find({}).map((s) => s.name));
  const fresh = HD_NEW_BOS.filter((b) => !usedNames.has(b[0]));
  const plans = kinds.map((kind, i) => {
    const site = exist[i] || null;
    let nb = null;
    if (!site) { const b = fresh[(i - exist.length) % fresh.length]; const rep = Math.floor((i - exist.length) / fresh.length); nb = { name: rep ? `${b[0]} ${rep + 1}` : b[0], lat: b[1] + rep * 0.004, lon: b[2] + rep * 0.004, area: b[3] }; }
    const need = { mc1: { multicam: 1, iphone: 0 }, mc2: { multicam: 2, iphone: 0 }, mcip: { multicam: 1, iphone: 1 }, ip1: { multicam: 0, iphone: 1 }, mc3: { multicam: 3, iphone: 0 } }[wpick({ mc1: 55, mc2: 20, mcip: 10, ip1: 10, mc3: 5 })];
    return {
      i, kind, site, nb, siteId: site ? site.id : null, sale: SALES[i % 3], byHos: chance(0.2), code: `HCM-${String(i + 1).padStart(3, '0')}`, business: pick(HD_BIZ),
      need: kind === 'w_preparing' ? { multicam: 2, iphone: 0 } : need, rate: rr(6.3, 9.2), zeroP: rr(0.03, 0.06), swapDays: wpick({ '1,3,5': 35, '2,4,6': 35, '1,2,3,4,5,6': 30 }), win: pick(HD_SWAP_WIN),
      quota: null, req: null, launch: null, reqDay: null,
    };
  });
  // Ngày launch theo loại: rải đều các tuần (có BO onboard cả tuần này và tuần trước để WoW / MoM có số), xin yêu cầu trước 3–6 ngày.
  const okLaunch = (i) => i >= 2 && i <= LAST && weekday(dateAt(i)) !== 7 && (i < LAST || endMin >= 11 * 60 + 30);
  const launchIn = (w) => { for (let k = 0; k < 12; k++) { const i = w * 7 + ri(0, 5); if (okLaunch(i)) return i; } for (let i = Math.min(LAST, w * 7 + 6); i >= 2; i--) if (okLaunch(i)) return i; return 2; };
  const wWeek = () => { const ws = {}; for (let w = 0; w < CW; w++) ws[w] = 1 + 0.12 * w; return +wpick(ws); };
  let liveN = 0;
  for (const p of plans) {
    if (p.kind === 'live') { p.launch = launchIn(liveN === 0 ? CW : liveN === 1 ? CW - 1 : wWeek()); liveN++; }
    else if (p.kind === 'paused' || p.kind.startsWith('ending')) p.launch = launchIn(ri(1, Math.max(1, CW - 2)));
    else if (p.kind === 'ended') p.launch = launchIn(ri(0, 1));
    if (p.launch !== null) p.reqDay = Math.max(0, p.launch - ri(3, 6));
  }
  const low = shuffle(plans.filter((p) => p.kind === 'live')).slice(0, Math.max(1, Math.round(5 * S)));
  for (const p of low) p.rate = rr(2.4, 4.4); // BO dưới chuẩn 5 giờ / kit / ngày
  for (const p of shuffle(plans.filter((p) => p.launch !== null)).slice(0, 2)) p.zeroP = rr(0.14, 0.2);
  const early = plans.filter((p) => p.kind === 'live' && !low.includes(p) && p.launch <= 30).sort((a, b) => a.launch - b.launch);
  const nearQ = early.slice(0, Math.max(1, Math.round(3 * S))), overQ = early.slice(nearQ.length, nearQ.length + Math.max(1, Math.round(S)));
  const kitsOf = (p) => (p.need.multicam || 0) + (p.need.iphone || 0);
  const evAt = new Map();
  const ev = (i, hm, fn) => { if (i < 0 || i > LAST) return; if (!evAt.has(i)) evAt.set(i, []); evAt.get(i).push([hm, fn]); };
  const holdReq = new Set(), partialReq = new Set(), holdRecover = new Set();
  for (const p of plans) {
    const life = p.launch !== null ? Math.max(7, LAST - p.launch) : 60;
    if (p.launch !== null && chance(0.85)) p.quota = Math.round((p.rate * kitsOf(p) * life * 0.9) / rr(0.3, 0.65) / 10) * 10;
    if (p.kind === 'w_ready') { p.reqDay = LAST - ri(2, 3); p.launchDate = addDays(TODAY, ri(1, 2)); }
    else if (p.kind === 'w_preparing') { p.reqDay = LAST - 1; p.launchDate = addDays(TODAY, ri(3, 5)); p.partial = true; }
    else if (p.kind === 'w_submitted') { p.reqDay = endMin >= 9 * 60 + 40 ? LAST : LAST - 1; p.launchDate = addDays(TODAY, ri(4, 7)); p.hold = true; p.reqHm = p.reqDay === LAST ? hmOf(ri(9 * 60, endMin - 25)) : '15:20'; }
    else if (p.kind === 'p_cancel') { p.reqDay = ri(8, Math.max(9, LAST - 12)); p.launchDate = dateAt(p.reqDay + 6); p.hold = true; ev(p.reqDay + ri(1, 3), '11:00', () => p.req && api(p.sale, 'POST', `/api/hub/requests/${p.req}/cancel`, { reason: 'Chủ BO dời kế hoạch ghi hình sang quý sau' })); }
    if (p.kind.startsWith('w_') || p.kind === 'p_cancel') p.quota = chance(0.7) ? ri(30, 80) * 10 : null;
    if (p.launchDate && weekday(p.launchDate) === 7) p.launchDate = addDays(p.launchDate, 1);
    if (p.launch !== null) p.launchDate = dateAt(p.launch);
    if (p.reqDay !== null && p.reqDay !== undefined) ev(p.reqDay, p.reqHm || hmOf(ri(9 * 60, 16 * 60 + 30)), () => sendRequest(p));
    if (p.kind === 'paused') { const from = LAST - ri(1, 2), to = LAST + ri(2, 4); ev(from - ri(3, 5), '10:15', () => p.siteId && api(p.sale, 'PATCH', `/api/hub/outlets/${p.siteId}`, { pause_from: dateAt(from), pause_to: dateAt(to), note: 'BO tạm nghỉ để sửa mặt bằng' })); }
    if (p.kind === 'ended') { const e = Math.min(LAST - 4, p.launch + ri(20, 27)); ev(e - ri(0, 2), '15:30', () => p.siteId && api(p.sale, 'POST', `/api/hub/outlets/${p.siteId}/end`, { date: dateAt(e), note: 'Hết hợp đồng ghi hình đợt này' })); }
    if (p.kind === 'ending1') ev(LAST - 1, '15:40', async () => { if (p.siteId && await api(p.sale, 'POST', `/api/hub/outlets/${p.siteId}/end`, { date: TODAY, note: 'BO đóng cửa chi nhánh, thu hồi máy' })) holdRecover.add(p.siteId); });
    if (p.kind === 'ending2') ev(LAST - 2, '16:10', () => p.siteId && api(p.sale, 'POST', `/api/hub/outlets/${p.siteId}/end`, { date: addDays(TODAY, 1), note: 'Kết thúc ghi hình theo yêu cầu của chủ BO' }));
  }
  const pastPause = plans.find((p) => p.kind === 'live' && p.launch <= LAST - 25 && !nearQ.includes(p) && !overQ.includes(p));
  if (pastPause) ev(pastPause.launch + 8, '10:30', () => pastPause.siteId && api(pastPause.sale, 'PATCH', `/api/hub/outlets/${pastPause.siteId}`, { pause_from: dateAt(pastPause.launch + 11), pause_to: dateAt(pastPause.launch + 13), note: 'Nghỉ lễ của BO' }));
  const planBySite = new Map();
  async function sendRequest(p) {
    const body = { need: p.need, launch_date: p.launchDate, swap_days: p.swapDays, swap_from: p.win[0], swap_to: p.win[1], note: pick(['BO mới, chủ quán muốn bắt đầu ghi hình trước cuối tuần', 'Mở thêm điểm theo hợp đồng khung', 'Khách hàng giới thiệu, ưu tiên launch đúng hẹn']) };
    if (p.siteId) body.site_id = p.siteId;
    else body.outlet = { name: p.nb.name, code: p.code, lat: p.nb.lat, lon: p.nb.lon, area: p.nb.area, address: `${p.nb.area}, TP.HCM (mô phỏng)`, contact: pick(['Quản lý cửa hàng', 'Chủ quán', 'Quản lý ca']), phone: `028 0000 ${2100 + p.i}`, business: p.business, quota_hours: p.quota || undefined, sale_id: p.byHos ? ids[p.sale] : undefined };
    const r = await api(p.byHos ? 'salehead' : p.sale, 'POST', '/api/hub/requests', body);
    if (!r) return;
    p.req = r.request.id; p.siteId = r.request.site.id;
    planBySite.set(p.siteId, p);
    if (p.site && p.quota) await api(p.sale, 'PATCH', `/api/hub/outlets/${p.siteId}`, { quota_hours: p.quota, contact: 'Quản lý cửa hàng' });
    if (p.hold) holdReq.add(p.req);
    if (p.partial) partialReq.add(p.req);
  }
  // BO có sẵn: mã, ngành hàng, khu vực (Quản trị), giao Sale phụ trách (Head of Sale).
  clock(at(D0, '05:45'));
  for (const p of plans) {
    if (!p.site) continue;
    planBySite.set(p.site.id, p);
    await api('admin', 'PATCH', `/api/hub/outlets/${p.site.id}`, { code: p.code, business: p.business, area: HD_AREA[p.site.name] || 'TP.HCM', contact: 'Quản lý cửa hàng' });
    await api('salehead', 'PATCH', `/api/hub/outlets/${p.site.id}`, { sale_id: ids[p.sale] });
  }

  // Kho: phụ kiện, thiết bị theo mã, thẻ nhớ, kit (đủ cho lúc cao điểm cộng dự phòng).
  clock(at(D0, '06:00'));
  const deployed = plans.filter((p) => !['ended', 'p_none', 'p_cancel', 'w_submitted'].includes(p.kind));
  const nMC = Math.max(Math.round(48 * S), deployed.reduce((a, p) => a + (p.need.multicam || 0), 0) + 8), nIP = Math.max(Math.round(12 * S), deployed.reduce((a, p) => a + (p.need.iphone || 0), 0) + 3);
  const nCards = Math.max(Math.round(260 * S), (nMC + nIP) * 4 + 20), spare = Math.max(2, Math.round(4 * S));
  const accIn = { hub_sac: nMC + 8, hub_sac_to: Math.round(6 * S) + 2, cap_c_c: 2 * nMC + 24, day_gan: nMC + 8, powerbank_cover: nMC + 4, sac_iphone: nIP + 6, headstrap: nIP + 6 };
  for (const [t, q] of Object.entries(accIn)) await api('lead', 'POST', `/api/hub/acc/${t}/move`, { kind: 'in', qty: q, reason: 'Nhập kho đầu kỳ theo biên bản kiểm kê' });
  const codes = (pre, from, n) => Array.from({ length: n }, (_, k) => `${pre}-${from + k}`);
  await api('lead', 'POST', '/api/hub/devices', { type: 'multicam', codes: codes('MC', 1001, nMC + spare), note: 'Lô nhập đầu kỳ' });
  await api('lead', 'POST', '/api/hub/devices', { type: 'cm5', codes: codes('CM5', 1001, nMC + spare), note: 'Lô nhập đầu kỳ' });
  await api('lead', 'POST', '/api/hub/devices', { type: 'iphone', codes: codes('IP', 2001, nIP + Math.max(1, Math.round(spare / 2))), note: 'Lô nhập đầu kỳ' });
  await api('lead', 'POST', '/api/hub/devices', { type: 'powerbank', codes: codes('PB', 3001, nMC + nIP + spare), note: 'Lô nhập đầu kỳ' });
  await api('lead', 'POST', '/api/hub/devices', { type: 'sd', codes: Array.from({ length: nCards }, (_, k) => `SD-${String(k + 1).padStart(4, '0')}`), note: 'Thẻ 256 GB' });
  for (let k = 0; k < nMC; k++) await api('lead', 'POST', '/api/hub/kits', { code: `KIT-M${String(k + 1).padStart(2, '0')}`, kind: 'multicam', acc: { hub_sac: 1, cap_c_c: 2, day_gan: 1, powerbank_cover: 1 }, devices: [`MC-${1001 + k}`, `CM5-${1001 + k}`, `PB-${3001 + k}`] });
  for (let k = 0; k < nIP; k++) await api('lead', 'POST', '/api/hub/kits', { code: `KIT-I${String(k + 1).padStart(2, '0')}`, kind: 'iphone', acc: { sac_iphone: 1, headstrap: 1 }, devices: [`IP-${2001 + k}`, `PB-${3001 + nMC + k}`] });

  // ───────── Bảng phân ca, chấm công, vòng làm việc của từng người ─────────
  const leave = new Set();
  for (const u of [...MEMBERS.logistics, ...MEMBERS.tech, 'lead', 'techlead']) for (let k = 0; k < (PROFN[u] === 'weak' ? 3 : 1); k++) leave.add(`${u}:${dateAt(ri(3, Math.max(4, LAST - 2)))}`);
  async function putRoster(w) {
    for (const [ld, team] of [['lead', 'logistics'], ['techlead', 'tech']]) {
      const rows = [];
      for (const u of [ld, ...MEMBERS[team]]) for (let k = 0; k < 7; k++) {
        const date = dateAt(w * 7 + k), isLead = u === ld;
        if (k === 6 || (isLead && k === 5)) continue; // Chủ nhật nghỉ; Lead nghỉ thứ Bảy
        if (leave.has(`${u}:${date}`)) { rows.push({ user_id: ids[u], date, kind: 'leave', note: 'Nghỉ phép năm' }); continue; }
        if (!isLead && chance(PROFN[u] === 'weak' ? 0.06 : 0.03)) continue; // nghỉ bù
        rows.push({ user_id: ids[u], date, shift: HD_PAT[u][w % 2] });
      }
      await api(ld, 'PUT', '/api/hub/roster', { rows });
    }
  }
  clock(at(D0, '06:10'));
  await putRoster(0);
  const ATT = [...MEMBERS.logistics, ...MEMBERS.tech, 'lead', 'techlead'];
  function planShift(u, d, i) {
    const r = store.roster.get(`${ids[u]}:${d}`);
    if (!r || r.kind === 'leave' || !r.start) return;
    const p = prof(u);
    if (chance(p.absent) && !(i >= LAST - 6 && PROFN[u] !== 'weak')) return; // vắng không báo: hệ thống tự ghi vắng và trả việc
    const tIn = at(d, r.start) + (chance(p.late) ? rr(11, 45) : rr(-14, 7)) * MIN;
    push(tIn, () => { const x = user(u); if (x) K.hooks.onSeen(x, T); });
    if (TEAM[u] && MEMBERS[TEAM[u]].includes(u)) push(tIn + rr(3, 12) * MIN, () => work(u, d, at(d, r.end)));
  }

  // Việc của mỗi người: chọn việc của mình theo độ gấp; làm xong mới chọn việc kế. Người chậm làm lâu hơn, hay ngồi chơi, để trễ hạn.
  const busy = new Set(), busyKit = new Set(), busyCard = new Set(), later = new Map(), manualToday = new Set(), swapKitTrip = new Map(), leaveOpen = new Set();
  const visible = (j, d) => !j.show_date || j.show_date <= d;
  const RANK = { cards_receive: 0, cards_back: 0, incident: 1, check_kit: 2, prep_kit: 2, receive_field: 2, deliver: 2, receive_back: 3, checkin: 3, swap_faulty: 3, card_swap: 4, qr_change: 4, repair: 5, deliver_acc: 5, manual: 6, stock_check: 7, cards_upload: 8 };
  const byRank = (a, b) => (b.priority || 0) - (a.priority || 0) || (RANK[a.type] ?? 9) - (RANK[b.type] ?? 9) || (a.due_at || 9e15) - (b.due_at || 9e15) || a.id - b.id;
  const complete = (k) => H.stock.completeness(k, H.stock.kitDevices(k.id)).complete;
  const inTrip = (kitId) => { const t = swapKitTrip.get(kitId); if (!t) return false; const tk = store.tasks.get(t); return !!tk && ['assigned', 'accepted', 'in_progress'].includes(tk.status); };
  /** Kit rảnh để gán cho yêu cầu: đã kiểm trước, rồi đang chuẩn bị, rồi kit thu hồi chờ check-in; đủ thành phần, không nằm trong chuyến. */
  function freeKits(kind) {
    const rank = { ready: 0, preparing: 1, returned: 2 };
    return store.kits.find({ kind, request_id: null, status: ['ready', 'preparing', 'returned'] }).filter((k) => !inTrip(k.id) && !busyKit.has(k.id) && complete(k)).sort((a, b) => rank[a.status] - rank[b.status] || a.code.localeCompare(b.code));
  }
  const spareKit = (kind, used) => { const h = heldNow(); return store.kits.find({ kind, status: 'ready', request_id: null }, { order: 'code' }).find((k) => !used.has(k.id) && !busyKit.has(k.id) && !inTrip(k.id) && !h.kits.has(k.id)); };
  /** Báo xong việc. Việc chưa bắt đầu có thể đã được hệ thống chuyển cho người khác (san việc khi có người vào ca, hết ca): người này thấy và thôi làm. */
  const done = (u, j, result) => { const x = store.jobs.get(j.id); if (x && x.assignee_id && x.assignee_id !== ids[u]) return null; return api(u, 'POST', `/api/hub/jobs/${j.id}/done`, { result: result || {} }); };

  async function work(u, d, endT) {
    if (T >= endT - 8 * MIN) return;
    const p = prof(u);
    if (chance(p.idle)) return push(T + rr(10, 45) * MIN, () => work(u, d, endT));
    const plan = (TEAM[u] === 'tech' ? techPick(u, d) : logPick(u, d)) || idlePick(u, d);
    if (!plan) return push(T + rr(12, 30) * MIN, () => work(u, d, endT));
    if (plan.jobId) busy.add(plan.jobId);
    for (const k of plan.kits || []) busyKit.add(k);
    for (const c of plan.cards || []) busyCard.add(c.id);
    if (plan.start) await plan.start();
    push(T + Math.max(1, plan.dur * p.speed * rr(0.8, 1.25)) * MIN, async () => {
      try { await plan.run(); } finally { if (plan.jobId) busy.delete(plan.jobId); for (const k of plan.kits || []) busyKit.delete(k); for (const c of plan.cards || []) busyCard.delete(c.id); }
      push(T + rr(1, 5) * MIN, () => work(u, d, endT));
    });
  }
  /** Việc / BO / kit / thẻ đang bị giữ sau chuyến (số FO / BO lệch kế hoạch): chỉ Logistic Lead làm tay theo thực tế. */
  function heldNow() {
    const x = { jobs: new Set(), sites: new Set(), kits: new Set(), cards: new Set(), list: [] };
    for (const r of store.recon.find({ status: 'open', source: ['trip', 'bo_confirm'] })) {
      if (typeof r.ref !== 'string' || !r.ref.startsWith('count:') || !r.data || !Array.isArray(r.data.jobs)) continue;
      if (!r.data.jobs.some((id) => OPEN.includes((store.jobs.get(id) || {}).status))) continue;
      x.list.push(r);
      for (const id of r.data.jobs) x.jobs.add(id);
      if (r.data.site_id) x.sites.add(r.data.site_id);
      for (const k of r.data.kits || []) x.kits.add(k);
      for (const c of r.data.cards || []) x.cards.add(c);
    }
    return x;
  }
  const heldOut = (j, h) => h.jobs.has(j.id) || (j.team === 'logistics' && FIELD.includes(j.type) && (h.sites.has(j.site_id) || (j.kit_id && h.kits.has(j.kit_id))));
  const mine = (u, d) => { const h = heldNow(); return store.jobs.find({ assignee_id: ids[u], status: OPEN }).filter((j) => !busy.has(j.id) && !leaveOpen.has(j.id) && !j.blocked && !j.task_id && !heldOut(j, h) && visible(j, d) && (later.get(j.id) || 0) <= T).sort(byRank); };
  function receivePlan(u, j, now) {
    const h = store.handovers.get(j.handover_id);
    if (!h || h.status !== 'sent') return null;
    if (!now && !later.has(j.id)) { later.set(j.id, j.created_at + rr(...prof(u).lag) * MIN); if (later.get(j.id) > T) return null; } // người chậm để phiếu chờ lâu hơn
    return {
      jobId: j.id, dur: 3 + (h.lines || 1) * 0.15, run: async () => {
        const hh = store.handovers.get(h.id);
        if (!hh || hh.status !== 'sent') return;
        const lines = store.handover_lines.find({ handover_id: h.id });
        if (lines.length > 3 && (chance(0.04) || (T >= at(dateAt(LAST - 1), '00:00') && !store.recon.count({ status: 'open', team: h.dir === 'to_tech' ? 'logistics' : 'tech' })))) { const gone = pick(lines); await api(u, 'POST', `/api/hub/handovers/${h.id}/receive`, { codes: lines.filter((l) => l.id !== gone.id).map((l) => l.code), missing_reason: 'Thiếu 1 thẻ so với phiếu, đã báo bên gửi tìm lại' }); }
        else await api(u, 'POST', `/api/hub/handovers/${h.id}/receive`, { all: true });
      },
    };
  }
  function techPick(u, d) {
    for (const j of mine(u, d)) {
      if (j.type === 'cards_receive') { const x = receivePlan(u, j); if (x) return x; continue; }
      if (j.type === 'cards_upload') {
        const cards = store.cards.find({ handover_id: j.handover_id, status: 'at_tech' }, { order: 'code' }).filter((c) => !busyCard.has(c.id)).slice(0, prof(u).batch);
        if (cards.length) return { jobId: j.id, cards, dur: cards.length * 1.3, run: () => upload(u, cards) };
        continue;
      }
      if (j.type === 'incident') {
        const inc = store.incidents.get(j.incident_id);
        if (!inc) continue;
        if (inc.status === 'open') return { jobId: j.id, dur: 2, run: async () => { if (await api(u, 'POST', `/api/hub/incidents/${inc.id}/ack`)) later.set(j.id, T + rr(20, 150) * prof(u).speed * MIN); } };
        if (inc.status === 'ack') return { jobId: j.id, dur: rr(10, 25), run: () => resolveInc(u, inc.id) };
        continue;
      }
      if (j.type === 'check_kit' || j.type === 'checkin') {
        const k = store.kits.get(j.kit_id);
        if (k && k.status === (j.type === 'check_kit' ? 'wait_check' : 'returned')) return { jobId: j.id, dur: j.type === 'check_kit' ? 15 : 12, start: j.status === 'open' ? () => api(u, 'POST', `/api/hub/jobs/${j.id}/start`) : null, run: () => checkKit(u, j) };
        continue;
      }
      if (j.type === 'repair') {
        if (!later.has(j.id)) { // sửa kit cần thời gian (chờ linh kiện, chạy thử); thỉnh thoảng báo vướng rồi gỡ khi có linh kiện
          const ready = Math.max(T, j.created_at + rr(6, 80) * prof(u).speed * HOUR);
          later.set(j.id, ready);
          if (chance(0.25)) return { jobId: j.id, dur: 2, run: async () => { if (await api(u, 'POST', `/api/hub/jobs/${j.id}/block`, { reason: 'Chờ linh kiện thay thế từ nhà cung cấp' })) push(ready - rr(0, 60) * MIN, () => unblock(u, j.id, 'techlead')); } };
          if (ready > T) continue;
        }
        const k = store.kits.get(j.kit_id);
        if (k && k.status === 'at_tech') return { jobId: j.id, dur: rr(35, 70), start: j.status === 'open' ? () => api(u, 'POST', `/api/hub/jobs/${j.id}/start`) : null, run: () => repair(u, j) };
        continue;
      }
      if (j.type === 'qr_change') return { jobId: j.id, dur: 10, run: () => done(u, j, { note: 'Đã dán QR mới, BO quét thử được' }) };
      if (j.type === 'manual') return { jobId: j.id, dur: rr(15, 35), run: () => done(u, j, { note: 'Đã xử lý xong' }) };
    }
    return null;
  }
  function logPick(u, d) {
    for (const j of mine(u, d)) {
      if (j.type === 'cards_back') { const x = receivePlan(u, j); if (x) return x; continue; }
      if (j.type === 'receive_field' || j.type === 'receive_back') {
        const k = store.kits.get(j.kit_id);
        if (!k || k.status !== (j.type === 'receive_field' ? 'recovering' : 'tech_done')) continue;
        return { jobId: j.id, dur: j.type === 'receive_field' ? 6 : 4, run: () => receiveKit(u, j) };
      }
      if (j.type === 'prep_kit') { const x = prepPlan(u, j); if (x) return x; continue; }
      if (j.type === 'stock_check') { if (T < at(d, '14:00')) continue; return { jobId: j.id, dur: 25, run: () => stockCheck(u, j) }; }
      if (j.type === 'manual') return { jobId: j.id, dur: rr(15, 40), run: () => done(u, j, { note: j.site_id ? 'Đã tới BO xử lý, BO xác nhận ổn' : 'Đã làm xong' }) };
      if (manualToday.has(j.id)) return { jobId: j.id, dur: rr(45, 90), run: () => manualField(u, j.id, d) };
    }
    return null;
  }
  /** Không còn việc của mình: nhận việc đang để chung, hoặc (Logistics) chuẩn bị sẵn kit dự phòng. */
  function idlePick(u, d) {
    const team = TEAM[u], weak = PROFN[u] === 'weak';
    if (!weak || chance(0.3)) {
      const pool = store.jobs.find({ team, assignee_id: null, status: 'open', type: DESK }).filter((j) => visible(j, d) && !leaveOpen.has(j.id) && !j.blocked && !j.task_id && !busy.has(j.id)).sort(byRank)[0];
      if (pool) return { jobId: pool.id, dur: 1, run: () => api(u, 'POST', `/api/hub/jobs/${pool.id}/claim`) };
    }
    if (team === 'tech') { // rảnh thì nhập giúp thẻ đang chờ (ai nhập người đó được tính)
      if (weak && !chance(0.3)) return null;
      const cards = store.cards.find({ status: 'at_tech' }, { order: 'code' }).filter((c) => !busyCard.has(c.id)).slice(0, prof(u).batch);
      return cards.length ? { cards, dur: cards.length * 1.3, run: () => upload(u, cards) } : null;
    }
    for (const kind of ['multicam', 'iphone']) {
      if (store.kits.count({ kind, request_id: null, status: ['ready', 'wait_check'] }) >= (kind === 'multicam' ? Math.max(3, Math.round(4 * S)) : 2)) continue;
      const k = store.kits.find({ kind, request_id: null, status: 'preparing' }, { order: 'code' }).find((x) => !busyKit.has(x.id) && complete(x));
      if (k) return { kits: [k.id], dur: 15, run: async () => { const x = store.kits.get(k.id); if (x && x.status === 'preparing' && !x.request_id) await api(u, 'POST', `/api/hub/kits/${k.id}/submit`); } };
    }
    return null;
  }
  async function unblock(u, jobId, ld) {
    const j = store.jobs.get(jobId);
    if (!j || !OPEN.includes(j.status) || !j.blocked) return;
    if (!(await api(j.assignee_id === ids[u] ? u : ld, 'POST', `/api/hub/jobs/${jobId}/unblock`, { note: 'Đã có linh kiện' })) && j.assignee_id) await api(j.assignee_id, 'POST', `/api/hub/jobs/${jobId}/unblock`, { note: 'Đã có linh kiện' });
  }
  function prepPlan(u, j) {
    const r = store.requests.get(j.request_id);
    if (!r || !['submitted', 'preparing', 'ready'].includes(r.status) || holdReq.has(r.id)) return null;
    const have = store.kits.find({ request_id: r.id });
    let room = partialReq.has(r.id) ? Math.max(0, 1 - have.length) : 99;
    const picks = [];
    for (const kind of ['multicam', 'iphone']) {
      let need = (r.need[kind] || 0) - have.filter((k) => (k.kind === 'iphone') === (kind === 'iphone')).length;
      for (const k of need > 0 && room > 0 ? freeKits(kind) : []) { if (need <= 0 || room <= 0) break; picks.push(k); need--; room--; }
    }
    const pend = have.filter((k) => ['preparing', 'returned'].includes(k.status) && !busyKit.has(k.id));
    if (!picks.length && !pend.length) { later.set(j.id, T + 90 * MIN); return null; }
    return {
      jobId: j.id, kits: [...picks, ...pend].map((k) => k.id), dur: 8 + 10 * (picks.length + pend.length), start: j.status === 'open' ? () => api(u, 'POST', `/api/hub/jobs/${j.id}/start`) : null,
      run: async () => {
        const free = picks.filter((k) => { const x = store.kits.get(k.id); return x && !x.request_id && !inTrip(k.id) && ['ready', 'preparing', 'returned'].includes(x.status); });
        if (free.length) await api(u, 'POST', `/api/hub/requests/${r.id}/assign`, { kit_ids: free.map((k) => k.id) });
        for (const k of store.kits.find({ request_id: r.id, status: ['preparing', 'returned'] })) await api(u, 'POST', `/api/hub/kits/${k.id}/submit`);
        later.set(j.id, T + 60 * MIN);
      },
    };
  }
  async function receiveKit(u, j) {
    const k = store.kits.get(j.kit_id);
    if (j.type === 'receive_back') return k && k.status === 'tech_done' ? done(u, j) : null;
    if (!k || k.status !== 'recovering') return null;
    const keys = Object.keys(k.acc || {});
    if (keys.length && chance(0.05)) { const acc = { ...k.acc }, t = pick(keys); acc[t] = Math.max(0, acc[t] - 1); return done(u, j, { acc }); } // thiếu phụ kiện khi thu hồi → Đối chiếu
    return done(u, j);
  }
  async function stockCheck(u, j) {
    const diff = chance(0.3);
    await done(u, j, { note: 'Đếm kit, thẻ và phụ kiện theo kệ', diff: diff ? 'Thiếu 1 dây Type-C to C so với sổ' : '' });
    if (diff) push(T + rr(40, 150) * MIN, () => api('lead', 'POST', '/api/hub/acc/cap_c_c/move', { kind: 'count', free_counted: Math.max(0, H.stock.accFree('cap_c_c') - 1), reason: 'Kiểm kê: thiếu 1 dây Type-C to C so với sổ' }));
  }
  /** Việc ngoài hiện trường Logistics tự đi làm trong ngày (không qua chuyến FO). */
  async function manualField(u, jobId, d) {
    const j = store.jobs.get(jobId);
    if (!j || !OPEN.includes(j.status) || j.task_id) return;
    if (heldOut(j, heldNow())) { manualToday.delete(j.id); return; }
    if (j.type === 'card_swap') { if (await done(u, j, { cards_out: takeCards(store.kits.count({ site_id: j.site_id, status: 'at_bo' }) * 2, new Set()) })) noteCards(j.site_id); return; }
    if (j.type === 'deliver') return done(u, j, { doc_code: `BB-${d.slice(2).replace(/-/g, '')}-${ri(100, 999)}`, cards_out: launchCards(j, new Set()) });
    if (j.type === 'deliver_acc') return done(u, j);
    if (j.type === 'swap_faulty') { const old = store.kits.get(j.kit_id), nk = old && spareKit(old.kind, new Set()); if (nk) return done(u, j, { new_kit_id: nk.id }); manualToday.delete(j.id); }
  }
  async function checkKit(u, j) {
    const k = store.kits.get(j.kit_id);
    if (!k || k.status !== (j.type === 'check_kit' ? 'wait_check' : 'returned')) return;
    const devs = H.stock.kitDevices(k.id);
    const pass = chance(j.type === 'check_kit' ? 0.86 : 0.8);
    const bad = pass ? null : pick(devs.filter((x) => x.type !== 'powerbank')) || devs[0];
    const why = pick(['Cổng sạc lỏng', 'Pin phồng nhẹ', 'Không nhận thẻ nhớ', 'Mất kết nối khi chạy thử 15 phút', 'Nút nguồn kẹt']);
    const devices = devs.map((x) => ({ id: x.id, ok: !bad || x.id !== bad.id, note: bad && x.id === bad.id ? why : '', ...(x.type === 'powerbank' ? { health: chance(0.85) ? 'good' : 'weak' } : {}) }));
    await done(u, j, { pass, devices, note: bad ? `${bad.code}: ${why}` : '' });
  }
  async function repair(u, j) {
    const k = store.kits.get(j.kit_id);
    if (!k || k.status !== 'at_tech') return;
    const bad = H.stock.kitDevices(k.id).filter((x) => x.cond !== 'ok');
    let note = pick(['Vệ sinh tiếp điểm, thay cáp, chạy thử 2 giờ ổn định', 'Cập nhật firmware và cấu hình lại', 'Thay đầu nối, ghi thử đạt']);
    if (bad.length && chance(0.35)) { // thay thiết bị hỏng bằng thiết bị dự phòng trong kho
      const sp = store.devices.find({ type: bad[0].type, kit_id: null, cond: 'ok' }, { order: 'code', limit: 1 })[0];
      if (sp && (await api(u, 'PATCH', `/api/hub/kits/${k.id}`, { remove: [bad[0].id], add: [sp.code] }))) note = `Thay ${bad[0].code} bằng ${sp.code} dự phòng`;
    }
    const left = H.stock.kitDevices(k.id).filter((x) => x.cond !== 'ok');
    await done(u, j, { devices: left.map((x) => ({ id: x.id, ok: true })), note, cause: pick(['Hao mòn', 'Va đập', 'Lỗi phần mềm', 'Nhiệt độ cao']) });
  }
  async function resolveInc(u, incId) {
    const inc = store.incidents.get(incId);
    if (!inc || inc.status !== 'ack') return;
    const kit = inc.kit_id ? store.kits.get(inc.kit_id) : null;
    let res = wpick({ no_recover: 58, swap: 22, office_repair: 9, invalid: 11 });
    if ((res === 'swap' || res === 'office_repair') && !(kit && kit.status === 'at_bo' && kit.site_id === inc.site_id)) res = 'no_recover';
    await api(u, 'POST', `/api/hub/incidents/${incId}/resolve`, { resolution: res, note: pick(HD_FIX[res]) });
  }

  // ───────── Thẻ nhớ: bàn giao Logistics ↔ Tech, nhập dung lượng ─────────
  // Mã thẻ → { kit, idx, per }: thẻ thứ idx trong per thẻ của một kit ở lượt đặt thẻ; kit ghi lần lượt từng thẻ, mỗi thẻ một phần các ngày tới lượt đổi sau.
  const cardMeta = new Map();
  function noteCards(siteId) {
    const here = store.cards.find({ site_id: siteId, status: 'at_bo' }, { order: 'code' });
    const kits = store.kits.find({ site_id: siteId, status: 'at_bo' }, { order: 'code' });
    const fresh = here.filter((c) => { const m = cardMeta.get(c.code); return !m || m.bo_in !== c.bo_in; });
    const nk = Math.max(1, kits.length);
    fresh.forEach((c, k) => cardMeta.set(c.code, { bo_in: c.bo_in, kit: kits.length ? kits[k % nk].id : null, idx: Math.floor(k / nk), per: Math.floor(fresh.length / nk) + (k % nk < fresh.length % nk ? 1 : 0) }));
  }
  function takeCards(n, used) {
    if (n <= 0) return [];
    const h = heldNow();
    const out = store.cards.find({ status: 'office', task_id: null }, { order: 'since', limit: n + used.size + h.cards.size + 20 }).filter((c) => !used.has(c.code) && !h.cards.has(c.code)).slice(0, n).map((c) => c.code);
    for (const c of out) used.add(c);
    return out;
  }
  /** Thẻ để sẵn trong kit khi giao launch (thỉnh thoảng quên ghi mã → vào Đối chiếu). */
  const launchCards = (j, used) => chance(0.04) ? [] : takeCards(store.kits.count({ request_id: j.request_id, status: ['reserved', 'delivering'] }) * H.cfg().cardsPerKit, used);
  async function sendCards(dir) {
    const who = dir === 'to_tech' ? shiftOf('logistics') : shiftOf('tech');
    if (!who) return;
    const list = store.cards.find({ status: dir === 'to_tech' ? 'returned' : 'uploaded' }, { order: 'code' }).map((c) => c.code);
    const r = list.length ? await api(who, 'POST', '/api/hub/handovers', { dir, codes: list, note: dir === 'to_tech' ? 'Thẻ thu về từ các chuyến trong ngày' : 'Thẻ đã nhập dung lượng, trả Logistics' }) : null;
    // Bên nhận ngưng việc đang làm để nhận phiếu khi bên gửi mang thẻ tới (người chậm để lâu hơn).
    const j = r && store.jobs.find({ handover_id: r.handover.id, status: 'open' }, { limit: 1 })[0];
    const rc = j && j.assignee_id && store.users.get(j.assignee_id);
    if (rc && TEAM[rc.username] && onShift(rc.id)) push(T + rr(...prof(rc.username).lag) * MIN, async () => {
      const x = store.jobs.get(j.id);
      if (!x || x.status !== 'open' || busy.has(x.id) || x.assignee_id !== rc.id) return;
      const plan = receivePlan(rc.username, x, true);
      if (!plan) return;
      busy.add(x.id);
      push(T + plan.dur * prof(rc.username).speed * MIN, async () => { try { await plan.run(); } finally { busy.delete(x.id); } });
    });
  }
  const shootDays = (s, a, b) => { const out = []; for (let x = a; x < b; x = addDays(x, 1)) if (!(s && s.pause_from && s.pause_to && x >= s.pause_from && x <= s.pause_to)) out.push(x); return out; };
  /** GB của một thẻ: các ngày từ lúc đặt thẻ tới lượt đổi sau (trừ ngày tạm nghỉ) chia đều cho các thẻ của kit, giờ = nhịp quay × số ngày. Ngày quay để máy chủ tự điền như màn hình nhập. */
  function recordOf(c) {
    const s = store.sites.get(c.site_id), p = planBySite.get(c.site_id);
    const m = cardMeta.get(c.code) || { kit: null, idx: 0, per: 1 };
    const from = c.bo_in ? localDate(c.bo_in, off) : addDays(localDate(T, off), -1);
    const until = c.bo_out ? localDate(c.bo_out, off) : localDate(T, off);
    const all = shootDays(s, from, until), per = Math.max(1, m.per), base = Math.floor(all.length / per), extra = all.length % per;
    const start = m.idx * base + Math.min(m.idx, extra), part = all.slice(start, start + base + (m.idx < extra ? 1 : 0)); // ngày dư dồn cho thẻ đầu
    const days = all.length >= per ? part.length : m.idx < per ? (all.length || (from === until ? 0.5 : 0)) / per : 0; // đổi thẻ mỗi ngày: mỗi thẻ ghi một phần ngày
    const rec = { card_id: c.id };
    if (m.kit && store.kits.get(m.kit)) rec.kit_id = m.kit;
    if (!days) return { ...rec, gb: 0, zero_reason: all.length ? 'Thẻ chưa dùng' : 'BO đóng cửa / nghỉ' };
    if (chance(p ? p.zeroP : 0.04)) return { ...rec, gb: 0, zero_reason: wpick(HD_ZERO) };
    const hours = Math.min(15.2, (p ? p.rate : 6) * days * rr(0.82, 1.18)); // thẻ đầy thì dừng ghi
    return { ...rec, gb: +(hours * H.cfg().gbPerHour).toFixed(1) };
  }
  async function upload(u, cards) {
    const recs = [];
    for (const c0 of cards) {
      const c = store.cards.get(c0.id);
      if (!c || c.status !== 'at_tech') continue;
      if (chance(0.007)) { await api(u, 'PATCH', `/api/hub/cards/${c.id}`, { status: 'bad', reason: 'Thẻ lỗi, đầu đọc không nhận' }); continue; }
      recs.push(recordOf(c));
    }
    if (recs.length) await api(u, 'POST', '/api/hub/cards/records', { records: recs });
  }

  // ───────── Chuyến FO: gom việc ngoài hiện trường, chạy từng điểm, BO xác nhận qua link ─────────
  const trips = new Map(), foFree = new Map();
  let foRot = 0;
  const FO_SPEED = new Map(fos.map((u, i) => [u.id, 27 - (8 * i) / Math.max(1, fos.length - 1)]));
  const sim = new Map(fos.map((u) => [u.id, { lat: office.lat, lon: office.lon, leg: null, bat: rr(0.7, 1), lastPing: 0 }]));
  function posOf(foId) {
    const s = sim.get(foId);
    if (!s.leg) return { lat: s.lat, lon: s.lon };
    const { a, b, t0, t1 } = s.leg, f = Math.max(0, Math.min(1, (T - t0) / Math.max(1, t1 - t0)));
    return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
  }
  function ping(foId) {
    const s = sim.get(foId);
    if (T - s.lastPing < 1500) return;
    s.lastPing = T; s.bat = Math.max(0.2, s.bat - 0.003);
    const p = posOf(foId);
    core.ingest(foId, { ts: T, lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), acc: ri(4, 14), spd: s.leg ? +(rr(3, 8)).toFixed(1) : 0, bat: +s.bat.toFixed(2) }, T);
  }
  function route(list) { // láng giềng gần nhất, xuất phát từ văn phòng
    const out = [], left = [...list];
    let cur = office;
    while (left.length) { let bi = 0, bd = Infinity; left.forEach((p, i) => { const dd = distM(cur.lat, cur.lon, p.lat, p.lon); if (dd < bd) { bd = dd; bi = i; } }); cur = left.splice(bi, 1)[0]; out.push(cur); }
    return out;
  }
  function clusters(siteIds) {
    const pts = siteIds.map((id) => { const s = store.sites.get(id); return { id, lat: s.lat, lon: s.lon, b: bearingDeg(office.lat, office.lon, s.lat, s.lon) }; }).sort((a, b) => a.b - b.b);
    const n = Math.max(1, Math.ceil(pts.length / 4.5)), size = Math.ceil(pts.length / n), out = [];
    for (let i = 0; i < pts.length; i += size) out.push(route(pts.slice(i, i + size)));
    return out;
  }
  function chooseFo(base) {
    for (let k = 0; k < fos.length; k++) { const fo = fos[(foRot + k) % fos.length]; if ((foFree.get(fo.id) || 0) <= base - 10 * MIN) { foRot = (foRot + k + 1) % fos.length; return { fo, startAt: base }; } }
    const fo = [...fos].sort((a, b) => (foFree.get(a.id) || 0) - (foFree.get(b.id) || 0))[0];
    return { fo, startAt: Math.max(base, (foFree.get(fo.id) || 0) + 15 * MIN) };
  }
  const MANUAL_P = { card_swap: 0.15, deliver: 0.25, deliver_acc: 0.35, swap_faulty: 0.1 };
  async function planTrips(d, slot, only) {
    const disp = shiftOf('logistics') || 'lead';
    const hd = heldNow();
    const cand = (only || store.jobs.find({ team: 'logistics', status: 'open', type: FIELD })).filter((j) => !j.task_id && !j.blocked && !heldOut(j, hd) && visible(j, d) && !manualToday.has(j.id) && !busy.has(j.id)).sort((a, b) => (a.due_at || 9e15) - (b.due_at || 9e15) || a.id - b.id);
    const picked = [], swapKits = {}, usedKit = new Set(), accNeed = {};
    for (const j of cand) {
      const s = store.sites.get(j.site_id);
      if (!s || s.lat === null) continue;
      if (j.type === 'card_swap' && (j.date > d || (slot === 'am' && j.date === d && (s.swap_from || '12:00') >= '12:00') || !store.kits.count({ site_id: s.id, status: 'at_bo' }))) continue;
      if (j.type === 'deliver') { const r = store.requests.get(j.request_id); if (!r || r.status !== 'ready' || r.launch_date > d) continue; }
      if (j.type === 'recover' && holdRecover.has(j.site_id)) continue;
      if (j.type === 'deliver_acc' && store.jobs.count({ type: 'swap_faulty', kit_id: j.kit_id, status: OPEN })) continue;
      if (!only && MANUAL_P[j.type] && chance(MANUAL_P[j.type])) { // Logistics tự đi làm (BO gần, việc gấp); việc chưa ai giữ thì người trong ca nhận, người làm tốt hay nhận hơn
        if (j.assignee_id && onShift(j.assignee_id)) { manualToday.add(j.id); continue; }
        const vol = !j.assignee_id && MEMBERS.logistics.filter(onShift);
        if (vol && vol.length) { const w = {}; for (const x of vol) w[x] = { strong: 4, avg: 2, weak: 1 }[PROFN[x]] || 2; if (await api(wpick(w), 'POST', `/api/hub/jobs/${j.id}/claim`)) { manualToday.add(j.id); continue; } }
      }
      if (j.type === 'swap_faulty') { const old = store.kits.get(j.kit_id), nk = old && spareKit(old.kind, usedKit); if (!nk) continue; usedKit.add(nk.id); swapKits[j.id] = nk.id; }
      if (j.type === 'deliver_acc') {
        const r = store.requests.get(j.request_id), need = (r && r.need && r.need.acc) || {};
        if (Object.entries(need).some(([t, q]) => H.stock.accFree(t) < (accNeed[t] || 0) + q)) continue;
        for (const [t, q] of Object.entries(need)) accNeed[t] = (accNeed[t] || 0) + q;
      }
      picked.push(j);
    }
    if (!picked.length) return 0;
    const bySite = new Map();
    for (const j of picked) { if (!bySite.has(j.site_id)) bySite.set(j.site_id, []); bySite.get(j.site_id).push(j); }
    const usedCards = new Set();
    let k = 0, made = 0;
    for (const g of clusters([...bySite.keys()])) {
      const jobIds = g.flatMap((p) => bySite.get(p.id).map((j) => j.id)).slice(0, 15);
      const cardsOut = {}, lCards = {};
      for (const p of g) {
        const here = bySite.get(p.id), dl = here.find((j) => j.type === 'deliver');
        if (here.some((j) => j.type === 'card_swap')) { cardsOut[p.id] = takeCards(store.kits.count({ site_id: p.id, status: 'at_bo' }) * 2, usedCards); if (dl) lCards[p.id] = launchCards(dl, usedCards); }
        else if (dl) cardsOut[p.id] = launchCards(dl, usedCards);
      }
      const sk = {};
      for (const id of jobIds) if (swapKits[id]) sk[id] = swapKits[id];
      const base = slot === 'now' ? T + 3 * MIN : at(d, slot === 'am' ? '08:30' : '13:30') + (k * 6 + ri(0, 8)) * MIN;
      const { fo, startAt } = chooseFo(base);
      k++;
      if (localDate(startAt, off) !== d) continue;
      const r = await api(disp, 'POST', '/api/hub/dispatch', { job_ids: jobIds, fo_id: fo.id, office_site_id: office.id, round_trip: true, swap_kits: sk, cards_out: cardsOut, launch_cards: lCards, date: d, start_time: localHM(startAt, off) });
      if (!r) continue;
      const task = r.task;
      for (const id of Object.values(sk)) swapKitTrip.set(id, task.id);
      trips.set(task.id, { fo: fo.id, disp, speed: FO_SPEED.get(fo.id), links: new Map(), active: false, retry: 0 });
      foFree.set(fo.id, task.start_at + (task.due_at - task.start_at) * 1.4 + 20 * MIN);
      made++;
      push(T + rr(2, 12) * MIN, () => store.tasks.get(task.id).status === 'assigned' && api(fo.id, 'POST', `/api/tasks/${task.id}/accept`));
      push(Math.max(T + (slot === 'now' ? 2 : 15) * MIN, task.start_at + rr(-2, 6) * MIN), () => tripStart(task.id));
    }
    return made;
  }
  async function tripStart(taskId) {
    const tp = trips.get(taskId), task = store.tasks.get(taskId);
    if (!task || !['assigned', 'accepted'].includes(task.status)) return;
    if (task.status === 'assigned') await api(tp.fo, 'POST', `/api/tasks/${taskId}/accept`);
    const s = sim.get(tp.fo);
    s.leg = null; s.lat = office.lat; s.lon = office.lon;
    ping(tp.fo);
    if (!(await api(tp.fo, 'POST', `/api/tasks/${taskId}/start`))) { // FO còn chuyến trước: lùi lại, quá 3 lần thì huỷ, việc tự về danh sách chờ
      if (++tp.retry > 3) await api(tp.disp, 'POST', `/api/tasks/${taskId}/cancel`, { reason: 'FO bận chuyến trước, gom lại ở chuyến sau' });
      else push(T + 20 * MIN, () => tripStart(taskId));
      return;
    }
    tp.active = true;
    const stops = store.stops.find({ task_id: taskId }, { order: 'seq' });
    for (const st of stops) if (st.bo_req) { const l = await api(tp.disp, 'POST', `/api/stops/${st.id}/bo-link`); if (l) tp.links.set(st.id, l.token); }
    push(T + rr(4, 10) * MIN, () => proof(taskId, stops[0].id)); // nhận kit, thẻ tại văn phòng
  }
  async function nextStop(taskId) {
    const tp = trips.get(taskId), task = store.tasks.get(taskId);
    if (!task || task.status !== 'in_progress') { tp.active = false; return; }
    const stops = store.stops.find({ task_id: taskId }, { order: 'seq' });
    const wait = stops.find((x) => x.status === 'done' && x.bo_status === 'pending');
    if (wait) return push(T + 3 * MIN, () => boStep(taskId, wait.id, true));
    const st = stops.find((x) => !x.is_return && (x.status === 'pending' || x.status === 'arrived')) || stops.find((x) => x.is_return && x.status === 'pending');
    if (!st) { tp.active = false; return; }
    const s = sim.get(tp.fo), cur = posOf(tp.fo), dist = distM(cur.lat, cur.lon, st.lat, st.lon);
    const mins = dist < 80 ? 0.5 : ((dist / 1000) * 1.35 / tp.speed) * 60 + rr(1, 5);
    s.leg = { a: cur, b: { lat: st.lat, lon: st.lon }, t0: T, t1: T + mins * MIN };
    push(s.leg.t1, async () => {
      s.leg = null; s.lat = st.lat; s.lon = st.lon;
      ping(tp.fo); // vào vùng của điểm: hệ thống tự ghi "đã đến"
      push(T + (st.is_return ? rr(1, 3) : rr(3, 9)) * MIN, () => proof(taskId, st.id));
    });
  }
  async function proof(taskId, stopId) {
    const tp = trips.get(taskId), task = store.tasks.get(taskId), st = store.stops.get(stopId);
    if (!task || task.status !== 'in_progress') { tp.active = false; return; }
    if (!['pending', 'arrived'].includes(st.status)) return push(T + MIN, () => nextStop(taskId));
    ping(tp.fo);
    const types = ((st.hub && st.hub.jobs) || []).map((id) => (store.jobs.get(id) || {}).type);
    if (st.bo_req && chance(0.02)) {
      await api(tp.fo, 'POST', `/api/stops/${stopId}/fail`, { reason: pick(['BO đóng cửa, gọi không ai nghe máy', 'Quản lý BO vắng, nhân viên không cho nhận máy']) });
      return push(T + rr(1, 3) * MIN, () => nextStop(taskId));
    }
    const atBo = st.bo_req ? store.cards.count({ site_id: st.site_id, status: 'at_bo' }) : 0;
    const cardsIn = types.includes('card_swap') || types.includes('recover') ? Math.max(0, atBo - (atBo && chance(0.03) ? 1 : 0)) : st.exp_cards_in;
    const ok = await api(tp.fo, 'POST', `/api/stops/${stopId}/proof`, { photos: st.is_return ? [] : [st.exp_dev_out + st.exp_dev_in ? DEMO_PHOTO_KIT : DEMO_PHOTO_FO], cards_out: st.exp_cards_out, cards_in: cardsIn, dev_out: st.exp_dev_out, dev_in: st.exp_dev_in, note: cardsIn < atBo ? 'BO đưa thiếu 1 thẻ' : '' });
    if (!ok) { await api(tp.fo, 'POST', `/api/stops/${stopId}/fail`, { reason: 'Không xác nhận được trên ứng dụng, Logistics xử lý sau' }); return push(T + MIN, () => nextStop(taskId)); }
    if (st.is_return) { tp.active = false; return; }
    if (st.bo_req) { const waive = !tp.links.has(stopId) || chance(0.05); push(T + (waive ? rr(8, 16) : rr(1, 6)) * MIN, () => boStep(taskId, stopId, waive)); }
    else push(T + rr(1, 3) * MIN, () => nextStop(taskId));
  }
  async function boStep(taskId, stopId, waive) {
    const tp = trips.get(taskId), st = store.stops.get(stopId);
    if (st.status === 'done' && st.bo_status === 'pending') {
      ping(tp.fo);
      let ok = false;
      const tok = tp.links.get(stopId);
      if (!waive && (await boApi(st.site_id, '/api/bo-link/view', { token: tok }))) {
        const lost = st.cards_out > 0 && chance(0.06) ? 1 : 0; // BO đếm thiếu → lệch số, vào Đối chiếu
        ok = !!(await boApi(st.site_id, '/api/bo-link/confirm', { token: tok, photos: [DEMO_PHOTO_BO], cards_recv: st.cards_out - lost, cards_given: st.cards_in, dev_recv: st.dev_out, dev_given: st.dev_in, note: lost ? 'Đếm lại thấy thiếu 1 thẻ' : '' }));
      }
      if (!ok) await api(tp.disp, 'POST', `/api/stops/${stopId}/bo-waive`, { reason: pick(['BO không mở được link, đã gọi điện xác nhận số lượng', 'Điện thoại của BO hết pin, Logistic xác nhận qua cuộc gọi']) });
      if (st.site_id) noteCards(st.site_id);
    }
    push(T + rr(1, 3) * MIN, () => nextStop(taskId));
  }

  // ───────── Sale, sự cố, hỗ trợ, đối chiếu, hộp thư ─────────
  const liveKits = () => store.kits.find({ status: 'at_bo' }).filter((k) => { const s = store.sites.get(k.site_id); return s && s.ops_status === 'live'; });
  async function raiseIncident(i, force) {
    const kits = liveKits();
    if (!kits.length) return;
    let kit = force ? pick(kits.filter((k) => k.kind === 'multicam')) : pick(kits);
    if (!kit) return;
    const site = store.sites.get(kit.site_id);
    if (!force && chance(0.1)) kit = null; // sự cố không rõ kit (BO báo chung)
    const w = { ...HD_LABEL_W[kit ? kit.kind : 'multicam'] };
    if (i >= LAST - 9) { if (w['Quá nhiệt']) w['Quá nhiệt'] *= 5; if (w['CM5 mất kết nối']) w['CM5 mất kết nối'] *= 3; }
    let label = force || wpick(w);
    for (let k = 0; k < 4 && store.incidents.count({ site_id: site.id, kit_id: kit ? kit.id : null, label, status: ['open', 'ack'] }); k++) label = wpick(w);
    const p = planBySite.get(site.id);
    const ownSale = p && site.sale_id === ids[p.sale] ? p.sale : null;
    const who = (ownSale && chance(0.4) && ownSale) || (chance(0.5) ? shiftOf('logistics') : shiftOf('tech')) || shiftOf('tech') || 'techlead';
    await api(who, 'POST', '/api/hub/incidents', { site_id: site.id, kit_id: kit ? kit.id : null, label, text: HD_INC_TEXT[label] || `${label}: BO báo qua điện thoại, cần Tech kiểm tra.`, urgent: chance(0.12), photos: chance(0.5) ? [DEMO_PHOTO_KIT] : [] });
  }
  async function support(kind) {
    const kits = liveKits();
    if (!kits.length) return;
    const kit = pick(kits), site = store.sites.get(kit.site_id), p = planBySite.get(site.id);
    const who = p && site.sale_id === ids[p.sale] && chance(0.6) ? p.sale : shiftOf('logistics') || 'lead';
    if (kind === 'extra_acc') {
      if (store.jobs.count({ type: ['deliver_acc', 'swap_faulty'], kit_id: kit.id, status: OPEN })) return;
      const acc = kit.kind === 'iphone' ? pick([{ sac_iphone: 1 }, { headstrap: 1 }]) : pick([{ cap_c_c: 2 }, { hub_sac: 1 }, { day_gan: 1 }, { cap_c_c: 1, day_gan: 1 }]);
      return api(who, 'POST', `/api/hub/outlets/${site.id}/support`, { kind, acc, kit_id: kit.id, note: 'BO báo thiếu phụ kiện, cần bổ sung ở lượt ghé gần nhất' });
    }
    if (kind === 'bad_card') return api(who, 'POST', `/api/hub/outlets/${site.id}/support`, { kind, note: 'Một thẻ báo lỗi đọc, BO cần thẻ thay' });
    if (!p || site.sale_id !== ids[p.sale] || store.jobs.count({ type: 'swap_faulty', kit_id: kit.id, status: OPEN })) return;
    return api(p.sale, 'POST', `/api/hub/outlets/${site.id}/support`, { kind: 'swap_device', kit_id: kit.id, label: kit.kind === 'iphone' ? 'Không ghi hình' : 'Không lên nguồn', note: 'BO báo máy chập chờn nhiều lần trong tuần, xin đổi máy' });
  }
  /** Logistic Lead làm tay việc bị giữ sau chuyến theo mã kit / thẻ thực tế (điểm tính cho người được giao); xong hết thì dòng Đối chiếu tự đóng. */
  async function settleHeldJobs() {
    for (const r of heldNow().list) {
      for (const id of r.data.jobs) {
        const j = store.jobs.get(id);
        if (!j || !OPEN.includes(j.status)) continue;
        let result = null;
        if (j.type === 'deliver') result = { kit_ids: store.kits.find({ request_id: j.request_id, status: ['reserved', 'delivering'] }).map((k) => k.id), cards_out: takeCards(store.kits.count({ request_id: j.request_id, status: ['reserved', 'delivering'] }) * H.cfg().cardsPerKit, new Set()), note: 'Gọi BO đếm lại, chốt theo thực tế' };
        else if (j.type === 'card_swap') result = { cards_out: takeCards(store.kits.count({ site_id: j.site_id, status: 'at_bo' }) * H.cfg().cardsPerKit, new Set()), cards_in: store.cards.find({ site_id: j.site_id, status: 'at_bo' }).map((c) => c.code) };
        else if (j.type === 'recover') result = { kit_ids: store.kits.find({ site_id: j.site_id, status: 'at_bo' }).map((k) => k.id) };
        else if (j.type === 'swap_faulty') { const old = store.kits.get(j.kit_id), nk = old && spareKit(old.kind, new Set()); if (nk) result = { new_kit_id: nk.id }; }
        if (result && (await api('lead', 'POST', `/api/hub/jobs/${id}/done`, { result, credit_assignee: true })) && j.type === 'card_swap') noteCards(j.site_id);
      }
    }
  }
  async function resolveRecon() {
    let left = store.recon.count({ status: 'open' });
    for (const r of store.recon.find({ status: 'open' }, { order: 'ts' })) {
      if (left <= 2) break; // Lead xử lý dần, luôn còn vài dòng chờ đối chiếu
      if (T - r.ts < 46 * HOUR || !chance(0.6)) continue; // dòng đã quá 2 ngày, không phải dòng nào cũng xong ngay
      left--;
      const who = r.team === 'tech' ? 'techlead' : r.team === 'sale' ? 'salehead' : 'lead';
      await api(who, 'POST', `/api/hub/recon/${r.id}/resolve`, chance(0.15) ? { status: 'ignored', note: 'Số liệu đã khớp ở lượt sau, bỏ qua' } : { note: pick(['Đã gọi BO xác nhận lại, cập nhật đúng thực tế', 'Đã tìm thấy, số liệu khớp', 'Đã đối chiếu với FO, ghi nhận chênh lệch']) });
    }
  }
  const READERS = { admin: 0.5, lead: 0.8, techlead: 0.8, salehead: 0.7, log: 0.6, log2: 0.8, log3: 0.3, tech: 0.6, tech2: 0.8, tech3: 0.3, sale: 0.5, sale2: 0.5, sale3: 0.4 };
  async function readInbox() { for (const [u, p] of Object.entries(READERS)) if (chance(p)) await api(u, 'POST', '/api/hub/inbox/read', { all: true }); }
  let ticks = 0;
  const tick = () => { for (const [, tp] of trips) if (tp.active) ping(tp.fo); core.tick(); ticks++; };

  // Biến động phụ kiện trong kỳ (ngoài nhập đầu kỳ): mua thêm, thanh lý, tìm lại.
  ev(10, '10:00', () => api('lead', 'POST', '/api/hub/acc/cap_c_c/move', { kind: 'in', qty: 20, reason: 'Mua bổ sung dây Type-C to C' }));
  ev(24, '15:00', () => api('lead', 'POST', '/api/hub/acc/hub_sac/move', { kind: 'out', qty: 2, reason: 'Hub sạc hỏng, thanh lý' }));
  ev(38, '10:30', () => api('lead', 'POST', '/api/hub/acc/powerbank_cover/move', { kind: 'in', qty: 10, reason: 'Nhập thêm vỏ powerbank' }));
  ev(52, '16:00', () => api('lead', 'POST', '/api/hub/acc/day_gan/move', { kind: 'found', qty: 1, reason: 'Tìm lại dây gắn trong thùng kit thu hồi' }));
  // Lỗi "Quá nhiệt" tăng vọt trong tuần này (đủ ngưỡng báo lỗi tăng vọt).
  for (let k = 0; k < 3; k++) {
    const i = Math.min(LAST, CW * 7 + k);
    const lo = i === LAST ? Math.max(30, endMin - 240) : 8 * 60, hi = i === LAST ? endMin - 15 : 19 * 60;
    if (hi > lo) ev(i, hmOf(ri(lo, hi)), () => raiseIncident(i, 'Quá nhiệt'));
  }
  const lockedMonth = new Set();
  // Việc giao tay quá hạn lúc mở ứng dụng: Lead giao cho người làm chậm, hạn ngắn, người nhận chưa làm tới.
  const OVER = endMin >= 14 * 60 ? { day: LAST, t: at(TODAY, '10:00') + ri(0, 60) * MIN, due: 2 } : { day: LAST - 1, t: at(dateAt(LAST - 1), '16:00') + ri(0, 40) * MIN, due: 3 };
  async function overdueJobs() {
    const live = shuffle(store.sites.find({ type: 'bo', active: 1, ops_status: 'live' }, { order: 'id' }));
    if (live.length < 2) return;
    for (const [ld, team, who, title, note, s] of [['lead', 'logistics', 'log3', `Gọi ${live[0].name} chốt lịch giao thêm máy`, 'BO muốn đổi giờ giao, cần chốt trong buổi', live[0]], ['techlead', 'tech', 'tech3', `Kiểm tra lại cấu hình ứng dụng ghi hình cho ${live[1].name}`, 'Sale báo hình bị giật từ hôm qua', live[1]]]) {
      const r = await api(ld, 'POST', '/api/hub/jobs', { team, title, note, site_id: s.id, assignee_id: ids[who], due_hours: OVER.due });
      if (r) leaveOpen.add(r.job.id);
    }
  }

  /**
   * Lead san việc bằng tay (đúng như cảnh báo "đang giữ nhiều việc"): người trong ca đã hết việc mà người khác còn ôm việc chưa bắt đầu
   * thì Lead giao bớt một nửa cho người rảnh, ưu tiên người làm nhanh. Việc Lead giao tay hệ thống không tự chuyển nữa.
   */
  async function leadSpread(team) {
    const on = MEMBERS[team].filter(onShift);
    const idle = on.filter((u) => !store.jobs.count({ assignee_id: ids[u], status: OPEN })).sort((a, b) => ({ strong: 0, avg: 1, weak: 2 }[PROFN[a]] ?? 1) - ({ strong: 0, avg: 1, weak: 2 }[PROFN[b]] ?? 1));
    if (!idle.length) return;
    const held = (u) => store.jobs.find({ assignee_id: ids[u], status: 'open', team }).filter((j) => !j.task_id && !j.blocked && !j.started_at && !busy.has(j.id) && !leaveOpen.has(j.id) && !manualToday.has(j.id));
    const [, list] = on.map((u) => [u, held(u)]).sort((a, b) => b[1].length - a[1].length)[0];
    if (list.length < 2) return;
    const take = list.sort(byRank).slice(-Math.floor(list.length / 2));
    await api(team === 'tech' ? 'techlead' : 'lead', 'POST', '/api/hub/jobs/bulk-assign', { job_ids: take.map((j) => j.id), user_id: ids[idle[0]] });
  }

  function planDay(i) {
    const d = dateAt(i), wd = weekday(d);
    manualToday.clear();
    for (const h of ['06:20', '09:45', '12:05', '15:15', '19:40', '22:30']) push(at(d, h), tick); // ngoài giờ cao điểm: hệ số đường không đổi giữa các nhịp
    for (const u of ATT) planShift(u, d, i);
    if (wd !== 7) { push(at(d, '08:10'), () => planTrips(d, 'am')); push(at(d, '13:10'), () => planTrips(d, 'pm')); }
    for (const hm of ['10:40', '15:40', '19:10']) push(at(d, hm), async () => { await leadSpread('logistics'); await leadSpread('tech'); });
    push(at(d, '12:30'), () => sendCards('to_tech')); push(at(d, '17:10'), () => sendCards('to_tech'));
    push(at(d, '16:40'), () => sendCards('to_log')); push(at(d, '21:30'), () => sendCards('to_log'));
    for (const [hm, fn] of evAt.get(i) || []) push(at(d, hm), fn);
    for (let k = poisson((wd === 7 ? 0.45 : 1.35) * S); k > 0; k--) push(at(d, hmOf(ri(7 * 60 + 30, 20 * 60))), () => raiseIncident(i));
    if (chance(0.15 * S)) push(at(d, hmOf(ri(9 * 60, 17 * 60))), () => support('extra_acc'));
    if (chance(0.08 * S)) push(at(d, hmOf(ri(9 * 60, 17 * 60))), () => support('bad_card'));
    if (chance(0.05 * S)) push(at(d, hmOf(ri(9 * 60, 17 * 60))), () => support('swap_device'));
    if (wd === 5) push(at(d, '16:00'), () => putRoster(weekOf(i) + 1));
    if (i < LAST) push(at(d, '18:40'), readInbox);
    if (i < LAST && wd !== 7) push(at(d, '19:30'), resolveRecon);
    for (const h of ['11:40', '17:50']) push(at(d, h), settleHeldJobs);
    const pm = addDays(d.slice(0, 7) + '-01', -1).slice(0, 7);
    if (+d.slice(8) >= 3 && wd <= 5 && !lockedMonth.has(pm) && pm >= D0.slice(0, 7) && i > 7) {
      lockedMonth.add(pm);
      push(at(d, '10:00'), async () => { await api('lead', 'POST', '/api/hub/perf/lock', { team: 'logistics', period: 'month', key: pm }); await api('techlead', 'POST', '/api/hub/perf/lock', { team: 'tech', period: 'month', key: pm }); });
    }
    if (i === OVER.day) push(OVER.t, overdueJobs);
    if (i === LAST && endMin >= 6 * 60 + 40 && endMin <= 21 * 60 + 30) { push(END - ri(25, 40) * MIN, () => finaleTrip(false)); push(END - 13 * MIN, () => finaleTrip(true)); } // ban đêm không có chuyến
  }
  /** Gần giờ hiện tại mà không có chuyến nào đang chạy: gom một chuyến (đổi thẻ còn lại hôm nay, thêm việc giao tay) để lúc mở ứng dụng có FO đang đi. */
  async function finaleTrip(late) {
    for (const [id, tp] of trips) {
      const tk = store.tasks.get(id);
      if (!tk) continue;
      if (['assigned', 'accepted'].includes(tk.status) && tk.start_at <= END - 3 * MIN) return;
      if (tp.active && tk.status === 'in_progress' && (!late || store.stops.find({ task_id: id }).some((x) => !x.is_return && ['pending', 'arrived'].includes(x.status)))) return; // sát giờ: chuyến chỉ còn chặng về thì vẫn gom chuyến mới
    }
    const d = TODAY;
    let jobs = store.jobs.find({ team: 'logistics', status: 'open', type: 'card_swap' }).filter((j) => !j.task_id && !busy.has(j.id) && visible(j, d) && j.date <= d && store.kits.count({ site_id: j.site_id, status: 'at_bo' }));
    const sites = new Set(jobs.map((j) => j.site_id));
    const live = store.sites.find({ type: 'bo', active: 1, ops_status: 'live' }).filter((s) => !sites.has(s.id) && s.lat !== null).sort((a, b) => distM(office.lat, office.lon, a.lat, a.lon) - distM(office.lat, office.lon, b.lat, b.lon));
    for (const s of live) {
      if (sites.size >= 3) break;
      const r = await api('lead', 'POST', '/api/hub/jobs', { team: 'logistics', title: `Kiểm tra dây nguồn và vị trí máy tại ${s.name}`, site_id: s.id, note: 'BO báo máy hay tắt vào giờ cao điểm', due_hours: 6 });
      if (r) { sites.add(s.id); jobs.push(store.jobs.get(r.job.id)); }
    }
    jobs = jobs.slice(0, 6);
    if (jobs.length) await planTrips(d, 'now', jobs);
  }
  /** Trạng thái cuối "hôm nay": việc vướng, việc Lead để cho cả đội (hệ thống giao ngay cho người trong ca), sự cố đang mở, quota sát ngưỡng. */
  async function finale() {
    for (const [team, ld, why, title] of [['tech', 'techlead', 'Chờ linh kiện CM5 thay thế từ nhà cung cấp', 'Thay pin cho các powerbank yếu trong kho'], ['logistics', 'lead', 'Chờ BO xác nhận lịch, quản lý BO nghỉ phép', 'Đổi lịch giao máy với BO theo đề nghị của Sale']]) {
      if (store.jobs.count({ team, status: OPEN, blocked: { ne: null } })) continue;
      let j = store.jobs.find({ team, status: OPEN }).filter((x) => x.assignee_id && !x.blocked && !x.task_id && !leaveOpen.has(x.id) && visible(x, TODAY) && !['cards_receive', 'cards_back', 'cards_upload', 'cards_return', 'incident'].includes(x.type)).sort(byRank)[0];
      if (!j) { const r = await api(ld, 'POST', '/api/hub/jobs', { team, title, assignee_id: ids[MEMBERS[team].find(onShift) || MEMBERS[team][0]], due_hours: 24 }); j = r && store.jobs.get(r.job.id); }
      if (j) await api(j.assignee_id, 'POST', `/api/hub/jobs/${j.id}/block`, { reason: why });
    }
    for (const [ld, team, title] of [['lead', 'logistics', 'Sắp xếp lại kệ kit sẵn sàng theo mã'], ['techlead', 'tech', 'Cập nhật firmware cho lô CM5 mới nhập']]) {
      await api(ld, 'POST', '/api/hub/jobs', { team, title, note: 'Ai rảnh thì nhận', due_hours: 8 }); // không chọn người: hệ thống giao cho người trong ca ít tải nhất
    }
    for (let k = store.incidents.count({ status: ['open', 'ack'] }); k < 3; k++) await raiseIncident(LAST);
    // Nhận sự cố: người đang giữ việc xử lý (chỉ người giữ hoặc Tech Lead nhận được), chưa ai giữ thì Tech Lead.
    if (!store.incidents.count({ status: 'ack' })) { const inc = store.incidents.find({ status: 'open' }, { order: 'created_at', limit: 1 })[0]; const ij = inc && store.jobs.find({ incident_id: inc.id, type: 'incident', status: ['open', 'doing'] }, { limit: 1 })[0]; if (inc) await api((ij && ij.assignee_id) || 'techlead', 'POST', `/api/hub/incidents/${inc.id}/ack`); }
    for (const [list, lo, hi] of [[nearQ, 0.84, 0.95], [overQ, 1.03, 1.12]]) for (const p of list) {
      const used = p.siteId ? H.outlets.usedHours([p.siteId]).get(p.siteId) || 0 : 0;
      if (used > 5) await api('salehead', 'PATCH', `/api/hub/outlets/${p.siteId}`, { quota_hours: Math.max(1, Math.round(used / rr(lo, hi))) });
    }
  }

  // ───────── Chạy từng ngày ─────────
  for (let i = 0; i <= LAST; i++) {
    planDay(i);
    await runTo(i < LAST ? at(dateAt(i + 1), '05:00') : END);
  }
  heap.length = 0;
  tick();
  await finale();
  for (const tp of tpls) await api('lead', 'PATCH', `/api/templates/${tp.id}`, { active: true });
  setNow(null);
  return { ms: Date.now() - started, calls: stat.calls, ticks, trips: trips.size, days: LAST + 1, scale: S, from: D0, to: TODAY, misses: stat.misses, errors: stat.errors };
}
