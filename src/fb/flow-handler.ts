import { sendMessage, sendTypingOn, markSeen } from './client'
import {
  getActiveSession,
  getLatestSession,
  createSession,
  updateSession,
  completeSession,
  resetUserSessions,
  appendConversationLog,
  pauseSessionByCskh
} from './session'
// DB layer: chỉ import qua `./db` — KHÔNG import trực tiếp từ libs/chat trong FB bot
import {
  fetchSpGaraCards,
  resolveProvince,
  getMinPriceForTireSize,
  fetchTireSizesByCarTags,
  type SpGaraCard
} from './db'
import type {
  MessengerEvent,
  SessionState,
  QuickReply,
  GenericElement,
  Button,
  FbSession,
  LoggedCard,
  MessengerStep
} from './types'
import {
  classifyTireInput,
  extractBrandNeed,
  getTireSizesForCar,
  getCarNameVariants,
  matchOption,
  type AiOptionDef
} from './ai-helper'
import { scheduleTimer, cancelTimer } from './timers'

const PAGE_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN!
const TROLYOTO_URL = 'https://trolyoto.com'
const COMMUNITY_URL = 'https://www.facebook.com/groups/748788784953241'

// ── Timers V2 (xem facebook-chat-bot-v2.md §7) ─────────────────────────────
const NUDGE_HELP_MS = 15_000 // 15s im lặng sau khi show SP+gara → gửi prompt "cần hỗ trợ thêm gì" + booking QRs
const NUDGE_BOOKING_MS = 45_000 // 45s im lặng sau prompt → coi như "Còn băn khoăn"

// ── Brand tiers V2 (danh sách brand mở rộng — xem facebook-chat-bot-v2.md §4.7) ─
const BRAND_TIERS = {
  premium: {
    label: 'Chất lượng nhất',
    brands: [
      'MICHELIN',
      'BRIDGESTONE',
      'PIRELLI',
      'CONTINENTAL',
      'TOYO',
      'GOODYEAR'
    ] as string[]
  },
  balanced: {
    label: 'Giá & chất lượng',
    brands: ['HANKOOK', 'YOKOHAMA', 'DUNLOP', 'LAUFENN'] as string[]
  },
  budget: {
    label: 'Tiết kiệm nhất',
    brands: ['KUMHO', 'ROADX', 'SAILUN', 'TBB', 'OTANI'] as string[]
  },
  all: { label: 'Xem tất cả', brands: [] as string[] }
} as const

const ALL_KNOWN_BRANDS = Array.from(
  new Set([
    ...BRAND_TIERS.premium.brands,
    ...BRAND_TIERS.balanced.brands,
    ...BRAND_TIERS.budget.brands
  ])
)

// Kích cỡ phổ biến — hiển thị khi bot hoàn toàn không có manh mối (V2 §4.1)
const POPULAR_SIZES = ['185/60R15', '205/55R16', '205/55R17', '235/55R19']

// ── Quick Reply titles (≤20 ký tự — xem facebook-chat-bot-limitations.md §2) ──
const QR_TITLE = {
  AI_CONSULT: '🤖 Báo giá ngay',
  CSKH_CONSULT: '👤 Tư vấn kĩ',
  AI_CONSULT_LATE: '🤖 Báo giá ngay',
  WAIT_CSKH: '💬 Chờ tư vấn',
  SIZE_NOT_RIGHT: '❌ Không đúng',
  BRAND_PREMIUM: 'Chất lượng nhất',
  BRAND_BALANCED: 'Giá & chất lượng',
  BRAND_BUDGET: 'Tiết kiệm nhất',
  BRAND_ALL: 'Xem tất cả',
  BOOK_DONE: '✅ Đã đặt lịch',
  NOT_YET: '🕐 Chưa cần thay',
  CONCERN: '🤔 Còn băn khoăn',
  BETTER_PRICE: '💰 Giá tốt hơn',
  CLOSER_DEALER: '📍 Đại lý gần hơn',
  CSKH_HERE: '💬 Chờ ở đây',
  LEAVE_PHONE: '📞 Để lại SĐT',
  // web_url button titles
  VIEW_PROMO: '🎁 Xem khuyến mại',
  VIEW_OTHER_GARAGE: 'Xem gara khác',
  VIEW_OTHER_PRODUCT: 'Xem SP khác',
  COMMUNITY_SUBSIDY: 'Trợ giá khi cần',
  COMMUNITY_VOUCHER: 'Nhận voucher 200k'
} as const

// ── Helpers cơ bản ─────────────────────────────────────────────────────────

function normVn(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isWorkingHours(): boolean {
  const vnTime = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' })
  )
  const day = vnTime.getDay()
  const hour = vnTime.getHours()
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('vi-VN').format(amount) + 'đ'
}

function qr(title: string, payload: string): QuickReply {
  return { content_type: 'text', title, payload }
}

/** Bóc số điện thoại VN từ free text. Trả null nếu không hợp lệ. */
function extractPhone(text: string): string | null {
  const digits = text.replace(/[^\d+]/g, '')
  const m = digits.match(/(?:\+?84|0)\d{8,10}/)
  return m ? m[0] : null
}

/** Gửi text/quick-reply từ bot + log conversation_log. */
async function reply(
  psid: string,
  sessionId: string,
  text: string,
  quickReplies?: QuickReply[]
): Promise<void> {
  sendTypingOn(psid, PAGE_TOKEN).catch(e => console.error('[FB typing]', e))
  await sendMessage(psid, { text, quick_replies: quickReplies }, PAGE_TOKEN)

  appendConversationLog(sessionId, {
    role: 'bot',
    type: quickReplies && quickReplies.length > 0 ? 'quick_replies' : 'text',
    text,
    ts: new Date().toISOString(),
    quick_replies: quickReplies?.map(q => ({
      title: q.title,
      payload: q.payload
    }))
  }).catch(e => console.error('[FB log bot]', e))
}

/** Gửi Button Template (text + 1-3 button web_url/postback) + log. */
async function sendButtonTemplate(
  psid: string,
  sessionId: string,
  text: string,
  buttons: Button[],
  context?: string
): Promise<void> {
  sendTypingOn(psid, PAGE_TOKEN).catch(e => console.error('[FB typing]', e))
  await sendMessage(
    psid,
    {
      attachment: {
        type: 'template',
        payload: { template_type: 'button', text, buttons }
      }
    },
    PAGE_TOKEN
  )

  appendConversationLog(sessionId, {
    role: 'bot',
    type: 'quick_replies',
    text: context ? `${context}: ${text}` : text,
    ts: new Date().toISOString(),
    quick_replies: buttons.map(b => ({
      title: b.title,
      payload: b.payload ?? b.url ?? ''
    }))
  }).catch(e => console.error('[FB log button]', e))
}

/** Gửi Generic Template (cards) + log kèm metadata. */
async function sendCards(
  psid: string,
  sessionId: string,
  elements: GenericElement[],
  context: string
): Promise<void> {
  await sendMessage(
    psid,
    {
      attachment: {
        type: 'template',
        payload: { template_type: 'generic', elements }
      }
    },
    PAGE_TOKEN
  )

  const cards: LoggedCard[] = elements.map(el => ({
    title: el.title,
    subtitle: el.subtitle,
    image_url: el.image_url,
    url: el.default_action?.url,
    buttons: el.buttons?.map(b => ({
      title: b.title,
      url: b.url,
      payload: b.payload
    }))
  }))

  appendConversationLog(sessionId, {
    role: 'bot',
    type: 'cards',
    text: context,
    ts: new Date().toISOString(),
    cards
  }).catch(e => console.error('[FB log cards]', e))
}

