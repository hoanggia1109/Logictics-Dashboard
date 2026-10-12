/* Ops Hub — Điều phối chuyến (#/dispatch): gom việc ngoài hiện trường của Logistics (giao kit, đổi thẻ, đổi kit hỏng, thu hồi,
   giao phụ kiện, việc giao tay có BO) thành một chuyến FO trên Rider Live. Mỗi BO là một điểm dừng; chuẩn bị kit / thẻ cho từng
   điểm, chọn FO rồi tạo chuyến (POST /api/hub/dispatch). Tab "Chuyến đang chạy": xem việc nào đang theo chuyến nào, gỡ việc khỏi
   chuyến chưa bắt đầu. Chỉ Logistics và Quản trị mở được màn hình này (Sale không bao giờ thấy FO). */
(() => {
  'use strict';
  const H = ARL.H, { h } = H;
  const MAX = 15; // máy chủ: tối đa 15 việc và 15 điểm mỗi chuyến
  const STOP_TONE = { pending: 'off', arrived: 'blue', done: 'go', failed: 'lost' };

  ARL.hub.view('dispatch', {
    mount(el, ctx) {
      const W = ARL.hubWork;
      if (!W) { el.append(H.error(new Error('Thiếu thành phần Bảng việc. Tải lại trang.'))); return; }
      const S = { tab: ctx.query.tab === 'trips' ? 'trips' : 'plan', q: '', up: false };
      const D = { jobs: null, sites: null, fos: null, tasks: null, det: new Map(), types: null };
      const picked = new Set();     // id việc đã chọn (giữ thứ tự chọn)
      let order = [];               // thứ tự điểm BO (site id) theo lúc chọn, sửa được bằng ↑ ↓
      const prep = { cards: {}, lcards: {}, swap: {} };
      const opt = { fo: '', office: null, round: true, date: H.today(), time: '', title: '', note: '' };

      // ── Khung ──
      const head = H.head('Điều phối chuyến', 'Gom việc ngoài hiện trường thành một chuyến FO trên Rider Live: mỗi BO một điểm dừng. Hệ thống tự đóng việc khi FO giao nhận xong và BO xác nhận.', H.link('#/live', 'Mở Rider Live', { class: 'btn' }));
      const tabs = h('div.dispatch-tabs');
      const onTab = (k) => { S.tab = k; ctx.setQuery({ tab: k === 'plan' ? '' : k }); show(); };
      const paintTabs = () => tabs.replaceChildren(H.tabs([['plan', 'Lập chuyến', D.jobs ? dispatchable().length : 0], ['trips', 'Chuyến đang chạy', D.tasks ? tripList().length : 0]], S.tab, onTab));
      const planPane = h('div.dispatch-plan');
      const tripsPane = h('div.dispatch-trips');
      el.append(head, tabs, planPane, tripsPane);
      const show = () => { planPane.hidden = S.tab !== 'plan'; tripsPane.hidden = S.tab !== 'trips'; };
      show();
      // (paintTabs dùng dispatchable / tripList khai báo bên dưới; gọi sau khi có dữ liệu)

      // ── Lập chuyến: bên trái chọn việc, bên phải chuẩn bị chuyến ──
      const search = H.search('Tìm BO, mã việc, kit', (v) => { S.q = v; paintPick(); });
      const upChip = h('button.chip', { type: 'button', 'aria-pressed': 'false', title: 'Gồm việc chưa tới ngày hiện, ví dụ giao kit cho BO launch vài ngày tới', onclick: () => { S.up = !S.up; upChip.setAttribute('aria-pressed', String(S.up)); rJobs(); } }, 'Gồm việc sắp tới');
      const pickBox = h('div.dispatch-pick', H.loading(5));
      const stopsBox = h('div.dispatch-stops');
      const sumBox = h('p.dispatch-sum');
      const errBox = h('p.h-note.dispatch-err', { 'data-tone': 'lost', role: 'alert', hidden: true });
      const okBox = h('div.dispatch-ok', { hidden: true });
      const foSel = h('select', { id: 'dp-fo', 'aria-describedby': 'dp-fo-h', onchange: () => { opt.fo = foSel.value; } });
      const offSel = h('select', { id: 'dp-off', onchange: () => { opt.office = offSel.value; roundBox.disabled = !opt.office; } });
      const roundBox = h('input', { type: 'checkbox', id: 'dp-round', checked: true, onchange: () => { opt.round = roundBox.checked; } });
      const dateIn = h('input', { type: 'date', id: 'dp-date', value: opt.date, min: H.today(), onchange: () => { opt.date = dateIn.value || H.today(); } });
      const timeIn = h('input', { type: 'time', id: 'dp-time', onchange: () => { opt.time = timeIn.value; } });
      const titleIn = h('input', { type: 'text', id: 'dp-title', maxlength: 80, placeholder: 'Tự đặt theo điểm đầu tiên', oninput: () => { opt.title = titleIn.value.trim(); } });
      const noteIn = h('textarea', { id: 'dp-note', rows: 2, maxlength: 500, placeholder: 'Dặn FO (không bắt buộc)', oninput: () => { opt.note = noteIn.value.trim(); } });
      const foHint = h('small', { id: 'dp-fo-h' }, '');
      const submit = H.btn('Tạo chuyến', () => create(), 'primary dispatch-go');
      const lab = (forId, text, input, hint) => h('label.h-field', { for: forId }, h('span', text), input, hint || null);
      const side = h('section.h-card.dispatch-side', { 'aria-labelledby': 'dp-side-h' },
        h('header', h('h3', { id: 'dp-side-h' }, 'Chuyến mới')),
        okBox, stopsBox,
        h('div.dispatch-opts',
          h('div.h-full', lab('dp-fo', 'FO đi chuyến', foSel, foHint)),
          h('div.h-full', lab('dp-off', 'Xuất phát từ', offSel)),
          h('div.h-full', h('label.h-field.h-inline', { for: 'dp-round' }, roundBox, h('span', 'Quay về điểm xuất phát (hai chiều)'))),
          lab('dp-date', 'Ngày', dateIn), lab('dp-time', 'Giờ bắt đầu', timeIn, h('small', 'Bỏ trống: bắt đầu ngay (hôm nay) hoặc 08:00.')),
          h('div.h-full', lab('dp-title', 'Tên chuyến', titleIn)), h('div.h-full', lab('dp-note', 'Ghi chú cho FO', noteIn))),
        sumBox, errBox, h('div.dispatch-foot', submit));
      const bar = h('div.dispatch-bar', { hidden: true }, h('span'), h('button.primary', { type: 'button', onclick: () => side.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, 'Lập chuyến ↓'));
      planPane.append(h('div.h-tools.dispatch-tools', search, upChip, h('span.jobs-grow'), h('small.h-muted', `Tối đa ${MAX} việc mỗi chuyến.`)), h('div.dispatch-grid', pickBox, side), bar);

      const siteOf = (id) => (D.sites && D.sites.get(id)) || null;
      const hasCoord = (s) => !!(s && s.lat !== null && s.lat !== undefined && s.lon !== null && s.lon !== undefined);
      const jobById = (id) => ((D.jobs && D.jobs.jobs) || []).find((j) => j.id === id) || null;
      const dispatchable = () => ((D.jobs && D.jobs.jobs) || []).filter((j) => W.FIELD_TYPES.includes(j.type) && j.team === 'logistics' && !j.task_id && j.site && W.OPEN.includes(j.status));
      const inTrips = () => ((D.jobs && D.jobs.jobs) || []).filter((j) => W.inTrip(j));

      function paintPick() {
        if (!D.jobs || !D.sites) return;
        const list = dispatchable().filter((j) => H.match([j.code, j.title, j.site && j.site.name, j.kit && j.kit.code, j.type_label, (siteOf(j.site.id) || {}).area].join(' '), S.q));
        // Việc đã chọn mà không còn trong danh sách (đã có người đưa vào chuyến khác, đã xong): bỏ chọn.
        const ids = new Set(dispatchable().map((j) => j.id));
        let drop = false;
        for (const id of [...picked]) if (!ids.has(id)) { picked.delete(id); drop = true; }
        if (drop) syncOrder();
        paintTabs();
        if (!list.length) {
          pickBox.replaceChildren(H.empty(S.q ? 'Không có việc nào khớp tìm kiếm.' : 'Không có việc ngoài hiện trường nào đang chờ. Việc giao kit, đổi thẻ, đổi kit hỏng, thu hồi, giao phụ kiện tự sinh ở đây khi tới lúc.'));
          return;
        }
        // Gom theo khu vực → BO.
        const areas = new Map();
        for (const j of list) {
          const s = siteOf(j.site.id), area = (s && s.area) || 'Chưa ghi khu vực';
          if (!areas.has(area)) areas.set(area, new Map());
          const m = areas.get(area);
          if (!m.has(j.site.id)) m.set(j.site.id, []);
          m.get(j.site.id).push(j);
        }
        const out = [];
        for (const area of [...areas.keys()].sort((a, b) => (a === 'Chưa ghi khu vực') - (b === 'Chưa ghi khu vực') || a.localeCompare(b, 'vi'))) {
          out.push(h('h3.dispatch-area', area));
          const bos = [...areas.get(area).entries()].sort((a, b) => String(a[1][0].site.name).localeCompare(String(b[1][0].site.name), 'vi'));
          for (const [sid, jobs] of bos) out.push(boCard(sid, jobs.sort(W.urgency)));
        }
        pickBox.replaceChildren(...out);
      }
      function boCard(sid, jobs) {
        const s = siteOf(sid), name = jobs[0].site.name, ok = hasCoord(s);
        const all = h('input', { type: 'checkbox', 'aria-label': `Chọn mọi việc tại ${name}`, disabled: !ok });
        const setAll = () => { const n = jobs.filter((j) => picked.has(j.id)).length; all.checked = n === jobs.length; all.indeterminate = n > 0 && n < jobs.length; };
        const boxes = [];
        const rows = jobs.map((j) => {
          const box = h('input', { type: 'checkbox', checked: picked.has(j.id), disabled: !ok, 'aria-label': `Chọn ${j.code}` });
          box.addEventListener('change', () => { if (!toggle(j, box.checked)) box.checked = false; setAll(); });
          boxes.push([j, box]);
          const due = W.dueOf(j);
          return h('li.dispatch-job', { 'data-tone': j.overdue ? 'lost' : j.priority ? 'wait' : null },
            h('label', box, h('span.dispatch-job-b', h('span.dispatch-job-t', H.pill(j.type_label, 'blue'), ' ', j.priority ? [H.pill('Gấp', 'lost'), ' '] : null, j.title),
              h('small', [j.code, j.kit ? `Kit ${j.kit.code}` : null, j.assignee ? j.assignee.name : 'Chưa ai nhận', j.note || null].filter(Boolean).join(' · ')))),
            h('span.dispatch-job-r', H.pill(due.text, due.tone), j.show_date && j.show_date > H.today() ? H.pill(`Hiện từ ${H.day(j.show_date)}`, 'off') : null));
        });
        all.addEventListener('change', () => {
          for (const [j, box] of boxes) { if (all.checked && !picked.has(j.id)) box.checked = toggle(j, true); if (!all.checked && picked.has(j.id)) { toggle(j, false); box.checked = false; } }
          setAll();
        });
        setAll();
        const outletHref = ctx.linkTo(`outlet:${sid}`);
        return h('section.dispatch-bo', { 'data-nocoord': ok ? null : '1' },
          h('header', h('label.dispatch-bo-h', all, h('span', h('b', name), s && s.address ? h('small', s.address) : null)), h('span.h-muted', `${jobs.length} việc`)),
          ok ? null : h('p.h-note', { 'data-tone': 'wait' }, s ? 'BO chưa có toạ độ nên chưa đưa vào chuyến được. ' : 'BO không còn hoạt động trên Rider Live. ', s && outletHref ? H.link(outletHref, 'Mở BO để dán toạ độ hoặc link Google Maps') : null),
          h('ul.dispatch-jobs', rows));
      }
      function syncOrder() {
        const sites = [];
        for (const id of picked) { const j = jobById(id); if (j && !sites.includes(j.site.id)) sites.push(j.site.id); }
        order = [...order.filter((s) => sites.includes(s)), ...sites.filter((s) => !order.includes(s))];
      }
      function toggle(j, on) {
        if (on) {
          if (picked.size >= MAX) { ARL.toast(`Một chuyến tối đa ${MAX} việc. Tạo chuyến này trước rồi lập chuyến tiếp theo.`, true); return false; }
          picked.add(j.id);
          loadDetail(j.id);
        } else picked.delete(j.id);
        syncOrder();
        okBox.hidden = true;
        paintSide();
        return true;
      }
      async function loadDetail(id, force) {
        if (D.det.has(id) && !force) return;
        D.det.set(id, D.det.get(id) || null);
        try {
          const d = await ctx.api('GET', `/api/hub/jobs/${id}`);
          if (!ctx.alive()) return;
          D.det.set(id, d);
        } catch (e) { D.det.set(id, { error: e.message }); }
        if (picked.has(id)) paintSide();
      }

      // ── Bên phải: điểm dừng và chuẩn bị ──
      function paintSide() {
        const n = picked.size;
        bar.hidden = !n;
        bar.firstChild.textContent = `Đã chọn ${n} việc · ${order.length} điểm`;
        errBox.hidden = true;
        if (!n) {
          stopsBox.replaceChildren(H.empty('Chọn việc ở danh sách bên cạnh. Việc cùng BO đi chung một điểm dừng.'));
          sumBox.textContent = '';
          submit.disabled = true;
          return;
        }
        submit.disabled = false;
        const usedSwap = new Set(Object.values(prep.swap).map(String));
        const acc = {};
        let kitsOut = 0, kitsIn = 0, swapStops = 0;
        const office = opt.office ? siteOf(Number(opt.office)) : null;
        const stops = [];
        if (office) stops.push(h('li.dispatch-stop.dispatch-stop-off', h('div.dispatch-stop-h', h('span.dispatch-num', '0'), h('b', office.name), h('small', 'Nhận kit / thẻ tại văn phòng'))));
        order.forEach((sid, i) => {
          const jobs = [...picked].map(jobById).filter((j) => j && j.site.id === sid);
          if (!jobs.length) return;
          let swapDone = false;
          const hasSwap = jobs.some((j) => j.type === 'card_swap');
          const cpk = (ARL.hubMeta && ARL.hubMeta.cfg && ARL.hubMeta.cfg.cardsPerKit) || 2;
          // Ô mã thẻ mới mang đi cho điểm này (đổi thẻ, hoặc thẻ để sẵn trong kit khi giao launch).
          // key 'lcards': thẻ trong kit giao launch khi điểm có cả lượt đổi thẻ (ô riêng, gửi ở launch_cards).
          const cardBox = (d, need, label, hint, key = 'cards') => {
            const id = `dp-${key}-${sid}`, box = prep[key];
            const others = new Set(['cards', 'lcards'].flatMap((k2) => Object.entries(prep[k2]).filter(([k]) => k2 !== key || String(k) !== String(sid)).flatMap(([, v]) => codes(v))));
            const free = (d.cards_office || []).filter((c) => !others.has(c));
            // Ô gõ / quét mã và danh sách tick chọn cùng trỏ vào một giá trị (prep[key][sid]): sửa bên nào thì bên kia cập nhật theo.
            const picked = () => codes(ta.value);
            const syncBoxes = () => { const sel = new Set(picked()); for (const cb of list.querySelectorAll('input[type=checkbox]')) cb.checked = sel.has(cb.value); box[sid] = ta.value; };
            const ta = h('textarea', { id, rows: 2, spellcheck: 'false', placeholder: 'Quét mã vạch hoặc gõ mã thẻ, cách nhau bởi dấu cách', oninput: syncBoxes }, box[sid] || '');
            const fill = free.length && need ? H.btn(`Điền ${Math.min(need, free.length)} thẻ sẵn sàng`, () => {
              const sel = picked(), add = free.filter((c) => !sel.includes(c)).slice(0, Math.max(0, need - sel.length));
              ta.value = [...sel, ...add].join(' '); syncBoxes();
            }, 'ghost small') : null;
            const cur = picked(), options = [...new Set([...free, ...cur])];
            const list = h('div.dp-cardlist', options.map((c) => h('label.dp-cardopt', h('input', { type: 'checkbox', value: c, checked: cur.includes(c), onchange: (e) => {
              let sel = picked();
              if (e.target.checked) { if (!sel.includes(c)) sel.push(c); } else sel = sel.filter((x) => x !== c);
              ta.value = sel.join(' '); box[sid] = ta.value;
            } }), h('code', c))));
            const pickList = options.length ? h('details.dp-cardpick', h('summary', `Thẻ sẵn sàng tại VP (${free.length})`), list) : null;
            return h('div.h-field', h('label', { for: id }, h('span', label)), ta, h('small', hint), fill, pickList);
          };
          const lines = jobs.map((j) => {
            const d = D.det.get(j.id);
            const lineHead = h('div.dispatch-line-h', H.pill(j.type_label, 'blue'), h('span', j.title), h('button.ghost.small', { type: 'button', 'aria-label': `Bỏ ${j.code} khỏi chuyến`, title: 'Bỏ khỏi chuyến', onclick: () => { toggle(j, false); paintPick(); } }, 'Bỏ'));
            if (d === null || d === undefined) return h('div.dispatch-line', lineHead, h('small.h-muted', 'Đang tải phần cần chuẩn bị…'));
            if (d.error) return h('div.dispatch-line', lineHead, H.note(d.error, 'lost'));
            let body = null;
            if (j.type === 'deliver') {
              const ks = (d.kits || []).filter((k) => k.status === 'reserved');
              kitsOut += ks.length;
              body = ks.length ? h('div', h('small', `Mang ${ks.length} kit đã kiểm: ${ks.map((k) => k.code).join(', ')}`),
                cardBox(d, ks.length * cpk, `Thẻ để sẵn trong kit (cần ${ks.length * cpk})`, `Ghi mã để lượt đổi thẻ đầu tiên thu đúng thẻ.${hasSwap ? ' Khác với thẻ mang đi đổi ở lượt đổi thẻ cùng điểm.' : ''} Thiếu mã thì hệ thống đưa vào Đối chiếu để ghi sau.`, hasSwap ? 'lcards' : 'cards'))
                : H.note('Chưa có kit nào đã kiểm đạt cho yêu cầu này; chuyến sẽ không mang kit.', 'wait');
            } else if (j.type === 'card_swap') {
              if (swapDone) body = h('small', 'Đổi thẻ chung lượt với việc đổi thẻ ở trên.');
              else {
                swapDone = true; swapStops++;
                const need = (d.kits || []).length * cpk;
                body = cardBox(d, need, `Thẻ mới mang đi * (cần ${need})`, `${(d.kits || []).length} kit đang quay · thu về ${(d.cards_at_bo || []).length} thẻ đang ghi ở BO. Cần ghi mã từng thẻ để biết thẻ nào đang ở BO.`);
              }
            } else if (j.type === 'swap_faulty') {
              kitsOut++; kitsIn++;
              const reps = (d.replacements || []).filter((k) => !usedSwap.has(String(k.id)) || String(prep.swap[j.id]) === String(k.id));
              const id = `dp-swap-${j.id}`;
              const s = h('select', { id, onchange: () => { if (s.value) prep.swap[j.id] = Number(s.value); else delete prep.swap[j.id]; paintSide(); } },
                h('option', { value: '' }, reps.length ? '— Chọn kit thay —' : 'Chưa có kit sẵn sàng cùng loại'), reps.map((k) => h('option', { value: String(k.id), selected: String(prep.swap[j.id]) === String(k.id) }, k.code)));
              body = h('div.h-field', h('label', { for: id }, h('span', `Kit thay cho ${d.kit ? d.kit.code : 'kit hỏng'} *`)), s, h('small', 'Kit sẵn sàng, đã kiểm đạt, cùng loại. Kit hỏng FO mang về kho.'));
            } else if (j.type === 'recover') {
              const ks = d.kits || [];
              kitsIn += ks.length;
              body = h('small', ks.length ? `Thu hồi ${ks.length} kit: ${ks.map((k) => k.code).join(', ')}, cùng thẻ đang ở BO.` : 'BO không còn kit nào đang quay.');
            } else if (j.type === 'deliver_acc') {
              const need = d.acc_need || {}, free = d.acc_free || {};
              const T = D.types || new Map();
              const parts = Object.entries(need).map(([t, q]) => { acc[t] = (acc[t] || 0) + q; return `${q} ${(T.get(t) || {}).name || t}`; });
              const short = Object.keys(need).filter((t) => (free[t] ?? 0) < acc[t]);
              body = h('div', h('small', `Phụ kiện cho kit ${d.kit ? d.kit.code : ''}: ${parts.join(', ') || '–'}`), short.length ? H.note(`Kho không đủ ${short.map((t) => `${(T.get(t) || {}).name || t} (rảnh ${free[t] ?? 0}, chuyến cần ${acc[t]})`).join(', ')}. Ghi "Nhập thêm" ở mục Phụ kiện nếu thực tế có, hoặc bỏ việc này khỏi chuyến.`, 'wait') : null);
            } else body = h('small', j.note || 'Việc giao tay tại BO.');
            return h('div.dispatch-line', lineHead, body);
          });
          const up = h('button.ghost.small', { type: 'button', 'aria-label': 'Đưa điểm lên trước', disabled: i === 0, onclick: () => { order.splice(i - 1, 0, order.splice(i, 1)[0]); paintSide(); } }, '↑');
          const dn = h('button.ghost.small', { type: 'button', 'aria-label': 'Đưa điểm xuống sau', disabled: i === order.length - 1, onclick: () => { order.splice(i + 1, 0, order.splice(i, 1)[0]); paintSide(); } }, '↓');
          stops.push(h('li.dispatch-stop', h('div.dispatch-stop-h', h('span.dispatch-num', String(i + 1)), h('b', jobs[0].site.name), h('span.dispatch-stop-mv', up, dn)), lines));
        });
        if (office && opt.round) stops.push(h('li.dispatch-stop.dispatch-stop-off', h('div.dispatch-stop-h', h('span.dispatch-num', '↩'), h('b', `Quay về ${office.name}`))));
        stopsBox.replaceChildren(h('ol.dispatch-stoplist', stops));
        sumBox.textContent = [`${n} việc`, `${order.length} điểm BO`, kitsOut ? `mang đi ${kitsOut} kit` : '', kitsIn ? `thu về ${kitsIn} kit` : '', swapStops ? `đổi thẻ ở ${swapStops} BO` : ''].filter(Boolean).join(' · ');
      }
      const codes = (s) => [...new Set(String(s || '').split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
      function paintOpts() {
        const fos = D.fos || [];
        const on = fos.filter((f) => f.onShift), off = fos.filter((f) => !f.onShift);
        const keep = opt.fo;
        H.clear(foSel, h('option', { value: '' }, '— Chọn FO —'),
          on.length ? h('optgroup', { label: 'Đang trong ca' }, on.map((f) => h('option', { value: String(f.id) }, `${f.name}${f.vehicle ? ' · ' + f.vehicle : ''}`))) : null,
          off.length ? h('optgroup', { label: 'Ngoài ca' }, off.map((f) => h('option', { value: String(f.id) }, `${f.name}${f.consent_ok === false ? ' · chưa đồng ý điều khoản' : ''}`))) : null,
          h('option', { value: 'none' }, 'Chưa giao FO (giao sau trên Rider Live)'));
        foSel.value = [...foSel.options].some((o) => o.value === keep) ? keep : '';
        opt.fo = foSel.value;
        foHint.textContent = on.length ? `${on.length} FO đang trong ca.` : 'Chưa có FO nào trong ca. Có thể tạo chuyến trước và giao sau.';
        if (!D.sites) return; // chưa có danh sách điểm: chưa chọn văn phòng xuất phát
        const offices = [...D.sites.values()].filter((s) => s.type === 'office' && hasCoord(s));
        if (opt.office === null) opt.office = offices.length ? String(offices[0].id) : '';
        H.clear(offSel, offices.map((s) => h('option', { value: String(s.id) }, s.name)), h('option', { value: '' }, 'Không xuất phát từ văn phòng'));
        offSel.value = [...offSel.options].some((o) => o.value === opt.office) ? opt.office : '';
        opt.office = offSel.value;
        roundBox.disabled = !opt.office;
      }
      offSel.addEventListener('change', () => paintSide());
      roundBox.addEventListener('change', () => paintSide());

      async function create() {
        errBox.hidden = true;
        const fail = (m) => { errBox.textContent = m; errBox.hidden = false; errBox.scrollIntoView({ block: 'nearest' }); };
        if (!picked.size) return fail('Chọn ít nhất một việc.');
        if (!opt.fo) { foSel.focus(); return fail('Chọn FO đi chuyến (hoặc chọn "Chưa giao FO").'); }
        const ids = [];
        for (const sid of order) for (const id of picked) { const j = jobById(id); if (j && j.site.id === sid) ids.push(id); }
        const pend = ids.filter((id) => !D.det.get(id) || D.det.get(id).error);
        if (pend.length) return fail('Còn việc chưa tải xong phần cần chuẩn bị. Đợi một chút rồi bấm lại.');
        const swap_kits = {};
        for (const id of ids) {
          const j = jobById(id);
          if (j.type !== 'swap_faulty') continue;
          if (!prep.swap[id]) return fail(`Chọn kit thay thế cho ${j.code} (${j.title}).`);
          swap_kits[id] = prep.swap[id];
        }
        const cards_out = {};
        const launch_cards = {};
        for (const sid of order) {
          const c = codes(prep.cards[sid]); if (c.length) cards_out[sid] = c;
          const hasSwap = ids.some((id) => { const j = jobById(id); return j && j.site.id === sid && j.type === 'card_swap'; });
          const lc = hasSwap ? codes(prep.lcards[sid]) : []; if (lc.length) launch_cards[sid] = lc;
        }
        for (const id of ids) {
          const j = jobById(id), d = D.det.get(id);
          if (j.type === 'card_swap' && (d.kits || []).length && !cards_out[j.site.id]) { const ta = document.getElementById(`dp-cards-${j.site.id}`); if (ta) ta.focus(); return fail(`Nhập mã thẻ mới mang đi cho ${j.site.name} (${j.code}).`); }
        }
        const body = W.clean({
          job_ids: ids, fo_id: opt.fo && opt.fo !== 'none' ? Number(opt.fo) : undefined, office_site_id: opt.office ? Number(opt.office) : undefined,
          round_trip: !!(opt.office && opt.round), date: opt.date || undefined, start_time: opt.time || undefined, title: opt.title || undefined, note: opt.note || undefined,
        });
        if (Object.keys(swap_kits).length) body.swap_kits = swap_kits;
        if (Object.keys(cards_out).length) body.cards_out = cards_out;
        if (Object.keys(launch_cards).length) body.launch_cards = launch_cards;
        let r;
        try { r = await ctx.api('POST', '/api/hub/dispatch', body); } catch (e) { fail(e.message || 'Không tạo được chuyến.'); return; }
        ARL.toast(`Đã tạo chuyến ${r.task.code}${r.task.fo ? ` cho ${r.task.fo.name}` : ''}.`);
        picked.clear(); order = []; prep.cards = {}; prep.lcards = {}; prep.swap = {};
        titleIn.value = ''; noteIn.value = ''; opt.title = ''; opt.note = '';
        okBox.replaceChildren(H.note(`Đã tạo chuyến ${r.task.code} · ${r.task.stops.length} điểm${r.task.fo ? ` · FO ${r.task.fo.name}` : ' · chưa giao FO'}. Việc đã chuyển "Đang làm" và tự đóng khi FO giao nhận xong.`, 'go'),
          h('div.h-row', H.link('#/live', 'Xem trên Rider Live', { class: 'btn primary' }), h('button', { type: 'button', onclick: () => { S.tab = 'trips'; ctx.setQuery({ tab: 'trips' }); paintPick(); show(); } }, 'Xem chuyến đang chạy')));
        okBox.hidden = false;
        paintSide();
        stopsBox.replaceChildren();
        rJobs(); rTasks();
      }

      // ── Chuyến đang chạy ──
      function tripList() {
        return (D.tasks || []).filter((t) => (t.stops || []).some((s) => s.hub && (s.hub.jobs || []).length));
      }
      function paintTrips() {
        if (!D.tasks || !D.jobs) { tripsPane.replaceChildren(H.loading(4)); return; }
        const list = tripList();
        const other = (D.tasks || []).length - list.length;
        if (!list.length) { tripsPane.replaceChildren(H.empty('Chưa có chuyến nào đang mở mang việc của Ops Hub.', H.link('#/live', 'Mở Rider Live', { class: 'btn' }))); return; }
        tripsPane.replaceChildren(h('div.dispatch-tripgrid', list.map((t) => {
          const running = t.status === 'in_progress';
          const stops = (t.stops || []).filter((s) => s.hub && (s.hub.jobs || []).length);
          return h('section.h-card.dispatch-trip', { 'data-tone': t.status === 'unassigned' ? 'wait' : null },
            h('header', h('h3', `${t.code} · ${t.title}`), H.st('task_st', t.status, ARL.TASK_ST[t.status]), h('p.sub', `${t.fo ? 'FO ' + t.fo.name : 'Chưa giao FO'} · ${H.day(t.date)}${t.start_at ? ' · bắt đầu ' + H.time(t.start_at) : ''}`)),
            running ? h('p.h-note', { 'data-tone': 'wait' }, 'Chuyến đã bắt đầu: không gỡ việc được. Không làm được ở điểm nào thì FO bấm "Không giao được" ở điểm đó, hoặc huỷ chuyến trên Rider Live.') : null,
            h('ol.dispatch-stoplist', stops.map((s) => h('li.dispatch-stop', h('div.dispatch-stop-h', h('span.dispatch-num', String(s.seq)), h('b', s.name), H.pill((ARL.STOP_ST && ARL.STOP_ST[s.status]) || s.status, STOP_TONE[s.status] || 'off')),
              (s.hub.jobs || []).map((id) => {
                const j = jobById(id);
                const done = !j;
                return h('div.dispatch-line', h('div.dispatch-line-h',
                  j ? H.pill(j.type_label, 'blue') : H.pill('Đã đóng', 'go'),
                  h('span', j ? H.link(`#/jobs/${j.id}`, `${j.code} · ${j.title}`) : `Việc #${id}`),
                  !done && !running && j.task_id === t.id ? H.btn('Gỡ khỏi chuyến', async () => {
                    if (!(await H.confirm(`Gỡ ${j.code} khỏi chuyến ${t.code}? Kit / thẻ của việc này trở về kho, việc trở lại chờ làm.`, 'Gỡ khỏi chuyến', true))) return;
                    await ctx.api('POST', `/api/hub/jobs/${j.id}/untrip`);
                    ARL.toast(`Đã gỡ ${j.code} khỏi chuyến ${t.code}.`);
                    rJobs(); rTasks();
                  }, 'small') : null));
              })))),
            h('div.h-row', H.link('#/live', 'Xem trên Rider Live', { class: 'btn small ghost' })));
        })), ...(other > 0 ? [h('p.sub.dispatch-other', `Còn ${other} chuyến khác trên Rider Live không mang việc của Ops Hub.`)] : []));
      }

      // ── Nạp dữ liệu ──
      const rJobs = W.coalesce(async () => {
        const q = W.clean({ team: ctx.role === 'admin' ? 'logistics' : undefined, view: 'team', status: 'active', type: W.FIELD_TYPES.join(','), upcoming: S.up ? '1' : undefined });
        try { D.jobs = await ctx.api('GET', '/api/hub/jobs', null, q); } catch (e) { if (!D.jobs) pickBox.replaceChildren(H.error(e, rJobs)); else ARL.toast(e.message, true); return; }
        if (!ctx.alive()) return;
        // Phần chuẩn bị của việc đã chọn có thể đổi (kit, thẻ): tải lại.
        for (const id of [...D.det.keys()]) if (!picked.has(id)) D.det.delete(id);
        for (const id of picked) loadDetail(id, true);
        paintPick(); paintSide(); paintTrips();
      });
      const rSites = W.coalesce(async () => {
        try { const r = await ctx.api('GET', '/api/sites'); D.sites = new Map(r.sites.map((s) => [s.id, s])); } catch (e) { if (!D.sites) pickBox.replaceChildren(H.error(e, rSites)); return; }
        if (!ctx.alive()) return;
        paintOpts(); paintPick(); paintSide();
      });
      const rFos = W.coalesce(async () => {
        try { const r = await ctx.api('GET', '/api/live'); D.fos = (r.fos || []).map((f) => ({ id: f.id, name: f.name, vehicle: f.vehicle, onShift: !!f.onShift, consent_ok: f.consent_ok })); } catch { if (!D.fos) D.fos = []; }
        if (!ctx.alive()) return;
        paintOpts();
      });
      const rTasks = W.coalesce(async () => {
        try { const r = await ctx.api('GET', '/api/tasks', null, { open: '1' }); D.tasks = r.tasks || []; } catch (e) { if (!D.tasks) tripsPane.replaceChildren(H.error(e, rTasks)); return; }
        if (!ctx.alive()) return;
        paintTrips(); paintPick(); paintTabs();
      });
      W.types(ctx).then((T) => { D.types = T; if (ctx.alive()) paintSide(); }).catch(() => {});
      paintSide(); paintTabs();
      rSites(); rFos(); rJobs(); rTasks();
      ctx.live(['jobs', 'kits', 'cards', 'acc'], () => { rJobs(); rTasks(); });
      ctx.live(['outlets'], () => rSites());
      ctx.every(45000, () => { rFos(); rTasks(); });
      ctx.onRoute((c) => { const t = c.query.tab === 'trips' ? 'trips' : 'plan'; if (t !== S.tab) { S.tab = t; paintPick(); show(); } });
    },
  });
})();
