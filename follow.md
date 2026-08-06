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

**⚠️ Ràng buộc bắt buộc — KHÔNG tự đoán số khi khách chê giá mà không nêu số cụ thể:**
Khách nói "giá cao quá"/"đắt quá" (KHÔNG kèm số) → `max_price_vnd` PHẢI = null, action='continue', hỏi lại khách muốn mức giá dưới bao nhiêu — **KHÔNG được tự suy ra 1 con số**. Bug thật đã xảy ra: khách nói "Giá cao quá" sau khi lịch sử hội thoại có tin nudge tự động "TRỢ GIÁ tới 800K đã sẵn sàng..." (số tiền TRỢ GIÁ của hệ thống, không liên quan khách) → AI hiểu nhầm 800K là mức giá khách muốn, tự fetch lại với `max_price=800000`, không tìm ra SP nào (giá thật ~2tr+) → handoff CSKH sai lý do, khách bị hỏi nhầm hoàn toàn. Fix 2 lớp:
1. Prompt: dạy AI phân biệt số liệu marketing/hệ thống (trong lịch sử) với số khách thực sự nêu, và bắt buộc hỏi lại khi khách chê giá không kèm số.
2. **Kiến trúc (quan trọng hơn, chặn tận gốc)**: `recentHistory()` (đưa vào `v3GatherTurn`) CHỈ chứa hội thoại thật giữa khách-bot, lọc bỏ tin "hệ thống tự tạo" qua cờ `ConversationMessage.hidden_from_ai` — set tại nguồn phát sinh (`sendCards`, `sendButtonTemplate`, `fireInfoNudgeStage1`), không phải suy đoán lại lúc đọc. Bất kỳ tin nudge/CTA/danh sách SP mới thêm sau này PHẢI tự set cờ này nếu không muốn AI đọc nhầm.

**⚠️ Ràng buộc bắt buộc — khách hỏi GIÁ CHUNG CHUNG (không chê đắt) KHÔNG được hiểu thành "yêu cầu lọc giá":**
Bug thật: bot vừa gợi ý 1 size xe + hỏi "xác nhận có phù hợp không", khách trả lời "Bao nhiêu một chiếc vậy" (hỏi thông tin, KHÔNG chê đắt/không muốn lọc giá) → AI hiểu nhầm thành ý "chê giá cao", hỏi ngược lại "mức giá dưới bao nhiêu ạ?" — sai hoàn toàn ý khách. Phân biệt 2 case trong prompt: "chê giá cao không kèm số" (mục trên) hỏi lại mức giá mong muốn; còn "hỏi giá chung chung, chưa đủ 3 trường" thì `max_price_vnd=null` LUÔN + set `off_topic_kind='generic_price_inquiry'`.
**Thiết kế cuối (SAU 1 vòng fix thất bại — xem lý do dưới):** off_topic_kind này KHÔNG dùng `decision.reply` do AI tự soạn để hỏi field tiếp theo. Thay vào đó `handleGathering`/`route.ts` deterministically tính field còn thiếu từ STATE THỰC TẾ (size→brand→khu vực, coi 1 size VỪA GỢI Ý ở lượt trước là ĐÃ CÓ) qua `genericPriceInquiryQuestion()` và GHI ĐÈ hẳn bằng 1 trong 3 câu hỏi cố định (kèm QR brand nếu đang hỏi brand) — AI chỉ cần set đúng `off_topic_kind` + `max_price_vnd=null`, reply của AI bị bỏ qua hoàn toàn.
Lý do KHÔNG để AI tự soạn (đã thử, KHÔNG đủ tin cậy dù đã cho ví dụ tương phản rõ ràng trong prompt): test trực tiếp cho thấy khi state CHỈ có size (brand + khu vực đều thiếu), AI vẫn LẶP LẠI y nguyên ví dụ "hỏi khu vực" trong prompt dù ví dụ khác ngay bên cạnh dạy đúng case này phải hỏi brand — 3/3 lần sai liên tiếp. Kết hợp với code cũ (`needBrand`/`hasBrandField` gate) tự động chèn brand QR bên dưới bất kỳ `decision.reply` nào khi brand thực sự thiếu → tạo ra tin nhắn "lẫn lộn" thật: text hỏi khu vực nhưng QR bên dưới lại là chọn hãng lốp (bug báo cáo 2026-08-06 từ log thật). Bài học: field-priority logic đã có sẵn deterministic helper (`nextMissingFieldQuestion`/`hasTireBrand`...) — dùng thẳng thay vì tin AI tự suy luận lại logic tương tự bằng văn xuôi.

