// defs.js — hằng số nghiệp vụ của Ops Hub: trạng thái, loại việc, cấu hình mặc định.
// Mọi con số trong HUB_DEFAULTS là ĐỀ XUẤT; cột `owner` ghi team có quyền chốt. Đổi được trong Cài đặt mà không sửa code.

export const TEAMS = { tech: 'Tech', logistics: 'Logistics', sale: 'Sale' };

// ───────── Kit ─────────
// Sửa thành phần chỉ khi kit đang ở văn phòng và chưa vào vòng kiểm/xuất: đang chuẩn bị, đã thu hồi về, đang ở Tech.
export const KIT_ST = {
  preparing: 'Đang chuẩn bị',
  wait_check: 'Chờ Tech kiểm',
  ready: 'Sẵn sàng',
  reserved: 'Đã gán BO, chờ giao',
  delivering: 'Đang giao ra BO',
  at_bo: 'Đang quay tại BO',
  recovering: 'Đang thu hồi',
  returned: 'Đã về VP, chờ Tech check-in',
  at_tech: 'Đang ở Tech',
  tech_done: 'Tech xong, chờ Logistics nhận',
  retired: 'Ngừng dùng',
};
export const KIT_EDITABLE = ['preparing', 'returned', 'at_tech'];
export const KIT_OUTSIDE = ['delivering', 'at_bo', 'recovering']; // kit không nằm ở văn phòng
export const KIT_KINDS = { multicam: 'Multicam KIT', iphone: 'iPhone Mono', custom: 'Kit tuỳ chỉnh' };
/** Thành phần bắt buộc theo loại kit (theo mã loại thiết bị). */
export const KIT_CORE = { multicam: ['multicam', 'cm5'], iphone: ['iphone'], custom: [] };

// ───────── Thiết bị ─────────
export const DEV_COND = { ok: 'Tốt', faulty: 'Hỏng', repairing: 'Đang sửa', retired: 'Ngừng dùng', lost: 'Thất lạc' };
export const HEALTH = { good: 'Tốt', weak: 'Yếu', bad: 'Kém' };
export const DEFAULT_TYPES = [
  // id, tên, kind, core (thiết bị chính, không phải phụ kiện), sort
  ['multicam', 'Multicam', 'device', 1, 1],
  ['cm5', 'CM5', 'device', 1, 2],
  ['iphone', 'iPhone', 'device', 1, 3],
  ['powerbank', 'Powerbank', 'device', 0, 4],
  ['sd', 'Thẻ nhớ', 'card', 0, 5],
  ['hub_sac', 'Hub sạc', 'acc', 0, 10],
  ['hub_sac_to', 'Hub sạc to', 'acc', 0, 11],
  ['sac_iphone', 'Sạc iPhone', 'acc', 0, 12],
  ['headstrap', 'Headstrap', 'acc', 0, 13],
  ['powerbank_cover', 'Powerbank cover', 'acc', 0, 14],
  ['cap_c_c', 'Dây Type-C to C', 'acc', 0, 15],
  ['day_gan', 'Dây gắn Multicam', 'acc', 0, 16],
];

// ───────── Thẻ nhớ ─────────
// Vòng đời: VP → (FO mang đi) → tại BO → (FO thu) → về VP → (bàn giao) → đang gửi Tech → Tech đã nhận → đã nhập dung lượng → (trả về) → VP.
export const CARD_ST = {
  office: 'Sẵn sàng tại VP',
  with_fo: 'FO đang mang đi',
  at_bo: 'Đang ở BO',
  returned: 'Đã thu về VP',
  to_tech: 'Đang bàn giao cho Tech',
  at_tech: 'Tech đã nhận',
  uploaded: 'Đã nhập dung lượng',
  to_log: 'Đang trả về Logistics',
  bad: 'Hỏng',
  lost: 'Thất lạc',
};

