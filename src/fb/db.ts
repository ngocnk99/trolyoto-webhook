/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Facebook Messenger bot — DB layer (STANDALONE)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  ĐÂY LÀ RANH GIỚI DUY NHẤT giữa flow handler của FB bot và database.
 *  Mọi truy vấn DB của FB bot PHẢI đi qua file này.
 *
 *  KHÔNG import gì từ `@/libs/chat/*` — file này độc lập hoàn toàn,
 *  chỉ dùng `supabaseAmin` (service role) + `province.json` để tra tỉnh.
 *
 *  ── Cách dùng ───────────────────────────────────────────────────────────────
 *  import { fetchTireCatalog, fetchGarageOffers, resolveProvince } from './db'
 *
 *  ── 3 hàm boundary ──────────────────────────────────────────────────────────
 *  1. fetchTireCatalog   — sản phẩm lốp (productadmin) theo size + brand + phân trang
 *  2. fetchGarageOffers  — đại lý chào giá (product JOIN garage JOIN productadmin)
 *  3. resolveProvince    — bóc mã tỉnh/TP từ free text user nhập
 *
 *  ── Schema reference ────────────────────────────────────────────────────────
 *  - `productadmin`: bảng SP chung. Lọc tire: type='SAN_PHAM', type2='LOP',
 *     status=true, forsale=true. SIZE format: "185_65R15" (slash → underscore).
 *  - `product`: bảng SP của gara. Lọc: status=true, display=true. JOIN với
 *     `garage` (FK garage_id) + `productadmin` (FK product_id).
 *  - `garage`: bảng đại lý. Có `province_code` ('01'=HN, '79'=HCM...), `code`,
 *     `name`, `hotline`, `information` (JSONB chứa address), `rating`, `slug`.
 */

import { supabaseAmin } from './supabase'
import provinceJson from '../province.json'
import wardJson from '../ward.json'
import { extractProvinceFromAddress } from './ai-helper'

// ── Public TYPES (input/output contracts) ─────────────────────────────────────

/** Sản phẩm lốp hiển thị trong gợi ý (đã có ảnh, giá, KM, slug để build URL) */
export interface TireCatalogItem {
  id: string
  name: string
  /** Hãng lốp viết HOA: MICHELIN, BRIDGESTONE, ... */
  brand: string
  /** Kích cỡ hiển thị: "185/65R15" (đã convert từ DB "185_65R15") */
  size: string
  /** Giá niêm yết (đ) — từ productadmin.price */
  price: number
  /** Giá khuyến mại nếu có (đ) — từ productadmin.lastprice nếu < price */
  promotional_price?: number
  rating?: number
  quantitysold?: number | null
  /** Slug để build URL `trolyoto.com/lop/{slug}` */
  slug: string
  /** Mã sản phẩm (`productadmin.code`) — hiển thị cho CSKH biết SP nào user chọn */
  code?: string | null
  /** URL ảnh chính (đã build full URL từ `main_image`) */
  image?: string
}

/** Đại lý/gara đang chào giá cho 1 sản phẩm cụ thể */
export interface GarageOffer {
  garageName: string
  garageCode: string | null
  hotline: string
  address: string
  garageRating: number | null
  garageCountRate: number | null
  /** Giá niêm yết tại gara (đ) — product.price */
  lastprice: number
  /** Giá cuối cùng sau KM (đ) — product.lastprice nếu < price, ngược lại = price */
  finalPrice: number
  hasPromotion: boolean
  /** URL chi tiết SP tại gara (gắn vào button "Xem khuyến mại") */
  detailUrl: string
  garageSold: number | null
}

export interface GarageOfferGroup {
  product: TireCatalogItem
  garages: GarageOffer[]
}

export interface ProvinceResolution {
  /** Mã tỉnh chuẩn ('01' = Hà Nội, '79' = TP.HCM, ...) */
  code: string | null
  /** Tên tỉnh hiển thị ('Hà Nội', 'Hồ Chí Minh', ...) */
  name: string | null
}

export type GarageSortBy = 'quantitysold' | 'lowest_price'

