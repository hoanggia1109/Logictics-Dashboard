# Atlas Ops Hub — Quy tắc vận hành giữa 3 team

Tài liệu này ghi các quy tắc hệ thống đang áp dụng sau đợt rà soát sâu tương tác giữa Logistics, Tech và Sale. Mỗi quy tắc đều có bài kiểm thử tự động đi kèm (`test/fix.*.test.mjs`). Các con số là **đề xuất**: team phụ trách chốt lại trong mục **Cài đặt**, không cần sửa code.

Ba nguyên tắc chung:

1. **Không tự sửa số liệu.** Khi thực tế ngoài hiện trường khác kế hoạch hoặc khác số trong hệ thống, hệ thống chỉ ghi phần đã được xác nhận, phần lệch đưa vào **Đối chiếu** cho đúng team và báo Lead của team đó.
2. **Mỗi số liệu một nguồn.** Giờ quay chỉ lấy từ dung lượng Tech nhập; Tổng quan, trang Sale và Head of Sale cộng cùng một cách nên luôn khớp nhau.
3. **Máy chủ kiểm quyền.** Nút bị ẩn trên màn hình chỉ để gọn; mọi quyền đều được máy chủ kiểm lại.

---

## Chung cho cả 3 team

- **Bấm gửi hai lần** (mất mạng, mở hai tab) trong khoảng gửi lặp thì hệ thống trả lại kết quả lần trước, không ghi thêm. Áp dụng cho yêu cầu mở BO, yêu cầu hỗ trợ, nhập / xuất phụ kiện, tạo việc tay.
- **Thông báo chỉ gửi sau khi lệnh ghi thành công.** Lệnh bị huỷ giữa chừng thì không ai nhận thông báo ảo.
- **BO mới trùng tên** (và địa chỉ, nếu có) với một BO đang chờ launch: hệ thống mở yêu cầu đã có; người gửi xác nhận là BO khác thì mới tạo tiếp.
- **Hạn trong ngày** tính tới hết 23:59:59 giờ Việt Nam.

## Logistics (Logistic Lead, Logistic Executive, Field Ops)

**Chuyến FO và giao nhận**

- Khi FO đóng một điểm, hệ thống so số kit / thẻ FO báo và số BO xác nhận với kế hoạch của điểm đó. Khớp thì ghi như kế hoạch. **Lệch** thì không chuyển kit, thẻ nào chưa được xác nhận: việc của điểm đó được giữ lại, một mục Đối chiếu mức cao ghi rõ kế hoạch / FO / BO, Logistic Lead được báo. Chỉ Lead hoàn tất việc bị giữ, bằng mã kit / thẻ thật; xong hết thì mục Đối chiếu tự đóng.
- Kit, thẻ đang nằm trong một mục Đối chiếu chưa xử lý thì không xếp được vào việc hay chuyến khác.
- Một kit hoặc một thẻ không thể nằm trong hai chuyến đang mở.
- Việc đã lên chuyến FO **đang chạy** thì không huỷ được từ Ops Hub (kể cả qua huỷ yêu cầu hỗ trợ): FO báo điểm "Không giao được" hoặc Logistic Lead huỷ chuyến trước. Chuyến chưa chạy thì gỡ việc như bình thường; điểm không còn việc bị bỏ khỏi chuyến, chuyến không còn điểm thì tự huỷ. Trên chuyến đang chạy, điểm hết việc chuyển "Bỏ qua" và không tính là thất bại cho FO.
- **Đổi thẻ qua chuyến phải có mã thẻ** đưa vào BO. Đổi thẻ làm tay chỉ nhận thẻ đang ở đúng BO đó; trang đã cũ thì máy chủ báo tải lại.
- **Giao launch ghi luôn mã thẻ nằm trong kit**, để lượt đổi thẻ đầu tiên thu đúng thẻ. Thiếu mã thì vẫn giao, nhưng có mục Đối chiếu.
- Phụ kiện FO mang đi giao bổ sung được **giữ chỗ** từ lúc chuyến chạy (cột "FO đang mang" trong kho phụ kiện), không còn tính là phụ kiện rảnh.

**Kho**

