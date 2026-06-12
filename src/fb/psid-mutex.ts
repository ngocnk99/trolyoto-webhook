/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Per-PSID mutex — serialize event processing cho từng customer.
 *
 *  Vấn đề: khi FB gửi 2 webhook gần như đồng thời (vd khách spam 2 tin trong
 *  100ms), 2 request POST chạy song song trên Node process. Cả 2 cùng gọi
 *  `getActiveSession` → cả 2 thấy null → cả 2 `createSession` → 2 session
 *  cùng PSID. State bị split, tin trước mất.
 *
 *  Fix: giữ 1 Promise chain per PSID. Event sau phải `await` event trước xong
 *  rồi mới xử lý. Race condition biến mất.
 *
 *  Lưu ý:
 *   - Chỉ work trong 1 Node process. Nếu deploy multi-instance (load balancer)
 *     cần đổi sang Redis lock hoặc Postgres advisory lock.
 *   - Render free/starter tier = single process → đủ cho hiện tại.
 *   - Mỗi PSID 1 entry trong Map; cleanup khi promise resolve để tránh leak.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const queues = new Map<string, Promise<unknown>>()

/**
 * Chạy `fn` cho PSID này theo thứ tự FIFO. Event sau chờ event trước
 * (kể cả nếu event trước throw — không block chain).
 */
export async function runWithPsidLock<T>(
  psid: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = queues.get(psid)
  // Tạo promise mới cho slot này; gắn vào map trước khi chạy fn để event tiếp
  // theo (nếu đến giữa khoảng này) biết phải chờ.
  let release!: () => void
  const slot = new Promise<void>(resolve => {
    release = resolve
  })
  queues.set(psid, slot)
  try {
    if (prev) {
      await prev.catch(() => {
        // Event trước throw → vẫn tiếp tục chain (không block)
      })
    }
    return await fn()
  } finally {
    release()
    // Chỉ cleanup nếu slot này vẫn là tail của queue (= không có event mới enqueue)
    if (queues.get(psid) === slot) {
      queues.delete(psid)
    }
  }
}

/** Số PSID đang có queue active — dùng cho /api/debug/mutex để monitor */
export function psidMutexStats(): { activePsids: number } {
  return { activePsids: queues.size }
}
