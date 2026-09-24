/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  modelRouting — chia luồng A/B model cho `v3GatherTurn`.
 *
 *  LUẬT (user chốt 2026-09-24):
 *   - Session CŨ (state chưa có `ai_model`) → LUÔN dùng model cũ, không đổi
 *     giữa chừng. Hội thoại đang dở mà đổi model sẽ lẫn 2 hành vi, log vô nghĩa.
 *   - Session MỚI → bốc ngẫu nhiên 50/50 giữa `MODEL_A` và `MODEL_B`, CHỐT 1
 *     LẦN vào `state.ai_model` để mọi lượt sau dùng lại đúng model đó.
 *
 *  Tắt khẩn cấp: `AB_MODEL_ENABLED=false` → mọi session mới về model A.
 *
 *  Cơ sở chọn gpt-6-luna làm nhánh B — benchmark 2026-09-24 (scripts/model-bench):
 *  rẻ hơn 72%/tháng, case vàng 29/30 vs 26/30, nhưng chậm hơn ~35% và còn 2
 *  điểm yếu đã được chốt chặn bằng code (bỏ sót giá khi khách so giá → xem
 *  `priceMarker.extractExplicitPriceVnd`; echo state → `dropEcho` trong
 *  ai-helper). Vision (analyzeTireImage) KHÔNG đổi — luna đọc sai hãng 100%.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { SessionState } from './types'

export const MODEL_A = process.env.AB_MODEL_A ?? 'gpt-4o-mini'
export const MODEL_B = process.env.AB_MODEL_B ?? 'gpt-6-luna'
const ENABLED = process.env.AB_MODEL_ENABLED !== 'false'
/** Tỉ lệ % session mới rơi vào nhánh B. */
const PERCENT_B = Number(process.env.AB_MODEL_PERCENT_B ?? 50)

/** Model cho session MỚI — gọi đúng 1 lần lúc tạo session. */
export function pickModelForNewSession(): string {
  if (!ENABLED) return MODEL_A
  return Math.random() * 100 < PERCENT_B ? MODEL_B : MODEL_A
}

/**
 * Model của 1 session đang chạy. Session cũ (chưa có `ai_model`) → MODEL_A,
 * KHÔNG bốc lại: giữ nguyên hành vi cũ cho hội thoại đã bắt đầu trước thử nghiệm.
 */
export function modelForSession(state: SessionState | null | undefined): string {
  return state?.ai_model ?? MODEL_A
}

export function getRoutingStatus() {
  return { enabled: ENABLED, modelA: MODEL_A, modelB: MODEL_B, percentB: PERCENT_B }
}