**⚠️ Ràng buộc bắt buộc — brand + tên xe trong CÙNG 1 câu hỏi tự nhiên PHẢI trích được CẢ HAI:**
Bug thật (2026-08-06): khách hỏi "lốp mít có dùng cho xe i10 không" ("mít" = tiếng lóng Michelin, đã có trong danh sách viết tắt hãng) — AI chỉ set `car_model='Hyundai Grand i10'`, BỎ SÓT `selected_brands=['MICHELIN']` vì brand nằm giữa câu hỏi thay vì gõ liền tên xe kiểu "michelin vf6" (ví dụ duy nhất trước đó trong prompt). Hệ quả dây chuyền: brand mãi không được lưu → các lượt sau cứ hỏi lại brand dù khách đã nói ngay từ đầu. Fix: thêm ví dụ tường minh "lốp mít có dùng cho xe i10 không → CẢ HAI" ngay dưới quy tắc "KẾT HỢP BRAND + CAR" (cả 2 bot). Bài học chung: 1 ví dụ dạng "gõ liền 2 từ" KHÔNG đủ để AI generalize sang câu hỏi tự nhiên đầy đủ — cần thêm ví dụ riêng cho dạng câu hỏi khi field quan trọng có thể bị bỏ sót.

**⚠️ Ràng buộc bắt buộc — `state.tire_size` PHẢI được khoá chắc chắn khi chỉ có ĐÚNG 1 size khớp xe, không phụ thuộc hoàn toàn vào AI tự nhớ:**
Sau khi `showCarSizeOptions`/`runCarSizeLookup` show 1 size duy nhất + hỏi "xác nhận có phù hợp không" (lưu vào `state.last_shown_car_sizes`), field `tire_size` CHƯA thực sự set — khách có thể xác nhận qua QR (`QR_TIRE_SIZE:`/`V3_TIRE_SIZE:`, bypass AI hoàn toàn) HOẶC qua tin nhắn tự do bất kỳ (AI phải tự suy luận "khách không phản đối size này" để set `tire_size`). Case thứ 2 KHÔNG đáng tin cậy 100% (AI có lúc set, có lúc quên) → nếu quên, `state.tire_size` mãi trống, các field-completeness check (`hasTireSize`/`hasSize`) cứ coi là thiếu mãi dù đã show/hỏi xác nhận rồi. **Fix: code-level fallback** (không chỉ dựa AI) — nếu turn này AI KHÔNG set `tire_size` VÀ KHÔNG nêu `car_model` mới VÀ `last_shown_car_sizes` chỉ có đúng 1 phần tử → tự khoá size đó vào state luôn (coi im lặng/hỏi chuyện khác = không phản đối), rồi xoá `last_shown_car_sizes`. Áp dụng cả 2 bot (`route.ts` Web, `flow-handler.ts` FB `handleGathering`).

