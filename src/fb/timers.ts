/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Timers in-process cho luồng V2 (nudge 15s / 45s)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  V2 yêu cầu auto-nudge khi khách im lặng:
 *   - 15s ở `SHOWING_RESULTS_NATIONAL` → hỏi nhu cầu + khu vực
 *   - 45s ở `AWAITING_BOOKING_STATE`   → coi như "Còn băn khoăn"
 *
 *  Render chạy Node always-on nên `setTimeout` sống giữa các request.
 *  ⚠️ Đánh đổi (đã chốt với product): timer MẤT nếu process restart/redeploy/sleep.
 *  Không bền vững như queue — chấp nhận vì free tier + nudge không critical.
 *
 *  Quy tắc dùng:
 *   - Key = sessionId.
 *   - Mỗi khi khách gửi event mới → `cancel(sessionId)` (khách đã phản hồi).
 *   - Handler muốn nudge → `schedule(sessionId, ms, fn)`.
 *   - Callback PHẢI tự re-fetch session để xác nhận vẫn đúng step trước khi gửi
 *     (tránh race: khách vừa trả lời ngay trước khi timer fire).
 */

const timers = new Map<string, { handle: NodeJS.Timeout; label: string; firesAt: number }>()

export function scheduleTimer(
  sessionId: string,
  ms: number,
  fn: () => Promise<void>,
  label = 'nudge'
): void {
  cancelTimer(sessionId, `replaced-by-${label}`)
  const firesAt = Date.now() + ms
  const handle = setTimeout(() => {
    timers.delete(sessionId)
    console.log(`[FB timer] FIRE ${label} session=${sessionId} (after ${ms}ms)`)
    fn().catch(e => console.error(`[FB timer] ${label} callback error:`, e))
  }, ms)
  // KHÔNG unref — đảm bảo timer luôn fire trên process always-on.
  timers.set(sessionId, { handle, label, firesAt })
  console.log(
    `[FB timer] SCHEDULE ${label} session=${sessionId} fires in ${ms}ms (at ${new Date(firesAt).toISOString()})`
  )
}

export function cancelTimer(sessionId: string, reason = 'manual'): void {
  const t = timers.get(sessionId)
  if (t) {
    clearTimeout(t.handle)
    timers.delete(sessionId)
    console.log(`[FB timer] CANCEL ${t.label} session=${sessionId} reason=${reason}`)
  }
}
