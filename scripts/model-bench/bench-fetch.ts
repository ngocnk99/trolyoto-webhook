/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  bench-fetch — patch `globalThis.fetch` CHỈ TRONG TIẾN TRÌNH BENCHMARK để:
 *   1. Bỏ `temperature` khi chạy model suy luận. `@ai-sdk/openai@0.0.9` LUÔN tự
 *      gửi `temperature: 0`, còn gpt-5.6-luna/gpt-6-luna từ chối mọi giá trị
 *      khác 1 → không bỏ thì 400 `unsupported_value` (đã đo, xem sdk-probe.ts).
 *   2. Chèn `reasoning_effort` (mặc định 'none') — token suy luận bị tính giá
 *      OUTPUT, để mặc định (medium) thì so sánh chi phí sẽ sai lệch.
 *   3. Ghi lại usage + độ trễ TỪNG request thật (kể cả retry của SDK, vốn tính
 *      tiền 3 lần khi schema fail) để tính chi phí từ số token thật, không ước.
 *
 *  KHÔNG đụng code production: harness import file này TRƯỚC khi import ai-helper.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface BenchCall {
  model: string
  ms: number
  ok: boolean
  status: number
  promptTokens: number
  cachedTokens: number
  completionTokens: number
  reasoningTokens: number
  error?: string
}

let calls: BenchCall[] = []

/** Giá USD / 1 triệu token (cập nhật 2026-09-24) — đồng bộ src/ai/usage-log.ts. */
export const PRICES: Record<
  string,
  { input: number; cached: number; output: number }
> = {
  'gpt-4o': { input: 2.5, cached: 1.25, output: 10 },
  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 }
}

export function priceFor(model: string): {
  input: number
  cached: number
  output: number
} {
  if (PRICES[model]) return PRICES[model]
  const key = Object.keys(PRICES)
    .filter(k => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]
  if (!key) throw new Error(`[bench] thiếu giá cho model "${model}"`)
  return PRICES[key]
}

export function costOf(c: BenchCall): number {
  const p = priceFor(c.model)
  const uncached = Math.max(0, c.promptTokens - c.cachedTokens)
  return (
    (uncached * p.input + c.cachedTokens * p.cached + c.completionTokens * p.output) /
    1_000_000
  )
}

/** Model suy luận — không nhận temperature, nhận reasoning_effort. */
export function isReasoningModel(model: string): boolean {
  return /^gpt-(5\.6|6)-/.test(model)
}

export function installBenchFetch(opts: {
  model: string
  /** 'none' | 'low' | 'medium' | 'high'. Bỏ qua với model không suy luận. */
  effort?: string
}): void {
  const orig = globalThis.fetch
  const reasoning = isReasoningModel(opts.model)
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : input?.url
    if (!url?.includes('api.openai.com') || !init?.body) {
      return orig(input, init)
    }
    const body = JSON.parse(init.body as string)
    if (reasoning) {
      delete body.temperature
      body.reasoning_effort = opts.effort ?? 'none'
    }
    const t0 = Date.now()
    const res = await orig(input, { ...init, body: JSON.stringify(body) })
    const ms = Date.now() - t0
    const clone = res.clone()
    let json: any = null
    try {
      json = await clone.json()
    } catch {
      /* body không phải JSON (stream) — bỏ qua, vẫn ghi latency */
    }
    const u = json?.usage
    calls.push({
      model: json?.model ?? body.model ?? opts.model,
      ms,
      ok: res.ok,
      status: res.status,
      promptTokens: u?.prompt_tokens ?? 0,
      cachedTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
      completionTokens: u?.completion_tokens ?? 0,
      reasoningTokens: u?.completion_tokens_details?.reasoning_tokens ?? 0,
      error: res.ok
        ? undefined
        : `${res.status} ${json?.error?.code ?? ''} ${json?.error?.message ?? ''}`.slice(
            0,
            200
          )
    })
    return res
  }) as typeof fetch
}

/** Lấy + xoá các call đã ghi kể từ lần gọi trước (gọi sau mỗi case). */
export function takeCalls(): BenchCall[] {
  const out = calls
  calls = []
  return out
}
