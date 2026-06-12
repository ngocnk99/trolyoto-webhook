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
import { handleMessengerEventV3 } from './v3/flow-handler'
import { handleMessengerEventProduction } from './production/flow-handler'
import { runWithPsidLock } from './psid-mutex'
import type { MessengerWebhookBody, MessengerEvent } from './types'

const VERIFY_TOKEN = process.env.FB_WEBHOOK_VERIFY_TOKEN!
const APP_SECRET = process.env.FB_APP_SECRET!
const PAGE_ID_V2 = process.env.FACEBOOK_PAGE_ID
const PAGE_ID_V3 = process.env.FACEBOOK_PAGE_ID_V3
const PAGE_ID_PRODUCT = process.env.FACEBOOK_PAGE_ID_PRODUCT

/**
 * Lấy PSID của KHÁCH HÀNG từ event.
 *  - Event thường (khách gửi): sender.id = customer
 *  - Echo event (page gửi, FB echo về): sender.id = pageId, recipient.id = customer
 *
 * Dùng để khóa mutex theo từng khách → tránh race condition khi 2 event cùng PSID
 * đến gần nhau.
 */
function customerPsid(event: MessengerEvent): string {
  const isEcho = event.message?.is_echo === true
  return (isEcho ? event.recipient?.id : event.sender?.id) ?? ''
}

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
    console.log('rawBody', rawBody)

    if (!verifySignature(rawBody, signature)) {
      console.warn('[FB webhook] Invalid signature')
      return res
        .status(HttpStatus.UNAUTHORIZED)
        .json({ error: 'Invalid signature' })
    }

    let body: MessengerWebhookBody
    try {
      body = JSON.parse(rawBody.toString('utf-8'))
      console.log('body', JSON.stringify(body, null, 2))
    } catch {
      return res.status(HttpStatus.BAD_REQUEST).json({ error: 'Invalid JSON' })
    }

    if (body.object !== 'page') {
      return res
        .status(HttpStatus.NOT_FOUND)
        .json({ error: 'Not a page event' })
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
      // Route theo page_id: V2 / V3 / PRODUCT dùng handler + token riêng.
      const isV2 = !!PAGE_ID_V2 && entry.id === PAGE_ID_V2
      const isV3 = !!PAGE_ID_V3 && entry.id === PAGE_ID_V3
      const isProduct = !!PAGE_ID_PRODUCT && entry.id === PAGE_ID_PRODUCT
      if (!isV2 && !isV3 && !isProduct) {
        console.warn(
          `[FB webhook] Ignored entry for unknown page ${entry.id} (V2=${PAGE_ID_V2 ?? 'n/a'}, V3=${PAGE_ID_V3 ?? 'n/a'}, PROD=${PAGE_ID_PRODUCT ?? 'n/a'})`
        )
        continue
      }

      const tag = isProduct ? 'PROD' : isV3 ? 'V3' : 'V2'
      console.log(`[FB webhook] route page=${entry.id} → ${tag}`)

      // hop_context xuất hiện khi thread vừa được handover sang bot — đây là
      // dấu hiệu rõ ràng "Pancake vừa pass control sang bot" → mark bot_owns_thread.
      const hopContext = entry.hop_context
      if (hopContext) {
        console.log(
          `[FB HOP] page=${entry.id} hop_context.app_id=${hopContext.app_id} metadata="${hopContext.metadata ?? ''}"`
        )
      }

      // PRIMARY events (entry.messaging) — bot có thread control → xử lý đầy đủ.
      // MỖI event được wrap trong runWithPsidLock để tránh race condition khi
      // 2 webhook cùng PSID đến đồng thời (vd khách spam tin) → tránh tạo
      // duplicate session.
      const messaging = entry.messaging ?? []
      for (const event of messaging) {
        if (
          event.sender?.id === '24081205854909009' ||
          event.recipient?.id === '24081205854909009' ||
          event.referral
        ) {
          console.log('body', JSON.stringify(body, null, 2))
        }
        const psid = customerPsid(event)
        if (!psid) continue
        await runWithPsidLock(psid, async () => {
          if (isProduct) {
            await handleMessengerEventProduction(event, entry.id, false, hopContext)
          } else if (isV3) {
            await handleMessengerEventV3(event, entry.id)
          } else {
            await handleMessengerEvent(event, entry.id)
          }
        })
      }

      // STANDBY events — bot KHÔNG giữ thread control. PROD vẫn xử lý (qua
      // mutex) để log + detect CSKH echo. V2/V3 dev pages chỉ log.
      const standby = entry.standby ?? []
      for (const event of standby) {
        const summary = {
          psid: event.sender?.id,
          referral: event.referral,
          optin: event.optin,
          postback: event.postback,
          text: event.message?.text,
          is_echo: event.message?.is_echo,
          app_id: event.message?.app_id,
          attachments: event.message?.attachments?.map(a => a.type)
        }
        console.log(
          `[FB STANDBY] page=${entry.id} tag=${tag} → ${JSON.stringify(summary)}`
        )
        if (isProduct) {
          const psid = customerPsid(event)
          if (!psid) continue
          await runWithPsidLock(psid, () =>
            handleMessengerEventProduction(event, entry.id, true)
          )
        }
      }
    }
  }
}