/**
 * 1 card SP+gara (Generic Template) — 3 button theo PDF V2:
 *   1. 🎁 Xem khuyến mại  → trang chi tiết SP của GARA (detailUrl)
 *   2. Xem gara khác       → trang chi tiết SP chung (/lop/{slug})
 *   3. Xem SP khác         → trang lốp filter theo size
 */
function buildSpGaraCard(card: SpGaraCard): GenericElement {
  const productPageUrl = card.productSlug
    ? `${TROLYOTO_URL}/lop/${card.productSlug}`
    : undefined
  const listingUrl = `${TROLYOTO_URL}/lop?size=${encodeURIComponent(card.size)}`
  const subtitle = [
    `🏪 ${card.garageName}`,
    `💰 ${formatCurrency(card.finalPrice)}/lốp`,
    card.garageAddress ? `📍 ${card.garageAddress}` : null
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 80)

  const buttons: Button[] = [
    { type: 'web_url', title: QR_TITLE.VIEW_PROMO, url: card.detailUrl }
  ]
  if (productPageUrl) {
    buttons.push({
      type: 'web_url',
      title: QR_TITLE.VIEW_OTHER_GARAGE,
      url: productPageUrl
    })
  }
  buttons.push({
    type: 'web_url',
    title: QR_TITLE.VIEW_OTHER_PRODUCT,
    url: listingUrl
  })

  return {
    title: `${card.brand} ${card.size}`,
    subtitle,
    ...(card.image ? { image_url: card.image } : {}),
    default_action: { type: 'web_url' as const, url: card.detailUrl },
    buttons
  }
}

function brandFilterFromState(state: SessionState): string {
  if (state.selected_brands && state.selected_brands.length > 0) {
    return state.selected_brands.join('|')
  }
  return '__skip_brand__'
}

// ── 3-strikes (safety net — giữ song song với handoff CSKH, xem v2 §12 q6) ──
const MAX_FAILED_ATTEMPTS = 3

// ════════════════════════════════════════════════════════════════════════════
//  STEP 1 — Chào mừng
// ════════════════════════════════════════════════════════════════════════════

async function sendWelcome(psid: string, sessionId: string): Promise<void> {
  await reply(
    psid,
    sessionId,
    '🤝 TRỢ LÝ Ô TÔ – nền tảng kết nối DV ô tô tiện lợi, uy tín – rất vui được hỗ trợ anh/chị 😊\n\nVui lòng chọn nhu cầu dưới đây:\n• Báo giá ngay → trợ lý ảo báo giá tức thì\n• Tư vấn kĩ → chuyên viên TROLYoto (9h-18h, T2-T6)',
    [
      qr(QR_TITLE.AI_CONSULT, 'QR_AI_CONSULT'),
      qr(QR_TITLE.CSKH_CONSULT, 'QR_CSKH_CONSULT')
    ]
  )
  await updateSession(sessionId, {
    step: 'AWAITING_CONSULT_TYPE',
    state: { failed_attempts: 0 }
  })
}

// ── Step 2: Chọn loại tư vấn ─────────────────────────────────────────────

async function handleConsultChoice(
  psid: string,
  sessionId: string,
  payload: string,
  state: SessionState
): Promise<void> {
  if (payload === 'QR_AI_CONSULT' || payload === 'QR_AI_CONSULT_LATE') {
    await updateSession(sessionId, {
      step: 'AWAITING_TIRE_SIZE',
      state: { ...state, consult_type: 'AI' }
    })
    await askTireSize(psid, sessionId)
    return
  }

  if (payload === 'QR_CSKH_CONSULT') {
    await updateSession(sessionId, {
      step: 'AWAITING_AREA_FOR_CSKH',
      state: { ...state, consult_type: 'CSKH' }
    })
    await reply(
      psid,
      sessionId,
      'Anh chị ở khu vực nào để TROLY tìm kiếm đại lý giá tốt gần mình ạ? 😊'
    )
    return
  }

  if (payload === 'QR_WAIT_CSKH') {
    await reply(
      psid,
      sessionId,
      'TROLYoto đã ghi nhận ạ 🙏\n\nĐội ngũ chuyên viên sẽ hỗ trợ mình ngay vào buổi làm việc kế tiếp 😊\n\n⏰ Giờ làm việc: 9h - 18h, Thứ 2 - Thứ 6'
    )
    await completeSession(sessionId)
  }
}

// ── Nhánh CSKH (Tư vấn kĩ) ────────────────────────────────────────────────

async function handleAreaForCskh(
  psid: string,
  sessionId: string,
  text: string,
  state: SessionState
): Promise<void> {
  const newState: SessionState = { ...state, area: text }

  if (isWorkingHours()) {
    // V2: trong giờ → hỏi thêm kích cỡ trước khi handoff
    await updateSession(sessionId, {
      step: 'AWAITING_SIZE_FOR_CSKH',
      state: newState
    })
    await reply(
      psid,
      sessionId,
      'Anh chị cần tìm lốp kích cỡ như thế nào ạ? 😊'
    )
  } else {
    await updateSession(sessionId, {
      step: 'AWAITING_CONSULT_TYPE',
      state: newState
    })
    await reply(
      psid,
      sessionId,
      'Hiện đang ngoài giờ làm việc, TROLYoto sẽ hỗ trợ mình ngay vào buổi làm việc kế tiếp 😊\n\nHoặc để tránh mất thời gian, anh chị muốn:',
      [
        qr(QR_TITLE.AI_CONSULT_LATE, 'QR_AI_CONSULT_LATE'),
        qr(QR_TITLE.WAIT_CSKH, 'QR_WAIT_CSKH')
      ]
    )
  }
}

async function handleSizeForCskh(
  psid: string,
  sessionId: string,
  text: string,
  state: SessionState
): Promise<void> {
  await updateSession(sessionId, {
    step: 'COMPLETED',
    state: { ...state, tire_size: text },
    is_active: false
  })
  await reply(
    psid,
    sessionId,
    'TROLY đã nhận thông tin & sẽ hỗ trợ anh chị sớm nhất ạ 😊'
  )
}

// ════════════════════════════════════════════════════════════════════════════
//  NHÁNH TRỢ LÝ ẢO — Kích cỡ lốp (AI-first, V2)
// ════════════════════════════════════════════════════════════════════════════

async function askTireSize(psid: string, sessionId: string): Promise<void> {
  await reply(
    psid,
    sessionId,
    'Anh chị cần tìm lốp kích cỡ nào ạ? 😊\n\nVui lòng nhập định dạng chuẩn để TROLYoto báo giá chính xác ạ.\nVí dụ: 185/60R15'
  )
}

/**
 * Tra kích cỡ lốp theo tên xe — merge DB exact tags (ưu tiên) + AI OEM sizes.
 * (Giữ pipeline cũ, tách ra để tái dùng.) Trả tối đa 4 size.
 */
