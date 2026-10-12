// jobs.js — việc tự sinh cho Logistics và Tech: khoá chống tạo trùng, tự giao theo bảng phân ca, hạn tính từ lúc có người nhận,
// báo vướng (tạm dừng hạn), trả việc, việc gấp, cảnh báo gọn cho Lead, và nối việc ngoài hiện trường (giao, đổi thẻ, đổi kit,
// thu hồi) với chuyến của FO bên Rider Live.
import { cleanStr, cleanText, int, num, atTime, dayStart, addDays, weekday, localDate, boLabel } from '../util.js';
import { fail } from '../core.js';
import { JOB_TYPES, JOB_ST, INCIDENT_RES, KIT_KINDS, CARD_ST } from './defs.js';

const FIELD_TYPES = ['deliver', 'card_swap', 'swap_faulty', 'recover', 'deliver_acc', 'manual'];
const MEMBER_ROLES = { logistics: ['logistic'], tech: ['tech'] };
const LEAD_ROLE = { logistics: 'lead', tech: 'tech_lead' };
/** Loại việc có hạn cố định theo ngày (ngày launch, khung giờ đổi thẻ, ngày kiểm kho). Các loại còn lại: hạn tính từ lúc có người nhận. */
const FIXED_DUE = ['deliver', 'card_swap', 'stock_check'];
const OPEN = ['open', 'doing'];
const TASK_OPEN = ['assigned', 'accepted', 'in_progress', 'unassigned'];

