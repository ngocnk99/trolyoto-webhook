/**
 * triage-diffs — phân loại 190 lượt KHÁC baseline thành nhóm, để biết chỗ nào
 * cần người/agent soi thật sự.
 *
 * Nhóm quan trọng nhất: "echo" — baseline nhắc lại field ĐÃ CÓ trong state
 * (bug kinh điển của gpt-4o-mini, xem follow.md ⚠️ "không re-trigger khi AI
 * echo lại giá trị CŨ"), model mới trả null. Khác baseline nhưng ĐÚNG hơn.
 *
 *   npx ts-node --transpile-only scripts/model-bench/triage-diffs.ts
 */
import fs from 'fs'
import path from 'path'

const OUT_DIR =
  process.env.BENCH_OUT_DIR ??
  'C:/Users/Admin/AppData/Local/Temp/claude/c--code-FL-trolyoto-production-buyer/2d232071-314d-4740-8ffe-f3b8a42567be/scratchpad/model-bench'

const FIELDS = [
  'tire_size',
  'selected_brands',
  'brand_tier',
  'province_name',
  'car_model',
  'max_price',
  'wants_best_quality'
] as const

type Any = Record<string, any>

const empty = (v: any) =>
  v == null || v === '' || (Array.isArray(v) && v.length === 0)
const norm = (v: any) => String(v ?? '').trim().toUpperCase()
const same = (a: any, b: any) => {
  if (empty(a) && empty(b)) return true
  if (empty(a) !== empty(b)) return false
  if (Array.isArray(a) || Array.isArray(b))
    return JSON.stringify((a ?? []).map(norm).sort()) === JSON.stringify((b ?? []).map(norm).sort())
  return norm(a) === norm(b)
}

/** Gộp update giống run-bench để dựng lại state TRƯỚC mỗi lượt. */
function merge(state: Any, u: Any): Any {
  const n = { ...state }
  if (u.tire_size) n.tire_size = u.tire_size
  if (u.brand_tier) n.brand_tier = u.brand_tier
  if (u.selected_brands?.length) n.selected_brands = u.selected_brands
  if (u.province_name) n.province_name = u.province_name
  if (u.max_price != null) n.max_price = u.max_price
  if (u.wants_best_quality === true) n.wants_best_quality = true
  return n
}

function load(model: string): Any {
  return JSON.parse(fs.readFileSync(path.join(OUT_DIR, `result-${model}-none.json`), 'utf8'))
}

function main(): void {
  const baselineModel = process.argv[2] ?? 'gpt-4o-mini'
  const base = load(baselineModel)
  const others = fs
    .readdirSync(OUT_DIR)
    .filter(f => f.startsWith('result-') && f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8')))
    .filter(r => r.model !== baselineModel)

  const out: Any[] = []
  const counts: Record<string, Record<string, number>> = {}

  for (const cand of others) {
    counts[cand.model] = {}
    for (const [si, sess] of cand.corpus.entries()) {
      const bSess = base.corpus[si]
      if (!bSess || bSess.sessionId !== sess.sessionId) continue
      let bState: Any = {}
      let cState: Any = {}
      for (const [ti, t] of sess.turns.entries()) {
        const bt = bSess.turns[ti]
        if (!bt) continue
        for (const f of FIELDS) {
          const bv = bt.updates?.[f]
          const cv = t.updates?.[f]
          if (same(bv, cv)) continue
          // Phân loại
          let kind: string
          if (!empty(bv) && empty(cv)) {
            kind = same(bv, bState[f]) ? 'baseline_echo' : 'baseline_only'
          } else if (empty(bv) && !empty(cv)) {
            kind = same(cv, cState[f]) ? 'candidate_echo' : 'candidate_only'
          } else {
            kind = 'value_mismatch'
          }
          counts[cand.model][`${f}:${kind}`] = (counts[cand.model][`${f}:${kind}`] ?? 0) + 1
          out.push({
            model: cand.model,
            kind,
            field: f,
            sessionId: sess.sessionId,
            bucket: sess.bucket,
            turn: ti + 1,
            userInput: t.userInput,
            stateBefore: { ...bState },
            baselineValue: bv ?? null,
            candidateValue: cv ?? null,
            baselineAction: bt.action,
            candidateAction: t.action,
            baselineReply: String(bt.reply ?? '').slice(0, 160),
            candidateReply: String(t.reply ?? '').slice(0, 160)
          })
        }
        bState = merge(bState, bt.updates ?? {})
        cState = merge(cState, t.updates ?? {})
      }
    }
  }

  for (const [model, c] of Object.entries(counts)) {
    console.log(`\n══ ${model} — khác baseline theo field × loại`)
    const rows = Object.entries(c).sort((a, b) => b[1] - a[1])
    for (const [k, n] of rows) console.log(`  ${k.padEnd(34)} ${n}`)
    console.log(`  TỔNG ${rows.reduce((s, r) => s + r[1], 0)}`)
  }

  const file = path.join(OUT_DIR, 'diffs-triaged.json')
  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8')
  console.log(`\n${out.length} khác biệt (theo field) → ${file}`)
}

main()
