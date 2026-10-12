// routing.test.mjs — lib/routing.js (đường đi thực tế cho deps.route) với fetch giả, không gọi mạng thật: yêu cầu đúng chuẩn
// Google Routes API v2 / OSRM, đọc kết quả, tính lại bằng ô tô khi chưa có đường xe máy, lỗi tiếng Việt không lộ khoá,
// bộ nhớ đệm theo khung giờ đi, hạn mức gọi trong ngày.
import { ok, eq, group, summary } from './harness.mjs';
import { createRouting, decodePolyline, encodePolyline, joinPolylines } from '../lib/routing.js';

const MIN = 60000, H = 3600000;
const KEY = 'AIzaSyKHOA-bi-mat-cua-kiem-thu-0123456789';
const T0 = Date.parse('2026-10-05T03:00:00Z'); // Thứ Hai 05/10/2026, 10:00 giờ Việt Nam (đúng mốc khung 5 phút và 15 phút)
const A = { lat: 10.7769, lon: 106.7009 }, B = { lat: 10.7626, lon: 106.6602 }, C = { lat: 10.8231, lon: 106.6297 }, D = { lat: 10.85, lon: 106.77 };
const MID = { lat: 10.77, lon: 106.69 }, MID2 = { lat: 10.8, lon: 106.64 };
const pl = (...pts) => encodePolyline(pts.map((p) => [p.lat, p.lon]));
const res = (status, obj) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const failOf = async (p) => { try { await p; return null; } catch (e) { return e; } };

/** fetch giả: ghi lại mọi yêu cầu; reply(c, n) trả về Response (hoặc ném lỗi như fetch thật). */
function fakeFetch(reply) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const c = { url: String(url), method: init.method || 'GET', headers: { ...(init.headers || {}) }, body: init.body ? JSON.parse(init.body) : null, signal: init.signal };
    calls.push(c);
    return reply(c, calls.length);
  };
  return { fetch, calls };
}
/** Máy chủ treo: chỉ trả lời khi bị huỷ (giữ một bộ hẹn giờ để tiến trình không thoát sớm trong lúc chờ). */
const hang = (c) => new Promise((_, rej) => { const k = setTimeout(() => {}, 10000); c.signal.addEventListener('abort', () => { clearTimeout(k); rej(c.signal.reason); }); });
/** Bộ tính đường Google với fetch giả và đồng hồ giả. */
function mkG(reply, extra = {}) {
  let t = T0;
  const logs = [], f = fakeFetch(reply);
  const r = createRouting({ provider: 'google', key: KEY, fetch: f.fetch, now: () => t, log: (m) => logs.push(m), ...extra });
  return { r, calls: f.calls, logs, clock: { set: (v) => { t = v; }, add: (ms) => { t += ms; }, now: () => t } };
}
/** Google trả lời đúng số điểm đã hỏi: mỗi chặng 1 km, 120 giây (không kẹt xe: 100 giây). */
const gAuto = (c) => {
  const pts = [c.body.origin, ...(c.body.intermediates || []), c.body.destination].map((w) => w.location.latLng);
  return res(200, { routes: [{ legs: pts.slice(1).map((p, i) => ({ distanceMeters: 1000, duration: '120s', staticDuration: '100s', polyline: { encodedPolyline: encodePolyline([[pts[i].latitude, pts[i].longitude], [p.latitude, p.longitude]]) } })) }] });
};
/** Kết quả Google 2 chặng A → B → C theo kiểu proto3 JSON (chỉ số 0 bị bỏ, thời lượng dạng "123s"). */
const G2 = () => ({ routes: [{
  distanceMeters: 9100, duration: '1500s', staticDuration: '1200s', warnings: ['Tuyến có đoạn đang thi công.'],
  legs: [
    { distanceMeters: 5000, duration: '900s', staticDuration: '700s', polyline: { encodedPolyline: pl(A, MID, B) }, travelAdvisory: { speedReadingIntervals: [{ endPolylinePointIndex: 1, speed: 'SLOW' }, { startPolylinePointIndex: 1, endPolylinePointIndex: 2, speed: 'NORMAL' }] } },
    { distanceMeters: 4100, duration: '600.4s', staticDuration: '500s', polyline: { encodedPolyline: pl(B, MID2, C) }, travelAdvisory: { speedReadingIntervals: [{ endPolylinePointIndex: 1, speed: 'NORMAL' }, { startPolylinePointIndex: 1, endPolylinePointIndex: 2, speed: 'TRAFFIC_JAM' }] } },
  ],
}] });

