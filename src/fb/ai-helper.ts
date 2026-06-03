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
      // FLAT schema (không nested) — tránh issue với OpenAI structured output khi
      // nested object có nullable array. Schema đơn giản hơn = AI generate đúng hơn.
      schema: z.object({
        tire_size: z
          .string()
          .nullable()
          .describe('Tire size XXX/YYRZZ (e.g. 185/65R15) nếu khách CHỐT. Null nếu không có/không chắc.'),
        brand_tier: z
          .enum(['premium', 'balanced', 'budget', 'all'])
          .nullable()
          .describe(
            "Phân khúc: 'premium' (cao cấp/bền/êm), 'balanced' (cân bằng), 'budget' (rẻ/tiết kiệm), 'all' (xem hết). Null nếu chưa rõ."
          ),
        selected_brands: z
          .array(z.string())
          .describe('Brand cụ thể UPPERCASE khách nhắc (vd ["MICHELIN","BRIDGESTONE"]). Mảng RỖNG [] nếu chưa có brand cụ thể (KHÔNG dùng null).'),
        province_name: z
          .string()
          .nullable()
          .describe('Tên tỉnh/TP chuẩn tiếng Việt (vd "Hà Nội", "Hồ Chí Minh"). Null nếu chưa có/chưa rõ.'),
        car_model: z
          .string()
          .nullable()
          .describe(
            'Tên xe khách nêu khi CHƯA có kích cỡ chính xác (vd "VinFast 3", "Toyota Vios", "Fortuner 2020"). Hệ thống sẽ tự tra DB+AI ra list kích cỡ → KHÔNG hỏi size dạng text. Null nếu khách không nêu tên xe hoặc đã có size.'
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
          .nullable()
          .describe('Lý do handoff (nếu action=handoff_cskh). Null cho continue/fetch_results.')
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
- Xưng "em"/"TROLY", gọi "anh/chị". Kết "ạ".
- 1 emoji nhẹ là đủ (😊 hoặc 👍).
- NGẮN — tối đa ~35 từ. KHÔNG dài dòng, KHÔNG kể tier dài.
- KHÔNG dùng bullet list trong reply.

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

- "không quan trọng" / "hãng nào cũng được" / "xem hết" → brand_tier='all'.
- "rẻ" / "tiết kiệm" → brand_tier='budget'. "êm" / "cao cấp" → 'premium'. "cân bằng" / "vừa tiền" → 'balanced'.
- Khách yêu cầu chuyên viên / không muốn bot → action='handoff_cskh'.
- Khi ĐỦ 3 trường → action='fetch_results', reply ngắn ack (vd: "Dạ TROLY tìm sản phẩm phù hợp ngay ạ 😊").
- Khi thiếu → action='continue'.

HẠN CHẾ:
- KHÔNG trả lời câu hỏi ngoài phạm vi báo giá lốp. Redirect ngắn về chủ đề lốp.
- KHÔNG bịa giá / khuyến mại — phần đó hệ thống tự xử lý.

VÍ DỤ REPLY ĐÚNG (ngắn + LUÔN có câu hỏi khi còn thiếu):
- (Thiếu size, khách mới chào) "Dạ anh/chị cho TROLY biết kích cỡ lốp nhé ạ? Ví dụ: 185/60R15 😊"
- (Khách gõ "vinfast 3" hoặc "vf6") → car_model='VinFast VF3' (hoặc 'VinFast VF6'), reply: "Dạ TROLY tra cứu kích cỡ phù hợp ạ 😊" (KHÔNG hỏi size — hệ thống tự đưa list)
- (Khách gõ "michelin vf6") → selected_brands=['MICHELIN'], car_model='VinFast VF6', reply: "Dạ ghi nhận Michelin ạ 👍\\n\\nTROLY tra cứu kích cỡ cho xe VF6 ngay ạ 😊" (KHÔNG hỏi size text)
- (Vừa nhận size, thiếu brand) "Dạ ghi nhận 175/75R16 ạ 👍\\n\\nAnh/chị muốn thương hiệu nào ạ — cao cấp, cân bằng, tiết kiệm, hay xem hết? 😊"
- (Vừa nhận brand, thiếu province) "Dạ ghi nhận thương hiệu cân bằng ạ 👍\\n\\nAnh/chị ở khu vực nào để TROLY tìm gara gần ạ? 😊"
- (Vừa nhận province, đủ 3 trường) "Dạ TROLY tìm sản phẩm phù hợp ngay ạ 😊" (action=fetch_results)

VÍ DỤ REPLY SAI (TUYỆT ĐỐI TRÁNH):
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
        brand_tier: object.brand_tier,
        selected_brands: normalizedBrands,
        province_name: object.province_name?.trim() || null,
        car_model: object.car_model?.trim() || null
      },
      reply: object.reply,
      action: object.action,
      cskh_reason: object.cskh_reason
    }
  } catch (e: any) {
    // Log chi tiết để debug schema/network/quota issues
    console.error('[AI v3GatherTurn] FAILED', {
      message: e?.message,
      name: e?.name,
      cause: e?.cause,
      stack: e?.stack?.split('\n').slice(0, 5).join('\n')
    })
    // Fallback an toàn: tiếp tục gathering với reply chung
    return {
      updates: {},
      reply:
        'Xin lỗi anh/chị, TROLY gặp chút trục trặc kỹ thuật 😅\n\nAnh/chị thử nhắn lại giúp em nhé ạ.',
      action: 'continue',
      cskh_reason: null
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
