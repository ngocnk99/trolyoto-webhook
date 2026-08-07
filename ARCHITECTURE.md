# TROLYoto V3 Bot — Kiến trúc code

> Tài liệu này mô tả **code hiện tại hoạt động thế nào** (implementation). Xem `follow.md` cho hành vi PHẢI có (business intent). Đọc file này trước khi sửa để biết chỗ nào đụng vào, và sau khi sửa xong, kiểm tra lại các mục còn khớp không — đặc biệt danh sách "chỗ dễ sót" ở mục 6.

## 1. Bản đồ file (FB — `fb-webhook-server/src/fb/`)

```
webhook.controller.ts       Entry point FB webhook (GET verify / POST events), route theo page_id
  ├─ production/flow-handler.ts   Wrapper: time-gate + handover protocol + CSKH-echo pause → gọi v3
  │    └─ v3/flow-handler.ts      LOGIC CHÍNH — state machine hội thoại (handleGathering, dispatch, ...)
  ├─ flow-handler.ts (V2, legacy) Không dùng cho page production, giữ cho session cũ trong DB
  └─ ai-helper.ts               Mọi AI call: v3GatherTurn, resolveCarModel, resolveAddress, analyzeTireImage
db.ts                        Supabase queries: fetchSpGaraCards, resolveProvinceSync, findWardsByText,
                              MERGED_PROVINCE_ALIASES, getTireSizesForCar
session.ts                   CRUD `fb_messenger_sessions`: createSession/updateSession/pauseSessionByCskh/
                              resolveEffectiveSession (auto-unpause sau CSKH_PAUSE_EXPIRY_MS=8h, follow.md mục 9)
handover.ts / handover-cron.ts   Facebook Handover Protocol (take/pass thread control), cron pass-back 8:30
types.ts                     MessengerStep enum, SessionState, FbSession, ConversationMessage
debug.controller.ts          Test-only endpoints: simulate-message/simulate-qr/session inspect
```

**Web bot tương đương** (`src/libs/chat/`):
```
server/route.ts              LOGIC CHÍNH tương đương v3/flow-handler.ts (runGatherTurn, finalize, ...)
ai/webGatherTurn.ts           ~ v3GatherTurn
ai/resolveCarModel.ts         ~ resolveCarModel (FB ai-helper.ts)
ai/resolveAddress.ts          ~ resolveAddress (FB ai-helper.ts)
db/locationResolve.ts         ~ db.ts location functions (resolveLocation, resolveLocationWithAi)
db/tireDb.ts                  ~ db.ts tire/garage queries
types/chatTypes.ts            ~ types.ts (WebChatState ~ SessionState)
```
Không có khái niệm `MessengerStep`/session step ở Web — trạng thái hội thoại nằm trong `WebChatState.awaiting` + `action` trả về mỗi turn (`continue`/`show_ward_confirm`/`handoff_cskh`/...).

## 2. Vòng đời 1 tin nhắn (FB)

```
webhook.controller.ts: processEvents()
  → route theo page_id (V2/V3/PRODUCT) + messaging[] vs standby[] (Handover Protocol)
  → runWithPsidLock(psid, ...)  // mutex tránh race condition 2 webhook cùng PSID
  → handleMessengerEventProduction()  (production/flow-handler.ts)
      → check CSKH echo (is_echo + app_id khác bot) → pauseSessionByCskh nếu chưa pause
      → check time gate (FROM_TIME/END_TIME) — ngoài giờ mới cho bot xử lý
      → check /reset, whitelist PSID (bypass gate)
      → handleMessengerEventV3()  (v3/flow-handler.ts)
          → switch theo session.step (AWAITING_PHONE / AWAITING_BOOKING_STATE / ... / default)
          → phần lớn rơi vào handleGathering(psid, session, pageId, userInput)
```

`handleGathering()` (v3/flow-handler.ts, hàm dài nhất file, ~600 dòng) là nơi 90% logic nghiệp vụ nằm — xem mục 4.

## 3. AI calls (`ai-helper.ts`)

