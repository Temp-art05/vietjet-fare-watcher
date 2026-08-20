# Vietjet Fare Watcher

Tool tự quét giá vé Vietjet theo chu kỳ. Vé nào rơi vào ngưỡng giá đã config thì bắn noti về Discord.

- **FE + BE** trong một app Next.js
- **Config toàn bộ trên web**: webhook, ngưỡng giá từ–đến, một chiều / khứ hồi, khoảng ngày đi/về, chu kỳ quét
- **Nhiều config**, mỗi cái một mục đích và một nhịp quét riêng
- **Không cần database**: toàn bộ dữ liệu nằm trong một file JSON

## Lưu ý

Tool này điều khiển website công khai của Vietjet để tự theo dõi giá vé cho cá nhân, không phải sản phẩm chính thức của Vietjet và không liên kết với họ. Giữ chu kỳ quét ở mức hợp lý (mặc định 20 phút) — quét quá dày vừa dễ bị chặn vừa làm phiền hệ thống của người ta. Dùng cho mục đích cá nhân.

## Chạy local

```bash
npm install
npx playwright install chromium     # lần đầu, tải Chromium
npm run dev                         # xong — http://localhost:3000
```

Một lệnh là đủ: bộ poll chạy luôn bên trong app (`instrumentation.ts`), không phải mở thêm process nào. **Không cần biến môi trường nào** — dữ liệu tự ghi vào `data/db.json`, muốn đổi chỗ thì đặt `DATA_FILE`.

Trên web:

1. **Thêm config** — dán Discord webhook URL (Server Settings → Integrations → Webhooks → Copy Webhook URL), đặt ngưỡng giá và chu kỳ quét
2. Bấm **Start** — từ đó mỗi config tự quét theo chu kỳ của nó
3. Bấm **Stop** khi muốn ngừng; trạng thái lưu trong file JSON nên khởi động lại app vẫn giữ nguyên

Muốn thử ngay không chờ hết chu kỳ thì bấm **Check now** ở config, hoặc **Quét ngay 1 lượt** để chạy hết mọi config đang bật.

## Lưu dữ liệu

Không có database. Config, lịch sử noti và công tắc Start/Stop nằm chung trong **một document JSON** — đọc/ghi nguyên file, vì dữ liệu chỉ cỡ vài chục config và vài nghìn dòng lịch sử. Mọi lượt ghi đi qua `mutate()` trong `lib/store.ts`, xếp hàng lần lượt nên hai request cùng lúc không đè lên nhau, và ghi ra file tạm rồi `rename` nên mất điện giữa chừng cũng không để lại file JSON hỏng.

File này ở đâu thì tuỳ biến môi trường:

| Có `BLOB_READ_WRITE_TOKEN`? | Nơi cất | Dùng khi |
|---|---|---|
| Không | File trên ổ đĩa, đường dẫn `DATA_FILE` | Local, Docker, VPS |
| Có | Vercel Blob, đường dẫn `BLOB_PATH` | Vercel (ổ đĩa chỉ đọc) |

Lịch sử alert bị cắt còn 2000 dòng mới nhất mỗi lần ghi, để file không phình vô hạn. Muốn sao lưu hay chuyển máy thì copy đúng file JSON đó.

## Deploy

### Docker / Railway / Fly.io / VPS — cách khuyến nghị

Một container, một process:

```bash
docker compose up -d --build
```

Web ở `http://<host>:3000`. File JSON nằm trên volume `watcher-data` nên config và lịch sử noti không mất khi rebuild.

### Vercel

Chạy được cả bộ, kể cả phần scrape. Ba thứ đã được chuẩn bị sẵn trong repo:

**1. Lưu dữ liệu — bắt buộc.** Tạo Blob store (Storage → Blob → Create), Vercel tự thêm `BLOB_READ_WRITE_TOKEN`. **Phải Redeploy sau khi tạo**: biến môi trường chỉ có hiệu lực với deployment mới, bản đang chạy không tự nhận.

Thiếu bước này thì app rơi về ghi file trên ổ đĩa, mà ổ đĩa serverless chỉ đọc — mọi thao tác lưu sẽ trả 500 kèm thông báo nhắc đúng việc phải làm.

Blob được ghi ở chế độ **private**: đọc phải có token, nên webhook Discord trong file không lộ ra ngoài. Đây cũng là điều kiện để dữ liệu đúng — `useCache: false` của `@vercel/blob` chỉ thật sự bỏ cache với blob private (`dist/index.js:146`), còn blob public đi qua CDN nên ghi xong đọc lại vẫn ra bản cũ, và lượt ghi kế tiếp dựng trên bản cũ đó sẽ xoá mất thay đổi vừa rồi. `BLOB_PATH` chỉ còn là chuyện đặt tên, không phải chỗ dựa bảo mật.

