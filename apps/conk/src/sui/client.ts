/**
 * CONK Sui Client — Mainnet
 * All blockchain calls via raw JSON-RPC — no SDK version dependency.
 * Gas sponsored via Cloudflare Worker. Users never pay gas.
 */

import { ADDRESSES, PACKAGES, RPC } from './index'
import { getSession, signWithZkLogin } from './zklogin'
import { isWalletSession, signWithWallet } from './walletSession'

export const NETWORK   = 'mainnet'
export const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
export const SUI_RPC   = 'https://fullnode.mainnet.sui.io:443'

const PROXY   = RPC.PROXY
const PACKAGE = PACKAGES.CONK
const ABYSS   = ADDRESSES.ABYSS
const CLOCK   = '0x6'

// ── Raw RPC call ──────────────────────────────────────────────
async function rpc(method: string, params: any[]): Promise<any> {
  const resp = await fetch(`${PROXY}/sui`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await resp.json()
  if (json.error) throw new Error('RPC error: ' + JSON.stringify(json.error))
  return json.result
}

// ── Get USDC coins ────────────────────────────────────────────
async function getUsdcCoins(address: string): Promise<any[]> {
  const result = await rpc('suix_getCoins', [address, USDC_TYPE, null, 10])
  if (!result?.data?.length) throw new Error('No USDC — fund your Harbor address first')
  return result.data
}

// ── Get Sui client (for Transaction building only) ────────────
let _client: unknown = null
export async function getSuiClient() {
  if (_client) return _client
  const { SuiClient } = await import('@mysten/sui/client')
  _client = new SuiClient({ url: SUI_RPC })
  return _client as InstanceType<typeof import('@mysten/sui/client').SuiClient>
}

// ── Read on-chain USDC balance ────────────────────────────────
export async function getUsdcBalance(address: string): Promise<number> {
  try {
    const result = await rpc('suix_getBalance', [address, USDC_TYPE])
    const total  = Number(result?.totalBalance ?? 0)
    return Math.floor(total / 10000)
  } catch (e) {
    console.warn('Balance read failed:', e)
    return 0
  }
}

// ── Sign transaction ──────────────────────────────────────────
async function signTx(txBytes: string): Promise<{ bytes: string; signature: string }> {
  const session = getSession()
  if (!session) throw new Error('No session — please connect')
  const authType = (session as any).authType
  const walletName = sessionStorage.getItem('wallet_name')
  console.log('[signTx] authType:', authType, 'wallet_name:', walletName)
  if (authType === 'wallet' && walletName) return signWithWallet(txBytes)
  // Clear any stale wallet_name
  sessionStorage.removeItem('wallet_name')
  return signWithZkLogin(txBytes, session)
}

// ── Sponsor gas via Cloudflare Worker ─────────────────────────
export async function sponsorTx(tx: unknown, sender: string): Promise<{ sponsoredBytes: string; sponsorSig: string }> {
  const { Transaction } = await import('@mysten/sui/transactions')
  const { toB64 }       = await import('@mysten/sui/utils')
  const client          = await getSuiClient()

  // Build transaction kind only — worker adds gas
  const txBytes = await (tx as InstanceType<typeof Transaction>).build({
    client:              client as any,
    onlyTransactionKind: true,
  })

  const response = await fetch(`${PROXY}/gas`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ txBytes: toB64(txBytes), sender }),
  })

  if (!response.ok) throw new Error('Gas sponsor error: ' + response.status)
  const json = await response.json()
  if (json.error) throw new Error('Gas sponsor error: ' + json.error)
  return json
}

// ── Execute transaction via raw RPC ───────────────────────────
async function executeTx(tx: unknown, sender: string): Promise<any> {
  const { sponsoredBytes, sponsorSig } = await sponsorTx(tx, sender)
  const { bytes, signature }           = await signTx(sponsoredBytes)

  const result = await rpc('sui_executeTransactionBlock', [
    bytes,
    [signature, sponsorSig],
    { showEffects: true, showObjectChanges: true, showEvents: true },
    'WaitForLocalExecution',
  ])

  if (result?.effects?.status?.status !== 'success') {
    throw new Error('Transaction failed: ' + JSON.stringify(result?.effects?.status))
  }
  return result
}

