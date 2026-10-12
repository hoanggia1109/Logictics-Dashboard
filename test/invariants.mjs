// invariants.mjs — các điều luôn phải đúng giữa kit, thiết bị, thẻ, việc, yêu cầu, BO, chuyến FO và sổ phụ kiện.
// Chạy sau mỗi bước trong kiểm thử luồng 3 team: một thao tác làm lệch bất kỳ bảng nào sẽ bị bắt ngay tại bước đó.
// Trả về danh sách vi phạm (rỗng = ổn). Chỗ lệch đã được đưa vào Đối chiếu (dòng recon đang mở) thì không tính là vi phạm.

const OPEN = ['open', 'doing'];
const TASK_OPEN = ['assigned', 'accepted', 'in_progress', 'unassigned'];
const OFFICE = ['preparing', 'wait_check', 'ready', 'reserved', 'returned', 'at_tech', 'tech_done', 'retired'];
/** Trạng thái kit → loại việc phải đang mở đúng một việc cho kit đó. */
const KIT_JOB = { wait_check: 'check_kit', at_tech: 'repair', returned: 'checkin', tech_done: 'receive_back', recovering: 'receive_field' };
const JOB_KIT = { check_kit: ['wait_check'], repair: ['at_tech'], checkin: ['returned'], receive_back: ['tech_done'], receive_field: ['recovering'], swap_faulty: ['at_bo'], deliver_acc: ['at_bo'] };

