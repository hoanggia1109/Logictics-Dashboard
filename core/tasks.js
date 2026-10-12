// tasks.js — task giao nhận nhiều điểm, SLA theo điều kiện, ảnh bằng chứng, BO xác nhận, tuyến định kỳ, thống kê, cảnh báo.
import { distM, num, int, cleanStr, cleanText, validCoord, localDate, dayStart, atTime, localHM, weekday, addDays, isDate, isHM, pathM, optimizeOrder, decodeDataUrl, csvCell, boLabel, decodePolyline, encodePolyline, projectOnPath, slicePath } from './util.js';
import { fail } from './core.js';

export const OPEN_STATUS = ['unassigned', 'assigned', 'accepted', 'in_progress'];
export const ISSUE_KINDS = { ket_xe: 'Kẹt xe', hong_xe: 'Hỏng xe', tai_nan: 'Tai nạn / va chạm', khong_gap: 'Không gặp người nhận', cho_bo: 'Đang chờ BO xác nhận', thieu_hang: 'Thiếu thẻ / thiết bị', khac: 'Việc khác' };
const DAY_NAMES = ['', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

// ───────────────────────── SLA theo đường, hiệu chỉnh theo lịch sử (hàm thuần) ─────────────────────────
/** Phân vị p (0–1) của dãy số, nội suy tuyến tính giữa hai giá trị kề (p = 0,5 là trung vị). Dãy rỗng → null. */
export function quantile(xs, p) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const pos = (a.length - 1) * p, lo = Math.floor(pos);
  return lo + 1 < a.length ? a[lo] + (a[lo + 1] - a[lo]) * (pos - lo) : a[lo];
}
const SVC_SITE_N = 8, SVC_ALL_N = 20, GAMMA_N = 100; // số lượt dừng của một điểm / của mọi điểm, số chuyến tối thiểu để tin số tính từ lịch sử
/** Phút dừng mặc định khi chưa đủ lịch sử: điểm thường stopMin (P85: thêm 4 phút); điểm cần BO xác nhận thêm 2 phút chờ (P85: thêm 10 phút). */
const svcDefault = (stopMin, bo) => (bo ? { min50: stopMin + 2, min85: stopMin + 10 } : { min50: stopMin, min85: stopMin + 4 });
/**
 * Thời gian dừng mỗi điểm: trung vị (min50) và P85 (min85). rows: [{ site_id, name, min, bo }] (số phút ở lại của từng lượt đã xong, kể cả lúc chờ BO xác nhận; bo: lượt cần BO xác nhận).
 * Điểm có ≥ 8 lượt: số của điểm đó; không đủ: số của mọi điểm khi có ≥ 20 lượt, không nữa thì mặc định (svcDefault). Số tính từ lịch sử kẹp trong 2–60 phút.
 * min = min50 (giữ cho chỗ còn đọc min). default.min50 / min85 = null khi mọi điểm cộng lại chưa đủ 20 lượt.
 */
export function calibService(rows, stopMin) {
  const ok = rows.filter((r) => r && Number.isFinite(r.min) && r.min >= 0), by = new Map();
  const q = (xs, p) => Math.min(60, Math.max(2, Math.round(quantile(xs, p))));
  const all = ok.length >= SVC_ALL_N ? { min50: q(ok.map((r) => r.min), 0.5), min85: q(ok.map((r) => r.min), 0.85) } : null;
  for (const r of ok) if (r.site_id) { let g = by.get(r.site_id); if (!g) by.set(r.site_id, (g = { site_id: r.site_id, name: r.name || '', xs: [], bo: 0 })); g.xs.push(r.min); if (r.bo) g.bo++; }
  const of = (g) => (g.xs.length >= SVC_SITE_N ? { min50: q(g.xs, 0.5), min85: q(g.xs, 0.85) } : all || svcDefault(stopMin, g.bo * 2 > g.xs.length));
  return {
    default: { min: all ? all.min50 : stopMin, min50: all ? all.min50 : null, min85: all ? all.min85 : null, n: ok.length },
    sites: [...by.values()].map((g) => { const v = of(g); return { site_id: g.site_id, name: g.name, min: v.min50, min50: v.min50, min85: v.min85, n: g.xs.length }; }).sort((a, b) => b.n - a.n || a.site_id - b.site_id),
  };
}
/**
 * Hệ số thời gian đi. samples: [{ r: thời gian thực tế / thời gian theo bản đồ của một chặng, peak: đi trong giờ cao điểm }].
 * Bỏ mẫu ngoài 0,3–4; trung vị co về 1 theo số mẫu (n / (n + 20)), kẹp 0,7–1,6. Giờ cao điểm / ngoài giờ có hệ số riêng khi nhóm đó có ≥ 30 mẫu, không thì dùng hệ số chung.
 */
export function calibTravel(samples) {
  const ok = samples.filter((x) => x && Number.isFinite(x.r) && x.r >= 0.3 && x.r <= 4);
  const kOf = (xs) => (xs.length ? Math.min(1.6, Math.max(0.7, +((xs.length * quantile(xs, 0.5) + 20) / (xs.length + 20)).toFixed(2))) : 1);
  const all = ok.map((x) => x.r), pk = ok.filter((x) => x.peak).map((x) => x.r), op = ok.filter((x) => !x.peak).map((x) => x.r), k = kOf(all);
  return { k, n: all.length, peak: { k: pk.length >= 30 ? kOf(pk) : k, n: pk.length }, off: { k: op.length >= 30 ? kOf(op) : k, n: op.length } };
}
/**
 * Hệ số γ nhân độ bất định trong phần dự phòng. rows: [{ a, p50, unc }] của chuyến hoàn thành có SLA theo đường: a = số phút thực tế (bắt đầu → xong) chia hệ số điều kiện,
 * p50 / unc = số lúc lập SLA. s = (a − p50 − base) / unc là γ nhỏ nhất để chuyến đó kịp hạn; γ = phân vị pct % của s (phần tử thứ ⌈(n + 1) × pct / 100⌉ sau khi xếp tăng), kẹp 0,5–3.
 * Dưới 100 chuyến: γ = 1.
 */
export function calibGamma(rows, pct, base) {
  const s = rows.filter((r) => r && Number.isFinite(r.a) && Number.isFinite(r.p50) && r.unc > 0).map((r) => (r.a - r.p50 - base) / r.unc).sort((x, y) => x - y);
  if (s.length < GAMMA_N) return { gamma: 1, n: s.length };
  return { gamma: +Math.min(3, Math.max(0.5, s[Math.min(s.length, Math.ceil(((s.length + 1) * pct) / 100)) - 1])).toFixed(2), n: s.length };
}
/** z của phân phối chuẩn: P(Z ≤ z) = p, với 0 < p < 1 (xấp xỉ hữu tỉ của Acklam, sai số cỡ 1e-9). Ví dụ 0,85 → 1,0364; 0,9 → 1,2816. */
export function zOf(p) {
  const h = (cs, x) => cs.reduce((s, c) => s * x + c, 0);
  if (p < 0.02425 || p > 0.97575) {
    const q = Math.sqrt(-2 * Math.log(Math.min(p, 1 - p))), v = h([-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783], q) / h([7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416, 1], q);
    return p < 0.5 ? v : -v;
  }
  const q = p - 0.5, r = q * q;
  return (h([-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239], r) * q) / h([-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1, 1], r);
}
/**
 * SLA theo đường thực tế, mô hình v2 (hàm thuần). legs: [{ duration_s }] (chặng i: điểm i → điểm i + 1, thời gian đã tính kẹt xe);
 * svc: [{ p50, p85 } | null] phút dừng từng điểm theo thứ tự (null: chặng quay về, không dừng); kOf(ts): hệ số thời gian đi theo khung giờ của lúc rời điểm;
 * o: { departAt, z, sigmaLeg, sigmaDay, bufferBase, bufferFloor, gamma }.
 *  - Lịch từng chặng: chặng đầu rời lúc departAt; đi T = phút theo bản đồ × k(lúc rời); chặng sau rời lúc tới điểm + P50 dừng ở điểm đó.
 *  - P50 = ΣT + Σ P50 dừng. Độ bất định U = √(XT² + XS²): XT = ΣT × (e^(z·σT) − 1), σT = √(σday² + σleg² / Leff), Leff = (ΣT)² / ΣT²;
 *    XS = √Σ(P85 − P50)² × z / z(85 %) — phần dao động thời gian dừng đo ở phân vị 85, nên nhắm % cao hơn thì nới theo cùng tỉ lệ với phần đi lại.
 *  - Dự phòng = max(bufferFloor, bufferBase + γ·U). Làm tròn từng phần rồi mới cộng (các số hiện trên màn hình cộng lại đúng), base_min làm tròn lên bội 5.
 */
export function routeSla(legs, svc, kOf, o) {
  let dep = o.departAt, sT = 0, sT2 = 0, s50 = 0, xs2 = 0;
  const stay = (v) => { if (v) { s50 += v.p50; xs2 += (v.p85 - v.p50) ** 2; } return v ? v.p50 : 0; };
  stay(svc[0]);
  legs.forEach((l, i) => { const T = ((l.duration_s || 0) / 60) * kOf(dep); sT += T; sT2 += T * T; dep += (T + stay(svc[i + 1])) * 60000; });
  const sig = Math.sqrt(o.sigmaDay ** 2 + o.sigmaLeg ** 2 / (sT2 > 0 ? (sT * sT) / sT2 : 1)), xt = sT * (Math.exp(o.z * sig) - 1), xs = Math.sqrt(xs2) * (o.z / zOf(0.85)), u = Math.sqrt(xt * xt + xs * xs);
  const travel = Math.round(sT), service = Math.round(s50), buffer = Math.round(Math.max(o.bufferFloor, o.bufferBase + o.gamma * u));
  return { travel_min: travel, service_min: service, buffer_min: buffer, base_min: Math.ceil((travel + service + buffer) / 5) * 5, p50_min: travel + service, unc_min: Math.round(u) };
}
const BETA_WARN = 'Đường xe máy của Google đang thử nghiệm (beta): vài đoạn có thể chưa sát thực tế.'; // giống lib/routing.js; Google bắt buộc hiện kèm đường xe máy

