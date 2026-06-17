import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Aperture — Rollout Tracker',
  description: 'Read-only rollout intelligence for FabricLiveTable feature flags.',
};

// Light theme is the default on load (design bible); the in-app toggle flips data-theme.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
