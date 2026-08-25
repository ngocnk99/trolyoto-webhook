/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Cache Outbox Consumer — đẩy giá mới lên web ngay thay vì chờ hết hạn cache
 *
 *  BỐI CẢNH
 *  Trang /lop/<slug> trên buyer được cache ISR (revalidate 3600). Giá thì đổi
 *  bởi cron DB chứ không phải lúc admin bấm duyệt:
 *      job 41  process_productadmin_price_sync_queue()  mỗi phút
 *      job 16  promotion_process_pending()              mỗi 10 phút
 *      job 28  garage_sync_productadmin_prices()         mỗi 2 giờ
 *  Trigger trong DB ghi trang cần xoá cache vào bảng
 *  `cache_invalidation_outbox` NGAY TRONG CÙNG TRANSACTION với UPDATE giá
 *  (xem database/migrations/20260813_cache_invalidation_outbox.sql).
 *  File này đọc bảng đó rồi gọi buyer /api/revalidate.
 *
 *  VÌ SAO CHẠY Ở ĐÂY: service này always-on trên Render (không cold start),
 *  nên poll được liên tục — khác Vercel cron vốn chỉ tới phút.
 *
 *  NGHỈ ĐÊM 00:00–07:00 giờ VN: lưu lượng rất thấp nên không xoá cache.
 *
 *  !! LẬP LUẬN AN TOÀN BAN ĐẦU CỦA KHUNG NGHỈ NÀY ĐÃ LỖI THỜI !!
 *  Bản đầu ghi: "`revalidate = 3600` bên buyer vẫn tự làm mới trang trong
 *  vòng 1 giờ, nên sai số ban đêm vẫn bị chặn ở 1 giờ". Điều đó ĐÚNG khi
 *  viết, nhưng từ commit 52702ed9 các trang sản phẩm đã lên
 *  `revalidate = 86400` ((market)/{lop,ac-quy,noi-ngoai-that}/[slug]/layout.tsx),
 *  và 20260820 nâng nốt /garage/[slug] lên 86400. Không còn lưới 1 giờ nào cả.
 *
 *  Hệ quả THỰC TẾ hiện nay: giá đổi lúc 00:05 nằm nguyên trong outbox tới
 *  07:00 mới được xoá cache — sai giá tối đa ~7 giờ chứ không phải 1 giờ.
 *  Đây là ĐÁNH ĐỔI CHƯA ĐƯỢC QUYẾT LẠI sau khi nâng revalidate, không phải
 *  thiết kế có chủ ý. Muốn đóng khe này thì thu hẹp hoặc bỏ hẳn khung nghỉ
 *  (CACHE_OUTBOX_QUIET_FROM / _TO) — đổi lại là vài đợt ISR Write ban đêm,
 *  vốn rẻ vì lưu lượng đêm thấp nên ít PoP phải dựng lại.
 *  Xem buyer/docs/vercel-cost-cache-plan.md mục 15.4.
 *
 *  AN TOÀN KHI CHẠY TRÙNG: revalidatePath là idempotent, xoá 2 lần cùng 1
 *  trang không khác gì xoá 1 lần. Nên chủ ý KHÔNG dùng khoá phân tán; kịch
 *  bản xấu nhất khi Render chạy 2 instance chỉ là gọi thừa vài lệnh.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { supabaseAmin } from '../fb/supabase'

const TABLE = 'cache_invalidation_outbox'

const BUYER_ORIGIN = process.env.BUYER_ORIGIN ?? 'https://trolyoto.com'
const REVALIDATE_SECRET = process.env.REVALIDATE_SECRET ?? ''
const INTERVAL_MS = Number(process.env.CACHE_OUTBOX_INTERVAL_MS ?? 30_000)

