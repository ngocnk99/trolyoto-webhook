import { openai } from '@ai-sdk/openai'
import { generateObject } from 'ai'
import { z } from 'zod'

// Model rẻ + đủ cho classification/extraction. Đổi sang gpt-4o nếu cần độ chính xác cao hơn.
const MODEL = 'gpt-4o-mini'

/**
 * Trích kích cỡ lốp (định dạng `XXX/YYRZZ`) từ free text của user.
 * Dùng khi user gõ "lốp tôi 185 60 r 15" / "kích cỡ 185/65 r15" / "lốp 205 55 17" — regex thông thường không bắt được.
 * @returns kích cỡ chuẩn hoá UPPERCASE, hoặc `null` nếu AI không nhận dạng được.
 */
export async function extractTireSize(
  userInput: string
): Promise<string | null> {
  try {
    const { object } = await generateObject({
      model: openai(MODEL) as any,
      schema: z.object({
        tireSize: z
          .string()
          .nullable()
          .describe(
            'Tire size in format like 185/65R15. Null if user input is NOT about tire size.'
          )
      }),
      system:
        'You extract Vietnamese tire size from user text. Output ONLY in format like 185/65R15 (width/aspect ratio + R + rim diameter). Return null if not present.',
      prompt: `User said: "${userInput}"\nExtract tire size. Return null if no tire size mentioned.`
    })
    if (!object.tireSize) return null
    const m = object.tireSize.match(/(\d{3})\s*\/\s*(\d{2})\s*R\s*(\d{2})/i)
    return m ? `${m[1]}/${m[2]}R${m[3]}`.toUpperCase() : null
  } catch (e) {
    console.error('[AI extractTireSize]', e)
    return null
  }
}

/**
 * Lấy 2-4 kích cỡ lốp OEM phù hợp cho dòng xe (toàn cầu, không giới hạn VN).
 *
 * Thứ tự ƯU TIÊN:
 *   1. Kích thước **nguyên bản theo hãng** (original manufacturer's spec / factory OEM) — luôn đứng đầu
 *   2. Sau đó là size của các phiên bản/trim khác (alternative trim sizes)
 *
 * Thay thế mapping `CAR_TIRE_SIZES` cứng — cho phép mở rộng sang mọi dòng xe trên thị trường thế giới.
 */
export async function getTireSizesForCar(carModel: string): Promise<string[]> {
  try {
    const { object } = await generateObject({
      model: openai(MODEL) as any,
      schema: z.object({
        sizes: z
          .array(z.string())
          .min(0)
          .max(4)
          .describe(
            'Tire sizes XXX/YYRZZ. FIRST element MUST be the original/factory size per manufacturer spec. Following elements are alternative trim sizes ordered by popularity.'
          )
      }),
      system:
        "You are a global automotive tire specialist. Return OEM tire sizes for any car model worldwide. CRITICAL: The very first size returned MUST be the **original equipment manufacturer (OEM) factory spec / stock size from the manufacturer's official specifications** — not an aftermarket or up-sized option. Subsequent sizes are alternatives from other trims, ordered by popularity.",
      prompt: `Car model entered by user: "${carModel}"\n\nReturn 2 to 4 OEM tire sizes (format XXX/YYRZZ):\n1. FIRST size: the ORIGINAL factory spec per manufacturer (e.g., from the door jamb sticker / owner's manual base trim). This is the most authoritative.\n2. SUBSEQUENT sizes: alternative sizes used in other trims/optional packages, ordered by popularity.\n3. Prefer 3-4 sizes when the model has multiple trims.\n4. If you don't recognize the car at all, return an empty array.`
    })
    return object.sizes
      .map(s => {
        const m = s.match(/(\d{3})\s*\/\s*(\d{2})\s*R\s*(\d{2})/i)
        return m ? `${m[1]}/${m[2]}R${m[3]}`.toUpperCase() : null
      })
      .filter((s): s is string => !!s)
  } catch (e) {
    console.error('[AI getTireSizesForCar]', e)
    return []
  }
}

/**
 * Chuẩn hoá `s` về format tag DB: lowercase + bỏ dấu + collapse khoảng trắng.
 * VD: "VinFast 3" → "vinfast 3", "Đà Nẵng" → "da nang".
 */
