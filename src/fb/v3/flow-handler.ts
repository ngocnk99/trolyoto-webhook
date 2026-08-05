/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  V3 Flow Handler — AI-driven conversational gathering
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  Khác biệt so với V2:
 *  - Phần "Xác định size + brand + location" → chuyển sang ONE AI turn / message.
 *    Khách có thể nhắn tự do (vd: "lốp 185/60R15 michelin Hà Nội") và bot extract
 *    đa-trường trong 1 lần.
 *  - Bot AI sinh reply tự nhiên thay vì script cứng.
 *
 *  GIỮ NGUYÊN từ V2 (theo yêu cầu user):
 *  - Cách trả ra sản phẩm SP+gara (carousel + 3 button per card)
 *  - Wording lời chào cộng đồng CHĂM XE KHÔNG HỚ (community CTA)
 *  - Timer 15s sau cards / 45s sau booking prompt → con_ban_khoan
 *  - Handoff CSKH (Chờ ở đây / Để lại SĐT)
 *
 *  Page riêng: FACEBOOK_PAGE_ID_V3, token FB_PAGE_ACCESS_TOKEN_V3
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { sendMessage, sendTypingOn, markSeen } from '../client'
import {
  getActiveSession,
  getLatestSession,
  createSession,
  updateSession,
  pauseSessionByCskh,
  completeSession,
  resetUserSessions,
  appendConversationLog,
  markSessionError
} from '../session'
import {
  fetchSpGaraCards,
  resolveProvinceSync,
  resolveMergedProvinceAlias,
  getMinPriceForTireSize,
  fetchTireSizesByCarTags,
  fetchTireSizesByProductSearch,
  findWardsByText,
  getWardParentCode,
  getWardByCode,
  type SpGaraCard,
  type WardMatch
} from '../db'
import type {
  MessengerEvent,
  SessionState,
  QuickReply,
  GenericElement,
  Button,
  FbSession,
  LoggedCard,
  ConversationMessage,
  BrandTier
} from '../types'
import {
  v3GatherTurn,
  getCarNameVariants,
  analyzeTireImage,
  resolveCarModel,
  resolveAddress
} from '../ai-helper'
import { scheduleTimer, cancelTimer } from '../timers'

// Token chọn theo pageId — V3 page và PRODUCTION page dùng chung handler này
// nhưng token khác nhau. AsyncLocalStorage giữ token theo request scope, an
// toàn khi nhiều event chạy song song (mỗi handler call → 1 ALS context).
const PAGE_TOKEN_V3 = process.env.FB_PAGE_ACCESS_TOKEN_V3 ?? ''
const PAGE_TOKEN_PRODUCT = process.env.FB_PAGE_ACCESS_TOKEN_PRODUCT ?? ''
const PAGE_ID_PRODUCT = process.env.FACEBOOK_PAGE_ID_PRODUCT
/** FB App ID của bot — để phân biệt bot tự gửi vs admin reply qua Business Suite.
 *  Bot send API → message.app_id = FB_APP_ID; Business Suite/Pages Manager →
 *  message.app_id KHÁC (263902037430900 cho BS). */
const FB_APP_ID = process.env.FB_APP_ID

const requestContext = new AsyncLocalStorage<{
  token: string
  pageId: string
}>()

/** Trả token cho request hiện tại (set bởi handleMessengerEventV3). */
function currentToken(): string {
  return requestContext.getStore()?.token ?? PAGE_TOKEN_V3
}

function tokenForPageId(pageId: string): string {
  if (PAGE_ID_PRODUCT && pageId === PAGE_ID_PRODUCT) return PAGE_TOKEN_PRODUCT
  return PAGE_TOKEN_V3
}
const TROLYOTO_URL = 'https://trolyoto.com'
const COMMUNITY_URL = 'https://www.facebook.com/groups/748788784953241'

// Timers (giữ y V2)
const NUDGE_HELP_MS = 15_000
const NUDGE_BOOKING_MS = 45_000

// V3: nudge "thiếu thông tin" khi bot đang hỏi size/brand/location mà khách im lặng.
// Override qua ENV cho phép tune không cần sửa code + deploy lại (cũng tiện để
// test nhanh: set vài giây thay vì chờ 90s/60s thật).
const NUDGE_INFO_STAGE1_MS = Number(process.env.NUDGE_INFO_STAGE1_MS) || 90_000 // 90s: nhắc + hỏi lại field thiếu
const NUDGE_INFO_STAGE2_MS = Number(process.env.NUDGE_INFO_STAGE2_MS) || 60_000 // +60s tiếp nếu vẫn im lặng: 2 tin mời "trợ giá khi cần"

// Brand tiers V2 (giữ để map AI brand_tier → brand list lúc query DB)
const BRAND_TIERS = {
  premium: {
    brands: [
      'MICHELIN',
      'BRIDGESTONE',
      'TOYO',
      'CONTINENTAL',
      'PIRELLI'
    ] as string[]
  },
  balanced: {
    brands: ['HANKOOK', 'GOODYEAR', 'DUNLOP', 'YOKOHAMA'] as string[]
  },
  budget: {
    brands: [
      'SAILUN',
      'KUMHO',
      'ROADX',
      'LAUFENN',
      'NEXEN',
      'TBB',
      'WESTLAKE',
      'MAXXIS',
      'OTANI'
    ] as string[]
  },
  all: { brands: [] as string[] }
} as const

// QR titles (≤20 ký tự — giống V2 để wording booking/concern/CSKH không đổi)
const QR_TITLE = {
  BOOK_DONE: '✅ Đã đặt lịch',
  NOT_YET: '🕐 Chưa cần thay',
  CONCERN: '🤔 Còn băn khoăn',
  BETTER_PRICE: '💰 Giá tốt hơn',
  CLOSER_DEALER: '📍 Đại lý gần hơn',
  VIEW_PROMO: '🎁 Xem khuyến mại',
  VIEW_OTHER_GARAGE: 'So sánh giá gara khác',
  VIEW_OTHER_PRODUCT: 'Xem loại lốp khác',
  COMMUNITY_SUBSIDY: 'Trợ giá khi cần',
  COMMUNITY_VOUCHER: 'Nhận voucher 200k',
  // V3 mới
  BRAND_ALL: 'Xem tất cả',
  CHAT_TVV: '💬 Chat tư vấn viên'
} as const

/** Brand list hiển thị làm QR — chọn các brand phổ biến nhất (FB max 13 QR;
 *  V3_BRAND_QRS thêm 1 nút "Xem tất cả" nên giữ ≤ 12 hãng). */
const V3_POPULAR_BRANDS = [
  'MICHELIN',
  'BRIDGESTONE',
  'CONTINENTAL',
  'GOODYEAR',
  'HANKOOK',
  'YOKOHAMA',
  'DUNLOP',
  'KUMHO',
  'SAILUN',
  'MAXXIS',
  'NEXEN',
  'TOYO'
] as const

const V3_BRAND_QRS = (): QuickReply[] => [
  ...V3_POPULAR_BRANDS.map(b => qr(b, `V3_BRAND_NAME:${b}`)),
  qr(QR_TITLE.BRAND_ALL, 'V3_BRAND:all')
]

/** Block mô tả phân khúc — luôn kèm khi hỏi brand để khách thấy gợi ý theo nhu cầu. */
const BRAND_TIER_BLOCK =
  '• Cao cấp: Michelin, Bridgestone, Continental\n' +
  '• Cân bằng: Goodyear, Hankook, Yokohama\n' +
  '• Tiết kiệm: Kumho, Sailun, Laufenn'

const BRAND_ASK_TEXT_FULL = `Anh/chị ưu tiên thương hiệu hoặc tầm giá nào không để TROLYoto giúp mình tìm sản phẩm ưng ý ạ? 😊\n\n${BRAND_TIER_BLOCK}`

// ── Helpers ────────────────────────────────────────────────────────────────

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('vi-VN').format(amount) + 'đ'
}

function qr(title: string, payload: string): QuickReply {
  return { content_type: 'text', title, payload }
}

function extractPhone(text: string): string | null {
  const digits = text.replace(/[^\d+]/g, '')
  const m = digits.match(/(?:\+?84|0)\d{8,10}/)
  return m ? m[0] : null
}

/** Trong giờ làm việc: 9h-18h, Thứ 2 - Thứ 6 (timezone Asia/Ho_Chi_Minh). */
function isWorkingHours(): boolean {
  const vnTime = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' })
  )
  const day = vnTime.getDay()
  const hour = vnTime.getHours()
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18
}

function brandFilterFromState(state: SessionState): string {
  if (state.selected_brands && state.selected_brands.length > 0) {
    return state.selected_brands.join('|')
  }
  return '__skip_brand__'
}

/** Field 2 (brand/phân khúc/giá/tốt nhất) coi là ĐỦ khi có BẤT KỲ tín hiệu nào:
 *  brand cụ thể, phân khúc, tầm giá, hoặc "tốt nhất". Dùng CHUNG ở mọi nơi check
 *  "đủ field 2" để tránh sót — KHÔNG inline lại điều kiện này ở chỗ khác. */
function hasBrandField(state: SessionState): boolean {
  return (
    !!state.brand_tier ||
    (state.selected_brands !== undefined && state.selected_brands.length > 0) ||
    state.max_price != null ||
    state.wants_best_quality === true
  )
}

const TIER_LABEL_VN: Record<'premium' | 'balanced' | 'budget' | 'all', string> =
  {
    premium: 'Cao cấp',
    balanced: 'Cân bằng',
    budget: 'Tiết kiệm',
    all: 'Tất cả'
  }

/** Tóm tắt brand cho summary message — ưu tiên tên tier nếu khớp full list. */
function summarizeBrand(state: SessionState): string {
  const brands = state.selected_brands ?? []
  if (brands.length === 0 && state.wants_best_quality) return 'tốt nhất'
  if (brands.length === 0 && state.max_price != null) {
    return `dưới ${formatCurrency(state.max_price)}`
  }
  if (brands.length === 0) return 'Tất cả'
  const tier = state.brand_tier
  if (tier === 'premium' || tier === 'balanced' || tier === 'budget') {
    const tierBrands = BRAND_TIERS[tier].brands
    const matchesTier =
      brands.length > 1 &&
      tierBrands.length === brands.length &&
      tierBrands.every(b => brands.includes(b))
    if (matchesTier) return TIER_LABEL_VN[tier]
  }
  return brands.join(', ')
}

type FieldKey = 'size' | 'brand' | 'location' | 'price'

/**
 * Parse kích cỡ lốp explicit từ text → chuẩn hoá "XXX/YYRZZ".
 * Match "205/60R16", "205/60/16", "205/60/R16" (sep THỪA cả / lẫn R cùng lúc,
 * vd khách gõ "215/60/r16") + có/không space. Bỏ ký hiệu tốc độ tuỳ chọn
 * (Z/H/V/W...) đứng giữa tỷ lệ khung và "R" — vd "225/55ZR19" → "225/55R19"
 * (catalog không phân biệt theo speed rating). Cận giữa 2 nhóm số cuối cho
 * phép tối đa 4 ký tự phân cách (chữ/space/-//) để không khớp nhầm số ngẫu
 * nhiên ở xa. Trả null nếu không tìm thấy pattern hợp lệ.
 */
function parseExplicitTireSize(text: string): string | null {
  const m = text.match(/(\d{3})\s*[/\s-]?\s*(\d{2})[\sA-Z/-]{0,4}(\d{2})/i)
  return m ? `${m[1]}/${m[2]}R${m[3]}`.toUpperCase() : null
}

/**
 * Phát hiện khách nêu ĐƯỜNG KÍNH VÀNH/MÂM xe (số cuối trong size lốp, vd
 * "235/60R18" → vành 18) qua từ "vành"/"la zăng"/"lazang" (chấp nhận cả
 * không dấu: "vanh", "la zang") kèm số cụ thể. Dùng để LỌC LẠI (client-side,
 * KHÔNG qua AI — chính xác 100% vì so khớp trực tiếp trong list DB đã trả
 * về cho đúng xe đó) danh sách size theo tên xe (`lookupCarSizes` hoặc
 * `state.last_shown_car_sizes`) xuống còn size khớp đường kính khách nêu —
 * dù gõ chung với tên xe trong CÙNG 1 tin ("lốp xe santafe vành 19") hay
 * gõ RIÊNG ở lượt sau khi đã thấy list. QUAN TRỌNG: kết quả lọc LUÔN được
 * show lại qua `showCarSizeOptions` (QR) để khách bấm xác nhận — KHÔNG tự
 * gán thẳng tire_size dù chỉ lọc còn đúng 1 kết quả (tránh chọn nhầm nếu
 * hiểu sai ý khách). Trả null nếu không match hoặc số ngoài phạm vi đường
 * kính vành xe con hợp lý (12-24 inch).
 */
function parseWheelDiameter(text: string): number | null {
  const m = text.match(/(?:vành|vanh|la\s*zăng|la\s*zang|lazang)\D{0,10}(\d{2})\b/i)
  if (!m) return null
  const d = parseInt(m[1], 10)
  if (d < 12 || d > 24) return null
  return d
}

/** Lọc size trong danh sách khớp đúng đường kính vành (hậu tố "R{diameter}")
 *  — có thể khớp NHIỀU size (vd cùng vành 18 nhưng khác bề rộng/tỷ lệ khung),
 *  giữ lại TẤT CẢ để khách tự chọn qua QR, không tự đoán 1 cái. */
function filterSizesByWheelDiameter(
  sizes: string[],
  diameter: number
): string[] {
  const suffix = `R${diameter}`
  return sizes.filter(s => s.toUpperCase().endsWith(suffix))
}

/**
 * Build intro KHI có sản phẩm — hướng dẫn khách bấm vào card.
 * (Không còn dạng xác nhận "{size} {brand} ở {location} phải không...".)
 */
function buildSearchIntro(_state: SessionState): string {
  return (
    'Dạ TROLYoto đã tìm được sản phẩm phù hợp 😊\n' +
    '👇 Anh/chị bấm vào sản phẩm để xem giá chi tiết, khuyến mại và gara gần mình nhé!'
  )
}

/**
 * Phần "Em đã nhận ${field}" — chỉ field "cuối cùng" khách cung cấp.
 * Priority: location > brand > size.
 * Trả '' nếu không có field nào trong updated array.
 */
function buildSummaryHead(state: SessionState, updated: FieldKey[]): string {
  let field: FieldKey | null = null
  if (updated.includes('location')) field = 'location'
  else if (updated.includes('brand')) field = 'brand'
  else if (updated.includes('price')) field = 'price'
  else if (updated.includes('size')) field = 'size'

  let infoLine = ''
  if (field === 'size' && state.tire_size) {
    infoLine = `kích thước: ${state.tire_size}`
  } else if (field === 'brand') {
    infoLine = `thương hiệu: ${summarizeBrand(state)}`
  } else if (field === 'price') {
    infoLine = state.wants_best_quality
      ? 'yêu cầu: tốt nhất'
      : state.max_price != null
        ? `tầm giá: dưới ${formatCurrency(state.max_price)}`
        : ''
  } else if (field === 'location') {
    const loc = state.ward_name
      ? `${state.ward_name}${state.province_name ? `, ${state.province_name}` : ''}`
      : (state.province_name ?? '?')
    infoLine = `khu vực: ${loc}`
  }
  return infoLine ? `Em đã nhận ${infoLine}` : ''
}

/** Suy ra bot đang hỏi field nào dựa trên state CŨ (size → brand → location). */
function deriveLastAsked(
  state: SessionState
): 'size' | 'brand' | 'location' | null {
  if (!state.tire_size) return 'size'
  if (!hasBrandField(state)) {
    return 'brand'
  }
  if (!state.province_code && !state.ward_code) return 'location'
  return null
}

const MAX_FAIL_PER_STEP = 2 // 1 lần = retry; 2 lần = CSKH handoff

/** Delay nhỏ giữa 2 reply liên tiếp — đảm bảo FB Messenger deliver đúng thứ tự.
 *  Khi không delay, FB có thể swap order do queue processing không atomic. */
const REPLY_GAP_MS = 1200
function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Trả về câu hỏi hardcoded cho field thiếu kế tiếp (size → brand → location). */
function nextMissingFieldQuestion(state: SessionState): string | null {
  if (!state.tire_size) {
    return 'Anh/chị cho em biết kích cỡ lốp nhé ạ? Ví dụ: 185/60R15 😊'
  }
  if (!hasBrandField(state)) {
    return BRAND_ASK_TEXT_FULL
  }
  if (!state.province_code && !state.ward_code) {
    return 'Anh/chị ở KHU VỰC THUỘC TỈNH/THÀNH nào để em tìm đại lý gần nhất ạ?\nVí dụ: "Cầu Giấy, Hà Nội" hoặc "TP. Vinh, Nghệ An" 😊'
  }
  return null
}