await group('Polyline: mã hoá / giải mã đúng chuẩn Google, nối các bước của một chặng', async () => {
  const pts = [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]];
  eq(encodePolyline(pts), '_p~iF~ps|U_ulLnnqC_mqNvxq`@', 'ví dụ mẫu trong tài liệu Google');
  eq(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), pts, 'giải mã ngược lại đúng');
  eq(decodePolyline(encodePolyline(pts, 6), 6), pts, 'precision 6 (polyline6) cũng đúng');
  eq([decodePolyline(''), decodePolyline(null)], [[], []], 'chuỗi rỗng / không phải chuỗi → không có điểm');
  eq(joinPolylines([encodePolyline([[1, 2], [3, 4]]), encodePolyline([[3, 4], [5, 6]]), encodePolyline([[5, 6], [5, 6]])]), encodePolyline([[1, 2], [3, 4], [5, 6]]), 'nối các bước: bỏ điểm trùng ở chỗ nối và ở bước "arrive"');
  eq(joinPolylines([encodePolyline([[1, 2], [1, 2]])]), '', 'chặng dài 0 → chuỗi rỗng');
});

await group('Không cấu hình hoặc cấu hình sai → null (lõi chạy như cũ), lý do rõ ràng, không lộ khoá', async () => {
  const logs = [], log = (m) => logs.push(m);
  eq(createRouting({ log }), null, 'mặc định (không có nhà cung cấp) → tắt');
  eq(createRouting({ provider: 'none', key: KEY, log }), null, 'ROUTING_PROVIDER=none → tắt');
  eq(logs.length, 0, 'tắt có chủ ý thì không cảnh báo');
  eq(createRouting({ provider: 'google', log }), null, 'google mà thiếu khoá → tắt');
  ok(/GOOGLE_MAPS_API_KEY/.test(logs.at(-1)) && /chim bay/.test(logs.at(-1)), `cảnh báo nói rõ thiếu khoá và SLA dùng ước tính — ${logs.at(-1)}`);
  eq(createRouting({ provider: 'osrm', log }), null, 'osrm mà thiếu OSRM_URL → tắt');
  ok(/OSRM_URL/.test(logs.at(-1)), 'cảnh báo nói rõ thiếu OSRM_URL');
  eq(createRouting({ provider: 'osrm', osrmUrl: 'ftp://osrm.local', log }), null, 'OSRM_URL không phải http(s) → tắt');
  eq(createRouting({ provider: 'osrm', osrmUrl: 'http://osrm.local', osrmProfile: 'xe máy', log }), null, 'OSRM_PROFILE sai → tắt');
  eq(createRouting({ provider: 'mapbox', key: KEY, log }), null, 'nhà cung cấp lạ → tắt');
  eq(createRouting({ provider: 'google', key: KEY, mode: 'MOTORBIKE', log }), null, 'ROUTING_MODE sai → tắt');
  eq(createRouting({ provider: 'google', key: KEY, pref: 'FAST', log }), null, 'ROUTING_PREF sai → tắt');
  eq(createRouting({ provider: 'google', key: KEY + ' "x"', log }), null, 'khoá có dấu cách / ngoặc kép (dán nhầm) → tắt');
  ok(logs.length === 8 && !logs.some((m) => m.includes(KEY.slice(0, 12))), `mỗi cấu hình sai có đúng một cảnh báo, không cảnh báo nào chứa khoá (${logs.length})`);
  const g = createRouting({ provider: ' Google ', key: ` ${KEY} `, mode: 'two_wheeler', log });
  ok(g && typeof g.route === 'function', 'chấp nhận chữ hoa / thường và khoảng trắng thừa');
  eq(g.stats(), { provider: 'google', mode: 'TWO_WHEELER', calls_today: 0, cache_hits_today: 0, errors_today: 0, limit: 1500, last_error: null }, 'stats() cho /healthz');
  const info = g.info();
  ok(info.traffic && info.trafficLines && info.timeoutMs === 8000 && /xe máy/.test(info.text) && !JSON.stringify(info).includes(KEY), `info() mô tả cấu hình, không có khoá — ${info.text}`);
  const o = createRouting({ provider: 'osrm', osrmUrl: 'https://router.project-osrm.org/', log });
  ok(o && o.info().host === 'router.project-osrm.org' && /chỉ dùng để thử/.test(o.info().text), `OSRM công cộng: nhắc chỉ để thử — ${o && o.info().text}`);
});

