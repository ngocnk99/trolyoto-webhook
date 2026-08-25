/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Search Alias Mining — học cách khách gõ để gợi ý tìm kiếm "hợp ý" hơn
 *  (task search-suggest-v2, Giai đoạn 3)
 *
 *  BỐI CẢNH
 *  Từ điển gợi ý (search_dictionary) sinh từ tên chuẩn: "Lốp Bridgestone",
 *  "Thay ắc quy"... Khách thì gõ "bigertone", "lop mít", "205/56/15". Corpus
 *  ngôn ngữ thật có sẵn: fb_messenger_sessions.conversation_log (61k tin nhắn
 *  user) + search_query_log (gõ tay trên web, GĐ1). Cron này chạy ĐÊM, gom câu
 *  khách gõ, hỏi gpt-4o-mini "câu này ứng với bản chuẩn nào trong từ điển",
 *  ghi search_alias. Runtime web KHÔNG gọi AI: alias approved được
 *  search_dictionary_refresh() (02:30 VN) nhồi vào từ điển → tầng 1 "Có phải
 *  bạn tìm...".
 *
 *  VÌ SAO Ở ĐÂY: service always-on trên Render, đã có sẵn stack OpenAI
 *  (ai-helper.ts) + service key Supabase; cùng lý do cache-outbox-cron.
 *
 *  CHI PHÍ: chặn cứng SEARCH_ALIAS_MAX_CALLS lượt/đêm (mặc định 40 × ~60 câu);
 *  watermark theo fb_messenger_sessions.updated_at nên mỗi session chỉ xử lý
 *  1 lần; câu đã có alias (mọi status) không hỏi AI lại, chỉ tăng evidence.
 *
 *  DUYỆT: tự approve khi confidence >= 0.9 VÀ evidence >= 3 (alias-utils.ts);
 *  còn lại pending, duyệt tay bằng SQL. Rejected → không bao giờ hỏi lại.
 *
 *  AN TOÀN KHI CHẠY TRÙNG: upsert theo (alias_norm, canonical_q) idempotent;
 *  chạy 2 lần cùng đêm chỉ tốn thêm tiền AI, không hỏng dữ liệu.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { openai } from '@ai-sdk/openai'
import { generateObject } from 'ai'
import { z } from 'zod'
import { supabaseAmin } from '../fb/supabase'
import {
  chunk,
  extractUserPhrases,
  normalizeText,
  shouldAutoApprove,
  validateAliases,
  type AiAliasCandidate,
  type ValidatedAlias
} from './alias-utils'

const MODEL = process.env.SEARCH_ALIAS_MODEL ?? 'gpt-4o-mini'
/** Giờ VN chạy hằng ngày — TRƯỚC cron DB search-dictionary-refresh (02:30). */
const RUN_AT = process.env.SEARCH_ALIAS_CRON_TIME ?? '01:30'
const SESSION_BATCH = Number(process.env.SEARCH_ALIAS_SESSION_BATCH ?? 300)
const PHRASES_PER_CALL = Number(process.env.SEARCH_ALIAS_PHRASES_PER_CALL ?? 60)
const MAX_CALLS = Number(process.env.SEARCH_ALIAS_MAX_CALLS ?? 40)
const QUERY_LOG_DAYS = Number(process.env.SEARCH_ALIAS_QUERY_LOG_DAYS ?? 30)
const FIRST_RUN_LOOKBACK_DAYS = Number(process.env.SEARCH_ALIAS_LOOKBACK_DAYS ?? 30)
const STATE_KEY_WATERMARK = 'fb_sessions_watermark'
const STATE_KEY_LAST_RUN = 'last_run'
const ENABLED = (process.env.SEARCH_ALIAS_CRON_ENABLED ?? '1') !== '0'

export interface MiningResult {
  dryRun: boolean
  startedAt: string
  durationMs: number
  sessions: number
  phrasesFromSessions: number
  phrasesFromQueryLog: number
  phrasesSkippedKnown: number
  aiCalls: number
  aiCandidates: number
  validated: number
  upserted: number
  autoApproved: number
  evidenceOnly: number
  watermarkBefore: string
  watermarkAfter: string | null
  samples: Array<{ alias: string; canonical: string; type: string; confidence: number }>
  error?: string
}

interface Phrase {
  text: string
  norm: string
  count: number
  source: 'fb_messenger' | 'query_log'
}

