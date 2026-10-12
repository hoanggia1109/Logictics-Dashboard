/* Điều phối — hộp thoại: soạn task, giao lại, điểm, điều kiện thời tiết/giao thông, tài khoản của tôi */
(() => {
  'use strict';
  const { $, $$, el, esc, api, toast, modal, ask, now, fmtHM, fmtKm, today, dateOf, pad2, safeColor, WEATHER, TRAFFIC, ROLE_LABEL, baseMap, parseCoord, HCMC } = ARL;

  const siteOptions = (ctx, sel) => {
    const list = [...ctx.S.sites.values()].sort((a, b) => (a.type === 'office' ? -1 : 0) - (b.type === 'office' ? -1 : 0) || a.name.localeCompare(b.name, 'vi'));
    return '<option value="">— Chọn điểm —</option>' + list.map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  };
  const foOptions = (ctx, sel, withNone = true) => {
    const list = [...ctx.S.fos.values()].sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    return (withNone ? '<option value="">— Chưa giao cho ai —</option>' : '') + list.map((f) => `<option value="${f.id}" ${f.id === sel ? 'selected' : ''}>${esc(f.name)}${f.consent_ok ? '' : ' (chưa đồng ý điều khoản)'}</option>`).join('');
  };

  /** Bộ soạn danh sách điểm dùng chung cho task và tuyến định kỳ. */
  function stopsEditor(ctx, initial, onChange) {
    const rows = (initial && initial.length ? initial : [{}, {}]).map((s) => ({ site_id: s.site_id || '', cards_out: s.cards_out || 0, cards_in: s.cards_in || 0, dev_out: s.dev_out || 0, dev_in: s.dev_in || 0, note: s.note || '' }));
    const box = el('<div class="se"><ol class="se-list"></ol><div class="se-actions"><button type="button" class="b-add">+ Thêm điểm</button><button type="button" class="ghost b-opt" title="Sắp lại thứ tự ghé cho quãng đường ngắn nhất, giữ nguyên điểm đầu">Sắp thứ tự ngắn nhất</button></div></div>');
    const list = $('.se-list', box);
    const num = (label, key, v) => `<label class="n">${label}<input type="number" min="0" max="999" step="1" inputmode="numeric" data-k="${key}" value="${v}"></label>`;
    function paint() {
      list.innerHTML = '';
      rows.forEach((r, i) => {
        const li = el(`<li class="se-row">
          <div class="se-top"><span class="num">${i + 1}</span><select data-k="site_id" aria-label="Điểm thứ ${i + 1}">${siteOptions(ctx, +r.site_id || null)}</select>
            <button type="button" class="ghost up" aria-label="Đưa lên" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="ghost down" aria-label="Đưa xuống" ${i === rows.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="ghost danger del" aria-label="Bỏ điểm này" ${rows.length <= 1 ? 'disabled' : ''}>×</button></div>
          <div class="se-nums">${num('Giao thẻ', 'cards_out', r.cards_out)}${num('Thu thẻ', 'cards_in', r.cards_in)}${num('Giao TB', 'dev_out', r.dev_out)}${num('Thu TB', 'dev_in', r.dev_in)}</div>
          <input class="se-note" data-k="note" maxlength="200" placeholder="Ghi chú cho FO tại điểm này (không bắt buộc)" value="${esc(r.note)}">
        </li>`);
        li.addEventListener('input', (e) => { const k = e.target.dataset.k; if (!k) return; r[k] = e.target.value; if (onChange) onChange(); });
        li.addEventListener('change', (e) => { if (e.target.dataset.k && onChange) onChange(); });
        $('.up', li).addEventListener('click', () => { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); paint(); if (onChange) onChange(); });
        $('.down', li).addEventListener('click', () => { rows.splice(i + 1, 0, rows.splice(i, 1)[0]); paint(); if (onChange) onChange(); });
        $('.del', li).addEventListener('click', () => { rows.splice(i, 1); paint(); if (onChange) onChange(); });
        list.append(li);
      });
      $('.b-add', box).disabled = rows.length >= 15;
    }
    $('.b-add', box).addEventListener('click', () => { rows.push({ site_id: '', cards_out: 0, cards_in: 0, dev_out: 0, dev_in: 0, note: '' }); paint(); if (onChange) onChange(); });
    paint();
    const api_ = {
      el: box,
      /** Trả về mảng điểm đã kiểm tra; ném lỗi tiếng Việt nếu còn thiếu. */
      value() {
        return rows.map((r, i) => {
          if (!r.site_id) throw new Error(`Điểm thứ ${i + 1} chưa chọn. Chọn điểm hoặc bấm × để bỏ.`);
          const o = { site_id: +r.site_id, note: String(r.note || '').trim() };
          for (const k of ['cards_out', 'cards_in', 'dev_out', 'dev_in']) {
            const n = r[k] === '' ? 0 : Number(r[k]);
            if (!Number.isInteger(n) || n < 0 || n > 999) throw new Error(`Điểm thứ ${i + 1}: số lượng phải là số nguyên từ 0 đến 999.`);
            o[k] = n;
          }
          return o;
        });
      },
      complete: () => rows.length > 0 && rows.every((r) => r.site_id),
      /** Mã điểm đã chọn theo thứ tự (null nếu dòng đó chưa chọn) — để vẽ bản đồ xem trước. */
      ids: () => rows.map((r) => +r.site_id || null),
      reorder(order) { const copy = rows.slice(); rows.length = 0; for (const i of order) rows.push(copy[i]); paint(); if (onChange) onChange(); },
      setDisabled(d) { for (const x of $$('input,select,button', box)) x.disabled = d; },
      optButton: $('.b-opt', box),
    };
    return api_;
  }
  ARL.opsStopsEditor = stopsEditor;

  const noDot = (s) => String(s || '').replace(/[.\s]+$/, '');
  /**
   * Xem trước khi soạn task: "Dự kiến ≈ 12,3 km · SLA 75 phút", giải thích SLA, bản đồ nhỏ (ghim + đường đi thực tế; chưa có thì nét đứt).
   * Có dịch vụ đường đi thì chờ máy chủ tính (gửi ngày + giờ bắt đầu để lấy giao thông đúng giờ đi); kết quả của danh sách cũ bị bỏ qua.
   * Trả về { el, run, mount (dựng bản đồ khi hộp thoại đã hiện), destroy (gỡ bản đồ khi đóng), lock (task không sửa điểm được: chỉ xem) }.
   */
  function planBox(ctx, editor, roundTripEl, dateEl, timeEl) {
    const box = el(`<div class="plan-box">
      <p class="plan" aria-live="polite"></p><p class="rt-bd" hidden></p><p class="warn-t plan-err" hidden></p>
      <div class="plan-map" aria-label="Bản đồ xem trước đường đi của task"></div>
      <p class="rt-src" hidden></p><div class="plan-lg"></div><p class="rt-note" hidden></p>
    </div>`);
    const line = $('.plan', box), bd = $('.rt-bd', box), err = $('.plan-err', box), src = $('.rt-src', box), lgBox = $('.plan-lg', box), note = $('.rt-note', box);
    const routing = () => !!(ARL.cfg && ARL.cfg.routing);
    const show = (node, text) => { node.textContent = text || ''; node.hidden = !text; };
    const when = () => ({ date: dateEl.value || undefined, start_time: timeEl.value || undefined });
    const sigNow = () => JSON.stringify([editor.ids(), roundTripEl.checked, dateEl.value, timeEl.value]);
    let map = null, pinL = null, lineL = null, t = null, seq = 0, res = null, pend = null, locked = null, closed = false;
    function paintText(msg, busy) {
      const j = !msg && res && res.sig === sigNow() ? res.j : null;
      line.classList.toggle('rt-busy', !!busy);
      for (const n of [bd, err, src, note]) show(n, '');
      lgBox.replaceChildren();
      if (!j) return show(line, msg || '');
      const start = /^\d\d:\d\d$/.test(timeEl.value) && dateEl.value ? ARL.dayStart(dateEl.value) + (+timeEl.value.slice(0, 2) * 60 + +timeEl.value.slice(3)) * 60000 : null;
      show(line, `Dự kiến ≈ ${fmtKm(j.plan_km)} · SLA ${j.sla_min} phút${start ? ` · hạn ${fmtHM(start + j.sla_min * 60000)}` : ''}`);
      show(bd, ARL.slaBreakdown(j, editor.ids().length));
      show(err, j.route_err ? `Chưa lấy được đường đi thực tế: ${noDot(j.route_err)}. SLA tạm tính theo đường chim bay.` : '');
      show(src, ARL.routeText(j));
      const lg = j.route ? ARL.routeLegend(j) : null;
      if (lg) lgBox.append(lg);
      show(note, ARL.routeNote(j));
    }
    /** Ghim các điểm đã chọn (vẽ ngay) + đường: kết quả khớp danh sách hiện tại thì đường thực tế, chưa có thì nét đứt nối các điểm. */
    function paintMap() {
      if (!map) return;
      pinL.clearLayers(); lineL.clearLayers();
      const b = L.latLngBounds([]);
      if (locked) {
        const tk = locked.task, my = seq;
        tk.stops.forEach((s, i) => { if (!s.is_return) L.marker([s.lat, s.lon], { icon: ARL.pinIcon(String(i + 1), s.status), interactive: false, keyboard: false }).addTo(pinL); b.extend([s.lat, s.lon]); });
        ARL.taskRoute(tk.id, tk.route_src ? tk.route_at : null).catch(() => ({ route: null })).then((j) => { if (map && my === seq) { lineL.clearLayers(); ARL.drawRoute(lineL, j.stale ? null : j.route, { points: tk.stops }); } });
      } else {
        const sites = editor.ids().map((id) => (id ? ctx.S.sites.get(id) : null));
        sites.forEach((s, i) => { if (s) { L.marker([s.lat, s.lon], { icon: ARL.pinIcon(String(i + 1)), interactive: false, keyboard: false }).addTo(pinL); b.extend([s.lat, s.lon]); } });
        if (editor.complete() && sites.every(Boolean)) {
          const pts = roundTripEl.checked ? [...sites, sites[0]] : sites;
          b.extend(ARL.drawRoute(lineL, res && res.sig === sigNow() ? res.j.route : null, { points: pts }));
        }
      }
      if (b.isValid()) map.fitBounds(b, { paddingTopLeft: [62, 22], paddingBottomRight: [70, 26], maxZoom: 15, animate: false }); // ghim không nằm dưới nút thu phóng (trái) và nút chọn lớp nền (phải)
    }
    const drop = () => { clearTimeout(t); pend = null; seq++; }; // bỏ lượt đang chờ / đang tính
    const run = () => {
      if (locked || closed) return;
      if (!editor.complete()) { drop(); paintMap(); return paintText('Chọn đủ các điểm để xem quãng đường và SLA dự kiến.'); }
      let stops;
      try { stops = editor.value(); } catch (e) { drop(); paintMap(); return paintText(e.message); }
      const sig = sigNow();
      paintMap();
      if (res && res.sig === sig) { drop(); return paintText(); } // chỉ đổi số lượng / ghi chú (hoặc đổi rồi đổi lại): không tính lại
      if (pend === sig) return; // đang tính đúng danh sách này: chờ tiếp
      drop(); pend = sig;
      const my = seq;
      if (routing()) paintText('Đang tính đường thực tế…', true);
      t = setTimeout(async () => {
        try {
          const j = await api('POST', '/api/plan', { stops, round_trip: roundTripEl.checked, ...when() });
          if (my !== seq || closed) return;
          res = { sig, j }; pend = null;
          paintText(); paintMap();
        } catch (e) { if (my === seq && !closed) { pend = null; paintText(e.message); } }
      }, routing() ? 600 : 350);
    };
    let optBusy = false;
    editor.optButton.addEventListener('click', async () => {
      if (optBusy) return;
      optBusy = true;
      try {
        const j = await api('POST', '/api/plan', { stops: editor.value(), round_trip: roundTripEl.checked, optimize: true, ...when() });
        if (j.order.every((x, i) => x === i)) return toast('Thứ tự hiện tại đã là ngắn nhất.');
        editor.reorder(j.order);
        toast(`Đã sắp lại (ước tính đường chim bay): ${fmtKm(j.est ? j.est.plan_km : j.plan_km)} → ${fmtKm(j.best_km)}`); // thứ tự gợi ý tính theo đường chim bay, so cùng kiểu
      } catch (e) { toast(e.message, true); } finally { optBusy = false; }
    });
    roundTripEl.addEventListener('change', run);
    dateEl.addEventListener('change', run);
    timeEl.addEventListener('change', run);
    return {
      el: box, run,
      mount() {
        if (map || closed) return;
        map = baseMap($('.plan-map', box), { zoomControl: true, scrollWheelZoom: false, dragging: !L.Browser.mobile, tap: false, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false });
        lineL = L.layerGroup().addTo(map); pinL = L.layerGroup().addTo(map);
        const c = ctx.map.getCenter();
        map.setView([c.lat, c.lng], Math.max(11, ctx.map.getZoom() - 1));
        map.invalidateSize();
        paintMap();
      },
      destroy() { closed = true; drop(); ARL.killMap(map); map = null; },
      lock(msg, task) { locked = { task }; drop(); paintText(msg); paintMap(); },
    };
  }

  async function suggestInto(ctx, select, hint, firstSiteId) {
    const site = ctx.S.sites.get(+firstSiteId);
    if (!site) { hint.textContent = 'Chọn điểm đầu tiên trước, rồi bấm gợi ý.'; return; }
    try {
      const j = await api('GET', '/api/suggest', null, { lat: site.lat, lon: site.lon });
      const best = j.fos[0];
      if (!best) { hint.textContent = 'Chưa có FO nào sẵn sàng (đã đồng ý điều khoản).'; return; }
      select.value = String(best.id);
      hint.textContent = `Gợi ý ${best.name}: ${best.km === null ? 'chưa rõ vị trí' : `cách điểm đầu ${fmtKm(best.km)}`}, đang có ${best.open} task mở${best.onShift ? '' : ', hiện ngoài ca'}.`;
    } catch (e) { hint.textContent = e.message; }
  }

  /** Tạo task mới (task = null) hoặc sửa task chưa kết thúc. */
  ARL.opsTaskEditor = function (ctx, task) {
    const { S } = ctx;
    if (!S.sites.size) return toast('Chưa có điểm giao nhận nào. Vào mục “Điểm” để thêm trước.', true);
    const running = task && task.status === 'in_progress';
    const adhoc = task && task.stops.some((s) => !s.is_return && !s.site_id);
    const lockStops = running || adhoc;
    const init = task ? task.stops.filter((s) => !s.is_return).map((s) => ({ site_id: s.site_id, cards_out: s.exp_cards_out, cards_in: s.exp_cards_in, dev_out: s.exp_dev_out, dev_in: s.exp_dev_in, note: s.note })) : null;
    const defDate = task ? task.date : S.date >= today() ? S.date : today();
    let defTime = '08:00';
    if (task) defTime = fmtHM(task.start_at);
    else if (defDate === today()) { const t = now() + 10 * 60000, d = new Date(Math.ceil(t / 300000) * 300000); defTime = dateOf(d.getTime()) === today() ? fmtHM(d.getTime()) : '23:55'; }
    const body = el(`<div class="stack">
      <label>Tên task (để trống sẽ tự đặt theo điểm đến)<input class="f-title" maxlength="80" value="${task ? esc(task.title) : ''}"></label>
      <div class="grid2">
        <label>Ngày<input type="date" class="f-date" value="${defDate}" min="${ARL.addDays(today(), -1)}" ${task ? 'disabled' : ''}></label>
        <label>Giờ bắt đầu<input type="time" class="f-time" value="${defTime}" ${running ? 'disabled' : ''}></label>
      </div>
      <label>Giao cho FO<div class="inline"><select class="f-fo">${foOptions(ctx, task ? task.fo_id : null)}</select><button type="button" class="b-suggest">Gợi ý FO gần nhất</button></div></label>
      <p class="sub f-hint"></p>
      <label class="check"><input type="checkbox" class="f-rt" ${task && task.round_trip ? 'checked' : ''} ${lockStops ? 'disabled' : ''}><span>Hai chiều: ghé xong các điểm thì quay về điểm đầu (vẫn tính là 1 task)</span></label>
      <div><h3>Các điểm theo thứ tự ghé</h3><p class="sub">Điểm đầu thường là văn phòng (nhận thẻ trống). “Giao/Thu” tính theo phía FO: giao cho điểm, thu về từ điểm.</p><div class="f-stops"></div></div>
      <label>Ghi chú chung cho FO<textarea class="f-note" maxlength="500" rows="2">${task ? esc(task.note) : ''}</textarea></label>
    </div>`);
    const rt = $('.f-rt', body), foSel = $('.f-fo', body), hint = $('.f-hint', body);
    let plan = null;
    const editor = stopsEditor(ctx, init, () => plan && plan.run());
    plan = planBox(ctx, editor, rt, $('.f-date', body), $('.f-time', body));
    $('.f-stops', body).append(editor.el, plan.el);
    if (lockStops) { editor.setDisabled(true); plan.lock(running ? 'Task đang chạy: không đổi được danh sách điểm và giờ bắt đầu.' : 'Task này có điểm nhập tay qua API nên không sửa danh sách điểm ở đây được.', task); } else plan.run();
    $('.b-suggest', body).addEventListener('click', () => { let first = ''; try { first = editor.value()[0].site_id; } catch { first = ''; } suggestInto(ctx, foSel, hint, first); });
    const dlg = modal({
      title: task ? `Sửa ${task.code}` : 'Tạo task', body, wide: true, onClose: () => plan.destroy(),
      actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, {
        label: task ? 'Lưu thay đổi' : 'Tạo task', cls: 'primary', run: async () => {
          const b = { title: $('.f-title', body).value.trim(), note: $('.f-note', body).value, fo_id: foSel.value ? +foSel.value : null };
          if (!running) { const tm = $('.f-time', body).value; if (tm) b.start_time = tm; }
          if (!lockStops) { b.stops = editor.value(); b.round_trip = rt.checked; }
          let j;
          if (task) {
            if (!b.title) delete b.title;
            if (b.fo_id === task.fo_id) delete b.fo_id; // không đổi FO thì không gửi, tránh đưa task đang chạy về "chờ nhận"
            if (b.start_time === fmtHM(task.start_at)) delete b.start_time;
            j = await api('PATCH', `/api/tasks/${task.id}`, b);
          } else { b.date = $('.f-date', body).value || today(); j = await api('POST', '/api/tasks', b); }
          ctx.onTask(j.task);
          toast(task ? 'Đã lưu' : `Đã tạo ${j.task.code}`);
          if (!task) { if (S.date !== j.task.date) await ctx.loadTasks(j.task.date); ctx.openTask(j.task.id); }
        },
      }],
    });
    // Bản đồ xem trước chỉ dựng được sau khi hộp thoại đã hiện (cần kích thước thật).
    setTimeout(() => { if (dlg.el.isConnected) plan.mount(); }, 60);
  };

  /** Giao lại task cho FO khác, kèm danh sách gợi ý theo khoảng cách và số việc đang mở. */
  ARL.opsAssignDialog = async function (ctx, task) {
    const first = task.stops.find((s) => s.status === 'pending' || s.status === 'arrived') || task.stops[0];
    const body = el('<div class="stack"><p class="sub">Chọn FO nhận task. Danh sách xếp theo mức phù hợp: gần điểm kế tiếp, đang ít việc, đang trong ca.</p><ul class="pick"></ul><p class="sub s-wait">Đang tìm FO phù hợp…</p></div>');
    const ul = $('.pick', body);
    const dlg = modal({ title: `Giao lại ${task.code}`, body, actions: [{ label: 'Gỡ FO (để chưa giao)', cls: 'ghost', run: async () => { const j = await api('PATCH', `/api/tasks/${task.id}`, { fo_id: null }); ctx.onTask(j.task); toast('Đã gỡ FO khỏi task'); } }, { label: 'Đóng', cls: 'ghost', run: () => {} }] });
    try {
      const j = await api('GET', '/api/suggest', null, { lat: first.lat, lon: first.lon });
      $('.s-wait', body).hidden = true;
      if (!j.fos.length) ul.innerHTML = '<li class="sub">Chưa có FO nào sẵn sàng (đã đồng ý điều khoản).</li>';
      j.fos.forEach((f, i) => {
        const li = el(`<li><button type="button" class="row" ${f.id === task.fo_id ? 'disabled' : ''}><span class="sw" style="--c:${safeColor(f.color)}"></span><span class="nm"><span>${esc(f.name)}${f.id === task.fo_id ? ' (đang giữ task)' : i === 0 ? ' · gợi ý' : ''}</span><small>${f.km === null ? 'Chưa rõ vị trí' : 'Cách ' + fmtKm(f.km)} · ${f.open} task mở · ${f.onShift ? 'đang trong ca' : 'ngoài ca'}</small></span></button></li>`);
        li.firstElementChild.addEventListener('click', async () => {
          try { const r = await api('PATCH', `/api/tasks/${task.id}`, { fo_id: f.id }); ctx.onTask(r.task); toast(`Đã giao ${task.code} cho ${f.name}`); dlg.close(); } catch (e) { dlg.setErr(e.message); }
        });
        ul.append(li);
      });
    } catch (e) { $('.s-wait', body).textContent = e.message; }
  };

  /** Thêm / sửa điểm giao nhận, chọn vị trí bằng bản đồ nhỏ, dán toạ độ hoặc link Google Maps. */
  ARL.opsSiteDialog = function (ctx, site) {
    const s = site || { name: '', type: 'bo', address: '', contact: '', phone: '', lat: null, lon: null, radius: (ARL.cfg && ARL.cfg.arriveRadiusM) || 120 };
    const body = el(`<div class="stack">
      <div class="grid2"><label>Tên điểm<input class="f-name" maxlength="80" value="${esc(s.name)}"></label>
        <label>Loại<select class="f-type"><option value="bo">BO (điểm của khách)</option><option value="office">Văn phòng / kho</option><option value="other">Khác</option></select></label></div>
      <label>Địa chỉ<input class="f-addr" maxlength="200" value="${esc(s.address || '')}"></label>
      <div class="grid2"><label>Người liên hệ<input class="f-contact" maxlength="60" value="${esc(s.contact || '')}"></label><label>Số điện thoại<input class="f-phone" maxlength="20" inputmode="tel" value="${esc(s.phone || '')}"></label></div>
      <label>Vị trí: dán toạ độ (vd 10.7725, 106.6980) hoặc link Google Maps, hoặc bấm lên bản đồ bên dưới<input class="f-paste" placeholder="10.7725, 106.6980" autocomplete="off"></label>
      <div class="pickmap" aria-label="Bản đồ chọn vị trí"></div>
      <div class="grid3"><label>Vĩ độ<input class="f-lat" inputmode="decimal" value="${s.lat ?? ''}"></label><label>Kinh độ<input class="f-lon" inputmode="decimal" value="${s.lon ?? ''}"></label><label>Bán kính “đã đến” (m)<input class="f-radius" type="number" min="30" max="2000" step="10" value="${s.radius}"></label></div>
      <p class="sub">FO vào trong bán kính này thì hệ thống tự ghi “đã đến”. Trong phố đông nhà cao tầng nên để 100–150 m.</p>
    </div>`);
    $('.f-type', body).value = s.type;
    // BO dùng chung với Ops Hub: không đổi loại ở đây; BO đang ghi hình / tạm nghỉ / thu hồi không xoá ở đây (máy chủ cũng chặn).
    const isBo = !!site && site.type === 'bo';
    const boBusy = isBo && ['live', 'paused', 'ending'].includes(site.ops_status);
    if (isBo) {
      $('.f-type', body).disabled = true;
      body.append(el(`<p class="sub">Điểm này là BO của Ops Hub: loại điểm giữ nguyên. ${boBusy ? 'BO đang dùng nên không xoá ở đây; kết thúc ghi hình và thu hồi kit ở Ops Hub.' : 'BO còn kit, việc hoặc yêu cầu đang mở thì không xoá được.'}</p>`));
    }
    const latEl = $('.f-lat', body), lonEl = $('.f-lon', body), radEl = $('.f-radius', body);
    let pm = null, marker = null, circle = null;
    const setPos = (lat, lon, pan) => {
      latEl.value = lat; lonEl.value = lon;
      if (!pm) return;
      if (!marker) {
        marker = L.marker([lat, lon], { draggable: true, icon: ARL.pinIcon('●', 'arrived') }).addTo(pm);
        marker.on('dragend', () => { const p = marker.getLatLng(); setPos(+p.lat.toFixed(6), +p.lng.toFixed(6)); });
        circle = L.circle([lat, lon], { radius: +radEl.value || 120, color: '#1456C8', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(pm);
      } else { marker.setLatLng([lat, lon]); circle.setLatLng([lat, lon]); }
      if (pan) pm.setView([lat, lon], Math.max(pm.getZoom(), 16));
    };
    const fromInputs = () => { const c = parseCoord(`${latEl.value}, ${lonEl.value}`); if (c) setPos(c.lat, c.lon, true); };
    latEl.addEventListener('change', fromInputs); lonEl.addEventListener('change', fromInputs);
    radEl.addEventListener('input', () => { if (circle) circle.setRadius(+radEl.value || 120); });
    $('.f-paste', body).addEventListener('input', (e) => { const c = parseCoord(e.target.value); if (c) { setPos(c.lat, c.lon, true); toast('Đã nhận toạ độ'); } });
    const actions = [{ label: 'Thôi', cls: 'ghost', run: () => {} }, {
      label: site ? 'Lưu' : 'Thêm điểm', cls: 'primary', run: async () => {
        const c = parseCoord(`${latEl.value}, ${lonEl.value}`);
        if (!$('.f-name', body).value.trim()) throw new Error('Cần nhập tên điểm.');
        if (!c) throw new Error('Chưa có vị trí hợp lệ. Bấm lên bản đồ hoặc dán toạ độ.');
        const b = { name: $('.f-name', body).value, type: $('.f-type', body).value, address: $('.f-addr', body).value, contact: $('.f-contact', body).value, phone: $('.f-phone', body).value, lat: c.lat, lon: c.lon, radius: radEl.value === '' ? null : +radEl.value };
        const j = site ? await api('PATCH', `/api/sites/${site.id}`, b) : await api('POST', '/api/sites', b);
        ctx.S.sites.set(j.site.id, j.site); ctx.paintSites(); ctx.renderSites();
        toast(site ? 'Đã lưu điểm' : 'Đã thêm điểm');
      },
    }];
    if (site && !boBusy) actions.unshift({ label: 'Xoá điểm', cls: 'ghost danger', run: async () => {
      if (!(await ask(`Xoá điểm “${site.name}”? Các task cũ vẫn giữ nguyên thông tin điểm này.`, 'Xoá', true))) return false;
      await api('DELETE', `/api/sites/${site.id}`);
      ctx.S.sites.delete(site.id); ctx.paintSites(); ctx.renderSites();
      toast('Đã xoá điểm');
    } });
    const dlg = modal({ title: site ? 'Sửa điểm' : 'Thêm điểm giao nhận', body, wide: true, actions, onClose: () => { ARL.killMap(pm); pm = null; } });
    // Bản đồ chỉ dựng được sau khi hộp thoại đã hiện (cần kích thước thật).
    setTimeout(() => {
      if (!dlg.el.isConnected) return;
      pm = baseMap($('.pickmap', body), { zoomControl: true, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false });
      for (const o of ctx.S.sites.values()) if (!site || o.id !== site.id) L.marker([o.lat, o.lon], { interactive: false, keyboard: false, icon: ARL.siteIcon(o.name, o.type) }).addTo(pm);
      if (s.lat !== null) { pm.setView([s.lat, s.lon], 16); setPos(s.lat, s.lon); } else { const c = ctx.map.getCenter(); pm.setView([c.lat, c.lng], Math.max(12, ctx.map.getZoom() - 1)); }
      pm.on('click', (e) => setPos(+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)));
    }, 60);
  };

  /** Điều kiện thời tiết / giao thông: quyết định hệ số nới SLA cho các task chưa xong. */
  ARL.opsConditionsDialog = function (ctx) {
    const c = ctx.S.conditions;
    if (!c) return;
    const opt = (map, sel) => Object.entries(map).map(([k, label]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${label}</option>`).join('');
    const body = el(`<div class="stack">
      <p class="sub">Hệ số này nhân vào SLA của mọi task chưa xong. Task đang chạy chỉ được nới thêm, không bị rút lại khi điều kiện tốt lên.</p>
      <fieldset><legend>Thời tiết</legend>
        <label class="check"><input type="radio" name="wm" value="auto" ${c.weatherMode === 'auto' ? 'checked' : ''} ${c.canAutoWeather ? '' : 'disabled'}><span>Tự động theo dịch vụ thời tiết${c.canAutoWeather ? '' : ' (máy chủ chưa bật – xem README)'}</span></label>
        <label class="check"><input type="radio" name="wm" value="manual" ${c.weatherMode !== 'auto' ? 'checked' : ''}><span>Chỉnh tay</span></label>
        <select class="f-weather">${opt(WEATHER, c.weather)}</select>
        ${c.weatherErr ? `<p class="err">Lần lấy thời tiết gần nhất bị lỗi (${esc(c.weatherErr)}). Đang giữ mức cũ.</p>` : ''}${c.weatherMode === 'auto' && c.weatherAt ? `<p class="sub">Cập nhật lúc ${fmtHM(c.weatherAt)}.</p>` : ''}
      </fieldset>
      <fieldset><legend>Giao thông</legend>
        <label class="check"><input type="radio" name="tm" value="auto" ${c.trafficMode === 'auto' ? 'checked' : ''}><span>Tự động theo giờ cao điểm (T2–T7: 6:30–9:00 và 16:30–19:30)</span></label>
        <label class="check"><input type="radio" name="tm" value="manual" ${c.trafficMode !== 'auto' ? 'checked' : ''}><span>Chỉnh tay</span></label>
        <select class="f-traffic">${opt(TRAFFIC, c.traffic)}</select>
      </fieldset>
      <p class="f-factor"></p>
    </div>`);
    const F = { clear: 1, rain: 1.2, heavy: 1.4, storm: 1.6, normal: 1, peak: 1.25, jam: 1.5 };
    const wSel = $('.f-weather', body), tSel = $('.f-traffic', body);
    const mode = (n) => $(`input[name=${n}]:checked`, body).value;
    const upd = () => {
      wSel.disabled = mode('wm') === 'auto'; tSel.disabled = mode('tm') === 'auto';
      const tf = mode('tm') === 'auto' ? c.traffic : tSel.value, wf = mode('wm') === 'auto' ? c.weather : wSel.value;
      $('.f-factor', body).textContent = `Hệ số SLA sẽ áp dụng: ×${Math.min(2, +(F[wf] * F[tf]).toFixed(2))}${mode('tm') === 'auto' || mode('wm') === 'auto' ? ' (phần tự động có thể đổi theo giờ / thời tiết)' : ''}`;
    };
    body.addEventListener('change', upd); upd();
    modal({ title: 'Điều kiện thời tiết và giao thông', body, actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, { label: 'Áp dụng', cls: 'primary', run: async () => {
      const b = { weatherMode: mode('wm'), trafficMode: mode('tm') };
      if (b.weatherMode === 'manual') b.weather = wSel.value;
      if (b.trafficMode === 'manual') b.traffic = tSel.value;
      ctx.setConditions(await api('PUT', '/api/conditions', b));
      toast('Đã áp dụng điều kiện mới');
    } }] });
  };

  /** Tạo link dùng một lần cho BO của một điểm; hiện link + tin nhắn mẫu để Logistic gửi (Zalo, SMS…). */
  ARL.opsBoLinkDialog = async function (ctx, task, stop) {
    if (stop.bo_link && !(await ask(`Tạo link mới cho ${ARL.boLabel(stop.name)}? Link cũ sẽ hết hiệu lực ngay; BO phải dùng link mới.`, 'Tạo link mới'))) return;
    let j;
    try { j = await api('POST', `/api/stops/${stop.id}/bo-link`); } catch (e) { return toast(e.message, true); }
    ctx.onTask(j.task);
    const url = location.origin + location.pathname + '?b=' + j.token;
    const msg = `Atlas Capture: ${task.fo ? 'FO ' + task.fo.name : 'nhân viên Atlas'} sẽ tới ${stop.name} hôm nay (dự kiến xuất phát ${fmtHM(task.start_at)}). Anh/chị bấm link để theo dõi và XÁC NHẬN BÀN GIAO (kèm ảnh) sau khi giao nhận xong:\n${url}\nLink chỉ dùng cho lượt này, trên 1 điện thoại – xin đừng chuyển tiếp.`;
    const body = el(`<div class="stack"><p>Gửi tin nhắn dưới đây cho <b>${esc(stop.name)}</b>${stop.phone ? ` (${esc(stop.phone)})` : ''}. Link chỉ hiện <b>một lần</b> ở đây; nếu BO làm mất hoặc mở nhầm máy, bấm “Tạo lại link BO”.</p><textarea class="csv f-msg" rows="7" readonly></textarea><p class="sub">Link gắn với điện thoại đầu tiên mở nó, chỉ dùng cho lượt giao nhận này và tự hết hạn sau 48 giờ. FO chỉ đi tiếp được khi BO đã xác nhận.</p></div>`);
    $('.f-msg', body).value = msg;
    const actions = [{ label: 'Sao chép tin nhắn', cls: 'primary', run: () => { ARL.copyText(msg, 'Đã sao chép tin nhắn cho BO'); return false; } }];
    if (navigator.share) actions.unshift({ label: 'Chia sẻ…', run: () => { navigator.share({ text: msg }).catch(() => {}); return false; } });
    if (ARL.demo) actions.unshift({ label: 'Mở link này (đóng vai BO)', run: () => { ARL.boToken = j.token; ARL.reboot(); } });
    actions.push({ label: 'Đóng', cls: 'ghost', run: () => {} });
    modal({ title: `Link cho ${ARL.boLabel(stop.name)}`, body, actions });
  };
  /** Lối thoát khi BO không xác nhận được: Logistic cho qua, bắt buộc ghi lý do (có lưu vết). */
  ARL.opsBoWaiveDialog = function (ctx, task, stop) {
    const body = el(`<div class="stack"><p>Cho FO đi tiếp mà không có xác nhận của BO <b>${esc(stop.name)}</b>? Chỉ dùng khi BO thật sự không xác nhận được (không liên lạc được, máy hết pin…). Việc này được ghi vào nhật ký task.</p><label>Lý do (bắt buộc)<input class="f-reason" maxlength="200" placeholder="Ví dụ: BO hết pin, đã gọi điện xác nhận đủ số"></label></div>`);
    modal({ title: 'Cho qua xác nhận của BO', body, cls: 'small', actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, { label: 'Cho qua', cls: 'primary danger-bg', run: async () => {
      const reason = $('.f-reason', body).value.trim();
      if (reason.length < 3) throw new Error('Cần ghi lý do.');
      const j = await api('POST', `/api/stops/${stop.id}/bo-waive`, { reason });
      ctx.onTask(j.task); toast('Đã cho qua; FO đi tiếp được');
    } }] });
  };

  ARL.opsAccountDialog = function (ctx) {
    const u = ctx.me.user;
    const body = el(`<div class="stack"><p><b>${esc(u.name)}</b><br><span class="sub">${esc(ROLE_LABEL[u.role])} · tên đăng nhập ${esc(u.username)}</span></p><button type="button" class="b-pw">Đổi mật khẩu</button><button type="button" class="danger b-out">Đăng xuất</button></div>`);
    const dlg = modal({ title: 'Tài khoản của tôi', body, cls: 'small' });
    $('.b-pw', body).addEventListener('click', () => { dlg.close(); ARL.changePasswordDialog(); });
    $('.b-out', body).addEventListener('click', () => { dlg.close(); ARL.logout(); });
  };
})();
