#!/usr/bin/env node
// Atlas Ops Hub + Rider Live — máy chủ. Phần nghiệp vụ nằm ở core/ (core/hub/ là Ops Hub); file này chỉ lo việc "ngoại vi":
// HTTP, WebSocket, cookie phiên đăng nhập, băm mật khẩu, lưu tệp ảnh, đọc file Excel nhập dữ liệu, gọi dịch vụ thời tiết, gửi Slack,
// gọi dịch vụ tính đường đi thực tế (Google Routes API hoặc OSRM; khoá API chỉ ở máy chủ), giữ phiên nền bản đồ Google chính thức (Map Tiles API).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { SCHEMA } from './core/schema.js';
import { createSqliteStore } from './core/store-sqlite.js';
import { createCore } from './core/core.js';
import { num } from './core/util.js';
import { seedDemo, createDemoDriver, DEMO_PASSWORD } from './core/demo.js';
import { seedHubDemo } from './core/hub/demo.js';
import { parseSheet } from './lib/xlsx.js';
import { createBackups } from './lib/backup.js';
import { createRouting } from './lib/routing.js';
import { createMapTiles } from './lib/maptiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const env = process.env;
const envNum = (k, d) => num(env[k]) ?? d;

// ───────────────────────── Cấu hình ─────────────────────────
const conf = {
  port: envNum('PORT', 8080),
  dataDir: env.DATA_DIR || path.join(__dirname, 'data'),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  trustProxy: env.TRUST_PROXY === '1',
  demo: env.DEMO === '1',
  // Tài khoản Quản trị đầu tiên (tạo khi chưa có Quản trị / Tech Lead nào). LEAD_USER / LEAD_PASS của bản Rider Live cũ vẫn dùng được.
  adminUser: (env.ADMIN_USER || env.LEAD_USER || 'admin').toLowerCase(),
  adminPass: env.ADMIN_PASS || env.LEAD_PASS || '',
  slackWebhook: env.SLACK_WEBHOOK_URL || '',
  backupKeep: envNum('BACKUP_KEEP', 14), backupHour: envNum('BACKUP_HOUR', 2), // BACKUP_KEEP=0: tắt sao lưu tự động
  weatherAuto: env.WEATHER_AUTO === '1',
  weatherUrl: env.WEATHER_URL || '',
  weatherLat: envNum('WEATHER_LAT', 10.7769), weatherLon: envNum('WEATHER_LON', 106.7009),
  // Đường đi thực tế cho task FO (lib/routing.js). Chỉ gửi toạ độ điểm giao nhận, không gửi GPS của FO. Khoá không bao giờ ra log hay trình duyệt.
  routing: {
    provider: env.ROUTING_PROVIDER || 'none', key: env.GOOGLE_MAPS_API_KEY || '', mode: env.ROUTING_MODE || 'TWO_WHEELER', pref: env.ROUTING_PREF || 'TRAFFIC_AWARE', trafficLines: env.ROUTING_TRAFFIC_LINES !== '0',
    dailyLimit: envNum('ROUTING_DAILY_LIMIT', 1500), timeoutMs: envNum('ROUTING_TIMEOUT_MS', 8000), osrmUrl: env.OSRM_URL || '', osrmProfile: env.OSRM_PROFILE || 'driving',
  },
  // Nền bản đồ Google chính thức (lib/maptiles.js). Khoá trình duyệt giới hạn theo tên miền của PUBLIC_URL; trống = dùng TILE_URL như cũ.
  tilesKey: env.GOOGLE_MAPS_TILES_KEY || '',
};
const coreCfg = {
  tzOffsetMin: envNum('TZ_OFFSET_MIN', 420),
  staleSec: envNum('STALE_SEC', 45), offlineSec: envNum('OFFLINE_SEC', 600),
  maxAccuracyM: envNum('MAX_ACCURACY_M', 150), maxSpeedKmh: envNum('MAX_SPEED_KMH', 160), trailMinutes: envNum('TRAIL_MINUTES', 30),
  retentionDays: envNum('RETENTION_DAYS', 30), photoRetentionDays: envNum('PHOTO_RETENTION_DAYS', 180), sessionDays: envNum('SESSION_DAYS', 30), routeRetentionDays: envNum('ROUTE_RETENTION_DAYS', 30),
  tileUrl: env.TILE_URL ?? 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
  tileAttribution: env.TILE_ATTRIBUTION ?? '© Google Maps',
  demo: conf.demo,
  note: conf.demo ? 'Chế độ mô phỏng (DEMO=1): FO trên bản đồ là dữ liệu giả, chạy đường thẳng giữa các điểm.' : '',
  // SLA theo đường thật: targetPct = % chuyến nhắm kịp hạn; sigmaLeg / sigmaDay = độ dao động thời gian đi; bufferBase / bufferFloor = dự phòng (phút).
  sla: {
    speedKmh: envNum('SLA_SPEED_KMH', 22), roadFactor: envNum('SLA_ROAD_FACTOR', 1.35), stopMin: envNum('SLA_STOP_MIN', 6), bufferMin: envNum('SLA_BUFFER_MIN', 10), calibrate: env.SLA_CALIBRATE !== '0',
    targetPct: envNum('SLA_TARGET_PCT', 85), sigmaLeg: envNum('SLA_SIGMA_LEG', 0.3), sigmaDay: envNum('SLA_SIGMA_DAY', 0.12), bufferBase: envNum('SLA_BUFFER_BASE', 3), bufferFloor: envNum('SLA_BUFFER_FLOOR', 5),
  },
  arriveRadiusM: envNum('ARRIVE_RADIUS_M', 120), farProofM: envNum('FAR_PROOF_M', 400), lostAlertSec: envNum('LOST_ALERT_SEC', 180), boRemindMin: envNum('BO_REMIND_MIN', 5), boConfirm: env.BO_CONFIRM !== '0', boLinkHours: envNum('BO_LINK_HOURS', 48),
  company: env.COMPANY_NAME || 'Atlas Capture Việt Nam', contact: env.PRIVACY_CONTACT || '',
};