async function lookupCarSizes(carModel: string): Promise<string[]> {
  let dbSizes: string[] = []
  let aiSizes: string[] = []
  try {
    const [variants, aiResult] = await Promise.all([
      getCarNameVariants(carModel),
      getTireSizesForCar(carModel)
    ])
    aiSizes = aiResult
    if (variants.exact.length > 0) {
      const r = await fetchTireSizesByCarTags(variants.exact)
      if (r.sizes.length > 0) dbSizes = r.sizes.map(s => s.size)
    }
  } catch (e) {
    console.error('[FB flow] lookupCarSizes:', e)
  }
  // Merge: DB sizes ưu tiên đầu, AI sizes append. Dedupe case-insensitive + cap 4.
  const seen = new Set<string>()
  const sizes: string[] = []
  for (const s of [...dbSizes, ...aiSizes]) {
    if (!s) continue
    const key = s.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    sizes.push(key)
    if (sizes.length >= 4) break
  }
  return sizes
}

/**
 * Core V2: xử lý free-text khách nhập ở bước kích cỡ.
 * Regex → AI classify → 3 nhánh (size / car / unknown).
 */
async function handleTireInput(
  psid: string,
  sessionId: string,
  pageId: string,
  text: string,
  state: SessionState
): Promise<void> {
  // 1. Regex kích cỡ chuẩn — nhanh, miễn phí
  const sizeMatch = text.match(/\d{3}\/\d{2}[Rr]\d{2}/)
  if (sizeMatch) {
    await resetStrikes(sessionId, state)
    await announceBasicPrice(psid, sessionId, sizeMatch[0].toUpperCase(), state)
    return
  }

  // 2. AI phân loại size vs car vs unknown
  const cls = await classifyTireInput(text)

  if (cls.kind === 'size' && cls.size && cls.confidence >= 0.7) {
    await resetStrikes(sessionId, state)
    await announceBasicPrice(psid, sessionId, cls.size, state)
    return
  }

  if (cls.kind === 'car' && cls.carModel) {
    const sizes = await lookupCarSizes(cls.carModel)
    if (sizes.length > 0) {
      await resetStrikes(sessionId, state)
      await showSizeSuggestions(
        psid,
        sessionId,
        sizes,
        `Tùy phiên bản và đời xe ${cls.carModel}, có một số kích cỡ lốp có thể phù hợp.\n\nAnh/chị xác nhận để TROLYoto báo giá chuẩn nhé 😊`,
        { ...state, car_model: cls.carModel }
      )
      return
    }
    // Không tra được size theo xe → fallback gợi ý kích cỡ phổ biến
    await fallbackSizeSuggestion(psid, sessionId, pageId, {
      ...state,
      car_model: cls.carModel
    })
    return
  }

  // 3. kind=size nhưng confidence thấp → gợi ý kèm size đoán được + phổ biến
  if (cls.kind === 'size' && cls.size) {
    const sizes = Array.from(new Set([cls.size, ...POPULAR_SIZES])).slice(0, 5)
    await showSizeSuggestions(
      psid,
      sessionId,
      sizes,
      'Có thể thông tin cung cấp có lỗi chính tả 😅\n\nAnh chị vui lòng lựa chọn theo gợi ý dưới đây để TROLYoto báo giá chính xác ạ 😊',
      state
    )
    return
  }

  // 4. unknown / không manh mối → kích cỡ phổ biến + ❌ Không đúng (kèm strike)
  await fallbackSizeSuggestion(psid, sessionId, pageId, state)
}

/** Hiển thị danh sách kích cỡ để khách chọn + nút "❌ Không đúng" → CSKH. */
async function showSizeSuggestions(
  psid: string,
  sessionId: string,
  sizes: string[],
  introText: string,
  state: SessionState
): Promise<void> {
  // Dedupe (case-insensitive) + cap 11 (chừa chỗ cho "❌ Không đúng" — FB max 13 QR)
  const seen = new Set<string>()
  const capped: string[] = []
  for (const s of sizes) {
    const key = s.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    capped.push(s.toUpperCase())
    if (capped.length >= 11) break
  }
  await updateSession(sessionId, {
    step: 'AWAITING_SIZE_CONFIRM',
    state: { ...state, size_suggestions: capped }
  })
  await reply(psid, sessionId, introText, [
    ...capped.map(s => qr(s, `TIRE_SIZE:${s}`)),
    qr(QR_TITLE.SIZE_NOT_RIGHT, 'QR_SIZE_NOT_RIGHT')
  ])
}

/** Bot hoàn toàn không manh mối → kích cỡ phổ biến; đếm strike, đủ 3 → CSKH. */
async function fallbackSizeSuggestion(
  psid: string,
  sessionId: string,
  pageId: string,
  state: SessionState
): Promise<void> {
  const failed = (state.failed_attempts ?? 0) + 1
  if (failed >= MAX_FAILED_ATTEMPTS) {
    await cskhHandoff(
      psid,
      sessionId,
      { ...state, failed_attempts: 0 },
      'Bot không nhận dạng được kích cỡ/xe sau nhiều lần thử'
    )
    return
  }
  await updateSession(sessionId, {
    step: 'AWAITING_SIZE_CONFIRM',
    state: {
      ...state,
      failed_attempts: failed,
      size_suggestions: POPULAR_SIZES
    }
  })
  await reply(
    psid,
    sessionId,
    'TROLY chưa nhận dạng được thông tin ạ 😅\n\nAnh/chị chọn 1 kích cỡ phổ biến dưới đây 👇\n\nHoặc bấm "❌ Không đúng" để chuyên viên hỗ trợ nhé 😊',
    [
      ...POPULAR_SIZES.map(s => qr(s, `TIRE_SIZE:${s}`)),
      qr(QR_TITLE.SIZE_NOT_RIGHT, 'QR_SIZE_NOT_RIGHT')
    ]
  )
}

/** Chuyển CSKH (V2 `cskh_ho_tro`) — cho chọn "Chờ ở đây" / "Để lại SĐT". */
async function cskhHandoff(
  psid: string,
  sessionId: string,
  state: SessionState,
  reason: string
): Promise<void> {
  await updateSession(sessionId, {
    step: 'AWAITING_CSKH_CHANNEL',
    state: { ...state, cskh_reason: reason }
  })
  await reply(
    psid,
    sessionId,
    'Thông tin của anh chị cần được tư vấn kỹ hơn để báo giá đúng nhất 🙏\n\nChăm sóc KH sẽ phản hồi trong giờ làm việc (9h–18h, T2–T6).\n\nAnh chị muốn chờ tại đây hay nhận tư vấn qua điện thoại?',
    [
      qr(QR_TITLE.CSKH_HERE, 'QR_CSKH_HERE'),
      qr(QR_TITLE.LEAVE_PHONE, 'QR_LEAVE_PHONE')
    ]
  )
}

