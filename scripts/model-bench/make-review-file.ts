/**
 * make-review-file — lọc các khác biệt CẦN NGƯỜI/AGENT PHÁN XỬ (bỏ nhóm
 * baseline_echo vì đã biết chắc baseline sai), kèm ngữ cảnh hội thoại thật.
 *
 *   npx ts-node --transpile-only scripts/model-bench/make-review-file.ts
 */
import fs from 'fs'
import path from 'path'

const OUT_DIR =
  process.env.BENCH_OUT_DIR ??
  'C:/Users/Admin/AppData/Local/Temp/claude/c--code-FL-trolyoto-production-buyer/2d232071-314d-4740-8ffe-f3b8a42567be/scratchpad/model-bench'

type Any = Record<string, any>

function main(): void {
  const diffs: Any[] = JSON.parse(
    fs.readFileSync(path.join(OUT_DIR, 'diffs-triaged.json'), 'utf8')
  )
  const corpus: Any[] = JSON.parse(
    fs.readFileSync(path.join(OUT_DIR, 'corpus.json'), 'utf8')
  )
  const bySession = new Map(corpus.map(s => [s.id, s]))

  const needReview = diffs.filter(d => d.kind !== 'baseline_echo')
  const items = needReview.map((d, i) => {
    const s = bySession.get(d.sessionId)
    const turn = s?.turns?.[d.turn - 1]
    return {
      no: i + 1,
      model: d.model,
      kind: d.kind,
      field: d.field,
      sessionId: d.sessionId.slice(0, 8),
      bucket: d.bucket,
      turnIndex: d.turn,
      history: (turn?.history ?? []).map((h: Any) => `${h.role}: ${h.text}`),
      userInput: d.userInput,
      stateBefore: d.stateBefore,
      baseline_gpt4omini: d.baselineValue,
      candidate: d.candidateValue,
      baselineAction: d.baselineAction,
      candidateAction: d.candidateAction,
      prodFinalState: {
        tire_size: s?.prodFinalState?.tire_size ?? null,
        selected_brands: s?.prodFinalState?.selected_brands ?? null,
        province_name: s?.prodFinalState?.province_name ?? null,
        max_price: s?.prodFinalState?.max_price ?? null
      }
    }
  })

  const file = path.join(OUT_DIR, 'review-needed.json')
  fs.writeFileSync(file, JSON.stringify(items, null, 2), 'utf8')
  const byKind: Record<string, number> = {}
  for (const it of items) byKind[`${it.field}:${it.kind}`] = (byKind[`${it.field}:${it.kind}`] ?? 0) + 1
  console.log(`${items.length} khác biệt cần soi (đã bỏ ${diffs.length - items.length} case baseline_echo)`)
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(34)} ${n}`)
  }
  console.log(`→ ${file}`)
}

main()
