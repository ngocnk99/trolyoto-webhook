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
  // ── V3: AI conversational ──────────────────────────────────────────────
  | 'V3_GATHERING'                // V3: AI thu thập size+brand+province qua chat tự nhiên
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
  /** Ngưỡng giá TỐI ĐA (VND) khách nêu (vd "dưới 2 triệu") — filter THÊM vào
   *  brand_tier/selected_brands nếu có, hoặc lọc theo giá thuần nếu khách
   *  không nêu brand nào. */
  max_price?: number | null
  /** Khách muốn "tốt nhất" mà không chỉ định brand/phân khúc cụ thể — kích
   *  hoạt cascade tìm phân khúc cao nhất đang có hàng tại khu vực khách. */
  wants_best_quality?: boolean
  /** Đã từng show kết quả SP+gara thành công trong session này chưa — dùng để
   *  quyết định có nên reset max_price khi khách đổi size/brand/khu vực hay
   *  không (đổi TRƯỚC lần fetch đầu tiên → giữ giá; đổi SAU khi đã có kết quả
   *  → giá cũ được coi là gắn với tìm kiếm cũ, cần xoá). */
  has_shown_results?: boolean
  /** Các tên xe (đã chuẩn hoá "Hãng Model") đã thử resolveCarModel + show size
   *  options nhưng khách KHÔNG bấm chọn size nào (gửi tin khác thay vào đó) —
   *  coi là "đã xác nhận sai". Dùng làm exclude-list + trigger escalate model
   *  mạnh hơn cho lần resolveCarModel kế tiếp. Reset về [] khi khách chọn 1
   *  size (QR_TIRE_SIZE) hoặc khi resolver cũng chịu (fail hẳn). */
  car_model_attempts?: string[]
  /** Danh sách size vừa show cho khách theo tên xe (`showCarSizeOptions`) —
   *  dùng để LỌC LẠI (client-side, không qua AI) khi khách gõ "vành X"/"la
   *  zăng X" thay vì bấm QR (vd size ['235/55R19','235/60R18'], khách gõ
   *  "vành 18" → chọn '235/60R18'). Reset về [] khi khách đã chọn 1 size
   *  (giống car_model_attempts) để tránh khớp nhầm ở lượt hội thoại sau. */
  last_shown_car_sizes?: string[]
  product_ids?: string[]
  province_code?: string | null
  province_name?: string | null
  total_product_count?: number
  shown_national?: boolean         // đã show kết quả toàn quốc rồi (dùng cho Step 13)

  // ── V3 — ward fallback khi province không resolve được ─────────────────
  /** Mã xã/phường khách xác nhận (vd '13225' = Phường Thái Bình, Hưng Yên).
   *  Khi có ward_code → query gara theo ward_code (chính xác hơn province). */
  ward_code?: string
  ward_name?: string

  // ── V3 — fail counter per step (size / brand / location) ──────────────
  /** Số lần khách trả lời không hiểu ở mỗi step (size/brand/location).
   *  1 → bot hỏi lại lần nữa; ≥2 → CSKH handoff. */
  fail_size?: number
  fail_brand?: number
  fail_location?: number
  /** Số lần liên tiếp user gửi free text không match được vào option ở step có button.
   *  Sau khi đạt ngưỡng (MAX_FAILED_ATTEMPTS) → bot reset về welcome. */
  failed_attempts?: number

  // ── V3 — nudge "thiếu thông tin" (90s hỏi tiếp + 60s mời trợ giá) ──────
  /** Đã gửi bộ nhắc "thiếu thông tin" (90s + 60s) trong session này chưa.
   *  Chỉ gửi 1 LẦN / session — dù khách quay lại trả lời rồi lại im lặng
   *  tiếp thì KHÔNG lặp lại kịch bản này nữa. */
  info_nudge_sent?: boolean

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
  /**
   * true = tin nhắn "hệ thống tự tạo" (danh sách SP/cards, nudge trợ giá tự
   * động theo timer, CTA cộng đồng/khuyến mại) — KHÔNG phải hội thoại thật
   * giữa khách và bot. Set NGAY LÚC GHI LOG (tại nguồn phát sinh: sendCards,
   * sendButtonTemplate, fireInfoNudgeStage1...), KHÔNG suy đoán lại khi đọc.
   * `recentHistory()` lọc bỏ các tin có cờ này trước khi đưa vào AI — tránh
   * AI đọc nhầm số liệu quảng cáo (vd "TRỢ GIÁ tới 800K") thành mức giá
   * khách yêu cầu, hoặc dữ liệu SP cụ thể thành thứ bot "đã nói".
   */
  hidden_from_ai?: boolean
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
  /** Thời điểm session bị pause bởi CSKH gần nhất — dùng để tự động hết hạn
   *  pause sau `CSKH_PAUSE_EXPIRY_MS` (xem session.ts), tránh bot im lặng
   *  vĩnh viễn cho 1 PSID nếu CSKH không quay lại nữa. Null khi chưa từng pause. */
  paused_by_cskh_at?: string | null
  /** Có lỗi gửi message gần nhất (vd FB reject 2018300 — bot không giữ thread). */
  is_error?: boolean
  /** Bot đang giữ thread control sau khi gọi take_thread_control thành công.
   *  Cron pass-back sẽ query session có cờ này = true để trả lại Primary. */
  bot_owns_thread?: boolean
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
  /** FB gắn `hop_context` ở entry-level khi thread vừa được handover sang app nhận.
   *  `app_id` = app đã pass control (hoặc current owner) — dùng để detect Pancake
   *  vừa trả thread cho bot → set bot_owns_thread=true. */
  hop_context?: {
    app_id: number
    metadata?: string
  }
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
    attachments?: Array<{
      type:
        | 'image'
        | 'audio'
        | 'video'
        | 'file'
        | 'location'
        | 'fallback'
        | 'sticker'
        | 'template'
      payload?: {
        url?: string
        /** Có giá trị khi khách gửi sticker (like 👍, emoji thumb...). Type lúc đó
         *  thường là 'image' (FB đóng gói sticker dưới dạng image) hoặc 'sticker'. */
        sticker_id?: number
        coordinates?: { lat: number; long: number }
        /** type='template' (echo) — vd tin "Ưu đãi và thông báo" Facebook TỰ GỬI
         *  (Recurring Notifications / nhắc lại thread cũ), KHÔNG phải người gõ qua
         *  Business Suite. Nhận diện qua field notification_messages_* trong
         *  buttons — xem isAutomatedAdEcho() trong production/flow-handler.ts. */
        template_type?: string
        elements?: Array<{
          buttons?: Array<Record<string, unknown>>
        }>
      }
    }>
  }
  postback?: {
    title: string
    payload: string
  }
  optin?: {
    ref?: string
    type?: string
    payload?: string
  }
  referral?: {
    /** param từ ad / m.me?ref=... */
    ref?: string
    /** 'ADS' | 'SHORTLINK' | 'MESSAGING' | 'DISCOVER_TAB' | 'CUSTOMER_CHAT_PLUGIN' | ... */
    source?: string
    /** 'OPEN_THREAD' | 'LEAD_COMPLETE' | ... */
    type?: string
    /** ID của ad nếu source='ADS' */
    ad_id?: string
    referer_uri?: string
    ads_context_data?: {
      ad_title?: string
      post_id?: string
      video_url?: string
    }
  }
  /** FB Lead Ads — khi khách submit Instant Form từ ad CTM.
   *  Đi kèm `referral.type='LEAD_COMPLETE'`. Mỗi item là 1 cặp Q (Pancake hoặc
   *  ad creative đặt sẵn) / A (khách trả lời). */
  lead?: {
    data: Array<{
      question?: string
      answer?: string
    }>
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
