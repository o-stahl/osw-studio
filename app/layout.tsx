import type { Metadata, Viewport } from "next";
import { Inter, PT_Sans } from "next/font/google";

import TanstackProvider from "@/components/providers/tanstack-query-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { LocaleProvider } from "@/components/providers/locale-provider";
import "@/assets/globals.css";
import { Toaster } from "@/components/ui/sonner";
import { McpActivityBanner } from '@/components/mcp-activity-banner';
import { BackendStatusBanner } from "@/components/backend-status-banner";

const inter = Inter({
  variable: "--font-inter-sans",
  subsets: ["latin"],
});

const ptSans = PT_Sans({
  variable: "--font-ptSans-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "OSW Studio",
  description:
    "Open Source Web Studio is an AI-powered development environment that enables autonomous multi-file development through intelligent tool usage. Build complete applications with natural language.",
  openGraph: {
    title: "Open Source Web Studio | Agentic AI Development",
    description:
      "Open Source Web Studio is an AI-powered development environment that enables autonomous multi-file development through intelligent tool usage. Build complete applications with natural language.",
    url: "https://huggingface.co/spaces/otst/osw-studio",
    siteName: "Open Source Web Studio",
    images: [
      {
        url: "https://huggingface.co/spaces/otst/osw-studio/resolve/main/banner.png",
        width: 1200,
        height: 630,
        alt: "Open Source Web Studio - Agentic AI Development",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "OSW Studio | Agentic AI Development",
    description:
      "OSW-Studio is an AI-powered development environment that enables autonomous multi-file development through intelligent tool usage. Build complete applications with natural language.",
    images: ["https://huggingface.co/spaces/otst/osw-studio/resolve/main/banner.png"],
  },
  appleWebApp: {
    capable: true,
    title: "OSW-Studio",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/osw-studio-logo.svg",
    shortcut: "/osw-studio-logo.svg",
    apple: "/osw-studio-logo.svg",
  },
};

export const viewport: Viewport = {
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#000000",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${ptSans.variable} antialiased bg-background h-[100dvh] overflow-hidden`}
        suppressHydrationWarning
      >
        <LocaleProvider>
          <ThemeProvider>
            <Toaster richColors position="bottom-center" />
            <BackendStatusBanner />
            <McpActivityBanner />
            <TanstackProvider>
              {children}
            </TanstackProvider>
          </ThemeProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
