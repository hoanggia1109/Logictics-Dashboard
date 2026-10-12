/* Ops Hub — Sự cố thiết bị: danh sách, thống kê lỗi (top 10, so tuần / tháng trước), chi tiết #/incidents/<id>, báo sự cố mới.
   Ai trong ba team cũng báo được (Sale chỉ BO của mình — máy chủ lọc). Người giữ việc (hoặc Tech Lead) nhận và xử lý; người báo huỷ được
   trong thời gian Tech chốt ở Cài đặt, sau đó Tech Lead / Quản trị huỷ. Máy chủ quyết định nút nào hiện (can_ack, can_handle, can_attach, can_cancel).
   Thống kê chỉ cho Lead, Head of Sale, Quản trị và Tech (máy chủ kiểm quyền); bấm một dòng thống kê mở danh sách đúng kỳ, dòng kit và đúng số. */
(() => {
  'use strict';
  const H = ARL.H, { h } = H, D = ARL.dash;
  const STATS_ROLES = ['admin', 'tech_lead', 'lead', 'sale_head', 'tech'];
  const TECH = ['admin', 'tech_lead', 'tech'];
  const OPEN = ['open', 'ack'];
  const RES_HINT = {
    no_recover: 'Chỉnh hoặc sửa ngay tại BO, kit ở lại BO.',
    swap: 'Thay kit lỗi: hệ thống tự tạo việc đổi kit cho Logistics (đi cùng lượt đổi thẻ gần nhất).',
    office_repair: 'Mang kit về văn phòng sửa: hệ thống tự tạo việc tiếp theo cho Logistics và Tech.',
    invalid: 'Báo nhầm hoặc BO tự khắc phục được. Không bắt buộc ghi chú.',
  };
  // Kit đã rời BO của sự cố (về kho, đã giao BO khác): máy chủ không tự đổi / báo hỏng kit ở chỗ mới.
  const AWAY_HINT = 'Kit đã rời BO của sự cố: hệ thống không đổi hay báo hỏng kit ở chỗ mới, chỉ đưa vào Đối chiếu cho Tech Lead xem lại.';
  const TL_TONE = { create: 'lost', dup: 'wait', ack: 'blue', resolve: 'go', cancel: 'off' };
  const nowMs = () => (ARL.now ? ARL.now() : Date.now());
  const photoUrl = (id) => (ARL.backend && ARL.backend.photoUrl ? ARL.backend.photoUrl(id) : `api/photo/${encodeURIComponent(id)}`);
  const minsSince = (ts) => Math.max(0, Math.round((nowMs() - ts) / 60000));

  ARL.hub.view('incidents', {
    mount(el, ctx) {
      const canStats = STATS_ROLES.includes(ctx.role);
      const isTech = TECH.includes(ctx.role);
      const canOpen = (v) => D.canOpen(ctx, v);
      const STATUS_KEYS = ['open', 'new', 'ack', 'resolved', 'cancelled', 'counted', 'all'];
      const KIND_KEYS = ['multicam', 'iphone', 'custom', 'none'];
      const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
      const fromQuery = () => ({
        status: STATUS_KEYS.includes(ctx.query.status) ? ctx.query.status : 'open',
        label: ctx.query.label || '', site: ctx.query.site || '',
        from: isDay(ctx.query.from) ? ctx.query.from : '', to: isDay(ctx.query.to) ? ctx.query.to : '', kind: KIND_KEYS.includes(ctx.query.kind) ? ctx.query.kind : '',
      });
      const kindName = (k) => (!k || k === 'none' ? 'Chưa rõ kit' : H.label('kit_kinds', k));
      const kindTone = (k) => (k === 'iphone' ? 'blue' : k && k !== 'none' ? 'violet' : 'off');
      const st = { ...fromQuery(), q: '', rows: [], open: null, siteName: '' };
      const sst = { period: 'week', key: null };

      const newBtn = H.btn('Báo sự cố', () => createDlg(st.site || null), 'primary');
      const head = H.head('Sự cố thiết bị', ' ', newBtn);
      const sub = head.querySelector('.sub');
      const statsBox = canStats ? h('section.inc-stats') : null;
      const listBox = h('section.inc-list');
      // Danh sách trước (việc hằng ngày), thống kê sau.
      el.append(head, h('div.inc-v.dash-v', listBox, statsBox));

      // ───── Thống kê ─────
      const loadStats = canStats ? H.async(statsBox, async () => {
        const s = await ctx.api('GET', '/api/hub/incidents/stats', null, D.q({ period: sst.period, key: sst.key }));
        if (!ctx.alive()) return undefined;
        sst.period = s.period; sst.key = s.key;
        return statsView(s);
      }) : null;

      function statsView(s) {
        const word = D.prevWord(s);
        // Một dòng cho mỗi lỗi; nhiều dòng kit thì chia nhỏ ngay trong dòng.
        const kindPills = (x) => {
          const ks = x.kinds || [];
          if (ks.length > 1) return ks.map((k) => H.pill(`${kindName(k.kind)} ${H.num(k.count)}`, kindTone(k.kind)));
          return ks.length ? H.pill(kindName(ks[0].kind), kindTone(ks[0].kind)) : (x.kind ? H.pill(kindName(x.kind), kindTone(x.kind)) : null);
        };
        // Link mở danh sách đúng tập đã đếm: cùng kỳ, trừ "Không phải sự cố" và đã huỷ.
        const listHref = (q) => D.href('incidents', [], { status: 'counted', from: s.from, to: s.to, ...q });
        const spikes = (s.top || []).filter((x) => x.spike).length;
        const office = Object.entries(s.office_faults || {});
        const officeN = office.reduce((a, [, n]) => a + n, 0);
        return [
          H.sec('Thống kê lỗi', `${s.label} (${D.range(s.from, s.to)}) so với ${s.prev_label}${s.cmp && s.cmp.running ? ` · ${D.cmpNote(s, { data: false })}` : ''}`, D.periodNav(s, (p, k) => { sst.period = p; sst.key = k; loadStats(); })),
          h('div.dash-grid-3',
            H.card('Top 10 lỗi thiết bị', [
              spikes ? H.note(`${H.num(spikes)} lỗi tăng vọt: đạt số lần tối thiểu và gấp đôi trung bình 4 tuần trước (ngưỡng đề xuất, Tech chốt trong Cài đặt).`, 'lost') : null,
              D.rank((s.top || []).map((x) => ({
                label: x.label, value: x.count, text: H.num(x.count), tone: x.spike ? 'lost' : 'violet',
                flag: [kindPills(x), x.spike ? H.pill('Tăng vọt', 'lost') : null],
                sub: [x.sites ? `${H.num(x.sites)} BO` : '', x.swap_rate !== null && x.swap_rate !== undefined ? `đổi máy ${H.num(x.swap_rate)}%` : '', x.avg4 !== null && x.avg4 !== undefined ? `TB 4 tuần ${H.num(x.avg4, 1)}` : ''].filter(Boolean).join(' · '),
                right: D.arrow(x.count, x.prev, { up: 'bad', label: word[0].toUpperCase() + word.slice(1) }),
                href: listHref({ label: x.label, kind: x.kind }),
              })), { empty: `Không có sự cố nào trong ${s.label} và ${s.prev_label}.` }),
              h('div.dash-foot', h('span', `Mũi tên: thay đổi so ${word}`), h('span', 'Bấm một lỗi để lọc danh sách bên dưới')),
            ], { sub: `${H.num(s.total)} lần báo trong ${s.label}, ${H.num(s.prev_total)} trong ${s.prev_label} (không tính đã huỷ)${s.invalid ? ` · ${H.num(s.invalid)} lần "Không phải sự cố" không vào Top 10` : ''}` }),
            h('div.h-stack', { style: { gap: 'var(--h-gap)', alignContent: 'start' } },
              H.card('Tóm tắt', h('div.dash-mini',
                h('div', h('span', 'Sự cố trong kỳ'), h('b', H.num(s.total)), H.delta(s.total, s.prev_total, { label: word, up: 'bad', abs: true })),
                h('div', h('span', 'Đang mở (mọi kỳ)'), h('b', H.num(s.open))),
                h('div', h('span', 'Không phải sự cố'), h('b', H.num(s.invalid || 0)), h('small.h-muted', 'Đếm riêng, không vào Top 10 và lỗi tăng vọt')),
                h('div', h('span', 'Tech nhận sau'), h('b', s.avg_ack_min === null ? '–' : H.dur(s.avg_ack_min))),
                h('div', h('span', 'Xử lý xong sau'), h('b', s.avg_resolve_min === null ? '–' : H.dur(s.avg_resolve_min))),
                h('div', h('span', 'Lỗi phát hiện ở văn phòng'), h('b', H.num(officeN)), office.length ? h('small.h-muted', office.map(([k, n]) => `${H.label('kit_kinds', k)} ${H.num(n)}`).join(' · ')) : null)), { sub: 'Thời gian tính trung bình từ lúc báo' }),
              H.card('BO có nhiều sự cố', D.rank((s.sites || []).map((x) => ({ label: x.site.name, value: x.count, text: H.num(x.count), tone: 'violet', href: listHref({ site: x.site.id }) })), { empty: 'Chưa BO nào báo sự cố trong kỳ.' }), { sub: `Top 5 trong ${s.label}` }))),
        ];
      }

      // ───── Danh sách ─────
      const chips = H.chips([
        { key: 'open', label: 'Đang mở' }, { key: 'new', label: H.label('incident_st', 'open') }, { key: 'ack', label: H.label('incident_st', 'ack') },
        { key: 'resolved', label: H.label('incident_st', 'resolved') }, { key: 'cancelled', label: H.label('incident_st', 'cancelled') },
        { key: 'counted', label: 'Tính vào thống kê' }, { key: 'all', label: 'Tất cả' },
      ], st.status, (k) => { st.status = k; ctx.setQuery({ status: k === 'open' ? null : k }); reloadList(); });
      const filterBox = h('div.h-row.inc-filters');
      const search = H.search('Tìm mã, BO, kit, lỗi, người báo…', (q) => { st.q = q; paint(); });
      const tbl = H.table({
        rows: [], pageSize: 50,
        onRow: (x) => ctx.setParams([x.id]),
        rowTone: (x) => (x.status === 'open' ? 'lost' : null),
        empty: 'Không có sự cố nào.',
        columns: [
          { key: 'created_at', label: 'Sự cố', desc: true, render: (x) => h('span.inc-cell', h('b', x.code), h('small', H.when(x.created_at))) },
          { key: 'site', label: 'BO · kit', value: (x) => (x.site ? x.site.name : ''), render: (x) => h('span.inc-cell', h('span', x.site ? x.site.name : '–'), h('small', x.kit ? `${x.kit.code} · ${H.label('kit_kinds', x.kit.kind)}` : 'Không gắn kit')) },
          { key: 'label', label: 'Lỗi', render: (x) => h('span.inc-cell.inc-lab', h('b', x.label), x.text ? h('small', { title: x.text }, x.text) : null) },
          { key: 'status', label: 'Trạng thái', value: (x) => ['open', 'ack', 'resolved', 'cancelled'].indexOf(x.status), render: (x) => h('span.inc-cell', H.st('incident_st', x.status), h('small', stateNote(x))) },
          { key: 'raised_by', label: 'Người báo', value: (x) => (x.raised_by ? x.raised_by.name : ''), render: (x) => (x.raised_by ? h('span.inc-cell', h('span', x.raised_by.name), h('small', x.raised_by.role_label)) : 'Hệ thống') },
        ],
      });
      listBox.append(
        h('div.h-tools', chips, search, filterBox),
        tbl);

      const swapOnly = (x) => !!x.swap && !(x.job && ['open', 'doing'].includes(x.job.status));
      function stateNote(x) {
        if (x.status === 'open') return swapOnly(x) ? `chờ Logistics đổi kit · ${H.dur(minsSince(x.created_at))}` : `chờ Tech nhận · ${H.dur(minsSince(x.created_at))}`;
        if (x.status === 'ack') return x.job && x.job.assignee ? `${x.job.assignee} đang xử lý` : 'Tech đang xử lý';
        if (x.status === 'resolved') return x.resolution_label || '';
        return x.resolve_note || '';
      }
      function paintFilters() {
        const kids = [];
        if (st.label) kids.push(h('button.chip', { type: 'button', 'aria-pressed': 'true', title: 'Bỏ lọc theo lỗi', onclick: () => { st.label = ''; ctx.setQuery({ label: null }); reloadList(); } }, `Lỗi: ${st.label}`, ' ×'));
        if (st.site) kids.push(h('button.chip', { type: 'button', 'aria-pressed': 'true', title: 'Bỏ lọc theo BO', onclick: () => { st.site = ''; ctx.setQuery({ site: null }); reloadList(); } }, `BO: ${st.siteName || 'đã chọn'}`, ' ×'));
        if (st.from || st.to) kids.push(h('button.chip', { type: 'button', 'aria-pressed': 'true', title: 'Bỏ lọc theo kỳ', onclick: () => { st.from = ''; st.to = ''; ctx.setQuery({ from: null, to: null }); reloadList(); } }, `Kỳ: ${D.range(st.from || st.to, st.to || st.from)}`, ' ×'));
        if (st.kind) kids.push(h('button.chip', { type: 'button', 'aria-pressed': 'true', title: 'Bỏ lọc theo dòng kit', onclick: () => { st.kind = ''; ctx.setQuery({ kind: null }); reloadList(); } }, `Kit: ${kindName(st.kind)}`, ' ×'));
        H.clear(filterBox, kids);
      }
      function paint() {
        const rows = st.rows.filter((x) => (st.status !== 'new' || x.status === 'open') && (!st.q || H.match(`${x.code} ${x.site ? x.site.name : ''} ${x.kit ? x.kit.code : ''} ${x.label} ${x.text} ${x.raised_by ? x.raised_by.name : ''}`, st.q)));
        tbl.update(rows);
        const tbody = tbl.querySelector('.h-tbl-empty');
        if (tbody && !rows.length) tbody.textContent = emptyText();
      }
      function emptyText() {
        if (st.q) return 'Không có sự cố nào khớp từ khoá.';
        if (st.status === 'open' || st.status === 'new') return 'Không có sự cố nào đang mở. Khi BO gặp lỗi, bấm "Báo sự cố" để Tech nhận và xử lý.';
        return 'Không có sự cố nào khớp bộ lọc.';
      }
      let listGen = 0;
      async function reloadList() {
        const my = ++listGen;
        paintFilters();
        try {
          const status = st.status === 'new' ? 'open' : st.status === 'all' ? null : st.status;
          const r = await ctx.api('GET', '/api/hub/incidents', null, D.q({ status, label: st.label, site: st.site, from: st.from, to: st.to, kind: st.kind, limit: 300 }));
          if (!ctx.alive() || my !== listGen) return;
          st.rows = r.incidents || [];
          st.open = r.open;
          if (st.site && st.rows[0] && st.rows[0].site) st.siteName = st.rows[0].site.name;
          ctx.badge('incidents', r.open || 0, 'lost');
          sub.textContent = `${H.num(r.open)} sự cố đang mở${ctx.role === 'sale' ? ' ở BO của bạn' : ''} · Tech nhận và xử lý; ai trong ba team cũng báo được`;
          paintFilters();
          paint();
        } catch (e) {
          if (ctx.alive()) ARL.toast(e.message || 'Không tải được danh sách sự cố.', true);
        }
      }

      // ───── Chi tiết #/incidents/<id> ─────
      let det = null;
      function closeDetail() { if (det) { const m = det.m; det = null; m.close(); } }
      function openDetail(id) {
        if (det && det.id === id) { refreshDetail(); return; }
        closeDetail();
        const bodyEl = h('div.inc-detail', H.loading(5));
        const m = ARL.modal({ title: 'Sự cố', body: bodyEl, wide: true, onClose: () => { if (det && det.m === m) { det = null; if (ctx.alive() && ctx.params[0]) ctx.setParams([]); } } });
        det = { id, m, bodyEl };
        refreshDetail();
      }
      async function refreshDetail() {
        if (!det) return;
        const cur = det;
        let r;
        try { r = await ctx.api('GET', `/api/hub/incidents/${cur.id}`); } catch (e) {
          if (det === cur) H.clear(cur.bodyEl, H.error(e, refreshDetail));
          return;
        }
        if (det !== cur || !ctx.alive()) return;
        const x = r.incident;
        cur.m.el.querySelector('h2').textContent = `Sự cố ${x.code}`;
        H.clear(cur.bodyEl, detailView(x, r));
      }
      function detailView(x, r) {
        const isOpen = OPEN.includes(x.status);
        // Máy chủ quyết định: chỉ người giữ việc (hoặc Tech Lead) nhận, gắn kit, báo kết quả; người báo huỷ trong thời gian cho phép.
        const heldBy = isOpen && isTech && !r.can_handle && x.job && x.job.assignee ? x.job.assignee : '';
        const acts = [];
        if (r.can_ack) acts.push(H.btn('Nhận xử lý', async () => { await ctx.api('POST', `/api/hub/incidents/${x.id}/ack`); ARL.toast(`Đã nhận sự cố ${x.code}. Hạn xử lý tính từ bây giờ.`); refreshDetail(); reloadList(); }, 'primary'));
        if (r.can_attach) acts.push(H.btn('Gắn kit', () => attachDlg(x)));
        if (r.can_handle) acts.push(H.btn('Báo đã xử lý', () => resolveDlg(x, r.resolutions), x.status === 'open' ? '' : 'primary'));
        if (r.can_cancel) acts.push(H.btn('Huỷ sự cố', () => cancelDlg(x, r.cancel_min), 'ghost danger'));
        const siteLink = x.site ? (canOpen('outlets') ? h('a', { href: D.href('outlets', [x.site.id]) }, x.site.name) : x.site.name) : '–';
        const kitLink = x.kit ? [canOpen('kits') ? h('a', { href: D.href('kits', [x.kit.id]) }, x.kit.code) : x.kit.code, ` · ${H.label('kit_kinds', x.kit.kind)} · `, H.st('kit_st', x.kit.status)] : 'Không gắn kit';
        // Chi tiết việc chỉ mở được với việc của team mình (Quản trị: mọi team); việc của team kia hiện mã dạng chữ để khỏi bấm vào rồi bị từ chối.
        const jobA = (j) => { const to = ctx.jobLink(j); return to ? h('a', { href: to }, j.code) : j.code; };
        const jobInfo = x.job ? [jobA(x.job), ' · ', H.st('job_st', x.job.status), x.job.assignee ? ` · ${x.job.assignee}` : ' · chưa ai nhận', x.job.due_at && isOpen ? (() => { const du = H.due(x.job.due_at); return [' · ', H.pill(du.text, du.tone)]; })() : null] : null;
        const swapInfo = x.swap ? [jobA(x.swap), ' · ', H.st('job_st', x.swap.status), ' · Logistics đổi kit'] : null;
        return [
          h('div.h-row', H.st('incident_st', x.status), h('b', x.label), x.kit ? H.pill(H.label('kit_kinds', x.kit.kind), x.kit.kind === 'iphone' ? 'blue' : 'violet') : null),
          h('p.inc-text', x.text || '–'),
          x.photos && x.photos.length ? h('div.inc-photos', h('div.thumbs', x.photos.map((id, i) => h('a.thumb', { href: photoUrl(id), target: '_blank', rel: 'noopener', title: `Ảnh ${i + 1}` }, h('img', { src: photoUrl(id), alt: `Ảnh sự cố ${i + 1}`, loading: 'lazy' }))))) : null,
          heldBy && isOpen ? H.note(`${heldBy} đang giữ sự cố này. Người giữ hoặc Tech Lead báo kết quả.`, 'wait') : null,
          acts.length ? h('div.inc-actions', acts) : null,
          h('section', h('h3', 'Thông tin'), H.dl([
            ['BO', siteLink], ['Kit', kitLink], ['Thiết bị', x.device ? `${x.device.code} · ${x.device.type}` : null],
            ['Người báo', x.raised_by ? `${x.raised_by.name} (${x.raised_by.role_label})` : 'Hệ thống'], ['Lúc báo', H.when(x.created_at)],
            ['Việc xử lý', jobInfo], ['Việc đổi kit', swapInfo], ['Cách xử lý', x.resolution_label ? `${x.resolution_label}${x.resolved_by ? ` · ${x.resolved_by}` : ''}` : null],
            [x.status === 'cancelled' ? 'Lý do huỷ' : 'Ghi chú xử lý', x.resolve_note || null],
          ])),
          h('section', h('h3', 'Diễn biến'), timeline(x, r.log || [])),
          isOpen && !acts.length ? D.src(swapOnly(x) ? 'Logistics sẽ đổi kit ở lượt gần nhất; sự cố tự đóng khi đổi xong.' : ctx.role === 'sale' || ctx.role === 'sale_head' ? 'Tech sẽ nhận và xử lý; bạn được báo khi xong.' : 'Tech nhận và xử lý sự cố này.') : null,
        ];
      }
      function timeline(x, log) {
        let items;
        if (log.length) items = [...log].reverse().map((l) => ({ ts: l.ts, text: l.text, tone: TL_TONE[l.action] || 'off' }));
        else {
          items = [{ ts: x.created_at, text: `${x.raised_by ? x.raised_by.name : 'Hệ thống'} báo sự cố`, tone: 'lost' }];
          if (x.ack_at && x.status !== 'cancelled') items.push({ ts: x.ack_at, text: 'Tech nhận xử lý', tone: 'blue' });
          if (x.status === 'resolved') items.push({ ts: x.resolved_at, text: `Đã xử lý: ${x.resolution_label}`, tone: 'go' });
          if (x.status === 'cancelled') items.push({ ts: x.resolved_at, text: 'Đã huỷ', tone: 'off' });
        }
        return h('ol.inc-tl', items.map((it) => h('li', { 'data-tone': it.tone }, h('i'), h('span.inc-tl-b', h('span', it.text), h('small', H.when(it.ts))))));
      }

      async function resolveDlg(x, resolutions) {
        const needKit = (id) => id === 'swap' || id === 'office_repair';
        let devs = [];
        if (x.kit && x.site) {
          try { const o = await ctx.api('GET', `/api/hub/outlets/${x.site.id}`); const k = (o.kits || []).find((y) => y.id === x.kit.id); devs = k ? k.devices || [] : []; } catch { devs = []; }
        }
        if (!ctx.alive()) return;
        const radios = (resolutions || []).map((rs) => {
          const dis = needKit(rs.id) && !x.kit;
          return h('label.inc-opt', { 'data-off': dis ? '1' : null },
            h('input', { type: 'radio', name: 'resolution', value: rs.id, disabled: dis }),
            h('span', rs.label), h('small', dis ? 'Sự cố chưa gắn kit nên chưa chọn được. Cần đổi máy thì bấm "Gắn kit" trước.' : needKit(rs.id) && x.kit.away ? AWAY_HINT : RES_HINT[rs.id] || ''));
        });
        const devSel = devs.length ? h('select', { name: 'device_id' }, h('option', { value: '' }, 'Không rõ / cả kit'), devs.map((dv) => h('option', { value: dv.id, selected: x.device && x.device.id === dv.id }, `${dv.code} · ${dv.type_name || dv.type}`))) : null;
        const devField = devSel ? h('label.h-field', { hidden: true }, h('span', 'Thiết bị hỏng'), devSel, h('small', 'Để Tech biết sửa gì khi kit về')) : null;
        const note = h('textarea', { name: 'note', rows: 3, maxlength: 500, placeholder: 'Ví dụ: Cắm lại cáp nguồn CM5, máy ghi bình thường.' });
        const form = h('form.inc-form', { onsubmit: (e) => e.preventDefault() },
          h('p.sub', `${x.code} · ${x.label} tại ${x.site ? x.site.name : '–'}`),
          h('fieldset.inc-res', h('legend.h-muted', 'Cách xử lý'), radios),
          devField,
          h('label.h-field', h('span', 'Đã xử lý thế nào'), note, h('small', 'Bắt buộc, trừ khi "Không phải sự cố".')));
        form.addEventListener('change', () => { const v = (form.querySelector('input[name="resolution"]:checked') || {}).value; if (devField) devField.hidden = !needKit(v); });
        ARL.modal({
          title: 'Báo đã xử lý', body: form, wide: false,
          actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, {
            label: 'Lưu kết quả', cls: 'primary', run: async (c) => {
              const res = (form.querySelector('input[name="resolution"]:checked') || {}).value;
              if (!res) { c.setErr('Chọn cách xử lý.'); return false; }
              const n = note.value.trim();
              if (res !== 'invalid' && n.length < 3) { c.setErr('Ghi ngắn đã xử lý thế nào (ít nhất 3 ký tự).'); note.focus(); return false; }
              const body = { resolution: res, note: n };
              if (devSel && needKit(res) && devSel.value) body.device_id = Number(devSel.value);
              await ctx.api('POST', `/api/hub/incidents/${x.id}/resolve`, body);
              ARL.toast(needKit(res) ? (x.kit.away ? `Đã xử lý ${x.code}. Kit đã rời BO của sự cố nên được đưa vào Đối chiếu.` : `Đã xử lý ${x.code}. Hệ thống đã tạo việc tiếp theo.`) : `Đã xử lý ${x.code}.`);
              refreshDetail(); reloadList();
              return true;
            },
          }],
        });
      }
      async function cancelDlg(x) {
        const intro = x.swap ? 'Sự cố sẽ đóng; việc xử lý của Tech và việc đổi kit đi kèm bị huỷ, kit được gỡ cờ lỗi do lần báo này đặt.' : 'Sự cố sẽ đóng và việc xử lý của Tech (nếu có) bị huỷ.';
        const reason = await H.reason(`Huỷ sự cố ${x.code}`, { intro, label: 'Lý do huỷ', submit: 'Huỷ sự cố', danger: true, placeholder: 'Ví dụ: Báo nhầm BO.' });
        if (!reason) return;
        await ctx.api('POST', `/api/hub/incidents/${x.id}/cancel`, { reason });
        ARL.toast(`Đã huỷ sự cố ${x.code}.`);
        refreshDetail(); reloadList();
      }
      // Gắn kit cho sự cố báo lúc chưa rõ kit nào: chọn kit đang ở BO; kit đã có sự cố cùng lỗi thì máy chủ gộp vào đó.
      async function attachDlg(x) {
        let kits = [];
        try { const o = await ctx.api('GET', `/api/hub/outlets/${x.site.id}`); kits = (o.kits || []).filter((k) => k.site && k.site.id === x.site.id && k.status === 'at_bo'); } catch { kits = []; }
        if (!ctx.alive()) return;
        if (!kits.length) { ARL.toast('BO này không có kit nào đang ở BO để gắn.', true); return; }
        const kitSel = h('select', { name: 'kit_id' }, h('option', { value: '' }, 'Chọn kit…'), kits.map((k) => h('option', { value: k.id }, `${k.code} · ${k.kind_label || H.label('kit_kinds', k.kind)}`)));
        const devSel = h('select', { name: 'device_id' });
        const fillDevs = () => {
          const k = kits.find((y) => String(y.id) === kitSel.value);
          H.clear(devSel, h('option', { value: '' }, 'Không rõ / cả kit'), ((k && k.devices) || []).map((dv) => h('option', { value: dv.id }, `${dv.code} · ${dv.type_name || dv.type}`)));
          devSel.disabled = !k;
        };
        if (kits.length === 1) kitSel.value = String(kits[0].id);
        kitSel.addEventListener('change', fillDevs);
        fillDevs();
        const form = h('form.inc-form', { onsubmit: (e) => e.preventDefault() },
          h('p.sub', `${x.code} · ${x.label} tại ${x.site ? x.site.name : '–'}`),
          h('label.h-field', h('span', 'Kit'), kitSel, h('small', 'Kit đang ở BO này')),
          h('label.h-field', h('span', 'Thiết bị lỗi'), devSel, h('small', 'Không bắt buộc')),
          D.src('Kit đã có sự cố đang mở cùng lỗi thì sự cố này được gộp vào đó, để một lỗi chỉ đếm một lần.'));
        ARL.modal({
          title: 'Gắn kit cho sự cố', body: form, wide: false,
          actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, {
            label: 'Gắn kit', cls: 'primary', run: async (c) => {
              if (!kitSel.value) { c.setErr('Chọn kit.'); kitSel.focus(); return false; }
              const r = await ctx.api('POST', `/api/hub/incidents/${x.id}/kit`, D.q({ kit_id: Number(kitSel.value), device_id: devSel.value ? Number(devSel.value) : null }));
              ARL.toast(r.merged ? `Kit này đang có sự cố ${r.incident.code} cùng lỗi: đã gộp ${x.code} vào đó.` : `Đã gắn kit cho ${x.code}.`);
              reloadList();
              if (r.merged) ctx.setParams([r.incident.id]); else refreshDetail();
              return true;
            },
          }],
        });
      }

      // ───── Báo sự cố ─────
      let labelsCache = null;
      async function createDlg(preSite) {
        if (ctx.query.new) ctx.setQuery({ new: null }); // mở một lần, không mở lại khi đổi chi tiết
        const [os, lb] = await Promise.all([ctx.api('GET', '/api/hub/outlets'), labelsCache ? Promise.resolve(labelsCache) : ctx.api('GET', '/api/hub/labels')]);
        if (!ctx.alive()) return;
        labelsCache = lb;
        const ORDER = { live: 0, paused: 1, ending: 2, planned: 3 };
        // Sale Lead chỉ báo được sự cố cho BO mình phụ trách (kể cả khi cấu hình cho xem mọi BO); máy chủ từ chối BO của Sale khác.
        const sites = (os.outlets || []).filter((o) => o.ops_status !== 'ended' && (ctx.role !== 'sale' || (o.sale && o.sale.id === ctx.user.id))).sort((a, b) => (ORDER[a.ops_status] ?? 9) - (ORDER[b.ops_status] ?? 9) || a.name.localeCompare(b.name, 'vi'));
        if (!sites.length) { ARL.toast('Chưa có BO nào để báo sự cố.', true); return; }
        const allLabels = [...new Set(Object.values(lb.labels || {}).flat())];
        const siteSel = h('select', { name: 'site_id', required: true }, h('option', { value: '' }, 'Chọn BO…'), sites.map((o) => h('option', { value: o.id, selected: String(o.id) === String(preSite || '') }, `${o.name}${o.code ? ` · ${o.code}` : ''}${o.ops_status !== 'live' ? ` (${H.label('outlet_st', o.ops_status || 'planned')})` : ''}`)));
        const kitSel = h('select', { name: 'kit_id', disabled: true }, h('option', { value: '' }, 'Chọn BO trước'));
        const labSel = h('select', { name: 'label', required: true });
        const urgent = h('input', { type: 'checkbox', name: 'urgent' });
        const text = h('textarea', { name: 'text', rows: 3, maxlength: 500, placeholder: 'Ví dụ: Đèn báo đỏ, máy không ghi từ 9 giờ sáng.' });
        const pp = ARL.photoPicker(4, 'Chụp ảnh');
        let kits = [];
        const fillLabels = () => {
          const k = kits.find((y) => String(y.id) === kitSel.value);
          const list = k && lb.labels[k.kind] ? lb.labels[k.kind] : allLabels;
          const cur = labSel.value;
          H.clear(labSel, h('option', { value: '' }, 'Chọn lỗi…'), list.map((l) => h('option', { value: l, selected: l === cur }, l)));
        };
        const fillKits = async () => {
          kits = [];
          H.clear(kitSel, h('option', { value: '' }, siteSel.value ? 'Đang tải kit…' : 'Chọn BO trước'));
          kitSel.disabled = true;
          if (siteSel.value) {
            try { const o = await ctx.api('GET', `/api/hub/outlets/${siteSel.value}`); kits = (o.kits || []).filter((k) => k.site && String(k.site.id) === siteSel.value); } catch { kits = []; }
            H.clear(kitSel, h('option', { value: '' }, kits.length ? 'Không rõ kit nào' : 'BO chưa có kit'), kits.map((k) => h('option', { value: k.id }, `${k.code} · ${k.kind_label || H.label('kit_kinds', k.kind)}`)));
            kitSel.disabled = !kits.length;
            if (kits.length === 1) kitSel.value = String(kits[0].id);
          }
          fillLabels();
        };
        siteSel.addEventListener('change', fillKits);
        kitSel.addEventListener('change', fillLabels);
        const field = (label, input, hint, req) => h('label.h-field', h('span', label, req ? h('i', ' *') : null), input, hint ? h('small', hint) : null);
        const form = h('form.inc-form', { onsubmit: (e) => e.preventDefault() },
          h('div.h-fields',
            field('BO', siteSel, ctx.role === 'sale' ? 'Chỉ BO bạn phụ trách' : null, true),
            field('Kit', kitSel, 'Biết kit nào thì chọn, Tech xử lý nhanh hơn'),
            field('Lỗi', labSel, 'Danh sách lỗi theo dòng máy (Tech chốt)', true),
            h('label.h-field.h-inline.h-full', urgent, h('span', 'Gấp — BO không ghi hình được'), h('small', { style: { gridColumn: '2' } }, 'Tech được báo ngay và việc được xếp lên đầu.')),
            field('Mô tả', text, 'Thấy gì, từ lúc nào, BO đã thử gì', true)),
          h('div.inc-photos', h('span.h-muted', 'Ảnh (không bắt buộc)'), pp.el));
        form.querySelector('textarea').closest('label').classList.add('h-full');
        fillLabels();
        if (preSite) fillKits();
        ARL.modal({
          title: 'Báo sự cố', body: form, wide: true,
          actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, {
            label: 'Gửi cho Tech', cls: 'primary', run: async (c) => {
              if (!siteSel.value) { c.setErr('Chọn BO.'); siteSel.focus(); return false; }
              if (!labSel.value) { c.setErr('Chọn lỗi.'); labSel.focus(); return false; }
              if (text.value.trim().length < 3) { c.setErr('Mô tả ngắn sự cố (ít nhất 3 ký tự).'); text.focus(); return false; }
              if (pp.busy) { c.setErr('Đang xử lý ảnh, chờ một chút.'); return false; }
              const r = await ctx.api('POST', '/api/hub/incidents', { site_id: Number(siteSel.value), kit_id: kitSel.value ? Number(kitSel.value) : null, label: labSel.value, text: text.value.trim(), urgent: urgent.checked, photos: pp.photos });
              ARL.toast(r.duplicate ? `Sự cố này đang mở (${r.incident.code}). Đã ghi thêm vào sự cố cũ và báo Tech Lead.` : `Đã báo sự cố ${r.incident.code}. Tech đã được báo.`);
              reloadList();
              setTimeout(() => { if (ctx.alive()) ctx.setParams([r.incident.id]); }, 0);
              return true;
            },
          }],
        });
        setTimeout(() => (preSite ? labSel : siteSel).focus(), 30);
      }

      // ───── Điều hướng ─────
      function route() {
        const q = fromQuery();
        if (q.status !== st.status || q.label !== st.label || q.site !== st.site || q.from !== st.from || q.to !== st.to || q.kind !== st.kind) {
          if (q.site !== st.site) st.siteName = '';
          Object.assign(st, q);
          chips.set(st.status);
          reloadList();
          const list = el.querySelector('.inc-list');
          if (list && !ctx.params[0]) list.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        const id = Number(ctx.params[0]);
        if (id) openDetail(id); else closeDetail();
        if (ctx.query.new === '1' && !document.querySelector('dialog[open]')) createDlg(ctx.query.site || null).catch((e) => ARL.toast(e.message, true));
      }
      ctx.onRoute(route);
      ctx.onCleanup(() => closeDetail());
      ctx.live(['incidents'], () => { reloadList(); if (loadStats) loadStats(); if (det) refreshDetail(); });
      ctx.every(60000, paint); // thời gian chờ Tech nhận
      reloadList();
      if (Number(ctx.params[0])) openDetail(Number(ctx.params[0]));
      if (ctx.query.new === '1') createDlg(ctx.query.site || null).catch((e) => ARL.toast(e.message, true));
    },
  });
})();