export function installTasks(K) {
  const { store, cfg, now, off, today, R, idOf, event, toOps, toUser, live, hooks, ensureLive, OPS } = K;
  const hm = (ts) => localHM(ts, off);
  const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  /** Báo cho Ops Hub (việc của Logistics đi theo chuyến). Lỗi phía hub không được chặn thao tác của FO hay BO: hoàn tác phần hub, ghi cảnh báo. */
  function fire(name, ...args) {
    const fn = hooks[name];
    if (!fn) return;
    try { store.tx(() => fn(...args)); } catch (e) {
      event('hub_error', 'alert', `Chưa cập nhật được việc của Ops Hub sau thao tác trên chuyến (${name}): ${(e && (e.msg || e.message)) || 'lỗi không rõ'}. Logistics kiểm tra lại các việc liên quan.`, { task_id: args[1] ? args[1].id : args[0] && args[0].id });
    }
  }

  // ───────────────────────── Dựng dữ liệu trả về ─────────────────────────
  const stopsOf = (taskId) => store.stops.find({ task_id: taskId }, { order: 'seq' });
  function taskView(task, stops) {
    stops = stops || stopsOf(task.id);
    const photos = stops.length ? store.photos.find({ stop_id: stops.map((s) => s.id) }, { order: 'ts' }) : [];
    const fo = task.fo_id ? store.users.get(task.fo_id) : null;
    return {
      ...task,
      fo: fo ? { id: fo.id, name: fo.name, phone: fo.phone || '', color: fo.color, vehicle: fo.vehicle || '' } : null,
      stops: stops.map((s) => {
        const { bo_link_hash, bo_link_dev, ...pub } = s; // mã link và mã thiết bị của BO không bao giờ rời máy chủ
        return { ...pub, bo_link: bo_link_hash ? { at: s.bo_link_at, opened_at: s.bo_link_open_at || null } : null, photos: photos.filter((p) => p.stop_id === s.id).map((p) => ({ id: p.id, by: p.by, ts: p.ts, lat: p.lat, lon: p.lon })) };
      }),
    };
  }
  /** Phát thay đổi của 1 task tới điều phối, FO được giao và các BO liên quan. */
  function pushTask(taskId, prevFo) {
    const task = store.tasks.get(taskId);
    if (!task) return null;
    const view = taskView(task);
    // Đẩy sau khi giao dịch ghi xong: chuyến tạo dở rồi hoàn tác thì FO không nhận chuyến ma.
    store.afterCommit(() => {
      toOps({ t: 'task', task: view });
      if (task.fo_id) toUser(task.fo_id, { t: 'task', task: view });
      if (prevFo && prevFo !== task.fo_id) toUser(prevFo, { t: 'task_gone', id: task.id });
    });
    return view;
  }

  // ───────────────────────── Task đang chạy của từng FO (để nhận diện "đã đến" và cộng km) ─────────────────────────
  function flushCur(l) {
    if (l.cur && l.cur.kmDirty) { store.tasks.update(l.cur.taskId, { km: +l.cur.km.toFixed(3) }); l.cur.kmDirty = false; }
  }
  function refreshCur(foId) {
    if (!foId) return;
    const l = ensureLive(foId);
    flushCur(l);
    const task = store.tasks.find({ fo_id: foId, status: 'in_progress' }, { limit: 1 })[0];
    l.cur = task ? { taskId: task.id, km: task.km || 0, kmDirty: false, stops: stopsOf(task.id).map((s) => ({ id: s.id, lat: s.lat, lon: s.lon, radius: s.radius, status: s.status, is_return: s.is_return, bo: s.bo_status })) } : null;
  }
  hooks.flushCur = flushCur;
  hooks.afterLoad = () => { for (const l of live.values()) refreshCur(l.id); };
  // Tự ghi "đã đến" khi FO vào vùng của một điểm đang chờ. Hai ngoại lệ để không ghi nhầm:
  //  - chặng quay về chỉ được tính khi mọi điểm khác đã chốt (lúc xuất phát FO cũng đang đứng ở đúng chỗ đó);
  //  - một nơi xuất hiện 2 lần trong tuyến thì chỉ lần ghé đứng trước được tính.
  hooks.onPoint = (l, p) => {
    if (!l.cur) return;
    const stops = l.cur.stops, hits = [];
    if (stops.some((x) => x.status === 'done' && x.bo === 'pending')) return; // đang chờ BO xác nhận: chưa được tính điểm kế tiếp
    const othersClosed = stops.every((x) => x.is_return || x.status === 'done' || x.status === 'failed' || x.status === 'skipped');
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      if (s.status !== 'pending' || distM(p.lat, p.lon, s.lat, s.lon) > s.radius) continue;
      if (s.is_return && !othersClosed) continue;
      if (stops.slice(0, i).some((e) => e.status === 'pending' && distM(e.lat, e.lon, s.lat, s.lon) < 60)) continue;
      hits.push(s.id);
    }
    for (const id of hits) arriveStop(store.stops.get(id), 'auto', p, null);
  };
  hooks.onShiftEnd = (l, reason) => {
    flushCur(l);
    if (!l.cur || reason === 'disabled' || reason === 'withdraw' || reason === 'terms') return;
    const task = store.tasks.get(l.cur.taskId), fo = store.users.get(l.id);
    if (!task || !fo) return;
    if (reason === 'timeout') event('lost_long', 'alert', `${fo.name} mất tín hiệu quá ${Math.round(cfg.offlineSec / 60)} phút khi đang làm task ${task.code}. Ca đã tự đóng; hãy gọi cho FO.`, { task_id: task.id, fo_id: fo.id });
    else event('shift_end_in_task', 'warn', `${fo.name} kết thúc ca khi task ${task.code} chưa xong.`, { task_id: task.id, fo_id: fo.id });
  };

  // ───────────────────────── SLA ─────────────────────────
  const round5 = (m) => Math.ceil(m / 5) * 5;
  function planOf(stops) {
    const km = (pathM(stops) / 1000) * cfg.sla.roadFactor;
    const work = stops.filter((s) => !s.is_return).length;
    return { plan_km: +km.toFixed(2), base_min: round5((km / cfg.sla.speedKmh) * 60 + work * cfg.sla.stopMin + cfg.sla.bufferMin) };
  }
  const dueOf = (startAt, baseMin, factor) => startAt + Math.round(baseMin * factor) * 60000;
  /**
   * Hệ số điều kiện của một task. Đường đi đã tính kẹt xe (route_traffic) thì không nhân thêm hệ số giờ cao điểm tự động (không tính kẹt xe hai lần);
   * thời tiết và mức giao thông Logistic chỉnh tay vẫn nhân. Task chưa có đường đi thực tế: như cũ (c.factor).
   */
  const factorFor = (task, c) => (task && task.route_traffic ? Math.min(2, +(c.weatherF * (c.trafficMode === 'manual' ? c.trafficF : 1)).toFixed(2)) : c.factor);
  /** Hiệu chỉnh theo lịch sử (cài đặt sla_calib, mô hình v2); cfg.sla.calibrate tắt, chưa tính lần nào hoặc còn bản cũ → null (dùng số mặc định). */
  const calOf = () => { const c = cfg.sla.calibrate ? K.getSetting('sla_calib') : null; return c && c.v === 2 ? c : null; };
  /** Thông số SLA theo đường (cfg.sla; số không hợp lệ thì dùng mặc định). pct: % chuyến kịp hạn nhắm tới, kẹp 50–99; z tương ứng. */
  function slaOpt() {
    const s = cfg.sla, pct = Math.min(99, Math.max(50, num(s.targetPct) ?? 85));
    return { pct, z: zOf(pct / 100), sigmaLeg: num(s.sigmaLeg) ?? 0.3, sigmaDay: num(s.sigmaDay) ?? 0.12, bufferBase: num(s.bufferBase) ?? 3, bufferFloor: num(s.bufferFloor) ?? 5 };
  }
  /** Hệ số thời gian thực tế / theo bản đồ cho lượt đi lúc ts (giờ cao điểm và ngoài giờ có hệ số riêng khi đủ dữ liệu). */
  function travelKOf(ts, cal = calOf()) {
    const tr = cal && cal.travel, g = tr ? (K.isPeak(ts) ? tr.peak : tr.off) || tr : null;
    return (g && g.k) || 1;
  }
  /**
   * Phút dừng tại một điểm { p50, p85 }, kể cả lúc chờ BO xác nhận: theo lịch sử của chính điểm đó (≥ 8 lượt), chưa đủ thì của mọi điểm (≥ 20 lượt),
   * không nữa thì mặc định theo loại điểm (stopMin; điểm cần BO xác nhận thêm thời gian chờ).
   */
  function svcOf(stop, cal = calOf()) {
    const sv = cal && cal.service, x = sv && stop.site_id ? (sv.sites || []).find((y) => y.site_id === stop.site_id) : null, all = sv && sv.default;
    const v = x && x.n >= SVC_SITE_N && Number.isFinite(x.min50) ? x : all && Number.isFinite(all.min50) ? all : svcDefault(cfg.sla.stopMin, !!stop.bo_req);
    return { p50: v.min50, p85: v.min85 };
  }
  const serviceMinFor = (stop, cal) => svcOf(stop, cal).p50;
  /**
   * SLA theo đường đi thực tế (mô hình v2, routeSla): đi từng chặng × hệ số theo khung giờ lúc rời điểm, dừng từng điểm (P50 / P85 theo lịch sử, trừ chặng quay về),
   * dự phòng theo độ bất định để khoảng targetPct % chuyến kịp hạn (γ hiệu chỉnh theo lịch sử). Hệ số thời tiết nhân sau (factorFor).
   * Task chưa có đường đi vẫn dùng planOf (đường chim bay).
   */
  function planFromRoute(stops, route) {
    const cal = calOf(), o = slaOpt(), b = cal && cal.buffer;
    const sla = routeSla(route.legs, stops.map((s) => (s.is_return ? null : svcOf(s, cal))), (ts) => travelKOf(ts, cal), { ...o, departAt: route.depart_at, gamma: (b && b.gamma) || 1 });
    const traffic = route.static_s === null || route.static_s === undefined ? null : Math.max(0, Math.round((route.duration_s - route.static_s) / 60));
    return { plan_km: +(route.distance_m / 1000).toFixed(2), base_min: sla.base_min, travel_min: sla.travel_min, traffic_min: traffic, service_min: sla.service_min, buffer_min: sla.buffer_min, p50_min: sla.p50_min, unc_min: sla.unc_min, sla_q: o.pct };
  }
  /** Danh sách điểm đổi: đường đi đã lưu hết đúng, SLA về ước tính đường chim bay cho tới khi có đường mới. */
  const NO_ROUTE = { route_src: null, route_at: null, route_traffic: null, route_mode: null, travel_min: null, traffic_min: null, service_min: null, buffer_min: null, p50_min: null, unc_min: null, sla_q: null, route_err: null, eta_at: null, al_predict: 0 };
  hooks.onConditions = (c) => {
    for (const task of store.tasks.find({ status: OPEN_STATUS })) {
      const f = factorFor(task, c), running = task.status === 'in_progress';
      const factor = running ? Math.max(task.factor || 1, f) : f; // task đang chạy: hạn chỉ được nới, không bị rút lại
      if (factor === task.factor) continue;
      const due = running ? Math.max(task.due_at, dueOf(task.start_at, task.base_min, factor)) : dueOf(task.start_at, task.base_min, factor), t = now();
      const patch = { factor, due_at: due };
      if (due > t) patch.al_late = 0;
      if (due - cfg.riskMin * 60000 > t) patch.al_risk = 0;
      if (task.al_predict && due > task.due_at) patch.al_predict = 0;
      store.tasks.update(task.id, patch);
      if (due !== task.due_at) event('sla_adjust', 'info', `Hạn của task ${task.code} đổi từ ${hm(task.due_at)} sang ${hm(due)} (hệ số điều kiện ×${factor}).`, { task_id: task.id, fo_id: task.fo_id, data: { from: task.due_at, to: due, factor } });
      pushTask(task.id);
    }
  };

  // ───────────────────────── Đường đi thực tế (deps.route, tuỳ chọn) ─────────────────────────
  // Tạo / sửa chuyến không chờ dịch vụ bản đồ: chuyến lưu ngay với SLA ước tính; đường đi thực tế lấy sau khi giao dịch ghi xong
  // (chuyến tạo dở rồi hoàn tác thì không gọi dịch vụ). Mỗi task một lượt (gọi trùng thì gộp), tối đa 2 lượt cùng lúc.
  // Có kết quả thì đọc lại task và danh sách điểm: task đã đóng hoặc điểm đã đổi trong lúc chờ → bỏ kết quả (lượt tính mới đã xếp hàng).
  // Vị trí FO không bao giờ gửi cho dịch vụ bản đồ, chỉ gửi toạ độ các điểm giao nhận; dự kiến khi đang chạy tính tại chỗ theo hình đường đã lưu.
  const routeQ = new Map(), routeBusy = new Set(), routeDone = new Map(), routeTried = new Map(), routeFailAt = new Map(), legMemo = new Map();
  let routeWait = [], pumpSoon = false;
  const vn = (x) => String(x).replace('.', ',');
  /** Chữ ký danh sách điểm (thứ tự, toạ độ, chặng quay về): khác chữ ký lúc tính thì đường đã lưu không còn đúng. */
  const sigOf = (stops) => stops.map((s) => `${s.seq}:${s.lat},${s.lon}${s.is_return ? 'r' : ''}`).join(';');
  const errOf = (e) => cleanStr(String((e && (e.msg || e.message)) || ''), 160) || 'Không lấy được đường đi.';
  const routeOut = (r) => ({ provider: r.provider, mode: r.mode, traffic: !!r.traffic, at: r.at, depart_at: r.depart_at, distance_m: r.distance_m, duration_s: r.duration_s, static_s: r.static_s, legs: r.legs || [], warnings: r.warnings || r.warn || [] });
  function queueRoute(taskId, why) {
    if (!K.deps.route || !taskId) return;
    routeQ.set(taskId, routeQ.get(taskId) === 'manual' ? 'manual' : why); // gộp lượt trùng; Logistic bấm tính lại thì giữ lý do đó (lỗi phải hiện cho họ)
    if (!pumpSoon) { pumpSoon = true; Promise.resolve().then(pumpRoute); }
  }
  function pumpRoute() {
    pumpSoon = false;
    for (const [id, why] of routeQ) {
      if (routeBusy.size >= 2) break;
      if (routeBusy.has(id)) continue; // task đang được tính: tính lại sau khi lượt này xong
      routeQ.delete(id); routeBusy.add(id);
      refineRoute(id, why).catch(() => {}).then(() => {
        routeBusy.delete(id);
        if (!routeQ.has(id)) { const w = routeDone.get(id) || []; routeDone.delete(id); for (const f of w) f(); }
        pumpRoute();
      });
    }
    if (!routeQ.size && !routeBusy.size) { const w = routeWait; routeWait = []; for (const f of w) f(); }
  }
  /** Xếp hàng rồi chờ chính task này tính xong (nút "Tính lại đường"). */
  function routeNow(taskId, why) {
    if (!K.deps.route) return Promise.resolve();
    return new Promise((res) => { if (!routeDone.has(taskId)) routeDone.set(taskId, []); routeDone.get(taskId).push(res); queueRoute(taskId, why); });
  }
  /** Hàng đợi trống và không còn lượt nào đang tính (kiểm thử chờ cái này). */
  const routeIdle = () => (routeQ.size || routeBusy.size ? new Promise((res) => routeWait.push(res)) : Promise.resolve());
  /** Kiểm dữ liệu deps.route trả về (đúng số chặng, số liệu hợp lệ); sai thì coi như dịch vụ báo lỗi. */
  function cleanRoute(r, n, departAt) {
    if (!r || typeof r !== 'object' || !Array.isArray(r.legs) || r.legs.length !== n - 1) throw new Error('Dịch vụ bản đồ trả dữ liệu đường đi không hợp lệ.');
    const pos = (v) => { const x = num(v); return x === null || x < 0 ? null : Math.round(x); };
    const legs = r.legs.map((l) => ({
      distance_m: pos(l && l.distance_m) ?? 0, duration_s: pos(l && l.duration_s) ?? 0, static_s: pos(l && l.static_s), polyline: l && typeof l.polyline === 'string' ? l.polyline : '',
      jams: l && Array.isArray(l.jams) ? l.jams.filter((j) => Array.isArray(j) && j.length === 3 && j.every(Number.isFinite)) : [],
    }));
    const sum = (k) => legs.reduce((a, l) => a + l[k], 0);
    return {
      provider: cleanStr(r.provider, 20) || 'route', mode: cleanStr(r.mode, 30), traffic: !!r.traffic, depart_at: pos(r.depart_at) ?? departAt, at: pos(r.at) ?? now(),
      distance_m: pos(r.distance_m) ?? sum('distance_m'), duration_s: pos(r.duration_s) ?? sum('duration_s'), static_s: pos(r.static_s) ?? (legs.every((l) => l.static_s !== null) ? sum('static_s') : null),
      legs, warnings: (Array.isArray(r.warnings) ? r.warnings : []).map((w) => cleanStr(w, 300)).filter(Boolean).slice(0, 10),
    };
  }
  async function refineRoute(taskId, why) {
    try {
      const t0 = now(), task0 = store.tasks.get(taskId);
      routeTried.set(taskId, t0);
      if (!task0 || !isOpen(task0)) return;
      const stops0 = stopsOf(taskId);
      if (stops0.length < 2) return; // một điểm: không có chặng nào (FO đi từ đâu tới điểm đó thì không gửi cho dịch vụ)
      const sig = sigOf(stops0), departAt = task0.status === 'in_progress' ? t0 : Math.max(t0, task0.start_at);
      let route = null, err = null;
      try { route = cleanRoute(await K.deps.route(stops0.map((s) => ({ lat: s.lat, lon: s.lon })), { departAt }), stops0.length, departAt); } catch (e) { err = errOf(e); }
      const task = store.tasks.get(taskId), stops = task && isOpen(task) ? stopsOf(taskId) : null;
      if (!stops || sigOf(stops) !== sig) return; // task đã đóng hoặc điểm đã đổi trong lúc chờ: bỏ kết quả
      store.tx(() => (route ? routeReady(task, stops, sig, route) : routeFailed(task, stops, err, why)));
    } catch (e) { console.error('[route]', (e && e.message) || e); }
  }
  /** Có đường đi thực tế: lưu hình đường, tính lại SLA (task đang chạy: hạn và hệ số chỉ được nới), báo điều phối và FO. */
  function routeReady(task, stops, sig, r) {
    const t = now(), plan = planFromRoute(stops, r);
    let factor = factorFor({ route_traffic: r.traffic ? 1 : 0 }, K.conditions()), due = dueOf(task.start_at, plan.base_min, factor);
    if (task.status === 'in_progress') { factor = Math.max(task.factor || 1, factor); due = Math.max(task.due_at, due); }
    const patch = { ...plan, route_src: r.provider, route_mode: r.mode || null, route_at: r.at, route_traffic: r.traffic ? 1 : 0, route_err: null, factor, due_at: due };
    if (due > t) patch.al_late = 0;
    if (due - cfg.riskMin * 60000 > t) patch.al_risk = 0;
    if (due > task.due_at) patch.al_predict = 0;
    store.routes.removeWhere({ task_id: task.id });
    store.routes.insert({ task_id: task.id, sig, provider: r.provider, mode: r.mode, traffic: r.traffic ? 1 : 0, depart_at: r.depart_at, at: r.at, distance_m: r.distance_m, duration_s: r.duration_s, static_s: r.static_s, legs: r.legs, warn: r.warnings });
    store.tasks.update(task.id, patch);
    routeFailAt.delete(task.id);
    const sla = Math.round((due - task.start_at) / 60000), prev = Math.round((task.due_at - task.start_at) / 60000);
    if (!task.route_src || sla !== prev) {
      const what = `${vn((r.distance_m / 1000).toFixed(1))} km, di chuyển ${plan.travel_min} phút${plan.traffic_min ? ` (kẹt xe +${plan.traffic_min} phút)` : ''} → SLA ${sla} phút`;
      event('route_ready', 'info', task.route_src ? `Cập nhật đường đi cho task ${task.code}: ${what} (trước: ${prev} phút).` : `Đã có đường đi thực tế cho task ${task.code}: ${what} (ước tính trước: ${prev} phút).`, { task_id: task.id, fo_id: task.fo_id, data: { src: r.provider, km: plan.plan_km, travel: plan.travel_min, traffic: plan.traffic_min, sla, prev } });
    }
    pushTask(task.id);
  }
  /**
   * Không lấy được đường đi: giữ SLA đang dùng, ghi lỗi để điều phối thấy, cảnh báo tối đa 1 lần / giờ mỗi task.
   * Đường cũ vẫn khớp danh sách điểm thì lượt tự làm mới bị lỗi không cần báo (vẫn dùng đường cũ); Logistic bấm tính lại thì vẫn ghi lỗi.
   */
  function routeFailed(task, stops, msg, why) {
    const t = now(), row = store.routes.find({ task_id: task.id }, { limit: 1, cols: ['sig'] })[0];
    const valid = !!task.route_src && !!row && row.sig === sigOf(stops);
    if (valid && why !== 'manual') return;
    store.tasks.update(task.id, { route_err: msg });
    if (!valid && t - (routeFailAt.get(task.id) || 0) >= 3600000) {
      routeFailAt.set(task.id, t);
      event('route_fail', 'warn', `Chưa lấy được đường đi thực tế cho task ${task.code}: ${msg.replace(/[.\s]+$/, '')}. SLA tạm tính theo đường chim bay.`, { task_id: task.id, fo_id: task.fo_id });
    }
    pushTask(task.id);
  }
  /** Đường đang dùng: các chặng đã giải mã, phương tiện, cảnh báo (nhớ theo task; đổi khi có đường mới hoặc điểm đổi). Không có đường khớp danh sách điểm → null. */
  function routeOf(task, stops) {
    if (!task.route_at) return null;
    const sig = sigOf(stops), key = `${task.route_at}|${sig}`, m = legMemo.get(task.id);
    if (m && m.key === key) return m.r;
    const row = store.routes.find({ task_id: task.id }, { limit: 1 })[0];
    const r = row && row.sig === sig && Array.isArray(row.legs) && row.legs.length === stops.length - 1 ? { mode: row.mode, warn: Array.isArray(row.warn) ? row.warn : [], legs: row.legs.map((x) => ({ path: decodePolyline(x.polyline), dur: x.duration_s || 0 })) } : null;
    legMemo.set(task.id, { key, r });
    return r;
  }
  const legsOf = (task, stops) => { const r = routeOf(task, stops); return r && r.legs; };
  /**
   * BO là điểm kế tiếp của FO: phần đường còn lại từ vị trí FO tới BO (bỏ mọi đoạn trước vị trí FO, không lộ điểm khác của chuyến). FO lệch đường ≥ 300 m → null.
   * Đường xe máy của Google kèm route_warn: cảnh báo đang thử nghiệm (lấy từ cảnh báo đã lưu của đường, không có thì câu chuẩn), Google bắt buộc hiện.
   */
  function pathTo(task, stops, stop, pos, t) {
    const r = routeOf(task, stops), j = stops.findIndex((s) => s.id === stop.id);
    if (!r || j < 1) return null;
    const leg = r.legs[j - 1], pr = projectOnPath(leg.path, pos.lat, pos.lon);
    if (!pr || pr.offM >= 300 || !pr.totalM) return null;
    const left = pr.totalM - pr.distAlongM;
    const out = { path: encodePolyline(slicePath(leg.path, pr.idx, pr.t)), dist_km: +(left / 1000).toFixed(1), eta_min: Math.max(1, Math.ceil(((left / pr.totalM) * leg.dur * travelKOf(t)) / 60)), eta_src: 'route' };
    if (r.mode === 'TWO_WHEELER') out.route_warn = r.warn.find((w) => typeof w === 'string' && /beta|thử nghiệm/i.test(w)) || BETA_WARN;
    return out;
  }
  /**
   * Dự kiến xong của task đang chạy, tính tại chỗ theo đường đã lưu (không gọi dịch vụ bản đồ): phần còn lại của chặng đang đi
   * (FO lệch đường hoặc đang tới điểm đầu: ước tính đường chim bay), các chặng sau, thời gian dừng các điểm còn lại, thời gian còn chờ BO xác nhận.
   */
  function etaOf(task, stops, pos, t) {
    const legs = legsOf(task, stops);
    if (!legs) return null;
    const cal = calOf(), k = travelKOf(t, cal), svc = (s) => (s.is_return ? 0 : serviceMinFor(s, cal) * 60000), legMs = (i) => legs[i].dur * 1000 * k;
    let ms = 0;
    const wait = stops.find((s) => s.status === 'done' && s.bo_status === 'pending');
    if (wait) ms += Math.max(60000, svc(wait) - (t - (wait.arrived_at || wait.done_at)));
    const j = stops.findIndex((s) => s.status === 'pending' || s.status === 'arrived');
    if (j < 0) return Math.round(t + ms);
    const next = stops[j];
    if (next.status === 'arrived') ms += Math.max(0, svc(next) - (t - next.arrived_at));
    else {
      const pr = j > 0 && !wait ? projectOnPath(legs[j - 1].path, pos.lat, pos.lon) : null;
      if (j > 0 && wait) ms += legMs(j - 1); // còn chờ BO ở điểm trước: cả chặng
      else if (pr && pr.offM < 300 && pr.totalM > 0) ms += (1 - pr.distAlongM / pr.totalM) * legMs(j - 1);
      else ms += ((distM(pos.lat, pos.lon, next.lat, next.lon) / 1000) * cfg.sla.roadFactor / cfg.sla.speedKmh) * 3600000;
      ms += svc(next);
    }
    for (let i = j + 1; i < stops.length; i++) if (stops[i].status === 'pending') ms += legMs(i - 1) + svc(stops[i]);
    return Math.round(t + ms);
  }
  /** Nhịp định kỳ, task đang chạy có đường đi: cập nhật dự kiến xong (đổi ≥ 2 phút mới ghi); dự kiến trễ quá 5 phút → báo trước 1 lần. */
  function etaCheck(task, t, patch, who) {
    const l = live.get(task.fo_id);
    if (!l || !l.last || t - l.last.ts > 300000) return;
    const eta = etaOf(task, stopsOf(task.id), l.last, t);
    if (eta === null) return;
    if (task.eta_at === null || task.eta_at === undefined || Math.abs(eta - task.eta_at) >= 120000) patch.eta_at = eta;
    if (eta > task.due_at + 300000 && !task.al_predict && !task.al_late && t <= task.due_at) {
      patch.al_predict = 1;
      event('sla_predict', 'warn', `Task ${task.code} ${who} dự kiến trễ ~${Math.round((eta - task.due_at) / 60000)} phút (dự kiến xong ${hm(eta)}, hạn ${hm(task.due_at)}).`, { task_id: task.id, fo_id: task.fo_id, data: { eta, due: task.due_at } });
    } else if (task.al_predict && eta <= task.due_at) patch.al_predict = 0;
  }
  /**
   * Tính hiệu chỉnh từ lịch sử 30 ngày (chỉ đọc dữ liệu đã có):
   *  - thời gian dừng: điểm đã xong (trừ chặng quay về và điểm FO xác nhận luôn mà không ghi "đã đến"), từ lúc đến tới lúc rời (BO xác nhận nếu có);
   *  - hệ số thời gian đi: chuyến hoàn thành có đường đi khớp danh sách điểm, từng chặng: rời điểm trước → đến điểm sau, chia cho thời gian theo bản đồ;
   *  - dự phòng: γ từ chuyến hoàn thành có SLA theo đường (p50_min, unc_min); coverage = tỉ lệ chuyến hoàn thành có đường thực tế xong trước hạn.
   */
  function calibrate(t) {
    const from = t - 30 * 86400000, svc = [], trv = [], gam = [], o = slaOpt();
    let nCov = 0, hit = 0;
    const cols = ['task_id', 'seq', 'site_id', 'name', 'lat', 'lon', 'is_return', 'status', 'arrived_at', 'arrive_mode', 'done_at', 'bo_req', 'bo_at'];
    for (const part of chunk(store.tasks.find({ date: { gte: localDate(from, off) } }, { cols: ['status', 'route_src', 'started_at', 'finished_at', 'due_at', 'factor', 'p50_min', 'unc_min'] }), 400)) {
      for (const x of part) {
        if (x.status !== 'completed' || !x.route_src || !x.finished_at || x.finished_at < from) continue;
        nCov++; if (x.finished_at <= x.due_at) hit++;
        if (x.p50_min !== null && x.unc_min > 0 && x.started_at && x.factor > 0) gam.push({ a: (x.finished_at - x.started_at) / 60000 / x.factor, p50: x.p50_min, unc: x.unc_min });
      }
      const byTask = new Map(part.map((x) => [x.id, []]));
      for (const s of store.stops.find({ task_id: part.map((x) => x.id) }, { order: 'seq', cols })) byTask.get(s.task_id).push(s);
      for (const list of byTask.values()) for (const s of list) {
        if (s.status !== 'done' || s.is_return || !s.arrived_at || !s.done_at || s.done_at < from || s.arrive_mode === 'proof') continue;
        svc.push({ site_id: s.site_id, name: s.name, min: ((s.bo_req && s.bo_at ? s.bo_at : s.done_at) - s.arrived_at) / 60000, bo: !!s.bo_req });
      }
      const done = part.filter((x) => x.status === 'completed').map((x) => x.id);
      for (const r of done.length ? store.routes.find({ task_id: done }, { cols: ['task_id', 'sig', 'legs'] }) : []) {
        const list = byTask.get(r.task_id) || [];
        if (r.sig !== sigOf(list) || !Array.isArray(r.legs)) continue;
        for (let i = 0; i + 1 < list.length; i++) {
          const a = list[i], b = list[i + 1], leg = r.legs[i], leave = a.bo_req && a.bo_at ? a.bo_at : a.done_at;
          if (!leg || !(leg.duration_s >= 60) || !leave || !b.arrived_at || b.arrived_at <= leave || b.arrive_mode === 'proof' || (a.status !== 'done' && a.status !== 'failed') || b.status === 'skipped') continue;
          trv.push({ r: (b.arrived_at - leave) / 1000 / leg.duration_s, peak: K.isPeak(leave) });
        }
      }
    }
    const service = calibService(svc, cfg.sla.stopMin);
    for (const x of service.sites) { const site = store.sites.get(x.site_id); if (site) x.name = site.name; }
    const buffer = { ...calibGamma(gam, o.pct, o.bufferBase), target_pct: o.pct, coverage: nCov ? +(hit / nCov).toFixed(3) : null, n_cov: nCov };
    return { v: 2, at: t, travel: calibTravel(trv), service, buffer };
  }
  /** Hiệu chỉnh đang dùng; quá 1 giờ, còn bản cũ (trước mô hình v2) hoặc force thì tính lại và lưu vào cài đặt sla_calib. */
  function calibNow(t, force) {
    const cur = K.getSetting('sla_calib');
    if (!force && cur && cur.v === 2 && cur.at <= t && t - cur.at < 3600000) return cur;
    const cal = calibrate(t);
    store.tx(() => K.setSetting('sla_calib', cal));
    return cal;
  }
  /** Dọn đường đi đã lưu của task đã kết thúc, tính trước mốc cut (điều khoản Google giới hạn thời gian lưu). Trả về số dòng đã xoá. */
  function pruneRoutes(cut) {
    let n = 0;
    store.tx(() => {
      for (const r of store.routes.find({ at: { lt: cut } }, { cols: ['task_id'] })) {
        const tk = store.tasks.get(r.task_id);
        if (!tk || !isOpen(tk)) { store.routes.remove(r.id); n++; }
      }
    });
    return n;
  }

  // ───────────────────────── Tạo / sửa task ─────────────────────────
  const count = (v, label) => {
    if (v === undefined || v === null || v === '') return 0;
    const n = int(v, 0, 999);
    if (n === null) fail(400, 'bad_count', `${label} phải là số nguyên từ 0 đến 999.`);
    return n;
  };
  function buildStops(input, roundTrip) {
    if (!Array.isArray(input) || !input.length) fail(400, 'no_stops', 'Task cần ít nhất một điểm.');
    if (input.length > 15) fail(400, 'too_many_stops', 'Một task tối đa 15 điểm.');
    const stops = input.map((s, i) => {
      if (!s || typeof s !== 'object') fail(400, 'bad_stop', `Điểm thứ ${i + 1} không hợp lệ.`);
      let base;
      if (s.site_id !== undefined && s.site_id !== null && s.site_id !== '') {
        const site = store.sites.get(int(s.site_id, 1, 1e12) ?? -1);
        if (!site || !site.active) fail(400, 'bad_site', `Điểm thứ ${i + 1}: điểm giao nhận không còn tồn tại.`);
        base = { bo_req: cfg.boConfirm && site.type === 'bo' ? 1 : 0, site_id: site.id, name: site.name, address: site.address || '', phone: site.phone || '', lat: site.lat, lon: site.lon, radius: site.radius || cfg.arriveRadiusM };
      } else {
        const lat = num(s.lat), lon = num(s.lon), name = cleanStr(s.name, 80);
        if (!name) fail(400, 'bad_stop', `Điểm thứ ${i + 1}: cần tên điểm.`);
        if (!validCoord(lat, lon)) fail(400, 'bad_coord', `Điểm thứ ${i + 1}: toạ độ không hợp lệ.`);
        base = { site_id: null, name, address: cleanStr(s.address, 200), phone: cleanStr(s.phone, 20), lat: +lat.toFixed(6), lon: +lon.toFixed(6), radius: int(s.radius, 30, 2000) ?? cfg.arriveRadiusM };
      }
      return {
        ...base, is_return: 0, note: cleanStr(s.note, 200),
        exp_cards_out: count(s.cards_out, 'Số thẻ giao'), exp_cards_in: count(s.cards_in, 'Số thẻ thu'), exp_dev_out: count(s.dev_out, 'Số thiết bị giao'), exp_dev_in: count(s.dev_in, 'Số thiết bị thu'),
      };
    });
    if (roundTrip) {
      if (stops.length < 2) fail(400, 'round_trip_needs_two', 'Task hai chiều (đi rồi quay về) cần ít nhất 2 điểm: điểm xuất phát và điểm đến.');
      const a = stops[0];
      stops.push({ site_id: a.site_id, name: `Quay về ${a.name}`, address: a.address, phone: a.phone, lat: a.lat, lon: a.lon, radius: a.radius, is_return: 1, bo_req: 0, note: '', exp_cards_out: 0, exp_cards_in: 0, exp_dev_out: 0, exp_dev_in: 0 });
    }
    return stops;
  }
  /** Điểm đã lưu → dữ liệu đầu vào để dựng lại (dùng khi đổi một chiều ↔ hai chiều mà giữ nguyên danh sách điểm). */
  function stopToInput(o) {
    const site = o.site_id ? store.sites.get(o.site_id) : null;
    const where = site && site.active ? { site_id: o.site_id } : { name: o.name, lat: o.lat, lon: o.lon, address: o.address, phone: o.phone, radius: o.radius };
    return { ...where, note: o.note, cards_out: o.exp_cards_out, cards_in: o.exp_cards_in, dev_out: o.exp_dev_out, dev_in: o.exp_dev_in };
  }
  const blankStop = { status: 'pending', arrived_at: null, arrive_mode: null, done_at: null, cards_out: null, cards_in: null, dev_out: null, dev_in: null, fo_note: '', fail_reason: '', proof_dist: null, bo_status: 'none', bo_user: null, bo_at: null, bo_cards_recv: null, bo_cards_given: null, bo_dev_recv: null, bo_dev_given: null, bo_note: '', bo_reminded: 0, bo_req: 0, bo_link_hash: null, bo_link_at: null, bo_link_dev: null, bo_link_open_at: null, bo_waive_reason: '' };
  function foOrFail(id) {
    const fo = store.users.get(int(id, 1, 1e12) ?? -1);
    if (!fo || fo.role !== 'fo' || !fo.active) fail(400, 'bad_fo', 'FO được chọn không tồn tại hoặc đã bị khoá.');
    return fo;
  }
  function startAtOf(b, date) {
    if (b.start_time !== undefined && b.start_time !== null && b.start_time !== '') {
      if (!isHM(b.start_time)) fail(400, 'bad_time', 'Giờ bắt đầu phải có dạng GG:PP.');
      return atTime(date, b.start_time, off);
    }
    const n = num(b.start_at);
    return n === null ? null : Math.round(n);
  }
  function nextCode(date) {
    const prefix = `T${date.slice(2).replace(/-/g, '')}-`;
    let n = store.tasks.count({ date }) + 1;
    while (store.tasks.count({ code: prefix + String(n).padStart(3, '0') })) n++;
    return prefix + String(n).padStart(3, '0');
  }
  function createTask(b, actor, extra = {}) {
    const t = now();
    const date = b.date === undefined || b.date === null || b.date === '' ? localDate(t, off) : b.date;
    if (!isDate(date)) fail(400, 'bad_date', 'Ngày không hợp lệ.');
    if (date < addDays(localDate(t, off), -1) || date > addDays(localDate(t, off), 60)) fail(400, 'bad_date', 'Ngày của task phải từ hôm qua đến 60 ngày tới.');
    let startAt = startAtOf(b, date);
    if (startAt === null) startAt = date === localDate(t, off) ? t : atTime(date, '08:00', off);
    if (localDate(startAt, off) !== date) fail(400, 'bad_time', 'Giờ bắt đầu không nằm trong ngày của task.');
    const roundTrip = !!b.round_trip;
    const stops = buildStops(b.stops, roundTrip);
    const fo = b.fo_id === undefined || b.fo_id === null || b.fo_id === '' ? null : foOrFail(b.fo_id);
    const dest = stops.filter((s) => !s.is_return).slice(roundTrip ? 1 : 0); // hai chiều: điểm đầu là nơi xuất phát
    const title = cleanStr(b.title, 80) || dest[0].name + (dest.length > 1 ? ` +${dest.length - 1} điểm` : '');
    const plan = planOf(stops), factor = K.conditions().factor;
    const task = {
      code: nextCode(date), title, fo_id: fo ? fo.id : null, created_by: actor ? actor.id : null, template_id: extra.template_id ?? null, date, start_at: startAt,
      base_min: plan.base_min, factor, due_at: dueOf(startAt, plan.base_min, factor), status: fo ? 'assigned' : 'unassigned', accepted_at: null, started_at: null, finished_at: null,
      round_trip: roundTrip ? 1 : 0, plan_km: plan.plan_km, km: 0, note: cleanText(b.note, 500), late: 0, partial: 0, al_nostart: 0, al_risk: 0, al_late: 0, cancel_reason: '', created_at: t,
    };
    store.tx(() => {
      task.id = store.tasks.insert(task);
      stops.forEach((s, i) => store.stops.insert({ ...blankStop, ...s, task_id: task.id, seq: i + 1 }));
    });
    event('task_created', 'info', `${actor ? actor.name : 'Hệ thống'} tạo task ${task.code} (${stops.length} điểm)${fo ? `, giao cho ${fo.name}` : ', chưa giao cho ai'}.`, { task_id: task.id, fo_id: task.fo_id, actor_id: actor ? actor.id : null });
    if (K.deps.route && stops.length > 1) store.afterCommit(() => queueRoute(task.id, 'create')); // đường đi thực tế lấy sau khi ghi xong; chuyến bị hoàn tác thì không gọi dịch vụ
    return pushTask(task.id);
  }
  function taskOrFail(id) {
    const task = store.tasks.get(idOf(id));
    if (!task) fail(404, 'not_found', 'Không tìm thấy task.');
    return task;
  }
  const isOpen = (task) => OPEN_STATUS.includes(task.status);

  function patchTask(task, b, actor) {
    if (!isOpen(task)) fail(409, 'task_closed', 'Task đã kết thúc, không sửa được nữa.');
    const patch = {}, prevFo = task.fo_id;
    let newStops = null;
    if (b.title !== undefined) { patch.title = cleanStr(b.title, 80); if (!patch.title) fail(400, 'bad_title', 'Cần nhập tên task.'); }
    if (b.note !== undefined) patch.note = cleanText(b.note, 500);
    if (b.stops !== undefined || b.round_trip !== undefined) {
      if (task.status === 'in_progress') fail(409, 'task_running', 'Task đang chạy, không đổi danh sách điểm được. Huỷ rồi tạo task mới nếu cần.');
      if (stopsOf(task.id).some((s) => s.hub && (s.hub.jobs || []).length)) fail(409, 'hub_task', 'Chuyến này gom từ việc của Ops Hub. Muốn đổi điểm: huỷ chuyến (các việc tự trở về danh sách chờ) rồi gom lại.');
      const roundTrip = b.round_trip !== undefined ? !!b.round_trip : !!task.round_trip;
      const input = b.stops !== undefined ? b.stops : stopsOf(task.id).filter((o) => !o.is_return).map(stopToInput);
      newStops = buildStops(input, roundTrip);
      Object.assign(patch, planOf(newStops), NO_ROUTE, { round_trip: roundTrip ? 1 : 0 });
    }
    const startAt = startAtOf(b, task.date);
    if (startAt !== null) {
      if (task.status === 'in_progress') fail(409, 'task_running', 'Task đang chạy, không đổi giờ bắt đầu được.');
      if (localDate(startAt, off) !== task.date) fail(400, 'bad_time', 'Giờ bắt đầu không nằm trong ngày của task.');
      patch.start_at = startAt; patch.al_nostart = 0;
    }
    if (b.fo_id !== undefined) {
      const fo = b.fo_id === null || b.fo_id === '' ? null : foOrFail(b.fo_id);
      const nextFo = fo ? fo.id : null;
      if (nextFo !== task.fo_id) {
        patch.fo_id = nextFo;
        patch.status = fo ? 'assigned' : 'unassigned';
        patch.accepted_at = null; patch.started_at = null; patch.al_nostart = 0;
      }
    }
    if (patch.start_at !== undefined || patch.base_min !== undefined) {
      const base = patch.base_min ?? task.base_min, st = patch.start_at ?? task.start_at;
      patch.factor = factorFor({ ...task, ...patch }, K.conditions());
      patch.due_at = dueOf(st, base, patch.factor); patch.al_risk = 0; patch.al_late = 0;
    }
    store.tx(() => {
      store.tasks.update(task.id, patch);
      if (newStops) {
        store.stops.removeWhere({ task_id: task.id });
        newStops.forEach((s, i) => store.stops.insert({ ...blankStop, ...s, task_id: task.id, seq: i + 1 }));
      }
    });
    if (K.deps.route && (newStops || patch.start_at !== undefined)) store.afterCommit(() => queueRoute(task.id, newStops ? 'stops' : 'start_time')); // điểm hoặc giờ đi đổi: lấy lại đường
    if (patch.fo_id !== undefined) {
      const fo = patch.fo_id ? store.users.get(patch.fo_id) : null;
      event('task_reassigned', 'info', fo ? `${actor.name} giao task ${task.code} cho ${fo.name}.` : `${actor.name} gỡ FO khỏi task ${task.code}.`, { task_id: task.id, fo_id: patch.fo_id, actor_id: actor.id });
      refreshCur(prevFo);
    }
    return pushTask(task.id, prevFo);
  }

  // ───────────────────────── Ảnh ─────────────────────────
  function decodePhotos(list, min) {
    const arr = Array.isArray(list) ? list : [];
    if (arr.length > cfg.maxPhotos) fail(400, 'too_many_photos', `Tối đa ${cfg.maxPhotos} ảnh mỗi lần.`);
    const out = arr.map((s) => decodeDataUrl(s, cfg.maxPhotoBytes) || fail(400, 'bad_photo', 'Có ảnh không hợp lệ hoặc quá lớn. Chụp lại rồi gửi lại.'));
    if (out.length < min) fail(400, 'photo_required', 'Cần ít nhất một ảnh chụp.');
    return out;
  }
  function savePhotos(decoded, stop, user, by, pos) {
    const t = now();
    decoded.forEach((d, i) => {
      const id = K.deps.token(16), ts = t + i; // +i: giữ đúng thứ tự chụp khi nhiều ảnh gửi cùng lúc
      K.deps.files.put(id, d.bytes, d.mime, ts);
      store.photos.insert({ id, stop_id: stop.id, task_id: stop.task_id, user_id: user.id, by, ts, lat: pos ? pos.lat : null, lon: pos ? pos.lon : null, mime: d.mime, size: d.bytes.length });
    });
  }
  /** Vị trí lúc thao tác: ưu tiên vị trí máy chủ vừa nhận (≤ 2 phút), sau đó mới tới toạ độ do máy FO gửi kèm. */
  function posOf(user, b) {
    const l = live.get(user.id);
    if (l && l.last && now() - l.last.ts <= 120000) return { lat: l.last.lat, lon: l.last.lon };
    const lat = num(b.lat), lon = num(b.lon);
    return validCoord(lat, lon) ? { lat: +lat.toFixed(6), lon: +lon.toFixed(6) } : null;
  }

  // ───────────────────────── Thao tác của FO ─────────────────────────
  function myTask(id, user) {
    const task = taskOrFail(id);
    if (task.fo_id !== user.id) fail(403, 'not_yours', 'Task này không được giao cho bạn.');
    return task;
  }
  function myStop(id, user) {
    const stop = store.stops.get(idOf(id));
    if (!stop) fail(404, 'not_found', 'Không tìm thấy điểm.');
    const task = store.tasks.get(stop.task_id);
    if (!task || task.fo_id !== user.id) fail(403, 'not_yours', 'Điểm này không thuộc task của bạn.');
    if (task.status !== 'in_progress') fail(409, 'task_not_running', 'Bạn cần bấm “Bắt đầu” task trước.');
    return { stop, task };
  }
  /** Chặng quay về chỉ được ghi nhận sau khi mọi điểm khác của task đã chốt (xong hoặc không giao được). */
  function returnGate(stop) {
    if (stop.is_return && stopsOf(stop.task_id).some((x) => !x.is_return && (x.status === 'pending' || x.status === 'arrived'))) fail(409, 'not_yet', 'Cần chốt các điểm khác trước khi xác nhận đã về.');
  }
  /** BO phải xác nhận lượt vừa giao nhận thì FO mới được làm điểm kế tiếp. */
  function boGate(stop) {
    const w = stopsOf(stop.task_id).find((x) => x.id !== stop.id && x.status === 'done' && x.bo_status === 'pending');
    if (w) fail(409, 'wait_bo', `Cần BO tại ${w.name} xác nhận trước khi đi tiếp. Nếu BO chưa nhận được link, bấm “Nhắc Logistic”.`);
  }
  function arriveStop(stop, mode, pos, actor) {
    if (!stop || stop.status !== 'pending') return;
    const t = now(), task = store.tasks.get(stop.task_id);
    store.stops.update(stop.id, { status: 'arrived', arrived_at: t, arrive_mode: mode });
    const fo = store.users.get(task.fo_id);
    const d = pos ? Math.round(distM(pos.lat, pos.lon, stop.lat, stop.lon)) : null;
    if (mode === 'manual' && (d === null || d > cfg.farProofM)) {
      event('far_arrive', 'warn', `${fo.name} bấm “Đã đến” ${stop.name} (task ${task.code}) ${d === null ? 'khi không có vị trí GPS' : `khi còn cách điểm ${d} m`}.`, { task_id: task.id, stop_id: stop.id, fo_id: fo.id, actor_id: actor ? actor.id : null, data: { dist: d } });
    } else event('arrived', 'info', `${fo.name} đã đến ${stop.name} (task ${task.code}).`, { task_id: task.id, stop_id: stop.id, fo_id: fo.id, data: { mode, dist: d } });
    refreshCur(task.fo_id);
    pushTask(task.id);
  }
  function finishIfDone(taskId) {
    const task = store.tasks.get(taskId), stops = stopsOf(taskId);
    if (task.status !== 'in_progress' || stops.some((s) => s.status === 'pending' || s.status === 'arrived')) return;
    if (stops.some((s) => s.status === 'done' && s.bo_status === 'pending')) return; // còn chờ BO xác nhận thì task chưa xong
    const t = now(), done = stops.filter((s) => s.status === 'done').length;
    const l = live.get(task.fo_id);
    if (l) flushCur(l);
    // Mọi điểm đều được bỏ qua (việc rời chuyến, không còn gì để làm): chuyến huỷ, không tính FO không hoàn thành.
    if (!done && stops.every((s) => s.status === 'skipped')) { cancelTask(task, 'Mọi điểm đã được bỏ qua: không còn việc nào trong chuyến', null); return; }
    const fresh = store.tasks.get(taskId);
    const counted = stops.filter((s) => s.status !== 'skipped').length; // điểm được bỏ qua (hết việc) không tính là thiếu
    const patch = { status: done ? 'completed' : 'failed', partial: done && done < counted ? 1 : 0, finished_at: t, late: t > fresh.due_at ? 1 : 0 };
    store.tasks.update(taskId, patch);
    fire('onTaskClosed', store.tasks.get(taskId));
    const fo = store.users.get(task.fo_id);
    const lateMin = Math.round((t - fresh.due_at) / 60000);
    if (!done) event('task_failed', 'alert', `Task ${task.code} của ${fo.name} không hoàn thành được điểm nào.`, { task_id: taskId, fo_id: fo.id });
    else event('task_done', patch.late || patch.partial ? 'warn' : 'info', `${fo.name} hoàn thành task ${task.code}${patch.partial ? ' (có điểm không giao được)' : ''}${patch.late ? `, trễ ${lateMin} phút so với hạn` : ', đúng hạn'}.`, { task_id: taskId, fo_id: fo.id });
    refreshCur(task.fo_id);
  }

  R('GET', '/api/my/tasks', ['fo'], ({ user }) => {
    const t0 = dayStart(today(), off);
    const rows = store.tasks.find({ fo_id: user.id }, { order: 'start_at' }).filter((x) => isOpen(x) || x.date === today() || (x.finished_at && x.finished_at >= t0));
    return { tasks: rows.map((x) => taskView(x)), conditions: K.conditions() };
  });
  R('POST', '/api/tasks/:id/accept', ['fo'], ({ user, p }) => {
    const task = myTask(p.id, user);
    if (task.status !== 'assigned') fail(409, 'bad_state', 'Task này không ở trạng thái chờ nhận.');
    store.tasks.update(task.id, { status: 'accepted', accepted_at: now() });
    event('task_accepted', 'info', `${user.name} đã nhận task ${task.code}.`, { task_id: task.id, fo_id: user.id, actor_id: user.id });
    return { task: pushTask(task.id) };
  });
  R('POST', '/api/tasks/:id/decline', ['fo'], ({ user, p, b }) => {
    const task = myTask(p.id, user);
    if (task.status !== 'assigned' && task.status !== 'accepted') fail(409, 'bad_state', 'Chỉ từ chối được task chưa bắt đầu.');
    const reason = cleanStr(b.reason, 200);
    if (reason.length < 3) fail(400, 'reason_required', 'Cần ghi lý do từ chối.');
    store.tasks.update(task.id, { status: 'unassigned', fo_id: null, accepted_at: null, al_nostart: 0 });
    event('task_declined', 'alert', `${user.name} từ chối task ${task.code}: ${reason}. Cần giao cho FO khác.`, { task_id: task.id, fo_id: user.id, actor_id: user.id });
    pushTask(task.id, user.id);
    return { ok: true };
  });
  R('POST', '/api/tasks/:id/start', ['fo'], ({ user, p }) => {
    const task = myTask(p.id, user);
    if (task.status !== 'assigned' && task.status !== 'accepted') fail(409, 'bad_state', 'Task này không ở trạng thái có thể bắt đầu.');
    const running = store.tasks.find({ fo_id: user.id, status: 'in_progress' }, { limit: 1 })[0];
    if (running) fail(409, 'busy', `Bạn đang làm task ${running.code}. Hoàn thành task đó trước.`);
    const t = now();
    store.tasks.update(task.id, { status: 'in_progress', accepted_at: task.accepted_at || t, started_at: t });
    fire('onTaskStarted', store.tasks.get(task.id));
    if (K.deps.route && (!task.route_at || t - task.route_at > 600000)) store.afterCommit(() => queueRoute(task.id, 'start')); // đường cũ quá 10 phút: lấy lại theo giao thông lúc xuất phát
    K.startShift(ensureLive(user.id), t); // bắt đầu task thì tự vào ca
    refreshCur(user.id);
    event('task_started', 'info', `${user.name} bắt đầu task ${task.code}.`, { task_id: task.id, fo_id: user.id, actor_id: user.id });
    // Đang đứng sẵn trong vùng của điểm nào thì ghi nhận "đã đến" luôn.
    const l = live.get(user.id);
    if (l && l.last && t - l.last.ts <= 120000 && hooks.onPoint) hooks.onPoint(l, l.last, t);
    return { task: pushTask(task.id) };
  });
  R('POST', '/api/stops/:id/arrive', ['fo'], ({ user, p, b }) => {
    const { stop, task } = myStop(p.id, user);
    if (stop.status !== 'pending') fail(409, 'bad_state', 'Điểm này đã được ghi nhận rồi.');
    returnGate(stop);
    boGate(stop);
    arriveStop(stop, 'manual', posOf(user, b), user);
    return { task: taskView(store.tasks.get(task.id)) };
  });
  R('POST', '/api/stops/:id/proof', ['fo'], ({ user, p, b }) => {
    const { stop, task } = myStop(p.id, user);
    if (stop.status !== 'pending' && stop.status !== 'arrived') fail(409, 'bad_state', 'Điểm này đã được xác nhận rồi.');
    returnGate(stop);
    boGate(stop);
    const photos = decodePhotos(b.photos, stop.is_return ? 0 : 1);
    const counts = { cards_out: count(b.cards_out, 'Số thẻ giao'), cards_in: count(b.cards_in, 'Số thẻ thu'), dev_out: count(b.dev_out, 'Số thiết bị giao'), dev_in: count(b.dev_in, 'Số thiết bị thu') };
    const pos = posOf(user, b), t = now();
    const dist = pos ? Math.round(distM(pos.lat, pos.lon, stop.lat, stop.lon)) : null;
    const needBo = !!stop.bo_req;
    store.tx(() => {
      savePhotos(photos, stop, user, 'fo', pos);
      store.stops.update(stop.id, { status: 'done', done_at: t, arrived_at: stop.arrived_at || t, arrive_mode: stop.arrive_mode || 'proof', ...counts, fo_note: cleanStr(b.note, 300), proof_dist: dist, bo_status: needBo ? 'pending' : 'none' });
    });
    if (!needBo) fire('onStopClosed', store.stops.get(stop.id), store.tasks.get(task.id));
    const diff = counts.cards_out !== stop.exp_cards_out || counts.cards_in !== stop.exp_cards_in || counts.dev_out !== stop.exp_dev_out || counts.dev_in !== stop.exp_dev_in;
    event('stop_done', 'info', `${user.name} xác nhận ${stop.name} (task ${task.code}): giao ${counts.cards_out} thẻ, thu ${counts.cards_in} thẻ, giao ${counts.dev_out} thiết bị, thu ${counts.dev_in} thiết bị.`, { task_id: task.id, stop_id: stop.id, fo_id: user.id, actor_id: user.id, data: { dist } });
    if (diff && !stop.is_return) event('count_diff', 'warn', `Số lượng tại ${stop.name} (task ${task.code}) khác kế hoạch: kế hoạch giao ${stop.exp_cards_out} thẻ / thu ${stop.exp_cards_in} thẻ / giao ${stop.exp_dev_out} TB / thu ${stop.exp_dev_in} TB; FO báo ${counts.cards_out} / ${counts.cards_in} / ${counts.dev_out} / ${counts.dev_in}.`, { task_id: task.id, stop_id: stop.id, fo_id: user.id });
    if (!stop.is_return && (dist === null || dist > cfg.farProofM)) event('far_proof', 'warn', `${user.name} xác nhận ${stop.name} (task ${task.code}) ${dist === null ? 'khi không có vị trí GPS' : `khi cách điểm ${dist} m`}. Nên xem lại ảnh.`, { task_id: task.id, stop_id: stop.id, fo_id: user.id, data: { dist } });
    if (needBo && !stop.bo_link_hash) event('bo_no_link', 'alert', `${user.name} đã giao nhận xong tại ${stop.name} (task ${task.code}) nhưng BO chưa có link xác nhận. Tạo và gửi link ngay: FO phải chờ BO xác nhận mới đi tiếp được.`, { task_id: task.id, stop_id: stop.id, fo_id: user.id });
    finishIfDone(task.id);
    refreshCur(user.id);
    return { task: pushTask(task.id) };
  });
  R('POST', '/api/stops/:id/fail', ['fo'], ({ user, p, b }) => {
    const { stop, task } = myStop(p.id, user);
    if (stop.status !== 'pending' && stop.status !== 'arrived') fail(409, 'bad_state', 'Điểm này đã được xác nhận rồi.');
    boGate(stop);
    const reason = cleanStr(b.reason, 200);
    if (reason.length < 3) fail(400, 'reason_required', 'Cần ghi lý do không giao nhận được.');
    const photos = decodePhotos(b.photos, 0), pos = posOf(user, b);
    store.tx(() => {
      savePhotos(photos, stop, user, 'fo', pos);
      store.stops.update(stop.id, { status: 'failed', done_at: now(), fail_reason: reason, proof_dist: pos ? Math.round(distM(pos.lat, pos.lon, stop.lat, stop.lon)) : null });
    });
    fire('onStopFailed', store.stops.get(stop.id), store.tasks.get(task.id));
    event('stop_failed', 'alert', `${user.name} không giao nhận được tại ${stop.name} (task ${task.code}): ${reason}.`, { task_id: task.id, stop_id: stop.id, fo_id: user.id, actor_id: user.id });
    finishIfDone(task.id);
    refreshCur(user.id);
    return { task: pushTask(task.id) };
  });
  R('POST', '/api/issues', ['fo'], ({ user, b }) => {
    if (!ISSUE_KINDS[b.kind]) fail(400, 'bad_kind', 'Loại sự cố không hợp lệ.');
    const note = cleanStr(b.note, 300);
    let task = null;
    if (b.task_id) { task = store.tasks.get(int(b.task_id, 1, 1e12) ?? -1); if (!task || task.fo_id !== user.id) task = null; }
    const ev = event('issue', 'alert', `${user.name} báo sự cố: ${ISSUE_KINDS[b.kind]}${note ? ` — ${note}` : ''}${task ? ` (task ${task.code})` : ''}.`, { task_id: task ? task.id : null, fo_id: user.id, actor_id: user.id, data: { kind: b.kind } });
    return { ok: true, id: ev.id };
  });
  R('GET', '/api/my/summary', ['fo'], ({ user }) => {
    const l = live.get(user.id);
    if (l) K.flushDay(l);
    const s = stats(today(), today(), user.id);
    return { date: today(), row: s.fos[0] || null, onShift: !!(l && l.onShift) };
  });

  // ───────────────────────── Điều phối (Logistic) ─────────────────────────
  R('GET', '/api/tasks', OPS, ({ q }) => {
    let rows;
    if (q.open === '1') rows = store.tasks.find({ status: OPEN_STATUS }, { order: 'start_at' });
    else {
      const date = q.date || today();
      if (!isDate(date)) fail(400, 'bad_date', 'Ngày không hợp lệ.');
      rows = store.tasks.find({ date }, { order: 'start_at' });
    }
    return { tasks: rows.map((x) => taskView(x)), conditions: K.conditions() };
  });
  R('POST', '/api/tasks', OPS, ({ user, b }) => ({ task: createTask(b, user) }));
  R('GET', '/api/tasks/:id', [...OPS, 'fo'], ({ user, p }) => {
    const task = user.role === 'fo' ? myTask(p.id, user) : taskOrFail(p.id);
    return { task: taskView(task), events: user.role === 'fo' ? [] : store.events.find({ task_id: task.id }, { order: 'ts' }) };
  });
  /** Đường đi thực tế của task (hình từng chặng, đoạn kẹt xe) để vẽ bản đồ. FO chỉ xem task của mình. stale: danh sách điểm đã đổi sau lần tính. */
  R('GET', '/api/tasks/:id/route', [...OPS, 'fo'], ({ user, p }) => {
    const task = store.tasks.get(idOf(p.id));
    if (!task || (user.role === 'fo' && task.fo_id !== user.id)) fail(404, 'not_found', 'Không tìm thấy task.');
    const row = store.routes.find({ task_id: task.id }, { limit: 1 })[0];
    return { route: row ? routeOut(row) : null, stale: !!row && row.sig !== sigOf(stopsOf(task.id)) };
  });
  /** Logistic bấm "Tính lại đường": lấy đường mới theo giao thông hiện tại, chờ dịch vụ bản đồ trả lời rồi trả task đã cập nhật (lỗi thì task.route_err). */
  R('POST', '/api/tasks/:id/reroute', OPS, async ({ p }) => {
    const task = taskOrFail(p.id);
    if (!isOpen(task)) fail(409, 'task_closed', 'Task đã kết thúc, không tính lại đường được.');
    if (!K.deps.route) fail(400, 'no_routing', 'Máy chủ chưa bật dịch vụ đường đi thực tế (ROUTING_PROVIDER).');
    if (stopsOf(task.id).length < 2) fail(400, 'one_stop', 'Task chỉ có một điểm, không có chặng nào để tính đường.');
    await routeNow(task.id, 'manual');
    return { task: taskView(store.tasks.get(task.id)) };
  });
  R('PATCH', '/api/tasks/:id', OPS, ({ user, p, b }) => ({ task: patchTask(taskOrFail(p.id), b, user) }));
  R('POST', '/api/tasks/:id/cancel', OPS, ({ user, p, b }) => {
    const task = taskOrFail(p.id);
    if (!isOpen(task)) fail(409, 'task_closed', 'Task đã kết thúc rồi.');
    return { task: cancelTask(task, cleanStr(b.reason, 200), user) };
  });
  function cancelTask(task, reason, actor) {
    store.tasks.update(task.id, { status: 'cancelled', finished_at: now(), cancel_reason: reason });
    fire('onTaskClosed', store.tasks.get(task.id));
    event('task_cancelled', 'info', `${actor ? actor.name : 'Hệ thống'} huỷ task ${task.code}${reason ? `: ${reason}` : ''}.`, { task_id: task.id, fo_id: task.fo_id, actor_id: actor ? actor.id : null });
    refreshCur(task.fo_id);
    return pushTask(task.id);
  }
  /**
   * Ops Hub gỡ hết việc của một số điểm (việc rời chuyến). Task chưa chạy: bỏ các điểm đó khỏi tuyến, đánh số lại, tính lại km và hạn
   * (không bỏ hết điểm: khi đó bên gọi huỷ task). Task đang chạy: điểm được ghi "bỏ qua" để FO không phải ghé; không tính là không giao được.
   */
  function dropStops(taskId, ids, why) {
    const task = store.tasks.get(taskId);
    if (!task || !isOpen(task)) return null;
    const all = stopsOf(taskId), drop = all.filter((s) => ids.includes(s.id) && (s.status === 'pending' || s.status === 'arrived'));
    if (!drop.length) return null;
    const reason = cleanStr(why, 200);
    if (task.status === 'in_progress') {
      store.tx(() => { for (const s of drop) store.stops.update(s.id, { status: 'skipped', done_at: now(), fail_reason: reason, bo_req: 0 }); });
      for (const s of drop) event('stop_skipped', 'info', `Bỏ qua ${s.name} trong task ${task.code}: ${reason}.`, { task_id: task.id, stop_id: s.id, fo_id: task.fo_id });
      refreshCur(task.fo_id);
      finishIfDone(taskId);
      return pushTask(taskId);
    }
    const rest = all.filter((s) => !drop.includes(s));
    if (!rest.some((s) => !s.is_return)) return null;
    // Đường đi cũ hết đúng (SLA về ước tính đường chim bay): hệ số cũng về hệ số chung nếu trước đó theo đường đã tính kẹt xe.
    const plan = planOf(rest), factor = (!task.route_traffic && task.factor) || K.conditions().factor;
    store.tx(() => {
      for (const s of drop) store.stops.remove(s.id);
      rest.forEach((s, i) => { if (s.seq !== i + 1) store.stops.update(s.id, { seq: i + 1 }); });
      store.tasks.update(task.id, { ...plan, ...NO_ROUTE, factor, due_at: dueOf(task.start_at, plan.base_min, factor), al_risk: 0, al_late: 0 });
    });
    for (const s of drop) event('stop_removed', 'info', `Bỏ ${s.name} khỏi task ${task.code}: ${reason}.`, { task_id: task.id, fo_id: task.fo_id });
    if (K.deps.route && rest.length > 1) store.afterCommit(() => queueRoute(taskId, 'drop'));
    return pushTask(taskId);
  }
  /** Xem trước SLA khi soạn task (ước tính đường chim bay). */
  function planPreview(b) {
    const stops = buildStops(b.stops, !!b.round_trip), plan = planOf(stops), c = K.conditions();
    const out = { ...plan, factor: c.factor, sla_min: Math.round(plan.base_min * c.factor) };
    if (b.optimize) { // gợi ý thứ tự ghé ngắn nhất, giữ nguyên điểm đầu
      const work = stops.filter((s) => !s.is_return);
      out.order = optimizeOrder(work, !!b.round_trip);
      const best = planOf(buildStops(out.order.map((i) => b.stops[i]), !!b.round_trip));
      out.best_km = best.plan_km; out.best_min = Math.round(best.base_min * c.factor);
    }
    return { out, stops };
  }
  if (!K.deps.route) R('POST', '/api/plan', OPS, ({ b }) => planPreview(b).out);
  else {
    /** Giờ xuất phát của bản xem trước, như khi tạo task: ngày + giờ bắt đầu; bỏ trống thì hôm nay đi ngay, ngày khác 08:00. Sai dạng thì coi như đi ngay. */
    const departOf = (b) => {
      const t = now(), date = isDate(b.date) ? b.date : localDate(t, off), n = num(b.start_at);
      if (isHM(b.start_time)) return Math.max(t, atTime(date, b.start_time, off));
      if (n !== null) return Math.max(t, Math.round(n));
      return date === localDate(t, off) ? t : Math.max(t, atTime(date, '08:00', off));
    };
    // Có dịch vụ đường đi: kèm đường thực tế (hình từng chặng) và SLA theo đường đó; est: số ước tính đường chim bay. Dịch vụ lỗi → giữ số ước tính, route_err.
    // Gợi ý thứ tự ghé (order, best_km, best_min) vẫn tính theo đường chim bay.
    R('POST', '/api/plan', OPS, async ({ b }) => {
      const { out, stops } = planPreview(b);
      Object.assign(out, { src: 'estimate', traffic: false, travel_min: null, traffic_min: null, service_min: null, buffer_min: null, p50_min: null, unc_min: null, sla_q: null, route: null, route_err: null, est: { plan_km: out.plan_km, base_min: out.base_min } });
      if (stops.length < 2) return out;
      const departAt = departOf(b);
      try {
        const r = cleanRoute(await K.deps.route(stops.map((s) => ({ lat: s.lat, lon: s.lon })), { departAt }), stops.length, departAt);
        const plan = planFromRoute(stops, r), factor = factorFor({ route_traffic: r.traffic ? 1 : 0 }, K.conditions());
        Object.assign(out, plan, { factor, sla_min: Math.round(plan.base_min * factor), src: r.provider, traffic: r.traffic, route: routeOut(r) });
      } catch (e) { out.route_err = errOf(e); }
      return out;
    });
  }
  R('GET', '/api/suggest', OPS, ({ q }) => {
    const lat = num(q.lat), lon = num(q.lon), t = now();
    const open = store.tasks.find({ status: OPEN_STATUS });
    const list = K.activeFos().filter((u) => !K.needConsent(u)).map((u) => {
      const l = live.get(u.id);
      const fresh = l && l.onShift && l.last && t - l.last.ts <= 300000;
      const km = fresh && validCoord(lat, lon) ? +(distM(l.last.lat, l.last.lon, lat, lon) / 1000).toFixed(1) : null;
      const load = open.filter((x) => x.fo_id === u.id).length;
      // Điểm càng thấp càng nên chọn: gần điểm đầu, đang ít việc, đang trong ca.
      return { id: u.id, name: u.name, color: u.color, onShift: !!(l && l.onShift), km, open: load, score: +((km === null ? 15 : km) + load * 4 + (fresh ? 0 : 10)).toFixed(1) };
    });
    list.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    return { fos: list };
  });

  // ───────────────────────── BO: theo dõi và xác nhận qua link dùng một lần (không cần tài khoản) ─────────────────────────
  // Logistic tạo link cho TỪNG lượt giao nhận rồi gửi cho BO. Link chỉ dùng cho lượt đó, gắn với thiết bị đầu tiên mở nó,
  // hết hiệu lực khi tạo link mới, khi lượt giao nhận đã chốt xong hoặc sau cfg.boLinkHours giờ.
  const TOKEN_RE = /^[A-Za-z0-9_-]{20,80}$/;
  const BO_DONE = ['confirmed', 'mismatch', 'waived'];
  R('POST', '/api/stops/:id/bo-link', OPS, ({ user, p }) => {
    const stop = store.stops.get(idOf(p.id)), task = stop ? store.tasks.get(stop.task_id) : null;
    if (!stop || !task) fail(404, 'not_found', 'Không tìm thấy điểm này.');
    if (!stop.bo_req) fail(400, 'no_bo', 'Điểm này không cần BO xác nhận.');
    if (!isOpen(task) || stop.status === 'failed' || stop.status === 'skipped' || BO_DONE.includes(stop.bo_status)) fail(409, 'bad_state', 'Lượt giao nhận này đã chốt xong, không cần link nữa.');
    const token = K.deps.token(24), again = !!stop.bo_link_hash;
    store.stops.update(stop.id, { bo_link_hash: K.deps.sha(token), bo_link_at: now(), bo_link_dev: null, bo_link_open_at: null });
    event('bo_link', 'info', `${user.name} tạo ${again ? 'lại ' : ''}link xác nhận cho ${boLabel(stop.name)} (task ${task.code})${again ? '; link cũ hết hiệu lực' : ''}.`, { task_id: task.id, stop_id: stop.id, actor_id: user.id });
    return { token, task: pushTask(task.id) };
  });
  /** Tìm lượt giao nhận theo link; lần mở đầu tiên gắn link với thiết bị đó (bind = false: chỉ kiểm tra, không gắn). */
  function linkStop(token, ctx, bind = true) {
    const key = 'bl:' + (ctx.ip || '');
    if (K.limited(key, 30)) fail(429, 'too_many_attempts', 'Thử quá nhiều lần. Đợi 10 phút rồi mở lại link.');
    const stop = typeof token === 'string' && TOKEN_RE.test(token) ? store.stops.find({ bo_link_hash: K.deps.sha(token) }, { limit: 1 })[0] : null;
    const task = stop ? store.tasks.get(stop.task_id) : null;
    if (!stop || !task || now() - stop.bo_link_at > cfg.boLinkHours * 3600000) { K.noteFail(key); fail(404, 'link_invalid', 'Link không còn hiệu lực. Nhờ Logistic gửi link mới.'); }
    let dev = typeof ctx.dev === 'string' && TOKEN_RE.test(ctx.dev) ? ctx.dev : null, setDev = null;
    if (!stop.bo_link_dev) {
      if (!bind) fail(403, 'link_used', 'Mở link trước đã.');
      if (!dev) { dev = K.deps.token(24); setDev = dev; }
      store.stops.update(stop.id, { bo_link_dev: K.deps.sha(dev), bo_link_open_at: now() });
      event('bo_link_opened', 'info', `${boLabel(stop.name)} đã mở link xác nhận (task ${task.code}).`, { task_id: task.id, stop_id: stop.id });
      pushTask(task.id);
    } else if (!dev || K.deps.sha(dev) !== stop.bo_link_dev) {
      fail(403, 'link_used', 'Link này đã được mở trên một thiết bị khác nên không dùng lại được. Nhờ Logistic gửi link mới.');
    }
    return { stop: store.stops.get(stop.id), task, setDev };
  }
  function linkView(stop, task) {
    const t = now(), fo = task.fo_id ? store.users.get(task.fo_id) : null;
    let state;
    if (stop.bo_status === 'confirmed' || stop.bo_status === 'mismatch') state = 'done';
    else if (stop.bo_status === 'waived' || stop.status === 'failed' || stop.status === 'skipped' || !isOpen(task)) state = 'closed';
    else if (stop.status === 'done') state = 'confirm';
    else if (stop.status === 'arrived') state = 'arrived';
    else if (task.status === 'in_progress') state = 'coming';
    else state = 'waiting';
    const out = {
      now: t, state, task_code: task.code, start_at: task.start_at, note: stop.note,
      site: { name: stop.name, address: stop.address, lat: stop.lat, lon: stop.lon },
      fo: fo && state !== 'closed' ? { name: fo.name, phone: fo.phone || '', vehicle: fo.vehicle || '' } : null,
      exp: { cards_out: stop.exp_cards_out, cards_in: stop.exp_cards_in, dev_out: stop.exp_dev_out, dev_in: stop.exp_dev_in },
      maxPhotos: cfg.maxPhotos, cfg: { tileUrl: cfg.tileUrl, tileAttribution: cfg.tileAttribution, tzOffsetMin: off, routingProvider: cfg.routingProvider || null, mapTiles: cfg.mapTiles || null }, // nền bản đồ như /api/me (đường của Google vẽ trên nền Google)
    };
    // Vị trí của FO chỉ lộ cho BO khi FO đang làm đúng task này và chưa giao nhận xong tại điểm của BO.
    const l = task.fo_id ? live.get(task.fo_id) : null;
    if ((state === 'coming' || state === 'arrived') && l && l.onShift && l.last && t - l.last.ts <= 300000) {
      out.pos = { lat: l.last.lat, lon: l.last.lon, ts: l.last.ts, hdg: l.last.hdg ?? null };
      out.dist_km = +((distM(l.last.lat, l.last.lon, stop.lat, stop.lon) / 1000) * cfg.sla.roadFactor).toFixed(1);
      out.eta_min = Math.max(1, Math.round((out.dist_km / cfg.sla.speedKmh) * 60));
      const all = stopsOf(task.id);
      out.before = all.filter((x) => x.seq < stop.seq && (x.status === 'pending' || x.status === 'arrived')).length;
      // BO là điểm kế tiếp và chuyến có đường thực tế: phần đường còn lại từ FO tới BO (path), km và phút theo đường đó. Không có thì giữ số đường chim bay.
      if (state === 'coming' && out.before === 0 && task.route_at) { const r = pathTo(task, all, stop, l.last, t); if (r) Object.assign(out, r); }
    }
    if (state === 'confirm' || state === 'done') {
      out.done_at = stop.done_at; out.fo_note = stop.fo_note;
      out.fo_counts = { cards_out: stop.cards_out, cards_in: stop.cards_in, dev_out: stop.dev_out, dev_in: stop.dev_in };
      out.photos = store.photos.find({ stop_id: stop.id }, { order: 'ts' }).map((ph) => ({ id: ph.id, by: ph.by, ts: ph.ts }));
    }
    if (state === 'done') out.bo = { status: stop.bo_status, at: stop.bo_at, cards_recv: stop.bo_cards_recv, cards_given: stop.bo_cards_given, dev_recv: stop.bo_dev_recv, dev_given: stop.bo_dev_given };
    return out;
  }
  const withDev = (out, r) => { if (r.setDev) out.__dev = r.setDev; return out; };
  R('POST', '/api/bo-link/view', 'public', ({ ctx, b }) => { const r = linkStop(b.token, ctx); return withDev(linkView(r.stop, r.task), r); });
  R('POST', '/api/bo-link/confirm', 'public', ({ ctx, b }) => {
    const r = linkStop(b.token, ctx), { stop, task } = r;
    if (stop.status !== 'done') fail(409, 'bad_state', 'FO chưa xác nhận lượt bàn giao này.');
    if (stop.bo_status !== 'pending') fail(409, 'already_confirmed', 'Lượt bàn giao này đã được xác nhận rồi.');
    const photos = decodePhotos(b.photos, 1);
    const c = { bo_cards_recv: count(b.cards_recv, 'Số thẻ đã nhận'), bo_cards_given: count(b.cards_given, 'Số thẻ đã giao'), bo_dev_recv: count(b.dev_recv, 'Số thiết bị đã nhận'), bo_dev_given: count(b.dev_given, 'Số thiết bị đã giao') };
    const match = c.bo_cards_recv === stop.cards_out && c.bo_cards_given === stop.cards_in && c.bo_dev_recv === stop.dev_out && c.bo_dev_given === stop.dev_in;
    store.tx(() => {
      savePhotos(photos, stop, { id: null }, 'bo', null);
      store.stops.update(stop.id, { ...c, bo_status: match ? 'confirmed' : 'mismatch', bo_user: null, bo_at: now(), bo_note: cleanStr(b.note, 300) });
    });
    fire('onStopClosed', store.stops.get(stop.id), store.tasks.get(task.id));
    if (match) event('bo_confirmed', 'info', `${boLabel(stop.name)} xác nhận đã bàn giao đủ với task ${task.code}.`, { task_id: task.id, stop_id: stop.id, fo_id: task.fo_id });
    else event('bo_mismatch', 'alert', `Lệch số lượng tại ${stop.name} (task ${task.code}): FO báo giao ${stop.cards_out} thẻ / thu ${stop.cards_in} thẻ / giao ${stop.dev_out} TB / thu ${stop.dev_in} TB; BO báo nhận ${c.bo_cards_recv} thẻ / giao ${c.bo_cards_given} thẻ / nhận ${c.bo_dev_recv} TB / giao ${c.bo_dev_given} TB.`, { task_id: task.id, stop_id: stop.id, fo_id: task.fo_id });
    finishIfDone(task.id); // BO xác nhận xong: FO được đi tiếp; nếu đây là điểm cuối thì task hoàn thành
    refreshCur(task.fo_id);
    pushTask(task.id);
    return withDev(linkView(store.stops.get(stop.id), store.tasks.get(task.id)), r);
  });
  R('GET', '/api/bo-link/photo/:id', 'public', ({ ctx, p, q }) => {
    const r = linkStop(q.t, ctx, false);
    const ph = /^[A-Za-z0-9_-]{8,64}$/.test(p.id) ? store.photos.get(p.id) : null;
    if (!ph || ph.stop_id !== r.stop.id || r.stop.status !== 'done') fail(404, 'not_found', 'Không tìm thấy ảnh.');
    return { __photo: { id: ph.id, mime: ph.mime, ts: ph.ts } };
  });
  /** Lối thoát khi BO không thể xác nhận (không liên lạc được, hết pin…): Logistic cho qua, có ghi lý do. */
  R('POST', '/api/stops/:id/bo-waive', OPS, ({ user, p, b }) => {
    const stop = store.stops.get(idOf(p.id)), task = stop ? store.tasks.get(stop.task_id) : null;
    if (!stop || !task) fail(404, 'not_found', 'Không tìm thấy điểm này.');
    if (stop.status !== 'done' || stop.bo_status !== 'pending') fail(409, 'bad_state', 'Điểm này không ở trạng thái chờ BO xác nhận.');
    const reason = cleanStr(b.reason, 200);
    if (reason.length < 3) fail(400, 'reason_required', 'Cần ghi lý do cho qua xác nhận của BO.');
    store.stops.update(stop.id, { bo_status: 'waived', bo_user: user.id, bo_at: now(), bo_waive_reason: reason, bo_link_hash: null, bo_link_dev: null });
    fire('onStopClosed', store.stops.get(stop.id), store.tasks.get(task.id));
    event('bo_waived', 'warn', `${user.name} cho qua xác nhận của BO tại ${stop.name} (task ${task.code}): ${reason}.`, { task_id: task.id, stop_id: stop.id, fo_id: task.fo_id, actor_id: user.id });
    finishIfDone(task.id);
    refreshCur(task.fo_id);
    return { task: pushTask(task.id) };
  });

  // ───────────────────────── Ảnh: kiểm tra quyền xem ─────────────────────────
  R('GET', '/api/photo/:id', 'any', ({ user, p }) => {
    const ph = /^[A-Za-z0-9_-]{8,64}$/.test(p.id) ? store.photos.get(p.id) : null;
    if (!ph) fail(404, 'not_found', 'Không tìm thấy ảnh.');
    if (ph.ref) { // ảnh của Ops Hub (dung lượng thẻ, sự cố)
      if (!K.hub || !K.hub.canSeePhoto(user, ph)) fail(403, 'forbidden', 'Bạn không có quyền xem ảnh này.');
    } else if (!K.isOps(user.role)) {
      const stop = store.stops.get(ph.stop_id), task = stop ? store.tasks.get(stop.task_id) : null;
      const ok = user.role === 'fo' && (ph.user_id === user.id || (task && task.fo_id === user.id));
      if (!ok) fail(403, 'forbidden', 'Bạn không có quyền xem ảnh này.');
    }
    return { __photo: { id: ph.id, mime: ph.mime, ts: ph.ts } };
  });

  // ───────────────────────── Tuyến định kỳ ─────────────────────────
  function templateInput(b, cur) {
    const out = {};
    const has = (k) => b[k] !== undefined || !cur;
    if (has('name')) { out.name = cleanStr(b.name, 80); if (!out.name) fail(400, 'bad_name', 'Cần nhập tên tuyến.'); }
    if (has('fo_id')) out.fo_id = b.fo_id === undefined || b.fo_id === null || b.fo_id === '' ? null : foOrFail(b.fo_id).id;
    if (has('days')) {
      const days = [...new Set((Array.isArray(b.days) ? b.days : []).map((d) => int(d, 1, 7)).filter((d) => d !== null))].sort();
      if (!days.length) fail(400, 'bad_days', 'Chọn ít nhất một ngày trong tuần.');
      out.days = days.join(',');
    }
    if (has('start_time')) { if (!isHM(b.start_time)) fail(400, 'bad_time', 'Giờ bắt đầu phải có dạng GG:PP.'); out.start_time = b.start_time; }
    if (has('round_trip')) out.round_trip = b.round_trip ? 1 : 0;
    if (has('note')) out.note = cleanText(b.note, 500);
    if (has('active')) out.active = b.active === undefined ? 1 : b.active ? 1 : 0;
    if (has('stops') || b.round_trip !== undefined) {
      const src = b.stops !== undefined ? b.stops : cur.stops;
      const rt = out.round_trip !== undefined ? !!out.round_trip : !!(cur && cur.round_trip);
      if (!Array.isArray(src) || src.some((s) => !s || s.site_id === undefined || s.site_id === null || s.site_id === '')) fail(400, 'bad_stop', 'Mỗi điểm của tuyến định kỳ phải chọn từ danh sách Điểm.');
      const built = buildStops(src, rt).filter((s) => !s.is_return); // kiểm tra hợp lệ
      out.stops = built.map((s) => ({ site_id: s.site_id, note: s.note, cards_out: s.exp_cards_out, cards_in: s.exp_cards_in, dev_out: s.exp_dev_out, dev_in: s.exp_dev_in }));
    }
    return out;
  }
  const tplView = (t) => ({ ...t, days: String(t.days || '').split(',').filter(Boolean).map(Number), active: !!t.active, round_trip: !!t.round_trip });
  /** Sinh task từ tuyến định kỳ cho một ngày. Trả về task hoặc null nếu đã có / không tạo được. */
  function generate(tpl, date, actor) {
    if (store.tasks.count({ template_id: tpl.id, date })) return null;
    const stops = (tpl.stops || []).filter((s) => { const site = store.sites.get(s.site_id); return site && site.active; });
    const fo = tpl.fo_id ? store.users.get(tpl.fo_id) : null;
    const foOk = fo && fo.active && fo.role === 'fo';
    try {
      const view = createTask({ title: tpl.name, fo_id: foOk ? fo.id : null, date, start_time: tpl.start_time, round_trip: !!tpl.round_trip, note: tpl.note, stops }, actor, { template_id: tpl.id });
      if (stops.length < (tpl.stops || []).length) event('template_warn', 'warn', `Tuyến định kỳ “${tpl.name}”: có điểm đã bị xoá nên task ${view.code} thiếu điểm. Kiểm tra lại tuyến.`, { task_id: view.id });
      if (!foOk) event('template_warn', 'alert', `Tuyến định kỳ “${tpl.name}”: task ${view.code} chưa có FO (FO của tuyến bị khoá hoặc chưa chọn). Cần giao tay.`, { task_id: view.id });
      return view;
    } catch (e) {
      if (e && e.status) { event('template_warn', 'alert', `Không tạo được task cho tuyến định kỳ “${tpl.name}” ngày ${date}: ${e.msg || e.code}`, {}); return null; }
      throw e;
    }
  }
  function generateDue(t) {
    const date = localDate(t, off), wd = weekday(date);
    for (const tpl of store.templates.find({ active: 1 })) {
      if (tpl.last_gen_date === date) continue;
      if (String(tpl.days).split(',').includes(String(wd))) generate(tpl, date, null);
      store.templates.update(tpl.id, { last_gen_date: date });
    }
  }
  R('GET', '/api/templates', OPS, () => ({ templates: store.templates.find({}, { order: 'name' }).map(tplView) }));
  R('POST', '/api/templates', OPS, ({ user, b }) => {
    const row = { ...templateInput(b, null), created_by: user.id, created_at: now(), last_gen_date: null };
    // Tạo tuyến sau giờ chạy của hôm nay thì hôm nay không tự sinh task (muốn chạy ngay: bấm "Tạo task hôm nay").
    if (atTime(today(), row.start_time, off) <= now()) row.last_gen_date = today();
    row.id = store.templates.insert(row);
    if (row.active) generateDue(now());
    return { template: tplView(store.templates.get(row.id)) };
  });
  R('PATCH', '/api/templates/:id', OPS, ({ p, b }) => {
    const cur = store.templates.get(idOf(p.id));
    if (!cur) fail(404, 'not_found', 'Không tìm thấy tuyến.');
    store.templates.update(cur.id, templateInput(b, cur));
    return { template: tplView(store.templates.get(cur.id)) };
  });
  R('DELETE', '/api/templates/:id', OPS, ({ p }) => {
    if (!store.templates.remove(idOf(p.id))) fail(404, 'not_found', 'Không tìm thấy tuyến.');
    return { ok: true };
  });
  R('POST', '/api/templates/:id/run', OPS, ({ user, p, b }) => {
    const tpl = store.templates.get(idOf(p.id));
    if (!tpl) fail(404, 'not_found', 'Không tìm thấy tuyến.');
    const date = b.date || today();
    if (!isDate(date)) fail(400, 'bad_date', 'Ngày không hợp lệ.');
    if (store.tasks.count({ template_id: tpl.id, date })) fail(409, 'already_generated', 'Tuyến này đã có task cho ngày đó rồi.');
    const view = generate(tpl, date, user);
    if (!view) fail(400, 'cannot_generate', 'Không tạo được task từ tuyến này. Kiểm tra danh sách điểm của tuyến.');
    return { task: view };
  });

  // ───────────────────────── Thống kê ─────────────────────────
  const blankRow = () => ({ km: 0, move_min: 0, tasks: 0, completed: 0, failed: 0, cancelled: 0, open: 0, ontime: 0, late: 0, stops_done: 0, stops_failed: 0, cards_out: 0, cards_in: 0, dev_out: 0, dev_in: 0, photos: 0, bo_confirmed: 0, bo_mismatch: 0, bo_pending: 0 });
  const SUM_KEYS = Object.keys(blankRow());
  function stats(from, to, foId) {
    for (const l of live.values()) K.flushDay(l);
    const where = { date: { gte: from, lte: to } };
    if (foId) where.fo_id = foId;
    const tasks = store.tasks.find(where);
    const byKey = new Map();
    const row = (fo, date) => { const k = `${fo}:${date}`; let r = byKey.get(k); if (!r) { r = { fo_id: fo, date, ...blankRow() }; byKey.set(k, r); } return r; };
    const dWhere = { date: { gte: from, lte: to } };
    if (foId) dWhere.user_id = foId;
    for (const d of store.daily.find(dWhere)) { const r = row(d.user_id, d.date); r.km += d.km || 0; r.move_min += Math.round((d.move_sec || 0) / 60); }
    const taskById = new Map();
    let unassigned = 0;
    for (const t of tasks) {
      if (!t.fo_id) { unassigned++; continue; }
      taskById.set(t.id, t);
      const r = row(t.fo_id, t.date);
      r.tasks++;
      if (t.status === 'completed') { r.completed++; if (t.late) r.late++; else r.ontime++; } else if (t.status === 'failed') r.failed++; else if (t.status === 'cancelled') r.cancelled++; else r.open++;
    }
    const ids = [...taskById.keys()];
    for (const part of chunk(ids, 400)) {
      for (const s of store.stops.find({ task_id: part })) {
        const t = taskById.get(s.task_id), r = row(t.fo_id, t.date);
        if (s.status === 'done') {
          r.stops_done++; r.cards_out += s.cards_out || 0; r.cards_in += s.cards_in || 0; r.dev_out += s.dev_out || 0; r.dev_in += s.dev_in || 0;
          if (s.bo_status === 'confirmed') r.bo_confirmed++; else if (s.bo_status === 'mismatch') r.bo_mismatch++; else if (s.bo_status === 'pending') r.bo_pending++;
        } else if (s.status === 'failed') r.stops_failed++;
      }
      for (const ph of store.photos.find({ task_id: part, by: 'fo' })) { const t = taskById.get(ph.task_id); row(t.fo_id, t.date).photos++; }
    }
    const days = [...byKey.values()].map((r) => ({ ...r, km: +r.km.toFixed(1) })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.fo_id - b.fo_id));
    const users = new Map(store.users.find({ role: 'fo' }).map((u) => [u.id, u]));
    const perFo = new Map();
    const totals = blankRow();
    for (const d of days) {
      let f = perFo.get(d.fo_id);
      if (!f) { const u = users.get(d.fo_id); f = { fo: { id: d.fo_id, name: u ? u.name : `FO #${d.fo_id}`, color: u ? u.color : null, active: !!(u && u.active) }, days: 0, ...blankRow() }; perFo.set(d.fo_id, f); }
      f.days++;
      for (const k of SUM_KEYS) { f[k] += d[k]; totals[k] += d[k]; }
    }
    const pct = (r) => (r.completed ? Math.round((r.ontime / r.completed) * 100) : null);
    const fos = [...perFo.values()].map((f) => ({ ...f, km: +f.km.toFixed(1), ontime_pct: pct(f) })).sort((a, b) => a.fo.name.localeCompare(b.fo.name));
    return { from, to, fos, days, totals: { ...totals, km: +totals.km.toFixed(1), ontime_pct: pct(totals), unassigned } };
  }
  /** Số liệu từng FO (điểm, đúng hạn, km) chỉ Logistic Lead và Quản trị xem; Logistics Executive dùng bảng điều phối. */
  const LEADS_FO = ['admin', 'lead'];
  function rangeOf(q) {
    const from = q.from || today(), to = q.to || from;
    if (!isDate(from) || !isDate(to) || to < from) fail(400, 'bad_range', 'Khoảng ngày không hợp lệ.');
    if (dayStart(to, off) - dayStart(from, off) > 92 * 86400000) fail(400, 'bad_range', 'Mỗi lần xem tối đa 93 ngày.');
    return { from, to, fo: q.fo ? idOf(q.fo) : null };
  }
  R('GET', '/api/stats', LEADS_FO, ({ q }) => { const r = rangeOf(q); return stats(r.from, r.to, r.fo); });
  R('GET', '/api/stats.csv', LEADS_FO, ({ q }) => {
    const r = rangeOf(q), s = stats(r.from, r.to, r.fo);
    const name = new Map(s.fos.map((f) => [f.fo.id, f.fo.name]));
    const head = ['Ngày', 'FO', 'Km thực tế', 'Phút di chuyển', 'Task', 'Hoàn thành', 'Đúng hạn', 'Trễ hạn', 'Thất bại', 'Huỷ', 'Điểm xong', 'Điểm không giao được', 'Thẻ giao', 'Thẻ thu', 'Thiết bị giao', 'Thiết bị thu', 'Ảnh FO chụp', 'BO xác nhận đủ', 'BO báo lệch', 'BO chưa xác nhận'];
    const lines = [head.map(csvCell).join(',')];
    for (const d of s.days) lines.push([d.date, name.get(d.fo_id) || d.fo_id, d.km, d.move_min, d.tasks, d.completed, d.ontime, d.late, d.failed, d.cancelled, d.stops_done, d.stops_failed, d.cards_out, d.cards_in, d.dev_out, d.dev_in, d.photos, d.bo_confirmed, d.bo_mismatch, d.bo_pending].map(csvCell).join(','));
    return { __csv: { name: `thong-ke-fo_${r.from}_${r.to}.csv`, text: '\ufeff' + lines.join('\r\n') + '\r\n' } };
  });
  /**
   * Hiệu chỉnh SLA theo lịch sử 30 ngày: thời gian dừng từng điểm (min50 / min85), hệ số thời gian đi, dự phòng (buffer: γ, tỉ lệ chuyến có đường thực tế xong trước hạn).
   * Tính lại tối đa 1 lần / giờ; ?refresh=1 để tính ngay.
   */
  R('GET', '/api/stats/sla', LEADS_FO, ({ q }) => ({ ...calibNow(now(), q.refresh === '1'), enabled: !!cfg.sla.calibrate, routing: !!K.deps.route }));

  // ───────────────────────── Cảnh báo ─────────────────────────
  R('GET', '/api/alerts', OPS, () => {
    const since = now() - 7 * 86400000;
    const rows = store.events.find({ ts: { gte: since }, level: ['warn', 'alert'] }, { order: 'ts', desc: true, limit: 300 });
    return { alerts: rows, open: rows.filter((e) => !e.ack_at).length };
  });
  R('POST', '/api/alerts/:id/ack', OPS, ({ user, p }) => {
    const ev = store.events.get(idOf(p.id));
    if (!ev || ev.level === 'info') fail(404, 'not_found', 'Không tìm thấy cảnh báo.');
    if (!ev.ack_at) store.events.update(ev.id, { ack_by: user.id, ack_at: now() });
    toOps({ t: 'alert_ack', ids: [ev.id] });
    return { ok: true };
  });
  R('POST', '/api/alerts/ack-all', OPS, ({ user }) => {
    const t = now(), ids = [];
    for (const ev of store.events.find({ ts: { gte: t - 7 * 86400000 }, level: ['warn', 'alert'], ack_at: null })) { store.events.update(ev.id, { ack_by: user.id, ack_at: t }); ids.push(ev.id); }
    toOps({ t: 'alert_ack', ids });
    return { ok: true, n: ids.length };
  });

  // ───────────────────────── Nhịp định kỳ ─────────────────────────
  hooks.tick = (t) => {
    generateDue(t);
    const running = new Set();
    for (const task of store.tasks.find({ status: OPEN_STATUS })) {
      const patch = {};
      const fo = task.fo_id ? store.users.get(task.fo_id) : null, who = fo ? `của ${fo.name}` : '(chưa có FO)';
      // Đang chạy và có đường đi: cập nhật dự kiến xong. Chưa chạy, sắp tới giờ đi (≤ 45 phút) mà đường đã tính quá 1 giờ: lấy lại theo giao thông gần giờ đi.
      if (task.status === 'in_progress') { running.add(task.id); if (task.route_at) etaCheck(task, t, patch, who); }
      else if (K.deps.route && task.start_at >= t && task.start_at - t <= 45 * 60000 && t - Math.max(task.route_at || 0, routeTried.get(task.id) || 0) > 3600000) queueRoute(task.id, 'tick');
      if (task.status !== 'in_progress' && !task.al_nostart && t > task.start_at + cfg.noStartMin * 60000) {
        patch.al_nostart = 1;
        event('task_not_started', 'alert', `Task ${task.code} ${who} đã quá giờ bắt đầu ${Math.round((t - task.start_at) / 60000)} phút mà chưa chạy.`, { task_id: task.id, fo_id: task.fo_id });
      }
      if (!task.al_late && t > task.due_at) {
        patch.al_late = 1; patch.al_risk = 1;
        event('sla_late', 'alert', `Task ${task.code} ${who} đã quá hạn (${hm(task.due_at)}).`, { task_id: task.id, fo_id: task.fo_id });
      } else if (!task.al_risk && t > task.due_at - cfg.riskMin * 60000 && t <= task.due_at) {
        patch.al_risk = 1;
        event('sla_risk', 'warn', `Task ${task.code} ${who} còn dưới ${cfg.riskMin} phút là tới hạn (${hm(task.due_at)}).`, { task_id: task.id, fo_id: task.fo_id });
      }
      if (Object.keys(patch).length) { store.tasks.update(task.id, patch); pushTask(task.id); }
    }
    for (const l of live.values()) {
      flushCur(l);
      if (l.cur && l.onShift && !l.lostAlerted && t - l.lastRecvAt > cfg.lostAlertSec * 1000) {
        l.lostAlerted = true;
        const fo = store.users.get(l.id), task = store.tasks.get(l.cur.taskId);
        if (fo && task) event('lost_signal', 'alert', `${fo.name} mất tín hiệu ${Math.round((t - l.lastRecvAt) / 60000)} phút khi đang làm task ${task.code}.`, { task_id: task.id, fo_id: fo.id });
      }
    }
    for (const s of store.stops.find({ bo_status: 'pending', bo_reminded: 0 })) {
      if (s.done_at && t - s.done_at > cfg.boRemindMin * 60000) {
        store.stops.update(s.id, { bo_reminded: 1 });
        const task = store.tasks.get(s.task_id), fo = task && task.fo_id ? store.users.get(task.fo_id) : null;
        const link = !s.bo_link_hash ? 'BO chưa có link' : s.bo_link_open_at ? 'BO đã mở link nhưng chưa xác nhận' : 'BO chưa mở link';
        event('bo_slow', 'alert', `${boLabel(s.name)} chưa xác nhận sau ${cfg.boRemindMin} phút (task ${task ? task.code : ''}); ${fo ? fo.name : 'FO'} đang phải chờ. ${link}.`, { task_id: s.task_id, stop_id: s.id, fo_id: task ? task.fo_id : null });
      }
    }
    // Đường đi: dọn bộ nhớ tạm; hiệu chỉnh SLA theo lịch sử tối đa 1 lần / giờ (chỉ khi có dịch vụ đường đi).
    for (const id of legMemo.keys()) if (!running.has(id)) legMemo.delete(id);
    for (const [id, ts] of routeTried) if (t - ts > 7200000) routeTried.delete(id);
    for (const [id, ts] of routeFailAt) if (t - ts >= 3600000) routeFailAt.delete(id);
    if (K.deps.route && cfg.sla.calibrate) { try { calibNow(t, false); } catch (e) { console.error('[sla]', (e && e.message) || e); } }
  };

  return { createTask, taskView, stats, generateDue, refreshCur, pushTask, cancelTask, dropStops, DAY_NAMES, planFromRoute, queueRoute, routeIdle, calibNow, pruneRoutes };
}
