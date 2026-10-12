# Atlas Ops Hub + Rider Live

Một ứng dụng web dùng chung cho ba team vận hành của Atlas Capture Việt Nam:

- **Ops Hub** – nơi Logistics, Tech và Sale nhận việc, làm việc và theo dõi kết quả. Yêu cầu của Sale tự sinh việc cho Logistics và Tech theo đúng thứ tự; kho kit, thiết bị, phụ kiện, thẻ nhớ tự cập nhật theo từng việc; dashboard WoW / MoM cho từng team và từng người.
- **Rider Live** – phần điều phối Field Ops (FO): bản đồ thời gian thực, chuyến nhiều điểm, ảnh giao nhận, BO xác nhận qua link dùng một lần, SLA, cảnh báo.

Tự host hoàn toàn: **1 tiến trình Node.js + 1 file SQLite**, không phụ thuộc dịch vụ trả phí nào. Hướng dẫn thao tác cho từng vai: [docs/huong-dan-su-dung.md](docs/huong-dan-su-dung.md). Quy tắc vận hành giữa 3 team (giao nhận lệch, phân ca, cách tính số liệu, các ngưỡng đề xuất): [docs/quy-tac-van-hanh.md](docs/quy-tac-van-hanh.md).

---

## 1. Vì sao không làm bằng Google Apps Script

| Yêu cầu | Apps Script + Google Sheets | Node.js + SQLite (bản này) |
|---|---|---|
| Bấm gửi không bị khựng | Mỗi lần ghi phải gọi qua máy chủ Google rồi khoá bảng tính, thường mất 1–3 giây; nhiều người bấm cùng lúc thì xếp hàng chờ khoá. Hạn mức Google công bố: tối đa 30 lượt chạy đồng thời mỗi người dùng, 6 phút mỗi lượt. | Mỗi thao tác là một giao dịch SQLite trên cùng máy, đo được vài chục mili giây kể cả lúc 40 người dùng đồng thời (xem mục 10). |
| Ba team thấy thay đổi của nhau ngay | Không có kênh đẩy; phải tải lại trang hoặc hỏi định kỳ. | WebSocket: màn hình của team khác tự cập nhật sau khoảng 150 ms. |
| Bảo mật giữa 3 team, Sale không thấy vị trí FO | Người có quyền mở file là thấy mọi tab; ẩn tab không phải là phân quyền. | Máy chủ kiểm vai trò ở từng API và lọc dữ liệu trước khi gửi; có bộ kiểm thử dò mọi API với mọi vai. |
| Theo dõi FO theo thời gian thực | Không làm được (không có WebSocket, không nhận GPS liên tục). | Có sẵn (Rider Live). |
| Số liệu không lệch giữa các bảng | Nhiều bảng tính sửa tay, công thức chép qua lại. | Mỗi chỉ số có một nguồn duy nhất; mỗi thao tác ghi đồng thời dữ liệu và nhật ký trong cùng một giao dịch. |

Đổi lại, cần một máy chủ nhỏ (1 vCPU / 1 GB RAM là đủ) và một tên miền có HTTPS, xem mục 8.

---

## 2. Chạy thử trong 2 phút

Cần Node.js **22.13 trở lên**.

```bash
npm install
npm run demo          # mở http://localhost:8080
```

(Windows: `set DEMO=1 && npm start` trong cmd, hoặc `$env:DEMO=1; npm start` trong PowerShell.)

Chế độ demo tạo **9 tuần dữ liệu mẫu** đi qua đúng API thật: khoảng 36 BO, 61 kit, hơn 1.000 lượt nhập thẻ, sự cố, phân ca, chấm công, cùng 7 FO giả tự chạy chuyến. Mật khẩu chung `demo1234`:

| Tên đăng nhập | Vai trò | Trang đầu |
|---|---|---|
| `admin` | Quản trị | Tổng quan vận hành, thấy mọi mục |
| `lead` | Logistic Lead | Tổng quan vận hành |
| `log`, `log2`, `log3` | Logistic Executive | Việc của tôi |
| `fo` (và `fo1`…`fo7` chạy tự động) | Field Ops | Ứng dụng điện thoại của FO |
| `techlead` | Tech Lead | Tổng quan vận hành |
| `tech`, `tech2`, `tech3` | Tech Executive | Việc của tôi |
| `salehead` | Head of Sale | Dashboard Kinh doanh |
| `sale`, `sale2`, `sale3` | Sale Lead | Dashboard Kinh doanh (chỉ BO của mình) |