export function installJobs(H) {
  const { K, G, store, now, off, today, log, changed, notify, reasonOf, idList } = H;
  const { R } = K;
  const handlers = {};
  /** Hạn "trong ngày": mili-giây cuối cùng của ngày giờ Việt Nam (xong lúc 23:59:30 vẫn đúng hạn). */
  const endOfDay = (date) => dayStart(addDays(date, 1), off) - 1;
  const isLeadOf = (u, team) => u.role === 'admin' || u.role === LEAD_ROLE[team];
  const inTeam = (u, team) => H.TEAM_OF[u.role] === team || u.role === 'admin';

  // ───────────────────────── Định mức ─────────────────────────
  /** Phút chuẩn của một việc. Nhập dung lượng thẻ tính điểm theo từng thẻ ở bảng ghi nhận (card_records), nên việc tổng có 0 phút. */
  /** Khoá định mức riêng của team cho loại việc dùng chung hai team (việc giao tay): 'manual_tech', 'manual_logistics'. Mỗi Lead chốt phần team mình. */
  const teamKey = (type, team) => (JOB_TYPES[type] && JOB_TYPES[type].team === null && (team === 'tech' || team === 'logistics') ? `${type}_${team}` : null);
  function stdOf(type, result, team) {
    const c = H.cfg();
    if (type === 'cards_upload') return 0;
    if (type === 'incident' && result && INCIDENT_RES[result.resolution]) return c.jobStd['incident_' + result.resolution] ?? INCIDENT_RES[result.resolution].std;
    const tk = teamKey(type, team);
    return (tk ? c.jobStd[tk] : undefined) ?? c.jobStd[type] ?? (JOB_TYPES[type] || {}).std ?? 0;
  }
  const uploadStd = () => H.cfg().jobStd.cards_upload ?? JOB_TYPES.cards_upload.std;
  const slaOf = (type, team) => { const c = H.cfg(), tk = teamKey(type, team); return (tk ? c.jobSla[tk] : undefined) ?? c.jobSla[type] ?? (JOB_TYPES[type] || {}).sla ?? 24 * 60; };
  /** Tải còn lại của một việc (phút chuẩn). Nhập dung lượng thẻ: chỉ tính các thẻ của phiếu còn ở Tech chờ nhập. Việc giao tay tính 10 phút. */
  function openLoad(j) {
    if (j.type === 'cards_upload' && j.handover_id) return uploadStd() * store.cards.count({ handover_id: j.handover_id, status: 'at_tech' });
    return (stdOf(j.type, null, j.team) || 10) * (j.units || 1);
  }
  /** Cấu hình có thể riêng theo team (khi đã tách cấu hình theo team) hoặc chung. */
  /** Cấu hình riêng theo team (TEAM_CFG). */
  const tc = (key, team) => H.tcfg(key, team);

  // ───────────────────────── Dựng dữ liệu trả về ─────────────────────────
  function brief(j) {
    const t = now(), def = JOB_TYPES[j.type] || {};
    const kit = j.kit_id ? store.kits.get(j.kit_id) : null;
    const open = OPEN.includes(j.status);
    return {
      id: j.id, code: j.code, type: j.type, type_label: def.label || j.type, team: j.team, title: j.title, status: j.status, status_label: JOB_ST[j.status],
      site: j.site_id ? { id: j.site_id, name: H.siteName(j.site_id) } : null, kit: kit ? { id: kit.id, code: kit.code, status: kit.status } : null,
      request_id: j.request_id, incident_id: j.incident_id, handover_id: j.handover_id, task_id: j.task_id,
      assignee: j.assignee_id ? { id: j.assignee_id, name: H.userName(j.assignee_id) } : null, done_by: j.done_by ? { id: j.done_by, name: H.userName(j.done_by) } : null,
      date: j.date, show_date: j.show_date, due_at: j.due_at, sla_min: j.due_at ? null : slaOf(j.type, j.team), created_at: j.created_at, started_at: j.started_at, done_at: j.done_at,
      note: j.note || '', units: j.units || 1, priority: j.priority || 0, blocked: j.blocked || '', blocked_at: j.blocked_at || null,
      points: j.status === 'done' ? +((j.std_min || 0) / 6).toFixed(2) : +((stdFor(j) * (j.units || 1)) / 6).toFixed(2),
      overdue: open && !j.blocked && !!j.due_at && t > j.due_at, late: j.status === 'done' && !!j.due_at && j.done_at > j.due_at,
      late_mine: j.status === 'done' && !!j.due_at && j.done_at > dueFor(j), // trễ theo hạn riêng của người làm xong (trang Hiệu suất của tôi, cùng nguồn với chỉ số Đúng hạn)
    };
  }
  /**
   * Việc theo người xem: người làm, điểm, trễ hạn là số theo từng người, chỉ Lead của team và Quản trị thấy; nhân viên chỉ thấy của mình.
   * Việc chưa ai giữ vẫn kèm điểm (để biết việc đáng bao nhiêu); việc đã đóng của người khác bỏ cả người giữ.
   * Việc mình giữ nhưng người khác làm (Logistic Executive chuyển cho FO trong chuyến): thấy ai làm, không thấy điểm, trễ hạn của người đó.
   */
  function viewFor(user) {
    return (j) => {
      const b = brief(j);
      if (user && (isLeadOf(user, j.team) || j.done_by === user.id)) return b;
      if (user && j.assignee_id === user.id) return j.done_by ? { ...b, points: null, late: null, late_mine: null } : b;
      if (!j.assignee_id && !j.done_by) return b;
      return { ...b, assignee: OPEN.includes(j.status) ? b.assignee : null, done_by: null, points: null, late: null, late_mine: null };
    };
  }
  /** Thứ tự ưu tiên trong danh sách: việc gấp trước, rồi hạn gần nhất (việc chưa ai nhận tính hạn dự kiến). */
  const eta = (j) => j.due_at || j.created_at + slaOf(j.type, j.team) * 60000;
  const byUrgency = (a, b) => (b.priority || 0) - (a.priority || 0) || eta(a) - eta(b) || a.id - b.id;

  // ───────────────────────── Ai đang trong ca ─────────────────────────
  /** Ca đã duyệt của một người trong ngày (không tính ngày nghỉ phép). */
  function shiftOf(uid, d) {
    const r = store.roster.get(`${uid}:${d}`);
    return r && r.kind !== 'leave' && (r.status || 'approved') === 'approved' ? r : null;
  }
  function inWindow(r, d, t, team) {
    if (!r.start || !r.end) return true; // ca chỉ có ngày, không có giờ: cả ngày
    return t >= atTime(d, r.start, off) - H.tcfg('earlyCheckinMin', team) * 60000 && t <= atTime(d, r.end, off);
  }
  /**
   * Người đang trong ca: có ca đã duyệt hôm nay, đã chấm công và đang trong giờ ca.
   * Không có ca đã duyệt thì không trong ca (kể cả ngày team chưa xếp ca nào): việc không tự giao cho người đang nghỉ.
   */
  function onShift(u, t = now()) {
    const d = localDate(t, off);
    const r = shiftOf(u.id, d);
    if (!r) return false;
    const a = store.attendance.get(`${u.id}:${d}`);
    const present = !!(a && a.checkin_at && (a.status === 'present' || a.status === 'late'));
    return present && inWindow(r, d, t, H.TEAM_OF[u.role]);
  }
  /** Team có bật tự giao việc theo ca không (mỗi Lead chốt cho team mình). */
  const autoOn = (team) => !!H.tcfg('autoAssign', team);
  /**
   * Tải đang giữ của một người, tính theo phút chuẩn còn lại (openLoad). Việc đang chờ Logistic Lead đối chiếu sau chuyến không tính:
   * người giữ không làm được việc đó (chỉ Lead làm tay), nên không được coi là đang bận với nó khi chia việc.
   */
  function loadOf(uid, held = heldIds()) {
    let m = 0;
    for (const j of store.jobs.find({ assignee_id: uid, status: OPEN })) if (!held.has(j.id)) m += openLoad(j);
    return m;
  }
  /** Chọn người nhận: trong ca, ít tải nhất. Không ai trong ca thì để chung, ai vào ca sẽ được giao. fit(tải): chỉ chọn người còn dưới phần chia đều. */
  function pickAssignee(team, exclude, fit) {
    const roles = MEMBER_ROLES[team];
    if (!roles) return null;
    const t = now();
    const cands = store.users.find({ role: roles, active: 1 }).filter((u) => u.id !== exclude && onShift(u, t));
    if (!cands.length) return null;
    const load = new Map(cands.map((u) => [u.id, loadOf(u.id)]));
    cands.sort((a, b) => load.get(a.id) - load.get(b.id) || a.id - b.id);
    const c = fit ? cands.find((u) => fit(load.get(u.id))) : cands[0];
    return c ? c.id : null;
  }
  /** Bắt đầu đồng hồ hạn khi việc có người nhận (việc hạn cố định đã có hạn từ lúc tạo). */
  const clockPatch = (j, t) => (j.due_at ? {} : { sla_start: t, due_at: t + slaOf(j.type, j.team) * 60000, al_due: 0 });
  /**
   * Thời gian làm của người nhận sau: việc hạn cố định theo ngày (giao, đổi thẻ, kiểm kho) không được cộng;
   * loại khác được đúng khoảng hạn của việc (hạn của loại việc, hoặc khoảng ngắn hơn nếu việc được tạo với hạn riêng).
   */
  function ownSlaMs(j) {
    if (FIXED_DUE.includes(j.type) || !j.due_at) return 0;
    return Math.min(slaOf(j.type, j.team) * 60000, Math.max(0, j.due_at - (j.sla_start || j.created_at)));
  }
  /**
   * Hệ thống đổi hạn của việc (dời ngày launch, siết hạn chuẩn bị): người đang giữ việc có hạn riêng tính lại như lúc họ nhận
   * (max(hạn mới, lúc nhận + thời gian làm của việc)), giống Lead dời hạn áp cho cả người giữ việc. Người nhận sau vẫn giữ phần thời gian được cộng.
   */
  function duePatch(j, due) {
    if (!j.assignee_id || !j.due_mine) return { due_at: due };
    const nj = { ...j, due_at: due };
    return { due_at: due, due_mine: Math.max(due, (j.assigned_at || j.created_at) + ownSlaMs(nj)) };
  }
  /**
   * Giao việc cho một người (uid null: trả về cho cả đội). how: 'auto' (hệ thống tự giao), 'lead' (Lead giao tay), 'self' (tự nhận / theo thao tác).
   * Ghi lúc người này nhận việc và hạn riêng của họ = max(hạn của việc, lúc nhận + thời gian làm của việc): hạn của team vẫn theo hạn gốc,
   * người nhận sau không bị tính trễ cho khoảng thời gian trước khi họ có việc.
   * Người vừa trả việc (hoặc bị Lead gỡ) mà tự nhận lại hay được hệ thống giao lại thì giữ hạn riêng cũ (skip_due), không tự làm mới đồng hồ của mình;
   * Lead giao tay thì theo quyết định của Lead (hạn riêng tính từ lúc giao).
   */
  function holderPatch(j, uid, how, t = now()) {
    if (!uid) return { assignee_id: null, assigned_at: null, assign_by: null, due_mine: null };
    const clock = clockPatch(j, t);
    if (uid === j.assignee_id) return { ...clock, ...(how === 'lead' ? { assign_by: 'lead' } : {}) };
    const nj = { ...j, ...clock };
    const back = how !== 'lead' && uid === j.skip_uid && j.skip_due;
    return { ...clock, assignee_id: uid, assigned_at: t, assign_by: how, due_mine: back ? j.skip_due : nj.due_at ? Math.max(nj.due_at, t + ownSlaMs(nj)) : null };
  }
  /** Ghi người vừa trả việc / bị gỡ cùng hạn riêng của họ lúc đó, để nhận lại thì không được làm mới hạn. */
  const skipPatch = (j, t = now()) => ({ skip_uid: j.assignee_id, skip_at: t, skip_due: j.due_mine || j.due_at || null });
  /** Hạn dùng để tính điểm đúng hạn cá nhân: hạn riêng khi chính người giữ việc làm xong; còn lại theo hạn của việc. */
  const dueFor = (j) => (j.due_mine && j.done_by && j.done_by === j.assignee_id ? Math.max(j.due_at || 0, j.due_mine) : j.due_at);
  /** Người vừa trả việc chỉ bị bỏ qua khi tự giao trong chính ngày trả, và hết bị bỏ qua khi họ vào ca lại sau lúc trả. */
  function skipOf(j) {
    const d = today();
    if (!j.skip_uid || !j.skip_at || localDate(j.skip_at, off) !== d) return null;
    const a = store.attendance.get(`${j.skip_uid}:${d}`);
    return a && a.checkin_at && a.checkin_at > j.skip_at ? null : j.skip_uid;
  }
  /** Giờ vào ca sớm nhất trong các ca mẫu: mốc cho ca chỉ ghi ngày (không có giờ). */
  function firstStart(team) {
    const list = tc('shifts', team);
    const starts = (Array.isArray(list) ? list : []).map((x) => x.start).filter(Boolean).sort();
    return starts[0] || '08:00';
  }
  /** Người có ca hôm nay sắp vào (giờ vào ca trong khoảng absentAfterMin phút quanh lúc này), chưa vào và chưa bị ghi vắng / nghỉ. */
  function expectedSoon(u, t) {
    const d = localDate(t, off), team = H.TEAM_OF[u.role];
    const r = shiftOf(u.id, d);
    if (!r) return false;
    const a = store.attendance.get(`${u.id}:${d}`);
    if (a && (a.checkin_at || ['absent', 'leave', 'off'].includes(a.status))) return false;
    const start = atTime(d, r.start || firstStart(team), off), win = tc('absentAfterMin', team) * 60000;
    return t >= start - win && t <= start + win && (!r.end || t <= atTime(d, r.end, off));
  }
  /**
   * Từ lúc nào một người coi là ngoài ca (null: đang hoặc sắp trong ca hôm nay):
   * hết ca quá releaseGraceMin phút; hôm nay không có ca đã duyệt; ca chỉ ghi ngày mà quá giờ vào ca sớm nhất + absentAfterMin vẫn chưa vào.
   * Có ca có giờ mà chưa vào trong giờ ca thì để phần ghi vắng (people.tick) xử lý.
   */
  function offSince(u, t) {
    if (onShift(u, t)) return null;
    const d = localDate(t, off), team = H.TEAM_OF[u.role];
    const r = shiftOf(u.id, d);
    if (!r) return atTime(d, '00:00', off); // không có ca đã duyệt hôm nay: ngoài ca cả ngày
    if (r.start && r.end) { const end = atTime(d, r.end, off) + tc('releaseGraceMin', team) * 60000; return t > end ? end : null; }
    const late = atTime(d, firstStart(team), off) + tc('absentAfterMin', team) * 60000;
    return t > late ? late : null;
  }

  // ───────────────────────── Tạo việc ─────────────────────────
  function fixedDue(spec, type, t) {
    if (spec.due_at) return spec.due_at;
    if (type === 'deliver' && spec.launch_date) return endOfDay(spec.launch_date);
    if (type === 'card_swap' && spec.date) { const s = store.sites.get(spec.site_id); return s && s.swap_to ? atTime(spec.date, s.swap_to, off) : endOfDay(spec.date); }
    if (type === 'stock_check') return endOfDay(spec.date || today());
    return null;
  }
  /** Tạo việc nếu chưa có (theo khoá dedupe). Trả về việc (mới hoặc đã có). */
  function ensure(spec, actor) {
    const def = JOB_TYPES[spec.type];
    if (!def) throw new Error('unknown job type ' + spec.type);
    if (spec.dedupe) {
      // Khoá kết thúc bằng ":open" chỉ chặn trùng khi việc còn mở (kit có thể hỏng và sửa nhiều lần); khoá khác chặn trùng mãi mãi.
      const ex = store.jobs.find({ dedupe: spec.dedupe, status: spec.dedupe.endsWith(':open') ? OPEN : { ne: 'cancelled' } }, { limit: 1 })[0];
      if (ex) return ex;
      // Lead đã huỷ việc định kỳ này (đổi thẻ của BO trong ngày, kiểm kho trong ngày): không tạo lại.
      const skip = store.jobs.find({ dedupe: spec.dedupe + ':skip' }, { limit: 1 })[0];
      if (skip) return skip;
    }
    const t = now();
    const team = spec.team || def.team;
    const date = spec.date || spec.show_date || today();
    const visible = !spec.show_date || spec.show_date <= today();
    const assignee = spec.assignee_id ?? (autoOn(team) && visible ? pickAssignee(team) : null);
    const how = !assignee ? null : spec.assignee_id == null ? 'auto' : actor && actor.id === assignee ? 'self' : 'lead';
    const fixed = !!spec.due_at || FIXED_DUE.includes(spec.type);
    let due = fixed ? fixedDue(spec, spec.type, t) : null, slaStart = null;
    if (!fixed && assignee) { slaStart = t; due = t + slaOf(spec.type, team) * 60000; }
    const job = {
      code: H.nextCode('J' + H.ym() + '-', 'jobs', 4), type: spec.type, team, title: cleanStr(spec.title, 160) || def.label, site_id: spec.site_id ?? null, kit_id: spec.kit_id ?? null,
      request_id: spec.request_id ?? null, incident_id: spec.incident_id ?? null, handover_id: spec.handover_id ?? null, dedupe: spec.dedupe || null, status: 'open',
      assignee_id: assignee, created_by: actor ? actor.id : null, created_at: t, show_date: spec.show_date || null, due_at: due, started_at: null,
      done_at: null, done_by: null, result: null, std_min: null, units: spec.units || 1, note: cleanText(spec.note || '', 500), task_id: null, al_due: 0, al_lead: 0, date,
      priority: spec.priority ? 1 : 0, sla_start: slaStart, blocked: null, blocked_at: null, skip_uid: null, al_pool: 0,
      assigned_at: assignee ? t : null, assign_by: how, due_mine: assignee ? due : null, skip_at: null, skip_due: null,
    };
    job.id = store.jobs.insert(job);
    log('job', job.id, 'create', `${actor ? actor.name : 'Hệ thống'} tạo việc ${job.code}: ${job.title}${assignee ? `, giao cho ${H.userName(assignee)}` : ''}.`, actor, spec.req_key ? { req_key: spec.req_key } : null);
    if (assignee && (!actor || actor.id !== assignee)) notify({ ids: [assignee] }, job.priority ? 'warn' : 'info', 'job', `${job.priority ? 'Việc gấp' : 'Việc mới'}: ${job.title}.`, `job:${job.id}`);
    changed('jobs');
    return job;
  }
  function jobOrFail(id) { const j = store.jobs.get(K.idOf(id)); if (!j) fail(404, 'not_found', 'Không tìm thấy việc.'); return j; }
  function canAct(u, j) {
    if (isLeadOf(u, j.team)) return true;
    if (!inTeam(u, j.team)) return false;
    return !j.assignee_id || j.assignee_id === u.id;
  }
  const openOrFail = (j) => { if (!OPEN.includes(j.status)) fail(409, 'job_closed', 'Việc này đã đóng.'); };

  /**
   * Hoàn thành việc. handler theo loại việc kiểm tra kết quả và làm các thay đổi kéo theo (đổi trạng thái kit, sinh việc kế tiếp…).
   * opt.by: người được tính điểm (ví dụ FO làm qua chuyến; việc tự đóng thì là người đang giữ việc). opt.raw: chỉ đóng việc, không chạy handler.
   */
  function complete(job, actor, result = {}, opt = {}) {
    if (!OPEN.includes(job.status)) fail(409, 'job_closed', 'Việc này đã đóng.');
    let out = result;
    store.tx(() => {
      if (!opt.raw && handlers[job.type]) out = handlers[job.type](job, actor, result, opt) || result;
      const t = now();
      const units = Math.max(1, int(out && out.units, 1, 100000) || job.units || 1);
      const by = opt.by !== undefined ? opt.by : actor ? actor.id : null;
      const patch = { status: 'done', done_at: t, done_by: by, result: out || null, std_min: by ? stdFor(job, out) * units : 0, units, assignee_id: job.assignee_id ?? by };
      if (job.dedupe && job.dedupe.endsWith(':open')) patch.dedupe = job.dedupe.slice(0, -5) + ':done:' + job.id;
      if (job.blocked_at) { patch.blocked = null; patch.blocked_at = null; if (job.due_at) patch.due_at = job.due_at + (t - job.blocked_at); if (job.due_mine) patch.due_mine = job.due_mine + (t - job.blocked_at); }
      if (!job.due_at) { patch.sla_start = job.started_at || t; patch.due_at = patch.sla_start + slaOf(job.type, job.team) * 60000; }
      store.jobs.update(job.id, patch);
      log('job', job.id, 'done', `${opt.byName || (actor ? actor.name : 'Hệ thống')} hoàn thành ${job.code}: ${job.title}${out && out.summary ? ` — ${out.summary}` : ''}.`, actor, out);
      settleHeld(job, actor);
      afterClose(job, actor, out);
    });
    changed('jobs', 'perf');
    return store.jobs.get(job.id);
  }
  function afterClose(job, actor, out) {
    if (job.incident_id && H.incidents) H.incidents.onJobDone(job, actor, out);
    if (!job.request_id) return;
    const r = store.requests.get(job.request_id);
    // Yêu cầu hỗ trợ đóng khi hết việc mở; riêng "Thêm kit" đi theo kit (đóng khi kit đã giao tới BO, outlets.refreshRequest).
    if (r && r.kind === 'support' && r.status !== 'closed' && !H.outlets.isKitReq(r) && !store.jobs.count({ request_id: r.id, status: OPEN })) {
      store.requests.update(r.id, { status: 'closed', closed_at: now(), updated_at: now() });
      log('request', r.id, 'closed', `Yêu cầu hỗ trợ ${r.code} đã xử lý xong.`, actor);
      notify({ ids: [r.sale_id, r.created_by] }, 'info', 'support', `Yêu cầu hỗ trợ ${r.code} tại ${H.siteName(r.site_id)} đã xử lý xong.`, `request:${r.id}`, `support_done:${r.id}`);
      changed('requests');
    }
  }
  /** Đóng tự động các việc khớp điều kiện. Điểm tính cho người đang giữ việc, hoặc người thao tác nếu cùng team; không thì không ai được điểm. */
  function closeFor(where, actor, note) {
    for (const j of store.jobs.find({ ...where, status: OPEN })) {
      const by = j.assignee_id || (actor && inTeam(actor, j.team) && actor.role !== 'admin' ? actor.id : null);
      const res = { auto: true, summary: note };
      if (j.type === 'prep_kit' && j.request_id) res.units = Math.max(1, store.kits.count({ request_id: j.request_id }));
      complete(j, actor, res, { raw: true, by, byName: by ? H.userName(by) : 'Hệ thống' });
    }
  }
  /** Người thao tác nhận luôn việc đang để chung (ví dụ Logistics gửi kit đi kiểm thì nhận việc chuẩn bị của yêu cầu đó). */
  function claimFor(where, user) {
    for (const j of store.jobs.find({ ...where, status: OPEN, assignee_id: null })) {
      if (!inTeam(user, j.team) || user.role === 'admin') continue;
      store.jobs.update(j.id, holderPatch(j, user.id, 'self'));
      log('job', j.id, 'claim', `${user.name} nhận việc ${j.code}.`, user);
    }
  }
  /**
   * Huỷ các việc khớp điều kiện. opt.keepHeld: việc đang chờ Logistic Lead đối chiếu sau chuyến (FO có thể đã làm thật) thì giữ lại,
   * như việc đang nằm trong chuyến: dòng Đối chiếu vẫn làm được. Trả về các việc được giữ.
   */
  function cancelFor(where, actor, note, opt = {}) {
    const w = { ...where };
    if (!w.status) w.status = OPEN;
    const held = opt.keepHeld ? heldIds() : null, kept = [];
    for (const j of store.jobs.find(w)) {
      if (held && held.has(j.id)) { kept.push(j); continue; }
      store.jobs.update(j.id, { status: 'cancelled', done_at: now(), blocked: null, blocked_at: null, note: [j.note, note].filter(Boolean).join(' · ').slice(0, 500) });
      log('job', j.id, 'cancel', `Việc ${j.code} được huỷ: ${note}.`, actor);
      if (j.task_id) detachFromTask(store.jobs.get(j.id)); // đọc lại: việc vừa chuyển "đã huỷ", không được mở lại khi gỡ khỏi chuyến
      if (j.incident_id && j.type !== 'incident' && H.incidents) H.incidents.onJobCancelled(j, actor, note);
    }
    changed('jobs');
    return kept;
  }
  function retime(where, launchDate) {
    const c = H.cfg();
    for (const j of store.jobs.find({ ...where, status: OPEN })) store.jobs.update(j.id, { show_date: addDays(launchDate, -c.setupShowDays), ...duePatch(j, endOfDay(launchDate)), date: addDays(launchDate, -c.setupShowDays), al_due: 0 });
    changed('jobs');
  }
  /**
   * Tự giao các việc đang để chung cho người trong ca. Gọi khi có người vào ca và theo nhịp mỗi phút.
   * Mỗi người nhận tới phần chia đều của mình: (tải người đang trong ca + tải hàng việc chờ) chia cho số người đang trong ca và sắp vào ca,
   * để người đến sớm không ôm hết việc tồn qua đêm; phần còn lại chờ người sắp vào (ai vắng thì phần đó giao cho người đang trong ca). Việc gấp giao ngay.
   */
  function assignPool(team) {
    if (team && !autoOn(team)) return 0;
    const d = today(), t = now(), held = heldIds();
    // Việc chờ Logistic Lead đối chiếu sau chuyến không tự giao: nhân viên không làm được (chỉ Lead làm tay theo thực tế).
    const pool = store.jobs.find({ assignee_id: null, status: 'open', ...(team ? { team } : {}) }, { order: 'created_at' }).sort(byUrgency)
      .filter((j) => (!j.show_date || j.show_date <= d) && MEMBER_ROLES[j.team] && !held.has(j.id));
    const caps = new Map();
    // Người vừa trả việc (skip) không nhận lại việc đó nên không tính vào phần chia đều của việc đó (cả người lẫn tải của họ).
    const capOf = (tm, skip) => {
      const key = `${tm}:${skip || ''}`;
      if (!caps.has(key)) {
        const users = store.users.find({ role: MEMBER_ROLES[tm], active: 1 }).filter((u) => u.id !== skip);
        const on = users.filter((u) => onShift(u, t)), soon = users.filter((u) => !on.includes(u) && expectedSoon(u, t)).length;
        const total = on.reduce((a, u) => a + loadOf(u.id, held), 0) + pool.filter((j) => j.team === tm).reduce((a, j) => a + openLoad(j), 0);
        caps.set(key, on.length + soon ? total / (on.length + soon) : Infinity);
      }
      return caps.get(key);
    };
    let n = 0;
    for (const j of pool) {
      if (!autoOn(j.team)) continue;
      const skip = skipOf(j);
      const cap = j.priority ? Infinity : capOf(j.team, skip);
      const who = pickAssignee(j.team, skip, (load) => load < cap);
      if (!who) continue;
      store.jobs.update(j.id, holderPatch(j, who, 'auto', t));
      log('job', j.id, 'auto_assign', `Hệ thống giao ${j.code} cho ${H.userName(who)} (trong ca, ít tải nhất).`, null);
      notify({ ids: [who] }, j.priority ? 'warn' : 'info', 'job', `${j.priority ? 'Việc gấp' : 'Việc mới'}: ${j.title}.`, `job:${j.id}`);
      n++;
    }
    if (n) changed('jobs');
    return n;
  }
  /**
   * Có người vào ca (uid): người đó nhận bớt việc hệ thống đã tự giao mà chưa bắt đầu của người đang trong ca giữ nhiều tải nhất,
   * tới khi chênh lệch với họ không còn lớn hơn một việc. Việc Lead giao tay, việc tự nhận, việc đang làm / đang vướng / trong chuyến FO giữ nguyên.
   */
  function rebalance(team, uid) {
    if (!MEMBER_ROLES[team] || !autoOn(team)) return 0;
    const t = now(), d = today();
    const on = store.users.find({ role: MEMBER_ROLES[team], active: 1 }).filter((u) => onShift(u, t));
    const lo = on.find((u) => u.id === uid);
    if (!lo || on.length < 2) return 0;
    const held = heldIds();
    const load = new Map(on.map((u) => [u.id, loadOf(u.id, held)]));
    const moved = new Map();
    let n = 0;
    for (let guard = 0; guard < 500; guard++) {
      const hi = on.filter((u) => u.id !== lo.id).sort((a, b) => load.get(b.id) - load.get(a.id) || a.id - b.id)[0];
      const gap = load.get(hi.id) - load.get(lo.id);
      const list = store.jobs.find({ assignee_id: hi.id, status: 'open', team, assign_by: 'auto', task_id: null })
        .filter((j) => !j.started_at && !j.blocked && !held.has(j.id) && (!j.show_date || j.show_date <= d) && skipOf(j) !== lo.id && openLoad(j) < gap).sort(byUrgency);
      const j = list[list.length - 1]; // chuyển việc ít gấp nhất; người đang giữ làm tiếp các việc gấp hơn
      if (!j) break;
      const jl = openLoad(j);
      store.jobs.update(j.id, holderPatch(j, lo.id, 'auto', t));
      log('job', j.id, 'auto_assign', `Hệ thống chuyển ${j.code} từ ${hi.name} sang ${lo.name} (chia đều khi có người vào ca).`, null);
      notify({ ids: [lo.id] }, j.priority ? 'warn' : 'info', 'job', `${j.priority ? 'Việc gấp' : 'Việc mới'}: ${j.title}.`, `job:${j.id}`);
      load.set(hi.id, load.get(hi.id) - jl); load.set(lo.id, load.get(lo.id) + jl);
      moved.set(hi.id, (moved.get(hi.id) || 0) + 1);
      n++;
    }
    for (const [id, k] of moved) notify({ ids: [id] }, 'info', 'job', `${k} việc chưa bắt đầu của bạn đã chuyển cho ${lo.name} (vừa vào ca) để chia đều việc.`, '');
    if (n) changed('jobs');
    return n;
  }
  /**
   * Người vắng ca: việc chưa bắt đầu của họ trả về để người khác trong ca nhận. Cùng cách với trả việc hết ca (releaseOffShift):
   * việc đang làm, đang vướng giữ nguyên (Lead được báo việc đang vướng để quyết định); việc Lead tự giữ thì Lead tự quyết.
   */
  function releaseOf(uid, why) {
    const u = store.users.get(uid);
    let n = 0;
    const stay = new Map();
    for (const j of store.jobs.find({ assignee_id: uid, status: 'open', task_id: null })) {
      if (u && u.active && isLeadOf(u, j.team)) continue; // Lead tự giữ việc: Lead tự quyết
      if (j.blocked) { stay.set(j.team, (stay.get(j.team) || 0) + 1); continue; }
      store.jobs.update(j.id, { ...holderPatch(j, null), skip_uid: uid, skip_at: now(), skip_due: null }); // vắng ca: không giữ hạn riêng cũ
      log('job', j.id, 'release', `${j.code} trả về cho cả đội: ${why}.`, null);
      n++;
    }
    for (const [team, k] of stay) if (LEAD_ROLE[team]) notify({ roles: [LEAD_ROLE[team]] }, 'warn', 'absent', `${why}: còn ${k} việc đang vướng vẫn giữ, Lead xem có cần giao lại.`, `user:${uid}`, `absent_stay:${uid}:${today()}`);
    if (n) { changed('jobs'); assignPool(null); }
    return n;
  }
  /**
   * Nhịp mỗi phút: người đã ngoài ca (offSince) mà còn giữ việc chưa bắt đầu được giao trước lúc đó thì việc trả về cho cả đội để người đang trong ca nhận.
   * Việc giao cho họ sau lúc đó (Lead giao tay khi biết họ ngoài ca) giữ nguyên. Việc đang làm, đang vướng, trong chuyến FO giữ nguyên; Lead được báo một lần.
   */
  function releaseOffShift(t) {
    const held = new Map();
    for (const j of store.jobs.find({ status: OPEN })) {
      if (!j.assignee_id || !MEMBER_ROLES[j.team]) continue;
      if (!held.has(j.assignee_id)) held.set(j.assignee_id, []);
      held.get(j.assignee_id).push(j);
    }
    let n = 0;
    for (const [uid, list] of held) {
      const u = store.users.get(uid);
      if (!u) continue;
      const team = list[0].team, member = (MEMBER_ROLES[team] || []).includes(u.role);
      if (u.active && isLeadOf(u, team)) continue; // Lead tự giữ việc: Lead tự quyết
      // Tài khoản đã khoá hoặc không phải thành viên team (dữ liệu cũ, trước khi có trả việc lúc khoá / đổi vai trò và kiểm người nhận, ví dụ việc giao cho FO): trả ngay.
      const since = !u.active || !member ? Infinity : offSince(u, t);
      if (since === null) continue;
      const rel = list.filter((j) => j.status === 'open' && !j.task_id && !j.blocked && (j.assigned_at || 0) < since);
      const stay = list.filter((j) => !j.task_id && (j.status === 'doing' || j.blocked));
      const r = shiftOf(u.id, localDate(t, off));
      const why = !u.active ? 'tài khoản đã khoá' : !member ? 'không phải thành viên của team giữ việc' : !r ? 'hôm nay không có ca' : r.start ? `hết ca ${r.end}` : 'chưa vào ca';
      for (const j of rel) {
        store.jobs.update(j.id, holderPatch(j, null));
        log('job', j.id, 'release', `${j.code} trả về cho cả đội: ${u.name} ${why}.`, null);
        n++;
      }
      if (!rel.length && !stay.length) continue;
      const parts = [rel.length ? `${rel.length} việc chưa bắt đầu đã trả về cho người đang trong ca` : '', stay.length ? `còn ${stay.length} việc đang làm hoặc đang vướng vẫn giữ, Lead xem có cần giao lại` : ''].filter(Boolean);
      notify({ roles: [LEAD_ROLE[team]] }, 'warn', 'offshift', `${u.name} ${why}: ${parts.join('; ')}.`, `user:${u.id}`, `offshift:${u.id}:${since === Infinity ? today() : since}`);
    }
    if (n) changed('jobs');
    return n;
  }
  /** Tài khoản bị khoá hoặc đổi vai trò: mọi việc người đó đang giữ (kể cả đang làm dở) trả về cho cả đội, trừ việc nằm trong chuyến FO chưa xong. */
  K.hooks.onUserChanged = (u, nu, actor) => store.tx(() => { // một giao dịch: trả việc, nhật ký, giao lại; thông báo gửi sau khi ghi xong
    const why = !nu.active ? 'tài khoản bị khoá' : 'đổi vai trò';
    const teams = new Map();
    for (const j of store.jobs.find({ assignee_id: u.id, status: OPEN })) {
      if (j.task_id) { const tk = store.tasks.get(j.task_id); if (tk && TASK_OPEN.includes(tk.status)) continue; }
      store.jobs.update(j.id, { ...holderPatch(j, null), status: 'open', skip_uid: null, skip_at: null, skip_due: null, al_lead: 0 });
      log('job', j.id, 'release', `${j.code} trả về cho cả đội: ${u.name} ${why}${j.status === 'doing' ? ' (việc đang làm dở, người nhận sau xem nhật ký để làm tiếp)' : ''}.`, actor);
      teams.set(j.team, (teams.get(j.team) || 0) + 1);
    }
    if (!teams.size) return;
    for (const [team, n] of teams) if (LEAD_ROLE[team]) notify({ roles: [LEAD_ROLE[team]] }, 'warn', 'release', `${u.name} ${why}: ${n} việc đang giữ đã trả về cho cả đội.`, `user:${u.id}`);
    changed('jobs');
    assignPool(null);
  });

  // ───────────────────────── API ─────────────────────────
  R('GET', '/api/hub/jobs', G.STAFF, ({ user, q }) => {
    if (H.isSale(user)) fail(403, 'forbidden', 'Sale xem tiến độ ở mục Yêu cầu và BO.');
    // Mỗi team chỉ xem hàng việc của team mình; Quản trị chọn team.
    const team = user.role === 'admin' ? (q.team === 'tech' || q.team === 'logistics' ? q.team : null) : H.TEAM_OF[user.role];
    const where = {};
    if (team) where.team = team;
    const st = q.status || 'active';
    if (st === 'active') where.status = OPEN;
    else if (st !== 'all') where.status = String(st).split(',').filter((x) => JOB_ST[x]);
    if (q.type) where.type = String(q.type).split(',');
    if (q.site) where.site_id = K.idOf(q.site);
    if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) where.date = { gte: q.from, ...(q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? { lte: q.to } : {}) };
    let rows = store.jobs.find(where, { order: 'created_at', desc: st !== 'active', limit: 5000 });
    const d = today(), t = now();
    if (st === 'active' && q.upcoming !== '1') rows = rows.filter((j) => !j.show_date || j.show_date <= d);
    const lead = team ? isLeadOf(user, team) : user.role === 'admin';
    const mine = q.view === 'mine' || (!lead && q.view !== 'team');
    if (mine) rows = rows.filter((j) => j.assignee_id === user.id || (!j.assignee_id && inTeam(user, j.team) && OPEN.includes(j.status)));
    // Nhân viên xem "Cả team": hàng việc đang mở của team; việc đã xong / đã huỷ chỉ việc của mình (khối lượng theo từng người chỉ Lead xem).
    else if (!lead) rows = rows.filter((j) => OPEN.includes(j.status) || j.assignee_id === user.id || j.done_by === user.id);
    if (q.assignee) rows = rows.filter((j) => j.assignee_id === K.idOf(q.assignee));
    if (q.pool === '1') rows = rows.filter((j) => !j.assignee_id);
    if (st === 'active') rows.sort(byUrgency);
    const t0 = atTime(d, '00:00', off);
    const out = {
      jobs: rows.slice(0, 1000).map(viewFor(user)), total: rows.length, team, lead,
      counts: {
        mine: store.jobs.count({ assignee_id: user.id, status: OPEN }),
        pool: store.jobs.find({ ...(team ? { team } : {}), assignee_id: null, status: 'open' }).filter((j) => (!j.show_date || j.show_date <= d) && MEMBER_ROLES[j.team]).length,
        done_today: store.jobs.count({ done_by: user.id, done_at: { gte: t0 } }),
        overdue: rows.filter((j) => OPEN.includes(j.status) && !j.blocked && j.due_at && j.due_at < t).length,
        blocked: rows.filter((j) => OPEN.includes(j.status) && j.blocked).length,
      },
    };
    if (lead && team && MEMBER_ROLES[team]) {
      // Bảng tải của team cho Lead: ai đang trong ca, đang giữ bao nhiêu việc, bao nhiêu phút chuẩn.
      const open = store.jobs.find({ team, status: OPEN });
      out.members = store.users.find({ role: [...MEMBER_ROLES[team], LEAD_ROLE[team]], active: 1 }, { order: 'name' }).map((u) => {
        const mineJ = open.filter((j) => j.assignee_id === u.id);
        return { id: u.id, name: u.name, role: u.role, on_shift: onShift(u, t), open: mineJ.filter((j) => j.status === 'open').length, doing: mineJ.filter((j) => j.status === 'doing').length, overdue: mineJ.filter((j) => !j.blocked && j.due_at && j.due_at < t).length, blocked: mineJ.filter((j) => j.blocked).length, load_min: Math.round(mineJ.reduce((a, j) => a + openLoad(j), 0)) };
      });
    }
    return out;
  });
  R('GET', '/api/hub/jobs/:id', G.STAFF, ({ user, p }) => {
    if (H.isSale(user)) fail(403, 'forbidden', 'Không có quyền.');
    const j = jobOrFail(p.id);
    if (!inTeam(user, j.team)) fail(403, 'forbidden', 'Việc này không thuộc team của bạn.');
    // Việc đã đóng của người khác: nhân viên không xem người làm, điểm và nhật ký (khối lượng theo từng người chỉ Lead xem).
    const own = isLeadOf(user, j.team) || OPEN.includes(j.status) || (!j.assignee_id && !j.done_by) || j.assignee_id === user.id || j.done_by === user.id;
    const held = OPEN.includes(j.status) ? heldRecon(j.id) : null;
    const out = {
      job: { ...viewFor(user)(j), result: j.result }, log: own ? store.hub_log.find({ entity: 'job', entity_id: j.id }, { order: 'ts', desc: true, limit: 50 }) : [], log_hidden: !own,
      held: held ? { id: held.id, text: held.text } : null,
      can_act: canAct(user, j) && OPEN.includes(j.status) && (!held || isLeadOf(user, j.team)), can_assign: isLeadOf(user, j.team) && OPEN.includes(j.status), can_block: OPEN.includes(j.status) && (isLeadOf(user, j.team) || j.assignee_id === user.id),
    };
    if (out.can_assign && MEMBER_ROLES[j.team]) out.team_members = store.users.find({ role: [...MEMBER_ROLES[j.team], LEAD_ROLE[j.team]], active: 1 }, { order: 'name' }).map((u) => ({ id: u.id, name: u.name, on_shift: onShift(u) }));
    if (j.kit_id) out.kit = H.stock.kitView(store.kits.get(j.kit_id));
    if (j.request_id) out.request = H.outlets.reqBrief(store.requests.get(j.request_id));
    if (j.site_id) { const s = store.sites.get(j.site_id); out.site = s ? { id: s.id, name: s.name, address: s.address, phone: s.phone, contact: s.contact, swap_from: s.swap_from, swap_to: s.swap_to, has_coord: s.lat !== null } : null; }
    if (j.type === 'deliver' && j.request_id) { out.kits = store.kits.find({ request_id: j.request_id }).map((k) => H.stock.kitView(k)); out.cards_office = store.cards.find({ status: 'office', task_id: null }, { order: 'code', limit: 400 }).map((c) => c.code); }
    if ((j.type === 'recover' || j.type === 'card_swap') && j.site_id) out.kits = store.kits.find({ site_id: j.site_id, status: 'at_bo' }).map((k) => H.stock.kitView(k));
    if (j.type === 'card_swap' && j.site_id) { out.cards_at_bo = store.cards.find({ site_id: j.site_id, status: 'at_bo' }).map((c) => c.code); out.cards_office = store.cards.find({ status: 'office', task_id: null }, { order: 'code', limit: 400 }).map((c) => c.code); }
    if (j.type === 'swap_faulty') out.replacements = store.kits.find({ status: ['ready'], request_id: null, kind: (store.kits.get(j.kit_id) || {}).kind }).filter((k) => !kitTrip(k.id)).map((k) => ({ id: k.id, code: k.code }));
    if (['deliver_acc', 'receive_field', 'recover', 'swap_faulty'].includes(j.type)) out.acc_types = store.dev_types.find({ kind: 'acc', active: 1 }, { order: 'sort' }).map((t) => ({ id: t.id, name: t.name }));
    if (j.type === 'deliver_acc') { const r = j.request_id ? store.requests.get(j.request_id) : null; out.acc_need = (r && r.need && r.need.acc) || {}; out.acc_free = Object.fromEntries(Object.keys(out.acc_need).map((t) => [t, H.stock.accFree(t, j.id)])); }
    if (j.handover_id && H.cards) out.handover = H.cards.handoverView(store.handovers.get(j.handover_id), true, user);
    if (j.incident_id && H.incidents) out.incident = H.incidents.brief(store.incidents.get(j.incident_id), user);
    if (j.task_id) { const tk = store.tasks.get(j.task_id); out.task = tk ? { id: tk.id, code: tk.code, status: tk.status, fo: H.userName(tk.fo_id) } : null; }
    return out;
  });
  R('POST', '/api/hub/jobs/:id/claim', G.OPS_STAFF, ({ user, p }) => {
    const j = jobOrFail(p.id);
    if (!inTeam(user, j.team)) fail(403, 'forbidden', 'Việc này không thuộc team của bạn.');
    openOrFail(j);
    if (j.assignee_id && j.assignee_id !== user.id && !isLeadOf(user, j.team)) fail(409, 'taken', `${H.userName(j.assignee_id)} đã nhận việc này.`);
    if (heldRecon(j.id) && !isLeadOf(user, j.team)) fail(403, 'held', HELD_JOB);
    store.jobs.update(j.id, { ...holderPatch(j, user.id, 'self'), skip_uid: null, skip_at: null, skip_due: null });
    log('job', j.id, 'claim', `${user.name} nhận việc ${j.code}.`, user);
    if (H.incidents) H.incidents.ackFromJob(j, user); // nhận việc xử lý sự cố = nhận sự cố
    changed('jobs');
    return { job: brief(store.jobs.get(j.id)) };
  });
  /** Người nhận việc của hub: thành viên hoặc Lead đang hoạt động của đúng team giữ việc (không FO, không team khác, không Quản trị). */
  function memberOrFail(u, team) {
    if (!u || !u.active || ![...(MEMBER_ROLES[team] || []), LEAD_ROLE[team]].includes(u.role)) fail(400, 'bad_user', `Chỉ giao được cho thành viên đang hoạt động của team ${team === 'tech' ? 'Tech' : 'Logistics'} (không giao cho FO hay người team khác).`);
    return u.id;
  }
  function assignTo(j, to, user) {
    if (!isLeadOf(user, j.team)) fail(403, 'forbidden', 'Chỉ Lead của team mới giao lại việc.');
    openOrFail(j);
    const uid = to ? memberOrFail(store.users.get(K.idOf(to)), j.team) : null;
    const patch = { ...holderPatch(j, uid, 'lead'), al_lead: 0, skip_uid: null, skip_at: null, skip_due: null };
    if (!uid && j.assignee_id) Object.assign(patch, skipPatch(j)); // để chung: không tự giao lại cho người vừa được gỡ trong ngày; họ nhận lại thì giữ hạn riêng cũ
    if (!uid && j.status === 'doing' && !j.task_id) patch.status = 'open'; // việc đang làm đưa về hàng chung thì trở lại chờ làm để tự giao được
    store.jobs.update(j.id, patch);
    log('job', j.id, 'assign', `${user.name} giao việc ${j.code} cho ${uid ? H.userName(uid) : 'cả đội (chưa ai nhận)'}.`, user);
    if (uid && uid !== user.id) notify({ ids: [uid] }, j.priority ? 'warn' : 'info', 'job', `${user.name} giao cho bạn: ${j.title}.`, `job:${j.id}`);
  }
  R('POST', '/api/hub/jobs/:id/assign', G.LEADS, ({ user, p, b }) => {
    const j = jobOrFail(p.id);
    assignTo(j, b.user_id, user);
    if (!b.user_id) assignPool(j.team);
    changed('jobs');
    return { job: brief(store.jobs.get(j.id)) };
  });
  R('POST', '/api/hub/jobs/bulk-assign', G.LEADS, ({ user, b }) => {
    const ids = idList(b.job_ids, 200);
    store.tx(() => { for (const id of ids) assignTo(jobOrFail(id), b.user_id, user); if (!b.user_id) assignPool(null); });
    changed('jobs');
    return { ok: true, count: ids.length };
  });
  R('POST', '/api/hub/jobs/:id/start', G.OPS_STAFF, ({ user, p }) => {
    const j = jobOrFail(p.id);
    if (!canAct(user, j)) fail(403, 'forbidden', 'Việc này đã giao cho người khác.');
    if (j.status !== 'open') fail(409, 'bad_state', 'Việc không ở trạng thái chờ làm.');
    if (heldRecon(j.id) && !isLeadOf(user, j.team)) fail(403, 'held', HELD_JOB);
    const t = now();
    store.jobs.update(j.id, { status: 'doing', started_at: t, ...(j.assignee_id ? clockPatch(j, t) : holderPatch(j, user.id, 'self', t)) });
    log('job', j.id, 'start', `${user.name} bắt đầu ${j.code}.`, user);
    if (H.incidents) H.incidents.ackFromJob(j, user); // bắt đầu việc xử lý sự cố = nhận sự cố
    changed('jobs');
    return { job: brief(store.jobs.get(j.id)) };
  });
  R('POST', '/api/hub/jobs/:id/done', G.OPS_STAFF, ({ user, p, b }) => {
    const j = jobOrFail(p.id);
    if (!canAct(user, j)) fail(403, 'forbidden', 'Việc này đã giao cho người khác.');
    if (j.task_id) { const tk = store.tasks.get(j.task_id); if (tk && TASK_OPEN.includes(tk.status)) fail(409, 'in_task', `Việc đang nằm trong chuyến ${tk.code} của FO; hệ thống tự đóng khi FO và BO xác nhận. Muốn làm tay thì gỡ khỏi chuyến trước.`); }
    if (OPEN.includes(j.status) && heldRecon(j.id) && !isLeadOf(user, j.team)) fail(403, 'held', HELD_JOB);
    const r = b.result && typeof b.result === 'object' && !Array.isArray(b.result) ? b.result : {};
    // Lead hoàn thành giúp thì điểm vẫn tính cho người đang giữ việc nếu có.
    const by = isLeadOf(user, j.team) && j.assignee_id && j.assignee_id !== user.id && b.credit_assignee ? j.assignee_id : user.id;
    const done = complete(j, user, r, { photos: b.photos, by });
    return { job: brief(done) };
  });
  /**
   * Việc giữ cho kit / thẻ / yêu cầu đi đúng vòng thì không huỷ tay (huỷ sẽ làm kit kẹt ở một trạng thái không ai xử lý);
   * mỗi loại có đường đúng để dừng, ghi trong lời báo. Việc khác Lead huỷ được, kèm lý do.
   */
  const NO_CANCEL = {
    prep_kit: 'Việc chuẩn bị đi theo yêu cầu. Muốn dừng thì huỷ yêu cầu ở mục Yêu cầu; việc đi kèm tự huỷ.',
    deliver: 'Việc giao đi theo yêu cầu. Muốn dừng thì huỷ yêu cầu (hoặc dời ngày launch); việc đi kèm tự huỷ.',
    check_kit: 'Việc kiểm đi theo trạng thái kit. Muốn dừng thì bấm "Mở lại để chỉnh" ở kit; việc kiểm tự huỷ.',
    repair: 'Kit đang ở Tech chờ sửa. Sửa xong thì báo xong; kit không dùng nữa thì cho ngừng dùng (việc tự huỷ).',
    checkin: 'Kit đã về kho chờ Tech check-in. Check-in xong hoặc cho kit ngừng dùng.',
    receive_back: 'Tech đã xử lý xong kit, Logistics bấm nhận lại để kit về sẵn sàng.',
    receive_field: 'Kit đang trên đường về kho. Bấm nhận khi kit về tới; thiếu phụ kiện thì ghi số thực nhận.',
    recover: 'Việc thu hồi đi theo yêu cầu kết thúc ghi hình và đóng khi đã thu kit. Muốn giữ BO ghi hình tiếp thì Sale phụ trách hoặc Head of Sale huỷ yêu cầu kết thúc (khi FO chưa đi thu).',
    cards_receive: 'Việc nhận đi theo phiếu bàn giao. Muốn dừng thì bên gửi huỷ phiếu.',
    cards_back: 'Việc nhận đi theo phiếu bàn giao. Muốn dừng thì bên gửi huỷ phiếu.',
    cards_upload: 'Việc tự đóng khi mọi thẻ của phiếu đã nhập dung lượng (hoặc được ghi hỏng / thất lạc).',
    cards_return: 'Việc tự đóng khi mọi thẻ đã nhập của phiếu đã vào phiếu trả Logistics; phiếu trả bị huỷ, bị gỡ thẻ hoặc Logistics không nhận được thẻ thì việc mở lại.',
    incident: 'Việc đi theo sự cố. Báo nhầm thì Tech Lead huỷ sự cố; việc tự huỷ.',
  };
  R('POST', '/api/hub/jobs/:id/cancel', G.LEADS, ({ user, p, b }) => {
    const j = jobOrFail(p.id);
    if (!isLeadOf(user, j.team)) fail(403, 'forbidden', 'Chỉ Lead của team mới huỷ việc.');
    openOrFail(j);
    if (NO_CANCEL[j.type]) fail(409, 'no_cancel', NO_CANCEL[j.type]);
    failIfTripRunning({ id: j.id }, 'Việc');
    const reason = reasonOf(b.reason, 'lý do huỷ');
    store.tx(() => {
      // Đổi kit hỏng không cần nữa (Tech xác nhận kit đã ổn): gỡ cờ lỗi trước để kit không bị báo mãi và sự cố đi kèm đóng đúng cách.
      if (j.type === 'swap_faulty') { dropSwap(j, user, reason, { force: true }); return; }
      cancelFor({ id: j.id }, user, reason);
      // Việc định kỳ (đổi thẻ của BO trong ngày, kiểm kho trong ngày) Lead đã huỷ thì giữ khoá ":skip" để nhịp sau không tạo lại.
      if (['card_swap', 'stock_check'].includes(j.type) && j.dedupe) store.jobs.update(j.id, { dedupe: j.dedupe + ':skip' });
      settleSupport(j.request_id, user, reason);
    });
    changed('jobs', 'kits', 'requests');
    return { job: brief(store.jobs.get(j.id)) };
  });
  /** Yêu cầu hỗ trợ không còn việc nào mở (do huỷ) thì đóng lại và báo Sale, để yêu cầu không treo. Yêu cầu đã huỷ thì giữ nguyên. */
  function settleSupport(reqId, actor, why) {
    const r = reqId ? store.requests.get(reqId) : null;
    if (!r || r.kind !== 'support' || ['closed', 'cancelled'].includes(r.status) || store.jobs.count({ request_id: r.id, status: OPEN })) return;
    store.requests.update(r.id, { status: 'closed', closed_at: now(), updated_at: now(), reason: cleanStr(`Huỷ: ${why}`, 300) });
    log('request', r.id, 'closed', `Yêu cầu hỗ trợ ${r.code} đóng vì việc đi kèm bị huỷ: ${why}.`, actor);
    notify({ ids: [r.sale_id, r.created_by] }, 'warn', 'support', `Yêu cầu hỗ trợ ${r.code} tại ${H.siteName(r.site_id)} đã đóng mà không thực hiện: ${why}.`, `request:${r.id}`, `support_cancel:${r.id}`);
  }
  /**
   * Việc đổi kit hỏng không còn cần (Tech kết luận không phải sự cố / xử lý tại chỗ, sự cố hoặc yêu cầu đổi máy bị huỷ):
   * gỡ cờ lỗi của kit (và thiết bị) do lần báo này đặt, huỷ việc, đóng yêu cầu hỗ trợ đi kèm. Trả về true khi đã huỷ.
   * Không rõ kit đã ổn chưa (việc đã lên chuyến FO, hoặc kit còn bị báo lỗi lần khác sau khi có việc) thì không tự gỡ:
   * giữ việc, đưa vào Đối chiếu cho Logistics quyết định. opt.detach: bỏ liên kết yêu cầu đã huỷ khỏi việc được giữ.
   * opt.force: Lead đã quyết định huỷ việc (nút Huỷ việc) nên không xét các trường hợp trên.
   */
  function dropSwap(j, actor, why, opt = {}) {
    if (!OPEN.includes(j.status)) return false;
    const k = j.kit_id ? store.kits.get(j.kit_id) : null;
    const who = actor ? actor.name : 'Hệ thống';
    if (!opt.force) {
      const tk = j.task_id ? store.tasks.get(j.task_id) : null;
      const inTrip = !!tk && TASK_OPEN.includes(tk.status);
      const held = !inTrip && !!heldRecon(j.id); // FO có thể đã đổi thật: số giao nhận đang chờ Lead đối chiếu
      const more = !!k && store.hub_log.count({ entity: 'kit', entity_id: k.id, action: 'faulty', ts: { gte: j.created_at } }) > 1;
      if (inTrip || held || more) {
        if (opt.detach && j.request_id) { store.jobs.update(j.id, { request_id: null }); log('job', j.id, 'detach', `Việc ${j.code} không còn đi theo yêu cầu (${why}); giữ lại chờ Logistics quyết định.`, actor); }
        const because = inTrip ? `việc đã lên chuyến ${tk.code} của FO` : held ? 'số giao nhận của chuyến FO đang chờ Logistic Lead đối chiếu (FO có thể đã đổi kit thật)' : 'kit còn bị báo lỗi lần khác';
        H.recon('swap', 'logistics', 'high', 'job', `swapkeep:${j.id}`, `${why}, nhưng việc đổi kit ${j.code}${k ? ` (kit ${k.code} tại ${H.siteName(j.site_id)})` : ''} chưa huỷ vì ${because}. Kiểm tra kit rồi huỷ việc hoặc đổi kit.`, { job_id: j.id, kit_id: k ? k.id : null, task_id: inTrip ? tk.id : null });
        return false;
      }
    }
    if (k && k.fault) {
      for (const d of H.stock.kitDevices(k.id)) if (d.cond === 'faulty' && d.note === k.fault) { store.devices.update(d.id, { cond: 'ok', updated_at: now() }); log('device', d.id, 'unfault', `${who} gỡ báo hỏng ${d.code}: ${why}.`, actor); }
      store.kits.update(k.id, { fault: null, updated_at: now() });
      log('kit', k.id, 'unfault', `${who} huỷ việc đổi kit ${k.code} và gỡ cờ lỗi: ${why}.`, actor);
    }
    cancelFor({ id: j.id }, actor, why);
    settleSupport(j.request_id, actor, why);
    if (!opt.force && j.assignee_id && (!actor || actor.id !== j.assignee_id)) notify({ ids: [j.assignee_id] }, 'info', 'job', `Việc ${j.code} đã huỷ: ${why}.`, `job:${j.id}`);
    changed('kits', 'requests');
    return true;
  }
  /** Trả việc về cho cả đội (ví dụ hết ca, không làm được). Hệ thống giao lại cho người khác trong ca. */
  R('POST', '/api/hub/jobs/:id/release', G.OPS_STAFF, ({ user, p, b }) => {
    const j = jobOrFail(p.id);
    openOrFail(j);
    if (j.assignee_id !== user.id && !isLeadOf(user, j.team)) fail(403, 'forbidden', 'Bạn không giữ việc này.');
    if (j.task_id) { const tk = store.tasks.get(j.task_id); if (tk && TASK_OPEN.includes(tk.status)) fail(409, 'in_task', `Việc đang nằm trong chuyến ${tk.code}.`); }
    const reason = reasonOf(b.reason, 'lý do trả việc');
    store.jobs.update(j.id, { ...holderPatch(j, null), status: 'open', ...skipPatch(j) });
    log('job', j.id, 'release', `${user.name} trả việc ${j.code} về cho cả đội: ${reason}.`, user);
    notify({ roles: [LEAD_ROLE[j.team]] }, 'info', 'release', `${user.name} trả việc ${j.title}: ${reason}.`, `job:${j.id}`);
    assignPool(j.team);
    changed('jobs');
    return { job: brief(store.jobs.get(j.id)) };
  });
  /** Báo vướng: việc chờ bên khác (thiếu linh kiện, chờ BO, chờ team khác). Hạn tạm dừng, Lead được báo ngay. */
  R('POST', '/api/hub/jobs/:id/block', G.OPS_STAFF, ({ user, p, b }) => {
    const j = jobOrFail(p.id);
    openOrFail(j);
    if (j.assignee_id !== user.id && !isLeadOf(user, j.team)) fail(403, 'forbidden', 'Chỉ người giữ việc hoặc Lead mới báo vướng.');
    if (j.blocked) fail(409, 'already_blocked', 'Việc đang ở trạng thái vướng.');
    const reason = reasonOf(b.reason, 'đang vướng ở đâu');
    store.jobs.update(j.id, { blocked: reason, blocked_at: now() });
    log('job', j.id, 'block', `${user.name} báo vướng ${j.code}: ${reason}.`, user);
    notify({ roles: [LEAD_ROLE[j.team]] }, 'warn', 'blocked', `${j.title} đang vướng: ${reason} (${user.name}).`, `job:${j.id}`);
    changed('jobs', 'overview');
    return { job: brief(store.jobs.get(j.id)) };
  });
  R('POST', '/api/hub/jobs/:id/unblock', G.OPS_STAFF, ({ user, p, b }) => {
    const j = jobOrFail(p.id);
    openOrFail(j);
    if (!j.blocked) fail(409, 'not_blocked', 'Việc không ở trạng thái vướng.');
    if (j.assignee_id !== user.id && !isLeadOf(user, j.team)) fail(403, 'forbidden', 'Chỉ người giữ việc hoặc Lead mới gỡ vướng.');
    const t = now(), paused = t - j.blocked_at;
    store.jobs.update(j.id, { blocked: null, blocked_at: null, due_at: j.due_at ? j.due_at + paused : null, due_mine: j.due_mine ? j.due_mine + paused : null, skip_due: j.skip_due ? j.skip_due + paused : null, al_due: 0, al_lead: 0 });
    log('job', j.id, 'unblock', `${user.name} gỡ vướng ${j.code} sau ${Math.round(paused / 60000)} phút${b.note ? `: ${cleanStr(b.note, 200)}` : ''}. Hạn được cộng thêm thời gian vướng.`, user);
    if (j.assignee_id && j.assignee_id !== user.id) notify({ ids: [j.assignee_id] }, 'info', 'job', `${j.title}: đã gỡ vướng, làm tiếp được.`, `job:${j.id}`);
    changed('jobs', 'overview');
    return { job: brief(store.jobs.get(j.id)) };
  });
  /** Lead chỉnh việc: gấp / không gấp, dời hạn (bắt buộc lý do), sửa tên, ghi chú. Người giữ việc chỉ sửa ghi chú. */
  R('PATCH', '/api/hub/jobs/:id', G.OPS_STAFF, ({ user, p, b }) => {
    const j = jobOrFail(p.id);
    openOrFail(j);
    const lead = isLeadOf(user, j.team);
    if (!lead && j.assignee_id !== user.id) fail(403, 'forbidden', 'Bạn không giữ việc này.');
    const patch = {}, notes = [];
    if (b.note !== undefined) { patch.note = cleanText(b.note, 500); notes.push('ghi chú'); }
    if (lead) {
      if (b.title !== undefined) { patch.title = cleanStr(b.title, 160); if (patch.title.length < 3) fail(400, 'bad_title', 'Tên việc quá ngắn.'); notes.push('tên việc'); }
      if (b.priority !== undefined) { patch.priority = b.priority ? 1 : 0; notes.push(patch.priority ? 'đánh dấu gấp' : 'bỏ gấp'); }
      if (b.due_at !== undefined || b.due_hours !== undefined) {
        const due = b.due_hours !== undefined ? now() + (int(b.due_hours, 1, 24 * 30) ?? fail(400, 'bad_due', 'Hạn từ 1 giờ đến 30 ngày.')) * 3600000 : int(b.due_at, now(), now() + 60 * 86400000) ?? fail(400, 'bad_due', 'Hạn mới phải ở tương lai, tối đa 60 ngày.');
        const reason = reasonOf(b.reason, 'lý do dời hạn');
        patch.due_at = due; patch.al_due = 0; patch.al_lead = 0; if (!j.sla_start) patch.sla_start = j.sla_start || now();
        if (j.assignee_id) patch.due_mine = due; // Lead dời hạn: hạn mới áp cho cả người đang giữ việc
        notes.push(`dời hạn (${reason})`);
      }
    } else if (b.title !== undefined || b.priority !== undefined || b.due_at !== undefined || b.due_hours !== undefined) fail(403, 'forbidden', 'Chỉ Lead mới đổi hạn, độ gấp hoặc tên việc.');
    if (!notes.length) return { job: brief(j) };
    store.jobs.update(j.id, patch);
    log('job', j.id, 'update', `${user.name} sửa ${j.code}: ${notes.join(', ')}.`, user, patch);
    if (patch.priority && j.assignee_id && j.assignee_id !== user.id) notify({ ids: [j.assignee_id] }, 'warn', 'job', `Việc gấp: ${j.title}.`, `job:${j.id}`);
    changed('jobs');
    return { job: brief(store.jobs.get(j.id)) };
  });
  R('POST', '/api/hub/jobs', [...G.LEADS, 'logistic', 'tech'], ({ user, b }) => {
    // Cùng hộp thoại gửi lại (mất phản hồi rồi bấm lại): trả việc đã tạo, không tạo việc thứ hai.
    const key = H.reqKeyOf(b);
    const again = H.replayOf('job', ['create'], user, key);
    if (again && store.jobs.get(again.entity_id)) return { job: brief(store.jobs.get(again.entity_id)), replay: true };
    const team = b.team === 'tech' || b.team === 'logistics' ? b.team : H.TEAM_OF[user.role];
    if (!MEMBER_ROLES[team]) fail(400, 'bad_team', 'Chọn team Logistics hoặc Tech.');
    if (!isLeadOf(user, team) && H.TEAM_OF[user.role] !== team) fail(403, 'forbidden', 'Bạn chỉ tạo việc cho team của mình.');
    const title = cleanStr(b.title, 160);
    if (title.length < 3) fail(400, 'bad_title', 'Cần nhập tên việc.');
    let assignee = null;
    if (b.assignee_id === 'me' || (!isLeadOf(user, team) && !b.assignee_id && b.self)) assignee = memberOrFail(user, team); // "Tôi tự làm": chỉ thành viên / Lead của team
    else if (b.assignee_id) assignee = memberOrFail(store.users.get(K.idOf(b.assignee_id)), team);
    const hours = b.due_hours === undefined || b.due_hours === '' ? 24 : int(b.due_hours, 1, 24 * 30) ?? fail(400, 'bad_due', 'Hạn từ 1 giờ đến 30 ngày.');
    const std = b.std_min === undefined || b.std_min === '' ? null : num(b.std_min);
    // Phút chuẩn của việc giao tay do Lead của team đặt; việc nhân viên tự tạo tính theo định mức "việc giao tay" trong Cài đặt.
    if (std !== null && !isLeadOf(user, team)) fail(403, 'forbidden', 'Chỉ Lead của team đặt phút chuẩn cho việc giao tay.');
    if (std !== null && (std < 0 || std > 480)) fail(400, 'bad_std', 'Phút chuẩn của việc giao tay từ 0 đến 480.');
    const job = ensure({ type: 'manual', team, title, note: b.note, priority: !!b.priority, site_id: b.site_id ? H.outlets.outletOrFail(b.site_id).id : null, assignee_id: assignee ?? undefined, due_at: now() + hours * 3600000, req_key: key }, user);
    if (std !== null) store.jobs.update(job.id, { result: { std_min: std } });
    return { job: brief(store.jobs.get(job.id)) };
  });

  // ───────────────────────── Việc kho: xử lý khi hoàn thành ─────────────────────────
  const kitOf = (job) => { const k = job.kit_id ? store.kits.get(job.kit_id) : null; if (!k) fail(409, 'no_kit', 'Việc này không gắn với kit nào.'); return k; };
  /** Kết quả kiểm từng thiết bị: [{ id, ok, health, note }]. Thiết bị không đạt → hỏng; đạt thì thiết bị đang hỏng / đang sửa về Tốt. */
  function applyDeviceResults(kit, list, actor) {
    const devs = H.stock.kitDevices(kit.id);
    const bad = [];
    for (const r of Array.isArray(list) ? list : []) {
      const d = devs.find((x) => x.id === int(r && r.id, 1, 1e12));
      if (!d) continue;
      const patch = { updated_at: now() };
      if (r.health && ['good', 'weak', 'bad'].includes(r.health)) patch.health = r.health;
      if (r.ok === false) { patch.cond = 'faulty'; patch.note = cleanStr(r.note, 200) || 'Không đạt khi kiểm'; bad.push(d.code); }
      else if (r.ok === true && ['faulty', 'repairing'].includes(d.cond)) patch.cond = 'ok';
      store.devices.update(d.id, patch);
    }
    if (bad.length) log('kit', kit.id, 'check_fail', `${actor.name}: ${bad.join(', ')} không đạt.`, actor);
    return bad;
  }
  handlers.prep_kit = (job) => {
    const r = job.request_id ? store.requests.get(job.request_id) : null;
    if (r && store.kits.count({ request_id: r.id }) === 0) fail(409, 'no_kits', 'Chưa gán kit nào cho yêu cầu. Gán kit rồi gửi Tech kiểm; việc này tự đóng khi kit sẵn sàng.');
    if (r && r.need) {
      // Báo xong khi còn thiếu kit (hoặc kit chưa gửi kiểm) thì yêu cầu kẹt "đang chuẩn bị" mà không ai có việc: chặn.
      const kits = store.kits.find({ request_id: r.id });
      const short = kits.filter((k) => k.kind !== 'iphone').length < (r.need.multicam || 0) || kits.filter((k) => k.kind === 'iphone').length < (r.need.iphone || 0);
      if (short) fail(409, 'short', `Yêu cầu cần ${H.outlets.needText(r.need)}, mới gán ${kits.length} kit. Gán đủ kit rồi gửi Tech kiểm; việc này tự đóng khi kit sẵn sàng.`);
      const pend = kits.filter((k) => ['preparing', 'returned'].includes(k.status));
      if (pend.length) fail(409, 'not_submitted', `Kit ${pend.map((k) => k.code).join(', ')} chưa gửi Tech kiểm. Chuẩn bị xong thì bấm "Gửi Tech kiểm"; việc này tự đóng khi kit sẵn sàng.`);
    }
    return { summary: 'Đã chuẩn bị', units: r ? Math.max(1, store.kits.count({ request_id: r.id })) : 1 };
  };
  handlers.check_kit = (job, actor, res) => {
    const kit = kitOf(job);
    if (kit.status !== 'wait_check') fail(409, 'bad_state', `Kit ${kit.code} không ở trạng thái chờ kiểm.`);
    const bad = applyDeviceResults(kit, res.devices, actor);
    const pass = res.pass !== false && !bad.length;
    const prev = store.jobs.find({ type: 'check_kit', kit_id: kit.id, status: 'done' });
    const firstPass = pass && !prev.some((x) => x.result && x.result.pass === false);
    if (pass) {
      const c = H.stock.completeness(kit, H.stock.kitDevices(kit.id));
      if (!c.complete) fail(409, 'incomplete', 'Kit chưa đủ thành phần hoặc còn thiết bị hỏng; không thể báo đạt.');
      H.stock.setKit(kit, kit.request_id ? 'reserved' : 'ready', actor, `${actor.name} kiểm kit ${kit.code}: đạt.`, { checked_at: now(), checked_by: actor.id, fault: null });
      if (kit.request_id) H.outlets.refreshRequest(kit.request_id, actor);
    } else {
      H.stock.reportFaulty(store.kits.get(kit.id), null, cleanStr(res.note, 200) || `Không đạt khi kiểm: ${bad.join(', ')}`, actor);
    }
    return { pass, first_pass: firstPass, bad, note: cleanStr(res.note, 300), summary: pass ? 'Đạt' : `Không đạt${bad.length ? ': ' + bad.join(', ') : ''}` };
  };
  /**
   * Giao và setup: Logistics xác nhận tay (mã biên bản) hoặc FO + BO xác nhận qua chuyến. Giao được một phần (res.kit_ids):
   * kit chưa giao vẫn chờ giao và có việc giao phần còn lại. Thẻ đi trong kit (res.cards_out) ghi "ở BO" để lượt đổi thẻ đầu tiên thu đúng thẻ;
   * thiếu mã thẻ thì không chặn launch mà đưa vào Đối chiếu.
   */
  handlers.deliver = (job, actor, res, opt) => {
    const site = store.sites.get(job.site_id);
    const all = store.kits.find({ request_id: job.request_id, status: ['reserved', 'delivering'] });
    if (!all.length) fail(409, 'no_kits', 'Không còn kit nào chờ giao cho yêu cầu này.');
    const pick = Array.isArray(res.kit_ids) && res.kit_ids.length ? idList(res.kit_ids, 200) : null;
    const kits = pick ? all.filter((k) => pick.includes(k.id)) : all;
    if (pick && kits.length !== pick.length) fail(400, 'bad_kit', 'Có kit không thuộc yêu cầu này hoặc không còn chờ giao.');
    for (const k of kits) if (heldFor('kits', k.id, job.id)) fail(409, 'held', `Kit ${k.code} đang chờ Logistic Lead đối chiếu số lượng sau chuyến (mục Đối chiếu).`);
    const held = !!heldRecon(job.id);
    const doc = cleanStr(res.doc_code, 40);
    if (!opt.viaTask && !held && !doc) fail(400, 'doc_required', 'Cần nhập mã biên bản bàn giao (2 bản, BO giữ 1 bản).');
    const t = now();
    const cards = (res.skip_cards ? [] : H.codesOf(res.cards_out || [], 200)).map((code) => {
      const c = store.cards.find({ code }, { limit: 1 })[0];
      if (!c) fail(404, 'no_card', `Không có thẻ mã ${code}.`);
      if (!['office', 'with_fo'].includes(c.status)) fail(409, 'card_busy', `Thẻ ${code} không ở trạng thái sẵn sàng tại VP.`);
      if (c.task_id && c.task_id !== opt.task_id) { const tk = store.tasks.get(c.task_id); if (tk && TASK_OPEN.includes(tk.status)) fail(409, 'card_busy', `Thẻ ${code} đã được chọn cho chuyến ${tk.code}. Chọn thẻ khác.`); }
      if (heldFor('cards', code, job.id)) fail(409, 'held', `Thẻ ${code} đang chờ Logistic Lead đối chiếu số lượng sau chuyến (mục Đối chiếu).`);
      return c;
    });
    H.outlets.delivered(site, kits.map((k) => k.id), actor, doc ? `biên bản ${doc}` : opt.viaTask ? 'FO giao, BO đã xác nhận' : held ? 'Logistic Lead chốt sau đối chiếu' : '');
    for (const c of cards) store.cards.update(c.id, { status: 'at_bo', site_id: site.id, task_id: null, kit_id: null, since: t, bo_in: t, bo_out: null, updated_at: t });
    if (cards.length) changed('cards');
    const want = kits.length * H.cfg().cardsPerKit;
    if (!res.skip_cards && cards.length < want) {
      H.recon('deliver', 'logistics', 'high', 'outlet', `launchcards:${job.id}`, `${boLabel(site.name)} (${job.code}): giao ${kits.length} kit nhưng chỉ ghi ${cards.length}/${want} mã thẻ để trong kit. Ghi mã thẻ đang ở BO ở mục Thẻ để lượt đổi thẻ đầu tiên thu đúng thẻ.`, { job_id: job.id, site_id: site.id, codes: cards.map((c) => c.code) });
    }
    const left = all.filter((k) => !kits.includes(k));
    if (left.length) ensure({ type: 'deliver', site_id: site.id, request_id: job.request_id, title: `Giao ${left.length} kit còn lại tại ${site.name}`, dedupe: `deliver:${job.request_id}:rest:${H.uniq()}`, due_at: now() + 24 * 3600000, note: `Còn ${left.map((k) => k.code).join(', ')} chưa giao (${job.code})` }, actor);
    return { kits: kits.map((k) => k.code), left: left.map((k) => k.code), cards_out: cards.map((c) => c.code), doc_code: doc, via: opt.viaTask ? 'fo' : 'manual', units: 1, summary: `Đã giao ${kits.length} kit${cards.length ? `, ${cards.length} thẻ trong kit` : ''}${doc ? `, biên bản ${doc}` : ''}${left.length ? `, còn ${left.length} kit chưa giao` : ''}` };
  };
  /**
   * Đổi thẻ: thẻ mới (theo mã nếu có) sang "ở BO"; thẻ cũ đang ở BO được thu về. Số FO báo khác số trên hệ thống thì đưa vào Đối chiếu.
   * Ghi rõ thẻ thu (cards_in) thì mỗi mã phải là thẻ đang ở chính BO này; mã khác (thẻ lạ, thẻ ở BO khác, trong phiếu, ở Tech, ở VP)
   * thì từ chối cả lượt, không đổi thẻ nào. Thẻ hệ thống ghi ở BO mà không thu thì giữ ở BO và vào Đối chiếu.
   */
  handlers.card_swap = (job, actor, res, opt) => {
    const out = H.codesOf(res.cards_out || [], 200), inn = H.codesOf(res.cards_in || [], 200);
    const t = now();
    const site = store.sites.get(job.site_id);
    if (inn.length) {
      const bad = inn.map((code) => [code, store.cards.find({ code }, { limit: 1 })[0]]).filter(([, c]) => !c || c.status !== 'at_bo' || c.site_id !== job.site_id);
      if (bad.length) fail(409, 'bad_cards', `Thẻ không còn ở ${site ? boLabel(site.name) : 'BO này'}: ${bad.slice(0, 12).map(([code, c]) => `${code} (${!c ? 'không có trong kho' : c.status === 'at_bo' ? `ở ${boLabel(H.siteName(c.site_id))}` : CARD_ST[c.status] || c.status})`).join(', ')}${bad.length > 12 ? '…' : ''}. Trang có thể đã cũ: tải lại việc rồi chọn lại thẻ đã thu.`);
    }
    // BO đã thu hồi hết kit trong lúc chuyến chạy: không để thẻ mới lại BO (không còn máy ghi); thẻ mới theo FO về, thẻ cũ vẫn thu.
    const keep = site && ['live', 'paused', 'ending'].includes(site.ops_status) && store.kits.count({ site_id: site.id, status: 'at_bo' }) > 0;
    const given = res.count_out !== undefined && res.count_out !== null && res.count_out !== '';
    // Thẻ mới không có mã thì hệ thống không biết thẻ nào đang ở BO: làm tay phải ghi mã, hoặc ghi rõ số thẻ đã để lại để đưa vào Đối chiếu.
    if (!opt.viaTask && keep && !out.length && !given) fail(400, 'cards_required', 'Nhập mã thẻ mới đã để lại BO. Thẻ không đọc được mã thì ghi số thẻ đã để lại; hệ thống đưa vào Đối chiếu để ghi mã sau.');
    for (const code of [...out, ...inn]) if (heldFor('cards', code, job.id)) fail(409, 'held', `Thẻ ${code} đang chờ Logistic Lead đối chiếu số lượng sau chuyến (mục Đối chiếu).`);
    for (const code of out) {
      const c = store.cards.find({ code }, { limit: 1 })[0];
      if (!c) fail(404, 'no_card', `Không có thẻ mã ${code}.`);
      if (!['office', 'with_fo'].includes(c.status)) fail(409, 'card_busy', `Thẻ ${code} không ở trạng thái sẵn sàng tại VP.`);
      if (c.task_id && c.task_id !== opt.task_id) { const tk = store.tasks.get(c.task_id); if (tk && TASK_OPEN.includes(tk.status)) fail(409, 'card_busy', `Thẻ ${code} đã được chọn cho chuyến ${tk.code}. Chọn thẻ khác.`); }
      if (!keep) { store.cards.update(c.id, opt.viaTask ? { status: 'with_fo', task_id: opt.task_id, updated_at: t } : { status: 'office', task_id: null, updated_at: t }); continue; }
      store.cards.update(c.id, { status: 'at_bo', site_id: job.site_id, task_id: null, since: t, bo_in: t, bo_out: null, kit_id: null, updated_at: t });
    }
    if (!keep && out.length && site) H.recon('card_swap', 'logistics', 'mid', 'card', `swapended:${job.id}`, `Đổi thẻ ${site.name} (${job.code}): BO không còn kit ghi hình nên ${out.length} thẻ mới (${out.join(', ')}) không tính là để lại BO. Kiểm lại thẻ thực tế với FO.`, { job_id: job.id, codes: out });
    const atBo = store.cards.find({ site_id: job.site_id, status: 'at_bo' }).filter((c) => !out.includes(c.code));
    const collected = inn.length ? inn : atBo.map((c) => c.code);
    for (const code of collected) if (heldFor('cards', code, job.id)) fail(409, 'held', `Thẻ ${code} đang chờ Logistic Lead đối chiếu số lượng sau chuyến (mục Đối chiếu).`);
    const left = atBo.filter((c) => !collected.includes(c.code));
    if (left.length && site) H.recon('card_swap', 'logistics', 'high', 'card', `swapleft:${job.id}`, `Đổi thẻ ${boLabel(site.name)} (${job.code}): ${left.length} thẻ hệ thống ghi đang ở BO không được thu (${left.slice(0, 10).map((c) => c.code).join(', ')}${left.length > 10 ? '…' : ''}). Thẻ vẫn ghi ở BO; kiểm lại với BO và thu ở lượt sau.`, { job_id: job.id, codes: left.map((c) => c.code) });
    for (const code of collected) {
      const c = store.cards.find({ code }, { limit: 1 })[0];
      if (!c || out.includes(code)) continue;
      store.cards.update(c.id, { status: opt.viaTask ? 'with_fo' : 'returned', task_id: opt.viaTask ? opt.task_id : null, since: t, bo_out: t, updated_at: t });
    }
    const nOut = int(res.count_out, 0, 999) ?? out.length, nIn = int(res.count_in, 0, 999) ?? collected.length;
    if (res.count_in !== undefined && res.count_in !== null && nIn !== collected.length && site) {
      H.recon('card_swap', 'logistics', 'high', 'card', `swapcount:${job.id}`, `Đổi thẻ ${site.name} (${job.code}): báo thu ${nIn} thẻ, hệ thống ghi ${collected.length} thẻ đang ở BO. Kiểm lại thẻ thực tế khi lập phiếu gửi Tech.`, { job_id: job.id, reported: nIn, system: collected.length, codes: collected });
    }
    // Báo để lại số thẻ khác số mã đã ghi (thẻ không có mã, hoặc để lại thiếu): hệ thống không biết thẻ nào đang ở BO → Đối chiếu.
    if (keep && given && nOut !== out.length && site) {
      H.recon('card_swap', 'logistics', 'high', 'card', `swapout:${job.id}`, `Đổi thẻ ${boLabel(site.name)} (${job.code}): báo để lại ${nOut} thẻ, hệ thống ghi ${out.length} thẻ có mã${out.length ? ` (${out.join(', ')})` : ''}. Ghi mã thẻ đang ở BO ở mục Thẻ.`, { job_id: job.id, site_id: site.id, reported: nOut, system: out.length, codes: out });
    }
    // Một lượt đổi thẻ thực tế thay cho các lượt còn treo của cùng BO tới hôm nay (lượt trễ hôm trước, lượt của hôm nay, hoặc lượt khác nằm cùng chuyến): đóng chung, không tính điểm thêm.
    for (const o of store.jobs.find({ type: 'card_swap', site_id: job.site_id, status: OPEN })) {
      if (o.id === job.id) continue;
      const sameTrip = opt.viaTask && o.task_id === opt.task_id;
      if (!sameTrip && (o.task_id || o.date > today())) continue; // lượt trễ làm vào ngày đổi kế tiếp đóng luôn lượt của hôm nay
      const hr = heldRecon(o.id);
      if (hr && !hr.data.jobs.includes(job.id)) continue; // lượt đang chờ Lead đối chiếu: để Lead chốt
      complete(o, actor, { auto: true, summary: `Đổi chung lượt ${job.code}` }, { raw: true, by: null, byName: 'Hệ thống' });
    }
    if (out.length || collected.length) changed('cards');
    return { cards_out: out, cards_in: collected, count_out: nOut, count_in: nIn, summary: `Giao ${nOut} thẻ, thu ${nIn} thẻ` };
  };
  /**
   * Đổi kit hỏng tại BO: kit thay thế sang BO, kit hỏng về Tech. CM5 / iPhone đổi mã thì sinh việc đổi QR cho Tech.
   * Kit thay phải cùng loại. Làm tay: kit thay phải đang sẵn sàng tại VP (không gán yêu cầu, không nằm trong chuyến nào);
   * qua chuyến: đúng kit đã chọn cho việc này khi xếp chuyến (đang theo FO). Làm tay thì đếm phụ kiện của kit hỏng ngay lúc đổi.
   */
  handlers.swap_faulty = (job, actor, res, opt) => {
    let old = kitOf(job);
    const site = store.sites.get(job.site_id);
    // BO đang thu hồi / đã kết thúc: kit lỗi về kho cùng đợt thu hồi, không đưa kit mới tới nữa (qua chuyến thì FO đã đổi thật, vẫn ghi theo thực tế).
    // Việc chờ Lead đối chiếu sau chuyến: Lead ghi đúng lần đổi FO đã làm thật, kể cả khi BO vừa chuyển đang thu hồi.
    if (!opt.viaTask && !heldRecon(job.id) && site && !['live', 'paused'].includes(site.ops_status)) fail(409, 'bo_ending', `${boLabel(site.name)} đang thu hồi thiết bị: kit lỗi về kho cùng đợt thu hồi, không cần đổi kit nữa. Lead huỷ việc này.`);
    const nk = H.stock.kitOrFail(res.new_kit_id ?? fail(400, 'kit_required', 'Chọn kit thay thế.'));
    if (nk.kind !== old.kind) fail(409, 'bad_kit', `Kit thay phải cùng loại với kit hỏng ${old.code} (${KIT_KINDS[old.kind] || old.kind}).`);
    const okState = opt.viaTask ? ['ready', 'delivering'].includes(nk.status) : nk.status === 'ready';
    if (!okState || nk.request_id) fail(409, 'bad_kit', `Kit ${nk.code} không sẵn sàng tại văn phòng để thay.`);
    const tk = kitTrip(nk.id);
    if (tk && tk.id !== opt.task_id) fail(409, 'in_trip', `Kit ${nk.code} đã được xếp cho chuyến ${tk.code} của FO. Chọn kit khác.`);
    for (const k of [nk, old]) if (heldFor('kits', k.id, job.id)) fail(409, 'held', `Kit ${k.code} đang chờ Logistic Lead đối chiếu số lượng sau chuyến (mục Đối chiếu).`);
    if (old.status !== 'at_bo') fail(409, 'bad_state', `Kit ${old.code} không còn ở BO.`);
    H.stock.setKit(nk, 'at_bo', actor, `Kit ${nk.code} thay cho ${old.code} tại ${site.name}.`, { site_id: site.id, request_id: old.request_id });
    let rec = null;
    if (opt.viaTask) {
      H.stock.setKit(old, 'recovering', actor, `FO mang kit hỏng ${old.code} về từ ${site.name}.`);
      ensure({ type: 'receive_field', kit_id: old.id, title: `Nhận kit hỏng ${old.code} về kho, chuyển Tech sửa`, dedupe: `recv:${old.id}:${H.uniq()}`, incident_id: job.incident_id }, actor);
    } else {
      // Logistics tự đổi và mang kit hỏng về: đếm phụ kiện thực nhận ngay lúc này (thiếu thì ghi mất và đưa vào Đối chiếu).
      rec = H.stock.reconcileAcc(old, res.acc, actor, { job_id: job.id, site_id: site.id, site_name: site.name });
      old = store.kits.get(old.id);
      H.stock.setKit(old, 'at_tech', actor, `Kit hỏng ${old.code} đã thu về từ ${site.name}, chuyển Tech sửa.`, { site_id: null, request_id: null });
      ensure({ type: 'repair', kit_id: old.id, title: `Sửa kit ${old.code}`, note: old.fault || job.note, dedupe: `repair:${old.id}:open`, incident_id: job.incident_id }, actor);
    }
    const codes = (k, tp) => H.stock.kitDevices(k.id).filter((d) => d.type === tp).map((d) => d.code).sort().join(',');
    if (['cm5', 'iphone'].some((tp) => codes(old, tp) !== codes(nk, tp))) {
      // Khoá theo lần đổi kit: đổi qua lại cùng hai kit vẫn có việc đổi QR mới cho mỗi lần.
      ensure({ type: 'qr_change', site_id: site.id, kit_id: nk.id, title: `Đổi QR tại ${site.name} (kit ${old.code} → ${nk.code})`, dedupe: `qr:${site.id}:${job.id}` }, actor);
    }
    return { old_kit: old.code, new_kit: nk.code, acc_short: rec ? rec.short : [], summary: `Đã thay ${old.code} bằng ${nk.code}${rec && rec.short.length ? `, kit hỏng thiếu ${rec.short.join(', ')}` : ''}` };
  };
  /** Thu hồi: thu được từng phần. Kit nào còn ở BO thì việc thu hồi mới được tạo cho phần còn lại. */
  handlers.recover = (job, actor, res, opt) => {
    let site = store.sites.get(job.site_id);
    // Thu sớm trước ngày kết thúc đã hẹn: BO chuyển "đang thu hồi" trước (việc đổi thẻ, hỗ trợ còn mở được dọn như kết thúc thường).
    const endReq = job.request_id ? store.requests.get(job.request_id) : null;
    if (['live', 'paused'].includes(site.ops_status) && endReq && endReq.kind === 'end' && endReq.status === 'scheduled') { H.outlets.beginEnding(site, endReq, actor); site = store.sites.get(site.id); }
    const atBo = store.kits.find({ site_id: site.id, status: 'at_bo' });
    const pick = Array.isArray(res.kit_ids) && res.kit_ids.length ? idList(res.kit_ids, 200) : atBo.map((k) => k.id);
    const got = atBo.filter((k) => pick.includes(k.id));
    if (!got.length && atBo.length) fail(400, 'kit_required', 'Chọn ít nhất một kit đã thu.');
    for (const k of got) if (heldFor('kits', k.id, job.id)) fail(409, 'held', `Kit ${k.code} đang chờ Logistic Lead đối chiếu số lượng sau chuyến (mục Đối chiếu).`);
    for (const c of store.cards.find({ site_id: site.id, status: 'at_bo' })) if (heldFor('cards', c.code, job.id)) fail(409, 'held', `Thẻ ${c.code} đang chờ Logistic Lead đối chiếu số lượng sau chuyến (mục Đối chiếu).`);
    for (const k of got) {
      const sw = store.jobs.find({ type: 'swap_faulty', kit_id: k.id, status: OPEN }, { limit: 1 })[0];
      if (sw && !(opt.task_id && sw.task_id === opt.task_id)) failIfInTrip({ id: sw.id }, `Việc đổi kit hỏng ${k.code}`);
      if (sw) cancelFor({ id: sw.id }, actor, `Kit ${k.code} đã thu hồi; kit lỗi về kho chuyển Tech sửa`);
    }
    const accBy = res.acc_by_kit && typeof res.acc_by_kit === 'object' ? res.acc_by_kit : {};
    for (const k of got) {
      if (opt.viaTask) H.stock.setKit(k, 'recovering', actor, `FO thu kit ${k.code} tại ${site.name}, đang mang về.`);
      else {
        // Logistics tự thu và nhận về kho: đếm phụ kiện thực nhận ngay lúc này (nếu có nhập).
        H.stock.reconcileAcc(k, accBy[k.id] ?? accBy[String(k.id)], actor, { job_id: job.id, site_id: site.id, site_name: site.name });
        receiveField(store.kits.get(k.id), actor, `Logistics thu kit ${k.code} tại ${site.name} và nhận về kho.`);
      }
    }
    if (opt.viaTask) for (const k of got) ensure({ type: 'receive_field', kit_id: k.id, title: `Nhận kit ${k.code} thu hồi về kho`, dedupe: `recv:${k.id}:${H.uniq()}` }, actor);
    // Thẻ đang ở BO cũng thu về.
    for (const c of store.cards.find({ site_id: site.id, status: 'at_bo' })) store.cards.update(c.id, { status: opt.viaTask ? 'with_fo' : 'returned', task_id: opt.viaTask ? opt.task_id : null, since: now(), bo_out: now(), updated_at: now() });
    const left = atBo.length - got.length;
    if (left > 0) ensure({ type: 'recover', site_id: site.id, request_id: job.request_id, title: `Thu hồi ${left} kit còn lại tại ${site.name}`, dedupe: `recover:${site.id}:rest:${H.uniq()}`, due_at: now() + 24 * 3600000 }, actor);
    H.outlets.maybeEnded(site.id, actor);
    return { kits: got.map((k) => k.code), left, summary: `Thu ${got.length} kit${left ? `, còn ${left} kit chưa thu` : ''}` };
  };
  /** Kit thu hồi về tới kho: có thiết bị hỏng hoặc kit đang mang cờ hỏng thì sang Tech sửa, không thì chờ Tech check-in. */
  function receiveField(kit, actor, text) {
    const faulty = !!kit.fault || H.stock.kitDevices(kit.id).some((d) => d.cond !== 'ok');
    if (faulty) {
      H.stock.setKit(kit, 'at_tech', actor, text + ' Kit có lỗi nên chuyển Tech sửa.', { site_id: null, request_id: null, checked_at: null });
      ensure({ type: 'repair', kit_id: kit.id, title: `Sửa kit ${kit.code}`, note: kit.fault || '', dedupe: `repair:${kit.id}:open` }, actor);
    } else {
      H.stock.setKit(kit, 'returned', actor, text, { site_id: null, request_id: null, checked_at: null });
      ensure({ type: 'checkin', kit_id: kit.id, title: `Check-in kit ${kit.code} thu hồi`, dedupe: `checkin:${kit.id}:${H.uniq()}` }, actor);
    }
  }
  /** Nhận kit thu hồi về kho. Đếm phụ kiện thực nhận (res.acc): thiếu thì trừ tổng kho và đưa vào Đối chiếu. */
  handlers.receive_field = (job, actor, res) => {
    const kit = kitOf(job);
    if (kit.status !== 'recovering') fail(409, 'bad_state', `Kit ${kit.code} không ở trạng thái đang thu hồi.`);
    const rec = H.stock.reconcileAcc(kit, res.acc, actor, { job_id: job.id, site_id: kit.site_id, site_name: H.siteName(kit.site_id) });
    receiveField(store.kits.get(kit.id), actor, `${actor.name} nhận kit ${kit.code} về kho.`);
    return { summary: rec && rec.short.length ? `Đã nhận về kho, thiếu ${rec.short.join(', ')}` : 'Đã nhận về kho', acc_short: rec ? rec.short : [], acc_extra: rec ? rec.extra : [] };
  };
  /** Giao bổ sung phụ kiện cho kit đang ở BO: phụ kiện lấy từ số rảnh trong kho và cộng vào kit (tồn kho tự cập nhật). */
  handlers.deliver_acc = (job, actor, res) => {
    const kit = kitOf(job);
    if (kit.status !== 'at_bo' || kit.site_id !== job.site_id) fail(409, 'bad_state', `Kit ${kit.code} không còn ở ${H.siteName(job.site_id)}.`);
    const r = job.request_id ? store.requests.get(job.request_id) : null;
    const give = res.acc !== undefined ? H.stock.accInput(res.acc) : { ...((r && r.need && r.need.acc) || {}) };
    if (!Object.keys(give).length) fail(400, 'acc_required', 'Nhập số phụ kiện đã giao.');
    const next = { ...(kit.acc || {}) };
    for (const [t, q] of Object.entries(give)) next[t] = (next[t] || 0) + q;
    H.stock.checkAccStock(kit.acc, next, job.id); // phần FO đang mang cho chính việc này đã giữ chỗ, không trừ hai lần
    store.kits.update(kit.id, { acc: next, updated_at: now() });
    const types = H.stock.typeMap();
    const text = Object.entries(give).map(([t, q]) => `${q} ${(types.get(t) || {}).name || t}`).join(', ');
    log('kit', kit.id, 'acc', `${actor ? actor.name : 'Hệ thống'} giao bổ sung ${text} cho kit ${kit.code} tại ${H.siteName(kit.site_id)}.`, actor, give);
    // Giao ít hơn yêu cầu: yêu cầu hỗ trợ còn mở với phần còn lại và có việc giao tiếp, không coi là đã xử lý xong.
    const rest = {};
    for (const [t, q] of Object.entries((r && r.need && r.need.acc) || {})) { const left = (int(q, 0, 1e6) || 0) - (give[t] || 0); if (left > 0) rest[t] = left; }
    let restText = '';
    if (r && r.kind === 'support' && Object.keys(rest).length) {
      restText = Object.entries(rest).map(([t, q]) => `${q} ${(types.get(t) || {}).name || t}`).join(', ');
      store.requests.update(r.id, { need: { ...r.need, acc: rest }, updated_at: now() });
      log('request', r.id, 'partial', `Yêu cầu ${r.code}: đã giao ${text} cho kit ${kit.code}, còn ${restText} giao sau.`, actor);
      ensure({ type: 'deliver_acc', site_id: job.site_id, kit_id: kit.id, request_id: r.id, title: `Giao ${restText} còn lại cho kit ${kit.code} tại ${H.siteName(job.site_id)}`, note: job.note, dedupe: `acc:${r.id}:rest:${H.uniq()}` }, actor);
      notify({ ids: [r.sale_id, r.created_by] }, 'info', 'support', `Yêu cầu hỗ trợ ${r.code} tại ${boLabel(H.siteName(r.site_id))}: đã giao ${text}, còn ${restText} Logistics giao sau.`, `request:${r.id}`);
    }
    changed('kits', 'acc');
    return { acc: give, rest, summary: `Đã giao ${text}${restText ? `, còn ${restText} giao sau` : ''}` };
  };
  handlers.checkin = (job, actor, res) => {
    const kit = kitOf(job);
    if (kit.status !== 'returned') fail(409, 'bad_state', `Kit ${kit.code} không ở trạng thái chờ check-in.`);
    const bad = applyDeviceResults(kit, res.devices, actor);
    const pass = res.pass !== false && !bad.length;
    if (pass) {
      H.stock.setKit(kit, 'tech_done', actor, `${actor.name} check-in kit ${kit.code}: đạt.`, { checked_at: now(), checked_by: actor.id, fault: null });
      ensure({ type: 'receive_back', kit_id: kit.id, title: `Nhận lại kit ${kit.code} từ Tech`, dedupe: `back:${kit.id}:${H.uniq()}` }, actor);
    } else {
      H.stock.setKit(kit, 'at_tech', actor, `${actor.name} check-in kit ${kit.code}: không đạt (${bad.join(', ') || cleanStr(res.note, 120)}).`, { fault: cleanStr(res.note, 200) || `Không đạt check-in: ${bad.join(', ')}` });
      ensure({ type: 'repair', kit_id: kit.id, title: `Sửa kit ${kit.code}`, note: res.note, dedupe: `repair:${kit.id}:open` }, actor);
    }
    return { pass, bad, note: cleanStr(res.note, 300), summary: pass ? 'Đạt' : 'Không đạt, chuyển sửa' };
  };
  handlers.repair = (job, actor, res) => {
    const kit = kitOf(job);
    if (kit.status !== 'at_tech') fail(409, 'bad_state', `Kit ${kit.code} không ở Tech.`);
    applyDeviceResults(kit, res.devices, actor);
    const c = H.stock.completeness(kit, H.stock.kitDevices(kit.id));
    if (!c.complete) fail(409, 'incomplete', c.faulty ? 'Kit vẫn còn thiết bị hỏng. Đánh dấu đã sửa từng thiết bị, hoặc gỡ thiết bị hỏng và gắn thiết bị thay.' : `Kit thiếu: ${c.missing.join(', ')}. Gắn thiết bị thay rồi báo xong.`);
    H.stock.setKit(kit, 'tech_done', actor, `${actor.name} sửa xong kit ${kit.code}${res.note ? `: ${cleanStr(res.note, 200)}` : ''}.`, { checked_at: now(), checked_by: actor.id, fault: null });
    ensure({ type: 'receive_back', kit_id: kit.id, title: `Nhận lại kit ${kit.code} từ Tech`, dedupe: `back:${kit.id}:${H.uniq()}` }, actor);
    return { note: cleanStr(res.note, 300), cause: cleanStr(res.cause, 80), summary: 'Đã sửa xong' };
  };
  handlers.receive_back = (job, actor) => {
    const kit = kitOf(job);
    if (kit.status !== 'tech_done') fail(409, 'bad_state', `Kit ${kit.code} không ở trạng thái chờ nhận lại.`);
    const c = H.stock.completeness(kit, H.stock.kitDevices(kit.id));
    if (!c.complete) { // phòng khi thiết bị bị gỡ / đổi tình trạng sau khi Tech xong: nhận về nhưng kit phải bổ sung và kiểm lại
      H.stock.setKit(kit, 'preparing', actor, `${actor.name} nhận lại kit ${kit.code} từ Tech nhưng kit ${c.faulty ? 'có thiết bị không dùng được' : `thiếu ${c.missing.join(', ')}`}; cần bổ sung rồi gửi kiểm.`, { checked_at: null, checked_by: null });
      return { summary: 'Đã nhận, kit cần bổ sung thiết bị' };
    }
    // Kit đã được gán cho một yêu cầu trong lúc ở Tech (Tech vừa kiểm đạt khi check-in / sửa): giữ cho yêu cầu đó luôn.
    H.stock.setKit(kit, kit.request_id ? 'reserved' : 'ready', actor, `${actor.name} nhận lại kit ${kit.code} từ Tech; kit ${kit.request_id ? `đã kiểm, giữ cho yêu cầu ${(store.requests.get(kit.request_id) || {}).code || ''}` : 'sẵn sàng'}.`);
    if (kit.request_id) H.outlets.refreshRequest(kit.request_id, actor);
    return { summary: kit.request_id ? 'Kit đã kiểm, giữ cho yêu cầu' : 'Kit sẵn sàng' };
  };
  handlers.stock_check = (job, actor, res) => {
    const counts = {};
    for (const k of store.kits.find({ status: { ne: 'retired' } })) counts[k.status] = (counts[k.status] || 0) + 1;
    const note = cleanText(res.note, 800);
    const diff = cleanText(res.diff, 800);
    if (diff) H.recon('stock_check', 'logistics', 'high', 'stock', `stock:${job.id}`, `Kiểm kho ${job.date}: ${actor.name} ghi nhận chênh lệch — ${diff}`, { job_id: job.id, counts });
    return { counts, note, diff, summary: diff ? 'Có chênh lệch' : 'Khớp' };
  };
  handlers.qr_change = (job, actor, res) => ({ note: cleanText(res.note, 300), summary: 'Đã đổi QR' });
  handlers.manual = (job, actor, res) => ({ note: cleanText(res.note, 500), summary: cleanStr(res.note, 80) });
  // Việc thẻ đi theo phiếu: đóng bằng thao tác trên phiếu / thẻ để số thẻ luôn khớp, không bấm "xong" chung.
  handlers.cards_receive = handlers.cards_back = () => fail(409, 'use_flow', 'Nhận thẻ theo phiếu bàn giao: đánh dấu các thẻ đã nhận ở mục Thẻ; việc tự đóng khi nhận xong.');
  handlers.cards_upload = () => fail(409, 'use_flow', 'Việc tự đóng khi mọi thẻ của phiếu đã nhập dung lượng (hoặc được ghi hỏng / thất lạc).');
  handlers.cards_return = () => fail(409, 'use_flow', 'Lập phiếu trả Logistics với các thẻ đã nhập ở mục Thẻ; việc tự đóng khi mọi thẻ đã nhập của phiếu đã vào phiếu trả.');
  /** Phút chuẩn khi đóng việc: việc giao tay dùng phút chuẩn Lead đặt lúc tạo (lưu ở result.std_min), loại khác theo bảng định mức. */
  function stdFor(job, out) { return job.type === 'manual' && job.result && job.result.std_min !== undefined ? job.result.std_min : stdOf(job.type, out, job.team); }

  // ───────────────────────── Lịch: đổi thẻ hằng ngày, kiểm kho ─────────────────────────
  function swapTitle(site, date) { return `Đổi thẻ ${site.name} ${date.slice(8, 10)}/${date.slice(5, 7)}${site.swap_from ? ` (${site.swap_from}–${site.swap_to || ''})` : ''}`; }
  function genSwaps(site, actor) {
    const d0 = today(), n = H.cfg().swapLeadDays;
    for (let i = 0; i <= n; i++) {
      const d = addDays(d0, i);
      if (!H.outlets.swapDue(site, d)) continue;
      const kits = store.kits.count({ site_id: site.id, status: 'at_bo' });
      if (!kits) continue; // BO chưa có máy (hoặc đã thu hết) thì chưa có thẻ để đổi
      ensure({ type: 'card_swap', site_id: site.id, date: d, show_date: d, title: swapTitle(site, d), dedupe: `swap:${site.id}:${d}`, note: `${kits} kit · ${kits * H.cfg().cardsPerKit} thẻ` }, actor);
    }
  }
  /** Lịch đổi thẻ của BO vừa đổi (hoặc BO tạm nghỉ / kết thúc): đồng bộ việc từ hôm nay. */
  function syncSwaps(site, actor) {
    const d0 = today();
    // BO không còn quay (tạm nghỉ, kết thúc): mọi việc đổi thẻ chưa lên chuyến đều huỷ, kể cả việc trễ hay đang làm tay; thẻ ở BO được thu theo việc thu hồi.
    // Lượt đổi thẻ đang chờ Logistic Lead đối chiếu sau chuyến (FO có thể đã đổi thật) giữ lại như lượt trong chuyến: Lead làm tay theo thực tế.
    if (site.ops_status !== 'live') cancelFor({ type: 'card_swap', site_id: site.id, task_id: null }, actor, `BO ${site.ops_status === 'paused' ? 'tạm nghỉ' : 'không còn ghi hình'}`, { keepHeld: true });
    for (const j of store.jobs.find({ type: 'card_swap', site_id: site.id, status: 'open', task_id: null, date: { gte: d0 } })) {
      if (heldRecon(j.id)) continue;
      if (!H.outlets.swapDue(site, j.date)) cancelFor({ id: j.id }, actor, 'Lịch đổi thẻ của BO thay đổi');
      else store.jobs.update(j.id, { due_at: site.swap_to ? atTime(j.date, site.swap_to, off) : endOfDay(j.date), title: swapTitle(site, j.date), al_due: 0 });
    }
    genSwaps(site, actor);
    changed('jobs');
  }

  // ───────────────────────── Chuyến FO (Rider Live) ─────────────────────────
  /** Gom việc ngoài hiện trường thành một chuyến cho FO: mỗi BO một điểm dừng; điểm đầu là văn phòng nếu chọn. */
  R('POST', '/api/hub/dispatch', ['admin', 'lead', 'logistic'], ({ user, b }) => {
    const ids = idList(b.job_ids, 15);
    if (!ids.length) fail(400, 'no_jobs', 'Chọn ít nhất một việc.');
    const jobs = ids.map((id) => jobOrFail(id));
    for (const j of jobs) {
      if (!FIELD_TYPES.includes(j.type) || j.team !== 'logistics') fail(400, 'not_field', `${j.code} không phải việc ngoài hiện trường.`);
      openOrFail(j);
      if (j.task_id) { const tk = store.tasks.get(j.task_id); if (tk && TASK_OPEN.includes(tk.status)) fail(409, 'in_task', `${j.code} đang nằm trong chuyến ${tk.code}.`); }
      if (heldRecon(j.id)) fail(409, 'held', `${j.code} đang chờ Logistic Lead đối chiếu số lượng sau chuyến trước (mục Đối chiếu). Lead làm tay việc này theo mã thực tế.`);
      if (!j.site_id) fail(400, 'no_site', `${j.code} chưa gắn BO.`);
      const s = store.sites.get(j.site_id);
      if (!s || s.lat === null || s.lon === null) fail(400, 'no_coord', `${s ? boLabel(s.name) : 'BO'} chưa có toạ độ. Mở BO, dán toạ độ hoặc link Google Maps rồi thử lại.`);
    }
    const swapKits = b.swap_kits && typeof b.swap_kits === 'object' ? b.swap_kits : {};
    const cardsOut = b.cards_out && typeof b.cards_out === 'object' ? b.cards_out : {};
    // Thẻ để sẵn trong kit giao launch, ghi riêng khi cùng điểm có lượt đổi thẻ (cards_out của điểm đó là thẻ đổi).
    const launchCards = b.launch_cards && typeof b.launch_cards === 'object' ? b.launch_cards : {};
    const cpk = H.cfg().cardsPerKit;
    const bySite = new Map();
    for (const j of jobs) { if (!bySite.has(j.site_id)) bySite.set(j.site_id, []); bySite.get(j.site_id).push(j); }
    const stops = [], hubs = [];
    if (b.office_site_id) {
      const o = store.sites.get(K.idOf(b.office_site_id));
      if (!o || !o.active || o.lat === null) fail(400, 'bad_office', 'Điểm xuất phát không hợp lệ.');
      stops.push({ site_id: o.id, note: 'Nhận kit / thẻ tại văn phòng' }); hubs.push(null);
    }
    const kitsOutAll = [], cardsAll = [], accNeed = {};
    /** Thẻ mới mang đi cho một điểm: sẵn sàng tại VP, chưa thuộc chuyến khác, không chọn cho hai điểm. */
    const pickCards = (siteId, from = cardsOut) => {
      const codes = H.codesOf(from[siteId] || from[String(siteId)] || [], 200);
      for (const c of codes) {
        const cd = store.cards.find({ code: c }, { limit: 1 })[0];
        if (!cd || cd.status !== 'office') fail(409, 'card_busy', `Thẻ ${c} không ở trạng thái sẵn sàng tại VP.`);
        if (cd.task_id) { const tk = store.tasks.get(cd.task_id); if (tk && TASK_OPEN.includes(tk.status)) fail(409, 'card_busy', `Thẻ ${c} đã được chọn cho chuyến ${tk.code}.`); }
        failIfCardInTrip(c);
        if (cardsAll.includes(c)) fail(409, 'card_busy', `Thẻ ${c} được chọn cho hai điểm.`);
        cardsAll.push(c);
      }
      return codes;
    };
    /** Thẻ đang ở BO mà điểm này sẽ thu về: không được nằm trong kế hoạch thu của chuyến khác. */
    const cardsAtBo = (siteId) => { const list = store.cards.find({ site_id: siteId, status: 'at_bo' }, { order: 'code' }).map((c) => c.code); for (const c of list) failIfCardInTrip(c); return list; };
    const accPlanned = H.stock.accPlanned(); // phụ kiện các chuyến khác đã xếp nhưng chưa chạy (chuyến đang chạy đã trừ khỏi số rảnh)
    for (const [siteId, list] of bySite) {
      // Mỗi việc ghi riêng phần kit / thẻ của nó (per), để gỡ một việc khỏi chuyến thì trừ đúng phần của việc đó.
      const h = { jobs: list.map((j) => j.id), per: {} };
      const site = store.sites.get(siteId);
      // Thẻ chọn cho điểm (cards_out): dùng cho lượt đổi thẻ; điểm chỉ giao launch thì là thẻ đi trong kit. Có cả hai thì thẻ trong kit ghi ở launch_cards.
      let siteCards = !list.some((o) => o.type === 'card_swap'), launchLeft = true;
      for (const j of list) {
        const x = { kits_out: [], kits_in: [], cards_out: [], cards_in: [], co: 0, ci: 0, dOut: 0, dIn: 0, note: '' };
        if (j.type === 'deliver') {
          const ks = store.kits.find({ request_id: j.request_id, status: 'reserved' });
          for (const k of ks) failIfKitInTrip(k);
          const codes = siteCards ? pickCards(siteId) : launchLeft ? pickCards(siteId, launchCards) : [];
          siteCards = false; launchLeft = false;
          x.kits_out = ks.map((k) => k.id); x.dOut = ks.length; x.cards_out = codes; x.co = codes.length || ks.length * cpk;
          x.note = `Giao ${ks.length} kit: ${ks.map((k) => k.code).join(', ')}${x.co ? ` · ${x.co} thẻ trong kit${codes.length ? '' : ' (chưa ghi mã)'}` : ''}`;
        }
        if (j.type === 'card_swap' && list.some((o) => o.type === 'card_swap' && o.id !== j.id && list.indexOf(o) < list.indexOf(j))) {
          x.note = 'Đổi thẻ (chung lượt)'; // BO có nhiều lượt đổi thẻ trong chuyến: thẻ và số lượng tính một lần ở lượt đầu
        } else if (j.type === 'card_swap') {
          const nKits = store.kits.count({ site_id: siteId, status: 'at_bo' });
          const codes = pickCards(siteId);
          // Đổi thẻ phải có mã thẻ mới: không có mã thì hệ thống không biết thẻ nào đang ở BO, thẻ thu về không gửi Tech được.
          if (!codes.length && nKits * cpk > 0) fail(400, 'cards_required', `${boLabel(site.name)}: nhập mã thẻ mới mang đi đổi (BO có ${nKits} kit, cần khoảng ${nKits * cpk} thẻ).`);
          const atBo = cardsAtBo(siteId);
          x.cards_out = codes; x.cards_in = atBo; x.co = codes.length; x.ci = atBo.length; x.note = 'Đổi thẻ';
        }
        if (j.type === 'swap_faulty') {
          const nk = H.stock.kitOrFail(swapKits[j.id] ?? swapKits[String(j.id)] ?? fail(400, 'kit_required', `Chọn kit thay thế cho ${j.code}.`));
          if (nk.status !== 'ready' || nk.request_id) fail(409, 'bad_kit', `Kit ${nk.code} không sẵn sàng để thay.`);
          failIfKitInTrip(nk);
          if (kitsOutAll.includes(nk.id) || Object.values(h.per).some((y) => y.kits_out.includes(nk.id))) fail(409, 'bad_kit', `Kit ${nk.code} đã được chọn cho việc khác trong chuyến.`);
          const old = store.kits.get(j.kit_id) || {};
          if (old.id) failIfKitInTrip(old);
          if (old.kind && nk.kind !== old.kind) fail(409, 'bad_kit', `Kit thay phải cùng loại với kit hỏng (${old.code}).`);
          x.kits_out = [nk.id]; x.kits_in = [j.kit_id]; x.swap = nk.id; x.dOut = 1; x.dIn = 1; x.note = `Đổi kit hỏng ${old.code} bằng ${nk.code}`;
        }
        if (j.type === 'recover') {
          const ks = store.kits.find({ site_id: siteId, status: 'at_bo' });
          for (const k of ks) failIfKitInTrip(k);
          const atBo = cardsAtBo(siteId); // thẻ đang ở BO thu cùng đợt thu hồi
          x.kits_in = ks.map((k) => k.id); x.dIn = ks.length; x.cards_in = atBo; x.ci = atBo.length; x.note = `Thu hồi ${ks.length} kit${atBo.length ? `, ${atBo.length} thẻ` : ''}`;
        }
        if (j.type === 'deliver_acc') {
          const r = j.request_id ? store.requests.get(j.request_id) : null, types = H.stock.typeMap();
          // FO chỉ mang đi phụ kiện kho còn rảnh (trừ phần các chuyến khác đã xếp); thiếu thì ghi nhập kho trước, tránh giao xong mà hệ thống không trừ được.
          for (const [t, q] of Object.entries((r && r.need && r.need.acc) || {})) {
            accNeed[t] = (accNeed[t] || 0) + q;
            const free = H.stock.accFree(t) - (accPlanned[t] || 0);
            if (free < accNeed[t]) fail(409, 'acc_short', `Kho chỉ còn ${Math.max(0, free)} ${(types.get(t) || {}).name || t} rảnh${accPlanned[t] ? ' (đã trừ phần các chuyến khác sẽ mang đi)' : ''}, chuyến cần ${accNeed[t]}. Ghi "Nhập thêm" ở mục Phụ kiện nếu thực tế có, hoặc bỏ ${j.code} khỏi chuyến.`);
          }
          x.note = `Giao phụ kiện cho kit ${(store.kits.get(j.kit_id) || {}).code || ''}: ${Object.entries((r && r.need && r.need.acc) || {}).map(([t, q]) => `${q} ${(types.get(t) || {}).name || t}`).join(', ')}`;
        }
        if (j.type === 'manual') x.note = j.title;
        // Một kit chỉ được thu một lần ở một điểm (ví dụ đổi kit hỏng và thu hồi cùng kit): FO không thể mang về hai thiết bị cho một kit.
        for (const kid of x.kits_in) {
          const other = list.find((o) => o.id !== j.id && ((h.per[o.id] || {}).kits_in || []).includes(kid));
          if (other) { const kc = (store.kits.get(kid) || {}).code || ''; fail(409, 'same_kit', `${boLabel(site.name)}: kit ${kc} vừa nằm trong ${other.code} vừa nằm trong ${j.code}, FO không thu cùng một kit hai lần. ${[other, j].some((o) => o.type === 'recover') ? 'BO sắp kết thúc thì kit lỗi về cùng đợt thu hồi: chỉ đưa việc thu hồi vào chuyến (Lead huỷ việc đổi kit nếu không cần nữa).' : 'Bỏ một việc khỏi chuyến.'}`); }
        }
        h.per[j.id] = x;
      }
      const sum = hubSum(h);
      kitsOutAll.push(...sum.hub.kits_out);
      stops.push({ site_id: siteId, cards_out: sum.co, cards_in: sum.ci, dev_out: sum.dOut, dev_in: sum.dIn, note: sum.note });
      hubs.push(sum.hub);
    }
    if (stops.length > 15) fail(400, 'too_many_stops', 'Một chuyến tối đa 15 điểm.');
    let view;
    store.tx(() => {
      view = K.tasks.createTask({ title: cleanStr(b.title, 80) || undefined, fo_id: b.fo_id || null, date: b.date || today(), start_time: b.start_time, round_trip: !!b.round_trip && !!b.office_site_id, note: b.note, stops }, user);
      const st = store.stops.find({ task_id: view.id }, { order: 'seq' });
      hubs.forEach((h, i) => { if (h) store.stops.update(st[i].id, { hub: h }); });
      for (const j of jobs) {
        store.jobs.update(j.id, { task_id: view.id, status: 'doing', started_at: j.started_at || now(), ...(j.assignee_id ? clockPatch(j, now()) : holderPatch(j, user.id, 'self')) });
        log('job', j.id, 'dispatch', `${user.name} đưa ${j.code} vào chuyến ${view.code}${view.fo ? ` của ${view.fo.name}` : ''}.`, user);
      }
      for (const c of cardsAll) { const cd = store.cards.find({ code: c }, { limit: 1 })[0]; if (cd) store.cards.update(cd.id, { task_id: view.id, updated_at: now() }); }
    });
    changed('jobs');
    return { task: K.tasks.taskView(store.tasks.get(view.id)) };
  });
  /** Gộp phần của từng việc trong một điểm thành danh sách chung (kit mang đi, kit thu về, thẻ mang đi) và số dự kiến. */
  function hubSum(h) {
    const per = h.per || {}, ids = (h.jobs || []).filter((id) => per[id]);
    const uniq = (k) => [...new Set(ids.flatMap((id) => per[id][k] || []))];
    const hub = { jobs: h.jobs || [], per, kits_out: uniq('kits_out'), kits_in: uniq('kits_in'), cards_out: uniq('cards_out'), cards_in: uniq('cards_in'), swap: Object.fromEntries(ids.filter((id) => per[id].swap).map((id) => [id, per[id].swap])) };
    const add = (k) => ids.reduce((a, id) => a + (per[id][k] || 0), 0);
    return { hub, co: add('co'), ci: Math.max(0, ...ids.map((id) => per[id].ci || 0)), dOut: add('dOut'), dIn: add('dIn'), note: ids.map((id) => per[id].note).filter(Boolean).join(' · ').slice(0, 200) };
  }
  /** Gỡ một việc khỏi chuyến: trừ phần kit / thẻ của việc đó khỏi điểm dừng; kit / thẻ đang mang đi của việc đó trở về kho. */
  function detachFromTask(j) {
    const taskId = j.task_id, emptied = [];
    store.jobs.update(j.id, { task_id: null, status: j.status === 'cancelled' ? 'cancelled' : 'open' });
    for (const s of store.stops.find({ task_id: taskId })) {
      if (!s.hub || !(s.hub.jobs || []).includes(j.id)) continue;
      const mine = (s.hub.per || {})[j.id] || { kits_out: [], cards_out: [] };
      const per = { ...(s.hub.per || {}) };
      delete per[j.id];
      const sum = hubSum({ jobs: s.hub.jobs.filter((x) => x !== j.id), per });
      const patch = { hub: sum.hub };
      const open = s.status === 'pending' || s.status === 'arrived';
      if (open) Object.assign(patch, { exp_cards_out: sum.co, exp_cards_in: sum.ci, exp_dev_out: sum.dOut, exp_dev_in: sum.dIn, note: sum.note }); // ghi chú theo việc còn lại; không giữ ghi chú của việc đã gỡ
      store.stops.update(s.id, patch);
      if (open && !sum.hub.jobs.length) emptied.push(s.id);
      for (const kid of mine.kits_out || []) { const k = store.kits.get(kid); if (k && k.status === 'delivering' && !sum.hub.kits_out.includes(kid)) { H.stock.setKit(k, k.request_id ? 'reserved' : 'ready', null, `Kit ${k.code} không còn đi theo chuyến (việc ${j.code} đã gỡ khỏi chuyến); kit về kho.`); if (k.request_id && k.request_id !== j.request_id) H.outlets.refreshRequest(k.request_id, null); } }
      for (const c of mine.cards_out || []) { const cd = store.cards.find({ code: c }, { limit: 1 })[0]; if (cd && cd.task_id === taskId && !sum.hub.cards_out.includes(c) && ['office', 'with_fo'].includes(cd.status)) store.cards.update(cd.id, { status: 'office', task_id: null, updated_at: now() }); }
    }
    if (emptied.length) dropEmptyStops(taskId, emptied, j);
  }
  /**
   * Điểm không còn việc nào sau khi gỡ việc: chuyến chưa chạy thì bỏ điểm khỏi tuyến (FO không phải ghé, không được tính điểm giao nhận);
   * không còn điểm nào có việc thì huỷ chuyến. Chuyến đang chạy thì điểm được ghi "bỏ qua".
   */
  function dropEmptyStops(taskId, ids, j) {
    const tk = store.tasks.get(taskId);
    if (!tk || !TASK_OPEN.includes(tk.status)) return;
    const busyStop = (s) => !ids.includes(s.id) && s.hub && (s.hub.jobs || []).some((id) => { const x = store.jobs.get(id); return x && OPEN.includes(x.status) && x.task_id === taskId; });
    if (tk.status !== 'in_progress' && !store.stops.find({ task_id: taskId }).some(busyStop)) {
      K.tasks.cancelTask(tk, `Không còn việc nào trong chuyến (${j.code} đã rời chuyến)`, null);
      return;
    }
    K.tasks.dropStops(taskId, ids, `không còn việc tại điểm này (${j.code} đã rời chuyến)`);
  }
  /** Chuyến đang mở có chứa việc khớp điều kiện (ví dụ việc giao của một yêu cầu). */
  function tripOf(where) {
    for (const j of store.jobs.find({ ...where, status: OPEN })) {
      if (!j.task_id) continue;
      const tk = store.tasks.get(j.task_id);
      if (tk && TASK_OPEN.includes(tk.status)) return tk;
    }
    return null;
  }
  /** Chuyến đang mở có mang kit này đi (giao, đổi) hoặc thu kit này về. Điểm FO đã giao nhận mà BO chưa xác nhận vẫn tính là chưa xong. */
  function kitTrip(kitId) {
    return openTripWith((s) => (s.status === 'pending' || s.status === 'arrived' || (s.status === 'done' && s.bo_status === 'pending')) && ((s.hub.kits_out || []).includes(kitId) || (s.hub.kits_in || []).includes(kitId)));
  }
  /** Chuyến đang mở có mang thẻ này đi hoặc lên kế hoạch thu thẻ này về. */
  function cardTrip(code) {
    return openTripWith((s) => (s.status === 'pending' || s.status === 'arrived') && ((s.hub.cards_out || []).includes(code) || (s.hub.cards_in || []).includes(code)));
  }
  /**
   * Chuyến đang mở đầu tiên (theo thứ tự chuyến) có điểm Ops Hub thoả match. Điểm của mọi chuyến đang mở đọc trong một lượt, chỉ các cột cần
   * (lập chuyến kiểm từng kit, từng thẻ: trước đây mỗi lần kiểm đọc lại điểm của từng chuyến).
   */
  function openTripWith(match) {
    const tasks = store.tasks.find({ status: TASK_OPEN });
    if (!tasks.length) return null;
    const hit = new Set();
    for (let i = 0; i < tasks.length; i += 400) {
      for (const s of store.stops.find({ task_id: tasks.slice(i, i + 400).map((t) => t.id) }, { cols: ['task_id', 'status', 'bo_status', 'hub'] })) if (s.hub && match(s)) hit.add(s.task_id);
    }
    return tasks.find((t) => hit.has(t.id)) || null;
  }
  const HELD_JOB = 'Việc đang chờ Logistic Lead đối chiếu số lượng sau chuyến FO (mục Đối chiếu). Lead làm tay việc này theo mã kit / thẻ thực tế.';
  const HELD_MSG = (what) => `${what} đang chờ Logistic Lead đối chiếu số lượng sau chuyến FO (mục Đối chiếu). Lead xử lý dòng đó trước.`;
  function failIfKitInTrip(kit) {
    const tk = kitTrip(kit.id);
    if (tk) fail(409, 'in_trip', `Kit ${kit.code} đã được xếp vào chuyến ${tk.code} của FO. Gỡ việc khỏi chuyến (khi chuyến chưa bắt đầu) hoặc huỷ chuyến trước.`);
    if (heldFor('kits', kit.id)) fail(409, 'held', HELD_MSG(`Kit ${kit.code}`));
  }
  function failIfCardInTrip(code) {
    const tk = cardTrip(code);
    if (tk) fail(409, 'in_trip', `Thẻ ${code} đã được xếp vào chuyến ${tk.code} của FO. Gỡ việc khỏi chuyến (khi chuyến chưa bắt đầu) hoặc huỷ chuyến trước.`);
    if (heldFor('cards', code)) fail(409, 'held', HELD_MSG(`Thẻ ${code}`));
  }
  /** Chặn huỷ việc đang nằm trong chuyến đã bắt đầu: kit / thẻ / phụ kiện của việc đang trên xe hoặc đã giao; huỷ ở đây làm hệ thống lệch thực tế. */
  function failIfTripRunning(where, what) {
    for (const j of store.jobs.find({ ...where, status: OPEN })) {
      const tk = j.task_id ? store.tasks.get(j.task_id) : null;
      if (tk && tk.status === 'in_progress') fail(409, 'trip_running', `${what} đang nằm trong chuyến ${tk.code} đã bắt đầu, không huỷ được. Không làm được việc này thì FO bấm "Không giao được" ở điểm đó, hoặc Logistic Lead huỷ chuyến trước.`);
    }
  }
  /** Chặn thao tác làm thay đổi kit / yêu cầu khi việc liên quan đang nằm trong một chuyến FO chưa xong, hoặc đang chờ Lead đối chiếu sau chuyến. */
  function failIfInTrip(where, what) {
    const tk = tripOf(where);
    if (tk) fail(409, 'in_trip', `${what} đang nằm trong chuyến ${tk.code} của FO. Gỡ việc khỏi chuyến (khi chuyến chưa bắt đầu) hoặc huỷ chuyến trước.`);
    for (const j of store.jobs.find({ ...where, status: OPEN })) if (heldRecon(j.id)) fail(409, 'held', HELD_MSG(what));
  }
  // ── Việc giữ lại sau chuyến: số FO / BO báo khác kế hoạch → một dòng Đối chiếu count:<điểm> liệt kê việc, kit, thẻ liên quan. ──
  const isHeldRef = (r) => typeof r.ref === 'string' && r.ref.startsWith('count:') && r.data && Array.isArray(r.data.jobs);
  const heldRecons = () => store.recon.find({ status: 'open', source: ['trip', 'bo_confirm'] }).filter(isHeldRef);
  /** Dòng Đối chiếu đang giữ việc này (chờ Logistic Lead làm tay theo thực tế). */
  function heldRecon(jobId) { return heldRecons().find((r) => r.data.jobs.includes(jobId)) || null; }
  /** Mọi việc đang chờ Logistic Lead đối chiếu (đọc một lần cho cả lượt chia việc). */
  function heldIds() { return new Set(heldRecons().flatMap((r) => r.data.jobs)); }
  /** Chặn thao tác dọn / huỷ khi việc liên quan đang chờ Logistic Lead đối chiếu sau chuyến (FO có thể đã làm thật). */
  function failIfHeld(where, what) {
    for (const j of store.jobs.find({ ...where, status: OPEN })) if (heldRecon(j.id)) fail(409, 'held', HELD_MSG(`${what} (${j.code})`));
  }
  /** Kit / thẻ thuộc một dòng Đối chiếu còn việc chưa xử lý (trừ dòng của chính việc jobId): chưa rõ thực tế nên không cho dùng vào việc khác. */
  function heldFor(kind, value, jobId) {
    return heldRecons().find((r) => (r.data[kind] || []).includes(value) && !(jobId && r.data.jobs.includes(jobId)) && r.data.jobs.some((id) => OPEN.includes((store.jobs.get(id) || {}).status))) || null;
  }
  /** Việc đang chờ đối chiếu vừa được làm xong: mọi việc của dòng Đối chiếu đã đóng thì dòng đó tự đóng (Lead đã chốt theo thực tế). */
  function settleHeld(job, actor) {
    const rc = heldRecon(job.id);
    if (!rc) return;
    if (rc.data.jobs.some((id) => id !== job.id && OPEN.includes((store.jobs.get(id) || {}).status))) return;
    const codes = rc.data.jobs.map((id) => (store.jobs.get(id) || {}).code).filter(Boolean).join(', ');
    store.recon.update(rc.id, { status: 'resolved', resolved_by: actor ? actor.id : null, resolved_at: now(), note: `Đã làm tay theo thực tế: ${codes}` });
    log('recon', rc.id, 'resolved', `${actor ? actor.name : 'Hệ thống'} làm tay ${codes} theo số thực tế; dòng Đối chiếu tự đóng.`, actor);
    changed('recon');
  }
  /** Logistics gỡ việc khỏi chuyến chưa bắt đầu (ví dụ tự đi, đổi FO, BO dời lịch). Việc trở lại chờ làm. */
  R('POST', '/api/hub/jobs/:id/untrip', ['admin', 'lead', 'logistic'], ({ user, p }) => {
    const j = jobOrFail(p.id);
    openOrFail(j);
    const tk = j.task_id ? store.tasks.get(j.task_id) : null;
    if (!tk || !TASK_OPEN.includes(tk.status)) fail(409, 'not_in_trip', 'Việc không nằm trong chuyến nào đang mở.');
    if (tk.status === 'in_progress') fail(409, 'trip_running', `Chuyến ${tk.code} đã bắt đầu. Nếu không làm được việc này thì FO bấm "Không giao được" ở điểm đó, hoặc huỷ chuyến.`);
    store.tx(() => {
      detachFromTask(j);
      log('job', j.id, 'untrip', `${user.name} gỡ ${j.code} khỏi chuyến ${tk.code}.`, user);
    });
    K.tasks.pushTask(tk.id);
    changed('jobs', 'kits', 'cards');
    return { job: brief(store.jobs.get(j.id)) };
  });
  /** FO bắt đầu chuyến: kit và thẻ mang theo chuyển sang "đang giao". */
  K.hooks.onTaskStarted = (task) => {
    const reqs = new Set();
    for (const s of store.stops.find({ task_id: task.id })) {
      if (!s.hub) continue;
      for (const id of s.hub.kits_out || []) { const k = store.kits.get(id); if (k && ['reserved', 'ready'].includes(k.status)) { H.stock.setKit(k, 'delivering', null, `FO ${H.userName(task.fo_id)} mang kit ${k.code} đi ${s.name} (chuyến ${task.code}).`); if (k.request_id) reqs.add(k.request_id); } }
      for (const c of s.hub.cards_out || []) { const cd = store.cards.find({ code: c }, { limit: 1 })[0]; if (cd && cd.status === 'office') store.cards.update(cd.id, { status: 'with_fo', task_id: task.id, since: now(), updated_at: now() }); }
    }
    for (const id of reqs) H.outlets.refreshRequest(id, null); // yêu cầu chuyển "đang giao" để Sale thấy kit đã lên đường
    changed('kits', 'cards', 'jobs');
  };
  /** Việc nào đi theo số nào ở điểm: kit (thiết bị), thẻ. Giao phụ kiện, việc tay: FO không đếm ở điểm nên không giữ lại. */
  const HOLD_ON = { deliver: ['dev'], swap_faulty: ['dev'], recover: ['dev', 'card'], card_swap: ['card'] };
  /** Số kế hoạch, số FO báo, số BO xác nhận (chỉ khi BO đã xác nhận / báo lệch) và hai cờ khớp: thiết bị, thẻ. */
  function stopCounts(stop) {
    const plan = { co: stop.exp_cards_out || 0, ci: stop.exp_cards_in || 0, dOut: stop.exp_dev_out || 0, dIn: stop.exp_dev_in || 0 };
    const fo = { co: stop.cards_out || 0, ci: stop.cards_in || 0, dOut: stop.dev_out || 0, dIn: stop.dev_in || 0 };
    const bo = ['confirmed', 'mismatch'].includes(stop.bo_status) ? { co: stop.bo_cards_recv || 0, ci: stop.bo_cards_given || 0, dOut: stop.bo_dev_recv || 0, dIn: stop.bo_dev_given || 0 } : null;
    const same = (keys) => keys.every((k) => fo[k] === plan[k] && (!bo || bo[k] === plan[k]));
    return { plan, fo, bo, dev: same(['dOut', 'dIn']), card: same(['co', 'ci']) };
  }
  const countText = (c) => `giao ${c.co} thẻ / ${c.dOut} TB, thu ${c.ci} thẻ / ${c.dIn} TB`;
  /**
   * Số giao nhận khác kế hoạch: việc không tự đóng, rời chuyến và trở về Logistics chờ Logistic Lead đối chiếu.
   * Kit / thẻ FO mang đi của việc này chưa ghi là đã giao: về lại kho trên hệ thống; kit / thẻ ở BO giữ nguyên chỗ.
   */
  function holdJob(j, mine, stop, task) {
    store.jobs.update(j.id, { task_id: null, status: 'open', al_due: 0 });
    log('job', j.id, 'hold', `${j.code} chưa tự đóng: số giao nhận tại ${boLabel(stop.name)} (chuyến ${task.code}) khác kế hoạch. Chờ Logistic Lead đối chiếu và làm tay theo mã thực tế.`, null);
    const reqs = new Set();
    for (const kid of (mine && mine.kits_out) || []) {
      const k = store.kits.get(kid);
      if (k && k.status === 'delivering') { H.stock.setKit(k, k.request_id ? 'reserved' : 'ready', null, `Kit ${k.code} chưa ghi là đã giao: ${j.code} chờ đối chiếu số lượng.`); if (k.request_id) reqs.add(k.request_id); }
    }
    for (const id of reqs) H.outlets.refreshRequest(id, null);
    for (const c of (mine && mine.cards_out) || []) { const cd = store.cards.find({ code: c }, { limit: 1 })[0]; if (cd && cd.status === 'with_fo' && cd.task_id === task.id) store.cards.update(cd.id, { status: 'office', task_id: null, since: now(), updated_at: now() }); }
    if (j.assignee_id) notify({ ids: [j.assignee_id] }, 'warn', 'job', `${j.title}: số giao nhận khác kế hoạch, việc chờ Logistic Lead đối chiếu.`, `job:${j.id}`);
  }
  /**
   * Một điểm đã chốt (FO xác nhận và BO đã xác nhận / được cho qua / không cần BO): đóng các việc đi theo điểm.
   * Số FO (và BO) khớp kế hoạch thì chạy theo kế hoạch. Khác thì không chuyển gì chưa xác nhận: việc liên quan giữ lại cho Logistic Lead,
   * một dòng Đối chiếu mức cao ghi số kế hoạch / FO / BO; Lead làm tay việc đó theo mã thực tế thì dòng tự đóng.
   */
  K.hooks.onStopClosed = (stop, task) => {
    if (!stop.hub || !(stop.hub.jobs || []).length) return;
    const fo = task.fo_id ? store.users.get(task.fo_id) : null;
    const cnt = stopCounts(stop), held = [];
    const perOf = (id) => (stop.hub.per || {})[id] || (stop.hub.per || {})[String(id)] || null;
    // Đổi thẻ chốt trước giao launch cùng điểm: thẻ đi trong kit mới giao không bị lượt đổi thẻ tính là thẻ cũ cần thu.
    const order = [...stop.hub.jobs].sort((a, b) => ((store.jobs.get(a) || {}).type === 'card_swap' ? 0 : 1) - ((store.jobs.get(b) || {}).type === 'card_swap' ? 0 : 1));
    /** Phần số thẻ FO báo thuộc về việc này: số cả điểm trừ phần kế hoạch của các việc khác cùng điểm (ví dụ thẻ trong kit giao launch). */
    const share = (id, key, total) => { let n = total || 0; for (const o of stop.hub.jobs) if (String(o) !== String(id)) n -= (perOf(o) || {})[key] || 0; return Math.max(0, n); };
    for (const id of order) {
      const j = store.jobs.get(id);
      if (!j || !OPEN.includes(j.status)) continue;
      const mine = perOf(id);
      const need = HOLD_ON[j.type] || [];
      if ((need.includes('dev') && !cnt.dev) || (need.includes('card') && !cnt.card)) { holdJob(j, mine, stop, task); held.push({ j, mine }); continue; }
      // Giao launch khớp số kit nhưng lệch số thẻ: kit vẫn giao, thẻ trong kit chưa ghi ở BO (đã nêu trong dòng Đối chiếu của điểm).
      const res = { cards_out: mine ? mine.cards_out : stop.hub.cards_out || [], count_out: mine ? share(id, 'co', stop.cards_out) : stop.cards_out, count_in: mine ? share(id, 'ci', stop.cards_in) : stop.cards_in, new_kit_id: mine ? mine.swap : stop.hub.swap ? stop.hub.swap[id] ?? stop.hub.swap[String(id)] : undefined, kit_ids: j.type === 'recover' ? (mine ? mine.kits_in : stop.hub.kits_in) : j.type === 'deliver' && mine ? mine.kits_out : undefined, skip_cards: !cnt.card, stop_id: stop.id, bo_status: stop.bo_status };
      try {
        complete(j, fo, res, { viaTask: true, task_id: task.id, by: fo ? fo.id : null, byName: fo ? `FO ${fo.name}` : 'FO' });
      } catch (e) {
        if (!e || !e.status) throw e;
        log('job', j.id, 'auto_fail', `Không tự đóng được ${j.code} sau khi FO xác nhận: ${e.msg || e.code}. Logistics cần xử lý tay.`, null);
        notify({ roles: ['lead', 'logistic'] }, 'alert', 'job', `Không tự đóng được ${j.code} (${j.title}) sau chuyến ${task.code}: ${e.msg || e.code}`, `job:${j.id}`);
        H.recon('trip', 'logistics', 'high', 'job', `autofail:${j.id}:${task.id}`, `${j.code} (${j.title}) không tự đóng được sau khi FO xác nhận ở chuyến ${task.code}: ${e.msg || e.code}. Đối chiếu thực tế rồi làm tay việc này.`, { job_id: j.id, task_id: task.id, stop_id: stop.id });
        store.jobs.update(j.id, { task_id: null, status: 'open' });
      }
    }
    if (!cnt.dev || !cnt.card) {
      const per = (k) => [...new Set(held.flatMap(({ mine }) => (mine && mine[k]) || []))];
      const kits = [...new Set([...per('kits_out'), ...per('kits_in')])], cards = [...new Set([...per('cards_out'), ...per('cards_in')])];
      const kitCodes = kits.map((kid) => (store.kits.get(kid) || {}).code).filter(Boolean);
      const boText = cnt.bo ? `; BO xác nhận đã nhận ${cnt.bo.co} thẻ / ${cnt.bo.dOut} TB, đưa FO ${cnt.bo.ci} thẻ / ${cnt.bo.dIn} TB` : stop.bo_status === 'waived' ? '; BO chưa xác nhận (đã cho qua)' : '';
      const what = held.length
        ? ` Chưa ghi chuyển kit / thẻ của ${held.map(({ j }) => j.code).join(', ')}: đối chiếu với FO và BO rồi Logistic Lead làm tay các việc này theo mã thực tế${kitCodes.length ? ` (kit theo kế hoạch: ${kitCodes.join(', ')})` : ''}.`
        : ' Đối chiếu với FO và BO.';
      H.recon(stop.bo_status === 'mismatch' ? 'bo_confirm' : 'trip', 'logistics', 'high', 'stop', `count:${stop.id}`, `${boLabel(stop.name)} (chuyến ${task.code}): số giao nhận khác kế hoạch. Kế hoạch ${countText(cnt.plan)}; FO báo ${countText(cnt.fo)}${boText}.${what}`,
        { task_id: task.id, stop_id: stop.id, site_id: stop.site_id || null, job_id: held.length ? held[0].j.id : null, jobs: held.map(({ j }) => j.id), job_codes: held.map(({ j }) => j.code), kits, cards, codes: cards, plan: cnt.plan, fo: cnt.fo, bo: cnt.bo });
      if (held.length) changed('jobs', 'kits', 'cards');
    }
    dropStale(stop.hub.jobs, null); // việc không tự đóng được mà BO đã ngừng ghi hình / kit đã rời BO ngay trong lượt này thì huỷ luôn
  };
  /** Điểm không giao được, hoặc chuyến bị huỷ: việc trở lại chờ làm, kit và thẻ đang mang theo trở về như trước. */
  function revertStop(stop, task, why) {
    if (!stop.hub) return;
    for (const id of stop.hub.jobs || []) {
      const j = store.jobs.get(id);
      if (!j || j.status !== 'doing' || j.task_id !== task.id) continue;
      store.jobs.update(j.id, { task_id: null, status: 'open', al_due: 0 });
      log('job', j.id, 'reopen', `${j.code} trở lại chờ làm: ${why} (chuyến ${task.code}).`, null);
      notify({ ids: [j.assignee_id] }, 'warn', 'job', `${j.title}: ${why}. Việc đã trở lại danh sách chờ.`, `job:${j.id}`);
    }
    const reqs = new Set();
    for (const kid of stop.hub.kits_out || []) {
      const k = store.kits.get(kid);
      if (k && k.status === 'delivering') { H.stock.setKit(k, k.request_id ? 'reserved' : 'ready', null, `Kit ${k.code} chưa giao được (${why}); FO mang về kho.`); if (k.request_id) reqs.add(k.request_id); }
    }
    for (const id of reqs) H.outlets.refreshRequest(id, null); // yêu cầu quay lại "sẵn sàng" và việc giao mở lại cho chuyến sau
    dropStale(stop.hub.jobs || [], null);
    for (const c of stop.hub.cards_out || []) { const cd = store.cards.find({ code: c }, { limit: 1 })[0]; if (cd && cd.status === 'with_fo') store.cards.update(cd.id, { status: 'office', task_id: null, updated_at: now() }); }
    changed('jobs', 'kits', 'cards');
  }
  /** Gộp việc giao phụ kiện `from` vào `into` (cùng kit): cộng số phụ kiện của yêu cầu, huỷ việc kia và đóng yêu cầu kia với ghi chú gộp. */
  function mergeAcc(into, from, actor) {
    const ri = into.request_id ? store.requests.get(into.request_id) : null, rf = from.request_id ? store.requests.get(from.request_id) : null;
    if (!ri || !rf || ri.kind !== 'support' || rf.kind !== 'support') return;
    const sum = { ...((ri.need && ri.need.acc) || {}) };
    for (const [t, q] of Object.entries((rf.need && rf.need.acc) || {})) sum[t] = (sum[t] || 0) + q;
    store.requests.update(ri.id, { need: { ...ri.need, acc: sum }, note: [ri.note, rf.note].filter(Boolean).join(' · ').slice(0, 500), updated_at: now() });
    store.jobs.update(from.id, { status: 'cancelled', done_at: now(), note: [from.note, `Gộp vào ${into.code}`].filter(Boolean).join(' · ').slice(0, 500) });
    store.requests.update(rf.id, { status: 'closed', closed_at: now(), updated_at: now(), reason: `Gộp vào ${ri.code}` });
    log('job', from.id, 'cancel', `Việc ${from.code} gộp vào ${into.code} (cùng kit, giao một lần).`, actor);
    log('request', ri.id, 'merge', `Yêu cầu ${rf.code} gộp vào ${ri.code}: giao chung một lần.`, actor);
  }
  /** Việc vừa trở lại danh sách chờ nhưng BO / kit đã đổi trong lúc chuyến chạy (BO ngừng ghi hình, kit rời BO): việc không còn cần thì huỷ. */
  function dropStale(ids, actor) {
    for (const id of ids) {
      const j = store.jobs.get(id);
      if (!j || j.status !== 'open' || j.task_id) continue;
      // Việc chờ Lead đối chiếu: BO không còn cần việc này thì vẫn huỷ như thường, số lệch giữ nguyên ở dòng Đối chiếu để Lead xử lý.
      const held = heldRecon(j.id) ? ' (số lệch vẫn chờ ở mục Đối chiếu)' : '';
      if (j.type === 'card_swap') { const site = store.sites.get(j.site_id); if (!site || site.ops_status !== 'live') { cancelFor({ id: j.id }, actor, `BO không còn ghi hình${held}`); continue; } }
      // BO đang thu hồi / đã kết thúc trong lúc chuyến chạy: kit lỗi về kho cùng đợt thu hồi, việc đổi kit không còn cần.
      if (j.type === 'swap_faulty') { const site = store.sites.get(j.site_id); if (!site || !['live', 'paused'].includes(site.ops_status)) { cancelFor({ id: j.id }, actor, `BO kết thúc, kit lỗi về cùng đợt thu hồi${held}`); settleSupport(j.request_id, actor, 'BO kết thúc, kit lỗi về cùng đợt thu hồi'); continue; } }
      if (held) continue; // còn lại: Lead quyết định
      if (j.type === 'deliver_acc') {
        const k = store.kits.get(j.kit_id);
        if (!k || k.status !== 'at_bo' || k.site_id !== j.site_id) { cancelFor({ id: j.id }, actor, 'Kit đã rời BO'); settleSupport(j.request_id, actor, 'kit đã rời BO'); continue; }
        // Trong lúc chuyến chạy đã có yêu cầu phụ kiện mới cho cùng kit: gộp về một việc để giao một lần.
        for (const o of store.jobs.find({ type: 'deliver_acc', kit_id: j.kit_id, status: OPEN, task_id: null }).filter((x) => x.id !== j.id)) mergeAcc(o, j, actor); // gộp lượt vừa trở lại vào lượt đang chờ / đang làm tay
      }
    }
  }
  K.hooks.onStopFailed = (stop, task) => revertStop(stop, task, `FO không giao nhận được: ${stop.fail_reason || ''}`);
  /** Chuyến kết thúc: thẻ FO thu về trong chuyến tính là đã về văn phòng. Chuyến huỷ: trả lại các việc chưa xong. */
  K.hooks.onTaskClosed = (task) => {
    if (task.status === 'cancelled') {
      for (const s of store.stops.find({ task_id: task.id })) {
        if (s.status !== 'done') { revertStop(s, task, 'Chuyến bị huỷ'); continue; }
        if (s.bo_status !== 'pending') continue;
        // FO đã giao nhận (có ảnh) nhưng BO chưa xác nhận lúc huỷ chuyến: chốt theo xác nhận của FO để kit / thẻ đúng thực tế, và đưa vào Đối chiếu để Logistics gọi BO xác nhận lại.
        store.stops.update(s.id, { bo_status: 'waived', bo_at: now(), bo_waive_reason: 'Chuyến bị huỷ khi BO chưa xác nhận; chốt theo ảnh và số của FO', bo_link_hash: null, bo_link_dev: null });
        H.recon('bo_confirm', 'logistics', 'mid', 'stop', `bo:${s.id}`, `Chuyến ${task.code} bị huỷ khi ${s.name} chưa xác nhận giao nhận. Hệ thống chốt theo ảnh và số FO báo (giao ${s.cards_out} thẻ / ${s.dev_out} TB, thu ${s.cards_in} thẻ / ${s.dev_in} TB). Gọi BO xác nhận lại.`, { task_id: task.id, stop_id: s.id });
        K.hooks.onStopClosed(store.stops.get(s.id), task);
      }
    }
    // Việc còn gắn chuyến mà chưa đóng được (huỷ chuyến, hoặc tự đóng không thành): trả về danh sách chờ để Logistics xử lý tay.
    for (const j of store.jobs.find({ task_id: task.id, status: OPEN })) {
      store.jobs.update(j.id, { task_id: null, status: 'open', al_due: 0 });
      log('job', j.id, 'reopen', `${j.code} trở lại chờ làm: chuyến ${task.code} đã ${task.status === 'cancelled' ? 'huỷ' : 'kết thúc'} mà việc chưa đóng.`, null);
      if (j.assignee_id) notify({ ids: [j.assignee_id] }, 'warn', 'job', `${j.title}: chuyến ${task.code} đã ${task.status === 'cancelled' ? 'huỷ' : 'kết thúc'} mà việc chưa đóng, cần xử lý tay.`, `job:${j.id}`);
    }
    dropStale(store.stops.find({ task_id: task.id }).flatMap((s) => (s.hub && s.hub.jobs) || []), null);
    // Thẻ xử lý sau cùng, khi các điểm chờ BO đã được chốt.
    for (const c of store.cards.find({ task_id: task.id, status: 'with_fo' })) {
      // Thẻ mới mang đi mà chưa giao (chuyến huỷ) thì về lại kho; thẻ thu từ BO thì về VP chờ gửi Tech.
      store.cards.update(c.id, { status: c.bo_out ? 'returned' : 'office', task_id: null, since: now(), updated_at: now() });
    }
    // Thẻ đã chọn cho chuyến nhưng FO chưa mang đi (chuyến huỷ trước khi bắt đầu): gỡ khỏi chuyến để chọn lại được.
    for (const c of store.cards.find({ task_id: task.id, status: 'office' })) store.cards.update(c.id, { task_id: null, updated_at: now() });
    changed('cards', 'jobs');
  };

  // ───────────────────────── Nhịp định kỳ ─────────────────────────
  let lastGen = 0;
  function tick(t) {
    const c = H.cfg(), d = localDate(t, off);
    if (t - lastGen >= 60000) {
      lastGen = t;
      store.tx(() => {
        // Tới ngày tạm nghỉ thì BO chuyển "tạm nghỉ" (máy vẫn ở BO; việc đổi thẻ chưa lên chuyến được huỷ). Hôm nay ngoài khoảng tạm nghỉ
        // (hết hạn, bị dời) thì BO đang tạm nghỉ ghi hình lại; BO tạm nghỉ không có ngày (nhập từ file) giữ nguyên chờ người sửa. Có nhật ký mỗi lần đổi.
        for (const s of store.sites.find({ active: 1, type: 'bo', ops_status: ['live', 'paused'] })) H.outlets.syncPause(s, d, null);
        // Tới ngày kết thúc đã hẹn: BO chuyển "đang thu hồi".
        for (const r of store.requests.find({ kind: 'end', status: 'scheduled' })) {
          const s = store.sites.get(r.site_id);
          if (s && ['live', 'paused'].includes(s.ops_status) && s.end_date && s.end_date <= d) H.outlets.beginEnding(s, r, null);
        }
        for (const s of store.sites.find({ active: 1, type: 'bo', ops_status: 'live' })) genSwaps(s, null);
        if (weekday(d) === c.stockCheckDay) ensure({ type: 'stock_check', date: d, title: `Kiểm kho ${d.slice(8, 10)}/${d.slice(5, 7)}`, dedupe: `stock:${d}` }, null);
        releaseOffShift(t);
        assignPool(null);
        if (H.cards) H.cards.tick(t); // thẻ sẵn sàng tại VP dưới ngưỡng thì báo Logistics
      });
    }
    // Quá hạn: báo người làm. Báo Lead khi việc quá hạn lâu, khi một người dồn nhiều việc lâu, hoặc khi việc chưa ai nhận mà team có người trong ca.
    const open = store.jobs.find({ status: OPEN });
    const pile = new Map();
    const shiftCache = new Map();
    // Team có người trong ca và không còn ai sắp vào ca (việc đang chờ người sắp vào theo phần chia đều thì chưa báo).
    const teamOnShift = (team) => {
      if (!shiftCache.has(team)) { const us = MEMBER_ROLES[team] ? store.users.find({ role: MEMBER_ROLES[team], active: 1 }) : []; shiftCache.set(team, us.some((u) => onShift(u, t)) && !us.some((u) => expectedSoon(u, t))); }
      return shiftCache.get(team);
    };
    for (const j of open) {
      if (j.show_date && j.show_date > d) continue;
      if (j.blocked) continue; // đang vướng: Lead đã được báo khi báo vướng
      if (j.due_at && t > j.due_at && !j.al_due) {
        store.jobs.update(j.id, { al_due: 1 });
        if (j.assignee_id) notify({ ids: [j.assignee_id] }, 'warn', 'overdue', `Quá hạn: ${j.title}.`, `job:${j.id}`, `due:${j.id}`);
      }
      const overMin = H.tcfg('leadOverdueMin', j.team, c), poolMin = H.tcfg('poolAlertMin', j.team, c); // ngưỡng của team giữ việc
      if (j.due_at && t > j.due_at + overMin * 60000 && !j.al_lead && LEAD_ROLE[j.team]) {
        store.jobs.update(j.id, { al_lead: 1 });
        notify({ roles: [LEAD_ROLE[j.team]] }, 'alert', 'lead_overdue', `${j.assignee_id ? H.userName(j.assignee_id) : 'Chưa ai nhận'}: quá hạn hơn ${overMin < 60 ? `${overMin} phút` : `${Math.round(overMin / 60)} giờ`} — ${j.title} (${j.code}).`, `job:${j.id}`, `lead:${j.id}`);
      }
      if (!j.assignee_id && !j.al_pool && LEAD_ROLE[j.team] && t - j.created_at > poolMin * 60000 && (j.priority || teamOnShift(j.team))) {
        store.jobs.update(j.id, { al_pool: 1 });
        notify({ roles: [LEAD_ROLE[j.team]] }, 'warn', 'pool', `Việc chưa ai nhận hơn ${poolMin} phút: ${j.title} (${j.code}).`, `job:${j.id}`, `pool:${j.id}`);
      }
      if (j.assignee_id) { const p = pile.get(j.assignee_id) || { n: 0, oldest: t, team: j.team }; p.n++; p.oldest = Math.min(p.oldest, j.started_at || j.sla_start || j.created_at); pile.set(j.assignee_id, p); }
    }
    for (const [uid, p] of pile) {
      if (p.n > H.tcfg('leadPileJobs', p.team, c) && t - p.oldest > H.tcfg('leadPileMin', p.team, c) * 60000 && LEAD_ROLE[p.team]) notify({ roles: [LEAD_ROLE[p.team]] }, 'warn', 'lead_pile', `${H.userName(uid)} đang giữ ${p.n} việc, việc lâu nhất đã ${Math.round((t - p.oldest) / 60000)} phút.`, `user:${uid}`, `pile:${uid}:${d}`);
    }
    // Việc tồn từ ngày trước: nhắc Lead một lần mỗi ngày.
    for (const team of ['logistics', 'tech']) {
      const stale = open.filter((j) => j.team === team && j.date < d && (!j.show_date || j.show_date < d)).length;
      if (stale) notify({ roles: [LEAD_ROLE[team]] }, 'warn', 'stale', `${stale} việc của team ${team === 'tech' ? 'Tech' : 'Logistics'} từ ngày trước chưa xong.`, 'jobs:stale', `stale:${team}:${d}`);
    }
  }

  return {
    ensure, complete, closeFor, claimFor, cancelFor, retime, brief, viewFor, jobOrFail, syncSwaps, genSwaps, tick, onShift, shiftOf, pickAssignee, assignPool, releaseOf, rebalance, dueFor, openLoad,
    handlers, isLeadOf, inTeam, receiveField, stdOf, stdFor, uploadStd, slaOf, OPEN, MEMBER_ROLES, LEAD_ROLE, tripOf, failIfInTrip, failIfTripRunning, kitTrip, failIfKitInTrip, settleSupport, dropSwap,
    detachFromTask, heldRecon, heldIds, failIfHeld, holderPatch, loadOf, duePatch, teamKey,
  };
}
