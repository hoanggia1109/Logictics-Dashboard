/* Ops Hub — biểu đồ SVG thuần (ARL.chart) và vài khối dựng dùng chung cho các màn hình bảng số (ARL.dash).
   - Biểu đồ tự đo bề rộng khung chứa và vẽ lại khi khung đổi cỡ: chữ trên trục luôn rõ, kể cả ở màn hình 360 px.
   - Màu theo tên tone (blue go wait lost violet teal rose off ink) → biến CSS, nên tự đúng ở chế độ tối.
   - Rê chuột, chạm, hoặc Tab rồi dùng phím mũi tên để xem từng số; Enter = bấm (nếu có onClick).
   - Nhãn và số từ máy chủ luôn đi qua textContent, không ghép vào innerHTML. */
(() => {
  'use strict';
  const H = ARL.H, { h } = H;
  const NS = 'http://www.w3.org/2000/svg';
  const TONES = new Set(['blue', 'go', 'wait', 'lost', 'violet', 'teal', 'rose', 'off', 'ink']);
  /** Thứ tự màu mặc định cho các chuỗi không khai báo tone (cố định theo vị trí, không xoay vòng theo hạng). */
  const ORDER = ['blue', 'teal', 'violet', 'rose', 'wait', 'go', 'off'];
  const toneOf = (t, i) => (TONES.has(t) ? t : ORDER[i % ORDER.length]);
  const numOrNull = (v) => (v === null || v === undefined || v === '' || Number.isNaN(+v) ? null : +v);

  // ───────────── Tiện ích vẽ ─────────────
  function s(tag, attrs, text) {
    const n = document.createElementNS(NS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) n.setAttribute(k, String(v));
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  let mctx = null;
  /** Bề rộng chữ (px) theo phông của ứng dụng; không đo được thì ước lượng. */
  function tw(text, size = 11, weight = 400) {
    if (mctx === null) { try { mctx = document.createElement('canvas').getContext('2d') || false; } catch { mctx = false; } }
    if (!mctx) return String(text).length * size * 0.58;
    mctx.font = `${weight} ${size}px "Be Vietnam Pro", system-ui, sans-serif`;
    return mctx.measureText(String(text)).width;
  }
  /** Cắt chữ cho vừa bề rộng, thêm "…". */
  function fit(text, max, size = 11, weight = 400) {
    text = String(text ?? '');
    if (tw(text, size, weight) <= max) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tw(text.slice(0, mid) + '…', size, weight) <= max) lo = mid; else hi = mid - 1; }
    return lo ? text.slice(0, lo).trimEnd() + '…' : '…';
  }
  const autoFmt = (v) => (v === null || v === undefined || Number.isNaN(+v) ? '–' : H.num(v, Math.abs(v) < 100 && v % 1 ? 1 : 0));
  const axisFmt = (step) => { const d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2; return (v) => (Math.abs(v) >= 1e6 ? `${H.num(v / 1e6, 1)} tr` : H.num(v, d)); };
  /** Vạch chia "đẹp" (1, 2, 2,5, 5 × 10ⁿ); dữ liệu số nguyên thì bước nguyên. */
  function ticks(min, max, count, integer) {
    if (!(max > min)) max = min + (integer ? Math.max(1, count) : 1);
    const raw = (max - min) / Math.max(1, count);
    const mag = 10 ** Math.floor(Math.log10(raw));
    const steps = integer ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
    let step = (steps.find((x) => raw <= x * mag * (1 + 1e-9)) || 10) * mag;
    if (integer) step = Math.max(1, Math.round(step));
    const lo = Math.floor(min / step + 1e-9) * step;
    let hi = Math.ceil(max / step - 1e-9) * step;
    if (hi <= lo) hi = lo + step;
    const list = [];
    for (let v = lo; v <= hi + step * 1e-6; v += step) list.push(+v.toFixed(10));
    return { lo, hi, step, list };
  }
  /** Cột / thanh: bo tròn 4 px ở đầu dữ liệu, vuông ở đường gốc. dir: 'up' | 'right'. */
  function barPath(x, y, w, ht, dir = 'up', r = 4) {
    if (w <= 0 || ht <= 0) return '';
    if (dir === 'up') {
      r = Math.min(r, w / 2, ht);
      return `M${x},${y + ht}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + ht}Z`;
    }
    r = Math.min(r, ht / 2, w);
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + ht - r}Q${x + w},${y + ht} ${x + w - r},${y + ht}H${x}Z`;
  }
  /** Chỉ số nhãn trục ngang được hiện (giãn cách cho khỏi chồng chữ; luôn giữ nhãn cuối — kỳ gần nhất). */
  function thin(labels, spacing, size = 11) {
    const widest = Math.max(1, ...labels.map((l) => tw(l, size))) + 10;
    const step = Math.max(1, Math.ceil(widest / Math.max(1, spacing)));
    const n = labels.length;
    return (i) => (n - 1 - i) % step === 0;
  }
  const sum = (arr) => arr.reduce((a, v) => a + (v || 0), 0);

  // ───────────── Khung chung: đo bề rộng, tooltip, chuột / chạm / bàn phím ─────────────
  let openTip = null;
  document.addEventListener('pointerdown', (e) => { if (openTip && !openTip.wrap.contains(e.target)) openTip.hide(); }, true);
  const RO = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
    for (const e of entries) {
      const w = e.target;
      if (!w.isConnected) { RO.unobserve(w); continue; }
      const width = Math.floor(e.contentRect.width);
      if (width > 40 && Math.abs(width - (w._chW || 0)) >= 2 && w._chDraw) w._chDraw(width);
    }
  }) : null;

  /**
   * frame(kind, o, build, opt) — build(width) trả về { svg, n, at(i) → { x, y, title, rows: [{ tone, name, value, key }] }, hit(x, y, target) → i, mark(i), extra }.
   * opt.fixed: không phụ thuộc bề rộng (donut, gauge, spark). opt.focusable = false: không nhận Tab (spark).
   */
  function frame(kind, o, build, opt = {}) {
    const wrap = h(`div.ch.ch-${kind}`, o.className ? { class: o.className } : null);
    const tip = h('div.ch-tip', { hidden: true, 'aria-hidden': 'true' });
    const say = h('span.ch-sr', { 'aria-live': 'polite' });
    let cur = null, idx = -1;
    const focusable = opt.focusable !== false;
    if (focusable) {
      wrap.tabIndex = 0;
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', `${o.aria || o.title || 'Biểu đồ'}. Dùng phím mũi tên để xem từng số.`);
    }
    const toSvg = (cx, cy) => {
      const r = cur.svg.getBoundingClientRect(), k = r.width ? r.width / (cur.w || r.width) : 1;
      return { x: (cx - r.left) / k, y: (cy - r.top) / k };
    };
    function place(pt) {
      const sr = cur.svg.getBoundingClientRect(), wr = wrap.getBoundingClientRect(), k = sr.width ? sr.width / (cur.w || sr.width) : 1;
      const px = sr.left - wr.left + pt.x * k, py = sr.top - wr.top + pt.y * k;
      const tw0 = tip.offsetWidth, th0 = tip.offsetHeight, W = wrap.clientWidth;
      let left = px - tw0 / 2;
      left = Math.max(0, Math.min(W - tw0, left));
      let top = py - th0 - 12;
      if (top < -4) top = py + 16;
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(top)}px`;
    }
    function show(i) {
      if (!cur || i < 0 || i >= cur.n) return hide();
      idx = i;
      const a = cur.at(i);
      if (!a) return hide();
      cur.mark(i);
      H.clear(tip,
        a.title ? h('b.ch-tip-t', a.title) : null,
        (a.rows || []).map((r) => h('div.ch-tip-r', h('i', { class: `k-${r.key || 'rect'}`, 'data-tone': r.tone }), h('b', r.value), r.name ? h('span', r.name) : null)),
        a.note ? h('div.ch-tip-n', a.note) : null);
      tip.hidden = false;
      place(a);
      say.textContent = `${a.title ? a.title + ': ' : ''}${(a.rows || []).map((r) => `${r.name ? r.name + ' ' : ''}${r.value}`).join(', ')}`;
      openTip = api;
    }
    function hide() {
      idx = -1;
      tip.hidden = true;
      if (cur) cur.mark(-1);
      if (openTip === api) openTip = null;
    }
    const api = { wrap, hide };
    function draw(width) {
      wrap._chW = width;
      const keep = idx;
      cur = build(width);
      cur.w = width;
      wrap.replaceChildren(cur.svg, ...(cur.extra || []), tip, say);
      if (keep >= 0 && !tip.hidden) show(keep); else hide();
    }
    wrap._chDraw = opt.fixed ? null : draw;
    draw(opt.fixed ? 0 : o.width || 560);
    if (RO && !opt.fixed) RO.observe(wrap);

    wrap.addEventListener('pointermove', (e) => {
      if (!cur || e.pointerType === 'touch') return;
      const p = toSvg(e.clientX, e.clientY);
      const i = cur.hit(p.x, p.y, e.target);
      if (i !== idx) { if (i >= 0) show(i); else hide(); }
    });
    wrap.addEventListener('pointerdown', (e) => {
      if (!cur || e.pointerType === 'mouse') return;
      const p = toSvg(e.clientX, e.clientY);
      const i = cur.hit(p.x, p.y, e.target);
      if (i >= 0) show(i); else hide();
    });
    wrap.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && document.activeElement !== wrap) hide(); });
    if (o.onClick) {
      wrap.dataset.click = '1';
      wrap.addEventListener('click', (e) => {
        if (!cur) return;
        const p = toSvg(e.clientX, e.clientY);
        const i = cur.hit(p.x, p.y, e.target);
        if (i >= 0) o.onClick(i);
      });
    }
    if (focusable) {
      wrap.addEventListener('focus', () => { if (cur && cur.n && idx < 0) show(cur.start ?? cur.n - 1); });
      wrap.addEventListener('blur', hide);
      wrap.addEventListener('keydown', (e) => {
        if (!cur || !cur.n) return;
        const k = e.key;
        let i = idx < 0 ? (cur.start ?? cur.n - 1) : idx;
        if (k === 'ArrowRight' || k === 'ArrowDown') i = Math.min(cur.n - 1, i + 1);
        else if (k === 'ArrowLeft' || k === 'ArrowUp') i = Math.max(0, i - 1);
        else if (k === 'Home') i = 0;
        else if (k === 'End') i = cur.n - 1;
        else if (k === 'Escape') { hide(); return; }
        else if (k === 'Enter' && o.onClick && idx >= 0) { e.preventDefault(); o.onClick(idx); return; }
        else return;
        e.preventDefault();
        show(i);
      });
    }
    return wrap;
  }
  function emptyChart(o, height, text) {
    return h('div.ch.ch-empty', { style: { minHeight: `${Math.min(height || 160, 140)}px` }, role: 'img', 'aria-label': `${o.title || 'Biểu đồ'}: chưa có số liệu` }, h('span', text || o.empty || 'Chưa có số liệu trong kỳ này.'));
  }
  const svgRoot = (W, Ht, aria) => s('svg', { viewBox: `0 0 ${W} ${Ht}`, width: W, height: Ht, role: 'img', 'aria-label': aria, class: 'ch-svg', focusable: 'false' });
  const legendKey = (kind) => (kind === 'line' ? 'line' : kind === 'dash' ? 'dash' : 'rect');

  /** Chú thích: ARL.chart.legend([{ label, tone, value }], { key: 'rect'|'line'|'dash' }). */
  function legend(items, opt = {}) {
    return h('div.ch-legend', (items || []).map((it, i) => h('span.ch-lg', h('i', { class: `k-${it.key || opt.key || 'rect'}`, 'data-tone': toneOf(it.tone, i) }), h('span', it.label), it.value !== undefined && it.value !== null && it.value !== '' ? h('b', typeof it.value === 'number' ? H.num(it.value, it.value % 1 ? 1 : 0) : it.value) : null)));
  }

  // ───────────── Đường (xu hướng) ─────────────
  function line(o) {
    const labels = (o.labels || []).map(String);
    const series = (o.series || []).map((x, i) => ({ ...x, tone: toneOf(x.tone, i), data: (x.data || []).map(numOrNull) }));
    const n = labels.length || Math.max(0, ...series.map((x) => x.data.length));
    const Ht = o.height || 220, fmt = o.format || autoFmt;
    const vals = series.flatMap((x) => x.data.slice(0, n)).filter((v) => v !== null);
    if (!n || !vals.length) return emptyChart(o, Ht);
    const integer = vals.every(Number.isInteger) && (!o.target || Number.isInteger(o.target.value));
    const lastOf = (d) => { for (let i = Math.min(n, d.length) - 1; i >= 0; i--) if (d[i] !== null) return i; return -1; };
    const firstOf = (d) => d.findIndex((v) => v !== null);
    const aria = o.aria || `${o.title || 'Xu hướng'}: ${series.map((x) => { const a = firstOf(x.data), b = lastOf(x.data); return `${x.name || ''} từ ${fmt(x.data[a])} (${labels[a] || ''}) đến ${fmt(x.data[b])} (${labels[b] || ''})`; }).join('; ')}`;
    const lg = series.length > 1 && o.legend !== false ? legend(series.map((x) => ({ label: x.name, tone: x.tone, key: x.dashed ? 'dash' : 'line' }))) : null;
    return frame('line', { ...o, aria }, (W) => {
      const top = o.target && o.target.label ? 20 : 12, bottom = 24;
      const plotH = Math.max(40, Ht - top - bottom);
      const hiData = Math.max(...vals, o.target ? o.target.value : -Infinity);
      const loData = Math.min(...vals, o.target ? o.target.value : Infinity);
      const T = ticks(o.yMin ?? Math.min(0, loData), o.yMax ?? hiData, Math.max(2, Math.min(5, Math.floor(plotH / 42))), integer);
      const lo = o.yMin ?? T.lo, hi = o.yMax ?? T.hi;
      const af = o.yFormat || axisFmt(T.step);
      const left = Math.ceil(Math.max(...T.list.map((v) => tw(af(v))))) + 12, right = 14;
      const pw = Math.max(20, W - left - right);
      const X = (i) => left + (n === 1 ? pw / 2 : (i * pw) / (n - 1));
      const Y = (v) => top + plotH - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo || 1)) * plotH;
      const svg = svgRoot(W, Ht, aria);
      const g = s('g', { class: 'ch-axes' });
      for (const v of T.list) {
        if (v < lo - 1e-9 || v > hi + 1e-9) continue;
        g.append(s('line', { x1: left, x2: W - right, y1: Y(v), y2: Y(v), class: v === 0 ? 'ch-base' : 'ch-grid' }));
        g.append(s('text', { x: left - 8, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'ch-ax' }, af(v)));
      }
      const showX = thin(labels, n > 1 ? pw / (n - 1) : pw);
      labels.forEach((l, i) => {
        if (!showX(i)) return;
        const x = X(i), wl = tw(l);
        const anchor = x - wl / 2 < 0 ? 'start' : x + wl / 2 > W ? 'end' : 'middle';
        g.append(s('text', { x: anchor === 'start' ? Math.max(0, x - 6) : anchor === 'end' ? Math.min(W, x + 6) : x, y: Ht - 6, 'text-anchor': anchor, class: 'ch-ax' }, l));
      });
      svg.append(g);
      if (o.target && o.target.value !== undefined && o.target.value !== null) {
        const ty = Y(o.target.value);
        svg.append(s('line', { x1: left, x2: W - right, y1: ty, y2: ty, class: 'ch-target' }));
        if (o.target.label) svg.append(s('text', { x: left + 4, y: ty - 5, class: 'ch-ax ch-target-t' }, o.target.label));
      }
      const base = Y(Math.max(lo, Math.min(hi, 0)));
      for (const x of series) {
        const segs = [];
        let segc = null;
        // Kỳ cuối đang chạy (o.partial): đoạn cuối nét đứt, chấm rỗng — số còn tăng, không phải sụt giảm.
        const tail = o.partial && n > 1 && x.data[n - 1] !== null && x.data[n - 1] !== undefined && x.data[n - 2] !== null && x.data[n - 2] !== undefined;
        const upto = tail ? n - 1 : n;
        for (let i = 0; i < upto; i++) {
          const v = x.data[i] ?? null;
          if (v === null) { segc = null; continue; }
          if (!segc) { segc = []; segs.push(segc); }
          segc.push([X(i), Y(v)]);
        }
        const sg = s('g', { 'data-tone': x.tone, class: 'ch-ser' });
        for (const seg of segs) {
          if (x.area && seg.length > 1) sg.append(s('path', { d: `M${seg.map((p) => p.join(',')).join('L')}L${seg[seg.length - 1][0]},${base}L${seg[0][0]},${base}Z`, class: 'ch-area' }));
          if (seg.length > 1) sg.append(s('path', { d: `M${seg.map((p) => p.join(',')).join('L')}`, class: `ch-line${x.dashed ? ' ch-dash' : ''}` }));
          else sg.append(s('circle', { cx: seg[0][0], cy: seg[0][1], r: 2.5, class: 'ch-pt' }));
        }
        if (tail) sg.append(s('path', { d: `M${X(n - 2)},${Y(x.data[n - 2])}L${X(n - 1)},${Y(x.data[n - 1])}`, class: 'ch-line ch-dash' }));
        const li = lastOf(x.data);
        if (li >= 0 && !x.dashed) sg.append(s('circle', { cx: X(li), cy: Y(x.data[li]), r: 3.5, class: tail && li === n - 1 ? 'ch-dot ch-dot-open' : 'ch-dot' }));
        if (li >= 0 && series.length === 1 && o.endLabel !== false) {
          const prevV = li > 0 ? x.data[li - 1] : null, below = prevV !== null && prevV !== undefined && prevV > x.data[li] && Y(x.data[li]) + 22 < top + plotH;
          const t = fmt(x.data[li]), tx = X(li), ty = below ? Y(x.data[li]) + 19 : Y(x.data[li]) - 9, half = tw(t, 11.5, 600) / 2;
          const anchor = tx + half > W - 1 ? 'end' : tx - half < left ? 'start' : 'middle';
          sg.append(s('text', { x: anchor === 'end' ? Math.min(W - 1, tx + 4) : tx, y: Math.max(11, ty), 'text-anchor': anchor, class: 'ch-val' }, t));
        }
        svg.append(sg);
      }
      const hv = s('g', { class: 'ch-hover', visibility: 'hidden' });
      const cross = s('line', { y1: top, y2: top + plotH, class: 'ch-cross' });
      hv.append(cross);
      const dots = series.map((x) => { const c = s('circle', { r: 4, class: 'ch-dot', 'data-tone': x.tone }); hv.append(c); return c; });
      svg.append(hv);
      return {
        svg, n, extra: lg ? [lg] : [],
        hit: (px) => (px < left - 14 || px > W - right + 14 ? -1 : n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((px - left) / pw) * (n - 1))))),
        mark: (i) => {
          if (i < 0) { hv.setAttribute('visibility', 'hidden'); return; }
          hv.setAttribute('visibility', 'visible');
          cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i));
          series.forEach((x, k) => { const v = x.data[i] ?? null; dots[k].setAttribute('visibility', v === null ? 'hidden' : 'visible'); if (v !== null) { dots[k].setAttribute('cx', X(i)); dots[k].setAttribute('cy', Y(v)); } });
        },
        at: (i) => {
          const ys = series.map((x) => x.data[i]).filter((v) => v !== null && v !== undefined).map(Y);
          return { x: X(i), y: ys.length ? Math.min(...ys) : top, title: labels[i], rows: series.map((x) => ({ tone: x.tone, name: x.name, value: x.data[i] === null || x.data[i] === undefined ? 'chưa có số' : fmt(x.data[i]), key: x.dashed ? 'dash' : 'line' })), note: o.note ? o.note(i) : o.partial && i === n - 1 ? (typeof o.partial === 'string' ? o.partial : 'Kỳ đang chạy, số còn tăng') : null };
        },
      };
    });
  }

  // ───────────── Cột / thanh (gộp, chồng, nằm ngang) ─────────────
  function bar(o) {
    const labels = (o.labels || []).map(String);
    const series = (o.series || []).map((x, i) => ({ ...x, tone: toneOf(x.tone, i), data: (x.data || []).map(numOrNull) }));
    const n = labels.length, m = series.length;
    const fmt = o.format || autoFmt;
    const stacked = !!o.stacked && m > 1;
    const vals = series.flatMap((x) => x.data.slice(0, n)).filter((v) => v !== null);
    if (!n || !m || !vals.length) return emptyChart(o, o.height || 220);
    const totals = labels.map((_, i) => sum(series.map((x) => x.data[i])));
    const integer = vals.every(Number.isInteger);
    const aria = o.aria || `${o.title || 'Biểu đồ cột'}: ${labels.map((l, i) => `${l} ${m === 1 ? fmt(series[0].data[i]) : fmt(totals[i])}`).slice(0, 24).join(', ')}`;
    const lg = m > 1 && o.legend !== false ? legend(series.map((x) => ({ label: x.name, tone: x.tone }))) : null;
    // Một chuỗi mà từng cột mang màu riêng (vd. đạt / dưới chuẩn): o.toneAt(i) → tone.
    const toneI = (x, i) => (m === 1 && o.toneAt && TONES.has(o.toneAt(i)) ? o.toneAt(i) : x.tone);
    const rowsOf = (i) => {
      const rows = series.map((x) => ({ tone: toneI(x, i), name: x.name, value: fmt(x.data[i]), key: 'rect' }));
      if (stacked) rows.push({ tone: 'ink', name: 'Tổng', value: fmt(totals[i]), key: 'none' });
      return rows;
    };
    if (o.horizontal) {
      const rowH = o.rowHeight || 30, Ht = o.height || n * rowH + 6;
      const step = (Ht - 6) / n;
      return frame('bar ch-hbar', { ...o, aria }, (W) => {
        const maxV = Math.max(0, ...(stacked ? totals : vals), o.target ? o.target.value : 0) || 1;
        const valW = Math.ceil(Math.max(...labels.map((_, i) => tw(fmt(stacked ? totals[i] : m === 1 ? series[0].data[i] : Math.max(...series.map((x) => x.data[i] || 0))), 11.5, 600)))) + 10;
        const labW = Math.min(Math.round(W * (o.labelShare || 0.42)), Math.ceil(Math.max(...labels.map((l) => tw(l, 12)))) + 12);
        const x0 = labW, pw = Math.max(20, W - labW - valW);
        const X = (v) => (Math.max(0, v) / maxV) * pw;
        const thick = stacked || m === 1 ? Math.min(16, step * 0.56) : Math.min(12, (step * 0.72 - (m - 1) * 2) / m);
        const svg = svgRoot(W, Ht, aria);
        const band = s('rect', { x: 0, width: W, height: step, class: 'ch-band', visibility: 'hidden', rx: 6 });
        svg.append(band);
        svg.append(s('line', { x1: x0, x2: x0, y1: 2, y2: Ht - 4, class: 'ch-base' }));
        labels.forEach((l, i) => {
          const cy = 3 + step * i + step / 2;
          svg.append(s('text', { x: labW - 10, y: cy + 4, 'text-anchor': 'end', class: 'ch-lab' }, fit(l, labW - 14, 12)));
          let acc = 0;
          series.forEach((x, k) => {
            const v = x.data[i] || 0;
            if (stacked) {
              const wv = X(acc + v) - X(acc), isLast = series.slice(k + 1).every((y) => !(y.data[i] > 0));
              if (wv > 0) svg.append(s('path', { d: isLast ? barPath(x0 + X(acc) + (acc ? 1 : 0), cy - thick / 2, Math.max(1, wv - (acc ? 1 : 0)), thick, 'right') : `M${x0 + X(acc) + (acc ? 1 : 0)},${cy - thick / 2}h${Math.max(1, wv - (acc ? 2 : 1))}v${thick}h${-Math.max(1, wv - (acc ? 2 : 1))}Z`, 'data-tone': x.tone, class: 'ch-bar' }));
              acc += v;
            } else {
              const y = m === 1 ? cy - thick / 2 : cy - (m * thick + (m - 1) * 2) / 2 + k * (thick + 2);
              if (v > 0) svg.append(s('path', { d: barPath(x0, y, Math.max(2, X(v)), thick, 'right'), 'data-tone': toneI(x, i), class: 'ch-bar' }));
            }
          });
          const tv = stacked ? totals[i] : m === 1 ? series[0].data[i] : null;
          if (tv !== null && o.values !== false) svg.append(s('text', { x: x0 + X(tv) + 6, y: cy + 4, class: 'ch-val' }, fmt(tv)));
        });
        if (o.target) { const tx = x0 + X(o.target.value); svg.append(s('line', { x1: tx, x2: tx, y1: 2, y2: Ht - 4, class: 'ch-target' })); }
        return {
          svg, n, start: 0, extra: lg ? [lg] : [],
          hit: (px, py) => { const i = Math.floor((py - 3) / step); return i >= 0 && i < n ? i : -1; },
          mark: (i) => { if (i < 0) band.setAttribute('visibility', 'hidden'); else { band.setAttribute('y', 3 + step * i); band.setAttribute('visibility', 'visible'); } },
          at: (i) => ({ x: x0 + X(stacked ? totals[i] : Math.max(...series.map((x) => x.data[i] || 0))) / 2 + 20, y: 3 + step * i + 2, title: labels[i], rows: rowsOf(i) }),
        };
      });
    }
    const Ht = o.height || 220;
    return frame('bar', { ...o, aria }, (W) => {
      const top = 18, bottom = 24, plotH = Math.max(40, Ht - top - bottom);
      const hiData = Math.max(0, ...(stacked ? totals : vals), o.target ? o.target.value : 0);
      const loData = stacked ? 0 : Math.min(0, ...vals);
      const T = ticks(o.yMin ?? loData, o.yMax ?? hiData, Math.max(2, Math.min(5, Math.floor(plotH / 42))), integer);
      const lo = o.yMin ?? T.lo, hi = o.yMax ?? T.hi;
      const af = o.yFormat || axisFmt(T.step);
      const left = Math.ceil(Math.max(...T.list.map((v) => tw(af(v))))) + 12, right = 6;
      const pw = Math.max(20, W - left - right), band = pw / n;
      const Y = (v) => top + plotH - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo || 1)) * plotH;
      const y0 = Y(Math.max(lo, 0));
      const bw = stacked || m === 1 ? Math.min(o.barMax || 24, Math.max(3, band * 0.62)) : Math.min(16, Math.max(2, (band * 0.74 - (m - 1) * 2) / m));
      const svg = svgRoot(W, Ht, aria);
      const hl = s('rect', { y: top - 6, height: plotH + 6, width: band, class: 'ch-band', visibility: 'hidden', rx: 6 });
      svg.append(hl);
      for (const v of T.list) {
        if (v < lo - 1e-9 || v > hi + 1e-9) continue;
        svg.append(s('line', { x1: left, x2: W - right, y1: Y(v), y2: Y(v), class: v === 0 ? 'ch-base' : 'ch-grid' }));
        svg.append(s('text', { x: left - 8, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'ch-ax' }, af(v)));
      }
      const showX = thin(labels, band);
      // Số trên đầu cột: ít cột thì ghi hết; nhiều cột thì chỉ ghi cột cao nhất và cột cuối (kỳ gần nhất).
      const capV = (i) => (stacked ? totals[i] : series[0].data[i]);
      const capAll = n <= (o.valueMax || 7);
      const maxI = labels.reduce((b, _, i) => ((capV(i) ?? -Infinity) > (capV(b) ?? -Infinity) ? i : b), 0);
      const cf = o.capFormat || autoFmt;
      const capOn = (i) => o.values !== false && (m === 1 || stacked) && (o.values === 'all' || ((capAll || i === maxI || i === n - 1) && capV(i) !== 0)) && tw(cf(capV(i)), 11, 600) <= Math.max(band - 2, i === n - 1 || i === maxI ? 40 : 0);
      labels.forEach((l, i) => {
        const cx = left + band * i + band / 2;
        if (showX(i)) svg.append(s('text', { x: cx, y: Ht - 6, 'text-anchor': 'middle', class: 'ch-ax' }, fit(l, Math.max(band * 2.2, 40))));
        let acc = 0;
        series.forEach((x, k) => {
          const v = x.data[i];
          if (v === null || v === undefined || v === 0) return;
          if (stacked) {
            const yTop = Y(acc + v), yBot = Y(acc), isTop = series.slice(k + 1).every((y) => !(y.data[i] > 0));
            const gap = acc > 0 && yBot - yTop > 3 ? 2 : 0;
            const hgt = Math.max(1, yBot - yTop - gap);
            svg.append(s('path', { d: isTop ? barPath(cx - bw / 2, yTop, bw, hgt, 'up') : `M${cx - bw / 2},${yTop}h${bw}v${hgt}h${-bw}Z`, 'data-tone': x.tone, class: 'ch-bar' }));
            acc += v;
          } else {
            const x1 = m === 1 ? cx - bw / 2 : cx - (m * bw + (m - 1) * 2) / 2 + k * (bw + 2);
            if (v > 0) svg.append(s('path', { d: barPath(x1, Y(v), bw, Math.max(1.5, y0 - Y(v)), 'up'), 'data-tone': toneI(x, i), class: 'ch-bar' }));
            else svg.append(s('rect', { x: x1, y: y0, width: bw, height: Math.max(1.5, Y(v) - y0), 'data-tone': toneI(x, i), class: 'ch-bar' }));
          }
        });
        if (capOn(i)) { const tv = capV(i); if (tv !== null && tv !== undefined) { const t = cf(tv), half = tw(t, 11.5, 600) / 2; svg.append(s('text', { x: Math.min(W - half, Math.max(left + half, cx)), y: Y(Math.max(0, tv)) - 5, 'text-anchor': 'middle', class: 'ch-val' }, t)); } }
      });
      if (o.target && o.target.value !== undefined) {
        const ty = Y(o.target.value);
        svg.append(s('line', { x1: left, x2: W - right, y1: ty, y2: ty, class: 'ch-target' }));
        if (o.target.label) svg.append(s('text', { x: left + 4, y: ty - 5, class: 'ch-ax ch-target-t' }, o.target.label));
      }
      return {
        svg, n, extra: lg ? [lg] : [],
        hit: (px) => { const i = Math.floor((px - left) / band); return i >= 0 && i < n ? i : -1; },
        mark: (i) => { if (i < 0) hl.setAttribute('visibility', 'hidden'); else { hl.setAttribute('x', left + band * i); hl.setAttribute('visibility', 'visible'); } },
        at: (i) => ({ x: left + band * i + band / 2, y: Y(Math.max(0, stacked ? totals[i] : Math.max(...series.map((x) => x.data[i] || 0)))), title: labels[i], rows: rowsOf(i), note: o.note ? o.note(i) : null }),
      };
    });
  }

  // ───────────── Vành khuyên (cơ cấu) ─────────────
  function donut(o) {
    const items = (o.items || []).map((x, i) => ({ ...x, tone: toneOf(x.tone, i), value: Math.max(0, numOrNull(x.value) || 0) }));
    const total = sum(items.map((x) => x.value));
    const size = o.size || 180, fmt = o.format || autoFmt;
    const pctOf = (v) => (total ? H.pct(v / total, v / total < 0.1 && v ? 1 : 0) : '–');
    const aria = o.aria || `${o.title || 'Cơ cấu'}: ${items.map((x) => `${x.label} ${fmt(x.value)} (${pctOf(x.value)})`).join(', ')}`;
    let legendRows = [];
    const wrap = frame('donut', { ...o, aria }, () => {
      const r = size / 2 - 3, thick = o.thickness || Math.max(12, Math.round(size * 0.13)), ir = r - thick, c = size / 2;
      const svg = svgRoot(size, size, aria);
      const segs = [];
      const pt = (a, rad) => [c + rad * Math.cos(a), c + rad * Math.sin(a)];
      svg.append(s('circle', { cx: c, cy: c, r: r - thick / 2, class: 'ch-track', 'stroke-width': thick }));
      const live = items.filter((x) => x.value > 0);
      let a = -Math.PI / 2;
      const pad = live.length > 1 ? Math.min(0.06, 2 / r) : 0;
      items.forEach((x, i) => {
        if (!x.value) { segs.push(null); return; }
        const sweep = (x.value / total) * Math.PI * 2;
        const a0 = a + pad / 2, a1 = a + sweep - pad / 2;
        let d;
        if (live.length === 1) d = `M${c},${c - r}A${r},${r} 0 1 1 ${c - 0.01},${c - r}L${c - 0.01},${c - ir}A${ir},${ir} 0 1 0 ${c},${c - ir}Z`;
        else {
          const large = a1 - a0 > Math.PI ? 1 : 0;
          const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r), [x2, y2] = pt(a1, ir), [x3, y3] = pt(a0, ir);
          d = `M${x0},${y0}A${r},${r} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${ir},${ir} 0 ${large} 0 ${x3},${y3}Z`;
        }
        const p = s('path', { d, 'data-tone': x.tone, 'data-i': i, class: 'ch-seg' });
        svg.append(p);
        segs.push({ p, mid: a + sweep / 2 });
        a += sweep;
      });
      const cv = o.center ? o.center.value : fmt(total);
      if (cv !== null && cv !== undefined && cv !== '') {
        const fs = Math.max(16, Math.round(size * 0.15));
        svg.append(s('text', { x: c, y: o.center && o.center.label ? c + fs * 0.18 : c + fs * 0.35, 'text-anchor': 'middle', class: 'ch-center', style: `font-size:${fs}px` }, fit(cv, ir * 1.7, fs, 700)));
        if (o.center && o.center.label) svg.append(s('text', { x: c, y: c + fs * 0.18 + 16, 'text-anchor': 'middle', class: 'ch-center-l' }, fit(o.center.label, ir * 1.75, 11.5)));
      }
      const order = items.map((x, i) => i).filter((i) => segs[i]);
      legendRows = o.legend === false ? [] : items.map((x, i) => h('div.ch-dl-r', { 'data-i': i, 'data-zero': x.value ? null : '1' }, h('i', { class: 'k-rect', 'data-tone': x.tone }), h('span', { title: x.label }, x.label), h('b', fmt(x.value)), h('em', pctOf(x.value))));
      return {
        svg, n: order.length, start: 0,
        extra: o.legend === false ? [] : [h('div.ch-dl', legendRows)],
        hit: (px, py, target) => { const el = target && target.closest ? target.closest('[data-i]') : null; if (!el) return -1; const i = order.indexOf(+el.dataset.i); return i; },
        mark: (k) => {
          const i = k < 0 ? -1 : order[k];
          segs.forEach((sg, j) => { if (sg) sg.p.classList.toggle('dim', i >= 0 && j !== i); });
          legendRows.forEach((row, j) => row.classList.toggle('on', j === i));
        },
        at: (k) => { const i = order[k], sg = segs[i]; const [x, y] = pt(sg.mid, r - thick / 2); return { x, y: y - 4, title: items[i].label, rows: [{ tone: items[i].tone, name: pctOf(items[i].value), value: fmt(items[i].value), key: 'rect' }] }; },
      };
    }, { fixed: true });
    return wrap;
  }

  // ───────────── Đồng hồ (một chỉ số so với ngưỡng) ─────────────
  function gauge(o) {
    const max = o.max || 1, v = numOrNull(o.value), fmt = o.format || ((x) => (max === 1 ? H.pct(x) : autoFmt(x)));
    const bands = o.bands || [];
    const band = v === null ? null : bands.find((b) => v <= b.to) || bands[bands.length - 1];
    const tone = toneOf((band && band.tone) || o.tone || 'blue', 0);
    const aria = o.aria || `${o.label || o.title || 'Chỉ số'}: ${v === null ? 'chưa có số' : fmt(v)}${max !== 1 ? ` trên ${fmt(max)}` : ''}`;
    return frame('gauge', { ...o, aria }, () => {
      const W = o.size || 200, r = W / 2 - 10, thick = Math.max(10, Math.round(W * 0.075)), c = W / 2, cy = r + 8, Ht = cy + 24;
      const svg = svgRoot(W, Ht, aria);
      const P = (ratio, rad) => { const a = Math.PI * (1 + Math.max(0, Math.min(1, ratio))); return [c + rad * Math.cos(a), cy + rad * Math.sin(a)]; };
      const arc = (r0, r1) => { const [x0, y0] = P(r0, r - thick / 2), [x1, y1] = P(r1, r - thick / 2); return `M${x0},${y0}A${r - thick / 2},${r - thick / 2} 0 0 1 ${x1},${y1}`; };
      svg.append(s('path', { d: arc(0, 1), class: 'ch-gtrack', 'stroke-width': thick }));
      const ratio = v === null ? 0 : Math.max(0, Math.min(1, v / max));
      if (ratio > 0.002) svg.append(s('path', { d: arc(0, ratio), class: 'ch-garc', 'data-tone': tone, 'stroke-width': thick }));
      for (const b of bands) { if (!(b.to > 0 && b.to < max)) continue; const [xa, ya] = P(b.to / max, r + 1), [xb, yb] = P(b.to / max, r - thick - 1); svg.append(s('line', { x1: xa, y1: ya, x2: xb, y2: yb, class: 'ch-gtick' })); }
      const fs = Math.max(18, Math.round(W * 0.14));
      svg.append(s('text', { x: c, y: cy - 6, 'text-anchor': 'middle', class: 'ch-center', style: `font-size:${fs}px` }, v === null ? '–' : fmt(v)));
      svg.append(s('text', { x: c - r + thick / 2, y: cy + 16, 'text-anchor': 'middle', class: 'ch-ax' }, fmt(0)));
      svg.append(s('text', { x: c + r - thick / 2, y: cy + 16, 'text-anchor': 'middle', class: 'ch-ax' }, fmt(max)));
      return {
        svg, n: 1, start: 0, extra: o.label ? [h('div.ch-gauge-l', o.label)] : [],
        hit: () => 0, mark: () => {},
        at: () => ({ x: c, y: cy - fs - 4, title: o.label || o.title || '', rows: [{ tone, name: max !== 1 ? `trên ${fmt(max)}` : '', value: v === null ? 'chưa có số' : fmt(v), key: 'rect' }], note: o.note || (band && band.label) || null }),
      };
    }, { fixed: true });
  }

  // ───────────── Phễu / các bước ─────────────
  function funnel(o) {
    const steps = (o.steps || []).map((x, i) => ({ ...x, tone: TONES.has(x.tone) ? x.tone : 'blue', value: Math.max(0, numOrNull(x.value) || 0), i }));
    const fmt = o.format || autoFmt;
    if (!steps.length) return emptyChart(o, 160);
    const maxV = Math.max(...steps.map((x) => x.value)) || 1;
    const total = sum(steps.map((x) => x.value));
    const rateOf = (i) => {
      if (o.rates === 'share') return total ? H.pct(steps[i].value / total) : '–';
      if (o.rates === false || i === 0 || !steps[i - 1].value) return '';
      return H.pct(steps[i].value / steps[i - 1].value);
    };
    const aria = o.aria || `${o.title || 'Các bước'}: ${steps.map((x) => `${x.label} ${fmt(x.value)}`).join(', ')}`;
    const rowH = o.rowHeight || 46, Ht = steps.length * rowH;
    return frame('funnel', { ...o, aria }, (W) => {
      const svg = svgRoot(W, Ht, aria);
      const hl = s('rect', { x: 0, width: W, height: rowH - 2, class: 'ch-band', visibility: 'hidden', rx: 6 });
      svg.append(hl);
      steps.forEach((x, i) => {
        const y = i * rowH, rt = rateOf(i), vt = fmt(x.value);
        const right = rt ? `${vt} · ${rt}` : vt;
        svg.append(s('text', { x: 2, y: y + 15, class: 'ch-lab' }, fit(x.label, W - tw(right, 12, 600) - 16, 12)));
        svg.append(s('text', { x: W - 2, y: y + 15, 'text-anchor': 'end', class: 'ch-val' }, right));
        const bw = Math.max(x.value ? 6 : 0, ((W - 4) * x.value) / maxV);
        svg.append(s('rect', { x: 2, y: y + 23, width: W - 4, height: 12, rx: 4, class: 'ch-gtrack-f' }));
        if (bw) svg.append(s('path', { d: barPath(2, y + 23, bw, 12, 'right'), 'data-tone': x.tone, class: 'ch-bar' }));
      });
      return {
        svg, n: steps.length, start: 0,
        hit: (px, py) => { const i = Math.floor(py / rowH); return i >= 0 && i < steps.length ? i : -1; },
        mark: (i) => { if (i < 0) hl.setAttribute('visibility', 'hidden'); else { hl.setAttribute('y', i * rowH); hl.setAttribute('visibility', 'visible'); } },
        at: (i) => ({ x: Math.min(W - 60, Math.max(60, ((W - 4) * steps[i].value) / maxV / 2)), y: i * rowH + 20, title: steps[i].label, rows: [{ tone: steps[i].tone, name: rateOf(i) ? (o.rates === 'share' ? 'trên tổng' : 'so với bước trước') : '', value: fmt(steps[i].value) + (rateOf(i) ? ` · ${rateOf(i)}` : ''), key: 'rect' }], note: steps[i].note || null }),
      };
    });
  }

  // ───────────── Đường nhỏ trong ô số liệu ─────────────
  function spark(values, opt = {}) {
    const data = (values || []).map(numOrNull);
    const W = opt.width || 96, Ht = opt.height || 28, tone = toneOf(opt.tone || 'blue', 0), fmt = opt.format || autoFmt;
    const vals = data.filter((v) => v !== null);
    const aria = opt.aria || (vals.length ? `Xu hướng: từ ${fmt(vals[0])} đến ${fmt(vals[vals.length - 1])}, thấp nhất ${fmt(Math.min(...vals))}, cao nhất ${fmt(Math.max(...vals))}` : 'Chưa có số liệu');
    const wrap = frame('spark', { aria, className: opt.className }, () => {
      const svg = svgRoot(W, Ht, aria);
      if (vals.length < 2) return { svg, n: 0, hit: () => -1, mark: () => {}, at: () => null };
      const lo = Math.min(...vals, opt.zero ? 0 : Infinity), hi = Math.max(...vals);
      const X = (i) => 2 + (i * (W - 6)) / Math.max(1, data.length - 1);
      const Y = (v) => Ht - 3 - ((v - lo) / (hi - lo || 1)) * (Ht - 7);
      const g = s('g', { 'data-tone': tone, class: 'ch-ser' });
      const segs = []; let cur = null;
      data.forEach((v, i) => { if (v === null) { cur = null; return; } if (!cur) { cur = []; segs.push(cur); } cur.push([X(i), Y(v)]); });
      for (const seg of segs) {
        if (seg.length < 2) continue;
        if (opt.area !== false) g.append(s('path', { d: `M${seg.map((p) => p.join(',')).join('L')}L${seg[seg.length - 1][0]},${Ht - 1}L${seg[0][0]},${Ht - 1}Z`, class: 'ch-area' }));
        g.append(s('path', { d: `M${seg.map((p) => p.join(',')).join('L')}`, class: 'ch-line ch-thin' }));
      }
      let li = data.length - 1; while (li >= 0 && data[li] === null) li--;
      if (li >= 0) g.append(s('circle', { cx: X(li), cy: Y(data[li]), r: 2.5, class: 'ch-dot ch-dot-s' }));
      const hv = s('circle', { r: 3, class: 'ch-dot ch-dot-s', visibility: 'hidden' });
      g.append(hv);
      svg.append(g);
      return {
        svg, n: data.length,
        hit: (px) => Math.max(0, Math.min(data.length - 1, Math.round(((px - 2) / (W - 6)) * (data.length - 1)))),
        mark: (i) => { if (i < 0 || data[i] === null) hv.setAttribute('visibility', 'hidden'); else { hv.setAttribute('cx', X(i)); hv.setAttribute('cy', Y(data[i])); hv.setAttribute('visibility', 'visible'); } },
        at: (i) => ({ x: X(i), y: data[i] === null ? 4 : Y(data[i]), title: opt.labels ? opt.labels[i] : '', rows: [{ tone, name: opt.name || '', value: data[i] === null ? 'chưa có số' : fmt(data[i]), key: 'line' }] }),
      };
    }, { fixed: true, focusable: false });
    return wrap;
  }

  // ───────────── Bản đồ nhiệt (hàng × cột) ─────────────
  function heat(o) {
    const rows = (o.rows || []).map(String), cols = (o.cols || []).map(String);
    const V = (o.values || []).map((r) => (r || []).map(numOrNull));
    const fmt = o.format || autoFmt, tone = toneOf(o.tone || 'blue', 0);
    const flat = V.flat().filter((v) => v !== null);
    if (!rows.length || !cols.length || !flat.length) return emptyChart(o, 160);
    const maxV = o.max || Math.max(...flat) || 1;
    const nr = rows.length, nc = cols.length;
    const aria = o.aria || `${o.title || 'Bản đồ nhiệt'}: ${nr} hàng × ${nc} cột, cao nhất ${fmt(Math.max(...flat))}`;
    const cellH = o.cellHeight || 26, topH = 22, Ht = topH + nr * (cellH + 2);
    return frame('heat', { ...o, aria }, (W) => {
      const labW = Math.min(Math.round(W * 0.34), Math.ceil(Math.max(...rows.map((l) => tw(l, 12)))) + 12);
      const cw = Math.max(8, (W - labW) / nc);
      const svg = svgRoot(W, Ht, aria);
      const showC = thin(cols, cw);
      cols.forEach((c, j) => { if (showC(j)) svg.append(s('text', { x: labW + cw * j + cw / 2, y: 14, 'text-anchor': 'middle', class: 'ch-ax' }, c)); });
      const cells = [];
      rows.forEach((r, i) => {
        const y = topH + i * (cellH + 2);
        svg.append(s('text', { x: labW - 8, y: y + cellH / 2 + 4, 'text-anchor': 'end', class: 'ch-lab' }, fit(r, labW - 12, 12)));
        cols.forEach((c, j) => {
          const v = (V[i] || [])[j] ?? null;
          const p = v === null || v <= 0 ? 0 : Math.round(14 + 86 * Math.min(1, v / maxV));
          const rect = s('rect', { x: labW + cw * j + 1, y, width: Math.max(2, cw - 2), height: cellH, rx: 4, 'data-tone': tone, 'data-i': i * nc + j, class: p ? 'ch-cell' : 'ch-cell ch-cell-0' });
          if (p) rect.style.fill = `color-mix(in srgb, var(--c) ${p}%, var(--surface))`;
          svg.append(rect);
          cells.push(rect);
          if (v !== null && o.labels !== false && cw >= tw(fmt(v), 11, 600) + 8) svg.append(s('text', { x: labW + cw * j + cw / 2, y: y + cellH / 2 + 4, 'text-anchor': 'middle', class: `ch-cell-t${p > 58 ? ' hi' : ''}` }, fmt(v)));
        });
      });
      return {
        svg, n: nr * nc, start: 0,
        hit: (px, py) => { const j = Math.floor((px - labW) / cw), i = Math.floor((py - topH) / (cellH + 2)); return i >= 0 && i < nr && j >= 0 && j < nc ? i * nc + j : -1; },
        mark: (k) => cells.forEach((c, j) => c.classList.toggle('on', j === k)),
        at: (k) => { const i = Math.floor(k / nc), j = k % nc, v = (V[i] || [])[j] ?? null; return { x: labW + cw * j + cw / 2, y: topH + i * (cellH + 2), title: `${rows[i]} · ${cols[j]}`, rows: [{ tone, name: o.unit || '', value: v === null ? 'chưa có số' : fmt(v), key: 'rect' }] }; },
      };
    });
  }

  ARL.chart = { line, bar, donut, gauge, funnel, spark, heat, legend, ticks, _fit: fit };

  // ═════════════ ARL.dash — khối dựng dùng chung cho các màn hình bảng số ═════════════
  const D = (ARL.dash = ARL.dash || {});
  const pad2 = (n) => String(n).padStart(2, '0');
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  /** '2026-10-08' → '2026-W41' (ISO 8601, giống máy chủ). */
  D.weekKey = (d) => {
    const dt = new Date(d + 'T00:00:00Z');
    const th = new Date(dt.getTime() + (3 - ((dt.getUTCDay() + 6) % 7)) * 86400000);
    const y = th.getUTCFullYear();
    return `${y}-W${pad2(1 + Math.floor((th - Date.UTC(y, 0, 1)) / 86400000 / 7))}`;
  };
  D.shiftMonth = (key, n) => { const [y, m] = key.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1 + n, 1)); return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}`; };
  D.addDays = addDays;
  const ddmm = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '');
  D.range = (from, to) => (from && to ? `${ddmm(from)} – ${ddmm(to)}/${to.slice(0, 4)}` : '');
  /**
   * Nhãn so sánh: "tuần trước" / "tháng trước"; kỳ đang chạy (d.cmp.running do máy chủ gửi) là "cùng kỳ tuần trước",
   * vì máy chủ chỉ lấy đúng phần đã trôi của kỳ trước. Nhận cả payload lẫn chuỗi 'week' | 'month'.
   */
  D.prevWord = (d) => {
    const period = typeof d === 'string' ? d : d && d.period;
    const unit = period === 'month' ? 'tháng trước' : 'tuần trước';
    return d && typeof d === 'object' && d.cmp && d.cmp.running ? `cùng kỳ ${unit}` : unit;
  };
  /** Giải thích khung so sánh cho dòng phụ đề. opt.data = false: bảng không có giờ quay (hiệu suất, sự cố). */
  D.cmpNote = (d, opt = {}) => {
    const c = d && d.cmp;
    if (!c) return '';
    const unit = d.period === 'month' ? 'tháng' : 'tuần', out = [];
    if (c.running) out.push(`${unit} đang chạy, so tới hôm nay với cùng kỳ ${ddmm(c.prev_from)}–${ddmm(c.prev_day_to)}`);
    if (opt.data !== false) {
      if (c.data_to === null) out.push(`giờ quay chưa so được (thẻ ${c.lag_days} ngày gần nhất chưa nhập đủ)`);
      else if (c.data_partial) out.push(`giờ quay so tới hết ${ddmm(c.data_to)} với cùng kỳ (thẻ ${c.lag_days} ngày gần nhất chưa nhập đủ)`);
    }
    return out.join(' · ');
  };
  /** So sánh giờ quay, số thẻ: x = { cur, cmp, prev }; so cmp (các ngày đã đủ dữ liệu ở cả hai kỳ) với prev, số hiển thị vẫn là cur. */
  D.dataDelta = (d, x, opt = {}) => (x && x.cmp === null && d && d.cmp ? h('span.h-delta', h('em', 'chưa đủ ngày để so')) : H.delta(x.cmp ?? x.cur, x.prev, opt));

  /**
   * Chọn kỳ: [Tuần | Tháng]  ‹  W41 · 05/10 – 11/10  ›  [Kỳ này]
   * p: { period, key, label, from, to } (lấy từ phản hồi của máy chủ). onChange(period, key|null).
   */
  D.periodNav = (p, onChange) => {
    const today = H.today();
    const seg = H.period(p.period, (per) => {
      // Đổi Tuần ↔ Tháng: giữ mốc thời gian đang xem (ngày cuối kỳ, không vượt hôm nay).
      const ref = p.to && p.to < today ? p.to : today;
      onChange(per, per === 'month' ? ref.slice(0, 7) : D.weekKey(ref));
    });
    const prevKey = p.period === 'month' ? D.shiftMonth(p.key, -1) : D.weekKey(addDays(p.from, -7));
    const nextKey = p.period === 'month' ? D.shiftMonth(p.key, 1) : D.weekKey(addDays(p.from, 7));
    const nextFrom = p.period === 'month' ? `${nextKey}-01` : addDays(p.from, 7);
    const isCur = p.from <= today && today <= p.to;
    const word = p.period === 'month' ? 'tháng' : 'tuần';
    return h('div.dash-period', { role: 'group', 'aria-label': 'Chọn kỳ báo cáo' },
      seg,
      h('div.dash-step',
        h('button.ghost', { type: 'button', 'aria-label': `Xem ${word} trước`, title: `${word[0].toUpperCase() + word.slice(1)} trước`, onclick: () => onChange(p.period, prevKey) }, '‹'),
        h('span.dash-plabel', h('b', p.label || p.key), h('small', D.range(p.from, p.to))),
        h('button.ghost', { type: 'button', 'aria-label': `Xem ${word} sau`, title: `${word[0].toUpperCase() + word.slice(1)} sau`, disabled: nextFrom > today, onclick: () => onChange(p.period, nextKey) }, '›')),
      isCur ? null : h('button.ghost.small', { type: 'button', onclick: () => onChange(p.period, null) }, p.period === 'month' ? 'Tháng này' : 'Tuần này'));
  };

  /** Chip thay đổi từ % do máy chủ tính sẵn (delta_pct). up: 'good' | 'bad'. */
  D.deltaPct = (pct, opt = {}) => {
    const lab = opt.label || 'kỳ trước';
    if (pct === null || pct === undefined) return h('span.h-delta', h('em', opt.none || `chưa có ${lab}`));
    if (Math.abs(pct) < 0.05) return h('span.h-delta', '＝ ', h('em', `như ${lab}`));
    const up = pct > 0, good = (opt.up || 'good') === 'good' ? up : !up;
    return h('span.h-delta', { 'data-tone': opt.neutral ? null : good ? 'good' : 'bad' }, `${up ? '▲' : '▼'} ${up ? '+' : '−'}${H.num(Math.abs(pct), Math.abs(pct) < 10 ? 1 : 0)}% `, opt.short ? null : h('em', `so ${lab}`));
  };
  /** Mũi tên thay đổi gọn (bảng / danh sách xếp hạng): ▲ 3 / ▼ 2 / ＝. */
  D.arrow = (cur, prev, opt = {}) => {
    if (prev === null || prev === undefined || cur === null || cur === undefined) return h('span.dash-arrow', { title: 'Chưa có kỳ trước' }, '–');
    const d = cur - prev;
    if (Math.abs(d) < 1e-9) return h('span.dash-arrow', { title: `Như ${opt.label || 'kỳ trước'}` }, '＝');
    const up = d > 0, good = (opt.up || 'good') === 'good' ? up : !up;
    return h('span.dash-arrow', { 'data-tone': opt.neutral ? null : good ? 'good' : 'bad', title: `${opt.label || 'Kỳ trước'}: ${H.num(prev, opt.d ?? (Number.isInteger(prev) ? 0 : 1))}${opt.unit || ''}` }, `${up ? '▲' : '▼'} ${H.num(Math.abs(d), opt.d ?? (Number.isInteger(d) ? 0 : 1))}${opt.unit || ''}`);
  };

  /**
   * Danh sách xếp hạng có thanh: D.rank([{ label, sub, value, text, href, onClick, tone, right: [Node], flag: Node }], { max, empty }).
   * Dùng cho top sự cố, BO nhiều giờ nhất…; mỗi dòng là link khi có href.
   */
  D.rank = (items, opt = {}) => {
    if (!items || !items.length) return H.empty(opt.empty || 'Chưa có số liệu trong kỳ này.');
    const max = opt.max || Math.max(1, ...items.map((x) => x.value || 0));
    return h('ol.dash-rank', items.map((x, i) => {
      const body = [
        h('span.dash-rank-n', String(i + 1)),
        h('span.dash-rank-b',
          h('span.dash-rank-t', h('span.dash-rank-l', x.label), x.flag || null, x.sub ? h('small', x.sub) : null),
          h('span.dash-rank-bar', h('i', { 'data-tone': x.tone || 'blue', style: { width: `${Math.max(x.value ? 2 : 0, Math.min(100, ((x.value || 0) / max) * 100))}%` } }))),
        h('span.dash-rank-v', h('b', x.text ?? H.num(x.value)), x.right || null),
      ];
      return h('li', x.href ? h('a.dash-rank-row', { href: x.href }, body) : x.onClick ? h('button.dash-rank-row', { type: 'button', onclick: x.onClick }, body) : h('div.dash-rank-row', body));
    }));
  };

  /** Bục vinh danh Top 3: D.podium([{ user, score, rating_label, points, sla_pct, delta_pct }], { label }). */
  D.podium = (list, opt = {}) => {
    if (!list || !list.length) return H.empty(opt.empty || 'Chưa đủ người được xếp loại trong kỳ này.');
    const medal = ['1', '2', '3'];
    return h('ol.dash-podium', list.slice(0, 3).map((x, i) => h('li', { 'data-rank': i + 1 },
      h('span.dash-medal', { 'aria-label': `Hạng ${i + 1}` }, medal[i]),
      h('span.dash-pod-b',
        h('b', x.user ? x.user.name : '–'),
        h('small', [x.rating_label, x.user && x.user.role_label].filter(Boolean).join(' · '))),
      h('span.dash-pod-s',
        h('b', x.score === null || x.score === undefined ? '–' : H.num(x.score, 1)),
        h('small', 'điểm tổng hợp')),
      h('span.dash-pod-m',
        h('span', `${H.num(x.points, 1)} điểm KL`),
        x.sla_pct !== null && x.sla_pct !== undefined ? h('span', `${H.pct(x.sla_pct, 0, true)} đúng hạn`) : null,
        x.delta_pct !== null && x.delta_pct !== undefined ? D.deltaPct(x.delta_pct, { short: true }) : null))));
  };

  /** Ô số liệu có đường nhỏ: như H.kpi nhưng thêm spark ở góc. */
  D.kpi = (o) => {
    const t = H.kpi(o);
    if (o.spark && o.spark.filter((v) => v !== null && v !== undefined).length > 1) { t.classList.add('dash-kpi-sp'); t.append(spark(o.spark, { tone: o.sparkTone || 'blue', labels: o.sparkLabels, format: o.sparkFormat, name: o.label, className: 'dash-kpi-spark' })); }
    return t;
  };
  /** Tiêu đề nhỏ trong thẻ + chú thích nguồn số liệu. */
  D.src = (text) => h('p.dash-src', text);
  /** Mở được màn hình viewId với vai trò hiện tại không (để chỉ hiện link dùng được). */
  D.canOpen = (ctx, viewId) => { const v = ARL.hub && ARL.hub.views && ARL.hub.views.get(viewId); return !!(v && v.roles.includes(ctx.role)); };
  /** Bỏ tham số rỗng trước khi gửi lên máy chủ. */
  D.q = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  /** Địa chỉ trong hub: D.href('jobs', [], { team: 'tech' }) → "#/jobs?team=tech". */
  D.href = (view, params = [], query = {}) => {
    const q = new URLSearchParams(D.q(query)).toString();
    return `#/${[view, ...params].map((p) => encodeURIComponent(String(p))).join('/')}${q ? '?' + q : ''}`;
  };
  /** Link tới màn hình khác nếu vai trò mở được, không thì chữ thường. */
  D.linkOr = (ctx, view, params, query, label, attrs = {}) => (D.canOpen(ctx, view) ? h('a', { href: D.href(view, params, query), ...attrs }, label) : h('span', label));
  /**
   * Nạp lại có giãn cách: gọi liên tục (mỗi lần dữ liệu đổi) thì chỉ nạp tối đa một lần mỗi gap ms. Trả về hàm kích hoạt.
   * Dùng cho bảng số nặng (tổng quan) để không dồn tải lên máy chủ khi nhiều người cùng thao tác.
   */
  D.throttle = (ctx, fn, gap = 12000) => {
    let last = 0, t = null;
    const run = () => { t = null; last = Date.now(); if (ctx.alive()) fn(); };
    ctx.onCleanup(() => clearTimeout(t));
    return () => { if (t) return; const wait = last + gap - Date.now(); if (wait <= 0) run(); else t = setTimeout(run, wait); };
  };
})();
