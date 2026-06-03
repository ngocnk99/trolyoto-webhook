import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  Headers,
  Query,
  HttpStatus
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { RawBodyRequest } from '@nestjs/common'
import * as crypto from 'crypto'
import { handleMessengerEvent } from './flow-handler'
import type { MessengerWebhookBody } from './types'

const VERIFY_TOKEN = process.env.FB_WEBHOOK_VERIFY_TOKEN!
const APP_SECRET = process.env.FB_APP_SECRET!
const ALLOWED_PAGE_ID = process.env.FACEBOOK_PAGE_ID

function verifySignature(rawBody: Buffer, signature?: string): boolean {
  if (!signature || !APP_SECRET) return !APP_SECRET // skip if no secret configured
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}

/**
 * Facebook Messenger webhook — single endpoint.
 *
 *  GET  /api/webhook/facebook   → verification challenge (FB subscribe handshake)
 *  POST /api/webhook/facebook   → incoming events (messages, postbacks, optin, referral, ...)
 *
 * Trên Render (always-on Node process), không có cold start nên trả tin nhắn nhanh
 * hơn nhiều so với Vercel serverless. Vẫn áp pattern "reply 200 OK ngay, xử lý
 * event async" để FB không retry — Node process còn sống nên work tiếp tục chạy.
 */
@Controller('api/webhook/facebook')
export class WebhookController {
  // ── GET verify ─────────────────────────────────────────────────────────────
  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() res: Response
  ) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      // eslint-disable-next-line no-console
      console.log('[FB webhook] Verification successful')
      return res.status(HttpStatus.OK).send(challenge ?? '')
    }
    console.warn('[FB webhook] Verification failed — bad token or mode')
    return res.status(HttpStatus.FORBIDDEN).json({ error: 'Forbidden' })
  }

  // ── POST events ────────────────────────────────────────────────────────────
  @Post()
  async handleEvent(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Headers('x-hub-signature-256') signature?: string
  ) {
    const rawBody = req.rawBody
    if (!rawBody) {
      return res.status(HttpStatus.BAD_REQUEST).json({ error: 'No body' })
    }

    if (!verifySignature(rawBody, signature)) {
      console.warn('[FB webhook] Invalid signature')
      return res.status(HttpStatus.UNAUTHORIZED).json({ error: 'Invalid signature' })
    }

    let body: MessengerWebhookBody
    try {
      body = JSON.parse(rawBody.toString('utf-8'))
    } catch {
      return res.status(HttpStatus.BAD_REQUEST).json({ error: 'Invalid JSON' })
    }

    if (body.object !== 'page') {
      return res.status(HttpStatus.NOT_FOUND).json({ error: 'Not a page event' })
    }

    // 200 OK ngay — FB stops retrying. Node process tiếp tục chạy xử lý event.
    res.status(HttpStatus.OK).json({ status: 'ok' })

    // Fire-and-forget — không block response. Node process always-on nên work
    // chạy đến lúc xong (không bị Vercel-style killing sau response).
    this.processEvents(body).catch(e =>
      console.error('[FB webhook] processEvents error:', e)
    )
  }

  private async processEvents(body: MessengerWebhookBody): Promise<void> {
    for (const entry of body.entry ?? []) {
      if (ALLOWED_PAGE_ID && entry.id !== ALLOWED_PAGE_ID) {
        console.warn(
          `[FB webhook] Ignored entry for page ${entry.id} (expected ${ALLOWED_PAGE_ID})`
        )
        continue
      }

      const events = [...(entry.messaging ?? []), ...(entry.standby ?? [])]
      for (const event of events) {
        await handleMessengerEvent(event, entry.id)
      }
    }
  }
}
