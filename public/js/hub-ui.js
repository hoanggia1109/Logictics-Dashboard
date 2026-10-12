/* Ops Hub — thành phần giao diện dùng chung (ARL.H). Mọi màn hình của hub dựng từ đây để nhìn và cư xử giống nhau.
   Quy ước: hàm trả về phần tử DOM; chuỗi người dùng nhập luôn đi qua textContent hoặc esc(), không ghép thẳng vào innerHTML. */
(() => {
  'use strict';
  const { $, $$, el, esc, toast, modal, fmtHM, fmtDate, fmtDT, dateOf, today } = ARL;
  const H = (ARL.H = ARL.H || {});

  // ───────────── Số và thời gian ─────────────
  const nf = (d) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: d, minimumFractionDigits: 0 });
  const NF0 = nf(0), NF1 = nf(1), NF2 = nf(2);
  /** Số theo kiểu Việt Nam (1.234,5). d = số lẻ tối đa. null/undefined → "–". */
  H.num = (n, d = 0) => (n === null || n === undefined || Number.isNaN(+n) ? '–' : (d === 0 ? NF0 : d === 1 ? NF1 : d === 2 ? NF2 : nf(d)).format(+n));
  /** Tỉ lệ: H.pct(0.873) → "87%", H.pct(87.3, 1, true) → "87,3%" (đã là phần trăm). */
  H.pct = (x, d = 0, isPct = false) => (x === null || x === undefined || Number.isNaN(+x) ? '–' : H.num(isPct ? +x : +x * 100, d) + '%');
  /** Giờ quay: 12.5 → "12,5 giờ". */
  H.hours = (h, d = 1) => (h === null || h === undefined ? '–' : `${H.num(h, d)} giờ`);
  /** Thời lượng theo phút: 135 → "2 giờ 15 phút". */
  H.dur = (min) => {
    if (min === null || min === undefined || Number.isNaN(+min)) return '–';
    min = Math.round(+min);
    if (Math.abs(min) < 60) return `${min} phút`;
    const h = Math.floor(Math.abs(min) / 60), m = Math.abs(min) % 60, sign = min < 0 ? '-' : '';
    if (h >= 48) return `${sign}${Math.round(h / 24)} ngày`;
    return `${sign}${h} giờ${m ? ` ${m} phút` : ''}`;
  };
  H.time = (ts) => fmtHM(ts);
  H.when = (ts) => fmtDT(ts);
  H.day = (date) => (date ? fmtDate(date) : '–');
  /** "dd/mm/yyyy" từ "yyyy-mm-dd". */
  H.dmy = (date) => (date ? `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}` : '–');
  /** Còn bao lâu tới hạn / quá hạn bao lâu: { text, tone }. */
  H.due = (dueAt, doneAt) => {
    if (!dueAt) return { text: 'Không hạn', tone: 'off' };
    const ref = doneAt || ARL.now(), left = (dueAt - ref) / 60000;
    if (doneAt) return left >= 0 ? { text: 'Đúng hạn', tone: 'go' } : { text: `Trễ ${H.dur(-left)}`, tone: 'lost' };
    if (left < 0) return { text: `Quá hạn ${H.dur(-left)}`, tone: 'lost' };
    if (left < 60) return { text: `Còn ${H.dur(left)}`, tone: 'wait' };
    return { text: `Hạn ${H.when(dueAt)}`, tone: 'off' };
  };
  H.today = today;
  H.dateOf = dateOf;

  // ───────────── Phần tử cơ bản ─────────────
  /** h('div.h-card', { onclick, title, 'data-x': 1 }, ...con). Con là Node, chuỗi (thành text), mảng, hoặc null (bỏ qua). */
  function h(tag, attrs, ...kids) {
    const [name, ...cls] = String(tag).split('.');
    const n = document.createElement(name || 'div');
    if (cls.length) n.className = cls.join(' ');
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'class') n.className = (n.className ? n.className + ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k === 'html') n.innerHTML = v; // chỉ dùng cho chuỗi do code tự dựng (ví dụ SVG), không cho dữ liệu người dùng
      else if (k in n && typeof v !== 'string' && k !== 'list') n[k] = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    add(n, kids);
    return n;
  }
  function add(n, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k === null || k === undefined || k === false || k === '') continue;
      n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return n;
  }
  H.h = h;
  H.add = add;
  H.clear = (n, ...kids) => { n.replaceChildren(); return add(n, kids); };
  H.esc = esc;
  H.text = (s) => document.createTextNode(String(s ?? ''));

  /** Nút có xử lý bất đồng bộ: tự khoá khi đang chạy, lỗi hiện toast đỏ. cls: 'primary' | 'ghost' | 'danger' … */
  H.btn = (label, run, cls = '', attrs = {}) => {
    const b = h('button', { type: 'button', class: cls, ...attrs }, label);
    if (run) b.addEventListener('click', async (e) => {
      if (b.disabled) return;
      b.disabled = true;
      try { await run(e, b); } catch (err) { if (err && err.message) toast(err.message, true); console.error(err); } finally { if (b.isConnected) b.disabled = false; }
    });
    return b;
  };
  /** Link trong hub: H.link('#/kits/12', 'K12'). */
  H.link = (href, label, attrs = {}) => h('a', { href, ...attrs }, label);
  H.pill = (text, tone = 'off', attrs = {}) => h('span.pill', { 'data-tone': tone, ...attrs }, text);
  H.badge = (n, tone) => (n ? h('b.h-badge', tone ? { 'data-tone': tone } : null, n > 99 ? '99+' : String(n)) : null);

  // Màu trạng thái theo từng nhóm nhãn (khoá trùng tên nhóm trong /api/hub/meta).
  const TONES = {
    kit_st: { preparing: 'off', wait_check: 'wait', ready: 'go', reserved: 'blue', delivering: 'blue', at_bo: 'violet', recovering: 'wait', returned: 'wait', at_tech: 'lost', tech_done: 'wait', retired: 'off' },
    job_st: { open: 'wait', doing: 'blue', done: 'go', cancelled: 'off' },
    req_st: { submitted: 'wait', preparing: 'wait', ready: 'blue', delivering: 'blue', live: 'go', scheduled: 'blue', ending: 'wait', closed: 'off', cancelled: 'off' },
    outlet_st: { planned: 'wait', live: 'go', paused: 'off', ending: 'wait', ended: 'off' },
    incident_st: { open: 'lost', ack: 'wait', resolved: 'go', cancelled: 'off' },
    card_st: { office: 'go', with_fo: 'blue', at_bo: 'violet', returned: 'wait', to_tech: 'blue', at_tech: 'wait', uploaded: 'go', to_log: 'blue', bad: 'lost', lost: 'lost' },
    dev_cond: { ok: 'go', faulty: 'lost', repairing: 'wait', retired: 'off', lost: 'lost' },
    att_st: { present: 'go', late: 'wait', absent: 'lost', leave: 'blue', off: 'off' },
    task_st: { unassigned: 'lost', assigned: 'wait', accepted: 'wait', in_progress: 'blue', completed: 'go', failed: 'lost', cancelled: 'off' },
  };
  H.TONES = TONES;
  /** Pill theo nhãn của máy chủ: H.st('kit_st', kit.status). Nhãn lấy từ ARL.hubMeta (một nguồn duy nhất). */
  H.st = (group, key, override) => {
    const m = (ARL.hubMeta && ARL.hubMeta[group]) || (group === 'task_st' ? ARL.TASK_ST : {}) || {};
    const label = override || (typeof m[key] === 'object' ? m[key].label : m[key]) || key || '–';
    return H.pill(label, (TONES[group] && TONES[group][key]) || 'off', { 'data-k': key || '' });
  };
  /** Nhãn chữ (không pill): H.label('job_types', 'repair') → "Sửa kit hỏng". */
  H.label = (group, key) => { const m = (ARL.hubMeta && ARL.hubMeta[group]) || {}; const v = m[key]; return (v && typeof v === 'object' ? v.label : v) || key || '–'; };

  // ───────────── Bố cục ─────────────
  /** Đầu trang: tiêu đề, dòng phụ, nút thao tác bên phải. */
  H.head = (title, sub, ...actions) => h('header.h-head', h('div.h-head-l', h('h1', title), sub ? h('p.sub', sub) : null), actions.flat().filter(Boolean).length ? h('div.h-actions', actions) : null);
  H.sec = (title, sub, ...right) => h('div.h-sec', h('h2', title), sub ? h('p.sub', sub) : h('span', { style: { marginRight: 'auto' } }), right);
  /** Lưới cột: H.grid(3, a, b, c). Màn hẹp tự xuống 2 rồi 1 cột. */
  H.grid = (cols, ...kids) => h('div.h-grid', { style: `--cols: ${cols}` }, kids);
  /** Thẻ: H.card('Tiêu đề', nội dung, { sub, actions: [nút], tone, flush, span2 }). */
  H.card = (title, body, opt = {}) => h(`section.h-card${opt.flush ? '.h-flush' : ''}${opt.span2 ? '.h-span2' : ''}`, opt.tone ? { 'data-tone': opt.tone } : null,
    title || opt.actions ? h('header', title ? h('h3', title) : null, opt.actions || null, opt.sub ? h('p.sub', opt.sub) : null) : null, body);
  H.note = (text, tone) => h('p.h-note', tone ? { 'data-tone': tone } : null, text);
  /** Danh sách định nghĩa: H.dl([['Mã', 'K12'], ['Trạng thái', pill]]). Dòng có giá trị rỗng bị bỏ. */
  H.dl = (rows) => h('dl.h-dl', rows.filter((r) => r && r[1] !== null && r[1] !== undefined && r[1] !== '').map(([k, v]) => [h('dt', k), h('dd', v)]));
  H.bar = (ratio, tone) => h('div.h-bar', tone ? { 'data-tone': tone, role: 'img', 'aria-label': H.pct(ratio) } : { role: 'img', 'aria-label': H.pct(ratio) }, h('i', { style: { width: `${Math.max(0, Math.min(1, ratio || 0)) * 100}%` } }));

  // ───────────── KPI và so sánh kỳ trước ─────────────
  /**
   * Chip thay đổi so với kỳ trước. cur, prev: số. opt: { up: 'good'|'bad' (tăng là tốt hay xấu), label: 'tuần trước', pct: true (so %), unit }.
   * Không có kỳ trước → "chưa có kỳ trước".
   */
  H.delta = (cur, prev, opt = {}) => {
    const lab = opt.label || 'kỳ trước';
    if (prev === null || prev === undefined || cur === null || cur === undefined) return h('span.h-delta', h('em', `chưa có ${lab}`));
    const diff = cur - prev;
    if (Math.abs(diff) < 1e-9) return h('span.h-delta', '＝ ', h('em', `như ${lab}`));
    const up = diff > 0, good = (opt.up || 'good') === 'good' ? up : !up;
    let txt;
    if (opt.abs || prev === 0) txt = `${up ? '+' : '−'}${H.num(Math.abs(diff), opt.d ?? (Number.isInteger(diff) ? 0 : 1))}${opt.unit || ''}`;
    else txt = `${up ? '+' : '−'}${H.num(Math.abs(diff / prev) * 100, Math.abs(diff / prev) < 0.1 ? 1 : 0)}%`;
    return h('span.h-delta', { 'data-tone': opt.neutral ? null : good ? 'good' : 'bad', title: `${lab}: ${H.num(prev, opt.d ?? 1)}${opt.unit || ''}` }, `${up ? '▲' : '▼'} ${txt} `, h('em', `so ${lab}`));
  };
  /**
   * Ô số liệu. o: { label, value, unit, tone, hint, deltas: [H.delta(...)], onClick, title }.
   * value là số (tự định dạng) hoặc chuỗi đã định dạng.
   */
  H.kpi = (o) => {
    const v = typeof o.value === 'number' ? H.num(o.value, o.d ?? 0) : o.value ?? '–';
    const body = [h('span.h-kpi-l', o.label), h('span.h-kpi-v', v, o.unit ? h('small', o.unit) : null), o.deltas && o.deltas.length ? h('span.h-kpi-d', o.deltas) : null, o.hint ? h('span.h-kpi-h', o.hint) : null];
    return o.onClick ? h('button.h-kpi', { type: 'button', 'data-tone': o.tone, title: o.title, onclick: o.onClick }, body) : h('div.h-kpi', { 'data-tone': o.tone, title: o.title }, body);
  };
  H.kpis = (...tiles) => h('div.h-kpis', tiles);

  // ───────────── Bảng ─────────────
  /**
   * Bảng có sắp xếp, phân trang, chọn dòng, tự thành thẻ trên điện thoại.
   * o: { columns: [{ key, label, value(row) → số/chuỗi để sắp, render(row) → Node|chuỗi, align: 'r'|'c', nowrap, sort: false }],
   *      rows, onRow(row), rowTone(row) → 'lost'|'wait'|'go', empty, pageSize = 50, sort: { key, dir: 1|-1 }, select: true, onSelect(rows), cards = true, id(row) }
   * Trả về phần tử; .update(rows) thay dữ liệu mà giữ trang / sắp xếp / dòng đã chọn.
   */
  H.table = (o) => {
    const cols = o.columns, pageSize = o.pageSize || 50, idOf = o.id || ((r) => r.id);
    let rows = o.rows || [], sort = o.sort || null, page = 0;
    const picked = new Set();
    const wrap = h('div.h-tbl-wrap'), scroll = h('div.h-tbl-scroll'), table = h(`table.h-tbl${o.cards === false ? '' : '.h-cards'}`), thead = h('thead'), tbody = h('tbody'), foot = h('div.h-tbl-foot');
    table.append(thead, tbody); scroll.append(table); wrap.append(scroll, foot);
    const valOf = (c, r) => (c.value ? c.value(r) : r[c.key]);
    const head = () => {
      const tr = h('tr', o.select ? h('th.h-check', h('input', { type: 'checkbox', 'aria-label': 'Chọn tất cả', onchange: (e) => { for (const r of view()) e.target.checked ? picked.add(idOf(r)) : picked.delete(idOf(r)); paint(); fire(); } })) : null);
      for (const c of cols) {
        const th = h('th', { class: c.align || '', scope: 'col' }, c.label);
        if (c.sort !== false && o.sortable !== false) {
          th.dataset.sort = c.key;
          if (sort && sort.key === c.key) th.setAttribute('aria-sort', sort.dir > 0 ? 'ascending' : 'descending');
          th.addEventListener('click', () => { sort = sort && sort.key === c.key ? { key: c.key, dir: -sort.dir } : { key: c.key, dir: c.desc ? -1 : 1 }; page = 0; head(); paint(); });
        }
        tr.append(th);
      }
      thead.replaceChildren(tr);
    };
    const sorted = () => {
      if (!sort) return rows;
      const c = cols.find((x) => x.key === sort.key);
      if (!c) return rows;
      return [...rows].sort((a, b) => {
        const x = valOf(c, a), y = valOf(c, b);
        if (x === y) return 0;
        if (x === null || x === undefined || x === '') return 1;
        if (y === null || y === undefined || y === '') return -1;
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'vi', { numeric: true })) * sort.dir;
      });
    };
    const view = () => sorted().slice(page * pageSize, page * pageSize + pageSize);
    const fire = () => { if (o.onSelect) o.onSelect(rows.filter((r) => picked.has(idOf(r)))); };
    function paint() {
      const all = sorted(), pages = Math.max(1, Math.ceil(all.length / pageSize));
      if (page >= pages) page = pages - 1;
      const list = all.slice(page * pageSize, page * pageSize + pageSize);
      tbody.replaceChildren();
      if (!list.length) tbody.append(h('tr', h('td.h-tbl-empty', { colspan: cols.length + (o.select ? 1 : 0) }, o.empty || 'Chưa có dữ liệu.')));
      for (const r of list) {
        const tr = h('tr', { 'data-tone': o.rowTone ? o.rowTone(r) : null });
        if (o.select) tr.append(h('td.h-check', h('input', { type: 'checkbox', 'aria-label': 'Chọn dòng', checked: picked.has(idOf(r)), onclick: (e) => e.stopPropagation(), onchange: (e) => { e.target.checked ? picked.add(idOf(r)) : picked.delete(idOf(r)); fire(); } })));
        for (const c of cols) {
          const v = c.render ? c.render(r) : valOf(c, r);
          tr.append(h('td', { class: [c.align || '', c.nowrap ? 'nw' : ''].join(' ').trim() || null, 'data-label': c.label || null }, v === null || v === undefined || v === '' ? '–' : v));
        }
        if (o.onRow) { tr.dataset.click = '1'; tr.tabIndex = 0; tr.addEventListener('click', (e) => { if (!e.target.closest('a, button, input, select, textarea, label')) o.onRow(r); }); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === tr) o.onRow(r); }); }
        tbody.append(tr);
      }
      foot.replaceChildren();
      foot.hidden = all.length <= pageSize && !o.footer;
      if (!foot.hidden) {
        foot.append(h('span', `${H.num(all.length)} dòng${pages > 1 ? ` · trang ${page + 1}/${pages}` : ''}`));
        if (o.footer) foot.append(o.footer); // append(null) in ra chữ "null"
        if (pages > 1) foot.append(h('span.h-row', H.btn('‹ Trước', () => { page = Math.max(0, page - 1); paint(); }, 'ghost', { disabled: page === 0 }), H.btn('Sau ›', () => { page = Math.min(pages - 1, page + 1); paint(); }, 'ghost', { disabled: page >= pages - 1 })));
      }
    }
    head(); paint();
    wrap.update = (next) => { rows = next || []; const ids = new Set(rows.map(idOf)); for (const id of [...picked]) if (!ids.has(id)) picked.delete(id); paint(); };
    wrap.selected = () => rows.filter((r) => picked.has(idOf(r)));
    wrap.clearSelection = () => { picked.clear(); head(); paint(); fire(); };
    return wrap;
  };

  // ───────────── Lọc, tab, tìm kiếm ─────────────
  /** Nhóm chip lọc: H.chips([{ key, label, count }], 'all', (k) => …). Trả về phần tử có .set(key) và .counts(map). */
  H.chips = (opts, value, onChange) => {
    const box = h('div.h-chips', { role: 'group' });
    const paint = () => {
      box.replaceChildren(...opts.map((x) => h('button.chip', { type: 'button', 'aria-pressed': String(x.key === value), onclick: () => { if (x.key === value) return; value = x.key; paint(); onChange(value); } }, x.label, x.count !== undefined && x.count !== null ? [' ', h('b', String(x.count))] : null)));
    };
    paint();
    box.set = (k) => { value = k; paint(); };
    box.counts = (m) => { for (const x of opts) if (m[x.key] !== undefined) x.count = m[x.key]; paint(); };
    return box;
  };
  /** Nút chọn một trong vài giá trị (tuần / tháng …). */
  H.seg = (opts, value, onChange) => {
    const box = h('div.h-seg', { role: 'group' });
    const paint = () => box.replaceChildren(...opts.map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(k === value), onclick: () => { if (k === value) return; value = k; paint(); onChange(k); } }, label)));
    paint();
    box.set = (k) => { value = k; paint(); };
    return box;
  };
  /** Tab: H.tabs([['list','Danh sách', badge?]], 'list', (k) => …). */
  H.tabs = (opts, value, onChange) => {
    const box = h('div.h-tabs', { role: 'tablist' });
    const paint = () => box.replaceChildren(...opts.map(([k, label, n]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(k === value), onclick: () => { if (k === value) return; value = k; paint(); onChange(k); } }, label, H.badge(n, 'blue'))));
    paint();
    box.set = (k) => { value = k; paint(); };
    return box;
  };
  /** Ô tìm kiếm có trễ 200 ms. */
  H.search = (placeholder, onInput, value = '') => {
    let t;
    const i = h('input.search', { type: 'search', placeholder, value, autocomplete: 'off', 'aria-label': placeholder });
    i.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => onInput(i.value.trim()), 200); });
    return i;
  };
  /** Tìm không phân biệt dấu: H.match('Gò Vấp', 'go vap') → true. */
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  H.fold = fold;
  H.match = (text, q) => !q || fold(text).includes(fold(q));

  // ───────────── Trạng thái tải ─────────────
  H.loading = (lines = 4) => h('div.h-loading', { 'aria-busy': 'true', 'aria-label': 'Đang tải' }, Array.from({ length: lines }, (_, i) => h('div.h-skel', { style: { width: `${90 - i * 12}%` } })));
  H.empty = (text, ...actions) => h('div.h-empty', h('p', text), actions.length ? h('div.h-row', actions) : null);
  H.error = (err, retry) => h('div.h-err', { role: 'alert' }, h('p', (err && err.message) || 'Không tải được dữ liệu.'), retry ? H.btn('Thử lại', retry) : null);
  /**
   * Vùng tự nạp: H.async(node, async () => Node) — hiện khung chờ, gọi hàm, thay nội dung; lỗi thì hiện nút thử lại.
   * Trả về reload(); lần nạp lại sau giữ nội dung cũ cho tới khi có dữ liệu mới (không nháy trắng).
   */
  H.async = (node, render) => {
    let gen = 0, first = true;
    const reload = async () => {
      const my = ++gen;
      if (first) node.replaceChildren(H.loading());
      try {
        const out = await render();
        if (my !== gen) return;
        first = false;
        if (out !== undefined) node.replaceChildren(...(Array.isArray(out) ? out : [out]).filter(Boolean));
      } catch (e) {
        if (my !== gen) return;
        console.error(e);
        if (first) node.replaceChildren(H.error(e, reload)); else toast(e.message || 'Không tải lại được dữ liệu.', true);
      }
    };
    reload();
    return reload;
  };

  // ───────────── Biểu mẫu ─────────────
  /**
   * Trường nhập. f: { name, label, type, value, options, required, hint, placeholder, min, max, step, rows, full, disabled, multiple, list }
   * type: text | number | date | time | month | email | tel | password | textarea | select | checkbox | codes (danh sách mã, cách bởi dấu cách / xuống dòng) | hidden
   * options của select: [[value, label], …] hoặc { value: label }.
   */
  H.field = (f) => {
    const id = 'f' + Math.random().toString(36).slice(2, 9);
    let input;
    const common = { id, name: f.name, required: !!f.required, disabled: !!f.disabled, placeholder: f.placeholder || null };
    if (f.type === 'textarea' || f.type === 'codes') input = h('textarea', { ...common, rows: f.rows || (f.type === 'codes' ? 4 : 3), spellcheck: f.type === 'codes' ? 'false' : null }, f.value ?? '');
    else if (f.type === 'select') {
      const opts = Array.isArray(f.options) ? f.options : Object.entries(f.options || {});
      input = h('select', { ...common, multiple: !!f.multiple }, f.empty !== undefined ? h('option', { value: '' }, f.empty) : null, opts.map(([v, l]) => h('option', { value: String(v), selected: f.multiple ? (f.value || []).map(String).includes(String(v)) : String(v) === String(f.value ?? '') }, l)));
    } else if (f.type === 'checkbox') input = h('input', { ...common, type: 'checkbox', checked: !!f.value });
    else input = h('input', { ...common, type: f.type || 'text', value: f.value ?? '', min: f.min ?? null, max: f.max ?? null, step: f.step ?? null, inputmode: f.type === 'number' ? 'decimal' : null, autocomplete: f.autocomplete || 'off', list: f.list || null });
    if (f.type === 'hidden') return input;
    if (f.type === 'checkbox') return h('label.h-field.h-inline', { class: f.full ? 'h-full' : null, for: id }, input, h('span', f.label), f.hint ? h('small', { style: { gridColumn: '2' } }, f.hint) : null);
    return h('label.h-field', { class: f.full || f.type === 'textarea' || f.type === 'codes' ? 'h-full' : null, for: id }, h('span', f.label, f.required ? h('i', ' *') : null), input, f.hint ? h('small', f.hint) : null);
  };
  /** Đọc giá trị biểu mẫu theo khai báo trường (số → Number, checkbox → boolean, codes → mảng mã in hoa). */
  H.values = (form, fields) => {
    const out = {};
    for (const f of fields) {
      if (!f.name) continue;
      const n = form.querySelector(`[name="${CSS.escape(f.name)}"]`);
      if (!n) continue;
      if (f.type === 'checkbox') out[f.name] = n.checked;
      else if (f.type === 'number') out[f.name] = n.value === '' ? null : Number(String(n.value).replace(',', '.'));
      else if (f.type === 'codes') out[f.name] = String(n.value).split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
      else if (f.type === 'select' && f.multiple) out[f.name] = [...n.selectedOptions].map((o) => o.value);
      else out[f.name] = typeof n.value === 'string' ? n.value.trim() : n.value;
      if (f.type === 'select' && f.numeric && out[f.name] !== '') out[f.name] = Number(out[f.name]);
    }
    return out;
  };
  /**
   * Hộp thoại biểu mẫu. o: { title, intro (chuỗi / Node), fields, submit = 'Lưu', danger, wide, xl, cancel = 'Thôi', extra (Node chèn sau trường),
   *   onSubmit(values, { close, setErr, body }) → trả về false để giữ hộp thoại mở }.
   * Kiểm tra trường bắt buộc trước khi gửi. Trả về Promise kết quả của onSubmit (hoặc null nếu đóng).
   */
  H.form = (o) => new Promise((resolve) => {
    const fields = o.fields || [];
    const form = h('form.h-form', { novalidate: true, onsubmit: (e) => e.preventDefault() },
      o.intro ? (o.intro instanceof Node ? o.intro : h('p.sub', o.intro)) : null,
      fields.length ? h('div.h-fields', fields.map(H.field)) : null,
      o.extra || null);
    let result = null;
    const m = modal({
      title: o.title, body: form, wide: !!o.wide, cls: o.xl ? 'h-xl' : '', onClose: () => resolve(result),
      actions: [
        { label: o.cancel || 'Thôi', cls: 'ghost', run: () => {} },
        { label: o.submit || 'Lưu', cls: o.danger ? 'primary danger-bg' : 'primary', run: async (ctl) => {
          for (const f of fields) {
            if (!f.required || !f.name) continue;
            const n = form.querySelector(`[name="${CSS.escape(f.name)}"]`);
            if (n && (f.type === 'checkbox' ? !n.checked : !String(n.value).trim())) { ctl.setErr(`Cần nhập: ${f.label}.`); n.focus(); return false; }
          }
          const vals = H.values(form, fields);
          const r = await o.onSubmit(vals, { ...ctl, form });
          if (r === false) return false;
          result = r === undefined ? vals : r;
          return true;
        } },
      ],
    });
    const first = form.querySelector('input:not([type="hidden"]):not([type="checkbox"]), select, textarea');
    if (first && !o.noFocus && !matchMedia('(pointer: coarse)').matches) setTimeout(() => { const a = document.activeElement; if (!(a && a !== first && a.matches('input, select, textarea') && form.contains(a))) first.focus(); }, 30); // điện thoại: không tự bật bàn phím; đang gõ ô khác thì không giật con trỏ
    form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); $$('.dlg-foot button', m.el).pop().click(); } });
  });
  /** Hỏi lý do (nhiều thao tác bắt buộc ghi lý do). Trả về chuỗi hoặc null nếu thôi. */
  H.reason = async (title, opt = {}) => {
    const r = await H.form({ title, intro: opt.intro, submit: opt.submit || 'Xác nhận', danger: !!opt.danger, fields: [{ name: 'reason', label: opt.label || 'Lý do', type: 'textarea', required: true, rows: 2, value: opt.value || '', placeholder: opt.placeholder || '' }], onSubmit: (v, c) => { if (v.reason.length < 3) { c.setErr('Ghi rõ hơn một chút (ít nhất 3 ký tự).'); return false; } return v; } });
    return r ? r.reason : null;
  };
  H.confirm = ARL.ask;

  // ───────────── Menu nhỏ ─────────────
  /** Đặt khung nổi sát nút neo, không tràn khỏi màn hình (gọi lại khi nội dung đổi kích thước). */
  H.place = (pop, anchor) => {
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, ht = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
    pop.style.top = `${r.bottom + 4 + ht > window.innerHeight ? Math.max(8, r.top - ht - 4) : r.bottom + 4}px`;
  };
  /** Mở menu cạnh nút: H.menu(btn, [{ label, run, danger, hidden }, '-', …]). */
  H.menu = (anchor, items) => {
    $$('.h-pop').forEach((p) => p.remove());
    const pop = h('div.h-pop', { role: 'menu' });
    for (const it of items) {
      if (!it || it.hidden) continue;
      if (it === '-') { pop.append(h('hr')); continue; }
      pop.append(H.btn(it.label, async () => { pop.remove(); await it.run(); }, it.danger ? 'ghost danger' : 'ghost', { role: 'menuitem' }));
    }
    (anchor.closest('dialog[open]') || document.body).append(pop); // trong hộp thoại thì gắn vào hộp thoại, không bị lớp trên cùng che
    H.place(pop, anchor);
    const off = (e) => { if (!pop.contains(e.target) && e.target !== anchor) { pop.remove(); document.removeEventListener('pointerdown', off, true); } };
    setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
    const first = pop.querySelector('button');
    if (first) first.focus();
    pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { pop.remove(); anchor.focus(); } });
    return pop;
  };
  /** Nút "⋯" mở menu thao tác. */
  H.more = (items, label = 'Thao tác khác') => { const b = h('button.ghost', { type: 'button', 'aria-label': label, title: label }, '⋯'); b.addEventListener('click', (e) => { e.stopPropagation(); H.menu(b, typeof items === 'function' ? items() : items); }); return b; };

  // ───────────── Tải tệp CSV xuất từ máy chủ ─────────────
  /** Link tải CSV: H.csv('/api/hub/export/kits.csv', { q: … }, 'Tải CSV'). Bản xem thử không có máy chủ thì nút tự ẩn. */
  H.csv = (path, query, label = 'Tải CSV') => {
    const a = h('a.btn', { href: path.replace(/^\//, '') + (query ? '?' + new URLSearchParams(query) : ''), download: '' }, label);
    if (ARL.demo) a.hidden = true;
    return a;
  };

  // ───────────── Kỳ báo cáo ─────────────
  /** Chọn tuần / tháng: H.period('week', (p) => …). */
  H.period = (value, onChange) => H.seg([['week', 'Tuần'], ['month', 'Tháng']], value, onChange);
})();
