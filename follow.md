# TROLYoto V3 Bot — Luồng hoạt động mong muốn

> Tài liệu này mô tả **hành vi bot PHẢI có** (product/business intent), không phải cách code hiện tại implement (xem `ARCHITECTURE.md` cho phần đó). Mỗi khi sửa/thêm logic, đọc file này trước để biết ràng buộc, và sau khi sửa xong, tự kiểm tra lại từng mục có còn đúng không (đặc biệt các mục đánh dấu ⚠️ — từng bị bug thật, đã fix, dễ regress lại).
>
> Áp dụng cho **V3 flow** (`fb-webhook-server/src/fb/v3/flow-handler.ts`), bọc bởi **production wrapper** (`fb-webhook-server/src/fb/production/flow-handler.ts`). Logic tương đương phải mirror sang Web bot (`src/libs/chat/`) trừ khi ghi rõ "chỉ FB".

## 1. Tổng quan

Bot tư vấn + tìm lốp xe (TROLYoto): thu thập **kích cỡ lốp**, **thương hiệu/phân khúc/giá**, **khu vực** qua chat tự nhiên (AI-driven, không phải cây quyết định cứng), sau đó trả về sản phẩm + gara gần khách. Khi bot không xử lý được → chuyển CSKH (con người) qua thu thập số điện thoại.

## 2. Thu thập thông tin (Gathering)

Mỗi tin nhắn của khách đi qua `v3GatherTurn` (1 AI call tổng hợp) để trích xuất field còn thiếu + quyết định hành động tiếp theo. Field cần đủ **cả 3** trước khi fetch kết quả:

1. **Kích cỡ lốp** (`tire_size`) — ưu tiên parse bằng regex trực tiếp từ tin nhắn (đáng tin hơn AI cho field này); AI chỉ dùng khi regex không match. Khách có thể gửi ảnh lốp → OCR đọc size + brand.
2. **Thương hiệu/phân khúc/giá** — chấp nhận nhiều dạng: brand cụ thể (1-3 hãng), phân khúc (cao cấp/cân bằng/tiết kiệm), tầm giá (`max_price_vnd`), "tốt nhất" (`wants_best_quality`), hoặc "xem hết" (`brand_tier='all'`).
3. **Khu vực** (`province_code`/`ward_code`) — xem mục 3.

Khi khách gõ **tên xe** (không phải size trực tiếp) → gọi `resolveCarModel` (AI resolver riêng, xem mục 5) để tra size thay vì đoán bừa từ field `car_model` do `v3GatherTurn` tự trích (dễ ảo giác với tên xe phát âm sai/gõ tắt).

**⚠️ Ràng buộc bắt buộc — không re-trigger khi AI echo lại giá trị CŨ:**
`v3GatherTurn` là AI, có thể "nhắc lại" 1 field đã biết (vd khách nói "cảm ơn" sau khi đã có kết quả, AI vẫn trả `province_name`/`selected_brands` y hệt lần trước) dù tin nhắn không hề nhắc gì tới field đó. **Mọi logic "field X vừa đổi → làm Y" PHẢI so sánh giá trị AI trả với giá trị ĐANG CÓ trong state, không chỉ check "AI có trả field này không".** Nếu không, hậu quả thật đã xảy ra:
- Xoá `province_code`/`ward_code` đã resolve đúng rồi resolve lại chỉ bằng tên tỉnh trần trụi → với tỉnh lớn (Hà Nội, TP.HCM — nhiều ward có tên tỉnh nằm trong `path`) sẽ khớp hàng chục ward trùng tên, hỏi lại khách vô lý dù đã xác nhận khu vực từ trước.
- Tự động fetch + gửi lại y nguyên card sản phẩm chỉ vì khách nói "cảm ơn".
- Xoá oan `max_price` khách vừa set.

## 3. Xác định khu vực (Location) — pipeline 3 tầng + retry có giới hạn

Thứ tự thử (dừng ở tầng đầu tiên thành công):

