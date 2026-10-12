// routing.js — đường đi thực tế theo đường phố cho task của FO; lõi gọi qua deps.route(points, { departAt }) → Promise<Route>.
// Chỉ chạy ở máy chủ (Node ≥ 22, có sẵn fetch), không đóng gói vào bản xem thử trên trình duyệt. Hai nhà cung cấp:
//  - Google Routes API v2 (computeRoutes): có giao thông trực tiếp và dự báo, tô màu đoạn chậm / kẹt; tính phí theo lần gọi.
//  - OSRM (tự dựng hoặc máy chủ tương thích OSRM): miễn phí, không có giao thông.
// Quyền riêng tư: chỉ gửi toạ độ các điểm giao nhận (địa điểm của doanh nghiệp), KHÔNG BAO GIỜ gửi vị trí GPS của FO.
// Khoá API chỉ nằm ở đây: không ghi ra log, không đưa vào thông báo lỗi, không bao giờ xuống trình duyệt.
// Có bộ nhớ đệm (tối đa 500 tuyến), giới hạn số lần gọi mỗi ngày, chờ tối đa timeoutMs mỗi lần gọi.
//
// Route = { provider, mode, traffic, depart_at, at, distance_m, duration_s, static_s, legs: [{ distance_m, duration_s, static_s, polyline, jams }], warnings }
//  - legs: đúng points.length − 1 chặng, chặng i = điểm i → điểm i + 1. polyline: "encoded polyline" precision 5 ('' nếu chặng dài 0).
//  - jams: [[từ điểm, tới điểm, mức]] theo chỉ số điểm trên polyline CỦA CHẶNG (vẽ path.slice(a, b + 1)); mức 1 = chậm, 2 = kẹt; đoạn bình thường bỏ qua.
// Lỗi: Promise bị từ chối với Error có .message tiếng Việt ngắn gọn (không chứa khoá) và .code (bad_points, too_many, limit, auth, quota,
// timeout, network, http, no_route, bad_response).
//
// Những điều đã kiểm theo tài liệu Google (10/2026):
//  - POST https://routes.googleapis.com/directions/v2:computeRoutes; khoá ở header X-Goog-Api-Key; bắt buộc X-Goog-FieldMask.
//  - routingPreference chỉ dùng được với DRIVE / TWO_WHEELER. TWO_WHEELER có hỗ trợ ở Việt Nam (danh sách coverage-two-wheeled),
//    đang beta và Google yêu cầu hiện cảnh báo cho người dùng → luôn thêm BETA_WARN vào warnings.
//  - TRAFFIC_ON_POLYLINE chỉ nhận DRIVE / TWO_WHEELER kèm TRAFFIC_AWARE hoặc TRAFFIC_AWARE_OPTIMAL → TRAFFIC_UNAWARE thì không xin.
//    Khoảng tốc độ ở cấp chặng (routes.legs.travelAdvisory.speedReadingIntervals) "phủ toàn bộ polyline của RouteLeg" → chỉ số tính
//    theo polyline của chặng. startPolylinePointIndex = 0 có thể bị bỏ (quy ước proto3) → thiếu thì hiểu là 0.
//  - departureTime: mặc định là lúc gửi yêu cầu; chỉ đặt cho yêu cầu có giao thông khi giờ đi ở tương lai (giờ đã qua → Google báo lỗi).
//  - Tối đa 25 điểm giữa (intermediates) → tối đa 27 điểm một lần gọi. Mỗi điểm dừng (không phải via) thêm đúng 1 chặng.
//  - polylineQuality mặc định là OVERVIEW (ít điểm, vẽ cắt góc phố) → xin HIGH_QUALITY để đường bám phố và chiếu vị trí FO lên đường
//    chính xác hơn (không đổi giá). Thời lượng dạng "123s" (có thể có phần lẻ "3.5s").
//  - Giá: TRAFFIC_AWARE(_OPTIMAL) = mức Pro; xe máy (TWO_WHEELER) và giao thông trên polyline = mức Enterprise (đắt nhất).
//  - Điều khoản (Service Specific Terms, mục Routes API): không dùng nội dung Routes API với bản đồ không phải của Google;
//    chỉ lưu tạm toạ độ tối đa 30 ngày liên tục.