- Đổi kit hỏng làm tay: kit thay phải **cùng loại** và đang **sẵn sàng tại văn phòng**; phụ kiện của kit hỏng được đếm ngay lúc đổi, thiếu thì vào Đối chiếu.
- Lead chỉnh một kit đang ở ngoài (tại BO): thiết bị, phụ kiện bị bỏ ra **không quay về kho rảnh** mà thành thất lạc và vào Đối chiếu, trừ khi Lead ghi giảm có lý do.
- Thu hồi kit mà phụ kiện dư so với sổ: vẫn ghi "tìm lại" nhưng có mục Đối chiếu.
- Giao thiếu phụ kiện so với yêu cầu: yêu cầu **vẫn mở** cho phần còn thiếu, có việc giao bổ sung mới, Sale được báo đã giao bao nhiêu và còn bao nhiêu.
- Mã thiết bị không được trùng mã thẻ nhớ.
- Việc **Chuẩn bị kit** có ít nhất số giờ chuẩn bị tối thiểu; launch gấp hơn thì việc được đánh dấu **gấp** chứ không vừa tạo đã trễ hạn. Yêu cầu tăng số kit sau khi đã sẵn sàng thì Logistics có việc chuẩn bị phần thiếu.
- Việc đổi thẻ / kiểm kho mà Lead đã huỷ thì không bị tạo lại trong cùng ngày.

## Tech (Tech Lead, Tech Executive)

- **Sự cố:** chỉ người đang giữ việc xử lý sự cố hoặc Tech Lead nhận và báo kết quả. Bấm "Bắt đầu" / "Nhận việc" trên bảng việc cũng tính là đã nhận sự cố. Sự cố chưa gắn kit có thể bấm **Gắn kit** sau.
- Đóng một sự cố cũ bằng "Đổi máy" / "Mang về sửa" mà kit **đã rời BO của sự cố**: hệ thống không đụng vào kit ở chỗ mới, sự cố đóng và Tech Lead nhận mục Đối chiếu để xem lại.
- Sale huỷ yêu cầu "Đổi máy hư": việc đổi kit được huỷ và cờ lỗi do chính yêu cầu đó đặt cho kit được gỡ. Việc đã xếp vào chuyến chưa chạy, hoặc kit còn lỗi khác, thì việc được giữ và Logistics nhận mục Đối chiếu; chuyến đã chạy thì không huỷ được.
- **Top 10 lỗi** gom theo nhãn lỗi (chia theo dòng máy bên trong). Sự cố đóng là "Không phải sự cố" không tính vào Top 10 lỗi thiết bị và không gây cờ tăng vọt; số này hiện riêng.
- **Thẻ nhớ:** nhận phiếu chỉ nhận dòng thuộc phiếu đó. Thẻ không rõ BO thì Tech chọn BO và ngày quay lúc nhập, không đoán. Sửa bản ghi dung lượng theo đúng quy tắc như lúc nhập (giới hạn ngày, ảnh, lý do 0 giờ, kỳ đã chốt). Dung lượng quá nhỏ làm tròn thành 0 giờ thì phải ghi lý do.
- **Trả thẻ về Logistics:** phiếu đã nhập hết thì Tech có việc trả thẻ; thẻ đã nhập nằm ở Tech quá lâu hiện trong Điểm nghẽn. Thẻ bị đánh dấu mất / hỏng thì Sale chủ BO được báo khoảng giờ quay có thể thiếu, Tech có mục Đối chiếu.

## Sale (Head of Sale, Sale Lead)

- **Không bao giờ thấy vị trí hay tên của Field Ops.** Ở mọi chỗ Sale xem (sự cố, yêu cầu, nhật ký, Điểm nghẽn), người làm là FO chỉ hiện chữ "FO".
- **Quyền theo chủ BO:** quota giờ quay và Sale phụ trách do Sale chốt (đổi người phụ trách chỉ Head of Sale). Logistics sửa thông tin hiện trường (địa chỉ, toạ độ, liên hệ, khung giờ đổi thẻ). Ngày launch chỉ đổi qua yêu cầu; kết thúc chỉ qua nút Kết thúc. Khi BO đổi Sale phụ trách, mọi yêu cầu của BO theo chủ mới.
- Bật "Sale Lead xem mọi BO" chỉ cho **xem**; sửa, huỷ, kết thúc vẫn chỉ chủ BO, Head of Sale hoặc Quản trị.
- **Hẹn ngày kết thúc trong tương lai:** BO vẫn ghi hình, vẫn đổi thẻ và vẫn được hỗ trợ tới ngày đó. Chủ BO, Head of Sale hoặc Quản trị huỷ được lịch kết thúc khi việc thu hồi chưa xong và chưa lên chuyến đang chạy.
- **Tạm nghỉ:** ghi cả hai ngày hoặc để trống cả hai; ngày bắt đầu không sau ngày kết thúc; Sale không ghi lùi ngày (Lead, Head of Sale ghi lùi được kèm lý do). Xoá hoặc rút ngắn khoảng tạm nghỉ thì BO ghi hình lại ngay.
- **Thêm kit cho BO đang chạy:** yêu cầu hỗ trợ "Thêm kit", đi đủ bước chuẩn bị, kiểm, giao như launch.
- Huỷ yêu cầu mở lại BO đã kết thúc thì BO trở về "Đã kết thúc".

