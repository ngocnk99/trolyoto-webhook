/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  usage-log — đo chi phí token OpenAI, 1 dòng DB = 1 request HTTP
 *
 *  VẤN ĐỀ: dashboard OpenAI chỉ nói "ngày X tốn $Y cho model Z". Không biết
 *  request đến từ bot FB hay chat web hay cron, do hàm nào gọi, và 1 tin nhắn
 *  khách kéo theo mấy lượt gọi. Thiếu dữ kiện đó thì không đối chiếu được hoá
 *  đơn với lưu lượng thật, cũng không kết luận được key có bị dùng ngoài không.
 *
 *  CÁCH LÀM: chặn ở TẦNG fetch chứ không phải tầng hàm.
 *    - @ai-sdk/provider-utils gọi `fetch(...)` trần → resolve `globalThis.fetch`
 *      lúc chạy, nên patch global là bắt được mọi request, KỂ CẢ retry nội bộ
 *      của AI SDK (mặc định `maxRetries: 2` → 1 lần fail = 3 request bị tính
 *      tiền). Log ở tầng hàm sẽ không thấy 2 request thừa đó — đúng chỗ hay
 *      gây lệch giữa hoá đơn và lưu lượng.
 *    - Đọc `usage.prompt_tokens_details.cached_tokens` từ body thật, vì
 *      @ai-sdk/openai@0.0.9 (bản đang cài) KHÔNG map cached tokens ra ngoài.
 *
 *  Ngữ cảnh (app/source/fn/psid/turn) đi theo AsyncLocalStorage — an toàn khi
 *  nhiều webhook chạy song song, không phải luồn tham số qua từng hàm.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { supabaseAmin } from '../fb/supabase'

const APP = 'fb-webhook'
const OPENAI_HOST = 'https://api.openai.com'

/** Bật/tắt ghi DB (đo lỗi hạ tầng thì tắt tạm, vẫn giữ log console). */
const ENABLED = process.env.AI_USAGE_LOG_ENABLED !== '0'

// ── Bảng giá USD / 1 triệu token ────────────────────────────────────────────
// Chỉ để tính SẴN cost_usd cho tiện query. Token thô vẫn lưu nguyên trong DB
// nên giá đổi thì tính lại được, không mất dữ liệu.
interface Price {
  input: number
  cached: number
  output: number
}
const PRICES: Record<string, Price> = {
  'gpt-4o': { input: 2.5, cached: 1.25, output: 10 },
  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 },
  'text-embedding-3-small': { input: 0.02, cached: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, cached: 0.13, output: 0 }
}

/** Khớp giá theo prefix để bản có hậu tố ngày (gpt-4o-2024-08-06) vẫn ra đúng. */
function priceFor(model: string): Price | null {
  if (PRICES[model]) return PRICES[model]
  const key = Object.keys(PRICES)
    .filter(k => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]
  return key ? PRICES[key] : null
}

function costUsd(
  model: string,
  promptTokens: number,
  cachedTokens: number,
  completionTokens: number
): number {
  const p = priceFor(model)
  if (!p) return 0
  const uncached = Math.max(0, promptTokens - cachedTokens)
  return (
    (uncached * p.input + cachedTokens * p.cached + completionTokens * p.output) /
    1_000_000
  )
}

// ── Ngữ cảnh 1 lượt xử lý ───────────────────────────────────────────────────

export type AiSource =
  | 'fb-v2'
  | 'fb-v3'
  | 'fb-prod'
  | 'cron-search-alias'
  // GĐ4 search-suggest-v2 (branch feature/task-search-suggest-v2-alias-mining,
  // chưa merge): embedding-cron.ts gọi thẳng REST /v1/embeddings bằng `fetch`
  // nên interceptor bắt được ngay, chỉ cần bọc runEmbeddingBackfill trong
  // withAiTurn({ source: 'cron-search-embed' }) lúc merge để có nhãn nguồn.
  | 'cron-search-embed'
  | 'script'
  | 'unknown'

export interface AiCallContext {
  source: AiSource
  /** Tên hàm gọi AI — set bởi `withAiCall()` ở từng helper. */
  fn: string
  psid?: string
  sessionId?: string
  pageId?: string
  /** 1 turn = 1 tin nhắn khách. Mọi call AI của cùng turn dùng chung id này. */
  turnId?: string
  hasImage?: boolean
  /** Đếm request thật trong cùng (turn, fn) — lộ ra retry của AI SDK. */
  attempts?: { n: number }
}

const aiContext = new AsyncLocalStorage<AiCallContext>()

/** Mở 1 turn: mọi call AI bên trong được gắn cùng `turn_id` + psid/session. */
export function withAiTurn<T>(
  ctx: Omit<AiCallContext, 'fn' | 'attempts'> & { fn?: string },
  run: () => Promise<T>
): Promise<T> {
  return aiContext.run(
    { ...ctx, fn: ctx.fn ?? '(turn)', turnId: ctx.turnId ?? randomUUID() },
    run
  )
}

/** Gắn tên hàm cho các request AI phát sinh bên trong `run` (kế thừa turn hiện tại). */
export function withAiCall<T>(fnName: string, run: () => Promise<T>): Promise<T> {
  const parent = aiContext.getStore()
  return aiContext.run(
    { source: 'unknown', ...parent, fn: fnName, attempts: { n: 0 } },
    run
  )
}

