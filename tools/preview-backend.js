/* Bản xem thử: "máy chủ" chạy ngay trong trình duyệt, dùng ĐÚNG lõi nghiệp vụ của bản thật (window.ARL_CORE) trên kho bộ nhớ.
   Không có gì được gửi ra ngoài; tải lại trang là dữ liệu trở về ban đầu. */
(() => {
  'use strict';
  const C = window.ARL_CORE;
  const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  let fake = null; // đồng hồ giả chỉ dùng lúc "tua nhanh" phần đầu ngày; sau đó chạy giờ thật
  const now = () => (fake === null ? Date.now() : fake);
  const files = new Map(); // id ảnh → data URL
  const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const rand = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64(a).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const store = C.createMemoryStore(C.SCHEMA);
  const core = C.createCore({
    store, now,
    cfg: { demo: true, tileUrl: 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', tileAttribution: '© Google Maps', note: 'Bản xem thử: dữ liệu giả lập trên nền Google Maps.' },
    hashPassword: async (p) => 'demo:' + p,
    verifyPassword: async (p, h) => h === 'demo:' + p,
    token: rand,
    sha: (s) => 's:' + s,
    files: { put: (id, bytes, mime) => files.set(id, `data:${mime};base64,${b64(bytes)}`), remove: (id) => files.delete(id) },
  });
  let token = null, username = null;
  const BO_DEV = 'thiet-bi-xem-thu-0000000000000000'; // "điện thoại của BO" trong bản xem thử
  const listeners = [];
  const authChanged = () => { for (const f of listeners) { try { f(username); } catch { /* bỏ qua */ } } };

  // ───── Khởi tạo: tạo dữ liệu mẫu rồi "tua nhanh" tối đa 40 phút để có task đang chạy, ảnh, cảnh báo, thống kê ─────
  try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith('arl.fo.')) localStorage.removeItem(k); } } catch { /* không có localStorage */ }
  let driver = null;
  const ready = (async () => {
    const real = Date.now(), off = core.cfg.tzOffsetMin;
    const midnight = Date.parse(new Date(real + off * 60000).toISOString().slice(0, 10) + 'T00:00:00Z') - off * 60000;
    fake = Math.max(midnight + 60000, real - 40 * 60000);
    if (fake > real) fake = real;
    await C.seedDemo(core);
    // Lịch sử Ops Hub (vài tuần BO, kit, thẻ, việc, sự cố, phân ca) để dashboard WoW/MoM có số. Bản xem thử dùng quy mô 0,5 cho nhanh.
    if (C.seedHubDemo) {
      const before = fake;
      try { await C.seedHubDemo(core, { setNow: (t) => { fake = t === null ? before : t; }, scale: 0.5 }); } catch (e) { console.error('[xem thử] Không tạo được lịch sử Ops Hub', e); }
      fake = before;
    }
    driver = C.createDemoDriver(core);
    core.tick();
    for (let i = 0; fake < real; i++) {
      fake = Math.min(real, fake + 2000);
      await driver.step(fake);
      core.flushPositions();
      if (i % 8 === 0) core.tick();
    }
    fake = null;
    core.tick();
    const r = await core.api({ user: null, ip: 'xem-thu', ua: navigator.userAgent }, 'POST', '/api/login', {}, { username: 'admin', password: C.DEMO_PASSWORD });
    if (r.status === 200) { token = r.body.__session; username = 'admin'; }
    let stepping = false;
    setInterval(async () => { if (stepping) return; stepping = true; try { await driver.step(Date.now()); } catch (e) { console.error(e); } stepping = false; }, 2000);
    setInterval(() => { try { core.flushPositions(); } catch (e) { console.error(e); } }, 1000);
    setInterval(() => { try { core.tick(); } catch (e) { console.error(e); } }, 15000);
    authChanged();
  })();

  // ───── API ─────
  async function api(method, path, body, query) {
    await ready;
    const ctx = { user: core.authToken(token), token, ip: 'xem-thu', ua: navigator.userAgent, dev: BO_DEV };
    const out = await core.api(ctx, method, path, clone(query) || {}, clone(body));
    const b = clone(out.body) || {};
    if (b.__session) { token = b.__session; delete b.__session; username = b.user ? b.user.username : null; authChanged(); }
    if (b.__clearSession) { token = null; username = null; delete b.__clearSession; authChanged(); }
    delete b.__dev;
    if (out.status >= 400) throw Object.assign(new Error(b.message || 'Có lỗi xảy ra. Thử lại.'), { status: out.status, code: b.error || 'http_' + out.status, data: b });
    return b;
  }

  // ───── Kênh trực tiếp (thay WebSocket) ─────
  function connect(onMsg, onState) {
    let closed = false, isReady = false, unsub = null, user = null;
    const deliver = (m) => {
      if (closed) return;
      const c = clone(m);
      setTimeout(() => {
        if (closed) return;
        if (c.t === 'hello') { isReady = true; onState('live'); }
        if (c.t === 'kick') closed = true;
        try { onMsg(c); } catch (e) { console.error(e); }
      }, 0);
    };
    onState('connecting');
    ready.then(() => {
      if (closed) return;
      user = core.authToken(token);
      if (!user) { onState('down'); return; }
      unsub = core.subscribe(user, deliver, () => {});
      const l = core.live.get(user.id);
      deliver({ t: 'hello', now: now(), uid: user.id, role: user.role, onShift: !!(l && l.onShift) });
      if (['admin', 'lead', 'logistic'].includes(user.role)) deliver(core.snapshot()); // bản đồ FO: chỉ Logistics và Quản trị (như máy chủ thật)
    });
    const handle = (m) => {
      if (closed || !user || !m || typeof m !== 'object') return;
      if (m.t === 'ping') return deliver({ t: 'pong', now: now() });
      if (user.role !== 'fo') { // màn hình FO đang chạy bằng phiên của vai khác: báo từ chối để màn hình tự mở lại (như máy chủ thật)
        if (m.t === 'loc') return deliver({ t: 'ack', seq: m.seq, ok: 0, drop: Array.isArray(m.pts) ? m.pts.length : 0, denied: true, why: 'role' });
        if (m.t === 'shift') return deliver({ t: 'shift', on: false, denied: true, why: 'role' });
        return;
      }
      const u = store.users.get(user.id), allowed = core.canTrack(u);
      try {
        if (m.t === 'loc' && Array.isArray(m.pts)) {
          if (!allowed) return deliver({ t: 'ack', seq: m.seq, ok: 0, drop: m.pts.length, denied: true });
          deliver({ t: 'ack', seq: m.seq, ...core.ingestMany(u.id, m.pts) });
        } else if (m.t === 'shift') {
          if (!allowed) return deliver({ t: 'shift', on: false, denied: true });
          deliver({ t: 'shift', on: core.setShift(u, !!m.on).onShift });
        }
      } catch (e) { console.error(e); }
    };
    return {
      send(o) { if (closed || !isReady) return false; const c = clone(o); setTimeout(() => handle(c), 0); return true; },
      get ready() { return isReady; },
      kickReconnect() {},
      close() { closed = true; isReady = false; if (unsub) unsub(); },
    };
  }

  // ───── GPS giả cho người đang xem với vai FO: tự "chạy xe" tới điểm kế tiếp của task đang làm ─────
  const RAD = Math.PI / 180;
  const pos = { lat: 10.7769, lon: 106.7009, spd: 0, hdg: 0, set: false };
  const watchers = new Map();
  let watchSeq = 0, geoTimer = null, lastMove = 0;
  function target() {
    const u = core.authToken(token);
    if (!u || u.role !== 'fo') return null;
    const t = store.tasks.find({ fo_id: u.id, status: 'in_progress' }, { limit: 1 })[0];
    if (!t) return null;
    const stops = store.stops.find({ task_id: t.id }, { order: 'seq' });
    return stops.find((s) => s.status === 'pending' || s.status === 'arrived') || null;
  }
  function moveOnce() {
    const t = Date.now(), dt = lastMove ? Math.min(5, (t - lastMove) / 1000) : 2;
    lastMove = t;
    if (!pos.set) { const o = store.sites.find({ type: 'office', active: 1 }, { limit: 1 })[0]; if (o) { pos.lat = o.lat + 0.00012; pos.lon = o.lon + 0.0001; } pos.set = true; }
    const s = target();
    pos.spd = 0;
    if (s) {
      const dy = (s.lat - pos.lat) * 111320, dx = (s.lon - pos.lon) * 111320 * Math.cos(pos.lat * RAD), d = Math.hypot(dx, dy);
      if (d > 12) {
        const step = Math.min(d - 6, 13 * dt); // ~47 km/h: đủ nhanh để xem thử, vẫn nằm trong ngưỡng lọc điểm nhảy
        pos.lat += ((dy / d) * step) / 111320; pos.lon += ((dx / d) * step) / (111320 * Math.cos(pos.lat * RAD));
        pos.spd = step / dt; pos.hdg = (Math.atan2(dx, dy) / RAD + 360) % 360;
      }
    }
  }
  const fix = () => ({ timestamp: Date.now(), coords: { latitude: pos.lat, longitude: pos.lon, accuracy: 8, speed: pos.spd, heading: pos.spd > 0.8 ? pos.hdg : NaN } });
  const geo = {
    watchPosition(okFn) {
      const id = ++watchSeq;
      watchers.set(id, okFn);
      if (!geoTimer) geoTimer = setInterval(() => { moveOnce(); const f = fix(); for (const fn of watchers.values()) { try { fn(f); } catch (e) { console.error(e); } } }, 2000);
      setTimeout(() => { if (watchers.has(id)) { moveOnce(); okFn(fix()); } }, 300);
      return id;
    },
    clearWatch(id) { watchers.delete(id); if (!watchers.size && geoTimer) { clearInterval(geoTimer); geoTimer = null; lastMove = 0; } },
    getCurrentPosition(okFn) { setTimeout(() => okFn(fix()), 50); },
  };

  window.ARL_BACKEND = {
    api, connect, geo,
    photoUrl: (id) => files.get(id) || 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
    boPhotoUrl: (id) => files.get(id) || 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
    /** Đóng vai BO: tạo link cho lượt giao nhận (tại BO) của FO do người xem tự điều khiển. Trả về null nếu không còn lượt nào. */
    async demoBoToken() {
      await ready;
      const lead = store.users.find({ username: 'lead' }, { limit: 1 })[0];
      let pickStop = null;
      for (const t of store.tasks.find({ status: ['in_progress', 'assigned', 'accepted'] }, { order: 'start_at' })) {
        const fo = t.fo_id ? store.users.get(t.fo_id) : null;
        if (!fo || /^fo\d+$/.test(fo.username)) continue; // task của FO mô phỏng đã có "BO mô phỏng" lo
        const stops = store.stops.find({ task_id: t.id }, { order: 'seq' }).filter((s) => s.bo_req && s.status !== 'failed' && (s.bo_status === 'none' || s.bo_status === 'pending'));
        const s = stops.find((x) => x.bo_status === 'pending') || stops[0];
        if (s && (!pickStop || s.bo_status === 'pending')) pickStop = s;
      }
      if (!pickStop) return null;
      const r = await core.api({ user: lead, ip: 'xem-thu', ua: 'xem-thu' }, 'POST', `/api/stops/${pickStop.id}/bo-link`, {}, {});
      return r.status === 200 ? r.body.token : null;
    },
    // không có csvUrl: bản xem thử hiện nội dung CSV trong hộp thoại thay vì tải tệp
    onAuth: (fn) => { listeners.push(fn); fn(username); },
    async switchTo(name) {
      await ready;
      try { await api('POST', '/api/logout'); } catch { /* chưa đăng nhập */ }
      await api('POST', '/api/login', { username: name, password: C.DEMO_PASSWORD });
    },
  };
})();