interface Vocabulary {
  brands: string[]
  carlines: string[]
  services: string[]
  norms: Set<string>
}

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function readState(key: string): Promise<string | null> {
  const { data, error } = await supabaseAmin
    .from('search_alias_state')
    .select('value')
    .eq('key', key)
    .maybeSingle()
  if (error) throw new Error(`state read ${key}: ${error.message}`)
  return (data as { value: string } | null)?.value ?? null
}

async function writeState(key: string, value: string): Promise<void> {
  const { error } = await supabaseAmin
    .from('search_alias_state')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  if (error) throw new Error(`state write ${key}: ${error.message}`)
}

async function loadVocabulary(): Promise<Vocabulary> {
  const norms = new Set<string>()
  const brands: string[] = []
  const carlines: string[] = []
  const services: Array<{ display: string; rank: number }> = []

  for (let page = 0; page < 12; page++) {
    const { data, error } = await supabaseAmin
      .from('search_dictionary')
      .select('display, norm, kind, facet, rank_score')
      .eq('is_active', true)
      .order('id', { ascending: true })
      .range(page * 1000, (page + 1) * 1000 - 1)
    if (error) throw new Error(`dictionary: ${error.message}`)
    const rows = (data ?? []) as Array<{
      display: string
      norm: string
      kind: string
      facet: string | null
      rank_score: number
    }>
    for (const r of rows) {
      norms.add(r.norm)
      if (r.kind === 'brand') brands.push(r.display)
      else if (r.facet === 'carline') carlines.push(r.display)
      else if (r.kind === 'service_name')
        services.push({ display: r.display, rank: Number(r.rank_score) || 0 })
    }
    if (rows.length < 1000) break
  }

  services.sort((a, b) => b.rank - a.rank)
  return {
    brands: Array.from(new Set(brands)),
    carlines: Array.from(new Set(carlines)),
    services: services.slice(0, 300).map(s => s.display),
    norms
  }
}

/** alias_norm đã có dòng trong search_alias (mọi status) → không hỏi AI lại. */
async function loadKnownAliases(): Promise<Map<string, { id: number; status: string }>> {
  const map = new Map<string, { id: number; status: string }>()
  for (let page = 0; page < 20; page++) {
    const { data, error } = await supabaseAmin
      .from('search_alias')
      .select('id, alias_norm, status')
      .order('id', { ascending: true })
      .range(page * 1000, (page + 1) * 1000 - 1)
    if (error) throw new Error(`search_alias: ${error.message}`)
    const rows = (data ?? []) as Array<{ id: number; alias_norm: string; status: string }>
    for (const r of rows) map.set(r.alias_norm, { id: r.id, status: r.status })
    if (rows.length < 1000) break
  }
  return map
}

async function loadSessionPhrases(
  watermark: string
): Promise<{ phrases: Phrase[]; sessions: number; maxUpdatedAt: string | null }> {
  const { data, error } = await supabaseAmin
    .from('fb_messenger_sessions')
    .select('id, updated_at, conversation_log')
    .gt('updated_at', watermark)
    .order('updated_at', { ascending: true })
    .limit(SESSION_BATCH)
  if (error) throw new Error(`sessions: ${error.message}`)

  const rows = (data ?? []) as Array<{
    id: string
    updated_at: string
    conversation_log: unknown
  }>
  const byNorm = new Map<string, Phrase>()
  let maxUpdatedAt: string | null = null
  for (const s of rows) {
    maxUpdatedAt = s.updated_at
    const log = Array.isArray(s.conversation_log) ? s.conversation_log : []
    for (const text of extractUserPhrases(log as any)) {
      const norm = normalizeText(text)
      const found = byNorm.get(norm)
      if (found) found.count += 1
      else byNorm.set(norm, { text, norm, count: 1, source: 'fb_messenger' })
    }
  }
  return { phrases: Array.from(byNorm.values()), sessions: rows.length, maxUpdatedAt }
}

