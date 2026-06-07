import type { Metadata } from "next";
import "@/app/globals.css";

export const metadata: Metadata = {
  title: "同路 Along · AI 协作旅行规划",
  description: "多人边聊边规划，AI 把讨论实时变成可执行的旅行路线。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&family=LXGW+WenKai:wght@300;400;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
