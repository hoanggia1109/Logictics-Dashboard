/* Ops Hub — Dashboard Kinh doanh: BO, onboard (đã ký), chờ active, đang active, giờ ghi hình, quota, chuẩn giờ quay.
   Head of Sale và Quản trị xem cả team; Sale Lead chỉ thấy BO mình phụ trách (máy chủ tự lọc, scope = 'mine').
   Một lượt GET /api/hub/sale cho cả trang; mọi con số do máy chủ tính. Không có gì về Field Ops ở đây (vị trí, chuyến, tài xế). */
(() => {
  'use strict';
  const H = ARL.H, { h } = H, C = ARL.chart, D = ARL.dash;

  // Màu Sale Lead theo id (không theo hạng) — 4 màu đã kiểm mù màu; Sale thứ 5 trở đi gộp "Sale khác".
  const SALE_TONES = ['blue', 'rose', 'teal', 'violet'];
  const BUCKETS = ['live', 'waiting', 'prospect', 'paused', 'ending', 'ended'];
  const bucketLabel = (b) => (b === 'waiting' ? 'Chờ active' : b === 'prospect' ? 'Chưa gửi yêu cầu launch' : H.label('outlet_st', b));
  const bucketTone = (b) => ({ live: 'go', waiting: 'wait', prospect: 'off', paused: 'off', ending: 'wait', ended: 'off' })[b] || 'off';

  ARL.hub.view('sale', {
    mount(el, ctx) {
      const st = {
        period: ctx.query.period === 'month' ? 'month' : 'week', key: ctx.query.key || null,
        bucket: BUCKETS.includes(ctx.query.bucket) ? ctx.query.bucket : 'all', q: '', sale: '', quotaAll: false,
      };
      const canOpen = (v) => D.canOpen(ctx, v);
      // scope: 'mine' (BO của mình) · 'view' (Sale Lead được xem mọi BO, chỉ xem, không có số theo từng Sale Lead) · 'all' (Head of Sale, Quản trị).
      const all = (d) => d.scope !== 'mine'; // hiện tên Sale phụ trách trên từng dòng
      const team = (d) => d.scope === 'all'; // số và biểu đồ theo từng Sale Lead
      const canQuota = (d, o) => d.can_edit_quota === true || (d.can_edit_quota === 'own' && !!o.sale && o.sale.id === ctx.user.id);
      const cap = (w) => w[0].toUpperCase() + w.slice(1);
      const boHref = (id) => (canOpen('outlets') ? D.href('outlets', [id]) : null);
      const navBox = h('div');
      const head = H.head('Dashboard Kinh doanh', ' ', navBox);
      const sub = head.querySelector('.sub');
      const body = h('div.sale-v.dash-v');
      el.append(head, body);

      const load = H.async(body, async () => {
        const d = await ctx.api('GET', '/api/hub/sale', null, D.q({ period: st.period, key: st.key }));
        if (!ctx.alive()) return undefined;
        st.period = d.period; st.key = d.key;
        H.clear(navBox, D.periodNav(d, (p, k) => { st.period = p; st.key = k; ctx.setQuery({ period: p === 'week' ? null : p, key: k }); load(); }));
        const note = D.cmpNote(d);
        sub.textContent = `${d.scope === 'mine' ? 'BO bạn phụ trách' : d.scope === 'view' ? 'Toàn bộ BO của team Sale (chỉ xem; chỉ sửa được BO bạn phụ trách)' : 'Toàn bộ BO của team Sale'} · ${d.label} (${D.range(d.from, d.to)}) so với ${d.prev_label}${note ? ` · ${note}` : ''}`;
        return render(d);
      });
      const soon = D.throttle(ctx, load, 8000);
      ctx.live(['outlets', 'records', 'requests', 'incidents', 'kits', 'config'], soon);

      function render(d) {
        const hos = d.hos, k = hos.kpi, ev = hos.eval, word = D.prevWord(d);
        const isAll = team(d);
        const inc = new Map((d.outlets || []).map((o) => [o.id, o]));
        const tr = d.trend || [];
        const labels = tr.map((x) => x.label);
        const evalOk = ev.from <= ev.to;
        const stdTxt = `${H.num(ev.std_hours, 1)} giờ/kit/ngày`;
        const evalTxt = evalOk ? `xét ${D.range(ev.from, ev.to)}, chỉ ngày thẻ đã nhập đủ` : 'kỳ này chưa có ngày đủ số liệu';
        const openInc = (d.outlets || []).reduce((a, o) => a + (o.open_incidents || 0), 0);
        const out = [];

        // ───── Ô số liệu ─────
        out.push(
          h('h2.ov-kpi-h', 'Kết quả ghi hình'),
          H.kpis(
            D.kpi({ label: 'Giờ ghi hình', value: H.num(k.hours.cur, 1), unit: 'giờ', deltas: [D.deltaPct(k.hours.delta_pct, { label: word, none: d.cmp && d.cmp.data_to === null ? 'chưa đủ ngày để so' : undefined })], hint: d.cmp && d.cmp.data_partial && d.cmp.data_to ? `${H.num(d.totals.cards)} thẻ · so tới hết ${H.dmy(d.cmp.data_to)}, thẻ ${d.cmp.lag_days} ngày gần nhất chưa nhập đủ` : `${H.num(d.totals.cards)} thẻ đã nhập · theo ngày quay`, spark: tr.map((x) => x.hours), sparkLabels: labels, sparkFormat: (v) => H.hours(v) }),
            D.kpi({
              label: 'Giờ quay / kit / ngày', value: k.per_kit_day.cur === null ? '–' : H.num(k.per_kit_day.cur, 1), unit: k.per_kit_day.cur === null ? null : 'giờ',
              tone: k.per_kit_day.cur === null ? null : k.per_kit_day.cur < k.per_kit_day.std ? 'wait' : 'go',
              deltas: k.per_kit_day.cur === null ? [] : [D.deltaPct(k.per_kit_day.delta_pct, { label: word })],
              hint: `Chuẩn đề xuất ${H.num(k.per_kit_day.std, 1)} giờ · ${evalTxt}`,
            }),
            D.kpi({ label: 'BO dưới chuẩn giờ quay', value: k.below_std.count, unit: `/ ${H.num(k.below_std.rated)} BO`, tone: k.below_std.count ? 'wait' : null, deltas: k.below_std.rated ? [H.delta(k.below_std.count, k.below_std.prev, { label: word, up: 'bad', abs: true })] : [], hint: `Dưới ${stdTxt} (đề xuất, Sale chốt)` }),
            D.kpi({ label: 'Thẻ 0 giờ', value: k.zero.cur, tone: k.zero.cur ? 'wait' : null, hint: 'Thẻ về mà không có dữ liệu ghi hình', spark: tr.map((x) => x.zero), sparkLabels: labels, sparkTone: 'wait' }),
            D.kpi({ label: 'Sự cố tại BO', value: d.totals.incidents, tone: openInc ? 'lost' : null, hint: `${H.num(openInc)} đang mở · báo trong ${d.label}`, onClick: () => ctx.go('incidents', [], { status: 'open' }), title: 'Mở danh sách sự cố' })),
          h('h2.ov-kpi-h', 'Danh mục BO'),
          H.kpis(
            D.kpi({ label: 'Đang active', value: k.active_now, unit: `/ ${H.num(k.bo_total)} BO`, tone: 'go', hint: `${H.num(k.live)} đang ghi hình · ${H.num(k.paused)} tạm nghỉ · ${H.num(d.totals.kits)} kit đang ở BO`, onClick: canOpen('outlets') ? () => ctx.go('outlets', [], { st: 'live' }) : null, title: 'Mở danh sách BO' }),
            D.kpi({ label: 'Đã onboard trong kỳ', value: k.onboard.cur, deltas: [H.delta(k.onboard.cur, k.onboard.prev, { label: word, abs: true })], hint: `BO đã ký (gửi yêu cầu launch) · ${k.onboard_month.label}: ${H.num(k.onboard_month.cur)} BO · ${k.onboard_month.prev_label}: ${H.num(k.onboard_month.prev)}` }),
            D.kpi({ label: 'Chờ active', value: k.waiting, tone: k.waiting ? 'wait' : null, hint: [`Đã onboard, chờ giao máy · ${H.num(k.activated.cur)} BO active trong kỳ`, k.launches.n ? `${H.num(k.launches.on_time)}/${H.num(k.launches.n)} launch đúng hẹn` : '', k.launches.avg_lead_days !== null ? `TB ${H.num(k.launches.avg_lead_days, 1)} ngày từ yêu cầu tới có máy` : '', `${H.num(k.prospect)} BO chưa gửi yêu cầu`].filter(Boolean).join(' · ') }),
            D.kpi({ label: 'Sắp chạm / vượt quota', value: k.quota.near + k.quota.over, unit: `/ ${H.num(k.quota.with_quota)} BO có quota`, tone: k.quota.over ? 'lost' : k.quota.near ? 'wait' : null, hint: `${H.num(k.quota.over)} đã vượt · ${H.num(k.quota.live_without_quota)} BO đang ghi hình chưa có quota` }),
            D.kpi({ label: 'Tạm nghỉ / đang thu hồi', value: k.paused + k.ending, hint: `${H.num(k.paused)} tạm nghỉ · ${H.num(k.ending)} đang thu hồi · ${H.num(k.ended)} đã kết thúc` })));

        // ───── Xu hướng giờ + phễu BO ─────
        const curWeek = tr.length && tr[tr.length - 1].key === D.weekKey(H.today());
        out.push(h('div.dash-grid-3.dash-sec-gap',
          H.card('Giờ ghi hình 12 tuần', tr.length ? C.line({ title: 'Giờ ghi hình theo tuần', labels, series: [{ name: 'Giờ ghi hình', data: tr.map((x) => x.hours), tone: 'blue', area: true }], format: (v) => H.hours(v), height: 220, partial: curWeek ? 'Tuần đang chạy, số còn tăng' : false }) : H.empty('Chưa có số liệu.'), { sub: `Giờ thô Tech nhập từ thẻ, theo ngày quay${all(d) ? '' : ' · BO của bạn'}` }),
          H.card('Phễu BO', [
            C.funnel({ title: 'Phễu BO', steps: [
              { label: 'Tổng BO trong danh sách', value: k.bo_total, tone: 'off' },
              { label: 'Đã onboard (đã ký)', value: k.onboarded, tone: 'blue' },
              { label: 'Đã active (có máy)', value: k.activated.total, tone: 'blue' },
              { label: 'Đang active', value: k.active_now, tone: 'go' },
            ], format: (v) => `${H.num(v)} BO` }),
            h('div.dash-foot', h('span', `${H.num(k.waiting)} chờ active · ${H.num(k.ending)} đang thu hồi · ${H.num(k.ended)} đã kết thúc`)),
          ], { sub: 'Tình trạng hiện tại, không theo kỳ · % so với bước trước' })));

        // ───── Onboard theo tháng + phân bố giờ / kit / ngày ─────
        const months = hos.onboard_by_month || [];
        const mLabels = months.map((m) => m.label.replace('/20', '/'));
        let onboardChart;
        if (isAll) {
          const ids = Object.keys(hos.sale_names).map(Number).filter((x) => x).sort((a, b) => a - b);
          const main = ids.slice(0, SALE_TONES.length), rest = ids.slice(SALE_TONES.length);
          const series = main.map((id, i) => ({ name: hos.sale_names[id], data: months.map((m) => m.by_sale[id] || 0), tone: SALE_TONES[i] }));
          if (rest.length) series.push({ name: 'Sale khác', data: months.map((m) => rest.reduce((a, id) => a + (m.by_sale[id] || 0), 0)), tone: 'off' });
          if (hos.sale_names[0]) series.push({ name: hos.sale_names[0], data: months.map((m) => m.by_sale[0] || 0), tone: 'ink' });
          onboardChart = C.bar({ title: 'BO đã onboard theo tháng, theo Sale Lead đã ký', labels: mLabels, series: series.filter((x) => x.data.some((v) => v)), stacked: true, height: 230, format: (v) => `${H.num(v)} BO`, empty: 'Chưa có BO nào onboard trong 12 tháng.' });
        } else {
          onboardChart = C.bar({ title: 'BO đã onboard theo tháng', labels: mLabels, series: [{ name: 'Đã onboard', data: months.map((m) => m.onboard), tone: 'blue' }], height: 230, format: (v) => `${H.num(v)} BO`, empty: 'Chưa có BO nào onboard trong 12 tháng.' });
        }
        const dist = hos.distribution || [];
        out.push(H.grid(2,
          H.card('BO đã onboard theo tháng', onboardChart, { sub: isAll ? '12 tháng, theo tháng gửi yêu cầu launch đầu tiên, chia theo Sale Lead đã ký' : all(d) ? '12 tháng, mọi BO đã ký' : '12 tháng, BO bạn đã ký' }),
          H.card('Phân bố giờ quay / kit / ngày', [
            dist.some((x) => x.count) ? C.bar({ title: 'Số BO theo mức giờ quay mỗi kit mỗi ngày', labels: dist.map((x) => x.label), series: [{ name: 'Số BO', data: dist.map((x) => x.count) }], toneAt: (i) => (dist[i].ok ? 'go' : 'wait'), height: 230, format: (v) => `${H.num(v)} BO`, note: (i) => (dist[i].ok ? 'Đạt chuẩn đề xuất' : 'Dưới chuẩn đề xuất') }) : H.empty(evalOk ? 'Chưa có BO nào đủ số liệu để xét.' : 'Kỳ này chưa có ngày đủ số liệu để xét chuẩn.'),
            D.src(`Chuẩn đề xuất ${stdTxt}, Sale chốt trong Cài đặt · ${evalTxt}. Giờ của mỗi thẻ chia đều cho các ngày thẻ nằm ở BO, chia cho số kit ở BO từng ngày.`),
          ], { sub: 'BO có ngày đủ số liệu trong kỳ · mốc theo chuẩn' })));

        // ───── Theo Sale Lead (Head of Sale, Quản trị) ─────
        if (isAll && (hos.by_sale || []).length) out.push(h('div.dash-sec-gap', leaderCard(d, word)));

        // ───── Quota + dưới chuẩn ─────
        out.push(H.sec('Cần chú ý', null), H.grid(2, quotaCard(d), belowCard(d, word)));
        out.push(h('div.dash-sec-gap', H.grid(3, zeroCard(d), incCard(d), waitCard(d))));

        // ───── Tất cả BO ─────
        out.push(h('div.dash-sec-gap', boCard(d, inc, word)));
        return out.flat(Infinity);
      }

      function leaderCard(d, word) {
        const hos = d.hos, rows = hos.by_sale;
        const tbl = H.table({
          rows, id: (r) => r.sale.id || 0, pageSize: 20,
          onRow: (r) => { st.sale = String(r.sale.id || 0); paintBo(); const t = el.querySelector('.sale-bo'); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
          columns: [
            { key: 'name', label: 'Sale Lead', value: (r) => r.sale.name, render: (r) => h('span.perf-who', h('b', r.sale.name), h('small', `${H.num(r.bo)} BO · ${H.num(r.onboard_total)} đã onboard`)) },
            { key: 'active', label: 'Đang active', align: 'r', desc: true, value: (r) => r.active, render: (r) => h('span', h('b', H.num(r.active)), h('span.h-muted', ` / ${H.num(r.bo)}`)) },
            { key: 'waiting', label: 'Chờ active', align: 'r', desc: true, value: (r) => r.waiting, render: (r) => (r.waiting || r.prospect ? `${H.num(r.waiting)}${r.prospect ? ` (+${H.num(r.prospect)} chưa gửi)` : ''}` : '0') },
            { key: 'onboard_cur', label: 'Đã onboard trong kỳ', align: 'r', desc: true, render: (r) => h('span', h('b', H.num(r.onboard_cur)), ' ', D.arrow(r.onboard_cur, r.onboard_prev, { label: cap(word) })) },
            { key: 'hours', label: 'Giờ ghi hình', align: 'r', desc: true, render: (r) => h('span.inc-cell', h('b', H.hours(r.hours)), h('small', D.deltaPct(r.delta_pct, { short: true, label: word }))) },
            { key: 'per_kit_day', label: 'Giờ/kit/ngày', align: 'r', desc: true, render: (r) => (r.per_kit_day === null ? '–' : H.pill(H.num(r.per_kit_day, 1), r.per_kit_day < hos.eval.std_hours ? 'wait' : 'go')) },
            { key: 'below_std', label: 'BO dưới chuẩn', align: 'r', desc: true, render: (r) => (r.rated ? `${H.num(r.below_std)}/${H.num(r.rated)}` : '–') },
            { key: 'near_quota', label: 'Quota', align: 'r', desc: true, value: (r) => r.near_quota + r.over_quota * 100, render: (r) => (r.near_quota || r.over_quota ? h('span', r.over_quota ? H.pill(`${H.num(r.over_quota)} vượt`, 'lost') : null, r.near_quota ? [' ', H.pill(`${H.num(r.near_quota)} sắp chạm`, 'wait')] : null) : h('span.h-muted', 'ổn')) },
            { key: 'zero', label: 'Thẻ 0 giờ', align: 'r', desc: true },
          ],
        });
        return H.card('Theo Sale Lead', tbl, { sub: `${d.label} so với ${d.prev_label} · bấm một dòng để lọc bảng Tất cả BO` });
      }

      function quotaCard(d) {
        const hos = d.hos, warn = hos.eval.quota_warn_pct;
        const list = hos.quota_list || [];
        const box = h('div.sale-quota');
        const paint = () => {
          const shown = st.quotaAll ? list : list.slice(0, 8);
          H.clear(box, shown.map((o) => {
            const tone = o.quota_status === 'over' ? 'lost' : o.quota_status === 'near' ? 'wait' : 'blue';
            return h('div.sale-q', { 'data-tone': tone },
              h('span.sale-q-n', boHref(o.id) ? h('a', { href: boHref(o.id) }, o.name) : h('b', o.name),
                h('small', [all(d) && o.sale ? o.sale.name : '', o.quota_eta && o.quota_status !== 'over' ? `dự kiến chạm ${H.dmy(o.quota_eta)}` : o.quota_status === 'over' ? 'đã vượt quota' : o.bucket !== 'live' ? o.status_label : `${H.hours(o.pace_daily)}/ngày`].filter(Boolean).join(' · '))),
              h('span.sale-q-b', H.bar(Math.min(1, (o.quota_pct || 0) / 100), tone)),
              h('span.sale-q-v', h('b', H.pct(o.quota_pct, 0, true)), `${H.num(o.used_hours)}/${H.num(o.quota_hours)} giờ`),
              canQuota(d, o) ? h('button.ghost.small.sale-q-e', { type: 'button', title: `Sửa quota ${o.name}`, 'aria-label': `Sửa quota ${o.name}`, onclick: () => editQuota(o, warn) }, 'Sửa') : null);
          }));
        };
        paint();
        const more = list.length > 8 ? H.btn(st.quotaAll ? 'Thu gọn' : `Xem cả ${list.length} BO`, (e, b) => { st.quotaAll = !st.quotaAll; paint(); b.textContent = st.quotaAll ? 'Thu gọn' : `Xem cả ${list.length} BO`; }, 'ghost small dash-more') : null;
        const noQuota = hos.kpi.quota.live_without_quota;
        return H.card('Quota giờ quay', [
          list.length ? [box, more] : H.empty('Chưa BO nào có quota giờ quay. Sale nhập quota ở từng BO (nút Sửa trong danh sách BO bên dưới).'),
          h('div.dash-foot', h('span', `Báo "sắp chạm" từ ${H.num(warn)}% quota (đề xuất, Sale chốt trong Cài đặt)`), noQuota ? h('span', `${H.num(noQuota)} BO đang ghi hình chưa có quota`) : null),
        ], { sub: 'BO còn ghi hình · đã dùng từ lần launch gần nhất · sắp theo % đã dùng', tone: hos.kpi.quota.over ? 'lost' : null });
      }

      function belowCard(d, word) {
        const ev = d.hos.eval, list = d.hos.below_list || [];
        return H.card('BO dưới chuẩn giờ quay', [
          D.rank(list.slice(0, 10).map((o) => ({
            label: o.name, value: o.per_kit_day, text: `${H.num(o.per_kit_day, 1)} giờ`, tone: 'wait', href: boHref(o.id),
            sub: [all(d) && o.sale ? o.sale.name : '', `${H.num(o.eval_kits)} kit × ${H.num(o.eval_days)} ngày`, o.status_label !== 'Đang ghi hình' ? o.status_label : ''].filter(Boolean).join(' · '),
            right: D.arrow(o.per_kit_day, o.prev_per_kit_day, { label: cap(word), d: 1, unit: ' giờ' }),
          })), { max: ev.std_hours, empty: ev.from <= ev.to ? 'Không có BO nào dưới chuẩn trong kỳ.' : 'Kỳ này chưa có ngày đủ số liệu để xét chuẩn.' }),
          list.length > 10 ? D.src(`Và ${H.num(list.length - 10)} BO khác — xem bảng Tất cả BO.`) : null,
          D.src(`Thanh đầy = đạt chuẩn ${H.num(ev.std_hours, 1)} giờ/kit/ngày (đề xuất, Sale chốt). Đây là gợi ý để Sale trao đổi với BO, không tự động thay đổi gì.`),
        ], { sub: ev.from <= ev.to ? `Giờ quay mỗi kit mỗi ngày, ${D.range(ev.from, ev.to)}` : 'Chưa đủ số liệu' });
      }

      function zeroCard(d) {
        const list = d.hos.outlets.filter((o) => o.zero > 0).sort((a, b) => b.zero - a.zero);
        return H.card('Thẻ 0 giờ', [
          D.rank(list.slice(0, 6).map((o) => ({ label: o.name, value: o.zero, text: `${H.num(o.zero)} thẻ`, tone: 'wait', href: boHref(o.id), sub: [all(d) && o.sale ? o.sale.name : '', `${H.num(o.cards)} thẻ đã nhập`].filter(Boolean).join(' · ') })), { empty: `Không có thẻ 0 giờ trong ${d.label}.` }),
          list.length > 6 ? D.src(`Và ${H.num(list.length - 6)} BO khác.`) : null,
          list.length ? D.src('Thẻ về mà không có dữ liệu ghi hình: nên hỏi BO máy có bật, có điện, có bị di chuyển không.') : null,
        ], { sub: `${d.label} · thẻ về không có dữ liệu ghi hình` });
      }

      function incCard(d) {
        const rows = d.outlets || [];
        const list = rows.filter((o) => o.open_incidents).sort((a, b) => b.open_incidents - a.open_incidents || b.incidents - a.incidents);
        const total = rows.reduce((a, o) => a + (o.incidents || 0), 0), openN = list.reduce((a, o) => a + o.open_incidents, 0);
        return H.card('Sự cố đang mở theo BO', [
          D.rank(list.slice(0, 6).map((o) => ({
            label: o.name, value: o.open_incidents, text: `${H.num(o.open_incidents)} đang mở`, tone: 'lost',
            sub: [`${H.num(o.incidents)} báo trong ${d.label}`, all(d) && o.sale ? o.sale.name : ''].filter(Boolean).join(' · '),
            href: D.href('incidents', [], { site: o.id, status: 'open' }),
          })), { empty: 'Không có sự cố nào đang mở ở BO. Tech đã nhận và xử lý hết.' }),
          list.length > 6 ? D.src(`Và ${H.num(list.length - 6)} BO khác.`) : null,
          h('div.dash-foot', h('span', `${H.num(total)} sự cố báo trong ${d.label} · ${H.num(openN)} đang mở`), h('a', { href: D.href('incidents', [], { status: 'open' }) }, 'Mở danh sách sự cố ›')),
        ], { sub: 'Tech nhận và xử lý; Sale theo dõi để báo BO' });
      }

      function waitCard(d) {
        const list = d.hos.waiting_list || [];
        return H.card('Chờ active', list.length ? h('ul.sale-list', list.map((o) => h('li',
          h('span.sale-list-n', boHref(o.id) ? h('a', { href: boHref(o.id) }, o.name) : h('b', o.name), h('small', [all(d) && o.sale ? o.sale.name : '', o.area].filter(Boolean).join(' · '))),
          h('span.sale-list-r', o.request ? (canOpen('requests') ? h('a', { href: D.href('requests', [o.request.id]) }, H.st('req_st', o.request.status)) : H.st('req_st', o.request.status)) : null,
            h('small', [(o.request && o.request.launch_date) || o.launch_date ? `hẹn ${H.dmy((o.request && o.request.launch_date) || o.launch_date)}` : 'chưa hẹn ngày', o.request && o.request.waiting && o.request.waiting.who ? `chờ ${o.request.waiting.who}` : ''].filter(Boolean).join(' · ')))))) : H.empty('Không có BO nào đang chờ active.'), { sub: `${H.num(list.length)} BO đã onboard (đã gửi yêu cầu launch), chờ Logistics và Tech giao máy` });
      }

      // Bảng tất cả BO: lọc theo nhóm, Sale Lead, tìm kiếm — cập nhật tại chỗ.
      let boTbl = null, boRows = [], boChips = null;
      function filtered() {
        return boRows.filter((o) => (st.bucket === 'all' || o.bucket === st.bucket) && (!st.sale || String(o.sale ? o.sale.id : 0) === st.sale) && (!st.q || H.match(`${o.name} ${o.code} ${o.area} ${o.business} ${o.sale ? o.sale.name : ''}`, st.q)));
      }
      function paintBo() {
        if (!boTbl) return;
        boTbl.update(filtered());
        const sel = el.querySelector('.sale-bo select');
        if (sel) sel.value = st.sale;
      }
      function boCard(d, inc, word) {
        boRows = d.hos.outlets;
        const counts = { all: boRows.length };
        for (const b of BUCKETS) counts[b] = boRows.filter((o) => o.bucket === b).length;
        boChips = H.chips([{ key: 'all', label: 'Tất cả', count: counts.all }, ...BUCKETS.filter((b) => counts[b]).map((b) => ({ key: b, label: bucketLabel(b), count: counts[b] }))], counts[st.bucket] ? st.bucket : 'all', (k) => { st.bucket = k; ctx.setQuery({ bucket: k === 'all' ? null : k }); paintBo(); });
        if (!counts[st.bucket]) st.bucket = 'all';
        const saleSel = team(d) ? h('select', { 'aria-label': 'Lọc theo Sale Lead', onchange: (e) => { st.sale = e.target.value; paintBo(); } },
          h('option', { value: '' }, 'Mọi Sale Lead'),
          Object.entries(d.hos.sale_names).map(([id, name]) => h('option', { value: id, selected: st.sale === id }, name))) : null;
        const std = d.hos.eval.std_hours;
        boTbl = H.table({
          rows: filtered(), pageSize: 50, sort: { key: 'hours', dir: -1 },
          empty: 'Không có BO nào khớp bộ lọc.',
          rowTone: (o) => (o.quota_status === 'over' ? 'lost' : null),
          onRow: (o) => { if (canOpen('outlets')) ctx.go('outlets', [o.id]); },
          columns: [
            { key: 'name', label: 'BO', render: (o) => h('span.perf-who', boHref(o.id) ? h('a', { href: boHref(o.id), onclick: (e) => e.stopPropagation() }, o.name) : h('b', o.name), h('small', [o.code, o.area].filter(Boolean).join(' · '))) },
            all(d) ? { key: 'sale', label: 'Sale Lead', value: (o) => (o.sale ? o.sale.name : ''), render: (o) => (o.sale ? o.sale.name : h('span.h-muted', 'Chưa giao')) } : null,
            { key: 'bucket', label: 'Tình trạng', value: (o) => BUCKETS.indexOf(o.bucket), render: (o) => H.pill(bucketLabel(o.bucket), bucketTone(o.bucket)) },
            { key: 'hours', label: 'Giờ trong kỳ', align: 'r', desc: true, render: (o) => h('span.inc-cell', h('b', H.hours(o.hours)), h('small', D.arrow(o.cmp_hours, o.prev_hours, { label: cap(word), d: 1, unit: ' giờ' }))) },
            { key: 'per_kit_day', label: 'Giờ/kit/ngày', align: 'r', desc: true, render: (o) => (o.per_kit_day === null ? '–' : H.pill(H.num(o.per_kit_day, 1), o.per_kit_day < std ? 'wait' : 'go')) },
            { key: 'quota_pct', label: 'Quota', align: 'r', desc: true, render: (o) => quotaCell(o, d) },
            { key: 'zero', label: 'Thẻ 0 giờ', align: 'r', desc: true, render: (o) => (o.zero ? H.pill(H.num(o.zero), 'wait') : '0') },
            { key: 'open_inc', label: 'Sự cố mở', align: 'r', desc: true, value: (o) => (inc.get(o.id) || {}).open_incidents || 0, render: (o) => { const n = (inc.get(o.id) || {}).open_incidents || 0; return n ? H.pill(H.num(n), 'lost') : '0'; } },
            { key: 'kits', label: 'Kit', align: 'r', desc: true },
          ].filter(Boolean),
        });
        return H.card('Tất cả BO', [
          h('div.h-tools.sale-bo', boChips, h('div.h-row', saleSel, H.search('Tìm BO, mã, khu vực…', (q) => { st.q = q; paintBo(); }, st.q))),
          boTbl,
        ], { sub: `${H.num(boRows.length)} BO · giờ ghi hình trong ${d.label} · bấm một dòng để mở BO` });
      }

      // Ô quota trong bảng: thanh + %; bấm để sửa (ai sửa được thì ô là nút).
      function quotaCell(o, d) {
        const kids = o.quota_hours ? [H.bar(Math.min(1, o.quota_pct / 100), o.quota_status === 'over' ? 'lost' : o.quota_status === 'near' ? 'wait' : null), h('b', H.pct(o.quota_pct, 0, true))] : [h('span', canQuota(d, o) ? 'Đặt quota' : 'chưa có')];
        const title = o.quota_hours ? `Đã dùng ${H.num(o.used_hours)}/${H.num(o.quota_hours)} giờ` : 'Chưa có quota giờ quay';
        if (!canQuota(d, o)) return h('span.sale-qc', { title, 'data-none': o.quota_hours ? null : '1' }, kids);
        return h('button.ghost.small.sale-qc', { type: 'button', title: `${title} · bấm để sửa`, 'aria-label': `Sửa quota ${o.name}. ${title}`, 'data-none': o.quota_hours ? null : '1', onclick: (e) => { e.stopPropagation(); editQuota(o, d.hos.eval.quota_warn_pct); } }, kids);
      }

      async function editQuota(o, warn) {
        const r = await H.form({
          title: `Quota giờ quay · ${o.name}`,
          intro: `Đã dùng ${H.hours(o.used_hours)} từ lần launch gần nhất${o.quota_from ? ` (${H.dmy(o.quota_from)})` : ''}${o.quota_hours ? `, ${H.pct(o.quota_pct, 0, true)} quota hiện tại` : ''}. Để trống nếu BO không giới hạn giờ quay.`,
          fields: [{ name: 'quota_hours', label: 'Quota (giờ)', type: 'number', value: o.quota_hours ?? '', min: 1, step: 1, hint: `Báo "sắp chạm" khi dùng từ ${H.num(warn)}% (đề xuất, Sale chốt trong Cài đặt).` }],
          submit: 'Lưu quota',
          onSubmit: async (v, c) => {
            if (v.quota_hours !== null && !(v.quota_hours > 0)) { c.setErr('Quota là số giờ lớn hơn 0, hoặc để trống.'); return false; }
            await ctx.api('PATCH', `/api/hub/outlets/${o.id}`, { quota_hours: v.quota_hours });
            return v;
          },
        });
        if (r) { ARL.toast(r.quota_hours === null ? `Đã bỏ quota của ${o.name}.` : `Đã lưu quota ${H.num(r.quota_hours)} giờ cho ${o.name}.`); load(); }
      }
    },
  });
})();
