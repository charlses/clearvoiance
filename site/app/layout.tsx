import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "clearvoiance — capture and replay real traffic, time-compressed",
    template: "%s · clearvoiance",
  },
  description:
    "Capture every input to your backend — HTTP, WebSockets, cron, queues, outbound calls, DB queries — then replay at N× speed against a hermetic clone. Find breaking points before production does.",
  metadataBase: new URL("https://clearvoiance.io"),
  openGraph: {
    type: "website",
    siteName: "clearvoiance",
    title: "clearvoiance",
    description:
      "Capture production traffic. Replay it at N× against a hermetic clone. Correlate every slow query, lock, and deadlock back to the event that caused it.",
  },
  twitter: {
    card: "summary_large_image",
    title: "clearvoiance",
    description:
      "Capture production traffic. Replay at N×. Correlate back to the exact event that caused the regression.",
  },
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable}`}
    >
      <body className="min-h-screen bg-background text-foreground antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
