# Vietjet Fare Watcher

Tool tự quét giá vé Vietjet theo chu kỳ. Vé nào rơi vào ngưỡng giá đã config thì bắn noti về Discord.

- **FE + BE** trong một app Next.js
- **Config toàn bộ trên web**: webhook, ngưỡng giá từ–đến, một chiều / khứ hồi, khoảng ngày đi/về, chu kỳ quét
- **Nhiều config**, mỗi cái một mục đích và một nhịp quét riêng

## Lưu ý

Tool này điều khiển website công khai của Vietjet để tự theo dõi giá vé cho cá nhân, không phải sản phẩm chính thức của Vietjet và không liên kết với họ. Giữ chu kỳ quét ở mức hợp lý (mặc định 20 phút) — quét quá dày vừa dễ bị chặn vừa làm phiền hệ thống của người ta. Dùng cho mục đích cá nhân.

## Chạy local

```bash
npm install
npx playwright install chromium     # lần đầu, tải Chromium
cp .env.example .env                # cấu hình đường dẫn SQLite
npm run db:push                     # tạo prisma/dev.db
npm run dev                         # xong — http://localhost:3000
```

Một lệnh là đủ: bộ poll chạy luôn bên trong app (`instrumentation.ts`), không phải mở thêm process nào.

Trên web:

1. **Thêm config** — dán Discord webhook URL (Server Settings → Integrations → Webhooks → Copy Webhook URL), đặt ngưỡng giá và chu kỳ quét
2. Bấm **Start** — từ đó mỗi config tự quét theo chu kỳ của nó
3. Bấm **Stop** khi muốn ngừng; trạng thái lưu trong DB nên khởi động lại app vẫn giữ nguyên

Muốn thử ngay không chờ hết chu kỳ thì bấm **Check now** ở config, hoặc **Quét ngay 1 lượt** để chạy hết mọi config đang bật.

## Deploy

Một container, một process:

```bash
docker compose up -d --build
```

Web ở `http://<host>:3000`. SQLite nằm trên volume `watcher-data` nên config và lịch sử noti không mất khi rebuild.

Deploy lên Railway / Fly.io / VPS đều dùng chung `Dockerfile` này. **Không deploy được lên Vercel** vì Playwright cần Chromium thật và SQLite cần ổ đĩa ghi được.

### Biến môi trường

Chỉ còn đúng một biến, vì mọi thứ khác chỉnh được trên web:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DATABASE_URL` | `file:./prisma/dev.db` | Đường dẫn file SQLite |

## Chỉnh gì trên web

**Từng config** — tên, một chiều/khứ hồi, điểm đi/đến (dropdown 152 sân bay lấy thẳng từ Vietjet, không gõ tay mã IATA), khoảng ngày đi/về, ngưỡng giá từ–đến, Discord webhook, bật/tắt, và **chu kỳ quét riêng** (5 phút → 1 ngày). Mỗi config chạy theo nhịp của chính nó, sửa xong có hiệu lực ở tick kế tiếp, không cần restart.

**Start / Stop** — công tắc chung cho cả bộ poll. Mặc định là dừng, phải bấm Start.

Bộ poll chỉ tick mỗi phút để hỏi "đang bật không, config nào tới hạn", nên nó không giữ tham số nào của riêng mình.

## Cách hoạt động

Danh sách sân bay thì lấy thẳng từ CMS API mở của Vietjet (`vietjetcms-api.vietjetair.com/api/v1/airport`, 152 sân bay/22 quốc gia, có tên tiếng Việt), cache 24h. Nếu API chết mà chưa có cache, form tự chuyển về ô nhập mã IATA để vẫn sửa được config.

Còn giá vé thì khác. Vietjet **mã hoá toàn bộ request body** của API booking (`{"encrypted":"..."}`) và chặn bằng reCAPTCHA v3 + AWS WAF, nên không có endpoint HTTP nào gọi thẳng được. Tool điều khiển web thật bằng Playwright headless:

1. Mở trang chủ → chọn một chiều/khứ hồi → điền điểm đi, điểm đến, ngày đi → bấm **Tìm chuyến bay**
2. Trang `/vi/select-flight` hiện dải ngày kèm giá thấp nhất mỗi ngày, mỗi lượt tải khoảng 5 ngày
3. Quét cả dải ngày bằng cách nhảy từng chặng 5 ngày, chỉ ngày nào có giá dưới ngưỡng mới mở chi tiết chuyến bay
4. Vé khớp ngưỡng → bắn Discord → ghi lại `fingerprint` để lần sau không bắn trùng

### Chống bị nâng giá

Vietjet cá nhân hoá giá theo dấu vết người truy cập, nên mỗi lượt search đều là một phiên ẩn danh sạch:

- Mỗi lần search tạo `browser.newContext()` mới — cookie và localStorage rỗng, huỷ ngay sau khi xong
- User agent và kích thước cửa sổ xoay vòng ngẫu nhiên giữa các lượt
- Hết mỗi chu kỳ, bộ poll đóng hẳn browser để chu kỳ sau chạy trên browser mới

Còn một thứ tool không đổi được là **địa chỉ IP**. Nếu muốn triệt để thì cắm thêm proxy xoay IP vào `chromium.launch({ proxy })` trong `lib/vietjet.ts`.

### Quy tắc bắn noti

- **Một chiều**: mỗi ngày trong khoảng chỉ bắn chuyến rẻ nhất, tránh spam 10 tin gần giống nhau
- **Khứ hồi**: ngưỡng giá áp cho **tổng** chiều đi + chiều về, bắn một tin cho cặp rẻ nhất
- Giá đổi thì bắn lại (giá nằm trong `fingerprint`); giá y hệt thì im lặng
- Discord lỗi thì **không** ghi `Alert`, để lượt sau bắn lại

## Cấu trúc

```
app/            web UI (1 trang) + API routes
lib/vietjet.ts  Playwright: điều khiển web Vietjet, parse giá
lib/runner.ts   quét → lọc theo ngưỡng → chống trùng → bắn noti
lib/discord.ts  build embed + gửi webhook
lib/airports.ts danh sách sân bay từ CMS API của Vietjet, cache 24h
worker.ts       bộ poll: tick mỗi phút, chạy config nào tới hạn
instrumentation.ts  Next gọi lúc boot để khởi động bộ poll trong cùng process
scripts/        test-scrape.ts — chạy thử scraper khi Vietjet đổi giao diện
```

## Khi Vietjet đổi giao diện

Class MUI (`jss1234`) đổi theo mỗi lần Vietjet deploy nên code **không** bám vào chúng — chỉ bám `id`, text tiếng Việt, `data-index` của dải ngày và `.rdr*` của lịch. Nếu scraper hỏng, chạy:

```bash
npx tsx scripts/test-scrape.ts
```

rồi sửa selector trong `lib/vietjet.ts`.

## Giấy phép

[MIT](LICENSE)
