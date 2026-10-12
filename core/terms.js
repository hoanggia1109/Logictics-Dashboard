// terms.js — bản điều khoản mặc định về xử lý dữ liệu cá nhân của FO (FieldOps).
// Đây là BẢN MẪU kỹ thuật, soạn theo Luật Bảo vệ dữ liệu cá nhân 2025 và Nghị định 356/2025/NĐ-CP.
// Bộ phận pháp chế của công ty cần rà soát và chỉnh sửa (Logistic Lead sửa ngay trong ứng dụng: Tài khoản → Điều khoản).

export function defaultTerms(cfg) {
  const company = cfg.company || 'Công ty';
  const contact = cfg.contact ? ` Liên hệ: ${cfg.contact}.` : ' Liên hệ: Logistic Lead hoặc bộ phận Nhân sự của công ty.';
  const keepPos = cfg.retentionDays > 0 ? `${cfg.retentionDays} ngày` : 'đến khi công ty xoá';
  const keepPhoto = cfg.photoRetentionDays > 0 ? `${cfg.photoRetentionDays} ngày` : 'đến khi công ty xoá';
  return {
    version: 'v2',
    title: 'Đồng ý cho công ty xử lý dữ liệu cá nhân',
    intro: `Bạn là nhân viên FieldOps (FO) của ${company}. Để dùng ứng dụng nhận và thực hiện task giao nhận, bạn cần đọc và đánh dấu đồng ý TỪNG mục dưới đây. Bạn có quyền không đồng ý; khi đó bạn không dùng được ứng dụng này và cần báo Logistic Lead để được giao việc theo cách khác.`,
    items: [
      `Mục đích. Tôi đồng ý để ${company} thu thập và xử lý dữ liệu cá nhân của tôi nêu ở các mục dưới, chỉ nhằm: điều phối và theo dõi công việc giao nhận thẻ nhớ, thiết bị; xác nhận việc bàn giao với BO; tính quãng đường và hiệu suất công việc; bảo đảm an toàn cho nhân viên và tài sản.`,
      'Vị trí (dữ liệu nhạy cảm). Tôi hiểu vị trí của tôi là dữ liệu cá nhân nhạy cảm. Ứng dụng chỉ ghi vị trí từ lúc tôi bấm “Bắt đầu ca” đến lúc tôi bấm “Kết thúc ca” (hoặc khi ca tự đóng vì mất tín hiệu quá lâu). Ngoài ca, ứng dụng không ghi vị trí của tôi.',
      'Ảnh và thông tin giao nhận. Tôi đồng ý cho lưu ảnh tôi chụp khi giao nhận (kèm thời gian và toạ độ nơi chụp), số lượng thẻ, thiết bị và ghi chú tôi nhập. Tôi sẽ không chụp khuôn mặt hay giấy tờ cá nhân của người khác khi không cần cho việc bàn giao.',
      'Thông tin tài khoản và thiết bị. Tôi đồng ý cho lưu họ tên, số điện thoại, biển số xe, mức pin điện thoại, loại trình duyệt và địa chỉ IP khi tôi đăng nhập hoặc bấm đồng ý.',
      'Ai được xem. Chỉ Logistic Lead, nhân viên Logistic được phân quyền và người quản trị hệ thống xem được vị trí, lộ trình và thống kê của tôi. BO (qua đường link do Logistic gửi cho riêng từng lượt giao nhận) chỉ thấy tên, số điện thoại, biển số xe của tôi, vị trí của tôi trên bản đồ TRONG LÚC tôi đang làm task có điểm của họ cho tới khi giao nhận xong tại điểm đó, và thông tin bàn giao tại điểm đó. Dữ liệu không được cung cấp cho bên khác, trừ khi pháp luật yêu cầu.',
      `Thời gian lưu. Lịch sử vị trí được lưu ${keepPos}; ảnh và hồ sơ giao nhận được lưu ${keepPhoto}; hết hạn sẽ bị xoá. Khi tôi nghỉ việc, tài khoản bị khoá và dữ liệu được xoá theo các thời hạn trên, trừ phần pháp luật buộc phải lưu lâu hơn.`,
      `Quyền của tôi. Tôi có quyền được biết, xem, yêu cầu sửa, yêu cầu xoá, yêu cầu hạn chế xử lý dữ liệu của mình và khiếu nại. Tôi có thể rút lại sự đồng ý bất cứ lúc nào tại mục “Tài khoản” trong ứng dụng: khi rút, ứng dụng ngừng ghi vị trí ngay và tôi không nhận task qua ứng dụng cho đến khi đồng ý lại; việc rút không ảnh hưởng tới dữ liệu đã xử lý hợp pháp trước đó.${contact}`,
      'Tự nguyện. Tôi đã đọc, hiểu các mục trên và tự nguyện đồng ý. Tôi chỉ dùng tài khoản của chính mình và không đưa tài khoản cho người khác dùng.',
    ],
  };
}
