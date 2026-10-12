// hub.security.test.mjs — kiểm phân quyền giữa 3 team trên TOÀN BỘ API, không chọn lọc:
//  1) Chính sách khai báo: đọc danh sách API của máy chủ và đối chiếu với quy tắc (Sale/Tech không có API nào chạm vị trí FO,
//     bảng đánh giá cá nhân chỉ Lead, FO không vào Ops Hub, Sale không sửa kho…).
//  2) Gọi thật: dựng một thế giới đã chạy ~1.200 thao tác ngẫu nhiên của cả 3 team + FO đang chạy ngoài đường (toạ độ riêng
//     dễ nhận ra), rồi mỗi vai trò gọi MỌI API đọc với mã thật trong kho. Kiểm: không lỗi 5xx; vai không được phép → 403;
//     phản hồi gửi Sale và Tech không chứa toạ độ FO; phản hồi gửi Sale không nêu tên FO (tên + giờ + BO = lộ nơi FO đang ở).
//  3) Đánh giá cá nhân: Lead team này không xem được team kia; tổng quan chỉ có Top 3 của team mình.
//  4) Kênh thời gian thực: Sale và Tech không nhận gói nào có vị trí FO.
import { run } from './hub.fuzz.mjs';
import { ok, eq, group, summary } from './harness.mjs';

const ROLE_OF = { ad: 'admin', tl: 'tech_lead', t1: 'tech', ll: 'lead', l1: 'logistic', sh: 'sale_head', s1: 'sale' };
const SALE = ['sale', 'sale_head'], TECH = ['tech', 'tech_lead'];
// Toạ độ FO dễ nhận ra (không trùng điểm BO / văn phòng nào trong dữ liệu ngẫu nhiên).
const FO_LAT = 10.712345, FO_LON = 106.612345;
const FO_MARKS = ['10.712', '106.612'];