function normalizeTag(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface CarNameVariants {
  /** Tên chính thức + viết tắt phổ biến (≥90% chắc chắn cùng 1 model) */
  exact: string[]
  /** Tên gọi khác kém chính xác (<90%) — dùng làm fallback nếu exact không match DB */
  loose: string[]
}

/**
 * Cho free text user nhập tên xe, AI trả về 2 nhóm variant đã chuẩn hoá
 * (lowercase, không dấu) để query `tag.name` trong DB.
 *
 * VD:
 *   user "vf3"       → exact=["vinfast 3","vf3"], loose=["vinfast","vinfast 2024"]
 *   user "civic"     → exact=["honda civic","civic"], loose=["honda"]
 *   user "xe ko biết" → exact=[], loose=[]
 */
export async function getCarNameVariants(
  carName: string
): Promise<CarNameVariants> {
  if (!carName || carName.trim().length < 2) {
    return { exact: [], loose: [] }
  }
  try {
    const { object } = await generateObject({
      model: openai(MODEL) as any,
      schema: z.object({
        exact: z
          .array(z.string())
          .describe(
            'Official full name + common abbreviations referring to the SAME model (≥90% sure). Always lowercase, no diacritics.'
          ),
        loose: z
          .array(z.string())
          .describe(
            'Less precise related names (<90% sure — eg. brand alone, year-specific). Always lowercase, no diacritics.'
          )
      }),
      system:
        'You normalize Vietnamese car model names entered by users into canonical variants used as DB tags. Output strings must be lowercase + diacritic-free (vd "vinfast 3", "vf3", "honda crv").',
      prompt: `User entered car name: "${carName}"\n\nReturn 2 lists of normalized variants (lowercase, no diacritics):\n1. exact[]: the official full name + common abbreviations referring to the SAME model. ≥90% confidence. VD user "vf3" → exact=["vinfast 3","vf3"].\n2. loose[]: less precise related names (brand only, year-suffixed, common typos). <90% confidence. VD ["vinfast","vinfast 2024"].\n\nIf you don't recognize the car at all, return empty arrays.`
    })
    return {
      exact: object.exact.map(normalizeTag).filter(Boolean),
      loose: object.loose.map(normalizeTag).filter(Boolean)
    }
  } catch (e) {
    console.error('[AI getCarNameVariants]', e)
    return { exact: [], loose: [] }
  }
}

/**
 * Verify danh sách `candidateSizes` lấy từ DB (qua loose tag) có thực sự phù hợp với xe `carName` không.
 *
 * @returns
 *  - `compatibleSizes`: subset của candidates mà AI cho là phù hợp (factory hoặc trim khác).
 *    Empty = không có size nào phù hợp → caller fallback `getTireSizesForCar()` (AI tự gợi ý).
 */
export async function verifyTireSizesForCar(
  carName: string,
  candidateSizes: string[]
): Promise<{ compatibleSizes: string[] }> {
  if (!candidateSizes.length) return { compatibleSizes: [] }
  try {
    const { object } = await generateObject({
      model: openai(MODEL) as any,
      schema: z.object({
        compatible_sizes: z
          .array(z.string())
          .describe(
            'Subset of input sizes that physically fit this car (factory OEM or commonly-accepted alternative trims). Format XXX/YYRZZ.'
          )
      }),
      system:
        'You are a global automotive tire specialist. Given a car model name and candidate tire sizes, return the SUBSET that is mechanically compatible with that car (factory OEM or trim-alternative). Reject sizes that clearly do not fit.',
      prompt: `Car: "${carName}"\nCandidate tire sizes: ${candidateSizes.join(', ')}\n\nReturn the SUBSET that fits this car. If none fit, return empty array.`
    })
    // Normalize back to XXX/YYRZZ format
    const compatibleSizes = object.compatible_sizes
      .map(s => {
        const m = s.match(/(\d{3})\s*\/\s*(\d{2})\s*R\s*(\d{2})/i)
        return m ? `${m[1]}/${m[2]}R${m[3]}`.toUpperCase() : null
      })
      .filter((s): s is string => !!s)
    return { compatibleSizes }
  } catch (e) {
    console.error('[AI verifyTireSizesForCar]', e)
    return { compatibleSizes: [] }
  }
}

/**
 * Bóc TÊN tỉnh/thành phố (theo cách viết chuẩn tiếng Việt) từ free text địa chỉ.
 * Dùng khi heuristic match `province.json` trong db.ts không khớp (vd: user chỉ
 * nhập quận/huyện như "Cầu Giấy" hoặc viết sai chính tả "Hà Nọi").
 *
 * Caller sẽ feed kết quả lại vào `resolveProvinceSync()` để lookup mã province.
 *
 * @returns Tên tỉnh chuẩn (vd: "Hà Nội", "Hồ Chí Minh") hoặc `null` nếu AI cũng chịu.
 */
export async function extractProvinceFromAddress(
  userText: string
): Promise<string | null> {
  try {
    const { object } = await generateObject({
      model: openai(MODEL) as any,
      schema: z.object({
        province: z
          .string()
          .nullable()
          .describe(
            'Standard Vietnamese province/city name (vd: "Hà Nội", "Hồ Chí Minh", "Đà Nẵng"). Null if cannot infer.'
          ),
        confidence: z.number().min(0).max(1).describe('Confidence 0-1')
      }),
      system:
        'You parse Vietnamese addresses to extract the province/city (tỉnh/thành phố) name. Infer from district/ward if user only typed those. Return standard Vietnamese name with diacritics. Confidence must be ≥0.7 to be useful.',
      prompt: `User address text: "${userText}"\n\nExtract the Vietnamese province/city name. If only ward/district mentioned, infer the province. Return null if truly unclear.`
    })
    if (!object.province || object.confidence < 0.7) return null
    return object.province.trim()
  } catch (e) {
    console.error('[AI extractProvinceFromAddress]', e)
    return null
  }
}

// ── V2: AI là ĐƯỜNG CHÍNH để hiểu free-text ở 2 bước then chốt ──────────────

export interface TireInputClassification {
  /** 'size' = user nhập kích cỡ lốp; 'car' = user nhập tên xe; 'unknown' = không rõ */
  kind: 'size' | 'car' | 'unknown'
  /** Kích cỡ chuẩn hoá XXX/YYRZZ nếu kind='size' (đã sửa lỗi không dấu / khoảng trắng) */
  size: string | null
  /** Tên xe đã chuẩn hoá nếu kind='car' */
  carModel: string | null
  /** Độ tự tin 0-1. <0.7 → bot nên hiển thị gợi ý + "❌ Không đúng" thay vì đoán bừa */
  confidence: number
}

/**
 * V2 `xac_dinh_kich_co_lop`: phân loại free-text của khách là KÍCH CỠ hay TÊN XE.
 *
 * Xử lý các trường hợp khách nhắn tay không chuẩn: sai chính tả, viết không dấu,
 * viết tắt, thiếu format ("185 60 15", "lop vios", "mai bảy ba r 16"...).
 *
 * Bot quyết định nhánh:
 *  - kind='size' & confidence cao  → báo giá luôn
 *  - kind='car'                    → tra kích cỡ theo xe rồi cho khách xác nhận
 *  - kind='unknown' / confidence thấp → hiển thị gợi ý + "❌ Không đúng"
 */
export async function classifyTireInput(
  userInput: string
): Promise<TireInputClassification> {
  const fallback: TireInputClassification = {
    kind: 'unknown',
    size: null,
    carModel: null,
    confidence: 0
  }
  if (!userInput || userInput.trim().length < 1) return fallback
  try {
    const { object } = await generateObject({
      model: openai(MODEL) as any,
      schema: z.object({
        kind: z
          .enum(['size', 'car', 'unknown'])
          .describe(
            "'size' if user typed a tire size, 'car' if a car model name, 'unknown' if neither is clear."
          ),
        size: z
          .string()
          .nullable()
          .describe('Normalized tire size XXX/YYRZZ if kind=size, else null.'),
        carModel: z
          .string()
          .nullable()
          .describe('Normalized car model name if kind=car, else null.'),
        confidence: z.number().min(0).max(1).describe('Confidence 0-1.')
      }),
      system:
        'You classify Vietnamese tire-shop chat input. Decide if the user typed a TIRE SIZE or a CAR MODEL name. Be robust to typos, missing diacritics, abbreviations and loose spacing (e.g. "185 60 15" → size 185/60R15; "lop vios" → car "Toyota Vios"; "mai bay ba r16" → 235/...R16 only if clearly inferable). If you cannot tell with reasonable confidence, return kind="unknown".',
      prompt: `User typed: "${userInput}"\n\nReturn:\n- kind: "size" | "car" | "unknown"\n- size: tire size in XXX/YYRZZ if kind=size (fix spacing/typos), else null\n- carModel: normalized car model if kind=car, else null\n- confidence: 0-1 (how sure you are about kind + value)`
    })
    let size: string | null = null
    if (object.size) {
      const m = object.size.match(/(\d{3})\s*\/?\s*(\d{2})\s*R?\s*(\d{2})/i)
      size = m ? `${m[1]}/${m[2]}R${m[3]}`.toUpperCase() : null
    }
    return {
      kind: object.kind,
      size,
      carModel: object.carModel?.trim() || null,
      confidence: object.confidence
    }
  } catch (e) {
    console.error('[AI classifyTireInput]', e)
    return fallback
  }
}

export interface BrandNeed {
  /** Bot có hiểu rõ nhu cầu không. false → hiển thị fallback 3 tier */
  understood: boolean
  /** Các thương hiệu cụ thể khách nhắc tới (HOA, vd ["MICHELIN"]). Rỗng nếu không có */
  brands: string[]
  /** Phân khúc khách ngầm định nếu không nêu brand cụ thể */
  tier: 'premium' | 'balanced' | 'budget' | null
  /** true nếu khách muốn xem hết / không có tiêu chí cụ thể */
  seeAll: boolean
  /** Khoảng giá (đ) nếu khách nêu — hiện chỉ log, chưa lọc DB */
  priceMin: number | null
  priceMax: number | null
  confidence: number
}

/**
 * V2 `xac_dinh_thuong_hieu`: trích nhu cầu GIÁ/THƯƠNG HIỆU từ free-text của khách.
 *
 * Bao quát các case: 1 thương hiệu, nhiều thương hiệu, khoảng giá, tầm giá
 * (rẻ/trung/cao), "xem hết". Xử lý sai chính tả / không dấu.
 *
 * @param knownBrands danh sách brand hợp lệ trong hệ thống (để AI map chính xác).
 */
export async function extractBrandNeed(
  userInput: string,
  knownBrands: string[] = []
): Promise<BrandNeed> {
  const fallback: BrandNeed = {
    understood: false,
    brands: [],
    tier: null,
    seeAll: false,
    priceMin: null,
    priceMax: null,
    confidence: 0
  }
  if (!userInput || userInput.trim().length < 1) return fallback
  try {
    const { object } = await generateObject({
      model: openai(MODEL) as any,
      schema: z.object({
        understood: z
          .boolean()
          .describe('Whether the need is clear enough to act on.'),
        brands: z
          .array(z.string())
          .describe('Specific tire brands mentioned, UPPERCASE. Empty if none.'),
        tier: z
          .enum(['premium', 'balanced', 'budget'])
          .nullable()
          .describe(
            "Implied segment: 'premium'=cao cấp/bền/êm, 'balanced'=cân bằng giá-chất lượng, 'budget'=rẻ/tiết kiệm. Null if not implied."
          ),
        seeAll: z
          .boolean()
          .describe('True if user wants to see all / has no specific criteria.'),
        priceMin: z.number().nullable().describe('Min price VND if a range given.'),
        priceMax: z.number().nullable().describe('Max price VND if a range given.'),
        confidence: z.number().min(0).max(1)
      }),
      system:
        'You parse a Vietnamese tire-shopping need about PRICE or BRAND. Map to specific brands, an implied segment (premium/balanced/budget), a price range, or "see all". Be robust to typos/no-diacritics. Only set understood=true when you can act (a brand, a segment, a price range, or explicit see-all).',
      prompt: `User typed: "${userInput}"\n\nKnown brands in system: ${
        knownBrands.length ? knownBrands.join(', ') : '(unknown)'
      }\n\nReturn understood, brands[] (UPPERCASE, only ones that make sense), tier, seeAll, priceMin, priceMax, confidence.`
    })
    return {
      understood: object.understood && object.confidence >= 0.6,
      brands: object.brands.map(b => b.trim().toUpperCase()).filter(Boolean),
      tier: object.tier,
      seeAll: object.seeAll,
      priceMin: object.priceMin,
      priceMax: object.priceMax,
      confidence: object.confidence
    }
  } catch (e) {
    console.error('[AI extractBrandNeed]', e)
    return fallback
  }
}

// ── V3: Phân tích ảnh lốp xe (vision) ──────────────────────────────────────

export interface TireImageAnalysis {
  /** Kích cỡ XXX/YYRZZ trích từ thành lốp (vd "215/75R16"). Null nếu không đọc được. */
  tire_size: string | null
  /** Thương hiệu UPPERCASE (vd "MICHELIN"). Null nếu không đọc được. */
  brand: string | null
  /** Độ tin cậy 0-1 — ngưỡng ≥ 0.5 thì bot mới apply vào state */
  confidence: number
}

/**
 * Đọc ký hiệu trên thành lốp xe từ ảnh khách gửi.
 *
 * Phải TỰ TẢI ảnh về rồi pass bytes inline — OpenAI vision API không fetch được
 * trực tiếp URL FB CDN (status 400 "invalid_image_url" vì FB CDN block các UA lạ
 * hoặc URL có query signed). Tải qua fetch của Node thì OK.
 */
export async function analyzeTireImage(imageUrl: string): Promise<TireImageAnalysis> {
  try {
    // 1. Tải ảnh từ FB CDN
    const imgRes = await fetch(imageUrl, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    if (!imgRes.ok) {
      throw new Error(`Fetch FB image failed: ${imgRes.status} ${imgRes.statusText}`)
    }
    const buf = await imgRes.arrayBuffer()
    const bytes = new Uint8Array(buf)
    const contentType = imgRes.headers.get('content-type') ?? 'image/jpeg'
    console.log(`[AI analyzeTireImage] downloaded ${bytes.byteLength} bytes (${contentType})`)

    // 2. Gửi inline cho vision model. Model configurable qua env VISION_MODEL
    //    (default gpt-4o cho accuracy cao; gpt-4o-mini đọc nhầm 145↔175,
    //    225↔255 khi ảnh xoay/góc nghiêng).
    const visionModel = process.env.VISION_MODEL ?? 'gpt-4o'
    console.log(`[AI analyzeTireImage] using model=${visionModel}`)
    const { object } = await generateObject({
      model: openai(visionModel) as any,
      schema: z.object({
        tire_size: z
          .string()
          .nullable()
          .describe(
            'Tire size XXX/YYRZZ extracted from sidewall (vd "215/75R16"). Null if not 100% legible.'
          ),
        brand: z
          .string()
          .nullable()
          .describe(
            'Brand name UPPERCASE from sidewall (vd "MICHELIN", "BRIDGESTONE", "HANKOOK"). Null if not legible.'
          ),
        confidence: z.number().min(0).max(1).describe('Confidence 0-1.'),
        raw_text: z
          .string()
          .nullable()
          .describe('Chuỗi text bạn đọc được trên thành lốp, kể cả khi xoay/ngược — để debug khi sai.')
      }),
      messages: [
        {
          role: 'system',
          content: [
            'Bạn đọc thành lốp xe (tire sidewall).',
            '',
            'NHIỆM VỤ:',
            '1. Tìm chuỗi kích cỡ định dạng: <3 chữ số width> "/" <2 chữ số aspect> "R" <2 chữ số rim>',
            '   Ví dụ hợp lệ: "145/70R13", "175/65R14", "215/75R16", "265/65R17".',
            '   Có thể có hậu tố như "C", "T", "82H", "91V" — BỎ QUA, không đưa vào tire_size.',
            '',
            '2. Tìm tên hãng (brand) viết HOA trên lốp: MICHELIN, BRIDGESTONE, HANKOOK, DUNLOP, GOODYEAR, KUMHO, MAXXIS, YOKOHAMA, CONTINENTAL, FALKEN, PIRELLI, NEXEN, TOYO, ADVANCE...',
            '',
            'CHÚ Ý QUAN TRỌNG:',
            '- Ảnh CÓ THỂ BỊ XOAY HOẶC NGƯỢC (text upside-down). Đọc kỹ từng chữ số, không đoán.',
            '- Chữ số "1" và "7" rất giống nhau khi xoay → kiểm tra kỹ độ cao, độ thẳng.',
            '- Chữ số "5" và "6" cũng dễ nhầm khi ảnh mờ → phóng to mentally trước khi quyết định.',
            '- Nếu KHÔNG chắc chắn 100% cả 3 chỉ số (width, aspect, rim) → set tire_size=null và confidence<0.5.',
            '- Đừng đoán dựa trên kích cỡ phổ biến — chỉ đọc đúng những gì THỰC SỰ THẤY.',
            '',
            'OUTPUT:',
            '- tire_size: chuỗi đúng format "XXX/YYRZZ" (chỉ khi tự tin tuyệt đối)',
            '- brand: tên hãng HOA (chỉ khi đọc rõ)',
            '- confidence: 0-1, < 0.7 nếu có nghi ngờ',
            '- raw_text: chuỗi text bạn ĐỌC được trên thành lốp (kể cả không đúng format) — để dev debug khi bot sai'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Đọc kích cỡ + thương hiệu trên lốp này. Lưu ý ảnh có thể bị xoay hoặc ngược — đọc kỹ từng chữ số.'
            },
            { type: 'image', image: bytes, mimeType: contentType }
          ]
        }
      ]
    })

    // Normalize size: 215 75 R 16 → 215/75R16
    let normalizedSize: string | null = null
    if (object.tire_size) {
      const m = object.tire_size.match(/(\d{3})\s*\/?\s*(\d{2})\s*R?\s*(\d{2})/i)
      normalizedSize = m ? `${m[1]}/${m[2]}R${m[3]}`.toUpperCase() : null
    }
    const normalizedBrand = object.brand?.trim().toUpperCase() || null

    console.log(
      `[AI analyzeTireImage] tire_size=${normalizedSize} brand=${normalizedBrand} confidence=${object.confidence} raw_text="${object.raw_text ?? ''}"`
    )

    // Áp dụng ngưỡng confidence: nếu <0.7 → coi như đọc không rõ, trả null
    // để bot retry bằng cách hỏi nhập tay.
    if (object.confidence !== undefined && object.confidence < 0.7) {
      console.log(
        `[AI analyzeTireImage] confidence ${object.confidence} < 0.7 → reject tire_size, ask user nhập tay`
      )
      return {
        tire_size: null,
        brand: normalizedBrand,
        confidence: object.confidence
      }
    }

    return {
      tire_size: normalizedSize,
      brand: normalizedBrand,
      confidence: object.confidence
    }
  } catch (e: any) {
    console.error('[AI analyzeTireImage] FAILED', {
      message: e?.message,
      cause: e?.cause
    })
    return { tire_size: null, brand: null, confidence: 0 }
  }
}

// ── V3: AI conversational gather turn ──────────────────────────────────────

export type V3BrandTier = 'premium' | 'balanced' | 'budget' | 'all'

export interface V3GatherCollected {
  tire_size?: string
  brand_tier?: V3BrandTier | null
  selected_brands?: string[]
  province_name?: string
}

export interface V3GatherInput {
  collected: V3GatherCollected
  userInput: string
  /** Lịch sử hội thoại gần đây (tối đa 6 turn) để AI có ngữ cảnh */
  recentHistory?: Array<{ role: 'bot' | 'user'; text: string }>
}

export interface V3GatherUpdate {
  tire_size?: string | null
  brand_tier?: V3BrandTier | null
  selected_brands?: string[] | null
  province_name?: string | null
  /** Tên xe khách nêu (khi chưa có size chính xác). Bot orchestrator sẽ tra
   *  DB+AI để show list size cho khách chọn — KHÔNG hỏi size dạng text. */
  car_model?: string | null
}

export interface V3GatherDecision {
  /** Các trường cần update vào state. Null = ko đổi. */
  updates: V3GatherUpdate
  /** Tin nhắn bot sẽ gửi cho khách (tiếng Việt, tự nhiên, có emoji nhẹ) */
  reply: string
  /**
   *  continue       → còn thiếu info → hỏi tiếp
   *  fetch_results  → đã đủ 3 trường → bot ack + chuẩn bị fetch SP+gara
   *  handoff_cskh   → khách yêu cầu chuyên viên / khó chịu / out-of-scope
   */
  action: 'continue' | 'fetch_results' | 'handoff_cskh'
  cskh_reason?: string | null
  /** V3: true khi AI call thất bại → orchestrator nên kèm QR [Chat tư vấn viên] */
  error?: boolean
  /**
   * V3: true khi AI đang trả lời câu hỏi ngoài luồng (vd "có phải bot không",
   * "đặt online à", "địa chỉ bạn ở đâu"). Orchestrator KHÔNG tính fail counter
   * cho turn này — khách đang hỏi hợp lệ, không phải "không hiểu".
   */
  is_off_topic?: boolean
}

const V3_BRAND_TIER_INFO = {
  premium: 'Michelin, Bridgestone, Pirelli, Continental, Toyo, Goodyear',
  balanced: 'Hankook, Yokohama, Dunlop, Laufenn',
  budget: 'Kumho, RoadX, Sailun, TBB, Otani'
} as const

/**
 * V3: một vòng AI conversational để thu thập tire_size + brand + province.
 *
 * AI có toàn quyền sinh reply tự nhiên (tiếng Việt, polite, "TROLY"/"em" - "anh/chị").
 * Bot orchestrator chỉ relay reply + apply updates + thực thi action.
 *
 * KHÔNG cho AI sinh ra phần community CTA / wording cards — phần đó deterministic
 * trong code (giữ y nguyên V2). AI chỉ làm phần gathering.
 */
export async function v3GatherTurn(input: V3GatherInput): Promise<V3GatherDecision> {
  const collected = input.collected || {}
  const historyText = (input.recentHistory ?? [])
    .slice(-6)
    .map(t => `${t.role === 'bot' ? 'TROLY' : 'Khách'}: ${t.text}`)
    .join('\n')

  const collectedSummary = [
    `tire_size: ${collected.tire_size ?? '(missing)'}`,
    `brand_tier: ${collected.brand_tier ?? '(missing)'}`,
    `selected_brands: ${collected.selected_brands?.join(', ') || '(missing)'}`,
    `province_name: ${collected.province_name ?? '(missing)'}`
  ].join('\n')

  try {
    const { object } = await generateObject({
      model: openai(MODEL) as any,
      // FLAT schema + .nullish() cho field optional — tolerant với AI khi nó omit field.
      schema: z.object({
        tire_size: z
          .string()
          .nullish()
          .describe('Tire size XXX/YYRZZ (e.g. 185/65R15) nếu khách CHỐT. Null/omit nếu không có/không chắc.'),
        brand_tier: z
          .enum(['premium', 'balanced', 'budget', 'all'])
          .nullish()
          .describe(
            "Phân khúc: 'premium' (cao cấp/bền/êm), 'balanced' (cân bằng), 'budget' (rẻ/tiết kiệm), 'all' (xem hết). Null/omit nếu chưa rõ."
          ),
        selected_brands: z
          .array(z.string())
          .nullish()
          .describe('Brand cụ thể UPPERCASE khách nhắc (vd ["MICHELIN","BRIDGESTONE"]). Null/omit hoặc [] nếu chưa có.'),
        province_name: z
          .string()
          .nullish()
          .describe('Tên tỉnh/TP chuẩn tiếng Việt (vd "Hà Nội", "Hồ Chí Minh"). Null/omit nếu chưa có/chưa rõ.'),
        car_model: z
          .string()
          .nullish()
          .describe(
            'Tên xe khách nêu khi CHƯA có kích cỡ chính xác (vd "VinFast 3", "Toyota Vios", "Fortuner 2020"). Hệ thống sẽ tự tra ra list kích cỡ. Null/omit nếu không có tên xe hoặc đã có size.'
          ),
        reply: z
          .string()
          .describe(
            'Tin nhắn TROLY gửi khách, tiếng Việt tự nhiên, polite (xưng "em"/"TROLY", gọi "anh/chị"). 1-2 emoji 😊👍.'
          ),
        action: z
          .enum(['continue', 'fetch_results', 'handoff_cskh'])
          .describe(
            "continue=còn thiếu info, fetch_results=đủ 3 trường, handoff_cskh=khách yêu cầu chuyên viên/khó chịu/ngoài phạm vi"
          ),
        cskh_reason: z
          .string()
          .nullish()
          .describe('Lý do handoff (nếu action=handoff_cskh). Null/omit cho continue/fetch_results.'),
        is_off_topic: z
          .boolean()
          .nullish()
          .describe(
            'True khi bạn đang trả lời câu hỏi NGOÀI luồng gathering (vd "có phải bot không", "đặt online à", "địa chỉ bạn ở đâu", "TROLYoto là gì"). Khi true, orchestrator sẽ KHÔNG tính fail counter. False/omit cho các turn gathering thông thường.'
          )
      }),
      system: `Bạn là TROLY — trợ lý ô tô của TROLYoto (nền tảng mua lốp xe ở Việt Nam).
Nhiệm vụ: thu thập 3 thông tin để báo giá lốp:
1. tire_size (định dạng XXX/YYRZZ)
2. brand preference: brand cụ thể HOẶC phân khúc HOẶC xem hết
3. province (tỉnh/TP ở Việt Nam) — HỎI SAU CÙNG, sau khi đã có size + brand

Phân khúc thương hiệu:
- premium: ${V3_BRAND_TIER_INFO.premium}
- balanced: ${V3_BRAND_TIER_INFO.balanced}
- budget: ${V3_BRAND_TIER_INFO.budget}

PHONG CÁCH (BẮT BUỘC):
- Xưng "em" (chủ ngữ tự xưng cho hành động của bạn). Gọi khách "anh/chị". Kết "ạ".
- KHÔNG xưng "TROLY [verb]" cho hành động của bot. Vd SAI: "TROLY tra cứu...", "TROLY hỗ trợ...". ĐÚNG: "Em tra cứu...", "Em hỗ trợ...".
- "TROLY" và "TROLYoto" CHỈ dùng làm TÊN của nền tảng/brand (danh từ), KHÔNG làm đại từ tự xưng. Vd: "TROLYoto là nền tảng..." (giới thiệu), "Chuyên viên TROLYoto sẽ liên hệ..." (chỉ team). KHÔNG "TROLY đã nhận thông tin" → dùng "Em đã nhận thông tin".

TONE TÍCH CỰC (CỰC QUAN TRỌNG):
- TRÁNH câu phủ định/tiêu cực kiểu "em chưa hiểu", "em chưa rõ", "em chưa nhận dạng được", "em chưa biết". Thay bằng câu tích cực, hướng dẫn:
  * Thay "Em chưa hiểu thông tin ạ" → "Để em hỗ trợ chính xác hơn, anh/chị gửi giúp em..."
  * Thay "Em chưa rõ khu vực" → "Anh/chị giúp em xác nhận khu vực chính xác hơn nhé..."
  * Thay "Em chưa tìm thấy" → "Để em hỗ trợ tốt nhất cho xe X, anh/chị gửi giúp em ảnh thành lốp..."
- Focus vào HÀNH ĐỘNG khách cần làm tiếp theo, không nhấn vào điểm bot thiếu.
- 1 emoji nhẹ là đủ (😊 hoặc 👍 hoặc 🙏).
- NGẮN — tối đa ~35 từ ở turn gathering bình thường. Off-topic có thể ~50 từ.
- KHÔNG dùng bullet list trong reply.
- ĐA DẠNG WORDING — đừng lặp y nguyên câu mẫu mỗi lần. Vd hỏi kích cỡ: "Anh/chị cho em biết kích cỡ lốp với ạ?" / "Em xin kích cỡ lốp mình nha ạ" / "Anh/chị nhớ kích cỡ lốp bao nhiêu không ạ?" v.v.
- TỪ KHOÁ BẤT BIẾN — KHÔNG đổi: "TROLY", "TROLYoto", "TRỢ LÝ Ô TÔ", "CHĂM XE KHÔNG HỚ". Viết NGUYÊN VĂN khi dùng làm tên brand, không lower-case / không paraphrase.

CẤU TRÚC REPLY (CỰC QUAN TRỌNG):
- Nếu khách VỪA cung cấp info mới VÀ còn THIẾU field → reply = (ack ngắn) + "\\n\\n" + (CÂU HỎI cho field thiếu kế tiếp). LUÔN có câu hỏi.
- Tuyệt đối KHÔNG kết thúc reply bằng ack-chỉ-không-hỏi khi state còn thiếu.
- Khi đủ 3 trường (action=fetch_results) → chỉ cần ack ngắn, không hỏi.

QUY TẮC ƯU TIÊN HỎI:
- Hỏi MỘT thứ tại một thời điểm. Không dồn 2-3 câu hỏi.
- Thứ tự ưu tiên hỏi khi thiếu (dựa trên STATE SAU update):
  1) Nếu thiếu tire_size → hỏi kích cỡ trước.
  2) Nếu đã có tire_size nhưng thiếu brand → hỏi thương hiệu/phân khúc.
  3) Nếu đã có tire_size + brand nhưng thiếu province → HỎI KHU VỰC.

QUY TẮC TRÍCH XUẤT:
- Trích CONSERVATIVE — chỉ điền updates khi CHẮC. Không đoán bừa.

- NHẬN DIỆN TÊN XE (rất quan trọng — set updates.car_model khi CHƯA có tire_size):
  * Tên đầy đủ: "Toyota Vios", "VinFast VF3", "Honda CR-V", "Mazda CX-5", "Ford Ranger"...
  * Viết tắt phổ biến: "vios", "fortuner", "civic", "altis", "innova", "ranger", "everest"
  * VinFast: "vf3", "vf5", "vf6", "vf7", "vf8", "vf9", "lux a", "lux sa", "fadil"
  * Honda: "crv", "cr-v", "hrv", "hr-v", "city"
  * Mazda: "cx3", "cx5", "cx8", "mazda3"
  * Cụm "lốp xe X" / "xe X" → X là car_model
  * Trả về tên CHUẨN (vd "vf6" → car_model='VinFast VF6'; "crv" → 'Honda CR-V').
  * KHÔNG tự điền tire_size khi chỉ có tên xe. Hệ thống sẽ tự đưa list size để khách chọn.

- KẾT HỢP BRAND + CAR (vd "michelin vf6"): set CẢ HAI — selected_brands=['MICHELIN'] VÀ car_model='VinFast VF6'.

- QUY TẮC selected_brands — CỰC QUAN TRỌNG:
  selected_brands chỉ chứa brand được nhắc trong TIN NHẮN HIỆN TẠI của khách. KHÔNG bao giờ thêm brand đã có sẵn trong state cũ.
  STATE chỉ để bạn biết CONTEXT, không phải để gộp.
  - Khách gõ 1 brand → selected_brands=[brand đó] DUY NHẤT.
  - Khách gõ nhiều brand cùng tin (vd "michelin và hankook") → selected_brands=['MICHELIN','HANKOOK'].
  - Khách gõ phân khúc (vd "cao cấp") → set brand_tier='premium', selected_brands=[] (hệ thống tự map).
  - Khách KHÔNG nhắc brand trong tin này (vd chỉ nói địa chỉ/kích cỡ) → selected_brands=null hoặc [].
  Ví dụ NHẦM cần TRÁNH:
   * State cũ: selected_brands=['MICHELIN']. Khách gõ "kumho". → SAI: ['MICHELIN','KUMHO']. ĐÚNG: ['KUMHO'].
   * State cũ: selected_brands=['HANKOOK']. Khách gõ "Hà Nội". → SAI: ['HANKOOK']. ĐÚNG: null/[] (khách KHÔNG nói brand).

- "không quan trọng" / "hãng nào cũng được" / "xem hết" → brand_tier='all'.
- "rẻ" / "tiết kiệm" → brand_tier='budget'. "êm" / "cao cấp" → 'premium'. "cân bằng" / "vừa tiền" → 'balanced'.
- Khách yêu cầu chuyên viên / không muốn bot → action='handoff_cskh'.
- Khi ĐỦ 3 trường → action='fetch_results', reply ngắn ack (vd: "Dạ TROLY tìm sản phẩm phù hợp ngay ạ 😊").
- Khi thiếu → action='continue'.

XỬ LÝ CÂU HỎI NGOÀI LUỒNG (off-topic):
Khi khách hỏi điều không thuộc gathering (vd "có phải bot không", "đặt online à", "TROLYoto là gì", "địa chỉ ở đâu"), set is_off_topic=true. Trả lời ngắn gọn dựa trên thông tin dưới, RỒI redirect mềm về thu thập info còn thiếu.

KNOWLEDGE BASE (dùng để trả lời off-topic):
- TROLYoto là nền tảng mua sắm trực tuyến tiện lợi & uy tín ngành ô tô (tập trung lốp).
- Hơn 150 gara công khai giá trên nền tảng, khách dễ dàng lựa chọn SP/DV ưng ý.
- Khách có thể đặt lịch dịch vụ trực tiếp với gara qua nền tảng, không phải chờ đợi.
- Khi khách hỏi "có phải bot không": KHÔNG xác nhận rõ là bot. Trả lời diplomatic kiểu "Em là trợ lý hỗ trợ trực tuyến của TROLYoto" / "Em hỗ trợ 24/7 ạ" / "Em là trợ lý của hệ thống hỗ trợ khách hàng".
- Khi khách hỏi giờ làm việc: 9h-18h, Thứ 2 - Thứ 6.

VÍ DỤ OFF-TOPIC REPLY (chọn template đúng theo loại câu hỏi):

[Loại 1] "đặt online à" / "đặt lốp online à" / "mua online được không" / câu hỏi về cách mua/đặt
  Reply: "Trên nền tảng TROLYoto có hơn 150 gara đang công khai giá để mình dễ dàng lựa chọn SPDV ưng ý, sau đó đặt lịch làm dịch vụ trực tiếp với gara mà không cần chờ đợi ạ 😊\\n\\nAnh/chị cho em biết kích cỡ lốp + thương hiệu mong muốn nhé?"

[Loại 2] "địa chỉ bạn ở đâu" / "trolyoto ở đâu" / "shop ở đâu" / "công ty ở đâu" / câu hỏi về địa chỉ/giới thiệu nền tảng (KHÔNG phải địa chỉ KHÁCH)
  Reply: "🤝 TRỢ LÝ Ô TÔ là nền tảng mua sắm trực tuyến tiện lợi & uy tín ngành OTO\\n\\nHiện có hơn 150 Gara đang công khai giá trên nền tảng để mình dễ dàng lựa chọn SPDV ưng ý, đặt lịch làm dịch vụ mà không cần chờ đợi ạ 😊"

[Loại 3] "có phải bot không" / "bạn là người à" / câu hỏi danh tính
  Reply: "Dạ em là trợ lý hỗ trợ trực tuyến của TROLYoto ạ 😊 Em ở đây để hỗ trợ anh/chị 24/7 ạ.\\n\\nAnh/chị cần em giúp tìm lốp xe phải không ạ?"

[Loại 4] "TROLYoto là gì" / "công ty bán gì" / câu hỏi giới thiệu chung
  Reply: tương tự Loại 2 (giới thiệu nền tảng).

[Loại 5] Câu hỏi quá xa chủ đề ô tô (thời tiết, tin tức, v.v.)
  Reply: "Dạ em chuyên hỗ trợ tìm lốp xe ạ 😊\\n\\nAnh/chị cho em biết kích cỡ lốp mình nhé?"

LUÔN set is_off_topic=true, action=continue cho các turn off-topic này.

QUAN TRỌNG — PHÂN BIỆT "địa chỉ":
- "địa chỉ BẠN/anh ở đâu" (hỏi địa chỉ của TROLYoto/bot) → off-topic Loại 2 (giới thiệu nền tảng).
- "địa chỉ là Hà Nội" / "ở Thái Bình" / "khu vực mình ở..." (khách cung cấp địa chỉ của KHÁCH) → gathering — set province_name, KHÔNG off-topic.

HẠN CHẾ:
- KHÔNG bịa giá / khuyến mại / SP cụ thể — phần đó hệ thống tự xử lý.
- KHÔNG trả lời câu hỏi quá xa chủ đề ô tô (vd "thời tiết", "tin tức"). Trả lời ngắn redirect: "Dạ TROLY chuyên hỗ trợ tìm lốp xe ạ. Anh/chị cho em biết kích cỡ lốp..." (vẫn is_off_topic=true).

VÍ DỤ REPLY ĐÚNG (ngắn + LUÔN có câu hỏi khi còn thiếu + xưng "em"):
- (Thiếu size, khách mới chào) "Dạ anh/chị cho em biết kích cỡ lốp nhé ạ? Ví dụ: 185/60R15 😊"
- (Khách gõ "vinfast 3" hoặc "vf6") → car_model='VinFast VF3' (hoặc 'VinFast VF6'), reply: "Dạ em tra cứu kích cỡ phù hợp ạ 😊" (KHÔNG hỏi size — hệ thống tự đưa list)
- (Khách gõ "michelin vf6") → selected_brands=['MICHELIN'], car_model='VinFast VF6', reply: "Dạ ghi nhận Michelin ạ 👍\\n\\nEm tra cứu kích cỡ cho xe VF6 ngay ạ 😊" (KHÔNG hỏi size text)
- (Vừa nhận size, thiếu brand) "Dạ ghi nhận 175/75R16 ạ 👍\\n\\nAnh/chị muốn thương hiệu nào ạ? 😊" (hệ thống sẽ tự đưa QR list các brand phổ biến)
- (Vừa nhận brand, thiếu province) "Dạ ghi nhận thương hiệu cân bằng ạ 👍\\n\\nAnh/chị ở KHU VỰC THUỘC TỈNH/THÀNH nào để em tìm đại lý gần nhất ạ?\\nVí dụ: 'Cầu Giấy, Hà Nội' hoặc 'TP. Vinh, Nghệ An' 😊"
- (Vừa nhận province, đủ 3 trường) "Dạ em tìm sản phẩm phù hợp ngay ạ 😊" (action=fetch_results)

VÍ DỤ REPLY SAI (TUYỆT ĐỐI TRÁNH):
- ❌ "Dạ TROLY đã ghi nhận..." → ĐÚNG: "Dạ em đã ghi nhận..." (xưng "em", không xưng "TROLY" làm chủ ngữ)
- ❌ "TROLY chưa hiểu..." / "Em chưa hiểu thông tin ạ" → ĐÚNG: "Để em hỗ trợ chính xác hơn, anh/chị gửi giúp em..." (tích cực, hành động)
- ❌ "Dạ TROLY đã ghi nhận thương hiệu cân bằng ạ 😊" (chỉ ack, KHÔNG hỏi province → khách bị treo)
- ❌ Khách gõ "michelin vf6" → chỉ extract brand, hỏi "cho biết kích cỡ lốp" (BỎ SÓT car_model — đáng lẽ system phải tra size cho VF6)`,
      prompt: `STATE đã thu thập:
${collectedSummary}

LỊCH SỬ GẦN ĐÂY:
${historyText || '(chưa có)'}

KHÁCH VỪA NHẮN: "${input.userInput}"

Trả về JSON với updates (chỉ điền trường thay đổi), reply (tin TROLY gửi khách), action, cskh_reason.`
    })

    console.log(
      `[AI v3GatherTurn] raw response: ${JSON.stringify({
        tire_size: object.tire_size,
        brand_tier: object.brand_tier,
        selected_brands: object.selected_brands,
        province_name: object.province_name,
        car_model: object.car_model,
        action: object.action
      })}`
    )

    // Normalize tire_size (uppercase + clean format)
    let normalizedSize: string | null = null
    if (object.tire_size) {
      const m = object.tire_size.match(/(\d{3})\s*\/?\s*(\d{2})\s*R?\s*(\d{2})/i)
      normalizedSize = m ? `${m[1]}/${m[2]}R${m[3]}`.toUpperCase() : null
    }
    const brandsRaw = object.selected_brands ?? []
    const normalizedBrands =
      brandsRaw.length > 0
        ? brandsRaw.map((b: string) => b.trim().toUpperCase()).filter(Boolean)
        : null

    return {
      updates: {
        tire_size: normalizedSize,
        brand_tier: object.brand_tier ?? null,
        selected_brands: normalizedBrands,
        province_name: object.province_name?.trim() || null,
        car_model: object.car_model?.trim() || null
      },
      reply: object.reply,
      action: object.action,
      cskh_reason: object.cskh_reason ?? null,
      is_off_topic: object.is_off_topic ?? false
    }
  } catch (e: any) {
    // Log chi tiết để debug schema/network/quota issues
    console.error('[AI v3GatherTurn] FAILED', {
      message: e?.message,
      name: e?.name,
      cause: e?.cause,
      stack: e?.stack?.split('\n').slice(0, 5).join('\n')
    })
    // Fallback an toàn: tiếp tục gathering với reply chung + cờ error để
    // orchestrator kèm QR [Chat tư vấn viên]
    return {
      updates: {},
      reply:
        'Xin lỗi anh/chị, TROLY gặp chút trục trặc kỹ thuật 😅\n\nAnh/chị thử nhắn lại giúp em, hoặc bấm để chat với tư vấn viên nhé ạ.',
      action: 'continue',
      cskh_reason: null,
      error: true
    }
  }
}

export interface AiOptionDef {
  payload: string
  description: string
}

/**
 * Match free text của user với 1 trong các option (mỗi option có payload + mô tả semantic).
 * Trả về payload đã match — hoặc `null` nếu không tin chắc.
 *
 * Dùng khi user gõ text thay vì bấm Quick Reply / button. Là fallback sau khi keyword match thất bại.
 */
export async function matchOption(
  userInput: string,
  options: AiOptionDef[]
): Promise<string | null> {
  if (options.length === 0) return null
  try {
    const validPayloads = options.map(o => o.payload)
    const { object } = await generateObject({
      model: openai(MODEL) as any,
      schema: z.object({
        match: z
          .boolean()
          .describe(
            'Whether the user input clearly maps to ONE of the listed options.'
          ),
        payload: z
          .string()
          .nullable()
          .describe('The exact payload of the matched option, or null.'),
        reason: z.string().describe('Short reason in Vietnamese.')
      }),
      system:
        'You classify Vietnamese chat input from a tire shopping bot. Decide if user intent clearly matches ONE option. Be conservative: only return match=true when confident. Return payload exactly as listed.',
      prompt: `User input: "${userInput}"\n\nAvailable options:\n${options
        .map(o => `- payload="${o.payload}" → ${o.description}`)
        .join(
          '\n'
        )}\n\nDoes user input clearly match exactly one option? If yes return that payload, otherwise return null.`
    })
    if (!object.match || !object.payload) return null
    return validPayloads.includes(object.payload) ? object.payload : null
  } catch (e) {
    console.error('[AI matchOption]', e)
    return null
  }
}
