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
    const m = object.tireSize.match(/(\d{3})\s*\/\s*(\d{2})\s*[A-Z]?\s*R\s*(\d{2})/i)
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
        const m = s.match(/(\d{3})\s*\/\s*(\d{2})\s*[A-Z]?\s*R\s*(\d{2})/i)
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
        const m = s.match(/(\d{3})\s*\/\s*(\d{2})\s*[A-Z]?\s*R\s*(\d{2})/i)
        return m ? `${m[1]}/${m[2]}R${m[3]}`.toUpperCase() : null
      })
      .filter((s): s is string => !!s)
    return { compatibleSizes }
  } catch (e) {
    console.error('[AI verifyTireSizesForCar]', e)
    return { compatibleSizes: [] }
  }
}

// ── resolveCarModel ─────────────────────────────────────────────────────────

export interface CarModelResolution {
  /** Tên chuẩn "<Hãng> <Model>" (vd "Hyundai Santa Fe"), null nếu không xác định được. */
  carModel: string | null
  brand: string | null
  confidence: number
}

/** Model mạnh hơn — dùng khi retry (lần đầu resolveCarModel trả sai/không xác định). */
const STRONG_MODEL = 'gpt-4o'

/**
 * Dedicated AI call CHỈ để xác định tên xe (hãng + model) từ free text tiếng
 * Việt của khách — TÁCH RIÊNG khỏi v3GatherTurn (prompt gom chung size+brand+
 * giá+khu vực+xe dễ khiến model xao nhãng, hallucinate tên xe không tồn tại
 * khi khách gõ sai chính tả / phát âm tiếng Việt không chuẩn, vd "san ta pe"
 * (Santa Fe bị tách âm tiết) từng bị đoán nhầm thành "Toyota San").
 *
 * Khác với v3GatherTurn: nhận toàn bộ userInput GỐC (không phải car_model đã
 * bị v3GatherTurn rút gọn) để giữ được ngữ cảnh gợi ý (vd "hàn quốc" giúp loại
 * trừ hãng Nhật/Mỹ/Đức), và hỗ trợ exclude-list + escalate model khi retry.
 *
 * @param params.excludeModels  Các tên xe ĐÃ THỬ và bị xác nhận sai (khách gửi
 *   tin khác thay vì chọn size) — dùng để tránh AI lặp lại đúng lỗi cũ.
 * @param params.useStrongModel true khi đây là lần retry (đã có excludeModels)
 *   — chuyển sang model mạnh hơn (gpt-4o) để tăng độ chính xác.
 */
export async function resolveCarModel(params: {
  userInput: string
  excludeModels?: string[]
  useStrongModel?: boolean
}): Promise<CarModelResolution> {
  const { userInput, excludeModels = [], useStrongModel = false } = params
  const modelToUse = useStrongModel ? STRONG_MODEL : MODEL
  try {
    const { object } = await generateObject({
      model: openai(modelToUse) as any,
      schema: z.object({
        car_model: z
          .string()
          .nullable()
          .describe(
            'Tên xe chuẩn dạng "<Hãng> <Model>" (vd "Hyundai Santa Fe", "Toyota Camry"). Null nếu KHÔNG đủ tin cậy để xác định.'
          ),
        brand: z.string().nullable().describe('Tên hãng xe (vd "Hyundai"). Null nếu car_model null.'),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .describe('Độ tin cậy 0-1. Dưới 0.6 → set car_model=null thay vì đoán liều.')
      }),
      system: `Bạn là chuyên gia nhận diện tên xe ô tô bán tại Việt Nam từ text tiếng Việt của khách hàng (chat/nhắn tin, có thể gõ tắt, sai chính tả, hoặc phiên âm tiếng Việt không chuẩn).

── DANH SÁCH HÃNG + MODEL PHỔ BIẾN TẠI VIỆT NAM ──
* TOYOTA:    Vios, Innova, Fortuner, Camry, Altis/Corolla Altis, Wigo, Yaris, Corolla Cross, Veloz, Avanza, Hilux, Land Cruiser, Raize, Rush
* HYUNDAI:   Accent, Grand i10, Tucson, Santa Fe, Elantra, Kona, Creta, Stargazer, Custin, Palisade
* KIA:       Seltos, Morning, Sonet, Carnival, Sorento, K3, K5, Cerato, Sportage, Rondo, Soluto
* MAZDA:     CX-3, CX-5, CX-8, CX-30, Mazda 2, Mazda 3, Mazda 6, BT-50
* HONDA:     City, Civic, CR-V, HR-V, Accord, Brio, Jazz, BR-V
* FORD:      Ranger, Everest, EcoSport, Focus, Territory, Explorer, Transit
* MITSUBISHI: Xpander, Outlander, Pajero, Triton, Attrage, Mirage, Xforce
* SUZUKI:    Swift, Ertiga, XL7, Ciaz, Carry, Jimny
* NISSAN:    Almera, Navara, X-Trail, Sunny, Terra, Kicks
* CHEVROLET: Spark, Trailblazer, Colorado, Captiva, Cruze, Aveo
* VINFAST:   VF3, VF5, VF6, VF7, VF8, VF9, Lux A, Lux SA, Fadil, President
* MG:        ZS, HS, MG5, RX5, MG3
* SUBARU:    Forester, Outback, XV, Impreza
* LEXUS:     RX, NX, LX, ES, GX, IS
* BMW:       X1, X3, X5, X7, Series 3, Series 5, Series 7
* MERCEDES:  C-Class, E-Class, S-Class, GLC, GLE, GLB, A-Class
* AUDI:      A4, A6, A8, Q3, Q5, Q7, Q8
* PEUGEOT:   3008, 5008, 2008
* ISUZU:     D-Max, mu-X
* WULING:    Mini EV, Hongguang

── XỬ LÝ PHÁT ÂM/GÕ TIẾNG VIỆT KHÔNG CHUẨN (CỰC QUAN TRỌNG) ──
Khách Việt Nam thường TÁCH ÂM TIẾT khi gõ/phát âm tên xe nước ngoài, hoặc gõ
theo cách nghe được. Hãy GHÉP LẠI các âm tiết rời rạc và so khớp NGỮ ÂM (phát
âm gần giống) với model trong danh sách trên, KHÔNG chỉ so khớp chuỗi ký tự
chính xác. Ví dụ:
* "san ta pe" / "xan ta phê" → "Santa Fe" (Hyundai)
* "pho tu nơ" / "pho tuy nơ" → "Fortuner" (Toyota)
* "cờ rốt xì" / "cờ rốt" → "Cross" (vd "Corolla Cross")
* "i ét" / "i ét mười" → "i10" (Hyundai Grand i10)
* "xe lô ra tô" → không khớp gì trong danh sách → car_model=null

── GỢI Ý TỪ QUỐC GIA XUẤT XỨ (nếu khách có nhắc) ──
* "hàn quốc"/"hàn" → ưu tiên Hyundai, Kia
* "nhật"/"nhật bản" → ưu tiên Toyota, Honda, Mazda, Nissan, Mitsubishi, Suzuki, Isuzu, Lexus
* "đức" → ưu tiên BMW, Mercedes, Audi
* "mỹ" → ưu tiên Ford, Chevrolet
* "trung quốc"/"tàu" → ưu tiên MG, Wuling
* "việt nam" → VinFast

── QUY TẮC BẮT BUỘC ──
* Trả tên CHUẨN "<Hãng> <Model>" (vd "Hyundai Santa Fe"), KHÔNG kèm năm/đời.
* CHỈ trả car_model khi confidence ≥ 0.6. Nếu không đủ tin cậy (model không
  khớp ngữ âm/ngữ nghĩa với BẤT KỲ tên nào trong danh sách, kể cả sau khi thử
  ghép âm tiết) → car_model=null, brand=null, confidence thấp. TUYỆT ĐỐI
  KHÔNG bịa ra 1 model không tồn tại trong danh sách (vd KHÔNG được trả "Toyota San" —
  "San" không phải model Toyota nào cả).
* ĐẶC BIỆT THẬN TRỌNG với input NGẮN/CỘT SỐNG YẾU (vd chỉ có 1 âm tiết mơ hồ +
  năm, như "San 2017" — KHÔNG có thêm ngữ cảnh nào khác): KHÔNG được cố "chọn
  đại" 1 model gần giống chỉ để có câu trả lời. "San" một mình KHÔNG đủ căn cứ
  để suy ra "Fortuner"/bất kỳ model nào — trường hợp này BẮT BUỘC car_model=null,
  confidence thấp (vd 0.2-0.4), để hệ thống hỏi khách rõ hơn thay vì đoán liều.
  Chỉ tự tin (≥0.6) khi có ít nhất 1 tín hiệu ngữ âm RÕ RÀNG khớp 1 model cụ
  thể, hoặc có thêm ngữ cảnh hỗ trợ (quốc gia, hãng, đặc điểm xe).
* Nếu có exclude-list (model đã thử và SAI) trong phần prompt bên dưới → KHÔNG
  ĐƯỢC trả lại các model đó, bắt buộc tìm phương án KHÁC dựa trên toàn bộ ngữ
  cảnh (kể cả gợi ý quốc gia, âm tiết gần đúng khác trong câu).`,
      prompt: `Tin nhắn khách: "${userInput}"
${
  excludeModels.length > 0
    ? `\nCác model ĐÃ THỬ và XÁC NHẬN SAI (không được trả lại): ${excludeModels.join(', ')}\nHãy suy luận LẠI từ đầu, ưu tiên các gợi ý ngữ âm/quốc gia khác trong câu để tìm ra xe ĐÚNG.`
    : ''
}

Xác định tên xe (hãng + model).`
    })

    console.log(
      `[AI resolveCarModel] model=${modelToUse} input="${userInput}" exclude=[${excludeModels.join(',')}] → car_model=${object.car_model} confidence=${object.confidence}`
    )

    if (!object.car_model || object.confidence < 0.6) {
      return { carModel: null, brand: null, confidence: object.confidence }
    }
    return {
      carModel: object.car_model.trim(),
      brand: object.brand?.trim() ?? null,
      confidence: object.confidence
    }
  } catch (e) {
    console.error('[AI resolveCarModel]', e)
    return { carModel: null, brand: null, confidence: 0 }
  }
}

