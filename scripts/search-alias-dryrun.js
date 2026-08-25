/**
 * Task search-suggest-v2 GĐ3 — chạy mining alias tại chỗ (mặc định DRY-RUN, không ghi DB).
 *   npm run build && node scripts/search-alias-dryrun.js          # dry-run
 *   npm run build && node scripts/search-alias-dryrun.js --write  # ghi search_alias + watermark
 * Đọc env từ .env (dotenv). Cần OPENAI_API_KEY + SUPABASE_SERVICE_ROLE_KEY.
 */
require('dotenv/config')
const { runAliasMining } = require('../dist/search/search-alias-cron')

const write = process.argv.includes('--write')
runAliasMining({ dryRun: !write })
  .then(r => {
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.error ? 1 : 0)
  })
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
