import { ClerkProvider } from "@clerk/nextjs";
import { Analytics } from "@vercel/analytics/next";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Codegraph",
  description: "Dependency maps of public GitHub repositories",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const theme = (await cookies()).get("theme")?.value;
  return (
    <html
      lang="en"
      data-theme={theme === "light" || theme === "dark" ? theme : undefined}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-full font-sans">
        <ClerkProvider
          taskUrls={{ "choose-organization": "/onboarding" }}
          // Clerk's components read the same tokens, so they follow the theme.
          appearance={{
            variables: {
              colorBackground: "var(--surface)",
              colorForeground: "var(--fg)",
              colorMutedForeground: "var(--muted)",
              colorNeutral: "var(--fg)",
              colorPrimary: "var(--accent)",
              colorInput: "var(--bg)",
              colorInputForeground: "var(--fg)",
              colorBorder: "var(--border)",
              fontFamily: "var(--font-geist-sans)",
              fontSize: "13px",
              borderRadius: "4px",
            },
          }}
        >
          {children}
        </ClerkProvider>
        <Analytics />
      </body>
    </html>
  );
}
