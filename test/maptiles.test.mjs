// maptiles.test.mjs — lib/maptiles.js (nền bản đồ Google chính thức, Map Tiles API) với fetch giả, đồng hồ giả và hẹn giờ giả, không gọi mạng thật:
// tạo phiên đúng chuẩn (kèm Referer cho khoá giới hạn theo trang web), mẫu địa chỉ ô bản đồ, làm mới mỗi 24 giờ, thử lại 1 → 30 phút khi lỗi,
// giữ phiên cũ tới khi hết hạn, dòng bản quyền theo khung nhìn (làm tròn khung, nhớ 30 phút, lỗi → ''), khoá không bao giờ lộ ra log / lỗi.
import { ok, eq, group, summary } from './harness.mjs';
import { createMapTiles, roundBox } from '../lib/maptiles.js';

const MIN = 60000, DAY = 86400000;
const KEY = 'AIzaSyBANDO-bi-mat-cua-kiem-thu-0123456';
const REF = 'https://fo.example.com';
const T0 = Date.parse('2026-10-05T03:00:00Z'); // Thứ Hai 05/10/2026, 10:00 giờ Việt Nam
const COPY = 'Dữ liệu bản đồ ©2026 Google';
const VIEW = { layer: 'roadmap', z: 14, n: 10.8, s: 10.75, e: 106.72, w: 106.66 }; // một khung nhìn ở trung tâm TP.HCM
const ALL_LOGS = [];
const res = (status, obj) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const deny = (status, msg) => res(status, { error: { code: status, message: msg, status: status === 403 ? 'PERMISSION_DENIED' : 'INVALID_ARGUMENT' } });
/** Máy chủ treo: chỉ trả lời khi bị huỷ (giữ một bộ hẹn giờ để tiến trình không thoát sớm trong lúc chờ). */
const hang = (c) => new Promise((_, rej) => { const k = setTimeout(() => {}, 10000); c.signal.addEventListener('abort', () => { clearTimeout(k); rej(c.signal.reason); }); });

/** Google giả: tạo phiên S1, S2, … theo thứ tự gọi, sống 14 ngày kể từ lúc tạo; hỏi khung nhìn thì trả dòng bản quyền. */
const google = () => {
  let i = 0;
  return (c, n, t) => (c.url.includes('/createSession')
    ? res(200, { session: `S${++i}-phien-ban-do`, expiry: String(Math.floor((t + 14 * DAY) / 1000)), tileWidth: 256, tileHeight: 256, imageFormat: 'png' })
    : res(200, { copyright: COPY, maxZoomRects: [{ maxZoom: 22, north: 90, south: -90, east: 180, west: -180 }] }));
};
/** Bộ nền bản đồ với fetch giả (ghi lại mọi yêu cầu), đồng hồ giả và hẹn giờ giả (chỉ chạy khi bài kiểm gọi fire()). */
function mk(reply, extra = {}) {
  let t = T0;
  const calls = [], logs = [], changes = [], timers = [];
  const fetch = async (url, init = {}) => { const c = { url: String(url), method: init.method || 'GET', headers: { ...(init.headers || {}) }, body: init.body ? JSON.parse(init.body) : null, signal: init.signal }; calls.push(c); return reply(c, calls.length, t); };
  const m = createMapTiles({
    key: KEY, referer: REF, fetch, now: () => t, log: (x) => { logs.push(x); ALL_LOGS.push(x); }, onChange: (x) => changes.push(x),
    setTimer: (fn, ms) => { const h = { fn, ms, on: true }; timers.push(h); return h; }, clearTimer: (h) => { h.on = false; }, ...extra,
  });
  const pend = () => timers.filter((h) => h.on);
  return {
    m, calls, logs, changes, pend,
    clock: { set: (v) => { t = v; }, add: (ms) => { t += ms; }, now: () => t },
    /** Tua đồng hồ tới hẹn giờ đang chờ rồi chạy nó; trả về số ms đã chờ. */
    async fire() { const h = pend().at(-1); h.on = false; t += h.ms; await h.fn(); return h.ms; },
  };
}
const tile = (s) => `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${s}&key=${KEY}`;

