/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Debug Controller — simulate khách gửi tin để test bot từ ngoài
 *
 *  Endpoints (gated bởi DEBUG_SECRET nếu set):
 *    POST /api/debug/simulate-message    → giả lập 1 tin text từ khách
 *    POST /api/debug/take-control        → manually take_thread_control 1 PSID
 *    POST /api/debug/pass-control        → manually pass_thread_control 1 PSID
 *    GET  /api/debug/session/:psid       → xem session + conversation_log
 *    GET  /api/debug/errored-sessions    → list session bị is_error=true
 *
 *  Auth: nếu env DEBUG_SECRET có set, request phải kèm header `x-debug-secret`
 *        khớp giá trị đó. Nếu env không set → không check (chỉ dùng nội bộ).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Res,
  Headers
} from '@nestjs/common'
import type { Response } from 'express'
import type { MessengerEvent } from './types'
import { handleMessengerEventProduction } from './production/flow-handler'
import { handleMessengerEventV3 } from './v3/flow-handler'
import { takeThreadControl, passThreadControl, getPrimaryAppId } from './handover'
import { getActiveSession, getLatestSession } from './session'
import { supabaseAmin } from './supabase'

const PAGE_ID_PRODUCT = process.env.FACEBOOK_PAGE_ID_PRODUCT ?? ''
const PAGE_ID_V3 = process.env.FACEBOOK_PAGE_ID_V3 ?? ''
const DEBUG_SECRET = process.env.DEBUG_SECRET ?? ''

function checkAuth(secret?: string): boolean {
  if (!DEBUG_SECRET) return true
  return secret === DEBUG_SECRET
}

