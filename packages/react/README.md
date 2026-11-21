# @bear-protocol/react

Idiomatic React hooks for integrating [Bear Protocol](https://github.com/bear-protocol) into React applications. This package wraps `marc-stellar-sdk` (`IdentityClient`, `CommerceClient`, and `marcFetch`) so you can drop async state, loading indicators, and error handling into your components without boilerplate.

## Installation

```bash
npm install @bear-protocol/react marc-stellar-sdk react
```

`react` (>= 18) is a peer dependency.

## Setup

Wrap your app in `WalletProvider` so the hooks can reach the configured clients and share wallet state. Every hook and component below must be rendered inside this provider.

```tsx
import { WalletProvider } from '@bear-protocol/react'

function App() {
  return (
    <WalletProvider options={{ network: 'testnet' }}>
      <YourApp />
    </WalletProvider>
  )
}
```

### `<WalletProvider />`

Provides the wallet context consumed by `useWallet`, `useWalletState`, and `<WalletConnectButton />`. It is SSR-safe and renders its children immediately.

Props:

| Prop       | Type                     | Default     | Description                                                                 |
| ---------- | ------------------------ | ----------- | --------------------------------------------------------------------------- |
| `children` | `React.ReactNode`        | —           | Your application tree.                                                      |
| `options`  | `WalletProviderOptions`  | `undefined` | Client configuration: `network`, `rpcUrl`, `horizonUrl`, `explorerUrl`, etc. |

```tsx
<WalletProvider options={{ network: 'mainnet', rpcUrl: 'https://soroban.stellar.org' }}>
  <App />
</WalletProvider>
```

### `useWalletContext()`

Low-level accessor for the raw context value. Throws if called outside a `<WalletProvider />`. Most applications should use `useWallet()` or `useWalletState()` instead; reach for `useWalletContext()` when building custom wallet UI that needs the underlying client and provider registry.

```tsx
import { useWalletContext } from '@bear-protocol/react'

function CustomWalletUI() {
  const { client, providers } = useWalletContext()
  // ...
}
```

## Exports

Everything below is exported from the package root (`@bear-protocol/react`).

### Hooks

| Hook                    | Returns                                                                 | Description                                                       |
| ----------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `useWallet()`           | `{ connected, address, balance, provider, connect, switchWallet, disconnect }` | Full multi-wallet connection state and actions.            |
| `useWalletState()`      | `{ connected, address, balance, provider }`                             | Read-only subset of `useWallet()` for display-only components.    |
| `useAgent(id, options?)`| `{ agent, loading, error }`                                             | Cached, deduplicated read of `IdentityClient.getAgent()`.         |
| `useJob(id)`            | `{ job, loading, error }`                                               | Read of `CommerceClient.getJob()`.                                |
| `useCreateJob()`        | `{ createJob, pending, error }`                                         | Mutation hook for creating jobs, with optimistic UI support.      |
| `useCommerce()`         | `{ client, loading, error }`                                            | Access to the configured `CommerceClient` instance.               |
| `usePaymentChannel()`   | `{ channel, open, close, pending, error }`                              | Manage a payment channel lifecycle.                               |
| `useAsync(fn, deps?)`   | `{ data, loading, error, refetch }`                                     | Generic async state wrapper used to build the hooks above.        |
| `useFreighter()`        | `{ connected, address, connect, disconnect }`                           | Freighter-only connection helper.                                 |
| `useMarcFetch(keypair)` | `{ fetch, isPaying, error }`                                            | Wraps `marcFetch` and surfaces x402 payment status.               |

### Components

| Component               | Description                                                                 |
| ----------------------- | --------------------------------------------------------------------------- |
| `<WalletConnectButton />` | Drop-in connect button with avatar, truncated address, balance, and modal. |
| `<AgentCard />`         | Renders an agent record (name, id, metadata) from an `Agent` or agent id.   |
| `<JobStatusBadge />`    | Colored badge for a `JobStatus` value.                                      |
| `<EscrowStepper />`     | Step indicator for the escrow lifecycle of a job.                           |

### Cache helpers

| Export                  | Description                                                                 |
| ----------------------- | --------------------------------------------------------------------------- |
| `clearCache()`          | Clears all in-memory query caches (useful in tests and on logout).          |
| `invalidate(key)`       | Invalidates a single cache entry by key.                                    |
| `getCacheStats()`       | Returns hit/miss statistics for debugging cache behaviour.                  |

### Types

`WalletProviderOptions`, `WalletContextValue`, `WalletProviderName`, `UseWalletResult`, `UseWalletStateResult`, `UseAgentOptions`, `UseAgentResult`, `UseJobResult`, `UseCreateJobResult`, `UseCommerceResult`, `UsePaymentChannelResult`, `UseAsyncResult`, `AgentCardProps`, `JobStatusBadgeProps`, `EscrowStepperProps`, plus re-exported core types (`Agent`, `Job`, `JobStatus`, `MarcConfig`, …).

```tsx
import type { Agent, Job, JobStatus, UseAgentOptions, WalletProviderOptions } from '@bear-protocol/react'
```

## Hooks

### `useAgent(id, options?)`

Read-only hook wrapping `IdentityClient.getAgent()`. Returns the agent record along with `loading` and `error` state.

Requests are cached in memory and deduplicated: mounting many components with the same `id` triggers a single RPC call, and cached data is returned immediately (stale-while-revalidate) while fresh data is fetched in the background.

Options:

| Option   | Type     | Default | Description                                                        |
| -------- | -------- | ------- | ------------------------------------------------------------------ |
| `ttlMs`  | `number` | `60000` | How long cached data is considered fresh before revalidating.      |

```tsx
import { useAgent } from '@bear-protocol/react'

function AgentCard({ agentId }: { agentId: string }) {
  const { agent, loading, error } = useAgent(agentId, { ttlMs: 30_000 })

  if (loading) return <Spinner />
  if (error) return <ErrorBanner error={error} />
  if (!agent) return null

  return <h2>{agent.name}</h2>
}
```

### `useAgents(options?)`

List hook built on the SDK's agent iterator. Returns a page of agents along with `loading` and `error` state, plus pagination helpers. Use `owner` to filter the list to agents owned by a specific address.

Options:

| Option     | Type     | Default | Description                                                        |
| ---------- | -------- | ------- | ------------------------------------------------------------------ |
| `pageSize` | `number` | `20`    | Number of agents fetched per page.                                 |
| `owner`    | `string` | `undefined` | Only return agents owned by this address.                      |

Result:

| Field      | Type                     | Description                                                       |
| ---------- | ------------------------ | ----------------------------------------------------------------- |
| `agents`   | `Agent[]`                | Agents loaded so far (accumulated across pages).                  |
| `loading`  | `boolean`                | `true` while a page is being fetched.                             |
| `error`    | `Error \| null`          | The last error encountered, if any.                               |
| `hasMore`  | `boolean`                | Whether another page is available.                                |
| `loadMore` | `() => Promise<void>`    | Fetch the next page and append it to `agents`.                    |
| `refresh`  | `() => Promise<void>`    | Reset to the first page and refetch.                              |

```tsx
import { useAgents } from '@bear-protocol/react'

function AgentList({ owner }: { owner?: string }) {
  const { agents, loading, error, hasMore, loadMore, refresh } = useAgents({
    pageSize: 10,
    owner,
  })

  if (loading && agents.length === 0) return <Spinner />
  if (error) return <ErrorBanner error={error} />

  return (
    <div>
      <button onClick={refresh}>Refresh</button>
      <ul>
        {agents.map((agent) => (
          <li key={agent.id}>{agent.name}</li>
        ))}
      </ul>
      {hasMore && (
        <button onClick={loadMore} disabled={loading}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
```

### `useJob(id)`

Read-only hook wrapping `CommerceClient.getJob()`.

```tsx
import { useJob } from '@bear-protocol/react'

function JobStatus({ jobId }: { jobId: string }) {
  const { job, loading, error } = useJob(jobId)

  if (loading) return <Spinner />
  if (error) return <ErrorBanner error={error} />

  return <span>Status: {job?.status}</span>
}
```

### `useCreateJob()`

Mutation hook for creating jobs. Exposes `createJob`, a `pending` flag, and an `error`. Supports optimistic UI by letting you pass an optimistic job that is reconciled once the request resolves.

```tsx
import { useCreateJob } from '@bear-protocol/react'

function NewJobButton() {
  const { createJob, pending, error } = useCreateJob()

  return (
    <button
      disabled={pending}
      onClick={() =>
        createJob(
          { agentId: 'agent-1', budget: '10' },
          { optimistic: { id: 'temp', status: 'pending' } },
        )
      }
    >
      {pending ? 'Creating…' : 'Create job'}
    </button>
  )
}
```

### `useFreighter()`

Manages Freighter wallet connection state.

```tsx
import { useFreighter } from '@bear-protocol/react'

function ConnectButton() {
  const { connected, address, connect, disconnect } = useFreighter()

  if (connected) {
    return (
      <button onClick={disconnect}>
        {address?.slice(0, 6)}…{address?.slice(-4)}
      </button>
    )
  }

  return <button onClick={connect}>Connect Freighter</button>
}
```

### `useWallet()`

Multi-wallet connection hook that powers `<WalletConnectButton />`. It tracks the active provider (Freighter, xBull, or Albedo), the connected address, balance, and connection status, and exposes actions for connecting, switching wallets, and disconnecting.

```tsx
import { useWallet } from '@bear-protocol/react'

function WalletStatus() {
  const { connected, address, balance, provider, connect, switchWallet, disconnect } = useWallet()

  if (!connected) return <button onClick={() => connect('freighter')}>Connect</button>

  return (
    <div>
      <span>{provider}: {address?.slice(0, 6)}…{address?.slice(-4)}</span>
      <span>{balance} XLM</span>
      <button onClick={() => switchWallet('xbull')}>Switch</button>
      <button onClick={disconnect}>Disconnect</button>
    </div>
  )
}
```

## Components

### `<WalletConnectButton />`

A drop-in connect button with an avatar badge, truncated address, balance display, and a wallet selection modal. It works out of the box with a single line:

```tsx
import { WalletConnectButton } from '@bear-protocol/react'

function Header() {
  return <WalletConnectButton />
}
```

When disconnected it renders a "Connect Wallet" trigger with the brand icon. Clicking it opens a responsive modal listing the supported providers (Freighter, xBull, and Albedo). When connected it shows the truncated address (`GABC…XYZ`), an avatar glyph, and the balance; clicking it opens a dropdown menu with **Copy Address**, **View on Explorer**, **Switch Wallet**, and **Disconnect**.

Props:

| Prop          | Type                                | Default     | Description                                                          |
| ------------- | ----------------------------------- | ----------- | -------------------------------------------------------------------- |
| `className`   | `string`                            | `undefined` | Extra class applied to the root element for custom styling.          |
| `onConnect`   | `(address: string) => void`         | `undefined` | Called with the address after a successful connection.               |
| `onDisconnect`| `() => void`                        | `undefined` | Called after the wallet is disconnected.                             |
| `providers`   | `WalletProvider[]`                  | all         | Restrict or reorder the wallet providers shown in the modal.         |
| `explorerUrl` | `(address: string) => string`       | network default | Customize the "View on Explorer" link target.                    |

```tsx
<WalletConnectButton
  className="my-connect-button"
  onConnect={(address) => console.log('connected', address)}
  providers={['freighter', 'xbull']}
/>
```

#### Custom styling

All markup uses stable, prefixed class names (`bear-wallet-connect`, `bear-wallet-modal`, …) and CSS custom properties, so you can override the look without fighting specificity:

```css
.my-connect-button {
  --bear-wallet-accent: #6d28d9;
  --bear-wallet-radius: 9999px;
  border-radius: var(--bear-wallet-radius);
  background: var(--bear-wallet-accent);
  color: white;
}
```

#### Accessibility

The modal and dropdown are fully keyboard accessible: focus is trapped inside the modal while open, `Escape` closes it, arrow keys move between providers, and focus is restored to the trigger on close. All interactive elements expose appropriate ARIA roles and labels.

## SSR & Next.js

The package is fully SSR-safe: no `window`, `document`, or `localStorage` access happens at module evaluation time, and the initial server render matches the client hydration state (wallets render as disconnected until hydration completes), so you get zero hydration mismatch warnings.

### `'use client'` boundaries

Every hook and component entry point ships with a `'use client'` directive, so they work out of the box in the Next.js 14+ App Router. Because hooks cannot be called from Server Components, wrap them in a Client Component and render that from your server page:

```tsx
// app/providers.tsx
'use client'

import { WalletProvider } from '@bear-protocol/react'

export function Providers({ children }: { children: React.ReactNode }) {
  return <WalletProvider options={{ network: 'testnet' }}>{children}</WalletProvider>
}
```

```tsx
// app/layout.tsx (Server Component)
import { Providers } from './providers'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
```

```tsx
// app/page.tsx (Server Component)
import { WalletConnectButton } from './wallet-connect-button'

export default function Page() {
  return <WalletConnectButton />
}
```

```tsx
// app/wallet-connect-button.tsx
'use client'

import { WalletConnectButton } from '@bear-protocol/react'

export function WalletConnectButtonClient() {
  return <WalletConnectButton />
}
```

### Dynamic import with `ssr: false`

If you need to keep a wallet widget out of the server render entirely (for example, to avoid rendering third-party wallet markup during SSR), load it with `next/dynamic` and `ssr: false`. This is only allowed inside a Client Component:

```tsx
// app/wallet-widget.tsx
'use client'

import dynamic from 'next/dynamic'

const WalletConnectButton = dynamic(
  () => import('@bear-protocol/react').then((m) => m.WalletConnectButton),
  { ssr: false, loading: () => <span>Loading wallet…</span> },
)

export function WalletWidget() {
  return <WalletConnectButton />
}
```

Both the Pages Router and App Router are supported. A reference Next.js 14 app lives in `examples/nextjs-starter` and is built in CI to verify clean SSR compilation.

## Bundle size & tree-shaking

The package is bundled with tsup as dual ESM + CJS output with TypeScript declarations. `@stellar/stellar-sdk`, `react`, and `react-dom` are peer dependencies and are never bundled. `sideEffects: false` is set so unused hooks and components are fully stripped by your bundler.

The minified + gzipped bundle is guaranteed to stay **under 15 KB**, and a `bundlesize` check runs in CI on every pull request to enforce the limit.

### `useMarcFetch(keypair)`

Wraps `marcFetch` and surfaces x402 payment status so you can render paywall UI while a request is being paid for.

```tsx
import { useMarcFetch } from '@bear-protocol/react'

function PaidResource({ keypair }: { keypair: Keypair }) {
  const { fetch, isPaying, error } = useMarcFetch(keypair)

  const load = async () => {
    const res = await fetch('https://api.bear-protocol.xyz/premium')
    return res.json()
  }

  return (
    <button onClick={load} disabled={isPaying}>
      {isPaying ? 'Processing payment…' : 'Load premium data'}
    </button>
  )
}
```

## TanStack Query

If your app already uses [TanStack Query](https://tanstack.com/query), the optional `@bear-protocol/react/query` entry point provides ready-made query hooks, a query key factory, and invalidation helpers so you don't have to wrap SDK calls by hand.

`@tanstack/react-query` (>= 5) is an **optional peer dependency**: it is only required if you import from `@bear-protocol/react/query`. Apps that don't use TanStack Query are unaffected and don't need to install it.

```bash
npm install @tanstack/react-query
```

### Query hooks

```tsx
import { useJobQuery, useAgentQuery } from '@bear-protocol/react/query'

function JobStatus({ jobId }: { jobId: string }) {
  const { data: job, isLoading, error } = useJobQuery(jobId)

  if (isLoading) return <Spinner />
  if (error) return <ErrorBanner error={error} />

  return <span>Status: {job?.status}</span>
}
```

### Query keys

Every query is keyed through a factory so you can target caches precisely (e.g. for prefetching, `setQueryData`, or invalidation). The factories are exported as `jobKeys` and `agentKeys`:

| Factory     | Key                                   | Description                              |
| ----------- | ------------------------------------- | ---------------------------------------- |
| `jobKeys`   | `jobKeys.all`                         | Root key for every job query.            |
|             | `jobKeys.lists()`                     | Key for job list queries.                |
|             | `jobKeys.detail(id)`                  | Key for a single job by id.              |
| `agentKeys` | `agentKeys.all`                       | Root key for every agent query.          |
|             | `agentKeys.lists()`                   | Key for agent list queries.              |
|             | `agentKeys.detail(id)`                | Key for a single agent by id.            |

```tsx
import { useQueryClient } from '@tanstack/react-query'
import { jobKeys, agentKeys } from '@bear-protocol/react/query'

const queryClient = useQueryClient()

// Prefetch a job into the cache
queryClient.prefetchQuery({ queryKey: jobKeys.detail('job-1'), queryFn: /* … */ })

// Read cached data for an agent
const agent = queryClient.getQueryData(agentKeys.detail('agent-1'))
```

### Invalidation helpers

After a mutation, invalidate the affected caches with the provided helpers instead of hand-writing keys:

```tsx
import { useCreateJob } from '@bear-protocol/react'
import { useQueryClient } from '@tanstack/react-query'
import { invalidateJob, invalidateAgent } from '@bear-protocol/react/query'

function NewJobButton() {
  const { createJob, pending } = useCreateJob()
  const queryClient = useQueryClient()

  const onClick = async () => {
    const job = await createJob({ agentId: 'agent-1', budget: '10' })
    // Refresh the single job and any job lists
    await invalidateJob(queryClient, job.id)
    // Or invalidate everything for an agent
    await invalidateAgent(queryClient, 'agent-1')
  }

  return <button disabled={pending} onClick={onClick}>Create job</button>
}
```

## Import paths

The package ships a dual ESM + CJS build with TypeScript declarations, and exposes two entry points through its export map:

| Import path                     | Contents                                                              |
| ------------------------------- | --------------------------------------------------------------------- |
| `@bear-protocol/react`          | Hooks, components, and types (no TanStack Query dependency).          |
| `@bear-protocol/react/query`    | TanStack Query hooks, `jobKeys`/`agentKeys`, and invalidation helpers. |

Both entry points resolve for ESM (`import`) and CJS (`require`) consumers, with matching `.d.ts` types for each:

```ts
// ESM
import { useAgent } from '@bear-protocol/react'
import { useJobQuery, jobKeys } from '@bear-protocol/react/query'

// CJS
const { useAgent } = require('@bear-protocol/react')
const { useJobQuery, jobKeys } = require('@bear-protocol/react/query')
```

The export map is validated in CI with [`publint`](https://publint.dev) and [`@arethetypeswrong/cli`](https://arethetypeswrong.github.io) (`attw`) on every pull request, so broken or mismatched entry points fail the build.

## Types

The package ships exhaustive TypeScript types for every hook and component, with `isolatedModules` and `declarationMap` enabled. Hook option and result interfaces (`UseAgentOptions`, `UseAgentResult`, `UseJobResult`, `UseCommerceResult`, …) and component prop interfaces are exported from the package root, and essential core types (`Agent`, `Job`, `JobStatus`, `MarcConfig`, …) are re-exported directly from `marc-stellar-sdk` so you don't need to import from both packages.

```tsx
import type { Agent, Job, JobStatus, UseAgentOptions } from '@bear-protocol/react'
```

## Storybook

An interactive Storybook showcase documents every component and hook with live controls, dark/light theme toggles, and copy-pasteable code snippets for each story.

```bash
npm run storybook        # start the local dev server (http://localhost:6006)
npm run build-storybook  # build the static documentation site into storybook-static/
```

The static site is built and deployed to GitHub Pages from CI. Once deployed it is available at:

https://bear-protocol.github.io/bear-protocol/

## Development

```bash
npm install
npm test              # Vitest + React Testing Library (all hooks and components)
npm run test:watch    # Vitest in watch mode
npm run test:coverage # Vitest with coverage report (90%+ threshold)
npm run storybook
```

Tests run with Vitest in a jsdom environment (`vitest.config.ts`) and mock Soroban RPC / client responses to cover loading, success, and error states, unmount cleanup, and race-condition prevention on dependency changes.

## License

MIT