**Cách tính trên dashboard Sale và Head of Sale**

- **Đã onboard** = BO đã ký: tính từ yêu cầu launch đầu tiên không bị huỷ, ghi cho Sale Lead gửi yêu cầu đó và tháng đó; đổi Sale phụ trách sau này không đổi số đã ghi. **Chờ active** = đã onboard, chưa giao kit. **Đang active** = đã giao kit đầu tiên. Số onboard của tháng đi theo kỳ đang xem.
- **Giờ quay mỗi kit mỗi ngày:** giờ của một thẻ được chia đều cho những ngày thẻ đó nằm trong máy (từ lúc đặt tới lúc thu), trừ ngày tạm nghỉ. Chỉ xét những ngày **đã đủ dữ liệu** (đã có thẻ được nhập phủ ngày đó); ngày chưa có thẻ về là "chưa đủ dữ liệu", không tính là 0 giờ. Số kit mỗi ngày lấy theo lịch sử giao / thu hồi thật, không theo số kit hiện tại.
- BO mở lại sau khi kết thúc có các giai đoạn hoạt động riêng; tuần đã kết thúc không tính là ngày ghi hình. **Quota tính từ lần launch gần nhất.**
- Quota "sắp chạm" / "vượt" chỉ xét BO đang chạy, tạm nghỉ hoặc đang thu hồi, và dùng cùng một cách tính với danh sách Điểm nghẽn.
- Tổng giờ cộng số chưa làm tròn rồi mới làm tròn một lần. Phân bố giờ / kit / ngày chia theo chuẩn giờ quay, các nhóm không chồng nhau.
- **WoW / MoM so cùng kỳ:** tuần / tháng đang chạy so với cùng số ngày của kỳ trước, không so với cả kỳ trước.

## Lead và đánh giá nhân sự