| Hàm | Model | Input | Dùng khi |
|---|---|---|---|
| `v3GatherTurn` | `gpt-4o-mini` (`MODEL`) | state hiện tại + userInput + recentHistory (window ngắn) | MỖI tin nhắn free-text |
| `resolveCarModel` | `gpt-4o-mini`, escalate `gpt-4o` (`STRONG_MODEL`) khi retry | userInput GỐC + excludeModels | Khi `decision.updates.car_model` có giá trị |
| `resolveAddress` | `gpt-4o-mini` | userInput GỐC | Khi sync-match location fail |
| `analyzeTireImage` | vision model | ảnh khách gửi | Khi khách gửi attachment ảnh |

**`v3GatherTurn` là 1 schema Zod lớn** (`generateObject`) trả về: `tire_size, brand_tier, selected_brands, province_name, car_model, max_price_vnd, wants_best_quality, off_topic_kind, is_off_topic, action, reply, cskh_reason`. `action` ∈ `continue | fetch_results | handoff_cskh`.

**`recentHistory()` — chỉ hội thoại thật, KHÔNG phải mọi tin đã gửi.** `ConversationMessage.hidden_from_ai` đánh dấu tin "hệ thống tự tạo" (danh sách SP/cards, CTA cộng đồng/khuyến mại qua `sendButtonTemplate`, nudge trợ giá tự động theo timer `fireInfoNudgeStage1`) — set NGAY LÚC GHI LOG tại nguồn phát sinh (`sendCards`/`sendButtonTemplate` luôn set; `reply()` nhận tham số `hiddenFromAi` tuỳ call site), `recentHistory()` lọc bỏ trước khi đưa vào AI. Lý do: bug thật — khách chê "Giá cao quá" (không kèm số) sau khi lịch sử có tin nudge "TRỢ GIÁ tới 800K", AI hiểu nhầm 800K là mức giá khách muốn → tự fetch với `max_price=800000` sai hoàn toàn. Đồng bộ với Web (`route.ts`: `finalize()` lọc bubble theo `AI_HISTORY_EXCLUDED_BUBBLE_TYPES` trước khi `pushBotMessages`).

⚠️ Đây là AI, **không deterministic** — cùng input/state có thể trả `action` khác nhau giữa 2 lần gọi (đã quan sát thực tế khi test). Field nào AI trả **có thể là ECHO của giá trị cũ trong state** dù tin nhắn hiện tại không nhắc gì tới field đó — xem mục 5.

## 4. `handleGathering()` — thứ tự xử lý (v3/flow-handler.ts)

1. Cancel timer pending (nudge 15s/45s từ turn trước).
2. Gọi `v3GatherTurn`.
3. Apply updates vào `newState` (size ưu tiên regex, brand/tier, `wants_best_quality`, `max_price` — có logic reset riêng, xem mục 5). Ngay sau khi merge `tire_size`: nếu turn này AI KHÔNG set `tire_size` VÀ KHÔNG nêu `car_model` mới VÀ `state.last_shown_car_sizes` chỉ có đúng 1 phần tử → tự khoá size đó vào `newState.tire_size` (coi im lặng/hỏi chuyện khác = không phản đối size vừa gợi ý), xoá `last_shown_car_sizes`. Xem `follow.md` mục 2 (bugfix 2026-08-06).
4. **Resolve location** — CHỈ chạy khi `decision.updates.province_name !== state.province_name` (guard `isFreshLocationUpdate`, thêm 2026-07-24). Pipeline chi tiết: `follow.md` mục 3.
5. Reset fail counters nếu AI extract được gì đó (`aiExtractedAnything`) — TRỪ `fail_location` nếu turn này vừa set `locationAskAgainMsg`/`locationHandoffReason` (không được xoá counter vừa tăng).
6. Persist state (`updateSession`).
7. Branch theo action, THỨ TỰ ƯU TIÊN (return sớm, dừng tại nhánh đầu tiên khớp):
   1. `decision.error` → reply + QR "Chat tư vấn viên"
   2. `decision.action==='handoff_cskh'` → xem `follow.md` mục 8 (có guard chặn lặp ở `AWAITING_PHONE`)
   3. `decision.off_topic_kind==='manufacture_year'` → FAQ cố định, replay card cũ
   3b. `decision.off_topic_kind==='garage_contact'` (hỏi địa chỉ/SĐT gara) → FAQ cố định, replay card cũ — CÙNG SHAPE với manufacture_year, dùng chung `replyFaqWithReplayCard()`. Prompt bắt buộc AI dùng off_topic_kind này thay vì action='handoff_cskh' cho nhóm câu hỏi này (khác với "còn hàng không"/"gai lốp thế nào" — nhóm đó KHÔNG có FAQ cố định nên vẫn đi handoff_cskh, xem mục "KHÁCH HỎI ĐIỀU BẠN KHÔNG CÓ DỮ LIỆU" trong ai-helper.ts).
   3c. `decision.off_topic_kind==='generic_price_inquiry'` (hỏi giá chung chung, chưa đủ 3 trường) → `handleGenericPriceInquiry()`: tính field còn thiếu deterministically từ `newState` qua `genericPriceInquiryQuestion()` (size→brand→khu vực, KHÔNG dùng `decision.reply`), gửi câu hỏi cố định tương ứng (kèm `V3_BRAND_QRS()` nếu đang hỏi brand). Trả `false`/fallthrough xuống nhánh 7 nếu state THỰC RA đã đủ 3 trường (hiếm). Xem `follow.md` mục 2 (lý do KHÔNG để AI tự soạn câu hỏi field — đã thử, AI đoán sai field 3/3 lần test).
   4. `locationHandoffReason` (fail_location chạm giới hạn) → `cskhHandoff`
   5. `locationAskAgainMsg` → hỏi lại khu vực
   6. `needWardConfirm` (đa khớp ward) → QR chọn ward
   7. Đủ 3 field (size+brand+location) VÀ `relevantFieldUpdated` VÀ không phải case xe-cần-hỏi-size → `dispatchAndShowResults`
   8. `carWantsOptions` (có tên xe, chưa có size explicit) → `resolveCarModel` → `showCarSizeOptions`
   9. Fallback: gửi `decision.reply` (+ kèm brand QR nếu đang hỏi brand) + safety-net hỏi field còn thiếu nếu AI quên hỏi

