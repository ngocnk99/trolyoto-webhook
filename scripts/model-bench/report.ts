/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  report — gộp các file result-*.json, chấm điểm và in bảng so sánh.
 *
 *    cd fb-webhook-server
 *    npx ts-node --transpile-only scripts/model-bench/report.ts [baselineModel]
 *
 *  Chấm 2 kiểu:
 *   - CASE VÀNG: so với đáp án gán tay trong golden-cases.ts (đúng/sai tuyệt đối).
 *   - CORPUS THẬT: so với model nền (mặc định gpt-4o-mini) — khác nhau KHÔNG
 *     tự động là sai, chỉ là chỗ cần soi tay; xuất ra file diffs.json.
 *
 *  Chi phí tháng dự phóng: lấy khối lượng THẬT của v3GatherTurn 30 ngày
 *  (ai_call_log) rồi áp giá từng model + tỉ lệ token suy luận đo được.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import fs from 'fs'
import path from 'path'
import { GOLDEN_CASES, type Expect } from './golden-cases'
import { priceFor } from './bench-fetch'

const OUT_DIR =
  process.env.BENCH_OUT_DIR ??
  'C:/Users/Admin/AppData/Local/Temp/claude/c--code-FL-trolyoto-production-buyer/2d232071-314d-4740-8ffe-f3b8a42567be/scratchpad/model-bench'

/** Khối lượng THẬT 30 ngày của v3GatherTurn (ai_call_log, 2026-09-24). */
const PROD_30D = { calls: 4709, inTok: 63_620_639, cachedTok: 55_000_576, outTok: 286_402 }

type Any = Record<string, any>

function norm(v: unknown): string {
  return String(v ?? '').trim().toUpperCase()
}

/** Chấm 1 field theo kỳ vọng. Trả null nếu field không được chấm. */
function checkField(key: keyof Expect, exp: any, got: any): boolean | null {
  if (exp === undefined) return null
  if (exp === null) {
    // Kỳ vọng "không được set" — [] và '' cũng coi như không set.
    return got == null || (Array.isArray(got) && got.length === 0) || got === ''
  }
  if (exp instanceof RegExp) return typeof got === 'string' && exp.test(got)
  if (Array.isArray(exp)) {
    const g = Array.isArray(got) ? got.map(norm).sort() : []
    return JSON.stringify(g) === JSON.stringify(exp.map(norm).sort())
  }
  if (typeof exp === 'number') return got === exp
  if (typeof exp === 'boolean') return got === exp
  return norm(got) === norm(exp)
}

function gradeGolden(res: Any): {
  pass: number
  fail: number
  failures: Array<{ id: string; group: string; detail: string }>
  byGroup: Record<string, { pass: number; total: number }>
} {
  const byId = new Map(GOLDEN_CASES.map(c => [c.id, c]))
  let pass = 0
  let fail = 0
  const failures: Array<{ id: string; group: string; detail: string }> = []
  const byGroup: Record<string, { pass: number; total: number }> = {}

  for (const r of res.golden ?? []) {
    const c = byId.get(r.caseId)
    if (!c) continue
    const got: Any = { ...r.updates, action: r.action, off_topic_kind: r.offTopicKind }
    const bad: string[] = []
    for (const key of Object.keys(c.expect) as Array<keyof Expect>) {
      const ok = checkField(key, (c.expect as Any)[key], got[key])
      if (ok === false) {
        const e = (c.expect as Any)[key]
        bad.push(`${key}: mong ${e instanceof RegExp ? e.source : JSON.stringify(e)}, nhận ${JSON.stringify(got[key])}`)
      }
    }
    byGroup[c.group] ??= { pass: 0, total: 0 }
    byGroup[c.group].total++
    if (bad.length === 0) {
      pass++
      byGroup[c.group].pass++
    } else {
      fail++
      failures.push({ id: c.id, group: c.group, detail: bad.join(' | ') })
    }
  }
  return { pass, fail, failures, byGroup }
}

const CMP_FIELDS = [
  'tire_size',
  'selected_brands',
  'brand_tier',
  'province_name',
  'car_model',
  'max_price',
  'wants_best_quality'
] as const

