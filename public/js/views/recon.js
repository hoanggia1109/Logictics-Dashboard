/* Ops Hub — Đối chiếu (#/recon, #/recon/<id>): những chỗ số liệu không khớp giữa các bên (BO báo khác FO, thiếu phụ kiện khi
   thu hồi, thẻ thiếu khi bàn giao, chênh lệch kiểm kho, dữ liệu nhập lệch…). Hệ thống không bao giờ tự sửa: Lead của team kiểm tra
   thực tế, sửa số ở màn hình liên quan nếu cần, rồi ghi cách đã xử lý (POST /api/hub/recon/:id/resolve). */
(() => {
  'use strict';
  const H = ARL.H, { h } = H;
  const SOURCE = { card_swap: 'Đổi thẻ', stock_check: 'Kiểm kho', bo_confirm: 'BO xác nhận giao nhận', deliver: 'Giao launch', acc_recover: 'Phụ kiện khi thu hồi', trip: 'Chuyến FO', handover: 'Bàn giao thẻ', import: 'Nhập dữ liệu', attendance: 'Chấm công', swap: 'Đổi kit hỏng', kit_adjust: 'Điều chỉnh kit ở ngoài', incident: 'Sự cố', card: 'Thẻ nhớ thiếu dung lượng', upload: 'Nhập dung lượng' };
  const LEVEL = { high: ['Cần xem ngay', 'lost'], mid: ['Trung bình', 'wait'], low: ['Thấp', 'off'] };
  const STATUS = { open: ['Chưa xử lý', 'wait'], resolved: ['Đã xử lý', 'go'], ignored: ['Bỏ qua', 'off'] };
  const LIVE_ROLES = ['admin', 'lead', 'logistic'];

  ARL.hub.view('recon', {
    mount(el, ctx) {
      const admin = ctx.role === 'admin';
      const q0 = ctx.query || {};
      const S = { st: ['open', 'done', 'all'].includes(q0.st) ? q0.st : 'open', lv: ['high', 'normal'].includes(q0.lv) ? q0.lv : '', team: admin && ['tech', 'logistics', 'sale'].includes(q0.team) ? q0.team : '', q: '' };
      let data = null, dlg = null;
      const teamName = (t) => (ARL.hubMeta && ARL.hubMeta.teams && ARL.hubMeta.teams[t]) || t;
      const sync = () => ctx.setQuery({ st: S.st === 'open' ? '' : S.st, lv: S.lv, team: S.team });
      const mine = !admin ? (ctx.role === 'sale_head' ? 'sale' : ctx.team) : null;

      el.append(
        H.head('Đối chiếu', mine ? `Các dòng của team ${teamName(mine)}.` : 'Các dòng của mọi team.'),
        h('p.h-note.recon-what', 'Đối chiếu là những chỗ số liệu không khớp giữa các bên (BO báo khác FO, thiếu phụ kiện khi thu hồi, thẻ thiếu khi bàn giao, chênh lệch kiểm kho…). Hệ thống không tự sửa: Lead của team kiểm tra thực tế, sửa ở màn hình liên quan nếu cần, rồi ghi cách đã xử lý ở đây.'));
      const teamChips = admin ? H.chips([{ key: '', label: 'Mọi team' }, { key: 'logistics', label: 'Logistics' }, { key: 'tech', label: 'Tech' }, { key: 'sale', label: 'Sale' }], S.team, (k) => { S.team = k; sync(); reload(); }) : null;
      const stSeg = H.seg([['open', 'Chưa xử lý'], ['done', 'Đã xử lý'], ['all', 'Tất cả']], S.st, (k) => { S.st = k; sync(); reload(); });
      const lvChips = H.chips([{ key: '', label: 'Mọi mức' }, { key: 'high', label: 'Cần xem ngay' }, { key: 'normal', label: 'Thường' }], S.lv, (k) => { S.lv = k; sync(); paint(); });
      const search = H.search('Tìm trong nội dung', (v) => { S.q = v; paint(); });
      el.append(h('div.h-tools.recon-tools', teamChips, stSeg, lvChips, search));

      const canView = (id) => { const v = ARL.hub.views.get(id); return !!(v && v.roles.includes(ctx.role)); };
      const canResolve = (r) => !!(data && data.can_resolve) && r.status === 'open' && ctx.isLead(r.team);
      /** Liên kết tới đối tượng liên quan (việc, kit, BO, phiếu…) — chỉ hiện khi vai trò mở được màn hình đó. */
      function links(r) {
        const d = r.data || {}, out = [], seen = new Set();
        const add = (label, link) => { if (!link || seen.has(link)) return; seen.add(link); const href = ctx.linkTo(link); if (href) out.push(H.link(href, label)); };
        if (Array.isArray(d.jobs) && d.jobs.length) d.jobs.forEach((id, i) => add(`Mở việc ${(d.job_codes || [])[i] || ''}`.trim(), `job:${id}`));
        else if (d.job_id) add('Mở việc', `job:${d.job_id}`);
        if (d.kit_id) add('Mở kit', `kit:${d.kit_id}`);
        if (d.site_id) add('Mở BO', `outlet:${d.site_id}`);
        if (d.card_id) add('Mở thẻ', `card:${d.card_id}`);
        if (Array.isArray(d.record_ids)) d.record_ids.slice(0, 6).forEach((id, i) => add(`Mở bản ghi ${(d.codes && d.codes[i]) || i + 1}`, `record:${id}`)); // bản ghi dung lượng chưa rõ BO
        const ref = String(r.ref || '');
        const pick = (re) => { const m = re.exec(ref); return m ? m[1] : null; };
        if (r.entity === 'kit') { const id = pick(/(?:^|:)kit:(\d+)(?::|$)/) || pick(/^accshort:(\d+):/); if (id) add('Mở kit', `kit:${id}`); }
        if (r.entity === 'outlet') { const id = pick(/(?:^|:)bo:(\d+)(?::|$)/); if (id) add('Mở BO', `outlet:${id}`); }
        if (r.entity === 'card') { const id = pick(/(?:^|:)card:(\d+)(?::|$)/); if (id) add('Mở thẻ', `card:${id}`); }
        if (r.entity === 'handover') { const id = pick(/^ho:(\d+)/); if (id) add('Mở phiếu bàn giao', `handover:${id}`); }
        if (r.entity === 'user') { const id = pick(/(?:^|:)user:(\d+)(?::|$)/); if (id) add('Mở tài khoản', `user:${id}`); }
        if (r.entity === 'acc' && canView('acc')) out.push(H.link('#/acc', 'Phụ kiện'));
        if (r.entity === 'stock' && canView('kits')) out.push(H.link('#/kits', 'Kit & thiết bị'));
        if (d.task_id && ctx.can(LIVE_ROLES)) out.push(H.link('#/live', 'Chuyến trên Rider Live'));
        // Bấm link trong bảng: đi tới đối tượng, không mở chi tiết dòng.
        for (const a of out) a.addEventListener('click', (e) => e.stopPropagation());
        return out;
      }
      const lvPill = (r) => { const [l, t] = LEVEL[r.level] || [r.level, 'off']; return H.pill(l, t); };
      const stPill = (r) => { const [l, t] = STATUS[r.status] || [r.status, 'off']; return H.pill(l, t); };
      const table = H.table({
        columns: [
          { key: 'ts', label: 'Lúc', value: (r) => r.ts, render: (r) => H.when(r.ts), nowrap: true, desc: true },
          { key: 'level', label: 'Mức', value: (r) => ({ high: 0, mid: 1, low: 2 }[r.level] ?? 3), render: lvPill },
          { key: 'text', label: 'Nội dung', render: (r) => h('div.recon-text', h('span', r.text), h('small', [SOURCE[r.source] || r.source, admin ? teamName(r.team) : null].filter(Boolean).join(' · ')), (() => { const ls = links(r); return ls.length ? h('span.recon-links', ls) : null; })()) },
          { key: 'status', label: 'Trạng thái', value: (r) => r.status, render: (r) => h('div.recon-st', stPill(r), r.status !== 'open' && (r.resolved_by || r.note) ? h('small', [r.resolved_by, r.note].filter(Boolean).join(': ')) : null, canResolve(r) ? H.btn('Ghi cách xử lý', (e) => { e.stopPropagation(); resolve(r); }, 'small') : null) },
        ],
        rows: [], pageSize: 50, sort: { key: 'ts', dir: -1 }, onRow: (r) => ctx.setParams([r.id]),
        rowTone: (r) => (r.status === 'open' && r.level === 'high' ? 'lost' : null),
        empty: 'Không có dòng nào. Số liệu đang khớp.',
      });
      const body = h('div', H.loading(5));
      el.append(body);

      function rows() {
        let list = (data && data.items) || [];
        if (S.lv === 'high') list = list.filter((r) => r.level === 'high');
        if (S.lv === 'normal') list = list.filter((r) => r.level !== 'high');
        if (S.q) list = list.filter((r) => H.match(`${r.text} ${r.note || ''} ${SOURCE[r.source] || ''}`, S.q));
        return list;
      }
      function paint() {
        if (!data) return;
        const all = data.items || [];
        lvChips.counts({ '': all.length, high: all.filter((r) => r.level === 'high').length, normal: all.filter((r) => r.level !== 'high').length });
        if (teamChips) teamChips.counts({ '': Object.values(data.counts || {}).reduce((a, b) => a + b, 0), logistics: (data.counts || {}).logistics || 0, tech: (data.counts || {}).tech || 0, sale: (data.counts || {}).sale || 0 });
        if (!body.contains(table)) body.replaceChildren(table);
        table.update(rows());
      }
      let gen = 0;
      async function reload() {
        const my = ++gen;
        try {
          const r = await ctx.api('GET', '/api/hub/recon', null, Object.fromEntries(Object.entries({ status: S.st === 'open' ? '' : S.st, team: S.team }).filter(([, v]) => v)));
          if (my !== gen || !ctx.alive()) return;
          data = r;
          paint();
          openParam();
        } catch (e) { if (!data) body.replaceChildren(H.error(e, reload)); else ARL.toast(e.message, true); }
      }

      // ── Chi tiết / ghi cách xử lý ──
      async function resolve(r, onDone) {
        let status = 'resolved';
        const seg = H.seg([['resolved', 'Đã xử lý'], ['ignored', 'Bỏ qua (không cần xử lý)']], status, (k) => { status = k; });
        const res = await H.form({
          title: 'Ghi cách xử lý', submit: 'Lưu',
          intro: h('div.h-stack', h('p', r.text), h('div.h-row', h('b', 'Kết luận'), seg)),
          fields: [{ name: 'note', label: 'Đã kiểm tra / xử lý thế nào', type: 'textarea', required: true, rows: 3, placeholder: 'Ví dụ: gọi BO xác nhận, thực tế thu 3 thẻ; đã sửa số ở mục Thẻ.' }],
          onSubmit: async (v, c) => {
            if (v.note.length < 3) { c.setErr('Ghi rõ hơn một chút (ít nhất 3 ký tự).'); return false; }
            await ctx.api('POST', `/api/hub/recon/${r.id}/resolve`, { note: v.note, status });
            return true;
          },
        });
        if (res) { ARL.toast(status === 'ignored' ? 'Đã ghi bỏ qua.' : 'Đã ghi cách xử lý.'); reload(); if (onDone) onDone(); }
      }
      function openDetail(r) {
        const [lv] = LEVEL[r.level] || [r.level];
        const L = links(r);
        const content = h('div.h-stack',
          h('div.h-row', lvPill(r), stPill(r), H.pill(SOURCE[r.source] || r.source, 'off')),
          h('p.recon-full', r.text),
          H.dl([
            ['Lúc ghi', H.when(r.ts)], ['Team duyệt', teamName(r.team)], ['Mức', lv],
            ['Liên quan', L.length ? h('span.recon-links', L) : null],
            ['Mã liên quan', r.data && Array.isArray(r.data.codes) && r.data.codes.length ? r.data.codes.join(', ') : null],
            ['Người xử lý', r.resolved_by || null], ['Xử lý lúc', r.resolved_at ? H.when(r.resolved_at) : null], ['Ghi chú xử lý', r.note || null],
          ]),
          r.status === 'open' && Array.isArray((r.data || {}).jobs) && String(r.ref || '').startsWith('count:') ? H.note('Việc liên quan đang được giữ lại: Logistic Lead đối chiếu với FO và BO, rồi mở từng việc và báo xong theo mã kit / thẻ thực tế. Xong hết thì dòng này tự đóng.', 'wait') : null,
          r.status === 'open' && !canResolve(r) ? H.note(`Dòng này do Lead của team ${teamName(r.team)} duyệt.`) : null);
        const actions = [{ label: 'Đóng', cls: 'ghost', run: () => {} }];
        if (canResolve(r)) actions.push({ label: 'Ghi cách xử lý', cls: 'primary', run: () => { setTimeout(() => resolve(r), 0); } });
        dlg = ARL.modal({ title: 'Dòng đối chiếu', body: content, actions, onClose: () => { dlg = null; if (ctx.alive() && ctx.params[0]) ctx.setParams([]); } });
      }
      function openParam() {
        const id = ctx.params[0];
        if (!id || dlg || !data) return;
        const r = (data.items || []).find((x) => String(x.id) === String(id));
        if (r) { openDetail(r); return; }
        // Dòng không nằm trong bộ lọc đang xem (ví dụ đã xử lý): tải mọi trạng thái rồi tìm lại.
        if (S.st !== 'all') { S.st = 'all'; stSeg.set('all'); sync(); reload(); return; }
        ARL.toast('Không tìm thấy dòng đối chiếu này (có thể thuộc team khác).', true);
        ctx.setParams([]);
      }
      ctx.onRoute(() => { if (!ctx.params[0]) { if (dlg) { const d = dlg; dlg = null; d.close(); } } else openParam(); });
      ctx.live(['recon'], reload);
      reload();
    },
  });
})();
