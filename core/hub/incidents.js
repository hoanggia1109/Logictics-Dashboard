// incidents.js — sự cố tại BO. Ai trong ba team cũng báo được (Sale chỉ BO của mình), nhãn lỗi chọn từ danh sách theo dòng máy.
// Tech nhận (đồng hồ hạn tính từ lúc nhận) và chọn cách xử lý; cách xử lý quyết định phút chuẩn. Đổi máy hoặc mang về sửa thì
// hệ thống tự sinh việc đổi kit cho Logistics (đi cùng chuyến đổi thẻ). Thống kê gộp sự cố BO và lỗi phát hiện ở văn phòng.
// Chỉ người giữ việc xử lý sự cố (hoặc Tech Lead) nhận và báo kết quả; bấm "Bắt đầu" / "Nhận việc" ở bảng việc cũng là nhận sự cố.
import { cleanStr, cleanText, int, addDays, localDate, boLabel, isDate } from '../util.js';
import { fail } from '../core.js';
import { INCIDENT_RES, INCIDENT_ST, KIT_KINDS, KIT_ST } from './defs.js';
import { periodOf, shiftWeek, weekRange, monthRange, shiftMonth, tsRange, weekLabel, monthLabel } from './period.js';

const OPEN = ['open', 'ack'];

export function installIncidents(H) {
  const { K, G, store, now, off, today, log, changed, notify, reasonOf } = H;
  const { R } = K;
  const isTech = (u) => G.TECH.includes(u.role);
  const openJob = (i, type = 'incident') => store.jobs.find({ incident_id: i.id, type, status: H.jobs.OPEN }, { limit: 1 })[0] || null;
  /** Người được nhận / báo kết quả: việc xử lý chưa ai giữ, mình đang giữ, hoặc Tech Lead (Quản trị). */
  const mayHold = (user, j) => isTech(user) && (!j || !j.assignee_id || j.assignee_id === user.id || H.jobs.isLeadOf(user, 'tech'));
  const heldBy = (j) => `${H.userName(j.assignee_id)} đang giữ sự cố này. Người giữ việc hoặc Tech Lead nhận và báo kết quả.`;

  /** Kit của sự cố đã rời BO của sự cố (về kho, đã giao BO khác): đổi máy / mang về sửa không còn tự tác động lên kit. Kit đang ở Tech sửa thì không tính. */
  const kitAway = (i, kit) => !!kit && kit.status !== 'at_tech' && !(['at_bo', 'recovering'].includes(kit.status) && kit.site_id === i.site_id);
  /**
   * Thông tin sự cố gửi cho màn hình. viewer: người xem. Ngoài Logistics và Tech, tên FO (người xử lý, người giữ việc) chỉ hiện vai "FO";
   * không truyền người xem (ví dụ gọi qua .map) thì cũng che. pre: việc và ảnh đã đọc sẵn cho cả danh sách (briefList); không có thì tự đọc.
   */
  function briefWith(i, viewer, pre) {
    if (!i) return null;
    const ops = !!viewer && typeof viewer === 'object' && G.OPS_STAFF.includes(viewer.role);
    const who = (uid) => { const u = uid ? H.rowOf('users', uid) : null; return !u ? '' : u.role === 'fo' && !ops ? H.ROLE_LABEL.fo : u.name; };
    const kit = i.kit_id ? H.rowOf('kits', i.kit_id) : null;
    const dev = i.device_id ? H.rowOf('devices', i.device_id) : null;
    const rel = pre ? pre.jobs.get(i.id) || [] : store.jobs.find({ incident_id: i.id, type: ['incident', 'swap_faulty'] }, { order: 'created_at', desc: true });
    const job = rel.find((j) => j.type === 'incident');
    const swap = rel.find((j) => j.type === 'swap_faulty' && H.jobs.OPEN.includes(j.status));
    const by = i.raised_by ? H.rowOf('users', i.raised_by) : null;
    return {
      id: i.id, code: i.code, site: i.site_id ? { id: i.site_id, name: H.siteName(i.site_id) } : null, kit: kit ? { id: kit.id, code: kit.code, kind: kit.kind, status: kit.status, away: kitAway(i, kit) } : null,
      device: dev ? { id: dev.id, code: dev.code, type: dev.type } : null, label: i.label, text: i.text || '', status: i.status, status_label: INCIDENT_ST[i.status] || i.status,
      raised_by: by ? { id: by.id, name: by.name, role: by.role, role_label: H.ROLE_LABEL[by.role] } : null, created_at: i.created_at, ack_at: i.ack_at, resolved_at: i.resolved_at,
      resolution: i.resolution, resolution_label: i.resolution ? (INCIDENT_RES[i.resolution] || {}).label || i.resolution : '', resolve_note: i.resolve_note || '',
      resolved_by: who(i.resolved_by), job: job ? { id: job.id, code: job.code, team: job.team, status: job.status, assignee: who(job.assignee_id), due_at: job.due_at } : null,
      swap: swap ? { id: swap.id, code: swap.code, team: swap.team, status: swap.status } : null, // team: màn hình chỉ gắn link chi tiết việc cho đúng team (máy chủ chặn việc ngoài team)
      photos: (pre ? pre.photos.get(`inc:${i.id}`) || [] : store.photos.find({ ref: `inc:${i.id}` }, { order: 'ts' })).map((p) => p.id),
    };
  }
  const brief = (i, viewer) => briefWith(i, viewer, null);
  const BRIEF_JOB_COLS = ['incident_id', 'type', 'status', 'code', 'assignee_id', 'due_at', 'created_at'];
  /** Danh sách sự cố: đọc việc xử lý và ảnh của cả danh sách trong hai lượt, không đọc riêng từng sự cố. */
  function briefList(rows, viewer) {
    if (!rows.length) return [];
    const ids = rows.map((i) => i.id);
    const jobs = new Map(), photos = new Map();
    // Mới nhất trước, như khi đọc riêng từng sự cố.
    // Chỉ các cột màn hình dùng (việc có cột JSON lớn, danh sách đọc vài trăm việc).
    for (const j of store.jobs.find({ incident_id: ids, type: ['incident', 'swap_faulty'] }, { order: 'created_at', desc: true, cols: BRIEF_JOB_COLS })) { if (!jobs.has(j.incident_id)) jobs.set(j.incident_id, []); jobs.get(j.incident_id).push(j); }
    for (const p of store.photos.find({ ref: ids.map((id) => `inc:${id}`) }, { order: 'ts' })) { if (!photos.has(p.ref)) photos.set(p.ref, []); photos.get(p.ref).push(p); }
    return rows.map((i) => briefWith(i, viewer, { jobs, photos }));
  }
  function incOrFail(id, user) {
    const i = store.incidents.get(K.idOf(id));
    if (!i) fail(404, 'not_found', 'Không tìm thấy sự cố.');
    if (user && H.isSale(user) && H.outlets.saleScope(user)) { const s = store.sites.get(i.site_id); if (!s || s.sale_id !== user.id) fail(403, 'forbidden', 'Sự cố này không thuộc BO của bạn.'); }
    return i;
  }
  const kindLabels = (kind) => { const L = H.labels(); return kind && L[kind] ? L[kind] : [...new Set(Object.values(L).flat())]; };

  /**
   * Tạo sự cố. Trùng BO, kit và nhãn với sự cố đang mở thì ghi thêm vào sự cố cũ, không tạo việc mới — kể cả sự cố đi kèm
   * yêu cầu đổi máy (opt.skipJob): việc đổi kit gắn vào sự cố cũ để một lỗi thật chỉ đếm một lần.
   */
  function create(spec, actor, opt = {}) {
    const site = H.outlets.outletOrFail(spec.site_id, actor, true); // báo sự cố là ghi: Sale chỉ BO của mình (xem mọi BO chỉ để xem)
    let kit = null, dev = null;
    if (spec.kit_id) {
      kit = H.stock.kitOrFail(spec.kit_id);
      if (kit.site_id !== site.id) fail(409, 'bad_kit', `Kit ${kit.code} không ở ${boLabel(site.name)}.`);
    }
    if (spec.device_id) {
      dev = store.devices.get(K.idOf(spec.device_id));
      if (!dev || !kit || dev.kit_id !== kit.id) fail(404, 'not_in_kit', 'Thiết bị không thuộc kit đã chọn.');
    }
    const label = cleanStr(spec.label, 60);
    if (!kindLabels(kit && kit.kind).includes(label)) fail(400, 'bad_label', 'Chọn nhãn lỗi trong danh sách.');
    const text = cleanText(spec.text, 500);
    if (text.length < 3) fail(400, 'text_required', 'Cần mô tả ngắn sự cố.');
    const dup = store.incidents.find({ site_id: site.id, kit_id: kit ? kit.id : null, label, status: OPEN }, { limit: 1 })[0];
    if (dup) {
      const what = opt.skipJob ? 'gửi yêu cầu đổi máy cho' : 'báo lại';
      log('incident', dup.id, 'dup', `${actor.name} ${what} sự cố ${dup.code}: ${text}`, actor);
      notify({ roles: ['tech_lead'] }, 'info', 'incident', `${actor.name} ${what} sự cố ${dup.code} tại ${site.name}: ${text}`, `incident:${dup.id}`);
      return { ...dup, duplicate: true };
    }
    const t = now();
    const row = { code: H.nextCode('S' + H.ym() + '-', 'incidents', 3), site_id: site.id, kit_id: kit ? kit.id : null, device_id: dev ? dev.id : null, label, text, status: 'open', raised_by: actor ? actor.id : null, raised_role: actor ? actor.role : null, resolution: null, resolve_note: null, resolved_by: null, created_at: t, ack_at: null, resolved_at: null };
    row.id = store.incidents.insert(row);
    if (opt.photos && opt.photos.length) H.savePhotos(opt.photos, `inc:${row.id}`, site.id, actor);
    if (!opt.skipJob) H.jobs.ensure({ type: 'incident', site_id: site.id, kit_id: row.kit_id, incident_id: row.id, title: `Sự cố ${label} tại ${site.name}${kit ? ` (kit ${kit.code})` : ''}`, note: text, dedupe: `inc:${row.id}`, priority: !!spec.urgent }, actor);
    log('incident', row.id, 'create', `${actor ? actor.name : 'Hệ thống'} (${actor ? H.ROLE_LABEL[actor.role] : ''}) báo sự cố ${row.code} tại ${site.name}: ${label} — ${text}`, actor);
    if (!opt.skipJob) notify({ roles: ['tech_lead', 'tech'] }, spec.urgent ? 'alert' : 'warn', 'incident', `Sự cố mới ${row.code} tại ${site.name}: ${label}${kit ? ` (kit ${kit.code})` : ''}.`, `incident:${row.id}`);
    changed('incidents', 'outlets', 'overview');
    return row;
  }
  /**
   * Xử lý xong sự cố. Đổi máy / mang về sửa: báo hỏng kit để hệ thống tự sinh việc đổi kit (kit ở BO) hoặc việc sửa (kit ở văn phòng).
   * Không phải sự cố / xử lý tại chỗ: việc đổi kit đi kèm (yêu cầu đổi máy) không còn cần — huỷ việc, gỡ cờ lỗi, đóng yêu cầu (H.jobs.dropSwap).
   */
  function resolve(inc, actor, resolution, note, deviceId) {
    if (!OPEN.includes(inc.status)) fail(409, 'closed', 'Sự cố đã đóng.');
    if (!INCIDENT_RES[resolution]) fail(400, 'bad_resolution', 'Chọn cách xử lý.');
    const n = cleanText(note, 500);
    if (resolution !== 'invalid' && n.length < 3) fail(400, 'note_required', 'Cần ghi ngắn đã xử lý thế nào.');
    // Kết luận không cần đổi kit trong khi việc đổi kit đang chờ Logistic Lead đối chiếu sau chuyến (FO có thể đã đổi thật): chờ Lead chốt trước.
    if (resolution === 'invalid' || resolution === 'no_recover') H.jobs.failIfHeld({ incident_id: inc.id, type: 'swap_faulty' }, 'Việc đổi kit của sự cố này');
    let follow = null;
    if (resolution === 'swap' || resolution === 'office_repair') {
      if (!inc.kit_id) fail(400, 'kit_required', 'Sự cố chưa gắn kit. Bấm "Gắn kit" để chọn kit rồi chọn lại cách xử lý.');
      const kit = store.kits.get(inc.kit_id);
      const why = `${inc.label}: ${n || inc.text}`;
      if (kit && kit.status === 'at_bo' && kit.site_id === inc.site_id) follow = H.stock.reportFaulty(kit, deviceId ? K.idOf(deviceId) : inc.device_id, why, actor, { incident_id: inc.id });
      else if (kit && kit.status === 'recovering' && kit.site_id === inc.site_id) {
        // Kit đang trên đường thu hồi từ chính BO của sự cố: gắn cờ lỗi để khi về kho tự chuyển Tech sửa.
        store.kits.update(kit.id, { fault: why, updated_at: now() });
        log('kit', kit.id, 'faulty', `${actor ? actor.name : 'Hệ thống'} ghi lỗi cho kit ${kit.code} theo sự cố ${inc.code}: ${why}. Kit về kho sẽ chuyển Tech sửa.`, actor);
        follow = 'noted';
      } else if (!kitAway(inc, kit)) follow = 'noted'; // kit đã ở Tech sửa: không cần làm gì thêm
      else {
        // Kit đã rời BO của sự cố (về kho, đã giao BO khác…): không đoán, không đổi kit ở chỗ mới; đưa vào Đối chiếu để Tech Lead quyết.
        const at = kit ? (kit.site_id ? `đang ở ${boLabel(H.siteName(kit.site_id))}` : `đang "${KIT_ST[kit.status] || kit.status}"`) : 'không còn';
        H.recon('incident', 'tech', 'high', 'incident', `inc:${inc.id}:moved`, `Sự cố ${inc.code} tại ${boLabel(H.siteName(inc.site_id))} được đóng bằng "${INCIDENT_RES[resolution].label}" nhưng kit ${kit ? kit.code : ''} ${at}, không còn ở BO của sự cố. Hệ thống không đổi hay báo hỏng kit; kiểm tra kit rồi báo hỏng nếu cần.`, { incident_id: inc.id, kit_id: inc.kit_id, site_id: inc.site_id });
        follow = 'recon';
      }
    }
    const t = now();
    store.incidents.update(inc.id, { status: 'resolved', resolution, resolve_note: n, resolved_by: actor ? actor.id : null, resolved_at: t, ack_at: inc.ack_at || t });
    log('incident', inc.id, 'resolve', `${actor ? actor.name : 'Hệ thống'} xử lý xong sự cố ${inc.code}: ${INCIDENT_RES[resolution].label}${n ? ` — ${n}` : ''}.`, actor);
    if (resolution === 'invalid' || resolution === 'no_recover') {
      for (const j of store.jobs.find({ incident_id: inc.id, type: 'swap_faulty', status: H.jobs.OPEN })) H.jobs.dropSwap(j, actor, `Tech kết luận sự cố ${inc.code}: ${INCIDENT_RES[resolution].label}`);
    }
    const s = store.sites.get(inc.site_id);
    notify({ ids: [inc.raised_by, s && s.sale_id] }, 'info', 'incident', `Sự cố ${inc.code} tại ${s ? s.name : ''} đã xử lý: ${INCIDENT_RES[resolution].label}${follow === 'swap_job' ? '. Logistics sẽ đổi kit ở lượt đổi thẻ gần nhất' : ''}.`, `incident:${inc.id}`, `inc_done:${inc.id}`);
    changed('incidents', 'outlets', 'overview');
    return follow;
  }
  // Việc "Xử lý sự cố" hoàn thành (qua nút Xong của việc hoặc nút xử lý của sự cố) → đóng sự cố.
  H.jobs.handlers.incident = (job, actor, res) => {
    const inc = store.incidents.get(job.incident_id);
    if (!inc) fail(404, 'not_found', 'Sự cố không còn.');
    const follow = resolve(inc, actor, res.resolution, res.note, res.device_id);
    return { resolution: res.resolution, note: cleanText(res.note, 300), follow, summary: INCIDENT_RES[res.resolution].label };
  };
  /** Việc khác gắn với sự cố hoàn thành: đổi kit hỏng xong thì sự cố (báo qua yêu cầu hỗ trợ đổi máy) cũng đóng. */
  function onJobDone(job, actor) {
    if (job.type !== 'swap_faulty') return;
    const inc = store.incidents.get(job.incident_id);
    if (!inc || !OPEN.includes(inc.status)) return;
    if (store.jobs.count({ incident_id: inc.id, type: 'incident', status: H.jobs.OPEN })) return; // Tech còn đang xử lý
    // Không có Tech nhận (sự cố đi kèm yêu cầu đổi máy): giữ trống giờ nhận để "Tech nhận sau" không tính giờ Logistics đổi kit.
    store.incidents.update(inc.id, { status: 'resolved', resolution: inc.resolution || 'swap', resolve_note: inc.resolve_note || 'Đã đổi kit tại BO', resolved_by: inc.resolved_by || null, resolved_at: now(), ack_at: inc.ack_at || null });
    log('incident', inc.id, 'resolve', `Sự cố ${inc.code} đóng sau khi đổi kit tại BO (${job.code}).`, actor);
    changed('incidents');
  }

  /**
   * Việc theo sau sự cố (đổi kit) bị huỷ mà sự cố không còn việc nào: đóng sự cố theo thực tế của kit, không để treo.
   * FO huỷ (thu hồi qua chuyến) thì không ghi FO là người xử lý: nhật ký vẫn giữ người thao tác thật cho Logistics.
   */
  function onJobCancelled(job, actor, note) {
    const inc = store.incidents.get(job.incident_id);
    if (!inc || !OPEN.includes(inc.status) || store.jobs.count({ incident_id: inc.id, status: H.jobs.OPEN })) return;
    const kit = inc.kit_id ? store.kits.get(inc.kit_id) : null;
    const resolution = kit && kit.fault ? 'office_repair' : 'no_recover';
    const text = resolution === 'office_repair' ? `Không đổi kit tại BO (${note}); kit lỗi về kho cùng đợt thu hồi và chuyển Tech sửa` : `Không cần đổi kit (${note})`;
    store.incidents.update(inc.id, { status: 'resolved', resolution, resolve_note: cleanText(text, 500), resolved_by: actor && actor.role !== 'fo' ? actor.id : null, resolved_at: now(), ack_at: inc.ack_at || null });
    log('incident', inc.id, 'resolve', `Sự cố ${inc.code} đóng: ${text}.`, actor);
    changed('incidents');
  }

  /** Sự cố chuyển "Tech đang xử lý"; người báo được báo tên người đang giữ việc. Gọi trong giao dịch của thao tác. */
  function markAck(inc, holder, actor) {
    store.incidents.update(inc.id, { status: 'ack', ack_at: now() });
    const name = H.userName(holder);
    log('incident', inc.id, 'ack', holder === actor.id ? `${actor.name} nhận xử lý sự cố ${inc.code}.` : `${actor.name} xác nhận sự cố ${inc.code} đã có Tech nhận (${name} đang giữ việc).`, actor);
    notify({ ids: [inc.raised_by] }, 'info', 'incident', `${name} (Tech) đang xử lý sự cố ${inc.code}.`, `incident:${inc.id}`, `inc_ack:${inc.id}`);
    changed('incidents', 'jobs');
  }
  /** Tech bấm "Bắt đầu" hoặc "Nhận việc" trên việc xử lý sự cố ở bảng việc: nhận luôn sự cố, như nút "Nhận xử lý". */
  function ackFromJob(job, actor) {
    if (job.type !== 'incident' || !job.incident_id) return;
    const inc = store.incidents.get(job.incident_id);
    if (!inc || inc.status !== 'open') return;
    markAck(inc, store.jobs.get(job.id).assignee_id || actor.id, actor);
  }

  // ───────────────────────── API ─────────────────────────
  R('GET', '/api/hub/labels', G.STAFF, () => ({ labels: H.labels() }));
  R('GET', '/api/hub/incidents', G.STAFF, ({ user, q }) => {
    const where = {};
    if (q.status === 'open') where.status = OPEN;
    else if (q.status === 'counted') { where.status = { ne: 'cancelled' }; where.resolution = { ne: 'invalid' }; } // đúng tập Top 10 và "BO có nhiều sự cố" đếm
    else if (q.status && INCIDENT_ST[q.status]) where.status = q.status;
    if (q.site) where.site_id = K.idOf(q.site);
    if (q.label) where.label = String(q.label);
    // Kỳ theo ngày Việt Nam: từ đầu ngày "from" đến hết ngày "to" (ngày không hợp lệ thì bỏ qua).
    const range = {};
    if (isDate(q.from)) range.gte = tsRange({ from: q.from, to: q.from }, off).t0;
    if (isDate(q.to)) range.lt = tsRange({ from: q.to, to: q.to }, off).t1;
    if (Object.keys(range).length) where.created_at = range;
    // Dòng kit: theo loại kit đang gắn; "none" là sự cố chưa gắn kit.
    if (q.kind === 'none') where.kit_id = null;
    else if (KIT_KINDS[q.kind]) where.kit_id = store.kits.find({ kind: q.kind }).map((k) => k.id);
    // Sale chỉ thấy BO của mình: lọc ngay trong truy vấn (trước giới hạn số dòng) để không sót sự cố cũ hơn của BO mình;
    // số "đang mở" cũng đếm trong phạm vi đó, khớp với danh sách.
    const mine = H.isSale(user) && H.outlets.saleScope(user) ? store.sites.find({ sale_id: user.id }).map((s) => s.id) : null;
    if (mine) {
      if (!mine.length || (where.site_id && !mine.includes(where.site_id))) return { incidents: [], open: 0 };
      if (!where.site_id) where.site_id = mine;
    }
    const rows = store.incidents.find(where, { order: 'created_at', desc: true, limit: int(q.limit, 1, 1000) || 300 });
    return { incidents: briefList(rows, user), open: store.incidents.count(mine ? { status: OPEN, site_id: mine } : { status: OPEN }) };
  });
  R('GET', '/api/hub/incidents/stats', [...G.OVERVIEW, 'tech'], ({ q }) => stats(q.period === 'month' ? 'month' : 'week', q.key));
  R('GET', '/api/hub/incidents/:id', G.STAFF, ({ user, p }) => {
    const i = incOrFail(p.id, user);
    const out = { incident: brief(i, user), log: H.isSale(user) ? [] : store.hub_log.find({ entity: 'incident', entity_id: i.id }, { order: 'ts', desc: true, limit: 40 }) };
    const isOpen = OPEN.includes(i.status), hold = mayHold(user, openJob(i)), win = H.cfg().incidentCancelMin;
    out.can_ack = hold && i.status === 'open';
    out.can_handle = hold && isOpen;
    out.can_attach = hold && isOpen && !i.kit_id;
    out.cancel_min = win;
    out.can_cancel = isOpen && (['admin', 'tech_lead'].includes(user.role) || (i.raised_by === user.id && now() - i.created_at < win * 60000));
    out.resolutions = Object.entries(INCIDENT_RES).map(([id, r]) => ({ id, label: r.label }));
    return out;
  });
  R('POST', '/api/hub/incidents', G.STAFF, ({ user, b }) => {
    const photos = H.decodePhotos(b.photos, 0);
    let row;
    store.tx(() => { row = create({ site_id: b.site_id, kit_id: b.kit_id || null, device_id: b.device_id || null, label: b.label, text: b.text, urgent: !!b.urgent }, user, { photos }); });
    return { incident: brief(store.incidents.get(row.id), user), duplicate: !!row.duplicate };
  });
  // Nhận xử lý: chỉ người đang giữ việc hoặc Tech Lead; việc chưa ai giữ thì người bấm nhận luôn việc. Thông báo nêu người giữ việc.
  R('POST', '/api/hub/incidents/:id/ack', G.TECH, ({ user, p }) => {
    const i = incOrFail(p.id);
    if (i.status !== 'open') fail(409, 'bad_state', 'Sự cố không ở trạng thái mới báo.');
    const j = openJob(i);
    if (!mayHold(user, j)) fail(409, 'taken', heldBy(j));
    const t = now(), holder = (j && j.assignee_id) || user.id;
    // Nhận qua sự cố như nhận việc (/jobs/:id/claim): người nhận mới có lúc nhận và hạn riêng (người nhận sau không bị tính trễ phần trước đó).
    const take = (x) => ({ ...H.jobs.holderPatch(x, holder, 'self', t), ...(x.assignee_id !== holder ? { skip_uid: null, skip_at: null, skip_due: null } : {}) });
    store.tx(() => {
      if (j && j.status === 'open') {
        store.jobs.update(j.id, { status: 'doing', started_at: t, ...take(j) });
        log('job', j.id, 'start', `${user.name} nhận xử lý sự cố ${i.code}${holder !== user.id ? ` (${H.userName(holder)} đang giữ việc)` : ''}.`, user);
      } else if (j && !j.assignee_id) {
        store.jobs.update(j.id, take(j));
        log('job', j.id, 'claim', `${user.name} nhận việc ${j.code}.`, user);
      }
      markAck(i, holder, user);
    });
    return { incident: brief(store.incidents.get(i.id), user) };
  });
  R('POST', '/api/hub/incidents/:id/resolve', G.TECH, ({ user, p, b }) => {
    const i = incOrFail(p.id);
    const job = openJob(i);
    const res = { resolution: b.resolution, note: b.note, device_id: b.device_id };
    if (job) {
      if (job.assignee_id && job.assignee_id !== user.id && !H.jobs.isLeadOf(user, 'tech')) fail(403, 'forbidden', `${H.userName(job.assignee_id)} đang giữ sự cố này.`);
      H.jobs.complete(job, user, res, {});
    } else store.tx(() => resolve(i, user, res.resolution, res.note, res.device_id));
    return { incident: brief(store.incidents.get(i.id), user) };
  });
  /**
   * Gắn kit cho sự cố báo lúc chưa rõ kit nào (để chọn đổi máy / mang về sửa mà không phải báo lại). Người giữ việc hoặc Tech Lead.
   * Kit đã có sự cố đang mở cùng lỗi thì gộp vào sự cố đó (sự cố này huỷ, ghi "gộp"), để một lỗi thật chỉ đếm một lần.
   */
  R('POST', '/api/hub/incidents/:id/kit', G.TECH, ({ user, p, b }) => {
    const i = incOrFail(p.id);
    if (!OPEN.includes(i.status)) fail(409, 'closed', 'Sự cố đã đóng.');
    if (i.kit_id) fail(409, 'has_kit', 'Sự cố đã gắn kit.');
    const j = openJob(i);
    if (!mayHold(user, j)) fail(403, 'forbidden', heldBy(j));
    const kit = H.stock.kitOrFail(b.kit_id);
    const site = store.sites.get(i.site_id);
    const where = boLabel(site ? site.name : '');
    if (kit.site_id !== i.site_id || kit.status !== 'at_bo') fail(409, 'bad_kit', `Kit ${kit.code} không ở ${where}.`);
    let dev = null;
    if (b.device_id) { dev = store.devices.get(K.idOf(b.device_id)); if (!dev || dev.kit_id !== kit.id) fail(404, 'not_in_kit', 'Thiết bị không thuộc kit đã chọn.'); }
    if (!kindLabels(kit.kind).includes(i.label)) fail(400, 'bad_label', `Lỗi "${i.label}" không có trong danh sách lỗi của ${KIT_KINDS[kit.kind] || kit.kind}. Huỷ sự cố này và báo lại với đúng lỗi.`);
    const dup = store.incidents.find({ site_id: i.site_id, kit_id: kit.id, label: i.label, status: OPEN }, { limit: 1 })[0];
    if (dup) {
      store.tx(() => {
        store.incidents.update(i.id, { status: 'cancelled', resolve_note: `Gộp vào ${dup.code} (cùng kit ${kit.code}, cùng lỗi)`, resolved_by: user.id, resolved_at: now() });
        H.jobs.cancelFor({ incident_id: i.id, type: 'incident' }, user, `Sự cố gộp vào ${dup.code}`);
        log('incident', i.id, 'cancel', `${user.name} gắn kit ${kit.code} cho sự cố ${i.code}: trùng sự cố đang mở ${dup.code}, gộp vào đó.`, user);
        log('incident', dup.id, 'dup', `${user.name} gộp sự cố ${i.code} (cùng kit ${kit.code}, cùng lỗi) vào ${dup.code}: ${i.text}`, user);
      });
      notify({ ids: [i.raised_by] }, 'info', 'incident', `Sự cố ${i.code} tại ${where} trùng sự cố ${dup.code} (kit ${kit.code}) nên đã gộp; theo dõi ở ${dup.code}.`, `incident:${dup.id}`);
      if (j && j.assignee_id && j.assignee_id !== user.id) notify({ ids: [j.assignee_id] }, 'info', 'job', `Việc ${j.code} đã huỷ: sự cố ${i.code} gộp vào ${dup.code}.`, `incident:${dup.id}`);
      changed('incidents', 'jobs');
      return { incident: brief(store.incidents.get(dup.id), user), merged: true };
    }
    store.tx(() => {
      store.incidents.update(i.id, { kit_id: kit.id, device_id: dev ? dev.id : null });
      if (j) store.jobs.update(j.id, { kit_id: kit.id, title: cleanStr(`Sự cố ${i.label} tại ${site ? site.name : ''} (kit ${kit.code})`, 160) });
      log('incident', i.id, 'kit', `${user.name} gắn kit ${kit.code}${dev ? ` (${dev.code})` : ''} cho sự cố ${i.code}.`, user);
    });
    changed('incidents', 'jobs');
    return { incident: brief(store.incidents.get(i.id), user), merged: false };
  });
  R('POST', '/api/hub/incidents/:id/cancel', G.STAFF, ({ user, p, b }) => {
    const i = incOrFail(p.id, user);
    if (!OPEN.includes(i.status)) fail(409, 'closed', 'Sự cố đã đóng.');
    const win = H.cfg().incidentCancelMin;
    const mine = i.raised_by === user.id && now() - i.created_at < win * 60000;
    if (!mine && !['admin', 'tech_lead'].includes(user.role)) fail(403, 'forbidden', win ? `Người báo huỷ được trong ${win} phút đầu; sau đó Tech Lead huỷ.` : 'Tech Lead huỷ sự cố.');
    H.jobs.failIfHeld({ incident_id: i.id, type: 'swap_faulty' }, 'Việc đổi kit của sự cố này');
    const reason = reasonOf(b.reason, 'lý do huỷ');
    store.tx(() => {
      store.incidents.update(i.id, { status: 'cancelled', resolve_note: reason, resolved_by: user.id, resolved_at: now() });
      H.jobs.cancelFor({ incident_id: i.id, type: 'incident' }, user, 'Sự cố được huỷ');
      // Sự cố đi kèm yêu cầu đổi máy: việc đổi kit, cờ lỗi do lần báo này đặt và yêu cầu hỗ trợ đi theo.
      for (const j of store.jobs.find({ incident_id: i.id, type: 'swap_faulty', status: H.jobs.OPEN })) H.jobs.dropSwap(j, user, `Sự cố ${i.code} được huỷ: ${reason}`);
      log('incident', i.id, 'cancel', `${user.name} huỷ sự cố ${i.code}: ${reason}.`, user);
    });
    changed('incidents', 'jobs');
    return { incident: brief(store.incidents.get(i.id), user) };
  });

  // ───────────────────────── Thống kê: top lỗi, WoW, MoM, lỗi tăng vọt ─────────────────────────
  /**
   * Đếm sự cố theo nhãn trong kỳ đang xem, kỳ trước, trung bình 4 tuần trước (khi xem theo tuần) và tháng trước.
   * Mỗi nhãn lỗi một dòng (gộp mọi dòng kit và sự cố chưa rõ kit; kinds chia nhỏ theo dòng kit, '' là chưa gắn kit).
   * Lỗi tăng vọt: ít nhất spikeMin lần trong tuần và gấp đôi trung bình 4 tuần trước. Tỉ lệ đổi máy từ 50% được đánh dấu.
   * "Không phải sự cố" không vào dòng lỗi, lỗi tăng vọt và BO nhiều sự cố; đếm riêng (invalid). total vẫn là số lần báo (trừ đã huỷ).
   * Lỗi phát hiện ở văn phòng (kiểm kit, check-in không đạt) được đếm riêng để có số gộp một chỗ.
   */
  // Thống kê đọc nhiều tuần sự cố: nhớ (H.memo) tới khi bảng sự cố, việc, kit… đổi; kỳ đang chạy so cùng mốc nên tính lại sau 5 giây.
  function stats(period, key) {
    const P = periodOf(period, key, today());
    return H.memo(`incstats|${period}|${P.key}|${today()}`, () => statsRaw(period, P), 5000);
  }
  function statsRaw(period, P) {
    const r = tsRange(P, off);
    // Kỳ đang chạy: kỳ trước và trung bình 4 tuần trước chỉ tính cùng khoảng thời gian đã trôi của mỗi kỳ (H.compare), để không so nửa tuần với cả tuần.
    const C = H.compare(P), prevR = C.ts.prev;
    const elapsed = C.running ? C.ts.cur.t1 - r.t0 : Infinity;
    const WEEK = 7 * 86400000;
    const avgFrom = period === 'week' ? tsRange(weekRange(shiftWeek(P.key, -4)), off).t0 : null;
    const all = store.incidents.find({ created_at: { gte: Math.min(prevR.t0, avgFrom || prevR.t0), lt: r.t1 } }).filter((i) => i.status !== 'cancelled');
    const kindOf = (i) => { const k = i.kit_id ? store.kits.get(i.kit_id) : null; return k ? k.kind : ''; };
    const by = new Map();
    const row = (i) => { if (!by.has(i.label)) by.set(i.label, { label: i.label, cur: 0, prev: 0, avg4: 0, swaps: 0, resolved: 0, sites: new Set(), kinds: new Map() }); return by.get(i.label); };
    let cur = 0, prev = 0, inv = 0, prevInv = 0, ackSum = 0, ackN = 0, resSum = 0, resN = 0;
    const bySite = new Map();
    for (const i of all) {
      const bad = i.resolution === 'invalid';
      if (i.created_at >= r.t0) {
        cur++;
        if (bad) inv++;
        else {
          const x = row(i), kd = kindOf(i);
          x.cur++; x.sites.add(i.site_id); x.kinds.set(kd, (x.kinds.get(kd) || 0) + 1);
          bySite.set(i.site_id, (bySite.get(i.site_id) || 0) + 1);
          if (i.status === 'resolved') { x.resolved++; if (i.resolution === 'swap' || i.resolution === 'office_repair') x.swaps++; }
        }
        if (i.ack_at) { ackSum += i.ack_at - i.created_at; ackN++; }
        if (i.resolved_at && i.status === 'resolved') { resSum += i.resolved_at - i.created_at; resN++; }
      } else if (i.created_at >= prevR.t0 && i.created_at < prevR.t1) { prev++; if (bad) prevInv++; else row(i).prev++; }
      if (!bad && avgFrom && i.created_at >= avgFrom && i.created_at < r.t0 && (i.created_at - avgFrom) % WEEK < elapsed) row(i).avg4 += 0.25;
    }
    const c = H.cfg();
    const top = [...by.values()].filter((x) => x.cur || x.prev).map((x) => {
      const kinds = [...x.kinds.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || (a.kind ? 0 : 1) - (b.kind ? 0 : 1) || a.kind.localeCompare(b.kind));
      return {
        label: x.label, kind: kinds.length === 1 && kinds[0].kind ? kinds[0].kind : null, kinds, count: x.cur, prev: x.prev, delta: x.cur - x.prev, delta_pct: x.prev ? Math.round(((x.cur - x.prev) / x.prev) * 100) : null,
        avg4: period === 'week' ? +x.avg4.toFixed(2) : null, spike: period === 'week' && x.cur >= c.spikeMin && x.cur >= 2 * x.avg4,
        swap_rate: x.resolved ? Math.round((x.swaps / x.resolved) * 100) : null, sites: x.sites.size,
      };
    }).sort((a, b) => b.count - a.count || b.prev - a.prev || a.label.localeCompare(b.label));
    // Lỗi phát hiện ở văn phòng trong kỳ: kiểm kit / check-in không đạt (theo loại kit).
    const office = {};
    for (const j of store.jobs.find({ type: ['check_kit', 'checkin'], status: 'done', done_at: { gte: r.t0, lt: r.t1 } })) {
      if (!j.result || j.result.pass !== false) continue;
      const k = j.kit_id ? store.kits.get(j.kit_id) : null;
      const kind = k ? k.kind : 'khác';
      office[kind] = (office[kind] || 0) + 1;
    }
    return {
      period: P.period, key: P.key, label: P.period === 'month' ? monthLabel(P.key) : weekLabel(P.key), prev_label: P.period === 'month' ? monthLabel(P.prev) : weekLabel(P.prev), from: P.from, to: P.to, cmp: C.info,
      total: cur, prev_total: prev, delta: cur - prev, invalid: inv, prev_invalid: prevInv, top: top.slice(0, 10), all: top,
      sites: [...bySite.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([sid, n]) => ({ site: { id: sid, name: H.siteName(sid) }, count: n })),
      avg_ack_min: ackN ? Math.round(ackSum / ackN / 60000) : null, avg_resolve_min: resN ? Math.round(resSum / resN / 60000) : null,
      open: store.incidents.count({ status: OPEN }), office_faults: office,
    };
  }
  /** Chuỗi số sự cố theo tuần (cho biểu đồ xu hướng). */
  function weekly(n, endKey) { return H.memo(`incweekly|${n}|${endKey}`, () => weeklyRaw(n, endKey)); }
  function weeklyRaw(n, endKey) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const k = shiftWeek(endKey, -i), rr = tsRange(weekRange(k), off);
      out.push({ key: k, label: weekLabel(k), count: store.incidents.count({ created_at: { gte: rr.t0, lt: rr.t1 }, status: { ne: 'cancelled' } }) });
    }
    return out;
  }

  return { create, resolve, brief, briefList, stats, weekly, onJobDone, onJobCancelled, ackFromJob, OPEN };
}