Bản xem thử một-file (không cần máy chủ): `npm run build:preview` → mở `preview/atlas-ops-hub-demo.html`. Bản này chạy đúng lõi nghiệp vụ của máy chủ ngay trong trình duyệt (dữ liệu mẫu nhỏ hơn); GPS của FO là giả lập và nền bản đồ là ô lưới.

---

## 3. Vai trò: ai thấy gì

Mỗi người chỉ thấy nút của vai mình; máy chủ kiểm lại quyền ở từng API, nên gõ thẳng địa chỉ cũng không vào được mục không thuộc vai.

| Team | Vai | Thấy | Không thấy |
|---|---|---|---|
| Logistics | Logistic Lead | Mọi việc của Logistics, điều phối chuyến, Rider Live, kho, phân ca, chấm công, đánh giá nhân sự Logistics và FO, tài khoản Logistics/FO | Điểm hiệu suất của Tech |
| | Logistic Executive | Việc của mình và hàng chờ của team, kho, thẻ, điều phối chuyến, hiệu suất của chính mình | Điểm của người khác |
| | Field Ops | Chuyến của mình trên điện thoại | Mọi màn hình Ops Hub |
| Tech | Tech Lead | Mọi việc của Tech, sự cố, nhập dung lượng, cấu hình của Tech, đánh giá nhân sự Tech, nhập dữ liệu | Điểm hiệu suất của Logistics |
| | Tech Executive | Việc của mình và hàng chờ của team, kiểm kit, thẻ, sự cố, hiệu suất của chính mình | Điểm của người khác |
| Sale | Head of Sale | Dashboard Kinh doanh toàn bộ BO, tổng quan vận hành, tài khoản Sale Lead | Vị trí, đường đi, tên FO |
| | Sale Lead | BO của mình, yêu cầu mở BO / hỗ trợ / kết thúc, sự cố của BO mình | BO của Sale khác, vị trí FO, hiệu suất nhân sự |

Quản trị (Tech Lead có thể kiêm) tạo tài khoản Lead đầu tiên; mỗi Lead tự tạo tài khoản cho team mình.

---

## 4. Luồng việc tự động giữa 3 team

Mọi việc dưới đây do hệ thống tự sinh khi bước trước xong; người làm chỉ xác nhận việc đã làm. Việc mới tự giao cho **người đang trong ca** theo bảng phân ca, ưu tiên người ít việc nhất (tính theo phút chuẩn); không ai trong ca thì việc nằm ở hàng chờ của team.

**Mở BO mới**
Sale gửi yêu cầu → *Chuẩn bị kit* (Logistics) → *Kiểm kit trước khi xuất* (Tech; không đạt thì kit quay về Logistics kèm lý do) → *Giao và setup tại BO* (Logistics gom thành chuyến FO trên Rider Live) → FO giao, BO xác nhận qua link → BO chuyển **Đang ghi hình**.
Việc *Chuẩn bị kit* có hạn trước 0 giờ ngày launch (tối đa 24 giờ) nhưng không ngắn hơn thời gian chuẩn bị tối thiểu (đề xuất 4 giờ, Logistics chốt); launch gấp hơn mức này thì việc được đánh dấu **gấp** thay vì vừa tạo đã quá hạn. BO mới trùng tên (và địa chỉ, nếu có) với một BO đang chờ launch thì hệ thống mở ra yêu cầu đã có; người gửi xác nhận là BO khác thì mới tạo tiếp.

**Trong lúc BO ghi hình**
*Đổi thẻ tại BO* tự tạo trước theo lịch đổi thẻ → thẻ về văn phòng → Logistics lập phiếu bàn giao → *Nhận thẻ* (Tech) → *Nhập dung lượng* (Tech nhập GB, hệ thống đổi ra giờ quay) → *Nhận lại thẻ* (Logistics). Giờ quay này là **nguồn duy nhất** cho dashboard của Sale.

**Sự cố**
Sale báo sự cố → *Xử lý sự cố* (Tech) → chọn cách xử lý: tại chỗ, đổi máy, mang về sửa. Đổi máy thì tự sinh *Đổi kit hỏng tại BO* cho Logistics; kit hỏng về thì tự sinh *Sửa kit hỏng* cho Tech rồi *Nhận lại kit* cho Logistics.