/**
 * KHOANG CACH TOI THIEU giua 2 lan goi /api/revalidate — mac dinh 5 phut.
 *
 * VI SAO CAN, tach rieng khoi INTERVAL_MS:
 * Moi lan goi la mot lan xoa cache tren Vercel, va moi trang bi xoa se phai
 * dung lai o luot truy cap tiep theo = mot ISR WRITE. Neu gia doi lien tuc
 * (vd cron DB chay lien tuc, hoac gara sua hang loat) thi voi chu ky poll 30s
 * ta se xoa cache 120 lan moi gio — moi lan keo theo mot dot dung lai.
 *
 * Chan cung o day thay vi chi nang INTERVAL_MS, de neu sau nay ai do ha
 * CACHE_OUTBOX_INTERVAL_MS xuong cho "phan hoi nhanh" thi van khong the ban
 * lien tuc. Poll van chay day (30s) nen dong outbox duoc phat hien som, chi
 * la doi cho du khoang cach roi moi goi.
 *
 * Danh doi: gia moi len web cham nhat 5 phut thay vi 30 giay.
 */
const MIN_FLUSH_GAP_MS = Number(
  process.env.CACHE_OUTBOX_MIN_GAP_MS ?? 300_000
)

/** Thoi diem goi /api/revalidate thanh cong gan nhat (epoch ms). */
let lastFlushAt = 0
const BATCH_SIZE = Number(process.env.CACHE_OUTBOX_BATCH ?? 500)

/** Bỏ qua dòng đã thử quá nhiều lần để 1 dòng độc không chặn cả hàng đợi. */
const MAX_ATTEMPTS = Number(process.env.CACHE_OUTBOX_MAX_ATTEMPTS ?? 5)

const QUIET_FROM = Number(process.env.CACHE_OUTBOX_QUIET_FROM ?? 0) // 00:00 VN
const QUIET_TO = Number(process.env.CACHE_OUTBOX_QUIET_TO ?? 7) // 07:00 VN

type OutboxRow = {
  id: number
  target_path: string
  attempts: number
}

/**
 * Giờ hiện tại theo Asia/Ho_Chi_Minh.
 * Dùng đúng cách của handover-cron.ts (toLocaleString + timeZone) thay vì
 * tự cộng UTC+7, để không phải tự lo lệch múi giờ của máy chạy.
 */
function nowVNHour(): number {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' })
  ).getHours()
}

function isQuietHours(): boolean {
  const h = nowVNHour()
  // Hỗ trợ cả khung vắt qua nửa đêm (vd 22 -> 6).
  return QUIET_FROM <= QUIET_TO
    ? h >= QUIET_FROM && h < QUIET_TO
    : h >= QUIET_FROM || h < QUIET_TO
}

/**
 * Luôn gửi ĐƯỜNG DẪN CỤ THỂ.
 *
 * Bản đầu có cơ chế "leo thang": lô > 200 trang thì gửi route pattern
 * `{ path: '/lop/[slug]', type: 'page' }` để xoá cả route bằng 1 lệnh. Đã ĐO
 * trên `next start` (Next 14.2) và nó KHÔNG hoạt động — header
 * `x-nextjs-cache` vẫn HIT sau khi gọi, trong khi gửi đường dẫn cụ thể thì
 * chuyển đúng HIT -> MISS -> HIT. Nên đã bỏ.
 *
 * Không cần leo thang thật: unique index một phía trên `target_path` đã gộp
 * trùng ngay từ lúc ghi, nên số trang trong một lô bị chặn bởi số trang THỰC
 * SỰ đổi, không phải số dòng bị UPDATE.
 *
 * `tags: ['market-listing']` xoá luôn các trang DANH SÁCH (/lop, /ac-quy, ...)
 * — chúng không có `target_path` riêng trong outbox vì không gắn với một slug
 * nào. Đã đo: revalidateTag('market-listing') đưa /lop từ HIT -> MISS -> HIT
 * đúng như mong đợi.
 *
 * NHƯNG CHỈ KÈM KHI LÔ CÓ ÍT NHẤT MỘT TRANG SẢN PHẨM.
 *
 * Từ 20260820_cache_outbox_garage_page.sql, outbox còn mang cả đường dẫn
 * `/garage/<slug>` (đổi tên/SEO của gara). Một lô chỉ toàn đường dẫn gara mà
 * vẫn gửi kèm tag này thì mỗi lần gara sửa tên lại xoá cache TOÀN BỘ trang
 * danh sách market — những trang chẳng liên quan gì, và mỗi lần xoá là một
 * đợt ISR Write ở mọi PoP. Đúng thứ chi phí mà cả kế hoạch này nhắm vào.
 */
