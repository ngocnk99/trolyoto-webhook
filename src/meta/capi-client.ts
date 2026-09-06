/**
 * Gửi sự kiện sang Meta Conversions API.
 *
 * Dùng `fetch` thuần theo đúng khuôn `src/fb/client.ts`: trả object kết quả thay
 * vì throw, để vòng lặp outbox tự quyết định retry hay bỏ.
 *
 * ⚠️ `src/ai/usage-log.ts` vá `globalThis.fetch` ở module scope (main.ts gọi
 * trước bootstrap). Mọi request ở đây cũng đi qua wrapper đó — nó chỉ ghi log
 * khi host là api.openai.com nên hành vi không đổi, nhưng cần biết khi debug.
 */
const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v21.0'
const PIXEL_ID = process.env.META_PIXEL_ID ?? ''
const ACCESS_TOKEN = process.env.META_CAPI_ACCESS_TOKEN ?? ''
/** Chỉ đặt khi đang test. Còn biến này thì sự kiện KHÔNG vào báo cáo thật. */
const TEST_EVENT_CODE = process.env.META_CAPI_TEST_EVENT_CODE ?? ''

export type CapiUserData = {
  em?: string
  ph?: string
  external_id?: string
  fbc?: string
  fbp?: string
  client_ip_address?: string
  client_user_agent?: string
}

export type CapiEvent = {
  event_name: string
  event_time: number
  event_id: string
  event_source_url?: string | null
  action_source: 'website'
  user_data: CapiUserData
  custom_data: {
    value: number
    currency: string
    content_type?: string
    content_ids?: string[]
    contents?: { id: string; quantity: number; item_price: number }[]
    num_items?: number
    order_id?: string
  }
}

export type CapiResult = {
  ok: boolean
  status: number
  eventsReceived?: number
  fbTraceId?: string
  error?: string
  /** Lỗi cấu hình (token sai/hết hạn, pixel sai) — retry vô nghĩa. */
  fatal?: boolean
}

export function isCapiConfigured(): boolean {
  return Boolean(PIXEL_ID && ACCESS_TOKEN)
}

export function capiConfigSummary() {
  return {
    graphVersion: GRAPH_VERSION,
    pixelId: PIXEL_ID || null,
    // Chỉ báo CÓ/KHÔNG, tuyệt đối không trả giá trị token.
    hasAccessToken: Boolean(ACCESS_TOKEN),
    testMode: Boolean(TEST_EVENT_CODE)
  }
}

export async function sendCapiEvents(events: CapiEvent[]): Promise<CapiResult> {
  if (!isCapiConfigured()) {
    return {
      ok: false,
      status: 0,
      error: 'Thiếu META_PIXEL_ID hoặc META_CAPI_ACCESS_TOKEN',
      fatal: true
    }
  }
  if (!events.length) return { ok: true, status: 200, eventsReceived: 0 }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PIXEL_ID}/events`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: events,
        access_token: ACCESS_TOKEN,
        ...(TEST_EVENT_CODE ? { test_event_code: TEST_EVENT_CODE } : {})
      })
    })

    const body: any = await res.json().catch(() => ({}))

    if (!res.ok || body?.error) {
      const code = body?.error?.code
      // 190 = token hỏng/hết hạn, 200 = thiếu quyền, 100 với subcode 33 = sai
      // pixel id. Ba nhóm này retry bao nhiêu lần cũng vẫn hỏng.
      const fatal = code === 190 || code === 200 || code === 803
      return {
        ok: false,
        status: res.status,
        error:
          body?.error?.message ||
          `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`,
        fbTraceId: body?.error?.fbtrace_id,
        fatal
      }
    }

    return {
      ok: true,
      status: res.status,
      eventsReceived: body?.events_received ?? events.length,
      fbTraceId: body?.fbtrace_id
    }
  } catch (error: any) {
    // Lỗi mạng -> để cron thử lại ở vòng sau.
    return { ok: false, status: 0, error: error?.message || 'fetch lỗi' }
  }
}
