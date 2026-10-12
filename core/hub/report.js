// report.js — tổng quan toàn khối vận hành cho Lead, bảng của Sale, danh sách theo dõi, Đối chiếu, hộp thư, nhật ký,
// cài đặt (mỗi mục ghi team có quyền chốt), xuất CSV.
import { cleanStr, cleanText, int, num, isDate, isHM, addDays, atTime, csvCell, boLabel } from '../util.js';
import { fail } from '../core.js';
import { HUB_DEFAULTS, HUB_OWNER, HUB_LABEL, TEAM_CFG, JOB_TYPES, KIT_ST, REQ_ST, CARD_ST, INCIDENT_RES, OUTLET_ST, DEFAULT_LABELS } from './defs.js';
import { periodOf, shiftWeek, shiftMonth, weekRange, monthRange, rangeOf, tsRange, weekLabel, monthLabel, weekKey } from './period.js';

// Làm tròn 1 chữ số thập phân sau khi gạt nhiễu dấu phẩy động (tổng nhiều phân số như 1306,65 có thể ra 1306,6499999 tuỳ thứ tự cộng):
// số hiển thị ở mọi bảng phải bằng nhau dù cộng theo BO hay theo từng bản ghi.
const r1 = (x) => (x === null || x === undefined ? null : Math.round(Math.round(x * 1e6) / 1e5) / 10);
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);
/** Khoảng dài nhất (ngày) giữa hai ngày đổi thẻ liền nhau theo lịch tuần của BO ('1,3,5' → 3: thứ Sáu tới thứ Hai). Không có lịch → 0. */
function swapGap(days) {
  const d = [...new Set(String(days || '').split(',').map(Number).filter((x) => x >= 1 && x <= 7))].sort((a, b) => a - b);
  if (!d.length) return 0;
  return Math.max(d[0] + 7 - d[d.length - 1], ...d.slice(1).map((x, i) => x - d[i]));
}

