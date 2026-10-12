/* Ops Hub — BO (#/outlets) và Yêu cầu của Sale (#/requests).
   BO: danh sách theo trạng thái, giờ quay tuần này so tuần trước, quota, chuẩn giờ quay; trang chi tiết có tab
   (Tổng quan, Kit & thẻ, Yêu cầu, Sự cố, Thông tin) và các thao tác theo vai: sửa, hỗ trợ, báo sự cố, kết thúc ghi hình.
   Yêu cầu: Sale gửi yêu cầu mở BO và thấy rõ yêu cầu đang ở bước nào, đang chờ ai; Logistics gán kit, gửi Tech kiểm, sửa, huỷ.
   Màn hình này không gọi API nào của Rider Live: Sale không thấy vị trí, chuyến hay tên FO. */
(() => {
  'use strict';
  const H = ARL.H, { h } = H;

  // ───────── Quyền: khớp danh sách vai của từng API (core/hub/outlets.js, incidents.js, stock.js) ─────────
  const CAN = {
    outCreate: ['admin', 'lead', 'logistic'], //                       POST /outlets
    outEdit: ['admin', 'lead', 'logistic', 'sale', 'sale_head'], //    PATCH /outlets/:id (Sale chỉ một số trường)
    outEnd: ['admin', 'lead', 'logistic', 'sale', 'sale_head'], //     POST /outlets/:id/end
    support: ['admin', 'lead', 'logistic', 'sale', 'sale_head', 'tech_lead', 'tech'], // POST /outlets/:id/support
    incident: ['admin', 'tech_lead', 'tech', 'lead', 'logistic', 'sale_head', 'sale'], // POST /incidents
    reqCreate: ['admin', 'lead', 'logistic', 'sale', 'sale_head'], //  POST /requests, PATCH, cancel (huỷ yêu cầu kết thúc: máy chủ báo can_cancel)
    reqAssign: ['admin', 'lead', 'logistic'], //                       POST /requests/:id/assign, unassign
    kitSubmit: ['admin', 'lead', 'logistic'], //                       POST /kits/:id/submit
    quota: ['admin', 'sale', 'sale_head'], //                          PATCH /outlets/:id quota_hours (Sale chốt; Logistics chỉ xem)
  };
  const SALE = ['sale', 'sale_head'];
  const REQ_EDITABLE = ['submitted', 'preparing', 'ready']; // máy chủ cho sửa / huỷ / gán kit ở các bước này
  const LAUNCH_OPEN = ['submitted', 'preparing', 'ready', 'delivering'];
  const REQ_ACTIVE = ['submitted', 'preparing', 'ready', 'delivering', 'scheduled', 'ending'];
  const REQ_WAITING = ['submitted', 'preparing']; // "Chờ chuẩn bị": đúng tập ô "Yêu cầu chờ chuẩn bị" ở Tổng quan đếm
  /** Ngày bắt đầu tạm nghỉ ở quá khứ chỉ các vai này ghi được, kèm lý do (khớp PATCH /outlets/:id). */
  const PAUSE_BACKDATE = ['admin', 'lead', 'sale_head'];
  const OUT_ORDER = { live: 0, paused: 1, ending: 2, planned: 3, ended: 4 };
  const DAYS = [[1, 'T2'], [2, 'T3'], [3, 'T4'], [4, 'T5'], [5, 'T6'], [6, 'T7'], [7, 'CN']];
  const QUOTA_ST = { ok: ['Trong quota', 'go'], near: ['Sắp chạm quota', 'wait'], over: ['Đã vượt quota', 'lost'] };

  const M = () => ARL.hubMeta || {};
  const CFG = () => M().cfg || {};
  const away = () => M().kit_outside || ['delivering', 'at_bo', 'recovering'];
  const kindName = (k) => H.label('kit_kinds', k);
  const mainEl = () => document.getElementById('h-main');
  const daysTo = (date) => (date ? Math.round((Date.parse(date) - Date.parse(H.today())) / 86400000) : null);
  function dayHint(date) {
    const d = daysTo(date);
    if (d === null) return '';
    if (d === 0) return 'hôm nay';
    if (d === 1) return 'ngày mai';
    if (d === -1) return 'hôm qua';
    return d > 0 ? `còn ${d} ngày` : `${-d} ngày trước`;
  }
  const daysText = (s) => { const set = String(s || '').split(',').filter(Boolean); return DAYS.filter(([k]) => set.includes(String(k))).map(([, l]) => l).join(', '); };
  const swapText = (o) => [daysText(o.swap_days), o.swap_from ? `${o.swap_from}–${o.swap_to || ''}` : ''].filter(Boolean).join(' · ');
  const tel = (p) => (p ? h('a', { href: 'tel:' + String(p).replace(/[^\d+]/g, '') }, p) : null);
  /** Link trong hub nếu vai này mở được màn hình đích, không thì chữ thường. */
  const linkOr = (ctx, link, label) => { const href = ctx.linkTo(link); return href ? H.link(href, label) : label; };
  const sum = (rows, f) => rows.reduce((a, r) => a + (+f(r) || 0), 0);
  /** So kỳ trước; cả hai kỳ đều 0 (BO chưa ghi hình) thì không hiện gì cho đỡ rối. */
  const deltaOr = (cur, prev, opt) => (!cur && !prev ? null : H.delta(cur, prev, opt));
  /** Giờ quay tuần này so cùng kỳ tuần trước: so trên các ngày thẻ đã nhập đủ (cmp_hours, do máy chủ tính), số hiển thị vẫn là tổng tới hôm nay. */
  const wkWord = (info) => (info && info.cmp && info.cmp.running ? 'cùng kỳ tuần trước' : info ? info.prev_label : 'tuần trước');
  const wkDelta = (info, cmp, prev, opt) => (info && info.cmp && info.cmp.data_to === null ? h('span.h-delta', h('em', 'chưa đủ ngày để so')) : deltaOr(cmp, prev, { label: wkWord(info), ...opt }));

  // ───────── Danh mục dùng chung (tải một lần) ─────────
  const TN = {}; // tên loại phụ kiện theo mã
  let typesP = null, labelsP = null;
  const accTypes = (ctx) => (typesP = typesP || ctx.api('GET', '/api/hub/types').then((j) => {
    const list = (j.types || []).filter((t) => t.kind === 'acc' && t.active !== 0);
    for (const t of j.types || []) TN[t.id] = t.name;
    return list;
  }).catch((e) => { typesP = null; throw e; }));
  const errLabels = (ctx) => (labelsP = labelsP || ctx.api('GET', '/api/hub/labels').then((j) => j.labels || {}).catch((e) => { labelsP = null; throw e; }));
  const labelsFor = (all, kind) => (kind && all[kind] ? all[kind] : [...new Set(Object.values(all).flat())]);

  const accText = (acc) => Object.entries(acc || {}).filter(([, q]) => q).map(([t, q]) => `${q} ${TN[t] || t}`).join(', ');
  function needText(n) {
    if (!n) return '';
    return [n.multicam ? `${n.multicam} ${kindName('multicam')}` : '', n.iphone ? `${n.iphone} ${kindName('iphone')}` : ''].filter(Boolean).join(' + ');
  }
  /** Yêu cầu đi theo vòng kit (gán, kiểm, giao): mở BO, hoặc hỗ trợ "Thêm kit" (khớp isKitReq ở core/hub/outlets.js). */
  const isKitReq = (r) => r.kind === 'launch' || (r.kind === 'support' && (r.need || {}).kind === 'add_kit');
  /** Nội dung yêu cầu, một dòng. */
  function reqWhat(r) {
    const n = r.need || {};
    if (r.kind === 'launch') return [needText(n), accText(n.acc), n.other].filter(Boolean).join(' · ');
    if (r.kind === 'support') return [H.label('support_kind', n.kind), n.kind === 'add_kit' ? needText(n) : accText(n.acc)].filter(Boolean).join(': ');
    return [n.end_date ? `Kết thúc từ ${H.dmy(n.end_date)}` : '', r.note].filter(Boolean).join(' · ') || 'Thu hồi toàn bộ kit và thẻ tại BO';
  }
  const kitsNeeded = (r) => (isKitReq(r) && r.need ? (r.need.multicam || 0) + (r.need.iphone || 0) : 0);

  /**
   * Yêu cầu đang chờ ai, nói bằng lời: { who, text, tone }. Máy chủ tính (reqBrief.waiting) để mọi màn hình nói cùng một câu;
   * không có thông tin chuyến hay FO.
   */
  const waitingOf = (r) => r.waiting || { who: '', tone: 'off', text: '' };

  // ───────── Biểu mẫu ─────────
  /** Hộp thoại biểu mẫu tự dựng (cần ẩn / hiện trường theo lựa chọn). onSubmit(form, ctl) → false để giữ hộp thoại. */
  function dlg(o) {
    return new Promise((resolve) => {
      const form = h('form.h-form', { novalidate: true, onsubmit: (e) => e.preventDefault() }, o.intro ? (o.intro instanceof Node ? o.intro : h('p.sub', o.intro)) : null, o.body);
      let result = null;
      const m = ARL.modal({
        title: o.title, body: form, wide: !!o.wide, cls: [o.xl ? 'h-xl' : '', o.cls || ''].join(' ').trim(), onClose: () => resolve(result),
        actions: [
          { label: o.cancel || 'Thôi', cls: 'ghost', run: () => {} },
          { label: o.submit || 'Lưu', cls: o.danger ? 'primary danger-bg' : 'primary', run: async (ctl) => { const r = await o.onSubmit(form, ctl); if (r === false) return false; result = r === undefined ? true : r; return true; } },
        ],
      });
      form.addEventListener('input', () => m.setErr(''));
      form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !['checkbox', 'radio'].includes(e.target.type)) { e.preventDefault(); [...m.el.querySelectorAll('.dlg-foot button')].pop().click(); } });
      const first = form.querySelector('input:not([type=hidden]):not([type=checkbox]):not([disabled]), select, textarea');
      // Đặt con trỏ ngay khi mở (không hẹn giờ, tránh giật con trỏ khi người dùng đã gõ); điện thoại thì không bật bàn phím sẵn.
      const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      if (first && !o.noFocus && !coarse) first.focus();
    });
  }
  const inp = (form, name) => form.querySelector(`[name="${name}"]`);
  const val = (form, name) => { const n = inp(form, name); return !n || n.disabled || n.closest('[hidden]') ? undefined : n.type === 'checkbox' ? n.checked : String(n.value).trim(); };
  /** Kiểm trường bắt buộc (bỏ qua trường đang ẩn). */
  function required(form, ctl, pairs) {
    for (const [name, label] of pairs) {
      const n = inp(form, name);
      if (!n || n.closest('[hidden]')) continue;
      if (!String(n.value).trim()) { ctl.setErr(`Cần nhập: ${label}.`); n.focus(); return false; }
    }
    return true;
  }
  const intOf = (v) => (v === undefined || v === '' ? 0 : parseInt(v, 10) || 0);
  /** Chọn ngày đổi thẻ trong tuần (T2…CN). .value() → [1, 3, 5]. */
  function dayPicker(value) {
    const set = new Set(String(value || '').split(',').filter(Boolean).map(Number));
    const box = h('div.outlets-days', { role: 'group', 'aria-label': 'Ngày đổi thẻ trong tuần' });
    for (const [k, l] of DAYS) {
      box.append(h('button', { type: 'button', 'aria-pressed': String(set.has(k)), 'aria-label': l === 'CN' ? 'Chủ nhật' : `Thứ ${k + 1}`, onclick: (e) => { if (set.has(k)) set.delete(k); else set.add(k); e.currentTarget.setAttribute('aria-pressed', String(set.has(k))); } }, l));
    }
    box.value = () => [...set].sort((a, b) => a - b);
    return box;
  }
  const fieldWrap = (label, node, hint, full = true) => h('div.h-field', { class: full ? 'h-full' : null }, h('span', label), node, hint ? h('small', hint) : null);
  /** Ô số lượng từng loại phụ kiện. */
  function accFields(types, cur = {}) {
    if (!types.length) return h('p.sub', 'Danh mục chưa có loại phụ kiện nào.');
    return h('div.outlets-acc', types.map((t) => h('label.outlets-acc-row', h('span', t.name),
      h('input', { type: 'number', min: 0, max: 99, step: 1, inputmode: 'numeric', name: 'acc:' + t.id, value: cur[t.id] || '', placeholder: '0', 'aria-label': `Số ${t.name}` }))));
  }
  function accValues(form) {
    const out = {};
    for (const n of form.querySelectorAll('input[name^="acc:"]')) { const q = parseInt(n.value, 10); if (q > 0) out[n.name.slice(4)] = q; }
    return out;
  }
  /** "10.77, 106.70" hoặc link Google Maps → { lat, lon }; trống → null; sai → false. */
  function coordOf(s) {
    if (s === undefined) return undefined;
    if (!s) return null;
    return ARL.parseCoord(s) || false;
  }
  const saleOptions = (sales) => sales.map((s) => [s.id, s.role === 'sale_head' ? `${s.name} (${H.label('roles', s.role)})` : s.name]);

  /**
   * Gửi yêu cầu mở BO (POST /api/hub/requests): BO mới (tạo luôn) hoặc BO có sẵn đang chờ launch / đã kết thúc.
   * opt: { site: BO cố định, outlets: danh sách BO để chọn, sales }. Trả về yêu cầu vừa tạo hoặc null.
   */
  async function requestForm(ctx, opt = {}) {
    const types = await accTypes(ctx);
    const sale = ctx.role === 'sale';
    const existing = opt.site ? [] : (opt.outlets || []).filter((o) => o.ops_status === 'planned' || o.ops_status === 'ended');
    let mode = opt.site ? 'site' : 'new';
    const sales = opt.sales || [];
    const newBox = h('div.h-fields',
      H.field({ name: 'name', label: 'Tên BO', required: true, placeholder: 'Ví dụ: Cửa hàng Hoa Mai Quận 3' }),
      H.field({ name: 'code', label: 'Mã BO', placeholder: 'Nếu đã có mã' }),
      H.field({ name: 'address', label: 'Địa chỉ', full: true }),
      H.field({ name: 'contact', label: 'Người liên hệ tại BO' }),
      H.field({ name: 'phone', label: 'Số điện thoại', type: 'tel' }),
      H.field({ name: 'business', label: 'Ngành hàng' }),
      H.field({ name: 'area', label: 'Khu vực' }),
      H.field({ name: 'coord', label: 'Vị trí trên bản đồ', full: true, placeholder: 'Dán link Google Maps hoặc toạ độ "10.77, 106.70"', hint: 'Logistics cần vị trí để xếp chuyến giao. Chưa có thì bổ sung sau.' }),
      !sale && sales.length ? H.field({ name: 'sale_id', label: 'Sale phụ trách', type: 'select', options: saleOptions(sales), empty: 'Chưa giao', hint: 'Có thể giao sau ở trang BO.' }) : null);
    const siteBox = h('div.h-fields', { hidden: mode !== 'site' || !!opt.site },
      existing.length ? H.field({ name: 'site_id', label: 'BO', type: 'select', required: true, full: true, empty: 'Chọn BO', options: existing.map((o) => [o.id, `${o.name}${o.code ? ' · ' + o.code : ''} (${H.label('outlet_st', o.ops_status)})`]) }) : null);
    newBox.hidden = mode !== 'new';
    const seg = !opt.site && existing.length ? H.seg([['new', 'BO mới'], ['site', 'BO đã có']], mode, (k) => { mode = k; newBox.hidden = k !== 'new'; siteBox.hidden = k !== 'site'; }) : null;
    const s0 = opt.site || {};
    const days = dayPicker(s0.swap_days);
    // Một khoá gửi cho lần mở hộp thoại này: bấm gửi lại sau khi mất mạng thì máy chủ trả yêu cầu đã tạo, không tạo thêm.
    const rk = ARL.reqKey();
    // BO mới trùng tên với BO đang chờ launch: hiện yêu cầu đã có; người gửi xác nhận là BO khác thì gửi lại kèm confirm_new.
    let confirmNew = false;
    const dupBox = h('div.h-note', { 'data-tone': 'wait', hidden: true });
    const resetDup = () => { confirmNew = false; dupBox.hidden = true; };
    for (const n of ['name', 'address']) { const x = newBox.querySelector(`[name="${n}"]`); if (x) x.addEventListener('input', resetDup); }
    const body = h('div.h-stack',
      opt.site ? H.note(`BO: ${s0.name}${s0.code ? ' · ' + s0.code : ''}`) : seg ? fieldWrap('Mở cho', seg) : null,
      newBox, dupBox, siteBox,
      h('h3.outlets-fh', 'Cần gì'),
      h('div.h-fields',
        H.field({ name: 'multicam', label: `Số ${kindName('multicam')}`, type: 'number', min: 0, max: 200, step: 1, value: 1 }),
        H.field({ name: 'iphone', label: `Số ${kindName('iphone')}`, type: 'number', min: 0, max: 200, step: 1, value: 0 }),
        H.field({ name: 'launch_date', label: 'Ngày launch', type: 'date', required: true, min: H.today(), hint: 'Ngày giao máy và setup tại BO.' }),
        H.field({ name: 'other', label: 'Thiết bị / yêu cầu khác', placeholder: 'Nếu có' })),
      types.length ? h('details.outlets-more', h('summary', 'Phụ kiện thêm (nếu cần)'), accFields(types)) : null,
      h('h3.outlets-fh', 'Lịch đổi thẻ'),
      h('div.h-fields',
        fieldWrap('Ngày đổi thẻ trong tuần', days, 'Logistics tự tạo việc đổi thẻ theo lịch này.'),
        H.field({ name: 'swap_from', label: 'Đổi thẻ từ', type: 'time', value: s0.swap_from || '' }),
        H.field({ name: 'swap_to', label: 'đến', type: 'time', value: s0.swap_to || '' }),
        H.field({ name: 'note', label: 'Ghi chú cho Logistics', type: 'textarea', rows: 2 })));
    return dlg({
      title: 'Gửi yêu cầu mở BO', wide: true, submit: 'Gửi yêu cầu',
      intro: 'Logistics nhận yêu cầu, chọn kit và gửi Tech kiểm. Bạn theo dõi từng bước ở mục Yêu cầu.',
      body,
      onSubmit: async (form, ctl) => {
        if (!required(form, ctl, mode === 'new' ? [['name', 'Tên BO']] : [['site_id', 'BO']])) return false;
        if (!required(form, ctl, [['launch_date', 'Ngày launch']])) return false;
        const multicam = intOf(val(form, 'multicam')), iphone = intOf(val(form, 'iphone'));
        if (multicam + iphone < 1) { ctl.setErr(`Cần ít nhất 1 ${kindName('multicam')} hoặc ${kindName('iphone')}.`); inp(form, 'multicam').focus(); return false; }
        const b = { need: { multicam, iphone, acc: accValues(form), other: val(form, 'other') || undefined }, launch_date: val(form, 'launch_date'), note: val(form, 'note') };
        const dv = days.value();
        if (dv.length || val(form, 'swap_from') || val(form, 'swap_to') || opt.site) Object.assign(b, { swap_days: dv, swap_from: val(form, 'swap_from'), swap_to: val(form, 'swap_to') });
        if (opt.site) b.site_id = opt.site.id;
        else if (mode === 'site') b.site_id = Number(val(form, 'site_id'));
        else {
          const c = coordOf(val(form, 'coord'));
          if (c === false) { ctl.setErr('Không đọc được vị trí. Dán link Google Maps hoặc toạ độ dạng "10.77, 106.70".'); inp(form, 'coord').focus(); return false; }
          b.outlet = { name: val(form, 'name'), code: val(form, 'code'), address: val(form, 'address'), contact: val(form, 'contact'), phone: val(form, 'phone'), business: val(form, 'business'), area: val(form, 'area') };
          if (c) Object.assign(b.outlet, c);
          const sid = val(form, 'sale_id');
          if (sid) b.outlet.sale_id = Number(sid);
        }
        b.req_key = rk;
        if (b.outlet && confirmNew) b.confirm_new = true;
        let j;
        try { j = await ctx.api('POST', '/api/hub/requests', b); } catch (e) {
          const d = e.data || {};
          if (e.code !== 'dup_request' || !d.request) throw e;
          // Mọi vai gửi được yêu cầu đều mở được mục Yêu cầu: đóng hộp thoại rồi mở thẳng yêu cầu đã có.
          const link = h('a', { href: `#/requests/${d.request.id}`, onclick: (ev) => { ev.preventDefault(); ctl.close(); ctx.go('requests', [d.request.id]); } }, `Mở yêu cầu ${d.request.code}`);
          if (d.confirm) {
            confirmNew = true;
            dupBox.replaceChildren(h('span', `${ARL.boLabel(d.site.name)} đang chờ launch ngày ${H.day(d.request.launch_date)} (yêu cầu ${d.request.code}). `), link, h('span', '. Nếu đây là một BO khác cùng tên, bấm "Gửi yêu cầu" lần nữa.'));
          } else dupBox.replaceChildren(h('span', `${e.message} `), link);
          dupBox.hidden = false;
          ctl.setErr(d.confirm ? 'BO này có vẻ đã được gửi yêu cầu.' : e.message);
          return false;
        }
        ARL.toast(j.replay ? `Yêu cầu ${j.request.code} đã được gửi trước đó.` : `Đã gửi yêu cầu ${j.request.code}. Logistics đã được báo.`);
        return j.request;
      },
    });
  }

  /**
   * Thêm BO (Logistics) hoặc sửa thông tin BO. Mỗi vai chỉ sửa trường mình sở hữu (khớp PATCH /outlets/:id):
   * Sale: quota, mã BO, ngành hàng (Head of Sale thêm khu vực, Sale phụ trách); Logistics: địa chỉ, toạ độ, liên hệ, lịch đổi thẻ.
   * Logistics thấy số của Sale ở dạng chỉ xem; mã BO chỉ điền khi BO chưa có mã.
   */
  function outletForm(ctx, o, sales) {
    const ops = ctx.can(CAN.outCreate), head = ctx.role === 'sale_head', logi = ctx.can(['lead', 'logistic']);
    const create = !o;
    o = o || {};
    const F = H.field;
    const days = dayPicker(o.swap_days);
    const saleOnly = logi && !create; // sửa BO: trường của Sale chỉ xem
    const codeLocked = logi && !create && !!o.code;
    const info = h('div.h-fields',
      ops ? F({ name: 'name', label: 'Tên BO', required: true, value: o.name }) : null,
      F({ name: 'code', label: 'Mã BO', value: o.code, disabled: codeLocked, hint: codeLocked ? 'BO đã có mã; đổi mã do Sale.' : null }),
      F({ name: 'address', label: 'Địa chỉ', value: o.address, full: true }),
      ops || head ? F({ name: 'area', label: 'Khu vực', value: o.area, disabled: saleOnly }) : null,
      F({ name: 'business', label: 'Ngành hàng', value: o.business, disabled: saleOnly, hint: saleOnly ? 'Sale ghi.' : null }),
      F({ name: 'contact', label: 'Người liên hệ tại BO', value: o.contact }),
      F({ name: 'phone', label: 'Số điện thoại', type: 'tel', value: o.phone }),
      ops ? F({ name: 'coord', label: 'Vị trí trên bản đồ', full: true, value: o.has_coord ? `${o.lat}, ${o.lon}` : '', placeholder: 'Dán link Google Maps hoặc toạ độ "10.77, 106.70"', hint: 'Cần để xếp chuyến giao, đổi thẻ. Để trống để xoá.' }) : null,
      (ops || head) && sales.length ? F({ name: 'sale_id', label: 'Sale phụ trách', type: 'select', options: saleOptions(sales), empty: 'Chưa giao', value: o.sale ? o.sale.id : '', disabled: saleOnly, hint: saleOnly ? 'Head of Sale giao BO cho Sale.' : null }) : null,
      logi && create ? null : F({ name: 'quota_hours', label: 'Quota giờ quay (giờ)', type: 'number', min: 1, step: 1, value: o.quota_hours ?? '', disabled: saleOnly, hint: saleOnly ? 'Sale chốt; Logistics chỉ xem.' : 'Tổng giờ quay BO được dùng, tính từ lần launch gần nhất. Sale chốt. Để trống nếu chưa có.' }));
    const sched = h('div.h-fields',
      fieldWrap('Ngày đổi thẻ trong tuần', days, 'Đổi lịch thì việc đổi thẻ từ hôm nay được tạo lại theo lịch mới.'),
      F({ name: 'swap_from', label: 'Đổi thẻ từ', type: 'time', value: o.swap_from || '' }),
      F({ name: 'swap_to', label: 'đến', type: 'time', value: o.swap_to || '' }),
      F({ name: 'pause_from', label: 'Tạm nghỉ từ ngày', type: 'date', value: o.pause_from || '' }),
      F({ name: 'pause_to', label: 'đến ngày', type: 'date', value: o.pause_to || '', hint: 'Trong khoảng này BO không đổi thẻ; máy vẫn ở BO. Xoá hoặc dời khi BO đang nghỉ thì BO ghi hình lại ngay.' + (o.ops_status === 'paused' && !o.pause_from ? ' BO đang tạm nghỉ chưa có ngày (thường do nhập từ file): nhập khoảng tạm nghỉ để BO tự ghi hình lại đúng ngày.' : '') }),
      PAUSE_BACKDATE.includes(ctx.role) ? F({ name: 'pause_reason', label: 'Lý do ghi lùi tạm nghỉ', full: true, hint: 'Chỉ cần khi ngày bắt đầu tạm nghỉ ở quá khứ: ghi lùi làm đổi cách tính chuẩn giờ quay những ngày đã qua.' }) : null,
      F({ name: 'note', label: 'Ghi chú', type: 'textarea', rows: 2, value: o.note || '' }));
    const body = h('div.h-stack', info, h('h3.outlets-fh', 'Lịch đổi thẻ và tạm nghỉ'), sched);
    const intro = create ? 'BO mới ở trạng thái "Chờ launch". Muốn giao máy thì gửi yêu cầu mở BO; quota giờ quay do Sale đặt sau.' : !ops ? 'Tên và vị trí BO do Logistics cập nhật. Bạn sửa được mã BO, thông tin liên hệ, lịch đổi thẻ, tạm nghỉ, quota và ghi chú.'
      : logi ? 'Quota, Sale phụ trách, ngành hàng và khu vực do Sale ghi (chỉ xem). Ngày launch đổi ở yêu cầu launch; dừng BO bằng nút "Kết thúc ghi hình".' : null;
    return dlg({
      title: create ? 'Thêm BO' : `Sửa thông tin ${o.name}`, wide: true, submit: create ? 'Thêm BO' : 'Lưu', intro, body,
      onSubmit: async (form, ctl) => {
        if (ops && !required(form, ctl, [['name', 'Tên BO']])) return false;
        const b = {};
        for (const k of ['name', 'code', 'address', 'area', 'business', 'contact', 'phone', 'swap_from', 'swap_to', 'pause_from', 'pause_to', 'note']) { const v = val(form, k); if (v !== undefined) b[k] = v; }
        b.swap_days = days.value();
        const q = val(form, 'quota_hours');
        if (q !== undefined) b.quota_hours = q === '' ? null : Number(String(q).replace(',', '.'));
        const sid = val(form, 'sale_id');
        if (sid !== undefined) b.sale_id = sid ? Number(sid) : null;
        if ((b.pause_from && !b.pause_to) || (!b.pause_from && b.pause_to)) { ctl.setErr('Nhập đủ cả ngày bắt đầu và ngày kết thúc tạm nghỉ (hoặc để trống cả hai).'); return false; }
        if (b.pause_from && b.pause_to && b.pause_from > b.pause_to) { ctl.setErr('Ngày kết thúc tạm nghỉ phải từ ngày bắt đầu trở đi.'); return false; }
        const pauseChanged = (b.pause_from || '') !== (o.pause_from || '') || (b.pause_to || '') !== (o.pause_to || '');
        if (!create && pauseChanged && b.pause_from && b.pause_from < H.today() && !(b.pause_from === o.pause_from && o.ops_status === 'paused')) {
          if (!PAUSE_BACKDATE.includes(ctx.role)) { ctl.setErr('Ngày bắt đầu tạm nghỉ không được ở quá khứ. Cần ghi lùi thì nhờ Head of Sale hoặc Logistic Lead sửa, kèm lý do.'); inp(form, 'pause_from').focus(); return false; }
          const why = val(form, 'pause_reason') || '';
          if (why.length < 3) { ctl.setErr('Ngày bắt đầu tạm nghỉ ở quá khứ: ghi lý do ghi lùi.'); inp(form, 'pause_reason').focus(); return false; }
          b.pause_reason = why;
        }
        if ((b.swap_from && !b.swap_to) || (!b.swap_from && b.swap_to)) { ctl.setErr('Nhập đủ giờ bắt đầu và giờ kết thúc khung đổi thẻ.'); return false; }
        if (ops) {
          const c = coordOf(val(form, 'coord'));
          if (c === false) { ctl.setErr('Không đọc được vị trí. Dán link Google Maps hoặc toạ độ dạng "10.77, 106.70".'); inp(form, 'coord').focus(); return false; }
          if (c) Object.assign(b, c); else if (!create && o.has_coord) Object.assign(b, { lat: null, lon: null });
        }
        if (create) {
          const j = await ctx.api('POST', '/api/hub/outlets', b);
          ARL.toast(`Đã thêm ${ARL.boLabel(j.outlet.name)}.`);
          return j.outlet;
        }
        const j = await ctx.api('PATCH', `/api/hub/outlets/${o.id}`, b);
        const sch = ['swap_days', 'swap_from', 'swap_to', 'pause_from', 'pause_to'].some((k) => String(j.outlet[k] ?? '') !== String(o[k] ?? ''));
        const moved = j.outlet.ops_status === o.ops_status ? '' : j.outlet.ops_status === 'live' ? ' BO ghi hình lại từ hôm nay.' : j.outlet.ops_status === 'paused' ? ' BO tạm nghỉ từ hôm nay.' : '';
        ARL.toast((sch ? 'Đã lưu. Việc đổi thẻ từ hôm nay được cập nhật theo lịch mới.' : 'Đã lưu thông tin BO.') + moved);
        return j.outlet;
      },
    });
  }

  /** Yêu cầu hỗ trợ trên BO đang ghi hình / tạm nghỉ (POST /outlets/:id/support). preset: { kind, kit_id }. */
  async function supportForm(ctx, d, preset = {}) {
    const o = d.outlet, kits = (d.kits || []).filter((k) => k.status === 'at_bo');
    const [types, labels] = await Promise.all([accTypes(ctx), errLabels(ctx)]);
    const known = new Set((d.requests || []).map((r) => r.id));
    const rk = ARL.reqKey(); // một khoá cho lần mở này: gửi lại sau khi mất mạng không cộng dồn lần nữa
    const kinds = Object.entries(M().support_kind || {});
    const kindF = H.field({ name: 'kind', label: 'Cần hỗ trợ gì', type: 'select', options: kinds, value: preset.kind || 'swap_device', required: true });
    const kitF = H.field({ name: 'kit_id', label: 'Kit', type: 'select', required: true, options: kits.map((k) => [k.id, `${k.code} · ${k.kind_label}${k.fault ? ' · đang ghi lỗi' : ''}`]), empty: kits.length === 1 ? undefined : 'Chọn kit', value: preset.kit_id || (kits.length === 1 ? kits[0].id : '') });
    const devF = h('div');
    const labF = h('div');
    const accBox = h('div.h-field.h-full', h('span', 'Phụ kiện cần bổ sung'), accFields(types));
    // Thêm kit: số kit từng loại và ngày giao (khớp POST /outlets/:id/support kind "add_kit").
    const addBox = h('div.h-fields',
      H.field({ name: 'multicam', label: `Số ${kindName('multicam')} thêm`, type: 'number', min: 0, max: 200, step: 1, value: 1 }),
      H.field({ name: 'iphone', label: `Số ${kindName('iphone')} thêm`, type: 'number', min: 0, max: 200, step: 1, value: 0 }),
      H.field({ name: 'launch_date', label: 'Ngày giao', type: 'date', required: true, min: H.today(), hint: 'Ngày Logistics giao và setup kit thêm tại BO.' }));
    const info = h('p.h-note');
    const warn = h('p.h-note', { 'data-tone': 'wait', hidden: true });
    const noteF = H.field({ name: 'note', label: 'Mô tả ngắn', type: 'textarea', required: true, rows: 3 });
    const body = h('div.h-stack', h('div.h-fields', kindF, kitF, devF, labF), addBox, accBox, warn, noteF, info);
    const kitOf = () => kits.find((k) => String(k.id) === String(inp(body, 'kit_id').value));
    function sync() {
      const kind = inp(body, 'kind').value, kit = kitOf();
      kitF.hidden = !['swap_device', 'extra_acc'].includes(kind) || !kits.length;
      accBox.hidden = kind !== 'extra_acc';
      addBox.hidden = kind !== 'add_kit';
      const devs = kit ? kit.devices || [] : [];
      devF.replaceChildren(H.field({ name: 'device_id', label: 'Thiết bị hỏng', type: 'select', empty: 'Không rõ / cả kit', options: devs.map((x) => [x.id, `${x.type_name} ${x.code}`]) }));
      labF.replaceChildren(H.field({ name: 'label', label: 'Lỗi', type: 'select', options: labelsFor(labels, kit && kit.kind).map((l) => [l, l]), value: 'Khác' }));
      devF.hidden = labF.hidden = kind !== 'swap_device';
      info.textContent = kind === 'swap_device' ? 'Hệ thống ghi sự cố, đánh dấu kit lỗi và tạo việc đổi kit cho Logistics (thường đi cùng lượt đổi thẻ gần nhất). Kit lỗi về kho thì Tech sửa.'
        : kind === 'extra_acc' ? 'Logistics giao phụ kiện và cộng vào kit đã chọn. Nếu kit này đang có yêu cầu bổ sung chưa giao, phần mới được gộp vào để Logistics đi một lần.'
          : kind === 'add_kit' ? 'Như mở BO: Logistics chọn và chuẩn bị kit, Tech kiểm, rồi giao và setup tại BO (có biên bản). Giao xong BO ghi hình với số kit mới; ngày launch của BO giữ nguyên.'
            : kind === 'bad_card' ? 'Logistics nhận việc kiểm tra và thay thẻ tại BO.' : 'Logistics nhận việc và liên hệ lại nếu cần.';
      inp(body, 'note').placeholder = kind === 'swap_device' ? 'Ví dụ: máy không lên nguồn từ sáng, BO đã thử sạc lại' : kind === 'extra_acc' ? 'Ví dụ: headstrap bị đứt, cần thêm 2 cái' : kind === 'add_kit' ? 'Ví dụ: BO mở thêm quầy, cần thêm một góc quay' : 'Mô tả ngắn để Logistics xử lý';
      warn.hidden = true;
      if (['swap_device', 'extra_acc'].includes(kind) && !kits.length) { warn.hidden = false; warn.textContent = 'BO chưa có kit nào đang quay.'; }
      else if (kind === 'swap_device' && kit && kit.fault) { warn.hidden = false; warn.textContent = `Kit ${kit.code} đang được ghi lỗi: ${kit.fault}. Thường đã có việc đổi kit đang chờ Logistics; nếu vậy hệ thống sẽ báo và không tạo trùng.`; }
    }
    kindF.querySelector('select').addEventListener('change', sync);
    kitF.querySelector('select').addEventListener('change', sync);
    sync();
    return dlg({
      title: `Yêu cầu hỗ trợ · ${o.name}`, wide: true, submit: 'Gửi yêu cầu', body,
      onSubmit: async (form, ctl) => {
        const kind = val(form, 'kind');
        if (kind === 'swap_device' && !required(form, ctl, [['kit_id', 'Kit']])) return false;
        if (kind === 'extra_acc' && kits.length > 1 && !required(form, ctl, [['kit_id', 'Kit']])) return false;
        if (kind === 'add_kit' && !required(form, ctl, [['launch_date', 'Ngày giao']])) return false;
        const note = val(form, 'note') || '';
        if (note.length < 3) { ctl.setErr('Cần mô tả ngắn yêu cầu (ít nhất 3 ký tự).'); inp(form, 'note').focus(); return false; }
        const b = { kind, note };
        if (kind === 'swap_device') Object.assign(b, { kit_id: Number(val(form, 'kit_id')), device_id: val(form, 'device_id') ? Number(val(form, 'device_id')) : null, label: val(form, 'label') });
        if (kind === 'extra_acc') {
          b.acc = accValues(form);
          if (!Object.keys(b.acc).length) { ctl.setErr('Nhập số lượng ít nhất một loại phụ kiện.'); return false; }
          if (val(form, 'kit_id')) b.kit_id = Number(val(form, 'kit_id'));
        }
        b.req_key = rk;
        if (kind === 'add_kit') {
          const multicam = intOf(val(form, 'multicam')), iphone = intOf(val(form, 'iphone'));
          if (multicam + iphone < 1) { ctl.setErr(`Cần ít nhất 1 ${kindName('multicam')} hoặc ${kindName('iphone')}.`); inp(form, 'multicam').focus(); return false; }
          Object.assign(b, { need: { multicam, iphone }, launch_date: val(form, 'launch_date') });
        }
        const j = await ctx.api('POST', `/api/hub/outlets/${o.id}/support`, b);
        ARL.toast(j.merged || known.has(j.request.id) ? `Đã gộp vào yêu cầu ${j.request.code} đang chờ giao (cùng kit) để Logistics đi một lần.` : `Đã gửi yêu cầu hỗ trợ ${j.request.code}. Logistics đã được báo.`);
        return j.request;
      },
    });
  }

  /** Báo sự cố tại BO (POST /api/hub/incidents). Tech nhận và xử lý; trùng kit + lỗi đang mở thì ghi thêm vào sự cố cũ. */
  async function incidentForm(ctx, d) {
    const o = d.outlet, kits = (d.kits || []).filter((k) => k.status === 'at_bo');
    const labels = await errLabels(ctx);
    const kitF = H.field({ name: 'kit_id', label: 'Kit', type: 'select', empty: 'Không rõ kit / cả BO', options: kits.map((k) => [k.id, `${k.code} · ${k.kind_label}`]), value: kits.length === 1 ? kits[0].id : '' });
    const labF = h('div');
    const body = h('div.h-stack', h('div.h-fields', kitF, labF),
      H.field({ name: 'text', label: 'Mô tả', type: 'textarea', required: true, rows: 3, placeholder: 'Ví dụ: màn hình CM5 báo lỗi đỏ từ 10 giờ sáng' }),
      H.field({ name: 'urgent', label: 'Gấp: BO đang không ghi hình được', type: 'checkbox' }),
      H.note('Tech nhận sự cố và chọn cách xử lý (hướng dẫn tại chỗ, đổi máy hoặc mang về sửa). Cần thay kit ngay thì dùng "Yêu cầu hỗ trợ → Đổi máy hư".'));
    const sync = () => { const k = kits.find((x) => String(x.id) === inp(body, 'kit_id').value); labF.replaceChildren(H.field({ name: 'label', label: 'Lỗi', type: 'select', required: true, empty: 'Chọn lỗi', options: labelsFor(labels, k && k.kind).map((l) => [l, l]) })); };
    kitF.querySelector('select').addEventListener('change', sync);
    sync();
    return dlg({
      title: `Báo sự cố · ${o.name}`, wide: true, submit: 'Báo sự cố', body,
      onSubmit: async (form, ctl) => {
        if (!required(form, ctl, [['label', 'Lỗi'], ['text', 'Mô tả']])) return false;
        if (val(form, 'text').length < 3) { ctl.setErr('Cần mô tả ngắn sự cố (ít nhất 3 ký tự).'); return false; }
        const j = await ctx.api('POST', '/api/hub/incidents', { site_id: o.id, kit_id: val(form, 'kit_id') ? Number(val(form, 'kit_id')) : null, label: val(form, 'label'), text: val(form, 'text'), urgent: val(form, 'urgent') });
        ARL.toast(j.duplicate ? `Sự cố ${j.incident.code} cùng kit và lỗi đang mở: đã ghi thêm vào đó.` : `Đã báo sự cố ${j.incident.code}. Tech đã được báo.`);
        return j.incident;
      },
    });
  }

  /** Kết thúc ghi hình: nói rõ hệ thống sẽ làm gì (khác nhau giữa kết thúc hôm nay và hẹn ngày sau) trước khi xác nhận. */
  function endForm(ctx, d) {
    const o = d.outlet, n = (d.kits || []).filter((k) => k.status === 'at_bo').length;
    const steps = h('ul.outlets-ul');
    const undo = 'Đổi ý (hoặc muốn đổi ngày) khi FO chưa đi thu: Sale phụ trách hoặc Head of Sale huỷ yêu cầu kết thúc ở mục Yêu cầu.';
    const done = `Thu hồi xong hết kit thì BO chuyển "${H.label('outlet_st', 'ended')}" và Sale được báo.`;
    const paint = (date) => {
      if (date && date > H.today()) {
        steps.replaceChildren(
          h('li', `Tạo yêu cầu kết thúc. Trước ngày ${H.dmy(date)} BO vẫn ghi hình, đổi thẻ và nhận hỗ trợ như thường.`),
          h('li', `Từ ngày ${H.dmy(date)}: BO chuyển "${H.label('outlet_st', 'ending')}", Logistics thu ${n} kit (hạn 2 ngày sau) và thẻ ở BO; không còn đổi thẻ, việc đổi kit hỏng chưa lên chuyến được huỷ (kit lỗi về cùng đợt thu hồi), yêu cầu hỗ trợ còn mở được đóng.`),
          h('li', undo), h('li', done));
      } else {
        steps.replaceChildren(
          h('li', `Chuyển BO sang "${H.label('outlet_st', 'ending')}" ngay và tạo yêu cầu kết thúc.`),
          h('li', `Tạo việc thu hồi ${n} kit cho Logistics (hạn 2 ngày), thẻ ở BO cũng được thu về.`),
          h('li', 'Huỷ việc đổi thẻ và việc đổi kit hỏng chưa lên chuyến (kit lỗi về cùng đợt thu hồi); yêu cầu hỗ trợ còn mở được đóng.'),
          h('li', undo), h('li', done));
      }
    };
    paint(H.today());
    const dateF = H.field({ name: 'date', label: 'Kết thúc từ ngày', type: 'date', required: true, value: H.today(), min: H.today(), hint: 'Chọn ngày sau nếu BO còn ghi hình thêm một thời gian.' });
    dateF.querySelector('input').addEventListener('input', (e) => paint(e.target.value));
    return dlg({
      title: `Kết thúc ghi hình · ${o.name}`, submit: 'Kết thúc ghi hình', danger: true, intro: h('div.h-stack', h('p', 'Khi xác nhận, hệ thống sẽ:'), steps),
      body: h('div.h-fields', dateF,
        H.field({ name: 'note', label: 'Lý do', type: 'textarea', required: true, rows: 2, placeholder: 'Ví dụ: hết hợp đồng, BO chuyển địa điểm' })),
      onSubmit: async (form, ctl) => {
        if (!required(form, ctl, [['date', 'Ngày kết thúc'], ['note', 'Lý do']])) return false;
        if (val(form, 'note').length < 3) { ctl.setErr('Ghi rõ lý do hơn một chút (ít nhất 3 ký tự).'); return false; }
        const date = val(form, 'date');
        const j = await ctx.api('POST', `/api/hub/outlets/${o.id}/end`, { date, note: val(form, 'note') });
        ARL.toast(j.request.status === 'scheduled' ? `Đã hẹn kết thúc ghi hình tại ${o.name} từ ${H.dmy(date)}. Trước ngày đó BO vẫn ghi hình; Logistics đã được báo.` : `Đã kết thúc ghi hình tại ${o.name} từ ${H.dmy(date)}. Logistics đã nhận việc thu hồi.`);
        return j.request;
      },
    });
  }

  /** Gán kit cho yêu cầu (Logistics): chọn từ kit rảnh đúng loại máy chủ gợi ý, không vượt số cần. */
  function assignForm(ctx, det) {
    const r = det.request, n = r.need || {}, cands = det.candidates || [];
    const have = { multicam: (r.kits || []).filter((k) => k.kind === 'multicam' || k.kind === 'custom').length, iphone: (r.kits || []).filter((k) => k.kind === 'iphone').length };
    const left = { multicam: Math.max(0, (n.multicam || 0) - have.multicam), iphone: Math.max(0, (n.iphone || 0) - have.iphone) };
    const picked = new Set();
    const boxes = [];
    const paintLimits = () => {
      for (const { kind, input, row } of boxes) {
        if (kind === 'custom') continue;
        const cnt = cands.filter((c) => c.kind === kind && picked.has(c.id)).length;
        const off = !input.checked && cnt >= left[kind];
        input.disabled = off; row.dataset.off = off ? '1' : '';
      }
      sumEl.textContent = `Đã chọn ${picked.size} kit.`;
    };
    const stLabel = { ready: 'Đã kiểm, sẵn sàng', preparing: 'Đang chuẩn bị', returned: 'Đã về kho, chưa kiểm' };
    const group = (kind) => {
      const list = cands.filter((c) => c.kind === kind);
      if (!list.length) return null;
      const title = kind === 'custom' ? kindName('custom') : `${kindName(kind)} · còn cần ${left[kind]}`;
      return h('fieldset.requests-pick', h('legend', title), list.map((c) => {
        const input = h('input', { type: 'checkbox', value: String(c.id), 'aria-label': `Chọn kit ${c.code}`, onchange: (e) => { if (e.target.checked) picked.add(c.id); else picked.delete(c.id); paintLimits(); } });
        const row = h('label', input, h('span', h('b', c.code), h('small', stLabel[c.status] || H.label('kit_st', c.status))), c.complete ? H.pill('Đủ thành phần', 'go') : H.pill(`Thiếu: ${(c.missing || []).map((t) => TN[t] || t).join(', ') || 'thiết bị'}`, 'wait'));
        boxes.push({ kind, input, row });
        return row;
      }));
    };
    const sumEl = h('p.sub');
    const groups = ['multicam', 'iphone', 'custom'].map(group).filter(Boolean);
    const body = groups.length ? h('div.h-stack', groups, sumEl) : H.empty(`Không còn kit rảnh đúng loại. Chuẩn bị thêm kit ở mục ${(ARL.hub.NAV.kits || {}).title || 'Kit'}.`);
    if (groups.length) paintLimits();
    return dlg({
      title: `Gán kit cho ${r.code}`, wide: true, submit: 'Gán kit', noFocus: true,
      intro: `Cần ${needText(n)}. Đã gán ${(r.kits || []).length} kit. Kit đã kiểm chuyển ngay sang "${H.label('kit_st', 'reserved')}"; kit đang chuẩn bị cần chuẩn bị xong rồi gửi Tech kiểm.`,
      body,
      onSubmit: async (form, ctl) => {
        if (!picked.size) { ctl.setErr('Chọn ít nhất một kit.'); return false; }
        const j = await ctx.api('POST', `/api/hub/requests/${r.id}/assign`, { kit_ids: [...picked] });
        ARL.toast(`Đã gán ${picked.size} kit cho ${r.code}.`);
        return j.request;
      },
    });
  }

  /** Sửa yêu cầu mở BO: ngày launch, số kit, phụ kiện, ghi chú. Chỉ gửi phần đã đổi (máy chủ chặn đổi số kit khi việc giao đã lên chuyến). */
  async function requestEdit(ctx, r) {
    const types = await accTypes(ctx);
    const n = r.need || {};
    const addKit = r.kind === 'support' && n.kind === 'add_kit', dateLbl = addKit ? 'Ngày giao' : 'Ngày launch';
    const body = h('div.h-stack',
      h('div.h-fields',
        H.field({ name: 'launch_date', label: dateLbl, type: 'date', required: true, value: r.launch_date || '', min: H.today() }),
        addKit ? null : H.field({ name: 'other', label: 'Thiết bị / yêu cầu khác', value: n.other || '' }),
        H.field({ name: 'multicam', label: `Số ${kindName('multicam')}`, type: 'number', min: 0, max: 200, step: 1, value: n.multicam || 0 }),
        H.field({ name: 'iphone', label: `Số ${kindName('iphone')}`, type: 'number', min: 0, max: 200, step: 1, value: n.iphone || 0 })),
      types.length ? h('details.outlets-more', { open: Object.keys(n.acc || {}).length > 0 }, h('summary', 'Phụ kiện thêm'), accFields(types, n.acc || {})) : null,
      H.field({ name: 'note', label: 'Ghi chú', type: 'textarea', rows: 2, value: r.note || '' }));
    return dlg({
      title: `Sửa yêu cầu ${r.code}`, wide: true, body,
      intro: SALE.includes(ctx.role) ? 'Logistics được báo khi bạn sửa. Giảm số kit thấp hơn số đã gán thì Logistics cần gỡ bớt kit trước.' : null,
      onSubmit: async (form, ctl) => {
        if (!required(form, ctl, [['launch_date', dateLbl]])) return false;
        const b = {};
        if (val(form, 'launch_date') !== r.launch_date) b.launch_date = val(form, 'launch_date');
        const nn = { multicam: intOf(val(form, 'multicam')), iphone: intOf(val(form, 'iphone')), acc: accValues(form), other: addKit ? n.other : val(form, 'other') || undefined };
        if (nn.multicam + nn.iphone < 1) { ctl.setErr(`Cần ít nhất 1 ${kindName('multicam')} hoặc ${kindName('iphone')}.`); return false; }
        const same = nn.multicam === (n.multicam || 0) && nn.iphone === (n.iphone || 0) && JSON.stringify(nn.acc) === JSON.stringify(n.acc || {}) && (nn.other || '') === (n.other || '');
        if (!same) b.need = nn;
        if (val(form, 'note') !== (r.note || '')) b.note = val(form, 'note');
        if (!Object.keys(b).length) return true;
        const j = await ctx.api('PATCH', `/api/hub/requests/${r.id}`, b);
        ARL.toast(`Đã lưu yêu cầu ${r.code}.`);
        return j.request;
      },
    });
  }

  // ───────── Mảnh giao diện dùng chung ─────────
  /** Biểu đồ giờ quay theo ngày. Dùng ARL.chart.line nếu có; không thì cột nhỏ bằng CSS. */
  function hoursChart(series, target, std, kits) {
    const labels = series.map((x) => `${x.date.slice(8, 10)}/${x.date.slice(5, 7)}`);
    const data = series.map((x) => x.hours);
    if (ARL.chart && typeof ARL.chart.line === 'function') {
      try {
        return ARL.chart.line({ labels, series: [{ name: 'Giờ quay', data, tone: 'blue', area: true }], height: 220, format: (v) => `${H.num(v, 1)} giờ`, yMin: 0, target: target ? { value: target, label: `Chuẩn ${H.num(std, 1)} giờ × ${kits} kit` } : undefined });
      } catch (e) { console.error(e); }
    }
    const max = Math.max(target || 0, ...data, 1);
    const bars = h('div.outlets-bars', { role: 'img', 'aria-label': `Giờ quay ${series.length} ngày gần nhất, cao nhất ${H.num(Math.max(...data, 0), 1)} giờ một ngày` },
      series.map((x) => h('i', { style: { height: `${Math.max(1, (x.hours / max) * 100)}%` }, title: `${H.dmy(x.date)}: ${H.num(x.hours, 1)} giờ, ${x.cards} thẻ` })),
      target ? h('b.outlets-bars-target', { style: { bottom: `${(target / max) * 100}%` }, title: `Chuẩn ${H.num(target, 1)} giờ/ngày` }) : null);
    return h('div', bars, h('div.outlets-bars-axis', h('span', H.dmy(series[0].date)), h('span', `cao nhất ${H.num(Math.max(...data, 0), 1)} giờ/ngày`), h('span', H.dmy(series[series.length - 1].date))));
  }
  function quotaGauge(o, w) {
    const warn = CFG().quotaWarnPct || 80, p = (o.quota_pct || 0) / 100;
    const qs = QUOTA_ST[o.quota_status || (w && w.quota_status) || 'ok']; // mức quota do máy chủ xếp (tỉ lệ chưa làm tròn)
    if (ARL.chart && typeof ARL.chart.gauge === 'function') {
      // Ngưỡng màu khớp cách máy chủ xếp quota_status: từ warn% là "sắp chạm", từ 100% là "vượt".
      try { return ARL.chart.gauge({ value: p, max: 1, label: 'quota đã dùng', format: (v) => H.pct(v), bands: [{ to: warn / 100 - 1e-6, tone: 'go' }, { to: 1 - 1e-6, tone: 'wait' }, { to: Infinity, tone: 'lost' }] }); } catch (e) { console.error(e); }
    }
    return h('div.outlets-gauge', h('span.outlets-big', H.pct(o.quota_pct, 0, true)), H.bar(p, qs[1]));
  }
  /** Ô quota trong bảng. */
  function quotaCell(r) {
    if (!r.quota_hours) return h('span.h-muted', 'Chưa đặt');
    const w = r.week, st = QUOTA_ST[r.quota_status || (w && w.quota_status) || 'ok'];
    return h('div.outlets-quota', h('span', h('b', H.pct(r.quota_pct, 0, true)), h('small', ` ${H.num(r.used_hours, 0)}/${H.num(r.quota_hours, 0)} giờ`)), H.bar((r.quota_pct || 0) / 100, st[1]));
  }
  /** Danh sách yêu cầu ngắn (trang BO). */
  function reqItems(ctx, list) {
    return h('div.h-list', list.map((r) => {
      const w = waitingOf(r);
      return h('button.h-item', { type: 'button', 'data-tone': w.tone === 'lost' ? 'lost' : REQ_ACTIVE.includes(r.status) ? 'wait' : null, onclick: () => ctx.go('requests', [r.id]) },
        h('span.h-item-t', `${r.code} · ${r.kind_label}`),
        h('span.h-item-m', h('span', reqWhat(r)), r.launch_date ? h('span', `Launch ${H.dmy(r.launch_date)}`) : null, h('span', `Gửi ${H.when(r.created_at)}`), w.who ? h('span', `Đang chờ: ${w.who}`) : null),
        h('span.h-item-r', H.st('req_st', r.status)));
    }));
  }
  function backBar(label, run) { return h('div.outlets-back', h('button.ghost', { type: 'button', onclick: run }, '‹ ', label)); }

  /** Mở / đóng trang chi tiết trong cùng màn hình: giữ vị trí cuộn của danh sách, nút Quay lại đi lùi lịch sử nếu vừa đi từ danh sách. */
  function detailNav(ctx, listBox, detBox, viewTitle) {
    const N = { open: null, fromList: false, next: false, scroll: 0 };
    N.show = (id) => {
      if (N.open === String(id)) return;
      if (!N.open) { N.scroll = mainEl() ? mainEl().scrollTop : 0; listBox.hidden = true; detBox.hidden = false; }
      N.fromList = N.next; N.next = false;
      N.open = String(id);
      if (mainEl()) mainEl().scrollTop = 0;
    };
    N.hide = () => {
      if (!N.open) return;
      N.open = null; N.fromList = false; N.next = false;
      detBox.hidden = true; listBox.hidden = false; detBox.replaceChildren();
      ctx.title(viewTitle);
      requestAnimationFrame(() => { if (mainEl()) mainEl().scrollTop = N.scroll; });
    };
    N.go = (id, query) => { N.next = !N.open; ctx.setParams([id], query); };
    N.back = () => {
      if (N.fromList && history.length > 1) history.back();
      else { const q = { ...ctx.query }; delete q.tab; ctx.setParams([], q); }
    };
    return N;
  }

  // ═════════════════════════ BO ═════════════════════════
  ARL.hub.view('outlets', {
    async mount(el, ctx) {
      const sale = ctx.role === 'sale', saleRole = SALE.includes(ctx.role), ops = ctx.can(CAN.outCreate);
      const viewTitle = (ARL.hub.NAV.outlets || {}).title || 'BO';
      const S = { rows: [], week: null, sales: [], loaded: false, f: { st: ctx.query.st || 'open', sale: ctx.query.sale || '', q: ctx.query.q || '', quick: ctx.query.quick || '' }, det: null, tab: ctx.query.tab || 'overview' };
      const listBox = h('div.outlets-list'), detBox = h('div.outlets-detail', { hidden: true });
      el.append(listBox, detBox);
      const N = detailNav(ctx, listBox, detBox, viewTitle);

      // ── Danh sách ──
      const newReq = async () => { const r = await requestForm(ctx, { outlets: S.rows, sales: S.sales }); if (r) { reload(); ctx.go('requests', [r.id]); } };
      const newBo = async () => { const o = await outletForm(ctx, null, S.sales); if (o) { await reload(); N.go(o.id); } };
      const head = H.head(viewTitle,
        saleRole ? (sale ? 'BO bạn phụ trách: giờ quay, quota, kit tại BO, yêu cầu và sự cố.' : 'Mọi BO của team Sale: giờ quay, quota, kit tại BO, yêu cầu và sự cố.')
          : 'Cửa hàng đối tác đang đặt kit ghi hình. Bấm một BO để xem giờ quay, kit, thẻ, yêu cầu và sự cố.',
        ctx.can(CAN.reqCreate) ? H.btn(saleRole ? 'Yêu cầu mở BO mới' : 'Gửi yêu cầu mở BO', newReq, saleRole ? 'primary' : '') : null,
        ops ? H.btn('Thêm BO', newBo, 'primary') : null,
        H.csv('/api/hub/export/outlets.csv', null, 'Tải CSV'));
      const kpiBox = h('div.outlets-kpis');
      const chipBox = h('div');
      const saleSel = h('select', { 'aria-label': 'Lọc theo Sale phụ trách', hidden: true, onchange: (e) => setF({ sale: e.target.value }) });
      const search = H.search('Tìm tên, mã, địa chỉ, Sale…', (q) => setF({ q }), S.f.q);
      const quickBox = h('div.outlets-quick');
      const tools = h('div.h-tools', chipBox);
      const tools2 = h('div.h-tools', search, saleSel, quickBox);
      const tableBox = h('div');
      listBox.append(head, kpiBox, tools, tools2, tableBox);

      const filterRows = (skip) => S.rows.filter((r) => {
        const f = S.f;
        if (skip !== 'st' && (f.st === 'open' ? r.ops_status === 'ended' : f.st !== 'all' && r.ops_status !== f.st)) return false;
        if (f.sale && (f.sale === 'none' ? !!r.sale : !r.sale || String(r.sale.id) !== f.sale)) return false;
        if (f.quick === 'quota' && !(r.week && ['near', 'over'].includes(r.week.quota_status))) return false;
        if (f.quick === 'below' && !(r.week && r.week.below_std)) return false;
        if (f.q && !H.match([r.name, r.code, r.address, r.area, r.business, r.contact, r.sale && r.sale.name].join(' '), f.q)) return false;
        return true;
      });
      function setF(patch) { Object.assign(S.f, patch); ctx.setQuery({ st: S.f.st === 'open' ? '' : S.f.st, sale: S.f.sale, q: S.f.q, quick: S.f.quick }); paint(); }

      const wkLabel = () => (S.week ? S.week.label : 'tuần này');
      const table = H.table({
        columns: [
          { key: 'name', label: 'BO', value: (r) => r.name, render: (r) => [h('b', r.name), h('small', [r.code, r.area || r.business].filter(Boolean).join(' · ') || null)] },
          { key: 'st', label: 'Trạng thái', value: (r) => OUT_ORDER[r.ops_status] ?? 9, render: (r) => [H.st('outlet_st', r.ops_status), r.ops_status === 'planned' && r.launch_date ? h('small', `Launch ${H.dmy(r.launch_date)}`) : null] },
          { key: 'sale', label: 'Sale', value: (r) => (r.sale ? r.sale.name : ''), render: (r) => (r.sale ? r.sale.name : h('span.h-muted', 'Chưa giao')) },
          { key: 'kits', label: 'Kit tại BO', align: 'r', value: (r) => r.kits, render: (r) => [h('b', H.num(r.kits)), r.kits ? h('small', Object.entries(r.kits_by_kind || {}).map(([k, n]) => `${n} ${kindName(k)}`).join(', ')) : null] },
          { key: 'hours', label: 'Giờ quay tuần này', align: 'r', desc: true, value: (r) => (r.week ? r.week.hours : null), render: (r) => (r.week ? [h('b', H.num(r.week.hours, 1)), h('small', wkDelta(S.week, r.week.cmp_hours, r.week.prev_hours, { d: 1 }))] : '–') },
          { key: 'quota', label: 'Quota đã dùng', desc: true, value: (r) => r.quota_pct, render: quotaCell },
          { key: 'pkd', label: 'Giờ/kit/ngày', align: 'r', value: (r) => (r.week ? r.week.per_kit_day : null), render: (r) => (r.week && r.week.per_kit_day !== null ? h('span', { class: r.week.below_std ? 'outlets-low' : null, title: r.week.below_std ? `Dưới chuẩn ${CFG().dailyStdHours} giờ/kit/ngày` : null }, H.num(r.week.per_kit_day, 1), r.week.below_std ? h('small', 'dưới chuẩn') : null) : '–') },
          { key: 'inc', label: 'Sự cố mở', align: 'r', desc: true, value: (r) => r.open_incidents, render: (r) => (r.open_incidents ? H.pill(String(r.open_incidents), 'lost') : '0') },
          { key: 'launch', label: 'Launch', value: (r) => r.launch_date || '', render: (r) => H.dmy(r.launch_date) },
        ],
        rows: [], onRow: (r) => N.go(r.id), pageSize: 50,
        rowTone: (r) => (r.week && r.week.quota_status === 'over') || r.open_incidents ? 'lost' : r.week && (r.week.below_std || r.week.quota_status === 'near') ? 'wait' : null,
        empty: 'Không có BO khớp bộ lọc.',
      });

      function paintKpis() {
        const rows = S.rows, std = CFG().dailyStdHours, warn = CFG().quotaWarnPct;
        const cnt = (st) => rows.filter((r) => r.ops_status === st).length;
        const wkRows = rows.filter((r) => r.week);
        const tiles = [
          H.kpi({ label: H.label('outlet_st', 'live'), value: cnt('live'), unit: 'BO', tone: 'go', hint: `${cnt('planned')} chờ launch · ${cnt('paused')} tạm nghỉ · ${cnt('ending')} đang thu hồi`, onClick: () => setF({ st: 'live', quick: '' }) }),
          H.kpi({ label: 'Kit đang ở BO', value: sum(rows, (r) => r.kits), unit: 'kit' }),
        ];
        if (S.week) {
          // Tổng do máy chủ cộng từ số thô (khớp Dashboard Kinh doanh và Tổng quan); bản cũ không có thì cộng từng BO.
          const tot = S.week.hours, cur = tot ? tot.cur : sum(wkRows, (r) => r.week.hours), cmp = tot ? tot.cmp || 0 : sum(wkRows, (r) => r.week.cmp_hours || 0), prev = tot ? tot.prev || 0 : sum(wkRows, (r) => r.week.prev_hours || 0);
          const q = rows.filter((r) => r.week && ['near', 'over'].includes(r.week.quota_status)).length, over = rows.filter((r) => r.week && r.week.quota_status === 'over').length;
          const rated = rows.filter((r) => r.week && r.week.per_kit_day !== null), below = rated.filter((r) => r.week.below_std).length;
          tiles.push(
            H.kpi({ label: `Giờ quay ${wkLabel()}`, value: H.num(cur, 1), unit: 'giờ', deltas: [wkDelta(S.week, cmp, prev)].filter(Boolean), hint: 'Giờ thô Tech nhập từ thẻ' }),
            H.kpi({ label: 'Sắp / đã chạm quota', value: q, unit: 'BO', tone: over ? 'lost' : q ? 'wait' : null, hint: `Báo khi dùng từ ${warn}% (đề xuất, Sale chốt)`, onClick: () => setQuick(S.f.quick === 'quota' ? '' : 'quota') }),
            H.kpi({ label: `Dưới chuẩn ${H.num(std, 1)} giờ/kit/ngày`, value: below, unit: `/${rated.length} BO`, tone: below ? 'wait' : null, hint: 'Chuẩn đề xuất, Sale chốt', onClick: () => setQuick(S.f.quick === 'below' ? '' : 'below') }));
        }
        const inc = sum(rows, (r) => r.open_incidents);
        tiles.push(H.kpi({ label: 'Sự cố đang mở', value: inc, tone: inc ? 'lost' : null, hint: inc ? 'Tại các BO trong danh sách' : 'Không có sự cố mở' }));
        kpiBox.replaceChildren(H.kpis(...tiles));
      }
      function paintChips() {
        const base = filterRows('st');
        const c = (st) => base.filter((r) => r.ops_status === st).length;
        const opts = [{ key: 'open', label: 'Chưa kết thúc', count: base.filter((r) => r.ops_status !== 'ended').length }];
        for (const st of ['live', 'planned', 'paused', 'ending', 'ended']) opts.push({ key: st, label: H.label('outlet_st', st), count: c(st) });
        opts.push({ key: 'all', label: 'Tất cả', count: base.length });
        chipBox.replaceChildren(H.chips(opts, S.f.st, (k) => setF({ st: k })));
      }
      function setQuick(k) { setF({ quick: k }); }
      function paintQuick() {
        if (!S.week) { quickBox.replaceChildren(); return; }
        const std = CFG().dailyStdHours;
        const nq = S.rows.filter((r) => r.week && ['near', 'over'].includes(r.week.quota_status)).length, nb = S.rows.filter((r) => r.week && r.week.below_std).length;
        const btn = (k, label, n) => h('button.chip', { type: 'button', 'aria-pressed': String(S.f.quick === k), onclick: () => setQuick(S.f.quick === k ? '' : k) }, label, ' ', h('b', String(n)));
        quickBox.replaceChildren(h('span', 'Lọc nhanh'), btn('quota', 'Sắp chạm quota', nq), btn('below', `Dưới chuẩn ${H.num(std, 1)} giờ/ngày`, nb));
      }
      function paintSale() {
        const show = !sale && S.sales.length > 0;
        saleSel.hidden = !show;
        if (!show) return;
        saleSel.replaceChildren(h('option', { value: '' }, 'Mọi Sale'), ...S.sales.map((s) => h('option', { value: String(s.id), selected: String(s.id) === S.f.sale }, s.name)), h('option', { value: 'none', selected: S.f.sale === 'none' }, 'Chưa giao Sale'));
      }
      function paint() {
        if (!S.loaded) return;
        paintChips(); paintQuick();
        if (!S.rows.length) {
          tools.hidden = tools2.hidden = true;
          tableBox.replaceChildren(H.empty(saleRole ? 'Bạn chưa phụ trách BO nào. Gửi yêu cầu mở BO để Logistics chuẩn bị kit.' : 'Chưa có BO nào. Thêm BO, hoặc chờ Sale gửi yêu cầu mở BO.',
            ctx.can(CAN.reqCreate) ? H.btn(saleRole ? 'Yêu cầu mở BO mới' : 'Gửi yêu cầu mở BO', newReq, 'primary') : null));
          return;
        }
        tools.hidden = tools2.hidden = false;
        if (!tableBox.contains(table)) tableBox.replaceChildren(table);
        table.update(filterRows().sort((a, b) => (OUT_ORDER[a.ops_status] ?? 9) - (OUT_ORDER[b.ops_status] ?? 9) || a.name.localeCompare(b.name, 'vi')));
      }
      async function reload() {
        const j = await ctx.api('GET', '/api/hub/outlets', null, { metrics: 1 });
        if (!ctx.alive()) return;
        S.rows = j.outlets || []; S.week = j.week || null; S.sales = j.sales || []; S.loaded = true;
        paintKpis(); paintSale(); paint();
      }
      tableBox.append(H.loading(6));
      const first = Promise.all([reload(), accTypes(ctx).catch(() => [])]).catch((e) => { if (ctx.alive()) tableBox.replaceChildren(H.error(e, () => { tableBox.replaceChildren(H.loading(6)); reload().catch((x) => tableBox.replaceChildren(H.error(x))); })); });

      // ── Chi tiết BO ──
      let detReload = null;
      const detBody = h('div');
      function openDetail(id) {
        const same = N.open === String(id);
        N.show(id);
        if (same && detReload) { detReload(); return; }
        S.det = null;
        S.tab = ctx.query.tab || 'overview';
        detBox.replaceChildren(backBar('Tất cả BO', N.back), detBody);
        detReload = H.async(detBody, async () => {
          const d = await ctx.api('GET', `/api/hub/outlets/${encodeURIComponent(id)}`, null, { days: 28, metrics: 1 });
          if (!ctx.alive() || N.open !== String(id)) return undefined;
          S.det = d;
          ctx.title(`${viewTitle} · ${d.outlet.name}`);
          return renderDetail(d);
        });
      }
      const refreshAll = () => { reload().catch((e) => console.error(e)); if (N.open && detReload) detReload(); };

      function detActions(d) {
        const o = d.outlet, st = o.ops_status;
        const liveish = st === 'live' || st === 'paused';
        const openLaunch = (d.requests || []).some((r) => r.kind === 'launch' && LAUNCH_OPEN.includes(r.status));
        const endOpen = (d.requests || []).some((r) => r.kind === 'end' && ['scheduled', 'ending'].includes(r.status));
        const mine = d.can_write !== false; // Sale Lead xem BO của người khác (cấu hình cho xem tất cả): chỉ xem
        const act = {
          support: liveish && mine && ctx.can(CAN.support) ? async () => { if (await supportForm(ctx, d)) refreshAll(); } : null,
          launch: (st === 'planned' || st === 'ended') && mine && !openLaunch && ctx.can(CAN.reqCreate) ? async () => { const r = await requestForm(ctx, { site: o, sales: S.sales }); if (r) ctx.go('requests', [r.id]); } : null,
          edit: mine && ctx.can(CAN.outEdit) ? async () => { if (await outletForm(ctx, o, S.sales)) refreshAll(); } : null,
          incident: ['live', 'paused', 'ending'].includes(st) && mine && ctx.can(CAN.incident) ? async () => { if (await incidentForm(ctx, d)) refreshAll(); } : null,
          end: liveish && mine && !endOpen && ctx.can(CAN.outEnd) ? async () => { if (await endForm(ctx, d)) refreshAll(); } : null,
        };
        return act;
      }
      function renderDetail(d) {
        const o = d.outlet, w = o.week, wk = d.week, act = detActions(d);
        const subBits = [o.code, o.sale ? `Sale: ${o.sale.name}` : 'Chưa giao Sale', o.address].filter(Boolean).join(' · ');
        const primary = act.support ? H.btn('Yêu cầu hỗ trợ', act.support, 'primary') : act.launch ? H.btn('Yêu cầu mở BO', act.launch, 'primary') : null;
        const more = [
          act.edit ? { label: 'Sửa thông tin', run: act.edit } : null,
          act.incident ? { label: 'Báo sự cố', run: act.incident } : null,
          { label: 'Xem yêu cầu của BO', run: () => ctx.go('requests', [], { site: o.id, st: 'all' }) },
          act.end ? '-' : null,
          act.end ? { label: 'Kết thúc ghi hình…', run: act.end, danger: true } : null,
        ].filter(Boolean);
        const head = h('header.h-head.outlets-dhead',
          h('div.h-head-l', h('h1', o.name, ' ', H.st('outlet_st', o.ops_status)), h('p.sub', subBits)),
          h('div.h-actions', primary, act.edit ? H.btn('Sửa thông tin', act.edit) : null, H.more(more)));
        const std = CFG().dailyStdHours;
        const kpis = H.kpis(
          H.kpi({ label: 'Kit tại BO', value: o.kits, unit: 'kit', hint: Object.entries(o.kits_by_kind || {}).map(([k, n]) => `${n} ${kindName(k)}`).join(', ') || 'Chưa có kit', onClick: () => { tabs.set('kits'); switchTab('kits'); } }),
          H.kpi({ label: 'Giờ quay 7 ngày qua', value: H.num(o.hours_7d, 1), unit: 'giờ', hint: `${o.cards_7d} thẻ${o.zero_7d ? ` · ${o.zero_7d} thẻ 0 giờ` : ''}`, tone: o.zero_7d ? 'wait' : null }),
          w ? H.kpi({ label: `Giờ quay ${wk ? wk.label : 'tuần này'}`, value: H.num(w.hours, 1), unit: 'giờ', deltas: [wkDelta(wk, w.cmp_hours, w.prev_hours, { d: 1 })].filter(Boolean), hint: wk ? `Tuần ${wk.from.slice(8, 10)}/${wk.from.slice(5, 7)}–${H.dmy(wk.to)}` : null }) : null,
          H.kpi({ label: 'Quota đã dùng', value: o.quota_hours ? H.pct(o.quota_pct, 0, true) : '–', hint: o.quota_hours ? `${H.num(o.used_hours, 1)} / ${H.num(o.quota_hours, 0)} giờ` : 'Chưa đặt quota', tone: o.quota_status === 'over' ? 'lost' : o.quota_status === 'near' ? 'wait' : null }),
          w ? H.kpi({ label: 'Giờ/kit/ngày', value: w.per_kit_day === null ? '–' : H.num(w.per_kit_day, 1), unit: w.per_kit_day === null ? '' : 'giờ', tone: w.below_std ? 'lost' : w.per_kit_day !== null ? 'go' : null, hint: `Chuẩn ${H.num(std, 1)} giờ (đề xuất, Sale chốt)` }) : null,
          H.kpi({ label: 'Sự cố đang mở', value: o.open_incidents, tone: o.open_incidents ? 'lost' : null, onClick: () => { tabs.set('incidents'); switchTab('incidents'); } }));
        const openReq = (d.requests || []).filter((r) => REQ_ACTIVE.includes(r.status)).length;
        const valid = ['overview', 'kits', 'requests', 'incidents', 'info'];
        if (!valid.includes(S.tab)) S.tab = 'overview';
        const tabs = H.tabs([['overview', 'Tổng quan'], ['kits', 'Kit & thẻ', o.kits], ['requests', 'Yêu cầu', openReq], ['incidents', 'Sự cố', o.open_incidents], ['info', 'Thông tin']], S.tab, (k) => switchTab(k));
        const tabBody = h('div.outlets-tab');
        function switchTab(k) { S.tab = k; ctx.setQuery({ tab: k === 'overview' ? '' : k }); paintTab(); }
        function paintTab() {
          const fn = { overview: tabOverview, kits: tabKits, requests: tabRequests, incidents: tabIncidents, info: tabInfo }[S.tab] || tabOverview;
          tabBody.replaceChildren(...[].concat(fn(d, act)).filter(Boolean));
        }
        paintTab();
        const notes = [];
        const launchReq = (d.requests || []).find((r) => r.kind === 'launch' && LAUNCH_OPEN.includes(r.status));
        if (o.ops_status === 'planned') {
          if (launchReq) {
            const wt = waitingOf(launchReq);
            notes.push(h('div.requests-wait', { 'data-tone': wt.tone },
              h('span.requests-wait-who', wt.who ? `Chờ launch · Đang chờ: ${wt.who}` : 'Chờ launch'),
              h('p', `Yêu cầu ${launchReq.code} (${H.label('req_st', launchReq.status)}), launch ${H.dmy(launchReq.launch_date)}. ${wt.text}`),
              h('p', H.btn(`Xem yêu cầu ${launchReq.code}`, () => ctx.go('requests', [launchReq.id]), 'small'))));
          } else notes.push(H.note(`BO chưa có yêu cầu mở BO đang xử lý.${act.launch ? ' Bấm "Yêu cầu mở BO" để Logistics chuẩn bị kit.' : ''}`, 'wait'));
        }
        const endReq = (d.requests || []).find((r) => r.kind === 'end' && ['scheduled', 'ending'].includes(r.status));
        const endBtn = endReq ? h('p', H.btn(`Xem yêu cầu ${endReq.code}`, () => ctx.go('requests', [endReq.id]), 'small')) : null;
        if (endReq && endReq.status === 'scheduled' && o.ops_status !== 'ending') {
          notes.push(h('div.requests-wait', { 'data-tone': 'blue' }, h('span.requests-wait-who', `Đã hẹn kết thúc ghi hình từ ${H.dmy(o.end_date)}`), h('p', waitingOf(endReq).text), endBtn));
        }
        if (o.ops_status === 'ending') notes.push(h('div.requests-wait', { 'data-tone': 'wait' }, h('span.requests-wait-who', 'Đang thu hồi'), h('p', `BO đang thu hồi thiết bị${o.end_date ? ` (kết thúc từ ${H.dmy(o.end_date)})` : ''}. Logistics thu kit và thẻ về kho.`), endBtn));
        if (d.can_write === false) notes.push(H.note('Bạn đang xem BO của Sale Lead khác: chỉ xem, không sửa hay gửi yêu cầu được.'));
        if (o.ops_status === 'paused') notes.push(H.note(`BO tạm nghỉ${o.pause_from ? ` từ ${H.dmy(o.pause_from)} đến ${H.dmy(o.pause_to)}` : ''}: không đổi thẻ, máy vẫn ở BO.`, 'wait'));
        return [head, ...notes, kpis, tabs, tabBody];
      }

      function tabOverview(d) {
        const o = d.outlet, w = o.week, ev = d.week && d.week.eval, std = CFG().dailyStdHours || 5, warn = CFG().quotaWarnPct || 80;
        const target = o.kits ? std * o.kits : null;
        // Bỏ các ngày trước đợt ghi hình gần nhất (launch lại thì từ lần launch mới); chưa có giờ nào thì nói rõ thay vì vẽ đường 0.
        const per = o.periods || [], start = per.length ? per[per.length - 1].from : o.active_date || o.launch_date || '';
        const series = (d.series || []).filter((x) => !start || x.date >= start);
        const anyHours = series.some((x) => x.hours > 0);
        const chart = H.card(`Giờ quay ${series.length && series.length < (d.series || []).length ? `từ ngày ghi hình ${H.dmy(start)}` : '28 ngày gần nhất'}`,
          anyHours && series.length > 1 ? hoursChart(series, target, std, o.kits)
            : H.empty(o.ops_status === 'planned' ? 'BO chưa ghi hình: giờ quay hiện ở đây sau khi giao kit.' : 'Chưa có giờ quay nào được nhập. Tech nhập giờ khi thẻ nhớ về kho.'), {
          span2: true, sub: target && anyHours ? `Đường chuẩn: ${H.num(std, 1)} giờ × ${o.kits} kit = ${H.num(target, 1)} giờ/ngày (đề xuất, Sale chốt). Giờ thô do Tech nhập từ thẻ, chia đều cho các ngày thẻ nằm ở BO; ngày thẻ còn ở BO chưa có giờ.` : 'Giờ thô do Tech nhập từ thẻ, chia đều cho các ngày thẻ nằm ở BO.',
        });
        const qs = o.quota_status ? QUOTA_ST[o.quota_status] : null;
        const quota = H.card('Quota giờ quay', o.quota_hours ? h('div.h-stack', quotaGauge(o, w), H.dl([
          ['Đã dùng', `${H.num(o.used_hours, 1)} / ${H.num(o.quota_hours, 0)} giờ${o.quota_from ? ` (từ lần launch gần nhất ${H.dmy(o.quota_from)})` : ''}`],
          ['Tình trạng', qs ? H.pill(qs[0], qs[1]) : null],
          ['Dự kiến chạm quota', w && w.quota_eta ? `${H.dmy(w.quota_eta)} (${dayHint(w.quota_eta)})` : null],
          ['Nhịp 14 ngày gần đây', w && w.pace_daily ? `${H.num(w.pace_daily, 1)} giờ/ngày` : null],
        ]), h('p.sub', `Báo "sắp chạm quota" khi dùng từ ${warn}% (đề xuất, Sale chốt).`)) : H.empty(ctx.can(CAN.quota) ? 'Chưa đặt quota giờ quay cho BO này.' : 'Chưa đặt quota giờ quay cho BO này. Sale đặt quota.', ctx.can(CAN.quota) && d.can_write !== false ? H.btn('Đặt quota', async () => { if (await outletForm(ctx, o, S.sales)) refreshAll(); }) : null)); // Sale Lead xem BO của người khác: chỉ xem
        let stdBody;
        if (!w) stdBody = H.empty('Chưa có số liệu chuẩn giờ quay.');
        else if (w.per_kit_day === null) stdBody = h('div.h-stack', h('p', 'Chưa đủ dữ liệu để xét tuần này.'), h('p.sub', 'Chỉ xét những ngày BO đang ghi hình, có kit và thẻ của ngày đó đã nhập đủ. Tuần này chưa có ngày nào như vậy (thẻ còn ở BO hoặc chưa nhập).'));
        else {
          stdBody = h('div.h-stack',
            h('div.h-row', h('span.outlets-big', H.num(w.per_kit_day, 1)), h('span.sub', 'giờ / kit / ngày'), w.below_std ? H.pill('Dưới chuẩn', 'lost') : H.pill('Đạt chuẩn', 'go'),
              w.prev_per_kit_day !== null ? H.delta(w.per_kit_day, w.prev_per_kit_day, { label: d.week ? d.week.prev_label : 'tuần trước', d: 1 }) : null),
            H.bar(Math.min(1, w.per_kit_day / std), w.below_std ? 'lost' : 'go'),
            h('p.sub', `Chuẩn ${H.num(std, 1)} giờ/kit/ngày (đề xuất, Sale chốt). Xét ${w.eval_days} ngày đã nhập đủ thẻ, ${H.num(w.eval_kits, 1)} kit mỗi ngày${ev ? `, trong ${H.dmy(ev.from)}–${H.dmy(ev.to)}` : ''}.`));
        }
        const stdCard = H.card('Chuẩn giờ quay', stdBody);
        const byKit = H.card('Giờ quay theo kit (28 ngày)', (d.hours_by_kit || []).length ? H.table({ columns: [{ key: 'kit', label: 'Kit', render: (x) => (x.kit_id ? linkOr(ctx, `kit:${x.kit_id}`, x.kit) : x.kit) }, { key: 'hours', label: 'Giờ quay', align: 'r', desc: true, render: (x) => H.num(x.hours, 1) }], rows: [...d.hours_by_kit].sort((a, b) => b.hours - a.hours), id: (x) => x.kit_id || 0, sort: null, cards: false }) : H.empty('Chưa có thẻ nào được nhập trong 28 ngày.'));
        const zero = H.card('Thẻ 0 giờ (28 ngày)', (d.zero_cards || []).length ? h('div.h-list', d.zero_cards.slice(0, 12).map((z) => h('div.h-item', { 'data-tone': 'wait' }, h('span.h-item-t', z.code), h('span.h-item-m', h('span', H.day(z.date)), h('span', z.reason || 'Chưa ghi lý do'))))) : H.empty('Không có thẻ 0 giờ. Tốt!'));
        const parts = [H.grid(2, chart, quota, stdCard, byKit, zero)];
        if (!SALE.includes(ctx.role)) {
          const jobs = d.jobs || [];
          parts.push(H.sec('Việc đang mở tại BO', jobs.length ? `${jobs.length} việc của Logistics và Tech` : null),
            jobs.length ? h('div.h-list', jobs.map((j) => { const due = H.due(j.due_at), href = ctx.jobLink(j); return h(href ? 'button.h-item' : 'div.h-item', { type: href ? 'button' : null, 'data-tone': j.overdue ? 'lost' : j.blocked ? 'wait' : null, onclick: href ? () => { location.hash = href; } : null }, h('span.h-item-t', j.title), h('span.h-item-m', h('span', `${j.code} · ${j.type_label}`), h('span', j.assignee ? j.assignee.name : 'Chưa ai nhận'), j.blocked ? h('span', `Vướng: ${j.blocked}`) : null), h('span.h-item-r', H.st('job_st', j.status), h('small', { 'data-tone': due.tone }, due.text))); })) : H.empty('Không có việc nào đang mở tại BO này.'));
        }
        return parts;
      }

      function tabKits(d, act) {
        const o = d.outlet, kits = d.kits || [];
        const canSup = !!act.support;
        const kitTable = H.table({
          columns: [
            { key: 'code', label: 'Kit', render: (k) => [h('b', linkOr(ctx, `kit:${k.id}`, k.code)), h('small', k.kind_label)] },
            { key: 'status', label: 'Trạng thái', render: (k) => H.st('kit_st', k.status) },
            { key: 'dev', label: 'Thiết bị', render: (k) => [(k.devices || []).map((x) => `${x.type_name} ${x.code}`).join(', ') || '–', k.faulty ? h('small.outlets-low', `${k.faulty} thiết bị không dùng được`) : null] },
            { key: 'acc', label: 'Phụ kiện', render: (k) => accText(k.acc) || '–' },
            { key: 'flag', label: 'Ghi nhận', render: (k) => [k.fault ? H.pill(`Lỗi: ${k.fault}`, 'lost') : null, k.watch ? H.pill(`Theo dõi: ${k.watch}`, 'wait') : null, !k.fault && !k.watch ? h('span.h-muted', 'Bình thường') : null] },
            canSup ? { key: 'act', label: 'Hỗ trợ', sort: false, render: (k) => (k.status === 'at_bo' ? h('div.h-row', H.btn('Đổi máy hư', async () => { if (await supportForm(ctx, d, { kind: 'swap_device', kit_id: k.id })) refreshAll(); }, 'small'), H.btn('Thêm phụ kiện', async () => { if (await supportForm(ctx, d, { kind: 'extra_acc', kit_id: k.id })) refreshAll(); }, 'small')) : null) } : null,
          ].filter(Boolean),
          rows: kits, sort: null, empty: o.ops_status === 'planned' ? 'BO chưa có kit. Kit tới BO sau khi Logistics giao và setup.' : 'Không có kit nào ở BO.',
        });
        const cards = d.cards || [];
        const cardTable = cards.length ? H.table({
          columns: [
            { key: 'code', label: 'Thẻ', render: (c) => h('b', c.code) },
            { key: 'since', label: 'Ở BO từ', value: (c) => c.since, render: (c) => H.when(c.since) },
            { key: 'age', label: 'Số ngày', align: 'r', value: (c) => c.since, render: (c) => (c.since ? H.dur((ARL.now() - c.since) / 60000) : '–') },
          ],
          rows: cards, sort: { key: 'since', dir: 1 },
        }) : H.empty('Không có thẻ nào đang ở BO.');
        const sch = swapText(o);
        return [
          H.sec('Kit tại BO', `${kits.length} kit`),
          kitTable,
          H.sec('Thẻ nhớ tại BO', [sch ? `Đổi thẻ: ${sch}` : 'Chưa có lịch đổi thẻ', `${H.num(CFG().cardsPerKit || 2)} thẻ/kit mỗi lượt (đề xuất, Logistics chốt)`].join(' · ')),
          cardTable,
        ];
      }

      function tabRequests(d, act) {
        const list = d.requests || [];
        return [
          h('div.h-row.h-between.outlets-tabbar', h('p.sub', list.length ? 'Bấm một yêu cầu để xem đang ở bước nào và đang chờ ai.' : ''),
            h('div.h-row', act.support ? H.btn('Yêu cầu hỗ trợ', act.support, 'primary') : null, act.launch ? H.btn('Yêu cầu mở BO', act.launch, 'primary') : null)),
          list.length ? reqItems(ctx, list) : H.empty('BO này chưa có yêu cầu nào.'),
        ];
      }

      function tabIncidents(d, act) {
        const list = d.incidents || [];
        const go = (i) => { const href = ctx.linkTo(`incident:${i.id}`); if (href) location.hash = href; };
        return [
          h('div.h-row.h-between.outlets-tabbar', h('p.sub', 'Sự cố do ba team báo tại BO; Tech nhận và xử lý.'), act.incident ? H.btn('Báo sự cố', act.incident, 'primary') : null),
          list.length ? h('div.h-list', list.map((i) => h('button.h-item', { type: 'button', 'data-tone': i.status === 'open' ? 'lost' : i.status === 'ack' ? 'wait' : null, onclick: () => go(i) },
            h('span.h-item-t', `${i.code} · ${i.label}`),
            h('span.h-item-m', i.kit ? h('span', `Kit ${i.kit.code}`) : null, h('span', H.when(i.created_at)), i.raised_by ? h('span', `${i.raised_by.name} (${i.raised_by.role_label})`) : null,
              i.status === 'resolved' && i.resolution_label ? h('span', i.resolution_label) : i.job && i.job.assignee ? h('span', `Tech: ${i.job.assignee}`) : null),
            h('span.h-item-r', H.st('incident_st', i.status))))) : H.empty('BO này chưa có sự cố nào.'),
        ];
      }

      function tabInfo(d, act) {
        const o = d.outlet;
        const dl = H.dl([
          ['Tên BO', o.name], ['Mã BO', o.code || null], ['Trạng thái', H.st('outlet_st', o.ops_status)], ['Sale phụ trách', o.sale ? o.sale.name : 'Chưa giao'],
          ['Địa chỉ', o.address ? [o.address, o.has_coord ? h('span', ' · ', H.link(ARL.gmapsAt(o.lat, o.lon), 'Mở bản đồ', { target: '_blank', rel: 'noopener' })) : null] : o.has_coord ? H.link(ARL.gmapsAt(o.lat, o.lon), 'Mở bản đồ', { target: '_blank', rel: 'noopener' }) : null],
          ['Vị trí', o.has_coord ? h('span.h-mono', `${o.lat}, ${o.lon}`) : h('span.outlets-low', 'Chưa có vị trí: Logistics chưa xếp chuyến được')],
          ['Khu vực', o.area || null], ['Ngành hàng', o.business || null], ['Người liên hệ', o.contact || null], ['Số điện thoại', tel(o.phone)],
          ['Lịch đổi thẻ', swapText(o) || h('span.outlets-low', 'Chưa có lịch')], ['Tạm nghỉ', o.pause_from ? `${H.dmy(o.pause_from)} – ${H.dmy(o.pause_to)}` : null],
          ['Ngày launch', o.launch_date ? H.dmy(o.launch_date) : null], ['Ngày onboard (đã ký)', o.onboard_date ? H.dmy(o.onboard_date) : null], ['Ngày active (có máy lần đầu)', o.active_date ? H.dmy(o.active_date) : null], ['Ngày kết thúc', o.end_date ? H.dmy(o.end_date) : null],
          ['Các đợt ghi hình', (o.periods || []).length ? h('div', o.periods.map((x) => h('div', `${H.dmy(x.from)} – ${x.to ? H.dmy(x.to) : 'nay'} · ${H.num(x.hours, 1)} giờ`))) : null],
          ['Quota giờ quay', o.quota_hours ? `${H.num(o.quota_hours, 0)} giờ` : 'Chưa đặt'], ['Ghi chú', o.note || null],
        ]);
        return [
          h('div.h-row.h-between.outlets-tabbar', h('p.sub', SALE.includes(ctx.role) ? 'Tên và vị trí do Logistics cập nhật; bạn sửa được mã BO, liên hệ, lịch đổi thẻ, tạm nghỉ, quota và ghi chú.' : ctx.can(['lead', 'logistic']) ? 'Quota, Sale phụ trách, ngành hàng, khu vực do Sale ghi; bạn sửa vị trí, liên hệ, lịch đổi thẻ và ghi chú.' : ''), act.edit ? H.btn('Sửa thông tin', act.edit, 'primary') : null),
          H.card(null, dl),
        ];
      }

      // ── Điều hướng trong màn hình ──
      const route = () => { const id = ctx.params[0]; if (id) openDetail(id); else { N.hide(); detReload = null; S.det = null; } };
      ctx.onRoute(() => {
        if (!ctx.params[0]) {
          const q = ctx.query;
          S.f = { st: q.st || 'open', sale: q.sale || '', q: q.q || '', quick: q.quick || '' };
          search.value = S.f.q; paintSale(); paint();
        }
        route();
      });
      ctx.live(['outlets', 'requests', 'kits', 'jobs', 'incidents', 'records'], refreshAll);
      route();
      await first;
    },
  });

  // ═════════════════════════ Yêu cầu của Sale ═════════════════════════
  const REQ_CHIPS = ['submitted', 'preparing', 'ready', 'delivering', 'live', 'scheduled', 'ending', 'closed', 'cancelled'];
  /** Các bước của yêu cầu (nhãn từ máy chủ) và thời điểm đã qua từng bước (từ nhật ký trạng thái). */
  function timeline(r, log) {
    const n = r.need || {};
    const addKit = r.kind === 'support' && n.kind === 'add_kit';
    // Kết thúc hẹn ngày sau hôm gửi: có thêm bước "Đã hẹn ngày kết thúc".
    const endSteps = n.end_date && n.end_date > H.dateOf(r.created_at) ? ['scheduled', 'ending', 'closed'] : ['ending', 'closed'];
    let steps = r.kind === 'launch' ? ['submitted', 'preparing', 'ready', 'delivering', 'live'] : addKit ? ['preparing', 'ready', 'delivering', 'closed'] : r.kind === 'support' ? ['preparing', 'closed'] : endSteps;
    if (r.kind === 'launch' && ['ending', 'closed'].includes(r.status)) steps = steps.concat('ending', 'closed');
    const when = { [steps[0]]: r.created_at };
    for (const e of [...(log || [])].reverse()) if (e.action === 'status' && e.data && e.data.to) when[e.data.to] = e.ts;
    if (r.closed_at) when[r.status === 'cancelled' ? 'cancelled' : 'closed'] = r.closed_at;
    let cur = steps.indexOf(r.status);
    const cancelled = r.status === 'cancelled';
    if (cancelled) {
      cur = 0;
      steps.forEach((k, i) => { if (when[k]) cur = i; });
      steps = steps.slice(0, cur + 1).concat('cancelled');
      cur = steps.length - 1;
    }
    const final = (k) => k === 'closed' || (k === 'live' && r.kind === 'launch' && r.status === 'live');
    return h('ol.requests-tl', { 'aria-label': 'Các bước của yêu cầu' }, steps.map((k, i) => {
      const state = cancelled && i === cur ? 'cancel' : i < cur || (i === cur && final(k)) ? 'done' : i === cur ? 'now' : 'todo';
      const label = i === 0 && r.kind === 'support' ? `Đã gửi · ${H.label('req_st', k)}` : H.label('req_st', k);
      return h('li', { 'data-state': state, 'aria-current': i === cur ? 'step' : null }, h('i', { 'aria-hidden': 'true' }), h('b', label), h('small', when[k] && i <= cur ? H.when(when[k]) : i === cur ? 'Đang ở bước này' : ''));
    }));
  }

  ARL.hub.view('requests', {
    async mount(el, ctx) {
      const saleRole = SALE.includes(ctx.role), ops = ctx.can(CAN.reqAssign);
      const viewTitle = (ARL.hub.NAV.requests || {}).title || 'Yêu cầu';
      const S = { rows: [], loaded: false, outlets: null, sales: [], f: { st: ctx.query.st || 'active', kind: ctx.query.kind || '', site: ctx.query.site || '', q: ctx.query.q || '' } };
      const listBox = h('div.requests-list'), detBox = h('div.requests-detail', { hidden: true });
      el.append(listBox, detBox);
      const N = detailNav(ctx, listBox, detBox, viewTitle);

      const outletsP = () => ctx.api('GET', '/api/hub/outlets').then((j) => { S.outlets = j.outlets || []; S.sales = j.sales || []; return j; });
      const newReq = async () => {
        if (!S.outlets) await outletsP();
        const r = await requestForm(ctx, { outlets: S.outlets, sales: S.sales });
        if (r) { await reload(); N.go(r.id); }
      };
      const head = H.head(viewTitle,
        saleRole ? 'Theo dõi yêu cầu gửi Logistics: đang ở bước nào và đang chờ ai.' : 'Yêu cầu mở BO, hỗ trợ và kết thúc ghi hình từ Sale. Gán kit, theo dõi chuẩn bị, kiểm và giao.',
        ctx.can(CAN.reqCreate) ? H.btn('Gửi yêu cầu mở BO', newReq, 'primary') : null);
      const chipBox = h('div');
      const kindSel = h('select', { 'aria-label': 'Lọc theo loại yêu cầu', onchange: (e) => setF({ kind: e.target.value }) },
        h('option', { value: '' }, 'Mọi loại'), Object.entries(M().req_kind || {}).map(([k, l]) => h('option', { value: k, selected: k === S.f.kind }, l)));
      const siteSel = h('select', { 'aria-label': 'Lọc theo BO', onchange: (e) => setF({ site: e.target.value }) });
      const search = H.search('Tìm mã, BO, Sale, ghi chú…', (q) => setF({ q }), S.f.q);
      const tools = h('div.h-tools', chipBox), tools2 = h('div.h-tools', search, kindSel, siteSel);
      const tableBox = h('div');
      listBox.append(head, tools, tools2, tableBox);

      const filterRows = (skip) => S.rows.filter((r) => {
        const f = S.f;
        if (skip !== 'st' && (f.st === 'active' ? !REQ_ACTIVE.includes(r.status) : f.st === 'waiting' ? !REQ_WAITING.includes(r.status) : f.st !== 'all' && r.status !== f.st)) return false;
        if (f.kind && r.kind !== f.kind) return false;
        if (f.site && (!r.site || String(r.site.id) !== String(f.site))) return false;
        if (f.q && !H.match([r.code, r.kind_label, r.site && r.site.name, r.sale && r.sale.name, r.by, r.note, reqWhat(r)].join(' '), f.q)) return false;
        return true;
      });
      function setF(patch) { Object.assign(S.f, patch); ctx.setQuery({ st: S.f.st === 'active' ? '' : S.f.st, kind: S.f.kind, site: S.f.site, q: S.f.q }); paint(); }
      const table = H.table({
        columns: [
          { key: 'code', label: 'Yêu cầu', value: (r) => r.created_at, desc: true, render: (r) => [h('b', r.code), h('small', r.kind_label)] },
          { key: 'site', label: 'BO', value: (r) => (r.site ? r.site.name : ''), render: (r) => [r.site ? r.site.name : '–', h('small', r.sale ? `Sale: ${r.sale.name}` : 'Chưa giao Sale')] },
          { key: 'what', label: 'Nội dung', sort: false, render: (r) => reqWhat(r) || '–' },
          { key: 'launch', label: 'Ngày launch', value: (r) => r.launch_date || '', render: (r) => (r.launch_date ? [H.dmy(r.launch_date), REQ_EDITABLE.includes(r.status) || r.status === 'delivering' ? h('small', dayHint(r.launch_date)) : null] : '–') },
          { key: 'status', label: 'Trạng thái', value: (r) => REQ_CHIPS.indexOf(r.status), render: (r) => { const w = waitingOf(r); return [H.st('req_st', r.status), w.who ? h('small', `Đang chờ: ${w.who}`) : null]; } },
          { key: 'kits', label: 'Kit', align: 'r', value: (r) => (r.kits || []).length, render: (r) => (isKitReq(r) ? `${(r.kits || []).length}/${kitsNeeded(r)}` : (r.kits || []).length || '–') },
          { key: 'upd', label: 'Cập nhật', value: (r) => r.updated_at, desc: true, render: (r) => H.when(r.updated_at) },
        ],
        rows: [], onRow: (r) => N.go(r.id),
        rowTone: (r) => { const w = waitingOf(r); return w.tone === 'lost' ? 'lost' : r.status === 'submitted' ? 'wait' : null; },
        empty: 'Không có yêu cầu khớp bộ lọc.',
      });
      function paintChips() {
        const base = filterRows('st');
        const c = (st) => base.filter((r) => r.status === st).length;
        const opts = [{ key: 'active', label: 'Đang xử lý', count: base.filter((r) => REQ_ACTIVE.includes(r.status)).length }];
        if (S.f.st === 'waiting') opts.push({ key: 'waiting', label: 'Chờ chuẩn bị', count: base.filter((r) => REQ_WAITING.includes(r.status)).length });
        for (const st of REQ_CHIPS) if (c(st) || S.f.st === st) opts.push({ key: st, label: H.label('req_st', st), count: c(st) });
        opts.push({ key: 'all', label: 'Tất cả', count: base.length });
        chipBox.replaceChildren(H.chips(opts, S.f.st, (k) => setF({ st: k })));
      }
      function paintSites() {
        const m = new Map();
        for (const r of S.rows) if (r.site) m.set(String(r.site.id), r.site.name);
        if (S.f.site && !m.has(String(S.f.site))) m.set(String(S.f.site), `BO #${S.f.site}`);
        const list = [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], 'vi'));
        siteSel.replaceChildren(h('option', { value: '' }, 'Mọi BO'), ...list.map(([id, name]) => h('option', { value: id, selected: id === String(S.f.site) }, name)));
        siteSel.hidden = list.length < 2 && !S.f.site;
      }
      function paint() {
        if (!S.loaded) return;
        paintChips();
        if (!S.rows.length) {
          tools.hidden = tools2.hidden = true;
          tableBox.replaceChildren(H.empty(saleRole ? 'Bạn chưa gửi yêu cầu nào. Gửi yêu cầu mở BO để Logistics chuẩn bị kit.' : 'Chưa có yêu cầu nào từ Sale.', ctx.can(CAN.reqCreate) ? H.btn('Gửi yêu cầu mở BO', newReq, 'primary') : null));
          return;
        }
        tools.hidden = tools2.hidden = false;
        if (!tableBox.contains(table)) tableBox.replaceChildren(table);
        table.update(filterRows());
      }
      async function reload() {
        const j = await ctx.api('GET', '/api/hub/requests');
        if (!ctx.alive()) return;
        S.rows = j.requests || []; S.loaded = true;
        if (ops) ctx.badge('requests', S.rows.filter((r) => r.status === 'submitted').length, 'wait');
        paintSites(); paint();
      }
      tableBox.append(H.loading(6));
      const first = Promise.all([reload(), accTypes(ctx).catch(() => [])]).catch((e) => { if (ctx.alive()) tableBox.replaceChildren(H.error(e, () => { tableBox.replaceChildren(H.loading(6)); reload().catch((x) => tableBox.replaceChildren(H.error(x))); })); });

      // ── Chi tiết yêu cầu ──
      let detReload = null;
      const detBody = h('div');
      function openDetail(id) {
        const same = N.open === String(id);
        N.show(id);
        if (same && detReload) { detReload(); return; }
        detBox.replaceChildren(backBar('Tất cả yêu cầu', N.back), detBody);
        detReload = H.async(detBody, async () => {
          const [d] = await Promise.all([ctx.api('GET', `/api/hub/requests/${encodeURIComponent(id)}`), accTypes(ctx).catch(() => [])]);
          if (!ctx.alive() || N.open !== String(id)) return undefined;
          ctx.title(`${viewTitle} · ${d.request.code}`);
          return renderDetail(d);
        });
      }
      const refreshAll = () => { reload().catch((e) => console.error(e)); if (N.open && detReload) detReload(); };

      function renderDetail(d) {
        const r = d.request, w = waitingOf(r), n = r.need || {};
        // Máy chủ báo can_write (Sale chỉ sửa yêu cầu của mình) và can_cancel (huỷ kết thúc còn tuỳ việc thu hồi).
        const kitReq = isKitReq(r), endReq = r.kind === 'end';
        const editable = kitReq && REQ_EDITABLE.includes(r.status) && ctx.can(CAN.reqCreate) && d.can_write !== false;
        const cancellable = d.can_cancel === true;
        const deliverJob = (d.jobs || []).find((j) => j.type === 'deliver' && ['open', 'doing'].includes(j.status) && j.task_id);
        const canAssign = ops && kitReq && REQ_EDITABLE.includes(r.status);
        const doAssign = async () => { if (await assignForm(ctx, d)) refreshAll(); };
        const doEdit = async () => { if (await requestEdit(ctx, r)) refreshAll(); };
        const doCancel = async () => {
          const intro = endReq
            ? 'BO tiếp tục ghi hình như cũ, việc thu hồi kit được huỷ và FO không phải đi thu nữa. Logistics được báo.'
            : 'Kit đã gán trả về kho (kit đã kiểm về "Sẵn sàng"). Việc chuẩn bị và giao đi kèm được huỷ; Logistics được báo.';
          const reason = await H.reason(endReq ? `Huỷ kết thúc ghi hình ${r.code}` : `Huỷ yêu cầu ${r.code}`, { intro, label: 'Lý do huỷ', danger: true, submit: endReq ? 'Huỷ kết thúc' : 'Huỷ yêu cầu' });
          if (!reason) return;
          await ctx.api('POST', `/api/hub/requests/${r.id}/cancel`, { reason });
          ARL.toast(endReq ? `Đã huỷ kết thúc ghi hình ${r.code}. BO tiếp tục ghi hình.` : `Đã huỷ yêu cầu ${r.code}.`);
          refreshAll();
        };
        const actions = [
          canAssign ? H.btn('Gán kit', doAssign, 'primary', deliverJob ? { disabled: true, title: 'Việc giao đã lên chuyến FO' } : {}) : null,
          editable ? H.btn('Sửa yêu cầu', doEdit) : null,
          cancellable ? H.more([{ label: endReq ? 'Huỷ kết thúc ghi hình…' : 'Huỷ yêu cầu…', run: doCancel, danger: true }]) : null,
        ];
        const head = h('header.h-head', h('div.h-head-l', h('h1', `${r.code} · ${r.kind_label}`, ' ', H.st('req_st', r.status)),
          h('p.sub', [r.site ? linkOr(ctx, `outlet:${r.site.id}`, r.site.name) : null, r.sale ? ` · Sale: ${r.sale.name}` : null, ` · Gửi bởi ${r.by || '–'} lúc ${H.when(r.created_at)}`])), h('div.h-actions', actions));
        const waitBox = h('div.requests-wait', { 'data-tone': w.tone },
          h('span.requests-wait-who', w.who ? `Đang chờ: ${w.who}` : r.status === 'cancelled' ? 'Đã huỷ' : 'Không chờ ai'), h('p', w.text));
        if (deliverJob && ops) waitBox.append(h('p.sub', `Việc giao ${deliverJob.code} đã lên chuyến FO: muốn đổi kit thì gỡ việc khỏi chuyến ở mục Điều phối trước.`));
        const info = H.card('Nội dung yêu cầu', H.dl([
          ['Loại', r.kind_label],
          ['BO', r.site ? linkOr(ctx, `outlet:${r.site.id}`, r.site.name) : null],
          kitReq ? ['Cần', needText(n)] : null,
          r.kind === 'support' ? ['Hỗ trợ', H.label('support_kind', n.kind)] : null,
          endReq && n.end_date ? ['Ngày kết thúc', H.dmy(n.end_date)] : null,
          accText(n.acc) ? ['Phụ kiện', accText(n.acc)] : null,
          n.other ? ['Khác', n.other] : null,
          r.launch_date ? [r.kind === 'launch' ? 'Ngày launch' : 'Ngày giao', `${H.dmy(r.launch_date)}${REQ_EDITABLE.includes(r.status) || r.status === 'delivering' ? ` (${dayHint(r.launch_date)})` : ''}`] : null,
          ['Ghi chú', r.note || null],
          r.status === 'cancelled' && r.reason ? ['Lý do huỷ', r.reason] : null,
          r.closed_at ? [r.status === 'cancelled' ? 'Huỷ lúc' : 'Đóng lúc', H.when(r.closed_at)] : null,
        ].filter(Boolean)));
        const kits = r.kits || [];
        const kitRows = kits.map((k) => {
          const btns = [];
          if (ops && ['preparing', 'returned'].includes(k.status) && ctx.can(CAN.kitSubmit)) btns.push(H.btn('Gửi Tech kiểm', async () => { await ctx.api('POST', `/api/hub/kits/${k.id}/submit`); ARL.toast(`Đã gửi kit ${k.code} cho Tech kiểm.`); refreshAll(); }, 'small'));
          if (ops && !away().includes(k.status)) btns.push(H.btn('Gỡ khỏi yêu cầu', async () => {
            if (!(await H.confirm(`Gỡ kit ${k.code} khỏi ${r.code}? Kit đã kiểm trả về "Sẵn sàng".`, 'Gỡ kit', true))) return;
            await ctx.api('POST', `/api/hub/requests/${r.id}/unassign`, { kit_id: k.id });
            ARL.toast(`Đã gỡ kit ${k.code}.`); refreshAll();
          }, 'small ghost danger', deliverJob ? { disabled: true, title: 'Việc giao đã lên chuyến FO' } : {}));
          return h('div.h-item', { 'data-tone': k.status === 'reserved' || k.status === 'at_bo' ? 'go' : k.status === 'wait_check' ? 'blue' : 'wait' },
            h('span.h-item-t', linkOr(ctx, `kit:${k.id}`, k.code), ' ', h('small.h-muted', kindName(k.kind))),
            h('span.h-item-m', H.st('kit_st', k.status)),
            h('span.h-item-r', btns.length ? h('div.h-row', btns) : null));
        });
        const need = kitsNeeded(r);
        const kitCard = (kitReq && r.status !== 'cancelled') || kits.length ? H.card(kitReq ? `Kit đã gán · ${kits.length}/${need}` : 'Kit', kits.length ? h('div.h-list', kitRows) : H.empty(ops && canAssign ? 'Chưa gán kit nào. Bấm "Gán kit" để chọn từ kit rảnh.' : 'Logistics chưa gán kit nào.', canAssign ? H.btn('Gán kit', doAssign, 'primary') : null), { actions: canAssign && kits.length && kits.length < need ? [H.btn('Gán thêm', doAssign, 'small')] : null }) : null;
        const parts = [head, timeline(r, d.log), waitBox, H.grid(kitCard ? 2 : 1, info, kitCard)];
        if (!saleRole) {
          const jobs = d.jobs || [];
          parts.push(H.sec('Việc liên quan', jobs.length ? 'Việc hệ thống tự sinh cho Logistics và Tech từ yêu cầu này' : null),
            jobs.length ? H.table({
              columns: [
                { key: 'code', label: 'Việc', render: (j) => { const href = ctx.jobLink(j); return [h('b', href ? H.link(href, j.code) : j.code), h('small', j.type_label)]; } },
                { key: 'title', label: 'Nội dung', render: (j) => j.title },
                { key: 'st', label: 'Trạng thái', render: (j) => [H.st('job_st', j.status), j.blocked ? h('small.outlets-low', `Vướng: ${j.blocked}`) : null, j.task_id && ['open', 'doing'].includes(j.status) ? h('small', 'Đã lên chuyến FO') : null] },
                { key: 'who', label: 'Người giữ', render: (j) => (j.assignee ? j.assignee.name : h('span.h-muted', ['open', 'doing'].includes(j.status) ? 'Chưa ai nhận' : '—')) },
                { key: 'due', label: 'Hạn', value: (j) => j.due_at || 0, render: (j) => { const x = H.due(j.due_at, j.done_at); return h('span', { class: x.tone === 'lost' ? 'outlets-low' : null }, x.text); } },
              ],
              rows: jobs, sort: null, onRow: (j) => { const href = ctx.jobLink(j); if (href) location.hash = href; },
            }) : H.empty('Chưa có việc nào.'));
        }
        if ((d.children || []).length) parts.push(H.sec('Yêu cầu hỗ trợ sau đó', `${d.children.length} yêu cầu`), reqItems(ctx, d.children));
        const log = d.log || [];
        if (log.length) parts.push(H.sec('Lịch sử'), h('ol.requests-log', log.map((e) => h('li', h('time', H.when(e.ts)), h('span', e.text)))));
        return parts;
      }

      const route = () => { const id = ctx.params[0]; if (id) openDetail(id); else { N.hide(); detReload = null; } };
      ctx.onRoute(() => {
        if (!ctx.params[0]) {
          // Về danh sách bằng link có bộ lọc (vd. từ trang BO): áp lại bộ lọc trên địa chỉ.
          const q = ctx.query;
          S.f = { st: q.st || 'active', kind: q.kind || '', site: q.site || '', q: q.q || '' };
          search.value = S.f.q; kindSel.value = S.f.kind;
          paintSites(); paint();
        }
        route();
      });
      ctx.live(['requests', 'kits', 'jobs', 'outlets'], refreshAll);
      route();
      await first;
    },
  });
})();
