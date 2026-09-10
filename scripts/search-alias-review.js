/**
 * Task 86eyuw542 GĐ8 — chạy AI duyệt alias pending tại chỗ (mặc định DRY-RUN).
 *   npm run build && node scripts/search-alias-review.js          # dry-run, không ghi DB
 *   npm run build && node scripts/search-alias-review.js --write  # ghi verdict vào search_alias
 * Đọc env từ .env (dotenv). Cần OPENAI_API_KEY + SUPABASE_SERVICE_ROLE_KEY.
 */
require('dotenv/config')
const { runAliasReview } = require('../dist/search/alias-review-cron')

const write = process.argv.includes('--write')
runAliasReview({ dryRun: !write })
  .then(r => {
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.error ? 1 : 0)
  })
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
