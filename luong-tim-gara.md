# Luồng ưu tiên tìm sản phẩm + gara

Tài liệu tra cứu nhanh: bot tìm gara theo thứ tự nào, câu trả lời tương ứng ra sao.

Code: `src/fb/v3/flow-handler.ts` (FB bot) và `src/libs/chat/server/route.ts` (Web bot) —
**sửa 1 bên phải sửa cả bên kia**. Cập nhật 2026-10-02.

---

## 0. Điều kiện trước khi tìm

Bot chỉ tìm khi đã có đủ **3 nhóm thông tin**:

| Nhóm | Đủ khi có bất kỳ thứ nào |
|---|---|
| Kích cỡ | `tire_size` (khách gõ, chọn từ list theo tên xe, hoặc đọc từ ảnh) |
| Nhu cầu | hãng cụ thể, phân khúc, tầm giá, hoặc "tốt nhất" |
| Khu vực | `ward_code` hoặc `province_code` |

Thiếu bất kỳ nhóm nào → hỏi tiếp, **không** tìm. Thiếu khu vực mà hỏi 2 lần không ra → chuyển CSKH.

---

## 1. Chọn chiến lược tìm

Dựa trên những gì khách đã nói (`resolveFetchStrategy`):

| Khách nói | Chiến lược |
|---|---|
| 1 hãng, hoặc từ 4 hãng trở lên | **Chuẩn** |
| 2–3 hãng cụ thể | **Đa thương hiệu** |
| Phân khúc (cao cấp / cân bằng / tiết kiệm) | **Chuẩn** (lọc theo nhóm hãng của phân khúc) |
| Chỉ nêu tầm giá, không nêu hãng | **Chuẩn** (bỏ lọc hãng, chỉ lọc giá) |
| "Tốt nhất", "xịn nhất" | **Tốt nhất** |
| "Xem hết", "các loại" | **Xem hết** |

---

## 2. Thứ tự tìm — chiến lược CHUẨN

Nguyên tắc: **đúng size + đúng hãng luôn được ưu tiên trước**, kể cả khi phải lấy gara tỉnh khác.
Dừng ngay ở bước đầu tiên có kết quả.

```
1. size + hãng + xã/phường
2. size + hãng + tỉnh/thành
3. size + hãng + nhóm gara ưu tiên      → "TRỢ GIÁ + MIỄN SHIP"
4. size + xã/phường        (bỏ hãng)
5. size + tỉnh/thành       (bỏ hãng)
6. size + nhóm gara ưu tiên (bỏ hãng)   → "TRỢ GIÁ + MIỄN SHIP"
7. size + hãng + toàn quốc
8. size + toàn quốc        (bỏ hãng)
9. Không có gì            → xin SĐT, chuyển CSKH
```

Ghi chú:
- Bước 4–6 chỉ chạy khi khách có nêu hãng cụ thể. Khách không nêu hãng thì 1–3 đã là "bỏ hãng".
- Khách chỉ cho tỉnh (không có xã) thì bỏ qua bước 1 và 4.
- Khách chỉ cho xã thì tỉnh được suy ra từ xã đó.
- **Đổi thứ tự ngày 2026-09-18**: trước đây "bỏ hãng trong khu vực" chạy TRƯỚC "đúng hãng + gara ưu tiên",
  nên khách hỏi đúng hãng mà gara ưu tiên có bán vẫn bị đẩy sang hãng khác.

---

## 3. Thứ tự tìm — các chiến lược còn lại

### Đa thương hiệu (2–3 hãng)

Mỗi hãng tìm **độc lập**, mỗi hãng 1 carousel riêng:

```
Với từng hãng:  xã → tỉnh → gara ưu tiên → toàn quốc
```

Không có bước "bỏ hãng" (khách đã chỉ đích danh). Hãng nào không có hàng thì **bỏ qua im lặng**,
không báo lỗi. Tất cả hãng đều không có → coi như không có kết quả (bước 9 ở trên).

### Tốt nhất

Duyệt hết phân khúc trong phạm vi hẹp trước, rồi mới nới phạm vi:

```
1. xã:           cao cấp → cân bằng → tiết kiệm → tất cả
2. tỉnh:         cao cấp → cân bằng → tiết kiệm → tất cả
3. gara ưu tiên: cao cấp → cân bằng → tiết kiệm → tất cả
4. toàn quốc:    cao cấp → cân bằng → tiết kiệm → tất cả
```

Dừng ở tổ hợp đầu tiên có hàng.

### Xem hết

Lấy **1 sản phẩm rẻ nhất của mỗi phân khúc** (tối đa 3 card), mỗi phân khúc tự thử xã rồi tỉnh:

```
1. cao cấp:   xã → tỉnh   (lấy 1)
2. cân bằng:  xã → tỉnh   (lấy 1)
3. tiết kiệm: xã → tỉnh   (lấy 1)
Cả 3 phân khúc đều trống → bỏ lọc hãng: xã → tỉnh → gara ưu tiên → toàn quốc
```

Kèm nút "Xem tất cả" dẫn về trang `/lop` lọc theo kích cỡ.

---

## 4. Lọc giá

Khi khách có nêu tầm giá, điều kiện `giá < mức khách nêu` được áp **ở mọi bước**, không phải bước riêng.

