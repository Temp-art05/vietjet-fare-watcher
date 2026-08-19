/** @type {import('next').NextConfig} */
const config = {
  // Package native, không được bundle vào server build.
  serverExternalPackages: ["playwright-core", "@sparticuz/chromium"],

  // Chromium nằm trong mấy file .br, chỉ được mở ra lúc chạy nên bộ dò phụ
  // thuộc của Next không thấy. Không khai ở đây thì bản deploy Vercel lên tới
  // nơi mới báo thiếu file — chép tay vào từng route có quét.
  outputFileTracingIncludes: {
    "/api/cron": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/run-all": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/configs/[id]/run": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
};

export default config;