fs.mkdirSync(path.join(conf.dataDir, 'photos'), { recursive: true });

// ───────────────────────── Phụ trợ cho lõi ─────────────────────────
const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64url')}$${(await scrypt(pw, salt)).toString('base64url')}`;
}
const DUMMY_SALT = crypto.randomBytes(16);
async function verifyPassword(pw, hash) {
  const m = /^scrypt\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(hash || '');
  if (!m) { await scrypt(pw, DUMMY_SALT); return false; } // vẫn tốn thời gian như thật để không lộ tài khoản nào tồn tại
  const want = Buffer.from(m[2], 'base64url'), got = await scrypt(pw, Buffer.from(m[1], 'base64url'));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const photoPath = (id, mime, ts) => path.join(conf.dataDir, 'photos', new Date(ts).toISOString().slice(0, 7), `${id}.${EXT[mime] || 'bin'}`);
const files = {
  put(id, bytes, mime, ts) {
    const f = photoPath(id, mime, ts);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, bytes, { mode: 0o600 });
  },
  remove(id, mime, ts) { fs.rmSync(photoPath(id, mime, ts), { force: true }); },
};
function notify(text) {
  if (!conf.slackWebhook) return;
  fetch(conf.slackWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `:rotating_light: ${text}` }), signal: AbortSignal.timeout(8000) })
    .then((r) => { if (!r.ok) console.error('[slack] HTTP', r.status); })
    .catch((e) => console.error('[slack]', e.message));
}
async function fetchWeather() {
  const url = conf.weatherUrl || `https://api.open-meteo.com/v1/forecast?latitude=${conf.weatherLat}&longitude=${conf.weatherLon}&current=precipitation,weather_code`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const c = j && j.current;
  if (!c || typeof c !== 'object') throw new Error('thiếu trường current');
  return { precip: c.precipitation, code: c.weather_code, intervalSec: c.interval };
}