## 5. Pattern "so sánh cũ/mới" — ĐỌC KỸ TRƯỚC KHI THÊM LOGIC MỚI

`v3GatherTurn` có thể trả lại field KHÔNG đổi (echo). Mọi biến "X đã đổi chưa" trong `handleGathering` PHẢI so sánh `decision.updates.X` với `state.X` (giá trị TRƯỚC turn này), không chỉ check truthy. Danh sách các biến đã áp dụng đúng pattern này (tham khảo khi thêm field mới):

- `isFreshPriceUpdate` — `decision.updates.max_price != null && !== state.max_price`
- `changedCoreField` — dùng để quyết định reset `max_price`; so sánh size/brand_tier/selected_brands (qua `JSON.stringify`)/province đều với state cũ
- `isFreshLocationUpdate` — gate cho toàn bộ khối resolve location (mục 4 bước 4)
- `sizeChanged` / `brandChanged` / `provinceChanged` → gộp thành `relevantFieldUpdated` — gate cho `dispatchAndShowResults`
- `carModelChanged` — `!!decision.updates.car_model && decision.updates.car_model !== state.car_model`; gate cho `carWantsOptions` (nhánh "xe mới → xoá `tire_size` + show size options lại")

**`brandChanged` và `changedCoreField` từng SAI** (chỉ check `decision.updates.selected_brands.length > 0`, không so sánh state cũ) → sửa 2026-07-24 sau khi phát hiện qua live-test: khách nói "Cảm ơn" sau khi có kết quả khiến bot tự động fetch + gửi lại y nguyên card sản phẩm. **`carWantsOptions` từng SAI theo đúng kiểu tương tự** (chỉ check `decision.updates.car_model` truthy) → sửa 2026-08-06: khách đã xác nhận xong size, lượt sau chỉ gõ tên khu vực nhưng AI vẫn echo lại `car_model` cũ trong `updates` → xoá oan `tire_size` vừa khoá + gọi lại `resolveCarModel` vô nghĩa trên tin nhắn khu vực, xem `follow.md` mục 2. **Nếu thêm field mới vào state (vd 1 tiêu chí lọc mới), PHẢI thêm vào các biến "changed" này theo đúng pattern so sánh — không copy nhầm kiểu check truthy-only.**

## 6. Chỗ dễ sót khi sửa (checklist)

