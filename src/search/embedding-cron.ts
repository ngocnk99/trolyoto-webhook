/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Search Embedding Backfill — L2 semantic cho gợi ý tìm kiếm
 *  (task search-suggest-v2, Giai đoạn 4)
 *
 *  Embed `display` (+ nhãn facet) của search_dictionary bằng OpenAI
 *  text-embedding-3-small, ghi vào cột `embedding` qua RPC
 *  search_dictionary_set_embeddings (service key). Chạy đêm 03:00 VN — SAU
 *  search-dictionary-refresh 02:30 — và chỉ embed DELTA (dòng mới / display đổi)
 *  nhờ cột `embedded_text`. Backfill lần đầu ~6k dòng ≈ 30 lượt × 200 = vài
 *  chục giây, chi phí không đáng kể ($0.02/1M token).
 *
 *  Buyer dùng: route /api/suggest/semantic embed câu khách gõ → RPC
 *  search_suggest_semantic → tầng 3 khi L0+L1 không có gì ("kêu cọt kẹt khi
 *  phanh" → "Thay má phanh").
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { supabaseAmin } from '../fb/supabase'
import { chunk } from './alias-utils'

const MODEL = process.env.SEARCH_EMBED_MODEL ?? 'text-embedding-3-small'
const RUN_AT = process.env.SEARCH_EMBED_CRON_TIME ?? '03:00'
const BATCH = Number(process.env.SEARCH_EMBED_BATCH ?? 200)
const MAX_ROWS = Number(process.env.SEARCH_EMBED_MAX_ROWS ?? 3000)
const ENABLED = (process.env.SEARCH_EMBED_CRON_ENABLED ?? '1') !== '0'

/**
 * Gọi thẳng OpenAI REST /v1/embeddings: @ai-sdk/openai ^0.0.9 của repo này chưa có
 * `openai.embedding()`, và nâng SDK chỉ vì embedding là không đáng (ai-helper.ts đang
 * chạy ổn định trên bản cũ). fetch có sẵn từ Node 18.
 */
export async function openaiEmbed(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY missing')
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: texts })
  })
  if (!res.ok) throw new Error(`openai embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> }
  const out: number[][] = new Array(texts.length)
  for (const d of json.data) out[d.index] = d.embedding
  return out
}

const FACET_LABEL: Record<string, string> = {
  brand: 'hãng',
  size: 'cỡ lốp',
  carline: 'lốp theo dòng xe',
  brand_size: 'lốp theo hãng và cỡ',
  carline_brand: 'lốp theo dòng xe và hãng',
  carline_size: 'lốp theo dòng xe và cỡ',
  product: 'sản phẩm',
  service: 'dịch vụ gara',
  other: ''
}

/** Text đưa vào embedding: display + nhãn facet để phân biệt "Lốp Hankook (hãng)" vs SP cụ thể. */
export function embeddingText(display: string, facet: string | null, type: string): string {
  const label = FACET_LABEL[facet ?? 'other'] || (type === 'DICH_VU' ? 'dịch vụ gara' : '')
  return label ? `${display} (${label})` : display
}

export interface EmbedResult {
  dryRun: boolean
  startedAt: string
  durationMs: number
  pending: number
  embedded: number
  batches: number
  error?: string
}

let running = false
let lastResult: EmbedResult | null = null

export async function runEmbeddingBackfill(opts: { dryRun?: boolean } = {}): Promise<EmbedResult> {
  const dryRun = !!opts.dryRun
  const t0 = Date.now()
  const result: EmbedResult = {
    dryRun,
    startedAt: new Date(t0).toISOString(),
    durationMs: 0,
    pending: 0,
    embedded: 0,
    batches: 0
  }
  if (running) {
    result.error = 'already running'
    return result
  }
  running = true
  try {
    const { data, error } = await supabaseAmin.rpc('search_dictionary_pending_embeddings', {
      max_rows: MAX_ROWS
    })
    if (error) throw new Error(`pending: ${error.message}`)
    const rows = (data ?? []) as Array<{
      id: number
      display: string
      type: string
      kind: string
      facet: string | null
    }>
    result.pending = rows.length

    for (const batch of chunk(rows, BATCH)) {
      const texts = batch.map(r => embeddingText(r.display, r.facet, r.type))
      const embeddings = await openaiEmbed(texts)
      result.batches += 1
      if (dryRun) {
        result.embedded += batch.length
        continue
      }
      const payload = batch.map((r, i) => ({
        id: r.id,
        text: texts[i],
        embedding: JSON.stringify(embeddings[i])
      }))
      const { data: n, error: setErr } = await supabaseAmin.rpc('search_dictionary_set_embeddings', {
        rows: payload
      })
      if (setErr) throw new Error(`set_embeddings: ${setErr.message}`)
      result.embedded += Number(n) || 0
    }
  } catch (e) {
    result.error = (e as Error)?.message ?? String(e)
    console.error('[search-embedding] run failed:', result.error)
  } finally {
    running = false
    result.durationMs = Date.now() - t0
    lastResult = result
    console.log(
      `[search-embedding] ${dryRun ? 'DRY-RUN ' : ''}pending=${result.pending} embedded=${result.embedded} ` +
        `batches=${result.batches} ${result.durationMs}ms` + (result.error ? ` ERROR=${result.error}` : '')
    )
  }
  return result
}

/** Embed 1 câu (dùng cho probe/test; buyer có route riêng). */
export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await openaiEmbed([text])
  return vec
}

export function getSearchEmbeddingStatus() {
  return { enabled: ENABLED, runAt: RUN_AT, model: MODEL, running, lastResult }
}

function nowVN(): { hhmm: string; day: string } {
  const vn = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
  const hh = String(vn.getHours()).padStart(2, '0')
  const mm = String(vn.getMinutes()).padStart(2, '0')
  const day = `${vn.getFullYear()}-${String(vn.getMonth() + 1).padStart(2, '0')}-${String(vn.getDate()).padStart(2, '0')}`
  return { hhmm: `${hh}:${mm}`, day }
}

let lastRunDay: string | null = null
let timer: NodeJS.Timeout | null = null

export function startSearchEmbeddingCron(): void {
  if (!ENABLED) {
    console.log('[search-embedding] cron disabled (SEARCH_EMBED_CRON_ENABLED=0)')
    return
  }
  if (timer) return
  console.log(`[search-embedding] cron armed: daily ${RUN_AT} VN, model=${MODEL}`)
  timer = setInterval(() => {
    const { hhmm, day } = nowVN()
    if (hhmm !== RUN_AT || lastRunDay === day) return
    lastRunDay = day
    runEmbeddingBackfill().catch(e => console.error('[search-embedding] cron error:', e))
  }, 60_000)
}

export function stopSearchEmbeddingCron(): void {
  if (timer) clearInterval(timer)
  timer = null
}