**Kết thúc BO**
Sale bấm kết thúc (bắt buộc lý do) → *Thu hồi kit* (Logistics) → *Nhận kit thu hồi về kho* → *Check-in kit thu hồi* (Tech) → *Nhận lại kit từ Tech* (Logistics) → kit sẵn sàng cho BO khác.

**Kho và đối chiếu**
Trạng thái kit, thiết bị, thẻ, phụ kiện đổi theo từng việc trong cùng một giao dịch, không ai phải sửa tay. *Kiểm kho định kỳ* tự tạo mỗi tuần. Số liệu lệch (kiểm kho, giao nhận thiếu, thẻ 0 giờ) **không bị sửa tự động** mà vào mục **Đối chiếu** để Lead xử lý, có ghi chú. Bấm gửi lại cùng một hộp thoại (mất mạng, mở hai tab) trong khoảng gửi lặp (đề xuất 10 phút) thì hệ thống trả lại kết quả lần trước, không ghi hai lần.

**Chống tắc nghẽn**
Báo Lead khi việc chưa ai nhận quá lâu trong khi team có người trong ca, khi việc quá hạn, khi một người ôm quá nhiều việc. Người vắng ca thì việc chưa bắt đầu tự trả về cho người khác trong ca. Lead giao lại, giao hàng loạt hoặc tạo việc tay được ở Bảng việc.

Các ngưỡng (phút chuẩn, hạn xử lý, giờ báo Lead…) đều là **đề xuất**, team phụ trách chốt trong mục Cấu hình mà không phải sửa code.

---

## 5. Dashboard

| Màn hình | Ai xem | Nội dung chính |
|---|---|---|
| Tổng quan vận hành | Quản trị, các Lead, Head of Sale | Điểm nghẽn (quá hạn, đang vướng, chưa ai nhận, đối chiếu mở), giờ ghi hình theo tuần, đúng hạn theo team, khối lượng công việc, đội kit theo trạng thái, top 10 lỗi thiết bị, BO nhiều sự cố, giờ ghi hình theo Sale Lead, top 3 FO. Mỗi chỉ số có WoW và MoM. |
| Dashboard Kinh doanh | Head of Sale (mọi BO), Sale Lead (BO của mình) | Phễu BO (chờ launch → đang ghi hình → kết thúc), BO onboard theo tháng và theo Sale Lead, giờ ghi hình 12 tuần, BO sắp chạm hoặc vượt quota giờ quay, BO dưới chuẩn 5 giờ/kit/ngày, phân bố giờ quay, thẻ 0 giờ, sự cố đang mở theo BO, bảng so sánh Sale Lead. |
| Đánh giá nhân sự | Chỉ Lead của team đó (và Quản trị) | Điểm tổng hợp từng người theo tuần / tháng với WoW, MoM; cơ cấu công việc, tỉ trọng việc trong team, top 3 theo hiệu quả trong SLA; chốt kỳ. |
| Hiệu suất của tôi | Từng nhân viên | Điểm của chính mình, thành phần điểm, so với trung bình team (trung bình không gồm chính mình, chỉ hiện khi có từ 2 người khác cùng có số liệu; ít hơn thì cả điểm khối lượng, điểm tổng hợp và mức cũng ẩn để không lộ số của ai). |
| Sự cố | Tech, Logistics, Sale (Sale chỉ BO của mình) | Top 10 lỗi với WoW / MoM, lỗi tăng vọt, BO nhiều sự cố. |

**Cách tính điểm nhân sự** (đề xuất, mỗi Lead chốt phần của team mình): điểm khối lượng = phút chuẩn ÷ 6 (thẻ đã nhập giữ phút chuẩn lúc nhập); điểm tổng hợp = khối lượng 50% + đúng hạn 30% + chất lượng 10% (thẻ bị người khác sửa lại) + chuyên cần 10% (đi đủ ca đã xếp, trừ ngày nghỉ phép; làm ngoài ca không bù ca vắng); xếp loại 5 mức theo ngưỡng 90 / 80 / 65 / 50. Ngày công lấy từ chấm công theo bảng phân ca; dưới 3 công / tuần hoặc 5 công / tháng thì không xếp loại. Lead không xếp loại và không có điểm tổng hợp. Top 3 chỉ gồm người có khối lượng trong kỳ. Trọng số, ngưỡng, số công tối thiểu, ca mẫu, giờ tính trễ / vắng, tự giao việc và các mức báo Lead là giá trị riêng của Tech và của Logistics (Field Ops theo phần của Logistics).

---

## 6. Rider Live (điều phối Field Ops)

### Bản đồ thời gian thực dùng gì

