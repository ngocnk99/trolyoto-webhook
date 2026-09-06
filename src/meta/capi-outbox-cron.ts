import { supabaseAmin } from '../fb/supabase'
import {
  CapiEvent,
  capiConfigSummary,
  isCapiConfigured,
  sendCapiEvents
} from './capi-client'

/**
 * Đọc `meta_capi_outbox` và gửi sang Meta Conversions API.
 *
 * Khuôn lấy từ `src/cache/cache-outbox-cron.ts` (claim qua RPC, đếm attempts,
 * phơi trạng thái ra /version) nhưng CỐ Ý BỎ hai thứ của bản gốc:
 *
 * - KHÔNG quiet-hours: chuyển đổi phải tới Meta càng sớm càng tốt. Cửa sổ khử
 *   trùng lặp của Meta là 48h nhưng khuyến nghị dưới 1h, và sự kiện tới muộn
 *   thì mất tác dụng tối ưu quảng cáo.
 * - KHÔNG min-gap: bài toán của cache-outbox là tiết kiệm ISR Writes của Vercel;
 *   ở đây không có chi phí nào theo lượt gọi để phải dồn.
 *
 * Vì sao có outbox thay vì gọi thẳng lúc tạo đơn: không đem độ trễ và sự cố của
 * Graph API vào đường đặt hàng của khách.
 */
const INTERVAL_MS = Number(process.env.META_CAPI_INTERVAL_MS ?? 60_000)
const BATCH_SIZE = Number(process.env.META_CAPI_BATCH ?? 50)
const MAX_ATTEMPTS = Number(process.env.META_CAPI_MAX_ATTEMPTS ?? 5)

type OutboxRow = {
  id: number
  event_id: string
  event_name: string
  event_time: string
  event_source_url: string | null
  order_ids: string[]
  value: number | string
  currency: string
  contents: { id: string; quantity: number; item_price: number }[] | null
  user_data: Record<string, string> | null
}

const stats = {
  startedAt: new Date().toISOString(),
  running: false,
  lastRunAt: null as string | null,
  lastSuccessAt: null as string | null,
  lastError: null as string | null,
  lastSkipReason: null as string | null,
  runs: 0,
  sent: 0,
  failed: 0
}

export function getMetaCapiStatus() {
  return {
    ...stats,
    ...capiConfigSummary(),
    intervalMs: INTERVAL_MS,
    batchSize: BATCH_SIZE,
    maxAttempts: MAX_ATTEMPTS
  }
}

function toCapiEvent(row: OutboxRow): CapiEvent {
  const contents = row.contents ?? []
  return {
    event_name: row.event_name || 'Purchase',
    event_time: Math.floor(new Date(row.event_time).getTime() / 1000),
    // Trùng với `eventID` của pixel -> Meta gộp hai bản làm một.
    event_id: row.event_id,
    event_source_url: row.event_source_url || undefined,
    action_source: 'website',
    user_data: (row.user_data ?? {}) as CapiEvent['user_data'],
    custom_data: {
      value: Number(row.value) || 0,
      currency: row.currency || 'VND',
      content_type: 'product',
      content_ids: contents.map(item => String(item.id)),
      contents,
      num_items: contents.reduce((total, item) => total + (item.quantity || 1), 0),
      order_id: row.event_id
    }
  }
}

export async function flushOnce(): Promise<{ sent: number; failed: number }> {
  stats.runs += 1
  stats.lastRunAt = new Date().toISOString()

  if (!isCapiConfigured()) {
    stats.lastSkipReason = 'chưa cấu hình META_PIXEL_ID / META_CAPI_ACCESS_TOKEN'
    return { sent: 0, failed: 0 }
  }
  stats.lastSkipReason = null

  const { data: rows, error } = await supabaseAmin.rpc('meta_capi_claim', {
    p_limit: BATCH_SIZE,
    p_max_attempts: MAX_ATTEMPTS
  })

  if (error) {
    stats.lastError = `claim lỗi: ${error.message}`
    console.error('[meta-capi] claim outbox lỗi:', error.message)
    return { sent: 0, failed: 0 }
  }

  const batch = (rows ?? []) as OutboxRow[]
  if (!batch.length) return { sent: 0, failed: 0 }

  // Gửi từng sự kiện một chứ không gộp cả lô vào một request: Meta trả lỗi ở
  // cấp request, gộp lại thì một sự kiện hỏng kéo cả lô phải thử lại và bị đếm
  // attempts oan.
  let sent = 0
  let failed = 0

  for (const row of batch) {
    const result = await sendCapiEvents([toCapiEvent(row)])

    if (result.ok) {
      sent += 1
      await supabaseAmin
        .from('meta_capi_outbox')
        .update({
          sent_at: new Date().toISOString(),
          last_error: null,
          fb_trace_id: result.fbTraceId ?? null
        })
        .eq('id', row.id)
      continue
    }

    failed += 1
    stats.lastError = result.error ?? 'không rõ lỗi'
    console.error(
      `[meta-capi] gửi ${row.event_id} lỗi (HTTP ${result.status}):`,
      result.error
    )

    await supabaseAmin
      .from('meta_capi_outbox')
      .update({
        last_error: (result.error ?? '').slice(0, 500),
        fb_trace_id: result.fbTraceId ?? null,
        // Lỗi cấu hình thì đẩy attempts lên trần luôn: thử lại chỉ tổ đốt quota
        // và làm nhiễu log, người trực phải đi sửa token/pixel.
        ...(result.fatal ? { attempts: MAX_ATTEMPTS } : {})
      })
      .eq('id', row.id)
  }

  stats.sent += sent
  stats.failed += failed
  if (sent) stats.lastSuccessAt = new Date().toISOString()

  return { sent, failed }
}

let timer: NodeJS.Timeout | null = null

export function startMetaCapiCron(): void {
  if (timer) return

  console.log(
    `[meta-capi] bật — poll ${INTERVAL_MS}ms, lô ${BATCH_SIZE}, tối đa ${MAX_ATTEMPTS} lần thử` +
      (isCapiConfigured() ? '' : ' (CHƯA có token, sẽ bỏ qua mọi vòng)')
  )

  stats.running = true
  timer = setInterval(() => {
    flushOnce().catch(e => console.error('[meta-capi] lỗi ngoài dự kiến:', e))
  }, INTERVAL_MS)
}

export function stopMetaCapiCron(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
    stats.running = false
  }
}