- **Mỗi team một bộ cài đặt riêng** cho ca làm, giao việc và đánh giá (ca mẫu, giờ tính trễ / vắng, tự giao việc, mức báo Lead, số công tối thiểu, trọng số, ngưỡng xếp loại). Tech Lead chỉ sửa phần Tech, Logistic Lead chỉ sửa phần Logistics; Field Ops theo phần Logistics.
- **Chỉ giao việc cho người có ca đã duyệt trên bảng phân ca.** Không có ca thì không vào ca và không được tự giao việc, kể cả khi mở ứng dụng. Lead vẫn ghi công tay khi có người làm ngoài ca.
- **Hết ca** (sau thời gian ân hạn) hoặc không có ca hôm nay: việc chưa bắt đầu tự trả về cho cả đội và giao cho người đang trong ca. Việc đang làm, đang vướng hoặc đang trên chuyến FO thì giữ, Lead được báo. Việc Lead giao tay cho người đã hết ca thì giữ tới lần hết ca kế tiếp.
- **Chia đều việc tồn:** đầu ca mỗi người nhận tối đa phần công bằng theo tải; người vào ca sau nhận bớt việc hệ thống đã giao cho người đang tải nhiều nhất. Việc Lead giao tay, việc ai tự nhận, việc đang làm thì không bị chuyển.
- **Hạn riêng của người nhận sau:** SLA của team vẫn tính theo hạn gốc của việc. Đúng hạn của từng người tính theo hạn riêng = muộn hơn giữa hạn gốc và lúc được giao + thời gian xử lý của loại việc, nên người nhận lại việc đã trễ không bị tính trễ phần thời gian trước khi mình nhận. Tự trả rồi nhận lại thì vẫn giữ hạn cũ.
- Khoá hoặc đổi vai một tài khoản thì việc người đó đang giữ trả về cho cả đội. Việc của hub chỉ giao được cho thành viên hoặc Lead của đúng team.
- **Điểm:** chất lượng chỉ trừ khi bản ghi dung lượng của mình bị người khác sửa lại (FO huỷ chuyến hay điểm thất bại không tính là làm lại cho người hoàn tất việc). Điểm nhập thẻ giữ phút chuẩn lúc nhập. Việc nhập dung lượng tính cho người nhập thẻ cuối. Cả team chưa có khối lượng thì không ai được xếp "Xuất sắc". Lead không có điểm tổng hợp. Tắt xếp loại Logistics thì Field Ops cũng không xếp loại.
- **Chuyên cần** chỉ tính trên những ngày có ca: ngày nghỉ phép không trừ hai lần; làm ngoài ca không bù cho ca vắng; ca chưa tới không tính là vắng.
- **Bảo mật số liệu từng người:** nhân viên chỉ thấy số của mình; các số trung bình của team chỉ hiện khi đủ người góp để không suy ra được số của một đồng nghiệp. Lead team này không xem được chấm công, bảng ca, bảng điểm, nhật ký việc theo từng người của team kia. Mở lại kỳ đã chốt cần lý do, bản đã chốt được giữ để Lead của team xem lại.
- Lead không tự sửa chấm công hay tự duyệt giờ làm thêm của chính mình (cần Quản trị). Sao chép lịch tuần không chép ngày nghỉ phép.

---

## Các ngưỡng mới (đề xuất)

| Cài đặt | Mặc định đề xuất | Team chốt |
|---|---|---|
| Thời gian chuẩn bị kit tối thiểu | 4 giờ | Logistics |
| Báo yêu cầu launch chưa sẵn sàng khi còn | 2 ngày | Logistics |
| Báo thẻ nằm ở BO quá | 3 ngày (không dưới chu kỳ đổi thẻ của BO + 1 ngày) | Logistics |
| Báo thẻ đã thu về chưa gửi Tech sau | 12 giờ | Logistics |
| Báo khi thẻ sẵn sàng tại văn phòng dưới | 10 thẻ (0 = tắt) | Logistics |
| Báo sự cố chưa có Tech nhận sau | 60 phút | Tech |
| Báo sự cố mở quá | 24 giờ | Tech |
| Người báo tự huỷ sự cố trong | 30 phút | Tech |
| Báo thẻ Tech đã nhận chưa nhập dung lượng sau | 24 giờ | Tech |
| Báo thẻ đã nhập chưa trả Logistics quá | 24 giờ | Tech |
| Ngày quay nhập được trong | 60 ngày gần đây | Tech |
| Người nhập tự sửa bản ghi dung lượng trong | 48 giờ | Tech |
| Trả việc chưa bắt đầu về cho cả đội sau khi hết ca | 30 phút | Lead của từng team |
| Coi là gửi lặp khi gửi lại trong | 10 phút | Quản trị |

Các ngưỡng đã có từ trước vẫn giữ: chuẩn giờ quay 5 giờ / kit / ngày và báo sắp chạm quota ở 80% (Sale chốt), bỏ qua 2 ngày gần nhất khi so giờ quay với kỳ trước (Tech chốt), phút chuẩn và hạn xử lý theo loại việc (Lead của từng team chốt).

## Giới hạn còn lại

- Bản ghi dung lượng cũ hoặc nhập từ file mà không biết thẻ nằm trong máy tới ngày nào thì giờ quay chỉ tính vào ngày quay; ngày đó hiện "chưa đủ dữ liệu" thay vì một số bị thổi phồng. Hệ thống tự điền khoảng phủ cho bản ghi cũ khi suy ra được từ lịch sử thẻ.
- Lịch sử kit tại BO trước khi cài bản này chỉ chính xác khi suy ra được từ việc thu hồi / đổi kit; BO đã mở lại trước bản này giữ một giai đoạn hoạt động.
- Mục Đối chiếu cũ dùng mã nhập từ file được đổi sang dạng mới để liên kết đúng thẻ / kit; không sửa dữ liệu nào khác.