const pathOf = (r) => r.re.source.replace(/\\\//g, '/').replace(/^\^|\$$/g, '');
const allows = (r, role) => r.roles === 'any' || r.roles === 'public' || (Array.isArray(r.roles) && r.roles.includes(role));

await group('Chính sách khai báo của từng API khớp quy tắc bảo mật giữa 3 team', async () => {
  const { h } = await run('memory', 1, 1);
  const routes = h.core.hub.K.routes();
  ok(routes.length > 150, `đọc được danh sách API (${routes.length})`);
  // Mọi bề mặt có vị trí FO, chuyến, ảnh giao nhận, lịch sử đường đi.
  const FO_SURFACE = /^\/api\/(live|history|tasks|stops|stats|alerts|suggest|plan|templates|sites|conditions)(\/|\.|$)|^\/api\/hub\/dispatch$|^\/api\/hub\/jobs\/\(\[\^\/\]\+\)\/untrip$/;
  // (Mã thiết bị gửi GPS của FO — /api/users/:id/device — chỉ dùng để GHI vị trí từ máy định vị, không đọc được vị trí; Tech Lead cài máy nên được cấp.)
  const surf = routes.filter((r) => FO_SURFACE.test(pathOf(r)));
  ok(surf.length >= 25, `nhận diện các API chạm vị trí / chuyến FO (${surf.length})`);
  for (const r of surf) {
    if (r.roles === 'public') continue; // link một lần của BO: kiểm riêng ở http.test (chỉ thấy đúng điểm của mình)
    for (const role of [...SALE, ...TECH]) ok(!allows(r, role), `${role} không được gọi ${r.method} ${pathOf(r)}`);
  }
  for (const r of routes.filter((x) => pathOf(x).startsWith('/api/hub/'))) ok(!allows(r, 'fo'), `FO không vào Ops Hub: ${r.method} ${pathOf(r)}`);
  for (const r of routes.filter((x) => /^\/api\/hub\/(perf($|\/trend|\/lock|\/unlock|\.csv)|attendance)/.test(pathOf(x)))) {
    for (const role of ['tech', 'logistic', 'sale', 'sale_head']) ok(!allows(r, role), `bảng đánh giá / chấm công chỉ Lead: ${role} bị chặn ${r.method} ${pathOf(r)}`);
  }
  const STOCK_WRITE = /^\/api\/hub\/(kits|devices|acc|types|cards|handovers|roster|dispatch|jobs)/;
  for (const r of routes.filter((x) => x.method !== 'GET' && STOCK_WRITE.test(pathOf(x)))) {
    for (const role of SALE) ok(!allows(r, role), `Sale không sửa kho / việc / ca: ${r.method} ${pathOf(r)}`);
  }
});

await group('Gọi thật mọi API đọc theo từng vai trò trên dữ liệu đã chạy 1.200 thao tác', async () => {
  const { h, U, broken } = await run('memory', 1200, 11);
  ok(!broken, 'thế giới ngẫu nhiên chạy sạch: ' + (broken || ''));
  const S = h.store;
  // FO đang trong ca, chạy ngoài đường với toạ độ riêng.
  const foUser = S.users.get(U.fo1.id);
  if (!h.core.live.get(foUser.id) || !h.core.live.get(foUser.id).onShift) await h.call('fo1', 'POST', '/api/shift', { on: true });
  for (let i = 0; i < 6; i++) { h.clock.add(20000); h.core.ingest(foUser.id, { ts: h.clock.now(), lat: FO_LAT + i * 0.00001, lon: FO_LON + i * 0.00001, acc: 5, spd: 6 }); }
  if (h.core.flushPositions) h.core.flushPositions();
  const foNames = S.users.find({ role: 'fo' }).map((u) => u.name);
  ok(foNames.length >= 2, 'có FO trong dữ liệu');

  // Mã thật để thay vào :id (lấy vài mã mỗi loại, ưu tiên bản ghi có liên quan tới FO / chuyến).
  const ids = {
    types: S.dev_types.find({}).slice(0, 2).map((x) => x.id), devices: S.devices.find({}).slice(0, 2).map((x) => x.id), kits: S.kits.find({}).slice(0, 3).map((x) => x.id),
    acc: ['hub_sac'], outlets: S.sites.find({ type: 'bo' }).slice(0, 3).map((x) => x.id), requests: S.requests.find({}).slice(0, 3).map((x) => x.id),
    jobs: [...S.jobs.find({ task_id: { ne: null } }).slice(0, 2), ...S.jobs.find({}).slice(0, 2)].map((x) => x.id), cards: S.cards.find({}).slice(0, 2).map((x) => x.id),
    handovers: S.handovers.find({}).slice(0, 2).map((x) => x.id), incidents: S.incidents.find({}).slice(0, 2).map((x) => x.id), records: S.card_records.find({}).slice(0, 1).map((x) => x.id),
    tasks: S.tasks.find({}).slice(0, 2).map((x) => x.id), users: [U.fo1.id, U.l1.id], photo: S.photos.find({}).slice(0, 1).map((x) => x.id),
  };
  const fill = (p) => {
    const m = /^\/api\/(?:hub\/)?([a-z]+)/.exec(p.replace('/api/hub/cards/records', '/api/hub/records'));
    const key = m ? m[1] : '';
    const pool = ids[key] || ids[{ outlet: 'outlets' }[key]] || [1];
    const n = (p.match(/\(\[\^\/\]\+\)/g) || []).length;
    if (!n) return [p];
    if (n === 2) return [p.replace('([^/]+)', String(U.t1.id)).replace('([^/]+)', '2026-10-06')]; // chấm công: /attendance/:uid/:date
    return (pool.length ? pool : [1]).map((id) => p.replace('([^/]+)', String(id)));
  };
  const gets = h.core.hub.K.routes().filter((r) => r.method === 'GET' && r.roles !== 'public');
  let calls = 0, fiveXX = 0;
  const leaks = [];
  for (const [who, role] of Object.entries(ROLE_OF)) {
    for (const r of gets) {
      for (const p of fill(pathOf(r))) {
        const query = p === '/api/hub/perf' || p === '/api/hub/perf/trend' || p === '/api/hub/attendance' || p === '/api/hub/perf.csv' ? { team: role === 'tech_lead' ? 'tech' : 'logistics' } : {};
        const res = await h.call(who, 'GET', p, null, query);
        calls++;
        if (res.status >= 500) { fiveXX++; leaks.push(`${who} GET ${p} → ${res.status}`); continue; }
        if (!allows(r, role)) { if (res.status !== 403) leaks.push(`${role} không được phép mà vẫn gọi được GET ${p} (${res.status})`); continue; }
        if (res.status !== 200) continue;
        const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        if ([...SALE, ...TECH].includes(role) && FO_MARKS.some((m) => body.includes(m))) leaks.push(`${role} nhận toạ độ FO qua GET ${p}`);
        if (SALE.includes(role)) for (const n of foNames) if (body.includes(`"${n}"`) || body.includes(` ${n} `) || body.includes(`${n}:`)) leaks.push(`${role} thấy tên FO "${n}" qua GET ${p}`);
      }
    }
  }
  // Đối chứng: bài kiểm thật sự nhận ra được toạ độ và tên FO khi chúng có mặt (Logistics được xem).
  const live = JSON.stringify((await h.call('l1', 'GET', '/api/live')).body), trips = JSON.stringify((await h.call('l1', 'GET', '/api/tasks')).body);
  ok(FO_MARKS.every((m) => live.includes(m)), 'đối chứng: Logistics xem bản đồ thấy đúng toạ độ FO vừa gửi');
  ok(foNames.some((n) => trips.includes(`"${n}"`) || live.includes(`"${n}"`)), 'đối chứng: Logistics thấy tên FO trên chuyến / bản đồ');
  ok(calls > 400, `đã gọi ${calls} lượt API đọc`);
  eq(fiveXX, 0, 'không lượt nào lỗi máy chủ');
  ok(!leaks.length, 'không rò rỉ giữa các team: ' + leaks.slice(0, 12).join(' | '));
  console.log(`    ${calls} lượt gọi API đọc theo 7 vai trò, ${leaks.length} vi phạm`);
});

await group('Đánh giá cá nhân: Lead chỉ thấy team mình; tổng quan chỉ kèm Top 3 của team mình', async () => {
  const { h } = await run('memory', 600, 5);
  const st = async (who, p, q) => (await h.call(who, 'GET', p, null, q)).status;
  eq([await st('tl', '/api/hub/perf', { team: 'logistics' }), await st('ll', '/api/hub/perf', { team: 'tech' })], [403, 403], 'Tech Lead không xem đánh giá Logistics và ngược lại');
  eq([await st('tl', '/api/hub/perf', { team: 'tech' }), await st('ll', '/api/hub/perf', { team: 'logistics' }), await st('ad', '/api/hub/perf', { team: 'tech' })], [200, 200, 200], 'Lead xem team mình; Quản trị xem mọi team');
  eq([await st('tl', '/api/hub/perf.csv', { team: 'logistics' }), await st('ll', '/api/hub/attendance', { team: 'tech' }), await st('tl', '/api/hub/perf/trend', { team: 'logistics' })], [403, 403, 403], 'tải CSV, chấm công, xu hướng: cũng chặn chéo team');
  eq([await st('t1', '/api/hub/perf'), await st('l1', '/api/hub/perf'), await st('sh', '/api/hub/perf'), await st('s1', '/api/hub/perf')], [403, 403, 403, 403], 'nhân viên và Sale không xem bảng đánh giá');
  const top = async (who) => Object.keys((await h.call(who, 'GET', '/api/hub/overview')).body.top3 || {}).sort();
  eq([await top('tl'), await top('ll'), await top('sh'), await top('ad')], [['tech'], ['logistics'], [], ['logistics', 'tech']], 'Top 3 trên tổng quan: Lead thấy team mình, Head of Sale không thấy, Quản trị thấy cả hai');
  const me = (await h.call('t1', 'GET', '/api/hub/perf/me')).body;
  const others = h.store.users.find({ role: ['tech', 'tech_lead', 'logistic', 'lead'] }).filter((u) => u.username !== 't1').map((u) => u.name);
  ok(!others.some((n) => JSON.stringify(me).includes(`"${n}"`)), 'trang "Hiệu suất của tôi" không kèm tên người khác');
});

await group('Kênh thời gian thực: Sale và Tech không nhận vị trí FO', async () => {
  const { h, U } = await run('memory', 300, 9);
  const got = {};
  for (const u of ['s1', 'sh', 't1', 'tl', 'l1']) { got[u] = []; h.core.subscribe(h.store.users.get(U[u].id), (m) => got[u].push(m)); }
  await h.call('fo2', 'POST', '/api/shift', { on: true });
  for (let i = 0; i < 5; i++) { h.clock.add(20000); h.core.ingest(U.fo2.id, { ts: h.clock.now(), lat: FO_LAT, lon: FO_LON + i * 0.0001, acc: 5, spd: 7 }); }
  if (h.core.flushPositions) h.core.flushPositions();
  h.core.tick();
  const posLike = (list) => list.filter((m) => ['pos', 'fo', 'shift', 'snapshot', 'task'].includes(m.t));
  ok(posLike(got.l1).length > 0, 'Logistics nhận vị trí FO theo thời gian thực');
  for (const u of ['s1', 'sh', 't1', 'tl']) {
    eq(posLike(got[u]).length, 0, `${u}: không nhận gói vị trí / chuyến FO`);
    ok(!FO_MARKS.some((m) => JSON.stringify(got[u]).includes(m)), `${u}: không gói nào chứa toạ độ FO`);
  }
});

summary('Ops Hub — bảo mật giữa 3 team');