const PRODUCT_PATH_RE = /^\/(lop|ac-quy|noi-ngoai-that)\//

/**
 * TÁCH TẦN SUẤT CỦA TAG KHỎI TẦN SUẤT CỦA PATH — mặc định 30 phút.
 *
 * VÌ SAO TÁCH: hai thứ này phục vụ hai loại trang khác nhau và không cần
 * chung một nhịp.
 *
 *   `paths`  -> xoá đúng /lop/<slug-san-pham> đã đổi giá. Hẹp, rẻ, cần NGAY.
 *   `tags`   -> revalidateTag('market-listing') xoá MỌI trang mang tag đó:
 *               /lop, /ac-quy và toàn bộ trang brand/dòng xe
 *               (/lop/michelin, /lop/vinfast-vf8...). Rộng và đắt.
 *
 * Với MIN_FLUSH_GAP_MS = 5 phút và khung chạy 17 giờ/ngày, tag đang bị bắn tới
 * ~204 lần/ngày. Đo trên log production 25/08/2026, GET /lop/vinfast-vf8:
 *
 *     Cache TTL: 1s   Reason: Tag-based deletion
 *     Tags: setting-view, market-listing
 *     ISR Function Invocation x2 (423ms + 396ms), Fluid 411 + 415 MB
 *     Response finished in 1.5s   ISR Cache updated
 *
 * Tức nhóm trang brand/dòng xe gần như không bao giờ được ở yên trong cache,
 * bất kể route khai `revalidate = 86400`. Đây là nguồn chính của ISR Writes.
 *
 * ĐÁNH ĐỔI: giá mới lên trang DANH SÁCH chậm nhất 30 phút thay vì 5 phút.
 * Trang CHI TIẾT không bị ảnh hưởng — nó được xoá theo `paths` chính xác, vẫn
 * 5 phút như cũ. Và `MARKET_LISTING_REVALIDATE = 3600` bên buyer vẫn là lưới
 * cuối, nên sai số trần vẫn là 1 giờ.
 *
 * CỐ Ý KHÔNG nâng hằng số 3600 đó lên 86400: nó là thứ duy nhất chặn sai số
 * trong khung nghỉ đêm 00:00-07:00, lúc consumer không chạy.
 */
const MIN_TAG_GAP_MS = Number(process.env.CACHE_OUTBOX_MIN_TAG_GAP_MS ?? 1_800_000)

/** Thời điểm gửi kèm tag `market-listing` gần nhất (epoch ms). */
let lastTagAt = 0

/**
 * Chỉ kèm tag khi lô CÓ trang sản phẩm VÀ đã đủ khoảng cách kể từ lần gửi
 * tag trước. Lô toàn đường dẫn gara (`/garage/<slug>`) không bao giờ cần tag.
 */
function buildBody(paths: string[]) {
  const hasProductPath = paths.some(p => PRODUCT_PATH_RE.test(p))
  const tagDue = Date.now() - lastTagAt >= MIN_TAG_GAP_MS
  return hasProductPath && tagDue ? { paths, tags: ['market-listing'] } : { paths }
}

/**
 * Trạng thái nội bộ, phơi ra qua GET /version.
 *
 * Có mặt vì lần deploy đầu gặp đúng tình huống không nhìn thấy gì: outbox
 * đọng 357 dòng với attempts=0 suốt 76 phút, tức consumer chưa từng gọi
 * cache_outbox_claim, nhưng từ bên ngoài không phân biệt được là "Render chưa
 * deploy code mới" hay "đã deploy nhưng thiếu REVALIDATE_SECRET nên thoát sớm".
 * Mấy trường dưới đây trả lời dứt điểm câu đó mà không cần mở log Render.
 */
const stats = {
  startedAt: new Date().toISOString(),
  running: false,
  lastRunAt: null as string | null,
  lastSkipReason: null as string | null,
  lastSuccessAt: null as string | null,
  lastError: null as string | null,
  runs: 0,
  batches: 0,
  pathsFlushed: 0
}

