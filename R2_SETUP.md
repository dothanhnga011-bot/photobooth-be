# Kết nối Cloudflare R2

Code đã hỗ trợ R2 nhưng **mặc định vẫn ghi GridFS**. Liên kết GitHub với Cloudflare
không tự tạo kho ảnh hoặc cấp khóa R2 cho backend Express. Tạo bucket và cấu hình
biến môi trường trên **máy chủ backend** (Render hoặc máy chủ đang chạy photobooth-be).
Không đặt khóa trong photobooth-fe, `VITE_*`, GitHub source hay gửi khóa qua chat.

## 1. Tạo kho ảnh riêng

1. Mở [R2 trong tài khoản của bạn](https://dash.cloudflare.com/60387d55b30e91f155c48f0e8bcbd15a/r2/overview).
2. Nếu chưa bật R2, hoàn tất đăng ký/thanh toán của Cloudflare. Chỉ tạo bucket khi đã bật dịch vụ.
3. Chọn **Create bucket**, tên `nxc-media`, lớp lưu trữ **Standard**, không chọn jurisdiction riêng.
4. Giữ bucket riêng tư: không bật public `r2.dev` hoặc custom domain. Backend phục vụ
   ảnh qua URL album hiện tại sau khi kiểm tra mã album và hạn lưu. Không cần CORS để dùng cách này.

## 2. Tạo khóa truy cập

Trong trang R2, chọn **Manage R2 API Tokens → Create API token**. Chọn quyền
**Object Read & Write**, chỉ bucket `nxc-media`. Lưu **Access Key ID** và
**Secret Access Key**; backend dùng hai giá trị S3 này, không dùng API token quản lý zone/DNS.
Theo [tài liệu Cloudflare](https://developers.cloudflare.com/r2/api/tokens/), secret chỉ hiện khi tạo.

## 3. Cấu hình backend

Đặt các biến sau trong Render → dịch vụ **photobooth-be** → Environment, hoặc `.env`
của backend khi chạy tại tiệm. Không ghi secret vào `.env.example` hay commit `.env`.

```dotenv
MEDIA_STORAGE_PROVIDER=gridfs
R2_ACCOUNT_ID=60387d55b30e91f155c48f0e8bcbd15a
R2_BUCKET=nxc-media
R2_ACCESS_KEY_ID=<Access Key ID vừa tạo>
R2_SECRET_ACCESS_KEY=<Secret Access Key vừa tạo>
R2_PREFIX=media/
R2_STORAGE_LIMIT_GB=10
MEDIA_TTL_HOURS=72
```

Chạy `npm run r2:check` trong backend để kiểm tra ghi/đọc/liệt kê/xóa một tệp nhỏ
có tên ngẫu nhiên. Lệnh tự dọn tệp kiểm tra, không kết nối MongoDB hay thay đổi ảnh có sẵn.
Nếu báo OK, đổi **`MEDIA_STORAGE_PROVIDER=r2`** và khởi động/deploy lại backend.
Chụp hoặc tải lên một ảnh thử, mở album, thử chỉnh/tải ảnh/gửi in rồi xem **Hàng chờ in → Trợ lí Minh Dâm**.
Thống kê R2 phải tăng; `media.files` trong MongoDB không tăng vì các ảnh mới.

Nếu chọn R2 nhưng thiếu biến bắt buộc, backend báo lỗi cấu hình và không khởi động.
Nếu R2 bị lỗi trong lúc vận hành, upload báo thất bại để máy chụp/điện thoại thử lại;
không tự ghi sang MongoDB làm đầy gói 512 MB. Đổi về `gridfs` là lựa chọn vận hành
tường minh; vẫn phải giữ nguyên khóa, bucket và prefix để mở/dọn ảnh đã lưu trên R2.
Không đổi tên bucket/account khi còn ảnh; tham chiếu `r2:` không chứa danh tính bucket cũ.

## 4. Hạn lưu và chống tồn file khi backend ngủ

Mỗi ảnh (JPEG, thumbnail; ảnh cũ còn thêm bản nhận vào) hết hạn cùng thời điểm 72 giờ từ ObjectId ảnh;
tờ in tính 72 giờ từ lúc gửi. Video và ảnh ghép xoá cùng ảnh cuối của album. Backend dọn khi khởi động và
15 phút/lần; URL xem ảnh/tờ in chặn nội dung đã hết hạn dù đợt dọn file chưa chạy. Khi vé hoàn tất/hủy đã
quá hạn và không còn file/lệnh in, tên, số điện thoại, token album và dữ liệu phiên chụp cũng bị xoá;
giữ sổ bán hàng để thống kê/đối soát doanh thu. Album đã dọn dữ liệu trả 404.

Render miễn phí có thể ngủ, nên nên thêm rule dự phòng trong bucket → **Settings →
Object Lifecycle Rules → Add rule**: prefix `media/`, delete sau **4 ngày** khi TTL là 72 giờ.
Rule này dọn cả tệp mồ côi nếu upload lỗi hoặc server tắt trước khi lưu tham chiếu.
Nếu đổi TTL, đặt rule dài hơn TTL (ví dụ TTL 72 giờ thì rule ít nhất 4 ngày).
Không áp dụng rule này cho bucket chứa khung ảnh/logo/tệp muốn lưu vĩnh viễn.
Cloudflare dọn lifecycle bất đồng bộ; đây là cơ chế dự phòng, không bảo đảm xóa đúng giây
hết hạn. [Tài liệu lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

## 5. Dung lượng, chất lượng và chuyển đổi dữ liệu cũ

- Ảnh mới lưu JPEG đầy đủ kích thước, thumbnail 640 px và preview 1600 px trên R2 (không còn bản nhận vào trùng lặp: JPEG
  sạch được lưu nguyên byte, JPEG có metadata được bỏ thông tin riêng tư mà không nén lại pixel,
  ảnh khác chuẩn hóa một lần ở JPEG 100 / 4:4:4); không giảm chất lượng
  tải xuống hoặc ảnh in. Thumbnail 640 px/JPEG 78 dùng cho thư viện/ghép vị trí;
  preview 1600 px/JPEG 90 dùng để chỉnh ảnh nhanh; nguồn in 3000 px/JPEG 95 / 4:4:4 dùng để tạo tờ in
  (nhẹ hơn ảnh gốc 26 MP nhiều lần, đủ điểm ảnh cho mọi ô khung; được tạo ở nền ngay sau khi ảnh lưu xong). Các bản này hết hạn cùng ảnh gốc;
  thống kê kho tính đủ chúng trong nhóm ảnh xem trước. Ảnh cũ chưa có preview dùng thumbnail có sẵn.
  Tờ in dùng PNG không mất dữ liệu 1200 × 1800 px (hoặc ngang), khổ 4 × 6 inch / 300 ppi.
- Ảnh GridFS cũ tiếp tục mở/tải/in/dọn được bằng tên cũ. Không tự di chuyển hoặc xóa hàng loạt.
  Theo TTL hiện tại, phần ảnh cũ trong MongoDB giảm sau các đợt dọn khi hết hạn.
- Trợ lí đọc metadata GridFS và R2 (gồm file mồ côi trong `media/`), không tải ảnh để đo.
  MongoDB theo dõi toàn cluster với mức 512 MB; R2 theo dõi dung lượng hiện tại bằng MB/GB
  và cảnh báo từ 80%, nguy cấp 90% mức bạn đặt. API sửa riêng: `PUT /api/admin/storage/r2-limit`
  với `{ "limitGB": 10 }`; `null` bỏ mức cảnh báo. Chỉ admin được thay mức hoặc dọn file.
- R2 Standard miễn phí 10 GB-tháng theo trung bình đỉnh dung lượng mỗi ngày trong kỳ;
  dung lượng tức thời không phải số liệu hóa đơn. Mức 10 GB trong ứng dụng chỉ để theo dõi,
  không chặn upload. Phí còn gồm lượt đọc/ghi vượt hạn mức; băng thông tải ra trực tiếp R2 miễn phí.
  [Bảng giá hiện hành](https://developers.cloudflare.com/r2/pricing/).
- Khi R2 không đo được, giao diện báo chưa biết dung lượng, không hiển thị 0 GB hoặc khẳng định không còn ảnh.
  Dọn lỗi giữ tham chiếu để lần sau thử lại; hủy lệnh in chỉ trả quota sau khi xóa file thành công.

## 6. Tải ảnh trực tiếp để giảm tải backend

Ảnh thư viện và tờ in dùng `?direct=1`: backend kiểm tra quyền album, tình trạng ảnh và hạn lưu
rồi ký URL GET riêng cho đúng tệp, tối đa 5 phút và không vượt hạn lưu của ảnh. Bucket vẫn riêng tư.
Trình duyệt đọc trực tiếp R2; không cần bật public access hay đặt khóa R2 ở frontend.
URL cũ, HEAD, Range và ZIP vẫn được backend xử lý. Nếu tải trực tiếp lỗi, web tự thử đường cũ.
Trình chỉnh ảnh xin `?direct=link` để nhận JSON chứa URL rồi tải R2, giữ đúng Origin của web
khi frontend/API khác miền. Backend cũ bỏ qua query và trả ảnh vẫn tương thích.
Phản hồi album còn kèm sẵn URL thumbnail/preview/nguồn in/ảnh gốc của từng ảnh (`photos[].links`, hết hạn
ở `until`), nên thư viện, trình chỉnh và bước ghép tờ in tải thẳng R2 mà không hỏi backend cho từng ảnh.

Để chỉnh ảnh bằng canvas tải trực tiếp và **máy chụp gửi ảnh gốc, video tua nhanh thẳng lên R2** (mục 7),
vào bucket **Settings → CORS policy** và đặt (có thể sao chép [r2-cors.json](r2-cors.json) vào ô JSON trong
dashboard). Origin viết đúng như trình duyệt gửi: `https://tên-miền`, **không có dấu `/` ở cuối** (có dấu `/`
thì không khớp và trình duyệt chặn tải lên):

```json
[
  {
    "AllowedOrigins": ["https://mellowptb.com", "https://photobooth.ngathanh.workers.dev", "http://localhost:5173"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["Range", "Content-Type"],
    "ExposeHeaders": ["Content-Length", "Content-Type", "Content-Range"],
    "MaxAgeSeconds": 3600
  }
]
```

Giữ các rule đã có nếu chúng phục vụ ứng dụng khác. Thay origin khi đổi tên miền frontend.
Khóa chỉ có quyền đọc/ghi object có thể không được sửa CORS; khi đó đặt rule qua dashboard.
Thiếu CORS chỉ làm trình chỉnh ảnh dùng đường backend; ảnh xem và in trực tiếp vẫn hoạt động.
Thiếu `PUT`/`Content-Type` thì máy chụp vẫn gửi ảnh và video qua backend như trước (thử lại đường thẳng sau 10 phút).
[Tài liệu CORS R2](https://developers.cloudflare.com/r2/buckets/cors/).

## 7. Máy chụp gửi ảnh gốc thẳng lên R2

(Ảnh JPEG khách tự thêm từ điện thoại trong album cũng đi đường này: điện thoại tự làm ảnh xem trước.)

Ảnh gốc máy ảnh (~15 MB) không còn đi qua Render — gói free có CPU, RAM và băng thông ra ngoài
hạn chế, mỗi ảnh trước đây đi vào Render rồi lại đi ra R2:

1. Máy chụp tự bỏ metadata riêng tư (giống hệt từng byte cách backend làm, có test so sánh) rồi xin
   `POST /api/kiosk/photo/upload-url` (sau buổi chụp: `/api/albums/{token}/photos/upload-url`).
   Backend kiểm tra phiên, ký URL PUT 15 phút cho **đúng một khóa, đúng loại image/jpeg và đúng số
   byte** (header content-length/content-type nằm trong chữ ký).
2. Trình duyệt PUT ảnh lên R2, rồi gửi `POST /api/kiosk/photo` chỉ với ảnh xem trước 1600 px và header
   `X-Photo-Stored` (mã HMAC gắn với phiên + mã ảnh, không dùng được cho album khác).
3. Backend chỉ đọc 128 KB đầu của ảnh trên R2 (đúng JPEG sạch metadata, sRGB, ≤ 40 MB), làm ảnh nhỏ từ ảnh
   xem trước, thêm ảnh vào album; nguồn in 3000 px đọc ảnh gốc từ R2 ở nền. Ảnh gốc giữ nguyên byte.

Không dùng được (bucket chưa cho PUT, mạng tới R2 lỗi, tệp đang ghi dở, ảnh lạ) thì máy chụp tự gửi
qua backend như cũ — không mất ảnh. Ảnh đã lên R2 mà chưa được nhận (mất mạng giữa chừng) được gửi
lại bằng cùng mã, không tải lại 15 MB; tệp bỏ dở chỉ được đếm là "không còn dùng" để xóa bằng nút dọn.

Kiosk gửi tối đa 2 ảnh cùng lúc; backend giới hạn 3 tác vụ lưu ảnh trên toàn tiệm. Ghi tệp
có thể gối nhau nhưng thêm ảnh vào album vẫn theo thứ tự, không trùng khi thử lại. Kết thúc
phiên đợi các ảnh đã nhận; ảnh mạng lỗi vẫn giữ nguyên file gốc trong IndexedDB để gửi lại.

Trình duyệt giải mã ảnh bằng worker và giữ cache JPEG nén tối đa 64 MiB. Thanh trượt xử lý
preview 1600 px; màn ghép vị trí dùng thumbnail 640 px. Khi tạo tờ in, web đọc từng nguồn in
3000 px (ảnh gốc chỉ khi ô phóng to cần nhiều điểm ảnh hơn, hoặc ảnh cũ chưa có nguồn in)
và vẽ trực tiếp vào canvas 1200 × 1800, giữ thứ tự ô/phóng to/xoay, rồi bỏ tham chiếu canvas lớn.
Không dùng `Promise.all` giữ nhiều ảnh 26 MP đã giải mã cùng lúc. Xuất PNG giữ toàn bộ pixel tờ in.

## File cần sửa sau này

- `src/services/r2.js`: SDK S3, reference `r2:`, cấu hình và cache metadata.
- `src/services/media.js`: đọc/ghi/xóa/stream GridFS + R2 và TTL chung.
- `src/services/capture.js`, `src/routes/albums.js`: ảnh album, thumbnail, tờ in.
- `src/services/media-storage.js`, `src/routes/admin/storage.js`: thống kê hai kho, mức cảnh báo.
- `scripts/check-r2.js`: xác minh cấu hình bằng tệp kiểm tra.
- `test/r2-media.test.js`: API/storage với MongoDB tạm và transport S3 giả lập.

`npm test` và bài browser smoke vô hiệu hóa khóa R2 trong môi trường test để không chạm kho thật.