await group('Google: yêu cầu đúng chuẩn Routes API v2', async () => {
  const g = mkG(gAuto);
  const r = await g.r.route([A, B, C], { departAt: null });
  eq(g.calls.length, 1, 'gọi đúng 1 lần');
  const c = g.calls[0], b = c.body;
  eq([c.method, c.url], ['POST', 'https://routes.googleapis.com/directions/v2:computeRoutes'], 'POST tới computeRoutes');
  eq(c.headers['X-Goog-Api-Key'], KEY, 'khoá gửi qua header X-Goog-Api-Key');
  ok(!c.url.includes(KEY) && !JSON.stringify(b).includes(KEY), 'khoá không nằm trên URL hay trong nội dung gửi');
  eq(c.headers['Content-Type'], 'application/json', 'gửi JSON');
  const mask = c.headers['X-Goog-FieldMask'].split(',');
  for (const f of ['routes.distanceMeters', 'routes.duration', 'routes.staticDuration', 'routes.warnings', 'routes.legs.distanceMeters', 'routes.legs.duration', 'routes.legs.staticDuration', 'routes.legs.polyline.encodedPolyline', 'routes.legs.travelAdvisory.speedReadingIntervals']) ok(mask.includes(f), `field mask có ${f}`);
  eq(mask.length, 9, 'field mask chỉ xin đúng các trường cần (không dùng *)');
  eq(b.origin, { location: { latLng: { latitude: A.lat, longitude: A.lon } } }, 'origin = toạ độ điểm đầu');
  eq(b.destination, { location: { latLng: { latitude: C.lat, longitude: C.lon } } }, 'destination = điểm cuối');
  eq(b.intermediates, [{ location: { latLng: { latitude: B.lat, longitude: B.lon } } }], '1 điểm giữa, đúng thứ tự');
  eq([b.travelMode, b.routingPreference], ['TWO_WHEELER', 'TRAFFIC_AWARE'], 'mặc định: xe máy, có giao thông');
  eq(b.extraComputations, ['TRAFFIC_ON_POLYLINE'], 'xin giao thông trên polyline');
  eq([b.languageCode, b.regionCode, b.units], ['vi', 'VN', 'METRIC'], 'tiếng Việt, Việt Nam, đơn vị mét');
  eq([b.polylineQuality, b.polylineEncoding, b.computeAlternativeRoutes], ['HIGH_QUALITY', 'ENCODED_POLYLINE', false], 'polyline chi tiết, mã hoá chuẩn, không xin tuyến thay thế');
  ok(!('departureTime' in b), 'đi ngay: không gửi departureTime (Google lấy giờ nhận yêu cầu)');
  eq([r.depart_at, r.at], [T0, T0], 'depart_at = lúc hỏi; at = lúc tính');
  await g.r.route([A, C], { departAt: T0 + 30000 });
  ok(!('departureTime' in g.calls[1].body), 'giờ đi trong vòng 60 giây tới vẫn là đi ngay (giờ đã qua thì Google báo lỗi)');
  ok(!('intermediates' in g.calls[1].body), 'chỉ 2 điểm: không có intermediates');
  await g.r.route([A, D], { departAt: T0 - 10 * MIN });
  ok(!('departureTime' in g.calls[2].body), 'giờ đi đã qua (task trễ) → đi ngay');
  const r2 = await g.r.route([B, D], { departAt: T0 + 2 * H });
  eq(g.calls[3].body.departureTime, '2026-10-05T05:00:00.000Z', 'giờ đi về sau: gửi departureTime (RFC 3339, giờ UTC)');
  eq(r2.depart_at, T0 + 2 * H, 'depart_at = giờ đi đã dùng để tính');
});

