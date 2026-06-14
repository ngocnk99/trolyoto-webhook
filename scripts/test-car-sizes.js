#!/usr/bin/env node
/**
 * Test flow lookup size theo tên xe — REPLICATE đúng logic bot V3 dùng.
 *
 *  Pipeline:
 *    [free text khách nhập]
 *      → AI (gpt-4o-mini) normalize → "VinFast VF8 Plus" + cartype canonical
 *      → toCartypeCodes() sinh variants
 *      → Replace [_-] → space + dedupe → keywords
 *      → Mỗi keyword prefix "LOP " call RPC search_products_by_tag
 *      → Log products + sizes
 *
 *  Usage:
 *    node scripts/test-car-sizes.js "vf8 plus"
 *    node scripts/test-car-sizes.js "Mazda CX-5"
 *    node scripts/test-car-sizes.js "vios 2020"
 *    node scripts/test-car-sizes.js "tôi đi xe acent"   # AI hiểu typo
 *
 *  Cần env trong fb-webhook-server/.env:
 *    NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL
 *    SUPABASE_SERVICE_ROLE_KEY
 *    OPENAI_API_KEY
 */

require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')

const rawInput = process.argv.slice(2).join(' ').trim()
if (!rawInput) {
  console.error(
    'Usage: node scripts/test-car-sizes.js "<car name or free text>"'
  )
  console.error('  ví dụ: node scripts/test-car-sizes.js "vf8 plus"')
  console.error('  ví dụ: node scripts/test-car-sizes.js "tôi đi xe acent"')
  process.exit(1)
}

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
const OPENAI_KEY = process.env.OPENAI_API_KEY
const TEXT_MODEL = process.env.AI_MODEL || 'gpt-4o-mini'

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    'Missing SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY trong .env'
  )
  process.exit(1)
}
if (!OPENAI_KEY) {
  console.error('Missing OPENAI_API_KEY trong .env')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
})

