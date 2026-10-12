// hub/index.js — Atlas Ops Hub: kho, kit, BO, yêu cầu của Sale, việc tự sinh cho Logistics và Tech, thẻ nhớ, sự cố,
// chấm công, hiệu suất. Chạy chung lõi với Rider Live: cùng kho dữ liệu, cùng tài khoản, cùng kênh thời gian thực.
// Nguyên tắc (giữ từ bản Apps Script):
//  - Máy chủ tự kiểm vai của người gọi; trình duyệt không quyết định quyền.
//  - Người dùng chỉ xác nhận việc đã làm; trạng thái kit, thẻ, yêu cầu và việc kế tiếp do hệ thống tự đổi và tự sinh.
//  - Mỗi thao tác ghi là một giao dịch (lỗi giữa chừng thì hoàn tác hết) và có nhật ký theo người làm.
//  - Mỗi chỉ số có một nguồn duy nhất; việc tự sinh có khoá chống tạo trùng.
import { localDate, addDays, cleanStr, int, num, decodeDataUrl } from '../util.js';
import { fail, ROLES, ROLE_LABEL, TEAM_OF } from '../core.js';
import { HUB_DEFAULTS, TEAM_CFG, DEFAULT_TYPES, DEFAULT_LABELS, TEAMS, KIT_ST, KIT_KINDS, KIT_CORE, KIT_OUTSIDE, KIT_EDITABLE, DEV_COND, HEALTH, CARD_ST, REQ_KIND, SUPPORT_KIND, REQ_ST, OUTLET_ST, JOB_TYPES, JOB_ST, INCIDENT_RES, INCIDENT_ST, ZERO_REASONS, ATT_ST, RATING, ACC_MOVE } from './defs.js';
import { installStock } from './stock.js';
import { installOutlets } from './outlets.js';
import { installJobs } from './jobs.js';
import { installCards } from './cards.js';
import { installIncidents } from './incidents.js';
import { installPeople } from './people.js';
import { installReport } from './report.js';
import { installImporter } from './importer.js';
import { compareOf } from './period.js';

