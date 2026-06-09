/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  PRODUCTION wrapper — dùng CHUNG handler V3, chỉ bọc thêm:
 *   - Time gate (FROM_TIME → END_TIME, overnight OK)
 *   - /reset bypass time gate (để test bất cứ lúc nào)
 *
 *  Logic chatbot 100% trong v3/flow-handler.ts (mọi update đều áp dụng cho cả V3
 *  và PRODUCTION). Token đúng được V3 handler tự pick theo pageId qua
 *  AsyncLocalStorage.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { MessengerEvent } from '../types'
import { handleMessengerEventV3 } from '../v3/flow-handler'

const FROM_TIME = process.env.FROM_TIME ?? '18:00'
const END_TIME = process.env.END_TIME ?? '08:30'

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

/**
 * Production = V3 handler + time gate. /reset BYPASS gate.
 *
 * Để chỉnh logic chatbot → sửa v3/flow-handler.ts (áp dụng cho cả 2).
 */
export async function handleMessengerEventProduction(
  event: MessengerEvent,
  pageId: string
): Promise<void> {
  const psid = event.sender?.id ?? ''
  const isReset = event.message?.text?.trim() === '/reset'
  const isWhitelistedPsid = psid && PROD_TEST_PSIDS.has(psid)
  if (!isReset && !isWhitelistedPsid && !isInProductionWindow()) {
    console.log(
      `[PROD] outside time window (${FROM_TIME}-${END_TIME}) → silent for psid=${psid}`
    )
    return
  }
  if (isWhitelistedPsid) {
    console.log('event', event)
    console.log(`[PROD] whitelisted test psid=${psid} → bypass time gate`)
  }
  await handleMessengerEventV3(event, pageId)
}
