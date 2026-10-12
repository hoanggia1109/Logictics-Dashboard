/* Atlas Rider Live — phần dùng chung cho mọi màn hình. Không cần build: JS thuần + Leaflet. */
(() => {
  'use strict';
  const ARL = (window.ARL = window.ARL || {});

  // ───────────── DOM ─────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  /** Tạo phần tử từ chuỗi HTML (đã tự thoát ký tự qua esc() ở nơi ghép chuỗi). */
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  let toastT;
  // Hộp thoại mở bằng showModal() nằm ở lớp trên cùng: thông báo phải nằm trong hộp thoại đang mở thì mới không bị che.
  const topLayerHost = (except) => [...document.querySelectorAll('dialog[open]')].filter((x) => x !== except).pop() || document.body;
  function toast(msg, bad) {
    let t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); t.hidden = true; }
    const host = topLayerHost();
    if (t.parentNode !== host) host.append(t);
    t.textContent = msg; t.hidden = false; t.dataset.bad = bad ? '1' : '0';
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, bad ? 5200 : 3200);
  }
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* hết chỗ hoặc chế độ riêng tư */ } },
  };

  // ───────────── Số, thời gian (hiển thị theo múi giờ của hệ thống, mặc định Việt Nam) ─────────────
  const RAD = Math.PI / 180;
  const distM = (aLat, aLon, bLat, bLon) => {
    const dLat = (bLat - aLat) * RAD, dLon = (bLon - aLon) * RAD;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
    return 12742000 * Math.asin(Math.min(1, Math.sqrt(s)));
  };
  const pad2 = (n) => String(n).padStart(2, '0');
  /** Tên BO kèm chữ "BO", trừ khi tên đã bắt đầu bằng "BO" (giống core/util.js boLabel). */
  ARL.boLabel = (name) => { const n = String(name ?? '').trim(); return /^bo(\s|$)/i.test(n) ? n : `BO ${n}`; };
  const tzOff = () => (ARL.cfg ? ARL.cfg.tzOffsetMin : 420);
  ARL.skew = 0; // chênh giữa đồng hồ máy chủ và máy này
  const now = () => Date.now() + ARL.skew;
  const shifted = (ts) => new Date(ts + tzOff() * 60000);
  const fmtHM = (ts, sec) => { if (!ts) return '–'; const d = shifted(ts); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}${sec ? ':' + pad2(d.getUTCSeconds()) : ''}`; };
  const dateOf = (ts) => shifted(ts).toISOString().slice(0, 10);
  const today = () => dateOf(now());
  const dayStart = (dateStr) => Date.parse(dateStr + 'T00:00:00Z') - tzOff() * 60000;
  const addDays = (dateStr, n) => new Date(Date.parse(dateStr + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const DOW = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  const fmtDate = (dateStr) => { const d = new Date(dateStr + 'T00:00:00Z'); return `${(ARL.DOW || DOW)[d.getUTCDay()]} ${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}`; };
  const fmtDT = (ts) => (ts ? `${fmtHM(ts)} ${fmtDate(dateOf(ts)).slice(-5)}` : '–');
  const kmh = (mps) => Math.round((mps || 0) * 3.6);
  const fmtKm = (km) => (km === null || km === undefined ? '–' : (Math.round(km * 10) / 10).toLocaleString(ARL.lang === 'en' ? 'en-US' : 'vi-VN') + ' km');
  function ago(sec) {
    const isEn = ARL.lang === 'en';
    if (sec < 5) return isEn ? 'just now' : 'vừa xong';
    if (sec < 60) return isEn ? `${Math.floor(sec)}s ago` : `${Math.floor(sec)} giây trước`;
    if (sec < 3600) return isEn ? `${Math.floor(sec / 60)}m ago` : `${Math.floor(sec / 60)} phút trước`;
    if (sec < 86400) return isEn ? `${Math.floor(sec / 3600)}h ago` : `${Math.floor(sec / 3600)} giờ trước`;
    return isEn ? `${Math.floor(sec / 86400)}d ago` : `${Math.floor(sec / 86400)} ngày trước`;
  }
  function span(sec) {
    const isEn = ARL.lang === 'en';
    sec = Math.max(0, sec);
    if (sec < 60) return isEn ? '< 1 min' : 'dưới 1 phút';
    if (sec < 3600) return isEn ? `${Math.floor(sec / 60)} min` : `${Math.floor(sec / 60)} phút`;
    const m = Math.floor((sec % 3600) / 60);
    return isEn ? `${Math.floor(sec / 3600)} hr${m ? ` ${m} min` : ''}` : `${Math.floor(sec / 3600)} giờ${m ? ` ${m} phút` : ''}`;
  }
  // Tên Việt: tên gọi là chữ cuối. "Nguyễn Minh Tuấn" → nhãn "Tuấn N.", chữ tắt "TN".
  function nameParts(name) {
    const w = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!w.length) return { short: '?', initials: '?', given: '' };
    const given = w[w.length - 1], family = w.length > 1 ? w[0] : '';
    return { given, short: family ? `${given} ${family[0].toUpperCase()}.` : given, initials: (given[0] + (family ? family[0] : '')).toUpperCase() };
  }
  const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#1456C8');
  const telHref = (p) => { const t = String(p || '').replace(/[^\d+]/g, ''); return t ? 'tel:' + t : ''; };

  // ───────────── Nhãn nghiệp vụ ─────────────
  const ROLE_LABEL = { lead: 'Logistic Lead', logistic: 'Logistic', fo: 'FO' };
  const TASK_ST = { unassigned: 'Chưa giao', assigned: 'Chờ FO nhận', accepted: 'FO đã nhận', in_progress: 'Đang chạy', completed: 'Hoàn thành', failed: 'Không hoàn thành', cancelled: 'Đã huỷ' };
  const STOP_ST = { pending: 'Chưa đến', arrived: 'Đã đến', done: 'Đã xong', failed: 'Không giao được', skipped: 'Bỏ qua' };
  const BO_ST = { none: '', pending: 'Chờ BO xác nhận', confirmed: 'BO đã xác nhận', mismatch: 'BO báo lệch số', waived: 'Logistic đã cho qua xác nhận của BO' };
  const WEATHER = { clear: 'Trời tạnh', rain: 'Mưa', heavy: 'Mưa to', storm: 'Giông bão' };
  const TRAFFIC = { normal: 'Bình thường', peak: 'Giờ cao điểm', jam: 'Kẹt xe nặng' };
  const ISSUES = { ket_xe: 'Kẹt xe', hong_xe: 'Hỏng xe', tai_nan: 'Tai nạn / va chạm', khong_gap: 'Không gặp người nhận', cho_bo: 'Đang chờ BO xác nhận', thieu_hang: 'Thiếu thẻ / thiết bị', khac: 'Việc khác' };
  const isOpen = (t) => ['unassigned', 'assigned', 'accepted', 'in_progress'].includes(t.status);
  /** Tình trạng hạn của task: { key: ok|risk|late|done|doneLate|off, text }. */
  function slaOf(t, at) {
    at = at || now();
    const isEn = ARL.lang === 'en';
    if (t.status === 'cancelled') return { key: 'off', text: isEn ? 'Cancelled' : 'Đã huỷ' };
    if (t.status === 'completed' || t.status === 'failed') return t.late ? { key: 'doneLate', text: isEn ? `Late ${span((t.finished_at - t.due_at) / 1000)}` : `Trễ ${span((t.finished_at - t.due_at) / 1000)}` } : { key: 'done', text: t.status === 'failed' ? (isEn ? 'Failed' : 'Không hoàn thành') : (isEn ? 'On time' : 'Đúng hạn') };
    const left = (t.due_at - at) / 1000;
    if (left < 0) return { key: 'late', text: isEn ? `Overdue ${span(-left)}` : `Quá hạn ${span(-left)}` };
    if (left < 600) return { key: 'risk', text: isEn ? `${span(left)} left` : `Còn ${span(left)}` };
    return { key: 'ok', text: isEn ? `Due ${fmtHM(t.due_at)}` : `Hạn ${fmtHM(t.due_at)}` };
  }
  /** "giao 2 thẻ · thu 2 thẻ · giao 1 TB" từ 4 con số; rỗng nếu toàn 0. */
  function countsText(co, ci, dOut, dIn) {
    const isEn = ARL.lang === 'en';
    const p = [];
    if (co) p.push(isEn ? `deliv ${co} card${co > 1 ? 's' : ''}` : `giao ${co} thẻ`);
    if (ci) p.push(isEn ? `ret ${ci} card${ci > 1 ? 's' : ''}` : `thu ${ci} thẻ`);
    if (dOut) p.push(isEn ? `deliv ${dOut} dev` : `giao ${dOut} TB`);
    if (dIn) p.push(isEn ? `ret ${dIn} dev` : `thu ${dIn} TB`);
    return p.join(' · ');
  }
  const progressOf = (t) => { const s = t.stops || []; return { done: s.filter((x) => x.status === 'done' || x.status === 'failed' || x.status === 'skipped').length, total: s.length }; };

  // ───────────── Kết nối máy chủ (bản xem thử thay bằng ARL_BACKEND chạy trong trình duyệt) ─────────────
  const real = {
    async api(method, path, body, query) {
      const qs = query ? '?' + new URLSearchParams(query) : '';
      let r;
      try {
        r = await fetch(path.replace(/^\//, '') + qs, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      } catch { throw Object.assign(new Error('Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.'), { status: 0, code: 'network' }); }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(j.message || 'Có lỗi xảy ra. Thử lại.'), { status: r.status, code: j.error || 'http_' + r.status, data: j });
      return j;
    },
    photoUrl: (id) => 'api/photo/' + encodeURIComponent(id),
    boPhotoUrl: (id, token) => 'api/bo-link/photo/' + encodeURIComponent(id) + '?t=' + encodeURIComponent(token),
    csvUrl: (q) => 'api/stats.csv?' + new URLSearchParams(q),
    geo: null, // dùng navigator.geolocation thật
    connect(onMsg, onState) {
      let ws, tries = 0, stopped = false, pingT, lastMsgAt = 0, ready = false;
      const open = () => {
        if (stopped) return;
        const u = new URL('ws', document.baseURI);
        u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(u);
        lastMsgAt = Date.now();
        ws.onmessage = (e) => {
          lastMsgAt = Date.now();
          let m;
          try { m = JSON.parse(e.data); } catch { return; }
          if (m.t === 'hello') { tries = 0; ready = true; if (typeof m.now === 'number') ARL.skew = m.now - Date.now(); onState('live'); }
          if (m.t === 'kick') { stopped = true; }
          onMsg(m);
        };
        ws.onclose = () => {
          clearInterval(pingT);
          const was = ready;
          ready = false;
          if (stopped) return;
          tries++;
          onState('down', was);
          // Nối lại thất bại nhiều lần: có thể phiên đăng nhập đã hết → hỏi máy chủ, nếu 401 thì về màn hình đăng nhập.
          if (tries === 2 || tries % 6 === 0) real.api('GET', '/api/me').then((m) => { if (!m.user) ARL.onUnauth(); }).catch(() => {});
          setTimeout(open, Math.min(15000, 600 * 2 ** Math.min(tries, 5)) + Math.random() * 400);
        };
        pingT = setInterval(() => {
          // Máy chủ luôn trả lời ping; im lặng quá 45 giây nghĩa là kết nối đã chết mà trình duyệt chưa biết → nối lại.
          if (Date.now() - lastMsgAt > 45000) { const dead = ws; dead.onmessage = null; const oc = dead.onclose; dead.onclose = null; try { dead.close(); } catch { /* đã đóng */ } oc(); return; }
          if (ws.readyState === 1) ws.send('{"t":"ping"}');
        }, 20000);
      };
      onState('connecting');
      open();
      return {
        send(o) { if (ready && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; } return false; },
        get ready() { return ready; },
        kickReconnect() { if (!stopped && ws && ws.readyState !== 1) { tries = 0; } },
        close() { stopped = true; clearInterval(pingT); if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close(); } catch { /* đã đóng */ } } },
      };
    },
  };
  const backend = window.ARL_BACKEND || real;
  ARL.demo = !!window.ARL_BACKEND;
  /**
   * Cùng một trình duyệt chỉ giữ được MỘT phiên đăng nhập (cookie dùng chung cho mọi tab). Đăng nhập tài khoản khác ở tab thứ hai
   * thì tab thứ nhất vẫn vẽ màn hình của tài khoản cũ nhưng mọi yêu cầu đi bằng phiên mới → máy chủ từ chối "không có quyền".
   * Hai lớp bảo vệ: (1) tab vừa đăng nhập / đăng xuất ghi dấu vào localStorage → các tab khác nhận sự kiện 'storage' và mở lại đúng màn hình;
   * (2) gặp 403 "không có quyền" thì hỏi lại /api/me: nếu tài khoản đã khác tài khoản đang hiển thị → báo và mở lại.
   */
  function noteAuth() { store.set('arl.auth', String(Date.now())); }
  ARL.noteAuth = noteAuth;
  let whoAt = 0;
  async function checkWho() {
    const me = ARL.me && ARL.me.user;
    if (!me || ARL.boToken || Date.now() - whoAt < 3000) return;
    whoAt = Date.now();
    let m;
    try { m = await backend.api('GET', '/api/me'); } catch { return; }
    if (!m.user) return ARL.onUnauth();
    if (m.user.id !== me.id) { toast(`Trình duyệt này đang đăng nhập bằng tài khoản ${m.user.name} (${m.user.username}), không phải ${me.name}. Đang mở lại màn hình cho tài khoản đó…`, true); ARL.reboot(); }
  }
  /** Gọi API. Lỗi 401 → về đăng nhập; bị chặn vì chưa đổi mật khẩu / chưa đồng ý → nạp lại luồng khởi động; 403 "không có quyền" → kiểm tra có phải tab đang chạy bằng phiên của tài khoản khác. */
  async function api(method, path, body, query) {
    try { return await backend.api(method, path, body, query); } catch (e) {
      if (e.status === 401 && path !== '/api/login') ARL.onUnauth();
      else if (e.code === 'consent_required' || e.code === 'password_change_required') ARL.reboot();
      else if (e.status === 403 && e.code === 'forbidden') checkWho();
      throw e;
    }
  }

  // ───────────── Hộp thoại ─────────────
  /** opts: { title, body: Node|chuỗi HTML, actions: [{ label, cls, run() }], wide, cls }. run() trả về false để giữ hộp thoại mở. */
  function modal(opts) {
    const d = el(`<dialog class="dlg ${opts.wide ? 'wide' : ''} ${opts.cls || ''}"><div class="dlg-head"><h2></h2><button type="button" class="ghost x" aria-label="Đóng">Đóng</button></div><div class="dlg-body"></div><p class="err dlg-err" hidden></p><div class="dlg-foot"></div></dialog>`);
    $('h2', d).textContent = opts.title || '';
    const body = $('.dlg-body', d), foot = $('.dlg-foot', d), err = $('.dlg-err', d);
    if (typeof opts.body === 'string') body.innerHTML = opts.body; else if (opts.body) body.append(opts.body);
    let closed = false;
    const close = () => { if (closed) return; closed = true; const t = $('#toast', d); if (t) topLayerHost(d).append(t); try { d.close(); } catch { /* chưa mở */ } d.remove(); if (opts.onClose) opts.onClose(); };
    const setErr = (m) => { err.hidden = !m; err.textContent = m || ''; };
    for (const a of opts.actions || []) {
      const b = el(`<button type="button" class="${a.cls || ''}"></button>`);
      b.textContent = a.label;
      b.addEventListener('click', async () => {
        if (b.disabled) return;
        setErr('');
        const btns = $$('button', foot);
        btns.forEach((x) => { x.disabled = true; });
        try { if ((await a.run({ close, setErr, body })) !== false) close(); } catch (e) { setErr(e.message || 'Có lỗi xảy ra. Thử lại.'); } finally { btns.forEach((x) => { x.disabled = false; }); }
      });
      foot.append(b);
    }
    if (!(opts.actions || []).length) foot.hidden = true;
    $('.x', d).addEventListener('click', close);
    d.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    document.body.append(d);
    d.showModal();
    return { el: d, body, close, setErr };
  }
  /** Hỏi xác nhận (không dùng window.confirm vì một số khung nhúng chặn). Trả về Promise<boolean>. */
  function ask(message, okLabel = 'Đồng ý', danger = false) {
    return new Promise((resolve) => {
      let done = false;
      const p = document.createElement('p');
      p.textContent = message;
      modal({ title: 'Xác nhận', body: p, cls: 'small', onClose: () => { if (!done) resolve(false); }, actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, { label: okLabel, cls: danger ? 'primary danger-bg' : 'primary', run: () => { done = true; resolve(true); } }] });
    });
  }
  async function copyText(txt, okMsg = 'Đã sao chép') {
    try { await navigator.clipboard.writeText(txt); toast(okMsg); } catch { toast('Không sao chép tự động được. Hãy bôi đen và sao chép tay.', true); }
  }

  // ───────────── Ảnh ─────────────
  function loadImg(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Không đọc được ảnh này. Chụp lại bằng camera của máy.')); };
      img.src = url;
    });
  }
  /** Thu nhỏ ảnh chụp (cạnh dài ≤ 1600 px, JPEG) để gửi nhanh trên 4G. Trả về data URL. */
  async function compressImage(file) {
    if (!file || !/^image\//.test(file.type || 'image/')) throw new Error('Tệp được chọn không phải là ảnh.');
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { src = await loadImg(file); }
    const w0 = src.width, h0 = src.height;
    if (!w0 || !h0) throw new Error('Không đọc được ảnh này. Chụp lại bằng camera của máy.');
    let max = 1600, q = 0.72, out = '';
    for (let i = 0; i < 4; i++) {
      const k = Math.min(1, max / Math.max(w0, h0));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      out = c.toDataURL('image/jpeg', q);
      if (out.length < 2600000) break; // ~1,9 MB sau khi giải mã
      max = Math.round(max * 0.75); q -= 0.1;
    }
    if (src.close) src.close();
    if (!out.startsWith('data:image/jpeg;base64,')) throw new Error('Trình duyệt này không nén được ảnh. Thử bằng Chrome hoặc Safari.');
    return out;
  }
  /** Ô chọn ảnh: nút chụp + dãy ảnh nhỏ có nút xoá. Trả về { el, photos (mảng data URL), busy }. */
  function photoPicker(max, label = 'Chụp ảnh') {
    const box = el(`<div class="pp"><div class="pp-list"></div><label class="btn pp-add"><input type="file" accept="image/*" capture="environment" hidden><span></span></label><p class="sub pp-hint"></p></div>`);
    const list = $('.pp-list', box), input = $('input', box), add = $('.pp-add', box), hint = $('.pp-hint', box);
    const state = { el: box, photos: [], busy: false, onChange: null };
    const paint = () => {
      list.innerHTML = '';
      state.photos.forEach((p, i) => {
        const it = el(`<div class="pp-item"><img alt="Ảnh ${i + 1}"><button type="button" aria-label="Xoá ảnh ${i + 1}">×</button></div>`);
        $('img', it).src = p;
        $('button', it).addEventListener('click', () => { state.photos.splice(i, 1); paint(); });
        list.append(it);
      });
      $('span', add).textContent = state.busy ? 'Đang xử lý ảnh…' : state.photos.length ? 'Chụp thêm' : label;
      add.hidden = state.photos.length >= max;
      hint.textContent = `${state.photos.length}/${max} ảnh`;
      if (state.onChange) state.onChange();
    };
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      input.value = '';
      if (!f || state.busy || state.photos.length >= max) return;
      state.busy = true; paint();
      try { state.photos.push(await compressImage(f)); } catch (e) { toast(e.message, true); }
      state.busy = false; paint();
    });
    paint();
    return state;
  }
  /** Dãy ảnh nhỏ (đã lưu trên máy chủ), bấm để xem lớn. photos: [{id, by, ts}] */
  function thumbs(photos) {
    const box = el('<div class="thumbs"></div>');
    photos.forEach((p, i) => {
      const b = el(`<button type="button" class="thumb" title="${p.by === 'bo' ? 'BO chụp' : 'FO chụp'} lúc ${esc(fmtHM(p.ts))}"><img alt="Ảnh ${p.by === 'bo' ? 'BO' : 'FO'} chụp" loading="lazy"><i>${p.by === 'bo' ? 'BO' : 'FO'}</i></button>`);
      $('img', b).src = (ARL.photoVia ? ARL.photoVia(p.id) : backend.photoUrl(p.id));
      b.addEventListener('click', () => viewPhotos(photos, i));
      box.append(b);
    });
    return box;
  }
  function viewPhotos(photos, i) {
    const body = el('<div class="pv"><img alt="Ảnh giao nhận"><p class="sub"></p><div class="pv-nav"><button type="button" class="prev">‹ Trước</button><span></span><button type="button" class="next">Sau ›</button></div></div>');
    const show = () => {
      const p = photos[i];
      $('img', body).src = (ARL.photoVia ? ARL.photoVia(p.id) : backend.photoUrl(p.id));
      $('p', body).textContent = `${p.by === 'bo' ? 'BO' : 'FO'} chụp lúc ${fmtDT(p.ts)}${p.lat ? ` · toạ độ ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : ''}`;
      $('span', body).textContent = `${i + 1}/${photos.length}`;
      $('.pv-nav', body).hidden = photos.length < 2;
    };
    $('.prev', body).addEventListener('click', () => { i = (i - 1 + photos.length) % photos.length; show(); });
    $('.next', body).addEventListener('click', () => { i = (i + 1) % photos.length; show(); });
    show();
    modal({ title: 'Ảnh giao nhận', body, wide: true });
  }

  // ───────────── Bản đồ nền ─────────────
  const HCMC = [10.7769, 106.7009];
  const GOOGLE_ROADS = 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}';
  const GOOGLE_HYBRID = 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}';
  // Logo Google Maps chính thức (bộ Google_Maps_Attribution_Assets của Google): viền sáng trên nền đường phố, viền tối trên ảnh vệ tinh.
  const GM_LOGO = { roadmap: 'vendor/images/GoogleMaps_Logo_WithLightOutline', satellite: 'vendor/images/GoogleMaps_Logo_WithDarkOutline' };
  const gmLive = new Set(); // bản đồ đang dùng nền Google chính thức: phiên Map Tiles đổi thì đổi URL lớp nền (syncTiles)

  /**
   * Nền Google chính thức (Map Tiles API, cfg.mapTiles): chỉ lớp "Google Maps" và "Google Vệ tinh"; logo Google Maps ở góc dưới trái,
   * dòng bản quyền theo khung nhìn lấy từ máy chủ (map-attribution), chờ 400 ms sau mỗi lần kéo / thu phóng / đổi lớp.
   */
  function googleTiles(map, mt) {
    // Trang gửi Referrer-Policy: no-referrer, còn khoá Map Tiles chỉ nhận yêu cầu từ tên miền của mình → ảnh nền phải gửi kèm nguồn.
    const o = { maxZoom: mt.maxZoom || 22, referrerPolicy: 'strict-origin-when-cross-origin', attribution: '' };
    const road = L.tileLayer(mt.roadmap, o).addTo(map), sat = mt.satellite ? L.tileLayer(mt.satellite, o) : null;
    if (sat) L.control.layers({ 'Google Maps': road, 'Google Vệ tinh': sat }, null, { position: 'topright' }).addTo(map);
    const g = { road, sat }, last = {};
    let img = null, layer = 'roadmap', shown = '', timer = null, seq = 0;
    gmLive.add(g);
    map.getContainer().classList.add('gm-tiles');
    const paintLogo = () => { if (img) { img.src = `${GM_LOGO[layer]}_1x.png`; img.srcset = `${GM_LOGO[layer]}_1x.png 1x, ${GM_LOGO[layer]}_2x.png 2x`; } };
    const logo = L.control({ position: 'bottomleft' });
    logo.onAdd = () => { const d = L.DomUtil.create('div', 'gm-logo'); img = L.DomUtil.create('img', '', d); img.alt = 'Google Maps'; img.width = 105; img.height = 22; paintLogo(); return d; };
    logo.addTo(map);
    const setCopy = (s) => { if (s === shown) return; if (shown) map.attributionControl.removeAttribution(esc(shown)); shown = s; if (s) map.attributionControl.addAttribution(esc(s)); };
    async function load() {
      const my = ++seq, sz = map.getSize();
      if (!sz.x || !sz.y) return;
      const b = map.wrapLatLngBounds(map.getBounds()), cut = (v, m) => Math.max(-m, Math.min(m, v)).toFixed(5);
      const q = new URLSearchParams({ layer, z: Math.max(0, Math.min(22, Math.round(map.getZoom()))), n: cut(b.getNorth(), 85), s: cut(b.getSouth(), 85), e: cut(b.getEast(), 180), w: cut(b.getWest(), 180) });
      let c = '';
      try { const r = await fetch(`${mt.attribution || 'map-attribution'}?${q}`, { credentials: 'same-origin' }); if (r.ok) c = String((await r.json()).copyright || ''); } catch { /* mất mạng: giữ dòng cũ */ }
      if (my !== seq || !gmLive.has(g)) return;
      if (c) last[layer] = c; // máy chủ lỗi trả chuỗi rỗng: giữ dòng đã có của lớp này
      setCopy(last[layer] || '');
    }
    const later = () => { clearTimeout(timer); timer = setTimeout(load, 400); };
    map.on('moveend zoomend', later);
    map.on('baselayerchange', (e) => { layer = e.layer === sat ? 'satellite' : 'roadmap'; paintLogo(); setCopy(last[layer] || ''); later(); });
    map.on('unload', () => { clearTimeout(timer); seq++; gmLive.delete(g); });
    later();
  }
  /** Máy chủ gửi cấu hình mới (phiên Map Tiles được làm mới): đổi URL lớp nền của các bản đồ đang mở. */
  function syncTiles() {
    const mt = (ARL.cfg || {}).mapTiles;
    if (!mt || !mt.roadmap) return;
    for (const g of gmLive) {
      if (g.road._url !== mt.roadmap) g.road.setUrl(mt.roadmap);
      if (g.sat && mt.satellite && g.sat._url !== mt.satellite) g.sat.setUrl(mt.satellite);
    }
  }

  /**
   * Tạo bản đồ Leaflet với nền Google Maps và các lớp chuyển đổi. Máy chủ có cfg.mapTiles: nền Google chính thức kèm logo và bản quyền.
   * Đường đi lấy từ Google (cfg.routingProvider = 'google') chỉ được vẽ trên nền Google: khi đó bỏ lựa chọn OpenStreetMap.
   */
  function baseMap(node, opt = {}) {
    const map = L.map(node, { zoomControl: false, zoomSnap: 0.5, worldCopyJump: true, attributionControl: true, ...opt }).setView(HCMC, 12);
    map.attributionControl.setPrefix(false);
    node.classList.remove('schematic');
    const cfg = ARL.cfg || {};
    if (cfg.mapTiles && cfg.mapTiles.roadmap) { googleTiles(map, cfg.mapTiles); return map; }
    const gOnly = cfg.routingProvider === 'google';
    const primaryUrl = cfg.tileUrl && (!gOnly || cfg.tileUrl.includes('google.com')) ? cfg.tileUrl : GOOGLE_ROADS;
    const isGoogle = primaryUrl.includes('google.com');
    const subdomains = isGoogle ? ['mt0', 'mt1', 'mt2', 'mt3'] : ['a', 'b', 'c'];
    const maxZoom = isGoogle ? 20 : 19;
    const baseLayer = L.tileLayer(primaryUrl, { maxZoom, subdomains, attribution: esc(cfg.tileAttribution || (isGoogle ? '© Google Maps' : '© OpenStreetMap contributors')) }).addTo(map);

    try {
      const gRoads = isGoogle && primaryUrl === GOOGLE_ROADS ? baseLayer : L.tileLayer(GOOGLE_ROADS, { maxZoom: 20, subdomains: ['mt0', 'mt1', 'mt2', 'mt3'], attribution: '© Google Maps' });
      const gHybrid = L.tileLayer(GOOGLE_HYBRID, { maxZoom: 20, subdomains: ['mt0', 'mt1', 'mt2', 'mt3'], attribution: '© Google Maps (Vệ tinh)' });
      const layers = { 'Google Maps': gRoads, 'Google Vệ tinh': gHybrid };
      L.control.layers(layers, null, { position: 'topright' }).addTo(map);
    } catch { /* Bỏ qua nếu có lỗi khởi tạo lớp phụ */ }

    return map;
  }
  /** Gỡ bản đồ an toàn: Leaflet có thể ném lỗi nếu bị gỡ giữa lúc đang chạy hiệu ứng thu phóng. */
  function killMap(map) {
    if (!map) return;
    try { map.stop(); } catch { /* chưa dựng xong */ }
    map._animatingZoom = false;
    try { map.remove(); } catch { /* đã gỡ */ }
  }
  const pinIcon = (label, cls = '') => L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: `<div class="pin ${cls}">${esc(label)}</div>` });
  const siteIcon = (name, type) => L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="lm" data-type="${esc(type)}">${esc(name)}</div>` });
  /** Link mở Google Maps chỉ đường tới 1 toạ độ, chế độ xe máy (Google Maps có hỗ trợ ở Việt Nam). */
  const gmapsDir = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=two-wheeler`;
  const gmapsAt = (lat, lon) => `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;

  // ───────────── Đường đi thực tế (máy chủ lấy từ Google / OSRM; trình duyệt chỉ vẽ) ─────────────
  // Màu cố định theo nền bản đồ (nền luôn sáng, kể cả khi giao diện tối): nét chính xanh, đoạn chậm cam, đoạn kẹt đỏ, chặng đã đi xám.
  const RT = { line: '#1A73E8', slow: '#FB8C00', jam: '#D93025', done: '#7B8597', est: '#1A73E8' };
  const BETA_WARN = 'Đường xe máy của Google đang thử nghiệm (beta): vài đoạn có thể chưa sát thực tế.'; // giống lib/routing.js
  const RT_SRC = { google: 'Google Maps', osrm: 'OSRM' };
  const RT_MODE = { TWO_WHEELER: 'xe máy', DRIVE: 'ô tô', driving: 'ô tô', car: 'ô tô' };
  const vnNum = (n) => String(n).replace('.', ',');
  /** Giải mã "encoded polyline" (độ chính xác 5) → [[vĩ độ, kinh độ], ...]; chuỗi hỏng hoặc không phải chuỗi: giữ phần đọc được trước chỗ hỏng. */
  function decodePolyline(str, precision = 5) {
    const out = [], f = 10 ** precision;
    if (typeof str !== 'string') return out;
    let i = 0, lat = 0, lon = 0;
    const next = () => {
      let res = 0, shift = 0, b;
      do {
        b = i < str.length ? str.charCodeAt(i++) - 63 : -1;
        if (b < 0 || b > 63 || shift > 30) return null;
        res += (b & 31) * 2 ** shift; shift += 5;
      } while (b >= 32);
      return res % 2 ? -(res + 1) / 2 : res / 2;
    };
    while (i < str.length) {
      const dLat = next(), dLon = dLat === null ? null : next();
      if (dLat === null || dLon === null || Math.abs((lat + dLat) / f) > 90 || Math.abs((lon + dLon) / f) > 180) break;
      lat += dLat; lon += dLon;
      out.push([+(lat / f).toFixed(precision), +(lon / f).toFixed(precision)]);
    }
    return out;
  }
  /** Mã hoá [[lat, lon], ...] → polyline (precision 5). */
  function encodePolyline(points, precision = 5) {
    const f = 10 ** precision;
    let out = '', pLat = 0, pLon = 0;
    const enc = (v) => { let x = v < 0 ? ~(v << 1) : v << 1, s = ''; while (x >= 32) { s += String.fromCharCode((32 | (x & 31)) + 63); x >>= 5; } return s + String.fromCharCode(x + 63); };
    for (const [a, b] of points || []) { const lat = Math.round(a * f), lon = Math.round(b * f); out += enc(lat - pLat) + enc(lon - pLon); pLat = lat; pLon = lon; }
    return out;
  }
  const _osrmCache = new Map();
  /** Lấy tuyến đường thực tế qua OSRM phía trình duyệt (fallback khi máy chủ chưa có tuyến). */
  async function fetchOsrmRoute(pts) {
    const coords = (pts || []).map(llOf).filter(Boolean);
    if (coords.length < 2) return null;
    const key = coords.map((c) => `${c[1].toFixed(5)},${c[0].toFixed(5)}`).join(';');
    if (_osrmCache.has(key)) return _osrmCache.get(key);
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${key}?overview=false&steps=true&geometries=polyline&annotations=false`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const j = await res.json();
      if (j.code !== 'Ok' || !j.routes || !j.routes[0]) return null;
      const r = j.routes[0];
      const legs = (r.legs || []).map((l) => {
        const stepPts = [];
        for (const s of (l.steps || [])) {
          if (s && s.geometry) {
            const sp = decodePolyline(s.geometry);
            for (const p of sp) {
              const q = stepPts[stepPts.length - 1];
              if (!q || q[0] !== p[0] || q[1] !== p[1]) stepPts.push(p);
            }
          }
        }
        return {
          distance_m: Math.max(0, Math.round(+l.distance || 0)),
          duration_s: Math.max(0, Math.round(+l.duration || 0)),
          polyline: stepPts.length > 1 ? encodePolyline(stepPts) : '',
          jams: [],
        };
      });
      const route = {
        provider: 'osrm',
        mode: 'driving',
        traffic: false,
        distance_m: Math.round(r.distance),
        duration_s: Math.round(r.duration),
        legs,
      };
      _osrmCache.set(key, route);
      return route;
    } catch {
      return null;
    }
  }
  const llOf = (p) => { const a = Array.isArray(p) ? p : p ? [p.lat, p.lon ?? p.lng] : []; return a[0] !== null && a[1] !== null && Number.isFinite(+a[0]) && Number.isFinite(+a[1]) ? [+a[0], +a[1]] : null; };
  /** Đường / task / kết quả /api/plan có tính giao thông (thời gian đi đã gồm kẹt xe) không. */
  const hasTraffic = (x) => !!x && (x.traffic === true || x.route_traffic === 1 || x.route_traffic === true || (!!x.route && x.route.traffic === true));
  /**
   * Vẽ đường đi lên group (L.layerGroup) chuẩn như Google Maps chỉ đường.
   * Tuyến đường hiển thị nét liền nổi bật với viền trắng tròn góc sắc nét.
   * Khi xem trước / thêm tuyến đường hoặc task chưa chạy: vẽ toàn bộ chặng bằng nét liền Google Maps.
   * Task đang chạy: chặng đang đi nét liền phủ màu giao thông (xanh/cam/đỏ), chặng kế tiếp nét liền mềm, chặng đã đi ẩn.
   * Chưa có dữ liệu tuyến đường: vẽ tạm nét đứt và tự động nạp đường thực tế từ OSRM để bám sát mặt đường.
   */
  function drawRoute(group, route, opt = {}) {
    const b = L.latLngBounds([]), pts = (opt.points || []).map(llOf).filter(Boolean), base = { interactive: false };
    if (opt.pane) base.pane = opt.pane;
    const line = (ll, o) => { for (const p of ll) b.extend(p); return L.polyline(ll, { ...base, ...o }).addTo(group); };
    for (const p of pts) b.extend(p);
    const legs = route && Array.isArray(route.legs) ? route.legs : [];
    const done = Math.max(0, Math.floor(+opt.doneLegs || 0)), act = Number.isInteger(opt.activeLeg) ? opt.activeLeg : -1, main = opt.color || RT.line;
    const allSolid = !!opt.allSolid || (act === -1 && done === 0);

    if (!legs.length) {
      if (pts.length > 1) {
        const placeholder = line(pts, { color: RT.est, weight: 3, opacity: 0.65, dashArray: '6 8' });
        if (opt.autoFetch !== false) {
          fetchOsrmRoute(pts).then((r) => {
            if (r && group) {
              try { group.removeLayer(placeholder); } catch {}
              drawRoute(group, r, { ...opt, autoFetch: false });
              if (typeof opt.onRoute === 'function') opt.onRoute(r);
            }
          });
        }
      }
      return b;
    }

    const rank = (i) => (i < done ? 0 : (allSolid || i === act) ? 2 : 1);
    legs.map((_, i) => i).sort((x, y) => rank(x) - rank(y) || x - y).forEach((i) => {
      const leg = legs[i] || {}, path = decodePolyline(leg.polyline);
      if (i < done) return; // chặng đã đi xong: không vẽ nữa
      if (path.length < 2) {
        const a = pts[i], z = pts[i + 1];
        if (a && z && (a[0] !== z[0] || a[1] !== z[1])) line([a, z], { color: RT.est, weight: 3, opacity: 0.65, dashArray: '6 8' });
        return;
      }
      if (allSolid || i === act) {
        // Tuyến chỉ đường như Google Maps: viền trắng dày bo tròn góc + vệt xanh chỉ đường sắc nét
        line(path, { color: '#ffffff', weight: 8, opacity: 0.95, lineCap: 'round', lineJoin: 'round' });
        line(path, { color: main, weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round' });
        for (const j of Array.isArray(leg.jams) ? leg.jams : []) {
          if (!Array.isArray(j) || (j[2] !== 1 && j[2] !== 2)) continue;
          const seg = path.slice(Math.max(0, Math.floor(+j[0] || 0)), Math.max(0, Math.floor(+j[1] || 0)) + 1);
          if (seg.length > 1) line(seg, { color: j[2] === 2 ? RT.jam : RT.slow, weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round' });
        }
      } else {
        // Chặng sắp đi tới: đường nét liền mềm với viền
        line(path, { color: '#ffffff', weight: 7, opacity: 0.85, lineCap: 'round', lineJoin: 'round' });
        line(path, { color: main, weight: 4.5, opacity: 0.85, lineCap: 'round', lineJoin: 'round' });
      }
    });
    return b;
  }
  /** Tiến độ theo chặng để truyền cho drawRoute (chặng i: điểm i → i + 1): task đang chạy → { doneLegs, activeLeg }; đã kết thúc → mọi chặng đã đi; chưa chạy → {}. */
  function routeLegs(t) {
    const stops = (t && t.stops) || [];
    if (!t || !isOpen(t)) return { doneLegs: stops.length };
    if (t.status !== 'in_progress') return {};
    const j = stops.findIndex((s) => s.status === 'pending' || s.status === 'arrived');
    if (j < 0) return { doneLegs: stops.length };
    // Chặng i nối điểm i → điểm i + 1. Đã tới điểm j (đang giao nhận): các chặng trước đó đã đi xong, chặng j là chặng sắp đi tiếp.
    if (stops[j].status === 'arrived') return { doneLegs: j, activeLeg: j };
    // Đang chạy tới điểm j: chặng đang đi là chặng j − 1 (chưa tới điểm đầu tiên thì chưa có chặng nào đang đi).
    return { doneLegs: Math.max(0, j - 1), activeLeg: j - 1 };
  }
  /** Chú thích màu đường (Thông thoáng / Chậm / Kẹt xe). Truyền route / task / kết quả /api/plan: không có số liệu giao thông → null. */
  function routeLegend(x) {
    if (x !== undefined && !hasTraffic(x)) return null;
    return el('<p class="rt-legend"><span class="lg-ok">Thông thoáng</span><span class="lg-slow">Chậm</span><span class="lg-jam">Kẹt xe</span></p>');
  }
  /**
   * SLA giải thích trong một dòng: "Di chuyển 38 phút (kẹt xe +7) · dừng 3 điểm 21 phút · dự phòng 14 phút → SLA 75 phút" (hệ số > 1: "→ 75 phút × thời tiết 1,2 = SLA 90 phút").
   * x: task hoặc kết quả /api/plan; nStops: số điểm phải dừng (không tính chặng quay về) khi x không có stops. Chưa có đường thực tế: "Ước tính theo đường chim bay: …".
   */
  function slaBreakdown(x, nStops) {
    if (!x) return '';
    const n = nStops ?? (Array.isArray(x.stops) ? x.stops.filter((s) => !s.is_return).length : null);
    const src = x.route_src !== undefined ? x.route_src : x.src, routed = !!src && src !== 'estimate' && Number.isFinite(x.travel_min);
    const sla = (ARL.cfg && ARL.cfg.sla) || null, ok = (v) => Number.isFinite(v);
    let travel = x.travel_min, svc = x.service_min, buf = x.buffer_min;
    if (!routed) { // đường chim bay: dựng lại từng phần như máy chủ (quãng đường × hệ số đường / tốc độ, dừng mỗi điểm, dự phòng)
      travel = sla && ok(x.plan_km) && sla.speedKmh ? Math.round((x.plan_km / sla.speedKmh) * 60) : null;
      svc = sla && ok(n) ? n * sla.stopMin : null;
      buf = sla ? sla.bufferMin : null;
    }
    const parts = [];
    if (ok(travel)) parts.push(`di chuyển ${travel} phút${routed && x.traffic_min > 0 ? ` (kẹt xe +${x.traffic_min})` : ''}`);
    if (ok(svc)) parts.push(`dừng ${n ? `${n} điểm ` : ''}${svc} phút`);
    if (ok(buf)) parts.push(`dự phòng ${buf} phút`);
    const f = +x.factor || 1, base = x.base_min;
    let tail = '';
    if (ok(base)) {
      const prod = Math.round(base * f), eff = ok(x.due_at) && ok(x.start_at) ? Math.round((x.due_at - x.start_at) / 60000) : ok(x.sla_min) ? x.sla_min : prod;
      tail = f > 1 ? `→ ${base} phút × ${hasTraffic(x) ? 'thời tiết' : 'điều kiện'} ${vnNum(f)} = SLA ${prod} phút` : `→ SLA ${base} phút`;
      if (eff !== prod) tail += ` (hạn đã nới thành ${eff} phút)`;
    }
    const body = [parts.join(' · '), tail].filter(Boolean).join(' ');
    if (!body) return '';
    return routed ? body.charAt(0).toUpperCase() + body.slice(1) : `Ước tính theo đường chim bay${parts.length ? ':' : ''} ${body}`;
  }
  /** Cảnh báo phải hiện kèm đường đi (Google bắt buộc hiện cảnh báo beta của đường xe máy). x: route, kết quả /api/plan hoặc task; không có → ''. */
  function routeNote(x) {
    if (!x) return '';
    const r = x.route && typeof x.route === 'object' ? x.route : x;
    const w = (Array.isArray(r.warnings) ? r.warnings : []).filter((s) => typeof s === 'string' && s);
    if (!w.length && x.route_src === 'google' && x.route_mode === 'TWO_WHEELER') w.push(BETA_WARN);
    return [...new Set(w)].join(' ');
  }
  /**
   * Dòng nguồn của đường đi. Task: "Đường thực tế 12,3 km · Google Maps, xe máy, tính cả kẹt xe · cập nhật 08:15";
   * route / kết quả /api/plan: "… · giao thông lúc 08:15" (khi có giao thông). Chưa có đường thực tế → ''.
   */
  function routeText(x) {
    if (!x) return '';
    const r = x.route && typeof x.route === 'object' ? x.route : x, isTask = x.code !== undefined || Array.isArray(x.stops);
    const src = isTask ? x.route_src : r.provider || x.src;
    if (!src || src === 'estimate') return '';
    const km = !isTask && Number.isFinite(r.distance_m) ? r.distance_m / 1000 : x.plan_km;
    const what = [RT_SRC[src] || src, RT_MODE[isTask ? x.route_mode : r.mode], hasTraffic(x) ? 'tính cả kẹt xe' : ''].filter(Boolean).join(', ');
    const at = isTask ? x.route_at : hasTraffic(x) ? r.depart_at : null, hm = (ts) => (dateOf(ts) === today() ? fmtHM(ts) : fmtDT(ts));
    return [`Đường thực tế ${fmtKm(km)}`, what, at ? `${isTask ? 'cập nhật' : 'giao thông lúc'} ${hm(at)}` : ''].filter(Boolean).join(' · ');
  }
  const routeMemo = new Map();
  /** Đường đi thực tế của task (GET /api/tasks/:id/route → { route, stale }), nhớ theo id + route_at; route_at trống → { route: null } không gọi máy chủ. */
  function taskRoute(id, routeAt) {
    if (!id || !routeAt) return Promise.resolve({ route: null, stale: false });
    const k = `${id}|${routeAt}`;
    let p = routeMemo.get(k);
    if (p) return p;
    for (const old of [...routeMemo.keys()]) if (old.startsWith(`${id}|`) || routeMemo.size > 40) routeMemo.delete(old); // bản cũ của task này, hoặc quá nhiều
    p = api('GET', `/api/tasks/${id}/route`).then((j) => ({ route: j.route || null, stale: !!j.stale }));
    routeMemo.set(k, p);
    p.catch(() => { if (routeMemo.get(k) === p) routeMemo.delete(k); }); // lỗi: lần sau tải lại
    return p;
  }
  /** Đọc toạ độ từ chuỗi dán vào: "10.77, 106.70" hoặc link Google Maps. */
  function parseCoord(s) {
    s = String(s || '');
    const pats = [/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /@(-?\d+\.\d+),(-?\d+\.\d+)/, /[?&](?:q|query|ll|destination)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i, /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/];
    for (const re of pats) {
      const m = re.exec(s);
      if (m) { const lat = +m[1], lon = +m[2]; if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) return { lat: +lat.toFixed(6), lon: +lon.toFixed(6) }; }
    }
    return null;
  }
  /** Khoá gửi cho một lần mở hộp thoại: bấm gửi lại (mất mạng, hai tab) thì máy chủ trả kết quả cũ, không ghi thêm. */
  function reqKey() {
    const b = new Uint8Array(12);
    (window.crypto || {}).getRandomValues ? window.crypto.getRandomValues(b) : b.forEach((_, i) => { b[i] = Math.floor(Math.random() * 256); });
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  Object.assign(ARL, {
    $, $$, el, esc, toast, store, distM, now, fmtHM, fmtDate, fmtDT, fmtKm, dateOf, today, dayStart, addDays, kmh, ago, span, nameParts, safeColor, telHref, pad2,
    ROLE_LABEL, TASK_ST, STOP_ST, BO_ST, WEATHER, TRAFFIC, ISSUES, isOpen, slaOf, countsText, progressOf,
    backend, api, modal, ask, copyText, compressImage, photoPicker, thumbs, viewPhotos, baseMap, killMap, pinIcon, siteIcon, gmapsDir, gmapsAt, parseCoord, HCMC, reqKey,
    syncTiles, decodePolyline, encodePolyline, fetchOsrmRoute, drawRoute, routeLegs, hasTraffic, routeLegend, slaBreakdown, routeNote, routeText, taskRoute,
  });
  if (typeof ARL.syncCommonLabels === 'function') ARL.syncCommonLabels(ARL.lang);
})();
