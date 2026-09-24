/**
 * Probe: @ai-sdk/openai@0.0.9 + ai@3.1.5 (bản 2024) có gọi được gpt-5.6-luna /
 * gpt-6-luna qua `generateObject` + zod schema không — đúng cách bot đang gọi.
 *
 * Kiểm tra thêm: SDK có tự gửi `temperature` (2 model mới từ chối mọi giá trị
 * khác 1) và có chèn được `reasoning_effort` qua patch fetch không.
 *
 *   cd fb-webhook-server
 *   npx ts-node --transpile-only -r dotenv/config scripts/model-bench/sdk-probe.ts
 */
import { openai } from '@ai-sdk/openai'
import { generateObject } from 'ai'
import { z } from 'zod'

const MODELS = ['gpt-4o-mini', 'gpt-5.6-luna', 'gpt-6-luna']

/** Bản ghi body request cuối cùng + usage response, để biết SDK thực sự gửi gì. */
type Seen = { body?: Record<string, unknown>; usage?: Record<string, unknown> }
const seen: Seen = {}

/** Patch fetch: xem SDK gửi gì, đồng thời thử chèn reasoning_effort / bỏ temperature. */
function patchFetch(opts: { effort?: string; stripTemperature?: boolean }): void {
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : input?.url
    if (url?.includes('api.openai.com') && init?.body) {
      const body = JSON.parse(init.body as string)
      if (opts.stripTemperature) delete body.temperature
      if (opts.effort) body.reasoning_effort = opts.effort
      seen.body = body
      init = { ...init, body: JSON.stringify(body) }
    }
    const res = await orig(input, init)
    if (url?.includes('api.openai.com')) {
      const clone = res.clone()
      try {
        const j: any = await clone.json()
        seen.usage = j.usage
      } catch {
        /* stream hoặc lỗi parse — bỏ qua */
      }
    }
    return res
  }) as typeof fetch
}

const schema = z.object({
  tire_size: z.string().nullish().describe('Kích cỡ lốp XXX/YYRZZ'),
  selected_brands: z.array(z.string()).nullish().describe('Hãng lốp HOA'),
  max_price: z.number().nullish().describe('Giá tối đa VND'),
  reply: z.string().describe('Câu trả lời cho khách')
})

async function probe(
  model: string,
  opts: { effort?: string; stripTemperature?: boolean } = {}
): Promise<void> {
  seen.body = undefined
  seen.usage = undefined
  patchFetch(opts)
  const label = `${model}${opts.effort ? ` [effort=${opts.effort}]` : ''}`
  const t0 = Date.now()
  try {
    const { object } = await generateObject({
      model: openai(model) as any,
      schema,
      system:
        'Bạn là trợ lý bán lốp. Trích kích cỡ, hãng, giá tối đa từ tin khách. Không có thì null.',
      prompt: 'KHÁCH VỪA NHẮN: "275/35r19 2 quả, hankook"'
    })
    const ms = Date.now() - t0
    const u = seen.usage as any
    console.log(
      `OK   ${label.padEnd(34)} ${String(ms).padStart(5)}ms | mode=${modeOf()} | in=${u?.prompt_tokens} out=${u?.completion_tokens} reasoning=${u?.completion_tokens_details?.reasoning_tokens ?? 0} | temp=${JSON.stringify(seen.body?.temperature)}`
    )
    console.log(`     → ${JSON.stringify(object)}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.log(
      `FAIL ${label.padEnd(34)} ${String(Date.now() - t0).padStart(5)}ms | mode=${modeOf()} | temp=${JSON.stringify(seen.body?.temperature)}`
    )
    console.log(`     → ${msg.replace(/\s+/g, ' ').slice(0, 260)}`)
  }
}

/** SDK 0.0.9 có thể dùng tool-calling hoặc json mode để ép schema — xem body. */
function modeOf(): string {
  const b = seen.body as any
  if (!b) return '?'
  if (b.tools) return 'tools'
  if (b.response_format) return `response_format:${b.response_format?.type}`
  if (b.functions) return 'functions'
  return 'plain'
}

async function main(): Promise<void> {
  for (const m of MODELS) {
    await probe(m)
    if (m !== 'gpt-4o-mini') {
      await probe(m, { effort: 'none', stripTemperature: true })
    }
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
