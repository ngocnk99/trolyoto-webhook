-- Migration: add is_error + bot_owns_thread to fb_messenger_sessions
-- Khi sendMessage API lỗi (vd bot chưa take_thread_control) → is_error=true + log error vào conversation_log.
-- Khi bot take_thread_control thành công → bot_owns_thread=true. Cron 8:30 sẽ pass back tất cả session có bot_owns_thread=true.

ALTER TABLE fb_messenger_sessions
  ADD COLUMN IF NOT EXISTS is_error BOOLEAN DEFAULT false;

ALTER TABLE fb_messenger_sessions
  ADD COLUMN IF NOT EXISTS bot_owns_thread BOOLEAN DEFAULT false;

-- Index cho cron query "lấy session bot đang giữ" — nhanh hơn full scan.
CREATE INDEX IF NOT EXISTS idx_fb_sessions_bot_owns_thread
  ON fb_messenger_sessions (page_id, bot_owns_thread)
  WHERE bot_owns_thread = true;
