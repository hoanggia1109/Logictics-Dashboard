// stock.js — danh mục loại thiết bị, thiết bị theo mã, kit, phụ kiện theo số lượng.
import { cleanStr, cleanText, int, boLabel } from '../util.js';
import { fail } from '../core.js';
import { KIT_ST, KIT_EDITABLE, KIT_OUTSIDE, KIT_KINDS, KIT_CORE, DEV_COND, HEALTH, CARD_ST, ACC_MOVE } from './defs.js';

export function installStock(H) {
  const { K, G, store, now, log, changed, codeOf, codesOf, reasonOf, idList } = H;
  const { R } = K;
  const typeMap = () => new Map(store.dev_types.find({}, { order: 'sort' }).map((t) => [t.id, t]));
  const isLead = (u) => u.role === 'admin' || u.role === 'lead' || u.role === 'tech_lead';

  // Tổng số phụ kiện là sổ kho của Logistics (nhập thêm, kiểm kê đều có dòng sổ); Tech Lead sửa danh mục nhưng không đổi số lượng.
  const ACC_OWN = 'Số lượng phụ kiện do Logistics ghi trong sổ kho (nhập thêm, kiểm kê).';

  // ───────────────────────── Danh mục loại ─────────────────────────
  R('GET', '/api/hub/types', G.STAFF, () => ({ types: store.dev_types.find({}, { order: 'sort' }) }));
  R('POST', '/api/hub/types', ['admin', 'lead', 'logistic', 'tech_lead'], ({ user, b }) => {
    const id = cleanStr(b.id || b.name, 40).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const name = cleanStr(b.name, 60);
    if (!name || !id) fail(400, 'bad_name', 'Cần nhập tên loại.');
    if (!['device', 'acc'].includes(b.kind)) fail(400, 'bad_kind', 'Chọn loại: thiết bị theo mã hoặc phụ kiện theo số lượng.');
    if (store.dev_types.get(id)) fail(409, 'exists', 'Loại này đã có trong danh mục.');
    const row = { id, name, kind: b.kind, core: b.core ? 1 : 0, sort: (store.dev_types.count({}) + 1) * 10, active: 1, total: 0, created_at: now() };
    const qty = b.kind === 'acc' && b.total !== undefined && b.total !== '' ? int(b.total, 0, 1e6) ?? fail(400, 'bad_number', 'Số lượng phải là số nguyên từ 0.') : 0;
    if (qty && !G.LOGI.includes(user.role)) fail(403, 'forbidden', ACC_OWN);
    store.tx(() => {
      store.dev_types.insert(row);
      log('type', null, 'create', `${user.name} thêm loại "${name}" vào danh mục.`, user, { id });
      if (qty) accMove(id, qty, 'in', 'Khai báo số lượng khi thêm loại phụ kiện', user);
    });
    changed('types', 'acc');
    return { type: store.dev_types.get(id) };
  });
  R('PATCH', '/api/hub/types/:id', ['admin', 'lead', 'logistic', 'tech_lead'], ({ user, p, b }) => {
    const t = store.dev_types.get(p.id);
    if (!t) fail(404, 'not_found', 'Không tìm thấy loại.');
    const patch = {};
    if (b.name !== undefined) { patch.name = cleanStr(b.name, 60); if (!patch.name) fail(400, 'bad_name', 'Cần nhập tên loại.'); }
    if (b.active !== undefined) patch.active = b.active ? 1 : 0;
    let total = null;
    if (b.total !== undefined) {
      if (t.kind !== 'acc') fail(400, 'not_acc', 'Chỉ phụ kiện mới nhập tổng số lượng; thiết bị theo mã được đếm tự động.');
      total = int(b.total, 0, 1e6) ?? fail(400, 'bad_number', 'Số lượng phải là số nguyên từ 0.');
      if (total !== (t.total || 0) && !G.LOGI.includes(user.role)) fail(403, 'forbidden', ACC_OWN);
    }
    store.tx(() => {
      if (Object.keys(patch).length) { store.dev_types.update(t.id, patch); log('type', null, 'update', `${user.name} sửa loại "${t.name}".`, user, { id: t.id, patch }); }
      // Đổi tổng số lượng = một dòng kiểm kê trong sổ kho (bắt buộc lý do), không ghi đè lặng lẽ.
      if (total !== null && total !== (t.total || 0)) accMove(t.id, total - (t.total || 0), 'count', reasonOf(b.reason, 'lý do đổi tổng số lượng'), user);
    });
    changed('types', 'acc');
    return { type: store.dev_types.get(t.id) };
  });

  // ───────────────────────── Thiết bị ─────────────────────────
  function devView(d, kitsById, types) {
    const kit = d.kit_id ? kitsById.get(d.kit_id) || store.kits.get(d.kit_id) : null;
    const tp = types.get(d.type);
    return { id: d.id, code: d.code, type: d.type, type_name: tp ? tp.name : d.type, cond: d.cond, health: d.health || null, note: d.note || '', kit: kit ? { id: kit.id, code: kit.code, status: kit.status } : null, updated_at: d.updated_at };
  }
  R('GET', '/api/hub/devices', G.STOCK_VIEW, ({ q }) => {
    const where = {};
    if (q.type) where.type = String(q.type);
    if (q.cond) where.cond = String(q.cond);
    if (q.free === '1') where.kit_id = null;
    let rows = store.devices.find(where, { order: 'code' });
    if (q.q) { const s = String(q.q).toUpperCase(); rows = rows.filter((d) => d.code.includes(s)); }
    const total = rows.length;
    const kitsById = new Map(store.kits.find({}).map((k) => [k.id, k]));
    const types = typeMap();
    return { total, devices: rows.slice(0, int(q.limit, 1, 2000) || 500).map((d) => devView(d, kitsById, types)) };
  });
  /** Thêm nhiều thiết bị cùng loại một lần (dán danh sách mã). Mã đã có thì bỏ qua và báo lại. */
  function addDevices(type, codes, note, actor, quiet) {
    const tp = store.dev_types.get(type);
    if (!tp || tp.kind === 'acc') fail(400, 'bad_type', 'Chọn loại thiết bị theo mã (không phải phụ kiện).');
    const t = now(), made = [], dup = [];
    store.tx(() => {
      for (const code of codes) {
        // Mã thiết bị và mã thẻ nhớ dùng chung một không gian mã (quét mã ra đúng một món).
        if (store.devices.count({ code }) || store.cards.count({ code })) { dup.push(code); continue; }
        if (tp.kind === 'card') store.cards.insert({ code, status: 'office', site_id: null, kit_id: null, handover_id: null, since: t, note: note || '', created_at: t, updated_at: t });
        else store.devices.insert({ code, type, cond: 'ok', kit_id: null, health: type === 'powerbank' ? 'good' : null, note: note || '', created_at: t, updated_at: t });
        made.push(code);
      }
      if (made.length && !quiet) log(tp.kind === 'card' ? 'card' : 'device', null, 'create', `${actor ? actor.name : 'Hệ thống'} thêm ${made.length} ${tp.name}.`, actor, { codes: made.slice(0, 200) });
    });
    if (made.length) changed(tp.kind === 'card' ? 'cards' : 'devices', 'overview');
    return { added: made.length, duplicates: dup };
  }
  R('POST', '/api/hub/devices', ['admin', 'lead', 'logistic', 'tech_lead'], ({ user, b }) => addDevices(String(b.type || ''), codesOf(b.codes), cleanStr(b.note, 200), user));
  R('PATCH', '/api/hub/devices/:id', [...G.LOGI, 'tech_lead', 'tech'], ({ user, p, b }) => {
    const d = store.devices.get(K.idOf(p.id));
    if (!d) fail(404, 'not_found', 'Không tìm thấy thiết bị.');
    const patch = { updated_at: now() };
    const notes = [];
    if (b.code !== undefined) {
      const code = codeOf(b.code, 'Mã thiết bị');
      if (code !== d.code) {
        if (store.devices.count({ code })) fail(409, 'exists', `Mã ${code} đã có.`);
        if (store.cards.count({ code })) fail(409, 'exists', `Mã ${code} đang là mã thẻ nhớ.`);
        if (d.kit_id) { const kit = store.kits.get(d.kit_id); if (kit && !KIT_EDITABLE.includes(kit.status)) fail(409, 'kit_locked', 'Thiết bị đang nằm trong kit đã khoá; chỉ đổi mã khi kit đang ở văn phòng.'); }
        patch.code = code; notes.push(`đổi mã ${d.code} → ${code}`);
      }
    }
    if (b.note !== undefined) patch.note = cleanText(b.note, 300);
    if (b.health !== undefined) { if (b.health !== null && !HEALTH[b.health]) fail(400, 'bad_value', 'Tình trạng pin không hợp lệ.'); patch.health = b.health; notes.push(`sức khoẻ: ${HEALTH[b.health] || 'chưa đánh giá'}`); }
    if (b.cond !== undefined) {
      if (!DEV_COND[b.cond]) fail(400, 'bad_value', 'Tình trạng không hợp lệ.');
      if (b.cond === 'faulty') fail(400, 'use_faulty', 'Báo hỏng bằng nút "Báo hỏng" để hệ thống chuyển cả kit sang Tech.');
      if ((b.cond === 'retired' || b.cond === 'lost') && !isLead(user) && user.role !== 'tech') fail(403, 'forbidden', 'Chỉ Lead hoặc Tech được đánh dấu ngừng dùng / thất lạc.');
      // Thiết bị đã báo hỏng / đang sửa: Tech kiểm rồi mới xác nhận tốt (hoặc chuyển sang sửa); Logistics không xoá cờ hỏng.
      if (['faulty', 'repairing'].includes(d.cond) && ['ok', 'repairing'].includes(b.cond) && b.cond !== d.cond && !G.TECH.includes(user.role)) fail(403, 'forbidden', `Thiết bị ${d.code} đang "${DEV_COND[d.cond]}": Tech kiểm rồi xác nhận tình trạng.`);
      if (b.cond !== d.cond) {
        if ((b.cond === 'retired' || b.cond === 'lost') && d.kit_id) patch.kit_id = null;
        patch.cond = b.cond; notes.push(`tình trạng: ${DEV_COND[d.cond]} → ${DEV_COND[b.cond]}${b.reason ? ` (${cleanStr(b.reason, 200)})` : ''}`);
      }
    }
    // Thiết bị trong kit chuyển sang không dùng được (thất lạc, ngừng dùng, đang sửa): kit không còn đủ, xử lý theo nơi kit đang ở.
    const kit = d.kit_id && patch.cond && patch.cond !== 'ok' ? store.kits.get(d.kit_id) : null;
    if (kit && kit.status === 'delivering') fail(409, 'in_trip', `Kit ${kit.code} đang trên đường giao. Đợi FO giao xong hoặc huỷ chuyến rồi ghi nhận.`);
    if (kit && LOCKED_OFFICE.includes(kit.status)) H.jobs.failIfKitInTrip(kit);
    store.tx(() => {
      store.devices.update(d.id, patch);
      log('device', d.id, 'update', `${user.name} sửa thiết bị ${d.code}${notes.length ? ': ' + notes.join('; ') : ''}.`, user, patch);
      if (patch.kit_id === null && d.kit_id) log('kit', d.kit_id, 'device_out', `${d.code} rời kit (${DEV_COND[patch.cond]}).`, user);
      if (!kit) return;
      const why = `${d.code} ${DEV_COND[patch.cond].toLowerCase()}`;
      if (LOCKED_OFFICE.includes(kit.status)) {
        // Kit đã kiểm / đã gán: về "đang chuẩn bị" để Logistics bổ sung thiết bị và gửi kiểm lại; yêu cầu đi kèm tự tính lại.
        setKit(kit, 'preparing', user, `Kit ${kit.code} thiếu thiết bị dùng được (${why}); cần bổ sung rồi gửi kiểm lại.`, { checked_at: null, checked_by: null });
        H.jobs.cancelFor({ type: ['check_kit', 'receive_back'], kit_id: kit.id }, user, `Kit thiếu thiết bị (${why})`);
        if (kit.request_id) H.outlets.refreshRequest(kit.request_id, user);
      } else if (kit.status === 'at_bo') reportFaulty(kit, null, `Thiết bị ${why}`, user);
    });
    changed('devices', 'kits', 'overview');
    return { ok: true };
  });

  // ───────────────────────── Kit ─────────────────────────
  const LOCKED_OFFICE = ['ready', 'reserved', 'wait_check', 'tech_done']; // kit ở văn phòng đã chốt thành phần
  function kitDevices(kitId) { return store.devices.find({ kit_id: kitId }, { order: 'code' }); }
  /** Kit đủ thành phần chưa: đủ thiết bị chính theo loại kit và không có thiết bị nào hỏng. */
  function completeness(kit, devs) {
    const missing = [];
    for (const t of KIT_CORE[kit.kind] || []) if (!devs.some((d) => d.type === t && d.cond === 'ok')) missing.push(t);
    const faulty = devs.filter((d) => d.cond !== 'ok').length;
    return { complete: !missing.length && !faulty && devs.length > 0, missing, faulty };
  }
  function kitView(kit, devs, opt = {}) {
    devs = devs || kitDevices(kit.id);
    const types = opt.types || typeMap();
    const site = kit.site_id ? H.rowOf('sites', kit.site_id) : null;
    const c = completeness(kit, devs);
    const out = {
      id: kit.id, code: kit.code, kind: kit.kind, kind_label: KIT_KINDS[kit.kind] || kit.kind, status: kit.status, status_label: KIT_ST[kit.status] || kit.status,
      site: site ? { id: site.id, name: site.name, code: site.code || '' } : null, request_id: kit.request_id, acc: kit.acc || {}, note: kit.note || '',
      checked_at: kit.checked_at, editable: KIT_EDITABLE.includes(kit.status), outside: KIT_OUTSIDE.includes(kit.status), updated_at: kit.updated_at,
      watch: kit.watch || '', fault: kit.fault || '',
      devices: devs.map((d) => ({ id: d.id, code: d.code, type: d.type, type_name: (types.get(d.type) || {}).name || d.type, cond: d.cond, health: d.health || null })),
      ...c,
    };
    if (opt.full) {
      out.jobs = store.jobs.find({ kit_id: kit.id }, { order: 'created_at', desc: true, limit: 30 }).map(H.jobs.viewFor(opt.user));
      out.log = store.hub_log.find({ entity: 'kit', entity_id: kit.id }, { order: 'ts', desc: true, limit: 80 });
      out.cards = store.cards.find({ kit_id: kit.id }).map((cd) => ({ id: cd.id, code: cd.code, status: cd.status }));
      out.lock_reason = out.editable ? '' : lockReason(kit.status);
    }
    return out;
  }
  function lockReason(st) {
    if (st === 'wait_check') return 'Kit đang chờ Tech kiểm. Muốn sửa: Tech trả kết quả "không đạt" hoặc Logistics bấm "Mở lại để chỉnh" kèm lý do (việc Tech kiểm đang chờ sẽ tự huỷ, kit phải kiểm lại).';
    if (st === 'ready' || st === 'reserved') return 'Kit đã được kiểm đạt. Sửa thành phần thì kit phải kiểm lại: bấm "Mở lại để chỉnh" (kit quay về Đang chuẩn bị).';
    if (KIT_OUTSIDE.includes(st)) return 'Kit đang ở ngoài văn phòng. Chỉ Logistic Lead được điều chỉnh cho khớp thực tế, bắt buộc ghi lý do.';
    if (st === 'tech_done') return 'Tech đã xử lý xong, chờ Logistics bấm nhận lại.';
    return 'Kit đã ngừng dùng.';
  }
  function kitOrFail(id) { const k = store.kits.get(K.idOf(id)); if (!k) fail(404, 'not_found', 'Không tìm thấy kit.'); return k; }
  /** Đổi trạng thái kit, ghi nhật ký. Mọi chỗ đổi trạng thái kit đều đi qua đây. */
  function setKit(kit, status, actor, text, extra = {}) {
    const patch = { status, updated_at: now(), ...extra };
    store.kits.update(kit.id, patch);
    // site_id: BO kit tới (khi sang "ở BO") hoặc BO kit rời đi — để dựng lại số kit ở BO theo từng ngày.
    log('kit', kit.id, 'status', text || `${kit.code}: ${KIT_ST[kit.status]} → ${KIT_ST[status]}.`, actor, { from: kit.status, to: status, site_id: (status === 'at_bo' ? patch.site_id ?? kit.site_id : kit.site_id) ?? null });
    if (kit.status === 'at_bo' && status !== 'at_bo' && H.jobs) {
      // Kit rời BO (đổi, thu hồi): việc giao phụ kiện cho kit đó không còn cần (kể cả khi đã lên chuyến: phụ kiện chưa trừ kho, FO mang về);
      // yêu cầu hỗ trợ đi kèm đóng và báo người gửi.
      for (const j of store.jobs.find({ type: 'deliver_acc', kit_id: kit.id, status: H.jobs.OPEN })) {
        H.jobs.cancelFor({ id: j.id }, actor, `Kit ${kit.code} đã rời BO`);
        H.jobs.settleSupport(j.request_id, actor, `kit ${kit.code} đã rời BO`);
      }
    }
    changed('kits', 'overview');
    return { ...kit, ...patch };
  }
  function accInput(v) {
    if (v === undefined) return undefined;
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail(400, 'bad_acc', 'Phụ kiện không hợp lệ.');
    const out = {};
    for (const [k, q] of Object.entries(v)) {
      const tp = store.dev_types.get(k);
      if (!tp || tp.kind !== 'acc') fail(400, 'bad_acc', `Phụ kiện "${k}" không có trong danh mục.`);
      const n = int(q, 0, 99);
      if (n === null) fail(400, 'bad_acc', `Số lượng ${tp.name} phải từ 0 đến 99.`);
      if (n) out[k] = n;
    }
    return out;
  }
  /**
   * Phụ kiện thêm vào kit lấy từ số rảnh trong kho. Không đủ thì chặn và chỉ cách xử lý (ghi nhập thêm nếu thực tế có),
   * để số tồn trên hệ thống luôn khớp với số thật. Bớt khỏi kit thì phụ kiện trở về rảnh.
   */
  function checkAccStock(oldAcc, newAcc, exceptJobId) {
    const types = typeMap();
    for (const [t, q] of Object.entries(newAcc || {})) {
      const more = q - ((oldAcc || {})[t] || 0);
      if (more <= 0) continue;
      const free = accFree(t, exceptJobId);
      if (more > free) fail(409, 'acc_short', `Kho chỉ còn ${Math.max(0, free)} ${(types.get(t) || {}).name || t} rảnh, không đủ để thêm ${more}. Nếu thực tế có thêm, ghi "Nhập thêm" ở mục Phụ kiện trước.`);
    }
  }
  /** Phụ kiện của các việc "Giao bổ sung phụ kiện" nằm trong chuyến FO: inProgress = chuyến đã chạy (FO đang mang, đã rời kệ), không thì chuyến chưa chạy. */
  function accTrips(inProgress, exceptJobId) {
    const out = {};
    for (const j of store.jobs.find({ type: 'deliver_acc', status: H.jobs.OPEN })) {
      if (!j.task_id || j.id === exceptJobId) continue;
      const tk = store.tasks.get(j.task_id);
      if (!tk || !['assigned', 'accepted', 'in_progress', 'unassigned'].includes(tk.status) || (tk.status === 'in_progress') !== inProgress) continue;
      const r = j.request_id ? store.requests.get(j.request_id) : null;
      for (const [t, q] of Object.entries((r && r.need && r.need.acc) || {})) out[t] = (out[t] || 0) + (int(q, 0, 1e6) || 0);
    }
    return out;
  }
  /** Phụ kiện FO đang mang đi giao (giữ chỗ từ lúc chuyến chạy tới khi điểm chốt, điểm không giao được hoặc chuyến huỷ). */
  const accCarried = (exceptJobId) => accTrips(true, exceptJobId);
  /** Phụ kiện các chuyến đã xếp nhưng chưa chạy sẽ mang đi (để không xếp quá số rảnh). */
  const accPlanned = () => accTrips(false);
  /** Số rảnh trên kệ: tổng − trong kit − FO đang mang đi giao. exceptJobId: bỏ qua phần của chính việc đang chốt. */
  function accFree(typeId, exceptJobId) {
    const t = store.dev_types.get(typeId);
    let used = 0;
    for (const k of store.kits.find({ status: { ne: 'retired' } })) used += (k.acc || {})[typeId] || 0;
    return ((t && t.total) || 0) - used - (accCarried(exceptJobId)[typeId] || 0);
  }
  /**
   * Ghi một biến động tổng số lượng phụ kiện vào sổ kho. delta > 0: tăng, < 0: giảm.
   * Giảm thì số rảnh không được âm (phụ kiện đang nằm trong kit phải gỡ khỏi kit trước), trừ khi giảm vì mất khi thu hồi
   * (lúc đó phụ kiện đã được trừ khỏi kit ngay trong cùng giao dịch).
   */
  function accMove(typeId, delta, kind, reason, actor, ctx = {}) {
    const t = store.dev_types.get(typeId);
    if (!t || t.kind !== 'acc') fail(404, 'not_found', 'Không tìm thấy loại phụ kiện.');
    if (!ACC_MOVE[kind]) fail(400, 'bad_kind', 'Loại biến động không hợp lệ.');
    if (!delta) return null;
    const total = (t.total || 0) + delta;
    if (total < 0) fail(409, 'acc_negative', `Tổng ${t.name} không thể âm (hiện có ${t.total || 0}).`);
    if (delta < 0 && kind !== 'lost' && accFree(typeId) + delta < 0) fail(409, 'acc_in_kits', `Chỉ còn ${Math.max(0, accFree(typeId))} ${t.name} rảnh trong kho; phần còn lại đang nằm trong kit. Gỡ khỏi kit trước rồi ghi giảm.`);
    store.dev_types.update(t.id, { total });
    const id = store.acc_moves.insert({ type_id: t.id, delta, kind, reason: cleanStr(reason, 300), kit_id: ctx.kit_id ?? null, site_id: ctx.site_id ?? null, job_id: ctx.job_id ?? null, by_id: actor ? actor.id : null, at: now(), total_after: total });
    log('acc', null, kind, `${actor ? actor.name : 'Hệ thống'}: ${ACC_MOVE[kind]} ${delta > 0 ? '+' : ''}${delta} ${t.name} (còn tổng ${total})${reason ? ` — ${cleanStr(reason, 200)}` : ''}.`, actor, { type_id: t.id, delta, move_id: id, ...(ctx.req_key ? { req_key: ctx.req_key } : {}) });
    changed('acc', 'types');
    return id;
  }
  /**
   * Đối chiếu phụ kiện thực nhận khi kit thu hồi về kho với số trên kit. Thiếu thì ghi mất (tổng giảm) và đưa vào Đối chiếu
   * để Logistic Lead làm việc với BO; dư thì ghi tìm lại (tổng tăng) và cũng đưa vào Đối chiếu để đếm lại xác nhận.
   * Số trên kit được cập nhật đúng thực tế.
   */
  function reconcileAcc(kit, actual, actor, ctx = {}) {
    if (actual === undefined || actual === null) return null;
    const got = accInput(actual) || {};
    const exp = kit.acc || {};
    const types = typeMap();
    const short = [], extra = [];
    for (const t of new Set([...Object.keys(exp), ...Object.keys(got)])) {
      const diff = (got[t] || 0) - (exp[t] || 0);
      if (!diff) continue;
      const name = (types.get(t) || {}).name || t;
      if (diff < 0) { short.push(`${-diff} ${name}`); accMove(t, diff, 'lost', `Thu hồi kit ${kit.code}${ctx.site_name ? ` từ ${ctx.site_name}` : ''} thiếu ${-diff}`, actor, { kit_id: kit.id, site_id: ctx.site_id, job_id: ctx.job_id }); }
      else { extra.push(`${diff} ${name}`); accMove(t, diff, 'found', `Thu hồi kit ${kit.code} dư ${diff} so với sổ`, actor, { kit_id: kit.id, site_id: ctx.site_id, job_id: ctx.job_id }); }
    }
    if (!short.length && !extra.length) return null;
    store.kits.update(kit.id, { acc: got, updated_at: now() });
    log('kit', kit.id, 'acc_recon', `Phụ kiện thực nhận của kit ${kit.code} khác sổ: ${[short.length ? `thiếu ${short.join(', ')}` : '', extra.length ? `dư ${extra.join(', ')}` : ''].filter(Boolean).join('; ')}. Kit và tổng kho đã cập nhật theo thực tế.`, actor);
    if (short.length) H.recon('acc_recover', 'logistics', 'high', 'kit', `accshort:${kit.id}:${ctx.job_id || now()}`, `Kit ${kit.code}${ctx.site_name ? ` thu hồi từ ${ctx.site_name}` : ''} thiếu ${short.join(', ')}. Đã trừ khỏi tổng kho; cần xác minh với BO.`, { kit_id: kit.id, site_id: ctx.site_id ?? null, short, job_id: ctx.job_id ?? null });
    if (extra.length) H.recon('acc_recover', 'logistics', 'high', 'kit', `accextra:${kit.id}:${ctx.job_id || now()}`, `Kit ${kit.code}${ctx.site_name ? ` thu hồi từ ${ctx.site_name}` : ''} dư ${extra.join(', ')} so với sổ. Đã cộng vào tổng kho; cần đếm lại để xác nhận.`, { kit_id: kit.id, site_id: ctx.site_id ?? null, extra, job_id: ctx.job_id ?? null });
    return { short, extra };
  }
  /** Gắn thiết bị (theo mã) vào kit. Thiết bị phải tốt và chưa thuộc kit nào. */
  function attach(kit, codes, actor) {
    const added = [];
    for (const code of codes) {
      const d = store.devices.find({ code }, { limit: 1 })[0];
      if (!d) fail(404, 'no_device', `Không có thiết bị mã ${code}. Thêm vào kho trước.`);
      if (d.kit_id === kit.id) continue;
      if (d.kit_id) { const other = store.kits.get(d.kit_id); fail(409, 'in_other_kit', `${code} đang nằm trong kit ${other ? other.code : '#' + d.kit_id}. Gỡ khỏi kit đó trước.`); }
      if (d.cond !== 'ok') fail(409, 'device_not_ok', `${code} đang ở tình trạng "${DEV_COND[d.cond]}", không gắn vào kit được.`);
      store.devices.update(d.id, { kit_id: kit.id, updated_at: now() });
      added.push(code);
    }
    if (added.length) log('kit', kit.id, 'device_in', `${actor ? actor.name : 'Hệ thống'} gắn ${added.join(', ')} vào kit ${kit.code}.`, actor);
    return added;
  }
  function detach(kit, ids, actor, reason) {
    const out = [];
    for (const id of ids) {
      const d = store.devices.get(id);
      if (!d || d.kit_id !== kit.id) fail(404, 'not_in_kit', 'Thiết bị không thuộc kit này.');
      store.devices.update(d.id, { kit_id: null, updated_at: now() });
      out.push(d.code);
    }
    if (out.length) log('kit', kit.id, 'device_out', `${actor ? actor.name : 'Hệ thống'} gỡ ${out.join(', ')} khỏi kit ${kit.code}${reason ? ` (lý do: ${reason})` : ''}.`, actor);
    return out;
  }

  R('GET', '/api/hub/kits', G.STOCK_VIEW, ({ q }) => {
    const where = {};
    if (q.status) where.status = String(q.status).split(',');
    if (q.kind) where.kind = String(q.kind);
    if (q.site) where.site_id = K.idOf(q.site);
    let kits = store.kits.find(where, { order: 'code' });
    if (q.q) { const s = String(q.q).toUpperCase(); const devKit = new Set(store.devices.find({}).filter((d) => d.code.includes(s)).map((d) => d.kit_id)); kits = kits.filter((k) => k.code.includes(s) || devKit.has(k.id)); }
    const devs = new Map();
    for (const d of store.devices.find({ kit_id: { ne: null } })) { if (!devs.has(d.kit_id)) devs.set(d.kit_id, []); devs.get(d.kit_id).push(d); }
    const types = typeMap();
    const counts = {};
    for (const k of store.kits.find({}, { cols: ['status'] })) counts[k.status] = (counts[k.status] || 0) + 1;
    return { kits: kits.map((k) => kitView(k, devs.get(k.id) || [], { types })), counts };
  });
  R('GET', '/api/hub/kits/:id', G.STOCK_VIEW, ({ user, p }) => ({ kit: kitView(kitOrFail(p.id), null, { full: true, user }) }));
  R('POST', '/api/hub/kits', ['admin', 'lead', 'logistic'], ({ user, b }) => {
    const code = codeOf(b.code, 'Mã kit');
    if (store.kits.count({ code })) fail(409, 'exists', `Đã có kit mã ${code}.`);
    const kind = KIT_KINDS[b.kind] ? b.kind : fail(400, 'bad_kind', 'Chọn loại kit.');
    const t = now();
    const kit = { code, kind, status: 'preparing', site_id: null, request_id: null, acc: accInput(b.acc) || {}, note: cleanText(b.note, 300), checked_at: null, checked_by: null, created_at: t, updated_at: t };
    checkAccStock({}, kit.acc);
    store.tx(() => {
      kit.id = store.kits.insert(kit);
      log('kit', kit.id, 'create', `${user.name} tạo kit ${code} (${KIT_KINDS[kind]}).`, user);
      if (b.devices) attach(kit, codesOf(b.devices, 30), user);
    });
    changed('kits', 'devices', 'overview');
    return { kit: kitView(store.kits.get(kit.id), null, { full: true, user }) };
  });
  R('PATCH', '/api/hub/kits/:id', ['admin', 'lead', 'logistic', 'tech_lead', 'tech'], ({ user, p, b }) => {
    const kit = kitOrFail(p.id);
    const isTech = G.TECH.includes(user.role) && user.role !== 'admin';
    const touchesParts = b.add !== undefined || b.remove !== undefined || b.acc !== undefined;
    let override = '';
    if (touchesParts && !KIT_EDITABLE.includes(kit.status)) {
      // Lead điều chỉnh cho khớp thực tế khi kit ở ngoài: bắt buộc lý do, có nhật ký.
      if (!(user.role === 'lead' || user.role === 'admin') || !KIT_OUTSIDE.includes(kit.status)) fail(409, 'kit_locked', lockReason(kit.status));
      override = reasonOf(b.reason, 'lý do điều chỉnh kit đang ở ngoài');
    }
    if (touchesParts && isTech && kit.status !== 'at_tech') fail(403, 'forbidden', 'Tech chỉ thay thiết bị khi kit đang ở Tech.');
    if (touchesParts && !KIT_OUTSIDE.includes(kit.status)) H.jobs.failIfKitInTrip(kit);
    const patch = { updated_at: now() };
    if (b.code !== undefined) {
      const code = codeOf(b.code, 'Mã kit');
      if (code !== kit.code) {
        // Kit đang ở ngoài (đang giao, ở BO, đang thu hồi): mã kit gắn với phiếu, thẻ, việc đang chạy; chỉ đổi mã khi kit đã về.
        if (KIT_OUTSIDE.includes(kit.status)) fail(409, 'kit_outside', `Kit ${kit.code} đang "${KIT_ST[kit.status]}". Chỉ đổi mã khi kit đã về văn phòng.`);
        if (store.kits.count({ code })) fail(409, 'exists', `Đã có kit mã ${code}.`); patch.code = code;
      }
    }
    if (b.note !== undefined) patch.note = cleanText(b.note, 300);
    if (b.watch !== undefined) patch.watch = cleanStr(b.watch, 120) || null; // cờ "Theo dõi": ví dụ máy đang chạy tạm dây USB-C
    const acc = accInput(b.acc);
    if (acc !== undefined) { checkAccStock(kit.acc, acc); patch.acc = acc; }
    const remove = b.remove ? idList(b.remove, 30) : [];
    // Kit đang trên đường giao: thiết bị đi theo chuyến của FO; đợi FO giao xong hoặc huỷ chuyến rồi điều chỉnh.
    if (override && remove.length && kit.status === 'delivering') fail(409, 'in_trip', `Kit ${kit.code} đang trên đường giao. Đợi FO giao xong hoặc huỷ chuyến rồi điều chỉnh thiết bị.`);
    // Kit ở ngoài: thiết bị gỡ ra chưa về kho nên không thành thiết bị rảnh. Ghi ngừng dùng (có lý do) hoặc ghi thất lạc và đưa vào Đối chiếu.
    const devWo = override && remove.length && b.dev_writeoff ? reasonOf(b.dev_reason || b.reason, 'lý do ghi ngừng dùng thiết bị') : '';
    const where = kit.site_id ? ` tại ${boLabel(H.siteName(kit.site_id))}` : ' đang ở ngoài';
    store.tx(() => {
      if (remove.length) {
        const out = detach(kit, remove, user, override);
        if (override) {
          for (const id of remove) { const d = store.devices.get(id); store.devices.update(id, { cond: devWo ? 'retired' : 'lost', updated_at: now() }); log('device', id, 'update', `${user.name} gỡ ${d.code} khỏi kit ${kit.code}${where}: ${devWo ? `ghi ngừng dùng (${devWo})` : 'ghi thất lạc, chờ nhận lại về kho'}.`, user, { cond: devWo ? 'retired' : 'lost' }); }
          if (!devWo) H.recon('kit_adjust', 'logistics', 'high', 'kit', `kitadj:dev:${kit.id}:${H.uniq()}`, `Kit ${kit.code}${where}: ${user.name} gỡ ${out.join(', ')} khỏi kit (${override}). Thiết bị ghi thất lạc vì chưa về kho; nhận lại thì đổi tình trạng về Tốt, không tìm thấy thì ghi ngừng dùng.`, { kit_id: kit.id, site_id: kit.site_id ?? null, codes: out });
        }
      }
      if (b.add) attach(kit, codesOf(b.add, 30), user);
      store.kits.update(kit.id, patch);
      if (patch.code) log('kit', kit.id, 'rename', `${user.name} đổi mã kit ${kit.code} → ${patch.code}.`, user);
      if (patch.watch !== undefined && patch.watch !== (kit.watch || null)) log('kit', kit.id, 'watch', patch.watch ? `${user.name} đưa kit ${kit.code} vào danh sách theo dõi: ${patch.watch}.` : `${user.name} bỏ kit ${kit.code} khỏi danh sách theo dõi.`, user);
      if (acc !== undefined) log('kit', kit.id, 'acc', `${user.name} cập nhật phụ kiện của kit ${patch.code || kit.code}${override ? ` (điều chỉnh khi kit ở ngoài: ${override})` : ''}.`, user, acc);
      // Bớt phụ kiện vì hỏng / mất: phần bớt ra không trở về kho rảnh mà ghi giảm tổng (sổ kho), bắt buộc lý do.
      if (acc !== undefined && b.acc_writeoff) {
        const why = reasonOf(b.acc_reason || b.reason, 'lý do ghi giảm phụ kiện');
        for (const [t, q] of Object.entries(kit.acc || {})) { const dec = q - (acc[t] || 0); if (dec > 0) accMove(t, -dec, KIT_OUTSIDE.includes(kit.status) ? 'lost' : 'out', `Kit ${kit.code}: ${why}`, user, { kit_id: kit.id, site_id: kit.site_id }); }
      } else if (acc !== undefined && override) {
        // Kit ở ngoài, bớt phụ kiện mà không ghi giảm: phần bớt ra chưa về kho, không tính là rảnh. Ghi thiếu (tổng giảm) và đưa vào Đối chiếu;
        // về tới kho thì Logistics ghi "Tìm lại" ở mục Phụ kiện.
        const types = typeMap(), short = [];
        for (const [t, q] of Object.entries(kit.acc || {})) { const dec = q - (acc[t] || 0); if (dec > 0) { short.push(`${dec} ${(types.get(t) || {}).name || t}`); accMove(t, -dec, 'lost', `Kit ${kit.code} điều chỉnh khi ở ngoài, chưa về kho: ${override}`, user, { kit_id: kit.id, site_id: kit.site_id }); } }
        if (short.length) H.recon('kit_adjust', 'logistics', 'high', 'kit', `kitadj:acc:${kit.id}:${H.uniq()}`, `Kit ${kit.code}${where}: ${user.name} bớt ${short.join(', ')} (${override}). Đã ghi thiếu khỏi tổng kho vì chưa về kho; về tới kho thì ghi "Tìm lại" ở mục Phụ kiện.`, { kit_id: kit.id, site_id: kit.site_id ?? null, short });
      }
      // Kit ở BO thiếu thiết bị chính sau khi gỡ: như thiết bị mất tại BO, sinh việc đổi kit cho Logistics.
      if (override && remove.length && kit.status === 'at_bo') {
        const c = completeness(kit, kitDevices(kit.id));
        if (c.missing.length) { const types = typeMap(); reportFaulty(store.kits.get(kit.id), null, `Thiếu ${c.missing.map((t) => (types.get(t) || {}).name || t).join(', ')} sau khi điều chỉnh: ${override}`, user); }
      }
      if (override) H.notify({ roles: ['lead'] }, 'warn', 'kit_override', `${user.name} điều chỉnh thành phần kit ${kit.code} khi kit đang ở ngoài: ${override}`, `kit:${kit.id}`);
    });
    changed('kits', 'devices', 'overview');
    return { kit: kitView(store.kits.get(kit.id), null, { full: true, user }) };
  });

  /** Logistics chuẩn bị xong: gửi Tech kiểm (hoặc sẵn sàng ngay nếu tắt bước kiểm). */
  function submitKit(kit, actor) {
    if (!['preparing', 'returned'].includes(kit.status)) fail(409, 'bad_state', `Kit đang "${KIT_ST[kit.status]}", không gửi kiểm được.`);
    const c = completeness(kit, kitDevices(kit.id));
    if (!c.complete) fail(409, 'incomplete', c.faulty ? 'Kit còn thiết bị hỏng. Thay thiết bị rồi gửi lại.' : `Kit còn thiếu: ${c.missing.join(', ') || 'thiết bị'}.`);
    if (H.cfg().checkBeforeShip) {
      const k = setKit(kit, 'wait_check', actor, `${actor ? actor.name : 'Hệ thống'} chuẩn bị xong kit ${kit.code}, gửi Tech kiểm.`);
      // Kit thu hồi chưa check-in mà Logistics gửi kiểm luôn: Tech kiểm một lần, việc check-in không còn cần.
      H.jobs.cancelFor({ type: 'checkin', kit_id: kit.id }, actor, 'Kit đã gửi Tech kiểm trước khi xuất (gộp với check-in)');
      H.jobs.ensure({ type: 'check_kit', kit_id: kit.id, request_id: kit.request_id, site_id: null, title: `Kiểm kit ${kit.code}`, dedupe: `check:${kit.id}:${H.uniq()}` }, actor);
      return k;
    }
    const k = setKit(kit, kit.request_id ? 'reserved' : 'ready', actor, `${actor ? actor.name : 'Hệ thống'} chuẩn bị xong kit ${kit.code} (không cần Tech kiểm theo cấu hình).`, { checked_at: now(), checked_by: actor ? actor.id : null });
    // Kit thu hồi chưa check-in mà xuất luôn (đã tắt bước Tech kiểm): việc check-in không còn cần, đóng lại để không treo ở Tech.
    H.jobs.cancelFor({ type: 'checkin', kit_id: kit.id }, actor, 'Kit xuất không cần Tech kiểm theo cấu hình');
    return k;
  }
  R('POST', '/api/hub/kits/:id/submit', ['admin', 'lead', 'logistic'], ({ user, p }) => {
    const kit = kitOrFail(p.id);
    let out;
    // Người gửi kit đi kiểm nhận luôn việc chuẩn bị của yêu cầu (nếu chưa ai nhận) để được tính điểm khi yêu cầu sẵn sàng.
    store.tx(() => { out = submitKit(kit, user); if (kit.request_id) H.jobs.claimFor({ type: 'prep_kit', request_id: kit.request_id }, user); });
    if (kit.request_id) H.outlets.refreshRequest(kit.request_id, user);
    return { kit: kitView(store.kits.get(out.id), null, { full: true, user }) };
  });
  /** Mở lại kit đã kiểm để chỉnh: kit về "Đang chuẩn bị" và phải kiểm lại. */
  R('POST', '/api/hub/kits/:id/reopen', ['admin', 'lead', 'logistic'], ({ user, p, b }) => {
    const kit = kitOrFail(p.id);
    if (!['ready', 'reserved', 'wait_check', 'tech_done'].includes(kit.status)) fail(409, 'bad_state', `Kit đang "${KIT_ST[kit.status]}", không mở lại được.`);
    H.jobs.failIfKitInTrip(kit);
    const reason = reasonOf(b.reason, 'lý do mở lại kit');
    store.tx(() => {
      setKit(kit, 'preparing', user, `${user.name} mở lại kit ${kit.code} để chỉnh (${reason}). Kit cần kiểm lại trước khi xuất.`, { checked_at: null, checked_by: null });
      H.jobs.cancelFor({ type: ['check_kit', 'receive_back'], kit_id: kit.id }, user, 'Kit được mở lại để chỉnh');
    });
    if (kit.request_id) H.outlets.refreshRequest(kit.request_id, user);
    return { kit: kitView(store.kits.get(kit.id), null, { full: true, user }) };
  });

  /**
   * Báo hỏng: thiết bị không tách lẻ, cả kit đi Tech.
   *  - Kit ở văn phòng → sang Tech ngay, sinh việc Sửa kit.
   *  - Kit đang ở BO → sinh việc Đổi kit hỏng cho Logistics (đi cùng chuyến đổi thẻ); về văn phòng thì tự sang Tech.
   */
  function reportFaulty(kit, deviceId, reason, actor, src = {}) {
    const devs = kitDevices(kit.id);
    const dev = deviceId ? devs.find((d) => d.id === deviceId) : null;
    if (deviceId && !dev) fail(404, 'not_in_kit', 'Thiết bị không thuộc kit này.');
    if (dev && dev.cond === 'ok') { store.devices.update(dev.id, { cond: 'faulty', updated_at: now(), note: reason }); log('device', dev.id, 'faulty', `${actor ? actor.name : 'Hệ thống'} báo hỏng ${dev.code}: ${reason}.`, actor); }
    const who = actor ? actor.name : 'Hệ thống';
    if (['preparing', 'wait_check', 'ready', 'reserved', 'returned', 'tech_done'].includes(kit.status)) {
      const reqId = kit.request_id;
      setKit(kit, 'at_tech', actor, `${who} báo hỏng kit ${kit.code}${dev ? ` (${dev.code})` : ''}: ${reason}. Cả kit chuyển sang Tech.`, { request_id: null, checked_at: null, fault: reason });
      // Việc gắn với trạng thái cũ của kit (kiểm, check-in, nhận lại từ Tech) không còn đúng: kit quay về Tech sửa.
      H.jobs.cancelFor({ type: ['check_kit', 'checkin', 'receive_back'], kit_id: kit.id }, actor, 'Kit bị báo hỏng, chuyển Tech sửa');
      H.jobs.ensure({ type: 'repair', kit_id: kit.id, title: `Sửa kit ${kit.code}${dev ? ` (${dev.code})` : ''}`, note: reason, dedupe: `repair:${kit.id}:open`, incident_id: src.incident_id || null, request_id: src.request_id || null }, actor);
      if (reqId) {
        log('request', reqId, 'kit_removed', `Kit ${kit.code} bị báo hỏng nên được gỡ khỏi yêu cầu. Cần gán kit khác.`, actor);
        H.notify({ roles: ['lead', 'logistic'] }, 'warn', 'kit_faulty', `Kit ${kit.code} đã gán cho yêu cầu bị báo hỏng và đã được gỡ ra. Cần gán kit khác.`, `request:${reqId}`);
        H.outlets.refreshRequest(reqId, actor);
      }
      return 'to_tech';
    }
    if (kit.status === 'at_bo') {
      store.kits.update(kit.id, { fault: reason, updated_at: now() });
      const site = store.sites.get(kit.site_id);
      if (site && site.ops_status === 'ending') {
        // BO đang thu hồi: không đổi kit nữa; kit mang cờ lỗi về kho sẽ tự chuyển Tech sửa.
        log('kit', kit.id, 'faulty', `${who} báo hỏng kit ${kit.code} tại BO${dev ? ` (${dev.code})` : ''}: ${reason}. BO đang thu hồi nên không đổi kit; kit về kho sẽ chuyển Tech sửa.`, actor);
        changed('kits');
        return 'noted';
      }
      H.jobs.ensure({ type: 'swap_faulty', kit_id: kit.id, site_id: kit.site_id, title: `Đổi kit hỏng ${kit.code} tại ${H.siteName(kit.site_id)}`, note: reason, dedupe: `swapf:${kit.id}:open`, incident_id: src.incident_id || null, request_id: src.request_id || null }, actor);
      log('kit', kit.id, 'faulty', `${who} báo hỏng kit ${kit.code} tại BO${dev ? ` (${dev.code})` : ''}: ${reason}. Đã tạo việc đổi kit cho Logistics.`, actor);
      changed('kits');
      return 'swap_job';
    }
    if (kit.status === 'at_tech') { store.kits.update(kit.id, { fault: kit.fault || reason, updated_at: now() }); log('kit', kit.id, 'faulty', `${who} ghi nhận thêm lỗi ${dev ? dev.code : ''}: ${reason}.`, actor); return 'noted'; }
    fail(409, 'bad_state', `Kit đang "${KIT_ST[kit.status]}". Đợi kit về văn phòng hoặc tới BO rồi báo hỏng.`);
  }
  R('POST', '/api/hub/kits/:id/faulty', [...G.LOGI, 'tech_lead', 'tech'], ({ user, p, b }) => {
    const kit = kitOrFail(p.id);
    if (!KIT_OUTSIDE.includes(kit.status)) H.jobs.failIfKitInTrip(kit);
    const reason = reasonOf(b.reason, 'mô tả lỗi');
    let r;
    store.tx(() => { r = reportFaulty(kit, b.device_id ? K.idOf(b.device_id) : null, reason, user); });
    return { result: r, kit: kitView(store.kits.get(kit.id), null, { full: true, user }) };
  });
  R('POST', '/api/hub/kits/:id/retire', ['admin', 'lead', 'tech_lead'], ({ user, p, b }) => {
    const kit = kitOrFail(p.id);
    if (KIT_OUTSIDE.includes(kit.status) || kit.status === 'reserved') fail(409, 'bad_state', 'Kit đang được dùng hoặc đã gán BO, không ngừng dùng được.');
    H.jobs.failIfKitInTrip(kit);
    const reason = reasonOf(b.reason);
    store.tx(() => {
      for (const d of kitDevices(kit.id)) store.devices.update(d.id, { kit_id: null, updated_at: now() });
      setKit(kit, 'retired', user, `${user.name} cho kit ${kit.code} ngừng dùng (${reason}). Thiết bị và phụ kiện trả về kho lẻ.`, { request_id: null });
      H.jobs.cancelFor({ kit_id: kit.id, type: { ne: 'incident' } }, user, 'Kit ngừng dùng'); // sự cố vẫn để Tech đóng (ghi nhận lỗi cho thống kê)
      if (kit.request_id) { // kit đang chuẩn bị cho một yêu cầu: gỡ ra, yêu cầu tính lại và báo Logistics gán kit khác
        log('request', kit.request_id, 'kit_removed', `Kit ${kit.code} ngừng dùng nên được gỡ khỏi yêu cầu. Cần gán kit khác.`, user);
        H.outlets.refreshRequest(kit.request_id, user);
      }
    });
    return { ok: true };
  });

  // ───────────────────────── Phụ kiện theo số lượng ─────────────────────────
  /** Tồn phụ kiện: tổng (theo sổ kho), trong kit ở văn phòng, trong kit ở ngoài (BO, đang giao, đang thu hồi), rảnh. */
  function accSummary() {
    const types = store.dev_types.find({ kind: 'acc' }, { order: 'sort' });
    const use = {}, out = {}, fo = accCarried();
    for (const k of store.kits.find({ status: { ne: 'retired' } })) for (const [t, q] of Object.entries(k.acc || {})) { use[t] = (use[t] || 0) + q; if (KIT_OUTSIDE.includes(k.status)) out[t] = (out[t] || 0) + q; }
    return types.map((t) => ({ id: t.id, name: t.name, active: !!t.active, total: t.total || 0, in_kits: use[t.id] || 0, outside: out[t.id] || 0, in_office_kits: (use[t.id] || 0) - (out[t.id] || 0), with_fo: fo[t.id] || 0, free: (t.total || 0) - (use[t.id] || 0) - (fo[t.id] || 0) }));
  }
  /** Phụ kiện mà các việc "Giao bổ sung phụ kiện" đang mở cần (theo yêu cầu đi kèm), để Logistics thấy trước chỗ kho không đủ. */
  function accNeed() {
    const need = {};
    for (const j of store.jobs.find({ type: 'deliver_acc', status: H.jobs.OPEN })) {
      const tk = j.task_id ? store.tasks.get(j.task_id) : null;
      if (tk && tk.status === 'in_progress') continue; // FO đang mang: đã trừ khỏi số rảnh
      const r = j.request_id ? store.requests.get(j.request_id) : null;
      for (const [t, q] of Object.entries((r && r.need && r.need.acc) || {})) need[t] = (need[t] || 0) + (int(q, 0, 1e6) || 0);
    }
    return need;
  }
  R('GET', '/api/hub/acc', G.STOCK_VIEW, () => ({ acc: accSummary(), kinds: ACC_MOVE, need: accNeed() }));
  /** Logistics thêm / bớt phụ kiện khi số tài sản thay đổi (mua thêm, hỏng, thanh lý, kiểm kê). Bắt buộc lý do, có sổ kho. */
  R('POST', '/api/hub/acc/:id/move', ['admin', 'lead', 'logistic'], ({ user, p, b }) => {
    const t = store.dev_types.get(p.id);
    if (!t || t.kind !== 'acc') fail(404, 'not_found', 'Không tìm thấy loại phụ kiện.');
    const kind = ['in', 'out', 'found', 'count'].includes(b.kind) ? b.kind : fail(400, 'bad_kind', 'Chọn: nhập thêm, ghi giảm, tìm lại hoặc kiểm kê.');
    const reason = reasonOf(b.reason, 'lý do');
    // Cùng hộp thoại gửi lại (mất phản hồi rồi bấm lại): trả kết quả lần trước, không ghi sổ lần hai.
    const key = H.reqKeyOf(b);
    const again = H.replayOf('acc', ['in', 'out', 'found', 'count'], user, key);
    if (again && again.data.type_id === t.id) return { move_id: again.data.move_id, delta: again.data.delta, acc: accSummary().find((x) => x.id === t.id), replay: true };
    let delta;
    if (kind === 'count') {
      // Kiểm kê: đếm số rảnh thực tế trong kho; tổng mới = số trong kit + số đếm được.
      const counted = int(b.free_counted, 0, 1e6) ?? fail(400, 'bad_number', 'Nhập số rảnh đếm được (số nguyên từ 0).');
      delta = counted - accFree(t.id);
    } else {
      const qty = int(b.qty, 1, 1e5) ?? fail(400, 'bad_number', 'Số lượng là số nguyên từ 1.');
      delta = kind === 'out' ? -qty : qty;
    }
    let id = null;
    store.tx(() => { id = accMove(t.id, delta, kind, reason, user, { req_key: key }); });
    return { move_id: id, delta, acc: accSummary().find((x) => x.id === t.id) };
  });
  R('GET', '/api/hub/acc/:id/moves', G.STOCK_VIEW, ({ p, q }) => {
    const t = store.dev_types.get(p.id);
    if (!t || t.kind !== 'acc') fail(404, 'not_found', 'Không tìm thấy loại phụ kiện.');
    const rows = store.acc_moves.find({ type_id: t.id }, { order: 'at', desc: true, limit: int(q.limit, 1, 1000) || 200 });
    return { type: { id: t.id, name: t.name, total: t.total || 0 }, moves: rows.map((m) => ({ ...m, kind_label: ACC_MOVE[m.kind] || m.kind, by: m.by_id ? H.userName(m.by_id) : 'Hệ thống', kit: m.kit_id ? (store.kits.get(m.kit_id) || {}).code || '' : '', site: m.site_id ? H.siteName(m.site_id) : '' })) };
  });

  /**
   * Tồn kho tổng hợp (tự tính từ trạng thái kit, thiết bị, thẻ nên luôn khớp với việc đã làm, không có số nhập tay):
   * thiết bị theo loại và vị trí, kit theo loại và trạng thái, thẻ theo trạng thái, phụ kiện.
   */
  function stockSummary() {
    const kits = store.kits.find({});
    const kitById = new Map(kits.map((k) => [k.id, k]));
    const types = store.dev_types.find({}, { order: 'sort' });
    const dev = {};
    for (const t of types) if (t.kind === 'device') dev[t.id] = { id: t.id, name: t.name, core: !!t.core, total: 0, free: 0, in_office_kits: 0, outside: 0, faulty: 0, repairing: 0, retired: 0, lost: 0 };
    for (const d of store.devices.find({})) {
      const x = dev[d.type] || (dev[d.type] = { id: d.type, name: d.type, core: false, total: 0, free: 0, in_office_kits: 0, outside: 0, faulty: 0, repairing: 0, retired: 0, lost: 0 });
      if (d.cond === 'retired' || d.cond === 'lost') { x[d.cond]++; continue; }
      x.total++;
      if (d.cond === 'faulty' || d.cond === 'repairing') x[d.cond]++;
      const k = d.kit_id ? kitById.get(d.kit_id) : null;
      if (!k || k.status === 'retired') { if (d.cond === 'ok') x.free++; } else if (KIT_OUTSIDE.includes(k.status)) x.outside++; else x.in_office_kits++;
    }
    const kitKinds = {};
    for (const k of kits) {
      const x = kitKinds[k.kind] || (kitKinds[k.kind] = { kind: k.kind, label: KIT_KINDS[k.kind] || k.kind, total: 0, by_status: {} });
      if (k.status !== 'retired') x.total++;
      x.by_status[k.status] = (x.by_status[k.status] || 0) + 1;
    }
    const cards = {};
    for (const c of store.cards.find({})) cards[c.status] = (cards[c.status] || 0) + 1;
    return { devices: Object.values(dev), kits: Object.values(kitKinds), kit_status: KIT_ST, cards, card_status: CARD_ST, acc: accSummary() };
  }
  R('GET', '/api/hub/stock/summary', G.STOCK_VIEW, () => stockSummary());

  return { kitView, kitOrFail, kitDevices, completeness, setKit, submitKit, reportFaulty, attach, detach, addDevices, accSummary, accFree, accPlanned, accMove, reconcileAcc, checkAccStock, accInput, typeMap, devView, stockSummary };
}