// ───────── Yêu cầu ─────────
export const REQ_KIND = { launch: 'Mở BO mới', support: 'Hỗ trợ', end: 'Kết thúc ghi hình' };
export const SUPPORT_KIND = { swap_device: 'Đổi máy hư', bad_card: 'Thẻ hư', extra_acc: 'Bổ sung phụ kiện', add_kit: 'Thêm kit', other: 'Khác' };
export const REQ_ST = {
  submitted: 'Đã gửi, chờ Logistics',
  preparing: 'Đang chuẩn bị', // ai đang giữ bước nào: xem "đang chờ" (outlets.js waitingOf)
  ready: 'Kit sẵn sàng, chờ giao',
  delivering: 'Đang giao',
  live: 'Đang ghi hình',
  scheduled: 'Đã hẹn ngày kết thúc', // yêu cầu kết thúc có ngày trong tương lai: BO vẫn ghi hình tới ngày đó
  ending: 'Đang thu hồi',
  closed: 'Đã đóng',
  cancelled: 'Đã huỷ',
};
export const OUTLET_ST = { planned: 'Chờ launch', live: 'Đang ghi hình', paused: 'Tạm nghỉ', ending: 'Đang thu hồi', ended: 'Đã kết thúc' };

// ───────── Việc tự sinh ─────────
// std: phút chuẩn mặc định (điểm = phút chuẩn ÷ 6). per: đơn vị tính (job | card | line | kit).
// sla: hạn xử lý mặc định (phút) tính từ lúc tạo việc, trừ khi ghi chú khác.
export const JOB_TYPES = {
  prep_kit: { team: 'logistics', label: 'Chuẩn bị kit cho yêu cầu', std: 20, per: 'kit', sla: 24 * 60 },
  check_kit: { team: 'tech', label: 'Kiểm kit trước khi xuất', std: 15, per: 'kit', sla: 24 * 60 },
  deliver: { team: 'logistics', label: 'Giao và setup tại BO', std: 45, per: 'job', sla: null }, // hạn = cuối ngày launch
  card_swap: { team: 'logistics', label: 'Đổi thẻ tại BO', std: 10, per: 'job', sla: null }, // hạn = cuối khung giờ đổi thẻ
  swap_faulty: { team: 'logistics', label: 'Đổi kit hỏng tại BO', std: 20, per: 'job', sla: 24 * 60 },
  recover: { team: 'logistics', label: 'Thu hồi kit tại BO', std: 30, per: 'job', sla: 48 * 60 },
  receive_field: { team: 'logistics', label: 'Nhận kit thu hồi về kho', std: 5, per: 'kit', sla: 12 * 60 },
  checkin: { team: 'tech', label: 'Check-in kit thu hồi', std: 12, per: 'kit', sla: 8 * 60 },
  receive_back: { team: 'logistics', label: 'Nhận lại kit từ Tech', std: 5, per: 'kit', sla: 24 * 60 },
  stock_check: { team: 'logistics', label: 'Kiểm kho định kỳ', std: 8, per: 'job', sla: null }, // hạn = cuối ngày
  repair: { team: 'tech', label: 'Sửa kit hỏng', std: 60, per: 'kit', sla: 72 * 60 },
  qr_change: { team: 'tech', label: 'Đổi QR cho BO', std: 10, per: 'job', sla: 24 * 60 },
  deliver_acc: { team: 'logistics', label: 'Giao bổ sung phụ kiện tại BO', std: 15, per: 'job', sla: 24 * 60 },
  cards_receive: { team: 'tech', label: 'Nhận thẻ từ Logistics', std: 5, per: 'line', sla: 30 },
  cards_upload: { team: 'tech', label: 'Nhập dung lượng thẻ', std: 6, per: 'card', sla: 24 * 60 },
  cards_back: { team: 'logistics', label: 'Nhận lại thẻ từ Tech', std: 5, per: 'line', sla: 24 * 60 },
  cards_return: { team: 'tech', label: 'Trả thẻ đã nhập về Logistics', std: 3, per: 'job', sla: 24 * 60 }, // tự đóng khi thẻ của phiếu đã vào phiếu trả
  incident: { team: 'tech', label: 'Xử lý sự cố tại BO', std: 20, per: 'job', sla: 24 * 60 },
  manual: { team: null, label: 'Việc giao tay', std: 0, per: 'job', sla: 24 * 60 },
};
export const JOB_ST = { open: 'Chờ làm', doing: 'Đang làm', done: 'Xong', cancelled: 'Đã huỷ' };
/** Phút chuẩn theo cách xử lý sự cố (ghi đè std của loại 'incident'). */
export const INCIDENT_RES = { no_recover: { label: 'Xử lý tại chỗ, không thu hồi', std: 20 }, swap: { label: 'Đổi máy', std: 30 }, office_repair: { label: 'Mang về sửa tại văn phòng', std: 60 }, invalid: { label: 'Không phải sự cố', std: 5 } };

