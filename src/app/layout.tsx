import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "IsoTri — Hierarchical Isometric Triangle Map Editor",
  description:
    "Prototype editor for maps built on hierarchical grids of isometric triangular tiles. Material weights live on vertices; the tile factory blends them, so beaches and ecotones emerge from interpolation. Refine any tile into four deterministic children.",
  keywords: [
    "tile map editor",
    "isometric",
    "triangular grid",
    "procedural generation",
    "hierarchical LOD",
  ],
  icons: {
    icon: "/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
