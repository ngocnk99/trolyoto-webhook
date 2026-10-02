/**
 * Địa điểm V2 (task dia-diem-tim-gara) — resolve câu khách nói ra ĐIỂM + BÁN KÍNH bằng RPC dùng chung với
 * web chat (DB: dia_diem_resolve / dia_diem_tu_toa_do), ghi dia_diem_log mỗi lượt để đo tỷ lệ đúng.
 *
 * Bật bằng env DIA_DIEM_V2_ENABLED=true. Tắt (mặc định) → bot chạy đường cũ (MERGED_PROVINCE_ALIASES +
 * ward.json + lọc ward_code/province_code). RPC lỗi (DB chưa có migration GĐ2) → hàm trả null để caller
 * quay về đường cũ, không chặn hội thoại.
 */
import { supabaseAmin } from './supabase'
import type { DiaDiemState } from './types'

export const DIA_DIEM_V2_ENABLED = process.env.DIA_DIEM_V2_ENABLED === 'true'
/** Tỉnh có từ ngần này gara trở lên mà khách chỉ nói tỉnh → hỏi thêm 1 câu "quận/huyện nào". */
export const DIA_DIEM_HOI_QUAN_MIN_GARA = Number(process.env.DIA_DIEM_HOI_QUAN_MIN_GARA ?? 10)

export interface DiaDiemUngVien {
  dvhc_id: number
  he: 'moi' | 'cu'
  cap: 'tinh' | 'huyen' | 'xa'
  loai: string
  code: string
  ten_hien_thi: string
  tinh_moi_code: string
  xa_moi_code: string | null
  lat: number
  lng: number
  ban_kinh_m: number
  score: number
  method: string
  khop: string | null
  so_gara_trong_tinh: number
  can_hoi_lai: boolean
}

/** Ứng viên theo thứ tự điểm. `null` = RPC lỗi (caller dùng đường cũ). */
export async function resolveDiaDiem(
  text: string,
  tinhGoiY: string | null,
  limit = 5
): Promise<DiaDiemUngVien[] | null> {
  const { data, error } = await supabaseAmin.rpc('dia_diem_resolve', {
    p_text: text,
    p_tinh_goi_y: tinhGoiY,
    p_limit: limit
  })
  if (error) {
    console.error('[diaDiem] dia_diem_resolve error:', error.message)
    return null
  }
  return (data ?? []) as DiaDiemUngVien[]
}

/** Khách ghim vị trí → xã mới gần nhất (giữ toạ độ ghim). `null` = lỗi / ngoài VN. */
export async function diaDiemTuToaDo(lat: number, lng: number): Promise<DiaDiemUngVien | null> {
  const { data, error } = await supabaseAmin.rpc('dia_diem_tu_toa_do', { p_lat: lat, p_lng: lng })
  if (error) {
    console.error('[diaDiem] dia_diem_tu_toa_do error:', error.message)
    return null
  }
  return ((data ?? []) as DiaDiemUngVien[])[0] ?? null
}

export function toDiaDiemState(u: DiaDiemUngVien, ghim = false): DiaDiemState {
  return {
    dvhc_id: u.dvhc_id,
    cap: ghim ? 'ghim' : u.cap,
    he: u.he,
    ten: ghim ? `vị trí đã ghim (gần ${u.ten_hien_thi})` : u.ten_hien_thi,
    lat: u.lat,
    lng: u.lng,
    ban_kinh_m: u.ban_kinh_m,
    tinh_moi_code: u.tinh_moi_code,
    xa_moi_code: u.xa_moi_code,
    so_gara_trong_tinh: u.so_gara_trong_tinh
  }
}

/** Ghi 1 lượt resolve vào dia_diem_log; trả id để cập nhật gara đã đưa ra. Lỗi log không chặn hội thoại. */
export async function ghiDiaDiemLog(params: {
  sessionId: string
  rawText: string
  ketQua: DiaDiemState | null
  ungVien?: DiaDiemUngVien[]
  method?: string
  score?: number | null
}): Promise<number | null> {
  const { sessionId, rawText, ketQua, ungVien, method, score } = params
  const { data, error } = await supabaseAmin
    .from('dia_diem_log')
    .insert({
      kenh: 'fb',
      session_id: sessionId,
      raw_text: rawText.slice(0, 500),
      cap_ket_qua: ketQua ? ketQua.cap : 'khong_ro',
      he: ketQua?.he ?? null,
      dvhc_id: ketQua?.dvhc_id ?? null,
      method: method ?? null,
      score: score ?? null,
      diem: ketQua ? `SRID=4326;POINT(${ketQua.lng} ${ketQua.lat})` : null,
      ban_kinh_m: ketQua?.ban_kinh_m ?? null,
      ung_vien: ungVien?.slice(0, 5).map(u => ({ id: u.dvhc_id, ten: u.ten_hien_thi, score: u.score, khop: u.khop })) ?? null
    })
    .select('id')
    .single()
  if (error) {
    console.error('[diaDiem] ghi dia_diem_log error:', error.message)
    return null
  }
  return data?.id ?? null
}

/** Sau khi ra card: lưu gara đã đưa + khoảng cách gần nhất vào dòng log của lượt resolve. */
export async function capNhatDiaDiemLog(
  logId: number | null | undefined,
  garageCodes: string[],
  ganNhatKm: number | null
): Promise<void> {
  if (!logId) return
  const { error } = await supabaseAmin
    .from('dia_diem_log')
    .update({ garage_codes: garageCodes, gan_nhat_km: ganNhatKm })
    .eq('id', logId)
  if (error) console.error('[diaDiem] cập nhật dia_diem_log error:', error.message)
}

/** Khách đổi địa điểm trong cùng phiên → đánh dấu lần resolve trước là "khách sửa lại" (đầu vào cron alias GĐ3). */
export async function danhDauKhachSuaLai(logId: number | null | undefined): Promise<void> {
  if (!logId) return
  const { error } = await supabaseAmin.from('dia_diem_log').update({ khach_sua_lai: true }).eq('id', logId)
  if (error) console.error('[diaDiem] đánh dấu khach_sua_lai error:', error.message)
}

/** Ngưỡng coi kết quả là "khu vực khác": gara gần nhất ngoài tỉnh khách VÀ xa hơn ngần này km. */
export const DIA_DIEM_XA_KM = Number(process.env.DIA_DIEM_XA_KM ?? 20)
