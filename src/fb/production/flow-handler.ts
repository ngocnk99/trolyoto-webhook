/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  PRODUCTION wrapper — dùng CHUNG handler V3, bọc thêm:
 *   - Time gate (FROM_TIME → END_TIME, overnight OK)
 *   - /reset bypass time gate (để test bất cứ lúc nào)
 *   - Whitelist PSID bypass time gate
 *   - Handover Protocol: bot là Secondary Receiver (Pancake là Primary).
 *
 *  Logic chatbot 100% trong v3/flow-handler.ts. Token đúng được V3 handler tự
 *  pick theo pageId qua AsyncLocalStorage.
 *
 *  ── 4 SCENARIOS ─────────────────────────────────────────────────────────────
 *
 *  A) Event ở entry.messaging[]  (bot đang giữ thread)
 *     - Trong giờ làm việc (CSKH on) → bot SILENT. Không reply.
 *     - Ngoài giờ làm việc           → bot xử lý qua V3 handler.
 *
 *  B) Event ở entry.standby[]    (Pancake đang giữ thread)
 *     - CSKH echo (is_echo + app_id != bot) → pauseSessionByCskh + log.
 *     - Customer message trong giờ làm việc → CHỈ log conversation_log (track
 *       cho future bot decisions). Không reply, không take.
 *     - Customer message ngoài giờ làm việc:
 *         + Session đã is_paused_by_cskh → log only, không take, không reply.
 *         + Chưa pause                    → take_thread_control → V3 handler.
 *
 *  Cron 8:30 hàng ngày pass_thread_control trả lại Pancake (handover-cron.ts).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  MessengerEvent,
  ConversationMessage,
  MessengerEntry,
  FbSession
} from '../types'
import {
  handleMessengerEventV3,
  dispatchAndShowResults,
  hasBrandField
} from '../v3/flow-handler'
import {
  getActiveSession,
  getLatestSession,
  createSession,
  updateSession,
  pauseSessionByCskh,
  completeSession,
  setBotOwnsThread,
  appendConversationLog,
  resolveEffectiveSession
} from '../session'
import { takeThreadControl } from '../handover'

const FROM_TIME = process.env.FROM_TIME ?? '18:00'
const END_TIME = process.env.END_TIME ?? '08:30'
const FB_APP_ID = process.env.FB_APP_ID ?? ''

/** Whitelist PSID bypass time gate (test trên prod page bất kể giờ).
 *  Override qua env PROD_TEST_PSIDS="psid1,psid2,..." nếu muốn thêm. */
const PROD_TEST_PSIDS = new Set(
  (process.env.PROD_TEST_PSIDS ?? '24081205854909009')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
)

function parseHHMM(s: string): number {
  const [h = 0, m = 0] = s.split(':').map(n => parseInt(n, 10))
  return h * 60 + m
}

/** True nếu giờ hiện tại (Asia/Ho_Chi_Minh) nằm trong khung [FROM, END). Overnight OK. */
function isInProductionWindow(): boolean {
  const vnTime = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' })
  )
  const nowMin = vnTime.getHours() * 60 + vnTime.getMinutes()
  const fromMin = parseHHMM(FROM_TIME)
  const endMin = parseHHMM(END_TIME)
  if (fromMin === endMin) return true
  if (fromMin > endMin) {
    // Overnight (vd 18:00 → 08:30 hôm sau)
    return nowMin >= fromMin || nowMin < endMin
  }
  return nowMin >= fromMin && nowMin < endMin
}

/** Detect echo từ app KHÁC bot (vd Pancake gửi tin cho khách → echo bay về với app_id khác). */
function isEchoFromOtherApp(event: MessengerEvent): boolean {
  const echo = event.message?.is_echo
  if (!echo) return false
  const appId = event.message?.app_id
  if (!FB_APP_ID || !appId) return echo === true
  return String(appId) !== String(FB_APP_ID)
}

