import { Controller, Get, Headers, HttpStatus, Post, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { getSearchEmbeddingStatus, runEmbeddingBackfill } from './embedding-cron'

/**
 * Task search-suggest-v2 GĐ4 — vận hành backfill embedding (cùng cơ chế DEBUG_SECRET).
 *   GET  /api/search-embedding/status
 *   POST /api/search-embedding/run?dryRun=1
 */
const DEBUG_SECRET = process.env.DEBUG_SECRET ?? ''
// Cùng chính sách search-alias.controller (vá 06/09): chưa set DEBUG_SECRET là TỪ CHỐI hết.
const authorized = (secret?: string) => !!DEBUG_SECRET && secret === DEBUG_SECRET

@Controller('api/search-embedding')
export class SearchEmbeddingController {
  @Get('status')
  status(@Headers('x-debug-secret') secret: string, @Res() res: Response) {
    if (!authorized(secret)) return res.status(HttpStatus.FORBIDDEN).json({ error: 'forbidden' })
    return res.json(getSearchEmbeddingStatus())
  }

  @Post('run')
  async run(
    @Headers('x-debug-secret') secret: string,
    @Query('dryRun') dryRun: string | undefined,
    @Res() res: Response
  ) {
    if (!authorized(secret)) return res.status(HttpStatus.FORBIDDEN).json({ error: 'forbidden' })
    const result = await runEmbeddingBackfill({ dryRun: dryRun === '1' || dryRun === 'true' })
    return res.status(result.error ? HttpStatus.INTERNAL_SERVER_ERROR : HttpStatus.OK).json(result)
  }
}
