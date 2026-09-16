/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  tireSizeMerge — cache RAM ánh xạ size lốp (categoryadmin, type='SIZE',
 *  category='TIRE') → `key` nhóm ĐÃ GỘP thật (giá trị productadmin.SIZE).
 *
 *  BỐI CẢNH (xem docs/tire-size-key-merge.md ở gốc repo `production/`)
 *  Admin có thể GỘP 2 kích cỡ lốp về chung 1 bộ lọc (vd "195/70R15" +
 *  "195/70R15C" → dùng chung 1 `key`) qua bảng `categoryadmin` — mỗi dòng
 *  giữ `name` + `sub_key` RIÊNG nhưng nhiều dòng có thể CÙNG trỏ về 1 `key`.
 *  `productadmin."SIZE"` LUÔN được ghi đè về đúng `key` đó qua trigger DB
 *  `productadmin_normalize_product_size()` (tra `sub_key = X OR key = X`).
 *
 *  Trước đây chatbot (FB + Web) KHÔNG tra `categoryadmin` — chỉ tự convert
 *  "/" → "_" rồi query thẳng `productadmin.SIZE = X`. Bug thật: admin gộp
 *  "195/70R15" vào "195/70R15C" (2026-09-16, hướng "không-C → C") — sau gộp,
 *  MỌI sản phẩm nhóm đó có `SIZE = "195_70R15C"`, không còn dòng nào
 *  `SIZE = "195_70R15"` nữa. Khách gõ "195/70R15" (không "C") → chatbot
 *  query thẳng "195_70R15" → 0 kết quả, dù nhóm ĐÃ CÓ hàng thật. Cơ chế
 *  `stripSizeSuffix()` cũ (db.ts) chỉ xử lý ĐÚNG 1 CHIỀU (có "C" → bỏ "C")
 *  nên KHÔNG bắt được case ngược này, và cũng không tổng quát cho các cặp
 *  gộp KHÁC "C" (vd "205/50ZR16"+"205/50R16", "P235/75R15"+"235/75R15"...).
 *
 *  Fix: tra ĐÚNG dữ liệu admin đã cấu hình (categoryadmin) thay vì đoán bằng
 *  regex — tổng quát cho MỌI cặp đã gộp, đúng cả 2 chiều, tự động cập nhật
 *  khi admin gộp thêm size mới, không cần sửa code.
 *
 *  VÌ SAO CACHE RAM, KHÔNG QUERY TRỰC TIẾP MỖI LƯỢT CHAT
 *  `fetchTireCatalog` có thể gọi tới 5 lần/lượt chat (ward → tỉnh → bỏ
 *  brand → gara ưu tiên → toàn quốc) — tra DB mỗi lần sẽ cộng thêm round-trip
 *  không cần thiết vào latency. Bảng chỉ ~442 dòng SIZE/TIRE (tính tới
 *  2026-09-16) — load hết vào RAM, refresh định kỳ. Cùng idiom với
 *  `priorityGarage.ts` (setInterval + start/stop + status object).
 *
 *  AN TOÀN KHI FETCH LỖI: giữ NGUYÊN cache cũ, chỉ log lỗi.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { supabaseAmin } from './supabase'

const REFRESH_MS = Number(process.env.TIRE_SIZE_MERGE_REFRESH_MS ?? 1_800_000) // 30 phút

/** sub_key/key (UPPERCASE, đã convert "/"→"_") -> key nhóm thật (categoryadmin.key). */
let keyByAlias = new Map<string, string>()
let timer: NodeJS.Timeout | null = null

const stats = {
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
      .from('categoryadmin')
      .select('key, sub_key')
      .eq('type', 'SIZE')
      .eq('category', 'TIRE')

    if (error) throw error

    const map = new Map<string, string>()
    for (const row of data ?? []) {
      const key = (row.key as string | null)?.trim().toUpperCase()
      if (!key) continue
      const subKey = (row.sub_key as string | null)?.trim().toUpperCase() || key
      map.set(key, key)
      map.set(subKey, key)
    }
    keyByAlias = map
    stats.count = map.size
    stats.lastSuccessAt = new Date().toISOString()
    stats.lastError = null
    console.log(`[tireSizeMerge] refreshed — ${map.size} alias entries`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    stats.lastError = msg
    console.error(
      `[tireSizeMerge] refresh lỗi, GIỮ NGUYÊN cache cũ (${keyByAlias.size} entries):`,
      msg
    )
  }
}

/**
 * Đọc đồng bộ, KHÔNG await — dùng ở mọi call site trong luồng chat/fetch DB.
 * @param naiveSizeKey Size đã convert "/"→"_" (vd "195_70R15", không phân
 *   biệt hoa/thường). Trả về `key` nhóm THẬT (đúng giá trị productadmin.SIZE)
 *   nếu categoryadmin có dòng khớp `sub_key` HOẶC `key` — `null` nếu size
 *   này chưa từng được khai báo qua categoryadmin (dùng nguyên văn làm fallback).
 */
export function resolveMergedTireSizeKey(naiveSizeKey: string): string | null {
  return keyByAlias.get(naiveSizeKey.toUpperCase()) ?? null
}

export function getTireSizeMergeStatus() {
  return { ...stats, count: keyByAlias.size }
}

export function startTireSizeMergeCache(): void {
  if (timer) return
  stats.startedAt = new Date().toISOString()
  stats.running = true
  console.log(`[tireSizeMerge] bật — refresh mỗi ${REFRESH_MS}ms`)
  // Load ngay lúc start — KHÔNG đợi hết 30 phút mới có dữ liệu đầu tiên.
  loadOnce().catch(e => console.error('[tireSizeMerge] load lần đầu lỗi:', e))
  timer = setInterval(() => {
    loadOnce().catch(e => console.error('[tireSizeMerge] lỗi ngoài dự kiến:', e))
  }, REFRESH_MS)
}

export function stopTireSizeMergeCache(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
    stats.running = false
  }
}
