// core.js — lõi nghiệp vụ Atlas Rider Live. Không phụ thuộc Node: cùng một mã chạy trên máy chủ (kho SQLite)
// và trong bản xem thử trên trình duyệt (kho bộ nhớ). Mọi thứ bên ngoài (đồng hồ, băm mật khẩu, lưu ảnh,
// gọi dịch vụ thời tiết, gửi Slack) được truyền vào qua `deps`.
import { distM, bearingDeg, num, int, cleanStr, cleanText, validCoord, localDate, dayStart, minuteOfDay, weekday, isDate } from './util.js';
import { defaultTerms } from './terms.js';
import { installTasks } from './tasks.js';
import { installHub } from './hub/index.js';

export class ApiError extends Error {
  constructor(status, code, msg, data) { super(code); this.status = status; this.code = code; this.msg = msg || ''; this.data = data || null; }
}
/** Báo lỗi cho người gọi. data: thông tin thêm gửi kèm (ví dụ bản ghi đã có để màn hình mở thẳng tới). */
export function fail(status, code, msg, data) { throw new ApiError(status, code, msg, data); }

// ───────── Vai trò ─────────
// Ba team: Logistics (Logistic Lead, Logistic Executive, FO), Tech (Tech Lead, Tech Executive), Sale (Head of Sale, Sale Lead).
// BO không có tài khoản: xác nhận giao nhận qua link dùng một lần.
export const ROLES = ['admin', 'tech_lead', 'tech', 'lead', 'logistic', 'fo', 'sale_head', 'sale'];
export const ROLE_LABEL = { admin: 'Quản trị', tech_lead: 'Tech Lead', tech: 'Tech Executive', lead: 'Logistic Lead', logistic: 'Logistic Executive', fo: 'FO', sale_head: 'Head of Sale', sale: 'Sale Lead' };
export const TEAM_OF = { admin: 'admin', tech_lead: 'tech', tech: 'tech', lead: 'logistics', logistic: 'logistics', fo: 'logistics', sale_head: 'sale', sale: 'sale' };
/** Điều phối Rider Live (bản đồ trực tiếp, chuyến FO, điểm giao nhận). Vị trí FO là dữ liệu cá nhân nên chỉ nhóm này xem. */
export const OPS = ['admin', 'lead', 'logistic'];
/** Ai tạo và sửa được tài khoản vai nào. Quản trị và Tech Lead (chủ hệ thống) quản lý mọi vai; Lead mỗi team quản lý thành viên team mình. */
export const CAN_MANAGE = { admin: ROLES, tech_lead: ROLES, lead: ['logistic', 'fo'], sale_head: ['sale'] };
const MANAGERS = Object.keys(CAN_MANAGE);
export const PALETTE = ['#1456C8', '#C2410C', '#0F8A5F', '#8B2FC9', '#B4236B', '#0E7490', '#8F5E00', '#4338CA', '#BE123C', '#3F7D20', '#6D28D9', '#0369A1'];
export const WEATHER = { clear: { label: 'Trời tạnh', f: 1 }, rain: { label: 'Mưa', f: 1.2 }, heavy: { label: 'Mưa to', f: 1.4 }, storm: { label: 'Giông bão', f: 1.6 } };
export const TRAFFIC = { normal: { label: 'Bình thường', f: 1 }, peak: { label: 'Giờ cao điểm', f: 1.25 }, jam: { label: 'Kẹt xe nặng', f: 1.5 } };
const USERNAME_RE = /^[a-z0-9][a-z0-9._@-]{1,39}$/;
const SITE_TYPES = ['bo', 'office', 'other'];

export const DEFAULT_CFG = {
  tzOffsetMin: 420, // Việt Nam UTC+7
  staleSec: 45, offlineSec: 600, maxAccuracyM: 150, maxSpeedKmh: 160, trailMinutes: 30,
  retentionDays: 30, photoRetentionDays: 180, sessionDays: 30,
  routeRetentionDays: 30, // giữ đường đi thực tế của task đã kết thúc bao nhiêu ngày (0 = giữ mãi); điều khoản Google giới hạn thời gian lưu
  tileUrl: 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', tileAttribution: '© Google Maps',
  demo: false, note: '',
  // speedKmh, roadFactor, stopMin, bufferMin: SLA ước tính đường chim bay. calibrate: hiệu chỉnh thời gian dừng / thời gian đi / hệ số dự phòng theo lịch sử 30 ngày.
  // SLA theo đường thực tế: targetPct = % chuyến kịp hạn nhắm tới; sigmaLeg, sigmaDay = độ lệch thời gian đi từng chặng / cả ngày;
  // dự phòng = max(bufferFloor, bufferBase + γ × độ bất định). routeBufferPct: không còn dùng (giữ để cấu hình cũ không lỗi).
  sla: { speedKmh: 22, roadFactor: 1.35, stopMin: 6, bufferMin: 10, routeBufferPct: 10, calibrate: true, targetPct: 85, sigmaLeg: 0.3, sigmaDay: 0.12, bufferBase: 3, bufferFloor: 5 },
  arriveRadiusM: 120, farProofM: 400, lostAlertSec: 180, riskMin: 10, noStartMin: 10,
  boConfirm: true, boRemindMin: 5, boLinkHours: 48, // BO phải xác nhận thì FO mới đi tiếp; chậm quá boRemindMin phút → báo Logistic; link sống tối đa boLinkHours giờ
  maxPhotos: 4, maxPhotoBytes: 3000000,
  company: 'Atlas Capture Việt Nam', contact: '',
};

