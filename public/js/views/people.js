/* Ops Hub — Đội nhóm: Phân ca (roster), Chấm công (attendance), Tài khoản (accounts).
   Máy chủ quyết định quyền và mọi con số; màn hình chỉ hiện đúng thứ vai trò đó dùng được. */
(() => {
  'use strict';
  const H = ARL.H, { h } = H;
  const addDays = ARL.addDays;
  const DOW = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
  const LEADS = ['admin', 'tech_lead', 'lead'];
  const TEAM_NAME = { tech: 'Tech', logistics: 'Logistics' };

  // ───────────── Ngày, tuần (ISO, thứ Hai → Chủ nhật, như máy chủ) ─────────────
  const utc = (s) => new Date(s + 'T00:00:00Z');
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(utc(s).getTime());
  const wd = (s) => (utc(s).getUTCDay() + 6) % 7; // 0 = thứ Hai
  const mondayOf = (s) => addDays(s, -wd(s));
  function weekKey(s) {
    const dt = utc(s), th = new Date(dt.getTime() + (3 - wd(s)) * 86400000), y = th.getUTCFullYear();
    return `${y}-W${String(1 + Math.floor((th - Date.UTC(y, 0, 1)) / 86400000 / 7)).padStart(2, '0')}`;
  }
  function weekFrom(key) {
    const m = /^(\d{4})-W(\d{2})$/.exec(String(key || ''));
    if (!m) return null;
    const jan4 = new Date(Date.UTC(+m[1], 0, 4)), mon1 = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000);
    const from = new Date(mon1.getTime() + (+m[2] - 1) * 7 * 86400000).toISOString().slice(0, 10);
    return weekKey(from) === key ? from : null;
  }
  const weekOf = (v) => (weekFrom(v) ? v : isDate(v) ? weekKey(v) : null);
  const shiftWeek = (key, n) => weekKey(addDays(weekFrom(key), 7 * n));
  const ddmm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  const dowOf = (d) => DOW[wd(d)];
  const daysFrom = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, i));
  const weekName = (key) => `Tuần ${+key.slice(6)}`;
  const weekSpan = (key) => { const f = weekFrom(key); return `${ddmm(f)} – ${ddmm(addDays(f, 6))}`; };
  const monthOk = (k) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(k || ''));
  const monthRange = (k) => { const [y, m] = k.split('-').map(Number); return { from: `${k}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) }; };
  const shiftMonth = (k, n) => { const [y, m] = k.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
  const monthName = (k) => `Tháng ${+k.slice(5)}/${k.slice(0, 4)}`;
  const nowHM = () => H.time(ARL.now());
  const isHM = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));

  // ───────────── Ca ─────────────
  /** Chữ mô tả một dòng ca: "HC · 08:30–17:30", "Nghỉ phép", "Cả ngày". */
  const timeOf = (r) => (r.start ? `${r.start}–${r.end}` : 'Cả ngày');
  const shiftText = (r) => (r.kind === 'leave' ? 'Nghỉ phép' : r.kind === 'off' ? 'Không có ca' : `${r.shift ? r.shift + ' · ' : ''}${timeOf(r)}`);
  const covers = (r, hm) => r && r.kind !== 'leave' && (!r.start || (hm >= r.start && hm <= r.end));
  /** Ô hiển thị một ca. */
  function shiftChip(r, shifts, draft) {
    if (r.kind === 'off') return h('span.ros-sh.is-off', { 'data-draft': draft ? '1' : null }, h('b', 'Xoá ca'));
    if (r.kind === 'leave') return h('span.ros-sh.is-leave', { 'data-draft': draft ? '1' : null }, h('b', 'Nghỉ phép'));
    let start = r.start, end = r.end;
    if (r.shift && !start) { const s = shifts.find((x) => x.id === r.shift); if (s) ({ start, end } = s); }
    const i = r.shift ? shifts.findIndex((x) => x.id === r.shift) : -1;
    return h('span.ros-sh', { 'data-c': i >= 0 ? String(i % 6) : 'x', 'data-draft': draft ? '1' : null }, h('b', r.shift || (start ? 'Giờ riêng' : 'Cả ngày')), start ? h('small', `${start}–${end}`) : null);
  }

  /**
   * Bộ chọn ca trong hộp thoại: ca mẫu, giờ riêng, nghỉ phép, (Lead) không có ca.
   * Trả về { el, value() } — value() ném lỗi tiếng Việt khi giờ nhập chưa đúng.
   */
  function shiftPicker(shifts, init, opt = {}) {
    const name = 'sp' + Math.random().toString(36).slice(2, 8);
    let cur = 'tpl:' + ((shifts[0] || {}).id || '');
    if (init) {
      if (init.kind === 'leave') cur = 'leave';
      else if (init.shift && shifts.some((s) => s.id === init.shift)) cur = 'tpl:' + init.shift;
      else if (init.start) cur = 'custom';
    }
    const start = h('input', { type: 'time', value: init && !init.shift && init.start ? init.start : '', 'aria-label': 'Giờ vào', step: 300 });
    const end = h('input', { type: 'time', value: init && !init.shift && init.end ? init.end : '', 'aria-label': 'Giờ ra', step: 300 });
    const times = h('div.ros-times', h('label', h('span', 'Giờ vào'), start), h('label', h('span', 'Giờ ra'), end));
    const opts = [
      ...shifts.map((s, i) => ['tpl:' + s.id, h('span.ros-opt', h('span.ros-sh', { 'data-c': String(i % 6) }, h('b', s.id)), h('span', s.name, h('small', `${s.start}–${s.end}`)))]),
      ['custom', h('span.ros-opt', h('span.ros-sh', { 'data-c': 'x' }, h('b', 'Giờ riêng')), h('span', 'Nhập giờ vào và giờ ra'))],
      ['leave', h('span.ros-opt', h('span.ros-sh.is-leave', h('b', 'Nghỉ phép')), h('span', opt.leaveHint || 'Xin nghỉ cả ngày'))],
      opt.allowOff ? ['off', h('span.ros-opt', h('span.ros-sh.is-off', h('b', 'Không có ca')), h('span', 'Xoá ca của ngày này'))] : null,
    ].filter(Boolean);
    const box = h('fieldset.ros-pick', h('legend', opt.legend || 'Ca làm'),
      opts.map(([v, lab]) => h('label.ros-pick-it', h('input', { type: 'radio', name, value: v, checked: v === cur, onchange: () => { cur = v; sync(); } }), lab)), times);
    const sync = () => { times.hidden = cur !== 'custom'; };
    sync();
    return {
      el: box,
      value() {
        if (cur === 'leave') return { kind: 'leave' };
        if (cur === 'off') return { kind: 'off' };
        if (cur === 'custom') {
          if (!isHM(start.value) || !isHM(end.value)) throw new Error('Nhập đủ giờ vào và giờ ra (GG:PP).');
          if (end.value <= start.value) throw new Error('Giờ ra phải sau giờ vào (chưa hỗ trợ ca qua đêm).');
          return { start: start.value, end: end.value };
        }
        return { shift: cur.slice(4) };
      },
    };
  }

  // ═════════════════════════════ PHÂN CA ═════════════════════════════
  ARL.hub.view('roster', {
    mount(el, ctx) {
      const role = ctx.role, me = ctx.user.id;
      const isAdmin = role === 'admin';
      const isLead = LEADS.includes(role);
      const member = role === 'tech' || role === 'logistic'; // nhân viên tự đăng ký ca, Lead duyệt
      const S = {
        week: weekOf(ctx.params[0]) || weekOf(ctx.query.w) || weekKey(H.today()),
        team: isAdmin ? (ctx.query.team === 'logistics' ? 'logistics' : 'tech') : ctx.team,
        data: null, pend: [], pendUsers: new Map(), brush: null, quick: false, draft: new Map(), day: null, idx: new Map(), att: new Map(),
      };

      // ── Khung trang ──
      const regBtn = member ? H.btn('Đăng ký ca', () => registerDialog([]), 'primary') : null;
      const quickBtn = isLead ? h('button', { type: 'button', 'aria-pressed': 'false', title: 'Chọn một ca rồi bấm vào nhiều ô để xếp nhanh', onclick: () => { S.quick = !S.quick; if (!S.quick) S.brush = null; paintBrush(); paintBody(); } }, 'Xếp nhanh') : null;
      const copyBtn = isLead ? H.btn('Chép tuần trước', () => copyWeek()) : null;
      const head = H.head('Phân ca', ' ', regBtn, quickBtn, copyBtn);
      const subEl = head.querySelector('.sub');
      const teamSeg = isAdmin ? H.seg([['tech', 'Tech'], ['logistics', 'Logistics']], S.team, (t) => { S.team = t; ctx.setQuery({ team: t === 'tech' ? '' : t }); load(true); }) : null;
      const weekLbl = h('b.ros-wk');
      const nav = h('div.ros-nav', { role: 'group', 'aria-label': 'Chọn tuần' },
        h('button.ghost', { type: 'button', 'aria-label': 'Tuần trước', onclick: () => goWeek(shiftWeek(S.week, -1)) }, '‹'),
        weekLbl,
        h('button.ghost', { type: 'button', 'aria-label': 'Tuần sau', onclick: () => goWeek(shiftWeek(S.week, 1)) }, '›'));
      const todayBtn = h('button.small', { type: 'button', onclick: () => goWeek(weekKey(H.today())) }, 'Tuần này');
      const tools = h('div.h-tools', teamSeg, nav, todayBtn);
      const brushBox = h('div.ros-brush', { hidden: true, role: 'group', 'aria-label': 'Chọn ca để xếp nhanh' });
      const explain = h('div.ros-explain');
      const pendBox = h('div.ros-pend');
      const mineBox = h('div');
      const gridBox = h('div.ros-gridbox', H.loading(5));
      const dayBox = h('div.ros-daybox');
      const legend = h('div.ros-legend');
      const saveBar = h('div.ros-save', { hidden: true, role: 'region', 'aria-label': 'Ô chưa lưu' });
      el.append(head, tools, brushBox, explain, pendBox, mineBox, gridBox, dayBox, legend, saveBar);

      function goWeek(k) {
        if (!k || k === S.week) return;
        S.week = k; S.day = null;
        ctx.setQuery({ w: k === weekKey(H.today()) ? '' : k });
        load(true);
      }

      // ── Dữ liệu ──
      let gen = 0;
      async function load(soft) {
        const my = ++gen;
        const from = weekFrom(S.week), to = addDays(from, 6);
        const q = { from, to };
        if (isAdmin) q.team = S.team;
        if (soft && S.data) gridBox.classList.add('is-busy');
        const pq = { from: addDays(H.today(), -14), to: addDays(H.today(), 48) };
        if (isAdmin) pq.team = S.team;
        try {
          const [d, p] = await Promise.all([ctx.api('GET', '/api/hub/roster', null, q), isLead ? ctx.api('GET', '/api/hub/roster', null, pq) : null]);
          if (my !== gen || !ctx.alive()) return;
          S.data = d;
          S.idx = new Map(d.rows.map((r) => [r.id, r]));
          S.att = new Map(d.attendance.map((a) => [`${a.user_id}:${a.date}`, a]));
          if (p) { S.pend = p.rows.filter((r) => r.status === 'pending').sort((a, b) => a.date.localeCompare(b.date)); S.pendUsers = new Map(p.users.map((u) => [u.id, u])); ctx.badge('roster', S.pend.length, 'wait'); }
          paint();
        } catch (e) {
          if (my !== gen || !ctx.alive()) return;
          if (!S.data) gridBox.replaceChildren(H.error(e, () => load()));
          else ARL.toast(e.message, true);
        } finally { gridBox.classList.remove('is-busy'); }
      }

      // ── Vẽ ──
      function paint() {
        const d = S.data;
        subEl.textContent = `${TEAM_NAME[d.team] || ''} · ${weekName(S.week)} (${weekSpan(S.week)})`;
        weekLbl.textContent = `${weekName(S.week)} · ${weekSpan(S.week)}`;
        todayBtn.hidden = S.week === weekKey(H.today());
        H.clear(explain, H.note([
          h('b', 'Việc tự sinh chỉ giao cho người đang trong ca.'), ' ',
          'Người trong ca là người có ca đã duyệt hôm nay, đang trong giờ ca và đã mở ứng dụng. Không có ca đã duyệt thì không được giao việc tự động và mở ứng dụng không thành ngày công (Lead vẫn sửa chấm công được).',
          d.team === 'logistics' ? ' FO không nằm trong bảng này: FO mở ca trên ứng dụng điện thoại.' : '',
        ]));
        paintBrush(); paintPend(); paintMine(); paintBody(); paintLegend();
      }
      function users() {
        const list = [...S.data.users];
        const self = list.findIndex((u) => u.id === me);
        if (self > 0) list.unshift(list.splice(self, 1)[0]);
        return list;
      }
      const approved = (uid, dt) => S.idx.get(`${uid}:${dt}`) || null;
      const request = (uid, dt) => S.idx.get(`req:${uid}:${dt}`) || null;
      const canEdit = (u, dt) => S.data.lead || (member && u.id === me && dt >= H.today());
      function cellKids(u, dt) {
        const k = `${u.id}:${dt}`, main = approved(u.id, dt), req = request(u.id, dt), dr = S.draft.get(k), a = S.att.get(k), shifts = S.data.shifts;
        const kids = [];
        if (dr) kids.push(shiftChip(dr, shifts, true));
        else if (main) kids.push(shiftChip(main, shifts));
        if (req && (req.status === 'pending' || (req.status === 'rejected' && u.id === me))) {
          kids.push(h('span.ros-req', { 'data-st': req.status, title: req.note || null }, req.status === 'pending' ? 'Chờ duyệt: ' : 'Không duyệt: ', shiftText(req)));
        }
        if (!kids.length) kids.push(h('span.ros-none', { 'aria-hidden': 'true' }, canEdit(u, dt) ? '+' : '–'));
        if (a && dt <= H.today()) kids.push(h('i.ros-att', { 'data-st': a.status, title: `Chấm công: ${a.status_label}${a.checkin_at ? ' lúc ' + H.time(a.checkin_at) : ''}` }));
        return kids;
      }
      function describe(u, dt) {
        const main = approved(u.id, dt), req = request(u.id, dt);
        return `${u.name}, ${dowOf(dt)} ${ddmm(dt)}: ${main ? shiftText(main) : 'chưa có ca'}${req && req.status === 'pending' ? `, chờ duyệt ${shiftText(req)}` : ''}`;
      }
      function cell(u, dt) {
        const main = approved(u.id, dt);
        const now = dt === H.today() && covers(main, nowHM()) && !S.draft.has(`${u.id}:${dt}`);
        const cls = `ros-cell${now ? ' is-now' : ''}`;
        if (!canEdit(u, dt)) return h(`div.${cls.replace(' ', '.')}`, { title: describe(u, dt) }, cellKids(u, dt));
        return h(`button.${cls.replace(' ', '.')}`, { type: 'button', 'data-u': u.id, 'data-d': dt, 'aria-label': describe(u, dt), onclick: () => onCell(u, dt) }, cellKids(u, dt));
      }
      function who(u) {
        const on = (S.data.on_shift || []).includes(u.id);
        return h('span.ros-who-in', h('b', u.name, u.id === me ? h('small.ros-me', ' (bạn)') : null), h('small', u.role_label),
          on ? h('span.ros-on', { title: 'Đang trong ca: việc tự sinh có thể giao cho người này' }, 'Đang trong ca') : null);
      }
      function coverage(dt) {
        const list = S.data.users.map((u) => approved(u.id, dt)).filter((r) => r && r.kind !== 'leave');
        const by = {};
        for (const r of list) { const k = r.shift || 'Khác'; by[k] = (by[k] || 0) + 1; }
        const pend = S.data.lead ? S.data.users.filter((u) => { const r = request(u.id, dt); return r && r.status === 'pending'; }).length : 0;
        return { n: list.length, by, pend };
      }
      function paintBody() {
        const d = S.data, dates = daysFrom(d.from, 7), today = H.today(), list = users();
        quickBtn && quickBtn.setAttribute('aria-pressed', String(S.quick));
        // Bảng tuần (màn hình rộng)
        const thead = h('thead', h('tr', h('th.ros-who', { scope: 'col' }, 'Nhân sự'),
          dates.map((dt) => h('th', { scope: 'col', class: dt === today ? 'is-today' : null }, h('span', dowOf(dt)), h('small', dt === today ? 'Hôm nay' : ddmm(dt))))));
        const tbody = h('tbody', list.length ? list.map((u) => h('tr', { class: [(d.on_shift || []).includes(u.id) ? 'is-on' : '', u.id === me ? 'is-me' : ''].join(' ').trim() || null },
          h('th.ros-who', { scope: 'row' }, who(u)),
          dates.map((dt) => h('td', { class: dt === today ? 'is-today' : null }, cell(u, dt))))) : h('tr', h('td', { colspan: 8 }, H.empty('Team chưa có thành viên đang hoạt động.'))));
        const tfoot = h('tfoot', h('tr', h('th.ros-who', { scope: 'row' }, 'Số người có ca'),
          dates.map((dt) => { const c = coverage(dt); return h('td', { class: dt === today ? 'is-today' : null }, h('span.ros-cov', { 'data-tone': c.n ? null : 'lost' }, h('b', c.n ? `${c.n} người` : 'Chưa xếp'), Object.keys(c.by).length ? h('small', Object.entries(c.by).map(([k, n]) => `${k} ${n}`).join(' · ')) : null, c.pend ? h('small.ros-cov-p', `+${c.pend} chờ duyệt`) : null)); })));
        gridBox.replaceChildren(h('div.ros-scroll', h('table.ros-grid', { 'data-quick': S.quick ? '1' : null }, thead, tbody, tfoot)));
        // Danh sách theo ngày (điện thoại)
        if (!S.day || !dates.includes(S.day)) S.day = dates.includes(today) ? today : dates[0];
        const chips = h('div.ros-dchips', { role: 'tablist', 'aria-label': 'Chọn ngày' }, dates.map((dt) => {
          const c = coverage(dt);
          return h('button', { type: 'button', role: 'tab', 'aria-selected': String(dt === S.day), class: dt === today ? 'is-today' : null, onclick: () => { S.day = dt; paintBody(); } },
            h('span', dowOf(dt)), h('b', ddmm(dt)), h('small', { 'data-tone': c.n ? null : 'lost' }, c.n ? `${c.n} người` : 'Chưa xếp'));
        }));
        const dl = h('div.ros-dlist', list.map((u) => h('div.ros-ditem', { class: (d.on_shift || []).includes(u.id) && S.day === today ? 'is-on' : null }, who(u), cell(u, S.day))));
        dayBox.replaceChildren(chips, h('p.sub.ros-dhead', `${dowOf(S.day)} ${H.dmy(S.day)}${S.day === today ? ' · hôm nay' : ''}`), dl);
        paintSave();
      }
      function paintLegend() {
        const shifts = S.data.shifts;
        H.clear(legend,
          shifts.map((s, i) => h('span.ros-leg', h('span.ros-sh', { 'data-c': String(i % 6) }, h('b', s.id)), `${s.name} ${s.start}–${s.end}`)),
          h('span.ros-leg', h('span.ros-sh.is-leave', h('b', 'Nghỉ phép'))),
          h('span.ros-leg', h('span.ros-req', { 'data-st': 'pending' }, 'Chờ duyệt'), 'Nhân viên đăng ký, chờ Lead'),
          h('span.ros-leg', h('i.ros-att', { 'data-st': 'present' }), 'Đã vào ca'),
          h('span.ros-leg', h('i.ros-att', { 'data-st': 'late' }), 'Vào trễ'),
          h('span.ros-leg', h('i.ros-att', { 'data-st': 'absent' }), 'Vắng'));
      }
      function paintBrush() {
        brushBox.hidden = !(isLead && S.quick && S.data);
        if (brushBox.hidden) return;
        const opts = [...S.data.shifts.map((s, i) => [{ shift: s.id }, h('span.ros-sh', { 'data-c': String(i % 6) }, h('b', s.id), h('small', `${s.start}–${s.end}`))]),
          [{ kind: 'leave' }, h('span.ros-sh.is-leave', h('b', 'Nghỉ phép'))], [{ kind: 'off' }, h('span.ros-sh.is-off', h('b', 'Xoá ca'))]];
        const same = (a, b) => !!a && !!b && a.shift === b.shift && a.kind === b.kind;
        brushBox.replaceChildren(h('span.sub', S.brush ? 'Bấm vào ô để xếp, bấm lại để bỏ.' : 'Chọn ca rồi bấm vào các ô:'),
          ...opts.map(([v, lab]) => h('button', { type: 'button', class: 'ros-brush-b', 'aria-pressed': String(same(S.brush, v)), onclick: () => { S.brush = same(S.brush, v) ? null : v; paintBrush(); } }, lab)),
          h('button.ghost.small', { type: 'button', onclick: () => { S.quick = false; S.brush = null; paintBrush(); paintBody(); } }, 'Xong'));
      }
      function paintSave() {
        const n = S.draft.size;
        saveBar.hidden = !n;
        if (!n) return;
        saveBar.replaceChildren(h('span', h('b', `${n} ô chưa lưu`), h('small', ' — chỉ có hiệu lực sau khi lưu')),
          H.btn('Bỏ', () => { S.draft.clear(); paintBody(); }, 'ghost'),
          H.btn(`Lưu ${n} ô`, saveDraft, 'primary'));
      }
      function paintPend() {
        if (!isLead || !S.pend.length) { pendBox.replaceChildren(); return; }
        const shifts = S.data.shifts;
        const nameOf = (r) => (S.pendUsers.get(r.user_id) || { name: '#' + r.user_id }).name;
        const tbl = H.table({
          columns: [
            { key: 'who', label: 'Nhân sự', value: nameOf, render: (r) => h('span', h('b', nameOf(r)), h('small', (S.pendUsers.get(r.user_id) || {}).role_label || '')) },
            { key: 'date', label: 'Ngày', render: (r) => h('span', `${dowOf(r.date)} ${ddmm(r.date)}`, h('small', weekName(weekKey(r.date)))) },
            { key: 'shift', label: 'Đăng ký', value: (r) => shiftText(r), render: (r) => shiftChip(r, shifts) },
            { key: 'note', label: 'Ghi chú', render: (r) => r.note || '' },
            { key: 'act', label: '', sort: false, render: (r) => h('span.h-row.ros-pend-act', H.btn('Duyệt', () => review([r.id], true), 'small primary'), H.btn('Không duyệt', () => review([r.id], false), 'small ghost danger')) },
          ],
          rows: S.pend, select: true, pageSize: 20, id: (r) => r.id, sort: { key: 'date', dir: 1 },
          onSelect: (sel) => { bulkA.disabled = bulkR.disabled = !sel.length; bulkA.textContent = sel.length ? `Duyệt ${sel.length} yêu cầu` : 'Duyệt đã chọn'; },
        });
        const bulkA = H.btn('Duyệt đã chọn', () => review(tbl.selected().map((r) => r.id), true), 'small primary', { disabled: true });
        const bulkR = H.btn('Không duyệt', () => review(tbl.selected().map((r) => r.id), false), 'small ghost danger', { disabled: true });
        pendBox.replaceChildren(H.card(`Chờ duyệt (${S.pend.length})`, tbl, { tone: 'wait', sub: 'Ca nhân viên tự đăng ký. Duyệt xong mới có hiệu lực và mới được giao việc tự sinh.', actions: [bulkR, bulkA] }));
      }
      function paintMine() {
        if (!member || !S.data) { mineBox.replaceChildren(); return; }
        const mine = S.data.rows.filter((r) => r.user_id === me && r.id.startsWith('req:')).sort((a, b) => a.date.localeCompare(b.date));
        if (!mine.length) { mineBox.replaceChildren(); return; }
        mineBox.replaceChildren(H.card('Đăng ký của bạn tuần này', h('div.h-list', mine.map((r) => h('div.h-item', { 'data-tone': r.status === 'pending' ? 'wait' : 'lost' },
          h('span.h-item-t', `${dowOf(r.date)} ${ddmm(r.date)} · ${shiftText(r)}`),
          h('span.h-item-m', r.status === 'pending' ? 'Đang chờ Lead duyệt' : `Lead không duyệt${r.by ? ` (${r.by})` : ''}${r.note ? ': ' + r.note : ''}`),
          h('span.h-item-r', H.pill(r.status === 'pending' ? 'Chờ duyệt' : 'Không duyệt', r.status === 'pending' ? 'wait' : 'lost')))))));
      }

      // ── Thao tác ──
      function onCell(u, dt) {
        if (S.data.lead && S.quick) {
          if (!S.brush) { ARL.toast('Chọn một ca ở thanh phía trên trước.'); return; }
          const k = `${u.id}:${dt}`, cur = S.draft.get(k);
          if (cur && cur.shift === S.brush.shift && cur.kind === S.brush.kind) S.draft.delete(k); else S.draft.set(k, { ...S.brush });
          paintBody();
          const again = el.querySelector(`.ros-cell[data-u="${u.id}"][data-d="${dt}"]`);
          if (again && again.offsetParent) again.focus();
          return;
        }
        if (S.data.lead) return leadCell(u, dt);
        if (member && u.id === me) return registerDialog([dt]);
      }
      async function saveDraft() {
        const rows = [...S.draft.entries()].map(([k, v]) => { const [uid, date] = k.split(':'); return { user_id: +uid, date, ...v }; });
        const r = await ctx.api('PUT', '/api/hub/roster', { rows });
        S.draft.clear();
        ARL.toast(`Đã lưu ${r.count} ô trong bảng ca.`);
        await load(true);
      }
      async function review(ids, approve) {
        if (!ids.length) return;
        let note = '';
        if (!approve) {
          const v = await H.form({ title: ids.length > 1 ? `Không duyệt ${ids.length} yêu cầu` : 'Không duyệt yêu cầu ca', intro: 'Nhân viên nhận thông báo kèm lý do bạn ghi (không bắt buộc).', submit: 'Không duyệt', danger: true, fields: [{ name: 'note', label: 'Lý do', type: 'textarea', rows: 2, placeholder: 'VD: ngày này đã đủ người' }], onSubmit: (x) => x });
          if (!v) return;
          note = v.note;
        }
        await ctx.api('POST', '/api/hub/roster/review', { ids, approve, note: note || undefined });
        ARL.toast(approve ? `Đã duyệt ${ids.length} yêu cầu.` : `Đã báo không duyệt ${ids.length} yêu cầu.`);
        await load(true);
      }
      function leadCell(u, dt) {
        const main = approved(u.id, dt), req = request(u.id, dt);
        const picker = shiftPicker(S.data.shifts, S.draft.get(`${u.id}:${dt}`) || main || (req && req.status === 'pending' ? req : null), { allowOff: !!main, leaveHint: 'Nghỉ cả ngày (tự ghi vào chấm công)' });
        const note = H.field({ name: 'note', label: 'Ghi chú', value: (main && main.note) || '', placeholder: 'Không bắt buộc', full: true });
        let m = null;
        const reqBox = req && req.status === 'pending' ? h('div.ros-reqbox',
          h('p', h('b', `${u.name} đăng ký: `), shiftText(req), req.note ? h('span.sub', ` · ${req.note}`) : null),
          h('div.h-row', H.btn('Duyệt yêu cầu', async () => { await review([req.id], true); m.close(); }, 'primary small'), H.btn('Không duyệt', async () => { m.close(); await review([req.id], false); }, 'ghost danger small'))) : null;
        m = ARL.modal({
          title: `${u.name} · ${dowOf(dt)} ${H.dmy(dt)}`,
          body: h('div.h-form', reqBox, main ? h('p.sub', `Đang xếp: ${shiftText(main)}${main.by ? ` (xếp bởi ${main.by})` : ''}`) : h('p.sub', 'Chưa có ca ngày này.'), picker.el, note),
          actions: [
            { label: 'Thôi', cls: 'ghost', run: () => {} },
            { label: 'Lưu ca', cls: 'primary', run: async () => {
              const v = picker.value();
              const r = await ctx.api('PUT', '/api/hub/roster', { rows: [{ user_id: u.id, date: dt, ...v, note: note.querySelector('input').value.trim() }] });
              S.draft.delete(`${u.id}:${dt}`);
              ARL.toast(v.kind === 'off' ? 'Đã xoá ca.' : `Đã xếp ca cho ${u.name}.`);
              if (r) await load(true);
            } },
          ],
        });
      }
      function registerDialog(preset) {
        const today = H.today(), dates = daysFrom(S.data.from, 7);
        const picks = h('div.ros-daypick', { role: 'group', 'aria-label': 'Chọn ngày' }, dates.map((dt) => h('label', { title: dt < today ? 'Ngày đã qua' : null },
          h('input', { type: 'checkbox', value: dt, disabled: dt < today, checked: preset.includes(dt) }), h('span', h('b', dowOf(dt)), h('small', ddmm(dt))))));
        const first = preset[0] && approved(me, preset[0]);
        const picker = shiftPicker(S.data.shifts, first || null, { leaveHint: 'Xin nghỉ cả ngày' });
        const note = H.field({ name: 'note', label: 'Ghi chú cho Lead', placeholder: 'Không bắt buộc', full: true });
        const allPast = dates.every((dt) => dt < today);
        ARL.modal({
          title: `Đăng ký ca · ${weekName(S.week)}`,
          body: h('div.h-form',
            h('p.sub', 'Chọn ngày và ca muốn làm. Ca có hiệu lực sau khi Lead duyệt; việc tự sinh chỉ giao cho bạn trong giờ ca đã duyệt.'),
            allPast ? H.note('Tuần này đã qua. Chuyển sang tuần sau để đăng ký.', 'wait') : null,
            h('div', h('span.ros-lbl', 'Ngày'), picks), picker.el, note),
          actions: [
            { label: 'Thôi', cls: 'ghost', run: () => {} },
            { label: 'Gửi đăng ký', cls: 'primary', run: async () => {
              const chosen = [...picks.querySelectorAll('input:checked')].map((i) => i.value);
              if (!chosen.length) throw new Error('Chọn ít nhất một ngày.');
              const v = picker.value(), n = note.querySelector('input').value.trim();
              const r = await ctx.api('POST', '/api/hub/roster/register', { rows: chosen.map((date) => ({ date, ...v, note: n })) });
              ARL.toast(r.pending ? `Đã gửi đăng ký ${chosen.length} ngày, chờ Lead duyệt.` : `Đã xếp ca ${chosen.length} ngày.`);
              await load(true);
              if (!r.pending) ctx.refreshMe();
            } },
          ],
        });
      }
      async function copyWeek() {
        const prev = shiftWeek(S.week, -1);
        if (!(await H.confirm(`Chép các ca làm đã duyệt của ${weekName(prev)} (${weekSpan(prev)}) sang ${weekName(S.week)} (${weekSpan(S.week)})? Ngày nghỉ phép không chép (mỗi lần nghỉ cần đăng ký riêng); ngày đã qua không chép. Ô đã có ca hoặc nghỉ phép ở tuần này giữ nguyên.`, 'Chép ca'))) return;
        const r = await ctx.api('POST', '/api/hub/roster/copy-week', { from_week: prev, to_week: S.week, team: S.data ? S.data.team : S.team });
        const past = r.skipped_past ? ` (bỏ ${r.skipped_past} ca rơi vào ngày đã qua)` : '';
        ARL.toast(r.count ? `Đã chép ${r.count} ca từ ${weekName(prev)}${past}.` : `Không có ca nào để chép (${weekName(prev)} trống, tuần này đã kín hoặc đã qua)${past}.`);
        await load(true);
      }

      ctx.onRoute(() => { const k = weekOf(ctx.params[0]) || weekOf(ctx.query.w); if (k && k !== S.week) { S.week = k; S.day = null; load(true); } });
      ctx.live(['roster', 'people'], () => load(true));
      ctx.every(60000, () => { if (S.data && S.week === weekKey(H.today())) paintBody(); }); // ô "đang diễn ra" theo giờ
      load();
    },
  });

  // ═════════════════════════════ CHẤM CÔNG ═════════════════════════════
  const ATT_CODE = { present: 'Đ', late: 'T', absent: 'V', leave: 'P', off: 'N' };
  ARL.hub.view('attendance', {
    mount(el, ctx) {
      const isAdmin = ctx.role === 'admin';
      const isSelf = (u) => !isAdmin && u.id === ctx.user.id; // chấm công, tăng ca của chính Lead do Quản trị sửa
      const period = ctx.query.p === 'month' ? 'month' : 'week';
      const S = {
        period,
        key: period === 'month' ? (monthOk(ctx.query.k) ? ctx.query.k : H.today().slice(0, 7)) : (weekFrom(ctx.query.k) ? ctx.query.k : weekKey(H.today())),
        team: isAdmin ? (ctx.query.team === 'logistics' ? 'logistics' : 'tech') : ctx.team,
        att: null, ros: null,
      };
      const range = () => (S.period === 'month' ? monthRange(S.key) : { from: weekFrom(S.key), to: addDays(weekFrom(S.key), 6) });
      const label = () => (S.period === 'month' ? monthName(S.key) : `${weekName(S.key)} · ${weekSpan(S.key)}`);
      const curKey = () => (S.period === 'month' ? H.today().slice(0, 7) : weekKey(H.today()));

      const head = H.head('Chấm công', 'Tự ghi khi nhân viên mở ứng dụng trong giờ ca. Lead sửa khi quên mở ứng dụng, nghỉ phép hay tăng ca; mỗi lần sửa cần lý do và có nhật ký.');
      const teamSeg = isAdmin ? H.seg([['tech', 'Tech'], ['logistics', 'Logistics']], S.team, (t) => { S.team = t; sync(); }) : null;
      const perSeg = H.period(S.period, (p) => { S.period = p; S.key = curKey(); sync(); });
      const lbl = h('b.ros-wk');
      const nav = h('div.ros-nav', { role: 'group', 'aria-label': 'Chọn kỳ' },
        h('button.ghost', { type: 'button', 'aria-label': 'Kỳ trước', onclick: () => step(-1) }, '‹'), lbl,
        h('button.ghost', { type: 'button', 'aria-label': 'Kỳ sau', onclick: () => step(1) }, '›'));
      const nowBtn = h('button.small', { type: 'button', onclick: () => { S.key = curKey(); sync(); } }, 'Kỳ này');
      const kpiBox = h('div');
      const gridBox = h('div.att-box', H.loading(6));
      const sumBox = h('div.att-sum');
      const legend = h('div.ros-legend', Object.entries(ctx.meta.att_st || {}).map(([k, v]) => h('span.ros-leg', h('span.att-c', { 'data-st': k }, ATT_CODE[k] || v[0]), v)),
        h('span.ros-leg', h('span.att-c', { 'data-st': 'sched' }, 'HC'), 'Có ca, chưa ghi chấm công'));
      el.append(head, h('div.h-tools', teamSeg, perSeg, nav, nowBtn), kpiBox, gridBox, legend, sumBox);

      function step(n) { S.key = S.period === 'month' ? shiftMonth(S.key, n) : shiftWeek(S.key, n); sync(); }
      function sync() { ctx.setQuery({ p: S.period === 'week' ? '' : 'month', k: S.key === curKey() ? '' : S.key, team: isAdmin && S.team !== 'tech' ? S.team : '' }); load(true); }

      let gen = 0;
      async function load(soft) {
        const my = ++gen, r = range();
        const q = { from: r.from, to: r.to };
        if (isAdmin) q.team = S.team;
        lbl.textContent = label();
        nowBtn.hidden = S.key === curKey();
        if (soft) gridBox.classList.add('is-busy');
        try {
          const [att, ros] = await Promise.all([ctx.api('GET', '/api/hub/attendance', null, q), ctx.api('GET', '/api/hub/roster', null, q)]);
          if (my !== gen || !ctx.alive()) return;
          S.att = att; S.ros = ros;
          paint();
        } catch (e) {
          if (my !== gen || !ctx.alive()) return;
          if (!S.att) gridBox.replaceChildren(H.error(e, () => load()));
          else ARL.toast(e.message, true);
        } finally { gridBox.classList.remove('is-busy'); }
      }
      function paint() {
        const A = S.att, today = H.today();
        const dates = daysFrom(A.from, Math.round((utc(A.to) - utc(A.from)) / 86400000) + 1);
        const am = new Map(A.rows.map((a) => [`${a.user_id}:${a.date}`, a]));
        const rm = new Map(S.ros.rows.filter((r) => (r.status || 'approved') === 'approved').map((r) => [`${r.user_id}:${r.date}`, r]));
        const sum = A.summary;
        const tot = (k) => sum.reduce((x, s) => x + (s[k] || 0), 0);
        kpiBox.replaceChildren(H.kpis(
          H.kpi({ label: 'Đúng giờ', value: tot('present'), unit: 'công', tone: 'go' }),
          H.kpi({ label: 'Vào trễ', value: tot('late'), unit: 'lần', tone: tot('late') ? 'wait' : null, hint: tot('late_min') ? `Tổng ${H.dur(tot('late_min'))}` : null }),
          H.kpi({ label: 'Vắng', value: tot('absent'), unit: 'ngày', tone: tot('absent') ? 'lost' : null }),
          H.kpi({ label: 'Nghỉ phép', value: tot('leave'), unit: 'ngày', tone: 'blue' }),
          H.kpi({ label: 'Tăng ca', value: H.dur(tot('ot_min')), hint: `${TEAM_NAME[A.team]} · ${label()}` })));
        const cellOf = (u, dt) => {
          const a = am.get(`${u.id}:${dt}`), r = rm.get(`${u.id}:${dt}`), future = dt > today;
          let txt = '', st = '', tip = `${u.name} · ${dowOf(dt)} ${ddmm(dt)}: `;
          if (a && a.status) {
            st = a.status; txt = ATT_CODE[a.status] || (a.status_label || '?')[0];
            tip += a.status_label + (a.checkin_at ? `, vào ${H.time(a.checkin_at)}` : '') + (a.late_min ? `, trễ ${a.late_min} phút` : '') + (a.ot_min ? `, tăng ca ${H.dur(a.ot_min)}` : '') + (a.note ? ` · ${a.note}` : '') + (a.by ? ` · sửa bởi ${a.by}` : '');
          } else if (r) {
            // Có ca, chưa vào ca (dòng Lead ghi trước chỉ có tăng ca vẫn chờ người đó vào ca hoặc bị ghi vắng như thường).
            st = 'sched'; txt = r.kind === 'leave' ? 'P' : r.shift || '•';
            tip += `${r.kind === 'leave' ? 'Nghỉ phép (đã duyệt)' : 'Có ca ' + shiftText(r)}, chưa ghi chấm công${a && a.ot_min ? `, đã ghi trước tăng ca ${H.dur(a.ot_min)}` : ''}`;
          } else tip += a && a.ot_min ? `Không có ca, đã ghi trước tăng ca ${H.dur(a.ot_min)}` : 'Không có ca, chưa ghi';
          const kids = [txt, a && a.ot_min ? h('i.att-ot', { 'aria-hidden': 'true' }) : null];
          if (isSelf(u)) return h('span.att-c', { 'data-st': st || null, 'data-self': '1', title: `${tip}. Chấm công của chính bạn do Quản trị sửa.` }, kids);
          if (future) return h('span.att-c', { 'data-st': st || null, 'data-future': '1', title: tip }, kids);
          return h('button.att-c', { type: 'button', 'data-st': st || null, 'data-u': u.id, 'data-d': dt, title: tip, 'aria-label': tip + '. Bấm để sửa.', onclick: () => edit(u, dt, a, r) }, kids);
        };
        const users = sum.map((s) => s.user);
        const weekend = (dt) => wd(dt) >= 5;
        const head = h('tr', h('th.att-who', { scope: 'col' }, 'Nhân sự'),
          dates.map((dt) => h('th', { scope: 'col', class: [dt === today ? 'is-today' : '', weekend(dt) ? 'is-we' : ''].join(' ').trim() || null }, h('span', dowOf(dt)), h('small', S.period === 'month' ? dt.slice(8) : ddmm(dt)))),
          ['Đ', 'T', 'V', 'P'].map((x, i) => h(i ? 'th.att-t' : 'th.att-t.att-t1', { scope: 'col', title: ['Đúng giờ', 'Vào trễ', 'Vắng', 'Nghỉ phép'][i] }, x)), h('th.att-t', { scope: 'col', title: 'Tăng ca' }, 'TC'));
        const rows = sum.map((s) => h('tr', h('th.att-who', { scope: 'row' }, h('b', s.user.name), h('small', s.user.role_label)),
          dates.map((dt) => h('td', { class: [dt === today ? 'is-today' : '', weekend(dt) ? 'is-we' : ''].join(' ').trim() || null }, cellOf(s.user, dt))),
          h('td.att-t.att-t1', String(s.present)), h('td.att-t', { 'data-tone': s.late ? 'wait' : null }, String(s.late)), h('td.att-t', { 'data-tone': s.absent ? 'lost' : null }, String(s.absent)), h('td.att-t', String(s.leave)), h('td.att-t', s.ot_min ? H.dur(s.ot_min) : '–')));
        gridBox.replaceChildren(users.length ? h('div.ros-scroll.att-scroll', h('table.att-grid', { 'data-period': S.period }, h('thead', head), h('tbody', rows))) : H.empty('Team chưa có thành viên đang hoạt động.'));
        // Tổng theo người (thẻ trên điện thoại)
        sumBox.dataset.period = S.period; // xem theo tháng: cột tổng nằm ngoài khung bảng nên hiện bảng tổng riêng
        sumBox.replaceChildren(H.sec('Tổng theo người', label()), H.table({
          columns: [
            { key: 'name', label: 'Nhân sự', value: (s) => s.user.name, render: (s) => h('span', h('b', s.user.name), h('small', s.user.role_label)) },
            { key: 'present', label: 'Đúng giờ', align: 'r' }, { key: 'late', label: 'Vào trễ', align: 'r' }, { key: 'late_min', label: 'Phút trễ', align: 'r' },
            { key: 'absent', label: 'Vắng', align: 'r' }, { key: 'leave', label: 'Nghỉ phép', align: 'r' }, { key: 'ot_min', label: 'Tăng ca', align: 'r', render: (s) => (s.ot_min ? H.dur(s.ot_min) : '–') },
          ],
          rows: sum, id: (s) => s.user.id, rowTone: (s) => (s.absent ? 'lost' : s.late ? 'wait' : null), empty: 'Chưa có ai trong team.',
        }));
      }
      async function edit(u, dt, a, r) {
        const ci = a && a.checkin_at ? H.time(a.checkin_at) : '';
        // Mặc định giữ trạng thái đang ghi: Lead chỉ ghi trước tăng ca thì người đó vẫn tự vào ca hoặc bị ghi vắng như thường.
        const keepLabel = a && a.status ? `Giữ nguyên (${a.status_label})` : 'Chưa ghi trạng thái (hệ thống tự ghi khi vào ca hoặc vắng)';
        const info = H.dl([['Ca', r ? shiftText(r) : 'Không có ca đã duyệt'], ['Đang ghi', a ? a.status_label : 'Chưa ghi'], ['Giờ vào', ci || null], ['Trễ', a && a.late_min ? `${a.late_min} phút` : null], ['Ghi chú', a && a.note ? a.note : null], ['Sửa lần cuối', a && a.by ? a.by : null]]);
        await H.form({
          title: `Sửa chấm công · ${u.name}`,
          intro: h('div.h-stack', h('p.sub', `${dowOf(dt)} ${H.dmy(dt)}`), info, H.note('Lý do được lưu vào nhật ký. Đổi giờ vào thì số phút trễ tính lại theo ca. Điểm chuyên cần trong Đánh giá nhân sự tự tính lại theo chấm công mới.')),
          fields: [
            { name: 'status', label: 'Trạng thái', type: 'select', options: [['', keepLabel], ...Object.entries(ctx.meta.att_st || {})], value: '' },
            { name: 'checkin', label: 'Giờ vào', type: 'time', value: ci },
            { name: 'ot_min', label: 'Tăng ca (phút)', type: 'number', min: 0, max: 720, step: 15, value: a ? a.ot_min || 0 : 0 },
            { name: 'reason', label: 'Lý do sửa', type: 'textarea', rows: 2, required: true, placeholder: 'VD: quên mở ứng dụng, đã báo Lead' },
          ],
          submit: 'Lưu chấm công',
          onSubmit: async (v, c) => {
            if (v.reason.length < 3) { c.setErr('Ghi rõ lý do (ít nhất 3 ký tự).'); return false; }
            const body = { reason: v.reason };
            if (v.status) body.status = v.status;
            if (v.checkin !== ci) body.checkin = v.checkin || null;
            const ot = v.ot_min === null ? 0 : v.ot_min;
            if (ot !== (a ? a.ot_min || 0 : 0)) body.ot_min = ot;
            await ctx.api('PATCH', `/api/hub/attendance/${u.id}/${dt}`, body);
            ARL.toast(`Đã sửa chấm công của ${u.name}.`);
            load(true);
          },
        });
      }
      ctx.live(['people', 'roster'], () => load(true));
      load();
    },
  });

  // ═════════════════════════════ TÀI KHOẢN ═════════════════════════════
  const TEAM_TONE = { tech: 'blue', logistics: 'go', sale: 'violet', admin: 'off' };
  /** Mật khẩu tạm chỉ hiện một lần, kèm nút sao chép và lời dặn gửi riêng. */
  function secretDialog(title, u, pw) {
    const text = `Atlas Ops Hub\nĐịa chỉ: ${location.origin}${location.pathname}\nTên đăng nhập: ${u.username}\nMật khẩu tạm: ${pw}\n(Lần đăng nhập đầu sẽ phải đổi mật khẩu.)`;
    ARL.modal({
      title,
      body: h('div.h-stack',
        H.note([h('b', 'Mật khẩu tạm chỉ hiện một lần ở đây. '), `Gửi riêng cho ${u.name} qua tin nhắn cá nhân, không gửi vào nhóm chung. Đóng hộp thoại này là không xem lại được.`], 'wait'),
        h('pre.cred.accts-cred', text)),
      actions: [{ label: 'Sao chép', cls: '', run: () => { ARL.copyText(text, 'Đã sao chép thông tin đăng nhập'); return false; } }, { label: 'Tôi đã gửi cho người dùng', cls: 'primary', run: () => {} }],
    });
  }
  const suggestUsername = (name) => {
    const w = H.fold(name).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
    return w.length ? (w.length > 1 ? `${w[w.length - 1]}.${w[0]}` : w[0]).slice(0, 40) : '';
  };

  ARL.hub.view('accounts', {
    mount(el, ctx) {
      const S = { users: [], canCreate: [], q: ctx.query.q || '', role: ctx.query.role || 'all', st: ctx.query.st || 'active', dlg: null, dlgId: null, loaded: false };
      const canDevice = ['admin', 'tech_lead', 'lead'].includes(ctx.role);
      const roleLabel = (r) => (ctx.meta.roles && ctx.meta.roles[r]) || r;
      const teamOf = (r) => (ctx.meta.team_of && ctx.meta.team_of[r]) || '';
      const scope = { admin: 'Bạn quản lý tài khoản của mọi vai trò.', tech_lead: 'Bạn quản lý tài khoản của mọi vai trò.', lead: 'Bạn quản lý tài khoản Logistic Executive và FO.', sale_head: 'Bạn quản lý tài khoản Sale Lead.' }[ctx.role] || '';

      const newBtn = H.btn('+ Tạo tài khoản', () => createDialog(), 'primary');
      newBtn.hidden = true;
      el.append(H.head('Tài khoản', scope, newBtn));
      const search = H.search('Tìm tên, tên đăng nhập, SĐT', (q) => { S.q = q; ctx.setQuery({ q }); paint(); }, S.q);
      const roleChips = h('div');
      const stSeg = H.seg([['active', 'Đang dùng'], ['locked', 'Đã khoá'], ['all', 'Tất cả']], S.st, (v) => { S.st = v; ctx.setQuery({ st: v === 'active' ? '' : v }); paint(); });
      const tools = h('div.h-tools', search, stSeg, roleChips);
      const box = h('div', H.loading(6));
      el.append(tools, box);
      let table = null, chips = null;

      const statusPill = (u) => (!u.active ? H.pill('Đã khoá', 'lost') : u.must_change ? H.pill('Chưa đổi mật khẩu tạm', 'wait') : H.pill('Đang hoạt động', 'go'));
      const consentCell = (u) => (u.role !== 'fo' ? h('span.accts-na', '–') : u.consent_ok ? h('span', H.pill('Đã đồng ý', 'go'), u.consent_at ? h('small', H.when(u.consent_at)) : null) : H.pill('Chưa đồng ý', 'wait'));
      const isSelf = (u) => u.id === ctx.user.id;
      function actionsOf(u) {
        return [
          { label: 'Sửa thông tin', run: () => ctx.setParams([u.id]) },
          { label: 'Cấp lại mật khẩu', run: () => resetPw(u), hidden: isSelf(u) },
          { label: 'Mã thiết bị chạy nền', run: () => deviceDialog(u), hidden: !(u.role === 'fo' && canDevice) },
          '-',
          { label: u.active ? 'Khoá tài khoản' : 'Mở khoá', danger: u.active, run: () => setActive(u, !u.active), hidden: isSelf(u) },
        ];
      }
      function filtered() {
        return S.users.filter((u) => (S.st === 'all' || (S.st === 'active' ? u.active : !u.active)) && (S.role === 'all' || u.role === S.role)
          && (!S.q || H.match(`${u.name} ${u.username} ${u.phone} ${u.email} ${u.vehicle}`, S.q)));
      }
      function paint() {
        const roles = [...new Set([...S.canCreate, ...S.users.map((u) => u.role)])].filter((r) => S.users.some((u) => u.role === r) || S.canCreate.includes(r));
        const inSt = S.users.filter((u) => S.st === 'all' || (S.st === 'active' ? u.active : !u.active));
        const counts = { all: inSt.length };
        for (const r of roles) counts[r] = inSt.filter((u) => u.role === r).length;
        if (!chips) { chips = H.chips([{ key: 'all', label: 'Mọi vai trò' }, ...roles.map((r) => ({ key: r, label: roleLabel(r) }))], S.role, (k) => { S.role = k; ctx.setQuery({ role: k === 'all' ? '' : k }); paint(); }); roleChips.replaceChildren(chips); }
        chips.counts(counts);
        roleChips.hidden = roles.length < 2;
        const hasFo = S.users.some((u) => u.role === 'fo');
        const rows = filtered();
        if (!table) {
          table = H.table({
            columns: [
              { key: 'name', label: 'Họ tên', render: (u) => h('span', h('b', u.name), isSelf(u) ? h('span.ros-me', ' (bạn)') : null, h('small.h-mono', u.username)) },
              { key: 'role', label: 'Vai trò', value: (u) => roleLabel(u.role), render: (u) => H.pill(roleLabel(u.role), TEAM_TONE[teamOf(u.role)] || 'off') },
              { key: 'contact', label: 'Liên hệ', value: (u) => u.phone || u.email, render: (u) => (u.phone || u.email ? h('span', u.phone || '', u.email ? h('small', u.email) : null, u.vehicle ? h('small', `Xe ${u.vehicle}`) : null) : '') },
              { key: 'status', label: 'Trạng thái', value: (u) => (u.active ? (u.must_change ? 1 : 0) : 2), render: statusPill },
              hasFo ? { key: 'consent', label: 'Điều khoản FO', value: (u) => (u.role === 'fo' ? (u.consent_ok ? 1 : 0) : null), render: consentCell } : null,
              { key: 'act', label: '', sort: false, align: 'r', render: (u) => H.more(actionsOf(u), `Thao tác với ${u.name}`) },
            ].filter(Boolean),
            rows, onRow: (u) => ctx.setParams([u.id]), rowTone: (u) => (!u.active ? null : u.must_change ? 'wait' : null), sort: { key: 'name', dir: 1 },
            empty: S.q ? 'Không có tài khoản khớp tìm kiếm.' : 'Chưa có tài khoản nào trong nhóm này.',
          });
          box.replaceChildren(table, h('p.sub.accts-foot', 'FO dùng ứng dụng trên điện thoại (nhận chuyến, giao nhận), không vào Ops Hub. Vị trí của FO không hiện ở đây.'));
          box.lastChild.hidden = !hasFo;
        } else table.update(rows);
      }
      async function load() {
        try {
          const j = await ctx.api('GET', '/api/users');
          if (!ctx.alive()) return;
          S.users = j.users; S.canCreate = j.canCreate || [];
          newBtn.hidden = !S.canCreate.length;
          S.loaded = true;
          paint();
          route();
        } catch (e) { if (!S.loaded) box.replaceChildren(H.error(e, load)); else ARL.toast(e.message, true); }
      }
      function route() {
        const id = +ctx.params[0] || null;
        if (!id) { if (S.dlg) { const d = S.dlg; S.dlg = null; S.dlgId = null; d.close(); } return; }
        if (!S.loaded || S.dlgId === id) return;
        const u = S.users.find((x) => x.id === id);
        if (!u) { ARL.toast('Không tìm thấy tài khoản này, hoặc bạn không quản lý tài khoản này.', true); ctx.setParams([]); return; }
        editDialog(u);
      }

      // ── Hộp thoại ──
      const fieldsBase = (u, roleOpts, isFo) => [
        { name: 'name', label: 'Họ tên', value: u ? u.name : '', required: true, full: !u },
        u ? null : { name: 'username', label: 'Tên đăng nhập', required: true, full: true, placeholder: 'vd: tuan.nguyen', hint: 'Chữ thường không dấu, số và . _ - @ (2–40 ký tự).' },
        roleOpts ? { name: 'role', label: 'Vai trò', type: 'select', options: roleOpts, value: u ? u.role : roleOpts[0][0], required: true } : null,
        { name: 'phone', label: 'Số điện thoại', type: 'tel', value: u ? u.phone : '' },
        { name: 'email', label: 'Email', type: 'email', value: u ? u.email : '' },
        isFo === false ? null : { name: 'vehicle', label: 'Biển số xe (FO)', value: u ? u.vehicle : '' },
      ].filter(Boolean);
      function createDialog() {
        const roleOpts = S.canCreate.map((r) => [r, roleLabel(r)]);
        const fields = fieldsBase(null, roleOpts, null);
        const form = h('form.h-form', { novalidate: true, onsubmit: (e) => e.preventDefault() }, h('div.h-fields', fields.map(H.field)));
        const $ = (n) => form.querySelector(`[name="${n}"]`);
        let touched = false;
        $('username').addEventListener('input', () => { touched = true; });
        $('username').setAttribute('autocapitalize', 'none'); $('username').setAttribute('spellcheck', 'false');
        $('name').addEventListener('input', () => { if (!touched) $('username').value = suggestUsername($('name').value); });
        const syncFo = () => { $('vehicle').closest('.h-field').hidden = $('role').value !== 'fo'; };
        $('role').addEventListener('change', syncFo); syncFo();
        ARL.modal({
          title: 'Tạo tài khoản', body: h('div.h-stack', h('p.sub', 'Hệ thống tạo mật khẩu tạm; người dùng phải đổi mật khẩu ở lần đăng nhập đầu.'), form),
          actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, { label: 'Tạo tài khoản', cls: 'primary', run: async (c) => {
            const v = H.values(form, fields);
            if (!v.name) { c.setErr('Cần nhập họ tên.'); $('name').focus(); return false; }
            if (!v.username) { c.setErr('Cần nhập tên đăng nhập.'); $('username').focus(); return false; }
            const body = { name: v.name, username: v.username.toLowerCase(), role: v.role, phone: v.phone, email: v.email };
            if (v.role === 'fo') body.vehicle = v.vehicle;
            const j = await ctx.api('POST', '/api/users', body);
            ARL.toast(`Đã tạo tài khoản cho ${j.user.name}.`);
            S.users.push(j.user); paint();
            setTimeout(() => secretDialog('Đã tạo tài khoản', j.user, j.tempPassword), 0);
          } }],
        });
        setTimeout(() => $('name').focus(), 30);
      }
      function editDialog(u) {
        const self = isSelf(u), isFo = u.role === 'fo';
        const canRole = !self && !isFo && S.canCreate.includes(u.role);
        const roleOpts = canRole ? S.canCreate.filter((r) => r !== 'fo').map((r) => [r, roleLabel(r)]) : null;
        const fields = fieldsBase(u, roleOpts, isFo);
        const form = h('form.h-form', { novalidate: true, onsubmit: (e) => e.preventDefault() }, h('div.h-fields', fields.map(H.field)));
        let m = null;
        const later = (fn) => () => { close(); setTimeout(fn, 0); };
        const quick = h('div.h-row.accts-quick',
          self ? null : H.btn('Cấp lại mật khẩu', later(() => resetPw(u)), 'small'),
          isFo && canDevice ? H.btn('Mã thiết bị chạy nền', later(() => deviceDialog(u)), 'small') : null,
          self ? null : H.btn(u.active ? 'Khoá tài khoản' : 'Mở khoá', later(() => setActive(u, !u.active)), u.active ? 'small ghost danger' : 'small'));
        const meta = H.dl([
          ['Tên đăng nhập', h('span.h-mono', u.username)], ['Vai trò', roleLabel(u.role)], ['Trạng thái', statusPill(u)],
          isFo ? ['Điều khoản xử lý dữ liệu', u.consent_ok ? `Đã đồng ý${u.consent_at ? ' lúc ' + H.when(u.consent_at) : ''}` : 'Chưa đồng ý (FO phải đồng ý khi đăng nhập)'] : null,
          ['Tạo lúc', u.created_at ? H.when(u.created_at) : null],
        ]);
        const notes = [self ? H.note('Đây là tài khoản của bạn: không tự đổi vai trò hay tự khoá được. Đổi mật khẩu ở menu tên của bạn (góc trên).') : null,
          isFo ? H.note('FO không đổi vai trò được (dữ liệu vị trí và điều khoản gắn với FO). Cần vai trò khác thì tạo tài khoản mới.') : null].filter(Boolean);
        const close = () => { if (m) m.close(); };
        m = ARL.modal({
          title: `Tài khoản · ${u.name}`, body: h('div.h-stack', meta, notes, form, quick.childNodes.length ? h('div.accts-qwrap', h('span.sub', 'Thao tác khác'), quick) : null),
          onClose: () => { if (S.dlg === m) { S.dlg = null; S.dlgId = null; if (+ctx.params[0] === u.id) ctx.setParams([]); } },
          actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, { label: 'Lưu', cls: 'primary', run: async (c) => {
            const v = H.values(form, fields);
            if (!v.name) { c.setErr('Cần nhập họ tên.'); return false; }
            const patch = {};
            for (const k of ['name', 'phone', 'email', 'vehicle', 'role']) if (v[k] !== undefined && v[k] !== (u[k] ?? '')) patch[k] = v[k];
            if (!Object.keys(patch).length) return true;
            if (patch.role && !(await H.confirm(`Đổi vai trò của ${u.name} từ ${roleLabel(u.role)} sang ${roleLabel(patch.role)}? Người này bị đăng xuất và thấy chức năng theo vai trò mới.`, 'Đổi vai trò'))) return false;
            const j = await ctx.api('PATCH', `/api/users/${u.id}`, patch);
            Object.assign(u, j.user);
            ARL.toast('Đã lưu thông tin tài khoản.');
            paint();
          } }],
        });
        S.dlg = m; S.dlgId = u.id;
      }
      async function resetPw(u) {
        if (!(await H.confirm(`Cấp mật khẩu tạm mới cho ${u.name}? Mật khẩu cũ và mọi phiên đang đăng nhập của người này hết hiệu lực ngay.`, 'Cấp mật khẩu mới', true))) return;
        const r = await ctx.api('POST', `/api/users/${u.id}/reset`);
        u.must_change = true; paint();
        secretDialog('Mật khẩu tạm mới', u, r.tempPassword);
      }
      async function setActive(u, active) {
        if (!active && !(await H.confirm(`Khoá tài khoản của ${u.name}? Người này bị đăng xuất ngay và không đăng nhập lại được cho tới khi mở khoá.`, 'Khoá tài khoản', true))) return;
        const j = await ctx.api('PATCH', `/api/users/${u.id}`, { active });
        Object.assign(u, j.user);
        ARL.toast(active ? `Đã mở khoá tài khoản của ${u.name}.` : `Đã khoá tài khoản của ${u.name}.`);
        paint();
      }
      async function deviceDialog(u) {
        let j;
        try { j = await ctx.api('GET', `/api/users/${u.id}/device`); } catch (e) { ARL.toast(e.message, true); return; }
        const url = location.origin + location.pathname.replace(/\/[^/]*$/, '/') + 'osmand';
        const tok = h('input.h-mono', { type: 'password', readonly: true, value: j.deviceToken, 'aria-label': 'Mã thiết bị' });
        const show = h('button.small', { type: 'button', onclick: () => { const hid = tok.type === 'password'; tok.type = hid ? 'text' : 'password'; show.textContent = hid ? 'Ẩn' : 'Hiện'; } }, 'Hiện');
        ARL.modal({
          title: `Mã thiết bị · ${u.name}`,
          body: h('div.h-stack',
            h('p.sub', 'Chỉ cần khi FO chạy nền bằng ứng dụng Traccar Client (trang web không gửi được khi tắt màn hình). Nhập hai dòng dưới vào Traccar trên máy của FO.'),
            h('label.h-field', h('span', 'Địa chỉ máy chủ'), h('input.h-mono', { readonly: true, value: url })),
            h('label.h-field', h('span', 'Mã thiết bị (giữ kín như mật khẩu)'), h('span.accts-tok', tok, show)),
            H.note('Đổi máy, mất máy hoặc nghi lộ mã: bấm "Đổi mã mới". Mã cũ ngừng hoạt động ngay; nhập lại mã mới trong Traccar. Vị trí chỉ được nhận khi FO đã đồng ý điều khoản.', 'wait')),
          actions: [
            { label: 'Đổi mã mới', cls: 'ghost danger', run: async () => {
              if (!(await H.confirm(`Đổi mã thiết bị của ${u.name}? Mã cũ ngừng hoạt động ngay, phải nhập lại mã mới trong Traccar.`, 'Đổi mã', true))) return false;
              const r = await ctx.api('POST', `/api/users/${u.id}/device`);
              j.deviceToken = r.deviceToken; tok.value = r.deviceToken;
              ARL.toast('Đã đổi mã thiết bị.');
              return false;
            } },
            { label: 'Sao chép mã', run: () => { ARL.copyText(j.deviceToken, 'Đã sao chép mã thiết bị'); return false; } },
            { label: 'Đóng', cls: 'primary', run: () => {} },
          ],
        });
      }

      ctx.onRoute(route);
      ctx.live(['people'], load);
      load();
    },
  });

})();
