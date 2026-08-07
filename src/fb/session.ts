import { supabaseAmin } from './supabase'
import type {
  ConversationMessage,
  FbSession,
  MessengerStep,
  SessionState
} from './types'

const TABLE = 'fb_messenger_sessions'

export async function getActiveSession(
  psid: string,
  pageId: string
): Promise<FbSession | null> {
  const { data, error } = await supabaseAmin
    .from(TABLE)
    .select('*')
    .eq('psid', psid)
    .eq('page_id', pageId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[FB session] getActiveSession error:', error)
    return null
  }
  return (data as FbSession) ?? null
}

/**
 * Lấy session mới nhất theo psid+pageId — KHÔNG filter `is_active`.
 * Dùng để revive session đã COMPLETED khi user click "Chọn sản phẩm này"
 * (state cũ vẫn giữ → re-use province_code, product_ids... đã lưu).
 */
export async function getLatestSession(
  psid: string,
  pageId: string
): Promise<FbSession | null> {
  const { data, error } = await supabaseAmin
    .from(TABLE)
    .select('*')
    .eq('psid', psid)
    .eq('page_id', pageId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[FB session] getLatestSession error:', error)
    return null
  }
  return (data as FbSession) ?? null
}

export async function createSession(
  psid: string,
  pageId: string
): Promise<FbSession> {
  const { data, error } = await supabaseAmin
    .from(TABLE)
    .insert({
      psid,
      page_id: pageId,
      step: 'WELCOME' as MessengerStep,
      state: {} as SessionState,
      is_active: true,
      is_paused_by_cskh: false
    })
    .select()
    .single()

  if (error) throw new Error(`[FB session] createSession: ${error.message}`)
  return data as FbSession
}

export async function updateSession(
  sessionId: string,
  updates: Partial<
    Pick<
      FbSession,
      | 'step'
      | 'state'
      | 'is_active'
      | 'is_paused_by_cskh'
      | 'paused_by_cskh_at'
    >
  > & {
    is_error?: boolean
    bot_owns_thread?: boolean
  }
): Promise<void> {
  const { error } = await supabaseAmin
    .from(TABLE)
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', sessionId)

  if (error) console.error('[FB session] updateSession error:', error)
}

/**
 * Đánh dấu bot đang giữ thread cho session này (sau khi take_thread_control thành công).
 * Cron pass-back sẽ query các session có bot_owns_thread=true.
 */
export async function setBotOwnsThread(
  sessionId: string,
  owns: boolean
): Promise<void> {
  console.log('setBotOwnsThread', {
    sessionId,
    owns
  })
  await updateSession(sessionId, { bot_owns_thread: owns })
}

/**
 * Đánh dấu session bị lỗi gửi message (vd FB reject vì bot không giữ thread).
 * Cũng append 1 log entry mô tả lỗi để debug.
 */
export async function markSessionError(
  sessionId: string,
  errorText: string
): Promise<void> {
  await updateSession(sessionId, { is_error: true })
  await appendConversationLog(sessionId, {
    role: 'system',
    type: 'system',
    text: `[ERROR] ${errorText}`,
    ts: new Date().toISOString()
  })
}

/**
 * Lấy tất cả session đang được bot giữ thread (cron pass-back sẽ chạy qua list này).
 * Limit page_id vì mỗi page có Primary khác nhau.
 */
export async function getSessionsOwnedByBot(
  pageId: string
): Promise<FbSession[]> {
  const { data, error } = await supabaseAmin
    .from(TABLE)
    .select('*')
    .eq('page_id', pageId)
    .eq('bot_owns_thread', true)

  if (error) {
    console.error('[FB session] getSessionsOwnedByBot error:', error)
    return []
  }
  return (data as FbSession[]) ?? []
}

/**
 * CSKH (page admin) đã reply thủ công → đánh dấu session là:
 *  - `is_paused_by_cskh = true`   → bot bỏ qua mọi tin nhắn user gửi sau đó
 *  - `is_active = false`          → coi như đã kết thúc phiên (mọi nơi check active đều ignore)
 *  - `step = 'PAUSED_BY_CSKH'`    → marker rõ ràng cho debug
 *  - `paused_by_cskh_at = now`    → mốc để tự động hết hạn sau `CSKH_PAUSE_EXPIRY_MS`
 *
 * Sau khi pause: dispatcher dùng `getLatestSession` để bắt cả session inactive,
 * nếu thấy is_paused_by_cskh (VÀ chưa hết hạn — xem `resolveEffectiveSession`)
 * → bot stay silent cho PSID đó (không tạo phiên mới, không gửi welcome).
 */