export function createCore(deps) {
  const store = deps.store;
  const cfg = { ...DEFAULT_CFG, ...(deps.cfg || {}), sla: { ...DEFAULT_CFG.sla, ...((deps.cfg || {}).sla || {}) } };
  const now = deps.now || (() => Date.now());
  const off = cfg.tzOffsetMin;
  const today = () => localDate(now(), off);
  const isOps = (role) => OPS.includes(role);

  // ───────────────────────── Kênh thời gian thực ─────────────────────────
  const subs = new Set();
  /** Đăng ký nhận thông điệp cho một người dùng đang mở ứng dụng. Trả về hàm huỷ đăng ký. */
  function subscribe(user, send, close) {
    const s = { uid: user.id, sid: user._sid || null, role: user.role, site_id: user.site_id, send, close }; // sid: phiên đăng nhập mở kênh này (để ngắt riêng các phiên khác)
    subs.add(s);
    return () => subs.delete(s);
  }
  const safeSend = (s, m) => { try { s.send(m); } catch { /* người nhận đã rời đi */ } };
  const toOps = (m) => { for (const s of subs) if (isOps(s.role)) safeSend(s, m); };
  const toUser = (uid, m) => { for (const s of subs) if (s.uid === uid) safeSend(s, m); };
  const toRoles = (roles, m) => { for (const s of subs) if (roles.includes(s.role)) safeSend(s, m); };
  /** Ngắt kênh thời gian thực của một người (exceptSid: giữ lại kênh của phiên này, ví dụ thiết bị vừa đổi mật khẩu). */
  function kick(uid, reason, exceptSid) {
    for (const s of [...subs]) if (s.uid === uid && !(exceptSid && s.sid === exceptSid)) { safeSend(s, { t: 'kick', reason }); subs.delete(s); if (s.close) { try { s.close(); } catch { /* đã đóng */ } } }
  }

  // ───────────────────────── Cài đặt ─────────────────────────
  const settingCache = new Map();
  function getSetting(key) {
    if (store.noteRead) store.noteRead('settings', key); // số liệu tổng hợp đã nhớ (hub/index.js memo) phụ thuộc cài đặt này
    if (!settingCache.has(key)) { const r = store.settings.get(key); settingCache.set(key, r ? r.value : null); }
    return settingCache.get(key);
  }
  function setSetting(key, value) {
    if (store.settings.get(key)) store.settings.update(key, { value }); else store.settings.insert({ id: key, value });
    settingCache.set(key, value);
    // Giao dịch hoàn tác thì bỏ giá trị đã nhớ, lần đọc sau lấy lại từ kho (không để số thứ tự mã nhảy cóc).
    store.onRollback(() => settingCache.delete(key));
  }
  const terms = () => getSetting('terms') || defaultTerms(cfg);
  const needConsent = (u) => u.role === 'fo' && u.consent_version !== terms().version;

  // ───────────────────────── Sự kiện / cảnh báo ─────────────────────────
  function event(type, level, text, o = {}) {
    const ev = { ts: now(), type, level, text, task_id: o.task_id ?? null, stop_id: o.stop_id ?? null, fo_id: o.fo_id ?? null, actor_id: o.actor_id ?? null, data: o.data ?? null, ack_by: null, ack_at: null };
    ev.id = store.events.insert(ev);
    // Cảnh báo chỉ đẩy đi sau khi giao dịch ghi xong; giao dịch hoàn tác thì không ai nhận cảnh báo ma.
    if (level !== 'info') store.afterCommit(() => {
      toOps({ t: 'alert', ev });
      if (level === 'alert' && deps.notify) { try { deps.notify(text); } catch { /* kênh báo ngoài lỗi thì bỏ qua */ } }
    });
    return ev;
  }

  // ───────────────────────── Người dùng ─────────────────────────
  const publicUser = (u) => ({
    id: u.id, username: u.username, name: u.name, phone: u.phone || '', email: u.email || '', lang: u.lang || 'vi', role: u.role, team: TEAM_OF[u.role] || '', site_id: u.site_id, active: !!u.active, color: u.color || null, vehicle: u.vehicle || '',
    must_change: !!u.must_change, consent_ok: u.role === 'fo' ? !needConsent(u) : null, consent_at: u.consent_at, created_at: u.created_at,
  });
  const foView = (u) => {
    const l = live.get(u.id);
    return { id: u.id, name: u.name, phone: u.phone || '', vehicle: u.vehicle || '', color: u.color || PALETTE[0], onShift: !!(l && l.onShift), last: l ? l.last : null, consent_ok: !needConsent(u) };
  };
  const activeFos = () => store.users.find({ role: 'fo', active: 1 }, { order: 'name' });
  function tempPassword() {
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const raw = deps.token(24);
    let out = '';
    for (let i = 0; i < raw.length && out.length < 10; i++) out += abc[raw.charCodeAt(i) % abc.length];
    return out.padEnd(10, '7');
  }
  function checkPassword(pw, username) {
    if (typeof pw !== 'string' || pw.length < 8) fail(400, 'weak_password', 'Mật khẩu cần ít nhất 8 ký tự.');
    if (pw.length > 128) fail(400, 'weak_password', 'Mật khẩu dài tối đa 128 ký tự.');
    if (pw.toLowerCase() === String(username).toLowerCase()) fail(400, 'weak_password', 'Mật khẩu không được trùng tên đăng nhập.');
  }
  function killSessions(uid, exceptSid) {
    for (const s of store.sessions.find({ user_id: uid })) if (s.id !== exceptSid) store.sessions.remove(s.id);
  }
  const topCount = () => store.users.count({ role: ['admin', 'tech_lead'], active: 1 });
  const canManage = (actor, target) => !!actor && (CAN_MANAGE[actor.role] || []).includes(target.role);

  async function createUser(b, actor) {
    const name = cleanStr(b.name, 60), username = cleanStr(b.username, 60).toLowerCase(), role = b.role;
    if (!name) fail(400, 'bad_name', 'Cần nhập họ tên.');
    if (!USERNAME_RE.test(username)) fail(400, 'bad_username', 'Tên đăng nhập dài 2–40 ký tự, chỉ gồm chữ thường không dấu, số và . _ - @');
    if (!ROLES.includes(role)) fail(400, 'bad_role', 'Vai trò không hợp lệ.');
    if (actor && !(CAN_MANAGE[actor.role] || []).includes(role)) fail(403, 'forbidden', `Tài khoản của bạn không tạo được tài khoản ${ROLE_LABEL[role]}.`);
    if (store.users.count({ username })) fail(409, 'username_taken', 'Tên đăng nhập này đã có người dùng.');
    const site_id = null;
    const pw = typeof b.password === 'string' && b.password ? b.password : tempPassword();
    checkPassword(pw, username);
    const row = {
      username, name, phone: cleanStr(b.phone, 20), email: cleanStr(b.email, 120).toLowerCase(), lang: b.lang === 'en' ? 'en' : 'vi', role, site_id, pass_hash: await deps.hashPassword(pw), must_change: b.must_change === false ? 0 : 1, active: 1,
      color: role === 'fo' ? PALETTE[store.users.count({ role: 'fo' }) % PALETTE.length] : null, vehicle: role === 'fo' ? cleanStr(b.vehicle, 30) : '',
      device_token: role === 'fo' ? deps.token(18) : null, consent_version: null, consent_at: null, created_at: now(), demo: b.demo ? 1 : 0,
    };
    if (store.users.count({ username })) fail(409, 'username_taken', 'Tên đăng nhập này đã có người dùng.'); // kiểm tra lại sau bước băm mật khẩu (bất đồng bộ)
    row.id = store.users.insert(row);
    if (role === 'fo') { ensureLive(row.id); toOps({ t: 'fo', op: 'upsert', fo: { ...foView(row), trail: [] } }); }
    if (actor) event('user_created', 'info', `${actor.name} tạo tài khoản ${ROLE_LABEL[role]} cho ${name}.`, { actor_id: actor.id });
    return { user: publicUser(row), tempPassword: pw };
  }

  function updateUser(id, b, actor) {
    const u = store.users.get(id);
    if (!u) fail(404, 'not_found', 'Không tìm thấy tài khoản.');
    if (u.id === actor.id && b.active !== undefined && !b.active) fail(400, 'self_lock', 'Bạn không thể tự khoá tài khoản của mình.');
    if (!canManage(actor, u)) fail(403, 'forbidden', 'Tài khoản của bạn không quản lý được tài khoản này.');
    const patch = {};
    if (b.name !== undefined) { patch.name = cleanStr(b.name, 60); if (!patch.name) fail(400, 'bad_name', 'Cần nhập họ tên.'); }
    if (b.email !== undefined) patch.email = cleanStr(b.email, 120).toLowerCase();
    if (b.lang !== undefined) patch.lang = b.lang === 'en' ? 'en' : 'vi';
    if (b.role !== undefined && b.role !== u.role) {
      if (!ROLES.includes(b.role) || !(CAN_MANAGE[actor.role] || []).includes(b.role)) fail(403, 'forbidden', 'Bạn không đổi được sang vai trò này.');
      if (u.role === 'fo' || b.role === 'fo') fail(400, 'role_fo', 'Không đổi vai trò từ FO hoặc sang FO được (dữ liệu vị trí và điều khoản gắn với FO). Tạo tài khoản mới.');
      if (u.id === actor.id) fail(400, 'self_role', 'Bạn không tự đổi vai trò của mình được.');
      if ((u.role === 'admin' || u.role === 'tech_lead') && u.active && topCount() <= 1) fail(400, 'last_admin', 'Phải còn ít nhất một tài khoản Quản trị hoặc Tech Lead đang hoạt động.');
      patch.role = b.role;
    }
    if (b.phone !== undefined) patch.phone = cleanStr(b.phone, 20);
    if (b.vehicle !== undefined) patch.vehicle = cleanStr(b.vehicle, 30);
    if (b.active !== undefined) {
      const active = b.active ? 1 : 0;
      if (!active && u.id === actor.id) fail(400, 'self_lock', 'Bạn không thể tự khoá tài khoản của mình.');
      if (!active && (u.role === 'admin' || u.role === 'tech_lead') && u.active && topCount() <= 1) fail(400, 'last_admin', 'Phải còn ít nhất một tài khoản Quản trị hoặc Tech Lead đang hoạt động.');
      patch.active = active;
    }
    store.users.update(id, patch);
    const nu = store.users.get(id);
    if (patch.active === 0) {
      killSessions(id);
      if (u.role === 'fo') { const l = live.get(id); if (l) endShift(l, now(), 'disabled'); toOps({ t: 'fo', op: 'remove', id }); }
      kick(id, 'disabled');
      event('user_disabled', 'info', `${actor.name} khoá tài khoản của ${u.name}.`, { actor_id: actor.id });
    } else if (nu.role === 'fo' && nu.active) {
      ensureLive(id);
      toOps({ t: 'fo', op: 'upsert', fo: foView(nu) });
      if (patch.active === 1 && !u.active) event('user_enabled', 'info', `${actor.name} mở lại tài khoản của ${u.name}.`, { actor_id: actor.id });
    }
    if ((patch.site_id !== undefined && patch.site_id !== u.site_id) || patch.role) kick(id, 'changed');
    if (hooks.onUserChanged && ((patch.active === 0 && u.active) || patch.role)) hooks.onUserChanged(u, nu, actor); // Ops Hub: trả việc người đó đang giữ
    return { user: publicUser(nu) };
  }

  // ───────────────────────── Đăng nhập ─────────────────────────
  const fails = new Map();
  const limited = (key, max) => { const f = fails.get(key); return !!f && f.n >= max && now() < f.until; };
  function noteFail(key) {
    const f = fails.get(key), t = now();
    if (!f || t > f.until) fails.set(key, { n: 1, until: t + 600000 }); else f.n++;
  }
  async function login(b, ctx) {
    const username = cleanStr(b.username, 60).toLowerCase(), ip = ctx.ip || '';
    if (limited('ip:' + ip, 20) || limited('u:' + username, 8)) fail(429, 'too_many_attempts', 'Đăng nhập sai quá nhiều lần. Đợi 10 phút rồi thử lại.');
    const u = username ? store.users.find({ username }, { limit: 1 })[0] : null;
    const ok = await deps.verifyPassword(typeof b.password === 'string' ? b.password : '', u ? u.pass_hash : null);
    if (!u || !ok || !u.active) {
      noteFail('ip:' + ip); noteFail('u:' + username);
      fail(401, 'bad_login', 'Tên đăng nhập hoặc mật khẩu không đúng.');
    }
    fails.delete('u:' + username);
    const token = deps.token(32), t = now();
    store.sessions.insert({ id: deps.sha(token), user_id: u.id, created_at: t, seen_at: t, expires_at: t + cfg.sessionDays * 86400000, ua: cleanStr(ctx.ua, 200) });
    return { token, user: u };
  }
  /** Mã phiên (trong cookie) → người dùng, hoặc null. */
  function authToken(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    const sid = deps.sha(token), s = store.sessions.get(sid), t = now();
    if (!s) return null;
    if (t > s.expires_at) { store.sessions.remove(sid); return null; }
    const u = store.users.get(s.user_id);
    if (!u || !u.active) return null;
    if (t - s.seen_at > 300000) store.sessions.update(sid, { seen_at: t, expires_at: t + cfg.sessionDays * 86400000 });
    u._sid = sid;
    if (hooks.onSeen) hooks.onSeen(u, t); // chấm công: lần đầu dùng ứng dụng trong ca
    return u;
  }
  function logout(token) { if (typeof token === 'string' && token) store.sessions.remove(deps.sha(token)); }

  // ───────────────────────── Vị trí thời gian thực ─────────────────────────
  const live = new Map(); // id FO → trạng thái đang theo dõi
  const dirty = new Set();
  const hooks = {}; // tasks.js gắn thêm: onPoint, onShiftEnd, onConditions, tick
  function ensureLive(uid) {
    let l = live.get(uid);
    if (!l) { l = { id: uid, last: null, trail: [], onShift: false, shiftId: null, lastRecvAt: 0, shiftEndedAt: 0, jumps: 0, anchor: null, day: null, cur: null, lostAlerted: false }; live.set(uid, l); }
    return l;
  }
  function pushTrail(l, lat, lon, ts) {
    const t = l.trail, tail = t[t.length - 1];
    if (tail && distM(tail[0], tail[1], lat, lon) < 10) return; // đứng yên: không thêm điểm
    t.push([lat, lon, ts]);
    const cut = ts - cfg.trailMinutes * 60000;
    let k = 0;
    while (k < t.length - 1 && (t[k][2] < cut || t.length - k > 600)) k++;
    if (k) t.splice(0, k);
  }
  function dayOf(l, ts) {
    const date = localDate(ts, off);
    if (!l.day || l.day.date !== date) {
      flushDay(l);
      const id = `${l.id}:${date}`, row = store.daily.get(id);
      l.day = row ? { ...row, dirty: false, isNew: false } : { id, user_id: l.id, date, km: 0, move_sec: 0, pts: 0, first_ts: ts, last_ts: ts, dirty: true, isNew: true };
    }
    return l.day;
  }
  function flushDay(l) {
    const d = l.day;
    if (!d || !d.dirty) return;
    const row = { user_id: d.user_id, date: d.date, km: +d.km.toFixed(3), move_sec: d.move_sec, pts: d.pts, first_ts: d.first_ts, last_ts: d.last_ts };
    if (d.isNew) { store.daily.insert({ id: d.id, ...row }); d.isNew = false; } else store.daily.update(d.id, row);
    d.dirty = false;
  }
  function startShift(l, t) {
    if (l.onShift) return;
    l.onShift = true;
    l.shiftId = store.shifts.insert({ user_id: l.id, start_ts: t, end_ts: null, end_reason: null });
    l.lastRecvAt = t; l.anchor = null; l.lostAlerted = false;
    toOps({ t: 'shift', id: l.id, on: true, ts: t });
    toUser(l.id, { t: 'shift', on: true });
  }
  function endShift(l, t, reason) {
    if (!l.onShift) return;
    l.onShift = false; l.shiftEndedAt = t;
    store.shifts.update(l.shiftId, { end_ts: t, end_reason: reason });
    l.shiftId = null; l.anchor = null;
    flushDay(l);
    if (hooks.onShiftEnd) hooks.onShiftEnd(l, reason);
    toOps({ t: 'shift', id: l.id, on: false, ts: t });
    toUser(l.id, { t: 'shift', on: false, reason });
  }
  /** FO có được ghi vị trí không (đang hoạt động và đã đồng ý điều khoản hiện hành). */
  const canTrack = (u) => !!u && u.role === 'fo' && !!u.active && !u.must_change && !needConsent(u);

  /** Nhận 1 điểm vị trí. Trả về 'ok' hoặc lý do bị loại. Mọi nguồn (WebSocket, HTTP, Traccar) đều đi qua đây. */
  function ingest(uid, raw, t = now()) {
    if (!raw || typeof raw !== 'object') return 'bad_point';
    const lat = num(raw.lat), lon = num(raw.lon);
    if (!validCoord(lat, lon)) return 'bad_coord';
    let ts = num(raw.ts);
    if (ts === null) ts = t;
    else if (ts < 1e11) ts *= 1000; // giây → mili giây
    ts = Math.round(ts);
    if (ts > t + 120000) ts = t; // đồng hồ máy FO chạy nhanh
    if (ts < t - 48 * 3600000) return 'too_old';
    const acc = num(raw.acc);
    if (acc !== null && (acc < 0 || acc > cfg.maxAccuracyM)) return 'low_accuracy';
    let spd = num(raw.spd), hdg = num(raw.hdg), bat = num(raw.bat);
    if (spd !== null && (spd < 0 || spd > 90)) spd = null; // iOS trả -1 khi không rõ
    if (hdg !== null && (hdg < 0 || hdg > 360)) hdg = null;
    if (bat !== null && (bat < 0 || bat > 1)) bat = null;

    const l = ensureLive(uid), prev = l.last;
    if (prev) {
      const dt = (ts - prev.ts) / 1000;
      if (dt < 0.9) return 'dup'; // trùng, cũ hơn, hoặc gửi dồn dập
      const dist = distM(prev.lat, prev.lon, lat, lon);
      // Điểm "nhảy cóc" (GPS trôi). Sau 3 lần liên tiếp thì tin điểm mới — có thể chính điểm cũ mới là điểm sai.
      if (dist > 200 && (dist / dt) * 3.6 > cfg.maxSpeedKmh && ++l.jumps <= 3) return 'jump';
      if (spd === null) spd = dt < 120 ? dist / dt : 0;
      if (hdg === null) hdg = dist > 8 ? bearingDeg(prev.lat, prev.lon, lat, lon) : prev.hdg;
    }
    l.jumps = 0;
    const p = {
      ts, lat: +lat.toFixed(6), lon: +lon.toFixed(6),
      spd: spd === null ? 0 : +spd.toFixed(2),
      hdg: hdg === null || hdg === undefined ? null : Math.round(hdg) % 360,
      acc: acc === null ? null : Math.round(acc),
      bat: bat === null ? (prev ? prev.bat : null) : +bat.toFixed(2),
    };
    store.positions.insert({ user_id: uid, ...p });
    l.last = p; l.lastRecvAt = t; l.lostAlerted = false;
    pushTrail(l, p.lat, p.lon, p.ts);
    // Điểm mới sau lúc kết thúc ca → tự mở ca (app chạy nền không có nút bấm ca).
    if (!l.onShift && ts > l.shiftEndedAt + 5000) startShift(l, t);
    // Cộng quãng đường thực tế: chỉ tính khi đã rời điểm neo ≥ 15 m để GPS rung lúc đứng yên không thành "km ảo".
    const day = dayOf(l, ts);
    day.pts++; day.dirty = true;
    if (ts > day.last_ts) day.last_ts = ts;
    if (ts < day.first_ts) day.first_ts = ts;
    if (!l.anchor) l.anchor = { lat: p.lat, lon: p.lon, ts };
    else {
      const d = distM(l.anchor.lat, l.anchor.lon, p.lat, p.lon);
      if (d >= 15) {
        const dt = (ts - l.anchor.ts) / 1000;
        day.km += d / 1000;
        if (dt > 0 && dt <= 300) day.move_sec += Math.round(dt);
        if (l.cur) { l.cur.km += d / 1000; l.cur.kmDirty = true; }
        l.anchor = { lat: p.lat, lon: p.lon, ts };
      }
    }
    if (hooks.onPoint) hooks.onPoint(l, p, t);
    dirty.add(l);
    return 'ok';
  }
  function ingestMany(uid, pts, t = now()) {
    const out = { ok: 0, drop: 0, why: {} };
    if (!Array.isArray(pts)) return out;
    for (const pt of pts.slice(0, 500)) {
      const r = ingest(uid, pt, t);
      if (r === 'ok') out.ok++; else { out.drop++; out.why[r] = (out.why[r] || 0) + 1; }
    }
    return out;
  }
  /** Điểm từ app Traccar Client: nhận diện FO bằng mã thiết bị. */
  function ingestDevice(deviceToken, pt) {
    if (typeof deviceToken !== 'string' || deviceToken.length < 12) return 'unknown_device';
    const u = store.users.find({ device_token: deviceToken }, { limit: 1 })[0];
    if (!u) return 'unknown_device';
    if (!canTrack(u)) return 'not_allowed';
    return ingest(u.id, pt);
  }
  /** Gom các vị trí mới và phát cho mọi màn hình điều phối (máy chủ gọi mỗi giây). */
  function flushPositions() {
    if (!dirty.size) return;
    const u = [];
    for (const l of dirty) if (l.last) u.push({ id: l.id, ...l.last });
    dirty.clear();
    if (u.length) toOps({ t: 'pos', now: now(), u });
  }
  function setShift(user, on) {
    const l = ensureLive(user.id), t = now();
    if (on) startShift(l, t); else endShift(l, t, 'fo');
    return { onShift: l.onShift };
  }

  const clientCfg = () => ({
    staleSec: cfg.staleSec, offlineSec: cfg.offlineSec, trailMinutes: cfg.trailMinutes, tileUrl: cfg.tileUrl, tileAttribution: cfg.tileAttribution, demo: cfg.demo, note: cfg.note,
    tzOffsetMin: off, arriveRadiusM: cfg.arriveRadiusM, maxPhotos: cfg.maxPhotos, company: cfg.company, sla: cfg.sla, boConfirm: !!cfg.boConfirm,
    routing: !!deps.route, // máy chủ có lấy đường đi thực tế (Google / OSRM) không; không thì bản đồ vẽ đường thẳng giữa các điểm
    routingProvider: cfg.routingProvider || null, // 'google' | 'osrm' | null (server.js đặt): đường của Google chỉ được vẽ trên nền bản đồ Google
    mapTiles: cfg.mapTiles || null, // nền bản đồ Google chính thức (Map Tiles API); server.js làm mới phiên định kỳ ngay trên core.cfg nên đọc lúc gọi
  });
  function snapshot() {
    return {
      t: 'snapshot', now: now(), cfg: clientCfg(), conditions: conditions(),
      fos: activeFos().map((u) => ({ ...foView(u), trail: (live.get(u.id) || { trail: [] }).trail })),
    };
  }

  function loadLive() {
    const t = now(), date = localDate(t, off);
    for (const u of activeFos()) {
      const l = ensureLive(u.id);
      const last = store.positions.find({ user_id: u.id }, { order: 'ts', desc: true, limit: 1 })[0];
      if (last) l.last = { ts: last.ts, lat: last.lat, lon: last.lon, spd: last.spd, hdg: last.hdg, acc: last.acc, bat: last.bat };
      for (const p of store.positions.find({ user_id: u.id, ts: { gte: t - cfg.trailMinutes * 60000 } }, { order: 'ts' })) pushTrail(l, p.lat, p.lon, p.ts);
      const open = store.shifts.find({ user_id: u.id, end_ts: null }, { order: 'id', desc: true, limit: 1 })[0];
      if (open) {
        const seen = l.last ? Math.max(l.last.ts, open.start_ts) : open.start_ts;
        if (t - seen > cfg.offlineSec * 1000) store.shifts.update(open.id, { end_ts: seen, end_reason: 'timeout' });
        else { l.onShift = true; l.shiftId = open.id; l.lastRecvAt = seen; }
      }
      const row = store.daily.get(`${u.id}:${date}`);
      if (row) l.day = { ...row, dirty: false, isNew: false };
    }
  }

  // ───────────────────────── Điều kiện thời tiết / giao thông (dùng để nới SLA) ─────────────────────────
  function autoTraffic(ts) {
    const m = minuteOfDay(ts, off), wd = weekday(localDate(ts, off));
    return wd <= 6 && ((m >= 390 && m < 540) || (m >= 990 && m < 1170)) ? 'peak' : 'normal'; // T2–T7: 6:30–9:00 và 16:30–19:30
  }
  const rawConditions = () => getSetting('conditions') || { weatherMode: 'manual', weather: 'clear', trafficMode: 'auto', traffic: 'normal', weatherAt: null, weatherErr: null };
  function conditions() {
    const c = rawConditions();
    const traffic = c.trafficMode === 'auto' ? autoTraffic(now()) : c.traffic;
    const factor = Math.min(2, +(WEATHER[c.weather].f * TRAFFIC[traffic].f).toFixed(2));
    // weatherF / trafficF: từng hệ số riêng (tasks.js tính hệ số cho task có đường đi đã tính kẹt xe: không nhân thêm giờ cao điểm tự động).
    return { weatherMode: c.weatherMode, weather: c.weather, trafficMode: c.trafficMode, traffic, factor, weatherF: WEATHER[c.weather].f, trafficF: TRAFFIC[traffic].f, weatherAt: c.weatherAt, weatherErr: c.weatherErr, canAutoWeather: !!deps.fetchWeather };
  }
  let lastFactor = null;
  /** Hệ số đổi (do người chỉnh, do thời tiết, hoặc do sang/hết giờ cao điểm) → tính lại hạn các task chưa xong. */
  function conditionsChanged(force) {
    const c = conditions();
    if (!force && c.factor === lastFactor) return;
    const first = lastFactor === null;
    lastFactor = c.factor;
    if (!first && hooks.onConditions) hooks.onConditions(c);
    toOps({ t: 'cond', conditions: c });
  }
  function setConditions(b, actor) {
    const c = { ...rawConditions() };
    if (b.weatherMode !== undefined) {
      if (b.weatherMode !== 'auto' && b.weatherMode !== 'manual') fail(400, 'bad_value', 'Chế độ thời tiết không hợp lệ.');
      if (b.weatherMode === 'auto' && !deps.fetchWeather) fail(400, 'no_weather_source', 'Máy chủ chưa bật nguồn thời tiết tự động.');
      c.weatherMode = b.weatherMode;
    }
    if (b.weather !== undefined) { if (!WEATHER[b.weather]) fail(400, 'bad_value', 'Thời tiết không hợp lệ.'); c.weather = b.weather; if (b.weatherMode === undefined) c.weatherMode = 'manual'; }
    if (b.trafficMode !== undefined) { if (b.trafficMode !== 'auto' && b.trafficMode !== 'manual') fail(400, 'bad_value', 'Chế độ giao thông không hợp lệ.'); c.trafficMode = b.trafficMode; }
    if (b.traffic !== undefined) { if (!TRAFFIC[b.traffic]) fail(400, 'bad_value', 'Giao thông không hợp lệ.'); c.traffic = b.traffic; if (b.trafficMode === undefined) c.trafficMode = 'manual'; }
    setSetting('conditions', c);
    const eff = conditions();
    event('conditions', 'info', `${actor.name} đặt điều kiện: ${WEATHER[eff.weather].label}, giao thông ${TRAFFIC[eff.traffic].label.toLowerCase()} (hệ số SLA ×${eff.factor}).`, { actor_id: actor.id });
    conditionsChanged(true);
    if (c.weatherMode === 'auto') refreshWeather().catch(() => {});
    return eff;
  }
  /** Lấy thời tiết hiện tại từ nguồn ngoài (nếu được bật) và quy ra mức ảnh hưởng. */
  async function refreshWeather() {
    const c0 = rawConditions();
    if (c0.weatherMode !== 'auto' || !deps.fetchWeather) return null;
    let level, err = null;
    try {
      const w = await deps.fetchWeather();
      const code = num(w && w.code), precip = num(w && w.precip), interval = num(w && w.intervalSec) || 3600;
      if (precip === null && code === null) throw new Error('empty');
      const rate = (precip || 0) * 3600 / interval; // mm/giờ
      level = code !== null && code >= 95 ? 'storm' : rate >= 7.6 ? 'heavy' : rate >= 0.5 || (code !== null && code >= 51 && code <= 82) ? 'rain' : 'clear';
    } catch (e) { err = String((e && e.message) || e).slice(0, 120); }
    const c = { ...rawConditions() };
    if (c.weatherMode !== 'auto') return null; // người dùng vừa chuyển sang chỉnh tay
    if (err) { c.weatherErr = err; setSetting('conditions', c); toOps({ t: 'cond', conditions: conditions() }); return null; }
    const changed = c.weather !== level;
    c.weather = level; c.weatherAt = now(); c.weatherErr = null;
    setSetting('conditions', c);
    if (changed) event('conditions', 'info', `Thời tiết tự động: ${WEATHER[level].label}.`, {});
    conditionsChanged(changed);
    if (!changed) toOps({ t: 'cond', conditions: conditions() });
    return level;
  }

  // ───────────────────────── Bộ định tuyến API ─────────────────────────
  const routes = [];
  let staticCount = 0;
  /**
   * roles: 'public' | 'any' | mảng vai trò. open: dùng được cả khi chưa đổi mật khẩu / chưa đồng ý điều khoản.
   * Đường dẫn cố định (không có :tham_số) được xét trước đường dẫn có tham số, để /cards/records không bị hiểu là /cards/:id.
   */
  function R(method, pattern, roles, fn, open = false) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    const route = { method, re, keys, roles, fn, open };
    if (keys.length) routes.push(route); else routes.splice(staticCount++, 0, route);
  }
  async function api(ctx, method, path, query, body) {
    try {
      let pathHit = false;
      for (const r of routes) {
        const m = r.re.exec(path);
        if (!m) continue;
        pathHit = true;
        if (r.method !== method) continue;
        const user = ctx.user || null;
        if (r.roles !== 'public') {
          if (!user) fail(401, 'unauthenticated', 'Bạn cần đăng nhập.');
          if (r.roles !== 'any' && !r.roles.includes(user.role)) fail(403, 'forbidden', 'Tài khoản của bạn không có quyền làm việc này.');
          if (!r.open) {
            if (user.must_change) fail(403, 'password_change_required', 'Bạn cần đổi mật khẩu trước.');
            if (needConsent(user)) fail(403, 'consent_required', 'Bạn cần đồng ý điều khoản trước.');
          }
        }
        const p = {};
        r.keys.forEach((k, i) => { try { p[k] = decodeURIComponent(m[i + 1]); } catch { fail(400, 'bad_path', 'Đường dẫn không hợp lệ.'); } });
        const call = () => r.fn({ ctx, user, p, q: query || {}, b: body && typeof body === 'object' && !Array.isArray(body) ? body : {} });
        // Mỗi lệnh ghi chạy trọn trong một giao dịch: lỗi giữa chừng thì hoàn tác hết, kể cả nhật ký và thông báo đã ghi.
        // Giao dịch lồng bên trong (store.tx trong từng chức năng) thành điểm lưu tạm. Hàm async (băm mật khẩu…) tự lo phần của nó.
        let out = method === 'GET' || r.fn.constructor.name === 'AsyncFunction' ? call() : store.tx(call);
        if (out && typeof out.then === 'function') out = await out;
        return { status: 200, body: out === undefined ? { ok: true } : out };
      }
      fail(pathHit ? 405 : 404, pathHit ? 'method_not_allowed' : 'not_found', 'Không có chức năng này.');
    } catch (e) {
      if (e instanceof ApiError) return { status: e.status, body: { ...(e.data || {}), error: e.code, message: e.msg } };
      throw e;
    }
    return { status: 500, body: { error: 'server_error' } };
  }
  const idOf = (v) => int(v, 1, 1e12) ?? fail(400, 'bad_id', 'Mã không hợp lệ.');

  // — Phiên đăng nhập —
  R('POST', '/api/login', 'public', async ({ ctx, b }) => {
    const { token, user } = await login(b, ctx);
    return { __session: token, user: publicUser(user) };
  });
  R('POST', '/api/logout', 'public', ({ ctx }) => { logout(ctx.token); return { __clearSession: true, ok: true }; });
  R('GET', '/api/me', 'public', ({ user }) => {
    if (!user) return { user: null };
    const out = { user: publicUser(user), cfg: clientCfg(), needConsent: needConsent(user), terms: user.role === 'fo' ? terms() : null, site: null, deviceToken: null };
    if (user.role === 'fo' && !user.must_change && !needConsent(user)) out.deviceToken = user.device_token;
    return out;
  }, true);
  R('POST', '/api/password', 'any', async ({ user, b }) => {
    if (!(await deps.verifyPassword(typeof b.old === 'string' ? b.old : '', user.pass_hash))) fail(400, 'bad_old_password', 'Mật khẩu hiện tại không đúng.');
    checkPassword(b.new, user.username);
    if (b.new === b.old) fail(400, 'same_password', 'Mật khẩu mới phải khác mật khẩu hiện tại.');
    store.users.update(user.id, { pass_hash: await deps.hashPassword(b.new), must_change: 0 });
    killSessions(user.id, user._sid);
    kick(user.id, 'password', user._sid); // thiết bị khác: phiên đã xoá thì kênh thời gian thực cũng phải ngắt ngay, không chờ tới lệnh HTTP kế tiếp
    return { ok: true };
  }, true);

  // — Điều khoản & đồng ý —
  R('GET', '/api/terms', 'any', () => terms(), true);
  R('PUT', '/api/terms', ['admin', 'lead'], ({ user, b }) => {
    const items = Array.isArray(b.items) ? b.items.map((s) => cleanText(s, 800)).filter(Boolean) : [];
    if (!items.length || items.length > 20) fail(400, 'bad_terms', 'Điều khoản cần từ 1 đến 20 mục.');
    const t = now();
    const next = { version: `v${localDate(t, off).replace(/-/g, '')}-${String(minuteOfDay(t, off)).padStart(4, '0')}-${String(t % 1000).padStart(3, '0')}`, title: cleanStr(b.title, 120) || terms().title, intro: cleanText(b.intro, 1500), items };
    setSetting('terms', next);
    event('terms_changed', 'info', `${user.name} cập nhật điều khoản (bản ${next.version}). Mọi FO cần đồng ý lại.`, { actor_id: user.id });
    for (const u of activeFos()) { const l = live.get(u.id); if (l) endShift(l, t, 'terms'); kick(u.id, 'terms'); toOps({ t: 'fo', op: 'upsert', fo: foView(u) }); }
    return next;
  });
  R('POST', '/api/consent', ['fo'], ({ ctx, user, b }) => {
    if (user.must_change) fail(403, 'password_change_required', 'Bạn cần đổi mật khẩu trước.');
    const tm = terms();
    if (b.version !== tm.version) fail(409, 'terms_changed', 'Điều khoản vừa được cập nhật. Tải lại để đọc bản mới.');
    const checked = new Set(Array.isArray(b.checked) ? b.checked : []);
    for (let i = 0; i < tm.items.length; i++) if (!checked.has(i)) fail(400, 'not_all_checked', 'Bạn cần đánh dấu đồng ý tất cả các mục.');
    const t = now();
    store.tx(() => {
      store.consents.insert({ user_id: user.id, version: tm.version, action: 'agree', ts: t, ip: cleanStr(ctx.ip, 60), ua: cleanStr(ctx.ua, 200), items: tm.items });
      store.users.update(user.id, { consent_version: tm.version, consent_at: t });
    });
    event('consent', 'info', `${user.name} đã đồng ý điều khoản (bản ${tm.version}).`, { fo_id: user.id, actor_id: user.id });
    toOps({ t: 'fo', op: 'upsert', fo: foView(store.users.get(user.id)) });
    return { ok: true, version: tm.version, at: t };
  }, true);
  R('POST', '/api/consent/withdraw', ['fo'], ({ ctx, user }) => {
    const t = now();
    store.tx(() => {
      store.consents.insert({ user_id: user.id, version: user.consent_version || '', action: 'withdraw', ts: t, ip: cleanStr(ctx.ip, 60), ua: cleanStr(ctx.ua, 200), items: null });
      store.users.update(user.id, { consent_version: null, consent_at: null });
    });
    const l = live.get(user.id);
    if (l) endShift(l, t, 'withdraw');
    event('consent_withdrawn', 'alert', `${user.name} đã rút lại sự đồng ý xử lý dữ liệu. Ứng dụng ngừng ghi vị trí của FO này; cần giao lại các task đang mở.`, { fo_id: user.id, actor_id: user.id });
    toOps({ t: 'fo', op: 'upsert', fo: foView(store.users.get(user.id)) });
    return { ok: true };
  }, true);
  R('GET', '/api/consents', ['admin', 'lead'], ({ q }) => {
    const where = q.user ? { user_id: idOf(q.user) } : {};
    return { consents: store.consents.find(where, { order: 'ts', desc: true, limit: 500 }) };
  });

  // — Tài khoản (Logistic Lead) —
  R('GET', '/api/users', [...MANAGERS, 'logistic'], ({ user }) => {
    const all = store.users.find({}, { order: 'name' });
    const list = all.filter((u) => canManage(user, u) || (user.role === 'logistic' && u.role === 'fo'));
    return { users: list.map(publicUser), canCreate: CAN_MANAGE[user.role] || [] };
  });
  R('POST', '/api/users', MANAGERS, ({ user, b }) => createUser({ ...b, password: undefined, must_change: true, demo: false }, user));
  R('PATCH', '/api/users/:id', MANAGERS, ({ user, p, b }) => updateUser(idOf(p.id), b, user));
  R('POST', '/api/users/:id/reset', MANAGERS, async ({ user, p }) => {
    const u = store.users.get(idOf(p.id));
    if (!u || !canManage(user, u)) fail(404, 'not_found', 'Không tìm thấy tài khoản.');
    const pw = tempPassword();
    store.users.update(u.id, { pass_hash: await deps.hashPassword(pw), must_change: 1 });
    killSessions(u.id, u.id === user.id ? user._sid : undefined);
    if (u.id !== user.id) kick(u.id, 'reset');
    fails.delete('u:' + u.username);
    event('password_reset', 'info', `${user.name} cấp lại mật khẩu cho ${u.name}.`, { actor_id: user.id });
    return { tempPassword: pw };
  });
  R('GET', '/api/users/:id/device', ['admin', 'tech_lead', 'lead'], ({ p }) => {
    const u = store.users.get(idOf(p.id));
    if (!u || u.role !== 'fo') fail(404, 'not_found', 'Không tìm thấy FO.');
    return { deviceToken: u.device_token };
  });
  R('POST', '/api/users/:id/device', ['admin', 'tech_lead', 'lead'], ({ p }) => {
    const u = store.users.get(idOf(p.id));
    if (!u || u.role !== 'fo') fail(404, 'not_found', 'Không tìm thấy FO.');
    const deviceToken = deps.token(18);
    store.users.update(u.id, { device_token: deviceToken });
    return { deviceToken };
  });

  // — Điểm giao nhận —
  function siteInput(b, cur) {
    const out = {};
    const has = (k) => b[k] !== undefined || !cur;
    if (has('name')) { out.name = cleanStr(b.name, 80); if (!out.name) fail(400, 'bad_name', 'Cần nhập tên điểm.'); }
    if (has('type')) { out.type = b.type || 'bo'; if (!SITE_TYPES.includes(out.type)) fail(400, 'bad_type', 'Loại điểm không hợp lệ.'); }
    if (has('address')) out.address = cleanStr(b.address, 200);
    if (has('contact')) out.contact = cleanStr(b.contact, 60);
    if (has('phone')) out.phone = cleanStr(b.phone, 20);
    if (has('lat') || has('lon')) {
      out.lat = num(b.lat ?? (cur && cur.lat)); out.lon = num(b.lon ?? (cur && cur.lon));
      if (!validCoord(out.lat, out.lon)) fail(400, 'bad_coord', 'Toạ độ không hợp lệ. Vĩ độ từ -90 đến 90, kinh độ từ -180 đến 180.');
      out.lat = +out.lat.toFixed(6); out.lon = +out.lon.toFixed(6);
    }
    if (has('radius')) { out.radius = b.radius === undefined || b.radius === null || b.radius === '' ? cfg.arriveRadiusM : int(b.radius, 30, 2000); if (out.radius === null) fail(400, 'bad_radius', 'Bán kính nhận diện “đã đến” từ 30 đến 2000 mét.'); }
    return out;
  }
  R('GET', '/api/sites', OPS, () => ({ sites: store.sites.find({ active: 1 }, { order: 'name' }) }));
  // Điểm loại BO dùng chung với Ops Hub: không đổi loại, không xoá BO đang dùng, có nhật ký Ops Hub (core/hub/outlets.js).
  R('POST', '/api/sites', OPS, ({ user, b }) => {
    const row = { ...siteInput(b, null), active: 1, created_at: now() };
    row.id = store.sites.insert(row);
    if (row.type === 'bo' && K.hub) K.hub.outlets.riderCreate(row, user);
    toOps({ t: 'site', op: 'upsert', site: row });
    return { site: row };
  });
  R('PATCH', '/api/sites/:id', OPS, ({ user, p, b }) => {
    const cur = store.sites.get(idOf(p.id));
    if (!cur || !cur.active) fail(404, 'not_found', 'Không tìm thấy điểm.');
    const patch = siteInput(b, cur);
    if (cur.type === 'bo' && K.hub) K.hub.outlets.riderEdit(cur, patch, user);
    else if (patch.type === 'bo' && K.hub) K.hub.outlets.riderCreate({ ...cur, ...patch }, user);
    store.sites.update(cur.id, patch);
    const site = store.sites.get(cur.id);
    toOps({ t: 'site', op: 'upsert', site });
    return { site };
  });
  R('DELETE', '/api/sites/:id', OPS, ({ user, p }) => {
    const cur = store.sites.get(idOf(p.id));
    if (!cur || !cur.active) fail(404, 'not_found', 'Không tìm thấy điểm.');
    if (store.templates.find({ active: 1 }).some((t) => (t.stops || []).some((s) => s.site_id === cur.id))) fail(409, 'site_in_use', 'Điểm này đang nằm trong một tuyến định kỳ. Sửa tuyến trước.');
    if (cur.type === 'bo' && K.hub) K.hub.outlets.riderRemove(cur, user);
    store.sites.update(cur.id, { active: 0 });
    toOps({ t: 'site', op: 'remove', id: cur.id });
    return { ok: true };
  });

  // — Vị trí & ca —
  R('POST', '/api/loc', ['fo'], ({ user, b }) => {
    const out = ingestMany(user.id, b.pts);
    if (b.shift === false) setShift(user, false); else if (b.shift === true) setShift(user, true);
    return { ...out, onShift: ensureLive(user.id).onShift };
  });
  R('POST', '/api/shift', ['fo'], ({ user, b }) => setShift(user, !!b.on));
  R('GET', '/api/live', OPS, () => snapshot());
  R('GET', '/api/history', [...OPS, 'fo'], ({ user, q }) => {
    const fo = user.role === 'fo' ? user.id : idOf(q.fo);
    let from = num(q.from), to = num(q.to);
    if (isDate(q.date)) { from = dayStart(q.date, off); to = from + 86400000; }
    if (from === null || to === null || to <= from || to - from > 8 * 86400000) fail(400, 'bad_range', 'Khoảng thời gian không hợp lệ (tối đa 8 ngày).');
    let rows = store.positions.find({ user_id: fo, ts: { gte: from, lt: to } }, { order: 'ts' });
    const total = rows.length;
    if (total > 4000) { const k = Math.ceil(total / 4000); rows = rows.filter((_, i) => i % k === 0 || i === total - 1); }
    const shifts = store.shifts.find({ user_id: fo, start_ts: { lt: to } }, { order: 'start_ts' }).filter((s) => s.end_ts === null || s.end_ts >= from).map((s) => [s.start_ts, s.end_ts, s.end_reason]);
    return { total, pts: rows.map((r) => [r.ts, r.lat, r.lon, r.spd]), shifts };
  });

  // — Điều kiện —
  R('GET', '/api/conditions', [...OPS, 'fo'], () => conditions());
  R('PUT', '/api/conditions', OPS, ({ user, b }) => setConditions(b, user));

  // ───────────────────────── Nhịp định kỳ & dọn dẹp ─────────────────────────
  /** Máy chủ gọi mỗi ~15 giây. */
  function tick() {
    const t = now();
    for (const l of live.values()) {
      if (l.onShift && t - l.lastRecvAt > cfg.offlineSec * 1000) endShift(l, t, 'timeout');
      flushDay(l);
    }
    conditionsChanged(false);
    if (hooks.tick) hooks.tick(t);
  }
  /** Máy chủ gọi vài giờ một lần: xoá dữ liệu hết hạn lưu. */
  function maintenance() {
    const t = now(), out = { positions: 0, photos: 0, sessions: 0, events: 0, routes: 0 };
    if (cfg.routeRetentionDays > 0) out.routes = tasks.pruneRoutes(t - cfg.routeRetentionDays * 86400000);
    if (cfg.retentionDays > 0) out.positions = store.positions.removeWhere({ ts: { lt: t - cfg.retentionDays * 86400000 } });
    if (cfg.photoRetentionDays > 0) {
      for (const ph of store.photos.find({ ts: { lt: t - cfg.photoRetentionDays * 86400000 } })) {
        try { if (deps.files && deps.files.remove) deps.files.remove(ph.id, ph.mime, ph.ts); } catch { /* tệp đã mất */ }
        store.photos.remove(ph.id); out.photos++;
      }
    }
    out.sessions = store.sessions.removeWhere({ expires_at: { lt: t } });
    out.events = store.events.removeWhere({ ts: { lt: t - 365 * 86400000 } });
    for (const [k, f] of fails) if (t > f.until) fails.delete(k);
    return out;
  }
  function shutdown() {
    for (const l of live.values()) { flushDay(l); if (hooks.flushCur) hooks.flushCur(l); }
  }

  const K = {
    store, cfg, deps, now, off, today, isOps, OPS, live, hooks, ensureLive, R, idOf, event, toOps, toUser, toRoles, kick, limited, noteFail, getSetting, setSetting, subs,
    publicUser, foView, activeFos, needConsent, canTrack, conditions, startShift, flushDay, terms, createUser,
    isPeak: (ts) => autoTraffic(ts) === 'peak', // giờ cao điểm theo lịch (hiệu chỉnh SLA tách giờ cao điểm / ngoài giờ)
    routes: () => routes.map((r) => ({ method: r.method, re: r.re, keys: r.keys, roles: r.roles })), // danh sách API (chỉ đọc) cho bài kiểm phân quyền
  };
  const tasks = installTasks(K);
  K.tasks = tasks;
  const hub = installHub(K);
  loadLive();
  if (hooks.afterLoad) hooks.afterLoad();
  lastFactor = conditions().factor;

  return {
    cfg, now, api, subscribe, authToken, login, logout, createUser, ingest, ingestMany, ingestDevice, flushPositions, setShift, canTrack, needConsent,
    snapshot, conditions, refreshWeather, tick, maintenance, shutdown, terms, live, publicUser, clientCfg, tasks, hub, store,
    /** Số liệu cho /healthz. */
    health() { let onShift = 0; for (const l of live.values()) if (l.onShift) onShift++; return { fo: live.size, onShift, viewers: subs.size }; },
  };
}