- Chỉ nhận giá khi tin nhắn có đơn vị tiền rõ ràng (`tr`, `triệu`, `k`, `củ`, `nghìn`, `đ`) hoặc số tiền
  đầy đủ. **"2 quả", "4 chiếc" là số lượng, không phải giá.**
- Nếu AI bỏ sót giá khách nêu, code tự trích lại bằng luật cố định (`priceMarker.ts`).
- Đổi size/hãng/khu vực **sau khi** đã ra kết quả → xoá mức giá cũ. Đổi trước lần tìm đầu tiên → giữ.
- Không có kết quả mà đang lọc giá → lý do gửi CSKH có ghi rõ `— ĐANG LỌC GIÁ dưới X`.

---

## 5. Dữ liệu và điều kiện lọc

| Bảng | Vai trò | Điều kiện |
|---|---|---|
| `productadmin` | Danh mục lốp chuẩn | `type=SAN_PHAM`, `type2=LOP`, `status`, `forsale`, `SIZE`, `BRAND` |
| `product` | Giá từng gara niêm yết | `status`, `display` |
| `garage` | Gara | `status=true`; tầng toàn quốc lọc thêm `is_test=false` |
| `priority_garage` | Danh sách gara ưu tiên | `is_active=true`, cache RAM 30 phút |

- Cửa sổ danh mục: lấy **10** sản phẩm rẻ nhất theo size+hãng, nới lên **30** khi có lọc giá hoặc khi
  tìm ở nhóm gara ưu tiên / toàn quốc.
- Kích cỡ được chuẩn hoá qua `categoryadmin` trước khi tra, để size đã được admin gộp vẫn ra đúng nhóm.
- Giá cuối = khuyến mại nếu thấp hơn giá niêm yết, nếu không thì `lastprice`, nếu không thì giá gốc.
- Sắp xếp **rẻ nhất trước**, tối đa **3 card**, mỗi sản phẩm tối đa 3 gara.
- Cột `priority` trong `priority_garage` hiện **không** dùng để sắp xếp.

---

## 6. Câu bot nói ứng với từng tầng

| Kết quả đến từ | Câu mở đầu |
|---|---|
| Xã hoặc tỉnh của khách | "Dạ TROLYoto đã tìm được sản phẩm phù hợp... gara **gần mình** nhé!" |
| Cùng khu vực nhưng đã bỏ lọc hãng | "...tìm thấy gara gần mình có những sản phẩm này... chọn **Xem loại lốp khác**" |
| Nhóm gara ưu tiên | "Hiện TROLYoto chưa ghi nhận gara ở {khu vực} công khai giá ạ 😔 / ...ĐẠI LÝ CHÍNH HÃNG sau đang có **TRỢ GIÁ + MIỄN SHIP**" |
| Toàn quốc | Như trên nhưng **không** hứa trợ giá/miễn ship, chỉ "mời anh/chị tham khảo" |
| Rơi tầng xa **vì lọc giá** (không phải vì khu vực hết hàng) | "Hiện gara ở {khu vực} chưa có giá dưới {X} ạ 😔..." |
| Đa thương hiệu, **lẫn lộn** (hãng có tại chỗ, hãng phải lấy tỉnh khác) | Câu chung bỏ chữ "gần mình"; **mỗi hãng** phải lấy tỉnh khác có dòng riêng: "Hiện chưa có gara ở {khu vực} bán {hãng} ạ 😔 Đây là ĐẠI LÝ CHÍNH HÃNG..." |

Quy tắc bất di bất dịch: **kết quả nằm ngoài khu vực khách thì tuyệt đối không nói "gara gần mình"**.

---

## 7. Hai ví dụ thật

**Bắc Ninh, hỏi HANKOOK + GOODYEAR 185/65R15** (session `3d498e22`, 2026-10-02)
HANKOOK có gara Từ Sơn ngay Bắc Ninh → tầng 2. GOODYEAR cả nước chỉ có 3 gara ở TP.HCM và Đồng Nai
→ tầng toàn quốc. Dữ liệu đúng, nhưng câu chữ cũ nói "gara gần mình" cho cả hai → đã sửa thành
câu chung trung tính + ghi chú riêng cho GOODYEAR.

**"Thái Bình", hỏi MICHELIN 175/75R16** (2026-09-18)
"Thái Bình" là tỉnh cũ đã sáp nhập → ra xã Thái Bình thuộc Hưng Yên. Không gara nào bán Michelin size
này → bỏ hãng → cả tỉnh Hưng Yên → ra gara Hoà Lốp. Trước khi sửa thứ tự, bước bỏ hãng chỉ tìm trong
xã nên trả về 0 và rơi oan xuống gara ưu tiên tỉnh khác.

---

## 8. Khi sửa cần nhớ

- Cascade nằm ở 4 hàm riêng (chuẩn / đa thương hiệu / tốt nhất / xem hết) × 2 bot = **8 chỗ**.
- Tầng gara ưu tiên và toàn quốc chỉ được mở bằng cờ tường minh (`restrictGarageCodes` /
  `allowNationwide`), không bao giờ suy ra từ việc thiếu tham số vị trí.
- Tắt nhanh tầng gara ưu tiên: `PRIORITY_GARAGE_ENABLED=false`.
- Chi tiết ràng buộc hành vi và các bug cũ: xem `follow.md` mục "Cascade khi tìm SP+gara".
