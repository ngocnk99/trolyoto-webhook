/**
 * Task search-suggest-v2 — GĐ3: mining alias tìm kiếm từ ngôn ngữ thật của khách.
 *
 * Module THUẦN (không import) — test bằng tsc + node:test (npm run test:alias).
 * Phần gọi AI / Supabase nằm ở search-alias-cron.ts.
 *
 * "Alias" = cách khách gõ ("bigertone", "lop mít", "205/56/15") ↔ bản chuẩn trong
 * search_dictionary ("Lốp Bridgestone", "Lốp Michelin", "Lốp 205/55R15").
 * Runtime KHÔNG gọi AI: alias approved được refresh đêm nhồi vào từ điển.
 */

export interface ConversationMessageLike {
  role: string
  type?: string
  text?: string
  hidden_from_ai?: boolean
}

/** Bỏ dấu + thường hoá + gộp khoảng trắng — KHỚP system_shared_immutable_unaccent(lower(trim())). */
export function normalizeText(str: string): string {
  if (!str) return ''
  return str
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

const MIN_LEN = 3
const MAX_LEN = 120
/** Tin hệ thống/bot ghi vào log dạng "[event]", "[referral: ADS/]", "[attachment/template]" */
const SYSTEM_TEXT = /^\[/
/** Chỉ số/SĐT/mã đơn — không phải từ khoá tìm kiếm (giữ lại cỡ lốp dạng 205/55/16) */
const ONLY_DIGITS = /^[\d\s.+-]+$/
const PHONE = /(^|\D)0\d{9,10}(\D|$)|(^|\D)84\d{9}(\D|$)/
/** Chào hỏi / chốt hội thoại — không mang ý định sản phẩm */
const CHITCHAT = /^(ok|oke|okie|vang|vâng|da|dạ|cam on|cảm ơn|thank|thanks|hi|hello|alo|chao|chào|ừ|u|uh|um|đc|dc|được|duoc|k|ko|không|khong|có|co|yes|no)\b[!. ]*$/i

/**
 * Lấy câu người dùng THẬT từ conversation_log của 1 session:
 * role='user', không hidden_from_ai, không phải tin hệ thống, không phải SĐT/chit-chat.
 * Dedupe theo bản chuẩn hoá trong cùng session.
 */
export function extractUserPhrases(log: ConversationMessageLike[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of log ?? []) {
    if (!m || m.role !== 'user' || m.hidden_from_ai) continue
    if (m.type && m.type !== 'text') continue
    const text = (m.text ?? '').replace(/\s+/g, ' ').trim()
    if (text.length < MIN_LEN || text.length > MAX_LEN) continue
    if (SYSTEM_TEXT.test(text) || ONLY_DIGITS.test(text) || PHONE.test(text)) continue
    if (CHITCHAT.test(text)) continue
    const norm = normalizeText(text)
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    out.push(text)
  }
  return out
}

export interface AiAliasCandidate {
  alias: string
  canonical: string
  type: 'SAN_PHAM' | 'DICH_VU'
  confidence: number
}

export interface ValidatedAlias extends AiAliasCandidate {
  alias_norm: string
  canonical_norm: string
}

const SIZE_RE = /^lop \d{3}\/\d{2}r\d{2}c?$/
/** Alias phải là CỤM NGẮN khách sẽ gõ lại ("lop mit", "bigertone"), không phải cả câu. */
export const MAX_ALIAS_TOKENS = 5

/**
 * Lọc kết quả AI trước khi ghi DB:
 *  - canonical PHẢI có trong từ điển (norm khớp) — chặn AI bịa bản chuẩn;
 *    ngoại lệ: cỡ lốp đúng dạng "Lốp 205/55R16" (từ điển đã sinh mọi size đang bán,
 *    nhưng khách có thể hỏi size chưa bán — vẫn giữ để route đúng).
 *  - alias_norm ≠ canonical_norm và alias_norm KHÔNG phải một norm chuẩn sẵn có
 *    (alias trùng bản chuẩn thì vô nghĩa).
 *  - confidence >= minConfidence; alias 2..80 ký tự.
 */
export function validateAliases(
  cands: AiAliasCandidate[],
  dictionaryNorms: ReadonlySet<string>,
  minConfidence = 0.5
): ValidatedAlias[] {
  const out: ValidatedAlias[] = []
  const seen = new Set<string>()
  for (const c of cands ?? []) {
    if (!c || typeof c.alias !== 'string' || typeof c.canonical !== 'string') continue
    if (c.type !== 'SAN_PHAM' && c.type !== 'DICH_VU') continue
    const conf = Number(c.confidence)
    if (!Number.isFinite(conf) || conf < minConfidence) continue
    const alias_norm = normalizeText(c.alias)
    const canonical_norm = normalizeText(c.canonical)
    if (alias_norm.length < 2 || alias_norm.length > 80) continue
    if (alias_norm.split(' ').length > MAX_ALIAS_TOKENS) continue
    if (!canonical_norm || alias_norm === canonical_norm) continue
    if (dictionaryNorms.has(alias_norm)) continue
    if (!dictionaryNorms.has(canonical_norm) && !SIZE_RE.test(canonical_norm)) continue
    const key = `${alias_norm}|${canonical_norm}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...c, confidence: conf, alias_norm, canonical_norm })
  }
  return out
}

/** Ngưỡng tự duyệt: chắc chắn cao VÀ gặp ở >= 3 session/query khác nhau. */
export const AUTO_APPROVE_CONFIDENCE = 0.9
export const AUTO_APPROVE_EVIDENCE = 3

export function shouldAutoApprove(confidence: number, evidenceCount: number): boolean {
  return confidence >= AUTO_APPROVE_CONFIDENCE && evidenceCount >= AUTO_APPROVE_EVIDENCE
}

/** Chia mảng thành các batch cố định (gửi AI mỗi batch 1 lượt). */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