export function checkInvariants(store, opt = {}) {
  const v = [];
  const bad = (msg) => v.push(msg);
  const reconOpen = new Set(store.recon.find({ status: 'open' }).map((r) => r.ref));
  const flagged = (ref) => reconOpen.has(ref);
  // Việc bị giữ sau chuyến (số FO / BO lệch kế hoạch, dòng Đối chiếu "count:" đang mở): Logistic Lead làm tay theo thực tế, không tính là lệch.
  const heldJobs = new Set(store.recon.find({ status: 'open' }).filter((r) => typeof r.ref === 'string' && r.ref.startsWith('count:') && r.data && Array.isArray(r.data.jobs)).flatMap((r) => r.data.jobs));

  const kits = store.kits.find({});
  const kitById = new Map(kits.map((k) => [k.id, k]));
  const sites = new Map(store.sites.find({}).map((s) => [s.id, s]));
  const jobs = store.jobs.find({});
  const openJobs = jobs.filter((j) => OPEN.includes(j.status));
  const tasks = new Map(store.tasks.find({}).map((t) => [t.id, t]));
  const requests = store.requests.find({});
  const devices = store.devices.find({});
  const cards = store.cards.find({});
  const openBy = (type, kitId) => openJobs.filter((j) => j.type === type && j.kit_id === kitId);

  // ───────── Kit ─────────
  for (const k of kits) {
    const tag = `kit ${k.code} (${k.status})`;
    if (OFFICE.includes(k.status) && k.site_id) bad(`${tag}: ở văn phòng nhưng còn gắn BO #${k.site_id}`);
    if (k.status === 'at_bo') {
      const s = sites.get(k.site_id);
      if (!s) bad(`${tag}: ở BO nhưng không có BO`);
      else if (!['live', 'paused', 'ending'].includes(s.ops_status) && !flagged(`imp:kit:${k.id}:planned`)) bad(`${tag}: BO ${s.name} đang "${s.ops_status}"`);
    }
    if (k.status === 'recovering' && !k.site_id) bad(`${tag}: đang thu hồi nhưng không rõ từ BO nào`);
    if (k.status === 'reserved') {
      const r = requests.find((x) => x.id === k.request_id);
      if (!r) bad(`${tag}: đã gán BO nhưng không có yêu cầu`);
      else if (!['preparing', 'ready', 'delivering'].includes(r.status)) bad(`${tag}: yêu cầu ${r.code} đang "${r.status}"`);
    }
    if (['ready', 'retired'].includes(k.status) && k.request_id) bad(`${tag}: còn gắn yêu cầu #${k.request_id}`);
    const need = KIT_JOB[k.status];
    if (need && (k.status !== 'wait_check' || opt.checkBeforeShip !== false)) {
      const n = openBy(need, k.id).length;
      if (n !== 1 && !(n === 0 && opt.allowMissingJob && opt.allowMissingJob(k))) bad(`${tag}: cần đúng 1 việc ${need} đang mở, có ${n}`);
    }
    if (k.status === 'at_bo' && k.fault && openBy('swap_faulty', k.id).length !== (sites.get(k.site_id) && sites.get(k.site_id).ops_status === 'ending' && !openBy('swap_faulty', k.id).length ? 0 : 1)) bad(`${tag}: đang lỗi tại BO nhưng có ${openBy('swap_faulty', k.id).length} việc đổi kit`);
    // Giao phụ kiện: được có thêm một lượt mới khi lượt trước đã lên chuyến FO; chưa lên chuyến thì phải gộp.
    for (const type of Object.keys(JOB_KIT)) { const n = type === 'deliver_acc' ? openBy(type, k.id).filter((j) => !j.task_id).length : openBy(type, k.id).length; if (n > 1) bad(`${tag}: ${n} việc ${type} cùng mở`); }
    if (['ready', 'reserved'].includes(k.status)) {
      const devs = devices.filter((d) => d.kit_id === k.id);
      if (!devs.length || devs.some((d) => d.cond !== 'ok')) bad(`${tag}: đã kiểm đạt nhưng thiếu thiết bị hoặc có thiết bị hỏng`);
    }
  }
  // Việc theo kit phải khớp trạng thái kit (chiều ngược lại).
  for (const j of openJobs) {
    const want = JOB_KIT[j.type];
    if (!want) continue;
    const k = kitById.get(j.kit_id);
    if (!k) { bad(`việc ${j.code} (${j.type}): kit không tồn tại`); continue; }
    if (!want.includes(k.status) && !(j.status === 'doing' && j.task_id && ['delivering'].includes(k.status))) bad(`việc ${j.code} (${j.type}) đang mở nhưng kit ${k.code} ở "${k.status}"`);
    if (j.type === 'swap_faulty' && k.site_id !== j.site_id) bad(`việc ${j.code}: kit ${k.code} không còn ở BO của việc`);
  }

  // ───────── Thiết bị ─────────
  for (const d of devices) {
    if (d.kit_id) {
      const k = kitById.get(d.kit_id);
      if (!k) bad(`thiết bị ${d.code}: kit #${d.kit_id} không tồn tại`);
      else if (k.status === 'retired') bad(`thiết bị ${d.code}: còn nằm trong kit đã ngừng dùng ${k.code}`);
    }
    if (['retired', 'lost'].includes(d.cond) && d.kit_id) bad(`thiết bị ${d.code}: ${d.cond} nhưng còn trong kit`);
  }
  const codes = new Set();
  for (const d of devices) { if (codes.has(d.code)) bad(`mã thiết bị trùng ${d.code}`); codes.add(d.code); }
  for (const c of cards) { if (codes.has(c.code)) bad(`mã thẻ trùng mã khác ${c.code}`); codes.add(c.code); }

  // ───────── Thẻ nhớ ─────────
  const sentHo = new Map(store.handovers.find({}).map((h) => [h.id, h]));
  for (const c of cards) {
    const tag = `thẻ ${c.code} (${c.status})`;
    if (c.status === 'at_bo' && !sites.get(c.site_id)) bad(`${tag}: không rõ BO`);
    if (c.status === 'at_bo') { const s = sites.get(c.site_id); if (s && s.ops_status === 'ended') bad(`${tag}: BO ${s.name} đã kết thúc mà thẻ còn ở đó`); }
    if (c.status === 'with_fo') {
      const t = tasks.get(c.task_id);
      if (!t) bad(`${tag}: không gắn chuyến nào`);
      else if (!TASK_OPEN.includes(t.status)) bad(`${tag}: chuyến ${t.code} đã "${t.status}" mà thẻ vẫn ở FO`);
    }
    if (c.status === 'office' && c.task_id) { const t = tasks.get(c.task_id); if (!t || !TASK_OPEN.includes(t.status)) bad(`${tag}: còn gắn chuyến cũ ${t ? t.code : '#' + c.task_id}`); }
    if (['to_tech', 'to_log'].includes(c.status)) {
      const h = sentHo.get(c.handover_id);
      if (!h || h.status !== 'sent' || h.dir !== c.status) bad(`${tag}: không nằm trong phiếu đang chờ nhận`);
      else if (!store.handover_lines.count({ handover_id: h.id, card_id: c.id })) bad(`${tag}: phiếu ${h.code} không có dòng của thẻ`);
    }
  }
  for (const h of sentHo.values()) {
    const recvType = h.dir === 'to_tech' ? 'cards_receive' : 'cards_back';
    const n = openJobs.filter((j) => j.handover_id === h.id && j.type === recvType).length;
    if (h.status === 'sent' && n !== 1) bad(`phiếu ${h.code} chờ nhận nhưng có ${n} việc nhận`);
    if (h.status !== 'sent' && n) bad(`phiếu ${h.code} đã ${h.status} nhưng việc nhận còn mở`);
    if (h.status === 'sent') for (const l of store.handover_lines.find({ handover_id: h.id })) { const c = cards.find((x) => x.id === l.card_id); if (!c || c.status !== h.dir) bad(`phiếu ${h.code}: thẻ ${l.code} không ở trạng thái "${h.dir}"`); }
  }
  for (const j of openJobs.filter((x) => x.type === 'cards_upload')) {
    if (!cards.some((c) => c.handover_id === j.handover_id && c.status === 'at_tech')) bad(`việc ${j.code} nhập dung lượng còn mở nhưng phiếu không còn thẻ chờ nhập`);
  }
  for (const j of openJobs.filter((x) => x.type === 'cards_return')) {
    if (!cards.some((c) => c.handover_id === j.handover_id && c.status === 'uploaded')) bad(`việc ${j.code} trả thẻ còn mở nhưng phiếu không còn thẻ đã nhập chờ trả`);
  }
  // Một thẻ chỉ nằm trên tối đa một phiếu đang chờ nhận.
  const onSent = new Map();
  for (const h of sentHo.values()) if (h.status === 'sent') for (const l of store.handover_lines.find({ handover_id: h.id })) {
    if (onSent.has(l.card_id)) bad(`thẻ ${l.code} nằm trên hai phiếu đang chờ nhận: ${onSent.get(l.card_id)} và ${h.code}`);
    onSent.set(l.card_id, h.code);
  }

  // ───────── Việc ─────────
  const dd = new Map();
  for (const j of jobs) {
    if (j.dedupe && j.status !== 'cancelled') { if (dd.has(j.dedupe)) bad(`trùng khoá việc ${j.dedupe}: ${dd.get(j.dedupe)} và ${j.code}`); dd.set(j.dedupe, j.code); }
    if (j.status === 'done' && !j.done_at) bad(`việc ${j.code} xong mà không có giờ xong`);
    if (OPEN.includes(j.status) && j.task_id) {
      const t = tasks.get(j.task_id);
      if (!t) bad(`việc ${j.code}: chuyến #${j.task_id} không tồn tại`);
      else if (!TASK_OPEN.includes(t.status)) bad(`việc ${j.code} còn mở trong chuyến ${t.code} đã "${t.status}"`);
      if (j.status !== 'doing') bad(`việc ${j.code} trong chuyến nhưng không ở "đang làm"`);
    }
    if (OPEN.includes(j.status) && j.request_id) {
      const r = requests.find((x) => x.id === j.request_id);
      if (r && ['cancelled'].includes(r.status)) bad(`việc ${j.code} còn mở của yêu cầu đã huỷ ${r.code}`);
    }
    if (OPEN.includes(j.status) && j.assignee_id) {
      const u = store.users.get(j.assignee_id);
      if (!u) bad(`việc ${j.code}: người nhận không tồn tại`);
      else if (u.role !== 'admin' && u.role !== 'fo' && ({ tech: 'tech', tech_lead: 'tech', lead: 'logistics', logistic: 'logistics' })[u.role] !== j.team) bad(`việc ${j.code} (team ${j.team}) giao cho ${u.name} (${u.role})`);
    }
    if (j.type === 'deliver' && OPEN.includes(j.status)) {
      const r = requests.find((x) => x.id === j.request_id);
      if (!r || !['ready', 'delivering'].includes(r.status)) if (!j.task_id) bad(`việc giao ${j.code} còn mở nhưng yêu cầu ${r ? r.code : '?'} đang "${r ? r.status : '?'}"`);
    }
    if (j.type === 'card_swap' && OPEN.includes(j.status) && !j.task_id && !heldJobs.has(j.id)) {
      const s = sites.get(j.site_id);
      if (!s || s.ops_status !== 'live') bad(`việc đổi thẻ ${j.code} còn mở cho BO ${s ? s.name : '?'} đang "${s ? s.ops_status : '?'}"`);
    }
  }

  // ───────── Yêu cầu ─────────
  for (const r of requests) {
    const rk = kits.filter((k) => k.request_id === r.id);
    if (r.kind === 'launch') {
      if (r.status === 'ready') {
        if (!rk.length || rk.some((k) => k.status !== 'reserved')) bad(`yêu cầu ${r.code} "sẵn sàng" nhưng kit: ${rk.map((k) => k.code + ':' + k.status).join(', ') || 'không có'}`);
        const mc = rk.filter((k) => k.kind !== 'iphone').length, ip = rk.filter((k) => k.kind === 'iphone').length;
        if (mc < (r.need.multicam || 0) || ip < (r.need.iphone || 0)) bad(`yêu cầu ${r.code} "sẵn sàng" nhưng chưa đủ số kit`);
        if (!openJobs.some((j) => j.type === 'deliver' && j.request_id === r.id)) bad(`yêu cầu ${r.code} "sẵn sàng" nhưng không có việc giao`);
      }
      if (['submitted', 'preparing'].includes(r.status) && !openJobs.some((j) => j.request_id === r.id && j.type === 'prep_kit') && !jobs.some((j) => j.request_id === r.id && j.type === 'prep_kit' && j.status === 'done')) bad(`yêu cầu ${r.code} đang chuẩn bị mà không có việc chuẩn bị`);
      if (r.status === 'live') { const s = sites.get(r.site_id); if (!s || !['live', 'paused'].includes(s.ops_status)) bad(`yêu cầu ${r.code} "đang ghi hình" nhưng BO đang "${s ? s.ops_status : '?'}"`); }
      if (['closed', 'cancelled'].includes(r.status) && rk.some((k) => ['reserved', 'delivering'].includes(k.status))) bad(`yêu cầu ${r.code} đã ${r.status} mà còn kit chờ giao`);
    }
    if (r.kind === 'support') {
      const open = openJobs.filter((j) => j.request_id === r.id).length;
      if (r.status === 'closed' && open) bad(`yêu cầu hỗ trợ ${r.code} đã đóng mà còn ${open} việc mở`);
      if (r.status === 'preparing' && !open && !jobs.some((j) => j.request_id === r.id && j.status === 'cancelled')) bad(`yêu cầu hỗ trợ ${r.code} đang xử lý mà không còn việc nào`);
    }
  }
  const activeLaunch = new Map();
  for (const r of requests.filter((x) => x.kind === 'launch' && ['submitted', 'preparing', 'ready', 'delivering'].includes(x.status))) { if (activeLaunch.has(r.site_id)) bad(`BO #${r.site_id} có hai yêu cầu launch cùng chạy`); activeLaunch.set(r.site_id, r.code); }

  // ───────── BO ─────────
  for (const s of sites.values()) {
    if (s.type !== 'bo' || !s.active) continue;
    const here = kits.filter((k) => k.site_id === s.id && ['at_bo', 'delivering', 'recovering'].includes(k.status));
    if (s.ops_status === 'live' && !here.length && !flagged(`imp:bo:${s.id}:nokit`)) bad(`BO ${s.name} đang ghi hình nhưng không có kit`);
    if (s.ops_status === 'ended' && here.some((k) => k.status !== 'recovering')) bad(`BO ${s.name} đã kết thúc mà còn kit ${here.map((k) => k.code).join(', ')}`);
    if (['live', 'paused', 'ending', 'ended'].includes(s.ops_status) && !s.onboard_date && !s.launch_date) bad(`BO ${s.name} đã ghi hình mà không có ngày onboard`);
    if (s.ops_status === 'planned' && kits.some((k) => k.site_id === s.id && k.status === 'at_bo') && !kits.filter((k) => k.site_id === s.id && k.status === 'at_bo').every((k) => flagged(`imp:kit:${k.id}:planned`))) bad(`BO ${s.name} chờ launch mà đã có kit ở BO`);
  }

  // ───────── Chuyến FO ↔ việc ─────────
  for (const t of tasks.values()) {
    if (TASK_OPEN.includes(t.status)) continue;
    for (const st of store.stops.find({ task_id: t.id })) for (const id of (st.hub && st.hub.jobs) || []) {
      const j = jobs.find((x) => x.id === id);
      if (j && OPEN.includes(j.status) && j.task_id === t.id) bad(`chuyến ${t.code} đã "${t.status}" mà việc ${j.code} còn gắn chuyến`);
    }
  }

  // ───────── Phụ kiện: tổng = sổ kho, rảnh không âm ─────────
  for (const tp of store.dev_types.find({ kind: 'acc' })) {
    const moves = store.acc_moves.find({ type_id: tp.id });
    const sum = moves.reduce((a, m) => a + m.delta, 0);
    if ((tp.total || 0) !== sum) bad(`phụ kiện ${tp.name}: tổng ${tp.total || 0} khác sổ kho ${sum}`);
    if ((tp.total || 0) < 0) bad(`phụ kiện ${tp.name}: tổng âm`);
    const inKits = kits.filter((k) => k.status !== 'retired').reduce((a, k) => a + ((k.acc || {})[tp.id] || 0), 0);
    if ((tp.total || 0) - inKits < 0 && !flagged(`imp:acc:${tp.id}:neg`)) bad(`phụ kiện ${tp.name}: số trong kit (${inKits}) nhiều hơn tổng (${tp.total || 0})`);
    const last = moves.sort((a, b) => a.at - b.at || a.id - b.id).at(-1);
    if (last && last.total_after !== tp.total) bad(`phụ kiện ${tp.name}: dòng sổ cuối ghi còn ${last.total_after}, tổng hiện tại ${tp.total}`);
  }

  // ───────── Sự cố ─────────
  for (const i of store.incidents.find({})) {
    const incJobs = openJobs.filter((j) => j.incident_id === i.id && j.type === 'incident');
    if (['resolved', 'cancelled'].includes(i.status) && incJobs.length) bad(`sự cố ${i.code} đã ${i.status} mà việc xử lý còn mở`);
    if (['open', 'ack'].includes(i.status) && i.src !== 'import') {
      const any = openJobs.some((j) => j.incident_id === i.id);
      if (!any) bad(`sự cố ${i.code} đang mở mà không có việc nào xử lý`);
    }
  }

  // ───────── Chống trùng: đối chiếu và hộp thư ─────────
  const rc = new Map();
  for (const r of store.recon.find({ status: 'open' })) if (r.ref) { if (rc.has(r.ref)) bad(`trùng dòng đối chiếu ${r.ref}`); rc.set(r.ref, 1); }
  const ib = new Set();
  for (const m of store.inbox.find({})) if (m.ref) { const k = `${m.user_id}|${m.ref}`; if (ib.has(k)) bad(`trùng thông báo ${m.ref} cho người #${m.user_id}`); ib.add(k); }

  return v;
}
