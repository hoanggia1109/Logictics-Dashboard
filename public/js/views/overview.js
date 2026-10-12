/* Ops Hub — Tổng quan vận hành: bức tranh toàn khối cho Lead, Head of Sale và Quản trị.
   Một lượt gọi GET /api/hub/overview cho cả trang; mọi con số do máy chủ tính, trang chỉ trình bày.
   Top 3 nhân sự chỉ hiện khi máy chủ trả về (Lead của team đó, Quản trị); khối Kinh doanh chỉ có ở Quản trị và Head of Sale. */
(() => {
  'use strict';
  const H = ARL.H, { h } = H, C = ARL.chart, D = ARL.dash;

  // Gom trạng thái kit thành ≤ 6 nhóm cho biểu đồ vành khuyên (đếm của máy chủ, chỉ cộng lại để vẽ).
  // Thứ tự và màu đã kiểm bằng công cụ kiểm bảng màu (mù màu đỏ–lục, sáng/tối): hai màu cạnh nhau luôn phân biệt được.
  const KIT_GROUPS = [
    { st: ['at_bo'], tone: 'violet' },
    { st: ['ready'], tone: 'go' },
    { st: ['preparing'], tone: 'off' },
    { label: 'Đang thu hồi / chờ check-in', st: ['recovering', 'returned'], tone: 'wait' },
    { label: 'Đã gán BO / đang giao', st: ['reserved', 'delivering'], tone: 'blue' },
    { label: 'Ở Tech (chờ kiểm, đang sửa)', st: ['wait_check', 'at_tech', 'tech_done'], tone: 'rose' },
  ];
  const LEVEL = { high: ['Cần xử lý ngay', 'lost'], mid: ['Cần theo dõi', 'wait'], low: ['Bổ sung dữ liệu', 'off'] };
  const TEAM_TONE = { tech: 'blue', logistics: 'violet', sale: 'go' };

  ARL.hub.view('overview', {
    mount(el, ctx) {
      const st = { period: ctx.query.period === 'month' ? 'month' : 'week', key: ctx.query.key || null, watchAll: false };
      const canOpen = (v) => D.canOpen(ctx, v);
      const ownTeam = (team) => ctx.role === 'admin' || ctx.team === team;
      const teamName = (t) => (ctx.meta.teams && ctx.meta.teams[t]) || t;
      const navBox = h('div');
      const head = H.head('Tổng quan vận hành', ' ', navBox);
      const sub = head.querySelector('.sub');
      const body = h('div.ov.dash-v');
      el.append(head, body);

      const load = H.async(body, async () => {
        const d = await ctx.api('GET', '/api/hub/overview', null, D.q({ period: st.period, key: st.key }));
        if (!ctx.alive()) return undefined;
        st.period = d.period; st.key = d.key;
        H.clear(navBox, D.periodNav(d, (p, k) => { st.period = p; st.key = k; ctx.setQuery({ period: p === 'week' ? null : p, key: k }); load(); }));
        const note = D.cmpNote(d);
        sub.textContent = `Toàn khối vận hành · ${d.label} (${D.range(d.from, d.to)}) so với ${d.prev_label}${note ? ` · ${note}` : ''} · cập nhật ${H.time(ARL.now())}`;
        return render(d);
      });
      const soon = D.throttle(ctx, load, 10000);
      ctx.live(['overview', 'jobs', 'incidents', 'kits', 'recon', 'records', 'outlets', 'requests', 'perf', 'roster', 'people'], soon);
      ctx.every(90000, soon); // số người trong ca, việc quá hạn thay đổi theo giờ

      function render(d) {
        const word = D.prevWord(d);
        const k = d.kpi, tr = d.trend || [];
        const labels = tr.map((x) => x.label);
        const out = [];

        // ───── Ô số liệu ─────
        const sla = (team, name, tone, key) => {
          const c = k.sla[team].cur, p = k.sla[team].prev;
          return D.kpi({
            label: `Đúng hạn ${name}`, value: c.pct === null ? '–' : H.pct(c.pct, 0, true),
            deltas: c.pct === null ? [] : [H.delta(c.pct, p.pct, { label: word, abs: true, unit: ' điểm %', d: 1 })],
            hint: c.n ? `${H.num(c.ok)}/${H.num(c.n)} việc có hạn của thành viên team xong đúng hạn` : 'Chưa có việc có hạn hoàn thành trong kỳ',
            spark: tr.map((x) => x[key]), sparkTone: tone, sparkLabels: labels, sparkFormat: (v) => H.pct(v, 0, true),
          });
        };
        const queue = (team, name) => {
          const x = k.queue[team];
          const click = canOpen('jobs') && ownTeam(team);
          return D.kpi({
            label: `Việc ${name} đang mở`, value: x.open, tone: x.overdue ? 'lost' : x.blocked ? 'wait' : null,
            hint: `${H.num(x.overdue)} quá hạn · ${H.num(x.blocked)} đang vướng · ${H.num(x.pool)} chưa ai nhận`,
            onClick: click ? () => ctx.go('jobs', [], D.q({ team: ctx.role === 'admin' ? team : null })) : null,
            title: click ? 'Mở bảng việc' : null,
          });
        };
        const sh = k.shift;
        out.push(
          h('h2.ov-kpi-h', 'Kết quả ghi hình'),
          H.kpis(
            D.kpi({ label: 'BO đang ghi hình', value: k.bo_live, tone: 'go', hint: `${H.num(k.bo_planned)} chờ launch · ${H.num(k.bo_ending)} đang thu hồi`, onClick: canOpen('outlets') ? () => ctx.go('outlets', [], { st: 'live' }) : null }),
            D.kpi({ label: 'Giờ ghi hình', value: H.num(k.hours.cur, 1), unit: 'giờ', deltas: [D.dataDelta(d, k.hours, { label: word })], hint: `${H.num(k.tb.cur, 1)} TB dữ liệu thô, theo ngày quay${k.hours_nosite && k.hours_nosite.cards ? ` · chưa tính ${H.num(k.hours_nosite.hours, 1)} giờ của ${H.num(k.hours_nosite.cards)} thẻ chưa rõ BO (chờ Tech đối chiếu)` : ''}${k.hours_offbo && k.hours_offbo.cards ? ` · không tính ${H.num(k.hours_offbo.hours, 1)} giờ của ${H.num(k.hours_offbo.cards)} thẻ thuộc BO đã ngừng hoạt động` : ''}`, spark: tr.map((x) => x.hours), sparkLabels: labels, sparkFormat: (v) => H.hours(v) }),
            D.kpi({ label: 'Thẻ đã nhập dung lượng', value: k.cards.cur, deltas: [D.dataDelta(d, k.cards, { label: word })], hint: `${H.num(k.under1h.cur)} thẻ dưới 1 giờ`, spark: tr.map((x) => x.cards), sparkLabels: labels, sparkTone: 'teal' }),
            D.kpi({ label: 'Thẻ 0 giờ', value: k.zero.cur, tone: k.zero.cur ? 'wait' : null, deltas: [D.dataDelta(d, k.zero, { label: word, up: 'bad', abs: true })], hint: 'Thẻ về mà không có dữ liệu ghi hình', spark: tr.map((x) => x.zero), sparkLabels: labels, sparkTone: 'wait' }),
            D.kpi({ label: 'Sự cố mới', value: k.incidents.cur, tone: k.incidents.open ? 'lost' : null, deltas: [H.delta(k.incidents.cur, k.incidents.prev, { label: word, up: 'bad' })], hint: `${H.num(k.incidents.open)} đang mở${k.incidents.avg_ack_min !== null ? ` · Tech nhận sau ${H.dur(k.incidents.avg_ack_min)}` : ''}`, spark: tr.map((x) => x.incidents), sparkLabels: labels, sparkTone: 'violet', onClick: () => ctx.go('incidents', [], { status: 'open' }) })),
          h('h2.ov-kpi-h', 'Vận hành đội'),
          H.kpis(
            sla('tech', 'Tech', 'blue', 'tech_sla'),
            sla('logistics', 'Logistics', 'rose', 'log_sla'),
            queue('tech', 'Tech'),
            queue('logistics', 'Logistics'),
            D.kpi({ label: 'Đang trong ca (lúc này)', value: sh.tech.on + sh.logistics.on, unit: `/ ${H.num(sh.tech.total + sh.logistics.total)} người`, hint: `Tech ${sh.tech.on}/${sh.tech.total} · Logistics ${sh.logistics.on}/${sh.logistics.total}`, tone: sh.tech.on && sh.logistics.on ? 'blue' : 'wait' })));

        // ───── Điểm nghẽn + đội kit ─────
        out.push(h('div.dash-grid-3.dash-sec-gap', jamCard(d), kitCard(k.kits)));

        // ───── Xu hướng 12 tuần ─────
        if (tr.length) {
          const endL = labels[labels.length - 1];
          const subT = `12 tuần gần nhất, đến ${endL}`;
          const running = tr[tr.length - 1].key === D.weekKey(H.today()) ? 'Tuần đang chạy, số còn tăng' : false;
          const runNote = (i) => (running && i === tr.length - 1 ? running : null);
          const slaVals = tr.flatMap((x) => [x.tech_sla, x.log_sla]).filter((v) => v !== null && v !== undefined);
          const slaMin = slaVals.length ? Math.max(0, Math.floor((Math.min(...slaVals) - 5) / 10) * 10) : 0;
          out.push(H.sec('Xu hướng', subT), H.grid(2,
            H.card('Giờ ghi hình theo tuần', C.line({ title: 'Giờ ghi hình theo tuần', labels, series: [{ name: 'Giờ ghi hình', data: tr.map((x) => x.hours), tone: 'blue', area: true }], format: (v) => H.hours(v), height: 210, partial: running }), { sub: 'Giờ thô Tech nhập từ thẻ, tính theo ngày quay' }),
            H.card('Sự cố theo tuần', C.bar({ title: 'Sự cố theo tuần', labels, series: [{ name: 'Sự cố', data: tr.map((x) => x.incidents), tone: 'violet' }], height: 210, format: (v) => `${H.num(v)} sự cố`, note: runNote }), { sub: 'Sự cố báo tại BO (không tính đã huỷ)' }),
            H.card('Đúng hạn theo team', C.line({ title: 'Tỉ lệ đúng hạn theo team', labels, series: [{ name: 'Tech', data: tr.map((x) => x.tech_sla), tone: 'blue' }, { name: 'Logistics', data: tr.map((x) => x.log_sla), tone: 'rose' }], yMin: slaMin, yMax: 100, format: (v) => H.pct(v, 1, true), yFormat: (v) => `${H.num(v)}%`, height: 210 }), { sub: 'Việc có hạn, xong trong tuần' }),
            H.card('Khối lượng công việc', C.line({ title: 'Điểm khối lượng theo team', labels, series: [{ name: 'Tech', data: tr.map((x) => x.tech_points), tone: 'blue' }, { name: 'Logistics', data: tr.map((x) => x.log_points), tone: 'rose' }], format: (v) => `${H.num(v, 1)} điểm`, height: 210, partial: running }), { sub: 'Điểm = phút chuẩn ÷ 6, cả team (không có tên người)' })));
        }

        // ───── Sự cố ─────
        out.push(H.sec('Sự cố thiết bị', `${d.label} so với ${d.prev_label}`, h('a.btn.small', { href: D.href('incidents', [], { status: 'open' }) }, 'Mở danh sách sự cố')));
        out.push(h('div.dash-grid-3', incTopCard(d, word), h('div.h-stack', { style: { gap: 'var(--h-gap)', alignContent: 'start' } }, incSitesCard(d), officeCard(d))));

        // ───── Top 3 (chỉ khi máy chủ trả về) ─────
        const teams = Object.keys(d.top3 || {});
        if (teams.length) {
          out.push(H.sec('Top 3 nhân sự', `${d.label} · chỉ Lead của team và Quản trị xem được`));
          const cards = [];
          for (const t of teams) {
            const x = d.top3[t];
            cards.push(H.card(`Top 3 ${teamName(t)}`, h('div.ov-team',
              D.podium(x.list, x.rate_off ? { empty: 'Logistics chưa bật xếp loại (Cài đặt).' } : {}),
              h('div.ov-team-sum',
                h('span', 'Cả team ', h('b', `${H.num(x.summary.points, 1)} điểm`)),
                x.summary.wow_pct !== null && x.summary.wow_pct !== undefined ? D.deltaPct(x.summary.wow_pct, { label: word }) : null,
                x.summary.sla_pct !== null ? h('span', 'Đúng hạn ', h('b', H.pct(x.summary.sla_pct, 0, true))) : null,
                x.summary.ppd !== null ? h('span', 'Điểm/công ', h('b', H.num(x.summary.ppd, 1))) : null),
              canOpen('perf') ? h('div.dash-foot', h('span', 'Điểm tổng hợp theo trọng số trong Cài đặt'), h('a', { href: D.href('perf', [], D.q({ team: ctx.role === 'admin' ? t : null, period: d.period === 'month' ? 'month' : null, key: d.key })) }, 'Xem đánh giá đầy đủ ›')) : null), { sub: x.label }));
            if (x.fo) cards.push(H.card('Top 3 Field Ops', h('div.ov-team', D.podium(x.fo.list, x.fo.rate_off ? { empty: 'Logistics chưa bật xếp loại (Cài đặt) nên Field Ops cũng chưa xếp loại.' } : {}), x.fo.summary ? h('div.ov-team-sum', h('span', 'Cả đội FO ', h('b', `${H.num(x.fo.summary.points, 1)} điểm`)), x.fo.summary.sla_pct !== null ? h('span', 'Chuyến đúng hạn ', h('b', H.pct(x.fo.summary.sla_pct, 0, true))) : null, h('span', 'Điểm giao nhận ', h('b', H.num(x.fo.summary.stops_done)))) : null), { sub: `${x.label} · thuộc Logistics` }));
          }
          out.push(H.grid(Math.min(3, cards.length), ...cards));
        }

        // ───── Kinh doanh (Quản trị, Head of Sale) ─────
        if (d.sale) out.push(saleSection(d, word));
        return out.flat(Infinity);
      }

      // Điểm nghẽn: số việc kẹt của từng team + danh sách cần xử lý ngay (máy chủ đã lọc theo vai trò).
      function jamCard(d) {
        const k = d.kpi, q = k.queue;
        // Khoá lọc đúng như màn hình Bảng việc đọc (giống trang Việc của tôi): quá hạn od=1, chưa ai nhận who=pool, đang vướng xem dạng bảng cột.
        const JOB_FILTER = { overdue: { scope: 'team', od: '1' }, pool: { scope: 'team', who: 'pool' }, blocked: { scope: 'team', v: 'board' } };
        const jobsLink = (team, filter) => (canOpen('jobs') && (!team || ownTeam(team)) ? D.href('jobs', [], D.q({ team: ctx.role === 'admin' ? team : null, ...JOB_FILTER[filter] })) : null);
        const myTeam = ctx.role === 'admin' ? null : ['tech', 'logistics'].includes(ctx.team) ? ctx.team : null;
        const tile = (label, n, small, tone, href) => {
          const kids = [h('span', label), h('b', H.num(n)), small ? h('small', small) : null];
          return href ? h('a', { href, 'data-tone': n ? tone : 'go' }, kids) : h('div', { 'data-tone': n ? tone : 'go' }, kids);
        };
        const split = (key) => `Tech ${H.num(q.tech[key])} · Logistics ${H.num(q.logistics[key])}`;
        const req = k.requests || {}, cards = k.card_st || {};
        const tiles = [
          tile('Việc quá hạn', q.tech.overdue + q.logistics.overdue, split('overdue'), 'lost', jobsLink(myTeam, 'overdue')),
          tile('Việc đang vướng', q.tech.blocked + q.logistics.blocked, split('blocked'), 'wait', jobsLink(myTeam, 'blocked')),
          tile('Việc chưa ai nhận', q.tech.pool + q.logistics.pool, split('pool'), 'wait', jobsLink(myTeam, 'pool')),
          tile('Đối chiếu đang mở', k.recon.open, `${H.num(k.recon.high)} mức cao`, k.recon.high ? 'lost' : 'wait', canOpen('recon') ? D.href('recon') : null),
          tile('Kit đang ở Tech', k.kits.at_tech, `${H.num((k.kits.by_status || {}).wait_check || 0)} kit chờ kiểm`, 'wait', canOpen('kits') ? D.href('kits', [], { st: 'at_tech' }) : null),
          tile('Yêu cầu chờ chuẩn bị', (req.submitted || 0) + (req.preparing || 0), `${H.num((req.ready || 0) + (req.delivering || 0))} đã sẵn sàng / đang giao`, 'wait', canOpen('requests') ? D.href('requests', [], { st: 'waiting' }) : null),
          tile('Thẻ chờ xử lý', (cards.returned || 0) + (cards.at_tech || 0), `${H.num(cards.returned || 0)} chờ gửi Tech · ${H.num(cards.at_tech || 0)} chờ nhập`, 'wait', canOpen('cards') ? D.href('cards') : null),
        ];
        const list = d.watch || [];
        const ul = h('ul.ov-watch');
        const paint = () => {
          const shown = st.watchAll ? list : list.slice(0, 8);
          H.clear(ul, shown.map((w) => {
            // Việc của team khác vẫn hiện để Lead nắm tình hình, nhưng máy chủ chặn chi tiết việc ngoài team → không gắn nút Mở (Quản trị mở được mọi việc).
            const otherTeam = w.link && w.link.startsWith('job:') && ctx.role !== 'admin' && w.team && w.team !== ctx.team;
            const to = otherTeam ? null : watchLink(w.link);
            return h('li', { 'data-level': w.level },
              h('i', { title: (LEVEL[w.level] || LEVEL.low)[0], 'aria-label': (LEVEL[w.level] || LEVEL.low)[0] }),
              h('span.ov-w-t', w.text),
              h('span.ov-w-r', w.team ? H.pill(teamName(w.team), TEAM_TONE[w.team] || 'off') : null, to ? h('a.btn', { href: to }, 'Mở') : null));
          }));
        };
        paint();
        const more = list.length > 8 ? H.btn(st.watchAll ? 'Thu gọn' : `Xem tất cả ${list.length} mục`, (e, b) => { st.watchAll = !st.watchAll; paint(); b.textContent = st.watchAll ? 'Thu gọn' : `Xem tất cả ${list.length} mục`; }, 'ghost small dash-more') : null;
        const high = list.filter((w) => w.level === 'high').length;
        return H.card('Điểm nghẽn', [
          h('div.ov-jam', tiles),
          list.length ? [ul, more] : H.note('Không có mục nào cần xử lý ngay. Danh sách tự cập nhật khi có việc quá hạn, sự cố chưa ai nhận, kit lỗi tại BO…', 'go'),
        ], { sub: list.length ? `${H.num(list.length)} mục cần theo dõi${high ? `, ${H.num(high)} cần xử lý ngay` : ''} · sắp theo mức độ` : 'Những thứ đang làm chậm vận hành', tone: high ? 'lost' : null });
      }
      // "cards:at_bo" và các đường dẫn khác: bộ giải chung của Ops Hub (mở danh sách thẻ lọc theo ?st=, đúng khoá màn hình đọc).
      const watchLink = (link) => (link ? ctx.linkTo(link) : null);

      function kitCard(kits) {
        const bs = kits.by_status || {};
        const items = KIT_GROUPS.map((g) => ({ label: g.label || H.label('kit_st', g.st[0]), value: g.st.reduce((a, s) => a + (bs[s] || 0), 0), tone: g.tone }));
        const kinds = Object.entries(kits.by_kind || {}).filter(([, v]) => v.total);
        return H.card('Đội kit', [
          C.donut({ title: 'Kit theo trạng thái', items, center: { value: H.num(kits.total), label: 'kit đang dùng' }, size: 168 }),
          kinds.length ? h('div.ov-kind', kinds.map(([kind, v]) => h('div.ov-kind-r',
            h('div', h('b', H.label('kit_kinds', kind)), h('span', `${H.num(v.deployed)} ngoài BO / ${H.num(v.total)} kit`)),
            h('div.ov-stack.dash-tone', { role: 'img', 'aria-label': `${H.label('kit_kinds', kind)}: ${v.deployed} ngoài BO trên ${v.total}` },
              h('i', { 'data-tone': 'violet', style: { width: `${(v.deployed / v.total) * 100}%` } }))))) : null,
          canOpen('kits') ? h('div.dash-foot', h('span', `${H.num(kits.ready)} kit sẵn sàng xuất`), h('a', { href: D.href('kits') }, 'Mở Kit & thiết bị ›')) : null,
        ], { sub: 'Không tính kit ngừng dùng' });
      }

      // Link sang danh sách sự cố đúng tập đã đếm: cùng kỳ, trừ "Không phải sự cố" và đã huỷ (máy chủ lọc theo status=counted).
      function incHref(d, q) { return canOpen('incidents') ? D.href('incidents', [], { status: 'counted', from: d.from, to: d.to, ...q }) : null; }
      function incTopCard(d, word) {
        const list = d.incidents_top || [];
        const spikes = (d.incidents_spikes || []).length;
        const kindName = (k) => (k ? H.label('kit_kinds', k) : 'Chưa rõ kit');
        const kindTone = (k) => (k === 'iphone' ? 'blue' : k ? 'violet' : 'off');
        // Một dòng cho mỗi lỗi; nhiều dòng kit thì chia nhỏ ngay trong dòng.
        const kindPill = (x) => {
          const ks = x.kinds || [];
          if (ks.length > 1) return ks.map((k) => H.pill(`${kindName(k.kind)} ${H.num(k.count)}`, kindTone(k.kind)));
          return ks.length ? H.pill(kindName(ks[0].kind), kindTone(ks[0].kind)) : (x.kind ? H.pill(kindName(x.kind), kindTone(x.kind)) : null);
        };
        const inv = d.kpi.incidents.invalid || 0;
        return H.card('Top 10 lỗi thiết bị', [
          spikes ? H.note(`${H.num(spikes)} lỗi tăng vọt trong tuần: đạt số lần tối thiểu và gấp đôi trung bình 4 tuần trước (ngưỡng đề xuất, Tech chốt trong Cài đặt).`, 'lost') : null,
          D.rank(list.map((x) => ({
            label: x.label, value: x.count, text: H.num(x.count), tone: x.spike ? 'lost' : 'violet',
            flag: [kindPill(x), x.spike ? H.pill('Tăng vọt', 'lost') : null],
            sub: [x.sites ? `${H.num(x.sites)} BO` : '', x.swap_rate !== null && x.swap_rate !== undefined ? `đổi máy ${H.num(x.swap_rate)}%` : '', x.avg4 !== null && x.avg4 !== undefined ? `TB 4 tuần ${H.num(x.avg4, 1)}` : ''].filter(Boolean).join(' · '),
            right: D.arrow(x.count, x.prev, { up: 'bad', label: `${word[0].toUpperCase()}${word.slice(1)}` }),
            href: incHref(d, { label: x.label, kind: x.kind }),
          })), { empty: `Không có sự cố nào trong ${d.label} và ${d.prev_label}.` }),
          d.kpi.incidents.avg_resolve_min !== null ? h('div.dash-foot', h('span', `Thời gian xử lý trung bình ${H.dur(d.kpi.incidents.avg_resolve_min)}`), h('span', `Mũi tên: thay đổi so ${word}`)) : null,
        ], { sub: `${H.num(d.kpi.incidents.cur)} lần báo trong ${d.label}, ${H.num(d.kpi.incidents.prev)} trong ${d.prev_label}${inv ? ` · ${H.num(inv)} lần "Không phải sự cố" không vào Top 10` : ''}` });
      }
      function incSitesCard(d) {
        const list = d.incident_sites || [];
        return H.card('BO có nhiều sự cố', D.rank(list.map((x) => ({ label: x.site.name, value: x.count, text: H.num(x.count), tone: 'violet', href: incHref(d, { site: x.site.id }) })), { empty: 'Chưa có BO nào báo sự cố trong kỳ.' }), { sub: `Top 5 trong ${d.label}, không tính "Không phải sự cố"` });
      }
      function officeCard(d) {
        const of = Object.entries(d.office_faults || {});
        return H.card('Lỗi phát hiện ở văn phòng', of.length
          ? [h('div.ov-office', of.map(([kind, n]) => h('span.pill', { 'data-tone': 'wait' }, `${H.label('kit_kinds', kind)}: ${H.num(n)}`))), D.src('Kiểm kit trước khi xuất hoặc check-in kit thu hồi không đạt.')]
          : H.empty('Không có kit nào kiểm không đạt trong kỳ.'), { sub: d.label });
      }

      function saleSection(d, word) {
        const s = d.sale, t = s.totals;
        const bySale = (s.by_sale || []).filter((x) => x.bo);
        const outRow = (x) => ({ label: x.name, value: x.hours, text: H.hours(x.hours), sub: x.sale ? x.sale.name : '', tone: 'blue', right: D.arrow(x.cmp_hours, x.prev_hours, { label: `${word[0].toUpperCase()}${word.slice(1)}`, d: 1, unit: ' giờ' }), href: canOpen('outlets') ? D.href('outlets', [x.id]) : null });
        return [
          H.sec('Kinh doanh', `${d.label} · giờ ghi hình theo BO và Sale Lead`, canOpen('sale') ? h('a.btn.small', { href: D.href('sale', [], D.q({ period: d.period === 'month' ? 'month' : null, key: d.key })) }, 'Mở Dashboard Kinh doanh') : null),
          h('div.dash-mini', { style: { marginBottom: 'var(--h-gap)' } },
            h('div', h('span', 'BO đang ghi hình'), h('b', H.num(t.live), h('small', `/ ${H.num(t.bo)} BO`))),
            h('div', h('span', 'Giờ ghi hình'), h('b', H.num(t.hours, 1), h('small', 'giờ')), D.dataDelta(d, { cur: t.hours, cmp: t.cmp_hours, prev: t.prev_hours }, { label: word })),
            h('div', h('span', 'Kit đang ở BO'), h('b', H.num(t.kits))),
            h('div', h('span', 'Thẻ 0 giờ'), h('b', H.num(t.zero))),
            h('div', h('span', 'Sự cố tại BO'), h('b', H.num(t.incidents)))),
          H.grid(3,
            H.card('Giờ ghi hình theo Sale Lead', bySale.length ? C.bar({ title: 'Giờ ghi hình theo Sale Lead', horizontal: true, labels: bySale.map((x) => x.sale.name), series: [{ name: 'Giờ ghi hình', data: bySale.map((x) => x.hours), tone: 'blue' }], format: (v) => H.hours(v), note: (i) => `${H.num(bySale[i].live)}/${H.num(bySale[i].bo)} BO đang ghi hình` }) : H.empty('Chưa có BO nào.'), { sub: d.label }),
            H.card('BO nhiều giờ nhất', D.rank((s.top || []).map(outRow), { empty: 'Chưa có giờ ghi hình trong kỳ.' }), { sub: 'Top 5' }),
            H.card('BO ít giờ nhất', D.rank((s.bottom || []).map((x) => ({ ...outRow(x), tone: 'wait' })), { empty: 'Chưa có BO đang ghi hình.', max: Math.max(1, ...(s.top || []).map((x) => x.hours)) }), { sub: 'BO đang ghi hình, ít giờ nhất' })),
        ];
      }
    },
  });
})();