/** V3: hiển thị list ward QR khi text địa chỉ khớp nhiều ward (vd "Thái Bình"). */
async function showWardConfirmOptions(
  psid: string,
  sessionId: string,
  userText: string,
  wards: WardMatch[],
  state: SessionState
): Promise<void> {
  const capped = wards.slice(0, 11) // chừa chỗ cho "Chat tư vấn viên" (≤13 QR)
  console.log(
    `[V3 wardConfirm] "${userText}" → ${capped.length} options: ${capped.map(w => `${w.code}=${w.path}`).join(', ')}`
  )

  await updateSession(sessionId, {
    step: 'V3_GATHERING',
    state: { ...state, cskh_reason: `Ward chưa xác định cho "${userText}"` }
  })

  const qrs: QuickReply[] = capped.map(w => {
    // Title: "Phường Thái Bình, Hưng Yên" — cắt vừa 20 ký tự FB
    const title = w.path.length <= 20 ? w.path : w.path.slice(0, 19) + '…'
    return qr(title, `V3_WARD:${w.code}`)
  })
  qrs.push(qr(QR_TITLE.CHAT_TVV, 'V3_CHAT_TVV'))

  await reply(
    psid,
    sessionId,
    `Em tìm thấy ${capped.length} khu vực trùng tên "${userText}" ạ 😊\n\nAnh/chị chọn đúng khu vực của mình giúp em nhé:`,
    qrs
  )
}

/** Lấy lịch sử gần đây từ conversation_log để feed AI ngữ cảnh. */
/**
 * Lịch sử gửi cho AI (v3GatherTurn) — CHỈ hội thoại thật giữa khách và bot
 * (role bot/user, KHÔNG phải log system) VÀ KHÔNG bị đánh dấu hidden_from_ai
 * (danh sách SP/cards, CTA cộng đồng/khuyến mại, nudge trợ giá tự động theo
 * timer — xem `ConversationMessage.hidden_from_ai`). Loại các tin này TRƯỚC
 * khi cắt `limit` để cửa sổ lịch sử luôn đủ N lượt hội thoại thật, không bị
 * "hao" chỗ bởi tin hệ thống xen giữa.
 */
function recentHistory(
  log: ConversationMessage[] | undefined,
  limit = 6
): Array<{ role: 'bot' | 'user'; text: string }> {
  if (!log || log.length === 0) return []
  return log
    .filter(m => (m.role === 'bot' || m.role === 'user') && !m.hidden_from_ai)
    .slice(-limit)
    .map(m => ({ role: m.role as 'bot' | 'user', text: m.text }))
}

// ── Send-API wrappers (token theo request scope qua currentToken()) ────────

/**
 * Khi sendMessage trả về !ok → append 1 system log entry mô tả lỗi + set
 * is_error=true (vd FB error 10/2018300 "app khác đang giữ thread").
 */
async function logSendError(
  sessionId: string,
  result: { error?: string; errorCode?: number; errorSubcode?: number }
): Promise<void> {
  const msg = `sendMessage failed (code=${result.errorCode ?? '?'}, subcode=${result.errorSubcode ?? '?'}): ${result.error ?? ''}`
  console.error(`[V3 send-error] session=${sessionId} ${msg}`)
  try {
    await markSessionError(sessionId, msg)
  } catch (e) {
    console.error('[V3 send-error] markSessionError fail:', e)
  }
}

async function reply(
  psid: string,
  sessionId: string,
  text: string,
  quickReplies?: QuickReply[],
  /** true = tin nudge/broadcast hệ thống tự bắn (vd "TRỢ GIÁ tới 800K" theo
   *  timer), KHÔNG phải phản hồi trực tiếp cho tin khách vừa gửi — loại khỏi
   *  recentHistory() để tránh AI đọc nhầm số liệu quảng cáo thành yêu cầu
   *  thật của khách. Mặc định false (hội thoại bình thường). */
  hiddenFromAi = false
): Promise<void> {
  const tok = currentToken()
  sendTypingOn(psid, tok).catch(e => console.error('[V3 typing]', e))
  const result = await sendMessage(
    psid,
    { text, quick_replies: quickReplies },
    tok
  )
  if (!result.ok) {
    await logSendError(sessionId, result)
    return
  }

  appendConversationLog(sessionId, {
    role: 'bot',
    type: quickReplies && quickReplies.length > 0 ? 'quick_replies' : 'text',
    text,
    ts: new Date().toISOString(),
    quick_replies: quickReplies?.map(q => ({
      title: q.title,
      payload: q.payload
    })),
    hidden_from_ai: hiddenFromAi || undefined
  }).catch(e => console.error('[V3 log bot]', e))
}

async function sendButtonTemplate(
  psid: string,
  sessionId: string,
  text: string,
  buttons: Button[],
  context?: string
): Promise<void> {
  const tok = currentToken()
  sendTypingOn(psid, tok).catch(e => console.error('[V3 typing]', e))
  const result = await sendMessage(
    psid,
    {
      attachment: {
        type: 'template',
        payload: { template_type: 'button', text, buttons }
      }
    },
    tok
  )
  if (!result.ok) {
    await logSendError(sessionId, result)
    return
  }
  appendConversationLog(sessionId, {
    role: 'bot',
    type: 'quick_replies',
    text: context ? `${context}: ${text}` : text,
    ts: new Date().toISOString(),
    quick_replies: buttons.map(b => ({
      title: b.title,
      payload: b.payload ?? b.url ?? ''
    })),
    // sendButtonTemplate CHỈ dùng cho CTA cộng đồng/khuyến mại + nudge trợ giá
    // (không phải hội thoại gathering) — luôn loại khỏi recentHistory().
    hidden_from_ai: true
  }).catch(e => console.error('[V3 log button]', e))
}

async function sendCards(
  psid: string,
  sessionId: string,
  elements: GenericElement[],
  context: string
): Promise<void> {
  const result = await sendMessage(
    psid,
    {
      attachment: {
        type: 'template',
        payload: { template_type: 'generic', elements }
      }
    },
    currentToken()
  )
  if (!result.ok) {
    await logSendError(sessionId, result)
    return
  }
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
    cards,
    // Danh sách SP/gara cụ thể — không phải hội thoại, luôn loại khỏi
    // recentHistory() (tránh AI đọc nhầm giá/SP cụ thể thành thứ bot "đã nói").
    hidden_from_ai: true
  }).catch(e => console.error('[V3 log cards]', e))
}

/**
 * Gắn UTM params vào URL để tracking click nguồn từ chatbot (GA/analytics).
 * utm_content phân biệt 3 loại button khi gửi card SP+gara.
 */
function withUtm(
  url: string,
  utmContent:
    | 'view_promo'
    | 'view_other_garage'
    | 'view_other_product'
    | 'view_all'
): string {
  try {
    const u = new URL(url)
    u.searchParams.set('utm_source', 'facebook_bot')
    u.searchParams.set('utm_medium', 'chatbot')
    u.searchParams.set('utm_campaign', 'tire_search')
    u.searchParams.set('utm_content', utmContent)
    return u.toString()
  } catch (e) {
    console.error('[V3 withUtm] invalid URL:', url, e)
    return url
  }
}

// Card SP+gara (GIỮ Y V2 — wording buttons đổi theo yêu cầu UTM tracking)
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
    {
      type: 'web_url',
      title: QR_TITLE.VIEW_PROMO,
      url: withUtm(card.detailUrl, 'view_promo')
    }
  ]
  if (productPageUrl) {
    buttons.push({
      type: 'web_url',
      title: QR_TITLE.VIEW_OTHER_GARAGE,
      url: withUtm(productPageUrl, 'view_other_garage')
    })
  }
  buttons.push({
    type: 'web_url',
    title: QR_TITLE.VIEW_OTHER_PRODUCT,
    url: withUtm(listingUrl, 'view_other_product')
  })

  return {
    title: `${card.brand} ${card.size}`,
    subtitle,
    ...(card.image ? { image_url: card.image } : {}),
    default_action: {
      type: 'web_url' as const,
      url: withUtm(card.detailUrl, 'view_promo')
    },
    buttons
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  V3 — Welcome ngắn khi tạo session, KHÔNG có 2-button screen.
//  - Session mới: tạo session step=V3_GATHERING, gửi welcome ngắn (1 tin),
//    rồi xử lý tin của khách qua handleGathering/handleImage.
// ════════════════════════════════════════════════════════════════════════════

async function sendV3Welcome(psid: string, sessionId: string): Promise<void> {
  await reply(
    psid,
    sessionId,
    '🤝 TRỢ LÝ Ô TÔ – nền tảng kết nối DV ô tô tiện lợi, uy tín – rất vui được hỗ trợ anh/chị 😊'
  )
}

// ── Car → sizes lookup (DB tags + AI OEM) ──────────────────────────────────

/**
 * Convert tên xe → các biến thể cartype code (cover format DB khác nhau).
 *
 * Vd "Mazda CX-5" → [
 *   "MAZDA_CX_5",   // underscore giữa mọi token
 *   "MAZDACX5",     // join hết
 *   "MAZDA-CX-5",   // dash
 *   "MAZDA_CX-5",   // chỉ space → underscore, giữ dash
 *   "MAZDA_CX5"     // gộp 2 token cuối nếu token cuối ngắn (≤2 ký tự)
 * ]
 */
function toCartypeCodes(carName: string): string[] {
  const normalized = carName
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^A-Z0-9\s_-]/g, '')
    .trim()
  if (!normalized) return []

  const tokens = normalized.split(/[\s_-]+/).filter(Boolean)
  if (tokens.length === 0) return []

  const variants = new Set<string>()
  variants.add(tokens.join('_'))
  variants.add(tokens.join(''))
  variants.add(tokens.join('-'))
  variants.add(normalized.replace(/\s+/g, '_')) // giữ dash gốc
  variants.add(normalized.replace(/\s+/g, '-'))
  variants.add(normalized.replace(/[\s_-]+/g, '')) // remove all separators

  // Gộp 2 token cuối nếu token cuối là số/ký tự ngắn (vd "CX 5" → "CX5", "CR V" → "CRV")
  if (tokens.length >= 2) {
    const lastShort = tokens[tokens.length - 1].length <= 2
    if (lastShort) {
      const merged = [...tokens.slice(0, -2), tokens.slice(-2).join('')]
      variants.add(merged.join('_'))
      variants.add(merged.join(''))
      variants.add(merged.join('-'))
    }
  }

  return Array.from(variants).filter(s => s.length > 0)
}

/**
 * V3: Tra kích cỡ lốp theo tên xe — query SONG SONG 2 nguồn DB:
 *   1. tag table (productadmin_tag) qua getCarNameVariants
 *   2. cartype table (productadmin_cartype) qua toCartypeCode
 * Merge dedup case-insensitive, sort theo quantitysold (qua thứ tự DB), cap 4.
 */
