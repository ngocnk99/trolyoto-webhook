#!/usr/bin/env node
/**
 * Test AI vision đọc kích cỡ + thương hiệu lốp — REPLICATE đúng prompt + model
 * bot V3 dùng trong ai-helper.ts.
 *
 *  Usage:
 *    node scripts/test-tire-image.js https://example.com/tire.jpg
 *    node scripts/test-tire-image.js ./path/to/local-tire.jpg
 *    node scripts/test-tire-image.js https://...  gpt-4o-mini  # override model
 *
 *  Cần env:
 *    OPENAI_API_KEY     — key có quyền gọi /v1/chat/completions
 *    VISION_MODEL       — optional, default 'gpt-4o' (gpt-4o-mini rẻ hơn nhưng kém)
 */

require('dotenv').config()
const fs = require('fs')

const input = 'C:\\Users\\Admin\\Downloads\\AA.jpg'
const modelOverride = process.argv[3]
if (!input) {
  console.error(
    'Usage: node scripts/test-tire-image.js <url-or-filepath> [model]'
  )
  console.error('  ví dụ: node scripts/test-tire-image.js ./tire.jpg')
  console.error(
    '  ví dụ: node scripts/test-tire-image.js https://... gpt-4o-mini'
  )
  process.exit(1)
}

const OPENAI_KEY = process.env.OPENAI_API_KEY
if (!OPENAI_KEY) {
  console.error('Missing OPENAI_API_KEY trong .env')
  process.exit(1)
}

const VISION_MODEL = modelOverride || process.env.VISION_MODEL || 'gpt-4o'

// ─── Prompt — copy y nguyên từ ai-helper.ts analyzeTireImage ───────────
const SYSTEM_PROMPT = [
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
  'OUTPUT JSON:',
  '- tire_size: chuỗi đúng format "XXX/YYRZZ" (chỉ khi tự tin tuyệt đối), null nếu không rõ',
  '- brand: tên hãng HOA, null nếu không rõ',
  '- confidence: 0-1, < 0.7 nếu có nghi ngờ',
  '- raw_text: chuỗi text bạn ĐỌC được trên thành lốp (kể cả không đúng format) — để dev debug khi bot sai'
].join('\n')

const USER_TEXT =
  'Đọc kích cỡ + thương hiệu trên lốp này. Lưu ý ảnh có thể bị xoay hoặc ngược — đọc kỹ từng chữ số.'

// ─── Load image (URL hoặc file local) ──────────────────────────────────
async function loadImage(input) {
  if (input.startsWith('http://') || input.startsWith('https://')) {
    console.log(`Downloading image from URL: ${input.slice(0, 80)}...`)
    const res = await fetch(input, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    if (!res.ok) {
      throw new Error(`Fetch failed: ${res.status} ${res.statusText}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const mime = res.headers.get('content-type') || 'image/jpeg'
    console.log(`Downloaded ${buf.length} bytes, mime=${mime}`)
    return { bytes: buf, mime }
  }
  // Local file
  console.log(`Reading local file: ${input}`)
  const buf = fs.readFileSync(input)
  const ext = input.toLowerCase().split('.').pop() || 'jpg'
  const mime =
    ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
  console.log(`Read ${buf.length} bytes, mime=${mime}`)
  return { bytes: buf, mime }
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════════')
  console.log(`  Test AI vision đọc lốp`)
  console.log(`  model: ${VISION_MODEL}`)
  console.log('══════════════════════════════════════════════════════════\n')

  const { bytes, mime } = await loadImage(input)
  const base64 = bytes.toString('base64')
  const dataUrl = `data:${mime};base64,${base64}`

  const body = {
    model: VISION_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: USER_TEXT },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ],
    response_format: { type: 'json_object' },
    max_tokens: 300,
    temperature: 0
  }

  console.log('Sending request to OpenAI...')
  const t0 = Date.now()
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  const elapsed = Date.now() - t0

  if (!res.ok) {
    const errText = await res.text()
    console.error(`HTTP ${res.status} ${res.statusText}`)
    console.error(errText)
    process.exit(1)
  }

  const json = await res.json()
  const content = json.choices?.[0]?.message?.content || ''
  console.log(`\nElapsed: ${elapsed}ms`)
  console.log(
    `Tokens used: input=${json.usage?.prompt_tokens} output=${json.usage?.completion_tokens} total=${json.usage?.total_tokens}`
  )
  console.log()

  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    console.log('Raw response (không parse được JSON):')
    console.log(content)
    process.exit(1)
  }

  console.log('──────── KẾT QUẢ AI ────────')
  console.log(`  tire_size:  ${parsed.tire_size ?? '(null)'}`)
  console.log(`  brand:      ${parsed.brand ?? '(null)'}`)
  console.log(`  confidence: ${parsed.confidence ?? '?'}`)
  console.log(`  raw_text:   ${parsed.raw_text ?? '(null)'}`)
  console.log()

  // Áp ngưỡng confidence như bot làm
  if (parsed.confidence !== undefined && parsed.confidence < 0.7) {
    console.log(
      `⚠️  confidence ${parsed.confidence} < 0.7 → bot sẽ REJECT, hỏi khách nhập tay`
    )
  } else if (parsed.tire_size) {
    // Normalize size pattern
    const m = String(parsed.tire_size).match(
      /(\d{3})\s*\/?\s*(\d{2})\s*R?\s*(\d{2})/i
    )
    const normalized = m ? `${m[1]}/${m[2]}R${m[3]}` : null
    console.log(
      `✓ size sau normalize: ${normalized ?? '(không match XXX/YYRZZ)'}`
    )
  }
  console.log('\n══════════════════════════════════════════════════════════\n')
}

main().catch(e => {
  console.error('FATAL:', e?.message ?? e)
  process.exit(1)
})