1. **Alias tỉnh cũ đã sáp nhập** (`resolveMergedProvinceAlias`) — khách gõ "Thái Bình"/"Thái Bình cũ" → map thẳng sang tỉnh mới (Hưng Yên) + ward đại diện, KHÔNG qua AI.
2. **Sync match trên userInput GỐC** (`resolveProvinceSync`/`resolveProvinceCodeFromText`) — so khớp tên tỉnh/TP chuẩn, chạy trên **tin nhắn gốc của khách**, KHÔNG chạy trên field `province_name` mà `v3GatherTurn` đã tự rút gọn/tóm tắt (field đó có thể bị AI hiểu sai/ảo giác — xem ⚠️ dưới).
3. **`resolveAddress`** (AI resolver riêng, dedicated — xem mục 5) — chỉ gọi khi bước 2 fail. Có threshold confidence ≥0.65, dưới ngưỡng → coi như KHÔNG xác định được (không đoán bừa).
4. **Ward-fallback đa khớp** — nếu vẫn fail, thử tìm ward theo tên (chấp nhận NHIỀU kết quả trùng tên → hỏi khách xác nhận qua QR). **KHÔNG BAO GIỜ tự động chấp nhận khi chỉ có ĐÚNG 1 KHỚP** — đây từng là nguồn gốc bug nghiêm trọng (xem ⚠️ dưới).
5. **Không xác định được** → hỏi lại khách (`fail_location` +1). Tối đa `MAX_FAIL_PER_STEP` (hiện = 2) lần hỏi lại, sau đó **handoff CSKH** — không được lặp hỏi vô hạn.

**⚠️ Bug thật đã xảy ra (đã fix, đừng regress):**
- Khách gõ "Phố nói a hùng yên" (ý là "Phố Nối, Hưng Yên", gõ sai/thiếu dấu) → `v3GatherTurn` tự trích `province_name="Yên Bái"` (ảo giác, chỉ vì trùng âm "yên"). Nếu code tin tưởng field này để sync-match → khớp "Yên Bái" (1 tỉnh cũ hợp lệ trong alias map) → SAI hoàn toàn, không có cơ hội sửa qua `resolveAddress`. **Vì vậy bước 2 bắt buộc chạy trên userInput gốc, KHÔNG chạy trên field AI đã tóm tắt.**
- Cùng lý do: nếu sync-match fail trên userInput, KHÔNG được fallback thử lại sync-match trên field AI tóm tắt (`text`) — vì field đó khi non-null LUÔN là 1 tên tỉnh "hợp lệ" kể cả khi bịa (vd khách chỉ nói "em không biết ghi địa chỉ thế nào" — không hề nhắc tỉnh nào — AI vẫn tự bịa ra "Hà Nội"), khiến sync-match "thành công" giả tạo, vô hiệu hoá hoàn toàn lớp bảo vệ `resolveAddress`.
- Ward-fallback từng tự động chấp nhận khi chỉ có 1 kết quả khớp mờ (fuzzy) — đã bỏ nhánh này, giờ CHỈ giữ nhánh nhiều-khớp-hỏi-lại (an toàn vì khách tự xác nhận).

## 4. Hiển thị kết quả (Dispatch & Fetch)

Khi đủ 3 field → chọn chiến lược theo state:

| State | Chiến lược |
|---|---|
| `selected_brands.length===1` | Đơn brand |
| `selected_brands.length` 2-3 | Đa brand — nhiều tin/carousel riêng, mỗi hãng ≤3 card, hãng không có hàng thì bỏ qua im lặng |
| `selected_brands.length>=4` | Quay về flat top (không tách dòng) |
| `brand_tier` cụ thể (không brand riêng) | Phân khúc |
| `wants_best_quality===true` | Cascade tier×khu vực: xã+cao cấp → xã+cân bằng → xã+tiết kiệm → xã+tất cả → tỉnh+... — dừng ở nhóm đầu tiên có hàng |
| `brand_tier==='all'` + không brand | "Xem hết" — lấy 1 SP rẻ nhất mỗi phân khúc có hàng (tối đa 3) |