/** Khách chọn kênh CSKH: chờ tại chat hoặc để lại SĐT. */
async function handleCskhChannel(
  psid: string,
  sessionId: string,
  payload: string,
  state: SessionState
): Promise<void> {
  if (payload === 'QR_CSKH_HERE') {
    await Promise.all([
      reply(
        psid,
        sessionId,
        'TROLY đã ghi nhận ạ 🙏\n\nĐội ngũ chuyên viên TROLYoto sẽ liên hệ anh/chị trong giờ làm việc sớm nhất 😊\n\n⏰ Giờ làm việc: 9h - 18h, Thứ 2 - Thứ 6'
      ),
      completeSession(sessionId)
    ])
    return
  }
  if (payload === 'QR_LEAVE_PHONE') {
    await Promise.all([
      updateSession(sessionId, { step: 'AWAITING_PHONE', state }),
      reply(
        psid,
        sessionId,
        'Anh chị nhắn số điện thoại, TROLYoto sẽ liên hệ sớm nhất ạ!'
      )
    ])
  }
}

async function handlePhoneInput(
  psid: string,
  sessionId: string,
  text: string,
  state: SessionState
): Promise<void> {
  const phone = extractPhone(text)
  if (!phone) {
    await reply(
      psid,
      sessionId,
      'Số điện thoại chưa hợp lệ ạ 😅\n\nAnh/chị nhập lại giúp em nhé.\nVí dụ: 0901234567'
    )
    return
  }
  await updateSession(sessionId, {
    step: 'COMPLETED',
    state: { ...state, phone },
    is_active: false
  })
  await reply(
    psid,
    sessionId,
    `TROLYoto đã nhận số ${phone} 🙏\n\nChuyên viên sẽ liên hệ anh/chị trong giờ làm việc sớm nhất ạ 😊\n\n⏰ Giờ làm việc: 9h - 18h, Thứ 2 - Thứ 6`
  )
}

// ════════════════════════════════════════════════════════════════════════════
//  Báo giá chuẩn + Thương hiệu (AI-first, V2)
// ════════════════════════════════════════════════════════════════════════════

async function announceBasicPrice(
  psid: string,
  sessionId: string,
  tireSize: string,
  state: SessionState
): Promise<void> {
  let minPrice: number | null = null
  try {
    minPrice = await getMinPriceForTireSize(tireSize)
  } catch (e) {
    console.error('[FB flow] getMinPriceForTireSize:', e)
  }

  const priceText =
    minPrice && minPrice > 0
      ? `Dạ lốp ${tireSize} giá từ ${formatCurrency(minPrice)}/lốp.\nGiá tùy THƯƠNG HIỆU LỐP và GARA ạ.\n\nGiá gồm TRỢ GIÁ ĐỘC QUYỀN từ TROLYoto dành riêng cho khách đặt lịch qua nền tảng 😊`
      : `Dạ TROLYoto có nhiều sản phẩm lốp ${tireSize} với giá tốt từ nhiều thương hiệu ạ 😊`

  await updateSession(sessionId, {
    step: 'AWAITING_BRAND',
    state: { ...state, tire_size: tireSize, min_price: minPrice ?? undefined }
  })

  await reply(psid, sessionId, priceText)
  // V2: hỏi nhu cầu thương hiệu dạng FREE TEXT (AI trích) — không ép button
  await reply(
    psid,
    sessionId,
    'Anh chị muốn tìm lốp có tầm GIÁ hoặc THƯƠNG HIỆU như thế nào ạ?\n\nEm hỏi để hỗ trợ tìm giúp mình sản phẩm ưng ý ạ 👍'
  )
}

/** V2: khách gõ tự do nhu cầu thương hiệu → AI trích; không hiểu → fallback 3 tier. */
async function handleBrandInput(
  psid: string,
  sessionId: string,
  text: string,
  state: SessionState
): Promise<void> {
  const need = await extractBrandNeed(text, ALL_KNOWN_BRANDS)

  if (need.understood) {
    await resetStrikes(sessionId, state)
    let tier: keyof typeof BRAND_TIERS = 'all'
    let brands: string[] = []
    if (need.brands.length > 0) {
      brands = need.brands
    } else if (need.tier) {
      tier = need.tier
      brands = [...BRAND_TIERS[need.tier].brands]
    }
    await askLocation(psid, sessionId, {
      ...state,
      brand_tier: tier,
      selected_brands: brands
    })
    return
  }

  // Không hiểu → xác nhận tiêu chí qua 3 tier (V2 `xac_nhan_tieu_chi`)
  await updateSession(sessionId, { step: 'AWAITING_BRAND_CONFIRM', state })
  await reply(
    psid,
    sessionId,
    'Có thể có lỗi chính tả 😅\n\nTROLYoto xác nhận lại anh chị đang muốn tìm lốp tiêu chí nào ạ? 😊',
    [
      qr(QR_TITLE.BRAND_PREMIUM, 'QR_BRAND_PREMIUM'),
      qr(QR_TITLE.BRAND_BALANCED, 'QR_BRAND_BALANCED'),
      qr(QR_TITLE.BRAND_BUDGET, 'QR_BRAND_BUDGET'),
      qr(QR_TITLE.BRAND_ALL, 'QR_BRAND_ALL')
    ]
  )
}

async function handleBrandConfirm(
  psid: string,
  sessionId: string,
  payload: string,
  state: SessionState
): Promise<void> {
  const tierMap: Record<string, keyof typeof BRAND_TIERS> = {
    QR_BRAND_PREMIUM: 'premium',
    QR_BRAND_BALANCED: 'balanced',
    QR_BRAND_BUDGET: 'budget',
    QR_BRAND_ALL: 'all'
  }
  const tier = tierMap[payload] ?? 'all'
  const brands = [...BRAND_TIERS[tier].brands]
  await resetStrikes(sessionId, state)
  await askLocation(psid, sessionId, {
    ...state,
    brand_tier: tier,
    selected_brands: brands
  })
}

// ════════════════════════════════════════════════════════════════════════════
//  V2: brand → location → SP+gara card (1 lần show, không có national trước)
// ════════════════════════════════════════════════════════════════════════════

async function askLocation(
  psid: string,
  sessionId: string,
  state: SessionState
): Promise<void> {
  await updateSession(sessionId, { step: 'AWAITING_LOCATION', state })
  await reply(
    psid,
    sessionId,
    'Dạ TROLYoto đã hiểu nhu cầu của mình rồi ạ 😊\n\nAnh chị ở khu vực xã/phường, tỉnh thành nào để TROLY tìm đại lý giá tốt gần mình ạ?'
  )
}

async function handleLocationInput(
  psid: string,
  sessionId: string,
  pageId: string,
  text: string,
  state: SessionState
): Promise<void> {
  const { code: provinceCode, name: provinceName } = await resolveProvince(text)
  const newState: SessionState = {
    ...state,
    province_code: provinceCode,
    province_name: provinceName ?? text
  }
  await showSpGaraResults(
    psid,
    sessionId,
    pageId,
    provinceCode,
    provinceName ?? text,
    newState
  )
}

/**
 * V2 core: query SP+gara theo size + brand + province, hiển thị tối đa 3 card.
 *
 * Fallback: nếu province không có gara → thử lại toàn quốc (gara hỗ trợ ship).
 * Nếu vẫn rỗng → CSKH handoff.
 */
