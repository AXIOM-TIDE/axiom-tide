/**
 * CONK zkLogin Integration
 * Users sign transactions with Google — no seed phrase needed.
 * Vessel addresses derived from JWT — anonymous on-chain.
 */

import { RPC, GOOGLE_CLIENT_ID } from './index'

export { GOOGLE_CLIENT_ID }

export interface ZkLoginSession {
  address:    string
  maxEpoch:   number
  salt:       string
  proof?:     unknown
  addressSeed?: string
}

// ── STEP 1: START LOGIN ───────────────────────────────────────
export async function startZkLogin(): Promise<void> {
  const { generateRandomness } = await import('@mysten/sui/zklogin')
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519')
  const { getSuiClient } = await import('./client')

  const ephemeralKeypair = new Ed25519Keypair()
  const randomness = generateRandomness()

  // Use CORS-friendly RPC directly for epoch (proxy blocks outbound)
  const epochRes = await fetch('https://conk-zkproxy-v2.axiomtide.workers.dev/sui', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getLatestSuiSystemState', params: [] })
  })
  const epochData = await epochRes.json()
  const maxEpoch = Number(epochData.result?.epoch ?? 0) + 10

  sessionStorage.setItem('zklogin_ephemeral_secret', ephemeralKeypair.getSecretKey())
  sessionStorage.setItem('zklogin_randomness', randomness)
  sessionStorage.setItem('zklogin_maxEpoch', String(maxEpoch))

  const { generateNonce } = await import('@mysten/sui/zklogin')
  const nonce = generateNonce(ephemeralKeypair.getPublicKey(), maxEpoch, randomness)

  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  window.location.origin,
    response_type: 'id_token',
    scope:         'openid',
    nonce:         nonce,
  })
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

// ── STEP 2: HANDLE RETURN FROM GOOGLE ────────────────────────
export async function handleZkLoginCallback(): Promise<ZkLoginSession | null> {
  const hash = window.location.hash
  if (!hash.includes('id_token')) return null

  const params = new URLSearchParams(hash.slice(1))
  const jwt = params.get('id_token')
  if (!jwt) return null

  window.history.replaceState(null, '', window.location.pathname)

  const { jwtToAddress } = await import('@mysten/sui/zklogin')

  // Salt stored locally — never on server
  let salt = localStorage.getItem('zklogin_salt')
  if (!salt) {
    const array = new Uint8Array(16)
    crypto.getRandomValues(array)
    salt = Array.from(array).map(b => b.toString(16).padStart(2,'0')).join('')
    localStorage.setItem('zklogin_salt', salt)
  }

  // Decode JWT to get sub and aud for addressSeed
  const jwtPayload = JSON.parse(atob(jwt.split('.')[1]))
  const { genAddressSeed } = await import('@mysten/sui/zklogin')
  const addressSeedValue = genAddressSeed(BigInt('0x' + salt), 'sub', jwtPayload.sub, jwtPayload.aud).toString()
  const address  = jwtToAddress(jwt, BigInt('0x' + salt))
  const maxEpoch = Number(sessionStorage.getItem('zklogin_maxEpoch') ?? 0)
  const randomness   = sessionStorage.getItem('zklogin_randomness') ?? ''
  const secretKey    = sessionStorage.getItem('zklogin_ephemeral_secret') ?? ''

  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519')
  const ephemeralKeypair   = Ed25519Keypair.fromSecretKey(secretKey)
  const extendedKey        = ephemeralKeypair.getPublicKey().toSuiBytes()
  const extendedKeyB64     = btoa(String.fromCharCode(...extendedKey))

  // Generate ZK proof via Shinami prover
  let proof: unknown = null
  try {
    const proverUrl = 'https://api.enoki.mystenlabs.com/v1/zklogin/zkp'

    const headers: Record<string,string> = {
      'Content-Type': 'application/json',
      'zklogin-jwt': jwt,
      'Authorization': 'Bearer enoki_public_fa10b08a0bbb5415b2a78850aba85c8c',
    }

    const resp = await fetch(proverUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        network: 'mainnet',
        ephemeralPublicKey: extendedKeyB64,
        maxEpoch: maxEpoch,
        randomness: randomness,
        salt: BigInt('0x' + salt).toString(),
        keyClaimName: 'sub',
      }),
    })
    if (resp.ok) {
      const raw = await resp.json()
      proof = raw.data
    } else {
      console.warn('ZK proof failed:', resp.status, await resp.text())
    }
  } catch (e) {
    console.warn('ZK proof generation failed:', e)
  }

  const enokiAddressSeed = (proof as any)?.addressSeed ?? addressSeedValue
  // Recompute address from Enoki's addressSeed
  const { computeZkLoginAddressFromSeed } = await import('@mysten/sui/zklogin')
  const finalAddress = enokiAddressSeed !== addressSeedValue
    ? computeZkLoginAddressFromSeed(BigInt(enokiAddressSeed), 'https://accounts.google.com')
    : address
  const session: ZkLoginSession = { address: finalAddress, maxEpoch, salt, proof, addressSeed: enokiAddressSeed }
  sessionStorage.setItem('zklogin_session', JSON.stringify(session))
  sessionStorage.setItem('zklogin_jwt', jwt)

  return session
}

