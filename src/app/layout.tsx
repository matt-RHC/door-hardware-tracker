import type { Metadata, Viewport } from "next";
import "./globals.css";
import PerformanceProvider from "@/components/PerformanceProvider";
import ToastProvider from "@/components/ToastProvider";

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
        {/* Mirror globals.css: dark --background is #0F1117, light --background is #F7F8FA.
            Safari only reads one value, so prefer the light default per ThemeToggle; dark users
            just see a dim chrome. Kept in sync manually with globals.css :root and [data-theme]. */}
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0F1117" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#F7F8FA" />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <PerformanceProvider>
          <ToastProvider>
            {children}
          </ToastProvider>
        </PerformanceProvider>
      </body>
    </html>
  );
}