| Thành phần | Dùng gì | Ghi chú |
|---|---|---|
| Thư viện bản đồ | **Leaflet** | Mã nguồn mở, nhúng sẵn trong `public/vendor`. |
| Ảnh nền đường phố | **Google Maps chính thức** (Map Tiles API) khi có `GOOGLE_MAPS_TILES_KEY`; chưa có khoá thì dùng `TILE_URL` | Nền chính thức có nhãn tiếng Việt, biên giới theo góc nhìn Việt Nam, logo Google và dòng bản quyền theo khung nhìn như Google yêu cầu; 100.000 ô miễn phí mỗi tháng, cách lấy khoá và hạn mức ghi trong `.env.example`. `TILE_URL` mặc định trỏ tới địa chỉ ô bản đồ của Google không có giấy phép, chỉ hợp để thử; OpenStreetMap công cộng chỉ hợp dùng nội bộ lưu lượng thấp. |
| Đường đi thực tế | **Google Routes API** (xe máy, có kẹt xe) hoặc **OSRM** tự dựng (miễn phí, không có giao thông), tuỳ `ROUTING_PROVIDER` | Máy chủ tính đường theo đường phố cho từng chuyến rồi vẽ lên bản đồ của Logistics, app FO và link BO; SLA tính theo thời gian chạy xe thật. Chỉ gửi toạ độ điểm giao nhận, không bao giờ gửi GPS của FO. Đường của Google chỉ được vẽ trên nền Google và chỉ lưu tạm 30 ngày; đường xe máy của Google đang thử nghiệm nên luôn kèm dòng lưu ý. Không cấu hình thì mọi thứ chạy như cũ (ước tính đường chim bay). |
| Vị trí FO | GPS của điện thoại FO (trình duyệt), gửi qua **WebSocket** về máy chủ của mình | Đang chạy: tối đa 1 điểm / 3 giây; đứng yên: 15 giây / lần. Mất mạng thì lưu tạm trên máy và gửi bù. |
| Chỉ đường cho FO | Mở **Google Maps** trên điện thoại bằng đường link (chế độ xe máy) | Không dùng Google Maps API nên không tốn phí. |

Toạ độ của FO chỉ đi từ điện thoại FO về máy chủ của công ty; Sale không bao giờ nhận được toạ độ, đường đi hay tên FO.

Một trình duyệt chỉ giữ được **một** phiên đăng nhập (cookie dùng chung cho mọi tab). Đăng nhập tài khoản khác ở tab thứ hai thì các tab đang mở tự chuyển sang màn hình của tài khoản mới; muốn vừa làm Logistics vừa thử vai FO trên cùng một máy thì mở vai FO bằng cửa sổ ẩn danh hoặc một hồ sơ trình duyệt khác.

### Chuyến
- Một chuyến tối đa 15 điểm; mỗi điểm có số thẻ, thiết bị giao / thu theo kế hoạch và ghi chú cho FO. Việc ra đường của Ops Hub (giao, đổi thẻ, thu hồi, giao phụ kiện) được gom vào chuyến ở màn **Điều phối chuyến**; chuyến xong thì việc tự đóng, kit và thẻ tự về đúng chỗ.
- Chuyến hai chiều, gợi ý FO theo khoảng cách và số chuyến đang mở, sắp thứ tự điểm cho quãng đường ngắn nhất, giao lại, FO từ chối (kèm lý do), huỷ; mọi thao tác ghi nhật ký. Mỗi FO chạy một chuyến tại một thời điểm.
- Tuyến định kỳ: khai báo một lần, đầu mỗi ngày tự sinh chuyến (không sinh trùng).

### Link dùng một lần cho BO
- Logistics bấm **Tạo link cho BO** ở từng điểm BO; link chỉ hiện một lần (máy chủ chỉ lưu bản băm), chỉ chạy trên thiết bị đầu tiên mở nó, xác nhận được một lần, tự hết hạn sau 48 giờ (`BO_LINK_HOURS`).
- BO thấy vị trí FO chỉ trong lúc FO đang làm đúng chuyến đó và chưa giao nhận xong tại điểm của BO; không thấy các điểm khác của tuyến.
- **FO chỉ đi tiếp được khi BO đã xác nhận** (kèm ảnh). Số BO nhập khác số FO báo thì vẫn tính là đã xác nhận nhưng vào cảnh báo "lệch số lượng". BO chưa xác nhận sau 5 phút (`BO_REMIND_MIN`) thì báo khẩn; Logistics bấm **Cho qua** (bắt buộc lý do) khi BO thật sự không xác nhận được. Tắt hẳn bước này: `BO_CONFIRM=0`.