// ── Open Harbor on-chain ──────────────────────────────────────
export async function openHarbor(tier: number = 1): Promise<{ harborId: string; harborCapId: string }> {
  const session = getSession()
  if (!session) throw new Error('No session')

  const { Transaction } = await import('@mysten/sui/transactions')
  const tx     = new Transaction()
  const coins  = await getUsdcCoins(session.address)

  const [payment] = tx.splitCoins(tx.object(coins[0].coinObjectId), [tx.pure.u64(150000)])

  const harborCap = tx.moveCall({
    target:    `${PACKAGE}::harbor::open`,
    arguments: [payment, tx.pure.u8(tier), tx.object(CLOCK)],
  })

  tx.transferObjects([harborCap], tx.pure.address(session.address))
  tx.setSender(session.address)

  const result = await executeTx(tx, session.address)
  const created = result.objectChanges?.filter((c: any) => c.type === 'created') ?? []
  const harborObj    = created.find((c: any) => c.objectType?.includes('::harbor::Harbor'))
  const harborCapObj = created.find((c: any) => c.objectType?.includes('::harbor::HarborCap'))

  if (!harborObj || !harborCapObj) throw new Error('Harbor creation failed')

  return { harborId: harborObj.objectId, harborCapId: harborCapObj.objectId }
}

// ── Launch Vessel on-chain ────────────────────────────────────
export async function launchVessel(
  harborId: string,
  harborCapId: string,
  burnAfterCast: boolean = false
): Promise<{ vesselId: string; vesselCapId: string }> {
  const session = getSession()
  if (!session) throw new Error('No session')

  const { Transaction } = await import('@mysten/sui/transactions')
  const tx = new Transaction()

  const vesselCap = tx.moveCall({
    target:    `${PACKAGE}::vessel::launch`,
    arguments: [
      tx.object(harborId),
      tx.pure.u8(0),
      tx.pure.bool(burnAfterCast),
      tx.object(CLOCK),
    ],
  })

  tx.transferObjects([vesselCap], tx.pure.address(session.address))
  tx.setSender(session.address)

  const result = await executeTx(tx, session.address)
  const created = result.objectChanges?.filter((c: any) => c.type === 'created') ?? []
  const vesselObj    = created.find((c: any) => c.objectType?.includes('::vessel::Vessel'))
  const vesselCapObj = created.find((c: any) => c.objectType?.includes('::vessel::VesselCap'))

  if (!vesselObj || !vesselCapObj) throw new Error('Vessel launch failed')

  return { vesselId: vesselObj.objectId, vesselCapId: vesselCapObj.objectId }
}

// ── Cross Paywall ─────────────────────────────────────────────
export async function crossPaywall(opts: {
  vesselId:       string
  castId:         string
  amountUsdc:     number
  authorAddress?: string
  price?:         number
  harborId?:      string
  harborCapId?:   string
  vesselCapId?:   string
}): Promise<string> {
  const session = getSession()
  if (!session) return 'mock_tx_' + Date.now()

  const { Transaction } = await import('@mysten/sui/transactions')
  const tx    = new Transaction()
  const coins = await getUsdcCoins(session.address)

  const totalAmount    = opts.amountUsdc
  const authorAmount   = Math.floor(totalAmount * 0.97)
  const treasuryAmount = totalAmount - authorAmount
  const hasAuthor      = opts.authorAddress && opts.authorAddress !== opts.vesselId
  const usdcCoinObj    = tx.object(coins[0].coinObjectId)

  if (hasAuthor && authorAmount > 0) {
    const [authorPayment, treasuryPayment] = tx.splitCoins(usdcCoinObj, [
      tx.pure.u64(authorAmount),
      tx.pure.u64(treasuryAmount),
    ])
    tx.transferObjects([authorPayment],   tx.pure.address(opts.authorAddress!))
    tx.transferObjects([treasuryPayment], tx.pure.address(ADDRESSES.TREASURY))
  } else {
    const [usdcPayment] = tx.splitCoins(usdcCoinObj, [tx.pure.u64(totalAmount)])
    tx.transferObjects([usdcPayment], tx.pure.address(ADDRESSES.TREASURY))
  }

  tx.setSender(session.address)
  const result = await executeTx(tx, session.address)
  return result.digest
}