async function lookupCarSizes(carModel: string): Promise<string[]> {
  // Lấy cartype codes (vd ['VINFAST_VF8_PLUS','VINFASTVF8PLUS','VINFAST-VF8-PLUS'])
  // Thay '_' và '-' bằng space rồi dedupe → keywords cho search_products_by_tag.
  // Ví dụ: ['VINFAST VF8 PLUS', 'VINFASTVF8PLUS'] (3 variants gốc dedupe còn 2)
  const cartypeCodes = toCartypeCodes(carModel)
  const searchKeywords = Array.from(
    new Set(
      cartypeCodes.map(c => c.replace(/[_-]+/g, ' ').trim()).filter(Boolean)
    )
  )

  // Song song: tag-based + product-search-based (RPC search_products_by_tag)
  const [searchResult] = await Promise.all([
    (async () => {
      if (searchKeywords.length === 0) return [] as string[]
      try {
        const r = await fetchTireSizesByProductSearch(searchKeywords)
        return r.sizes.map(s => s.size)
      } catch (e) {
        console.error('[V3 lookupCarSizes] product-search query:', e)
        return [] as string[]
      }
    })()
  ])

  console.log(
    `[V3 lookupCarSizes] "${carModel}"  search([${searchKeywords.join('|')}])=${searchResult.length}`
  )

  // Merge + dedup case-insensitive + cap 4
  const seen = new Set<string>()
  const sizes: string[] = []
  for (const s of [...searchResult]) {
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
 * Hiển thị QR list size cho dòng xe khách vừa nêu.
 * Payload: V3_TIRE_SIZE:<size> → dispatcher sẽ lưu size + tiếp tục gather.
 */
async function showCarSizeOptions(
  psid: string,
  sessionId: string,
  carName: string,
  sizes: string[]
): Promise<void> {
  const capped = sizes.slice(0, 11)
  // Hiển thị tối đa 3 sizes trong text; thêm ", ..." khi > 3.
  // "các" chỉ xuất hiện khi có nhiều hơn 1 size.
  const hasMultiple = capped.length > 1
  const displaySizes = capped.slice(0, 3)
  const sizeList = displaySizes.join(', ') + (capped.length > 3 ? ', ...' : '')
  const text = `Dạ xe ${carName} có ${hasMultiple ? 'các ' : ''}kích cỡ sau: ${sizeList}\n\nAnh/chị xác nhận có phù hợp không ạ? 😊`
  await reply(
    psid,
    sessionId,
    text,
    capped.map(s => qr(s, `V3_TIRE_SIZE:${s}`))
  )
}

// ════════════════════════════════════════════════════════════════════════════
//  V3 — Handlers cho các QR payloads (brand tier, ward confirm, restart)
// ════════════════════════════════════════════════════════════════════════════

const TIER_LABEL_VI: Record<'premium' | 'balanced' | 'budget' | 'all', string> =
  {
    premium: 'cao cấp',
    balanced: 'cân bằng',
    budget: 'tiết kiệm',
    all: 'xem tất cả'
  }

async function handleBrandNameChoice(
  psid: string,
  session: FbSession,
  pageId: string,
  brand: string
): Promise<void> {
  console.log(`[V3 flow] V3_BRAND_NAME click → brand=${brand}`)
  cancelTimer(session.id, 'v3-brand-name-choice')
  const newState: SessionState = {
    ...session.state,
    selected_brands: [brand],
    brand_tier: 'all', // marker đã chọn brand cụ thể; brand_tier không lọc thêm
    wants_best_quality: false,
    // Đổi brand SAU khi đã có kết quả → giá cũ gắn với tìm kiếm cũ, xoá.
    ...(session.state.has_shown_results ? { max_price: null } : {})
  }
  await updateSession(session.id, { step: 'V3_GATHERING', state: newState })

  const ackText = `Dạ ghi nhận thương hiệu ${brand} ạ 👍`

  const hasSize = !!newState.tire_size
  const hasLocation = !!newState.province_code || !!newState.ward_code
  if (hasSize && hasLocation) {
    await dispatchAndShowResults(psid, session.id, pageId, newState, ['brand'])
    return
  }
  const nextQ = nextMissingFieldQuestion(newState)
  await reply(psid, session.id, nextQ ? `${ackText}\n\n${nextQ}` : ackText)
  maybeScheduleInfoNudge(psid, session.id, pageId, newState)
}

async function handleBrandTierChoice(
  psid: string,
  session: FbSession,
  pageId: string,
  tier: 'premium' | 'balanced' | 'budget' | 'all'
): Promise<void> {
  console.log(`[V3 flow] V3_BRAND click → tier=${tier}`)
  cancelTimer(session.id, 'v3-brand-choice')
  const newState: SessionState = {
    ...session.state,
    brand_tier: tier,
    selected_brands: tier === 'all' ? [] : [...BRAND_TIERS[tier].brands],
    wants_best_quality: false,
    // Đổi brand/phân khúc SAU khi đã có kết quả → giá cũ gắn với tìm kiếm cũ, xoá.
    ...(session.state.has_shown_results ? { max_price: null } : {})
  }
  await updateSession(session.id, { step: 'V3_GATHERING', state: newState })

  const ackText = `Dạ ghi nhận thương hiệu ${TIER_LABEL_VI[tier]} ạ 👍`

  const hasSize = !!newState.tire_size
  const hasLocation = !!newState.province_code || !!newState.ward_code
  if (hasSize && hasLocation) {
    await dispatchAndShowResults(psid, session.id, pageId, newState, ['brand'])
    return
  }
  const nextQ = nextMissingFieldQuestion(newState)
  await reply(psid, session.id, nextQ ? `${ackText}\n\n${nextQ}` : ackText)
  maybeScheduleInfoNudge(psid, session.id, pageId, newState)
}

async function handleWardChoice(
  psid: string,
  session: FbSession,
  pageId: string,
  wardCode: string
): Promise<void> {
  console.log(`[V3 flow] V3_WARD click → wardCode=${wardCode}`)
  cancelTimer(session.id, 'v3-ward-choice')

  // Lookup ward theo code để lấy tên + path tỉnh hiện hành (tránh giữ lại tên
  // tỉnh cũ khách gõ trước đó — có thể sai sau sáp nhập địa giới).
  const wardInfo = getWardByCode(wardCode)

  const newState: SessionState = {
    ...session.state,
    ward_code: wardCode,
    ward_name:
      wardInfo?.name ??
      session.state.ward_name ??
      session.state.province_name ??
      wardCode,
    province_name: wardInfo?.path ?? session.state.province_name,
    // Đổi khu vực SAU khi đã có kết quả → giá cũ gắn với tìm kiếm cũ, xoá.
    ...(session.state.has_shown_results ? { max_price: null } : {})
  }
  await updateSession(session.id, { step: 'V3_GATHERING', state: newState })

  const ackText = `Dạ ghi nhận khu vực đã chọn ạ 👍`

  const hasSize = !!newState.tire_size
  const hasBrand = hasBrandField(newState)
  if (hasSize && hasBrand) {
    await dispatchAndShowResults(psid, session.id, pageId, newState, [
      'location'
    ])
    return
  }
  const nextQ = nextMissingFieldQuestion(newState)
  const needBrand = !!newState.tire_size && !hasBrandField(newState)
  await reply(
    psid,
    session.id,
    nextQ ? `${ackText}\n\n${nextQ}` : ackText,
    needBrand && nextQ ? V3_BRAND_QRS() : undefined
  )
  maybeScheduleInfoNudge(psid, session.id, pageId, newState)
}

// ════════════════════════════════════════════════════════════════════════════
//  V3 Image — đọc size+brand từ ảnh lốp khách gửi
// ════════════════════════════════════════════════════════════════════════════

async function handleImage(
  psid: string,
  session: FbSession,
  pageId: string,
  imageUrl: string
): Promise<void> {
  cancelTimer(session.id, 'v3-image-restart')

  console.log(
    `[V3 image] session=${session.id} url=${imageUrl.slice(0, 80)}...`
  )
  const analysis = await analyzeTireImage(imageUrl)

  const state = session.state
  const newState: SessionState = { ...state }
  const ackParts: string[] = []

  // Đổi size/brand qua ảnh SAU khi đã có kết quả → giá cũ gắn với tìm kiếm
  // cũ, xoá (trước khi apply update để không bị ghi đè lẫn).
  const imgWillResetMaxPrice =
    !!state.has_shown_results &&
    ((!!analysis.tire_size &&
      analysis.confidence >= 0.5 &&
      analysis.tire_size !== state.tire_size) ||
      (!!analysis.brand &&
        analysis.confidence >= 0.5 &&
        (state.selected_brands?.length !== 1 ||
          state.selected_brands[0] !== analysis.brand)))
  if (imgWillResetMaxPrice) newState.max_price = null

  // Áp dụng kết quả nếu confidence ≥ 0.5
  if (analysis.tire_size && analysis.confidence >= 0.5) {
    newState.tire_size = analysis.tire_size
    ackParts.push(`kích cỡ ${analysis.tire_size}`)
  }
  if (analysis.brand && analysis.confidence >= 0.5) {
    const brandUpper = analysis.brand
    // Ghi đè — brand từ ảnh là thông tin mới nhất, không merge với brand cũ
    newState.selected_brands = [brandUpper]
    newState.brand_tier = 'all'
    newState.wants_best_quality = false
    ackParts.push(`thương hiệu ${brandUpper}`)
  }

  // Nếu không đọc được gì → bump fail_size (vì ảnh đang trong context size step)
  if (ackParts.length === 0) {
    const failCount = (newState.fail_size ?? 0) + 1
    newState.fail_size = failCount
    await updateSession(session.id, { step: 'V3_GATHERING', state: newState })
    console.log(`[V3 image] không đọc được → fail_size=${failCount}`)
    if (failCount >= MAX_FAIL_PER_STEP) {
      await cskhHandoff(
        psid,
        session.id,
        newState,
        `Ảnh không đọc được sau ${failCount} lần`
      )
      return
    }
    await reply(
      psid,
      session.id,
      'Để em hỗ trợ chính xác hơn, anh/chị thử chụp lại rõ phần "215/75R16" trên thành lốp giúp em ạ 📸\n\nHoặc nhập tay theo định dạng XXX/YYRZZ (vd: 185/60R15) cũng được ạ 😊'
    )
    maybeScheduleInfoNudge(psid, session.id, pageId, newState)
    return
  }

  // Image extract thành công → reset fail_size
  newState.fail_size = 0
  if (analysis.brand && analysis.confidence >= 0.5) newState.fail_brand = 0
  await updateSession(session.id, { step: 'V3_GATHERING', state: newState })

  const ackText = `Dạ TROLY đọc được ${ackParts.join(' và ')} từ ảnh ạ 👍`

  const hasSize = !!newState.tire_size
  const hasBrand = hasBrandField(newState)
  const hasLocation = !!newState.province_code || !!newState.ward_code

  if (hasSize && hasBrand && hasLocation) {
    // Đủ 3 trường → dispatchAndShowResults sẽ tự compose summary theo result
    const updatedFields: FieldKey[] = []
    if (analysis.tire_size && analysis.confidence >= 0.5)
      updatedFields.push('size')
    if (analysis.brand && analysis.confidence >= 0.5)
      updatedFields.push('brand')
    await dispatchAndShowResults(
      psid,
      session.id,
      pageId,
      newState,
      updatedFields
    )
    return
  }

  const nextQ = nextMissingFieldQuestion(newState)
  // Nếu đang hỏi brand → kèm QR options
  const needBrand = !!newState.tire_size && !hasBrandField(newState)
  await reply(
    psid,
    session.id,
    nextQ ? `${ackText}\n\n${nextQ}` : ackText,
    needBrand && nextQ ? V3_BRAND_QRS() : undefined
  )
  maybeScheduleInfoNudge(psid, session.id, pageId, newState)
}

const ADMIN_UNIT_WORD =
  /\b(xã|phường|thị trấn|huyện|quận|thị xã|thành phố|tỉnh|tp\.?)\s+/gi

/**
 * Bóc các cụm địa danh (ward/district/province) từ text địa chỉ ĐẦY ĐỦ khách
 * gõ (không phải bản đã AI rút gọn về "tỉnh") — dùng làm fallback khi tên tỉnh
 * đơn lẻ (vd "Thái Bình") khớp NHIỀU ward cùng tên sau sáp nhập địa giới, mà
 * khách đã gõ thêm chi tiết xã/huyện (vd "Kiến Xương") có thể khớp DUY NHẤT 1
 * ward → tự resolve thay vì hỏi lại (tránh loop hỏi-đáp vô ích).
 *
 * Vd "Thanh Tân huyện Kiến Xương tỉnh Thái Bình cũ"
 *   → ["Thanh Tân", "Kiến Xương", "Thái Bình"] (cắt trước mỗi từ khoá đơn vị
 *      hành chính, bỏ "cũ", bỏ từ khoá "huyện/tỉnh/..." khỏi mỗi cụm).
 */
function extractLocationTokens(text: string): string[] {
  const cleaned = text.replace(/\(?\s*cũ\s*\)?/gi, ' ').trim()
  if (!cleaned) return []

  const chunks = cleaned
    .split(/(?=\b(?:xã|phường|thị trấn|huyện|quận|thị xã|thành phố|tỉnh)\b)/i)
    .flatMap(p => p.split(','))

  const tokens = chunks
    .map(p => p.replace(ADMIN_UNIT_WORD, '').trim())
    .filter(p => p.length >= 4)

  return Array.from(new Set(tokens))
}

// ════════════════════════════════════════════════════════════════════════════
//  FAQ "cố định + replay card gần nhất" — dùng chung cho "lốp sản xuất năm
//  nào" và "địa chỉ/SĐT gara" (2 FAQ có CÙNG shape: trả lời cố định, gửi lại
//  y nguyên card SP+gara gần nhất, chỉ đổi nhãn nút "🎁 Xem khuyến mại").
// ════════════════════════════════════════════════════════════════════════════

const MANUFACTURE_YEAR_FAQ_TEXT =
  '😊 Năm sản xuất có thể khác nhau giữa từng gara. Anh/chị chọn [Xem năm sản xuất] để xem chi tiết nhé.'
const VIEW_MANUFACTURE_YEAR_TITLE = 'Xem năm sản xuất'

const GARAGE_CONTACT_FAQ_TEXT =
  '😊 Anh/chị sẽ có ngay thông tin liên hệ khi chọn [Xem gara này] ạ.'
const VIEW_GARAGE_CONTACT_TITLE = 'Xem gara này'

/**
 * Trả lời CỐ ĐỊNH (KHÔNG để AI tự sinh) + tìm tin card gần nhất trong
 * conversation_log (đã lưu sẵn đầy đủ LoggedCard[]), gửi lại y nguyên, chỉ
 * đổi nhãn nút "🎁 Xem khuyến mại" → `viewButtonTitle` (giữ nguyên URL — theo
 * yêu cầu: dùng chung URL với nút khuyến mại hiện tại). Chưa có card nào
 * trước đó (khách hỏi ngay từ đầu) → chỉ trả FAQ + tiếp tục hỏi field còn
 * thiếu như bình thường.
 */
async function replyFaqWithReplayCard(
  psid: string,
  session: FbSession,
  pageId: string,
  newState: SessionState,
  faqText: string,
  viewButtonTitle: string,
  logContext: string
): Promise<void> {
  await reply(psid, session.id, faqText)

  const lastCardsMsg = [...session.conversation_log]
    .reverse()
    .find(m => m.role === 'bot' && m.type === 'cards' && m.cards?.length)

  if (!lastCardsMsg?.cards) {
    const nextQ = nextMissingFieldQuestion(newState)
    if (nextQ) {
      await delay(REPLY_GAP_MS)
      const needBrand = !!newState.tire_size && !hasBrandField(newState)
      await reply(
        psid,
        session.id,
        nextQ,
        needBrand ? V3_BRAND_QRS() : undefined
      )
    }
    maybeScheduleInfoNudge(psid, session.id, pageId, newState)
    return
  }

  await delay(REPLY_GAP_MS)
  const relabeled: GenericElement[] = lastCardsMsg.cards.map(c => ({
    title: c.title,
    subtitle: c.subtitle,
    image_url: c.image_url,
    ...(c.url
      ? { default_action: { type: 'web_url' as const, url: c.url } }
      : {}),
    buttons: c.buttons?.map(
      (b): Button => ({
        type: 'web_url',
        title: b.title === QR_TITLE.VIEW_PROMO ? viewButtonTitle : b.title,
        url: b.url ?? ''
      })
    )
  }))
  await sendCards(psid, session.id, relabeled, logContext)
}

/** Khách hỏi "lốp sản xuất năm nào" — xem replyFaqWithReplayCard(). */
async function handleManufactureYearFaq(
  psid: string,
  session: FbSession,
  pageId: string,
  newState: SessionState
): Promise<void> {
  await replyFaqWithReplayCard(
    psid,
    session,
    pageId,
    newState,
    MANUFACTURE_YEAR_FAQ_TEXT,
    VIEW_MANUFACTURE_YEAR_TITLE,
    'Replay card gần nhất (đổi nhãn nút → năm SX)'
  )
}

/** Khách hỏi địa chỉ/SĐT của GARA cụ thể — xem replyFaqWithReplayCard(). */
async function handleGarageContactFaq(
  psid: string,
  session: FbSession,
  pageId: string,
  newState: SessionState
): Promise<void> {
  await replyFaqWithReplayCard(
    psid,
    session,
    pageId,
    newState,
    GARAGE_CONTACT_FAQ_TEXT,
    VIEW_GARAGE_CONTACT_TITLE,
    'Replay card gần nhất (đổi nhãn nút → gara contact)'
  )
}

// ════════════════════════════════════════════════════════════════════════════
//  V3 Gathering — AI conversational turn
// ════════════════════════════════════════════════════════════════════════════

async function handleGathering(
  psid: string,
  session: FbSession,
  pageId: string,
  userInput: string
): Promise<void> {
  const state = session.state
  const sessionId = session.id

  // Hủy mọi timer pending (15s/45s từ flow trước) — khách đang chủ động gather
  // lại / hỏi lốp khác → tin nudge cũ sẽ ghi đè QR mới (vd: list size cho xe).
  cancelTimer(sessionId, 'v3-gathering-restart')

  // 1. Gọi AI gather turn
  const decision = await v3GatherTurn({
    collected: {
      tire_size: state.tire_size,
      brand_tier: state.brand_tier as
        | 'premium'
        | 'balanced'
        | 'budget'
        | 'all'
        | undefined,
      selected_brands: state.selected_brands,
      province_name: state.province_name ?? undefined,
      max_price: state.max_price,
      wants_best_quality: state.wants_best_quality
    },
    userInput,
    recentHistory: recentHistory(session.conversation_log)
  })

  console.log(
    `[V3 gather] session=${sessionId} action=${decision.action} updates=${JSON.stringify(decision.updates)}`
  )

  // 2. Apply updates
  const newState: SessionState = { ...state }
  // Ưu tiên regex parse size từ TIN HIỆN TẠI (deterministic) hơn AI —
  // tránh case AI echo lại size CŨ khi khách gõ size MỚI (vd đang có 185/70R13,
  // khách gõ 155/70R13 nhưng AI trả về 185 cũ). Regex luôn lấy đúng size vừa gõ.
  const parsedSize = parseExplicitTireSize(userInput)

  if (parsedSize) {
    newState.tire_size = parsedSize
  } else if (decision.updates.tire_size) {
    newState.tire_size = decision.updates.tire_size
  }
  if (
    decision.updates.brand_tier !== undefined &&
    decision.updates.brand_tier !== null
  ) {
    newState.brand_tier = decision.updates.brand_tier
    newState.wants_best_quality = false // brand/tier cụ thể → không còn "tốt nhất" mở
    // Map tier → selected_brands (cho fetchSpGaraCards). Nếu AI cũng nêu brands cụ thể, ưu tiên brands.
    if (
      !decision.updates.selected_brands ||
      decision.updates.selected_brands.length === 0
    ) {
      newState.selected_brands = [
        ...BRAND_TIERS[decision.updates.brand_tier].brands
      ]
    }
  }
  if (
    decision.updates.selected_brands &&
    decision.updates.selected_brands.length > 0
  ) {
    newState.selected_brands = decision.updates.selected_brands
    newState.wants_best_quality = false // brand cụ thể → không còn "tốt nhất" mở
    // Nếu AI cung cấp brands cụ thể mà chưa có tier → đoán tier hoặc set 'all' để query nhận brand filter
    if (!newState.brand_tier) newState.brand_tier = 'all'
  }
  // "Tốt nhất" (không kèm brand/phân khúc cụ thể) → mở cascade tìm tier cao nhất
  // đang có hàng, GHI ĐÈ brand/tier cũ (nếu có) để không bị pin vào 1 hãng cũ.
  if (decision.updates.wants_best_quality === true) {
    newState.wants_best_quality = true
    newState.brand_tier = undefined
    newState.selected_brands = []
  }
  // ── max_price ──────────────────────────────────────────────────────────
  // Giữ nguyên khi khách đổi size/brand/khu vực TRƯỚC lần fetch đầu tiên
  // (đang gộp chung 1 yêu cầu). XOÁ khi đổi field đó SAU khi đã có kết quả
  // (has_shown_results) — giá cũ gắn với tìm kiếm cũ, không áp dụng ngầm cho
  // tìm kiếm mới. "isFreshPriceUpdate" (giá AI trả KHÁC giá cũ trong state)
  // luôn được áp dụng bất kể có đổi field khác hay không — AI đôi khi "echo"
  // lại giá cũ y hệt dựa vào lịch sử hội thoại dù khách không nhắc lại trong
  // tin nhắn này (vd chỉ gõ "hankook"); so sánh giá trị mới≠cũ giúp phân biệt
  // "khách nêu giá mới thật" với "AI lặp lại giá cũ".
  const isFreshPriceUpdate =
    decision.updates.max_price != null &&
    decision.updates.max_price !== state.max_price
  // So sánh với state CŨ ở MỌI field (kể cả brand) — tránh AI echo lại đúng
  // brand đã có (vd "Cảm ơn" sau khi có kết quả → v3GatherTurn lặp lại
  // selected_brands cũ y hệt) khiến changedCoreField sai thành true, xoá oan
  // max_price khách vừa set dù chẳng có gì thực sự thay đổi.
  const changedCoreField =
    (!!parsedSize && parsedSize !== state.tire_size) ||
    (!!decision.updates.tire_size &&
      decision.updates.tire_size !== state.tire_size) ||
    (!!decision.updates.brand_tier &&
      decision.updates.brand_tier !== state.brand_tier) ||
    (!!decision.updates.selected_brands &&
      decision.updates.selected_brands.length > 0 &&
      JSON.stringify(decision.updates.selected_brands) !==
        JSON.stringify(state.selected_brands)) ||
    (!!decision.updates.province_name &&
      decision.updates.province_name !== state.province_name)
  if (isFreshPriceUpdate) {
    newState.max_price = decision.updates.max_price
  } else if (state.has_shown_results && changedCoreField) {
    newState.max_price = null
    console.log(
      `[V3 gather] session=${sessionId} reset max_price (đổi size/brand/khu vực sau khi đã có kết quả)`
    )
  }

  // 3. Resolve location (province + ward). Strategy:
  //    a. resolveProvince → match province? Save province_code.
  //    b. findWardsByText → match ward(s)? Nếu 1 ward trong cùng province → auto.
  //    c. Province không match → ward-only fallback (cho case "Thái Bình" sau reorg).
  //  LUÔN ghi đè khi AI trả province_name (kể cả state đã có province/ward cũ).
  let needWardConfirm: WardMatch[] | null = null
  /** Set khi resolveAddress KHÔNG xác định được địa chỉ — trigger hỏi lại
   *  (tối đa MAX_FAIL_PER_STEP lần) thay vì âm thầm đoán bừa theo ward khớp
   *  ngẫu nhiên 1 từ (nguồn gốc bug "hùng yên" từng bị hiểu nhầm "Yên Bái"). */
  let locationAskAgainMsg: string | null = null
  let locationHandoffReason: string | null = null
  // CHỈ re-resolve khi province_name THỰC SỰ khác state cũ đã resolve — tránh
  // v3GatherTurn echo lại giá trị cũ (vd khách nhắn "cảm ơn"/hỏi off-topic sau
  // khi đã có kết quả → AI vẫn lặp lại province_name="Hà Nội" y hệt) khiến bot
  // XOÁ province_code/ward_code đã resolve đúng rồi RE-RESOLVE lại từ đầu chỉ
  // bằng tên tỉnh trần trụi — với tỉnh lớn kiểu "Hà Nội"/"Hồ Chí Minh" (rất
  // nhiều ward có path chứa sẵn tên tỉnh làm substring) sẽ vô tình khớp hàng
  // chục ward trùng tên → hỏi lại khách vô lý dù đã xác nhận khu vực từ trước.
  const isFreshLocationUpdate =
    !!decision.updates.province_name &&
    decision.updates.province_name !== state.province_name
  if (isFreshLocationUpdate && decision.updates.province_name) {
    // Clear location cũ — sẽ được set lại sau resolve
    newState.province_code = undefined
    newState.ward_code = undefined
    newState.ward_name = undefined
    const text = decision.updates.province_name

    // Thử match deterministic (merged-alias + sync) trên USERINPUT GỐC TRƯỚC —
    // đáng tin hơn "text" (province_name do v3GatherTurn tự trích xuất/tóm tắt
    // TỪ userInput — CÓ THỂ đã tự đoán/ảo giác sai ngay trong bước extract, vd
    // "hùng yên" từng bị v3GatherTurn tự trả về "Yên Bái", khiến sync-match
    // trên "text" "khớp đúng" 1 tỉnh cũ HỢP LỆ nhưng SAI theo alias, chặn mất
    // cơ hội gọi resolveAddress bên dưới). "text" chỉ dùng làm phương án dự
    // phòng cho case nhiều lượt chat (địa chỉ nhắc ở lượt trước, userInput
    // lượt này không lặp lại, vd khách chỉ trả lời "ok" sau khi đã cho địa chỉ).
    const tryResolveDeterministic = (candidate: string): boolean => {
      const alias = resolveMergedProvinceAlias(candidate)
      if (alias) {
        newState.province_code = alias.provinceCode
        newState.province_name = alias.provinceName
        newState.ward_code = alias.wardCode ?? undefined
        newState.ward_name = alias.wardName ?? undefined
        newState.fail_location = 0
        console.log(
          `[V3 gather] merged-province alias "${candidate}" → ${
            alias.wardCode
              ? `ward ${alias.wardCode} (${alias.path})`
              : `province ${alias.provinceCode} (${alias.provinceName}, không có ward cụ thể)`
          }`
        )
        return true
      }
      const r = resolveProvinceSync(candidate)
      if (r.code) {
        newState.province_code = r.code
        newState.province_name = r.name ?? candidate
        newState.fail_location = 0
        console.log(
          `[V3 gather] resolveProvinceSync("${candidate}") → province=${r.code} ${r.name}`
        )

        // Cũng quét ward trong candidate — nếu khớp đúng 1 ward thuộc province → auto-pick.
        const wardsInText = findWardsByText(candidate, 5).filter(
          w => w.parent_code === r.code
        )
        if (wardsInText.length === 1) {
          newState.ward_code = wardsInText[0].code
          newState.ward_name = wardsInText[0].name
          console.log(
            `[V3 gather] auto-detect ward "${wardsInText[0].name}" (${wardsInText[0].code}) within province ${r.name}`
          )
        } else if (wardsInText.length > 1) {
          // Nhiều ward khớp → giữ province, không pick ward (sẽ fallback province khi fetch)
          console.log(
            `[V3 gather] ${wardsInText.length} wards match within province → keep province only`
          )
        }
        return true
      }
      return false
    }

    // CHỈ thử deterministic trên userInput — KHÔNG thử lại trên "text" (province_name
    // do v3GatherTurn tự trích xuất). Lý do: "text" luôn là 1 tên tỉnh CHUẨN/hợp lệ
    // khi non-null (kể cả khi bị ảo giác), nên resolveProvinceSync(text) hầu như
    // LUÔN "khớp" — vô hiệu hoá hoàn toàn lớp bảo vệ resolveAddress bên dưới. Case
    // thực tế gặp phải: input "em o cho asdkjqwelkj... khong biet ghi the nao"
    // (không hề nhắc địa danh) vẫn khiến v3GatherTurn tự bịa ra "Hà Nội" — một tên
    // tỉnh hợp lệ — nên sync-match trên "text" sẽ luôn "thành công" dù là bịa. Coi
    // "text" chỉ là TÍN HIỆU (khách CÓ nhắc gì đó về khu vực), không phải dữ liệu
    // đáng tin — giống hệt cách resolveCarModel chỉ dùng userInput gốc, không dùng
    // car_model đã bị v3GatherTurn rút gọn.
    const resolvedDeterministically = tryResolveDeterministic(userInput)

    if (!resolvedDeterministically) {
      try {
        // Deterministic trên userInput fail → resolveAddress dedicated AI call,
        // nhận NGUYÊN VĂN userInput để giữ ngữ cảnh đầy đủ nhất, có confidence
        // threshold rõ ràng thay vì đoán bừa qua fuzzy substring match hay tin
        // tưởng mù quáng vào "text" (vd "hùng yên" từng bị match nhầm ward
        // "Yên Bái" chỉ vì trùng 1 âm tiết "yên").
        const addressResolution = await resolveAddress({ userInput })
        let resolvedOk = false

        if (addressResolution.provinceName) {
          const reResolved = resolveProvinceSync(
            addressResolution.provinceName
          )
          if (reResolved.code) {
            newState.province_code = reResolved.code
            newState.province_name =
              reResolved.name ?? addressResolution.provinceName
            newState.fail_location = 0
            resolvedOk = true
            console.log(
              `[V3 gather] resolveAddress("${userInput}") → province=${reResolved.code} ${reResolved.name} (confidence=${addressResolution.confidence}) ward_hint="${addressResolution.wardHint ?? ''}"`
            )

            if (addressResolution.wardHint) {
              const wardsInHint = findWardsByText(
                addressResolution.wardHint,
                5
              ).filter(w => w.parent_code === reResolved.code)
              if (wardsInHint.length === 1) {
                newState.ward_code = wardsInHint[0].code
                newState.ward_name = wardsInHint[0].name
                console.log(
                  `[V3 gather] ward_hint "${addressResolution.wardHint}" → ward ${wardsInHint[0].code} (${wardsInHint[0].name})`
                )
              }
            }
          } else {
            console.warn(
              `[V3 gather] resolveAddress trả province_name="${addressResolution.provinceName}" không khớp province.json hiện hành`
            )
          }
        }

        if (!resolvedOk) {
          // Nhiều ward TRÙNG TÊN vẫn còn giá trị disambiguate an toàn (khách
          // TỰ xác nhận qua QR, không phải bot âm thầm đoán) — giữ lại
          // nhánh này. CHỈ bỏ nhánh "1 match → auto-accept" (nguồn gốc bug).
          const tokens = extractLocationTokens(userInput)
          let wards = findWardsByText(text, 11)
          if (wards.length > 1) {
            for (const token of tokens) {
              const narrowed = findWardsByText(token, 5)
              if (narrowed.length === 1) {
                wards = narrowed
                break
              }
            }
          }
          if (wards.length > 1) {
            newState.province_name = text
            needWardConfirm = wards
            resolvedOk = true
            console.log(
              `[V3 gather] resolveAddress fail → ward fallback ${wards.length} candidates, hỏi khách xác nhận`
            )
          }
        }

        if (!resolvedOk) {
          const failCount = (newState.fail_location ?? 0) + 1
          newState.fail_location = failCount
          // Ghi lại userInput GỐC (không phải "text" có thể đã bị v3GatherTurn
          // ảo giác) — để CSKH nhận handoff thấy đúng khách đã gõ gì.
          newState.province_name = userInput
          console.log(
            `[V3 gather] resolveAddress không xác định được từ "${userInput}" → fail_location=${failCount}`
          )
          if (failCount >= MAX_FAIL_PER_STEP) {
            locationHandoffReason = `Không xác định được khu vực từ "${userInput}" (${failCount} lần)`
          } else {
            locationAskAgainMsg =
              'Anh/chị giúp em xác nhận lại KHU VỰC THUỘC TỈNH/THÀNH nào ạ?\nVí dụ: "Cầu Giấy, Hà Nội" hoặc "TP. Vinh, Nghệ An" 😊'
          }
        }
      } catch (e) {
        console.error('[V3 gather] resolveAddress:', e)
        newState.province_name = text
      }
    }
  }

  // 4. Tính trạng thái "AI có hiểu không" — để bump/reset fail counter
  const wasAsking = deriveLastAsked(state) // state CŨ trước update
  const aiExtractedAnything = !!(
    decision.updates.tire_size ||
    decision.updates.car_model ||
    decision.updates.brand_tier ||
    (decision.updates.selected_brands &&
      decision.updates.selected_brands.length > 0) ||
    decision.updates.province_name ||
    decision.updates.max_price != null ||
    decision.updates.wants_best_quality === true
  )

  if (aiExtractedAnything) {
    // Khách cung cấp info hữu ích → reset fail counters. KHÔNG reset
    // fail_location nếu resolveAddress vừa xác định fail lượt này (đã tự
    // tăng fail_location ở bước 3) — customer CÓ gõ gì đó (aiExtractedAnything
    // vẫn true vì province_name có text) nhưng nội dung không xác định được
    // địa chỉ, nên phải giữ đúng số lần fail để giới hạn hỏi lại.
    newState.fail_size = 0
    newState.fail_brand = 0
    if (!locationAskAgainMsg && !locationHandoffReason) {
      newState.fail_location = 0
    }
  }

  // 4b. Persist state
  await updateSession(sessionId, { state: newState })

  // 5. Branch theo action
  // V3: nếu AI fail → kèm QR [Chat tư vấn viên] để khách thoát
  if (decision.error) {
    await reply(psid, sessionId, decision.reply, [
      qr(QR_TITLE.CHAT_TVV, 'V3_CHAT_TVV')
    ])
    return
  }

  if (decision.action === 'handoff_cskh') {
    // Đã từng hỏi SĐT rồi (cskhHandoff trước đó đặt step=AWAITING_PHONE) mà
    // khách trả lời tiếp vẫn không có SĐT + AI lại quyết định handoff lần nữa
    // → khách đang từ chối/không có SĐT để cho (vd "không có số điện thoại
    // gara"), KHÔNG hỏi lại vòng 2 (tránh lặp lại y nguyên câu xin lỗi mãi) —
    // đóng luồng luôn qua handlePhoneInput (đã có sẵn nhánh "không có SĐT").
    if (session.step === 'AWAITING_PHONE') {
      console.log(
        `[V3 gather] session=${sessionId} handoff_cskh lặp lại ở AWAITING_PHONE → đóng luồng (handlePhoneInput)`
      )
      await handlePhoneInput(psid, sessionId, userInput, newState)
      return
    }
    // KHÔNG gửi decision.reply ở đây — mọi call site khác của cskhHandoff
    // trong file này đều gọi trực tiếp, không kèm reply riêng (cskhHandoff tự
    // có message rõ ràng, nhất quán). Từng có bug: decision.reply do AI sinh
    // đôi khi nhầm lẫn hỏi "SĐT của gara" thay vì SĐT khách, kèm dư thừa vì
    // cskhHandoff NGAY SAU ĐÓ cũng hỏi SĐT lần nữa → 3 tin nhắn liên tiếp.
    await cskhHandoff(
      psid,
      sessionId,
      newState,
      decision.cskh_reason ?? 'AI v3GatherTurn'
    )
    return
  }

  // FAQ "lốp sản xuất năm nào" — reply cố định + replay card gần nhất, KHÔNG
  // dùng decision.reply do AI sinh (field này bắt buộc câu chữ nguyên văn).
  // Chỉ check off_topic_kind (KHÔNG kèm is_off_topic) — is_off_topic đã biết
  // không đáng tin cậy 100% (AI đôi khi set off_topic_kind đúng nhưng quên set
  // is_off_topic=true cùng lúc); off_topic_kind tự nó đã là tín hiệu đủ chắc.
  if (decision.off_topic_kind === 'manufacture_year') {
    await handleManufactureYearFaq(psid, session, pageId, newState)
    return
  }

  // FAQ "địa chỉ/SĐT gara" — cùng shape với FAQ năm sản xuất ở trên (reply cố
  // định + replay card gần nhất, đổi nhãn nút khác).
  if (decision.off_topic_kind === 'garage_contact') {
    await handleGarageContactFaq(psid, session, pageId, newState)
    return
  }

  // resolveAddress không xác định được địa chỉ → handoff CSKH (đã đạt giới
  // hạn hỏi lại) hoặc hỏi lại (chưa đạt). Priority cao hơn fetch_results/ward
  // confirm — chưa có địa chỉ hợp lệ thì chưa thể làm gì tiếp.
  if (locationHandoffReason) {
    // KHÔNG gửi decision.reply riêng — giống mọi cskhHandoff call site khác,
    // tránh dư thừa (cskhHandoff tự có message rõ ràng "Em đã nhận thông tin...").
    await cskhHandoff(psid, sessionId, newState, locationHandoffReason)
    return
  }
  if (locationAskAgainMsg) {
    // State (kèm fail_location đã tăng) đã persist ở bước 4b phía trên.
    await reply(psid, sessionId, locationAskAgainMsg)
    maybeScheduleInfoNudge(psid, sessionId, pageId, newState)
    return
  }

  // Ward confirm có priority cao hơn fetch_results. KHÔNG gửi decision.reply ở
  // đây — AI thường sinh câu kiểu "tìm sản phẩm ngay ạ" (tưởng đã đủ info),
  // gửi trước showWardConfirmOptions sẽ tạo mâu thuẫn (vừa nói "tìm ngay" vừa
  // hỏi lại khu vực). showWardConfirmOptions tự có message đầy đủ.
  if (needWardConfirm) {
    await showWardConfirmOptions(
      psid,
      sessionId,
      decision.updates.province_name ?? '',
      needWardConfirm,
      newState
    )
    return
  }

  // V3: AUTO fetch_results nếu state đã đủ 3 trường (size + brand + location)
  //  — bất kể AI quyết định gì. Cover case khách re-gather: gửi size mới mà
  //    state có brand+location từ trước → fetch ngay với data mới.
  const hasSize = !!newState.tire_size
  const hasBrand = hasBrandField(newState)
  const hasLocation = !!newState.province_code || !!newState.ward_code

  // Đủ 3 trường → fetch. Nhưng CHỈ fetch khi AI thực sự cập nhật field
  // relevant (size/brand/location) VÀ giá trị KHÁC state cũ. Tránh refetch loop
  // khi AI echo lại field đã có (vd khách hỏi off-topic "gara làm việc khi nào"
  // ở SHOWING_RESULTS → AI emit lại province_name='Hà Nội' → KHÔNG nên re-fetch).
  // Size đổi khi: regex parse ra size mới (ưu tiên) HOẶC AI trả size khác state cũ.
  const sizeChanged =
    (!!parsedSize && parsedSize !== state.tire_size) ||
    (!!decision.updates.tire_size &&
      decision.updates.tire_size !== state.tire_size)
  // So sánh với state CŨ (giống sizeChanged/provinceChanged) — tránh AI echo
  // lại đúng brand/giá đã có (vd "Cảm ơn" sau khi đã có kết quả → v3GatherTurn
  // vẫn lặp lại selected_brands=['GOODYEAR'] y hệt cũ) khiến relevantFieldUpdated
  // sai thành true, tự động re-fetch + gửi lại y nguyên card sản phẩm vô ích.
  const brandChanged =
    (!!decision.updates.brand_tier &&
      decision.updates.brand_tier !== state.brand_tier) ||
    (!!decision.updates.selected_brands &&
      decision.updates.selected_brands.length > 0 &&
      JSON.stringify(decision.updates.selected_brands) !==
        JSON.stringify(state.selected_brands)) ||
    (decision.updates.max_price != null &&
      decision.updates.max_price !== state.max_price) ||
    (decision.updates.wants_best_quality === true &&
      state.wants_best_quality !== true)
  const provinceChanged =
    !!decision.updates.province_name &&
    decision.updates.province_name !== state.province_name
  const relevantFieldUpdated = sizeChanged || brandChanged || provinceChanged

  // Detect: khách EXPLICIT nêu size (vd "vf3 205/55r17") qua regex trong tin gốc.
  // Nếu AI extract car_model nhưng khách KHÔNG viết size pattern → bỏ qua tire_size
  // do AI auto-fill (có thể hallucinate); ưu tiên show car size options.
  // Match "205/60R16", "205/60/16", "205/60/R16" (sep THỪA cả / lẫn R, vd
  // "215/60/r16") + có/không space — đồng bộ với parseExplicitTireSize.
  const userExplicitSize =
    /\d{3}\s*[/\s-]?\s*\d{2}[\sA-Z/-]{0,4}\d{2}/i.test(userInput)
  const carWantsOptions = !!decision.updates.car_model && !userExplicitSize

  if (
    hasSize &&
    hasBrand &&
    hasLocation &&
    relevantFieldUpdated &&
    !carWantsOptions
  ) {
    const updatedFields: FieldKey[] = []
    if (decision.updates.tire_size) updatedFields.push('size')
    if (
      decision.updates.brand_tier ||
      (decision.updates.selected_brands &&
        decision.updates.selected_brands.length > 0)
    ) {
      updatedFields.push('brand')
    }
    if (
      decision.updates.max_price != null ||
      decision.updates.wants_best_quality === true
    ) {
      updatedFields.push('price')
    }
    if (decision.updates.province_name) updatedFields.push('location')
    await dispatchAndShowResults(
      psid,
      sessionId,
      pageId,
      newState,
      updatedFields
    )
    return
  }

  // AI muốn fetch nhưng state thực tế chưa đủ → fallback continue
  if (decision.action === 'fetch_results') {
    console.warn(
      `[V3 gather] action=fetch_results nhưng thiếu (size=${hasSize}, brand=${hasBrand}, location=${hasLocation}) → fallback continue`
    )
  }

  // ── Fail branch: AI không hiểu — bump fail_X cho field đang hỏi ────────
  //  - Off-topic question (vd "có phải bot không") → KHÔNG fail (AI đã reply hợp lệ)
  //  - 1 lần fail: hỏi lại (size → ask image; brand/location → re-ask)
  //  - ≥2 lần fail: cskhHandoff
  //  - Nếu chưa có tin bot nào trong session → prepend welcome intro vào tin retry
  //    (welcome chỉ xuất hiện ở case khách nhắn không khớp luồng nào)
  if (!aiExtractedAnything && wasAsking && !decision.is_off_topic) {
    const failKey =
      wasAsking === 'size'
        ? 'fail_size'
        : wasAsking === 'brand'
          ? 'fail_brand'
          : 'fail_location'
    const count = ((newState[failKey] as number | undefined) ?? 0) + 1
    newState[failKey] = count
    await updateSession(sessionId, { state: newState })
    console.log(`[V3 gather] fail ${wasAsking}=${count}`)

    if (count >= MAX_FAIL_PER_STEP) {
      await cskhHandoff(
        psid,
        sessionId,
        newState,
        `Khách không cung cấp info ở step ${wasAsking} (${count} lần)`
      )
      return
    }

    // Detect tin bot đầu tiên trong session → chèn welcome intro lên trước retry
    const noPriorBotReply = !session.conversation_log.some(
      m => m.role === 'bot'
    )
    const WELCOME_INTRO =
      '🤝 TRỢ LÝ Ô TÔ – nền tảng kết nối DV ô tô tiện lợi, uy tín – rất vui được hỗ trợ anh/chị 😊'

    if (noPriorBotReply) {
      await reply(psid, sessionId, WELCOME_INTRO)
      await delay(REPLY_GAP_MS)
    }

    // 1 lần fail — gửi retry message tone tích cực (không "chưa hiểu")
    if (wasAsking === 'size') {
      await reply(
        psid,
        sessionId,
        'Để em báo giá chính xác hơn, anh/chị gửi giúp em ảnh thành lốp xe để em đọc kích cỡ ạ 📸\n\nHoặc nhập tay theo định dạng XXX/YYRZZ (vd: 185/60R15) cũng được ạ 😊'
      )
      maybeScheduleInfoNudge(psid, sessionId, pageId, newState)
      return
    }
    if (wasAsking === 'brand') {
      await reply(psid, sessionId, BRAND_ASK_TEXT_FULL, V3_BRAND_QRS())
      maybeScheduleInfoNudge(psid, sessionId, pageId, newState)
      return
    }
    if (wasAsking === 'location') {
      await reply(
        psid,
        sessionId,
        'Anh/chị giúp em xác nhận KHU VỰC THUỘC TỈNH/THÀNH nào để em tìm đại lý gần nhất ạ?\nVí dụ: "Hai Bà Trưng, Hà Nội" hoặc "TP. Vinh, Nghệ An" 😊'
      )
      maybeScheduleInfoNudge(psid, sessionId, pageId, newState)
      return
    }
  }

  // ── Branch 1: AI phát hiện tên xe + khách KHÔNG explicit nêu size → show options
  if (carWantsOptions && decision.updates.car_model) {
    // Bỏ qua tire_size từ AI (có thể hallucinate) + clear stale state.tire_size
    newState.tire_size = undefined

    // resolveCarModel là AI call RIÊNG, dedicated chỉ để xác định tên xe —
    // KHÔNG dùng thẳng decision.updates.car_model (v3GatherTurn gộp chung
    // nhiều việc dễ hallucinate tên xe không tồn tại khi khách gõ sai chính
    // tả/phát âm, vd "san ta pe" từng bị đoán nhầm "Toyota San"). Nhận
    // NGUYÊN VĂN userInput (không phải bản đã rút gọn) để giữ ngữ cảnh gợi ý
    // (vd "hàn quốc"). Nếu đã có lần thử trước (car_model_attempts) → coi là
    // khách đang SỬA LẠI vì lần trước sai → loại trừ + dùng model mạnh hơn.
    const priorAttempts = state.car_model_attempts ?? []
    const isRetry = priorAttempts.length > 0
    const resolution = await resolveCarModel({
      userInput,
      excludeModels: priorAttempts,
      useStrongModel: isRetry
    })

    if (!resolution.carModel) {
      // Resolver cũng không xác định được → coi như size-fail, tránh lặp lại
      // vòng hỏi vô ích với 1 tên xe hallucinate.
      const failCount = (newState.fail_size ?? 0) + 1
      newState.fail_size = failCount
      newState.car_model_attempts = []
      await updateSession(sessionId, { state: newState })
      console.log(
        `[V3 gather] resolveCarModel không xác định được từ "${userInput}" (exclude=${priorAttempts.length}) → fail_size=${failCount}`
      )

      if (failCount >= MAX_FAIL_PER_STEP) {
        await cskhHandoff(
          psid,
          sessionId,
          newState,
          `Không xác định được xe từ "${userInput}" (${failCount} lần)`
        )
        return
      }
      await reply(
        psid,
        sessionId,
        `Để em hỗ trợ chính xác hơn, anh/chị gửi giúp em ảnh thành lốp xe ạ 📸\n\nHoặc nhập tay theo định dạng XXX/YYRZZ (vd: 185/60R15) cũng được ạ 😊`
      )
      maybeScheduleInfoNudge(psid, sessionId, pageId, newState)
      return
    }

    const carName = resolution.carModel
    newState.car_model_attempts = [...priorAttempts, carName]
    await updateSession(sessionId, { state: newState })
    console.log(
      `[V3 gather] car raw="${decision.updates.car_model}" → resolveCarModel(${isRetry ? 'retry' : '1st'})="${carName}" (confidence=${resolution.confidence}) → lookupCarSizes`
    )

    const justGotBrand =
      (decision.updates.selected_brands &&
        decision.updates.selected_brands.length > 0) ||
      decision.updates.brand_tier
    let ackText: string
    if (justGotBrand) {
      const brandLabel =
        decision.updates.selected_brands &&
        decision.updates.selected_brands.length > 0
          ? decision.updates.selected_brands.join(', ')
          : `phân khúc ${decision.updates.brand_tier}`
      ackText = `Dạ ghi nhận ${brandLabel} ạ 👍\n\nEm tra cứu kích cỡ cho xe ${carName} ngay ạ 😊`
    } else {
      ackText = `Dạ em tra cứu kích cỡ cho xe ${carName} ngay ạ 😊`
    }
    await reply(psid, sessionId, ackText)

    const sizes = await lookupCarSizes(carName)
    if (sizes.length > 0) {
      // Khách có thể đã nêu "vành X"/"la zăng X" NGAY TRONG tin nhắn này,
      // gộp chung với tên xe (vd "lốp xe santafe vành 19") → lọc lại xuống
      // đúng đường kính khách nêu TRƯỚC khi show — nhưng VẪN show qua QR để
      // khách bấm xác nhận (xem showCarSizeOptions), KHÔNG tự gán tire_size.
      const diameter = parseWheelDiameter(userInput)
      const filtered =
        diameter != null ? filterSizesByWheelDiameter(sizes, diameter) : []
      const sizesToShow = filtered.length > 0 ? filtered : sizes
      // Lưu list + tên xe vừa show — cho phép khách gõ "vành X"/"la zăng X"
      // Ở LƯỢT SAU thay vì bấm QR (xem parseWheelDiameter ở đầu file + check
      // trong dispatcher phần "Plain text").
      await updateSession(sessionId, {
        state: {
          ...newState,
          car_model: carName,
          last_shown_car_sizes: sizesToShow
        }
      })
      if (diameter != null && filtered.length === 0) {
        await reply(
          psid,
          sessionId,
          `Dạ xe ${carName} không có kích cỡ vành ${diameter} ạ, hiện có các kích cỡ sau ạ:`
        )
      }
      await showCarSizeOptions(psid, sessionId, carName, sizesToShow)
    } else {
      // V3: car name không tra ra size → coi là size-fail
      const failCount = (newState.fail_size ?? 0) + 1
      newState.fail_size = failCount
      await updateSession(sessionId, { state: newState })
      console.log(
        `[V3 gather] car "${carName}" no DB sizes → fail_size=${failCount}`
      )

      if (failCount >= MAX_FAIL_PER_STEP) {
        await cskhHandoff(
          psid,
          sessionId,
          newState,
          `Không tra được size cho xe "${carName}" (${failCount} lần)`
        )
        return
      }
      await reply(
        psid,
        sessionId,
        `Để em hỗ trợ chính xác cho xe "${carName}", anh/chị gửi giúp em ảnh thành lốp xe ạ 📸\n\nHoặc nhập tay theo định dạng XXX/YYRZZ (vd: 185/60R15) cũng được ạ 😊`
      )
    }
    // Cả 2 nhánh trên (show size options / retry no-sizes) đều là bot đang
    // hỏi field "size" → schedule nudge nếu state vẫn thiếu.
    maybeScheduleInfoNudge(psid, sessionId, pageId, newState)
    return
  }

  // ── Branch 2: gửi reply AI bình thường, có thể kèm brand QRs + tier block
  const needBrand = !!newState.tire_size && !hasBrandField(newState)
  const askingBrand = decision.action === 'continue' && needBrand
  // Khi hỏi brand → kèm block mô tả phân khúc (nối vào sau AI reply)
  const replyText = askingBrand
    ? `${decision.reply}\n\n${BRAND_TIER_BLOCK}`
    : decision.reply
  const replyQRs = askingBrand ? V3_BRAND_QRS() : undefined
  await reply(psid, sessionId, replyText, replyQRs)

  // Safety-net: AI đôi khi chỉ ack mà quên hỏi field thiếu kế tiếp.
  if (!decision.reply.includes('?')) {
    const fallback = nextMissingFieldQuestion(newState)
    if (fallback) {
      console.log(`[V3 gather] safety-net fallback: ${fallback}`)
      const fallbackIsAboutBrand = needBrand && !askingBrand
      await delay(REPLY_GAP_MS)
      await reply(
        psid,
        sessionId,
        fallback,
        fallbackIsAboutBrand ? V3_BRAND_QRS() : undefined
      )
    }
  }

  // Bot vừa hỏi tiếp field thiếu (size/brand/location) qua AI reply hoặc
  // safety-net fallback → schedule nudge nếu vẫn còn thiếu.
  maybeScheduleInfoNudge(psid, sessionId, pageId, newState)
}

// ════════════════════════════════════════════════════════════════════════════
//  Show SP+gara cards (giữ y V2, wording không đổi)
// ════════════════════════════════════════════════════════════════════════════

async function showSpGaraResults(
  psid: string,
  sessionId: string,
  pageId: string,
  state: SessionState,
  updatedFields: FieldKey[]
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
  const wardCode = state.ward_code ?? null
  const provinceCode = state.province_code ?? null
  const locationLabel = state.ward_name
    ? `${state.ward_name}${state.province_name ? `, ${state.province_name}` : ''}`
    : (state.province_name ?? '')

  // V3 yêu cầu: BẮT BUỘC có ward_code hoặc province_code mới query
  if (!wardCode && !provinceCode) {
    console.warn(`[V3 showSpGara] no ward/province → cskhHandoff`)
    await cskhHandoff(
      psid,
      sessionId,
      state,
      'State thiếu ward/province khi fetch'
    )
    return
  }

  console.log(
    `[V3 showSpGara] session=${sessionId} INPUT: size="${tireSize}" brand="${brandFilter}" ward=${wardCode} province=${provinceCode} label="${locationLabel}"`
  )

  try {
    let cards: SpGaraCard[] = []
    let usedFallbackProvince = false
    let usedFallbackBrand = false

    const maxFinalPriceFloor = state.max_price ?? undefined

    // 1. Ưu tiên ward_code nếu có
    if (wardCode) {
      cards = await fetchSpGaraCards({
        tireSize,
        tireBrand: brandFilter,
        provinceCode: null,
        wardCode,
        limit: 3,
        sortBy: 'lowest_price',
        maxFinalPriceFloor
      })
      console.log(
        `[V3 showSpGara] ward query (${wardCode}) → ${cards.length} cards`
      )
    }

    // 2. Nếu ward không có gara → fallback toàn tỉnh/TP.
    //    provinceCode có thể null (khách chỉ cho ward) → suy ra từ parent_code của ward.
    if (cards.length === 0) {
      const fallbackProvinceCode =
        provinceCode ?? (wardCode ? getWardParentCode(wardCode) : null)
      if (fallbackProvinceCode) {
        cards = await fetchSpGaraCards({
          tireSize,
          tireBrand: brandFilter,
          provinceCode: fallbackProvinceCode,
          wardCode: null,
          limit: 3,
          sortBy: 'lowest_price',
          maxFinalPriceFloor
        })
        usedFallbackProvince = !!wardCode // chỉ đánh dấu fallback khi có ward trước đó
        console.log(
          `[V3 showSpGara] province fallback (${fallbackProvinceCode}${provinceCode ? '' : ' ← ward parent'}) → ${cards.length} cards${usedFallbackProvince ? ' [WARD→PROVINCE fallback]' : ''}`
        )
      }
    }

    // 3. Vẫn không có gara (dù đã thử ward + toàn tỉnh) VÀ đang lọc theo brand
    //    cụ thể (không phải "Xem tất cả") → thử lại CÙNG khu vực nhưng bỏ lọc
    //    brand, để khách vẫn thấy lựa chọn khác thay vì đi thẳng CSKH. Vẫn giữ
    //    điều kiện giá (maxFinalPriceFloor) nếu khách có nêu tầm giá.
    if (cards.length === 0 && brandFilter !== '__skip_brand__') {
      const fallbackWard = wardCode
      const fallbackProvince =
        provinceCode ?? (wardCode ? getWardParentCode(wardCode) : null)
      if (fallbackWard || fallbackProvince) {
        cards = await fetchSpGaraCards({
          tireSize,
          tireBrand: '__skip_brand__',
          provinceCode: fallbackWard ? null : fallbackProvince,
          wardCode: fallbackWard,
          limit: 3,
          sortBy: 'lowest_price',
          maxFinalPriceFloor
        })
        usedFallbackBrand = cards.length > 0
        console.log(
          `[V3 showSpGara] brand fallback (all brands, ${fallbackWard ? `ward=${fallbackWard}` : `province=${fallbackProvince}`}) → ${cards.length} cards${usedFallbackBrand ? ' [BRAND fallback]' : ''}`
        )
      }
    }

    const head = buildSummaryHead(state, updatedFields)

    if (cards.length === 0) {
      // V3: không có SP/gara → summary + "sẽ gửi thông tin sớm nhất" + phone-ask
      const msg1 = head
        ? `${head}\n\nBên em sẽ gửi thông tin sản phẩm sớm nhất tới anh/chị 😊`
        : 'Em đã nhận thông tin ạ 🙏\n\nBên em sẽ gửi thông tin sản phẩm sớm nhất tới anh/chị 😊'
      await updateSession(sessionId, {
        step: 'AWAITING_PHONE',
        state: {
          ...state,
          cskh_reason:
            brandFilter !== '__skip_brand__'
              ? `Không có gara cho size ${tireSize} (brand="${brandFilter}", đã thử cả all brand) ở ${locationLabel}`
              : `Không có gara cho size ${tireSize} ở ${locationLabel}`
        }
      })
      await reply(psid, sessionId, msg1)
      await delay(REPLY_GAP_MS)
      await reply(
        psid,
        sessionId,
        'Hoặc để được hỗ trợ mình nhanh hơn, anh/chị vui lòng để lại số điện thoại ạ 😊'
      )
      return
    }

    // Có SP → intro (gộp 1 tin — kèm ghi chú brand fallback nếu có, tránh 2
    // tin liên tiếp cùng mở đầu "TROLYoto tìm/đã tìm được..." trùng ý).
    const msgFound = usedFallbackBrand
      ? `Dạ TROLYoto tìm thấy gara gần mình có những sản phẩm này ạ 😊 Anh/chị có thể tìm được thương hiệu mong muốn khi chọn "Xem loại lốp khác" nhé!\n👇 Anh/chị bấm vào sản phẩm để xem giá chi tiết, khuyến mại và gara gần mình nhé!`
      : buildSearchIntro(state)
    await reply(psid, sessionId, msgFound)
    await delay(REPLY_GAP_MS)
    const displayLabel = usedFallbackProvince
      ? (state.province_name ?? locationLabel)
      : locationLabel
    await sendCards(
      psid,
      sessionId,
      cards.map(buildSpGaraCard),
      `${cards.length} SP+gara ở ${displayLabel}${usedFallbackProvince ? ' (ward fallback)' : ''}${usedFallbackBrand ? ' (brand fallback)' : ''}`
    )

    const shownCodes = cards
      .map(c => c.garageCode)
      .filter((c): c is string => !!c)
    const minPrice = Math.min(...cards.map(c => c.finalPrice))

    await updateSession(sessionId, {
      step: 'SHOWING_RESULTS_LOCAL',
      is_active: true,
      state: {
        ...state,
        shown_garage_codes: shownCodes,
        shown_garage_min_price: minPrice,
        shown_national: false,
        has_shown_results: true
      }
    })

    scheduleTimer(
      sessionId,
      NUDGE_HELP_MS,
      () => promptHelpAndBooking(psid, sessionId, pageId),
      'v3-help-15s'
    )
  } catch (err) {
    console.error('[V3 flow] showSpGaraResults:', err)
    await reply(
      psid,
      sessionId,
      'Xin lỗi, có lỗi khi tìm sản phẩm/đại lý. Vui lòng thử lại sau ạ 😊'
    )
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Dispatch chiến lược tìm kiếm — brand cụ thể (1 hoặc ≥4 hãng) / phân khúc /
//  chỉ giá → GIỮ NGUYÊN showSpGaraResults hiện có (case "standard").
//  2-3 hãng cụ thể → multi_brand (nhiều carousel). "Tốt nhất" / "Xem hết"
//  (brand_tier='all' rỗng brand) → cascade tier×khu vực.
// ════════════════════════════════════════════════════════════════════════════

/** Thứ tự thử tier khi cascade — cao cấp trước, "all" (bỏ lọc brand) sau cùng. */
const TIER_CASCADE_ORDER: Array<'premium' | 'balanced' | 'budget' | 'all'> = [
  'premium',
  'balanced',
  'budget',
  'all'
]

type FetchStrategy =
  | { kind: 'standard' }
  | { kind: 'multi_brand'; brands: string[] }
  | { kind: 'best_quality' }
  | { kind: 'view_all' }

function resolveFetchStrategy(state: SessionState): FetchStrategy {
  const brands = state.selected_brands ?? []
  // brand_tier==='all' + có brand cụ thể = marker "khách chọn brand rõ ràng"
  // (KHÁC với brand_tier==='all' + brands rỗng = "xem hết", không tiêu chí gì).
  const isExplicitBrandPick = state.brand_tier === 'all' && brands.length > 0

  if (isExplicitBrandPick && brands.length >= 2 && brands.length <= 3) {
    return { kind: 'multi_brand', brands }
  }
  if (
    state.brand_tier === 'premium' ||
    state.brand_tier === 'balanced' ||
    state.brand_tier === 'budget' ||
    isExplicitBrandPick // 1 hãng, hoặc ≥4 hãng → flat top (không đổi)
  ) {
    return { kind: 'standard' }
  }
  if (state.wants_best_quality) return { kind: 'best_quality' }
  if (state.brand_tier === 'all' && brands.length === 0)
    return { kind: 'view_all' }
  // Chỉ có max_price (không brand/tier/tốt nhất nào) → standard với
  // brandFilter='__skip_brand__' + price filter (đã threading sẵn ở trên).
  return { kind: 'standard' }
}

/**
 * Cascade "tốt nhất": thử LẦN LƯỢT xã→(premium→balanced→budget→all), rồi mới
 * tới tỉnh→(premium→balanced→budget→all) — DỪNG ở tổ hợp đầu tiên có kết quả.
 * Đúng thứ tự người dùng đã chốt: ưu tiên hết các phân khúc trong PHẠM VI xã
 * trước khi rơi xuống phạm vi tỉnh.
 */
async function fetchBestQualityCascade(
  tireSize: string,
  state: SessionState
): Promise<{ cards: SpGaraCard[]; usedFallbackProvince: boolean }> {
  const wardCode = state.ward_code ?? null
  const provinceCode =
    state.province_code ?? (wardCode ? getWardParentCode(wardCode) : null)
  const maxFinalPriceFloor = state.max_price ?? undefined

  const locations: Array<{
    wardCode: string | null
    provinceCode: string | null
    isWard: boolean
  }> = []
  if (wardCode) locations.push({ wardCode, provinceCode: null, isWard: true })
  if (provinceCode)
    locations.push({ wardCode: null, provinceCode, isWard: false })

  for (const loc of locations) {
    for (const tier of TIER_CASCADE_ORDER) {
      const brandFilter =
        tier === 'all' ? '__skip_brand__' : BRAND_TIERS[tier].brands.join('|')
      const cards = await fetchSpGaraCards({
        tireSize,
        tireBrand: brandFilter,
        provinceCode: loc.provinceCode,
        wardCode: loc.wardCode,
        limit: 3,
        sortBy: 'lowest_price',
        maxFinalPriceFloor
      })
      console.log(
        `[V3 cascade best] loc=${loc.isWard ? `ward:${loc.wardCode}` : `province:${loc.provinceCode}`} tier=${tier} → ${cards.length} cards`
      )
      if (cards.length > 0) {
        return { cards, usedFallbackProvince: !loc.isWard && !!wardCode }
      }
    }
  }
  return { cards: [], usedFallbackProvince: false }
}

/**
 * Cascade "xem hết": lấy 1 SP rẻ nhất từ MỖI phân khúc premium/balanced/budget
 * đang có hàng (mỗi phân khúc tự thử xã→tỉnh riêng, KHÔNG dừng sớm như "tốt
 * nhất" — thử đủ cả 3 phân khúc), cap tổng 3 card. Nếu cả 3 phân khúc đều
 * trống (kể cả sau fallback tỉnh) → thử thêm 1 bước bỏ lọc brand hoàn toàn để
 * tránh trả về tay không dù catalog vẫn còn hàng ngoài 3 phân khúc chuẩn.
 */
async function fetchViewAllCascade(
  tireSize: string,
  state: SessionState
): Promise<{ cards: SpGaraCard[]; usedFallbackProvince: boolean }> {
  const wardCode = state.ward_code ?? null
  const provinceCode =
    state.province_code ?? (wardCode ? getWardParentCode(wardCode) : null)
  const maxFinalPriceFloor = state.max_price ?? undefined
  const tiers: Array<'premium' | 'balanced' | 'budget'> = [
    'premium',
    'balanced',
    'budget'
  ]

  const collected: SpGaraCard[] = []
  let usedFallbackProvince = false

  for (const tier of tiers) {
    const brandFilter = BRAND_TIERS[tier].brands.join('|')
    let cards: SpGaraCard[] = []
    if (wardCode) {
      cards = await fetchSpGaraCards({
        tireSize,
        tireBrand: brandFilter,
        provinceCode: null,
        wardCode,
        limit: 1,
        sortBy: 'lowest_price',
        maxFinalPriceFloor
      })
    }
    if (cards.length === 0 && provinceCode) {
      cards = await fetchSpGaraCards({
        tireSize,
        tireBrand: brandFilter,
        provinceCode,
        wardCode: null,
        limit: 1,
        sortBy: 'lowest_price',
        maxFinalPriceFloor
      })
      if (cards.length > 0 && wardCode) usedFallbackProvince = true
    }
    if (cards.length > 0) collected.push(cards[0])
    console.log(
      `[V3 cascade viewAll] tier=${tier} → ${cards.length > 0 ? 1 : 0} card`
    )
  }

  if (collected.length === 0) {
    let cards: SpGaraCard[] = []
    if (wardCode) {
      cards = await fetchSpGaraCards({
        tireSize,
        tireBrand: '__skip_brand__',
        provinceCode: null,
        wardCode,
        limit: 3,
        sortBy: 'lowest_price',
        maxFinalPriceFloor
      })
    }
    if (cards.length === 0 && provinceCode) {
      cards = await fetchSpGaraCards({
        tireSize,
        tireBrand: '__skip_brand__',
        provinceCode,
        wardCode: null,
        limit: 3,
        sortBy: 'lowest_price',
        maxFinalPriceFloor
      })
      if (cards.length > 0 && wardCode) usedFallbackProvince = true
    }
    console.log(
      `[V3 cascade viewAll] cả 3 phân khúc trống → all-brand fallback → ${cards.length} cards`
    )
    collected.push(...cards)
  }

  return { cards: collected.slice(0, 3), usedFallbackProvince }
}

/**
 * Render kết quả cascade ("tốt nhất" / "xem hết") — tái dùng buildSpGaraCard
 * (đã có sẵn nút "Xem loại lốp khác" trên mỗi card) + luồng no-result/CSKH
 * giống showSpGaraResults, chỉ khác nguồn cards đến từ cascade thay vì query
 * đơn lẻ có 3-bước fallback.
 */
async function showCascadeResults(
  psid: string,
  sessionId: string,
  pageId: string,
  state: SessionState,
  updatedFields: FieldKey[],
  kind: 'best_quality' | 'view_all'
): Promise<void> {
  const tireSize = state.tire_size ?? ''
  const wardCode = state.ward_code ?? null
  const provinceCode = state.province_code ?? null
  const locationLabel = state.ward_name
    ? `${state.ward_name}${state.province_name ? `, ${state.province_name}` : ''}`
    : (state.province_name ?? '')

  if (!wardCode && !provinceCode) {
    console.warn(`[V3 cascade] no ward/province → cskhHandoff`)
    await cskhHandoff(
      psid,
      sessionId,
      state,
      'State thiếu ward/province khi fetch (cascade)'
    )
    return
  }

  try {
    const { cards, usedFallbackProvince } =
      kind === 'best_quality'
        ? await fetchBestQualityCascade(tireSize, state)
        : await fetchViewAllCascade(tireSize, state)

    const head = buildSummaryHead(state, updatedFields)

    if (cards.length === 0) {
      const msg1 = head
        ? `${head}\n\nBên em sẽ gửi thông tin sản phẩm sớm nhất tới anh/chị 😊`
        : 'Em đã nhận thông tin ạ 🙏\n\nBên em sẽ gửi thông tin sản phẩm sớm nhất tới anh/chị 😊'
      await updateSession(sessionId, {
        step: 'AWAITING_PHONE',
        state: {
          ...state,
          cskh_reason: `Không có gara cho size ${tireSize} (cascade ${kind}) ở ${locationLabel}`
        }
      })
      await reply(psid, sessionId, msg1)
      await delay(REPLY_GAP_MS)
      await reply(
        psid,
        sessionId,
        'Hoặc để được hỗ trợ mình nhanh hơn, anh/chị vui lòng để lại số điện thoại ạ 😊'
      )
      return
    }

    const msgFound = buildSearchIntro(state)
    await reply(psid, sessionId, msgFound)
    await delay(REPLY_GAP_MS)
    const displayLabel = usedFallbackProvince
      ? (state.province_name ?? locationLabel)
      : locationLabel
    await sendCards(
      psid,
      sessionId,
      cards.map(buildSpGaraCard),
      `${cards.length} SP+gara ở ${displayLabel} (${kind}${usedFallbackProvince ? ', ward fallback' : ''})`
    )

    // "Xem hết" (view_all, không tiêu chí brand cụ thể) → thêm nút [Xem tất
    // cả] BÊN DƯỚI 3 card, dẫn về trang /lop chung lọc theo kích cỡ (không
    // giới hạn 3 phân khúc như trên) — theo yêu cầu spec riêng cho case này.
    if (kind === 'view_all' && tireSize) {
      await delay(REPLY_GAP_MS)
      await sendButtonTemplate(
        psid,
        sessionId,
        'Anh/chị có thể xem thêm các lựa chọn khác tại đây ạ 😊',
        [
          {
            type: 'web_url',
            title: QR_TITLE.BRAND_ALL,
            url: withUtm(
              `${TROLYOTO_URL}/lop?page=1&size=${encodeURIComponent(tireSize)}`,
              'view_all'
            )
          }
        ],
        'Xem tất cả (view_all)'
      )
    }

    const shownCodes = cards
      .map(c => c.garageCode)
      .filter((c): c is string => !!c)
    const minPrice = Math.min(...cards.map(c => c.finalPrice))

    await updateSession(sessionId, {
      step: 'SHOWING_RESULTS_LOCAL',
      is_active: true,
      state: {
        ...state,
        shown_garage_codes: shownCodes,
        shown_garage_min_price: minPrice,
        shown_national: false,
        has_shown_results: true
      }
    })

    scheduleTimer(
      sessionId,
      NUDGE_HELP_MS,
      () => promptHelpAndBooking(psid, sessionId, pageId),
      'v3-help-15s'
    )
  } catch (err) {
    console.error('[V3 flow] showCascadeResults:', err)
    await reply(
      psid,
      sessionId,
      'Xin lỗi, có lỗi khi tìm sản phẩm/đại lý. Vui lòng thử lại sau ạ 😊'
    )
  }
}

/**
 * Fetch riêng từng hãng (2-3 hãng khách nêu) — mỗi hãng tự có ward→province
 * fallback riêng. Hãng nào 0 kết quả → im lặng bỏ qua (đã chốt thiết kế).
 */
async function fetchMultiBrandResults(
  tireSize: string,
  state: SessionState
): Promise<
  Array<{ brand: string; cards: SpGaraCard[]; usedFallbackProvince: boolean }>
> {
  const wardCode = state.ward_code ?? null
  const provinceCode =
    state.province_code ?? (wardCode ? getWardParentCode(wardCode) : null)
  const maxFinalPriceFloor = state.max_price ?? undefined
  const brands = state.selected_brands ?? []

  const results: Array<{
    brand: string
    cards: SpGaraCard[]
    usedFallbackProvince: boolean
  }> = []

  for (const brand of brands) {
    let cards: SpGaraCard[] = []
    if (wardCode) {
      cards = await fetchSpGaraCards({
        tireSize,
        tireBrand: brand,
        provinceCode: null,
        wardCode,
        limit: 3,
        sortBy: 'lowest_price',
        maxFinalPriceFloor
      })
    }
    let usedFallbackProvince = false
    if (cards.length === 0 && provinceCode) {
      cards = await fetchSpGaraCards({
        tireSize,
        tireBrand: brand,
        provinceCode,
        wardCode: null,
        limit: 3,
        sortBy: 'lowest_price',
        maxFinalPriceFloor
      })
      usedFallbackProvince = !!wardCode
    }
    console.log(`[V3 multiBrand] brand=${brand} → ${cards.length} cards`)
    if (cards.length > 0) {
      results.push({ brand, cards, usedFallbackProvince })
    }
  }
  return results
}

/**
 * Hiển thị kết quả đa thương hiệu (2-3 hãng) — mỗi hãng 1 dòng text tên hãng +
 * 1 carousel riêng, gửi TUẦN TỰ (delay REPLY_GAP_MS giữa các tin để FB không
 * đảo thứ tự). Toàn bộ hãng không có hàng nào → coi như no-result chung.
 */
async function showMultiBrandResults(
  psid: string,
  sessionId: string,
  pageId: string,
  state: SessionState,
  updatedFields: FieldKey[]
): Promise<void> {
  const tireSize = state.tire_size ?? ''
  const wardCode = state.ward_code ?? null
  const provinceCode = state.province_code ?? null
  const locationLabel = state.ward_name
    ? `${state.ward_name}${state.province_name ? `, ${state.province_name}` : ''}`
    : (state.province_name ?? '')

  if (!wardCode && !provinceCode) {
    console.warn(`[V3 multiBrand] no ward/province → cskhHandoff`)
    await cskhHandoff(
      psid,
      sessionId,
      state,
      'State thiếu ward/province khi fetch (multi-brand)'
    )
    return
  }

  try {
    const results = await fetchMultiBrandResults(tireSize, state)
    const head = buildSummaryHead(state, updatedFields)

    if (results.length === 0) {
      const msg1 = head
        ? `${head}\n\nBên em sẽ gửi thông tin sản phẩm sớm nhất tới anh/chị 😊`
        : 'Em đã nhận thông tin ạ 🙏\n\nBên em sẽ gửi thông tin sản phẩm sớm nhất tới anh/chị 😊'
      await updateSession(sessionId, {
        step: 'AWAITING_PHONE',
        state: {
          ...state,
          cskh_reason: `Không có gara cho size ${tireSize} ở các hãng ${(state.selected_brands ?? []).join(', ')} tại ${locationLabel}`
        }
      })
      await reply(psid, sessionId, msg1)
      await delay(REPLY_GAP_MS)
      await reply(
        psid,
        sessionId,
        'Hoặc để được hỗ trợ mình nhanh hơn, anh/chị vui lòng để lại số điện thoại ạ 😊'
      )
      return
    }

    const msgFound = buildSearchIntro(state)
    await reply(psid, sessionId, msgFound)
    await delay(REPLY_GAP_MS)

    const allShownCodes: string[] = []
    const allPrices: number[] = []
    for (let i = 0; i < results.length; i++) {
      const { brand, cards, usedFallbackProvince } = results[i]
      const displayLabel = usedFallbackProvince
        ? (state.province_name ?? locationLabel)
        : locationLabel
      await reply(psid, sessionId, `🔹 ${brand}`)
      await sendCards(
        psid,
        sessionId,
        cards.map(buildSpGaraCard),
        `${cards.length} SP+gara ${brand} ở ${displayLabel}${usedFallbackProvince ? ' (ward fallback)' : ''}`
      )
      allShownCodes.push(
        ...cards.map(c => c.garageCode).filter((c): c is string => !!c)
      )
      allPrices.push(...cards.map(c => c.finalPrice))
      if (i < results.length - 1) await delay(REPLY_GAP_MS)
    }

    const minPrice = allPrices.length > 0 ? Math.min(...allPrices) : undefined

    await updateSession(sessionId, {
      step: 'SHOWING_RESULTS_LOCAL',
      is_active: true,
      state: {
        ...state,
        shown_garage_codes: allShownCodes,
        shown_garage_min_price: minPrice,
        shown_national: false,
        has_shown_results: true
      }
    })

    scheduleTimer(
      sessionId,
      NUDGE_HELP_MS,
      () => promptHelpAndBooking(psid, sessionId, pageId),
      'v3-help-15s'
    )
  } catch (err) {
    console.error('[V3 flow] showMultiBrandResults:', err)
    await reply(
      psid,
      sessionId,
      'Xin lỗi, có lỗi khi tìm sản phẩm/đại lý. Vui lòng thử lại sau ạ 😊'
    )
  }
}

/**
 * ĐIỂM VÀO DUY NHẤT để hiển thị kết quả sau khi đủ 3 field — mọi call site cũ
 * gọi showSpGaraResults trực tiếp phải đổi sang gọi hàm này để tự động dispatch
 * đúng chiến lược (chuẩn / đa thương hiệu / cascade tốt-nhất / cascade xem-hết).
 */
async function dispatchAndShowResults(
  psid: string,
  sessionId: string,
  pageId: string,
  state: SessionState,
  updatedFields: FieldKey[]
): Promise<void> {
  const strategy = resolveFetchStrategy(state)
  console.log(`[V3 dispatch] strategy=${strategy.kind}`)
  if (strategy.kind === 'multi_brand') {
    await showMultiBrandResults(psid, sessionId, pageId, state, updatedFields)
    return
  }
  if (strategy.kind === 'best_quality' || strategy.kind === 'view_all') {
    await showCascadeResults(
      psid,
      sessionId,
      pageId,
      state,
      updatedFields,
      strategy.kind
    )
    return
  }
  await showSpGaraResults(psid, sessionId, pageId, state, updatedFields)
}

async function promptHelpAndBooking(
  psid: string,
  sessionId: string,
  pageId: string
): Promise<void> {
  const sess = await getLatestSession(psid, pageId)
  if (!sess || sess.id !== sessionId) {
    console.log(`[V3 nudge] help-15s SKIP no-matching session=${sessionId}`)
    return
  }
  if (!sess.is_active || sess.is_paused_by_cskh) {
    console.log(`[V3 nudge] help-15s SKIP inactive/paused session=${sessionId}`)
    return
  }
  if (sess.step !== 'SHOWING_RESULTS_LOCAL') {
    console.log(`[V3 nudge] help-15s SKIP step-changed step=${sess.step}`)
    return
  }
  console.log(`[V3 nudge] help-15s SEND session=${sessionId}`)
  await Promise.all([
    updateSession(sessionId, { step: 'AWAITING_BOOKING_STATE' }),
    reply(
      psid,
      sessionId,
      'Anh chị cần TROLYoto hỗ trợ thêm gì để chọn lốp ưng ý không ạ 😊',
      [
        qr(QR_TITLE.BOOK_DONE, 'QR_BOOK_DONE'),
        qr(QR_TITLE.NOT_YET, 'QR_NOT_YET'),
        qr(QR_TITLE.CONCERN, 'QR_CONCERN')
      ]
    )
  ])
  scheduleTimer(
    sessionId,
    NUDGE_BOOKING_MS,
    () => nudgeBookingToConcern(psid, sessionId, pageId),
    'v3-concern-45s'
  )
}

async function nudgeBookingToConcern(
  psid: string,
  sessionId: string,
  pageId: string
): Promise<void> {
  const sess = await getLatestSession(psid, pageId)
  if (!sess || sess.id !== sessionId) return
  if (!sess.is_active || sess.is_paused_by_cskh) return
  if (sess.step !== 'AWAITING_BOOKING_STATE') return
  console.log(`[V3 nudge] concern-45s SEND session=${sessionId}`)
  await promptConcern(psid, sessionId, sess.state)
}

// ════════════════════════════════════════════════════════════════════════════
//  Nudge "thiếu thông tin" — khách im lặng khi bot đang hỏi size/brand/location
//  90s: nhắc + hỏi lại field thiếu. +60s tiếp (vẫn im lặng): 2 tin mời "trợ giá
//  khi cần". CHỈ 1 LẦN / session (state.info_nudge_sent) — dùng slot rồi thì
//  dù khách quay lại trả lời rồi lại im lặng tiếp cũng KHÔNG lặp lại kịch bản.
// ════════════════════════════════════════════════════════════════════════════

/** Nhãn field thiếu cho câu nhắc — dùng chung deriveLastAsked (size→brand→location). */
function missingFieldLabel(
  state: SessionState
): 'kích cỡ nào' | 'thương hiệu nào' | 'khu vực nào' | null {
  const asking = deriveLastAsked(state)
  if (asking === 'size') return 'kích cỡ nào'
  if (asking === 'brand') return 'thương hiệu nào'
  if (asking === 'location') return 'khu vực nào'
  return null
}

/**
 * Gọi ở CUỐI mỗi nhánh mà bot vừa hỏi khách 1 field còn thiếu (size/brand/
 * location) — cả từ AI gather turn lẫn car-size options lẫn fail-retry.
 * Fire-and-forget (không await ở call site) — chỉ schedule, không chặn reply.
 */
function maybeScheduleInfoNudge(
  psid: string,
  sessionId: string,
  pageId: string,
  state: SessionState
): void {
  if (state.info_nudge_sent) return // slot 1 lần/session đã dùng
  if (!missingFieldLabel(state)) return // đã đủ field, không cần nhắc

  scheduleTimer(
    sessionId,
    NUDGE_INFO_STAGE1_MS,
    () => fireInfoNudgeStage1(psid, sessionId, pageId),
    'v3-info-nudge-90s'
  )
}

async function fireInfoNudgeStage1(
  psid: string,
  sessionId: string,
  pageId: string
): Promise<void> {
  // Re-fetch để tránh race: khách vừa trả lời ngay trước khi timer fire.
  const sess = await getActiveSession(psid, pageId)
  if (!sess || sess.id !== sessionId) return
  if (!sess.is_active || sess.is_paused_by_cskh) return
  if (sess.state.info_nudge_sent) return // đã dùng slot (đề phòng race đúp lịch)
  const missing = missingFieldLabel(sess.state)
  if (!missing) {
    console.log(
      `[V3 nudge] info-90s SKIP session=${sessionId} (đã đủ field trong lúc chờ)`
    )
    return
  }

  console.log(
    `[V3 nudge] info-90s SEND session=${sessionId} missing="${missing}"`
  )
  const newState: SessionState = { ...sess.state, info_nudge_sent: true }
  await Promise.all([
    updateSession(sessionId, { state: newState }),
    reply(
      psid,
      sessionId,
      `TRỢ GIÁ tới 800K đã sẵn sàng cho mình ạ!\nAnh/chị muốn tìm ${missing} để TROLYoto giúp mình tìm sản phẩm phù hợp ngay ạ 😊`,
      undefined,
      true // hiddenFromAi — nudge tự động theo timer, số "800K" là trợ giá hệ
      // thống chứ KHÔNG phải mức giá khách yêu cầu (nguồn gốc bug AI hiểu
      // nhầm "Giá cao quá" → max_price=800000).
    )
  ])

  // Giai đoạn 2: +60s tiếp theo nếu vẫn im lặng.
  scheduleTimer(
    sessionId,
    NUDGE_INFO_STAGE2_MS,
    () => fireInfoNudgeStage2(psid, sessionId, pageId),
    'v3-info-nudge-60s'
  )
}

async function fireInfoNudgeStage2(
  psid: string,
  sessionId: string,
  pageId: string
): Promise<void> {
  const sess = await getActiveSession(psid, pageId)
  if (!sess || sess.id !== sessionId) return
  if (!sess.is_active || sess.is_paused_by_cskh) return
  if (!missingFieldLabel(sess.state)) {
    console.log(
      `[V3 nudge] info-60s SKIP session=${sessionId} (đã đủ field trong lúc chờ)`
    )
    return
  }

  console.log(`[V3 nudge] info-60s SEND session=${sessionId}`)
  await sendButtonTemplate(
    psid,
    sessionId,
    '😊 Hoặc anh/chị có thể chủ động nhận thêm trợ giá bất cứ lúc nào từ TROLYoto khi có nhu cầu bằng cách chọn tab dưới đây',
    [
      { type: 'web_url', title: QR_TITLE.COMMUNITY_SUBSIDY, url: COMMUNITY_URL }
    ],
    'Info-nudge stage2'
  )
  // await delay(REPLY_GAP_MS)
  // await reply(
  //   psid,
  //   sessionId,
  //   '😊 Cảm ơn anh/chị đã tin tưởng TROLYoto.\nKhi cần thay lốp hoặc chăm xe, TROLYoto luôn sẵn sàng hỗ trợ mình ạ!'
  // )
}

// ════════════════════════════════════════════════════════════════════════════
//  Booking / Concern / CSKH (giữ wording y V2)
// ════════════════════════════════════════════════════════════════════════════

async function handleBookingState(
  psid: string,
  sessionId: string,
  payload: string,
  state: SessionState
): Promise<void> {
  console.log(`[V3 handler] handleBookingState payload=${payload}`)
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
  console.log(`[V3 handler] handleConcern payload=${payload}`)
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
    // V3: chuyển thẳng cskhHandoff (2 tin text, không QR)
    await cskhHandoff(psid, sessionId, state, 'Khách muốn gara gần/tiện hơn')
  }
}

/**
 * V3 cskhHandoff: gửi 2 tin nhắn text (không QR), đặt step AWAITING_PHONE.
 * Tin tiếp theo của khách (phone hoặc khác) sẽ end-permanent (pause-by-cskh).
 *
 * @param mode  'default' = chuyển CSKH chung; 'no_product' = không có SP/gara.
 *               Khác nhau ở tin nhắn ĐẦU TIÊN.
 */
async function cskhHandoff(
  psid: string,
  sessionId: string,
  state: SessionState,
  reason: string,
  mode: 'default' | 'no_product' = 'default'
): Promise<void> {
  console.log(
    `[V3] cskhHandoff session=${sessionId} mode=${mode} reason=${reason}`
  )
  cancelTimer(sessionId, 'v3-cskh-handoff')
  await updateSession(sessionId, {
    step: 'AWAITING_PHONE',
    state: { ...state, cskh_reason: reason }
  })

  const workHours = isWorkingHours()
  const msg1 =
    mode === 'no_product'
      ? 'Em đã nhận thông tin ạ 🙏\n\nBên em sẽ gửi thông tin sản phẩm sớm nhất tới anh/chị 😊'
      : workHours
        ? 'Em đã nhận thông tin ạ 🙏\n\nBên em sẽ hỗ trợ anh/chị sớm nhất có thể ạ 😊'
        : 'Em đã nhận thông tin ạ 🙏\n\nBên em sẽ hỗ trợ mình ngay vào buổi làm việc kế tiếp 😊\n(9h–18h từ T2–T6)'

  await reply(psid, sessionId, msg1)
  await delay(REPLY_GAP_MS)
  await reply(
    psid,
    sessionId,
    'Hoặc để được hỗ trợ mình nhanh hơn, anh/chị vui lòng để lại số điện thoại ạ 😊'
  )
}

/**
 * V3 handlePhoneInput: nhận text bất kỳ ở step AWAITING_PHONE.
 * - Có phone → ack có số
 * - Không phone → ack đã ghi nhận
 * Cả 2 case: end-permanent (is_paused_by_cskh=true). Bot stay silent vĩnh viễn
 * cho PSID này — giống CSKH thực tế đã vào nhắn.
 */
async function handlePhoneInput(
  psid: string,
  sessionId: string,
  text: string,
  state: SessionState
): Promise<void> {
  const phone = extractPhone(text)
  const workHours = isWorkingHours()
  let ackText: string
  if (phone) {
    ackText = workHours
      ? `Bên em đã nhận được số điện thoại ${phone} ạ 🙏\n\nChuyên viên TROLYoto sẽ liên hệ anh/chị sớm nhất có thể ạ 😊`
      : `Bên em đã nhận được số điện thoại ${phone} ạ 🙏\n\nChuyên viên TROLYoto sẽ liên hệ anh/chị vào buổi làm việc kế tiếp ạ 😊\n⏰ 9h–18h từ T2–T6`
  } else {
    ackText = workHours
      ? 'Em đã ghi nhận thông tin ạ 🙏\n\nChuyên viên TROLYoto sẽ liên hệ hỗ trợ anh/chị sớm nhất có thể ạ 😊'
      : 'Em đã ghi nhận thông tin ạ 🙏\n\nChuyên viên TROLYoto sẽ liên hệ hỗ trợ anh/chị vào buổi làm việc kế tiếp ạ 😊\n⏰ 9h–18h từ T2–T6'
  }

  await reply(psid, sessionId, ackText)
  await updateSession(sessionId, {
    step: 'PAUSED_BY_CSKH',
    state: { ...state, phone: phone ?? state.phone },
    is_active: false,
    is_paused_by_cskh: true
  })
}

// ════════════════════════════════════════════════════════════════════════════
//  Main dispatcher
// ════════════════════════════════════════════════════════════════════════════

export async function handleMessengerEventV3(
  event: MessengerEvent,
  pageId: string
): Promise<void> {
  return requestContext.run({ token: tokenForPageId(pageId), pageId }, () =>
    handleMessengerEventV3Inner(event, pageId)
  )
}

/** Log mô tả ngắn loại event để debug entry points. */
function describeEvent(event: MessengerEvent): string {
  if (event.message?.is_echo) {
    return `echo(app_id=${event.message.app_id ?? 'null'})`
  }
  if (event.optin) {
    return `OPTIN(ref="${event.optin.ref ?? ''}" type="${event.optin.type ?? ''}")`
  }
  if (event.referral) {
    return `REFERRAL(source="${event.referral.source ?? ''}" type="${event.referral.type ?? ''}" ad_id="${event.referral.ad_id ?? ''}" ref="${event.referral.ref ?? ''}")`
  }
  if (event.message?.quick_reply) {
    return `QR_CLICK(payload="${event.message.quick_reply.payload}" title="${event.message.text ?? ''}")`
  }
  if (event.postback) {
    return `POSTBACK(payload="${event.postback.payload}" title="${event.postback.title ?? ''}")`
  }
  if (event.message?.attachments?.length) {
    const types = event.message.attachments.map(a => a.type).join(',')
    return `ATTACHMENT(${types})`
  }
  if (event.message?.text) {
    return `TEXT("${event.message.text.slice(0, 80)}")`
  }
  return 'UNKNOWN'
}

async function handleMessengerEventV3Inner(
  event: MessengerEvent,
  pageId: string
): Promise<void> {
  try {
    const psid = event.sender.id
    console.log(
      `[V3 entry] psid=${psid} pageId=${pageId} → ${describeEvent(event)}`
    )

    // CSKH takeover detection (echo from page admin)
    //  FB gửi `is_echo=true` cho MỌI tin nhắn đi ra từ page (nếu app subscribe
    //  `message_echoes`). Phân biệt qua message.app_id:
    //    - Bot gửi qua API: app_id = FB_APP_ID (bot's app) → BỎ QUA
    //    - Admin reply qua Business Suite: app_id = 263902037430900 (BS app)
    //    - Admin Pages Manager / khác: app_id KHÁC FB_APP_ID
    //  → pause khi app_id khác FB_APP_ID (hoặc khi không có FB_APP_ID env: bỏ
    //  qua mọi echo để tránh bot tự pause — admin takeover sẽ không detect được)
    if (event.message?.is_echo) {
      const echoAppId = event.message.app_id
      // Không có FB_APP_ID env → không phân biệt được → bỏ qua hết để an toàn
      if (!FB_APP_ID) {
        console.log(
          `[V3] echo received (app_id=${echoAppId}) but FB_APP_ID env not set — skip (set env to enable CSKH detect)`
        )
        return
      }
      // Bot tự gửi → ignore
      if (echoAppId && String(echoAppId) === FB_APP_ID) {
        console.log(`[V3] echo from bot self (app_id=${echoAppId}) → ignore`)
        return
      }
      // Admin reply (app_id khác hoặc không có) → pause
      const recipientPsid = event.recipient.id
      const activeSession = await getActiveSession(recipientPsid, pageId)
      if (activeSession && !activeSession.is_paused_by_cskh) {
        cancelTimer(activeSession.id, 'v3-cskh-takeover')
        await pauseSessionByCskh(activeSession.id)
        appendConversationLog(activeSession.id, {
          role: 'system',
          type: 'system',
          text: `[V3 bot paused by CSKH reply (admin app_id=${echoAppId})]`,
          ts: new Date().toISOString()
        }).catch(e => console.error('[V3 log]', e))
        console.log(
          `[V3] Bot paused for psid=${recipientPsid} by CSKH (admin app_id=${echoAppId})`
        )
      }
      return
    }

    if (psid === pageId) return

    // Skip non-actionable events (delivery/read)
    const hasAttachment = !!event.message?.attachments?.length
    const isActionable = !!(
      event.message?.text ||
      event.message?.quick_reply ||
      hasAttachment ||
      event.postback ||
      event.optin ||
      event.referral
    )
    if (!isActionable) return

    // Typing + seen sớm
    sendTypingOn(psid, currentToken()).catch(e =>
      console.error('[V3 typing-early]', e)
    )
    markSeen(psid, currentToken()).catch(e => console.error('[V3 markSeen]', e))

    // /reset — bypass MỌI guard (kể cả paused-by-cskh) để dễ test.
    // Phải check ở ĐÂY, trước khi getActiveSession check pause.
    if (event.message?.text?.trim() === '/reset') {
      console.log(`[V3 flow] /reset psid=${psid} — wipe all sessions + welcome`)
      await resetUserSessions(psid, pageId)
      const fresh = await createSession(psid, pageId)
      await updateSession(fresh.id, { step: 'V3_GATHERING' })
      await sendV3Welcome(psid, fresh.id)
      await delay(REPLY_GAP_MS)
      await reply(
        psid,
        fresh.id,
        'Em đã reset cuộc trò chuyện ạ 🔄\n\nAnh/chị cho em biết kích cỡ lốp + thương hiệu mong muốn nhé 😊'
      )
      return
    }

    let session: FbSession | null = await getActiveSession(psid, pageId)
    if (session?.is_paused_by_cskh) return

    let messageText = event.message?.text?.trim() ?? ''
    const payload =
      event.message?.quick_reply?.payload ?? event.postback?.payload ?? ''
    // Image attachment: BỎ QUA sticker (like 👍, emoji, sticker FB). Đặc điểm:
    //   - Có attachment type='sticker', HOẶC
    //   - Type='image' nhưng có field sticker_id trong payload
    // Chỉ lấy URL khi là ảnh thật khách upload từ điện thoại.
    const attachments = event.message?.attachments ?? []
    const hasSticker = attachments.some(
      a => a.type === 'sticker' || !!a.payload?.sticker_id
    )
    const realImage = attachments.find(
      a => a.type === 'image' && !a.payload?.sticker_id
    )
    const imageUrl = hasSticker ? undefined : realImage?.payload?.url
    /** Khách CHỈ gửi sticker (không có text/payload/image thật). Không bump fail
     *  counter, không chạy AI gather — re-ask theo field đang chờ là đủ. */
    const isStickerOnly = hasSticker && !messageText && !payload && !realImage

    const latest = session ? null : await getLatestSession(psid, pageId)
    if (!session && latest?.is_paused_by_cskh) return

    // optin/referral (Get Started / ad click / m.me link) → CHỈ tạo session, IM LẶNG.
    //  Ad creative đã có "welcome message" tự bắn rồi → bot không cần chào nữa.
    //  Tin đầu tiên khách gửi sẽ vào V3_GATHERING: AI tự thu thập size/brand/xe;
    //  nếu là FAQ (ở đâu, có phải bot, đặt online...) → AI trả lời FAQ;
    //  nếu AI không trích được gì + không phải FAQ → mới hỏi lại kích cỡ.
    if (event.optin || event.referral) {
      const entryKind = event.optin
        ? `OPTIN (ref="${event.optin.ref ?? ''}")`
        : `REFERRAL (source=${event.referral?.source} type=${event.referral?.type} ad_id=${event.referral?.ad_id ?? 'n/a'} ref="${event.referral?.ref ?? ''}")`
      if (!session) {
        session = await createSession(psid, pageId)
        await updateSession(session.id, { step: 'V3_GATHERING' })
        console.log(
          `[V3 entry] ${entryKind} → NEW session ${session.id} (silent, chờ khách nhắn)`
        )
      } else {
        console.log(
          `[V3 entry] ${entryKind} → EXISTING session ${session.id} (silent)`
        )
      }
      return
    }

    if (!session) {
      // Lần đầu khách nhắn → tạo session step=V3_GATHERING IM LẶNG.
      //  KHÔNG gửi welcome ở đây — chỉ gửi khi AI không xử lý được tin (fallback).
      //  Mọi tin extract được info / FAQ → AI trả lời thẳng, không cần intro.
      session = await createSession(psid, pageId)
      await updateSession(session.id, { step: 'V3_GATHERING' })
      session = { ...session, step: 'V3_GATHERING' }
    }

    const { step, state } = session

    // Log user msg
    if (messageText || payload || imageUrl) {
      appendConversationLog(session.id, {
        role: 'user',
        type: payload ? 'qr_click' : 'text',
        text:
          messageText ||
          (imageUrl
            ? `[image: ${imageUrl.slice(0, 60)}...]`
            : `[click: ${payload}]`),
        ts: new Date().toISOString(),
        ...(payload ? { payload } : {})
      }).catch(e => console.error('[V3 log user]', e))
    }

    // ── Image attachment → handleImage ──────────────────────────────────
    if (imageUrl) {
      await handleImage(psid, session, pageId, imageUrl)
      return
    }

    // ── Sticker-only (like 👍, emoji) — không phải input thật ───────────
    //  Re-ask theo field đang chờ; KHÔNG bump fail counter (sticker ≠ "fail hiểu").
    if (isStickerOnly) {
      appendConversationLog(session.id, {
        role: 'user',
        type: 'text',
        text: '[sticker]',
        ts: new Date().toISOString()
      }).catch(e => console.error('[V3 log sticker]', e))
      const nextQ = nextMissingFieldQuestion(session.state)
      console.log(
        `[V3 flow] sticker-only → re-ask field "${deriveLastAsked(session.state) ?? 'none'}" (no fail bump)`
      )
      if (nextQ) {
        const needBrand =
          !!session.state.tire_size && !hasBrandField(session.state)
        await reply(
          psid,
          session.id,
          nextQ,
          needBrand ? V3_BRAND_QRS() : undefined
        )
      }
      // Nếu đã đủ 3 field (nextQ=null) thì không làm gì — bot chờ user thực sự nhắn
      return
    }

    // ── Payload (QR/postback) ────────────────────────────────────────────
    if (payload) {
      // Khách chọn 1 size từ list QR (sau khi AI tra theo tên xe)
      if (payload.startsWith('V3_TIRE_SIZE:')) {
        const rawSize = payload.replace('V3_TIRE_SIZE:', '').toUpperCase()
        // Chuẩn hoá — nút gợi ý OEM có thể chứa ký hiệu tốc độ (vd "225/55ZR19")
        // mà catalog lưu dạng không speed-rating ("225/55R19"), giữ nguyên literal
        // sẽ không khớp DB → báo hết hàng oan.
        const size = parseExplicitTireSize(rawSize) ?? rawSize
        console.log(
          `[V3 flow] V3_TIRE_SIZE click → tire_size=${size} (raw="${rawSize}")`
        )
        // Khách đã CHỌN 1 size từ list → coi như tên xe đã resolve đúng, xoá
        // car_model_attempts (tránh tồn đọng ảnh hưởng lần tra xe khác sau này)
        // + last_shown_car_sizes (tránh khớp nhầm "vành X" ở lượt hội thoại sau).
        const newState: SessionState = {
          ...state,
          tire_size: size,
          car_model_attempts: [],
          last_shown_car_sizes: []
        }
        await updateSession(session.id, {
          step: 'V3_GATHERING',
          state: newState
        })
        await handleGathering(
          psid,
          { ...session, state: newState, step: 'V3_GATHERING' },
          pageId,
          size
        )
        return
      }

      // Khách chọn 1 brand cụ thể từ QR (Michelin / Hankook / ...)
      if (payload.startsWith('V3_BRAND_NAME:')) {
        const brand = payload.replace('V3_BRAND_NAME:', '').toUpperCase()
        await handleBrandNameChoice(psid, session, pageId, brand)
        return
      }

      // Khách chọn "Xem tất cả" hoặc click QR tier (legacy compat)
      if (payload.startsWith('V3_BRAND:')) {
        const tier = payload.replace('V3_BRAND:', '') as
          | 'premium'
          | 'balanced'
          | 'budget'
          | 'all'
        await handleBrandTierChoice(psid, session, pageId, tier)
        return
      }

      // Khách chọn ward để xác nhận khu vực
      if (payload.startsWith('V3_WARD:')) {
        const wardCode = payload.replace('V3_WARD:', '')
        await handleWardChoice(psid, session, pageId, wardCode)
        return
      }

      // Khách chọn "Chat tư vấn viên" — chuyển CSKH
      if (payload === 'V3_CHAT_TVV') {
        await cskhHandoff(psid, session.id, state, 'Khách bấm Chat tư vấn viên')
        return
      }
      // V3: bỏ QR_CSKH_HERE/QR_LEAVE_PHONE (cskhHandoff giờ không có QR).
      // Nếu tin cũ vẫn còn → bỏ qua silently.
      if (
        payload === 'QR_BOOK_DONE' ||
        payload === 'QR_NOT_YET' ||
        payload === 'QR_CONCERN'
      ) {
        console.log(`[V3 flow] booking-global payload=${payload} step=${step}`)
        await handleBookingState(psid, session.id, payload, state)
        return
      }
      if (payload === 'QR_BETTER_PRICE' || payload === 'QR_CLOSER_DEALER') {
        console.log(`[V3 flow] concern-global payload=${payload} step=${step}`)
        await handleConcern(psid, session.id, payload, state)
        return
      }
      // V3 không có welcome → các QR_AI_CONSULT/QR_CSKH_CONSULT/... không phát
      // hành; nếu xuất hiện (vd tin cũ) → bỏ qua + log.
      //
      // FB đôi khi thay payload quick-reply bằng metadata quảng cáo khi hội thoại
      // đến từ Click-to-Messenger ad (vd payload={"is_csm":true,"ad_id":...} thay
      // vì "V3_TIRE_SIZE:185/60R15") — không khớp prefix nào ta định nghĩa, nhưng
      // `messageText` (title nút, vd "Kích thước 185/60R15") vẫn đúng nội dung
      // khách chọn. Fallback xử lý như text thường thay vì bỏ qua im lặng — nếu
      // không, field coi như "chưa cung cấp" và bắn nhầm nudge chờ lâu dù khách
      // đã chọn rồi.
      if (!messageText) {
        // quick_reply click → event.message.text đã có title; postback thuần
        // (không có message) thì lấy title từ postback.
        messageText = event.postback?.title?.trim() ?? ''
      }
      console.log(
        `[V3 flow] unhandled payload=${payload} step=${step} → fallback messageText="${messageText}"`
      )
      if (!messageText) return
    }

    // ── Plain text ───────────────────────────────────────────────────────
    if (messageText) {
      // Khách gõ "vành X"/"la zăng X" NGAY SAU khi vừa được show list size
      // theo tên xe (state.last_shown_car_sizes) → lọc CLIENT-SIDE (không
      // qua AI) xuống đúng size khớp đường kính vành trong CHÍNH list DB đã
      // trả về cho xe đó — RE-SHOW list đã lọc qua QR để khách bấm xác nhận,
      // KHÔNG tự gán tire_size dù chỉ lọc còn đúng 1 kết quả (tránh chọn
      // nhầm nếu hiểu sai ý khách — khách vẫn phải bấm 1 lần nữa mới chốt).
      if (state.last_shown_car_sizes && state.last_shown_car_sizes.length > 0) {
        const diameter = parseWheelDiameter(messageText)
        if (diameter != null) {
          const filtered = filterSizesByWheelDiameter(
            state.last_shown_car_sizes,
            diameter
          )
          if (filtered.length > 0) {
            console.log(
              `[V3 flow] wheel diameter=${diameter} từ "${messageText}" → lọc còn ${filtered.length} size (list=${state.last_shown_car_sizes.join(',')})`
            )
            await updateSession(session.id, {
              state: { ...state, last_shown_car_sizes: filtered }
            })
            await showCarSizeOptions(
              psid,
              session.id,
              state.car_model ?? 'này',
              filtered
            )
            return
          }
          console.log(
            `[V3 flow] wheel diameter=${diameter} từ "${messageText}" → KHÔNG khớp size nào (list=${state.last_shown_car_sizes.join(',')})`
          )
          await reply(
            psid,
            session.id,
            `Dạ xe này không có kích cỡ vành ${diameter} ạ, hiện chỉ có: ${state.last_shown_car_sizes.join(', ')}\n\nAnh/chị chọn giúp em 1 trong các kích cỡ trên nhé 😊`,
            state.last_shown_car_sizes.map(s => qr(s, `V3_TIRE_SIZE:${s}`))
          )
          return
        }
      }

      // /reset đã được xử lý SỚM ở đầu dispatcher (bypass paused guard)
      switch (step) {
        case 'AWAITING_PHONE':
          // V3: chỉ kết-thúc-pause khi khách gửi SĐT thật. Tin khác (hỏi off-topic,
          // gửi lại size/brand/location) → tiếp tục handleGathering để khách có thể
          // hỏi/tìm lại sản phẩm.
          if (extractPhone(messageText)) {
            await handlePhoneInput(psid, session.id, messageText, state)
          } else {
            console.log(`[V3 flow] AWAITING_PHONE non-phone → handleGathering`)
            await handleGathering(psid, session, pageId, messageText)
          }
          break

        case 'SHOWING_RESULTS_LOCAL':
          // Khách gửi tin TRONG LÚC đang chờ nudge 15s (`promptHelpAndBooking`)
          // → XỬ LÝ BÌNH THƯỜNG, KHÔNG im lặng bỏ qua — khách có thể đang hỏi
          // câu hỏi thật (vd "lốp sản xuất năm nào", "có SĐT gara không") cần
          // trả lời ngay. Bug thật đã xảy ra: im lặng bỏ tin khách → nudge cũ
          // vẫn fire theo lịch, hỏi 1 câu không liên quan như thể khách chưa
          // nói gì. handleGathering() tự cancelTimer() timer đang chờ (Map
          // key=sessionId, chỉ 1 timer/session) → nudge cũ tự huỷ, không xung
          // đột với tin trả lời mới.
          console.log(
            `[V3 flow] SHOWING_RESULTS_LOCAL → handleGathering session=${session.id}`
          )
          await handleGathering(psid, session, pageId, messageText)
          break

        case 'WELCOME':
        case 'V3_GATHERING':
        case 'AWAITING_BOOKING_STATE':
        case 'AWAITING_CONCERN':
        // Legacy V2 steps — V3 không tạo ra nữa nhưng có thể tồn tại trong DB
        case 'AWAITING_CONSULT_TYPE':
        case 'AWAITING_AREA_FOR_CSKH':
        case 'AWAITING_SIZE_FOR_CSKH':
        default:
          // V3: mọi free-text đi qua AI gather. AI quyết định extract / hỏi /
          // handoff. Không còn welcome / consult-choice cứng.
          await handleGathering(psid, session, pageId, messageText)
          break
      }
    }
  } catch (err) {
    console.error('[V3 flow] handleMessengerEventV3:', err)
  }
}
