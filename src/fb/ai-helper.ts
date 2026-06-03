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
