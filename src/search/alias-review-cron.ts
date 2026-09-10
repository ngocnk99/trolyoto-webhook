/**
 * Task 86eyuw542 — GĐ8 (10/09/2026): cron AI TỰ DUYỆT alias pending.
 *
 * Vì sao: mining đêm chỉ auto-approve khi conf ≥ 0.9 VÀ gặp ≥ 3 lần; case hiếm
 * ("mít" ev=1, "han cốc") nằm pending vô hạn vì user không có thời gian duyệt
 * tay, có dòng mining đoán SAI canonical ("cum ho" → "Thay cụm đèn hậu").
 * Cron này chạy 02:00 VN (SAU mining 01:30, TRƯỚC refresh từ điển 02:30) cho
 * gpt-4o-mini chấm lại từng dòng pending: approve / reject / fix (đổi canonical
 * đúng). Verdict được đối chiếu từ điển trước khi ghi (resolveReviewVerdicts) —
 * AI không thể bịa bản chuẩn. Dòng skip giữ pending, đêm sau chấm lại.
 *
 * Chi phí: tối đa REVIEW_MAX_CALLS lượt AI/đêm (mặc định 6 × 25 dòng = 150);
 * hết backlog thì mỗi đêm chỉ còn vài dòng mới từ mining. Log vào ai_call_log
 * qua withAiCall như mining.
 */
import { openai } from '@ai-sdk/openai'
import { generateObject } from 'ai'
import { z } from 'zod'
import { withAiTurn, withAiCall } from '../ai/usage-log'
import { supabaseAmin } from '../fb/supabase'
import {
  chunk,
  resolveReviewVerdicts,
  type AiReviewVerdict,
  type PendingAliasRow,
  type ReviewAction
} from './alias-utils'
import { loadVocabulary, type Vocabulary } from './search-alias-cron'

const MODEL = process.env.SEARCH_ALIAS_REVIEW_MODEL ?? 'gpt-4o-mini'
const RUN_AT = process.env.SEARCH_ALIAS_REVIEW_CRON_TIME ?? '02:00'
const ROWS_PER_CALL = Number(process.env.SEARCH_ALIAS_REVIEW_ROWS_PER_CALL ?? 25)
const MAX_CALLS = Number(process.env.SEARCH_ALIAS_REVIEW_MAX_CALLS ?? 6)
const ENABLED = (process.env.SEARCH_ALIAS_REVIEW_ENABLED ?? '1') !== '0'

export interface ReviewResult {
  startedAt: string
  finishedAt?: string
  dryRun: boolean
  pendingSeen: number
  aiCalls: number
  approved: number
  fixed: number
  rejected: number
  skipped: number
  error?: string
  samples: string[]
}

let lastResult: ReviewResult | null = null
let running = false

const verdictSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().describe('Số thứ tự dòng (bắt đầu 0) đúng như danh sách'),
      verdict: z.enum(['approve', 'reject', 'fix']),
      canonical: z
        .string()
        .optional()
        .describe('CHỈ khi fix: bản chuẩn đúng, COPY NGUYÊN VĂN từ danh sách từ điển'),
      confidence: z.number().min(0).max(1),
      reason: z.string().describe('1 câu ngắn vì sao')
    })
  )
})

function buildReviewSystemPrompt(v: Vocabulary): string {
  return [
    'Bạn là bộ kiểm duyệt alias tìm kiếm cho sàn dịch vụ ô tô Việt Nam (TROLYoto).',
    'Mỗi dòng là một alias PENDING: cách khách gõ (alias) đang được đề xuất trỏ về một bản chuẩn (canonical).',
    'Với TỪNG dòng, trả về verdict:',
    '- approve: alias thật sự là cách gõ sai chính tả / phiên âm tiếng Việt / lóng / viết tắt của ĐÚNG canonical đó (vd "han cốc" → Lốp Hankook, "bigertone" → Lốp Bridgestone).',
    '- fix: alias có nghĩa nhưng canonical hiện tại SAI — kèm `canonical` đúng, COPY NGUYÊN VĂN một dòng trong danh sách bên dưới (vd alias "cum ho" đang trỏ "Thay cụm đèn hậu" → fix canonical "Lốp Kumho").',
    '- reject: alias vô nghĩa / chung chung ("lốp tốt", "giá rẻ") / địa danh / số điện thoại / không liên quan ô tô / trùng luôn bản chuẩn.',
    'Cân nhắc evidence (câu khách gõ thật) đính kèm từng dòng. Trả verdict cho MỌI dòng.',
    '',
    `HÃNG (${v.brands.length}): ${v.brands.join(' | ')}`,
    '',
    `DÒNG XE (${v.carlines.length}): ${v.carlines.join(' | ')}`,
    '',
    `DỊCH VỤ (${v.services.length}): ${v.services.join(' | ')}`
  ].join('\n')
}

