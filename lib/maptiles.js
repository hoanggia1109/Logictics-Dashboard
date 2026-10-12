// maptiles.js — nền bản đồ Google chính thức (Map Tiles API, ô bản đồ 2D) cho mọi bản đồ của ứng dụng: Logistic, app FO, link BO.
// Chỉ chạy ở máy chủ (Node ≥ 22, có sẵn fetch), không đóng gói vào bản xem thử trên trình duyệt. Máy chủ tạo "phiên" (session) cho lớp
// đường phố và lớp vệ tinh, đưa mẫu địa chỉ ô bản đồ vào cfg.mapTiles; trình duyệt tự tải ô từ tile.googleapis.com.
// Khoá GOOGLE_MAPS_TILES_KEY là khoá TRÌNH DUYỆT (nằm ngay trong địa chỉ ô bản đồ): phải giới hạn theo trang web (HTTP referrer) = tên miền
// của PUBLIC_URL và chỉ bật Map Tiles API. Máy chủ tự gọi Google thì gửi kèm Referer: <gốc PUBLIC_URL>/ — đúng như trình duyệt gửi khi tải ô
// (referrerPolicy strict-origin-when-cross-origin) — để qua được giới hạn đó. Dù vậy khoá không bao giờ ra log hay thông báo lỗi (che bằng ***).
//
// Những điều đã kiểm theo tài liệu Google (10/2026):
//  - POST https://tile.googleapis.com/v1/createSession?key=KHOÁ, JSON { mapType, language, region[, layerTypes] }
//    → { session, expiry (số giây kể từ 1970, dạng chuỗi), tileWidth, tileHeight, imageFormat }. Phiên dùng được khoảng 2 tuần (Google có thể đổi).
//  - Vệ tinh kèm tên đường (như kiểu "hybrid" của Maps JavaScript API): mapType 'satellite' + layerTypes ['layerRoadmap'].
//  - language 'vi-VN': nhãn tiếng Việt; region 'VN': biên giới, hải đảo vẽ theo góc nhìn Việt Nam.
//  - Ô bản đồ: https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=PHIÊN&key=KHOÁ, zoom 0–22.
//  - Bản quyền theo khung nhìn: GET https://tile.googleapis.com/tile/v1/viewport?session=&key=&zoom=&north=&south=&east=&west= (bắt buộc đủ)
//    → { copyright, maxZoomRects }. Google bắt buộc hiện chuỗi copyright (kèm logo Google Maps) trên bản đồ; chuỗi đổi theo khung nhìn.
//    north/south trong (−90, 90), east/west trong (−180, 180); khung vắt qua kinh tuyến 180 thì west > east.
//  - Lỗi: JSON { error: { code, message, status } }; khoá sai / chưa bật API / sai tên miền → 400 "API key not valid" hoặc 403; hết hạn mức → 429.
//  - Tạo phiên và hỏi khung nhìn không tính vào hạn mức ngày (mặc định 15.000 ô/ngày, 6.000 yêu cầu/phút mỗi dự án).
//  - fetch của Node (undici) không lọc các header "cấm" như trình duyệt → Referer tự đặt được gửi đi thật (đã thử với máy chủ dội lại).

const MIN = 60000, H = 3600000, DAY = 86400000;
const BASE = 'https://tile.googleapis.com';
const LAYERS = ['roadmap', 'satellite'];
const NAME = { roadmap: 'đường phố', satellite: 'vệ tinh' };
const REFRESH = DAY; // làm mới phiên mỗi 24 giờ (phiên cũ vẫn dùng tới khi hết hạn)
const RETRY = [1, 2, 4, 8, 16, 30]; // lỗi liên tiếp lần 1, 2, 3…: chờ ngần này phút rồi thử lại (tối đa 30)
const ATTR_TTL = 30 * MIN, ATTR_FAIL_TTL = MIN, ATTR_MAX = 500, VIEW_MS = 5000; // dòng bản quyền: nhớ 30 phút (lỗi: 1 phút), tối đa 500 khung
const LAT_MAX = 85.0511; // vĩ độ xa nhất của bản đồ Mercator

/** Thời lượng dễ đọc cho log: "13 ngày", "5 giờ", "20 phút". */
const dur = (ms) => (ms >= 2 * DAY ? `${Math.floor(ms / DAY)} ngày` : ms >= 2 * H ? `${Math.floor(ms / H)} giờ` : `${Math.max(1, Math.round(ms / MIN))} phút`);

