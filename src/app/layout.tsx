import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/components/theme-provider";
import { InlineScript } from "@/components/inline-script";
import { AppSidebar } from "@/components/app-sidebar";
import { TopBar } from "@/components/top-bar";
import { Toaster } from "@/components/ui/sonner";
import { ChatWidget } from "@/components/chat-widget";
import { getSidebarVisibleTabs } from "@/lib/config";

const geistSans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Finance Dashboard",
  description: "Private, local-first dashboard for all your accounts.",
  // Installed to the iPhone home screen from /m.
  appleWebApp: { capable: true, title: "Finance", statusBarStyle: "black-translucent" },
  icons: {
    icon: [{ url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
};

/**
 * `viewportFit: "cover"` lets the standalone app paint under the notch and home
 * indicator; the phone layout pays that back with safe-area padding. Zoom stays
 * enabled — disabling it breaks pinch-zoom accessibility for no real gain.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const visibleTabs = await getSidebarVisibleTabs();
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/* Sets the .dark class before first paint to avoid a theme flash. */}
        <InlineScript html={THEME_INIT_SCRIPT} />
      </head>
      {/* Extensions may annotate body before React hydrates; suppression is one level only. */}
      <body className="min-h-full" suppressHydrationWarning>
        <ThemeProvider>
          <a href="#main-content" className="skip-link">Skip to content</a>
          <div className="flex min-h-screen">
            <AppSidebar visibleTabs={visibleTabs} />
            <div className="flex min-w-0 flex-1 flex-col">
              <TopBar visibleTabs={visibleTabs} />
              {process.env.FINANCE_DEMO === "1" && <div className="border-b bg-positive/10 px-6 py-2 text-center text-xs font-medium">DEMO · Fictional household · No real accounts or personal finances</div>}
              <main id="main-content" tabIndex={-1} className="flex-1 p-4 md:p-6">{children}</main>
            </div>
          </div>
          <Toaster richColors position="top-right" />
          <ChatWidget />
        </ThemeProvider>
      </body>
    </html>
  );
}