async function loadQueryLogPhrases(): Promise<Phrase[]> {
  const since = new Date(Date.now() - QUERY_LOG_DAYS * 86_400_000).toISOString()
  const { data, error } = await supabaseAmin
    .from('search_query_log')
    .select('q, norm')
    .eq('source', 'enter')
    .gte('created_at', since)
    .order('id', { ascending: false })
    .limit(5000)
  if (error) throw new Error(`search_query_log: ${error.message}`)

  const byNorm = new Map<string, Phrase>()
  for (const r of (data ?? []) as Array<{ q: string; norm: string | null }>) {
    const norm = r.norm ?? normalizeText(r.q)
    if (!norm || norm.length < 2) continue
    const found = byNorm.get(norm)
    if (found) found.count += 1
    else byNorm.set(norm, { text: r.q, norm, count: 1, source: 'query_log' })
  }
  return Array.from(byNorm.values())
}

// ── AI ───────────────────────────────────────────────────────────────────────

const aliasSchema = z.object({
  aliases: z.array(
    z.object({
      alias: z.string().describe('Nguyên văn câu/cụm khách gõ (giữ nguyên)'),
      canonical: z
        .string()
        .describe(
          'Bản chuẩn COPY NGUYÊN VĂN từ danh sách HÃNG / DÒNG XE / DỊCH VỤ, hoặc cỡ lốp dạng "Lốp 205/55R16"'
        ),
      type: z.enum(['SAN_PHAM', 'DICH_VU']),
      confidence: z.number().min(0).max(1)
    })
  )
})

function buildSystemPrompt(v: Vocabulary): string {
  return [
    'Bạn là bộ chuẩn hoá từ khoá tìm kiếm cho sàn dịch vụ ô tô Việt Nam (TROLYoto): lốp, ắc quy, phụ tùng, dịch vụ gara.',
    'Nhiệm vụ: với mỗi câu khách gõ, quyết định câu đó ĐANG TÌM sản phẩm/dịch vụ chuẩn nào, để lần sau gõ vậy hệ thống gợi ý đúng.',
    '',
    'QUY TẮC:',
    '1. `canonical` PHẢI copy nguyên văn một dòng trong danh sách bên dưới, HOẶC là cỡ lốp đúng dạng "Lốp 205/55R16" (3 số/2 số R 2 số).',
    '2. Chỉ tạo alias khi câu khách gõ KHÁC bản chuẩn: lỗi chính tả ("bigertone" → Lốp Bridgestone, "huyndai" → Lốp Hyundai Accent nếu có dòng xe), tiếng lóng ("lốp mít" → Lốp Michelin), viết tắt, cỡ lốp gõ tự do ("205 55 16", "205/56/15" → Lốp 205/55R16 / Lốp 205/56R15).',
    '3. BỎ QUA (không đưa vào kết quả): chào hỏi, cảm ơn, địa chỉ/khu vực, số điện thoại, hỏi giá chung chung không có sản phẩm, câu đã đúng chính tả và trùng bản chuẩn, câu không liên quan ô tô.',
    '4. Câu có nhiều ý (vd "lốp mít 185 65 15 ở hà nội") → tách thành nhiều alias riêng cho từng cụm có nghĩa ("lốp mít" → Lốp Michelin; "185 65 15" → Lốp 185/65R15). KHÔNG đưa phần địa chỉ.',
    '5. `confidence`: 0.9+ khi chắc chắn (lỗi chính tả rõ, lóng phổ biến); 0.5–0.8 khi suy đoán; dưới 0.5 thì bỏ.',
    '6. `type`: SAN_PHAM cho lốp/ắc quy/phụ kiện; DICH_VU cho việc sửa/thay/bảo dưỡng/kiểm tra.',
    '',
    `HÃNG (${v.brands.length}): ${v.brands.join(' | ')}`,
    '',
    `DÒNG XE (${v.carlines.length}): ${v.carlines.join(' | ')}`,
    '',
    `DỊCH VỤ (${v.services.length}): ${v.services.join(' | ')}`
  ].join('\n')
}

async function askAi(system: string, phrases: Phrase[]): Promise<AiAliasCandidate[]> {
  const list = phrases.map((p, i) => `${i + 1}. ${p.text}`).join('\n')
  const { object } = await generateObject({
    model: openai(MODEL) as any,
    schema: aliasSchema,
    system,
    prompt: `Các câu khách gõ:\n${list}\n\nTrả về danh sách alias theo quy tắc. Bỏ qua câu không phù hợp.`
  })
  return (object?.aliases ?? []) as AiAliasCandidate[]
}

// ── Ghi DB ───────────────────────────────────────────────────────────────────

