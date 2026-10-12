/* Ops Hub — Kho: "Kit & thiết bị" (kits) và "Phụ kiện" (acc).
   Mọi con số tồn kho do máy chủ tính từ trạng thái kit, thiết bị và sổ kho phụ kiện; màn hình chỉ hiển thị và gửi thao tác.
   Nút nào vai trò không làm được (theo quyền ở core/hub/stock.js) thì không hiện. */
(() => {
  'use strict';
  const H = ARL.H, { h } = H;

  // Quyền theo từng API (core/hub/stock.js)
  const LOGI = ['admin', 'lead', 'logistic']; //                     tạo kit, gửi kiểm, mở lại, sổ phụ kiện
  const TYPE_EDIT = ['admin', 'lead', 'logistic', 'tech_lead']; //   thêm / sửa loại, thêm thiết bị
  const RETIRE_ROLES = ['admin', 'lead', 'tech_lead']; //            cho kit ngừng dùng
  const DEV_FINAL = ['admin', 'lead', 'tech_lead', 'tech']; //       ghi thiết bị ngừng dùng / thất lạc
  // Trạng thái kit (core/hub/stock.js)
  const FAULTY_FROM = ['preparing', 'wait_check', 'ready', 'reserved', 'returned', 'tech_done', 'at_bo', 'at_tech'];
  const REOPEN_FROM = ['ready', 'reserved', 'wait_check', 'tech_done'];
  const LOCKED_OFFICE = ['ready', 'reserved', 'wait_check', 'tech_done'];
  const OUTSIDE = ['delivering', 'at_bo', 'recovering'];
  const AT_TECH = ['wait_check', 'returned', 'at_tech'];
  const GROUPS = { outside: { label: 'Đang ở ngoài', st: OUTSIDE }, tech: { label: 'Đang ở Tech', st: AT_TECH } };
  const OPEN_JOB = ['open', 'doing'];
  const HEALTH_RANK = { good: 1, weak: 2, bad: 3 };
  const HEALTH_TONE = { good: 'go', weak: 'wait', bad: 'lost' };
  const TYPE_KIND = { device: 'Thiết bị theo mã', acc: 'Phụ kiện theo số lượng', card: 'Thẻ nhớ theo mã' };

  const M = () => ARL.hubMeta || {};
  const kitKinds = () => M().kit_kinds || {};
  const kitCore = () => M().kit_core || {};
  const cfg = () => M().cfg || {};
  const enc = encodeURIComponent;

  // ───────────── Phần dùng chung trong file ─────────────
  /** Dòng báo lỗi trong hộp thoại (toast nằm dưới lớp phủ của hộp thoại nên dễ bị che). */
  const errLine = () => h('p.err.vs-err', { role: 'alert', hidden: true });
  const showErr = (box, e) => { box.textContent = (e && e.message) || 'Có lỗi xảy ra. Thử lại.'; box.hidden = false; };
  /** Nút thao tác trong hộp thoại chi tiết: tự khoá khi chạy, lỗi hiện ngay trong hộp thoại. */
  function act(box, label, run, cls = '', attrs = {}) {
    return H.btn(label, async (e, b) => {
      box.hidden = true;
      try { await run(e, b); } catch (err) { if (!err || err.status === undefined) console.error(err); showErr(box, err); } // lỗi API đã hiện tại chỗ; chỉ ghi console lỗi lập trình
    }, cls, attrs);
  }
  /** Hỏi lý do rồi gọi API ngay trong hộp thoại (lỗi máy chủ hiện tại chỗ, không mất chữ đã gõ). */
  function reasonForm(title, o) {
    return H.form({
      title, intro: o.intro, danger: !!o.danger, submit: o.submit || 'Xác nhận',
      fields: [{ name: 'reason', label: o.label || 'Lý do', type: 'textarea', required: true, rows: 2, placeholder: o.placeholder || '' }],
      onSubmit: async (v, c) => {
        if (v.reason.length < 3) { c.setErr('Ghi rõ hơn một chút (ít nhất 3 ký tự).'); return false; }
        const r = await o.run(v.reason);
        return r === undefined ? v.reason : r;
      },
    });
  }
  /** Hộp thoại có phần thân tự dựng (trường thay đổi theo lựa chọn). onSubmit({ setErr }) trả về false để giữ mở. */
  function dlgForm(o) {
    return new Promise((resolve) => {
      let out = null;
      const m = ARL.modal({
        title: o.title, body: o.body, wide: !!o.wide, cls: o.cls || '', onClose: () => resolve(out),
        actions: [
          { label: 'Thôi', cls: 'ghost', run: () => {} },
          { label: o.submit || 'Lưu', cls: o.danger ? 'primary danger-bg' : 'primary', run: async (c) => { const r = await o.onSubmit(c); if (r === false) return false; out = r === undefined ? true : r; return true; } },
        ],
      });
      m.el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !['checkbox', 'radio'].includes(e.target.type)) { e.preventDefault(); m.el.querySelector('.dlg-foot button:last-child').click(); }
      });
      const first = o.body.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea');
      // Đang gõ ô khác của hộp thoại thì không giật con trỏ về ô đầu (chữ sẽ rơi vào ô số lượng), cùng cách với H.form.
      if (first && !o.noFocus) setTimeout(() => { const a = document.activeElement; if (!(a && a !== first && a.matches('input, select, textarea') && m.el.contains(a))) first.focus(); }, 30);
    });
  }
  /** Nhãn + ô nhập tự dựng (cùng kiểu với H.field). */
  const fieldWrap = (label, input, hint, full) => h('label.h-field', { class: full ? 'h-full' : null }, h('span', label), input, hint ? h('small', hint) : null);
  /** Nhật ký thao tác (mới nhất trước). */
  function logList(rows, empty = 'Chưa có ghi chép nào.') {
    if (!rows || !rows.length) return h('p.sub', empty);
    return h('ol.vs-log', rows.map((r) => h('li', h('time', { datetime: new Date(r.ts).toISOString() }, H.when(r.ts)), h('span', r.text))));
  }
  /** Danh sách việc gắn với kit / phiếu: việc đang mở trước, kèm người giữ và hạn. */
  function jobList(ctx, jobs, opt = {}) {
    const open = jobs.filter((j) => OPEN_JOB.includes(j.status));
    const closed = jobs.filter((j) => !OPEN_JOB.includes(j.status));
    const item = (j) => {
      const href = ctx.jobLink(j);
      const due = OPEN_JOB.includes(j.status) ? H.due(j.due_at) : null;
      const tone = j.status === 'cancelled' ? null : j.overdue ? 'lost' : OPEN_JOB.includes(j.status) ? 'blue' : 'go';
      return h('div.h-item.vs-job', { 'data-tone': tone },
        h('div.h-item-t', href ? H.link(href, `${j.code} · ${j.title}`) : `${j.code} · ${j.title}`),
        h('div.h-item-m', h('span', j.type_label), j.assignee ? h('span', `Người giữ: ${j.assignee.name}`) : OPEN_JOB.includes(j.status) ? h('span', 'Chưa ai nhận') : null,
          j.done_by && j.status === 'done' ? h('span', `Làm: ${j.done_by.name}`) : null, j.done_at ? h('span', H.when(j.done_at)) : due ? h('span', due.text) : null),
        h('div.h-item-r', H.st('job_st', j.status)));
    };
    if (!jobs.length) return h('p.sub', opt.empty || 'Chưa có việc nào.');
    const more = closed.slice(opt.closedMax ?? 6);
    return h('div.h-list', open.map(item), closed.slice(0, opt.closedMax ?? 6).map(item),
      more.length ? h('p.sub', `… và ${more.length} việc cũ hơn.`) : null);
  }
  /** Tải CSV dựng từ đúng các dòng đang hiện trên màn hình (khi máy chủ chưa có bản xuất riêng). */
  function csvDownload(name, head, rows) {
    const cell = (v) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // chặn công thức khi mở bằng Excel
      return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const text = '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: name, hidden: true });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  /**
   * Chi tiết mở theo địa chỉ (#/view/<id>): mở khi có id, đóng khi bấm quay lại; người dùng đóng hộp thoại thì địa chỉ về danh sách.
   * keyOf() → khoá hiện tại (null = không mở); open(key, onUserClose) → hàm đóng.
   */
  function detailRouter(ctx, keyOf, open) {
    let cur = null;
    const closeCur = () => { if (!cur) return; const c = cur; cur = null; try { c.close(); } catch (e) { console.error(e); } };
    function sync() {
      const key = keyOf();
      if (cur && cur.key === key) return;
      closeCur();
      if (!key) return;
      const c = { key, close: () => {} };
      cur = c;
      c.close = open(key, () => { if (cur === c) { cur = null; ctx.setParams([], ctx.query); } }) || c.close;
    }
    ctx.onCleanup(closeCur);
    return { sync, close: closeCur };
  }
  const groupBy = (rows, key) => { const m = new Map(); for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const worstHealth = (devs) => (devs || []).reduce((w, d) => ((HEALTH_RANK[d.health] || 0) > (HEALTH_RANK[w] || 0) ? d.health : w), null);
  const healthPill = (v) => (v ? H.pill(`Pin ${String(H.label('health', v)).toLowerCase()}`, HEALTH_TONE[v] || 'off', { title: 'Sức khoẻ pin' }) : null);
  const intOk = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
  const splitCodes = (s) => String(s || '').split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  async function typeMapOf(ctx) {
    const j = await ctx.api('GET', '/api/hub/types');
    return new Map(j.types.map((t) => [t.id, t]));
  }
  const typeName = (types, id) => ((types && types.get(id)) || {}).name || id;
  const missingText = (kit, types) => (kit.missing || []).map((t) => typeName(types, t)).join(', ');

  /** Dùng chung với views/cards.js (nạp ngay sau file này). */
  ARL.hub.vstock = { errLine, showErr, act, reasonForm, dlgForm, fieldWrap, logList, jobList, csvDownload, detailRouter, splitCodes, intOk, OPEN_JOB };

  // ═════════════ Kit & thiết bị ═════════════
  ARL.hub.view('kits', {
    mount(el, ctx) {
      const S = { tab: tabOf(ctx.query.tab), types: new Map(), refresh: null };
      function tabOf(t) { return t === 'devices' || t === 'types' ? t : 'kits'; }
      const actBox = h('div.h-actions');
      const head = h('header.h-head', h('div.h-head-l', h('h1', 'Kit & thiết bị'),
        h('p.sub', 'Số tồn tự cập nhật theo việc đã làm: tạo kit, Tech kiểm, giao BO, thu hồi, báo hỏng. Không có số nhập tay.')), actBox);
      const tabs = H.tabs([['kits', 'Kit'], ['devices', 'Thiết bị'], ['types', 'Loại thiết bị']], S.tab, (k) => {
        S.tab = k;
        ctx.setQuery({ tab: k === 'kits' ? '' : k, st: '', kind: '', q: '', type: '', cond: '', free: '' });
        renderTab();
      });
      const body = h('div.kits-body');
      el.append(head, tabs, body);

      const loadTypes = async () => { try { S.types = await typeMapOf(ctx); } catch (e) { console.error(e); } };
      const typesReady = loadTypes();

      function renderTab() {
        S.refresh = null;
        actBox.replaceChildren();
        if (S.tab === 'kits') kitTab();
        else if (S.tab === 'devices') devicesTab();
        else typesTab();
        actBox.hidden = !actBox.childElementCount;
      }

      // ───────── Tab Kit ─────────
      function kitTab() {
        const st = { status: ctx.query.st || 'all', kind: ctx.query.kind || '', q: ctx.query.q || '', rows: [], counts: {}, chipKeys: '' };
        if (ctx.can(...LOGI)) actBox.append(H.btn('Tạo kit', () => createKit(), 'primary'));
        actBox.append(H.csv('/api/hub/export/kits.csv', null, 'Tải CSV'));
        const strip = h('div.kits-strip', H.loading(2));
        const chipsBox = h('div.kits-chips');
        const kindSel = h('select', { 'aria-label': 'Loại kit', onchange: () => { st.kind = kindSel.value; ctx.setQuery({ kind: st.kind }); paint(); } },
          h('option', { value: '' }, 'Mọi loại kit'), Object.entries(kitKinds()).map(([k, l]) => h('option', { value: k, selected: k === st.kind }, l)));
        const issueText = (k) => {
          if (k.status === 'retired') return '';
          if (k.fault) return `Lỗi: ${k.fault}`;
          if (k.faulty) return `${k.faulty} thiết bị không dùng được`;
          if (!k.complete) return k.missing.length ? `Thiếu ${missingText(k, S.types)}` : 'Chưa có thiết bị';
          return '';
        };
        const accCount = (k) => Object.values(k.acc || {}).reduce((a, n) => a + n, 0);
        const search = H.search('Tìm mã kit, mã thiết bị, BO…', (v) => { st.q = v; ctx.setQuery({ q: v }); paint(); }, st.q);
        const table = H.table({
          columns: [
            { key: 'code', label: 'Mã kit', render: (k) => [h('b', k.code), k.watch ? h('small', `Theo dõi: ${k.watch}`) : null] },
            { key: 'kind', label: 'Loại', value: (k) => k.kind_label, nowrap: true },
            { key: 'status', label: 'Trạng thái', value: (k) => (M().kit_st || {})[k.status] || k.status, render: (k) => [H.st('kit_st', k.status), issueText(k) ? h('small.kits-issue', issueText(k)) : null] },
            { key: 'site', label: 'BO', value: (k) => (k.site ? k.site.name : ''), render: (k) => (k.site ? k.site.name : h('span.h-muted', 'Văn phòng')) },
            { key: 'parts', label: 'Thành phần', sort: false, render: (k) => [h('span.h-mono', k.devices.map((d) => d.code).join(' ') || '–'), accCount(k) ? h('small', `${accCount(k)} phụ kiện`) : null] },
            { key: 'health', label: 'Sức khoẻ pin', value: (k) => HEALTH_RANK[worstHealth(k.devices)] || 0, render: (k) => healthPill(worstHealth(k.devices)) },
            { key: 'updated_at', label: 'Cập nhật', desc: true, nowrap: true, render: (k) => H.when(k.updated_at) },
          ],
          rows: [], sort: { key: 'code', dir: 1 }, pageSize: 50,
          onRow: (k) => ctx.setParams([k.id]),
          rowTone: (k) => (k.status === 'retired' ? null : k.fault || k.faulty ? 'lost' : !k.complete ? 'wait' : null),
          empty: 'Không có kit nào khớp bộ lọc.',
        });
        H.clear(body, strip, h('div.h-tools', chipsBox, kindSel, search), table);

        const pass = (k) => {
          if (st.status === 'all') { if (k.status === 'retired') return false; } else if (GROUPS[st.status]) { if (!GROUPS[st.status].st.includes(k.status)) return false; } else if (k.status !== st.status) return false;
          if (st.kind && k.kind !== st.kind) return false;
          return !st.q || H.match(`${k.code} ${k.site ? `${k.site.name} ${k.site.code}` : ''} ${k.devices.map((d) => d.code).join(' ')} ${k.note} ${k.watch}`, st.q);
        };
        const setStatus = (s) => { st.status = s; ctx.setQuery({ st: s === 'all' ? '' : s }); paintChips(true); paint(); };
        function paintChips(force) {
          const c = st.counts, kst = M().kit_st || {};
          const keys = ['all', ...(GROUPS[st.status] ? [st.status] : []), ...Object.keys(kst).filter((k) => c[k] || k === st.status)];
          const sig = keys.join(',');
          const opts = keys.map((k) => ({ key: k, label: k === 'all' ? 'Đang dùng' : GROUPS[k] ? GROUPS[k].label : kst[k], count: k === 'all' ? Object.entries(c).reduce((a, [s, n]) => a + (s === 'retired' ? 0 : n), 0) : GROUPS[k] ? GROUPS[k].st.reduce((a, s) => a + (c[s] || 0), 0) : c[k] || 0 }));
          if (!force && sig === st.chipKeys && chipsBox.firstChild) { chipsBox.firstChild.counts(Object.fromEntries(opts.map((o) => [o.key, o.count]))); return; }
          st.chipKeys = sig;
          H.clear(chipsBox, H.chips(opts, st.status, setStatus));
        }
        function paint() { table.update(st.rows.filter(pass)); }
        function paintStrip(sum) {
          const by = {};
          for (const k of sum.kits) for (const [s, n] of Object.entries(k.by_status)) by[s] = (by[s] || 0) + n;
          const n = (s) => by[s] || 0;
          const out = OUTSIDE.reduce((a, s) => a + n(s), 0), tech = AT_TECH.reduce((a, s) => a + n(s), 0);
          const core = sum.devices.filter((d) => d.core);
          const freeCore = core.reduce((a, d) => a + d.free, 0);
          const broken = sum.devices.reduce((a, d) => a + d.faulty + d.repairing, 0);
          H.clear(strip, H.kpis(
            H.kpi({ label: 'Kit sẵn sàng xuất', value: n('ready'), tone: 'go', hint: n('reserved') ? `${n('reserved')} kit khác đã gán BO, chờ giao` : 'Đã kiểm đạt, chưa gán BO', onClick: () => setStatus('ready') }),
            H.kpi({ label: 'Đang ở ngoài', value: out, tone: 'blue', hint: `Đang quay ${n('at_bo')} · đang giao ${n('delivering')} · đang thu hồi ${n('recovering')}`, onClick: () => setStatus('outside') }),
            H.kpi({ label: 'Đang ở Tech', value: tech, tone: n('at_tech') ? 'lost' : tech ? 'wait' : null, hint: `Chờ kiểm ${n('wait_check')} · chờ check-in ${n('returned')} · đang sửa ${n('at_tech')}`, onClick: () => setStatus('tech') }),
            H.kpi({ label: 'Đang chuẩn bị', value: n('preparing'), hint: n('tech_done') ? `${n('tech_done')} kit Tech xong, chờ Logistics nhận` : 'Logistics đang ráp kit', onClick: () => setStatus('preparing') }),
            H.kpi({ label: 'Thiết bị chính còn rảnh', value: freeCore, tone: broken ? 'wait' : null, hint: [core.map((d) => `${d.name} ${d.free}`).join(' · '), broken ? `${broken} hỏng / đang sửa` : ''].filter(Boolean).join(' · '), onClick: () => { ctx.setQuery({ tab: 'devices', st: '', kind: '', q: '', free: '1' }); S.tab = 'devices'; tabs.set('devices'); renderTab(); } })),
          h('p.sub.kits-kinds', sum.kits.filter((k) => k.total).map((k) => `${k.label}: ${H.num(k.total)} kit`).join(' · ') || 'Chưa có kit nào.'));
        }
        const loadStrip = H.async(strip, async () => { const sum = await ctx.api('GET', '/api/hub/stock/summary'); if (ctx.alive()) paintStrip(sum); return undefined; });
        async function load() {
          const j = await ctx.api('GET', '/api/hub/kits');
          await typesReady;
          if (!ctx.alive()) return;
          st.rows = j.kits; st.counts = j.counts;
          paintChips(); paint();
        }
        load().catch((e) => { table.replaceWith(H.error(e, () => renderTab())); });
        S.refresh = () => { loadStrip(); return load(); };
      }

      async function createKit() {
        const [devJ, accJ] = await Promise.all([ctx.api('GET', '/api/hub/devices', null, { free: '1', cond: 'ok', limit: 2000 }), ctx.api('GET', '/api/hub/acc'), typesReady]);
        const free = groupBy(devJ.devices, 'type');
        let kind = Object.keys(kitKinds())[0] || 'multicam';
        const code = h('input', { name: 'code', required: true, autocomplete: 'off', placeholder: 'VD: K-MC-012', spellcheck: 'false' });
        const kindSeg = H.seg(Object.entries(kitKinds()), kind, (k) => { kind = k; paintDevs(); });
        const devBox = h('div.h-fields');
        const hint = h('p.h-note.kits-hint');
        const extra = h('textarea', { rows: 2, spellcheck: 'false', placeholder: 'Mã thiết bị khác (nếu có), cách nhau bởi dấu cách' });
        let sels = [];
        function paintDevs() {
          const core = kitCore()[kind] || [];
          const devTypes = [...S.types.values()].filter((t) => t.kind === 'device' && t.active && (kind === 'custom' || core.includes(t.id) || !t.core));
          devTypes.sort((a, b) => (core.includes(b.id) - core.includes(a.id)) || a.sort - b.sort);
          sels = devTypes.map((t) => {
            const list = free.get(t.id) || [];
            const s = h('select', { 'data-type': t.id, onchange: paintHint }, h('option', { value: '' }, list.length ? '— Không gắn —' : '— Kho không còn thiết bị rảnh —'), list.map((d) => h('option', { value: d.code }, d.code)));
            if (core.includes(t.id) && list.length) s.value = list[0].code; // gợi ý thiết bị rảnh đầu tiên cho thành phần bắt buộc
            return { t, s, required: core.includes(t.id), row: fieldWrap(`${t.name}${core.includes(t.id) ? ' (bắt buộc)' : ''}`, s, `${list.length} rảnh trong kho`) };
          });
          H.clear(devBox, ...sels.map((x) => x.row), fieldWrap('Thêm mã thiết bị khác', extra, 'Không bắt buộc. Thiết bị phải đang tốt và chưa thuộc kit nào.', true));
          paintHint();
        }
        function paintHint() {
          const miss = sels.filter((x) => x.required && !x.s.value).map((x) => x.t.name);
          hint.dataset.tone = miss.length ? 'wait' : 'go';
          hint.textContent = miss.length ? `Kit còn thiếu ${miss.join(', ')}: vẫn tạo được ở trạng thái "Đang chuẩn bị" nhưng chưa gửi Tech kiểm được.` : 'Đủ thành phần chính. Sau khi tạo, bấm "Gửi Tech kiểm" ở chi tiết kit.';
        }
        const accRows = accJ.acc.filter((a) => a.active).map((a) => {
          const i = h('input', { type: 'number', min: 0, max: 99, step: 1, inputmode: 'numeric', value: 0, 'aria-label': a.name });
          return { a, i, row: fieldWrap(a.name, i, `Rảnh trong kho: ${H.num(a.free)}`) };
        });
        const note = h('textarea', { rows: 2, placeholder: 'Ghi chú (không bắt buộc)' });
        const form = h('div.h-form',
          h('div.h-fields', fieldWrap('Mã kit *', code), h('div.h-field', h('span', 'Loại kit'), kindSeg)),
          h('h3.kits-h3', 'Thiết bị'), devBox, hint,
          accRows.length ? [h('h3.kits-h3', 'Phụ kiện đi kèm'), h('div.h-fields.kits-acc-fields', accRows.map((x) => x.row))] : null,
          fieldWrap('Ghi chú', note, null, true));
        paintDevs();
        const res = await dlgForm({
          title: 'Tạo kit mới', body: form, submit: 'Tạo kit', wide: true,
          onSubmit: async ({ setErr }) => {
            if (!code.value.trim()) { setErr('Cần nhập mã kit.'); code.focus(); return false; }
            const acc = {};
            for (const x of accRows) {
              const n = x.i.value === '' ? 0 : Number(x.i.value);
              if (!intOk(n, 0, 99)) { setErr(`Số lượng ${x.a.name} phải là số nguyên từ 0 đến 99.`); x.i.focus(); return false; }
              if (n > x.a.free) { setErr(`Kho chỉ còn ${Math.max(0, x.a.free)} ${x.a.name} rảnh. Nếu thực tế có thêm, ghi "Nhập thêm" ở mục Phụ kiện trước.`); x.i.focus(); return false; }
              if (n) acc[x.a.id] = n;
            }
            const devices = [...sels.map((x) => x.s.value).filter(Boolean), ...splitCodes(extra.value)];
            const r = await ctx.api('POST', '/api/hub/kits', { code: code.value.trim(), kind, devices: devices.join(' '), acc, note: note.value.trim() });
            return r.kit;
          },
        });
        if (res && res.id) { ARL.toast(`Đã tạo kit ${res.code}.`); if (S.refresh) S.refresh(); ctx.setParams([res.id]); }
      }

      // ───────── Chi tiết kit (#/kits/<id>) ─────────
      function openKit(id, onClose) {
        const err = errLine();
        const body = h('div.kits-det', H.loading(6));
        const m = ARL.modal({ title: 'Kit', body, wide: true, cls: 'kits-dlg', onClose });
        const title = m.el.querySelector('.dlg-head h2');
        let kit = null;
        async function reload() {
          try {
            const [j] = await Promise.all([ctx.api('GET', `/api/hub/kits/${enc(id)}`), typesReady]);
            kit = j.kit; paint();
          } catch (e) { if (!kit) H.clear(body, H.error(e, reload)); else showErr(err, e); }
        }
        const after = async (msg) => { if (msg) ARL.toast(msg); await reload(); if (S.refresh) S.refresh(); };
        function paint() {
          const st = kit.status, role = ctx.role;
          title.textContent = `Kit ${kit.code}`;
          const since = (kit.log || []).find((l) => l.action === 'status' || l.action === 'create');
          const facts = h('div.kits-facts', H.st('kit_st', st), H.pill(kit.kind_label, 'off'),
            st === 'retired' ? null : kit.complete ? H.pill('Đủ thành phần', 'go') : H.pill(kit.faulty ? `${kit.faulty} thiết bị không dùng được` : kit.missing.length ? `Thiếu ${missingText(kit, S.types)}` : 'Chưa có thiết bị', 'lost'),
            since ? h('span.sub', `từ ${H.when(since.ts)}`) : null);
          const notes = [
            kit.fault ? H.note(`Lỗi đang ghi nhận: ${kit.fault}`, 'lost') : null,
            kit.watch ? H.note(`Đang theo dõi: ${kit.watch}`, 'wait') : null,
            !kit.editable && kit.lock_reason && st !== 'retired' ? H.note(st === 'wait_check' // máy chủ chỉ nhắc Lead; thực tế Logistics cũng mở lại được (kèm lý do)
              ? `Kit đang chờ Tech kiểm. Muốn sửa: Tech trả kết quả "không đạt", hoặc ${ctx.can(...LOGI) ? 'bấm "Mở lại để chỉnh"' : 'Logistics mở lại'} kèm lý do (việc kiểm bị huỷ, kit phải kiểm lại).`
              : kit.lock_reason) : null,
          ];
          // Thao tác theo vai trò và trạng thái (khớp quyền ở máy chủ)
          const acts = [];
          if (ctx.can(...LOGI) && ['preparing', 'returned'].includes(st)) {
            const ship = cfg().checkBeforeShip !== false;
            acts.push(act(err, ship ? 'Gửi Tech kiểm' : 'Chốt sẵn sàng', async () => {
              const r = await ctx.api('POST', `/api/hub/kits/${kit.id}/submit`);
              await after(r.kit.status === 'wait_check' ? `Đã gửi kit ${kit.code} cho Tech kiểm. Tech nhận việc "${H.label('job_types', 'check_kit')}".` : `Kit ${kit.code} đã sẵn sàng.`);
            }, 'primary', { disabled: !kit.complete, title: kit.complete ? null : 'Bổ sung đủ thành phần trước' }));
          }
          if (canParts(kit)) acts.push(act(err, 'Sửa thành phần', () => editParts(kit, after), kit.editable && !['preparing', 'returned'].includes(st) ? 'primary' : ''));
          if (ctx.can(...LOGI) && REOPEN_FROM.includes(st)) acts.push(act(err, 'Mở lại để chỉnh', () => reasonForm(`Mở lại kit ${kit.code}`, {
            intro: 'Kit về "Đang chuẩn bị" để sửa thành phần và phải được Tech kiểm lại trước khi xuất. Việc kiểm hoặc nhận lại đang chờ (nếu có) tự huỷ.',
            label: 'Lý do mở lại', placeholder: 'VD: Thay powerbank yếu trước khi giao', submit: 'Mở lại',
            run: async (reason) => { await ctx.api('POST', `/api/hub/kits/${kit.id}/reopen`, { reason }); await after(`Đã mở lại kit ${kit.code}.`); },
          })));
          if (FAULTY_FROM.includes(st)) acts.push(act(err, 'Báo hỏng', () => faultyForm(kit, null, after), 'danger'));
          acts.push(act(err, 'Sửa mã, ghi chú', () => infoForm(kit, after), 'ghost'));
          if (ctx.can(...RETIRE_ROLES) && !OUTSIDE.includes(st) && !['reserved', 'retired'].includes(st)) acts.push(act(err, 'Ngừng dùng kit', () => reasonForm(`Ngừng dùng kit ${kit.code}`, {
            intro: 'Kit không dùng nữa: thiết bị và phụ kiện trả về kho lẻ, việc đang mở của kit tự huỷ (sự cố vẫn để Tech đóng). Không hoàn tác được.',
            label: 'Lý do ngừng dùng', danger: true, submit: 'Ngừng dùng',
            run: async (reason) => { await ctx.api('POST', `/api/hub/kits/${kit.id}/retire`, { reason }); await after(`Kit ${kit.code} đã ngừng dùng.`); },
          }), 'ghost danger'));
          const submitHint = ctx.can(...LOGI) && ['preparing', 'returned'].includes(st) && !kit.complete ? h('p.sub', 'Bổ sung đủ thiết bị chính (và thay thiết bị hỏng) rồi mới gửi Tech kiểm được.') : null;

          const siteHref = kit.site ? ctx.linkTo(`outlet:${kit.site.id}`) : null;
          const reqHref = kit.request_id ? ctx.linkTo(`request:${kit.request_id}`) : null;
          const info = H.dl([
            ['BO hiện tại', kit.site ? (siteHref ? H.link(siteHref, kit.site.name) : kit.site.name) : OUTSIDE.includes(st) ? '–' : 'Ở văn phòng'],
            ['Yêu cầu', kit.request_id ? (reqHref ? H.link(reqHref, 'Xem yêu cầu đang giữ kit') : `#${kit.request_id}`) : null],
            ['Tech kiểm gần nhất', kit.checked_at ? H.when(kit.checked_at) : 'Chưa có lượt kiểm đạt còn hiệu lực'],
            ['Ghi chú', kit.note || null],
            ['Cập nhật', H.when(kit.updated_at)],
          ]);
          const devRows = kit.devices.map((d) => h('li', h('b.h-mono', d.code), h('span', d.type_name), H.st('dev_cond', d.cond), healthPill(d.health),
            FAULTY_FROM.includes(st) && d.cond === 'ok' ? h('button.ghost.small.danger', { type: 'button', onclick: () => faultyForm(kit, d.id, after).catch((e) => showErr(err, e)) }, 'Báo hỏng') : null));
          const accTypes = Object.entries(kit.acc || {});
          const parts = h('div.kits-parts',
            h('h3.kits-h3', `Thiết bị (${kit.devices.length})`),
            kit.devices.length ? h('ul.kits-devs', devRows) : h('p.sub', 'Chưa gắn thiết bị nào.'),
            h('h3.kits-h3', 'Phụ kiện'),
            accTypes.length ? h('ul.kits-accs', accTypes.map(([t, n]) => h('li', h('span', typeName(S.types, t)), h('b', `× ${n}`)))) : h('p.sub', 'Không có phụ kiện.'),
            kit.cards && kit.cards.length ? [h('h3.kits-h3', `Thẻ nhớ (${kit.cards.length})`), h('div.kits-cards', kit.cards.map((c) => { const href = ctx.linkTo(`card:${c.id}`); return h('span.kits-card', href ? H.link(href, c.code) : c.code, ' ', H.st('card_st', c.status)); }))] : null);
          const openJobs = (kit.jobs || []).filter((j) => OPEN_JOB.includes(j.status));
          H.clear(body,
            h('div.kits-top', facts, h('div.h-row.kits-acts', acts), submitHint, err, notes),
            h('div.kits-det-grid',
              h('div.h-stack', H.card('Thông tin', info), H.card('Thành phần', parts)),
              h('div.h-stack',
                H.card(`Việc liên quan${openJobs.length ? ` · ${openJobs.length} đang mở` : ''}`, jobList(ctx, kit.jobs || [], { empty: 'Kit chưa có việc nào.' })),
                H.card('Lịch sử', logList(kit.log)))));
        }
        reload();
        return m.close;
      }
      /** Ai được sửa thành phần (PATCH /kits/:id có add/remove/acc). */
      function canParts(kit) {
        const st = kit.status;
        if (st === 'at_tech') return true;
        if (st === 'preparing' || st === 'returned') return ctx.can(...LOGI);
        if (OUTSIDE.includes(st)) return ctx.can('admin', 'lead');
        return false;
      }
      async function editParts(kit, after) {
        const [devJ, accJ] = await Promise.all([ctx.api('GET', '/api/hub/devices', null, { free: '1', cond: 'ok', limit: 2000 }), ctx.api('GET', '/api/hub/acc')]);
        const free = groupBy(devJ.devices, 'type');
        const core = kitCore()[kit.kind] || [];
        const rm = kit.devices.map((d) => {
          const cb = h('input', { type: 'checkbox', 'aria-label': `Gỡ ${d.code}`, onchange: () => paintDev() });
          return { d, cb, row: h('label.kits-pick', cb, h('b.h-mono', d.code), h('span', d.type_name), H.st('dev_cond', d.cond), h('small', 'Gỡ khỏi kit')) };
        });
        // Kit ở ngoài: thiết bị gỡ ra chưa về kho nên ghi thất lạc và vào Đối chiếu; chọn ghi ngừng dùng nếu đã biết hỏng bỏ (dùng lý do điều chỉnh).
        const devWo = h('input', { type: 'checkbox' });
        const devWoBox = kit.outside ? h('div.kits-wo', { hidden: true },
          H.note(kit.status === 'delivering' ? 'Kit đang trên đường giao: chưa gỡ thiết bị được. Đợi FO giao xong hoặc huỷ chuyến.' : 'Thiết bị gỡ khi kit đang ở ngoài chưa về kho: hệ thống ghi "Thất lạc" và đưa vào Đối chiếu. Nhận lại về kho thì đổi tình trạng về "Tốt". Kit ở BO thiếu thiết bị chính thì có việc đổi kit cho Logistics.', 'wait'),
          kit.status === 'delivering' ? null : h('label.h-field.h-inline', devWo, h('span', 'Thiết bị gỡ ra đã hỏng bỏ: ghi "Ngừng dùng" (không đưa vào Đối chiếu)'))) : null;
        function paintDev() { if (devWoBox) devWoBox.hidden = !rm.some((x) => x.cb.checked); }
        const devTypes = [...S.types.values()].filter((t) => t.kind === 'device' && t.active && (kit.kind === 'custom' || core.includes(t.id) || !t.core));
        devTypes.sort((a, b) => (core.includes(b.id) - core.includes(a.id)) || a.sort - b.sort);
        const sels = devTypes.map((t) => {
          const list = free.get(t.id) || [];
          const s = h('select', { 'aria-label': `Gắn thêm ${t.name}` }, h('option', { value: '' }, list.length ? '— Không gắn —' : '— Không còn thiết bị rảnh —'), list.map((d) => h('option', { value: d.code }, d.code)));
          return { t, s, row: fieldWrap(`Gắn thêm ${t.name}${(kit.missing || []).includes(t.id) ? ' (kit đang thiếu)' : ''}`, s, `${list.length} rảnh trong kho`) };
        });
        const extra = h('textarea', { rows: 2, spellcheck: 'false', placeholder: 'Hoặc dán mã thiết bị, cách nhau bởi dấu cách' });
        const accList = accJ.acc.filter((a) => a.active || (kit.acc || {})[a.id]);
        const accRows = accList.map((a) => {
          const cur = (kit.acc || {})[a.id] || 0;
          const i = h('input', { type: 'number', min: 0, max: 99, step: 1, inputmode: 'numeric', value: cur, 'aria-label': a.name, oninput: () => paintAcc() });
          return { a, cur, i, row: fieldWrap(a.name, i, `Đang có ${cur} · rảnh trong kho ${H.num(a.free)}`) };
        });
        const wo = h('input', { type: 'checkbox', onchange: () => paintAcc() });
        const woReason = h('input', { type: 'text', placeholder: 'VD: Hub sạc cháy, thanh lý', autocomplete: 'off' });
        const woBox = h('div.kits-wo', { hidden: true },
          kit.outside ? H.note('Kit đang ở ngoài: phần phụ kiện bớt ra chưa về kho nên không trả về số rảnh. Không chọn ghi giảm thì hệ thống ghi thiếu và đưa vào Đối chiếu; về tới kho thì ghi "Tìm lại" ở mục Phụ kiện.', 'wait') : null,
          h('label.h-field.h-inline', wo, h('span', kit.outside ? 'Phần phụ kiện bớt ra đã hỏng / bỏ: ghi giảm tổng kho có lý do (không đưa vào Đối chiếu)' : 'Phần phụ kiện bớt ra bị hỏng / mất: ghi giảm tổng kho (không trả về số rảnh)')),
          h('div', { hidden: true }, fieldWrap('Lý do ghi giảm *', woReason)));
        const ov = kit.outside ? h('input', { type: 'text', autocomplete: 'off', placeholder: 'VD: FO báo BO đã tự tháo 1 hub sạc' }) : null;
        function paintAcc() {
          const dec = accRows.some((x) => Number(x.i.value || 0) < x.cur);
          woBox.hidden = !dec;
          woBox.lastChild.hidden = !(dec && wo.checked);
        }
        const form = h('div.h-form',
          kit.outside ? H.note('Kit đang ở ngoài văn phòng: chỉ điều chỉnh cho khớp thực tế, bắt buộc ghi lý do. Logistic Lead được báo lại.', 'wait') : null,
          rm.length ? [h('h3.kits-h3', 'Thiết bị đang trong kit'), h('div.kits-picks', rm.map((x) => x.row)), devWoBox] : null,
          h('h3.kits-h3', 'Gắn thêm thiết bị'), h('div.h-fields', sels.map((x) => x.row), fieldWrap('Mã khác', extra, 'Thiết bị phải đang tốt và chưa thuộc kit nào.', true)),
          accRows.length ? [h('h3.kits-h3', 'Phụ kiện'), h('div.h-fields.kits-acc-fields', accRows.map((x) => x.row)), woBox] : null,
          ov ? fieldWrap('Lý do điều chỉnh khi kit đang ở ngoài *', ov, null, true) : null);
        const ok = await dlgForm({
          title: `Sửa thành phần kit ${kit.code}`, body: form, submit: 'Lưu thay đổi', wide: true, noFocus: true,
          onSubmit: async ({ setErr }) => {
            const b = {};
            const remove = rm.filter((x) => x.cb.checked).map((x) => x.d.id);
            const add = [...sels.map((x) => x.s.value).filter(Boolean), ...splitCodes(extra.value)];
            if (remove.length) b.remove = remove;
            if (remove.length && kit.outside && devWo.checked) b.dev_writeoff = true;
            if (add.length) b.add = add.join(' ');
            const acc = {};
            let changed = false;
            for (const x of accRows) {
              const n = x.i.value === '' ? 0 : Number(x.i.value);
              if (!intOk(n, 0, 99)) { setErr(`Số lượng ${x.a.name} phải là số nguyên từ 0 đến 99.`); x.i.focus(); return false; }
              if (n - x.cur > x.a.free) { setErr(`Kho chỉ còn ${Math.max(0, x.a.free)} ${x.a.name} rảnh, không đủ để thêm ${n - x.cur}. Nếu thực tế có thêm, ghi "Nhập thêm" ở mục Phụ kiện trước.`); x.i.focus(); return false; }
              if (n) acc[x.a.id] = n;
              if (n !== x.cur) changed = true;
            }
            if (changed) {
              b.acc = acc;
              if (wo.checked && !woBox.hidden) {
                const r = woReason.value.trim();
                if (r.length < 3) { setErr('Ghi lý do ghi giảm phụ kiện (ít nhất 3 ký tự).'); woReason.focus(); return false; }
                b.acc_writeoff = true; b.acc_reason = r;
              }
            }
            if (!Object.keys(b).length) { setErr('Chưa có thay đổi nào.'); return false; }
            if (ov) { const r = ov.value.trim(); if (r.length < 3) { setErr('Cần ghi lý do điều chỉnh khi kit đang ở ngoài.'); ov.focus(); return false; } b.reason = r; }
            await ctx.api('PATCH', `/api/hub/kits/${kit.id}`, b);
            return true;
          },
        });
        if (ok) await after(`Đã cập nhật thành phần kit ${kit.code}.`);
      }
      async function faultyForm(kit, deviceId, after) {
        const st = kit.status;
        const intro = st === 'at_bo'
          ? `Kit đang ở BO: hệ thống tạo việc "${H.label('job_types', 'swap_faulty')}" cho Logistics (đi cùng chuyến đổi thẻ nếu có). Kit về văn phòng sẽ tự chuyển sang Tech sửa.`
          : st === 'at_tech' ? 'Kit đang ở Tech: lỗi được ghi thêm vào kit, không tạo việc mới.'
            : `Thiết bị không tách lẻ: cả kit chuyển sang Tech và hệ thống tạo việc "${H.label('job_types', 'repair')}" cho Tech.${kit.request_id ? ' Kit đang giữ cho một yêu cầu sẽ được gỡ ra; Logistics được báo để gán kit khác.' : ''}`;
        const r = await H.form({
          title: `Báo hỏng kit ${kit.code}`, intro, submit: 'Báo hỏng', danger: true,
          fields: [
            { name: 'device_id', label: 'Thiết bị hỏng', type: 'select', options: kit.devices.filter((d) => d.cond === 'ok' || d.id === deviceId).map((d) => [d.id, `${d.code} · ${d.type_name}`]), empty: 'Chưa rõ thiết bị nào', value: deviceId || '', full: true },
            { name: 'reason', label: 'Mô tả lỗi', type: 'textarea', required: true, rows: 3, placeholder: 'VD: Multicam không lên nguồn sau khi sạc đầy' },
          ],
          onSubmit: async (v, c) => {
            if (v.reason.length < 3) { c.setErr('Mô tả lỗi rõ hơn một chút (ít nhất 3 ký tự).'); return false; }
            return ctx.api('POST', `/api/hub/kits/${kit.id}/faulty`, { reason: v.reason, device_id: v.device_id ? Number(v.device_id) : undefined });
          },
        });
        if (!r) return;
        const msg = r.result === 'to_tech' ? `Kit ${kit.code} đã chuyển sang Tech. Đã tạo việc "${H.label('job_types', 'repair')}".`
          : r.result === 'swap_job' ? `Đã tạo việc "${H.label('job_types', 'swap_faulty')}" cho Logistics.` : 'Đã ghi nhận lỗi.';
        await after(msg);
      }
      async function infoForm(kit, after) {
        const r = await H.form({
          title: `Sửa thông tin kit ${kit.code}`,
          fields: [
            // Kit đang ở ngoài: mã gắn với phiếu, thẻ, việc đang chạy; máy chủ chỉ cho đổi mã khi kit đã về văn phòng.
            { name: 'code', label: 'Mã kit', required: true, value: kit.code, disabled: OUTSIDE.includes(kit.status), hint: OUTSIDE.includes(kit.status) ? 'Kit đang ở ngoài: đổi mã khi kit đã về văn phòng.' : null },
            { name: 'watch', label: 'Theo dõi', value: kit.watch, placeholder: 'VD: Đang chạy tạm dây USB-C', hint: 'Để trống để bỏ khỏi danh sách theo dõi.' },
            { name: 'note', label: 'Ghi chú', type: 'textarea', value: kit.note, rows: 2 },
          ],
          onSubmit: async (v) => {
            const b = {};
            if (v.code.toUpperCase() !== kit.code) b.code = v.code;
            if (v.watch !== (kit.watch || '')) b.watch = v.watch;
            if (v.note !== (kit.note || '')) b.note = v.note;
            if (!Object.keys(b).length) return true;
            await ctx.api('PATCH', `/api/hub/kits/${kit.id}`, b);
            return true;
          },
        });
        if (r) await after('Đã lưu thông tin kit.');
      }

      // ───────── Tab Thiết bị ─────────
      function devicesTab() {
        const st = { type: ctx.query.type || '', cond: ctx.query.cond || 'all', free: ctx.query.free === '1', q: ctx.query.q || '', rows: [], total: 0 };
        if (ctx.can(...TYPE_EDIT)) actBox.append(H.btn('Thêm thiết bị', () => addDevices(), 'primary'));
        const strip = h('div.kits-strip', H.loading(2));
        const chipsBox = h('div');
        const typeSel = h('select', { 'aria-label': 'Loại thiết bị', onchange: () => { st.type = typeSel.value; ctx.setQuery({ type: st.type }); paint(); } });
        const freeCb = h('input', { type: 'checkbox', checked: st.free, onchange: () => { st.free = freeCb.checked; ctx.setQuery({ free: st.free ? '1' : '' }); paint(); } });
        const search = H.search('Tìm mã thiết bị…', (v) => { st.q = v; ctx.setQuery({ q: v }); paint(); }, st.q);
        const table = H.table({
          columns: [
            { key: 'code', label: 'Mã', render: (d) => h('b.h-mono', d.code) },
            { key: 'type_name', label: 'Loại' },
            { key: 'cond', label: 'Tình trạng', value: (d) => H.label('dev_cond', d.cond), render: (d) => H.st('dev_cond', d.cond) },
            { key: 'health', label: 'Sức khoẻ pin', value: (d) => HEALTH_RANK[d.health] || 0, render: (d) => healthPill(d.health) },
            { key: 'kit', label: 'Trong kit', value: (d) => (d.kit ? d.kit.code : ''), render: (d) => (d.kit ? [h('span', d.kit.code), h('small', H.label('kit_st', d.kit.status))] : h('span.h-muted', 'Chưa vào kit')) },
            { key: 'note', label: 'Ghi chú', render: (d) => d.note || null },
            { key: 'updated_at', label: 'Cập nhật', desc: true, nowrap: true, render: (d) => H.when(d.updated_at) },
          ],
          rows: [], sort: { key: 'code', dir: 1 },
          onRow: (d) => deviceDialog(d),
          rowTone: (d) => (d.cond === 'faulty' || d.cond === 'lost' ? 'lost' : d.cond === 'repairing' ? 'wait' : null),
          empty: 'Không có thiết bị nào khớp bộ lọc.',
        });
        const totalNote = h('p.sub.kits-total');
        H.clear(body, strip, h('div.h-tools', chipsBox, typeSel, h('label.kits-free', freeCb, h('span', 'Chỉ thiết bị chưa vào kit')), search), totalNote, table);
        const pass = (d) => (!st.type || d.type === st.type) && (st.cond === 'all' || d.cond === st.cond) && (!st.free || !d.kit) && (!st.q || H.match(`${d.code} ${d.note}`, st.q));
        function paint() {
          const counts = { all: 0 };
          for (const d of st.rows) if ((!st.type || d.type === st.type) && (!st.free || !d.kit)) { counts.all++; counts[d.cond] = (counts[d.cond] || 0) + 1; }
          const cond = M().dev_cond || {};
          H.clear(chipsBox, H.chips([{ key: 'all', label: 'Tất cả', count: counts.all }, ...Object.keys(cond).filter((k) => counts[k] || k === st.cond).map((k) => ({ key: k, label: cond[k], count: counts[k] || 0 }))], st.cond, (k) => { st.cond = k; ctx.setQuery({ cond: k === 'all' ? '' : k }); paint(); }));
          const rows = st.rows.filter(pass);
          table.update(rows);
          totalNote.textContent = st.total > st.rows.length ? `Đang hiện ${H.num(st.rows.length)}/${H.num(st.total)} thiết bị đầu tiên theo mã; gõ mã để tìm.` : '';
          totalNote.hidden = !totalNote.textContent;
        }
        function paintTypes() {
          const devTypes = [...S.types.values()].filter((t) => t.kind === 'device');
          H.clear(typeSel, h('option', { value: '' }, 'Mọi loại'), devTypes.map((t) => h('option', { value: t.id, selected: t.id === st.type }, t.name)));
        }
        function paintStrip(sum) {
          H.clear(strip, H.kpis(...sum.devices.filter((d) => d.total || d.retired || d.lost).map((d) => H.kpi({
            label: `${d.name} rảnh`, value: d.free, tone: d.core && !d.free ? 'wait' : null,
            hint: `Tổng ${d.total} · trong kit ở VP ${d.in_office_kits} · ở ngoài ${d.outside}${d.faulty + d.repairing ? ` · hỏng / sửa ${d.faulty + d.repairing}` : ''}`,
            onClick: () => { st.type = d.id; st.free = true; freeCb.checked = true; typeSel.value = d.id; ctx.setQuery({ type: d.id, free: '1' }); paint(); },
          }))));
          if (!strip.firstChild.childElementCount) H.clear(strip, H.note('Chưa có thiết bị nào trong kho. Bấm "Thêm thiết bị" và dán danh sách mã.'));
        }
        const loadStrip = H.async(strip, async () => { const sum = await ctx.api('GET', '/api/hub/stock/summary'); if (ctx.alive()) paintStrip(sum); return undefined; });
        async function load() {
          const [j] = await Promise.all([ctx.api('GET', '/api/hub/devices', null, { limit: 2000 }), typesReady]);
          if (!ctx.alive()) return;
          st.rows = j.devices; st.total = j.total;
          paintTypes(); paint();
        }
        load().catch((e) => table.replaceWith(H.error(e, () => renderTab())));
        S.refresh = () => { loadStrip(); return load(); };
      }
      async function addDevices() {
        await typesReady;
        const devTypes = [...S.types.values()].filter((t) => t.kind === 'device' && t.active);
        const r = await H.form({
          title: 'Thêm thiết bị vào kho',
          intro: 'Dán danh sách mã cùng một loại (cách nhau bởi dấu cách, dấu phẩy hoặc xuống dòng). Mã đã có thì bỏ qua và báo lại. Thẻ nhớ thêm ở mục "Thẻ nhớ & bàn giao".',
          submit: 'Thêm',
          fields: [
            { name: 'type', label: 'Loại thiết bị', type: 'select', options: devTypes.map((t) => [t.id, t.name]), required: true, full: true },
            { name: 'codes', label: 'Mã thiết bị', type: 'codes', required: true, rows: 5, placeholder: 'MC013 MC014 MC015' },
            { name: 'note', label: 'Ghi chú', placeholder: 'VD: Lô mua tháng 10', full: true },
          ],
          onSubmit: async (v, c) => {
            if (!v.codes.length) { c.setErr('Cần nhập ít nhất một mã.'); return false; }
            if (v.codes.length > 2000) { c.setErr('Tối đa 2000 mã mỗi lần.'); return false; }
            return ctx.api('POST', '/api/hub/devices', { type: v.type, codes: v.codes, note: v.note });
          },
        });
        if (!r) return;
        ARL.toast(r.added ? `Đã thêm ${r.added} thiết bị${r.duplicates.length ? `. Bỏ qua ${r.duplicates.length} mã đã có: ${r.duplicates.slice(0, 8).join(', ')}${r.duplicates.length > 8 ? '…' : ''}` : ''}.` : `Không thêm mã nào: ${r.duplicates.length} mã đã có trong kho.`, !r.added);
        if (S.refresh) S.refresh();
      }
      function deviceDialog(d) {
        const err = errLine();
        const body = h('div.h-stack');
        let m = null;
        const after = async (msg) => { if (msg) ARL.toast(msg); if (m) m.close(); if (S.refresh) S.refresh(); };
        const acts = [
          act(err, 'Sửa tình trạng, ghi chú', () => deviceForm(d, after), 'primary'),
          d.kit && FAULTY_FROM.includes(d.kit.status) && d.cond === 'ok' ? act(err, 'Báo hỏng (cả kit)', async () => {
            const j = await ctx.api('GET', `/api/hub/kits/${d.kit.id}`);
            await faultyForm(j.kit, d.id, after);
          }, 'danger') : null,
          d.kit ? h('button', { type: 'button', onclick: () => { m.close(); ctx.setParams([d.kit.id]); } }, `Mở kit ${d.kit.code}`) : null,
        ].filter(Boolean);
        body.append(
          h('div.kits-facts', H.st('dev_cond', d.cond), healthPill(d.health), H.pill(d.type_name, 'off')),
          H.dl([['Trong kit', d.kit ? `${d.kit.code} · ${H.label('kit_st', d.kit.status)}` : 'Chưa vào kit (kho lẻ)'], ['Ghi chú', d.note || null], ['Cập nhật', H.when(d.updated_at)]]),
          err, h('div.h-row', acts));
        m = ARL.modal({ title: `Thiết bị ${d.code}`, body });
      }
      async function deviceForm(d, after) {
        const cond = M().dev_cond || {};
        // Thiết bị đã báo hỏng / đang sửa: Tech kiểm rồi xác nhận "Tốt"; Logistics không xoá cờ hỏng (khớp PATCH /devices/:id).
        const techOnly = ['faulty', 'repairing'].includes(d.cond) && !ctx.can('admin', 'tech_lead', 'tech');
        const allowed = [...(techOnly ? [] : ['ok', 'repairing']), ...(ctx.can(...DEV_FINAL) ? ['retired', 'lost'] : [])];
        if (!allowed.includes(d.cond)) allowed.unshift(d.cond); // giữ tình trạng hiện tại (vd. "Hỏng" chỉ đổi qua nút Báo hỏng)
        const ks = d.kit ? d.kit.status : null;
        const locked = ks === 'delivering';
        const intro = locked ? `Kit ${d.kit.code} đang trên đường giao: chưa đổi tình trạng được. Đợi FO giao xong hoặc huỷ chuyến rồi ghi nhận.`
          : ks && LOCKED_OFFICE.includes(ks) ? `Thiết bị đang trong kit ${d.kit.code} đã chốt thành phần: đổi sang tình trạng khác "Tốt" thì kit quay về "Đang chuẩn bị" để bổ sung và kiểm lại.`
            : ks === 'at_bo' ? `Kit ${d.kit.code} đang ở BO: đổi sang tình trạng khác "Tốt" sẽ tạo việc "${H.label('job_types', 'swap_faulty')}" cho Logistics.`
              : techOnly ? `Thiết bị đang "${cond[d.cond] || d.cond}": Tech kiểm rồi xác nhận "Tốt".`
                : d.kit ? 'Ngừng dùng hoặc thất lạc thì thiết bị tự rời kit.' : 'Thiết bị hỏng chưa vào kit: chọn "Đang sửa". Thiết bị trong kit thì báo hỏng ở kit.';
        const r = await H.form({
          title: `Sửa thiết bị ${d.code}`, intro,
          fields: [
            { name: 'code', label: 'Mã thiết bị', required: true, value: d.code },
            { name: 'cond', label: 'Tình trạng', type: 'select', options: allowed.map((k) => [k, cond[k] || k]), value: d.cond, disabled: locked },
            { name: 'health', label: 'Sức khoẻ pin', type: 'select', options: [['', 'Chưa đánh giá'], ...Object.entries(M().health || {})], value: d.health || '' },
            { name: 'reason', label: 'Lý do đổi tình trạng', placeholder: 'VD: Rơi vỡ màn hình' },
            { name: 'note', label: 'Ghi chú', type: 'textarea', value: d.note, rows: 2 },
          ],
          onSubmit: async (v, c) => {
            const b = {};
            if (v.code.toUpperCase() !== d.code) b.code = v.code;
            if (!locked && v.cond && v.cond !== d.cond) {
              if (v.cond !== 'ok' && v.reason.length < 3) { c.setErr('Ghi lý do đổi tình trạng.'); return false; }
              b.cond = v.cond; if (v.reason) b.reason = v.reason;
            }
            if ((v.health || null) !== (d.health || null)) b.health = v.health || null;
            if (v.note !== (d.note || '')) b.note = v.note;
            if (!Object.keys(b).length) return true;
            await ctx.api('PATCH', `/api/hub/devices/${d.id}`, b);
            return true;
          },
        });
        if (r) await after(`Đã lưu thiết bị ${d.code}.`);
      }

      // ───────── Tab Loại thiết bị ─────────
      function typesTab() {
        const canEdit = ctx.can(...TYPE_EDIT);
        if (canEdit) actBox.append(H.btn('Thêm loại', () => typeForm(null), 'primary'));
        let sum = null;
        const count = (t) => {
          if (!sum) return null;
          if (t.kind === 'acc') return t.total || 0;
          if (t.kind === 'card') return Object.values(sum.cards || {}).reduce((a, n) => a + n, 0);
          const d = sum.devices.find((x) => x.id === t.id);
          return d ? d.total : 0;
        };
        const table = H.table({
          columns: [
            { key: 'name', label: 'Tên loại', render: (t) => h('b', t.name) },
            { key: 'id', label: 'Mã loại', render: (t) => h('span.h-mono', t.id) },
            { key: 'kind', label: 'Cách quản lý', value: (t) => TYPE_KIND[t.kind] || t.kind },
            { key: 'core', label: 'Thiết bị chính', value: (t) => (t.core ? 1 : 0), render: (t) => (t.core ? 'Có' : h('span.h-muted', 'Không')) },
            { key: 'count', label: 'Số lượng', align: 'r', value: count, render: (t) => (count(t) === null ? '…' : H.num(count(t))) },
            { key: 'sort', label: 'Thứ tự', align: 'r' },
            { key: 'active', label: 'Trạng thái', value: (t) => (t.active ? 1 : 0), render: (t) => (t.active ? H.pill('Đang dùng', 'go') : H.pill('Ẩn khỏi danh sách chọn', 'off')) },
          ],
          rows: [], sort: { key: 'sort', dir: 1 }, onRow: canEdit ? (t) => typeForm(t) : null,
          empty: 'Chưa có loại nào.',
        });
        H.clear(body, H.note('Thiết bị và thẻ nhớ quản lý theo từng mã; phụ kiện quản lý theo số lượng (ở mục Phụ kiện). Thành phần bắt buộc của kit: Multicam KIT cần Multicam và CM5; iPhone Mono cần iPhone.'), h('div', { style: 'height: 12px' }), table);
        async function load() {
          const [j, s] = await Promise.all([ctx.api('GET', '/api/hub/types'), ctx.api('GET', '/api/hub/stock/summary')]);
          if (!ctx.alive()) return;
          S.types = new Map(j.types.map((t) => [t.id, t]));
          sum = s;
          table.update(j.types);
        }
        load().catch((e) => table.replaceWith(H.error(e, () => renderTab())));
        S.refresh = load;
      }
      async function typeForm(t) {
        if (!t) {
          const r = await H.form({
            title: 'Thêm loại vào danh mục', submit: 'Thêm loại',
            intro: 'Thiết bị theo mã: mỗi cái có mã riêng (Multicam, CM5, powerbank…). Phụ kiện theo số lượng: chỉ đếm tổng (hub sạc, dây cáp…).',
            fields: [
              { name: 'name', label: 'Tên loại', required: true, placeholder: 'VD: Gimbal', full: true },
              { name: 'kind', label: 'Cách quản lý', type: 'select', options: [['device', TYPE_KIND.device], ['acc', TYPE_KIND.acc]], value: 'acc', full: true },
              { name: 'core', label: 'Thiết bị chính của kit (không phải phụ kiện đi kèm)', type: 'checkbox', hint: 'Chỉ áp dụng cho thiết bị theo mã.', full: true },
              // Số lượng phụ kiện là sổ kho của Logistics: Tech Lead thêm loại, Logistics ghi số.
              ctx.can(...LOGI) ? { name: 'total', label: 'Số lượng hiện có', type: 'number', min: 0, step: 1, hint: 'Chỉ cho phụ kiện. Ghi vào sổ kho như một lần "Nhập thêm".' } : null,
            ].filter(Boolean),
            onSubmit: async (v, c) => {
              if (v.kind === 'acc' && v.total != null && !intOk(v.total, 0, 1e6)) { c.setErr('Số lượng phải là số nguyên từ 0.'); return false; }
              const b = { name: v.name, kind: v.kind, core: v.kind === 'device' && v.core };
              if (v.kind === 'acc' && v.total) b.total = v.total;
              return ctx.api('POST', '/api/hub/types', b);
            },
          });
          if (r && r.type) { ARL.toast(`Đã thêm loại "${r.type.name}".`); await loadTypes(); if (S.refresh) S.refresh(); }
          return;
        }
        const r = await H.form({
          title: `Sửa loại "${t.name}"`,
          intro: t.kind === 'acc' ? 'Đổi số lượng phụ kiện ở mục Phụ kiện (có sổ kho, bắt buộc lý do).' : null,
          fields: [
            { name: 'name', label: 'Tên loại', required: true, value: t.name, full: true },
            { name: 'active', label: 'Đang dùng (hiện trong danh sách chọn khi tạo kit, thêm thiết bị)', type: 'checkbox', value: !!t.active, full: true },
          ],
          onSubmit: async (v) => {
            const b = {};
            if (v.name !== t.name) b.name = v.name;
            if (v.active !== !!t.active) b.active = v.active;
            if (!Object.keys(b).length) return true;
            await ctx.api('PATCH', `/api/hub/types/${enc(t.id)}`, b);
            return true;
          },
        });
        if (r) { ARL.toast('Đã lưu loại.'); await loadTypes(); if (S.refresh) S.refresh(); }
      }

      // ───────── Điều hướng, cập nhật trực tiếp ─────────
      const det = detailRouter(ctx, () => (ctx.params[0] ? String(ctx.params[0]) : null), (id, onClose) => openKit(id, onClose));
      ctx.onRoute(() => {
        const t = tabOf(ctx.query.tab);
        if (t !== S.tab) { S.tab = t; tabs.set(t); renderTab(); }
        det.sync();
      });
      ctx.live(['kits', 'devices', 'types', 'acc'], () => { if (S.refresh) return S.refresh(); });
      ctx.live(['types'], loadTypes);
      renderTab();
      det.sync();
    },
  });

  // ═════════════ Phụ kiện ═════════════
  ARL.hub.view('acc', {
    mount(el, ctx) {
      const canMove = ctx.can(...LOGI);
      const canType = ctx.can(...TYPE_EDIT);
      const S = { rows: [], need: {}, kinds: {}, q: ctx.query.q || '', hidden: ctx.query.hidden === '1' };
      el.append(H.head('Phụ kiện', canMove
        ? 'Phụ kiện đếm theo số lượng. Số rảnh tự trừ khi phụ kiện vào kit và tự cộng khi gỡ ra. Khi số tài sản thay đổi (mua thêm, hỏng, thanh lý, kiểm kê), ghi vào sổ kho kèm lý do.'
        : 'Phụ kiện đếm theo số lượng. Số rảnh tự trừ khi phụ kiện vào kit và tự cộng khi gỡ ra. Logistics ghi sổ kho khi số tài sản thay đổi.',
      canType ? H.btn('Thêm loại phụ kiện', () => addType(), canMove ? '' : 'primary') : null));
      const kpis = h('div.kits-strip', H.loading(2));
      const warn = h('div.acc-warn');
      const hiddenCb = h('input', { type: 'checkbox', checked: S.hidden, onchange: () => { S.hidden = hiddenCb.checked; ctx.setQuery({ hidden: S.hidden ? '1' : '' }); paint(); } });
      const search = H.search('Tìm phụ kiện…', (v) => { S.q = v; ctx.setQuery({ q: v }); paint(); }, S.q);
      const needOf = (a) => S.need[a.id] || 0;
      const table = H.table({
        columns: [
          { key: 'name', label: 'Phụ kiện', render: (a) => [h('b', a.name), a.active ? null : h('small', 'Đã ẩn khỏi danh sách chọn')] },
          { key: 'total', label: 'Tổng (sổ kho)', align: 'r', render: (a) => H.num(a.total) },
          { key: 'free', label: 'Rảnh trong kho', align: 'r', render: (a) => h('b.acc-free', { 'data-tone': needOf(a) > a.free ? 'wait' : a.free <= 0 && a.total > 0 ? 'lost' : null }, H.num(a.free)) },
          { key: 'in_office_kits', label: 'Trong kit ở VP', align: 'r', render: (a) => H.num(a.in_office_kits) },
          { key: 'outside', label: 'Đang ở ngoài (BO)', align: 'r', render: (a) => H.num(a.outside) },
          { key: 'with_fo', label: 'FO đang mang', align: 'r', render: (a) => (a.with_fo ? H.num(a.with_fo) : h('span.h-muted', '–')) },
          { key: 'need', label: 'Việc đang cần', align: 'r', value: needOf, render: (a) => (needOf(a) ? h('span', { class: needOf(a) > a.free ? 'acc-short' : null }, H.num(needOf(a))) : h('span.h-muted', '–')) },
          { key: 'act', label: 'Thao tác', sort: false, render: (a) => h('div.acc-acts', { onclick: (e) => e.stopPropagation() },
            canMove ? [H.btn('Nhập thêm', () => moveForm(a, 'in'), 'small'), H.btn('Ghi giảm', () => moveForm(a, 'out'), 'small'), H.btn('Kiểm kê', () => moveForm(a, 'count'), 'small')]
              : H.btn('Xem sổ kho', () => ctx.setParams([a.id]), 'small')) },
        ],
        rows: [], sort: null, onRow: (a) => ctx.setParams([a.id]),
        rowTone: (a) => (needOf(a) > a.free ? 'wait' : a.free <= 0 && a.total > 0 && a.active ? 'lost' : null),
        empty: canType ? 'Chưa có loại phụ kiện nào. Bấm "Thêm loại phụ kiện".' : 'Chưa có loại phụ kiện nào.',
      });
      el.append(kpis, warn, h('div.h-tools', search, h('label.kits-free', hiddenCb, h('span', 'Hiện cả loại đã ẩn'))), table, h('p.sub.acc-foot', 'Bấm vào một dòng để xem sổ kho (mọi lần nhập thêm, ghi giảm, kiểm kê, mất khi thu hồi) và tải CSV.'));
      const pass = (a) => (S.hidden || a.active) && H.match(a.name, S.q);
      function paint() {
        const rows = S.rows.filter(pass);
        table.update(rows);
        const act = S.rows.filter((a) => a.active);
        const sum = (k) => act.reduce((x, a) => x + (a[k] || 0), 0);
        H.clear(kpis, H.kpis(
          H.kpi({ label: 'Tổng phụ kiện (sổ kho)', value: sum('total'), hint: `${act.length} loại đang dùng` }),
          H.kpi({ label: 'Rảnh trong kho', value: sum('free'), tone: act.some((a) => a.total > 0 && a.free <= 0) || act.some((a) => needOf(a) > a.free) ? 'wait' : 'go', hint: 'Lấy được ngay để ráp kit hoặc giao bổ sung' }),
          H.kpi({ label: 'Trong kit ở văn phòng', value: sum('in_office_kits'), hint: 'Đang nằm trong kit chưa xuất' }),
          H.kpi({ label: 'Đang ở ngoài (BO)', value: sum('outside'), tone: 'blue', hint: 'Theo kit đang giao, đang quay, đang thu hồi' })));
        const lines = [];
        for (const a of act) {
          const n = needOf(a);
          if (n > a.free) lines.push(H.note(`${a.name}: việc giao bổ sung đang mở cần ${H.num(n)}, kho chỉ còn ${H.num(Math.max(0, a.free))} rảnh.${canMove ? ' Nếu đã mua thêm, bấm "Nhập thêm"; không thì lấy từ kit khác.' : ' Logistics cần nhập thêm hoặc lấy từ kit khác.'}`, 'wait'));
          else if (a.free <= 0 && a.total > 0) lines.push(H.note(`${a.name}: đã hết hàng rảnh (${H.num(a.in_kits)} đang nằm trong kit).`, 'lost'));
        }
        H.clear(warn, ...lines);
        warn.hidden = !lines.length;
      }
      async function load() {
        const j = await ctx.api('GET', '/api/hub/acc');
        if (!ctx.alive()) return;
        S.rows = j.acc; S.need = j.need || {}; S.kinds = j.kinds || M().acc_move || {};
        paint();
        return j;
      }
      load().catch((e) => { kpis.replaceChildren(); table.replaceWith(H.error(e, () => load())); });

      async function addType() {
        const r = await H.form({
          title: 'Thêm loại phụ kiện', submit: 'Thêm',
          fields: [
            { name: 'name', label: 'Tên phụ kiện', required: true, placeholder: 'VD: Kẹp gắn kệ', full: true },
            canMove ? { name: 'total', label: 'Số lượng hiện có', type: 'number', min: 0, step: 1, hint: 'Ghi vào sổ kho như một lần "Nhập thêm".' } : null,
          ].filter(Boolean),
          intro: canMove ? null : 'Số lượng do Logistics ghi vào sổ kho sau khi thêm loại.',
          onSubmit: async (v, c) => {
            if (v.total != null && !intOk(v.total, 0, 1e6)) { c.setErr('Số lượng phải là số nguyên từ 0.'); return false; }
            return ctx.api('POST', '/api/hub/types', { name: v.name, kind: 'acc', ...(v.total ? { total: v.total } : {}) });
          },
        });
        if (r && r.type) { ARL.toast(`Đã thêm "${r.type.name}".`); load(); }
      }

      const KIND_HELP = {
        in: { label: 'Nhập thêm', qty: 'Số lượng nhập thêm', hint: 'Mua mới, nhận thêm từ nơi khác.', ph: 'VD: Mua thêm theo đơn 10/2026' },
        out: { label: 'Ghi giảm', qty: 'Số lượng ghi giảm', hint: 'Hỏng, thanh lý, cho mượn hẳn. Chỉ ghi giảm được phần đang rảnh; phụ kiện trong kit thì gỡ khỏi kit trước.', ph: 'VD: 2 cái cháy cổng sạc, thanh lý' },
        found: { label: 'Tìm lại', qty: 'Số lượng tìm lại', hint: 'Phụ kiện đã ghi mất nay tìm thấy.', ph: 'VD: Tìm thấy trong thùng kit cũ' },
        count: { label: 'Kiểm kê', qty: 'Số rảnh đếm được', hint: 'Đếm số đang rảnh trong kho (không tính phụ kiện nằm trong kit hoặc FO đang mang đi giao). Chênh lệch được ghi vào sổ kho.', ph: 'VD: Kiểm kho thứ Sáu' },
      };
      /** Ghi biến động sổ kho: nhập thêm / ghi giảm / tìm lại / kiểm kê. */
      async function moveForm(a, kind) {
        let k = kind;
        const rk = ARL.reqKey(); // một khoá cho lần mở này: gửi lại sau khi mất mạng không ghi sổ hai lần
        const qty = h('input', { type: 'number', min: 0, step: 1, inputmode: 'numeric', required: true, autocomplete: 'off', oninput: () => preview() });
        const reason = h('textarea', { rows: 2, required: true });
        const qtyLab = h('span');
        const hint = h('p.sub');
        const pv = h('p.acc-preview', { 'aria-live': 'polite' });
        const seg = H.seg(Object.entries(KIND_HELP).map(([x, o]) => [x, o.label]), k, (x) => { k = x; paintKind(); });
        function paintKind() {
          const o = KIND_HELP[k];
          qtyLab.textContent = o.qty + ' *';
          hint.textContent = o.hint;
          reason.placeholder = o.ph;
          qty.min = k === 'count' ? 0 : 1;
          if (k === 'count' && qty.value === '') qty.value = Math.max(0, a.free);
          preview();
        }
        function delta() {
          const n = Number(qty.value);
          if (qty.value === '' || !Number.isInteger(n) || n < 0) return null;
          return k === 'count' ? n - a.free : k === 'out' ? -n : n;
        }
        function preview() {
          const d = delta();
          pv.dataset.tone = '';
          if (d === null) { pv.textContent = `Hiện có: tổng ${H.num(a.total)} · rảnh ${H.num(a.free)}.`; return; }
          if (k === 'out' && -d > a.free) { pv.dataset.tone = 'lost'; pv.textContent = `Chỉ còn ${H.num(Math.max(0, a.free))} rảnh trong kho; phần còn lại đang nằm trong kit.`; return; }
          pv.textContent = d === 0 ? 'Khớp sổ kho, không có chênh lệch.' : `Dự kiến sau khi ghi: tổng ${H.num(a.total + d)} (${d > 0 ? '+' : '−'}${H.num(Math.abs(d))}) · rảnh ${H.num(a.free + d)}.`;
        }
        const body = h('div.h-form', h('div.h-field', h('span', 'Loại ghi sổ'), seg), hint,
          h('div.h-fields', h('label.h-field', qtyLab, qty), h('div')), pv, fieldWrap('Lý do *', reason, 'Ghi rõ để người kiểm kho sau hiểu được.', true));
        paintKind();
        const r = await dlgForm({
          title: `Sổ kho · ${a.name}`, body, submit: 'Ghi sổ',
          onSubmit: async ({ setErr }) => {
            const n = Number(qty.value);
            if (qty.value === '' || !Number.isInteger(n) || n < (k === 'count' ? 0 : 1)) { setErr(k === 'count' ? 'Nhập số rảnh đếm được (số nguyên từ 0).' : 'Số lượng là số nguyên từ 1.'); qty.focus(); return false; }
            if (k === 'out' && n > a.free) { setErr(`Chỉ còn ${Math.max(0, a.free)} ${a.name} rảnh trong kho. Gỡ khỏi kit trước rồi ghi giảm.`); qty.focus(); return false; }
            const why = reason.value.trim();
            if (why.length < 3) { setErr('Cần ghi lý do (ít nhất 3 ký tự).'); reason.focus(); return false; }
            return ctx.api('POST', `/api/hub/acc/${enc(a.id)}/move`, k === 'count' ? { kind: k, free_counted: n, reason: why, req_key: rk } : { kind: k, qty: n, reason: why, req_key: rk });
          },
        });
        if (!r || r === true) return null;
        ARL.toast(r.delta ? `Đã ghi sổ: ${KIND_HELP[k].label} ${r.delta > 0 ? '+' : '−'}${Math.abs(r.delta)} ${a.name}. Tổng ${r.acc.total}, rảnh ${r.acc.free}.` : 'Số đếm khớp sổ kho, không có chênh lệch.');
        await load();
        return r;
      }

      // ───────── Sổ kho của một loại (#/acc/<id>) ─────────
      function openLedger(id, onClose) {
        const err = errLine();
        const body = h('div.acc-ledger', H.loading(5));
        const m = ARL.modal({ title: 'Sổ kho', body, wide: true, cls: 'acc-dlg', onClose });
        const title = m.el.querySelector('.dlg-head h2');
        let moves = [];
        const table = H.table({
          columns: [
            { key: 'at', label: 'Lúc', desc: true, nowrap: true, render: (x) => H.when(x.at) },
            { key: 'kind', label: 'Biến động', value: (x) => x.kind_label, render: (x) => x.kind_label },
            { key: 'delta', label: 'Số lượng', align: 'r', render: (x) => h('b.acc-delta', { 'data-tone': x.delta > 0 ? 'go' : 'lost' }, `${x.delta > 0 ? '+' : '−'}${H.num(Math.abs(x.delta))}`) },
            { key: 'total_after', label: 'Tổng sau', align: 'r', render: (x) => H.num(x.total_after) },
            { key: 'reason', label: 'Lý do', render: (x) => [x.reason || '–', x.kit || x.site ? h('small', [x.kit ? `Kit ${x.kit}` : '', x.site].filter(Boolean).join(' · ')) : null] },
            { key: 'by', label: 'Người ghi' },
          ],
          rows: [], sort: { key: 'at', dir: -1 }, pageSize: 50, cards: true, id: (x) => x.id,
          empty: 'Chưa có biến động nào trong sổ kho.',
        });
        async function reload() {
          try {
            const [j, s] = await Promise.all([ctx.api('GET', `/api/hub/acc/${enc(id)}/moves`, null, { limit: 1000 }), S.rows.length ? null : load()]);
            void s;
            moves = j.moves;
            const a = S.rows.find((x) => x.id === id) || { id, name: j.type.name, total: j.type.total, free: 0, in_office_kits: 0, outside: 0, active: true };
            title.textContent = `Sổ kho · ${a.name}`;
            table.update(moves);
            H.clear(body,
              h('div.kits-strip', H.kpis(
                H.kpi({ label: 'Tổng (sổ kho)', value: a.total }),
                H.kpi({ label: 'Rảnh trong kho', value: a.free, tone: a.free <= 0 ? 'lost' : 'go' }),
                H.kpi({ label: 'Trong kit ở VP', value: a.in_office_kits }),
                H.kpi({ label: 'Đang ở ngoài (BO)', value: a.outside, tone: 'blue' }))),
              S.need[a.id] ? H.note(`Việc giao bổ sung đang mở cần ${H.num(S.need[a.id])} ${a.name}.`, S.need[a.id] > a.free ? 'wait' : null) : null,
              err,
              h('div.h-row.acc-ledger-acts',
                canMove ? [act(err, 'Nhập thêm', () => moveForm(a, 'in').then((r) => r && reload()), 'primary'), act(err, 'Ghi giảm', () => moveForm(a, 'out').then((r) => r && reload())), act(err, 'Tìm lại', () => moveForm(a, 'found').then((r) => r && reload())), act(err, 'Kiểm kê', () => moveForm(a, 'count').then((r) => r && reload()))] : null,
                h('button.ghost', { type: 'button', disabled: !moves.length, onclick: () => csvDownload(`so-kho_${a.id}_${H.today()}.csv`, ['Lúc', 'Biến động', 'Số lượng', 'Tổng sau', 'Lý do', 'Kit', 'BO', 'Người ghi'], moves.map((x) => [H.when(x.at), x.kind_label, x.delta, x.total_after, x.reason || '', x.kit || '', x.site || '', x.by || ''])) }, 'Tải CSV')),
              table,
              h('p.sub', 'Mỗi dòng là một lần tổng số thay đổi. Phụ kiện vào kit hoặc gỡ khỏi kit không đổi tổng nên không có dòng ở đây; xem ở lịch sử từng kit.'));
          } catch (e) { if (!moves.length) H.clear(body, H.error(e, reload)); else showErr(err, e); }
        }
        reload();
        return m.close;
      }
      const det = detailRouter(ctx, () => (ctx.params[0] ? String(ctx.params[0]) : null), openLedger);
      ctx.onRoute(() => det.sync());
      ctx.live(['acc', 'types', 'kits', 'jobs'], () => load());
      det.sync();
    },
  });
})();
