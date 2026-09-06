import {
  Controller,
  Get,
  Headers,
  HttpStatus,
  Post,
  Res
} from '@nestjs/common'
import type { Response } from 'express'

import { capiConfigSummary, sendCapiEvents } from './capi-client'
import { flushOnce, getMetaCapiStatus } from './capi-outbox-cron'

/**
 * Endpoint vận hành cho hàng đợi Meta Conversions API.
 *
 *   GET  /api/meta/capi/status   → trạng thái cron + cấu hình (không lộ token)
 *   POST /api/meta/capi/flush    → chạy ngay một vòng, không đợi tới nhịp cron
 *   POST /api/meta/capi/test     → gửi 1 sự kiện giả để soi ở tab "Sự kiện kiểm tra"
 *
 * KHÁC với `debug.controller.ts` và `search-alias.controller.ts` ở một điểm cố ý:
 * chưa set secret thì **TỪ CHỐI**, không phải cho qua. Hai controller kia dùng
 * `if (!DEBUG_SECRET) return true` mà `DEBUG_SECRET` lại chưa được set ở đâu cả
 * -> chúng đang mở ra internet. Không lặp lại lỗi đó ở endpoint có thể bơm dữ
 * liệu vào tài khoản quảng cáo.
 */
const CAPI_ADMIN_SECRET = process.env.CAPI_ADMIN_SECRET ?? ''

function authorized(secret?: string): boolean {
  if (!CAPI_ADMIN_SECRET) return false
  return secret === CAPI_ADMIN_SECRET
}

@Controller('api/meta/capi')
export class MetaCapiController {
  @Get('status')
  status(@Headers('x-capi-secret') secret: string, @Res() res: Response) {
    if (!authorized(secret)) {
      return res.status(HttpStatus.FORBIDDEN).json({ error: 'forbidden' })
    }
    return res.json(getMetaCapiStatus())
  }

  @Post('flush')
  async flush(@Headers('x-capi-secret') secret: string, @Res() res: Response) {
    if (!authorized(secret)) {
      return res.status(HttpStatus.FORBIDDEN).json({ error: 'forbidden' })
    }
    const result = await flushOnce()
    return res.json({ ...result, status: getMetaCapiStatus() })
  }

  @Post('test')
  async test(@Headers('x-capi-secret') secret: string, @Res() res: Response) {
    if (!authorized(secret)) {
      return res.status(HttpStatus.FORBIDDEN).json({ error: 'forbidden' })
    }

    const config = capiConfigSummary()
    if (!config.testMode) {
      // Không có META_CAPI_TEST_EVENT_CODE thì sự kiện giả này sẽ vào BÁO CÁO
      // THẬT và làm bẩn số doanh thu. Chặn hẳn.
      return res.status(HttpStatus.BAD_REQUEST).json({
        error:
          'Chưa đặt META_CAPI_TEST_EVENT_CODE — lấy mã ở Trình quản lý sự kiện → Sự kiện kiểm tra, và nhớ xoá env này sau khi test.'
      })
    }

    const result = await sendCapiEvents([
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: `test-${Date.now()}`,
        event_source_url: 'https://trolyoto.com/thank-you',
        action_source: 'website',
        user_data: {},
        custom_data: { value: 1000, currency: 'VND' }
      }
    ])

    return res
      .status(result.ok ? HttpStatus.OK : HttpStatus.BAD_GATEWAY)
      .json(result)
  }
}
