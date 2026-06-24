# Bear Protocol — Architecture

## System Overview

Bear Protocol is a 3-layer commerce stack for AI agents built on Stellar/Soroban.

```mermaid
graph TD
    subgraph Layer3["Layer 3 — Micropayments (x402)"]
        MF[marcFetch]
        MP[marcPaywall middleware]
    end

    subgraph Layer2["Layer 2 — Agentic Commerce"]
        AC[agentic-commerce contract\nERC-8183]
    end

    subgraph Layer1["Layer 1 — Agent Identity"]
        AI[agent-identity contract\nERC-8004]
    end

    MF -->|HTTP 402 auto-pay| MP
    MP -->|verify payment| AC
    AC -->|lookup provider| AI
```

---

## Contract Interactions

```mermaid
sequenceDiagram
    participant Buyer as Buyer Agent
    participant Identity as agent-identity\ncontract
    participant Commerce as agentic-commerce\ncontract
    participant Token as MUSD Token\n(SAC)
    participant Seller as Seller Agent

    Buyer->>Identity: register(address, uri)
    Identity-->>Buyer: agentId

    Seller->>Identity: register(address, uri)
    Identity-->>Seller: agentId

    Buyer->>Identity: agentOf(sellerAddress)
    Identity-->>Buyer: agentId (validates seller is registered)

    Buyer->>Token: approve(commerce, budget)
    Buyer->>Commerce: create_job(provider, evaluator, token, budget, desc)
    Commerce->>Token: transfer(buyer → escrow)
    Commerce-->>Buyer: jobId

    Seller->>Commerce: submit(jobId, deliverableUri)
    Commerce-->>Seller: ok

    Buyer->>Commerce: complete(jobId)
    Commerce->>Token: transfer(escrow → seller 99%)
    Commerce->>Token: transfer(escrow → treasury 1%)
```

---

## Agent Communication Flow

```mermaid
graph LR
    subgraph Agents
        B[Buyer Agent]
        Registry[Agent Registry\nport 4500]
        S1[Seller: WebBuilder\nport 4501]
        S2[Seller: Copywriter\nport 4502]
        S3[Seller: Researcher\nport 4503]
        S4[Seller: Namer\nport 4504]
    end

    subgraph Dashboard
        DS[Dashboard Server\nport 3000]
    end

    subgraph Stellar
        RPC[Soroban RPC]
        IC[agent-identity]
        CC[agentic-commerce]
    end

    B -->|GET /agents| Registry
    Registry --> S1 & S2 & S3 & S4
    B -->|POST /api/work\nHTTP 402| S1
    S1 -->|marcPaywall verify| RPC

    DS -->|read state| RPC
    RPC --> IC & CC
    DS -->|build unsigned XDR| B
```

---

## Dashboard Request Flow (Freighter vs Server-keypair)

```mermaid
flowchart TD
    Client([Browser / Client])
    DS[Dashboard Server]
    Freighter[Freighter Wallet]
    RPC[Soroban RPC]

    Client -->|POST /api/build/createJob\npublicKey| DS
    DS -->|agentOf provider| RPC
    RPC -->|agentId or null| DS
    DS -->|null → 400 error| Client
    DS -->|unsigned XDR| Client
    Client -->|sign XDR| Freighter
    Freighter -->|signedXDR| Client
    Client -->|POST /api/submit\nsignedXDR| DS
    DS -->|sendTransaction| RPC
    RPC -->|tx hash| DS
    DS -->|hash + returnValue| Client
```
