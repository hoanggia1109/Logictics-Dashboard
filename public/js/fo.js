/* Ứng dụng của FO (FieldOps): bắt đầu/kết thúc ca, gửi vị trí, nhận và thực hiện task, chụp ảnh xác nhận. */
(() => {
  'use strict';
  const { $, $$, el, esc, api, toast, modal, ask, store, distM, now, fmtHM, fmtKm, span, nameParts, telHref, TASK_ST, STOP_ST, BO_ST, ISSUES, WEATHER, TRAFFIC, isOpen, slaOf, countsText, progressOf, photoPicker, thumbs, baseMap, pinIcon, gmapsDir } = ARL;
  const MIN_GAP_MS = 3000, MIN_MOVE_M = 10, HEARTBEAT_MS = 15000, MAX_ACC_M = 150, MAX_QUEUE = 3000, BATCH = 50;

  ARL.mountFo = function (root, me) {
    const uid = me.user.id, K = `arl.fo.${uid}.`;
    const ac = new AbortController();
    const S = { tasks: new Map(), sel: null, summary: null, conditions: null, conn: 'connecting', seenIds: null };
    let alive = true;
    const v = el(`
      <div class="fo">
        <header class="fo-top"><div><b>Chào ${esc(nameParts(me.user.name).given || 'bạn')}</b><small>${esc(me.user.vehicle || 'FieldOps')}</small></div><button type="button" class="ghost b-menu">Tài khoản</button></header>
        <main class="fo-main">
          <section class="fo-home">
            <div class="shift-card">
              <button type="button" class="shift-btn" data-on="0">Bắt đầu ca</button>
              <p class="state" role="status" aria-live="polite">Chưa bắt đầu ca.</p>
              <dl class="trio"><div><dt>Km hôm nay</dt><dd class="s-km">–</dd></div><div><dt>Task xong</dt><dd class="s-tasks">–</dd></div><div><dt>Thẻ thu / giao</dt><dd class="s-cards">–</dd></div></dl>
              <p class="sub tip"></p>
            </div>
            <p class="cond-note sub" hidden></p>
            <h2>Việc của tôi</h2>
            <ul class="fo-tasks"></ul>
            <p class="empty" hidden>Hiện chưa có task nào được giao cho bạn. Khi Logistic giao việc, task sẽ hiện ở đây ngay.</p>
            <button type="button" class="b-issue">Báo sự cố cho Logistic</button>
          </section>
          <section class="fo-task" hidden></section>
        </main>
      </div>`);
    root.replaceChildren(v);
    const q = (s) => $(s, v);

    // ═════════════ Gửi vị trí ═════════════
    const ls = { get: (k) => store.get(K + k), set: (k, val) => store.set(K + k, val) };
    let onShift = ls.get('shift') === '1';
    let queue = [];
    try { queue = JSON.parse(ls.get('q') || '[]'); if (!Array.isArray(queue)) queue = []; } catch { queue = []; }
    let link = null, wsReady = false, wsDownSince = Date.now();
    let seq = 0, inflight = null, ackMiss = 0, shiftOffPending = ls.get('off') === '1', denied = false;
    let watchId = null, wake = null, lastSent = null, lastFix = null, lastFixAt = 0, geoErr = null, battery = null;
    const geo = ARL.backend.geo || (('geolocation' in navigator) ? navigator.geolocation : null);
    const saveQueue = () => ls.set('q', JSON.stringify(queue));

    function paintShift() {
      const btn = q('.shift-btn'), st = q('.state');
      btn.dataset.on = onShift ? '1' : '0';
      btn.textContent = onShift ? 'Kết thúc ca' : 'Bắt đầu ca';
      let s = '', msg;
      if (!onShift) msg = queue.length ? 'Đã kết thúc ca. Đang gửi nốt các điểm còn lại…' : 'Chưa bắt đầu ca. Ngoài ca, ứng dụng không ghi vị trí của bạn.';
      else if (denied) { s = 'bad'; msg = 'Máy chủ từ chối vị trí (tài khoản bị khoá hoặc điều khoản đã đổi). Tải lại trang.'; }
      else if (geoErr === 'denied') { s = 'bad'; msg = 'Trang chưa được phép dùng vị trí. Bật quyền Vị trí cho trang này trong cài đặt trình duyệt rồi tải lại.'; }
      else if (geoErr === 'insecure') { s = 'bad'; msg = 'Trang phải mở bằng địa chỉ https thì mới lấy được vị trí. Báo Logistic Lead kiểm tra đường link.'; }
      else if (geoErr === 'unsupported') { s = 'bad'; msg = 'Trình duyệt này không hỗ trợ định vị. Mở bằng Chrome hoặc Safari.'; }
      else if (!lastFix || Date.now() - lastFixAt > 30000) { s = 'warn'; msg = 'Đang tìm GPS… Ra chỗ thoáng nếu chờ lâu.'; }
      else if ((!wsReady && Date.now() - wsDownSince > 5000) || (queue.length && Date.now() - queue[0].ts > 12000)) { s = 'warn'; msg = `Mất mạng. Vị trí vẫn được lưu (${queue.length} điểm) và sẽ gửi bù khi có mạng.`; }
      else { s = 'ok'; msg = `Đang gửi vị trí · sai số ± ${Math.round(lastFix.acc)} m`; }
      st.dataset.s = s; st.textContent = msg;
      q('.tip').textContent = !onShift ? '' : wake ? 'Màn hình sẽ luôn sáng trong ca. Giữ trang này mở: nếu chuyển sang app khác quá lâu, trình duyệt sẽ ngừng gửi vị trí.' : 'Giữ trang này mở và đừng để màn hình tự khoá: khi màn hình tắt, trình duyệt sẽ ngừng gửi vị trí.';
    }
    function enqueue(pt) {
      queue.push(pt);
      if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE); // mất sóng quá lâu: bỏ điểm cũ nhất
      saveQueue();
      lastSent = pt;
      sync();
    }
    function done(n) {
      queue.splice(0, n);
      saveQueue();
      inflight = null; ackMiss = 0;
      sync();
    }
    function sync() {
      if (!alive) return;
      if (inflight && Date.now() - inflight.at > 9000) { // không thấy phản hồi → gửi lại (máy chủ tự bỏ điểm trùng)
        inflight = null;
        if (wsReady && ++ackMiss >= 2) { ackMiss = 0; reconnect(); } // kết nối "chết lâm sàng" (đổi trạm, vào hầm): bỏ và nối lại
      }
      if (inflight || denied) return paintShift();
      if (queue.length) {
        const pts = queue.slice(0, BATCH);
        inflight = { seq: ++seq, n: pts.length, at: Date.now() };
        if (wsReady && link.send({ t: 'loc', seq, pts })) { /* chờ ack */ } else if (Date.now() - wsDownSince > 8000) httpSend(pts, inflight); // WebSocket bị chặn → gửi qua HTTP
        else inflight = null;
      } else if (shiftOffPending) {
        if (wsReady && link.send({ t: 'shift', on: false })) { shiftOffPending = false; ls.set('off', null); } else if (Date.now() - wsDownSince > 8000) {
          inflight = { seq: ++seq, n: 0, at: Date.now() };
          httpSend([], inflight, false);
        }
      }
      paintShift();
    }
    async function httpSend(pts, mine, shift) {
      try {
        await ARL.backend.api('POST', '/api/loc', shift === false ? { pts, shift: false } : { pts });
        if (shift === false) { shiftOffPending = false; ls.set('off', null); }
        if (inflight === mine) done(mine.n);
      } catch (e) {
        if (inflight === mine) inflight = null;
        if (e.status === 401) ARL.onUnauth(); else if (e.status === 403) { denied = true; ARL.reboot(); }
        paintShift();
      }
    }
    function onFix(pos) {
      const c = pos.coords, t = Date.now();
      geoErr = null;
      if (c.accuracy > MAX_ACC_M) return paintShift(); // định vị bằng trạm phát sóng, sai cả cây số → bỏ
      const ts = Math.abs(pos.timestamp - t) < 60000 ? Math.round(pos.timestamp) : t;
      const pt = { ts, lat: +c.latitude.toFixed(6), lon: +c.longitude.toFixed(6), acc: Math.round(c.accuracy) };
      if (typeof c.speed === 'number' && c.speed >= 0) pt.spd = +c.speed.toFixed(2);
      if (typeof c.heading === 'number' && c.heading >= 0 && (pt.spd === undefined || pt.spd > 0.8)) pt.hdg = Math.round(c.heading);
      if (battery) pt.bat = +battery.level.toFixed(2);
      lastFix = pt; lastFixAt = t;
      paintMe();
      if (!onShift) return;
      const gap = lastSent ? ts - lastSent.ts : Infinity;
      const moved = lastSent ? distM(lastSent.lat, lastSent.lon, pt.lat, pt.lon) : Infinity;
      // Đang chạy: tối đa 1 điểm / 3 giây và phải đi được ≥ 10 m. Đứng yên: 15 giây báo 1 lần để Logistic biết vẫn đang kết nối.
      if (gap >= HEARTBEAT_MS || (gap >= MIN_GAP_MS && moved >= MIN_MOVE_M)) enqueue(pt); else paintShift();
    }
    function onGeoErr(e) { if (e && e.code === 1) geoErr = 'denied'; paintShift(); }
    function startGeo() {
      if (!ARL.backend.geo && !window.isSecureContext) { geoErr = 'insecure'; return paintShift(); }
      if (!geo) { geoErr = 'unsupported'; return paintShift(); }
      if (watchId === null) watchId = geo.watchPosition(onFix, onGeoErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
      acquireWake();
    }
    function stopGeo() {
      if (watchId !== null && geo) { geo.clearWatch(watchId); watchId = null; }
      if (wake) { wake.release().catch(() => {}); wake = null; }
    }
    async function acquireWake() {
      if (wake || !('wakeLock' in navigator) || document.hidden) return;
      try { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; if (alive) paintShift(); }); } catch { wake = null; }
      if (alive) paintShift();
    }
    function setShiftLocal(on) {
      onShift = on; ls.set('shift', on ? '1' : null);
      if (on) { shiftOffPending = false; ls.set('off', null); lastSent = null; startGeo(); } else stopGeo();
      paintShift();
    }
    q('.shift-btn').addEventListener('click', async () => {
      if (!onShift) {
        setShiftLocal(true);
        if (!(wsReady && link.send({ t: 'shift', on: true }))) ARL.backend.api('POST', '/api/shift', { on: true }).catch(() => {});
      } else {
        const running = [...S.tasks.values()].find((t) => t.status === 'in_progress');
        if (!(await ask(running ? `Bạn đang làm task ${running.code}. Kết thúc ca bây giờ thì Logistic sẽ không thấy vị trí của bạn và sẽ nhận cảnh báo. Vẫn kết thúc ca?` : 'Kết thúc ca? Từ lúc này ứng dụng ngừng ghi vị trí của bạn.', 'Kết thúc ca', !!running))) return;
        setShiftLocal(false);
        shiftOffPending = true; ls.set('off', '1');
        sync();
      }
    });
    function reconnect() {
      if (link) link.close();
      if (wsReady) wsDownSince = Date.now();
      wsReady = false;
      link = ARL.backend.connect(onMsg, onState);
    }
    function onState(s) {
      S.conn = s;
      if (s === 'live') { wsReady = true; inflight = null; } else { if (wsReady) wsDownSince = Date.now(); wsReady = false; }
      paintShift();
    }

    // ═════════════ Task ═════════════
    const mine = () => [...S.tasks.values()].sort((a, b) => (isOpen(b) - isOpen(a)) || (a.status === 'in_progress' ? -1 : b.status === 'in_progress' ? 1 : 0) || a.start_at - b.start_at);
    function paintSummary() {
      const r = S.summary;
      q('.s-km').textContent = r ? fmtKm(r.km) : '0 km';
      q('.s-tasks').textContent = r ? `${r.completed}/${r.tasks}` : `0/${S.tasks.size}`;
      q('.s-cards').textContent = r ? `${r.cards_in} / ${r.cards_out}` : '0 / 0';
      const c = S.conditions, n = q('.cond-note');
      n.hidden = !(c && c.factor > 1);
      if (c && c.factor > 1) n.textContent = `Điều kiện hôm nay: ${WEATHER[c.weather]}, giao thông ${TRAFFIC[c.traffic].toLowerCase()}. Hạn các task đã được nới ×${c.factor}. Chạy xe cẩn thận.`;
    }
    async function loadSummary() { try { const j = await api('GET', '/api/my/summary'); S.summary = j.row; paintSummary(); } catch { /* giữ số cũ */ } }
    function taskCard(t) {
      const p = progressOf(t), sla = slaOf(t), next = t.stops.find((s) => s.status === 'pending' || s.status === 'arrived');
      return `<li><button type="button" class="tcard" data-id="${t.id}" data-ts="${t.status}">
        <span class="tc-top"><b>${esc(t.code)}</b><span class="pill sm" data-ts="${t.status}">${esc(t.status === 'assigned' ? 'Mới – chờ bạn nhận' : TASK_ST[t.status])}</span></span>
        <span class="tc-title">${esc(t.title)}${t.round_trip ? ' <i class="tag">2 chiều</i>' : ''}</span>
        <span class="tc-meta"><span>Bắt đầu ${fmtHM(t.start_at)}</span><span class="sla" data-sla="${sla.key}">${esc(sla.text)}</span></span>
        <span class="tc-meta"><span class="bar"><i style="width:${p.total ? Math.round((p.done / p.total) * 100) : 0}%"></i></span><span class="cnt">${p.done}/${p.total} điểm</span>${t.stops.some((x) => x.status === 'done' && x.bo_status === 'pending') ? '<span class="next">Đang chờ BO xác nhận</span>' : next && isOpen(t) ? `<span class="next">Kế tiếp: ${esc(next.name)}</span>` : ''}</span>
      </button></li>`;
    }
    function paintList() {
      const list = mine();
      q('.fo-tasks').innerHTML = list.map(taskCard).join('');
      q('.fo-home .empty').hidden = list.length > 0;
      paintSummary();
    }
    q('.fo-tasks').addEventListener('click', (e) => { const b = e.target.closest('.tcard'); if (b) openTask(+b.dataset.id); });
    async function loadTasks() {
      try {
        const j = await api('GET', '/api/my/tasks');
        S.tasks = new Map(j.tasks.map((t) => [t.id, t]));
        S.conditions = j.conditions;
        if (!S.seenIds) S.seenIds = new Set(S.tasks.keys());
        paintList();
        if (S.sel !== null) { if (S.tasks.has(S.sel)) paintTask(); else closeTask(); }
      } catch (e) { if (alive && e.status !== 401 && e.status !== 403) toast(e.message, true); }
    }

    // ─── Chi tiết task ───
    const tEl = q('.fo-task');
    let fmap = null, fLayer = null, meMarker = null;
    function paintMe() {
      if (!fmap || !lastFix) return;
      if (!meMarker) meMarker = L.marker([lastFix.lat, lastFix.lon], { interactive: false, keyboard: false, zIndexOffset: 2000, icon: L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: '<div class="me-dot"></div>' }) }).addTo(fmap);
      else meMarker.setLatLng([lastFix.lat, lastFix.lon]);
      for (const d of $$('.dist', tEl)) {
        const m = distM(lastFix.lat, lastFix.lon, +d.dataset.lat, +d.dataset.lon);
        d.textContent = Date.now() - lastFixAt > 60000 ? '' : m < 60 ? 'Bạn đang ở điểm này' : m < 1000 ? `Còn ${Math.round(m / 10) * 10} m` : `Còn ${(m / 1000).toFixed(1).replace('.', ',')} km`;
      }
    }
    let routeSeq = 0;
    /** Ghim các điểm ngay; rồi vẽ đường đi thực tế máy chủ đã tính (chặng đã đi ẩn, chặng đang đi nét liền, chặng sắp tới nét đứt); chưa có đường thì nối thẳng nét đứt. */
    function drawMap(t) {
      if (!fmap) return;
      const my = ++routeSeq;
      fLayer.clearLayers();
      t.stops.forEach((s, i) => L.marker([s.lat, s.lon], { icon: pinIcon(s.is_return ? '↩' : String(i + 1), s.status), interactive: false, keyboard: false }).addTo(fLayer));
      const draw = (route) => { if (my === routeSeq && fmap) ARL.drawRoute(fLayer, route, { points: t.stops, ...ARL.routeLegs(t) }); };
      if (!t.route_src || !t.route_at) return draw(null);
      ARL.taskRoute(t.id, t.route_at).then((j) => draw(j.stale ? null : j.route), () => draw(null));
    }
    function openTask(id) {
      if (!S.tasks.has(id)) return;
      S.sel = id; if (S.seenIds) S.seenIds.add(id);
      q('.fo-home').hidden = true; tEl.hidden = false;
      tEl.innerHTML = '<header class="top"><button type="button" class="ghost back">‹ Việc của tôi</button><span class="pill t-pill"></span></header><div class="t-head"></div><div class="fmap" aria-label="Bản đồ các điểm của task"></div><ol class="stops t-stops"></ol><div class="t-foot"></div>';
      $('.back', tEl).addEventListener('click', closeTask);
      fmap = baseMap($('.fmap', tEl), { zoomControl: true, dragging: !L.Browser.mobile, tap: false, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false });
      fLayer = L.layerGroup().addTo(fmap); meMarker = null;
      paintTask(true);
      window.scrollTo(0, 0);
    }
    function closeTask() {
      S.sel = null;
      if (fmap) { ARL.killMap(fmap); fmap = null; fLayer = null; meMarker = null; }
      tEl.hidden = true; tEl.innerHTML = ''; q('.fo-home').hidden = false;
      paintList();
    }
    function stopHtml(t, s, i, isNext) {
      const plan = countsText(s.exp_cards_out, s.exp_cards_in, s.exp_dev_out, s.exp_dev_in), active = t.status === 'in_progress' && (s.status === 'pending' || s.status === 'arrived');
      const lines = [];
      if (s.address) lines.push(`<p class="sub">${esc(s.address)}</p>`);
      if (plan) lines.push(`<p><b>Cần làm:</b> ${esc(plan)}</p>`); else if (s.is_return) lines.push('<p class="sub">Quay về điểm xuất phát để kết thúc task.</p>');
      if (s.note) lines.push(`<p class="note">${esc(s.note)}</p>`);
      if (s.status === 'done') lines.push(`<p class="ok-t">Xong lúc ${fmtHM(s.done_at)}${countsText(s.cards_out, s.cards_in, s.dev_out, s.dev_in) ? ' · ' + esc(countsText(s.cards_out, s.cards_in, s.dev_out, s.dev_in)) : ''}</p>`);
      if (s.status === 'failed') lines.push(`<p class="err">Không giao được: ${esc(s.fail_reason)}</p>`);
      if (s.status === 'skipped') lines.push(`<p class="sub">Bỏ qua điểm này: ${esc(s.fail_reason || 'Logistics đã gỡ hết việc ở điểm này')}</p>`);
      if (s.bo_status !== 'none') lines.push(`<p class="${s.bo_status === 'mismatch' ? 'err' : s.bo_status === 'confirmed' ? 'ok-t' : 'sub'}">${esc(BO_ST[s.bo_status])}</p>`);
      const tel = telHref(s.phone);
      const othersClosed = t.stops.every((x) => x.is_return || x.status === 'done' || x.status === 'failed' || x.status === 'skipped');
      const waitFor = t.stops.find((x) => x.status === 'done' && x.bo_status === 'pending'); // BO chưa xác nhận → chưa đi tiếp được
      let btns = '';
      if (t.status === 'in_progress' && s.bo_status === 'pending') btns = `<div class="wait-bo"><p><b>Đang chờ BO xác nhận.</b> Nhờ BO mở link mà Logistic đã gửi, đếm lại, chụp ảnh và bấm xác nhận. BO xác nhận xong bạn mới đi tiếp được.</p><p class="sub">${s.bo_link ? (s.bo_link.opened_at ? 'BO đã mở link.' : 'Logistic đã tạo link nhưng BO chưa mở.') : 'BO chưa có link – Logistic đã được báo.'}</p><button type="button" class="b-nudge">Nhắc Logistic</button></div>`;
      else if (active && waitFor) btns = `<p class="sub">Chờ BO tại ${esc(waitFor.name)} xác nhận xong mới làm tiếp điểm này.</p>`;
      else if (active && s.is_return && !othersClosed) btns = '<p class="sub">Xác nhận “đã về” được sau khi chốt xong các điểm phía trên.</p>';
      else if (active && isNext) btns = `<div class="actions">
          <a class="btn" href="${gmapsDir(s.lat, s.lon)}" target="_blank" rel="noopener">Chỉ đường</a>${tel ? `<a class="btn" href="${tel}">Gọi điểm</a>` : ''}
          ${s.status === 'pending' ? '<button type="button" class="b-arrive">Tôi đã đến</button>' : ''}
          <button type="button" class="primary b-proof">${s.is_return ? 'Xác nhận đã về' : 'Chụp ảnh & xác nhận'}</button>
          ${s.is_return ? '' : '<button type="button" class="ghost danger b-fail">Không giao nhận được</button>'}
        </div>`;
      else if (active) btns = `<div class="actions compact"><a class="btn" href="${gmapsDir(s.lat, s.lon)}" target="_blank" rel="noopener">Chỉ đường</a><button type="button" class="b-proof">Làm điểm này trước</button></div>`;
      return `<li class="stop ${isNext ? 'next' : ''}" data-ss="${s.status}" data-id="${s.id}" data-i="${i}"><span class="num">${s.is_return ? '↩' : i + 1}</span><div class="stop-body"><div class="stop-head"><b>${esc(s.name)}</b><span class="pill sm" data-ss="${s.status}">${STOP_ST[s.status]}</span></div>${active ? `<p class="dist sub" data-lat="${s.lat}" data-lon="${s.lon}"></p>` : ''}${lines.join('')}<div class="ph"></div>${btns}</div></li>`;
    }
    function paintTask(fit) {
      const t = S.tasks.get(S.sel);
      if (!t || tEl.hidden) return;
      const sla = slaOf(t), p = progressOf(t);
      const pill = $('.t-pill', tEl);
      pill.dataset.ts = t.status; pill.textContent = t.status === 'assigned' ? 'Mới – chờ bạn nhận' : t.status === 'accepted' ? 'Bạn đã nhận' : TASK_ST[t.status];
      const rtNote = ARL.routeNote(t); // đường xe máy của Google đang thử nghiệm: Google yêu cầu ghi rõ ở mọi nơi vẽ đường đó
      $('.t-head', tEl).innerHTML = `<h2>${esc(t.title)}</h2><p class="sub">${esc(t.code)} · bắt đầu ${fmtHM(t.start_at)} · <span class="sla" data-sla="${sla.key}">${esc(sla.text)}</span>${t.factor > 1 ? ` · hạn đã nới ×${t.factor}` : ''}</p>${t.note ? `<p class="note">${esc(t.note)}</p>` : ''}<p class="sub">${p.done}/${p.total} điểm · dự kiến ≈ ${fmtKm(t.plan_km)}${t.km ? ` · đã chạy ${fmtKm(t.km)}` : ''}${t.route_src && t.route_src !== 'estimate' ? ` · theo đường thực tế${t.route_src === 'google' ? ' (Google Maps)' : ''}` : ''}</p>${rtNote ? `<p class="sub rt-note">${esc(rtNote)}</p>` : ''}`;
      const waitIdx = t.stops.findIndex((s) => s.status === 'done' && s.bo_status === 'pending');
      const nextIdx = waitIdx >= 0 ? waitIdx : t.stops.findIndex((s) => s.status === 'pending' || s.status === 'arrived');
      const ol = $('.t-stops', tEl);
      ol.innerHTML = t.stops.map((s, i) => stopHtml(t, s, i, t.status === 'in_progress' && i === nextIdx)).join('');
      t.stops.forEach((s, i) => { if (s.photos.length) $(`.stop[data-i="${i}"] .ph`, ol).append(thumbs(s.photos)); });
      const foot = $('.t-foot', tEl);
      if (t.status === 'assigned') foot.innerHTML = '<button type="button" class="primary big b-accept">Nhận task</button><button type="button" class="ghost danger b-decline">Tôi không nhận được</button>';
      else if (t.status === 'accepted') {
        // Mỗi FO chạy một task tại một thời điểm (máy chủ từ chối "bắt đầu" khi đang có task khác chạy) → không chìa nút ra rồi báo lỗi.
        const running = [...S.tasks.values()].find((x) => x.status === 'in_progress' && x.id !== t.id);
        foot.innerHTML = `${running ? `<p class="sub">Hoàn thành task ${esc(running.code)} trước rồi mới bắt đầu task này.</p>` : '<button type="button" class="primary big b-start">Bắt đầu task</button>'}<button type="button" class="ghost danger b-decline">Tôi không làm được nữa</button>`;
      }
      else if (t.status === 'in_progress') foot.innerHTML = '<p class="sub">Tới gần điểm, ứng dụng tự ghi “đã đến”. Mỗi điểm cần ít nhất một ảnh khi xác nhận. Tại BO: sau khi bạn xác nhận, BO phải xác nhận trên link của họ thì bạn mới đi tiếp được.</p>';
      else foot.innerHTML = `<p class="${t.status === 'completed' && !t.late ? 'ok-t' : 'sub'}">${t.status === 'completed' ? `Task hoàn thành lúc ${fmtHM(t.finished_at)}${t.late ? ', trễ hạn.' : ', đúng hạn.'}` : t.status === 'cancelled' ? 'Logistic đã huỷ task này.' : 'Task kết thúc mà không giao nhận được điểm nào.'}</p>`;
      drawMap(t);
      if (fit && fmap) {
        const pts = t.stops.map((s) => [s.lat, s.lon]);
        if (lastFix) pts.push([lastFix.lat, lastFix.lon]);
        setTimeout(() => { if (fmap) { fmap.invalidateSize(); fmap.fitBounds(L.latLngBounds(pts), { padding: [28, 28], maxZoom: 16 }); } }, 30);
      }
      paintMe();
    }
    const act = async (fn, okMsg) => { try { const j = await fn(); if (j && j.task) onTask(j.task, true); if (okMsg) toast(okMsg); loadSummary(); return true; } catch (e) { toast(e.message, true); if (e.code === 'bad_state' || e.code === 'not_yours' || e.code === 'task_not_running' || e.code === 'wait_bo') loadTasks(); return false; } };
    tEl.addEventListener('click', async (e) => {
      const t = S.tasks.get(S.sel), b = e.target.closest('button');
      if (!t || !b || b.disabled) return;
      const li = b.closest('.stop'), stop = li ? t.stops.find((s) => s.id === +li.dataset.id) : null;
      const once = async (fn) => { b.disabled = true; try { await fn(); } finally { if (b.isConnected) b.disabled = false; } };
      if (b.classList.contains('b-accept')) return once(() => act(() => api('POST', `/api/tasks/${t.id}/accept`), 'Đã nhận task'));
      if (b.classList.contains('b-start')) return once(async () => { if (await act(() => api('POST', `/api/tasks/${t.id}/start`), 'Đã bắt đầu. Chạy xe an toàn!')) { if (!onShift) setShiftLocal(true); } });
      if (b.classList.contains('b-decline')) return declineDialog(t);
      if (!stop) return;
      if (b.classList.contains('b-arrive')) return once(() => act(() => api('POST', `/api/stops/${stop.id}/arrive`, here()), 'Đã ghi nhận bạn đến nơi')); // chỉ gửi vị trí còn tươi (≤ 2 phút), như lúc xác nhận điểm
      if (b.classList.contains('b-proof')) return proofDialog(t, stop);
      if (b.classList.contains('b-fail')) return failDialog(t, stop);
      if (b.classList.contains('b-nudge')) return once(async () => {
        try { await api('POST', '/api/issues', { kind: 'cho_bo', note: `tại ${stop.name}${stop.bo_link ? (stop.bo_link.opened_at ? ' (BO đã mở link)' : ' (BO chưa mở link)') : ' (BO chưa có link)'}`, task_id: t.id }); toast('Đã nhắc Logistic'); } catch (e2) { toast(e2.message, true); }
      });
    });
    const here = () => (lastFix && Date.now() - lastFixAt < 120000 ? { lat: lastFix.lat, lon: lastFix.lon } : {});
    const numField = (label, cls, val) => `<label class="n">${label}<input type="number" class="${cls}" min="0" max="999" step="1" inputmode="numeric" value="${val}"></label>`;
    const readNum = (body, cls) => { const x = $('.' + cls, body).value, n = x === '' ? 0 : Number(x); if (!Number.isInteger(n) || n < 0 || n > 999) throw new Error('Số lượng phải là số nguyên từ 0 đến 999.'); return n; };
    function proofDialog(t, stop) {
      if (stop.is_return) {
        const body = el('<div class="stack"><p>Xác nhận bạn đã về tới điểm xuất phát? Task sẽ kết thúc.</p><label>Ghi chú (không bắt buộc)<input class="f-note" maxlength="300"></label></div>');
        return modal({ title: 'Xác nhận đã về', body, cls: 'small', actions: [{ label: 'Chưa', cls: 'ghost', run: () => {} }, { label: 'Đã về, kết thúc task', cls: 'primary', run: async () => { const j = await api('POST', `/api/stops/${stop.id}/proof`, { ...here(), note: $('.f-note', body).value }); onTask(j.task, true); loadSummary(); toast('Đã kết thúc task'); } }] });
      }
      const pick = photoPicker((ARL.cfg && ARL.cfg.maxPhotos) || 4, 'Chụp ảnh bàn giao');
      const body = el(`<div class="stack"><p class="sub">Nhập số lượng THỰC TẾ. Số đã điền sẵn là số theo kế hoạch.</p>
        <div class="grid2">${numField('Giao thẻ cho điểm', 'f-co', stop.exp_cards_out)}${numField('Thu thẻ về', 'f-ci', stop.exp_cards_in)}${numField('Giao thiết bị', 'f-do', stop.exp_dev_out)}${numField('Thu thiết bị về', 'f-di', stop.exp_dev_in)}</div>
        <div><span class="lbl">Ảnh bàn giao (bắt buộc, chụp rõ thẻ / thiết bị)</span><div class="f-photos"></div></div>
        <label>Ghi chú (không bắt buộc)<input class="f-note" maxlength="300" placeholder="Ví dụ: BO đưa thiếu 1 thẻ"></label></div>`);
      $('.f-photos', body).append(pick.el);
      modal({ title: stop.name, body, actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, { label: 'Gửi xác nhận', cls: 'primary', run: async () => {
        if (pick.busy) throw new Error('Đang xử lý ảnh, đợi vài giây rồi bấm lại.');
        if (!pick.photos.length) throw new Error('Cần chụp ít nhất một ảnh bàn giao.');
        const b = { ...here(), photos: pick.photos, cards_out: readNum(body, 'f-co'), cards_in: readNum(body, 'f-ci'), dev_out: readNum(body, 'f-do'), dev_in: readNum(body, 'f-di'), note: $('.f-note', body).value };
        const j = await api('POST', `/api/stops/${stop.id}/proof`, b);
        onTask(j.task, true); loadSummary();
        toast(j.task.status === 'completed' ? 'Đã xong task!' : 'Đã xác nhận điểm này');
      } }] });
    }
    function failDialog(t, stop) {
      const reasons = ['BO đóng cửa', 'Không gặp người nhận', 'BO chưa chuẩn bị xong thẻ', 'Sai địa chỉ / không tìm thấy điểm', 'Lý do khác'];
      const pick = photoPicker(2, 'Chụp ảnh hiện trường (nếu có)');
      const body = el(`<div class="stack"><label>Lý do<select class="f-reason">${reasons.map((r) => `<option>${r}</option>`).join('')}</select></label><label>Nói rõ thêm<input class="f-more" maxlength="150" placeholder="Ví dụ: gọi 3 lần không ai nghe máy"></label><div class="f-photos"></div><p class="sub">Logistic sẽ nhận cảnh báo ngay để xử lý.</p></div>`);
      $('.f-photos', body).append(pick.el);
      modal({ title: `Không giao nhận được: ${stop.name}`, body, actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, { label: 'Gửi báo cáo', cls: 'primary danger-bg', run: async () => {
        if (pick.busy) throw new Error('Đang xử lý ảnh, đợi vài giây rồi bấm lại.');
        const more = $('.f-more', body).value.trim(), r = $('.f-reason', body).value;
        if (r === 'Lý do khác' && more.length < 3) throw new Error('Hãy ghi rõ lý do.');
        const j = await api('POST', `/api/stops/${stop.id}/fail`, { ...here(), reason: r === 'Lý do khác' ? more : more ? `${r} – ${more}` : r, photos: pick.photos });
        onTask(j.task, true); loadSummary();
        toast('Đã báo cho Logistic');
      } }] });
    }
    function declineDialog(t) {
      const body = el('<div class="stack"><p>Task sẽ được trả lại để Logistic giao cho người khác.</p><label>Lý do<input class="f-reason" maxlength="200" placeholder="Ví dụ: xe hỏng, đang kẹt việc khác"></label></div>');
      modal({ title: `Không nhận ${t.code}`, body, cls: 'small', actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, { label: 'Trả task', cls: 'primary danger-bg', run: async () => {
        const reason = $('.f-reason', body).value.trim();
        if (reason.length < 3) throw new Error('Cần ghi lý do.');
        await api('POST', `/api/tasks/${t.id}/decline`, { reason });
        S.tasks.delete(t.id); closeTask(); toast('Đã trả task cho Logistic');
      } }] });
    }
    q('.b-issue').addEventListener('click', () => {
      const running = [...S.tasks.values()].find((t) => t.status === 'in_progress');
      const body = el(`<div class="stack"><label>Sự cố gì?<select class="f-kind">${Object.entries(ISSUES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label><label>Mô tả ngắn<input class="f-note" maxlength="300" placeholder="Ví dụ: thủng lốp ở Điện Biên Phủ, cần 30 phút"></label>${running ? `<p class="sub">Sẽ gắn với task đang chạy ${esc(running.code)}.</p>` : ''}<p class="sub">Nếu là tai nạn hoặc việc khẩn cấp, hãy gọi điện trực tiếp cho Logistic Lead.</p></div>`);
      modal({ title: 'Báo sự cố', body, actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, { label: 'Gửi cho Logistic', cls: 'primary', run: async () => { await api('POST', '/api/issues', { kind: $('.f-kind', body).value, note: $('.f-note', body).value, task_id: running ? running.id : undefined }); toast('Logistic đã nhận được báo cáo'); } }] });
    });
    q('.b-menu').addEventListener('click', () => {
      const origin = location.origin + location.pathname.replace(/\/[^/]*$/, '/');
      const body = el(`<div class="stack"><p><b>${esc(me.user.name)}</b><br><span class="sub">FO · tên đăng nhập ${esc(me.user.username)}</span></p>
        <button type="button" class="b-pw">Đổi mật khẩu</button><button type="button" class="b-terms">Điều khoản & quyền riêng tư</button>
        <details><summary>Cần chạy nền khi tắt màn hình?</summary><p class="sub">Trang web không gửi được vị trí khi màn hình tắt. Cài app <b>Traccar Client</b> rồi nhập:</p><label>Địa chỉ máy chủ<input readonly value="${esc(origin)}osmand"></label><label>Mã thiết bị (giữ kín)<input readonly value="${esc(me.deviceToken || 'Tải lại trang để lấy mã')}"></label><p class="sub">Vẫn dùng trang này để nhận task và chụp ảnh.</p></details>
        <button type="button" class="danger b-out">Đăng xuất</button></div>`);
      const dlg = modal({ title: 'Tài khoản', body, cls: 'small' });
      $('.b-pw', body).addEventListener('click', () => { dlg.close(); ARL.changePasswordDialog(); });
      $('.b-terms', body).addEventListener('click', () => { dlg.close(); ARL.termsDialog(me); });
      $('.b-out', body).addEventListener('click', async () => {
        if (onShift && !(await ask('Bạn đang trong ca. Đăng xuất sẽ kết thúc ca và ngừng gửi vị trí. Vẫn đăng xuất?', 'Đăng xuất', true))) return;
        dlg.close();
        if (onShift) { setShiftLocal(false); try { await ARL.backend.api('POST', '/api/shift', { on: false }); } catch { /* máy chủ tự đóng ca khi hết tín hiệu */ } }
        ARL.logout();
      });
    });

    // ═════════════ Nhận dữ liệu ═════════════
    function onTask(t, quiet) {
      const isNew = S.seenIds && !S.seenIds.has(t.id);
      S.tasks.set(t.id, t);
      if (isNew && !quiet) {
        S.seenIds.add(t.id);
        toast(`Bạn có task mới: ${t.title}`);
        if (navigator.vibrate) { try { navigator.vibrate([200, 100, 200]); } catch { /* máy không rung */ } }
      }
      if (S.sel === t.id) paintTask(); else if (S.sel === null) paintList();
    }
    function onMsg(m) {
      switch (m.t) {
        case 'hello':
          if ((m.uid && m.uid !== uid) || (m.role && m.role !== 'fo')) { ARL.reboot(); break; } // kênh mở bằng phiên của tài khoản khác (vừa đăng nhập ở tab khác) → mở lại đúng màn hình
          // Đối chiếu trạng thái ca giữa máy và máy chủ sau khi nối lại (tab khác cùng trình duyệt đã kết thúc ca thì không mở lại).
          if (onShift && !m.onShift) { if (ls.get('shift') !== '1') setShiftLocal(false); else if (link) link.send({ t: 'shift', on: true }); }
          else if (!onShift && m.onShift && !shiftOffPending) setShiftLocal(true);
          loadTasks(); loadSummary(); sync();
          break;
        case 'ack': if (m.denied) { denied = true; paintShift(); ARL.reboot(); } else if (inflight && m.seq === inflight.seq) done(inflight.n); break;
        case 'shift':
          if (m.denied) { denied = true; paintShift(); ARL.reboot(); } else if (m.on && !onShift) setShiftLocal(true);
          // Ca bị đóng ở nơi khác (hết tín hiệu, Lead đóng, hoặc chính FO bấm "Kết thúc ca" trên tab / thiết bị khác): dừng ghi vị trí ngay,
          // nếu không tab này vẫn gửi điểm và máy chủ sẽ tự mở lại ca mà FO vừa kết thúc.
          else if (!m.on && onShift && m.reason) { setShiftLocal(false); toast(m.reason === 'timeout' ? 'Ca đã tự đóng vì mất tín hiệu quá lâu. Bấm “Bắt đầu ca” để tiếp tục.' : m.reason === 'fo' ? 'Ca đã được kết thúc từ tab hoặc thiết bị khác của bạn.' : 'Ca của bạn đã được đóng.', true); }
          break;
        case 'task': onTask(m.task); break;
        case 'task_gone': if (S.tasks.delete(m.id)) { toast('Một task đã được chuyển cho người khác.'); if (S.sel === m.id) closeTask(); else paintList(); } break;
        case 'kick': ARL.reboot(); break;
      }
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (onShift) acquireWake(); // khoá màn hình sáng tự nhả khi trang bị ẩn → xin lại
      loadTasks();
    }, { signal: ac.signal });
    window.addEventListener('online', () => { if (!wsReady) reconnect(); }, { signal: ac.signal });
    // Cùng tài khoản mở ở hai tab của một trình duyệt: trạng thái ca dùng chung một khoá → tab kia bấm bắt đầu / kết thúc ca thì tab này theo ngay,
    // không gửi lại lệnh (tab kia đã gửi) và không để hai tab cùng ghi vị trí.
    window.addEventListener('storage', (e) => {
      if (e.key !== K + 'shift' || !alive) return;
      const on = e.newValue === '1';
      if (on === onShift) return;
      onShift = on;
      if (on) { shiftOffPending = false; lastSent = null; startGeo(); } else stopGeo();
      paintShift();
    }, { signal: ac.signal });
    const t1 = setInterval(() => {
      // Máy đứng yên có thể không báo điểm mới → chủ động hỏi lại vị trí hiện tại (không gửi điểm giả).
      if (onShift && watchId !== null && geo && (!lastSent || Date.now() - lastSent.ts >= HEARTBEAT_MS)) geo.getCurrentPosition(onFix, () => {}, { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 });
      sync();
    }, 5000);
    const t2 = setInterval(() => { if (S.sel !== null) { const t = S.tasks.get(S.sel); if (t) { const s = slaOf(t), e = $('.t-head .sla', tEl); if (e) { e.textContent = s.text; e.dataset.sla = s.key; } } } else paintList(); }, 20000);
    const t3 = setInterval(loadSummary, 60000);
    if (navigator.getBattery) navigator.getBattery().then((b) => { battery = b; }).catch(() => {});

    paintShift(); paintSummary();
    link = ARL.backend.connect(onMsg, onState);
    if (onShift) startGeo();
    loadTasks(); loadSummary();
    return function unmount() { alive = false; ac.abort(); clearInterval(t1); clearInterval(t2); clearInterval(t3); stopGeo(); if (link) link.close(); ARL.killMap(fmap); fmap = null; };
  };
})();