// ── resolveAddress ───────────────────────────────────────────────────────────

export interface AddressResolution {
  /** Tên tỉnh/TP CHUẨN, khớp 1 trong 34 tỉnh/TP hiện hành. Null nếu không xác định được. */
  provinceName: string | null
  /** Tên phường/xã/khu vực cụ thể khách có nhắc (nếu có) — dùng để thu hẹp
   *  thêm xuống mức ward trong phạm vi tỉnh đã xác nhận. Null nếu không có. */
  wardHint: string | null
  confidence: number
}

/**
 * Dedicated AI call CHỈ để xác định ĐỊA CHỈ (tỉnh/TP + gợi ý phường/xã) từ
 * free text tiếng Việt của khách — TÁCH RIÊNG khỏi v3GatherTurn, cùng lý do
 * với resolveCarModel: prompt gom chung nhiều việc dễ khiến model hiểu sai
 * địa chỉ gõ tắt/sai chính tả/phát âm không chuẩn (vd "Phố nói a hùng yên"
 * từng bị hiểu nhầm khớp sang ward "Yên Bái, Lào Cai" thay vì "Hưng Yên").
 *
 * Nhận toàn bộ userInput GỐC (không phải province_name đã bị v3GatherTurn
 * rút gọn/hiểu sai) để giữ ngữ cảnh đầy đủ nhất.
 */
