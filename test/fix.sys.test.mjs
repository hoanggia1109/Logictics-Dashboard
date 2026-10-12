// fix.sys.test.mjs — kiểm hồi quy cho cụm lỗi hệ thống: thông báo chỉ gửi sau khi ghi xong, hạn cuối ngày, mã không nhảy số,
// launch gấp không sinh việc quá hạn, chống gửi lặp (BO mới trùng tên, khoá gửi của hộp thoại), hiệu năng bảng tổng quan,
// và đường dẫn trên dashboard / thông báo mở đúng màn hình với đúng bộ lọc.
// Mỗi nhóm chạy 2 lần: kho bộ nhớ (bản xem thử) và kho SQLite (máy chủ).
import fs from 'node:fs';
import vm from 'node:vm';
import { mk, ok, eq, group, summary, JPEG } from './harness.mjs';
import { SCHEMA } from '../core/schema.js';
import { HUB_DEFAULTS, HUB_OWNER, HUB_LABEL } from '../core/hub/defs.js';

const MIN = 60000, HOUR = 60 * MIN;
const VN = (date, hm, s = '00') => Date.parse(`${date}T${hm}:${s}+07:00`);
const ROOT = new URL('..', import.meta.url).pathname;
const src = (p) => fs.readFileSync(ROOT + p, 'utf8');

async function world(kind, at = VN('2026-10-08', '10:00')) {
  const h = mk(kind);
  h.clock.set(at);
  const people = [['ad', 'admin'], ['tl', 'tech_lead'], ['t1', 'tech'], ['ll', 'lead'], ['l1', 'logistic'], ['l2', 'logistic'], ['sh', 'sale_head'], ['s1', 'sale'], ['s2', 'sale']];
  const U = {};
  for (const [u, role] of people) U[u] = await h.user(u, role, { name: 'Người ' + u });
  const go = async (who, method, path, body, query) => {
    const r = await h.call(who, method, path, body, query);
    if (r.status !== 200) throw new Error(`${who} ${method} ${path} → ${r.status} ${r.body.error}: ${r.body.message}`);
    return r.body;
  };
  const H = h.core.hub;
  /** BO đang ghi hình của s1, có một kit tại BO (dựng thẳng trong kho để thử các luồng hỗ trợ). */
  async function liveBo(name = 'BO Hoa Mai', code = 'HM') {
    const o = (await go('ll', 'POST', '/api/hub/outlets', { name, code, address: '1 Lê Lợi' })).outlet;
    h.store.sites.update(o.id, { ops_status: 'live', sale_id: U.s1.id, onboard_date: '2026-09-01', launch_date: '2026-09-01' });
    const k = (await go('l1', 'POST', '/api/hub/kits', { code: 'K-' + code, kind: 'multicam' })).kit;
    h.store.kits.update(k.id, { status: 'at_bo', site_id: o.id });
    return { site: h.store.sites.get(o.id), kit: h.store.kits.get(k.id) };
  }
  return { h, U, go, H, liveBo };
}

/** Đếm số lần đọc một bảng (và số dòng đọc ra) trong lúc chạy fn. */
async function countFind(store, table, fn) {
  const t = store[table], orig = t.find;
  const calls = [];
  t.find = function (where, opt) { const r = orig.call(this, where, opt); calls.push({ where: where || {}, opt: opt || {}, rows: r }); return r; };
  try { await fn(); } finally { t.find = orig; }
  return calls;
}