async function askReview(system: string, rows: PendingAliasRow[]): Promise<AiReviewVerdict[]> {
  return withAiCall('askAliasReview', async () => {
    const list = rows
      .map((r, i) => {
        const ev = (r.evidence ?? []).slice(0, 3).join(' / ')
        return `${i}. alias="${r.alias_norm}" → canonical hiện tại="${r.canonical_q}" [${r.type}] (conf=${r.confidence ?? '?'}, gặp ${r.evidence_count} lần${ev ? `, khách gõ: ${ev}` : ''})`
      })
      .join('\n')
    const { object } = await generateObject({
      model: openai(MODEL) as any,
      schema: verdictSchema,
      system,
      prompt: `Các alias pending cần duyệt:\n${list}\n\nTrả verdict cho từng dòng theo index.`
    })
    return (object?.verdicts ?? []) as AiReviewVerdict[]
  })
}

async function applyActions(actions: ReviewAction[], dryRun: boolean): Promise<void> {
  if (dryRun) return
  const now = new Date().toISOString()
  for (const a of actions) {
    if (a.action === 'skip') continue
    const patch: Record<string, unknown> = { updated_at: now, reviewed_at: now }
    if (a.action === 'reject') patch.status = 'rejected'
    if (a.action === 'approve') patch.status = 'approved'
    if (a.action === 'fix') {
      patch.status = 'approved'
      patch.canonical_q = a.canonical_q
    }
    const { error } = await supabaseAmin.from('search_alias').update(patch).eq('id', a.id)
    // 23505: fix đụng dòng (alias_norm, canonical_q) đã tồn tại → reject dòng pending này
    if (error && /duplicate|23505/i.test(error.message)) {
      await supabaseAmin
        .from('search_alias')
        .update({ status: 'rejected', reviewed_at: now, updated_at: now })
        .eq('id', a.id)
    } else if (error) {
      throw new Error(`search_alias update #${a.id}: ${error.message}`)
    }
  }
}

export async function runAliasReview(opts: { dryRun?: boolean } = {}): Promise<ReviewResult> {
  return withAiTurn({ source: 'cron-search-alias-review' }, () => runAliasReviewImpl(opts))
}

async function runAliasReviewImpl(opts: { dryRun?: boolean } = {}): Promise<ReviewResult> {
  const dryRun = !!opts.dryRun
  const result: ReviewResult = {
    startedAt: new Date().toISOString(),
    dryRun,
    pendingSeen: 0,
    aiCalls: 0,
    approved: 0,
    fixed: 0,
    rejected: 0,
    skipped: 0,
    samples: []
  }
  if (running) {
    result.error = 'đang chạy lượt khác'
    return result
  }
  running = true
  try {
    const { data, error } = await supabaseAmin
      .from('search_alias')
      .select('id, alias, alias_norm, canonical_q, type, confidence, evidence_count, evidence')
      .eq('status', 'pending')
      .order('evidence_count', { ascending: false })
      .order('id', { ascending: true })
      .limit(ROWS_PER_CALL * MAX_CALLS)
    if (error) throw new Error(`search_alias read: ${error.message}`)
    const rows = (data ?? []) as PendingAliasRow[]
    result.pendingSeen = rows.length
    if (rows.length === 0) return result

    const vocab = await loadVocabulary()
    const system = buildReviewSystemPrompt(vocab)

    for (const batch of chunk(rows, ROWS_PER_CALL)) {
      if (result.aiCalls >= MAX_CALLS) break
      result.aiCalls += 1
      const verdicts = await askReview(system, batch)
      const actions = resolveReviewVerdicts(batch, verdicts, vocab.norms)
      for (const a of actions) {
        if (a.action === 'approve') result.approved += 1
        else if (a.action === 'fix') result.fixed += 1
        else if (a.action === 'reject') result.rejected += 1
        else result.skipped += 1
        if (result.samples.length < 30)
          result.samples.push(
            `${a.action.toUpperCase()} "${a.alias_norm}"${a.canonical_q ? ` → ${a.canonical_q}` : ''} (${a.reason})`
          )
      }
      await applyActions(actions, dryRun)
    }
    return result
  } catch (e: any) {
    result.error = e?.message ?? String(e)
    return result
  } finally {
    running = false
    result.finishedAt = new Date().toISOString()
    lastResult = result
    console.log(
      `[alias-review] ${dryRun ? 'DRY-RUN ' : ''}pending=${result.pendingSeen} calls=${result.aiCalls} approve=${result.approved} fix=${result.fixed} reject=${result.rejected} skip=${result.skipped}${result.error ? ` ERROR=${result.error}` : ''}`
    )
  }
}

export function getAliasReviewStatus() {
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

export function startAliasReviewCron(): void {
  if (!ENABLED) {
    console.log('[alias-review] cron disabled (SEARCH_ALIAS_REVIEW_ENABLED=0)')
    return
  }
  if (timer) return
  console.log(`[alias-review] cron armed: daily ${RUN_AT} VN, model=${MODEL}, maxCalls=${MAX_CALLS}`)
  timer = setInterval(() => {
    const { hhmm, day } = nowVN()
    if (hhmm !== RUN_AT || lastRunDay === day) return
    lastRunDay = day
    runAliasReview().catch(e => console.error('[alias-review] cron error:', e))
  }, 60_000)
}

export function stopAliasReviewCron(): void {
  if (timer) clearInterval(timer)
  timer = null
}
