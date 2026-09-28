# model-bench — so sánh model AI cho chatbot

Đo `v3GatherTurn` (lời gọi AI chính, ~76% chi phí AI) và `analyzeTireImage`
(đọc ảnh lốp) giữa các model, trên case thật lấy từ DB production.

Dựng 2026-09-24 khi cân nhắc đổi `gpt-4o-mini` → `gpt-5.6-luna` / `gpt-6-luna`.

## Chạy

```bash
cd fb-webhook-server

# 1. Rút 50 hội thoại thật từ fb_messenger_sessions (chỉ đọc DB)
npx ts-node --transpile-only -r dotenv/config scripts/model-bench/build-corpus.ts 50

# 2. Chạy từng model (1 tiến trình / 1 model — model đọc từ env lúc import)
for M in gpt-4o-mini gpt-5.6-luna gpt-6-luna; do
  AI_USAGE_LOG_ENABLED=false AI_MODEL=$M BENCH_EFFORT=none \
    npx ts-node --transpile-only -r dotenv/config scripts/model-bench/run-bench.ts
done

# 3. Chấm điểm + bảng so sánh (baseline mặc định gpt-4o-mini)
npx ts-node --transpile-only scripts/model-bench/report.ts

# 4. Đọc ảnh lốp (bộ ảnh RoadX: thấy hãng, KHÔNG thấy size → test bịa đặt)
for M in gpt-4o gpt-4o-mini gpt-5.6-luna gpt-6-luna; do
  AI_USAGE_LOG_ENABLED=false VISION_MODEL=$M \
    npx ts-node --transpile-only -r dotenv/config scripts/model-bench/vision-bench.ts 20
done
```

`AI_USAGE_LOG_ENABLED=false` là BẮT BUỘC — không thì mỗi lượt benchmark ghi 1
dòng vào `ai_call_log`, làm hỏng số liệu chi phí production.

## File

| File | Việc |
|---|---|
| `bench-fetch.ts` | Patch `fetch` trong tiến trình test: bỏ `temperature` (model suy luận từ chối), chèn `reasoning_effort`, đo token/độ trễ từng request kể cả retry |
| `golden-cases.ts` | 30 case VÀNG — mỗi case là 1 bug thật trong `follow.md`, đáp án gán tay |
| `build-corpus.ts` | Rút hội thoại thật từ DB, phân 4 nhóm (có kết quả / CSKH / theo tên xe / có nêu giá) |
| `run-bench.ts` | Chạy toàn bộ case với 1 model, ghi `result-<model>-<effort>.json` |
| `report.ts` | Chấm điểm, bảng chi phí/tốc độ, dự phóng chi phí tháng, xuất `diffs.json` |
| `vision-bench.ts` | Đo đọc ảnh lốp; tự dựng HTTP server tạm phục vụ ảnh cục bộ |
| `sdk-probe.ts` | Kiểm tra SDK cũ (`@ai-sdk/openai@0.0.9`) có gọi được model mới không |

Kết quả ghi ra scratchpad, KHÔNG ghi vào repo (chứa nội dung chat thật của khách).

## Kết quả A/B (24/9 → 28/9/2026) — ĐÃ CHUYỂN HẲN SANG gpt-6-luna

107 session `gpt-4o-mini` vs 106 session `gpt-6-luna` trên khách thật, 682 lượt gọi:

| Chỉ số | gpt-4o-mini | gpt-6-luna |
|---|---|---|
| Chi phí / lượt | $0.001415 | **$0.000377** (−73%) |
| Độ trễ trung bình | 1906ms | 1902ms |
| p95 / chậm nhất | 3103ms / 10267ms | **2886ms / 4092ms** |
| Lỗi API / retry | 0 / 0 | 0 / 0 |
| Trích được size / khu vực | 65% / 53% | **75% / 61%** |
| Số lần bot hiểu sai (fail_*) | 16 | **10** |
| Session lỗi | 5 | **2** |
| Ra được sản phẩm | 51% | **57%** |
| Khách để lại SĐT khi được hỏi | **9/20** | 4/21 |

Chỉ số cuối là điểm DUY NHẤT luna kém (p≈0.09, chưa đủ ý nghĩa thống kê; soi
tay 4 hội thoại thấy lý do là khách bực/hỏi việc ngoài lốp) — **vẫn phải theo
dõi tiếp**, đủ ~100 lượt hỏi SĐT mà còn thấp rõ thì rollback.

Rollback khẩn: đặt env `AI_MODEL=gpt-4o-mini` rồi restart (thắng cả
`state.ai_model` đã lưu). Xem `src/fb/modelRouting.ts`.

Phạm vi đổi: CHỈ `v3GatherTurn`. `analyzeTireImage` vẫn `gpt-4o` (luna đọc sai
thương hiệu 20/20 ảnh), các hàm AI phụ vẫn `gpt-4o-mini` (chưa benchmark).

**Theo dõi — chi phí, tốc độ, lỗi theo nhánh:**

```sql
SELECT l.model, count(*) calls,
       round(sum(l.cost_usd)::numeric, 4) cost_usd,
       round(avg(l.cost_usd)::numeric, 6) cost_moi_luot,
       round(avg(l.duration_ms)::numeric) avg_ms,
       count(*) FILTER (WHERE NOT l.ok) loi
FROM ai_call_log l
WHERE l.fn = 'v3GatherTurn' AND l.created_at >= now() - interval '7 days'
GROUP BY 1 ORDER BY 1;
```

**Theo dõi — kết quả hội thoại theo nhánh (tỉ lệ ra được SP, tỉ lệ phải đẩy CSKH):**

```sql
SELECT COALESCE(state->>'ai_model', 'gpt-4o-mini (session cũ)') model,
       count(*) sessions,
       count(*) FILTER (WHERE (state->>'has_shown_results')::boolean) co_ket_qua,
       count(*) FILTER (WHERE state->>'cskh_reason' IS NOT NULL) phai_cskh,
       count(*) FILTER (WHERE state->>'phone' IS NOT NULL) de_lai_sdt
FROM fb_messenger_sessions
WHERE created_at >= now() - interval '7 days' AND psid NOT LIKE 'test\_%'
GROUP BY 1 ORDER BY 1;
```

Chốt chặn đã thêm cho nhánh model mới (đều log ra console để đếm tần suất):
`BỔ SUNG max_price=` (AI bỏ sót giá, luật cố định bắt lại),
`BỎ echo <field>` (AI nhắc lại field đã có trong state),
`province_name=... KHÔNG xuất hiện nguyên văn` (cảnh báo nghe nhầm địa danh).

## Ràng buộc đã phát hiện (2026-09-24)

- `@ai-sdk/openai@0.0.9` **luôn gửi `temperature: 0`**; `gpt-5.6-luna`/`gpt-6-luna`
  từ chối mọi giá trị khác 1 → lỗi 400. Muốn đổi model thật phải bỏ `temperature`
  (FB không truyền, nhưng Web `webGatherTurn` đang đặt `temperature: 0.3`).
- Model suy luận mặc định sinh token suy luận, tính giá OUTPUT → phải đặt
  `reasoning_effort: 'none'` mới so sánh chi phí công bằng.
- Bảng giá trong `src/ai/usage-log.ts` phải có model mới, nếu không `cost_usd`
  ghi 0 âm thầm (`priceFor` trả null).
- Cách gộp state trong `run-bench.ts` là bản RÚT GỌN của `flow-handler.ts`
  (không có `priceMarker`, `brandAliases`, `parseExplicitTireSize`) — cố ý, để
  đo model tự nó, vì mỗi chốt chặn đó sinh ra từ 1 lần model hiểu sai.