/**
 * Detect tin ECHO TỰ ĐỘNG — KHÔNG phải CSKH người thật engage — 2 dạng đã
 * biết, cả 2 đều echo về CÙNG app_id với admin Business Suite thật
 * (263902037430900) nên KHÔNG thể phân biệt qua app_id, phải nhận diện qua
 * CẤU TRÚC/NỘI DUNG:
 *
 * 1. "Recurring Notifications" — Facebook tự động nhắc lại thread cũ (vd
 *    tiêu đề "Ưu đãi và thông báo", `notification_messages_cta_entry_point:
 *    "mm_stale_thread_automation"`) — chỉ tin dạng này mới có field
 *    `notification_messages_*` trong `buttons`.
 * 2. "Trả lời tức thì" (Instant Reply) — tính năng auto-greeting mặc định
 *    của Meta Business Suite, bắn NGAY khi có hội thoại mới, luôn đúng 1
 *    khuôn "Xin chào {tên khách}! Bạn có thắc mắc nào cần trao đổi thêm với
 *    chúng tôi không?" (chỉ tên thay đổi, phần còn lại KHÔNG BAO GIỜ đổi).
 *    Phát hiện 2026-08-25 qua log DB thật: 41/41 lần xuất hiện khớp y hệt
 *    cấu trúc câu — khác hẳn văn phong CSKH người thật gõ tay (có lỗi chính
 *    tả, nội dung theo đúng ngữ cảnh khách hỏi). 81% tin echo app_id Business
 *    Suite trả lời trong <10 giây kể từ tin đầu của khách — quá nhanh so với
 *    người thật, phần lớn rơi vào đúng mẫu này. Trước fix: check cũ (dạng 1)
 *    CHỈ bắt tin có attachment/buttons — mẫu Instant Reply là TEXT THUẦN nên
 *    lọt qua hoàn toàn, khiến bot bị pause oan dù CHƯA có CSKH thật nào
 *    engage (khách bị "im lặng" oan ngay từ tin đầu tiên).
 *
 * Người thật gõ qua Business Suite chỉ gửi text tự do/ảnh đơn giản theo đúng
 * ngữ cảnh — không khớp cấu trúc/khuôn mẫu cố định nào ở trên. Coi tin dạng
 * này KHÔNG phải CSKH thật engage — không được pause bot vì tin này (xem call
 * site). Đồng bộ với `isAutomatedAdEcho()` trong v3/flow-handler.ts.
 */
function isAutomatedAdEcho(event: MessengerEvent): boolean {
  const attachments = event.message?.attachments
  const hasNotificationButton =
    !!attachments?.length &&
    attachments.some(a => {
      const elements = a.payload?.elements
      if (!Array.isArray(elements)) return false
      return elements.some(el =>
        (el.buttons ?? []).some(b =>
          Object.keys(b ?? {}).some(k => k.startsWith('notification_messages_'))
        )
      )
    })
  if (hasNotificationButton) return true

  const text = event.message?.text?.trim()
  if (text && INSTANT_REPLY_GREETING_RE.test(text)) return true

  return false
}

/** Khuôn cố định của "Trả lời tức thì" (Instant Reply) mặc định Meta Business
 *  Suite — verify qua log thật, xem docstring `isAutomatedAdEcho()`. */
const INSTANT_REPLY_GREETING_RE =
  /^Xin chào .+?!\s*Bạn có thắc mắc nào cần trao đổi thêm với chúng tôi không\?$/

/**
 * Lấy session active/latest + tự động unpause nếu `is_paused_by_cskh` đã quá
 * hạn (`resolveEffectiveSession`, xem session.ts) — PHẢI dùng hàm này (thay
 * vì gọi trực tiếp `getActiveSession ?? getLatestSession`) ở MỌI điểm quyết
 * định "bot có nên im lặng vì đang pause_by_cskh" để đảm bảo pause tự hết
 * hạn sau `CSKH_PAUSE_EXPIRY_MS`, tránh bot im lặng vĩnh viễn cho 1 PSID.
 */
async function getEffectiveSession(
  psid: string,
  pageId: string
): Promise<FbSession | null> {
  const session =
    (await getActiveSession(psid, pageId)) ?? (await getLatestSession(psid, pageId))
  return resolveEffectiveSession(session)
}

/** Tóm tắt event để lưu vào conversation_log khi observe-only (không xử lý). */
function summarizeEvent(event: MessengerEvent): string {
  if (event.message?.text) return event.message.text
  if (event.message?.attachments?.length)
    return `[attachment: ${event.message.attachments.map(a => a.type).join(',')}]`
  if (event.postback) return `[click: ${event.postback.title}]`
  if (event.referral) return `[referral: ${event.referral.source}/${event.referral.ref ?? ''}]`
  if (event.optin) return `[optin: ${event.optin.type ?? 'default'}]`
  return '[event]'
}