**⚠️ Ràng buộc bắt buộc — chỉ coi `car_model` là "xe MỚI" khi nó THỰC SỰ khác `state.car_model` cũ:**
Hệ quả trực tiếp của bug "AI echo field cũ" (bullet đầu mục này) áp dụng riêng cho `car_model`: logic "khách nêu tên xe mới → xoá `tire_size` (có thể hallucinate) + bắt buộc tra lại DB qua `runCarSizeLookup`/`resolveCarModel`" trước đây chỉ check `decision.updates.car_model` có giá trị hay không — KHÔNG so với `state.car_model` cũ. Bug thật: khách đã xác nhận xong size (`tire_size` đã khoá), lượt sau chỉ gõ "Hà Nội" (cho khu vực) — nhưng AI vẫn ECHO lại `car_model` cũ trong `updates` (dù tin nhắn không hề nhắc xe) → code hiểu nhầm "xe mới", XOÁ OAN `tire_size` vừa khoá + gọi lại `resolveCarModel("Hà Nội")` vô nghĩa → AI resolver trả `car_model=null` → tính là fail_size, bot hỏi lại ảnh/size dù đã xong từ trước. Fix: thêm điều kiện `decision.updates.car_model !== state.car_model` (car_model THỰC SỰ đổi) trước khi trigger nhánh "xe mới". Áp dụng cả 2 bot.

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
- Khách gõ "Tp Vĩnh Yên cũ" (Vĩnh Yên = TP tỉnh lỵ cũ của Vĩnh Phúc, nay thuộc Phú Thọ) → trả SAI ra "Vĩnh Long". Nguyên nhân KÉP:
  1. `MERGED_PROVINCE_ALIASES` lúc đó chỉ có tên TỈNH cũ (vd "vinh phuc") chứ chưa có tên THÀNH PHỐ/tỉnh lỵ cũ (vd "vinh yen") — "Vĩnh Yên" không khớp bước 1 lẫn bước 2 → rơi xuống AI `resolveAddress`, AI đoán liều theo âm gần giống ("Vĩnh" + tỉnh hiện hành bất kỳ) ra "Vĩnh Long". **Đã fix**: thêm ~50 key tên thành phố/thị xã cũ (tra từ `old_data.txt`, verify ward.json) vào `MERGED_PROVINCE_ALIASES`.
  2. `stripVn()` không xử lý đúng chữ "Đ" (không giống nguyên âm có dấu, KHÔNG có canonical decomposition trong Unicode NFD) → bị catch-all xoá hẳn thay vì chuyển thành "d" (vd "Châu Đốc" → "chau oc" thay vì "chau doc") — khiến 3 alias cũ có tên bắt đầu bằng "Đ" (`nam dinh`, `binh dinh`, `dak nong`) **chưa bao giờ khớp được** với input thật có dấu. **Đã fix tại gốc**: thêm `.replace(/đ/g, 'd')` trước bước `normalize('NFD')` trong `stripVn()`.
  3. (Phát hiện thêm khi test toàn bộ `old_data.txt`) Thuật toán so khớp `key.includes(haystack)`/`c.includes(haystack)` (chiều "text khách ngắn hơn key") không có ngưỡng độ dài tối thiểu → tên NGẮN, KHÔNG ĐỔI tự nó (vd "Vinh" - TP Vinh, Nghệ An, không sáp nhập) bị coi là tiền tố mập mờ khớp NHẦM vào tên dài hơn chứa nó (vd "Vĩnh Long" chứa "vinh"). **Đã fix**: chiều `X.includes(haystack)` chỉ áp dụng khi `haystack.length >= 5`.
  **Test bắt buộc trước khi sửa lại pipeline location**: chạy lại toàn bộ 83 dòng `old_data.txt` (4 cách gõ/dòng: tên trần, "Tp {tên}", "{tên} cũ", "Tp {tên} cũ") qua `resolveMergedProvinceAlias`+`resolveProvinceSync` — không được để lọt trường hợp resolve SAI sang 1 tỉnh khác (khác với việc trả `null`/để AI xử lý, vốn CHẤP NHẬN ĐƯỢC).

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

**Sau khi show kết quả — nudge 15s + khách nhắn tiếp (`SHOWING_RESULTS_LOCAL`):**
Bot lên lịch `scheduleTimer('v3-help-15s', ...)` (map key = sessionId, CHỈ 1 timer/session — schedule mới tự cancel timer cũ). Khi khách gửi tin BẤT KỲ (kể cả free-text hỏi FAQ) → dispatcher PHẢI route qua `handleGathering()` như mọi step khác — `handleGathering()` tự `cancelTimer()` timer đang chờ ở dòng đầu tiên, không cần code riêng.

