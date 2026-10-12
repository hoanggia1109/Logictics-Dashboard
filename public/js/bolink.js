/* Trang của BO, mở bằng link dùng một lần do Logistic gửi (không cần tài khoản):
   theo dõi FO đang đến điểm của mình → sau khi FO giao nhận xong thì đếm lại, chụp ảnh và xác nhận. */
(() => {
  'use strict';
  const { $, el, esc, toast, fmtHM, telHref, nameParts, countsText, photoPicker, thumbs, baseMap, killMap, pinIcon } = ARL;

  ARL.mountBoLink = function (root, token) {
    let alive = true, view = null, shown = '', timer = null, busy = false, map = null, foMarker = null, line = null, pick = null;
    const call = (path, body) => ARL.backend.api('POST', path, { token, ...(body || {}) });
    ARL.photoVia = (id) => ARL.backend.boPhotoUrl(id, token);
    const v = el(`
      <div class="bo bl">
        <header class="fo-top"><div><b class="bl-site">Xác nhận bàn giao</b><small>Atlas Capture · theo dõi và xác nhận giao nhận thẻ, thiết bị</small></div></header>
        <main class="fo-main"><p class="empty">Đang mở link…</p></main>
      </div>`);
    root.replaceChildren(v);
    const main = $('.fo-main', v);
    const dropMap = () => { if (map) { killMap(map); map = null; foMarker = null; line = null; } };
    const foLine = (fo) => (fo ? `<b>${esc(fo.name)}</b>${fo.vehicle ? ` · xe ${esc(fo.vehicle)}` : ''}${telHref(fo.phone) ? ` · <a href="${telHref(fo.phone)}">Gọi FO</a>` : ''}` : 'Chưa phân công FO');
    const planLine = (x) => { const p = countsText(x.exp.cards_out, x.exp.cards_in, x.exp.dev_out, x.exp.dev_in); return p ? `<p class="sub">Kế hoạch (tính theo phía FO): ${esc(p)}</p>` : ''; };

    function fail(e) {
      dropMap(); shown = 'error';
      const gone = e.code === 'link_invalid' || e.code === 'link_used';
      const title = e.code === 'link_used' ? 'Link đã được dùng trên thiết bị khác' : e.code === 'link_invalid' ? 'Link không còn hiệu lực' : 'Chưa mở được link';
      // Link hết hiệu lực khi: quá 48 giờ, Logistic tạo link mới, hoặc lượt giao nhận đã được Logistic chốt / huỷ (khi đó không cần link mới nữa).
      const why = e.code === 'link_invalid' ? 'Link đã hết hạn, đã được thay bằng link mới, hoặc lượt giao nhận này đã được Logistic của Atlas Capture chốt / huỷ. Nếu bạn chưa xác nhận bàn giao, hãy liên hệ Logistic.' : e.message || 'Kiểm tra mạng rồi thử lại.';
      main.innerHTML = `<div class="card"><h2>${title}</h2><p>${esc(why)}</p>${gone ? '<p class="sub">Mỗi link chỉ dùng cho một lượt giao nhận, trên một thiết bị.</p>' : '<button type="button" class="primary big b-retry">Thử lại</button>'}</div>`;
      const b = $('.b-retry', main);
      if (b) b.addEventListener('click', () => { main.innerHTML = '<p class="empty">Đang mở link…</p>'; shown = ''; load(); });
      if (gone) stop();
    }
    function paintTrack() { // cập nhật vị trí FO trên bản đồ mà không dựng lại trang
      const x = view;
      const info = $('.bl-eta', main), h = $('.bl-h', main);
      if (h) h.textContent = x.state === 'arrived' ? 'FO đã tới nơi' : 'FO đang trên đường';
      if (info) info.textContent = x.state === 'arrived' ? 'FO đã tới điểm của bạn, đang giao nhận.' : x.pos ? `Đang đến · còn khoảng ${String(x.dist_km).replace('.', ',')} km (~${x.eta_min} phút${x.eta_src === 'route' ? ', theo đường thực tế' : ''})${x.before ? ` · còn ghé ${x.before} điểm trước khi tới bạn` : ''}` : 'Chưa có vị trí của FO (FO mất sóng hoặc đang tạm dừng). Trang sẽ tự cập nhật.';
      const warn = $('.bl-warn', main);
      if (warn) { warn.hidden = !x.route_warn; warn.textContent = x.route_warn || ''; } // đường xe máy của Google đang thử nghiệm: Google yêu cầu ghi rõ
      if (!map) return;
      const site = [x.site.lat, x.site.lon];
      if (x.pos) {
        const p = [x.pos.lat, x.pos.lon];
        // Máy chủ chỉ gửi đoạn đường từ vị trí FO tới điểm của BO (không lộ các điểm khác của chuyến); không có thì nối thẳng nét đứt.
        const road = x.path ? ARL.decodePolyline(x.path) : [], ll = road.length > 1 ? road : [p, site];
        const style = road.length > 1 ? { color: '#1456C8', weight: 5, opacity: 0.9, dashArray: null } : { color: '#14213D', weight: 3, opacity: 0.6, dashArray: '6 8' };
        if (!foMarker) {
          foMarker = L.marker(p, { interactive: false, keyboard: false, zIndexOffset: 1000, icon: L.divIcon({ className: 'rm-wrap', iconSize: [34, 34], iconAnchor: [17, 17], html: `<div class="rm" data-st="moving" data-nohdg style="--c:#1456C8"><div class="rm-dot">${esc(nameParts(x.fo ? x.fo.name : 'FO').initials)}</div></div>` }) }).addTo(map);
          line = L.polyline(ll, { ...style, interactive: false }).addTo(map);
          map.fitBounds(L.latLngBounds(ll), { padding: [36, 36], maxZoom: 16, animate: false });
        } else { foMarker.setLatLng(p); line.setLatLngs(ll); line.setStyle(style); if (!map.getBounds().pad(-0.1).contains(p)) map.fitBounds(L.latLngBounds(ll), { padding: [36, 36], maxZoom: 16, animate: false }); }
      } else if (foMarker) { foMarker.remove(); line.remove(); foMarker = null; line = null; }
    }
    function paint() {
      const x = view;
      $('.bl-site', v).textContent = x.site.name;
      const key = x.state === 'coming' || x.state === 'arrived' ? 'track' : x.state;
      if (key === shown) { if (key === 'track') paintTrack(); return; } // cùng trạng thái: không dựng lại (giữ số và ảnh BO đang nhập)
      shown = key; dropMap(); pick = null;
      if (x.state === 'waiting') {
        main.innerHTML = `<div class="card"><h2>FO sắp tới điểm của bạn</h2><p>${foLine(x.fo)}</p><p>${x.fo ? `Dự kiến bắt đầu chuyến lúc ${fmtHM(x.start_at)}.` : ''} Khi FO lên đường, bản đồ theo dõi sẽ hiện ở đây.</p>${planLine(x)}${x.note ? `<p class="note">${esc(x.note)}</p>` : ''}</div><p class="sub">Giữ link này: sau khi FO giao nhận xong, bạn xác nhận ngay tại đây. Link chỉ dùng trên điện thoại này.</p>`;
      } else if (key === 'track') {
        main.innerHTML = `<div class="card"><h2 class="bl-h">FO đang trên đường</h2><p>${foLine(x.fo)}</p><p class="bl-eta" role="status" aria-live="polite"></p><div class="fmap bl-map" aria-label="Bản đồ vị trí FO và điểm của bạn"></div><p class="sub rt-note bl-warn" hidden></p>${planLine(x)}${x.note ? `<p class="note">${esc(x.note)}</p>` : ''}</div><p class="sub">Sau khi giao nhận xong và FO bấm xác nhận, phần xác nhận của bạn sẽ hiện ở đây. FO chỉ đi tiếp được khi bạn đã xác nhận.</p>`;
        map = baseMap($('.bl-map', main), { zoomControl: true, dragging: !L.Browser.mobile, tap: false, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false });
        L.marker([x.site.lat, x.site.lon], { interactive: false, keyboard: false, icon: pinIcon('●', 'arrived') }).addTo(map);
        map.setView([x.site.lat, x.site.lon], 15);
        setTimeout(() => { if (map) { map.invalidateSize(); paintTrack(); } }, 30);
        paintTrack();
      } else if (x.state === 'confirm') {
        const fc = x.fo_counts;
        const num = (label, cls, val) => `<label class="n">${label}<input type="number" class="${cls}" min="0" max="999" step="1" inputmode="numeric" value="${val}"></label>`;
        main.innerHTML = `<div class="card"><h2>Kiểm tra và xác nhận</h2><p>${foLine(x.fo)}</p><p><b>FO báo lúc ${fmtHM(x.done_at)}:</b> ${esc(countsText(fc.cards_out, fc.cards_in, fc.dev_out, fc.dev_in) || 'không giao nhận gì')}</p>${x.fo_note ? `<p class="note">FO ghi: ${esc(x.fo_note)}</p>` : ''}<div class="ph"></div>
          <p class="sub">Đếm lại thực tế rồi nhập. Số điền sẵn là số FO đã báo; nếu khác, cứ sửa cho đúng – Atlas sẽ liên hệ để đối chiếu.</p>
          <fieldset><legend>Bạn đã NHẬN từ FO</legend><div class="grid2">${num('Thẻ', 'f-cr', fc.cards_out)}${num('Thiết bị', 'f-dr', fc.dev_out)}</div></fieldset>
          <fieldset><legend>Bạn đã GIAO cho FO</legend><div class="grid2">${num('Thẻ', 'f-cg', fc.cards_in)}${num('Thiết bị', 'f-dg', fc.dev_in)}</div></fieldset>
          <div><span class="lbl">Ảnh chụp thẻ / thiết bị (bắt buộc)</span><div class="f-photos"></div></div>
          <label>Ghi chú (không bắt buộc)<input class="f-note" maxlength="300"></label>
          <label class="check"><input type="checkbox" class="f-ok"><span>Tôi xác nhận các số trên đúng với thực tế bàn giao.</span></label>
          <p class="err f-err" role="alert" hidden></p>
          <button type="button" class="primary big b-send">Xác nhận bàn giao</button></div><p class="sub">FO đang chờ: FO chỉ đi tiếp được sau khi bạn xác nhận.</p>`;
        if (x.photos.length) $('.ph', main).append(thumbs(x.photos));
        pick = photoPicker(x.maxPhotos || 4, 'Chụp ảnh thẻ / thiết bị');
        $('.f-photos', main).append(pick.el);
        $('.b-send', main).addEventListener('click', send);
      } else if (x.state === 'done') {
        const b = x.bo, ok = b.status === 'confirmed';
        main.innerHTML = `<div class="card"><h2>${ok ? 'Đã xác nhận bàn giao' : 'Đã ghi nhận số của bạn'}</h2><p class="${ok ? 'ok-t' : 'warn-t'}">${ok ? `Xác nhận lúc ${fmtHM(b.at)}. Cảm ơn bạn!` : `Ghi nhận lúc ${fmtHM(b.at)}. Số của bạn khác số FO báo; Atlas sẽ liên hệ để đối chiếu.`}</p><p>Bạn báo: nhận ${b.cards_recv} thẻ, ${b.dev_recv} thiết bị · giao ${b.cards_given} thẻ, ${b.dev_given} thiết bị.</p><div class="ph"></div></div><p class="sub">Bạn có thể đóng trang này. Link này không dùng lại cho lượt giao nhận khác.</p>`;
        if (x.photos && x.photos.length) $('.ph', main).append(thumbs(x.photos));
        stop();
      } else {
        main.innerHTML = '<div class="card"><h2>Lượt giao nhận này đã đóng</h2><p>Lượt này đã được huỷ hoặc đã được Logistic xử lý. Nếu cần, hãy liên hệ Logistic của Atlas Capture.</p></div>';
        stop();
      }
    }
    async function send() {
      const err = $('.f-err', main), btn = $('.b-send', main);
      const bad = (m) => { err.textContent = m; err.hidden = false; };
      err.hidden = true;
      const read = (cls) => { const s = $('.' + cls, main).value, n = s === '' ? 0 : Number(s); if (!Number.isInteger(n) || n < 0 || n > 999) throw new Error('Số lượng phải là số nguyên từ 0 đến 999.'); return n; };
      let body;
      try {
        if (pick.busy) throw new Error('Đang xử lý ảnh, đợi vài giây rồi bấm lại.');
        if (!pick.photos.length) throw new Error('Cần chụp ít nhất một ảnh.');
        if (!$('.f-ok', main).checked) throw new Error('Hãy đánh dấu ô xác nhận ở trên.');
        body = { photos: pick.photos, cards_recv: read('f-cr'), dev_recv: read('f-dr'), cards_given: read('f-cg'), dev_given: read('f-dg'), note: $('.f-note', main).value };
      } catch (e) { return bad(e.message); }
      btn.disabled = true; btn.textContent = 'Đang gửi…';
      try { view = await call('/api/bo-link/confirm', body); paint(); toast(view.bo && view.bo.status === 'confirmed' ? 'Đã xác nhận. Cảm ơn bạn!' : 'Đã ghi nhận.'); } catch (e) {
        if (e.code === 'already_confirmed' || e.code === 'link_invalid' || e.code === 'link_used') { shown = ''; return load(); }
        btn.disabled = false; btn.textContent = 'Xác nhận bàn giao'; bad(e.message);
      }
    }
    async function load() {
      if (busy || !alive) return;
      busy = true;
      try {
        const x = await call('/api/bo-link/view');
        if (!alive) return;
        view = x;
        if (x.cfg) ARL.cfg = { ...(ARL.cfg || {}), ...x.cfg };
        if (!ARL.demo && typeof x.now === 'number') ARL.skew = x.now - Date.now();
        paint();
      } catch (e) { if (alive && (!view || e.code === 'link_invalid' || e.code === 'link_used')) fail(e); } finally { busy = false; }
    }
    function stop() { clearInterval(timer); timer = null; }
    timer = setInterval(() => { if (!document.hidden) load(); }, 5000);
    const onVis = () => { if (!document.hidden && timer) load(); };
    document.addEventListener('visibilitychange', onVis);
    load();
    return function unmount() { alive = false; stop(); document.removeEventListener('visibilitychange', onVis); dropMap(); ARL.photoVia = null; };
  };
})();