await group('Không đặt khoá hoặc cấu hình sai → null (dùng nền cũ), lý do rõ ràng, không lộ khoá', async () => {
  const logs = [], log = (m) => { logs.push(m); ALL_LOGS.push(m); };
  eq(createMapTiles({ log }), null, 'chưa đặt GOOGLE_MAPS_TILES_KEY → tắt');
  eq(createMapTiles({ key: '   ', referer: REF, log }), null, 'khoá toàn khoảng trắng → tắt');
  eq(logs.length, 0, 'không đặt khoá thì không cảnh báo');
  eq(createMapTiles({ key: KEY, log }), null, 'thiếu PUBLIC_URL → tắt');
  ok(/PUBLIC_URL/.test(logs.at(-1)) && /nền cũ \(TILE_URL\)/.test(logs.at(-1)), `cảnh báo nói rõ thiếu PUBLIC_URL và bản đồ dùng nền cũ — ${logs.at(-1)}`);
  eq(createMapTiles({ key: KEY, referer: 'fo.example.com', log }), null, 'PUBLIC_URL thiếu https:// → tắt');
  eq(createMapTiles({ key: KEY, referer: 'ftp://fo.example.com', log }), null, 'PUBLIC_URL không phải http(s) → tắt');
  eq(createMapTiles({ key: KEY + ' "x"', referer: REF, log }), null, 'khoá có dấu cách / ngoặc kép (dán nhầm) → tắt');
  ok(/ký tự lạ/.test(logs.at(-1)), 'cảnh báo khoá có ký tự lạ');
  ok(logs.length === 4 && !logs.some((m) => m.includes(KEY.slice(0, 12))), `mỗi cấu hình sai có đúng một cảnh báo, không cảnh báo nào chứa khoá (${logs.length})`);
  const m = createMapTiles({ key: ` ${KEY} `, referer: ` ${REF}/ `, fetch: async () => res(500, ''), log });
  ok(m && typeof m.start === 'function' && typeof m.attribution === 'function', 'có khoá + PUBLIC_URL → bật (bỏ khoảng trắng thừa)');
  eq(m.cfg(), null, 'chưa tạo phiên → cfg() = null');
  eq(m.status(), { provider: 'google', on: false, referer: 'https://fo.example.com/', roadmap: null, satellite: null, next_at: null, fails: 0, last_error: null, attribution: { calls: 0, cache_hits: 0, errors: 0, cached: 0 } }, 'status() lúc chưa chạy');
});

await group('Tạo phiên: đúng chuẩn Map Tiles API, kèm Referer; cfg() là mẫu địa chỉ ô bản đồ', async () => {
  const g = mk(google());
  const p = g.m.start();
  ok(p === g.m.start(), 'gọi start() lần nữa không tạo thêm vòng làm mới');
  await p;
  eq(g.calls.length, 2, 'tạo 2 phiên: đường phố + vệ tinh');
  const [a, b] = g.calls;
  eq([a.method, a.url], ['POST', `https://tile.googleapis.com/v1/createSession?key=${KEY}`], 'POST /v1/createSession, khoá ở tham số key');
  eq([a.headers['Content-Type'], b.headers['Content-Type']], ['application/json', 'application/json'], 'gửi JSON');
  eq([a.headers.Referer, b.headers.Referer], ['https://fo.example.com/', 'https://fo.example.com/'], 'gửi Referer = gốc PUBLIC_URL + "/" để qua giới hạn trang web của khoá');
  eq(a.body, { mapType: 'roadmap', language: 'vi-VN', region: 'VN' }, 'đường phố: nhãn tiếng Việt, góc nhìn Việt Nam');
  eq(b.body, { mapType: 'satellite', language: 'vi-VN', region: 'VN', layerTypes: ['layerRoadmap'] }, 'vệ tinh kèm tên đường (layerRoadmap, như kiểu hybrid)');
  ok(!JSON.stringify([a.body, b.body]).includes(KEY), 'khoá không nằm trong nội dung gửi');
  ok(a.signal instanceof AbortSignal, 'có giới hạn thời gian chờ');
  const c = g.m.cfg();
  eq(c, { provider: 'google', roadmap: tile('S1-phien-ban-do'), satellite: tile('S2-phien-ban-do'), maxZoom: 22, attribution: 'map-attribution' }, 'cfg(): mẫu {z}/{x}/{y} kèm phiên của từng lớp và khoá, zoom tối đa 22, đường dẫn lấy dòng bản quyền');
  eq(g.changes, [c], 'báo cfg() mới cho máy chủ (core.cfg.mapTiles) đúng một lần');
  eq(g.pend().map((h) => h.ms), [DAY], 'hẹn làm mới sau 24 giờ');
  ok(g.logs.length === 1 && /đã tạo phiên/.test(g.logs[0]) && /14 ngày/.test(g.logs[0]), `log một dòng: đã tạo phiên, còn hạn 14 ngày — ${g.logs[0]}`);
  const st = g.m.status(), exp = T0 + 14 * DAY;
  eq([st.on, st.roadmap, st.satellite, st.next_at, st.fails, st.last_error], [true, { ok: true, at: T0, expiry: exp }, { ok: true, at: T0, expiry: exp }, T0 + DAY, 0, null], 'status() cho /healthz: hai lớp còn hạn, lần làm mới kế tiếp');
  ok(!JSON.stringify(st).includes(KEY) && !JSON.stringify(st).includes('S1-phien'), 'status() không có khoá, không có mã phiên');
  const h = mk(google(), { referer: 'https://fo.example.com:8443/atlas/' });
  await h.m.start();
  eq(h.calls[0].headers.Referer, 'https://fo.example.com:8443/', 'PUBLIC_URL có đường dẫn con: Referer chỉ lấy gốc trang (đúng như trình duyệt gửi khi tải ô)');
  const k = mk((x, n, t) => res(200, { session: 'Phien/la+co=dau{x}', expiry: String((t + DAY) / 1000) }), { key: KEY });
  await k.m.start();
  ok(k.m.cfg().roadmap.includes('session=Phien%2Fla%2Bco%3Ddau%7Bx%7D&key='), 'mã phiên có ký tự đặc biệt: mã hoá trên địa chỉ (không phá mẫu {z}/{x}/{y} của Leaflet)');
});

