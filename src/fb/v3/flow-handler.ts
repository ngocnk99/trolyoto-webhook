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

import { sendMessage, sendTypingOn, markSeen } from '../client'
import {
  getActiveSession,
  getLatestSession,
  createSession,
  updateSession,
  pauseSessionByCskh,
  completeSession,
  resetUserSessions,
  appendConversationLog
} from '../session'
import {
  fetchSpGaraCards,
  resolveProvince,
  getMinPriceForTireSize,
  fetchTireSizesByCarTags,
  type SpGaraCard
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
import { v3GatherTurn, getTireSizesForCar, getCarNameVariants } from '../ai-helper'
import { scheduleTimer, cancelTimer } from '../timers'

const PAGE_TOKEN_V3 = process.env.FB_PAGE_ACCESS_TOKEN_V3!
const TROLYOTO_URL = 'https://trolyoto.com'
const COMMUNITY_URL = 'https://www.facebook.com/groups/748788784953241'

// Timers (giữ y V2)
const NUDGE_HELP_MS = 15_000
const NUDGE_BOOKING_MS = 45_000

// Brand tiers V2 (giữ để map AI brand_tier → brand list lúc query DB)
const BRAND_TIERS = {
  premium: { brands: ['MICHELIN', 'BRIDGESTONE', 'PIRELLI', 'CONTINENTAL', 'TOYO', 'GOODYEAR'] as string[] },
  balanced: { brands: ['HANKOOK', 'YOKOHAMA', 'DUNLOP', 'LAUFENN'] as string[] },
  budget: { brands: ['KUMHO', 'ROADX', 'SAILUN', 'TBB', 'OTANI'] as string[] },
  all: { brands: [] as string[] }
} as const

// QR titles (≤20 ký tự — giống V2 để wording không đổi)
const QR_TITLE = {
  AI_CONSULT: '🤖 Báo giá ngay',
  CSKH_CONSULT: '👤 Tư vấn kĩ',
  AI_CONSULT_LATE: '🤖 Báo giá ngay',
  WAIT_CSKH: '💬 Chờ tư vấn',
  BOOK_DONE: '✅ Đã đặt lịch',
  NOT_YET: '🕐 Chưa cần thay',
  CONCERN: '🤔 Còn băn khoăn',
  BETTER_PRICE: '💰 Giá tốt hơn',
  CLOSER_DEALER: '📍 Đại lý gần hơn',
  CSKH_HERE: '💬 Chờ ở đây',
  LEAVE_PHONE: '📞 Để lại SĐT',
  VIEW_PROMO: '🎁 Xem khuyến mại',
  VIEW_OTHER_GARAGE: 'Xem gara khác',
  VIEW_OTHER_PRODUCT: 'Xem SP khác',
  COMMUNITY_SUBSIDY: 'Trợ giá khi cần',
  COMMUNITY_VOUCHER: 'Nhận voucher 200k'
} as const

function isWorkingHours(): boolean {
  const vnTime = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' })
  )
  const day = vnTime.getDay()
  const hour = vnTime.getHours()
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18
}

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

function brandFilterFromState(state: SessionState): string {
  if (state.selected_brands && state.selected_brands.length > 0) {
    return state.selected_brands.join('|')
  }
  return '__skip_brand__'
}

/** Trả về câu hỏi hardcoded cho field thiếu kế tiếp (size → brand → province). */
function nextMissingFieldQuestion(state: SessionState): string | null {
  if (!state.tire_size) {
    return 'Anh/chị cho TROLY biết kích cỡ lốp nhé ạ? Ví dụ: 185/60R15 😊'
  }
  if (!state.brand_tier && (!state.selected_brands || state.selected_brands.length === 0)) {
    return 'Anh/chị muốn thương hiệu nào ạ — cao cấp, cân bằng, tiết kiệm, hay xem hết? 😊'
  }
  if (!state.province_name) {
    return 'Anh/chị ở khu vực nào để TROLY tìm gara gần ạ? 😊'
  }
  return null
}