// ── SEAL: AES-256-GCM helpers ───────────────────────────────
// Internal use only. Not exported — only called via soundCast() and decryptCastBody().

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '')
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function encryptBodyForCast(
  plaintext: string,
): Promise<{ encryptedBytes: Uint8Array; key: string; iv: string }> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32))
  const ivBytes  = crypto.getRandomValues(new Uint8Array(12))
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt'],
  )
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBytes },
    cryptoKey,
    new TextEncoder().encode(plaintext),
  )
  return {
    encryptedBytes: new Uint8Array(ciphertext),
    key: bytesToHex(keyBytes),
    iv:  bytesToHex(ivBytes),
  }
}

async function decryptBodyBytes(
  encryptedBytes: Uint8Array,
  key:  string,
  iv:   string,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', hexToBytes(key), { name: 'AES-GCM' }, false, ['decrypt'],
  )
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBytes(iv) },
    cryptoKey,
    encryptedBytes,
  )
  return new TextDecoder().decode(plaintext)
}

// Upload encrypted bytes to Walrus via zkProxy.
async function uploadEncryptedToWalrus(bytes: Uint8Array): Promise<string> {
  const resp = await fetch(`${PROXY}/walrus-upload?epochs=8`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body:    bytes,
  })
  if (!resp.ok) throw new Error(`Walrus upload failed: ${resp.status}`)
  const data = await resp.json() as {
    newlyCreated?:     { blobObject: { blobId: string } }
    alreadyCertified?: { blobId: string }
  }
  const blobId = data.newlyCreated?.blobObject?.blobId ?? data.alreadyCertified?.blobId
  if (!blobId) throw new Error('Walrus upload returned no blobId')
  return blobId
}

// Register cast encryption key with zkProxy after sound() tx confirms.
async function registerCastKey(
  castId: string,
  key:    string,
  iv:     string,
  blobId: string,
): Promise<void> {
  const resp = await fetch(`${PROXY}/cast-key`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ castId, key, iv, blobId }),
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(`Key registration failed: ${(err as any).error ?? resp.status}`)
  }
}

// Request decryption key from zkProxy after readCast() tx confirms.
// Verifies the on-chain CastRead event server-side before releasing key.
export async function decryptCastBody(
  castId:        string,
  txDigest:      string,
  readerAddress: string,
): Promise<string> {
  // Request key from zkProxy — verifies tx on-chain before releasing
  const resp = await fetch(`${PROXY}/cast-decrypt`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ castId, txDigest, address: readerAddress }),
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error((err as any).error ?? `Decryption denied: ${resp.status}`)
  }
  const { key, iv, blobId } = await resp.json() as { key: string; iv: string; blobId: string }

  // Fetch encrypted bytes from Walrus
  const walrusResp = await fetch(`${ADDRESSES.WALRUS_AGG}/v1/${blobId}`)
  if (!walrusResp.ok) throw new Error(`Walrus fetch failed: ${walrusResp.status}`)
  const encryptedBytes = new Uint8Array(await walrusResp.arrayBuffer())

  // Decrypt client-side — key never leaves the reader's browser after this point
  return decryptBodyBytes(encryptedBytes, key, iv)
}