const MIN = 60000, DAY = 86400000;
const GOOGLE_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const MODES = ['TWO_WHEELER', 'DRIVE'];
const PREFS = ['TRAFFIC_AWARE', 'TRAFFIC_AWARE_OPTIMAL', 'TRAFFIC_UNAWARE'];
const MAX_POINTS = 27; // Google: điểm đầu + tối đa 25 điểm giữa + điểm cuối (task tối đa 15 điểm + điểm quay về nên không chạm mức này)
const FIELDS = 'routes.distanceMeters,routes.duration,routes.staticDuration,routes.warnings,routes.legs.distanceMeters,routes.legs.duration,routes.legs.staticDuration,routes.legs.polyline.encodedPolyline';
const JAM = { SLOW: 1, TRAFFIC_JAM: 2 }; // NORMAL không ghi
const CACHE_MAX = 500;
const UA = 'atlas-ops-hub (routing)';
const BETA_WARN = 'Đường xe máy của Google đang thử nghiệm (beta): vài đoạn có thể chưa sát thực tế.';
const FALLBACK_WARN = 'Google chưa hỗ trợ đường xe máy cho các điểm này nên đã tính theo đường ô tô.';

const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(+v) ? null : +v);
const okCoord = (p) => p.lat !== null && p.lon !== null && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && !(p.lat === 0 && p.lon === 0);
/** "1234s" / "3.5s" (kiểu Duration của Google) → số giây làm tròn; thiếu hoặc sai → 0. */
const secs = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
const sum = (legs, k) => legs.reduce((s, l) => s + l[k], 0);
const zeroLeg = () => ({ distance_m: 0, duration_s: 0, static_s: 0, polyline: '', jams: [] });

// ───────── Polyline ("encoded polyline" của Google; OSRM geometries=polyline cũng dùng precision 5) ─────────
/** Chuỗi polyline → [[lat, lon], …]. Chuỗi rỗng / sai → []; phần dở dang ở cuối bị bỏ. */
export function decodePolyline(str, precision = 5) {
  const s = typeof str === 'string' ? str : '', f = 10 ** precision, out = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => { let r = 0, sh = 0, b; do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32 && i < s.length); return r & 1 ? ~(r >> 1) : r >> 1; };
  while (i < s.length) { lat += next(); if (i >= s.length) break; lon += next(); out.push([lat / f, lon / f]); }
  return out;
}
/** [[lat, lon], …] → chuỗi polyline (ngược với decodePolyline). */
export function encodePolyline(points, precision = 5) {
  const f = 10 ** precision;
  let out = '', pLat = 0, pLon = 0;
  const enc = (v) => { let x = v < 0 ? ~(v << 1) : v << 1, s = ''; while (x >= 32) { s += String.fromCharCode((32 | (x & 31)) + 63); x >>= 5; } return s + String.fromCharCode(x + 63); };
  for (const [a, b] of points || []) { const lat = Math.round(a * f), lon = Math.round(b * f); out += enc(lat - pLat) + enc(lon - pLon); pLat = lat; pLon = lon; }
  return out;
}
/** Nối nhiều polyline liền nhau (các bước của một chặng OSRM) thành một, bỏ điểm trùng ở chỗ nối. Ít hơn 2 điểm → ''. */
export function joinPolylines(list, precision = 5) {
  const pts = [];
  for (const s of list || []) for (const p of decodePolyline(s, precision)) { const q = pts[pts.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p); }
  return pts.length > 1 ? encodePolyline(pts, precision) : '';
}

/**
 * Tạo bộ tính đường cho deps.route. Trả về null khi tắt (provider 'none') hoặc cấu hình sai (đã ghi lý do qua log).
 * opt: { provider: 'google' | 'osrm' | 'none', key, mode ('TWO_WHEELER' | 'DRIVE'), pref ('TRAFFIC_AWARE' | 'TRAFFIC_AWARE_OPTIMAL' | 'TRAFFIC_UNAWARE'),
 *        trafficLines (true: xin tô màu kẹt xe), osrmUrl, osrmProfile ('driving'), timeoutMs (8000), dailyLimit (1500; 0 = không giới hạn),
 *        cacheTtlMs (10 phút, đi ngay), cacheTtlFutureMs (60 phút, giờ đi về sau hoặc tuyến không có giao thông),
 *        fetch (globalThis.fetch), now (Date.now), tzOffsetMin (420, để tính "ngày" của hạn mức), log (hàm nhận một dòng cảnh báo) }
 * → { route(points, { departAt }) → Promise<Route>, info(), stats() }
 */