await group('Google: đọc kết quả — thời lượng "123s", chỉ số thiếu = 0, đoạn chậm / kẹt, số chặng', async () => {
  const g = mkG(() => res(200, G2()));
  const r = await g.r.route([A, B, C]);
  eq(Object.keys(r).sort(), ['at', 'depart_at', 'distance_m', 'duration_s', 'legs', 'mode', 'provider', 'static_s', 'traffic', 'warnings'], 'đúng các trường của Route');
  eq(Object.keys(r.legs[0]).sort(), ['distance_m', 'duration_s', 'jams', 'polyline', 'static_s'], 'đúng các trường của một chặng');
  eq(r.legs.length, 2, '3 điểm → 2 chặng');
  eq([r.provider, r.mode, r.traffic], ['google', 'TWO_WHEELER', true], 'nguồn, phương tiện, có giao thông');
  eq(r.legs.map((l) => [l.distance_m, l.duration_s, l.static_s]), [[5000, 900, 700], [4100, 600, 500]], 'mét, giây ("600.4s" → 600), giây khi không kẹt xe');
  eq([r.distance_m, r.duration_s, r.static_s], [9100, 1500, 1200], 'tổng = cộng các chặng');
  eq([r.legs[0].polyline, r.legs[1].polyline], [pl(A, MID, B), pl(B, MID2, C)], 'polyline của từng chặng giữ nguyên');
  eq(r.legs[0].jams, [[0, 1, 1]], 'SLOW → mức 1; thiếu startPolylinePointIndex hiểu là 0; NORMAL bỏ qua');
  eq(r.legs[1].jams, [[1, 2, 2]], 'TRAFFIC_JAM → mức 2; chỉ số tính theo polyline của chặng');
  ok(r.warnings.includes('Tuyến có đoạn đang thi công.'), 'giữ cảnh báo của Google');
  ok(r.warnings.some((w) => /beta/.test(w)), 'đường xe máy: kèm cảnh báo bản thử nghiệm (Google yêu cầu hiện cho người dùng)');
  const h = mkG(() => res(200, { routes: [{ legs: [{ distanceMeters: 1000, duration: '123s', staticDuration: '98s', polyline: { encodedPolyline: pl(A, B) } }] }] }));
  const r1 = await h.r.route([A, B]);
  eq([r1.duration_s, r1.static_s, r1.legs.length], [123, 98, 1], '"123s" → 123 giây; 2 điểm → 1 chặng');
  const k = mkG(() => res(200, { routes: [{ legs: [{ duration: '0s', polyline: {} }] }] }));
  const z = await k.r.route([A, B]);
  eq(z.legs[0], { distance_m: 0, duration_s: 0, static_s: null, polyline: '', jams: [] }, 'trường bị bỏ (proto3) → 0 / null / chuỗi rỗng');
  eq(z.static_s, null, 'một chặng thiếu thời lượng không kẹt xe → tổng là null');
});

await group('Google: không tính giao thông, tắt tô màu kẹt xe', async () => {
  const g = mkG(gAuto, { mode: 'DRIVE', pref: 'TRAFFIC_UNAWARE' });
  const r = await g.r.route([A, B], { departAt: T0 + 3 * H });
  const b = g.calls[0].body;
  ok(!('extraComputations' in b) && !('departureTime' in b), 'TRAFFIC_UNAWARE: không xin giao thông trên polyline, không gửi giờ đi');
  ok(!g.calls[0].headers['X-Goog-FieldMask'].includes('speedReadingIntervals'), 'field mask không xin khoảng tốc độ');
  eq([r.traffic, r.mode, r.depart_at, r.warnings], [false, 'DRIVE', T0 + 3 * H, []], 'traffic = false; ô tô không có cảnh báo beta');
  const h = mkG(gAuto, { mode: 'DRIVE', trafficLines: false });
  const r2 = await h.r.route([A, B]);
  ok(h.calls[0].body.routingPreference === 'TRAFFIC_AWARE' && !('extraComputations' in h.calls[0].body) && r2.traffic, 'trafficLines = false: vẫn tính giao thông, chỉ không tô màu (Google tính giá mức Pro thay vì Enterprise)');
  ok(!h.r.info().trafficLines && !/tô màu/.test(h.r.info().text), 'info() ghi đúng');
});