await group('Làm mới mỗi 24 giờ; lỗi thì thử lại sau 1 → 30 phút, vẫn dùng phiên cũ tới khi hết hạn', async () => {
  let fail = false;
  const auto = google();
  const g = mk((c, n, t) => (fail && c.url.includes('/createSession') ? deny(403, `Requests from referer https://fo.example.com/ are blocked. key=${KEY}`) : auto(c, n, t)));
  await g.m.start();
  eq(await g.fire(), DAY, 'chờ đúng 24 giờ');
  eq(g.calls.length, 4, 'làm mới cả hai phiên');
  eq([g.m.cfg().roadmap, g.m.cfg().satellite], [tile('S3-phien-ban-do'), tile('S4-phien-ban-do')], 'dùng phiên mới');
  eq([g.changes.length, g.changes[1]], [2, g.m.cfg()], 'báo cfg() mới cho máy chủ');
  eq(g.logs.length, 1, 'làm mới thành công hằng ngày không ghi thêm log');
  fail = true;
  const waits = [];
  for (let i = 0; i < 8; i++) waits.push(await g.fire());
  eq(waits.map((w) => w / MIN), [1440, 1, 2, 4, 8, 16, 30, 30], 'lỗi liên tiếp: thử lại sau 1, 2, 4, 8, 16 rồi 30 phút');
  eq(g.calls.length, 4 + 8 * 2, 'mỗi lần thử lại tạo lại cả hai phiên');
  eq(g.m.cfg().roadmap, tile('S3-phien-ban-do'), 'trong lúc lỗi vẫn dùng phiên cũ còn hạn');
  eq(g.changes.at(-1), g.m.cfg(), 'mỗi lần thử đều báo cfg() hiện tại cho máy chủ');
  ok(/thử lại sau 1 phút/i.test(g.logs[1]) && /vẫn dùng phiên cũ \(còn hạn 13 ngày\)/.test(g.logs[1]) && /bị từ chối \(HTTP 403\)/.test(g.logs[1]) && /are blocked/.test(g.logs[1]), `log lỗi: lý do của Google, lúc thử lại, phiên cũ còn hạn — ${g.logs[1]}`);
  const st = g.m.status();
  eq([st.on, st.fails, st.last_error.message], [true, 8, 'Khoá GOOGLE_MAPS_TILES_KEY bị từ chối (HTTP 403): khoá sai, chưa bật Map Tiles API hoặc chưa cho phép tên miền của PUBLIC_URL'], 'status(): vẫn bật (phiên cũ), số lần lỗi liên tiếp, lỗi gần nhất bằng tiếng Việt');
  ok(!g.logs.some((x) => x.includes(KEY)) && !JSON.stringify(st).includes(KEY), 'Google nhắc lại khoá trong câu báo lỗi: log và status() đều đã che');
  const exp = st.roadmap.expiry;
  g.clock.set(exp - 40 * MIN);
  await g.fire();
  eq(g.pend().map((h) => h.ms), [9 * MIN], 'phiên cũ chỉ còn 10 phút: hẹn thử lại đúng lúc sắp hết hạn, không chờ đủ 30 phút');
  ok(g.m.cfg() !== null, 'chưa hết hạn: vẫn dùng');
  await g.fire();
  eq([g.m.cfg(), g.changes.at(-1), g.m.status().on], [null, null, false], 'phiên cũ hết hạn mà Google vẫn lỗi → cfg() = null, máy chủ gỡ nền Google (trình duyệt dùng nền cũ)');
  ok(/nền cũ \(TILE_URL\)/.test(g.logs.at(-1)), `log báo bản đồ dùng nền cũ — ${g.logs.at(-1)}`);
  eq(g.pend().map((h) => h.ms), [30 * MIN], 'vẫn thử lại mỗi 30 phút');
  fail = false;
  await g.fire();
  eq([g.m.cfg().roadmap, g.m.status().fails], [tile('S5-phien-ban-do'), 0], 'Google hết lỗi → tạo phiên mới, bật lại nền, đếm lỗi về 0');
  ok(/tạo lại phiên sau 10 lần lỗi/.test(g.logs.at(-1)), `log báo đã tạo lại (8 lần thử lại + 1 lần sát hạn + 1 lần hết hạn) — ${g.logs.at(-1)}`);
  eq(g.pend().map((h) => h.ms), [DAY], 'lại hẹn làm mới sau 24 giờ');
});

