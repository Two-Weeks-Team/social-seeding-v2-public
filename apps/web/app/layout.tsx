import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Social Seeding — Mission Control",
  description: "Agent-orchestrated TikTok influencer campaign operator",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
