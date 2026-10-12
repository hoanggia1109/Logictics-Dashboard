/* Màn hình điều phối cho Logistic Lead / Logistic: bản đồ trực tiếp + task. Các trang còn lại ở ops-pages.js */
(() => {
  'use strict';
  const { $, $$, el, esc, api, toast, modal, ask, distM, now, fmtHM, fmtDate, fmtKm, today, kmh, ago, span, nameParts, safeColor, telHref, TASK_ST, STOP_ST, BO_ST, WEATHER, TRAFFIC, isOpen, slaOf, countsText, progressOf, thumbs, baseMap, pinIcon, siteIcon, gmapsAt, HCMC } = ARL;
  const { drawRoute, routeLegs, hasTraffic, routeLegend, slaBreakdown, routeNote, routeText, taskRoute } = ARL;

  const ST = { moving: 'Đang chạy', stopped: 'Đang dừng', stale: 'Mất sóng', offline: 'Ngoài ca' };
  const ORDER = { moving: 0, stopped: 1, stale: 2, offline: 3 };
  const MOVING_MPS = 1.2; // dưới ~4 km/h coi như đứng yên (GPS luôn rung nhẹ)
  const TRAIL_LABEL = { all: 'Vệt đường: tất cả', sel: 'Vệt đường: người đang chọn', off: 'Vệt đường: tắt' };
  const svg = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    live: svg('<circle cx="12" cy="10" r="3"/><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/>'),
    tasks: svg('<rect x="4" y="4" width="16" height="17" rx="2"/><path d="M9 4V2.5h6V4M8 10l2 2 4-4M8 16h8"/>'),
    routes: svg('<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.8"/>'),
    sites: svg('<path d="M4 20V9l8-5 8 5v11M9 20v-6h6v6"/>'),
    stats: svg('<path d="M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3"/>'),
    alerts: svg('<path d="M6 17V11a6 6 0 1 1 12 0v6l1.5 2h-15zM10 21h4"/>'),
    users: svg('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.5c1.8.8 3 2.6 3 5.5"/>'),
    more: svg('<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>'),
    hub: svg('<rect x="3.5" y="3.5" width="7" height="8" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.5"/><rect x="13.5" y="11.5" width="7" height="9" rx="1.5"/><rect x="3.5" y="14.5" width="7" height="6" rx="1.5"/>'),
  };
  const TABS = [['live', 'Trực tiếp'], ['tasks', 'Task'], ['routes', 'Tuyến định kỳ'], ['sites', 'Điểm'], ['stats', 'Thống kê'], ['alerts', 'Cảnh báo'], ['users', 'Tài khoản'], ['more', 'Thêm']];
  const MAP_TABS = ['live', 'tasks', 'sites'];
  /** Thống kê từng FO và tài khoản: chỉ Logistic Lead và Quản trị (máy chủ cũng chặn). */
  const LEAD_TABS = ['users', 'stats'];

  /** opt.onExit: có thì hiện nút "Ops Hub" trên thanh bên để quay về Ops Hub (Rider Live chạy bên trong Ops Hub). */
  ARL.mountOps = function (root, me, opt = {}) {
    const isLead = me.user.role === 'lead' || me.user.role === 'admin';
    const ac = new AbortController();
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const isMobile = window.matchMedia('(max-width: 899px)');
    const S = {
      me, isLead, tab: 'live', fos: new Map(), tasks: new Map(), sites: new Map(), date: today(), taskFilter: 'all', selTask: null, taskEvents: [],
      filter: 'all', q: '', sel: null, follow: false, trailMode: 'sel', showSites: true, hist: null, fitted: false, conditions: null, openAlerts: 0, alerts: null, conn: 'connecting',
      route: null, routeFor: null, routeBounds: null, fitFor: null, rerouting: null, // đường đi thực tế của task đang xem (đã tải) + khung bao; chờ vẽ xong mới thu phóng; đang bấm "Tính lại đường"
    };
    const v = el(`
      <div class="ops sheet-peek" data-tab="live">
        <nav class="rail" aria-label="Chức năng">
          <div class="brand"><span class="logo" aria-hidden="true"></span></div>
          ${opt.onExit ? `<button type="button" data-tab="hub" class="tab to-hub" title="Quay về Ops Hub">${ICON.hub}<span>Ops Hub</span></button>` : ''}
          ${TABS.filter(([k]) => !LEAD_TABS.includes(k) || isLead).map(([k, label]) => `<button type="button" data-tab="${k}" class="tab">${ICON[k]}<span>${label}</span>${k === 'alerts' ? '<b class="badge" hidden></b>' : ''}</button>`).join('')}
          <div class="rail-foot">
            <button type="button" class="cond" title="Điều kiện thời tiết / giao thông đang áp dụng cho SLA"></button>
            <button type="button" class="acct" title="Tài khoản"></button>
          </div>
        </nav>
        <aside class="side" aria-label="Danh sách">
          <button class="handle" type="button" aria-label="Mở rộng hoặc thu gọn danh sách"><i></i></button>
          <div class="pane" data-pane="live">
            <section class="view-roster">
              <header class="top"><h1>Trực tiếp</h1><span class="conn" data-state="connecting">Đang kết nối</span></header>
              <div class="filters" role="group" aria-label="Lọc FO theo trạng thái"></div>
              <input class="search q" type="search" placeholder="Tìm FO theo tên hoặc biển số" autocomplete="off" aria-label="Tìm FO">
              <ul class="roster"></ul>
              <p class="empty" hidden></p>
            </section>
            <section class="view-detail" hidden>
              <header class="top"><button class="ghost back" type="button">‹ Danh sách</button><span class="pill d-status"></span></header>
              <div class="who"><span class="sw d-sw"></span><div><h2 class="d-name"></h2><p class="sub d-vehicle"></p></div></div>
              <dl class="stats"><div><dt>Tốc độ</dt><dd class="d-speed">–</dd></div><div><dt>Cập nhật</dt><dd class="d-age">–</dd></div><div><dt>Pin</dt><dd class="d-bat">–</dd></div><div><dt>Sai số GPS</dt><dd class="d-acc">–</dd></div></dl>
              <div class="actions"><button class="b-follow" type="button" aria-pressed="false">Bám theo</button><a class="btn b-call" href="#" hidden>Gọi</a><a class="btn b-gmaps" href="#" target="_blank" rel="noopener">Mở Google Maps</a></div>
              <div class="fo-tasks"><h3>Task hôm nay</h3><ul class="mini-tasks"></ul></div>
              <div class="hist"><h3>Lộ trình theo ngày</h3>
                <div class="hist-row"><input class="h-date" type="date" aria-label="Ngày xem lộ trình"><button class="b-hist" type="button">Xem lộ trình</button><button class="ghost b-hist-close" type="button" hidden>Đóng</button></div>
                <p class="sub h-info" hidden></p><input class="h-scrub" type="range" min="0" max="0" value="0" hidden aria-label="Tua lại lộ trình"><p class="sub h-at" hidden></p>
              </div>
            </section>
          </div>
          <div class="pane" data-pane="tasks">
            <section class="view-tlist">
              <header class="top"><h1>Task</h1><button type="button" class="primary b-new-task">+ Tạo task</button></header>
              <div class="toolbar"><input type="date" class="t-date" aria-label="Ngày"><button type="button" class="ghost t-today">Hôm nay</button></div>
              <div class="chips t-filter" role="group" aria-label="Lọc task"></div>
              <ul class="tlist"></ul>
              <p class="empty t-empty" hidden></p>
            </section>
            <section class="view-tdetail" hidden></section>
          </div>
          <div class="pane" data-pane="sites">
            <header class="top"><h1>Điểm giao nhận</h1><button type="button" class="primary b-new-site">+ Thêm điểm</button></header>
            <input class="search s-q" type="search" placeholder="Tìm điểm" autocomplete="off" aria-label="Tìm điểm">
            <ul class="slist"></ul>
            <p class="empty s-empty" hidden></p>
          </div>
        </aside>
        <main class="mapwrap">
          <div class="map" aria-label="Bản đồ vị trí FO"></div>
          <div class="mapctl"><button class="b-fit" type="button" title="Thu phóng để thấy mọi FO đang trong ca">Xem tất cả</button><button class="b-trail" type="button" title="Đổi cách hiện vệt đường đã đi"></button></div>
          <p class="demo-note" hidden></p>
        </main>
        <section class="page" hidden></section>
      </div>`);
    root.replaceChildren(v);
    const q = (s) => $(s, v);
    const mapEl = q('.map'), side = q('.side'), page = q('.page');
    const srvNow = now;

    // ───────────── Điều hướng ─────────────
    const setSheet = (open) => { v.classList.toggle('sheet-open', open); v.classList.toggle('sheet-peek', !open); };
    q('.handle').addEventListener('click', () => setSheet(v.classList.contains('sheet-peek')));
    function go(tab) {
      if (LEAD_TABS.includes(tab) && !isLead) tab = 'live';
      S.tab = tab; v.dataset.tab = tab;
      for (const b of $$('.tab', v)) b.setAttribute('aria-current', String(b.dataset.tab === tab));
      const withMap = MAP_TABS.includes(tab);
      side.hidden = !withMap; q('.mapwrap').hidden = !withMap; page.hidden = withMap;
      for (const p of $$('.pane', v)) p.hidden = p.dataset.pane !== tab;
      if (withMap) {
        setSheet(tab !== 'live');
        setTimeout(() => map.invalidateSize(), 0);
        if (tab !== 'tasks') drawTaskRoute(null);
        if (tab === 'tasks') { renderTasks(); if (S.selTask) drawTaskRoute(S.tasks.get(S.selTask)); }
        if (tab === 'sites') renderSites();
        paintSites();
      } else ARL.opsPages[tab](ctx, page);
    }
    q('.rail').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (!b) return; if (b.dataset.tab === 'hub') opt.onExit(); else go(b.dataset.tab); });

    // ───────────── Bản đồ ─────────────
    const map = baseMap(mapEl);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.createPane('trails').style.zIndex = 450;
    map.createPane('history').style.zIndex = 460;
    map.createPane('route').style.zIndex = 440;
    const siteLayer = L.layerGroup().addTo(map), routeLayer = L.layerGroup().addTo(map);
    const onZoom = () => mapEl.classList.toggle('far', map.getZoom() < (S.fos.size > 30 ? 14 : 12));
    map.on('zoomend', onZoom);
    map.on('dragstart', () => { setFollow(false); S.fitFor = null; });
    const sheetH = () => (isMobile.matches && !side.hidden ? side.offsetHeight : 0);
    // Điện thoại: tấm danh sách che phần dưới bản đồ → đưa logo Google, dòng bản quyền lên trên mép tấm (không bị che).
    const sheetRO = window.ResizeObserver ? new ResizeObserver(() => mapEl.style.setProperty('--sheet-h', `${sheetH()}px`)) : null;
    if (sheetRO) sheetRO.observe(side);
    const fitPad = () => ({ paddingTopLeft: [28, isMobile.matches ? 64 : 28], paddingBottomRight: [isMobile.matches ? 40 : 96, sheetH() + 28] });
    function centerOn(lat, lon, zoom, animate = true) {
      const z = zoom ?? map.getZoom();
      const pt = map.project([lat, lon], z).add([0, sheetH() / 2]); // trên điện thoại, tâm nhìn nằm phía trên tấm danh sách
      map.setView(map.unproject(pt, z), z, { animate: animate && !reduceMotion.matches });
    }
    function fitAll(animate = true) {
      let pts = [];
      for (const r of S.fos.values()) if (r.shown && r.visible && r.status !== 'offline') pts.push([r.shown.lat, r.shown.lon]);
      if (!pts.length) for (const r of S.fos.values()) if (r.shown) pts.push([r.shown.lat, r.shown.lon]);
      if (!pts.length) for (const s of S.sites.values()) pts.push([s.lat, s.lon]);
      if (!pts.length) return map.setView(HCMC, 12);
      map.fitBounds(L.latLngBounds(pts), { maxZoom: 16, animate: animate && !reduceMotion.matches, ...fitPad() });
    }
    function fitOverview() { // lần đầu mở: thấy cả FO đang chạy lẫn các điểm giao nhận
      const pts = [];
      for (const r of S.fos.values()) if (r.shown) pts.push([r.shown.lat, r.shown.lon]);
      for (const s of S.sites.values()) pts.push([s.lat, s.lon]);
      if (pts.length) map.fitBounds(L.latLngBounds(pts), { maxZoom: 15, animate: false, ...fitPad() });
    }
    q('.b-fit').addEventListener('click', () => { setFollow(false); fitAll(); });
    const btnTrail = q('.b-trail');
    btnTrail.textContent = TRAIL_LABEL[S.trailMode];
    btnTrail.addEventListener('click', () => {
      S.trailMode = { all: 'sel', sel: 'off', off: 'all' }[S.trailMode];
      btnTrail.textContent = TRAIL_LABEL[S.trailMode];
      for (const r of S.fos.values()) paintLine(r);
    });
    function paintSites() {
      siteLayer.clearLayers();
      for (const s of S.sites.values()) {
        const m = L.marker([s.lat, s.lon], { interactive: S.tab === 'sites', keyboard: false, zIndexOffset: -1000, icon: siteIcon(s.name, s.type) });
        if (S.tab === 'sites') m.on('click', () => ARL.opsSiteDialog(ctx, s));
        m.addTo(siteLayer);
      }
    }

    // ───────────── Dấu FO + vệt đường ─────────────
    function statusOf(r, t) {
      if (!r.last) return 'offline';
      const age = (t - r.last.ts) / 1000;
      if (!r.onShift || age >= S.cfg.offlineSec) return 'offline';
      if (age >= S.cfg.staleSec) return 'stale';
      return (r.last.spd || 0) >= MOVING_MPS ? 'moving' : 'stopped';
    }
    function ensureMarker(r) {
      if (r.marker || !r.last) return;
      r.shown = { lat: r.last.lat, lon: r.last.lon };
      r.marker = L.marker([r.last.lat, r.last.lon], { keyboard: false, icon: L.divIcon({ className: 'rm-wrap', iconSize: [34, 34], iconAnchor: [17, 17], html: `<div class="rm" style="--c:${r.color}"><i class="rm-dir"></i><b class="rm-dot"></b><i class="rm-badge"></i><span class="rm-tag"></span></div>` }) });
      r.marker.on('click', () => { if (S.tab !== 'live') go('live'); select(r.id); });
      r.line = L.polyline([], { pane: 'trails', color: r.color, weight: 4, opacity: 0.55, lineJoin: 'round', interactive: false });
      r.painted = false;
    }
    function paintMarker(r) {
      if (!r.marker) return;
      const show = r.visible !== false;
      if (show && !map.hasLayer(r.marker)) r.marker.addTo(map);
      if (!show && map.hasLayer(r.marker)) r.marker.remove();
      const m = r.marker.getElement() && r.marker.getElement().firstElementChild;
      if (m) {
        const isSel = S.sel === r.id;
        m.dataset.st = r.status;
        m.classList.toggle('sel', isSel);
        m.style.setProperty('--c', r.color);
        if (r.last.hdg === null || r.last.hdg === undefined) m.dataset.nohdg = '1'; else { delete m.dataset.nohdg; m.style.setProperty('--h', r.last.hdg + 'deg'); }
        m.children[1].textContent = r.initials;
        m.children[2].textContent = r.status === 'stale' ? '!' : '';
        m.children[3].textContent = r.short;
        r.marker.setZIndexOffset(isSel ? 2000 : r.status === 'offline' ? -600 : r.status === 'moving' ? 200 : 0);
      }
    }
    function paintLine(r, upto) {
      if (!r.line) return;
      const isSel = S.sel === r.id;
      const show = r.visible !== false && r.status !== 'offline' && !S.hist && (S.trailMode === 'all' || (S.trailMode === 'sel' && isSel));
      if (!show) { if (map.hasLayer(r.line)) r.line.remove(); return; }
      const n = upto ?? r.trail.length, pts = [];
      for (let i = 0; i < n; i++) pts.push([r.trail[i][0], r.trail[i][1]]);
      r.line.setLatLngs(pts);
      r.line.setStyle({ weight: isSel ? 5 : 4, opacity: isSel ? 0.9 : 0.5 });
      if (!map.hasLayer(r.line)) r.line.addTo(map);
    }
    function trimTrail(r, t) {
      const cut = t - S.cfg.trailMinutes * 60000;
      let k = 0;
      while (k < r.trail.length - 1 && r.trail[k][2] < cut) k++;
      if (k) r.trail.splice(0, k);
    }
    // Dấu trượt mượt giữa 2 lần cập nhật thay vì nhảy cóc.
    let rafOn = false, alive = true;
    function frame(t) {
      if (!alive) return;
      let busy = false;
      for (const r of S.fos.values()) {
        const a = r.anim;
        if (!a) continue;
        const k = Math.min(1, (t - a.t0) / a.dur);
        r.shown = { lat: a.fromLat + (a.toLat - a.fromLat) * k, lon: a.fromLon + (a.toLon - a.fromLon) * k };
        r.marker.setLatLng([r.shown.lat, r.shown.lon]);
        if (k >= 1) { r.anim = null; paintLine(r); } else busy = true;
      }
      if (busy) requestAnimationFrame(frame); else rafOn = false;
    }
    function settle() { // tab bị ẩn rồi mở lại: đưa mọi dấu về đúng vị trí mới nhất
      for (const r of S.fos.values()) {
        if (!r.marker || !r.last) continue;
        r.anim = null;
        r.shown = { lat: r.last.lat, lon: r.last.lon };
        r.marker.setLatLng([r.shown.lat, r.shown.lon]);
        paintLine(r);
      }
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { settle(); render(); } }, { signal: ac.signal });

    function upsert(d) {
      let r = S.fos.get(d.id);
      if (!r) { r = { id: d.id, trail: [], marker: null, line: null, shown: null, anim: null, status: 'offline', visible: true, last: null }; S.fos.set(d.id, r); }
      r.name = d.name; r.phone = d.phone || ''; r.vehicle = d.vehicle || ''; r.color = safeColor(d.color); r.onShift = !!d.onShift; r.consent_ok = d.consent_ok !== false;
      Object.assign(r, nameParts(r.name));
      if ('last' in d) r.last = d.last;
      if (Array.isArray(d.trail)) r.trail = d.trail.slice();
      ensureMarker(r);
      if (r.line) r.line.setStyle({ color: r.color });
      r.painted = false;
      return r;
    }
    function dropFo(id) {
      const r = S.fos.get(id);
      if (!r) return;
      if (r.marker) r.marker.remove();
      if (r.line) r.line.remove();
      S.fos.delete(id);
      const row = rows.get(id);
      if (row) { row.li.remove(); rows.delete(id); }
      if (S.sel === id) showRoster();
    }
    function onPos(u) {
      const r = S.fos.get(u.id);
      if (!r) return;
      const prev = r.last;
      r.last = { ts: u.ts, lat: u.lat, lon: u.lon, spd: u.spd, hdg: u.hdg, acc: u.acc, bat: u.bat };
      const tail = r.trail[r.trail.length - 1];
      const grew = !tail || distM(tail[0], tail[1], u.lat, u.lon) >= 10;
      if (grew) r.trail.push([u.lat, u.lon, u.ts]);
      trimTrail(r, u.ts);
      ensureMarker(r);
      const gap = distM(r.shown.lat, r.shown.lon, u.lat, u.lon);
      if (prev && !document.hidden && !reduceMotion.matches && gap > 0.5 && gap < 1500) {
        r.anim = { fromLat: r.shown.lat, fromLon: r.shown.lon, toLat: u.lat, toLon: u.lon, t0: performance.now(), dur: Math.max(400, Math.min(5000, u.ts - prev.ts)) };
        paintLine(r, grew ? r.trail.length - 1 : undefined); // vệt chỉ vẽ tới điểm dấu đã đi qua
        if (!rafOn) { rafOn = true; requestAnimationFrame(frame); }
      } else {
        r.anim = null;
        r.shown = { lat: u.lat, lon: u.lon };
        r.marker.setLatLng([u.lat, u.lon]);
        paintLine(r);
      }
      if (r.painted) paintMarker(r); // xoay mũi tên theo hướng mới
      if (S.follow && S.sel === r.id && !S.hist) centerOn(u.lat, u.lon);
    }

    // ───────────── Danh sách FO + bộ lọc ─────────────
    const rows = new Map();
    const rosterEl = q('.roster'), filtersEl = q('.filters');
    const FILTERS = [['all', 'Tất cả'], ['moving', ST.moving], ['stopped', ST.stopped], ['stale', ST.stale], ['offline', ST.offline]];
    filtersEl.innerHTML = FILTERS.map(([f, label]) => `<button type="button" data-f="${f}" aria-pressed="${f === 'all'}"><b>0</b><span>${label}</span></button>`).join('');
    filtersEl.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      S.filter = S.filter === b.dataset.f ? 'all' : b.dataset.f;
      for (const x of filtersEl.children) x.setAttribute('aria-pressed', String(x.dataset.f === S.filter));
      if (isMobile.matches && v.classList.contains('sheet-peek') && S.filter !== 'all') setSheet(true);
      render();
    });
    q('.q').addEventListener('input', (e) => { S.q = e.target.value.trim().toLowerCase(); render(); });
    rosterEl.addEventListener('click', (e) => { const b = e.target.closest('.row'); if (b) select(+b.dataset.id); });
    const runningOf = (foId) => { for (const t of S.tasks.values()) if (t.fo_id === foId && t.status === 'in_progress') return t; return null; };
    function rowFor(r) {
      let row = rows.get(r.id);
      if (!row) {
        const li = document.createElement('li');
        li.innerHTML = '<button type="button" class="row"><span class="sw"></span><span class="nm"><span></span><small></small></span><span class="meta"><b></b><small></small></span></button>';
        const btn = li.firstElementChild;
        btn.dataset.id = r.id;
        row = { li, btn, sw: btn.children[0], nm: btn.children[1].children[0], sub: btn.children[1].children[1], main: btn.children[2].children[0], age: btn.children[2].children[1] };
        rows.set(r.id, row);
      }
      return row;
    }
    function describe(r, t) {
      if (!r.last) return ['Ngoài ca', r.consent_ok ? 'Chưa có vị trí' : 'Chưa đồng ý điều khoản'];
      const age = (t - r.last.ts) / 1000;
      switch (r.status) {
        case 'moving': return [`${kmh(r.last.spd)} km/h`, ago(age)];
        case 'stopped': {
          const t0 = r.trail.length ? r.trail[r.trail.length - 1][2] : r.last.ts, still = (t - t0) / 1000;
          return [still < 60 ? 'Vừa dừng' : `Dừng ${span(still)}`, ago(age)];
        }
        case 'stale': return ['Mất sóng', ago(age)];
        default: return ['Ngoài ca', r.consent_ok ? `Lần cuối ${age < 86400 ? fmtHM(r.last.ts) : ago(age)}` : 'Chưa đồng ý điều khoản'];
      }
    }
    let orderKey = '';
    function render() {
      if (!S.cfg) return;
      const t = srvNow();
      const counts = { all: 0, moving: 0, stopped: 0, stale: 0, offline: 0 }, list = [];
      for (const r of S.fos.values()) {
        const st = statusOf(r, t);
        const vis = S.filter === 'all' || S.filter === st || S.sel === r.id;
        const changed = st !== r.status || vis !== r.visible;
        r.status = st; r.visible = vis;
        counts.all++; counts[st]++;
        if (changed || !r.painted) { paintMarker(r); if (!r.anim) paintLine(r); r.painted = true; }
        if ((S.filter === 'all' || S.filter === st) && (!S.q || r.name.toLowerCase().includes(S.q) || r.vehicle.toLowerCase().includes(S.q))) list.push(r);
      }
      for (const b of filtersEl.children) b.firstElementChild.textContent = counts[b.dataset.f];
      list.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name, 'vi'));
      for (const r of list) {
        const row = rowFor(r), [main, sub] = describe(r, t), run = runningOf(r.id);
        row.btn.dataset.st = r.status;
        row.sw.style.setProperty('--c', r.color);
        if (row.nm.textContent !== r.name) row.nm.textContent = r.name;
        const p = run ? progressOf(run) : null;
        const subText = run ? `${run.code} · ${p.done}/${p.total} điểm` : r.vehicle || r.phone || '';
        if (row.sub.textContent !== subText) row.sub.textContent = subText;
        row.sub.classList.toggle('run', !!run);
        if (row.main.textContent !== main) row.main.textContent = main;
        if (row.age.textContent !== sub) row.age.textContent = sub;
      }
      const key = list.map((r) => r.id).join(',');
      if (key !== orderKey) { orderKey = key; rosterEl.replaceChildren(...list.map((r) => rows.get(r.id).li)); } // chỉ sắp lại DOM khi thứ tự đổi → không mất focus
      const empty = q('.empty');
      empty.hidden = list.length > 0;
      if (!list.length) empty.textContent = !S.fos.size ? (isLead ? 'Chưa có FO nào. Vào “Tài khoản” để tạo tài khoản FO đầu tiên.' : 'Chưa có FO nào trong hệ thống.') : S.q ? `Không có FO nào khớp “${S.q}”.` : `Không có FO nào ở trạng thái “${ST[S.filter]}”.`;
      if (S.sel !== null) paintDetail(t);
      if (S.tab === 'tasks') tickTasks();
    }

    // ───────────── Chi tiết FO + bám theo + lộ trình ─────────────
    function setFollow(on) {
      if (S.follow === on) return;
      S.follow = on;
      q('.b-follow').setAttribute('aria-pressed', String(on));
      q('.b-follow').textContent = on ? 'Đang bám theo' : 'Bám theo';
    }
    function select(id) {
      const r = S.fos.get(id);
      if (!r) return;
      const prev = S.fos.get(S.sel);
      clearHistory();
      S.sel = id;
      if (prev) paintMarker(prev);
      q('.view-roster').hidden = true; q('.view-detail').hidden = false;
      v.dataset.view = 'detail';
      setSheet(false);
      q('.h-date').value = today();
      r.visible = true;
      paintMarker(r);
      paintDetail(srvNow());
      paintFoTasks();
      setFollow(!!r.last);
      if (r.shown) centerOn(r.shown.lat, r.shown.lon, Math.max(map.getZoom(), 15));
      for (const x of S.fos.values()) paintLine(x);
    }
    function showRoster() {
      const prev = S.fos.get(S.sel);
      clearHistory();
      S.sel = null;
      setFollow(false);
      v.dataset.view = 'roster';
      q('.view-roster').hidden = false; q('.view-detail').hidden = true;
      if (prev) paintMarker(prev);
      for (const x of S.fos.values()) paintLine(x);
      render();
    }
    q('.back').addEventListener('click', showRoster);
    q('.b-follow').addEventListener('click', () => {
      const r = S.fos.get(S.sel);
      if (!S.follow && r && r.shown) { clearHistory(); setFollow(true); centerOn(r.shown.lat, r.shown.lon, Math.max(map.getZoom(), 15)); } else setFollow(false);
    });
    function paintDetail(t) {
      const r = S.fos.get(S.sel);
      if (!r) return;
      q('.d-sw').style.setProperty('--c', r.color);
      q('.d-name').textContent = r.name;
      q('.d-vehicle').textContent = [r.vehicle, r.phone].filter(Boolean).join(' — ') || 'Chưa có biển số';
      const pill = q('.d-status');
      pill.dataset.st = r.status; pill.textContent = ST[r.status];
      const l = r.last;
      q('.d-speed').textContent = l && (r.status === 'moving' || r.status === 'stopped') ? `${kmh(l.spd)} km/h` : '–';
      q('.d-age').textContent = l ? ago((t - l.ts) / 1000) : 'Chưa có vị trí';
      q('.d-bat').textContent = l && l.bat !== null && l.bat !== undefined ? `${Math.round(l.bat * 100)}%` : '–';
      q('.d-acc').textContent = l && l.acc !== null && l.acc !== undefined ? `± ${l.acc} m` : '–';
      const call = q('.b-call'), gm = q('.b-gmaps'), tel = telHref(r.phone);
      call.hidden = !tel; if (tel) call.href = tel;
      gm.hidden = !l; if (l) gm.href = gmapsAt(l.lat, l.lon);
      q('.b-follow').disabled = !l;
    }
    function paintFoTasks() {
      const ul = q('.mini-tasks');
      if (S.sel === null) return;
      const list = [...S.tasks.values()].filter((t) => t.fo_id === S.sel && t.date === today()).sort((a, b) => a.start_at - b.start_at);
      ul.innerHTML = list.length ? '' : '<li class="sub">Hôm nay FO này chưa có task.</li>';
      for (const t of list) {
        const p = progressOf(t), li = el(`<li><button type="button" class="mini"><b>${esc(t.code)}</b><span>${esc(t.title)}</span><small data-ts="${t.status}">${esc(TASK_ST[t.status])} · ${p.done}/${p.total} điểm · ${esc(slaOf(t).text)}</small></button></li>`);
        li.firstElementChild.addEventListener('click', () => openTask(t.id));
        ul.append(li);
      }
    }
    function clearHistory() {
      if (!S.hist) return;
      S.hist.layers.forEach((l) => l.remove());
      S.hist = null;
      for (const c of ['.h-info', '.h-scrub', '.h-at', '.b-hist-close']) q(c).hidden = true;
      for (const x of S.fos.values()) paintLine(x);
    }
    async function loadHistory() {
      const r = S.fos.get(S.sel), day = q('.h-date').value;
      if (!r || !day) return;
      const info = q('.h-info');
      clearHistory();
      info.hidden = false; info.textContent = 'Đang tải lộ trình…';
      let j;
      try { j = await api('GET', '/api/history', null, { fo: r.id, date: day }); } catch (e) { info.textContent = e.message; return; }
      if (S.sel !== r.id) return;
      const pts = j.pts || [];
      if (!pts.length) { info.textContent = 'Không có dữ liệu vị trí trong ngày này.'; return; }
      let km = 0, moveSec = 0, anchor = pts[0];
      for (let i = 1; i < pts.length; i++) {
        const d = distM(anchor[1], anchor[2], pts[i][1], pts[i][2]), dt = (pts[i][0] - anchor[0]) / 1000;
        if (d >= 15) { km += d / 1000; if (dt <= 300) moveSec += dt; anchor = pts[i]; } // cùng cách tính với máy chủ: bỏ rung GPS khi đứng yên
      }
      const ll = pts.map((p) => [p[1], p[2]]);
      const layers = [
        L.polyline(ll, { pane: 'history', color: '#fff', weight: 8, opacity: 0.9, interactive: false }),
        L.polyline(ll, { pane: 'history', color: '#14213D', weight: 4, opacity: 0.95, interactive: false }),
        L.marker(ll[0], { icon: pinIcon('A', 'dark'), interactive: false, keyboard: false }),
        L.marker(ll[ll.length - 1], { icon: pinIcon('B', 'dark'), interactive: false, keyboard: false }),
      ];
      const ghost = L.marker(ll[ll.length - 1], { icon: L.divIcon({ className: '', iconSize: [16, 16], iconAnchor: [8, 8], html: '<div class="hghost"></div>' }), interactive: false, keyboard: false, zIndexOffset: 3000 });
      layers.push(ghost);
      layers.forEach((l) => l.addTo(map));
      S.hist = { layers, pts, ghost };
      setFollow(false);
      for (const x of S.fos.values()) paintLine(x);
      info.textContent = `${km.toFixed(1).replace('.', ',')} km, di chuyển ${span(moveSec)}, từ ${fmtHM(pts[0][0])} đến ${fmtHM(pts[pts.length - 1][0])}.`;
      const scrub = q('.h-scrub');
      scrub.max = pts.length - 1; scrub.value = pts.length - 1; scrub.hidden = pts.length < 2;
      q('.b-hist-close').hidden = false;
      scrubTo(pts.length - 1);
      map.fitBounds(L.latLngBounds(ll), { maxZoom: 17, ...fitPad() });
    }
    function scrubTo(i) {
      if (!S.hist) return;
      const p = S.hist.pts[i];
      S.hist.ghost.setLatLng([p[1], p[2]]);
      const at = q('.h-at');
      at.hidden = false; at.textContent = `Lúc ${fmtHM(p[0], true)}: ${kmh(p[3])} km/h`;
    }
    q('.b-hist').addEventListener('click', loadHistory);
    q('.b-hist-close').addEventListener('click', clearHistory);
    q('.h-scrub').addEventListener('input', (e) => scrubTo(+e.target.value));

    // ───────────── Task: danh sách ─────────────
    const TFILTER = [['all', 'Tất cả'], ['run', 'Đang chạy'], ['wait', 'Chờ'], ['done', 'Xong'], ['issue', 'Có vấn đề']];
    const tfEl = q('.t-filter');
    tfEl.innerHTML = TFILTER.map(([k, label]) => `<button type="button" class="chip" data-k="${k}" aria-pressed="${k === 'all'}"><span>${label}</span> <b>0</b></button>`).join('');
    tfEl.addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (!b) return; S.taskFilter = b.dataset.k; for (const x of tfEl.children) x.setAttribute('aria-pressed', String(x.dataset.k === S.taskFilter)); renderTasks(); });
    const hasIssue = (t) => t.status === 'failed' || t.late || t.partial || t.status === 'unassigned' || (isOpen(t) && slaOf(t).key === 'late') || t.stops.some((s) => s.bo_status === 'mismatch' || s.bo_status === 'pending' || s.status === 'failed');
    const TMATCH = { all: () => true, run: (t) => t.status === 'in_progress', wait: (t) => ['unassigned', 'assigned', 'accepted'].includes(t.status), done: (t) => !isOpen(t), issue: hasIssue };
    const tDate = q('.t-date');
    tDate.value = S.date;
    async function loadTasks(date) {
      S.date = date; tDate.value = date;
      try {
        const j = await api('GET', '/api/tasks', null, { date });
        for (const [id, t] of S.tasks) if (t.date === date) S.tasks.delete(id);
        for (const t of j.tasks) S.tasks.set(t.id, t);
        if (j.conditions) setConditions(j.conditions);
      } catch (e) { toast(e.message, true); }
      renderTasks(); paintFoTasks(); render();
    }
    tDate.addEventListener('change', () => { if (tDate.value) { closeTask(); loadTasks(tDate.value); } });
    q('.t-today').addEventListener('click', () => { closeTask(); loadTasks(today()); });
    q('.b-new-task').addEventListener('click', () => ARL.opsTaskEditor(ctx, null));
    const tlist = q('.tlist');
    tlist.addEventListener('click', (e) => { const b = e.target.closest('.tcard'); if (b) openTask(+b.dataset.id); });
    function taskCard(t) {
      const p = progressOf(t), sla = slaOf(t);
      return `<li><button type="button" class="tcard" data-id="${t.id}" data-ts="${t.status}">
        <span class="tc-top"><b>${esc(t.code)}</b><span class="pill sm" data-ts="${t.status}">${esc(TASK_ST[t.status])}</span></span>
        <span class="tc-title">${esc(t.title)}${t.round_trip ? ' <i class="tag">2 chiều</i>' : ''}${t.template_id ? ' <i class="tag">định kỳ</i>' : ''}${t.route_src ? ` <i class="tag" title="SLA tính theo đường đi thực tế">${t.route_src === 'google' ? 'đường Google Maps' : 'đường thực tế'}</i>` : ''}</span>
        <span class="tc-meta"><span class="who-sm">${t.fo ? `<i class="sw" style="--c:${safeColor(t.fo.color)}"></i>${esc(t.fo.name)}` : '<i class="sw none"></i>Chưa giao'}</span><span>${fmtHM(t.start_at)} → ${fmtHM(t.due_at)}</span></span>
        <span class="tc-meta"><span class="bar"><i style="width:${p.total ? Math.round((p.done / p.total) * 100) : 0}%"></i></span><span class="cnt">${p.done}/${p.total} điểm</span><span class="sla" data-sla="${sla.key}">${esc(sla.text)}</span></span>
      </button></li>`;
    }
    function renderTasks() {
      const all = [...S.tasks.values()].filter((t) => t.date === S.date).sort((a, b) => a.start_at - b.start_at || a.id - b.id);
      for (const b of tfEl.children) b.lastElementChild.textContent = all.filter(TMATCH[b.dataset.k]).length;
      const list = all.filter(TMATCH[S.taskFilter]);
      tlist.innerHTML = list.map(taskCard).join('');
      const empty = q('.t-empty');
      empty.hidden = list.length > 0;
      if (!list.length) empty.textContent = all.length ? 'Không có task nào khớp bộ lọc này.' : `Chưa có task nào cho ${fmtDate(S.date)}. Bấm “+ Tạo task” để giao việc cho FO.`;
    }
    function tickTasks() { // cập nhật dòng "còn X phút / quá hạn" mà không vẽ lại cả danh sách
      for (const c of $$('.tcard', tlist)) {
        const t = S.tasks.get(+c.dataset.id);
        if (!t) continue;
        const sla = slaOf(t), sEl = $('.sla', c);
        if (sEl.textContent !== sla.text) { sEl.textContent = sla.text; sEl.dataset.sla = sla.key; }
      }
      const live = q('.td-sla');
      if (live && S.selTask) { const t = S.tasks.get(S.selTask); if (t) { const s = slaOf(t); live.textContent = s.text; live.dataset.sla = s.key; } }
    }

    // ───────────── Task: chi tiết ─────────────
    const tdEl = q('.view-tdetail');
    let routeSeq = 0;
    /** Ghim các điểm của task ngay; rồi vẽ đường đi thực tế (tải theo route_at, có nhớ), chưa có thì nối thẳng nét đứt như trước. */
    function drawTaskRoute(t) {
      const my = ++routeSeq;
      routeLayer.clearLayers();
      if (!t) { S.route = null; S.routeFor = null; S.routeBounds = null; S.fitFor = null; return; }
      t.stops.forEach((s, i) => {
        L.circle([s.lat, s.lon], { pane: 'route', radius: s.radius, color: '#1456C8', weight: 1, opacity: 0.5, fillOpacity: 0.06, interactive: false }).addTo(routeLayer);
        L.marker([s.lat, s.lon], { icon: pinIcon(s.is_return ? '↩' : String(i + 1), s.status), keyboard: false, zIndexOffset: 1500 }).bindTooltip(`${i + 1}. ${s.name} — ${STOP_ST[s.status]}`).addTo(routeLayer);
      });
      const draw = (route) => {
        if (my !== routeSeq) return; // đã chuyển sang task khác hoặc có bản mới hơn
        S.route = route; S.routeFor = t.id;
        S.routeBounds = drawRoute(routeLayer, route, { points: t.stops, pane: 'route', ...routeLegs(t) }); // chặng đã đi ẩn, chặng đang đi nét liền, chặng sắp tới nét đứt
        if (S.fitFor === t.id) { S.fitFor = null; fitTask(t); }
        if (S.selTask === t.id) paintRouteNote();
      };
      if (!t.route_src || !t.route_at) return draw(null);
      taskRoute(t.id, t.route_at).then((j) => draw(j.stale ? null : j.route), () => draw(null));
    }
    function fitTask(t) {
      const pts = t.stops.map((s) => [s.lat, s.lon]);
      const r = t.fo_id ? S.fos.get(t.fo_id) : null;
      if (r && r.shown && isOpen(t)) pts.push([r.shown.lat, r.shown.lon]);
      if (!pts.length) return;
      const b = L.latLngBounds(pts);
      if (S.routeFor === t.id && S.routeBounds && S.routeBounds.isValid()) b.extend(S.routeBounds); // đường phố có thể vòng ra ngoài khung các điểm
      map.fitBounds(b, { maxZoom: 16, ...fitPad() });
    }
    async function openTask(id) {
      if (S.tab !== 'tasks') go('tasks');
      let t = S.tasks.get(id);
      S.selTask = id;
      q('.view-tlist').hidden = true; tdEl.hidden = false;
      setSheet(true);
      // Thu phóng sau khi vẽ xong đường (có trong bộ nhớ thì ngay lập tức) để thấy trọn đường đi.
      if (t) { S.taskEvents = []; renderTaskDetail(); setFollow(false); S.fitFor = id; drawTaskRoute(t); } else tdEl.innerHTML = '<p class="empty">Đang tải…</p>';
      try {
        const j = await api('GET', `/api/tasks/${id}`);
        if (S.selTask !== id) return;
        S.tasks.set(id, j.task); S.taskEvents = j.events || [];
        renderTaskDetail();
        if (!t) S.fitFor = id;
        drawTaskRoute(j.task);
      } catch (e) { if (S.selTask === id && !t) tdEl.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
    }
    function closeTask() {
      S.selTask = null;
      q('.view-tlist').hidden = false; tdEl.hidden = true;
      drawTaskRoute(null);
    }
    function stopHtml(s, i) {
      const plan = countsText(s.exp_cards_out, s.exp_cards_in, s.exp_dev_out, s.exp_dev_in), actual = s.status === 'done' ? countsText(s.cards_out, s.cards_in, s.dev_out, s.dev_in) : '';
      const diff = s.status === 'done' && !s.is_return && plan !== actual;
      const lines = [];
      if (s.address) lines.push(`<p class="sub">${esc(s.address)}</p>`);
      if (plan) lines.push(`<p class="sub">Kế hoạch: ${esc(plan)}</p>`);
      if (s.note) lines.push(`<p class="sub">Ghi chú: ${esc(s.note)}</p>`);
      if (s.status === 'arrived') lines.push(`<p class="sub">Đến lúc ${fmtHM(s.arrived_at)}${s.arrive_mode === 'manual' ? ' (FO bấm tay)' : ''}</p>`);
      if (s.status === 'done') lines.push(`<p class="${diff ? 'warn-t' : 'sub'}">Xong lúc ${fmtHM(s.done_at)}${actual ? ` · FO báo: ${esc(actual)}` : ''}${diff ? ' (khác kế hoạch)' : ''}${s.proof_dist !== null && s.proof_dist > 400 ? ` · xác nhận khi cách điểm ${s.proof_dist} m` : ''}</p>`);
      if (s.fo_note) lines.push(`<p class="sub">FO ghi: ${esc(s.fo_note)}</p>`);
      if (s.status === 'failed') lines.push(`<p class="err">Không giao được lúc ${fmtHM(s.done_at)}: ${esc(s.fail_reason)}</p>`);
      if (s.status === 'skipped') lines.push(`<p class="sub">Bỏ qua lúc ${fmtHM(s.done_at)}: ${esc(s.fail_reason || 'Logistics đã gỡ hết việc ở điểm này')}</p>`);
      const t = S.tasks.get(S.selTask), boOpen = !!s.bo_req && s.status !== 'failed' && s.status !== 'skipped' && (s.bo_status === 'none' || s.bo_status === 'pending') && !!t && isOpen(t);
      if (s.bo_status === 'pending') lines.push('<p class="err">FO đang chờ BO xác nhận – chưa đi tiếp được</p>');
      if (s.bo_status === 'waived') lines.push(`<p class="warn-t">Logistic cho qua xác nhận của BO lúc ${fmtHM(s.bo_at)}: ${esc(s.bo_waive_reason || '')}</p>`);
      if (boOpen) lines.push(`<p class="sub bo-link-st">Link BO: ${s.bo_link ? (s.bo_link.opened_at ? `BO đã mở lúc ${fmtHM(s.bo_link.opened_at)}` : `đã tạo lúc ${fmtHM(s.bo_link.at)}, BO chưa mở`) : '<b>chưa tạo</b>'}</p><div class="actions"><button type="button" class="b-bolink">${s.bo_link ? 'Tạo lại link BO' : 'Tạo link cho BO'}</button>${s.bo_status === 'pending' ? '<button type="button" class="ghost danger b-bowaive">Cho qua</button>' : ''}</div>`);
      if (s.bo_status === 'confirmed') lines.push(`<p class="ok-t">BO đã xác nhận đủ lúc ${fmtHM(s.bo_at)}${s.bo_note ? ` · ${esc(s.bo_note)}` : ''}</p>`);
      if (s.bo_status === 'mismatch') lines.push(`<p class="err">BO báo lệch: nhận ${s.bo_cards_recv} thẻ, giao ${s.bo_cards_given} thẻ, nhận ${s.bo_dev_recv} TB, giao ${s.bo_dev_given} TB${s.bo_note ? ` · ${esc(s.bo_note)}` : ''}</p>`);
      return `<li class="stop" data-ss="${s.status}" data-i="${i}"><span class="num">${s.is_return ? '↩' : i + 1}</span><div class="stop-body"><div class="stop-head"><b>${esc(s.name)}</b><span class="pill sm" data-ss="${s.status}">${STOP_ST[s.status]}</span></div>${lines.join('')}<div class="ph"></div></div></li>`;
    }
    const noDot = (s) => String(s || '').replace(/[.\s]+$/, '');
    /** Đường đi + SLA của task: dự kiến xong (đang chạy), nguồn đường đi hoặc "Đang tính…", giải thích SLA, lỗi lấy đường, chú thích màu, cảnh báo beta. */
    function routeBlock(t, open) {
      const out = [], busy = !!(ARL.cfg && ARL.cfg.routing) && open && !t.route_src && !t.route_err && t.stops.length >= 2;
      if (t.status === 'in_progress' && t.eta_at && t.eta_at > now() - 120000) { // dự kiến đã qua mà chưa xong: số cũ (FO mất sóng), không hiện
        const late = Math.round((t.eta_at - t.due_at) / 60000);
        out.push(`<p class="rt-eta" data-late="${late > 0 ? 1 : 0}">Dự kiến xong ${fmtHM(t.eta_at)}${late > 0 ? ` · có thể trễ ~${late} phút so với hạn` : ' · kịp hạn'}</p>`);
      }
      const src = routeText(t);
      if (src) out.push(`<p class="rt-src">${esc(src)}</p>`); else if (busy) out.push('<p class="rt-src rt-busy">Đang tính đường thực tế…</p>');
      out.push(`<p class="rt-bd">${esc(slaBreakdown(t))}</p>`);
      if (t.route_err) out.push(`<p class="warn-t">${t.route_src ? `Chưa tính lại được đường: ${esc(noDot(t.route_err))}. Vẫn dùng đường đã tính lúc ${fmtHM(t.route_at)}.` : `Chưa lấy được đường đi thực tế: ${esc(noDot(t.route_err))}. SLA tạm tính theo đường chim bay.`}</p>`);
      if (t.route_src && hasTraffic(t)) out.push('<div class="rt-lg"></div>');
      out.push('<p class="rt-note" hidden></p>');
      return `<div class="rt-box pad">${out.join('')}</div>`;
    }
    /** Cảnh báo kèm đường đi (beta đường xe máy của Google): lấy từ đường đã tải, chưa tải thì suy từ task. */
    function paintRouteNote() {
      const n = $('.rt-note', tdEl), t = S.tasks.get(S.selTask);
      if (!n || !t) return;
      const txt = t.route_src ? routeNote(S.routeFor === t.id && S.route ? S.route : t) : '';
      n.textContent = txt; n.hidden = !txt;
    }
    async function reroute(t) {
      if (S.rerouting) return;
      S.rerouting = t.id; renderTaskDetail();
      try {
        const j = await api('POST', `/api/tasks/${t.id}/reroute`);
        S.rerouting = null;
        onTask(j.task);
        if (j.task.route_err) toast(`Chưa tính lại được đường: ${noDot(j.task.route_err)}.`, true); else toast(hasTraffic(j.task) ? 'Đã tính lại đường đi theo giao thông hiện tại' : 'Đã tính lại đường đi');
      } catch (e) { S.rerouting = null; toast(e.message, true); if (S.selTask === t.id) renderTaskDetail(); }
    }
    function renderTaskDetail() {
      const t = S.tasks.get(S.selTask);
      if (!t) return;
      const sla = slaOf(t), p = progressOf(t), open = isOpen(t);
      const life = [t.started_at ? `FO bắt đầu lúc ${fmtHM(t.started_at)}.` : '', t.finished_at ? `Kết thúc lúc ${fmtHM(t.finished_at)}.` : '', t.cancel_reason ? `Lý do huỷ: ${esc(t.cancel_reason)}.` : ''].filter(Boolean).join(' ');
      const canReroute = open && !!(ARL.cfg && ARL.cfg.routing) && t.stops.length >= 2, rerouting = S.rerouting === t.id;
      tdEl.innerHTML = `
        <header class="top"><button class="ghost back" type="button">‹ Danh sách task</button><span class="pill" data-ts="${t.status}">${esc(TASK_ST[t.status])}</span></header>
        <div class="td-head"><h2>${esc(t.title)}</h2><p class="sub">${esc(t.code)} · ${fmtDate(t.date)}${t.round_trip ? ' · hai chiều' : ''}${t.template_id ? ' · từ tuyến định kỳ' : ''}</p></div>
        <dl class="stats">
          <div><dt>FO</dt><dd class="who-sm">${t.fo ? `<i class="sw" style="--c:${safeColor(t.fo.color)}"></i>${esc(t.fo.name)}` : 'Chưa giao'}</dd></div>
          <div><dt>Hạn (SLA)</dt><dd><span class="td-sla sla" data-sla="${sla.key}">${esc(sla.text)}</span></dd></div>
          <div><dt>Bắt đầu → hạn</dt><dd>${fmtHM(t.start_at)} → ${fmtHM(t.due_at)}</dd></div>
          <div><dt>Quãng đường</dt><dd>${!open && t.km ? fmtKm(t.km) + ' thực tế' : '≈ ' + fmtKm(t.plan_km) + (t.km >= 0.1 ? ` · đã chạy ${fmtKm(t.km)}` : '')}</dd></div>
        </dl>
        ${routeBlock(t, open)}
        ${life ? `<p class="sub pad rt-life">${life}</p>` : ''}
        ${t.note ? `<p class="note pad">${esc(t.note)}</p>` : ''}
        <div class="actions">${open ? '<button type="button" class="b-assign">Giao lại</button><button type="button" class="b-edit">Sửa</button><button type="button" class="danger b-cancel">Huỷ task</button>' : ''}${t.fo && telHref(t.fo.phone) ? `<a class="btn" href="${telHref(t.fo.phone)}">Gọi FO</a>` : ''}<button type="button" class="b-fitt">Xem trên bản đồ</button>${canReroute ? `<button type="button" class="b-reroute" title="Lấy lại đường đi theo giao thông hiện tại" ${rerouting ? 'disabled' : ''}>${rerouting ? 'Đang tính lại đường…' : 'Tính lại đường'}</button>` : ''}</div>
        <h3 class="pad">Các điểm (${p.done}/${p.total})</h3>
        <ol class="stops">${t.stops.map(stopHtml).join('')}</ol>
        <details class="evs pad"><summary>Nhật ký task (${S.taskEvents.length})</summary><ul>${S.taskEvents.map((e) => `<li data-lv="${e.level}"><time>${fmtHM(e.ts)}</time> ${esc(e.text)}</li>`).join('') || '<li class="sub">Chưa có ghi nhận.</li>'}</ul></details>`;
      t.stops.forEach((s, i) => {
        const li = $(`.stop[data-i="${i}"]`, tdEl);
        if (s.photos.length) $('.ph', li).append(thumbs(s.photos));
        const bl = $('.b-bolink', li), bw = $('.b-bowaive', li);
        if (bl) bl.addEventListener('click', () => ARL.opsBoLinkDialog(ctx, t, s));
        if (bw) bw.addEventListener('click', () => ARL.opsBoWaiveDialog(ctx, t, s));
      });
      $('.back', tdEl).addEventListener('click', () => { closeTask(); renderTasks(); });
      $('.b-fitt', tdEl).addEventListener('click', () => { setSheet(false); fitTask(t); });
      const lg = $('.rt-lg', tdEl), rr = $('.b-reroute', tdEl);
      if (lg) lg.replaceWith(routeLegend());
      if (rr) rr.addEventListener('click', () => reroute(t));
      paintRouteNote();
      if (open) {
        $('.b-assign', tdEl).addEventListener('click', () => ARL.opsAssignDialog(ctx, t));
        $('.b-edit', tdEl).addEventListener('click', () => ARL.opsTaskEditor(ctx, t));
        $('.b-cancel', tdEl).addEventListener('click', () => {
          const body = el('<div class="stack"><p>Huỷ task này? FO sẽ thấy task biến khỏi danh sách việc.</p><label>Lý do (không bắt buộc)<input maxlength="200"></label></div>');
          modal({ title: `Huỷ ${t.code}`, body, cls: 'small', actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, { label: 'Huỷ task', cls: 'primary danger-bg', run: async () => { const j = await api('POST', `/api/tasks/${t.id}/cancel`, { reason: $('input', body).value }); onTask(j.task); toast('Đã huỷ task'); } }] });
        });
      }
    }
    function onTask(t) {
      S.tasks.set(t.id, t);
      if (S.tab === 'tasks') { renderTasks(); if (S.selTask === t.id) { renderTaskDetail(); drawTaskRoute(t); refreshEvents(t.id); } }
      if (S.sel === t.fo_id || S.sel !== null) paintFoTasks();
    }
    let evT = null;
    function refreshEvents(id) { // nhật ký đổi theo task: tải lại nhẹ nhàng, gộp các lần gọi dồn dập
      clearTimeout(evT);
      evT = setTimeout(async () => {
        if (S.selTask !== id || !alive) return;
        try { const j = await api('GET', `/api/tasks/${id}`); if (S.selTask === id) { S.tasks.set(id, j.task); S.taskEvents = j.events || []; const open = $('.evs', tdEl) && $('.evs', tdEl).open; renderTaskDetail(); if (open) $('.evs', tdEl).open = true; } } catch { /* lần sau thử lại */ }
      }, 600);
    }

    // ───────────── Điểm (danh sách bên cạnh bản đồ) ─────────────
    const SITE_TYPE = { bo: 'BO', office: 'Văn phòng / kho', other: 'Khác' };
    let siteQ = '';
    q('.s-q').addEventListener('input', (e) => { siteQ = e.target.value.trim().toLowerCase(); renderSites(); });
    q('.b-new-site').addEventListener('click', () => ARL.opsSiteDialog(ctx, null));
    const slist = q('.slist');
    slist.addEventListener('click', (e) => {
      const b = e.target.closest('.row');
      if (!b) return;
      const s = S.sites.get(+b.dataset.id);
      if (e.target.closest('.s-edit')) return ARL.opsSiteDialog(ctx, s);
      setSheet(false);
      centerOn(s.lat, s.lon, 16);
    });
    function renderSites() {
      const list = [...S.sites.values()].filter((s) => !siteQ || s.name.toLowerCase().includes(siteQ) || (s.address || '').toLowerCase().includes(siteQ)).sort((a, b) => (a.type === 'office' ? -1 : 0) - (b.type === 'office' ? -1 : 0) || a.name.localeCompare(b.name, 'vi'));
      slist.innerHTML = list.map((s) => `<li><div class="row site" data-id="${s.id}" role="button" tabindex="0"><span class="nm"><span>${esc(s.name)}</span><small>${esc(SITE_TYPE[s.type] || '')}${s.address ? ' · ' + esc(s.address) : ''}</small></span><button type="button" class="ghost s-edit">Sửa</button></div></li>`).join('');
      const empty = q('.s-empty');
      empty.hidden = list.length > 0;
      if (!list.length) empty.textContent = S.sites.size ? 'Không có điểm nào khớp.' : 'Chưa có điểm nào. Thêm văn phòng và các BO để tạo task.';
    }

    // ───────────── Điều kiện, cảnh báo, tài khoản (trên thanh điều hướng) ─────────────
    function setConditions(c) {
      S.conditions = c;
      const b = q('.cond');
      b.innerHTML = `<b>×${c.factor}</b><span>${esc(WEATHER[c.weather])}<br>${esc(TRAFFIC[c.traffic])}</span>`;
      b.dataset.hot = c.factor > 1 ? '1' : '0';
    }
    q('.cond').addEventListener('click', () => ARL.opsConditionsDialog(ctx));
    function setBadge(n) {
      S.openAlerts = Math.max(0, n);
      const b = q('.badge');
      b.hidden = !S.openAlerts; b.textContent = S.openAlerts > 99 ? '99+' : String(S.openAlerts);
    }
    q('.acct').innerHTML = `<b>${esc(nameParts(me.user.name).initials)}</b><span>Tài khoản</span>`;
    q('.acct').addEventListener('click', () => ARL.opsAccountDialog(ctx));

    // ───────────── Nhận dữ liệu trực tiếp ─────────────
    function onMsg(m) {
      switch (m.t) {
        case 'hello': if (m.uid && ARL.me && ARL.me.user && m.uid !== ARL.me.user.id) ARL.reboot(); break; // kênh mở bằng phiên của tài khoản khác → mở lại đúng màn hình
        case 'snapshot': {
          ARL.skew = m.now - Date.now();
          S.cfg = m.cfg; ARL.cfg = m.cfg;
          ARL.syncTiles(); // phiên nền Google có thể đã được làm mới
          const seen = new Set();
          for (const d of m.fos) { upsert(d); seen.add(d.id); }
          for (const id of [...S.fos.keys()]) if (!seen.has(id)) dropFo(id);
          settle();
          setConditions(m.conditions);
          const note = q('.demo-note');
          note.hidden = !m.cfg.note; note.textContent = m.cfg.note || '';
          onZoom(); render();
          if (!S.fitted && S.fos.size) { S.fitted = true; fitOverview(); }
          break;
        }
        case 'pos': ARL.skew = m.now - Date.now(); for (const u of m.u) onPos(u); render(); break;
        case 'shift': { const r = S.fos.get(m.id); if (r) { r.onShift = m.on; render(); } break; }
        case 'fo': if (m.op === 'remove') dropFo(m.id); else upsert(m.fo); render(); break;
        case 'task': onTask(m.task); render(); break;
        case 'site': if (m.op === 'remove') S.sites.delete(m.id); else S.sites.set(m.site.id, m.site); paintSites(); if (S.tab === 'sites') renderSites(); break;
        case 'cond': setConditions(m.conditions); break;
        case 'alert': setBadge(S.openAlerts + 1); if (S.alerts) S.alerts.unshift(m.ev); if (m.ev.level === 'alert') toast(m.ev.text, true); if (S.tab === 'alerts') ARL.opsPages.alerts(ctx, page); break;
        case 'alert_ack': if (S.alerts) { const ids = new Set(m.ids); let n = 0; for (const a of S.alerts) if (ids.has(a.id) && !a.ack_at) { a.ack_at = now(); n++; } setBadge(S.openAlerts - n); } else refreshAlertCount(); if (S.tab === 'alerts') ARL.opsPages.alerts(ctx, page); break;
        case 'kick': ARL.reboot(); break;
      }
    }
    const CONN = { connecting: 'Đang kết nối', live: 'Trực tiếp', down: 'Đang nối lại' };
    function onState(s) {
      S.conn = s;
      const c = q('.conn');
      c.dataset.state = s; c.textContent = CONN[s];
      if (s === 'live') { if (S.everLive) reload(); S.everLive = true; } // nối lại sau khi rớt mạng: tải lại để không sót thay đổi
    }
    async function refreshAlertCount() { try { const j = await api('GET', '/api/alerts'); S.alerts = j.alerts; setBadge(j.open); } catch { /* giữ số cũ */ } }
    async function reload() {
      try {
        const [sites] = await Promise.all([api('GET', '/api/sites'), loadTasks(S.date), S.date !== today() ? api('GET', '/api/tasks', null, { date: today() }).then((j) => { for (const t of j.tasks) S.tasks.set(t.id, t); }) : null, refreshAlertCount()]);
        S.sites = new Map(sites.sites.map((s) => [s.id, s]));
        paintSites();
        if (S.tab === 'sites') renderSites();
        if (!S.loaded) { S.fitted = true; fitOverview(); }
      } catch (e) { toast(e.message, true); }
      S.loaded = true;
    }

    const ctx = { S, v, map, go, api, onTask, openTask, reload, loadTasks, setConditions, setBadge, refreshAlertCount, paintSites, renderSites, centerOn, isLead, me };
    ARL.cfg = me.cfg; S.cfg = me.cfg;
    go('live');
    reload();
    const link = ARL.backend.connect(onMsg, onState);
    const timer = setInterval(render, 2000); // "x giây trước", chuyển sang "mất sóng"… cần tự cập nhật theo thời gian
    return function unmount() { alive = false; ac.abort(); clearInterval(timer); clearTimeout(evT); link.close(); if (sheetRO) sheetRO.disconnect(); ARL.killMap(map); };
  };
})();
