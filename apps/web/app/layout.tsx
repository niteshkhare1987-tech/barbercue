import type { Metadata, Viewport } from "next";
import { Fraunces, Work_Sans } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "../lib/auth-context";
import { SiteHeader } from "../components/layout/SiteHeader";
import { SiteFooter } from "../components/layout/SiteFooter";
import { HideOnOwnerShell } from "../components/layout/HideOnOwnerShell";
import { UniqueVisitorTracker } from "../components/analytics/UniqueVisitorTracker";
import { MetaPixel } from "../components/analytics/MetaPixel";

// next/font self-hosts these at build time (no runtime request to Google, no layout shift) and
// exposes each as a CSS variable so globals.css can assign them without a hardcoded font stack
// living in two places. Fraunces (a warm, characterful serif with real editorial presence at
// display sizes) carries headings; Work Sans, a clean and slightly warmer alternative to the
// ubiquitous Inter/Helvetica-everywhere look, carries body copy and UI chrome — the pairing is the
// single biggest lever for "premium barbershop brand" over "generic SaaS dashboard".
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  // Fraunces' optical-size + soft axes are what give it character at large sizes without going
  // twee at small ones — both weights below lean on that rather than faux-bolding a single cut.
  weight: ["500", "600"],
  style: ["normal", "italic"],
  display: "swap",
});
const workSans = Work_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "FastQue",
    template: "%s | FastQue",
  },
  description: "Find nearby barbershops, check the wait, and book your chair.",
  icons: {
    icon: "/brand/fastque-premium-3d-mark.png",
    apple: "/brand/fastque-premium-3d-mark.png",
  },
};

// Build 12 physical retest: a real Android phone rendered the entire site with inverted colors —
// dark backgrounds, light text, a black/red hero — despite globals.css's `html { color-scheme:
// light }`. That CSS property alone isn't reliably honored by Android Chrome/WebView's automatic
// "force dark" page-darkening heuristic; a `<meta name="color-scheme">` tag in <head> is the
// documented, more broadly-respected opt-out. Next's `viewport` export is what renders that tag
// (colorScheme here, not the `metadata` export above, which has no such field).
export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#fffdf9",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${fraunces.variable} ${workSans.variable}`}>
      <body>
        <UniqueVisitorTracker />
        <MetaPixel />
        <AuthProvider>
          <SiteHeader />
          {children}
          <HideOnOwnerShell>
            <SiteFooter />
          </HideOnOwnerShell>
        </AuthProvider>
      </body>
    </html>
  );
}
