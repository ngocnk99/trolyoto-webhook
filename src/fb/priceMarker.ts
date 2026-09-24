/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  priceMarker — kiểm tra DETERMINISTIC tin khách có thực sự nêu GIÁ TIỀN
 *  không, trước khi tin `max_price_vnd` do AI (v3GatherTurn) trích ra.
 *
 *  Bug thật (session e617aefa, 2026-09-21): khách gõ "275/35r19 2 quả" (ý nói
 *  mua 2 LỐP) → AI hiểu "2 quả" theo tiếng lóng = 2 triệu → max_price=2000000
 *  (tái hiện 3/3 lần) → Hankook 275/35R19 ở Hà Nội có thật (4.650.000đ) nhưng
 *  bị lọc sạch mọi tầng → bot báo "không có" + chuyển CSKH.
 *
 *  Nguyên tắc (cùng triết lý `resolveBrandAliasFromText`): có tín hiệu cố định
 *  đủ chắc thì không tin AI mù quáng. CHỈ chấp nhận max_price khi tin nhắn có
 *  ĐƠN VỊ TIỀN rõ ràng sau 1 con số ("2tr", "2tr5", "2 triệu", "800k", "2 củ",
 *  "500 nghìn/ngàn", "1.500.000đ", "vnd"/"đồng") HOẶC 1 số tiền viết đầy đủ
 *  (≥5 chữ số, hoặc nhóm nghìn "800.000"/"1,500,000"). "N quả/chiếc/cái/lốp/bộ"
 *  là SỐ LƯỢNG, KHÔNG phải giá — cố ý KHÔNG nhận "quả" làm đơn vị tiền dù có
 *  nơi dùng tiếng lóng này (ngữ cảnh mua lốp gần như luôn là số lượng).
 *
 *  Module THUẦN (zero-dependency) — test bằng ts-node không cần DB/env:
 *    npx ts-node --transpile-only src/fb/__tests__/priceMarker.test.ts
 *  Bản song song ở Web: src/libs/chat/priceMarker.ts — GIỮ ĐỒNG BỘ khi sửa.
 *  KHÔNG dùng regex lookbehind (Safari iOS đời cũ crash cả chunk ở bản Web).
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Bỏ dấu tiếng Việt + lowercase — "triệu" → "trieu", "củ" → "cu", "đ" → "d".
 *  Sau bước này mọi chữ cái là ASCII nên `\b` hoạt động đúng (với chữ có dấu,
 *  `\b` coi "ư" là non-word → "tr" trong "trước" sẽ khớp nhầm "tr" = triệu). */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

/** Số + đơn vị tiền. "tr" có thể dính số phía sau ("2tr5" = 2.5 triệu) nên
 *  chấp nhận ranh giới HOẶC chữ số ngay sau. */
const MONEY_UNIT_RE =
  /\d\s*(?:(?:trieu|tr)(?:\d|\b)|(?:cu|k|nghin|ngan|dong|vnd|d)\b)/

/** Số tiền viết đầy đủ: nhóm nghìn ("800.000", "1,500,000") hoặc 5-9 chữ số
 *  liền. Chuỗi ≥10 chữ số (SĐT "0968866983") không khớp vì bị chặn 2 đầu
 *  bởi ký tự không phải số. Size lốp ("275/35r19") chỉ có nhóm ≤3 chữ số. */
const FULL_AMOUNT_RE =
  /(?:^|[^\d.,])(?:\d{1,3}(?:[.,]\d{3})+|\d{5,9})(?![\d.,]*\d)/

export function hasExplicitPriceMarker(text: string): boolean {
  if (!text) return false
  const t = normalize(text)
  return MONEY_UNIT_RE.test(t) || FULL_AMOUNT_RE.test(t)
}

/** Số + đơn vị, có bắt nhóm để TÍNH ra tiền (khác MONEY_UNIT_RE chỉ dò có/không). */
const AMOUNT_WITH_UNIT_RE =
  /(\d+(?:[.,]\d+)?)\s*(trieu|tr|cu|k|nghin|ngan)(\d?)/g
const FULL_AMOUNT_CAPTURE_RE = /(?:^|[^\d.,])(\d{1,3}(?:[.,]\d{3})+|\d{5,9})(?![\d.,]*\d)/g

/**
 * Trích ngưỡng giá (VND) bằng LUẬT CỐ ĐỊNH — dùng làm lưới an toàn khi AI bỏ
 * sót giá khách nêu.
 *
 * Vì sao cần: benchmark 2026-09-24 cho thấy gpt-5.6-luna/gpt-6-luna trả null
 * ở 6/6 lượt khách nêu giá trong câu SO SÁNH ("2150k/quả à", "bên kia báo
 * 1.65tr", "Từ sơn mình hỏi rồi 3250k/cái") — mất ngưỡng lọc giá, bot tiếp tục
 * đẩy sản phẩm đắt hơn mức khách vừa nói. gpt-4o-mini bắt đúng cả 6.
 *
 * Quy tắc: lấy giá trị LỚN NHẤT tìm được trong câu (khách hay nêu 1 số; khi
 * nêu khoảng "1.5-2tr" thì cận trên là ngưỡng, đúng quy ước đang dùng ở prompt).
 * Bỏ số < 100k (nhiễu) và > 50 triệu (không phải giá 1 lốp xe con).
 * Trả null nếu câu không có đơn vị tiền rõ ràng — KHÔNG đoán từ số trần.
 */
export function extractExplicitPriceVnd(text: string): number | null {
  if (!text || !hasExplicitPriceMarker(text)) return null
  const t = normalize(text)
  const found: number[] = []

  // Array.from(...) thay vì for...of THẲNG trên iterator: repo Web không đặt
  // `target` trong tsconfig → TypeScript mặc định ES5, hạ cấp for...of thành
  // vòng lặp theo `.length` nên iterator của matchAll chạy 0 vòng và hàm luôn
  // trả null (bug thật lúc mirror sang Web 2026-09-24, FB target ES2022 không
  // lộ ra). GIỮ NGUYÊN Array.from khi sửa 2 bản.
  for (const m of Array.from(t.matchAll(AMOUNT_WITH_UNIT_RE))) {
    const base = parseFloat(m[1].replace(',', '.'))
    if (!Number.isFinite(base)) continue
    const unit = m[2]
    // "2tr5" = 2,5 triệu — chữ số dính ngay sau "tr" là phần thập phân.
    const tail = m[3] ? parseFloat(`0.${m[3]}`) : 0
    if (unit === 'trieu' || unit === 'tr' || unit === 'cu') {
      found.push(Math.round((base + tail) * 1_000_000))
    } else {
      found.push(Math.round(base * 1_000))
    }
  }

  for (const m of Array.from(t.matchAll(FULL_AMOUNT_CAPTURE_RE))) {
    const n = parseInt(m[1].replace(/[.,]/g, ''), 10)
    if (Number.isFinite(n)) found.push(n)
  }

  const valid = found.filter(n => n >= 100_000 && n <= 50_000_000)
  return valid.length > 0 ? Math.max(...valid) : null
}