const store = createSqliteStore(SCHEMA, path.join(conf.dataDir, 'atlas.db'));
const backups = conf.backupKeep > 0 ? createBackups({
  store, dir: path.join(conf.dataDir, 'backups'), keep: conf.backupKeep, hour: conf.backupHour, tzOffsetMin: coreCfg.tzOffsetMin,
  onError: (e) => { console.error('[backup] Sao lưu thất bại:', e.message); notify(`Sao lưu dữ liệu hằng ngày thất bại: ${e.message}. Kiểm tra dung lượng đĩa của máy chủ.`); },
}) : null;
const deps = {
  store, cfg: coreCfg, hashPassword, verifyPassword, files, notify, parseSheet,
  token: (n) => crypto.randomBytes(n).toString('base64url'),
  sha: (s) => crypto.createHash('sha256').update(s).digest('hex'),
};
let fakeNow = null; // DEMO=1: đồng hồ giả chỉ dùng lúc tạo lịch sử mẫu cho Ops Hub (tua lại vài tuần), xong thì về giờ thật
if (conf.demo) deps.now = () => fakeNow ?? Date.now();
if (conf.weatherAuto || conf.weatherUrl) deps.fetchWeather = fetchWeather;
// Đường đi thực tế: chỉ gắn deps.route khi đã cấu hình đúng; cấu hình sai thì cảnh báo rồi chạy như cũ (SLA ước tính đường chim bay).
// Chế độ mô phỏng không gọi dịch vụ ngoài: dữ liệu mẫu tạo hàng trăm task (cả lịch sử tua lại nhiều tuần) sẽ đốt hết lượt gọi.
const routing = conf.demo ? null : createRouting({ ...conf.routing, tzOffsetMin: coreCfg.tzOffsetMin, log: (m) => console.warn('[route] ' + m) });
if (routing) {
  deps.route = routing.route;
  if (routing.info().provider === 'google') {
    // Điều khoản Google Maps Platform (mục Routes API): chỉ lưu tạm toạ độ tối đa 30 ngày, không dùng cùng bản đồ không phải của Google.
    if (!(coreCfg.routeRetentionDays > 0 && coreCfg.routeRetentionDays <= 30)) { console.warn('[route] Điều khoản Google chỉ cho lưu tạm đường đi tối đa 30 ngày: ROUTE_RETENTION_DAYS được đặt về 30.'); coreCfg.routeRetentionDays = 30; }
    if (coreCfg.tileUrl && !/google/i.test(coreCfg.tileUrl)) console.warn('[route] TILE_URL không phải bản đồ Google: điều khoản Google cấm vẽ đường đi lấy từ Routes API lên bản đồ khác. Dùng lại bản đồ Google hoặc chuyển ROUTING_PROVIDER=osrm.');
  }
}
console.log(`[route] Đường đi thực tế: ${routing ? routing.info().text : `tắt${conf.demo ? ' trong chế độ mô phỏng (DEMO=1)' : ''} — SLA ước tính theo đường chim bay`}.`);
coreCfg.routingProvider = routing ? routing.info().provider : null; // trình duyệt: đường của Google chỉ vẽ trên bản đồ Google (bỏ lớp OpenStreetMap)
const core = createCore(deps);
// Nền bản đồ Google chính thức: máy chủ tạo và làm mới phiên Map Tiles, đưa mẫu địa chỉ ô bản đồ vào cfg.mapTiles; trình duyệt tự tải ô
// từ Google và hỏi dòng bản quyền qua /map-attribution. Chế độ mô phỏng không gọi dịch vụ ngoài.
const tiles = conf.demo ? null : createMapTiles({ key: conf.tilesKey, referer: conf.publicUrl, log: (m) => console.warn('[map] ' + m), onChange: (c) => { core.cfg.mapTiles = c; } });
if (!conf.demo && !tiles && routing && routing.info().provider === 'google') console.warn('[map] Đang dùng đường đi của Google nhưng chưa có nền bản đồ Google chính thức (GOOGLE_MAPS_TILES_KEY): điều khoản Google yêu cầu vẽ đường Google trên bản đồ Google, và địa chỉ mt1.google.com không có giấy phép.');

