/**
 * Test case cho TOÀN BỘ hãng lốp đã khai báo trong `BRAND_ALIASES`
 * (`../brandAliases.ts`) — theo yêu cầu user 2026-09-11 sau bug "lốp mít" →
 * SAILUN (session a87ce436-c48e-4a05-b531-c13ec5da8086) và bug bỏ sót brand
 * khi khách nêu 2 hãng cùng câu ("mít, sai lun").
 *
 * Port TRỰC TIẾP từ src/libs/chat/__tests__/brandAliases.test.ts (buyer/Web)
 * — GIỮ ĐỒNG BỘ khi sửa 1 bên.
 *
 * Module test KHÔNG phụ thuộc DB/env (chỉ import module thuần
 * `brandAliases.ts`) — chạy trực tiếp bằng ts-node, không cần .env/mạng:
 *
 *   npx ts-node --transpile-only src/fb/__tests__/brandAliases.test.ts
 *
 * Không dùng framework test (repo chưa có jest/vitest) — tự chấm PASS/FAIL,
 * exit code 1 nếu có case FAIL để dùng được trong CI sau này nếu cần.
 */
import { BRAND_ALIASES, resolveBrandAliasFromText } from '../brandAliases'

let pass = 0
let fail = 0
const failures: string[] = []

function check(label: string, actual: string[], expected: string[]) {
  const a = [...actual].sort().join(',')
  const e = [...expected].sort().join(',')
  if (a === e) {
    pass++
  } else {
    fail++
    failures.push(`❌ ${label}\n     input-derived=[${a}] expected=[${e}]`)
  }
}

// ── 1. MỖI alias khai báo trong BRAND_ALIASES phải tự resolve đúng về brand
//       của chính nó — cả dạng alias thô lẫn nhúng trong câu khách hàng thật ──
for (const [brand, aliases] of Object.entries(BRAND_ALIASES)) {
  for (const alias of aliases) {
    check(`[${brand}] alias thô "${alias}"`, resolveBrandAliasFromText(alias), [brand])
    check(
      `[${brand}] nhúng câu "cho hỏi lốp ${alias} còn hàng không"`,
      resolveBrandAliasFromText(`cho hỏi lốp ${alias} còn hàng không`),
      [brand]
    )
  }
}

// ── 2. Biến thể CÓ DẤU thật (khách gõ tiếng Việt có dấu/viết hoa) — theo đúng
//       ví dụ phát âm trong system prompt (ai-helper.ts mục "VIẾT TẮT/CÁCH GỌI
//       TÊN HÃNG LỐP") — đây là input THỰC TẾ khách sẽ gõ, quan trọng hơn test
//       alias thô (đã stripVn sẵn) ở mục 1. ──
const accentedRealWorld: Array<[string, string[]]> = [
  ['MICHELIN', ['Có lốp mít lắp cho xe 10 không bạn ơi?', 'cho hỏi lốp míc còn không', 'MICHELLIN có sẵn không']],
  ['BRIDGESTONE', ['lốp bri đờ giá bao nhiêu', 'Bri đờ stôn còn hàng không']],
  ['HANKOOK', ['Han cốc có mấy loại', 'hăn cốc giá sao']],
  ['DUNLOP', ['đăn lốp có tốt không', 'dăn lốp giá nhiêu']],
  ['GOODYEAR', ['Gút diê còn không shop', 'good year giá sao']],
  ['KUMHO', ['Kum hô có sẵn không', 'kum hồ giá nhiêu']],
  ['MAXXIS', ['Mắc xít giá bao nhiêu', 'mác xít có tốt không']],
  ['YOKOHAMA', ['Yô cô ha ma có không shop', 'yô hama giá sao']],
  ['CONTINENTAL', ['lốp conti có tốt không', 'em muốn xem giá continental']],
  ['PIRELLI', ['Pi rê li giá sao', 'pi reo li có sẵn không']],
  ['TOYO', ['Tô yô có mấy loại', 'lốp to yo giá sao']],
  ['FALKEN', ['Phan ken giá nhiêu', 'phai ken có sẵn không']],
  ['NEXEN', ['Nếch sen giá bao nhiêu', 'nech xen có tốt không']],
  ['SAILUN', ['Sây lun giá sao', 'sai lun có sẵn không']],
  ['ROADX', ['Rốt ích giá nhiêu', 'road x có tốt không']],
  ['LAUFENN', ['Lau fen giá bao nhiêu']],
  ['WESTLAKE', ['Goét lếch có sẵn không', 'oét lếch giá sao']],
  ['OTANI', ['Ô ta ni giá nhiêu', 'otani có tốt không']],
  ['ADVENZA', ['Advenza giá bao nhiêu shop', 'avenza giá sao']]
]
for (const [brand, phrases] of accentedRealWorld) {
  for (const phrase of phrases) {
    check(`[${brand}] câu có dấu thật "${phrase}"`, resolveBrandAliasFromText(phrase), [brand])
  }
}