/** Lấy lịch sử gần đây từ conversation_log để feed AI ngữ cảnh. */
function recentHistory(
  log: ConversationMessage[] | undefined,
  limit = 6
): Array<{ role: 'bot' | 'user'; text: string }> {
  if (!log || log.length === 0) return []
  return log
    .filter(m => m.role === 'bot' || m.role === 'user')
    .slice(-limit)
    .map(m => ({ role: m.role as 'bot' | 'user', text: m.text }))
}

// ── Send-API wrappers (dùng PAGE_TOKEN_V3) ─────────────────────────────────

async function reply(
  psid: string,
  sessionId: string,
  text: string,
  quickReplies?: QuickReply[]
): Promise<void> {
  sendTypingOn(psid, PAGE_TOKEN_V3).catch(e => console.error('[V3 typing]', e))
  await sendMessage(psid, { text, quick_replies: quickReplies }, PAGE_TOKEN_V3)

  appendConversationLog(sessionId, {
    role: 'bot',
    type: quickReplies && quickReplies.length > 0 ? 'quick_replies' : 'text',
    text,
    ts: new Date().toISOString(),
    quick_replies: quickReplies?.map(q => ({ title: q.title, payload: q.payload }))
  }).catch(e => console.error('[V3 log bot]', e))
}

async function sendButtonTemplate(
  psid: string,
  sessionId: string,
  text: string,
  buttons: Button[],
  context?: string
): Promise<void> {
  sendTypingOn(psid, PAGE_TOKEN_V3).catch(e => console.error('[V3 typing]', e))
  await sendMessage(
    psid,
    {
      attachment: { type: 'template', payload: { template_type: 'button', text, buttons } }
    },
    PAGE_TOKEN_V3
  )
  appendConversationLog(sessionId, {
    role: 'bot',
    type: 'quick_replies',
    text: context ? `${context}: ${text}` : text,
    ts: new Date().toISOString(),
    quick_replies: buttons.map(b => ({ title: b.title, payload: b.payload ?? b.url ?? '' }))
  }).catch(e => console.error('[V3 log button]', e))
}

async function sendCards(
  psid: string,
  sessionId: string,
  elements: GenericElement[],
  context: string
): Promise<void> {
  await sendMessage(
    psid,
    { attachment: { type: 'template', payload: { template_type: 'generic', elements } } },
    PAGE_TOKEN_V3
  )
  const cards: LoggedCard[] = elements.map(el => ({
    title: el.title,
    subtitle: el.subtitle,
    image_url: el.image_url,
    url: el.default_action?.url,
    buttons: el.buttons?.map(b => ({ title: b.title, url: b.url, payload: b.payload }))
  }))
  appendConversationLog(sessionId, {
    role: 'bot',
    type: 'cards',
    text: context,
    ts: new Date().toISOString(),
    cards
  }).catch(e => console.error('[V3 log cards]', e))
}

