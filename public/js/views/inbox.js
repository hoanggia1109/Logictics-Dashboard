/* Ops Hub — Thông báo (#/inbox) và Nhật ký thao tác (#/log).
   Thông báo: hộp thư riêng của từng người; bấm một dòng thì đánh dấu đã đọc và mở đúng chỗ cần xử lý; chuông trên thanh trên cập nhật theo.
   Nhật ký: ai làm gì, lúc nào, trên đối tượng nào (Lead và Head of Sale; Head of Sale chỉ thấy yêu cầu, BO, sự cố). */
(() => {
  'use strict';
  const H = ARL.H, { h } = H;
  const LEVEL_TONE = { alert: 'lost', warn: 'wait', info: 'blue' };
  const LEVEL_LABEL = { alert: 'Khẩn', warn: 'Cần chú ý', info: 'Thông tin' };

  // ───────────── Thông báo ─────────────
  ARL.hub.view('inbox', {
    mount(el, ctx) {
      const S = { f: ctx.query.f === 'unread' ? 'unread' : 'all' };
      let data = null;
      const markAll = H.btn('Đánh dấu đã đọc hết', async () => {
        const r = await ctx.api('POST', '/api/hub/inbox/read', { all: true });
        ARL.toast('Đã đánh dấu đã đọc hết.');
        ctx.refreshMe();
        if (data) { for (const it of data.items) it.read_at = it.read_at || ARL.now(); data.unread = r.unread; }
        paint();
        if (S.f === 'unread') reload();
      }, 'ghost');
      el.append(H.head('Thông báo', 'Việc mới, quá hạn, vướng, đối chiếu… gửi riêng cho bạn. Bấm vào một thông báo để mở đúng chỗ cần xử lý.', markAll));
      const tabsHost = h('div');
      const list = h('div.inbox-list', { 'aria-live': 'polite' }, H.loading(6));
      const foot = h('p.sub.inbox-foot');
      el.append(tabsHost, list, foot);
      const paintTabs = () => tabsHost.replaceChildren(H.tabs([['all', 'Tất cả'], ['unread', 'Chưa đọc', data ? data.unread : 0]], S.f, (k) => { S.f = k; ctx.setQuery({ f: k === 'all' ? '' : k }); reload(); }));
      paintTabs();

      async function open(it) {
        if (!it.read_at) {
          try {
            const r = await ctx.api('POST', '/api/hub/inbox/read', { ids: [it.id] });
            it.read_at = ARL.now();
            if (data) data.unread = r.unread;
            ctx.refreshMe();
          } catch (e) { ARL.toast(e.message, true); }
        }
        const to = ctx.linkTo(it.link);
        if (to) location.hash = to;
        // Chỉ báo "không mở được" khi đường dẫn trỏ tới một màn hình có thật mà vai trò này không có quyền mở.
        else { paint(); if (it.link && ARL.hub.linkView(it.link)) ARL.toast('Vai trò của bạn không mở được mục này; đã đánh dấu đã đọc.'); }
      }
      function paint() {
        if (!data) return;
        paintTabs();
        markAll.hidden = !data.unread;
        const items = S.f === 'unread' ? data.items.filter((it) => !it.read_at) : data.items;
        if (!items.length) {
          list.replaceChildren(H.empty(S.f === 'unread' ? 'Bạn đã đọc hết thông báo.' : 'Chưa có thông báo nào. Khi có việc mới giao cho bạn, việc quá hạn hoặc cần đối chiếu, thông báo sẽ hiện ở đây.'));
          foot.textContent = '';
          return;
        }
        const days = new Map();
        for (const it of items) { const d = H.dateOf(it.ts); if (!days.has(d)) days.set(d, []); days.get(d).push(it); }
        const today = H.today(), yest = ARL.addDays(today, -1);
        const out = [];
        for (const [d, arr] of days) {
          out.push(h('h2.inbox-day', d === today ? 'Hôm nay' : d === yest ? 'Hôm qua' : H.day(d)));
          out.push(h('ul.inbox-group', arr.map((it) => {
            const to = ctx.linkTo(it.link);
            return h('li', h('button.inbox-it', { type: 'button', 'data-unread': it.read_at ? null : '1', 'data-tone': LEVEL_TONE[it.level] || 'blue', onclick: () => open(it), 'aria-label': `${it.read_at ? '' : 'Chưa đọc. '}${it.text}` },
              h('span.inbox-dot', { 'aria-hidden': 'true' }),
              h('span.inbox-txt', it.text),
              h('span.inbox-meta', h('time', H.time(it.ts)), it.level !== 'info' ? H.pill(LEVEL_LABEL[it.level] || it.level, LEVEL_TONE[it.level] || 'off') : null, to ? h('span.inbox-go', 'Mở') : null)));
          })));
        }
        list.replaceChildren(...out);
        foot.textContent = data.items.length >= 200 ? 'Đang hiện 200 thông báo gần nhất.' : '';
      }
      let gen = 0;
      async function reload() {
        const my = ++gen;
        try {
          const r = await ctx.api('GET', '/api/hub/inbox', null, S.f === 'unread' ? { unread: '1', limit: 200 } : { limit: 200 });
          if (my !== gen || !ctx.alive()) return;
          data = r;
          paint();
        } catch (e) { if (!data) list.replaceChildren(H.error(e, reload)); else ARL.toast(e.message, true); }
      }
      ctx.live(['inbox'], reload);
      reload();
    },
  });

  // ───────────── Nhật ký thao tác ─────────────
  const ENTITY = { job: 'Việc', kit: 'Kit', device: 'Thiết bị', card: 'Thẻ nhớ', handover: 'Phiếu bàn giao', request: 'Yêu cầu', outlet: 'BO', incident: 'Sự cố', recon: 'Đối chiếu', roster: 'Phân ca', attendance: 'Chấm công', acc: 'Phụ kiện', perf: 'Đánh giá', config: 'Cấu hình', import: 'Nhập dữ liệu', type: 'Danh mục' };
  const SALE_ENT = ['request', 'outlet', 'incident'];
  ARL.hub.view('log', {
    mount(el, ctx) {
      const sale = ctx.role === 'sale_head';
      const ents = sale ? SALE_ENT : Object.keys(ENTITY);
      const q0 = ctx.query || {};
      const S = { entity: ents.includes(q0.entity) ? q0.entity : '', id: /^\d+$/.test(q0.id || '') ? q0.id : '', actor: /^\d+$/.test(q0.actor || '') ? q0.actor : '', from: q0.from || '', to: q0.to || '', q: q0.q || '' };
      const actors = new Map();
      let data = null;
      const sync = () => ctx.setQuery({ entity: S.entity, id: S.id, actor: S.actor, from: S.from, to: S.to, q: S.q });
      el.append(H.head('Nhật ký thao tác', sale ? 'Ai đã làm gì trên yêu cầu, BO và sự cố. Mỗi thao tác ghi kèm người làm và thời điểm. Thao tác của FO chỉ ghi vai "FO".'
        : ctx.role === 'admin' ? 'Ai đã làm gì, lúc nào, trên việc, kit, thẻ, BO… Mỗi thao tác ghi kèm người làm và thời điểm.'
          : 'Việc, chấm công, phân ca của team bạn và dữ liệu chung (kit, thẻ, BO, yêu cầu). Lọc theo người chỉ với người trong team.'));
      const entSel = h('select', { 'aria-label': 'Đối tượng', onchange: () => { S.entity = entSel.value; S.id = ''; sync(); reload(); } }, h('option', { value: '' }, 'Mọi đối tượng'), ents.map((k) => h('option', { value: k, selected: k === S.entity }, ENTITY[k])));
      const actSel = h('select', { 'aria-label': 'Người làm', onchange: () => { S.actor = actSel.value; sync(); reload(); } });
      const fromIn = h('input', { type: 'date', value: S.from, 'aria-label': 'Từ ngày', max: H.today(), onchange: () => { S.from = fromIn.value; sync(); reload(); } });
      const toIn = h('input', { type: 'date', value: S.to, 'aria-label': 'Đến ngày', max: H.today(), onchange: () => { S.to = toIn.value; sync(); reload(); } });
      const search = H.search('Tìm trong nội dung', (v) => { S.q = v; sync(); paint(); }, S.q);
      const idBox = h('div.log-id', { hidden: true });
      el.append(h('div.h-tools.log-tools', entSel, actSel, h('label.log-date', h('span', 'Từ'), fromIn), h('label.log-date', h('span', 'đến'), toIn), search), idBox);
      const table = H.table({
        columns: [
          { key: 'ts', label: 'Lúc', value: (r) => r.ts, render: (r) => h('span.log-ts', H.time(r.ts), h('small', H.day(H.dateOf(r.ts)))), nowrap: true, desc: true },
          { key: 'actor', label: 'Người làm', value: (r) => r.actor, render: (r) => (r.actor_id ? r.actor : h('span.h-muted', r.actor || 'Hệ thống')) }, // người ngoài team: chỉ tên / vai, không lọc theo
          { key: 'entity', label: 'Đối tượng', value: (r) => `${r.entity}${String(r.entity_id || '').padStart(9, '0')}`, render: (r) => {
            const label = `${ENTITY[r.entity] || r.entity}${r.entity_id ? ' #' + r.entity_id : ''}`;
            const href = r.entity_id ? ctx.linkTo(`${r.entity}:${r.entity_id}`) : null;
            return href ? H.link(href, label, { onclick: (e) => e.stopPropagation() }) : label;
          } },
          { key: 'text', label: 'Thao tác', sort: false, render: (r) => h('span.log-text', r.text) },
        ],
        rows: [], pageSize: 50, sort: { key: 'ts', dir: -1 },
        empty: 'Không có thao tác nào theo bộ lọc này.',
        onRow: (r) => { if (r.entity_id) { S.entity = r.entity; S.id = String(r.entity_id); entSel.value = r.entity; sync(); reload(); } },
      });
      const body = h('div', H.loading(6));
      const foot = h('p.sub.log-foot');
      el.append(body, foot);
      function paintActors() {
        H.clear(actSel, h('option', { value: '' }, 'Mọi người'), [...actors.entries()].sort((a, b) => a[1].localeCompare(b[1], 'vi')).map(([id, name]) => h('option', { value: String(id), selected: String(id) === S.actor }, name)));
      }
      function paint() {
        if (!data) return;
        idBox.hidden = !S.id;
        if (S.id) idBox.replaceChildren(h('span', `Đang xem nhật ký của ${ENTITY[S.entity] || 'đối tượng'} #${S.id}. `), h('button.ghost.small', { type: 'button', onclick: () => { S.id = ''; sync(); reload(); } }, 'Xem tất cả'));
        const rows = S.q ? data.items.filter((r) => H.match(`${r.text} ${r.actor}`, S.q)) : data.items;
        if (!body.contains(table)) body.replaceChildren(table);
        table.update(rows);
        foot.textContent = data.items.length >= 1000 ? 'Đang hiện 1.000 thao tác mới nhất theo bộ lọc. Chọn khoảng ngày để xem cũ hơn.' : `${H.num(data.items.length)} thao tác.`;
      }
      let gen = 0;
      async function reload() {
        const my = ++gen;
        try {
          const r = await ctx.api('GET', '/api/hub/log', null, Object.fromEntries(Object.entries({ entity: S.entity, id: S.id, actor: S.actor, from: S.from, to: S.to, limit: 1000 }).filter(([, v]) => v !== '' && v !== null && v !== undefined)));
          if (my !== gen || !ctx.alive()) return;
          data = r;
          for (const it of r.items) if (it.actor_id && !actors.has(it.actor_id)) actors.set(it.actor_id, it.actor);
          paintActors(); paint();
        } catch (e) {
          // Lọc theo người ngoài team (vd. mở từ liên kết cũ): bỏ bộ lọc người, xem lại toàn bộ.
          if (e.status === 403 && S.actor) { ARL.toast(e.message, true); S.actor = ''; sync(); reload(); return; }
          if (!data) body.replaceChildren(H.error(e, reload)); else ARL.toast(e.message, true);
        }
      }
      paintActors();
      ctx.live(sale ? ['requests', 'outlets', 'incidents'] : ['jobs', 'kits', 'devices', 'cards', 'handovers', 'requests', 'outlets', 'incidents', 'recon', 'roster', 'acc', 'config', 'types'], reload);
      ctx.onRoute((c) => {
        const q = c.query || {};
        const next = { entity: ents.includes(q.entity) ? q.entity : '', id: /^\d+$/.test(q.id || '') ? q.id : '', actor: q.actor || '', from: q.from || '', to: q.to || '', q: q.q || '' };
        if (JSON.stringify(next) === JSON.stringify(S)) return;
        Object.assign(S, next); entSel.value = S.entity; fromIn.value = S.from; toIn.value = S.to; search.value = S.q; reload();
      });
      reload();
    },
  });
})();
