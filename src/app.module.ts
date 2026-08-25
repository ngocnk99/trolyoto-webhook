import { Module } from '@nestjs/common'
import { WebhookController } from './fb/webhook.controller'
import { DebugController } from './fb/debug.controller'
import { HealthController } from './health.controller'
import { VersionController } from './version.controller'
import { SearchAliasController } from './search/search-alias.controller'

@Module({
  controllers: [
    HealthController,
    VersionController,
    WebhookController,
    DebugController,
    SearchAliasController
  ]
})
export class AppModule {}