**⚠️ Bug thật đã xảy ra (đã fix, đừng regress)**: step `SHOWING_RESULTS_LOCAL` từng được code là "im lặng" (comment "Đang chờ timer 15s → im lặng", KHÔNG gọi `handleGathering`) — khách gửi câu hỏi thật ("lốp sản xuất năm nào") trong lúc chờ 15s bị **BỎ QUA HOÀN TOÀN** (không trả lời gì), sau đó nudge 15s vẫn fire theo lịch cũ, hỏi 1 câu không liên quan ("Anh chị cần hỗ trợ thêm gì...") như thể khách chưa nói gì — khách phải hỏi lại lần 2 mới được trả lời. **Đã fix**: `SHOWING_RESULTS_LOCAL` route qua `handleGathering()` như bình thường.

**FAQ "cố định + replay card/offers gần nhất"** — pattern dùng chung cho các câu hỏi có sẵn 1 câu trả lời chuẩn KHÔNG đổi theo ngữ cảnh (AI KHÔNG tự soạn reply, chỉ cần set đúng `off_topic_kind`):
- `manufacture_year` ("lốp sản xuất năm nào") → đổi nhãn nút "🎁 Xem khuyến mại" → "Xem năm sản xuất".
- `garage_contact` ("cho xin địa chỉ/SĐT gara") → đổi nhãn nút → "Xem gara này".

**⚠️ Bug thật đã xảy ra**: `garage_contact` chưa có FAQ riêng lúc đầu → khách hỏi "có số điện thoại gara không" bị AI xếp nhầm vào nhóm "KHÁCH HỎI ĐIỀU BẠN KHÔNG CÓ DỮ LIỆU" (mục 2) → `action='handoff_cskh'`, chuyển thẳng CSKH thay vì trả lời FAQ có sẵn. **Đã fix**: thêm `off_topic_kind='garage_contact'` + FAQ riêng, PHẢI đặt trước/loại trừ rõ khỏi nhóm "không có dữ liệu" trong prompt (nếu thêm FAQ cố định mới tương tự sau này — nhớ làm y hệt: vừa thêm template mới, vừa loại trừ khỏi mục "KHÁCH HỎI ĐIỀU BẠN KHÔNG CÓ DỮ LIỆU" để tránh AI phân vân giữa 2 nhánh).

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

## 9. CSKH echo detection (cả FB PROD lẫn V3 — 2 bản độc lập, phải sửa cả 2)

Khi Page Inbox/Business Suite/Pancake gửi tin cho khách (không phải bot) → FB echo về webhook với `app_id` khác bot. Đây là dấu hiệu CSKH người thật đã engage → **pause session** cho PSID đó, bot ngừng tự động trả lời — **tối đa 8 tiếng** (xem "Pause tự hết hạn" bên dưới, sửa 2026-08-06; TRƯỚC ĐÓ pause thật sự vĩnh viễn, không có cơ chế hết hạn).

**Phân biệt tin quảng cáo/tự động khỏi CSKH người thật (đã fix, xem `isAutomatedAdEcho()` — trùng tên, tách riêng ở CẢ `production/flow-handler.ts` LẪN `v3/flow-handler.ts`, KHÔNG import chung vì `production` đã import từ `v3` — import ngược sẽ tạo circular dependency):**
Meta có tính năng "Recurring Notifications" tự động gửi tin nhắc lại thread cũ (title "Ưu đãi và thông báo", `notification_messages_cta_entry_point: "mm_stale_thread_automation"`) — echo về webhook với **CÙNG app_id=263902037430900** như CSKH người thật trả lời qua Business Suite, nên KHÔNG thể phân biệt qua app_id. Phải nhận diện qua CẤU TRÚC nội dung: chỉ tin tự động mới có field `notification_messages_*` trong `message.attachments[].payload.elements[].buttons[]` — người thật gõ chỉ gửi text/ảnh đơn giản.

