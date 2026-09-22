/**
 * Test `hasExplicitPriceMarker` (`../priceMarker.ts`) — bug "2 quả" → 2 triệu
 * (session e617aefa, 2026-09-21), xem docstring module.
 *
 * Port TRỰC TIẾP sang src/libs/chat/__tests__/priceMarker.test.ts (buyer/Web)
 * — GIỮ ĐỒNG BỘ khi sửa 1 bên.
 *
 *   npx ts-node --transpile-only src/fb/__tests__/priceMarker.test.ts
 *
 * Tự chấm PASS/FAIL, exit code 1 nếu có case FAIL.
 */
import { hasExplicitPriceMarker } from '../priceMarker'

let pass = 0
let fail = 0

function expect(text: string, expected: boolean, note: string): void {
  const got = hasExplicitPriceMarker(text)
  if (got === expected) {
    pass++
  } else {
    fail++
    console.log(`FAIL [${note}] "${text}" → ${got}, mong đợi ${expected}`)
  }
}

// ── CÓ nêu giá → true ──────────────────────────────────────────────────────
expect('dưới 2tr', true, 'tr')
expect('michelin dưới 2tr', true, 'brand + tr')
expect('tầm 2tr5', true, 'tr dính số')
expect('2 triệu', true, 'triệu')
expect('tầm 1.5-2 triệu', true, 'khoảng triệu')
expect('2.5 trieu', true, 'không dấu')
expect('800k', true, 'k')
expect('tầm 800 k thôi', true, 'k cách số')
expect('dưới 2 củ', true, 'củ')
expect('500 nghìn', true, 'nghìn')
expect('500 ngàn', true, 'ngàn')
expect('1.500.000đ', true, 'nhóm nghìn + đ')
expect('1500000', true, '7 chữ số')
expect('800.000', true, 'nhóm nghìn')
expect('1,500,000 vnd', true, 'dấu phẩy + vnd')
expect('2 triệu đồng', true, 'đồng')
expect('2900k/1 quả đắt quá', true, 'giá + quả (session 472859b9)')

// ── KHÔNG nêu giá → false ──────────────────────────────────────────────────
expect('275/35r19 2 quả\n245/40r19', false, 'bug e617aefa: quả = số lượng')
expect('2 quả', false, 'quả')
expect('lấy 4 quả', false, 'quả')
expect('4 chiếc', false, 'chiếc')
expect('2 cái', false, 'cái')
expect('thay 4 lốp', false, 'lốp')
expect('1 bộ', false, 'bộ')
expect('185/65R15', false, 'size')
expect('215/55r17 94V', false, 'size + load index')
expect('lốp r19 trước', false, '"tr" trong "trước"')
expect('Hankook', false, 'brand')
expect('Hà Nội', false, 'địa chỉ')
expect('0968866983', false, 'SĐT')
expect('giá cao quá', false, 'chê giá không số')
expect('bao nhiêu một chiếc vậy', false, 'hỏi giá chung')
expect('xe đời 2019', false, 'năm')
expect('', false, 'rỗng')

console.log(`priceMarker: ${pass} PASS, ${fail} FAIL`)
if (fail > 0) process.exit(1)