@Controller('api/debug')
export class DebugController {
  // ─── POST /api/debug/simulate-message ───────────────────────────────────
  // Body: { psid: string, text: string, pageId?: string, route?: 'PROD'|'V3' }
  @Post('simulate-message')
  async simulate(
    @Body()
    body: {
      psid?: string
      text?: string
      pageId?: string
      route?: 'PROD' | 'V3'
    },
    @Headers('x-debug-secret') secret: string | undefined,
    @Res() res: Response
  ) {
    if (!checkAuth(secret)) {
      return res.status(HttpStatus.UNAUTHORIZED).json({ error: 'bad secret' })
    }
    const psid = body?.psid?.trim()
    const text = body?.text?.trim()
    if (!psid || !text) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'psid + text required' })
    }
    const route = body.route ?? 'V3'
    const pageId =
      body.pageId ?? (route === 'PROD' ? PAGE_ID_PRODUCT : PAGE_ID_V3)
    if (!pageId) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: `pageId missing (route=${route} env không có)` })
    }

    const fakeEvent: MessengerEvent = {
      sender: { id: psid },
      recipient: { id: pageId },
      timestamp: Date.now(),
      message: {
        mid: `sim_${Date.now()}`,
        text
      }
    }
    console.log(
      `[DEBUG simulate] route=${route} page=${pageId} psid=${psid} text="${text.slice(0, 120)}"`
    )

    // Reply 202 ngay — handler chạy async (giống webhook flow real)
    res.status(HttpStatus.ACCEPTED).json({
      ok: true,
      note: 'event dispatched, check log & session DB',
      psid,
      pageId,
      route,
      text
    })

    const handler =
      route === 'PROD'
        ? () => handleMessengerEventProduction(fakeEvent, pageId, false)
        : () => handleMessengerEventV3(fakeEvent, pageId)
    handler().catch(e =>
      console.error('[DEBUG simulate] handler error:', e?.message ?? e)
    )
  }

  // ─── POST /api/debug/simulate-qr ─────────────────────────────────────────
  // Giả lập click quick reply/postback payload (vd V3_BRAND_NAME:MICHELIN)
  @Post('simulate-qr')
  async simulateQr(
    @Body()
    body: {
      psid?: string
      payload?: string
      title?: string
      pageId?: string
      route?: 'PROD' | 'V3'
    },
    @Headers('x-debug-secret') secret: string | undefined,
    @Res() res: Response
  ) {
    if (!checkAuth(secret)) {
      return res.status(HttpStatus.UNAUTHORIZED).json({ error: 'bad secret' })
    }
    const psid = body?.psid?.trim()
    const payload = body?.payload?.trim()
    if (!psid || !payload) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'psid + payload required' })
    }
    const route = body.route ?? 'V3'
    const pageId =
      body.pageId ?? (route === 'PROD' ? PAGE_ID_PRODUCT : PAGE_ID_V3)
    if (!pageId) {
      return res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: `pageId missing (route=${route} env không có)` })
    }

    const fakeEvent: MessengerEvent = {
      sender: { id: psid },
      recipient: { id: pageId },
      timestamp: Date.now(),
      postback: {
        title: body.title ?? payload,
        payload
      }
    }
    console.log(
      `[DEBUG simulate-qr] route=${route} page=${pageId} psid=${psid} payload="${payload}"`
    )

    res.status(HttpStatus.ACCEPTED).json({ ok: true, psid, pageId, route, payload })

    const handler =
      route === 'PROD'
        ? () => handleMessengerEventProduction(fakeEvent, pageId, false)
        : () => handleMessengerEventV3(fakeEvent, pageId)
    handler().catch(e =>
      console.error('[DEBUG simulate-qr] handler error:', e?.message ?? e)
    )
  }

  // ─── POST /api/debug/take-control ────────────────────────────────────────
  @Post('take-control')
  async take(
    @Body() body: { psid?: string; pageId?: string; metadata?: string },
    @Headers('x-debug-secret') secret: string | undefined,
    @Res() res: Response
  ) {
    if (!checkAuth(secret)) {
      return res.status(HttpStatus.UNAUTHORIZED).json({ error: 'bad secret' })
    }
    const psid = body?.psid?.trim()
    if (!psid) {
      return res.status(HttpStatus.BAD_REQUEST).json({ error: 'psid required' })
    }
    const pageId = body.pageId ?? PAGE_ID_PRODUCT
    const ok = await takeThreadControl(psid, pageId, body.metadata ?? 'debug')
    return res.json({ ok, psid, pageId })
  }

  // ─── POST /api/debug/pass-control ────────────────────────────────────────
  @Post('pass-control')
  async pass(
    @Body()
    body: {
      psid?: string
      pageId?: string
      targetAppId?: string
      metadata?: string
    },
    @Headers('x-debug-secret') secret: string | undefined,
    @Res() res: Response
  ) {
    if (!checkAuth(secret)) {
      return res.status(HttpStatus.UNAUTHORIZED).json({ error: 'bad secret' })
    }
    const psid = body?.psid?.trim()
    if (!psid) {
      return res.status(HttpStatus.BAD_REQUEST).json({ error: 'psid required' })
    }
    const pageId = body.pageId ?? PAGE_ID_PRODUCT
    const ok = await passThreadControl(
      psid,
      pageId,
      body.targetAppId,
      body.metadata ?? 'debug'
    )
    return res.json({ ok, psid, pageId, target: body.targetAppId ?? 'auto' })
  }

  // ─── GET /api/debug/session/:psid ────────────────────────────────────────
  @Get('session/:psid')
  async session(
    @Param('psid') psid: string,
    @Headers('x-debug-secret') secret: string | undefined,
    @Res() res: Response
  ) {
    if (!checkAuth(secret)) {
      return res.status(HttpStatus.UNAUTHORIZED).json({ error: 'bad secret' })
    }
    const pageId = PAGE_ID_V3 || PAGE_ID_PRODUCT
    const active = await getActiveSession(psid, pageId)
    const latest = active ?? (await getLatestSession(psid, pageId))
    return res.json({
      psid,
      pageId,
      active: !!active,
      session: latest
        ? {
            id: latest.id,
            step: latest.step,
            state: latest.state,
            is_active: latest.is_active,
            is_paused_by_cskh: latest.is_paused_by_cskh,
            is_error: latest.is_error,
            bot_owns_thread: latest.bot_owns_thread,
            created_at: latest.created_at,
            updated_at: latest.updated_at,
            conversation_log_count: latest.conversation_log?.length ?? 0,
            conversation_log: latest.conversation_log
          }
        : null
    })
  }

  // ─── GET /api/debug/primary-app/:pageId ──────────────────────────────────
  @Get('primary-app/:pageId')
  async primary(
    @Param('pageId') pageId: string,
    @Headers('x-debug-secret') secret: string | undefined,
    @Res() res: Response
  ) {
    if (!checkAuth(secret)) {
      return res.status(HttpStatus.UNAUTHORIZED).json({ error: 'bad secret' })
    }
    const appId = await getPrimaryAppId(pageId)
    return res.json({ pageId, primary_app_id: appId })
  }

  // ─── GET /api/debug/errored-sessions ─────────────────────────────────────
  @Get('errored-sessions')
  async errored(
    @Headers('x-debug-secret') secret: string | undefined,
    @Res() res: Response
  ) {
    if (!checkAuth(secret)) {
      return res.status(HttpStatus.UNAUTHORIZED).json({ error: 'bad secret' })
    }
    const { data, error } = await supabaseAmin
      .from('fb_messenger_sessions')
      .select(
        'id, psid, page_id, step, is_active, is_paused_by_cskh, is_error, bot_owns_thread, updated_at'
      )
      .eq('is_error', true)
      .order('updated_at', { ascending: false })
      .limit(20)

    if (error) {
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: error.message })
    }
    return res.json({ count: data?.length ?? 0, sessions: data ?? [] })
  }
}