Khi phát hiện tin quảng cáo/tự động dạng này:
- **KHÔNG coi là CSKH engage** — không tạo session mới, không pause.
- Nếu session **HIỆN ĐANG bị pause** (do CSKH thật xong việc, hoặc do quảng cáo trước đó lỡ trigger trước khi có check này) → `completeSession()` (như `/reset`) để khách chat lại sau đó bot hoạt động bình thường, không bị treo silent oan vĩnh viễn chỉ vì 1 tin quảng cáo.
  **⚠️ Lưu ý đã từng SAI (sửa 2026-08-06)**: `completeSession()` KHÔNG tự xoá `is_paused_by_cskh` (chỉ set `is_active=false, step='COMPLETED'`) — trước đây tài liệu này ghi nhầm rằng session cũ "sẽ không được tìm thấy nữa" vì `is_active=false`, nhưng dispatcher LUÔN fallback qua `getLatestSession()` (bỏ qua filter `is_active`) khi check pause — nên session cũ vẫn bị tìm thấy VÀ vẫn `is_paused_by_cskh=true` mãi mãi, bot VẪN im lặng dù đã "complete". Cơ chế hết hạn 8h ở mục dưới mới là thứ thực sự giải quyết việc này tận gốc.

**Pause tự hết hạn sau 8 tiếng (`CSKH_PAUSE_EXPIRY_MS` trong `session.ts`, thêm 2026-08-06):**
Bug thật: khách hỏi `"Lốp continentel 235/45R18 sx năm bn"` trong lúc session đang `PAUSED_BY_CSKH` — bot không bao giờ trả lời nữa dù CSKH không follow-up thêm, vì `is_paused_by_cskh` trước đây KHÔNG BAO GIỜ được xoá ở bất kỳ đâu trong code (chỉ có nơi SET thành `true`, không có nơi SET thành `false`).
- Field mới `paused_by_cskh_at` (migration `20260806_fb_messenger_sessions_pause_expiry.sql`) — set MỖI LẦN `pauseSessionByCskh()` được gọi (kể cả set lại nhiều lần), tức là **mốc 8h luôn tính từ lần CSKH engage GẦN NHẤT**, không phải lần đầu tiên.
- `resolveEffectiveSession(session)` (session.ts) — gọi NGAY SAU mỗi lần fetch session ở các điểm quyết định "bot có nên im lặng": nếu pause đã quá 8h → tự động unpause TRONG DB (`is_paused_by_cskh=false, is_active=true, step='V3_GATHERING', paused_by_cskh_at=null`) VÀ trả về session đã cập nhật, để tin nhắn khách LẦN NÀY được xử lý ngay (không cần đợi thêm 1 lượt).
- **PHẢI dùng hàm này (hoặc wrapper `getEffectiveSession` trong `production/flow-handler.ts`) ở MỌI điểm check `is_paused_by_cskh`** để quyết định im lặng hay không — nếu 1 chỗ mới thêm sau này gọi thẳng `getActiveSession`/`getLatestSession` rồi check `.is_paused_by_cskh` mà quên bọc qua resolver, chỗ đó sẽ KHÔNG tôn trọng cơ chế hết hạn, bot lại im lặng vĩnh viễn y hệt bug cũ.
- Không cần sửa `updated_at` (bump bởi MỌI update, kể cả khách tự nhắn khi đang bị im lặng) — dùng field riêng `paused_by_cskh_at` để tránh hoạt động của khách (lặp lại nhắn tin trong lúc bị im lặng) vô tình "làm mới" đồng hồ hết hạn.