export function installReport(H) {
  const { K, G, store, now, off, today, log, changed } = H;
  const { R } = K;
  const OPEN = ['open', 'doing'];

  // ───────────────────────── Số liệu chung ─────────────────────────
  /**
   * Giờ ghi hình, số thẻ, thẻ 0 giờ trong khoảng. Nguồn duy nhất: card_records qua H.outlets.hoursBySite (giờ của thẻ chia theo các ngày thẻ ghi;
   * số thẻ theo ngày quay). Cộng số thô của mọi BO rồi làm tròn một lần, nên khớp với tổng của bảng Sale và Head of Sale.
   * Chỉ tính BO đang hoạt động, giống bảng Sale và Head of Sale. Bản ghi chưa rõ BO (Tech chưa chọn BO, đang chờ đối chiếu) trả riêng ở nosite;
   * bản ghi của BO đã ngừng hoạt động trả riêng ở offbo. Thẻ 0 giờ đếm theo số giờ (đã làm tròn), cùng cách với danh sách thẻ 0 giờ của BO.
   */
  const liveBo = () => new Set(store.sites.find({ active: 1, type: 'bo' }, { cols: ['id'] }).map((s) => s.id));
  const footageOf = (x) => ({ hours: r1(x.total), cards: x.cards, zero: x.zero, under1h: x.under1h, tb: r1(x.gb / 1024) });
  const footSum = (x) => ({ hours: r1(x.total), cards: x.cards });
  const addTo = (x, m) => { x.total += m.total; x.gb += m.gb; x.cards += m.cards; x.zero += m.zero; x.under1h += m.under1h; };
  const blank = () => ({ total: 0, gb: 0, cards: 0, zero: 0, under1h: 0 });
  function footage(from, to, siteIds) {
    const live = liveBo(), x = blank(), ns = blank(), ob = blank();
    for (const [sid, m] of H.outlets.hoursBySite(siteIds || null, from, to)) addTo(!sid ? ns : live.has(sid) ? x : ob, m);
    return { ...footageOf(x), nosite: footSum(ns), offbo: footSum(ob) };
  }
  /**
   * Chuỗi giờ quay theo nhiều khoảng (12 tuần, 12 tháng): một lượt đọc cả khoảng (H.outlets.hoursSeries), cùng số với footage() từng khoảng.
   * Chỉ BO đang hoạt động (như footage).
   */
  function footageSeries(ranges, siteIds) {
    return H.memo(`fser|${H.idsKey(siteIds || null)}|${ranges.map((r) => r.from + '~' + r.to).join(',')}`, () => {
      const live = liveBo();
      return H.outlets.hoursSeries(siteIds || null, ranges, (id) => live.has(id)).map(footageOf);
    });
  }
  /** Tỉ lệ đúng hạn của team: cùng một nguồn với bảng hiệu suất (H.people.teamSla, chỉ việc thành viên team làm). */
  const slaTeam = (team, t0, t1) => H.people.teamSla(team, t0, t1);
  function queue(team) {
    const t = now(), d = today();
    const open = store.jobs.find({ team, status: OPEN }).filter((j) => !j.show_date || j.show_date <= d);
    return { open: open.length, doing: open.filter((j) => j.status === 'doing').length, overdue: open.filter((j) => !j.blocked && j.due_at && j.due_at < t).length, blocked: open.filter((j) => j.blocked).length, pool: open.filter((j) => !j.assignee_id && j.status === 'open').length, urgent: open.filter((j) => j.priority).length };
  }
  function onShiftCount(team) {
    const roles = team === 'tech' ? ['tech', 'tech_lead'] : ['logistic', 'lead'];
    const users = store.users.find({ role: roles, active: 1 });
    return { on: users.filter((u) => H.jobs.onShift(u)).length, total: users.length };
  }
  function countBy(rows, k) { const o = {}; for (const r of rows) o[r[k]] = (o[r[k]] || 0) + 1; return o; }

  /** Danh sách "Theo dõi": những thứ cần người xử lý ngay, kèm tên BO và thông tin kit. */
  function watchList(user) {
    const t = now(), d = today(), out = [], c = H.cfg();
    const push = (level, kind, text, link, team) => out.push({ level, kind, text, link, team });
    // Sale không thấy tên FO (vị trí, chuyến của FO là dữ liệu riêng của Logistics): chỉ ghi vai "FO".
    const who = (uid) => { const u = uid ? H.rowOf('users', uid) : null; return !u ? '' : u.role === 'fo' && H.isSale(user) ? H.ROLE_LABEL.fo : u.name; };
    for (const k of store.kits.find({ status: 'at_bo' })) {
      if (k.fault) { const j = store.jobs.find({ type: 'swap_faulty', kit_id: k.id, status: OPEN }, { limit: 1 })[0]; push('high', 'kit_fault', `Kit ${k.code} tại ${H.siteName(k.site_id)} đang lỗi: ${k.fault}${j ? ` · việc đổi kit ${j.code}${j.assignee_id ? ` (${who(j.assignee_id)})` : ' chưa ai nhận'}` : ''}`, `kit:${k.id}`, 'logistics'); }
      else if (k.watch) push('mid', 'kit_watch', `Kit ${k.code} tại ${H.siteName(k.site_id)}: ${k.watch}`, `kit:${k.id}`, 'tech');
    }
    const incs = store.incidents.find({ status: ['open', 'ack'] }, { order: 'created_at' });
    // Việc đang mở của các sự cố đang mở: một lượt đọc cho cả danh sách (không đếm riêng từng sự cố).
    const incJobs = new Map();
    if (incs.length) for (const j of store.jobs.find({ incident_id: incs.map((i) => i.id), type: ['incident', 'swap_faulty'], status: OPEN }, { cols: ['incident_id', 'type'] })) {
      const x = incJobs.get(j.incident_id) || { incident: 0, swap: 0 };
      if (j.type === 'incident') x.incident++; else x.swap++;
      incJobs.set(j.incident_id, x);
    }
    for (const i of incs) {
      const age = (t - i.created_at) / 60000;
      // Sự cố gửi kèm yêu cầu đổi máy (chỉ có việc đổi kit của Logistics, không có việc của Tech): không chờ Tech nhận.
      const ij = incJobs.get(i.id) || { incident: 0, swap: 0 };
      const swapOnly = !ij.incident && ij.swap > 0;
      if (i.status === 'open' && !swapOnly && age > c.incidentAckMin) push('high', 'incident_unacked', `Sự cố ${i.code} tại ${H.siteName(i.site_id)} (${i.label}) chưa có Tech nhận sau ${Math.round(age)} phút`, `incident:${i.id}`, 'tech');
      else if (age > c.incidentOldH * 60) push('mid', 'incident_old', `Sự cố ${i.code} tại ${H.siteName(i.site_id)} (${i.label}) mở hơn ${Math.round(age / 60)} giờ${swapOnly ? ', chờ đổi kit' : ''}`, `incident:${i.id}`, swapOnly ? 'logistics' : 'tech');
    }
    for (const j of store.jobs.find({ status: OPEN })) {
      if (j.blocked) push('high', 'job_blocked', `${j.title} đang vướng: ${j.blocked} (${j.assignee_id ? who(j.assignee_id) : 'chưa ai nhận'}, ${Math.round((t - j.blocked_at) / 3600000)} giờ)`, `job:${j.id}`, j.team);
      else if (j.due_at && t - j.due_at > H.tcfg('leadOverdueMin', j.team, c) * 60000 && (!j.show_date || j.show_date <= d)) push('mid', 'job_overdue', `${j.title} quá hạn ${Math.round((t - j.due_at) / 3600000)} giờ (${j.assignee_id ? who(j.assignee_id) : 'chưa ai nhận'})`, `job:${j.id}`, j.team);
    }
    for (const r of store.requests.find({ kind: ['launch', 'support'], status: ['submitted', 'preparing'] })) {
      if (!H.outlets.isKitReq(r)) continue; // mở BO, hoặc thêm kit cho BO đang ghi hình
      if (r.launch_date && r.launch_date <= addDays(d, c.reqLateDays)) push('high', 'request_late', `Yêu cầu ${r.code} (${H.siteName(r.site_id)}) ${r.kind === 'launch' ? 'launch' : 'giao thêm kit'} ${r.launch_date.slice(8, 10)}/${r.launch_date.slice(5, 7)} nhưng kit chưa sẵn sàng (${REQ_ST[r.status]})`, `request:${r.id}`, 'logistics');
    }
    for (const s of store.sites.find({ active: 1, type: 'bo', ops_status: 'live' })) {
      const miss = [];
      if (s.lat === null || s.lon === null) miss.push('toạ độ');
      if (!s.contact) miss.push('người liên hệ');
      if (!s.swap_from || !s.swap_to) miss.push('khung giờ đổi thẻ');
      if (!s.swap_days) miss.push('ngày đổi thẻ');
      if (miss.length) push('low', 'outlet_data', `${boLabel(s.name)} đang ghi hình nhưng thiếu ${miss.join(', ')}`, `outlet:${s.id}`, 'sale');
    }
    const quotaSites = store.sites.find({ active: 1, type: 'bo', ops_status: H.outlets.QUOTA_ST }).filter((s) => s.quota_hours);
    if (quotaSites.length) {
      const used = H.outlets.usedHours(quotaSites.map((s) => s.id));
      for (const s of quotaSites) {
        const u = used.get(s.id) || 0, p = (u / s.quota_hours) * 100, st = H.outlets.quotaStatus(u, s.quota_hours);
        if (st === 'over') push('high', 'quota_over', `${boLabel(s.name)} đã dùng ${Math.round(p)}% quota giờ quay (${Math.round(u)}/${s.quota_hours} giờ)`, `outlet:${s.id}`, 'sale');
        else if (st === 'near') push('mid', 'quota_near', `${boLabel(s.name)} sắp chạm quota: ${Math.floor(p)}% (${Math.floor(u)}/${s.quota_hours} giờ)`, `outlet:${s.id}`, 'sale');
      }
    }
    // Ngưỡng vòng thẻ: cài đặt của team chốt (cùng mục với Điểm nghẽn). Thẻ ở BO: BO đổi thưa hơn ngưỡng thì tính theo khoảng dài nhất giữa hai ngày đổi + 1 ngày.
    const boDays = new Map();
    const boLimit = (sid) => { if (!boDays.has(sid)) { const s = sid ? H.rowOf('sites', sid) : null; boDays.set(sid, Math.max(c.cardsStaleDays, s ? swapGap(s.swap_days) + 1 : 0)); } return boDays.get(sid); };
    const stale = store.cards.find({ status: 'at_bo' }).filter((x) => x.bo_in && t - x.bo_in > boLimit(x.site_id) * 86400000);
    if (stale.length) push('mid', 'cards_stale', `${stale.length} thẻ nằm ở BO quá ${c.cardsStaleDays} ngày (${[...new Set(stale.map((x) => H.siteName(x.site_id)))].slice(0, 4).join(', ')}${stale.length > 4 ? '…' : ''})`, 'cards:at_bo', 'logistics');
    const waiting = store.cards.find({ status: 'at_tech' }).filter((x) => t - x.since > c.uploadLateH * 3600000).length;
    if (waiting) push('mid', 'upload_late', `${waiting} thẻ Tech đã nhận quá ${c.uploadLateH} giờ chưa nhập dung lượng`, 'cards:at_tech', 'tech');
    const ret = store.cards.find({ status: 'returned' }).filter((x) => t - x.since > c.cardsReturnedH * 3600000).length;
    if (ret) push('low', 'cards_returned', `${ret} thẻ đã thu về VP hơn ${c.cardsReturnedH} giờ chưa lập phiếu gửi Tech`, 'cards:returned', 'logistics');
    const upl = store.cards.find({ status: 'uploaded' }).filter((x) => t - x.since > c.cardsUploadedHours * 3600000).length;
    if (upl) push('mid', 'cards_uploaded', `${upl} thẻ đã nhập dung lượng hơn ${c.cardsUploadedHours} giờ chưa trả Logistics`, 'cards:uploaded', 'tech');
    const office = H.cards.officeFree();
    if (c.officeCardsMin && office < c.officeCardsMin) push('mid', 'cards_low', `Chỉ còn ${office} thẻ sẵn sàng tại VP (ngưỡng ${c.officeCardsMin}). Nhắc Tech trả thẻ đã nhập hoặc bổ sung thẻ.`, 'cards:office', 'logistics');
    const order = { high: 0, mid: 1, low: 2 };
    let list = out.sort((a, b) => order[a.level] - order[b.level]);
    // Mỗi Lead thấy việc của team mình, cộng vài mục liên team cần biết (kit lỗi tại BO, sự cố chưa ai nhận). Quota là số thương mại của Sale.
    if (user.role === 'tech_lead') list = list.filter((x) => x.team === 'tech' || x.kind === 'kit_fault');
    if (user.role === 'lead') list = list.filter((x) => x.team === 'logistics' || ['kit_fault', 'incident_unacked', 'outlet_data'].includes(x.kind));
    if (user.role === 'sale_head') list = list.filter((x) => ['kit_fault', 'incident_unacked', 'incident_old', 'request_late', 'outlet_data', 'quota_over', 'quota_near'].includes(x.kind));
    return list.slice(0, 60);
  }

  // ───────────────────────── Tổng quan toàn khối (Lead, Head of Sale, Quản trị) ─────────────────────────
  R('GET', '/api/hub/overview', G.OVERVIEW, ({ user, q }) => H.outlets.memoRead(() => {
    const period = q.period === 'month' ? 'month' : 'week';
    const P = periodOf(period, q.key, today());
    // So sánh WoW / MoM qua H.compare: kỳ đang chạy so cùng kỳ; giờ quay so trên các ngày thẻ đã nhập đủ (cmp), số hiển thị vẫn là tổng tới hôm nay (cur).
    const C = H.compare(P);
    const tr = tsRange(P, off), trp = C.ts.prev;
    // Xu hướng 12 tuần đọc trước: kỳ đang xem và phần so sánh nằm trong 12 tuần đó nên dùng lại cùng lượt đọc (H.outlets.memoRead).
    const endKey = period === 'week' ? P.key : weekKey(P.to < today() ? P.to : today());
    const wk12 = [];
    for (let i = 11; i >= 0; i--) wk12.push(shiftWeek(endKey, -i));
    const trendF = footageSeries(wk12.map(weekRange));
    const f = footage(P.from, P.to);
    const fc = C.data ? footage(C.data.cur.from, C.data.cur.to) : null, fp = C.data ? footage(C.data.prev.from, C.data.prev.to) : null;
    const fk = (k, withPct) => ({ cur: f[k], cmp: fc ? fc[k] : null, prev: fp ? fp[k] : null, ...(withPct ? { delta_pct: fc ? pct(fc[k], fp[k]) : null } : {}) });
    const inc = H.incidents.stats(period, P.key);
    const kits = store.kits.find({ status: { ne: 'retired' } });
    const kitSt = countBy(kits, 'status');
    const reqs = store.requests.find({ status: ['submitted', 'preparing', 'ready', 'delivering'] });
    // Ô Đối chiếu đếm như danh sách người xem mở ra: Lead / Head of Sale chỉ phần của team mình, Quản trị mọi team.
    const rw = reconTeam(user) ? { team: reconTeam(user) } : {};
    const out = {
      period, key: P.key, label: period === 'month' ? monthLabel(P.key) : weekLabel(P.key), prev_label: period === 'month' ? monthLabel(P.prev) : weekLabel(P.prev), from: P.from, to: P.to, cmp: C.info,
      kpi: {
        bo_live: store.sites.count({ active: 1, type: 'bo', ops_status: 'live' }), bo_planned: store.sites.find({ active: 1, type: 'bo' }, { cols: ['ops_status'] }).filter((s) => (s.ops_status || 'planned') === 'planned').length, bo_ending: store.sites.count({ active: 1, type: 'bo', ops_status: 'ending' }),
        hours: fk('hours', true), cards: fk('cards', true), zero: fk('zero'), under1h: fk('under1h'), tb: fk('tb'), hours_nosite: f.nosite, hours_offbo: f.offbo,
        incidents: { cur: inc.total, prev: inc.prev_total, delta_pct: pct(inc.total, inc.prev_total), open: inc.open, avg_ack_min: inc.avg_ack_min, avg_resolve_min: inc.avg_resolve_min, invalid: inc.invalid },
        sla: { tech: { cur: slaTeam('tech', tr.t0, tr.t1), prev: slaTeam('tech', trp.t0, trp.t1) }, logistics: { cur: slaTeam('logistics', tr.t0, tr.t1), prev: slaTeam('logistics', trp.t0, trp.t1) } },
        queue: { tech: queue('tech'), logistics: queue('logistics') }, shift: { tech: onShiftCount('tech'), logistics: onShiftCount('logistics') },
        kits: { by_status: kitSt, deployed: (kitSt.at_bo || 0) + (kitSt.delivering || 0) + (kitSt.recovering || 0), ready: kitSt.ready || 0, at_tech: kitSt.at_tech || 0, total: kits.length,
          by_kind: Object.fromEntries(['multicam', 'iphone', 'custom'].map((k) => [k, { total: kits.filter((x) => x.kind === k).length, deployed: kits.filter((x) => x.kind === k && ['at_bo', 'delivering', 'recovering'].includes(x.status)).length }])) },
        // Số thẻ theo trạng thái để riêng (card_st): khoá "cards" ở trên là số thẻ đã nhập dung lượng trong kỳ, không được ghi đè.
        requests: countBy(reqs, 'status'), card_st: countBy(store.cards.find({}, { cols: ['status'] }), 'status'),
        recon: { open: store.recon.count({ status: 'open', ...rw }), high: store.recon.count({ status: 'open', level: 'high', ...rw }) },
      },
      incidents_top: inc.top, incidents_spikes: inc.all.filter((x) => x.spike), incident_sites: inc.sites, office_faults: inc.office_faults,
      watch: watchList(user),
    };
    // Xu hướng 12 tuần: giờ ghi hình, thẻ, sự cố, điểm khối lượng và đúng hạn của hai team (số cấp team, không có tên người).
    const techT = H.people.trend('tech', 12, endKey), logT = H.people.trend('logistics', 12, endKey);
    const incT = H.incidents.weekly(12, endKey);
    out.trend = techT.map((w, i) => { const j = wk12.indexOf(w.key), ff = j >= 0 ? trendF[j] : footage(weekRange(w.key).from, weekRange(w.key).to); return { key: w.key, label: w.label, hours: ff.hours, cards: ff.cards, zero: ff.zero, incidents: incT[i].count, tech_points: w.points, tech_sla: w.sla_pct, log_points: logT[i].points, log_sla: logT[i].sla_pct }; });
    // Top 3 và bảng cá nhân chỉ dành cho Lead của team đó (Quản trị xem cả hai).
    out.top3 = {};
    for (const team of ['tech', 'logistics']) if (H.leadOf(user, team)) { const p = H.people.perfPayload(team, period, P.key); out.top3[team] = { label: p.label, list: p.top3, fo: p.fo ? { list: p.fo.top3, summary: p.fo.summary, rate_off: !!p.fo.rate_off } : null, rate_off: !!p.rate_off, summary: { points: p.summary.points, wow_pct: p.summary.wow_pct, sla_pct: p.summary.sla_pct, ppd: p.summary.ppd, by_type: p.summary.by_type.slice(0, 8), fo_points: p.summary.fo_points, other_points: p.summary.other_points } }; }
    if (user.role === 'admin' || user.role === 'sale_head') out.sale = saleBlock(null, period, P);
    return out;
  }));

  // ───────────────────────── Sale ─────────────────────────
  function saleBlock(saleId, period, P) {
    const C = H.compare(P);
    let sites = store.sites.find({ active: 1, type: 'bo' }, { order: 'name' });
    if (saleId) sites = sites.filter((s) => s.sale_id === saleId);
    const ids = sites.map((s) => s.id);
    const cur = H.outlets.hoursBySite(ids, P.from, P.to);
    const cc = C.data ? H.outlets.hoursBySite(ids, C.data.cur.from, C.data.cur.to) : null, prev = C.data ? H.outlets.hoursBySite(ids, C.data.prev.from, C.data.prev.to) : null;
    const kitsAt = countBy(store.kits.find({ status: 'at_bo' }), 'site_id');
    const incOpen = countBy(store.incidents.find({ status: ['open', 'ack'] }), 'site_id');
    const tr = tsRange(P, off);
    const incPeriod = countBy(store.incidents.find({ created_at: { gte: tr.t0, lt: tr.t1 }, status: { ne: 'cancelled' } }), 'site_id');
    const raw = new Map(); // số thô của từng BO: tổng và theo Sale Lead cộng số thô rồi mới làm tròn
    const rows = sites.map((s) => {
      const c = cur.get(s.id) || { total: 0, cards: 0, zero: 0 }, cm = cc ? (cc.get(s.id) || { total: 0 }).total : null, p = prev ? (prev.get(s.id) || { total: 0 }).total : null;
      raw.set(s.id, { hours: c.total, cmp_hours: cm || 0, prev_hours: p || 0 });
      return { id: s.id, name: s.name, code: s.code || '', sale: s.sale_id ? { id: s.sale_id, name: H.userName(s.sale_id) } : null, ops_status: s.ops_status || 'planned', status_label: OUTLET_ST[s.ops_status || 'planned'], hours: r1(c.total), cmp_hours: r1(cm), prev_hours: r1(p), delta_pct: cm === null ? null : pct(cm, p), cards: c.cards, zero: c.zero, kits: kitsAt[s.id] || 0, incidents: incPeriod[s.id] || 0, open_incidents: incOpen[s.id] || 0, launch_date: s.launch_date };
    });
    const live = rows.filter((r) => r.ops_status === 'live' || r.hours);
    const bySale = new Map();
    for (const r of rows) {
      const k = r.sale ? r.sale.id : 0;
      if (!bySale.has(k)) bySale.set(k, { sale: r.sale || { id: null, name: 'Chưa giao Sale' }, bo: 0, live: 0, hours: 0, cmp_hours: 0, prev_hours: 0, zero: 0, incidents: 0, kits: 0 });
      const x = bySale.get(k), w = raw.get(r.id); x.bo++; if (r.ops_status === 'live') x.live++; x.hours += w.hours; x.cmp_hours += w.cmp_hours; x.prev_hours += w.prev_hours; x.zero += r.zero; x.incidents += r.incidents; x.kits += r.kits;
    }
    const totals = rows.reduce((a, r) => { const w = raw.get(r.id); return { hours: a.hours + w.hours, cmp_hours: a.cmp_hours + w.cmp_hours, prev_hours: a.prev_hours + w.prev_hours, cards: a.cards + r.cards, zero: a.zero + r.zero, incidents: a.incidents + r.incidents }; }, { hours: 0, cmp_hours: 0, prev_hours: 0, cards: 0, zero: 0, incidents: 0 });
    const cmpOf = (x) => (C.data ? { cmp_hours: r1(x.cmp_hours), prev_hours: r1(x.prev_hours), delta_pct: pct(r1(x.cmp_hours), r1(x.prev_hours)) } : { cmp_hours: null, prev_hours: null, delta_pct: null }); // % tính trên số hiển thị, như Tổng quan
    return {
      totals: { ...totals, hours: r1(totals.hours), ...cmpOf(totals), live: rows.filter((r) => r.ops_status === 'live').length, bo: rows.length, kits: rows.reduce((a, r) => a + r.kits, 0) },
      outlets: rows, top: [...live].sort((a, b) => b.hours - a.hours).slice(0, 5), bottom: live.filter((r) => r.ops_status === 'live').sort((a, b) => a.hours - b.hours || b.zero - a.zero).slice(0, 5),
      by_sale: [...bySale.values()].map((x) => ({ ...x, hours: r1(x.hours), ...cmpOf(x) })).sort((a, b) => b.hours - a.hours),
    };
  }
  // ───────────────────────── Head of Sale: onboard, chờ active, quota giờ quay, chuẩn giờ quay mỗi kit mỗi ngày ─────────────────────────
  const OPEN_LAUNCH = ['submitted', 'preparing', 'ready', 'delivering'];
  /** Số ngày được xét chuẩn giờ quay của BO trong [from, to]: trong đợt ghi hình, không tạm nghỉ, có kit, thẻ của ngày đã nhập đủ (H.outlets.rateDays). */
  function activeDays(s, from, to) { const m = H.outlets.rateDays([s], from, to).get(s.id); return m ? m.size : 0; }
  /** Mốc phân bố giờ / kit / ngày theo chuẩn (0,4 · 0,6 · 0,8 · 1 lần chuẩn): không chồng nhau, mốc cuối là chuẩn (làm tròn lên 0,1 như số hiển thị). */
  function distEdges(std) {
    const top = Math.ceil(std * 10 - 1e-9) / 10;
    return [...new Set([0, ...[0.4, 0.6, 0.8].map((f) => r1(f * std)).filter((x) => x > 0 && x < top), top])];
  }
  const vn = (x) => String(x).replace('.', ',');
  /**
   * Bảng của Head of Sale (Sale Lead xem phần BO của mình). Giờ quay là giờ thô Tech nhập từ thẻ (card_records), không nhập tay ở Sale.
   * Chuẩn giờ quay xét riêng từng BO trên những ngày đã nhập đủ thẻ, với số kit thật ở BO ngày đó; ngày chưa đủ dữ liệu không tính 0 giờ.
   * Onboard = BO đã ký (yêu cầu launch đầu tiên không huỷ), ghi cho Sale Lead đã ký; active = lần đầu có máy.
   */
  function hosBlock(saleId, period, P, opt = {}) {
    const c = H.cfg(), d0 = today(), O = H.outlets, std = c.dailyStdHours, warn = c.quotaWarnPct;
    const C = H.compare(P), dayPrev = C.day.prev; // onboard trong kỳ so với cùng số ngày của kỳ trước
    const allSites = store.sites.find({ active: 1, type: 'bo' }, { order: 'name' });
    const sites = saleId ? allSites.filter((s) => s.sale_id === saleId) : allSites;
    const ids = sites.length ? sites.map((s) => s.id) : [-1];
    const openReq = new Map();
    for (const r of store.requests.find({ kind: 'launch', status: OPEN_LAUNCH })) openReq.set(r.site_id, r);
    const bucket = (s) => { const st = s.ops_status || 'planned'; return st === 'planned' ? (openReq.has(s.id) ? 'waiting' : 'prospect') : st; };
    const inR = (v, r) => !!v && v >= r.from && v <= r.to;
    const status = { prospect: 0, waiting: 0, live: 0, paused: 0, ending: 0, ended: 0 };
    for (const s of sites) status[bucket(s)]++;

    // Giờ quay: kỳ đang xem, phần so sánh (H.compare), quota từ lần launch gần nhất.
    const curH = O.hoursBySite(ids, P.from, P.to);
    const cmpH = C.data ? O.hoursBySite(ids, C.data.cur.from, C.data.cur.to) : null, prevH = C.data ? O.hoursBySite(ids, C.data.prev.from, C.data.prev.to) : null;
    const used = opt.used || O.usedHours(ids); // màn hình BO đã tính trong cùng lượt gọi thì dùng lại
    // Chuẩn giờ quay: ngày được xét của kỳ này, kỳ trước và 14 ngày gần nhất (nhịp quay để dự báo ngày chạm quota).
    const ev = { from: P.from, to: P.to < d0 ? P.to : d0 }, evp = rangeOf(P.period, P.prev), paceW = { from: addDays(d0, -14), to: addDays(d0, -1) };
    const days = O.rateDays(sites, evp.from < paceW.from ? evp.from : paceW.from, ev.to > paceW.to ? ev.to : paceW.to);
    const sumIn = (s, w) => { let h = 0, k = 0, n = 0; for (const [d, x] of days.get(s.id) || []) if (d >= w.from && d <= w.to) { h += x.hours; k += x.kits; n++; } return { hours: h, kits: k, days: n, v: k ? h / k : null }; };
    const kitsAt = countBy(store.kits.find({ status: 'at_bo' }), 'site_id');
    const raw = new Map(); // số thô của từng BO: tổng, theo Sale Lead, giờ/kit/ngày cả team cộng số thô rồi mới làm tròn
    const rows = sites.map((s) => {
      const b = bucket(s), u = used.get(s.id) || 0, q = s.quota_hours || null;
      const qs = q && O.QUOTA_ST.includes(b) ? O.quotaStatus(u, q, warn) : null;
      const pc = sumIn(s, paceW), daily = pc.days ? pc.hours / pc.days : 0;
      const k = sumIn(s, ev), kp = sumIn(s, evp);
      const v = k.v === null ? null : r1(k.v), vp = kp.v === null ? null : r1(kp.v); // một giá trị cho số hiển thị, cờ dưới chuẩn và phân bố
      const cur = curH.get(s.id) || { total: 0, cards: 0, zero: 0 }, cm = cmpH ? (cmpH.get(s.id) || { total: 0 }).total : null, pv = prevH ? (prevH.get(s.id) || { total: 0 }).total : null;
      raw.set(s.id, { hours: cur.total, cmp_hours: cm || 0, prev_hours: pv || 0, kh: k.hours, kd: k.kits, kph: kp.hours, kpd: kp.kits });
      const req = openReq.get(s.id), by = O.signerOf(s);
      return {
        id: s.id, name: s.name, code: s.code || '', area: s.area || '', business: s.business || '', sale: s.sale_id ? { id: s.sale_id, name: H.userName(s.sale_id) } : null,
        bucket: b, status_label: OUTLET_ST[s.ops_status || 'planned'], onboard_date: O.onboardOf(s), onboard_by: by ? { id: by, name: H.userName(by) } : null, active_date: O.activeOf(s), launch_date: s.launch_date, end_date: s.end_date,
        request: req ? { id: req.id, code: req.code, status: req.status, status_label: REQ_ST[req.status], launch_date: req.launch_date, waiting: b === 'waiting' ? O.waitingOf(req) : null } : null,
        quota_hours: q, quota_from: O.quotaFrom(s), used_hours: r1(u), quota_pct: q ? Math.floor((u / q) * 1000) / 10 : null, quota_status: qs,
        quota_eta: qs && daily > 0 && u < q ? addDays(d0, Math.ceil((q - u) / daily)) : null, pace_daily: r1(daily),
        hours: r1(cur.total), cmp_hours: r1(cm), prev_hours: r1(pv), delta_pct: cm === null ? null : pct(cm, pv), cards: cur.cards, zero: cur.zero,
        kits: kitsAt[s.id] || 0, eval_days: k.days, eval_kits: k.days ? r1(k.kits / k.days) : 0, per_kit_day: v, prev_per_kit_day: vp,
        below_std: v !== null && v < std,
      };
    });
    const rated = rows.filter((r) => r.per_kit_day !== null);
    const teamPkd = (h, kd) => { let a = 0, b = 0; for (const w of raw.values()) { a += w[h]; b += w[kd]; } return b ? r1(a / b) : null; }; // tổng giờ / tổng kit-ngày của các ngày được xét
    // Onboard ghi cho Sale Lead đã ký, theo ngày ký (không đổi khi BO giao cho người khác). Sale Lead xem phần của mình: BO mình đã ký.
    const signed = (saleId ? allSites.filter((s) => O.signerOf(s) === saleId) : allSites).filter((s) => O.onboardOf(s));
    const endMonth = P.to.slice(0, 7);
    const months = [];
    for (let i = 11; i >= 0; i--) months.push(shiftMonth(endMonth, -i));
    const monthF = opt.lite ? null : footageSeries(months.map(monthRange), ids); // màn hình BO chỉ cần số từng BO, không cần biểu đồ 12 tháng
    const onboardByMonth = months.map((m, i) => {
      const list = signed.filter((s) => O.onboardOf(s).slice(0, 7) === m);
      return { key: m, label: monthLabel(m), onboard: list.length, by_sale: countBy(list.map((s) => ({ k: O.signerOf(s) || 0 })), 'k'), hours: monthF ? monthF[i].hours : null };
    });
    const thisMonth = P.period === 'month' ? P.key : (P.to < d0 ? P.to : d0).slice(0, 7), lastMonth = shiftMonth(thisMonth, -1);
    const monthCount = (m) => signed.filter((s) => O.onboardOf(s).slice(0, 7) === m).length;
    // Thời gian từ lúc Sale gửi yêu cầu tới lúc BO có máy, cho mỗi lần launch (kể cả launch lại) trong kỳ: đo dịch vụ của Logistics và Tech với Sale.
    const launched = [];
    for (const s of sites) for (const [a] of O.periodsOf(s)) {
      if (!inR(a, P)) continue;
      const r = store.requests.find({ site_id: s.id, kind: 'launch', status: { ne: 'cancelled' }, created_at: { lt: atTime(addDays(a, 1), '00:00', off) } }, { order: 'created_at', desc: true, limit: 1 })[0];
      if (!r) continue;
      const created = new Date(r.created_at + off * 60000).toISOString().slice(0, 10);
      launched.push({ lead: Math.round((Date.parse(a) - Date.parse(created)) / 86400000), on_time: !r.launch_date || a <= r.launch_date });
    }
    // Theo Sale Lead: BO đang phụ trách; onboard theo người ký (có cả Sale Lead không còn BO nào).
    const bySale = new Map();
    const slot = (id) => {
      const k = id || 0;
      if (!bySale.has(k)) bySale.set(k, { sale: id ? { id, name: H.userName(id) } : { id: null, name: 'Chưa giao Sale' }, bo: 0, live: 0, active: 0, waiting: 0, prospect: 0, onboard_cur: 0, onboard_prev: 0, onboard_total: 0, hours: 0, cmp_hours: 0, prev_hours: 0, near_quota: 0, over_quota: 0, below_std: 0, rated: 0, zero: 0, kh: 0, kd: 0 });
      return bySale.get(k);
    };
    for (const r of rows) {
      const x = slot(r.sale ? r.sale.id : 0), w = raw.get(r.id);
      x.bo++; if (r.bucket === 'live') x.live++; if (r.bucket === 'live' || r.bucket === 'paused') x.active++; if (r.bucket === 'waiting') x.waiting++; if (r.bucket === 'prospect') x.prospect++;
      x.hours += w.hours; x.cmp_hours += w.cmp_hours; x.prev_hours += w.prev_hours; x.zero += r.zero;
      if (r.quota_status === 'near') x.near_quota++; if (r.quota_status === 'over') x.over_quota++;
      if (r.per_kit_day !== null) { x.rated++; if (r.below_std) x.below_std++; x.kh += w.kh; x.kd += w.kd; }
    }
    for (const s of signed) { const x = slot(O.signerOf(s)), ob = O.onboardOf(s); if (inR(ob, P)) x.onboard_cur++; if (inR(ob, dayPrev)) x.onboard_prev++; x.onboard_total++; }
    // Phân bố: mốc theo chuẩn, cùng giá trị đã làm tròn với cờ dưới chuẩn nên tổng các cột = số BO được xét, cột dưới chuẩn = số BO dưới chuẩn.
    const edges = distEdges(std), top = edges[edges.length - 1];
    const dist = edges.map((a, i) => {
      const b = i + 1 < edges.length ? edges[i + 1] : Infinity;
      return { label: !i ? `<${vn(b)} giờ` : b === Infinity ? `≥${vn(a)} giờ` : `${vn(a)}–${vn(b)} giờ`, from: a, to: b === Infinity ? null : b, count: rated.filter((r) => r.per_kit_day >= a && r.per_kit_day < b).length, ok: a >= top };
    });
    const sumK = (k) => rows.reduce((a, r) => a + raw.get(r.id)[k], 0);
    const totals = { hours: r1(sumK('hours')), cmp_hours: C.data ? r1(sumK('cmp_hours')) : null, prev_hours: C.data ? r1(sumK('prev_hours')) : null };
    const pkd = teamPkd('kh', 'kd'), pkdPrev = teamPkd('kph', 'kpd');
    const quotaRows = rows.filter((r) => r.quota_status);
    return {
      eval: { from: ev.from, to: ev.to, prev_from: evp.from, prev_to: evp.to, std_hours: std, quota_warn_pct: warn },
      kpi: {
        bo_total: sites.length, ...status, onboarded: sites.filter((s) => O.onboardOf(s)).length, active_now: status.live + status.paused,
        onboard: { cur: signed.filter((s) => inR(O.onboardOf(s), P)).length, prev: signed.filter((s) => inR(O.onboardOf(s), dayPrev)).length },
        onboard_month: { key: thisMonth, label: monthLabel(thisMonth), cur: monthCount(thisMonth), prev: monthCount(lastMonth), prev_label: monthLabel(lastMonth) },
        activated: { cur: sites.filter((s) => inR(O.activeOf(s), P)).length, prev: sites.filter((s) => inR(O.activeOf(s), dayPrev)).length, total: sites.filter((s) => O.activeOf(s)).length },
        hours: { cur: totals.hours, cmp: totals.cmp_hours, prev: totals.prev_hours, delta_pct: C.data ? pct(totals.cmp_hours, totals.prev_hours) : null },
        per_kit_day: { cur: pkd, prev: pkdPrev, delta_pct: pct(pkd, pkdPrev), std },
        quota: { with_quota: quotaRows.length, near: quotaRows.filter((r) => r.quota_status === 'near').length, over: quotaRows.filter((r) => r.quota_status === 'over').length, live_without_quota: rows.filter((r) => r.bucket === 'live' && !r.quota_hours).length },
        below_std: { count: rated.filter((r) => r.below_std).length, rated: rated.length, pct: rated.length ? r1((rated.filter((r) => r.below_std).length / rated.length) * 100) : null, prev: rows.filter((r) => r.prev_per_kit_day !== null && r.prev_per_kit_day < std).length },
        zero: { cur: rows.reduce((a, r) => a + r.zero, 0) },
        launches: { n: launched.length, on_time: launched.filter((x) => x.on_time).length, avg_lead_days: launched.length ? r1(launched.reduce((a, x) => a + x.lead, 0) / launched.length) : null },
      },
      by_sale: [...bySale.values()].map(({ kh, kd, ...x }) => ({ ...x, hours: r1(x.hours), cmp_hours: C.data ? r1(x.cmp_hours) : null, prev_hours: C.data ? r1(x.prev_hours) : null, delta_pct: C.data ? pct(r1(x.cmp_hours), r1(x.prev_hours)) : null, per_kit_day: kd ? r1(kh / kd) : null })).sort((a, b) => b.onboard_total - a.onboard_total || b.hours - a.hours),
      onboard_by_month: onboardByMonth,
      sale_names: Object.fromEntries([...bySale.values()].map((x) => [x.sale.id || 0, x.sale.name])),
      quota_list: quotaRows.sort((a, b) => b.quota_pct - a.quota_pct).slice(0, 30),
      below_list: rated.filter((r) => r.below_std).sort((a, b) => a.per_kit_day - b.per_kit_day).slice(0, 30),
      waiting_list: rows.filter((r) => r.bucket === 'waiting').sort((a, b) => String((a.request || {}).launch_date).localeCompare(String((b.request || {}).launch_date))),
      distribution: dist,
      outlets: rows,
    };
  }

  R('GET', '/api/hub/sale', [...G.SALE, 'admin'], ({ user, q }) => H.outlets.memoRead(() => {
    const period = q.period === 'month' ? 'month' : 'week';
    const P = periodOf(period, q.key, today());
    const own = user.role === 'sale' && H.outlets.saleScope(user) ? user.id : null;
    // Sale Lead được xem mọi BO (saleSeesAll): chỉ xem; số theo từng Sale Lead vẫn chỉ Head of Sale / Quản trị thấy.
    const viewOnly = user.role === 'sale' && !own;
    const block = saleBlock(own, period, P);
    const mine = own ? H.outlets.reqScope(user) : null; // yêu cầu theo Sale phụ trách hiện tại của BO
    const reqs = H.outlets.reqBriefs(store.requests.find({ status: ['submitted', 'preparing', 'ready', 'delivering', 'scheduled', 'ending'] }, { order: 'created_at', desc: true }).filter((r) => !mine || mine(r)));
    // Xu hướng giờ ghi hình 8 tuần cho BO trong phạm vi.
    const ids = block.outlets.map((o) => o.id);
    const endKey = period === 'week' ? P.key : weekKey(P.to < today() ? P.to : today());
    const weeks = [];
    for (let i = 11; i >= 0; i--) weeks.push(shiftWeek(endKey, -i));
    const wf = footageSeries(weeks.map(weekRange), ids.length ? ids : [-1]);
    const trend = weeks.map((k, i) => ({ key: k, label: weekLabel(k), hours: wf[i].hours, cards: wf[i].cards, zero: wf[i].zero }));
    const hos = hosBlock(own, period, P);
    if (viewOnly) {
      delete block.by_sale; delete hos.by_sale; delete hos.sale_names;
      hos.onboard_by_month = hos.onboard_by_month.map(({ by_sale, ...m }) => m);
    }
    // Quyền sửa quota: Head of Sale / Quản trị mọi BO; Sale Lead chỉ BO của mình ('own': giao diện so Sale phụ trách của từng dòng).
    return { period, key: P.key, label: period === 'month' ? monthLabel(P.key) : weekLabel(P.key), prev_label: period === 'month' ? monthLabel(P.prev) : weekLabel(P.prev), from: P.from, to: P.to, cmp: H.compare(P).info, scope: own ? 'mine' : viewOnly ? 'view' : 'all', ...block, requests: reqs, trend, hos, can_edit_quota: user.role === 'sale' ? 'own' : true };
  }));

  // ───────────────────────── Trang đầu của thành viên ─────────────────────────
  R('GET', '/api/hub/home', G.OPS_STAFF, ({ user }) => {
    const team = H.TEAM_OF[user.role] === 'admin' ? null : H.TEAM_OF[user.role];
    const out = { team, watch: watchList(user).filter((x) => !team || x.team === team).slice(0, 12) };
    if (team) {
      out.queue = queue(team);
      // Ai đang trong ca là số theo từng người: chỉ Lead của team thấy (giống bảng phân ca).
      if (H.leadOf(user, team)) out.on_shift = store.users.find({ role: team === 'tech' ? ['tech', 'tech_lead'] : ['logistic', 'lead'], active: 1 }).filter((u) => H.jobs.onShift(u)).map((u) => ({ id: u.id, name: u.name }));
    }
    if (team === 'tech') out.cards = { to_receive: store.handovers.count({ dir: 'to_tech', status: 'sent' }), at_tech: store.cards.count({ status: 'at_tech' }), uploaded: store.cards.count({ status: 'uploaded' }) };
    if (team === 'logistics') out.cards = { returned: store.cards.count({ status: 'returned' }), to_receive: store.handovers.count({ dir: 'to_log', status: 'sent' }), office: store.cards.count({ status: 'office' }) };
    return out;
  });

  // ───────────────────────── Đối chiếu ─────────────────────────
  const reconTeam = (u) => (u.role === 'admin' ? null : u.role === 'sale_head' ? 'sale' : H.TEAM_OF[u.role]);
  R('GET', '/api/hub/recon', [...G.OPS_STAFF, 'sale_head'], ({ user, q }) => {
    const team = reconTeam(user);
    const where = {};
    if (team) where.team = team; else if (['sale', 'logistics', 'tech'].includes(q.team)) where.team = q.team;
    where.status = q.status === 'all' ? undefined : q.status === 'done' ? ['resolved', 'ignored'] : 'open';
    if (where.status === undefined) delete where.status;
    const rows = store.recon.find(where, { order: 'ts', desc: true, limit: 500 });
    const counts = {};
    for (const r of store.recon.find({ status: 'open' })) counts[r.team] = (counts[r.team] || 0) + 1;
    return { items: rows.map((r) => ({ ...r, resolved_by: r.resolved_by ? H.userName(r.resolved_by) : '' })), counts, can_resolve: user.role === 'admin' || ['tech_lead', 'lead', 'sale_head'].includes(user.role) };
  });
  R('POST', '/api/hub/recon/:id/resolve', [...G.LEADS, 'sale_head'], ({ user, p, b }) => {
    const r = store.recon.get(K.idOf(p.id));
    if (!r) fail(404, 'not_found', 'Không tìm thấy dòng đối chiếu.');
    if (r.status !== 'open') fail(409, 'closed', 'Dòng này đã xử lý.');
    if (!H.leadOf(user, r.team)) fail(403, 'forbidden', 'Dòng này do Lead của team khác duyệt.');
    const note = H.reasonOf(b.note, 'cách đã xử lý');
    const status = b.status === 'ignored' ? 'ignored' : 'resolved';
    store.recon.update(r.id, { status, note, resolved_by: user.id, resolved_at: now() });
    log('recon', r.id, status, `${user.name} ${status === 'ignored' ? 'bỏ qua' : 'xử lý'} dòng đối chiếu: ${r.text} → ${note}`, user);
    changed('recon');
    return { ok: true };
  });

  // ───────────────────────── Hộp thư, nhật ký ─────────────────────────
  R('GET', '/api/hub/inbox', G.STAFF, ({ user, q }) => {
    const where = { user_id: user.id };
    if (q.unread === '1') where.read_at = null;
    return { items: store.inbox.find(where, { order: 'ts', desc: true, limit: int(q.limit, 1, 200) || 60 }), unread: store.inbox.count({ user_id: user.id, read_at: null }) };
  });
  R('POST', '/api/hub/inbox/read', G.STAFF, ({ user, b }) => {
    const t = now();
    if (b.all) { for (const m of store.inbox.find({ user_id: user.id, read_at: null })) store.inbox.update(m.id, { read_at: t }); }
    else for (const id of H.idList(b.ids || [], 500)) { const m = store.inbox.get(id); if (m && m.user_id === user.id && !m.read_at) store.inbox.update(id, { read_at: t }); }
    return { unread: store.inbox.count({ user_id: user.id, read_at: null }) };
  });
  R('GET', '/api/hub/log', [...G.LEADS, 'sale_head'], ({ user, q }) => {
    // Lead chỉ xem nhật ký của team mình: việc, chấm công, phân ca, hiệu suất, đối chiếu của team; kho, thẻ, BO, yêu cầu là dữ liệu chung.
    // Mã người chỉ kèm cho người trong team (và Quản trị): Lead không lọc, không đếm được việc theo từng người của team khác.
    const team = user.role === 'admin' ? null : H.TEAM_OF[user.role];
    const uCache = new Map();
    const userOf = (id) => { if (!id) return null; if (!uCache.has(id)) uCache.set(id, store.users.get(id) || null); return uCache.get(id); };
    const sameTeam = (id) => { const u = userOf(id); return !!u && (u.role === 'admin' || H.TEAM_OF[u.role] === team); };
    const where = {};
    if (q.entity) where.entity = cleanStr(q.entity, 20);
    if (q.id) where.entity_id = K.idOf(q.id);
    if (q.actor) { where.actor_id = K.idOf(q.actor); if (team && !sameTeam(where.actor_id)) fail(403, 'forbidden', 'Chỉ lọc được theo người trong team của bạn.'); }
    if (isDate(q.from)) where.ts = { gte: atTime(q.from, '00:00', off) };
    if (isDate(q.to)) where.ts = { ...(where.ts || {}), lt: atTime(addDays(q.to, 1), '00:00', off) }; // đến hết ngày q.to
    // Head of Sale chỉ xem nhật ký yêu cầu, BO, sự cố: lọc ngay lúc tìm để giới hạn số dòng không bị nhật ký khác chiếm chỗ.
    const SALE_LOG = ['request', 'outlet', 'incident'];
    if (user.role === 'sale_head') where.entity = where.entity ? (SALE_LOG.includes(where.entity) ? where.entity : '-') : SALE_LOG;
    const limit = int(q.limit, 1, 1000) || 300;
    let rows = store.hub_log.find(where, { order: 'ts', desc: true, limit: team === 'tech' || team === 'logistics' ? Math.min(limit * 6, 6000) : limit });
    if (user.role === 'sale_head') rows = rows.filter((l) => ['request', 'outlet', 'incident'].includes(l.entity));
    if (team === 'tech' || team === 'logistics') {
      const jCache = new Map(), rCache = new Map();
      const jobTeam = (id) => { if (!jCache.has(id)) jCache.set(id, (store.jobs.get(id) || {}).team); return jCache.get(id); };
      const reconOf = (id) => { if (!rCache.has(id)) rCache.set(id, (store.recon.get(id) || {}).team); return rCache.get(id); };
      const mine = (l) => {
        if (l.entity === 'job') return jobTeam(l.entity_id) === team;
        if (l.entity === 'attendance') return sameTeam(l.entity_id);
        if (l.entity === 'perf') return l.data && l.data.team ? l.data.team === team : !l.actor_id || sameTeam(l.actor_id); // chốt kỳ ghi team; nhật ký cũ: theo người chốt
        if (l.entity === 'roster') return !l.actor_id || sameTeam(l.actor_id);
        if (l.entity === 'recon') return reconOf(l.entity_id) === team;
        if (l.entity === 'card' && (l.action === 'upload' || l.action === 'record_edit')) return team === 'tech'; // nhập dung lượng: khối lượng của Tech
        return true;
      };
      rows = rows.filter(mine).slice(0, limit);
    }
    // FO giao kit / đổi máy qua chuyến cũng đóng yêu cầu, sự cố (người ghi là FO): Sale chỉ thấy vai "FO", không thấy tên.
    const actorOf = (id) => { const u = userOf(id); return !id ? 'Hệ thống' : u && u.role === 'fo' && H.isSale(user) ? H.ROLE_LABEL.fo : H.userName(id); };
    return { items: rows.map((l) => ({ ...l, actor_id: !team || !l.actor_id || sameTeam(l.actor_id) ? l.actor_id : null, actor: actorOf(l.actor_id) })) };
  });

  // ───────────────────────── Cài đặt ─────────────────────────
  /** Ai sửa được mục nào: Quản trị mọi mục; Tech Lead mục của Tech; Logistic Lead mục của Logistics; mục "Lead" thì cả hai Lead. */
  function canEdit(user, key) {
    if (user.role === 'admin') return true;
    const o = HUB_OWNER[key] || '';
    if (user.role === 'tech_lead') return o.includes('Tech') || o === 'Lead';
    if (user.role === 'lead') return o.includes('Logistics') || o === 'Lead';
    if (user.role === 'sale_head') return o.includes('Sale');
    return false;
  }
  const NUM = {
    gbPerHour: [1, 200], swapLeadDays: [0, 14], setupShowDays: [0, 14], stockCheckDay: [1, 7], cardsPerKit: [1, 10], poolAlertMin: [5, 1440], leadOverdueMin: [10, 2880], leadPileJobs: [1, 50],
    leadPileMin: [10, 1440], earlyCheckinMin: [0, 120], lateAfterMin: [0, 120], absentAfterMin: [15, 600], releaseGraceMin: [0, 240], minDaysWeek: [0, 7], minDaysMonth: [0, 31], spikeMin: [1, 50],
    dailyStdHours: [0.5, 24], quotaWarnPct: [50, 99], evalLagDays: [0, 7], foStopStd: [0, 120], prepMinHours: [1, 24], replayMin: [1, 60],
    incidentAckMin: [5, 1440], incidentOldH: [1, 720], incidentCancelMin: [0, 1440], uploadLateH: [1, 240], reqLateDays: [0, 30], cardsStaleDays: [1, 30], cardsReturnedH: [1, 240],
    officeCardsMin: [0, 1000], cardsUploadedHours: [1, 336], shootWindowDays: [7, 365], recordEditHours: [1, 720],
  };
  const BOOL = ['checkBeforeShip', 'uploadPhotoRequired', 'autoAssign', 'zeroHourAlert', 'rosterSelfApprove', 'rateLogistics', 'saleSeesAll'];
  const TEAM_NAME = { tech: 'Tech', logistics: 'Logistics' };
  /** Phần nào của mục riêng theo team người gọi được sửa: Lead phần team mình, Quản trị cả hai. */
  const myTeams = (user) => (user.role === 'admin' ? ['tech', 'logistics'] : user.role === 'tech_lead' ? ['tech'] : user.role === 'lead' ? ['logistics'] : []);
  /**
   * Mục riêng theo team: nhận { tech: …, logistics: … } (một hoặc cả hai phần) hoặc một giá trị chung — Lead áp cho team mình,
   * Quản trị áp cho cả hai. Phần của team kia giữ giá trị đang dùng. Lưu lại đủ hai phần.
   */
  function validateTeam(key, v, user) {
    const mine = myTeams(user);
    const parts = H.isTeamVal(v) ? v : Object.fromEntries(mine.map((t) => [t, v]));
    const out = { tech: H.tcfg(key, 'tech'), logistics: H.tcfg(key, 'logistics') };
    for (const [t, x] of Object.entries(parts)) {
      if (!mine.includes(t)) fail(403, 'forbidden', `Mục "${HUB_LABEL[key]}" của ${TEAM_NAME[t]} do Lead của ${TEAM_NAME[t]} chốt.`);
      out[t] = validate(key, x, user);
    }
    return out;
  }
  function validate(key, v, user) {
    if (NUM[key]) { const n = num(v); if (n === null || n < NUM[key][0] || n > NUM[key][1]) fail(400, 'bad_value', `${HUB_LABEL[key]}: từ ${NUM[key][0]} đến ${NUM[key][1]}.`); return key === 'gbPerHour' || key === 'dailyStdHours' ? +n.toFixed(2) : Math.round(n); }
    if (BOOL.includes(key)) return !!v;
    if (key === 'shifts') {
      if (!Array.isArray(v) || !v.length || v.length > 10) fail(400, 'bad_value', 'Ca mẫu: từ 1 đến 10 ca.');
      return v.map((s) => {
        const id = cleanStr(s && s.id, 6).toUpperCase(), name = cleanStr(s && s.name, 30);
        if (!/^[A-Z0-9]{1,6}$/.test(id) || !name || !isHM(s.start) || !isHM(s.end) || s.end <= s.start) fail(400, 'bad_value', 'Mỗi ca cần mã (chữ, số), tên, giờ vào và giờ ra (ra sau vào).');
        return { id, name, start: s.start, end: s.end };
      });
    }
    if (key === 'scoreWeights') {
      const o = {};
      for (const k of ['vol', 'sla', 'quality', 'att']) { o[k] = int(v && v[k], 0, 100); if (o[k] === null) fail(400, 'bad_value', 'Trọng số là số nguyên từ 0 đến 100.'); }
      if (!Object.values(o).some((x) => x > 0)) fail(400, 'bad_value', 'Cần ít nhất một trọng số lớn hơn 0.');
      return o;
    }
    if (key === 'scoreBands') {
      if (!Array.isArray(v) || v.length !== 4) fail(400, 'bad_value', 'Cần 4 ngưỡng cho mức 5, 4, 3, 2.');
      const b = v.map((x) => num(x));
      if (b.some((x) => x === null || x < 0 || x > 100) || b.some((x, i) => i && x >= b[i - 1])) fail(400, 'bad_value', 'Ngưỡng giảm dần, trong khoảng 0–100.');
      return b;
    }
    if (key === 'jobStd' || key === 'jobSla') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) fail(400, 'bad_value', 'Dữ liệu định mức không hợp lệ.');
      // Chủ của từng dòng: team của loại việc; việc dùng chung hai team (việc giao tay) theo hậu tố team ('manual_tech', 'manual_logistics')
      // để mỗi Lead chốt phần team mình; dòng chung không team ('manual') chỉ Quản trị. Lead gửi dòng không thuộc mình mà đổi giá trị → 403.
      const teamOf = (t) => {
        if (t.startsWith('incident_')) return INCIDENT_RES[t.slice(9)] ? JOB_TYPES.incident.team : undefined;
        if (JOB_TYPES[t]) return JOB_TYPES[t].team;
        const m = /^(.+)_(tech|logistics)$/.exec(t);
        return m && JOB_TYPES[m[1]] && JOB_TYPES[m[1]].team === null ? m[2] : undefined;
      };
      const owns = (team) => user.role === 'admin' || (user.role === 'tech_lead' && team === 'tech') || (user.role === 'lead' && team === 'logistics');
      const cur = H.cfg()[key] || {};
      const o = {};
      for (const [t, x] of Object.entries(v)) {
        const team = teamOf(t);
        if (team === undefined) fail(400, 'bad_value', `Loại việc "${cleanStr(t, 30)}" không có.`);
        const n = x === null || x === '' ? null : num(x);
        if (x !== null && x !== '' && (n === null || n < 0 || n > (key === 'jobStd' ? 600 : 43200))) fail(400, 'bad_value', key === 'jobStd' ? 'Phút chuẩn từ 0 đến 600.' : 'Hạn từ 5 phút đến 30 ngày.');
        if (!owns(team)) {
          if ((n ?? null) !== (cur[t] ?? null)) fail(403, 'forbidden', `Định mức "${(JOB_TYPES[t] || JOB_TYPES[t.replace(/_(tech|logistics)$/, '')] || JOB_TYPES.incident).label}"${team ? ` của ${TEAM_NAME[team]} do Lead của ${TEAM_NAME[team]} chốt` : ' dùng chung hai team do Quản trị chốt'}.`);
          continue;
        }
        if (n === null) { o[t] = null; continue; }
        if (key === 'jobSla' && n < 5) fail(400, 'bad_value', 'Hạn tối thiểu 5 phút.');
        o[t] = n;
      }
      // Chỉ đổi các dòng được gửi (để trống / null = về mặc định); dòng không gửi giữ nguyên, kể cả dòng khác của chính team mình.
      const out = { ...cur };
      for (const [t, n] of Object.entries(o)) { if (n === null) delete out[t]; else out[t] = n; }
      return out;
    }
    if (key === 'labels') {
      if (v === null) return null;
      const o = {};
      for (const kind of ['multicam', 'iphone']) {
        const list = Array.isArray(v[kind]) ? [...new Set(v[kind].map((x) => cleanStr(x, 60)).filter(Boolean))] : [];
        if (!list.length || list.length > 60) fail(400, 'bad_value', 'Mỗi dòng máy cần từ 1 đến 60 nhãn.');
        o[kind] = list.includes('Khác') ? list : [...list, 'Khác'];
      }
      return o;
    }
    fail(400, 'bad_key', `Không có mục cấu hình "${cleanStr(key, 30)}".`);
  }
  R('GET', '/api/hub/config', [...G.LEADS, 'sale_head', 'tech', 'logistic'], ({ user }) => ({
    values: H.cfgView(), defaults: HUB_DEFAULTS, owners: HUB_OWNER, labels: HUB_LABEL, editable: Object.keys(HUB_OWNER).filter((k) => canEdit(user, k)),
    team_keys: TEAM_CFG, my_teams: myTeams(user), // mục riêng theo team và phần người xem được sửa
    job_types: Object.entries(JOB_TYPES).map(([id, d]) => ({ id, label: d.label, team: d.team, std: d.std, per: d.per, sla: d.sla })), incident_res: INCIDENT_RES, default_labels: DEFAULT_LABELS,
  }));
  R('PUT', '/api/hub/config', [...G.LEADS, 'sale_head'], ({ user, b }) => {
    const patch = {}, notes = [];
    const cur = H.cfgView();
    for (const [k, v] of Object.entries(b && typeof b === 'object' ? b : {})) {
      if (!(k in HUB_DEFAULTS)) fail(400, 'bad_key', `Không có mục cấu hình "${cleanStr(k, 30)}".`);
      if (!canEdit(user, k)) fail(403, 'forbidden', `Mục "${HUB_LABEL[k]}" do ${HUB_OWNER[k]} chốt.`);
      if (TEAM_CFG.includes(k)) {
        patch[k] = validateTeam(k, v, user);
        for (const t of ['tech', 'logistics']) if (JSON.stringify(patch[k][t]) !== JSON.stringify(cur[k][t])) notes.push(`${HUB_LABEL[k]} · ${TEAM_NAME[t]}: ${JSON.stringify(cur[k][t])} → ${JSON.stringify(patch[k][t])}`);
        continue;
      }
      patch[k] = validate(k, v, user);
      if (JSON.stringify(patch[k]) !== JSON.stringify(cur[k])) notes.push(`${HUB_LABEL[k]}: ${JSON.stringify(cur[k])} → ${JSON.stringify(patch[k])}`);
    }
    if (!notes.length) return { values: cur };
    H.setCfg(patch);
    log('config', null, 'update', `${user.name} đổi cài đặt: ${notes.join('; ')}.`, user, patch);
    changed('config');
    return { values: H.cfgView() };
  });

  // ───────────────────────── Xuất CSV ─────────────────────────
  const csv = (name, head, rows) => ({ __csv: { name, text: '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n' } });
  const fmt = (ts) => (ts ? new Date(ts + off * 60000).toISOString().slice(0, 16).replace('T', ' ') : '');
  function rangeQ(q) { const to = isDate(q.to) ? q.to : today(), from = isDate(q.from) ? q.from : addDays(to, -30); if (addDays(from, 370) < to) fail(400, 'bad_range', 'Tối đa 1 năm mỗi lần.'); return { from, to, ...tsRange({ from, to }, off) }; }
  R('GET', '/api/hub/export/jobs.csv', G.LEADS, ({ user, q }) => {
    const r = rangeQ(q);
    const team = user.role === 'admin' ? null : H.TEAM_OF[user.role];
    const rows = store.jobs.find({ ...(team ? { team } : {}), created_at: { gte: r.t0, lt: r.t1 } }, { order: 'created_at' });
    return csv(`viec_${r.from}_${r.to}.csv`, ['Mã', 'Loại', 'Team', 'Tên việc', 'BO', 'Kit', 'Trạng thái', 'Người giữ', 'Người làm', 'Tạo lúc', 'Hạn', 'Xong lúc', 'Đúng hạn', 'Phút chuẩn', 'Điểm', 'Gấp', 'Ghi chú'],
      rows.map((j) => [j.code, (JOB_TYPES[j.type] || {}).label || j.type, j.team, j.title, H.siteName(j.site_id), j.kit_id ? (store.kits.get(j.kit_id) || {}).code : '', j.status, H.userName(j.assignee_id), H.userName(j.done_by), fmt(j.created_at), fmt(j.due_at), fmt(j.done_at), j.status === 'done' && j.due_at ? (j.done_at <= j.due_at ? 'Có' : 'Không') : '', j.std_min ?? '', j.std_min ? r1(j.std_min / 6) : '', j.priority ? 'Có' : '', j.note || '']));
  });
  R('GET', '/api/hub/export/records.csv', ['admin', 'tech_lead', 'tech', 'sale_head', 'lead'], ({ user, q }) => {
    const r = rangeQ(q);
    const rows = store.card_records.find({ shoot_date: { gte: r.from, lte: r.to } }, { order: 'shoot_date' });
    // Người nhập là số theo từng người của Tech: Quản trị, Tech Lead có đủ; Tech Executive chỉ tên mình; team khác không có cột này.
    const by = ['admin', 'tech_lead'].includes(user.role) ? (x) => H.userName(x.by_id) : user.role === 'tech' ? (x) => (x.by_id === user.id ? user.name : '') : null;
    return csv(`dung-luong_${r.from}_${r.to}.csv`, ['Ngày quay', 'Thẻ', 'BO', 'Kit', 'GB', 'Giờ', 'Lý do 0 giờ', ...(by ? ['Người nhập'] : []), 'Lúc nhập'], rows.map((x) => [x.shoot_date, x.code, H.siteName(x.site_id), x.kit_id ? (store.kits.get(x.kit_id) || {}).code : '', x.gb, x.hours, x.zero_reason || '', ...(by ? [by(x)] : []), fmt(x.at)]));
  });
  R('GET', '/api/hub/export/incidents.csv', [...G.OVERVIEW, 'tech'], ({ q }) => {
    const r = rangeQ(q);
    const rows = store.incidents.find({ created_at: { gte: r.t0, lt: r.t1 } }, { order: 'created_at' });
    return csv(`su-co_${r.from}_${r.to}.csv`, ['Mã', 'BO', 'Kit', 'Nhãn', 'Mô tả', 'Trạng thái', 'Người báo', 'Báo lúc', 'Tech nhận lúc', 'Xử lý lúc', 'Cách xử lý', 'Ghi chú xử lý'], rows.map((i) => [i.code, H.siteName(i.site_id), i.kit_id ? (store.kits.get(i.kit_id) || {}).code : '', i.label, i.text, i.status, H.userName(i.raised_by), fmt(i.created_at), fmt(i.ack_at), fmt(i.resolved_at), i.resolution ? (INCIDENT_RES[i.resolution] || {}).label : '', i.resolve_note || '']));
  });
  R('GET', '/api/hub/export/kits.csv', G.STOCK_VIEW, () => {
    const types = H.stock.typeMap();
    return csv(`kit_${today()}.csv`, ['Mã kit', 'Loại', 'Trạng thái', 'BO', 'Thiết bị', 'Phụ kiện', 'Lỗi', 'Theo dõi', 'Kiểm lần cuối'], store.kits.find({}, { order: 'code' }).map((k) => [k.code, k.kind, KIT_ST[k.status] || k.status, H.siteName(k.site_id), H.stock.kitDevices(k.id).map((d) => `${d.code}${d.cond !== 'ok' ? ` (${d.cond})` : ''}`).join(' '), Object.entries(k.acc || {}).map(([t, n]) => `${(types.get(t) || {}).name || t}: ${n}`).join('; '), k.fault || '', k.watch || '', fmt(k.checked_at)]));
  });
  R('GET', '/api/hub/export/cards.csv', G.STOCK_VIEW, () => csv(`the_${today()}.csv`, ['Mã thẻ', 'Trạng thái', 'BO', 'Từ lúc', 'Ghi chú'], store.cards.find({}, { order: 'code' }).map((c) => [c.code, CARD_ST[c.status] || c.status, H.siteName(c.site_id), fmt(c.since), c.note || ''])));
  R('GET', '/api/hub/export/outlets.csv', [...G.STAFF], ({ user }) => {
    let rows = store.sites.find({ active: 1, type: 'bo' }, { order: 'name' });
    if (H.isSale(user) && H.outlets.saleScope(user)) rows = rows.filter((s) => s.sale_id === user.id);
    return csv(`bo_${today()}.csv`, ['Mã', 'Tên BO', 'Trạng thái', 'Sale', 'Địa chỉ', 'Người liên hệ', 'SĐT', 'Ngày đổi thẻ', 'Khung giờ', 'Launch', 'Kết thúc', 'Vĩ độ', 'Kinh độ'], rows.map((s) => [s.code || '', s.name, OUTLET_ST[s.ops_status || 'planned'], H.userName(s.sale_id), s.address || '', s.contact || '', s.phone || '', s.swap_days || '', s.swap_from ? `${s.swap_from}-${s.swap_to || ''}` : '', s.launch_date || '', s.end_date || '', s.lat ?? '', s.lon ?? '']));
  });

  return { footage, watchList, saleBlock, hosBlock, slaTeam, queue, activeDays };
}
