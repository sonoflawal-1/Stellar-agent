# MARC Stellar — Design System

Extracted from `marcprotocol.com` (live Ethereum-version site, provided as visual reference). We reuse the visual identity 1:1 and pivot only the copy (privacy layer → commerce layer).

## Tokens

### Color (light theme)

| Token             | Value     | Usage                                                                    |
| ----------------- | --------- | ------------------------------------------------------------------------ |
| `--bg`            | `#FAFAFA` | Page background                                                          |
| `--bg-elevated`   | `#FFFFFF` | Cards, modals                                                            |
| `--border`        | `#E5E7EB` | Card borders, dividers                                                   |
| `--text`          | `#0A0A0A` | Headlines, primary text                                                  |
| `--text-muted`    | `#6B7280` | Descriptions, labels                                                     |
| `--accent`        | `#F97316` | Orange — primary accent (buttons, highlights, accent words in headlines) |
| `--accent-soft`   | `#FFF4E6` | Light orange — active nav item bg, chips, label bg                       |
| `--accent-strong` | `#EA580C` | Hover state for orange                                                   |
| `--logo-yellow`   | `#FFD60A` | Logo square only                                                         |

### Color (dark theme — inferred, implement if time allows)

| Token           | Value                 |
| --------------- | --------------------- |
| `--bg`          | `#0A0A0A`             |
| `--bg-elevated` | `#1A1A1A`             |
| `--border`      | `#262626`             |
| `--text`        | `#FAFAFA`             |
| `--text-muted`  | `#9CA3AF`             |
| `--accent`      | `#F97316` (unchanged) |
| `--accent-soft` | `#2D1B0A`             |

### Typography

- **Font family:** `Inter`, fallback `-apple-system, BlinkMacSystemFont, sans-serif`
- **Headline (hero):** 72–96px, weight 800–900, tight line-height (1.05), letter-spacing -0.02em
- **Headline (section):** 48–64px, weight 800, line-height 1.1
- **Section label (eyebrow):** 13px, weight 600, uppercase, letter-spacing 0.15em, color `--accent`
- **Body:** 17–19px, weight 400, line-height 1.6, color `--text-muted`
- **Caption:** 13–14px, weight 500

### Spacing

Base 4px scale: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128.

### Radius

| Token           | Value  | Usage                     |
| --------------- | ------ | ------------------------- |
| `--radius-sm`   | 8px    | Chips, small pills        |
| `--radius-md`   | 12px   | Inputs, small buttons     |
| `--radius-lg`   | 16px   | Cards                     |
| `--radius-xl`   | 20px   | Large cards               |
| `--radius-full` | 9999px | Buttons, pills, nav items |

### Shadows

| Token           | Value                                                 |
| --------------- | ----------------------------------------------------- |
| `--shadow-sm`   | `0 1px 2px rgba(0,0,0,0.04)`                          |
| `--shadow-md`   | `0 4px 12px rgba(0,0,0,0.05)`                         |
| `--shadow-card` | `0 2px 8px rgba(0,0,0,0.04), 0 0 0 1px var(--border)` |

## Component specs

### Navigation bar

- Height: 72px
- Sticky top, subtle bottom border on scroll
- Logo (left): 32px yellow square with black "M" glyph + "MARC" wordmark in black
- Center: text links `Home` `Protocol` `About`, medium weight, gray when inactive, black when active
- Right cluster: icon buttons (GitHub, X, docs book, theme toggle) then orange pill `Launch App`

### Hero

- Full viewport height
- Background: cream with subtle orange dot particles (positioned absolutely, low opacity)
- Center: wireframe geodesic sphere SVG (orange strokes, ~600–800px wide, slow rotate animation optional)
- Overlay: huge two-line headline (first line black, second line orange with period), then muted subtitle paragraph, then two pill CTAs ([orange fill] Start Building, [white outline] Read Docs)
- Bottom: vertical line + `SCROLL` label

### Section header

