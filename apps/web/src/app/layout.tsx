import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ledger Logic",
  description: "PennyWise payroll assistant for a Junior HR Assistant",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