await group('Một lớp lỗi: chỉ thử lại lớp đó; chưa có phiên đường phố → cfg() = null', async () => {
  let satFail = true;
  const auto = google();
  const g = mk((c, n, t) => (satFail && c.body && c.body.mapType === 'satellite' ? res(503, 'Service Unavailable') : auto(c, n, t)));
  await g.m.start();
  eq(g.m.cfg(), { provider: 'google', roadmap: tile('S1-phien-ban-do'), satellite: null, maxZoom: 22, attribution: 'map-attribution' }, 'vệ tinh lỗi: vẫn bật nền đường phố, chưa có lớp vệ tinh');
  ok(/\(vệ tinh\): Google Maps đang trục trặc \(HTTP 503\)/.test(g.logs[0]) && /tạm ẩn lớp vệ tinh/.test(g.logs[0]), `log nói rõ lớp nào lỗi — ${g.logs[0]}`);
  eq(g.pend().map((h) => h.ms), [MIN], 'thử lại sau 1 phút');
  satFail = false;
  await g.fire();
  eq(g.calls.slice(2).map((x) => x.body.mapType), ['satellite'], 'lần thử lại chỉ tạo phiên vệ tinh');
  eq(g.m.cfg().satellite, tile('S2-phien-ban-do'), 'có lớp vệ tinh');
  eq(g.pend().map((h) => h.ms), [DAY - MIN], 'hẹn làm mới theo phiên tạo sớm nhất (đường phố, trước 1 phút)');
  const bad = mk(() => deny(403, `API key not valid. Please pass a valid API key. (${KEY})`));
  await bad.m.start();
  eq([bad.m.cfg(), bad.changes], [null, [null]], 'không tạo được phiên nào → cfg() = null, báo null cho máy chủ');
  ok(/\(đường phố, vệ tinh\)/.test(bad.logs[0]) && /nền cũ \(TILE_URL\)/.test(bad.logs[0]) && /API key not valid/.test(bad.logs[0]) && !bad.logs[0].includes(KEY), `log có lý do của Google nhưng đã che khoá — ${bad.logs[0]}`);
  eq(bad.m.status().on, false, 'status(): chưa bật');
  const k400 = mk(() => deny(400, 'API key not valid. Please pass a valid API key.'));
  await k400.m.start();
  ok(/bị từ chối \(HTTP 400\)/.test(k400.m.status().last_error.message), 'Google trả 400 "API key not valid" (khoá sai định dạng) cũng báo là lỗi khoá');
  const road = mk((c, n, t) => (c.body.mapType === 'roadmap' ? res(500, '') : google()(c, n, t)));
  await road.m.start();
  eq(road.m.cfg(), null, 'chỉ có phiên vệ tinh, chưa có đường phố → cfg() = null');
});

