import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { startHandoverCron } from './fb/handover-cron'
import { startCacheOutboxCron } from './cache/cache-outbox-cron'
import { startMetaCapiCron } from './meta/capi-outbox-cron'
import { startSearchAliasCron } from './search/search-alias-cron'
import { startAliasReviewCron } from './search/alias-review-cron'
import { startPriorityGarageCache } from './fb/priorityGarage'
import { startTireSizeMergeCache } from './fb/tireSizeMerge'
import { installAiUsageLogging } from './ai/usage-log'

// Patch globalThis.fetch trước khi mở cổng — mọi request tới api.openai.com
// được ghi 1 dòng ai_call_log (kể cả retry nội bộ của AI SDK). Xem
// src/ai/usage-log.ts. Chạy ở module scope, trước bootstrap(), vì cron trong
// bootstrap() cũng gọi AI.
installAiUsageLogging()
import { startSearchEmbeddingCron } from './search/embedding-cron'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Bật rawBody để controller verify chữ ký FB (HMAC-SHA256 trên raw bytes).
    rawBody: true,
    bodyParser: true
  })
  app.enableShutdownHooks()

  const port = Number(process.env.PORT ?? 3000)
  await app.listen(port, '0.0.0.0')
  // eslint-disable-next-line no-console
  console.log(`[FB bot] listening on :${port}`)

  // ── Env sanity check — log những env critical để dễ debug khi deploy ───
  const envReport = {
    FB_APP_ID: process.env.FB_APP_ID || '(MISSING!)',
    FACEBOOK_PAGE_ID_PRODUCT:
      process.env.FACEBOOK_PAGE_ID_PRODUCT || '(not set)',
    FACEBOOK_PAGE_ID_V3: process.env.FACEBOOK_PAGE_ID_V3 || '(not set)',
    FB_PAGE_ACCESS_TOKEN_PRODUCT: process.env.FB_PAGE_ACCESS_TOKEN_PRODUCT
      ? `(set, len=${process.env.FB_PAGE_ACCESS_TOKEN_PRODUCT.length})`
      : '(not set)',
    FROM_TIME: process.env.FROM_TIME || '(default 18:00)',
    END_TIME: process.env.END_TIME || '(default 08:30)',
    PROD_TEST_PSIDS: process.env.PROD_TEST_PSIDS || '(default)'
  }
  console.log('[FB bot] env check:', envReport)
  if (!process.env.FB_APP_ID) {
    console.error(
      '[FB bot] ⚠️  FB_APP_ID env CHƯA SET — CSKH echo detection sẽ tắt ' +
        '(mọi echo treat as bot self-echo). Set ngay để pause-by-cskh hoạt động!'
    )
  }

  // Cron: hàng ngày lúc END_TIME (vd 08:30 VN) → pass thread control trả Primary.
  startHandoverCron()

  // Đọc cache_invalidation_outbox → gọi buyer /api/revalidate, để giá mới lên
  // web ngay thay vì chờ hết cache 1 giờ. Chạy ở đây vì service always-on trên
  // Render. Xem src/cache/cache-outbox-cron.ts.
  startCacheOutboxCron()

  // Task search-suggest-v2 GĐ3: đêm 01:30 VN mining alias tìm kiếm từ
  // conversation_log + search_query_log bằng gpt-4o-mini → search_alias.
  // Xem src/search/search-alias-cron.ts.
  startSearchAliasCron()

  // 86eyuw542 GĐ8: 02:00 VN (sau mining, trước refresh 02:30) — AI tự duyệt
  // alias pending: approve/reject/fix canonical. Xem src/search/alias-review-cron.ts.
  startAliasReviewCron()

  // Cache RAM bảng priority_garage (gara ưu tiên khi hết cách tìm theo vị trí
  // — tier 3 trong cascade tìm SP+gara). Refresh 30 phút/lần, load ngay lúc
  // start. Xem src/fb/priorityGarage.ts.
  startPriorityGarageCache()

  // Cache RAM ánh xạ size lốp đã GỘP (categoryadmin type=SIZE/category=TIRE)
  // → key nhóm thật, để query productadmin đúng ngay cả khi khách gõ biến
  // thể (vd "C") khác với key admin đã gộp. Refresh 30 phút/lần. Xem
  // docs/tire-size-key-merge.md (gốc repo production/) + src/fb/tireSizeMerge.ts.
  startTireSizeMergeCache()

  // Đọc meta_capi_outbox → gửi Purchase sang Meta Conversions API. Có kênh
  // server-side thì pixel trình duyệt và Meta mới khử trùng lặp được cho nhau
  // (qua event_id), và đơn không mất khi trình duyệt chặn pixel.
  // Xem src/meta/capi-outbox-cron.ts.
  startMetaCapiCron()
  // GĐ4: 03:00 VN embed delta của search_dictionary (OpenAI text-embedding-3-small)
  // cho tầng semantic. Xem src/search/embedding-cron.ts.
  startSearchEmbeddingCron()
}

bootstrap().catch(e => {
  // eslint-disable-next-line no-console
  console.error('[FB bot] bootstrap failed:', e)
  process.exit(1)
})
