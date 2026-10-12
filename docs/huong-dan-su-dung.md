# Atlas Ops Hub — Hướng dẫn sử dụng theo vai trò

Ops Hub là trang web dùng chung cho Logistics, Tech và Sale; Rider Live là phần bản đồ và ứng dụng điện thoại của Field Ops.
Mở bằng trình duyệt trên máy tính hoặc điện thoại, không cần cài app. Mỗi người chỉ thấy các mục của vai mình.

Nguyên tắc chung cho mọi vai:

- **Chỉ xác nhận việc đã làm.** Hệ thống tự đổi trạng thái kit, thẻ, BO và tự sinh việc kế tiếp cho đúng team.
- **Việc tự giao cho người đang trong ca** theo bảng phân ca, ưu tiên người ít việc nhất. Không đăng ký ca thì không được tự giao việc.
- **Số liệu lệch không bị sửa tự động.** Hệ thống đưa vào mục Đối chiếu để Lead của team liên quan xử lý, có ghi chú.
- **Mọi thao tác đều có nhật ký**: ai làm, lúc nào, lý do. Thao tác quan trọng (huỷ, mở lại, sửa số) bắt buộc ghi lý do.
- **Màn hình tự cập nhật** khi team khác thay đổi, không cần tải lại trang. Đang gõ dở thì hệ thống chờ gõ xong mới cập nhật.
- Chuông góc trên là hộp thông báo; bấm một thông báo để mở đúng việc, kit, BO hoặc sự cố.
- Các ngưỡng (5 giờ/ngày, 80% quota, hạn xử lý…) là **đề xuất**; team phụ trách chốt trong mục Cấu hình. Quy tắc chi tiết khi giao nhận lệch, khi hết ca, cách tính số liệu: [quy-tac-van-hanh.md](quy-tac-van-hanh.md).

---

## Logistics

### Logistic Lead
Trang đầu: **Tổng quan vận hành**.

| Việc | Ở đâu |
|---|---|
| Xem điểm nghẽn buổi sáng: việc quá hạn, đang vướng, chưa ai nhận, đối chiếu đang mở | Tổng quan → Điểm nghẽn (bấm từng ô để mở danh sách) |
| Giao việc cho người, giao hàng loạt, tạo việc tay | Bảng việc → chọn dòng → Giao… |
| Gom việc ra đường thành chuyến FO (nhiều việc cùng BO đi chung một lượt) | Điều phối chuyến |
| Theo dõi FO trên bản đồ, cảnh báo trễ hạn, mất tín hiệu | Nút Rider Live ở thanh bên |
| Xếp ca, duyệt đăng ký ca, chép ca tuần trước | Phân ca |
| Sửa chấm công (bắt buộc lý do), xem công tháng | Chấm công |
| Đánh giá nhân sự Logistics và Field Ops, chốt kỳ | Đánh giá nhân sự |
| Tạo tài khoản Logistic Executive và Field Ops, khoá, cấp lại mật khẩu | Tài khoản |
| Chốt các ngưỡng của Logistics | Cấu hình |
| Xử lý mục Đối chiếu của Logistics | Đối chiếu |

### Logistic Executive
Trang đầu: **Việc của tôi** (việc đang giữ, việc chờ nhận của team, việc cần để ý).

1. **Chuẩn bị kit** khi Sale gửi yêu cầu mở BO: Kit & thiết bị → Tạo kit (mỗi loại thiết bị một ô chọn, gợi ý sẵn thiết bị rảnh) → gán kit vào yêu cầu → Gửi Tech kiểm.
2. **Giao, đổi thẻ, thu hồi**: việc ra đường hiện ở Bảng việc; vào Điều phối chuyến chọn FO đang trong ca rồi tạo chuyến. Chuyến xong thì việc tự đóng, kit và thẻ tự về đúng chỗ.
3. **Bàn giao thẻ cho Tech**: Thẻ nhớ & bàn giao → Phiếu bàn giao → tạo từ danh sách gợi ý. Nhận thẻ Tech trả lại cũng ở đây.
4. **Phụ kiện**: Phụ kiện → Nhập thêm / Ghi giảm / Kiểm kê / Tìm lại (bắt buộc lý do). Hệ thống báo khi số rảnh không đủ cho việc giao phụ kiện đang mở.
5. **Kiểm kho định kỳ** (mặc định thứ Sáu): làm việc Kiểm kho, nhập số đếm được; chênh lệch tự vào Đối chiếu.
6. Đăng ký ca ở **Phân ca**; xem điểm của mình ở **Hiệu suất của tôi**.

### Field Ops (điện thoại)
1. Lần đầu đăng nhập: đổi mật khẩu, đọc và đồng ý từng mục điều khoản dữ liệu vị trí. Chưa đồng ý thì không gửi được vị trí.
2. Bấm **Bắt đầu ca**: chỉ trong ca mới ghi vị trí.
3. Nhận chuyến → **Bắt đầu** → tới gần điểm hệ thống tự ghi "đã đến" → chụp ảnh và xác nhận số thẻ, thiết bị giao nhận thực tế.
4. Tại BO cần xác nhận, BO mở link Logistics gửi và xác nhận kèm ảnh; FO đi tiếp sau khi BO xác nhận.
5. Không giao được: chọn lý do; Logistics nhận cảnh báo ngay.
6. Bản đồ trong chuyến vẽ đường đi thật theo đường phố khi hệ thống đã bật tính đường (chặng đã đi tự ẩn, chặng đang đi nét liền, chặng sắp tới nét đứt); nút **Chỉ đường** mở Google Maps ở chế độ xe máy.
7. Mỗi trình duyệt chỉ giữ **một** phiên đăng nhập. Nếu trên cùng điện thoại hay máy tính có người đăng nhập tài khoản khác (ví dụ Logistics thử vai FO rồi quay lại tài khoản của mình), màn hình FO đang mở tự chuyển sang tài khoản mới chứ không gửi được nữa. Muốn thử hai vai cùng lúc trên một máy: mở vai FO bằng cửa sổ ẩn danh hoặc một hồ sơ trình duyệt khác.

