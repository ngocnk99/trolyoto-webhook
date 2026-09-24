/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  vision-bench — đo `analyzeTireImage` (đọc thành lốp) trên bộ ảnh RoadX.
 *
 *  Bộ ảnh (C:\Users\Admin\Pictures\SAILUN_ROADX_WEBP) hầu hết THẤY THƯƠNG HIỆU
 *  nhưng KHÔNG thấy kích cỡ → đây là bài test BỊA ĐẶT: model nào tự nghĩ ra
 *  size là model nguy hiểm, vì bot lấy size đó đi tra catalog và báo giá sai.
 *
 *  analyzeTireImage() nhận URL và tự tải ảnh (FB CDN chặn OpenAI fetch trực
 *  tiếp) → harness dựng 1 HTTP server tĩnh tạm để phục vụ ảnh cục bộ, KHÔNG
 *  cần upload lên Supabase.
 *
 *    cd fb-webhook-server
 *    AI_USAGE_LOG_ENABLED=false VISION_MODEL=gpt-4o \
 *      npx ts-node --transpile-only -r dotenv/config scripts/model-bench/vision-bench.ts [soAnh]
 * ─────────────────────────────────────────────────────────────────────────────
 */
import fs from 'fs'
import http from 'http'
import path from 'path'
import { installBenchFetch, takeCalls, costOf } from './bench-fetch'

const MODEL = process.env.VISION_MODEL ?? 'gpt-4o'
installBenchFetch({ model: MODEL, effort: process.env.BENCH_EFFORT ?? 'none' })

import { analyzeTireImage } from '../../src/fb/ai-helper'

const IMG_DIR = process.env.BENCH_IMG_DIR ?? 'C:/Users/Admin/Pictures/SAILUN_ROADX_WEBP'
const OUT_DIR =
  process.env.BENCH_OUT_DIR ??
  'C:/Users/Admin/AppData/Local/Temp/claude/c--code-FL-trolyoto-production-buyer/2d232071-314d-4740-8ffe-f3b8a42567be/scratchpad/model-bench'
const PORT = Number(process.env.BENCH_IMG_PORT ?? 8799)

function serve(dirRaw: string): Promise<http.Server> {
  // path.resolve cả 2 phía: IMG_DIR viết dấu "/" còn path.join trả dấu "\"
  // trên Windows → so chuỗi thô sẽ luôn trượt (404).
  const dir = path.resolve(dirRaw)
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const name = decodeURIComponent((req.url ?? '/').replace(/^\//, ''))
      const file = path.resolve(dir, name)
      if (!file.startsWith(dir) || !fs.existsSync(file)) {
        res.writeHead(404).end('no')
        return
      }
      res.writeHead(200, { 'Content-Type': 'image/webp' })
      fs.createReadStream(file).pipe(res)
    })
    server.listen(PORT, () => resolve(server))
  })
}

async function main(): Promise<void> {
  if (process.env.AI_USAGE_LOG_ENABLED !== 'false') {
    console.error('DỪNG: phải set AI_USAGE_LOG_ENABLED=false.')
    process.exit(1)
  }
  const limit = Number(process.argv[2] ?? 20)
  const files = fs
    .readdirSync(IMG_DIR)
    .filter(f => /\.(webp|jpe?g|png)$/i.test(f))
    .slice(0, limit)
  const server = await serve(IMG_DIR)
  console.log(`\n=== VISION ${MODEL} — ${files.length} ảnh`)

  const rows: any[] = []
  for (const f of files) {
    takeCalls()
    const t0 = Date.now()
    const r = await analyzeTireImage(`http://127.0.0.1:${PORT}/${encodeURIComponent(f)}`)
    const ms = Date.now() - t0
    const calls = takeCalls()
    const cost = calls.reduce((s, c) => s + costOf(c), 0)
    rows.push({ file: f, ...r, ms, cost })
    console.log(
      `  ${f.padEnd(24)} size=${String(r.tire_size ?? '—').padEnd(12)} brand=${String(r.brand ?? '—').padEnd(12)} conf=${r.confidence} ${ms}ms $${cost.toFixed(5)}`
    )
  }
  server.close()

  // Ảnh KHÔNG có size trên thành lốp → mọi size trả về đều là BỊA.
  const invented = rows.filter(r => r.tire_size).length
  const brandOk = rows.filter(r => /roadx|road x|sailun/i.test(String(r.brand ?? ''))).length
  const totalCost = rows.reduce((s, r) => s + r.cost, 0)
  console.log(
    `\n${MODEL}: bịa size ${invented}/${rows.length} | đọc đúng hãng ${brandOk}/${rows.length} | $${totalCost.toFixed(4)} | trung bình ${Math.round(rows.reduce((s, r) => s + r.ms, 0) / rows.length)}ms`
  )
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const out = path.join(OUT_DIR, `vision-${MODEL}.json`)
  fs.writeFileSync(out, JSON.stringify({ model: MODEL, rows }, null, 2), 'utf8')
  console.log(`→ ${out}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