await group('Google: chưa có đường xe máy → tính lại MỘT lần bằng ô tô', async () => {
  const bad = { error: { code: 400, message: 'Travel mode TWO_WHEELER is not supported for this route.', status: 'INVALID_ARGUMENT' } };
  const g = mkG((c) => (c.body.travelMode === 'TWO_WHEELER' ? res(400, bad) : gAuto(c)));
  const r = await g.r.route([A, B]);
  eq(g.calls.map((c) => c.body.travelMode), ['TWO_WHEELER', 'DRIVE'], 'thử xe máy rồi ô tô');
  eq(r.mode, 'DRIVE', 'Route.mode = phương tiện thật sự đã dùng');
  ok(r.warnings.some((w) => /ô tô/.test(w)) && !r.warnings.some((w) => /beta/.test(w)), 'ghi chú đã tính theo ô tô');
  await g.r.route([A, C]);
  eq(g.calls.length, 4, 'tuyến khác gặp lỗi này cũng tính lại như vậy');
  eq(g.logs.filter((m) => /DRIVE/.test(m)).length, 1, 'chỉ ghi log một lần');
  eq(g.r.stats().calls_today, 4, 'lần gọi lại cũng tính vào hạn mức ngày');
  const h = mkG(() => res(400, bad));
  const e = await failOf(h.r.route([A, B]));
  eq(h.calls.length, 2, 'ô tô cũng lỗi: dừng, không thử lần ba');
  ok(e && e.code === 'http' && /HTTP 400/.test(e.message), `báo lỗi tiếng Việt — ${e && e.message}`);
  const k = mkG(() => res(400, { error: { code: 400, message: 'Invalid JSON payload received.', status: 'INVALID_ARGUMENT' } }));
  await failOf(k.r.route([A, B]));
  eq(k.calls.length, 1, 'lỗi 400 khác: không tính lại bằng ô tô');
});

await group('Google: lỗi → câu tiếng Việt ngắn gọn, không bao giờ lộ khoá', async () => {
  const deny = mkG(() => res(403, { error: { code: 403, message: `API key not valid. Please pass a valid API key. (${KEY})`, status: 'PERMISSION_DENIED' } }));
  let e = await failOf(deny.r.route([A, B]));
  eq([e && e.code, e && e.message], ['auth', 'Khoá Google Maps không hợp lệ hoặc chưa bật Routes API'], '403 → khoá sai / chưa bật Routes API');
  ok(e instanceof Error && !e.message.includes(KEY) && !JSON.stringify(e).includes(KEY), 'lỗi không chứa khoá');
  ok(deny.logs.length === 1 && /403/.test(deny.logs[0]) && !deny.logs[0].includes(KEY), `log có lý do nhưng đã che khoá — ${deny.logs[0]}`);
  e = await failOf(deny.r.route([A, C]));
  eq([deny.calls.length, e && e.code], [1, 'auth'], 'sau lỗi khoá: tạm ngừng gọi 5 phút, báo lỗi ngay');
  deny.clock.add(5 * MIN + 1000);
  await failOf(deny.r.route([A, C]));
  eq(deny.calls.length, 2, 'hết 5 phút thì thử gọi lại');
  eq(deny.logs.length, 1, 'lỗi giống hệt không ghi log lại trong 10 phút');
  const s = deny.r.stats();
  eq([s.errors_today, s.calls_today, s.last_error && s.last_error.message], [3, 2, 'Khoá Google Maps không hợp lệ hoặc chưa bật Routes API'], 'stats(): số lỗi, số lần gọi, lỗi gần nhất');
  const q = mkG(() => res(429, { error: { code: 429, message: 'Quota exceeded for quota metric', status: 'RESOURCE_EXHAUSTED' } }));
  e = await failOf(q.r.route([A, B]));
  eq([e && e.code, e && e.message], ['quota', 'Vượt hạn mức gọi Google'], '429 → vượt hạn mức');
  await failOf(q.r.route([A, C]));
  q.clock.add(MIN + 1000);
  await failOf(q.r.route([A, C]));
  eq(q.calls.length, 2, '429: tạm ngừng 1 phút rồi mới gọi lại');
  const slow = mkG(hang, { timeoutMs: 30 });
  e = await failOf(slow.r.route([A, B]));
  eq([e && e.code, e && e.message], ['timeout', 'Google không trả lời kịp'], 'quá ROUTING_TIMEOUT_MS → không trả lời kịp');
  const net = mkG(() => { throw new TypeError('fetch failed', { cause: new Error(`getaddrinfo ENOTFOUND routes.googleapis.com ${KEY}`) }); });
  e = await failOf(net.r.route([A, B]));
  eq([e && e.code, e && e.message], ['network', 'Không kết nối được tới Google Maps'], 'mất mạng → không kết nối được');
  ok(net.logs.length === 1 && !net.logs[0].includes(KEY), 'log lỗi mạng đã che khoá');
  const down = mkG(() => res(503, 'Service Unavailable'));
  e = await failOf(down.r.route([A, B]));
  ok(e && e.code === 'http' && e.message === 'Google Maps đang trục trặc (HTTP 503), thử lại sau', `5xx → Google đang trục trặc — ${e && e.message}`);
  const none = mkG(() => res(200, {}));
  e = await failOf(none.r.route([A, B]));
  eq([e && e.code, e && e.message], ['no_route', 'Google không tìm được đường đi qua các điểm này'], 'không có tuyến ({}) → không tìm được đường');
  const odd = mkG(() => res(200, G2()));
  e = await failOf(odd.r.route([A, B]));
  eq(e && e.code, 'bad_response', 'số chặng không khớp số điểm → báo lỗi, không đoán');
  for (const m of [deny, q, slow, net, down, none, odd]) ok(!m.logs.some((x) => x.includes(KEY)), 'không dòng log nào chứa khoá');
});

