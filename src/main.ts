import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { startHandoverCron } from './fb/handover-cron'

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
}

bootstrap().catch(e => {
  // eslint-disable-next-line no-console
  console.error('[FB bot] bootstrap failed:', e)
  process.exit(1)
})