/**
 * Khung nhìn làm tròn RA NGOÀI theo lưới ô bản đồ của mức zoom (1 ô = 360/2^z độ; từ zoom 16 trở lên giữ lưới của zoom 16):
 * kéo bản đồ một chút vẫn trúng bộ nhớ đệm, còn khung hỏi Google luôn phủ hết phần đang xem. → [north, south, east, west]
 */
export function roundBox(z, n, s, e, w) {
  const g = 360 / 2 ** Math.min(z, 16), lo = (v) => Math.floor(v / g) * g, hi = (v) => Math.ceil(v / g) * g;
  let E = Math.min(180, hi(e)), W = Math.max(-180, lo(w));
  if (w > e && W <= E) { E = 180; W = -180; } // vắt qua kinh tuyến 180 mà làm tròn xong phủ cả vòng → cả thế giới
  return [Math.min(LAT_MAX, hi(n)), Math.max(-LAT_MAX, lo(s)), E, W];
}

/**
 * Tạo bộ quản lý nền bản đồ Google chính thức. Trả về null khi chưa đặt khoá, hoặc cấu hình sai (đã ghi lý do qua log).
 * opt: { key (GOOGLE_MAPS_TILES_KEY), referer (PUBLIC_URL), language ('vi-VN'), region ('VN'), timeoutMs (8000, chờ tạo phiên),
 *        fetch (globalThis.fetch), now (Date.now), log (hàm nhận một dòng log), onChange (nhận cfg() sau mỗi lần tạo / làm mới phiên),
 *        setTimer / clearTimer (setTimeout / clearTimeout; bài kiểm thử thay bằng hẹn giờ giả) }
 * → { start() → Promise (xong lần tạo phiên đầu, không bao giờ lỗi), stop(), cfg(), attribution({ layer, z, n, s, e, w }) → Promise<string>, status() }
 */
