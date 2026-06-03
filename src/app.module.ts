import { Module } from '@nestjs/common'
import { WebhookController } from './fb/webhook.controller'
import { HealthController } from './health.controller'

@Module({
  controllers: [HealthController, WebhookController]
})
export class AppModule {}