// ── SIGN TRANSACTION WITH ZKLOGIN ────────────────────────────
export async function signWithZkLogin(
  tx: unknown,
  session: ZkLoginSession
): Promise<{ bytes: string; signature: string }> {
  // Accept raw base64 bytes directly
  if (typeof tx === 'string') {
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519')
    const { getZkLoginSignature } = await import('@mysten/sui/zklogin')
    const secretKey = sessionStorage.getItem('zklogin_ephemeral_secret') ?? ''
    const ephemeralKeypair = Ed25519Keypair.fromSecretKey(secretKey)
    const { fromB64 } = await import('@mysten/sui/utils')
    const txBytes = fromB64(tx)
    const { signature: ephemeralSig } = await ephemeralKeypair.signTransaction(txBytes)
    const proofWithSeed = {
      ...(session.proof as any),
      addressSeed: (session.proof as any).addressSeed ?? session.addressSeed ?? BigInt('0x' + session.salt).toString(),
    }
    const zkLoginSig = getZkLoginSignature({
      inputs: proofWithSeed,
      maxEpoch: session.maxEpoch,
      userSignature: ephemeralSig,
    })
    return { bytes: tx, signature: zkLoginSig }
  }
  if (!session.proof) {
    throw new Error('ZK proof not available — cannot sign transaction')
  }

  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519')
  const { getZkLoginSignature } = await import('@mysten/sui/zklogin')
  const { toB64 } = await import('@mysten/sui/utils')
  const { Transaction } = await import('@mysten/sui/transactions')
  const { getSuiClient } = await import('./client')

  const secretKey        = sessionStorage.getItem('zklogin_ephemeral_secret') ?? ''
  const ephemeralKeypair = Ed25519Keypair.fromSecretKey(secretKey)
  const client           = await getSuiClient()

  // Build transaction bytes
  const txBytes = await (tx as InstanceType<typeof Transaction>).build({
    client: client as any,
  })

  // Sign with ephemeral keypair
  const { signature: ephemeralSig } = await ephemeralKeypair.signTransaction(txBytes)

  // Wrap with zkLogin proof to create final signature
  // Add addressSeed derived from salt
  const proofWithSeed = {
    ...(session.proof as any),
    addressSeed: (session.proof as any).addressSeed ?? session.addressSeed ?? BigInt('0x' + session.salt).toString(),
  }

  const zkLoginSig = getZkLoginSignature({
    inputs:        proofWithSeed,
    maxEpoch:      session.maxEpoch,
    userSignature: ephemeralSig,
  })

  return { bytes: toB64(txBytes), signature: zkLoginSig }
}

// ── HELPERS ───────────────────────────────────────────────────
export function getSession(): ZkLoginSession | null {
  try {
    const raw = sessionStorage.getItem('zklogin_session')
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function isLoggedIn(): boolean {
  return !!getSession()
}

export function clearSession(): void {
  sessionStorage.removeItem('zklogin_session')
  sessionStorage.removeItem('zklogin_jwt')
  sessionStorage.removeItem('zklogin_randomness')
  sessionStorage.removeItem('zklogin_maxEpoch')
  sessionStorage.removeItem('zklogin_ephemeral_secret')
}

export function getAddress(): string | null {
  return getSession()?.address ?? null
}

export function hasProof(): boolean {
  return !!getSession()?.proof
}