async function showSpGaraResults(
  psid: string,
  sessionId: string,
  pageId: string,
  provinceCode: string | null,
  provinceName: string,
  state: SessionState
): Promise<void> {
  const tireSize = state.tire_size ?? ''
  if (!tireSize) {
    await reply(
      psid,
      sessionId,
      'Thiếu thông tin kích cỡ lốp, vui lòng bắt đầu lại 😊'
    )
    return
  }
  const brandFilter = brandFilterFromState(state)

  try {
    // 1. Thử theo tỉnh
    let cards = await fetchSpGaraCards({
      tireSize,
      tireBrand: brandFilter,
      provinceCode,
      limit: 3,
      sortBy: 'quantitysold'
    })
    let usedNational = false

    // 2. Fallback toàn quốc (gara hỗ trợ ship)
    if (cards.length === 0 && provinceCode) {
      cards = await fetchSpGaraCards({
        tireSize,
        tireBrand: brandFilter,
        provinceCode: null,
        limit: 3,
        sortBy: 'quantitysold'
      })
      usedNational = true
    }

    // 3. Hết hẳn → CSKH handoff
    if (cards.length === 0) {
      await updateSession(sessionId, {
        step: 'AWAITING_CSKH_CHANNEL',
        state: {
          ...state,
          cskh_reason: `Không có SP+gara cho size ${tireSize} ở ${provinceName}`
        }
      })
      await reply(
        psid,
        sessionId,
        `Hiện TROLYoto chưa có sản phẩm phù hợp ở ${provinceName} ạ 😅\n\nĐể chuyên viên hỗ trợ anh/chị nhé 😊`,
        [
          qr(QR_TITLE.CSKH_HERE, 'QR_CSKH_HERE'),
          qr(QR_TITLE.LEAVE_PHONE, 'QR_LEAVE_PHONE')
        ]
      )
      return
    }

    const intro = usedNational
      ? `Dạ TROLYoto đã tìm được sản phẩm phù hợp (gara hỗ trợ ship đến ${provinceName}) ạ 😊`
      : `Dạ TROLYoto đã tìm được sản phẩm phù hợp ở ${provinceName} - gara hỗ trợ ship ạ 😊`
    await reply(psid, sessionId, intro)
    await sendCards(
      psid,
      sessionId,
      cards.map(buildSpGaraCard),
      `${cards.length} SP+gara ở ${provinceName}${usedNational ? ' (toàn quốc)' : ''}`
    )

    const shownCodes = cards
      .map(c => c.garageCode)
      .filter((c): c is string => !!c)
    const minPrice = Math.min(...cards.map(c => c.finalPrice))

    // V2: sau khi show cards → KHÔNG gửi booking QR ngay. Đợi 15s im lặng rồi
    // mới gửi prompt "Anh chị cần TROLYoto hỗ trợ thêm gì..." kèm booking QRs.
    await updateSession(sessionId, {
      step: 'SHOWING_RESULTS_LOCAL',
      is_active: true,
      state: {
        ...state,
        shown_garage_codes: shownCodes,
        shown_garage_min_price: minPrice,
        shown_national: usedNational
      }
    })

    scheduleTimer(
      sessionId,
      NUDGE_HELP_MS,
      () => promptHelpAndBooking(psid, sessionId, pageId),
      'help-15s'
    )
  } catch (err) {
    console.error('[FB flow] showSpGaraResults:', err)
    await reply(
      psid,
      sessionId,
      'Xin lỗi, có lỗi khi tìm sản phẩm/đại lý. Vui lòng thử lại sau ạ 😊'
    )
  }
}

/**
 * V2: gửi prompt "Anh chị cần TROLYoto hỗ trợ thêm gì..." + 3 booking QRs.
 * Lên lịch tiếp 45s timer → tự nhảy sang "Còn băn khoăn" nếu khách im lặng.
 *
 * Gọi từ 2 nguồn:
 *  1. Timer 15s sau khi show SP+gara (nudge mặc định)
 *  2. Khách chủ động gõ text ở step SHOWING_RESULTS_LOCAL (không đợi 15s)
 */
async function promptHelpAndBooking(
  psid: string,
  sessionId: string,
  pageId: string
): Promise<void> {
  const sess = await getLatestSession(psid, pageId)
  if (!sess || sess.id !== sessionId) {
    console.log(
      `[FB nudge] help-15s SKIP session=${sessionId} reason=no-matching-session`
    )
    return
  }
  if (!sess.is_active || sess.is_paused_by_cskh) {
    console.log(
      `[FB nudge] help-15s SKIP session=${sessionId} reason=inactive-or-paused (active=${sess.is_active}, paused=${sess.is_paused_by_cskh})`
    )
    return
  }
  if (sess.step !== 'SHOWING_RESULTS_LOCAL') {
    console.log(
      `[FB nudge] help-15s SKIP session=${sessionId} reason=step-changed step=${sess.step}`
    )
    return
  }

  console.log(`[FB nudge] help-15s SEND session=${sessionId}`)
  await updateSession(sessionId, { step: 'AWAITING_BOOKING_STATE' })
  await reply(
    psid,
    sessionId,
    'Anh chị cần TROLYoto hỗ trợ thêm gì để chọn lốp ưng ý không ạ 😊',
    [
      qr(QR_TITLE.BOOK_DONE, 'QR_BOOK_DONE'),
      qr(QR_TITLE.NOT_YET, 'QR_NOT_YET'),
      qr(QR_TITLE.CONCERN, 'QR_CONCERN')
    ]
  )

  // Timer 45s im lặng sau prompt → coi như "Còn băn khoăn"
  scheduleTimer(
    sessionId,
    NUDGE_BOOKING_MS,
    () => nudgeBookingToConcern(psid, sessionId, pageId),
    'concern-45s'
  )
}

/** Timer 45s: khách im lặng ở booking state → coi như "Còn băn khoăn". */
async function nudgeBookingToConcern(
  psid: string,
  sessionId: string,
  pageId: string
): Promise<void> {
  const sess = await getLatestSession(psid, pageId)
  if (!sess || sess.id !== sessionId) {
    console.log(
      `[FB nudge] concern-45s SKIP session=${sessionId} reason=no-matching-session`
    )
    return
  }
  if (!sess.is_active || sess.is_paused_by_cskh) {
    console.log(
      `[FB nudge] concern-45s SKIP session=${sessionId} reason=inactive-or-paused (active=${sess.is_active}, paused=${sess.is_paused_by_cskh})`
    )
    return
  }
  if (sess.step !== 'AWAITING_BOOKING_STATE') {
    console.log(
      `[FB nudge] concern-45s SKIP session=${sessionId} reason=step-changed step=${sess.step}`
    )
    return
  }
  console.log(`[FB nudge] concern-45s SEND session=${sessionId}`)
  await promptConcern(psid, sessionId, sess.state)
}

// ── Booking state / Concern ────────────────────────────────────────────────

