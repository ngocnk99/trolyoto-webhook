/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Handover Cron — daily 8:30 VN time
 *
 *  Mục đích: vào đầu giờ làm việc CSKH (8:30), bot trả thread control về cho
 *  Primary Receiver (Pancake) trên TẤT CẢ session có bot_owns_thread=true.
 *
 *  Cơ chế:
 *   - setInterval 60 giây kiểm tra giờ hiện tại (Asia/Ho_Chi_Minh)
 *   - Khi gặp khung phút END_TIME (vd 08:30) → trigger pass-back
 *   - Cờ `lastRunDay` chống chạy 2 lần trong cùng 1 ngày
 *
 *  Khi pass thành công → set bot_owns_thread=false.
 *  Khi fail → giữ nguyên cờ; lần cron sau retry.
 *
 *  Phòng ngừa: nếu Pancake setup auto-handover ngược lại (sau 18:00 pass sang
 *  bot, trước 8:30 lấy về) thì code này không gây hại — chỉ trả lại app nào đã
 *  được set là Primary qua /me/secondary_receivers (auto-discovered).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getSessionsOwnedByBot, setBotOwnsThread } from './session'
import { getPrimaryAppId, passThreadControl } from './handover'

const END_TIME = process.env.END_TIME ?? '08:30'
const FB_PAGE_ID_PRODUCT = process.env.FACEBOOK_PAGE_ID_PRODUCT ?? ''

/** Format hh:mm hiện tại theo Asia/Ho_Chi_Minh */
function nowVNHHMM(): { hhmm: string; day: string } {
  const vnTime = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' })
  )
  const hh = String(vnTime.getHours()).padStart(2, '0')
  const mm = String(vnTime.getMinutes()).padStart(2, '0')
  const day = `${vnTime.getFullYear()}-${String(vnTime.getMonth() + 1).padStart(2, '0')}-${String(vnTime.getDate()).padStart(2, '0')}`
  return { hhmm: `${hh}:${mm}`, day }
}

let lastRunDay: string | null = null

async function runPassBack(): Promise<void> {
  if (!FB_PAGE_ID_PRODUCT) {
    console.warn('[handover-cron] FACEBOOK_PAGE_ID_PRODUCT chưa set → skip')
    return
  }
  const primaryAppId = await getPrimaryAppId(FB_PAGE_ID_PRODUCT)
  if (!primaryAppId) {
    console.warn(
      '[handover-cron] Không discover được Primary app_id (Pancake?) → skip pass-back'
    )
    return
  }

  const sessions = await getSessionsOwnedByBot(FB_PAGE_ID_PRODUCT)
  if (sessions.length === 0) {
    console.log('[handover-cron] Không có session nào bot đang giữ → done')
    return
  }
  console.log(
    `[handover-cron] Pass back ${sessions.length} thread(s) → Primary app=${primaryAppId}`
  )

  let okCount = 0
  let failCount = 0
  for (const s of sessions) {
    const ok = await passThreadControl(
      s.psid,
      FB_PAGE_ID_PRODUCT,
      primaryAppId,
      'cron_morning_pass_back'
    )
    if (ok) {
      await setBotOwnsThread(s.id, false)
      okCount++
    } else {
      failCount++
    }
  }
  console.log(
    `[handover-cron] Pass-back result: ${okCount} OK, ${failCount} fail (giữ flag để retry next cron)`
  )
}

export function startHandoverCron(): void {
  console.log(
    `[handover-cron] Started — sẽ trigger pass-back lúc ${END_TIME} VN time hàng ngày`
  )

  setInterval(() => {
    const { hhmm, day } = nowVNHHMM()
    if (hhmm !== END_TIME) return
    if (lastRunDay === day) return
    lastRunDay = day
    console.log(`[handover-cron] Trigger ${hhmm} ngày ${day} — chạy pass-back`)
    runPassBack().catch(e => console.error('[handover-cron] runPassBack error:', e))
  }, 60_000)
}
