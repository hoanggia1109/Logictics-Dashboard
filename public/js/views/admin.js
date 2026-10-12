/* Ops Hub — Hệ thống: Cấu hình (settings) và Nhập dữ liệu (import).
   Mọi con số cấu hình là đề xuất; máy chủ quyết định ai được sửa mục nào (theo team chốt) và kiểm tra giá trị. */
(() => {
  'use strict';
  const H = ARL.H, { h } = H;

  // ═════════════════════════════ CẤU HÌNH ═════════════════════════════
  // Đơn vị, khoảng cho phép (giống máy chủ, chỉ để gợi ý khi nhập) và lời giải thích ngắn cho từng mục.
  const NUM = {
    gbPerHour: [1, 200, 'GB/giờ', 0.1], swapLeadDays: [0, 14, 'ngày'], setupShowDays: [0, 14, 'ngày'], stockCheckDay: [1, 7, ''], cardsPerKit: [1, 10, 'thẻ'],
    poolAlertMin: [5, 1440, 'phút'], leadOverdueMin: [10, 2880, 'phút'], leadPileJobs: [1, 50, 'việc'], leadPileMin: [10, 1440, 'phút'], earlyCheckinMin: [0, 120, 'phút'],
    lateAfterMin: [0, 120, 'phút'], absentAfterMin: [15, 600, 'phút'], releaseGraceMin: [0, 240, 'phút'], minDaysWeek: [0, 7, 'công'], minDaysMonth: [0, 31, 'công'], spikeMin: [1, 50, 'lần'],
    dailyStdHours: [0.5, 24, 'giờ/ngày', 0.5], quotaWarnPct: [50, 99, '%'], evalLagDays: [0, 7, 'ngày'], foStopStd: [0, 120, 'phút'], prepMinHours: [1, 24, 'giờ'], replayMin: [1, 60, 'phút'],
    incidentAckMin: [5, 1440, 'phút'], incidentOldH: [1, 720, 'giờ'], incidentCancelMin: [0, 1440, 'phút'], uploadLateH: [1, 240, 'giờ'], reqLateDays: [0, 30, 'ngày'], cardsStaleDays: [1, 30, 'ngày'], cardsReturnedH: [1, 240, 'giờ'],
    officeCardsMin: [0, 1000, 'thẻ'], cardsUploadedHours: [1, 336, 'giờ'], shootWindowDays: [7, 365, 'ngày'], recordEditHours: [1, 720, 'giờ'],
  };
  const EXPLAIN = {
    gbPerHour: 'Tech nhập dung lượng thẻ (GB); số giờ ghi hình = GB chia cho con số này.',
    checkBeforeShip: 'Kit phải được Tech kiểm đạt mới được giao ra BO.',
    uploadPhotoRequired: 'Khi nhập dung lượng thẻ phải kèm ảnh chụp màn hình dung lượng.',
    swapLeadDays: 'Việc đổi thẻ được tạo sẵn trước ngày đổi bao nhiêu ngày để kịp chuẩn bị.',
    setupShowDays: 'Việc giao và setup hiện ra trước ngày launch bao nhiêu ngày.',
    stockCheckDay: 'Ngày trong tuần hệ thống tạo việc kiểm kho cho Logistics.',
    cardsPerKit: 'Mỗi lượt đổi thẻ mang theo bao nhiêu thẻ cho mỗi máy.',
    autoAssign: 'Việc mới tự giao cho người đang trong ca (theo bảng phân ca), ai ít việc nhất nhận trước. Việc tồn qua đêm chia đều cho người đang trong ca và người sắp vào ca; có người vào ca thì việc hệ thống đã giao mà chưa bắt đầu được san lại (việc Lead giao tay giữ nguyên). Tắt thì việc để chung, ai rảnh tự nhận.',
    poolAlertMin: 'Việc chưa ai nhận lâu hơn mức này trong khi team có người trong ca thì báo Lead.',
    leadOverdueMin: 'Việc quá hạn lâu hơn mức này thì báo Lead và hiện trong mục Điểm nghẽn của Tổng quan.',
    leadPileJobs: 'Một người giữ nhiều việc hơn mức này (và việc lâu nhất chờ quá mức bên dưới) thì báo Lead để san tải.',
    leadPileMin: 'Đi cùng mục trên: việc lâu nhất người đó đang giữ đã chờ quá bao nhiêu phút.',
    zeroHourAlert: 'Báo cho Sale khi thẻ của BO mình phụ trách ghi 0 giờ quay.',
    earlyCheckinMin: 'Mở ứng dụng sớm hơn giờ vào ca tối đa bao nhiêu phút vẫn được tính là vào ca.',
    lateAfterMin: 'Vào sau giờ ca quá số phút này thì ghi "Vào trễ".',
    absentAfterMin: 'Quá giờ vào ca bao lâu mà chưa vào thì ghi vắng; việc chưa bắt đầu của người đó chuyển cho người khác trong ca.',
    releaseGraceMin: 'Đề xuất 30 phút. Hết ca quá mức này (hoặc hôm nay không có ca) thì việc chưa bắt đầu của người đó trả về cho người đang trong ca; việc đang làm giữ nguyên, Lead được báo.',
    rosterSelfApprove: 'Bật: ca nhân viên tự đăng ký có hiệu lực ngay. Tắt: chờ Lead duyệt.',
    shifts: 'Các ca có sẵn để chọn khi xếp hoặc đăng ký ca. Đổi giờ ca mẫu không đổi các ca đã xếp trước đó.',
    minDaysWeek: 'Trong tuần có ít công hơn mức này thì chưa xếp loại người đó.',
    minDaysMonth: 'Trong tháng có ít công hơn mức này thì chưa xếp loại người đó.',
    rateLogistics: 'Xếp loại nhân sự Logistics theo điểm. Tắt khi định mức của Logistics chưa được bấm giờ thật.',
    scoreWeights: 'Tỉ trọng của khối lượng, đúng hạn, chất lượng và chuyên cần trong điểm tổng hợp. Không cần cộng đủ 100: hệ thống chia theo tỉ lệ.',
    scoreBands: 'Điểm tổng hợp từ ngưỡng này trở lên được mức 5, 4, 3, 2; thấp hơn là mức 1.',
    spikeMin: 'Một lỗi được coi là tăng vọt khi xuất hiện ít nhất từng này lần trong tuần và gấp đôi trung bình 4 tuần trước.',
    saleSeesAll: 'Bật: Sale Lead xem mọi BO. Tắt: chỉ BO mình phụ trách. Head of Sale luôn xem tất cả.',
    labels: 'Danh sách nhãn lỗi để chọn khi báo sự cố, riêng cho Multicam KIT và iPhone Mono.',
    dailyStdHours: 'Chuẩn giờ quay thô mỗi kit mỗi ngày; BO quay dưới chuẩn được đánh dấu để Sale theo dõi.',
    quotaWarnPct: 'BO dùng tới mức này của quota giờ quay thì báo "sắp chạm quota".',
    evalLagDays: 'So giờ quay với kỳ trước (WoW / MoM) tới trước mấy ngày gần nhất, vì thẻ chưa kịp về và nhập. Chuẩn giờ quay không dùng mục này: chỉ xét những ngày thẻ đã nhập đủ.',
    foStopStd: 'Phút chuẩn tính cho FO mỗi điểm giao nhận xong mà không gắn với việc của hub.',
    prepMinHours: 'Việc chuẩn bị kit luôn có ít nhất bấy nhiêu giờ, kể cả khi ngày launch rất gần. Launch gấp hơn mức này thì việc được đánh dấu gấp, không bị tính là trễ ngay khi vừa tạo.',
    replayMin: 'Cùng một người bấm gửi lại cùng một hộp thoại (mất mạng, mở hai tab) trong khoảng này thì hệ thống trả lại kết quả lần trước, không ghi thêm.',
    incidentAckMin: 'Sự cố có việc của Tech mà chưa ai nhận lâu hơn mức này thì hiện trong Điểm nghẽn (mức cần xử lý ngay).',
    incidentOldH: 'Sự cố còn mở lâu hơn mức này thì hiện trong Điểm nghẽn. Sự cố chỉ chờ Logistics đổi kit thì tính cho Logistics.',
    incidentCancelMin: 'Người báo tự huỷ sự cố của mình trong khoảng này (ví dụ báo nhầm BO); sau đó Tech Lead huỷ. Đặt 0 thì chỉ Tech Lead huỷ.',
    uploadLateH: 'Thẻ Tech đã nhận mà chưa nhập dung lượng lâu hơn mức này thì hiện trong Điểm nghẽn và mục theo dõi của Tech.',
    reqLateDays: 'Yêu cầu mở BO hoặc thêm kit còn từng này ngày (hoặc ít hơn) tới ngày giao mà kit chưa sẵn sàng thì hiện trong Điểm nghẽn.',
    cardsStaleDays: 'Thẻ nằm ở BO lâu hơn mức này thì hiện trong Điểm nghẽn và mục theo dõi của Logistics để xếp lượt đổi thẻ. BO đổi thẻ thưa hơn (ví dụ thứ Sáu tới thứ Hai) thì tính theo khoảng giữa hai ngày đổi cộng 1 ngày.',
    cardsReturnedH: 'Thẻ đã thu về văn phòng mà chưa lập phiếu gửi Tech lâu hơn mức này thì hiện trong Điểm nghẽn và mục theo dõi của Logistics.',
    officeCardsMin: 'Thẻ sẵn sàng tại văn phòng (chưa chọn cho chuyến nào) ít hơn mức này thì báo Logistics, mỗi ngày một lần. Đặt 0 để tắt.',
    cardsUploadedHours: 'Thẻ đã nhập dung lượng lâu hơn mức này mà chưa trả Logistics thì hiện trong mục theo dõi của Tech.',
    shootWindowDays: 'Ngày quay khi nhập hoặc sửa dung lượng phải nằm trong số ngày gần đây này (không ở tương lai).',
    recordEditHours: 'Người nhập tự sửa bản ghi dung lượng của mình trong số giờ này; quá hạn thì nhờ Tech Lead sửa.',
  };
  const WEEKDAY = { 1: 'Thứ Hai', 2: 'Thứ Ba', 3: 'Thứ Tư', 4: 'Thứ Năm', 5: 'Thứ Sáu', 6: 'Thứ Bảy', 7: 'Chủ nhật' };
  const W_LABEL = { vol: 'Khối lượng', sla: 'Đúng hạn', quality: 'Chất lượng', att: 'Chuyên cần' };
  const GROUPS = [
    { id: 'sale', title: 'Kinh doanh', sub: 'Head of Sale chốt', owners: ['Sale', 'Sale và Tech'], keys: ['dailyStdHours', 'quotaWarnPct', 'zeroHourAlert'] },
    { id: 'tech', title: 'Kỹ thuật', sub: 'Tech Lead chốt', owners: ['Tech'], keys: ['gbPerHour', 'checkBeforeShip', 'uploadPhotoRequired', 'shootWindowDays', 'recordEditHours', 'cardsUploadedHours', 'evalLagDays', 'labels', 'spikeMin', 'incidentAckMin', 'incidentOldH', 'incidentCancelMin', 'uploadLateH'] },
    { id: 'logistics', title: 'Logistics', sub: 'Logistic Lead chốt', owners: ['Logistics'], keys: ['cardsPerKit', 'swapLeadDays', 'setupShowDays', 'prepMinHours', 'stockCheckDay', 'officeCardsMin', 'foStopStd', 'rateLogistics', 'reqLateDays', 'cardsStaleDays', 'cardsReturnedH'] },
    { id: 'lead', title: 'Ca làm, giao việc và đánh giá', sub: 'Mỗi team một giá trị riêng · mỗi Lead chốt phần của team mình', owners: ['Lead'], keys: ['shifts', 'rosterSelfApprove', 'earlyCheckinMin', 'lateAfterMin', 'absentAfterMin', 'releaseGraceMin', 'autoAssign', 'poolAlertMin', 'leadOverdueMin', 'leadPileJobs', 'leadPileMin', 'minDaysWeek', 'minDaysMonth', 'scoreWeights', 'scoreBands'] },
    { id: 'jobs', title: 'Định mức theo loại việc', sub: 'Mỗi Lead chốt phần việc của team mình', owners: [], keys: ['jobStd', 'jobSla'] },
    { id: 'admin', title: 'Quản trị hệ thống', sub: 'Quản trị chốt', owners: ['Quản trị'], keys: ['saleSeesAll', 'replayMin'] },
  ];
  const OWNER_TXT = { Lead: 'Lead của từng team chốt phần của team mình', Tech: 'Tech chốt', Logistics: 'Logistics chốt', Sale: 'Sale chốt', 'Sale và Tech': 'Sale và Tech chốt', 'Quản trị': 'Quản trị chốt' };
  const PER = { kit: 'phút/kit', card: 'phút/thẻ', line: 'phút/dòng', job: 'phút/việc' };
  const FIXED_DUE = { deliver: 'Cuối ngày launch', card_swap: 'Cuối khung giờ đổi thẻ của BO', stock_check: 'Cuối ngày kiểm kho' };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const TEAMS = [['tech', 'Tech'], ['logistics', 'Logistics']];
  const TEAM_NAME = Object.fromEntries(TEAMS);

  ARL.hub.view('settings', {
    mount(el, ctx) {
      const role = ctx.role;
      const S = { c: null, log: [], tab: ctx.query.g || 'all', mine: ctx.query.mine === '1' };
      const canLog = role !== 'sale_head'; // nhật ký cấu hình chỉ Lead và Quản trị xem
      const who = { admin: 'Quản trị sửa được mọi mục, cả phần của Tech và của Logistics.', tech_lead: 'Bạn sửa được mục do Tech chốt, phần của Tech trong các mục riêng từng team và định mức việc của Tech.', lead: 'Bạn sửa được mục do Logistics chốt, phần của Logistics trong các mục riêng từng team và định mức việc của Logistics.', sale_head: 'Bạn sửa được mục do Sale chốt.' }[role] || '';
      el.append(H.head('Cấu hình', 'Mọi con số ở đây là đề xuất; mỗi mục ghi rõ team nào chốt. Đổi xong có hiệu lực ngay, không cần sửa phần mềm.'));
      const tabs = H.tabs([['all', 'Tất cả'], ...GROUPS.map((g) => [g.id, g.title.split(',')[0]])], S.tab, (k) => { S.tab = k; ctx.setQuery({ g: k === 'all' ? '' : k }); paint(); });
      const mineBox = h('label.h-field.h-inline.set-mine', h('input', { type: 'checkbox', checked: S.mine, onchange: (e) => { S.mine = e.target.checked; ctx.setQuery({ mine: S.mine ? '1' : '' }); paint(); } }), h('span', 'Chỉ mục tôi sửa được'));
      const intro = h('div.set-intro');
      const body = h('div.set-body', H.loading(8));
      const logBox = h('div');
      el.append(tabs, h('div.h-tools', mineBox), intro, body, logBox);

      async function load() {
        try {
          const [c, lg] = await Promise.all([ctx.api('GET', '/api/hub/config'), canLog ? ctx.api('GET', '/api/hub/log', null, { entity: 'config', limit: 200 }).catch(() => ({ items: [] })) : { items: [] }]);
          if (!ctx.alive()) return;
          S.c = c; S.log = lg.items || [];
          paint();
        } catch (e) { if (!S.c) body.replaceChildren(H.error(e, load)); else ARL.toast(e.message, true); }
      }
      const can = (k) => S.c.editable.includes(k);
      // Mục riêng theo team: giá trị dạng { tech, logistics }; Lead chỉ sửa phần của team mình, Quản trị sửa cả hai.
      const isTeam = (k) => (S.c.team_keys || []).includes(k);
      const canTeam = (k, t) => can(k) && (S.c.my_teams || []).includes(t);
      const lastChange = (k) => S.log.find((l) => l.data && typeof l.data === 'object' && k in l.data);
      function fmt(k, v) {
        const c = S.c;
        if (v === null && k === 'labels') return 'Bộ đề xuất';
        if (typeof v === 'boolean') return v ? 'Bật' : 'Tắt';
        if (k === 'stockCheckDay') return WEEKDAY[v] || String(v);
        if (NUM[k]) return `${H.num(v, 2)}${NUM[k][2] ? ' ' + NUM[k][2] : ''}`;
        if (k === 'shifts') return (v || []).map((s) => `${s.id} ${s.start}–${s.end}`).join(' · ');
        if (k === 'scoreWeights') return Object.entries(W_LABEL).map(([x, l]) => `${l} ${v[x]}`).join(' · ');
        if (k === 'scoreBands') return v.map((x, i) => `Mức ${5 - i} ≥ ${x}`).join(' · ');
        if (k === 'labels') { const L = v || c.default_labels; return `Multicam ${L.multicam.length} nhãn · iPhone ${L.iphone.length} nhãn`; }
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
      }
      function valueNode(k, v) {
        if (typeof v === 'boolean') return H.pill(v ? 'Bật' : 'Tắt', v ? 'go' : 'off');
        if (k === 'shifts') return h('span.set-shifts', (v || []).map((s) => h('span.set-shift', h('b', s.id), ` ${s.name} `, h('small', `${s.start}–${s.end}`))));
        return h('b.set-v', fmt(k, v));
      }
      function row(k) {
        const c = S.c, v = c.values[k], d = c.defaults[k], owner = c.owners[k] || '', team = isTeam(k), lc = lastChange(k);
        const changed = team ? TEAMS.some(([t]) => !same(v[t], d)) : !same(v, d);
        const meta = [h('span.set-own', 'Đề xuất · ', OWNER_TXT[owner] || `${owner} chốt`)];
        meta.push(h('span', `Mặc định${team ? ' (cả hai team)' : ''}: ${fmt(k, d)}`));
        if (lc) meta.push(h('span', `Đổi ${H.when(lc.ts)} · ${lc.actor}`));
        const right = team
          ? h('div.set-r.set-teams', TEAMS.map(([t, tn]) => h('div.set-team', { 'data-team': t },
            h('span.set-tn', tn), valueNode(k, v[t]),
            canTeam(k, t) ? H.btn('Sửa', () => edit(k, t), 'small', { 'aria-label': `Sửa: ${c.labels[k] || k} (${tn})` }) : h('span.set-ro', 'Chỉ xem'))))
          : h('div.set-r', valueNode(k, v), can(k) ? H.btn('Sửa', () => edit(k), 'small', { 'aria-label': `Sửa: ${c.labels[k] || k}` }) : h('span.set-ro', 'Chỉ xem'));
        return h('div.set-row', { 'data-k': k, 'data-changed': changed ? '1' : null },
          h('div.set-l', h('h4', c.labels[k] || k, changed ? H.pill('Đã đổi', 'blue', { class: 'sm' }) : null), EXPLAIN[k] ? h('p', EXPLAIN[k]) : null, h('p.set-meta', meta)), right);
      }
      function groupKeys(g) {
        const c = S.c;
        const ks = g.keys.filter((k) => k in c.values);
        if (g.id !== 'jobs') for (const k of Object.keys(c.values)) if (!ks.includes(k) && g.owners.includes(c.owners[k]) && !GROUPS.some((x) => x.keys.includes(k))) ks.push(k);
        return ks;
      }
      function paint() {
        const c = S.c;
        const n = c.editable.length;
        intro.replaceChildren(H.note(n ? `${who} (${n} mục)` : 'Vai trò của bạn chỉ xem cấu hình; mỗi mục ghi rõ team nào chốt.', n ? null : 'wait'));
        const out = [];
        for (const g of GROUPS) {
          if (S.tab !== 'all' && S.tab !== g.id) continue;
          if (g.id === 'jobs') { const t = jobsCard(); if (t) out.push(t); continue; }
          let ks = groupKeys(g);
          if (S.mine) ks = ks.filter(can);
          if (!ks.length) continue;
          out.push(H.card(g.title, h('div.set-list', ks.map(row)), { sub: g.sub, flush: true }));
        }
        body.replaceChildren(...(out.length ? out : [H.empty(S.mine ? 'Không có mục nào bạn sửa được trong nhóm này.' : 'Không có mục nào.')]));
        paintLog();
      }
      function paintLog() {
        if (!canLog) { logBox.replaceChildren(); return; }
        const items = S.log.slice(0, 15);
        logBox.replaceChildren(H.sec('Thay đổi gần đây', 'Ai đổi gì, lúc nào (nhật ký thao tác)'), items.length ? h('div.h-list', items.map((l) => h('div.h-item',
          h('span.h-item-t', l.actor), h('span.h-item-m', l.text), h('span.h-item-r', h('small.sub', H.when(l.ts)))))) : H.empty('Chưa ai đổi cấu hình. Đang dùng toàn bộ giá trị đề xuất.'));
      }

      // ── Định mức theo loại việc ──
      // Dòng của team nào do Lead team đó chốt; dòng chung không team chỉ Quản trị (máy chủ kiểm lại).
      const rowTeamOk = (team) => role === 'admin' || (role === 'tech_lead' && team === 'tech') || (role === 'lead' && team === 'logistics');
      function jobRows() {
        const c = S.c, out = [];
        for (const t of c.job_types) {
          // Việc giao tay: Lead đặt phút chuẩn và hạn ở từng việc; việc nhân viên tự tạo tính theo dòng của team mình.
          if (t.id === 'manual') { for (const tm of ['tech', 'logistics']) out.push({ id: `manual_${tm}`, label: `${t.label} (nhân viên tự tạo)`, team: tm, per: t.per, std: t.std, sla: t.sla, fixed: 'Theo hạn đặt khi tạo việc' }); continue; }
          out.push({ id: t.id, label: t.label, team: t.team, per: t.per, std: t.std, sla: t.sla, fixed: FIXED_DUE[t.id] || null });
          if (t.id === 'incident') for (const [rk, r] of Object.entries(c.incident_res || {})) out.push({ id: 'incident_' + rk, label: `· ${r.label}`, team: 'tech', per: 'job', std: r.std, sla: null, sub: true, fixed: 'Theo việc xử lý sự cố' });
        }
        return out;
      }
      function jobsCard() {
        const c = S.c, std = c.values.jobStd || {}, sla = c.values.jobSla || {};
        const editable = can('jobStd') || can('jobSla');
        let rows = jobRows();
        if (S.mine) rows = rows.filter((r) => editable && rowTeamOk(r.team));
        if (S.mine && !rows.length) return null;
        const teamPill = (t) => (t ? H.pill(t === 'tech' ? 'Tech' : 'Logistics', t === 'tech' ? 'blue' : 'go') : '');
        const stdCell = (r) => { const v = std[r.id]; return h('span', h('b', `${H.num(v ?? r.std, 1)}`), ` ${PER[r.per] || 'phút'}`, v !== undefined && v !== r.std ? h('small', `Mặc định ${H.num(r.std, 1)}`) : null); };
        const slaCell = (r) => { if (r.sub) return h('span.sub', 'Như việc sự cố'); if (r.fixed) return h('span.sub', r.fixed); const v = sla[r.id]; return h('span', h('b', H.dur(v ?? r.sla)), v !== undefined && v !== r.sla ? h('small', `Mặc định ${H.dur(r.sla)}`) : null); };
        const tbl = H.table({
          columns: [
            { key: 'label', label: 'Loại việc', render: (r) => h('span', { class: r.sub ? 'set-subrow' : null }, r.label) },
            { key: 'team', label: 'Team', render: (r) => teamPill(r.team) },
            { key: 'std', label: 'Phút chuẩn', align: 'r', value: (r) => std[r.id] ?? r.std, render: stdCell },
            { key: 'sla', label: 'Hạn xử lý', align: 'r', value: (r) => (r.fixed ? null : sla[r.id] ?? r.sla), render: slaCell },
            { key: 'act', label: '', sort: false, align: 'r', render: (r) => (editable && rowTeamOk(r.team) ? H.btn('Sửa', () => editJob(r), 'small', { 'aria-label': `Sửa định mức: ${r.label}` }) : h('span.set-ro', 'Chỉ xem')) },
          ],
          rows, sortable: false, pageSize: 100, rowTone: (r) => (std[r.id] !== undefined || sla[r.id] !== undefined ? 'go' : null),
        });
        const lc = lastChange('jobStd') || lastChange('jobSla');
        return H.card('Định mức theo loại việc', h('div', h('p.sub.set-jobsub', 'Điểm khối lượng = phút chuẩn ÷ 6. Hạn xử lý tính từ lúc việc có người nhận. ', h('span.set-own', 'Đề xuất · mỗi Lead chốt phần việc của team mình'), lc ? ` · Đổi ${H.when(lc.ts)} · ${lc.actor}` : ''), tbl));
      }
      async function editJob(r) {
        const c = S.c, std = { ...(c.values.jobStd || {}) }, sla = { ...(c.values.jobSla || {}) };
        const slaEditable = !r.fixed && !r.sub && can('jobSla');
        const fields = [
          can('jobStd') ? { name: 'std', label: `Phút chuẩn (${PER[r.per] || 'phút'})`, type: 'number', min: 0, max: 600, step: 0.5, value: std[r.id] ?? '', placeholder: String(r.std), hint: `Để trống = dùng mặc định ${H.num(r.std, 1)}. Từ 0 đến 600.` } : null,
          slaEditable ? { name: 'sla', label: 'Hạn xử lý (phút)', type: 'number', min: 5, max: 43200, step: 5, value: sla[r.id] ?? '', placeholder: String(r.sla), hint: `Để trống = mặc định ${H.dur(r.sla)}. Từ 5 phút đến 30 ngày.` } : null,
        ].filter(Boolean);
        await H.form({
          title: `Định mức · ${r.label.replace(/^· /, '')}`,
          intro: r.fixed && !r.sub ? `Hạn của việc này theo lịch (${r.fixed.toLowerCase()}), không đổi ở đây.` : 'Áp dụng cho việc tạo từ bây giờ; việc đã xong giữ điểm cũ.',
          fields, submit: 'Lưu định mức',
          onSubmit: async (v) => {
            const patch = {};
            // Chỉ gửi dòng đang sửa (trống = null, về mặc định); máy chủ giữ nguyên các dòng khác.
            if ('std' in v && (std[r.id] ?? null) !== v.std) patch.jobStd = { [r.id]: v.std };
            if ('sla' in v && (sla[r.id] ?? null) !== v.sla) patch.jobSla = { [r.id]: v.sla };
            if (!Object.keys(patch).length) return;
            await put(patch, `định mức ${r.label.replace(/^· /, '')}`);
          },
        });
      }

      // ── Sửa một mục ──
      async function put(patch, what) {
        const r = await ctx.api('PUT', '/api/hub/config', patch);
        S.c.values = r.values;
        // Giữ nhãn và cấu hình dùng chung của giao diện khớp với máy chủ (các màn hình khác đọc từ ARL.hubMeta).
        const m = ARL.hubMeta;
        if (m) { if (patch.shifts) m.shifts = r.values.shifts; if (m.cfg) for (const k of Object.keys(m.cfg)) if (k in patch) m.cfg[k] = r.values[k]; }
        ARL.toast(`Đã lưu: ${what}.`);
        if (canLog) { try { S.log = (await ctx.api('GET', '/api/hub/log', null, { entity: 'config', limit: 200 })).items || []; } catch { /* giữ nhật ký cũ */ } }
        if (ctx.alive()) paint();
      }
      /** Sửa một mục; team: phần của team nào (mục riêng theo team), chỉ gửi đúng phần đó lên máy chủ. */
      function edit(k, team) {
        const c = S.c, v = team ? c.values[k][team] : c.values[k], d = c.defaults[k], label = (c.labels[k] || k) + (team ? ` · ${TEAM_NAME[team]}` : '');
        const wrap = (x) => ({ [k]: team ? { [team]: x } : x });
        if (k === 'shifts') return editShifts(team);
        if (k === 'labels') return editLabels();
        const intro = h('div.h-stack', h('p.sub', EXPLAIN[k] || ''), h('p.sub', `Đề xuất · ${team ? `phần của ${TEAM_NAME[team]}, không đổi phần của team kia` : OWNER_TXT[c.owners[k]] || c.owners[k] + ' chốt'} · Mặc định: ${fmt(k, d)}`));
        if (typeof d === 'boolean') {
          return H.form({ title: label, intro, fields: [{ name: 'v', label: 'Trạng thái', type: 'select', options: [['1', 'Bật'], ['0', 'Tắt']], value: v ? '1' : '0' }], submit: 'Lưu',
            onSubmit: async (x) => { const nv = x.v === '1'; if (nv !== v) await put(wrap(nv), label); } });
        }
        if (k === 'stockCheckDay') {
          return H.form({ title: label, intro, fields: [{ name: 'v', label: 'Ngày kiểm kho', type: 'select', options: Object.entries(WEEKDAY), value: v, numeric: true }], submit: 'Lưu',
            onSubmit: async (x) => { if (x.v !== v) await put(wrap(x.v), label); } });
        }
        if (NUM[k]) {
          const [min, max, unit, step] = NUM[k];
          const reset = h('button.ghost.small', { type: 'button', onclick: (e) => { const i = e.target.closest('form').querySelector('[name="v"]'); i.value = d; i.focus(); } }, `Về mặc định (${H.num(d, 2)})`);
          return H.form({ title: label, intro, extra: h('div.h-row', reset), fields: [{ name: 'v', label: `Giá trị${unit ? ` (${unit})` : ''}`, type: 'number', min, max, step: step || 1, value: v, required: true, hint: `Cho phép từ ${H.num(min, 2)} đến ${H.num(max, 2)}.` }], submit: 'Lưu',
            onSubmit: async (x, ctl) => {
              if (x.v === null || Number.isNaN(x.v)) { ctl.setErr('Nhập một số.'); return false; }
              if (x.v < min || x.v > max) { ctl.setErr(`Giá trị từ ${H.num(min, 2)} đến ${H.num(max, 2)}.`); return false; }
              if (x.v !== v) await put(wrap(x.v), label);
            } });
        }
        if (k === 'scoreWeights') {
          return H.form({ title: label, intro, fields: Object.entries(W_LABEL).map(([x, l]) => ({ name: x, label: `${l} (%)`, type: 'number', min: 0, max: 100, step: 1, value: v[x], required: true })), submit: 'Lưu trọng số',
            onSubmit: async (x, ctl) => {
              const o = Object.fromEntries(Object.keys(W_LABEL).map((q) => [q, x[q]]));
              if (Object.values(o).some((n) => n === null || n < 0 || n > 100 || !Number.isInteger(n))) { ctl.setErr('Mỗi trọng số là số nguyên từ 0 đến 100.'); return false; }
              if (!Object.values(o).some((n) => n > 0)) { ctl.setErr('Cần ít nhất một trọng số lớn hơn 0.'); return false; }
              if (!same(o, v)) await put(wrap(o), label);
            } });
        }
        if (k === 'scoreBands') {
          return H.form({ title: label, intro, fields: v.map((x, i) => ({ name: 'b' + i, label: `Mức ${5 - i} từ điểm`, type: 'number', min: 0, max: 100, step: 1, value: x, required: true })), submit: 'Lưu ngưỡng',
            onSubmit: async (x, ctl) => {
              const b = v.map((_, i) => x['b' + i]);
              if (b.some((n) => n === null || n < 0 || n > 100) || b.some((n, i) => i && n >= b[i - 1])) { ctl.setErr('Ngưỡng phải giảm dần từ mức 5 xuống mức 2, trong khoảng 0–100.'); return false; }
              if (!same(b, v)) await put(wrap(b), label);
            } });
        }
        ARL.toast('Mục này chưa sửa được trên giao diện.', true);
        return null;
      }
      function editShifts(team) {
        const c = S.c, label = (c.labels.shifts || 'Ca mẫu') + (team ? ` · ${TEAM_NAME[team]}` : '');
        const cur = team ? c.values.shifts[team] : c.values.shifts;
        const list = h('div.set-shiftlist');
        const addRow = (s) => {
          const r = h('div.set-shiftrow',
            h('label', h('span', 'Mã'), h('input', { name: 'id', value: s ? s.id : '', maxlength: 6, autocomplete: 'off', placeholder: 'VD: T' })),
            h('label', h('span', 'Tên ca'), h('input', { name: 'name', value: s ? s.name : '', maxlength: 30, autocomplete: 'off', placeholder: 'VD: Ca tối' })),
            h('label', h('span', 'Giờ vào'), h('input', { name: 'start', type: 'time', value: s ? s.start : '' })),
            h('label', h('span', 'Giờ ra'), h('input', { name: 'end', type: 'time', value: s ? s.end : '' })),
            h('button.ghost.danger.set-del', { type: 'button', 'aria-label': 'Bỏ ca này', title: 'Bỏ ca này', onclick: () => { if (list.children.length > 1) r.remove(); else ARL.toast('Cần ít nhất một ca mẫu.', true); } }, '×'));
          list.append(r);
        };
        for (const s of cur || []) addRow(s);
        const add = h('button.small', { type: 'button', onclick: () => { if (list.children.length >= 10) return ARL.toast('Tối đa 10 ca mẫu.', true); addRow(null); list.lastChild.querySelector('input').focus(); } }, '+ Thêm ca');
        ARL.modal({
          title: label, wide: true,
          body: h('div.h-stack', h('p.sub', EXPLAIN.shifts), h('p.sub', `Đề xuất · ${team ? `ca mẫu riêng của ${TEAM_NAME[team]}, Lead của team chốt theo giờ làm thật` : 'Lead chốt theo giờ làm thật của từng team'}. Mã ca ngắn (chữ, số, tối đa 6 ký tự). Chưa hỗ trợ ca qua đêm.`), list, h('div.h-row', add)),
          actions: [{ label: 'Thôi', cls: 'ghost', run: () => {} }, { label: 'Lưu ca mẫu', cls: 'primary', run: async () => {
            const rows = [...list.children].map((r) => ({ id: r.querySelector('[name=id]').value.trim().toUpperCase(), name: r.querySelector('[name=name]').value.trim(), start: r.querySelector('[name=start]').value, end: r.querySelector('[name=end]').value }));
            for (const s of rows) {
              if (!/^[A-Z0-9]{1,6}$/.test(s.id)) throw new Error('Mã ca chỉ gồm chữ không dấu và số, tối đa 6 ký tự.');
              if (!s.name) throw new Error(`Ca ${s.id}: cần tên ca.`);
              if (!s.start || !s.end || s.end <= s.start) throw new Error(`Ca ${s.id}: giờ ra phải sau giờ vào.`);
            }
            if (new Set(rows.map((s) => s.id)).size !== rows.length) throw new Error('Mã ca bị trùng.');
            if (!same(rows, cur)) await put({ shifts: team ? { [team]: rows } : rows }, label);
          } }],
        });
      }
      function editLabels() {
        const c = S.c, cur = c.values.labels || c.default_labels, label = c.labels.labels || 'Bộ nhãn lỗi';
        const ta = (kind) => h('textarea', { name: kind, rows: 12, spellcheck: 'false' }, cur[kind].join('\n'));
        const mc = ta('multicam'), ip = ta('iphone');
        const countOf = (t) => t.value.split('\n').map((s) => s.trim()).filter(Boolean).length;
        const cnt = h('p.sub');
        const upd = () => { cnt.textContent = `Multicam KIT: ${countOf(mc)} nhãn · iPhone Mono: ${countOf(ip)} nhãn. Nhãn "Khác" luôn được giữ ở cuối.`; };
        mc.addEventListener('input', upd); ip.addEventListener('input', upd); upd();
        ARL.modal({
          title: label, wide: true,
          body: h('div.h-stack', h('p.sub', 'Mỗi dòng một nhãn (1–60 nhãn mỗi dòng máy). Đề xuất · Tech chốt theo bộ nhãn của file Tech. Đổi nhãn không sửa các sự cố đã báo.'),
            h('div.set-labels', h('label.h-field', h('span', 'Multicam KIT'), mc), h('label.h-field', h('span', 'iPhone Mono'), ip)), cnt),
          actions: [
            c.values.labels ? { label: 'Dùng lại bộ đề xuất', cls: 'ghost', run: async () => { if (!(await H.confirm('Bỏ bộ nhãn đang dùng và quay về bộ nhãn đề xuất?', 'Dùng bộ đề xuất', true))) return false; await put({ labels: null }, label); } } : null,
            { label: 'Thôi', cls: 'ghost', run: () => {} },
            { label: 'Lưu bộ nhãn', cls: 'primary', run: async () => {
              const o = { multicam: mc.value.split('\n').map((s) => s.trim()).filter(Boolean), iphone: ip.value.split('\n').map((s) => s.trim()).filter(Boolean) };
              if (!o.multicam.length || !o.iphone.length) throw new Error('Mỗi dòng máy cần ít nhất một nhãn.');
              if (!same(o, cur)) await put({ labels: o }, label);
            } },
          ].filter(Boolean),
        });
      }

      ctx.live(['config'], load);
      load();
    },
  });

  // ═════════════════════════════ NHẬP DỮ LIỆU ═════════════════════════════
  const MAX_MB = 12;
  /** Mô tả các sheet hệ thống đọc được (theo phần nhập ở máy chủ). */
  const SHEETS = [
    { id: 'outlets', n: 'BO', t: 'BO (điểm ghi hình)', s: 'BO, Danh sách BO, Outlet, Tracker', req: 'Tên BO', opt: 'mã BO, địa chỉ, người liên hệ, SĐT, Sale phụ trách, khu vực, ngành, link Google Maps hoặc toạ độ, ngày đổi thẻ (T2, T4, T6…), khung giờ đổi thẻ, ngày launch, ngày kết thúc, trạng thái, quota giờ quay, ngày onboard' },
    { id: 'kits', n: 'kit', t: 'Kit', s: 'Kit, Multicam KIT, iPhone Mono', req: 'Mã kit', opt: 'loại kit, trạng thái, BO đang đặt, mã Multicam, CM5, iPhone, Powerbank, số lượng từng phụ kiện trong kit' },
    { id: 'devices', n: 'thiết bị', t: 'Thiết bị lẻ', s: 'Thiết bị, Device, Inventory, Tài sản', req: 'Mã thiết bị', opt: 'loại thiết bị, tình trạng, mã kit, sức khoẻ pin' },
    { id: 'cards', n: 'thẻ nhớ', t: 'Thẻ nhớ', s: 'Thẻ, Thẻ nhớ, Card, SD', req: 'Mã thẻ', opt: 'trạng thái, BO đang giữ thẻ' },
    { id: 'acc', n: 'phụ kiện', t: 'Tồn phụ kiện', s: 'Phụ kiện, Tồn phụ kiện', req: 'Tên phụ kiện, Tổng số lượng', opt: '' },
    { id: 'records', n: 'lịch sử giờ quay', t: 'Dung lượng thẻ (lịch sử giờ quay)', s: 'Dung lượng, Giờ quay, Raw, Chi tiết', req: 'Mã thẻ, Ngày quay, và GB hoặc Giờ quay', opt: 'BO, lý do 0 giờ, mã kit' },
    { id: 'incidents', n: 'sự cố', t: 'Sự cố (lịch sử)', s: 'Sự cố, Báo lỗi, Nhãn lỗi', req: 'Ngày báo, BO, Nhãn lỗi', opt: 'mã kit, mô tả, trạng thái, cách xử lý, ngày xử lý' },
    { id: 'users', n: 'tài khoản', t: 'Tài khoản người dùng', s: 'Nhân sự, Nhân viên, Tài khoản', req: 'Họ tên, Vai trò', opt: 'tên đăng nhập, email, SĐT' },
  ];
  /** Loại dữ liệu chỉ team sở hữu nhập (khớp máy chủ, core/hub/importer.js): tài khoản, dung lượng thẻ, sự cố của Tech; tồn phụ kiện của Logistics. */
  const ONLY = { users: ['admin', 'tech_lead'], records: ['admin', 'tech_lead'], incidents: ['admin', 'tech_lead'], acc: ['admin', 'lead'] };
  const colName = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const readFile = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Không đọc được file trên máy này.')); r.readAsDataURL(f); });
  const TEAM_LBL = { tech: 'Tech', logistics: 'Logistics', sale: 'Sale' };

  ARL.hub.view('import', {
    mount(el, ctx) {
      const canT = (id) => !ONLY[id] || ONLY[id].includes(ctx.role);
      const canAll = Object.keys(ONLY).every(canT);
      const S = { step: 1, name: '', parsed: null, plan: [], dry: null, result: null, busy: '' };
      el.append(H.head('Nhập dữ liệu', `Đưa dữ liệu đang có trong Excel vào hệ thống: ${SHEETS.filter((x) => canT(x.id)).map((x) => x.n).join(', ')}.`));
      const steps = h('ol.imp-steps', { 'aria-label': 'Các bước' });
      const main = h('div.imp-main');
      const histBox = h('div');
      el.append(steps, main, histBox);

      function paintSteps() {
        const L = ['Chọn file', 'Chọn sheet và cột', 'Chạy thử', 'Nhập thật'];
        steps.replaceChildren(...L.map((t, i) => h('li', { 'aria-current': S.step === i + 1 ? 'step' : null, 'data-done': S.step > i + 1 ? '1' : null }, h('b', String(i + 1)), h('span', t))));
      }
      function go(n) { S.step = n; paintSteps(); paint(); steps.scrollIntoView({ block: 'nearest' }); }
      function reset() { S.parsed = null; S.plan = []; S.dry = null; S.result = null; S.name = ''; go(1); }
      function paint() {
        if (S.step === 1) return paintPick();
        if (S.step === 2) return paintMap();
        if (S.step === 3) return paintDry();
        return paintDone();
      }

      // ── Bước 1: chọn file ──
      function paintPick() {
        const input = h('input.imp-file', { type: 'file', accept: '.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv', 'aria-label': 'Chọn file Excel hoặc CSV' });
        const status = h('p.imp-status', { role: 'status' }, S.busy);
        const drop = h('label.imp-drop', { 'data-busy': S.busy ? '1' : null }, input,
          h('span.imp-drop-t', 'Bấm để chọn file, hoặc kéo thả file vào đây'),
          h('small', `Excel .xlsx hoặc .csv · tối đa ${MAX_MB} MB · file của công ty: Atlas_Ops_Hub_Data.xlsx`));
        input.addEventListener('change', () => { if (input.files && input.files[0]) pick(input.files[0], status, drop); });
        drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.dataset.over = '1'; });
        drop.addEventListener('dragleave', () => { delete drop.dataset.over; });
        drop.addEventListener('drop', (e) => { e.preventDefault(); delete drop.dataset.over; const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) pick(f, status, drop); });
        const guide = h('div.imp-guide',
          h('p', 'Mỗi sheet là một loại dữ liệu. Tên sheet và tên cột không cần đúng từng chữ: hệ thống tự đoán, bạn kiểm tra lại ở bước 2. Dòng tiêu đề có thể nằm trong 10 dòng đầu của sheet.'),
          h('div.h-tbl-wrap', h('div.h-tbl-scroll', h('table.h-tbl.h-cards.imp-guide-tbl',
            h('thead', h('tr', h('th', 'Loại dữ liệu'), h('th', 'Tên sheet thường gặp'), h('th', 'Cột bắt buộc'), h('th', 'Cột nên có'))),
            h('tbody', SHEETS.filter((x) => canT(x.id)).map((x) => h('tr', h('td', { 'data-label': 'Loại dữ liệu' }, x.t), h('td', { 'data-label': 'Tên sheet' }, x.s), h('td', { 'data-label': 'Bắt buộc' }, h('b', x.req)), h('td', { 'data-label': 'Nên có' }, x.opt || '–'))))))),
          h('ul.imp-rules',
            h('li', 'Chạy thử trước: hệ thống đi đúng đường nhập thật rồi hoàn tác, nên kết quả chạy thử là kết quả thật.'),
            h('li', 'Bản ghi đã có chỉ được điền vào ô đang trống. Chỗ khác nhau không ghi đè mà đưa vào Đối chiếu cho team liên quan.'),
            h('li', 'BO được ghép theo mã, rồi số điện thoại, rồi tên. Khớp nhiều BO thì không đoán, đưa vào Đối chiếu.'),
            h('li', 'BO đã có: ngày launch, ngày kết thúc không điền qua file (đổi ở yêu cầu launch, nút "Kết thúc ghi hình"), đưa vào Đối chiếu cho Sale.'),
            ctx.role === 'lead' ? h('li', 'Quota giờ quay, Sale phụ trách, ngành, khu vực là số của Sale: file của Logistics có các cột này thì không điền mà đưa vào Đối chiếu cho Sale.') : null,
            h('li', 'Lịch sử dung lượng và sự cố được đánh dấu là dữ liệu nhập: vào số giờ quay và thống kê lỗi, không tính điểm của ai.'),
            h('li', 'Nhập lại cùng một file không tạo trùng bản ghi.'),
            canT('users') ? h('li', 'Tài khoản mới nhận mật khẩu tạm, hiện một lần sau khi nhập; người dùng phải đổi ở lần đăng nhập đầu.') : null,
            canAll ? null : h('li', 'Tài khoản, dung lượng thẻ, sự cố chỉ Quản trị hoặc Tech Lead nhập; tồn phụ kiện chỉ Quản trị hoặc Logistic Lead nhập. Sheet loại khác team sẽ được bỏ qua.')));
        main.replaceChildren(H.card('Chọn file', h('div.h-stack', drop, status)), H.card('File cần có gì', guide));
      }
      async function pick(f, status, drop) {
        if (S.busy) return;
        if (!/\.(xlsx|csv)$/i.test(f.name)) { status.textContent = /\.xls$/i.test(f.name) ? 'File .xls (Excel 97-2003) chưa hỗ trợ. Mở bằng Excel rồi lưu thành .xlsx.' : 'Chỉ nhận file .xlsx hoặc .csv.'; status.dataset.bad = '1'; return; }
        if (f.size > MAX_MB * 1024 * 1024) { status.textContent = `File ${H.num(f.size / 1048576, 1)} MB, quá giới hạn ${MAX_MB} MB. Tách bớt sheet rồi nhập từng phần.`; status.dataset.bad = '1'; return; }
        S.busy = `Đang đọc "${f.name}"…`; status.textContent = S.busy; delete status.dataset.bad; drop.dataset.busy = '1';
        try {
          const data = await readFile(f);
          const j = await ctx.api('POST', '/api/hub/import/parse', { name: f.name, data });
          if (!ctx.alive()) return;
          S.parsed = j; S.name = j.name || f.name;
          S.plan = j.sheets.map((s) => {
            const t = s.guess.target && !canT(s.guess.target) ? '' : s.guess.target || '';
            return { target: t, mapping: t ? { ...s.guess.mapping } : {}, header_row: s.header_row };
          });
          S.busy = '';
          go(2);
        } catch (e) {
          S.busy = '';
          if (!ctx.alive()) return;
          status.textContent = e.message; status.dataset.bad = '1'; delete drop.dataset.busy;
        }
      }

      // ── Bước 2: chọn loại dữ liệu và cột cho từng sheet ──
      const targetOf = (id) => S.parsed.targets.find((t) => t.id === id);
      function autoMap(sheet, tid) {
        if (tid === sheet.guess.target) return { ...sheet.guess.mapping };
        const t = targetOf(tid), out = {}, used = new Set();
        const heads = sheet.headers.map((x) => H.fold(x).toLowerCase().trim());
        for (const f of t.fields) {
          const want = H.fold(f.label).toLowerCase();
          const i = heads.findIndex((x, j) => !used.has(j) && x && (x === want || x.includes(want) || want.includes(x)));
          if (i >= 0) { out[f.key] = i; used.add(i); }
        }
        return out;
      }
      function missing(i) {
        const p = S.plan[i];
        if (!p.target) return [];
        const t = targetOf(p.target);
        const miss = t.fields.filter((f) => f.required && p.mapping[f.key] === undefined && !(p.target === 'records' && f.key === 'site')).map((f) => f.label);
        if (p.target === 'records' && p.mapping.gb === undefined && p.mapping.hours === undefined) miss.push('Dung lượng (GB) hoặc Giờ quay');
        return miss;
      }
      function sheetCard(s, i) {
        const p = S.plan[i];
        const box = h('div.imp-sheet');
        const draw = () => {
          const t = p.target ? targetOf(p.target) : null;
          const opts = [['', 'Bỏ qua sheet này'], ...S.parsed.targets.filter((x) => canT(x.id)).map((x) => [x.id, x.label])];
          const sel = h('select', { 'aria-label': `Loại dữ liệu của sheet ${s.name}`, onchange: () => { p.target = sel.value; p.mapping = p.target ? autoMap(s, p.target) : {}; draw(); paintFoot(); } }, opts.map(([v, l]) => h('option', { value: v, selected: v === p.target }, l)));
          const hr = h('input', { type: 'number', min: 1, max: 51, value: p.header_row + 1, 'aria-label': 'Dòng tiêu đề', onchange: () => { const n = Math.max(1, Math.min(51, Math.round(+hr.value || 1))); hr.value = n; p.header_row = n - 1; } });
          const guessTxt = s.guess.target ? `Hệ thống đoán: ${(targetOf(s.guess.target) || {}).label || s.guess.target}` : 'Hệ thống chưa đoán được loại dữ liệu';
          const blocked = !!s.guess.target && !canT(s.guess.target);
          const miss = missing(i);
          const colOpts = [['', '— Không có cột này —'], ...s.headers.map((x, ci) => [String(ci), `${colName(ci)} · ${x}`])];
          const mapGrid = t ? h('div.imp-map', t.fields.map((f) => {
            const fs = h('select', { 'aria-label': f.label, 'data-key': f.key, onchange: () => { if (fs.value === '') delete p.mapping[f.key]; else p.mapping[f.key] = +fs.value; draw(); paintFoot(); } },
              colOpts.map(([v, l]) => h('option', { value: v, selected: v === (p.mapping[f.key] === undefined ? '' : String(p.mapping[f.key])) }, l)));
            const need = f.required && !(p.target === 'records' && f.key === 'site');
            return h('label.h-field', { 'data-miss': need && p.mapping[f.key] === undefined ? '1' : null }, h('span', f.label, need ? h('i', ' *') : null), fs);
          })) : null;
          const mappedAt = new Map(Object.entries(p.mapping).map(([k, ci]) => [ci, (t && t.fields.find((f) => f.key === k) || {}).label || k]));
          const sample = s.sample.length ? h('div.imp-sample', h('table.imp-tbl',
            h('thead', h('tr', h('th.imp-rn', '#'), s.headers.map((x, ci) => h('th', { 'data-on': mappedAt.has(ci) ? '1' : null }, h('span', `${colName(ci)} · ${x}`), mappedAt.has(ci) ? h('small', `→ ${mappedAt.get(ci)}`) : null)))),
            h('tbody', s.sample.slice(0, 5).map((r, ri) => h('tr', h('td.imp-rn', String(s.header_row + ri + 2)), s.headers.map((_, ci) => h('td', { 'data-on': mappedAt.has(ci) ? '1' : null }, r[ci] || '')))))))
            : h('p.sub', 'Sheet không có dòng dữ liệu nào dưới dòng tiêu đề.');
          box.replaceChildren(H.card(s.name, h('div.h-stack',
            h('div.imp-sel', h('label.h-field', h('span', 'Loại dữ liệu'), sel), h('label.h-field.imp-hr', h('span', 'Dòng tiêu đề'), hr), h('p.sub', guessTxt, blocked ? ' · loại dữ liệu này do team khác nhập, sheet này sẽ bỏ qua' : '')),
            p.target ? (miss.length ? H.note(`Chưa chọn cột: ${miss.join(', ')}.`, 'lost') : null) : H.note('Sheet này sẽ không được nhập.', null),
            mapGrid, sample), { sub: `${H.num(s.rows)} dòng${s.hidden ? ' · sheet ẩn' : ''}`, tone: p.target && miss.length ? 'lost' : null }));
        };
        draw();
        return box;
      }
      const footBox = h('div.imp-foot');
      function paintFoot() {
        const chosen = S.plan.filter((p) => p.target).length;
        const bad = S.plan.some((_, i) => missing(i).length);
        footBox.replaceChildren(
          H.btn('‹ Chọn file khác', () => reset(), 'ghost'),
          h('span.sub', chosen ? `${chosen}/${S.plan.length} sheet sẽ nhập${bad ? ' · còn sheet thiếu cột bắt buộc' : ''}` : 'Chưa chọn sheet nào để nhập'),
          H.btn('Chạy thử', () => runDry(), 'primary', { disabled: !chosen || bad }));
      }
      function paintMap() {
        main.replaceChildren(
          H.note(`File "${S.name}": ${S.parsed.sheets.length} sheet. Kiểm tra loại dữ liệu và cột cho từng sheet (hệ thống đã đoán sẵn), rồi bấm Chạy thử. Chạy thử không đổi dữ liệu.`),
          h('div.imp-sheets', S.parsed.sheets.map(sheetCard)), footBox);
        paintFoot();
      }
      const planBody = () => S.plan.map((p, i) => (p.target ? { sheet: S.parsed.sheets[i].index, target: p.target, header_row: p.header_row, mapping: p.mapping } : null)).filter(Boolean);
      async function call(commit) {
        try { return await ctx.api('POST', '/api/hub/import/run', { token: S.parsed.token, plan: planBody(), commit }); } catch (e) {
          if (e.status === 410) { ARL.toast(e.message, true); reset(); return null; }
          throw e;
        }
      }
      async function runDry() {
        const r = await call(false);
        if (!r || !ctx.alive()) return;
        S.dry = r; go(3);
      }

      // ── Bước 3, 4: kết quả ──
      const tot = (rep, k) => rep.reduce((a, r) => a + (r[k] || 0), 0);
      function reportView(R, dry) {
        const rep = R.report;
        const kpis = H.kpis(
          H.kpi({ label: dry ? 'Sẽ thêm mới' : 'Đã thêm mới', value: tot(rep, 'created'), tone: 'go' }),
          H.kpi({ label: dry ? 'Sẽ bổ sung ô trống' : 'Đã bổ sung ô trống', value: tot(rep, 'updated'), tone: 'blue' }),
          H.kpi({ label: 'Giữ nguyên (đã có, khớp)', value: tot(rep, 'unchanged') }),
          H.kpi({ label: 'Dòng bỏ qua vì lỗi', value: tot(rep, 'skipped'), tone: tot(rep, 'skipped') ? 'wait' : null }),
          H.kpi({ label: dry ? 'Sẽ vào Đối chiếu' : 'Đã vào Đối chiếu', value: R.recon || 0, tone: R.recon ? 'wait' : null, hint: 'Chỗ lệch, không tự sửa' }));
        const tbl = H.table({
          columns: [
            { key: 'sheet', label: 'Sheet', render: (r) => h('span', h('b', r.sheet), h('small', r.label)) },
            { key: 'rows', label: 'Số dòng', align: 'r' }, { key: 'created', label: 'Thêm mới', align: 'r' }, { key: 'updated', label: 'Bổ sung', align: 'r' },
            { key: 'unchanged', label: 'Giữ nguyên', align: 'r' }, { key: 'skipped', label: 'Bỏ qua', align: 'r' }, { key: 'conflicts', label: 'Đối chiếu', align: 'r' },
          ],
          rows: rep, id: (r) => r.sheet + r.target, sortable: false, rowTone: (r) => (r.error_count ? 'wait' : null),
        });
        const details = rep.filter((r) => r.error_count || (r.notes && r.notes.length)).map((r) => H.card(`${r.sheet} · ${r.label}`, h('div.h-stack',
          r.notes && r.notes.length ? h('ul.imp-notes', r.notes.map((n) => h('li', n))) : null,
          r.error_count ? h('div', h('p.sub', `${r.error_count} dòng bị bỏ qua${r.error_count > r.errors.length ? ` (hiện ${r.errors.length} dòng đầu)` : ''}:`), h('ul.imp-errs', r.errors.map((e) => h('li', h('b', `Dòng ${e.row}: `), e.msg)))) : null), { tone: r.error_count ? 'wait' : null }));
        const recon = R.recon_sample && R.recon_sample.length ? H.card(`Chỗ lệch ${dry ? 'sẽ' : 'đã'} đưa vào Đối chiếu (${R.recon})`, h('div.h-stack',
          h('p.sub', 'Hệ thống không tự sửa các chỗ này. Team liên quan xem và quyết định ở mục Đối chiếu.'),
          h('ul.imp-recon', R.recon_sample.map((x) => h('li', H.pill(TEAM_LBL[x.team] || x.team || '–', x.level === 'high' ? 'lost' : x.level === 'mid' ? 'wait' : 'off'), ' ', x.text))),
          R.recon > R.recon_sample.length ? h('p.sub', `… và ${R.recon - R.recon_sample.length} chỗ khác.`) : null)) : null;
        return [kpis, h('div.imp-gap'), tbl, ...details, recon];
      }
      function paintDry() {
        const R = S.dry;
        const foot = h('div.imp-foot',
          H.btn('‹ Sửa lại cột', () => go(2), 'ghost'),
          h('span.sub', 'Chưa có gì thay đổi trên hệ thống.'),
          H.btn('Nhập thật', async () => {
            const c = tot(R.report, 'created'), u = tot(R.report, 'updated');
            if (!(await H.confirm(`Nhập dữ liệu thật từ "${S.name}"? Thêm mới ${c}, bổ sung ${u}${R.recon ? `, ${R.recon} chỗ lệch vào Đối chiếu` : ''}. Dữ liệu đã nhập không tự hoàn tác được.`, 'Nhập thật'))) return;
            const r = await call(true);
            if (!r || !ctx.alive()) return;
            S.result = r; go(4); loadHist();
          }, 'primary'));
        main.replaceChildren(H.note([h('b', 'Kết quả chạy thử. '), 'Đây đúng là kết quả sẽ có khi nhập thật (chạy thử đi đúng đường nhập thật rồi hoàn tác).'], 'go'), ...reportView(R, true).filter(Boolean), foot);
      }
      function paintDone() {
        const R = S.result;
        const users = R.users_created || [];
        const usersCard = users.length ? H.card(`Tài khoản mới (${users.length})`, h('div.h-stack',
          H.note([h('b', 'Mật khẩu tạm chỉ hiện một lần ở đây. '), 'Gửi riêng cho từng người qua tin nhắn cá nhân; mỗi người phải đổi mật khẩu ở lần đăng nhập đầu.'], 'wait'),
          H.table({ columns: [{ key: 'name', label: 'Họ tên' }, { key: 'username', label: 'Tên đăng nhập', render: (u) => h('span.h-mono', u.username) }, { key: 'role_label', label: 'Vai trò' }, { key: 'tempPassword', label: 'Mật khẩu tạm', render: (u) => h('span.h-mono.imp-pw', u.tempPassword) }], rows: users, id: (u) => u.username, sortable: false }),
          h('div.h-row', H.btn('Sao chép tất cả', () => ARL.copyText(users.map((u) => `${u.name}\nĐịa chỉ: ${location.origin}${location.pathname}\nTên đăng nhập: ${u.username}\nMật khẩu tạm: ${u.tempPassword}`).join('\n\n'), 'Đã sao chép thông tin đăng nhập'))))) : null;
        main.replaceChildren(...[H.note([h('b', `Đã nhập xong "${S.name}". `), R.recon ? `${R.recon} chỗ lệch đã vào Đối chiếu, chờ team liên quan xử lý.` : 'Không có chỗ lệch nào.'], 'go'),
          usersCard, ...reportView(R, false)].filter(Boolean),
          h('div.imp-foot', R.recon ? H.btn('Mở Đối chiếu', () => ctx.go('recon'), '') : h('span'), h('span'), H.btn('Nhập file khác', () => reset(), 'primary')));
      }

      // ── Lịch sử ──
      let histTbl = null;
      async function loadHist() {
        try {
          const j = await ctx.api('GET', '/api/hub/import/history');
          if (!ctx.alive()) return;
          if (!histTbl) {
            histTbl = H.table({
              columns: [
                { key: 'at', label: 'Lúc', desc: true, render: (x) => H.when(x.at), nowrap: true },
                { key: 'name', label: 'File', render: (x) => h('b', x.name) },
                { key: 'by', label: 'Người nhập' },
                { key: 'summary', label: 'Kết quả', sort: false, render: (x) => h('span.imp-hsum', (x.summary || []).map((s) => h('small', `${s.sheet} → ${s.label}: thêm ${s.created}, bổ sung ${s.updated}, đối chiếu ${s.conflicts}${s.errors ? `, ${s.errors} dòng lỗi` : ''}`))) },
              ],
              rows: j.items, sort: { key: 'at', dir: -1 }, pageSize: 20, empty: 'Chưa có lần nhập nào.',
            });
            histBox.replaceChildren(H.sec('Lịch sử nhập', '50 lần gần nhất'), histTbl);
          } else histTbl.update(j.items);
        } catch (e) { if (!histTbl) histBox.replaceChildren(H.sec('Lịch sử nhập'), H.error(e, loadHist)); }
      }

      paintSteps(); paint(); loadHist();
    },
  });
})();