function sameValue(a: any, b: any): boolean {
  const empty = (v: any) => v == null || v === '' || (Array.isArray(v) && v.length === 0)
  if (empty(a) && empty(b)) return true
  if (empty(a) !== empty(b)) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      JSON.stringify((a ?? []).map(norm).sort()) ===
      JSON.stringify((b ?? []).map(norm).sort())
    )
  }
  return norm(a) === norm(b)
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

function stats(res: Any) {
  const turns = [...(res.golden ?? []), ...(res.corpus ?? []).flatMap((c: Any) => c.turns)]
  const calls = turns.flatMap((t: Any) => t.calls ?? [])
  const cost = turns.reduce((s: number, t: Any) => s + (t.costUsd ?? 0), 0)
  const lat = turns.map((t: Any) => t.ms)
  return {
    turns: turns.length,
    calls: calls.length,
    retries: calls.length - turns.length,
    httpFails: calls.filter((c: Any) => !c.ok).length,
    aiErrors: turns.filter((t: Any) => t.error).length,
    cost,
    costPerTurn: cost / Math.max(1, turns.length),
    p50: percentile(lat, 50),
    p95: percentile(lat, 95),
    avgIn: calls.reduce((s: number, c: Any) => s + c.promptTokens, 0) / Math.max(1, calls.length),
    avgOut: calls.reduce((s: number, c: Any) => s + c.completionTokens, 0) / Math.max(1, calls.length),
    avgReasoning:
      calls.reduce((s: number, c: Any) => s + c.reasoningTokens, 0) / Math.max(1, calls.length)
  }
}

/** Chi phí 30 ngày nếu chạy khối lượng production bằng model này. */
function projectMonthly(model: string, avgOutPerCall: number, baselineOutPerCall: number): number {
  const p = priceFor(model)
  // Output thật của model này có thể nhiều/ít hơn baseline (token suy luận,
  // câu trả lời dài hơn) → scale theo tỉ lệ đo được.
  const ratio = baselineOutPerCall > 0 ? avgOutPerCall / baselineOutPerCall : 1
  const uncached = PROD_30D.inTok - PROD_30D.cachedTok
  return (
    (uncached * p.input + PROD_30D.cachedTok * p.cached + PROD_30D.outTok * ratio * p.output) /
    1_000_000
  )
}

