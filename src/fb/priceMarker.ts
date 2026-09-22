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