await group('Tạo phiên: mọi kiểu lỗi → câu tiếng Việt ngắn gọn, không lộ khoá', async () => {
  const cases = [
    ['429 hết hạn mức', () => res(429, { error: { code: 429, message: `Quota exceeded for quota metric ${KEY}`, status: 'RESOURCE_EXHAUSTED' } }), 'quota', 'Vượt hạn mức Map Tiles API (HTTP 429)'],
    ['503', () => res(503, 'Service Unavailable'), 'http', 'Google Maps đang trục trặc (HTTP 503)'],
    ['400 khác', () => deny(400, 'Invalid JSON payload received.'), 'http', 'Google từ chối yêu cầu (HTTP 400)'],
    ['mất mạng', () => { throw new TypeError('fetch failed', { cause: new Error(`getaddrinfo ENOTFOUND tile.googleapis.com ${KEY}`) }); }, 'network', 'Không kết nối được tới Google Maps'],
    ['200 nhưng thiếu session', () => res(200, { expiry: '1' }), 'bad_response', 'Google trả về phiên bản đồ không đọc được'],
    ['không phải JSON', () => res(200, '<html>lỗi</html>'), 'bad_response', 'Google trả về phiên bản đồ không đọc được'],
  ];
  for (const [name, reply, , want] of cases) {
    const g = mk(reply);
    await g.m.start();
    eq([g.m.cfg(), g.m.status().last_error.message], [null, want], `${name} → ${want}`);
    ok(g.logs.length === 1 && !g.logs[0].includes(KEY) && g.logs[0].includes(want), `${name}: log một dòng, không chứa khoá — ${g.logs[0]}`);
  }
  const slow = mk(hang, { timeoutMs: 30 });
  await slow.m.start();
  eq(slow.m.status().last_error.message, 'Google không trả lời kịp', 'Google treo quá thời gian chờ → không trả lời kịp');
  const noExp = mk(() => res(200, { session: 'Phien-khong-co-han' }));
  await noExp.m.start();
  eq([noExp.m.status().roadmap.expiry, noExp.pend()[0].ms], [T0 + DAY, DAY / 2], 'thiếu expiry: coi như dùng được 24 giờ, làm mới khi đã dùng nửa thời hạn');
});

