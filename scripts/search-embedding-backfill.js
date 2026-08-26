/**
 * Task search-suggest-v2 GĐ4 — backfill embedding tại chỗ / probe semantic.
 *   npm run build && node scripts/search-embedding-backfill.js            # backfill (ghi DB)
 *   npm run build && node scripts/search-embedding-backfill.js --dry-run  # chỉ gọi OpenAI, không ghi
 *   npm run build && node scripts/search-embedding-backfill.js --probe "kêu cọt kẹt khi phanh"
 * Đọc env từ .env (dotenv). Cần OPENAI_API_KEY + SUPABASE_SERVICE_ROLE_KEY.
 */
require('dotenv/config')
const { runEmbeddingBackfill, embedQuery } = require('../dist/search/embedding-cron')
const { supabaseAmin } = require('../dist/fb/supabase')

async function main() {
  const args = process.argv.slice(2)
  const probeIdx = args.indexOf('--probe')
  if (probeIdx >= 0) {
    const q = args.slice(probeIdx + 1).join(' ').trim()
    if (!q) throw new Error('--probe cần câu hỏi')
    const t0 = Date.now()
    const vec = await embedQuery(q)
    const t1 = Date.now()
    const { data, error } = await supabaseAmin.rpc('search_suggest_semantic', {
      query_embedding: JSON.stringify(vec),
      facets: null,
      max_results: 8,
      min_similarity: 0.3
    })
    if (error) throw new Error(error.message)
    console.log(`"${q}"  embed ${t1 - t0}ms, rpc ${Date.now() - t1}ms`)
    for (const r of data ?? []) console.log(`  ${r.sim.toFixed(3)}  ${r.display}  [${r.facet}]`)
    return
  }
  const r = await runEmbeddingBackfill({ dryRun: args.includes('--dry-run') })
  console.log(JSON.stringify(r, null, 2))
  if (r.error) process.exit(1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
