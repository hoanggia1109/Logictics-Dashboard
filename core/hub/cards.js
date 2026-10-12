// cards.js — thẻ nhớ theo mã: phiếu bàn giao Logistics ↔ Tech (một phiếu nhiều BO, bên gửi lập, bên nhận xác nhận,
// phiếu đã xác nhận hoặc đã huỷ thì khoá), Tech nhập dung lượng (nhập GB, giờ là số tính ra), Tech trả thẻ về Logistics.
// Số giờ ghi hình của BO chỉ lấy từ đây (card_records): một chỉ số, một nguồn.
import { cleanStr, cleanText, int, num, isDate, localDate, addDays, boLabel } from '../util.js';
import { fail } from '../core.js';
import { CARD_ST, ZERO_REASONS } from './defs.js';

const HO_ST = { sent: 'Chờ bên nhận xác nhận', received: 'Đã nhận', cancelled: 'Đã huỷ' };
const DIR = { to_tech: 'Logistics → Tech', to_log: 'Tech → Logistics' };
/** Trạng thái thẻ được đưa vào phiếu, và trạng thái sau khi bên nhận xác nhận. */
const FROM_ST = { to_tech: 'returned', to_log: 'uploaded' };
const MID_ST = { to_tech: 'to_tech', to_log: 'to_log' };
const RECV_ST = { to_tech: 'at_tech', to_log: 'office' };
const RECV_JOB = { to_tech: 'cards_receive', to_log: 'cards_back' };
/** Trạng thái thẻ mà giờ quay trên thẻ chưa được nhập (ghi hỏng / thất lạc lúc này thì có thể thiếu giờ quay). */
const FOOTAGE_PENDING = ['at_bo', 'returned', 'at_tech'];
const ZERO_MIN = 10; // lý do 0 giờ tự ghi (hoặc "Khác: …") cần đủ dài để người đọc hiểu