// Nhãn lỗi: bản ĐỀ XUẤT, Tech chốt lại theo bộ nhãn của file Tech (19 nhãn Multicam KIT, 11 nhãn iPhone Mono).
export const DEFAULT_LABELS = {
  multicam: ['Không lên nguồn', 'Không ghi hình', 'CM5 mất kết nối', 'Lỗi thẻ nhớ', 'Thẻ đầy', 'Powerbank không sạc', 'Cáp lỏng hoặc đứt', 'Quá nhiệt', 'Lệch góc quay', 'Ống kính bẩn hoặc mờ', 'Mất tiếng', 'Đèn báo lỗi', 'Hub sạc hỏng', 'Dây gắn hỏng', 'Rơi hoặc va đập', 'BO tắt máy', 'BO tháo thiết bị', 'Mất thiết bị', 'Khác'],
  iphone: ['Không lên nguồn', 'Không ghi hình', 'Hết bộ nhớ', 'Pin chai hoặc không sạc', 'Sạc hỏng', 'Headstrap hỏng', 'Quá nhiệt', 'Ứng dụng lỗi', 'Rơi hoặc va đập', 'Mất thiết bị', 'Khác'],
};

// ───────── Thẻ: lý do 0 giờ ─────────
export const ZERO_REASONS = ['BO không bật máy', 'BO đóng cửa / nghỉ', 'Máy không ghi', 'Thẻ lỗi', 'Thẻ chưa dùng', 'Khác'];

// ───────── Sự cố ─────────
export const INCIDENT_ST = { open: 'Mới báo', ack: 'Tech đang xử lý', resolved: 'Đã xử lý', cancelled: 'Đã huỷ' };

// ───────── Chấm công ─────────
export const ATT_ST = { present: 'Đúng giờ', late: 'Vào trễ', absent: 'Vắng', leave: 'Nghỉ phép', off: 'Nghỉ' };
export const RATING = { 5: 'Xuất sắc', 4: 'Tốt', 3: 'Đạt', 2: 'Cần cải thiện', 1: 'Chưa đạt' };