async function handleBookingState(
  psid: string,
  sessionId: string,
  payload: string,
  state: SessionState
): Promise<void> {
  console.log(
    `[FB handler] handleBookingState ENTER session=${sessionId} payload=${payload}`
  )
  if (payload === 'QR_BOOK_DONE') {
    await Promise.all([
      sendButtonTemplate(
        psid,
        sessionId,
        'Cảm ơn anh chị đã tin tưởng TROLYoto! 🙏\n\nGara sẽ chủ động liên hệ để xác nhận lịch ạ 😊\n\nTham gia Cộng đồng CHĂM XE KHÔNG HỚ để chủ động các khuyến mại tốt nhất trong ngành DV ô tô khi cần ạ 😊',
        [
          {
            type: 'web_url',
            title: QR_TITLE.COMMUNITY_SUBSIDY,
            url: COMMUNITY_URL
          }
        ],
        'Đã đặt lịch'
      ),
      completeSession(sessionId)
    ])
    return
  }
  if (payload === 'QR_NOT_YET') {
    await Promise.all([
      sendButtonTemplate(
        psid,
        sessionId,
        'TROLYoto đã hiểu nhu cầu của anh chị rồi ạ 😊\n\nTham gia Cộng đồng CHĂM XE KHÔNG HỚ - nơi chia sẻ các khuyến mại tốt nhất trong ngành DV ô tô để có sẵn trợ giá khi cần ạ 😊',
        [
          {
            type: 'web_url',
            title: QR_TITLE.COMMUNITY_SUBSIDY,
            url: COMMUNITY_URL
          }
        ],
        'Chưa cần thay'
      ),
      completeSession(sessionId)
    ])
    return
  }
  if (payload === 'QR_CONCERN') {
    await promptConcern(psid, sessionId, state)
  }
}

async function promptConcern(
  psid: string,
  sessionId: string,
  state: SessionState
): Promise<void> {
  console.log(`[FB handler] promptConcern session=${sessionId}`)
  // Parallel: update DB + send reply đồng thời để giảm latency (~150ms)
  await Promise.all([
    updateSession(sessionId, { step: 'AWAITING_CONCERN', state }),
    reply(psid, sessionId, 'Anh chị còn băn khoăn điều gì ạ 😊', [
      qr(QR_TITLE.BETTER_PRICE, 'QR_BETTER_PRICE'),
      qr(QR_TITLE.CLOSER_DEALER, 'QR_CLOSER_DEALER')
    ])
  ])
}

async function handleConcern(
  psid: string,
  sessionId: string,
  payload: string,
  state: SessionState
): Promise<void> {
  console.log(
    `[FB handler] handleConcern ENTER session=${sessionId} payload=${payload}`
  )
  if (payload === 'QR_BETTER_PRICE') {
    await Promise.all([
      sendButtonTemplate(
        psid,
        sessionId,
        'TROLYoto đã hiểu nhu cầu của anh chị rồi ạ 😊\n\nTham gia Cộng đồng CHĂM XE KHÔNG HỚ - để nhận thêm voucher giảm giá tới 200k ạ 😊',
        [
          {
            type: 'web_url',
            title: QR_TITLE.COMMUNITY_VOUCHER,
            url: COMMUNITY_URL
          }
        ],
        'Giá tốt hơn'
      ),
      completeSession(sessionId)
    ])
    return
  }
  if (payload === 'QR_CLOSER_DEALER') {
    await Promise.all([
      updateSession(sessionId, {
        step: 'AWAITING_CSKH_CHANNEL',
        state: { ...state, cskh_reason: 'Khách muốn gara gần/tiện hơn' }
      }),
      reply(
        psid,
        sessionId,
        'TROLYoto đã hiểu nhu cầu của anh chị rồi ạ 😊\n\nChuyên viên khách hàng sẽ tư vấn anh chị gara tiện hơn trong thời gian sớm nhất ạ.\n\nAnh chị muốn chờ ở đây hay nhận tư vấn qua điện thoại?',
        [
          qr(QR_TITLE.CSKH_HERE, 'QR_CSKH_HERE'),
          qr(QR_TITLE.LEAVE_PHONE, 'QR_LEAVE_PHONE')
        ]
      )
    ])
  }
}

// ── Free-text matching cho các option step (fuzzy + AI fallback) ───────────

type OptionDef = { keywords: string[]; payload: string }

const STEP_TEXT_OPTIONS: Partial<Record<string, OptionDef[]>> = {
  AWAITING_CONSULT_TYPE: [
    {
      keywords: ['bao gia', 'tro ly', 'bot', 'ai', 'nhanh', 'tuc thi', 'ngay'],
      payload: 'QR_AI_CONSULT'
    },
    {
      keywords: [
        'tu van',
        'chuyen vien',
        'nhan vien',
        'cskh',
        'tu van ki',
        'ky'
      ],
      payload: 'QR_CSKH_CONSULT'
    }
  ],
  AWAITING_BOOKING_STATE: [
    {
      keywords: ['dat lich', 'da dat', 'dat roi', 'ok dat', 'chot'],
      payload: 'QR_BOOK_DONE'
    },
    {
      keywords: ['chua can', 'chua thay', 'de sau', 'tu tu', 'chua'],
      payload: 'QR_NOT_YET'
    },
    {
      keywords: ['ban khoan', 'phan van', 'chua chac', 'suy nghi', 'con'],
      payload: 'QR_CONCERN'
    }
  ],
  AWAITING_CONCERN: [
    {
      keywords: [
        'gia tot',
        're hon',
        'khuyen mai',
        'giam gia',
        'voucher',
        're'
      ],
      payload: 'QR_BETTER_PRICE'
    },
    {
      keywords: ['gan hon', 'dai ly gan', 'gara gan', 'tien hon', 'gan nha'],
      payload: 'QR_CLOSER_DEALER'
    }
  ],
  AWAITING_CSKH_CHANNEL: [
    {
      keywords: ['cho o day', 'cho day', 'cho', 'doi', 'o day'],
      payload: 'QR_CSKH_HERE'
    },
    {
      keywords: [
        'de lai sdt',
        'so dien thoai',
        'sdt',
        'goi',
        'dien thoai',
        'lien he'
      ],
      payload: 'QR_LEAVE_PHONE'
    }
  ]
}

const STEP_AI_OPTIONS: Partial<Record<string, AiOptionDef[]>> = {
  AWAITING_CONSULT_TYPE: [
    {
      payload: 'QR_AI_CONSULT',
      description: 'Người dùng muốn trợ lý ảo / bot báo giá ngay'
    },
    {
      payload: 'QR_CSKH_CONSULT',
      description: 'Người dùng muốn chuyên viên thật / tư vấn kĩ'
    }
  ],
  AWAITING_BOOKING_STATE: [
    {
      payload: 'QR_BOOK_DONE',
      description: 'Người dùng đã đặt lịch / đồng ý chốt gara'
    },
    { payload: 'QR_NOT_YET', description: 'Người dùng chưa cần thay lốp ngay' },
    {
      payload: 'QR_CONCERN',
      description: 'Người dùng còn băn khoăn, phân vân, chưa quyết'
    }
  ],
  AWAITING_CONCERN: [
    {
      payload: 'QR_BETTER_PRICE',
      description: 'Người dùng muốn giá tốt hơn / nhiều khuyến mại hơn'
    },
    {
      payload: 'QR_CLOSER_DEALER',
      description: 'Người dùng muốn đại lý/gara gần hơn, tiện hơn'
    }
  ],
  AWAITING_CSKH_CHANNEL: [
    {
      payload: 'QR_CSKH_HERE',
      description: 'Người dùng muốn chờ tư vấn ngay tại khung chat này'
    },
    {
      payload: 'QR_LEAVE_PHONE',
      description: 'Người dùng muốn để lại số điện thoại để được gọi lại'
    }
  ]
}

