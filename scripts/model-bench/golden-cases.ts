/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Bộ case VÀNG cho v3GatherTurn — mỗi case là 1 lỗi THẬT đã ghi trong
 *  follow.md (mục ⚠️) hoặc 1 hành vi bắt buộc của prompt. Đáp án gán TAY.
 *
 *  Chỉ chấm TẦNG AI (decision.updates/action/off_topic_kind). Các chốt chặn
 *  deterministic phía sau (priceMarker, brandAliases, parseExplicitTireSize,
 *  resolveProvinceSync...) KHÔNG chạy ở đây — mục đích là đo model TỰ nó hiểu
 *  đúng tới đâu, vì mỗi chốt chặn đó sinh ra từ 1 lần model hiểu sai.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { V3GatherCollected } from '../../src/fb/ai-helper'

export interface Expect {
  /** null = BẮT BUỘC không được set. undefined = không chấm field này. */
  tire_size?: string | null
  selected_brands?: string[] | null
  brand_tier?: string | null
  /** Regex — AI trả text tự do, code phía sau mới resolve ra mã tỉnh. */
  province_name?: RegExp | null
  car_model?: RegExp | null
  max_price?: number | null
  wants_best_quality?: boolean | null
  action?: string
  off_topic_kind?: string | null
}

export interface GoldenCase {
  id: string
  group: 'size' | 'price' | 'brand' | 'car' | 'location' | 'offtopic' | 'echo'
  /** State TRƯỚC lượt này. */
  collected: V3GatherCollected
  history?: Array<{ role: 'bot' | 'user'; text: string }>
  userInput: string
  expect: Expect
  /** Vì sao case này tồn tại (bug thật / rule trong follow.md). */
  why: string
}

const EMPTY: V3GatherCollected = {}

const AFTER_RESULTS: V3GatherCollected = {
  tire_size: '185/65R15',
  selected_brands: ['MICHELIN'],
  brand_tier: 'all',
  province_name: 'Hà Nội'
}

