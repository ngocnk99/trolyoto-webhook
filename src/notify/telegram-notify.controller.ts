import { Body, Controller, Get, Header, Post, Req } from '@nestjs/common'
import type { Request } from 'express'

/**
 * POST /notify/telegram — chuyển tiếp một đoạn text vào kênh log Telegram.
 *
 * Vì sao cần cái này: trang duyệt thiết kế Settings là một Artifact đã publish,
 * và sandbox của nó chặn toàn bộ fetch/XHR ra ngoài. Một form submit thì là
 * điều hướng, không phải fetch, nên không bị chặn — trang POST một form vào đây
 * và server gọi Telegram. Cách này cũng giữ token khỏi một trang được chia sẻ
 * công khai.
 *
 * Không yêu cầu đăng nhập: người duyệt là người được gửi link, họ không có tài
 * khoản và form cũng không đính token được. Đổi lại đây là một đường ghi mở vào
 * đúng một kênh, nên có chặn theo kích thước và theo tần suất mỗi IP, và mọi
 * tin đều mang nhãn nguồn.
 */

// Cố định trong code theo yêu cầu. Token nằm trong git history — nếu cần vô
// hiệu hoá thì thu hồi và cấp lại bot bên Telegram, không sửa code.
const TG_TOKEN = '8725302553:AAFqlJrAc2f64JnMNvPz3TxAl_X6BsjQHL8'
const TG_CHAT = '-5026164513'

const MAX_TEXT = 60_000
const TG_CHUNK = 3500 // sendMessage cap là 4096; chừa chỗ cho tiêu đề mỗi phần
const MAX_PARTS = 12
const RATE_WINDOW_MS = 10 * 60 * 1000
const RATE_MAX = 8

// Cố ý để trong RAM: restart làm mất bộ đếm là hành vi đúng cho một hàng rào
// chống spam vào một kênh debug. Lưu xuống DB là thêm máy móc hơn mức rủi ro.
const hits = new Map<string, number[]>()

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const seen = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
  if (seen.length >= RATE_MAX) {
    hits.set(ip, seen)
    return true
  }
  seen.push(now)
  hits.set(ip, seen)
  if (hits.size > 5000) hits.clear()
  return false
}

/** Cắt theo ranh giới dòng để không xẻ đôi một mục giữa hai tin nhắn. */
function chunk(text: string, size: number): string[] {
  const out: string[] = []
  let current = ''
  for (const line of text.split('\n')) {
    if (current && current.length + line.length + 1 > size) {
      out.push(current)
      current = ''
    }
    // Một dòng dài hơn cả một tin nhắn thì buộc phải cắt cứng.
    if (line.length > size) {
      if (current) {
        out.push(current)
        current = ''
      }
      for (let i = 0; i < line.length; i += size) out.push(line.slice(i, i + size))
      continue
    }
    current = current ? `${current}\n${line}` : line
  }
  if (current.trim()) out.push(current)
  return out.length ? out : ['(rỗng)']
}

async function sendOne(text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text,
        disable_web_page_preview: true
      })
    })
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn('[notify/telegram] Telegram từ chối:', res.status, (await res.text()).slice(0, 200))
      return false
    }
    return true
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[notify/telegram] gọi Telegram lỗi:', (err as Error).message)
    return false
  }
}

function page(title: string, body: string, ok: boolean): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c110d;color:#e9f2ea;
font:15px/1.6 ui-sans-serif,system-ui,sans-serif;text-align:center;padding:24px}
h1{font-size:19px;margin:0 0 8px;color:${ok ? '#b9f24d' : '#ff5f56'}}
p{margin:0;color:#9fb2a3;max-width:48ch}</style>
<div><h1>${title}</h1><p>${body}</p></div>`
}

@Controller('notify')
export class TelegramNotifyController {
  @Get('telegram')
  probe() {
    return { service: 'notify/telegram', method: 'POST', field: 'text' }
  }

  @Post('telegram')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async send(
    @Body() body: Record<string, unknown>,
    @Req() req: Request
  ): Promise<string> {
    const ip =
      String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() ||
      req.ip ||
      'unknown'

    if (rateLimited(ip)) {
      return page('Gửi quá nhanh', 'Đợi vài phút rồi gửi lại. Nội dung vẫn còn trong trình duyệt.', false)
    }

    const text = typeof body?.text === 'string' ? body.text : ''
    if (!text.trim()) {
      return page('Không có gì để gửi', 'Thiếu trường text.', false)
    }
    if (text.length > MAX_TEXT) {
      return page('Nội dung quá dài', `Tối đa ${MAX_TEXT} ký tự.`, false)
    }

    const title = typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : 'NOTIFY'
    const parts = chunk(text, TG_CHUNK)
    if (parts.length > MAX_PARTS) {
      return page('Nội dung quá dài', `Cần ${parts.length} tin nhắn, tối đa ${MAX_PARTS}.`, false)
    }

    let sent = 0
    for (let i = 0; i < parts.length; i += 1) {
      const head = parts.length > 1 ? `${title} (${i + 1}/${parts.length})\n\n` : ''
      // Tuần tự, không song song: Telegram giới hạn tần suất mỗi chat, và gửi
      // song song thì các phần đến không đúng thứ tự.
      // eslint-disable-next-line no-await-in-loop
      if (await sendOne(head + parts[i])) sent += 1
    }

    if (sent === 0) {
      return page('Gửi thất bại', 'Không gửi được sang Telegram. Thử lại sau.', false)
    }
    if (sent < parts.length) {
      return page(
        'Gửi thiếu',
        `Chỉ ${sent}/${parts.length} tin nhắn tới nơi. Nội dung đã được chép vào clipboard, bạn dán bù phần thiếu.`,
        false
      )
    }
    return page(
      'Đã gửi',
      parts.length > 1
        ? `${parts.length} tin nhắn đã vào kênh log. Đóng tab này và quay lại trang duyệt.`
        : 'Đã vào kênh log. Đóng tab này và quay lại trang duyệt.',
      true
    )
  }
}
