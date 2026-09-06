import { Controller, Get, Headers, HttpStatus, Post, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { getSearchAliasStatus, runAliasMining } from './search-alias-cron'

/**
 * Task search-suggest-v2 GĐ3 — endpoint vận hành cho mining alias.
 * Bảo vệ bằng DEBUG_SECRET (cùng cơ chế debug.controller.ts): header
 * `x-debug-secret`. Chưa set DEBUG_SECRET → TỪ CHỐI hết (sửa 06/09/2026, trước
 * đó là cho qua nên endpoint mở ra internet).
 *
 *   GET  /api/search-alias/status
 *   POST /api/search-alias/run?dryRun=1   → chạy ngay, dryRun không ghi DB
 */
const DEBUG_SECRET = process.env.DEBUG_SECRET ?? ''

function authorized(secret?: string): boolean {
  // Xem chú thích trong fb/debug.controller.ts: chưa set secret là TỪ CHỐI.
  if (!DEBUG_SECRET) return false
  return secret === DEBUG_SECRET
}

@Controller('api/search-alias')
export class SearchAliasController {
  @Get('status')
  status(@Headers('x-debug-secret') secret: string, @Res() res: Response) {
    if (!authorized(secret)) return res.status(HttpStatus.FORBIDDEN).json({ error: 'forbidden' })
    return res.json(getSearchAliasStatus())
  }

  @Post('run')
  async run(
    @Headers('x-debug-secret') secret: string,
    @Query('dryRun') dryRun: string | undefined,
    @Res() res: Response
  ) {
    if (!authorized(secret)) return res.status(HttpStatus.FORBIDDEN).json({ error: 'forbidden' })
    const result = await runAliasMining({ dryRun: dryRun === '1' || dryRun === 'true' })
    return res.status(result.error ? HttpStatus.INTERNAL_SERVER_ERROR : HttpStatus.OK).json(result)
  }
}
