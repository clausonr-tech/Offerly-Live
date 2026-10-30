import type { Metadata, Viewport } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Offerly",
  description: "Learn, network, and apply - the finance recruiting workflow in one place.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistMono.variable} h-full antialiased`}
      // One theme: light. Dark mode was removed (2026-09-25).
      data-mkt-theme="light"
    >
      <body className="min-h-full flex flex-col bg-background">{children}</body>
    </html>
  );
}