**2. Chromium.** Ổ đĩa serverless không có browser, nên `lib/vietjet.ts` tự đổi cách khởi động khi thấy biến `VERCEL`: giải nén Chromium từ `@sparticuz/chromium` thay vì dùng bản `playwright install` tải về.

- `playwright-core` (không kèm browser) nằm ở `dependencies`; `playwright` đầy đủ chỉ là `devDependency` để chạy local
- Hai package **phải khớp phiên bản Chromium**: `playwright-core@1.61` và `@sparticuz/chromium@149` cùng dùng Chromium 149. Nâng cái này thì nâng cả cái kia
- `--single-process` của `@sparticuz/chromium` là cờ **phải giữ**: thiếu nó, lần navigate đầu tiên phải spawn renderer riêng và trên Lambda việc đó chết (`prctl(PR_SET_NO_NEW_PRIVS) failed`) — browser sập, Playwright chỉ báo lại `Target page, context or browser has been closed`. Đổi lại `browser.newContext()` không dùng được, nên nhánh serverless đi bằng `launchPersistentContext` với một profile rỗng trong `/tmp` (`openSession()` trong `lib/vietjet.ts`): default context, mà vẫn xoay được user agent và cỡ cửa sổ. Cờ duy nhất bị lọc ra là `--headless='shell'`, vì Playwright tự đặt `--headless`
- Profile trong `/tmp` được xoá khi đóng; thư mục sót lại từ invocation bị chém giữa đường thì lượt sau dọn, vì `/tmp` chỉ có 512MB mà Chromium giải nén đã chiếm một phần
- Đặt `VJ_GRAPHICS=0` nếu nghi thiếu RAM: tắt WebGL/swiftshader cho nhẹ, đánh đổi là reCAPTCHA v3 dễ nghi hơn
- Binary Chromium là mấy file `.br` chỉ mở lúc chạy, bộ dò phụ thuộc của Next không thấy, nên `outputFileTracingIncludes` trong `next.config.mjs` khai tay cho từng route có quét. Bundle ra khoảng **75 MB**, thoải mái dưới hạn 250 MB

**3. Lịch quét.** `worker.ts` không sống trên serverless (process đóng ngay sau mỗi request), nên `instrumentation.ts` tự bỏ qua khi thấy biến `VERCEL`. Thay vào đó `vercel.json` khai Cron gọi `/api/cron`, làm đúng việc bộ poll vẫn làm. Đặt `CRON_SECRET` trong Project Settings để chặn request lạ.

Lịch mặc định để **`0 3 * * *`** (3h sáng mỗi ngày) vì đó là mức dày nhất mà **Hobby** cho phép — để dày hơn thì Vercel **từ chối deploy** luôn. Một ngày một lượt thì tool gần như vô dụng, nên chọn một trong hai cách:

- **Lên Pro** rồi sửa `vercel.json` thành `*/5 * * * *` (Pro cho tới 1 lần/phút)
- **Vẫn ở Hobby**: dùng một dịch vụ cron miễn phí bên ngoài ([cron-job.org](https://cron-job.org), GitHub Actions…) gọi `GET https://<app>.vercel.app/api/cron` mỗi 5 phút, kèm header `Authorization: Bearer <CRON_SECRET>`. Route không quan tâm ai gọi, miễn đúng secret — nên cách này cho nhịp quét y hệt Pro mà không tốn tiền

Vì function bị cắt cứng khi hết giờ, các route có quét đều **tự canh giờ**: chúng nhận một deadline (`maxDuration` trừ 30s dự phòng) và không bắt đầu config mới khi sắp hết. Config chưa kịp chạy vẫn còn "tới hạn" nên lượt cron sau tự nhặt tiếp — quét không bao giờ bị chém nửa chừng, chỉ bị chia thành nhiều lượt.

Giới hạn thực tế phải sống chung:

| | Hobby | Pro |
|---|---|---|
| Cron dày nhất | **1 lần/ngày** | 1 lần/phút |
| `maxDuration` | 300s | 300s mặc định, tối đa 800s |
| RAM | 2 GB | 2–4 GB |

Repo để `maxDuration = 300` vì nó hợp lệ ở cả hai. Trên Pro thì sửa số đó trong ba route `app/api/cron`, `app/api/run-all`, `app/api/configs/[id]/run` lên tới 800 — Next bắt viết số thẳng nên không gom vào một chỗ được, bù lại mỗi route truyền đúng con số của mình vào `deadlineFrom()`.

Một lượt quét dải ngày dài vẫn có thể lâu hơn 300s cho **một** config. Deadline chỉ chặn được giữa các config, không cắt được giữa chừng một config — nên nếu bạn để khoảng ngày rộng, hãy chia thành nhiều config khoảng ngày hẹp.

Còn nếu muốn tránh hẳn mấy giới hạn này: deploy web UI lên Vercel với Blob storage, rồi chạy scraper ở một máy khác (VPS/Docker/máy ở nhà) trỏ vào cùng blob store — cả hai đọc ghi chung một file JSON.

### Biến môi trường

Chạy local hay Docker thì **không phải đặt biến nào**. Bảng này chỉ dùng khi deploy Vercel hoặc muốn đổi chỗ lưu file:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `DATA_FILE` | `data/db.json` | Đường dẫn file JSON (khi lưu trên ổ đĩa) |
| `BLOB_READ_WRITE_TOKEN` | — | Có thì chuyển sang lưu trên Vercel Blob |
| `BLOB_PATH` | `vietjet-fare-watcher/db.json` | Đường dẫn file trong blob store |
| `CRON_SECRET` | — | Có thì `/api/cron` đòi `Authorization: Bearer <secret>` |
| `VERCEL` | Vercel tự đặt | Có thì dùng Chromium của `@sparticuz/chromium` và tắt `worker.ts` |

## Chỉnh gì trên web

**Từng config** — tên, một chiều/khứ hồi, điểm đi/đến (dropdown 152 sân bay lấy thẳng từ Vietjet, không gõ tay mã IATA), khoảng ngày đi/về, ngưỡng giá từ–đến, Discord webhook, **tag khi có vé**, bật/tắt, và **chu kỳ quét riêng** (5 phút → 1 ngày). Mỗi config chạy theo nhịp của chính nó, sửa xong có hiệu lực ở tick kế tiếp, không cần restart.

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

### Tag khi có vé

Mỗi config chọn được tag `@everyone`, `@here`, một vai trò cụ thể, hoặc không tag ai.

Lấy ID vai trò: Discord → **Cài đặt → Nâng cao → Chế độ nhà phát triển**, rồi `Cài đặt máy chủ → Vai trò` → chuột phải vai trò → **Sao chép ID**.

Có một cái bẫy ở đây: mention chỉ ping thật khi nằm trong trường `content` (embed không bao giờ ping) **và** payload kèm `allowed_mentions` cho phép. Thiếu vế thứ hai thì tin nhắn vẫn hiện chữ xanh nhưng không ai nhận thông báo. Code gửi cả hai:

| Chọn | `content` | `allowed_mentions` |
|---|---|---|
| Không tag | `""` | `{"parse":[]}` |
| @everyone | `@everyone` | `{"parse":["everyone"]}` |
| @here | `@here` | `{"parse":["everyone"]}` |
| Vai trò | `<@&ID>` | `{"parse":[],"roles":["ID"]}` |

Liệt kê ID trong `roles` giúp ping được cả vai trò **không** bật "cho phép nhắc đến". Config không tag thì `parse: []` chặn mọi ping, kể cả lỡ có ký tự `@` trong tên config.

### Quy tắc bắn noti

- **Một chiều**: mỗi ngày chỉ bắn mức giá rẻ nhất, tránh spam 10 tin gần giống nhau. Nhưng **mọi chuyến cùng mức giá đó đều được báo riêng** — hai chuyến 490k khác giờ bay là hai lựa chọn thật, không cái nào bị bỏ
- **Khứ hồi**: ngưỡng giá áp cho **tổng** chiều đi + chiều về, bắn một tin cho cặp rẻ nhất
- Chống trùng theo `configId|ngày|giá|số hiệu chuyến`: giá đổi thì bắn lại, khác chuyến thì bắn lại, giá y hệt cùng chuyến thì im lặng
- Bật **"Báo lại kể cả khi giá không đổi"** ở config thì bỏ qua chống trùng, lượt nào khớp cũng bắn
- Nút **"Gửi thử"** bắn một tin mẫu vào webhook để kiểm tra URL và tag, không cần chờ có vé
- Discord lỗi thì **không** ghi `Alert`, để lượt sau bắn lại

## Cấu trúc

```
app/            web UI (1 trang) + API routes
lib/vietjet.ts  Playwright: điều khiển web Vietjet, parse giá, chọn Chromium
lib/runner.ts   quét → lọc theo ngưỡng → chống trùng → bắn noti
lib/discord.ts  build embed + gửi webhook
lib/airports.ts danh sách sân bay từ CMS API của Vietjet, cache 24h
lib/store.ts    document JSON: đọc/ghi, xếp hàng lượt ghi, chọn file hay blob
lib/limits.ts   tính deadline cho route quét từ maxDuration của chính nó
lib/db.ts       thao tác trên document đó: config, alert, cài đặt
worker.ts       bộ poll: tick mỗi phút, chạy config nào tới hạn (không dùng trên Vercel)
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
