// hub.fuzz.mjs — kiểm thử ngẫu nhiên có hạt giống (lặp lại được): hàng nghìn thao tác thật qua API của cả 3 team và FO,
// theo thứ tự ngẫu nhiên, có cả thao tác sai quyền / sai trạng thái / bấm hai lần. Sau MỖI thao tác:
//  1) máy chủ không được lỗi 500 hay ném lỗi lạ (mọi từ chối phải là lỗi 4xx có lời giải thích);
//  2) toàn bộ bất biến dữ liệu (invariants.mjs) vẫn đúng.
// Gặp vi phạm thì in lại chuỗi thao tác gần nhất để tái hiện. Chạy: node test/hub.fuzz.mjs [số bước] [hạt giống]
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mk, boDevice, ok, group, summary, JPEG } from './harness.mjs';
import { checkInvariants } from './invariants.mjs';

const MIN = 60000, HOUR = 60 * MIN;
const VN = (date, hm) => Date.parse(`${date}T${hm}:00+07:00`);
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Chạy kịch bản ngẫu nhiên; trả về kết quả kèm thế giới đã chạy (h, U) để bài kiểm khác dùng lại dữ liệu phong phú. */
export async function run(kind, steps, seed, opt = {}) {
  const R = rng(seed);
  const pick = (arr) => (arr.length ? arr[Math.floor(R() * arr.length)] : undefined);
  const chance = (p) => R() < p;
  const some = (arr, max = arr.length) => arr.filter(() => chance(0.5)).slice(0, max);
  const h = mk(kind);
  h.clock.set(VN('2026-10-05', '08:00'));
  const people = [['ad', 'admin'], ['tl', 'tech_lead'], ['t1', 'tech'], ['t2', 'tech'], ['ll', 'lead'], ['l1', 'logistic'], ['l2', 'logistic'], ['fo1', 'fo'], ['fo2', 'fo'], ['sh', 'sale_head'], ['s1', 'sale'], ['s2', 'sale']];
  const U = {};
  for (const [u, role] of people) U[u] = await h.user(u, role, { name: u.toUpperCase() });
  const names = Object.keys(U), staff = names.filter((n) => !n.startsWith('fo'));
  const S = h.store;
  const trace = [];
  const stats = { calls: 0, ok: 0, rejected: 0, byCode: {} };
  let broken = null;
  async function call(who, method, path, body, query) {
    stats.calls++;
    trace.push(`${who} ${method} ${path} ${body ? JSON.stringify(body).slice(0, 160) : ''}`);
    if (trace.length > 25) trace.shift();
    let r;
    try { r = await h.call(who, method, path, body, query); } catch (e) { broken = broken || `ném lỗi lạ: ${e.stack || e}`; return { status: 500, body: {} }; }
    if (r.status >= 500) broken = broken || `máy chủ trả ${r.status}: ${JSON.stringify(r.body)}`;
    else if (r.status !== 200) { stats.rejected++; stats.byCode[r.body.error] = (stats.byCode[r.body.error] || 0) + 1; if (!r.body.message) broken = broken || `từ chối ${r.status} mà không có lời giải thích (${r.body.error})`; }
    else stats.ok++;
    if (process.env.FUZZ_TRACE && new RegExp(process.env.FUZZ_TRACE).test(path)) console.log(`      [${r.status}] ${who} ${method} ${path} ${r.status === 200 ? '' : JSON.stringify(r.body)}`);
    return r;
  }
  const seen = () => { for (const n of staff) if (chance(0.8)) h.core.hub.K.hooks.onSeen(S.users.get(U[n].id), h.clock.now()); };

  // Kho ban đầu
  await call('ll', 'POST', '/api/sites', { name: 'VP', type: 'office', lat: 10.7769, lon: 106.7009 });
  const vp = S.sites.find({ type: 'office' })[0];
  const mcs = Array.from({ length: 14 }, (_, i) => 'MC' + (i + 1)), cms = Array.from({ length: 14 }, (_, i) => 'CM' + (i + 1)), ips = Array.from({ length: 6 }, (_, i) => 'IP' + (i + 1));
  await call('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: mcs.join(' ') });
  await call('ll', 'POST', '/api/hub/devices', { type: 'cm5', codes: cms.join(' ') });
  await call('ll', 'POST', '/api/hub/devices', { type: 'iphone', codes: ips.join(' ') });
  await call('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: Array.from({ length: 40 }, (_, i) => 'SD' + (i + 1)).join(' ') });
  for (const id of ['hub_sac', 'day_gan', 'headstrap']) await call('ll', 'POST', `/api/hub/acc/${id}/move`, { kind: 'in', qty: 12, reason: 'Tồn đầu' });
  for (let i = 0; i < 10; i++) await call('l1', 'POST', '/api/hub/kits', { code: 'K' + (i + 1), kind: 'multicam', devices: `${mcs[i]} ${cms[i]}`, acc: { hub_sac: 1, day_gan: 1 } });
  for (let i = 0; i < 4; i++) await call('l1', 'POST', '/api/hub/kits', { code: 'P' + (i + 1), kind: 'iphone', devices: ips[i], acc: { headstrap: 1 } });
  await call('ll', 'PUT', '/api/hub/roster', { rows: ['l1', 'l2'].flatMap((u) => ['2026-10-05', '2026-10-06', '2026-10-07'].map((date) => ({ user_id: U[u].id, date, shift: 'HC' }))) });
  // Tech cũng có ca: chỉ người có ca đã duyệt mới được tự giao việc (không còn "team chưa xếp ca thì ai mở ứng dụng cũng là trong ca").
  await call('tl', 'PUT', '/api/hub/roster', { rows: ['t1', 't2'].flatMap((u) => ['2026-10-05', '2026-10-06', '2026-10-07'].map((date) => ({ user_id: U[u].id, date, shift: 'HC' }))) });

  const bos = [];
  const coords = () => ({ lat: +(10.75 + R() * 0.1).toFixed(5), lon: +(106.65 + R() * 0.1).toFixed(5) });
  const today = () => new Date(h.clock.now() + 7 * HOUR).toISOString().slice(0, 10);
  const addD = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
  const openJobs = (where = {}) => S.jobs.find({ ...where, status: ['open', 'doing'] });
  const actorFor = (j) => {
    if (j.assignee_id && chance(0.85)) return S.users.get(j.assignee_id).username;
    return pick(j.team === 'tech' ? ['t1', 't2', 'tl'] : ['l1', 'l2', 'll']);
  };
  const kitsBy = (st) => S.kits.find({ status: st });

  const A = {
    async newLaunch() {
      const who = pick(['s1', 's2', 'sh', 'l1']);
      const old = S.sites.find({ type: 'bo', ops_status: ['planned', 'ended'] });
      const body = { need: chance(0.7) ? { multicam: 1 + Math.floor(R() * 2) } : { iphone: 1 }, launch_date: addD(today(), Math.floor(R() * 4)), swap_days: some(['1', '2', '3', '4', '5', '6']).join(','), swap_from: '09:00', swap_to: '12:00' };
      if (old.length && chance(0.4)) body.site_id = pick(old).id;
      else { const n = bos.length + 1; body.outlet = { name: 'BO ' + n, code: 'B' + n, phone: '09000000' + String(n).padStart(2, '0'), contact: 'Chủ ' + n, ...(chance(0.9) ? coords() : {}) }; bos.push(n); }
      await call(who, 'POST', '/api/hub/requests', body);
    },
    async assignKits() {
      const r = pick(S.requests.find({ kind: 'launch', status: ['submitted', 'preparing', 'ready'] }));
      if (!r) return;
      const cands = S.kits.find({ status: ['ready', 'preparing', 'returned'], request_id: null }).filter((k) => (r.need.iphone ? k.kind === 'iphone' : k.kind !== 'iphone'));
      await call(pick(['l1', 'l2', 'll', 't1']), 'POST', `/api/hub/requests/${r.id}/assign`, { kit_ids: some(cands, 2).map((k) => k.id) });
    },
    async unassign() {
      const k = pick(S.kits.find({}).filter((x) => x.request_id));
      if (k) await call('l1', 'POST', `/api/hub/requests/${k.request_id}/unassign`, { kit_id: k.id });
    },
    async submitKit() { const k = pick(kitsBy(['preparing', 'returned'])); if (k) await call(pick(['l1', 'l2']), 'POST', `/api/hub/kits/${k.id}/submit`); },
    async reopenKit() { const k = pick(kitsBy(['ready', 'reserved', 'wait_check'])); if (k) await call('ll', 'POST', `/api/hub/kits/${k.id}/reopen`, { reason: 'Chỉnh lại phụ kiện' }); },
    async kitAcc() {
      const k = pick(S.kits.find({ status: { ne: 'retired' } }));
      if (!k) return;
      const acc = { hub_sac: Math.floor(R() * 3), day_gan: Math.floor(R() * 2), headstrap: Math.floor(R() * 2) };
      await call(pick(['l1', 'll', 't1']), 'PATCH', `/api/hub/kits/${k.id}`, { acc, acc_writeoff: chance(0.3), acc_reason: 'Hỏng', reason: 'Điều chỉnh theo thực tế' });
    },
    async swapDevice() {
      const k = pick(kitsBy(['preparing', 'at_tech', 'returned']));
      if (!k) return;
      const bad = S.devices.find({ kit_id: k.id }).filter((d) => d.cond !== 'ok');
      const free = S.devices.find({ kit_id: null, cond: 'ok' }).filter((d) => (k.kind === 'iphone' ? d.type === 'iphone' : d.type !== 'iphone'));
      const repl = bad.map((d) => free.find((f) => f.type === d.type)).filter(Boolean);
      await call(k.status === 'at_tech' ? pick(['t1', 't2']) : 'l1', 'PATCH', `/api/hub/kits/${k.id}`, { remove: bad.map((d) => d.id), add: repl.map((d) => d.code).join(' ') });
    },
    async faulty() {
      const k = pick(S.kits.find({ status: { ne: 'retired' } }));
      if (!k) return;
      const d = pick(S.devices.find({ kit_id: k.id }));
      await call(pick(['l1', 't1', 'tl', 's1']), 'POST', `/api/hub/kits/${k.id}/faulty`, { reason: 'Không lên nguồn', device_id: d && chance(0.6) ? d.id : undefined });
    },
    async retire() { const k = pick(kitsBy(['ready', 'preparing', 'at_tech'])); if (k && chance(0.3)) await call(pick(['ll', 'tl']), 'POST', `/api/hub/kits/${k.id}/retire`, { reason: 'Thanh lý' }); },
    async doJob() {
      const j = pick(openJobs());
      if (!j) return;
      const who = actorFor(j);
      const res = {};
      const k = j.kit_id ? S.kits.get(j.kit_id) : null;
      if (j.type === 'check_kit' || j.type === 'checkin') { res.pass = chance(0.75); if (!res.pass && k && chance(0.7)) { const d = pick(S.devices.find({ kit_id: k.id })); if (d) res.devices = [{ id: d.id, ok: false, note: 'Lỗi' }]; } }
      if (j.type === 'repair' && k) res.devices = S.devices.find({ kit_id: k.id }).map((d) => ({ id: d.id, ok: chance(0.8) }));
      if (j.type === 'deliver') res.doc_code = chance(0.9) ? 'BB' + j.id : '';
      if (j.type === 'card_swap') { res.cards_out = some(S.cards.find({ status: 'office' }).map((c) => c.code), 4); if (chance(0.3)) res.count_in = Math.floor(R() * 5); }
      if (j.type === 'swap_faulty') { const nk = pick(S.kits.find({ status: 'ready', request_id: null, kind: k ? k.kind : 'multicam' })); res.new_kit_id = nk ? nk.id : undefined; }
      if (j.type === 'recover') { const at = S.kits.find({ site_id: j.site_id, status: 'at_bo' }); if (chance(0.3)) res.kit_ids = some(at).map((x) => x.id); res.acc_by_kit = Object.fromEntries(at.filter(() => chance(0.4)).map((x) => [x.id, { hub_sac: Math.floor(R() * 2) }])); }
      if (j.type === 'receive_field' && chance(0.5)) res.acc = { hub_sac: Math.floor(R() * 2), day_gan: Math.floor(R() * 2) };
      if (j.type === 'stock_check' && chance(0.3)) res.diff = 'Lệch 1 hub sạc';
      if (j.type === 'incident') { res.resolution = pick(['no_recover', 'swap', 'office_repair', 'invalid']); res.note = 'Đã xử lý'; }
      await call(who, 'POST', `/api/hub/jobs/${j.id}/done`, { result: res, credit_assignee: chance(0.5) });
    },
    async jobAdmin() {
      const j = pick(openJobs());
      if (!j) return;
      const lead = j.team === 'tech' ? 'tl' : 'll';
      const op = pick(['claim', 'start', 'block', 'unblock', 'release', 'assign', 'cancel', 'patch']);
      const who = chance(0.7) ? actorFor(j) : lead;
      if (op === 'assign') return call(lead, 'POST', `/api/hub/jobs/${j.id}/assign`, { user_id: chance(0.8) ? U[j.team === 'tech' ? pick(['t1', 't2']) : pick(['l1', 'l2'])].id : null });
      if (op === 'cancel') return chance(0.3) && call(lead, 'POST', `/api/hub/jobs/${j.id}/cancel`, { reason: 'Không cần nữa' });
      if (op === 'patch') return call(lead, 'PATCH', `/api/hub/jobs/${j.id}`, { priority: chance(0.5), due_hours: chance(0.3) ? 4 : undefined, reason: 'Dời hạn theo BO' });
      return call(who, 'POST', `/api/hub/jobs/${j.id}/${op}`, { reason: 'Chờ phụ tùng' });
    },
    async manualJob() { await call(pick(['ll', 'tl', 'l1', 't2']), 'POST', '/api/hub/jobs', { title: 'Việc phát sinh', team: pick(['tech', 'logistics']), self: chance(0.5) }); },
    async dispatch() {
      const field = openJobs({ team: 'logistics' }).filter((j) => ['deliver', 'card_swap', 'swap_faulty', 'recover', 'deliver_acc', 'manual'].includes(j.type) && !j.task_id && j.site_id);
      const list = some(field, 3);
      if (!list.length) return;
      const swap_kits = {};
      for (const j of list.filter((x) => x.type === 'swap_faulty')) { const k = S.kits.get(j.kit_id); const nk = pick(S.kits.find({ status: 'ready', request_id: null, kind: k.kind })); if (nk) swap_kits[j.id] = nk.id; }
      const cards_out = {};
      // Thẻ mang đi: phần lớn chọn đúng (mỗi điểm thẻ riêng), thỉnh thoảng cố ý chọn trùng để thử chặn.
      let free = S.cards.find({ status: 'office', task_id: null }).map((c) => c.code);
      for (const j of list.filter((x) => x.type === 'card_swap')) { const take = some(free, 2); cards_out[j.site_id] = take; if (chance(0.97)) free = free.filter((c) => !take.includes(c)); }
      await call(pick(['l1', 'll']), 'POST', '/api/hub/dispatch', { job_ids: list.map((j) => j.id), fo_id: U[pick(['fo1', 'fo2'])].id, office_site_id: chance(0.6) ? vp.id : undefined, round_trip: chance(0.5), swap_kits, cards_out });
    },
    async foStep() {
      const t = pick(S.tasks.find({ status: ['assigned', 'accepted', 'in_progress'] }));
      if (!t || !t.fo_id) return;
      const fo = S.users.get(t.fo_id).username;
      if (t.status !== 'in_progress') {
        if (chance(0.04)) return call(pick(['l1', 'll']), 'POST', `/api/tasks/${t.id}/cancel`, { reason: 'Đổi kế hoạch' });
        if (S.tasks.count({ fo_id: t.fo_id, status: 'in_progress' })) return;
        return call(fo, 'POST', `/api/tasks/${t.id}/start`);
      }
      if (chance(0.02)) return call('ll', 'POST', `/api/tasks/${t.id}/cancel`, { reason: 'Xe hỏng' });
      const stops = S.stops.find({ task_id: t.id }, { order: 'seq' });
      const wait = stops.find((s) => s.status === 'done' && s.bo_status === 'pending');
      if (wait) {
        if (chance(0.2)) return call('l1', 'POST', `/api/stops/${wait.id}/bo-waive`, { reason: 'BO không liên lạc được' });
        const lk = await call('l1', 'POST', `/api/stops/${wait.id}/bo-link`);
        if (lk.status !== 200) return;
        const bo = boDevice(h);
        const mism = chance(0.25);
        const v = await bo.call('POST', '/api/bo-link/view', { token: lk.body.token });
        if (process.env.FUZZ_TRACE) console.log('      [bo-view]', v.status, v.status === 200 ? '' : JSON.stringify(v.body));
        const r = await bo.call('POST', '/api/bo-link/confirm', { token: lk.body.token, photos: [JPEG], cards_recv: wait.cards_out + (mism ? 1 : 0), cards_given: wait.cards_in, dev_recv: wait.dev_out, dev_given: wait.dev_in });
        if (r.status >= 500) broken = broken || 'BO xác nhận lỗi 500';
        if (process.env.FUZZ_TRACE) console.log('      [bo-confirm]', r.status, r.status === 200 ? '' : JSON.stringify(r.body));
        return;
      }
      const s = stops.find((x) => x.status === 'pending' || x.status === 'arrived');
      if (!s) { if (process.env.FUZZ_TRACE) console.log('      [kẹt]', t.code, t.status, JSON.stringify(stops.map((x) => [x.id, x.status, x.bo_status, x.is_return]))); return; }
      h.clock.add(10 * MIN);
      if (!s.is_return && chance(0.12)) return call(fo, 'POST', `/api/stops/${s.id}/fail`, { reason: 'BO đóng cửa' });
      const off = (n) => Math.max(0, n + (chance(0.15) ? 1 : 0));
      return call(fo, 'POST', `/api/stops/${s.id}/proof`, { photos: s.is_return ? [] : [JPEG], cards_out: off(s.exp_cards_out), cards_in: s.exp_cards_in, dev_out: s.exp_dev_out, dev_in: s.exp_dev_in, lat: s.lat, lon: s.lon });
    },
    async incident() {
      const s = pick(S.sites.find({ type: 'bo', ops_status: ['live', 'paused', 'ending'] }));
      if (!s) return;
      const k = pick(S.kits.find({ site_id: s.id, status: 'at_bo' }));
      await call(pick(['s1', 's2', 'sh', 'l1', 't1']), 'POST', '/api/hub/incidents', { site_id: s.id, kit_id: k && chance(0.8) ? k.id : null, label: pick(['Không ghi hình', 'Quá nhiệt', 'Không lên nguồn', 'Khác']), text: 'BO báo lỗi', urgent: chance(0.2) });
    },
    async incidentFlow() {
      const i = pick(S.incidents.find({ status: ['open', 'ack'] }));
      if (!i) return;
      const who = pick(['t1', 't2', 'tl', 's1']);
      if (i.status === 'open' && chance(0.5)) return call(who, 'POST', `/api/hub/incidents/${i.id}/ack`);
      if (chance(0.1)) return call(pick(['tl', who]), 'POST', `/api/hub/incidents/${i.id}/cancel`, { reason: 'Báo nhầm' });
      return call(who, 'POST', `/api/hub/incidents/${i.id}/resolve`, { resolution: pick(['no_recover', 'swap', 'office_repair', 'invalid']), note: 'Đã xử lý tại chỗ' });
    },
    async support() {
      const s = pick(S.sites.find({ type: 'bo', ops_status: ['live', 'paused'] }));
      if (!s) return;
      const kind = pick(['swap_device', 'bad_card', 'extra_acc', 'other']);
      const k = pick(S.kits.find({ site_id: s.id, status: 'at_bo' }));
      await call(pick(['s1', 's2', 'sh', 'l1', 't1']), 'POST', `/api/hub/outlets/${s.id}/support`, { kind, kit_id: k ? k.id : undefined, acc: { headstrap: 1 + Math.floor(R() * 3) }, note: 'Cần hỗ trợ', label: 'Khác' });
    },
    async endBo() { const s = pick(S.sites.find({ type: 'bo', ops_status: ['live', 'paused'] })); if (s && chance(0.25)) await call(pick(['s1', 's2', 'sh', 'l1']), 'POST', `/api/hub/outlets/${s.id}/end`, {}); },
    async editBo() {
      const s = pick(S.sites.find({ type: 'bo' }));
      if (!s) return;
      const body = chance(0.5) ? { swap_days: some(['1', '2', '3', '4', '5', '6', '7']).join(',') } : chance(0.5) ? { pause_from: today(), pause_to: addD(today(), 2) } : { quota_hours: 50 + Math.floor(R() * 200) };
      await call(pick(['s1', 's2', 'sh', 'l1', 'll']), 'PATCH', `/api/hub/outlets/${s.id}`, body);
    },
    async cancelReq() { const r = pick(S.requests.find({ kind: 'launch', status: ['submitted', 'preparing', 'ready'] })); if (r && chance(0.3)) await call(pick(['s1', 's2', 'sh', 'll']), 'POST', `/api/hub/requests/${r.id}/cancel`, { reason: 'BO đổi ý' }); },
    async moveLaunch() { const r = pick(S.requests.find({ kind: 'launch', status: ['submitted', 'preparing', 'ready'] })); if (r) await call(pick(['s1', 's2', 'l1']), 'PATCH', `/api/hub/requests/${r.id}`, { launch_date: addD(today(), Math.floor(R() * 5)) }); },
    async handover() {
      if (chance(0.5)) { const c = some(S.cards.find({ status: 'returned' }), 6); if (c.length) await call(pick(['l1', 'l2']), 'POST', '/api/hub/handovers', { dir: 'to_tech', codes: c.map((x) => x.code) }); }
      else { const c = some(S.cards.find({ status: 'uploaded' }), 6); if (c.length) await call(pick(['t1', 't2']), 'POST', '/api/hub/handovers', { dir: 'to_log', codes: c.map((x) => x.code) }); }
    },
    async receiveHo() {
      const ho = pick(S.handovers.find({ status: 'sent' }));
      if (!ho) return;
      const who = ho.dir === 'to_tech' ? pick(['t1', 't2', 'l1']) : pick(['l1', 'l2', 't1']);
      if (chance(0.15)) return call(ho.dir === 'to_tech' ? 'l1' : 't1', 'POST', `/api/hub/handovers/${ho.id}/cancel`, { reason: 'Lập nhầm' });
      const lines = S.handover_lines.find({ handover_id: ho.id });
      if (chance(0.7)) return call(who, 'POST', `/api/hub/handovers/${ho.id}/receive`, { all: true });
      return call(who, 'POST', `/api/hub/handovers/${ho.id}/receive`, { codes: some(lines).map((l) => l.code), missing_reason: 'Thiếu thẻ' });
    },
    async upload() {
      const cs = some(S.cards.find({ status: 'at_tech' }), 5);
      if (!cs.length) return;
      await call(pick(['t1', 't2', 'tl']), 'POST', '/api/hub/cards/records', { records: cs.map((c) => { const gb = chance(0.15) ? 0 : +(R() * 120).toFixed(1); return { card_id: c.id, gb, zero_reason: gb ? undefined : 'BO không bật máy' }; }) });
    },
    async cardAdjust() { const c = pick(S.cards.find({})); if (c && chance(0.3)) await call(pick(['ll', 't1', 'l1']), 'PATCH', `/api/hub/cards/${c.id}`, { status: pick(['office', 'bad', 'lost', 'returned']), reason: 'Điều chỉnh theo thực tế' }); },
    async accMove() { await call(pick(['l1', 'll', 's1']), 'POST', `/api/hub/acc/${pick(['hub_sac', 'day_gan', 'headstrap'])}/move`, { kind: pick(['in', 'out', 'found', 'count']), qty: 1 + Math.floor(R() * 4), free_counted: Math.floor(R() * 10), reason: 'Kiểm kê' }); },
    async devCond() { const d = pick(S.devices.find({})); if (d && chance(0.2)) await call(pick(['ll', 't1']), 'PATCH', `/api/hub/devices/${d.id}`, { cond: pick(['ok', 'lost', 'retired', 'repairing']), reason: 'Kiểm kê' }); },
    async roster() { await call(pick(['ll', 'tl']), 'PUT', '/api/hub/roster', { rows: [{ user_id: U[pick(['l1', 'l2', 't1', 't2'])].id, date: addD(today(), Math.floor(R() * 3)), shift: pick(['HC', 'S', 'C']), kind: chance(0.1) ? 'leave' : undefined }] }); },
    async reads() {
      const who = pick(staff);
      for (const [m, p, q] of [['GET', '/api/hub/overview'], ['GET', '/api/hub/sale'], ['GET', '/api/hub/home'], ['GET', '/api/hub/perf', { period: pick(['week', 'month']) }], ['GET', '/api/hub/perf/me'], ['GET', '/api/hub/jobs'], ['GET', '/api/hub/outlets'], ['GET', '/api/hub/stock/summary'], ['GET', '/api/hub/incidents/stats'], ['GET', '/api/hub/recon']]) await call(who, m, p, undefined, q);
    },
    async time() { h.clock.add(chance(0.7) ? Math.floor(R() * 3 * HOUR) : Math.floor(R() * 26 * HOUR)); seen(); h.core.tick(); },
  };
  const W8 = { newLaunch: 5, assignKits: 8, unassign: 1, submitKit: 6, reopenKit: 1, kitAcc: 2, swapDevice: 3, faulty: 2, retire: 1, doJob: 22, jobAdmin: 6, manualJob: 1, dispatch: 5, foStep: 14, incident: 3, incidentFlow: 4, support: 3, endBo: 2, editBo: 2, cancelReq: 1, moveLaunch: 1, handover: 4, receiveHo: 4, upload: 4, cardAdjust: 1, accMove: 2, devCond: 1, roster: 1, reads: 1, time: 6 };
  const bag = Object.entries(W8).flatMap(([k, w]) => Array(w).fill(k));
  const used = {};
  seen();
  for (let i = 0; i < steps && !broken; i++) {
    const a = pick(bag);
    used[a] = (used[a] || 0) + 1;
    trace.push(`── bước ${i + 1}: ${a}`);
    await A[a]();
    const v = checkInvariants(S);
    if (!v.length && opt.onStep) { const e = await opt.onStep(i, a, { h, U }); if (e) broken = `bước ${i + 1} (${a}): ${e}`; } // bài kiểm khác xét thêm sau mỗi bước
    if (v.length) { broken = `bất biến sai ở bước ${i + 1} (${a}): ${v.slice(0, 6).join(' | ')}`; if (process.env.FUZZ_DEBUG) console.log(JSON.stringify({ log: S.hub_log.find(process.env.FUZZ_ENTITY ? { entity: process.env.FUZZ_ENTITY.split('#')[0], entity_id: +process.env.FUZZ_ENTITY.split('#')[1] } : {}, { order: 'ts', desc: true, limit: 40 }).map((l) => `${l.entity}#${l.entity_id} ${l.action}: ${l.text}`).reverse(), jobs: S.jobs.find({ status: ['open', 'doing'] }).map((j) => [j.code, j.type, j.status, j.task_id, j.request_id, j.kit_id]), tasks: S.tasks.find({}).map((t) => [t.id, t.code, t.status]), reqs: S.requests.find({}).map((r) => [r.id, r.code, r.kind, r.status]), ho: S.handovers.find({}).map((x) => [x.id, x.code, x.dir, x.status, S.jobs.find({ handover_id: x.id }).map((j) => [j.id, j.code, j.type, j.status, j.dedupe])]) })); }
  }
  if (process.env.FUZZ_TRACE) for (const t of S.tasks.find({})) console.log('      [chuyến]', t.code, t.status, t.cancel_reason || '', JSON.stringify(S.stops.find({ task_id: t.id }, { order: 'seq' }).map((x) => [x.id, x.status, x.bo_status, x.is_return ? 'về' : ''])));
  if (process.env.FUZZ_GREP) for (const l of S.hub_log.find({}, { order: 'ts' })) if (l.text.includes(process.env.FUZZ_GREP)) console.log('      [lịch sử]', new Date(l.ts).toISOString().slice(5, 16), `${l.entity}#${l.entity_id}`, l.action, l.text);
  if (process.env.FUZZ_ENTITY) { const [e, id] = process.env.FUZZ_ENTITY.split('#'); for (const l of S.hub_log.find({ entity: e, entity_id: +id }, { order: 'ts' })) console.log('      [lịch sử]', new Date(l.ts).toISOString().slice(5, 16), l.action, l.text); }
  if (broken) console.log(`    hạt giống ${seed}, 25 thao tác cuối:\n      ` + trace.join('\n      '));
  return { h, U, broken, stats, used, state: { jobs: S.jobs.count({}), done: S.jobs.count({ status: 'done' }), tasks: S.tasks.count({ status: 'completed' }), records: S.card_records.count({}), live: S.sites.count({ ops_status: 'live' }), ended: S.sites.count({ ops_status: 'ended' }), incidents: S.incidents.count({}), recon: S.recon.count({}), autofail: S.hub_log.find({ action: 'auto_fail' }).map((l) => l.text) } };
}

// Chạy trực tiếp (không phải khi được bài kiểm khác import).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();

async function main() {
  const steps = +(process.argv[2] || 1500), seed0 = +(process.argv[3] || 1);
  let totalRecords = 0;
  const seeds = process.argv[3] ? [seed0] : [1, 2, 3, 4, 5, 6];
  for (const kind of (process.env.FUZZ_KINDS || 'memory,sqlite').split(',')) {
    for (const seed of kind === 'sqlite' ? seeds.slice(0, 2) : seeds) {
      await group(`Ngẫu nhiên ${steps} thao tác, hạt giống ${seed}, kho ${kind === 'sqlite' ? 'SQLite' : 'bộ nhớ'}`, async () => {
        const t0 = Date.now();
        const r = await run(kind, steps, seed);
        ok(!r.broken, r.broken || '');
        if (r.state.autofail.length) console.log('    việc không tự đóng được sau chuyến:', r.state.autofail.length, process.env.FUZZ_DEBUG ? JSON.stringify(r.state.autofail) : '');
        if (process.env.FUZZ_DEBUG) console.log('    lý do từ chối:', JSON.stringify(r.stats.byCode), 'thao tác:', JSON.stringify(r.used));
        console.log(`    ${r.stats.calls} lệnh API (${r.stats.ok} thành công, ${r.stats.rejected} bị từ chối đúng quy tắc), ${Date.now() - t0} ms · việc ${r.state.done}/${r.state.jobs} xong, chuyến xong ${r.state.tasks}, BO đang quay ${r.state.live}, đã kết thúc ${r.state.ended}, sự cố ${r.state.incidents}, bản ghi dung lượng ${r.state.records}, đối chiếu ${r.state.recon}`);
        ok(r.state.done > steps / 30 && r.state.tasks > 0, 'kịch bản ngẫu nhiên đi được tới cuối vòng đời (có việc xong, có chuyến FO xong)');
        totalRecords += r.state.records;
      });
    }
  }
  if (seeds.length > 1) ok(totalRecords > 0, `các lượt chạy có nhập dung lượng thẻ (tổng ${totalRecords} bản ghi)`);
  summary('Ops Hub — ngẫu nhiên');
}
