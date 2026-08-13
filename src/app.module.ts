import { Module } from '@nestjs/common'
import { WebhookController } from './fb/webhook.controller'
import { DebugController } from './fb/debug.controller'
import { HealthController } from './health.controller'
import { VersionController } from './version.controller'

@Module({
  controllers: [
    HealthController,
    VersionController,
    WebhookController,
    DebugController
  ]
})
export class AppModule {}