Ward fallback về tỉnh nếu không có gara tại ward cụ thể (log rõ `[WARD→PROVINCE fallback]`).

`max_price_vnd` nếu có → filter THÊM vào bất kỳ chiến lược nào, không phải case riêng.

**Reset `max_price`**: chỉ reset khi đổi size/brand/khu vực **SAU KHI đã show kết quả lần đầu** (`has_shown_results=true`) — đổi TRƯỚC lần fetch đầu tiên (đang gộp yêu cầu) thì GIỮ giá.

## 5. Dedicated AI resolvers (không dùng thẳng field từ `v3GatherTurn`)

Nguyên tắc chung: `v3GatherTurn` là 1 AI call TỔNG HỢP nhiều field cùng lúc, dễ ảo giác với field cần suy luận phức tạp (tên xe phát âm sai, địa chỉ gõ tắt). Với các field này, `v3GatherTurn` chỉ đóng vai trò **TÍN HIỆU** ("khách có nhắc gì đó về X"), KHÔNG phải **DỮ LIỆU** đáng tin — phải verify qua 1 AI call riêng, hẹp, nhận **userInput gốc**:

- **`resolveCarModel`** — xác định tên xe từ input phát âm/gõ sai (vd "xe san ta pe hàn quốc" → Hyundai Santa Fe). Confidence thấp/input quá ngắn mơ hồ (vd chỉ "San 2017") → trả `null`, KHÔNG đoán đại. Gửi lặp lại lần 2 → coi lần 1 sai, loại trừ khỏi kết quả + escalate model mạnh hơn (`gpt-4o`).
- **`resolveAddress`** — xác định tỉnh/TP + gợi ý ward từ địa chỉ gõ tắt/sai chính tả (xem mục 3).

Cả 2 đều: sync/deterministic trước (rẻ, nhanh) → AI resolver riêng nếu fail → giới hạn retry (`MAX_FAIL_PER_STEP` lần) → hỏi lại hoặc handoff CSKH, KHÔNG bao giờ lặp vô hạn.

## 6. FAQ "Lốp sản xuất năm nào"

Câu trả lời **cố định**, KHÔNG để AI tự sinh: "😊 Năm sản xuất có thể khác nhau giữa từng gara. Anh/chị chọn [Xem năm sản xuất] để xem chi tiết nhé." Dựng lại từ card gần nhất trong `conversation_log` (không fetch lại DB), chỉ đổi nhãn nút "🎁 Xem khuyến mại" → "Xem năm sản xuất" (giữ nguyên URL).

## 7. Sau khi hiển thị kết quả (`AWAITING_BOOKING_STATE`)

Bot hỏi "Anh chị cần TROLYoto hỗ trợ thêm gì để chọn lốp ưng ý không ạ" kèm QR: Đã đặt lịch / Chưa cần thay / Còn băn khoăn.

**Free-text ở bước này** (khách không bấm QR) vẫn đi qua `handleGathering` bình thường — CHO PHÉP khách tiếp tục hỏi/tìm sản phẩm khác. Nhưng:
- Nếu tin nhắn KHÔNG mang thông tin mới thật sự (off-topic, cảm ơn, chào tạm biệt) → KHÔNG được re-trigger tìm kiếm/hỏi lại khu vực (xem ràng buộc ở mục 2). Bot trả lời tự nhiên (`decision.reply` do AI sinh) là đủ.
- Nếu khách nêu yêu cầu CSKH/phàn nàn nghiêm trọng → `handoff_cskh` (xem mục 8).

## 8. Handoff CSKH — 1 lần hỏi SĐT, KHÔNG lặp lại

Khi bot quyết định handoff (`decision.action==='handoff_cskh'`, hoặc fail counter chạm `MAX_FAIL_PER_STEP`, hoặc khách bấm "Chat tư vấn viên"):

