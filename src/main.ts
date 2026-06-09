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

  // Cron: hàng ngày lúc END_TIME (vd 08:30 VN) → pass thread control trả Primary.
  startHandoverCron()
}

bootstrap().catch(e => {
  // eslint-disable-next-line no-console
  console.error('[FB bot] bootstrap failed:', e)
  process.exit(1)
})