/**
 * Lead Ads payload (referral.type='LEAD_COMPLETE' + lead.data) chứa Q/A pairs
 * từ Instant Form — Q là câu Pancake/ad creative đặt sẵn, A là user trả lời.
 *
 * Lưu vào conversation_log để V3 handler có context khi xử lý: Q = role 'bot',
 * A = role 'user'. Trả về true nếu đã log >=1 cặp.
 */
async function logLeadData(
  sessionId: string,
  event: MessengerEvent
): Promise<boolean> {
  const items = event.lead?.data
  if (!items || items.length === 0) return false
  const ts = new Date().toISOString()
  for (const it of items) {
    if (it.question) {
      await appendConversationLog(sessionId, {
        role: 'bot',
        type: 'text',
        text: `[LEAD_Q] ${it.question}`,
        ts
      })
    }
    if (it.answer) {
      await appendConversationLog(sessionId, {
        role: 'user',
        type: 'text',
        text: it.answer,
        ts
      })
    }
  }
  console.log(
    `[PROD] LEAD_COMPLETE session=${sessionId}: logged ${items.length} Q/A pair(s)`
  )
  return true
}

/**
 * Production handler — phân nhánh theo 4 scenarios mô tả ở đầu file.
 *
 * @param isStandby   true khi event đến qua entry.standby[] (bot là Secondary,
 *                    Pancake đang giữ thread).
 * @param hopContext  entry.hop_context (nếu có) — signal "thread vừa được
 *                    handover sang bot". Nếu app_id == bot's FB_APP_ID →
 *                    set bot_owns_thread=true cho session.
 */
