// fix.access.test.mjs — kiểm hồi quy cho nhóm lỗi phân quyền giữa các team và quyền sở hữu trường dữ liệu:
// người phụ trách BO đổi thì quyền với yêu cầu đổi theo; Rider Live không đổi loại / xoá BO đang dùng; Logistics không sửa số của Sale;
// nhân viên không tự đặt phút chuẩn; số theo từng người chỉ Lead của team thấy; nhật ký theo team; nhập dữ liệu của Tech chỉ Tech Lead;
// liên kết Đối chiếu không đọc nhầm mã thành số thứ tự; WebSocket chặn như HTTP khi chưa đổi mật khẩu.
// Mỗi nhóm chạy 2 lần: kho bộ nhớ và kho SQLite (riêng WebSocket dựng máy chủ thật).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { mk, ok, eq, group, summary } from './harness.mjs';
import { buildXlsx } from './xlsx-build.mjs';
import { seedDemo } from '../core/demo.js';
import { seedHubDemo } from '../core/hub/demo.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VN = (date, hm) => Date.parse(`${date}T${hm}:00+07:00`);
const Q3 = { name: 'BO Quận 3', code: 'Q3', lat: 10.7835, lon: 106.6869, contact: 'Chị Hoa', phone: '0901111222', address: '12 Võ Văn Tần, Quận 3' };
const TD = { name: 'BO Thủ Đức', code: 'TD', lat: 10.8494, lon: 106.7537, contact: 'Anh Nam', phone: '0903333444', address: 'Thủ Đức' };

async function world(kind) {
  const h = mk(kind);
  h.clock.set(VN('2026-10-05', '08:30')); // Thứ Hai, W41
  const people = [['ad', 'admin', 'Quản trị'], ['tl', 'tech_lead', 'Trưởng Tech'], ['t1', 'tech', 'Tech Một'], ['t2', 'tech', 'Tech Hai'], ['ll', 'lead', 'Trưởng Logistics'],
    ['l1', 'logistic', 'Log Một'], ['l2', 'logistic', 'Log Hai'], ['fo1', 'fo', 'FO Một'], ['sh', 'sale_head', 'Trưởng Sale'], ['s1', 'sale', 'Sale Một'], ['s2', 'sale', 'Sale Hai']];
  const U = {};
  for (const [u, role, name] of people) U[u] = await h.user(u, role, { name });
  const go = async (who, method, p, body, query) => {
    const r = await h.call(who, method, p, body, query);
    if (r.status !== 200) throw new Error(`${who} ${method} ${p} → ${r.status} ${r.body.error}: ${r.body.message}`);
    return r.body;
  };
  const call = (who, method, p, body, query) => h.call(who, method, p, body, query);
  const st = async (who, method, p, body, query) => (await h.call(who, method, p, body, query)).status;
  const site = (code) => h.store.sites.find({ code }, { limit: 1 })[0];
  const kit = (code) => h.store.kits.find({ code }, { limit: 1 })[0];
  const dev = (code) => h.store.devices.find({ code }, { limit: 1 })[0];
  const card = (code) => h.store.cards.find({ code }, { limit: 1 })[0];
  return { h, U, go, call, st, site, kit, dev, card };
}