/** V3: 1 ward match từ ward.json — hiển thị cho khách xác nhận khi province không resolve. */
export interface WardMatch {
  code: string
  name: string // 'Phường Thái Bình' / 'Xã Thái Bình'
  path: string // 'Thái Bình, Hưng Yên'
  path_with_type: string // 'Phường Thái Bình, Tỉnh Hưng Yên'
  parent_code: string // province code cũ (vd '34')
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TROLYOTO_URL = 'https://trolyoto.com'

// URL ảnh: ưu tiên env NEXT_PUBLIC_SUPABASE_IMAGE_URL, fallback URL Supabase production
const IMAGE_BASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_IMAGE_URL ||
  'https://zhxqbnaoeohcryrbemqx.supabase.co/storage/v1/object/public/images'

// ── 1. fetchTireCatalog ───────────────────────────────────────────────────────

/**
 * Lấy danh sách sản phẩm lốp (productadmin) theo size + brand, có phân trang.
 *
 * Query: productadmin WHERE type='SAN_PHAM' AND type2='LOP' AND status=true
 *        AND forsale=true AND SIZE=<converted> AND BRAND IN <brands>
 * Sort:  quantitysold DESC, rating DESC, lastprice ASC
 *
 * @param tireSize  '185/65R15' (sẽ tự convert thành '185_65R15' cho DB)
 * @param tireBrand '__skip_brand__' | 'MICHELIN|HANKOOK' (pipe) | 'MICHELIN'
 * @param skip      Default 0
 * @param limit     Default 3
 */
export async function fetchTireCatalog(params: {
  tireSize: string
  tireBrand: string
  skip?: number
  limit?: number
}): Promise<{
  items: TireCatalogItem[]
  productadminIds: string[]
  total: number
}> {
  const { tireSize, tireBrand, skip = 0, limit = 3 } = params
  const sizeKey = toSizeKey(tireSize) // '185/65R15' → '185_65R15'

  if (!sizeKey) return { items: [], productadminIds: [], total: 0 }

  let query = supabaseAmin
    .from('productadmin')
    .select(
      'id, name, BRAND, SIZE, slug, code, price, lastprice, promotional_price, rating, quantitysold, main_image',
      { count: 'exact' }
    )
    .eq('type', 'SAN_PHAM')
    .eq('type2', 'LOP')
    .eq('status', true)
    .eq('forsale', true)
    .eq('SIZE', sizeKey)

  const brands = parseBrandFilter(tireBrand)
  if (brands.length > 0) {
    query = query.in('BRAND', brands)
  }

  // Sort theo lastprice ASC (rẻ nhất trước), rating DESC, quantitysold DESC
  query = query
    .order('lastprice', { ascending: true, nullsFirst: false })
    .order('rating', { ascending: false, nullsFirst: false })
    .order('quantitysold', { ascending: false, nullsFirst: false })
    .range(skip, skip + limit - 1)

  const { data, error, count } = await query
  if (error) {
    console.error('[FB db] fetchTireCatalog error:', error)
    return { items: [], productadminIds: [], total: 0 }
  }

  const items = (data ?? []).map(mapProductadminToCatalogItem)
  return {
    items,
    productadminIds: items.map(p => p.id),
    total: count ?? items.length
  }
}

// ── 1b. getMinPriceForTireSize ────────────────────────────────────────────────

/**
 * Lấy giá thấp nhất (đ) cho 1 kích cỡ lốp, dùng cho dòng báo giá:
 *   "Dạ lốp 225/55R19 giá từ X/lốp, tùy THƯƠNG HIỆU LỐP và GARA ạ."
 *
 * Query: MIN(lastprice) WHERE size + tire filters. Lastprice > 0 only.
 *
 * @param tireBrand Optional brand filter (vd: 'MICHELIN|HANKOOK'); default lấy tất cả.
 * @returns Giá đ (>0) hoặc `null` nếu DB không có sản phẩm hợp lệ.
 */
export async function getMinPriceForTireSize(
  tireSize: string,
  tireBrand?: string
): Promise<number | null> {
  const sizeKey = toSizeKey(tireSize)
  if (!sizeKey) return null

  let q = supabaseAmin
    .from('productadmin')
    .select('lastprice')
    .eq('type', 'SAN_PHAM')
    .eq('type2', 'LOP')
    .eq('status', true)
    .eq('forsale', true)
    .eq('SIZE', sizeKey)
    .gt('lastprice', 0)
    .order('lastprice', { ascending: true, nullsFirst: false })
    .limit(1)

  if (tireBrand) {
    const brands = parseBrandFilter(tireBrand)
    if (brands.length > 0) q = q.in('BRAND', brands)
  }

  const { data, error } = await q
  if (error) {
    console.error('[FB db] getMinPriceForTireSize error:', error)
    return null
  }
  const first = data?.[0]
  if (!first) return null
  const v = num(first.lastprice)
  return v > 0 ? v : null
}

// ── 1c. getProductBriefById ───────────────────────────────────────────────────

/**
 * Lấy thông tin tóm tắt 1 sản phẩm theo id (brand + size + code) — dùng để build
 * label "Chọn SP MICHELIN 185/65R15 - ABC123" cho conversation_log + bot confirmation
 * khi user click postback "Chọn sản phẩm này".
 *
 * @returns `null` nếu không tìm thấy (vd: SP đã bị xóa/disable sau khi user thấy card).
 */
export async function getProductBriefById(
  productId: string
): Promise<TireCatalogItem | null> {
  if (!productId) return null
  const { data, error } = await supabaseAmin
    .from('productadmin')
    .select(
      'id, name, BRAND, SIZE, slug, code, price, lastprice, promotional_price, rating, quantitysold, main_image'
    )
    .eq('id', productId)
    .maybeSingle()

  if (error) {
    console.error('[FB db] getProductBriefById error:', error)
    return null
  }
  if (!data) return null
  return mapProductadminToCatalogItem(data)
}

// ── 1d. fetchTireSizesByCarTags ───────────────────────────────────────────────

export interface TireSizeWithStock {
  /** Hiển thị "185/65R15" */
  size: string
  /** Tổng quantitysold của các sản phẩm cùng size (dùng để sort) */
  quantitysold: number
}

/**
 * Lấy danh sách kích cỡ lốp mà TROLYoto đang bán cho 1 dòng xe, qua bảng tag.
 *
 * Query:  productadmin_tag JOIN productadmin (type=SAN_PHAM, type2=LOP, status=true, forsale=true)
 *         JOIN tag WHERE tag.name IN (tagKeys)
 *
 * @param tagKeys  Mảng tên tag đã chuẩn hoá (lowercase, no diacritic). VD: ["vinfast 3","vf3"].
 *
 * @returns
 *  - `sizes`: danh sách size unique, sort theo `quantitysold` DESC
 *  - `matchedTags`: tag.name thực tế khớp trong DB (để debug)
 *  - `productCount`: số sản phẩm (productadmin) unique đã match
 */
export async function fetchTireSizesByCarTags(tagKeys: string[]): Promise<{
  sizes: TireSizeWithStock[]
  matchedTags: string[]
  productCount: number
}> {
  if (!tagKeys.length) {
    return { sizes: [], matchedTags: [], productCount: 0 }
  }

  const { data, error } = await supabaseAmin
    .from('productadmin_tag')
    .select(
      `
        productadmin!inner (
          id,
          SIZE,
          quantitysold,
          status,
          forsale,
          type,
          type2
        ),
        tag!inner (
          id,
          name
        )
      `
    )
    .eq('productadmin.type', 'SAN_PHAM')
    .eq('productadmin.type2', 'LOP')
    .eq('productadmin.forsale', true)
    .eq('productadmin.status', true)
    .in('tag.name', tagKeys)

  if (error) {
    console.error('[FB db] fetchTireSizesByCarTags error:', error)
    return { sizes: [], matchedTags: [], productCount: 0 }
  }

  // Dedupe theo productadmin.id rồi group theo SIZE
  const seenProducts = new Map<string, { size: string; qty: number }>()
  const matchedTags = new Set<string>()

  for (const row of (data ?? []) as unknown as Array<{
    productadmin:
      | { id: string; SIZE: string | null; quantitysold: number | null }
      | { id: string; SIZE: string | null; quantitysold: number | null }[]
      | null
    tag: { id: string; name: string } | { id: string; name: string }[] | null
  }>) {
    const pa = oneOf(row.productadmin)
    const tg = oneOf(row.tag)
    if (!pa || !tg) continue
    if (!pa.SIZE) continue

    matchedTags.add(tg.name)

    if (!seenProducts.has(pa.id)) {
      seenProducts.set(pa.id, {
        size: fromSizeKey(pa.SIZE),
        qty: num(pa.quantitysold)
      })
    }
  }

  const sizeQtyMap = new Map<string, number>()
  for (const [, v] of Array.from(seenProducts.entries())) {
    if (!v.size) continue
    sizeQtyMap.set(v.size, (sizeQtyMap.get(v.size) ?? 0) + v.qty)
  }

  const sizes: TireSizeWithStock[] = Array.from(sizeQtyMap.entries())
    .map(([size, quantitysold]) => ({ size, quantitysold }))
    .sort((a, b) => b.quantitysold - a.quantitysold)

  return {
    sizes,
    matchedTags: Array.from(matchedTags),
    productCount: seenProducts.size
  }
}

// ── 1e. fetchTireSizesByCartype (V3 — query qua productadmin_cartype) ─────────

/**
 * Lấy danh sách kích cỡ lốp cho 1+ cartype code (vd ["HYUNDAI_ACCENT", "HYUNDAIACCENT"]).
 *
 * Query: productadmin JOIN productadmin_cartype (inner) WHERE
 *        productadmin_cartype.code IN cartypeCodes AND tire filters.
 *
 * Nhận MẢNG để cover các biến thể format ("MAZDA_CX_5" vs "MAZDA_CX5" vs "MAZDACX5"...).
 * Bổ sung cho `fetchTireSizesByCarTags`. Caller gộp 2 kết quả, dedup.
 */
export async function fetchTireSizesByCartype(
  cartypeCodes: string | string[]
): Promise<{
  sizes: TireSizeWithStock[]
  productCount: number
}> {
  const codes = (
    Array.isArray(cartypeCodes) ? cartypeCodes : [cartypeCodes]
  ).filter(c => !!c && c.length > 0)
  console.log('code', codes)
  if (codes.length === 0) return { sizes: [], productCount: 0 }

  const { data, error } = await supabaseAmin
    .from('productadmin')
    .select(
      `
        id,
        SIZE,
        quantitysold,
        productadmin_cartype!inner ( code )
      `
    )
    .eq('type', 'SAN_PHAM')
    .eq('type2', 'LOP')
    .eq('forsale', true)
    .eq('status', true)
    .in('productadmin_cartype.code', codes)

  if (error) {
    console.error('[FB db] fetchTireSizesByCartype error:', error)
    return { sizes: [], productCount: 0 }
  }

  // Dedupe theo productadmin.id rồi group theo SIZE
  const seenProducts = new Map<string, { size: string; qty: number }>()
  for (const row of (data ?? []) as Array<{
    id: string
    SIZE: string | null
    quantitysold: number | null
  }>) {
    if (!row.SIZE) continue
    if (seenProducts.has(row.id)) continue
    seenProducts.set(row.id, {
      size: fromSizeKey(row.SIZE),
      qty: num(row.quantitysold)
    })
  }

  const sizeMap = new Map<string, number>()
  for (const [, v] of Array.from(seenProducts.entries())) {
    if (!v.size) continue
    sizeMap.set(v.size, (sizeMap.get(v.size) ?? 0) + v.qty)
  }

  const sizes: TireSizeWithStock[] = Array.from(sizeMap.entries())
    .map(([size, quantitysold]) => ({ size, quantitysold }))
    .sort((a, b) => b.quantitysold - a.quantitysold)

  console.log(
    `[FB db] fetchTireSizesByCartype([${codes.join(',')}]) → ${sizes.length} sizes from ${seenProducts.size} products`
  )

  return { sizes, productCount: seenProducts.size }
}

// ── 1f. fetchTireSizesByProductSearch (V3 — qua RPC search_products_by_tag) ────
/**
 * Tìm sản phẩm lốp qua Postgres RPC `search_products_by_tag` (giống như cách
 * web buyer search). Mỗi keyword được prefix `"LOP "` để filter chỉ lấy lốp.
 *
 * Caller truyền nhiều keyword variants → chạy song song mỗi keyword 1 RPC call
 * → gộp SIZE từ tất cả results, dedupe theo product id.
 *
 * Ví dụ: keywords = ["VINFAST VF8 PLUS", "VINFASTVF8PLUS"]
 *  → 2 RPC calls: keywords="LOP VINFAST VF8 PLUS" + keywords="LOP VINFASTVF8PLUS"
 *  → gộp SIZE từ products tìm thấy.
 */
export async function fetchTireSizesByProductSearch(
  keywords: string[]
): Promise<{
  sizes: TireSizeWithStock[]
  productCount: number
}> {
  const cleaned = Array.from(
    new Set(keywords.map(k => k.trim()).filter(k => !!k))
  )
  if (cleaned.length === 0) return { sizes: [], productCount: 0 }

  const results = await Promise.all(
    cleaned.map(async kw => {
      let searchKw = `${kw}`.toLocaleUpperCase().trim()
      if (searchKw.includes('VINFAST') && searchKw.includes('VF')) {
        searchKw = searchKw.replace('VINFAST', '').trim()
      }
      const { data, error } = await supabaseAmin.rpc('search_products_by_tag', {
        keywords: searchKw,
        category: ['LOP'],
        sort_by: 'quantitysold',
        sort_direction: 'desc',
        page_number: 1,
        page_size: 50
      })
      if (error) {
        console.error(
          `[FB db] fetchTireSizesByProductSearch("${searchKw}") rpc error:`,
          error.message
        )
        return [] as Array<{
          id: string
          SIZE: string | null
          quantitysold: number | null
        }>
      }
      const first = Array.isArray(data)
        ? (data as Array<{ products: unknown }>)[0]
        : null
      const products = (first?.products ?? []) as Array<{
        id: string
        SIZE: string | null
        quantitysold: number | null
      }>
      console.log(
        `[FB db] fetchTireSizesByProductSearch("${searchKw}") → ${products.length} products`
      )
      return products
    })
  )

  // Dedupe theo product id, group theo SIZE
  const seenProducts = new Map<string, { size: string; qty: number }>()
  for (const products of results) {
    for (const p of products) {
      if (!p.SIZE) continue
      if (seenProducts.has(p.id)) continue
      seenProducts.set(p.id, {
        size: fromSizeKey(p.SIZE),
        qty: num(p.quantitysold)
      })
    }
  }

  const sizeMap = new Map<string, number>()
  for (const [, v] of Array.from(seenProducts.entries())) {
    if (!v.size) continue
    sizeMap.set(v.size, (sizeMap.get(v.size) ?? 0) + v.qty)
  }

  const sizes: TireSizeWithStock[] = Array.from(sizeMap.entries())
    .map(([size, quantitysold]) => ({ size, quantitysold }))
    .sort((a, b) => b.quantitysold - a.quantitysold)

  console.log(
    `[FB db] fetchTireSizesByProductSearch([${cleaned.join('|')}]) → ${sizes.join(',')} sizes from ${seenProducts.size} products`
  )

  return { sizes, productCount: seenProducts.size }
}

// ── 2. fetchGarageOffers ──────────────────────────────────────────────────────

/**
 * Lấy danh sách đại lý chào giá cho các sản phẩm + lọc theo tỉnh.
 *
 * Query: product (status=true, display=true, product_id IN ids)
 *        INNER JOIN productadmin (status=true)
 *        INNER JOIN garage (status=true, province_code=? optional)
 */
export async function fetchGarageOffers(params: {
  productadminIds: string[]
  provinceCode: string | null
  /** V3: filter theo ward_code (chính xác hơn province). Ưu tiên hơn provinceCode nếu có. */
  wardCode?: string | null
  maxGaragesPerTire?: number
  sortBy?: GarageSortBy
  excludeGarageCodes?: string[]
  maxFinalPriceFloor?: number
}): Promise<GarageOfferGroup[]> {
  const {
    productadminIds,
    provinceCode,
    wardCode,
    maxGaragesPerTire = 3,
    sortBy = 'lowest_price',
    excludeGarageCodes = [],
    maxFinalPriceFloor
  } = params

  if (!productadminIds.length) return []

  // V3 yêu cầu BẮT BUỘC có province_code HOẶC ward_code — không bao giờ search all
  if (!provinceCode && !wardCode) {
    console.warn(
      '[FB db] fetchGarageOffers SKIP — yêu cầu provinceCode hoặc wardCode'
    )
    return []
  }

  // Lấy thông tin productadmin để gắn vào group
  const { data: paRows, error: paErr } = await supabaseAmin
    .from('productadmin')
    .select(
      'id, name, BRAND, SIZE, slug, code, price, lastprice, promotional_price, rating, quantitysold, main_image'
    )
    .in('id', productadminIds)

  if (paErr) {
    console.error('[FB db] fetchGarageOffers (productadmin) error:', paErr)
    return []
  }
  const productMap = new Map<string, TireCatalogItem>(
    (paRows ?? []).map(r => [r.id, mapProductadminToCatalogItem(r)])
  )

  // Lấy product (gara) JOIN garage cho các product_id
  // Note: dùng garage!inner để filter theo province_code / ward_code
  let pQuery = supabaseAmin
    .from('product')
    .select(
      `
        id,
        product_id,
        price,
        lastprice,
        promotional_price,
        is_promotion,
        quantitysold,
        garage:garage_id!inner (
          id,
          name,
          code,
          hotline,
          status,
          rating,
          count_rate,
          slug,
          information,
          province_code,
          ward_code
        )
      `
    )
    .in('product_id', productadminIds)
    .eq('status', true)
    .eq('display', true)
    .eq('garage.status', true)

  // Ưu tiên ward_code (chính xác hơn). Có ward_code → filter theo ward.
  // Không có ward_code mà có province_code → filter theo province.
  if (wardCode) {
    pQuery = pQuery.eq('garage.ward_code', wardCode)
  } else if (provinceCode) {
    pQuery = pQuery.eq('garage.province_code', provinceCode)
  }

  const { data: prows, error: pErr } = await pQuery
  if (pErr) {
    console.error('[FB db] fetchGarageOffers (product) error:', pErr)
    return []
  }

  // Group theo product_id
  // Supabase TS infer FK relation thành array; runtime với FK 1-1 trả single object.
  // Cast qua unknown + normalize bằng `oneOf` để xử lý cả 2 trường hợp.
  const groups = new Map<string, GarageOffer[]>()
  for (const row of (prows ?? []) as unknown as ProductJoinedRow[]) {
    if (!row.product_id) continue
    const g = oneOf(row.garage)
    if (!g) continue

    // Pass productSlug để buildGarageOffer build URL /lop/{slug}?code-gara={code}
    const productSlug = productMap.get(row.product_id)?.slug ?? null
    const offer = buildGarageOffer(row, g, productSlug)
    if (!offer) continue

    // Filter exclude
    if (offer.garageCode && excludeGarageCodes.includes(offer.garageCode)) {
      continue
    }
    // Filter price floor
    if (
      typeof maxFinalPriceFloor === 'number' &&
      offer.finalPrice >= maxFinalPriceFloor
    ) {
      continue
    }

    if (!groups.has(row.product_id)) groups.set(row.product_id, [])
    groups.get(row.product_id)!.push(offer)
  }

  const result: GarageOfferGroup[] = []
  for (const [productId, garages] of Array.from(groups.entries())) {
    const product = productMap.get(productId)
    if (!product) continue

    // Sort
    if (sortBy === 'lowest_price') {
      garages.sort((a, b) => a.finalPrice - b.finalPrice)
    } else {
      garages.sort(
        (a, b) =>
          (b.garageSold ?? 0) - (a.garageSold ?? 0) ||
          (b.garageRating ?? 0) - (a.garageRating ?? 0)
      )
    }

    result.push({ product, garages: garages.slice(0, maxGaragesPerTire) })
  }

  return result
}

// ── 2b. fetchSpGaraCards (V2: SP + gara gộp) ──────────────────────────────────

/**
 * 1 card SP+gara cho luồng V2 — mỗi item = 1 sản phẩm tại 1 gara cụ thể.
 *
 * Hiển thị theo PDF V2: ảnh SP - tên SP đầy đủ - gara - giá - nút "Xem khuyến mại".
 */
export interface SpGaraCard {
  /** productadmin.id */
  productId: string
  /** Hãng lốp HOA: MICHELIN, ... */
  brand: string
  /** Kích cỡ hiển thị: "185/65R15" */
  size: string
  /** slug để build URL "/lop/{slug}" (Xem gara khác / Xem SP khác) */
  productSlug: string
  /** Ảnh SP (full URL đã build từ main_image) */
  image?: string
  /** Giá niêm yết SP (đ) — productadmin.price */
  productListPrice: number
  /** Tên gara */
  garageName: string
  /** garage.code (dùng cho de-dup ở "Giá tốt hơn") */
  garageCode: string | null
  /** Địa chỉ gara (đã compose từ JSONB) */
  garageAddress: string
  /** Đánh giá gara */
  garageRating: number | null
  /** Giá cuối cùng tại gara (đ) — sau KM */
  finalPrice: number
  /** Lượt bán của gara (sort khi sortBy='quantitysold') */
  garageSold: number | null
  /** Link "Xem khuyến mại" → trang chi tiết SP của gara */
  detailUrl: string
}

/**
 * Lấy danh sách SP+gara cho luồng V2.
 *
 * Vào: size + brand + (optional) province + sort/exclude/floor.
 * Ra: mảng SpGaraCard đã sort, cap theo `limit`.
 *
 * Implementation HIỆN TẠI: wrap `fetchTireCatalog` + `fetchGarageOffers` (tạm).
 * → TODO (user sẽ tối ưu): viết 1 query trực tiếp join productadmin + product + garage
 *    để giảm số roundtrip + sort/limit ở DB.
 *
 * @param params.tireSize     '185/65R15'
 * @param params.tireBrand    '__skip_brand__' | 'MICHELIN|HANKOOK'
 * @param params.provinceCode mã tỉnh — null = toàn quốc (gara hỗ trợ ship)
 * @param params.limit        số card tối đa (default 3 — đúng PDF V2)
 * @param params.sortBy       'quantitysold' (default) hoặc 'lowest_price'
 * @param params.excludeGarageCodes  danh sách garage.code đã hiển thị (de-dup)
 * @param params.maxFinalPriceFloor  chỉ trả item có finalPrice < số này
 *
 * @returns Mảng SpGaraCard. Empty nếu không có kết quả.
 */
export async function fetchSpGaraCards(params: {
  tireSize: string
  tireBrand: string
  provinceCode: string | null
  /** V3: ưu tiên ward_code hơn province_code. Khi có ward_code → filter theo ward. */
  wardCode?: string | null
  limit?: number
  sortBy?: GarageSortBy
  excludeGarageCodes?: string[]
  maxFinalPriceFloor?: number
}): Promise<SpGaraCard[]> {
  const {
    tireSize,
    tireBrand,
    provinceCode,
    wardCode,
    limit = 3,
    sortBy = 'lowest_price',
    excludeGarageCodes,
    maxFinalPriceFloor
  } = params

  // BẮT BUỘC có province_code HOẶC ward_code
  if (!provinceCode && !wardCode) {
    console.warn(
      '[DB fetchSpGaraCards] SKIP — yêu cầu provinceCode hoặc wardCode'
    )
    return []
  }

  console.log(
    `[DB fetchSpGaraCards] params: size="${tireSize}" brand="${tireBrand}" provinceCode="${provinceCode}" wardCode="${wardCode}" limit=${limit} sortBy=${sortBy}`
  )

  // 1. Lấy danh sách SP theo size+brand (rộng để có đủ gara map qua).
  //    Khi có lọc theo giá (maxFinalPriceFloor) → nới cap lên 30, tránh trường
  //    hợp top-10 mặc định toàn hàng đắt bị lọc sạch trong khi catalog vẫn còn
  //    SP rẻ hơn ở ngoài top-10 (theo lastprice ASC).
  const { items, productadminIds } = await fetchTireCatalog({
    tireSize,
    tireBrand,
    skip: 0,
    limit: typeof maxFinalPriceFloor === 'number' ? 30 : 10
  })
  console.log(
    `[DB fetchSpGaraCards] fetchTireCatalog → ${items.length} products (sizeKey=${toSizeKey(tireSize)})`
  )
  if (productadminIds.length === 0) return []
  const productMap = new Map(items.map(p => [p.id, p]))

  // 2. Lấy gara theo productIds + (ward_code hoặc province_code)
  const groups = await fetchGarageOffers({
    productadminIds,
    provinceCode,
    wardCode,
    maxGaragesPerTire: 3,
    sortBy,
    excludeGarageCodes,
    maxFinalPriceFloor
  })
  console.log(
    `[DB fetchSpGaraCards] fetchGarageOffers(ward=${wardCode}, province=${provinceCode}, productIds=${productadminIds.length}) → ${groups.length} groups, total ${groups.reduce((s, g) => s + g.garages.length, 0)} gara offers`
  )

  // 3. Flatten thành cặp SP+gara, sort overall, cap limit
  type Pair = { product: TireCatalogItem; offer: GarageOffer }
  const pairs: Pair[] = []
  for (const g of groups) {
    for (const o of g.garages) pairs.push({ product: g.product, offer: o })
  }
  if (sortBy === 'lowest_price') {
    pairs.sort((a, b) => a.offer.finalPrice - b.offer.finalPrice)
  } else {
    pairs.sort(
      (a, b) =>
        (b.offer.garageSold ?? 0) - (a.offer.garageSold ?? 0) ||
        (b.offer.garageRating ?? 0) - (a.offer.garageRating ?? 0)
    )
  }

  return pairs.slice(0, limit).map(({ product, offer }) => {
    const p = productMap.get(product.id) ?? product
    return {
      productId: p.id,
      brand: p.brand,
      size: p.size,
      productSlug: p.slug,
      image: p.image,
      productListPrice: p.price,
      garageName: offer.garageName,
      garageCode: offer.garageCode,
      garageAddress: offer.address,
      garageRating: offer.garageRating,
      finalPrice: offer.finalPrice,
      garageSold: offer.garageSold,
      detailUrl: offer.detailUrl
    }
  })
}

// ── 3. resolveProvince ────────────────────────────────────────────────────────

type ProvinceEntry = {
  name: string
  name_with_type: string
  code: string
  slug: string
  type: string
}
const PROVINCE_MAP = provinceJson as Record<string, ProvinceEntry>

/**
 * Match heuristic (sync) — chỉ dùng province.json + alias phổ biến.
 * Dùng nội bộ + làm bước đầu cho `resolveProvince()` async.
 */
export function resolveProvinceSync(text: string): ProvinceResolution {
  const haystack = stripVn(text)
  if (!haystack) return { code: null, name: null }

  let best: { code: string; name: string; score: number } | null = null

  for (const [code, p] of Object.entries(PROVINCE_MAP)) {
    const candidates = [
      stripVn(p.name),
      stripVn(p.name_with_type),
      stripVn(p.slug.replace(/-/g, ' '))
    ].filter(Boolean)

    for (const c of candidates) {
      if (!c || c.length < 2) continue
      // c.includes(haystack): text khách gõ NGẮN HƠN tên tỉnh -> chỉ an toàn
      // khi haystack đủ dài, tránh 1 tên NGẮN, KHÔNG ĐỔI tự nó (vd "Vinh" -
      // TP Vinh, Nghệ An, không sáp nhập) bị coi là tiền tố mập mờ khớp NHẦM
      // vào tên tỉnh khác dài hơn chứa nó (vd "Vĩnh Long" chứa "vinh" như 1
      // tiền tố, dù không liên quan).
      const isMatch =
        haystack.includes(c) || (haystack.length >= 5 && c.includes(haystack))
      if (isMatch) {
        const score = Math.min(c.length, haystack.length)
        if (!best || score > best.score) {
          best = { code, name: p.name, score }
        }
      }
    }
  }

  if (best) return { code: best.code, name: best.name }

  // Aliases hay gặp
  if (
    haystack.includes('ho chi minh') ||
    haystack.includes('tphcm') ||
    haystack.includes('tp hcm') ||
    haystack.includes('hcm') ||
    haystack.includes('sg') ||
    haystack.includes('sai gon')
  ) {
    return { code: '79', name: PROVINCE_MAP['79']?.name ?? 'Hồ Chí Minh' }
  }
  if (haystack.includes('ha noi') || haystack.includes('hn ')) {
    return { code: '01', name: PROVINCE_MAP['01']?.name ?? 'Hà Nội' }
  }
  if (haystack.includes('da nang') || haystack.includes('dn ')) {
    return { code: '48', name: PROVINCE_MAP['48']?.name ?? 'Đà Nẵng' }
  }

  return { code: null, name: null }
}

type WardEntry = {
  name: string
  type: string
  slug: string
  name_with_type: string
  path: string
  path_with_type: string
  code: string
  parent_code: string
}
const WARD_MAP = wardJson as Record<string, WardEntry>

/**
 * Lấy mã tỉnh/TP (parent_code) từ mã ward. Dùng khi cần fallback ward → toàn tỉnh.
 * Vd getWardParentCode('10525') → '31' (Hải Phòng).
 */
export function getWardParentCode(wardCode: string): string | null {
  const w = WARD_MAP[wardCode]
  return w?.parent_code ?? null
}

/**
 * Lấy đầy đủ thông tin ward (tên + path tỉnh hiện hành) từ mã ward.
 * Dùng khi khách CHỌN 1 ward cụ thể (vd click QR) — tránh phải giữ lại tên
 * tỉnh cũ khách gõ trước đó, vốn có thể sai sau sáp nhập địa giới
 * (vd '04252' → path "Yên Bái, Lào Cai" dù khách gõ "Yên Bái").
 */
export function getWardByCode(code: string): WardMatch | null {
  const w = WARD_MAP[code]
  if (!w) return null
  return {
    code,
    name: w.name_with_type,
    path: w.path,
    path_with_type: w.path_with_type,
    parent_code: w.parent_code
  }
}

/**
 * V3 fallback: tìm các ward (xã/phường) match với text khách nhập.
 * Dùng khi province.json không khớp (vd "Thái Bình" sau khi reorg địa giới).
 *
 * Match strategy: text khách (đã chuẩn hoá không dấu) chứa trong `name`, `path`
 * hoặc `slug` của ward. Trả về danh sách match (≤ limit).
 */
export function findWardsByText(text: string, limit = 13): WardMatch[] {
  const needle = stripVn(text)
  if (!needle || needle.length < 2) return []

  const matches: WardMatch[] = []
  const seen = new Set<string>()
  for (const [code, w] of Object.entries(WARD_MAP)) {
    if (matches.length >= limit) break
    if (seen.has(code)) continue
    const haystacks = [
      stripVn(w.name),
      stripVn(w.path),
      stripVn(w.slug.replace(/-/g, ' '))
    ]
    let hit = false
    for (const h of haystacks) {
      if (h && h.includes(needle)) {
        hit = true
        break
      }
    }
    if (hit) {
      seen.add(code)
      matches.push({
        code,
        name: w.name_with_type,
        path: w.path,
        path_with_type: w.path_with_type,
        parent_code: w.parent_code
      })
    }
  }
  return matches
}

/**
 * Bản đồ tỉnh CŨ (đã sáp nhập 2025, không còn trong province.json) → ward đại
 * diện CÙNG TÊN trong tỉnh MỚI (thường là khu vực trung tâm/tỉnh lỵ cũ vẫn
 * giữ tên làm 1 phường/xã sau sáp nhập). Danh sách sáp nhập + wardCode đã
 * được verify khớp thực tế với ward.json (không suy đoán) — 9 tỉnh cũ KHÔNG
 * có ward trùng tên (wardCode null), khi đó chỉ resolve về tỉnh mới.
 */
const MERGED_PROVINCE_ALIASES: Record<
  string,
  {
    provinceCode: string
    provinceName: string
    wardCode: string | null
    wardName: string | null
    path: string | null
  }
> = {
  'thai binh': { provinceCode: '33', provinceName: 'Hưng Yên', wardCode: '13225', wardName: 'Phường Thái Bình', path: 'Thái Bình, Hưng Yên' },
  'hai duong': { provinceCode: '31', provinceName: 'Hải Phòng', wardCode: '10525', wardName: 'Phường Hải Dương', path: 'Hải Dương, Hải Phòng' },
  'bac giang': { provinceCode: '24', provinceName: 'Bắc Ninh', wardCode: '07210', wardName: 'Phường Bắc Giang', path: 'Bắc Giang, Bắc Ninh' },
  'vinh phuc': { provinceCode: '25', provinceName: 'Phú Thọ', wardCode: '08716', wardName: 'Phường Vĩnh Phúc', path: 'Vĩnh Phúc, Phú Thọ' },
  'hoa binh': { provinceCode: '25', provinceName: 'Phú Thọ', wardCode: '04795', wardName: 'Phường Hòa Bình', path: 'Hòa Bình, Phú Thọ' },
  'yen bai': { provinceCode: '15', provinceName: 'Lào Cai', wardCode: '04252', wardName: 'Phường Yên Bái', path: 'Yên Bái, Lào Cai' },
  'ha giang': { provinceCode: '08', provinceName: 'Tuyên Quang', wardCode: null, wardName: null, path: null },
  'bac kan': { provinceCode: '19', provinceName: 'Thái Nguyên', wardCode: '01843', wardName: 'Phường Bắc Kạn', path: 'Bắc Kạn, Thái Nguyên' },
  'ha nam': { provinceCode: '37', provinceName: 'Ninh Bình', wardCode: '13366', wardName: 'Phường Hà Nam', path: 'Hà Nam, Ninh Bình' },
  'nam dinh': { provinceCode: '37', provinceName: 'Ninh Bình', wardCode: '13669', wardName: 'Phường Nam Định', path: 'Nam Định, Ninh Bình' },
  'quang binh': { provinceCode: '44', provinceName: 'Quảng Trị', wardCode: null, wardName: null, path: null },
  'quang nam': { provinceCode: '48', provinceName: 'Đà Nẵng', wardCode: null, wardName: null, path: null },
  'kon tum': { provinceCode: '51', provinceName: 'Quảng Ngãi', wardCode: '23293', wardName: 'Phường Kon Tum', path: 'Kon Tum, Quảng Ngãi' },
  'binh dinh': { provinceCode: '52', provinceName: 'Gia Lai', wardCode: '21907', wardName: 'Phường Bình Định', path: 'Bình Định, Gia Lai' },
  'phu yen': { provinceCode: '66', provinceName: 'Đắk Lắk', wardCode: '22240', wardName: 'Phường Phú Yên', path: 'Phú Yên, Đắk Lắk' },
  'ninh thuan': { provinceCode: '56', provinceName: 'Khánh Hòa', wardCode: null, wardName: null, path: null },
  'dak nong': { provinceCode: '68', provinceName: 'Lâm Đồng', wardCode: null, wardName: null, path: null },
  'binh thuan': { provinceCode: '68', provinceName: 'Lâm Đồng', wardCode: '22960', wardName: 'Phường Bình Thuận', path: 'Bình Thuận, Lâm Đồng' },
  'binh phuoc': { provinceCode: '75', provinceName: 'Đồng Nai', wardCode: '25195', wardName: 'Phường Bình Phước', path: 'Bình Phước, Đồng Nai' },
  'binh duong': { provinceCode: '79', provinceName: 'Hồ Chí Minh', wardCode: '25760', wardName: 'Phường Bình Dương', path: 'Bình Dương, Hồ Chí Minh' },
  'ba ria vung tau': { provinceCode: '79', provinceName: 'Hồ Chí Minh', wardCode: null, wardName: null, path: null },
  'long an': { provinceCode: '80', provinceName: 'Tây Ninh', wardCode: '27694', wardName: 'Phường Long An', path: 'Long An, Tây Ninh' },
  'tien giang': { provinceCode: '82', provinceName: 'Đồng Tháp', wardCode: null, wardName: null, path: null },
  'ben tre': { provinceCode: '86', provinceName: 'Vĩnh Long', wardCode: '28789', wardName: 'Phường Bến Tre', path: 'Bến Tre, Vĩnh Long' },
  'tra vinh': { provinceCode: '86', provinceName: 'Vĩnh Long', wardCode: '29242', wardName: 'Phường Trà Vinh', path: 'Trà Vinh, Vĩnh Long' },
  'soc trang': { provinceCode: '92', provinceName: 'Cần Thơ', wardCode: '31507', wardName: 'Phường Sóc Trăng', path: 'Sóc Trăng, Cần Thơ' },
  'hau giang': { provinceCode: '92', provinceName: 'Cần Thơ', wardCode: null, wardName: null, path: null },
  'bac lieu': { provinceCode: '96', provinceName: 'Cà Mau', wardCode: '31825', wardName: 'Phường Bạc Liêu', path: 'Bạc Liêu, Cà Mau' },
  'kien giang': { provinceCode: '91', provinceName: 'An Giang', wardCode: null, wardName: null, path: null },

  // ── Tên THÀNH PHỐ/THỊ XÃ cũ (không phải tên tỉnh) ─────────────────────────
  // Khác nhóm trên: đây là tên tỉnh lỵ/thành phố cũ NẰM TRONG 1 tỉnh cũ (có
  // thể tỉnh đó đã đổi tên hoặc giữ nguyên) - khách hay chỉ gõ tên thành phố,
  // KHÔNG kèm tên tỉnh (vd "Vĩnh Yên" thay vì "Vĩnh Phúc"). Loại tên này KHÔNG
  // khớp được `resolveProvinceSync` (không phải 1 trong 34 tỉnh hiện hành) và
  // cũng KHÔNG khớp nhóm alias tên-tỉnh phía trên -> từng bị rơi xuống AI
  // `resolveAddress`, AI đoán liều theo âm gần giống 1 tỉnh HIỆN HÀNH bất kỳ
  // (vd "Vĩnh Yên" bị đoán nhầm thành "Vĩnh Long" - chỉ vì cùng bắt đầu bằng
  // "Vĩnh", trong khi Vĩnh Yên thực chất thuộc Phú Thọ). Toàn bộ danh sách +
  // wardCode dưới đây verify trực tiếp với ward.json (không suy đoán) từ bảng
  // tra cứu tỉnh/thành cũ người dùng cung cấp (xem old_data.txt).
  'long xuyen': { provinceCode: '91', provinceName: 'An Giang', wardCode: '30307', wardName: 'Phường Long Xuyên', path: 'Long Xuyên, An Giang' },
  'chau doc': { provinceCode: '91', provinceName: 'An Giang', wardCode: '30316', wardName: 'Phường Châu Đốc', path: 'Châu Đốc, An Giang' },
  // Đã có key gộp 'ba ria vung tau' phía trên, nhưng chỉ khớp khi text KHÔNG
  // có tiền tố khác (vd "Tp Vũng Tàu" KHÔNG match "ba ria vung tau" theo cả 2
  // chiều includes) -> thêm riêng 2 key này để chắc chắn khớp mọi cách gõ.
  'vung tau': { provinceCode: '79', provinceName: 'Hồ Chí Minh', wardCode: '26506', wardName: 'Phường Vũng Tàu', path: 'Vũng Tàu, Hồ Chí Minh' },
  'ba ria': { provinceCode: '79', provinceName: 'Hồ Chí Minh', wardCode: '26560', wardName: 'Phường Bà Rịa', path: 'Bà Rịa, Hồ Chí Minh' },
  'tu son': { provinceCode: '24', provinceName: 'Bắc Ninh', wardCode: '09367', wardName: 'Phường Từ Sơn', path: 'Từ Sơn, Bắc Ninh' },
  'quy nhon': { provinceCode: '52', provinceName: 'Gia Lai', wardCode: '21583', wardName: 'Phường Quy Nhơn', path: 'Quy Nhơn, Gia Lai' },
  'thu dau mot': { provinceCode: '79', provinceName: 'Hồ Chí Minh', wardCode: '25747', wardName: 'Phường Thủ Dầu Một', path: 'Thủ Dầu Một, Hồ Chí Minh' },
  'di an': { provinceCode: '79', provinceName: 'Hồ Chí Minh', wardCode: '25942', wardName: 'Phường Dĩ An', path: 'Dĩ An, Hồ Chí Minh' },
  'thuan an': { provinceCode: '79', provinceName: 'Hồ Chí Minh', wardCode: '25978', wardName: 'Phường Thuận An', path: 'Thuận An, Hồ Chí Minh' },
  'tan uyen': { provinceCode: '79', provinceName: 'Hồ Chí Minh', wardCode: '25888', wardName: 'Phường Tân Uyên', path: 'Tân Uyên, Hồ Chí Minh' },
  'dong xoai': { provinceCode: '75', provinceName: 'Đồng Nai', wardCode: '25210', wardName: 'Phường Đồng Xoài', path: 'Đồng Xoài, Đồng Nai' },
  'phan thiet': { provinceCode: '68', provinceName: 'Lâm Đồng', wardCode: '22945', wardName: 'Phường Phan Thiết', path: 'Phan Thiết, Lâm Đồng' },
  'buon ma thuot': { provinceCode: '66', provinceName: 'Đắk Lắk', wardCode: '24133', wardName: 'Phường Buôn Ma Thuột', path: 'Buôn Ma Thuột, Đắk Lắk' },
  'gia nghia': { provinceCode: '68', provinceName: 'Lâm Đồng', wardCode: null, wardName: null, path: null },
  'bien hoa': { provinceCode: '75', provinceName: 'Đồng Nai', wardCode: '26068', wardName: 'Phường Biên Hòa', path: 'Biên Hòa, Đồng Nai' },
  'long khanh': { provinceCode: '75', provinceName: 'Đồng Nai', wardCode: '26080', wardName: 'Phường Long Khánh', path: 'Long Khánh, Đồng Nai' },
  'cao lanh': { provinceCode: '82', provinceName: 'Đồng Tháp', wardCode: '29869', wardName: 'Phường Cao Lãnh', path: 'Cao Lãnh, Đồng Tháp' },
  'sa dec': { provinceCode: '82', provinceName: 'Đồng Tháp', wardCode: '29905', wardName: 'Phường Sa Đéc', path: 'Sa Đéc, Đồng Tháp' },
  'hong ngu': { provinceCode: '82', provinceName: 'Đồng Tháp', wardCode: '29955', wardName: 'Phường Hồng Ngự', path: 'Hồng Ngự, Đồng Tháp' },
  'pleiku': { provinceCode: '52', provinceName: 'Gia Lai', wardCode: '23575', wardName: 'Phường Pleiku', path: 'Pleiku, Gia Lai' },
  'phu ly': { provinceCode: '37', provinceName: 'Ninh Bình', wardCode: '13285', wardName: 'Phường Phủ Lý', path: 'Phủ Lý, Ninh Bình' },
  'chi linh': { provinceCode: '31', provinceName: 'Hải Phòng', wardCode: '10546', wardName: 'Phường Chí Linh', path: 'Chí Linh, Hải Phòng' },
  'vi thanh': { provinceCode: '92', provinceName: 'Cần Thơ', wardCode: '31321', wardName: 'Phường Vị Thanh', path: 'Vị Thanh, Cần Thơ' },
  'nga bay': { provinceCode: '92', provinceName: 'Cần Thơ', wardCode: '31340', wardName: 'Phường Ngã Bảy', path: 'Ngã Bảy, Cần Thơ' },
  'nha trang': { provinceCode: '56', provinceName: 'Khánh Hòa', wardCode: '22366', wardName: 'Phường Nha Trang', path: 'Nha Trang, Khánh Hòa' },
  'cam ranh': { provinceCode: '56', provinceName: 'Khánh Hòa', wardCode: '22420', wardName: 'Phường Cam Ranh', path: 'Cam Ranh, Khánh Hòa' },
  'rach gia': { provinceCode: '91', provinceName: 'An Giang', wardCode: '30742', wardName: 'Phường Rạch Giá', path: 'Rạch Giá, An Giang' },
  'ha tien': { provinceCode: '91', provinceName: 'An Giang', wardCode: '30769', wardName: 'Phường Hà Tiên', path: 'Hà Tiên, An Giang' },
  'phu quoc': { provinceCode: '91', provinceName: 'An Giang', wardCode: null, wardName: null, path: null },
  'da lat': { provinceCode: '68', provinceName: 'Lâm Đồng', wardCode: null, wardName: null, path: null },
  'bao loc': { provinceCode: '68', provinceName: 'Lâm Đồng', wardCode: null, wardName: null, path: null },
  'tan an': { provinceCode: '80', provinceName: 'Tây Ninh', wardCode: '27712', wardName: 'Phường Tân An', path: 'Tân An, Tây Ninh' },
  'tam diep': { provinceCode: '37', provinceName: 'Ninh Bình', wardCode: '14362', wardName: 'Phường Tam Điệp', path: 'Tam Điệp, Ninh Bình' },
  'phan rang thap cham': { provinceCode: '56', provinceName: 'Khánh Hòa', wardCode: null, wardName: null, path: null },
  'viet tri': { provinceCode: '25', provinceName: 'Phú Thọ', wardCode: '07900', wardName: 'Phường Việt Trì', path: 'Việt Trì, Phú Thọ' },
  'tuy hoa': { provinceCode: '66', provinceName: 'Đắk Lắk', wardCode: '22015', wardName: 'Phường Tuy Hòa', path: 'Tuy Hòa, Đắk Lắk' },
  'dong hoi': { provinceCode: '44', provinceName: 'Quảng Trị', wardCode: '18880', wardName: 'Phường Đồng Hới', path: 'Đồng Hới, Quảng Trị' },
  'tam ky': { provinceCode: '48', provinceName: 'Đà Nẵng', wardCode: '20341', wardName: 'Phường Tam Kỳ', path: 'Tam Kỳ, Đà Nẵng' },
  'hoi an': { provinceCode: '48', provinceName: 'Đà Nẵng', wardCode: '20410', wardName: 'Phường Hội An', path: 'Hội An, Đà Nẵng' },
  'ha long': { provinceCode: '22', provinceName: 'Quảng Ninh', wardCode: '06688', wardName: 'Phường Hạ Long', path: 'Hạ Long, Quảng Ninh' },
  'mong cai': { provinceCode: '22', provinceName: 'Quảng Ninh', wardCode: null, wardName: null, path: null },
  'cam pha': { provinceCode: '22', provinceName: 'Quảng Ninh', wardCode: '06793', wardName: 'Phường Cẩm Phả', path: 'Cẩm Phả, Quảng Ninh' },
  'uong bi': { provinceCode: '22', provinceName: 'Quảng Ninh', wardCode: '06811', wardName: 'Phường Uông Bí', path: 'Uông Bí, Quảng Ninh' },
  'dong ha': { provinceCode: '44', provinceName: 'Quảng Trị', wardCode: '19333', wardName: 'Phường Đông Hà', path: 'Đông Hà, Quảng Trị' },
  'song cong': { provinceCode: '19', provinceName: 'Thái Nguyên', wardCode: '05518', wardName: 'Phường Sông Công', path: 'Sông Công, Thái Nguyên' },
  'pho yen': { provinceCode: '19', provinceName: 'Thái Nguyên', wardCode: '05860', wardName: 'Phường Phổ Yên', path: 'Phổ Yên, Thái Nguyên' },
  'sam son': { provinceCode: '38', provinceName: 'Thanh Hóa', wardCode: '16531', wardName: 'Phường Sầm Sơn', path: 'Sầm Sơn, Thanh Hóa' },
  'my tho': { provinceCode: '82', provinceName: 'Đồng Tháp', wardCode: '28261', wardName: 'Phường Mỹ Tho', path: 'Mỹ Tho, Đồng Tháp' },
  'go cong': { provinceCode: '82', provinceName: 'Đồng Tháp', wardCode: '28306', wardName: 'Phường Gò Công', path: 'Gò Công, Đồng Tháp' },
  'cai lay': { provinceCode: '82', provinceName: 'Đồng Tháp', wardCode: '28439', wardName: 'Phường Cai Lậy', path: 'Cai Lậy, Đồng Tháp' },
  'vinh yen': { provinceCode: '25', provinceName: 'Phú Thọ', wardCode: '08707', wardName: 'Phường Vĩnh Yên', path: 'Vĩnh Yên, Phú Thọ' },
  'phuc yen': { provinceCode: '25', provinceName: 'Phú Thọ', wardCode: '08740', wardName: 'Phường Phúc Yên', path: 'Phúc Yên, Phú Thọ' }
}

/**
 * Khớp text khách gõ với 1 tỉnh CŨ đã sáp nhập (vd "Thái Bình", "Thái Bình
 * cũ", "tỉnh Hải Dương") → trả thẳng ward/tỉnh MỚI tương ứng, bỏ qua hoàn
 * toàn bước resolveProvince + ward-fallback (tránh hỏi lại/AI đoán sai).
 * Trả `null` nếu text không khớp tỉnh cũ nào trong danh sách.
 */
export function resolveMergedProvinceAlias(text: string): {
  provinceCode: string
  provinceName: string
  wardCode: string | null
  wardName: string | null
  path: string | null
} | null {
  const cleaned = text.replace(/\(?\s*cũ\s*\)?/gi, ' ')
  const haystack = stripVn(cleaned)
  if (!haystack) return null

  let best: { key: string; score: number } | null = null
  for (const key of Object.keys(MERGED_PROVINCE_ALIASES)) {
    // haystack.includes(key): text khách gõ DÀI HƠN/chứa trọn key -> an toàn dù
    // key ngắn (khách gõ rõ ràng đủ, không mập mờ).
    // key.includes(haystack): text khách gõ NGẮN HƠN key (vd "Bà Rịa" khớp
    // "ba ria vung tau") -> CHỈ an toàn khi haystack đủ dài để không phải 1
    // tiền tố mập mờ của nhiều key khác nhau (vd "Vinh" (Nghệ An, không đổi)
    // ngắn hơn "vinh phuc"/"vinh yen" nên bị includes() coi là match SAI nếu
    // không chặn) - yêu cầu tối thiểu 5 ký tự cho chiều này.
    const isMatch =
      haystack.includes(key) || (haystack.length >= 5 && key.includes(haystack))
    if (isMatch) {
      const score = Math.min(key.length, haystack.length)
      if (!best || score > best.score) best = { key, score }
    }
  }
  return best ? MERGED_PROVINCE_ALIASES[best.key] : null
}

/**
 * Bóc mã tỉnh/TP từ free text user nhập (vd: "Hà Nội", "TPHCM", "Sài Gòn",
 * "Số 12 Cầu Giấy", "Hải Châu" ...) — kết hợp heuristic + AI.
 *
 * Flow:
 *  1. Heuristic match `province.json` (sync, free) — bắt các case rõ.
 *  2. Nếu fail → gọi AI `extractProvinceFromAddress()` để bóc tên tỉnh
 *     (vd: user chỉ nhập "Cầu Giấy" → AI trả "Hà Nội") → re-resolve heuristic.
 */
export async function resolveProvince(
  text: string
): Promise<ProvinceResolution> {
  const direct = resolveProvinceSync(text)
  if (direct.code) return direct

  try {
    const aiName = await extractProvinceFromAddress(text)
    if (aiName) {
      const aiResolved = resolveProvinceSync(aiName)
      if (aiResolved.code) return aiResolved
    }
  } catch (e) {
    console.error('[FB db] resolveProvince AI fallback error:', e)
  }

  return { code: null, name: null }
}

// ── Helpers (private) ─────────────────────────────────────────────────────────

type ProductadminRow = {
  id: string
  name: string
  BRAND: string | null
  SIZE: string | null
  slug: string
  code: string | null
  price: number | null
  lastprice: number | null
  promotional_price: number | null
  rating: number | null
  quantitysold: number | null
  main_image: string | null
}

type GarageJoined = {
  id: string
  name: string
  code: string | null
  hotline: string | null
  status: boolean | null
  rating: number | null
  count_rate: number | null
  slug: string | null
  information: unknown
  province_code: string | null
  ward_code: string | null
}

type ProductJoinedRow = {
  id: string
  product_id: string | null
  price: number | null
  lastprice: number | null
  promotional_price: number | null
  is_promotion: boolean | null
  quantitysold: number | null
  /** Supabase trả về array khi FK relation; với 1-1 FK thực tế chỉ có 1 phần tử */
  garage: GarageJoined | GarageJoined[] | null
}

/** Normalize 1-1 FK relation: lấy phần tử đầu nếu là array, ngược lại trả nguyên. */
function oneOf<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null
  if (Array.isArray(v)) return v[0] ?? null
  return v
}

