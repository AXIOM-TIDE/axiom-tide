# CONK Chest — Tatum × Walrus Hackathon Submission

**Axiom Tide LLC · axiomtide.com · [conk.app](https://conk.app)**

---

## What We Built

**CONK Chest** is the eighth primitive of the CONK protocol — a Walrus-backed encrypted file vault with on-chain access control and USDC micropayments on Sui mainnet.

A developer encrypts a file with SEAL, stores the blob on Walrus, then commits the `blobId` and `sealId` on-chain via `chest::open`. Anyone can pay the access fee in USDC to receive the blob reference and decrypt the file. Revenue flows 97% to the author, 3% to the CONK protocol treasury — with no intermediary custody.

**This is live on Sui mainnet today.**

---

## The Stack

| Layer | Technology |
|-------|-----------|
| Storage | **Walrus** — decentralized blob storage |
| Encryption | **SEAL** (Mysten Labs) — threshold encryption, policy-gated decryption |
| Settlement | **Sui** — on-chain micropayments in USDC |
| Language | **Move** — type-safe smart contracts |
| SDK | **TypeScript** — `@axiomtide/conk-sdk` on npm |

---

## How It Works

```
1. Author uploads file to Walrus (encrypted with SEAL off-chain)
2. Author calls chest::open() on Sui — commits blobId + sealId, pays open fee
3. Chest is a shared object. Anyone can call chest::access() and pay the fee
4. On access: 97% → author, 3% → protocol Abyss treasury
5. ChestAccessed event emits blob_id + seal_id — reader fetches + decrypts
6. Author can burn (destroy on-chain gate) or extend (more Walrus epochs)
```

The blob stays on Walrus. The SEAL policy controls who can decrypt. CONK controls who pays to get the reference and key.

---

## Three Size Tiers

| Tier | Max Size | Open Fee |
|------|----------|----------|
| Nano | 100 KB | $0.05 |
| Standard | 1 MB | $0.10 |
| Large | 10 MB | $0.25 |

---

## Live Contracts

| Item | Address |
|------|---------|
| CONK Package (v9) | `0x7bc8f81b03cede714045a9f24e5f776fc449000c9414e33908ebe177d3b5ac2b` |
| Abyss (protocol treasury) | `0x392d5f46b5f02fb34cc0cb06c27e89b6e4dacc4cafd41e3b9ac1bc9f02dd1598` |
| Network | Sui Mainnet |

---

## SDK

```bash
npm install @axiomtide/conk-sdk
```

```typescript
import { ConkClient } from '@axiomtide/conk-sdk'

const conk = new ConkClient({ network: 'mainnet', privateKey: process.env.SUI_PRIVATE_KEY })

// Open a Chest (author flow)
// 1. Encrypt your file with SEAL off-chain
// 2. Upload to Walrus, get blobId
// 3. Commit on-chain:
const chest = await conk.chest.open({
  blobId:    'your-walrus-blob-id',
  sealId:    'your-seal-policy-id',
  tier:      'standard',         // 'nano' | 'standard' | 'large'
  sizeBytes: 524288,             // actual file size
  accessFee: 0.10,               // USD — 0 for free access
  epochs:    5,                  // Walrus storage duration (~35 days)
})

// Access a Chest (reader flow)
const result = await conk.chest.access({
  chestId: chest.chestId,
  // blobId + sealId returned in ChestAccessed event
  // use these to fetch from Walrus and decrypt with SEAL
})
```

---

## Why Walrus

Walrus solves the only real problem with on-chain file storage: cost and permanence.

- Storing a 1 MB file on Walrus costs ~$0.000001 per KB per epoch (14 days)
- 10,000 standard Chests stored for one year costs **under $1.00 total**
- Walrus blobs survive even if the uploader disappears — erasure coding distributes across nodes
- CONK holds 2,500 WAL for storage sponsorship

When a Chest is burned, the on-chain gate (blobId + sealId) is zeroed out. The blob persists on Walrus but is permanently undecryptable. This is the correct behavior: burning destroys access, not data.

---

## Why SEAL

SEAL's threshold encryption means no single key holder can decrypt content unilaterally. The decryption key is only assembled when the SEAL policy conditions are met — in CONK's case, that means the `ChestAccessed` event was emitted with a valid payment.

This makes Chest genuinely access-controlled at the cryptographic level, not just at the application layer.

---

## Repository Structure

```
protocol/
  sources/
    chest.move          ← Chest primitive (this submission)
    abyss.move          ← Protocol treasury — handles all fee routing
    cast.move           ← Cast primitive (pre-existing)
    harbor.move         ← Harbor (wallet) primitive
    vessel.move         ← Vessel (identity) primitive
    drift.move          ← Drift (feed) primitive
    siren.move          ← Siren (broadcast) primitive
    relay.move          ← Relay primitive
    lighthouse.move     ← Lighthouse primitive

apps/conk/              ← conk.app — live UI
upgrade-chest.mjs       ← Deployment script (mainnet upgrade PTB)
PROTOCOL.md             ← Full CONK protocol paper
```

---

## What Chest Enables

| Use Case | How |
|----------|-----|
| Paid research reports | Author uploads PDF → Walrus + SEAL + Chest |
| Agent knowledge bases | Daemon uploads dataset → access-gated for other agents |
| Encrypted messages | Eyes-Only Casts upgraded to file-level |
| AI model weights (nano) | Sub-100KB model snapshots, agent-to-agent transfer |
| Software licenses | Binary or config gated behind USDC micropayment |
| Live → VOD | Stream ends → recording uploaded to Chest for replay access |

---

## Team

**Axiom Tide LLC** — Wyoming  
CTO: Franklin (AI orchestration) · Founder: Jauert (iTalktonumbers)  
Website: [axiomtide.com](https://axiomtide.com) · Protocol: [conk.app](https://conk.app)

---

## Live Demo

See the demo video for a full walkthrough: `chest::open` → `chest::access` → Walrus fetch → SEAL decrypt — all on Sui mainnet.

*Chest is Primitive 8 of 8 in the CONK protocol. It runs alongside Cast, Harbor, Vessel, Drift, Dock, Siren, and Lighthouse — all live on Sui mainnet since April 2026.*