function matchStepOption(text: string, options: OptionDef[]): string | null {
  const t = normVn(text)
  if (t.length < 2) return null
  for (const opt of options) {
    for (const kw of opt.keywords) {
      const k = normVn(kw)
      if (t.includes(k) || k.includes(t)) return opt.payload
    }
  }
  return null
}

type StepQuestion = { text: string; qrs: QuickReply[] }
const STEP_QUESTIONS: Partial<Record<string, StepQuestion>> = {
  AWAITING_CONSULT_TYPE: {
    text: 'Anh/chị cần hỗ trợ:',
    qrs: [
      qr(QR_TITLE.AI_CONSULT, 'QR_AI_CONSULT'),
      qr(QR_TITLE.CSKH_CONSULT, 'QR_CSKH_CONSULT')
    ]
  },
  AWAITING_BOOKING_STATE: {
    text: 'Anh/chị thấy sao về các đại lý trên ạ? 😊',
    qrs: [
      qr(QR_TITLE.BOOK_DONE, 'QR_BOOK_DONE'),
      qr(QR_TITLE.NOT_YET, 'QR_NOT_YET'),
      qr(QR_TITLE.CONCERN, 'QR_CONCERN')
    ]
  },
  AWAITING_CONCERN: {
    text: 'Anh chị còn băn khoăn điều gì ạ 😊',
    qrs: [
      qr(QR_TITLE.BETTER_PRICE, 'QR_BETTER_PRICE'),
      qr(QR_TITLE.CLOSER_DEALER, 'QR_CLOSER_DEALER')
    ]
  },
  AWAITING_CSKH_CHANNEL: {
    text: 'Anh chị muốn chờ ở đây hay nhận tư vấn qua điện thoại?',
    qrs: [
      qr(QR_TITLE.CSKH_HERE, 'QR_CSKH_HERE'),
      qr(QR_TITLE.LEAVE_PHONE, 'QR_LEAVE_PHONE')
    ]
  }
}

async function resendQuestion(
  psid: string,
  sessionId: string,
  step: string
): Promise<void> {
  const q = STEP_QUESTIONS[step]
  if (!q) return
  await reply(
    psid,
    sessionId,
    `Em chưa hiểu ý anh/chị lắm 😅\n\n${q.text}`,
    q.qrs
  )
  await updateSession(sessionId, { step: step as MessengerStep })
}

/**
 * Đếm strike khi không match option ở step có button.
 *  - < MAX → resend câu hỏi
 *  - ≥ MAX → gửi tin xin lỗi + completeSession. Khách nhắn lại bất kỳ tin → bot
 *            tự welcome (qua dispatcher null-session branch).
 */
async function handleNoMatch(
  psid: string,
  sessionId: string,
  _pageId: string,
  state: SessionState,
  step: string
): Promise<void> {
  const failed = (state.failed_attempts ?? 0) + 1
  if (failed >= MAX_FAILED_ATTEMPTS) {
    await reply(
      psid,
      sessionId,
      'TROLY xin lỗi vì chưa hiểu ý anh/chị 😅\n\nAnh/chị nhắn lại bất cứ lúc nào TROLY sẽ hỗ trợ lại nhé 🤝'
    )
    await completeSession(sessionId)
    return
  }
  await updateSession(sessionId, {
    state: { ...state, failed_attempts: failed }
  })
  await resendQuestion(psid, sessionId, step)
}

