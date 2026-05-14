# CONK Bridge — Architecture Specification

**Phase 1 (MVP): The Bridge**
Google sign-in → auto-provision Harbor + Vessel on-chain → agent can transact immediately

---

## 1. zkLogin Flow

### What exists

`apps/conk/src/sui/zklogin.ts` implements full browser-side zkLogin:

1. **`startZkLogin()`** — generates an ephemeral Ed25519 keypair, randomness, and a nonce from the current epoch. Stores all three in `sessionStorage`. Redirects to Google OAuth with the nonce embedded so the JWT is cryptographically bound to the ephemeral key.

2. **`handleZkLoginCallback()`** — called on OAuth return. Parses the `id_token` from the URL fragment. Generates (or reuses) a locally-stored salt. Computes the `addressSeed` via `genAddressSeed(salt, 'sub', sub, aud)`. Calls the Enoki ZK prover at `https://api.enoki.mystenlabs.com/v1/zklogin/zkp` to get a ZK proof. Derives the deterministic Sui address via `jwtToAddress(jwt, salt)`. Stores the session in `sessionStorage`.

3. **`signWithZkLogin(txBytes, session)`** — reconstructs the ephemeral keypair from `sessionStorage`, signs the transaction bytes, assembles the zkLogin signature via `getZkLoginSignature({ inputs: proof, maxEpoch, userSignature })`.

4. **`getSession()` / `isLoggedIn()` / `hasProof()` / `getAddress()`** — session state helpers.

### Address derivation

```
Google sub (stable user ID)
  + locally-stored salt (16 bytes, never leaves device)
  + aud (client ID)
  ──→ addressSeed
  ──→ Enoki returns a ZK proof covering this addressSeed
  ──→ computeZkLoginAddressFromSeed(addressSeed, "https://accounts.google.com")
  = deterministic Sui address (stable for same Google account + salt)
```

### Salt storage

Salt is stored in `localStorage` — it persists across browser sessions but only on the originating device. If localStorage is cleared, the address changes. **This is the current limitation** — salt is not backed up server-side. Phase 2 hardening should use server-side salt storage tied to the Google sub.

### Session lifecycle

- Session lives in `sessionStorage` — cleared on tab close.
- Ephemeral keypair valid until `maxEpoch` (current epoch + 10 ≈ ~10 hours on Sui mainnet).
- If proof expires, user must re-authenticate via Google. All on-chain objects persist.

---

## 2. Auto-Provision (The Bridge — Phase 1)

### The gap

Current `Onboarding.tsx` flow:
```ts
const vesselId = `v_${Math.random().toString(36).slice(2,10)}`  // FAKE, never on-chain
addVessel({ id: vesselId, ... })  // local state only
setOnboarded(true)
```

The user has a real Sui address (from zkLogin) but no Harbor or Vessel exists on-chain. Until Harbor+Vessel exist, the user can't cast, read, or transact in the protocol.

### What triggers provisioning

After zkLogin callback → `provisionOnChainIdentity(session)` is called in the `launch()` function of Onboarding. This runs immediately after the Google sign-in completes.

### Harbor + Vessel creation

```
provisionOnChainIdentity(session):
  1. Query suix_getOwnedObjects for HarborCap (CONK package) owned by session.address
  2. If HarborCap found → Harbor already exists (idempotent, skip harbor::open)
  3. If not → call openHarbor(tier=1):
       - Splits 150,000 USDC microunits ($0.015) from user's USDC coin
       - Calls harbor::open(payment, tier, clock) → returns HarborCap
       - Transfers HarborCap to session.address
  4. Query for VesselCap owned by session.address
  5. If not found → call launchVessel(harborId, harborCapId):
       - Calls vessel::launch(harbor, tier=0, burnAfterCast=false, clock)
       - Returns VesselCap (owned) and Vessel (shared)
```

### Gas sponsorship model

All SUI gas is sponsored by the zkProxy Cloudflare Worker. Users pay **zero SUI**. Users pay only USDC fees:
- Harbor creation: **$0.015 USDC** (150,000 microunits, paid to Abyss)
- Vessel launch: **free** (no USDC required — Vessel creation draws from Harbor)

The gas wallet on the worker is topped up manually. Circuit breaker at 0.5 SUI pauses sponsorship before wallet empties.

### Idempotency

`provisionOnChainIdentity()` queries on-chain state before any transaction:
- HarborCap exists → skip `harbor::open`, return existing IDs
- VesselCap exists → skip `vessel::launch`, return existing IDs
- No USDC → return `{ harborId: null, vesselId: null, funded: false }`

Safe to call multiple times. No double-provisioning.

### No-USDC case

`openHarbor()` requires USDC (`getUsdcCoins()` throws if balance is zero). The bridge catches this and returns a partial result:

```ts
{ harborId: null, vesselId: null, vesselCapId: null, funded: false }
```

The UI falls back to a local stub vessel (same as current behavior) and shows a "Fund your Harbor to activate" prompt. The user funds their address with USDC, then re-runs provision.

---

## 3. CCTP Integration (Phase 2)

### Circle CCTP on Sui

Circle Cross-Chain Transfer Protocol (CCTP) is live on Sui mainnet. It enables native USDC to burn on a source chain and mint on Sui (not wrapped — canonical USDC).

**Architecture:**
```
Source chain (e.g., Base/ETH)
  → User approves USDC transfer to CCTP Token Messenger
  → CCTP burns USDC on source
  → Circle's Attestation Service issues a signed attestation
  → Sui CCTP Message Transmitter verifies attestation
  → Mints canonical USDC to destination address on Sui
```

### What we need to build

**Relay Worker endpoint** (`POST /bridge/cctp-relay`):
- Receives `{ sourceChain, burnTxHash, destinationAddress }`
- Polls Circle Attestation Service (`https://iris.circle.com/v1/attestations/{messageHash}`)
- Once attested: submits mint tx on Sui side via gas-sponsored transaction
- Returns `{ suiTxDigest, usdcAmount }`

**Bridge UI** (Phase 2 screen):
- Source chain selector (Base, ETH, Arbitrum)
- "Bridge USDC to your Harbor" flow
- Status display: pending → attested → minted

**Third-party relay options:**
- LayerZero, deBridge, and Jumper Finance all support CCTP on Sui
- Phase 2 decision: build own relay vs. integrate third-party
- Recommendation: start with a third-party relay (embed Jumper widget or use deBridge API), own relay in Phase 3 for full control and fee capture

### Multi-chain wallet support

External agents (Base x402, Solana Pay, ETH EIP-681) reach the protocol via The Bridge:

```
External agent has USDC on Base/ETH/Solana
  → Bridge detects source chain + amount
  → CCTP burn on source
  → Relay worker attests + mints on Sui
  → provisionOnChainIdentity() auto-creates Harbor+Vessel
  → Agent receives { suiAddress, harborId, vesselId }
  → Agent can transact immediately
```

This makes The Bridge a universal entry point — any agent on any chain with USDC can join the protocol.

---

## 4. Security

### Salt storage
- **Current**: `localStorage` — vulnerable to XSS, lost on clear
- **Phase 2**: Encrypt salt with Google OIDC token, store on server indexed by sub-hash (never raw sub)

### Session expiry
- Ephemeral key expires at `maxEpoch` (~10 hours)
- After expiry, user re-auths with Google — new keypair, same address (same salt + sub)
- Transactions with expired sessions are rejected by zkLogin verification

### Gas rate limits (enforced on zkProxy worker)
| Endpoint | Limit |
|---|---|
| `/gas` | 50 per IP per hour |
| `/zkproof` | 30 per IP per hour |
| `/sui` (RPC) | 200 per IP per hour |
| `/bridge/provision` | 5 per IP per hour |

### Proof replay attacks
- ZK proofs are epoch-bound (`maxEpoch` in the proof)
- Expired proofs are rejected by Sui validators
- No server-side proof deduplication needed (chain enforces epoch)

### Harbor dust griefing
- Harbor creation costs USDC — not free. Eliminates spam account creation.
- Harbor objects are owned (not shared) — no griefing via shared object contention
- The $0.015 creation fee acts as a sybil barrier

### CORS boundary
- zkProxy Worker: `ALLOWED_ORIGINS` whitelist — only `conk.app` and localhost
- Agent API (Phase 2): separate worker or route prefix, API-key authenticated
- Browser UI never exposes gas private key — it only receives sponsored bytes

---

## 5. MVP Scope — Phase 1 Done Criteria

Phase 1 (The Bridge MVP) is complete when:

1. ✅ **`bridge.ts`** — `provisionOnChainIdentity()` implemented, idempotent, handles no-USDC gracefully
2. ✅ **`Onboarding.tsx`** — fake `v_${random}` vessel ID replaced with real on-chain IDs; fallback to local stub on failure
3. ✅ **`worker.js`** — `POST /bridge/provision` endpoint for non-browser agents; rate-limited; idempotency check
4. **User journey**: Google sign-in → USDC in wallet → Harbor+Vessel created on-chain in same session → user can cast immediately

**Not in Phase 1:**
- CCTP bridge (Phase 2)
- Multi-chain agent onboarding (Phase 2)
- Server-side salt backup (Phase 2 security hardening)
- Browser wallet bridge (wallets already provision via their own flow)

---

*Axiom Tide LLC — CONK Protocol v2 — May 2026*
