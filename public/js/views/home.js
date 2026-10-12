/* Ops Hub — Việc của tôi (#/home, #/home/<id>): trang Tech / Logistic Executive mở cả ngày trên điện thoại.
   Ca làm hôm nay, việc đang giữ (sắp theo độ gấp, một chạm để bắt đầu / báo xong), việc chưa ai nhận của team (nhận hoặc Lead giao),
   hàng việc của team, thẻ nhớ, những thứ cần để ý, lối tắt. Dữ liệu tự cập nhật tại chỗ khi người khác thao tác. */
(() => {
  'use strict';
  const H = ARL.H, { h } = H;

  const greet = () => {
    const hr = parseInt(H.time(ARL.now()), 10) || 0; // giờ theo múi giờ của hệ thống
    return hr < 11 ? 'Chào buổi sáng' : hr < 13 ? 'Chào buổi trưa' : hr < 18 ? 'Chào buổi chiều' : 'Chào buổi tối';
  };
  const canView = (ctx, id) => { const v = ARL.hub.views.get(id); return !!(v && v.roles.includes(ctx.role)); };

  ARL.hub.view('home', {
    mount(el, ctx) {
      const W = ARL.hubWork;
      if (!W) { el.append(H.error(new Error('Thiếu thành phần Bảng việc. Tải lại trang.'))); return; }
      const lead = ctx.role === 'admin' || ctx.isLead(ctx.team);
      const D = { me: ctx.hubMe || null, home: null, jobs: null };

      // ── Khung trang ──
      const given = ARL.nameParts(ctx.user.name).given || ctx.user.name;
      const subEl = h('p.sub', H.day(H.today()));
      const head = H.head(`${greet()}, ${given}`, null, canView(ctx, 'jobs') ? H.link('#/jobs', 'Mở Bảng việc', { class: 'btn' }) : null);
      head.querySelector('.h-head-l').append(subEl);
      const shiftBox = h('div.home-shift');
      const kpiBox = h('div.home-kpis');
      const mineCount = h('b.home-count');
      const mineList = h('div.home-list', { 'aria-live': 'polite' }, H.loading(3));
      const poolCount = h('b.home-count');
      const poolHint = h('p.sub');
      const poolList = h('div.home-list', H.loading(2));
      const poolSec = h('section.home-sec', h('div.h-sec', h('h2', 'Chưa ai nhận ', poolCount), poolHint), poolList);
      const queueBox = h('div');
      const watchBox = h('div');
      const links = h('div.home-links');
      el.append(head, shiftBox, kpiBox,
        h('section.home-sec', h('div.h-sec', h('h2', 'Việc của tôi ', mineCount), h('p.sub', 'Gấp và gần hạn lên trước. Bấm vào việc để xem chi tiết.')), mineList),
        poolSec,
        h('div.home-grid', queueBox, watchBox),
        links);

      // ── Ca làm ──
      function paintShift() {
        const m = D.me;
        if (!m) return;
        subEl.textContent = `${H.day(m.today || H.today())}${m.user && m.user.role_label ? ' · ' + m.user.role_label : ''}`;
        if (m.on_shift === null || m.on_shift === undefined) { shiftBox.replaceChildren(); return; }
        const sh = m.shift, a = m.attendance;
        const span = sh && sh.start ? `${sh.shift ? sh.shift + ' ' : ''}${sh.start}–${sh.end}` : '';
        const att = a && a.checkin_at ? ` Vào ca lúc ${H.time(a.checkin_at)}${a.late_min ? ` (trễ ${a.late_min} phút)` : ''}.` : '';
        let text, tone;
        if (m.on_shift) { text = `Bạn đang trong ca${span ? ' ' + span : ''}.${att} Việc mới tự giao cho người trong ca, ít việc nhất.`; tone = 'go'; }
        else if (a && a.status === 'leave') { text = 'Hôm nay bạn nghỉ phép. Hệ thống không giao việc cho bạn.'; tone = null; }
        else if (sh && sh.start) { text = `Ca hôm nay: ${span}. Ngoài giờ ca, hệ thống không tự giao việc cho bạn.${att}`; tone = 'wait'; }
        else { text = 'Hôm nay bạn không có ca trong bảng phân ca. Hệ thống không tự giao việc cho bạn; bạn vẫn nhận tay được nếu cần.'; tone = 'wait'; }
        shiftBox.replaceChildren(h('p.h-note.home-shift-note', tone ? { 'data-tone': tone } : null, h('i.home-dot', { 'data-on': m.on_shift ? '1' : '0', 'aria-hidden': 'true' }), h('span', text, canView(ctx, 'roster') ? [' ', H.link('#/roster', 'Xem bảng phân ca')] : null)));
      }

      // ── Số liệu ──
      function paintKpis() {
        const j = (D.me && D.me.jobs) || {}, q = (D.home && D.home.queue) || null;
        const go = (query) => () => ctx.go('jobs', [], query);
        const tiles = [
          H.kpi({ label: 'Đang giữ', value: j.open ?? '–', tone: 'blue', hint: 'việc chờ làm và đang làm', onClick: go({ scope: 'mine' }) }),
          H.kpi({ label: 'Quá hạn', value: j.overdue ?? '–', tone: j.overdue ? 'lost' : 'go', hint: j.overdue ? 'làm trước hoặc báo vướng' : 'không có việc trễ', onClick: go({ scope: 'mine', od: '1' }) }),
          H.kpi({ label: 'Xong hôm nay', value: j.done_today ?? '–', tone: 'go', hint: 'việc bạn đã báo xong' }),
        ];
        if (q) tiles.push(H.kpi({ label: lead ? 'Team: chưa ai nhận' : 'Team chưa ai nhận', value: q.pool, tone: q.pool ? 'wait' : null, hint: `${q.open} việc đang mở của team`, onClick: go({ scope: 'team', who: lead ? 'pool' : '' }) }));
        if (q && lead) {
          tiles.push(H.kpi({ label: 'Team: quá hạn', value: q.overdue, tone: q.overdue ? 'lost' : 'go', hint: q.urgent ? `${q.urgent} việc gấp` : 'việc chưa vướng mà trễ hạn', onClick: go({ scope: 'team', od: '1' }) }));
          tiles.push(H.kpi({ label: 'Team: đang vướng', value: q.blocked, tone: q.blocked ? 'wait' : null, hint: 'chờ bên khác, hạn tạm dừng' }));
        }
        kpiBox.replaceChildren(H.kpis(...tiles));
        if (D.me && D.me.jobs) ctx.badge('home', j.overdue || j.open, j.overdue ? null : 'blue');
      }

      // ── Danh sách việc ──
      const after = () => { rJobs(); rMe(); rHome(); };
      const assignBtn = (j) => {
        const b = h('button', { type: 'button', onclick: () => W.assignMenu(ctx, b, [j], (D.jobs && D.jobs.members) || [], after) }, 'Giao…');
        return b;
      };
      function paintJobs() {
        if (!D.jobs) return;
        const me = ctx.user.id;
        const all = D.jobs.jobs || [];
        const mine = all.filter((j) => j.assignee && j.assignee.id === me).sort(W.urgency);
        const pool = all.filter((j) => !j.assignee).sort(W.urgency);
        mineCount.textContent = String(mine.length);
        poolCount.textContent = String(pool.length);
        const sigOf = (j) => W.sig(j) + (lead ? '|L' : '');
        if (!mine.length) {
          mineList.replaceChildren(H.empty(D.me && D.me.on_shift === false ? 'Bạn chưa có việc nào. Ngoài ca hệ thống không tự giao việc; nhận việc chưa ai nhận bên dưới nếu cần.' : 'Bạn chưa có việc nào đang mở. Việc mới sẽ tự đến khi có việc cho team; hoặc nhận việc chưa ai nhận bên dưới.'));
        } else {
          if (mineList.querySelector('.h-empty, .h-loading')) mineList.replaceChildren();
          W.keyed(mineList, mine, (j) => j.id, sigOf, (j) => W.item(ctx, j, { href: `#/home/${j.id}`, action: W.primary(ctx, j, after) }));
        }
        const members = (D.jobs.members || []).length;
        poolHint.textContent = !pool.length ? '' : lead && members ? 'Giao cho người trong ca, hoặc để hệ thống tự giao khi có người vào ca.'
          : D.me && D.me.on_shift ? 'Bạn đang trong ca: nhận việc nào bạn làm được ngay.' : 'Bạn đang ngoài ca: vẫn nhận tay được nếu cần.';
        poolSec.hidden = !pool.length && !lead;
        if (!pool.length) poolList.replaceChildren(H.empty('Không có việc nào đang chờ người nhận.'));
        else {
          if (poolList.querySelector('.h-empty, .h-loading')) poolList.replaceChildren();
          W.keyed(poolList, pool, (j) => j.id, sigOf, (j) => W.item(ctx, j, { href: `#/home/${j.id}`, action: lead && members ? assignBtn(j) : (!lead && W.primary(ctx, j, after)) || H.link(`#/home/${j.id}`, 'Xem', { class: 'btn' }) }));
        }
      }

      // ── Hàng việc của team, thẻ, cần để ý ──
      function paintHome() {
        const d = D.home;
        if (!d) return;
        const cards = [];
        if (d.queue) {
          const q = d.queue;
          const on = d.on_shift || [];
          const row = (label, n, tone, query) => h('a.home-q', { href: `#/jobs?${new URLSearchParams(query)}`, 'data-tone': n && tone ? tone : null }, h('span', label), h('b', H.num(n)));
          cards.push(H.card(`Hàng việc team ${W.teamLabel(d.team)}`, [
            h('div.home-qgrid',
              row('Đang mở', q.open, null, { scope: 'team' }), row('Đang làm', q.doing, null, { scope: 'team', st: 'doing' }),
              row('Chưa ai nhận', q.pool, 'wait', { scope: 'team', who: lead ? 'pool' : '' }), row('Quá hạn', q.overdue, 'lost', { scope: 'team', od: '1' }),
              row('Đang vướng', q.blocked, 'wait', { scope: 'team', v: 'board' }), row('Việc gấp', q.urgent, 'lost', { scope: 'team' })),
            // Ai đang trong ca: chỉ Lead của team nhận danh sách này (máy chủ không gửi cho nhân viên).
            d.on_shift ? h('p.home-on', h('b', `Đang trong ca (${on.length}): `), on.length ? on.map((u) => u.name).join(', ') : 'chưa có ai. Việc mới để chung, ai vào ca sẽ được giao.') : null,
          ]));
          if (d.cards) {
            const c = d.cards;
            const cl = (label, n, href) => h(href ? 'a.home-q' : 'div.home-q', href ? { href } : null, h('span', label), h('b', H.num(n)));
            const ho = canView(ctx, 'cards') ? '#/cards?tab=handovers' : null;
            cards.push(H.card('Thẻ nhớ', d.team === 'tech'
              ? h('div.home-qgrid', cl('Phiếu chờ Tech nhận', c.to_receive, ho), cl('Thẻ Tech đang giữ', c.at_tech, canView(ctx, 'upload') ? '#/upload' : null), cl('Đã nhập, chờ trả', c.uploaded, ho))
              : h('div.home-qgrid', cl('Thẻ đã thu về VP', c.returned, canView(ctx, 'cards') ? '#/cards' : null), cl('Phiếu Tech trả, chờ nhận', c.to_receive, ho), cl('Thẻ sẵn sàng tại VP', c.office, canView(ctx, 'cards') ? '#/cards' : null))));
          }
        }
        queueBox.replaceChildren(...cards);
        queueBox.className = cards.length > 1 ? 'home-pair' : '';
        const watch = d.watch || [];
        const TONE = { high: 'lost', mid: 'wait', low: null };
        watchBox.replaceChildren(watch.length ? H.card('Cần để ý', h('ul.home-watch', watch.map((w) => {
          const href = ctx.linkTo(w.link);
          return h('li', { 'data-tone': TONE[w.level] || null }, href ? H.link(href, w.text) : h('span', w.text));
        })), { sub: 'Những chỗ đang vướng, quá hạn lâu hoặc thiếu dữ liệu, cần người xử lý.' }) : '');
      }
      function paintLinks() {
        const L = [['jobs', 'Bảng việc'], ['dispatch', 'Điều phối chuyến'], ['kits', 'Kit & thiết bị'], ['cards', 'Thẻ nhớ & bàn giao'], ['upload', 'Nhập dung lượng'], ['incidents', 'Sự cố'], ['roster', 'Phân ca'], ['me', 'Hiệu suất của tôi'], ['inbox', 'Thông báo']];
        const items = L.filter(([id]) => canView(ctx, id)).map(([id, label]) => H.link(`#/${id}`, label, { class: 'btn' }));
        const add = ctx.can('admin', 'tech_lead', 'tech', 'lead', 'logistic') ? H.btn('Tạo việc giao tay', async () => { const j = await W.create(ctx, {}); if (j) { after(); ctx.setParams([j.id]); } }, 'ghost') : null;
        links.replaceChildren(h('h2.home-links-h', 'Lối tắt'), h('div.h-row', items, add));
      }

      // ── Nạp dữ liệu ──
      const rMe = W.coalesce(async () => {
        try { D.me = await ctx.api('GET', '/api/hub/me'); } catch (e) { if (!D.me) shiftBox.replaceChildren(H.error(e, rMe)); return; }
        if (!ctx.alive()) return;
        paintShift(); paintKpis();
      });
      const rHome = W.coalesce(async () => {
        try { D.home = await ctx.api('GET', '/api/hub/home'); } catch (e) { if (!D.home) queueBox.replaceChildren(H.error(e, rHome)); return; }
        if (!ctx.alive()) return;
        paintHome(); paintKpis();
      });
      const rJobs = W.coalesce(async () => {
        try { D.jobs = await ctx.api('GET', '/api/hub/jobs', null, { view: 'mine' }); } catch (e) { if (!D.jobs) mineList.replaceChildren(H.error(e, rJobs)); else ARL.toast(e.message, true); return; }
        if (!ctx.alive()) return;
        paintJobs();
      });
      paintShift(); paintKpis(); paintLinks();
      rMe(); rHome(); rJobs();

      const panel = W.panel(ctx, { onClose: () => ctx.setParams([]), onChanged: after });
      ctx.onRoute((c) => { const id = c.params[0]; if (id) panel.open(id); else panel.hide(); });
      if (ctx.params[0]) panel.open(ctx.params[0]);
      ctx.live(['jobs'], () => { rJobs(); rMe(); rHome(); panel.refresh(); });
      ctx.live(['roster', 'people'], () => { rMe(); rHome(); rJobs(); });
      ctx.live(['cards', 'handovers', 'kits', 'incidents', 'requests', 'outlets'], () => { rHome(); panel.refresh(); });
      ctx.every(60000, () => { paintJobs(); });
    },
  });
})();