export async function pauseSessionByCskh(sessionId: string): Promise<void> {
  await updateSession(sessionId, {
    is_paused_by_cskh: true,
    is_active: false,
    step: 'PAUSED_BY_CSKH',
    paused_by_cskh_at: new Date().toISOString()
  })
}

export async function completeSession(sessionId: string): Promise<void> {
  await updateSession(sessionId, { is_active: false, step: 'COMPLETED' })
}

/**
 * Pause CSKH KHÔNG được tồn tại vĩnh viễn — nếu CSKH pause rồi không quay lại
 * follow-up thêm lần nào trong `CSKH_PAUSE_EXPIRY_MS` (hiện = 8 tiếng), bot
 * PHẢI tự động hoạt động lại cho PSID đó, tránh im lặng oan với khách hàng
 * (bug thật: khách hỏi tiếp sau nhiều ngày, session vẫn `is_paused_by_cskh`
 * từ lần CSKH engage trước đó → bot không bao giờ trả lời nữa).
 *
 * Lưu ý: mỗi lần CSKH thực sự reply thêm (`pauseSessionByCskh` gọi lại) sẽ
 * làm mới `paused_by_cskh_at` → đồng hồ 8h tính lại từ lần CSKH gần nhất,
 * KHÔNG phải từ lần pause đầu tiên.
 */
export const CSKH_PAUSE_EXPIRY_MS = 8 * 60 * 60 * 1000 // 8 tiếng

export function isPauseExpired(
  session: Pick<FbSession, 'is_paused_by_cskh' | 'paused_by_cskh_at'>
): boolean {
  if (!session.is_paused_by_cskh || !session.paused_by_cskh_at) return false
  return (
    Date.now() - new Date(session.paused_by_cskh_at).getTime() >
    CSKH_PAUSE_EXPIRY_MS
  )
}

/**
 * Gọi NGAY SAU mỗi lần fetch session ở các điểm quyết định "bot có nên im
 * lặng vì đang pause_by_cskh không" — nếu pause đã hết hạn, tự động unpause
 * TRONG DB (is_paused_by_cskh=false, is_active=true, step='V3_GATHERING',
 * paused_by_cskh_at=null) và trả về session đã cập nhật để code gọi tiếp xử
 * lý như session bình thường (tin nhắn khách lần này được xử lý ngay, không
 * cần đợi thêm 1 lượt). Trả nguyên session nếu null hoặc chưa hết hạn.
 */
export async function resolveEffectiveSession(
  session: FbSession | null
): Promise<FbSession | null> {
  if (!session || !isPauseExpired(session)) return session
  console.log(
    `[FB session] pause_by_cskh session=${session.id} đã quá hạn ${CSKH_PAUSE_EXPIRY_MS / 3600000}h (paused_at=${session.paused_by_cskh_at}) → tự động unpause`
  )
  await updateSession(session.id, {
    is_paused_by_cskh: false,
    is_active: true,
    step: 'V3_GATHERING',
    paused_by_cskh_at: null
  })
  return {
    ...session,
    is_paused_by_cskh: false,
    is_active: true,
    step: 'V3_GATHERING',
    paused_by_cskh_at: null
  }
}

/**
 * Khoảng cách tối đa giữa 2 tin nhắn TRONG CÙNG 1 session — quá mốc này,
 * session bị coi là "nguội" (stale) và PHẢI tách sang session mới khi khách
 * nhắn tiếp, thay vì tiếp tục cộng dồn vào `conversation_log` cũ. Lý do:
 * `conversation_log` được feed thẳng vào AI (`recentHistory()`) làm ngữ cảnh
 * — nếu 1 session kéo dài nhiều ngày/tuần, log cũ (đã hoàn toàn không liên
 * quan tới nhu cầu HIỆN TẠI của khách) có thể khiến AI hiểu nhầm ngữ cảnh.
 */
export const SESSION_SPLIT_GAP_MS = 24 * 60 * 60 * 1000 // 24 tiếng

export function isSessionStale(session: Pick<FbSession, 'updated_at'>): boolean {
  return Date.now() - new Date(session.updated_at).getTime() > SESSION_SPLIT_GAP_MS
}

