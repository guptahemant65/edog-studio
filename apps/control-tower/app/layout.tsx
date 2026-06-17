import type { ReactNode } from 'react';

export const metadata = {
  title: 'Aperture — Rollout Tracker',
  description: 'Read-only rollout intelligence for FabricLiveTable feature flags.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif',
          background: '#0e0e12',
          color: '#e7e7ee',
        }}
      >
        {children}
      </body>
    </html>
  );
}