// Card SP+gara (GIỮ Y V2 — wording không đổi)
function buildSpGaraCard(card: SpGaraCard): GenericElement {
  const productPageUrl = card.productSlug ? `${TROLYOTO_URL}/lop/${card.productSlug}` : undefined
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
    buttons.push({ type: 'web_url', title: QR_TITLE.VIEW_OTHER_GARAGE, url: productPageUrl })
  }
  buttons.push({ type: 'web_url', title: QR_TITLE.VIEW_OTHER_PRODUCT, url: listingUrl })

  return {
    title: `${card.brand} ${card.size}`,
    subtitle,
    ...(card.image ? { image_url: card.image } : {}),
    default_action: { type: 'web_url' as const, url: card.detailUrl },
    buttons
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  V3 Welcome — 2 QR (Báo giá ngay / Tư vấn kĩ) — đồng bộ V2
// ════════════════════════════════════════════════════════════════════════════

async function sendV3Welcome(psid: string, sessionId: string): Promise<void> {
  await reply(
    psid,
    sessionId,
    '🤝 TRỢ LÝ Ô TÔ – TROLYoto rất vui được hỗ trợ anh/chị 😊\n\nAnh/chị muốn:\n• Báo giá ngay → trợ lý ảo (TROLY)\n• Tư vấn kĩ → chuyên viên TROLYoto (9h-18h, T2-T6)',
    [
      qr(QR_TITLE.AI_CONSULT, 'QR_AI_CONSULT'),
      qr(QR_TITLE.CSKH_CONSULT, 'QR_CSKH_CONSULT')
    ]
  )
  await updateSession(sessionId, {
    step: 'AWAITING_CONSULT_TYPE',
    state: {}
  })
}

/** Nhánh AI: tin nhắn đầu ngắn gọn hỏi size + brand (chưa hỏi location). */
async function askInitialGathering(psid: string, sessionId: string): Promise<void> {
  await updateSession(sessionId, { step: 'V3_GATHERING' })
  await reply(
    psid,
    sessionId,
    'Anh/chị cho TROLY biết kích cỡ lốp + thương hiệu mong muốn nhé ạ 😊\n\nVí dụ: "185/60R15, Michelin" hoặc "lốp xe vios, hãng nào cũng được".'
  )
}

async function handleConsultChoice(
  psid: string,
  sessionId: string,
  payload: string,
  state: SessionState
): Promise<void> {
  if (payload === 'QR_AI_CONSULT' || payload === 'QR_AI_CONSULT_LATE') {
    await updateSession(sessionId, { state: { ...state, consult_type: 'AI' } })
    await askInitialGathering(psid, sessionId)
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

// ── Nhánh CSKH (Tư vấn kĩ) — giữ y V2 ──────────────────────────────────────

async function handleAreaForCskh(
  psid: string,
  sessionId: string,
  text: string,
  state: SessionState
): Promise<void> {
  const newState: SessionState = { ...state, area: text }
  if (isWorkingHours()) {
    await updateSession(sessionId, { step: 'AWAITING_SIZE_FOR_CSKH', state: newState })
    await reply(psid, sessionId, 'Anh chị cần tìm lốp kích cỡ như thế nào ạ? 😊')
  } else {
    await updateSession(sessionId, { step: 'AWAITING_CONSULT_TYPE', state: newState })
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
  await Promise.all([
    updateSession(sessionId, {
      step: 'COMPLETED',
      state: { ...state, tire_size: text },
      is_active: false
    }),
    reply(psid, sessionId, 'TROLY đã nhận thông tin & sẽ hỗ trợ anh chị sớm nhất ạ 😊')
  ])
}

// ── Car → sizes lookup (DB tags + AI OEM) ──────────────────────────────────

/**
 * Tra kích cỡ lốp theo tên xe — merge DB exact tags (ưu tiên) + AI OEM sizes.
 * Dedupe case-insensitive, cap 4. Đồng bộ pattern V2.
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
    console.error('[V3 flow] lookupCarSizes:', e)
  }
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
  await reply(
    psid,
    sessionId,
    `Dạ xe ${carName} thường dùng các kích cỡ sau, anh/chị chọn giúp em nhé 😊`,
    capped.map(s => qr(s, `V3_TIRE_SIZE:${s}`))
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
      brand_tier: state.brand_tier as 'premium' | 'balanced' | 'budget' | 'all' | undefined,
      selected_brands: state.selected_brands,
      province_name: state.province_name ?? undefined
    },
    userInput,
    recentHistory: recentHistory(session.conversation_log)
  })

  console.log(
    `[V3 gather] session=${sessionId} action=${decision.action} updates=${JSON.stringify(decision.updates)}`
  )

  // 2. Apply updates
  const newState: SessionState = { ...state }
  if (decision.updates.tire_size) newState.tire_size = decision.updates.tire_size
  if (decision.updates.brand_tier !== undefined && decision.updates.brand_tier !== null) {
    newState.brand_tier = decision.updates.brand_tier
    // Map tier → selected_brands (cho fetchSpGaraCards). Nếu AI cũng nêu brands cụ thể, ưu tiên brands.
    if (!decision.updates.selected_brands || decision.updates.selected_brands.length === 0) {
      newState.selected_brands = [...BRAND_TIERS[decision.updates.brand_tier].brands]
    }
  }
  if (decision.updates.selected_brands && decision.updates.selected_brands.length > 0) {
    newState.selected_brands = decision.updates.selected_brands
    // Nếu AI cung cấp brands cụ thể mà chưa có tier → đoán tier hoặc set 'all' để query nhận brand filter
    if (!newState.brand_tier) newState.brand_tier = 'all'
  }

  // 3. Resolve province (async helper, có AI fallback)
  if (decision.updates.province_name && !newState.province_code) {
    try {
      const r = await resolveProvince(decision.updates.province_name)
      newState.province_code = r.code
      newState.province_name = r.name ?? decision.updates.province_name
    } catch (e) {
      console.error('[V3 gather] resolveProvince:', e)
      newState.province_name = decision.updates.province_name
    }
  }

  // 4. Persist state
  await updateSession(sessionId, { state: newState })

  // 5. Branch theo action
  if (decision.action === 'handoff_cskh') {
    await reply(psid, sessionId, decision.reply)
    await cskhHandoff(psid, sessionId, newState, decision.cskh_reason ?? 'AI v3GatherTurn')
    return
  }

  if (decision.action === 'fetch_results') {
    // Đảm bảo đủ 3 trường (an toàn — đôi khi AI act sớm)
    const hasSize = !!newState.tire_size
    const hasBrand = !!newState.brand_tier
    const hasProvince = !!newState.province_name
    if (!hasSize || !hasBrand || !hasProvince) {
      console.warn(
        `[V3 gather] action=fetch_results nhưng thiếu field (size=${hasSize}, brand=${hasBrand}, prov=${hasProvince}). Fallback continue.`
      )
      await reply(psid, sessionId, decision.reply)
      return
    }
    await reply(psid, sessionId, decision.reply)
    await showSpGaraResults(
      psid,
      sessionId,
      pageId,
      newState.province_code ?? null,
      newState.province_name ?? '',
      newState
    )
    return
  }

  // ── Branch 1: AI phát hiện tên xe + chưa có size → BỎ QUA reply AI để tránh
  //    AI hỏi size text trùng với tin 2 (carousel QR sizes). Dùng tin cứng.
  if (decision.updates.car_model && !newState.tire_size) {
    const carName = decision.updates.car_model
    console.log(`[V3 gather] car_model="${carName}" → lookupCarSizes (bỏ qua AI reply)`)

    // Compose ack ngắn: nếu vừa nhận brand, ack brand; luôn kèm "tra cứu kích cỡ"
    const justGotBrand =
      (decision.updates.selected_brands && decision.updates.selected_brands.length > 0) ||
      decision.updates.brand_tier
    let ackText: string
    if (justGotBrand) {
      const brandLabel =
        decision.updates.selected_brands && decision.updates.selected_brands.length > 0
          ? decision.updates.selected_brands.join(', ')
          : `phân khúc ${decision.updates.brand_tier}`
      ackText = `Dạ ghi nhận ${brandLabel} ạ 👍\n\nTROLY tra cứu kích cỡ cho xe ${carName} ngay ạ 😊`
    } else {
      ackText = `Dạ TROLY tra cứu kích cỡ cho xe ${carName} ngay ạ 😊`
    }
    await reply(psid, sessionId, ackText)

    const sizes = await lookupCarSizes(carName)
    if (sizes.length > 0) {
      await showCarSizeOptions(psid, sessionId, carName, sizes)
    } else {
      await reply(
        psid,
        sessionId,
        `TROLY chưa tra được kích cỡ cho xe "${carName}" 😅\n\nAnh/chị nhập giúp em kích cỡ lốp nhé? Ví dụ: 185/60R15`
      )
    }
    return
  }

  // ── Branch 2: gửi reply AI bình thường
  await reply(psid, sessionId, decision.reply)

  // Safety-net: AI đôi khi chỉ ack mà quên hỏi field thiếu kế tiếp.
  // Nếu reply không có '?' và state vẫn thiếu → tự gửi câu hỏi cứng.
  if (!decision.reply.includes('?')) {
    const fallback = nextMissingFieldQuestion(newState)
    if (fallback) {
      console.log(`[V3 gather] safety-net fallback: ${fallback}`)
      await reply(psid, sessionId, fallback)
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Show SP+gara cards (giữ y V2, wording không đổi)
// ════════════════════════════════════════════════════════════════════════════

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
    await reply(psid, sessionId, 'Thiếu thông tin kích cỡ lốp, vui lòng bắt đầu lại 😊')
    return
  }
  const brandFilter = brandFilterFromState(state)

  try {
    let cards = await fetchSpGaraCards({
      tireSize,
      tireBrand: brandFilter,
      provinceCode,
      limit: 3,
      sortBy: 'quantitysold'
    })
    let usedNational = false

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

    if (cards.length === 0) {
      await updateSession(sessionId, {
        step: 'AWAITING_CSKH_CHANNEL',
        state: { ...state, cskh_reason: `Không có SP+gara cho size ${tireSize} ở ${provinceName}` }
      })
      await reply(
        psid,
        sessionId,
        `Hiện TROLYoto chưa có sản phẩm phù hợp ở ${provinceName} ạ 😅\n\nĐể chuyên viên hỗ trợ anh/chị nhé 😊`,
        [qr(QR_TITLE.CSKH_HERE, 'QR_CSKH_HERE'), qr(QR_TITLE.LEAVE_PHONE, 'QR_LEAVE_PHONE')]
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

    const shownCodes = cards.map(c => c.garageCode).filter((c): c is string => !!c)
    const minPrice = Math.min(...cards.map(c => c.finalPrice))

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
      'v3-help-15s'
    )
  } catch (err) {
    console.error('[V3 flow] showSpGaraResults:', err)
    await reply(psid, sessionId, 'Xin lỗi, có lỗi khi tìm sản phẩm/đại lý. Vui lòng thử lại sau ạ 😊')
  }
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
        [{ type: 'web_url', title: QR_TITLE.COMMUNITY_SUBSIDY, url: COMMUNITY_URL }],
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
        [{ type: 'web_url', title: QR_TITLE.COMMUNITY_SUBSIDY, url: COMMUNITY_URL }],
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
        [{ type: 'web_url', title: QR_TITLE.COMMUNITY_VOUCHER, url: COMMUNITY_URL }],
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
        [qr(QR_TITLE.CSKH_HERE, 'QR_CSKH_HERE'), qr(QR_TITLE.LEAVE_PHONE, 'QR_LEAVE_PHONE')]
      )
    ])
  }
}

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
    [qr(QR_TITLE.CSKH_HERE, 'QR_CSKH_HERE'), qr(QR_TITLE.LEAVE_PHONE, 'QR_LEAVE_PHONE')]
  )
}

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
      reply(psid, sessionId, 'Anh chị nhắn số điện thoại, TROLYoto sẽ liên hệ sớm nhất ạ!')
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
  await Promise.all([
    updateSession(sessionId, {
      step: 'COMPLETED',
      state: { ...state, phone },
      is_active: false
    }),
    reply(
      psid,
      sessionId,
      `TROLYoto đã nhận số ${phone} 🙏\n\nChuyên viên sẽ liên hệ anh/chị trong giờ làm việc sớm nhất ạ 😊\n\n⏰ Giờ làm việc: 9h - 18h, Thứ 2 - Thứ 6`
    )
  ])
}

// ════════════════════════════════════════════════════════════════════════════
//  Main dispatcher
// ════════════════════════════════════════════════════════════════════════════

export async function handleMessengerEventV3(
  event: MessengerEvent,
  pageId: string
): Promise<void> {
  try {
    const psid = event.sender.id

    // CSKH takeover detection (echo from page admin)
    if (event.message?.is_echo) {
      const recipientPsid = event.recipient.id
      const activeSession = await getActiveSession(recipientPsid, pageId)
      if (activeSession && !activeSession.is_paused_by_cskh) {
        cancelTimer(activeSession.id, 'v3-cskh-takeover')
        await pauseSessionByCskh(activeSession.id)
        appendConversationLog(activeSession.id, {
          role: 'system',
          type: 'system',
          text: '[V3 bot paused by CSKH reply]',
          ts: new Date().toISOString()
        }).catch(e => console.error('[V3 log]', e))
        console.log(`[V3] Bot paused for psid=${recipientPsid} by CSKH`)
      }
      return
    }

    if (psid === pageId) return

    // Skip non-actionable events (delivery/read)
    const isActionable = !!(
      event.message?.text ||
      event.message?.quick_reply ||
      event.postback ||
      event.optin ||
      event.referral
    )
    if (!isActionable) return

    // Typing + seen sớm
    sendTypingOn(psid, PAGE_TOKEN_V3).catch(e => console.error('[V3 typing-early]', e))
    markSeen(psid, PAGE_TOKEN_V3).catch(e => console.error('[V3 markSeen]', e))

    let session: FbSession | null = await getActiveSession(psid, pageId)
    if (session?.is_paused_by_cskh) return

    // optin/referral → welcome
    if (event.optin || event.referral) {
      if (!session) session = await createSession(psid, pageId)
      await sendV3Welcome(psid, session.id)
      return
    }

    const messageText = event.message?.text?.trim() ?? ''
    const payload =
      event.message?.quick_reply?.payload ?? event.postback?.payload ?? ''

    const latest = session ? null : await getLatestSession(psid, pageId)
    if (!session && latest?.is_paused_by_cskh) return

    if (!session) {
      session = await createSession(psid, pageId)
      await sendV3Welcome(psid, session.id)
      return
    }

    const { step, state } = session

    // Log user msg
    if (messageText || payload) {
      appendConversationLog(session.id, {
        role: 'user',
        type: payload ? 'qr_click' : 'text',
        text: messageText || `[click: ${payload}]`,
        ts: new Date().toISOString(),
        ...(payload ? { payload } : {})
      }).catch(e => console.error('[V3 log user]', e))
    }

    // ── Payload (QR/postback) ────────────────────────────────────────────
    if (payload) {
      // Khách chọn 1 size từ list QR (sau khi AI tra theo tên xe)
      if (payload.startsWith('V3_TIRE_SIZE:')) {
        const size = payload.replace('V3_TIRE_SIZE:', '').toUpperCase()
        console.log(`[V3 flow] V3_TIRE_SIZE click → tire_size=${size}`)
        const newState: SessionState = { ...state, tire_size: size }
        await updateSession(session.id, { step: 'V3_GATHERING', state: newState })
        // Re-trigger gather turn với size làm input — AI sẽ ack + hỏi bước tiếp
        await handleGathering(
          psid,
          { ...session, state: newState, step: 'V3_GATHERING' },
          pageId,
          size
        )
        return
      }
      // Global payloads (route bất kể step)
      if (payload === 'QR_CSKH_HERE' || payload === 'QR_LEAVE_PHONE') {
        await handleCskhChannel(psid, session.id, payload, state)
        return
      }
      if (payload === 'QR_BOOK_DONE' || payload === 'QR_NOT_YET' || payload === 'QR_CONCERN') {
        console.log(`[V3 flow] booking-global payload=${payload} step=${step}`)
        await handleBookingState(psid, session.id, payload, state)
        return
      }
      if (payload === 'QR_BETTER_PRICE' || payload === 'QR_CLOSER_DEALER') {
        console.log(`[V3 flow] concern-global payload=${payload} step=${step}`)
        await handleConcern(psid, session.id, payload, state)
        return
      }
      // Welcome consult choice + late AI + wait CSKH
      if (
        payload === 'QR_AI_CONSULT' ||
        payload === 'QR_AI_CONSULT_LATE' ||
        payload === 'QR_CSKH_CONSULT' ||
        payload === 'QR_WAIT_CSKH'
      ) {
        await handleConsultChoice(psid, session.id, payload, state)
        return
      }
      // V3 hiếm khi dùng QR khác — postback lạ → bỏ qua + log
      console.log(`[V3 flow] unhandled payload=${payload} step=${step}`)
      return
    }

    // ── Plain text ───────────────────────────────────────────────────────
    if (messageText) {
      if (messageText === '/reset') {
        cancelTimer(session.id, '/reset')
        await resetUserSessions(psid, pageId)
        const fresh = await createSession(psid, pageId)
        await sendV3Welcome(psid, fresh.id)
        return
      }

      switch (step) {
        case 'AWAITING_CONSULT_TYPE':
        case 'WELCOME':
          // Welcome đang chờ click QR. Khách gõ text → fuzzy match (giống V2):
          // nếu match → route; không match → resend ngắn.
          {
            const t = messageText.toLowerCase()
            if (/bao\s*gia|tro\s*ly|bot|ai|nhanh|ngay|tuc\s*thi/.test(t)) {
              await handleConsultChoice(psid, session.id, 'QR_AI_CONSULT', state)
            } else if (/tu\s*van|chuyen\s*vien|nhan\s*vien|cskh|ky/.test(t)) {
              await handleConsultChoice(psid, session.id, 'QR_CSKH_CONSULT', state)
            } else {
              await reply(
                psid,
                session.id,
                'Anh/chị cần hỗ trợ:',
                [
                  qr(QR_TITLE.AI_CONSULT, 'QR_AI_CONSULT'),
                  qr(QR_TITLE.CSKH_CONSULT, 'QR_CSKH_CONSULT')
                ]
              )
            }
          }
          break

        case 'AWAITING_AREA_FOR_CSKH':
          await handleAreaForCskh(psid, session.id, messageText, state)
          break

        case 'AWAITING_SIZE_FOR_CSKH':
          await handleSizeForCskh(psid, session.id, messageText, state)
          break

        case 'V3_GATHERING':
          await handleGathering(psid, session, pageId, messageText)
          break

        case 'AWAITING_PHONE':
          await handlePhoneInput(psid, session.id, messageText, state)
          break

        case 'AWAITING_CSKH_CHANNEL':
          // Khách gõ thẳng SĐT → nhận luôn; khác → silent (đợi click QR)
          if (extractPhone(messageText)) {
            await updateSession(session.id, { step: 'AWAITING_PHONE', state })
            await handlePhoneInput(psid, session.id, messageText, state)
          }
          break

        case 'SHOWING_RESULTS_LOCAL':
          // Đang chờ timer 15s → im lặng (theo design V2)
          console.log(`[V3 flow] SHOWING_RESULTS_LOCAL silent session=${session.id}`)
          break

        case 'AWAITING_BOOKING_STATE':
        case 'AWAITING_CONCERN':
          // Đang chờ click QR booking/concern. Khách gõ text → AI gather có thể
          // hiểu intent (vd "rẻ hơn không"); tạm xử như gathering để bot phản
          // hồi tự nhiên thay vì silent.
          await handleGathering(psid, session, pageId, messageText)
          break

        case 'COMPLETED':
        default: {
          const ns = await createSession(psid, pageId)
          await sendV3Welcome(psid, ns.id)
          break
        }
      }
    }
  } catch (err) {
    console.error('[V3 flow] handleMessengerEventV3:', err)
  }
}
