/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  openai-reasoning — provider OpenAI riêng cho MODEL SUY LUẬN (gpt-5.6-*,
 *  gpt-6-*), vá đúng 2 chỗ `ai@3` + `@ai-sdk/openai@0.0.72` chưa biết:
 *
 *   1. `generateObject` của ai@3 LUÔN gửi `temperature: 0`; model suy luận chỉ
 *      nhận mặc định (1) → 400 `unsupported_value`. Phải XOÁ field.
 *   2. SDK ép schema bằng function tools trên `/v1/chat/completions`, mà ở đó
 *      OpenAI BẮT BUỘC `reasoning_effort: 'none'` — không gửi gì cũng lỗi.
 *      Phải THÊM field.
 *
 *  Cả 2 đo trực tiếp 2026-09-24 (scripts/model-bench/sdk-probe.ts). Đã thử các
 *  cách khác và KHÔNG được, đừng làm lại:
 *   - Nâng provider 0.0.9 → 0.0.72: `temperature: 0` do ai@3 đặt, không phải
 *     provider → vẫn lỗi.
 *   - `structuredOutputs: true` (đổi sang response_format json_schema): SDK
 *     sinh JSON schema thiếu `required` → OpenAI từ chối, lỗi CẢ với gpt-4o-mini.
 *   - `temperature: 1` ở call site: qua được lỗi (1) nhưng vẫn kẹt lỗi (2).
 *
 *  Dùng `fetch` RIÊNG của provider (0.0.72 hỗ trợ; 0.0.9 bỏ qua tuỳ chọn này)
 *  thay vì patch `globalThis.fetch` — chỉ ảnh hưởng đúng các call dùng provider
 *  này, không đụng gpt-4o/gpt-4o-mini và các module khác.
 *
 *  KHI NÂNG `ai` lên v4/v5 (có `providerOptions.openai.reasoningEffort`) thì
 *  XOÁ file này, đừng để 2 lớp cùng sửa request.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { openai, createOpenAI } from '@ai-sdk/openai'

export function isReasoningModel(model: string | undefined): boolean {
  return !!model && /^gpt-(5\.6|6)[-.]/.test(model)
}

const reasoningFetch: typeof globalThis.fetch = async (input, init) => {
  if (init?.body && typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body)
      delete body.temperature
      if (body.reasoning_effort == null) {
        body.reasoning_effort = process.env.OPENAI_REASONING_EFFORT ?? 'none'
      }
      init = { ...init, body: JSON.stringify(body) }
    } catch {
      /* body không phải JSON — để nguyên */
    }
  }
  return globalThis.fetch(input, init)
}

const reasoningProvider = createOpenAI({ fetch: reasoningFetch })

/**
 * Lấy model instance đúng loại: model suy luận đi qua provider có fetch vá,
 * còn lại dùng provider mặc định (hành vi cũ, không đổi gì).
 */
export function openaiModel(model: string) {
  return isReasoningModel(model) ? reasoningProvider(model) : openai(model)
}