await group('Bộ nhớ đệm: không gọi lại tuyến vừa tính, hết hạn theo khung giờ đi', async () => {
  const g = mkG(gAuto);
  const r1 = await g.r.route([A, B, C]);
  g.clock.add(4 * MIN);
  const r2 = await g.r.route([{ lat: 10.776901, lon: 106.700899 }, B, C]);
  eq(g.calls.length, 1, 'cùng tuyến (toạ độ làm tròn 5 chữ số), cùng khung 5 phút → dùng lại, không gọi');
  eq(r2, r1, 'kết quả giống hệt lần tính trước');
  eq(g.r.stats().cache_hits_today, 1, 'đếm lượt dùng lại');
  r2.legs[0].polyline = 'hong';
  r2.legs.length = 0;
  g.clock.add(30000);
  eq((await g.r.route([A, B, C])).legs.map((l) => l.polyline), r1.legs.map((l) => l.polyline), 'sửa kết quả trả về không làm hỏng bộ nhớ đệm');
  g.clock.set(T0 + 5 * MIN);
  await g.r.route([A, B, C]);
  eq(g.calls.length, 2, 'sang khung 5 phút mới → tính lại theo giao thông mới');
  const later = T0 + 3 * H;
  await g.r.route([A, B], { departAt: later });
  g.clock.add(10 * MIN);
  const again = await g.r.route([A, B], { departAt: later + 10 * MIN });
  eq([g.calls.length, again.depart_at], [3, later], 'giờ đi về sau: cùng khung 15 phút → dùng lại (depart_at là giờ đã dùng để tính)');
  await g.r.route([A, B], { departAt: later + 15 * MIN });
  eq(g.calls.length, 4, 'khác khung 15 phút → tính lại');
  g.clock.add(61 * MIN);
  await g.r.route([A, B], { departAt: later });
  eq(g.calls.length, 5, 'quá 60 phút → hết hạn, tính lại');
  const h = mkG(gAuto);
  const [x, y] = await Promise.all([h.r.route([A, D]), h.r.route([A, D])]);
  eq([h.calls.length, x, h.r.stats().cache_hits_today], [1, y, 1], 'hai yêu cầu giống hệt cùng lúc → chỉ gọi 1 lần, dùng chung kết quả');
  const lru = mkG(gAuto);
  for (let i = 0; i <= 500; i++) await lru.r.route([A, { lat: 10.5 + i / 1000, lon: 106.5 }]);
  await lru.r.route([A, { lat: 10.5 + 500 / 1000, lon: 106.5 }]);
  eq(lru.calls.length, 501, 'tuyến mới nhất vẫn còn trong bộ nhớ đệm');
  await lru.r.route([A, { lat: 10.5, lon: 106.5 }]);
  eq(lru.calls.length, 502, 'quá 500 tuyến: bỏ tuyến cũ nhất');
});

