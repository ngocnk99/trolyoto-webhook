/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Priority Garage — cache RAM danh sách gara ƯU TIÊN (bảng `priority_garage`)
 *
 *  BỐI CẢNH
 *  Khi khách đã đủ size+brand+vị trí nhưng khu vực khách KHÔNG có gara nào còn
 *  hàng, bot trước đây đi thẳng CSKH — CSKH người thật phải tự tay gợi ý vài
 *  ĐẠI LÝ CHÍNH HÃNG ở tỉnh/TP khác. Bảng `priority_garage` số hoá danh sách
 *  đó (xem database/migrations/20260827_priority_garage.sql), dùng làm bước 3
 *  trong cascade 4 bước:
 *    1. size+brand+wardCode  2. size+brand+provinceCode
 *    3. size+brand + CHỈ gara trong danh sách này (module này)
 *    4. size+brand + toàn bộ gara, không giới hạn vị trí
 *
 *  VÌ SAO CACHE RAM, KHÔNG QUERY TRỰC TIẾP MỖI LƯỢT CHAT
 *  Bước 3 chỉ chạy khi bước 1+2 đều rỗng (hiếm) — nhưng nếu có chạy, KHÔNG
 *  được cộng thêm 1 round-trip DB vào latency của lượt chat đó. Module này
 *  fetch định kỳ (mặc định 30 phút) và cache trong RAM, `getPriorityGarageCodes()`
 *  đọc đồng bộ (không await) — cùng idiom với `src/cache/cache-outbox-cron.ts`
 *  (setInterval + start/stop + status object expose qua /version).
 *
 *  AN TOÀN KHI FETCH LỖI: giữ NGUYÊN cache cũ, chỉ log lỗi — 1 lần Supabase
 *  hiccup không được vô tình tắt cả tier 3 trong 30 phút tiếp theo.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { supabaseAmin } from './supabase'

const REFRESH_MS = Number(process.env.PRIORITY_GARAGE_REFRESH_MS ?? 1_800_000) // 30 phút
const ENABLED = process.env.PRIORITY_GARAGE_ENABLED !== 'false'

let codes: string[] = []
let rank = new Map<string, number>() // garage_code -> priority (chưa dùng để sort kết quả, chỉ để dành)
let timer: NodeJS.Timeout | null = null

const stats = {
  enabled: ENABLED,
  startedAt: null as string | null,
  running: false,
  lastRunAt: null as string | null,
  lastSuccessAt: null as string | null,
  lastError: null as string | null,
  runs: 0,
  count: 0
}

async function loadOnce(): Promise<void> {
  stats.lastRunAt = new Date().toISOString()
  stats.runs++
  try {
    const { data, error } = await supabaseAmin
      .from('priority_garage')
      .select('garage_code, priority')
      .eq('is_active', true)
      .order('priority', { ascending: true })

    if (error) throw error

    const newCodes = (data ?? []).map(r => r.garage_code as string)
    const newRank = new Map<string, number>(
      (data ?? []).map(r => [r.garage_code as string, r.priority as number])
    )

    codes = newCodes
    rank = newRank
    stats.count = codes.length
    stats.lastSuccessAt = new Date().toISOString()
    stats.lastError = null
    console.log(`[priorityGarage] refreshed — ${codes.length} gara: [${codes.join(', ')}]`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    stats.lastError = msg
    console.error(
      `[priorityGarage] refresh lỗi, GIỮ NGUYÊN cache cũ (${codes.length} gara):`,
      msg
    )
  }
}

/** Đọc đồng bộ, KHÔNG await — dùng ở mọi call site trong luồng chat. */
export function getPriorityGarageCodes(): string[] {
  return codes
}

/** Chưa dùng để sort kết quả (v1: cheapest-first như mọi tier khác) — để dành
 *  nếu sau này cần ưu tiên hiển thị theo đúng thứ tự cột `priority`. */
export function getPriorityGarageRank(): Map<string, number> {
  return rank
}

export function getPriorityGarageStatus() {
  return { ...stats, codes }
}

export function startPriorityGarageCache(): void {
  if (!ENABLED) {
    console.log('[priorityGarage] TẮT qua PRIORITY_GARAGE_ENABLED=false — tier 3 sẽ không bao giờ chạy')
    return
  }
  if (timer) return
  stats.startedAt = new Date().toISOString()
  stats.running = true
  console.log(`[priorityGarage] bật — refresh mỗi ${REFRESH_MS}ms`)
  // Load ngay lúc start — KHÔNG đợi hết 30 phút mới có dữ liệu đầu tiên.
  loadOnce().catch(e => console.error('[priorityGarage] load lần đầu lỗi:', e))
  timer = setInterval(() => {
    loadOnce().catch(e => console.error('[priorityGarage] lỗi ngoài dự kiến:', e))
  }, REFRESH_MS)
}

export function stopPriorityGarageCache(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
    stats.running = false
  }
}