async function upsertAliases(
  validated: ValidatedAlias[],
  phraseByNorm: Map<string, Phrase>,
  known: Map<string, { id: number; status: string }>,
  dryRun: boolean
): Promise<{ upserted: number; autoApproved: number }> {
  if (validated.length === 0) return { upserted: 0, autoApproved: 0 }

  // Dòng đã có (cùng alias_norm + canonical) → cộng evidence, giữ status trừ khi lên approved
  const keys = validated.map(v => v.alias_norm)
  const { data: existingRows, error } = await supabaseAmin
    .from('search_alias')
    .select('id, alias_norm, canonical_q, confidence, evidence_count, evidence, status')
    .in('alias_norm', keys)
  if (error) throw new Error(`search_alias read: ${error.message}`)
  const existing = new Map<string, any>()
  for (const r of (existingRows ?? []) as any[])
    existing.set(`${r.alias_norm}|${normalizeText(r.canonical_q)}`, r)

  const now = new Date().toISOString()
  const rows: any[] = []
  let autoApproved = 0
  for (const v of validated) {
    const phrase = phraseByNorm.get(v.alias_norm)
    const count = phrase?.count ?? 1
    const sample = phrase?.text ?? v.alias
    const source = phrase?.source ?? 'fb_messenger'
    const prev = existing.get(`${v.alias_norm}|${v.canonical_norm}`)
    if (prev?.status === 'rejected') continue

    const evidence_count = (prev?.evidence_count ?? 0) + count
    const confidence = Math.max(Number(prev?.confidence ?? 0), v.confidence)
    const evidence = Array.isArray(prev?.evidence) ? [...prev.evidence] : []
    if (!evidence.includes(sample)) evidence.push(sample)
    let status: string = prev?.status ?? 'pending'
    let reviewed_at: string | null = prev?.reviewed_at ?? null
    if (status === 'pending' && shouldAutoApprove(confidence, evidence_count)) {
      status = 'approved'
      reviewed_at = now
      autoApproved += 1
    }
    rows.push({
      ...(prev ? { id: prev.id } : {}),
      alias: sample,
      alias_norm: v.alias_norm,
      canonical_q: prev?.canonical_q ?? v.canonical,
      type: v.type,
      confidence,
      evidence_count,
      evidence: evidence.slice(-5),
      source,
      status,
      reviewed_at,
      updated_at: now
    })
  }

  if (dryRun || rows.length === 0) return { upserted: rows.length, autoApproved }

  const { error: upErr } = await supabaseAmin
    .from('search_alias')
    .upsert(rows, { onConflict: 'alias_norm,canonical_q' })
  if (upErr) throw new Error(`search_alias upsert: ${upErr.message}`)
  return { upserted: rows.length, autoApproved }
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

let running = false
let lastResult: MiningResult | null = null

export async function runAliasMining(opts: { dryRun?: boolean } = {}): Promise<MiningResult> {
  const dryRun = !!opts.dryRun
  const t0 = Date.now()
  const result: MiningResult = {
    dryRun,
    startedAt: new Date(t0).toISOString(),
    durationMs: 0,
    sessions: 0,
    phrasesFromSessions: 0,
    phrasesFromQueryLog: 0,
    phrasesSkippedKnown: 0,
    aiCalls: 0,
    aiCandidates: 0,
    validated: 0,
    upserted: 0,
    autoApproved: 0,
    evidenceOnly: 0,
    watermarkBefore: '',
    watermarkAfter: null,
    samples: []
  }
  if (running) {
    result.error = 'already running'
    return result
  }
  running = true
  try {
    const watermark =
      (await readState(STATE_KEY_WATERMARK)) ??
      new Date(Date.now() - FIRST_RUN_LOOKBACK_DAYS * 86_400_000).toISOString()
    result.watermarkBefore = watermark

    const [vocab, known, fromSessions, fromLog] = await Promise.all([
      loadVocabulary(),
      loadKnownAliases(),
      loadSessionPhrases(watermark),
      loadQueryLogPhrases()
    ])
    result.sessions = fromSessions.sessions
    result.phrasesFromSessions = fromSessions.phrases.length
    result.phrasesFromQueryLog = fromLog.length

    // Gộp 2 nguồn theo norm; bỏ câu ĐÃ là norm chuẩn (không cần alias) và câu đã có
    // alias (mọi status) — chỉ cộng evidence cho pending/approved.
    const phraseByNorm = new Map<string, Phrase>()
    for (const p of [...fromSessions.phrases, ...fromLog]) {
      const f = phraseByNorm.get(p.norm)
      if (f) f.count += p.count
      else phraseByNorm.set(p.norm, { ...p })
    }
    const toAsk: Phrase[] = []
    for (const p of phraseByNorm.values()) {
      if (vocab.norms.has(p.norm)) {
        result.phrasesSkippedKnown += 1
        continue
      }
      const k = known.get(p.norm)
      if (k) {
        result.evidenceOnly += 1
        continue
      }
      toAsk.push(p)
    }
    // Ưu tiên câu gặp nhiều lần
    toAsk.sort((a, b) => b.count - a.count)

    const system = buildSystemPrompt(vocab)
    const batches = chunk(toAsk, PHRASES_PER_CALL).slice(0, MAX_CALLS)
    const candidates: AiAliasCandidate[] = []
    for (const batch of batches) {
      try {
        const got = await askAi(system, batch)
        candidates.push(...got)
      } catch (e) {
        console.error('[search-alias] AI batch failed:', (e as Error)?.message ?? e)
      }
      result.aiCalls += 1
    }
    result.aiCandidates = candidates.length

    const validated = validateAliases(candidates, vocab.norms)
    result.validated = validated.length
    result.samples = validated.slice(0, 15).map(v => ({
      alias: v.alias,
      canonical: v.canonical,
      type: v.type,
      confidence: v.confidence
    }))

    const { upserted, autoApproved } = await upsertAliases(validated, phraseByNorm, known, dryRun)
    result.upserted = upserted
    result.autoApproved = autoApproved

    if (!dryRun) {
      if (fromSessions.maxUpdatedAt) {
        await writeState(STATE_KEY_WATERMARK, fromSessions.maxUpdatedAt)
        result.watermarkAfter = fromSessions.maxUpdatedAt
      }
      await writeState(
        STATE_KEY_LAST_RUN,
        JSON.stringify({ ...result, samples: undefined, durationMs: Date.now() - t0 })
      )
    }
  } catch (e) {
    result.error = (e as Error)?.message ?? String(e)
    console.error('[search-alias] run failed:', result.error)
  } finally {
    running = false
    result.durationMs = Date.now() - t0
    lastResult = result
    console.log(
      `[search-alias] ${dryRun ? 'DRY-RUN ' : ''}sessions=${result.sessions} phrases=${result.phrasesFromSessions}+${result.phrasesFromQueryLog} ` +
        `skipKnown=${result.phrasesSkippedKnown} evidenceOnly=${result.evidenceOnly} ai=${result.aiCalls}/${result.aiCandidates} ` +
        `valid=${result.validated} upsert=${result.upserted} auto=${result.autoApproved} ${result.durationMs}ms` +
        (result.error ? ` ERROR=${result.error}` : '')
    )
  }
  return result
}

export function getSearchAliasStatus() {
  return { enabled: ENABLED, runAt: RUN_AT, model: MODEL, running, lastResult }
}

// ── Lịch chạy: hằng ngày lúc RUN_AT giờ VN (pattern handover-cron.ts) ─────────

function nowVN(): { hhmm: string; day: string } {
  const vn = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
  const hh = String(vn.getHours()).padStart(2, '0')
  const mm = String(vn.getMinutes()).padStart(2, '0')
  const day = `${vn.getFullYear()}-${String(vn.getMonth() + 1).padStart(2, '0')}-${String(vn.getDate()).padStart(2, '0')}`
  return { hhmm: `${hh}:${mm}`, day }
}

let lastRunDay: string | null = null
let timer: NodeJS.Timeout | null = null

export function startSearchAliasCron(): void {
  if (!ENABLED) {
    console.log('[search-alias] cron disabled (SEARCH_ALIAS_CRON_ENABLED=0)')
    return
  }
  if (timer) return
  console.log(`[search-alias] cron armed: daily ${RUN_AT} VN, model=${MODEL}, maxCalls=${MAX_CALLS}`)
  timer = setInterval(() => {
    const { hhmm, day } = nowVN()
    if (hhmm !== RUN_AT || lastRunDay === day) return
    lastRunDay = day
    runAliasMining().catch(e => console.error('[search-alias] cron error:', e))
  }, 60_000)
}

export function stopSearchAliasCron(): void {
  if (timer) clearInterval(timer)
  timer = null
}