### SLA tự điều chỉnh
- Có đường đi thực tế: SLA gốc = thời gian chạy xe theo đường thật (từng chặng nhân hệ số học được theo giờ cao điểm / thấp điểm) + thời gian dừng điển hình ở từng điểm (học từ lịch sử của chính điểm đó; chưa đủ dữ liệu thì 6 phút, điểm BO phải xác nhận 8 phút) + dự phòng theo độ bất định của chuyến, nhắm tới 85% chuyến kịp hạn (`SLA_TARGET_PCT`), làm tròn lên 5 phút. Mức dự phòng tự hiệu chỉnh khi đã có 100 chuyến chạy theo đường thật; Lead xem các hệ số đã học ở `/api/stats/sla`.
- Chưa có đường thật (tắt, đang tính, lỗi, hết lượt gọi): SLA gốc = quãng chim bay × 1,35 ÷ 22 km/h + 6 phút mỗi điểm + 10 phút dự phòng, làm tròn 5 phút (biến `SLA_*`).
- Hạn = giờ bắt đầu + SLA gốc × hệ số thời tiết (1 · 1,2 · 1,4 · 1,6) × hệ số giao thông (1 · 1,25 · 1,5), tối đa ×2. Giao thông tự theo giờ cao điểm hoặc chỉnh tay; thời tiết chỉnh tay hoặc tự động (`WEATHER_AUTO`, có lưu ý giấy phép). Đường của Google đã tính kẹt xe thì không nhân thêm hệ số giờ cao điểm tự động.
- Chuyến đang chạy chỉ được nới hạn, không bị rút lại; máy chủ ước tính giờ xong theo vị trí FO trên đường và báo Logistics khi dự kiến trễ.

### Ảnh, km, cảnh báo
- Ảnh nén ngay trên điện thoại (cạnh dài 1600 px, khoảng 250–450 KB), máy chủ kiểm đúng định dạng JPEG/PNG/WebP, tối đa 4 ảnh/lần, 3 MB/ảnh.
- Km thực tế cộng dồn từ GPS trong ca, bỏ rung khi đứng yên; thống kê theo FO, theo ngày, xuất CSV.
- Cảnh báo tự động (trên màn hình, tuỳ chọn đẩy sang Slack): chưa bắt đầu, sắp trễ, trễ hạn, mất tín hiệu, kết thúc ca giữa chuyến, xác nhận ở xa điểm, số thực tế khác kế hoạch, không giao được, BO chưa có link, BO chậm xác nhận, BO báo lệch, cho qua, FO từ chối, FO báo sự cố, FO rút lại sự đồng ý.

### Gửi vị trí khi tắt màn hình (Traccar Client)
Trang web không gửi được vị trí khi điện thoại tắt màn hình lâu (giới hạn của trình duyệt). Nếu cần chạy nền thật sự: cài app miễn phí **Traccar Client** trên máy FO, nhập địa chỉ `https://<tên-miền>/osmand` và mã thiết bị (Lead xem ở Tài khoản → "Chạy nền" của FO). Máy chủ chỉ nhận vị trí từ Traccar khi FO đã đồng ý điều khoản; ca tự mở khi có điểm đầu tiên và tự đóng sau 10 phút im lặng.

---

## 7. Bảo mật và dữ liệu cá nhân