// ── 3. Đa hãng trong 1 câu (bug thật: AI hay BỎ SÓT khi khách nêu ≥2 hãng —
//       xem follow.md mục 17) — deterministic PHẢI bắt đủ CẢ hai. ──
check(
  'đa hãng "có lốp mít, sai lun lắp cho xe 10 không bản ơi?"',
  resolveBrandAliasFromText('có lốp mít, sai lun lắp cho xe 10 không bản ơi?'),
  ['MICHELIN', 'SAILUN']
)
check(
  'đa hãng "so sánh michelin với bridgestone với continental giúp em"',
  resolveBrandAliasFromText('so sánh michelin với bridgestone với continental giúp em'),
  ['MICHELIN', 'BRIDGESTONE', 'CONTINENTAL']
)
check(
  'đa hãng viết tắt phát âm "conti với sai lun cái nào bền hơn"',
  resolveBrandAliasFromText('conti với sai lun cái nào bền hơn'),
  ['CONTINENTAL', 'SAILUN']
)

// ── 4. FALSE-POSITIVE PROBE — câu KHÔNG nhắc hãng nào nhưng chứa cụm từ tiếng
//       Việt phổ biến TRÙNG NGẪU NHIÊN với 1 alias sau khi stripVn. Đây là
//       rủi ro thật của cách tiếp cận whole-word match trên alias NGẮN/đa âm
//       tiết phổ thông — PHẢI trả [] (không match brand nào).
//
//       LƯU Ý: "con ti"~"còn tí" (CONTINENTAL), "cum ho"~"cụm hộ" (KUMHO),
//       "lau phan"~"lau phần" (LAUFENN) TỪNG bị coi là false-positive và bị
//       xoá khỏi BRAND_ALIASES — nhưng theo quyết định user (2026-09-11): GIỮ
//       NGUYÊN 3 alias đó, vì đặc thù chat mua lốp qua Messenger không bao
//       giờ thực sự phát sinh 3 cụm đời thường này. Nên KHÔNG còn test case
//       false-positive cho 3 cụm đó nữa (đã xoá khỏi list dưới). ──
const falsePositiveProbes: string[] = [
  // brand tên xe dễ nhầm — "toyo" là whole-word con của "toyota" nhưng
  // KHÔNG được match nhờ whole-word (test khẳng định không false-positive).
  'xe em là Toyota Vios',
  'xe Mitsubishi Xpander đời 2021',
  // câu chào hỏi/off-topic chung chung — không brand nào.
  'xin chào ạ, shop còn mở cửa không',
  'em cảm ơn nhiều ạ',
  'bao giờ giao được lốp cho em'
]
for (const phrase of falsePositiveProbes) {
  const result = resolveBrandAliasFromText(phrase)
  if (result.length === 0) {
    pass++
  } else {
    fail++
    failures.push(
      `❌ FALSE-POSITIVE "${phrase}"\n     → match nhầm [${result.join(',')}] (kỳ vọng KHÔNG match brand nào)`
    )
  }
}

// ── 5. Audit song song PROMPT (danh sách brand AI được dạy) vs BRAND_ALIASES
//       (bảng deterministic) — phát hiện brand có trong 1 bên mà thiếu bên kia. ──
const PROMPT_DECLARED_BRANDS = [
  'MICHELIN', 'BRIDGESTONE', 'HANKOOK', 'DUNLOP', 'GOODYEAR', 'KUMHO', 'MAXXIS',
  'YOKOHAMA', 'CONTINENTAL', 'PIRELLI', 'TOYO', 'FALKEN', 'NEXEN', 'ADVANCE',
  'SAILUN', 'ROADX', 'LAUFENN', 'TBB', 'WESTLAKE', 'OTANI', 'ADVENZA'
]
const codeBrands = Object.keys(BRAND_ALIASES)
const missingFromCode = PROMPT_DECLARED_BRANDS.filter(b => !codeBrands.includes(b))
const missingFromPrompt = codeBrands.filter(b => !PROMPT_DECLARED_BRANDS.includes(b))

console.log('\n=== AUDIT: prompt (ai-helper.ts) vs BRAND_ALIASES (code) ===')
if (missingFromCode.length > 0) {
  console.log(`⚠️  Có trong PROMPT nhưng THIẾU trong BRAND_ALIASES (code): ${missingFromCode.join(', ')}`)
}
if (missingFromPrompt.length > 0) {
  console.log(`⚠️  Có trong BRAND_ALIASES (code) nhưng KHÔNG thấy alias phonetic trong PROMPT: ${missingFromPrompt.join(', ')}`)
}
if (missingFromCode.length === 0 && missingFromPrompt.length === 0) {
  console.log('✅ Khớp hoàn toàn.')
}

// ── Report ──
console.log(`\n=== KẾT QUẢ: ${pass} pass / ${fail} fail (tổng ${pass + fail}) ===`)
if (failures.length > 0) {
  console.log(failures.join('\n'))
  process.exit(1)
}