---

## Tech

### Tech Lead
Trang đầu: **Tổng quan vận hành**. Ngoài các việc của Tech Executive:

| Việc | Ở đâu |
|---|---|
| Phân việc, theo dõi việc quá hạn của Tech | Bảng việc |
| Đánh giá nhân sự Tech, chốt kỳ | Đánh giá nhân sự |
| Xếp ca, duyệt ca, chấm công team Tech | Phân ca, Chấm công |
| Quản lý tài khoản (Tech Lead kiêm quản trị hệ thống) | Tài khoản |
| Chốt các ngưỡng của Tech: dung lượng 1 giờ ghi hình, bộ nhãn lỗi, kiểm kit trước khi xuất | Cấu hình |
| Nhập dữ liệu từ Excel (chạy thử trước, rồi mới ghi thật) | Nhập dữ liệu |

### Tech Executive
Trang đầu: **Việc của tôi**.

1. **Kiểm kit trước khi xuất**: mở việc → kiểm từng thiết bị → Đạt hoặc Không đạt (kèm lý do). Kit chỉ được xuất sau khi đạt.
2. **Nhận thẻ**: Thẻ nhớ & bàn giao → phiếu Logistics gửi → quét hoặc gõ mã từng thẻ; thiếu thẻ phải ghi lý do.
3. **Nhập dung lượng**: Nhập dung lượng → gõ GB từng thẻ (Enter xuống dòng, Ctrl+Enter lưu). Hệ thống tự đổi ra giờ quay; thẻ 0 GB bắt buộc lý do và tự báo Sale. Số giờ này là nguồn duy nhất cho dashboard của Sale.
4. **Sự cố**: Sự cố thiết bị → Nhận xử lý → Báo đã xử lý (sửa tại chỗ, đổi thiết bị, đổi cả kit). Đổi kit thì hệ thống tự sinh việc cho Logistics.
5. **Sửa kit hỏng, check-in kit thu hồi**: làm theo việc trong Việc của tôi; xong thì Logistics tự có việc nhận lại kit.

---

## Sale

### Head of Sale
Trang đầu: **Tổng quan vận hành** (tình hình chung) và **Dashboard Kinh doanh**.

- BO onboard theo tháng và theo từng Sale Lead, BO chờ active, BO đang active.
- BO sắp chạm hoặc đã vượt quota giờ quay; BO dưới chuẩn 5 giờ mỗi kit mỗi ngày.
- Giờ ghi hình 12 tuần, WoW và MoM; bảng so sánh các Sale Lead.
- Tạo tài khoản Sale Lead; chốt ngưỡng của Sale trong Cấu hình; xử lý mục Đối chiếu của Sale.

### Sale Lead
Trang đầu: **Dashboard Kinh doanh** (chỉ BO của mình).

1. **Mở BO mới**: BO → Yêu cầu mở BO → ngày launch, số kit, phụ kiện, lịch đổi thẻ. Theo dõi ở Yêu cầu của Sale: mỗi bước ghi rõ đang chờ team nào.
2. **Hỗ trợ BO đang chạy**: mở BO → Yêu cầu hỗ trợ (đổi thiết bị, thêm phụ kiện) hoặc Báo sự cố.
3. **Kết thúc BO**: mở BO → Kết thúc (bắt buộc lý do); Logistics tự có việc thu hồi kit.
4. Sale không thấy vị trí, đường đi hay tên Field Ops; chỉ thấy trạng thái việc theo từng bước.

---

## Quản trị
Thấy mọi mục. Việc riêng: tạo tài khoản Lead đầu tiên, mở lại kỳ hiệu suất đã chốt (bắt buộc lý do; bản đã chốt được giữ lại, Lead của team bấm "Xem bản đã chốt" để so), chỉnh cấu hình của mọi team.

## Câu hỏi thường gặp
- **Không thấy việc mới?** Kiểm tra mình đã đăng ký ca và đang trong giờ ca chưa (Phân ca). Ngoài ca, việc nằm ở hàng chờ của team.
- **Nút bấm báo lỗi đỏ?** Đọc dòng lỗi trong hộp thoại: hệ thống luôn nói lý do và việc cần làm tiếp (ví dụ kit đang trên chuyến FO thì phải gỡ khỏi chuyến trước).
- **Báo "Tài khoản của bạn không có quyền làm việc này" dù đúng vai?** Thường do cùng trình duyệt vừa đăng nhập tài khoản khác ở tab khác (cookie dùng chung): tab cũ sẽ tự mở lại màn hình của tài khoản mới; nếu chưa, tải lại trang. Hai vai cùng lúc trên một máy thì dùng cửa sổ ẩn danh cho vai thứ hai.
- **Số trên dashboard tuần này thấp bất thường?** Tuần đang chạy chưa đủ ngày; thẻ của 2–3 ngày gần nhất có thể chưa được nhập dung lượng.
