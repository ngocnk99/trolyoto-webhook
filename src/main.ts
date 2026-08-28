import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { startHandoverCron } from './fb/handover-cron'
import { startCacheOutboxCron } from './cache/cache-outbox-cron'
import { startSearchAliasCron } from './search/search-alias-cron'
import { startPriorityGarageCache } from './fb/priorityGarage'

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

  // Cache RAM bảng priority_garage (gara ưu tiên khi hết cách tìm theo vị trí
  // — tier 3 trong cascade tìm SP+gara). Refresh 30 phút/lần, load ngay lúc
  // start. Xem src/fb/priorityGarage.ts.
  startPriorityGarageCache()
}

bootstrap().catch(e => {
  // eslint-disable-next-line no-console
  console.error('[FB bot] bootstrap failed:', e)
  process.exit(1)
})
