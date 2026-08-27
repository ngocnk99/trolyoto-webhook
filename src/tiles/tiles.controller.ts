import { Controller, Get, Param, Res } from '@nestjs/common'
import type { Response } from 'express'

/**
 * Proxy tile bản đồ cho Leaflet (buyer + gara).
 *
 * VÌ SAO CẦN — 27/08/2026:
 * Mạng VNPT băng rộng cố định chặn openstreetmap.org ở HAI tầng:
 *   1. DNS trả 127.0.0.1 / ::1 cho *.openstreetmap.org
 *   2. DPI đọc SNI trong ClientHello rồi bắn RST
 * Tầng 2 là lý do đổi DNS sang 8.8.8.8 KHÔNG cứu được — đã đo: nối thẳng tới IP
 * Fastly thì TCP connect thành công, nhưng gửi ClientHello mang SNI
 * `tile.openstreetmap.org` là bị reset ngay; đổi SNI sang `www.fastly.com` trên
 * ĐÚNG IP đó thì bắt tay TLS chạy bình thường.
 * Gói RST quay về sau ~8ms trong khi router nhà chỉ 3ms và Fastly ~60ms → thiết
 * bị chặn nằm trong mạng VNPT, không phải router người dùng.
 * Hệ quả: mọi khách dùng internet VNPT thấy bản đồ trắng ở cả buyer lẫn gara.
 *
 * CÁCH CHỮA: server này chạy Render region Singapore — ngoài mạng VNPT — nên
 * fetch tile bình thường. Client gọi về domain proxy, SNI khi đó là domain của
 * mình nên DPI không có chuỗi nào để khớp.
 *
 * ĐÂY LÀ FIX TẠM cho sự cố production. Kế hoạch dài hạn là chuyển sang Google Maps.
 *
 * LƯU Ý PHÁP LÝ: OSM Tile Usage Policy không cho phép proxy lại tile của họ. Nếu
 * OSM chặn IP của Render, set env TILE_UPSTREAM=carto để đổi nguồn sang CARTO
 * (miễn phí 5 triệu tile/tháng, có cho phép dùng thương mại).
 */

type TileSource = (z: number, x: number, y: number) => string

const UPSTREAMS: Record<string, TileSource> = {
  osm: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  carto: (z, x, y) =>
    `https://basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`
}

const PRIMARY = process.env.TILE_UPSTREAM === 'carto' ? 'carto' : 'osm'
const FALLBACK = PRIMARY === 'osm' ? 'carto' : 'osm'

const MAX_ZOOM = 19
const UPSTREAM_TIMEOUT_MS = 10_000

/**
 * Cache RAM. Tile OSM gần như không đổi nên giữ lại tránh gọi upstream lặp —
 * vừa đỡ tốn bandwidth Render (plan starter có hạn mức), vừa tránh bị OSM
 * rate-limit. 2000 tile * ~15KB ≈ 30MB, an toàn với 512MB RAM của starter.
 */
const CACHE_MAX = 2000
const cache = new Map<string, { body: Buffer; type: string }>()

const stats = {
  hit: 0,
  miss: 0,
  fallbackUsed: 0,
  upstreamError: 0,
  lastError: null as string | null,
  lastErrorAt: null as string | null
}

function cacheGet(key: string) {
  const v = cache.get(key)
  if (!v) return undefined
  // Chạm vào -> đẩy xuống cuối Map để key ít dùng nhất nằm đầu (LRU).
  cache.delete(key)
  cache.set(key, v)
  return v
}

function cacheSet(key: string, value: { body: Buffer; type: string }) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
}

async function fetchTile(url: string) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // OSM policy bắt buộc User-Agent định danh được, không dùng UA mặc định.
        'User-Agent': 'trolyoto-tile-proxy/1.0 (+https://www.trolyoto.com)',
        Referer: 'https://www.trolyoto.com'
      }
    })
    if (!r.ok) throw new Error(`upstream ${r.status}`)
    return {
      body: Buffer.from(await r.arrayBuffer()),
      type: r.headers.get('content-type') ?? 'image/png'
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Dùng chung cho /tiles/_stats và /version. Gọi /version mà thấy field `tiles`
 * nghĩa là bản deploy ĐÃ có proxy tile — khỏi phải đoán qua log Render.
 */
export function getTilesStatus() {
  return {
    primary: PRIMARY,
    fallback: FALLBACK,
    cacheSize: cache.size,
    cacheMax: CACHE_MAX,
    ...stats
  }
}

@Controller()
export class TilesController {
  /**
   * Xem proxy có sống và cache có ăn không mà không phải mở log Render.
   * Phải khai báo TRƯỚC route :z/:x/:y, nếu không '_stats' sẽ bị nuốt thành `z`.
   */
  @Get('tiles/_stats')
  tileStats() {
    return getTilesStatus()
  }

  @Get('tiles/:z/:x/:y')
  async tile(
    @Param('z') zRaw: string,
    @Param('x') xRaw: string,
    @Param('y') yRaw: string,
    @Res() res: Response
  ) {
    const z = Number(zRaw)
    const x = Number(xRaw)
    // Leaflet gọi /tiles/{z}/{x}/{y}.png nên y mang sẵn đuôi .png.
    const y = Number(yRaw.replace(/\.png$/i, ''))

    // Chặn giá trị rác trước khi ghép vào URL upstream (tránh SSRF).
    const limit = 2 ** z
    const valid =
      Number.isInteger(z) &&
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      z >= 0 &&
      z <= MAX_ZOOM &&
      x >= 0 &&
      x < limit &&
      y >= 0 &&
      y < limit
    if (!valid) {
      res.status(400).json({ error: 'invalid tile coordinates' })
      return
    }

    const key = `${PRIMARY}/${z}/${x}/${y}`
    const cached = cacheGet(key)
    if (cached) {
      stats.hit++
      send(res, cached, 'HIT')
      return
    }
    stats.miss++

    let tile: { body: Buffer; type: string }
    try {
      tile = await fetchTile(UPSTREAMS[PRIMARY](z, x, y))
    } catch (err) {
      // Upstream chính hỏng thì thử nguồn còn lại — thà bản đồ khác style một
      // chút còn hơn để khách nhìn ô trắng.
      stats.upstreamError++
      stats.lastError = err instanceof Error ? err.message : String(err)
      stats.lastErrorAt = new Date().toISOString()
      try {
        tile = await fetchTile(UPSTREAMS[FALLBACK](z, x, y))
        stats.fallbackUsed++
      } catch {
        res.status(502).json({ error: 'tile upstream unavailable' })
        return
      }
    }

    cacheSet(key, tile)
    send(res, tile, 'MISS')
  }
}

function send(res: Response, tile: { body: Buffer; type: string }, cacheState: string) {
  res.setHeader('Content-Type', tile.type)
  // Tile hầu như không đổi -> để browser giữ lâu, giảm hẳn request về Render.
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable')
  res.setHeader('X-Tile-Cache', cacheState)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.send(tile.body)
}
