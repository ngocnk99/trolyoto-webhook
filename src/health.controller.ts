import { Controller, Get } from '@nestjs/common'

/**
 * Health check endpoint for Render — phải trả 200 OK nhanh.
 * Configured trong render.yaml: `healthCheckPath: /healthz`.
 */
@Controller()
export class HealthController {
  @Get('healthz')
  healthz() {
    return { status: 'ok', ts: new Date().toISOString() }
  }

  @Get()
  root() {
    return { service: 'trolyoto-fb-webhook', status: 'ok' }
  }
}