export function getCacheOutboxStatus() {
  return {
    ...stats,
    // Chỉ báo CÓ/KHÔNG, tuyệt đối không trả giá trị secret.
    hasRevalidateSecret: Boolean(REVALIDATE_SECRET),
    buyerOrigin: BUYER_ORIGIN,
    intervalMs: INTERVAL_MS,
    minFlushGapMs: MIN_FLUSH_GAP_MS,
    // Nhịp RIÊNG của tag `market-listing` — xem MIN_TAG_GAP_MS. Nếu ISR Writes
    // vẫn cao, so hai mốc này trước: `lastTagAt` mới là thứ xoá cả nhóm trang
    // brand/dòng xe, `lastFlushAt` chỉ xoá từng đường dẫn.
    minTagGapMs: MIN_TAG_GAP_MS,
    lastTagAt: lastTagAt ? new Date(lastTagAt).toISOString() : null,
    lastFlushAt: lastFlushAt ? new Date(lastFlushAt).toISOString() : null,
    // Mốc sớm nhất được phép xoá cache lần kế. Nếu lastSkipReason đang là
    // "hoãn ..." thì dòng vẫn nằm trong outbox chờ tới mốc này, chưa mất.
    nextFlushEligibleAt: lastFlushAt
      ? new Date(lastFlushAt + MIN_FLUSH_GAP_MS).toISOString()
      : null,
    batchSize: BATCH_SIZE,
    quietHoursVN: `${QUIET_FROM}h-${QUIET_TO}h`,
    isQuietNow: isQuietHours(),
    nowVNHour: nowVNHour()
  }
}