export async function resolveAddress(params: {
  userInput: string
}): Promise<AddressResolution> {
  const { userInput } = params
  try {
    const { object } = await generateObject({
      model: openai(MODEL) as any,
      schema: z.object({
        province_name: z
          .string()
          .nullable()
          .describe(
            'Tên tỉnh/TP CHUẨN, PHẢI khớp đúng 1 trong danh sách 34 tỉnh/TP hiện hành bên dưới. Null nếu không đủ tin cậy.'
          ),
        ward_hint: z
          .string()
          .nullable()
          .describe(
            'Tên phường/xã/khu vực cụ thể khách có nhắc (vd "Phố Nối", "Cầu Giấy") — chỉ set khi khách nhắc RÕ, không suy diễn. Null nếu không có.'
          ),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .describe('Độ tin cậy 0-1 cho province_name. Dưới 0.65 → set province_name=null thay vì đoán liều.')
      }),
      system: `Bạn là chuyên gia xác định ĐỊA CHỈ (tỉnh/thành phố) tại Việt Nam từ text tiếng Việt của khách hàng (chat/nhắn tin, có thể gõ tắt, thiếu dấu, sai chính tả, hoặc lỗi phát âm/gõ do gõ vội — vd "hùng yên" thay vì "Hưng Yên", "Phố nói" thay vì "Phố Nối").

── DANH SÁCH 34 TỈNH/THÀNH PHỐ HIỆN HÀNH (sau sáp nhập 2025) ──
An Giang, Bắc Ninh, Cao Bằng, Cà Mau, Cần Thơ, Gia Lai, Huế, Hà Nội, Hà Tĩnh,
Hưng Yên, Hải Phòng, Hồ Chí Minh, Khánh Hòa, Lai Châu, Lào Cai, Lâm Đồng,
Lạng Sơn, Nghệ An, Ninh Bình, Phú Thọ, Quảng Ngãi, Quảng Ninh, Quảng Trị,
Sơn La, Thanh Hóa, Thái Nguyên, Tuyên Quang, Tây Ninh, Vĩnh Long, Điện Biên,
Đà Nẵng, Đắk Lắk, Đồng Nai, Đồng Tháp

province_name TRẢ VỀ PHẢI khớp CHÍNH XÁC 1 tên trong danh sách trên (không tự
bịa tên tỉnh cũ đã sáp nhập — nếu khách nhắc tỉnh cũ như "Thái Bình"/"Hải Dương"
thì đã có hệ thống khác xử lý riêng trước khi tới bạn, bạn KHÔNG cần lo case đó).

── XỬ LÝ LỖI CHÍNH TẢ/GÕ TẮT/THIẾU DẤU (CỰC QUAN TRỌNG) ──
Khách thường gõ thiếu dấu, sai dấu (vd "hùng" thay vì "hưng" — 2 từ khác nghĩa
nhưng gõ nhầm dấu do gõ nhanh), viết tắt, hoặc lẫn ký tự lạ do lỗi bàn phím/
giọng nói chuyển văn bản. Hãy đọc theo ÂM ĐIỆU GẦN ĐÚNG và ngữ cảnh tổng thể
câu để suy ra tên tỉnh/phường xã ĐÚNG, KHÔNG chỉ so khớp ký tự chính xác.
Ví dụ:
* "Phố nói a hùng yên" → "hùng yên" gần âm với "Hưng Yên" (chỉ sai dấu ù/ư),
  "Phố nói a" gần âm với "Phố Nối" (1 phường thuộc Hưng Yên) →
  province_name="Hưng Yên", ward_hint="Phố Nối"
* "Cầu giấy hà lội" → province_name="Hà Nội", ward_hint="Cầu Giấy"
* Chỉ nhắc quận/huyện/phường mà KHÔNG nhắc tỉnh → suy ra tỉnh từ quận/huyện đó
  nếu bạn CHẮC CHẮN (vd "Cầu Giấy" → Hà Nội).

── QUY TẮC BẮT BUỘC ──
* CHỈ trả province_name khi confidence ≥ 0.65. Nếu câu quá mơ hồ, không có
  địa danh nào nhận diện được (kể cả sau khi thử đọc gần âm) → province_name=null,
  confidence thấp — ĐỪNG đoán đại 1 tỉnh nghe "gần giống" chỉ để có câu trả lời.
* TUYỆT ĐỐI KHÔNG chọn 1 tỉnh chỉ vì nó chứa 1 âm tiết trùng ngẫu nhiên (vd
  KHÔNG được suy "yên" trong "hùng yên" thành tỉnh có chữ "Yên" bất kỳ như
  "Yên Bái" — phải đọc TOÀN BỘ cụm từ theo ngữ âm, không chỉ 1 âm tiết lẻ).
* ward_hint CHỈ set khi khách THỰC SỰ nhắc tên phường/xã/khu vực cụ thể, không
  suy diễn khi không có căn cứ.`,
      prompt: `Tin nhắn khách: "${userInput}"\n\nXác định tỉnh/thành phố (và phường/xã nếu có nhắc).`
    })

    console.log(
      `[AI resolveAddress] input="${userInput}" → province_name=${object.province_name} ward_hint=${object.ward_hint} confidence=${object.confidence}`
    )

    if (!object.province_name || object.confidence < 0.65) {
      return { provinceName: null, wardHint: null, confidence: object.confidence }
    }
    return {
      provinceName: object.province_name.trim(),
      wardHint: object.ward_hint?.trim() ?? null,
      confidence: object.confidence
    }
  } catch (e) {
    console.error('[AI resolveAddress]', e)
    return { provinceName: null, wardHint: null, confidence: 0 }
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
      const m = object.size.match(/(\d{3})\s*\/?\s*(\d{2})\s*[A-Z]?\s*R?\s*(\d{2})/i)
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
          .describe(
            'Specific tire brands mentioned, UPPERCASE. Empty if none.'
          ),
        tier: z
          .enum(['premium', 'balanced', 'budget'])
          .nullable()
          .describe(
            "Implied segment: 'premium'=cao cấp/bền/êm, 'balanced'=cân bằng giá-chất lượng, 'budget'=rẻ/tiết kiệm. Null if not implied."
          ),
        seeAll: z
          .boolean()
          .describe(
            'True if user wants to see all / has no specific criteria.'
          ),
        priceMin: z
          .number()
          .nullable()
          .describe('Min price VND if a range given.'),
        priceMax: z
          .number()
          .nullable()
          .describe('Max price VND if a range given.'),
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
export async function analyzeTireImage(
  imageUrl: string
): Promise<TireImageAnalysis> {
  try {
    // 1. Tải ảnh từ FB CDN
    const imgRes = await fetch(imageUrl, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    if (!imgRes.ok) {
      throw new Error(
        `Fetch FB image failed: ${imgRes.status} ${imgRes.statusText}`
      )
    }
    const buf = await imgRes.arrayBuffer()
    const bytes = new Uint8Array(buf)
    const contentType = imgRes.headers.get('content-type') ?? 'image/jpeg'
    console.log(
      `[AI analyzeTireImage] downloaded ${bytes.byteLength} bytes (${contentType})`
    )

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
          .describe(
            'Chuỗi text bạn đọc được trên thành lốp, kể cả khi xoay/ngược — để debug khi sai.'
          )
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

    // Normalize size: 215 75 R 16 → 215/75R16. Bỏ ký hiệu tốc độ tuỳ chọn
    // (Z/H/V/W...) giữa tỷ lệ khung và "R" — vd "225/55ZR19" → "225/55R19".
    let normalizedSize: string | null = null
    if (object.tire_size) {
      const m = object.tire_size.match(
        /(\d{3})\s*\/?\s*(\d{2})\s*[A-Z]?\s*R?\s*(\d{2})/i
      )
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
  max_price?: number | null
  wants_best_quality?: boolean
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
  /** Ngưỡng giá tối đa (VND) khi khách hỏi theo tầm giá. */
  max_price?: number | null
  /** Khách muốn "tốt nhất" mà không chỉ định brand/phân khúc cụ thể. */
  wants_best_quality?: boolean | null
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
  /** Loại câu hỏi off-topic cụ thể (chỉ set khi is_off_topic=true) — dùng để
   *  route sang xử lý riêng (vd FAQ năm sản xuất / địa chỉ-SĐT gara → resend
   *  card cũ đổi nhãn nút). */
  off_topic_kind?: 'manufacture_year' | 'garage_contact' | null
}

const V3_BRAND_TIER_INFO = {
  premium: 'Michelin, Bridgestone, Toyo, Continental, Pirelli',
  balanced: 'Hankook, Goodyear, Dunlop, Yokohama',
  budget: 'Sailun, Kumho, RoadX, Laufenn, Nexen, TBB, Westlake, Maxxis, Otani'
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
export async function v3GatherTurn(
  input: V3GatherInput
): Promise<V3GatherDecision> {
  console.log('v3GatherTurn', input)
  const collected = input.collected || {}
  const historyText = (input.recentHistory ?? [])
    .slice(-6)
    .map(t => `${t.role === 'bot' ? 'TROLY' : 'Khách'}: ${t.text}`)
    .join('\n')

  const collectedSummary = [
    `tire_size: ${collected.tire_size ?? '(missing)'}`,
    `brand_tier: ${collected.brand_tier ?? '(missing)'}`,
    `selected_brands: ${collected.selected_brands?.join(', ') || '(missing)'}`,
    `province_name: ${collected.province_name ?? '(missing)'}`,
    `max_price: ${collected.max_price ?? '(missing)'}`,
    `wants_best_quality: ${collected.wants_best_quality ?? '(missing)'}`
  ].join('\n')

  try {
    const { object } = await generateObject({
      model: openai(MODEL) as any,
      // FLAT schema + .nullish() cho field optional — tolerant với AI khi nó omit field.
      schema: z.object({
        tire_size: z
          .string()
          .nullish()
          .describe(
            'Tire size XXX/YYRZZ (e.g. 185/65R15) nếu khách CHỐT. Null/omit nếu không có/không chắc.'
          ),
        brand_tier: z
          .enum(['premium', 'balanced', 'budget', 'all'])
          .nullish()
          .describe(
            "Phân khúc: 'premium' (cao cấp/bền/êm), 'balanced' (cân bằng), 'budget' (rẻ/tiết kiệm), 'all' (xem hết). Null/omit nếu chưa rõ."
          ),
        selected_brands: z
          .array(z.string())
          .nullish()
          .describe(
            'Brand cụ thể UPPERCASE khách nhắc (vd ["MICHELIN","BRIDGESTONE"]). Null/omit hoặc [] nếu chưa có.'
          ),
        max_price_vnd: z
          .number()
          .nullish()
          .describe(
            'Ngưỡng giá TỐI ĐA (VND) khi khách hỏi theo TẦM GIÁ thay vì/kèm brand-phân khúc. Parse "2tr"/"2 triệu"→2000000, "2tr5"/"2.5 triệu"→2500000, "dưới 2tr"/"tối đa 2tr"/"không quá 2tr"→2000000, "tầm 1.5-2 triệu" (có khoảng)→lấy cận TRÊN=2000000. Null/omit nếu khách không nêu tầm giá bằng số cụ thể.'
          ),
        wants_best_quality: z
          .boolean()
          .nullish()
          .describe(
            'True khi khách hỏi loại "tốt nhất"/"chất lượng nhất"/"bền nhất"/"xịn nhất" mà KHÔNG chỉ định brand/phân khúc cụ thể nào — hệ thống sẽ tự tìm SP tốt nhất đang có sẵn. False/omit cho các trường hợp khác (kể cả khi khách nói "cao cấp" — đó là brand_tier=premium, không phải trường này).'
          ),
        province_name: z
          .string()
          .nullish()
          .describe(
            'Tên tỉnh/TP chuẩn tiếng Việt (vd "Hà Nội", "Hồ Chí Minh"). Null/omit nếu chưa có/chưa rõ.'
          ),
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
            'continue=còn thiếu info, fetch_results=đủ 3 trường, handoff_cskh=khách yêu cầu chuyên viên/khó chịu/ngoài phạm vi HOẶC bạn KHÔNG có đủ dữ liệu để trả lời chính xác câu hỏi cụ thể của khách (tồn kho, giá dịch vụ đi kèm chi tiết, thông số kỹ thuật SP...) — dùng handoff_cskh thay vì tự trả lời "không thể"/từ chối.'
          ),
        cskh_reason: z
          .string()
          .nullish()
          .describe(
            'Lý do handoff (nếu action=handoff_cskh). Null/omit cho continue/fetch_results.'
          ),
        is_off_topic: z
          .boolean()
          .nullish()
          .describe(
            'True khi bạn đang trả lời câu hỏi NGOÀI luồng gathering (vd "có phải bot không", "đặt online à", "địa chỉ bạn ở đâu", "TROLYoto là gì"). Khi true, orchestrator sẽ KHÔNG tính fail counter. False/omit cho các turn gathering thông thường.'
          ),
        off_topic_kind: z
          .enum(['manufacture_year', 'garage_contact'])
          .nullish()
          .describe(
            'Set "manufacture_year" BẤT CỨ KHI NÀO khách hỏi về NĂM/NGÀY SẢN XUẤT lốp (vd "lốp sản xuất năm nào", "date code là gì", "lốp này mới hay tồn kho lâu", "sản xuất khi nào", "date bao nhiêu"). Set "garage_contact" BẤT CỨ KHI NÀO khách hỏi ĐỊA CHỈ/SỐ ĐIỆN THOẠI của GARA cụ thể (vd "cho tôi xin địa chỉ gara", "có số điện thoại gara không", "gara ở đâu", "liên hệ gara sao", "sđt gara là gì") — KHÁC với hỏi địa chỉ/SĐT của TROLYoto (đó là off-topic Loại 2 riêng). Cả 2 trường hợp: kể cả câu hỏi có vẻ liên quan tới SP đang bàn (không phải "off-topic xa lạ"), kể cả khi state đã đủ 3 trường. Khi set field này → BẮT BUỘC set is_off_topic=true CÙNG LÚC, KHÔNG set action=\'handoff_cskh\' (hệ thống đã có câu trả lời cố định riêng, không cần chuyển CSKH). Null/omit cho mọi trường hợp khác.'
          )
      }),
      system: `Bạn là TROLY — trợ lý ô tô của TROLYoto (nền tảng mua lốp xe ở Việt Nam).
Nhiệm vụ: thu thập 3 thông tin để báo giá lốp:
1. tire_size (định dạng XXX/YYRZZ)
2. brand preference: brand cụ thể (1-3 hãng) HOẶC phân khúc (mô tả định tính như "hàng bình dân" cũng tính) HOẶC tầm giá (vd "dưới 2tr") HOẶC "tốt nhất"/"chất lượng nhất" (không kèm brand cụ thể) HOẶC xem hết. Brand/phân khúc và tầm giá KHÔNG loại trừ nhau — khách có thể nêu cả hai cùng lúc (vd "michelin dưới 2tr"), lúc đó điền CẢ selected_brands VÀ max_price_vnd.
3. province (tỉnh/TP ở Việt Nam) — HỎI SAU CÙNG, sau khi đã có size + brand

TỪ ĐỒNG NGHĨA "LỐP" (CỰC QUAN TRỌNG): khách gọi lốp xe bằng nhiều cách —
"lốp", "nốp", "vỏ", "vỏ xe", "bánh xe". TẤT CẢ đều hiểu là "lốp xe".
Vd "vỏ xe vios" → car_model='Toyota Vios'. Vd "nốp 185/60R15" → tire_size='185/60R15'.

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

- NHẬN DIỆN KÍCH CỠ LỐP — chuẩn hoá MỌI biến thể về "XXX/YYRZZ":
  * "205/60R16" → "205/60R16" (chuẩn)
  * "205/60/16" → "205/60R16" (dấu "/" thứ 2 = R)
  * "205 60 16" / "205-60-16" / "205.60.16" → "205/60R16"
  * "20560R16" / "2056016" (dính liền) → "205/60R16"
  * Có hậu tố tải/tốc độ (vd "205/60R16 92V", "215/75R16C") → BỎ hậu tố, chỉ lấy "205/60R16".
  * LUÔN output tire_size dạng chuẩn "XXX/YYRZZ" (3 số / 2 số R 2 số), dù khách gõ kiểu gì.
  * ĐỔI SIZE (CỰC QUAN TRỌNG): nếu khách gõ kích cỡ MỚI khác size đã có trong STATE
    → tire_size = size MỚI (GHI ĐÈ), reply nhắc ĐÚNG size mới.
    Vd STATE có "185/70R13", khách gõ "155/70R13" → tire_size='155/70R13',
    reply "Dạ ghi nhận 155/70R13 ạ..." — TUYỆT ĐỐI KHÔNG giữ/nhắc lại "185/70R13".

- NHẬN DIỆN VIẾT TẮT HÃNG LỐP (2-3 ký tự, ngữ cảnh lốp) — map về tên CHUẨN HOA:
  * MC / MI / MCL → MICHELIN
  * BS / BRI → BRIDGESTONE
  * HK / HAN → HANKOOK
  * DL / DUN → DUNLOP
  * GY / GDY → GOODYEAR
  * YK / YH / YOKO → YOKOHAMA
  * KM / KH → KUMHO
  * CT / CON / CONTI → CONTINENTAL
  * MX / MAX → MAXXIS
  * PL / PIR → PIRELLI
  * → Vd "MC" → selected_brands=['MICHELIN']. "BS 2 lốp" → ['BRIDGESTONE'].

- BỎ QUA tên DÒNG SẢN PHẨM + NĂM khi trích (chúng KHÔNG phải kích cỡ/xe):
  * Dòng lốp: "sp05", "primacy", "energy", "pilot", "sport", "turanza", "alenza",
    "advan", "ecopia", "assurance", "kinergy"... → KHÔNG đưa vào car_model.
  * Năm "2026", "đời 2024" → bỏ.
  * Vd "cần tư vấn MC sp05 2026 cho 205/60/16" → selected_brands=['MICHELIN'],
    tire_size='205/60R16', car_model=null (sp05 là dòng lốp, KHÔNG phải xe).

- NHẬN DIỆN TÊN XE (rất quan trọng — set updates.car_model khi CHƯA có tire_size):
  * Cụm "lốp xe X" / "xe X" / "X đời YYYY" → X là car_model (BỎ năm "đời 2021", "model 2020")
  * Trả về tên CHUẨN dạng "<Hãng> <Model>" (KHÔNG kèm năm/đời).

  ── DANH SÁCH HÃNG + MODEL PHỔ BIẾN TẠI VIỆT NAM ──
  * TOYOTA:    Vios, Innova, Fortuner, Camry, Altis, Wigo, Yaris, Corolla Cross, Veloz, Avanza, Hilux, Land Cruiser, Raize, Rush
  * HYUNDAI:   Accent, Grand i10, Tucson, Santa Fe, Elantra, Kona, Creta, Stargazer, Custin, Palisade
  * KIA:       Seltos, Morning, Sonet, Carnival, Sorento, K3, K5, Cerato, Sportage, Rondo, Soluto
  * MAZDA:     CX-3, CX-5, CX-8, CX-30, Mazda 2, Mazda 3, Mazda 6, BT-50
  * HONDA:     City, Civic, CR-V, HR-V, Accord, Brio, Jazz, BR-V
  * FORD:      Ranger, Everest, EcoSport, Focus, Territory, Explorer, Transit
  * MITSUBISHI: Xpander, Outlander, Pajero, Triton, Attrage, Mirage, Xforce
  * SUZUKI:    Swift, Ertiga, XL7, Ciaz, Carry, Jimny
  * NISSAN:    Almera, Navara, X-Trail, Sunny, Terra, Kicks
  * CHEVROLET: Spark, Trailblazer, Colorado, Captiva, Cruze, Aveo
  * VINFAST:   VF3, VF5, VF6, VF7, VF8, VF9, Lux A, Lux SA, Fadil, President
  * MG:        ZS, HS, MG5, RX5, MG3
  * SUBARU:    Forester, Outback, XV, Impreza
  * LEXUS:     RX, NX, LX, ES, GX, IS
  * BMW:       X1, X3, X5, X7, Series 3, Series 5, Series 7
  * MERCEDES:  C-Class, E-Class, S-Class, GLC, GLE, GLB, A-Class
  * AUDI:      A4, A6, A8, Q3, Q5, Q7, Q8
  * PEUGEOT:   3008, 5008, 2008
  * ISUZU:     D-Max, mu-X
  * WULING:    Mini EV, Hongguang

  ── VIẾT TẮT/TYPO PHỔ BIẾN ──
  * "vios" → Toyota Vios       "altis"/"corolla" → Toyota Corolla Altis
  * "fortuner" → Toyota Fortuner    "innova" → Toyota Innova
  * "wigo" → Toyota Wigo           "raize" → Toyota Raize
  * "civic" → Honda Civic          "crv"/"cr-v" → Honda CR-V
  * "city" → Honda City            "hrv"/"hr-v" → Honda HR-V
  * "cx3"/"cx5"/"cx8" → Mazda CX-3/5/8    "mazda3" → Mazda 3
  * "vf3"-"vf9" → VinFast VF3-VF9    "fadil" → VinFast Fadil
  * "acent"/"accent" → Hyundai Accent    "i10"/"grand i10" → Hyundai Grand i10
  * "tucson"/"tucs" → Hyundai Tucson    "santafe"/"santa fe" → Hyundai Santa Fe
  * "elantra" → Hyundai Elantra
  * "seltos"/"seltot"/"selto" → Kia Seltos    "morning" → Kia Morning
  * "sonet" → Kia Sonet           "carnival" → Kia Carnival
  * "sorento" → Kia Sorento       "k3"/"k5" → Kia K3/K5
  * "cerato" → Kia Cerato         "sportage" → Kia Sportage
  * "xpander" → Mitsubishi Xpander    "outlander" → Mitsubishi Outlander
  * "triton" → Mitsubishi Triton    "xforce" → Mitsubishi Xforce
  * "swift" → Suzuki Swift        "ertiga" → Suzuki Ertiga
  * "xl7" → Suzuki XL7            "almera" → Nissan Almera
  * "navara" → Nissan Navara      "xtrail"/"x-trail" → Nissan X-Trail
  * "ranger" → Ford Ranger        "everest" → Ford Everest
  * "ecosport" → Ford EcoSport    "territory" → Ford Territory
  * "spark" → Chevrolet Spark     "trailblazer" → Chevrolet Trailblazer
  * "forester" → Subaru Forester
  * "glc"/"gle" → Mercedes-Benz GLC/GLE    "x5"/"x3" → BMW X5/X3
  * "q5"/"q7" → Audi Q5/Q7         "rx"/"nx"/"lx" → Lexus RX/NX/LX
  * "d-max"/"dmax" → Isuzu D-Max   "mu-x"/"mux" → Isuzu mu-X
  * "3008"/"5008" → Peugeot 3008/5008

  ── TUYỆT ĐỐI TRÁNH ──
  * KHÔNG đoán brand khi model không match danh sách trên.
    Vd: "seltot" → match "Seltos" (Kia) — KHÔNG đoán VinFast/Toyota.
    Vd: "tucs" → match "Tucson" (Hyundai) — KHÔNG đoán random.
  * Nếu KHÔNG chắc model thuộc hãng nào → set car_model=null, để bot hỏi rõ.
  * KHÔNG tự điền tire_size khi chỉ có tên xe. Hệ thống sẽ tự đưa list size để khách chọn.
  * BỎ năm/đời ra khỏi car_model (vd "Seltos đời 2021" → car_model='Kia Seltos', KHÔNG kèm 2021).

- KẾT HỢP BRAND + CAR (vd "michelin vf6"): set CẢ HAI — selected_brands=['MICHELIN'] VÀ car_model='VinFast VF6'.

- VIẾT TẮT/CÁCH GỌI TÊN HÃNG LỐP — chuyển về tên CHUẨN HOA:
  * MICHELIN: "michelin", "michellin", "mít", "míc", "mit", "mic", "mix", "ma sờ lin", "mi sờ lin", "mì sờ lăng"
  * BRIDGESTONE: "bridgestone", "bri", "bri đờ", "bri đờ stôn", "bê rít gì tôn", "bri sờ tôn"
  * HANKOOK: "hankook", "han cốc", "han cook", "hăn cốc", "han kook"
  * DUNLOP: "dunlop", "đăn lốp", "đăn lóp", "đăn lop", "dăn lốp"
  * GOODYEAR: "goodyear", "good year", "gút diê", "gút năm", "good iya"
  * KUMHO: "kumho", "kum hô", "kum hồ", "kum ho", "cum hô"
  * MAXXIS: "maxxis", "mắc xít", "max xít", "mác xít", "max sit"
  * YOKOHAMA: "yokohama", "yô cô ha ma", "yo ko ha ma", "yô hama"
  * CONTINENTAL: "continental", "conti", "côn ti", "công ty nen tan"
  * PIRELLI: "pirelli", "pi reo li", "pi rê li"
  * TOYO: "toyo", "tô yô", "to yo"
  * FALKEN: "falken", "phan ken", "phai ken"
  * NEXEN: "nexen", "nếch sen", "nech xen"
  * ADVANCE: "advance", "át văn", "ad van"
  * SAILUN: "sailun", "sai lun", "sây lun"
  * ROADX: "roadx", "road x", "rốt ích"
  * LAUFENN: "laufenn", "lau fen", "lau phần"
  * TBB: "tbb", "ti bi bi"
  * WESTLAKE: "westlake", "goét lếch", "oét lếch"
  * OTANI: "otani", "ô ta ni", "o ta ni"
  → Khi khách gõ alias trên (kể cả viết tắt 2-3 ký tự) → selected_brands = [TÊN CHUẨN HOA].
  → Vd: "lốp mít cho vios" → selected_brands=['MICHELIN'], car_model='Toyota Vios'.
  → Vd: "han cốc" → selected_brands=['HANKOOK'].
  → Vd: "tôi muốn đăn lốp" → selected_brands=['DUNLOP'].

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
- "rẻ" / "tiết kiệm" / "hàng bình thường" / "bình dân" / "cho xe dịch vụ" / "loại phổ thông" → brand_tier='budget'.
- "êm" / "cao cấp" → 'premium'. "cân bằng" / "vừa tiền" → 'balanced'.
- "tốt nhất" / "chất lượng nhất" / "bền nhất" / "loại xịn nhất" KHÔNG kèm brand/phân khúc cụ thể nào
  → wants_best_quality=true, brand_tier=null, selected_brands=[] (hệ thống tự tìm SP tốt nhất đang có).
  (Nếu khách nói "cao cấp" → đó là brand_tier='premium', KHÔNG phải wants_best_quality.)

TẦM GIÁ (max_price_vnd) — nhận diện khi khách nêu ngưỡng giá bằng số:
  * "2tr" / "2 triệu" → 2000000. "2tr5" / "2.5 triệu" → 2500000.
  * "dưới 2tr" / "tối đa 2tr" / "không quá 2tr" → max_price_vnd=2000000.
  * "tầm 1.5-2 triệu" (có khoảng) → lấy cận TRÊN → max_price_vnd=2000000.
  * Khách CHỈ nêu tầm giá, KHÔNG nêu brand/phân khúc → max_price_vnd set, brand_tier=null, selected_brands=[].
  * Khách nêu CẢ brand/phân khúc VÀ tầm giá trong cùng câu (vd "michelin dưới 2tr") → điền CẢ HAI, tầm giá là filter THÊM chứ không thay thế brand.
  * Null/omit nếu khách KHÔNG nêu tầm giá bằng số cụ thể TRONG TIN NHẮN HIỆN TẠI này —
    TUYỆT ĐỐI KHÔNG tự lặp lại/echo giá trị max_price đã có trong STATE hay đã nhắc ở
    LỊCH SỬ GẦN ĐÂY trước đó chỉ vì nó vẫn "còn liên quan". Field này CHỈ phản ánh
    những gì khách gõ ở tin nhắn NÀY, y hệt cách selected_brands hoạt động.
  * Khách CHÊ GIÁ CAO nhưng KHÔNG kèm số cụ thể (vd "giá cao quá", "đắt quá", "mắc quá",
    "giá hơi cao", "có rẻ hơn không") → max_price_vnd=null (TUYỆT ĐỐI KHÔNG tự đoán/suy
    ra 1 con số), action='continue', reply hỏi lại rõ ràng mức giá khách mong muốn (vd
    "Dạ anh/chị mong muốn tìm mức giá dưới bao nhiêu để em tìm giúp mình ạ? 😊"). CHỈ
    điền max_price_vnd ở LƯỢT KẾ TIẾP khi khách trả lời bằng số cụ thể.
  * Khách hỏi GIÁ CHUNG CHUNG — KHÔNG chê đắt, chỉ đơn thuần hỏi "bao nhiêu tiền"/"giá
    sao" (vd "bao nhiêu một chiếc vậy", "giá bao nhiêu", "nhiêu tiền vậy", "giá thế
    nào", "báo giá giúp em") — PHÂN BIỆT RÕ với "chê giá cao" ở trên: khách này KHÔNG hề
    phàn nàn/yêu cầu lọc giá, chỉ đang hỏi thông tin. max_price_vnd=null (hỏi giá KHÔNG
    có nghĩa khách muốn lọc theo 1 ngưỡng giá).
    - CHƯA đủ 3 trường (size/brand/khu vực) → TUYỆT ĐỐI KHÔNG hỏi "mức giá dưới bao
      nhiêu" (khách không hề nêu ý muốn lọc giá, hỏi vậy là sai ý). Thay vào đó reply
      giải thích ngắn gọn cần thêm thông tin để báo giá chính xác + hỏi tiếp field CÒN
      THIẾU tiếp theo (size→brand→khu vực), y hệt turn gathering bình thường. Coi 1
      kích cỡ VỪA ĐƯỢC GỢI Ý ở lượt trước (bot vừa hỏi "xác nhận có phù hợp không") là
      ĐÃ CÓ khi xét field nào còn thiếu — KHÔNG hỏi lại xác nhận size (tránh vòng lặp
      thừa khi khách đang hỏi giá chứ không phải từ chối size đó). Vd đã có size (đang
      chờ xác nhận) + brand, còn thiếu khu vực → reply: "Dạ giá lốp tùy theo khu vực +
      gara ạ, anh/chị ở khu vực nào (vd Hà Nội) để em gửi giá phù hợp cho mình ạ? 😊"
      (LUÔN kết thúc bằng dấu "?" — reply không có "?" sẽ bị hệ thống coi là "AI quên
      hỏi field thiếu" và tự chèn thêm 1 tin hỏi lại KHU VỰC dư thừa, trùng lặp ý).
    - ĐÃ ĐỦ 3 trường → action='fetch_results' bình thường (khách hỏi giá lúc đã đủ info
      → cứ tìm SP thật để trả lời, không cần hỏi lại).
  * CỰC KỲ QUAN TRỌNG: các con số THUỘC VỀ TIN NHẮN HỆ THỐNG/MARKETING trong LỊCH SỬ
    GẦN ĐÂY (vd "TRỢ GIÁ tới 800K", "giảm giá tới 200k", tên chương trình khuyến mại)
    KHÔNG PHẢI là mức giá khách mong muốn — chỉ là số tiền trợ giá/khuyến mại của hệ
    thống. TUYỆT ĐỐI KHÔNG lấy các con số này làm max_price_vnd dù khách vừa chê giá
    cao ngay sau đó — 2 việc này KHÔNG liên quan nhau.
- Khách yêu cầu chuyên viên / không muốn bot → action='handoff_cskh'.
- Khi ĐỦ 3 trường → action='fetch_results', reply ngắn ack (vd: "Dạ TROLY tìm sản phẩm phù hợp ngay ạ 😊").
- Khi thiếu → action='continue'.

KHÁCH HỎI ĐIỀU BẠN KHÔNG CÓ DỮ LIỆU ĐỂ TRẢ LỜI (CỰC QUAN TRỌNG):
Khi khách hỏi thông tin CỤ THỂ mà bạn KHÔNG có dữ liệu chính xác để trả lời — vd:
tình trạng CÒN HÀNG/tồn kho cụ thể ("còn hàng không", "còn size này không"), THÔNG SỐ
KỸ THUẬT chi tiết của SP ("gai lốp thế nào", "hoa văn ra sao", "độ bền bao lâu"), GIÁ
CHI TIẾT của từng dịch vụ đi kèm ngoài giá SP hiển thị ("giá đã bao gồm thay + cân bằng
động + chỉnh chụm chưa", "phí lắp đặt bao nhiêu") — TUYỆT ĐỐI KHÔNG tự trả lời kiểu từ
chối/xin lỗi ("em không thể...", "em chưa thể cung cấp...", "em không có thông tin...").
Thay vào đó set action='handoff_cskh' kèm cskh_reason mô tả ngắn gọn câu hỏi, để chuyên
viên TROLYoto liên hệ hỗ trợ trực tiếp — KHÔNG cố tự trả lời rồi redirect tiếp.
(Phân biệt với off-topic ở dưới: off-topic là câu hỏi bạn CÓ đủ info để trả lời ngắn gọn
theo KNOWLEDGE BASE/template có sẵn — vd hỏi giờ làm việc, TROLYoto là gì. Còn nhóm này
là câu hỏi bạn KHÔNG có dữ liệu, dù có vẻ liên quan trực tiếp tới SP/dịch vụ đang bàn.
NGOẠI LỆ: hỏi ĐỊA CHỈ/SỐ ĐIỆN THOẠI GARA cụ thể — KHÔNG thuộc nhóm handoff_cskh này,
xem [Loại 10] bên dưới, đã có FAQ riêng.)

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

[Loại 6] Giờ giấc / lịch làm việc của GARA — BẤT KỲ câu hỏi nào về THỜI GIAN gara hoạt động:
  Ví dụ: "gara mở cửa lúc nào", "mấy giờ gara đóng cửa", "giờ làm việc gara", "gara làm việc khi nào",
  "gara làm việc giờ nào", "gara mấy giờ làm", "khi nào gara mở", "gara có làm cuối tuần không",
  "gara làm thứ 7 chủ nhật không", "gara nghỉ ngày nào", "gara làm tới mấy giờ".
  → Nhận diện theo Ý ĐỊNH (hỏi về thời gian/lịch hoạt động của gara), KHÔNG cần khớp đúng câu chữ.
  Reply: "Dạ phần lớn gara mở cửa từ 8h-18h, Thứ 2 đến Thứ 7 ạ 😊 Tùy từng gara có thể khác giờ một chút. Anh/chị có thể xem giờ cụ thể của từng gara trên trang chi tiết ạ.\\n\\nAnh/chị cần em hỗ trợ thêm gì về lốp xe không ạ?"

[Loại 7] "Loại nào tốt" — khách CHƯA xác định thương hiệu/SP, hỏi chung "loại nào tốt", "nên mua hãng nào", "tư vấn hãng giúp em"
  Reply: "Dạ tùy vào nhu cầu và ngân sách, TROLYoto gợi ý theo tiêu chí chất lượng + giá thành ạ:\\n• Cao cấp: Michelin, Bridgestone, Continental\\n• Cân bằng: Goodyear, Hankook, Yokohama\\n• Tiết kiệm: Kumho, Sailun, Laufenn\\n\\nAnh/chị đang quan tâm thương hiệu nào ạ?"

[Loại 8] Hỏi tên CHƯƠNG TRÌNH KHUYẾN MẠI cụ thể: "có khuyến mại gì", "chương trình X còn không", "đang sale gì"
  Reply: "Dạ tùy vào kích cỡ + thương hiệu + gara khác nhau sẽ có các chương trình khác nhau ạ 😊\\n\\nAnh/chị cho em biết kích cỡ lốp + thương hiệu mong muốn để em tìm chương trình phù hợp nhé?"
  → Tiếp tục flow tìm 3 dữ liệu: kích cỡ + thương hiệu + khu vực.

[Loại 9] Hỏi NĂM/NGÀY SẢN XUẤT lốp: "lốp sản xuất năm nào", "date code là gì", "lốp này mới hay tồn kho lâu", "sản xuất khi nào", "date bao nhiêu"
  → LUÔN set is_off_topic=true VÀ off_topic_kind='manufacture_year' CÙNG LÚC — kể cả khi câu hỏi nghe như đang hỏi tiếp về SP vừa chọn (KHÔNG coi đây là câu hỏi "on-topic" cần trả lời chi tiết, KHÔNG áp dụng quy tắc "KHÔNG bịa SP cụ thể" ở đây vì hệ thống đã có câu trả lời cố định sẵn), kể cả khi state đã đủ 3 trường size/brand/khu vực. Reply KHÔNG cần tự soạn — hệ thống dùng câu cố định riêng, bạn CHỈ CẦN set đúng 2 field trên, reply có thể để trống hoặc câu ngắn bất kỳ (sẽ bị hệ thống ghi đè).

[Loại 10] Hỏi ĐỊA CHỈ/SỐ ĐIỆN THOẠI của GARA cụ thể (KHÁC "địa chỉ TROLYoto" ở Loại 2):
  Ví dụ: "cho tôi xin địa chỉ gara", "có số điện thoại gara không", "sđt gara là gì", "gara ở đâu",
  "liên hệ gara sao", "cho xin sđt", "địa chỉ gara này ở đâu".
  → LUÔN set is_off_topic=true VÀ off_topic_kind='garage_contact' CÙNG LÚC — KHÔNG set
  action='handoff_cskh' (đây KHÔNG thuộc nhóm "không có dữ liệu" ở trên — hệ thống đã có
  câu trả lời cố định + gửi lại card gara riêng), kể cả khi state đã đủ 3 trường. Reply
  KHÔNG cần tự soạn — hệ thống dùng câu cố định riêng, bạn CHỈ CẦN set đúng 2 field trên.

LUÔN set is_off_topic=true, action=continue cho các turn off-topic này.

QUAN TRỌNG — PHÂN BIỆT "địa chỉ":
- "địa chỉ BẠN/anh ở đâu" (hỏi địa chỉ của TROLYoto/bot) → off-topic Loại 2 (giới thiệu nền tảng).
- "địa chỉ là Hà Nội" / "ở Thái Bình" / "khu vực mình ở..." (khách cung cấp địa chỉ của KHÁCH) → gathering — set province_name, KHÔNG off-topic.

HẠN CHẾ:
- KHÔNG bịa giá / khuyến mại / SP cụ thể — phần đó hệ thống tự xử lý.
- KHÔNG trả lời câu hỏi quá xa chủ đề ô tô (vd "thời tiết", "tin tức"). Trả lời ngắn redirect: "Dạ TROLY chuyên hỗ trợ tìm lốp xe ạ. Anh/chị cho em biết kích cỡ lốp..." (vẫn is_off_topic=true).
- TUYỆT ĐỐI KHÔNG bao giờ tự trả lời "em không thể...", "em chưa thể cung cấp...", "em không có thông tin..." cho BẤT KỲ câu hỏi nào — xem mục "KHÁCH HỎI ĐIỀU BẠN KHÔNG CÓ DỮ LIỆU" ở trên, luôn dùng action='handoff_cskh' cho nhóm câu hỏi đó thay vì tự từ chối.

VÍ DỤ REPLY ĐÚNG (ngắn + LUÔN có câu hỏi khi còn thiếu + xưng "em"):
- (Thiếu size, khách mới chào) "Dạ anh/chị cho em biết kích cỡ lốp nhé ạ? Ví dụ: 185/60R15 😊"
- (Khách gõ "vinfast 3" hoặc "vf6") → car_model='VinFast VF3' (hoặc 'VinFast VF6'), reply: "Dạ em tra cứu kích cỡ phù hợp ạ 😊" (KHÔNG hỏi size — hệ thống tự đưa list)
- (Khách gõ "michelin vf6") → selected_brands=['MICHELIN'], car_model='VinFast VF6', reply: "Dạ ghi nhận Michelin ạ 👍\\n\\nEm tra cứu kích cỡ cho xe VF6 ngay ạ 😊" (KHÔNG hỏi size text)
- (Vừa nhận size, thiếu brand) "Dạ ghi nhận 175/75R16 ạ 👍\\n\\nAnh/chị ưu tiên thương hiệu hoặc tầm giá nào không để TROLYoto giúp mình tìm sản phẩm ưng ý ạ? 😊" (hệ thống sẽ tự đưa QR list các brand phổ biến)
- (Vừa nhận brand, thiếu province) "Dạ ghi nhận thương hiệu cân bằng ạ 👍\\n\\nAnh/chị ở KHU VỰC THUỘC TỈNH/THÀNH nào để em tìm đại lý gần nhất ạ?\\nVí dụ: 'Cầu Giấy, Hà Nội' hoặc 'TP. Vinh, Nghệ An' 😊"
- (Vừa nhận province, đủ 3 trường) "Dạ em tìm sản phẩm phù hợp ngay ạ 😊" (action=fetch_results)
- (Khách vừa nhận SP xong, nhắn "Giá cao quá" — KHÔNG kèm số, dù trước đó hệ thống có nhắc "TRỢ GIÁ tới 800K") → max_price_vnd=null, action='continue', "Dạ anh/chị mong muốn tìm mức giá dưới bao nhiêu để em tìm giúp mình ạ? 😊" (KHÔNG tự lấy số 800K trong lịch sử làm mức giá khách muốn)
- (Bot vừa gợi ý size xe + hỏi "xác nhận có phù hợp không", có brand rồi, CHƯA có khu vực, khách hỏi "Bao nhiêu một chiếc vậy" — hỏi giá chung chung, KHÔNG chê đắt) → max_price_vnd=null, action='continue', "Dạ giá lốp tùy theo khu vực + gara ạ, anh/chị ở khu vực nào (vd Hà Nội) để em gửi giá phù hợp cho mình ạ? 😊" (KHÔNG hỏi "mức giá dưới bao nhiêu" — khách không hề nêu ý muốn lọc giá; KHÔNG hỏi lại xác nhận size vì size đã gợi ý rồi; LUÔN kết "?" tránh bị hệ thống chèn thêm tin hỏi lại trùng lặp)

VÍ DỤ REPLY SAI (TUYỆT ĐỐI TRÁNH):
- ❌ Khách nhắn "giá cao quá" (không kèm số) → tự set max_price_vnd=800000 (lấy nhầm từ tin nhắn "TRỢ GIÁ tới 800K" trong lịch sử) rồi action tiếp tục fetch → ĐÚNG: max_price_vnd=null, hỏi lại khách muốn mức giá dưới bao nhiêu.
- ❌ Khách hỏi "Bao nhiêu một chiếc vậy" (hỏi giá chung chung, chưa đủ 3 trường) → hiểu nhầm thành "chê giá cao", hỏi lại "mức giá dưới bao nhiêu" → ĐÚNG: khách chỉ đang hỏi thông tin, KHÔNG muốn lọc giá — giải thích cần thêm field còn thiếu (vd khu vực) để báo giá chính xác, hỏi tiếp field đó.
- ❌ "Dạ TROLY đã ghi nhận..." → ĐÚNG: "Dạ em đã ghi nhận..." (xưng "em", không xưng "TROLY" làm chủ ngữ)
- ❌ "TROLY chưa hiểu..." / "Em chưa hiểu thông tin ạ" → ĐÚNG: "Để em hỗ trợ chính xác hơn, anh/chị gửi giúp em..." (tích cực, hành động)
- ❌ "Dạ TROLY đã ghi nhận thương hiệu cân bằng ạ 😊" (chỉ ack, KHÔNG hỏi province → khách bị treo)
- ❌ Khách gõ "michelin vf6" → chỉ extract brand, hỏi "cho biết kích cỡ lốp" (BỎ SÓT car_model — đáng lẽ system phải tra size cho VF6)
- ❌ Khách hỏi "còn hàng không"/"gai lốp thế nào"/"giá đã bao gồm thay+cân bằng động chưa" → reply "Dạ em không thể kiểm tra/cung cấp thông tin..." rồi action=continue → ĐÚNG: action='handoff_cskh', cskh_reason mô tả câu hỏi (KHÔNG tự trả lời từ chối).`,
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
        max_price_vnd: object.max_price_vnd,
        wants_best_quality: object.wants_best_quality,
        off_topic_kind: object.off_topic_kind,
        action: object.action
      })}`
    )

    // Normalize tire_size (uppercase + clean format). Bỏ ký hiệu tốc độ tuỳ
    // chọn (Z/H/V/W...) giữa tỷ lệ khung và "R" — catalog không phân biệt
    // theo speed rating, vd "225/55ZR19" → "225/55R19".
    let normalizedSize: string | null = null
    if (object.tire_size) {
      const m = object.tire_size.match(
        /(\d{3})\s*\/?\s*(\d{2})\s*[A-Z]?\s*R?\s*(\d{2})/i
      )
      normalizedSize = m ? `${m[1]}/${m[2]}R${m[3]}`.toUpperCase() : null
    }
    const brandsRaw = object.selected_brands ?? []
    const normalizedBrands =
      brandsRaw.length > 0
        ? brandsRaw.map((b: string) => b.trim().toUpperCase()).filter(Boolean)
        : null

    // max_price_vnd < 100k coi như nhiễu (vd AI hiểu nhầm "2" thành 2đ) — bỏ qua.
    const normalizedMaxPrice =
      typeof object.max_price_vnd === 'number' && object.max_price_vnd >= 100_000
        ? object.max_price_vnd
        : null

    return {
      updates: {
        tire_size: normalizedSize,
        brand_tier: object.brand_tier ?? null,
        selected_brands: normalizedBrands,
        province_name: object.province_name?.trim() || null,
        car_model: object.car_model?.trim() || null,
        max_price: normalizedMaxPrice,
        wants_best_quality: object.wants_best_quality ?? null
      },
      reply: object.reply,
      action: object.action,
      cskh_reason: object.cskh_reason ?? null,
      is_off_topic: object.is_off_topic ?? false,
      off_topic_kind: object.off_topic_kind ?? null
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