async function resetStrikes(
  sessionId: string,
  state: SessionState
): Promise<void> {
  if (state.failed_attempts && state.failed_attempts > 0) {
    await updateSession(sessionId, { state: { ...state, failed_attempts: 0 } })
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Main dispatcher
// ════════════════════════════════════════════════════════════════════════════

const OPTION_STEPS = [
  'AWAITING_CONSULT_TYPE',
  'AWAITING_BOOKING_STATE',
  'AWAITING_CONCERN',
  'AWAITING_CSKH_CHANNEL'
]

async function routeMatchedOption(
  psid: string,
  sessionId: string,
  step: string,
  payload: string,
  state: SessionState
): Promise<void> {
  switch (step) {
    case 'AWAITING_CONSULT_TYPE':
      await handleConsultChoice(psid, sessionId, payload, state)
      break
    case 'AWAITING_BOOKING_STATE':
      await handleBookingState(psid, sessionId, payload, state)
      break
    case 'AWAITING_CONCERN':
      await handleConcern(psid, sessionId, payload, state)
      break
    case 'AWAITING_CSKH_CHANNEL':
      await handleCskhChannel(psid, sessionId, payload, state)
      break
  }
}

export async function handleMessengerEvent(
  event: MessengerEvent,
  pageId: string
): Promise<void> {
  try {
    const psid = event.sender.id

    // CSKH reply từ Page Inbox → pause bot
    if (event.message?.is_echo) {
      const recipientPsid = event.recipient.id
      const activeSession = await getActiveSession(recipientPsid, pageId)
      if (activeSession && !activeSession.is_paused_by_cskh) {
        cancelTimer(activeSession.id, 'cskh-takeover')
        await pauseSessionByCskh(activeSession.id)
        appendConversationLog(activeSession.id, {
          role: 'system',
          type: 'system',
          text: '[Bot paused by CSKH reply]',
          ts: new Date().toISOString()
        }).catch(e => console.error('[FB log]', e))
        console.log(`[FB] Bot paused for psid=${recipientPsid} by CSKH`)
      }
      return
    }

    if (psid === pageId) return

    // Bỏ qua event không actionable (delivery/read/etc). FB gửi các event này
    // CỰC NHIỀU sau mỗi tin bot. Nếu không skip, chúng sẽ rơi vào nhánh
    // null-session và bắn welcome sai (sau khi vừa completeSession).
    const isActionable = !!(
      event.message?.text ||
      event.message?.quick_reply ||
      event.postback ||
      event.optin ||
      event.referral
    )
    if (!isActionable) return

    // Fire-and-forget: gửi typing_on + markSeen ngay khi nhận event để khách
    // thấy bot đang xử lý (DB query + AI call có thể tốn 1-3s). FB typing TTL
    // ~20s, đủ phủ thời gian xử lý; reply() sau đó sẽ tự refresh.
    sendTypingOn(psid, PAGE_TOKEN).catch(e =>
      console.error('[FB typing-early]', e)
    )
    markSeen(psid, PAGE_TOKEN).catch(e => console.error('[FB markSeen]', e))

    let session: FbSession | null = await getActiveSession(psid, pageId)
    if (session?.is_paused_by_cskh) return

    // V2: KHÔNG auto-cancel timer ở đây — timer phải chạy đủ 15s/45s dù khách
    // gõ gì. Các nudge callback có guard step-check để no-op nếu khách đã
    // chuyển flow hợp lệ (vd: click QR Đã đặt lịch). Cancel chỉ ở /reset hoặc
    // CSKH takeover (is_echo).

    if (event.optin || event.referral) {
      if (!session) session = await createSession(psid, pageId)
      await sendWelcome(psid, session.id)
      return
    }

    const messageText = event.message?.text?.trim() ?? ''
    const payload =
      event.message?.quick_reply?.payload ?? event.postback?.payload ?? ''

    const latest = session ? null : await getLatestSession(psid, pageId)
    // CSKH-takeover: stay silent vĩnh viễn
    if (!session && latest?.is_paused_by_cskh) return

    if (!session) {
      // Session đã kết thúc / chưa có → tạo phiên mới và welcome.
      // (User gửi tin bất kỳ sau khi end → welcome lại; không nhắn → bot im lặng.)
      session = await createSession(psid, pageId)
      await sendWelcome(psid, session.id)
      return
    }

    const { step, state } = session

    // Log tin nhắn user
    if (messageText || payload) {
      appendConversationLog(session.id, {
        role: 'user',
        type: payload ? 'qr_click' : 'text',
        text: messageText || `[click: ${payload}]`,
        ts: new Date().toISOString(),
        ...(payload ? { payload } : {})
      }).catch(e => console.error('[FB log user]', e))
    }

    // ── Quick reply / postback ───────────────────────────────────────────
    if (payload) {
      // Global payloads (xử lý bất kể step)
      if (payload.startsWith('TIRE_SIZE:')) {
        await announceBasicPrice(
          psid,
          session.id,
          payload.replace('TIRE_SIZE:', ''),
          state
        )
        return
      }
      if (payload === 'QR_SIZE_NOT_RIGHT') {
        await cskhHandoff(
          psid,
          session.id,
          state,
          'Khách bấm "Không đúng" ở bước kích cỡ'
        )
        return
      }
      if (payload === 'QR_CSKH_HERE' || payload === 'QR_LEAVE_PHONE') {
        await handleCskhChannel(psid, session.id, payload, state)
        return
      }
      // "Tư vấn kĩ" có thể được offer ở nhiều bước fallback → route global
      if (payload === 'QR_CSKH_CONSULT') {
        await handleConsultChoice(psid, session.id, payload, state)
        return
      }
      if (payload.startsWith('QR_BRAND_')) {
        await handleBrandConfirm(psid, session.id, payload, state)
        return
      }
      // Booking/concern QRs: route GLOBAL (không phụ thuộc step) — chống race với
      // timer 45s; đảm bảo intent của khách luôn xử lý đúng dù step đã đổi.
      if (
        payload === 'QR_BOOK_DONE' ||
        payload === 'QR_NOT_YET' ||
        payload === 'QR_CONCERN'
      ) {
        console.log(
          `[FB flow] booking-global payload=${payload} step=${step} session=${session.id}`
        )
        await handleBookingState(psid, session.id, payload, state)
        return
      }
      if (payload === 'QR_BETTER_PRICE' || payload === 'QR_CLOSER_DEALER') {
        console.log(
          `[FB flow] concern-global payload=${payload} step=${step} session=${session.id}`
        )
        await handleConcern(psid, session.id, payload, state)
        return
      }

      switch (step) {
        case 'WELCOME':
        case 'AWAITING_CONSULT_TYPE':
          await handleConsultChoice(psid, session.id, payload, state)
          break
        case 'AWAITING_BOOKING_STATE':
          await handleBookingState(psid, session.id, payload, state)
          break
        case 'AWAITING_CONCERN':
          await handleConcern(psid, session.id, payload, state)
          break
        default:
          // Postback ở step không match → nếu session inactive → welcome lại
          if (!session.is_active) {
            const ns = await createSession(psid, pageId)
            await sendWelcome(psid, ns.id)
          }
      }
      return
    }

    // ── Plain text ───────────────────────────────────────────────────────
    if (messageText) {
      if (messageText === '/reset') {
        cancelTimer(session.id, '/reset')
        await resetUserSessions(psid, pageId)
        const fresh = await createSession(psid, pageId)
        await sendWelcome(psid, fresh.id)
        return
      }

      // Step có button → fuzzy + AI match, fail → strike/resend
      if (OPTION_STEPS.includes(step)) {
        // CSKH channel: nếu khách gõ thẳng số điện thoại → coi như để lại SĐT
        if (step === 'AWAITING_CSKH_CHANNEL' && extractPhone(messageText)) {
          await updateSession(session.id, { step: 'AWAITING_PHONE', state })
          await handlePhoneInput(psid, session.id, messageText, state)
          return
        }
        const opts = STEP_TEXT_OPTIONS[step]
        let matched: string | null = opts
          ? matchStepOption(messageText, opts)
          : null
        if (!matched) {
          const aiOpts = STEP_AI_OPTIONS[step]
          if (aiOpts) matched = await matchOption(messageText, aiOpts)
        }
        if (matched) {
          await resetStrikes(session.id, state)
          await routeMatchedOption(psid, session.id, step, matched, state)
        } else if (step === 'AWAITING_BOOKING_STATE') {
          // V2: timer 45s đang chạy → KHÔNG strike/resend, im lặng chờ timer fire
          console.log(
            `[FB flow] AWAITING_BOOKING_STATE silent (no match) session=${session.id} text="${messageText.slice(0, 50)}"`
          )
        } else {
          await handleNoMatch(psid, session.id, pageId, state, step)
        }
        return
      }

      switch (step) {
        case 'WELCOME':
          await updateSession(session.id, {
            step: 'AWAITING_TIRE_SIZE',
            state: { ...state, consult_type: 'AI' }
          })
          await askTireSize(psid, session.id)
          break

        case 'AWAITING_AREA_FOR_CSKH':
          await handleAreaForCskh(psid, session.id, messageText, state)
          break

        case 'AWAITING_SIZE_FOR_CSKH':
        case 'AWAITING_TIRE_SIZE_AFTER_CSKH':
          await handleSizeForCskh(psid, session.id, messageText, state)
          break

        case 'AWAITING_TIRE_SIZE':
        case 'AWAITING_SIZE_CONFIRM':
        case 'AWAITING_CAR_TIRE_CONFIRM':
          await handleTireInput(psid, session.id, pageId, messageText, state)
          break

        case 'AWAITING_BRAND':
        case 'AWAITING_BRAND_CONFIRM':
          await handleBrandInput(psid, session.id, messageText, state)
          break

        case 'SHOWING_RESULTS_NATIONAL':
        case 'SHOWING_RESULTS':
          // Legacy step (V2 không còn) — chuyển sang hỏi khu vực
          await askLocation(psid, session.id, state)
          break

        case 'AWAITING_LOCATION':
        case 'SHOWING_DEALERS':
          await handleLocationInput(
            psid,
            session.id,
            pageId,
            messageText,
            state
          )
          break

        case 'SHOWING_RESULTS_LOCAL':
          // V2: timer 15s đang chạy → KHÔNG fire ngay, im lặng chờ timer
          console.log(
            `[FB flow] SHOWING_RESULTS_LOCAL silent session=${session.id} text="${messageText.slice(0, 50)}"`
          )
          break

        case 'AWAITING_PHONE':
          await handlePhoneInput(psid, session.id, messageText, state)
          break

        case 'COMPLETED':
        default: {
          // Edge: session vẫn active nhưng step COMPLETED (legacy/defensive)
          // → tạo phiên mới + welcome (khách nhắn lại sau khi kết thúc).
          const ns = await createSession(psid, pageId)
          await sendWelcome(psid, ns.id)
          break
        }
      }
    }
  } catch (err) {
    console.error('[FB flow] handleMessengerEvent:', err)
  }
}
