// outlets.js — BO (dùng chung bảng sites với Rider Live) và yêu cầu của Sale: mở BO mới, hỗ trợ, kết thúc ghi hình.
import { cleanStr, cleanText, int, num, isDate, isHM, validCoord, addDays, weekday, boLabel, localDate, dayStart } from '../util.js';
import { fail } from '../core.js';
import { REQ_KIND, REQ_ST, OUTLET_ST, SUPPORT_KIND, KIT_KINDS, KIT_OUTSIDE, CARD_ST } from './defs.js';
import { periodOf, weekLabel } from './period.js';

export function installOutlets(H) {
  const { K, G, store, now, today, log, changed, notify, reasonOf, idList } = H;
  const { R } = K;
  const OUT_EDIT = ['admin', 'lead', 'logistic'];

  // ───────── Quyền của Sale: chỉ BO của mình (trừ khi cấu hình cho xem tất cả) ─────────
  // "Sale Lead xem mọi BO" (saleSeesAll) chỉ mở quyền XEM; ghi (sửa, kết thúc, hỗ trợ, gửi / sửa / huỷ yêu cầu) luôn cần đúng Sale phụ trách.
  const saleScope = (user) => user.role === 'sale' && !H.cfg().saleSeesAll;
  const READ_ONLY = 'Bạn chỉ được xem BO của Sale Lead khác; Sale phụ trách hoặc Head of Sale mới sửa được.';
  function outletOrFail(id, user, write = false) {
    const s = store.sites.get(K.idOf(id));
    if (!s || !s.active || s.type !== 'bo') fail(404, 'not_found', 'Không tìm thấy BO.');
    if (user && user.role === 'sale' && s.sale_id !== user.id && (write || saleScope(user))) fail(403, 'forbidden', saleScope(user) ? 'BO này không thuộc danh sách của bạn.' : READ_ONLY);
    return s;
  }
  /** Người này ghi được vào BO / yêu cầu không (Sale Lead chỉ BO của mình). Giao diện dùng để ẩn nút. */
  const canWriteOutlet = (s, user) => user.role !== 'sale' || s.sale_id === user.id;
  const daysOf = (v) => {
    if (v === undefined) return undefined;
    const arr = Array.isArray(v) ? v : String(v || '').split(',');
    return [...new Set(arr.map((d) => int(d, 1, 7)).filter((d) => d !== null))].sort().join(',');
  };
  /** Hôm đó BO có đổi thẻ không: đang ghi hình, đúng ngày trong tuần, không trong khoảng tạm nghỉ, trước ngày kết thúc (ngày đó Logistics thu hồi cả thẻ). */
  function swapDue(site, date) {
    if (site.ops_status !== 'live' || !site.swap_days) return false;
    if (!String(site.swap_days).split(',').includes(String(weekday(date)))) return false;
    if (site.pause_from && site.pause_to && date >= site.pause_from && date <= site.pause_to) return false;
    if (site.end_date && date >= site.end_date) return false;
    if (site.launch_date && date <= site.launch_date) return false; // ngày launch là ngày giao máy, chưa có thẻ để đổi
    return true;
  }
  function outletInput(b, cur) {
    const out = {};
    const has = (k) => b[k] !== undefined || !cur;
    if (has('name')) { out.name = cleanStr(b.name, 80); if (!out.name) fail(400, 'bad_name', 'Cần nhập tên BO.'); }
    if (b.code !== undefined) out.code = cleanStr(b.code, 30).toUpperCase();
    for (const k of ['address', 'contact', 'business', 'area']) if (b[k] !== undefined) out[k] = cleanStr(b[k], k === 'address' ? 200 : 80);
    if (b.phone !== undefined) out.phone = cleanStr(b.phone, 20);
    if (b.note !== undefined) out.note = cleanText(b.note, 500);
    if (b.lat !== undefined || b.lon !== undefined) {
      const lat = num(b.lat), lon = num(b.lon);
      if (lat === null && lon === null) { out.lat = null; out.lon = null; } else {
        if (!validCoord(lat, lon)) fail(400, 'bad_coord', 'Toạ độ không hợp lệ.');
        out.lat = +lat.toFixed(6); out.lon = +lon.toFixed(6);
      }
    }
    if (b.swap_days !== undefined) out.swap_days = daysOf(b.swap_days);
    for (const k of ['swap_from', 'swap_to']) if (b[k] !== undefined) { if (b[k] && !isHM(b[k])) fail(400, 'bad_time', 'Khung giờ đổi thẻ có dạng GG:PP.'); out[k] = b[k] || null; }
    if ((out.swap_from || (cur && cur.swap_from)) && (out.swap_to || (cur && cur.swap_to)) && (out.swap_from ?? cur.swap_from) >= (out.swap_to ?? cur.swap_to)) fail(400, 'bad_time', 'Giờ kết thúc khung đổi thẻ phải sau giờ bắt đầu.');
    for (const k of ['pause_from', 'pause_to', 'launch_date', 'end_date']) if (b[k] !== undefined) { if (b[k] && !isDate(b[k])) fail(400, 'bad_date', 'Ngày không hợp lệ.'); out[k] = b[k] || null; }
    if (b.quota_hours !== undefined) {
      if (b.quota_hours === null || b.quota_hours === '') out.quota_hours = null;
      else { const q = num(b.quota_hours); if (q === null || q <= 0 || q > 1e6) fail(400, 'bad_quota', 'Quota giờ quay là số giờ lớn hơn 0.'); out.quota_hours = +q.toFixed(1); }
    }
    if (b.sale_id !== undefined) {
      if (b.sale_id === null || b.sale_id === '') out.sale_id = null; else {
        const s = store.users.get(int(b.sale_id, 1, 1e12) ?? -1);
        if (!s || (s.role !== 'sale' && s.role !== 'sale_head')) fail(400, 'bad_sale', 'Người phụ trách phải là tài khoản Sale.');
        out.sale_id = s.id;
      }
    }
    return out;
  }

  // ───────── Số liệu giờ ghi hình của BO (nguồn duy nhất: card_records do Tech nhập) ─────────
  /** Ngày BO có máy ghi hình lần đầu (active). Dữ liệu cũ chưa có thì lấy ngày launch của BO đã từng ghi hình. */
  const activeOf = (s) => s.onboard_date || (['live', 'paused', 'ending', 'ended'].includes(s.ops_status) ? s.launch_date || null : null);
  /** Ngày onboard = ngày BO được ký (yêu cầu launch đầu tiên không huỷ). BO đã ghi hình mà chưa có ngày ký (dữ liệu nhập) thì lấy ngày active. */
  const onboardOf = (s) => s.signed_date || activeOf(s);
  /** Sale Lead được ghi BO onboard: người đã ký, không đổi khi BO giao cho người khác (dữ liệu cũ: Sale đang phụ trách). */
  const signerOf = (s) => (onboardOf(s) ? s.signed_by ?? s.sale_id ?? null : null);
  /** Các đợt ghi hình của BO [[từ, đến | null]]: từ ngày có máy tới ngày kết thúc; launch lại là một đợt mới. Dữ liệu cũ: ngày active tới ngày kết thúc. */
  function periodsOf(s) {
    if (Array.isArray(s.live_periods) && s.live_periods.length) return s.live_periods;
    const a = activeOf(s);
    return a ? [[a, s.end_date || null]] : [];
  }
  /** Các lần tạm nghỉ: những lần đã qua (lưu khi Sale đặt lịch mới) và lịch đang đặt. */
  const pausesOf = (s) => [...(Array.isArray(s.pauses) ? s.pauses : []), ...(s.pause_from && s.pause_to ? [[s.pause_from, s.pause_to]] : [])];
  /** Quota giờ quay tính từ lần launch gần nhất (đợt ghi hình cuối); các đợt trước vẫn xem được trong lịch sử của BO. */
  const quotaFrom = (s) => { const p = periodsOf(s); return p.length ? p[p.length - 1][0] : null; };
  /** Mức quota trên tỉ lệ chưa làm tròn: 'over' từ 100%, 'near' từ ngưỡng báo (đề xuất, Sale chốt). Chỉ xét BO còn ghi hình (QUOTA_ST). */
  const QUOTA_ST = ['live', 'paused', 'ending'];
  const quotaStatus = (used, quota, warn = H.cfg().quotaWarnPct) => { if (!quota) return null; const p = (used / quota) * 100; return p >= 100 ? 'over' : p >= warn ? 'near' : 'ok'; };
  const inSpans = (d, spans) => spans.some(([a, b]) => d >= a && (!b || d <= b));
  /** Ngày cuối thẻ ghi: cover_to giữ khoảng thẻ nằm ở BO lúc nhập; Tech sửa ngày quay về sau thì tính từ ngày quay mới tới cover_to (không kéo dài cover_to). */
  const lastDay = (r) => (r.cover_to && r.cover_to > r.shoot_date ? r.cover_to : r.shoot_date);
  /** Ngày kế tiếp (nhớ sẵn: báo cáo đi qua cùng các ngày rất nhiều lần). */
  const nextDay = new Map();
  const inc = (d) => { let n = nextDay.get(d); if (!n) nextDay.set(d, (n = addDays(d, 1))); return n; };
  /** Đợt ghi hình và các lần tạm nghỉ của từng BO, đọc một lần cho mỗi lượt tính (recDays gọi cho từng bản ghi). */
  const spansOf = (sites) => new Map([...sites.values()].map((s) => [s.id, { live: periodsOf(s), paused: pausesOf(s) }]));
  /**
   * Các ngày một thẻ đã ghi: từ ngày quay tới cover_to (hôm trước ngày thu thẻ), trừ ngày tạm nghỉ và ngày BO không trong đợt ghi hình.
   * Thẻ chỉ nằm trong những ngày đó (hoặc chỉ có ngày quay) thì tính cho cả khoảng. sp: { live, paused } của BO (spansOf).
   */
  function recDays(r, sp) {
    const e = lastDay(r);
    if (e === r.shoot_date) return [e];
    const all = [];
    for (let d = r.shoot_date; d <= e; d = inc(d)) all.push(d);
    if (!sp) return all;
    const on = all.filter((d) => !inSpans(d, sp.paused) && (!sp.live.length || inSpans(d, sp.live)));
    return on.length ? on : all;
  }
  /** Danh sách ngày [from, to] (dùng lại trong một lượt tính, khỏi cộng ngày từng bước cho từng BO / kit). */
  const dayList = (from, to) => { const out = []; for (let d = from; d <= to; d = inc(d)) out.push(d); return out; };
  const siteMap = (siteIds) => new Map(store.sites.find(siteIds ? { id: siteIds } : { type: 'bo' }).map((s) => [s.id, s]));
  const REC_COLS = ['site_id', 'kit_id', 'shoot_date', 'cover_to', 'hours', 'gb'];
  /**
   * Nhớ tạm trong một lượt đọc (memoRead: một yêu cầu GET, không có ghi xen giữa): bản ghi đã đọc cho một khoảng ngày và nhóm BO
   * được dùng lại cho mọi khoảng nằm trong đó (cùng BO hoặc ít BO hơn), nên Tổng quan / Dashboard Kinh doanh không đọc lại cùng dữ liệu.
   * Ngoài memoRead thì luôn đọc thẳng từ kho.
   */
  let memo = null;
  function memoRead(fn) {
    if (memo) return fn();
    memo = { recs: [], used: new Map() };
    try { return fn(); } finally { memo = null; }
  }
  const inRange = (r, from, to) => (to === null || r.shoot_date <= to) && (r.shoot_date >= from || (!!r.cover_to && r.cover_to >= from));
  /** Thứ tự cố định của bản ghi (theo mã): tổng số thực cộng theo cùng một thứ tự nên ra đúng cùng một số dù đọc theo đường nào. */
  const byId = (x, y) => x.id - y.id;
  /**
   * Bản ghi có ngày ghi rơi vào [from, to] (to = null: tới nay): ngày quay trong khoảng, hoặc ngày quay trước đó mà thẻ còn ghi tới khoảng này.
   * Hai lượt đọc theo chỉ mục (ngày quay; ngày ghi cuối), chỉ các cột cần cho giờ quay. Luôn trả theo mã bản ghi tăng dần, cả khi lọc lại từ
   * bản đã đọc của memoRead: cộng số thực theo thứ tự khác cho số lệch ở chữ số cuối (24,45 thành 24,449999…, làm tròn ra 24,5 hoặc 24,4),
   * để giờ quay đã nhớ (H.memo) giống nhau dù màn hình nào tính trước, và một BO có cùng một số ở mọi màn hình.
   */
  function recordsIn(siteIds, from, to) {
    if (memo) {
      const want = siteIds ? new Set(siteIds) : null;
      const hit = memo.recs.find((m) => m.from <= from && (m.to === null || (to !== null && m.to >= to)) && (!m.ids || (want && [...want].every((id) => m.ids.has(id)))));
      if (hit) {
        if (store.noteRead) store.noteRead('card_records'); // dùng lại bản đã đọc: số liệu đã nhớ (H.memo) vẫn phụ thuộc bảng thẻ
        return hit.rows.filter((r) => (!want || want.has(r.site_id)) && inRange(r, from, to));
      }
    }
    const a = { shoot_date: to === null ? { gte: from } : { gte: from, lte: to } }, b = { cover_to: { gte: from }, shoot_date: { lt: from } };
    if (siteIds) { a.site_id = siteIds; b.site_id = siteIds; }
    const rows = [...store.card_records.find(a, { cols: REC_COLS }), ...store.card_records.find(b, { cols: REC_COLS })].sort(byId);
    if (memo) memo.recs.push({ ids: siteIds ? new Set(siteIds) : null, from, to, rows });
    return rows;
  }
  /**
   * Giờ ghi hình theo BO và theo ngày trong [from, to] — nguồn duy nhất cho mọi báo cáo giờ quay (Tổng quan, Sale, BO, quota).
   * Giờ (và GB) của mỗi thẻ chia đều cho các ngày thẻ đã ghi (recDays). Số thẻ, thẻ 0 giờ, thẻ dưới 1 giờ tính theo ngày quay.
   * days[ngày] có mặt khi ngày đó có thẻ đã nhập (kể cả thẻ 0 giờ); unknown: ngày có bản ghi chưa rõ khoảng ngày ghi (cover_to trống: dữ liệu cũ,
   * lịch sử nhập từ file chưa điền được), giờ của bản ghi đó nằm ở ngày quay nên ngày đó không xét chuẩn giờ quay. Giữ số thô; làm tròn khi hiển thị.
   */
  // Số liệu tổng hợp từ cả lịch sử thẻ: nhớ (H.memo) tới khi bảng thẻ, BO, kit… đổi; người gọi chỉ đọc, không sửa kết quả.
  const hoursBySite = (siteIds, from, to) => H.memo(`hbs|${H.idsKey(siteIds)}|${from}|${to}`, () => hoursBySiteRaw(siteIds, from, to));
  function hoursBySiteRaw(siteIds, from, to) {
    const out = new Map(), sp = spansOf(siteMap(siteIds));
    for (const r of recordsIn(siteIds, from, to)) {
      let m = out.get(r.site_id); if (!m) { m = { total: 0, gb: 0, cards: 0, zero: 0, under1h: 0, days: {}, kits: {} }; out.set(r.site_id, m); }
      const day = (d) => m.days[d] || (m.days[d] = { hours: 0, gb: 0, cards: 0, zero: 0, under1h: 0 });
      if (r.shoot_date >= from) { m.cards++; if (!r.hours) m.zero++; if ((r.hours || 0) < 1) m.under1h++; const x = day(r.shoot_date); x.cards++; if (!r.hours) x.zero++; if ((r.hours || 0) < 1) x.under1h++; if (!r.cover_to) x.unknown = true; }
      const ds = recDays(r, sp.get(r.site_id)), hr = (r.hours || 0) / ds.length, gb = (r.gb || 0) / ds.length;
      const kk = r.kit_id || 0; // giờ theo kit: cùng cách chia theo ngày thẻ ghi như theo BO / theo ngày
      for (const d of ds) if (d >= from && d <= to) { const x = day(d); x.hours += hr; x.gb += gb; m.total += hr; m.gb += gb; m.kits[kk] = (m.kits[kk] || 0) + hr; }
    }
    return out;
  }
  /**
   * Giờ quay theo nhiều khoảng (chuỗi 12 tuần, 12 tháng): một lượt đọc bản ghi cho cả khoảng, chia theo ngày thẻ ghi như hoursBySite
   * nên cùng số với gọi hoursBySite riêng từng khoảng. ranges: [{ from, to }] không chồng nhau. Trả về [{ total, gb, cards, zero, under1h }] cùng thứ tự.
   * keep(site_id): chỉ cộng bản ghi của BO thoả điều kiện (Tổng quan: BO đang hoạt động), vẫn đọc chung một lượt.
   */
  function hoursSeries(siteIds, ranges, keep = null) {
    const out = ranges.map(() => ({ total: 0, gb: 0, cards: 0, zero: 0, under1h: 0 }));
    if (!ranges.length) return out;
    const from = ranges.reduce((a, x) => (x.from < a ? x.from : a), ranges[0].from), to = ranges.reduce((a, x) => (x.to > a ? x.to : a), ranges[0].to);
    const at = (d) => ranges.findIndex((w) => d >= w.from && d <= w.to);
    let sp = null;
    for (const r of recordsIn(siteIds, from, to)) {
      if (keep && !keep(r.site_id)) continue;
      const i = r.shoot_date >= from ? at(r.shoot_date) : -1, e = lastDay(r);
      if (i >= 0) { const o = out[i]; o.cards++; if (!r.hours) o.zero++; if ((r.hours || 0) < 1) o.under1h++; }
      // Thẻ ghi gọn trong một khoảng: cộng cả thẻ, không cần chia theo ngày (cùng kết quả với hoursBySite).
      if (i >= 0 && e <= ranges[i].to) { out[i].total += r.hours || 0; out[i].gb += r.gb || 0; continue; }
      if (!sp) sp = spansOf(siteMap(siteIds));
      const ds = recDays(r, sp.get(r.site_id)), hr = (r.hours || 0) / ds.length, gb = (r.gb || 0) / ds.length;
      for (const d of ds) { const j = d >= from && d <= to ? at(d) : -1; if (j >= 0) { out[j].total += hr; out[j].gb += gb; } }
    }
    return out;
  }
  /**
   * BO kit rời đi, với nhật ký cũ chưa ghi BO: kit chỉ rời BO khi xong việc thu hồi hoặc đổi kit hỏng, nên lấy BO của việc đó (xong cùng lúc).
   * Không tìm được đúng một BO thì để trống (đợt đó không tính kit cho BO nào).
   */
  function leftSite(kitId, ts) {
    const js = store.jobs.find({ type: ['recover', 'swap_faulty'], status: 'done', done_at: { gte: ts - 120000, lte: ts + 120000 } }).filter((j) => j.type === 'recover' || j.kit_id === kitId);
    const ids = new Set(js.map((j) => j.site_id).filter(Boolean));
    return ids.size === 1 ? [...ids][0] : null;
  }
  /** Số kit ở mỗi BO từng ngày trong [from, to], dựng lại từ nhật ký đổi trạng thái kit: kit tính cho BO từ ngày tới, không tính ngày rời đi. */
  function kitsByDay(siteIds, from, to) {
    const want = new Set(siteIds), out = new Map(), logs = new Map();
    for (const l of store.hub_log.find({ entity: 'kit', action: 'status', ts: { gte: dayStart(from, H.off) } }, { order: 'ts' })) {
      if (!l.data) continue;
      if (!logs.has(l.entity_id)) logs.set(l.entity_id, []);
      logs.get(l.entity_id).push(l);
    }
    const kits = new Map(store.kits.find({ status: 'at_bo', site_id: siteIds }).map((k) => [k.id, k]));
    for (const id of logs.keys()) if (!kits.has(id)) { const k = store.kits.get(id); if (k) kits.set(id, k); }
    const days = dayList(from, to), pos = new Map(days.map((d, i) => [d, i]));
    const add = (site, a, b) => {
      if (!want.has(site)) return;
      let m = out.get(site); if (!m) out.set(site, (m = new Map()));
      for (let i = a < from ? 0 : pos.get(a) ?? days.length; i < days.length && days[i] < b; i++) m.set(days[i], (m.get(days[i]) || 0) + 1);
    };
    for (const k of kits.values()) {
      // Đi ngược từ hiện tại: trước mỗi lần đổi trạng thái, kit ở BO ghi trong nhật ký (nếu rời BO). Nhật ký cũ không ghi BO thì lấy BO của việc thu hồi / đổi kit.
      let at = k.status === 'at_bo' ? k.site_id : null, end = addDays(to, 1);
      const ls = logs.get(k.id) || [];
      for (let i = ls.length - 1; i >= 0; i--) {
        const x = ls[i].data, d = localDate(ls[i].ts, H.off);
        if (at) add(at, d, end);
        at = x.from === 'at_bo' ? ('site_id' in x ? x.site_id : leftSite(k.id, ls[i].ts)) || null : null;
        end = d;
      }
      if (at) add(at, from, end);
    }
    return out;
  }
  const PENDING_CARD = ['at_bo', 'with_fo', 'returned', 'to_tech', 'at_tech', 'bad', 'lost'];
  /**
   * Các ngày thẻ chưa nhập đã ghi ở BO: từ ngày đặt thẻ tới hôm trước ngày thu thẻ. Thẻ còn ở BO thì chưa biết ngày thu (còn mở).
   * Thẻ rời BO không qua lượt đổi thẻ (Lead ghi mất / hỏng ngay tại BO) thì tới ngày đổi trạng thái đó, không để mở mãi.
   */
  function pendingSpan(c) {
    const a = localDate(c.bo_in, H.off);
    let b;
    // Lead ghi mất / hỏng ngay tại BO: thẻ rời BO đúng lúc đổi trạng thái (bo_out = since), thẻ vẫn ghi tới ngày đó.
    if (c.bo_out && ['bad', 'lost'].includes(c.status) && c.since === c.bo_out) b = localDate(c.bo_out, H.off);
    else if (c.bo_out) b = addDays(localDate(c.bo_out, H.off), -1);
    else if (c.status === 'at_bo') b = null;
    else { const l = store.hub_log.find({ entity: 'card', entity_id: c.id, ts: { gte: c.bo_in } }, { order: 'ts', desc: true, limit: 30 }).find((x) => x.data && x.data.status === c.status); b = localDate(l ? l.ts : c.updated_at || c.bo_in, H.off); }
    return [a, b !== null && b < a ? a : b];
  }
  /**
   * Ngày được xét chuẩn giờ quay của từng BO trong [from, to] (không quá hôm nay): BO trong đợt ghi hình, không tạm nghỉ, có kit,
   * ngày đó có thẻ đã nhập, mọi bản ghi của ngày đó rõ khoảng ngày ghi, và không còn thẻ nào của ngày đó chưa nhập (thẻ còn ở BO, đang về,
   * chờ nhập, hỏng hoặc mất). Ngày khác là "chưa đủ dữ liệu", không tính 0 giờ. Trả về Map(BO → Map(ngày → { hours, kits })).
   */
  function rateDays(sites, from, to) {
    const d0 = today();
    if (to > d0) to = d0;
    if (!sites.length || from > to) return new Map();
    const ids = sites.map((s) => s.id);
    // Đọc lại BO trong lượt tính để kết quả đã nhớ phụ thuộc đúng bảng BO (đợt ghi hình, tạm nghỉ).
    return H.memo(`rate|${H.idsKey(ids)}|${from}|${to}`, () => { const cur = siteMap(ids); return rateDaysRaw(sites.map((s) => cur.get(s.id) || s), ids, from, to); });
  }
  function rateDaysRaw(sites, ids, from, to) {
    const out = new Map();
    const hrs = hoursBySite(ids, from, to), kits = kitsByDay(ids, from, to), wait = new Map();
    for (const c of store.cards.find({ status: PENDING_CARD, site_id: ids })) {
      if (!c.bo_in || (['bad', 'lost'].includes(c.status) && store.card_records.count({ card_id: c.id }))) continue;
      if (!wait.has(c.site_id)) wait.set(c.site_id, []);
      wait.get(c.site_id).push(pendingSpan(c));
    }
    const days = dayList(from, to);
    for (const s of sites) {
      const live = periodsOf(s), paused = pausesOf(s), h = (hrs.get(s.id) || { days: {} }).days, k = kits.get(s.id), w = wait.get(s.id) || [], m = new Map();
      for (const d of days) {
        const n = k ? k.get(d) || 0 : 0;
        if (n && h[d] && !h[d].unknown && inSpans(d, live) && !inSpans(d, paused) && !inSpans(d, w)) m.set(d, { hours: h[d].hours, kits: n });
      }
      out.set(s.id, m);
    }
    return out;
  }
  function outletBrief(s, ctx) {
    const kits = ctx.kitsBySite.get(s.id) || [];
    const h = ctx.hours.get(s.id);
    return {
      id: s.id, code: s.code || '', name: s.name, address: s.address || '', phone: s.phone || '', contact: s.contact || '', business: s.business || '', area: s.area || '',
      ops_status: s.ops_status || 'planned', status_label: OUTLET_ST[s.ops_status || 'planned'], sale: s.sale_id ? { id: s.sale_id, name: H.userName(s.sale_id) } : null,
      launch_date: s.launch_date, end_date: s.end_date, swap_days: s.swap_days || '', swap_from: s.swap_from, swap_to: s.swap_to, pause_from: s.pause_from, pause_to: s.pause_to,
      has_coord: s.lat !== null && s.lon !== null, lat: s.lat, lon: s.lon, onboard_date: onboardOf(s), active_date: activeOf(s), quota_hours: s.quota_hours ?? null, quota_from: quotaFrom(s),
      used_hours: ctx.used ? +(ctx.used.get(s.id) || 0).toFixed(1) : null, quota_pct: ctx.used && s.quota_hours ? Math.floor(((ctx.used.get(s.id) || 0) / s.quota_hours) * 1000) / 10 : null, // làm tròn xuống: chưa tới ngưỡng thì không hiện ngưỡng
      quota_status: ctx.used && QUOTA_ST.includes(s.ops_status) ? quotaStatus(ctx.used.get(s.id) || 0, s.quota_hours) : null,
      kits: kits.length, kit_codes: kits.map((k) => k.code), kits_by_kind: kits.reduce((a, k) => ((a[k.kind] = (a[k.kind] || 0) + 1), a), {}),
      hours_7d: h ? +h.total.toFixed(2) : 0, cards_7d: h ? h.cards : 0, zero_7d: h ? h.zero : 0,
      open_incidents: ctx.incBySite.get(s.id) || 0,
    };
  }
  /**
   * Tổng giờ quay đã dùng của mỗi BO kể từ lần launch gần nhất (để so với quota), chia theo ngày thẻ ghi như hoursBySite.
   * BO cùng ngày launch đọc chung một lượt, chỉ bản ghi còn ghi tới sau ngày đó (theo chỉ mục ngày quay / ngày ghi cuối), không quét cả lịch sử thẻ.
   */
  const usedHours = (siteIds) => H.memo(`used|${H.idsKey(siteIds)}`, () => usedHoursRaw(siteIds));
  function usedHoursRaw(siteIds) {
    const out = new Map(), sites = siteMap(siteIds), sp = spansOf(sites), byQ = new Map();
    for (const s of sites.values()) { const q = quotaFrom(s) || ''; if (!byQ.has(q)) byQ.set(q, []); byQ.get(q).push(s.id); }
    const rows = [];
    for (const [q, ids] of byQ) rows.push(...(q ? recordsIn(ids, q, null) : store.card_records.find({ site_id: ids }, { cols: REC_COLS }).sort(byId)));
    for (const r of rows) {
      const s = sites.get(r.site_id), q = quotaFrom(s);
      if (q && lastDay(r) < q) continue;
      if (!q || r.shoot_date >= q) { out.set(r.site_id, (out.get(r.site_id) || 0) + (r.hours || 0)); continue; } // cả thẻ sau ngày launch: không cần chia theo ngày
      const ds = recDays(r, sp.get(r.site_id)), hr = (r.hours || 0) / ds.length;
      out.set(r.site_id, (out.get(r.site_id) || 0) + hr * ds.filter((d) => d >= q).length);
    }
    return out;
  }
  /**
   * Điền khoảng ngày ghi (cover_to) cho bản ghi chưa có: dữ liệu trước khi giờ của thẻ chia theo ngày, lịch sử nhập từ file (chỉ có ngày quay).
   * Thẻ còn giữ ngày đặt / ngày thu của lượt đó thì tới hôm trước ngày thu; không thì tới hôm trước lần đổi thẻ kế tiếp của BO
   * (ngày quay kế tiếp, mọi thẻ của BO đổi cùng lượt), nếu trong 7 ngày. Không rõ thì để trống: giờ nằm ở ngày quay, ngày đó không xét chuẩn giờ quay.
   * Trả về số bản ghi đã điền; người gọi ghi nhật ký trong cùng giao dịch.
   */
  function fillCover(siteIds) {
    const rows = store.card_records.find(siteIds ? { cover_to: null, site_id: siteIds } : { cover_to: null });
    if (!rows.length) return 0;
    const dates = new Map(), lo = rows.reduce((a, r) => (r.shoot_date < a ? r.shoot_date : a), rows[0].shoot_date), hi = rows.reduce((a, r) => (r.shoot_date > a ? r.shoot_date : a), rows[0].shoot_date);
    for (const r of store.card_records.find({ site_id: [...new Set(rows.map((x) => x.site_id))], shoot_date: { gte: lo, lte: addDays(hi, 7) } })) { if (!dates.has(r.site_id)) dates.set(r.site_id, new Set()); dates.get(r.site_id).add(r.shoot_date); }
    for (const [k, v] of dates) dates.set(k, [...v].sort());
    let n = 0;
    for (const r of rows) {
      const c = r.card_id ? store.cards.get(r.card_id) : null;
      let to = null;
      if (c && c.bo_in && c.bo_out && c.site_id === r.site_id && localDate(c.bo_in, H.off) === r.shoot_date) to = addDays(localDate(c.bo_out, H.off), -1);
      else { const next = (dates.get(r.site_id) || []).find((d) => d > r.shoot_date); if (next && next <= addDays(r.shoot_date, 7)) to = addDays(next, -1); }
      if (!to) continue;
      store.card_records.update(r.id, { cover_to: to < r.shoot_date ? r.shoot_date : to });
      n++;
    }
    return n;
  }
  function listCtx(siteIds) {
    const kitsBySite = new Map();
    for (const k of store.kits.find({ status: KIT_OUTSIDE })) { if (!k.site_id) continue; if (!kitsBySite.has(k.site_id)) kitsBySite.set(k.site_id, []); kitsBySite.get(k.site_id).push(k); }
    const incBySite = new Map();
    for (const i of store.incidents.find({ status: ['open', 'ack'] })) incBySite.set(i.site_id, (incBySite.get(i.site_id) || 0) + 1);
    const to = today(), from = addDays(to, -6);
    return { kitsBySite, incBySite, hours: hoursBySite(siteIds, from, to), used: usedHours(siteIds) };
  }
  /**
   * Số liệu tuần của BO (giờ quay tuần này / tuần trước, giờ mỗi kit mỗi ngày so chuẩn, mức quota): lấy đúng từ bảng của Head of Sale
   * (report.hosBlock) để màn hình BO và Dashboard Kinh doanh cùng một nguồn số. Chỉ tính khi giao diện xin (?metrics=1).
   */
  const WEEK_KEYS = ['hours', 'cmp_hours', 'prev_hours', 'delta_pct', 'cards', 'zero', 'per_kit_day', 'prev_per_kit_day', 'below_std', 'eval_days', 'eval_kits', 'quota_status', 'quota_eta', 'pace_daily'];
  function weekMetrics(saleId, used) {
    if (!H.report || !H.report.hosBlock) return null;
    const P = periodOf('week', null, today());
    const b = H.report.hosBlock(saleId, 'week', P, { used, lite: true });
    const rows = new Map(b.outlets.map((r) => [r.id, Object.fromEntries(WEEK_KEYS.map((k) => [k, r[k] ?? null]))]));
    return { rows, info: { key: P.key, label: weekLabel(P.key), prev_label: weekLabel(P.prev), from: P.from, to: P.to, eval: b.eval, cmp: H.compare(P).info, hours: b.kpi.hours } };
  }
  R('GET', '/api/hub/outlets', G.STAFF, ({ user, q }) => memoRead(() => {
    let rows = store.sites.find({ active: 1, type: 'bo' }, { order: 'name' });
    if (saleScope(user)) rows = rows.filter((s) => s.sale_id === user.id);
    if (q.status) { const st = String(q.status).split(','); rows = rows.filter((s) => st.includes(s.ops_status || 'planned')); }
    if (q.q) { const s = String(q.q).toLowerCase(); rows = rows.filter((x) => `${x.name} ${x.code || ''} ${x.address || ''}`.toLowerCase().includes(s)); }
    const ctx = listCtx(saleScope(user) ? rows.map((r) => r.id) : null);
    // Danh sách Sale để lọc và giao BO (Sale Lead chỉ xem BO của mình thì không cần).
    const sales = saleScope(user) ? [] : store.users.find({ role: ['sale', 'sale_head'], active: 1 }, { order: 'name' }).map((u) => ({ id: u.id, name: u.name, role: u.role }));
    if (q.metrics !== '1') return { outlets: rows.map((s) => outletBrief(s, ctx)), sales };
    // Giờ đã dùng vừa tính cho danh sách (đủ mọi BO khi không lọc) thì bảng tuần dùng lại, không đọc lần hai.
    const wk = weekMetrics(saleScope(user) ? user.id : null, q.status || q.q ? null : ctx.used);
    return { outlets: rows.map((s) => ({ ...outletBrief(s, ctx), week: wk ? wk.rows.get(s.id) || null : null })), week: wk ? wk.info : null, sales };
  }));
  R('GET', '/api/hub/outlets/:id', G.STAFF, ({ user, p, q }) => memoRead(() => {
    const s = outletOrFail(p.id, user);
    const ctx = listCtx([s.id]);
    const days = int(q.days, 7, 92) || 14;
    const to = today(), from = addDays(to, -(days - 1));
    const h = hoursBySite([s.id], from, to).get(s.id) || { days: {}, kits: {} };
    const series = [];
    for (let d = from; d <= to; d = addDays(d, 1)) { const x = h.days[d] || { hours: 0, cards: 0, zero: 0 }; series.push({ date: d, hours: +x.hours.toFixed(2), cards: x.cards, zero: x.zero }); }
    const kits = store.kits.find({ site_id: s.id, status: KIT_OUTSIDE }).map((k) => H.stock.kitView(k));
    const byKit = h.kits; // cùng nguồn với chuỗi theo ngày (hoursBySite): giờ của thẻ chia cho các ngày thẻ ghi
    const showJobs = !H.isSale(user);
    const wk = q.metrics === '1' ? weekMetrics(s.sale_id || null) : null;
    return {
      outlet: { ...outletBrief(s, ctx), note: s.note || '', periods: periodsOf(s).map(([a, b]) => ({ from: a, to: b, hours: +((hoursBySite([s.id], a, b || to).get(s.id) || { total: 0 }).total).toFixed(1) })), ...(wk ? { week: wk.rows.get(s.id) || null } : {}) },
      can_write: canWriteOutlet(s, user),
      ...(wk ? { week: wk.info } : {}),
      series, kits, hours_by_kit: Object.entries(byKit).map(([k, v]) => ({ kit_id: +k || null, kit: +k ? (store.kits.get(+k) || {}).code : 'Chưa rõ kit', hours: +v.toFixed(2) })),
      cards: store.cards.find({ site_id: s.id, status: 'at_bo' }).map((c) => ({ id: c.id, code: c.code, since: c.since, status_label: CARD_ST[c.status] })),
      // Thẻ 0 giờ theo số giờ (GB nhỏ làm tròn ra 0 giờ cũng tính), cùng cách đếm với chuỗi theo ngày ở trên.
      zero_cards: store.card_records.find({ site_id: s.id, shoot_date: { gte: from, lte: to } }, { order: 'shoot_date', desc: true }).filter((r) => !r.hours).map((r) => ({ code: r.code, date: r.shoot_date, reason: r.zero_reason })),
      incidents: store.incidents.find({ site_id: s.id }, { order: 'created_at', desc: true, limit: 30 }).map((i) => H.incidents.brief(i, user)),
      requests: store.requests.find({ site_id: s.id }, { order: 'created_at', desc: true, limit: 30 }).map(reqBrief),
      jobs: showJobs ? store.jobs.find({ site_id: s.id, status: ['open', 'doing'] }, { order: 'due_at' }).map(H.jobs.viewFor(user)) : [],
    };
  }));
  // ───────── Ai sửa trường nào của BO ─────────
  // Sale: Sale phụ trách (Head of Sale giao), quota giờ quay, ngành hàng, khu vực, mã BO. Logistics: địa chỉ, toạ độ, liên hệ, SĐT, lịch đổi thẻ, ghi chú.
  // Mã BO: Sale và Quản trị sửa; Logistics chỉ điền khi BO chưa có mã. Ngày launch đổi ở yêu cầu launch; ngày kết thúc bằng nút "Kết thúc ghi hình".
  const isLogi = (u) => u.role === 'lead' || u.role === 'logistic';
  const same = (a, b) => (a ?? '') === (b ?? '') || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-6);
  function ownFields(user, patch, cur) {
    for (const k of ['launch_date', 'end_date']) {
      if (patch[k] === undefined) continue;
      if (!same(patch[k], cur ? cur[k] : null)) fail(409, 'use_flow', k === 'launch_date' ? 'Ngày launch đổi ở yêu cầu launch của BO (mục Yêu cầu), để yêu cầu và việc giao khớp theo.' : 'Ngày kết thúc đặt bằng nút "Kết thúc ghi hình" của BO, để hệ thống tạo việc thu hồi kit.');
      delete patch[k];
    }
    if (!isLogi(user)) return patch;
    const changedKey = (k) => patch[k] !== undefined && !same(patch[k], cur ? cur[k] : null);
    if (changedKey('quota_hours')) fail(403, 'forbidden', 'Quota giờ quay do Sale chốt.');
    if (cur && changedKey('sale_id')) fail(403, 'forbidden', 'Sale phụ trách BO do Head of Sale giao.');
    if (cur && (changedKey('business') || changedKey('area'))) fail(403, 'forbidden', 'Ngành hàng và khu vực của BO do Sale ghi.');
    if (cur && cur.code && changedKey('code')) fail(403, 'forbidden', 'BO đã có mã; đổi mã do Sale hoặc Quản trị.');
    if (cur) for (const k of ['quota_hours', 'sale_id', 'business', 'area', 'code']) if (patch[k] !== undefined && !changedKey(k)) delete patch[k];
    return patch;
  }

  R('POST', '/api/hub/outlets', OUT_EDIT, ({ user, b }) => {
    const row = { type: 'bo', radius: K.cfg.arriveRadiusM, active: 1, created_at: now(), updated_at: now(), ops_status: 'planned', lat: null, lon: null, ...ownFields(user, outletInput(b, null), null) };
    if (row.code && store.sites.count({ code: row.code, active: 1 })) fail(409, 'exists', `Đã có BO mã ${row.code}.`);
    row.id = store.sites.insert(row);
    log('outlet', row.id, 'create', `${user.name} thêm ${boLabel(row.name)}.`, user);
    changed('outlets');
    if (row.lat !== null) K.toOps({ t: 'site', op: 'upsert', site: store.sites.get(row.id) });
    return { outlet: outletBrief(store.sites.get(row.id), listCtx([row.id])) };
  });
  // ───────── Tạm nghỉ ─────────
  const inPause = (s, d) => !!(s.pause_from && s.pause_to && d >= s.pause_from && d <= s.pause_to);
  /**
   * Đưa trạng thái BO về đúng lịch tạm nghỉ: đang ghi hình mà hôm nay trong khoảng tạm nghỉ thì tạm nghỉ; đang tạm nghỉ mà hôm nay
   * ngoài khoảng (đã hết, bị dời hoặc bị xoá) thì ghi hình lại ngay. Mỗi lần đổi có nhật ký và việc đổi thẻ được đồng bộ. Trả về true nếu có đổi.
   * BO tạm nghỉ không có ngày (vd. nhập từ file) chỉ ghi hình lại khi có người sửa lịch tạm nghỉ (actor): nhịp định kỳ không tự đoán.
   */
  function syncPause(s, d, actor) {
    const t = now();
    const outside = s.pause_from && s.pause_to ? !inPause(s, d) : !!actor;
    if (s.ops_status === 'live' && inPause(s, d)) {
      store.sites.update(s.id, { ops_status: 'paused', updated_at: t });
      log('outlet', s.id, 'paused', `${s.name} tạm nghỉ từ ${s.pause_from} đến ${s.pause_to} theo lịch của Sale.`, actor);
    } else if (s.ops_status === 'paused' && outside) {
      store.sites.update(s.id, { ops_status: 'live', updated_at: t });
      const why = actor ? `${actor.name} sửa lịch tạm nghỉ` : s.pause_to && d > s.pause_to ? `hết tạm nghỉ (tới ${s.pause_to})` : 'lịch tạm nghỉ không còn phủ hôm nay';
      log('outlet', s.id, 'resumed', `${s.name} ghi hình lại: ${why}.`, actor, { pause_from: s.pause_from || null, pause_to: s.pause_to || null });
    } else return false;
    H.jobs.syncSwaps(store.sites.get(s.id), actor);
    changed('outlets');
    return true;
  }
  /**
   * Khoảng tạm nghỉ sau khi sửa: đủ hai ngày hoặc để trống cả hai, ngày bắt đầu không sau ngày kết thúc. Ghi lùi (ngày bắt đầu mới ở quá khứ)
   * làm đổi cách tính chuẩn giờ quay đã qua, nên chỉ Logistic Lead, Head of Sale, Quản trị làm được và phải ghi lý do.
   */
  function pauseCheck(s, patch, user, b) {
    if (patch.pause_from === undefined && patch.pause_to === undefined) return null;
    const from = patch.pause_from !== undefined ? patch.pause_from : s.pause_from || null;
    const to = patch.pause_to !== undefined ? patch.pause_to : s.pause_to || null;
    if (from === (s.pause_from || null) && to === (s.pause_to || null)) return null; // gửi lại khoảng cũ: không đổi gì
    if (!from !== !to) fail(400, 'bad_pause', 'Nhập đủ ngày bắt đầu và ngày kết thúc tạm nghỉ, hoặc để trống cả hai.');
    if (from && from > to) fail(400, 'bad_pause', 'Ngày kết thúc tạm nghỉ phải từ ngày bắt đầu trở đi.');
    const backdate = !!from && from < today() && !(from === s.pause_from && s.ops_status === 'paused'); // đang nghỉ thì được rút ngắn / kéo dài
    if (!backdate) return null;
    if (!['lead', 'sale_head', 'admin'].includes(user.role)) fail(400, 'past_pause', 'Ngày bắt đầu tạm nghỉ không được ở quá khứ. Cần ghi lùi thì nhờ Head of Sale hoặc Logistic Lead sửa, kèm lý do.');
    return { from, to, reason: reasonOf(b.pause_reason, 'lý do ghi lùi ngày tạm nghỉ') };
  }
  R('PATCH', '/api/hub/outlets/:id', [...OUT_EDIT, 'sale', 'sale_head'], ({ user, p, b }) => {
    const s = outletOrFail(p.id, user, true);
    let input = b;
    if (H.isSale(user)) { // Sale sửa được thông tin liên hệ, lịch đổi thẻ, quota, mã BO của BO mình; Head of Sale giao BO cho Sale Lead
      input = {};
      const keys = ['contact', 'phone', 'note', 'swap_days', 'swap_from', 'swap_to', 'pause_from', 'pause_to', 'address', 'business', 'quota_hours', 'code', 'launch_date', 'end_date'];
      if (user.role === 'sale_head') keys.push('sale_id', 'area');
      for (const k of keys) if (b[k] !== undefined) input[k] = b[k];
    }
    const patch = { ...ownFields(user, outletInput(input, s), s), updated_at: now() };
    if (patch.code && patch.code !== s.code && store.sites.count({ code: patch.code, active: 1 })) fail(409, 'exists', `Đã có BO mã ${patch.code}.`);
    const back = pauseCheck(s, patch, user, b);
    const schedChanged = ['swap_days', 'swap_from', 'swap_to', 'pause_from', 'pause_to'].some((k) => patch[k] !== undefined && patch[k] !== s[k]);
    const reassigned = patch.sale_id !== undefined && patch.sale_id !== (s.sale_id ?? null);
    const pauseChanged = ['pause_from', 'pause_to'].some((k) => patch[k] !== undefined && (patch[k] || null) !== (s[k] || null));
    // Đổi lịch tạm nghỉ: phần đã qua của lần tạm nghỉ cũ được lưu lại để các kỳ cũ vẫn trừ đúng ngày nghỉ.
    const pf = patch.pause_from !== undefined ? patch.pause_from : s.pause_from, pt = patch.pause_to !== undefined ? patch.pause_to : s.pause_to, y = addDays(today(), -1);
    if (s.pause_from && s.pause_to && (pf !== s.pause_from || pt !== s.pause_to) && s.pause_from <= y) patch.pauses = [...(s.pauses || []), [s.pause_from, s.pause_to < y ? s.pause_to : y]];
    // Giao BO cho Sale Lead khác: BO onboard vẫn ghi cho người đã ký.
    if (reassigned && onboardOf(s) && !s.signed_by) Object.assign(patch, { signed_date: onboardOf(s), signed_by: s.sale_id ?? null });
    // Sửa ngày kết thúc: đợt ghi hình cuối kết thúc theo ngày mới.
    if (patch.end_date && patch.end_date !== s.end_date && s.end_date) { const per = periodsOf(s).map((x) => [...x]), last = per[per.length - 1]; if (last && last[1] === s.end_date) { last[1] = patch.end_date; patch.live_periods = per; } }
    store.tx(() => {
      store.sites.update(s.id, patch);
      log('outlet', s.id, 'update', `${user.name} sửa thông tin ${boLabel(s.name)}${schedChanged ? ' (đổi lịch đổi thẻ; việc từ hôm nay được đồng bộ lại)' : ''}.`, user, patch);
      if (back) log('outlet', s.id, 'pause_backdate', `${user.name} ghi lùi tạm nghỉ ${boLabel(s.name)} từ ${back.from} đến ${back.to}: ${back.reason}.`, user, back);
      // Đổi lịch tạm nghỉ có hiệu lực ngay (tạm nghỉ từ hôm nay, hoặc xoá / dời khi đang nghỉ thì ghi hình lại), không chờ nhịp định kỳ.
      // Sửa thông tin khác (liên hệ, toạ độ…) không đụng tới trạng thái tạm nghỉ.
      if (!(pauseChanged && syncPause(store.sites.get(s.id), today(), user)) && schedChanged) H.jobs.syncSwaps(store.sites.get(s.id), user);
      if (reassigned) {
        // Giao lại BO: mọi yêu cầu của BO (đang xử lý và đã đóng) đi theo Sale phụ trách mới; quyền xem / sửa / huỷ theo người phụ trách hiện tại.
        const reqs = store.requests.find({ site_id: s.id });
        for (const r of reqs) if (r.sale_id !== patch.sale_id) store.requests.update(r.id, { sale_id: patch.sale_id });
        log('outlet', s.id, 'reassign', `${user.name} giao ${boLabel(s.name)} cho ${patch.sale_id ? H.userName(patch.sale_id) : '"Chưa giao Sale"'} (trước: ${s.sale_id ? H.userName(s.sale_id) : 'chưa giao'}); ${reqs.length} yêu cầu của BO chuyển theo.`, user, { from: s.sale_id ?? null, to: patch.sale_id, requests: reqs.length });
      }
    });
    if (reassigned && patch.sale_id) notify({ ids: [patch.sale_id] }, 'info', 'outlet', `${user.name} giao ${boLabel(s.name)} cho bạn phụ trách.`, `outlet:${s.id}`);
    changed(...(reassigned ? ['outlets', 'requests'] : ['outlets']));
    const site = store.sites.get(s.id);
    if (site.lat !== null) K.toOps({ t: 'site', op: 'upsert', site });
    return { outlet: outletBrief(site, listCtx([s.id])) };
  });

  // ───────── Rider Live sửa / xoá điểm là BO (bảng sites dùng chung) ─────────
  // BO thuộc luồng Ops Hub: Rider Live không đổi loại, không xoá BO đang dùng; mọi lần ghi có nhật ký Ops Hub, trong cùng giao dịch với lệnh ghi.
  const BO_BUSY = { live: 'đang ghi hình', paused: 'đang tạm nghỉ, máy vẫn ở BO', ending: 'đang thu hồi kit' };
  function riderCreate(site, user) {
    // BO mới (hoặc điểm đổi sang BO) ở Rider Live là BO chờ launch như BO tạo ở Ops Hub: mọi bảng đếm "chờ launch" cùng một trạng thái.
    if (!site.ops_status) { store.sites.update(site.id, { ops_status: 'planned' }); site.ops_status = 'planned'; }
    log('outlet', site.id, 'create', `${user.name} thêm ${boLabel(site.name)} ở Rider Live.`, user);
    changed('outlets');
  }
  function riderEdit(cur, patch, user) {
    if (patch.type !== undefined && patch.type !== 'bo') fail(409, 'bo_type', `${boLabel(cur.name)} là BO của Ops Hub, không đổi sang loại điểm khác ở Rider Live. BO không dùng nữa thì kết thúc ghi hình ở Ops Hub.`);
    const notes = [['name', 'tên'], ['address', 'địa chỉ'], ['contact', 'người liên hệ'], ['phone', 'SĐT'], ['lat', 'toạ độ'], ['radius', 'bán kính nhận diện']].filter(([k]) => patch[k] !== undefined && !same(patch[k], cur[k])).map(([, l]) => l);
    log('outlet', cur.id, 'update', `${user.name} sửa ${boLabel(cur.name)} ở Rider Live${notes.length ? `: ${notes.join(', ')}` : ''}.`, user, patch);
    changed('outlets');
  }
  function riderRemove(cur, user) {
    const why = [];
    if (BO_BUSY[cur.ops_status]) why.push(BO_BUSY[cur.ops_status]);
    const kits = store.kits.count({ site_id: cur.id, status: KIT_OUTSIDE });
    if (kits) why.push(`còn ${kits} kit ở ngoài`);
    const jobs = store.jobs.count({ site_id: cur.id, status: H.jobs.OPEN });
    if (jobs) why.push(`còn ${jobs} việc đang mở`);
    const reqs = store.requests.find({ site_id: cur.id }).filter((r) => !['closed', 'cancelled'].includes(r.status)).length;
    if (reqs) why.push(`còn ${reqs} yêu cầu đang xử lý`);
    if (why.length) fail(409, 'bo_in_use', `Không xoá được ${boLabel(cur.name)}: ${why.join('; ')}. Xử lý ở Ops Hub trước (kết thúc ghi hình, thu hồi kit, đóng việc, huỷ yêu cầu).`);
    log('outlet', cur.id, 'delete', `${user.name} xoá ${boLabel(cur.name)} ở Rider Live.`, user);
    changed('outlets');
  }

  // ───────────────────────── Yêu cầu ─────────────────────────
  /** Yêu cầu đi theo vòng kit (gán, kiểm, giao): mở BO, hoặc hỗ trợ "Thêm kit" cho BO đang ghi hình. */
  const isKitReq = (r) => !!r && (r.kind === 'launch' || (r.kind === 'support' && !!r.need && r.need.kind === 'add_kit'));
  const dm = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '');
  /**
   * Yêu cầu đang chờ ai, nói bằng lời: { who, tone, text }. Một nguồn cho mọi màn hình (Yêu cầu, trang BO, bảng Head of Sale).
   * Chỉ dựa vào yêu cầu và kit đã gán; không có thông tin chuyến hay FO.
   */
  function waitingOf(r, kits = store.kits.find({ request_id: r.id })) {
    const n = r.need || {};
    const by = (sts) => kits.filter((k) => sts.includes(k.status));
    const codes = (list) => list.map((k) => k.code).join(', ');
    const addKit = r.kind === 'support' && n.kind === 'add_kit';
    if (r.status === 'cancelled') return { who: '', tone: 'off', text: r.reason ? `Đã huỷ: ${r.reason}` : 'Yêu cầu đã huỷ.' };
    if (r.status === 'closed') {
      if (r.kind === 'support') { const off = /^(Huỷ|Gộp)/.test(r.reason || ''); return { who: '', tone: off ? 'off' : 'go', text: off ? `Đã đóng: ${r.reason}.` : addKit ? 'Đã giao thêm kit, BO ghi hình với số kit mới.' : 'Đã xử lý xong.' }; }
      return { who: '', tone: 'go', text: r.kind === 'end' ? 'Đã thu hồi xong thiết bị, BO kết thúc ghi hình.' : 'Đã đóng: BO đã kết thúc và thu hồi xong thiết bị.' };
    }
    if (r.kind === 'end') {
      if (r.status === 'scheduled') return { who: '', tone: 'blue', text: `Đã hẹn kết thúc ghi hình từ ngày ${dm(n.end_date)}. Trước ngày đó BO vẫn ghi hình, đổi thẻ và nhận hỗ trợ như thường; tới ngày đó Logistics thu hồi kit và thẻ.` };
      return { who: 'Logistics', tone: 'wait', text: `Logistics đang thu hồi kit và thẻ tại BO. Thu hồi xong BO chuyển "${OUTLET_ST.ended}".` };
    }
    if (r.kind === 'support' && !addKit) {
      const k = n.kind;
      const text = k === 'swap_device' ? 'Logistics đổi kit hỏng tại BO (thường đi cùng lượt đổi thẻ gần nhất). Kit lỗi về kho thì Tech sửa.'
        : k === 'extra_acc' ? 'Logistics chuẩn bị và giao phụ kiện tới BO.'
          : k === 'bad_card' ? 'Logistics kiểm tra và thay thẻ tại BO.' : 'Logistics đang xử lý yêu cầu.';
      return { who: 'Logistics', tone: 'wait', text };
    }
    // Mở BO mới, hoặc thêm kit cho BO đang ghi hình
    const day = addKit ? 'ngày giao' : 'ngày launch';
    const late = ['submitted', 'preparing'].includes(r.status) && r.launch_date && r.launch_date <= addDays(today(), H.cfg().reqLateDays ?? 2); // cùng ngưỡng với ô "Yêu cầu trễ" ở Điểm nghẽn
    const lateText = late ? `Sắp tới ${day} ${dm(r.launch_date)} mà kit chưa sẵn sàng. ` : '';
    if (r.status === 'submitted') return { who: 'Logistics', tone: late ? 'lost' : 'wait', text: lateText + 'Chờ Logistics nhận yêu cầu và chọn kit.' };
    if (r.status === 'preparing') {
      const mc = kits.filter((k) => k.kind !== 'iphone').length, ip = kits.filter((k) => k.kind === 'iphone').length;
      const miss = [[Math.max(0, (n.multicam || 0) - mc), 'multicam'], [Math.max(0, (n.iphone || 0) - ip), 'iphone']].filter(([q]) => q).map(([q, kd]) => `${q} ${KIT_KINDS[kd]}`).join(' + ');
      const parts = [], who = new Set();
      const add = (list, team, text) => { if (list.length) { parts.push(`${list.length} kit ${text} (${codes(list)}).`); who.add(team); } };
      if (miss) { parts.push(`Logistics cần chọn thêm ${miss}.`); who.add('Logistics'); }
      add(by(['preparing']), 'Logistics', 'Logistics đang chuẩn bị');
      add(by(['returned']), 'Tech', 'vừa thu hồi về, chờ Tech check-in (hoặc Logistics gửi kiểm luôn)');
      add(by(['wait_check']), 'Tech', 'chờ Tech kiểm');
      add(by(['at_tech']), 'Tech', 'đang ở Tech sửa');
      add(by(['tech_done']), 'Logistics', 'Tech đã xong, chờ Logistics nhận lại');
      const ok = by(['reserved']);
      if (ok.length) parts.push(`${ok.length} kit đã kiểm xong.`);
      return { who: [...who].join(' và ') || 'Logistics', tone: late ? 'lost' : 'wait', text: lateText + (parts.join(' ') || 'Logistics đang chuẩn bị kit.') };
    }
    if (r.status === 'ready') return { who: 'Logistics', tone: 'blue', text: `Kit đã kiểm xong. Logistics giao và setup trước hoặc đúng ${day} ${dm(r.launch_date)}.` };
    if (r.status === 'delivering') return { who: 'Logistics', tone: 'blue', text: 'Kit đang trên đường tới BO để giao và setup.' };
    if (r.status === 'live') return { who: '', tone: 'go', text: `Đã giao xong, BO đang ghi hình. Cần đổi máy, thêm kit hay thêm phụ kiện thì gửi yêu cầu hỗ trợ ở trang BO.` };
    if (r.status === 'ending') return { who: 'Logistics', tone: 'wait', text: 'BO đang thu hồi thiết bị: Logistics thu kit và thẻ về kho.' };
    return { who: '', tone: 'off', text: '' };
  }
  const reqBrief = (r) => reqBriefWith(r, store.kits.find({ request_id: r.id }));
  /** Danh sách yêu cầu: kit của cả danh sách đọc trong một lượt (không đọc riêng từng yêu cầu), cùng thứ tự như reqBrief. */
  function reqBriefs(rows) {
    const byReq = new Map();
    for (let i = 0; i < rows.length; i += 500) {
      for (const k of store.kits.find({ request_id: rows.slice(i, i + 500).map((r) => r.id) })) { if (!byReq.has(k.request_id)) byReq.set(k.request_id, []); byReq.get(k.request_id).push(k); }
    }
    return rows.map((r) => reqBriefWith(r, byReq.get(r.id) || []));
  }
  function reqBriefWith(r, kits) {
    return {
      id: r.id, code: r.code, kind: r.kind, kind_label: REQ_KIND[r.kind] || r.kind, status: r.status, status_label: REQ_ST[r.status] || r.status,
      site: r.site_id ? { id: r.site_id, name: H.siteName(r.site_id) } : null, sale: r.sale_id ? { id: r.sale_id, name: H.userName(r.sale_id) } : null,
      by: H.userName(r.created_by), need: r.need || {}, launch_date: r.launch_date, note: r.note || '', reason: r.reason || '', parent_id: r.parent_id,
      kits: kits.map((k) => ({ id: k.id, code: k.code, kind: k.kind, status: k.status })), created_at: r.created_at, updated_at: r.updated_at, closed_at: r.closed_at,
      waiting: waitingOf(r, kits),
    };
  }
  /** Yêu cầu thuộc Sale nào: Sale phụ trách hiện tại của BO, không theo người tạo (BO giao lại thì quyền đi theo). */
  const ownsReq = (r, user) => (r.site_id ? (store.sites.get(r.site_id) || {}).sale_id === user.id : r.sale_id === user.id);
  /** Sale Lead chỉ thấy yêu cầu của BO mình đang phụ trách (trừ khi được xem mọi BO). null = không giới hạn. */
  function reqScope(user) {
    if (!saleScope(user)) return null;
    const mine = new Set(store.sites.find({ sale_id: user.id }).map((s) => s.id));
    return (r) => (r.site_id ? mine.has(r.site_id) : r.sale_id === user.id);
  }
  function reqOrFail(id, user, write = false) {
    const r = store.requests.get(K.idOf(id));
    if (!r) fail(404, 'not_found', 'Không tìm thấy yêu cầu.');
    // "Sale Lead xem mọi BO" chỉ mở quyền xem: sửa / huỷ yêu cầu luôn cần đúng Sale phụ trách hiện tại của BO.
    if (user && user.role === 'sale' && !ownsReq(r, user) && (write || saleScope(user))) fail(403, 'forbidden', saleScope(user) ? 'Yêu cầu này không phải của bạn.' : 'Bạn chỉ được xem yêu cầu của Sale Lead khác; Sale phụ trách hoặc Head of Sale mới sửa, huỷ được.');
    return r;
  }
  function needInput(v) {
    const n = v && typeof v === 'object' ? v : {};
    const out = { multicam: int(n.multicam ?? 0, 0, 200), iphone: int(n.iphone ?? 0, 0, 200), acc: {} };
    if (out.multicam === null || out.iphone === null) fail(400, 'bad_need', 'Số kit phải là số nguyên từ 0 đến 200.');
    if (!out.multicam && !out.iphone) fail(400, 'bad_need', 'Cần ít nhất 1 kit Multicam hoặc iPhone Mono.');
    if (n.acc && typeof n.acc === 'object') for (const [k, q] of Object.entries(n.acc)) {
      const tp = store.dev_types.get(k), qty = int(q, 0, 999);
      if (!tp || tp.kind !== 'acc' || qty === null) fail(400, 'bad_acc', `Phụ kiện "${k}" không hợp lệ.`);
      if (qty) out.acc[k] = qty;
    }
    if (n.other) out.other = cleanStr(n.other, 200);
    return out;
  }
  const needText = (n) => [n.multicam ? `${n.multicam} Multicam KIT` : '', n.iphone ? `${n.iphone} iPhone Mono` : ''].filter(Boolean).join(' + ');
  /** Việc chuẩn bị kit của yêu cầu (khoá ":open": làm xong rồi mà yêu cầu lại thiếu kit thì có việc mới). */
  function ensurePrep(r, siteName, actor, title) {
    const day = r.kind === 'launch' ? 'launch' : 'giao';
    const pd = prepDue(r.launch_date, now()); // hạn theo prepMinHours (launch / giao gấp thì việc gấp, không sinh ra đã quá hạn)
    return H.jobs.ensure({ type: 'prep_kit', request_id: r.id, site_id: r.site_id, title: `${title} cho ${siteName} (${day} ${dm(r.launch_date)})`, dedupe: `prep:${r.id}:open`, due_at: pd.due_at, priority: pd.priority }, actor);
  }

  const LAUNCH_OPEN = ['submitted', 'preparing', 'ready', 'delivering'];
  /** Tên / địa chỉ để so trùng: bỏ hoa thường, khoảng trắng thừa, chữ "BO" ở đầu tên. */
  const normText = (v) => String(v ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  const normName = (v) => normText(v).replace(/^bo\s+/, '');
  /**
   * BO mới gửi lại lần hai (mất mạng rồi bấm lại, mở hai tab): tìm BO đang chờ launch cùng tên (và cùng địa chỉ khi cả hai có)
   * đã có yêu cầu launch đang xử lý. Sale Lead chỉ so với BO của mình, không lộ BO của người khác.
   */
  function similarPending(row, user) {
    const name = normName(row.name), addr = normText(row.address);
    if (!name) return null;
    for (const s of store.sites.find({ type: 'bo', active: 1, ops_status: ['planned', null] })) {
      if ((s.ops_status || 'planned') !== 'planned') continue;
      if (normName(s.name) !== name) continue;
      if (addr && s.address && normText(s.address) !== addr) continue;
      if (saleScope(user) && s.sale_id !== user.id) continue;
      const r = store.requests.find({ site_id: s.id, kind: 'launch', status: LAUNCH_OPEN }, { order: 'created_at', desc: true, limit: 1 })[0];
      if (r) return { site: s, request: r };
    }
    return null;
  }
  const dupData = (s, r) => ({ site: { id: s.id, name: s.name, code: s.code || '' }, request: { id: r.id, code: r.code, status: r.status, launch_date: r.launch_date } });
  /**
   * Hạn việc chuẩn bị kit: trước 0 giờ ngày launch, tối đa 24 giờ, nhưng không ít hơn prepMinHours (Logistics chốt).
   * Launch gấp hơn mức tối thiểu thì việc được đánh dấu gấp thay vì sinh ra đã quá hạn.
   */
  function prepDue(launchDate, t) {
    const start = dayStart(launchDate, H.off), min = (H.cfg().prepMinHours ?? 4) * 3600000;
    return { due_at: Math.max(t + min, Math.min(t + 24 * 3600000, start)), priority: start - t < min };
  }

  /** Sale (hoặc Logistics) gửi yêu cầu mở BO mới. BO chưa có thì tạo luôn. */
  R('POST', '/api/hub/requests', ['admin', 'lead', 'logistic', 'sale', 'sale_head'], ({ user, b }) => {
    const need = needInput(b.need);
    if (!isDate(b.launch_date)) fail(400, 'bad_date', 'Cần chọn ngày launch.');
    if (b.launch_date < today()) fail(400, 'bad_date', 'Ngày launch không được ở quá khứ.');
    // Cùng hộp thoại gửi lại (mất phản hồi rồi bấm lại): trả yêu cầu đã tạo, không tạo thêm.
    const key = H.reqKeyOf(b);
    const again = H.replayOf('request', ['create'], user, key);
    if (again && store.requests.get(again.entity_id)) return { request: reqBrief(store.requests.get(again.entity_id)), replay: true };
    const t = now();
    let site;
    if (b.site_id) site = outletOrFail(b.site_id, user, true);
    const req = { kind: 'launch', parent_id: null, created_by: user.id, status: 'submitted', need, launch_date: b.launch_date, kit_id: null, note: cleanText(b.note, 800), reason: '', created_at: t, updated_at: t, closed_at: null, prev: null };
    store.tx(() => {
      if (!site) {
        const o = b.outlet || {};
        const row = { type: 'bo', radius: K.cfg.arriveRadiusM, active: 1, created_at: t, updated_at: t, ops_status: 'planned', lat: null, lon: null, ...ownFields(user, outletInput({ ...o, launch_date: undefined, end_date: undefined, swap_days: b.swap_days, swap_from: b.swap_from, swap_to: b.swap_to }, null), null) };
        if (row.code && store.sites.count({ code: row.code, active: 1 })) fail(409, 'exists', `Đã có BO mã ${row.code}. Chọn BO có sẵn thay vì tạo mới.`);
        if (!b.confirm_new) {
          const dup = similarPending(row, user);
          if (dup) fail(409, 'dup_request', `${boLabel(dup.site.name)} đang chờ launch với yêu cầu ${dup.request.code} (launch ${dup.request.launch_date}). Mở yêu cầu đó, hoặc xác nhận đây là một BO khác cùng tên.`, { ...dupData(dup.site, dup.request), confirm: true });
        }
        row.sale_id = user.role === 'sale' ? user.id : row.sale_id ?? null;
        row.launch_date = b.launch_date;
        row.id = store.sites.insert(row);
        site = row;
        log('outlet', row.id, 'create', `${user.name} tạo ${boLabel(row.name)} kèm yêu cầu launch.`, user);
      } else {
        if (site.ops_status === 'ending') fail(409, 'ending', 'BO đang thu hồi thiết bị. Thu hồi xong (BO "Đã kết thúc") thì gửi yêu cầu mở BO lại. Muốn giữ BO ghi hình tiếp thì Sale phụ trách hoặc Head of Sale huỷ yêu cầu kết thúc khi FO chưa đi thu.');
        if (['live', 'paused'].includes(site.ops_status)) fail(409, 'already_live', `BO này đang ${site.ops_status === 'paused' ? 'tạm nghỉ (máy vẫn ở BO)' : 'ghi hình'}. Cần thêm máy thì gửi yêu cầu hỗ trợ "${SUPPORT_KIND.add_kit}" ở trang BO.`);
        const open = store.requests.find({ site_id: site.id, kind: 'launch', status: LAUNCH_OPEN }, { order: 'created_at', desc: true, limit: 1 })[0];
        if (open) fail(409, 'dup_request', `BO này đã có yêu cầu launch ${open.code} đang xử lý.`, dupData(site, open));
        // BO đã kết thúc mở lại: nhớ trạng thái cũ để huỷ yêu cầu thì BO về "Đã kết thúc", không thành BO chưa từng ghi hình.
        if (site.ops_status === 'ended') req.prev = { ops_status: site.ops_status, launch_date: site.launch_date || null, end_date: site.end_date || null };
        const patch = { launch_date: b.launch_date, ops_status: 'planned', end_date: null, updated_at: t };
        // Launch lại BO đã kết thúc: giữ các đợt ghi hình cũ (có ngày kết thúc) trước khi xoá ngày kết thúc.
        if (!Array.isArray(site.live_periods) || !site.live_periods.length) { const per = periodsOf(site); if (per.length) patch.live_periods = per; }
        if (b.swap_days !== undefined) Object.assign(patch, outletInput({ swap_days: b.swap_days, swap_from: b.swap_from, swap_to: b.swap_to }, site));
        store.sites.update(site.id, patch);
      }
      // Mã cấp sau khi mọi điều kiện đã qua: lần gửi bị chặn không làm nhảy số.
      req.code = H.nextCode('Y' + H.ym() + '-', 'requests', 3);
      req.site_id = site.id; req.sale_id = site.sale_id || (user.role === 'sale' ? user.id : null);
      req.id = store.requests.insert(req);
      // Yêu cầu launch đầu tiên (không huỷ) = BO đã ký (onboard): ghi ngày và Sale Lead gửi; BO đã từng có máy thì giữ ngày active và Sale phụ trách.
      if (!site.signed_date) store.sites.update(site.id, activeOf(site) ? { signed_date: activeOf(site), signed_by: site.sale_id ?? null } : { signed_date: today(), signed_by: user.role === 'sale' ? user.id : req.sale_id });
      log('request', req.id, 'create', `${user.name} gửi yêu cầu ${req.code}: ${needText(need)} cho ${site.name}, launch ${req.launch_date}.`, user, key ? { req_key: key } : null);
      ensurePrep(req, site.name, user, `Chuẩn bị ${needText(need)}`);
    });
    notify({ roles: ['lead', 'logistic'] }, 'info', 'request', `Yêu cầu mới ${req.code} từ ${user.name}: ${needText(need)} cho ${site.name}, launch ${req.launch_date}.`, `request:${req.id}`);
    changed('requests', 'outlets', 'jobs');
    return { request: reqBrief(store.requests.get(req.id)) };
  });
  const REQ_OPEN = ['submitted', 'preparing', 'ready', 'delivering', 'live', 'scheduled', 'ending'];
  R('GET', '/api/hub/requests', G.STAFF, ({ user, q }) => {
    const where = {};
    if (q.status) where.status = String(q.status).split(',');
    if (q.kind) where.kind = String(q.kind);
    if (q.site) where.site_id = K.idOf(q.site);
    // Lọc phạm vi Sale ngay lúc tìm (không cắt 500 dòng rồi mới lọc); yêu cầu còn mở luôn đủ, đã đóng / huỷ lấy 500 dòng mới nhất.
    // Phạm vi theo Sale phụ trách hiện tại của BO (như reqScope).
    if (saleScope(user)) {
      const mineIds = store.sites.find({ sale_id: user.id }).map((s) => s.id);
      where.site_id = where.site_id ? (mineIds.includes(where.site_id) ? where.site_id : -1) : mineIds.length ? mineIds : [-1];
    }
    const parts = where.status ? [store.requests.find(where, { order: 'created_at', desc: true, limit: 500 })]
      : [store.requests.find({ ...where, status: REQ_OPEN }), store.requests.find({ ...where, status: ['closed', 'cancelled'] }, { order: 'created_at', desc: true, limit: 500 })];
    const rows = parts.flat().sort((a, b) => b.created_at - a.created_at || b.id - a.id);
    return { requests: reqBriefs(rows) };
  });
  R('GET', '/api/hub/requests/:id', G.STAFF, ({ user, p }) => {
    const r = reqOrFail(p.id, user);
    const mine = reqScope(user);
    const rows = store.hub_log.find({ entity: 'request', entity_id: r.id }, { order: 'ts', desc: true, limit: 60 });
    // Sale chỉ cần biết bước nào, lúc nào, vai nào làm: bỏ mã người làm và dữ liệu thô; FO (giao kit / đổi máy qua chuyến) chỉ hiện vai "FO".
    const actorOf = (id) => { const u = id ? store.users.get(id) : null; return !id ? 'Hệ thống' : u && u.role === 'fo' ? H.ROLE_LABEL.fo : H.userName(id); };
    const log = H.isSale(user) ? rows.map((e) => ({ ts: e.ts, action: e.action, text: e.text, actor: actorOf(e.actor_id), ...(e.action === 'status' && e.data ? { data: { from: e.data.from, to: e.data.to } } : {}) })) : rows;
    const site = r.site_id ? store.sites.get(r.site_id) : null;
    return {
      request: reqBrief(r),
      can_write: user.role !== 'sale' || ownsReq(r, user),
      can_cancel: canCancel(r, user, site),
      children: store.requests.find({ parent_id: r.id }, { order: 'created_at' }).filter((c) => !mine || mine(c)).map(reqBrief),
      jobs: H.isSale(user) ? [] : store.jobs.find({ request_id: r.id }, { order: 'created_at' }).map(H.jobs.viewFor(user)),
      log,
      candidates: H.isSale(user) ? [] : candidates(r),
    };
  });
  /** Kit có thể gán cho yêu cầu: đúng loại, chưa gán cho ai, đang chuẩn bị / sẵn sàng / đã về. Kit đã kiểm đạt xếp trước. */
  function candidates(r) {
    if (!isKitReq(r) || !['submitted', 'preparing', 'ready'].includes(r.status)) return [];
    const kinds = [r.need.multicam ? 'multicam' : null, r.need.iphone ? 'iphone' : null, 'custom'].filter(Boolean);
    const rank = { ready: 0, preparing: 1, returned: 2 };
    return store.kits.find({ status: ['ready', 'preparing', 'returned'], request_id: null, kind: kinds })
      .sort((a, b) => rank[a.status] - rank[b.status] || a.code.localeCompare(b.code)).slice(0, 300)
      .map((k) => { const c = H.stock.completeness(k, H.stock.kitDevices(k.id)); return { id: k.id, code: k.code, kind: k.kind, status: k.status, complete: c.complete, missing: c.missing }; });
  }
  R('POST', '/api/hub/requests/:id/assign', ['admin', 'lead', 'logistic'], ({ user, p, b }) => {
    const r = reqOrFail(p.id);
    if (!isKitReq(r)) fail(409, 'bad_kind', 'Chỉ gán kit cho yêu cầu mở BO hoặc yêu cầu thêm kit.');
    if (!['submitted', 'preparing', 'ready'].includes(r.status)) fail(409, 'bad_state', `Yêu cầu đang "${REQ_ST[r.status]}", không gán thêm kit được.`);
    H.jobs.failIfInTrip({ type: 'deliver', request_id: r.id }, 'Việc giao của yêu cầu này');
    const ids = idList(b.kit_ids, 200);
    store.tx(() => {
      const have = store.kits.find({ request_id: r.id });
      const cnt = (kind) => have.filter((k) => k.kind === kind).length;
      for (const id of ids) {
        const k = H.stock.kitOrFail(id);
        if (k.request_id === r.id) continue;
        if (k.request_id) fail(409, 'kit_taken', `Kit ${k.code} đã gán cho yêu cầu khác.`);
        if (!['ready', 'preparing', 'returned'].includes(k.status)) fail(409, 'bad_state', `Kit ${k.code} đang "${k.status}", không gán được.`);
        H.jobs.failIfKitInTrip(k);
        const kind = k.kind === 'custom' ? (r.need.multicam > cnt('multicam') ? 'multicam' : 'iphone') : k.kind;
        if (cnt(kind) >= (r.need[kind] || 0) && k.kind !== 'custom') fail(409, 'over', `Yêu cầu chỉ cần ${r.need[kind] || 0} ${KIT_KINDS[kind]}; đã gán đủ.`);
        const patch = { request_id: r.id, updated_at: now() };
        store.kits.update(k.id, patch);
        have.push({ ...k, ...patch });
        if (k.status === 'ready') H.stock.setKit({ ...k, ...patch }, 'reserved', user, `${user.name} gán kit ${k.code} (đã kiểm) cho ${r.code}.`);
        else log('kit', k.id, 'assign', `${user.name} gán kit ${k.code} cho ${r.code}; kit cần chuẩn bị xong và qua Tech kiểm.`, user);
      }
      log('request', r.id, 'assign', `${user.name} gán ${ids.length} kit cho yêu cầu.`, user, { ids });
    });
    refreshRequest(r.id, user);
    return { request: reqBrief(store.requests.get(r.id)) };
  });
  R('POST', '/api/hub/requests/:id/unassign', ['admin', 'lead', 'logistic'], ({ user, p, b }) => {
    const r = reqOrFail(p.id);
    const k = H.stock.kitOrFail(b.kit_id);
    if (k.request_id !== r.id) fail(404, 'not_assigned', 'Kit không thuộc yêu cầu này.');
    if (KIT_OUTSIDE.includes(k.status)) fail(409, 'bad_state', 'Kit đã rời kho, không gỡ được.');
    H.jobs.failIfInTrip({ type: 'deliver', request_id: r.id }, 'Việc giao của yêu cầu này');
    store.tx(() => {
      store.kits.update(k.id, { request_id: null, updated_at: now() });
      if (k.status === 'reserved') H.stock.setKit({ ...k, request_id: null }, 'ready', user, `${user.name} gỡ kit ${k.code} khỏi ${r.code}.`);
      else log('kit', k.id, 'unassign', `${user.name} gỡ kit ${k.code} khỏi ${r.code}.`, user);
    });
    refreshRequest(r.id, user);
    return { request: reqBrief(store.requests.get(r.id)) };
  });
  R('PATCH', '/api/hub/requests/:id', ['admin', 'lead', 'logistic', 'sale', 'sale_head'], ({ user, p, b }) => {
    const r = reqOrFail(p.id, user, true);
    if (!isKitReq(r)) fail(409, 'bad_kind', 'Yêu cầu này không sửa được. Cần thêm gì thì gửi yêu cầu hỗ trợ mới ở trang BO.');
    if (!['submitted', 'preparing', 'ready'].includes(r.status)) fail(409, 'bad_state', 'Yêu cầu đã giao máy, không sửa được nữa. Dùng yêu cầu hỗ trợ.');
    if (b.need !== undefined) H.jobs.failIfInTrip({ type: 'deliver', request_id: r.id }, 'Việc giao của yêu cầu này');
    const addKit = r.kind === 'support';
    const patch = { updated_at: now() };
    if (b.launch_date !== undefined) { if (!isDate(b.launch_date) || b.launch_date < today()) fail(400, 'bad_date', addKit ? 'Ngày giao không hợp lệ.' : 'Ngày launch không hợp lệ.'); patch.launch_date = b.launch_date; }
    // Dời ngày launch / ngày giao khi việc giao đã lên chuyến FO: chuyến đã chạy thì không dời được (kit đang trên đường);
    // chuyến chưa chạy thì gỡ việc giao khỏi chuyến để Logistics xếp lại theo ngày mới.
    let untrip = null;
    if (patch.launch_date && patch.launch_date !== r.launch_date) {
      untrip = H.jobs.tripOf({ type: 'deliver', request_id: r.id });
      if (untrip && untrip.status === 'in_progress') fail(409, 'trip_running', `Việc giao của yêu cầu này đang trên chuyến ${untrip.code} đã bắt đầu, không dời ${addKit ? 'ngày giao' : 'ngày launch'} được nữa. Nhờ Logistics dừng lượt giao (FO báo không giao được hoặc huỷ chuyến) rồi dời ngày.`);
    }
    if (b.need !== undefined) {
      patch.need = addKit ? { ...needInput(b.need), kind: 'add_kit' } : needInput(b.need);
      const have = store.kits.find({ request_id: r.id });
      for (const kind of ['multicam', 'iphone']) if (have.filter((k) => k.kind === kind).length > (patch.need[kind] || 0)) fail(409, 'over', `Đã gán nhiều ${KIT_KINDS[kind]} hơn số mới. Gỡ bớt kit trước.`);
    }
    if (b.note !== undefined) patch.note = cleanText(b.note, 800);
    store.tx(() => {
      store.requests.update(r.id, patch);
      if (untrip) {
        for (const j of store.jobs.find({ type: 'deliver', request_id: r.id, task_id: untrip.id, status: H.jobs.OPEN })) {
          H.jobs.detachFromTask(j);
          log('job', j.id, 'untrip', `${user.name} dời ngày launch ${r.code} sang ${patch.launch_date}; ${j.code} được gỡ khỏi chuyến ${untrip.code}.`, user);
        }
      }
      if (patch.launch_date) {
        if (!addKit) store.sites.update(r.site_id, { launch_date: patch.launch_date, updated_at: now() }); // thêm kit: BO đã ghi hình, ngày launch của BO giữ nguyên
        H.jobs.retime({ type: 'deliver', request_id: r.id }, patch.launch_date);
        // Launch dời sớm hơn: việc chuẩn bị còn mở theo hạn mới, vẫn giữ mức tối thiểu prepMinHours (gấp thì đánh dấu gấp).
        if (patch.launch_date < r.launch_date) {
          const t = now(), start = dayStart(patch.launch_date, H.off), min = (H.cfg().prepMinHours ?? 4) * 3600000;
          for (const j of store.jobs.find({ type: 'prep_kit', request_id: r.id, status: H.jobs.OPEN })) {
            const due = Math.min(j.due_at || Infinity, Math.max(start, t + min)), rush = start - t < min;
            if (due !== j.due_at || (rush && !j.priority)) store.jobs.update(j.id, { ...(due !== j.due_at ? { ...H.jobs.duePatch(j, due), al_due: 0, al_lead: 0 } : {}), ...(rush ? { priority: 1 } : {}) }); // hạn riêng của người giữ việc đi theo hạn mới
          }
        }
      }
      log('request', r.id, 'update', `${user.name} sửa yêu cầu ${r.code}${patch.launch_date ? `: ${addKit ? 'ngày giao' : 'ngày launch'} ${r.launch_date} → ${patch.launch_date}` : ''}.`, user, patch);
    });
    if (untrip) {
      notify({ roles: ['lead', 'logistic'] }, 'warn', 'request', `${user.name} dời ngày launch ${r.code} (${H.siteName(r.site_id)}) sang ${patch.launch_date}; việc giao đã gỡ khỏi chuyến ${untrip.code}, cần xếp lại.`, `request:${r.id}`);
      K.tasks.pushTask(untrip.id);
      changed('jobs', 'kits', 'cards');
    } else if (H.isSale(user)) notify({ roles: ['lead', 'logistic'] }, 'warn', 'request', `${user.name} sửa yêu cầu ${r.code} (${H.siteName(r.site_id)}).`, `request:${r.id}`);
    refreshRequest(r.id, user);
    return { request: reqBrief(store.requests.get(r.id)) };
  });
  /** Lý do không huỷ được yêu cầu kết thúc nữa (null = huỷ được): Logistics đã thu kit về, hoặc FO đã lên đường thu hồi. */
  function endLock(r) {
    if (!['scheduled', 'ending'].includes(r.status)) return r.status === 'closed' ? 'BO đã thu hồi xong và kết thúc. Muốn ghi hình lại thì gửi yêu cầu mở BO.' : `Yêu cầu đang "${REQ_ST[r.status] || r.status}", không huỷ được.`;
    const recs = store.jobs.find({ type: 'recover', request_id: r.id });
    if (recs.some((j) => j.status === 'done')) return 'Logistics đã thu kit về kho nên không huỷ kết thúc được nữa. Thu hồi xong thì gửi yêu cầu mở BO để ghi hình lại.';
    for (const j of recs) {
      const tk = H.jobs.OPEN.includes(j.status) && j.task_id ? store.tasks.get(j.task_id) : null;
      if (tk && tk.status === 'in_progress') return 'FO đã lên đường thu hồi nên không huỷ kết thúc được nữa. Thu hồi xong thì gửi yêu cầu mở BO để ghi hình lại.';
      // Chuyến thu hồi đã chạy mà số kit FO / BO báo khác kế hoạch: FO có thể đã thu một phần, Logistic Lead đang đối chiếu.
      if (H.jobs.OPEN.includes(j.status) && H.jobs.heldRecon(j.id)) return 'FO đã đi thu hồi và số kit đang chờ Logistic Lead đối chiếu nên không huỷ kết thúc được nữa. Thu hồi xong thì gửi yêu cầu mở BO để ghi hình lại.';
    }
    return null;
  }
  /** Yêu cầu hỗ trợ (không phải thêm kit) huỷ được bằng nút huỷ yêu cầu: đổi máy hư, bổ sung phụ kiện. */
  const cancelSupport = (r) => r.kind === 'support' && !!r.need && ['swap_device', 'extra_acc'].includes(r.need.kind);
  /** Ai huỷ được yêu cầu này lúc này (giao diện dùng để hiện nút; máy chủ vẫn kiểm lại khi huỷ). */
  function canCancel(r, user, site) {
    if (user.role === 'sale' && !ownsReq(r, user)) return false;
    if (isKitReq(r) || cancelSupport(r)) return ['submitted', 'preparing', 'ready'].includes(r.status) && ['admin', 'lead', 'logistic', 'sale', 'sale_head'].includes(user.role);
    if (r.kind === 'end') return ['sale', 'sale_head', 'admin'].includes(user.role) && !!site && !endLock(r);
    return false;
  }
  R('POST', '/api/hub/requests/:id/cancel', ['admin', 'lead', 'logistic', 'sale', 'sale_head'], ({ user, p, b }) => {
    const r = reqOrFail(p.id, user, true);
    if (r.kind === 'end') return cancelEnd(r, user, b);
    // Đổi máy hư / bổ sung phụ kiện huỷ được ở đây (việc đổi kit, giao phụ kiện được dọn đúng cách bên dưới); hỗ trợ khác đi theo việc của Logistics.
    if (!isKitReq(r) && !cancelSupport(r)) fail(409, 'bad_kind', 'Yêu cầu hỗ trợ này đi theo việc của Logistics: không cần nữa thì báo Logistic Lead huỷ việc đi kèm (kèm lý do); yêu cầu tự đóng và Sale được báo.');
    if (!['submitted', 'preparing', 'ready'].includes(r.status)) fail(409, 'bad_state', r.kind === 'launch' ? 'Kit đã rời kho hoặc đã giao. Muốn dừng thì bấm "Kết thúc ghi hình" ở BO.' : isKitReq(r) ? 'Kit đã rời kho hoặc đã giao nên không huỷ yêu cầu thêm kit được nữa.' : 'Yêu cầu đã xử lý xong, không huỷ được nữa.');
    H.jobs.failIfInTrip({ type: 'deliver', request_id: r.id }, 'Việc giao của yêu cầu này');
    H.jobs.failIfTripRunning({ request_id: r.id }, 'Việc của yêu cầu này'); // yêu cầu hỗ trợ: việc đổi kit / giao phụ kiện FO đang làm
    H.jobs.failIfHeld({ request_id: r.id }, 'Việc của yêu cầu này'); // FO có thể đã làm thật: Logistic Lead chốt trước
    const reason = reasonOf(b.reason, 'lý do huỷ');
    store.tx(() => {
      for (const k of store.kits.find({ request_id: r.id })) {
        store.kits.update(k.id, { request_id: null, updated_at: now() });
        if (k.status === 'reserved') H.stock.setKit({ ...k, request_id: null }, 'ready', user, `Yêu cầu ${r.code} bị huỷ, kit ${k.code} trả về sẵn sàng.`);
      }
      store.requests.update(r.id, { status: 'cancelled', reason, closed_at: now(), updated_at: now() });
      // Yêu cầu đổi máy huỷ: gỡ cờ lỗi do yêu cầu đặt cùng việc đổi kit; việc đã lên chuyến FO hoặc kit còn lỗi khác thì giữ việc và đưa vào Đối chiếu.
      for (const j of store.jobs.find({ request_id: r.id, type: 'swap_faulty', status: H.jobs.OPEN })) H.jobs.dropSwap(j, user, `Yêu cầu ${r.code} bị huỷ: ${reason}`, { detach: true });
      // Việc theo yêu cầu (chuẩn bị, giao) huỷ; việc theo kit (Tech đang kiểm) vẫn chạy, chỉ bỏ liên kết yêu cầu: kit kiểm xong về sẵn sàng.
      H.jobs.cancelFor({ request_id: r.id, type: { ne: 'check_kit' } }, user, 'Yêu cầu bị huỷ');
      for (const j of store.jobs.find({ request_id: r.id, type: 'check_kit', status: H.jobs.OPEN })) store.jobs.update(j.id, { request_id: null });
      const site = store.sites.get(r.site_id);
      if (site && site.ops_status === 'planned' && r.kind === 'launch') {
        // Yêu cầu mở lại BO đã kết thúc bị huỷ: BO về đúng trạng thái trước đó (không thành BO chưa từng ghi hình).
        store.sites.update(site.id, r.prev ? { ops_status: r.prev.ops_status, launch_date: r.prev.launch_date, end_date: r.prev.end_date, updated_at: now() } : { launch_date: null, updated_at: now() });
        if (r.prev) log('outlet', site.id, 'relaunch_cancel', `${boLabel(site.name)} về "${OUTLET_ST[r.prev.ops_status]}" vì yêu cầu mở lại ${r.code} bị huỷ.`, user);
      }
      // BO chưa từng có máy và không còn yêu cầu launch nào khác: chưa tính là đã ký (onboard).
      const unsign = site && r.kind === 'launch' && site.signed_date && !activeOf(site) && !store.requests.count({ site_id: site.id, kind: 'launch', status: { ne: 'cancelled' } });
      if (unsign) store.sites.update(site.id, { signed_date: null, signed_by: null, updated_at: now() });
      log('request', r.id, 'cancel', `${user.name} huỷ yêu cầu ${r.code}: ${reason}.${unsign ? ` ${boLabel(site.name)} chưa có máy lần nào nên không còn tính là đã onboard.` : ''}`, user);
    });
    notify({ roles: ['lead', 'logistic'] }, 'warn', 'request', `${user.name} huỷ yêu cầu ${r.code} (${H.siteName(r.site_id)}): ${reason}.`, `request:${r.id}`);
    changed('requests', 'kits', 'jobs', 'outlets');
    return { request: reqBrief(store.requests.get(r.id)) };
  });
  /**
   * Huỷ kết thúc ghi hình (Sale phụ trách, Head of Sale, Quản trị) khi chưa thu kit nào và FO chưa lên đường thu hồi:
   * việc thu hồi huỷ, BO bỏ ngày kết thúc và ghi hình tiếp (hoặc tạm nghỉ nếu hôm nay trong lịch tạm nghỉ), việc đổi thẻ và đổi kit hỏng có lại.
   */
  function cancelEnd(r, user, b) {
    if (!['sale', 'sale_head', 'admin'].includes(user.role)) fail(403, 'forbidden', 'Yêu cầu kết thúc do Sale phụ trách, Head of Sale hoặc Quản trị huỷ.');
    const lock = endLock(r);
    if (lock) fail(409, 'bad_state', lock);
    const reason = reasonOf(b.reason, 'lý do huỷ');
    const s = store.sites.get(r.site_id), t = now(), wasEnding = s.ops_status === 'ending';
    const ops = wasEnding ? (inPause(s, today()) ? 'paused' : 'live') : s.ops_status;
    store.tx(() => {
      H.jobs.cancelFor({ type: 'recover', request_id: r.id }, user, 'Huỷ kết thúc ghi hình');
      store.requests.update(r.id, { status: 'cancelled', reason, closed_at: t, updated_at: t });
      // Đợt ghi hình cuối đã chốt theo ngày hẹn kết thúc thì mở lại (BO ghi hình tiếp).
      const per = periodsOf(s).map((x) => [...x]), last = per[per.length - 1];
      const reopen = Array.isArray(s.live_periods) && last && last[1] && last[1] === s.end_date;
      if (reopen) last[1] = null;
      store.sites.update(s.id, { ops_status: ops, end_date: null, ...(reopen ? { live_periods: per } : {}), updated_at: t });
      if (wasEnding) {
        // Trạng thái yêu cầu launch tính lại từ kit đã gán (một nguồn với refreshRequest), không đặt thẳng.
        for (const x of store.requests.find({ site_id: s.id, kind: 'launch', status: 'ending' })) refreshRequest(x.id, user, { reopen: true });
        // Đợt thu hồi đã huỷ việc đổi kit hỏng chưa lên chuyến; BO ghi hình tiếp thì kit còn cờ lỗi cần việc đổi kit như trước.
        for (const k of store.kits.find({ site_id: s.id, status: 'at_bo' })) if (k.fault) H.jobs.ensure({ type: 'swap_faulty', kit_id: k.id, site_id: s.id, title: `Đổi kit hỏng ${k.code} tại ${s.name}`, note: k.fault, dedupe: `swapf:${k.id}:open` }, user);
      }
      H.jobs.syncSwaps(store.sites.get(s.id), user);
      log('outlet', s.id, 'end_cancel', `${user.name} huỷ kết thúc ghi hình tại ${boLabel(s.name)} (${r.code}): ${reason}. ${ops === 'paused' ? 'BO trở lại tạm nghỉ theo lịch' : 'BO tiếp tục ghi hình'}.`, user);
      log('request', r.id, 'cancel', `${user.name} huỷ yêu cầu kết thúc ${r.code}: ${reason}.`, user);
    });
    notify({ roles: ['lead', 'logistic'] }, 'warn', 'end', `${user.name} huỷ kết thúc ghi hình tại ${boLabel(s.name)}: ${reason}. Việc thu hồi đã huỷ${wasEnding ? '; việc đổi thẻ được tạo lại' : ''}.`, `outlet:${s.id}`);
    changed('requests', 'outlets', 'jobs');
    return { request: reqBrief(store.requests.get(r.id)) };
  }

  /** Số kit còn thiếu so với yêu cầu, bằng lời ('' nếu đủ). */
  const missText = (n, kits) => needText({ multicam: Math.max(0, (n.multicam || 0) - kits.filter((k) => k.kind !== 'iphone').length), iphone: Math.max(0, (n.iphone || 0) - kits.filter((k) => k.kind === 'iphone').length) });
  /**
   * Tính lại trạng thái yêu cầu có kit (mở BO, thêm kit) từ trạng thái các kit đã gán. Sinh / huỷ việc Chuẩn bị và Giao cho khớp:
   * yêu cầu lùi về "đang chuẩn bị" (Sale tăng số kit, kit đã giữ bị báo hỏng hoặc ngừng dùng) thì Logistics luôn có việc chuẩn bị.
   */
  function refreshRequest(reqId, actor, opt = {}) {
    const r = store.requests.get(reqId);
    // opt.reopen: huỷ kết thúc ghi hình — yêu cầu launch đang thu hồi tính lại từ kit.
    if (!isKitReq(r) || ['closed', 'cancelled', 'live'].includes(r.status) || (r.status === 'ending' && !opt.reopen)) { changed('requests'); return; }
    const addKit = r.kind === 'support';
    const site = store.sites.get(r.site_id);
    const off = !opt.reopen && !!site && ['ending', 'ended'].includes(site.ops_status);
    // BO đang thu hồi / đã kết thúc (ví dụ chuyến giao phần còn lại không giao được, kit về kho): kit chưa giao không còn đi BO này.
    if (off && !dropKitReq(r, actor, 'BO kết thúc ghi hình')) { settleKitReq(r, site, actor, 'BO kết thúc ghi hình'); maybeEnded(site.id, actor); changed('requests', 'jobs'); return; }
    const kits = store.kits.find({ request_id: r.id });
    const cnt = (kind, st) => kits.filter((k) => (k.kind === kind || (k.kind === 'custom' && kind === 'multicam')) && (!st || st.includes(k.status))).length;
    const full = cnt('multicam') >= (r.need.multicam || 0) && cnt('iphone') >= (r.need.iphone || 0) && kits.length > 0;
    const allReady = full && kits.every((k) => k.status === 'reserved');
    let status = r.status;
    if (kits.some((k) => k.status === 'at_bo') && kits.every((k) => k.status === 'at_bo')) status = addKit ? 'closed' : 'live'; // thêm kit: giao xong là xong yêu cầu
    else if (kits.some((k) => ['delivering', 'at_bo'].includes(k.status))) status = 'delivering';
    else if (allReady) status = 'ready';
    else status = kits.length ? 'preparing' : r.status === 'submitted' ? 'submitted' : 'preparing';
    if (status === 'live' && off) status = 'ending'; // kit còn trên đường vừa tới BO đang thu hồi: yêu cầu thu hồi cùng BO
    if (status !== r.status) {
      store.requests.update(r.id, { status, updated_at: now(), ...(status === 'closed' ? { closed_at: now() } : {}) });
      log('request', r.id, 'status', `Yêu cầu ${r.code}: ${REQ_ST[r.status]} → ${REQ_ST[status]}.`, null, { from: r.status, to: status });
      if (status === 'ready') notify({ ids: [r.sale_id] }, 'info', 'request', `Kit ${addKit ? 'thêm ' : ''}cho ${H.siteName(r.site_id)} đã sẵn sàng, chờ giao ngày ${r.launch_date}.`, `request:${r.id}`, `req_ready:${r.id}`);
      if (status === 'closed') notify({ ids: [r.sale_id, r.created_by] }, 'info', 'support', `Đã giao thêm ${kits.length} kit tại ${H.siteName(r.site_id)} (yêu cầu ${r.code}).`, `request:${r.id}`, `support_done:${r.id}`);
    }
    if (status === 'ready') {
      H.jobs.ensure({ type: 'deliver', request_id: r.id, site_id: r.site_id, title: `${addKit ? 'Giao thêm' : 'Giao và setup'} ${kits.length} kit tại ${H.siteName(r.site_id)}`, dedupe: `deliver:${r.id}`, show_date: addDays(r.launch_date, -H.cfg().setupShowDays), launch_date: r.launch_date }, actor);
      H.jobs.closeFor({ type: 'prep_kit', request_id: r.id }, actor, 'Kit đã sẵn sàng');
    } else if (status === 'preparing' || status === 'submitted') {
      // Việc giao chưa vào chuyến (kể cả đang làm tay) không còn đúng khi bộ kit chưa đủ; việc trong chuyến đã bị chặn từ trước (failIfInTrip).
      for (const j of store.jobs.find({ type: 'deliver', request_id: r.id, status: 'doing', task_id: null })) if (j.assignee_id) notify({ ids: [j.assignee_id] }, 'warn', 'job', `Việc ${j.code} dừng lại vì bộ kit của ${H.siteName(r.site_id)} chưa đủ.`, `job:${j.id}`, `deliver_stop:${j.id}`);
      H.jobs.cancelFor({ type: 'deliver', request_id: r.id, task_id: null }, actor, 'Kit chưa sẵn sàng đủ');
      // Còn thiếu kit, hoặc kit đã gán chưa gửi kiểm: phải có việc chuẩn bị đang mở (việc cũ đã xong thì tạo việc mới).
      const miss = missText(r.need, kits), pending = kits.filter((k) => ['preparing', 'returned'].includes(k.status));
      if ((miss || pending.length) && !store.jobs.count({ type: 'prep_kit', request_id: r.id, status: H.jobs.OPEN })) ensurePrep(r, H.siteName(r.site_id), actor, miss ? `Chuẩn bị thêm ${miss}` : `Chuẩn bị và gửi kiểm ${pending.length} kit đã gán`);
    }
    changed('requests', 'jobs');
  }

  /** Giao xong tại BO (FO + BO xác nhận, hoặc Logistics xác nhận tay). Kit sang "đang quay tại BO", BO bắt đầu ghi hình. */
  function delivered(site, kitIds, actor, note) {
    const t = now();
    for (const id of kitIds) {
      const k = store.kits.get(id);
      if (!k || !['reserved', 'delivering', 'ready'].includes(k.status)) continue;
      H.stock.setKit(k, 'at_bo', actor, `Kit ${k.code} đã giao tại ${site.name}${note ? ` (${note})` : ''}.`, { site_id: site.id });
    }
    const patch = { updated_at: t };
    // BO đang ghi hình / tạm nghỉ nhận thêm kit thì giữ nguyên trạng thái và ngày kết thúc đã hẹn; BO chờ launch (hoặc mở lại) thì bắt đầu ghi hình.
    // BO đã kết thúc chỉ mở lại qua yêu cầu mở BO (BO về "chờ launch"); kit thêm đi trên chuyến từ trước tới BO đã kết thúc thì BO quay lại "đang thu hồi" để thu phần này.
    const stray = site.ops_status === 'ended';
    if (stray) patch.ops_status = 'ending';
    else if (!['live', 'paused', 'ending'].includes(site.ops_status)) {
      patch.ops_status = 'live'; patch.launch_date = site.launch_date || today(); patch.end_date = null;
      // Đợt ghi hình mới từ hôm nay (launch lần đầu hoặc launch lại); đợt cũ chưa kết thúc thì chạy tiếp.
      const per = periodsOf(site).map((x) => [...x]), last = per[per.length - 1];
      if (last && (!last[1] || last[1] >= today())) last[1] = null; else per.push([today(), null]);
      patch.live_periods = per;
    }
    if (!site.onboard_date) patch.onboard_date = today(); // lần đầu BO có máy ghi hình: tính là active
    store.sites.update(site.id, patch);
    if ((stray || site.ops_status === 'ending') && !store.jobs.count({ type: 'recover', site_id: site.id, status: H.jobs.OPEN })) {
      // Kit tới BO khi BO đã thu hồi xong đợt trước (chuyến giao đi trước lúc kết thúc): không tự sửa, đưa vào Đối chiếu và tạo việc thu hồi phần này.
      const end = store.requests.find({ site_id: site.id, kind: 'end', status: stray ? ['ending', 'closed'] : 'ending' }, { order: 'created_at', desc: true, limit: 1 })[0];
      const n = store.kits.count({ site_id: site.id, status: 'at_bo' });
      if (stray) log('outlet', site.id, 'ending', `${boLabel(site.name)} đã kết thúc mà nhận ${kitIds.length} kit giao tới: BO chuyển lại "${OUTLET_ST.ending}" để thu phần này.`, actor, { kit_ids: kitIds });
      H.jobs.ensure({ type: 'recover', site_id: site.id, request_id: end ? end.id : null, title: `Thu hồi ${n} kit vừa giao tới ${site.name}`, dedupe: `recover:${site.id}:rest:${H.uniq()}`, due_at: t + 24 * 3600000 }, actor);
      H.recon('deliver', 'logistics', 'high', 'outlet', `deliver_ending:${site.id}`, `${boLabel(site.name)} ${stray ? 'đã kết thúc' : 'đang thu hồi'} mà vừa nhận ${kitIds.length} kit giao tới. Đã tạo việc thu hồi phần này; kiểm lại với Sale vì sao BO kết thúc mà kit vẫn được giao.`, { site_id: site.id, kit_ids: kitIds });
    }
    for (const r of store.requests.find({ site_id: site.id, status: ['ready', 'delivering', 'preparing'] })) if (isKitReq(r)) refreshRequest(r.id, actor);
    H.jobs.syncSwaps(store.sites.get(site.id), actor);
    changed('outlets', 'kits');
  }

  /**
   * Sale bấm "Kết thúc ghi hình": tạo yêu cầu kết thúc và việc thu hồi cho Logistics (hiện từ ngày kết thúc).
   * Kết thúc từ hôm nay thì BO sang "đang thu hồi" ngay. Hẹn ngày sau thì BO vẫn ghi hình, đổi thẻ, nhận hỗ trợ tới trước ngày đó;
   * nhịp định kỳ chuyển BO sang "đang thu hồi" đúng ngày. Sale phụ trách / Head of Sale huỷ được khi FO chưa đi thu (huỷ yêu cầu kết thúc).
   */
  R('POST', '/api/hub/outlets/:id/end', ['admin', 'lead', 'logistic', 'sale', 'sale_head'], ({ user, p, b }) => {
    const s = outletOrFail(p.id, user, true);
    if (!['live', 'paused'].includes(s.ops_status)) fail(409, 'bad_state', `BO đang "${OUTLET_ST[s.ops_status || 'planned']}", không kết thúc được.`);
    const d = today(), end = b.date || d;
    if (!isDate(end) || end < d) fail(400, 'bad_date', 'Ngày kết thúc không hợp lệ.');
    const dup = store.requests.find({ site_id: s.id, kind: 'end', status: ['scheduled', 'ending'] }, { limit: 1 })[0];
    if (dup) fail(409, 'dup_end', `BO đã hẹn kết thúc từ ngày ${dm((dup.need && dup.need.end_date) || s.end_date)} (yêu cầu ${dup.code}). Muốn đổi ngày thì huỷ yêu cầu đó rồi gửi lại.`);
    const t = now(), later = end > d;
    let req;
    store.tx(() => {
      req = { code: H.nextCode('Y' + H.ym() + '-', 'requests', 3), kind: 'end', site_id: s.id, parent_id: null, sale_id: s.sale_id, created_by: user.id, status: later ? 'scheduled' : 'ending', need: { end_date: end }, launch_date: null, kit_id: null, note: cleanText(b.note, 500), reason: '', created_at: t, updated_at: t, closed_at: null, prev: null };
      req.id = store.requests.insert(req);
      // Đợt ghi hình cuối kết thúc theo ngày hẹn (huỷ kết thúc thì mở lại).
      const per = periodsOf(s).map((x) => [...x]), last = per[per.length - 1];
      if (last && !last[1]) last[1] = end;
      store.sites.update(s.id, { end_date: end, live_periods: per, updated_at: t });
      const kits = store.kits.count({ site_id: s.id, status: 'at_bo' });
      H.jobs.ensure({ type: 'recover', site_id: s.id, request_id: req.id, title: `Thu hồi ${kits} kit tại ${s.name}`, dedupe: `recover:${s.id}:${req.id}`, show_date: end, due_at: Date.parse(H.addDays(end, 2) + 'T00:00:00Z') - H.off * 60000 }, user);
      log('request', req.id, 'create', `${user.name} tạo yêu cầu kết thúc ${req.code} cho ${s.name}${later ? `, từ ngày ${end}` : ''}.`, user);
      if (later) {
        log('outlet', s.id, 'end_scheduled', `${user.name} hẹn kết thúc ghi hình tại ${s.name} từ ngày ${end}; trước ngày đó BO vẫn ghi hình và đổi thẻ.`, user);
        H.jobs.syncSwaps(store.sites.get(s.id), user); // chỉ bỏ các lượt đổi thẻ từ ngày kết thúc
      } else {
        log('outlet', s.id, 'end', `${user.name} bấm kết thúc ghi hình tại ${s.name} từ ngày ${end}.`, user);
        beginEnding(store.sites.get(s.id), store.requests.get(req.id), user);
      }
    });
    notify({ roles: ['lead', 'logistic'] }, 'warn', 'end', later ? `${user.name} hẹn kết thúc ghi hình tại ${s.name} từ ${end}. Việc thu hồi đã lên lịch, hiện từ ngày đó.` : `${user.name} kết thúc ghi hình tại ${s.name} từ ${end}. Đã tạo việc thu hồi.`, `outlet:${s.id}`);
    changed('outlets', 'requests', 'jobs');
    return { request: reqBrief(store.requests.get(req.id)) };
  });
  /**
   * BO bắt đầu thu hồi (kết thúc từ hôm nay, tới ngày hẹn, hoặc Logistics thu sớm): BO và yêu cầu sang "đang thu hồi",
   * việc đổi thẻ và đổi kit hỏng chưa lên chuyến huỷ (kit lỗi về cùng đợt thu hồi), yêu cầu hỗ trợ còn mở được đóng.
   */
  function beginEnding(s, req, actor) {
    const t = now();
    store.sites.update(s.id, { ops_status: 'ending', updated_at: t });
    for (const r of store.requests.find({ site_id: s.id, kind: 'launch', status: ['live', 'delivering'] })) {
      // Launch giao dở: kit chưa giao về kho, việc giao phần còn lại huỷ. Kit còn trên đường thì giữ "đang giao" (Đối chiếu đã ghi).
      if (r.status === 'delivering' && dropKitReq(r, actor, 'BO kết thúc ghi hình')) continue;
      store.requests.update(r.id, { status: 'ending', updated_at: t });
    }
    if (req && req.status !== 'ending') { // yêu cầu đã hẹn ngày: tới ngày (nhịp định kỳ) hoặc Logistics thu sớm
      store.requests.update(req.id, { status: 'ending', updated_at: t });
      log('request', req.id, 'status', `Yêu cầu ${req.code}: ${REQ_ST[req.status]} → ${REQ_ST.ending}.`, null, { from: req.status, to: 'ending' });
      // Không ghi tên người thu (có thể là FO): nhật ký BO Sale cũng đọc; người làm đã lưu ở actor_id.
      log('outlet', s.id, 'end', actor ? `Logistics thu hồi tại ${s.name} trước ngày kết thúc đã hẹn (${req.code}): BO chuyển đang thu hồi.` : `${s.name} tới ngày kết thúc đã hẹn (${req.code}): BO chuyển đang thu hồi.`, actor);
    }
    H.jobs.syncSwaps(store.sites.get(s.id), actor);
    // Việc đổi kit hỏng chưa lên chuyến không còn cần: kit lỗi về cùng đợt thu hồi và tự chuyển Tech sửa (cờ lỗi giữ nguyên).
    // Việc đang chờ Logistic Lead đối chiếu sau chuyến (FO có thể đã đổi thật) giữ lại để Lead ghi đúng thực tế.
    H.jobs.cancelFor({ type: 'swap_faulty', site_id: s.id, task_id: null }, actor, 'BO kết thúc, kit lỗi về cùng đợt thu hồi', { keepHeld: true });
    settleSupportOf(s.id, actor, 'BO kết thúc ghi hình');
    if (req) { const n = store.kits.count({ site_id: s.id, status: 'at_bo' }); for (const j of store.jobs.find({ type: 'recover', request_id: req.id, status: H.jobs.OPEN, task_id: null })) store.jobs.update(j.id, { title: `Thu hồi ${n} kit tại ${s.name}` }); }
    changed('outlets', 'requests', 'jobs');
  }
  /**
   * BO kết thúc: yêu cầu hỗ trợ còn mở không còn làm được. Việc chưa lên chuyến huỷ (thêm kit: kit trả về kho), yêu cầu đóng và Sale được báo.
   * Việc đã lên chuyến FO vẫn chạy; xong chuyến thì yêu cầu tự đóng.
   */
  function settleSupportOf(siteId, actor, why) {
    for (const r of store.requests.find({ site_id: siteId, kind: 'support', status: ['submitted', 'preparing', 'ready', 'delivering'] })) {
      if (isKitReq(r)) { if (!dropKitReq(r, actor, why)) settleKitReq(r, store.sites.get(siteId), actor, why); continue; }
      // Việc đang chờ Logistic Lead đối chiếu sau chuyến giữ lại (yêu cầu còn mở theo việc đó); việc trong chuyến chạy tiếp.
      H.jobs.cancelFor({ request_id: r.id, task_id: null, type: ['swap_faulty', 'deliver_acc', 'manual', 'prep_kit', 'deliver'] }, actor, why, { keepHeld: true });
      H.jobs.settleSupport(r.id, actor, why);
    }
  }
  /**
   * Yêu cầu mở BO / thêm kit mà BO kết thúc khi kit chưa giao hết: kit chưa rời kho trả về (giữ chỗ → sẵn sàng), việc chuẩn bị / giao chưa chạy huỷ
   * (gỡ khỏi chuyến chưa bắt đầu), việc kiểm của Tech bỏ liên kết yêu cầu. Kit đang theo FO (chuyến đã chạy) hoặc việc giao đang chờ Logistic Lead
   * đối chiếu: kit có thể đã tới BO nên không tự sửa — giữ nguyên, đưa vào Đối chiếu cho Logistics. Trả về true khi còn phần đang giữ.
   */
  function dropKitReq(r, actor, why) {
    const site = store.sites.get(r.site_id);
    const name = site ? boLabel(site.name) : 'BO';
    const open = store.jobs.find({ request_id: r.id, type: 'deliver', status: H.jobs.OPEN });
    // Việc giao đã xếp vào chuyến FO (kể cả chuyến chưa chạy) hoặc đang chờ đối chiếu: không tự huỷ, Logistics xử lý theo thực tế.
    const inTrip = (j) => { const tk = j.task_id ? store.tasks.get(j.task_id) : null; return !!tk && ['assigned', 'accepted', 'in_progress', 'unassigned'].includes(tk.status); };
    const busy = open.filter((j) => inTrip(j) || !!H.jobs.heldRecon(j.id));
    const away = store.kits.find({ request_id: r.id, status: 'delivering' });
    if (busy.length || away.length) {
      const left = store.kits.find({ request_id: r.id, status: ['reserved', 'delivering'] });
      H.recon('deliver', 'logistics', 'high', 'request', `endkit:${r.id}`, `${name} kết thúc ghi hình khi yêu cầu ${r.code} còn ${left.length} kit chưa ghi là đã giao (${left.map((k) => k.code).join(', ')}); việc giao ${busy.map((j) => j.code).join(', ') || ''} ${busy.some((j) => H.jobs.heldRecon(j.id)) ? 'đang chờ đối chiếu số lượng' : 'đang xếp trên chuyến FO'}. Hệ thống không tự chuyển kit: chuyến chưa chạy thì gỡ việc khỏi chuyến nếu không giao nữa; kit tới BO thì thu cùng đợt thu hồi; FO mang về thì kit trở về kho.`, { request_id: r.id, site_id: r.site_id, kit_ids: left.map((k) => k.id), jobs: busy.map((j) => j.id) });
      return true;
    }
    const freed = [];
    H.jobs.cancelFor({ request_id: r.id, type: ['deliver', 'prep_kit'] }, actor, why);
    for (const k of store.kits.find({ request_id: r.id })) {
      if (KIT_OUTSIDE.includes(k.status)) continue;
      store.kits.update(k.id, { request_id: null, updated_at: now() });
      if (k.status === 'reserved') H.stock.setKit({ ...k, request_id: null }, 'ready', actor, `Yêu cầu ${r.code} không giao tiếp (${why}), kit ${k.code} trả về sẵn sàng.`);
      else log('kit', k.id, 'unassign', `Yêu cầu ${r.code} không giao tiếp (${why}), kit ${k.code} bỏ gán.`, actor);
      freed.push(k.code);
    }
    for (const j of store.jobs.find({ request_id: r.id, type: 'check_kit', status: H.jobs.OPEN })) store.jobs.update(j.id, { request_id: null });
    if (freed.length) {
      log('request', r.id, 'undelivered', `${why}: ${freed.length} kit chưa giao của ${r.code} (${freed.join(', ')}) không giao tới ${name} nữa, trả về kho.`, actor, { kits: freed });
      notify({ roles: ['lead', 'logistic'] }, 'info', 'end', `${name} kết thúc ghi hình: kit chưa giao của ${r.code} (${freed.join(', ')}) trả về kho, việc giao còn lại đã huỷ.`, `request:${r.id}`);
      changed('kits');
    }
    return false;
  }
  /** Yêu cầu có kit không còn phần nào đang giữ ở BO kết thúc: thêm kit thì đóng (huỷ phần chưa giao), mở BO thì theo BO (đang thu hồi / đã đóng). */
  function settleKitReq(r, site, actor, why) {
    const cur = store.requests.get(r.id);
    if (['closed', 'cancelled'].includes(cur.status)) return;
    if (cur.kind === 'support') { H.jobs.settleSupport(cur.id, actor, why); return; }
    const to = site && site.ops_status === 'ended' ? 'closed' : 'ending';
    if (cur.status === to) return;
    store.requests.update(cur.id, { status: to, updated_at: now(), ...(to === 'closed' ? { closed_at: now() } : {}) });
    log('request', cur.id, 'status', `Yêu cầu ${cur.code}: ${REQ_ST[cur.status]} → ${REQ_ST[to]}.`, null, { from: cur.status, to });
  }
  /** Thu hồi xong hết kit: BO kết thúc, yêu cầu đóng; yêu cầu hỗ trợ còn sót (việc từng nằm trong chuyến) cũng đóng. */
  function maybeEnded(siteId, actor) {
    const s = store.sites.get(siteId);
    if (!s || s.ops_status !== 'ending') return;
    if (store.kits.count({ site_id: siteId, status: ['at_bo', 'delivering'] })) return;
    // Kit của yêu cầu mở BO / thêm kit đang trên đường (chuyến FO đang chạy) hoặc việc giao đang chờ Lead đối chiếu: chưa rõ kit ở đâu
    // nên BO chưa kết thúc; kit tới BO thì thu cùng đợt, về kho thì yêu cầu được dọn (refreshRequest). Kit còn ở kho (chuyến chưa chạy) không chặn.
    const pend = store.requests.find({ site_id: siteId, status: ['submitted', 'preparing', 'ready', 'delivering'] }).filter(isKitReq);
    const unsure = (r) => store.kits.count({ request_id: r.id, status: 'delivering' }) || store.jobs.find({ request_id: r.id, type: 'deliver', status: H.jobs.OPEN }).some((j) => H.jobs.heldRecon(j.id));
    if (pend.some(unsure)) return;
    const t = now();
    store.sites.update(siteId, { ops_status: 'ended', updated_at: t });
    for (const r of store.requests.find({ site_id: siteId, status: 'ending' })) store.requests.update(r.id, { status: 'closed', closed_at: t, updated_at: t });
    settleSupportOf(siteId, actor, 'BO đã kết thúc ghi hình');
    log('outlet', siteId, 'ended', `${s.name}: đã thu hồi hết kit, BO kết thúc ghi hình.`, actor);
    notify({ ids: [s.sale_id] }, 'info', 'end', `Đã thu hồi xong thiết bị tại ${s.name}.`, `outlet:${s.id}`, `ended:${s.id}:${t}`);
    changed('outlets', 'requests');
  }

  /** Yêu cầu hỗ trợ từ Sale hoặc Logistics trên BO đang ghi hình: đổi máy hư, thẻ hư, bổ sung phụ kiện, thêm kit. */
  R('POST', '/api/hub/outlets/:id/support', ['admin', 'lead', 'logistic', 'sale', 'sale_head', 'tech_lead', 'tech'], ({ user, p, b }) => {
    const s = outletOrFail(p.id, user, true);
    if (!SUPPORT_KIND[b.kind]) fail(400, 'bad_kind', 'Chọn loại hỗ trợ.');
    if (!['live', 'paused'].includes(s.ops_status)) fail(409, 'not_live', s.ops_status === 'ending' ? `${s.name} đang thu hồi thiết bị: kit lỗi hoặc thiếu sẽ về kho cùng đợt thu hồi và tự chuyển Tech. Có sự cố cần ghi nhận thì báo sự cố.` : `${s.name} đang "${OUTLET_ST[s.ops_status || 'planned']}", chỉ gửi hỗ trợ cho BO đang ghi hình hoặc tạm nghỉ.`);
    const note = cleanText(b.note, 500);
    if (note.length < 3) fail(400, 'reason_required', 'Cần mô tả ngắn yêu cầu.');
    // Cùng hộp thoại gửi lại: trả yêu cầu của lần trước, không tạo thêm và không cộng dồn phụ kiện lần nữa.
    const key = H.reqKeyOf(b);
    const again = H.replayOf('request', ['create', 'merge'], user, key);
    if (again && store.requests.get(again.entity_id)) return { request: reqBrief(store.requests.get(again.entity_id)), merged: again.action === 'merge', replay: true };
    const keyData = key ? { req_key: key } : null;
    let addNeed = null;
    if (b.kind === 'add_kit') {
      addNeed = needInput(b.need);
      if (!isDate(b.launch_date) || b.launch_date < today()) fail(400, 'bad_date', 'Chọn ngày giao kit (từ hôm nay trở đi).');
      const dup = store.requests.find({ site_id: s.id, kind: 'support', status: ['preparing', 'ready', 'delivering'] }).find(isKitReq);
      if (dup) fail(409, 'dup_request', `BO đã có yêu cầu thêm kit ${dup.code} đang xử lý. Cần thêm nữa thì sửa số kit ở yêu cầu đó.`);
    }
    const t = now();
    const parent = store.requests.find({ site_id: s.id, kind: 'launch' }, { order: 'created_at', desc: true, limit: 1 })[0];
    let req, merged = false;
    // Mã yêu cầu chỉ cấp khi thật sự tạo yêu cầu mới (gộp vào yêu cầu cũ hoặc bị chặn thì không làm nhảy số).
    const insertReq = () => { req.code = H.nextCode('Y' + H.ym() + '-', 'requests', 3); req.id = store.requests.insert(req); };
    store.tx(() => {
      req = { kind: 'support', site_id: s.id, parent_id: parent ? parent.id : null, sale_id: s.sale_id, created_by: user.id, status: 'preparing', need: { kind: b.kind }, launch_date: null, kit_id: null, note, reason: b.kind, created_at: t, updated_at: t, closed_at: null, prev: null };
      if (b.kind === 'add_kit') {
        // Thêm kit: đi đúng vòng như mở BO (Logistics gán và chuẩn bị, Tech kiểm, giao có biên bản); giao xong BO giữ nguyên trạng thái, yêu cầu đóng.
        req.need = { ...addNeed, kind: 'add_kit' }; req.launch_date = b.launch_date;
        insertReq();
        ensurePrep(req, s.name, user, `Chuẩn bị thêm ${needText(addNeed)}`);
      } else if (b.kind === 'swap_device') {
        const kit = H.stock.kitOrFail(b.kit_id);
        if (kit.site_id !== s.id || kit.status !== 'at_bo') fail(409, 'bad_kit', 'Chọn kit đang ở BO này.');
        const sw = store.jobs.find({ type: 'swap_faulty', kit_id: kit.id, status: H.jobs.OPEN }, { limit: 1 })[0];
        if (sw) fail(409, 'dup_swap', `Kit ${kit.code} đã có việc đổi kit ${sw.code} đang chờ Logistics${sw.task_id ? ' (đã lên chuyến FO)' : ''}. Không cần gửi lại; thêm ghi chú vào sự cố nếu có lỗi mới.`);
        req.kit_id = kit.id;
        insertReq();
        const inc = H.incidents.create({ site_id: s.id, kit_id: kit.id, device_id: b.device_id || null, label: cleanStr(b.label, 60) || 'Khác', text: note }, user, { skipJob: true });
        H.stock.reportFaulty(kit, b.device_id ? K.idOf(b.device_id) : null, note, user, { incident_id: inc.id, request_id: req.id });
      } else if (b.kind === 'extra_acc') {
        // Bổ sung phụ kiện: ghi rõ loại, số lượng và kit nhận; khi giao xong phụ kiện tự cộng vào kit và trừ khỏi số rảnh.
        const acc = H.stock.accInput(b.acc) || {};
        if (!Object.keys(acc).length) fail(400, 'acc_required', 'Chọn loại và số lượng phụ kiện cần bổ sung.');
        const atBo = store.kits.find({ site_id: s.id, status: 'at_bo' });
        const kit = b.kit_id ? H.stock.kitOrFail(b.kit_id) : atBo.length === 1 ? atBo[0] : fail(400, 'kit_required', 'BO có nhiều kit: chọn kit cần bổ sung phụ kiện.');
        if (kit.site_id !== s.id || kit.status !== 'at_bo') fail(409, 'bad_kit', 'Chọn kit đang ở BO này.');
        const types = H.stock.typeMap();
        const accText = (a) => Object.entries(a).map(([t, q]) => `${q} ${(types.get(t) || {}).name || t}`).join(', ');
        // Kit đã có việc giao phụ kiện chưa lên chuyến: gộp vào yêu cầu đó để Logistics đi một lần, không sinh việc trùng.
        const prev = store.jobs.find({ type: 'deliver_acc', kit_id: kit.id, status: H.jobs.OPEN, task_id: null }, { limit: 1 })[0];
        const prevReq = prev && prev.request_id ? store.requests.get(prev.request_id) : null;
        if (prevReq && prevReq.kind === 'support' && prevReq.status === 'preparing') {
          const sum = { ...((prevReq.need && prevReq.need.acc) || {}) };
          for (const [t, q] of Object.entries(acc)) sum[t] = (sum[t] || 0) + q;
          store.requests.update(prevReq.id, { need: { ...prevReq.need, acc: sum }, note: [prevReq.note, note].filter(Boolean).join(' · ').slice(0, 500), updated_at: t });
          store.jobs.update(prev.id, { title: `Giao ${accText(sum)} cho kit ${kit.code} tại ${s.name}`, note: [prev.note, note].filter(Boolean).join(' · ').slice(0, 500) });
          log('request', prevReq.id, 'merge', `${user.name} bổ sung ${accText(acc)} vào yêu cầu ${prevReq.code} (gộp, cùng kit ${kit.code}): ${note}`, user, keyData);
          if (prev.assignee_id && prev.assignee_id !== user.id) notify({ ids: [prev.assignee_id] }, 'info', 'job', `${prev.code} có thêm ${accText(acc)} cần giao cho kit ${kit.code} (gộp yêu cầu mới).`, `job:${prev.id}`);
          req = prevReq; merged = true;
          return;
        }
        req.kit_id = kit.id; req.need = { kind: b.kind, acc };
        insertReq();
        const text = accText(acc);
        const short = Object.entries(acc).filter(([t, q]) => H.stock.accFree(t) < q).map(([t]) => (types.get(t) || {}).name || t);
        H.jobs.ensure({ type: 'deliver_acc', site_id: s.id, kit_id: kit.id, request_id: req.id, title: `Giao ${text} cho kit ${kit.code} tại ${s.name}`, note: note + (short.length ? ` · Kho đang thiếu: ${short.join(', ')}` : ''), dedupe: `acc:${req.id}` }, user);
        if (short.length) notify({ roles: ['lead'] }, 'warn', 'acc_short', `Yêu cầu ${req.code} cần ${text} cho ${s.name} nhưng kho không đủ ${short.join(', ')}. Ghi nhập thêm hoặc lấy từ kit khác.`, `request:${req.id}`);
      } else {
        insertReq();
        const title = b.kind === 'bad_card' ? `Thẻ hư tại ${s.name}` : `Hỗ trợ ${s.name}`;
        H.jobs.ensure({ type: 'manual', team: 'logistics', site_id: s.id, request_id: req.id, title, note, dedupe: `support:${req.id}` }, user);
      }
      log('request', req.id, 'create', `${user.name} gửi yêu cầu hỗ trợ ${req.code} (${SUPPORT_KIND[b.kind]}${addNeed ? `: ${needText(addNeed)}, giao ${b.launch_date}` : ''}) cho ${s.name}: ${note}`, user, keyData);
    });
    notify({ roles: ['lead', 'logistic'] }, 'warn', 'support', `Yêu cầu hỗ trợ ${req.code} tại ${s.name}: ${SUPPORT_KIND[b.kind]} — ${note}`, `request:${req.id}`);
    changed('requests', 'jobs');
    return { request: reqBrief(store.requests.get(req.id)), merged };
  });

  // Dữ liệu trước khi có ngày ký: điền từ yêu cầu launch đầu tiên không huỷ (người gửi là Sale Lead thì ghi cho người đó, không thì Sale phụ trách
  // ghi trên yêu cầu); BO đã ghi hình mà không có yêu cầu (nhập từ file) thì lấy ngày active và Sale đang phụ trách. Chạy khi khởi động, có ghi nhật ký.
  const unsigned = store.sites.find({ type: 'bo', signed_date: null });
  if (unsigned.length) store.tx(() => {
    const done = [];
    for (const s of unsigned) {
      const r = store.requests.find({ site_id: s.id, kind: 'launch', status: { ne: 'cancelled' } }, { order: 'created_at', limit: 1 })[0];
      const u = r && store.users.get(r.created_by);
      const v = r ? { signed_date: localDate(r.created_at, H.off), signed_by: u && u.role === 'sale' ? u.id : r.sale_id ?? null } : activeOf(s) ? { signed_date: activeOf(s), signed_by: s.sale_id ?? null } : null;
      if (v) { store.sites.update(s.id, v); done.push(s.id); }
    }
    if (done.length) log('outlet', null, 'backfill', `Điền ngày onboard (ngày ký) cho ${done.length} BO từ yêu cầu launch đầu tiên không huỷ.`, null, { ids: done });
  });
  // Bản ghi dung lượng trước khi có khoảng ngày ghi: điền từ ngày thu thẻ hoặc lần đổi thẻ kế tiếp của BO (fillCover). Chạy khi khởi động, có ghi nhật ký.
  if (store.card_records.count({ cover_to: null })) store.tx(() => {
    const n = fillCover(null);
    if (n) log('card', null, 'backfill', `Điền khoảng ngày ghi cho ${n} bản ghi dung lượng cũ (tới hôm trước lần đổi thẻ kế tiếp của BO), để giờ của thẻ chia đúng theo ngày.`, null, { n });
  });

  return { outletOrFail, swapDue, refreshRequest, delivered, maybeEnded, beginEnding, syncPause, reqBrief, reqBriefs, reqScope, waitingOf, isKitReq, hoursBySite, saleScope, needText, onboardOf, usedHours, riderCreate, riderEdit, riderRemove, activeOf, signerOf, periodsOf, pausesOf, quotaFrom, quotaStatus, QUOTA_ST, rateDays, hoursSeries, fillCover, memoRead };
}
