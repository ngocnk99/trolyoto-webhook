# TROLYoto FB Webhook Server

Facebook Messenger webhook bot cho TROLYoto — **NestJS standalone**, deploy lên **Render** (always-on Node process, không cold start).

Tách ra từ project Next.js chính để tránh latency cao do Vercel serverless cold start.

---

## 1. Endpoint duy nhất

`GET/POST /api/webhook/facebook` — Facebook Messenger webhook (verify + nhận events).

Phụ:
- `GET /healthz` — health check cho Render (`healthCheckPath`)
- `GET /` — service status

## 2. Cấu trúc

```
src/
├── main.ts                      bootstrap NestJS, bật rawBody
├── app.module.ts                root module
├── health.controller.ts         /healthz + /
├── province.json                63 tỉnh VN (dùng resolveProvince)
└── fb/
    ├── webhook.controller.ts    GET verify + POST events
    ├── flow-handler.ts          State machine: welcome → tire size → brand → results → garages
    ├── session.ts               Supabase CRUD `fb_messenger_sessions`
    ├── client.ts                FB Graph API: sendMessage / sendTypingOn / markSeen
    ├── ai-helper.ts             OpenAI: extractTireSize, getTireSizesForCar, ...
    ├── db.ts                    Supabase queries: fetchTireCatalog, fetchGarageOffers, resolveProvince
    ├── supabase.ts              supabaseAmin (service-role client)
    └── types.ts                 Types: MessengerEvent, SessionState, QuickReply, ...
```

## 3. Local dev

```bash
# 1. Cài deps
npm install

# 2. Copy env
cp .env.example .env
# → điền FB_PAGE_ACCESS_TOKEN, FB_APP_SECRET, FB_WEBHOOK_VERIFY_TOKEN, FACEBOOK_PAGE_ID,
#   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, ...

# 3. Run dev (auto-reload)
npm run start:dev

# Local URL: http://localhost:3000/api/webhook/facebook
# Dùng ngrok/cloudflared expose ra public cho FB test:
#   ngrok http 3000
```

## 4. Deploy lên Render

### Cách 1: Render Blueprint (1-click)

1. Push project lên GitHub repo (có thể là sub-folder trong mono-repo — Render đọc `rootDir` từ `render.yaml`).
2. Trên Render dashboard → **New + → Blueprint** → chọn repo.
3. Render đọc `render.yaml`, hỏi điền các env var (mark `sync: false` → cần điền thủ công).
4. Deploy.

### Cách 2: Thủ công (Web Service)

1. **New + → Web Service** → chọn repo.
2. Cấu hình:
   - **Root Directory**: `fb-webhook-server` (nếu mono-repo); hoặc bỏ trống nếu repo riêng
   - **Runtime**: Node
   - **Region**: Singapore (gần Việt Nam)
   - **Plan**: Starter ($7/mo, always-on) ← khuyến nghị cho webhook
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm run start:prod`
   - **Health Check Path**: `/healthz`
3. Environment Variables: điền các giá trị từ `.env.example`.
4. Deploy.

### ⚠️ Tránh Free plan

Free plan **sleep sau 15 phút idle** → request đầu sau khi sleep mất 30-60s khởi động → **FB sẽ retry và treo bot**. **KHÔNG dùng Free plan cho production**.

## 5. Cấu hình Facebook

Sau khi có URL Render (vd `https://trolyoto-fb-webhook.onrender.com`):

1. **Meta Developer Console** → App → Messenger → Settings → **Webhooks** → Edit.
2. **Callback URL**: `https://trolyoto-fb-webhook.onrender.com/api/webhook/facebook`
3. **Verify Token**: khớp với `FB_WEBHOOK_VERIFY_TOKEN` trong env.
4. **Subscription fields**: tick `messages`, `messaging_postbacks`, `messaging_optins`, `messaging_referrals`, `message_echoes` (CSKH takeover detection).
5. **Subscribe Page** với Page TROLYoto.

## 6. So sánh với Vercel serverless

| Khoản                 | Vercel Hobby SGP | Render Starter SGP |
| --------------------- | ---------------- | ------------------- |
| Cold start (idle)     | 500ms - 2s       | 0ms (always-on)     |
| 1 reply latency       | ~300-600ms       | ~200-300ms          |
| 5-reply flow latency  | ~1.5-3s          | ~1-1.5s             |
| Max execution         | 10s (Hobby)      | Unlimited           |
| Cost                  | Free (limits)    | $7/mo               |
| Background processing | Tricky (waitUntil)| Native (process alive) |

→ Render Starter **trả tin nhắn nhanh + ổn định hơn** Vercel cho use case này.

## 7. Migration từ Next.js project gốc

Webhook route cũ `src/pages/api/webhook/facebook.ts` trong project Next.js TROLYoto-buyer:

1. **Vẫn giữ tạm** trong project Next.js để fallback nếu Render gặp sự cố.
2. Khi Render stable → **đổi Callback URL trên Meta** sang URL Render.
3. Sau khi verify Render hoạt động OK → có thể xóa route cũ trong project Next.js để tránh nhầm.

Bảng `fb_messenger_sessions` trên Supabase **dùng chung** giữa 2 môi trường (cả 2 đều query cùng DB) — không cần migrate data.

## 8. Lưu ý vận hành

- **Log**: Render dashboard → service → Logs. Filter `[FB]` để xem flow.
- **Restart**: dashboard → Manual Deploy → Deploy latest commit. Hoặc push commit mới (autoDeploy bật).
- **Scale**: nâng plan Standard nếu traffic tăng (nhiều CPU + RAM).
- **Cron cleanup session** (xoá session > 7 ngày): hiện chưa có; có thể setup Render Cron Job riêng gọi `clearOldSessions()`.
- **Monitoring**: thêm Sentry / Logtail nếu cần observability nâng cao.

## 9. Roadmap

- [ ] Cron job xoá session cũ (gọi `clearOldSessions()` mỗi ngày)
- [ ] Sentry/Logtail integration
- [ ] Multi-page support (hiện chỉ filter 1 `FACEBOOK_PAGE_ID`)
- [ ] Batch `appendConversationLog` → giảm Supabase round-trip