export function installHub(K) {
  const { store, now, off, R, hooks } = K;
  const STAFF = ROLES.filter((r) => r !== 'fo');
  const G = {
    STAFF,
    OPS_STAFF: ['admin', 'tech_lead', 'tech', 'lead', 'logistic'], // Logistics và Tech (không gồm Sale)
    LOGI: ['admin', 'lead', 'logistic'],
    TECH: ['admin', 'tech_lead', 'tech'],
    LEADS: ['admin', 'tech_lead', 'lead'],
    SALE: ['sale_head', 'sale'],
    STOCK_VIEW: ['admin', 'tech_lead', 'tech', 'lead', 'logistic'],
    OVERVIEW: ['admin', 'tech_lead', 'lead', 'sale_head'], // tổng quan toàn khối vận hành
  };
  const isSale = (u) => u.role === 'sale' || u.role === 'sale_head';
  /** Lead của team (Quản trị coi như Lead của mọi team). */
  const leadOf = (u, team) => u.role === 'admin' || (team === 'tech' && u.role === 'tech_lead') || (team === 'logistics' && u.role === 'lead') || (team === 'sale' && u.role === 'sale_head');
  const today = () => localDate(now(), off);

  // ───────── Cấu hình (lưu trong settings, ghi đè mặc định) ─────────
  function cfg() { return { ...HUB_DEFAULTS, ...(K.getSetting('hub_cfg') || {}) }; }
  function setCfg(patch) { const next = { ...(K.getSetting('hub_cfg') || {}), ...patch }; K.setSetting('hub_cfg', next); return cfg(); }
  const labels = () => cfg().labels || DEFAULT_LABELS;
  /** Giá trị lưu theo từng team ({ tech, logistics }) hay giá trị chung (cách lưu cũ, áp cho cả hai team). */
  const isTeamVal = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k === 'tech' || k === 'logistics');
  /** Mục cấu hình riêng của một team (TEAM_CFG): phần của team đó; lưu dạng chung thì dùng giá trị chung; chưa có thì giá trị đề xuất. */
  function tcfg(key, team, c = cfg()) {
    const v = c[key];
    if (isTeamVal(v)) return v[team] ?? HUB_DEFAULTS[key];
    return v ?? HUB_DEFAULTS[key];
  }
  /** Toàn bộ cấu hình để xem: mục riêng theo team luôn ở dạng { tech, logistics }. */
  function cfgView(c = cfg()) {
    const o = { ...c };
    for (const k of TEAM_CFG) o[k] = { tech: tcfg(k, 'tech', c), logistics: tcfg(k, 'logistics', c) };
    return o;
  }

  // Hậu tố cho khoá việc sinh mỗi lần một việc (nhận kit về, check-in…): thời điểm + số đếm, để hai lần trong cùng mili-giây không bị coi là trùng.
  let seqU = 0;
  const uniq = () => `${now()}.${++seqU}`;
  // ───────── Mã tự tăng theo tiền tố (K2610-0001 …) ─────────
  function nextCode(prefix, table, pad = 4) {
    const key = 'seq:' + prefix;
    let n = (K.getSetting(key) || 0) + 1;
    while (store[table].count({ code: prefix + String(n).padStart(pad, '0') })) n++;
    K.setSetting(key, n);
    return prefix + String(n).padStart(pad, '0');
  }
  const ym = () => localDate(now(), off).slice(2, 7).replace('-', '');

  // ───────── Nhật ký, thông báo, đẩy thay đổi ─────────
  function log(entity, entityId, action, text, actor, data) {
    store.hub_log.insert({ ts: now(), actor_id: actor ? actor.id : null, entity, entity_id: entityId ?? null, action, text, data: data ?? null });
  }
  const changedSet = new Set();
  let flushT = null;
  /** Báo cho mọi màn hình Ops Hub đang mở rằng một nhóm dữ liệu vừa đổi; màn hình tự nạp lại phần đang xem (gộp trong 150 ms). */
  function changed(...ents) {
    for (const e of ents) changedSet.add(e);
    if (flushT) return;
    const run = () => { flushT = null; const list = [...changedSet]; changedSet.clear(); K.toRoles(STAFF, { t: 'hub', ent: list, v: now() }); };
    flushT = typeof setTimeout === 'function' ? setTimeout(run, 150) : (run(), null);
  }
  function usersOf(where) {
    if (where.ids) return where.ids.filter(Boolean).map((id) => store.users.get(id)).filter((u) => u && u.active);
    return store.users.find({ role: where.roles, active: 1 });
  }
  /**
   * Thông báo trong ứng dụng (hộp thư). Mức 'alert' còn đẩy ra Slack nếu đã cấu hình. ref: khoá chống gửi trùng.
   * Dòng hộp thư ghi trong giao dịch; phần đẩy tới màn hình và Slack chỉ chạy sau khi giao dịch ghi xong (hoàn tác thì không gửi).
   */
  function notify(where, level, kind, text, link, ref) {
    const t = now();
    const targets = usersOf(where);
    for (const u of targets) {
      if (ref && store.inbox.count({ user_id: u.id, ref })) continue;
      const id = store.inbox.insert({ user_id: u.id, ts: t, level, kind, text, link: link || '', ref: ref || null, read_at: null });
      store.afterCommit(() => K.toUser(u.id, { t: 'inbox', item: { id, ts: t, level, kind, text, link: link || '' } }));
    }
    if (level === 'alert' && K.deps.notify) store.afterCommit(() => { try { K.deps.notify(text); } catch { /* kênh ngoài lỗi thì bỏ qua */ } });
  }

  // ───────── Chống gửi lặp (bấm gửi lại sau khi mất mạng, mở hai tab) ─────────
  /** Khoá gửi do trình duyệt tạo một lần mỗi khi mở hộp thoại. Không có hoặc sai dạng thì không chống lặp. */
  const reqKeyOf = (b) => (b && typeof b.req_key === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(b.req_key) ? b.req_key : null);
  /** Dòng nhật ký của lần gửi trước cùng khoá, cùng người, trong replayMin phút; chưa có thì null. */
  function replayOf(entity, actions, user, key) {
    if (!key || !user) return null;
    const since = now() - (cfg().replayMin ?? HUB_DEFAULTS.replayMin) * 60000;
    return store.hub_log.find({ entity, action: actions, ts: { gte: since } }, { order: 'ts', desc: true }).find((l) => l.actor_id === user.id && l.data && l.data.req_key === key) || null;
  }

  // ───────── Bộ nhớ đệm số liệu tổng hợp ─────────
  /**
   * memo(key, fn, ttl): kết quả của fn (số liệu tổng hợp chỉ đọc kho) dùng lại cho tới khi một lệnh ghi đổi bất kỳ bảng (phần bảng) nào fn
   * đã đọc (kho tự ghi lại phụ thuộc: core/store-ver.js), nên không bao giờ trả số cũ hơn lệnh ghi cuối đã xong. Chỉ nhớ kết quả tính ngoài
   * giao dịch và không có lệnh ghi xen giữa. ttl (ms, theo đồng hồ của lõi): số liệu còn phụ thuộc giờ hiện tại (kỳ đang chạy so cùng mốc
   * kỳ trước) thì tính lại sau chừng ấy thời gian dù không ai ghi. key phải gồm mọi tham số (kể cả ngày hôm nay nếu fn dùng).
   * Kết quả dùng chung cho mọi người gọi: người gọi không được sửa giá trị trả về; số theo phạm vi người xem phải nằm trong key.
   */
  const memoCache = new Map();
  const MEMO_MAX = 800;
  /** Kết quả đã nhớ còn đúng (hoặc undefined). */
  function memoHit(key, ttl = 0) {
    const e = memoCache.get(key);
    if (!e) return undefined;
    const t = now();
    if ((ttl && (t < e.at || t - e.at >= ttl)) || !store.fresh(e.deps)) { memoCache.delete(key); return undefined; }
    store.adopt(e.deps);
    memoCache.delete(key); memoCache.set(key, e); // dùng gần đây: để lại lâu hơn
    return e;
  }
  function memo(key, fn, ttl = 0) {
    if (!store.track) return fn();
    const e = memoHit(key, ttl);
    if (e) return e.value;
    const t = now(), r = store.track(fn);
    if (r.ok) {
      memoCache.set(key, { value: r.value, deps: r.deps, at: t });
      if (memoCache.size > MEMO_MAX) memoCache.delete(memoCache.keys().next().value);
    }
    return r.value;
  }
  /** Khoá ngắn cho danh sách mã (BO, người) trong key của memo. */
  const idsKey = (ids) => (ids ? ids.join(',') : '*');

  // ───────── Tiện ích chung ─────────
  /**
   * Dòng của một bảng nhỏ (người dùng, BO, kit, thiết bị) theo mã, cho danh sách và bảng tổng hợp cần tra rất nhiều lần mỗi yêu cầu:
   * đọc một lượt cả bảng rồi nhớ tới khi bảng đó đổi. Dòng trả về dùng chung, chỉ để đọc (không sửa). Trong giao dịch vừa sửa bảng đó
   * thì đọc thẳng từng dòng (không dựng lại cả bảng sau mỗi lệnh ghi). Không có thì null, như store[table].get.
   */
  const ROW_TABLES = ['users', 'sites', 'kits', 'devices'];
  function rowOf(table, id) {
    if (id === null || id === undefined) return null;
    if (store.track && typeof id === 'number' && ROW_TABLES.includes(table)) {
      const e = memoHit('rows:' + table);
      const m = e ? e.value : !store.inTx() ? memo('rows:' + table, () => new Map(store[table].find({}).map((x) => [x.id, x]))) : null;
      if (m) return m.get(id) || null;
    }
    return store[table].get(id);
  }
  const userName = (id) => { const u = id ? rowOf('users', id) : null; return u ? u.name : ''; };
  const siteName = (id) => { const s = id ? rowOf('sites', id) : null; return s ? s.name : ''; };
  const idList = (v, max = 500) => {
    if (!Array.isArray(v)) fail(400, 'bad_list', 'Danh sách không hợp lệ.');
    if (v.length > max) fail(400, 'too_many', `Tối đa ${max} mục mỗi lần.`);
    return [...new Set(v.map((x) => int(x, 1, 1e12) ?? fail(400, 'bad_id', 'Mã không hợp lệ.')))];
  };
  /** Mã thiết bị / kit / thẻ: chữ in hoa, số, - _ . / ; 2–40 ký tự. */
  const codeOf = (v, label = 'Mã') => {
    const c = cleanStr(v, 40).toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9][A-Z0-9._/-]{1,39}$/.test(c)) fail(400, 'bad_code', `${label} "${cleanStr(v, 40)}" không hợp lệ (2–40 ký tự: chữ, số, - _ . /).`);
    return c;
  };
  const codesOf = (v, max = 2000) => {
    const raw = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
    const list = raw.map((x) => cleanStr(String(x ?? ''), 40)).filter(Boolean);
    if (list.length > max) fail(400, 'too_many', `Tối đa ${max} mã mỗi lần.`);
    return [...new Set(list.map((x) => codeOf(x)))];
  };
  const posNum = (v, label, max = 1e6) => { const n = num(v); if (n === null || n < 0 || n > max) fail(400, 'bad_number', `${label} phải là số từ 0 đến ${max}.`); return n; };
  const reasonOf = (v, label = 'lý do') => { const r = cleanStr(v, 300); if (r.length < 3) fail(400, 'reason_required', `Cần ghi ${label}.`); return r; };

  /**
   * Đối chiếu: dữ liệu thiếu hoặc lệch không được tự sửa; ghi thành một dòng để team liên quan duyệt.
   * ref: khoá chống ghi trùng khi dòng cũ chưa xử lý xong.
   */
  function recon(source, team, level, entity, ref, text, data) {
    if (ref && store.recon.count({ ref, status: 'open' })) return null;
    const id = store.recon.insert({ ts: now(), source, team, level, entity, ref: ref || null, text, data: data ?? null, status: 'open', resolved_by: null, resolved_at: null, note: '' });
    if (level === 'high') notify({ roles: team === 'tech' ? ['tech_lead'] : team === 'sale' ? ['sale_head'] : ['lead'] }, 'warn', 'recon', `Cần đối chiếu: ${text}`, `recon:${id}`, `recon:${id}`);
    changed('recon');
    return id;
  }

  // ───────── Ảnh của hub (ảnh dung lượng thẻ, ảnh sự cố) ─────────
  function decodePhotos(list, min = 0) {
    const c = K.cfg, arr = Array.isArray(list) ? list : [];
    if (arr.length > c.maxPhotos) fail(400, 'too_many_photos', `Tối đa ${c.maxPhotos} ảnh mỗi lần.`);
    const out = arr.map((x) => decodeDataUrl(x, c.maxPhotoBytes) || fail(400, 'bad_photo', 'Có ảnh không hợp lệ hoặc quá lớn. Chụp lại rồi gửi lại.'));
    if (out.length < min) fail(400, 'photo_required', 'Cần ít nhất một ảnh.');
    return out;
  }
  function savePhotos(decoded, ref, siteId, user) {
    const t = now(), ids = [];
    decoded.forEach((d, i) => {
      const id = K.deps.token(16), ts = t + i;
      K.deps.files.put(id, d.bytes, d.mime, ts);
      store.photos.insert({ id, stop_id: null, task_id: null, user_id: user ? user.id : null, by: 'hub', ts, lat: null, lon: null, mime: d.mime, size: d.bytes.length, ref, site_id: siteId ?? null });
      ids.push(id);
    });
    return ids;
  }
  /** Quyền xem ảnh của hub: Logistics và Tech xem được; Sale chỉ xem ảnh sự cố ở BO của mình. */
  function canSeePhoto(user, ph) {
    if (G.OPS_STAFF.includes(user.role)) return true;
    if (isSale(user) && String(ph.ref || '').startsWith('inc:')) return user.role === 'sale_head' || H.cfg().saleSeesAll || (ph.site_id && (store.sites.get(ph.site_id) || {}).sale_id === user.id);
    return false;
  }

  const H = {
    K, G, store, now, off, today, cfg, setCfg, tcfg, isTeamVal, cfgView, labels, nextCode, uniq, ym, log, changed, notify, recon, reqKeyOf, replayOf, userName, siteName, rowOf, idList, codeOf, codesOf, posNum, reasonOf, memo, idsKey,
    ROLE_LABEL, TEAM_OF, addDays, isSale, leadOf, decodePhotos, savePhotos, canSeePhoto,
  };
  /** Khung so sánh WoW / MoM của kỳ P: kỳ đang chạy so cùng kỳ, giờ quay bỏ các ngày thẻ chưa nhập đủ (period.compareOf). */
  H.compare = (P) => compareOf(P, today(), now(), off, cfg().evalLagDays);
  K.hub = H;

  // ───────── Dữ liệu khởi đầu: danh mục loại thiết bị ─────────
  if (!store.dev_types.count({})) {
    const t = now();
    store.tx(() => { for (const [id, name, kind, core, sort] of DEFAULT_TYPES) store.dev_types.insert({ id, name, kind, core, sort, active: 1, total: 0, created_at: t }); });
  }

  H.stock = installStock(H);
  H.outlets = installOutlets(H);
  H.jobs = installJobs(H);
  H.cards = installCards(H);
  H.incidents = installIncidents(H);
  H.people = installPeople(H);
  H.report = installReport(H);
  H.importer = installImporter(H);

  // Nhịp định kỳ: sinh việc theo lịch, cảnh báo quá hạn. Gắn nối tiếp sau nhịp của Rider Live.
  const prevTick = hooks.tick;
  hooks.tick = (t) => { if (prevTick) prevTick(t); H.jobs.tick(t); H.people.tick(t); };

  R('GET', '/api/hub/ping', STAFF, () => ({ ok: true, now: now() }));
  /** Nhãn và hằng số cho giao diện: một nguồn duy nhất, giao diện không tự đặt lại tên trạng thái. */
  R('GET', '/api/hub/meta', STAFF, () => ({
    teams: TEAMS, roles: ROLE_LABEL, team_of: TEAM_OF, kit_st: KIT_ST, kit_kinds: KIT_KINDS, kit_core: KIT_CORE, kit_outside: KIT_OUTSIDE, kit_editable: KIT_EDITABLE,
    dev_cond: DEV_COND, health: HEALTH, card_st: CARD_ST, req_kind: REQ_KIND, support_kind: SUPPORT_KIND, req_st: REQ_ST, outlet_st: OUTLET_ST,
    job_types: Object.fromEntries(Object.entries(JOB_TYPES).map(([k, v]) => [k, { team: v.team, label: v.label }])), job_st: JOB_ST,
    incident_res: Object.fromEntries(Object.entries(INCIDENT_RES).map(([k, v]) => [k, v.label])), incident_st: INCIDENT_ST, zero_reasons: ZERO_REASONS, att_st: ATT_ST, rating: RATING, acc_move: ACC_MOVE,
    shifts: cfgView().shifts, cfg: { dailyStdHours: cfg().dailyStdHours, quotaWarnPct: cfg().quotaWarnPct, gbPerHour: cfg().gbPerHour, cardsPerKit: cfg().cardsPerKit, checkBeforeShip: cfg().checkBeforeShip, uploadPhotoRequired: cfg().uploadPhotoRequired },
  }));
  return H;
}
