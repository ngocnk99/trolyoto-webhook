import { createClient } from '@supabase/supabase-js'

/**
 * Supabase admin client (service-role) — bypass RLS để query mọi bảng.
 * KHÔNG expose ra client. Chỉ dùng trong server-side webhook handler.
 */
export const supabaseAmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: { persistSession: false }
  }
)
