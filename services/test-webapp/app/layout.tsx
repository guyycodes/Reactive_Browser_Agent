import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "browser_agent — reviewer",
  description: "Tier-1 IT triage agent reviewer UI",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
