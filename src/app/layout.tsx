import type { Metadata, Viewport } from "next";
import "./globals.css";
import { publicPath } from "@/lib/deployment";
export const metadata: Metadata = {
  title: "Вместе — план вашей поездки",
  description: "Поездки, билеты, отели и любимые места — в одном плане.",
  icons: { icon: publicPath("/icon.svg") },
  manifest: publicPath("/manifest.webmanifest"),
  appleWebApp: { capable: true, title: "Вместе", statusBarStyle: "default" },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#284e3f",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