- **Điều kiện "đủ field 2" (brand/tier/price/best-quality) rải rác ~7 chỗ** trong `v3/flow-handler.ts` (`deriveLastAsked`, `nextMissingFieldQuestion`, `handleBrandNameChoice`, `handleBrandTierChoice`, `handleWardChoice`, `handleImage`, `handleGathering` x2). Web chỉ có 1 chỗ tập trung (`hasTireBrand()` trong `stateMachine.ts`).
- **Mọi thay đổi field logic phải mirror Web** (`src/libs/chat/`) — trừ phần chỉ FB (Handover Protocol, CSKH echo detection, `MessengerStep`, sequential push messages qua `reply()`).
- **Câu chữ cố định** (FAQ năm sản xuất, closing message CSKH) định nghĩa ở hằng số riêng — KHÔNG để trong prompt AI, vì AI được yêu cầu đa dạng hoá câu chữ ở chỗ khác.
- **`cskhHandoff()` không nên có tin nhắn phụ trước nó** — mọi call site nên gọi trực tiếp (không `reply(decision.reply)` trước), xem `follow.md` mục 8.
- **Ward-fallback fuzzy match** (`findWardsByText`) chỉ được dùng ở nhánh yêu cầu khách xác nhận qua QR (nhiều kết quả) — KHÔNG BAO GIỜ tự động chấp nhận 1 kết quả duy nhất mà không qua `resolveAddress` trước.
- **`fail_size` / `fail_brand` / `fail_location`** — mỗi field-đang-hỏi có counter riêng, ngưỡng chung `MAX_FAIL_PER_STEP` (hiện = 2). Đừng dùng chung 1 counter cho nhiều field khác nhau.
- **Khi thêm ví dụ extraction mới vào prompt (ai-helper.ts/webGatherTurn.ts), 1 ví dụ dạng ngắn gọn KHÔNG đủ generalize sang câu hỏi tự nhiên đầy đủ.** Bug thật 2026-08-06: chỉ có ví dụ "michelin vf6" cho quy tắc KẾT HỢP BRAND+CAR → AI bỏ sót brand khi khách hỏi "lốp mít có dùng cho xe i10 không" (brand xen giữa câu hỏi). Với field quan trọng (brand, size), nên thêm ít nhất 1 ví dụ dạng câu hỏi tự nhiên đầy đủ bên cạnh ví dụ ngắn gọn.
- **KHÔNG giao cho AI tự suy luận "field nào đang thiếu" bằng văn xuôi khi đã có deterministic helper sẵn (`nextMissingTireField`/`hasTireBrand`/`hasLocation`...).** Bug thật 2026-08-06 (xem mục 4.3c): dù prompt có ví dụ tương phản rõ ràng, AI vẫn áp nhầm ví dụ 3/3 lần test khi state thực tế khác ví dụ. Pattern đúng: AI chỉ cần phát tín hiệu phân loại (`off_topic_kind`), CODE tính field còn thiếu + soạn câu hỏi cố định.
- **`dispatchAndShowResults()`/`hasBrandField()` (v3/flow-handler.ts) nay có `export`** — dùng ở `production/flow-handler.ts` cho feature "tự gửi lại card SP khi CSKH nhắc xem khuyến mại mà chưa có card gần đó" (xem `follow.md` mục 9). Bất kỳ call site MỚI nào gọi `dispatchAndShowResults` từ NGOÀI `handleGathering` bình thường PHẢI nhớ nó tự set `is_active=true` + đổi `step` — nếu gọi trong lúc session đang `is_paused_by_cskh`, PHẢI `pauseSessionByCskh()` lại ngay sau, nếu không bot sẽ vô tình unpause.
- **Mọi điểm check `session.is_paused_by_cskh` để quyết định bot có im lặng không PHẢI đi qua `resolveEffectiveSession()`/`getEffectiveSession()` (session.ts / production/flow-handler.ts), KHÔNG check thẳng field.** Đây là cơ chế tự hết hạn pause sau 8h (`CSKH_PAUSE_EXPIRY_MS`) — check thẳng field sẽ bỏ sót cơ chế hết hạn, quay lại bug "bot im lặng vĩnh viễn" (xem `follow.md` mục 9). Danh sách chỗ ĐÃ áp dụng đúng (tham khảo khi thêm chỗ mới): `production/flow-handler.ts` — `getEffectiveSession()` (dùng ở nhánh CSKH echo, standby, messaging) + ad-echo branch; `v3/flow-handler.ts` — dispatcher chính (2 chỗ: `getActiveSession` + fallback `getLatestSession`), CSKH-echo branch, ad-echo branch.
- **Thêm field mới vào `SessionState`/`WebChatState` → cân nhắc luôn có nên đưa vào `pickCarryOverState()` không** (`session.ts` mục FB, `stateMachine.ts` mục Web — xem `follow.md` mục 9b). Field "đã thu thập" thật (khách cung cấp, còn đúng lâu dài) → thêm vào allowlist. Field ephemeral/turn-scoped (gắn với 1 tin nhắn cụ thể, vd list vừa show/fail counter/flag đã gửi nudge) → KHÔNG thêm, để bị xoá khi session tách sau 24h — mặc định AN TOÀN hơn nếu quên: field mới không trong allowlist sẽ bị coi là ephemeral (mất khi tách), không phải ngược lại.

