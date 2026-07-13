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

  // 1. Lấy danh sách SP theo size+brand (rộng để có đủ gara map qua)
  const { items, productadminIds } = await fetchTireCatalog({
    tireSize,
    tireBrand,
    skip: 0,
    limit: 10
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
      if (haystack.includes(c) || c.includes(haystack)) {
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
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
