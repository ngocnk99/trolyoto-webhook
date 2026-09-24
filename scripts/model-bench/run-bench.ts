/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  run-bench — chạy TOÀN BỘ case (vàng + corpus thật) qua `v3GatherTurn` với
 *  1 model, ghi kết quả thô ra JSON. Chạy 1 tiến trình / 1 model vì model đọc
 *  từ env lúc import module (`AI_MODEL` trong src/fb/ai-helper.ts).
 *
 *    cd fb-webhook-server
 *    AI_USAGE_LOG_ENABLED=false AI_MODEL=gpt-4o-mini \
 *      npx ts-node --transpile-only -r dotenv/config scripts/model-bench/run-bench.ts
 *
 *  Env:
 *    AI_MODEL       model cần đo (mặc định gpt-4o-mini)
 *    BENCH_EFFORT   reasoning_effort cho model suy luận (mặc định 'none')
 *    BENCH_ONLY     'golden' | 'corpus' (mặc định chạy cả hai)
 *    AI_USAGE_LOG_ENABLED=false  BẮT BUỘC — tránh đổ rác vào bảng ai_call_log
 * ─────────────────────────────────────────────────────────────────────────────
 */
import fs from 'fs'
import path from 'path'
import { installBenchFetch, takeCalls, costOf, type BenchCall } from './bench-fetch'

installBenchFetch({
  model: process.env.AI_MODEL ?? 'gpt-4o-mini',
  effort: process.env.BENCH_EFFORT ?? 'none'
})

// Import SAU khi patch fetch (ai-helper đọc MODEL từ env lúc import).
import { v3GatherTurn, type V3GatherCollected } from '../../src/fb/ai-helper'
import { GOLDEN_CASES } from './golden-cases'
import type { CorpusSession } from './build-corpus'

const MODEL = process.env.AI_MODEL ?? 'gpt-4o-mini'
const EFFORT = process.env.BENCH_EFFORT ?? 'none'
const ONLY = process.env.BENCH_ONLY
const OUT_DIR =
  process.env.BENCH_OUT_DIR ??
  'C:/Users/Admin/AppData/Local/Temp/claude/c--code-FL-trolyoto-production-buyer/2d232071-314d-4740-8ffe-f3b8a42567be/scratchpad/model-bench'

export interface TurnResult {
  userInput: string
  updates: Record<string, unknown>
  action: string
  offTopicKind: string | null
  isOffTopic: boolean
  reply: string
  error?: boolean
  /** Mọi HTTP request thật của lượt này (SDK retry ⇒ nhiều hơn 1). */
  calls: BenchCall[]
  costUsd: number
  ms: number
}

export interface GoldenResult extends TurnResult {
  caseId: string
  group: string
}

export interface CorpusResult {
  sessionId: string
  bucket: string
  prodFinalState: Record<string, unknown>
  /** State cuối sau khi áp dụng update của CHÍNH model này qua từng lượt. */
  finalCollected: V3GatherCollected
  turns: TurnResult[]
}

/**
 * Gộp update vào state — bản RÚT GỌN của flow-handler (không có chốt chặn
 * deterministic: parseExplicitTireSize, resolveBrandAliasFromText,
 * hasExplicitPriceMarker...). Cố ý: đo model TỰ nó, và mọi model dùng CÙNG
 * một phép gộp nên vẫn công bằng.
 */
function mergeUpdates(
  state: V3GatherCollected,
  u: Record<string, any>
): V3GatherCollected {
  const next: V3GatherCollected = { ...state }
  if (u.tire_size) next.tire_size = u.tire_size
  if (u.brand_tier) next.brand_tier = u.brand_tier
  if (u.selected_brands?.length) next.selected_brands = u.selected_brands
  if (u.province_name) next.province_name = u.province_name
  if (u.max_price != null) next.max_price = u.max_price
  if (u.wants_best_quality === true) next.wants_best_quality = true
  return next
}

async function runTurn(
  collected: V3GatherCollected,
  userInput: string,
  history: Array<{ role: 'bot' | 'user'; text: string }>
): Promise<TurnResult> {
  takeCalls() // xả call của lượt trước
  const t0 = Date.now()
  const d: any = await v3GatherTurn({ collected, userInput, recentHistory: history })
  const ms = Date.now() - t0
  const calls = takeCalls()
  return {
    userInput,
    updates: d.updates ?? {},
    action: d.action,
    offTopicKind: d.off_topic_kind ?? null,
    isOffTopic: !!d.is_off_topic,
    reply: d.reply ?? '',
    error: d.error,
    calls,
    costUsd: calls.reduce((s, c) => s + costOf(c), 0),
    ms
  }
}

async function main(): Promise<void> {
  if (process.env.AI_USAGE_LOG_ENABLED !== 'false') {
    console.error('DỪNG: phải set AI_USAGE_LOG_ENABLED=false để không ghi ai_call_log.')
    process.exit(1)
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const golden: GoldenResult[] = []
  const corpus: CorpusResult[] = []

  if (ONLY !== 'corpus') {
    console.log(`\n=== CASE VÀNG (${GOLDEN_CASES.length}) — ${MODEL} effort=${EFFORT}`)
    for (const c of GOLDEN_CASES) {
      const r = await runTurn(c.collected, c.userInput, c.history ?? [])
      golden.push({ ...r, caseId: c.id, group: c.group })
      process.stdout.write(`  ${c.id} ${r.ms}ms $${r.costUsd.toFixed(5)}\n`)
    }
  }

  if (ONLY !== 'golden') {
    const corpusFile = path.join(OUT_DIR, 'corpus.json')
    const sessions: CorpusSession[] = JSON.parse(fs.readFileSync(corpusFile, 'utf8'))
    const totalTurns = sessions.reduce((s, x) => s + x.turns.length, 0)
    console.log(`\n=== CORPUS THẬT (${sessions.length} hội thoại / ${totalTurns} lượt)`)
    let done = 0
    for (const s of sessions) {
      let collected: V3GatherCollected = {}
      const turns: TurnResult[] = []
      for (const t of s.turns) {
        const r = await runTurn(collected, t.userInput, t.history)
        collected = mergeUpdates(collected, r.updates)
        turns.push(r)
        done++
        if (done % 20 === 0) process.stdout.write(`  ...${done}/${totalTurns} lượt\n`)
      }
      corpus.push({
        sessionId: s.id,
        bucket: s.bucket,
        prodFinalState: s.prodFinalState,
        finalCollected: collected,
        turns
      })
    }
  }

  const allTurns = [...golden, ...corpus.flatMap(c => c.turns)]
  const totalCost = allTurns.reduce((s, t) => s + t.costUsd, 0)
  const file = path.join(OUT_DIR, `result-${MODEL}-${EFFORT}.json`)
  fs.writeFileSync(
    file,
    JSON.stringify({ model: MODEL, effort: EFFORT, at: new Date().toISOString(), golden, corpus }, null, 2),
    'utf8'
  )
  console.log(
    `\n${MODEL}: ${allTurns.length} lượt, tổng $${totalCost.toFixed(4)} → ${file}`
  )
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