async function suite(kind) {
  console.log(`\n── Kho ${kind === 'sqlite' ? 'SQLite' : 'bộ nhớ'} ──`);

  await group('Đổi Sale phụ trách BO: yêu cầu của BO đi theo người phụ trách hiện tại', async () => {
    const { h, U, go, call, st, site } = await world(kind);
    const req = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-07', outlet: Q3 })).request;
    const q3 = site('Q3');
    eq(await st('s1', 'GET', `/api/hub/requests/${req.id}`), 200, 'trước khi đổi: Sale Lead tạo yêu cầu xem được');
    await go('sh', 'PATCH', `/api/hub/outlets/${q3.id}`, { sale_id: U.s2.id });
    eq(h.store.requests.find({ site_id: q3.id }).map((r) => r.sale_id), [U.s2.id], 'yêu cầu của BO ghi theo Sale phụ trách mới');
    const lg = h.store.hub_log.find({ entity: 'outlet', entity_id: q3.id, action: 'reassign' });
    ok(lg.length === 1 && lg[0].text.includes('Sale Hai') && lg[0].text.includes('Sale Một'), 'nhật ký ghi việc giao lại BO, kèm người cũ và người mới');
    const list = async (who) => (await go(who, 'GET', '/api/hub/requests')).requests.map((r) => r.id);
    eq(await list('s1'), [], 'Sale Lead cũ không còn thấy yêu cầu của BO');
    eq(await list('s2'), [req.id], 'Sale Lead mới thấy yêu cầu của BO mình');
    eq(await st('s1', 'GET', `/api/hub/requests/${req.id}`), 403, 'Sale Lead cũ không mở được yêu cầu');
    eq(await st('s1', 'PATCH', `/api/hub/requests/${req.id}`, { launch_date: '2026-10-12' }), 403, 'Sale Lead cũ không sửa được yêu cầu');
    eq(await st('s1', 'POST', `/api/hub/requests/${req.id}/cancel`, { reason: 'Đổi ý' }), 403, 'Sale Lead cũ không huỷ được yêu cầu');
    eq([h.store.requests.get(req.id).status, site('Q3').launch_date], ['submitted', '2026-10-07'], 'yêu cầu và ngày launch giữ nguyên');
    eq(await st('s2', 'GET', `/api/hub/requests/${req.id}`), 200, 'Sale Lead mới mở được yêu cầu');
    eq(await st('s2', 'PATCH', `/api/hub/requests/${req.id}`, { note: 'Sale mới tiếp nhận BO' }), 200, 'Sale Lead mới sửa được yêu cầu');
    const sale = async (who) => (await go(who, 'GET', '/api/hub/sale')).requests.map((r) => r.id);
    eq([await sale('s1'), await sale('s2')], [[], [req.id]], 'Dashboard Kinh doanh: yêu cầu hiện cho người phụ trách mới');
    // Yêu cầu hỗ trợ người mới gửi: người cũ không đọc được, kể cả qua yêu cầu launch cũ.
    h.store.sites.update(q3.id, { ops_status: 'live' }); // dựng nhanh: BO đã ghi hình
    const sup = (await go('s2', 'POST', `/api/hub/outlets/${q3.id}/support`, { kind: 'other', note: 'Chủ BO muốn đổi giờ đóng cửa' })).request;
    eq(await st('s1', 'GET', `/api/hub/requests/${sup.id}`), 403, 'Sale Lead cũ không đọc yêu cầu hỗ trợ của người mới');
    const det = await go('s2', 'GET', `/api/hub/requests/${req.id}`);
    ok(det.children.some((c) => c.id === sup.id), 'Sale Lead mới thấy yêu cầu hỗ trợ trong yêu cầu launch');
    const r1 = await call('s1', 'GET', `/api/hub/requests/${req.id}`);
    ok(r1.status === 403 && !JSON.stringify(r1.body).includes('đóng cửa'), 'không lộ nội dung yêu cầu hỗ trợ cho người cũ');
  });

  await group('Rider Live: không đổi loại BO, không xoá BO đang dùng; sửa / xoá BO có nhật ký', async () => {
    const { h, go, st, site } = await world(kind);
    const vp = (await go('ll', 'POST', '/api/sites', { name: 'Văn phòng Atlas', type: 'office', lat: 10.7769, lon: 106.7009 })).site;
    const req = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-07', outlet: Q3 })).request;
    const q3 = site('Q3');
    const logs = (id) => h.store.hub_log.find({ entity: 'outlet', entity_id: id });
    eq(await st('l1', 'DELETE', `/api/sites/${q3.id}`), 409, 'BO còn yêu cầu đang xử lý → không xoá được ở Rider Live');
    eq(await st('l1', 'PATCH', `/api/sites/${q3.id}`, { type: 'office' }), 409, 'không đổi BO sang loại điểm khác ở Rider Live');
    eq([site('Q3').type, site('Q3').active], ['bo', 1], 'BO giữ nguyên');
    const n0 = logs(q3.id).length;
    await go('l1', 'PATCH', `/api/sites/${q3.id}`, { name: 'BO Quận 3', type: 'bo', address: '14 Võ Văn Tần', lat: Q3.lat, lon: Q3.lon });
    eq(site('Q3').address, '14 Võ Văn Tần', 'Logistics sửa địa chỉ BO ở Rider Live');
    ok(logs(q3.id).length === n0 + 1 && logs(q3.id).some((l) => l.action === 'update' && l.text.includes('Rider Live')), 'sửa BO ở Rider Live có nhật ký Ops Hub');
    await go('s1', 'POST', `/api/hub/requests/${req.id}/cancel`, { reason: 'BO đổi ý' });
    // BO đang ghi hình, kit đang ở BO, việc đang mở: đều chặn xoá.
    const td = (await go('l1', 'POST', '/api/hub/outlets', TD)).outlet;
    h.store.sites.update(td.id, { ops_status: 'live' });
    const r1 = await h.call('l1', 'DELETE', `/api/sites/${td.id}`);
    ok(r1.status === 409 && /đang ghi hình/.test(r1.body.message), 'BO đang ghi hình → không xoá, báo lý do');
    h.store.sites.update(td.id, { ops_status: 'ended' });
    await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: 'MC01' });
    const k = (await go('l1', 'POST', '/api/hub/kits', { code: 'K01', kind: 'multicam', devices: 'MC01' })).kit;
    h.store.kits.update(k.id, { status: 'at_bo', site_id: td.id }); // dựng nhanh: kit còn nằm ở BO
    const r2 = await h.call('l1', 'DELETE', `/api/sites/${td.id}`);
    ok(r2.status === 409 && /kit/.test(r2.body.message), 'BO còn kit ở ngoài → không xoá');
    h.store.kits.update(k.id, { status: 'returned', site_id: null });
    const j = (await go('ll', 'POST', '/api/hub/jobs', { team: 'logistics', title: 'Kiểm tra dây nguồn tại BO', site_id: td.id })).job;
    const r3 = await h.call('l1', 'DELETE', `/api/sites/${td.id}`);
    ok(r3.status === 409 && /việc/.test(r3.body.message), 'BO còn việc đang mở → không xoá');
    await go('ll', 'POST', `/api/hub/jobs/${j.id}/cancel`, { reason: 'Không cần nữa' });
    await go('l1', 'DELETE', `/api/sites/${td.id}`);
    eq(h.store.sites.get(td.id).active, 0, 'BO không còn dùng → xoá được');
    ok(logs(td.id).some((l) => l.action === 'delete'), 'xoá BO ở Rider Live có nhật ký Ops Hub');
    await go('l1', 'DELETE', `/api/sites/${q3.id}`);
    eq(h.store.sites.get(q3.id).active, 0, 'BO chờ launch đã huỷ yêu cầu → xoá được');
    // Thêm BO ở Rider Live cũng có nhật ký Ops Hub
    const nb = (await go('l1', 'POST', '/api/sites', { name: 'BO Mới Rider', type: 'bo', lat: 10.79, lon: 106.7 })).site;
    ok(logs(nb.id).some((l) => l.action === 'create' && l.text.includes('Rider Live')), 'thêm BO ở Rider Live có nhật ký Ops Hub');
    // Điểm không phải BO: như cũ.
    await go('l1', 'PATCH', `/api/sites/${vp.id}`, { type: 'other' });
    await go('l1', 'DELETE', `/api/sites/${vp.id}`);
    eq(h.store.sites.get(vp.id).active, 0, 'điểm văn phòng: sửa, xoá như trước');
  });

  await group('Việc giao tay: chỉ Lead đặt phút chuẩn; Lead chọn "Tôi tự làm" được', async () => {
    const { h, U, go, st } = await world(kind);
    eq(await st('t1', 'POST', '/api/hub/jobs', { title: 'Việc tự làm', std_min: 480, self: true }), 403, 'Tech Executive không tự đặt phút chuẩn');
    eq(await st('l1', 'POST', '/api/hub/jobs', { title: 'Việc tự làm', std_min: 480, self: true }), 403, 'Logistic Executive không tự đặt phút chuẩn');
    eq(h.store.jobs.count({}), 0, 'không việc nào được tạo');
    const jl = (await go('tl', 'POST', '/api/hub/jobs', { title: 'Lead đặt phút chuẩn', std_min: 30, assignee_id: U.t1.id })).job;
    eq([jl.assignee.id, jl.points], [U.t1.id, 5], 'Tech Lead đặt 30 phút chuẩn = 5 điểm');
    await go('ad', 'PUT', '/api/hub/config', { jobStd: { manual: 12 } });
    const js = (await go('t1', 'POST', '/api/hub/jobs', { title: 'Việc tự làm', self: true })).job;
    eq(js.assignee.id, U.t1.id, 'nhân viên tự tạo việc cho mình');
    await go('t1', 'POST', `/api/hub/jobs/${js.id}/done`, { result: { note: 'Đã xong' } });
    eq(h.store.jobs.get(js.id).std_min, 12, 'việc tự tạo tính theo định mức việc giao tay trong Cài đặt');
    // "Tôi tự làm" của Lead
    const a = await h.call('ll', 'POST', '/api/hub/jobs', { title: 'Lead tự làm', assignee_id: 'me' });
    eq([a.status, a.body.job && a.body.job.assignee && a.body.job.assignee.id], [200, U.ll.id], 'Logistic Lead chọn "Tôi tự làm" → việc giao cho chính mình');
    const b = await h.call('tl', 'POST', '/api/hub/jobs', { title: 'Tech Lead tự làm', assignee_id: 'me' });
    eq([b.status, b.body.job && b.body.job.assignee && b.body.job.assignee.id], [200, U.tl.id], 'Tech Lead chọn "Tôi tự làm" → việc giao cho chính mình');
    eq(await st('ad', 'POST', '/api/hub/jobs', { team: 'tech', title: 'Quản trị tự làm', assignee_id: 'me' }), 400, 'Quản trị không thuộc team: không tự nhận việc của team');
  });

  await group('Sửa BO: Logistics không đổi số của Sale; ngày launch / kết thúc chỉ qua luồng riêng', async () => {
    const { h, U, go, call, st, site } = await world(kind);
    await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-07', outlet: Q3 });
    const q3 = site('Q3'), P = `/api/hub/outlets/${q3.id}`;
    await go('sh', 'PATCH', P, { quota_hours: 300, area: 'Quận 3', business: 'Nhà hàng' });
    const r = await call('l1', 'PATCH', P, { quota_hours: 5000 });
    eq([r.status, r.body.message], [403, 'Quota giờ quay do Sale chốt.'], 'Logistics đổi quota → 403');
    eq(await st('ll', 'PATCH', P, { quota_hours: null }), 403, 'Logistic Lead xoá quota → 403');
    eq(await st('l1', 'PATCH', P, { address: '14 Võ Văn Tần', quota_hours: 300, sale_id: U.s1.id }), 200, 'gửi kèm đúng quota, Sale hiện tại (không đổi) → lưu được');
    eq([site('Q3').address, site('Q3').quota_hours, site('Q3').sale_id], ['14 Võ Văn Tần', 300, U.s1.id], 'địa chỉ đổi, quota và Sale giữ nguyên');
    eq(await st('l1', 'PATCH', P, { sale_id: U.s2.id }), 403, 'Logistics không giao lại BO cho Sale khác');
    eq(await st('ll', 'PATCH', P, { business: 'Spa' }), 403, 'Logistics không đổi ngành hàng (thông tin kinh doanh của Sale)');
    eq(await st('l1', 'PATCH', P, { area: 'Quận 1' }), 403, 'Logistics không đổi khu vực');
    eq(await st('l1', 'PATCH', P, { code: 'Q3X' }), 403, 'BO đã có mã: Logistics không đổi mã');
    eq(await st('ad', 'PATCH', P, { launch_date: '2026-12-31' }), 409, 'ngày launch không đổi qua sửa BO (kể cả Quản trị)');
    eq(await st('l1', 'PATCH', P, { end_date: '2026-10-08' }), 409, 'ngày kết thúc không đổi qua sửa BO');
    eq([site('Q3').launch_date, site('Q3').end_date, site('Q3').sale_id, site('Q3').code], ['2026-10-07', null, U.s1.id, 'Q3'], 'BO giữ nguyên ngày, Sale, mã');
    eq(await st('ad', 'PATCH', P, { launch_date: '2026-10-07', note: 'Quản trị ghi chú' }), 200, 'gửi lại đúng ngày launch hiện tại thì không chặn');
    // Logistics sửa thông tin điểm
    await go('l1', 'PATCH', P, { contact: 'Anh Tư', phone: '0907777888', lat: 10.79, lon: 106.69, swap_days: [1, 3, 5], swap_from: '09:00', swap_to: '11:00', note: 'Gửi xe sau quán' });
    const s = site('Q3');
    eq([s.contact, s.phone, s.lat, s.swap_days, s.swap_from, s.note], ['Anh Tư', '0907777888', 10.79, '1,3,5', '09:00', 'Gửi xe sau quán'], 'Logistics sửa liên hệ, toạ độ, lịch đổi thẻ, ghi chú');
    // Mã BO: Sale sửa được; Logistics chỉ điền khi BO chưa có mã
    await go('s1', 'PATCH', P, { code: 'Q3-A' });
    eq(site('Q3-A') && site('Q3-A').id, q3.id, 'Sale Lead đổi mã BO của mình');
    const o = (await go('l1', 'POST', '/api/hub/outlets', { name: 'BO Chưa Mã', lat: 10.8, lon: 106.7 })).outlet;
    await go('l1', 'PATCH', `/api/hub/outlets/${o.id}`, { code: 'NEW1' });
    eq(h.store.sites.get(o.id).code, 'NEW1', 'BO chưa có mã: Logistics điền mã được');
    eq(await st('l1', 'POST', '/api/hub/outlets', { name: 'BO Có Quota', quota_hours: 100 }), 403, 'Logistics thêm BO kèm quota → 403');
    eq(await st('sh', 'PATCH', P, { quota_hours: 320 }), 200, 'Head of Sale vẫn đổi quota');
  });

  await group('Bảng việc của nhân viên: "Cả team" chỉ hàng việc đang mở; việc xong chỉ của mình; không kèm điểm của người khác', async () => {
    const { h, U, go, st } = await world(kind);
    const a = (await go('tl', 'POST', '/api/hub/jobs', { title: 'Việc của Tech Một', assignee_id: U.t1.id, std_min: 30 })).job;
    const b = (await go('tl', 'POST', '/api/hub/jobs', { title: 'Việc của Tech Hai', assignee_id: U.t2.id, std_min: 60 })).job;
    const c = (await go('tl', 'POST', '/api/hub/jobs', { title: 'Việc Tech Hai đang giữ', assignee_id: U.t2.id, std_min: 20 })).job;
    await go('t1', 'POST', `/api/hub/jobs/${a.id}/done`, { result: { note: 'Xong' } });
    await go('t2', 'POST', `/api/hub/jobs/${b.id}/done`, { result: { note: 'Xong' } });
    const ids = (r) => r.jobs.map((j) => j.id).sort((x, y) => x - y);
    eq(ids(await go('t1', 'GET', '/api/hub/jobs', null, { view: 'team', status: 'done' })), [a.id], 'nhân viên xem "Cả team · Đã xong": chỉ việc của mình');
    const all = await go('t1', 'GET', '/api/hub/jobs', null, { view: 'team', status: 'all' });
    ok(!all.jobs.some((j) => j.id === b.id) && all.jobs.some((j) => j.id === c.id) && all.jobs.some((j) => j.id === a.id), '"Tất cả": việc đang mở của team + việc đã đóng của mình');
    const act = await go('t1', 'GET', '/api/hub/jobs', null, { view: 'team' });
    const cj = act.jobs.find((j) => j.id === c.id);
    ok(cj && cj.assignee.id === U.t2.id, 'hàng việc đang mở của team vẫn thấy ai đang giữ');
    eq([cj.points, cj.done_by, cj.late], [null, null, null], 'việc người khác giữ: không kèm điểm');
    const done = await go('tl', 'GET', '/api/hub/jobs', null, { view: 'team', status: 'done' });
    eq(ids(done), [a.id, b.id], 'Tech Lead thấy mọi việc đã xong của team');
    ok(done.jobs.find((j) => j.id === b.id).points === 10 && done.jobs.find((j) => j.id === b.id).done_by.id === U.t2.id, 'Tech Lead thấy điểm và người làm');
    const det = await go('t1', 'GET', `/api/hub/jobs/${b.id}`);
    eq([det.job.done_by, det.job.points, det.job.late], [null, null, null], 'chi tiết việc đã xong của người khác: không kèm người làm, điểm');
    const mine = await go('t1', 'GET', `/api/hub/jobs/${a.id}`);
    eq([mine.job.done_by.id, mine.job.points], [U.t1.id, 5], 'chi tiết việc của mình: đủ điểm');
    // Chi tiết việc chỉ trong team
    const lj = (await go('ll', 'POST', '/api/hub/jobs', { title: 'Việc của Logistics', assignee_id: U.l1.id })).job;
    eq([await st('t1', 'GET', `/api/hub/jobs/${lj.id}`), await st('tl', 'GET', `/api/hub/jobs/${lj.id}`)], [403, 403], 'Tech không mở chi tiết việc của Logistics');
    eq([await st('l1', 'GET', `/api/hub/jobs/${a.id}`), await st('ll', 'GET', `/api/hub/jobs/${a.id}`)], [403, 403], 'Logistics không mở chi tiết việc của Tech');
    eq([await st('ad', 'GET', `/api/hub/jobs/${lj.id}`), await st('l2', 'GET', `/api/hub/jobs/${lj.id}`)], [200, 200], 'Quản trị và người cùng team mở được');
    // Lịch sử việc trong chi tiết kit: nhân viên không thấy người làm, điểm của người khác
    await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: 'MC09' });
    const k = (await go('ll', 'POST', '/api/hub/kits', { code: 'K09', kind: 'multicam', devices: 'MC09' })).kit;
    const t = h.clock.now();
    const kj = h.store.jobs.insert({ code: 'V-K09', type: 'check_kit', team: 'tech', title: 'Kiểm kit K09', status: 'done', kit_id: k.id, assignee_id: U.t2.id, done_by: U.t2.id, std_min: 60, due_at: t - 1000, done_at: t, created_at: t - 3600000 }); // dựng nhanh: Tech Hai đã kiểm kit
    const kv = (await go('t1', 'GET', `/api/hub/kits/${k.id}`)).kit.jobs.find((x) => x.id === kj);
    eq([kv.done_by, kv.points, kv.assignee], [null, null, null], 'chi tiết kit cho nhân viên: việc đã xong của người khác không kèm người làm, điểm');
    ok((await go('tl', 'GET', `/api/hub/kits/${k.id}`)).kit.jobs.find((x) => x.id === kj).done_by.id === U.t2.id, 'Tech Lead thấy người làm trong chi tiết kit');
    ok((await go('l1', 'GET', `/api/hub/kits/${k.id}`)).kit.jobs.find((x) => x.id === kj).points === null, 'Logistics không thấy điểm việc của Tech');
    // Trang đầu: ai đang trong ca chỉ Lead thấy
    const tHome = await go('t1', 'GET', '/api/hub/home');
    ok(tHome.on_shift === undefined, 'trang đầu của nhân viên: không kèm danh sách ai đang trong ca');
    ok(Array.isArray((await go('tl', 'GET', '/api/hub/home')).on_shift), 'Tech Lead thấy ai đang trong ca');
  });

  await group('Dung lượng thẻ: người nhập chỉ Tech thấy; nhân viên chỉ thấy tên mình', async () => {
    const { h, U, go, call, st, card } = await world(kind);
    await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-07', outlet: Q3 });
    await go('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: 'SD01 SD02' });
    const sid = h.store.sites.find({ code: 'Q3' })[0].id;
    // dựng nhanh: hai bản ghi dung lượng do hai Tech nhập
    for (const [code, by] of [['SD01', U.t1.id], ['SD02', U.t2.id]]) h.store.card_records.insert({ card_id: card(code).id, code, site_id: sid, kit_id: null, handover_id: null, shoot_date: '2026-10-04', gb: 33.8, hours: 2, zero_reason: null, photos: null, by_id: by, at: h.clock.now(), edited_by: null, edited_at: null });
    const recs = async (who, q) => (await go(who, 'GET', '/api/hub/cards/records', null, q));
    const l = await recs('l1');
    ok(l.total === 2 && l.records.every((r) => !r.by), 'Logistics xem dung lượng: không kèm người nhập');
    eq((await recs('ll', { by: U.t1.id })).total, 2, 'Logistics lọc theo người nhập: bị bỏ qua');
    const cd = await go('l1', 'GET', `/api/hub/cards/${card('SD02').id}`);
    ok(cd.records.length === 1 && !cd.records[0].by, 'chi tiết thẻ cho Logistics: không kèm người nhập');
    const t = await recs('t1');
    eq(t.records.map((r) => (r.by ? r.by.id : null)).sort(), [U.t1.id, null].sort(), 'Tech Executive chỉ thấy tên mình ở bản ghi của mình');
    eq((await recs('t1', { by: U.t1.id })).total, 1, 'Tech Executive lọc "chỉ của tôi" được');
    eq(await st('t1', 'GET', '/api/hub/cards/records', null, { by: U.t2.id }), 403, 'Tech Executive không lọc theo người khác');
    eq((await recs('tl', { by: U.t2.id })).records.map((r) => r.by.id), [U.t2.id], 'Tech Lead lọc theo từng người');
    const csv = async (who) => (await call(who, 'GET', '/api/hub/export/records.csv', null, { from: '2026-10-01', to: '2026-10-05' })).body.__csv.text;
    ok(!(await csv('ll')).includes('Người nhập') && !(await csv('ll')).includes('Tech Hai'), 'CSV dung lượng cho Logistic Lead: không có cột người nhập');
    ok(!(await csv('sh')).includes('Người nhập') && !(await csv('sh')).includes('Tech Một'), 'CSV dung lượng cho Head of Sale: không có cột người nhập');
    const tlCsv = await csv('tl');
    ok(tlCsv.includes('Người nhập') && tlCsv.includes('Tech Một') && tlCsv.includes('Tech Hai'), 'CSV cho Tech Lead: có người nhập');
    const t1Csv = await csv('t1');
    ok(t1Csv.includes('Tech Một') && !t1Csv.includes('Tech Hai'), 'CSV cho Tech Executive: chỉ tên mình');
  });

  await group('Nhật ký: Lead chỉ xem phần của team mình; Head of Sale không thấy mã người của FO', async () => {
    const { h, U, go, call, st } = await world(kind);
    const lj = (await go('ll', 'POST', '/api/hub/jobs', { title: 'Sắp xếp kệ', assignee_id: U.l1.id })).job;
    await go('l1', 'POST', `/api/hub/jobs/${lj.id}/done`, { result: { note: 'Xong' } });
    const tj = (await go('tl', 'POST', '/api/hub/jobs', { title: 'Vệ sinh ống kính', assignee_id: U.t1.id })).job;
    await go('t1', 'POST', `/api/hub/jobs/${tj.id}/done`, { result: { note: 'Xong' } });
    await go('ll', 'PATCH', `/api/hub/attendance/${U.l2.id}/2026-10-05`, { status: 'absent', reason: 'Nghỉ không phép' });
    const req = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-07', outlet: Q3 })).request;
    h.core.hub.log('request', req.id, 'status', 'Yêu cầu đã giao xong tại BO.', h.byName('fo1')); // dựng nhanh: FO đóng bước qua chuyến
    h.core.hub.log('card', null, 'upload', 'Tech Một nhập dung lượng 2 thẻ, tổng 67.6 GB.', h.byName('t1')); // dựng nhanh: Tech nhập dung lượng
    const items = async (who, q) => (await go(who, 'GET', '/api/hub/log', null, { limit: 1000, ...(q || {}) })).items;
    const tl = await items('tl');
    ok(!tl.some((l) => l.entity === 'job' && l.entity_id === lj.id), 'Tech Lead không thấy nhật ký việc của Logistics');
    ok(tl.some((l) => l.entity === 'job' && l.entity_id === tj.id), 'Tech Lead thấy nhật ký việc của Tech');
    ok(!tl.some((l) => l.entity === 'attendance'), 'Tech Lead không thấy chấm công của Logistics');
    ok(tl.every((l) => !l.actor_id || ['tech_lead', 'tech', 'admin'].includes(h.store.users.get(l.actor_id).role)), 'Tech Lead chỉ nhận mã người của team mình');
    eq(await st('tl', 'GET', '/api/hub/log', null, { actor: U.l1.id }), 403, 'Tech Lead không lọc theo người của Logistics');
    eq((await items('tl', { entity: 'job', id: lj.id })).length, 0, 'Tech Lead mở nhật ký một việc của Logistics: trống');
    const ll = await items('ll');
    ok(!ll.some((l) => l.entity === 'job' && l.entity_id === tj.id) && ll.some((l) => l.entity === 'attendance'), 'Logistic Lead: không thấy việc của Tech, thấy chấm công của team mình');
    eq(await st('ll', 'GET', '/api/hub/log', null, { actor: U.t1.id }), 403, 'Logistic Lead không lọc theo người của Tech');
    ok(!ll.some((l) => l.entity === 'card' && l.action === 'upload') && tl.some((l) => l.entity === 'card' && l.action === 'upload'), 'nhập dung lượng (khối lượng của Tech): chỉ Tech Lead thấy');
    eq(await st('ll', 'GET', '/api/hub/log', null, { actor: U.fo1.id }), 200, 'Logistic Lead lọc theo FO của team mình');
    ok((await items('ad', { actor: U.l1.id })).length > 0, 'Quản trị lọc theo mọi người');
    const sh = await items('sh');
    const foRow = sh.find((l) => l.entity === 'request' && l.entity_id === req.id && l.action === 'status');
    ok(foRow && foRow.actor_id === null && foRow.actor === 'FO', 'Head of Sale: dòng do FO làm chỉ ghi vai FO, không kèm mã người');
    ok(!sh.some((l) => l.actor_id === U.fo1.id), 'Head of Sale không nhận mã người của FO ở dòng nào');
    eq(await st('sh', 'GET', '/api/hub/log', null, { actor: U.fo1.id }), 403, 'Head of Sale không lọc theo FO');
    const rq = await go('s1', 'GET', `/api/hub/requests/${req.id}`);
    ok(rq.log.length && !rq.log.some((l) => l.actor_id === U.fo1.id), 'Sale xem yêu cầu: nhật ký không kèm mã người của FO');
    const r = await call('sh', 'GET', '/api/hub/log', null, { actor: U.s1.id });
    ok(r.status === 200 && r.body.items.every((l) => l.actor_id === U.s1.id), 'Head of Sale lọc theo Sale Lead của mình');
  });

  await group('Kho: Logistics không xoá cờ hỏng; không đổi mã kit đang ở ngoài; tổng phụ kiện chỉ Logistics', async () => {
    const { h, go, st, dev, kit } = await world(kind);
    const td = (await go('l1', 'POST', '/api/hub/outlets', TD)).outlet;
    await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: 'MC01 MC02 MC03' });
    h.store.devices.update(dev('MC01').id, { cond: 'faulty' }); // dựng nhanh: thiết bị Tech đã ghi hỏng
    h.store.devices.update(dev('MC03').id, { cond: 'repairing' });
    eq(await st('l1', 'PATCH', `/api/hub/devices/${dev('MC01').id}`, { cond: 'ok' }), 403, 'Logistic Executive không chuyển thiết bị hỏng về Tốt');
    eq(await st('ll', 'PATCH', `/api/hub/devices/${dev('MC03').id}`, { cond: 'ok' }), 403, 'Logistic Lead không chuyển thiết bị đang sửa về Tốt');
    eq([dev('MC01').cond, dev('MC03').cond], ['faulty', 'repairing'], 'tình trạng giữ nguyên');
    eq(await st('l1', 'PATCH', `/api/hub/devices/${dev('MC01').id}`, { note: 'Để ở kệ 2' }), 200, 'Logistics vẫn sửa ghi chú thiết bị hỏng');
    eq(await st('t1', 'PATCH', `/api/hub/devices/${dev('MC01').id}`, { cond: 'ok' }), 200, 'Tech xác nhận thiết bị đã tốt');
    eq(dev('MC01').cond, 'ok', 'Tech chuyển về Tốt');
    const k = (await go('l1', 'POST', '/api/hub/kits', { code: 'K01', kind: 'multicam', devices: 'MC02' })).kit;
    h.store.kits.update(k.id, { status: 'at_bo', site_id: td.id }); // dựng nhanh: kit đang quay tại BO
    eq(await st('t1', 'PATCH', `/api/hub/kits/${k.id}`, { code: 'HACKED-1' }), 409, 'Tech không đổi mã kit đang ở BO');
    eq(await st('ll', 'PATCH', `/api/hub/kits/${k.id}`, { code: 'K01-B' }), 409, 'Lead cũng không đổi mã kit đang ở ngoài');
    eq(kit('K01').id, k.id, 'mã kit giữ nguyên');
    eq(await st('t1', 'PATCH', `/api/hub/kits/${k.id}`, { note: 'Theo dõi pin' }), 200, 'vẫn sửa ghi chú kit đang ở BO');
    await go('l1', 'POST', '/api/hub/acc/hub_sac/move', { kind: 'in', qty: 8, reason: 'Tồn đầu kỳ' });
    eq(await st('tl', 'PATCH', '/api/hub/types/hub_sac', { total: 0, reason: 'Kiểm kê' }), 403, 'Tech Lead không đổi tổng phụ kiện');
    eq(h.store.dev_types.get('hub_sac').total, 8, 'tổng phụ kiện giữ nguyên');
    eq(await st('tl', 'PATCH', '/api/hub/types/hub_sac', { name: 'Hub sạc 4 cổng' }), 200, 'Tech Lead vẫn đổi tên loại');
    eq(await st('tl', 'POST', '/api/hub/types', { name: 'Dây sạc mới', kind: 'acc', total: 10 }), 403, 'Tech Lead thêm loại phụ kiện kèm số lượng → 403');
    eq(await st('tl', 'POST', '/api/hub/types', { name: 'Dây sạc mới', kind: 'acc' }), 200, 'Tech Lead thêm loại không kèm số lượng');
    await go('ll', 'PATCH', '/api/hub/types/hub_sac', { total: 6, reason: 'Kiểm kê cuối tuần' });
    eq(h.store.dev_types.get('hub_sac').total, 6, 'Logistic Lead đổi tổng phụ kiện (ghi sổ kho)');
  });

  await group('Nhập dữ liệu: dung lượng thẻ và sự cố chỉ Quản trị / Tech Lead; thẻ lạ vào Đối chiếu của Tech', async () => {
    const { h, go, call } = await world(kind);
    await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-07', outlet: Q3 });
    await go('ll', 'POST', '/api/hub/devices', { type: 'sd', codes: 'SD01' });
    const data = buildXlsx([
      { name: 'Dung lượng', rows: [['Mã thẻ', 'BO', 'Ngày quay', 'GB'], ['FAKE01', 'BO Quận 3', { date: '2026-10-01' }, 676], ['FAKE01', 'BO Quận 3', { date: '2026-10-02' }, 676], ['SD01', 'BO Quận 3', { date: '2026-10-02' }, 33.8]] },
      { name: 'Sự cố', rows: [['Ngày', 'BO', 'Nhãn lỗi', 'Trạng thái'], [{ date: '2026-09-20' }, 'BO Quận 3', 'Quá nhiệt', 'Đã xử lý']] },
    ]).toString('base64');
    const parsed = await go('ll', 'POST', '/api/hub/import/parse', { data, name: 'du-lieu.xlsx' });
    const plan = (p, only) => p.sheets.filter((s) => !only || s.guess.target === only).map((s) => ({ sheet: s.index, target: s.guess.target, header_row: s.header_row, mapping: s.guess.mapping }));
    for (const t of ['records', 'incidents']) {
      const r = await call('ll', 'POST', '/api/hub/import/run', { token: parsed.token, plan: plan(parsed, t), commit: true });
      eq(r.status, 403, `Logistic Lead nhập ${t === 'records' ? 'dung lượng thẻ' : 'sự cố'} → 403`);
    }
    eq([h.store.card_records.count({}), h.store.incidents.count({})], [0, 0], 'không ghi gì');
    const p2 = await go('tl', 'POST', '/api/hub/import/parse', { data, name: 'du-lieu.xlsx' });
    const real = await go('tl', 'POST', '/api/hub/import/run', { token: p2.token, plan: plan(p2), commit: true });
    const rep = real.report.find((r) => r.target === 'records');
    eq([rep.created, h.store.card_records.count({ code: 'FAKE01' }), h.store.card_records.count({ code: 'SD01' }), h.store.card_records.count({ code: 'FAKE01', card_id: null })], [3, 2, 1, 2], 'lịch sử giờ quay giữ nguyên (không tự tạo thẻ, không tự sửa mã)');
    const rc = h.store.recon.find({ source: 'import', entity: 'record' });
    ok(rc.length === 1 && rc[0].team === 'tech' && rc[0].ref.startsWith('imp:cardcode:FAKE01') && rc[0].text.includes('FAKE01') && rc[0].text.includes('2 dòng') && !rc[0].text.includes('SD01'), 'thẻ không có trong kho → một dòng Đối chiếu cho Tech, gộp các dòng của thẻ');
    // Nhập lại cùng file: không thêm dòng Đối chiếu trùng
    const p3 = await go('tl', 'POST', '/api/hub/import/parse', { data, name: 'du-lieu.xlsx' });
    await go('tl', 'POST', '/api/hub/import/run', { token: p3.token, plan: plan(p3, 'records'), commit: true });
    eq(h.store.recon.count({ source: 'import', entity: 'record' }), 1, 'nhập lại cùng file: không thêm dòng Đối chiếu trùng');
    eq(h.store.incidents.count({}), 1, 'Tech Lead nhập được sự cố');
    // Tổng phụ kiện là sổ kho của Logistics: Tech Lead không nhập qua file
    const acc = buildXlsx([{ name: 'Phụ kiện', rows: [['Tên phụ kiện', 'Tổng số lượng'], ['Hub sạc', 0]] }]).toString('base64');
    const pa = await go('tl', 'POST', '/api/hub/import/parse', { data: acc, name: 'phu-kien.xlsx' });
    const r3 = await call('tl', 'POST', '/api/hub/import/run', { token: pa.token, plan: plan(pa, 'acc'), commit: true });
    eq(r3.status, 403, 'Tech Lead nhập tồn phụ kiện → 403');
    const pb = await go('ll', 'POST', '/api/hub/import/parse', { data: acc, name: 'phu-kien.xlsx' });
    eq((await call('ll', 'POST', '/api/hub/import/run', { token: pb.token, plan: plan(pb, 'acc'), commit: false })).status, 200, 'Logistic Lead nhập tồn phụ kiện được');
  });

  await group('Đối chiếu từ file nhập: mã (kể cả toàn số) không bị đọc thành số thứ tự', async () => {
    const { h, go } = await world(kind);
    // Liên kết của màn Đối chiếu: đọc đúng biểu thức trong public/js/views/recon.js.
    const src = fs.readFileSync(path.join(ROOT, 'public/js/views/recon.js'), 'utf8');
    const RE = {};
    for (const m of src.matchAll(/r\.entity === '(\w+)'\) \{ const id = pick\((\/.+?\/)\)/g)) RE[m[1]] = new Function(`return ${m[2]}`)();
    ok(RE.kit && RE.card && RE.outlet, 'đọc được biểu thức liên kết kit, thẻ, BO của màn Đối chiếu');
    const linkId = (r) => { const re = RE[r.entity]; const m = re ? re.exec(String(r.ref || '')) : null; return m ? m[1] : null; };
    await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: 'MC01' });
    const k1 = (await go('l1', 'POST', '/api/hub/kits', { code: 'K01', kind: 'multicam', devices: 'MC01' })).kit;
    const data = buildXlsx([
      { name: 'Danh sách BO', rows: [['Mã BO', 'Tên BO', 'SĐT', 'Sale phụ trách'], ['', '0003', '0900000003', 'Người Lạ']] },
      { name: 'Kit', rows: [['Mã kit', 'Loại kit', 'Trạng thái', 'BO'], ['0001', 'Multicam KIT', 'Tại BO', 'BO Không Có'], ['K01', 'Multicam KIT', 'Sẵn sàng', '']] },
      { name: 'Thẻ nhớ', rows: [['Mã thẻ', 'Trạng thái', 'BO'], ['0002', 'Tại BO', 'BO Không Có'], ['0004', 'Tại BO', '']] },
    ]).toString('base64');
    const p = await go('tl', 'POST', '/api/hub/import/parse', { data, name: 'ma-so.xlsx' });
    await go('tl', 'POST', '/api/hub/import/run', { token: p.token, plan: p.sheets.map((s) => ({ sheet: s.index, target: s.guess.target, header_row: s.header_row, mapping: s.guess.mapping })), commit: true });
    const rows = h.store.recon.find({ source: 'import' });
    const byCode = rows.filter((r) => /(kitcode|cardcode|boname):/.test(r.ref));
    ok(byCode.some((r) => r.entity === 'kit') && byCode.some((r) => r.entity === 'card') && byCode.some((r) => r.entity === 'outlet'), 'dòng theo mã kit, mã thẻ, tên BO dùng tiền tố riêng');
    eq(byCode.map(linkId).filter(Boolean), [], 'không dòng nào theo mã / tên bị đọc thành số thứ tự để mở nhầm kit, thẻ, BO');
    const st = rows.find((r) => r.entity === 'kit' && r.ref === `imp:kit:${k1.id}:status`);
    ok(st && linkId(st) === String(k1.id), 'dòng theo số thứ tự thật (kit đã có) vẫn mở đúng kit');
  });

  await group('Đối chiếu cũ (ghi trước bản này): mã tham chiếu theo mã / tên được đổi sang tiền tố riêng khi khởi động', async () => {
    const { h, go } = await world(kind);
    await go('ll', 'POST', '/api/hub/devices', { type: 'multicam', codes: 'MC01 MC02' });
    const k1 = (await go('ll', 'POST', '/api/hub/kits', { code: 'K01', kind: 'multicam', devices: 'MC01' })).kit;
    const d2 = h.store.devices.find({ code: 'MC02' })[0];
    const t = h.clock.now();
    const old = (ref, entity, level, team = 'logistics') => h.store.recon.insert({ ts: t, source: 'import', team, level, entity, ref, text: `[Nhập cũ] ${ref}`, data: null, status: 'open', resolved_by: null, resolved_at: null, note: '' });
    // Dòng theo mã (bản cũ ghi chung tiền tố với dòng theo số thứ tự)
    const a = old('imp:card:0002:site', 'card', 'mid'), b = old('imp:card:0004:nosite', 'card', 'mid'), c = old('imp:kit:0001:nosite', 'kit', 'high');
    const d = old('imp:dev:9999:unknown', 'device', 'mid'), e = old('imp:dev:XY1:cond', 'device', 'low', 'tech'), f = old('imp:bo:0003:0900000003', 'outlet', 'high', 'sale'), g = old('imp:bo:ben thanh:sale', 'outlet', 'mid', 'sale');
    // Dòng theo số thứ tự thật: giữ nguyên
    const x = old(`imp:kit:${k1.id}:status`, 'kit', 'mid'), y = old(`imp:dev:${d2.id}:cond`, 'device', 'mid', 'tech'), z = old('imp:bo:7:miss', 'outlet', 'mid');
    mk(kind, { store: h.store, t }); // khởi động lại trên cùng dữ liệu
    const ref = (id) => h.store.recon.get(id).ref;
    eq([a, b, c, d, e, f, g].map(ref), ['imp:cardcode:0002:site', 'imp:cardcode:0004:nosite', 'imp:kitcode:0001:nosite', 'imp:devcode:9999:unknown', 'imp:devcode:XY1:cond', 'imp:boname:0003:0900000003', 'imp:boname:ben thanh:sale'], 'dòng theo mã / tên: đổi sang tiền tố riêng');
    eq([x, y, z].map(ref), [`imp:kit:${k1.id}:status`, `imp:dev:${d2.id}:cond`, 'imp:bo:7:miss'], 'dòng theo số thứ tự: giữ nguyên');
    const lg = h.store.hub_log.find({ entity: 'recon', action: 'migrate' });
    ok(lg.length === 1 && lg[0].text.includes('7'), 'nhật ký ghi một lần đổi, kèm số dòng');
    mk(kind, { store: h.store, t });
    eq(h.store.hub_log.count({ entity: 'recon', action: 'migrate' }), 1, 'khởi động lần nữa: không đổi lại, không ghi thêm nhật ký');
    // Nhập lại cùng thẻ sau khi nâng cấp: không thêm dòng Đối chiếu trùng
    const data = buildXlsx([{ name: 'Thẻ nhớ', rows: [['Mã thẻ', 'Trạng thái', 'BO'], ['0002', 'Tại BO', 'BO Không Có']] }]).toString('base64');
    const p = await go('ll', 'POST', '/api/hub/import/parse', { data, name: 'the.xlsx' });
    await go('ll', 'POST', '/api/hub/import/run', { token: p.token, plan: p.sheets.map((s) => ({ sheet: s.index, target: s.guess.target, header_row: s.header_row, mapping: s.guess.mapping })), commit: true });
    eq(h.store.recon.find({ status: 'open' }).filter((r) => /:0002:site$/.test(r.ref)).map((r) => r.ref), ['imp:cardcode:0002:site'], 'nhập lại cùng thẻ: vẫn một dòng Đối chiếu');
  });

  await group('Nhập danh sách BO: không điền ngày launch / kết thúc của BO đã có; Logistic Lead không điền số của Sale', async () => {
    const { h, U, go, site } = await world(kind);
    const td = (await go('ll', 'POST', '/api/hub/outlets', TD)).outlet;
    h.store.sites.update(td.id, { ops_status: 'live', launch_date: null, end_date: null }); // dựng nhanh: BO đang ghi hình, chưa ghi ngày
    const rows = [['Mã BO', 'Tên BO', 'Ngày launch', 'Ngày kết thúc', 'Quota giờ', 'Sale phụ trách', 'Ngành', 'Khu vực', 'Ghi chú'],
      ['TD', 'BO Thủ Đức', { date: '2026-09-01' }, { date: '2026-10-08' }, 99999, 'Sale Hai', 'Spa', 'Thủ Đức', 'Cổng sau'],
      ['NB', 'BO Nhập Mới', { date: '2026-09-15' }, '', 250, 'Sale Một', 'Cafe', 'Quận 1', '']];
    const data = buildXlsx([{ name: 'Danh sách BO', rows }]).toString('base64');
    const run = async (who) => {
      const p = await go(who, 'POST', '/api/hub/import/parse', { data, name: 'bo.xlsx' });
      return go(who, 'POST', '/api/hub/import/run', { token: p.token, plan: p.sheets.map((s) => ({ sheet: s.index, target: s.guess.target, header_row: s.header_row, mapping: s.guess.mapping })), commit: true });
    };
    await run('ll');
    const s = site('TD');
    eq([s.launch_date, s.end_date, s.quota_hours, s.sale_id, s.business, s.area, s.ops_status], [null, null, null, null, null, null, 'live'], 'BO đã có: Logistic Lead không đặt ngày kết thúc (BO vẫn ghi hình), không điền quota, Sale, ngành, khu vực');
    eq(s.note, 'Cổng sau', 'thông tin điểm (ghi chú) vẫn điền vào ô trống');
    const rc = (id, k) => h.store.recon.find({ source: 'import', ref: `imp:bo:${id}:${k}` })[0];
    for (const k of ['launch_date', 'end_date', 'quota_hours', 'sale_id', 'business', 'area']) {
      const r = rc(s.id, k);
      ok(r && r.team === 'sale' && r.status === 'open', `${k} trong file → Đối chiếu cho Sale (không tự điền)`);
    }
    ok(rc(s.id, 'end_date').text.includes('Kết thúc ghi hình') && rc(s.id, 'sale_id').text.includes('Sale Hai'), 'Đối chiếu nói rõ đi luồng nào, kèm giá trị trong file');
    const nb = site('NB');
    eq([nb.quota_hours, nb.sale_id, nb.launch_date], [null, U.s1.id, '2026-09-15'], 'BO mới: Logistic Lead không đặt quota (như khi thêm BO tay); Sale và ngày launch nhập theo file');
    ok(rc(nb.id, 'quota_hours') && rc(nb.id, 'quota_hours').team === 'sale', 'quota của BO mới → Đối chiếu cho Sale');
    // Tech Lead (kiêm quản trị hệ thống, người chuyển dữ liệu) điền được số của Sale; ngày của BO đã có vẫn đi luồng riêng
    await run('tl');
    eq([site('TD').quota_hours, site('TD').sale_id, site('TD').business, site('TD').area, site('TD').end_date, site('TD').launch_date, site('NB').quota_hours], [99999, U.s2.id, 'Spa', 'Thủ Đức', null, null, 250], 'Tech Lead nhập: điền quota, Sale, ngành, khu vực; ngày launch / kết thúc của BO đã có vẫn không điền');
  });

  await group('Việc Logistic Executive chuyển cho FO: không kèm điểm, trễ hạn của FO', async () => {
    const { h, U, go } = await world(kind);
    const t = h.clock.now();
    const j = h.store.jobs.insert({ code: 'V-FO1', type: 'card_swap', team: 'logistics', title: 'Đổi thẻ BO Quận 3', status: 'done', assignee_id: U.l1.id, done_by: U.fo1.id, std_min: 10, due_at: t - 2000, done_at: t - 1000, created_at: t - 3600000 }); // dựng nhanh: FO trong chuyến đã đổi thẻ
    const own = h.store.jobs.insert({ code: 'V-L1', type: 'manual', team: 'logistics', title: 'Việc tự làm', status: 'done', assignee_id: U.l1.id, done_by: U.l1.id, std_min: 30, due_at: t - 2000, done_at: t - 1000, created_at: t - 3600000 });
    for (const view of ['mine', 'team']) {
      const r = await go('l1', 'GET', '/api/hub/jobs', null, { view, status: 'all' });
      const a = r.jobs.find((x) => x.id === j), b = r.jobs.find((x) => x.id === own);
      ok(a && a.points === null && a.late === null, `Logistic Executive (${view}): việc FO làm không kèm điểm, trễ hạn`);
      ok(b && b.points === 5 && b.late === true, `Logistic Executive (${view}): việc mình làm vẫn đủ điểm`);
    }
    const det = await go('l1', 'GET', `/api/hub/jobs/${j}`);
    eq([det.job.points, det.job.late], [null, null], 'chi tiết việc: không kèm điểm, trễ hạn của FO');
    const ld = (await go('ll', 'GET', '/api/hub/jobs', null, { view: 'team', status: 'all' })).jobs.find((x) => x.id === j);
    eq([ld.points, ld.late, ld.done_by.id], [1.67, true, U.fo1.id], 'Logistic Lead thấy đủ');
  });

  await group('Dữ liệu mẫu: BO thêm ở Rider Live ghi nhật ký ở đầu lịch sử, không nằm trên các thao tác sau', async () => {
    const END = Date.parse('2026-10-08T09:00:00Z');
    const h = mk(kind, { t: END, cfg: { demo: true } });
    await seedDemo(h.core);
    await seedHubDemo(h.core, { setNow: (t) => h.clock.set(t ?? END), scale: 0.25, weeks: 3 });
    const made = h.store.hub_log.find({ entity: 'outlet', action: 'create' }).filter((r) => r.text.includes('ở Rider Live'));
    ok(made.length > 0, 'có nhật ký thêm BO ở Rider Live');
    const late = made.filter((r) => h.store.hub_log.find({ entity: 'outlet', entity_id: r.entity_id }).some((x) => x.id !== r.id && x.ts < r.ts));
    eq(late.length, 0, 'nhật ký thêm BO đứng trước mọi thao tác khác trên BO đó');
    const top = (await h.call('salehead', 'GET', '/api/hub/log', null, { limit: 10 })).body.items;
    ok(top.length && !top.some((x) => x.entity === 'outlet' && x.action === 'create' && x.text.includes('ở Rider Live')), 'Nhật ký của Head of Sale: đầu trang là thao tác mới nhất, không phải dòng thêm BO lúc tạo dữ liệu mẫu');
  });
}

