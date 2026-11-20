# Bear Protocol — Next.js 14 Starter

A Next.js 14 App Router starter for building on Bear Protocol (agent commerce on Stellar).

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/sonoflawal-1/Stellar-agent/tree/main/examples/nextjs-starter)
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/sonoflawal-1/Stellar-agent)

## Quick Start

```bash
git clone https://github.com/sonoflawal-1/Stellar-agent.git
cd Stellar-agent/examples/nextjs-starter
npm install
npm run dev
# Open http://localhost:3000
```

## Pages

| Route | Description |
|-------|-------------|
| `/` | Home with agent list and job creation form |
| `/agents` | Full agent directory |
| `/jobs/[id]` | Job detail page |

## Workflow

1. Browse agents on `/agents`
2. Create a job on `/` — enter provider, evaluator, budget, description + secret key
3. Track job status at `/jobs/{id}`

## Get testnet USDC

```bash
stellar keys generate mykey --network testnet --fund
```

## WalletProvider Setup

The starter wraps the App Router tree in `WalletProvider` from `@bear-protocol/react`. Because the provider relies on browser APIs, it is mounted inside a client component so it can be used from any server-rendered page.

`app/providers.tsx`:

```tsx
'use client';

import { WalletProvider } from '@bear-protocol/react';
import type { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <WalletProvider
      network="testnet"
      appName="Bear Protocol Starter"
      autoConnect
    >
      {children}
    </WalletProvider>
  );
}
```

`app/layout.tsx`:

```tsx
import { Providers } from './providers';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

### Provider props

| Prop | Type | Description |
|------|------|-------------|
| `network` | `'testnet' \| 'mainnet'` | Stellar network the wallet connects to. |
| `appName` | `string` | Name shown in the wallet connection prompt. |
| `autoConnect` | `boolean` | Reconnect to the last-used wallet on mount. |
| `children` | `ReactNode` | App tree that can consume the hooks below. |

## Hooks

All hooks must be called from client components (`'use client'`) rendered inside `WalletProvider`.

### `useWallet()`

Access the active wallet connection and connect/disconnect actions.

```tsx
const { address, isConnected, isConnecting, connect, disconnect, error } = useWallet();
```

| Field | Type | Description |
|-------|------|-------------|
| `address` | `string \| null` | Connected Stellar public key, or `null`. |
| `isConnected` | `boolean` | Whether a wallet is connected. |
| `isConnecting` | `boolean` | Connection in progress. |
| `connect` | `() => Promise<void>` | Open the wallet picker and connect. |
| `disconnect` | `() => void` | Clear the active connection. |
| `error` | `Error \| null` | Last connection error, if any. |

### `useAgents()`

Fetch the agent directory.

```tsx
const { agents, isLoading, error, refetch } = useAgents();
```

| Field | Type | Description |
|-------|------|-------------|
| `agents` | `Agent[]` | Registered agents. |
| `isLoading` | `boolean` | Fetch in progress. |
| `error` | `Error \| null` | Fetch error, if any. |
| `refetch` | `() => Promise<void>` | Re-run the query. |

### `useJob(id)`

Fetch a single job by id.

```tsx
const { job, isLoading, error, refetch } = useJob(jobId);
```

| Field | Type | Description |
|-------|------|-------------|
| `job` | `Job \| null` | The job, or `null` while loading / not found. |
| `isLoading` | `boolean` | Fetch in progress. |
| `error` | `Error \| null` | Fetch error, if any. |
| `refetch` | `() => Promise<void>` | Re-run the query. |

### `useCreateJob()`

Submit a new job to the protocol.

```tsx
const { createJob, isPending, error, jobId } = useCreateJob();
```

| Field | Type | Description |
|-------|------|-------------|
| `createJob` | `(input: CreateJobInput) => Promise<string>` | Create a job, resolves to the new job id. |
| `isPending` | `boolean` | Transaction in progress. |
| `error` | `Error \| null` | Submission error, if any. |
| `jobId` | `string \| null` | Id of the most recently created job. |

## SSR Notes

- `WalletProvider` and every hook touch browser-only APIs (wallet extensions, `window`). Keep them in client components; never import them into a server component module.
- The `app/providers.tsx` client boundary above is the recommended pattern for the App Router. Server components can still render pages that contain client components using the hooks.
- Avoid reading wallet state during server render. Gate UI on `isConnected` inside a client component, or use `useEffect` to hydrate wallet-dependent state after mount to prevent hydration mismatches.
- For the Pages Router, wrap `_app.tsx` with `WalletProvider` and import it via `next/dynamic` with `{ ssr: false }`.

## CI

The `nextjs-ssr` CI job builds this example on every pull request, running `npm install` and `npm run build` inside `examples/nextjs-starter`. A broken build here fails CI, so keep the example compiling when you change the provider or hooks.