## 7. Testing methodology

**FB**: qua `debug.controller.ts` — `POST /api/debug/simulate-message {psid, text}` và `POST /api/debug/simulate-qr {psid, payload}` (cả 2 async fire-and-forget, trả 202 ngay). `GET /api/debug/session/:psid` xem state + `conversation_log` đầy đủ. FB Graph API LUÔN reject fake PSID (`sendMessage failed code=100`) → **không đọc được nội dung tin bot gửi qua log `[ERROR] sendMessage failed`** — verify qua console log (`[V3 gather]`, `[AI ...]`, `[V3 dispatch]`, `[DB ...]`) + session state persisted, KHÔNG qua nội dung tin nhắn thực tế. Tiếng Việt có dấu → gửi qua `curl --data-binary @file.json` (file viết bằng tool Write), KHÔNG dùng `-d` inline (Windows bash mangle dấu).

**Web**: gọi thẳng `POST /api/chat` (trả response đầy đủ, đồng bộ, đọc được cả nội dung bubble) — dùng script harness `test_web_chat.js` (scratchpad) với `runScenario(name, turns)` thread state qua nhiều turn.

**Dev server gotcha (Windows)**: `npm run start:dev` (FB, port 3002) / `npm run dev` (Web, port 3000) chạy nền có thể sống sót qua session boundary → `EADDRINUSE` khi start lại. Check `netstat -ano | grep ":3002" | grep LISTENING` lấy PID, `taskkill //PID <pid> //F`. Nest watch mode đôi khi restart nhưng process cũ chưa kịp release port → cùng lỗi `EADDRINUSE`, cần kill thủ công rồi start lại.

**Timer thật trong flow**: `SHOWING_RESULTS_LOCAL` → `AWAITING_BOOKING_STATE` có delay ~15-20s (timer nudge) trước khi chuyển step — test script cần `sleep` đợi qua bước này trước khi giả lập turn tiếp theo, nếu không session vẫn ở `SHOWING_RESULTS_LOCAL` (im lặng theo thiết kế) và tin nhắn test sẽ bị bỏ qua.

## 8. Database / location data

- `province.json` — 34 tỉnh/TP hiện hành (sau sáp nhập 2025/2026).
- `ward.json` — toàn bộ phường/xã, mỗi entry có `parent_code` (tỉnh) + `path`/`path_with_type` (chuỗi đầy đủ "Phường X, Tỉnh Y" — **path LUÔN chứa tên tỉnh làm substring**, đây là lý do fuzzy-search ward theo tên tỉnh trần trụi sẽ khớp toàn bộ ward trong tỉnh đó, xem `follow.md` mục 3 ⚠️).
- `MERGED_PROVINCE_ALIASES` (`db.ts`) — 29 tỉnh cũ đã sáp nhập + ~50 thành phố/thị xã cũ (tỉnh lỵ, nằm trong 1 tỉnh cũ, tên KHÁC tên tỉnh — vd "Vĩnh Yên" khác "Vĩnh Phúc") → tỉnh mới + ward đại diện. Danh sách city-level tra từ `old_data.txt` (86 dòng, do user cung cấp), verify từng ward.json (không suy đoán). Đồng bộ với `src/libs/chat/db/locationResolve.ts` + `src/libs/chat/tireDb.ts` bên Web (cùng tên hằng số/hàm, `tireDb.ts` giữ bản `resolveProvinceCodeFromText`/`stripVn` riêng — nhớ sửa CẢ 2 file Web khi đổi).
- Bảng Supabase chính: `fb_messenger_sessions` (session + state + conversation_log dạng JSON array), sản phẩm/gara nằm ở schema chung project Next.js (query qua `db.ts`/`tireDb.ts`).