await group('Dòng bản quyền theo khung nhìn: đúng yêu cầu, làm tròn khung, nhớ 30 phút, hỏi chung', async () => {
  const g = mk(google());
  eq(await g.m.attribution(VIEW), '', 'chưa có phiên → chuỗi rỗng');
  eq(g.calls.length, 0, 'chưa có phiên thì không hỏi Google');
  await g.m.start();
  eq(await g.m.attribution(VIEW), COPY, 'trả đúng chuỗi copyright của Google');
  const v = g.calls[2], u = new URL(v.url);
  eq([v.method, u.origin + u.pathname], ['GET', 'https://tile.googleapis.com/tile/v1/viewport'], 'GET /tile/v1/viewport');
  eq([...u.searchParams.keys()], ['session', 'key', 'zoom', 'north', 'south', 'east', 'west'], 'đủ các tham số bắt buộc');
  eq([u.searchParams.get('session'), u.searchParams.get('key'), u.searchParams.get('zoom')], ['S1-phien-ban-do', KEY, '14'], 'phiên của lớp đường phố, khoá, zoom');
  const box = ['north', 'south', 'east', 'west'].map((k) => +u.searchParams.get(k));
  eq(box, roundBox(14, VIEW.n, VIEW.s, VIEW.e, VIEW.w), 'khung gửi Google = khung đã làm tròn');
  ok(box[0] >= VIEW.n && box[1] <= VIEW.s && box[2] >= VIEW.e && box[3] <= VIEW.w, 'khung hỏi Google phủ hết khung đang xem');
  eq(v.headers.Referer, 'https://fo.example.com/', 'kèm Referer');
  eq(await g.m.attribution({ ...VIEW, n: VIEW.n + 0.002, s: VIEW.s + 0.002, e: VIEW.e - 0.002, w: VIEW.w + 0.002 }), COPY, 'kéo bản đồ một chút');
  eq(g.calls.length, 3, 'kéo trong cùng lưới ô → dùng lại, không hỏi Google');
  await g.m.attribution({ ...VIEW, z: 15 });
  eq(g.calls.length, 4, 'khác zoom → hỏi lại');
  await g.m.attribution({ ...VIEW, layer: 'satellite' });
  eq([g.calls.length, new URL(g.calls[4].url).searchParams.get('session')], [5, 'S2-phien-ban-do'], 'lớp vệ tinh hỏi bằng phiên vệ tinh');
  g.clock.add(29 * MIN);
  await g.m.attribution(VIEW);
  eq(g.calls.length, 5, 'sau 29 phút vẫn dùng lại');
  g.clock.add(2 * MIN);
  await g.m.attribution(VIEW);
  eq(g.calls.length, 6, 'quá 30 phút → hỏi lại');
  const [x, y] = await Promise.all([g.m.attribution({ ...VIEW, z: 10 }), g.m.attribution({ ...VIEW, z: 10 })]);
  eq([g.calls.length, x, y], [7, COPY, COPY], 'hai yêu cầu cùng khung cùng lúc → chỉ hỏi Google một lần');
  eq(g.m.status().attribution, { calls: 5, cache_hits: 3, errors: 0, cached: 4 }, 'status(): số lần hỏi, số lần dùng lại, số khung đang nhớ');
  const bad = [{ ...VIEW, layer: 'terrain' }, { ...VIEW, layer: '__proto__' }, { ...VIEW, layer: undefined }, { ...VIEW, z: 23 }, { ...VIEW, z: -1 }, { ...VIEW, z: 1.5 }, { ...VIEW, z: '14' }, { ...VIEW, n: NaN }, { ...VIEW, n: 91 }, { ...VIEW, w: -181 }, { ...VIEW, e: Infinity }, { ...VIEW, n: 10.7 }, null, undefined];
  for (const q of bad) eq(await g.m.attribution(q), '', `tham số sai → '' (${JSON.stringify(q)})`);
  eq(g.calls.length, 7, 'tham số sai thì không hỏi Google');
  const sea = mk((c, n, t) => (c.url.includes('/viewport') ? res(200, { copyright: '', maxZoomRects: [] }) : google()(c, n, t)));
  await sea.m.start();
  eq(await sea.m.attribution(VIEW), '', 'Google trả chuỗi rỗng (vùng không có dữ liệu) → chuỗi rỗng');
  sea.clock.add(10 * MIN);
  await sea.m.attribution(VIEW);
  eq([sea.calls.length, sea.m.status().attribution.errors], [3, 0], 'chuỗi rỗng hợp lệ vẫn nhớ 30 phút, không tính là lỗi');
});

await group('Dòng bản quyền: Google lỗi → chuỗi rỗng, nhớ lỗi 1 phút; tối đa 500 khung; phiên hết hạn → chuỗi rỗng', async () => {
  let mode = 'ok';
  const auto = google();
  const g = mk((c, n, t) => {
    if (!c.url.includes('/viewport') || mode === 'ok') return auto(c, n, t);
    if (mode === 'net') throw new TypeError('fetch failed', { cause: new Error(`connect ECONNRESET ${KEY}`) });
    if (mode === 'html') return res(200, '<html>');
    return res(500, { error: { code: 500, message: `Internal error for key ${KEY}`, status: 'INTERNAL' } });
  });
  await g.m.start();
  mode = '500';
  eq(await g.m.attribution(VIEW), '', 'Google lỗi 500 → chuỗi rỗng');
  eq(await g.m.attribution(VIEW), '', 'hỏi lại ngay → vẫn chuỗi rỗng');
  eq(g.calls.length, 3, 'lỗi được nhớ 1 phút: không hỏi Google dồn dập');
  g.clock.add(MIN + 1000);
  mode = 'net';
  eq(await g.m.attribution(VIEW), '', 'mất mạng → chuỗi rỗng');
  eq(g.calls.length, 4, 'quá 1 phút → hỏi lại');
  g.clock.add(MIN + 1000);
  mode = 'html';
  eq(await g.m.attribution(VIEW), '', 'trả lời không phải JSON → chuỗi rỗng');
  g.clock.add(MIN + 1000);
  mode = 'ok';
  eq(await g.m.attribution(VIEW), COPY, 'Google hết lỗi → có lại dòng bản quyền');
  eq(g.m.status().attribution.errors, 3, 'đếm số lần lỗi');
  ok(g.logs.length === 4 && g.logs.slice(1).every((x) => /dòng bản quyền/.test(x)) && !g.logs.some((x) => x.includes(KEY)), `mỗi kiểu lỗi một dòng log, đã che khoá — ${g.logs.slice(1).join(' | ')}`);
  const l = mk(google());
  await l.m.start();
  const q = (i) => ({ layer: 'roadmap', z: 16, n: 10.8 + i * 0.01, s: 10.79 + i * 0.01, e: 106.7, w: 106.69 });
  for (let i = 0; i <= 500; i++) await l.m.attribution(q(i));
  eq([l.calls.length, l.m.status().attribution.cached], [2 + 501, 500], '501 khung khác nhau: hỏi 501 lần, chỉ nhớ 500 khung');
  await l.m.attribution(q(500));
  eq(l.calls.length, 503, 'khung mới nhất vẫn còn trong bộ nhớ đệm');
  await l.m.attribution(q(0));
  eq(l.calls.length, 504, 'quá 500 khung: bỏ khung cũ nhất');
  const old = mk(google());
  await old.m.start();
  old.m.stop();
  old.clock.add(15 * DAY);
  eq([await old.m.attribution(VIEW), old.calls.length], ['', 2], 'phiên đã hết hạn → chuỗi rỗng, không hỏi Google');
});

