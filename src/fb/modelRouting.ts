/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  modelRouting — chọn model AI cho `v3GatherTurn`.
 *
 *  LỊCH SỬ
 *   - 2026-09-24: bật A/B 50/50 gpt-4o-mini / gpt-6-luna cho session MỚI,
 *     model chốt 1 lần vào `state.ai_model` để 1 hội thoại không trộn 2 model.
 *   - 2026-09-28: A/B kết thúc, chuyển HẲN sang gpt-6-luna (số liệu bên dưới).
 *
 *  Hai chốt chặn sinh ra từ benchmark và vẫn cần thiết: bỏ sót giá khi khách so
 *  giá → `priceMarker.extractExplicitPriceVnd`; AI echo lại state cũ →
 *  `dropEcho` trong ai-helper.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { SessionState } from './types'

/**
 * ĐÃ CHỐT (2026-09-28): dùng gpt-6-luna cho MỌI session. Kết quả A/B 4 ngày
 * trên khách thật (107 session gpt-4o-mini / 106 session gpt-6-luna, 682 lượt):
 *
 *   | chỉ số                    | gpt-4o-mini | gpt-6-luna |
 *   | chi phí / lượt            | $0.001415   | $0.000377 (−73%)
 *   | độ trễ trung bình         | 1906ms      | 1902ms
 *   | p95 / chậm nhất           | 3103/10267  | 2886/4092
 *   | lỗi API, retry            | 0 / 0       | 0 / 0
 *   | trích được size / khu vực | 65% / 53%   | 75% / 61%
 *   | số lần bot hiểu sai       | 16          | 10
 *   | session lỗi               | 5           | 2
 *   | ra được sản phẩm          | 51%         | 57%
 *
 * Điểm DUY NHẤT luna kém: khách để lại SĐT 4/21 so với 9/20 lượt bot hỏi
 * (p≈0.09, chưa đủ ý nghĩa thống kê; soi tay 4 hội thoại thì lý do là khách
 * bực/hỏi việc ngoài lốp, không phải model sai). THEO DÕI TIẾP chỉ số này —
 * nếu sau ~100 lượt hỏi SĐT mà vẫn thấp rõ rệt thì rollback theo cách dưới.
 *
 * ROLLBACK KHẨN: đặt env `AI_MODEL=gpt-4o-mini` rồi restart — env THẮNG cả
 * `state.ai_model` đã lưu, nên mọi hội thoại (kể cả đang dở) quay về ngay.
 *
 * PHẠM VI: chỉ `v3GatherTurn`. Các hàm AI khác (resolveCarModel,
 * resolveAddress, extractTireSize...) vẫn gpt-4o-mini và `analyzeTireImage`
 * vẫn gpt-4o — benchmark cho thấy luna đọc SAI thương hiệu trên ảnh 100%
 * (0/20 ảnh RoadX), tuyệt đối không đổi vision sang luna.
 */
export const DEFAULT_MODEL = 'gpt-6-luna'

/** Đặt env để ép TOÀN BỘ về 1 model (rollback) — thắng cả state đã lưu. */
const ENV_OVERRIDE = process.env.AI_MODEL

/** Model cho session MỚI — vẫn ghi vào `state.ai_model` để log/đối chiếu. */
export function pickModelForNewSession(): string {
  return ENV_OVERRIDE ?? DEFAULT_MODEL
}

/**
 * Model của 1 session đang chạy. Session tạo trong giai đoạn A/B đã ghi sẵn
 * `ai_model` thì GIỮ NGUYÊN model đó tới hết hội thoại (không đổi giữa chừng,
 * session hết hạn sau 8h nên tự hết). Session cũ không có field → model mặc định.
 */
export function modelForSession(state: SessionState | null | undefined): string {
  return ENV_OVERRIDE ?? state?.ai_model ?? DEFAULT_MODEL
}

export function getRoutingStatus() {
  return { defaultModel: DEFAULT_MODEL, envOverride: ENV_OVERRIDE ?? null }
}
