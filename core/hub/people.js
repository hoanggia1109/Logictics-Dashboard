// people.js — bảng phân ca (Lead xếp; nhân viên đăng ký, Lead duyệt), chấm công (tự ghi khi mở ứng dụng trong giờ ca),
// và đánh giá hiệu suất kiểu HRIS theo tuần / tháng cho Tech và Logistics: khối lượng (phút chuẩn ÷ 6), đúng hạn, chất lượng,
// chuyên cần → điểm tổng hợp → mức 1–5. Bảo mật theo team: Lead chỉ xem team mình, thành viên chỉ xem dòng của mình, Sale không xem.
import { cleanStr, cleanText, int, isDate, isHM, atTime, addDays, localDate, csvCell } from '../util.js';
import { fail } from '../core.js';
import { JOB_TYPES, ATT_ST, RATING } from './defs.js';
import { periodOf, shiftWeek, weekRange, monthRange, tsRange, weekLabel, monthLabel, weekKey, mondayOf } from './period.js';

const TEAM_ROLES = { tech: ['tech', 'tech_lead'], logistics: ['logistic', 'lead'] };
const LEAD_ROLES = ['tech_lead', 'lead'];
const ATT_ROLES = ['tech', 'tech_lead', 'logistic', 'lead'];
const r1 = (x) => (x === null || x === undefined ? null : Math.round(Math.round(x * 1e6) / 1e5) / 10); // gạt nhiễu dấu phẩy động trước khi làm tròn (như report.js)
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);

