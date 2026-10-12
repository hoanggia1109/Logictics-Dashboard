/* Ops Hub — Bảng việc (#/jobs, #/jobs/<id>) và phần dùng chung của nhóm "việc hằng ngày" (ARL.hubWork):
   khung chi tiết việc, hộp thoại báo xong theo từng loại việc (gửi đúng dữ liệu máy chủ kiểm tra), nhận / giao / bắt đầu /
   báo vướng / trả việc / huỷ / gỡ khỏi chuyến FO, tạo việc giao tay. "Việc của tôi" và "Điều phối chuyến" dùng lại các phần này.
   Người dùng chỉ xác nhận việc đã làm; trạng thái kit, thẻ, yêu cầu và việc kế tiếp do máy chủ tự đổi. */
(() => {
  'use strict';
  const H = ARL.H, { h } = H;
  const W = (ARL.hubWork = ARL.hubWork || {});

  const OPEN = ['open', 'doing'];
  const TASK_OPEN = ['unassigned', 'assigned', 'accepted', 'in_progress'];
  const LOGI = ['admin', 'lead', 'logistic'];
  /** Loại việc máy chủ không cho huỷ tay (core/hub/jobs.js NO_CANCEL): mỗi loại có đường dừng riêng. */
  const NO_CANCEL = new Set(['prep_kit', 'deliver', 'check_kit', 'repair', 'checkin', 'receive_back', 'receive_field', 'recover', 'cards_receive', 'cards_back', 'cards_upload', 'cards_return', 'incident']);
  /** Việc ngoài hiện trường đưa được vào chuyến FO (core/hub/jobs.js FIELD_TYPES). */
  W.FIELD_TYPES = ['deliver', 'card_swap', 'swap_faulty', 'recover', 'deliver_acc', 'manual'];
  W.OPEN = OPEN;
  W.TASK_OPEN = TASK_OPEN;
  const CORE_NAME = { multicam: 'Multicam', cm5: 'CM5', iphone: 'iPhone' };

  // ───────────── Tiện ích ─────────────
  /** Bỏ tham số rỗng trước khi gửi (URLSearchParams biến undefined thành chữ "undefined"). */
  W.clean = (q) => Object.fromEntries(Object.entries(q || {}).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false));
  /** Gộp các lần nạp lại dồn dập: đang nạp thì chỉ chạy thêm một lần nữa sau khi xong. */
  W.coalesce = (fn) => {
    let running = null, again = false;
    const run = () => {
      if (running) { again = true; return running; }
      running = (async () => { try { await fn(); } finally { running = null; if (again) { again = false; run(); } } })();
      return running;
    };
    return run;
  };
  const typeLabel = (t) => H.label('job_types', t);
  const teamLabel = (t) => (t && ARL.hubMeta && ARL.hubMeta.teams && ARL.hubMeta.teams[t]) || '';
  W.typeLabel = typeLabel;
  W.teamLabel = teamLabel;
  W.inTrip = (j) => OPEN.includes(j.status) && !!j.task_id;
  /** Hạn / tình trạng hạn của một việc: { text, tone }. */
  W.dueOf = (j) => {
    if (j.status === 'cancelled') return { text: 'Đã huỷ', tone: 'off' };
    if (j.status === 'done') return j.due_at ? H.due(j.due_at, j.done_at) : { text: 'Đã xong', tone: 'go' };
    if (j.blocked) return { text: 'Hạn tạm dừng do vướng', tone: 'wait' };
    if (j.due_at) return H.due(j.due_at);
    if (j.sla_min) return { text: `Hạn ${H.dur(j.sla_min)} từ lúc nhận`, tone: 'off' };
    return { text: 'Không hạn', tone: 'off' };
  };
  /** Hạn dự kiến để sắp xếp (việc chưa ai nhận: tính từ lúc tạo + SLA). */
  W.eta = (j) => j.due_at || (j.created_at || 0) + (j.sla_min || 1440) * 60000;
  /** Thứ tự gấp: việc đang vướng xuống cuối, rồi việc gấp, rồi hạn gần nhất. */
  W.urgency = (a, b) => (!!a.blocked - !!b.blocked) || ((b.priority || 0) - (a.priority || 0)) || (W.eta(a) - W.eta(b)) || (a.id - b.id);
  const canView = (ctx, id) => { const v = ARL.hub.views.get(id); return !!(v && v.roles.includes(ctx.role)); };
  const linkOr = (href, text) => (href ? H.link(href, text) : h('span', text));

  /** Danh mục loại thiết bị / phụ kiện (tên hiển thị). Nạp một lần, dùng chung. */
  let typesP = null;
  W.types = (ctx) => {
    if (!typesP) typesP = ctx.api('GET', '/api/hub/types').then((r) => new Map(r.types.map((t) => [t.id, t])), (e) => { typesP = null; throw e; });
    return typesP;
  };

  /** Việc đi theo phiếu / thẻ: không bấm "xong" chung mà làm ở màn hình phiếu (máy chủ trả use_flow). */
  W.flowOf = (ctx, j) => {
    if (j.type === 'cards_receive' || j.type === 'cards_back') {
      const href = (j.handover_id && ctx.linkTo(`handover:${j.handover_id}`)) || (canView(ctx, 'cards') ? '#/cards?tab=handovers' : null);
      return href ? { label: 'Mở phiếu bàn giao', href, hint: 'Đánh dấu các thẻ đã nhận trên phiếu; việc tự đóng khi nhận xong.' } : null;
    }
    if (j.type === 'cards_upload') return canView(ctx, 'upload') ? { label: 'Mở Nhập dung lượng', href: '#/upload', hint: 'Việc tự đóng khi mọi thẻ của phiếu đã nhập dung lượng (hoặc được ghi hỏng / thất lạc).' } : null;
    if (j.type === 'cards_return') return canView(ctx, 'cards') ? { label: 'Lập phiếu trả Logistics', href: '#/cards?tab=handovers', hint: 'Lập phiếu "Tech → Logistics" với các thẻ đã nhập dung lượng; việc tự đóng khi mọi thẻ đã nhập của phiếu đã vào phiếu trả.' } : null;
    return null;
  };

  /** Hộp thoại tự dựng: run() trả về false để giữ mở; lỗi ném ra hiện ngay trong hộp thoại (nguyên văn từ máy chủ). */
  W.dialog = (o) => new Promise((resolve) => {
    let out = null;
    ARL.modal({
      title: o.title, body: o.body, wide: !!o.wide, cls: o.cls || '', onClose: () => resolve(out),
      actions: [
        { label: o.cancel || 'Thôi', cls: 'ghost', run: () => {} },
        { label: o.submit || 'Lưu', cls: o.danger ? 'primary danger-bg' : 'primary', run: async (ctl) => { const r = await o.run(ctl); if (r === false) return false; out = r === undefined ? true : r; return true; } },
      ],
    });
    // Điện thoại: không tự đặt con trỏ (bàn phím bật lên che hộp thoại).
    if (o.focus !== false && !(window.matchMedia && matchMedia('(pointer: coarse)').matches)) setTimeout(() => {
      // Người dùng đã bấm vào một ô khác thì không giành lại con trỏ (gõ nhanh / máy quét mã không bị nhảy ô).
      const a = document.activeElement;
      if (a && o.body.contains(a) && a.matches('input, select, textarea')) return;
      const f = o.body.querySelector && o.body.querySelector('input:not([type=checkbox]):not([type=hidden]), select, textarea');
      if (f) f.focus();
    }, 40);
  });
  /** Trường nhập dùng lại H.field: { el, input, get() }. */
  const fld = (f) => { const el = H.field(f); const input = el.querySelector('input, select, textarea'); return { el, input, get: () => (f.type === 'checkbox' ? input.checked : String(input.value || '').trim()) }; };
  const codesOf = (s) => [...new Set(String(s || '').split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
  /** Hỏi lý do rồi gửi ngay trong hộp thoại (lỗi máy chủ hiện trong hộp thoại). */
  W.askReason = (title, opt, send) => H.form({
    title, intro: opt.intro, submit: opt.submit || 'Xác nhận', danger: !!opt.danger,
    fields: [{ name: 'reason', label: opt.label || 'Lý do', type: 'textarea', required: !opt.optional, rows: 2, placeholder: opt.placeholder || '' }],
    onSubmit: async (v, c) => {
      if (!opt.optional && v.reason.length < 3) { c.setErr('Ghi rõ hơn một chút (ít nhất 3 ký tự).'); return false; }
      await send(v.reason);
      return true;
    },
  });

  // ───────────── Thao tác nhanh ─────────────
  W.claim = async (ctx, j) => { const r = await ctx.api('POST', `/api/hub/jobs/${j.id}/claim`); ARL.toast(`Đã nhận việc ${j.code}.`); return r; };
  W.start = async (ctx, j) => { const r = await ctx.api('POST', `/api/hub/jobs/${j.id}/start`); ARL.toast(`Đã bắt đầu ${j.code}.`); return r; };
  /** Menu chọn người nhận (Lead): người đang trong ca lên trước. */
  W.assignMenu = (ctx, anchor, jobs, members, after) => {
    const list = [...(members || [])].sort((a, b) => (b.on_shift ? 1 : 0) - (a.on_shift ? 1 : 0) || String(a.name).localeCompare(String(b.name), 'vi'));
    const ids = jobs.map((j) => j.id);
    const send = async (uid, name) => {
      if (ids.length === 1) await ctx.api('POST', `/api/hub/jobs/${ids[0]}/assign`, { user_id: uid });
      else await ctx.api('POST', '/api/hub/jobs/bulk-assign', { job_ids: ids, user_id: uid });
      ARL.toast(uid ? `Đã giao ${ids.length > 1 ? `${ids.length} việc` : jobs[0].code} cho ${name}.` : `Đã để ${ids.length > 1 ? `${ids.length} việc` : jobs[0].code} chung cho cả đội.`);
      if (after) after();
    };
    return H.menu(anchor, [
      ...list.map((m) => ({ label: `${m.name}${m.on_shift ? ' · đang trong ca' : ' · ngoài ca'}`, run: () => send(m.id, m.name) })),
      list.length ? '-' : null,
      { label: 'Để chung: hệ thống giao cho người khác đang trong ca', run: () => send(null) },
    ].filter(Boolean));
  };
  /** Nút chính cho một việc trong danh sách (một chạm): nhận / bắt đầu / báo xong / mở phiếu. Không có thì trả về null. */
  W.primary = (ctx, j, after) => {
    if (!OPEN.includes(j.status) || W.inTrip(j)) return null;
    const flow = W.flowOf(ctx, j);
    const inTeam = ctx.role === 'admin' || ctx.team === j.team;
    if (!j.assignee) return inTeam ? H.btn('Nhận việc', async () => { await W.claim(ctx, j); after(); }, 'primary') : null;
    if (j.assignee.id !== ctx.user.id) return null;
    if (flow) return H.link(flow.href, flow.label, { class: 'btn primary' });
    if (j.status === 'open') return H.btn('Bắt đầu', async () => { await W.start(ctx, j); after(); }, 'primary');
    return H.btn('Báo xong…', async () => { const d = await ctx.api('GET', `/api/hub/jobs/${j.id}`); if (await W.done(ctx, d)) after(); }, 'primary');
  };
  /** Một việc trong danh sách dạng thẻ (Việc của tôi, Điều phối, bảng theo trạng thái). opt: { href, action, assignee, check } */
  W.item = (ctx, j, opt = {}) => {
    const due = W.dueOf(j);
    const tone = j.overdue ? 'lost' : j.blocked ? 'wait' : j.priority ? 'wait' : W.inTrip(j) ? 'blue' : null;
    const meta = [j.code, typeLabel(j.type), j.site && j.site.name, j.kit && `Kit ${j.kit.code}`, opt.assignee ? (j.assignee ? j.assignee.name : 'Chưa ai nhận') : null].filter(Boolean);
    const upcoming = j.show_date && j.show_date > H.today();
    return h('div.jobs-item', { 'data-tone': tone, 'data-id': String(j.id) },
      opt.check || null,
      h('a.jobs-item-main', { href: opt.href || `#/jobs/${j.id}` },
        h('span.jobs-item-t', j.priority ? H.pill('Gấp', 'lost') : null, ' ', j.title),
        h('span.jobs-item-m', meta.map((x) => h('span', x)))),
      h('span.jobs-item-r', H.pill(due.text, due.tone), j.blocked ? H.pill('Đang vướng', 'wait') : null, W.inTrip(j) ? H.pill('Trong chuyến FO', 'blue') : j.status === 'doing' && !j.blocked ? H.st('job_st', 'doing') : null, upcoming ? H.pill(`Hiện từ ${H.day(j.show_date)}`, 'off') : null),
      opt.action ? h('span.jobs-item-a', opt.action) : null);
  };
  /** Chữ ký nội dung để cập nhật danh sách tại chỗ (chỉ dựng lại thẻ nào đổi). */
  W.sig = (j) => [j.status, j.title, j.assignee && j.assignee.id, j.due_at, j.blocked, j.priority, j.task_id, j.overdue, W.dueOf(j).text, j.site && j.site.name, j.kit && j.kit.status].join('|');
  /** Cập nhật danh sách theo khoá: giữ nguyên phần tử (và tiêu điểm) của mục không đổi. */
  W.keyed = (box, items, keyOf, sigOf, render) => {
    const old = new Map([...box.children].filter((n) => n.dataset && n.dataset.key).map((n) => [n.dataset.key, n]));
    const next = items.map((it) => {
      const k = String(keyOf(it)), s = sigOf(it), prev = old.get(k);
      if (prev && prev.dataset.sig === s) return prev;
      const n = render(it);
      n.dataset.key = k; n.dataset.sig = s;
      return n;
    });
    // Chỉ chạm DOM khi thứ tự / nội dung đổi.
    const cur = [...box.children];
    if (cur.length === next.length && cur.every((n, i) => n === next[i])) return;
    box.replaceChildren(...next);
  };

  // ───────────── Hộp thoại báo xong theo từng loại việc ─────────────
  /** Danh sách thiết bị của kit để kiểm: bỏ chọn = không đạt (ghi lỗi). Chỉ gửi thiết bị có thay đổi. */
  function devCheck(devs, mode, onChange) {
    const HL = (ARL.hubMeta && ARL.hubMeta.health) || {};
    const rows = (devs || []).map((dv) => {
      const ok0 = dv.cond === 'ok';
      const okBox = h('input', { type: 'checkbox', checked: ok0 });
      const note = h('input', { type: 'text', placeholder: mode === 'repair' ? 'Còn lỗi gì?' : 'Lỗi gì? (ví dụ: không lên nguồn)', 'aria-label': `Lỗi của ${dv.code}`, maxlength: 200, hidden: ok0 });
      const health = h('select', { 'aria-label': `Pin của ${dv.code}` }, h('option', { value: '' }, 'Pin: giữ nguyên'), Object.entries(HL).map(([k, v]) => h('option', { value: k, selected: dv.health === k }, `Pin: ${v}`)));
      const h0 = dv.health || '';
      okBox.addEventListener('change', () => { note.hidden = okBox.checked; if (!okBox.checked) note.focus(); if (onChange) onChange(); });
      const row = h('div.jobs-dev',
        h('label.jobs-dev-ok', okBox, h('span', h('b', dv.code), ' ', h('small', dv.type_name || dv.type)), !ok0 ? H.st('dev_cond', dv.cond) : null, h('em', mode === 'repair' ? 'Tốt' : 'Đạt')),
        health, note);
      return { dv, okBox, note, health, h0, ok0, row };
    });
    return {
      el: rows.length ? h('div.jobs-devs', rows.map((r) => r.row)) : H.note('Kit chưa có thiết bị nào. Gắn thiết bị ở màn hình Kit trước.', 'wait'),
      bad: () => rows.filter((r) => !r.okBox.checked).map((r) => r.dv.code),
      missingNote: () => rows.some((r) => !r.okBox.checked && r.ok0 && !r.note.value.trim()),
      values: () => rows.filter((r) => r.okBox.checked !== r.ok0 || r.health.value !== r.h0).map((r) => {
        const o = { id: r.dv.id };
        if (r.okBox.checked !== r.ok0) o.ok = r.okBox.checked;
        if (!r.okBox.checked && r.note.value.trim()) o.note = r.note.value.trim();
        if (r.health.value && r.health.value !== r.h0) o.health = r.health.value;
        return o;
      }),
    };
  }
  /** Cảnh báo kit chưa đủ thành phần (máy chủ chặn báo đạt / sửa xong khi kit thiếu). */
  function kitGap(ctx, kit) {
    if (!kit || kit.complete) return null;
    const miss = (kit.missing || []).map((t) => CORE_NAME[t] || t);
    const href = ctx.linkTo(`kit:${kit.id}`);
    return h('p.h-note', { 'data-tone': 'wait' }, `Kit ${kit.code} chưa đủ: ${[miss.length ? `thiếu ${miss.join(', ')}` : '', kit.faulty ? `${kit.faulty} thiết bị chưa tốt` : ''].filter(Boolean).join(', ')}. `, href ? H.link(href, 'Mở kit để gắn / gỡ thiết bị') : null);
  }
  /** Ô đếm phụ kiện: keys = loại phụ kiện, exp = số trên sổ, def = số điền sẵn. */
  function accGrid(T, keys, exp, def, info) {
    const rows = keys.map((t) => {
      const name = (T.get(t) || {}).name || t;
      const inp = h('input', { type: 'number', min: 0, max: 99, step: 1, inputmode: 'numeric', value: String(def[t] ?? 0), 'aria-label': `Số ${name}` });
      return { t, inp, row: h('label.jobs-acc-row', h('span', name, h('small', info ? info(t) : `Sổ: ${exp[t] || 0}`)), inp) };
    });
    return {
      el: rows.length ? h('div.jobs-acc', rows.map((r) => r.row)) : h('p.sub', 'Không có phụ kiện nào trong danh mục.'),
      bad: () => rows.find((r) => !/^\d{1,2}$/.test(String(r.inp.value).trim())),
      values: () => Object.fromEntries(rows.map((r) => [r.t, parseInt(r.inp.value, 10) || 0])),
    };
  }
  const accKeys = (d, kit) => [...new Set([...(d.acc_types || []).map((t) => t.id), ...Object.keys((kit && kit.acc) || {})])];
  const listCodes = (arr) => h('div.jobs-codes', arr.map((c) => h('code', c)));

  const DONE = {
    check_kit: (ctx, d) => kitCheck(ctx, d, 'check'),
    checkin: (ctx, d) => kitCheck(ctx, d, 'checkin'),
    repair(ctx, d) {
      const kit = d.kit;
      if (!kit) return noKit();
      const devs = devCheck(kit.devices, 'repair');
      const cause = fld({ name: 'cause', label: 'Nguyên nhân hỏng', placeholder: 'Ví dụ: hỏng nguồn, cáp lỏng', hint: 'Dùng cho thống kê lỗi.' });
      cause.input.maxLength = 80;
      const note = fld({ name: 'note', label: 'Đã sửa gì', type: 'textarea', rows: 2 });
      return {
        title: `Sửa xong kit ${kit.code}`, submit: 'Báo sửa xong', wide: true,
        body: [h('p.sub', 'Đánh dấu "Tốt" cho thiết bị đã sửa. Thiết bị không sửa được thì gỡ khỏi kit và gắn thiết bị thay ở màn hình Kit. Báo xong thì hệ thống tạo việc cho Logistics nhận lại kit.'), kit.fault ? H.note(`Lỗi đã báo: ${kit.fault}`, 'lost') : null, devs.el, kitGap(ctx, kit), h('div.h-fields', cause.el, note.el)],
        collect: () => ({ devices: devs.values(), cause: cause.get(), note: note.get() }),
      };
    },
    deliver(ctx, d) {
      const kits = (d.kits || []).filter((k) => ['reserved', 'delivering'].includes(k.status));
      const held = !!d.held;
      const cpk = (ARL.hubMeta && ARL.hubMeta.cfg && ARL.hubMeta.cfg.cardsPerKit) || 2;
      const doc = fld({ name: 'doc', label: 'Mã biên bản bàn giao', required: !held, placeholder: 'Ví dụ: BB-0123', hint: held ? 'Không bắt buộc khi chốt sau đối chiếu.' : 'Biên bản 2 bản, BO giữ 1 bản.' });
      doc.input.maxLength = 40;
      const boxes = kits.map((k) => ({ k, box: h('input', { type: 'checkbox', checked: true, 'aria-label': `Đã giao kit ${k.code}` }) }));
      const cards = fld({ name: 'cards', label: 'Thẻ để sẵn trong kit (mã thẻ)', type: 'codes', rows: 2, placeholder: 'Quét hoặc gõ mã, cách nhau bởi dấu cách', hint: `Cần ${cpk} thẻ mỗi kit. Thiếu mã thì hệ thống đưa vào Đối chiếu để ghi sau.` });
      const office = d.cards_office || [];
      const fill = office.length ? H.btn(`Điền thẻ sẵn sàng tại VP`, () => { cards.input.value = office.slice(0, boxes.filter((x) => x.box.checked).length * cpk).join(' '); }, 'ghost small') : null;
      return {
        title: 'Xác nhận đã giao và setup tại BO', submit: 'Xác nhận đã giao', wide: true,
        body: [h('p.sub', held ? 'Chốt theo số thực tế sau đối chiếu: chỉ chọn kit và thẻ BO thật sự đã nhận. Kit chưa giao vẫn chờ giao ở việc mới.' : `Logistics tự giao (không qua chuyến FO). Kit chuyển sang "Đang quay tại BO", BO bắt đầu ghi hình. Kit chưa giao được thì bỏ chọn; hệ thống tạo việc giao phần còn lại.`),
          kits.length ? h('div.h-field', h('span', `Kit đã giao (${kits.length} kit chờ giao)`), h('div.jobs-checks', boxes.map((x) => h('label', x.box, h('code', x.k.code))))) : H.note('Không còn kit nào chờ giao cho yêu cầu này.', 'wait'),
          cards.el, fill ? h('div.h-row', fill) : null, doc.el],
        collect: (setErr) => {
          if (!held && !doc.get()) { setErr('Cần nhập mã biên bản bàn giao (2 bản, BO giữ 1 bản).'); doc.input.focus(); return false; }
          const got = boxes.filter((x) => x.box.checked).map((x) => x.k.id);
          if (boxes.length && !got.length) { setErr('Chọn ít nhất một kit đã giao.'); return false; }
          const res = { cards_out: codesOf(cards.input.value) };
          if (doc.get()) res.doc_code = doc.get();
          if (got.length !== boxes.length) res.kit_ids = got;
          return res;
        },
      };
    },
    card_swap(ctx, d) {
      const cpk = (ARL.hubMeta && ARL.hubMeta.cfg && ARL.hubMeta.cfg.cardsPerKit) || 2;
      const nKits = (d.kits || []).length, need = nKits * cpk;
      const atBo = d.cards_at_bo || [], office = (d.cards_office || []).filter((c) => !atBo.includes(c));
      const out = fld({ name: 'out', label: 'Thẻ mới để lại BO (mã thẻ)', type: 'codes', rows: 2, placeholder: 'Quét hoặc gõ mã, cách nhau bởi dấu cách', hint: `Cần ${need} thẻ (${nKits} kit × ${cpk} thẻ).` });
      const cntOut = fld({ name: 'cnt_out', label: 'Thẻ không đọc được mã: số thẻ đã để lại', type: 'number', min: 0, max: 999, hint: 'Chỉ nhập khi không ghi được mã. Hệ thống đưa vào Đối chiếu để ghi mã sau.' });
      const suggest = office.length ? H.btn(`Điền ${Math.min(need || cpk, office.length)} thẻ sẵn sàng tại VP`, () => { out.input.value = office.slice(0, need || cpk).join(' '); }, 'ghost small') : null;
      const boxes = atBo.map((c) => ({ c, box: h('input', { type: 'checkbox', checked: true, 'aria-label': `Đã thu thẻ ${c}` }) }));
      const cnt = fld({ name: 'cnt', label: 'Số thẻ thực thu (chỉ nhập khi khác hệ thống)', type: 'number', min: 0, max: 999, hint: 'Khác số hệ thống thì đưa vào Đối chiếu để kiểm lại.' });
      return {
        title: 'Xác nhận đã đổi thẻ', submit: 'Xác nhận đã đổi', wide: true,
        body: [h('p.sub', `Thẻ mới sang "Đang ở BO"; thẻ cũ thu về VP chờ gửi Tech.`), out.el, suggest ? h('div.h-row', suggest) : null,
          h('div.h-field', h('span', `Thẻ thu về (${atBo.length} thẻ hệ thống ghi đang ở BO)`), atBo.length ? [h('div.jobs-checks', boxes.map((x) => h('label', x.box, h('code', x.c)))), h('small', 'Bỏ chọn thẻ không thu được: thẻ đó vẫn ghi ở BO và vào mục Đối chiếu để Logistics kiểm lại.')] : h('small', 'Hệ thống không ghi thẻ nào đang ở BO.')),
          cnt.el, nKits ? cntOut.el : null],
        collect: (setErr) => {
          const res = { cards_out: codesOf(out.input.value) };
          if (nKits && cntOut.get() !== '') { const n = Number(cntOut.get()); if (!Number.isInteger(n) || n < 0) { setErr('Số thẻ đã để lại phải là số nguyên.'); return false; } res.count_out = n; }
          if (nKits && !res.cards_out.length && res.count_out === undefined) { setErr('Nhập mã thẻ mới đã để lại BO (hoặc số thẻ nếu không đọc được mã).'); out.input.focus(); return false; }
          const picked = boxes.filter((x) => x.box.checked).map((x) => x.c);
          if (boxes.length && !picked.length) { setErr('Chọn thẻ đã thu về. Thu ít hơn hệ thống thì ghi số ở ô "Số thẻ thực thu".'); return false; }
          if (boxes.length && picked.length !== boxes.length) res.cards_in = picked;
          if (cnt.get() !== '') { const n = Number(cnt.get()); if (!Number.isInteger(n) || n < 0) { setErr('Số thẻ thực thu phải là số nguyên.'); return false; } res.count_in = n; }
          return res;
        },
      };
    },
    async swap_faulty(ctx, d) {
      const T = await W.types(ctx);
      const kit = d.kit, reps = d.replacements || [];
      const sel = fld({ name: 'kit', label: 'Kit thay thế (cùng loại, đang sẵn sàng tại VP)', type: 'select', required: true, empty: reps.length ? '— Chọn kit —' : 'Chưa có kit sẵn sàng cùng loại', options: reps.map((k) => [k.id, k.code]) });
      // Kit hỏng mang về: đếm phụ kiện thực nhận ngay lúc đổi (mặc định theo sổ), thiếu thì hệ thống ghi mất và đưa vào Đối chiếu.
      const g = kit ? accGrid(T, accKeys(d, kit), kit.acc || {}, kit.acc || {}) : null;
      return {
        title: `Đổi kit hỏng${kit ? ' ' + kit.code : ''}`, submit: 'Xác nhận đã đổi', wide: !!g,
        body: [h('p.sub', 'Kit thay sang BO; kit hỏng về Tech sửa (tự sinh việc sửa). CM5 / iPhone đổi mã thì tự sinh việc đổi QR cho Tech.'), kit && kit.fault ? H.note(`Lỗi: ${kit.fault}`, 'lost') : null, sel.el, reps.length ? null : H.note('Chuẩn bị một kit cùng loại (gửi Tech kiểm đạt) ở màn hình Kit rồi quay lại.', 'wait'),
          g ? h('details', h('summary', `Đếm phụ kiện của kit hỏng ${kit.code} mang về (mặc định theo sổ)`), h('p.sub', 'Thiếu so với sổ thì hệ thống trừ tổng kho và đưa vào Đối chiếu để làm việc với BO.'), g.el) : null],
        collect: (setErr) => {
          if (!sel.get()) { setErr('Chọn kit thay thế.'); return false; }
          if (g && g.bad()) { setErr('Số phụ kiện là số nguyên từ 0 đến 99.'); return false; }
          return { new_kit_id: Number(sel.get()), ...(g ? { acc: g.values() } : {}) };
        },
      };
    },
    async recover(ctx, d) {
      const T = await W.types(ctx);
      const kits = d.kits || [];
      const rows = kits.map((k) => {
        const box = h('input', { type: 'checkbox', checked: true });
        const g = accGrid(T, accKeys(d, k), k.acc || {}, k.acc || {});
        return { k, box, g, el: h('div.jobs-rk', h('label.jobs-rk-h', box, h('b', `Kit ${k.code}`), h('small', k.kind_label || '')), h('details', h('summary', 'Đếm phụ kiện thực nhận (mặc định theo sổ)'), g.el)) };
      });
      return {
        title: 'Xác nhận đã thu hồi', submit: 'Xác nhận đã thu', wide: true,
        body: [h('p.sub', 'Logistics tự thu và nhận về kho ngay: kit có lỗi sang Tech sửa, kit không lỗi chờ Tech check-in. Kit chưa thu được thì bỏ chọn; hệ thống tạo việc thu hồi phần còn lại. Thẻ đang ở BO cũng được thu về.'),
          rows.length ? h('div.jobs-stack', rows.map((r) => r.el)) : H.note('BO không còn kit nào đang quay.', 'wait')],
        collect: (setErr) => {
          if (!rows.length) return {};
          const got = rows.filter((r) => r.box.checked);
          if (!got.length) { setErr('Chọn ít nhất một kit đã thu.'); return false; }
          if (got.some((r) => r.g.bad())) { setErr('Số phụ kiện là số nguyên từ 0 đến 99.'); return false; }
          return { kit_ids: got.map((r) => r.k.id), acc_by_kit: Object.fromEntries(got.map((r) => [r.k.id, r.g.values()])) };
        },
      };
    },
    async receive_field(ctx, d) {
      const T = await W.types(ctx);
      const kit = d.kit;
      if (!kit) return noKit();
      const g = accGrid(T, accKeys(d, kit), kit.acc || {}, kit.acc || {});
      const faulty = !!kit.fault || (kit.devices || []).some((x) => x.cond !== 'ok');
      return {
        title: `Nhận kit ${kit.code} về kho`, submit: 'Xác nhận đã nhận', wide: true,
        body: [h('p.sub', 'Đếm phụ kiện thực nhận. Thiếu so với sổ thì hệ thống trừ tổng kho và đưa vào Đối chiếu để làm việc với BO.'), H.note(faulty ? 'Kit đang có lỗi: nhận xong sẽ chuyển Tech sửa.' : 'Nhận xong, kit chờ Tech check-in.', faulty ? 'wait' : null), g.el],
        collect: (setErr) => { if (g.bad()) { setErr('Số phụ kiện là số nguyên từ 0 đến 99.'); return false; } return { acc: g.values() }; },
      };
    },
    async deliver_acc(ctx, d) {
      const T = await W.types(ctx);
      const need = d.acc_need || {}, free = d.acc_free || {};
      const g = accGrid(T, Object.keys(need), need, need, (t) => `Cần ${need[t] || 0} · kho rảnh ${free[t] ?? '–'}`);
      const short = Object.keys(need).filter((t) => (free[t] ?? 0) < need[t]);
      return {
        title: 'Xác nhận đã giao phụ kiện', submit: 'Xác nhận đã giao',
        body: [h('p.sub', `Phụ kiện lấy từ số rảnh trong kho và cộng vào kit${d.kit ? ' ' + d.kit.code : ''} tại BO. Giao ít hơn số cần thì yêu cầu của Sale vẫn mở và hệ thống tạo việc giao phần còn lại.`), short.length ? H.note(`Kho không đủ ${short.map((t) => (T.get(t) || {}).name || t).join(', ')}. Ghi "Nhập thêm" ở mục Phụ kiện nếu thực tế có.`, 'wait') : null, g.el],
        collect: (setErr) => {
          if (g.bad()) { setErr('Số phụ kiện là số nguyên từ 0 đến 99.'); return false; }
          const v = Object.fromEntries(Object.entries(g.values()).filter(([, n]) => n > 0));
          if (!Object.keys(v).length) { setErr('Nhập số phụ kiện đã giao.'); return false; }
          return { acc: v };
        },
      };
    },
    stock_check() {
      const note = fld({ name: 'note', label: 'Ghi chú', type: 'textarea', rows: 2 });
      const diff = fld({ name: 'diff', label: 'Chênh lệch (nếu có)', type: 'textarea', rows: 2, placeholder: 'Ví dụ: thiếu 1 hub sạc ở kệ B', hint: 'Có chênh lệch thì hệ thống đưa vào Đối chiếu cho Logistic Lead, không tự sửa số.' });
      return { title: 'Báo xong kiểm kho', submit: 'Báo xong', body: [h('p.sub', 'Đếm kit và phụ kiện trong kho so với hệ thống.'), note.el, diff.el], collect: () => ({ note: note.get(), diff: diff.get() }) };
    },
    qr_change() {
      const note = fld({ name: 'note', label: 'Ghi chú', type: 'textarea', rows: 2, placeholder: 'Ví dụ: đã dán QR mới cho kit thay' });
      return { title: 'Báo xong đổi QR', submit: 'Báo xong', body: [note.el], collect: () => ({ note: note.get() }) };
    },
    manual(ctx, d) {
      const note = fld({ name: 'note', label: 'Kết quả', type: 'textarea', rows: 3, placeholder: 'Đã làm gì (không bắt buộc)' });
      return { title: `Báo xong: ${d.job.title}`, submit: 'Báo xong', body: [note.el], collect: () => ({ note: note.get() }) };
    },
    incident(ctx, d) {
      const inc = d.incident, RES = (ARL.hubMeta && ARL.hubMeta.incident_res) || {};
      const res = fld({ name: 'res', label: 'Cách xử lý', type: 'select', required: true, empty: '— Chọn —', options: Object.entries(RES) });
      const note = fld({ name: 'note', label: 'Đã xử lý thế nào', type: 'textarea', rows: 2, hint: 'Bắt buộc, trừ khi "Không phải sự cố".' });
      const devs = (d.kit && d.kit.devices) || [];
      const dev = devs.length ? fld({ name: 'dev', label: 'Thiết bị lỗi (nếu biết)', type: 'select', empty: '— Không chọn —', options: devs.map((x) => [x.id, `${x.code} · ${x.type_name}`]) }) : null;
      return {
        title: inc ? `Xử lý sự cố ${inc.code}` : 'Xử lý sự cố', submit: 'Báo xử lý xong',
        body: [inc ? H.note(`${inc.label}: ${inc.text}`, 'wait') : null, h('p.sub', 'Đổi máy hoặc mang về sửa: hệ thống tự báo hỏng kit và tạo việc đổi kit cho Logistics.'),
          inc && inc.kit && inc.kit.away ? H.note(`Kit ${inc.kit.code} đã rời BO của sự cố: chọn đổi máy hoặc mang về sửa thì hệ thống không đổi kit, chỉ đưa vào Đối chiếu cho Tech Lead xem lại.`, 'wait') : null,
          h('div.h-fields', res.el, dev ? dev.el : null), note.el],
        collect: (setErr) => {
          if (!res.get()) { setErr('Chọn cách xử lý.'); return false; }
          if (res.get() !== 'invalid' && note.get().length < 3) { setErr('Cần ghi ngắn đã xử lý thế nào.'); note.input.focus(); return false; }
          return { resolution: res.get(), note: note.get(), device_id: dev && dev.get() ? Number(dev.get()) : undefined };
        },
      };
    },
    prep_kit(ctx, d) {
      const kits = (d.request && d.request.kits) || [];
      return { title: 'Báo xong chuẩn bị kit', submit: 'Báo xong', body: [H.note('Việc này thường tự đóng khi mọi kit của yêu cầu đã được Tech kiểm đạt. Chỉ báo xong khi đã gán và chuẩn bị đủ kit.'), kits.length ? h('div', h('b', 'Kit đã gán: '), listCodes(kits.map((k) => k.code))) : H.note('Chưa gán kit nào cho yêu cầu.', 'wait')], collect: () => ({}) };
    },
    receive_back(ctx, d) {
      const kit = d.kit;
      return { title: `Nhận lại kit${kit ? ' ' + kit.code : ''} từ Tech`, submit: 'Xác nhận đã nhận', body: [h('p.sub', 'Kit đủ thành phần thì về "Sẵn sàng" (hoặc giữ cho yêu cầu đã gán). Kit thiếu thì về "Đang chuẩn bị" để bổ sung rồi gửi kiểm lại.'), kitGap(ctx, kit)], collect: () => ({}) };
    },
  };
  function noKit() { return { title: 'Báo xong', body: [H.note('Việc này không gắn với kit nào.', 'lost')], collect: () => ({}) }; }
  function kitCheck(ctx, d, mode) {
    const kit = d.kit;
    if (!kit) return noKit();
    let pass = 'pass';
    const seg = H.seg([['pass', 'Đạt'], ['fail', 'Không đạt']], 'pass', (k) => { pass = k; });
    const devs = devCheck(kit.devices, 'check', () => { if (devs.bad().length && pass !== 'fail') { pass = 'fail'; seg.set('fail'); } });
    const note = fld({ name: 'note', label: 'Ghi chú', type: 'textarea', rows: 2, placeholder: 'Không đạt thì ghi lỗi chung của kit' });
    return {
      title: mode === 'check' ? `Kiểm kit ${kit.code}` : `Check-in kit ${kit.code}`, submit: 'Gửi kết quả', wide: true,
      body: [
        h('div.h-row.jobs-result', h('b', 'Kết quả'), seg),
        h('p.sub', mode === 'check' ? 'Bỏ chọn thiết bị không đạt và ghi lỗi. Đạt: kit sẵn sàng xuất. Không đạt: cả kit sang Tech sửa (tự sinh việc sửa).' : 'Kiểm từng thiết bị của kit thu hồi. Đạt: tự sinh việc cho Logistics nhận lại kit. Không đạt: tự sinh việc sửa.'),
        devs.el, kitGap(ctx, kit), note.el,
      ],
      collect: (setErr) => {
        const bad = devs.bad(), ok = pass === 'pass' && !bad.length;
        if (!ok && !bad.length && note.get().length < 3) { setErr('Không đạt: ghi lỗi ở ô ghi chú, hoặc bỏ chọn thiết bị không đạt.'); note.input.focus(); return false; }
        if (devs.missingNote() && note.get().length < 3) { setErr('Ghi lỗi của thiết bị không đạt (ô cạnh thiết bị hoặc ô ghi chú).'); return false; }
        return { pass: ok, devices: devs.values(), note: note.get() };
      },
    };
  }

  /** Mở hộp thoại báo xong cho chi tiết việc d (GET /api/hub/jobs/:id). Trả về true khi đã báo xong. */
  W.done = async (ctx, d) => {
    const j = d.job;
    const flow = W.flowOf(ctx, j);
    if (flow) { location.hash = flow.href; return false; }
    const make = DONE[j.type] || DONE.manual;
    const spec = await make(ctx, d);
    const credit = ctx.isLead(j.team) && j.assignee && j.assignee.id !== ctx.user.id ? fld({ name: 'credit', type: 'checkbox', label: `Tính điểm cho ${j.assignee.name} (người đang giữ việc)`, value: true }) : null;
    const body = h('div.h-form.jobs-done', h('p.jobs-done-of', `${j.code} · ${j.title}${j.site ? ' · ' + j.site.name : ''}`), spec.body, credit ? credit.el : null);
    const r = await W.dialog({
      title: spec.title || 'Báo xong', body, submit: spec.submit || 'Báo xong', wide: !!spec.wide,
      run: async ({ setErr }) => {
        const result = spec.collect(setErr);
        if (result === false) return false;
        const out = await ctx.api('POST', `/api/hub/jobs/${j.id}/done`, W.clean({ result, credit_assignee: credit ? credit.get() : undefined }));
        return out;
      },
    });
    if (r) ARL.toast(`Đã báo xong ${j.code}. Hệ thống tự cập nhật kit / thẻ và tạo việc kế tiếp nếu có.`);
    return !!r;
  };

  // ───────────── Tạo việc giao tay, sửa việc ─────────────
  /** Tạo việc giao tay (POST /api/hub/jobs). Ai trong Tech / Logistics cũng tạo được cho team mình; Lead giao được cho người khác. */
  W.create = async (ctx, opt = {}) => {
    const admin = ctx.role === 'admin';
    const myTeam = ctx.team === 'tech' || ctx.team === 'logistics' ? ctx.team : null;
    const teams = admin ? ['logistics', 'tech'] : myTeam ? [myTeam] : [];
    if (!teams.length) return null;
    const lead = admin || ctx.isLead(myTeam);
    let members = [], outlets = [];
    const [rs, os] = await Promise.all([
      lead ? Promise.all(teams.map((t) => ctx.api('GET', '/api/hub/roster', null, admin ? { team: t } : {}).then((r) => r.users.map((u) => ({ ...u, team: t }))).catch(() => []))) : Promise.resolve([]),
      ctx.api('GET', '/api/hub/outlets').then((r) => r.outlets).catch(() => []),
    ]);
    members = rs.flat(); outlets = os;
    const team = admin ? fld({ name: 'team', label: 'Team', type: 'select', value: opt.team && teams.includes(opt.team) ? opt.team : teams[0], options: teams.map((t) => [t, teamLabel(t)]) }) : null;
    const title = fld({ name: 'title', label: 'Tên việc', required: true, placeholder: 'Ví dụ: Sắp xếp kệ phụ kiện', full: true });
    title.input.maxLength = 160;
    const who = lead ? fld({ name: 'who', label: 'Người làm', type: 'select', value: '', options: [['', 'Để chung: hệ thống giao cho người trong ca'], ['me', 'Tôi tự làm']] }) : fld({ name: 'self', label: 'Tôi tự làm việc này', type: 'checkbox', value: true, hint: 'Bỏ chọn: hệ thống giao cho người đang trong ca, ít việc nhất.' });
    const fillWho = () => {
      if (!lead) return;
      const t = team ? team.get() : myTeam;
      const keep = who.input.value;
      who.input.replaceChildren(h('option', { value: '' }, 'Để chung: hệ thống giao cho người trong ca'), h('option', { value: 'me' }, 'Tôi tự làm'),
        ...members.filter((m) => m.team === t && m.id !== ctx.user.id).map((m) => h('option', { value: String(m.id) }, `${m.name} · ${m.role_label || ''}`)));
      who.input.value = [...who.input.options].some((o) => o.value === keep) ? keep : '';
      if (admin) who.input.querySelector('option[value="me"]').hidden = true; // Quản trị không thuộc team nào: giao cho người trong team
    };
    fillWho();
    if (team) team.input.addEventListener('change', fillWho);
    const listId = 'bo-' + Math.random().toString(36).slice(2, 8);
    const site = fld({ name: 'site', label: 'BO (nếu có)', placeholder: 'Gõ tên BO', list: listId, hint: 'Việc ngoài hiện trường cần BO để đưa vào chuyến FO.' });
    const dl = h('datalist', { id: listId }, outlets.map((o) => h('option', { value: o.code ? `${o.name} (${o.code})` : o.name })));
    const due = fld({ name: 'due', label: 'Hạn (giờ kể từ bây giờ)', type: 'number', value: 24, min: 1, max: 720, step: 1 });
    const pri = fld({ name: 'pri', label: 'Việc gấp', type: 'checkbox', value: false });
    const std = lead ? fld({ name: 'std', label: 'Phút chuẩn (tính điểm khối lượng)', type: 'number', min: 0, max: 480, step: 1, hint: 'Bỏ trống: theo định mức việc giao tay trong Cài đặt.' }) : null;
    const note = fld({ name: 'note', label: 'Ghi chú', type: 'textarea', rows: 2 });
    const body = h('div.h-form', h('div.h-fields', title.el, team ? team.el : null, who.el, site.el, due.el, std ? std.el : null, pri.el, note.el), dl);
    const rk = ARL.reqKey(); // một khoá cho lần mở này: gửi lại sau khi mất mạng không tạo việc thứ hai
    const r = await W.dialog({
      title: 'Tạo việc giao tay', body, submit: 'Tạo việc',
      run: async ({ setErr }) => {
        if (title.get().length < 3) { setErr('Cần nhập tên việc.'); title.input.focus(); return false; }
        const hours = Number(due.get());
        if (!Number.isInteger(hours) || hours < 1 || hours > 720) { setErr('Hạn từ 1 giờ đến 30 ngày (720 giờ).'); return false; }
        let siteId;
        if (site.get()) {
          const o = outlets.find((x) => (x.code ? `${x.name} (${x.code})` : x.name) === site.get()) || outlets.find((x) => H.fold(x.name) === H.fold(site.get()));
          if (!o) { setErr('Chọn BO trong danh sách gợi ý (hoặc để trống).'); site.input.focus(); return false; }
          siteId = o.id;
        }
        const body2 = { title: title.get(), team: team ? team.get() : undefined, site_id: siteId, due_hours: hours, priority: pri.get() || undefined, note: note.get() || undefined, req_key: rk };
        if (lead) { if (who.get()) body2.assignee_id = who.get() === 'me' ? 'me' : Number(who.get()); }
        else body2.self = who.get() || undefined;
        if (std && std.get() !== '') body2.std_min = Number(std.get());
        return ctx.api('POST', '/api/hub/jobs', W.clean(body2));
      },
    });
    if (!r) return null;
    ARL.toast(`Đã tạo việc ${r.job.code}${r.job.assignee ? `, giao cho ${r.job.assignee.name}` : ', chờ người trong ca nhận'}.`);
    return r.job;
  };
  /** Lead sửa việc: tên, gấp, dời hạn (bắt buộc lý do), ghi chú. Người giữ việc chỉ sửa ghi chú. */
  W.edit = async (ctx, j) => {
    const lead = ctx.isLead(j.team);
    const title = lead ? fld({ name: 'title', label: 'Tên việc', value: j.title, required: true, full: true }) : null;
    const pri = lead ? fld({ name: 'pri', label: 'Việc gấp', type: 'checkbox', value: !!j.priority }) : null;
    const due = lead ? fld({ name: 'due', label: 'Dời hạn: còn bao nhiêu giờ', type: 'number', min: 1, max: 720, step: 1, hint: 'Bỏ trống nếu giữ hạn cũ.' }) : null;
    const why = lead ? fld({ name: 'why', label: 'Lý do dời hạn', type: 'text', hint: 'Bắt buộc khi dời hạn.' }) : null;
    const note = fld({ name: 'note', label: 'Ghi chú', type: 'textarea', rows: 3, value: j.note || '' });
    const body = h('div.h-form', h('div.h-fields', title ? title.el : null, pri ? pri.el : null, due ? due.el : null, why ? why.el : null, note.el));
    const r = await W.dialog({
      title: lead ? `Sửa việc ${j.code}` : `Ghi chú cho ${j.code}`, body, submit: 'Lưu',
      run: async ({ setErr }) => {
        const p = {};
        if (note.get() !== (j.note || '')) p.note = note.get();
        if (lead) {
          if (title.get() !== j.title) { if (title.get().length < 3) { setErr('Tên việc quá ngắn.'); return false; } p.title = title.get(); }
          if (pri.get() !== !!j.priority) p.priority = pri.get();
          if (due.get() !== '') {
            const n = Number(due.get());
            if (!Number.isInteger(n) || n < 1 || n > 720) { setErr('Hạn từ 1 giờ đến 30 ngày (720 giờ).'); return false; }
            if (why.get().length < 3) { setErr('Cần ghi lý do dời hạn.'); why.input.focus(); return false; }
            p.due_hours = n; p.reason = why.get();
          }
        }
        if (!Object.keys(p).length) return true;
        return ctx.api('PATCH', `/api/hub/jobs/${j.id}`, p);
      },
    });
    if (r && r !== true) ARL.toast(`Đã lưu ${j.code}.`);
    return !!r;
  };

  // ───────────── Khung chi tiết việc (bảng trượt bên phải; điện thoại: toàn màn hình) ─────────────
  /**
   * W.panel(ctx, { onClose, onChanged }) → { open(id), hide(), refresh(), id }.
   * Đặt trong khung màn hình nên tự gỡ khi rời màn hình. Không phải <dialog> nên cập nhật trực tiếp vẫn chạy khi đang mở.
   */
  W.panel = (ctx, opt = {}) => {
    const titleId = 'jp-' + Math.random().toString(36).slice(2, 8);
    const scrim = h('div.jobs-scrim', { hidden: true, onclick: () => close() });
    const head = h('div.jobs-phead');
    const body = h('div.jobs-pbody');
    const box = h('aside.jobs-panel', { hidden: true, role: 'dialog', 'aria-labelledby': titleId, tabindex: '-1' }, head, body);
    ctx.el.append(scrim, box);
    let id = null, gen = 0, back = null;
    const close = () => (opt.onClose ? opt.onClose() : api.hide());
    const onKey = (e) => { if (e.key === 'Escape' && id && !document.querySelector('dialog.dlg[open], .h-pop')) { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey);
    ctx.onCleanup(() => document.removeEventListener('keydown', onKey));
    const closeBtn = () => h('button.ghost.jobs-px', { type: 'button', onclick: close, 'aria-label': 'Đóng chi tiết việc' }, 'Đóng');
    const changed = () => { load(false); if (opt.onChanged) opt.onChanged(); };
    async function load(first) {
      const my = ++gen, want = id;
      try {
        const d = await ctx.api('GET', `/api/hub/jobs/${encodeURIComponent(want)}`);
        if (my !== gen || id !== want || !ctx.alive()) return;
        const top = body.scrollTop;
        const parts = detail(ctx, d, changed);
        head.replaceChildren(h('div.jobs-phead-l', h('small', [d.job.code, typeLabel(d.job.type), teamLabel(d.job.team)].filter(Boolean).join(' · ')), h('h2', { id: titleId }, d.job.title)), parts.more || '', closeBtn());
        body.replaceChildren(...parts);
        if (first) { body.scrollTop = 0; box.focus({ preventScroll: true }); } else body.scrollTop = top;
      } catch (e) {
        if (my !== gen || id !== want) return;
        if (first || e.status === 404) { head.replaceChildren(h('div.jobs-phead-l', h('h2', { id: titleId }, 'Chi tiết việc')), closeBtn()); body.replaceChildren(H.error(e, () => load(true))); }
        else console.error(e);
      }
    }
    const api = {
      open(newId) {
        if (id !== null && String(newId) === String(id)) return load(false);
        if (id === null) back = document.activeElement;
        id = String(newId);
        box.hidden = false; scrim.hidden = false;
        document.documentElement.classList.add('jobs-locked');
        head.replaceChildren(h('div.jobs-phead-l', h('h2', { id: titleId }, 'Đang tải…')), closeBtn());
        body.replaceChildren(H.loading(6));
        return load(true);
      },
      hide() {
        if (id === null) return;
        id = null; gen++;
        box.hidden = true; scrim.hidden = true;
        document.documentElement.classList.remove('jobs-locked');
        if (back && back.isConnected) back.focus({ preventScroll: true });
        back = null;
      },
      refresh() { if (id !== null) return load(false); return null; },
      get id() { return id; },
    };
    ctx.onCleanup(() => document.documentElement.classList.remove('jobs-locked'));
    return api;
  };

  /** Nội dung chi tiết việc: trạng thái, thao tác đúng vai trò, thông tin, kit, kết quả, nhật ký. */
  function detail(ctx, d, changed) {
    const j = d.job, open = OPEN.includes(j.status);
    const due = W.dueOf(j);
    const task = d.task && TASK_OPEN.includes(d.task.status) ? d.task : null;
    const pills = h('div.jobs-pills', H.st('job_st', j.status), j.priority ? H.pill('Gấp', 'lost') : null, j.blocked ? H.pill('Đang vướng', 'wait') : null, task ? H.pill('Trong chuyến FO', 'blue') : null,
      open && !j.assignee ? H.pill('Chưa ai nhận', 'wait') : null, H.pill(due.text, due.tone));
    const out = [pills];
    if (d.held && open) out.push(h('div.h-note', { 'data-tone': 'wait' }, h('p', h('b', 'Chờ đối chiếu: '), 'số giao nhận ở chuyến FO khác kế hoạch nên hệ thống chưa ghi chuyển kit / thẻ. Logistic Lead đối chiếu với FO và BO rồi làm tay việc này theo mã thực tế.'),
      ctx.linkTo(`recon:${d.held.id}`) ? H.link(ctx.linkTo(`recon:${d.held.id}`), 'Mở dòng Đối chiếu', { class: 'btn small ghost' }) : null));
    if (task) {
      const live = ctx.can(LOGI);
      out.push(h('div.h-note.jobs-trip', { 'data-tone': null },
        h('p', `Việc nằm trong chuyến ${task.code}${task.fo ? ` của FO ${task.fo}` : ''} (${(ARL.TASK_ST && ARL.TASK_ST[task.status]) || task.status}). Hệ thống tự đóng việc khi FO giao nhận xong và BO xác nhận.`),
        live ? h('div.h-row',
          task.status === 'in_progress' ? h('small.h-muted', 'Chuyến đã bắt đầu nên không gỡ việc được. Không làm được thì FO bấm "Không giao được" ở điểm đó, hoặc huỷ chuyến trên Rider Live.')
            : H.btn('Gỡ khỏi chuyến', async () => {
              if (!(await H.confirm(`Gỡ ${j.code} khỏi chuyến ${task.code}? Kit / thẻ của việc này trở về kho, việc trở lại chờ làm.`, 'Gỡ khỏi chuyến', true))) return;
              await ctx.api('POST', `/api/hub/jobs/${j.id}/untrip`);
              ARL.toast(`Đã gỡ ${j.code} khỏi chuyến ${task.code}.`);
              changed();
            }, 'small'),
          H.link('#/live', 'Xem trên Rider Live', { class: 'btn small ghost' })) : null));
    }
    if (j.blocked && open) {
      out.push(h('div.h-note.jobs-blocked', { 'data-tone': 'wait' }, h('p', h('b', 'Đang vướng: '), j.blocked, h('small', ` · từ ${H.when(j.blocked_at)}. Hạn tạm dừng trong lúc vướng.`)),
        d.can_block ? H.btn('Gỡ vướng', async () => {
          const ok = await W.askReason('Gỡ vướng', { intro: 'Việc làm tiếp được. Hạn được cộng thêm thời gian đã vướng.', label: 'Ghi chú (không bắt buộc)', optional: true, submit: 'Gỡ vướng' }, (note) => ctx.api('POST', `/api/hub/jobs/${j.id}/unblock`, W.clean({ note })));
          if (ok) { ARL.toast('Đã gỡ vướng.'); changed(); }
        }, 'small') : null));
    }
    const acts = actionsOf(ctx, d, task, changed);
    if (acts && acts.el) out.push(acts.el);
    if (acts && acts.more) out.more = acts.more; // menu "⋯" nằm trên đầu khung, cạnh nút Đóng
    const flow = open ? W.flowOf(ctx, j) : null;
    if (flow) out.push(H.note(flow.hint));
    // Thông tin
    const site = d.site;
    const rows = [
      ['Loại việc', [typeLabel(j.type), teamLabel(j.team)].filter(Boolean).join(' · ')],
      ['BO', site ? h('span', linkOr(ctx.linkTo(`outlet:${site.id}`), site.name), site.address ? h('small', site.address) : null) : null],
      ['Liên hệ', site && (site.contact || site.phone) ? h('span', site.contact || '', site.contact && site.phone ? ' · ' : '', site.phone ? H.link(`tel:${site.phone}`, site.phone) : null) : null],
      ['Khung giờ ở BO', site && site.swap_from && W.FIELD_TYPES.includes(j.type) ? `${site.swap_from}–${site.swap_to || ''}` : null],
      ['Kit', d.kit ? h('span.h-row', linkOr(ctx.linkTo(`kit:${d.kit.id}`), d.kit.code), H.st('kit_st', d.kit.status)) : null],
      ['Yêu cầu', d.request ? h('span.h-row', linkOr(ctx.linkTo(`request:${d.request.id}`), `${d.request.code} · ${d.request.kind_label}`), H.st('req_st', d.request.status)) : null],
      ['Sự cố', d.incident ? h('span.h-row', linkOr(ctx.linkTo(`incident:${d.incident.id}`), `${d.incident.code} · ${d.incident.label}`), H.st('incident_st', d.incident.status)) : null],
      ['Phiếu bàn giao', d.handover ? h('span.h-row', linkOr(ctx.linkTo(`handover:${d.handover.id}`), `${d.handover.code} · ${d.handover.dir_label}`), H.pill(d.handover.status_label, 'off')) : null],
      ['Người làm', j.assignee ? j.assignee.name : open ? 'Chưa ai nhận' : null],
      ['Ngày', H.day(j.date)],
      ['Hiện từ', j.show_date && j.show_date > H.today() ? H.day(j.show_date) : null],
      ['Tạo lúc', H.when(j.created_at)],
      ['Bắt đầu', j.started_at ? H.when(j.started_at) : null],
      ['Hạn', j.due_at ? `${H.when(j.due_at)}${j.blocked ? ' (tạm dừng)' : ''}` : j.sla_min ? `${H.dur(j.sla_min)} kể từ lúc có người nhận` : 'Không hạn'],
      ['Xong lúc', j.status === 'done' ? `${H.when(j.done_at)}${j.done_by ? ' · ' + j.done_by.name : ''}` : null],
      ['Huỷ lúc', j.status === 'cancelled' && j.done_at ? H.when(j.done_at) : null],
      ['Điểm khối lượng', j.points ? H.num(j.points, 1) : null],
      ['Ghi chú', j.note || null],
    ];
    out.push(h('section.jobs-sec', h('h3', 'Thông tin'), H.dl(rows)));
    if (d.kit) out.push(kitBox(ctx, d.kit));
    if (Array.isArray(d.kits) && d.kits.length && (j.type === 'deliver' || j.type === 'recover' || j.type === 'card_swap')) {
      out.push(h('section.jobs-sec', h('h3', j.type === 'deliver' ? 'Kit của yêu cầu' : 'Kit đang quay tại BO'), h('div.jobs-chips', d.kits.map((k) => h('span.jobs-kchip', linkOr(ctx.linkTo(`kit:${k.id}`), k.code), H.st('kit_st', k.status))))));
    }
    if (j.type === 'card_swap' && d.cards_at_bo) out.push(h('section.jobs-sec', h('h3', `Thẻ đang ở BO (${d.cards_at_bo.length})`), d.cards_at_bo.length ? listCodes(d.cards_at_bo) : h('p.sub', 'Hệ thống không ghi thẻ nào.')));
    if (j.status === 'done' && j.result) out.push(resultBox(j.result));
    // Nhật ký
    const log = d.log || [];
    out.push(h('section.jobs-sec', h('div.h-row.h-between', h('h3', 'Diễn biến'), canView(ctx, 'log') ? H.link(`#/log?entity=job&id=${j.id}`, 'Nhật ký đầy đủ') : null),
      log.length ? h('ol.jobs-log', log.map((l) => h('li', h('time', H.when(l.ts)), h('span', l.text)))) : h('p.sub', d.log_hidden ? 'Việc đã đóng của người khác: người làm, điểm và diễn biến chỉ Lead của team xem.' : 'Chưa có ghi nhận.')));
    return out;
  }
  function actionsOf(ctx, d, task, changed) {
    const j = d.job;
    if (!OPEN.includes(j.status)) return null;
    const me = ctx.user.id, lead = ctx.isLead(j.team), mine = !!j.assignee && j.assignee.id === me;
    const inTeam = ctx.role === 'admin' || ctx.team === j.team;
    const flow = W.flowOf(ctx, j);
    const btns = [];
    const more = [];
    if (!task) {
      if (inTeam && !j.assignee) btns.push(H.btn('Nhận việc', async () => { await W.claim(ctx, j); changed(); }, 'primary'));
      if (d.can_act && j.status === 'open') btns.push(H.btn('Bắt đầu', async () => { await W.start(ctx, j); changed(); }, j.assignee && mine ? 'primary' : ''));
      if (flow) btns.push(H.link(flow.href, flow.label, { class: `btn${j.assignee && mine ? ' primary' : ''}` }));
      else if (d.can_act) btns.push(H.btn('Báo xong…', async () => { if (await W.done(ctx, d)) changed(); }, j.status === 'doing' && (mine || lead) ? 'primary' : ''));
      if (inTeam && j.assignee && !mine && lead) more.push({ label: 'Nhận về mình', run: async () => { await W.claim(ctx, j); changed(); } });
    }
    if (d.can_assign) {
      const b = h('button', { type: 'button', onclick: () => W.assignMenu(ctx, b, [j], d.team_members, changed) }, j.assignee ? 'Giao lại…' : 'Giao cho…');
      btns.push(b);
    }
    if (d.can_block && !j.blocked) more.push({ label: 'Báo vướng…', run: async () => {
      const ok = await W.askReason('Báo vướng', { intro: 'Việc đang chờ bên khác (thiếu linh kiện, chờ BO, chờ team khác). Hạn tạm dừng trong lúc vướng; Lead được báo ngay.', label: 'Đang vướng ở đâu', submit: 'Báo vướng' }, (reason) => ctx.api('POST', `/api/hub/jobs/${j.id}/block`, { reason }));
      if (ok) { ARL.toast('Đã báo vướng. Lead đã được báo.'); changed(); }
    } });
    if (j.assignee && (mine || lead) && !task) more.push({ label: 'Trả việc cho cả đội…', run: async () => {
      const ok = await W.askReason('Trả việc cho cả đội', { intro: 'Việc trở lại hàng chung; hệ thống giao cho người khác đang trong ca. Lead được báo. Người vừa trả nhận lại sau thì vẫn giữ hạn cũ.', label: 'Lý do trả việc', submit: 'Trả việc' }, (reason) => ctx.api('POST', `/api/hub/jobs/${j.id}/release`, { reason }));
      if (ok) { ARL.toast(`Đã trả ${j.code} về cho cả đội.`); changed(); }
    } });
    if (lead) {
      more.push({ label: j.priority ? 'Bỏ đánh dấu gấp' : 'Đánh dấu gấp', run: async () => { await ctx.api('PATCH', `/api/hub/jobs/${j.id}`, { priority: !j.priority }); ARL.toast(j.priority ? 'Đã bỏ gấp.' : 'Đã đánh dấu gấp.'); changed(); } });
      more.push({ label: 'Sửa việc / dời hạn…', run: async () => { if (await W.edit(ctx, j)) changed(); } });
    } else if (mine) more.push({ label: 'Sửa ghi chú…', run: async () => { if (await W.edit(ctx, j)) changed(); } });
    if (lead && !NO_CANCEL.has(j.type) && !(task && task.status === 'in_progress')) {
      more.push('-');
      more.push({ label: 'Huỷ việc…', danger: true, run: async () => {
        const ok = await W.askReason(`Huỷ việc ${j.code}`, { intro: j.type === 'swap_faulty' ? 'Huỷ đổi kit hỏng (ví dụ Tech xác nhận kit đã ổn): cờ lỗi của kit được gỡ. Không hoàn tác được.' : 'Việc huỷ không tính điểm cho ai. Không hoàn tác được.', label: 'Lý do huỷ', submit: 'Huỷ việc', danger: true }, (reason) => ctx.api('POST', `/api/hub/jobs/${j.id}/cancel`, { reason }));
        if (ok) { ARL.toast(`Đã huỷ ${j.code}.`); changed(); }
      } });
    }
    while (more.length && more[more.length - 1] === '-') more.pop();
    if (!btns.length && !more.length) return null;
    return { el: btns.length ? h('div.jobs-acts', btns) : null, more: more.length ? H.more(more, 'Thao tác khác với việc này') : null };
  }
  function kitBox(ctx, kit) {
    const devs = kit.devices || [];
    return h('section.jobs-sec', h('div.h-row.h-between', h('h3', `Kit ${kit.code}`), h('span.h-row', H.pill(kit.kind_label || kit.kind, 'off'), kit.complete ? H.pill('Đủ thành phần', 'go') : H.pill('Chưa đủ thành phần', 'wait'))),
      kit.fault ? H.note(`Lỗi đang báo: ${kit.fault}`, 'lost') : null,
      kit.watch ? H.note(`Theo dõi: ${kit.watch}`, 'wait') : null,
      devs.length ? h('ul.jobs-devlist', devs.map((x) => h('li', h('b', x.code), h('small', x.type_name), x.cond !== 'ok' ? H.st('dev_cond', x.cond) : null, x.health && x.health !== 'good' ? H.pill(`Pin ${H.label('health', x.health).toLowerCase()}`, 'wait') : null))) : h('p.sub', 'Kit chưa có thiết bị.'),
      kitGap(ctx, kit));
  }
  function resultBox(r) {
    const join = (a) => (Array.isArray(a) && a.length ? a.join(', ') : null);
    const res = r.resolution ? H.label('incident_res', r.resolution) : null;
    return h('section.jobs-sec', h('h3', 'Kết quả'), H.dl([
      ['Tóm tắt', r.summary || null], ['Tự đóng', r.auto ? 'Có (hệ thống đóng theo thao tác khác)' : null], ['Qua', r.via === 'fo' ? 'Chuyến FO, BO đã xác nhận' : null],
      ['Cách xử lý', res], ['Biên bản', r.doc_code || null], ['Kit', join(r.kits)], ['Thẻ giao', join(r.cards_out)], ['Thẻ thu', join(r.cards_in)],
      ['Thiết bị không đạt', join(r.bad)], ['Thiếu phụ kiện', join(r.acc_short)], ['Dư phụ kiện', join(r.acc_extra)], ['Chênh lệch', r.diff || null],
      ['Nguyên nhân', r.cause || null], ['Ghi chú', r.note || null],
    ]));
  }

  // ───────────── Màn hình Bảng việc ─────────────
  const ACTIVE = ['active', 'open', 'doing'];
  ARL.hub.view('jobs', {
    mount(el, ctx) {
      const admin = ctx.role === 'admin';
      const myLead = admin || ctx.isLead(ctx.team);
      const q0 = ctx.query || {};
      const S = {
        team: admin ? (['tech', 'logistics'].includes(q0.team) ? q0.team : '') : ctx.team,
        st: ['active', 'open', 'doing', 'done', 'cancelled'].includes(q0.st) ? q0.st : 'active',
        type: q0.type || '', who: q0.who || '', q: q0.q || '', od: q0.od === '1', up: q0.up === '1',
        scope: q0.scope === 'mine' || q0.scope === 'team' ? q0.scope : myLead ? 'team' : 'mine',
        v: q0.v === 'board' ? 'board' : 'list',
      };
      let data = null, picked = [];
      const leadHere = () => (admin ? true : ctx.isLead(ctx.team));
      const sync = () => ctx.setQuery({ team: admin ? S.team : '', st: S.st === 'active' ? '' : S.st, type: S.type, who: S.who, q: S.q, od: S.od ? '1' : '', up: S.up ? '1' : '', scope: S.scope === (myLead ? 'team' : 'mine') ? '' : S.scope, v: S.v === 'list' ? '' : S.v });
      const sub = () => (admin && !S.team ? 'Việc tự sinh của Tech và Logistics. Người làm chỉ xác nhận việc đã làm; hệ thống tự đổi trạng thái kit, thẻ và tạo việc kế tiếp.'
        : `Việc tự sinh của team ${teamLabel(S.team || ctx.team)}. Bạn chỉ xác nhận việc đã làm; hệ thống tự đổi trạng thái kit, thẻ và tạo việc kế tiếp.`);
      const subEl = h('p.sub');
      const head = H.head('Bảng việc', null, leadHere() ? H.csv('/api/hub/export/jobs.csv', null, 'Tải CSV 30 ngày') : null,
        H.btn('Tạo việc', async () => { const j = await W.create(ctx, { team: S.team || ctx.team }); if (j) { reload(); ctx.setParams([j.id]); } }, 'primary'));
      head.querySelector('.h-head-l').append(subEl);
      subEl.textContent = sub();

      // Thanh lọc
      const teamChips = admin ? H.chips([{ key: '', label: 'Cả hai team' }, { key: 'tech', label: 'Tech' }, { key: 'logistics', label: 'Logistics' }], S.team, (k) => { S.team = k; S.who = ''; S.type = ''; fillTypes(); sync(); subEl.textContent = sub(); reload(true); }) : null;
      const scopeSeg = H.seg([['mine', 'Của tôi'], ['team', admin ? 'Tất cả' : 'Cả team']], S.scope, (k) => { S.scope = k; if (k === 'mine') S.who = ''; sync(); reload(true); });
      const stChips = H.chips([{ key: 'active', label: 'Đang mở' }, { key: 'open', label: 'Chờ làm' }, { key: 'doing', label: 'Đang làm' }, { key: 'done', label: 'Đã xong' }, { key: 'cancelled', label: 'Đã huỷ' }], S.st, (k) => {
        const both = ACTIVE.includes(S.st) && ACTIVE.includes(k);
        S.st = k; sync();
        if (both) paint(); else reload(true);
      });
      const search = H.search('Tìm việc, BO, kit, người làm', (v) => { S.q = v; sync(); paint(); }, S.q);
      const typeSel = h('select', { 'aria-label': 'Loại việc', onchange: () => { S.type = typeSel.value; sync(); reload(true); } });
      function fillTypes() {
        const jt = (ARL.hubMeta && ARL.hubMeta.job_types) || {};
        const team = S.team || (admin ? '' : ctx.team);
        const opts = Object.entries(jt).filter(([, v]) => !team || !v.team || v.team === team);
        H.clear(typeSel, h('option', { value: '' }, 'Mọi loại việc'), opts.map(([k, v]) => h('option', { value: k, selected: k === S.type }, team ? v.label : `${v.label}${v.team ? ` · ${teamLabel(v.team)}` : ''}`)));
      }
      fillTypes();
      const whoSel = h('select', { 'aria-label': 'Người làm', hidden: true, onchange: () => { S.who = whoSel.value; sync(); reload(true); } });
      const odChip = h('button.chip', { type: 'button', 'aria-pressed': String(S.od), onclick: () => { S.od = !S.od; odChip.setAttribute('aria-pressed', String(S.od)); sync(); paint(); } }, 'Quá hạn ', h('b', '0'));
      const upChip = h('button.chip', { type: 'button', 'aria-pressed': String(S.up), title: 'Gồm cả việc chưa tới ngày hiện (ví dụ giao kit cho BO launch vài ngày tới)', onclick: () => { S.up = !S.up; upChip.setAttribute('aria-pressed', String(S.up)); sync(); reload(true); } }, 'Gồm việc sắp tới');
      const viewSeg = H.seg([['list', 'Danh sách'], ['board', 'Theo trạng thái']], S.v, (k) => { S.v = k; sync(); paint(); });
      const tools1 = h('div.h-tools.jobs-tools', teamChips, scopeSeg, stChips);
      const tools2 = h('div.h-tools.jobs-tools', search, typeSel, whoSel, odChip, upChip, h('span.jobs-grow'), viewSeg);
      // Giao hàng loạt (Lead)
      const bulkN = h('b', '0');
      const bulkBtn = h('button.primary', { type: 'button', onclick: () => W.assignMenu(ctx, bulkBtn, picked, (data && data.members) || [], () => { table && table.clearSelection(); reload(); }) }, 'Giao cho…');
      const bulk = h('div.jobs-bulk', { hidden: true, role: 'region', 'aria-label': 'Giao nhiều việc' }, h('span', 'Đã chọn ', bulkN, ' việc'), bulkBtn, h('button.ghost', { type: 'button', onclick: () => table && table.clearSelection() }, 'Bỏ chọn'));
      const summary = h('div.jobs-summary');
      const scopeNote = h('p.h-note', { hidden: true }, 'Cả team: hàng việc đang mở của team; việc đã xong, đã huỷ chỉ gồm việc của bạn. Khối lượng, điểm theo từng người do Lead của team theo dõi.');
      const teamBox = h('div.jobs-teambox');
      const content = h('div.jobs-content', H.loading(6));
      el.append(head, tools1, tools2, summary, scopeNote, teamBox, bulk, content);

      // Bảng
      let table = null, tableSel = null;
      const moreNote = h('p.h-note.jobs-more', { hidden: true });
      const cols = () => [
        { key: 'title', label: 'Việc', value: (r) => r.title, render: (r) => h('div.jobs-cell', h('b', r.priority ? [H.pill('Gấp', 'lost'), ' '] : null, r.title), h('small', `${r.code} · ${r.type_label}`)) },
        { key: 'site', label: 'BO / kit', value: (r) => (r.site ? r.site.name : '') + (r.kit ? r.kit.code : ''), render: (r) => (r.site || r.kit ? h('div', r.site ? r.site.name : '', r.kit ? h('small', `Kit ${r.kit.code}`) : null) : '–') },
        { key: 'who', label: 'Người làm', value: (r) => (r.assignee ? r.assignee.name : ''), render: (r) => (r.assignee ? r.assignee.name : OPEN.includes(r.status) ? H.pill('Chưa ai nhận', 'wait') : '–') },
        { key: 'status', label: 'Trạng thái', value: (r) => r.status + (r.blocked ? 'z' : ''), render: (r) => h('span.jobs-pills', H.st('job_st', r.status), r.blocked ? H.pill('Vướng', 'wait') : null, W.inTrip(r) ? H.pill('Chuyến FO', 'blue') : null) },
        { key: 'due', label: 'Hạn', value: (r) => (ACTIVE.includes(S.st) ? W.eta(r) : r.done_at || 0), render: (r) => { const x = W.dueOf(r); return H.pill(x.text, x.tone); } },
        { key: 'created', label: 'Tạo lúc', value: (r) => r.created_at, render: (r) => H.when(r.created_at), nowrap: true, desc: true },
      ];
      function ensureTable() {
        const selectable = leadHere() && ACTIVE.includes(S.st) && !!(data && data.members && data.members.length);
        const key = `${selectable}|${emptyText()}`;
        if (table && tableSel === key) return table;
        tableSel = key; picked = []; bulk.hidden = true;
        table = H.table({
          columns: cols(), rows: [], pageSize: 50, select: selectable, id: (r) => r.id,
          onSelect: (rows) => { picked = rows.filter((r) => OPEN.includes(r.status)); bulkN.textContent = String(picked.length); bulk.hidden = !picked.length; },
          onRow: (r) => ctx.setParams([r.id]),
          rowTone: (r) => (r.overdue ? 'lost' : r.blocked ? 'wait' : null),
          empty: emptyText(),
        });
        return table;
      }
      function emptyText() {
        if (S.st === 'done') return 'Chưa có việc nào xong theo bộ lọc này.';
        if (S.st === 'cancelled') return 'Không có việc nào bị huỷ theo bộ lọc này.';
        return S.scope === 'mine' ? 'Bạn không có việc nào đang mở. Việc mới sẽ tự đến khi bạn trong ca.' : 'Không có việc nào đang mở theo bộ lọc này.';
      }
      function rows() {
        let list = (data && data.jobs) || [];
        if (S.st === 'open' || S.st === 'doing') list = list.filter((j) => j.status === S.st);
        if (S.od) list = list.filter((j) => j.overdue);
        if (S.q) list = list.filter((j) => H.match([j.code, j.title, j.type_label, j.site && j.site.name, j.kit && j.kit.code, j.assignee && j.assignee.name, j.note].filter(Boolean).join(' '), S.q));
        return list;
      }
      function paint() {
        if (!data) return;
        const all = data.jobs || [];
        if (ACTIVE.includes(S.st)) stChips.counts({ active: all.length, open: all.filter((j) => j.status === 'open').length, doing: all.filter((j) => j.status === 'doing').length, done: null, cancelled: null });
        else stChips.counts({ active: null, open: null, doing: null, done: S.st === 'done' ? data.total : null, cancelled: S.st === 'cancelled' ? data.total : null });
        const base = all.filter((j) => (S.st === 'open' || S.st === 'doing' ? j.status === S.st : true));
        odChip.querySelector('b').textContent = String(base.filter((j) => j.overdue).length);
        odChip.hidden = !ACTIVE.includes(S.st);
        upChip.hidden = !ACTIVE.includes(S.st);
        viewSeg.hidden = !ACTIVE.includes(S.st);
        scopeNote.hidden = !(S.scope === 'team' && !leadHere() && !ACTIVE.includes(S.st));
        const list = rows();
        if (S.v === 'board' && ACTIVE.includes(S.st)) { content.replaceChildren(board(list)); bulk.hidden = true; return; }
        const t = ensureTable();
        if (!content.contains(t)) content.replaceChildren(t, moreNote);
        t.update(list);
        moreNote.hidden = !(data.total > (data.jobs || []).length);
        moreNote.textContent = `Đang hiện ${H.num((data.jobs || []).length)} / ${H.num(data.total)} việc mới nhất. Thu hẹp bộ lọc để xem việc cũ hơn.`;
      }
      function board(list) {
        const colsB = [
          ['pool', 'Chưa ai nhận', (j) => !j.assignee && !j.blocked],
          ['open', 'Chờ làm', (j) => j.assignee && j.status === 'open' && !j.blocked],
          ['doing', 'Đang làm', (j) => j.status === 'doing' && !j.blocked],
          ['blocked', 'Đang vướng', (j) => !!j.blocked],
        ];
        return h('div.jobs-board', colsB.map(([k, label, f]) => {
          const items = list.filter(f).sort(W.urgency);
          return h('section.jobs-col', { 'data-col': k }, h('h3', label, ' ', h('b', String(items.length))),
            items.length ? h('div.jobs-col-list', items.map((j) => W.item(ctx, j, { href: `#/jobs/${j.id}`, assignee: k !== 'pool' }))) : h('p.sub.jobs-col-empty', 'Không có việc.'));
        }));
      }
      function paintSummary() {
        const c = (data && data.counts) || {};
        summary.replaceChildren(h('span', 'Của tôi ', h('b', H.num(c.mine))), h('span', 'Chưa ai nhận ', h('b', H.num(c.pool))), h('span', { 'data-tone': c.overdue ? 'lost' : null }, 'Quá hạn ', h('b', H.num(c.overdue))), h('span', { 'data-tone': c.blocked ? 'wait' : null }, 'Đang vướng ', h('b', H.num(c.blocked))), h('span', 'Tôi xong hôm nay ', h('b', H.num(c.done_today))));
        const mem = (data && data.members) || [];
        // Người làm (Lead): lọc theo người
        whoSel.hidden = !(leadHere() && S.scope === 'team' && mem.length);
        H.clear(whoSel, h('option', { value: '' }, 'Mọi người'), h('option', { value: 'pool', selected: S.who === 'pool' }, 'Chưa ai nhận'), mem.map((m) => h('option', { value: String(m.id), selected: String(m.id) === S.who }, `${m.name}${m.on_shift ? ' · trong ca' : ''}`)));
        if (!mem.length || !leadHere()) { teamBox.replaceChildren(); return; }
        const on = mem.filter((m) => m.on_shift).length;
        const open0 = teamBox.querySelector('details') ? teamBox.querySelector('details').open : false;
        const tbl = H.table({
          columns: [
            { key: 'name', label: 'Người', render: (m) => h('div', m.name, h('small', H.label('roles', m.role))) },
            { key: 'on_shift', label: 'Ca', value: (m) => (m.on_shift ? 1 : 0), desc: true, render: (m) => (m.on_shift ? H.pill('Trong ca', 'go') : H.pill('Ngoài ca', 'off')) },
            { key: 'open', label: 'Chờ làm', align: 'r' }, { key: 'doing', label: 'Đang làm', align: 'r' },
            { key: 'overdue', label: 'Quá hạn', align: 'r', render: (m) => (m.overdue ? h('b.jobs-bad', String(m.overdue)) : '0') },
            { key: 'blocked', label: 'Vướng', align: 'r' },
            { key: 'load_min', label: 'Tải (phút chuẩn)', align: 'r', render: (m) => H.num(m.load_min) },
          ],
          rows: mem, pageSize: 50, sort: { key: 'on_shift', dir: -1 }, onRow: (m) => { S.scope = 'team'; scopeSeg.set('team'); S.who = String(m.id); sync(); reload(true); },
        });
        teamBox.replaceChildren(h('details.jobs-team', { open: open0 }, h('summary', `Tải của team: ${mem.length} người, ${on} đang trong ca`), h('p.sub', 'Bấm vào một người để xem việc người đó đang giữ.'), tbl));
      }
      let gen = 0;
      const reload = W.coalesce(async () => {
        const my = ++gen;
        const st = ACTIVE.includes(S.st) ? 'active' : S.st;
        const q = W.clean({ team: admin ? S.team : undefined, status: st, type: S.type, view: S.scope, assignee: S.who && S.who !== 'pool' && S.scope === 'team' ? S.who : undefined, pool: S.who === 'pool' && S.scope === 'team' ? '1' : undefined, upcoming: S.up && st === 'active' ? '1' : undefined });
        try {
          const r = await ctx.api('GET', '/api/hub/jobs', null, q);
          if (my !== gen || !ctx.alive()) return;
          data = r;
          paintSummary();
          paint();
        } catch (e) {
          if (!ctx.alive()) return;
          if (!data) content.replaceChildren(H.error(e, () => reload()));
          else ARL.toast(e.message, true);
        }
      });
      const panel = W.panel(ctx, { onClose: () => ctx.setParams([]), onChanged: () => reload() });
      ctx.onRoute((c) => { const id = c.params[0]; if (id) panel.open(id); else panel.hide(); });
      ctx.live(['jobs', 'kits', 'cards', 'handovers', 'incidents', 'requests', 'roster', 'people'], () => { reload(); panel.refresh(); });
      ctx.every(60000, () => paint()); // chữ "còn … phút" / "quá hạn …" tự cập nhật
      reload();
      if (ctx.params[0]) panel.open(ctx.params[0]);
    },
  });
})();