async function flushOnce(): Promise<void> {
  stats.runs++
  stats.lastRunAt = new Date().toISOString()

  if (!REVALIDATE_SECRET) {
    stats.lastSkipReason = 'REVALIDATE_SECRET chưa set'
    console.warn('[cache-outbox] REVALIDATE_SECRET chưa set → skip')
    return
  }
  if (isQuietHours()) {
    stats.lastSkipReason = 'dang trong khung nghi dem'
    return
  }

  // Chặn tần suất — đây là HOÃN LẠI, không phải bỏ qua.
  //
  // Return ở đây xảy ra TRƯỚC khi gọi cache_outbox_claim, nên không dòng nào
  // bị đụng vào: `processed_at` vẫn NULL, `attempts` không tăng. setInterval
  // vẫn chạy đều mỗi INTERVAL_MS nên vòng loop kế tiếp kiểm lại điều kiện
  // này, và tới vòng đầu tiên đủ 5 phút thì gom TẤT CẢ dòng dồn lại trong
  // lúc chờ ra xoá một lượt. Không dòng nào bị mất.
  //
  // Bắt buộc phải kiểm TRƯỚC claim: nếu kiểm sau, mỗi vòng poll trong lúc chờ
  // sẽ đốt một lần `attempts`, và với INTERVAL_MS=30s thì chỉ 2,5 phút là dòng
  // chạm MAX_ATTEMPTS rồi bị bỏ hẳn — lúc đó mới đúng là "bỏ qua hoàn toàn".
  const sinceLast = Date.now() - lastFlushAt
  if (lastFlushAt && sinceLast < MIN_FLUSH_GAP_MS) {
    const waitS = Math.ceil((MIN_FLUSH_GAP_MS - sinceLast) / 1000)
    stats.lastSkipReason = `hoãn ${waitS}s cho đủ khoảng cách tối thiểu (dòng vẫn nằm nguyên trong outbox)`
    return
  }

  stats.lastSkipReason = null

  // Claim qua RPC chứ không SELECT rồi UPDATE: cần "chọn lô + tăng attempts"
  // nguyên tử. supabase-js không diễn đạt được `attempts = attempts + 1`, nên
  // làm 2 bước sẽ phải gán CÙNG một con số cho cả lô — dòng đã thử 3 lần và
  // dòng chưa thử lần nào bị đặt về cùng giá trị, mất lịch sử retry.
  // RPC còn dùng FOR UPDATE SKIP LOCKED nên an toàn nếu Render chạy 2 instance.
  const { data: rows, error } = await supabaseAmin.rpc('cache_outbox_claim', {
    p_limit: BATCH_SIZE,
    p_max_attempts: MAX_ATTEMPTS
  })

  if (error) {
    console.error('[cache-outbox] claim outbox lỗi:', error.message)
    return
  }
  if (!rows || rows.length === 0) return

  const batch = rows as OutboxRow[]
  const ids = batch.map(r => r.id)
  const paths = Array.from(new Set(batch.map(r => r.target_path)))

  const body = buildBody(paths)

  try {
    const res = await fetch(`${BUYER_ORIGIN}/api/revalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-revalidate-secret': REVALIDATE_SECRET
      },
      body: JSON.stringify(body)
    })

    if (!res.ok) {
      const text = await res.text()
      const msg = `HTTP ${res.status}: ${text.slice(0, 300)}`
      stats.lastError = msg
      console.error('[cache-outbox] revalidate thất bại —', msg)
      // KHÔNG đánh dấu processed_at → lượt sau retry.
      await supabaseAmin
        .from(TABLE)
        .update({ last_error: msg })
        .in('id', ids)
        .is('processed_at', null)
      return
    }

    // Cache ĐÃ bị xoá xong tại đây. Đặt mốc NGAY, trước bước ghi dấu bên
    // dưới: thứ mà MIN_FLUSH_GAP_MS đo là thời điểm xoá cache thật, không
    // phải thời điểm ghi sổ thành công. Bản đầu đặt mốc ở cuối hàm nên khi
    // bước ghi `processed_at` lỗi, hàm return với mốc cũ → 30s sau bộ chặn
    // tưởng chưa từng xoá, claim lại đúng lô đó và xoá cache lần nữa. Đúng
    // kiểu bắn dồn mà biến này sinh ra để chặn.
    lastFlushAt = Date.now()
    // Chỉ tính mốc khi lô NÀY thật sự có kèm tag. Đặt ở đây (sau khi biết
    // request thành công) chứ không đặt trong buildBody: dựng body xong mà
    // request lỗi thì tag chưa hề được xoá, ghi mốc sẽ khoá mất 30 phút kế
    // tiếp cho một lần xoá không xảy ra.
    if ('tags' in body) lastTagAt = lastFlushAt

    const now = new Date().toISOString()
    const { error: markErr } = await supabaseAmin
      .from(TABLE)
      .update({ processed_at: now, last_error: null })
      .in('id', ids)
      .is('processed_at', null)

    if (markErr) {
      // Cache ĐÃ được xoá rồi, chỉ là không ghi được dấu. Lượt sau sẽ gọi lại
      // — vô hại vì revalidate idempotent.
      console.error('[cache-outbox] đánh dấu processed lỗi:', markErr.message)
      return
    }

    stats.lastSuccessAt = now
    stats.lastError = null
    stats.batches++
    stats.pathsFlushed += paths.length
    console.log(
      `[cache-outbox] đã xoá cache ${paths.length} trang` +
        ` — ${batch.length} dòng outbox`
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    stats.lastError = msg
    console.error('[cache-outbox] gọi /api/revalidate lỗi:', msg)
    await supabaseAmin
      .from(TABLE)
      .update({ last_error: msg.slice(0, 300) })
      .in('id', ids)
      .is('processed_at', null)
  }
}

let timer: NodeJS.Timeout | null = null

export function startCacheOutboxCron(): void {
  if (timer) return

  console.log(
    `[cache-outbox] bật — poll ${INTERVAL_MS}ms, cách tối thiểu ${MIN_FLUSH_GAP_MS}ms, lô ${BATCH_SIZE}, ` +
      `nghỉ ${QUIET_FROM}h–${QUIET_TO}h giờ VN, đích ${BUYER_ORIGIN}`
  )

  stats.running = true
  timer = setInterval(() => {
    flushOnce().catch(e =>
      console.error('[cache-outbox] lỗi ngoài dự kiến:', e)
    )
  }, INTERVAL_MS)
}

export function stopCacheOutboxCron(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
    stats.running = false
  }
}
