import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Bear Protocol — Next.js Starter',
  description: 'Agent commerce on Stellar',
};

// Note: This layout is a Server Component and intentionally does not reference
// any browser globals (window, document, localStorage) during SSR.
//
// Components and hooks from @marc-stellar/react are client components (they
// include 'use client' directives). They must be imported and rendered inside
// a client boundary — e.g. within a component that itself declares 'use client'
// or a file that is only rendered on the client — rather than directly in this
// server layout, to avoid "window is not defined" errors during SSR.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}