export function createMapTiles(opt = {}) {
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  const key = String(opt.key || '').trim();
  if (!key) return null;
  const off = (why) => { log(`${why} → tắt nền bản đồ Google chính thức, bản đồ dùng nền cũ (TILE_URL).`); return null; };
  if (!/^[\x21-\x7e]+$/.test(key)) return off('GOOGLE_MAPS_TILES_KEY có ký tự lạ (dấu cách, dấu ngoặc, xuống dòng?)');
  let u = null;
  try { u = new URL(String(opt.referer || '').trim()); } catch { /* trống hoặc sai định dạng */ }
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return off('Có GOOGLE_MAPS_TILES_KEY nhưng PUBLIC_URL trống hoặc sai (ví dụ https://fo.example.com): khoá giới hạn theo trang web cần địa chỉ này');
  const referer = u.origin + '/'; // giống hệt trình duyệt gửi khi tải ô bản đồ (chỉ gốc trang)
  const language = String(opt.language || 'vi-VN'), region = String(opt.region || 'VN');
  const timeoutMs = Number.isFinite(opt.timeoutMs) && opt.timeoutMs >= 1 ? Math.min(60000, Math.floor(opt.timeoutMs)) : 8000; // AbortSignal.timeout chỉ nhận số nguyên
  const doFetch = opt.fetch || globalThis.fetch, now = opt.now || Date.now, onChange = typeof opt.onChange === 'function' ? opt.onChange : () => {};
  const setTimer = opt.setTimer || ((fn, ms) => { const h = setTimeout(fn, ms); if (h.unref) h.unref(); return h; }), clearTimer = opt.clearTimer || clearTimeout;
  const K = encodeURIComponent(key);
  const hide = (s) => String(s).split(key).join('***').split(K).join('***'); // Google hay nhắc lại khoá trong câu báo lỗi
  const say = (m) => log(hide(m));
  const said = new Map();
  /** Cảnh báo lặp lại (lỗi hỏi dòng bản quyền): cùng một nội dung tối đa 10 phút một lần. */
  const warn = (m) => { m = hide(m); const t = now(); if (t - (said.get(m) ?? -Infinity) < 10 * MIN) return; if (said.size > 100) said.clear(); said.set(m, t); log(m); };
  const err = (code, message, status, detail) => Object.assign(new Error(message), { code }, status ? { status } : {}, detail ? { detail: hide(detail).slice(0, 300) } : {});

  /** Một lần gọi Google (kèm Referer cho khoá giới hạn theo trang web), chờ tối đa ms. → { status, j } (j: JSON đã đọc hoặc null). */
  async function call(url, init, ms) {
    let r, text;
    try {
      r = await doFetch(url, { ...init, headers: { ...init.headers, Referer: referer }, signal: AbortSignal.timeout(ms) });
      text = await r.text();
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw err('timeout', 'Google không trả lời kịp', null, `quá ${ms} ms`);
      throw err('network', 'Không kết nối được tới Google Maps', null, String((e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || e));
    }
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* không phải JSON */ }
    return { status: r.status, j };
  }
  function httpErr(res) {
    const s = res.status, d = String((res.j && res.j.error && (res.j.error.message || res.j.error.status)) || `HTTP ${s}`);
    if (s === 401 || s === 403 || (s === 400 && /api.?key/i.test(d))) return err('auth', `Khoá GOOGLE_MAPS_TILES_KEY bị từ chối (HTTP ${s}): khoá sai, chưa bật Map Tiles API hoặc chưa cho phép tên miền của PUBLIC_URL`, s, d);
    if (s === 429) return err('quota', 'Vượt hạn mức Map Tiles API (HTTP 429)', s, d);
    if (s >= 500) return err('http', `Google Maps đang trục trặc (HTTP ${s})`, s, d);
    return err('http', `Google từ chối yêu cầu (HTTP ${s})`, s, d);
  }

  // ───────── Phiên (session) của từng lớp ─────────
  const ses = { roadmap: null, satellite: null }; // { session, at, exp }: mã phiên, lúc tạo, lúc hết hạn (ms)
  let running = false, first = null, timer = null, nextAt = null, fails = 0, lastErr = null, okSaid = false;
  /** Phiên còn dùng được (trừ hao 1 phút trước lúc hết hạn) hoặc null. */
  const live = (n, t = now()) => (ses[n] && ses[n].exp - t > MIN ? ses[n] : null);
  /** Lúc cần làm mới: sau 24 giờ; Google rút thời hạn phiên xuống dưới 2 ngày thì làm mới khi đã dùng nửa thời hạn. */
  const dueOf = (s) => s.at + Math.min(REFRESH, (s.exp - s.at) / 2);
  async function create(n) {
    const body = { mapType: n, language, region, ...(n === 'satellite' ? { layerTypes: ['layerRoadmap'] } : {}) }; // vệ tinh kèm tên đường
    const res = await call(`${BASE}/v1/createSession?key=${K}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs);
    if (res.status < 200 || res.status > 299) throw httpErr(res);
    const j = res.j || {}, t = now(), exp = Number(j.expiry) * 1000; // expiry: số giây, dạng chuỗi
    if (typeof j.session !== 'string' || !/^[\x21-\x7e]{8,2000}$/.test(j.session)) throw err('bad_response', 'Google trả về phiên bản đồ không đọc được');
    return { session: j.session, at: t, exp: exp > t ? exp : t + REFRESH }; // thiếu thời hạn: coi như dùng được 24 giờ
  }
  const schedule = (ms) => { if (!running) return; nextAt = now() + ms; timer = setTimer(() => cycle().catch(() => {}), ms); };
  /** Tạo / làm mới phiên các lớp đã tới hạn; xong thì hẹn lần sau (24 giờ, lỗi thì 1 → 30 phút) và báo cfg() mới cho máy chủ. */
  async function cycle() {
    timer = null;
    const t0 = now(), bad = [];
    await Promise.all(LAYERS.filter((n) => !ses[n] || t0 >= dueOf(ses[n])).map(async (n) => { try { ses[n] = await create(n); } catch (e) { bad.push([n, e]); } }));
    const t = now(), road = live('roadmap', t), sat = live('satellite', t);
    if (bad.length) {
      const e = bad[0][1];
      fails++;
      lastErr = { at: t, message: e.message };
      let wait = RETRY[Math.min(fails, RETRY.length) - 1] * MIN;
      if (road) wait = Math.min(wait, Math.max(MIN, road.exp - MIN - t)); // phiên cũ sắp hết hạn: thử lại đúng lúc đó, hỏng tiếp thì gỡ nền khỏi cấu hình
      const keep = !road ? 'bản đồ dùng nền cũ (TILE_URL)' : bad.some(([n]) => n === 'roadmap') ? `vẫn dùng phiên cũ (còn hạn ${dur(road.exp - t)})` : sat ? `lớp vệ tinh dùng phiên cũ (còn hạn ${dur(sat.exp - t)})` : 'tạm ẩn lớp vệ tinh';
      say(`Không tạo được phiên bản đồ Google (${bad.map(([n]) => NAME[n]).join(', ')}): ${e.message}${e.detail ? ` — ${e.detail}` : ''}. Thử lại sau ${dur(wait)}; trong lúc đó ${keep}.`);
      schedule(wait);
    } else {
      if (!okSaid || fails) say(`Nền bản đồ Google chính thức (Map Tiles API): đã ${fails ? `tạo lại phiên sau ${fails} lần lỗi` : 'tạo phiên'} (${LAYERS.map((n) => NAME[n]).join(' + ')}${road ? `, còn hạn ${dur(road.exp - t)}` : ''}); tự làm mới mỗi 24 giờ.`);
      okSaid = true; fails = 0;
      schedule(Math.max(MIN, Math.min(...LAYERS.map((n) => dueOf(ses[n]))) - t));
    }
    try { onChange(cfg()); } catch { /* bên nhận lỗi thì bỏ qua */ }
  }
  const tpl = (s) => `${BASE}/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(s.session)}&key=${K}`;
  /** Cấu hình cho trình duyệt (core.cfg.mapTiles); null khi chưa có phiên đường phố còn hạn (trình duyệt dùng nền cũ). */
  function cfg() {
    const t = now(), r = live('roadmap', t), s = live('satellite', t);
    return r ? { provider: 'google', roadmap: tpl(r), satellite: s ? tpl(s) : null, maxZoom: 22, attribution: 'map-attribution' } : null;
  }

  // ───────── Dòng bản quyền theo khung nhìn (Google bắt buộc hiện trên bản đồ) ─────────
  const cache = new Map(), pending = new Map(); // khoá: lớp|zoom|khung đã làm tròn → { exp, copyright }
  let calls = 0, hits = 0, errs = 0;
  /** q: { layer: 'roadmap' | 'satellite', z: số nguyên 0–22, n, s, e, w: độ } → chuỗi bản quyền; tham số sai, chưa có phiên hoặc Google lỗi → ''. */
  async function attribution(q) {
    const { layer, z, n, s, e, w } = q || {};
    if (!LAYERS.includes(layer) || !Number.isInteger(z) || z < 0 || z > 22 || ![n, s, e, w].every(Number.isFinite) || Math.abs(n) > 90 || Math.abs(s) > 90 || Math.abs(e) > 180 || Math.abs(w) > 180 || n <= s) return '';
    const t = now(), sx = live(layer, t);
    if (!sx) return '';
    const box = roundBox(z, n, s, e, w), ck = `${layer}|${z}|${box.join(',')}`, hit = cache.get(ck);
    if (hit && hit.exp > t) { cache.delete(ck); cache.set(ck, hit); hits++; return hit.copyright; } // lần dùng gần nhất xếp cuối (LRU)
    if (hit) cache.delete(ck);
    if (pending.has(ck)) { hits++; return pending.get(ck); } // cùng khung đang hỏi: chờ chung, không hỏi trùng
    const job = (async () => {
      calls++;
      let c = null;
      try {
        const [N, S, E, W] = box;
        const res = await call(`${BASE}/tile/v1/viewport?session=${encodeURIComponent(sx.session)}&key=${K}&zoom=${z}&north=${N}&south=${S}&east=${E}&west=${W}`, { method: 'GET' }, VIEW_MS);
        if (res.status < 200 || res.status > 299) throw httpErr(res);
        if (!res.j || typeof res.j !== 'object') throw err('bad_response', 'Google trả về dòng bản quyền không đọc được');
        c = typeof res.j.copyright === 'string' ? res.j.copyright.trim().slice(0, 1000) : '';
      } catch (x) { errs++; warn(`Không lấy được dòng bản quyền bản đồ Google: ${x.message}${x.detail ? ` — ${x.detail}` : ''}.`); }
      cache.set(ck, { exp: now() + (c === null ? ATTR_FAIL_TTL : ATTR_TTL), copyright: c || '' }); // lỗi: nhớ 1 phút cho khỏi hỏi dồn
      while (cache.size > ATTR_MAX) cache.delete(cache.keys().next().value);
      return c || '';
    })();
    pending.set(ck, job);
    try { return await job; } finally { pending.delete(ck); }
  }

  return {
    /** Tạo phiên lần đầu rồi tự làm mới; gọi lại khi đang chạy thì trả về đúng lần đầu đó. */
    start() { if (!running) { running = true; first = cycle(); } return first; },
    stop() { running = false; nextAt = null; if (timer !== null) { clearTimer(timer); timer = null; } },
    cfg, attribution,
    /** Tình trạng cho /healthz (không có khoá, không có mã phiên). */
    status() {
      const t = now(), lay = (n) => (ses[n] ? { ok: !!live(n, t), at: ses[n].at, expiry: ses[n].exp } : null);
      return { provider: 'google', on: !!live('roadmap', t), referer, roadmap: lay('roadmap'), satellite: lay('satellite'), next_at: nextAt, fails, last_error: lastErr && { ...lastErr }, attribution: { calls, cache_hits: hits, errors: errs, cached: cache.size } };
    },
  };
}
