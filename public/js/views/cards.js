/* Ops Hub — "Thẻ nhớ & bàn giao" (cards) và "Nhập dung lượng" (upload).
   Thẻ đi theo vòng: VP → BO → về VP → phiếu bàn giao sang Tech → Tech nhập dung lượng → phiếu trả Logistics → VP.
   Trạng thái thẻ do máy chủ tự đổi theo phiếu / chuyến; giờ quay = GB ÷ GB mỗi giờ, tính ở máy chủ (nguồn của Dashboard Kinh doanh). */
(() => {
  'use strict';
  const H = ARL.H, { h } = H;
  const V = ARL.hub.vstock;
  const { errLine, showErr, act, reasonForm, dlgForm, fieldWrap, logList, jobList, detailRouter, splitCodes } = V;

  // Quyền theo từng API (core/hub/cards.js, core/hub/stock.js)
  const LOGI = ['admin', 'lead', 'logistic'];
  const TECH = ['admin', 'tech_lead', 'tech'];
  const LEADS = ['admin', 'tech_lead', 'lead']; //               điều chỉnh trạng thái thẻ
  const CARD_ADD = ['admin', 'lead', 'logistic', 'tech_lead']; // thêm thẻ (POST /devices loại thẻ)
  const SENDER = { to_tech: LOGI, to_log: TECH };
  const RECEIVER = { to_tech: TECH, to_log: LOGI };
  const FROM_ST = { to_tech: 'returned', to_log: 'uploaded' };
  const NO_MANUAL = ['to_tech', 'to_log', 'with_fo']; //          chỉ đổi qua phiếu / chuyến FO
  const HO_TONE = { sent: 'wait', received: 'go', cancelled: 'off' };
  const HO_ST = { sent: 'Chờ bên nhận xác nhận', received: 'Đã nhận', cancelled: 'Đã huỷ' }; // trùng nhãn máy chủ trả trong phiếu
  const CARD_GROUPS = {
    field: { label: 'Ngoài hiện trường', st: ['with_fo', 'at_bo'] },
    tech: { label: 'Bên Tech', st: ['to_tech', 'at_tech', 'uploaded', 'to_log'] },
    broken: { label: 'Hỏng / thất lạc', st: ['bad', 'lost'] },
  };
  const M = () => ARL.hubMeta || {};
  const enc = encodeURIComponent;
  const sideOf = (ctx, dir, who) => ctx.can(...(who === 'send' ? SENDER : RECEIVER)[dir]);

  // ═════════════ Thẻ nhớ & bàn giao ═════════════
  ARL.hub.view('cards', {
    mount(el, ctx) {
      const tabOf = (t) => (t === 'handovers' ? 'handovers' : 'cards');
      const S = { tab: tabOf(ctx.query.tab), refresh: null, open: { to_tech: 0, to_log: 0 } };
      const actBox = h('div.h-actions');
      el.append(h('header.h-head', h('div.h-head-l', h('h1', 'Thẻ nhớ & bàn giao'),
        h('p.sub', 'Thẻ đi theo vòng VP → BO → về VP → Tech nhập dung lượng → trả Logistics. Trạng thái tự đổi theo phiếu bàn giao và chuyến FO.')), actBox));
      const tabsBox = h('div');
      const body = h('div.cards-body');
      el.append(tabsBox, body);
      // Số phiếu đang chờ chính mình xác nhận (hiện trên tab).
      const waitingMine = () => (sideOf(ctx, 'to_tech', 'recv') ? S.open.to_tech : 0) + (sideOf(ctx, 'to_log', 'recv') ? S.open.to_log : 0);
      function paintTabs() {
        H.clear(tabsBox, H.tabs([['cards', 'Thẻ nhớ'], ['handovers', 'Phiếu bàn giao', waitingMine()]], S.tab, (k) => {
          S.tab = k;
          ctx.setQuery({ tab: k === 'cards' ? '' : k, st: '', q: '', dir: '' });
          renderTab();
        }));
      }
      async function loadOpen() {
        try { const j = await ctx.api('GET', '/api/hub/handovers', null, { status: 'sent', limit: 1 }); S.open = j.open; paintTabs(); } catch (e) { console.error(e); }
      }
      function renderTab() {
        S.refresh = null;
        actBox.replaceChildren();
        paintTabs();
        if (S.tab === 'cards') cardsTab(); else handoversTab();
        actBox.hidden = !actBox.childElementCount;
      }

      // ───────── Tab Thẻ ─────────
      function cardsTab() {
        const st = { status: ctx.query.st || 'all', q: ctx.query.q || '', rows: [], counts: {}, total: 0, sig: '' };
        if (ctx.can(...CARD_ADD)) actBox.append(H.btn('Thêm thẻ', () => addCards(), 'primary'));
        if (ctx.can(...LOGI)) actBox.append(H.btn('Lập phiếu gửi Tech', () => createHandover('to_tech')));
        actBox.append(H.csv('/api/hub/export/cards.csv', null, 'Tải CSV'));
        const kpis = h('div.kits-strip', H.loading(2));
        const chipsBox = h('div.kits-chips');
        const search = H.search('Tìm mã thẻ, BO, kit…', (v) => { st.q = v; ctx.setQuery({ q: v }); paint(); }, st.q);
        const totalNote = h('p.sub', { hidden: true });
        const table = H.table({
          columns: [
            { key: 'code', label: 'Mã thẻ', render: (c) => h('b.h-mono', c.code) },
            { key: 'status', label: 'Trạng thái', value: (c) => H.label('card_st', c.status), render: (c) => H.st('card_st', c.status) },
            { key: 'site', label: 'BO', value: (c) => (c.site ? c.site.name : ''), render: (c) => (c.site ? c.site.name : null) },
            { key: 'kit', label: 'Kit', value: (c) => (c.kit ? c.kit.code : ''), render: (c) => (c.kit ? c.kit.code : null) },
            { key: 'since', label: 'Từ lúc', desc: true, nowrap: true, render: (c) => (c.since ? H.when(c.since) : null) },
            { key: 'note', label: 'Ghi chú', render: (c) => c.note || null },
          ],
          rows: [], sort: { key: 'code', dir: 1 },
          onRow: (c) => ctx.setParams([c.id]),
          rowTone: (c) => (c.status === 'bad' || c.status === 'lost' ? 'lost' : null),
          empty: 'Không có thẻ nào khớp bộ lọc.',
        });
        const cta = h('div');
        H.clear(body, kpis, cta, h('div.h-tools', chipsBox, search), totalNote, table);
        const pass = (c) => {
          if (st.status !== 'all') { if (CARD_GROUPS[st.status]) { if (!CARD_GROUPS[st.status].st.includes(c.status)) return false; } else if (c.status !== st.status) return false; }
          return !st.q || H.match(`${c.code} ${c.site ? c.site.name : ''} ${c.kit ? c.kit.code : ''} ${c.note}`, st.q);
        };
        const setStatus = (s) => { st.status = s; ctx.setQuery({ st: s === 'all' ? '' : s }); paintChips(true); paint(); };
        function paintChips(force) {
          const c = st.counts, cst = M().card_st || {};
          const keys = ['all', ...(CARD_GROUPS[st.status] ? [st.status] : []), ...Object.keys(cst).filter((k) => c[k] || k === st.status)];
          const opts = keys.map((k) => ({ key: k, label: k === 'all' ? 'Tất cả' : CARD_GROUPS[k] ? CARD_GROUPS[k].label : cst[k], count: k === 'all' ? Object.values(c).reduce((a, n) => a + n, 0) : CARD_GROUPS[k] ? CARD_GROUPS[k].st.reduce((a, s) => a + (c[s] || 0), 0) : c[k] || 0 }));
          const sig = keys.join(',');
          if (!force && sig === st.sig && chipsBox.firstChild) { chipsBox.firstChild.counts(Object.fromEntries(opts.map((o) => [o.key, o.count]))); return; }
          st.sig = sig;
          H.clear(chipsBox, H.chips(opts, st.status, setStatus));
        }
        function paintKpis() {
          const n = (s) => st.counts[s] || 0;
          const g = (k) => CARD_GROUPS[k].st.reduce((a, s) => a + n(s), 0);
          H.clear(kpis, H.kpis(
            H.kpi({ label: 'Sẵn sàng tại VP', value: n('office'), tone: 'go', hint: 'Mang đi đổi thẻ được', onClick: () => setStatus('office') }),
            H.kpi({ label: 'Ngoài hiện trường', value: g('field'), tone: 'blue', hint: `Ở BO ${n('at_bo')} · FO đang mang ${n('with_fo')}`, onClick: () => setStatus('field') }),
            H.kpi({ label: 'Đã thu về, chờ gửi Tech', value: n('returned'), tone: n('returned') ? 'wait' : null, hint: 'Logistics lập phiếu bàn giao', onClick: () => setStatus('returned') }),
            H.kpi({ label: 'Bên Tech', value: g('tech'), hint: `Chờ nhập ${n('at_tech')} · đã nhập ${n('uploaded')} · đang chuyển ${n('to_tech') + n('to_log')}`, onClick: () => setStatus('tech') }),
            H.kpi({ label: 'Hỏng / thất lạc', value: g('broken'), tone: g('broken') ? 'lost' : null, onClick: () => setStatus('broken') })));
          const ret = n('returned');
          H.clear(cta, ret && ctx.can(...LOGI) ? h('div.h-note.cards-cta', { 'data-tone': 'wait' }, h('span', `${ret} thẻ đã thu về văn phòng, chờ gửi Tech nhập dung lượng.`), H.btn('Lập phiếu gửi Tech', () => createHandover('to_tech'), 'small primary')) : null);
        }
        function paint() { table.update(st.rows.filter(pass)); }
        async function load() {
          const j = await ctx.api('GET', '/api/hub/cards', null, { limit: 3000 });
          if (!ctx.alive()) return;
          st.rows = j.cards; st.counts = j.counts; st.total = j.total;
          totalNote.hidden = j.total <= j.cards.length;
          totalNote.textContent = `Đang hiện ${H.num(j.cards.length)}/${H.num(j.total)} thẻ đầu tiên theo mã.`;
          paintKpis(); paintChips(); paint();
        }
        load().catch((e) => { kpis.replaceChildren(); table.replaceWith(H.error(e, () => renderTab())); });
        S.refresh = load;
      }
      async function addCards() {
        const tj = await ctx.api('GET', '/api/hub/types');
        const types = tj.types.filter((t) => t.kind === 'card' && t.active);
        if (!types.length) { ARL.toast('Danh mục chưa có loại thẻ nhớ đang dùng.', true); return; }
        const r = await H.form({
          title: 'Thêm thẻ nhớ vào kho', submit: 'Thêm thẻ',
          intro: 'Dán danh sách mã thẻ (cách nhau bởi dấu cách, dấu phẩy hoặc xuống dòng). Thẻ mới ở trạng thái "Sẵn sàng tại VP". Mã đã có thì bỏ qua và báo lại.',
          fields: [
            types.length > 1 ? { name: 'type', label: 'Loại thẻ', type: 'select', options: types.map((t) => [t.id, t.name]), full: true } : { name: 'type', type: 'hidden', value: types[0].id },
            { name: 'codes', label: 'Mã thẻ', type: 'codes', required: true, rows: 5, placeholder: 'SD101 SD102 SD103' },
            { name: 'note', label: 'Ghi chú', placeholder: 'VD: Lô thẻ 128 GB tháng 10', full: true },
          ],
          onSubmit: async (v, c) => {
            if (!v.codes.length) { c.setErr('Cần nhập ít nhất một mã thẻ.'); return false; }
            return ctx.api('POST', '/api/hub/devices', { type: v.type || types[0].id, codes: v.codes, note: v.note });
          },
        });
        if (!r) return;
        ARL.toast(r.added ? `Đã thêm ${r.added} thẻ${r.duplicates.length ? `. Bỏ qua ${r.duplicates.length} mã đã có: ${r.duplicates.slice(0, 8).join(', ')}${r.duplicates.length > 8 ? '…' : ''}` : ''}.` : `Không thêm thẻ nào: ${r.duplicates.length} mã đã có.`, !r.added);
        if (S.refresh) S.refresh();
      }

      // ───────── Chi tiết thẻ (#/cards/<id>) ─────────
      function openCard(id, onClose) {
        const err = errLine();
        const body = h('div.cards-det', H.loading(5));
        const m = ARL.modal({ title: 'Thẻ nhớ', body, wide: true, cls: 'kits-dlg', onClose });
        const title = m.el.querySelector('.dlg-head h2');
        let data = null;
        async function reload() {
          try { data = await ctx.api('GET', `/api/hub/cards/${enc(id)}`); paint(); } catch (e) { if (!data) H.clear(body, H.error(e, reload)); else showErr(err, e); }
        }
        const after = async (msg) => { if (msg) ARL.toast(msg); await reload(); if (S.refresh) S.refresh(); };
        function paint() {
          const c = data.card;
          title.textContent = `Thẻ ${c.code}`;
          const inHo = ['to_tech', 'to_log'].includes(c.status);
          const acts = [];
          if (ctx.can(...LEADS) && !inHo) acts.push(act(err, 'Điều chỉnh trạng thái', () => statusForm(c, after)));
          else if (ctx.can('tech') && ['at_tech', 'uploaded'].includes(c.status)) acts.push(act(err, 'Báo thẻ hỏng', () => reasonForm(`Báo thẻ ${c.code} hỏng`, {
            intro: 'Thẻ chuyển sang "Hỏng" và Logistic Lead được báo. Thẻ chưa nhập dung lượng thì việc nhập của phiếu tự tính là xong phần thẻ này; Sale phụ trách BO được báo giờ quay của khoảng đó có thể thiếu và thẻ vào mục Đối chiếu của Tech (hệ thống không tự đặt giờ).',
            label: 'Mô tả lỗi', danger: true, submit: 'Báo hỏng', placeholder: 'VD: Máy không đọc được thẻ',
            run: async (reason) => { await ctx.api('PATCH', `/api/hub/cards/${c.id}`, { status: 'bad', reason }); await after(`Đã ghi thẻ ${c.code} hỏng.`); },
          }), 'danger'));
          acts.push(act(err, 'Sửa ghi chú', async () => {
            const r = await H.form({ title: `Ghi chú thẻ ${c.code}`, fields: [{ name: 'note', label: 'Ghi chú', type: 'textarea', value: c.note, rows: 3 }], onSubmit: async (v) => { if (v.note !== (c.note || '')) await ctx.api('PATCH', `/api/hub/cards/${c.id}`, { note: v.note }); return true; } });
            if (r) await after('Đã lưu ghi chú.');
          }, 'ghost'));
          const hoHref = c.handover_id ? `#/cards/${c.handover_id}?tab=handovers` : null;
          const siteHref = c.site ? ctx.linkTo(`outlet:${c.site.id}`) : null;
          const kitHref = c.kit ? ctx.linkTo(`kit:${c.kit.id}`) : null;
          const recs = data.records || [];
          const recTable = H.table({
            columns: [
              { key: 'shoot_date', label: 'Ngày quay', render: (r) => H.dmy(r.shoot_date) },
              { key: 'gb', label: 'GB', align: 'r', render: (r) => H.num(r.gb, 1) },
              { key: 'hours', label: 'Giờ quay', align: 'r', render: (r) => H.num(r.hours, 2) },
              { key: 'site', label: 'BO', value: (r) => (r.site ? r.site.name : ''), render: (r) => (r.site ? r.site.name : h('span.h-muted', 'Chưa rõ BO')) },
              { key: 'zero_reason', label: 'Lý do 0 giờ', render: (r) => r.zero_reason || null },
              // Người nhập là số theo từng người của Tech: team khác chỉ thấy lúc nhập.
              ctx.can('admin', 'tech_lead', 'tech') ? { key: 'by', label: 'Người nhập', value: (r) => (r.by ? r.by.name : ''), render: (r) => [r.by ? r.by.name : '–', h('small', H.when(r.at))] }
                : { key: 'at', label: 'Lúc nhập', value: (r) => r.at, render: (r) => H.when(r.at) },
            ],
            rows: recs, sort: null, pageSize: 20, empty: 'Thẻ chưa có lần nhập dung lượng nào.',
          });
          H.clear(body,
            h('div.kits-top', h('div.kits-facts', H.st('card_st', c.status), c.since ? h('span.sub', `từ ${H.when(c.since)}`) : null), h('div.h-row.kits-acts', acts), err,
              inHo ? H.note('Thẻ đang nằm trong một phiếu bàn giao chưa xác nhận: trạng thái đổi khi bên nhận xác nhận hoặc bên gửi huỷ phiếu.') : null),
            h('div.kits-det-grid',
              h('div.h-stack', H.card('Thông tin', H.dl([
                ['BO', c.site ? (siteHref ? H.link(siteHref, c.site.name) : c.site.name) : null],
                ['Kit', c.kit ? (kitHref ? H.link(kitHref, c.kit.code) : c.kit.code) : null],
                ['Vào BO lúc', c.bo_in ? H.when(c.bo_in) : null],
                ['Rời BO lúc', c.bo_out ? H.when(c.bo_out) : null],
                ['Phiếu bàn giao', hoHref ? H.link(hoHref, 'Xem phiếu gần nhất') : null],
                ['Ghi chú', c.note || null],
              ])), H.card('Dung lượng đã nhập', recTable)),
              h('div.h-stack', H.card('Lịch sử', logList(data.log)))));
        }
        reload();
        return m.close;
      }
      async function statusForm(c, after) {
        const cst = M().card_st || {};
        const opts = Object.keys(cst).filter((k) => !NO_MANUAL.includes(k) && k !== c.status).map((k) => [k, cst[k]]);
        const p = H.form({
          title: `Điều chỉnh trạng thái thẻ ${c.code}`,
          intro: 'Chỉ dùng để sửa cho khớp thực tế. Thẻ đi theo phiếu bàn giao hoặc chuyến FO thì hệ thống tự đổi; ghi "Hỏng" hoặc "Thất lạc" sẽ báo Logistic Lead. Thẻ chưa nhập dung lượng mà hỏng / thất lạc thì Sale phụ trách BO được báo có thể thiếu giờ quay và thẻ vào mục Đối chiếu của Tech.',
          submit: 'Lưu',
          fields: [
            { name: 'status', label: 'Trạng thái mới', type: 'select', options: opts, required: true, full: true, empty: '— Chọn —' },
            { name: 'site_id', label: 'BO đang giữ thẻ', type: 'select', options: c.site ? [[c.site.id, c.site.name]] : [], empty: c.site ? null : '— Chọn BO —', full: true },
            { name: 'reason', label: 'Lý do', type: 'textarea', required: true, rows: 2, placeholder: 'VD: Kiểm kho thấy thẻ nằm trong túi kit K-MC-03' },
          ],
          onSubmit: async (v, cc) => {
            if (v.reason.length < 3) { cc.setErr('Ghi rõ lý do (ít nhất 3 ký tự).'); return false; }
            const b = { status: v.status, reason: v.reason };
            if (v.status === 'at_bo') { if (!v.site_id) { cc.setErr('Chọn BO đang giữ thẻ.'); return false; } b.site_id = Number(v.site_id); }
            await ctx.api('PATCH', `/api/hub/cards/${c.id}`, b);
            return true;
          },
        });
        // Ô chọn BO chỉ hiện khi chọn "Đang ở BO"; danh sách BO nạp khi cần.
        const dlg = [...document.querySelectorAll('dialog.dlg')].pop();
        const stSel = dlg && dlg.querySelector('select[name="status"]'), siteSel = dlg && dlg.querySelector('select[name="site_id"]');
        if (stSel && siteSel) {
          const field = siteSel.closest('.h-field');
          field.hidden = true;
          stSel.addEventListener('change', async () => {
            field.hidden = stSel.value !== 'at_bo';
            if (field.hidden || siteSel.dataset.filled) return;
            siteSel.dataset.filled = '1';
            try {
              const list = (await ctx.api('GET', '/api/hub/outlets')).outlets;
              const have = new Set([...siteSel.options].map((o) => o.value));
              for (const o of list) if (!have.has(String(o.id))) siteSel.append(h('option', { value: o.id }, o.name));
            } catch (e) { siteSel.dataset.filled = ''; console.error(e); }
          });
        }
        if (await p) await after(`Đã cập nhật thẻ ${c.code}.`);
      }

      // ───────── Tab Phiếu bàn giao ─────────
      function handoversTab() {
        const st = { status: ctx.query.st || 'sent', dir: ctx.query.dir || '', rows: [], q: ctx.query.q || '' };
        if (ctx.can(...LOGI)) actBox.append(H.btn('Lập phiếu gửi Tech', () => createHandover('to_tech'), 'primary'));
        if (ctx.can(...TECH)) actBox.append(H.btn('Lập phiếu trả Logistics', () => createHandover('to_log'), ctx.can(...LOGI) ? '' : 'primary'));
        const note = h('div');
        const chipsBox = h('div');
        const dirSel = h('select', { 'aria-label': 'Chiều bàn giao', onchange: () => { st.dir = dirSel.value; ctx.setQuery({ dir: st.dir }); paint(); } },
          h('option', { value: '' }, 'Cả hai chiều'), h('option', { value: 'to_tech', selected: st.dir === 'to_tech' }, 'Logistics → Tech'), h('option', { value: 'to_log', selected: st.dir === 'to_log' }, 'Tech → Logistics'));
        const search = H.search('Tìm mã phiếu, người gửi…', (v) => { st.q = v; ctx.setQuery({ q: v }); paint(); }, st.q);
        const mineToRecv = (x) => x.status === 'sent' && sideOf(ctx, x.dir, 'recv');
        const table = H.table({
          columns: [
            { key: 'code', label: 'Mã phiếu', render: (x) => [h('b.h-mono', x.code), mineToRecv(x) ? h('small.cards-mine', 'Chờ bạn xác nhận') : null] },
            { key: 'dir', label: 'Chiều', value: (x) => x.dir_label },
            { key: 'status', label: 'Trạng thái', value: (x) => x.status_label, render: (x) => H.pill(x.status_label, HO_TONE[x.status] || 'off') },
            { key: 'lines', label: 'Số thẻ', align: 'r', render: (x) => (x.status === 'received' ? `${H.num(x.recv)}/${H.num(x.lines)}` : H.num(x.lines)) },
            { key: 'from', label: 'Bên gửi', value: (x) => (x.from ? x.from.name : ''), render: (x) => (x.from ? x.from.name : null) },
            { key: 'to', label: 'Bên nhận', value: (x) => (x.to ? x.to.name : ''), render: (x) => (x.to ? x.to.name : null) },
            { key: 'created_at', label: 'Lập lúc', desc: true, nowrap: true, render: (x) => H.when(x.created_at) },
            { key: 'received_at', label: 'Nhận lúc', desc: true, nowrap: true, render: (x) => (x.received_at ? H.when(x.received_at) : null) },
          ],
          rows: [], sort: { key: 'created_at', dir: -1 },
          onRow: (x) => ctx.setParams([x.id], { ...ctx.query, tab: 'handovers' }),
          rowTone: (x) => (mineToRecv(x) ? 'wait' : x.status === 'received' && x.recv < x.lines ? 'lost' : null),
          empty: 'Không có phiếu nào khớp bộ lọc.',
        });
        H.clear(body, note, h('div.h-tools', chipsBox, dirSel, search), table);
        const pass = (x) => (st.status === 'all' || x.status === st.status) && (!st.dir || x.dir === st.dir) && (!st.q || H.match(`${x.code} ${x.from ? x.from.name : ''} ${x.to ? x.to.name : ''} ${x.note}`, st.q));
        function paint() {
          const c = { all: st.rows.length };
          for (const x of st.rows) c[x.status] = (c[x.status] || 0) + 1;
          H.clear(chipsBox, H.chips([['sent', HO_ST.sent], ['received', 'Đã nhận'], ['cancelled', 'Đã huỷ'], ['all', 'Tất cả']].map(([k, l]) => ({ key: k, label: l, count: c[k] || 0 })), st.status, (k) => { st.status = k; ctx.setQuery({ st: k === 'sent' ? '' : k }); paint(); }));
          table.update(st.rows.filter(pass));
          const mine = st.rows.filter(mineToRecv).length;
          H.clear(note, mine ? H.note(`Có ${mine} phiếu đang chờ bạn xác nhận đã nhận thẻ. Mở phiếu, đánh dấu từng thẻ (hoặc quét mã) rồi xác nhận.`, 'wait') : null);
          note.hidden = !mine;
        }
        async function load() {
          const j = await ctx.api('GET', '/api/hub/handovers', null, { limit: 500 });
          if (!ctx.alive()) return;
          st.rows = j.handovers; S.open = j.open; paintTabs();
          paint();
        }
        load().catch((e) => table.replaceWith(H.error(e, () => renderTab())));
        S.refresh = load;
      }

      /** Lập phiếu: gợi ý thẻ đúng trạng thái (gom theo BO), chọn sẵn tất cả; có thể quét / dán thêm mã. */
      async function createHandover(dir) {
        const sug = await ctx.api('GET', '/api/hub/handovers/suggest', null, { dir });
        const label = dir === 'to_tech' ? 'Logistics → Tech' : 'Tech → Logistics';
        const fromLabel = H.label('card_st', FROM_ST[dir]);
        const boxes = [];
        const counter = h('p.cards-counter', { 'aria-live': 'polite' });
        const groups = sug.groups.map((g) => {
          const all = h('input', { type: 'checkbox', checked: true, 'aria-label': `Chọn cả ${g.site ? g.site.name : 'nhóm'}` });
          const items = g.cards.map((c) => { const cb = h('input', { type: 'checkbox', checked: true, value: c.code }); boxes.push(cb); return h('label.cards-chip', cb, h('span.h-mono', c.code)); });
          const own = boxes.slice(-items.length);
          all.addEventListener('change', () => { for (const b of own) b.checked = all.checked; count(); });
          for (const b of own) b.addEventListener('change', () => { all.checked = own.every((x) => x.checked); count(); });
          return h('div.cards-group', h('label.cards-group-h', all, h('b', g.site ? g.site.name : 'Không rõ BO'), h('span.sub', `${g.cards.length} thẻ`)), h('div.cards-chips', items));
        });
        const extra = h('textarea', { rows: 2, spellcheck: 'false', placeholder: 'Quét hoặc dán thêm mã thẻ, cách nhau bởi dấu cách', oninput: () => count() });
        const note = h('textarea', { rows: 2, placeholder: 'Ghi chú cho bên nhận (không bắt buộc)' });
        function picked() { return [...new Set([...boxes.filter((b) => b.checked).map((b) => b.value), ...splitCodes(extra.value)])]; }
        function count() { const n = picked().length; counter.textContent = n ? `Đã chọn ${n} thẻ.` : 'Chưa chọn thẻ nào.'; }
        const body = h('div.h-form',
          h('p.sub', dir === 'to_tech' ? 'Gửi các thẻ đã thu về văn phòng sang Tech. Tech nhận thông báo và việc "Nhận thẻ từ Logistics"; thẻ chỉ đổi sang "Tech đã nhận" khi Tech xác nhận.' : 'Trả các thẻ đã nhập dung lượng về Logistics. Logistics nhận thông báo và xác nhận từng thẻ.'),
          sug.waiting_upload ? H.note(`Còn ${sug.waiting_upload} thẻ Tech đã nhận nhưng chưa nhập dung lượng; các thẻ này chưa trả về được.`, 'wait') : null,
          groups.length ? h('div.cards-groups', groups) : H.note(`Không có thẻ nào ở trạng thái "${fromLabel}".`),
          fieldWrap('Thêm mã thẻ', extra, `Chỉ nhận thẻ đang ở trạng thái "${fromLabel}".`, true),
          counter,
          fieldWrap('Ghi chú', note, null, true));
        count();
        const r = await dlgForm({
          title: `Lập phiếu ${label}`, body, submit: 'Gửi phiếu', wide: true, noFocus: true,
          onSubmit: async ({ setErr }) => {
            const codes = picked();
            if (!codes.length) { setErr('Chọn ít nhất một thẻ.'); return false; }
            const j = await ctx.api('POST', '/api/hub/handovers', { dir, codes, note: note.value.trim() });
            return j.handover;
          },
        });
        if (r && r.id) {
          ARL.toast(`Đã gửi phiếu ${r.code}: ${r.lines} thẻ. Bên nhận đã được báo.`);
          S.tab = 'handovers';
          ctx.setParams([r.id], { tab: 'handovers' });
          renderTab();
        }
      }

      // ───────── Chi tiết phiếu (#/cards/<id>?tab=handovers) ─────────
      function openHandover(id, onClose) {
        const err = errLine();
        const body = h('div.cards-det', H.loading(5));
        const m = ARL.modal({ title: 'Phiếu bàn giao', body, wide: true, cls: 'kits-dlg', onClose });
        const title = m.el.querySelector('.dlg-head h2');
        let ho = null;
        async function reload() {
          try { ho = (await ctx.api('GET', `/api/hub/handovers/${enc(id)}`)).handover; paint(); } catch (e) { if (!ho) H.clear(body, H.error(e, reload)); else showErr(err, e); }
        }
        const after = async (msg) => { if (msg) ARL.toast(msg); await reload(); if (S.refresh) S.refresh(); loadOpen(); };
        function paint() {
          title.textContent = `Phiếu ${ho.code}`;
          const sent = ho.status === 'sent';
          const isSender = sideOf(ctx, ho.dir, 'send'), isRecv = sideOf(ctx, ho.dir, 'recv');
          const recvTeam = ho.dir === 'to_tech' ? 'Tech' : 'Logistics';
          const acts = [];
          if (sent && isSender) {
            acts.push(act(err, 'Sửa phiếu', () => editHandover(ho, after)));
            acts.push(act(err, 'Huỷ phiếu', () => reasonForm(`Huỷ phiếu ${ho.code}`, {
              intro: `Thẻ trong phiếu trở về "${H.label('card_st', FROM_ST[ho.dir])}", việc nhận của ${recvTeam} tự huỷ.`,
              label: 'Lý do huỷ', danger: true, submit: 'Huỷ phiếu',
              run: async (reason) => { await ctx.api('POST', `/api/hub/handovers/${ho.id}/cancel`, { reason }); await after(`Đã huỷ phiếu ${ho.code}.`); },
            }), 'ghost danger'));
          }
          const facts = h('div.kits-facts', H.pill(ho.status_label, HO_TONE[ho.status] || 'off'), H.pill(ho.dir_label, 'off'),
            h('span.sub', ho.status === 'received' ? `Nhận ${ho.recv}/${ho.lines} thẻ` : `${ho.lines} thẻ`), ho.missing ? H.pill(`Thiếu ${ho.missing} thẻ`, 'lost') : null);
          const info = H.dl([
            ['Bên gửi', ho.from ? `${ho.from.name} · ${H.when(ho.created_at)}` : H.when(ho.created_at)],
            ['Bên nhận', ho.to ? `${ho.to.name} · ${H.when(ho.received_at)}` : sent ? `Chờ ${recvTeam} xác nhận` : null],
            ['Ghi chú', ho.note || null],
          ]);
          const receiving = sent && isRecv;
          const lines = receiving ? receiveBox(ho, err, after) : linesView(ho);
          H.clear(body,
            h('div.kits-top', facts, acts.length ? h('div.h-row.kits-acts', acts) : null, err,
              sent && !isRecv ? H.note(`Phiếu đang chờ ${recvTeam} xác nhận đã nhận thẻ.`) : null,
              ho.missing ? H.note(`${ho.missing} thẻ không có khi nhận: đã trả về bên gửi và đưa vào mục Đối chiếu để tìm.`, 'lost') : null),
            h('div.kits-det-grid',
              h('div.h-stack', H.card('Thông tin', info), H.card(receiving ? 'Xác nhận đã nhận' : 'Thẻ trong phiếu', lines)),
              h('div.h-stack', H.card('Việc đi kèm', jobList(ctx, ho.jobs || [], { empty: 'Không có việc đi kèm.' })), H.card('Lịch sử', logList(ho.log)))));
          if (receiving) setTimeout(() => { const s = body.querySelector('.cards-scan input'); if (s) s.focus(); }, 40);
        }
        reload();
        return m.close;
      }
      /** Thẻ của phiếu theo BO, kèm kết quả nhận. */
      function linesView(ho) {
        return h('div.cards-groups', (ho.groups || []).map((g) => h('div.cards-group',
          h('div.cards-group-h', h('b', g.site ? g.site.name : 'Không rõ BO'), h('span.sub', `${g.cards.length} thẻ`)),
          h('div.cards-chips', g.cards.map((c) => h('span.cards-chip', { 'data-st': c.missing ? 'missing' : c.recv_at ? 'got' : null }, h('span.h-mono', c.code),
            c.missing ? h('small', 'thiếu') : c.recv_at ? h('small', 'đã nhận') : null))))));
      }
      /** Bên nhận: đánh dấu từng thẻ (bấm hoặc quét mã), thẻ không đánh dấu phải ghi lý do. */
      function receiveBox(ho, err, after) {
        const all = [];
        const groups = (ho.groups || []).map((g) => {
          const items = g.cards.map((c) => {
            const cb = h('input', { type: 'checkbox', 'aria-label': `Đã nhận ${c.code}`, onchange: () => paint() });
            const row = h('label.cards-chip.cards-recv', cb, h('span.h-mono', c.code));
            all.push({ c, cb, row });
            return row;
          });
          return h('div.cards-group', h('div.cards-group-h', h('b', g.site ? g.site.name : 'Không rõ BO'), h('span.sub', `${g.cards.length} thẻ`)), h('div.cards-chips', items));
        });
        const scanMsg = h('small.cards-scan-msg', { 'aria-live': 'polite' });
        const scan = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'Quét hoặc gõ mã thẻ rồi Enter', 'aria-label': 'Quét mã thẻ' });
        scan.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const codes = splitCodes(scan.value);
          if (!codes.length) return;
          const unknown = [];
          for (const code of codes) {
            const x = all.find((y) => y.c.code === code);
            if (!x) { unknown.push(code); continue; }
            x.cb.checked = true; x.row.classList.add('cards-flash'); setTimeout(() => x.row.classList.remove('cards-flash'), 700);
          }
          scan.value = '';
          scanMsg.dataset.tone = unknown.length ? 'lost' : 'go';
          scanMsg.textContent = unknown.length ? `Không có trong phiếu: ${unknown.join(', ')}. Kiểm lại thẻ hoặc báo bên gửi thêm vào phiếu.` : `Đã đánh dấu ${codes.join(', ')}.`;
          paint();
        });
        const counter = h('p.cards-counter', { 'aria-live': 'polite' });
        const missBox = h('div.cards-miss', { hidden: true });
        const reason = h('textarea', { rows: 2, placeholder: 'VD: Túi thẻ của BO Gò Vấp chỉ có 3 thẻ' });
        const confirmBtn = act(err, 'Xác nhận đã nhận', async () => {
          const got = all.filter((x) => x.cb.checked);
          const miss = all.filter((x) => !x.cb.checked);
          const b = {};
          if (!miss.length) b.all = true;
          else {
            const r = reason.value.trim();
            if (r.length < 3) { reason.focus(); showErr(err, { message: `Ghi lý do thiếu ${miss.length} thẻ (ít nhất 3 ký tự).` }); return; }
            if (!got.length && !(await H.confirm(`Xác nhận không nhận được thẻ nào trong phiếu ${ho.code}? Cả ${miss.length} thẻ trả về bên gửi và vào mục Đối chiếu.`, 'Xác nhận', true))) return;
            b.line_ids = got.map((x) => x.c.line_id);
            b.missing_reason = r;
          }
          let j;
          try { j = await ctx.api('POST', `/api/hub/handovers/${ho.id}/receive`, b); } catch (e) { if (e.code === 'not_in_ticket' && b.line_ids) await after(); throw e; } // bên gửi vừa sửa phiếu: nạp lại để đánh dấu lại
          const hv = j.handover;
          await after(hv.missing ? `Đã nhận ${hv.recv}/${hv.lines} thẻ; ${hv.missing} thẻ thiếu đã vào mục Đối chiếu.` : `Đã nhận đủ ${hv.recv} thẻ của phiếu ${ho.code}.${ho.dir === 'to_tech' ? ' Thẻ đã vào hàng chờ nhập dung lượng.' : ''}`);
        }, 'primary');
        function paint() {
          const got = all.filter((x) => x.cb.checked).length, miss = all.filter((x) => !x.cb.checked);
          counter.textContent = `Đã đánh dấu ${got}/${all.length} thẻ.`;
          confirmBtn.textContent = !miss.length ? `Xác nhận đã nhận đủ ${all.length} thẻ` : `Xác nhận nhận ${got}/${all.length} thẻ (thiếu ${miss.length})`;
          for (const x of all) x.row.dataset.st = x.cb.checked ? 'got' : '';
          missBox.hidden = !miss.length;
          H.clear(missBox,
            h('p.cards-miss-list', `Chưa đánh dấu: ${miss.slice(0, 30).map((x) => x.c.code).join(', ')}${miss.length > 30 ? '…' : ''}`),
            fieldWrap(`Lý do thiếu ${miss.length} thẻ *`, reason, 'Thẻ thiếu trả về bên gửi và vào mục Đối chiếu; hệ thống không tự sửa.', true));
        }
        paint();
        return h('div.h-stack',
          h('div.cards-scan', scan, scanMsg),
          h('div.h-row', h('button.small', { type: 'button', onclick: () => { for (const x of all) x.cb.checked = true; paint(); } }, 'Chọn hết'), h('button.small.ghost', { type: 'button', onclick: () => { for (const x of all) x.cb.checked = false; paint(); } }, 'Bỏ chọn hết'), counter),
          h('div.cards-groups', groups), missBox, h('div.h-row', confirmBtn));
      }
      /** Bên gửi sửa phiếu khi bên nhận chưa xác nhận: bỏ thẻ, thêm thẻ, sửa ghi chú. */
      async function editHandover(ho, after) {
        const sug = await ctx.api('GET', '/api/hub/handovers/suggest', null, { dir: ho.dir });
        const cur = (ho.groups || []).flatMap((g) => g.cards);
        const rm = cur.map((c) => { const cb = h('input', { type: 'checkbox', value: c.code }); return { cb, row: h('label.cards-chip', cb, h('span.h-mono', c.code), h('small', 'bỏ')) }; });
        const add = sug.groups.flatMap((g) => g.cards).map((c) => { const cb = h('input', { type: 'checkbox', value: c.code }); return { cb, row: h('label.cards-chip', cb, h('span.h-mono', c.code)) }; });
        const extra = h('textarea', { rows: 2, spellcheck: 'false', placeholder: 'Quét hoặc dán thêm mã thẻ' });
        const note = h('textarea', { rows: 2 }, ho.note || '');
        const body = h('div.h-form',
          h('h3.kits-h3', `Thẻ đang trong phiếu (${cur.length}) — đánh dấu để bỏ ra`), h('div.cards-chips', rm.map((x) => x.row)),
          add.length ? [h('h3.kits-h3', `Thêm thẻ "${H.label('card_st', FROM_ST[ho.dir])}"`), h('div.cards-chips', add.map((x) => x.row))] : null,
          fieldWrap('Thêm mã khác', extra, null, true), fieldWrap('Ghi chú', note, null, true));
        const ok = await dlgForm({
          title: `Sửa phiếu ${ho.code}`, body, wide: true, noFocus: true,
          onSubmit: async ({ setErr }) => {
            const b = {};
            const remove = rm.filter((x) => x.cb.checked).map((x) => x.cb.value);
            const plus = [...new Set([...add.filter((x) => x.cb.checked).map((x) => x.cb.value), ...splitCodes(extra.value)])];
            if (remove.length) b.remove = remove;
            if (plus.length) b.add = plus;
            if (note.value.trim() !== (ho.note || '')) b.note = note.value.trim();
            if (!Object.keys(b).length) { setErr('Chưa có thay đổi nào.'); return false; }
            if (remove.length === cur.length && !plus.length) { setErr('Phiếu cần ít nhất một thẻ. Muốn bỏ phiếu thì bấm "Huỷ phiếu".'); return false; }
            await ctx.api('PATCH', `/api/hub/handovers/${ho.id}`, b);
            return true;
          },
        });
        if (ok) await after(`Đã sửa phiếu ${ho.code}.`);
      }

      // ───────── Điều hướng, cập nhật trực tiếp ─────────
      const det = detailRouter(ctx, () => (ctx.params[0] ? `${tabOf(ctx.query.tab)}:${ctx.params[0]}` : null), (key, onClose) => {
        const [tab, id] = key.split(':');
        return tab === 'handovers' ? openHandover(id, onClose) : openCard(id, onClose);
      });
      ctx.onRoute(() => {
        const t = tabOf(ctx.query.tab);
        if (t !== S.tab) { S.tab = t; renderTab(); }
        det.sync();
      });
      ctx.live(['cards', 'handovers', 'records'], () => { if (S.refresh) S.refresh(); });
      ctx.live(['handovers'], loadOpen);
      renderTab();
      loadOpen();
      det.sync();
    },
  });

  // ═════════════ Nhập dung lượng ═════════════
  ARL.hub.view('upload', {
    mount(el, ctx) {
      const tabOf = (t) => (t === 'records' ? 'records' : 'queue');
      const S = { tab: tabOf(ctx.query.tab), refresh: null, queueN: null };
      const gbh = () => (M().cfg && M().cfg.gbPerHour) || null;
      const saleHref = ARL.hub.NAV.sale && ARL.hub.NAV.sale.roles.includes(ctx.role) ? '#/sale' : null;
      el.append(H.head('Nhập dung lượng',
        [`Nhập GB đọc được trên từng thẻ; giờ quay = GB ÷ ${gbh() ? H.num(gbh(), 1) : '…'} GB mỗi giờ (Tech Lead chốt). `,
          'Số giờ này là nguồn duy nhất của giờ quay từng BO trên Dashboard Kinh doanh. ', saleHref ? H.link(saleHref, 'Mở Dashboard Kinh doanh') : null]));
      const tabsBox = h('div');
      const body = h('div.upl-body');
      el.append(tabsBox, body);
      function paintTabs() {
        H.clear(tabsBox, H.tabs([['queue', 'Chờ nhập', S.queueN || 0], ['records', 'Đã nhập']], S.tab, (k) => { S.tab = k; ctx.setQuery({ tab: k === 'queue' ? '' : k }); renderTab(); }));
      }
      function renderTab() { S.refresh = null; paintTabs(); if (S.tab === 'queue') queueTab(); else recordsTab(); }

      // ───────── Hàng chờ nhập: lưới nhập nhanh bằng bàn phím ─────────
      const draft = new Map(); // card_id → { gb, date, kit, site, zero, zx } giữ chữ đã gõ khi danh sách nạp lại
      function queueTab() {
        let Q = null, rows = [], picker = null;
        const top = h('div');
        const grid = h('div.upl-grid-wrap', H.loading(5));
        const sumLine = h('p.upl-sum', { 'aria-live': 'polite' });
        const formErr = errLine();
        const saveBtn = act(formErr, 'Lưu', () => save(), 'primary');
        const photoBox = h('div.upl-photo');
        const foot = h('div.upl-foot', photoBox, h('div.upl-foot-r', sumLine, formErr, saveBtn));
        H.clear(body, top, grid, foot);
        const today = H.today();
        let minDate = ARL.addDays(today, -60), win = 60; // khoảng ngày quay theo cài đặt của Tech (nạp cùng hàng chờ)
        const kitLabel = (k) => `${k.code}${k.kind ? ` · ${H.label('kit_kinds', k.kind)}` : ''}`;
        function build() {
          if (!Q.cards.length) {
            H.clear(grid, H.empty('Không có thẻ nào chờ nhập. Thẻ vào đây khi Tech xác nhận đã nhận phiếu bàn giao từ Logistics.',
              h('a.btn', { href: '#/cards?tab=handovers' }, 'Xem phiếu bàn giao')));
            foot.hidden = true; rows = [];
            return;
          }
          foot.hidden = false;
          win = Q.shoot_window_days || 60; minDate = ARL.addDays(today, -win);
          // Gom theo phiếu rồi BO để Tech nhập theo túi thẻ.
          const groups = new Map();
          for (const c of Q.cards) {
            const k = `${c.handover || ''}|${c.site ? c.site.id : 0}`;
            if (!groups.has(k)) groups.set(k, { ho: c.handover, site: c.site, cards: [] });
            groups.get(k).cards.push(c);
          }
          const zeroOpts = (Q.zero_reasons || M().zero_reasons || []);
          rows = [];
          const tbody = h('tbody');
          for (const g of [...groups.values()].sort((a, b) => String(a.ho).localeCompare(String(b.ho)) || (a.site ? a.site.name : '').localeCompare(b.site ? b.site.name : '', 'vi'))) {
            tbody.append(h('tr.upl-grp', h('th', { colspan: 7, scope: 'rowgroup' }, h('b', g.site ? g.site.name : 'Không rõ BO'), h('span', [g.ho ? `Phiếu ${g.ho}` : '', `${g.cards.length} thẻ`].filter(Boolean).join(' · ')))));
            for (const c of g.cards) {
              const d = draft.get(c.id) || {};
              const gb = h('input.upl-gb', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: 'GB', 'aria-label': `GB thẻ ${c.code}`, value: d.gb ?? '' });
              // Thẻ không rõ thời gian ở BO: không gợi ý ngày, Tech nhập ngày quay.
              const date = h('input.upl-date', { type: 'date', max: today, min: minDate, value: d.date || c.shoot_date || '', 'aria-label': `Ngày quay thẻ ${c.code}` });
              const kits = c.kits || [];
              const kitDefault = d.kit ?? (c.kit ? String(c.kit.id) : kits.length === 1 ? String(kits[0].id) : '');
              const kit = kits.length || c.kit ? h('select.upl-kit', { 'aria-label': `Kit của thẻ ${c.code}` }, h('option', { value: '' }, c.kit ? `${c.kit.code} (theo thẻ)` : '— Chưa rõ kit —'),
                kits.filter((k) => !c.kit || k.id !== c.kit.id).map((k) => h('option', { value: k.id }, kitLabel(k)))) : null;
              if (kit) kit.value = c.kit && kitDefault === String(c.kit.id) ? '' : kitDefault;
              // Thẻ không rõ BO: Tech chọn BO; để trống thì bản ghi vào mục Đối chiếu của Tech, chưa tính cho BO nào.
              const site = !c.site ? h('select.upl-kit', { 'aria-label': `BO của thẻ ${c.code}` }, h('option', { value: '' }, '— Chưa rõ BO —'), (Q.sites || []).map((x) => h('option', { value: x.id }, x.name))) : null;
              if (site) site.value = d.site || '';
              const zero = h('select.upl-zero', { 'aria-label': `Lý do 0 giờ thẻ ${c.code}` }, h('option', { value: '' }, '— Lý do 0 giờ —'), zeroOpts.map((z) => h('option', { value: z }, z)));
              zero.value = d.zero || '';
              const zx = h('input.upl-zx', { type: 'text', maxlength: 100, placeholder: 'Ghi rõ lý do', 'aria-label': `Lý do khác thẻ ${c.code}`, value: d.zx || '', hidden: zero.value !== 'Khác' });
              const hrs = h('span.upl-hrs');
              const msg = h('small.upl-msg');
              const kitCell = site ? h('td.upl-c-kit', { 'data-label': 'BO' }, site) : h(kit ? 'td.upl-c-kit' : 'td.upl-c-kit.upl-c-kit-none', { 'data-label': 'Kit' }, kit || h('span.h-muted', 'Không có kit ở BO'));
              const tr = h('tr.upl-row', h('td.upl-code', h('b.h-mono', c.code), c.since ? h('small', `nhận ${H.when(c.since)}`) : null), kitCell, h('td.upl-c-date', { 'data-label': 'Ngày quay' }, date), h('td.upl-c-gb', { 'data-label': 'GB' }, gb), h('td.r.upl-c-hrs', { 'data-label': 'Giờ quay' }, hrs), h('td.upl-c-zero', { 'data-label': 'Lý do 0 giờ' }, zero, zx), h('td.upl-msg-td', msg));
              const row = { c, gb, date, kit, site, zero, zx, hrs, msg, tr, state: 'empty' };
              rows.push(row);
              const keep = () => draft.set(c.id, { gb: gb.value, date: date.value, kit: kit ? kit.value : '', site: site ? site.value : '', zero: zero.value, zx: zx.value });
              gb.addEventListener('input', () => { keep(); check(row); paintSum(); });
              zx.addEventListener('input', () => { keep(); check(row); paintSum(); });
              for (const x of [date, zero, kit, site].filter(Boolean)) x.addEventListener('change', () => { keep(); check(row); paintSum(); });
              gb.addEventListener('keydown', (e) => nav(e, row, 'gb'));
              zero.addEventListener('keydown', (e) => nav(e, row, 'zero'));
              date.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); gb.focus(); } });
              tbody.append(tr);
              check(row);
            }
          }
          H.clear(grid, h('table.h-tbl.upl-tbl',
            h('thead', h('tr', h('th', 'Thẻ'), h('th', 'Kit'), h('th', 'Ngày quay'), h('th', 'Dung lượng (GB)'), h('th.r', 'Giờ quay'), h('th', 'Lý do nếu 0 GB'), h('th', h('span.upl-sr', 'Kiểm tra')))),
            tbody));
          if (!picker) {
            picker = ARL.photoPicker((ARL.cfg && ARL.cfg.maxPhotos) || 4, 'Chụp / chọn ảnh');
            H.clear(photoBox, h('p.upl-photo-l', Q.photo_required ? 'Ảnh màn hình dung lượng (bắt buộc)' : 'Ảnh màn hình dung lượng (không bắt buộc)'), picker.el);
          }
          paintSum();
        }
        /** Giờ quay của một số GB, làm tròn như máy chủ: GB ra 0 giờ (kể cả số rất nhỏ) là thẻ 0 giờ, cần lý do. */
        const zeroOf = (n) => Number.isFinite(n) && n >= 0 && (gbh() ? Math.round((Math.round(n * 100) / 100 / gbh()) * 100) === 0 : Math.round(n * 100) === 0);
        /** Kiểm từng dòng ngay khi gõ: dòng trống bỏ qua; GB ra 0 giờ cần lý do; ngày quay trong số ngày gần đây theo cài đặt. */
        function check(row) {
          const raw = row.gb.value.trim().replace(',', '.');
          let st = 'ok', text = '';
          const n = raw === '' ? null : Number(raw);
          const zmin = Q.zero_min || 10;
          const isZero = raw !== '' && zeroOf(n);
          if (raw === '') { st = 'empty'; text = ''; } else if (!Number.isFinite(n) || n < 0 || n > 2048) { st = 'bad'; text = 'GB từ 0 đến 2048'; } else if (isZero && !row.zero.value) { st = 'bad'; text = 'Ra 0 giờ: chọn lý do'; } else if (isZero && row.zero.value === 'Khác' && row.zx.value.trim().length < zmin) { st = 'bad'; text = `Ghi rõ lý do (ít nhất ${zmin} ký tự)`; } else if (!row.date.value) { st = 'bad'; text = 'Nhập ngày quay'; } else if (row.date.value > today || row.date.value < minDate) { st = 'bad'; text = `Ngày quay trong ${win} ngày gần đây`; } else if (row.site && !row.site.value) text = 'Chưa chọn BO: vào Đối chiếu';
          row.state = st; row.n = n;
          row.tr.dataset.st = st;
          row.tr.dataset.zero = isZero ? '1' : '';
          row.zero.disabled = !isZero;
          if (!isZero && row.zero.value) { row.zero.value = ''; }
          row.zx.hidden = row.zero.value !== 'Khác';
          row.hrs.textContent = st !== 'empty' && Number.isFinite(n) && n >= 0 && gbh() ? `≈ ${H.num(n / gbh(), 2)} giờ` : '';
          row.msg.textContent = text;
          row.gb.setAttribute('aria-invalid', st === 'bad' ? 'true' : 'false');
        }
        function paintSum() {
          const ok = rows.filter((r) => r.state === 'ok'), bad = rows.filter((r) => r.state === 'bad');
          const gb = ok.reduce((a, r) => a + r.n, 0);
          sumLine.textContent = ok.length ? `Sẵn sàng lưu ${ok.length}/${rows.length} thẻ · ${H.num(gb, 1)} GB${gbh() ? ` ≈ ${H.num(gb / gbh(), 1)} giờ` : ''}${bad.length ? ` · ${bad.length} dòng cần sửa` : ''}` : bad.length ? `${bad.length} dòng cần sửa` : `Nhập GB cho các thẻ (${rows.length} thẻ chờ). Enter để xuống dòng.`;
          saveBtn.textContent = ok.length ? `Lưu ${ok.length} thẻ` : 'Lưu';
          saveBtn.disabled = !ok.length;
        }
        /** Enter / ↓ xuống dòng, ↑ lên dòng; 0 GB thì sang ô lý do trước. Ctrl+Enter lưu. */
        function nav(e, row, from) {
          const i = rows.indexOf(row);
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!saveBtn.disabled) saveBtn.click(); return; }
          if (from === 'gb' && e.key === 'Enter') {
            e.preventDefault();
            if (zeroOf(row.n) && !row.zero.value) { row.zero.focus(); return; }
            const next = rows[i + 1];
            if (next) { next.gb.focus(); next.gb.select(); } else saveBtn.focus();
          } else if (from === 'zero' && e.key === 'Enter') {
            e.preventDefault();
            const next = rows[i + 1];
            if (next) { next.gb.focus(); next.gb.select(); } else saveBtn.focus();
          } else if (from === 'gb' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            const to = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
            if (to) { e.preventDefault(); to.gb.focus(); to.gb.select(); }
          }
        }
        async function save() {
          const ok = rows.filter((r) => r.state === 'ok');
          const bad = rows.filter((r) => r.state === 'bad');
          const stop = (msg) => ARL.toast(msg, true);
          if (!ok.length) return stop('Chưa có thẻ nào đủ thông tin để lưu.');
          if (ok.length > 300) return stop('Tối đa 300 thẻ mỗi lần lưu. Lưu bớt rồi nhập tiếp.');
          if (picker.busy) return stop('Ảnh đang được xử lý, đợi một chút.');
          if (Q.photo_required && !picker.photos.length) return stop('Cần ít nhất một ảnh màn hình dung lượng (Tech Lead đã bật bắt buộc).');
          if (bad.length && !(await H.confirm(`${bad.length} dòng còn lỗi sẽ không được lưu. Lưu ${ok.length} thẻ hợp lệ?`, `Lưu ${ok.length} thẻ`))) return;
          const records = ok.map((r) => {
            const o = { card_id: r.c.id, gb: r.n, shoot_date: r.date.value };
            if (r.kit && r.kit.value) o.kit_id = Number(r.kit.value);
            if (r.site && r.site.value) o.site_id = Number(r.site.value);
            if (zeroOf(r.n)) o.zero_reason = r.zero.value === 'Khác' ? `Khác: ${r.zx.value.trim()}` : r.zero.value;
            return o;
          });
          const res = await ctx.api('POST', '/api/hub/cards/records', { records, photos: picker.photos.slice() });
          for (const r of ok) draft.delete(r.c.id);
          picker = null; // ảnh đã gắn cho lượt vừa lưu; lượt sau chọn ảnh mới
          ARL.toast(`Đã lưu ${res.count} thẻ · ${H.num(res.hours, 1)} giờ quay. Dashboard Kinh doanh đã có số mới.`);
          await load();
        }
        async function load() {
          const j = await ctx.api('GET', '/api/hub/cards/upload-queue');
          if (!ctx.alive()) return;
          Q = j;
          for (const id of [...draft.keys()]) if (!j.cards.some((c) => c.id === id)) draft.delete(id);
          S.queueN = j.cards.length; paintTabs();
          const noSite = j.cards.filter((c) => !c.site).length;
          H.clear(top, j.cards.length ? H.note(`Thẻ chưa có dữ liệu thì để trống (không lưu). Thẻ ra 0 giờ cần chọn lý do; Sale phụ trách BO được báo khi có thẻ 0 giờ.${j.photo_required ? ' Cần ảnh màn hình dung lượng cho mỗi lượt lưu.' : ''}${noSite ? ` Có ${noSite} thẻ không rõ BO: chọn BO và nhập ngày quay; không chọn BO thì bản ghi vào mục Đối chiếu của Tech, chưa tính giờ cho BO nào.` : ''}`) : null);
          build();
          const first = rows.find((r) => r.state === 'empty');
          if (first && S.tab === 'queue' && !el.contains(document.activeElement) && !document.querySelector('dialog.dlg[open]') && matchMedia('(min-width: 900px)').matches) first.gb.focus({ preventScroll: true });
        }
        load().catch((e) => H.clear(grid, H.error(e, () => renderTab())));
        S.refresh = load;
      }

      // ───────── Đã nhập: bản ghi dung lượng, người nhập sửa trong số giờ theo cài đặt của Tech (Tech Lead sửa mọi lúc) ─────────
      // Hạn sửa, khoảng ngày quay và danh sách BO lấy từ máy chủ cùng danh sách bản ghi.
      const recCfg = { edit_hours: 48, shoot_window_days: 60, sites: [] };
      const keepCfg = (j) => { for (const k of Object.keys(recCfg)) if (j[k] !== undefined) recCfg[k] = j[k]; };
      const canEditRec = (r) => ctx.can('admin', 'tech_lead') || (r.by && r.by.id === ctx.user.id && ARL.now() - r.at < recCfg.edit_hours * 3600000);
      function recordsTab() {
        const t = H.today();
        const st = { from: ctx.query.from || ARL.addDays(t, -6), to: ctx.query.to || t, zero: ctx.query.zero === '1', mine: ctx.query.mine === '1', q: ctx.query.q || '', rows: [], meta: null };
        const kpis = h('div.kits-strip', H.loading(2));
        const from = h('input', { type: 'date', value: st.from, max: t, 'aria-label': 'Từ ngày quay' });
        const to = h('input', { type: 'date', value: st.to, max: t, 'aria-label': 'Đến ngày quay' });
        const onDates = () => { if (!from.value || !to.value) return; if (from.value > to.value) { ARL.toast('Ngày bắt đầu phải trước ngày kết thúc.', true); return; } st.from = from.value; st.to = to.value; ctx.setQuery({ from: st.from, to: st.to }); H.clear(csvBox, csvLink()); load(); };
        from.addEventListener('change', onDates); to.addEventListener('change', onDates);
        const zeroCb = h('input', { type: 'checkbox', checked: st.zero, onchange: () => { st.zero = zeroCb.checked; ctx.setQuery({ zero: st.zero ? '1' : '' }); load(); } });
        const mineCb = h('input', { type: 'checkbox', checked: st.mine, onchange: () => { st.mine = mineCb.checked; ctx.setQuery({ mine: st.mine ? '1' : '' }); load(); } });
        const search = H.search('Tìm mã thẻ, BO, kit…', (v) => { st.q = v; ctx.setQuery({ q: v }); paint(); }, st.q);
        const csvLink = () => H.csv('/api/hub/export/records.csv', { from: st.from, to: st.to }, 'Tải CSV');
        const csvBox = h('span', csvLink());
        const canEdit = canEditRec;
        const table = H.table({
          columns: [
            { key: 'shoot_date', label: 'Ngày quay', desc: true, render: (r) => H.dmy(r.shoot_date) },
            { key: 'code', label: 'Thẻ', render: (r) => h('b.h-mono', r.code) },
            { key: 'site', label: 'BO', value: (r) => (r.site ? r.site.name : ''), render: (r) => (r.site ? r.site.name : h('span.h-muted', 'Chưa rõ BO')) },
            { key: 'kit', label: 'Kit', value: (r) => (r.kit ? r.kit.code : ''), render: (r) => (r.kit ? r.kit.code : null) },
            { key: 'gb', label: 'GB', align: 'r', render: (r) => H.num(r.gb, 1) },
            { key: 'hours', label: 'Giờ quay', align: 'r', render: (r) => h('b', H.num(r.hours, 2)) },
            { key: 'zero_reason', label: 'Lý do 0 giờ', render: (r) => r.zero_reason || null },
            { key: 'by', label: 'Người nhập', value: (r) => (r.by ? r.by.name : ''), render: (r) => [r.by ? r.by.name : '–', h('small', H.when(r.at)), r.edited_by ? h('small', `Sửa: ${r.edited_by}`) : null] },
          ],
          rows: [], sort: { key: 'shoot_date', dir: -1 },
          onRow: (r) => ctx.setParams([r.id], { ...ctx.query, tab: 'records' }),
          rowTone: (r) => (!r.hours || !r.site ? 'wait' : null),
          empty: 'Không có bản ghi nào trong khoảng ngày này.',
        });
        H.clear(body, kpis, h('div.h-tools.upl-tools', h('label.upl-date-f', h('span', 'Từ'), from), h('label.upl-date-f', h('span', 'đến'), to), h('label.kits-free', zeroCb, h('span', 'Chỉ thẻ 0 giờ')), h('label.kits-free', mineCb, h('span', 'Chỉ của tôi')), search, csvBox), table);
        const pass = (r) => !st.q || H.match(`${r.code} ${r.site ? r.site.name : ''} ${r.kit ? r.kit.code : ''} ${r.zero_reason}`, st.q);
        function paint() { table.update(st.rows.filter(pass)); }
        async function load() {
          const q = { from: st.from, to: st.to };
          if (st.zero) q.zero = '1';
          if (st.mine) q.by = ctx.user.id;
          const j = await ctx.api('GET', '/api/hub/cards/records', null, q);
          if (!ctx.alive()) return;
          st.rows = j.records; st.meta = j; keepCfg(j);
          const zeros = j.records.filter((r) => !r.hours).length;
          H.clear(kpis, H.kpis(
            H.kpi({ label: 'Giờ quay', value: H.num(j.hours, 1), unit: 'giờ', tone: 'blue', hint: `${H.dmy(j.from)} – ${H.dmy(j.to)}` }),
            H.kpi({ label: 'Dung lượng', value: H.num(j.gb, 1), unit: 'GB' }),
            H.kpi({ label: 'Số thẻ đã nhập', value: j.total, hint: j.total > j.records.length ? `Đang hiện ${j.records.length} dòng mới nhất` : null }),
            H.kpi({ label: 'Thẻ 0 giờ', value: zeros, tone: zeros ? 'wait' : null, hint: 'Sale phụ trách BO được báo' })));
          paint();
        }
        load().catch((e) => { kpis.replaceChildren(); table.replaceWith(H.error(e, () => renderTab())); });
        S.refresh = load;
        S.records = () => st.rows;
        S.canEdit = canEdit;
      }
      /** Chi tiết một bản ghi (#/upload/<id>): xem ảnh, sửa nếu được phép. */
      function openRecord(id, onClose) {
        const err = errLine();
        const body = h('div.h-stack', H.loading(4));
        const m = ARL.modal({ title: 'Bản ghi dung lượng', body, onClose });
        const canEdit = canEditRec;
        const title = m.el.querySelector('.dlg-head h2');
        (async () => {
          let r = (S.records ? S.records() : []).find((x) => String(x.id) === String(id));
          if (!r) { // mở từ thông báo hoặc mục Đối chiếu: tìm trong khoảng ngày quay cho phép (cài đặt của Tech)
            const t = H.today();
            const j = await ctx.api('GET', '/api/hub/cards/records', null, { from: ARL.addDays(t, -Math.max(60, recCfg.shoot_window_days)), to: t });
            keepCfg(j);
            r = j.records.find((x) => String(x.id) === String(id));
          }
          if (!r) { H.clear(body, H.empty(`Không tìm thấy bản ghi trong ${Math.max(60, recCfg.shoot_window_days)} ngày gần đây.`)); return; }
          paint(r);
        })().catch((e) => H.clear(body, H.error(e)));
        function paint(r) {
          title.textContent = `Thẻ ${r.code} · ${H.dmy(r.shoot_date)}`;
          const photos = (r.photos || []).map((pid) => h('a.upl-thumb', { href: ARL.backend.photoUrl(pid), target: '_blank', rel: 'noopener' }, h('img', { src: ARL.backend.photoUrl(pid), alt: `Ảnh dung lượng thẻ ${r.code}`, loading: 'lazy' })));
          H.clear(body,
            H.dl([
              ['Dung lượng', `${H.num(r.gb, 2)} GB`], ['Giờ quay', `${H.num(r.hours, 2)} giờ`], ['Lý do 0 giờ', r.zero_reason || null],
              ['BO', r.site ? r.site.name : 'Chưa rõ BO (chờ Tech chọn BO, đang ở mục Đối chiếu)'], ['Kit', r.kit ? r.kit.code : null],
              ['Người nhập', r.by ? `${r.by.name} · ${H.when(r.at)}` : H.when(r.at)], ['Đã sửa', r.edited_by ? `${r.edited_by} · ${H.when(r.edited_at)}` : null],
            ]),
            photos.length ? h('div.upl-thumbs', photos) : null,
            err,
            canEdit(r) ? h('div.h-row', act(err, r.site ? 'Sửa bản ghi' : 'Chọn BO, sửa bản ghi', () => editRecord(r), 'primary')) : h('p.sub', `Chỉ người nhập (trong ${recCfg.edit_hours} giờ) hoặc Tech Lead được sửa bản ghi này.`));
        }
        /** Sửa theo cùng quy tắc như lúc nhập: ngày quay trong khoảng cho phép, ảnh mới khi đổi GB (nếu Tech Lead bắt buộc ảnh), lý do 0 giờ. */
        async function editRecord(r) {
          const zeroOpts = (M().zero_reasons || []).map((z) => [z, z]);
          const other = /^Khác:\s*/.test(r.zero_reason || '');
          const lead = ctx.can('admin', 'tech_lead');
          const photoReq = !!(M().cfg && M().cfg.uploadPhotoRequired);
          const gbh = (M().cfg && M().cfg.gbPerHour) || null;
          const zeroOf = (n) => (gbh ? Math.round((Math.round(n * 100) / 100 / gbh) * 100) === 0 : Math.round(n * 100) === 0);
          const picker = ARL.photoPicker((ARL.cfg && ARL.cfg.maxPhotos) || 4, 'Chụp / chọn ảnh');
          const fields = [
            { name: 'gb', label: 'Dung lượng (GB)', type: 'number', min: 0, max: 2048, step: 0.01, required: true, value: r.gb },
            { name: 'shoot_date', label: 'Ngày quay', type: 'date', required: true, value: r.shoot_date, max: H.today(), min: ARL.addDays(H.today(), -recCfg.shoot_window_days), hint: `Trong ${recCfg.shoot_window_days} ngày gần đây.` },
          ];
          // Bản ghi chưa rõ BO: người nhập chọn BO; đổi BO đã có thì chỉ Tech Lead. BO của bản ghi đã ngừng hoạt động vẫn có trong danh sách để ô chọn giữ đúng BO cũ.
          const site0 = r.site ? String(r.site.id) : '';
          const siteOpts = recCfg.sites.map((x) => [x.id, x.name]);
          if (r.site && !siteOpts.some(([id]) => String(id) === site0)) siteOpts.unshift([r.site.id, `${r.site.name} (đã ngừng hoạt động)`]);
          if (!r.site || lead) fields.push({ name: 'site_id', label: 'BO', type: 'select', options: siteOpts, empty: r.site ? undefined : '— Chưa rõ BO —', value: site0, full: true, hint: r.site ? 'Đổi BO chuyển giờ quay của bản ghi sang BO khác.' : 'Chọn BO để giờ quay được tính cho BO đó.' });
          fields.push({ name: 'zero_reason', label: 'Lý do nếu ra 0 giờ', type: 'select', options: zeroOpts, empty: '— Không —', value: other ? 'Khác' : r.zero_reason || '', full: true });
          fields.push({ name: 'zero_more', label: 'Ghi rõ nếu chọn "Khác"', value: other ? r.zero_reason.replace(/^Khác:\s*/, '') : '', full: true });
          const res = await H.form({
            title: `Sửa dung lượng thẻ ${r.code}`, intro: 'Giờ quay tính lại theo GB mới. Kỳ hiệu suất đã chốt thì không sửa được. Mỗi lần sửa được ghi nhật ký.',
            fields,
            extra: h('div.upl-photo', h('p.upl-photo-l', photoReq ? 'Ảnh màn hình dung lượng mới (bắt buộc khi đổi GB)' : 'Ảnh màn hình dung lượng mới (không bắt buộc)'), picker.el),
            onSubmit: async (v, c) => {
              if (v.gb === null || !Number.isFinite(v.gb) || v.gb < 0 || v.gb > 2048) { c.setErr('Dung lượng phải từ 0 đến 2048 GB.'); return false; }
              const zero = zeroOf(v.gb);
              if (zero && !v.zero_reason) { c.setErr('GB này ra 0 giờ: chọn lý do 0 giờ.'); return false; }
              if (zero && v.zero_reason === 'Khác' && v.zero_more.trim().length < 10) { c.setErr('Chọn "Khác" thì ghi rõ lý do (ít nhất 10 ký tự).'); return false; }
              if (picker.busy) { c.setErr('Ảnh đang được xử lý, đợi một chút.'); return false; }
              const b = {};
              if (v.gb !== r.gb) b.gb = v.gb;
              if (v.shoot_date !== r.shoot_date) b.shoot_date = v.shoot_date;
              if (v.site_id && String(v.site_id) !== site0) b.site_id = Number(v.site_id); // chỉ gửi khi người sửa thật sự chọn BO khác
              if (zero) b.zero_reason = v.zero_reason === 'Khác' ? `Khác: ${v.zero_more.trim()}` : v.zero_reason;
              if (b.gb !== undefined && photoReq && !picker.photos.length) { c.setErr('Đổi GB cần ảnh màn hình dung lượng mới (Tech Lead đã bật bắt buộc).'); return false; }
              if (picker.photos.length) b.photos = picker.photos.slice();
              if (!Object.keys(b).length || (Object.keys(b).length === 1 && b.zero_reason === r.zero_reason)) return true;
              const j = await ctx.api('PATCH', `/api/hub/cards/records/${r.id}`, b);
              return j.record || true;
            },
          });
          if (!res) return;
          ARL.toast('Đã sửa bản ghi.');
          if (res.id) paint(res);
          if (S.refresh) S.refresh();
        }
        return m.close;
      }

      const det = detailRouter(ctx, () => (ctx.params[0] ? String(ctx.params[0]) : null), openRecord);
      ctx.onRoute(() => {
        const t = tabOf(ctx.query.tab);
        if (t !== S.tab) { S.tab = t; renderTab(); }
        det.sync();
      });
      ctx.live(['cards', 'records', 'handovers'], () => { if (S.refresh) S.refresh(); });
      renderTab();
      det.sync();
    },
  });
})();
