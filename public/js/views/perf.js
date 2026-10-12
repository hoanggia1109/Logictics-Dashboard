/* Ops Hub — Đánh giá nhân sự (Lead của team, Quản trị) và Hiệu suất của tôi (từng thành viên Tech / Logistics).
   Điểm, trọng số, xếp loại do máy chủ tính (GET /api/hub/perf, /perf/me); trang chỉ trình bày và so sánh.
   Đánh giá từng người chỉ Lead của team đó và Quản trị xem; "Hiệu suất của tôi" chỉ có số của chính mình và trung bình team. */
(() => {
  'use strict';
  const H = ARL.H, { h } = H, C = ARL.chart, D = ARL.dash;

  const RATE_TONE = { 5: 'go', 4: 'blue', 3: 'off', 2: 'wait', 1: 'lost' };
  const stars = (n) => '★'.repeat(n) + '☆'.repeat(Math.max(0, 5 - n));
  const rateCell = (r) => (r.rated && r.rating
    ? h('span.perf-rate', { title: `${r.rating_label} · ${H.num(r.score, 1)} điểm tổng hợp` }, h('span.stars', { 'aria-hidden': 'true' }, stars(r.rating)), H.pill(r.rating_label, RATE_TONE[r.rating] || 'off'))
    : h('span.h-muted', r.not_rated_reason || 'Chưa xếp loại'));
  const cap = (w) => w[0].toUpperCase() + w.slice(1);
  const dd = (date) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
  const isNum = (v) => v !== null && v !== undefined && !Number.isNaN(+v);
  const PARTS = [
    ['vol', 'Khối lượng', 's_vol', 'Điểm/công so với TB team (bằng TB = 80; cả team 0 điểm thì 0)'],
    ['sla', 'Đúng hạn', 's_sla', '% việc có hạn xong đúng hạn; người nhận lại việc được tính hạn từ lúc nhận'],
    ['quality', 'Chất lượng', 's_quality', '% thẻ đã nhập không bị người khác sửa lại'],
    ['att', 'Chuyên cần', 's_att', 'Đi đủ ca đã xếp, trừ ngày nghỉ phép (trễ tính nửa; làm ngoài ca không bù ca vắng)'],
  ];

  /** Bảng các thành phần điểm của một người: thanh 0–100 cho từng phần, kèm trọng số. */
  function parts(r, weights, fo) {
    return h('div.me-vs', PARTS.filter(([k]) => (weights || {})[k] && !(fo && k === 'att')).map(([k, label, key, hint]) => h('div.me-vs-r',
      h('div', h('b', `${label} · trọng số ${H.num(weights[k])}%`), h('span', isNum(r[key]) ? `${H.num(r[key], 1)} / 100` : 'chưa có số')),
      H.bar(isNum(r[key]) ? r[key] / 100 : 0, isNum(r[key]) && r[key] < 50 ? 'wait' : null),
      h('small.h-muted', hint))));
  }

  // ═════════════ Đánh giá nhân sự (Lead, Quản trị) ═════════════
  ARL.hub.view('perf', {
    mount(el, ctx) {
      const isAdmin = ctx.role === 'admin';
      const st = {
        team: isAdmin ? (ctx.query.team === 'logistics' ? 'logistics' : 'tech') : ctx.team,
        period: ctx.query.period === 'month' ? 'month' : 'week', key: ctx.query.key || null, snap: false, // snap: đang xem bản đã chốt trước lần mở lại gần nhất
      };
      const teamName = (t) => (ctx.meta.teams && ctx.meta.teams[t]) || (t === 'tech' ? 'Tech' : 'Logistics');
      const teamBox = h('div'), navBox = h('div'), csvBox = h('div');
      const head = H.head('Đánh giá nhân sự', ' ', isAdmin ? teamBox : null, navBox, csvBox);
      const sub = head.querySelector('.sub');
      const body = h('div.perf-v.dash-v');
      el.append(head, body);
      if (isAdmin) teamBox.append(H.seg([['tech', 'Tech'], ['logistics', 'Logistics']], st.team, (t) => { st.team = t; st.snap = false; ctx.setQuery({ team: t === 'tech' ? null : t }); load(); }));

      let last = null, dlg = null;
      const load = H.async(body, async () => {
        const d = await ctx.api('GET', '/api/hub/perf', null, D.q({ team: isAdmin ? st.team : null, period: st.period, key: st.key, snapshot: st.snap ? 1 : null }));
        if (!ctx.alive()) return undefined;
        last = d; st.period = d.period; st.key = d.key; st.team = d.team;
        H.clear(navBox, D.periodNav(d, (p, k) => { st.period = p; st.key = k; st.snap = false; ctx.setQuery({ period: p === 'week' ? null : p, key: k }); load(); }));
        H.clear(csvBox, H.csv('/api/hub/perf.csv', D.q({ team: isAdmin ? d.team : null, period: d.period, key: d.key }), 'Tải CSV'));
        const note = D.cmpNote(d, { data: false });
        sub.textContent = `Team ${teamName(d.team)} · ${d.label} (${D.range(d.from, d.to)}) so với ${d.prev_label}${note ? ` · ${note}` : ''}${d.locked ? ' · đã chốt' : ''}`;
        const out = render(d);
        setTimeout(openFromRoute, 0);
        return out;
      });
      const soon = D.throttle(ctx, load, 8000);
      ctx.live(['perf', 'jobs', 'roster', 'people', 'records', 'config'], soon);
      // #/perf/<id người>: mở bảng chi tiết của người đó (link từ nơi khác, nút quay lại của trình duyệt).
      ctx.onRoute(() => {
        // Đổi kỳ / team qua địa chỉ (link từ màn hình khác, nút quay lại): nạp lại; chỉ đổi phần chi tiết thì mở / đóng hộp thoại.
        const q = ctx.query, team = isAdmin ? (q.team === 'logistics' ? 'logistics' : 'tech') : st.team, period = q.period === 'month' ? 'month' : 'week';
        const want = q.key || (period === 'month' ? H.today().slice(0, 7) : D.weekKey(H.today()));
        if (team !== st.team || period !== st.period || want !== st.key) {
          st.team = team; st.period = period; st.key = q.key || null; st.snap = false;
          if (isAdmin) teamBox.firstChild.set(team);
          load();
          return;
        }
        openFromRoute();
      });
      ctx.onCleanup(() => { if (dlg) dlg.close(); });

      function openFromRoute() {
        const id = Number(ctx.params[0]);
        if (!id) { if (dlg) { const x = dlg; dlg = null; x.close(); } return; }
        if (!last) return;
        const r = last.rows.find((x) => x.user.id === id) || (last.fo ? last.fo.rows.find((x) => x.user.id === id) : null);
        if (r) showPerson(last, r, !!(last.fo && last.fo.rows.includes(r)));
      }

      function render(d) {
        const s = d.summary, word = D.prevWord(d), isLog = d.team === 'logistics';
        const out = [lockBar(d)];
        const p = s.prev || {};
        const peers = d.rows.filter((r) => !['tech_lead', 'lead', 'admin'].includes(r.user.role));
        const rated = peers.filter((r) => r.rated).length;
        out.push(H.kpis(
          D.kpi({ label: 'Điểm khối lượng cả team', value: H.num(s.points, 1), unit: 'điểm', deltas: [D.deltaPct(s.wow_pct, { label: word }), d.period === 'week' && s.avg4 && s.avg4.points ? D.deltaPct(s.vs_avg4_pct, { label: 'TB 4 tuần' }) : null].filter(Boolean), hint: `${H.num(s.jobs)} việc${isLog ? '' : ` · ${H.num(s.uploads)} thẻ đã nhập`} · điểm = phút chuẩn ÷ 6${s.other_points ? ` · ngoài ra ${H.num(s.other_points, 1)} điểm việc người ngoài team (như Quản trị) làm giúp, tính riêng` : ''}` }),
          D.kpi({ label: 'Đúng hạn', value: s.sla_pct === null ? '–' : H.pct(s.sla_pct, 0, true), tone: s.sla_pct === null ? null : s.sla_pct >= 90 ? 'go' : s.sla_pct >= 75 ? 'wait' : 'lost', deltas: s.sla_pct === null ? [] : [H.delta(s.sla_pct, p.sla_pct, { label: word, abs: true, unit: ' điểm %', d: 1 })], hint: s.with_due ? `${H.num(s.on_time)}/${H.num(s.with_due)} việc có hạn xong đúng hạn` : 'Chưa có việc có hạn hoàn thành' }),
          D.kpi({ label: 'Điểm / công', value: s.ppd === null ? '–' : H.num(s.ppd, 1), deltas: s.ppd === null ? [] : [H.delta(s.ppd, p.ppd, { label: word, d: 1 })], hint: `${H.num(s.workdays)} công cả team · TB mỗi người ${H.num(d.team_avg_ppd, 1)}` }),
          isLog
            ? D.kpi({ label: 'Việc FO làm qua chuyến', value: H.num(s.fo_points, 1), unit: 'điểm', hint: 'Tính riêng ở phần Field Ops bên dưới' })
            : D.kpi({ label: 'Thẻ đã nhập', value: s.uploads, deltas: [H.delta(s.uploads, p.uploads, { label: word })], hint: `${H.num(s.gb, 1)} GB · ${H.num(s.hours, 1)} giờ ghi hình` }),
          D.kpi({ label: 'Đã xếp loại', value: rated, unit: `/ ${H.num(peers.length)} người`, hint: d.rate_off ? 'Logistics chưa bật xếp loại (Cài đặt)' : `Cần từ ${H.num(d.min_days)} công trong kỳ; Lead không xếp loại` })));

        // Xu hướng + cơ cấu việc
        out.push(h('div.dash-grid-3.dash-sec-gap', trendCard(d), typeCard(d)));
        out.push(H.grid(3,
          H.card(`Top 3 ${teamName(d.team)}`, D.podium(d.top3, { empty: d.rate_off ? 'Logistics chưa bật xếp loại (Cài đặt).' : `Chưa ai đủ ${d.min_days} công và có khối lượng để xếp loại trong kỳ này.` }), { sub: `${d.label} · điểm tổng hợp, rồi đúng hạn, rồi khối lượng` }),
          shareCard(d), dailyCard(d)));

        // Bảng từng người + cách tính
        out.push(h('div.dash-sec-gap', peopleCard(d, word)));
        if (d.fo) out.push(foSection(d, word));
        out.push(h('div.dash-sec-gap', howCard(d)));
        return out.flat(Infinity);
      }

      function lockBar(d) {
        const word = d.period === 'month' ? 'tháng' : 'tuần';
        if (d.snapshot) {
          return h('div.h-note.perf-lock', { 'data-tone': 'wait' },
            h('span', `Đang xem bản số liệu ${d.label} lúc chốt (${H.when(d.locked.at)}, ${d.locked.by}), trước khi ${d.snapshot.by} mở lại kỳ lúc ${H.when(d.snapshot.at)}: ${d.snapshot.reason}.`),
            H.btn('Về số liệu hiện tại', () => { st.snap = false; load(); }, 'ghost small'));
        }
        const bar = mainBar(d, word);
        if (d.locked || !d.reopened) return bar;
        return [h('div.h-note.perf-lock', { 'data-tone': 'wait' },
          h('span', `${cap(word)} này đã chốt rồi được ${d.reopened.by} mở lại lúc ${H.when(d.reopened.at)}: ${d.reopened.reason}. Số dưới đây tính lại theo dữ liệu hiện tại.`),
          H.btn('Xem bản đã chốt', () => { st.snap = true; load(); }, 'ghost small')), bar];
      }
      function mainBar(d, word) {
        if (d.locked) {
          return h('div.h-note.perf-lock', { 'data-tone': 'go' },
            h('span', `Đã chốt số liệu ${d.label} lúc ${H.when(d.locked.at)} (${d.locked.by}). Bảng điểm kỳ này được giữ nguyên: sửa việc hay chấm công sau này không làm đổi số đã chốt.`),
            isAdmin ? H.btn('Mở lại kỳ', () => unlock(d), 'ghost small') : null);
        }
        if (d.to >= H.today()) return h('div.h-note.perf-lock', h('span', `${cap(word)} đang chạy nên số còn thay đổi. Chốt được sau khi ${word} kết thúc (sau ${H.dmy(d.to)}).`));
        return h('div.h-note.perf-lock', { 'data-tone': 'wait' },
          h('span', `${d.label} đã kết thúc nhưng chưa chốt. Chốt để giữ nguyên số liệu: sau khi chốt, sửa việc hay chấm công của kỳ này không làm đổi bảng điểm${isAdmin ? '' : ' (chỉ Quản trị mở lại được)'}.`),
          H.btn('Chốt số liệu kỳ này', () => lock(d), 'primary small'));
      }
      async function lock(d) {
        const ok = await H.confirm(`Chốt số liệu ${teamName(d.team)} ${d.label}? Bảng điểm sẽ được giữ nguyên như hiện tại; sửa việc hay chấm công của kỳ này sau đó không làm đổi số đã chốt.${isAdmin ? '' : ' Chỉ Quản trị mở lại được.'}`, 'Chốt số liệu');
        if (!ok) return;
        await ctx.api('POST', '/api/hub/perf/lock', { team: d.team, period: d.period, key: d.key });
        ARL.toast(`Đã chốt số liệu ${d.label}.`);
        load();
      }
      async function unlock(d) {
        const reason = await H.reason(`Mở lại ${d.label}`, { intro: 'Bảng điểm sẽ tính lại theo dữ liệu hiện tại; bản đã chốt được giữ lại để Lead của team xem lại. Lý do được ghi vào nhật ký thao tác.', label: 'Lý do mở lại', submit: 'Mở lại kỳ', danger: true });
        if (!reason) return;
        await ctx.api('POST', '/api/hub/perf/unlock', { team: d.team, period: d.period, key: d.key, reason });
        ARL.toast(`Đã mở lại ${d.label}.`);
        load();
      }

      function trendCard(d) {
        const box = h('div');
        const endKey = d.period === 'week' ? d.key : D.weekKey(d.to < H.today() ? d.to : H.today());
        H.async(box, async () => {
          const t = await ctx.api('GET', '/api/hub/perf/trend', null, D.q({ team: isAdmin ? d.team : null, weeks: 12, key: endKey }));
          if (!ctx.alive()) return undefined;
          const w = t.weeks || [], labels = w.map((x) => x.label);
          const running = w.length && w[w.length - 1].key === D.weekKey(H.today()) ? 'Tuần đang chạy, số còn tăng' : false;
          return [
            C.line({ title: 'Điểm khối lượng theo tuần', labels, series: [{ name: 'Điểm khối lượng', data: w.map((x) => x.points), tone: 'blue', area: true }], format: (v) => `${H.num(v, 1)} điểm`, height: 200, partial: running, note: (i) => (w[i].ppd !== null ? `${H.num(w[i].ppd, 1)} điểm/công · ${H.num(w[i].workdays)} công` : null) }),
            h('p.ov-sub-h', { style: { marginTop: '12px' } }, 'Đúng hạn theo tuần'),
            C.line({ title: 'Tỉ lệ đúng hạn theo tuần', labels, series: [{ name: 'Đúng hạn', data: w.map((x) => x.sla_pct), tone: 'go' }], format: (v) => H.pct(v, 1, true), yFormat: (v) => `${H.num(v)}%`, yMax: 100, height: 130 }),
          ];
        });
        return H.card('Xu hướng 12 tuần', box, { sub: `Cả team, đến ${d.period === 'week' ? d.label : endKey.slice(5)}` });
      }
      function typeCard(d) {
        const list = (d.summary.by_type || []).filter((x) => x.points > 0);
        return H.card('Cơ cấu công việc', [
          D.rank(list.slice(0, 8).map((x) => ({ label: x.label, value: x.share, text: `${H.num(x.share, x.share < 10 ? 1 : 0)}%`, sub: `${H.num(x.n)} ${x.type === 'cards_upload' ? 'thẻ' : 'việc'} · ${H.num(x.points, 1)} điểm`, tone: 'blue' })), { max: 100, empty: 'Chưa có việc hoàn thành trong kỳ.' }),
          list.length > 8 ? D.src(`Và ${H.num(list.length - 8)} loại việc khác.`) : null,
        ], { sub: 'Tỉ trọng điểm khối lượng theo loại việc' });
      }
      function shareCard(d) {
        const rows = d.rows.filter((r) => r.points > 0 || r.workdays > 0).sort((a, b) => b.points - a.points);
        const tot = d.summary.points || 0;
        return H.card('Chia việc trong team', rows.length
          ? C.bar({ title: 'Điểm khối lượng từng người', horizontal: true, labels: rows.map((r) => r.user.name), series: [{ name: 'Điểm khối lượng', data: rows.map((r) => r.points), tone: 'blue' }], format: (v) => `${H.num(v, 1)} điểm`, note: (i) => `${tot ? H.pct(rows[i].points / tot) : '–'} khối lượng team · ${H.num(rows[i].workdays)} công` })
          : H.empty('Chưa ai có việc hoàn thành trong kỳ.'), { sub: 'Điểm khối lượng từng người · để cân tải, không phải xếp hạng' });
      }
      function dailyCard(d) {
        const days = d.summary.daily || [];
        const today = H.today();
        const labels = days.map((x) => dd(x.date));
        return H.card('Điểm theo ngày', C.bar({ title: 'Điểm khối lượng theo ngày', labels, series: [{ name: 'Điểm', data: days.map((x) => (x.date > today ? null : x.points)), tone: 'blue' }], format: (v) => `${H.num(v, 1)} điểm`, capFormat: (v) => H.num(v, 0), height: 200, note: (i) => (days[i].date === today ? 'Hôm nay, số còn tăng' : null), empty: 'Chưa có số liệu.' }), { sub: `${d.label} · cả team` });
      }

      function howCard(d) {
        const w = d.weights || {}, b = d.bands || [];
        const tot = PARTS.reduce((a, [k]) => a + (w[k] || 0), 0) || 1;
        const rl = (n) => H.label('rating', n);
        return H.card('Cách tính điểm', h('div.perf-how', h('div',
          h('div.perf-weights', PARTS.filter(([k]) => w[k]).map(([k, label, , hint]) => h('div', { title: hint }, h('span', label), h('b', `${H.num(w[k])}%`), H.bar(w[k] / tot), h('small.h-muted', hint)))),
          b.length === 4 ? h('div.perf-bands', [[5, `≥ ${b[0]}`], [4, `≥ ${b[1]}`], [3, `≥ ${b[2]}`], [2, `≥ ${b[3]}`], [1, `< ${b[3]}`]].map(([n, t]) => H.pill(`${t}: ${rl(n)}`, RATE_TONE[n]))) : null),
          h('div.perf-note',
            h('p', `Điểm khối lượng = phút chuẩn ÷ 6. Trung bình team kỳ này: ${H.num(d.team_avg_ppd, 1)} điểm/công.`),
            h('p', `Xếp loại khi có từ ${H.num(d.min_days)} công trong kỳ; Lead không xếp loại nên không có điểm tổng hợp. Thành phần không có số liệu thì bỏ và chia lại trọng số. Top 3 chỉ gồm người có khối lượng trong kỳ.`),
            h('p.h-muted', `Trọng số, ngưỡng và số công tối thiểu là đề xuất, riêng cho ${teamName(d.team)}; Lead của team chốt trong Cài đặt.`),
            d.note ? H.note(d.note, 'wait') : null)), { sub: 'Trọng số và ngưỡng xếp loại lấy từ Cài đặt hiện hành' });
      }

      function peopleCard(d, word) {
        const tot = d.summary.points || 0, isLog = d.team === 'logistics';
        const tbl = H.table({
          rows: d.rows, id: (r) => r.user.id, pageSize: 50, sort: null,
          onRow: (r) => ctx.setParams([r.user.id]),
          empty: 'Team chưa có ai.',
          columns: [
            { key: 'name', label: 'Nhân sự', value: (r) => r.user.name, render: (r) => h('span.perf-who', h('b', r.user.name), h('small', [r.user.role_label, r.user.active ? '' : 'đã khoá'].filter(Boolean).join(' · '))) },
            { key: 'score', label: 'Điểm tổng hợp', align: 'r', desc: true, render: (r) => (isNum(r.score) ? h('span.inc-cell', h('b', H.num(r.score, 1)), h('small', D.arrow(r.score, r.prev_score, { label: cap(word), d: 1 }))) : '–') },
            { key: 'rating', label: 'Mức', value: (r) => r.rating || 0, desc: true, render: rateCell },
            { key: 'points', label: 'Điểm KL', align: 'r', desc: true, render: (r) => h('span.inc-cell', h('b', H.num(r.points, 1)), isNum(r.delta_pct) ? h('small', D.deltaPct(r.delta_pct, { short: true, label: word })) : null) },
            { key: 'share', label: 'Tỉ trọng', align: 'r', desc: true, value: (r) => (tot ? r.points / tot : 0), render: (r) => h('span.perf-share', h('span', tot ? H.pct(r.points / tot) : '–'), H.bar(tot ? r.points / tot : 0)) },
            { key: 'jobs', label: isLog ? 'Việc' : 'Việc / thẻ', align: 'r', desc: true, render: (r) => h('span.inc-cell', h('b', isLog ? H.num(r.jobs) : `${H.num(r.jobs)} / ${H.num(r.uploads)}`), r.late_jobs ? h('small', `${H.num(r.late_jobs)} trễ hạn`) : null) },
            { key: 'sla_pct', label: 'Đúng hạn', align: 'r', desc: true, render: (r) => (isNum(r.sla_pct) ? h('span.inc-cell', h('b', H.pct(r.sla_pct, 0, true)), h('small', D.arrow(r.sla_pct, r.prev_sla_pct, { label: cap(word), unit: ' điểm', d: 0 }))) : '–') },
            { key: 'quality', label: 'Chất lượng', align: 'r', desc: true, render: (r) => (isNum(r.quality) ? h('span.inc-cell', h('b', H.pct(r.quality, 0, true)), r.rework ? h('small', `${H.num(r.rework)} sửa lại`) : null) : '–') },
            { key: 'workdays', label: 'Công', align: 'r', desc: true, render: (r) => h('span.inc-cell', h('b', H.num(r.workdays)), h('small', [r.late_days ? `${r.late_days} trễ` : '', r.absent ? `${r.absent} vắng` : '', r.leave ? `${r.leave} phép` : ''].filter(Boolean).join(' · ') || (r.scheduled ? `${r.scheduled} ca xếp` : ''))) },
            { key: 'ppd', label: 'Điểm/công', align: 'r', desc: true, render: (r) => (isNum(r.ppd) ? H.num(r.ppd, 1) : '–') },
          ],
        });
        return H.card('Từng người', tbl, { sub: `${H.num(d.rows.length)} người · bấm một dòng để xem chi tiết · sắp theo điểm tổng hợp` });
      }

      function foSection(d, word) {
        const fo = d.fo, s = fo.summary;
        const tbl = H.table({
          rows: fo.rows, id: (r) => r.user.id, pageSize: 50,
          onRow: (r) => ctx.setParams([r.user.id]),
          empty: 'Chưa có Field Ops nào chạy chuyến trong kỳ.',
          columns: [
            { key: 'name', label: 'Field Ops', value: (r) => r.user.name, render: (r) => h('span.perf-who', h('b', r.user.name), h('small', r.user.active ? r.user.role_label : 'đã khoá')) },
            { key: 'score', label: 'Điểm tổng hợp', align: 'r', desc: true, render: (r) => (isNum(r.score) ? h('span.inc-cell', h('b', H.num(r.score, 1)), h('small', D.arrow(r.score, r.prev_score, { label: cap(word), d: 1 }))) : '–') },
            { key: 'rating', label: 'Mức', value: (r) => r.rating || 0, desc: true, render: rateCell },
            { key: 'points', label: 'Điểm KL', align: 'r', desc: true, render: (r) => h('span.inc-cell', h('b', H.num(r.points, 1)), h('small', { title: 'Điểm việc hub + điểm giao nhận' }, `việc ${H.num(r.hub_points, 1)} · giao ${H.num(r.stop_points, 1)}`)) },
            { key: 'completed', label: 'Chuyến xong', align: 'r', desc: true, render: (r) => h('span.inc-cell', h('b', `${H.num(r.completed)} / ${H.num(r.tasks)}`), r.failed ? h('small', `${H.num(r.failed)} không giao được`) : null) },
            { key: 'stops_done', label: 'Điểm giao nhận', align: 'r', desc: true, render: (r) => h('span.inc-cell', h('b', H.num(r.stops_done)), r.stops_failed ? h('small', `${H.num(r.stops_failed)} lỗi`) : null) },
            { key: 'sla_pct', label: 'Đúng hạn', align: 'r', desc: true, render: (r) => (isNum(r.sla_pct) ? H.pct(r.sla_pct, 0, true) : '–') },
            { key: 'quality', label: 'Chất lượng', align: 'r', desc: true, render: (r) => (isNum(r.quality) ? h('span.inc-cell', h('b', H.pct(r.quality, 0, true)), r.bo_mismatch ? h('small', `${H.num(r.bo_mismatch)} BO báo lệch`) : null) : '–') },
            { key: 'workdays', label: 'Ngày chạy', align: 'r', desc: true },
            { key: 'km', label: 'Km', align: 'r', desc: true, render: (r) => H.num(r.km, 0) },
            { key: 'ppd', label: 'Điểm/ngày', align: 'r', desc: true, render: (r) => (isNum(r.ppd) ? H.num(r.ppd, 1) : '–') },
          ],
        });
        return [
          H.sec('Field Ops', `Thuộc Logistics · số liệu từ chuyến đã chạy, không có vị trí`),
          H.grid(2,
            H.card('Top 3 Field Ops', D.podium(fo.top3, { empty: fo.rate_off ? 'Logistics chưa bật xếp loại (Cài đặt) nên Field Ops cũng chưa xếp loại.' : 'Chưa FO nào đủ ngày chạy và có khối lượng để xếp loại.' }), { sub: d.label }),
            H.card('Cả đội Field Ops', [
              h('div.dash-mini',
                h('div', h('span', 'Điểm khối lượng'), h('b', H.num(s.points, 1)), D.deltaPct(s.delta_pct, { label: word, short: true })),
                h('div', h('span', 'Chuyến xong'), h('b', H.num(s.completed))),
                h('div', h('span', 'Đúng hạn'), h('b', isNum(s.sla_pct) ? H.pct(s.sla_pct, 0, true) : '–')),
                h('div', h('span', 'Điểm giao nhận'), h('b', H.num(s.stops_done))),
                h('div', h('span', 'Km'), h('b', H.num(s.km, 0)))),
              D.src(`Điểm FO = điểm việc hub đi theo chuyến + điểm giao nhận không gắn việc (${H.num(fo.stop_std)} phút chuẩn mỗi điểm, đề xuất, Logistics chốt). TB ${isNum(fo.avg_ppd) ? H.num(fo.avg_ppd, 1) : '–'} điểm/ngày chạy.`),
            ], { sub: `${d.label} so với ${d.prev_label}` })),
          h('div.dash-sec-gap', H.card('Từng Field Ops', tbl, { sub: 'Bấm một dòng để xem chi tiết' })),
        ];
      }

      function showPerson(d, r, isFo) {
        if (dlg) { const x = dlg; dlg = null; x.close(); }
        const word = D.prevWord(d);
        const kv = isFo
          ? [['Điểm khối lượng', `${H.num(r.points, 1)} (việc ${H.num(r.hub_points, 1)} + giao nhận ${H.num(r.stop_points, 1)})`], [`${cap(word)}`, `${H.num(r.prev_points, 1)} điểm`], ['Chuyến', `${H.num(r.completed)} xong / ${H.num(r.tasks)} · ${H.num(r.ontime)} đúng hạn · ${H.num(r.late)} trễ · ${H.num(r.failed)} không giao được`], ['Điểm giao nhận', `${H.num(r.stops_done)} xong · ${H.num(r.stops_failed)} lỗi · ${H.num(r.bo_mismatch)} BO báo lệch`], ['Ngày chạy', `${H.num(r.workdays)} · ${H.num(r.km, 0)} km`], ['Điểm / ngày', isNum(r.ppd) ? H.num(r.ppd, 1) : '–']]
          : [['Điểm khối lượng', `${H.num(r.points, 1)} điểm`], [cap(word), `${H.num(r.prev_points, 1)} điểm`], ['TB 4 tuần trước', isNum(r.avg4_points) ? `${H.num(r.avg4_points, 1)} điểm/tuần` : null], ['Việc xong', `${H.num(r.jobs)} việc · ${H.num(r.late_jobs)} trễ hạn${r.uploads ? ` · ${H.num(r.uploads)} thẻ đã nhập (${H.num(r.gb, 1)} GB, ${H.num(r.hours, 1)} giờ)` : ''}`], ['Đúng hạn', isNum(r.sla_pct) ? `${H.pct(r.sla_pct, 0, true)} (${H.num(r.on_time)}/${H.num(r.with_due)})` : '–'], ['Thời gian xử lý TB', isNum(r.avg_handle_min) ? H.dur(r.avg_handle_min) : null], ['Chấm công', `${H.num(r.workdays)} công / ${H.num(r.scheduled)} ca xếp · ${H.num(r.late_days)} trễ · ${H.num(r.absent)} vắng · ${H.num(r.leave)} phép${r.ot_min ? ` · tăng ca ${H.dur(r.ot_min)}` : ''}`], ['Điểm / công', isNum(r.ppd) ? `${H.num(r.ppd, 1)} (TB team ${H.num(isFo ? d.fo.avg_ppd : d.team_avg_ppd, 1)})` : '–']];
        const types = (r.by_type || []).filter((x) => x.points > 0);
        const bodyEl = h('div.inc-detail',
          h('div.h-row', isNum(r.score) ? h('span.perf-pscore', h('b', H.num(r.score, 1)), ' điểm tổng hợp') : null, rateCell(r)),
          h('section', h('h3', 'Thành phần điểm'), parts(r, d.weights, isFo)),
          h('section', h('h3', 'Số liệu trong kỳ'), H.dl(kv)),
          types.length ? h('section', h('h3', 'Theo loại việc'), D.rank(types.map((x) => ({ label: x.label, value: x.points, text: `${H.num(x.points, 1)} điểm`, sub: `${H.num(x.n)} lần`, tone: 'blue' })))) : null,
          d.locked ? H.note(`Số liệu đã chốt ${H.when(d.locked.at)}.`, 'go') : null);
        dlg = ARL.modal({ title: `${r.user.name} · ${d.label}`, body: bodyEl, wide: true, actions: [{ label: 'Đóng', cls: 'ghost', run: () => {} }], onClose: () => { if (dlg) { dlg = null; if (ctx.alive() && ctx.params[0]) ctx.setParams([]); } } });
      }
    },
  });

  // ═════════════ Hiệu suất của tôi ═════════════
  ARL.hub.view('me', {
    mount(el, ctx) {
      const st = { period: ctx.query.period === 'month' ? 'month' : 'week', key: ctx.query.key || null };
      const navBox = h('div');
      const head = H.head('Hiệu suất của tôi', ' ', navBox);
      const sub = head.querySelector('.sub');
      const body = h('div.me-v.dash-v');
      el.append(head, body);
      const load = H.async(body, async () => {
        const d = await ctx.api('GET', '/api/hub/perf/me', null, D.q({ period: st.period, key: st.key }));
        if (!ctx.alive()) return undefined;
        st.period = d.period; st.key = d.key;
        H.clear(navBox, D.periodNav(d, (p, k) => { st.period = p; st.key = k; st.snap = false; ctx.setQuery({ period: p === 'week' ? null : p, key: k }); load(); }));
        const note = D.cmpNote(d, { data: false });
        sub.textContent = `${d.label} (${D.range(d.from, d.to)}) so với ${d.prev_label}${note ? ` · ${note}` : ''}${d.locked ? ' · đã chốt' : ''}`;
        return render(d);
      });
      const soon = D.throttle(ctx, load, 8000);
      ctx.live(['perf', 'jobs', 'roster', 'records', 'config'], soon);

      function render(d) {
        const r = d.me, a = d.team_avg || {}, word = D.prevWord(d);
        if (!r) return [H.empty('Chưa có số liệu của bạn trong kỳ này. Số liệu có khi bạn hoàn thành việc hoặc được chấm công.')];
        const isLead = ['tech_lead', 'lead'].includes(ctx.role);
        // Trung bình team chỉ có khi từ 2 người khác (không gồm bạn và Lead) có số liệu; ít hơn thì không gửi để không lộ số của ai.
        const canCompare = !!d.team_avg;
        const out = [];
        if (d.in_top3) out.push(H.note(`Bạn đang trong Top 3 của team ${d.label}. Giữ phong độ nhé!`, 'go'));
        out.push(H.kpis(
          D.kpi({ label: 'Điểm khối lượng', value: H.num(r.points, 1), unit: 'điểm', deltas: [D.deltaPct(r.delta_pct, { label: word }), d.period === 'week' && r.avg4_points ? D.deltaPct(r.vs_avg4_pct, { label: 'TB 4 tuần' }) : null].filter(Boolean), hint: `${H.num(r.jobs)} việc${r.uploads ? ` · ${H.num(r.uploads)} thẻ đã nhập` : ''} · điểm = phút chuẩn ÷ 6` }),
          D.kpi({ label: 'Đúng hạn', value: isNum(r.sla_pct) ? H.pct(r.sla_pct, 0, true) : '–', deltas: isNum(r.sla_pct) ? [H.delta(r.sla_pct, r.prev_sla_pct, { label: word, abs: true, unit: ' điểm %', d: 1 })] : [], hint: r.with_due ? `${H.num(r.on_time)}/${H.num(r.with_due)} việc có hạn · ${H.num(r.late_jobs)} trễ` : 'Chưa có việc có hạn hoàn thành' }),
          D.kpi({ label: 'Công', value: r.workdays, unit: r.scheduled ? `/ ${H.num(r.scheduled)} ca xếp` : null, hint: [r.late_days ? `${r.late_days} ngày trễ` : '', r.absent ? `${r.absent} vắng` : '', r.leave ? `${r.leave} phép` : ''].filter(Boolean).join(' · ') || 'Không trễ, không vắng' }),
          D.kpi({ label: 'Điểm / công', value: isNum(r.ppd) ? H.num(r.ppd, 1) : '–', deltas: isNum(r.ppd) ? [H.delta(r.ppd, r.prev_ppd, { label: word, d: 1 })] : [], hint: canCompare && isNum(a.ppd) ? `TB team ${H.num(a.ppd, 1)}` : `${H.num(r.workdays)} công trong kỳ` }),
          D.kpi({ label: 'Điểm tổng hợp', value: isNum(r.score) ? H.num(r.score, 1) : '–', tone: r.rated ? RATE_TONE[r.rating] : null, deltas: isNum(r.score) && isNum(r.prev_score) ? [H.delta(r.score, r.prev_score, { label: word, abs: true, d: 1 })] : [], hint: r.rated ? `Mức: ${r.rating_label}` : (r.not_rated_reason || 'Chưa xếp loại') })));

        out.push(h('div.dash-sec-gap', H.grid(2,
          H.card('So với trung bình team', canCompare ? vsTeam(r, a) : H.empty('Chưa đủ 2 người khác trong team góp vào trung bình điểm/công kỳ này (đủ số công tối thiểu, có số liệu) nên chưa so với trung bình, để không lộ số của người khác.'), { sub: canCompare ? `Trung bình của ${H.num(d.avg_n)} người khác góp vào trung bình điểm/công của team (không gồm bạn và Lead) · không hiện tên hay số của ai khác` : 'So sánh khi có từ 2 người khác cùng có số liệu' }),
          H.card('Thành phần điểm', [d.weights ? parts(r, d.weights, false) : H.empty('Chưa có trọng số điểm.'), isLead ? D.src('Lead không xếp loại theo khối lượng; số ở đây để bạn tự theo dõi.') : null], { sub: 'Mỗi phần 0–100, gộp theo trọng số đề xuất trong Cài đặt' }))));

        const types = (r.by_type || []).filter((x) => x.points > 0);
        const jobsBox = h('div');
        out.push(h('div.dash-sec-gap', H.grid(2,
          H.card('Việc theo loại', D.rank(types.map((x) => ({ label: x.label, value: x.points, text: `${H.num(x.points, 1)} điểm`, sub: `${H.num(x.n)} lần`, tone: 'blue' })), { empty: 'Chưa có việc hoàn thành trong kỳ.' }), { sub: d.label }),
          H.card('Việc vừa xong', jobsBox, { sub: 'Gần nhất trước · việc nhập dung lượng tính điểm theo từng thẻ' }))));
        H.async(jobsBox, async () => {
          const j = await ctx.api('GET', '/api/hub/jobs', null, { status: 'done', view: 'mine' });
          if (!ctx.alive()) return undefined;
          const list = (j.jobs || []).filter((x) => x.done_by && x.done_by.id === ctx.user.id).sort((x, y) => (y.done_at || 0) - (x.done_at || 0)).slice(0, 8);
          if (!list.length) return H.empty('Chưa có việc nào hoàn thành.');
          return h('ul.sale-list', list.map((x) => h('li',
            h('span.sale-list-n', h('a', { href: D.href('jobs', [x.id]) }, x.title || x.type_label), h('small', [x.code, x.type_label, x.site ? x.site.name : ''].filter(Boolean).join(' · '))),
            h('span.sale-list-r', x.type === 'cards_upload' && !x.points ? h('b.h-muted', { title: 'Việc nhập dung lượng được tính điểm theo từng thẻ đã nhập' }, `${H.num(x.units)} thẻ`) : h('b', `${H.num(x.points, 1)} điểm`), h('small', [H.when(x.done_at), x.late_mine ? 'trễ hạn' : ''].filter(Boolean).join(' · '))))));
        });
        out.push(h('div.dash-sec-gap', H.note(d.note || 'Phút chuẩn và trọng số là đề xuất.', null)));
        return out;
      }
      function vsTeam(r, a) {
        const rows = [
          ['Điểm khối lượng', r.points, a.points, (v) => `${H.num(v, 1)}`],
          ['Điểm / công', r.ppd, a.ppd, (v) => H.num(v, 1)],
          ['Đúng hạn', r.sla_pct, a.sla_pct, (v) => H.pct(v, 0, true)],
          ['Điểm tổng hợp', r.score, a.score, (v) => H.num(v, 1)],
        ];
        return h('div.me-vs', rows.map(([label, me, avg, f]) => {
          const max = Math.max(isNum(me) ? me : 0, isNum(avg) ? avg : 0, label === 'Đúng hạn' || label === 'Điểm tổng hợp' ? 100 : 0) || 1;
          const diff = isNum(me) && isNum(avg) ? me - avg : null;
          return h('div.me-vs-r',
            h('div', h('b', label), h('span', diff === null ? 'chưa đủ số để so' : Math.abs(diff) < 0.05 ? 'bằng trung bình team' : `${diff > 0 ? 'cao hơn' : 'thấp hơn'} trung bình ${label === 'Đúng hạn' ? `${H.num(Math.abs(diff), 0)} điểm %` : f(Math.abs(diff))}`)),
            h('div.me-vs-bars',
              h('div', h('span', 'Bạn'), H.bar(isNum(me) ? me / max : 0), h('b', isNum(me) ? f(me) : '–')),
              h('div', h('span', 'TB team'), h('div.h-bar.avg', { role: 'img', 'aria-label': `Trung bình team ${isNum(avg) ? f(avg) : 'chưa có'}` }, h('i', { style: { width: `${isNum(avg) ? Math.min(100, (avg / max) * 100) : 0}%` } })), h('b', isNum(avg) ? f(avg) : '–'))));
        }));
      }
    },
  });
})();
