import { Controller, Get, Header } from '@nestjs/common'
import { getCacheOutboxStatus } from './cache/cache-outbox-cron'
import { getTilesStatus } from './tiles/tiles.controller'
import { getPriorityGarageStatus } from './fb/priorityGarage'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json')

/**
 * Cho biết CHÍNH XÁC bản build nào đang chạy trên Render, và consumer
 * cache-outbox có thật sự hoạt động không.
 *
 * VÌ SAO CẦN — bài học từ lần deploy đầu:
 * Outbox đọng 357 dòng với `attempts = 0` suốt 76 phút. Nhìn từ ngoài không
 * phân biệt được ba khả năng:
 *   1. Render chưa deploy code mới
 *   2. Đã deploy nhưng thiếu REVALIDATE_SECRET -> consumer thoát trước khi claim
 *   3. Đang trong khung nghỉ đêm
 * /healthz trả 200 ở CẢ BA trường hợp nên vô dụng cho việc này. Endpoint này
 * trả lời dứt điểm mà không phải mở log Render.
 *
 * CÁCH ĐỌC:
 *   - Gọi được /version (không 404)  -> code mới ĐÃ deploy
 *   - cacheOutbox.running = false    -> startCacheOutboxCron() chưa được gọi
 *   - hasRevalidateSecret = false    -> thiếu env trên Render
 *   - lastSkipReason có giá trị      -> lý do lượt gần nhất không làm gì
 *   - lastRunAt đứng yên             -> setInterval đã chết
 *   - lastError                      -> lỗi gọi buyer /api/revalidate
 *
 * TUYỆT ĐỐI không trả giá trị secret, chỉ trả cờ có/không.
 */
@Controller()
export class VersionController {
  @Get('version')
  @Header('Cache-Control', 'no-store, max-age=0, must-revalidate')
  version() {
    const commit = process.env.RENDER_GIT_COMMIT ?? null

    return {
      service: pkg.name,
      version: pkg.version,
      commit,
      commitShort: commit ? commit.slice(0, 8) : null,
      branch: process.env.RENDER_GIT_BRANCH ?? null,
      renderService: process.env.RENDER_SERVICE_NAME ?? null,
      instanceId: process.env.RENDER_INSTANCE_ID ?? null,
      // Render không cấp biến "thời điểm build", nhưng process khởi động ngay
      // sau khi deploy xong -> uptime chính là "bản này chạy được bao lâu".
      // startedAt lệch nhiều so với lúc push nghĩa là bản đang chạy là bản CŨ.
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      now: new Date().toISOString(),
      cacheOutbox: getCacheOutboxStatus(),
      tiles: getTilesStatus(),
      priorityGarage: getPriorityGarageStatus()
    }
  }
}