await group('Hạn mức gọi trong ngày (ROUTING_DAILY_LIMIT), tính theo giờ Việt Nam', async () => {
  const g = mkG(gAuto, { dailyLimit: 2, tzOffsetMin: 420 });
  await g.r.route([A, B]);
  await g.r.route([A, C]);
  let e = await failOf(g.r.route([A, D]));
  eq([e && e.code, e && e.message], ['limit', 'Đã dùng hết hạn mức gọi tuyến đường trong ngày (ROUTING_DAILY_LIMIT)'], 'quá hạn mức → báo rõ');
  eq(g.calls.length, 2, 'không gọi thêm');
  eq((await g.r.route([A, B])).legs.length, 1, 'tuyến có sẵn trong bộ nhớ đệm vẫn dùng được (không tính vào hạn mức)');
  await failOf(g.r.route([A, D]));
  eq(g.logs.filter((m) => /ROUTING_DAILY_LIMIT/.test(m)).length, 1, 'chạm hạn mức: ghi log đúng một lần trong ngày');
  eq(g.r.stats(), { provider: 'google', mode: 'TWO_WHEELER', calls_today: 2, cache_hits_today: 1, errors_today: 2, limit: 2, last_error: { at: T0, message: 'Đã dùng hết hạn mức gọi tuyến đường trong ngày (ROUTING_DAILY_LIMIT)' } }, 'stats() trong ngày');
  g.clock.set(Date.parse('2026-10-05T16:59:00Z')); // 23:59 giờ Việt Nam: vẫn là hôm nay
  e = await failOf(g.r.route([A, D]));
  eq(e && e.code, 'limit', '23:59 vẫn hết lượt');
  g.clock.set(Date.parse('2026-10-05T17:00:00Z')); // 00:00 ngày 06/10 giờ Việt Nam
  eq([g.r.stats().calls_today, g.r.stats().errors_today], [0, 0], 'sang ngày mới (giờ Việt Nam) → đếm lại từ 0');
  await g.r.route([A, D]);
  eq(g.calls.length, 3, 'gọi lại được');
  const u = mkG(gAuto, { dailyLimit: 0 });
  for (const p of [B, C, D]) await u.r.route([A, p]);
  eq(u.calls.length, 3, 'ROUTING_DAILY_LIMIT=0 → không giới hạn');
});

await group('OSRM: yêu cầu, ghép hình học các bước thành từng chặng, lỗi', async () => {
  const S1 = { lat: 10.775, lon: 106.695 };
  const body = { code: 'Ok', waypoints: [], routes: [{ distance: 6001, duration: 800.5, weight: 800.5, legs: [
    { distance: 3000.4, duration: 400.6, summary: '', steps: [{ geometry: pl(A, S1), maneuver: { type: 'depart' } }, { geometry: pl(S1, MID), maneuver: { type: 'turn' } }, { geometry: pl(MID, MID), maneuver: { type: 'arrive' } }] },
    { distance: 3000.6, duration: 399.9, summary: '', steps: [{ geometry: pl(MID, B), maneuver: { type: 'depart' } }, { geometry: pl(B, B), maneuver: { type: 'arrive' } }] },
  ] }] };
  let t = T0;
  const f = fakeFetch(() => res(200, body));
  const o = createRouting({ provider: 'osrm', osrmUrl: 'http://osrm.local:5000/', fetch: f.fetch, now: () => t });
  const r = await o.route([A, MID, B], { departAt: T0 + 2 * H });
  eq(f.calls[0].url, 'http://osrm.local:5000/route/v1/driving/106.700900,10.776900;106.690000,10.770000;106.660200,10.762600?overview=false&steps=true&geometries=polyline&annotations=false', 'GET /route/v1/driving/kinh độ,vĩ độ;… kèm steps, polyline');
  ok(f.calls[0].method === 'GET' && f.calls[0].headers['User-Agent'], 'GET, có User-Agent riêng');
  eq([r.provider, r.mode, r.traffic, r.warnings], ['osrm', 'driving', false, []], 'OSRM: không có giao thông, không có cảnh báo');
  eq(r.legs.map((l) => [l.distance_m, l.duration_s, l.static_s]), [[3000, 401, 401], [3001, 400, 400]], 'mỗi chặng: mét, giây; static_s = duration_s');
  eq([r.distance_m, r.duration_s, r.static_s], [6001, 801, 801], 'tổng = cộng các chặng');
  eq(r.legs[0].polyline, pl(A, S1, MID), 'chặng 1 = nối các bước, bỏ điểm trùng ở chỗ nối và bước "arrive"');
  eq(decodePolyline(r.legs[1].polyline), [[MID.lat, MID.lon], [B.lat, B.lon]], 'chặng 2 giải mã ra đúng các điểm');
  eq([r.legs[0].jams, r.legs[1].jams], [[], []], 'không có dữ liệu kẹt xe');
  eq(r.depart_at, T0 + 2 * H, 'giữ giờ đi đã hỏi');
  t += 30 * MIN;
  const r2 = await o.route([A, MID, B]);
  eq([f.calls.length, r2.depart_at, r2.legs[0].polyline], [1, t, r.legs[0].polyline], 'không có giao thông: dùng lại bất kể giờ đi, depart_at theo lần hỏi này');
  const no = fakeFetch(() => res(400, { code: 'NoRoute', message: 'Impossible route between points' }));
  let e = await failOf(createRouting({ provider: 'osrm', osrmUrl: 'https://osrm.test', fetch: no.fetch, now: () => T0 }).route([A, B]));
  eq([e && e.code, e && e.message], ['no_route', 'OSRM không tìm được đường đi qua các điểm này'], 'NoRoute → không tìm được đường');
  const seg = fakeFetch(() => res(400, { code: 'NoSegment', message: 'Could not find a matching segment for any coordinate.' }));
  e = await failOf(createRouting({ provider: 'osrm', osrmUrl: 'https://osrm.test', fetch: seg.fetch, now: () => T0 }).route([A, B]));
  ok(e && e.code === 'no_route' && /xa đường/.test(e.message), `NoSegment → toạ độ nằm xa đường — ${e && e.message}`);
  const busy = fakeFetch(() => res(429, 'Too Many Requests'));
  e = await failOf(createRouting({ provider: 'osrm', osrmUrl: 'https://osrm.test', fetch: busy.fetch, now: () => T0 }).route([A, B]));
  eq([e && e.code, e && e.message], ['quota', 'Máy chủ OSRM từ chối vì gọi quá dày (HTTP 429)'], '429 → gọi quá dày');
  const slow = fakeFetch(hang);
  e = await failOf(createRouting({ provider: 'osrm', osrmUrl: 'https://osrm.test', fetch: slow.fetch, timeoutMs: 30 }).route([A, B]));
  eq([e && e.code, e && e.message], ['timeout', 'Máy chủ OSRM không trả lời kịp'], 'quá giờ chờ → không trả lời kịp');
});