/**
 * Field "thông tin ĐÃ THU THẬP" — PHẢI chuyển nguyên vẹn sang session mới khi
 * tách. KHÔNG bao gồm field ephemeral/turn-scoped (fail counter,
 * car_model_attempts, last_shown_car_sizes, shown_*, cskh_reason,
 * size_suggestions...) — những field đó gắn chặt với 1 tin nhắn CỤ THỂ trong
 * log cũ (vd `last_shown_car_sizes` trỏ tới 1 tin bot hỏi "xác nhận size"
 * mà giờ không còn trong log mới) — giữ lại sẽ gây khớp nhầm/nhầm lẫn ngữ
 * cảnh, đúng thứ session-split này cố tránh.
 */
function pickCarryOverState(state: SessionState): SessionState {
  return {
    car_model: state.car_model,
    tire_size: state.tire_size,
    brand_tier: state.brand_tier,
    selected_brands: state.selected_brands,
    max_price: state.max_price,
    wants_best_quality: state.wants_best_quality,
    province_code: state.province_code,
    province_name: state.province_name,
    ward_code: state.ward_code,
    ward_name: state.ward_name,
    phone: state.phone
  }
}

/**
 * Nếu session hiện tại đã nguội (>`SESSION_SPLIT_GAP_MS`, xem `isSessionStale`)
 * → tách sang session MỚI: các field "đã thu thập" (`pickCarryOverState`)
 * được chuyển nguyên vẹn, nhưng `conversation_log` bắt đầu lại từ đầu (tránh
 * log rác cũ feed vào AI). Session cũ được đánh dấu `COMPLETED` (giữ lại,
 * không xoá — vẫn tra cứu/debug được qua `getLatestSession`).
 *
 * Trả về session MỚI nếu đã tách, hoặc nguyên session gốc nếu chưa đủ nguội.
 * Gọi NGAY SAU khi fetch session active, TRƯỚC khi dùng cho bất kỳ xử lý gì.
 */
export async function splitStaleSession(session: FbSession): Promise<FbSession> {
  if (!isSessionStale(session)) return session
  const carriedState = pickCarryOverState(session.state)
  console.log(
    `[FB session] session=${session.id} nguội quá ${SESSION_SPLIT_GAP_MS / 3600000}h (updated_at=${session.updated_at}) → tách session mới, chuyển state: ${JSON.stringify(carriedState)}`
  )
  await updateSession(session.id, { is_active: false, step: 'COMPLETED' })
  const fresh = await createSession(session.psid, session.page_id)
  await updateSession(fresh.id, { step: 'V3_GATHERING', state: carriedState })
  return { ...fresh, step: 'V3_GATHERING', state: carriedState }
}

/**
 * Append một tin nhắn vào conversation_log.
 * Nếu `message.step` không được truyền, sẽ auto-fill bằng `step` hiện tại của session.
 */
export async function appendConversationLog(
  sessionId: string,
  message: ConversationMessage
): Promise<void> {
  const { data } = await supabaseAmin
    .from(TABLE)
    .select('conversation_log, step')
    .eq('id', sessionId)
    .single()

  const current = (data?.conversation_log as ConversationMessage[]) ?? []
  current.push({
    ...message,
    step: message.step ?? (data?.step as string | undefined) ?? ''
  })

  const { error } = await supabaseAmin
    .from(TABLE)
    .update({ conversation_log: current, updated_at: new Date().toISOString() })
    .eq('id', sessionId)

  if (error) console.error('[FB session] appendConversationLog error:', error)
}

/** Xóa toàn bộ session của một user — dùng cho lệnh /reset khi test. */
export async function resetUserSessions(
  psid: string,
  pageId: string
): Promise<void> {
  const { error } = await supabaseAmin
    .from(TABLE)
    .delete()
    .eq('psid', psid)
    .eq('page_id', pageId)

  if (error) console.error('[FB session] resetUserSessions error:', error)
}

/** Xóa các session cũ hơn 7 ngày — gọi bởi cron job. */
export async function clearOldSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { count, error } = await supabaseAmin
    .from(TABLE)
    .delete({ count: 'exact' })
    .lt('updated_at', cutoff)

  if (error) {
    console.error('[FB session] clearOldSessions error:', error)
    return 0
  }
  return count ?? 0
}