1. Gửi **đúng 2 tin nhắn cố định** qua `cskhHandoff()`: (a) "Em đã nhận thông tin ạ 🙏 ..." (nội dung khác nhau theo `mode`/trong-ngoài giờ), (b) "Hoặc để được hỗ trợ mình nhanh hơn, anh/chị vui lòng để lại số điện thoại ạ 😊". Chuyển step → `AWAITING_PHONE`.
2. **⚠️ KHÔNG gửi thêm `decision.reply` (câu AI tự sinh) trước 2 tin này** — mọi call site `cskhHandoff` khác trong code đều gọi trực tiếp, không kèm reply riêng. Từng có bug: `decision.reply` do AI sinh lẫn lộn (vd hỏi "SĐT của gara" thay vì SĐT khách) + dư thừa thành 3 tin liên tiếp cho cùng 1 yêu cầu.
3. Khách trả lời có SĐT → `handlePhoneInput` ghi nhận, ack, **end-permanent** (`is_paused_by_cskh=true`, `is_active=false`) — bot im lặng vĩnh viễn cho PSID này.
4. Khách trả lời KHÔNG có SĐT nhưng câu chữ trông như hỏi sản phẩm khác (vd đổi size/brand/khu vực) → tiếp tục `handleGathering` bình thường, KHÔNG ép đóng.
5. **⚠️ Khách trả lời KHÔNG có SĐT và AI (`v3GatherTurn`) LẠI quyết định `handoff_cskh` lần nữa** (nghĩa là chính AI cũng không thấy đây là câu hỏi sản phẩm mới) → **KHÔNG hỏi lại vòng 2** (tránh lặp y nguyên câu xin lỗi mãi mãi) — đóng luồng NGAY qua `handlePhoneInput` (nhánh "không có SĐT": 1 tin ack + end-permanent), giống hệt như khi khách chủ động từ chối cho SĐT.

## 9. CSKH echo detection (chỉ FB, production wrapper)

Khi Page Inbox/Business Suite/Pancake gửi tin cho khách (không phải bot) → FB echo về webhook với `app_id` khác bot. Đây là dấu hiệu CSKH người thật đã engage → **pause session vĩnh viễn** cho PSID đó, bot ngừng tự động trả lời.

> Trạng thái ⏳ ĐANG XỬ LÝ (chưa merge tại thời điểm viết file này): phân biệt tin quảng cáo/tự động (Meta "stale thread automation", `notification_messages_*` template) khỏi CSKH người thật trả lời tay — chỉ loại `app_id=263902037430900` khỏi pause-trigger khi xác định được đó là tin **quảng cáo/tự động**, KHÔNG loại trừ toàn bộ app_id (vì app_id này cũng là kênh CSKH thật trả lời qua Page Inbox UI). Xem lịch sử chat để lấy quyết định cuối cùng + code thực tế khi đọc lại file này.

## 10. Giờ làm việc (production wrapper)

`FROM_TIME`→`END_TIME` (default 18:00→08:30, overnight) là khung **bot được hoạt động**. Trong giờ CSKH (ngoài khung bot) → bot SILENT hoàn toàn (kể cả đang giữ thread). `/reset` và whitelist PSID (`PROD_TEST_PSIDS`) bypass gate để test bất cứ lúc nào.

## 11. Bất biến xuyên suốt dự án

- **Mọi thay đổi logic PHẢI mirror cả FB (`fb-webhook-server/src/fb/`) và Web (`src/libs/chat/`)**, trừ phần rõ ràng chỉ áp dụng 1 bên (vd CSKH echo detection chỉ FB — Web không có khái niệm Page Inbox/handover).
- Câu chữ cố định (FAQ, closing message...) KHÔNG để AI tự sinh — sai 1 chữ là sai hẳn ý nghĩa nghiệp vụ.
- `v3GatherTurn`/`webGatherTurn` là AI — KHÔNG deterministic, cùng input có thể ra action khác nhau giữa các lần gọi. Code phải có **safety net xác định** (so sánh state cũ/mới, regex, sync match) chứ không phụ thuộc hoàn toàn vào quyết định của AI.