- **Giữa 3 team**: máy chủ kiểm vai trò ở từng API. Sale không nhận toạ độ, đường đi, tên FO ở bất kỳ API hay tin cập nhật trực tiếp nào (Sale không mở được bảng việc, chuyến hay bản đồ; nhật ký chỉ ghi vai "Field Ops", không ghi tên). Sale Lead chỉ thấy BO của mình. Điểm hiệu suất chỉ Lead của đúng team thấy; nhân viên chỉ thấy điểm của chính mình. `test/hub.security.test.mjs` dò mọi API với mọi vai để giữ các quy tắc này.
- Mật khẩu băm bằng scrypt; phiên đăng nhập là cookie `HttpOnly`, `SameSite=Lax`, thêm `Secure` khi chạy https; máy chủ chỉ lưu bản băm của mã phiên.
- Chặn dò mật khẩu (8 lần sai / tài khoản, 20 lần / IP trong 10 phút), chặn dò mã thiết bị Traccar và mã link BO.
- Chống giả mạo yêu cầu: kiểm `Origin`, chỉ nhận JSON; WebSocket kiểm cookie và `Origin`. Trang có CSP `default-src 'self'`, không nạp mã từ bên ngoài.
- Thao tác quan trọng (huỷ, mở lại, sửa số, cho qua, sửa chấm công, mở lại kỳ đã chốt) bắt buộc ghi lý do; mọi thao tác ghi nhật ký người làm, thời điểm.
- **Dữ liệu cá nhân**: từ 01/01/2026, Luật Bảo vệ dữ liệu cá nhân 2025 và Nghị định 356/2025/NĐ-CP thay cho Nghị định 13/2023; dữ liệu vị trí thuộc nhóm dữ liệu cá nhân **nhạy cảm**. Phần mềm hỗ trợ các việc sau, nhưng **không thay cho tư vấn pháp lý**:
  - Chỉ ghi vị trí trong ca; FO bấm kết thúc ca là dừng.
  - Checklist đồng ý từng mục, lưu vết (thời điểm, IP, thiết bị, nguyên văn bản đã đồng ý); FO rút lại được bất cứ lúc nào; sửa điều khoản thì mọi FO phải đồng ý lại.
  - Tự xoá vị trí sau `RETENTION_DAYS`, ảnh sau `PHOTO_RETENTION_DAYS`.
  - Việc công ty phải tự làm: để pháp chế duyệt nội dung điều khoản, lập hồ sơ đánh giá tác động xử lý dữ liệu nếu thuộc diện phải lập, quy định nội bộ ai được xem.

---

## 8. Triển khai thật

Điện thoại **chỉ cho lấy GPS và mở camera trên địa chỉ https**, nên bắt buộc có tên miền + HTTPS. Bộ `docker-compose.yml` kèm theo dùng Caddy tự xin chứng chỉ.

```bash
cp .env.example .env        # sửa DOMAIN; các mục khác có giải thích ngay trong file
docker compose up -d --build
docker compose logs app | grep "mật khẩu tạm"    # tài khoản Quản trị đầu tiên: admin + mật khẩu tạm
```

Việc cần làm sau khi chạy:
1. Đăng nhập `admin` → đổi mật khẩu → tạo tài khoản Logistic Lead, Tech Lead, Head of Sale. Mỗi Lead tự tạo tài khoản cho team mình.
2. **Nhập dữ liệu** (Tech Lead hoặc Quản trị): tải file Excel hiện có (kit, thiết bị, phụ kiện, BO, thẻ, lịch sử nhập dung lượng) → chạy thử để xem trước → ghi thật. Dòng lỗi được liệt kê, không ghi thiếu một nửa.
3. **Cấu hình**: từng team chốt các ngưỡng của mình (mỗi mục ghi rõ team phụ trách).
4. **Phân ca**: Lead xếp ca tuần đầu; chưa có ca thì việc không tự giao cho ai.
5. **Tài khoản → Điều khoản FO**: đưa nội dung đã được pháp chế duyệt vào (bản mặc định chỉ là bản mẫu kỹ thuật).

**Sao lưu**: máy chủ tự chép toàn bộ dữ liệu mỗi ngày lúc 2 giờ sáng ra `/data/backups/atlas-YYYYMMDD-HHMM.db`, giữ 14 bản (`BACKUP_HOUR`, `BACKUP_KEEP`); lỗi sao lưu thì báo Slack và thử lại sau 30 phút. `/healthz` cho biết bản sao lưu gần nhất. Ảnh giao nhận ở `/data/photos` không nằm trong tệp sao lưu: chép cả thư mục `/data` ra ngoài máy chủ theo lịch riêng.

Không dùng Docker: `npm ci --omit=dev && DATA_DIR=/duong/dan/du-lieu PUBLIC_URL=https://ten-mien node server.js` sau một reverse proxy có HTTPS (đặt `TRUST_PROXY=1`; hệ thống giả định chỉ có **một** proxy đứng trước).

Ước lượng tài nguyên: 1 vCPU / 1 GB RAM đủ cho cả ba team và vài chục FO. Ảnh là phần tốn đĩa nhất (10 FO × 10 điểm × 2 ảnh ≈ 60–90 MB mỗi ngày); chỉnh `PHOTO_RETENTION_DAYS` cho hợp dung lượng đĩa.

### Dùng thử nội bộ trên một máy tính của công ty