export function installCards(H) {
  const { K, G, store, now, off, today, log, changed, notify, reasonOf, idList, codesOf } = H;
  const { R } = K;
  const SENDER = { to_tech: G.LOGI, to_log: G.TECH };
  const RECEIVER = { to_tech: G.TECH, to_log: G.LOGI };
  const TEAM = { to_tech: 'logistics', to_log: 'tech' };
  const hoursOf = (gb) => +(gb / H.cfg().gbPerHour).toFixed(2);
  const isTechLead = (u) => u.role === 'admin' || u.role === 'tech_lead';
  const isLead = (u) => u.role === 'admin' || u.role === 'tech_lead' || u.role === 'lead';

  function cardView(c) {
    const kit = c.kit_id ? H.rowOf('kits', c.kit_id) : null;
    return {
      id: c.id, code: c.code, status: c.status, status_label: CARD_ST[c.status] || c.status, site: c.site_id ? { id: c.site_id, name: H.siteName(c.site_id) } : null,
      kit: kit ? { id: kit.id, code: kit.code } : null, since: c.since, bo_in: c.bo_in, bo_out: c.bo_out, handover_id: c.handover_id, task_id: c.task_id, note: c.note || '',
    };
  }
  function cardOrFail(id) { const c = store.cards.get(K.idOf(id)); if (!c) fail(404, 'not_found', 'Không tìm thấy thẻ.'); return c; }
  const dm = (ts) => { const d = localDate(ts, off); return `${d.slice(8, 10)}/${d.slice(5, 7)}`; };
  /**
   * Thẻ hỏng / thất lạc khi giờ quay trên thẻ chưa được nhập: không tự đặt giờ. Báo Sale phụ trách BO rằng khoảng đó có thể thiếu giờ quay,
   * và đưa vào Đối chiếu của Tech (thử đọc lại thẻ, hoặc chốt thiếu giờ với Sale).
   */
  function footageGap(c, status, reason) {
    const s = c.site_id ? store.sites.get(c.site_id) : null;
    if (!s || !c.bo_in) return;
    const span = `ở BO từ ${dm(c.bo_in)}${c.bo_out ? ` đến ${dm(c.bo_out)}` : ''}`;
    const st = CARD_ST[status].toLowerCase();
    if (s.sale_id) notify({ ids: [s.sale_id] }, 'warn', 'card_gap', `Thẻ ${c.code} của ${boLabel(s.name)} (${span}) được ghi là ${st} khi chưa nhập dung lượng: giờ quay của khoảng này có thể thiếu trên báo cáo. Tech đang đối chiếu.`, `outlet:${s.id}`, `cardgap:${c.id}:${c.bo_in}`);
    H.recon('card', 'tech', 'high', 'card', `cardgap:${c.id}:${c.bo_in}`, `Thẻ ${c.code} (${boLabel(s.name)}, ${span}) được ghi là ${st} khi chưa nhập dung lượng: ${reason}. Giờ quay khoảng này có thể thiếu. Thử đọc lại thẻ; không đọc được thì chốt thiếu giờ với Sale phụ trách. Hệ thống không tự đặt giờ.`, { card_id: c.id, site_id: s.id, bo_in: c.bo_in, bo_out: c.bo_out });
  }

  // ───────────────────────── Danh sách thẻ ─────────────────────────
  R('GET', '/api/hub/cards', G.STOCK_VIEW, ({ q }) => {
    const where = {};
    if (q.status) where.status = String(q.status).split(',').filter((s) => CARD_ST[s]);
    if (q.site) where.site_id = K.idOf(q.site);
    let rows = store.cards.find(where, { order: 'code' });
    if (q.q) { const s = String(q.q).toUpperCase(); rows = rows.filter((c) => c.code.includes(s)); }
    const counts = {};
    for (const c of store.cards.find({}, { cols: ['status'] })) counts[c.status] = (counts[c.status] || 0) + 1;
    return { total: rows.length, cards: rows.slice(0, int(q.limit, 1, 3000) || 800).map(cardView), counts };
  });
  R('GET', '/api/hub/cards/:id', G.STOCK_VIEW, ({ user, p }) => {
    const c = cardOrFail(p.id);
    return {
      card: cardView(c),
      records: store.card_records.find({ card_id: c.id }, { order: 'at', desc: true, limit: 60 }).map(recFor(user)),
      log: store.hub_log.find({ entity: 'card', entity_id: c.id }, { order: 'ts', desc: true, limit: 60 }).filter(logFor(user)),
    };
  });
  /** Dòng nhật ký nhập / sửa dung lượng ghi tên người nhập: cùng quy tắc với recFor (Tech Lead, Quản trị, hoặc chính người đó). */
  const REC_LOG = ['record_edit', 'upload'];
  const logFor = (user) => (e) => !REC_LOG.includes(e.action) || isTechLead(user) || e.actor_id === user.id;
  /** Điều chỉnh thẻ cho khớp thực tế (Lead), hoặc Tech báo thẻ hỏng. Thẻ đang nằm trong phiếu chưa xác nhận thì xử lý phiếu trước. */
  R('PATCH', '/api/hub/cards/:id', G.OPS_STAFF, ({ user, p, b }) => {
    const c = cardOrFail(p.id);
    const patch = { updated_at: now() };
    const notes = [];
    let reason = '';
    if (b.note !== undefined) { patch.note = cleanText(b.note, 300); notes.push('ghi chú'); }
    if (b.status !== undefined && b.status !== c.status) {
      if (!CARD_ST[b.status] || ['to_tech', 'to_log', 'with_fo'].includes(b.status)) fail(400, 'bad_status', 'Trạng thái này chỉ đổi qua phiếu bàn giao hoặc chuyến FO.');
      if (['to_tech', 'to_log'].includes(c.status)) fail(409, 'in_handover', 'Thẻ đang nằm trong phiếu bàn giao chưa xác nhận. Xử lý phiếu trước.');
      if (c.task_id) { const tk = store.tasks.get(c.task_id); if (tk && ['assigned', 'accepted', 'in_progress', 'unassigned'].includes(tk.status)) fail(409, 'in_trip', `Thẻ ${c.code} đã được xếp vào chuyến ${tk.code} của FO. Gỡ việc khỏi chuyến hoặc huỷ chuyến trước.`); }
      const techBad = b.status === 'bad' && G.TECH.includes(user.role) && ['at_tech', 'uploaded'].includes(c.status);
      if (!isLead(user) && !techBad) fail(403, 'forbidden', 'Chỉ Lead được điều chỉnh trạng thái thẻ; Tech báo được thẻ hỏng khi thẻ đang ở Tech.');
      reason = reasonOf(b.reason, 'lý do điều chỉnh');
      patch.status = b.status;
      patch.since = now();
      if (c.status === 'at_bo' && b.status !== 'at_bo') patch.bo_out = now(); // rời BO: ngày quay gợi ý tính theo lúc vào / rời BO
      if (b.status === 'office') Object.assign(patch, { site_id: null, kit_id: null, bo_in: null, bo_out: null, task_id: null });
      if (b.status === 'at_bo') { const s = H.outlets.outletOrFail(b.site_id ?? c.site_id ?? fail(400, 'site_required', 'Chọn BO đang giữ thẻ.')); Object.assign(patch, { site_id: s.id, bo_in: c.bo_in || now(), bo_out: null }); }
      notes.push(`trạng thái ${CARD_ST[c.status]} → ${CARD_ST[b.status]} (${reason})`);
      if (b.status === 'bad' || b.status === 'lost') notify({ roles: ['lead'] }, 'warn', 'card', `Thẻ ${c.code} được ghi là ${CARD_ST[b.status].toLowerCase()} bởi ${user.name}: ${reason}.`, `card:${c.id}`);
    }
    if (!notes.length) return { card: cardView(c) };
    store.tx(() => {
      store.cards.update(c.id, patch);
      log('card', c.id, 'update', `${user.name} sửa thẻ ${c.code}: ${notes.join('; ')}.`, user, patch);
      if ((patch.status === 'bad' || patch.status === 'lost') && FOOTAGE_PENDING.includes(c.status)) footageGap(c, patch.status, reason);
      if (c.status === 'at_tech' && c.handover_id) uploadDone(c.handover_id, user);
      if (c.status === 'uploaded' && c.handover_id) returnDone(c.handover_id, user);
    });
    changed('cards');
    return { card: cardView(store.cards.get(c.id)) };
  });

  // ───────────────────────── Phiếu bàn giao ─────────────────────────
  function handoverView(h, full = true, user = null) {
    if (!h) return null;
    const out = {
      id: h.id, code: h.code, dir: h.dir, dir_label: DIR[h.dir], status: h.status, status_label: HO_ST[h.status], note: h.note || '',
      from: h.from_id ? { id: h.from_id, name: H.userName(h.from_id) } : null, to: h.to_id ? { id: h.to_id, name: H.userName(h.to_id) } : null,
      created_at: h.created_at, received_at: h.received_at, lines: h.lines || 0, recv: h.recv || 0,
    };
    if (!full) return out;
    const lines = store.handover_lines.find({ handover_id: h.id }, { order: 'code' });
    const groups = new Map();
    for (const l of lines) {
      const k = l.site_id || 0;
      if (!groups.has(k)) groups.set(k, { site: l.site_id ? { id: l.site_id, name: H.siteName(l.site_id) } : null, cards: [] });
      groups.get(k).cards.push({ line_id: l.id, card_id: l.card_id, code: l.code, recv_at: l.recv_at, missing: !!l.missing });
    }
    out.groups = [...groups.values()].sort((a, b) => (a.site ? a.site.name : '').localeCompare(b.site ? b.site.name : ''));
    out.missing = lines.filter((l) => l.missing).length;
    const job = store.jobs.find({ handover_id: h.id }, { order: 'created_at' });
    out.jobs = job.map(H.jobs.viewFor(user));
    out.log = store.hub_log.find({ entity: 'handover', entity_id: h.id }, { order: 'ts', desc: true, limit: 40 });
    return out;
  }
  function hoOrFail(id) { const h = store.handovers.get(K.idOf(id)); if (!h) fail(404, 'not_found', 'Không tìm thấy phiếu.'); return h; }
  const groupsOf = (lines) => Math.max(1, new Set(lines.map((l) => l.site_id || 0)).size);

  R('GET', '/api/hub/handovers', G.OPS_STAFF, ({ q }) => {
    const where = {};
    if (q.dir && DIR[q.dir]) where.dir = q.dir;
    if (q.status) where.status = String(q.status).split(',').filter((s) => HO_ST[s]);
    const rows = store.handovers.find(where, { order: 'created_at', desc: true, limit: int(q.limit, 1, 500) || 200 });
    return { handovers: rows.map((h) => handoverView(h, false)), open: { to_tech: store.handovers.count({ dir: 'to_tech', status: 'sent' }), to_log: store.handovers.count({ dir: 'to_log', status: 'sent' }) } };
  });
  /** Gợi ý thẻ để lập phiếu: Logistics gửi Tech các thẻ đã thu về; Tech trả Logistics các thẻ đã nhập dung lượng. */
  R('GET', '/api/hub/handovers/suggest', G.OPS_STAFF, ({ q }) => {
    const dir = DIR[q.dir] ? q.dir : 'to_tech';
    const cards = store.cards.find({ status: FROM_ST[dir] }, { order: 'code' });
    const groups = new Map();
    for (const c of cards) {
      const k = c.site_id || 0;
      if (!groups.has(k)) groups.set(k, { site: c.site_id ? { id: c.site_id, name: H.siteName(c.site_id) } : null, cards: [] });
      groups.get(k).cards.push({ id: c.id, code: c.code, since: c.since });
    }
    return { dir, total: cards.length, groups: [...groups.values()], waiting_upload: dir === 'to_log' ? store.cards.count({ status: 'at_tech' }) : undefined };
  });
  R('GET', '/api/hub/handovers/:id', G.OPS_STAFF, ({ user, p }) => ({ handover: handoverView(hoOrFail(p.id), true, user) }));

  /** Kiểm danh sách thẻ cho phiếu: đúng trạng thái, không nằm ở phiếu khác. Mã lạ thì báo lại, không tự tạo. */
  function pickCards(dir, b) {
    const want = b.card_ids ? idList(b.card_ids, 2000).map((id) => store.cards.get(id)) : codesOf(b.codes, 2000).map((code) => store.cards.find({ code }, { limit: 1 })[0] || { code, missing: true });
    const unknown = want.filter((c) => !c || c.missing).map((c) => (c ? c.code : '?'));
    if (unknown.length) fail(404, 'unknown_cards', `Không có trong kho: ${unknown.slice(0, 20).join(', ')}${unknown.length > 20 ? '…' : ''}. Thêm thẻ ở mục Kho trước, hoặc kiểm lại mã.`);
    const bad = want.filter((c) => c.status !== FROM_ST[dir]);
    if (bad.length) fail(409, 'bad_cards', `Thẻ không ở trạng thái "${CARD_ST[FROM_ST[dir]]}": ${bad.slice(0, 12).map((c) => `${c.code} (${CARD_ST[c.status]})`).join(', ')}${bad.length > 12 ? '…' : ''}.`);
    return want;
  }
  function addLines(h, cards, dir) {
    const t = now();
    const prev = new Set(cards.map((c) => c.handover_id).filter(Boolean)); // phiếu gửi Tech trước đó của các thẻ được trả
    for (const c of cards) {
      store.handover_lines.insert({ handover_id: h.id, card_id: c.id, code: c.code, site_id: c.site_id, kit_id: c.kit_id, recv_at: null, recv_by: null, missing: 0 });
      store.cards.update(c.id, { status: MID_ST[dir], handover_id: h.id, since: t, updated_at: t });
    }
    return prev;
  }
  function syncCounts(h) {
    const lines = store.handover_lines.find({ handover_id: h.id });
    store.handovers.update(h.id, { lines: lines.length });
    for (const j of store.jobs.find({ handover_id: h.id, type: RECV_JOB[h.dir], status: H.jobs.OPEN })) store.jobs.update(j.id, { units: groupsOf(lines), title: recvTitle(h, lines) });
  }
  const recvTitle = (h, lines) => `${h.dir === 'to_tech' ? 'Nhận' : 'Nhận lại'} ${lines.length} thẻ, ${groupsOf(lines)} BO (phiếu ${h.code})`;

  R('POST', '/api/hub/handovers', G.OPS_STAFF, ({ user, b }) => {
    const dir = DIR[b.dir] ? b.dir : fail(400, 'bad_dir', 'Chọn chiều bàn giao.');
    if (!SENDER[dir].includes(user.role)) fail(403, 'forbidden', `Phiếu ${DIR[dir]} do ${dir === 'to_tech' ? 'Logistics' : 'Tech'} lập.`);
    const cards = pickCards(dir, b);
    if (!cards.length) fail(400, 'no_cards', 'Phiếu cần ít nhất một thẻ.');
    const t = now();
    const h = { code: H.nextCode('BG' + H.ym() + '-', 'handovers', 3), dir, status: 'sent', from_id: user.id, to_id: null, created_at: t, received_at: null, note: cleanText(b.note, 300), lines: cards.length, recv: 0 };
    store.tx(() => {
      h.id = store.handovers.insert(h);
      const prev = addLines(h, cards, dir);
      if (dir === 'to_log') for (const hid of prev) returnDone(hid, user);
      const lines = store.handover_lines.find({ handover_id: h.id });
      H.jobs.ensure({ type: RECV_JOB[dir], handover_id: h.id, units: groupsOf(lines), title: recvTitle(h, lines), dedupe: `ho:${h.id}` }, user);
      log('handover', h.id, 'create', `${user.name} lập phiếu ${h.code} (${DIR[dir]}): ${cards.length} thẻ, ${groupsOf(lines)} BO.`, user);
      for (const c of cards) log('card', c.id, 'handover', `Thẻ ${c.code} vào phiếu ${h.code} (${DIR[dir]}).`, user);
    });
    notify({ roles: dir === 'to_tech' ? ['tech_lead', 'tech'] : ['lead', 'logistic'] }, 'info', 'handover', `${user.name} gửi phiếu ${h.code}: ${cards.length} thẻ.`, `handover:${h.id}`);
    changed('cards', 'handovers', 'jobs');
    return { handover: handoverView(store.handovers.get(h.id), true, user) };
  });
  /** Bên gửi sửa phiếu khi bên nhận chưa xác nhận. */
  R('PATCH', '/api/hub/handovers/:id', G.OPS_STAFF, ({ user, p, b }) => {
    const h = hoOrFail(p.id);
    if (h.status !== 'sent') fail(409, 'locked', 'Phiếu đã xác nhận hoặc đã huỷ, không sửa được.');
    if (!SENDER[h.dir].includes(user.role)) fail(403, 'forbidden', 'Chỉ bên gửi sửa được phiếu.');
    store.tx(() => {
      const back = [];
      if (b.remove) {
        for (const code of codesOf(b.remove, 2000)) {
          const l = store.handover_lines.find({ handover_id: h.id, code }, { limit: 1 })[0];
          if (!l) continue;
          store.handover_lines.remove(l.id);
          store.cards.update(l.card_id, { status: FROM_ST[h.dir], updated_at: now() });
          if (h.dir === 'to_log') back.push(l.card_id);
        }
      }
      returnAgain(back, user, `${user.name} gỡ thẻ khỏi phiếu trả ${h.code}`);
      if (b.add || b.add_ids) { const prev = addLines(h, pickCards(h.dir, { codes: b.add, card_ids: b.add_ids }), h.dir); if (h.dir === 'to_log') for (const hid of prev) returnDone(hid, user); }
      if (b.note !== undefined) store.handovers.update(h.id, { note: cleanText(b.note, 300) });
      if (!store.handover_lines.count({ handover_id: h.id })) fail(400, 'no_cards', 'Phiếu cần ít nhất một thẻ. Muốn bỏ phiếu thì bấm Huỷ phiếu.');
      syncCounts(h);
      log('handover', h.id, 'update', `${user.name} sửa phiếu ${h.code}.`, user, { add: b.add || b.add_ids || null, remove: b.remove || null });
    });
    changed('cards', 'handovers', 'jobs', 'perf');
    return { handover: handoverView(store.handovers.get(h.id), true, user) };
  });
  R('POST', '/api/hub/handovers/:id/cancel', G.OPS_STAFF, ({ user, p, b }) => {
    const h = hoOrFail(p.id);
    if (h.status !== 'sent') fail(409, 'locked', 'Phiếu đã xác nhận hoặc đã huỷ.');
    if (!SENDER[h.dir].includes(user.role)) fail(403, 'forbidden', 'Chỉ bên gửi huỷ được phiếu.');
    const reason = reasonOf(b.reason, 'lý do huỷ phiếu');
    store.tx(() => {
      const ls = store.handover_lines.find({ handover_id: h.id });
      for (const l of ls) store.cards.update(l.card_id, { status: FROM_ST[h.dir], updated_at: now() });
      store.handovers.update(h.id, { status: 'cancelled', note: [h.note, `Huỷ: ${reason}`].filter(Boolean).join(' · ') });
      H.jobs.cancelFor({ handover_id: h.id }, user, `Phiếu ${h.code} bị huỷ`);
      if (h.dir === 'to_log') returnAgain(ls.map((l) => l.card_id), user, `phiếu trả ${h.code} bị huỷ (${reason})`);
      log('handover', h.id, 'cancel', `${user.name} huỷ phiếu ${h.code}: ${reason}.`, user);
    });
    changed('cards', 'handovers', 'jobs', 'perf');
    return { handover: handoverView(store.handovers.get(h.id), true, user) };
  });
  /**
   * Bên nhận xác nhận: đánh dấu từng thẻ đã nhận (hoặc nhận đủ, hoặc quét mã). Thẻ không nhận được phải ghi lý do,
   * thẻ đó trở về bên gửi và vào Đối chiếu; hệ thống không tự sửa. Điểm của việc nhận phiếu tính cho người xác nhận.
   */
  R('POST', '/api/hub/handovers/:id/receive', G.OPS_STAFF, ({ user, p, b }) => {
    const h = hoOrFail(p.id);
    if (h.status !== 'sent') fail(409, 'locked', 'Phiếu đã xác nhận hoặc đã huỷ, không sửa được.');
    if (!RECEIVER[h.dir].includes(user.role)) fail(403, 'forbidden', `Phiếu ${DIR[h.dir]} do ${h.dir === 'to_tech' ? 'Tech' : 'Logistics'} xác nhận.`);
    const lines = store.handover_lines.find({ handover_id: h.id });
    let got;
    let extra = [];
    if (b.all === true) got = new Set(lines.map((l) => l.id));
    else if (b.codes !== undefined) {
      const cs = new Set(codesOf(b.codes, 2000));
      got = new Set(lines.filter((l) => cs.has(l.code)).map((l) => l.id));
      extra = [...cs].filter((c) => !lines.some((l) => l.code === c));
    } else {
      // Đánh dấu theo dòng: chỉ nhận dòng của chính phiếu này (phiếu có thể đã được bên gửi sửa trong lúc mở hộp thoại).
      const ids = idList(b.line_ids || [], 2000);
      if (ids.some((id) => !lines.some((l) => l.id === id))) fail(409, 'not_in_ticket', `Phiếu ${h.code} đã thay đổi so với lúc mở. Tải lại phiếu rồi đánh dấu lại các thẻ đã nhận.`);
      got = new Set(ids);
    }
    if (extra.length) fail(409, 'not_in_ticket', `Mã không có trong phiếu: ${extra.slice(0, 12).join(', ')}. Kiểm lại thẻ, hoặc báo bên gửi thêm vào phiếu.`);
    const missing = lines.filter((l) => !got.has(l.id));
    const reason = missing.length ? reasonOf(b.missing_reason, `lý do thiếu ${missing.length} thẻ`) : '';
    const t = now();
    const gotLines = lines.filter((l) => got.has(l.id));
    store.tx(() => {
      for (const l of lines) {
        if (got.has(l.id)) {
          store.handover_lines.update(l.id, { recv_at: t, recv_by: user.id, missing: 0 });
          const patch = { status: RECV_ST[h.dir], since: t, updated_at: t };
          if (h.dir === 'to_log') Object.assign(patch, { site_id: null, kit_id: null, bo_in: null, bo_out: null, task_id: null });
          store.cards.update(l.card_id, patch);
        } else {
          store.handover_lines.update(l.id, { missing: 1 });
          store.cards.update(l.card_id, { status: FROM_ST[h.dir], updated_at: t });
          log('card', l.card_id, 'missing', `Thẻ ${l.code} không có khi ${user.name} nhận phiếu ${h.code}: ${reason}.`, user);
        }
      }
      if (missing.length && h.dir === 'to_log') returnAgain(missing.map((l) => l.card_id), user, `Logistics không nhận được ${missing.length} thẻ của phiếu ${h.code}`);
      if (missing.length) {
        H.recon('handover', TEAM[h.dir], 'high', 'handover', `ho:${h.id}`, `Phiếu ${h.code} (${DIR[h.dir]}): ${user.name} không nhận được ${missing.length} thẻ (${missing.slice(0, 10).map((l) => l.code).join(', ')}${missing.length > 10 ? '…' : ''}). Lý do: ${reason}. Thẻ đã trả về bên gửi, cần tìm và lập lại phiếu.`, { handover_id: h.id, codes: missing.map((l) => l.code) });
      }
      const n = gotLines.length;
      store.handovers.update(h.id, { status: 'received', to_id: user.id, received_at: t, recv: n });
      const job = store.jobs.find({ handover_id: h.id, type: RECV_JOB[h.dir], status: H.jobs.OPEN }, { limit: 1 })[0];
      const groups = groupsOf(n ? gotLines : lines);
      if (job) H.jobs.complete(job, user, { received: n, missing: missing.length, units: groups, summary: `Nhận ${n}/${lines.length} thẻ` }, { raw: true, by: user.id });
      if (h.dir === 'to_tech' && n) {
        H.jobs.ensure({ type: 'cards_upload', handover_id: h.id, units: n, title: `Nhập dung lượng ${n} thẻ (phiếu ${h.code})`, dedupe: `upload:${h.id}`, assignee_id: user.role === 'admin' ? undefined : user.id }, user);
      }
      log('handover', h.id, 'receive', `${user.name} xác nhận phiếu ${h.code}: nhận ${n}/${lines.length} thẻ${missing.length ? `, thiếu ${missing.length} (${reason})` : ''}.`, user);
    });
    notify({ ids: [h.from_id] }, missing.length ? 'warn' : 'info', 'handover', `${user.name} đã nhận phiếu ${h.code}: ${gotLines.length}/${lines.length} thẻ${missing.length ? `, thiếu ${missing.length}` : ''}.`, `handover:${h.id}`);
    changed('cards', 'handovers', 'jobs', 'perf');
    return { handover: handoverView(store.handovers.get(h.id), true, user) };
  });

  // ───────────────────────── Nhập dung lượng ─────────────────────────
  function recView(r) {
    return {
      id: r.id, card_id: r.card_id, code: r.code, site: r.site_id ? { id: r.site_id, name: H.siteName(r.site_id) } : null, kit: r.kit_id ? { id: r.kit_id, code: (store.kits.get(r.kit_id) || {}).code || '' } : null,
      shoot_date: r.shoot_date, gb: r.gb, hours: r.hours, zero_reason: r.zero_reason || '', photos: r.photos || [], by: r.by_id ? { id: r.by_id, name: H.userName(r.by_id) } : null, at: r.at,
      edited_by: r.edited_by ? H.userName(r.edited_by) : '', edited_at: r.edited_at,
    };
  }
  /** Người nhập dung lượng là số theo từng người của Tech: Tech Lead và Quản trị thấy đủ; Tech Executive chỉ thấy tên mình; team khác không thấy. */
  function recFor(user) {
    return (r) => {
      const v = recView(r);
      if (isTechLead(user) || (user.role === 'tech' && r.by_id === user.id)) return v;
      return { ...v, by: null, edited_by: '' };
    };
  }
  /** Ngày quay gợi ý: ngày thẻ vào BO (hoặc trước ngày rời BO một ngày). Thẻ không rõ thời gian ở BO thì không đoán: Tech nhập ngày. */
  const defaultShootDate = (c) => (c.bo_in ? localDate(c.bo_in, off) : c.bo_out ? addDays(localDate(c.bo_out, off), -1) : null);
  /** Ngày quay hợp lệ: không ở tương lai, trong số ngày gần đây theo cài đặt của Tech (giống nhau khi nhập và khi sửa). */
  function shootOf(v, code) {
    const d0 = today(), win = H.cfg().shootWindowDays;
    if (!isDate(v) || v > d0 || v < addDays(d0, -win)) fail(400, 'bad_date', `${code ? `Thẻ ${code}: n` : 'N'}gày quay không hợp lệ (trong ${win} ngày gần đây, không ở tương lai).`);
    return v;
  }
  const boList = () => store.sites.find({ active: 1, type: 'bo' }, { order: 'name' }).map((s) => ({ id: s.id, name: s.name }));
  /** Hàng chờ nhập: thẻ Tech đã nhận, gom theo phiếu và BO; kèm ngày quay gợi ý, các kit đang ở BO đó, danh sách BO cho thẻ không rõ BO. */
  R('GET', '/api/hub/cards/upload-queue', G.TECH, () => {
    const cards = store.cards.find({ status: 'at_tech' }, { order: 'code' });
    const kitsBySite = new Map();
    const kitsAt = (sid) => {
      if (!sid) return [];
      if (!kitsBySite.has(sid)) kitsBySite.set(sid, store.kits.find({ site_id: sid }).map((k) => ({ id: k.id, code: k.code, kind: k.kind })));
      return kitsBySite.get(sid);
    };
    const c = H.cfg();
    return {
      gb_per_hour: c.gbPerHour, photo_required: !!c.uploadPhotoRequired, zero_reasons: ZERO_REASONS, zero_min: ZERO_MIN, shoot_window_days: c.shootWindowDays,
      sites: cards.some((x) => !x.site_id) ? boList() : [],
      cards: cards.map((x) => ({ ...cardView(x), shoot_date: defaultShootDate(x), kits: kitsAt(x.site_id), handover: x.handover_id ? (store.handovers.get(x.handover_id) || {}).code : '' })),
    };
  });
  /** Lý do 0 giờ: một lý do trong danh sách, hoặc "Khác: …" ghi rõ (đủ dài để Sale hiểu). */
  function zeroReasonOf(v, code) {
    const r = cleanStr(v, 120);
    if (ZERO_REASONS.includes(r) && r !== 'Khác') return r;
    const detail = r.replace(/^Khác\s*[:\-–]?\s*/i, '');
    if (detail.length < ZERO_MIN) fail(400, 'zero_reason', `${code ? `Thẻ ${code}: t` : 'T'}hẻ 0 giờ cần chọn lý do; chọn "Khác" thì ghi rõ (ít nhất ${ZERO_MIN} ký tự).`);
    return `Khác: ${detail}`;
  }
  /**
   * Tech nhập dung lượng nhiều thẻ một lần. Ảnh chụp màn hình dung lượng (nếu có) gắn chung cho cả lượt nhập.
   * Thẻ không rõ BO: Tech chọn BO (ghi nhật ký); không chọn thì bản ghi lưu chưa rõ BO, không tính cho BO nào và vào Đối chiếu của Tech.
   * GB ra 0 giờ (sau khi làm tròn) cần lý do 0 giờ.
   */
  R('POST', '/api/hub/cards/records', G.TECH, ({ user, b }) => {
    const list = Array.isArray(b.records) ? b.records : fail(400, 'bad_list', 'Danh sách thẻ không hợp lệ.');
    if (!list.length) fail(400, 'no_cards', 'Chưa có thẻ nào.');
    if (list.length > 300) fail(400, 'too_many', 'Tối đa 300 thẻ mỗi lần.');
    const photos = H.decodePhotos(b.photos, H.cfg().uploadPhotoRequired ? 1 : 0);
    const t = now();
    const rows = list.map((r, i) => {
      const c = store.cards.get(int(r && r.card_id, 1, 1e12) ?? -1);
      if (!c) fail(404, 'not_found', `Dòng ${i + 1}: không tìm thấy thẻ.`);
      if (c.status !== 'at_tech') fail(409, 'bad_state', `Thẻ ${c.code} không ở trạng thái "Tech đã nhận".`);
      const gb = num(r.gb);
      if (gb === null || gb < 0 || gb > 2048) fail(400, 'bad_gb', `Thẻ ${c.code}: dung lượng phải từ 0 đến 2048 GB.`);
      const shoot = shootOf(r.shoot_date || defaultShootDate(c) || fail(400, 'date_required', `Thẻ ${c.code} không rõ thời gian ở BO: nhập ngày quay.`), c.code);
      let siteId = c.site_id, picked = false;
      if (r.site_id !== undefined && r.site_id !== null && r.site_id !== '') {
        const s = H.outlets.outletOrFail(r.site_id);
        if (c.site_id && s.id !== c.site_id) fail(409, 'site_mismatch', `Thẻ ${c.code} đang ghi của ${boLabel(H.siteName(c.site_id))}. Muốn đổi BO của thẻ thì Lead điều chỉnh thẻ trước.`);
        if (!c.site_id) { siteId = s.id; picked = true; }
      }
      let kitId = c.kit_id;
      if (r.kit_id) { const k = H.stock.kitOrFail(r.kit_id); kitId = k.id; }
      const g = +gb.toFixed(2);
      // Thẻ ghi từ ngày quay tới hôm trước ngày thu thẻ: giờ của thẻ chia đều cho các ngày đó (báo cáo theo ngày, chuẩn giờ quay).
      const last = c.bo_out ? addDays(localDate(c.bo_out, off), -1) : shoot;
      return { c, gb: g, shoot, cover: last > shoot ? last : shoot, kitId, siteId, picked, zero: hoursOf(g) === 0 ? zeroReasonOf(r.zero_reason, c.code) : '' };
    });
    const seen = new Set();
    for (const r of rows) { if (seen.has(r.c.id)) fail(400, 'dup', `Thẻ ${r.c.code} bị nhập hai lần trong cùng lượt.`); seen.add(r.c.id); }
    const zeros = new Map();
    let ids = [];
    const upStd = H.jobs.uploadStd(); // phút chuẩn mỗi thẻ lúc nhập: đổi định mức sau này không viết lại điểm kỳ đã qua
    store.tx(() => {
      const recIds = [];
      for (const r of rows) {
        r.id = store.card_records.insert({ card_id: r.c.id, code: r.c.code, site_id: r.siteId, kit_id: r.kitId, handover_id: r.c.handover_id, shoot_date: r.shoot, cover_to: r.cover, gb: r.gb, hours: hoursOf(r.gb), zero_reason: r.zero || null, photos: null, by_id: user.id, at: t, edited_by: null, edited_at: null, std_min: upStd });
        recIds.push(r.id);
        store.cards.update(r.c.id, { status: 'uploaded', kit_id: r.kitId, since: t, updated_at: t });
        if (r.zero && r.siteId) { const k = `${r.siteId}:${r.shoot}`; zeros.set(k, (zeros.get(k) || []).concat(r.c.code)); }
      }
      if (photos.length) {
        ids = H.savePhotos(photos, `upl:${recIds[0]}`, rows[0].siteId, user);
        for (const id of recIds) store.card_records.update(id, { photos: ids });
      }
      for (const hid of new Set(rows.map((r) => r.c.handover_id).filter(Boolean))) uploadDone(hid, user);
      const zr = rows.filter((r) => r.zero), pk = rows.filter((r) => r.picked), ns = rows.filter((r) => !r.siteId);
      const extra = [
        zr.length ? `${zr.length} thẻ 0 giờ (${zr.slice(0, 10).map((r) => `${r.c.code}: ${r.zero}`).join('; ')}${zr.length > 10 ? '…' : ''})` : '',
        pk.length ? `chọn BO cho thẻ không rõ BO: ${pk.slice(0, 10).map((r) => `${r.c.code} → ${boLabel(H.siteName(r.siteId))}`).join(', ')}` : '',
        ns.length ? `${ns.length} thẻ chưa rõ BO, đã vào Đối chiếu` : '',
      ].filter(Boolean);
      // Bản ghi cũ của các BO này chưa rõ khoảng ngày ghi (chờ lần đổi thẻ kế tiếp): điền luôn.
      const sids = [...new Set(rows.map((r) => r.siteId).filter(Boolean))], filled = sids.length ? H.outlets.fillCover(sids) : 0;
      if (filled) extra.push(`điền khoảng ngày ghi cho ${filled} bản ghi cũ của BO`);
      log('card', null, 'upload', `${user.name} nhập dung lượng ${rows.length} thẻ, tổng ${rows.reduce((a, r) => a + r.gb, 0).toFixed(1)} GB${extra.length ? `; ${extra.join('; ')}` : ''}.`, user,
        { codes: rows.map((r) => r.c.code), zero: zr.map((r) => ({ code: r.c.code, reason: r.zero })), site_pick: pk.map((r) => ({ code: r.c.code, site_id: r.siteId })), ...(filled ? { cover_filled: filled } : {}) });
      if (ns.length) {
        H.recon('upload', 'tech', 'high', 'card_record', `nosite:${ns[0].id}`, `${user.name} nhập ${ns.length} thẻ chưa rõ BO (${ns.slice(0, 10).map((r) => r.c.code).join(', ')}${ns.length > 10 ? '…' : ''}), ${ns.reduce((a, r) => a + hoursOf(r.gb), 0).toFixed(2)} giờ quay chưa tính cho BO nào. Mở bản ghi ở Nhập dung lượng → Đã nhập, chọn đúng BO rồi đánh dấu đã xử lý.`, { record_ids: ns.map((r) => r.id), codes: ns.map((r) => r.c.code) });
      }
    });
    // Thẻ 0 giờ: báo Sale phụ trách BO, gộp theo BO và ngày quay trong lượt nhập này (lượt sau có thẻ 0 giờ mới vẫn báo).
    if (H.cfg().zeroHourAlert) for (const [k, codes] of zeros) {
      const [sid, date] = k.split(':');
      const s = store.sites.get(+sid);
      if (!s) continue;
      notify({ ids: [s.sale_id] }, 'warn', 'zero_hour', `${boLabel(s.name)} có ${codes.length} thẻ 0 giờ ngày ${date.slice(8, 10)}/${date.slice(5, 7)} (${codes.join(', ')}). Liên hệ BO kiểm tra máy.`, `outlet:${s.id}`, `zero:${s.id}:${date}:${codes.join(',')}`);
    }
    changed('cards', 'records', 'outlets', 'perf', 'jobs');
    return { ok: true, count: rows.length, hours: +rows.reduce((a, r) => a + hoursOf(r.gb), 0).toFixed(2), photos: ids.length };
  });
  /**
   * Hết thẻ "Tech đã nhận" của phiếu thì việc nhập dung lượng của phiếu tự đóng (điểm đã tính theo từng thẻ),
   * và Tech có việc trả các thẻ đã nhập của phiếu về Logistics (mỗi phiếu một việc).
   * Người hoàn thành là người nhập thẻ cuối cùng của phiếu (thành viên team của việc, không phải Quản trị), không phải người nhận phiếu
   * hay người ghi mất / hỏng thẻ còn lại (vd. Logistic Lead): đúng hạn / trễ hạn tính cho người đó. Chưa ai trong team nhập thẻ nào
   * thì tính cho người được giao.
   */
  function uploadDone(handoverId, actor) {
    if (store.cards.count({ handover_id: handoverId, status: 'at_tech' })) return;
    for (const j of store.jobs.find({ handover_id: handoverId, type: 'cards_upload', status: H.jobs.OPEN })) {
      const ok = (u) => u && u.role !== 'admin' && H.jobs.inTeam(u, j.team);
      const up = store.card_records.find({ handover_id: handoverId }, { order: 'at', desc: true, limit: 200 }).map((r) => store.users.get(r.by_id)).find(ok);
      H.jobs.complete(j, actor, { summary: 'Đã nhập đủ thẻ của phiếu', units: j.units }, { raw: true, by: up ? up.id : j.assignee_id || null });
    }
    const n = store.cards.count({ handover_id: handoverId, status: 'uploaded' });
    const h = store.handovers.get(handoverId);
    if (n && h && h.dir === 'to_tech') H.jobs.ensure({ type: 'cards_return', handover_id: handoverId, title: `Trả ${n} thẻ đã nhập về Logistics (phiếu ${h.code})`, dedupe: `return:${handoverId}` }, actor);
  }
  /** Thẻ đã nhập của phiếu đều đã vào phiếu trả (hoặc được Lead điều chỉnh) thì việc trả thẻ tự đóng; điểm cho người lập phiếu trả. */
  function returnDone(handoverId, actor) {
    if (store.cards.count({ handover_id: handoverId, status: 'uploaded' })) return;
    for (const j of store.jobs.find({ handover_id: handoverId, type: 'cards_return', status: H.jobs.OPEN })) {
      H.jobs.complete(j, actor, { summary: 'Đã lập phiếu trả thẻ về Logistics' }, { raw: true, by: actor && G.TECH.includes(actor.role) ? actor.id : j.assignee_id || null });
    }
  }
  /** Phiếu gửi Tech gần nhất mà Tech đã nhận thẻ này (lượt thẻ hiện tại). */
  function techHoOf(cardId) {
    let best = null;
    for (const l of store.handover_lines.find({ card_id: cardId })) {
      if (!l.recv_at || (best && l.recv_at <= best.recv_at)) continue;
      const h = store.handovers.get(l.handover_id);
      if (h && h.dir === 'to_tech') best = l;
    }
    return best ? best.handover_id : null;
  }
  /**
   * Thẻ của phiếu trả quay về "Đã nhập" (phiếu trả bị huỷ, bên gửi gỡ thẻ, Logistics không nhận được): gắn lại phiếu gửi Tech của thẻ,
   * và việc trả thẻ của phiếu đó mở lại cho Tech (bỏ điểm đã tính lúc lập phiếu trả). Kỳ hiệu suất đã chốt thì tạo việc trả mới.
   */
  function returnAgain(cardIds, actor, why) {
    const hids = new Set();
    for (const id of cardIds) { const hid = techHoOf(id); if (hid) { store.cards.update(id, { handover_id: hid }); hids.add(hid); } }
    for (const hid of hids) {
      const h = store.handovers.get(hid);
      const n = store.cards.count({ handover_id: hid, status: 'uploaded' });
      if (!n) continue;
      const title = `Trả ${n} thẻ đã nhập về Logistics (phiếu ${h.code})`;
      const open = store.jobs.find({ handover_id: hid, type: 'cards_return', status: H.jobs.OPEN }, { limit: 1 })[0];
      if (open) { store.jobs.update(open.id, { title }); continue; }
      const j = store.jobs.find({ handover_id: hid, type: 'cards_return', status: 'done' }, { order: 'done_at', desc: true, limit: 1 })[0];
      if (j && !(H.people && H.people.isLocked('tech', j.done_at))) {
        const t = now(), sla = j.assignee_id ? t : null;
        store.jobs.update(j.id, { status: 'open', title, done_at: null, done_by: null, result: null, std_min: null, sla_start: sla, due_at: sla ? t + H.jobs.slaOf('cards_return') * 60000 : null, al_due: 0 });
        log('job', j.id, 'reopen', `${j.code} trở lại chờ làm: ${why}.`, actor);
        if (j.assignee_id) notify({ ids: [j.assignee_id] }, 'warn', 'job', `${title}: ${why}. Việc đã trở lại danh sách chờ.`, `job:${j.id}`);
      } else H.jobs.ensure({ type: 'cards_return', handover_id: hid, title, dedupe: `return:${hid}:${H.uniq()}` }, actor);
    }
  }
  /**
   * Sửa bản ghi dung lượng: người nhập (trong số giờ theo cài đặt) hoặc Tech Lead. Cùng quy tắc như lúc nhập: ngày quay, ảnh khi đổi GB
   * (nếu Tech Lead bắt buộc ảnh), lý do 0 giờ. Bản ghi chưa rõ BO thì người nhập chọn BO; đổi BO đã có thì chỉ Tech Lead.
   * Kỳ hiệu suất đã chốt thì không sửa được.
   */
  R('PATCH', '/api/hub/cards/records/:id', G.TECH, ({ user, p, b }) => {
    const r = store.card_records.get(K.idOf(p.id));
    if (!r) fail(404, 'not_found', 'Không tìm thấy bản ghi.');
    const cf = H.cfg();
    if (!isTechLead(user) && (r.by_id !== user.id || now() - r.at > cf.recordEditHours * 3600000)) fail(403, 'forbidden', `Chỉ người nhập (trong ${cf.recordEditHours} giờ) hoặc Tech Lead được sửa.`);
    if (H.people && H.people.isLocked('tech', r.at)) fail(409, 'period_locked', 'Kỳ hiệu suất chứa bản ghi này đã chốt. Quản trị mở lại kỳ trước khi sửa.');
    const patch = {}, notes = [];
    if (b.gb !== undefined) {
      const gb = num(b.gb);
      if (gb === null || gb < 0 || gb > 2048) fail(400, 'bad_gb', 'Dung lượng phải từ 0 đến 2048 GB.');
      const g = +gb.toFixed(2);
      if (g !== r.gb) { patch.gb = g; patch.hours = hoursOf(g); notes.push(`${r.gb} GB → ${g} GB`); }
    }
    if (b.shoot_date !== undefined && b.shoot_date !== r.shoot_date) { patch.shoot_date = shootOf(b.shoot_date); notes.push(`ngày quay ${r.shoot_date} → ${patch.shoot_date}`); } // cover_to giữ nguyên khoảng thẻ nằm ở BO lúc nhập (sửa nhầm rồi sửa lại thì về đúng)
    if (b.kit_id !== undefined) { const k = b.kit_id ? H.stock.kitOrFail(b.kit_id).id : null; if (k !== r.kit_id) { patch.kit_id = k; notes.push('kit'); } }
    if (b.site_id !== undefined) {
      const s = H.outlets.outletOrFail(b.site_id || fail(400, 'site_required', 'Chọn BO của bản ghi.'));
      if (s.id !== r.site_id) {
        if (r.site_id && !isTechLead(user)) fail(403, 'forbidden', 'Bản ghi đã có BO; chỉ Tech Lead đổi BO.');
        patch.site_id = s.id;
        notes.push(`BO ${r.site_id ? boLabel(H.siteName(r.site_id)) : 'chưa rõ'} → ${boLabel(s.name)}`);
      }
    }
    const photos = H.decodePhotos(b.photos, patch.gb !== undefined && cf.uploadPhotoRequired ? 1 : 0);
    const gb = patch.gb ?? r.gb;
    if (hoursOf(gb) === 0) {
      const z = zeroReasonOf(b.zero_reason ?? r.zero_reason);
      if (z !== r.zero_reason) { patch.zero_reason = z; notes.push(`lý do 0 giờ: ${z}`); }
    } else if (r.zero_reason) patch.zero_reason = null;
    if (photos.length) notes.push(`thêm ${photos.length} ảnh dung lượng`);
    if (!notes.length) return { record: recView(r) };
    Object.assign(patch, { edited_by: user.id, edited_at: now() });
    store.tx(() => {
      if (photos.length) patch.photos = [...(r.photos || []), ...H.savePhotos(photos, `upl:${r.id}`, patch.site_id ?? r.site_id, user)];
      store.card_records.update(r.id, patch);
      log('card', r.card_id, 'record_edit', `${user.name} sửa dung lượng thẻ ${r.code}: ${notes.join('; ')}.`, user, patch);
    });
    changed('records', 'outlets', 'perf');
    return { record: recView(store.card_records.get(r.id)) };
  });
  /** Bản ghi dung lượng. Sale chỉ xem BO của mình. */
  R('GET', '/api/hub/cards/records', G.STAFF, ({ user, q }) => {
    const to = isDate(q.to) ? q.to : today(), from = isDate(q.from) ? q.from : addDays(to, -6);
    const where = { shoot_date: { gte: from, lte: to } };
    if (q.site) where.site_id = K.idOf(q.site);
    if (q.by && G.TECH.includes(user.role)) { // lọc theo người nhập: Tech Lead theo từng người, Tech Executive chỉ "của tôi"; team khác bỏ qua
      const by = K.idOf(q.by);
      if (!isTechLead(user) && by !== user.id) fail(403, 'forbidden', 'Bạn chỉ lọc được bản ghi do mình nhập.');
      where.by_id = by;
    }
    // Sale Lead chỉ BO của mình: lọc ngay lúc tìm, trước khi cắt số dòng (không thì bản ghi của BO khác chiếm hết chỗ).
    if (H.isSale(user) && H.outlets.saleScope(user)) { const mine = store.sites.find({ sale_id: user.id }).map((s) => s.id); where.site_id = where.site_id ? (mine.includes(where.site_id) ? where.site_id : -1) : mine.length ? mine : [-1]; }
    let rows = store.card_records.find(where, { order: 'shoot_date', desc: true, limit: 5000 });
    if (H.isSale(user)) rows = rows.filter((r) => r.site_id); // bản ghi chưa rõ BO đang chờ Tech đối chiếu
    if (q.zero === '1') rows = rows.filter((r) => !r.hours);
    const sum = rows.reduce((a, r) => ({ gb: a.gb + (r.gb || 0), hours: a.hours + (r.hours || 0) }), { gb: 0, hours: 0 });
    const out = H.isSale(user) ? rows.map((r) => ({ code: r.code, site: { id: r.site_id, name: H.siteName(r.site_id) }, shoot_date: r.shoot_date, hours: r.hours, gb: r.gb, zero_reason: r.zero_reason || '' })) : rows.map(recFor(user));
    const cf = H.cfg();
    return { from, to, records: out.slice(0, 2000), total: rows.length, gb: +sum.gb.toFixed(2), hours: +sum.hours.toFixed(2), edit_hours: cf.recordEditHours, shoot_window_days: cf.shootWindowDays, sites: H.isSale(user) ? undefined : boList() };
  });

  // ───────────────────────── Kho thẻ tại VP ─────────────────────────
  /** Thẻ sẵn sàng tại VP chưa được chọn cho chuyến FO nào. */
  const officeFree = () => store.cards.count({ status: 'office', task_id: null });
  /** Nhịp định kỳ: thẻ sẵn sàng tại VP dưới ngưỡng (cài đặt của Logistics) thì báo Logistics, mỗi ngày một lần. */
  function tick() {
    const min = H.cfg().officeCardsMin;
    if (!min || !store.cards.count({})) return;
    const n = officeFree();
    if (n >= min) return;
    notify({ roles: ['lead', 'logistic'] }, 'warn', 'cards_low', `Chỉ còn ${n} thẻ sẵn sàng tại VP (ngưỡng ${min}). Nhắc Tech trả thẻ đã nhập dung lượng, hoặc bổ sung thẻ.`, '', `cards_low:${today()}`);
  }

  return { handoverView, cardView, recView, hoursOf, uploadDone, returnDone, officeFree, tick };
}