export async function handleMessengerEventProduction(
  event: MessengerEvent,
  pageId: string,
  isStandby = false,
  hopContext?: MessengerEntry['hop_context']
): Promise<void> {
  // ECHO event: sender=page, recipient=customer. Với non-echo: sender=customer.
  //  → Customer PSID = recipient.id khi is_echo, ngược lại = sender.id.
  const isEcho = event.message?.is_echo === true
  const psid = isEcho
    ? (event.recipient?.id ?? '')
    : (event.sender?.id ?? '')
  if (!psid || psid === pageId) {
    // Safety net: nếu PSID rỗng hoặc đúng = pageId (parse sai) → skip
    console.warn(
      `[PROD] skip event: derived psid="${psid}" pageId="${pageId}" isEcho=${isEcho}`
    )
    return
  }

  const isReset = event.message?.text?.trim() === '/reset'
  const isWhitelistedPsid = PROD_TEST_PSIDS.has(psid)
  const inWindow = isInProductionWindow() // true = giờ bot (18:00-08:30)
  const isOutOfHours = inWindow // alias for clarity: bot active outside business hours

  // ── (0) hop_context: bot vừa nhận thread từ Pancake → mark owns + log ────
  //  Đây là signal mạnh: dù event đến qua messaging[] hay standby[], nếu
  //  hop_context.app_id == bot's FB_APP_ID → bot đang là current owner.
  //  Mark sớm để cron 8:30 biết pass back.
  const botJustGotThread =
    !!hopContext && String(hopContext.app_id) === String(FB_APP_ID)
  if (botJustGotThread) {
    const session =
      (await getActiveSession(psid, pageId)) ?? (await getLatestSession(psid, pageId))
    if (session) {
      console.log(
        `[PROD] hop_context: bot vừa nhận thread psid=${psid} session=${session.id} → set bot_owns_thread=true`
      )
      await setBotOwnsThread(session.id, true)
    }
  }

  // ── (0b) Lead Ads: lead.data Q/A → lưu vào conversation_log ─────────────
  //  Bypass handover rules — event đến qua messaging[] kể cả Pancake là Primary.
  //  Mục đích: V3 handler có context khi user nhắn tiếp.
  if (event.lead?.data && event.lead.data.length > 0) {
    let session =
      (await getActiveSession(psid, pageId)) ?? (await getLatestSession(psid, pageId))
    if (!session) {
      session = await createSession(psid, pageId)
      await updateSession(session.id, { step: 'V3_GATHERING' })
    }
    await logLeadData(session.id, event)
    // Lead Ads event KHÔNG kèm text từ khách — chỉ chứa form data đã submit từ
    // trước. Không có gì để V3 reply ngay → return sau khi log.
    return
  }

  // ── (1) CSKH ECHO — bất kể standby/messaging, in/out giờ ─────────────────
  // Page Inbox / Business Suite / Pancake gửi tin cho khách → echo bay về với
  // app_id != bot. Đây là dấu hiệu CSKH đã engage → pause session vĩnh viễn
  // cho PSID này để bot không tự động trả lời ở các turn sau.
  //
  // App_id thường gặp:
  //   - 263902037430900: Meta Business Suite / Page Inbox (admin gửi qua FB UI)
  //   - 1733556690196497: Pancake CRM
  //   - Khác app_id của bot (FB_APP_ID) đều coi là CSKH.
  //
  // Edge: nếu chưa có session → CREATE rồi pause luôn (để khách quay lại
  // sau bot vẫn stay silent vĩnh viễn cho PSID đó).
  if (isEchoFromOtherApp(event)) {
    const appId = event.message?.app_id ?? 'unknown'

    // Tin quảng cáo/nhắc lại thread tự động do CHÍNH FACEBOOK gửi (KHÔNG phải
    // người thật) → KHÔNG coi là CSKH engage, bỏ qua hoàn toàn — không tạo
    // session mới, không pause. Nếu session HIỆN ĐANG bị pause (có thể do
    // đúng CSKH thật đã xong việc, hoặc do quảng cáo trước đó lỡ trigger
    // pause trước khi có check này) → complete session đó (như /reset) để
    // khách chat lại sau đó bot hoạt động bình thường, không bị treo silent
    // oan vĩnh viễn chỉ vì 1 tin quảng cáo.
    if (isAutomatedAdEcho(event)) {
      const adSession = await resolveEffectiveSession(
        await getLatestSession(psid, pageId)
      )
      if (adSession?.is_paused_by_cskh) {
        await completeSession(adSession.id)
        console.log(
          `[PROD] Automated echo (ad/instant-reply) app_id=${appId} psid=${psid} → session ${adSession.id} đang paused → complete (khách chat lại bot sẽ hoạt động bình thường)`
        )
      } else {
        console.log(
          `[PROD] Automated echo (ad/instant-reply) app_id=${appId} psid=${psid} → bỏ qua (không phải CSKH thật)`
        )
      }
      return
    }

    let session = await getEffectiveSession(psid, pageId)
    if (!session) {
      session = await createSession(psid, pageId)
      console.log(
        `[PROD] CSKH echo app_id=${appId} psid=${psid} (chưa có session) → CREATE session ${session.id} + pause`
      )
    } else if (!session.is_paused_by_cskh) {
      console.log(
        `[PROD] CSKH echo app_id=${appId} psid=${psid} → pause session ${session.id}`
      )
    } else {
      console.log(
        `[PROD] CSKH echo app_id=${appId} psid=${psid} session=${session.id} đã paused → chỉ log thêm`
      )
    }
    if (!session.is_paused_by_cskh) {
      await pauseSessionByCskh(session.id)
    }
    // Log nội dung CSKH đã gửi vào conversation_log để có ngữ cảnh đầy đủ
    const logMsg: ConversationMessage = {
      role: 'bot',
      type: 'text',
      text: `[CSKH app=${appId}] ${event.message?.text ?? '[attachment/template]'}`,
      ts: new Date().toISOString()
    }
    await appendConversationLog(session.id, logMsg)

    // CSKH nhắc khách "chọn [XEM KHUYẾN MẠI]" (xem giá/khuyến mại/năm SX) —
    // nếu 2 tin GẦN NHẤT TRƯỚC ĐÓ (session.conversation_log lúc này CHƯA
    // append logMsg ở trên) không có tin nào gửi card sản phẩm, khách sẽ
    // không có card để bấm. Nếu state đã đủ 3 trường (size/brand/khu vực) →
    // tự gửi lại card SP dùng ĐÚNG thông tin mới nhất đã thu thập (query DB
    // fresh qua dispatchAndShowResults, KHÔNG replay card cũ). Chỉ áp dụng
    // khi ĐÃ ĐỦ info — nếu thiếu, bỏ qua (không tự ý cskhHandoff/hỏi lại
    // trong lúc CSKH đang trực tiếp xử lý). Xem follow.md.
    if (/xem khuyến mại/i.test(event.message?.text ?? '')) {
      const recentHasCard = session.conversation_log
        .slice(-2)
        .some(m => m.type === 'cards')
      const st = session.state
      const stateComplete =
        !!st.tire_size &&
        hasBrandField(st) &&
        (!!st.province_code || !!st.ward_code)
      if (!recentHasCard && stateComplete) {
        console.log(
          `[PROD] CSKH nhắc "xem khuyến mại" nhưng 2 tin gần nhất chưa có card → tự gửi lại card SP (state hiện có) session=${session.id}`
        )
        await dispatchAndShowResults(psid, session.id, pageId, st, [])
        // dispatchAndShowResults set is_active=true/step khác để phục vụ luồng
        // gathering bình thường → re-pause NGAY, tránh bot vô tình "sống lại"
        // trong lúc CSKH vẫn đang trực tiếp xử lý khách.
        await pauseSessionByCskh(session.id)
      }
    }
    return
  }

  // ── (2) /reset hoặc whitelisted PSID — bypass time gate ──────────────────
  if (isReset || isWhitelistedPsid) {
    if (isStandby) {
      const taken = await takeThreadControl(psid, pageId, isReset ? 'reset' : 'whitelist')
      if (!taken) {
        console.warn(
          `[PROD] take_thread_control fail psid=${psid} (reset/whitelist) → skip`
        )
        return
      }
      const session = await getActiveSession(psid, pageId)
      if (session) await setBotOwnsThread(session.id, true)
    }
    await handleMessengerEventV3(event, pageId)
    return
  }

  // ── (3) Standby branch — Pancake đang giữ thread ─────────────────────────
  if (isStandby) {
    // Lấy hoặc tạo session để có chỗ ghi log conversation
    let session = await getEffectiveSession(psid, pageId)

    // Trong giờ làm việc → chỉ log, không reply, không take.
    if (!isOutOfHours) {
      if (!session) {
        // Tạo session để track conversation (sẽ dùng ở turn ngoài giờ tiếp theo)
        session = await createSession(psid, pageId)
        await updateSession(session.id, { step: 'V3_GATHERING' })
        console.log(
          `[PROD] standby in business-hours → NEW session ${session.id} (log only)`
        )
      }
      const userMsg: ConversationMessage = {
        role: 'user',
        type: 'text',
        text: summarizeEvent(event),
        ts: new Date().toISOString()
      }
      await appendConversationLog(session.id, userMsg)
      console.log(
        `[PROD] standby in business-hours psid=${psid} session=${session.id} → log: ${userMsg.text.slice(0, 80)}`
      )
      return
    }

    // Ngoài giờ làm việc — bot có nhiệm vụ trả lời.
    // Nếu session đã pause_by_cskh từ trước → bot KHÔNG can thiệp.
    if (session?.is_paused_by_cskh) {
      console.log(
        `[PROD] standby out-of-hours psid=${psid} session=${session.id} đã pause_by_cskh → log only`
      )
      const userMsg: ConversationMessage = {
        role: 'user',
        type: 'text',
        text: summarizeEvent(event),
        ts: new Date().toISOString()
      }
      await appendConversationLog(session.id, userMsg)
      return
    }

    // Bot take_thread_control rồi xử lý qua V3.
    console.log(
      `[PROD] standby out-of-hours psid=${psid} → take_thread_control + V3`
    )
    const taken = await takeThreadControl(psid, pageId, 'out_of_hours_takeover')
    if (!taken) {
      console.warn(`[PROD] take_thread_control fail psid=${psid} → skip`)
      return
    }
    if (session) await setBotOwnsThread(session.id, true)
    await handleMessengerEventV3(event, pageId)
    return
  }

  // ── (4) Messaging branch — bot đã giữ thread (handover trước đó) ─────────
  if (!isOutOfHours) {
    // Trong giờ làm việc → bot không reply dù đang giữ thread.
    console.log(
      `[PROD] messaging in business-hours psid=${psid} → silent (giờ CSKH)`
    )
    return
  }

  // Ngoài giờ — check pause trước khi reply.
  const session = await getEffectiveSession(psid, pageId)
  if (session?.is_paused_by_cskh) {
    console.log(
      `[PROD] messaging out-of-hours psid=${psid} session=${session.id} pause_by_cskh → skip`
    )
    return
  }

  await handleMessengerEventV3(event, pageId)
}