// ───────── WebSocket: chưa đổi mật khẩu thì không nhận dữ liệu (cùng chốt chặn với HTTP) ─────────
let portSeq = 19300 + Math.floor(Math.random() * 600);
function startServer(dataDir, env = {}) {
  const port = ++portSeq;
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, TILE_URL: '', DEMO: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const ready = new Promise((resolve, reject) => {
    const t = setInterval(() => { if (out.includes('[http]')) { clearInterval(t); resolve(); } }, 30);
    proc.on('exit', (c) => { clearInterval(t); reject(new Error('máy chủ thoát sớm, mã ' + c + '\n' + out)); });
    setTimeout(() => { clearInterval(t); reject(new Error('máy chủ không khởi động kịp\n' + out)); }, 15000);
  });
  const stop = () => new Promise((resolve) => { if (proc.exitCode !== null) return resolve(proc.exitCode); proc.on('exit', (c) => resolve(c)); proc.kill('SIGTERM'); });
  return { port, base: `http://127.0.0.1:${port}`, ready, stop };
}
function client(base) {
  let cookie = '';
  return {
    async req(method, p, body) {
      const headers = {};
      if (cookie) headers.Cookie = cookie;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = r.headers.get('set-cookie');
      if (set) { const m = /arl_sid=([^;]*)/.exec(set); if (m) cookie = /Max-Age=0/.test(set) ? '' : `arl_sid=${m[1]}`; }
      let json = null;
      try { json = await r.json(); } catch { /* không phải JSON */ }
      return { status: r.status, json };
    },
    ws() {
      return new Promise((resolve) => {
        const msgs = [];
        const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: cookie ? { Cookie: cookie } : {} });
        const done = (o) => { setTimeout(() => { try { ws.close(); } catch { /* đã đóng */ } resolve({ msgs, ...o }); }, 400); };
        ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
        ws.on('open', () => done({ opened: true }));
        ws.on('unexpected-response', (_rq, res) => resolve({ msgs, opened: false, status: res.statusCode }));
        ws.on('error', () => resolve({ msgs, opened: false, status: 0 }));
      });
    },
  };
}

