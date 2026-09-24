/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  build-corpus — rút hội thoại THẬT từ `fb_messenger_sessions` thành bộ case
 *  replay cho benchmark. CHỈ ĐỌC DB, không ghi gì.
 *
 *    cd fb-webhook-server
 *    npx ts-node --transpile-only -r dotenv/config scripts/model-bench/build-corpus.ts [soLuong]
 *
 *  Ra file JSON ở scratchpad (KHÔNG commit vào repo — chứa nội dung chat thật).
 *
 *  Phân tầng mẫu để phủ đủ các nhánh: có kết quả / phải chuyển CSKH / hỏi theo
 *  tên xe / có nêu tầm giá. Bỏ các lượt không replay được ([event], [sticker],
 *  [image...]) vì tầng AI text không xử lý được chúng.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import fs from 'fs'
import path from 'path'
import { supabaseAmin } from '../../src/fb/supabase'
import type { ConversationMessage } from '../../src/fb/types'

const OUT_DIR =
  process.env.BENCH_OUT_DIR ??
  'C:/Users/Admin/AppData/Local/Temp/claude/c--code-FL-trolyoto-production-buyer/2d232071-314d-4740-8ffe-f3b8a42567be/scratchpad/model-bench'

export interface CorpusTurn {
  /** Tin khách ở lượt này. */
  userInput: string
  /** Lịch sử THẬT trước lượt này (đã lọc như recentHistory(), tối đa 6). */
  history: Array<{ role: 'bot' | 'user'; text: string }>
}

export interface CorpusSession {
  id: string
  createdAt: string
  bucket: string
  /** State CUỐI CÙNG mà production (gpt-4o-mini) đạt được — dùng tham chiếu. */
  prodFinalState: Record<string, unknown>
  turns: CorpusTurn[]
}

/** Lượt khách không phải text thật — không replay được ở tầng AI. */
function isPlaceholder(text: string): boolean {
  const t = (text ?? '').trim()
  return (
    !t ||
    t === '[event]' ||
    t === '[sticker]' ||
    t.startsWith('[image') ||
    t.startsWith('[referral') ||
    t.startsWith('[attachment')
  )
}

/** Giống recentHistory() trong v3/flow-handler.ts: bỏ system + hidden_from_ai. */
function historyBefore(
  log: ConversationMessage[],
  index: number
): Array<{ role: 'bot' | 'user'; text: string }> {
  return log
    .slice(0, index)
    .filter(m => (m.role === 'bot' || m.role === 'user') && !m.hidden_from_ai)
    .filter(m => !isPlaceholder(m.text))
    .slice(-6)
    .map(m => ({ role: m.role as 'bot' | 'user', text: m.text }))
}

interface Row {
  id: string
  created_at: string
  state: Record<string, unknown>
  conversation_log: ConversationMessage[]
}

async function fetchBucket(
  bucket: string,
  apply: (q: any) => any,
  limit: number
): Promise<Array<{ row: Row; bucket: string }>> {
  let q = supabaseAmin
    .from('fb_messenger_sessions')
    .select('id, created_at, state, conversation_log')
    .not('psid', 'like', 'test\\_%')
    .gte('created_at', new Date(Date.now() - 45 * 864e5).toISOString())
    .order('created_at', { ascending: false })
    .limit(limit * 4)
  q = apply(q)
  const { data, error } = await q
  if (error) throw error
  return ((data ?? []) as Row[]).map(row => ({ row, bucket }))
}

async function main(): Promise<void> {
  const target = Number(process.argv[2] ?? 50)
  const per = Math.ceil(target / 4)

  const buckets = [
    ...(await fetchBucket('co_ket_qua', q => q.eq('state->has_shown_results', true), per)),
    ...(await fetchBucket('cskh', q => q.not('state->>cskh_reason', 'is', null), per)),
    ...(await fetchBucket('theo_xe', q => q.not('state->>car_model', 'is', null), per)),
    ...(await fetchBucket('co_gia', q => q.not('state->>max_price', 'is', null), per))
  ]

  const seenSession = new Set<string>()
  const seenFirstMsg = new Set<string>()
  const out: CorpusSession[] = []
  const takenPerBucket: Record<string, number> = {}

  for (const { row, bucket } of buckets) {
    if (out.length >= target) break
    // Hạn mức từng nhóm — không để nhóm đầu (nhiều dòng nhất) chiếm hết chỗ.
    if ((takenPerBucket[bucket] ?? 0) >= per) continue
    if (seenSession.has(row.id)) continue
    const log = row.conversation_log ?? []
    const turns: CorpusTurn[] = []
    log.forEach((m, i) => {
      if (m.role !== 'user' || isPlaceholder(m.text)) return
      turns.push({ userInput: m.text, history: historyBefore(log, i) })
    })
    if (turns.length === 0) continue
    // Khử trùng lặp: rất nhiều hội thoại mở đầu y hệt nhau ("Bạn ơi", "Alo").
    const key = turns[0].userInput.trim().toLowerCase().slice(0, 40)
    if (seenFirstMsg.has(key)) continue
    seenFirstMsg.add(key)
    seenSession.add(row.id)
    takenPerBucket[bucket] = (takenPerBucket[bucket] ?? 0) + 1
    out.push({
      id: row.id,
      createdAt: row.created_at,
      bucket,
      prodFinalState: row.state ?? {},
      turns: turns.slice(0, 6) // cắt hội thoại quá dài cho đỡ tốn
    })
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const file = path.join(OUT_DIR, 'corpus.json')
  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8')

  const byBucket: Record<string, number> = {}
  let turnCount = 0
  for (const s of out) {
    byBucket[s.bucket] = (byBucket[s.bucket] ?? 0) + 1
    turnCount += s.turns.length
  }
  console.log(`corpus: ${out.length} hội thoại, ${turnCount} lượt khách → ${file}`)
  console.log('phân bổ:', JSON.stringify(byBucket))
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
