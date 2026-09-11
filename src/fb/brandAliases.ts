/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  brandAliases — bảng alias/cách gọi hãng lốp + hàm quét deterministic.
 *
 *  TÁCH RIÊNG khỏi db.ts (không phụ thuộc Supabase/env) để test được bằng
 *  `ts-node` thuần, không cần DB — xem `src/fb/__tests__/brandAliases.test.ts`.
 *
 *  Port từ src/libs/chat/brandAliases.ts (buyer/Web) — GIỮ ĐỒNG BỘ khi sửa 1 bên.
 * ─────────────────────────────────────────────────────────────────────────────
 */

function stripVn(s: string): string {
  return s
    .toLowerCase()
    .replace(/đ/g, 'd') // "Đ" không có canonical decomposition trong NFD (không
    // giống các nguyên âm có dấu) -> normalize('NFD') KHÔNG tách được nó, phải
    // thay tay trước, nếu không catch-all bên dưới sẽ XOÁ HẲN chữ "đ" (không
    // phải chuyển thành "d") -> "Đốc" thành "oc" thay vì "doc", gây sai lệch
    // toàn bộ các so khớp chứa chữ đầu "Đ" (vd "Nam Định", "Bình Định", "Đắk
    // Nông", "Châu Đốc"...).
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * `haystack.includes(needle)` nhưng bắt buộc `needle` khớp theo RANH GIỚI TỪ
 * (đứng đầu/cuối chuỗi hoặc có khoảng trắng bao quanh) — KHÔNG chấp nhận
 * `needle` nằm lọt thỏm giữa 1 từ khác. Cả `haystack` lẫn `needle` đều phải
 * đã qua `stripVn()` trước (chỉ còn chữ/số/khoảng trắng đơn). Bản sao riêng
 * của hàm cùng tên trong `db.ts` (giữ module này zero-dependency).
 */
function includesWholeWord(haystack: string, needle: string): boolean {
  if (!needle) return false
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(haystack)
}

/**
 * Bảng alias/cách gọi hãng lốp — đã stripVn (không dấu, thường) sẵn. Port
 * TRỰC TIẾP từ danh sách "VIẾT TẮT/CÁCH GỌI TÊN HÃNG LỐP" trong system prompt
 * v3GatherTurn (ai-helper.ts) — GIỮ ĐỒNG BỘ khi sửa 1 bên. CỐ Ý KHÔNG gồm mã
 * viết tắt 2-3 ký tự (MC/BS/HK...) — quá ngắn, dễ false-positive nếu match mù
 * quáng không ngữ cảnh (khác lớp bài toán tên tỉnh/ward đã fix trước — brand
 * KHÔNG có "vị trí trong câu" để dựa vào, nên chỉ nhận biến thể ĐỦ DÀI/ĐẶC
 * TRƯNG). Cũng KHÔNG gồm "mix" (alias Michelin trong prompt) vì "mix" là từ
 * tiếng Anh quá phổ biến trong tiếng Việt (rủi ro match nhầm ngữ cảnh khác).
 *
 * ĐÃ CÂN NHẮC bỏ 3 alias 2-âm-tiết sau (phát hiện qua
 * `__tests__/brandAliases.test.ts` mục "FALSE-POSITIVE PROBE", 2026-09-11) vì
 * trùng NGẪU NHIÊN với cụm từ tiếng Việt phổ biến ("con ti"~"còn tí",
 * "cum ho"~"cụm hộ", "lau phan"~"lau phần") — nhưng theo quyết định user
 * (2026-09-11): GIỮ NGUYÊN cả 3, vì đặc thù chat qua Messenger (khách hàng
 * hỏi mua lốp) KHÔNG BAO GIỜ thực sự gõ các cụm đời thường đó trong ngữ cảnh
 * này — rủi ro lý thuyết, không phải rủi ro thực tế của kênh chat này. 3 test
 * case false-positive tương ứng đã bị xoá khỏi test suite (không còn là
 * kỳ vọng đúng).
 */
export const BRAND_ALIASES: Record<string, string[]> = {
  MICHELIN: ['michelin', 'michellin', 'mit', 'mic', 'ma so lin', 'mi so lin', 'mi so lang'],
  BRIDGESTONE: ['bridgestone', 'bri do', 'bri do ston', 'be rit gi ton', 'bri so ton'],
  HANKOOK: ['hankook', 'han coc', 'han cook', 'han kook'],
  DUNLOP: ['dunlop', 'dan lop', 'dan lop'],
  GOODYEAR: ['goodyear', 'good year', 'gut die', 'gut nam', 'good iya'],
  KUMHO: ['kumho', 'kum ho', 'kum ho', 'cum ho'],
  MAXXIS: ['maxxis', 'mac xit', 'max xit', 'max sit'],
  YOKOHAMA: ['yokohama', 'yo co ha ma', 'yo ko ha ma', 'yo hama'],
  CONTINENTAL: ['continental', 'conti', 'con ti'],
  PIRELLI: ['pirelli', 'pi reo li', 'pi re li'],
  TOYO: ['toyo', 'to yo'],
  FALKEN: ['falken', 'phan ken', 'phai ken'],
  NEXEN: ['nexen', 'nech sen', 'nech xen'],
  SAILUN: ['sailun', 'sai lun', 'say lun'],
  ROADX: ['roadx', 'road x', 'rot ich'],
  LAUFENN: ['laufenn', 'lau fen', 'lau phan'],
  TBB: ['ti bi bi'],
  WESTLAKE: ['westlake', 'goet lech', 'oet lech'],
  OTANI: ['otani', 'o ta ni'],
  ADVENZA: ['advenza', 'avenza', 'ad venza'],
  DAYTON: ['dayton'],
  AMERICAN: ['american']
}

/**
 * Quét trực tiếp `text` KHÁCH GÕ (chưa qua AI) theo bảng alias cố định ở trên
 * — trả về danh sách hãng khớp (whole-word, không đoán ngoài whitelist).
 *
 * Bug thật (session a87ce436-c48e-4a05-b531-c13ec5da8086, 2026-09-11): khách
 * gõ "Có lốp mít lắp cho xe 10 không bạn ơi?" — "mít" là alias CÓ SẴN của
 * MICHELIN ngay trong chính system prompt (kèm ví dụ MINH HOẠ gần như y hệt
 * câu này: "lốp mít có dùng cho xe i10 không"), nhưng AI vẫn trả nhầm
 * selected_brands=['SAILUN'] — hoàn toàn không khớp BẤT KỲ từ nào khách gõ,
 * AI KHÔNG tuân thủ prompt dù hướng dẫn đã rất rõ ràng (không phải lỗi thiếu
 * ví dụ — ví dụ đã có, AI vẫn sai). Cùng bản chất "không tin AI tuyệt đối"
 * như các fix location trước đó — brand alias là bảng CỐ ĐỊNH, hữu hạn, khớp
 * chuỗi trực tiếp đáng tin hơn quyết định AI khi có mâu thuẫn.
 */
export function resolveBrandAliasFromText(text: string): string[] {
  const haystack = stripVn(text)
  if (!haystack) return []
  const found = new Set<string>()
  for (const [brand, aliases] of Object.entries(BRAND_ALIASES)) {
    if (aliases.some(a => includesWholeWord(haystack, a))) {
      found.add(brand)
    }
  }
  return Array.from(found)
}