// ── Read a Cast on-chain (v5) ─────────────────────────────────
// Calls the Move cast::read function directly. Contract handles:
//   • 97/3 split routing (97% to cast.author, 3% to Abyss)
//   • EYES_ONLY Dock gating (claims_used < max_claims)
//   • read_count increment, CastRead event
//   • DockClaimed event (for EYES_ONLY reads)
//   • Burn-on-read for GHOST, burn-when-Dock-full for EYES_ONLY
export async function readCast(opts: {
  castId:     string  // Sui object ID of the Cast to read
  amountUsdc: number  // Full payment amount (contract does 97/3 split)
}): Promise<{ digest: string; castId: string; readerAddress: string }> {
  const session = getSession()
  if (!session) throw new Error('No session')

  const { Transaction } = await import('@mysten/sui/transactions')
  const { getAddress }  = await import('./zklogin')
  const tx     = new Transaction()
  const reader = getAddress() ?? session.address
  const coins  = await getUsdcCoins(session.address)

  // Split out exactly amountUsdc into a fresh Coin<USDC> for the contract.
  // Contract will handle the split internally.
  const [feeCoin] = tx.splitCoins(tx.object(coins[0].coinObjectId), [
    tx.pure.u64(opts.amountUsdc),
  ])

  tx.moveCall({
    target: `${PACKAGE}::cast::read`,
    arguments: [
      tx.object(opts.castId),     // &mut Cast
      feeCoin,                    // Coin<USDC>
      tx.object(ABYSS),           // &mut Abyss
      tx.pure.address(reader),    // reader: address (for DockClaimed)
      tx.object(CLOCK),           // &Clock
    ],
  })

  tx.setSender(session.address)
  const result = await executeTx(tx, session.address)
  return { digest: result.digest, castId: opts.castId, readerAddress: reader }
}

// ── Fetch a Cast object by ID and map to frontend shape (v5) ──
// Used by the Flare reader to hydrate a cast from its URL into the store.
// Returns null if the object doesn't exist, is the wrong type, or fetch fails.
export interface OnChainCastView {
  id:                 string
  hook:               string
  body:               string              // empty if sealed/eyes_only/burn and not yet read
  mode:               'open' | 'sealed' | 'eyes_only' | 'burn'
  duration:           '24h' | '48h' | '72h' | '7d'
  createdAt:          number
  expiresAt:          number
  readCount:          number
  burned:             boolean
  isLighthouse:       boolean
  feePaid:            number              // the cast's read price in microUSDC
  author:             string              // v5: explicit author address
  recipient:          string              // for SEALED casts
  maxClaims:          number              // v5: Dock seat count
  claimsUsed:         number              // v5: seats consumed so far
  claimsRemaining:    number              // v5: derived
  isDockFull:         boolean             // v5: derived
  dockDescription:    string              // v5: optional Dock invitation text
  vesselId:           string              // on-chain vessel reference
  vesselTier:         number
}

export async function fetchCastById(castId: string): Promise<OnChainCastView | null> {
  try {
    const result = await rpc('sui_getObject', [
      castId,
      { showContent: true, showType: true },
    ])

    if (!result?.data?.content) {
      console.warn('[fetchCastById] no content for', castId)
      return null
    }

    const type = result.data.type as string
    if (!type || !type.includes('::cast::Cast')) {
      console.warn('[fetchCastById] object is not a Cast:', type)
      return null
    }

    const f = result.data.content.fields as any

    // Hook and body are stored as vector<u8> — decode to utf-8 string
    const decodeBytes = (arr: any): string => {
      if (!arr) return ''
      // Already a string (some RPC shapes)
      if (typeof arr === 'string') return arr
      // Array of numbers
      if (Array.isArray(arr)) {
        try { return new TextDecoder().decode(new Uint8Array(arr)) } catch { return '' }
      }
      return ''
    }

    // Map Move enum u8 -> frontend string
    const modeMap: Record<number, OnChainCastView['mode']> = {
      0: 'open',
      1: 'sealed',
      2: 'eyes_only',
      3: 'burn',
    }
    const durationMap: Record<number, OnChainCastView['duration']> = {
      1: '24h',
      2: '48h',
      3: '72h',
      4: '7d',
    }

    const modeNum     = Number(f.mode ?? 0)
    const durationNum = Number(f.duration ?? 1)
    const stateNum    = Number(f.state ?? 0)
    const maxClaims   = Number(f.max_claims ?? 1)
    const claimsUsed  = Number(f.claims_used ?? 0)

    return {
      id:              castId,
      hook:            decodeBytes(f.hook),
      // ⚠ SECURITY: blank body for paid casts — content gated behind readCast().
      // Free casts (fee_paid === 0) and burned casts are unaffected.
      // Paid content must be fetched via fetchCastBodyRaw() immediately before readCast().
      body:            Number(f.fee_paid ?? 0) > 0 ? '' : decodeBytes(f.content_blob),
      mode:            modeMap[modeNum]          ?? 'open',
      duration:        durationMap[durationNum]  ?? '24h',
      createdAt:       Number(f.created_at ?? 0),
      expiresAt:       Number(f.expires_at ?? 0),
      readCount:       Number(f.read_count ?? 0),
      burned:          stateNum === 1,
      isLighthouse:    Boolean(f.is_lighthouse),
      feePaid:         Number(f.fee_paid ?? 0),
      author:          String(f.author ?? ''),
      recipient:       String(f.recipient ?? ''),
      maxClaims,
      claimsUsed,
      claimsRemaining: Math.max(0, maxClaims - claimsUsed),
      isDockFull:      claimsUsed >= maxClaims,
      dockDescription: decodeBytes(f.dock_description),
      vesselId:        String(f.vessel_id ?? ''),
      vesselTier:      Number(f.vessel_tier ?? 1),
    }
  } catch (err) {
    console.error('[fetchCastById] fetch failed:', err)
    return null
  }
}

