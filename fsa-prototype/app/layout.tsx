import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Music Coach — Core Prototype",
  description: "MusicXML reference vs. MIDI/audio performance comparison via DTW.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