export function installPeople(H) {
  const { K, G, store, now, off, today, log, changed, notify, reasonOf, idList } = H;
  const { R } = K;
  const teamOfUser = (u) => (TEAM_ROLES.tech.includes(u.role) ? 'tech' : TEAM_ROLES.logistics.includes(u.role) ? 'logistics' : null);
  /** Team mà người gọi được xem bảng của cả team (Lead của team đó hoặc Quản trị). */
  function leadTeam(user, want) {
    if (user.role === 'admin') return want === 'logistics' ? 'logistics' : want === 'tech' ? 'tech' : 'tech';
    if (user.role === 'tech_lead') return 'tech';
    if (user.role === 'lead') return 'logistics';
    return null;
  }
  function teamOrFail(user, want) {
    const t = leadTeam(user, want);
    if (!t) fail(403, 'forbidden', 'Chỉ Lead của team mới xem được bảng của cả team.');
    if (user.role !== 'admin' && want && want !== t) fail(403, 'forbidden', 'Bạn chỉ xem được team của mình.');
    return t;
  }
  const membersOf = (team, withInactive = false) => store.users.find({ role: TEAM_ROLES[team], ...(withInactive ? {} : { active: 1 }) }, { order: 'name' });
  const shiftsCfg = (team) => H.tcfg('shifts', team) || []; // ca mẫu riêng của từng team

  // ───────────────────────── Bảng phân ca ─────────────────────────
  /** Chuẩn hoá một dòng ca: theo ca mẫu (shift) hoặc giờ tự nhập; ca chỉ có ngày (không giờ) cũng hợp lệ. */
  function shiftInput(r, team) {
    if (r.kind === 'leave') return { kind: 'leave', shift: null, start: null, end: null };
    let start = r.start || null, end = r.end || null, shift = null;
    if (r.shift) {
      const s = shiftsCfg(team).find((x) => x.id === r.shift);
      if (!s) fail(400, 'bad_shift', `Không có ca mẫu "${cleanStr(r.shift, 10)}".`);
      ({ start, end } = s); shift = s.id;
    }
    if ((start && !isHM(start)) || (end && !isHM(end)) || (!!start !== !!end)) fail(400, 'bad_time', 'Giờ ca có dạng GG:PP, cần cả giờ vào và giờ ra.');
    if (start && end <= start) fail(400, 'bad_time', 'Giờ ra phải sau giờ vào (chưa hỗ trợ ca qua đêm).');
    return { kind: 'shift', shift, start, end };
  }
  function dateOk(d) {
    if (!isDate(d)) fail(400, 'bad_date', 'Ngày không hợp lệ.');
    if (d < addDays(today(), -31) || d > addDays(today(), 92)) fail(400, 'bad_date', 'Chỉ xếp ca trong khoảng 31 ngày trước đến 92 ngày tới.');
    return d;
  }
  const rosterView = (r) => ({ id: r.id, user_id: r.user_id, date: r.date, kind: r.kind || 'shift', shift: r.shift, start: r.start, end: r.end, status: r.status || 'approved', note: r.note || '', by: r.by_id ? H.userName(r.by_id) : '' });
  R('GET', '/api/hub/roster', G.OPS_STAFF, ({ user, q }) => {
    const from = isDate(q.from) ? q.from : mondayOf(today()), to = isDate(q.to) && q.to >= from ? q.to : addDays(from, 6);
    if (addDays(from, 62) < to) fail(400, 'bad_range', 'Mỗi lần xem tối đa 62 ngày.');
    const team = user.role === 'admin' ? (q.team === 'logistics' ? 'logistics' : 'tech') : teamOfUser(user);
    const lead = !!leadTeam(user, team) && (user.role === 'admin' || leadTeam(user) === team);
    const users = membersOf(team);
    const ids = new Set(users.map((u) => u.id));
    let rows = store.roster.find({ date: { gte: from, lte: to } }).filter((r) => ids.has(r.user_id));
    // Thành viên thấy lịch đã duyệt của cả team (để biết ai trong ca) và yêu cầu của chính mình.
    if (!lead) rows = rows.filter((r) => (r.status || 'approved') === 'approved' || r.user_id === user.id);
    const att = store.attendance.find({ date: { gte: from, lte: to } }).filter((a) => ids.has(a.user_id) && (lead || a.user_id === user.id));
    return {
      team, from, to, lead, shifts: shiftsCfg(team), users: users.map((u) => ({ id: u.id, name: u.name, role: u.role, role_label: H.ROLE_LABEL[u.role] })),
      rows: rows.map(rosterView), attendance: att.map(attView), pending: lead ? rows.filter((r) => r.status === 'pending').length : undefined,
      // Ai đang trong ca lúc này (đúng quy tắc giao việc tự động). Thành viên chỉ biết của chính mình (vì lộ cả chấm công).
      on_shift: users.filter((u) => (lead || u.id === user.id) && H.jobs.onShift(u)).map((u) => u.id),
    };
  });
  /** Lead xếp ca hàng loạt (đã duyệt). kind: 'off' để xoá ca của ngày đó. */
  R('PUT', '/api/hub/roster', G.LEADS, ({ user, b }) => {
    const list = Array.isArray(b.rows) ? b.rows : fail(400, 'bad_list', 'Danh sách ca không hợp lệ.');
    if (list.length > 1000) fail(400, 'too_many', 'Tối đa 1000 dòng mỗi lần.');
    const t = now();
    let n = 0;
    store.tx(() => {
      for (const r of list) {
        const u = store.users.get(int(r && r.user_id, 1, 1e12) ?? -1);
        if (!u || !teamOfUser(u)) fail(400, 'bad_user', 'Người trong bảng ca phải thuộc Tech hoặc Logistics.');
        const team = teamOfUser(u);
        if (user.role !== 'admin' && leadTeam(user) !== team) fail(403, 'forbidden', `Bạn không xếp ca cho ${u.name} (khác team).`);
        const date = dateOk(r.date), id = `${u.id}:${date}`;
        store.roster.remove(`req:${id}`);
        if (date === today()) seen.delete(u.id); // ca hôm nay đổi: xét lại chấm công ở lần mở ứng dụng kế tiếp
        if (r.kind === 'off') { store.roster.remove(id); n++; continue; }
        const s = shiftInput(r, team);
        const row = { id, user_id: u.id, date, ...s, by_id: user.id, status: 'approved', note: cleanStr(r.note, 120), team, at: t };
        if (store.roster.get(id)) store.roster.update(id, row); else store.roster.insert(row);
        if (s.kind === 'leave') leaveOverAbsent(u, date, user);
        n++;
      }
      log('roster', null, 'set', `${user.name} cập nhật ${n} ô trong bảng phân ca.`, user);
    });
    changed('roster', 'people');
    return { ok: true, count: n };
  });
  /** Nhân viên đăng ký ca hoặc xin nghỉ. Cần Lead duyệt (trừ khi cấu hình cho tự duyệt). */
  R('POST', '/api/hub/roster/register', G.OPS_STAFF, ({ user, b }) => {
    const team = teamOfUser(user);
    if (!team) fail(403, 'forbidden', 'Chỉ thành viên Tech và Logistics đăng ký ca.');
    const list = Array.isArray(b.rows) ? b.rows : fail(400, 'bad_list', 'Danh sách không hợp lệ.');
    if (!list.length || list.length > 62) fail(400, 'bad_list', 'Đăng ký từ 1 đến 62 ngày mỗi lần.');
    const auto = !!H.tcfg('rosterSelfApprove', team), t = now(); // mỗi team chốt riêng có cho tự duyệt hay không
    store.tx(() => {
      for (const r of list) {
        const date = dateOk(r.date);
        if (date < today()) fail(400, 'bad_date', 'Không đăng ký cho ngày đã qua.');
        const s = shiftInput(r, team), id = `${user.id}:${date}`;
        const row = { user_id: user.id, date, ...s, by_id: user.id, status: auto ? 'approved' : 'pending', note: cleanStr(r.note, 120), team, at: t };
        if (auto) {
          store.roster.remove(`req:${id}`); if (store.roster.get(id)) store.roster.update(id, row); else store.roster.insert({ id, ...row });
          if (date === today()) seen.delete(user.id); // ca hôm nay có hiệu lực ngay: xét lại chấm công ở lần mở ứng dụng kế tiếp
          if (s.kind === 'leave') leaveOverAbsent(user, date, user);
        }
        else if (store.roster.get(`req:${id}`)) store.roster.update(`req:${id}`, row); else store.roster.insert({ id: `req:${id}`, ...row });
      }
      log('roster', null, 'register', `${user.name} đăng ký ${list.length} ngày (${list.some((r) => r.kind === 'leave') ? 'có xin nghỉ' : 'ca làm'}).`, user);
    });
    if (!auto) notify({ roles: [team === 'tech' ? 'tech_lead' : 'lead'] }, 'info', 'roster', `${user.name} đăng ký ${list.length} ngày, chờ duyệt.`, 'roster', `rosterreq:${user.id}:${list[0].date}:${t}`);
    changed('roster');
    return { ok: true, pending: !auto };
  });
  R('POST', '/api/hub/roster/review', G.LEADS, ({ user, b }) => {
    const ids = Array.isArray(b.ids) ? b.ids.map((x) => cleanStr(x, 60)).filter((x) => x.startsWith('req:')) : [];
    if (!ids.length) fail(400, 'bad_list', 'Chọn yêu cầu cần duyệt.');
    const approve = b.approve !== false, t = now();
    const done = new Map();
    store.tx(() => {
      for (const id of ids) {
        const r = store.roster.get(id);
        if (!r || r.status !== 'pending') continue;
        if (user.role !== 'admin' && leadTeam(user) !== r.team) fail(403, 'forbidden', 'Yêu cầu không thuộc team của bạn.');
        if (approve) {
          const main = id.slice(4);
          const row = { user_id: r.user_id, date: r.date, kind: r.kind, shift: r.shift, start: r.start, end: r.end, by_id: user.id, status: 'approved', note: r.note, team: r.team, at: t };
          if (store.roster.get(main)) store.roster.update(main, row); else store.roster.insert({ id: main, ...row });
          store.roster.remove(id);
          if (r.kind === 'leave') leaveOverAbsent(store.users.get(r.user_id), r.date, user);
        } else store.roster.update(id, { status: 'rejected', note: [r.note, cleanStr(b.note, 120)].filter(Boolean).join(' · '), by_id: user.id, at: t });
        if (approve && r.date === today()) seen.delete(r.user_id); // ca hôm nay vừa duyệt: lần mở ứng dụng kế tiếp được ghi vào ca ngay
        done.set(r.user_id, (done.get(r.user_id) || 0) + 1);
      }
      log('roster', null, approve ? 'approve' : 'reject', `${user.name} ${approve ? 'duyệt' : 'từ chối'} ${[...done.values()].reduce((a, x) => a + x, 0)} yêu cầu ca.`, user);
    });
    for (const [uid, n] of done) notify({ ids: [uid] }, approve ? 'info' : 'warn', 'roster', `${user.name} ${approve ? 'đã duyệt' : 'không duyệt'} ${n} ngày bạn đăng ký${b.note ? `: ${cleanStr(b.note, 120)}` : ''}.`, 'roster');
    changed('roster', 'people');
    return { ok: true };
  });
  /**
   * Chép các ca làm đã duyệt của một tuần sang tuần khác (bỏ qua ô đã có). Nghỉ phép không chép (mỗi lần nghỉ là một yêu cầu riêng);
   * ngày đã qua của tuần đích không chép (chép vào tuần đang chạy thì chép từ hôm nay).
   */
  R('POST', '/api/hub/roster/copy-week', G.LEADS, ({ user, b }) => {
    const src = weekRange(b.from_week), dst = weekRange(b.to_week);
    if (!src || !dst) fail(400, 'bad_week', 'Tuần có dạng 2026-W41.');
    const team = teamOrFail(user, b.team);
    const ids = new Set(membersOf(team).map((u) => u.id));
    const d0 = today();
    let n = 0, past = 0;
    store.tx(() => {
      for (const r of store.roster.find({ date: { gte: src.from, lte: src.to }, status: 'approved' })) {
        if (!ids.has(r.user_id) || r.kind === 'leave') continue;
        const date = addDays(dst.from, Math.round((Date.parse(r.date) - Date.parse(src.from)) / 86400000));
        if (date < d0) { past++; continue; }
        dateOk(date);
        const id = `${r.user_id}:${date}`;
        if (store.roster.get(id)) continue;
        store.roster.insert({ id, user_id: r.user_id, date, kind: 'shift', shift: r.shift, start: r.start, end: r.end, by_id: user.id, status: 'approved', note: '', team, at: now() });
        if (date === d0) seen.delete(r.user_id);
        n++;
      }
      log('roster', null, 'copy', `${user.name} chép ${n} ca từ ${b.from_week} sang ${b.to_week}${past ? ` (bỏ ${past} ca rơi vào ngày đã qua)` : ''}.`, user);
    });
    changed('roster');
    return { ok: true, count: n, skipped_past: past };
  });

  // ───────────────────────── Chấm công ─────────────────────────
  const attView = (a) => ({ id: a.id, user_id: a.user_id, date: a.date, checkin_at: a.checkin_at, late_min: a.late_min || 0, status: a.status || null, status_label: a.status ? ATT_ST[a.status] || a.status : 'Chưa vào ca', ot_min: a.ot_min || 0, note: a.note || '', by: a.by_id ? H.userName(a.by_id) : '' });
  const seen = new Map(); // uid → { date, until }: chưa cần xét lại trước thời điểm until
  /**
   * Gọi mỗi khi một người dùng ứng dụng (mọi yêu cầu đã đăng nhập). Lần đầu trong giờ ca của ngày thì ghi vào ca.
   * Chỉ người có ca đã duyệt trong ngày mới được ghi: tính từ earlyCheckinMin phút trước giờ vào; vào sau giờ ca quá lateAfterMin phút
   * ghi trễ (ngưỡng của team mình). Không có ca thì không ghi (mở ứng dụng ngoài ca không thành ngày công); Lead vẫn sửa tay được.
   */
  function onSeen(u, t) {
    if (!ATT_ROLES.includes(u.role)) return;
    const d = localDate(t, off);
    const c = seen.get(u.id);
    if (c && c.date === d && t < c.until) return;
    const id = `${u.id}:${d}`;
    const a = store.attendance.get(id);
    if (a && (a.checkin_at || a.status === 'leave' || a.status === 'off')) { seen.set(u.id, { date: d, until: Infinity }); return; }
    const r = H.jobs.shiftOf(u.id, d);
    const team = teamOfUser(u);
    if (!r) { seen.set(u.id, { date: d, until: t + 10 * 60000 }); return; } // chưa có ca: xét lại sau (Lead có thể vừa xếp ca)
    if (r.start) {
      const early = atTime(d, r.start, off) - H.tcfg('earlyCheckinMin', team) * 60000;
      if (t < early) { seen.set(u.id, { date: d, until: early }); return; }
      if (t > atTime(d, r.end, off)) { seen.set(u.id, { date: d, until: Infinity }); return; }
    }
    const late = r.start ? Math.max(0, Math.round((t - atTime(d, r.start, off)) / 60000)) : 0;
    const status = r.start && late > H.tcfg('lateAfterMin', team) ? 'late' : 'present';
    const row = { user_id: u.id, date: d, checkin_at: t, late_min: status === 'late' ? late : 0, status, ot_min: a ? a.ot_min || 0 : 0, note: a ? a.note || '' : '', by_id: null };
    store.tx(() => {
      if (a) store.attendance.update(id, row); else store.attendance.insert({ id, ...row });
      log('attendance', u.id, 'checkin', `${u.name} vào ca ngày ${d.slice(8, 10)}/${d.slice(5, 7)}${status === 'late' ? `, trễ ${late} phút` : ''}${a && a.status === 'absent' ? ' (sau khi đã bị ghi vắng)' : ''}.`, u, { date: d, status, late_min: row.late_min });
      if (a && a.status === 'absent') notify({ roles: [team === 'tech' ? 'tech_lead' : 'lead'] }, 'info', 'attendance', `${u.name} đã vào ca (trễ ${late} phút) sau khi bị ghi vắng.`, 'attendance');
    });
    seen.set(u.id, { date: d, until: Infinity });
    changed('people');
    store.tx(() => { H.jobs.assignPool(team); H.jobs.rebalance(team, u.id); }); // có người vào ca thì giao các việc đang chờ, san lại việc hệ thống đã giao
  }
  /**
   * Ngày vừa thành nghỉ phép đã duyệt (Lead xếp hoặc duyệt) mà hệ thống đã tự ghi vắng: chấm công đổi thành nghỉ phép, có nhật ký.
   * Dòng Lead đã sửa tay hoặc người đó đã vào ca thì giữ nguyên (người sửa quyết định). Ngày thuộc kỳ hiệu suất đã chốt thì chấm công
   * giữ nguyên như sửa tay (PATCH chấm công cũng bị chặn), đưa vào Đối chiếu để quyết định sau khi Quản trị mở lại kỳ.
   */
  function leaveOverAbsent(u, date, actor) {
    const id = `${u.id}:${date}`, a = store.attendance.get(id);
    if (!a || a.status !== 'absent' || a.checkin_at || a.by_id) return;
    const team = teamOfUser(u), dd = `${date.slice(8, 10)}/${date.slice(5, 7)}`;
    if (isLocked(team, atTime(date, '12:00', off))) {
      H.recon('attendance', team, 'mid', 'attendance', `leave:${id}`, `${u.name} được xếp nghỉ phép ngày ${dd} nhưng chấm công đang ghi vắng và kỳ hiệu suất chứa ngày này đã chốt. Chấm công giữ nguyên; nếu đúng là nghỉ phép, Quản trị mở lại kỳ rồi Lead sửa chấm công.`, { user_id: u.id, date });
      return;
    }
    store.attendance.update(id, { status: 'leave', late_min: 0, by_id: actor.id });
    log('attendance', u.id, 'leave', `${actor.name}: ${u.name} nghỉ phép ngày ${dd}, chấm công đổi từ vắng sang nghỉ phép.`, actor, { date, from: 'absent' });
    changed('people', 'perf');
  }
  K.hooks.onSeen = (u, t) => { try { onSeen(u, t); } catch (e) { /* chấm công lỗi không được chặn thao tác của người dùng */ console.error('attendance', e && e.message); } };

  /**
   * Mỗi phút: ghi nghỉ phép đã duyệt, ghi vắng khi quá giờ vào ca mà chưa vào (việc chưa bắt đầu trả về cho người khác trong ca).
   * Dòng Lead ghi trước chỉ có tăng ca / ghi chú (chưa có trạng thái) vẫn được xét như chưa vào ca; tăng ca đã ghi được giữ.
   * Mỗi lần ghi là một giao dịch có nhật ký.
   */
  let lastPeople = 0;
  function tick(t) {
    if (t - lastPeople < 60000) return;
    lastPeople = t;
    const d = localDate(t, off);
    for (const date of [addDays(d, -1), d]) {
      for (const r of store.roster.find({ date, status: 'approved' })) {
        const id = `${r.user_id}:${date}`;
        const a = store.attendance.get(id);
        if (a && (a.checkin_at || (a.status && a.status !== 'present'))) continue;
        const keep = { ot_min: a ? a.ot_min || 0 : 0, note: a ? a.note || '' : '' };
        const u = store.users.get(r.user_id);
        const dd = `${date.slice(8, 10)}/${date.slice(5, 7)}`;
        if (r.kind === 'leave') {
          store.tx(() => {
            const row = { user_id: r.user_id, date, checkin_at: null, late_min: 0, status: 'leave', ...keep, note: r.note || keep.note, by_id: r.by_id };
            if (a) store.attendance.update(id, row); else store.attendance.insert({ id, ...row });
            log('attendance', r.user_id, 'leave', `${u ? u.name : 'Nhân viên'} nghỉ phép ngày ${dd} theo bảng phân ca đã duyệt.`, null, { date });
          });
          changed('people');
          continue;
        }
        if (!u || !u.active) continue;
        const startAt = r.start ? atTime(date, r.start, off) : atTime(date, '23:59', off);
        if (t < startAt + H.tcfg('absentAfterMin', teamOfUser(u)) * 60000) continue;
        store.tx(() => {
          const row = { user_id: r.user_id, date, checkin_at: null, late_min: 0, status: 'absent', ...keep, by_id: null };
          if (a) store.attendance.update(id, row); else store.attendance.insert({ id, ...row });
          const moved = H.jobs.onShift(u, t) ? 0 : H.jobs.releaseOf(u.id, `${u.name} chưa vào ca`); // ghi vắng cho hôm qua (ca chỉ ghi ngày) cũng trả việc
          log('attendance', u.id, 'absent', `Hệ thống ghi vắng: ${u.name} chưa vào ca ${r.start || ''} ngày ${dd}${moved ? `; ${moved} việc chưa bắt đầu trả về cho người khác trong ca` : ''}.`, null, { date, moved });
          notify({ roles: [teamOfUser(u) === 'tech' ? 'tech_lead' : 'lead'] }, 'warn', 'absent', `${u.name} chưa vào ca ${r.start || ''} ngày ${dd}${moved ? `; ${moved} việc chưa bắt đầu đã chuyển cho người khác trong ca` : ''}.`, 'attendance', `absent:${u.id}:${date}`);
        });
        changed('people');
      }
    }
  }
  R('GET', '/api/hub/attendance', G.LEADS, ({ user, q }) => {
    const team = teamOrFail(user, q.team);
    const from = isDate(q.from) ? q.from : mondayOf(today()), to = isDate(q.to) && q.to >= from ? q.to : addDays(from, 6);
    const users = membersOf(team);
    const ids = new Set(users.map((u) => u.id));
    const rows = store.attendance.find({ date: { gte: from, lte: to } }).filter((a) => ids.has(a.user_id));
    const sum = users.map((u) => {
      const mine = rows.filter((a) => a.user_id === u.id);
      const cnt = (st) => mine.filter((a) => a.status === st).length;
      return { user: { id: u.id, name: u.name, role_label: H.ROLE_LABEL[u.role] }, present: cnt('present'), late: cnt('late'), absent: cnt('absent'), leave: cnt('leave'), ot_min: mine.reduce((x, a) => x + (a.ot_min || 0), 0), late_min: mine.reduce((x, a) => x + (a.late_min || 0), 0) };
    });
    return { team, from, to, rows: rows.map(attView), summary: sum };
  });
  /** Lead sửa chấm công (quên mở ứng dụng, nghỉ phép, tăng ca). Bắt buộc lý do, có nhật ký. Chấm công của chính Lead do Quản trị sửa. */
  R('PATCH', '/api/hub/attendance/:uid/:date', G.LEADS, ({ user, p, b }) => {
    const u = store.users.get(K.idOf(p.uid));
    if (!u || !teamOfUser(u)) fail(404, 'not_found', 'Không tìm thấy nhân viên.');
    if (user.role !== 'admin' && leadTeam(user) !== teamOfUser(u)) fail(403, 'forbidden', 'Nhân viên khác team.');
    if (user.role !== 'admin' && u.id === user.id) fail(403, 'self_edit', 'Sửa chấm công, tăng ca của chính mình cần Quản trị.');
    const date = isDate(p.date) ? p.date : fail(400, 'bad_date', 'Ngày không hợp lệ.');
    if (isLocked(teamOfUser(u), atTime(date, '12:00', off))) fail(409, 'period_locked', 'Kỳ hiệu suất chứa ngày này đã chốt.');
    const id = `${u.id}:${date}`, a = store.attendance.get(id);
    // Dòng mới chỉ ghi tăng ca / ghi chú thì chưa có trạng thái: người đó vẫn tự vào ca hoặc bị ghi vắng như thường.
    const row = a ? { ...a } : { user_id: u.id, date, checkin_at: null, late_min: 0, status: null, ot_min: 0, note: '', by_id: null };
    delete row.id;
    if (b.status !== undefined) {
      if (!ATT_ST[b.status]) fail(400, 'bad_status', 'Trạng thái chấm công không hợp lệ.');
      row.status = b.status;
      if (b.status !== 'late' && b.checkin === undefined) row.late_min = 0; // đổi sang đúng giờ / vắng / nghỉ: không còn phút trễ
    }
    if (b.checkin !== undefined) {
      if (b.checkin === null || b.checkin === '') row.checkin_at = null;
      else { if (!isHM(b.checkin)) fail(400, 'bad_time', 'Giờ vào có dạng GG:PP.'); row.checkin_at = atTime(date, b.checkin, off); }
      const r = H.jobs.shiftOf(u.id, date);
      row.late_min = r && r.start && row.checkin_at ? Math.max(0, Math.round((row.checkin_at - atTime(date, r.start, off)) / 60000)) : 0;
      if (b.status === undefined && row.checkin_at) row.status = row.late_min > H.tcfg('lateAfterMin', teamOfUser(u)) ? 'late' : 'present';
      if (row.status !== 'late') row.late_min = 0;
    }
    if (b.ot_min !== undefined) row.ot_min = int(b.ot_min, 0, 720) ?? fail(400, 'bad_ot', 'Tăng ca từ 0 đến 720 phút.');
    if ((row.status === 'present' || row.status === 'late') && !row.checkin_at) row.checkin_at = atTime(date, (H.jobs.shiftOf(u.id, date) || {}).start || '08:00', off);
    const reason = reasonOf(b.reason, 'lý do sửa chấm công');
    row.note = cleanStr(reason, 200); row.by_id = user.id;
    if (a) store.attendance.update(id, row); else store.attendance.insert({ id, ...row });
    if (date === today()) seen.delete(u.id);
    log('attendance', u.id, 'edit', `${user.name} sửa chấm công ${u.name} ngày ${date}: ${row.status ? ATT_ST[row.status] : 'chưa vào ca'}${row.ot_min ? `, tăng ca ${row.ot_min} phút` : ''} (${reason}).`, user, row);
    changed('people', 'perf');
    return { attendance: attView({ id, ...row }) };
  });

  // ───────────────────────── Hiệu suất ─────────────────────────
  function lockId(team, period, key) { return `${team}:${period}:${key}`; }
  /** Thời điểm ts có nằm trong kỳ (tuần hoặc tháng) đã chốt của team không. */
  function isLocked(team, ts) {
    const d = localDate(ts, off);
    return !!(store.perf_lock.get(lockId(team, 'week', weekKey(d))) || store.perf_lock.get(lockId(team, 'month', d.slice(0, 7))));
  }
  /** Cột cần cho xu hướng 12 tuần (điểm khối lượng, đúng hạn, số thẻ, giờ quay). */
  const TREND_COLS = { jobs: ['done_at', 'done_by', 'due_at', 'std_min'], recs: ['at', 'hours', 'std_min', 'by_id'] };
  /** Cột chấm công dùng cho điểm chuyên cần, công, tăng ca, đi trễ. */
  const ATT_COLS = ['user_id', 'date', 'status', 'checkin_at', 'ot_min', 'late_min'];
  /** Cột cần cho bảng hiệu suất (metricsOf, teamSummary): không đọc các cột JSON lớn của việc và bản ghi thẻ. */
  const PERF_COLS = { jobs: ['done_at', 'done_by', 'due_at', 'due_mine', 'assignee_id', 'std_min', 'type', 'units', 'started_at', 'sla_start'], recs: ['at', 'by_id', 'std_min', 'edited_by', 'gb', 'hours'] };
  const memberSet = (team) => new Set(membersOf(team, true).map((u) => u.id));
  /**
   * Đúng hạn của team (một nguồn cho bảng hiệu suất, xu hướng, Top 3 và ô Tổng quan): việc xong có hạn do thành viên team làm.
   * Việc FO làm qua chuyến tính ở hiệu suất FO, việc người ngoài team làm giúp không tính vào đúng hạn của team.
   */
  function slaCount(jobs, memberIds, t0 = -Infinity, t1 = Infinity) {
    let n = 0, ok = 0;
    for (const j of jobs) if (j.done_at >= t0 && j.done_at < t1 && j.due_at && j.done_by && memberIds.has(j.done_by)) { n++; if (j.done_at <= j.due_at) ok++; }
    return { n, ok, pct: n ? r1((ok / n) * 100) : null };
  }
  function teamSla(team, t0, t1) {
    return slaCount(store.jobs.find({ team, status: 'done', done_at: { gte: t0, lt: t1 } }, { cols: ['done_at', 'due_at', 'done_by'] }), memberSet(team));
  }
  /** Thẻ do thành viên team nhập (tính điểm team); thẻ người ngoài team nhập giúp như Quản trị tính vào "người khác làm giúp". */
  const ownRecs = (recs, memberIds) => recs.filter((r) => r.by_id && memberIds.has(r.by_id));
  /** Gom số liệu thô của team trong khoảng ngày: việc đã xong, thẻ đã nhập, chấm công, ca. Một nguồn cho mỗi chỉ số. */
  /**
   * Dữ liệu thô của team trong khoảng ngày [from, to].
   * tMax: cắt các mốc thời gian (việc xong, thẻ nhập) tại đây, để kỳ trước chỉ tính đúng khoảng đã trôi của kỳ đang chạy.
   * dayMax: ca đã xếp sau ngày này chưa tính là ca phải làm; ca của chính ngày này chỉ tính khi đã có chấm công (có thể chưa tới giờ vào ca).
   */
  function collect(team, from, to, tMax = null, dayMax = null, cols = null) {
    const tr = tsRange({ from, to }, off), t0 = tr.t0, t1 = tMax === null ? tr.t1 : Math.min(tr.t1, tMax);
    // cols: chỉ đọc các cột cần (xu hướng nhiều tuần đọc rất nhiều dòng); cùng điều kiện lọc nên vẫn một nguồn số.
    const jobs = store.jobs.find({ team, status: 'done', done_at: { gte: t0, lt: t1 } }, cols ? { cols: cols.jobs } : {});
    const recs = team === 'tech' ? store.card_records.find({ at: { gte: t0, lt: t1 }, src: null }, cols ? { cols: cols.recs } : {}) : []; // lịch sử nhập từ file không tính điểm
    const att = store.attendance.find({ date: { gte: from, lte: to } }, { cols: ATT_COLS });
    let roster = store.roster.find({ date: { gte: from, lte: to }, status: 'approved' }, { cols: ['user_id', 'date', 'kind', 'status'] });
    if (dayMax) { const seen = new Set(att.map((a) => `${a.user_id}|${a.date}`)); roster = roster.filter((x) => x.date < dayMax || (x.date === dayMax && seen.has(`${x.user_id}|${x.date}`))); }
    // Chất lượng chỉ tính bản ghi thẻ người khác phải sửa lại. Việc hệ thống mở lại (chuyến FO huỷ, điểm không giao được) không phải lỗi
    // của người hoàn thành sau nên không tính là làm lại.
    return { from, to, t0, t1, jobs, recs, att, roster };
  }
  /** Điểm của các thẻ đã nhập: mỗi bản ghi giữ phút chuẩn lúc nhập (std_min), đổi phút chuẩn không viết lại kỳ đã qua. */
  const recPts = (recs, up = H.jobs.uploadStd()) => recs.reduce((a, r) => a + (r.std_min ?? up), 0) / 6;
  /** Chỉ số thô của một người. */
  function metricsOf(u, D) {
    const by = {};
    const add = (type, n, units, pts) => { const x = by[type] || (by[type] = { type, label: (JOB_TYPES[type] || {}).label || type, n: 0, units: 0, points: 0 }); x.n += n; x.units += units; x.points += pts; };
    let points = 0, jobsN = 0, withDue = 0, onTime = 0, rework = 0, handle = 0, handleN = 0;
    for (const j of D.jobs) {
      if (j.done_by !== u.id) continue;
      const pts = (j.std_min || 0) / 6;
      if (j.type !== 'cards_upload') { add(j.type, 1, j.units || 1, pts); jobsN++; }
      points += pts;
      if (j.due_at) { withDue++; if (j.done_at <= H.jobs.dueFor(j)) onTime++; } // hạn riêng: người nhận sau không bị tính trễ phần trước khi có việc
      if (j.started_at || j.sla_start) { handle += j.done_at - (j.started_at || j.sla_start); handleN++; }
    }
    const recs = D.recs.filter((r) => r.by_id === u.id);
    if (recs.length) { const pts = recPts(recs); add('cards_upload', recs.length, recs.length, pts); points += pts; rework += recs.filter((r) => r.edited_by && r.edited_by !== r.by_id).length; }
    const gb = recs.reduce((a, r) => a + (r.gb || 0), 0), hours = recs.reduce((a, r) => a + (r.hours || 0), 0);
    const att = D.att.filter((a) => a.user_id === u.id);
    const cnt = (st) => att.filter((a) => a.status === st).length;
    const present = cnt('present'), late = cnt('late'), absent = cnt('absent'), leave = cnt('leave');
    const shiftDays = new Set(D.roster.filter((r) => r.user_id === u.id && r.kind !== 'leave').map((r) => r.date));
    const scheduled = shiftDays.size;
    const workdays = present + late;
    const qTotal = jobsN + recs.length;
    // Chuyên cần: chỉ xét các ca đã xếp. Ca phải làm = ca đã xếp trừ ngày ca đó được ghi nghỉ phép (ngày phép không có ca thì đã không
    // nằm trong số ca, không trừ thêm). Có mặt ngoài ca vẫn là công nhưng không bù cho ca vắng. Không có ca nào: tính trên số công.
    const onShiftAtt = att.filter((a) => shiftDays.has(a.date));
    const cntS = (st) => onShiftAtt.filter((a) => a.status === st).length;
    const due = scheduled - cntS('leave');
    const attPct = due > 0 ? Math.max(0, Math.min(100, (100 * (cntS('present') + 0.5 * cntS('late'))) / due)) : workdays ? (100 * (present + 0.5 * late)) / workdays : null;
    return {
      points: r1(points), jobs: jobsN, uploads: recs.length, gb: r1(gb), hours: r1(hours), with_due: withDue, on_time: onTime, late_jobs: withDue - onTime,
      sla_pct: withDue ? r1((onTime / withDue) * 100) : null, rework, quality: qTotal ? r1(100 * (1 - rework / qTotal)) : null,
      workdays, scheduled, present, late_days: late, absent, leave, ot_min: att.reduce((a, x) => a + (x.ot_min || 0), 0), late_min: att.reduce((a, x) => a + (x.late_min || 0), 0),
      ppd: workdays ? r1(points / workdays) : null, avg_handle_min: handleN ? Math.round(handle / handleN / 60000) : null,
      by_type: Object.values(by).map((x) => ({ ...x, points: r1(x.points) })).sort((a, b) => b.points - a.points),
      att_pct: attPct, // chỉ dùng để tính điểm chuyên cần (s_att), không gửi ra ngoài
    };
  }
  /**
   * Điểm khối lượng 0–100: 80 × điểm/công ÷ TB điểm/công của team. Chưa có trung bình (không ai đủ số liệu) thì bỏ; cả team cùng 0 điểm
   * thì khối lượng 0 là số thật (điểm 0), không bị bỏ như "chưa có số".
   */
  const volOf = (ppd, avg) => (ppd === null || avg === null || avg === undefined ? null : avg > 0 ? Math.max(0, Math.min(100, (80 * ppd) / avg)) : 0);
  /** Điểm thành phần 0–100 và điểm tổng hợp theo trọng số của team (bỏ thành phần không có dữ liệu, chia lại trọng số). */
  function scoreOf(m, teamAvgPpd, team) {
    const w = H.tcfg('scoreWeights', team) || {};
    const s = { vol: volOf(m.ppd, teamAvgPpd), sla: m.sla_pct, quality: m.quality, att: m.att_pct };
    let sum = 0, ws = 0;
    for (const k of ['vol', 'sla', 'quality', 'att']) if (s[k] !== null && s[k] !== undefined && w[k]) { sum += s[k] * w[k]; ws += w[k]; }
    return { s_vol: r1(s.vol), s_sla: r1(s.sla), s_quality: r1(s.quality), s_att: r1(s.att), score: ws ? r1(sum / ws) : null };
  }
  function ratingOf(score, team) {
    const b = H.tcfg('scoreBands', team) || [90, 80, 65, 50];
    if (score === null) return null;
    return score >= b[0] ? 5 : score >= b[1] ? 4 : score >= b[2] ? 3 : score >= b[3] ? 2 : 1;
  }
  /** Gộp dữ liệu thô của nhiều khoảng (trung bình 4 tuần trước khi so cùng kỳ). */
  const mergeD = (list) => ({ from: list[0].from, to: list[list.length - 1].to, jobs: list.flatMap((x) => x.jobs), recs: list.flatMap((x) => x.recs), att: list.flatMap((x) => x.att), roster: list.flatMap((x) => x.roster) });
  /**
   * Dữ liệu kỳ này, kỳ trước và 4 tuần trước theo khung so sánh H.compare: kỳ đang chạy thì kỳ trước và từng tuần trong 4 tuần trước
   * chỉ lấy đúng phần thời gian đã trôi của kỳ này (WoW / MoM cùng kỳ), ca chưa tới không tính là vắng.
   */
  function collectCmp(team, P) {
    const C = H.compare(P);
    const D = collect(team, P.from, P.to, null, C.running ? C.day.cur.to : null, PERF_COLS);
    const Dp = collect(team, C.day.prev.from, C.day.prev.to, C.ts.prev.t1, C.running ? C.day.prev.to : null, PERF_COLS);
    let D4 = null;
    if (P.period === 'week') {
      const elapsed = C.ts.cur.t1 - C.ts.cur.t0, n = C.day.cur.to === P.to ? 6 : Math.round((Date.parse(C.day.cur.to) - Date.parse(P.from)) / 86400000);
      D4 = mergeD([4, 3, 2, 1].map((k) => { const w = weekRange(shiftWeek(P.key, -k)), t0 = tsRange(w, off).t0, last = addDays(w.from, n); return collect(team, w.from, last, C.running ? t0 + elapsed : null, C.running ? last : null, PERF_COLS); }));
    }
    return { C, D, Dp, D4 };
  }
  /** Bảng hiệu suất của team trong một kỳ, kèm kỳ trước (WoW / MoM) và trung bình 4 tuần trước khi xem theo tuần. */
  function compute(team, period, key) {
    const P = periodOf(period, key, today());
    const c = H.cfg();
    const minDays = H.tcfg(P.period === 'month' ? 'minDaysMonth' : 'minDaysWeek', team, c);
    const { C, D, Dp, D4 } = collectCmp(team, P);
    const users = new Map();
    for (const u of membersOf(team, true)) users.set(u.id, u);
    const active = [...users.values()].filter((u) => u.active || D.jobs.some((j) => j.done_by === u.id) || D.recs.some((r) => r.by_id === u.id) || D.att.some((a) => a.user_id === u.id));
    const rows = active.map((u) => ({ u, m: metricsOf(u, D), mp: metricsOf(u, Dp), m4: D4 ? metricsOf(u, D4) : null }));
    const isLeadRole = (u) => LEAD_ROLES.includes(u.role);
    const staff = rows.filter((x) => !isLeadRole(x.u));
    const eligible = staff.filter((x) => x.m.workdays >= minDays && x.m.ppd !== null);
    // Người góp vào TB điểm/công (kỳ này, kỳ trước): ghi lại để trang "Hiệu suất của tôi" biết số đó có lộ số của người khác không.
    const avgCur = (eligible.length ? eligible : staff).filter((x) => x.m.ppd !== null), avgPrev = staff.filter((x) => x.mp.workdays >= minDays && x.mp.ppd !== null);
    const avgPpd = (list, k) => (list.length ? list.reduce((a, x) => a + x[k].ppd, 0) / list.length : null);
    const teamAvg = avgPpd(avgCur, 'm');
    const teamAvgPrev = avgPpd(avgPrev, 'mp');
    const rateOff = team === 'logistics' && !c.rateLogistics;
    const out = rows.map(({ u, m: mAll, mp, m4 }) => {
      const { att_pct: _a, ...m } = mAll;
      let sc = scoreOf(mAll, teamAvg, team), scp = scoreOf(mp, teamAvgPrev, team);
      let reason = '';
      if (isLeadRole(u)) {
        reason = 'Lead không xếp loại theo khối lượng';
        sc = { ...sc, s_vol: null, score: null }; scp = { ...scp, score: null }; // không có điểm tổng hợp cho vai không xếp loại
      } else if (rateOff) reason = 'Chưa xếp loại Logistics (Cài đặt)';
      else if (m.workdays < minDays) reason = `Dưới ${minDays} công trong kỳ`;
      const rated = !reason && sc.score !== null;
      const rating = rated ? ratingOf(sc.score, team) : null;
      return {
        user: { id: u.id, name: u.name, role: u.role, role_label: H.ROLE_LABEL[u.role], active: !!u.active }, ...m, ...sc,
        prev_points: mp.points, delta_pct: pct(m.points, mp.points), prev_sla_pct: mp.sla_pct, prev_score: scp.score, prev_ppd: mp.ppd,
        avg4_points: m4 ? r1(m4.points / 4) : null, vs_avg4_pct: m4 && m4.points ? pct(m.points, m4.points / 4) : null,
        rated, rating, rating_label: rating ? RATING[rating] : '', not_rated_reason: reason,
      };
    }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.points - a.points);
    // Top 3 chỉ gồm người đã xếp loại và có khối lượng trong kỳ.
    const top3 = out.filter((x) => x.rated && x.points > 0).sort((a, b) => b.score - a.score || (b.sla_pct ?? 0) - (a.sla_pct ?? 0) || b.points - a.points).slice(0, 3)
      .map((x) => ({ user: x.user, score: x.score, rating: x.rating, rating_label: x.rating_label, points: x.points, sla_pct: x.sla_pct, ppd: x.ppd, delta_pct: x.delta_pct }));
    return { P, C, D, Dp, D4, rows: out, top3, teamAvg, avgIds: { cur: avgCur.map((x) => x.u.id), prev: avgPrev.map((x) => x.u.id) }, summary: teamSummary(team, P, D, Dp, D4) };
  }
  /**
   * Tổng của team: khối lượng, đúng hạn, công, tỉ trọng theo loại việc, điểm theo ngày. Việc người ngoài team hoàn thành tách riêng:
   * FO làm qua chuyến (fo_points, chỉ người có vai FO) và người khác như Quản trị làm giúp (other_points).
   */
  function teamSummary(team, P, D, Dp, D4) {
    const memberIds = memberSet(team);
    const foIds = new Set(store.users.find({ role: 'fo' }).map((u) => u.id));
    const agg = (X) => {
      if (!X) return null;
      let points = 0, jobs = 0, fo = 0, other = 0;
      const by = {};
      const sla = slaCount(X.jobs, memberIds), recs = ownRecs(X.recs, memberIds);
      other += recPts(X.recs.filter((r) => !(r.by_id && memberIds.has(r.by_id))));
      for (const j of X.jobs) {
        const pts = (j.std_min || 0) / 6;
        if (j.done_by && !memberIds.has(j.done_by)) { if (foIds.has(j.done_by)) fo += pts; else other += pts; continue; }
        points += pts; if (j.type !== 'cards_upload') { jobs++; const x = by[j.type] || (by[j.type] = { type: j.type, label: (JOB_TYPES[j.type] || {}).label || j.type, n: 0, points: 0 }); x.n++; x.points += pts; }
      }
      if (recs.length) { const pts = recPts(recs); points += pts; by.cards_upload = { type: 'cards_upload', label: JOB_TYPES.cards_upload.label, n: recs.length, points: pts }; }
      const workdays = X.att.filter((a) => memberIds.has(a.user_id) && (a.status === 'present' || a.status === 'late')).length;
      const list = Object.values(by).sort((a, b) => b.points - a.points);
      return {
        points: r1(points), jobs, uploads: recs.length, gb: r1(recs.reduce((a, r) => a + (r.gb || 0), 0)), hours: r1(recs.reduce((a, r) => a + (r.hours || 0), 0)),
        sla_pct: sla.pct, on_time: sla.ok, with_due: sla.n, workdays, ppd: workdays ? r1(points / workdays) : null, fo_points: r1(fo), other_points: r1(other),
        by_type: list.map((x) => ({ ...x, points: r1(x.points), share: points ? r1((x.points / points) * 100) : 0 })),
      };
    };
    const cur = agg(D), prev = agg(Dp), avg4 = agg(D4);
    const daily = [];
    for (let d = P.from; d <= P.to; d = addDays(d, 1)) {
      const t0 = atTime(d, '00:00', off), t1 = t0 + 86400000;
      let p = 0;
      for (const j of D.jobs) if (j.done_at >= t0 && j.done_at < t1 && (!j.done_by || memberIds.has(j.done_by))) p += (j.std_min || 0) / 6;
      p += recPts(ownRecs(D.recs, memberIds).filter((r) => r.at >= t0 && r.at < t1));
      daily.push({ date: d, points: r1(p) });
    }
    return {
      ...cur, prev: prev, avg4: avg4 ? { points: r1(avg4.points / 4), sla_pct: avg4.sla_pct, ppd: avg4.ppd, uploads: r1(avg4.uploads / 4), hours: r1(avg4.hours / 4) } : null,
      wow_pct: pct(cur.points, prev.points), vs_avg4_pct: avg4 ? pct(cur.points, avg4.points / 4) : null, daily,
    };
  }
  // ───────────────────────── Field Ops (thuộc Logistics) ─────────────────────────
  /**
   * Số liệu FO trong khoảng ngày, lấy từ chuyến trên Rider Live: điểm của việc hub đi theo chuyến, điểm giao nhận không gắn việc hub
   * (phút chuẩn foStopStd), chuyến đúng hạn, điểm không giao được, BO báo lệch, km. Không chứa vị trí; chỉ Logistic Lead và Quản trị xem.
   */
  function foCollect(from, to, tMax = null) {
    const c = H.cfg();
    const tr = tsRange({ from, to }, off), t0 = tr.t0, t1 = tMax === null ? tr.t1 : Math.min(tr.t1, tMax), cut = tMax === null ? Infinity : t1;
    const fos = new Map(store.users.find({ role: 'fo' }).map((u) => [u.id, u]));
    const out = new Map();
    const get = (id) => { let x = out.get(id); if (!x) { x = { hub_points: 0, stop_points: 0, days: new Set(), tasks: 0, completed: 0, ontime: 0, late: 0, failed: 0, stops_done: 0, stops_failed: 0, bo_mismatch: 0, km: 0 }; out.set(id, x); } return x; };
    for (const j of store.jobs.find({ team: 'logistics', status: 'done', done_at: { gte: t0, lt: t1 } }, { cols: ['done_by', 'std_min'] })) if (j.done_by && fos.has(j.done_by)) get(j.done_by).hub_points += (j.std_min || 0) / 6;
    const taskFo = new Map();
    for (const t of store.tasks.find({ date: { gte: from, lte: to } }, { cols: ['fo_id', 'status', 'date', 'finished_at', 'late'] })) {
      if (!t.fo_id || !fos.has(t.fo_id) || t.status === 'cancelled') continue;
      const x = get(t.fo_id);
      x.tasks++; x.days.add(t.date); taskFo.set(t.id, t.fo_id);
      const fin = !t.finished_at || t.finished_at < cut; // kỳ trước khi so cùng kỳ: chuyến kết thúc sau mốc cắt coi như chưa xong lúc đó
      if (fin && t.status === 'completed') { x.completed++; if (t.late) x.late++; else x.ontime++; } else if (fin && t.status === 'failed') x.failed++;
    }
    const ids = [...taskFo.keys()];
    for (let i = 0; i < ids.length; i += 400) {
      for (const st of store.stops.find({ task_id: ids.slice(i, i + 400) }, { cols: ['task_id', 'done_at', 'status', 'is_return', 'hub', 'bo_status'] })) {
        const x = get(taskFo.get(st.task_id));
        if (st.done_at && st.done_at >= cut) continue;
        if (st.status === 'done') {
          x.stops_done++;
          if (!st.is_return && !(st.hub && (st.hub.jobs || []).length)) x.stop_points += (c.foStopStd || 0) / 6;
          if (st.bo_status === 'mismatch') x.bo_mismatch++;
        } else if (st.status === 'failed') x.stops_failed++;
      }
    }
    for (const d of store.daily.find({ date: { gte: from, lte: to } }, { cols: ['user_id', 'km'] })) if (fos.has(d.user_id)) get(d.user_id).km += d.km || 0;
    return { fos, out };
  }
  function foMetrics(x) {
    if (!x) return { points: 0, hub_points: 0, stop_points: 0, workdays: 0, tasks: 0, completed: 0, ontime: 0, late: 0, failed: 0, stops_done: 0, stops_failed: 0, bo_mismatch: 0, km: 0, ppd: null, sla_pct: null, quality: null };
    const points = x.hub_points + x.stop_points, workdays = x.days.size, handled = x.stops_done + x.stops_failed;
    return {
      points: r1(points), hub_points: r1(x.hub_points), stop_points: r1(x.stop_points), workdays, tasks: x.tasks, completed: x.completed, ontime: x.ontime, late: x.late, failed: x.failed,
      stops_done: x.stops_done, stops_failed: x.stops_failed, bo_mismatch: x.bo_mismatch, km: r1(x.km), ppd: workdays ? r1(points / workdays) : null,
      sla_pct: x.completed ? r1((x.ontime / x.completed) * 100) : null, quality: handled ? r1(100 * (1 - (x.stops_failed + x.bo_mismatch) / handled)) : null,
    };
  }
  /** Bảng Field Ops: FO thuộc Logistics nên dùng ngưỡng, trọng số của Logistics và theo công tắc xếp loại Logistics. */
  function foBlock(P) {
    const c = H.cfg();
    const minDays = H.tcfg(P.period === 'month' ? 'minDaysMonth' : 'minDaysWeek', 'logistics', c);
    const rateOff = !c.rateLogistics;
    const C = H.compare(P); // kỳ đang chạy: kỳ trước chỉ tính tới cùng mốc thời gian
    const A = foCollect(P.from, P.to), B = foCollect(C.day.prev.from, C.day.prev.to, C.ts.prev.t1);
    const list = [...A.fos.values()].filter((u) => u.active || A.out.has(u.id)).sort((a, b) => a.name.localeCompare(b.name));
    const rows = list.map((u) => ({ u, m: foMetrics(A.out.get(u.id)), mp: foMetrics(B.out.get(u.id)) }));
    const avg = (k) => { const v = rows.filter((x) => x[k].workdays >= minDays && x[k].ppd !== null).map((x) => x[k].ppd); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const avgPpd = avg('m'), avgPrev = avg('mp');
    const w = H.tcfg('scoreWeights', 'logistics', c) || {};
    const score = (m, base) => {
      const sv = { vol: volOf(m.ppd, base), sla: m.sla_pct, quality: m.quality };
      let sum = 0, ws = 0;
      for (const k of ['vol', 'sla', 'quality']) if (sv[k] !== null && w[k]) { sum += sv[k] * w[k]; ws += w[k]; }
      return { s_vol: r1(sv.vol), s_sla: r1(sv.sla), s_quality: r1(sv.quality), score: ws ? r1(sum / ws) : null };
    };
    const out = rows.map(({ u, m, mp }) => {
      const sc = score(m, avgPpd), scp = score(mp, avgPrev);
      const reason = rateOff ? 'Chưa xếp loại Logistics (Cài đặt)' : m.workdays < minDays ? `Dưới ${minDays} ngày chạy trong kỳ` : '';
      const rated = !reason && sc.score !== null;
      const rating = rated ? ratingOf(sc.score, 'logistics') : null;
      return { user: { id: u.id, name: u.name, role: 'fo', role_label: H.ROLE_LABEL.fo, active: !!u.active }, ...m, ...sc, prev_points: mp.points, delta_pct: pct(m.points, mp.points), prev_sla_pct: mp.sla_pct, prev_score: scp.score, rated, rating, rating_label: rating ? RATING[rating] : '', not_rated_reason: reason };
    }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.points - a.points);
    const top3 = out.filter((x) => x.rated && x.points > 0).sort((a, b) => b.score - a.score || (b.sla_pct ?? 0) - (a.sla_pct ?? 0) || b.points - a.points).slice(0, 3)
      .map((x) => ({ user: x.user, score: x.score, rating: x.rating, rating_label: x.rating_label, points: x.points, sla_pct: x.sla_pct, ppd: x.ppd, delta_pct: x.delta_pct }));
    const sum = (k, arr) => r1(arr.reduce((a, x) => a + (x[k] || 0), 0));
    return {
      rows: out, top3, avg_ppd: r1(avgPpd), stop_std: c.foStopStd, rate_off: rateOff,
      summary: { points: sum('points', out), prev_points: sum('prev_points', out), delta_pct: pct(sum('points', out), sum('prev_points', out)), stops_done: sum('stops_done', out), completed: sum('completed', out), ontime: sum('ontime', out), km: sum('km', out), sla_pct: (() => { const c2 = sum('completed', out); return c2 ? r1((sum('ontime', out) / c2) * 100) : null; })() },
    };
  }

  /**
   * snap: xem bản số liệu lúc chốt của lần mở lại gần nhất (giữ trong kho chốt kỳ, chỉ đọc qua bảng hiệu suất của đúng team),
   * không đưa vào nhật ký thao tác vì nhật ký không chia theo team.
   */
  // Bảng hiệu suất đọc nhiều tuần việc, thẻ, chấm công: nhớ (H.memo) tới khi một trong các bảng đó đổi. Kỳ đang chạy so cùng mốc
  // thời gian với kỳ trước nên còn đổi theo giờ: tính lại sau PERF_TTL ms dù không ai ghi. Người gọi chỉ đọc, không sửa kết quả.
  const PERF_TTL = 5000;
  function perfPayload(team, period, key, snap = false) {
    const P = periodOf(period, key, today());
    return H.memo(`perf|${team}|${P.period}|${P.key}|${snap ? 1 : 0}|${today()}`, () => perfPayloadRaw(team, P, snap), PERF_TTL);
  }
  function perfPayloadRaw(team, P, snap) {
    const lock = store.perf_lock.get(lockId(team, P.period, P.key));
    const arc = store.perf_lock.get(`reopened:${lockId(team, P.period, P.key)}`);
    const last = arc && arc.data && arc.data.list && arc.data.list[arc.data.list.length - 1];
    const reopened = last ? { at: last.at, by: H.userName(last.by_id), reason: last.reason, n: arc.data.list.length } : null;
    if (snap) {
      if (!last) fail(404, 'not_reopened', 'Kỳ này chưa từng mở lại sau khi chốt.');
      return { ...last.data, locked: { by: H.userName(last.locked_by), at: last.locked_at }, snapshot: reopened };
    }
    if (lock) return { ...lock.data, locked: { by: H.userName(lock.by_id), at: lock.at } };
    const r = compute(team, P.period, P.key);
    const c = H.cfg();
    return {
      team, period: P.period, key: P.key, label: P.period === 'month' ? monthLabel(P.key) : weekLabel(P.key), prev_label: P.period === 'month' ? monthLabel(P.prev) : weekLabel(P.prev),
      from: P.from, to: P.to, cmp: r.C.info, summary: r.summary, rows: r.rows, top3: r.top3, team_avg_ppd: r1(r.teamAvg), avg_ids: r.avgIds,
      weights: H.tcfg('scoreWeights', team, c), bands: H.tcfg('scoreBands', team, c), // trọng số, ngưỡng của đúng team
      min_days: H.tcfg(P.period === 'month' ? 'minDaysMonth' : 'minDaysWeek', team, c), rate_off: team === 'logistics' && !c.rateLogistics, locked: null,
      fo: team === 'logistics' ? foBlock(P) : null, reopened,
      note: 'Phút chuẩn và trọng số là đề xuất; dùng để theo dõi xu hướng và cân tải, chưa dùng làm căn cứ khen thưởng hay kỷ luật cho tới khi định mức được bấm giờ thật.',
    };
  }
  R('GET', '/api/hub/perf', G.LEADS, ({ user, q }) => perfPayload(teamOrFail(user, q.team), q.period === 'month' ? 'month' : 'week', q.key, !!q.snapshot && q.snapshot !== '0'));
  /**
   * Thành viên xem kết quả của chính mình, so với trung bình team (không thấy tên hay số của người khác).
   * Chống lộ số qua phép tính ngược: mọi trung bình team gửi ra tính trên đúng nhóm người góp vào TB điểm/công dùng cho điểm khối
   * lượng (đủ công, có số), bỏ chính người xem, chỉ tính người có số, và chỉ gửi khi có từ 2 người khác góp. Hai nhóm khác nhau
   * (vd. một người dưới số công tối thiểu có trong nhóm này mà không có trong nhóm kia) thì trừ hai con số là ra số của người đó.
   * Điểm khối lượng và các số suy từ nó (điểm tổng hợp, mức) chỉ gửi khi TB đó có từ 2 người khác góp; ít hơn thì ẩn, Lead vẫn thấy đủ.
   */
  const MIN_PEERS = 2;
  R('GET', '/api/hub/perf/me', G.OPS_STAFF, ({ user, q }) => {
    const team = teamOfUser(user);
    if (!team) fail(403, 'forbidden', 'Chỉ thành viên Tech và Logistics có bảng hiệu suất.');
    const all = perfPayload(team, q.period === 'month' ? 'month' : 'week', q.key);
    let me = all.rows.find((x) => x.user.id === user.id) || null;
    const staff = all.rows.filter((x) => !LEAD_ROLES.includes(x.user.role));
    // Kỳ đã chốt trước khi có avg_ids: suy ra người góp TB như lúc tính (đủ công và có điểm/công); kỳ trước không biết thì ẩn.
    const ids = all.avg_ids || { cur: staff.filter((x) => x.ppd !== null && x.workdays >= (all.min_days || 0)).map((x) => x.user.id), prev: null };
    const peers = new Set((ids.cur || []).filter((id) => id !== user.id));
    const others = staff.filter((x) => peers.has(x.user.id));
    const avg = (k) => { const v = others.map((x) => x[k]).filter((x) => x !== null && x !== undefined); return v.length >= MIN_PEERS ? r1(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    const ta = { points: avg('points'), ppd: avg('ppd'), sla_pct: avg('sla_pct'), score: avg('score') };
    if (me && !LEAD_ROLES.includes(me.user.role)) {
      const n = (list) => (list ? list.filter((id) => id !== user.id).length : 0);
      if (me.s_vol !== null && n(ids.cur) < MIN_PEERS) {
        me = { ...me, s_vol: null, score: null, rated: false, rating: null, rating_label: '', not_rated_reason: 'Team chưa đủ người có số liệu để so khối lượng mà không lộ số của người khác; Lead của team vẫn xem được mức của bạn.' };
      }
      if (me.prev_score !== null && n(ids.prev) < MIN_PEERS) me = { ...me, prev_score: null };
    }
    return {
      team, period: all.period, key: all.key, label: all.label, prev_label: all.prev_label, from: all.from, to: all.to, cmp: all.cmp || null, me, locked: all.locked, note: all.note,
      weights: all.weights, // trọng số điểm tổng hợp (Cài đặt) để trang "Hiệu suất của tôi" giải thích các thành phần điểm
      team_avg: Object.values(ta).some((x) => x !== null) ? ta : null, avg_n: others.length, // số người khác góp vào TB (cùng nhóm với TB điểm/công)
      in_top3: !!(me && me.rated && all.top3.some((x) => x.user.id === user.id)), members: staff.length,
    };
  });
  /** Xu hướng theo tuần của team (biểu đồ), một lượt đọc dữ liệu cho cả dải tuần. */
  function trend(team, weeks, endKey) {
    const end = endKey && weekRange(endKey) ? endKey : weekKey(today());
    return H.memo(`trend|${team}|${weeks}|${end}`, () => trendRaw(team, weeks, end));
  }
  function trendRaw(team, weeks, end) {
    const first = shiftWeek(end, -(weeks - 1));
    const D = collect(team, weekRange(first).from, weekRange(end).to, null, null, TREND_COLS);
    const memberIds = memberSet(team), own = ownRecs(D.recs, memberIds);
    const out = [];
    for (let i = 0; i < weeks; i++) {
      const k = shiftWeek(first, i), wr = weekRange(k), tr = tsRange(wr, off);
      let points = 0;
      for (const j of D.jobs) {
        if (j.done_at < tr.t0 || j.done_at >= tr.t1 || (j.done_by && !memberIds.has(j.done_by))) continue;
        points += (j.std_min || 0) / 6;
      }
      const sla = slaCount(D.jobs, memberIds, tr.t0, tr.t1);
      const recs = own.filter((r) => r.at >= tr.t0 && r.at < tr.t1);
      points += recPts(recs);
      const workdays = D.att.filter((a) => memberIds.has(a.user_id) && a.date >= wr.from && a.date <= wr.to && (a.status === 'present' || a.status === 'late')).length;
      out.push({ key: k, label: weekLabel(k), points: r1(points), sla_pct: sla.pct, workdays, ppd: workdays ? r1(points / workdays) : null, uploads: recs.length, hours: r1(recs.reduce((a, r) => a + (r.hours || 0), 0)) });
    }
    return out;
  }
  R('GET', '/api/hub/perf/trend', G.LEADS, ({ user, q }) => ({ team: teamOrFail(user, q.team), weeks: trend(teamOrFail(user, q.team), Math.min(26, int(q.weeks, 4, 26) || 12), q.key) }));
  R('POST', '/api/hub/perf/lock', G.LEADS, ({ user, b }) => {
    const team = teamOrFail(user, b.team);
    const P = periodOf(b.period === 'month' ? 'month' : 'week', b.key, today());
    const id = lockId(team, P.period, P.key);
    if (store.perf_lock.get(id)) fail(409, 'locked', 'Kỳ này đã chốt.');
    if (P.to >= today()) fail(400, 'not_ended', 'Chỉ chốt được kỳ đã kết thúc.');
    const data = perfPayload(team, P.period, P.key);
    store.perf_lock.insert({ id, by_id: user.id, at: now(), data });
    log('perf', null, 'lock', `${user.name} chốt hiệu suất ${team === 'tech' ? 'Tech' : 'Logistics'} ${data.label}. Số liệu kỳ này được giữ nguyên.`, user, { team, period: P.period, key: P.key });
    changed('perf');
    return { ok: true };
  });
  /**
   * Quản trị mở lại kỳ đã chốt: kiểm lý do trước khi bỏ chốt. Bản số liệu đã chốt được giữ trong kho chốt kỳ (Lead của team xem lại
   * được trên bảng hiệu suất); nhật ký chỉ ghi kỳ nào, team nào, không chứa bảng điểm từng người.
   */
  R('POST', '/api/hub/perf/unlock', ['admin'], ({ user, b }) => {
    const team = b.team === 'logistics' ? 'logistics' : 'tech';
    const P = periodOf(b.period === 'month' ? 'month' : 'week', b.key, today());
    const reason = reasonOf(b.reason, 'lý do mở lại');
    const id = lockId(team, P.period, P.key), lock = store.perf_lock.get(id);
    if (!lock) fail(404, 'not_locked', 'Kỳ này chưa chốt.');
    store.perf_lock.remove(id);
    const aid = `reopened:${id}`, arc = store.perf_lock.get(aid);
    const list = [...((arc && arc.data && arc.data.list) || []), { at: now(), by_id: user.id, reason, locked_by: lock.by_id, locked_at: lock.at, data: lock.data }].slice(-5);
    if (arc) store.perf_lock.update(aid, { by_id: user.id, at: now(), data: { list } }); else store.perf_lock.insert({ id: aid, by_id: user.id, at: now(), data: { list } });
    log('perf', null, 'unlock', `${user.name} mở lại kỳ ${P.key} của ${team === 'tech' ? 'Tech' : 'Logistics'} (chốt bởi ${H.userName(lock.by_id) || 'không rõ'}): ${reason}.`, user, { team, period: P.period, key: P.key, locked_by: lock.by_id });
    changed('perf');
    return { ok: true };
  });
  R('GET', '/api/hub/perf.csv', G.LEADS, ({ user, q }) => {
    const d = perfPayload(teamOrFail(user, q.team), q.period === 'month' ? 'month' : 'week', q.key);
    const head = ['Kỳ', 'Nhân sự', 'Vai trò', 'Điểm khối lượng', 'Kỳ trước', 'Thay đổi %', 'Số việc', 'Thẻ đã nhập', 'GB', 'Giờ ghi hình', 'Đúng hạn %', 'Việc trễ', 'Chất lượng %', 'Công', 'Ca xếp', 'Trễ (ngày)', 'Vắng', 'Nghỉ phép', 'Tăng ca (phút)', 'Điểm/công', 'Khối lượng', 'Đúng hạn', 'Chất lượng', 'Chuyên cần', 'Điểm tổng hợp', 'Mức', 'Ghi chú'];
    const lines = [head.map(csvCell).join(',')];
    for (const r of d.rows) lines.push([d.label, r.user.name, r.user.role_label, r.points, r.prev_points, r.delta_pct, r.jobs, r.uploads, r.gb, r.hours, r.sla_pct, r.late_jobs, r.quality, r.workdays, r.scheduled, r.late_days, r.absent, r.leave, r.ot_min, r.ppd, r.s_vol, r.s_sla, r.s_quality, r.s_att, r.score, r.rating_label, r.not_rated_reason].map(csvCell).join(','));
    if (d.fo) for (const r of d.fo.rows) lines.push([d.label, r.user.name, r.user.role_label, r.points, r.prev_points, r.delta_pct, r.stops_done, '', '', '', r.sla_pct, r.late, r.quality, r.workdays, '', '', '', '', '', r.ppd, r.s_vol, r.s_sla, r.s_quality, '', r.score, r.rating_label, r.not_rated_reason].map(csvCell).join(','));
    return { __csv: { name: `hieu-suat-${d.team}-${d.key}.csv`, text: '\ufeff' + lines.join('\r\n') + '\r\n' } };
  });

  // ───────────────────────── Trang "Của tôi" ─────────────────────────
  R('GET', '/api/hub/me', G.STAFF, ({ user }) => {
    const d = today();
    const team = teamOfUser(user);
    const a = store.attendance.get(`${user.id}:${d}`);
    const shift = team ? H.jobs.shiftOf(user.id, d) : null;
    const t0 = atTime(d, '00:00', off);
    return {
      user: { id: user.id, name: user.name, role: user.role, role_label: H.ROLE_LABEL[user.role], team: H.TEAM_OF[user.role] },
      today: d, attendance: a ? attView(a) : null, shift: shift ? rosterView(shift) : null, on_shift: team ? H.jobs.onShift(user) : null,
      jobs: team ? { open: store.jobs.count({ assignee_id: user.id, status: ['open', 'doing'] }), done_today: store.jobs.count({ done_by: user.id, done_at: { gte: t0 } }), overdue: store.jobs.find({ assignee_id: user.id, status: ['open', 'doing'] }).filter((j) => j.due_at && j.due_at < now() && !j.blocked).length } : null,
      unread: store.inbox.count({ user_id: user.id, read_at: null }),
    };
  });

  return { tick, onSeen, isLocked, compute, perfPayload, trend, teamOfUser, collect, metricsOf, foBlock, teamSla, TEAM_ROLES };
}
