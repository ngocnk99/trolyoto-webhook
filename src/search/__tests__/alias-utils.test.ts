/**
 * Task search-suggest-v2 GĐ3 — test phần thuần của mining alias.
 * Chạy: npm run test:alias  (tsc + node:test, không thêm framework)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chunk,
  extractUserPhrases,
  normalizeText,
  shouldAutoApprove,
  validateAliases
} from '../alias-utils'

// ── extractUserPhrases ───────────────────────────────────────────────────────

test('lấy câu user thật, bỏ tin hệ thống / bot / hidden / SĐT / chit-chat', () => {
  const log = [
    { role: 'bot', type: 'text', text: 'Anh ở khu vực nào ạ?' },
    { role: 'user', type: 'text', text: '[event]' },
    { role: 'user', type: 'text', text: '[referral: ADS/]' },
    { role: 'user', type: 'text', text: '205/56/15 bigertone' },
    { role: 'user', type: 'text', text: 'Cảm ơn' },
    { role: 'user', type: 'text', text: 'ok' },
    { role: 'user', type: 'text', text: '0912345678' },
    { role: 'user', type: 'text', text: 'lốp mít cho i10', hidden_from_ai: true },
    { role: 'user', type: 'qr_click', text: 'MICHELIN' },
    { role: 'user', type: 'text', text: 'Lốp mít cho i10' },
    { role: 'user', type: 'text', text: 'lốp mít cho i10' } // trùng sau chuẩn hoá
  ]
  assert.deepEqual(extractUserPhrases(log), ['205/56/15 bigertone', 'Lốp mít cho i10'])
})

test('bỏ câu quá ngắn / quá dài / toàn số', () => {
  const log = [
    { role: 'user', type: 'text', text: 'ab' },
    { role: 'user', type: 'text', text: '123 456' },
    { role: 'user', type: 'text', text: 'x'.repeat(200) },
    { role: 'user', type: 'text', text: 'thay ắc quy' }
  ]
  assert.deepEqual(extractUserPhrases(log), ['thay ắc quy'])
})

// ── validateAliases ──────────────────────────────────────────────────────────

const DICT = new Set(['lop bridgestone', 'lop michelin', 'thay ac quy', 'lop 185/65r15'])

test('giữ alias hợp lệ, chuẩn hoá norm', () => {
  const out = validateAliases(
    [{ alias: 'Bigertone', canonical: 'Lốp Bridgestone', type: 'SAN_PHAM', confidence: 0.95 }],
    DICT
  )
  assert.equal(out.length, 1)
  assert.equal(out[0].alias_norm, 'bigertone')
  assert.equal(out[0].canonical_norm, 'lop bridgestone')
})

test('loại canonical AI bịa (không có trong từ điển)', () => {
  const out = validateAliases(
    [{ alias: 'lop hankok', canonical: 'Lốp Hankok', type: 'SAN_PHAM', confidence: 0.9 }],
    DICT
  )
  assert.equal(out.length, 0)
})

test('ngoại lệ: canonical là cỡ lốp đúng dạng dù chưa có trong từ điển', () => {
  const out = validateAliases(
    [{ alias: '205 56 15', canonical: 'Lốp 205/56R15', type: 'SAN_PHAM', confidence: 0.8 }],
    DICT
  )
  assert.equal(out.length, 1)
})

test('loại alias trùng bản chuẩn hoặc alias đã là norm chuẩn', () => {
  const out = validateAliases(
    [
      { alias: 'Lốp Michelin', canonical: 'Lốp Michelin', type: 'SAN_PHAM', confidence: 0.99 },
      { alias: 'thay ắc quy', canonical: 'Lốp Michelin', type: 'SAN_PHAM', confidence: 0.99 }
    ],
    DICT
  )
  assert.equal(out.length, 0)
})

test('loại alias là cả câu (> 5 từ) — không ai gõ lại y hệt', () => {
  const out = validateAliases(
    [
      { alias: 'lốp TBB mình định thay 4 quả cho xe', canonical: 'Lốp Bridgestone', type: 'SAN_PHAM', confidence: 0.9 },
      { alias: 'lốp tbb', canonical: 'Lốp Bridgestone', type: 'SAN_PHAM', confidence: 0.9 }
    ],
    DICT
  )
  assert.deepEqual(out.map(x => x.alias_norm), ['lop tbb'])
})

test('loại confidence thấp / type sai / trùng cặp', () => {
  const out = validateAliases(
    [
      { alias: 'lop mit', canonical: 'Lốp Michelin', type: 'SAN_PHAM', confidence: 0.3 },
      { alias: 'lop mit', canonical: 'Lốp Michelin', type: 'XYZ' as any, confidence: 0.9 },
      { alias: 'lop mit', canonical: 'Lốp Michelin', type: 'SAN_PHAM', confidence: 0.9 },
      { alias: 'Lốp mít', canonical: 'Lốp Michelin', type: 'SAN_PHAM', confidence: 0.8 }
    ],
    DICT
  )
  assert.equal(out.length, 1)
  assert.equal(out[0].confidence, 0.9)
})

// ── shouldAutoApprove / chunk / normalizeText ────────────────────────────────

test('tự duyệt chỉ khi confidence >= 0.9 và evidence >= 3', () => {
  assert.equal(shouldAutoApprove(0.95, 3), true)
  assert.equal(shouldAutoApprove(0.95, 2), false)
  assert.equal(shouldAutoApprove(0.8, 10), false)
})

test('chunk chia đúng', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})

test('normalizeText khớp quy ước unaccent lower', () => {
  assert.equal(normalizeText('  Lốp   Mít  '), 'lop mit')
  assert.equal(normalizeText('Đảo lốp'), 'dao lop')
})