// ── Fetch raw content_blob for pre-payment capture ─────────────
// ONLY call this in payment flows, right before readCast().
// Never use for display without a confirmed on-chain payment transaction.
export async function fetchCastBodyRaw(castId: string): Promise<string> {
  try {
    const result = await rpc('sui_getObject', [castId, { showContent: true }])
    const f = result?.data?.content?.fields as any
    if (!f?.content_blob) return ''
    if (typeof f.content_blob === 'string') return f.content_blob
    if (Array.isArray(f.content_blob)) {
      try { return new TextDecoder().decode(new Uint8Array(f.content_blob)) } catch { return '' }
    }
    return ''
  } catch { return '' }
}

// ── Fetch Open casts for the Drift feed ───────────────────────
// Queries CastSounded events where mode = 0 (Open), hydrates each via fetchCastById.
// Flares (mode=2) are NEVER returned — privacy rule enforced at query level.
export async function fetchDriftCasts(): Promise<Array<{
  id: string; hook: string; body: string; mode: 'open';
  createdAt: number; expiresAt: number; readCount: number;
  feePaid: number; author: string; isLighthouse: boolean;
  maxClaims: number; claimsUsed: number;
}>> {
  try {
    const events = await rpc('suix_queryEvents', [
      { MoveEventType: `${PACKAGE}::cast::CastSounded` },
      null, 50, true,
    ])
    if (!events?.data) return []

    // Filter to Open casts only (mode=0) — NEVER include Flares
    const openEvents = events.data.filter((e: any) => e.parsedJson?.mode === 0)

    const casts = []
    for (const ev of openEvents) {
      const castId = ev.parsedJson?.cast_id
      if (!castId) continue
      const cast = await fetchCastById(castId)
      if (!cast || cast.burned) continue
      // Skip expired non-lighthouse casts
      if (!cast.isLighthouse && cast.expiresAt < Date.now()) continue
      casts.push({
        id:           cast.id,
        hook:         cast.hook,
        body:         cast.body,
        mode:         'open' as const,
        createdAt:    cast.createdAt,
        expiresAt:    cast.expiresAt,
        readCount:    cast.readCount,
        feePaid:      cast.feePaid,
        author:       cast.author,
        isLighthouse: cast.isLighthouse,
        maxClaims:    cast.maxClaims,
        claimsUsed:   cast.claimsUsed,
      })
    }
    return casts
  } catch (err) {
    console.error('[fetchDriftCasts] failed:', err)
    return []
  }
}