function main(): void {
  const baselineModel = process.argv[2] ?? 'gpt-4o-mini'
  const files = fs
    .readdirSync(OUT_DIR)
    .filter(f => f.startsWith('result-') && f.endsWith('.json'))
  if (files.length === 0) {
    console.error(`Không có file result-*.json trong ${OUT_DIR}`)
    process.exit(1)
  }
  const results = files.map(f => JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8')))
  const baseline = results.find(r => r.model === baselineModel)

  console.log(`\n══ CASE VÀNG (${GOLDEN_CASES.length} case, đáp án gán tay) ══`)
  const graded = new Map<string, ReturnType<typeof gradeGolden>>()
  for (const r of results) graded.set(r.model, gradeGolden(r))
  const groups = Array.from(
    new Set(Object.keys(Object.fromEntries(GOLDEN_CASES.map(c => [c.group, 1]))))
  )
  console.log(
    'model'.padEnd(16),
    'đạt'.padStart(9),
    ...groups.map(g => g.padStart(9))
  )
  for (const r of results) {
    const g = graded.get(r.model)!
    console.log(
      `${r.model}`.padEnd(16),
      `${g.pass}/${g.pass + g.fail}`.padStart(9),
      ...groups.map(k =>
        `${g.byGroup[k]?.pass ?? 0}/${g.byGroup[k]?.total ?? 0}`.padStart(9)
      )
    )
  }

  console.log(`\n══ CHI PHÍ / TỐC ĐỘ (đo thật trong lần chạy này) ══`)
  console.log(
    'model'.padEnd(16),
    'lượt'.padStart(6),
    'retry'.padStart(6),
    'lỗi'.padStart(5),
    '$/lượt'.padStart(9),
    'p50 ms'.padStart(7),
    'p95 ms'.padStart(7),
    'out tok'.padStart(8),
    'suy luận'.padStart(9)
  )
  const baseStats = baseline ? stats(baseline) : null
  for (const r of results) {
    const s = stats(r)
    console.log(
      `${r.model}`.padEnd(16),
      String(s.turns).padStart(6),
      String(s.retries).padStart(6),
      String(s.aiErrors + s.httpFails).padStart(5),
      s.costPerTurn.toFixed(5).padStart(9),
      String(s.p50).padStart(7),
      String(s.p95).padStart(7),
      s.avgOut.toFixed(0).padStart(8),
      s.avgReasoning.toFixed(0).padStart(9)
    )
  }

  console.log(`\n══ DỰ PHÓNG CHI PHÍ 30 NGÀY (khối lượng thật v3GatherTurn: ${PROD_30D.calls} lượt) ══`)
  for (const r of results) {
    const s = stats(r)
    const proj = projectMonthly(r.model, s.avgOut, baseStats?.avgOut ?? s.avgOut)
    const base = baseStats ? projectMonthly(baselineModel, baseStats.avgOut, baseStats.avgOut) : proj
    const delta = base > 0 ? ((proj - base) / base) * 100 : 0
    console.log(
      `${r.model}`.padEnd(16),
      `$${proj.toFixed(2)}`.padStart(8),
      r.model === baselineModel ? '(nền)' : `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%`
    )
  }

  if (baseline) {
    console.log(`\n══ CORPUS THẬT — mức đồng thuận với ${baselineModel} ══`)
    console.log('model'.padEnd(16), 'lượt khớp'.padStart(12), ...CMP_FIELDS.map(f => f.slice(0, 8).padStart(9)))
    const diffsOut: Any[] = []
    for (const r of results) {
      if (r.model === baselineModel) continue
      let turnsSame = 0
      let turnsTotal = 0
      const fieldSame: Record<string, number> = {}
      for (const [si, sess] of (r.corpus ?? []).entries()) {
        const bSess = baseline.corpus?.[si]
        if (!bSess || bSess.sessionId !== sess.sessionId) continue
        for (const [ti, t] of sess.turns.entries()) {
          const bt = bSess.turns[ti]
          if (!bt) continue
          turnsTotal++
          let allSame = true
          for (const f of CMP_FIELDS) {
            const ok = sameValue(t.updates?.[f], bt.updates?.[f])
            if (ok) fieldSame[f] = (fieldSame[f] ?? 0) + 1
            else allSame = false
          }
          if (allSame) turnsSame++
          else
            diffsOut.push({
              model: r.model,
              sessionId: sess.sessionId,
              bucket: sess.bucket,
              turn: ti + 1,
              userInput: t.userInput,
              baseline: Object.fromEntries(CMP_FIELDS.map(f => [f, bt.updates?.[f] ?? null])),
              candidate: Object.fromEntries(CMP_FIELDS.map(f => [f, t.updates?.[f] ?? null])),
              baselineAction: bt.action,
              candidateAction: t.action
            })
        }
      }
      console.log(
        `${r.model}`.padEnd(16),
        `${turnsSame}/${turnsTotal} ${pct(turnsSame, turnsTotal)}`.padStart(12),
        ...CMP_FIELDS.map(f => pct(fieldSame[f] ?? 0, turnsTotal).padStart(9))
      )
    }
    const diffFile = path.join(OUT_DIR, 'diffs.json')
    fs.writeFileSync(diffFile, JSON.stringify(diffsOut, null, 2), 'utf8')
    console.log(`\n${diffsOut.length} lượt khác baseline → ${diffFile}`)
  }

  console.log(`\n══ CASE VÀNG TRƯỢT (chi tiết) ══`)
  for (const r of results) {
    const g = graded.get(r.model)!
    console.log(`\n▸ ${r.model} — trượt ${g.fail}:`)
    for (const f of g.failures) console.log(`   ${f.id.padEnd(26)} ${f.detail}`)
  }
}

main()
