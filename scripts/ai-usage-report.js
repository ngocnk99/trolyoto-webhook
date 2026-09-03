/**
 * Đối chiếu chi phí OpenAI với lưu lượng thật.
 *   node scripts/ai-usage-report.js [số_ngày]      # mặc định 14
 *
 * In 3 phần:
 *   1. ai_call_log theo ngày  → cột `requests` phải KHỚP số requests trên
 *      dashboard OpenAI. Lệch = có request phát sinh ngoài 2 app này.
 *   2. Bóc tách theo nguồn / hàm / model → biết tiền đi đâu.
 *   3. Lưu lượng hội thoại FB (đếm từ conversation_log) → dùng khi ai_call_log
 *      còn trống (chưa apply migration / chưa deploy) để ước lượng số call AI
 *      đáng lẽ phải có, so với hoá đơn.
 *
 * Đọc env từ .env (dotenv). Cần SUPABASE_SERVICE_ROLE_KEY.
 */
require('dotenv/config')
const { createClient } = require('@supabase/supabase-js')

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const DAYS = Math.min(Math.max(Number(process.argv[2]) || 14, 1), 90)
const SINCE = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10)

function pad(v, n) {
  return String(v).padStart(n)
}

async function reportAiCallLog() {
  const { data, error } = await sb
    .from('ai_call_daily')
    .select('*')
    .gte('day_utc', SINCE)
  if (error) {
    console.log(`\n[ai_call_log] không đọc được: ${error.message}`)
    console.log('  → chưa apply migrations/20260903_ai_call_log.sql?')
    return
  }
  if (!data.length) {
    console.log('\n[ai_call_log] chưa có dòng nào (chưa deploy bản có logging?)')
    return
  }

  const byDay = new Map()
  for (const r of data) {
    const cur = byDay.get(r.day_utc) ?? { requests: 0, failed: 0, cost: 0, tokens: 0 }
    cur.requests += Number(r.requests)
    cur.failed += Number(r.failed_requests)
    cur.cost += Number(r.cost_usd)
    cur.tokens += Number(r.total_tokens)
    byDay.set(r.day_utc, cur)
  }
  console.log('\n── 1. Theo ngày (so cột requests với dashboard OpenAI) ──')
  console.log('ngày         requests   fail      tokens     cost_usd')
  for (const [d, v] of [...byDay.entries()].sort()) {
    console.log(
      `${d}  ${pad(v.requests, 8)} ${pad(v.failed, 6)} ${pad(v.tokens, 11)}   ${v.cost.toFixed(4)}`
    )
  }

  const byKey = new Map()
  for (const r of data) {
    const k = `${r.app}/${r.source}/${r.fn}/${r.model}`
    const cur = byKey.get(k) ?? { requests: 0, cost: 0, avgPrompt: 0 }
    cur.requests += Number(r.requests)
    cur.cost += Number(r.cost_usd)
    cur.avgPrompt = Math.max(cur.avgPrompt, Number(r.avg_prompt_tokens))
    byKey.set(k, cur)
  }
  console.log('\n── 2. Tiền đi đâu (sắp theo cost) ──')
  console.log('cost_usd  requests  avg_prompt_tok  app/source/fn/model')
  for (const [k, v] of [...byKey.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    console.log(
      `${pad(v.cost.toFixed(4), 8)}  ${pad(v.requests, 8)}  ${pad(v.avgPrompt, 14)}  ${k}`
    )
  }

  const { data: turns } = await sb
    .from('ai_cost_per_turn')
    .select('*')
    .gte('day_utc', SINCE)
  if (turns && turns.length) {
    console.log('\n── 2b. Mỗi tin nhắn khách tốn bao nhiêu ──')
    console.log('ngày         nguồn              turns  req/turn  usd/turn')
    for (const r of turns.sort((a, b) => (a.day_utc < b.day_utc ? -1 : 1))) {
      console.log(
        `${r.day_utc}  ${String(r.source).padEnd(18)} ${pad(r.turns, 5)}  ${pad(r.requests_per_turn, 8)}  ${r.cost_per_turn_usd}`
      )
    }
  }
}

async function reportConversationVolume() {
  const sinceIso = `${SINCE}T00:00:00Z`
  const perDay = {}
  let from = 0
  const page = 200
  let scanned = 0
  for (;;) {
    const { data, error } = await sb
      .from('fb_messenger_sessions')
      .select('id, conversation_log')
      .gte('updated_at', sinceIso)
      .order('updated_at', { ascending: true })
      .range(from, from + page - 1)
    if (error) throw error
    if (!data || !data.length) break
    for (const s of data) {
      scanned++
      for (const m of Array.isArray(s.conversation_log) ? s.conversation_log : []) {
        if (!m || !m.ts) continue
        const d = String(m.ts).slice(0, 10)
        if (d < SINCE) continue
        perDay[d] = perDay[d] ?? { user: 0, qr: 0, bot: 0, sess: new Set() }
        perDay[d].sess.add(s.id)
        if (m.role === 'user') {
          perDay[d].user++
          if (m.type === 'qr_click') perDay[d].qr++
        } else if (m.role === 'bot') perDay[d].bot++
      }
    }
    from += page
    if (data.length < page) break
  }
  console.log(`\n── 3. Lưu lượng FB thật (${scanned} session quét được) ──`)
  console.log('ngày         tin_khách  (qr_click)  tin_bot  session')
  for (const d of Object.keys(perDay).sort()) {
    const v = perDay[d]
    console.log(
      `${d}  ${pad(v.user, 9)}  ${pad(v.qr, 10)}  ${pad(v.bot, 7)}  ${pad(v.sess.size, 7)}`
    )
  }
  console.log(
    '\nGhi chú: chỉ đếm được session còn tồn tại và có updated_at trong khoảng —'
  )
  console.log(
    'session bị reset/xoá sẽ thiếu, nên con số này là CẬN DƯỚI của lưu lượng thật.'
  )
}

;(async () => {
  console.log(`Khoảng: từ ${SINCE} (${DAYS} ngày)`)
  await reportAiCallLog()
  await reportConversationVolume()
})().catch(e => {
  console.error(e)
  process.exit(1)
})