// ── Query Flares sent by an author ─────────────────────────────
// Returns CastSounded events where sender = authorAddress and mode = EYES_ONLY (2)
export async function fetchSentFlares(authorAddress: string): Promise<Array<{
  castId: string; hook: string; mode: number; createdAt: number; expiresAt: number
}>> {
  try {
    const events = await rpc('suix_queryEvents', [
      { MoveEventType: `${PACKAGE}::cast::CastSounded` },
      null, 50, true,  // cursor, limit, descending
    ])
    if (!events?.data) return []
    return events.data
      .filter((e: any) => e.sender === authorAddress && e.parsedJson?.mode === 2)
      .map((e: any) => ({
        castId:    e.parsedJson.cast_id,
        hook:      (() => {
          const arr = e.parsedJson.hook
          if (!arr || typeof arr === 'string') return arr ?? ''
          try { return new TextDecoder().decode(new Uint8Array(arr)) } catch { return '' }
        })(),
        mode:      e.parsedJson.mode,
        createdAt: Number(e.parsedJson.created_at ?? 0),
        expiresAt: Number(e.parsedJson.expires_at ?? 0),
      }))
  } catch (err) {
    console.error('[fetchSentFlares] failed:', err)
    return []
  }
}

export interface DockClaimEvent {
  castId:     string
  claimsUsed: number
  maxClaims:  number
  claimedAt:  number
  sender:     string
}

function mapDockClaimEvent(e: any): DockClaimEvent {
  return {
    castId:     e.parsedJson.cast_id,
    claimsUsed: Number(e.parsedJson.claims_used ?? 0),
    maxClaims:  Number(e.parsedJson.max_claims ?? 0),
    claimedAt:  Number(e.parsedJson.claimed_at ?? 0),
    sender:     e.sender ?? '',
  }
}

async function fetchDockClaimEvents(): Promise<DockClaimEvent[]> {
  const events = await rpc('suix_queryEvents', [
    { MoveEventType: `${PACKAGE}::cast::DockClaimed` },
    null, 50, true,
  ])
  if (!events?.data) return []
  return events.data.map(mapDockClaimEvent)
}

// ── Query Docks claimed by a reader ───────────────────────────
// Returns DockClaimed events where sender = readerAddress
export async function fetchClaimedDocks(readerAddress: string): Promise<Array<{
  castId: string; claimsUsed: number; maxClaims: number; claimedAt: number
}>> {
  try {
    return (await fetchDockClaimEvents())
      .filter((e) => e.sender === readerAddress)
      .map(({ castId, claimsUsed, maxClaims, claimedAt }) => ({ castId, claimsUsed, maxClaims, claimedAt }))
  } catch (err) {
    console.error('[fetchClaimedDocks] failed:', err)
    return []
  }
}

// ── Query claim events for a specific cast ────────────────────
// Author-side Return Flare uses this to enforce the 48h window.
export async function fetchDockClaimsByCastId(castId: string): Promise<DockClaimEvent[]> {
  try {
    return (await fetchDockClaimEvents()).filter((e) => e.castId === castId)
  } catch (err) {
    console.error('[fetchDockClaimsByCastId] failed:', err)
    return []
  }
}

