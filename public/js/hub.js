/* Atlas Ops Hub — khung ứng dụng: thanh chọn theo vai trò, điều hướng theo địa chỉ (#/màn-hình/…),
   chuyển qua lại Ops Hub ↔ Rider Live, chuông thông báo, chỉ báo ca làm, cập nhật trực tiếp qua WebSocket.
   Mỗi màn hình tự đăng ký bằng ARL.hub.view(id, { title, group, roles, icon, order, mount(el, ctx) }).
   Trình duyệt chỉ ẩn nút; máy chủ vẫn tự kiểm quyền ở từng API. */
(() => {
  'use strict';
  const { $, $$, api, toast, nameParts } = ARL;
  const H = ARL.H;
  const { h } = H;

  // ───────────── Sổ đăng ký màn hình ─────────────
  const VIEWS = new Map();
  ARL.hub = ARL.hub || {};
  // Danh mục màn hình: một chỗ duy nhất quyết định ai thấy nút nào (khớp với quyền máy chủ kiểm ở từng API).
  // tab: thứ tự trên thanh dưới của điện thoại (số nhỏ đứng trước). short: nhãn ngắn cho thanh dưới.
  const STAFF = ['admin', 'tech_lead', 'tech', 'lead', 'logistic', 'sale_head', 'sale'];
  const OPS_STAFF = ['admin', 'tech_lead', 'tech', 'lead', 'logistic'];
  const LEADS = ['admin', 'tech_lead', 'lead'];
  const NAV = {
    overview: { title: 'Tổng quan vận hành', short: 'Tổng quan', group: 'main', order: 1, icon: 'overview', tab: 1, roles: ['admin', 'tech_lead', 'lead', 'sale_head'], wide: true },
    sale: { title: 'Dashboard Kinh doanh', short: 'Kinh doanh', group: 'main', order: 2, icon: 'sale', tab: 1, roles: ['admin', 'sale_head', 'sale'], wide: true },
    home: { title: 'Việc của tôi', short: 'Của tôi', group: 'main', order: 3, icon: 'home', tab: 2, roles: OPS_STAFF },
    jobs: { title: 'Bảng việc', short: 'Việc', group: 'work', order: 10, icon: 'jobs', tab: 3, roles: OPS_STAFF, wide: true },
    dispatch: { title: 'Điều phối chuyến', short: 'Điều phối', group: 'work', order: 12, icon: 'dispatch', roles: ['admin', 'lead', 'logistic'] },
    incidents: { title: 'Sự cố thiết bị', short: 'Sự cố', group: 'work', order: 14, icon: 'incidents', tab: 5, roles: STAFF },
    recon: { title: 'Đối chiếu', group: 'work', order: 16, icon: 'recon', roles: [...OPS_STAFF, 'sale_head'] },
    kits: { title: 'Kit & thiết bị', short: 'Kit', group: 'stock', order: 20, icon: 'kits', tab: 4, roles: OPS_STAFF, wide: true },
    acc: { title: 'Phụ kiện', group: 'stock', order: 22, icon: 'acc', roles: OPS_STAFF },
    cards: { title: 'Thẻ nhớ & bàn giao', short: 'Thẻ nhớ', group: 'stock', order: 24, icon: 'cards', roles: OPS_STAFF, wide: true },
    upload: { title: 'Nhập dung lượng', short: 'Nhập giờ', group: 'stock', order: 26, icon: 'upload', tab: 3, roles: ['admin', 'tech_lead', 'tech'] },
    outlets: { title: 'BO', group: 'bo', order: 30, icon: 'outlets', tab: 2, roles: STAFF, wide: true },
    requests: { title: 'Yêu cầu của Sale', short: 'Yêu cầu', group: 'bo', order: 32, icon: 'requests', tab: 3, roles: STAFF },
    perf: { title: 'Đánh giá nhân sự', short: 'Đánh giá', group: 'report', order: 40, icon: 'perf', roles: LEADS, wide: true },
    me: { title: 'Hiệu suất của tôi', group: 'report', order: 42, icon: 'me', roles: ['tech_lead', 'tech', 'lead', 'logistic'] },
    roster: { title: 'Phân ca', group: 'team', order: 50, icon: 'roster', roles: OPS_STAFF, wide: true },
    attendance: { title: 'Chấm công', group: 'team', order: 52, icon: 'attendance', roles: LEADS, wide: true },
    accounts: { title: 'Tài khoản', group: 'team', order: 54, icon: 'accounts', roles: ['admin', 'tech_lead', 'lead', 'sale_head'] },
    inbox: { title: 'Thông báo', group: 'sys', order: 60, icon: 'inbox', roles: STAFF },
    log: { title: 'Nhật ký thao tác', short: 'Nhật ký', group: 'sys', order: 62, icon: 'log', roles: [...LEADS, 'sale_head'] },
    settings: { title: 'Cấu hình', group: 'sys', order: 64, icon: 'settings', roles: [...LEADS, 'sale_head'] },
    import: { title: 'Nhập dữ liệu', group: 'sys', order: 66, icon: 'import', roles: LEADS },
  };
  ARL.hub.NAV = NAV;
  /** Màn hình tự đăng ký phần dựng: ARL.hub.view('jobs', { mount(el, ctx) { … } }). Vai trò, nhóm, biểu tượng lấy từ NAV. */
  ARL.hub.view = (id, def) => { VIEWS.set(id, { id, order: 50, group: 'work', icon: 'dot', roles: [], ...(NAV[id] || {}), ...def }); };
  ARL.hub.views = VIEWS;

  const GROUPS = [['main', ''], ['work', 'Công việc'], ['stock', 'Kho & thiết bị'], ['bo', 'BO & Kinh doanh'], ['report', 'Báo cáo'], ['team', 'Đội nhóm'], ['sys', 'Hệ thống']];
  /** Màn hình mở đầu theo vai trò. */
  const HOME = { admin: 'overview', tech_lead: 'overview', lead: 'overview', sale_head: 'sale', sale: 'sale', tech: 'home', logistic: 'home' };
  /** Ai được mở Rider Live (bản đồ FO): chỉ Logistics và Quản trị. Sale và Tech không thấy vị trí FO. */
  const LIVE_ROLES = ['admin', 'lead', 'logistic'];
  /** Đường dẫn trong thông báo ("job:12") → màn hình. */
  const LINK_VIEW = { job: 'jobs', card: 'cards', handover: 'cards', outlet: 'outlets', incident: 'incidents', recon: 'recon', request: 'requests', kit: 'kits', acc: 'acc', record: 'upload', roster: 'roster', perf: 'perf', user: 'accounts', stock: 'kits' };

  const svg = (d) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '20'); s.setAttribute('height', '20'); s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = d; // hằng số trong mã, không có dữ liệu người dùng
    return s;
  };
  const ICONS = {
    dot: '<circle cx="12" cy="12" r="3"/>',
    home: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>',
    overview: '<rect x="3.5" y="3.5" width="7" height="8" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.5"/><rect x="13.5" y="11.5" width="7" height="9" rx="1.5"/><rect x="3.5" y="14.5" width="7" height="6" rx="1.5"/>',
    jobs: '<rect x="4" y="4" width="16" height="17" rx="2"/><path d="M9 4V2.5h6V4M8 10l2 2 4-4M8 16h8"/>',
    dispatch: '<path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
    recon: '<path d="M12 3v18M5 7h14M5 7l-3 7a3.5 3.5 0 0 0 6 0zM19 7l-3 7a3.5 3.5 0 0 0 6 0zM8 21h8"/>',
    inbox: '<path d="M6 17V11a6 6 0 1 1 12 0v6l1.5 2h-15zM10 21h4"/>',
    log: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    kits: '<path d="M3.5 8L12 4l8.5 4v8L12 20l-8.5-4zM3.5 8L12 12l8.5-4M12 12v8"/>',
    acc: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
    cards: '<path d="M7 3h7l4 4v14H7zM10 3v4M13 3v4"/>',
    upload: '<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 9.5M12 12v8M9 15l3-3 3 3"/>',
    outlets: '<path d="M4 9l1.5-5h13L20 9M4 9h16v2a2.7 2.7 0 0 1-5.3 0 2.7 2.7 0 0 1-5.4 0A2.7 2.7 0 0 1 4 11zM5.5 13v7h13v-7M10 20v-4h4v4"/>',
    requests: '<path d="M4 13l3-8h10l3 8v6H4zM4 13h5l1 2h4l1-2h5"/>',
    incidents: '<path d="M12 4l9 16H3zM12 10v4M12 17h.01"/>',
    perf: '<circle cx="12" cy="9" r="5"/><path d="M9 13.5L7.5 21l4.5-2.5 4.5 2.5-1.5-7.5"/>',
    me: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"/>',
    roster: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14h3M8 17h6"/>',
    attendance: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M9 2.5h6"/>',
    accounts: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.5c1.8.8 3 2.6 3 5.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    import: '<path d="M14 3H7v18h10V6zM14 3v3h3M12 10v7M9 14l3 3 3-3"/>',
    sale: '<path d="M4 19h16M5 16l4-5 3 3 6-7M14 7h4v4"/>',
    live: '<circle cx="12" cy="10" r="3"/><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    bell: '<path d="M6 17V11a6 6 0 1 1 12 0v6l1.5 2h-15zM10 21h4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  };
  ARL.hub.icon = (name) => svg(ICONS[name] || ICONS.dot);

  /** Đọc địa chỉ "#/jobs/12?type=repair" → { id: 'jobs', params: ['12'], query: { type: 'repair' } }. */
  function parseHash() {
    const raw = (location.hash || '').replace(/^#\/?/, '');
    const [path, qs] = raw.split('?');
    const parts = path.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
    return { id: parts[0] || '', params: parts.slice(1), query: Object.fromEntries(new URLSearchParams(qs || '')) };
  }
  function makeHash(id, params = [], query = {}) {
    const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v !== null && v !== undefined && v !== false));
    const s = q.toString();
    return `#/${[id, ...params].map((p) => encodeURIComponent(String(p))).join('/')}${s ? '?' + s : ''}`;
  }

  // ───────────── Đường dẫn trong thông báo và mục "Theo dõi" ─────────────
  /** Màn hình danh sách lọc theo trạng thái bằng ?st= (đúng khoá màn hình đọc). */
  const ST_VIEWS = ['cards', 'kits', 'outlets'];
  /**
   * "job:12" → việc 12; "handover:3" → phiếu bàn giao; "roster", "attendance" → màn hình đó;
   * "jobs:stale" → Bảng việc; "cards:at_bo" → danh sách thẻ lọc trạng thái. Không nhận ra thì null.
   */
  function linkTarget(link) {
    const m = /^([a-z_]+)(?::(\w+))?$/.exec(link || '');
    if (!m) return null;
    const [, key, arg] = m;
    if (LINK_VIEW[key] && arg) return { view: LINK_VIEW[key], params: [arg], query: key === 'handover' ? { tab: 'handovers' } : {} };
    const view = LINK_VIEW[key] || (VIEWS.has(key) || NAV[key] ? key : null);
    if (!view) return null;
    return { view, params: [], query: arg && ST_VIEWS.includes(view) ? { st: arg } : {} };
  }
  /** Địa chỉ mở được cho vai trò này; null nếu không rõ đường dẫn hoặc vai trò không mở được màn hình đó. */
  function resolveLink(link, role) {
    const t = linkTarget(link);
    const def = t && VIEWS.get(t.view);
    return def && def.roles.includes(role) ? makeHash(t.view, t.params, t.query) : null;
  }
  ARL.hub.resolveLink = resolveLink;
  /** Màn hình mà đường dẫn trỏ tới (không xét vai trò); null nếu không nhận ra. */
  ARL.hub.linkView = (link) => { const t = linkTarget(link); return t ? t.view : null; };

  ARL.mountHub = function (root, me) {
    const role = me.user.role;
    const ac = new AbortController();
    const on = (target, ev, fn, opt) => target.addEventListener(ev, fn, { signal: ac.signal, ...opt });
    const S = { hubMe: null, cur: null, live: null, liveShown: false, unread: 0, conn: 'connecting', everLive: false, badges: new Map(), alive: true };
    const canLive = LIVE_ROLES.includes(role);
    const mine = () => [...VIEWS.values()].filter((v) => v.roles.includes(role) && (!v.visible || v.visible(me)));
    const gIdx = (g) => { const i = GROUPS.findIndex(([k]) => k === g); return i < 0 ? 99 : i; };
    const ordered = () => mine().sort((a, b) => gIdx(a.group) - gIdx(b.group) || a.order - b.order || a.title.localeCompare(b.title, 'vi'));
    const homeId = () => { const want = HOME[role]; const list = mine(); return (list.find((v) => v.id === want) || ordered()[0] || { id: '' }).id; };

    // ───────────── Khung ─────────────
    const np = nameParts(me.user.name);
    const roleLabel = (ARL.hubMeta && ARL.hubMeta.roles && ARL.hubMeta.roles[role]) || me.user.role_label || role;
    const navEl = h('nav.h-nav', { 'aria-label': 'Chức năng' });
    const svcEl = canLive ? h('div.h-svc', { role: 'group', 'aria-label': 'Chọn dịch vụ' },
      h('button', { type: 'button', 'aria-pressed': 'true', 'data-svc': 'hub', onclick: () => goHub() }, 'Ops Hub'),
      h('button', { type: 'button', 'aria-pressed': 'false', 'data-svc': 'live', onclick: () => go('live') }, 'Rider Live')) : null;
    const side = h('aside.h-side', { 'aria-label': 'Điều hướng' },
      h('div.h-brand', h('span.logo', { 'aria-hidden': 'true' }), h('div', 'Atlas Ops Hub', h('small', roleLabel))),
      svcEl, navEl,
      h('div.h-side-foot', h('span', me.user.name)));
    const titleEl = h('div.h-title', ARL.t('app.ops_hub', 'Ops Hub'));
    const shiftEl = h('span.h-shift', { hidden: true, title: ARL.t('shift.today', 'Ca làm hôm nay theo bảng phân ca') }, h('i'), h('span', ''));
    const connEl = h('span.h-conn', { 'data-state': 'connecting', title: ARL.t('app.connecting', 'Đang kết nối') });
    const bellBadge = h('b.h-badge', { hidden: true });
    const bell = h('button.ghost.h-bell', { type: 'button', 'aria-label': ARL.t('app.notifications', 'Thông báo'), title: ARL.t('app.notifications', 'Thông báo') }, svg(ICONS.bell), bellBadge);
    const meBtn = h('button.ghost.h-me', { type: 'button', 'aria-label': ARL.t('app.my_account', 'Tài khoản của tôi') }, h('span.h-av', np.initials), h('span', String(me.user.name || '').trim().split(/\s+/).length <= 2 ? me.user.name : np.short));
    const menuBtn = h('button.ghost.h-menu-btn', { type: 'button', 'aria-label': ARL.t('nav.more', 'Mở danh mục') }, svg(ICONS.menu));

    // Nút đổi giao diện Sáng / Tối (Google Antigravity Style)
    const themeBtn = h('button.ghost.h-theme-btn', { type: 'button', 'aria-label': ARL.t('app.toggle_theme', 'Đổi giao diện Sáng / Tối'), onclick: () => { ARL.toggleTheme(); paintTheme(); } });
    function paintTheme() {
      const isDark = (ARL.theme || 'light') === 'dark';
      themeBtn.replaceChildren(svg(isDark ? ICONS.sun : ICONS.moon), h('span.h-hide-mobile', isDark ? 'Light' : 'Dark'));
      themeBtn.title = isDark ? ARL.t('app.theme_light', 'Giao diện Sáng') : ARL.t('app.theme_dark', 'Giao diện Tối');
    }
    paintTheme();
    on(window, 'arl:theme', paintTheme);

    // Nút đổi ngôn ngữ Song ngữ (VI / EN)
    const langBtn = h('button.ghost.h-lang-btn', { type: 'button', 'aria-label': ARL.t('app.lang', 'Ngôn ngữ'), onclick: () => { ARL.toggleLang(); } });
    function paintLang() {
      const isVi = (ARL.lang || 'vi') === 'vi';
      langBtn.replaceChildren(svg(ICONS.globe), h('span', isVi ? 'EN' : 'VI'));
      langBtn.title = isVi ? 'Switch to English' : 'Chuyển sang Tiếng Việt';
      if (titleEl && S.cur) titleEl.textContent = ARL.t('nav.' + S.cur.def.id, S.cur.def.title);
    }
    paintLang();
    on(window, 'arl:lang', () => { paintLang(); paintNav(); paintTheme(); if (S.cur) mountView(S.cur.def, S.cur.params, S.cur.query); });

    const top = h('header.h-top', menuBtn, titleEl, shiftEl, connEl, langBtn, themeBtn, bell, meBtn);
    const staleBtn = h('button', { type: 'button' }, ARL.t('app.new_update', 'Có cập nhật mới · bấm để tải'));
    const stale = h('div.h-stale', { hidden: true }, staleBtn);
    const main = h('main.h-main', { id: 'h-main', tabindex: '-1' }, stale);
    const tabbar = h('nav.h-tabbar', { 'aria-label': 'Chức năng chính' });
    const scrim = h('div.h-scrim', { onclick: () => setNav(false) });
    const app = h('div.h-app', side, top, main, tabbar, scrim);
    const liveLayer = h('div.h-live-layer', { hidden: true });
    root.replaceChildren(app, liveLayer);
    ARL.refreshCurrentView = () => { if (S.cur) mountView(S.cur.def, S.cur.params, S.cur.query); };

    const setNav = (open) => { app.classList.toggle('nav-open', open); menuBtn.setAttribute('aria-expanded', String(open)); };
    on(menuBtn, 'click', () => setNav(!app.classList.contains('nav-open')));
    on(document, 'keydown', (e) => { if (e.key === 'Escape' && app.classList.contains('nav-open')) setNav(false); });

    function paintNav() {
      const list = ordered();
      const cur = S.cur && S.cur.def.id;
      const kids = [];
      let g = null;
      for (const v of list) {
        if (v.group !== g) {
          g = v.group;
          const rawLabel = (GROUPS.find(([k]) => k === g) || [, ''])[1];
          const label = g ? ARL.t('grp.' + g, rawLabel) : '';
          if (label) kids.push(h('h3', label));
        }
        const b = S.badges.get(v.id);
        const titleText = ARL.t('nav.' + v.id, v.title);
        kids.push(h('a', { href: makeHash(v.id), 'data-view': v.id, 'aria-current': v.id === cur && !S.liveShown ? 'page' : null, onclick: () => setNav(false) }, svg(ICONS[v.icon] || ICONS.dot), h('span', titleText), b && b.n ? H.badge(b.n, b.tone) : null));
      }
      navEl.replaceChildren(...kids);
      // Thanh dưới trên điện thoại: tối đa 4 màn hình hay dùng + "Thêm" mở danh mục đầy đủ.
      const tabs = list.filter((v) => v.tab).sort((a, b) => (a.tab === true ? 50 : a.tab) - (b.tab === true ? 50 : b.tab)).slice(0, canLive ? 3 : 4);
      const tk = tabs.map((v) => {
        const b = S.badges.get(v.id);
        const shortText = ARL.t('nav.' + v.id + '.short', v.short || v.title);
        return h('a', { href: makeHash(v.id), 'aria-current': v.id === cur && !S.liveShown ? 'page' : null }, svg(ICONS[v.icon] || ICONS.dot), h('span', shortText), b && b.n ? H.badge(b.n, b.tone) : null);
      });
      if (canLive) tk.push(h('a', { href: '#/live', 'aria-current': S.liveShown ? 'page' : null }, svg(ICONS.live), h('span', ARL.t('nav.live', 'Rider Live'))));
      tk.push(h('a', { href: '#', onclick: (e) => { e.preventDefault(); setNav(true); } }, svg(ICONS.more), h('span', ARL.t('nav.more', 'Thêm'))));
      tabbar.replaceChildren(...tk);
      if (svcEl) for (const b of $$('button', svcEl)) b.setAttribute('aria-pressed', String((b.dataset.svc === 'live') === S.liveShown));
    }

    // ───────────── Ca làm, số việc, thông báo chưa đọc ─────────────
    async function refreshMe() {
      try {
        const m = await api('GET', '/api/hub/me');
        if (!S.alive) return;
        S.hubMe = m;
        setUnread(m.unread);
        if (m.on_shift === null || m.on_shift === undefined) shiftEl.hidden = true;
        else {
          shiftEl.hidden = false;
          shiftEl.dataset.on = m.on_shift ? '1' : '0';
          const sh = m.shift;
          $('span', shiftEl).textContent = m.on_shift ? `Trong ca${sh && sh.start ? ` ${sh.start}–${sh.end}` : ''}` : sh && sh.start ? `Ca hôm nay ${sh.start}–${sh.end}` : 'Không có ca hôm nay';
          shiftEl.title = m.on_shift ? 'Bạn đang trong ca: việc tự sinh có thể được giao cho bạn.' : 'Ngoài ca: hệ thống không tự giao việc cho bạn.';
        }
        if (m.jobs) setBadge('home', m.jobs.overdue || m.jobs.open, m.jobs.overdue ? null : 'blue');
      } catch { /* giữ số cũ */ }
    }
    function setUnread(n) {
      S.unread = Math.max(0, n | 0);
      bellBadge.hidden = !S.unread;
      bellBadge.textContent = S.unread > 99 ? '99+' : String(S.unread);
      bell.setAttribute('aria-label', S.unread ? `Thông báo, ${S.unread} chưa đọc` : 'Thông báo');
      setBadge('inbox', S.unread, 'blue');
    }
    function setBadge(viewId, n, tone) {
      const prev = S.badges.get(viewId);
      if (prev && prev.n === n && prev.tone === tone) return;
      S.badges.set(viewId, { n, tone });
      paintNav();
    }
    const linkTo = (link) => resolveLink(link, role);
    ARL.hub.linkTo = linkTo;
    const LEVEL_TONE = { alert: 'lost', warn: 'wait', info: 'blue' };
    async function openInbox() {
      const pop = H.menu(bell, []);
      pop.classList.add('h-inbox');
      pop.replaceChildren(H.loading(3));
      H.place(pop, bell);
      let j;
      try { j = await api('GET', '/api/hub/inbox', null, { limit: 12 }); } catch (e) { pop.replaceChildren(H.error(e)); H.place(pop, bell); return; }
      if (!pop.isConnected) return;
      setUnread(j.unread);
      const items = j.items.map((it) => h('button.h-inbox-it', {
        type: 'button', 'data-unread': it.read_at ? null : '1', 'data-tone': LEVEL_TONE[it.level] || 'blue',
        onclick: async () => {
          pop.remove();
          if (!it.read_at) api('POST', '/api/hub/inbox/read', { ids: [it.id] }).then((r) => setUnread(r.unread)).catch(() => {});
          const to = linkTo(it.link);
          location.hash = to || '#/inbox';
        },
      }, h('span', it.text), h('small', H.when(it.ts))));
      pop.replaceChildren(
        h('div.h-inbox-head', h('b', 'Thông báo'), S.unread ? H.btn('Đã đọc hết', async () => { const r = await api('POST', '/api/hub/inbox/read', { all: true }); setUnread(r.unread); pop.remove(); }, 'ghost small') : null),
        items.length ? h('div.h-inbox-list', items) : h('p.sub', { style: 'padding: 8px' }, 'Chưa có thông báo nào.'),
        VIEWS.has('inbox') ? h('hr') : null,
        VIEWS.has('inbox') ? h('button', { type: 'button', onclick: () => { pop.remove(); location.hash = '#/inbox'; } }, 'Xem tất cả thông báo') : null);
      H.place(pop, bell);
    }
    on(bell, 'click', (e) => { e.stopPropagation(); if ($('.h-pop.h-inbox')) { $('.h-pop.h-inbox').remove(); return; } openInbox(); });
    on(meBtn, 'click', (e) => {
      e.stopPropagation();
      H.menu(meBtn, [
        { label: `${me.user.name} · ${roleLabel}`, run: () => {} },
        '-',
        { label: 'Đổi mật khẩu', run: () => ARL.changePasswordDialog() },
        VIEWS.has('me') && VIEWS.get('me').roles.includes(role) ? { label: 'Hiệu suất của tôi', run: () => { location.hash = '#/me'; } } : null,
        { label: 'Đăng xuất', danger: true, run: () => ARL.logout() },
      ].filter(Boolean));
    });

    // ───────────── Rider Live ─────────────
    /** Gắn Rider Live một lần rồi giữ nguyên (bản đồ, kết nối, vệt đường) để chuyển qua lại không phải tải lại. */
    function showLive(show) {
      if (show && !canLive) return go(homeId());
      S.liveShown = show;
      if (show && !S.live) {
        const host = h('div', { style: 'height: 100%' });
        liveLayer.replaceChildren(host);
        try { S.live = ARL.mountOps(host, me, { onExit: goHub }); } catch (e) { console.error(e); liveLayer.replaceChildren(H.error(e)); }
      }
      liveLayer.hidden = !show;
      app.hidden = show; // ẩn khung hub cho Rider Live dùng trọn màn hình; dữ liệu và màn hình đang xem vẫn giữ
      document.title = show ? 'Rider Live · Atlas' : `${S.cur ? S.cur.def.title + ' · ' : ''}Atlas Ops Hub`;
      if (show) requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))); // Leaflet đo lại khung bản đồ
      paintNav();
    }
    function goHub() {
      if (S.cur) { history.pushState(null, '', makeHash(S.cur.def.id, S.cur.params, S.cur.query)); showLive(false); flushPending(); }
      else go(homeId());
    }

    // ───────────── Điều hướng ─────────────
    function go(id, params = [], query = {}) {
      const to = makeHash(id, params, query);
      if (location.hash === to) route(); else location.hash = to;
    }
    function route() {
      const r = parseHash();
      if (r.id === 'live') return showLive(true);
      let def = VIEWS.get(r.id);
      if (!def || !def.roles.includes(role) || (def.visible && !def.visible(me))) {
        const hid = homeId();
        if (!hid) { main.replaceChildren(H.empty('Tài khoản này chưa được mở chức năng nào trong Ops Hub.')); return; }
        if (r.id && r.id !== hid) toast(def ? 'Vai trò của bạn không mở được màn hình này.' : 'Không tìm thấy màn hình này.', !!def);
        history.replaceState(null, '', makeHash(hid));
        def = VIEWS.get(hid); r.params = []; r.query = {};
      }
      if (S.liveShown) showLive(false);
      // Cùng màn hình, chỉ đổi phần sau (mở chi tiết, đổi bộ lọc): màn hình tự xử lý nếu có đăng ký onRoute.
      if (S.cur && S.cur.def === def && S.cur.routeFn) {
        S.cur.params = r.params; S.cur.query = r.query;
        S.cur.ctx.params = r.params; S.cur.ctx.query = r.query;
        try { S.cur.routeFn(S.cur.ctx); } catch (e) { console.error(e); }
        return;
      }
      mountView(def, r.params, r.query);
    }

    function teardown() {
      const c = S.cur;
      if (!c) return;
      c.alive = false;
      for (const t of c.timers) clearInterval(t);
      for (const fn of c.cleanups.splice(0)) { try { fn(); } catch (e) { console.error(e); } }
      for (const d of $$('dialog.dlg')) { try { d.close(); } catch { /* chưa mở */ } d.remove(); }
      $$('.h-pop').forEach((p) => p.remove());
      S.cur = null;
      stale.hidden = true;
    }

    function mountView(def, params, query) {
      teardown();
      const host = h(`div.h-view${def.wide ? '.h-wide' : ''}`, { 'data-view': def.id });
      main.replaceChildren(stale, host);
      main.scrollTop = 0;
      const cur = { def, params, query, host, alive: true, timers: [], cleanups: [], subs: [], routeFn: null, pending: new Set(), ctx: null };
      S.cur = cur;
      const ctx = {
        me, user: me.user, role, team: (ARL.hubMeta && ARL.hubMeta.team_of && ARL.hubMeta.team_of[role]) || null,
        get meta() { return ARL.hubMeta; },
        get hubMe() { return S.hubMe; },
        api, params, query, el: host,
        can: (...roles) => roles.flat().includes(role),
        isLead: (team) => role === 'admin' || (team === 'tech' && role === 'tech_lead') || (team === 'logistics' && role === 'lead') || (team === 'sale' && role === 'sale_head'),
        alive: () => cur.alive && S.alive,
        go,
        /** Đổi bộ lọc trên địa chỉ mà không dựng lại màn hình. */
        setQuery(patch, replace = true) {
          const q = { ...cur.query, ...patch };
          for (const k of Object.keys(q)) if (q[k] === '' || q[k] === null || q[k] === undefined) delete q[k];
          cur.query = q; ctx.query = q;
          const to = makeHash(def.id, cur.params, q);
          if (replace) history.replaceState(null, '', to); else history.pushState(null, '', to);
        },
        /** Mở / đóng phần chi tiết trong cùng màn hình (vd. #/jobs/12) — cần đăng ký onRoute. */
        setParams(p, query) { go(def.id, p, query || cur.query); },
        onRoute(fn) { cur.routeFn = fn; },
        /** Nạp lại khi dữ liệu thuộc nhóm ents đổi (từ bất kỳ ai). Đang gõ hoặc đang mở hộp thoại thì hoãn, hiện nút "Có cập nhật mới". */
        live(ents, fn) { cur.subs.push({ ents: new Set([].concat(ents)), fn }); },
        every(ms, fn) { cur.timers.push(setInterval(() => { if (!document.hidden && cur.alive) fn(); }, ms)); },
        onCleanup(fn) { cur.cleanups.push(fn); },
        title(t) { titleEl.textContent = t; if (!S.liveShown) document.title = `${t} · Atlas Ops Hub`; },
        badge: setBadge,
        refreshMe,
        linkTo,
        /** Liên kết tới chi tiết việc: chỉ việc của team mình (Quản trị mọi team); máy chủ chặn chi tiết việc của team khác. */
        jobLink: (j) => (j && (role === 'admin' || ctx.team === j.team) ? linkTo(`job:${j.id}`) : null),
      };
      cur.ctx = ctx;
      ctx.title(def.title);
      paintNav();
      try {
        const r = def.mount(host, ctx);
        if (r && typeof r.then === 'function') r.then((fn) => { if (typeof fn === 'function') { if (cur.alive) cur.cleanups.push(fn); else fn(); } }, (e) => { console.error(e); if (cur.alive) host.replaceChildren(H.error(e, () => mountView(def, cur.params, cur.query))); });
        else if (typeof r === 'function') cur.cleanups.push(r);
      } catch (e) {
        console.error(e);
        host.replaceChildren(H.error(e, () => mountView(def, cur.params, cur.query)));
      }
    }

    // ───────────── Cập nhật trực tiếp ─────────────
    const busy = () => {
      if ($('dialog.dlg[open]')) return true;
      const a = document.activeElement;
      return !!(a && S.cur && S.cur.host.contains(a) && (a.matches('textarea, select, input:not([type=search]):not([type=checkbox]):not([type=radio])') || a.isContentEditable));
    };
    let runT = null;
    function schedule(ents) {
      const c = S.cur;
      if (!c) return;
      for (const s of c.subs) if (ents === '*' || ents.some((e) => s.ents.has(e))) c.pending.add(s);
      if (!c.pending.size || runT) return;
      runT = setTimeout(flushPending, 250); // gộp nhiều thay đổi dồn dập
    }
    function flushPending() {
      clearTimeout(runT); runT = null;
      const c = S.cur;
      if (!c || !c.pending.size || S.liveShown) return;
      if (busy()) { stale.hidden = false; return; }
      stale.hidden = true;
      const list = [...c.pending]; c.pending.clear();
      for (const s of list) { try { const r = s.fn(); if (r && r.catch) r.catch((e) => console.error(e)); } catch (e) { console.error(e); } }
    }
    on(staleBtn, 'click', () => { const a = document.activeElement; if (a && a.blur) a.blur(); flushPending(); });
    on(document, 'focusout', () => { if (S.cur && S.cur.pending.size) setTimeout(() => { if (!busy()) flushPending(); }, 60); });
    const dlgWatch = setInterval(() => { if (S.cur && S.cur.pending.size && !busy()) flushPending(); }, 1500);

    function onMsg(m) {
      if (m.t === 'hello') { if (m.uid && m.uid !== me.user.id) ARL.reboot(); return; } // kênh mở bằng phiên của tài khoản khác (vừa đăng nhập ở tab khác) → mở lại đúng màn hình
      if (m.t === 'hub') { schedule(m.ent || []); if ((m.ent || []).some((e) => e === 'jobs' || e === 'roster' || e === 'people')) refreshMeSoon(); return; }
      if (m.t === 'inbox') {
        setUnread(S.unread + 1);
        if (m.item && (m.item.level === 'alert' || m.item.level === 'warn') && !S.liveShown) toast(m.item.text, m.item.level === 'alert');
        schedule(['inbox']);
        return;
      }
      if (m.t === 'kick') ARL.reboot();
    }
    let meT = null;
    const refreshMeSoon = () => { clearTimeout(meT); meT = setTimeout(refreshMe, 800); };
    const CONN = { connecting: 'Đang kết nối', live: 'Đang cập nhật trực tiếp', down: 'Mất kết nối, đang nối lại' };
    function onState(s) {
      S.conn = s;
      connEl.dataset.state = s; connEl.title = CONN[s] || s;
      if (s === 'live') {
        if (S.everLive) { refreshMe(); schedule('*'); } // nối lại sau khi rớt mạng: nạp lại để không sót thay đổi
        S.everLive = true;
      }
    }
    const link = ARL.backend.connect(onMsg, onState);
    const meTimer = setInterval(() => { if (!document.hidden) refreshMe(); }, 60000);
    on(document, 'visibilitychange', () => { if (!document.hidden) { refreshMe(); schedule('*'); } });

    // ───────────── Khởi động ─────────────
    on(window, 'hashchange', route);
    main.replaceChildren(h('div.h-view', H.loading(6)));
    paintNav();
    (async () => {
      try {
        if (!ARL.hubMeta) ARL.hubMeta = await api('GET', '/api/hub/meta');
      } catch (e) {
        if (!S.alive) return;
        main.replaceChildren(h('div.h-view', H.error(e, () => ARL.reboot())));
        return;
      }
      if (!S.alive) return;
      const rl = ARL.hubMeta.roles && ARL.hubMeta.roles[role];
      if (rl) $('.h-brand small', side).textContent = rl;
      refreshMe();
      route();
    })();

    return function unmount() {
      S.alive = false;
      teardown();
      ac.abort();
      clearInterval(meTimer); clearInterval(dlgWatch); clearTimeout(runT); clearTimeout(meT);
      link.close();
      if (S.live) { try { S.live(); } catch (e) { console.error(e); } S.live = null; }
    };
  };
})();
