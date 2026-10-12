/* Điều phối — các trang toàn màn hình: tuyến định kỳ, thống kê, cảnh báo, tài khoản, thêm */
(() => {
  'use strict';
  const { $, $$, el, esc, api, toast, modal, ask, copyText, now, fmtHM, fmtDate, fmtDT, fmtKm, today, addDays, safeColor, ROLE_LABEL, WEATHER, TRAFFIC } = ARL;
  const DAYS = [[1, 'T2'], [2, 'T3'], [3, 'T4'], [4, 'T5'], [5, 'T6'], [6, 'T7'], [7, 'CN']];
  const P = (ARL.opsPages = {});
  const head = (title, right = '') => `<header class="page-head"><h1>${title}</h1><div class="page-actions">${right}</div></header>`;
  const stillOn = (ctx, tab) => ctx.S.tab === tab && ctx.v.isConnected;

  // ───────────── Tuyến định kỳ ─────────────
  P.routes = async function (ctx, page) {
    page.innerHTML = head('Tuyến định kỳ', '<button type="button" class="primary b-new">+ Tạo tuyến</button>') + '<p class="sub lead">Tuyến định kỳ tự sinh task vào đầu mỗi ngày có trong lịch (ví dụ swap thẻ hằng ngày), giao sẵn cho FO phụ trách.</p><ul class="cards"></ul><p class="empty" hidden></p>';
    $('.b-new', page).addEventListener('click', () => editor(ctx, null));
    let j;
    try { j = await api('GET', '/api/templates'); } catch (e) { $('.empty', page).hidden = false; $('.empty', page).textContent = e.message; return; }
    if (!stillOn(ctx, 'routes')) return;
    const ul = $('.cards', page);
    $('.empty', page).hidden = j.templates.length > 0;
    $('.empty', page).textContent = 'Chưa có tuyến định kỳ nào.';
    for (const t of j.templates) {
      const fo = ctx.S.fos.get(t.fo_id);
      const names = t.stops.map((s) => (ctx.S.sites.get(s.site_id) || { name: '(điểm đã xoá)' }).name);
      const li = el(`<li class="card" data-off="${t.active ? 0 : 1}">
        <div class="card-top"><h2>${esc(t.name)}</h2><span class="pill sm" data-ts="${t.active ? 'in_progress' : 'cancelled'}">${t.active ? 'Đang chạy' : 'Tạm dừng'}</span></div>
        <p class="days">${DAYS.map(([d, l]) => `<i class="${t.days.includes(d) ? 'on' : ''}">${l}</i>`).join('')}<b>${esc(t.start_time)}</b></p>
        <p class="who-sm">${fo ? `<i class="sw" style="--c:${safeColor(fo.color)}"></i>${esc(fo.name)}` : '<i class="sw none"></i>Chưa chọn FO (task sinh ra sẽ chờ giao tay)'}</p>
        <p class="sub">${t.stops.length} điểm${t.round_trip ? ', hai chiều' : ''}: ${esc(names.join(' → '))}</p>
        <div class="actions"><button type="button" class="b-edit">Sửa</button><button type="button" class="b-toggle">${t.active ? 'Tạm dừng' : 'Chạy lại'}</button><button type="button" class="b-run">Tạo task hôm nay</button><button type="button" class="ghost danger b-del">Xoá</button></div>
      </li>`);
      $('.b-edit', li).addEventListener('click', () => editor(ctx, t));
      $('.b-toggle', li).addEventListener('click', async () => { try { await api('PATCH', `/api/templates/${t.id}`, { active: !t.active }); toast(t.active ? 'Đã tạm dừng tuyến' : 'Tuyến chạy lại từ ngày kế tiếp trong lịch'); P.routes(ctx, page); } catch (e) { toast(e.message, true); } });
      $('.b-run', li).addEventListener('click', async () => { try { const r = await api('POST', `/api/templates/${t.id}/run`, {}); ctx.onTask(r.task); toast(`Đã tạo ${r.task.code}`); await ctx.loadTasks(today()); ctx.openTask(r.task.id); } catch (e) { toast(e.message, true); } });
      $('.b-del', li).addEventListener('click', async () => { if (!(await ask(`Xoá tuyến “${t.name}”? Các task đã sinh trước đó vẫn giữ nguyên.`, 'Xoá', true))) return; try { await api('DELETE', `/api/templates/${t.id}`); toast('Đã xoá tuyến'); P.routes(ctx, page); } catch (e) { toast(e.message, true); } });
      ul.append(li);
    }
  };
  function editor(ctx, t) {
    if (!ctx.S.sites.size) return toast('Chưa có điểm giao nhận nào. Vào mục “Điểm” để thêm trước.', true);
    const body = el(`<div class="stack">
      <label>Tên tuyến<input class="f-name" maxlength="80" value="${t ? esc(t.name) : ''}" placeholder="Ví dụ: Swap thẻ sáng – cụm Quận 1"></label>
      <div><span class="lbl">Chạy vào các ngày</span><div class="daypick">${DAYS.map(([d, l]) => `<label><input type="checkbox" value="${d}" ${(t ? t.days : [1, 2, 3, 4, 5, 6]).includes(d) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
      <div class="grid2"><label>Giờ bắt đầu<input type="time" class="f-time" value="${t ? esc(t.start_time) : '08:00'}"></label>
        <label>FO phụ trách<select class="f-fo"><option value="">— Chưa chọn —</option>${[...ctx.S.fos.values()].sort((a, b) => a.name.localeCompare(b.name, 'vi')).map((f) => `<option value="${f.id}" ${t && t.fo_id === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label></div>
      <label class="check"><input type="checkbox" class="f-rt" ${!t || t.round_trip ? 'checked' : ''}><span>Hai chiều: ghé xong thì quay về điểm đầu</span></label>
      <div><h3>Các điểm theo thứ tự ghé</h3><div class="f-stops"></div></div>
      <label>Ghi chú cho FO<textarea class="f-note" maxlength="500" rows="2">${t ? esc(t.note || '') : ''}</textarea></label>
    </div>`);
    const ed = ARL.opsStopsEditor(ctx, t ? t.stops : null, null);
    $('.f-stops', body).append(ed.el);
    ed.optButton.addEventListener('click', async () => {
      try { const j = await api('POST', '/api/plan', { stops: ed.value(), round_trip: $('.f-rt', body).checked, optimize: true }); if (j.order.every((x, i) => x === i)) return toast('Thứ tự hiện tại đã là ngắn nhất.'); ed.reorder(j.order); toast(`Đã sắp lại: ${fmtKm(j.plan_km)} → ${fmtKm(j.best_km)}`); } catch (e) { toast(e.message, true); }
    });
    modal({ title: t ? 'Sửa tuyến định kỳ' : 'Tạo tuyến định kỳ', body, wide: true, actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, { label: t ? 'Lưu' : 'Tạo tuyến', cls: 'primary', run: async () => {
      const b = { name: $('.f-name', body).value, days: $$('.daypick input:checked', body).map((x) => +x.value), start_time: $('.f-time', body).value, fo_id: $('.f-fo', body).value ? +$('.f-fo', body).value : null, round_trip: $('.f-rt', body).checked, note: $('.f-note', body).value, stops: ed.value() };
      if (!b.name.trim()) throw new Error('Cần nhập tên tuyến.');
      if (!b.days.length) throw new Error('Chọn ít nhất một ngày trong tuần.');
      if (!b.start_time) throw new Error('Cần chọn giờ bắt đầu.');
      if (t) await api('PATCH', `/api/templates/${t.id}`, b); else await api('POST', '/api/templates', b);
      toast(t ? 'Đã lưu tuyến' : 'Đã tạo tuyến');
      if (ctx.S.tab === 'routes') P.routes(ctx, $('.page', ctx.v));
      ctx.loadTasks(ctx.S.date);
    } }] });
  }

  // ───────────── Thống kê ─────────────
  const range = { from: null, to: null, preset: 'today' };
  P.stats = async function (ctx, page) {
    if (!range.from) { range.from = range.to = today(); }
    const presets = [['today', 'Hôm nay'], ['yesterday', 'Hôm qua'], ['7d', '7 ngày'], ['30d', '30 ngày']];
    page.innerHTML = head('Thống kê hiệu suất FO', '<button type="button" class="b-csv">Xuất CSV</button>') + `
      <div class="toolbar wrap"><div class="chips">${presets.map(([k, l]) => `<button type="button" class="chip" data-k="${k}" aria-pressed="${range.preset === k}">${l}</button>`).join('')}</div>
        <label class="inline-l">Từ <input type="date" class="f-from" value="${range.from}"></label><label class="inline-l">đến <input type="date" class="f-to" value="${range.to}"></label></div>
      <div class="kpis"></div><div class="tablewrap"><table class="tbl"><thead></thead><tbody></tbody></table></div><p class="empty" hidden></p>
      <p class="sub lead">Km thực tế tính từ GPS trong ca (bỏ rung khi đứng yên, đo theo đường nối các điểm GPS nên thường thấp hơn công-tơ-mét 5–15%). “Đúng hạn” = hoàn thành trước hạn SLA đã nới theo thời tiết, giao thông.</p>`;
    const setRange = (f, t, preset) => { range.from = f; range.to = t; range.preset = preset; P.stats(ctx, page); };
    $('.chips', page).addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      const t = today(), k = b.dataset.k;
      if (k === 'today') setRange(t, t, k); else if (k === 'yesterday') setRange(addDays(t, -1), addDays(t, -1), k); else if (k === '7d') setRange(addDays(t, -6), t, k); else setRange(addDays(t, -29), t, k);
    });
    const custom = () => { const f = $('.f-from', page).value, t = $('.f-to', page).value; if (f && t) setRange(f, t < f ? f : t, 'custom'); };
    $('.f-from', page).addEventListener('change', custom); $('.f-to', page).addEventListener('change', custom);
    $('.b-csv', page).addEventListener('click', async () => {
      const q = { from: range.from, to: range.to };
      if (ARL.backend.csvUrl) { const a = document.createElement('a'); a.href = ARL.backend.csvUrl(q); a.download = ''; document.body.append(a); a.click(); a.remove(); return; }
      try { const j = await api('GET', '/api/stats.csv', null, q); const pre = el('<div><p class="sub">Bản xem thử không tải tệp về được. Nội dung CSV (bản cài thật sẽ tải thẳng về máy):</p><textarea class="csv" rows="12" readonly></textarea></div>'); $('textarea', pre).value = j.__csv.text.replace(/^\ufeff/, ''); modal({ title: j.__csv.name, body: pre, wide: true }); } catch (e) { toast(e.message, true); }
    });
    let s;
    try { s = await api('GET', '/api/stats', null, { from: range.from, to: range.to }); } catch (e) { $('.empty', page).hidden = false; $('.empty', page).textContent = e.message; return; }
    if (!stillOn(ctx, 'stats')) return;
    const T = s.totals, pct = (v) => (v === null ? '–' : v + '%');
    const kpi = (label, val, sub = '') => `<div class="kpi"><dt>${label}</dt><dd>${val}</dd><small>${sub}</small></div>`;
    $('.kpis', page).innerHTML = kpi('Km thực tế', fmtKm(T.km), `${T.move_min} phút di chuyển`) + kpi('Task hoàn thành', `${T.completed}/${T.tasks}`, `${T.open} đang mở · ${T.failed} thất bại · ${T.cancelled} huỷ${T.unassigned ? ` · ${T.unassigned} chưa giao` : ''}`) + kpi('Đúng hạn', pct(T.ontime_pct), `${T.late} task trễ`) + kpi('Thẻ', `thu ${T.cards_in} · giao ${T.cards_out}`, `thiết bị: thu ${T.dev_in} · giao ${T.dev_out}`) + kpi('Điểm giao nhận', `${T.stops_done} xong`, `${T.stops_failed} không giao được · ${T.photos} ảnh`) + kpi('BO xác nhận', `${T.bo_confirmed} đủ`, `${T.bo_mismatch} lệch · ${T.bo_pending} chưa xác nhận`);
    const cols = [['Km', (r) => (r.km || 0).toLocaleString('vi-VN')], ['Task xong', (r) => `${r.completed}/${r.tasks}`], ['Đúng hạn', (r) => (r.completed ? Math.round((r.ontime / r.completed) * 100) + '%' : '–')], ['Trễ', (r) => r.late], ['Điểm xong', (r) => r.stops_done], ['Không giao được', (r) => r.stops_failed], ['Thẻ giao', (r) => r.cards_out], ['Thẻ thu', (r) => r.cards_in], ['TB giao', (r) => r.dev_out], ['TB thu', (r) => r.dev_in], ['Ảnh', (r) => r.photos], ['BO đủ', (r) => r.bo_confirmed], ['BO lệch', (r) => r.bo_mismatch]];
    $('thead', page).innerHTML = `<tr><th>FO</th>${cols.map(([l]) => `<th>${l}</th>`).join('')}</tr>`;
    const tb = $('tbody', page);
    $('.empty', page).hidden = s.fos.length > 0;
    $('.empty', page).textContent = 'Chưa có số liệu trong khoảng ngày này.';
    $('.tablewrap', page).hidden = !s.fos.length;
    for (const f of s.fos) {
      const multi = range.from !== range.to;
      const tr = el(`<tr class="fo-row ${multi ? 'click' : ''}"><th><span class="who-sm"><i class="sw" style="--c:${safeColor(f.fo.color)}"></i>${esc(f.fo.name)}${f.fo.active ? '' : ' (đã khoá)'}</span>${multi ? '<small>bấm để xem từng ngày</small>' : ''}</th>${cols.map(([, fn]) => `<td>${fn(f)}</td>`).join('')}</tr>`);
      tb.append(tr);
      if (multi) tr.addEventListener('click', () => {
        const open = tr.dataset.open === '1';
        tr.dataset.open = open ? '0' : '1';
        for (const x of $$(`tr.day[data-fo="${f.fo.id}"]`, tb)) x.remove();
        if (open) return;
        let after = tr;
        for (const d of s.days.filter((x) => x.fo_id === f.fo.id)) { const r = el(`<tr class="day" data-fo="${f.fo.id}"><th>${fmtDate(d.date)}</th>${cols.map(([, fn]) => `<td>${fn(d)}</td>`).join('')}</tr>`); after.after(r); after = r; }
      });
    }
  };

  // ───────────── Cảnh báo ─────────────
  let onlyOpen = true;
  P.alerts = async function (ctx, page) {
    const S = ctx.S;
    if (!S.alerts) { page.innerHTML = head('Cảnh báo') + '<p class="empty">Đang tải…</p>'; await ctx.refreshAlertCount(); if (!stillOn(ctx, 'alerts')) return; if (!S.alerts) { page.innerHTML = head('Cảnh báo') + '<p class="empty">Không tải được cảnh báo. Kiểm tra mạng rồi mở lại mục này.</p>'; return; } }
    const list = S.alerts.filter((a) => !onlyOpen || !a.ack_at);
    page.innerHTML = head('Cảnh báo', `<button type="button" class="b-all" ${S.openAlerts ? '' : 'disabled'}>Đánh dấu tất cả đã xử lý</button>`) + `<div class="chips"><button type="button" class="chip" data-o="1" aria-pressed="${onlyOpen}">Chưa xử lý (${S.openAlerts})</button><button type="button" class="chip" data-o="0" aria-pressed="${!onlyOpen}">Tất cả 7 ngày</button></div><ul class="alist"></ul><p class="empty" ${list.length ? 'hidden' : ''}>${onlyOpen ? 'Không có cảnh báo nào đang chờ xử lý.' : 'Chưa có cảnh báo nào trong 7 ngày qua.'}</p>`;
    $('.chips', page).addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (b) { onlyOpen = b.dataset.o === '1'; P.alerts(ctx, page); } });
    $('.b-all', page).addEventListener('click', async () => { try { await api('POST', '/api/alerts/ack-all'); for (const a of S.alerts) if (!a.ack_at) a.ack_at = now(); ctx.setBadge(0); P.alerts(ctx, page); } catch (e) { toast(e.message, true); } });
    const ul = $('.alist', page);
    for (const a of list.slice(0, 150)) {
      const li = el(`<li class="alert" data-lv="${a.level}" data-ack="${a.ack_at ? 1 : 0}"><span class="lv">${a.level === 'alert' ? 'Khẩn' : 'Lưu ý'}</span><div><p>${esc(a.text)}</p><small>${fmtDT(a.ts)}${a.ack_at ? ' · đã xử lý' : ''}</small></div><div class="alert-actions">${a.task_id ? '<button type="button" class="b-open">Mở task</button>' : ''}${a.ack_at ? '' : '<button type="button" class="ghost b-ack">Đã xử lý</button>'}</div></li>`);
      if (a.task_id) $('.b-open', li).addEventListener('click', () => ctx.openTask(a.task_id));
      if (!a.ack_at) $('.b-ack', li).addEventListener('click', async () => { try { await api('POST', `/api/alerts/${a.id}/ack`); if (!a.ack_at) { a.ack_at = now(); ctx.setBadge(S.openAlerts - 1); } P.alerts(ctx, page); } catch (e) { toast(e.message, true); } });
      ul.append(li);
    }
  };

  // ───────────── Tài khoản (Logistic Lead) ─────────────
  function showCredentials(title, user, pw) {
    const text = `Atlas Rider Live\nĐịa chỉ: ${location.origin + location.pathname}\nTên đăng nhập: ${user.username}\nMật khẩu tạm: ${pw}\n(Đăng nhập lần đầu sẽ phải đổi mật khẩu.)`;
    const body = el(`<div class="stack"><p>Gửi thông tin này cho <b>${esc(user.name)}</b> qua kênh riêng (Zalo/Slack cá nhân). Mật khẩu tạm chỉ hiện <b>một lần</b> ở đây.</p><pre class="cred"></pre><button type="button" class="b-copy">Sao chép</button></div>`);
    $('.cred', body).textContent = text;
    $('.b-copy', body).addEventListener('click', () => copyText(text, 'Đã sao chép thông tin đăng nhập'));
    modal({ title, body, actions: [{ label: 'Tôi đã gửi cho người dùng', cls: 'primary', run: () => {} }] });
  }
  function userDialog(ctx, page, u, canCreate) {
    // Chỉ liệt kê vai mà máy chủ cho tài khoản này tạo (Logistic Lead tạo FO và Logistic; Quản trị tạo cả Logistic Lead), tránh bấm xong mới bị từ chối.
    const roles = [['fo', 'FO – FieldOps đi giao nhận'], ['logistic', 'Logistic – điều phối'], ['lead', 'Logistic Lead – điều phối + quản lý tài khoản']].filter(([r]) => !Array.isArray(canCreate) || canCreate.includes(r));
    const body = el(`<div class="stack">
      <label>Họ tên<input class="f-name" maxlength="60" value="${u ? esc(u.name) : ''}"></label>
      ${u ? '' : `<label>Tên đăng nhập (chữ thường không dấu, số, dấu . _ - @)<input class="f-username" maxlength="40" autocapitalize="none" spellcheck="false" placeholder="vd: tuan.nguyen hoặc 0901234567"></label>
      <label>Vai trò<select class="f-role">${roles.map(([r, l]) => `<option value="${r}">${l}</option>`).join('')}</select></label>`}
      <label>Số điện thoại<input class="f-phone" maxlength="20" inputmode="tel" value="${u ? esc(u.phone) : ''}"></label>
      <label class="for-fo">Biển số xe<input class="f-vehicle" maxlength="30" value="${u ? esc(u.vehicle) : ''}"></label>
    </div>`);
    const role = () => (u ? u.role : $('.f-role', body).value);
    const upd = () => { $('.for-fo', body).hidden = role() !== 'fo'; };
    if (!u) $('.f-role', body).addEventListener('change', upd);
    upd();
    modal({ title: u ? `Sửa tài khoản ${u.username}` : 'Tạo tài khoản', body, actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, { label: u ? 'Lưu' : 'Tạo tài khoản', cls: 'primary', run: async () => {
      const b = { name: $('.f-name', body).value, phone: $('.f-phone', body).value };
      if (role() === 'fo') b.vehicle = $('.f-vehicle', body).value;
      if (u) { await api('PATCH', `/api/users/${u.id}`, b); toast('Đã lưu'); } else {
        b.username = $('.f-username', body).value.trim().toLowerCase(); b.role = role();
        const j = await api('POST', '/api/users', b);
        showCredentials('Đã tạo tài khoản', j.user, j.tempPassword);
      }
      P.users(ctx, page);
    } }] });
  }
  async function deviceDialog(u) {
    let j;
    try { j = await api('GET', `/api/users/${u.id}/device`); } catch (e) { return toast(e.message, true); }
    const url = location.origin + location.pathname.replace(/\/[^/]*$/, '/') + 'osmand';
    const body = el(`<div class="stack"><p class="sub">Trang web không gửi được vị trí khi FO tắt màn hình. Nếu cần chạy nền, cài app <b>Traccar Client</b> (Android/iOS) trên máy FO rồi nhập hai dòng dưới. FO vẫn dùng trang web này để nhận task và chụp ảnh.</p><label>Địa chỉ máy chủ<input readonly class="f-url"></label><label>Mã thiết bị (giữ kín như mật khẩu)<input readonly class="f-tok"></label><p class="sub">Vị trí từ Traccar chỉ được nhận khi FO đã đồng ý điều khoản. Ca tự mở khi có điểm đầu tiên và tự đóng sau 10 phút mất tín hiệu.</p></div>`);
    $('.f-url', body).value = url; $('.f-tok', body).value = j.deviceToken;
    modal({ title: `Chạy nền cho ${u.name}`, body, actions: [{ label: 'Đổi mã mới', cls: 'ghost danger', run: async () => { if (!(await ask('Đổi mã thiết bị? Mã cũ ngừng hoạt động ngay, phải nhập lại mã mới trong app Traccar của FO.', 'Đổi mã', true))) return false; const r = await api('POST', `/api/users/${u.id}/device`); $('.f-tok', body).value = r.deviceToken; toast('Đã đổi mã thiết bị'); return false; } }, { label: 'Sao chép mã', run: () => { copyText(j.deviceToken); return false; } }, { label: 'Đóng', cls: 'primary', run: () => {} }] });
  }
  async function termsEditor(ctx, page) {
    let t;
    try { t = await api('GET', '/api/terms'); } catch (e) { return toast(e.message, true); }
    const body = el(`<div class="stack"><p class="sub">Đây là nội dung FO phải đánh dấu đồng ý từng mục ở lần đăng nhập đầu. Mỗi mục cách nhau bằng <b>một dòng trống</b>. Bản mặc định là bản mẫu kỹ thuật; hãy để pháp chế rà soát trước khi dùng chính thức.</p><label>Tiêu đề<input class="f-title" maxlength="120" value="${esc(t.title || '')}"></label><label>Lời dẫn<textarea class="f-intro" rows="3" maxlength="1500">${esc(t.intro || '')}</textarea></label><label>Các mục (cách nhau bằng dòng trống)<textarea class="f-items" rows="14"></textarea></label><p class="sub">Bản hiện tại: ${esc(t.version)}</p></div>`);
    $('.f-items', body).value = t.items.join('\n\n');
    modal({ title: 'Điều khoản xử lý dữ liệu của FO', body, wide: true, actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, { label: 'Lưu bản mới', cls: 'primary', run: async () => {
      const items = $('.f-items', body).value.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
      if (!items.length) throw new Error('Cần ít nhất một mục.');
      if (!(await ask(`Lưu bản điều khoản mới gồm ${items.length} mục? MỌI FO sẽ phải đọc và đồng ý lại trước khi dùng tiếp; ca đang chạy của FO sẽ bị đóng.`, 'Lưu và yêu cầu đồng ý lại', true))) return false;
      await api('PUT', '/api/terms', { title: $('.f-title', body).value, intro: $('.f-intro', body).value, items });
      toast('Đã lưu điều khoản mới');
      P.users(ctx, page);
    } }] });
  }
  async function consentLog() {
    let j;
    try { j = await api('GET', '/api/consents'); } catch (e) { return toast(e.message, true); }
    let users = new Map();
    try { users = new Map((await api('GET', '/api/users')).users.map((u) => [u.id, u])); } catch { /* vẫn hiện bằng mã số */ }
    const body = el(`<div class="tablewrap"><table class="tbl"><thead><tr><th>FO</th><th>Việc</th><th>Lúc</th><th>Bản</th><th>IP</th><th>Thiết bị</th></tr></thead><tbody>${j.consents.map((c) => `<tr><th>${esc((users.get(c.user_id) || { name: '#' + c.user_id }).name)}</th><td>${c.action === 'agree' ? 'Đồng ý' : 'Rút lại'}</td><td>${fmtDT(c.ts)}</td><td>${esc(c.version)}</td><td>${esc(c.ip)}</td><td class="ua">${esc(c.ua)}</td></tr>`).join('') || '<tr><td colspan="6">Chưa có ghi nhận nào.</td></tr>'}</tbody></table></div>`);
    modal({ title: 'Lịch sử đồng ý điều khoản', body, wide: true });
  }
  P.users = async function (ctx, page) {
    page.innerHTML = head('Tài khoản', '<button type="button" class="b-terms">Điều khoản FO</button><button type="button" class="b-log">Lịch sử đồng ý</button><button type="button" class="primary b-new">+ Tạo tài khoản</button>') + '<div class="tablewrap"><table class="tbl users"><thead><tr><th>Họ tên</th><th>Tên đăng nhập</th><th>Vai trò</th><th>Trạng thái</th><th>Điều khoản</th><th></th></tr></thead><tbody></tbody></table></div><p class="empty" hidden></p>';
    $('.b-new', page).addEventListener('click', () => userDialog(ctx, page, null, page._canCreate));
    $('.b-terms', page).addEventListener('click', () => termsEditor(ctx, page));
    $('.b-log', page).addEventListener('click', consentLog);
    let j;
    try { j = await api('GET', '/api/users'); } catch (e) { $('.empty', page).hidden = false; $('.empty', page).textContent = e.message; return; }
    if (!stillOn(ctx, 'users')) return;
    page._canCreate = j.canCreate; // vai được phép tạo, máy chủ trả về theo tài khoản đang đăng nhập
    const tb = $('tbody', page), order = { lead: 0, logistic: 1, fo: 2 };
    for (const u of j.users.sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name, 'vi'))) {
      const site = u.site_id ? ctx.S.sites.get(u.site_id) : null;
      const tr = el(`<tr data-off="${u.active ? 0 : 1}"><th>${esc(u.name)}<small>${esc([u.phone, u.vehicle, site ? site.name : ''].filter(Boolean).join(' · '))}</small></th><td>${esc(u.username)}</td><td>${esc(ROLE_LABEL[u.role])}</td>
        <td>${u.active ? (u.must_change ? '<span class="warn-t">Chưa đổi mật khẩu tạm</span>' : 'Đang hoạt động') : '<span class="err">Đã khoá</span>'}</td>
        <td>${u.role !== 'fo' ? '–' : u.consent_ok ? `<span class="ok-t">Đã đồng ý</span><small>${fmtDT(u.consent_at)}</small>` : '<span class="warn-t">Chưa đồng ý</span>'}</td>
        <td class="acts"><button type="button" class="b-edit">Sửa</button><button type="button" class="b-reset">Cấp lại mật khẩu</button>${u.role === 'fo' ? '<button type="button" class="b-dev">Chạy nền</button>' : ''}<button type="button" class="ghost ${u.active ? 'danger' : ''} b-lock">${u.active ? 'Khoá' : 'Mở khoá'}</button></td></tr>`);
      $('.b-edit', tr).addEventListener('click', () => userDialog(ctx, page, u));
      $('.b-reset', tr).addEventListener('click', async () => { if (!(await ask(`Cấp mật khẩu tạm mới cho ${u.name}? Mật khẩu cũ và mọi phiên đang đăng nhập của người này sẽ hết hiệu lực.`, 'Cấp lại'))) return; try { const r = await api('POST', `/api/users/${u.id}/reset`); showCredentials('Mật khẩu tạm mới', u, r.tempPassword); P.users(ctx, page); } catch (e) { toast(e.message, true); } });
      if (u.role === 'fo') $('.b-dev', tr).addEventListener('click', () => deviceDialog(u));
      $('.b-lock', tr).addEventListener('click', async () => { if (u.active && !(await ask(`Khoá tài khoản của ${u.name}? Người này bị đăng xuất ngay và không đăng nhập lại được cho tới khi mở khoá.`, 'Khoá', true))) return; try { await api('PATCH', `/api/users/${u.id}`, { active: !u.active }); toast(u.active ? 'Đã khoá tài khoản' : 'Đã mở khoá'); P.users(ctx, page); } catch (e) { toast(e.message, true); } });
      tb.append(tr);
    }
  };

  // ───────────── "Thêm" (điện thoại) ─────────────
  P.more = function (ctx, page) {
    const c = ctx.S.conditions;
    page.innerHTML = head('Thêm') + `<ul class="menu"><li><button type="button" data-go="routes">Tuyến định kỳ<small>Lịch tự sinh task hằng ngày</small></button></li><li><button type="button" data-go="sites">Điểm giao nhận<small>Văn phòng, kho, BO</small></button></li>${ctx.isLead ? '<li><button type="button" data-go="users">Tài khoản<small>FO, Logistic: tạo, khoá, cấp lại mật khẩu, điều khoản FO</small></button></li>' : ''}<li><button type="button" data-do="cond">Điều kiện thời tiết / giao thông<small>${c ? `Đang áp dụng ×${c.factor}: ${esc(WEATHER[c.weather])}, ${esc(TRAFFIC[c.traffic]).toLowerCase()}` : ''}</small></button></li><li><button type="button" data-do="acct">Tài khoản của tôi<small>${esc(ctx.me.user.name)} · đổi mật khẩu, đăng xuất</small></button></li></ul>`;
    $('.menu', page).addEventListener('click', (e) => { // gắn vào danh sách (được dựng lại mỗi lần) để không cộng dồn trình nghe
      const b = e.target.closest('button[data-go],button[data-do]');
      if (!b) return;
      if (b.dataset.go) ctx.go(b.dataset.go); else if (b.dataset.do === 'cond') ARL.opsConditionsDialog(ctx); else ARL.opsAccountDialog(ctx);
    });
  };
})();
