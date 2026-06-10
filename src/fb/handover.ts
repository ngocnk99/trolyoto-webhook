/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Facebook Messenger Handover Protocol helpers
 *
 *  Khi page có 1 Primary Receiver (vd Pancake CRM) + bot là Secondary, bot KHÔNG
 *  thể gửi message API cho khách trừ khi:
 *    1) Bot tự gọi `take_thread_control` → FB cấp quyền cho bot trên thread này
 *    2) Primary chủ động `pass_thread_control` sang bot
 *
 *  Module này expose:
 *    - takeThreadControl(psid, pageId, metadata?) → bot chiếm thread
 *    - passThreadControl(psid, pageId, targetAppId?, metadata?) → trả thread cho Primary
 *    - getPancakeAppId(pageId) → auto-discover app_id Primary qua /me/secondary_receivers
 *
 *  Token được pick theo pageId qua tokenForPageId() (cùng convention với v3/flow-handler).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const FB_GRAPH_VERSION = 'v21.0'
const FB_API_BASE = `https://graph.facebook.com/${FB_GRAPH_VERSION}`

const FB_PAGE_ID_V3 = process.env.FB_PAGE_ID_V3 ?? ''
const FB_PAGE_ID_PRODUCT = process.env.FACEBOOK_PAGE_ID_PRODUCT ?? ''
const FB_TOKEN_V3 = process.env.FB_PAGE_ACCESS_TOKEN ?? ''
const FB_TOKEN_PRODUCT = process.env.FB_PAGE_ACCESS_TOKEN_PRODUCT ?? FB_TOKEN_V3
const FB_APP_ID = process.env.FB_APP_ID ?? ''

function tokenForPageId(pageId: string): string {
  if (pageId === FB_PAGE_ID_PRODUCT) return FB_TOKEN_PRODUCT
  if (pageId === FB_PAGE_ID_V3) return FB_TOKEN_V3
  return FB_TOKEN_V3
}

/** Cache Primary Receiver app_id của từng page (auto-discover qua /me/secondary_receivers). */
const primaryAppIdCache = new Map<string, string>()

/**
 * Tìm app_id của Primary Receiver bằng cách query secondary_receivers + loại bot ra.
 * App nào trong list mà KHÔNG phải bot → đó là Primary (= Pancake hoặc tool tương đương).
 *
 * Nếu chỉ có 1 receiver trong list (bot) → page chưa có Primary khác → trả null.
 */
export async function getPrimaryAppId(pageId: string): Promise<string | null> {
  if (primaryAppIdCache.has(pageId)) {
    return primaryAppIdCache.get(pageId) ?? null
  }

  const token = tokenForPageId(pageId)
  const url = `${FB_API_BASE}/me/secondary_receivers?fields=id,name&access_token=${token}`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      const text = await res.text()
      console.error(
        `[handover] getPrimaryAppId page=${pageId} error ${res.status}:`,
        text
      )
      return null
    }
    const json: { data?: Array<{ id: string; name?: string }> } = await res.json()
    const receivers = json.data ?? []
    console.log(
      `[handover] secondary_receivers page=${pageId}:`,
      receivers.map(r => `${r.name ?? '?'}#${r.id}`).join(', ')
    )
    const primary = receivers.find(r => r.id !== FB_APP_ID)
    if (primary) {
      primaryAppIdCache.set(pageId, primary.id)
      console.log(
        `[handover] Primary discovered for page=${pageId}: ${primary.name ?? '?'}#${primary.id}`
      )
      return primary.id
    }
    return null
  } catch (e) {
    console.error('[handover] getPrimaryAppId exception:', e)
    return null
  }
}

/**
 * Bot chiếm thread cho 1 PSID. Trả về true nếu thành công.
 * Sau khi success, mọi `sendMessage(psid)` sẽ work bình thường.
 */
export async function takeThreadControl(
  psid: string,
  pageId: string,
  metadata = 'bot_take_for_reply'
): Promise<boolean> {
  const token = tokenForPageId(pageId)
  const url = `${FB_API_BASE}/me/take_thread_control?access_token=${token}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, metadata })
    })
    if (!res.ok) {
      const text = await res.text()
      // Error 27 / subcode 1893035 = "App requesting thread control đã có quyền".
      //  Bot đã giữ thread (vd hop_context trước đó) → coi như success luôn.
      let subcode: number | undefined
      try {
        subcode = JSON.parse(text)?.error?.error_subcode
      } catch {
        // bỏ qua
      }
      if (subcode === 1893035) {
        console.log(
          `[handover] take_thread_control psid=${psid} page=${pageId}: bot đã giữ thread sẵn (subcode=1893035) → treat as success`
        )
        return true
      }
      console.error(
        `[handover] take_thread_control psid=${psid} page=${pageId} error ${res.status}:`,
        text
      )
      return false
    }
    const json: { success?: boolean } = await res.json()
    console.log(
      `[handover] take_thread_control OK psid=${psid} page=${pageId} (success=${json.success})`
    )
    return json.success === true
  } catch (e) {
    console.error('[handover] take_thread_control exception:', e)
    return false
  }
}

/**
 * Trả thread về cho Primary (Pancake). Nếu không truyền targetAppId → auto-discover.
 * Trả về true nếu thành công.
 */
export async function passThreadControl(
  psid: string,
  pageId: string,
  targetAppId?: string,
  metadata = 'bot_pass_back_to_primary'
): Promise<boolean> {
  const token = tokenForPageId(pageId)
  let target = targetAppId
  if (!target) {
    target = (await getPrimaryAppId(pageId)) ?? undefined
  }
  if (!target) {
    console.warn(
      `[handover] pass_thread_control psid=${psid}: không có target app_id → skip (Primary chưa setup?)`
    )
    return false
  }

  const url = `${FB_API_BASE}/me/pass_thread_control?access_token=${token}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: psid },
        target_app_id: target,
        metadata
      })
    })
    if (!res.ok) {
      const text = await res.text()
      console.error(
        `[handover] pass_thread_control psid=${psid} page=${pageId} → app=${target} error ${res.status}:`,
        text
      )
      return false
    }
    const json: { success?: boolean } = await res.json()
    console.log(
      `[handover] pass_thread_control OK psid=${psid} page=${pageId} → app=${target} (success=${json.success})`
    )
    return json.success === true
  } catch (e) {
    console.error('[handover] pass_thread_control exception:', e)
    return false
  }
}