// ───────────────────────── Tài khoản đầu tiên ─────────────────────────
async function bootstrap() {
  if (conf.demo) {
    const made = await seedDemo(core);
    if (!made) return;
    let hub = null;
    try { hub = await seedHubDemo(core, { setNow: (t) => { fakeNow = t; } }); } catch (e) { console.error('[demo] Không tạo được lịch sử Ops Hub:', e); }
    fakeNow = null;
    if (hub) console.log(`[demo] Đã tạo lịch sử Ops Hub ${hub.days} ngày (${hub.from} → ${hub.to}) trong ${(hub.ms / 1000).toFixed(1)} giây.`);
    console.log(`[demo] Đã tạo dữ liệu mẫu. Đăng nhập thử (mật khẩu chung: ${DEMO_PASSWORD}): admin; Tech: techlead, tech, tech2, tech3; Logistics: lead, log, log2, log3; FO: fo (tự thao tác), fo1–fo7 (mô phỏng); Sale: salehead, sale, sale2, sale3`);
    return;
  }
  if (store.users.count({ role: ['admin', 'tech_lead'], active: 1 })) return;
  let pw;
  try {
    pw = (await core.createUser({ username: conf.adminUser, name: 'Quản trị', role: 'admin', password: conf.adminPass || undefined, must_change: true }, null)).tempPassword;
  } catch (e) {
    console.error(`[auth] Không tạo được tài khoản Quản trị đầu tiên (${e.msg || e.message}). Kiểm tra ADMIN_USER / ADMIN_PASS.`);
    process.exit(1);
  }
  const f = path.join(conf.dataDir, 'first-login.txt');
  if (!conf.adminPass) fs.writeFileSync(f, `Tên đăng nhập: ${conf.adminUser}\nMật khẩu tạm: ${pw}\n(Hệ thống bắt đổi mật khẩu ở lần đăng nhập đầu. Xoá file này sau khi đã đăng nhập.)\n`, { mode: 0o600 });
  console.log(`[auth] Đã tạo tài khoản Quản trị đầu tiên: ${conf.adminUser}${conf.adminPass ? ' (mật khẩu lấy từ ADMIN_PASS)' : ` / mật khẩu tạm: ${pw}  (cũng lưu ở ${f})`}`);
}

// ───────────────────────── HTTP ─────────────────────────
class HttpError extends Error { constructor(status, code) { super(code); this.status = status; } }
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=()',
};
const CSP = "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon' };