await group('Điểm trùng liền nhau, điểm sai, quá nhiều điểm', async () => {
  const g = mkG(gAuto);
  const r = await g.r.route([A, { ...A }, B]);
  ok(!('intermediates' in g.calls[0].body), 'hai điểm liền nhau trùng chỗ (vd hai điểm cùng một BO): chỉ gửi một lần');
  eq(r.legs.length, 2, 'vẫn đủ points − 1 chặng');
  eq(r.legs[0], { distance_m: 0, duration_s: 0, static_s: 0, polyline: '', jams: [] }, 'chặng trùng chỗ = chặng rỗng');
  eq([r.legs[1].distance_m, r.distance_m], [1000, 1000], 'chặng còn lại lấy từ Google');
  const z = await g.r.route([B, { lat: B.lat, lon: B.lon }]);
  eq([g.calls.length, z.distance_m, z.duration_s, z.legs.length], [1, 0, 0, 1], 'mọi điểm cùng một chỗ → không gọi dịch vụ, tuyến dài 0');
  const loop = await g.r.route([A, B, A]);
  eq([g.calls[1].body.intermediates.length, loop.legs.length], [1, 2], 'tuyến hai chiều (điểm cuối = điểm đầu) vẫn gửi đủ điểm');
  for (const bad of [[], [A], null, [A, { lat: 'x', lon: 106 }], [A, { lat: 91, lon: 106 }], [A, { lat: 0, lon: 0 }]]) {
    const e = await failOf(g.r.route(bad));
    ok(e && e.code === 'bad_points' && /ít nhất 2 điểm/.test(e.message), `điểm không hợp lệ → báo lỗi (${JSON.stringify(bad)})`);
  }
  eq(g.calls.length, 2, 'không gọi dịch vụ cho điểm sai');
  const many = Array.from({ length: 28 }, (_, i) => ({ lat: 10.7 + i * 0.001, lon: 106.6 }));
  const e = await failOf(g.r.route(many));
  ok(e && e.code === 'too_many' && /27/.test(e.message), 'quá 27 điểm (Google tối đa 25 điểm giữa) → báo lỗi, không gọi');
  const r27 = await g.r.route(many.slice(0, 27));
  eq([g.calls.length, g.calls[2].body.intermediates.length, r27.legs.length], [3, 25, 26], '27 điểm → 25 điểm giữa, 26 chặng');
});

summary('Đường đi thực tế');