for (const kind of ['memory', 'sqlite']) await suite(kind);

await group('WebSocket: tài khoản chưa đổi mật khẩu tạm không nhận bản đồ FO', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-fixacc-'));
  const S = startServer(dir, { LEAD_PASS: 'Khoitao-12345' });
  try {
    await S.ready;
    const admin = client(S.base);
    eq((await admin.req('POST', '/api/login', { username: 'admin', password: 'Khoitao-12345' })).status, 200, 'Quản trị đăng nhập bằng mật khẩu tạm');
    const w0 = await admin.ws();
    ok(!w0.opened && w0.status === 403 && !w0.msgs.some((m) => m.t === 'snapshot'), 'chưa đổi mật khẩu: WebSocket bị từ chối, không có bản đồ FO');
    eq((await admin.req('POST', '/api/password', { old: 'Khoitao-12345', new: 'Matkhau-quantri-moi' })).status, 200, 'đổi mật khẩu');
    const w1 = await admin.ws();
    ok(w1.opened && w1.msgs.some((m) => m.t === 'hello') && w1.msgs.some((m) => m.t === 'snapshot'), 'đổi xong: WebSocket mở, nhận bản đồ như trước');
    const made = await admin.req('POST', '/api/users', { username: 'log9', name: 'Log Chín', role: 'logistic' });
    const lg = client(S.base);
    eq((await lg.req('POST', '/api/login', { username: 'log9', password: made.json.tempPassword })).status, 200, 'Logistic Executive mới đăng nhập bằng mật khẩu tạm');
    eq((await lg.req('GET', '/api/live')).status, 403, 'HTTP /api/live: chặn khi chưa đổi mật khẩu');
    const w2 = await lg.ws();
    ok(!w2.opened && w2.status === 403 && !w2.msgs.length, 'WebSocket cũng chặn: không nhận gói nào');
  } finally { await S.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

summary('Phân quyền giữa các team (fix.access)');
