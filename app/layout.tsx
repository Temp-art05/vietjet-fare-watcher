import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vietjet Fare Watcher",
  description: "Săn vé Vietjet giá rẻ, bắn Discord khi vào ngưỡng giá",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body className="min-h-screen text-slate-800 antialiased">{children}</body>
    </html>
  );
}