Chạy được trên một máy Windows / macOS / Linux đặt tại văn phòng, miễn là máy **bật liên tục, không ngủ** trong giờ làm. Dùng "đường hầm" miễn phí để có https mà không phải mở cổng router:

```bash
cloudflared tunnel --url http://localhost:8080          # ghi lại địa chỉ https://xxxx.trycloudflare.com
npm install
PUBLIC_URL=https://xxxx.trycloudflare.com TRUST_PROXY=1 npm start
#    Windows PowerShell:  $env:PUBLIC_URL="https://xxxx.trycloudflare.com"; $env:TRUST_PROXY="1"; npm start
```

Mật khẩu tạm của `admin` in ra ở cửa sổ chạy ứng dụng (và lưu ở `data/first-login.txt`). Địa chỉ `trycloudflare.com` đổi mỗi lần chạy lại đường hầm và không có cam kết dịch vụ, chỉ hợp để thử; khi có tên miền thì dùng "named tunnel" của Cloudflare hoặc máy chủ thuê.

---

## 9. Giới hạn đã biết

- **Phút chuẩn và hạn xử lý** của từng loại việc là số đề xuất; nên bấm giờ thật 2–4 tuần đầu rồi để Lead chốt lại, vì điểm hiệu suất dựa trên các số này.
- **Giờ quay thô** đến từ dung lượng Tech nhập (GB ÷ GB mỗi giờ). Giờ của mỗi thẻ chia đều cho những ngày thẻ nằm trong máy; ngày chưa có thẻ được nhập là "chưa đủ dữ liệu", không tính là 0 giờ khi xét chuẩn 5 giờ/kit/ngày. Bản ghi cũ hoặc nhập từ file không rõ thẻ nằm tới ngày nào thì chỉ tính vào ngày quay (xem `docs/quy-tac-van-hanh.md`).
- Vị trí nền khi tắt màn hình: xem mục 6 (Traccar Client).
- Chưa cấu hình `ROUTING_PROVIDER` thì SLA và km kế hoạch tính theo đường chim bay × hệ số. OSRM công cộng chỉ để thử và không có dữ liệu kẹt xe; đường Google xe máy đang ở giai đoạn thử nghiệm của Google. Km thực tế đo bằng GPS thường thấp hơn công-tơ-mét 5–15%.
- Link cho BO do Logistics tự gửi (Zalo, SMS…); chưa gửi tự động. BO xác nhận là bước chặn: BO chậm thì FO chậm theo.
- Chưa có thông báo đẩy khi trang đóng; trang đang mở thì hiện ngay.
- Chống gian lận GPS ở mức cơ bản; không phát hiện được app giả lập GPS.
- Một máy chủ, một file SQLite: đủ cho quy mô hiện tại (vài chục người dùng văn phòng, vài chục đến vài trăm FO); chưa chạy nhiều máy chủ song song.

---

## 10. Kiểm thử

```bash
npm test               # toàn bộ kiểm thử lõi, HTTP, bảo mật, dữ liệu mẫu, kiểm thử ngẫu nhiên
npm run test:ui        # giao diện bằng Chromium thật (cần: pip install playwright && playwright install chromium)
npm run test:hubload   # tải Ops Hub: 40 người dùng đồng thời, đo thời gian từng API
npm run test:load      # tải Rider Live: 300 FO gửi vị trí đồng thời
```

