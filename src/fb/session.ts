import { supabaseAmin } from './supabase'
import type { ConversationMessage, FbSession, MessengerStep, SessionState } from './types'

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
  updates: Partial<Pick<FbSession, 'step' | 'state' | 'is_active' | 'is_paused_by_cskh'>>
): Promise<void> {
  const { error } = await supabaseAmin
    .from(TABLE)
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', sessionId)

  if (error) console.error('[FB session] updateSession error:', error)
}

/**
 * CSKH (page admin) đã reply thủ công → đánh dấu session là:
 *  - `is_paused_by_cskh = true`   → bot bỏ qua mọi tin nhắn user gửi sau đó
 *  - `is_active = false`          → coi như đã kết thúc phiên (mọi nơi check active đều ignore)
 *  - `step = 'PAUSED_BY_CSKH'`    → marker rõ ràng cho debug
 *
 * Sau khi pause: dispatcher dùng `getLatestSession` để bắt cả session inactive,
 * nếu thấy is_paused_by_cskh → bot stay silent vĩnh viễn cho PSID đó
 * (không tạo phiên mới, không gửi welcome).
 */
export async function pauseSessionByCskh(sessionId: string): Promise<void> {
  await updateSession(sessionId, {
    is_paused_by_cskh: true,
    is_active: false,
    step: 'PAUSED_BY_CSKH'
  })
}

export async function completeSession(sessionId: string): Promise<void> {
  await updateSession(sessionId, { is_active: false, step: 'COMPLETED' })
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
export async function resetUserSessions(psid: string, pageId: string): Promise<void> {
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