export function createRouting(opt = {}) {
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  const provider = String(opt.provider || 'none').trim().toLowerCase();
  if (provider === 'none') return null;
  const off = (why) => { log(`${why} → tắt tính đường thực tế, SLA dùng ước tính đường chim bay.`); return null; };
  if (provider !== 'google' && provider !== 'osrm') return off('ROUTING_PROVIDER không hợp lệ (chỉ nhận google, osrm hoặc none)');
  const key = provider === 'google' ? String(opt.key || '').trim() : '';
  let mode, pref = null, base = null, host = null;
  if (provider === 'google') {
    if (!key) return off('ROUTING_PROVIDER=google nhưng chưa có GOOGLE_MAPS_API_KEY');
    if (!/^[\x21-\x7e]+$/.test(key)) return off('GOOGLE_MAPS_API_KEY có ký tự lạ (dấu cách, dấu ngoặc, xuống dòng?)');
    mode = String(opt.mode || 'TWO_WHEELER').trim().toUpperCase();
    pref = String(opt.pref || 'TRAFFIC_AWARE').trim().toUpperCase();
    if (!MODES.includes(mode)) return off('ROUTING_MODE không hợp lệ (chỉ nhận TWO_WHEELER hoặc DRIVE)');
    if (!PREFS.includes(pref)) return off('ROUTING_PREF không hợp lệ (chỉ nhận TRAFFIC_AWARE, TRAFFIC_AWARE_OPTIMAL hoặc TRAFFIC_UNAWARE)');
  } else {
    let u = null;
    try { u = new URL(String(opt.osrmUrl || '').trim()); } catch { /* sai định dạng */ }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return off('ROUTING_PROVIDER=osrm nhưng OSRM_URL trống hoặc sai (ví dụ http://osrm:5000)');
    base = (u.origin + u.pathname).replace(/\/+$/, '');
    host = u.host;
    mode = String(opt.osrmProfile || 'driving').trim();
    if (!/^[\w-]{1,40}$/.test(mode)) return off('OSRM_PROFILE không hợp lệ (ví dụ driving)');
  }
  const traffic = provider === 'google' && pref !== 'TRAFFIC_UNAWARE'; // thời lượng đã gồm giao thông trực tiếp / dự báo
  const lines = traffic && opt.trafficLines !== false;
  const timeoutMs = Number.isFinite(opt.timeoutMs) && opt.timeoutMs >= 1 ? Math.min(600000, Math.floor(opt.timeoutMs)) : 8000; // AbortSignal.timeout chỉ nhận số nguyên
  const limit = Number.isFinite(opt.dailyLimit) && opt.dailyLimit >= 0 ? Math.floor(opt.dailyLimit) : 1500;
  const ttlNow = Number.isFinite(opt.cacheTtlMs) ? opt.cacheTtlMs : 10 * MIN, ttlLater = Number.isFinite(opt.cacheTtlFutureMs) ? opt.cacheTtlFutureMs : 60 * MIN;
  const doFetch = opt.fetch || globalThis.fetch, now = opt.now || Date.now, tz = Number.isFinite(opt.tzOffsetMin) ? opt.tzOffsetMin : 420;
  const NAME = provider === 'google' ? 'Google' : 'Máy chủ OSRM';

  const cache = new Map(), inflight = new Map(), said = new Map();
  let day = null, calls = 0, hits = 0, errs = 0, lastErr = null, pause = null, limitSaid = false, modeSaid = false;
  const roll = (t) => { const d = Math.floor((t + tz * MIN) / DAY); if (d !== day) { day = d; calls = 0; hits = 0; errs = 0; limitSaid = false; } };
  const hide = (s) => (key ? String(s).split(key).join('***') : String(s)); // phòng xa: không bao giờ để lộ khoá ra log
  /** Ghi cảnh báo; cùng một nội dung tối đa 10 phút một lần (lỗi lặp lại không dội log). */
  const warn = (m) => {
    m = hide(m);
    const t = now();
    if (t - (said.get(m) ?? -Infinity) < 10 * MIN) return;
    if (said.size > 200) said.clear();
    said.set(m, t);
    log(m);
  };
  const err = (code, message, status) => Object.assign(new Error(message), { code }, status ? { status } : {});
  /** Lỗi khoá / hết hạn mức của nhà cung cấp: tạm ngừng gọi một lúc, trong lúc đó trả lỗi ngay (không gọi dồn dập). */
  const hold = (ms, e) => { pause = { until: now() + ms, code: e.code, message: e.message, status: e.status }; return e; };
  const detail = (j) => String((j && j.error && (j.error.message || j.error.status)) || (j && (j.message || j.code)) || '').slice(0, 300);

  /** Một lần gọi HTTP: kiểm và trừ hạn mức ngày, chờ tối đa timeoutMs. → { status, j } (j: JSON đã đọc hoặc null). */
  async function call(url, init) {
    if (limit && calls >= limit) {
      if (!limitSaid) { limitSaid = true; log(`Đã chạm hạn mức ${limit} lần gọi hôm nay (ROUTING_DAILY_LIMIT): tới hết ngày, task mới dùng SLA ước tính đường chim bay.`); }
      throw err('limit', 'Đã dùng hết hạn mức gọi tuyến đường trong ngày (ROUTING_DAILY_LIMIT)');
    }
    calls++;
    let r, text;
    try {
      r = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      text = await r.text();
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        warn(`${NAME} không trả lời trong ${timeoutMs} ms (ROUTING_TIMEOUT_MS).`);
        throw err('timeout', provider === 'google' ? 'Google không trả lời kịp' : 'Máy chủ OSRM không trả lời kịp');
      }
      warn(`Không gọi được ${NAME}: ${(e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || e}`);
      throw err('network', provider === 'google' ? 'Không kết nối được tới Google Maps' : 'Không kết nối được máy chủ OSRM');
    }
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* không phải JSON */ }
    return { status: r.status, j };
  }

  // ───────── Google Routes API v2 ─────────
  const wp = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lon } } });
  const jamsOf = (ivs) => {
    const out = [];
    for (const v of Array.isArray(ivs) ? ivs : []) {
      const lv = JAM[v && v.speed], a = Math.round(+(v && v.startPolylinePointIndex) || 0), b = Math.round(+(v && v.endPolylinePointIndex) || 0); // thiếu chỉ số = 0 (proto3)
      if (lv && a >= 0 && b > a) out.push([a, b, lv]);
    }
    return out;
  };
  function googleErr(res) {
    const s = res.status;
    warn(`Google trả HTTP ${s}: ${detail(res.j) || 'không rõ lý do'}`);
    if (s === 401 || s === 403) return hold(5 * MIN, err('auth', 'Khoá Google Maps không hợp lệ hoặc chưa bật Routes API', s));
    if (s === 429) return hold(MIN, err('quota', 'Vượt hạn mức gọi Google', s));
    if (s >= 500) return err('http', `Google Maps đang trục trặc (HTTP ${s}), thử lại sau`, s);
    return err('http', `Google không tính được đường cho các điểm này (HTTP ${s})`, s);
  }
  async function google(pts, dep) {
    const headers = { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': lines ? FIELDS + ',routes.legs.travelAdvisory.speedReadingIntervals' : FIELDS };
    const ask = (m) => call(GOOGLE_URL, { method: 'POST', headers, body: JSON.stringify({
      origin: wp(pts[0]), destination: wp(pts[pts.length - 1]), ...(pts.length > 2 ? { intermediates: pts.slice(1, -1).map(wp) } : {}),
      travelMode: m, routingPreference: pref, ...(traffic && dep ? { departureTime: new Date(dep).toISOString() } : {}),
      ...(lines ? { extraComputations: ['TRAFFIC_ON_POLYLINE'] } : {}),
      polylineQuality: 'HIGH_QUALITY', polylineEncoding: 'ENCODED_POLYLINE', computeAlternativeRoutes: false, languageCode: 'vi', regionCode: 'VN', units: 'METRIC',
    }) });
    let m = mode, res = await ask(m);
    // Khu vực chưa có đường xe máy: Google trả 400 nhắc tới travel mode → tính lại MỘT lần bằng ô tô.
    if (res.status === 400 && m !== 'DRIVE' && /travel.?mode|two.?wheel/i.test(JSON.stringify(res.j || ''))) {
      if (!modeSaid) { modeSaid = true; log(`Google chưa hỗ trợ ${m} cho tuyến vừa tính (${hide(detail(res.j)) || 'HTTP 400'}): tính lại bằng DRIVE (ô tô). Tuyến nào gặp lỗi này cũng sẽ được tính lại như vậy.`); }
      m = 'DRIVE';
      res = await ask(m);
    }
    if (res.status < 200 || res.status > 299) throw googleErr(res);
    const r = res.j && Array.isArray(res.j.routes) ? res.j.routes[0] : null; // không tìm được đường: Google trả {} (HTTP 200)
    if (!r) throw err('no_route', 'Google không tìm được đường đi qua các điểm này');
    const legs = Array.isArray(r.legs) ? r.legs : [];
    if (legs.length !== pts.length - 1) { warn(`Google trả ${legs.length} chặng cho ${pts.length} điểm.`); throw err('bad_response', 'Google trả về số chặng không khớp số điểm'); }
    const warnings = (Array.isArray(r.warnings) ? r.warnings.filter((w) => typeof w === 'string' && w) : []).concat(m !== mode ? [FALLBACK_WARN] : m === 'TWO_WHEELER' ? [BETA_WARN] : []);
    return {
      mode: m, warnings,
      legs: legs.map((l) => ({
        distance_m: Math.max(0, Math.round(+l.distanceMeters || 0)), duration_s: secs(l.duration), static_s: l.staticDuration == null ? null : secs(l.staticDuration),
        polyline: (l.polyline && typeof l.polyline.encodedPolyline === 'string' && l.polyline.encodedPolyline) || '',
        jams: lines ? jamsOf(l.travelAdvisory && l.travelAdvisory.speedReadingIntervals) : [],
      })),
    };
  }

  // ───────── OSRM ─────────
  function osrmErr(res) {
    const s = res.status, c = (res.j && typeof res.j.code === 'string' && res.j.code) || '';
    warn(`OSRM trả HTTP ${s}${c ? ' ' + c : ''}: ${(res.j && res.j.message) || 'không rõ lý do'}`);
    if (c === 'NoRoute') return err('no_route', 'OSRM không tìm được đường đi qua các điểm này', s);
    if (c === 'NoSegment') return err('no_route', 'OSRM không tìm thấy đường phố gần một điểm (toạ độ nằm xa đường?)', s);
    if (c === 'TooBig') return err('too_many', 'Quá nhiều điểm cho máy chủ OSRM', s);
    if (s === 429) return hold(MIN, err('quota', 'Máy chủ OSRM từ chối vì gọi quá dày (HTTP 429)', s));
    return err('http', `Máy chủ OSRM báo lỗi (HTTP ${s}${c ? ', ' + c : ''})`, s);
  }
  async function osrm(pts) {
    // Toạ độ theo thứ tự kinh độ,vĩ độ. overview=false: không lấy hình cả tuyến, tự nối hình học các bước (steps) thành từng chặng.
    const url = `${base}/route/v1/${mode}/${pts.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';')}?overview=false&steps=true&geometries=polyline&annotations=false`;
    const res = await call(url, { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': UA } });
    if (res.status !== 200 || !res.j || res.j.code !== 'Ok') throw osrmErr(res);
    const r = Array.isArray(res.j.routes) ? res.j.routes[0] : null;
    if (!r) throw err('no_route', 'OSRM không tìm được đường đi qua các điểm này');
    const legs = Array.isArray(r.legs) ? r.legs : [];
    if (legs.length !== pts.length - 1) { warn(`OSRM trả ${legs.length} chặng cho ${pts.length} điểm.`); throw err('bad_response', 'Máy chủ OSRM trả về số chặng không khớp số điểm'); }
    return {
      mode, warnings: [],
      legs: legs.map((l) => {
        const d = Math.max(0, Math.round(+l.duration || 0));
        return { distance_m: Math.max(0, Math.round(+l.distance || 0)), duration_s: d, static_s: d, polyline: joinPolylines((Array.isArray(l.steps) ? l.steps : []).map((s) => s && s.geometry)), jams: [] };
      }),
    };
  }

  const pack = (m, legs, warnings, dep) => ({
    provider, mode: m, traffic, depart_at: dep, at: now(),
    distance_m: sum(legs, 'distance_m'), duration_s: sum(legs, 'duration_s'), static_s: legs.every((l) => l.static_s !== null) ? sum(legs, 'static_s') : null,
    legs, warnings: [...new Set(warnings)],
  });
  /** Bản sao cho người gọi (sửa kết quả không làm hỏng bộ nhớ đệm). Tuyến không phụ thuộc giờ đi: ghi lại giờ đi của lần hỏi này. */
  const reuse = (r, dep) => { const c = structuredClone(r); if (!traffic) c.depart_at = dep; return c; };

  /** points: [{ lat, lon }] theo thứ tự đi (≥ 2). opts.departAt: giờ đi (ms); trống hoặc trong vòng 60 giây tới = đi ngay. */
  async function route(points, opts) {
    const t = now();
    roll(t);
    try {
      const pts = Array.isArray(points) ? points.map((p) => ({ lat: num(p && p.lat), lon: num(p && p.lon) })) : [];
      if (pts.length < 2 || !pts.every(okCoord)) throw err('bad_points', 'Cần ít nhất 2 điểm có toạ độ hợp lệ để tính đường');
      const dep = num(opts && opts.departAt), later = dep !== null && dep > t + MIN, depAt = later ? dep : t;
      // Hai điểm liền nhau trùng chỗ (vd hai điểm cùng một BO): không gửi chặng dài 0 cho nhà cung cấp, tự điền chặng rỗng.
      const keys = pts.map((p) => p.lat.toFixed(5) + ',' + p.lon.toFixed(5)), uniq = [], at = [];
      pts.forEach((p, i) => { if (!i || keys[i] !== keys[i - 1]) uniq.push(p); at.push(uniq.length - 1); });
      if (uniq.length < 2) return pack(mode, pts.slice(1).map(zeroLeg), [], depAt);
      if (provider === 'google' && uniq.length > MAX_POINTS) throw err('too_many', `Quá nhiều điểm cho một lần tính đường (tối đa ${MAX_POINTS})`);
      // Khoá bộ nhớ đệm: giờ đi gom theo khung 5 phút (đi ngay) hoặc 15 phút (đi sau); tuyến không có giao thông thì không phụ thuộc giờ đi.
      const ck = [provider, mode, pref || '', keys.join(';'), !traffic ? 's' : later ? 'f' + Math.floor(dep / (15 * MIN)) : 'n' + Math.floor(t / (5 * MIN))].join('|');
      const hit = cache.get(ck);
      if (hit && hit.exp > t) { cache.delete(ck); cache.set(ck, hit); hits++; return reuse(hit.route, depAt); } // lần dùng gần nhất xếp cuối (LRU)
      if (hit) cache.delete(ck);
      if (inflight.has(ck)) { const r = await inflight.get(ck); hits++; return reuse(r, depAt); } // cùng tuyến đang được tính: chờ chung, không gọi trùng
      const job = (async () => {
        if (pause && now() < pause.until) throw err(pause.code, pause.message, pause.status);
        const out = provider === 'google' ? await google(uniq, later ? dep : null) : await osrm(uniq);
        return pack(out.mode, pts.slice(1).map((_, i) => (at[i + 1] === at[i] ? zeroLeg() : out.legs[at[i]])), out.warnings, depAt);
      })();
      inflight.set(ck, job);
      try {
        const r = await job;
        cache.set(ck, { exp: now() + (later || !traffic ? ttlLater : ttlNow), route: r });
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        return structuredClone(r);
      } finally { inflight.delete(ck); }
    } catch (e) {
      errs++;
      lastErr = { at: t, message: e.message };
      throw e;
    }
  }

  const label = provider === 'google'
    ? `Google Routes API — ${mode === 'TWO_WHEELER' ? 'xe máy' : 'ô tô'} (${mode}), ${traffic ? `có giao thông (${pref})${lines ? ', tô màu đoạn kẹt xe' : ''}` : 'không tính giao thông (TRAFFIC_UNAWARE)'}`
    : `OSRM tại ${host} (${mode}), không có dữ liệu giao thông${/(^|\.)project-osrm\.org(:\d+)?$/.test(host) ? ' — máy chủ thử công cộng, chỉ dùng để thử' : ''}`;
  return {
    route,
    /** Mô tả cấu hình (không có khoá) cho dòng log lúc khởi động. */
    info: () => ({ provider, mode, pref, traffic, trafficLines: lines, limit, timeoutMs, host, text: `${label}; ${limit ? `tối đa ${limit} lần gọi/ngày` : 'không giới hạn số lần gọi'}, chờ tối đa ${String(timeoutMs / 1000).replace('.', ',')} giây` }),
    /** Số liệu trong ngày (theo giờ địa phương) cho /healthz. */
    stats() { roll(now()); return { provider, mode, calls_today: calls, cache_hits_today: hits, errors_today: errs, limit, last_error: lastErr && { ...lastErr } }; },
  };
}