// ── Sound a Cast on-chain ─────────────────────────────────────
export async function soundCast(opts: {
  hook:        string
  body:        string
  mode:        number
  duration:    number
  price:       number
  vesselId:    string
  vesselCapId: string
  maxClaims?:       number  // v5: Dock seat count, default 1 (single-claim)
  dockDescription?: string  // v5: optional description shown in Dock invitation card
}): Promise<{ digest: string; castId: string }> {
  const session = getSession()
  if (!session) throw new Error('No session')

  // ── SEAL: encrypt paid cast bodies before they hit the chain ────────────
  // For paid casts (price > 0): encrypt body with AES-256-GCM, upload ciphertext to
  // Walrus, store {encrypted:true,blobId} JSON as the on-chain content_blob instead
  // of plaintext. Key is registered with zkProxy after the sound() tx confirms.
  let bodyToStore = opts.body
  let sealMeta: { key: string; iv: string; blobId: string } | null = null

  if (opts.price > 0) {
    try {
      const { encryptedBytes, key, iv } = await encryptBodyForCast(opts.body)
      const blobId = await uploadEncryptedToWalrus(encryptedBytes)
      bodyToStore = JSON.stringify({ encrypted: true, blobId })
      sealMeta    = { key, iv, blobId }
    } catch (encryptErr) {
      // Encryption or Walrus upload failed — do NOT fall back to plaintext.
      // Fail loudly: paid casts must never go on-chain unencrypted.
      throw new Error(
        `SEAL encrypt failed — cast aborted: ${(encryptErr as Error).message}. ` +
        'Retry or contact support.'
      )
    }
  }

  const { Transaction } = await import('@mysten/sui/transactions')
  const tx    = new Transaction()
  const coins = await getUsdcCoins(session.address)

  // v6: Flares (mode 2, EYES_ONLY) require $0.05 publish fee. Non-Flares pay $0.001 baseline.
  const publishFee = opts.mode === 2 ? 50_000 : 1_000
  const [feeCoin] = tx.splitCoins(tx.object(coins[0].coinObjectId), [tx.pure.u64(publishFee)])

  tx.moveCall({
    target:    `${PACKAGE}::cast::sound`,
    arguments: [
      feeCoin,
      tx.object(ABYSS),
      tx.object(opts.vesselId),
      tx.pure.u8(0),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(opts.hook))),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(bodyToStore))),
      tx.pure.option('vector<u8>', null),
      tx.pure.u8(opts.mode),
      tx.pure.address(session.address),
      tx.pure.u8(opts.duration),
      tx.pure.u64(opts.price),
      tx.pure.u64(opts.maxClaims ?? 1),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(opts.dockDescription ?? ''))),
      tx.object(CLOCK),
    ],
  })

  tx.setSender(session.address)
  const result = await executeTx(tx, session.address)

  // v5: extract the created Cast object ID from the CastSounded event
  const castSoundedEvent = result.events?.find((e: any) =>
    e.type.endsWith('::cast::CastSounded')
  )
  const castId = (castSoundedEvent?.parsedJson as any)?.cast_id ?? ''

  if (!castId) {
    console.warn('[soundCast] Could not extract cast_id from events, returning digest only')
  }

  // Register encryption key with zkProxy AFTER tx confirms and castId is known.
  // If this fails, log the error but don't throw — the cast is already on-chain.
  // The key can be re-registered manually via a recovery flow if needed.
  if (sealMeta && castId) {
    registerCastKey(castId, sealMeta.key, sealMeta.iv, sealMeta.blobId).catch((err) => {
      console.error('[SEAL] Key registration failed for cast', castId, err)
    })
  }

  return { digest: result.digest, castId }
}

// ── Pay Return Flare fee on-chain ─────────────────────────────
export async function payReturnFlareFee(): Promise<string> {
  const session = getSession()
  if (!session) throw new Error('No session')

  const { Transaction } = await import('@mysten/sui/transactions')
  const tx    = new Transaction()
  const coins = await getUsdcCoins(session.address)

  const [feeCoin] = tx.splitCoins(tx.object(coins[0].coinObjectId), [tx.pure.u64(50_000)])

  tx.moveCall({
    target:    `${PACKAGE}::abyss::receive_return_flare`,
    arguments: [tx.object(ABYSS), feeCoin, tx.object(CLOCK)],
  })

  tx.setSender(session.address)
  const result = await executeTx(tx, session.address)
  return result.digest
}

// ── Withdraw Harbor ───────────────────────────────────────────
export async function withdrawHarbor(opts: {
  toAddress:  string
  amountUsdc: number
}): Promise<string> {
  const session = getSession()
  if (!session) throw new Error('No session')

  const { Transaction } = await import('@mysten/sui/transactions')
  const tx    = new Transaction()
  const coins = await getUsdcCoins(session.address)

  const [payment] = tx.splitCoins(tx.object(coins[0].coinObjectId), [tx.pure.u64(opts.amountUsdc)])
  tx.transferObjects([payment], tx.pure.address(opts.toAddress))
  tx.setSender(session.address)

  const result = await executeTx(tx, session.address)
  return result.digest
}

export function getStatus() {
  return {
    network:  NETWORK,
    package:  PACKAGES.CONK,
    treasury: ADDRESSES.TREASURY,
    abyss:    ADDRESSES.ABYSS,
    gas:      'self-hosted',
    sui_rpc:  SUI_RPC,
  }
}

export function isReady(): boolean {
  return !!PACKAGES.CONK
}
