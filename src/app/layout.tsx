import type { Metadata, Viewport } from "next";
import "./globals.css";
import PerformanceProvider from "@/components/PerformanceProvider";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export const metadata: Metadata = {
  title: "Door Hardware Tracker",
  description: "Track door hardware installations in real-time",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Door Hardware Tracker",
  },
  formatDetection: {
    telephone: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <head>
        <meta name="theme-color" content="#000000" />
      </head>
      <body className="min-h-full flex flex-col bg-black text-[#f5f5f7]">
        <PerformanceProvider>
          {children}
        </PerformanceProvider>
      </body>
    </html>
  );
}