export const HUB_DEFAULTS = {
  gbPerHour: 16.9, //            Tech Lead chốt: dung lượng thô của 1 giờ ghi hình (GB). Tech nhập GB, giờ là số tính ra.
  checkBeforeShip: true, //      Tech chốt: kit phải được Tech kiểm đạt mới được xuất.
  uploadPhotoRequired: false, // Tech chốt: bắt buộc ảnh chụp màn hình dung lượng khi nhập thẻ.
  swapLeadDays: 2, //            Logistics chốt: việc đổi thẻ tự tạo trước bao nhiêu ngày.
  setupShowDays: 2, //           Logistics chốt: việc giao/setup hiện trước ngày launch bao nhiêu ngày.
  stockCheckDay: 5, //           Logistics chốt: ngày kiểm kho trong tuần (1 = T2 … 7 = CN).
  cardsPerKit: 2, //             Logistics chốt: số thẻ mỗi máy mỗi lượt đổi.
  // Các mục trong TEAM_CFG có giá trị riêng cho từng team ({ tech, logistics }); mỗi Lead chốt phần của team mình. Số dưới đây là đề xuất chung cho cả hai.
  autoAssign: true, //           Lead chốt: việc mới tự giao cho người đang trong ca theo bảng phân ca, ít tải nhất (tính theo phút chuẩn).
  poolAlertMin: 45, //           Lead chốt: việc chưa ai nhận quá bao lâu (phút) trong khi team có người trong ca thì báo Lead.
  leadOverdueMin: 120, //        Lead chốt: một việc để quá hạn bao lâu (phút) thì báo Lead.
  leadPileJobs: 4, leadPileMin: 60, // Giữ hơn N việc và việc lâu nhất quá M phút thì báo Lead.
  zeroHourAlert: true, //        Báo Sale khi có thẻ 0 giờ ở BO của mình.
  earlyCheckinMin: 15, lateAfterMin: 10, // Chấm công: tính từ 15 phút trước giờ vào ca; vào trễ quá 10 phút ghi là trễ.
  absentAfterMin: 60, //         Quá giờ vào ca bao lâu (phút) mà chưa vào thì ghi vắng, việc chưa bắt đầu trả về cho người khác trong ca.
  releaseGraceMin: 30, //        Lead chốt (đề xuất): hết ca quá bao lâu (phút) thì việc chưa bắt đầu của người đó trả về cho người đang trong ca.
  rosterSelfApprove: false, //   Nhân viên đăng ký ca thì cần Lead duyệt.
  shifts: [ //                    Ca mẫu. Lead chốt theo giờ làm thật của từng team.
    { id: 'HC', name: 'Hành chính', start: '08:30', end: '17:30' },
    { id: 'S', name: 'Ca sáng', start: '07:00', end: '15:00' },
    { id: 'C', name: 'Ca chiều', start: '14:00', end: '22:00' },
  ],
  minDaysWeek: 3, minDaysMonth: 5, // Không xếp loại khi dưới số công này.
  rateLogistics: true, //        Xếp loại cả Logistics (định mức phút chuẩn của Logistics vẫn là đề xuất, cần bấm giờ thật).
  scoreWeights: { vol: 50, sla: 30, quality: 10, att: 10 }, // Trọng số điểm tổng hợp: khối lượng, đúng hạn, chất lượng, chuyên cần.
  scoreBands: [90, 80, 65, 50], // Điểm tổng hợp ≥ 90 → 5, ≥ 80 → 4, ≥ 65 → 3, ≥ 50 → 2, thấp hơn → 1.
  spikeMin: 3, //                Lỗi tăng vọt: ít nhất 3 lần trong tuần và gấp đôi trung bình 4 tuần trước.
  saleSeesAll: false, //         Sale Lead chỉ thấy BO của mình (Head of Sale luôn thấy tất cả).
  jobStd: {}, jobSla: {}, //     Ghi đè phút chuẩn / hạn theo loại việc.
  labels: null, //               Ghi đè bộ nhãn lỗi.
  dailyStdHours: 5, //           Sale chốt: chuẩn giờ quay thô mỗi kit mỗi ngày; BO dưới chuẩn được đánh dấu.
  quotaWarnPct: 80, //           Sale chốt: BO dùng tới bao nhiêu % quota giờ quay thì báo "sắp chạm quota".
  evalLagDays: 2, //             Tech chốt: so giờ quay WoW / MoM tới trước bao nhiêu ngày gần nhất (thẻ chưa kịp về và nhập). Chuẩn giờ quay chỉ xét ngày thẻ đã nhập đủ.
  foStopStd: 15, //              Logistics chốt: phút chuẩn cho một điểm FO giao nhận xong mà không gắn việc của hub.
  prepMinHours: 4, //            Logistics chốt (đề xuất): việc chuẩn bị kit có ít nhất bấy nhiêu giờ; launch gấp hơn thì đánh dấu gấp thay vì sinh ra đã quá hạn.
  replayMin: 10, //              Quản trị chốt (đề xuất): cùng người gửi lại cùng một hộp thoại trong bấy nhiêu phút thì coi là gửi lặp, trả lại kết quả cũ.
  // Ngưỡng của danh sách "Điểm nghẽn" (đề xuất). Việc quá hạn dùng chung leadOverdueMin ở trên.
  incidentAckMin: 60, //         Tech chốt: sự cố chưa có Tech nhận quá bao lâu (phút) thì báo.
  incidentOldH: 24, //           Tech chốt: sự cố mở quá bao lâu (giờ) thì báo.
  incidentCancelMin: 30, //      Tech chốt: người báo tự huỷ sự cố được trong bao lâu (phút); sau đó Tech Lead huỷ.
  uploadLateH: 24, //            Tech chốt: thẻ Tech đã nhận quá bao lâu (giờ) chưa nhập dung lượng thì báo.
  reqLateDays: 2, //             Logistics chốt: còn từng này ngày tới launch mà kit chưa sẵn sàng thì báo.
  cardsStaleDays: 3, //          Logistics chốt: thẻ nằm ở BO quá bao nhiêu ngày thì báo (BO đổi thưa hơn thì tính theo lịch đổi + 1 ngày).
  cardsReturnedH: 12, //         Logistics chốt: thẻ đã thu về VP quá bao lâu (giờ) chưa lập phiếu gửi Tech thì báo.
  // Vòng thẻ nhớ (đề xuất): ngưỡng báo và giới hạn nhập / sửa dung lượng. Thẻ ở BO, thẻ thu về, thẻ ở Tech dùng chung ba mục ở trên.
  officeCardsMin: 10, //         Logistics chốt: thẻ sẵn sàng tại VP dưới mức này thì báo Logistics (0 = tắt).
  cardsUploadedHours: 24, //     Tech chốt: thẻ đã nhập quá bao nhiêu giờ chưa trả Logistics thì báo.
  shootWindowDays: 60, //        Tech chốt: ngày quay được nhập / sửa trong bao nhiêu ngày gần đây.
  recordEditHours: 48, //        Tech chốt: người nhập tự sửa bản ghi dung lượng trong bao nhiêu giờ (Tech Lead sửa mọi lúc).
};
export const HUB_OWNER = {
  gbPerHour: 'Tech', checkBeforeShip: 'Tech', uploadPhotoRequired: 'Tech', swapLeadDays: 'Logistics', setupShowDays: 'Logistics', stockCheckDay: 'Logistics', cardsPerKit: 'Logistics',
  autoAssign: 'Lead', poolAlertMin: 'Lead', leadOverdueMin: 'Lead', leadPileJobs: 'Lead', leadPileMin: 'Lead', zeroHourAlert: 'Sale và Tech', earlyCheckinMin: 'Lead', lateAfterMin: 'Lead',
  absentAfterMin: 'Lead', releaseGraceMin: 'Lead', rosterSelfApprove: 'Lead', shifts: 'Lead', minDaysWeek: 'Lead', minDaysMonth: 'Lead', rateLogistics: 'Logistics', scoreWeights: 'Lead', scoreBands: 'Lead',
  spikeMin: 'Tech', saleSeesAll: 'Quản trị', jobStd: 'Lead', jobSla: 'Lead', labels: 'Tech',
  dailyStdHours: 'Sale', quotaWarnPct: 'Sale', evalLagDays: 'Tech', foStopStd: 'Logistics', prepMinHours: 'Logistics', replayMin: 'Quản trị',
  incidentAckMin: 'Tech', incidentOldH: 'Tech', incidentCancelMin: 'Tech', uploadLateH: 'Tech', reqLateDays: 'Logistics', cardsStaleDays: 'Logistics', cardsReturnedH: 'Logistics',
  officeCardsMin: 'Logistics', cardsUploadedHours: 'Tech', shootWindowDays: 'Tech', recordEditHours: 'Tech',
};
/**
 * Mục cấu hình riêng của từng team: lưu dạng { tech, logistics }. Tech Lead chỉ sửa phần Tech, Logistic Lead chỉ sửa phần Logistics,
 * Quản trị sửa cả hai. Giá trị cũ lưu dạng chung (một giá trị) vẫn đọc được và áp cho cả hai team. Field Ops tính theo phần Logistics.
 */