function json(res, status, obj, extra) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { ...SEC_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(s), ...(extra || {}) });
  res.end(s);
}
function text(res, status, s, extra) {
  res.writeHead(status, { ...SEC_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...(extra || {}) });
  res.end(s);
}
function rawBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false;
    const chunks = [];
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; reject(new HttpError(413, 'too_large')); } else chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}
function sendFile(req, res, rel) {
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return text(res, 404, 'Not found');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return text(res, 404, 'Not found');
    const ext = path.extname(file);
    const headers = { ...SEC_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': rel.startsWith('vendor/') ? 'public, max-age=604800' : 'no-cache' };
    if (ext === '.html') headers['Content-Security-Policy'] = CSP;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

// Sau proxy ngược: lấy địa chỉ CUỐI trong X-Forwarded-For (do chính proxy của mình ghi thêm); các địa chỉ phía trước người gửi tự khai được nên không tin.
const clientIp = (req) => (conf.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress || '';
const isHttps = (req) => (conf.publicUrl ? conf.publicUrl.startsWith('https:') : (conf.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') || !!req.socket.encrypted);
function sidOf(req) {
  const m = /(?:^|;\s*)arl_sid=([A-Za-z0-9_-]{20,200})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
const cookie = (req, value, maxAge, name = 'arl_sid') => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
/** Mã thiết bị của BO (cookie arl_bl): link xác nhận chỉ dùng được trên thiết bị đầu tiên mở nó. */
function devOf(req) {
  const m = /(?:^|;\s*)arl_bl=([A-Za-z0-9_-]{20,80})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
/** Chặn trang web lạ mượn cookie của người dùng để gọi API: yêu cầu ghi dữ liệu phải đến từ chính trang này. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // công cụ dòng lệnh, app không phải trình duyệt
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  if (host === req.headers.host) return true;
  if (conf.publicUrl) { try { return new URL(conf.publicUrl).host === host; } catch { return false; } }
  return false;
}

// Yêu cầu có ảnh hoặc file: giới hạn 18 MB; còn lại 256 KB.
const BIG_BODY = /^\/api\/(stops\/\d+\/(proof|fail)|bo-link\/confirm|hub\/cards\/records|hub\/incidents|hub\/import\/parse|hub\/jobs\/\d+\/done)$/;
async function api(req, res, url) {
  const method = req.method, p = url.pathname;
  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) return json(res, 403, { error: 'bad_origin', message: 'Yêu cầu đến từ trang không hợp lệ.' });
  let body = {};
  if (method !== 'GET' && method !== 'HEAD') {
    const raw = await rawBody(req, BIG_BODY.test(p) ? 18 * 1024 * 1024 : 256 * 1024);
    if (raw) {
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res, 415, { error: 'json_only', message: 'Nội dung gửi lên phải là JSON.' });
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad_json', message: 'Dữ liệu gửi lên không đọc được.' }); }
    }
  }
  const token = sidOf(req);
  const ctx = { user: core.authToken(token), token, ip: clientIp(req), ua: req.headers['user-agent'] || '', dev: devOf(req) };
  const out = await core.api(ctx, method === 'HEAD' ? 'GET' : method, p, Object.fromEntries(url.searchParams), body);
  const b = out.body || {};
  if (b.__photo) {
    const f = photoPath(b.__photo.id, b.__photo.mime, b.__photo.ts);
    return fs.stat(f, (err, st) => {
      if (err || !st.isFile()) return json(res, 404, { error: 'not_found', message: 'Ảnh đã bị xoá khỏi máy chủ.' });
      res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': b.__photo.mime, 'Content-Length': st.size, 'Cache-Control': 'private, max-age=86400', 'Content-Disposition': 'inline' });
      if (method === 'HEAD') return res.end();
      fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
    });
  }
  if (b.__csv) {
    return text(res, 200, b.__csv.text, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${b.__csv.name.replace(/[^\w.-]/g, '_')}"` });
  }
  const extra = {};
  if (b.__session) { extra['Set-Cookie'] = cookie(req, b.__session, core.cfg.sessionDays * 86400); delete b.__session; }
  if (b.__clearSession) { extra['Set-Cookie'] = cookie(req, 'x', 0); delete b.__clearSession; }
  if (b.__dev) { extra['Set-Cookie'] = cookie(req, b.__dev, 180 * 86400, 'arl_bl'); delete b.__dev; }
  return json(res, out.status, b, extra);
}

// Giao thức OsmAnd: cho app Traccar Client (Android/iOS) gửi vị trí khi chạy nền. "Mã thiết bị" trong app = mã thiết bị của FO.
const devFails = new Map();
function parseTs(v) {
  if (v === undefined || v === null || v === '') return null;
  if (/^\d+(\.\d+)?$/.test(String(v))) return +v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
async function osmand(req, res, url) {
  const ip = clientIp(req), f = devFails.get(ip);
  if (f && f.n >= 30 && Date.now() < f.until) return text(res, 429, 'too many attempts');
  const qs = Object.fromEntries(url.searchParams);
  let id, pt;
  if (req.method === 'POST') {
    const raw = await rawBody(req, 64 * 1024);
    if (String(req.headers['content-type'] || '').includes('json')) {
      let j;
      try { j = JSON.parse(raw || '{}'); } catch { return text(res, 400, 'bad json'); }
      const loc = (j && j.location) || {}, c = loc.coords || {};
      id = j && j.device_id;
      pt = { ts: parseTs(loc.timestamp), lat: c.latitude, lon: c.longitude, acc: c.accuracy, spd: c.speed, hdg: c.heading, bat: loc.battery && loc.battery.level };
    } else if (raw) Object.assign(qs, Object.fromEntries(new URLSearchParams(raw)));
  } else if (req.method !== 'GET') return text(res, 405, 'method not allowed');
  if (!pt) {
    id = qs.id ?? qs.deviceid;
    let { lat, lon } = qs;
    if (qs.location) [lat, lon] = String(qs.location).split(',');
    const knots = num(qs.speed), batt = num(qs.batt);
    pt = { ts: parseTs(qs.timestamp), lat, lon, acc: qs.accuracy, spd: knots === null ? null : knots * 0.514444, hdg: qs.bearing ?? qs.heading, bat: batt === null ? null : batt / 100 };
  }
  const r = core.ingestDevice(String(id ?? ''), pt);
  if (r === 'unknown_device') {
    const now = Date.now(), cur = devFails.get(ip);
    if (!cur || now > cur.until) devFails.set(ip, { n: 1, until: now + 600000 }); else cur.n++;
    return text(res, 400, 'unknown device');
  }
  return text(res, r === 'not_allowed' ? 403 : r === 'bad_coord' || r === 'bad_point' ? 400 : 200, r);
}

// Dòng bản quyền Google theo khung nhìn (Google bắt buộc hiện trên bản đồ; trình duyệt hỏi sau mỗi lần kéo / thu phóng, máy chủ nhớ 30 phút
// theo khung đã làm tròn). Công khai vì trang BO không đăng nhập cũng cần; giới hạn 120 lượt / phút / IP.
const attrHits = new Map();
async function mapAttribution(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'method not allowed');
  if (!tiles) return json(res, 200, { copyright: '' });
  const ip = clientIp(req), t = Date.now(), h = attrHits.get(ip);
  if (h && t < h.until) { if (++h.n > 120) return json(res, 429, { copyright: '' }); } else attrHits.set(ip, { n: 1, until: t + 60000 });
  const q = Object.fromEntries(url.searchParams);
  const copyright = await tiles.attribution({ layer: q.layer, z: num(q.z), n: num(q.n), s: num(q.s), e: num(q.e), w: num(q.w) });
  return json(res, 200, { copyright }, { 'Cache-Control': 'private, max-age=600' });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/healthz') return json(res, 200, { ok: true, ...core.health(), uptimeSec: Math.round(process.uptime()), backup: backups ? backups.status() : null, routing: routing ? routing.stats() : null, tiles: tiles ? tiles.status() : null });
  if (p === '/map-attribution') return mapAttribution(req, res, url);
  if (p === '/osmand' || p === '/osmand/') return osmand(req, res, url);
  if (p.startsWith('/api/')) return api(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'method not allowed');
  if (p === '/') return sendFile(req, res, 'index.html');
  let rel;
  try { rel = decodeURIComponent(p.slice(1)); } catch { return text(res, 400, 'bad path'); }
  return sendFile(req, res, rel);
}
const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (res.headersSent) return res.destroy();
    if (e instanceof HttpError) return json(res, e.status, { error: e.message, message: e.status === 413 ? 'Dữ liệu gửi lên quá lớn.' : 'Yêu cầu không hợp lệ.' }, { Connection: 'close' });
    console.error('[http]', e);
    json(res, 500, { error: 'server_error', message: 'Máy chủ gặp lỗi. Thử lại sau ít phút.' });
  });
});

// ───────────────────────── WebSocket ─────────────────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const deny = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  if (new URL(req.url, 'http://x').pathname !== '/ws') return deny(404, 'Not Found');
  if (!sameOrigin(req)) return deny(403, 'Forbidden');
  const user = core.authToken(sidOf(req));
  if (!user) return deny(401, 'Unauthorized');
  // Cùng chốt chặn với HTTP: chưa đổi mật khẩu tạm hoặc FO chưa đồng ý điều khoản thì không nhận dữ liệu (kể cả bản đồ FO).
  if (user.must_change || core.needConsent(user)) return deny(403, 'Forbidden');
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, user));
});
wss.on('connection', (ws, req, user) => {
  const send = (o) => { if (ws.readyState === 1 && ws.bufferedAmount < 1000000) ws.send(JSON.stringify(o)); }; // máy xem mạng yếu bị dồn hàng thì bỏ nhịp này
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
  const unsub = core.subscribe(user, send, () => ws.close(4001, 'kick'));
  ws.on('close', unsub);
  const l = core.live.get(user.id);
  // uid: trình duyệt đối chiếu với tài khoản đang hiển thị (đăng nhập tài khoản khác ở tab khác thì cookie đã đổi → tab cũ tự mở lại đúng màn hình).
  send({ t: 'hello', now: Date.now(), uid: user.id, role: user.role, onShift: !!(l && l.onShift) });
  if (['admin', 'lead', 'logistic'].includes(user.role)) send(core.snapshot()); // bản đồ FO: chỉ Logistics và Quản trị

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'ping') return send({ t: 'pong', now: Date.now() });
    if (user.role !== 'fo') { // màn hình FO đang chạy bằng phiên của vai khác: từ chối rõ để màn hình tự mở lại (không im lặng kẻo FO tưởng vẫn đang gửi vị trí)
      if (m.t === 'loc') return send({ t: 'ack', seq: m.seq, ok: 0, drop: Array.isArray(m.pts) ? m.pts.length : 0, denied: true, why: 'role' });
      if (m.t === 'shift') return send({ t: 'shift', on: false, denied: true, why: 'role' });
      return;
    }
    const u = store.users.get(user.id); // đọc lại: quyền có thể vừa đổi (rút đồng ý, bị khoá)
    const allowed = core.canTrack(u);
    try {
      if (m.t === 'loc' && Array.isArray(m.pts)) {
        if (!allowed) return send({ t: 'ack', seq: m.seq, ok: 0, drop: m.pts.length, denied: true });
        send({ t: 'ack', seq: m.seq, ...core.ingestMany(u.id, m.pts) });
      } else if (m.t === 'shift') {
        if (!allowed) return send({ t: 'shift', on: false, denied: true });
        send({ t: 'shift', on: core.setShift(u, !!m.on).onShift });
      }
    } catch (e) { console.error('[ws]', e); }
  });
});

// ───────────────────────── Nhịp định kỳ ─────────────────────────
const timers = [];
const every = (ms, fn) => timers.push(setInterval(() => { try { const r = fn(); if (r && r.catch) r.catch((e) => console.error('[timer]', e)); } catch (e) { console.error('[timer]', e); } }, ms));
every(1000, () => core.flushPositions());
every(15000, () => core.tick());
every(25000, () => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }); // dọn kết nối chết
every(60000, () => { const now = Date.now(); for (const [ip, f] of devFails) if (now > f.until) devFails.delete(ip); for (const [ip, h] of attrHits) if (now > h.until) attrHits.delete(ip); });
every(6 * 3600000, () => { const r = core.maintenance(); if (r.positions || r.photos) console.log(`[db] Dọn dữ liệu hết hạn: ${r.positions} điểm vị trí, ${r.photos} ảnh`); });
if (deps.fetchWeather) every(10 * 60000, () => core.refreshWeather());
const backupNow = () => { const r = backups.maybeRun(); if (r && r.file) console.log(`[backup] Đã sao lưu ${r.file} (${(r.bytes / 1048576).toFixed(1)} MB, ${r.ms} ms), giữ ${r.kept} bản.`); };
if (backups) every(10 * 60000, backupNow);

// ───────────────────────── Khởi động ─────────────────────────
await bootstrap();
if (tiles) await tiles.start(); // tạo phiên nền bản đồ trước khi mở cổng (chờ tối đa 8 giây; lỗi thì tự thử lại, bản đồ tạm dùng TILE_URL)
core.maintenance();
if (backups) backupNow();
core.tick();
if (deps.fetchWeather) core.refreshWeather().catch(() => {});
if (conf.demo) {
  const driver = createDemoDriver(core);
  every(2000, () => driver.step(Date.now()));
}
server.listen(conf.port, () => {
  const h = core.health();
  console.log(`[http] Atlas Ops Hub + Rider Live chạy ở cổng ${conf.port} — ${h.fo} FO — mở http://localhost:${conf.port}/`);
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('[sys] Đang tắt…');
  timers.forEach(clearInterval);
  if (tiles) tiles.stop();
  for (const ws of wss.clients) ws.close(1001, 'server_shutdown');
  const done = () => { try { core.shutdown(); store.close(); } catch (e) { console.error(e); } process.exit(0); };
  server.close(done);
  setTimeout(done, 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
