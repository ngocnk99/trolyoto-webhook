import { Module } from '@nestjs/common'
import { WebhookController } from './fb/webhook.controller'
import { DebugController } from './fb/debug.controller'
import { HealthController } from './health.controller'

@Module({
  controllers: [HealthController, WebhookController, DebugController]
})
export class AppModule {}