async function suite(kind) {
  console.log(`\n── Kho ${kind === 'sqlite' ? 'SQLite' : 'bộ nhớ'} ──`);

  await group('notify-before-commit: việc sau ghi chỉ chạy khi giao dịch ngoài cùng ghi xong', async () => {
    const { h } = await world(kind);
    const seen = [];
    h.store.afterCommit(() => seen.push('ngoài giao dịch'));
    eq(seen, ['ngoài giao dịch'], 'ngoài giao dịch: chạy ngay');
    seen.length = 0;
    h.store.tx(() => {
      h.store.afterCommit(() => seen.push('ngoài'));
      try {
        h.store.tx(() => {
          h.store.afterCommit(() => seen.push('trong'));
          h.store.onRollback(() => seen.push('hoàn tác trong'));
          throw new Error('lỗi trong');
        });
      } catch { /* phần trong hoàn tác */ }
      h.store.tx(() => h.store.afterCommit(() => seen.push('trong ghi xong')));
      eq(seen, ['hoàn tác trong'], 'chưa ghi xong thì chưa gửi gì; phần lồng hoàn tác chạy việc hoàn tác của nó');
    });
    eq(seen, ['hoàn tác trong', 'ngoài', 'trong ghi xong'], 'ghi xong: chạy việc của giao dịch ngoài và phần lồng đã ghi; bỏ phần lồng đã hoàn tác');
    seen.length = 0;
    try { h.store.tx(() => { h.store.afterCommit(() => seen.push('x')); h.store.onRollback(() => seen.push('hoàn tác')); throw new Error('lỗi'); }); } catch { /* hoàn tác */ }
    eq(seen, ['hoàn tác'], 'giao dịch hoàn tác: bỏ việc sau ghi, chạy việc hoàn tác');
  });

  await group('notify-before-commit: giao việc hàng loạt bị hoàn tác thì không đẩy thông báo nào', async () => {
    const { h, U, go } = await world(kind);
    const a = (await go('ll', 'POST', '/api/hub/jobs', { title: 'Sắp xếp kệ A', assignee_id: U.l1.id })).job;
    const b = (await go('ll', 'POST', '/api/hub/jobs', { title: 'Sắp xếp kệ B', assignee_id: U.l1.id })).job;
    h.store.jobs.update(b.id, { status: 'done', done_at: h.clock.now(), done_by: U.l1.id });
    const msgs = [];
    const off = h.core.subscribe(h.byName('l2'), (m) => msgs.push(m));
    const inbox0 = h.store.inbox.count({ user_id: U.l2.id });
    const r = await h.call('ll', 'POST', '/api/hub/jobs/bulk-assign', { job_ids: [a.id, b.id], user_id: U.l2.id });
    eq(r.status, 409, 'có việc đã đóng trong danh sách → chặn cả lượt');
    eq(h.store.jobs.get(a.id).assignee_id, U.l1.id, 'việc mở vẫn của người cũ (hoàn tác)');
    eq(h.store.inbox.count({ user_id: U.l2.id }), inbox0, 'không có dòng hộp thư cho người nhận');
    eq(msgs.filter((m) => m.t === 'inbox').length, 0, 'không có thông báo đẩy tới màn hình người nhận');
    const r2 = await h.call('ll', 'POST', '/api/hub/jobs/bulk-assign', { job_ids: [a.id], user_id: U.l2.id });
    eq(r2.status, 200, 'lượt hợp lệ ghi được');
    const pushed = msgs.filter((m) => m.t === 'inbox');
    eq(pushed.length, 1, 'ghi xong thì người nhận được đẩy đúng một thông báo');
    ok(pushed[0] && h.store.inbox.get(pushed[0].item.id) && h.store.inbox.get(pushed[0].item.id).user_id === U.l2.id, 'thông báo đã đẩy có thật trong hộp thư của người nhận');
    off();
  });

  await group('notify-before-commit: Slack, cảnh báo điều phối và số thứ tự mã không rò ra khi hoàn tác', async () => {
    const { h, H } = await world(kind);
    const ops = [];
    const off = h.core.subscribe(h.byName('ll'), (m) => ops.push(m));
    const n0 = h.notes.length;
    try { h.store.tx(() => { H.notify({ roles: ['lead'] }, 'alert', 'test', 'Cảnh báo thử', ''); h.core.hub.K.event('test', 'alert', 'Sự kiện thử'); throw new Error('lỗi'); }); } catch { /* hoàn tác */ }
    eq(h.notes.length, n0, 'giao dịch hoàn tác: không gửi Slack');
    eq(ops.filter((m) => m.t === 'inbox' || m.t === 'alert').length, 0, 'giao dịch hoàn tác: không đẩy hộp thư hay cảnh báo');
    h.store.tx(() => { H.notify({ roles: ['lead'] }, 'alert', 'test', 'Cảnh báo thật', ''); });
    eq(h.notes.slice(n0), ['Cảnh báo thật'], 'ghi xong: gửi Slack đúng một lần');
    off();
    // Số thứ tự mã nằm trong cài đặt có bộ nhớ đệm: hoàn tác thì lần cấp sau dùng lại đúng số.
    try { h.store.tx(() => { eq(H.nextCode('ZZ-', 'requests', 3), 'ZZ-001', 'cấp mã trong giao dịch'); throw new Error('lỗi'); }); } catch { /* hoàn tác */ }
    eq(h.store.tx(() => H.nextCode('ZZ-', 'requests', 3)), 'ZZ-001', 'giao dịch hoàn tác: mã không bị nhảy số');
  });

  await group('eod-2359: hạn "cuối ngày" là hết ngày giờ Việt Nam', async () => {
    const { h, U, H } = await world(kind);
    const sc = h.store.tx(() => H.jobs.ensure({ type: 'stock_check', date: '2026-10-09', dedupe: 'stock:2026-10-09' }, null));
    eq(sc.due_at, VN('2026-10-10', '00:00') - 1, 'kiểm kho: hạn là mili-giây cuối của ngày');
    const site = h.store.sites.insert({ name: 'BO Không Khung', type: 'bo', active: 1, ops_status: 'live', swap_days: '5', swap_from: null, swap_to: null, created_at: h.clock.now() });
    const sw = h.store.tx(() => H.jobs.ensure({ type: 'card_swap', site_id: site, date: '2026-10-09', dedupe: 'swap:x' }, null));
    eq(sw.due_at, VN('2026-10-10', '00:00') - 1, 'đổi thẻ ở BO chưa có khung giờ: hạn cuối ngày như việc khác');
    h.store.jobs.update(sc.id, { status: 'done', done_at: VN('2026-10-09', '23:59', '30'), done_by: U.l1.id, assignee_id: U.l1.id });
    const j = (await h.call('ll', 'GET', `/api/hub/jobs/${sc.id}`)).body.job;
    eq(j.late, false, 'xong lúc 23:59:30 vẫn đúng hạn');
  });

  await group('code-seq-gaps: mã yêu cầu liền số khi gộp hoặc bị chặn', async () => {
    const { h, go, liveBo } = await world(kind);
    const { kit } = await liveBo('BO Gộp', 'GOP');
    await go('ll', 'POST', '/api/hub/acc/cap_c_c/move', { kind: 'in', qty: 20, reason: 'Tồn đầu kỳ' });
    const first = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-12', outlet: { name: 'BO Một', code: 'B1' } })).request;
    eq((await h.call('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-12', outlet: { name: 'BO Một', code: 'B1' } })).status, 409, 'mã BO đã có → chặn');
    const site = kit.site_id;
    const sup = (await go('s1', 'POST', `/api/hub/outlets/${site}/support`, { kind: 'extra_acc', acc: { cap_c_c: 1 }, kit_id: kit.id, note: 'Thêm dây' })).request;
    const mrg = await go('s1', 'POST', `/api/hub/outlets/${site}/support`, { kind: 'extra_acc', acc: { cap_c_c: 1 }, kit_id: kit.id, note: 'Thêm dây nữa' });
    eq([mrg.request.id, mrg.merged], [sup.id, true], 'lần hai gộp vào yêu cầu cũ');
    const next = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-12', outlet: { name: 'BO Hai', code: 'B2' } })).request;
    const n = (c) => +c.split('-').pop();
    eq([n(sup.code) - n(first.code), n(next.code) - n(sup.code)], [1, 1], `mã liền số (${first.code}, ${sup.code}, ${next.code}): lần bị chặn và lần gộp không lấy số`);
  });

  await group('same-day-launch-prep-overdue: launch gấp không sinh việc chuẩn bị đã quá hạn', async () => {
    eq([HUB_DEFAULTS.prepMinHours, HUB_OWNER.prepMinHours, !!HUB_LABEL.prepMinHours], [4, 'Logistics', true], 'ngưỡng mới có trong cấu hình, Logistics chốt');
    const { h, U, go } = await world(kind, VN('2026-10-08', '10:00'));
    await go('ll', 'PUT', '/api/hub/roster', { rows: [{ user_id: U.l1.id, date: '2026-10-08', shift: 'HC' }] });
    h.core.hub.K.hooks.onSeen(h.byName('l1'), h.clock.now());
    const t = h.clock.now();
    const r = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-08', outlet: { name: 'BO Khai Trương Gấp' } })).request;
    const prep = h.store.jobs.find({ type: 'prep_kit', request_id: r.id })[0];
    ok(prep.due_at >= prep.created_at, 'hạn không trước lúc tạo việc');
    eq([prep.due_at, prep.priority], [t + 4 * HOUR, 1], 'launch trong ngày: hạn = lúc tạo + 4 giờ, đánh dấu gấp');
    const alerts0 = h.store.inbox.count({ kind: 'lead_overdue' });
    h.clock.add(61000); h.core.tick(); h.clock.add(61000); h.core.tick();
    eq(h.store.inbox.count({ kind: 'lead_overdue' }), alerts0, 'không báo Lead quá hạn ngay sau khi tạo');
    eq((await go('l1', 'GET', `/api/hub/jobs/${prep.id}`)).job.overdue, false, 'việc không hiện quá hạn');
    // Gửi lúc 22:00 cho launch ngày mai: vẫn có đủ thời gian tối thiểu.
    h.clock.set(VN('2026-10-08', '22:00'));
    const r2 = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-09', outlet: { name: 'BO Buổi Tối' } })).request;
    const p2 = h.store.jobs.find({ type: 'prep_kit', request_id: r2.id })[0];
    eq([p2.due_at, p2.priority], [VN('2026-10-09', '02:00'), 1], 'launch sáng mai, gửi lúc 22:00: hạn 02:00, gấp');
    // Launch còn xa: giữ như cũ (24 giờ), không gấp.
    h.clock.set(VN('2026-10-08', '10:00'));
    const r3 = (await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-14', outlet: { name: 'BO Thong Thả' } })).request;
    const p3 = h.store.jobs.find({ type: 'prep_kit', request_id: r3.id })[0];
    eq([p3.due_at, p3.priority], [h.clock.now() + 24 * HOUR, 0], 'launch còn xa: hạn 24 giờ, không gấp');
    // Dời launch sớm lên hôm nay: việc chuẩn bị còn mở theo hạn mới nhưng vẫn giữ mức tối thiểu.
    h.clock.add(HOUR);
    await go('s1', 'PATCH', `/api/hub/requests/${r3.id}`, { launch_date: '2026-10-08' });
    const p3b = h.store.jobs.get(p3.id);
    eq([p3b.due_at, p3b.priority], [h.clock.now() + 4 * HOUR, 1], 'dời launch về hôm nay: hạn = bây giờ + 4 giờ, đánh dấu gấp');
    eq((await h.call('ll', 'PUT', '/api/hub/config', { prepMinHours: 30 })).status, 400, 'ngưỡng ngoài khoảng cho phép bị chặn');
    eq((await h.call('tl', 'PUT', '/api/hub/config', { prepMinHours: 6 })).status, 403, 'Tech Lead không sửa mục Logistics chốt');
  });

  await group('idem-launch-new-bo-dup: BO mới gửi hai lần không tạo hai BO', async () => {
    const { h, U, go } = await world(kind);
    const body = { need: { multicam: 1 }, launch_date: '2026-10-12', outlet: { name: 'BO Lê Văn Sỹ', address: '12 Lê Văn Sỹ' } };
    const first = (await go('s1', 'POST', '/api/hub/requests', body)).request;
    const count = () => [h.store.sites.count({ type: 'bo' }), h.store.requests.count({ kind: 'launch' }), h.store.jobs.count({ type: 'prep_kit' })];
    eq(count(), [1, 1, 1], 'lần đầu: 1 BO, 1 yêu cầu, 1 việc chuẩn bị');
    const r = await h.call('s1', 'POST', '/api/hub/requests', body);
    eq([r.status, r.body.error], [409, 'dup_request'], 'gửi lại: báo trùng');
    eq([r.body.request && r.body.request.id, r.body.site && r.body.site.id, r.body.confirm], [first.id, first.site.id, true], 'kèm yêu cầu và BO đã có để mở thẳng tới');
    eq((await h.call('s1', 'POST', '/api/hub/requests', { ...body, outlet: { name: '  lê văn   sỹ ', address: '12 lê văn sỹ' } })).status, 409, 'khác hoa thường, khoảng trắng, chữ "BO" vẫn nhận ra trùng');
    eq(count(), [1, 1, 1], 'không có BO, yêu cầu hay việc thừa');
    eq((await h.call('s1', 'POST', '/api/hub/requests', { ...body, outlet: { name: 'BO Lê Văn Sỹ', address: '99 Trần Hưng Đạo' } })).status, 200, 'cùng tên khác địa chỉ: BO khác');
    const ok2 = await h.call('s1', 'POST', '/api/hub/requests', { ...body, confirm_new: true });
    eq(ok2.status, 200, 'người gửi xác nhận là BO khác cùng tên → tạo được');
    eq(count(), [3, 3, 3], 'sau khi xác nhận: thêm đúng một BO');
    // Sale Lead khác không được biết BO của người khác.
    const other = await h.call('s2', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-12', outlet: { name: 'BO Riêng Của S1' } });
    eq(other.status, 200, 'chuẩn bị: BO của s2');
    await go('s1', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-12', outlet: { name: 'BO Bí Mật' } });
    const leak = await h.call('s2', 'POST', '/api/hub/requests', { need: { multicam: 1 }, launch_date: '2026-10-12', outlet: { name: 'BO Bí Mật' } });
    eq(leak.status, 200, 'Sale Lead khác cùng tên BO: không bị chặn bởi BO của người khác');
    ok(!JSON.stringify(leak.body).includes(String(U.s1.id)) || leak.body.request.sale.id === U.s2.id, 'không lộ BO hay yêu cầu của Sale khác');
    // Khoá gửi của hộp thoại: gửi lại sau khi mất phản hồi thì trả đúng yêu cầu cũ.
    const kb = { need: { multicam: 1 }, launch_date: '2026-10-13', outlet: { name: 'BO Mới Toanh' }, req_key: 'dlg-aaaa1111' };
    const k1 = (await go('s1', 'POST', '/api/hub/requests', kb)).request;
    const k2 = await go('s1', 'POST', '/api/hub/requests', kb);
    eq([k2.request.id, k2.replay], [k1.id, true], 'cùng khoá: trả yêu cầu đã tạo, không ghi thêm');
    eq(h.store.sites.count({ name: 'BO Mới Toanh' }), 1, 'chỉ một BO');
  });

  await group('idem-extra-acc-double: gửi lại hỗ trợ phụ kiện không cộng dồn lần nữa', async () => {
    const { h, go, liveBo } = await world(kind);
    const { site, kit } = await liveBo();
    await go('ll', 'POST', '/api/hub/acc/cap_c_c/move', { kind: 'in', qty: 20, reason: 'Tồn đầu kỳ' });
    const b = { kind: 'extra_acc', acc: { cap_c_c: 2 }, kit_id: kit.id, note: 'Dây bị đứt', req_key: 'sup-key-0001' };
    const a1 = await go('s1', 'POST', `/api/hub/outlets/${site.id}/support`, b);
    const a2 = await go('s1', 'POST', `/api/hub/outlets/${site.id}/support`, b);
    eq([a2.request.id, a2.replay], [a1.request.id, true], 'cùng khoá: trả yêu cầu cũ');
    eq(h.store.requests.get(a1.request.id).need.acc, { cap_c_c: 2 }, 'số phụ kiện không bị cộng đôi');
    eq(h.store.jobs.count({ type: 'deliver_acc' }), 1, 'một việc giao phụ kiện');
    const a3 = await go('s1', 'POST', `/api/hub/outlets/${site.id}/support`, { ...b, acc: { cap_c_c: 1 }, req_key: 'sup-key-0002' });
    eq([a3.request.id, a3.merged, h.store.requests.get(a1.request.id).need.acc], [a1.request.id, true, { cap_c_c: 3 }], 'lần gửi khác (khoá khác) vẫn gộp và cộng như thiết kế');
    await go('s1', 'POST', `/api/hub/outlets/${site.id}/support`, { ...b, acc: { cap_c_c: 1 }, req_key: 'sup-key-0002' });
    eq(h.store.requests.get(a1.request.id).need.acc, { cap_c_c: 3 }, 'gửi lại lần gộp: không cộng thêm');
  });

  await group('idem-acc-move-manual-jobs: gửi lại ghi sổ kho, việc giao tay, hỗ trợ khác không ghi hai lần', async () => {
    const { h, U, go, liveBo } = await world(kind);
    const total = () => h.store.dev_types.get('day_gan').total || 0;
    const t0 = total();
    const mv = { kind: 'in', qty: 10, reason: 'Mua thêm', req_key: 'acc-key-0001' };
    const m1 = await go('l1', 'POST', '/api/hub/acc/day_gan/move', mv);
    const m2 = await go('l1', 'POST', '/api/hub/acc/day_gan/move', mv);
    eq([total() - t0, h.store.acc_moves.count({ type_id: 'day_gan' }), m2.move_id, m2.replay], [10, 1, m1.move_id, true], 'cùng khoá: tổng chỉ +10, một dòng sổ kho, trả lần ghi cũ');
    await go('l2', 'POST', '/api/hub/acc/day_gan/move', mv);
    eq(total() - t0, 20, 'người khác dùng trùng khoá: là lần ghi riêng');
    await go('l1', 'POST', '/api/hub/acc/day_gan/move', { ...mv, req_key: 'acc-key-0002' });
    eq(total() - t0, 30, 'mở hộp thoại mới (khoá mới): ghi thêm như bình thường');
    eq((await h.call('l1', 'POST', '/api/hub/acc/hub_sac/move', mv)).body.replay, undefined, 'khoá cũ trên loại phụ kiện khác: không coi là gửi lại');
    const jb = { title: 'Dọn kho', assignee_id: U.l1.id, req_key: 'job-key-0001' };
    const j1 = await go('ll', 'POST', '/api/hub/jobs', jb);
    const j2 = await go('ll', 'POST', '/api/hub/jobs', jb);
    eq([j2.job.id, h.store.jobs.count({ title: 'Dọn kho' })], [j1.job.id, 1], 'việc giao tay: một việc');
    h.clock.add(11 * MIN);
    await go('ll', 'POST', '/api/hub/jobs', jb);
    eq(h.store.jobs.count({ title: 'Dọn kho' }), 2, 'quá 10 phút (replayMin, đề xuất): coi là lần gửi mới');
    const { site } = await liveBo();
    const sb = { kind: 'other', note: 'BO cần hỗ trợ dựng giá', req_key: 'oth-key-0001' };
    const s1 = await go('s1', 'POST', `/api/hub/outlets/${site.id}/support`, sb);
    await go('s1', 'POST', `/api/hub/outlets/${site.id}/support`, sb);
    eq([h.store.requests.count({ kind: 'support', site_id: site.id }), h.store.jobs.count({ type: 'manual', request_id: s1.request.id })], [1, 1], 'hỗ trợ khác: một yêu cầu, một việc');
    eq([HUB_DEFAULTS.replayMin, HUB_OWNER.replayMin], [10, 'Quản trị'], 'khung gửi lặp có trong cấu hình đề xuất');
  });

  await group('perf-incidents-n1: danh sách sự cố đọc việc xử lý một lượt, có chỉ mục', async () => {
    const jobsIx = SCHEMA.jobs.index.map((x) => x.join(','));
    ok(['incident_id,type', 'request_id', 'handover_id', 'task_id'].every((k) => jobsIx.includes(k)), 'jobs có chỉ mục theo sự cố, yêu cầu, phiếu, chuyến');
    const { h, go, H, liveBo } = await world(kind);
    const { site, kit } = await liveBo();
    const ids = [];
    for (const label of H.labels().multicam.slice(0, 4)) ids.push((await go('s1', 'POST', '/api/hub/incidents', { site_id: site.id, kit_id: kit.id, label, text: 'Mô tả ' + label, photos: [JPEG] })).incident.id);
    const calls = await countFind(h.store, 'jobs', async () => {
      const list = (await go('tl', 'GET', '/api/hub/incidents')).incidents;
      for (const i of list) {
        const latest = h.store.jobs.find({ incident_id: i.id, type: 'incident' }, { order: 'created_at', desc: true, limit: 1 })[0];
        eq(i.job && i.job.id, latest ? latest.id : undefined, `sự cố ${i.code}: đúng việc xử lý mới nhất`);
        eq(i.photos.length, 1, `sự cố ${i.code}: đủ ảnh`);
      }
    });
    eq(calls.filter((c) => c.where.incident_id !== undefined && Array.isArray(c.where.incident_id)).length, 1, 'một lượt đọc việc cho cả danh sách');
    ok(calls.filter((c) => typeof c.where.incident_id === 'number').length === ids.length, 'kiểm chéo ở trên đọc riêng từng sự cố (chỉ trong phép thử)');
  });

  await group('perf-overview-slow / perf-outlets-metrics-sale: số lượt đọc không theo số tuần, giờ đã dùng đọc từ ngày onboard', async () => {
    ok(SCHEMA.hub_log.index.some((x) => x.join(',') === 'entity,action,ts'), 'hub_log có chỉ mục (entity, action, ts) cho truy vấn làm lại');
    ok(SCHEMA.jobs.index.some((x) => x.join(',') === 'status,team,done_at'), 'jobs có chỉ mục (status, team, done_at)');
    ok(SCHEMA.card_records.index.some((x) => x.join(',') === 'at'), 'card_records có chỉ mục theo lúc nhập');
    const { h, U, go, liveBo } = await world(kind);
    const a = await liveBo('BO Một', 'M1'), b = await liveBo('BO Hai', 'M2');
    h.store.sites.update(a.site.id, { quota_hours: 500 }); h.store.sites.update(b.site.id, { quota_hours: 500 });
    // Lịch sử trước ngày onboard (dữ liệu nhập từ hệ thống cũ) và giờ quay sau onboard.
    const rec = (site, kit, date, hours) => h.store.card_records.insert({ card_id: null, code: 'X', site_id: site, kit_id: kit, handover_id: null, shoot_date: date, gb: hours * 16.9, hours, zero_reason: null, photos: null, by_id: U.t1.id, at: h.clock.now(), edited_by: null, edited_at: null, src: null });
    for (let i = 1; i <= 20; i++) rec(a.site.id, a.kit.id, `2026-08-${String(i).padStart(2, '0')}`, 3);
    for (const d of ['2026-09-02', '2026-09-20', '2026-10-05', '2026-10-06']) { rec(a.site.id, a.kit.id, d, 4); rec(b.site.id, b.kit.id, d, 5); }
    let body;
    const cr = await countFind(h.store, 'card_records', async () => { body = await go('ll', 'GET', '/api/hub/outlets', null, { metrics: '1' }); });
    ok(body.outlets.length === 2, 'màn hình BO có đủ hai BO');
    ok(cr.every((c) => c.where.shoot_date || c.where.at), 'mọi lượt đọc bảng dung lượng đều giới hạn theo ngày (không quét cả lịch sử)');
    const usedReads = cr.filter((c) => c.where.shoot_date && c.where.shoot_date.gte === '2026-09-01' && c.where.shoot_date.lte === undefined);
    eq(usedReads.length, 1, 'giờ đã dùng tính một lần cho cả màn hình BO và bảng tuần');
    ok(usedReads.every((c) => c.rows.every((r) => r.shoot_date >= '2026-09-01')), 'giờ đã dùng không đọc dữ liệu trước ngày onboard');
    const hos = (await go('sh', 'GET', '/api/hub/sale', null, { period: 'week' })).hos;
    const row = (code) => hos.outlets.find((o) => o.code === code);
    eq([row('M1').used_hours, row('M2').used_hours], [16, 20], 'số giờ đã dùng đúng (từ ngày onboard)');
    const ov = await countFind(h.store, 'card_records', async () => { await go('ad', 'GET', '/api/hub/overview', null, { period: 'week' }); });
    const series = (calls) => calls.filter((c) => c.where.shoot_date && !c.where.at && c.where.shoot_date.lte && c.where.shoot_date.lte.slice(0, 7) !== c.where.shoot_date.gte.slice(0, 7) && c.opt.cols).length;
    console.log(`      (tổng quan: ${ov.length} lượt đọc bảng dung lượng)`);
    ok(ov.length <= 16, `tổng quan đọc bảng dung lượng ${ov.length} lượt (trước đây thêm một lượt cho mỗi tuần trong 12 tuần)`);
    eq(series(ov), 1, 'xu hướng 12 tuần của tổng quan: một lượt đọc');
    // Lần mở trước đã tính sẵn: số liệu tổng hợp nhớ tới khi có lệnh ghi đổi dữ liệu nên mở lại không đọc lại bảng dung lượng.
    const again = await countFind(h.store, 'card_records', async () => { await go('sh', 'GET', '/api/hub/sale', null, { period: 'week' }); });
    eq(again.length, 0, 'mở lại Dashboard Kinh doanh khi chưa có gì đổi: dùng số đã tính, không đọc lại bảng dung lượng');
    rec(b.site.id, b.kit.id, '2026-10-06', 1); // Tech nhập thêm một thẻ: phải tính lại từ bảng dung lượng
    const sl = await countFind(h.store, 'card_records', async () => { await go('sh', 'GET', '/api/hub/sale', null, { period: 'week' }); });
    console.log(`      (Dashboard Kinh doanh: ${sl.length} lượt đọc bảng dung lượng)`);
    ok(sl.length <= 16, `Dashboard Kinh doanh đọc bảng dung lượng ${sl.length} lượt (trước đây 12 tuần + 12 tháng mỗi khoảng một lượt)`);
    eq(series(sl), 2, 'xu hướng 12 tuần và giờ quay 12 tháng: mỗi chuỗi một lượt đọc');
    const jb = await countFind(h.store, 'jobs', async () => { await go('ad', 'GET', '/api/hub/overview', null, { period: 'week' }); });
    ok(jb.filter((c) => c.where.done_at && !c.opt.cols).every((c) => c.rows.length === 0 || c.where.team), 'đọc việc đã xong theo team và khoảng thời gian');
  });
}

// ───────── Giao diện: đường dẫn dashboard và thông báo (không cần trình duyệt) ─────────
async function ui() {
  console.log('\n── Giao diện ──');
  await group('dashboard-status-param-ignored: liên kết dùng đúng khoá ?st= mà màn hình đọc', async () => {
    const ov = src('public/js/views/overview.js'), sale = src('public/js/views/sale.js');
    for (const [name, s] of [['overview', ov], ['sale', sale]]) {
      ok(!/go\('outlets', \[\], \{ status:/.test(s), `${name}: BO đang ghi hình không gửi ?status=`);
      ok(/go\('outlets', \[\], \{ st: 'live' \}\)/.test(s), `${name}: BO đang ghi hình mở #/outlets?st=live`);
    }
    ok(/href\('kits', \[\], \{ st: 'at_tech' \}\)/.test(ov) && !/href\('kits', \[\], \{ status:/.test(ov), 'Kit đang ở Tech mở #/kits?st=at_tech');
    ok(!/href\('cards', \[\], \{ status:/.test(ov), 'mục Theo dõi về thẻ không gửi ?status=');
    ok(/ctx\.query\.st\b/.test(src('public/js/views/outlets.js')) && /ctx\.query\.st\b/.test(src('public/js/views/stock.js')) && /ctx\.query\.st\b/.test(src('public/js/views/cards.js')), 'ba màn hình lọc theo ?st=');
  });
  await group('overview-jobs-filter-ignored: ô Điểm nghẽn mở Bảng việc đã lọc', async () => {
    const ov = src('public/js/views/overview.js'), jobs = src('public/js/views/jobs.js');
    ok(!/,\s*filter\s*\}\)/.test(ov), 'không còn gửi ?filter= (màn hình Bảng việc không đọc)');
    ok(/overdue: \{ scope: 'team', od: '1' \}/.test(ov) && /pool: \{ scope: 'team', who: 'pool' \}/.test(ov) && /blocked: \{ scope: 'team', v: 'board' \}/.test(ov), 'quá hạn → od=1, chưa ai nhận → who=pool, đang vướng → dạng bảng cột');
    ok(['q0.od', 'q0.who', 'q0.v', 'q0.scope'].every((k) => jobs.includes(k)), 'Bảng việc đọc các khoá này');
  });
  await group('unresolvable-notification-links: đường dẫn thông báo mở đúng màn hình', async () => {
    const ARL = { $: () => null, $$: () => [], api: async () => ({}), toast: () => {}, nameParts: () => ({}), H: { h: () => ({}) } };
    const ctx = { ARL, window: { ARL }, console, URLSearchParams };
    vm.createContext(ctx);
    vm.runInContext(src('public/js/hub.js'), ctx);
    for (const id of Object.keys(ARL.hub.NAV)) ARL.hub.view(id, { mount() {} });
    const R = ARL.hub.resolveLink;
    eq(R('roster', 'lead'), '#/roster', 'đăng ký ca chờ duyệt → Phân ca');
    eq(R('roster', 'logistic'), '#/roster', 'ca đã duyệt → Phân ca');
    eq(R('attendance', 'lead'), '#/attendance', 'vắng ca → Chấm công');
    eq(R('jobs:stale', 'tech_lead'), '#/jobs', 'việc tồn từ ngày trước → Bảng việc');
    eq(R('cards:at_bo', 'lead'), '#/cards?st=at_bo', 'thẻ nằm ở BO → danh sách thẻ lọc trạng thái');
    eq(R('job:12', 'tech'), '#/jobs/12', 'việc cụ thể vẫn mở như cũ');
    eq(R('handover:3', 'lead'), '#/cards/3?tab=handovers', 'phiếu bàn giao vẫn mở như cũ');
    eq(R('attendance', 'tech'), null, 'vai trò không có màn hình → không mở');
    eq(R('cards:at_bo', 'sale'), null, 'Sale không mở được thẻ nhớ');
    eq([ARL.hub.linkView('attendance'), ARL.hub.linkView('la_lam'), ARL.hub.linkView('')], ['attendance', null, null], 'nhận ra màn hình có thật, bỏ qua đường dẫn lạ');
    const inbox = src('public/js/views/inbox.js');
    ok(/ARL\.hub\.linkView\(it\.link\)\) ARL\.toast\('Vai trò của bạn không mở được/.test(inbox), 'hộp thư chỉ báo "không mở được" khi màn hình có thật mà vai trò không có');
  });
  await group('idem: hộp thoại gửi khoá gửi một lần mỗi lần mở; báo trùng có liên kết', async () => {
    const out = src('public/js/views/outlets.js'), stock = src('public/js/views/stock.js'), jobs = src('public/js/views/jobs.js'), common = src('public/js/common.js'), prev = src('tools/preview-backend.js');
    ok((out.match(/ARL\.reqKey\(\)/g) || []).length >= 2 && /req_key = rk/.test(out), 'yêu cầu mở BO và yêu cầu hỗ trợ gửi req_key');
    ok(/ARL\.reqKey\(\)/.test(stock) && /req_key: rk/.test(stock), 'ghi sổ phụ kiện gửi req_key');
    ok(/ARL\.reqKey\(\)/.test(jobs) && /req_key: rk/.test(jobs), 'tạo việc giao tay gửi req_key');
    ok(/function reqKey\(\)/.test(common) && /data: j \}/.test(common) && /data: b \}/.test(prev), 'lỗi từ máy chủ mang kèm dữ liệu (yêu cầu đã có) cho màn hình');
    ok(/confirm_new = true/.test(out) && /#\/requests\/\$\{d\.request\.id\}/.test(out), 'báo trùng BO: liên kết tới yêu cầu đã có và cho xác nhận BO khác');
  });
}

for (const kind of ['memory', 'sqlite']) await suite(kind);
await ui();
summary('fix.sys');
