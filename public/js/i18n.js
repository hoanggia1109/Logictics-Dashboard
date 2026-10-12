/* Atlas Ops Hub — Hệ thống Song ngữ (i18n: Vietnamese / English) & Chủ đề (Theme: Light / Dark)
   Phong cách chuẩn Google Antigravity: chuyển đổi tức thì, mượt mà, lưu trữ localStorage */
(() => {
  'use strict';
  const ARL = (window.ARL = window.ARL || {});

  // ───────────── Khởi tạo Theme & Ngôn ngữ ─────────────
  let curLang = 'vi';
  try {
    const savedL = localStorage.getItem('arl.lang');
    if (savedL === 'en' || savedL === 'vi') curLang = savedL;
  } catch {}

  let curTheme = 'light';
  try {
    const savedT = localStorage.getItem('arl.theme');
    if (savedT === 'light' || savedT === 'dark') {
      curTheme = savedT;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      curTheme = 'dark';
    }
  } catch {}

  document.documentElement.setAttribute('data-theme', curTheme);
  document.documentElement.setAttribute('lang', curLang);
  ARL.lang = curLang;
  ARL.theme = curTheme;

  // ───────────── Từ điển Song ngữ (i18n Dictionary) ─────────────
  const DICT = {
    vi: {
      // Nhãn điều hướng (Navigation Views)
      'nav.overview': 'Tổng quan vận hành',
      'nav.overview.short': 'Tổng quan',
      'nav.sale': 'Dashboard Kinh doanh',
      'nav.sale.short': 'Kinh doanh',
      'nav.home': 'Việc của tôi',
      'nav.home.short': 'Của tôi',
      'nav.jobs': 'Bảng việc',
      'nav.jobs.short': 'Việc',
      'nav.dispatch': 'Điều phối chuyến',
      'nav.dispatch.short': 'Điều phối',
      'nav.incidents': 'Sự cố thiết bị',
      'nav.incidents.short': 'Sự cố',
      'nav.recon': 'Đối chiếu',
      'nav.recon.short': 'Đối chiếu',
      'nav.kits': 'Kit & thiết bị',
      'nav.kits.short': 'Kit',
      'nav.acc': 'Phụ kiện',
      'nav.acc.short': 'Phụ kiện',
      'nav.cards': 'Thẻ nhớ & bàn giao',
      'nav.cards.short': 'Thẻ nhớ',
      'nav.upload': 'Nhập dung lượng',
      'nav.upload.short': 'Nhập giờ',
      'nav.outlets': 'BO',
      'nav.outlets.short': 'BO',
      'nav.requests': 'Yêu cầu của Sale',
      'nav.requests.short': 'Yêu cầu',
      'nav.perf': 'Đánh giá nhân sự',
      'nav.perf.short': 'Đánh giá',
      'nav.me': 'Hiệu suất của tôi',
      'nav.me.short': 'Hiệu suất',
      'nav.roster': 'Phân ca',
      'nav.roster.short': 'Phân ca',
      'nav.attendance': 'Chấm công',
      'nav.attendance.short': 'Chấm công',
      'nav.accounts': 'Tài khoản',
      'nav.accounts.short': 'Tài khoản',
      'nav.inbox': 'Thông báo',
      'nav.inbox.short': 'Thông báo',
      'nav.log': 'Nhật ký thao tác',
      'nav.log.short': 'Nhật ký',
      'nav.settings': 'Cấu hình',
      'nav.settings.short': 'Cấu hình',
      'nav.import': 'Nhập dữ liệu',
      'nav.import.short': 'Nhập liệu',
      'nav.live': 'Rider Live',
      'nav.more': 'Thêm',

      // Nhóm menu (Groups)
      'grp.main': '',
      'grp.work': 'Công việc',
      'grp.stock': 'Kho & thiết bị',
      'grp.bo': 'BO & Kinh doanh',
      'grp.report': 'Báo cáo',
      'grp.team': 'Đội nhóm',
      'grp.sys': 'Hệ thống',

      // Header & Chung
      'app.title': 'Atlas Ops Hub',
      'app.ops_hub': 'Ops Hub',
      'app.rider_live': 'Rider Live',
      'app.switch_svc': 'Chọn dịch vụ',
      'app.notifications': 'Thông báo',
      'app.no_unread': 'Không có thông báo mới',
      'app.unread_badge': 'chưa đọc',
      'app.my_account': 'Tài khoản của tôi',
      'app.sign_out': 'Đăng xuất',
      'app.change_pw': 'Đổi mật khẩu',
      'app.new_update': 'Có cập nhật mới · bấm để tải',
      'app.connected': 'Đã kết nối',
      'app.connecting': 'Đang kết nối...',
      'app.offline': 'Mất kết nối',
      'app.toggle_theme': 'Đổi giao diện Sáng / Tối',
      'app.theme_light': 'Giao diện Sáng',
      'app.theme_dark': 'Giao diện Tối',
      'app.lang': 'Ngôn ngữ',
      'app.lang_en': 'English',
      'app.lang_vi': 'Tiếng Việt',

      // Ca làm (Shift)
      'shift.on': 'Trong ca',
      'shift.off': 'Ngoài ca',
      'shift.today': 'Ca hôm nay',
      'shift.none': 'Không có ca hôm nay',
      'shift.title_on': 'Bạn đang trong ca: việc tự sinh có thể được giao cho bạn.',
      'shift.title_off': 'Ngoài ca: hệ thống không tự giao việc cho bạn.',

      // Vai trò (Roles)
      'role.admin': 'Quản trị viên',
      'role.tech_lead': 'Trưởng nhóm Kỹ thuật',
      'role.tech': 'Kỹ thuật viên',
      'role.lead': 'Logistic Lead',
      'role.logistic': 'Điều phối viên',
      'role.sale_head': 'Trưởng phòng Kinh doanh',
      'role.sale': 'Nhân viên Kinh doanh',
      'role.fo': 'Field Ops (FO)',

      // Trạng thái chuyến / task (Task Status)
      'task.unassigned': 'Chưa giao',
      'task.assigned': 'Chờ FO nhận',
      'task.accepted': 'FO đã nhận',
      'task.in_progress': 'Đang chạy',
      'task.completed': 'Hoàn thành',
      'task.failed': 'Không hoàn thành',
      'task.cancelled': 'Đã huỷ',

      // Trạng thái điểm dừng (Stop Status)
      'stop.pending': 'Chưa đến',
      'stop.arrived': 'Đã đến',
      'stop.done': 'Đã xong',
      'stop.failed': 'Không giao được',
      'stop.skipped': 'Bỏ qua',

      // Trạng thái xác nhận BO (BO Status)
      'bo.none': '',
      'bo.pending': 'Chờ BO xác nhận',
      'bo.confirmed': 'BO đã xác nhận',
      'bo.mismatch': 'BO báo lệch số',
      'bo.waived': 'Logistic đã cho qua xác nhận của BO',

      // Hành động phổ biến (Actions)
      'act.create': 'Tạo mới',
      'act.add': 'Thêm',
      'act.save': 'Lưu',
      'act.cancel': 'Huỷ',
      'act.delete': 'Xoá',
      'act.edit': 'Chỉnh sửa',
      'act.search': 'Tìm kiếm',
      'act.filter': 'Lọc',
      'act.close': 'Đóng',
      'act.confirm': 'Xác nhận',
      'act.refresh': 'Làm mới',
      'act.back': '‹ Trước',
      'act.next': 'Sau ›',
      'act.all': 'Tất cả',
      'act.export': 'Xuất dữ liệu',
      'act.import': 'Nhập dữ liệu',
      'act.select_all': 'Chọn tất cả',
      'act.retry': 'Thử lại',
      'act.view': 'Xem',

      // Thời gian (Time expressions)
      'time.just_now': 'vừa xong',
      'time.sec_ago': 'giây trước',
      'time.min_ago': 'phút trước',
      'time.hour_ago': 'giờ trước',
      'time.day_ago': 'ngày trước',
      'time.under_min': 'dưới 1 phút',
      'time.hours': 'giờ',
      'time.minutes': 'phút',
      'time.days': 'ngày',
      'time.on_time': 'Đúng hạn',
      'time.overdue': 'Quá hạn',
      'time.late': 'Trễ',
      'time.due': 'Hạn',
      'time.no_due': 'Không hạn',
      'time.left': 'Còn',

      // Bảng biểu & Dữ liệu
      'tbl.rows': 'dòng',
      'tbl.page': 'trang',
      'tbl.empty': 'Chưa có dữ liệu.',
      'tbl.loading': 'Đang tải…',

      // Thời tiết & Giao thông
      'weather.clear': 'Trời tạnh',
      'weather.rain': 'Mưa',
      'weather.heavy': 'Mưa to',
      'weather.storm': 'Giông bão',
      'traffic.normal': 'Bình thường',
      'traffic.peak': 'Giờ cao điểm',
      'traffic.jam': 'Kẹt xe nặng',
    },
    en: {
      // Nav Views
      'nav.overview': 'Operations Overview',
      'nav.overview.short': 'Overview',
      'nav.sale': 'Sales Dashboard',
      'nav.sale.short': 'Sales',
      'nav.home': 'My Tasks',
      'nav.home.short': 'My Work',
      'nav.jobs': 'Jobs Board',
      'nav.jobs.short': 'Jobs',
      'nav.dispatch': 'Trip Dispatch',
      'nav.dispatch.short': 'Dispatch',
      'nav.incidents': 'Device Incidents',
      'nav.incidents.short': 'Incidents',
      'nav.recon': 'Reconciliation',
      'nav.recon.short': 'Recon',
      'nav.kits': 'Kits & Devices',
      'nav.kits.short': 'Kits',
      'nav.acc': 'Accessories',
      'nav.acc.short': 'Accessories',
      'nav.cards': 'Memory Cards',
      'nav.cards.short': 'Cards',
      'nav.upload': 'Hours Upload',
      'nav.upload.short': 'Hours',
      'nav.outlets': 'BO Outlets',
      'nav.outlets.short': 'Outlets',
      'nav.requests': 'Sales Requests',
      'nav.requests.short': 'Requests',
      'nav.perf': 'Staff Performance',
      'nav.perf.short': 'Performance',
      'nav.me': 'My Performance',
      'nav.me.short': 'My KPI',
      'nav.roster': 'Shift Roster',
      'nav.roster.short': 'Roster',
      'nav.attendance': 'Attendance',
      'nav.attendance.short': 'Attendance',
      'nav.accounts': 'User Accounts',
      'nav.accounts.short': 'Accounts',
      'nav.inbox': 'Notifications',
      'nav.inbox.short': 'Inbox',
      'nav.log': 'Audit Logs',
      'nav.log.short': 'Logs',
      'nav.settings': 'System Settings',
      'nav.settings.short': 'Settings',
      'nav.import': 'Data Import',
      'nav.import.short': 'Import',
      'nav.live': 'Rider Live',
      'nav.more': 'More',

      // Groups
      'grp.main': '',
      'grp.work': 'Work Management',
      'grp.stock': 'Stock & Equipment',
      'grp.bo': 'Outlets & Sales',
      'grp.report': 'Reports & Analytics',
      'grp.team': 'Team & Shifts',
      'grp.sys': 'System Administration',

      // Header & Common
      'app.title': 'Atlas Ops Hub',
      'app.ops_hub': 'Ops Hub',
      'app.rider_live': 'Rider Live',
      'app.switch_svc': 'Switch Service',
      'app.notifications': 'Notifications',
      'app.no_unread': 'No unread notifications',
      'app.unread_badge': 'unread',
      'app.my_account': 'My Account',
      'app.sign_out': 'Sign out',
      'app.change_pw': 'Change Password',
      'app.new_update': 'New update available · click to reload',
      'app.connected': 'Live Connected',
      'app.connecting': 'Connecting...',
      'app.offline': 'Offline',
      'app.toggle_theme': 'Switch Light / Dark Theme',
      'app.theme_light': 'Light Mode',
      'app.theme_dark': 'Dark Mode',
      'app.lang': 'Language',
      'app.lang_en': 'English',
      'app.lang_vi': 'Vietnamese',

      // Shift
      'shift.on': 'On Shift',
      'shift.off': 'Off Shift',
      'shift.today': 'Today\'s shift',
      'shift.none': 'No shift scheduled today',
      'shift.title_on': 'You are on shift: auto-generated tasks can be assigned to you.',
      'shift.title_off': 'Off shift: tasks will not be auto-assigned to you.',

      // Roles
      'role.admin': 'Administrator',
      'role.tech_lead': 'Tech Lead',
      'role.tech': 'Technician',
      'role.lead': 'Logistics Lead',
      'role.logistic': 'Logistics Specialist',
      'role.sale_head': 'Head of Sales',
      'role.sale': 'Sales Executive',
      'role.fo': 'Field Operator (FO)',

      // Task Status
      'task.unassigned': 'Unassigned',
      'task.assigned': 'Assigned (Pending)',
      'task.accepted': 'Accepted by FO',
      'task.in_progress': 'In Progress',
      'task.completed': 'Completed',
      'task.failed': 'Failed',
      'task.cancelled': 'Cancelled',

      // Stop Status
      'stop.pending': 'Pending',
      'stop.arrived': 'Arrived',
      'stop.done': 'Completed',
      'stop.failed': 'Delivery Failed',
      'stop.skipped': 'Skipped',

      // BO Status
      'bo.none': '',
      'bo.pending': 'Awaiting BO Confirmation',
      'bo.confirmed': 'BO Confirmed',
      'bo.mismatch': 'BO Count Mismatch',
      'bo.waived': 'BO Confirmation Waived by Ops',

      // Actions
      'act.create': 'Create',
      'act.add': 'Add',
      'act.save': 'Save',
      'act.cancel': 'Cancel',
      'act.delete': 'Delete',
      'act.edit': 'Edit',
      'act.search': 'Search',
      'act.filter': 'Filter',
      'act.close': 'Close',
      'act.confirm': 'Confirm',
      'act.refresh': 'Refresh',
      'act.back': '‹ Previous',
      'act.next': 'Next ›',
      'act.all': 'All',
      'act.export': 'Export Data',
      'act.import': 'Import Data',
      'act.select_all': 'Select All',
      'act.retry': 'Retry',
      'act.view': 'View',

      // Time
      'time.just_now': 'just now',
      'time.sec_ago': 'sec ago',
      'time.min_ago': 'min ago',
      'time.hour_ago': 'hours ago',
      'time.day_ago': 'days ago',
      'time.under_min': 'under 1 min',
      'time.hours': 'hours',
      'time.minutes': 'mins',
      'time.days': 'days',
      'time.on_time': 'On time',
      'time.overdue': 'Overdue',
      'time.late': 'Late',
      'time.due': 'Due',
      'time.no_due': 'No deadline',
      'time.left': 'Remaining',

      // Tables
      'tbl.rows': 'rows',
      'tbl.page': 'page',
      'tbl.empty': 'No data available.',
      'tbl.loading': 'Loading…',

      // Weather & Traffic
      'weather.clear': 'Clear sky',
      'weather.rain': 'Rainy',
      'weather.heavy': 'Heavy rain',
      'weather.storm': 'Thunderstorm',
      'traffic.normal': 'Normal traffic',
      'traffic.peak': 'Rush hour',
      'traffic.jam': 'Heavy traffic jam',
    }
  };

  /** Hàm tra từ điển song ngữ: ARL.t('nav.jobs', 'Bảng việc') */
  ARL.t = function (key, fallback) {
    const l = ARL.lang || 'vi';
    const d = DICT[l] || DICT.vi;
    if (d && d[key] !== undefined) return d[key];
    if (DICT.vi && DICT.vi[key] !== undefined) return DICT.vi[key];
    return fallback !== undefined ? fallback : key;
  };

  /** Đổi ngôn ngữ và cập nhật giao diện */
  ARL.setLang = function (lang) {
    if (lang !== 'vi' && lang !== 'en') lang = 'vi';
    ARL.lang = lang;
    try { localStorage.setItem('arl.lang', lang); } catch {}
    document.documentElement.setAttribute('lang', lang);

    // Đồng bộ các hằng số nhãn trong common.js
    syncCommonLabels(lang);

    // Kích hoạt sự kiện toàn cục
    window.dispatchEvent(new CustomEvent('arl:lang', { detail: { lang } }));

    // Cập nhật lại tiêu đề trang và NAV nếu đang ở Hub
    if (ARL.hub && ARL.hub.NAV) {
      for (const [k, v] of Object.entries(ARL.hub.NAV)) {
        if (DICT[lang]['nav.' + k]) v.title = DICT[lang]['nav.' + k];
        if (DICT[lang]['nav.' + k + '.short']) v.short = DICT[lang]['nav.' + k + '.short'];
      }
    }

    // Refresh giao diện
    if (typeof ARL.refreshCurrentView === 'function') {
      ARL.refreshCurrentView();
    } else if (typeof ARL.reboot === 'function') {
      ARL.reboot();
    }
  };

  /** Đổi giao diện Sáng / Tối */
  ARL.setTheme = function (theme) {
    if (theme !== 'light' && theme !== 'dark') theme = 'light';
    ARL.theme = theme;
    try { localStorage.setItem('arl.theme', theme); } catch {}
    document.documentElement.setAttribute('data-theme', theme);
    window.dispatchEvent(new CustomEvent('arl:theme', { detail: { theme } }));
  };

  ARL.toggleTheme = function () {
    ARL.setTheme(ARL.theme === 'dark' ? 'light' : 'dark');
  };

  ARL.toggleLang = function () {
    ARL.setLang(ARL.lang === 'vi' ? 'en' : 'vi');
  };

  /** Đồng bộ các bảng nhãn trong common.js theo ngôn ngữ */
  function syncCommonLabels(l) {
    if (!ARL.ROLE_LABEL) return;
    const isEn = l === 'en';
    Object.assign(ARL.ROLE_LABEL, isEn ? {
      lead: 'Logistics Lead',
      logistic: 'Logistics Specialist',
      fo: 'Field Ops (FO)',
      admin: 'Administrator',
      tech_lead: 'Tech Lead',
      tech: 'Technician',
      sale_head: 'Head of Sales',
      sale: 'Sales Executive'
    } : {
      lead: 'Logistic Lead',
      logistic: 'Logistic',
      fo: 'FO',
      admin: 'Quản trị viên',
      tech_lead: 'Trưởng nhóm Kỹ thuật',
      tech: 'Kỹ thuật viên',
      sale_head: 'Trưởng phòng Kinh doanh',
      sale: 'Nhân viên Kinh doanh'
    });

    if (ARL.TASK_ST) {
      Object.assign(ARL.TASK_ST, isEn ? {
        unassigned: 'Unassigned', assigned: 'Pending FO', accepted: 'FO Accepted', in_progress: 'In Progress',
        completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled'
      } : {
        unassigned: 'Chưa giao', assigned: 'Chờ FO nhận', accepted: 'FO đã nhận', in_progress: 'Đang chạy',
        completed: 'Hoàn thành', failed: 'Không hoàn thành', cancelled: 'Đã huỷ'
      });
    }

    if (ARL.STOP_ST) {
      Object.assign(ARL.STOP_ST, isEn ? {
        pending: 'Pending', arrived: 'Arrived', done: 'Done', failed: 'Failed', skipped: 'Skipped'
      } : {
        pending: 'Chưa đến', arrived: 'Đã đến', done: 'Đã xong', failed: 'Không giao được', skipped: 'Bỏ qua'
      });
    }

    if (ARL.BO_ST) {
      Object.assign(ARL.BO_ST, isEn ? {
        none: '', pending: 'Awaiting BO Confirmation', confirmed: 'BO Confirmed', mismatch: 'Count Mismatch',
        waived: 'Waived by Logistics'
      } : {
        none: '', pending: 'Chờ BO xác nhận', confirmed: 'BO đã xác nhận', mismatch: 'BO báo lệch số',
        waived: 'Logistic đã cho qua xác nhận của BO'
      });
    }

    if (ARL.DOW) {
      ARL.DOW = isEn ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    }
  }

  ARL.syncCommonLabels = syncCommonLabels;
  // Chạy đồng bộ lần đầu ngay khi nạp
  syncCommonLabels(curLang);
})();
