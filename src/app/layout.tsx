import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RelayKit",
  description: "Self-hostable storefront for reselling digital goods.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
