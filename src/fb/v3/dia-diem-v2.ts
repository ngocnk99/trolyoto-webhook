/**
 * Địa điểm V2 cho luồng V3 (task dia-diem-tim-gara) — 1 lượt khách nói địa điểm:
 *   RPC dia_diem_resolve (DB, dùng chung web chat) → điểm + bán kính → newState.dia_diem
 *   + province_code / ward_code để các bước cũ (label, cskh_reason, nudge…) vẫn chạy.
 * Không còn "phường đại diện" cho tỉnh cũ (nguồn 32% ca gán phường giả, bao-cao-log-chat.md mục 3.2).
 *
 * Trả `null` khi RPC lỗi → caller chạy đường cũ (DB chưa chạy migration GĐ2 thì bot vẫn sống).
 */
import {
  DIA_DIEM_HOI_QUAN_MIN_GARA,
  danhDauKhachSuaLai,
  ghiDiaDiemLog,
  resolveDiaDiem,
  toDiaDiemState,
  type DiaDiemUngVien
} from '../diaDiem'
import { resolveProvinceSync } from '../db'
import type { DiaDiemState, SessionState } from '../types'

export interface KetQuaDiaDiemV2 {
  /** Nhiều nơi trùng tên → hỏi khách chọn (quick reply V3_DD:<dvhc_id>) */
  confirm?: DiaDiemState[]
  askAgainMsg?: string
  handoffReason?: string
}

const MAX_FAIL_PER_STEP = 2 // giống flow-handler: 1 lần hỏi lại, 2 lần CSKH

/** Áp kết quả đã chọn vào state (dùng cả khi khách bấm quick reply). */
export function apDiaDiem(newState: SessionState, dd: DiaDiemState): void {
  newState.dia_diem = dd
  newState.dia_diem_ung_vien = undefined
  newState.province_code = dd.tinh_moi_code ?? undefined
  newState.province_name = dd.ten
  // ward_code chỉ khi khách nói tới cấp xã (hoặc ghim) — cấp huyện/tỉnh KHÔNG gán phường đại diện.
  if ((dd.cap === 'xa' || dd.cap === 'ghim') && dd.xa_moi_code) {
    newState.ward_code = dd.xa_moi_code
    newState.ward_name = dd.ten
  } else {
    newState.ward_code = undefined
    newState.ward_name = undefined
  }
  newState.fail_location = 0
}

export async function xuLyDiaDiemV2(params: {
  sessionId: string
  userInput: string
  /** province_name do v3GatherTurn trích — chỉ dùng làm câu dự phòng / gợi ý tỉnh, không tin tuyệt đối */
  llmText: string | null
  state: SessionState
  newState: SessionState
}): Promise<KetQuaDiaDiemV2 | null> {
  const { sessionId, userInput, llmText, state, newState } = params
  const choQuan = !!state.dia_diem_cho_quan
  newState.dia_diem_cho_quan = false

  // Gợi ý tỉnh: đang chờ câu "quận/huyện nào" → tỉnh vừa hỏi; không thì tỉnh AI trích được (nếu khớp tỉnh hiện hành).
  const tinhGoiY =
    (choQuan ? state.dia_diem?.tinh_moi_code : null) ??
    (llmText ? resolveProvinceSync(llmText).code : null) ??
    null

  let ds = await resolveDiaDiem(userInput, tinhGoiY, 5)
  if (ds === null) return null
  if (ds.length === 0 && llmText && llmText.trim() && llmText !== userInput) {
    const ds2 = await resolveDiaDiem(llmText, tinhGoiY, 5)
    if (ds2 === null) return null
    ds = ds2
  }

  if (ds.length === 0) {
    // Đang chờ quận/huyện mà khách không nói được → tìm từ tâm tỉnh đã có, không tính là lỗi.
    if (choQuan && state.dia_diem) {
      console.log(`[V3 diaDiemV2] "${userInput}" không ra quận/huyện → giữ ${state.dia_diem.ten}`)
      return {}
    }
    const failCount = (newState.fail_location ?? 0) + 1
    newState.fail_location = failCount
    newState.province_name = userInput
    await ghiDiaDiemLog({ sessionId, rawText: userInput, ketQua: null })
    console.log(`[V3 diaDiemV2] không resolve được "${userInput}" → fail_location=${failCount}`)
    if (failCount >= MAX_FAIL_PER_STEP) {
      return { handoffReason: `Không xác định được khu vực từ "${userInput}" (${failCount} lần)` }
    }
    return {
      askAgainMsg:
        'Anh/chị giúp em xác nhận lại KHU VỰC (quận/huyện, tỉnh/thành) ạ?\nVí dụ: "Cầu Giấy, Hà Nội" hoặc "Quỳnh Phụ, Thái Bình cũ" 😊'
    }
  }

  const top = ds[0]
  // Khách trả lời "quận/huyện nào" bằng thứ còn thô hơn (lại 1 tên tỉnh) → giữ địa điểm cũ.
  if (choQuan && state.dia_diem && top.cap === 'tinh' && top.tinh_moi_code === state.dia_diem.tinh_moi_code) {
    return {}
  }

  if (top.can_hoi_lai) {
    // Xã cũ và xã mới cùng tên thường là CÙNG một nơi (cùng xã mới) → chỉ giữ 1 dòng.
    const daCo = new Set<string>()
    const confirm = ds
      .filter((u: DiaDiemUngVien) => u.score >= top.score - 1)
      .filter(u => {
        const khoa = u.xa_moi_code ?? `dvhc:${u.dvhc_id}`
        if (daCo.has(khoa)) return false
        daCo.add(khoa)
        return true
      })
      .slice(0, 5)
      .map(u => toDiaDiemState(u))
    if (confirm.length >= 2) {
      newState.dia_diem_ung_vien = confirm
      newState.province_name = userInput
      await ghiDiaDiemLog({ sessionId, rawText: userInput, ketQua: null, ungVien: ds, method: 'hoi_lai' })
      console.log(`[V3 diaDiemV2] "${userInput}" trùng tên ${confirm.length} nơi → hỏi khách chọn`)
      return { confirm }
    }
  }

  const dd = toDiaDiemState(top)
  if (state.dia_diem?.log_id && state.dia_diem.dvhc_id !== dd.dvhc_id) {
    await danhDauKhachSuaLai(state.dia_diem.log_id)
  }
  dd.log_id = await ghiDiaDiemLog({
    sessionId,
    rawText: userInput,
    ketQua: dd,
    ungVien: ds,
    method: top.method,
    score: top.score
  })
  apDiaDiem(newState, dd)
  console.log(
    `[V3 diaDiemV2] "${userInput}" → ${dd.ten} (${top.he}/${top.cap}, score=${top.score}, r=${dd.ban_kinh_m}m, ${top.so_gara_trong_tinh} gara trong tỉnh)`
  )

  // Chỉ nói tới tỉnh mà tỉnh nhiều gara → hỏi thêm 1 lần cho ra gara gần thật. Tỉnh ít gara → tìm luôn từ tâm tỉnh.
  if (top.cap === 'tinh' && top.so_gara_trong_tinh >= DIA_DIEM_HOI_QUAN_MIN_GARA && !state.dia_diem_da_hoi_quan) {
    newState.dia_diem_da_hoi_quan = true
    newState.dia_diem_cho_quan = true
    return {
      askAgainMsg: `Anh/chị ở quận/huyện nào của ${top.ten_hien_thi.replace(/^(Thành phố|Tỉnh) /, '')} ạ? (tên cũ cũng được, vd "Cầu Giấy", "Quận 7") để em tìm gara gần mình nhất 😊`
    }
  }
  return {}
}
