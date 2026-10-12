// schema.js — định nghĩa bảng dùng chung cho kho SQLite (máy chủ) và kho bộ nhớ (bản xem thử, kiểm thử).
// Kiểu cột: int | real | text | json. Mọi bảng có cột khoá `id` (số tự tăng, trừ khi ghi idType: 'text').

export const SCHEMA = {
  users: {
    cols: {
      username: 'text', name: 'text', phone: 'text', role: 'text', site_id: 'int', pass_hash: 'text', must_change: 'int', active: 'int',
      color: 'text', vehicle: 'text', device_token: 'text', consent_version: 'text', consent_at: 'int', created_at: 'int', demo: 'int',
      email: 'text', lang: 'text',
    },
    index: [['username'], ['device_token']],
  },
  sessions: { idType: 'text', cols: { user_id: 'int', created_at: 'int', seen_at: 'int', expires_at: 'int', ua: 'text' }, index: [['user_id']] },
  // sites: điểm giao nhận của Rider Live, đồng thời là BO của Ops Hub (type = 'bo'). Các cột ops_* do Ops Hub quản lý.
  sites: {
    cols: {
      name: 'text', type: 'text', address: 'text', contact: 'text', phone: 'text', lat: 'real', lon: 'real', radius: 'int', active: 'int', created_at: 'int',
      code: 'text', sale_id: 'int', ops_status: 'text', launch_date: 'text', end_date: 'text', swap_days: 'text', swap_from: 'text', swap_to: 'text',
      pause_from: 'text', pause_to: 'text', business: 'text', area: 'text', note: 'text', updated_at: 'int',
      quota_hours: 'real', onboard_date: 'text', // quota giờ quay tối đa theo hợp đồng; ngày BO có máy ghi hình lần đầu (active)
      signed_date: 'text', signed_by: 'int', // onboard = BO đã ký: ngày gửi yêu cầu launch đầu tiên không huỷ và Sale Lead gửi (giữ nguyên khi giao BO cho người khác)
      live_periods: 'json', pauses: 'json', // các đợt ghi hình [[từ, đến | null]]; các lần tạm nghỉ đã qua [[từ, đến]]
    },
    index: [['code'], ['sale_id'], ['ops_status']],
  },
  tasks: {
    cols: {
      code: 'text', title: 'text', fo_id: 'int', created_by: 'int', template_id: 'int', date: 'text', start_at: 'int', base_min: 'int', factor: 'real', due_at: 'int',
      status: 'text', accepted_at: 'int', started_at: 'int', finished_at: 'int', round_trip: 'int', plan_km: 'real', km: 'real', note: 'text', late: 'int', partial: 'int',
      al_nostart: 'int', al_risk: 'int', al_late: 'int', cancel_reason: 'text', created_at: 'int',
      // Đường đi thực tế (deps.route): route_src null = SLA ước tính đường chim bay | 'google' | 'osrm'; route_traffic 1 = thời gian đi đã tính kẹt xe.
      // travel_min + service_min + buffer_min → base_min; traffic_min: phút thêm do kẹt xe so với đường thông thoáng (null = không rõ).
      // eta_at: dự kiến xong khi đang chạy; al_predict: đã báo dự kiến trễ. Hình đường đi nằm ở bảng routes, không nằm ở đây.
      route_src: 'text', route_at: 'int', route_traffic: 'int', travel_min: 'int', traffic_min: 'int', service_min: 'int', buffer_min: 'int', route_err: 'text', eta_at: 'int', al_predict: 'int',
      // SLA theo đường (mô hình v2): p50_min = đi + dừng (trung vị), unc_min = độ bất định U (phút), sla_q = % chuyến kịp hạn nhắm tới lúc tính;
      // route_mode: phương tiện dịch vụ đã dùng (TWO_WHEELER | DRIVE | driving…): đường xe máy của Google phải kèm cảnh báo đang thử nghiệm.
      p50_min: 'int', unc_min: 'int', sla_q: 'real', route_mode: 'text',
    },
    index: [['date'], ['fo_id', 'status'], ['template_id', 'date'], ['status']],
  },
  // Đường đi thực tế của task (một dòng mỗi task, tính lại thì thay). Tách khỏi tasks: nhịp định kỳ đọc mọi task đang mở 15 giây một lần, không giải mã hình đường.
  // sig: chữ ký danh sách điểm lúc tính (điểm đổi thì đường cũ hết đúng); legs: [{ distance_m, duration_s, static_s, polyline, jams }].
  routes: {
    cols: { task_id: 'int', sig: 'text', provider: 'text', mode: 'text', traffic: 'int', depart_at: 'int', at: 'int', distance_m: 'int', duration_s: 'int', static_s: 'int', legs: 'json', warn: 'json' },
    index: [['task_id']],
  },
  stops: {
    cols: {
      task_id: 'int', seq: 'int', site_id: 'int', name: 'text', address: 'text', phone: 'text', lat: 'real', lon: 'real', radius: 'int', is_return: 'int',
      exp_cards_out: 'int', exp_cards_in: 'int', exp_dev_out: 'int', exp_dev_in: 'int', note: 'text',
      status: 'text', arrived_at: 'int', arrive_mode: 'text', done_at: 'int', cards_out: 'int', cards_in: 'int', dev_out: 'int', dev_in: 'int',
      fo_note: 'text', fail_reason: 'text', proof_dist: 'int',
      bo_status: 'text', bo_user: 'int', bo_at: 'int', bo_cards_recv: 'int', bo_cards_given: 'int', bo_dev_recv: 'int', bo_dev_given: 'int', bo_note: 'text', bo_reminded: 'int',
      bo_req: 'int', bo_link_hash: 'text', bo_link_at: 'int', bo_link_dev: 'text', bo_link_open_at: 'int', bo_waive_reason: 'text',
      hub: 'json', // việc Ops Hub đi theo điểm này: { jobs: [id], kits_out: [id], kits_in: [id], cards_out: [mã], cards_in: [mã] }
    },
    index: [['task_id'], ['site_id', 'bo_status'], ['bo_link_hash']],
  },
  photos: { idType: 'text', cols: { stop_id: 'int', task_id: 'int', user_id: 'int', by: 'text', ts: 'int', lat: 'real', lon: 'real', mime: 'text', size: 'int', ref: 'text', site_id: 'int' }, index: [['stop_id'], ['ref']] },
  events: {
    cols: { ts: 'int', type: 'text', level: 'text', task_id: 'int', stop_id: 'int', fo_id: 'int', actor_id: 'int', text: 'text', data: 'json', ack_by: 'int', ack_at: 'int' },
    index: [['ts'], ['task_id']],
  },
  templates: {
    cols: { name: 'text', fo_id: 'int', days: 'text', start_time: 'text', round_trip: 'int', stops: 'json', note: 'text', active: 'int', last_gen_date: 'text', created_by: 'int', created_at: 'int' },
  },
  consents: { cols: { user_id: 'int', version: 'text', action: 'text', ts: 'int', ip: 'text', ua: 'text', items: 'json' }, index: [['user_id']] },
  settings: { idType: 'text', cols: { value: 'json' } },
  positions: { cols: { user_id: 'int', ts: 'int', lat: 'real', lon: 'real', spd: 'real', hdg: 'real', acc: 'real', bat: 'real' }, index: [['user_id', 'ts'], ['ts']] },
  shifts: { cols: { user_id: 'int', start_ts: 'int', end_ts: 'int', end_reason: 'text' }, index: [['user_id', 'start_ts']] },
  daily: { idType: 'text', cols: { user_id: 'int', date: 'text', km: 'real', move_sec: 'int', pts: 'int', first_ts: 'int', last_ts: 'int' }, index: [['date'], ['user_id', 'date']] },

  // ───────────────────────── Ops Hub ─────────────────────────
  // Danh mục loại thiết bị / phụ kiện. kind: device (theo mã) | card (thẻ nhớ, theo mã) | acc (phụ kiện, theo số lượng).
  dev_types: { idType: 'text', cols: { name: 'text', kind: 'text', core: 'int', sort: 'int', active: 'int', total: 'int', created_at: 'int' } },
  devices: {
    cols: { code: 'text', type: 'text', cond: 'text', kit_id: 'int', health: 'text', note: 'text', created_at: 'int', updated_at: 'int' },
    index: [['code'], ['kit_id'], ['type', 'cond']],
  },
  kits: {
    cols: { code: 'text', kind: 'text', status: 'text', site_id: 'int', request_id: 'int', acc: 'json', note: 'text', checked_at: 'int', checked_by: 'int', created_at: 'int', updated_at: 'int', watch: 'text', fault: 'text' },
    index: [['code'], ['status'], ['site_id'], ['request_id']],
  },
  requests: {
    cols: {
      code: 'text', kind: 'text', site_id: 'int', parent_id: 'int', sale_id: 'int', created_by: 'int', status: 'text', need: 'json', launch_date: 'text',
      kit_id: 'int', note: 'text', reason: 'text', created_at: 'int', updated_at: 'int', closed_at: 'int',
      prev: 'json', // yêu cầu mở lại BO đã kết thúc: trạng thái BO trước đó, để huỷ yêu cầu thì trả BO về như cũ
    },
    index: [['site_id'], ['status'], ['parent_id'], ['sale_id']],
  },
  jobs: {
    cols: {
      code: 'text', type: 'text', team: 'text', title: 'text', site_id: 'int', kit_id: 'int', request_id: 'int', incident_id: 'int', handover_id: 'int',
      dedupe: 'text', status: 'text', assignee_id: 'int', created_by: 'int', created_at: 'int', show_date: 'text', due_at: 'int', started_at: 'int',
      done_at: 'int', done_by: 'int', result: 'json', std_min: 'real', units: 'int', note: 'text', task_id: 'int', al_due: 'int', al_lead: 'int', date: 'text',
      // priority: 1 = gấp. sla_start: lúc đồng hồ hạn bắt đầu (lúc có người nhận; null = hạn cố định theo ngày).
      // blocked: lý do đang vướng (chờ bên khác); thời gian vướng được cộng trả vào hạn khi gỡ. skip_uid: người vừa trả việc, không tự giao lại cho họ.
      priority: 'int', sla_start: 'int', blocked: 'text', blocked_at: 'int', skip_uid: 'int', al_pool: 'int',
      // assigned_at: lúc người đang giữ nhận việc; assign_by: auto (hệ thống tự giao) | lead (Lead giao tay) | self (tự nhận, theo thao tác).
      // due_mine: hạn riêng của người đang giữ (tính điểm đúng hạn cá nhân); hạn của team vẫn là due_at. skip_at: lúc trả việc (skip_uid hết hiệu lực qua ngày hoặc khi người đó vào ca lại).
      // skip_due: hạn riêng của người vừa trả việc (skip_uid) lúc trả; họ nhận lại thì giữ hạn này, không làm mới.
      assigned_at: 'int', assign_by: 'text', due_mine: 'int', skip_at: 'int', skip_due: 'int',
    },
    index: [['dedupe'], ['status', 'team', 'done_at'], ['assignee_id', 'status'], ['site_id'], ['kit_id'], ['done_by', 'done_at'], ['date'], ['incident_id', 'type'], ['request_id'], ['handover_id'], ['task_id']],
  },
  cards: {
    cols: { code: 'text', status: 'text', site_id: 'int', kit_id: 'int', handover_id: 'int', task_id: 'int', since: 'int', note: 'text', created_at: 'int', updated_at: 'int', bo_in: 'int', bo_out: 'int' },
    index: [['code'], ['status'], ['site_id']],
  },
  handovers: {
    cols: { code: 'text', dir: 'text', status: 'text', from_id: 'int', to_id: 'int', created_at: 'int', received_at: 'int', note: 'text', lines: 'int', recv: 'int' },
    index: [['status', 'dir'], ['created_at']],
  },
  handover_lines: {
    cols: { handover_id: 'int', card_id: 'int', code: 'text', site_id: 'int', kit_id: 'int', recv_at: 'int', recv_by: 'int', missing: 'int' },
    index: [['handover_id'], ['card_id']],
  },
  card_records: {
    // src: 'import' = lịch sử nhập từ file (tính vào giờ quay của BO, không tính vào điểm khối lượng của ai).
    // std_min: phút chuẩn mỗi thẻ lúc nhập (điểm khối lượng); bản ghi cũ chưa có thì dùng phút chuẩn hiện hành.
    // cover_to: ngày cuối thẻ nằm ở BO lúc nhập (trước hôm thu thẻ), không đổi khi sửa ngày quay; giờ của thẻ chia đều cho các ngày shoot_date → cover_to.
    // Trống = chưa rõ (dữ liệu cũ, nhập từ file): giờ nằm ở ngày quay và ngày đó không xét chuẩn giờ quay.
    cols: { card_id: 'int', code: 'text', site_id: 'int', kit_id: 'int', handover_id: 'int', shoot_date: 'text', gb: 'real', hours: 'real', zero_reason: 'text', photos: 'json', by_id: 'int', at: 'int', edited_by: 'int', edited_at: 'int', src: 'text', std_min: 'real', cover_to: 'text' },
    index: [['site_id', 'shoot_date'], ['card_id'], ['shoot_date'], ['by_id', 'at'], ['at'], ['cover_to']],
  },
  incidents: {
    cols: {
      code: 'text', site_id: 'int', kit_id: 'int', device_id: 'int', label: 'text', text: 'text', status: 'text', raised_by: 'int', raised_role: 'text',
      resolution: 'text', resolve_note: 'text', resolved_by: 'int', created_at: 'int', ack_at: 'int', resolved_at: 'int', src: 'text',
    },
    index: [['status'], ['site_id'], ['created_at']],
  },
  hub_log: {
    cols: { ts: 'int', actor_id: 'int', entity: 'text', entity_id: 'int', action: 'text', text: 'text', data: 'json' },
    index: [['entity', 'entity_id'], ['entity', 'action', 'ts'], ['ts']],
  },
  inbox: {
    cols: { user_id: 'int', ts: 'int', level: 'text', kind: 'text', text: 'text', link: 'text', ref: 'text', read_at: 'int' },
    index: [['user_id', 'read_at'], ['ref']],
  },
  // Bảng phân ca. kind: shift (ca làm) | leave (nghỉ phép). status: approved | pending (nhân viên đăng ký, chờ Lead duyệt) | rejected.
  roster: {
    idType: 'text',
    cols: { user_id: 'int', date: 'text', start: 'text', end: 'text', by_id: 'int', kind: 'text', shift: 'text', status: 'text', note: 'text', team: 'text', at: 'int' },
    index: [['date'], ['user_id', 'date'], ['status']],
  },
  attendance: {
    idType: 'text',
    cols: { user_id: 'int', date: 'text', checkin_at: 'int', late_min: 'int', status: 'text', ot_min: 'int', note: 'text', by_id: 'int' },
    index: [['date'], ['user_id', 'date']],
  },
  recon: {
    cols: { ts: 'int', source: 'text', team: 'text', level: 'text', entity: 'text', ref: 'text', text: 'text', data: 'json', status: 'text', resolved_by: 'int', resolved_at: 'int', note: 'text' },
    index: [['status'], ['ref']],
  },
  perf_lock: { idType: 'text', cols: { by_id: 'int', at: 'int', data: 'json' } },
  // Sổ kho phụ kiện: mọi thay đổi tổng số lượng (nhập thêm, ghi giảm, mất khi thu hồi, kiểm kê, nhập dữ liệu ban đầu).
  // Số "trong kit" và "rảnh" không ghi ở đây mà tính từ kit, nên luôn khớp với trạng thái việc.
  acc_moves: {
    cols: { type_id: 'text', delta: 'int', kind: 'text', reason: 'text', kit_id: 'int', site_id: 'int', job_id: 'int', by_id: 'int', at: 'int', total_after: 'int' },
    index: [['type_id', 'at'], ['at']],
  },
  // Nhập dữ liệu từ file Excel: mỗi lượt nhập một dòng, giữ ánh xạ cột và kết quả để xem lại.
  imports: { cols: { name: 'text', by_id: 'int', at: 'int', status: 'text', summary: 'json', mapping: 'json' }, index: [['at']] },
};