export const TEAM_CFG = ['autoAssign', 'poolAlertMin', 'leadOverdueMin', 'leadPileJobs', 'leadPileMin', 'earlyCheckinMin', 'lateAfterMin', 'absentAfterMin', 'releaseGraceMin', 'rosterSelfApprove', 'shifts', 'minDaysWeek', 'minDaysMonth', 'scoreWeights', 'scoreBands'];
/** Tên dễ đọc của từng mục cấu hình (màn hình Cài đặt). */
export const HUB_LABEL = {
  gbPerHour: 'GB cho mỗi giờ ghi hình', checkBeforeShip: 'Tech kiểm kit trước khi xuất', uploadPhotoRequired: 'Bắt buộc ảnh dung lượng khi nhập thẻ',
  swapLeadDays: 'Tạo việc đổi thẻ trước (ngày)', setupShowDays: 'Hiện việc giao, setup trước ngày launch (ngày)', stockCheckDay: 'Ngày kiểm kho trong tuần (1 = T2 … 7 = CN)',
  cardsPerKit: 'Số thẻ mỗi máy mỗi lượt đổi', autoAssign: 'Tự giao việc theo ca', poolAlertMin: 'Báo Lead khi việc chưa ai nhận quá (phút)',
  leadOverdueMin: 'Báo Lead khi việc quá hạn quá (phút)', leadPileJobs: 'Báo Lead khi một người giữ hơn (việc)', leadPileMin: 'và việc lâu nhất quá (phút)',
  zeroHourAlert: 'Báo Sale khi có thẻ 0 giờ', earlyCheckinMin: 'Chấm công sớm nhất trước giờ vào ca (phút)', lateAfterMin: 'Tính trễ khi vào sau giờ ca quá (phút)',
  absentAfterMin: 'Ghi vắng khi quá giờ vào ca (phút)', releaseGraceMin: 'Trả việc chưa bắt đầu về cho cả đội sau khi hết ca (phút)', rosterSelfApprove: 'Ca nhân viên tự đăng ký không cần duyệt', shifts: 'Ca mẫu',
  minDaysWeek: 'Số công tối thiểu để xếp loại tuần', minDaysMonth: 'Số công tối thiểu để xếp loại tháng', rateLogistics: 'Xếp loại Logistics',
  scoreWeights: 'Trọng số điểm tổng hợp (%)', scoreBands: 'Ngưỡng điểm cho mức 5, 4, 3, 2', spikeMin: 'Số lần tối thiểu để coi là lỗi tăng vọt',
  saleSeesAll: 'Sale Lead xem mọi BO', jobStd: 'Phút chuẩn theo loại việc', jobSla: 'Hạn xử lý theo loại việc (phút)', labels: 'Bộ nhãn lỗi',
  dailyStdHours: 'Chuẩn giờ quay mỗi kit mỗi ngày (giờ)', quotaWarnPct: 'Báo sắp chạm quota khi đã dùng (%)', evalLagDays: 'Bỏ qua số ngày gần nhất khi so giờ quay với kỳ trước',
  foStopStd: 'Phút chuẩn mỗi điểm FO không gắn việc hub', prepMinHours: 'Thời gian chuẩn bị kit tối thiểu (giờ)',
  replayMin: 'Coi là gửi lặp khi gửi lại trong (phút)',
  incidentAckMin: 'Báo sự cố chưa có Tech nhận sau (phút)', incidentOldH: 'Báo sự cố mở quá (giờ)', incidentCancelMin: 'Người báo tự huỷ sự cố trong (phút)',
  uploadLateH: 'Báo thẻ Tech đã nhận chưa nhập dung lượng sau (giờ)', reqLateDays: 'Báo yêu cầu launch chưa sẵn sàng khi còn (ngày)',
  cardsStaleDays: 'Báo thẻ nằm ở BO quá (ngày)', cardsReturnedH: 'Báo thẻ đã thu về chưa gửi Tech sau (giờ)',
  officeCardsMin: 'Báo khi thẻ sẵn sàng tại VP dưới (thẻ)', cardsUploadedHours: 'Báo thẻ đã nhập chưa trả Logistics quá (giờ)', shootWindowDays: 'Ngày quay nhập được trong (ngày gần đây)',
  recordEditHours: 'Người nhập tự sửa bản ghi dung lượng trong (giờ)',
};
/** Loại biến động kho phụ kiện. */
export const ACC_MOVE = { in: 'Nhập thêm', out: 'Ghi giảm (hỏng, thanh lý)', lost: 'Mất / thiếu khi thu hồi', found: 'Tìm lại', count: 'Kiểm kê điều chỉnh', import: 'Nhập dữ liệu ban đầu' };