- Small orange uppercase eyebrow label
- 48–64px black headline (optionally with one orange accent word)
- Gray paragraph, 2–3 lines

### Card (value prop / feature)

- White bg, `--radius-lg`, `--shadow-card`, `--border`
- Padding 32px
- Orange circle icon (48px) at top
- Bold title (20–22px black)
- Gray description (16px)

### Button

- Pill (`--radius-full`), padding 14px 28px, weight 600
- Primary: `--accent` bg, white text, hover → `--accent-strong`
- Secondary: white bg, `--border`, black text, hover → light gray bg

### Dashboard sidebar

- Width 240px, white bg, right border
- Logo at top (identical to nav)
- Nav items: icon + label, 16px padding, `--radius-lg`
- Active: `--accent-soft` bg, `--accent` text + icon
- Inactive: gray text, hover → light gray bg

### Stat card

- White bg, `--radius-lg`, `--border`, padding 24px
- Label (gray, small) → number (32–40px black bold) → subtitle (gray, small)
- Empty state: em dash `—` instead of number

## Assets

- **Logo:** yellow square (`--logo-yellow`) with black italic "M", 32px in nav, 40–48px in hero/sidebar
- **Geodesic sphere:** SVG, orange wireframe, low stroke weight (~0.5–1px), semi-transparent
- **Orange dot particles:** 2–6px circles scattered in background with CSS animations (optional, cut if tight on time)

## Dark mode

Implement only if we have time on Day 2. Toggle lives in nav. Persisted to localStorage.

## Tech choices for implementing this

- **Framework:** plain HTML + CSS + a tiny vanilla JS file (no React for the hackathon landing page — saves build time)
- **Fonts:** Inter via Google Fonts CDN
- **Icons:** Lucide via CDN (matches the minimal geometric style of the reference)
- **Hosting:** GitHub Pages or Vercel, static deploy
- **Build tool:** none — just `index.html` + `style.css` + `app.js`

## Copy pivots (original site → Stellar version)

| Original copy                                                                                                                                         | Stellar version                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The Privacy Layer for Agent Payments."                                                                                                               | **"The Commerce Layer for Agent Payments."**                                                                                                                      |
| "The confidential payment layer for AI agents. FHE-encrypted tokens, on-chain identity, and escrow-based commerce. All in one protocol."              | "The commerce layer for AI agent payments on Stellar. Job escrow with delivery guarantees, on-chain agent identity, on top of x402 and MPP. All in one protocol." |
| "Wrap USDC into FHE-encrypted cUSDC. Fee-free peer-to-peer transfers. Silent failure pattern leaks zero balance info."                                | "Escrow USDC for multi-step agent jobs. 1% platform fee on completion. ERC-8183-inspired job lifecycle."                                                          |
| "Three ERC standards working together to bring private payments to every agent protocol: x402, MCP, MPP, A2A, AgentKit, Virtuals GAME, and OpenClaw." | "Two Soroban contracts working with x402 and MPP to bring trust and delivery guarantees to every AI agent transaction on Stellar."                                |
| Protocol stack: ERC-7984 (Confidential Token)                                                                                                         | Protocol stack: **Agentic Commerce** (Soroban — job escrow)                                                                                                       |
| ERC-8004 (Identity / Reputation)                                                                                                                      | **Agent Identity** (Soroban — ERC-8004-inspired)                                                                                                                  |
| ERC-8183 (Agentic Commerce)                                                                                                                           | **x402 / MPP integration** (Stellar payment rails)                                                                                                                |
| "From USDC to Confidential Commerce"                                                                                                                  | "From Payment to Commerce"                                                                                                                                        |
| "Chain: Ethereum Sepolia"                                                                                                                             | "Chain: Stellar Testnet"                                                                                                                                          |
| Wallet: MetaMask / WalletConnect                                                                                                                      | Wallet: Freighter (via Stellar Wallets Kit)                                                                                                                       |

All orange accents and visual elements stay identical.