export const GOLDEN_CASES: GoldenCase[] = [
  // ── SIZE ──────────────────────────────────────────────────────────────────
  {
    id: 'size-plain',
    group: 'size',
    collected: EMPTY,
    userInput: '185/65R15',
    expect: { tire_size: '185/65R15' },
    why: 'Case cơ bản nhất — phải trích đúng size.'
  },
  {
    id: 'size-suffix-C',
    group: 'size',
    collected: EMPTY,
    userInput: 'cho mình hỏi lốp 195/70R15C',
    expect: { tire_size: '195/70R15C' },
    why: 'follow.md: hậu tố "C" là SKU catalog KHÁC, bỏ mất sẽ tra sai (bug ae22724b).'
  },
  {
    id: 'size-speed-rating',
    group: 'size',
    collected: EMPTY,
    userInput: 'Lốp michelin 235/60R -18 giá sao ạ',
    expect: { tire_size: '235/60R18', selected_brands: ['MICHELIN'] },
    why: 'Khách gõ rời rạc "R -18"; đồng thời phải bắt được brand trong cùng câu.'
  },
  {
    id: 'size-two-sizes',
    group: 'size',
    collected: EMPTY,
    userInput: '275/35r19 2 quả\n245/40r19',
    expect: { max_price: null },
    why: 'Case thật session e617aefa — 2 size trong 1 tin, KHÔNG được biến "2 quả" thành giá.'
  },

  // ── PRICE ─────────────────────────────────────────────────────────────────
  {
    id: 'price-qua-is-quantity',
    group: 'price',
    collected: EMPTY,
    userInput: '275/35r19 2 quả',
    expect: { tire_size: '275/35R19', max_price: null },
    why: 'BUG GỐC session e617aefa: AI hiểu "2 quả" = 2 triệu → lọc sạch hàng có thật.'
  },
  {
    id: 'price-chiec-is-quantity',
    group: 'price',
    collected: { tire_size: '185/65R15' },
    userInput: 'lấy 4 chiếc',
    expect: { max_price: null },
    why: 'Cùng lớp lỗi với "2 quả" — "N chiếc" là số lượng.'
  },
  {
    id: 'price-explicit-tr',
    group: 'price',
    collected: { tire_size: '185/65R15' },
    userInput: 'michelin dưới 2tr',
    expect: { max_price: 2000000, selected_brands: ['MICHELIN'] },
    why: 'Phải nhận ĐÚNG giá khi có đơn vị tiền, và brand đi kèm không bị bỏ sót.'
  },
  {
    id: 'price-k-per-tire',
    group: 'price',
    collected: AFTER_RESULTS,
    history: [
      { role: 'bot', text: 'Dạ TROLYoto đã tìm được sản phẩm phù hợp 😊' },
      { role: 'user', text: 'giá sao' }
    ],
    userInput: '2900k/1 quả đắt quá',
    expect: { max_price: 2900000 },
    why: 'follow.md session 472859b9 — có số + đơn vị "k" thì PHẢI nhận, dù kèm chữ "quả".'
  },
  {
    id: 'price-complaint-no-number',
    group: 'price',
    collected: AFTER_RESULTS,
    history: [
      { role: 'bot', text: 'Dạ TROLYoto đã tìm được sản phẩm phù hợp 😊' }
    ],
    userInput: 'Giá cao quá',
    expect: { max_price: null, action: 'continue' },
    why: 'follow.md ⚠️: chê giá không kèm số → KHÔNG tự đoán số, phải hỏi lại.'
  },
  {
    id: 'price-nudge-number-in-history',
    group: 'price',
    collected: AFTER_RESULTS,
    history: [
      { role: 'bot', text: 'TRỢ GIÁ tới 800K đã sẵn sàng cho mình ạ!' },
      { role: 'user', text: 'ok' }
    ],
    userInput: 'đắt quá bạn ơi',
    expect: { max_price: null },
    why: 'follow.md ⚠️: KHÔNG lấy số quảng cáo 800K trong lịch sử làm giá khách muốn.'
  },
  {
    id: 'price-generic-inquiry',
    group: 'price',
    collected: { tire_size: '205/55R16' },
    history: [
      { role: 'bot', text: 'Dạ xe Kia Morning có kích cỡ sau: 165/65R14\n\nAnh/chị xác nhận có phù hợp không ạ? 😊' }
    ],
    userInput: 'Bao nhiêu một chiếc vậy',
    expect: { max_price: null, off_topic_kind: 'generic_price_inquiry', action: 'continue' },
    why: 'follow.md ⚠️: hỏi giá chung chung KHÔNG phải yêu cầu lọc giá.'
  },

  // ── BRAND ─────────────────────────────────────────────────────────────────
  {
    id: 'brand-alias-mit',
    group: 'brand',
    collected: EMPTY,
    userInput: 'Có lốp mít lắp cho xe 10 không bạn ơi?',
    expect: { selected_brands: ['MICHELIN'], car_model: /i\s*-?\s*10|grand\s*i10/i },
    why: 'Bug session a87ce436: "mít" = Michelin nhưng AI trả SAILUN; phải bắt CẢ brand + xe.'
  },
  {
    id: 'brand-two-aliases',
    group: 'brand',
    collected: { tire_size: '185/65R15' },
    userInput: 'mít, sai lun',
    expect: { selected_brands: ['MICHELIN', 'SAILUN'] },
    why: 'follow.md: 2 hãng cùng câu, từng bị bỏ sót 1.'
  },
  {
    id: 'brand-tier-all',
    group: 'brand',
    collected: { tire_size: '185/65R15' },
    history: [{ role: 'bot', text: 'Anh/chị ưu tiên thương hiệu hoặc tầm giá nào ạ?' }],
    userInput: 'Báo giá các loại',
    expect: { brand_tier: 'all', max_price: null },
    why: 'follow.md ⚠️: "các loại" = chọn xem hết, KHÔNG phải chỉ hỏi giá suông.'
  },
  {
    id: 'brand-best-quality',
    group: 'brand',
    collected: { tire_size: '185/65R15' },
    userInput: 'loại nào tốt nhất ấy bạn',
    expect: { wants_best_quality: true, selected_brands: null },
    why: '"tốt nhất" không kèm hãng → cascade phân khúc, không được tự chọn 1 hãng.'
  },
  {
    id: 'brand-budget-tier',
    group: 'brand',
    collected: { tire_size: '185/65R15' },
    userInput: 'loại nào rẻ rẻ thôi',
    expect: { brand_tier: 'budget', max_price: null },
    why: 'Mô tả định tính về giá → phân khúc tiết kiệm, KHÔNG phải max_price.'
  },

  // ── CAR MODEL ─────────────────────────────────────────────────────────────
  {
    id: 'car-vf6-with-brand',
    group: 'car',
    collected: EMPTY,
    userInput: 'michelin vf6',
    expect: { selected_brands: ['MICHELIN'], car_model: /vf\s*-?6/i },
    why: 'follow.md: phải trích CẢ brand lẫn xe, không bỏ sót xe.'
  },
  {
    id: 'car-morning-price',
    group: 'car',
    collected: EMPTY,
    userInput: 'kia morning giá bao tiền bạn',
    expect: { car_model: /morning/i },
    why: 'follow.md ⚠️: câu có tên xe → phải tra xe, không rơi vào generic_price_inquiry.'
  },
  {
    id: 'car-santafe-wheel',
    group: 'car',
    collected: EMPTY,
    userInput: 'lốp xe santafe vành 19',
    expect: { car_model: /santa\s*-?fe/i },
    why: 'Tên xe + cỡ vành trong 1 câu (luồng lọc size theo đường kính vành).'
  },

  // ── LOCATION (AI chỉ trích text, code phía sau mới resolve mã) ────────────
  {
    id: 'loc-hanoi',
    group: 'location',
    collected: { tire_size: '185/65R15', selected_brands: ['MICHELIN'] },
    history: [{ role: 'bot', text: 'Anh/chị ở KHU VỰC THUỘC TỈNH/THÀNH nào ạ?' }],
    userInput: 'Hà Nội',
    expect: { province_name: /hà\s*nội/i, action: 'fetch_results' },
    why: 'Đủ 3 trường → phải chuyển sang fetch_results.'
  },
  {
    id: 'loc-hadong-hanoi',
    group: 'location',
    collected: { tire_size: '185/65R15', selected_brands: ['MICHELIN'] },
    userInput: 'Hà đông - hanoi',
    expect: { province_name: /hà\s*(nội|đông)/i },
    why: 'Bug d9c1f4dc: từng bị hiểu thành "Đông Hà, Quảng Trị" (đảo âm tiết).'
  },
  {
    id: 'loc-hungyen-typo',
    group: 'location',
    collected: { tire_size: '185/65R15', selected_brands: ['MICHELIN'] },
    userInput: 'mình ở hùng yên',
    expect: { province_name: /h[ưu]ng\s*y[êe]n/i },
    why: 'follow.md: "hùng yên" từng bị AI ảo giác thành "Yên Bái".'
  },
  {
    id: 'loc-old-province',
    group: 'location',
    collected: { tire_size: '185/65R15', selected_brands: ['MICHELIN'] },
    userInput: 'Tiền hải thái bình cũ',
    expect: { province_name: /thái\s*bình|hưng\s*yên/i },
    why: 'Tỉnh cũ đã sáp nhập — alias code xử lý, AI chỉ cần trả đúng text khách nói.'
  },
  {
    id: 'loc-gibberish',
    group: 'location',
    collected: { tire_size: '185/65R15', selected_brands: ['MICHELIN'] },
    history: [{ role: 'bot', text: 'Anh/chị ở KHU VỰC THUỘC TỈNH/THÀNH nào ạ?' }],
    userInput: 'em o cho asdkjqwelkj khong biet ghi the nao',
    expect: { province_name: null },
    why: 'follow.md: câu không có địa danh — AI từng TỰ BỊA ra "Hà Nội".'
  },

  // ── OFF-TOPIC / FAQ ───────────────────────────────────────────────────────
  {
    id: 'faq-manufacture-year',
    group: 'offtopic',
    collected: AFTER_RESULTS,
    history: [{ role: 'bot', text: 'Dạ TROLYoto đã tìm được sản phẩm phù hợp 😊' }],
    userInput: 'lốp sản xuất năm nào vậy shop',
    expect: { off_topic_kind: 'manufacture_year', action: 'continue' },
    why: 'FAQ có câu trả lời cố định — không được đẩy CSKH.'
  },
  {
    id: 'faq-garage-contact',
    group: 'offtopic',
    collected: AFTER_RESULTS,
    history: [{ role: 'bot', text: 'Dạ TROLYoto đã tìm được sản phẩm phù hợp 😊' }],
    userInput: 'cho mình xin số điện thoại gara với',
    expect: { off_topic_kind: 'garage_contact', action: 'continue' },
    why: 'follow.md ⚠️: từng bị xếp nhầm vào "không có dữ liệu" → handoff CSKH oan.'
  },
  {
    id: 'faq-booking',
    group: 'offtopic',
    collected: AFTER_RESULTS,
    userInput: 'đặt lịch kiểu gì vậy bạn',
    expect: { off_topic_kind: 'booking_flow', action: 'continue' },
    why: 'FAQ quy trình đặt lịch có câu trả lời cố định.'
  },
  {
    id: 'offtopic-stock-question',
    group: 'offtopic',
    collected: AFTER_RESULTS,
    history: [{ role: 'bot', text: 'Dạ TROLYoto đã tìm được sản phẩm phù hợp 😊' }],
    userInput: 'gara đó còn hàng không bạn',
    expect: { action: 'handoff_cskh' },
    why: 'follow.md: hỏi tồn kho — bot KHÔNG có dữ liệu, phải chuyển CSKH, không tự chối.'
  },

  // ── ANTI-ECHO (nguồn của rất nhiều bug) ───────────────────────────────────
  {
    id: 'echo-thanks',
    group: 'echo',
    collected: { ...AFTER_RESULTS, max_price: 2000000 },
    history: [
      { role: 'bot', text: 'Dạ TROLYoto đã tìm được sản phẩm phù hợp 😊' },
      { role: 'user', text: 'ok' }
    ],
    userInput: 'Cảm ơn bạn nhé',
    expect: {
      tire_size: null,
      selected_brands: null,
      province_name: null,
      max_price: null
    },
    why: 'follow.md ⚠️: AI echo lại field cũ → code tưởng khách đổi yêu cầu, fetch lại/xoá giá oan.'
  },
  {
    id: 'echo-new-size-only',
    group: 'echo',
    collected: AFTER_RESULTS,
    history: [{ role: 'bot', text: 'Dạ TROLYoto đã tìm được sản phẩm phù hợp 😊' }],
    userInput: 'cho mình hỏi size 205/55R16 luôn',
    expect: { tire_size: '205/55R16', province_name: null },
    why: 'Đổi size thì CHỈ size được set; echo lại khu vực cũ là sai.'
  }
]
