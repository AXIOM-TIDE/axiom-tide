# CONK × Tatum × Walrus Hackathon

**Submission Deadline:** June 6, 2026  
**Event:** Tatum × Walrus Hackathon

---

## What We Built

**CONK Chest** — a permissionless encrypted file vault with on-chain access control and instant creator payout, built on Walrus + SEAL + Sui.

- Author encrypts a file with SEAL, uploads to Walrus, commits to Sui via `chest-open`
- Reader pays a fee in USDC, calls `chest-access`, receives the blobId + sealId to decrypt
- **97% of every payment goes directly to the author's wallet — instantly**
- 3% to the CONK protocol treasury
- No backend. No login. No platform. Just math.

---

## Live Links

| Resource | URL |
|----------|-----|
| App | https://www.conk.app |
| npm | https://npmjs.com/package/@axiomtide/conk-sdk |
| GitHub | https://github.com/AXIOM-TIDE/CONK |
| Demo Video | *(YouTube URL — upload before June 6)* |

---

## Package Addresses (Sui Mainnet)

| Package | Address |
|---------|---------|
| CONK v8 (Chest) | `0x5b2581953997faa81c3294d1ed5619ad9f1acf2883197727a54c6a0cbdb067f3` |
| CONK v9 (Stream) | `0x7bc8f81b03cede714045a9f24e5f776fc449000c9414e33908ebe177d3b5ac2b` |
| Abyss (shared) | `0x392d5f46b5f02fb34cc0cb06c27e89b6e4dacc4cafd41e3b9ac1bc9f02dd1598` |

---

## SDK Quick Start

```bash
npm install @axiomtide/conk-sdk
```

```typescript
import { ConkClient } from '@axiomtide/conk-sdk'

const conk = new ConkClient({ network: 'mainnet', privateKey: key })

// Open a Chest (author)
const chest = await conk.chest.open({
  blobId: 'your-walrus-blob-id',
  sealId: 'your-seal-policy-id',
  tier: 'standard',   // $0.10 access fee
})

// Access a Chest (reader — pays fee, gets blob + seal refs)
const access = await conk.chest.access({ chestId: chest.chestId })
```

---

## Architecture

```
Author → Encrypt file (SEAL) → Upload to Walrus → chest-open (Sui)
                                                        ↓
Reader → chest-access → Pay USDC → ChestAccessed event (blobId + sealId)
                                        ↓
                          Fetch from Walrus → Decrypt with SEAL → File ✓
```

---

## Protocol Primitives (8 of 9 live on mainnet)

| Primitive | Description |
|-----------|-------------|
| Harbor | On-chain identity / wallet |
| Vessel | Named identity with storage |
| Cast | Encrypted message with USDC paywall |
| Dock | Inbox + claimed content |
| Drift | Open on-chain feed |
| Lighthouse | Content discovery |
| Siren | Subscription streams |
| **Chest** | Encrypted file vault (Walrus + SEAL) ← **hackathon entry** |
| Stream | Streaming content sessions |

---

## Checklist

- [x] Chest primitive deployed on Sui mainnet
- [x] SDK v0.3.0 published to npm
- [x] Demo video recorded (2:55, 1080p)
- [x] GitHub repo cleaned and documented
- [x] PROTOCOL.md with full fee table
- [ ] YouTube demo URL (upload before June 6)
- [ ] Registration on hackathon portal (opens May 23)
- [ ] Final submission
