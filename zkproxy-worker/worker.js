/**
 * CONK ZK Proxy + Self-Hosted Gas Station — HARDENED
 * Axiom Tide LLC · April 2026
 *
 * Security layers:
 *   1. Origin validation — only conk.app and localhost
 *   2. Per-IP rate limiting via Cloudflare KV
 *   3. Circuit breaker — pauses if SUI balance < 0.5 SUI
 *   4. Request size limits
 *   5. Address validation
 *   6. Secure CORS — no more wildcard
 *   7. Error sanitization
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction }    from '@mysten/sui/transactions'

// Tatum enterprise Sui RPC — Tatum × Walrus Hackathon requirement
const SUI_RPC      = 'https://sui-mainnet.gateway.tatum.io'
const TATUM_API_KEY = 't-6a148cf82a008398a3ef2ed0-68d0fa83c0b74fbe9c9550ba'
const ENOKI_URL = 'https://api.enoki.mystenlabs.com/v1/zklogin/zkp'
const CONK_TREASURY = '0xe0117fba317d2267b8d90adca1fe79eceeec756bcf54edf04cc29ee5306ab32e'
const CONK_USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
const RETURN_FLARE_FEE_USDC = 50_000

const CONK_PACKAGE = '0x6eca0063f930674f26a4a4593a7ef5ed487e21f31caafe74290ab5df88478cc6' // v13 — two-payment read() (2026-05-21)

const GAS_FLOOR_MIST               = 500_000_000n  // 0.5 SUI
const MAX_GAS_PER_IP_PER_HOUR      = 50
const MAX_ZKP_PER_IP_PER_HOUR      = 30
const MAX_RPC_PER_IP_PER_HOUR      = 200
const MAX_WALRUS_PER_HOUR          = 20
const MAX_PROVISION_PER_IP_PER_HOUR = 5            // Harbor creation is expensive
const MAX_BODY_SIZE                = 64 * 1024     // 64KB
const MAX_KEY_REG_PER_IP_PER_HOUR  = 30            // cast key registrations (author)
const MAX_DECRYPT_PER_IP_PER_HOUR  = 100           // cast decryption requests (reader)

const ALLOWED_ORIGINS = new Set([
  'https://conk.app',
  'https://www.conk.app',
  'https://staging.conk.app',
  'http://localhost:5173',
  'http://localhost:3000',
])

// ─── CORS ─────────────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : 'https://conk.app'
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, zklogin-jwt',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',
  }
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...corsHeaders(origin || 'https://conk.app'), 'Content-Type': 'application/json' },
  })
}

function errResponse(message, status, origin) {
  return jsonResponse({ error: message }, status, origin)
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

async function checkRateLimit(kv, key, max) {
  const windowMs = 3_600_000
  const now      = Date.now()
  const kvKey    = 'rl:' + key + ':' + Math.floor(now / windowMs)

  let count = 0
  try {
    const current = await kv.get(kvKey)
    count = current ? parseInt(current) : 0
  } catch (e) {
    // KV read failed — allow through, don't block legitimate users
    return { allowed: true, remaining: max }
  }

  if (count >= max) {
    return { allowed: false, remaining: 0 }
  }

  try {
    await kv.put(kvKey, String(count + 1), {
      expirationTtl: Math.ceil(windowMs / 1000) + 60,
    })
  } catch (e) {
    // KV write failed — allow through
  }

  return { allowed: true, remaining: max - count - 1 }
}

// ─── RPC helper ───────────────────────────────────────────────────────────────

async function rpc(method, params) {
  const resp = await fetch(SUI_RPC, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': TATUM_API_KEY },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await resp.json()
  if (json.error) throw new Error('RPC: ' + JSON.stringify(json.error))
  return json.result
}

// ─── B64 helpers ──────────────────────────────────────────────────────────────

function toB64(bytes) {
  return btoa(String.fromCharCode(...bytes))
}

function fromB64(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0))
}


// ─── SEAL: verify cast::read() tx ──────────────────────────────────────────────
// Confirms the caller executed cast::read() for the given castId before releasing
// the AES decryption key. Called by /cast-decrypt endpoint.

async function verifyReadCastTx(castId, txDigest, readerAddress, kv) {
  if (!txDigest || typeof txDigest !== 'string') {
    return { ok: false, error: 'txDigest required' }
  }
  if (!castId || typeof castId !== 'string') {
    return { ok: false, error: 'castId required' }
  }
  if (!readerAddress || !/^0x[0-9a-fA-F]{64}$/.test(readerAddress)) {
    return { ok: false, error: 'Invalid reader address' }
  }

  // Replay protection — each txDigest can only unlock a key once
  const replayKey = 'seal-read:' + txDigest
  if (kv) {
    const seen = await kv.get(replayKey).catch(() => null)
    if (seen) return { ok: false, error: 'txDigest already used for decryption' }
  }

  let tx
  try {
    tx = await rpc('sui_getTransactionBlock', [txDigest, {
      showEffects:        true,
      showEvents:         true,
      showObjectChanges:  false,
    }])
  } catch (e) {
    return { ok: false, error: 'Could not fetch transaction: ' + e.message }
  }

  if (tx?.effects?.status?.status !== 'success') {
    return { ok: false, error: 'Transaction did not succeed' }
  }

  // Verify tx sender matches the claimed reader address
  const txSender = tx?.transaction?.data?.sender ?? ''
  const normSender = txSender.toLowerCase()
  const normReader = readerAddress.toLowerCase()
  if (normSender !== normReader) {
    return { ok: false, error: 'Transaction sender does not match reader address' }
  }

  // Verify CastRead event exists for the correct castId
  const events = tx.events ?? []
  const normCastId = castId.toLowerCase().startsWith('0x') ? castId.toLowerCase() : '0x' + castId.toLowerCase()
  const readEvent = events.find((e) => {
    if (!e.type?.endsWith('::cast::CastRead')) return false
    const eventCastId = (e.parsedJson?.cast_id ?? '').toLowerCase()
    const normEvent   = eventCastId.startsWith('0x') ? eventCastId : '0x' + eventCastId
    return normEvent === normCastId
  })

  if (!readEvent) {
    return { ok: false, error: 'No CastRead event found for this castId in the transaction' }
  }

  // Mark txDigest as used (30-day TTL — well beyond any cast expiry)
  if (kv) {
    await kv.put(replayKey, '1', { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {})
  }

  return { ok: true }
}

// ─── Return Flare fee verification ───────────────────────────────────────────

function eventAmount(event) {
  const amount = Number(event?.parsedJson?.amount ?? 0)
  return Number.isFinite(amount) ? amount : 0
}

function balanceChangeAmount(change) {
  const amount = Number(change?.amount ?? 0)
  return Number.isFinite(amount) ? amount : 0
}

function isTreasuryOwner(owner) {
  if (!owner) return false
  if (owner.AddressOwner) return owner.AddressOwner === CONK_TREASURY
  if (owner.ObjectOwner) return owner.ObjectOwner === CONK_TREASURY
  return false
}

async function verifyReturnFlareFeeTx(txDigest, kv) {
  if (!txDigest || typeof txDigest !== 'string') return { ok: false, error: 'Return Flare fee txDigest required' }

  const seenKey = 'return-flare-fee:' + txDigest
  if (kv) {
    const seen = await kv.get(seenKey).catch(() => null)
    if (seen) return { ok: false, error: 'Return Flare fee txDigest already used' }
  }

  const tx = await rpc('sui_getTransactionBlock', [txDigest, {
    showEffects: true,
    showEvents: true,
    showBalanceChanges: true,
  }])

  if (tx?.effects?.status?.status !== 'success') return { ok: false, error: 'Return Flare fee transaction failed' }

  const feeEvent = (tx.events || []).find((event) =>
    event.type?.endsWith('::abyss::FeeReceived') &&
    eventAmount(event) >= RETURN_FLARE_FEE_USDC
  )

  const treasuryCredit = (tx.balanceChanges || []).find((change) =>
    change.coinType === CONK_USDC_TYPE &&
    isTreasuryOwner(change.owner) &&
    balanceChangeAmount(change) >= RETURN_FLARE_FEE_USDC
  )

  if (!feeEvent && !treasuryCredit) return { ok: false, error: 'Return Flare fee transaction not found' }

  if (kv) {
    await kv.put(seenKey, '1', { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {})
  }

  return { ok: true }
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────

async function checkGasBalance(keypair) {
  const address = keypair.getPublicKey().toSuiAddress()
  try {
    const result = await rpc('suix_getBalance', [address, '0x2::sui::SUI'])
    const balance = BigInt(result.totalBalance)
    return { ok: balance >= GAS_FLOOR_MIST, balance, address }
  } catch (e) {
    return { ok: false, balance: 0n, address }
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || 'https://conk.app'
    const ip     = request.headers.get('CF-Connecting-IP') || 'unknown'
    const url    = new URL(request.url)
    const path   = url.pathname

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }

    // Health check
    if (path === '/health') {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
      })
    }

    // Origin check
    if (!ALLOWED_ORIGINS.has(origin) && !origin.includes('localhost')) {
      console.warn('[SECURITY] Blocked origin: ' + origin + ' from IP: ' + ip)
      return errResponse('Forbidden', 403, origin)
    }

    try {

      // ── Walrus upload ─────────────────────────────────────────────────────
      if (path.includes('walrus-upload')) {
        const limit = await checkRateLimit(env.RATE_LIMITER, 'walrus:' + ip, MAX_WALRUS_PER_HOUR)
        if (!limit.allowed) {
          return errResponse('Upload rate limit exceeded — try again later', 429, origin)
        }

        const ct    = request.headers.get('Content-Type') || 'application/octet-stream'
        const bytes = await request.arrayBuffer()

        if (bytes.byteLength > 500 * 1024 * 1024) {
          return errResponse('File too large — maximum 500 MB', 413, origin)
        }

        const epochs = url.searchParams.get('epochs') || '5'
        const resp   = await fetch(
          'https://publisher.walrus.site/v1/store?epochs=' + epochs,
          { method: 'PUT', headers: { 'Content-Type': ct }, body: bytes },
        )
        const text = await resp.text()
        return new Response(text, {
          status:  resp.status,
          headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        })
      }

      // All other routes — read body
      const rawBody = await request.text()

      if (rawBody.length > MAX_BODY_SIZE) {
        return errResponse('Request too large', 413, origin)
      }

      // ── ZK proof ──────────────────────────────────────────────────────────
      if (path.includes('zkproof')) {
        const limit = await checkRateLimit(env.RATE_LIMITER, 'zkp:' + ip, MAX_ZKP_PER_IP_PER_HOUR)
        if (!limit.allowed) {
          console.warn('[SECURITY] ZKP rate limit: ' + ip)
          return errResponse('Rate limit exceeded — slow down', 429, origin)
        }

        const req  = JSON.parse(rawBody)
        const resp = await fetch(ENOKI_URL, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'zklogin-jwt':   req.jwt,
            'Authorization': 'Bearer ' + env.ENOKI_KEY,
          },
          body: JSON.stringify({
            network:            'mainnet',
            ephemeralPublicKey: req.ephemeralPublicKey,
            maxEpoch:           req.maxEpoch,
            randomness:         req.randomness,
            salt:               req.salt,
          }),
        })
        const text = await resp.text()
        return new Response(text, {
          status:  resp.status,
          headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        })
      }

      // ── Gas sponsorship ───────────────────────────────────────────────────
      if (path.includes('gas')) {
        const limit = await checkRateLimit(env.RATE_LIMITER, 'gas:' + ip, MAX_GAS_PER_IP_PER_HOUR)
        if (!limit.allowed) {
          console.warn('[SECURITY] Gas rate limit: ' + ip)
          return errResponse('Gas rate limit exceeded — try again later', 429, origin)
        }

        const { txBytes, sender } = JSON.parse(rawBody)
        if (!txBytes || !sender) {
          return errResponse('Missing txBytes or sender', 400, origin)
        }

        if (!/^0x[0-9a-fA-F]{64}$/.test(sender)) {
          return errResponse('Invalid sender address', 400, origin)
        }

        const privateKey = env.GAS_PRIVATE_KEY
        if (!privateKey) throw new Error('GAS_PRIVATE_KEY not set')

        const keypair = Ed25519Keypair.fromSecretKey(privateKey)

        // Circuit breaker
        const balanceCheck = await checkGasBalance(keypair)
        if (!balanceCheck.ok) {
          console.error('[CIRCUIT BREAKER] Gas wallet low: ' + balanceCheck.balance + ' at ' + balanceCheck.address)
          return errResponse('Gas sponsorship temporarily paused — network maintenance', 503, origin)
        }

        const gasAddr = balanceCheck.address

        const [coinsResult, refGasPrice] = await Promise.all([
          rpc('suix_getCoins', [gasAddr, '0x2::sui::SUI', null, 1]),
          rpc('suix_getReferenceGasPrice', []),
        ])

        if (!coinsResult.data?.length) throw new Error('Gas wallet empty — top up SUI at ' + gasAddr)

        const coin = coinsResult.data[0]
        const tx   = Transaction.fromKind(fromB64(txBytes))

        tx.setSender(sender)
        tx.setGasOwner(gasAddr)
        tx.setGasPrice(Number(refGasPrice))
        tx.setGasBudget(10_000_000)
        tx.setGasPayment([{
          objectId: coin.coinObjectId,
          version:  coin.version,
          digest:   coin.digest,
        }])

        const builtBytes    = await tx.build()
        const { signature } = await keypair.signTransaction(builtBytes)

        return jsonResponse({
          sponsoredBytes: toB64(builtBytes),
          sponsorSig:     signature,
        }, 200, origin)
      }

      // ── Sui RPC proxy ─────────────────────────────────────────────────────
      if (path.includes('sui')) {
        const limit = await checkRateLimit(env.RATE_LIMITER, 'rpc:' + ip, MAX_RPC_PER_IP_PER_HOUR)
        if (!limit.allowed) {
          return errResponse('RPC rate limit exceeded', 429, origin)
        }

        const resp = await fetch(SUI_RPC, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': TATUM_API_KEY },
          body:    rawBody,
        })
        const text = await resp.text()
        return new Response(text, {
          status:  resp.status,
          headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
        })
      }

      // ── Bridge provision (gas sponsor for harbor::open + vessel::launch) ──
      // For non-browser agents that have a zkLogin address but can't run browser code.
      // Body: { address: string, txBytes: string }
      //   txBytes = transaction KIND bytes (without gas) for harbor::open + vessel::launch
      // Returns:
      //   { harborExists: true, provisioned: false }  — Harbor already on-chain, nothing done
      //   { sponsoredBytes, sponsorSig, provisioned: true }  — sponsored tx for agent to sign+submit
      if (path === '/bridge/provision' && request.method === 'POST') {
        const limit = await checkRateLimit(
          env.RATE_LIMITER,
          'provision:' + ip,
          MAX_PROVISION_PER_IP_PER_HOUR
        )
        if (!limit.allowed) {
          return errResponse('Provision rate limit exceeded — try again later', 429, origin)
        }

        let data
        try { data = JSON.parse(rawBody) } catch { return errResponse('Bad JSON', 400, origin) }

        const { address, txBytes } = data

        if (!address || !txBytes) {
          return errResponse('Missing address or txBytes', 400, origin)
        }

        if (!/^0x[0-9a-fA-F]{64}$/.test(address)) {
          return errResponse('Invalid address format', 400, origin)
        }

        // Idempotency check — does Harbor already exist for this address?
        let harborExists = false
        try {
          const owned = await rpc('suix_getOwnedObjects', [
            address,
            {
              filter:  { StructType: `${CONK_PACKAGE}::harbor::HarborCap` },
              options: { showContent: false },
            },
            null,
            1,
          ])
          harborExists = (owned?.data?.length ?? 0) > 0
        } catch (e) {
          console.warn('[bridge/provision] Harbor check failed:', e.message)
          // Proceed — idempotency check best-effort
        }

        if (harborExists) {
          return jsonResponse({ harborExists: true, provisioned: false }, 200, origin)
        }

        // Harbor doesn't exist — sponsor the provision PTB
        const privateKey = env.GAS_PRIVATE_KEY
        if (!privateKey) throw new Error('GAS_PRIVATE_KEY not set')

        const keypair = Ed25519Keypair.fromSecretKey(privateKey)

        const balanceCheck = await checkGasBalance(keypair)
        if (!balanceCheck.ok) {
          return errResponse('Gas sponsorship temporarily paused — network maintenance', 503, origin)
        }

        const gasAddr = balanceCheck.address

        const [coinsResult, refGasPrice] = await Promise.all([
          rpc('suix_getCoins', [gasAddr, '0x2::sui::SUI', null, 1]),
          rpc('suix_getReferenceGasPrice', []),
        ])

        if (!coinsResult.data?.length) {
          throw new Error('Gas wallet empty — top up SUI at ' + gasAddr)
        }

        const coin = coinsResult.data[0]
        const tx   = Transaction.fromKind(fromB64(txBytes))

        tx.setSender(address)
        tx.setGasOwner(gasAddr)
        tx.setGasPrice(Number(refGasPrice))
        tx.setGasBudget(10_000_000)
        tx.setGasPayment([{
          objectId: coin.coinObjectId,
          version:  coin.version,
          digest:   coin.digest,
        }])

        const builtBytes    = await tx.build()
        const { signature } = await keypair.signTransaction(builtBytes)

        return jsonResponse({
          sponsoredBytes: toB64(builtBytes),
          sponsorSig:     signature,
          harborExists:   false,
          provisioned:    true,
        }, 200, origin)
      }

      // ── Return Flare email delivery ───────────────────────────────────────
      // Must sit before generic /flare handler: /return-flare includes "flare".
      if (path.includes('return-flare') && request.method === 'POST') {
        const apiKey = env.RESEND_API_KEY
        if (!apiKey) return errResponse('RESEND_API_KEY not configured', 503, origin)

        let data
        try { data = JSON.parse(rawBody) } catch { return errResponse('Bad JSON', 400, origin) }

        const { to, hook, castId, amount, note, claimedAt, txDigest } = data
        if (!to || !hook || !castId) return errResponse('Missing fields', 400, origin)

        const feeCheck = await verifyReturnFlareFeeTx(txDigest, env.RATE_LIMITER)
        if (!feeCheck.ok) return errResponse(feeCheck.error, 402, origin)

        const amountLabel = Number(amount || 0) > 0
          ? `$${Number(amount).toFixed(3)} USDC`
          : 'the original read amount'
        const claimedLabel = Number(claimedAt || 0) > 0
          ? new Date(Number(claimedAt)).toUTCString()
          : 'recently'

        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
          body{background:#000208;color:#a8ccdc;font-family:monospace;margin:0;padding:32px}
          .card{background:#020b18;border:1px solid rgba(0,212,255,0.2);padding:28px 32px;max-width:560px;margin:0 auto}
          .label{font-size:11px;letter-spacing:0.3em;text-transform:uppercase;color:rgba(0,212,255,0.5);margin-bottom:8px}
          .hook{font-size:22px;font-weight:700;color:#d0eef8;margin-bottom:16px;line-height:1.3}
          .body{font-size:14px;color:rgba(168,204,220,0.7);line-height:1.8;margin-bottom:24px;white-space:pre-wrap}
          .pill{display:inline-block;border:1px solid rgba(0,212,255,0.35);color:#00d4ff;padding:8px 12px;border-radius:999px;font-size:12px;margin-bottom:22px}
          .footer{margin-top:24px;font-size:10px;color:rgba(168,204,220,0.25);letter-spacing:0.1em;line-height:1.8}
        </style></head><body><div class="card">
          <div class="label">// CONK Return Flare</div>
          <div class="hook">${escapeHtml(hook)}</div>
          <div class="body">The author issued a Return Flare for this cast. They intend to return ${escapeHtml(amountLabel)} from the read claimed ${escapeHtml(claimedLabel)}.</div>
          ${note ? `<div class="body">${escapeHtml(note)}</div>` : ''}
          <div class="pill">Return window: 48 hours</div>
          <div class="footer">
            Cast: ${escapeHtml(castId)}<br>
            Powered by CONK Protocol &middot; Sui Mainnet &middot; Axiom Tide LLC<br>
            This notification does not custody funds. Refund transfer is author-issued.
          </div>
        </div></body></html>`

        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'CONK Return Flare <flare@conk.app>', to: [to], subject: `Return Flare: ${hook}`, html }),
        })

        if (!res.ok) {
          const err = await res.text().catch(() => String(res.status))
          return errResponse(err, 502, origin)
        }

        return jsonResponse({ ok: true, txDigest }, 200, origin)
      }

      // ── Flare email delivery ──────────────────────────────────────────────
      if (path.includes('flare') && request.method === 'POST') {
        const apiKey = env.RESEND_API_KEY
        if (!apiKey) return errResponse('RESEND_API_KEY not configured', 503, origin)

        let data
        try { data = JSON.parse(rawBody) } catch { return errResponse('Bad JSON', 400, origin) }

        const { to, hook, body, price, castUrl, castId } = data
        if (!to || !hook || !castUrl) return errResponse('Missing fields', 400, origin)

        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
          body{background:#000208;color:#a8ccdc;font-family:monospace;margin:0;padding:32px}
          .card{background:#020b18;border:1px solid rgba(0,212,255,0.2);padding:28px 32px;max-width:560px;margin:0 auto}
          .label{font-size:11px;letter-spacing:0.3em;text-transform:uppercase;color:rgba(0,212,255,0.5);margin-bottom:8px}
          .hook{font-size:22px;font-weight:700;color:#d0eef8;margin-bottom:16px;line-height:1.3}
          .body{font-size:14px;color:rgba(168,204,220,0.7);line-height:1.8;margin-bottom:24px;white-space:pre-wrap}
          .price{font-size:13px;color:#00d4ff;margin-bottom:24px}
          .btn{display:inline-block;background:#00d4ff;color:#000208;padding:14px 32px;font-family:monospace;font-size:12px;font-weight:700;letter-spacing:0.2em;text-decoration:none;text-transform:uppercase}
          .footer{margin-top:24px;font-size:10px;color:rgba(168,204,220,0.25);letter-spacing:0.1em;line-height:1.8}
        </style></head><body><div class="card">
          <div class="label">// CONK Flare</div>
          <div class="hook">${hook}</div>
          <div class="body">${String(body||'').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
          <div class="price">$${Number(price||0).toFixed(3)} USDC to read &middot; instant settlement</div>
          <a href="${castUrl}" class="btn">Read Cast &rarr;</a>
          <div class="footer">
            Cast: ${castId||''}<br>
            Powered by CONK Protocol &middot; Sui Mainnet &middot; Axiom Tide LLC<br>
            Fund a Harbor at conk.app &middot; No account required
          </div>
        </div></body></html>`

        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'CONK Flare <flare@conk.app>', to: [to], subject: hook, html }),
        })

        if (!res.ok) {
          const err = await res.text().catch(() => String(res.status))
          return errResponse(err, 502, origin)
        }

        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' }
        })
      }

      // ── SEAL: register cast encryption key ─────────────────────────────────
      // Called by the cast author immediately after a paid cast::sound() tx confirms.
      // Stores the AES-256-GCM key in KV, keyed by castId.
      // Body: { castId, key (hex32), iv (hex12), blobId (Walrus blob ID) }
      if (path === '/cast-key' && request.method === 'POST') {
        const limit = await checkRateLimit(env.RATE_LIMITER, 'seal-key:' + ip, MAX_KEY_REG_PER_IP_PER_HOUR)
        if (!limit.allowed) return errResponse('Rate limit exceeded', 429, origin)

        let data
        try { data = JSON.parse(rawBody) } catch { return errResponse('Bad JSON', 400, origin) }

        const { castId, key, iv, blobId } = data
        if (!castId || !key || !iv || !blobId) return errResponse('Missing castId, key, iv, or blobId', 400, origin)

        // Validate formats: castId=0x+64hex, key=64hex (32 bytes), iv=24hex (12 bytes)
        if (!/^0x[0-9a-fA-F]{64}$/.test(castId)) return errResponse('Invalid castId format', 400, origin)
        if (!/^[0-9a-fA-F]{64}$/.test(key))      return errResponse('Invalid key format — expected 64 hex chars (32 bytes)', 400, origin)
        if (!/^[0-9a-fA-F]{24}$/.test(iv))        return errResponse('Invalid iv format — expected 24 hex chars (12 bytes)', 400, origin)

        // Store key in KV. TTL: 8 days (longest cast duration is 7 days + 1 day buffer).
        // For lighthouse casts the key persists because lighthouse duration is ~100 years
        // but casts only become lighthouses after 1M reads — we'll extend TTL on first access.
        const kvKey = 'seal-key:' + castId.toLowerCase()
        await env.RATE_LIMITER.put(
          kvKey,
          JSON.stringify({ key, iv, blobId }),
          { expirationTtl: 60 * 60 * 24 * 8 }
        )

        return jsonResponse({ ok: true }, 200, origin)
      }

      // ── SEAL: decrypt cast body ───────────────────────────────────────────
      // Called by a reader after a successful readCast() transaction.
      // Verifies the on-chain tx, then returns the AES key.
      // Body: { castId, txDigest, address }
      if (path === '/cast-decrypt' && request.method === 'POST') {
        const limit = await checkRateLimit(env.RATE_LIMITER, 'seal-decrypt:' + ip, MAX_DECRYPT_PER_IP_PER_HOUR)
        if (!limit.allowed) return errResponse('Rate limit exceeded', 429, origin)

        let data
        try { data = JSON.parse(rawBody) } catch { return errResponse('Bad JSON', 400, origin) }

        const { castId, txDigest, address } = data
        if (!castId || !txDigest || !address) return errResponse('Missing castId, txDigest, or address', 400, origin)

        // Verify on-chain payment tx
        const verify = await verifyReadCastTx(castId, txDigest, address, env.RATE_LIMITER)
        if (!verify.ok) return errResponse(verify.error, 402, origin)

        // Fetch stored key
        const kvKey = 'seal-key:' + castId.toLowerCase()
        const stored = await env.RATE_LIMITER.get(kvKey).catch(() => null)
        if (!stored) {
          return errResponse('No encryption key found for this cast — it may be unencrypted or the key has expired', 404, origin)
        }

        let keyData
        try { keyData = JSON.parse(stored) } catch {
          return errResponse('Key store corrupted', 500, origin)
        }

        // Extend TTL if this cast has survived (lighthouse) — heuristic: if key accessed after 7 days, refresh to 30 days
        const age = Date.now() - (keyData.registeredAt ?? 0)
        if (age > 7 * 24 * 60 * 60 * 1000) {
          await env.RATE_LIMITER.put(kvKey, stored, { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {})
        }

        return jsonResponse({ key: keyData.key, iv: keyData.iv, blobId: keyData.blobId }, 200, origin)
      }

      return errResponse('Not found', 404, origin)

    } catch (e) {
      console.error('[ERROR]', e.message)
      return errResponse('Internal error', 500, origin)
    }
  }
}