/** Bổ sung ngữ cảnh cho turn đang chạy (vd biết session_id sau khi load DB). */
export function setAiContext(patch: Partial<AiCallContext>): void {
  const store = aiContext.getStore()
  if (store) Object.assign(store, patch)
}

// ── Ghi DB ──────────────────────────────────────────────────────────────────

interface LogRow {
  app: string
  source: string
  fn: string
  endpoint: string
  model: string
  ok: boolean
  http_status: number | null
  attempt: number
  duration_ms: number
  error: string | null
  prompt_tokens: number
  cached_tokens: number
  completion_tokens: number
  total_tokens: number
  cost_usd: number
  psid: string | null
  session_id: string | null
  page_id: string | null
  turn_id: string | null
  has_image: boolean
}

async function insertRow(row: LogRow): Promise<void> {
  if (!ENABLED) return
  const { error } = await supabaseAmin.from('ai_call_log').insert(row)
  if (error) console.error('[ai-usage] insert failed:', error.message)
}

// ── Patch globalThis.fetch ──────────────────────────────────────────────────

const PATCHED = Symbol.for('trolyoto.aiUsageFetchPatched')

/**
 * Cài interceptor. Idempotent — gọi nhiều lần chỉ patch 1 lần. Gọi sớm nhất có
 * thể (đầu `main.ts`), trước khi bất kỳ module nào giữ tham chiếu tới `fetch`.
 */
export function installAiUsageLogging(): void {
  const g = globalThis as any
  if (g[PATCHED]) return
  const original: typeof fetch = g.fetch
  if (typeof original !== 'function') {
    console.error('[ai-usage] globalThis.fetch không tồn tại — bỏ qua logging')
    return
  }

  g.fetch = async function patchedFetch(
    input: any,
    init?: any
  ): Promise<Response> {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input?.url ?? '')
    if (!url.startsWith(OPENAI_HOST)) return original(input, init)

    const ctx = aiContext.getStore()
    if (ctx?.attempts) ctx.attempts.n += 1
    const attempt = ctx?.attempts?.n ?? 1
    const endpoint = url.slice(OPENAI_HOST.length).split('?')[0]
    // Model lấy từ request body — response lỗi (4xx/5xx) không có field model.
    let requestedModel = '(unknown)'
    try {
      const body = init?.body ?? (input?.body as any)
      if (typeof body === 'string') {
        requestedModel = JSON.parse(body).model ?? requestedModel
      }
    } catch {
      /* body không phải JSON — bỏ qua, vẫn log request */
    }

    const started = Date.now()
    let res: Response
    try {
      res = await original(input, init)
    } catch (e: any) {
      void insertRow(
        buildRow(ctx, {
          endpoint,
          model: requestedModel,
          ok: false,
          status: null,
          attempt,
          durationMs: Date.now() - started,
          error: `network: ${e?.message ?? String(e)}`,
          usage: null
        })
      )
      throw e
    }

    const durationMs = Date.now() - started
    // clone() để không "tiêu" body — AI SDK vẫn đọc bản gốc bình thường.
    let parsed: any = null
    let errText: string | null = null
    try {
      parsed = await res.clone().json()
    } catch {
      errText = res.ok ? null : `http ${res.status} (body không phải JSON)`
    }
    if (!res.ok && !errText) {
      errText = `http ${res.status}: ${JSON.stringify(
        parsed?.error ?? parsed
      ).slice(0, 500)}`
    }

    void insertRow(
      buildRow(ctx, {
        endpoint,
        model: parsed?.model ?? requestedModel,
        ok: res.ok,
        status: res.status,
        attempt,
        durationMs,
        error: errText,
        usage: parsed?.usage ?? null
      })
    )
    return res
  }

  g[PATCHED] = true
  console.log(
    '[ai-usage] fetch interceptor đã cài — mọi request OpenAI được ghi ai_call_log'
  )
}

function buildRow(
  ctx: AiCallContext | undefined,
  r: {
    endpoint: string
    model: string
    ok: boolean
    status: number | null
    attempt: number
    durationMs: number
    error: string | null
    usage: any
  }
): LogRow {
  const promptTokens = Number(r.usage?.prompt_tokens ?? 0)
  const cachedTokens = Number(r.usage?.prompt_tokens_details?.cached_tokens ?? 0)
  const completionTokens = Number(r.usage?.completion_tokens ?? 0)
  const totalTokens =
    Number(r.usage?.total_tokens ?? 0) || promptTokens + completionTokens
  return {
    app: APP,
    source: ctx?.source ?? 'unknown',
    fn: ctx?.fn ?? '(unknown)',
    endpoint: r.endpoint,
    model: r.model,
    ok: r.ok,
    http_status: r.status,
    attempt: r.attempt,
    duration_ms: r.durationMs,
    error: r.error ? r.error.slice(0, 1000) : null,
    prompt_tokens: promptTokens,
    cached_tokens: cachedTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cost_usd: Number(
      costUsd(r.model, promptTokens, cachedTokens, completionTokens).toFixed(6)
    ),
    psid: ctx?.psid ?? null,
    session_id: ctx?.sessionId ?? null,
    page_id: ctx?.pageId ?? null,
    turn_id: ctx?.turnId ?? null,
    has_image: ctx?.hasImage ?? false
  }
}