**⚠️ Bug phụ phát hiện khi test (đã fix)**: `v3/flow-handler.ts`'s `handleMessengerEventV3Inner` luôn tính `psid = event.sender.id` — với event ECHO (`sender=page, recipient=customer`), giá trị này SAI (= page ID, không phải customer PSID thật), khiến log `[V3 entry] psid=...` gây nhiễu khi debug (không ảnh hưởng logic thật vì nhánh echo tự tính lại `recipient.id` riêng cho mọi thao tác). Đã sửa để tính `psid` echo-aware giống `production/flow-handler.ts` (`isEcho ? recipient.id : sender.id`).

**Feature mới (2026-08-06) — tự gửi lại card SP khi CSKH nhắc "xem khuyến mại" mà chưa có card gần đó:**
Case thật từ log CSKH (`test.js`): khách hỏi giá/năm sản xuất khi session đã `PAUSED_BY_CSKH` (CSKH người thật đang xử lý), CSKH trả lời hướng dẫn "...chọn [XEM KHUYẾN MẠI] nhé ạ" — nhưng KHÔNG có card sản phẩm nào được gửi gần đó để khách bấm (CSKH quên đính kèm, hoặc trả lời sau nhiều giờ). Khách sẽ không biết bấm vào đâu.

Fix (CHỈ ở `production/flow-handler.ts`, trong đúng block log CSKH echo mục 9 — case này KHÔNG xảy ra ở V3 route trực tiếp vì handler đó không log nguyên văn text CSKH gửi, chỉ log 1 dòng system marker): khi tin CSKH gửi khớp `/xem khuyến mại/i` VÀ 2 tin gần nhất trong `conversation_log` (TRƯỚC tin CSKH này) KHÔNG có tin nào `type==='cards'` VÀ `session.state` đã đủ 3 trường (size/brand/khu vực, qua `hasBrandField()` + check size/location trực tiếp) → tự gọi `dispatchAndShowResults()` (export từ `v3/flow-handler.ts`) để **query DB FRESH** (không phải replay card cũ) bằng ĐÚNG state mới nhất đã thu thập, gửi card ngay dưới tin CSKH.

**⚠️ Side-effect PHẢI xử lý**: `dispatchAndShowResults`/`showSpGaraResults` tự set `is_active=true` + đổi `step` (phục vụ luồng gathering bình thường) — nếu để nguyên, bot sẽ vô tình "sống lại" và có thể tự trả lời tin tiếp theo của khách dù CSKH người thật vẫn đang xử lý. Bắt buộc gọi `pauseSessionByCskh(session.id)` LẠI ngay sau để khoá về `is_paused_by_cskh=true, is_active=false, step='PAUSED_BY_CSKH'`.

State thiếu (chưa đủ 3 trường) → KHÔNG làm gì thêm ngoài log — không tự ý `cskhHandoff`/hỏi lại (CSKH đang trực tiếp xử lý, bot chen vào lúc này là sai).

## 10. Giờ làm việc (production wrapper)

`FROM_TIME`→`END_TIME` (default 18:00→08:30, overnight) là khung **bot được hoạt động**. Trong giờ CSKH (ngoài khung bot) → bot SILENT hoàn toàn (kể cả đang giữ thread). `/reset` và whitelist PSID (`PROD_TEST_PSIDS`) bypass gate để test bất cứ lúc nào.

## 11. Bất biến xuyên suốt dự án

- **Mọi thay đổi logic PHẢI mirror cả FB (`fb-webhook-server/src/fb/`) và Web (`src/libs/chat/`)**, trừ phần rõ ràng chỉ áp dụng 1 bên (vd CSKH echo detection chỉ FB — Web không có khái niệm Page Inbox/handover).
- Câu chữ cố định (FAQ, closing message...) KHÔNG để AI tự sinh — sai 1 chữ là sai hẳn ý nghĩa nghiệp vụ.
- `v3GatherTurn`/`webGatherTurn` là AI — KHÔNG deterministic, cùng input có thể ra action khác nhau giữa các lần gọi. Code phải có **safety net xác định** (so sánh state cũ/mới, regex, sync match) chứ không phụ thuộc hoàn toàn vào quyết định của AI.