| Bộ kiểm thử | Nội dung |
|---|---|
| `test/hub.test.mjs` | Kịch bản đầy đủ của 3 team trên cả kho bộ nhớ lẫn SQLite: mở BO, kiểm kit, giao, đổi thẻ, nhập dung lượng, sự cố, đổi kit, thu hồi, kho, phân ca, tự giao việc, chấm công, hiệu suất, đối chiếu, nhập Excel. |
| `test/hub.security.test.mjs` | Dò mọi API với mọi vai: quyền, phạm vi dữ liệu theo team, Sale không thấy vị trí / tên FO, hiệu suất chỉ Lead của team thấy. |
| `test/hub.fuzz.mjs` | Thao tác ngẫu nhiên của cả 3 team, sau mỗi bước soát bất biến (kit không ở hai nơi, thẻ không mất dấu, số kho khớp sổ, việc không mồ côi). |
| `test/hub.demo.test.mjs` | Sinh 9 tuần dữ liệu mẫu qua API thật, soát số liệu dashboard khớp dữ liệu gốc. |
| `test/core.test.mjs`, `test/demo.test.mjs`, `test/http.test.mjs` | Rider Live: tài khoản, điều khoản, vị trí, chuyến, SLA, ảnh, BO, máy chủ thật, cookie, CSRF, WebSocket, Traccar. |
| `test/backup.test.mjs`, `test/deploy.test.mjs` | Sao lưu tự động; gói triển khai Docker. |
| `test/ui/*.py` | Từng màn hình theo từng vai trên Chromium: máy tính, điện thoại, giao diện tối, không lỗi JS, không tràn ngang. |
| `test/fix.*.test.mjs` | 12 bộ kiểm hồi quy cho các lỗi tìm được khi rà soát sâu (nhân sự, phân quyền, hệ thống, chuyến FO, sự cố, kho, vòng đời BO, giao việc, thẻ nhớ, số liệu Sale, chỗ nối giữa các phần, tốc độ và bộ nhớ đệm số liệu); mỗi bộ chạy trên cả kho bộ nhớ lẫn SQLite. Quy tắc tương ứng ghi trong `docs/quy-tac-van-hanh.md`. |
| `test/hub.load.mjs` | 40 người dùng ảo trên máy chủ thật với dữ liệu mẫu cỡ lớn: đọc dashboard, nhận / trả việc (Tech tự nhận ở hàng chung; Logistics tự giao theo ca, trả việc thì hệ thống giao lại; mỗi loại phải đủ lượt đo), nhập xuất phụ kiện, báo sự cố; đo p50 / p95 / p99 và thời gian màn hình team khác nhận được cập nhật. |

**Chưa kiểm thử được** trong môi trường phát triển (cần thử khi triển khai): build Docker và Caddy thật, ảnh nền bản đồ thật, điện thoại thật ngoài đường (GPS, camera, Safari iOS), app Traccar Client thật, Slack thật, file Excel thật của công ty.

---

## 11. Cấu trúc mã

```
server.js              HTTP, cookie, tệp tĩnh, WebSocket, /osmand, lưu ảnh, Slack, thời tiết, sao lưu
core/core.js           tài khoản, phiên, điều khoản, điểm, vị trí trực tiếp, bộ định tuyến API có kiểm vai trò
core/tasks.js          Rider Live: chuyến, điểm dừng, SLA, ảnh, BO, tuyến định kỳ, thống kê, cảnh báo
core/hub/              Ops Hub: defs (hằng số, cấu hình đề xuất), stock (kit, thiết bị, phụ kiện), outlets (BO, yêu cầu Sale),
                       jobs (việc tự sinh, tự giao, SLA, gom chuyến), cards (thẻ, bàn giao, dung lượng), incidents (sự cố),
                       people (phân ca, chấm công, hiệu suất), report (dashboard, đối chiếu, nhật ký), importer (Excel), demo
core/store-sqlite.js   kho SQLite (bản thật)      core/store-memory.js  kho bộ nhớ (kiểm thử, bản xem thử)
lib/backup.js          sao lưu hằng ngày
public/                giao diện: JS thuần + Leaflet, không cần build; public/js/views/ mỗi màn hình một file
tools/                 gộp bản xem thử một-file
docs/                  hướng dẫn sử dụng theo vai
```

Lõi nghiệp vụ không phụ thuộc Node (chạy được cả trong trình duyệt), nên bản xem thử và các bộ kiểm thử dùng đúng logic của bản thật.

Thành phần của bên thứ ba kèm trong gói: Leaflet 1.9.4 (BSD-2-Clause), phông Be Vietnam Pro (SIL OFL 1.1), thư viện `ws` (MIT). Dữ liệu bản đồ © OpenStreetMap contributors (ODbL).

---

## 12. Lộ trình đề xuất

1. **Thông báo đẩy** cho nhân viên và FO khi có việc mới hoặc sắp trễ (Web Push, hoặc đóng gói thành app Android để có luôn vị trí nền).
2. **Quét mã** thẻ, thiết bị, kit (QR, serial) khi kiểm kit, bàn giao và giao nhận, thay cho chọn tay.
3. **Tự gửi link cho BO** qua Zalo OA / SMS khi chuyến được giao.
4. **Tối ưu thứ tự điểm theo đường thật** (Google `optimizeWaypointOrder` hoặc OSRM `/trip`) thay cho sắp xếp theo đường chim bay; giờ đến dự kiến từng điểm cho FO và BO.
5. Đăng nhập bằng tài khoản Google công ty; nối bảng lương / HRIS chung bằng xuất dữ liệu hiệu suất đã chốt kỳ.