await group('roundBox: làm tròn ra ngoài theo lưới ô của mức zoom, vắt qua kinh tuyến 180', async () => {
  const g14 = 360 / 2 ** 14;
  eq(roundBox(14, 10.8, 10.75, 106.72, 106.66), [492 * g14, 489 * g14, 4857 * g14, 4854 * g14], 'zoom 14: lưới 360/2^14 độ, làm tròn ra ngoài');
  eq(roundBox(14, 10.8, 10.75, 106.72, 106.66).map(String), ['10.810546875', '10.74462890625', '106.72119140625', '106.6552734375'], 'số gửi Google là số chính xác (không có đuôi 0.30000000000000004)');
  eq(roundBox(20, 10.8, 10.75, 106.72, 106.66), roundBox(16, 10.8, 10.75, 106.72, 106.66), 'từ zoom 16 trở lên giữ lưới của zoom 16');
  eq(roundBox(0, 10, -10, 20, -20), [85.0511, -85.0511, 180, -180], 'zoom 0: cả thế giới (vĩ độ trong giới hạn Mercator)');
  eq(roundBox(5, 10, -10, -170, 170), [11.25, -11.25, -168.75, 168.75], 'khung vắt qua kinh tuyến 180 (west > east) vẫn giữ nguyên chiều');
  eq(roundBox(1, 10, -10, 100, 101), [85.0511, -85.0511, 180, -180], 'vắt qua kinh tuyến 180 mà làm tròn xong phủ cả vòng → cả thế giới');
  eq(roundBox(3, 84.9, 80, 180, 170), [85.0511, 45, 180, 135], 'không vượt vĩ độ / kinh độ tối đa');
  const [n, s, e, w] = roundBox(12, 10.80001, 10.79999, 106.70001, 106.69999);
  ok(n > s && e > w, 'khung rất nhỏ vẫn có diện tích');
});

await group('start() / stop(): hẹn giờ thật được huỷ, không giữ tiến trình', async () => {
  const g = mk(google());
  await g.m.start();
  g.m.stop();
  eq([g.pend().length, g.m.status().next_at], [0, null], 'stop() huỷ hẹn làm mới');
  await g.m.start();
  eq([g.calls.length, g.pend().map((h) => h.ms)], [2, [DAY]], 'chạy lại: phiên còn mới thì không tạo lại, chỉ hẹn lần làm mới');
  let t = T0;
  const auto = google();
  const real = createMapTiles({ key: KEY, referer: REF, fetch: async (url, init) => auto({ url: String(url), body: JSON.parse(init.body || 'null') }, 0, t), now: () => t });
  await real.start();
  ok(real.cfg() !== null && real.status().next_at === T0 + DAY, 'hẹn giờ mặc định (setTimeout) chạy được');
  real.stop();
  eq(real.status().next_at, null, 'stop() huỷ hẹn giờ thật');
});

await group('Khoá không bao giờ xuất hiện trong log', async () => {
  ok(ALL_LOGS.length > 20, `đã gom ${ALL_LOGS.length} dòng log từ mọi bài kiểm ở trên`);
  ok(!ALL_LOGS.some((x) => x.includes(KEY) || x.includes(encodeURIComponent(KEY))), 'không dòng nào chứa khoá');
});

summary('Nền bản đồ Google chính thức');