// ─── AI: free text → canonical car name + cartype code ────────────────
async function normalizeCarWithAI(input) {
  const systemPrompt = [
    'Bạn là trợ lý phân loại xe ô tô tại Việt Nam.',
    '',
    'Nhiệm vụ: từ chuỗi text khách nhập (có thể typo, viết tắt, không dấu, không có hãng), trích ra:',
    '  - car_full_name: tên chuẩn dạng "<Hãng> <Model>" hoặc "<Hãng> <Model> <Phiên bản>"',
    '    Ví dụ: "vf8 plus" → "VinFast VF8 Plus"',
    '            "cx5"    → "Mazda CX-5"',
    '            "vios"   → "Toyota Vios"',
    '            "acent"  → "Hyundai Accent"',
    '            "i10"    → "Hyundai Grand i10"',
    '            "spark"  → "Chevrolet Spark"',
    '            "innova" → "Toyota Innova"',
    '            "wigo"   → "Toyota Wigo"',
    '            "morning"→ "Kia Morning"',
    '            "santafe"→ "Hyundai Santa Fe"',
    '            "fortuner"→"Toyota Fortuner"',
    '            "everest"→ "Ford Everest"',
    '            "x5"     → "BMW X5"',
    '            "glc"    → "Mercedes-Benz GLC"',
    '',
    '  - cartype_code: tên chuẩn dạng UPPERCASE, không dấu, dùng underscore:',
    '    "VinFast VF8 Plus" → "VINFAST_VF8_PLUS"',
    '    "Mazda CX-5"       → "MAZDA_CX5"',
    '    "Hyundai Accent"   → "HYUNDAI_ACCENT"',
    '',
    '  - confidence: 0-1, < 0.7 nếu không chắc xe nào',
    '',
    'Nếu input KHÔNG nhận ra là xe ô tô (vd "ấdfsdf") → car_full_name=null, cartype_code=null, confidence<0.3.',
    '',
    'Trả về JSON: {"car_full_name": "...", "cartype_code": "...", "confidence": 0.95}'
  ].join('\n')

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: TEXT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Khách nhập: "${input}"` }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 200,
      temperature: 0
    })
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`OpenAI ${res.status}: ${t}`)
  }
  const json = await res.json()
  const usage = json.usage || {}
  const content = json.choices?.[0]?.message?.content || '{}'
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    parsed = { car_full_name: null, cartype_code: null, confidence: 0 }
  }
  return { ...parsed, _usage: usage, _raw: content }
}

// ─── Replicate toCartypeCodes ──────────────────────────────────────────
function toCartypeCodes(carName) {
  const normalized = carName
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^A-Z0-9\s_-]/g, '')
    .trim()
  if (!normalized) return []
  const tokens = normalized.split(/[\s_-]+/).filter(Boolean)
  if (tokens.length === 0) return []
  const variants = new Set()
  variants.add(tokens.join('_'))
  variants.add(tokens.join(''))
  variants.add(tokens.join('-'))
  variants.add(normalized.replace(/\s+/g, '_'))
  variants.add(normalized.replace(/\s+/g, '-'))
  variants.add(normalized.replace(/[\s_-]+/g, ''))
  // Gộp 2 token cuối nếu cuối là số/ký tự ngắn (vd "CX 5" → "CX5")
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1]
    if (/^[A-Z0-9]{1,3}$/.test(last)) {
      const merged = [...tokens.slice(0, -2), tokens[tokens.length - 2] + last]
      variants.add(merged.join('_'))
      variants.add(merged.join(''))
      variants.add(merged.join('-'))
    }
  }
  return Array.from(variants)
}

// ─── Normalize size từ DB key (185_65R15 → 185/65R15) ───────────────────
function fromSizeKey(s) {
  if (!s) return ''
  return s.replace(/_/g, '/').toUpperCase()
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════════')
  console.log(`  Test lookup size — input: "${rawInput}"`)
  console.log(`  AI text model: ${TEXT_MODEL}`)
  console.log('══════════════════════════════════════════════════════════\n')

  // ── Bước 1: AI normalize free text → tên xe chuẩn + cartype code ──
  console.log('──> [1] AI normalize input...')
  const t0 = Date.now()
  const ai = await normalizeCarWithAI(rawInput)
  const aiMs = Date.now() - t0
  console.log(
    `    elapsed: ${aiMs}ms | tokens: in=${ai._usage?.prompt_tokens} out=${ai._usage?.completion_tokens}`
  )
  console.log(`    AI car_full_name: ${ai.car_full_name ?? '(null)'}`)
  console.log(`    AI cartype_code:  ${ai.cartype_code ?? '(null)'}`)
  console.log(`    AI confidence:    ${ai.confidence ?? '?'}`)
  console.log()

  if (
    !ai.car_full_name ||
    (ai.confidence !== undefined && ai.confidence < 0.5)
  ) {
    console.error(
      `❌ AI không nhận diện được xe (confidence ${ai.confidence ?? '?'} thấp). Dừng.`
    )
    process.exit(1)
  }

  // Dùng AI car_full_name làm input chính. Cộng thêm cartype_code AI suggest
  // để cover trường hợp toCartypeCodes có biến thể chưa hoàn hảo.
  const carName = ai.car_full_name
  console.log(`──> [2] sinh cartype variants từ "${carName}"`)
  const codes = toCartypeCodes(carName)
  if (ai.cartype_code && !codes.includes(ai.cartype_code)) {
    codes.push(ai.cartype_code) // thêm code AI gợi ý nếu chưa có
  }
  console.log('    cartype codes:', codes)

  const keywords = Array.from(
    new Set(codes.map(c => c.replace(/[_-]+/g, ' ').trim()).filter(Boolean))
  )
  console.log('    search keywords (sau dedupe):', keywords)
  console.log()

  if (keywords.length === 0) {
    console.error('Không sinh được keyword nào → exit')
    process.exit(1)
  }

  console.log('──> [3] Gọi RPC search_products_by_tag cho từng keyword')
  const allProducts = new Map() // id → { size, qty, source_kw }
  for (const kw of keywords) {
    const searchKw = `${kw}`
    console.log(`    RPC search_products_by_tag(keywords="${searchKw}")`)
    const { data, error } = await supabase.rpc('search_products_by_tag', {
      keywords: searchKw,
      category: ['LOP'],
      sort_by: 'quantitysold',
      sort_direction: 'desc',
      page_number: 1,
      page_size: 50
    })
    if (error) {
      console.error(`      ERROR:`, error.message)
      continue
    }
    const first = Array.isArray(data) ? data[0] : null
    const products = (first && first.products) || []
    console.log(`      → ${products.length} products`)
    for (const p of products) {
      console.log('size', p.SIZE)
      if (allProducts.has(p.id)) continue
      allProducts.set(p.id, {
        size: fromSizeKey(p.SIZE),
        qty: Number(p.quantitysold ?? 0),
        name: p.name,
        source_kw: searchKw
      })
    }
  }

  // Group theo size
  const sizeMap = new Map()
  for (const [, v] of allProducts) {
    if (!v.size) continue
    sizeMap.set(v.size, (sizeMap.get(v.size) ?? 0) + v.qty)
  }
  const sizesSorted = Array.from(sizeMap.entries()).sort((a, b) => b[1] - a[1])

  console.log('\n──────── KẾT QUẢ ────────')
  console.log(`Total products (dedup): ${allProducts.size}`)
  console.log(`Total unique sizes:     ${sizesSorted.length}`)
  console.log()
  console.log('Sizes theo quantitysold desc (top 10):')
  for (const [size, qty] of sizesSorted.slice(0, 10)) {
    console.log(`  ${size.padEnd(15)} qty=${qty}`)
  }
  console.log()
  console.log('Sample products (top 5):')
  let i = 0
  for (const [id, v] of allProducts) {
    if (i++ >= 5) break
    console.log(
      `  [${i}] ${v.size.padEnd(15)} qty=${String(v.qty).padStart(4)} | ${v.name?.slice(0, 60) ?? '(no name)'}`
    )
  }
  console.log('\n══════════════════════════════════════════════════════════\n')
}

main().catch(e => {
  console.error('FATAL:', e)
  process.exit(1)
})
