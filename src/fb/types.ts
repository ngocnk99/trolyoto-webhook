export type MessengerStep =
  | 'WELCOME'
  | 'AWAITING_CONSULT_TYPE'
  // ── Nhánh CSKH (Tư vấn kĩ) ─────────────────────────────────────────────
  | 'AWAITING_AREA_FOR_CSKH'      // CSKH: hỏi khu vực
  | 'AWAITING_SIZE_FOR_CSKH'      // V2: CSKH trong giờ — hỏi thêm kích cỡ
  // ── Nhánh Trợ lý ảo — kích cỡ (AI-first) ───────────────────────────────
  | 'AWAITING_TIRE_SIZE'          // V2: khách gõ tự do, AI phân loại size/xe
  | 'AWAITING_SIZE_CONFIRM'       // V2: hiển thị gợi ý kích cỡ + "❌ Không đúng"
  // ── Thương hiệu (AI-first) ─────────────────────────────────────────────
  | 'AWAITING_BRAND'              // V2: khách gõ tự do, AI trích nhu cầu
  | 'AWAITING_BRAND_CONFIRM'      // V2: fallback 3 tier khi AI không hiểu
  // ── Kết quả & vị trí ───────────────────────────────────────────────────
  | 'SHOWING_RESULTS_NATIONAL'    // V2: carousel SP toàn quốc (+ timer 15s)
  | 'AWAITING_LOCATION'           // hỏi khu vực
  | 'SHOWING_RESULTS_LOCAL'       // V2: carousel SP-gara theo khu vực
  | 'AWAITING_BOOKING_STATE'      // V2: Đã đặt lịch / Chưa cần thay / Còn băn khoăn (+ timer 45s)
  | 'AWAITING_CONCERN'            // V2: Giá tốt hơn / Đại lý gần hơn
  // ── Handoff CSKH ───────────────────────────────────────────────────────
  | 'AWAITING_CSKH_CHANNEL'       // V2: chờ chọn "Chờ ở đây" / "Để lại SĐT"
  | 'AWAITING_PHONE'              // V2: chờ khách nhập số điện thoại
  // ── Legacy (giữ cho session cũ trong DB) ───────────────────────────────
  | 'AWAITING_TIRE_SIZE_AFTER_CSKH'
  | 'AWAITING_CAR_TIRE_CONFIRM'
  | 'SHOWING_RESULTS'
  | 'SHOWING_DEALERS'
  | 'AWAITING_FOLLOW_UP'
  | 'COMPLETED'
  | 'PAUSED_BY_CSKH'

export type BrandTier = 'premium' | 'balanced' | 'budget' | 'all'

export interface SessionState {
  consult_type?: 'AI' | 'CSKH'
  area?: string
  car_model?: string
  tire_size?: string
  min_price?: number               // giá thấp nhất DB trả về (dùng cho Step 5)
  brand_tier?: BrandTier
  selected_brands?: string[]
  product_ids?: string[]
  province_code?: string | null
  province_name?: string | null
  total_product_count?: number
  shown_national?: boolean         // đã show kết quả toàn quốc rồi (dùng cho Step 13)
  /** Số lần liên tiếp user gửi free text không match được vào option ở step có button.
   *  Sau khi đạt ngưỡng (MAX_FAILED_ATTEMPTS) → bot reset về welcome. */
  failed_attempts?: number

  // ── V2 ────────────────────────────────────────────────────────────────────
  /** Số điện thoại khách để lại (nhánh "📞 Để lại SĐT") */
  phone?: string
  /** Lý do chuyển CSKH (debug + cho chuyên viên đọc): vd "không nhận dạng kích cỡ" */
  cskh_reason?: string
  /** Gợi ý kích cỡ đang hiển thị ở AWAITING_SIZE_CONFIRM (để biết bot đoán gì) */
  size_suggestions?: string[]

  // ── Product selection flow ───────────────────────────────────────────────
  /** ID sản phẩm mà user đã click "Chọn sản phẩm này" — dùng cho fetchGarageOffers */
  selected_product_id?: string
  /** Số sản phẩm đã hiển thị cho user (= skip param cho lần "Xem thêm" tiếp theo) */
  shown_product_count?: number

  // ── Garage offer follow-up ───────────────────────────────────────────────
  /** Danh sách garage code đã hiển thị — dùng để de-dup khi user click "Giá tốt hơn" */
  shown_garage_codes?: string[]
  /** Giá thấp nhất trong số garage đã hiển thị — "Giá tốt hơn" chỉ trả garage có finalPrice < giá này */
  shown_garage_min_price?: number
}

export type ConversationMessageType =
  | 'text'          // bot/user: plain text
  | 'quick_replies' // bot: text + danh sách quick reply options
  | 'cards'         // bot: generic template (sản phẩm / đại lý) — ảnh + giá + buttons
  | 'qr_click'      // user: click quick reply / postback button
  | 'system'        // log nội bộ: handoff, pause, reset...

export interface LoggedQuickReply {
  title: string
  payload: string
}

export interface LoggedCardButton {
  title: string
  url?: string
  payload?: string
}

export interface LoggedCard {
  title: string
  subtitle?: string
  image_url?: string
  url?: string
  buttons?: LoggedCardButton[]
}

export interface ConversationMessage {
  role: 'user' | 'bot' | 'system'
  type: ConversationMessageType
  text: string
  /** Bước (`MessengerStep`) tại thời điểm message được tạo. Auto-fill từ session nếu không truyền. */
  step?: string
  ts: string
  quick_replies?: LoggedQuickReply[]
  cards?: LoggedCard[]
  /** Payload khi user click QR/postback */
  payload?: string
}

export interface FbSession {
  id: string
  psid: string
  page_id: string
  step: MessengerStep
  state: SessionState
  conversation_log: ConversationMessage[]
  is_active: boolean
  is_paused_by_cskh: boolean
  created_at: string
  updated_at: string
}

// ── Facebook Messenger webhook payload types ───────────────────────────────

export interface MessengerWebhookBody {
  object: string
  entry: MessengerEntry[]
}

export interface MessengerEntry {
  id: string
  time: number
  messaging?: MessengerEvent[]
  standby?: MessengerEvent[]
}

export interface MessengerEvent {
  sender: { id: string }
  recipient: { id: string }
  timestamp: number
  message?: {
    mid: string
    text?: string
    quick_reply?: { payload: string }
    is_echo?: boolean
    app_id?: number
  }
  postback?: {
    title: string
    payload: string
  }
  optin?: {
    ref: string
    type?: string
  }
  referral?: {
    ref: string
    source: string
    type: string
  }
}

// ── Send API types ─────────────────────────────────────────────────────────

export interface QuickReply {
  content_type: 'text'
  title: string
  payload: string
}

export interface Button {
  type: 'web_url' | 'postback'
  title: string
  url?: string
  payload?: string
}

export interface GenericElement {
  title: string
  subtitle?: string
  image_url?: string
  default_action?: {
    type: 'web_url'
    url: string
    webview_height_ratio?: 'compact' | 'tall' | 'full'
  }
  buttons?: Button[]
}

export interface SendMessagePayload {
  recipient: { id: string }
  messaging_type?: 'RESPONSE' | 'UPDATE' | 'MESSAGE_TAG'
  message: {
    text?: string
    quick_replies?: QuickReply[]
    attachment?: {
      type: 'template'
      payload:
        | { template_type: 'generic'; elements: GenericElement[] }
        | {
            template_type: 'button'
            text: string
            buttons: Button[]
          }
    }
  }
}