/** Convert kích cỡ hiển thị '185/65R15' → DB tag key '185_65R15' */
function toSizeKey(displaySize: string): string {
  return displaySize.trim().toUpperCase().replace(/\//g, '_')
}

/** Convert DB tag key '185_65R15' → hiển thị '185/65R15' */
function fromSizeKey(dbSize: string | null | undefined): string {
  if (!dbSize) return ''
  return dbSize.trim().toUpperCase().replace(/_/g, '/')
}

function parseBrandFilter(raw: string): string[] {
  if (!raw || raw === '__skip_brand__' || raw === '__ANY__') return []
  return raw
    .split('|')
    .map(b => b.trim().toUpperCase())
    .filter(Boolean)
}

/** Build full URL từ `main_image` field (filename or path) */
function buildImageUrl(
  mainImage: string | null | undefined
): string | undefined {
  if (!mainImage) return undefined
  const path = mainImage.replace(/[​-‍﻿]/g, '').trim()
  if (!path) return undefined
  // Đã là URL đầy đủ
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  return `${IMAGE_BASE_URL}/${path}`
}

function num(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

function mapProductadminToCatalogItem(pa: ProductadminRow): TireCatalogItem {
  const list = num(pa.price)
  const last = num(pa.lastprice)
  const promo = num(pa.promotional_price)
  // Giá hiển thị: ưu tiên promo nếu có và < list, sau đó lastprice nếu < list
  const hasPromo = promo > 0 && promo < list
  const finalPrice = hasPromo ? promo : last > 0 && last < list ? last : list

  return {
    id: pa.id,
    name: pa.name,
    brand: (pa.BRAND || '—').trim(),
    size: fromSizeKey(pa.SIZE),
    price: list > 0 ? list : finalPrice,
    promotional_price:
      finalPrice < list && finalPrice > 0 ? finalPrice : undefined,
    rating: pa.rating != null ? Number(pa.rating) : undefined,
    quantitysold: pa.quantitysold ?? null,
    slug: pa.slug,
    code: pa.code,
    image: buildImageUrl(pa.main_image)
  }
}

/**
 * Extract khu vực hiển thị từ garage.information (JSONB) — CHỈ convert ward/
 * province code sang tên, KHÔNG dùng field `address` (street) thô vì nó
 * thường đã tự chứa cả ward/district/province → ghép thêm province riêng
 * sẽ bị trùng lặp dài dòng (vd "126A15-16 Tam Trinh, Yên Sở, Hoàng Mai,
 * Hà Nội, Hoàng Mai, Hà Nội").
 *
 * Schema thực tế: `{"ward": "00331", "address": "...", "district": "",
 * "province": "01"}` — `ward` tra qua ward.json cho path "Phường, Tỉnh/TP"
 * đã chuẩn (vd "00331" → "Hoàng Mai, Hà Nội"); fallback tên tỉnh nếu
 * ward không có/không tra được.
 */
function extractAddressFromGarage(info: unknown): string {
  if (!info || typeof info !== 'object') return ''
  const i = info as Record<string, unknown>

  const ward = i.ward
  if (typeof ward === 'string' && ward.trim()) {
    const w = getWardByCode(ward.trim())
    if (w?.path) return w.path
  }

  const prov = i.province
  if (typeof prov === 'string' && prov.trim()) {
    const entry = PROVINCE_MAP[prov.trim()]
    if (entry?.name) return entry.name
    if (prov.length > 2) return prov // đã là tên, không phải code
  }

  return ''
}

function buildGarageOffer(
  row: ProductJoinedRow,
  g: GarageJoined,
  productSlug?: string | null
): GarageOffer | null {
  const list = num(row.price)
  const last = num(row.lastprice)
  const promo = num(row.promotional_price)
  const hasPromotion =
    row.is_promotion === true ||
    (promo > 0 && promo < list) ||
    (last > 0 && last < list)
  const finalPrice =
    promo > 0 && promo < list ? promo : last > 0 && last < list ? last : list

  if (finalPrice <= 0) return null

  // detailUrl: ưu tiên trang sản phẩm CỦA GARA: /lop/{productSlug}?code-gara={garage.code}
  // → user click thẳng vào sản phẩm tại gara đó. Fallback /garage/{code} nếu thiếu dữ liệu.
  let detailUrl = `${TROLYOTO_URL}/garage`
  if (productSlug && g.code) {
    detailUrl = `${TROLYOTO_URL}/lop/${productSlug}?code-gara=${g.code}`
  } else if (g.code) {
    detailUrl = `${TROLYOTO_URL}/garage/${g.code}`
  } else if (g.slug) {
    detailUrl = `${TROLYOTO_URL}/garage/${g.slug}`
  }

  return {
    garageName: g.name,
    garageCode: g.code,
    hotline: g.hotline ?? '',
    address: extractAddressFromGarage(g.information),
    garageRating: g.rating != null ? Number(g.rating) : null,
    garageCountRate: g.count_rate != null ? Number(g.count_rate) : null,
    lastprice: list,
    finalPrice,
    hasPromotion,
    detailUrl,
    garageSold: row.quantitysold != null ? Number(row.quantitysold) : null
  }
}

function stripVn(s: string): string {
  return s
    .toLowerCase()
    .replace(/đ/g, 'd') // "Đ" không có canonical decomposition trong NFD (không
    // giống các nguyên âm có dấu) -> normalize('NFD') KHÔNG tách được nó, phải
    // thay tay trước, nếu không catch-all bên dưới sẽ XOÁ HẲN chữ "đ" (không
    // phải chuyển thành "d") -> "Đốc" thành "oc" thay vì "doc", gây sai lệch
    // toàn bộ các so khớp chứa chữ đầu "Đ" (vd "Nam Định", "Bình Định", "Đắk
    // Nông", "Châu Đốc"...).
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
