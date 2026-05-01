import { SuiClient } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1'
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1'

const SUI_RPC = process.env.CONK_SUI_RPC || 'https://fullnode.mainnet.sui.io:443'
const PACKAGE = process.env.CONK_PACKAGE_ID || '0x23a10fe5bd4a7b78087d6e716a1e810168e0b3332ff022637606a02d001fc9f1'
const ABYSS = process.env.CONK_ABYSS_ID || '0x392d5f46b5f02fb34cc0cb06c27e89b6e4dacc4cafd41e3b9ac1bc9f02dd1598'
const CLOCK = '0x6'
const USDC_TYPE = process.env.CONK_USDC_TYPE || '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'

const modeMap = { open: 0, sealed: 1, eyes_only: 2, burn: 3 }
const durationMap = { '24h': 1, '48h': 2, '72h': 3, '7d': 4 }

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-api-key')
}

function readBody(req) {
  if (!req.body) return {}
  if (typeof req.body === 'string') return JSON.parse(req.body)
  return req.body
}

function fail(res, status, error, message, extra = {}) {
  return res.status(status).json({ ok: false, error, message, ...extra })
}

function validateAuth(req) {
  const configured = (process.env.CONK_API_KEYS || process.env.CONK_API_KEY || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)

  if (!configured.length) return true

  const auth = req.headers.authorization || ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : ''
  const apiKey = req.headers['x-api-key'] || bearer
  return configured.includes(apiKey)
}

function keypairFromEnv() {
  const raw = process.env.CONK_API_PRIVATE_KEY || process.env.CONK_PRIVATE_KEY
  if (!raw) throw new Error('CONK_API_PRIVATE_KEY is not configured')

  if (raw.startsWith('suiprivkey')) {
    const decoded = decodeSuiPrivateKey(raw)
    if (decoded.schema === 'ED25519') return Ed25519Keypair.fromSecretKey(decoded.secretKey)
    if (decoded.schema === 'Secp256k1') return Secp256k1Keypair.fromSecretKey(decoded.secretKey)
    if (decoded.schema === 'Secp256r1') return Secp256r1Keypair.fromSecretKey(decoded.secretKey)
    throw new Error(`Unsupported Sui key schema: ${decoded.schema}`)
  }

  const secretKey = Uint8Array.from(Buffer.from(raw, 'base64'))
  return Ed25519Keypair.fromSecretKey(secretKey.length === 64 ? secretKey.slice(0, 32) : secretKey)
}

function normalizeCast(body) {
  const hook = String(body.hook || '').trim()
  const castBody = String(body.body || '').trim()
  if (hook.length < 3 || hook.length > 240) throw new Error('hook must be 3-240 characters')
  if (castBody.length < 1 || castBody.length > 20000) throw new Error('body must be 1-20000 characters')

  const mode = body.mode ? String(body.mode) : 'open'
  if (!(mode in modeMap)) throw new Error('mode must be one of: open, sealed, eyes_only, burn')

  const duration = body.duration ? String(body.duration) : '24h'
  if (!(duration in durationMap)) throw new Error('duration must be one of: 24h, 48h, 72h, 7d')

  let price = body.priceMicroUsdc ?? body.price_micro_usdc
  if (price == null && body.price != null) price = Math.round(Number(body.price) * 1_000_000)
  if (price == null) price = 100_000
  price = Number(price)
  if (!Number.isSafeInteger(price) || price < 0) throw new Error('price must be a non-negative number')

  const maxClaims = Number(body.maxClaims ?? body.max_claims ?? 1)
  if (!Number.isSafeInteger(maxClaims) || maxClaims < 1 || maxClaims > 10000) throw new Error('maxClaims must be 1-10000')

  return {
    hook,
    body: castBody,
    mode: modeMap[mode],
    modeLabel: mode,
    duration: durationMap[duration],
    durationLabel: duration,
    price,
    maxClaims,
    dockDescription: String(body.dockDescription || body.dock_description || '').slice(0, 500),
  }
}

async function getUsdcCoin(client, owner, minBalance) {
  const coins = await client.getCoins({ owner, coinType: USDC_TYPE, limit: 50 })
  const coin = coins.data.find((c) => BigInt(c.balance) >= BigInt(minBalance))
  if (!coin) throw new Error('Hosted CONK wallet needs USDC fuel')
  return coin.coinObjectId
}

export default async function handler(req, res) {
  cors(res)

  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'Use POST /api/cast')
  if (!validateAuth(req)) return fail(res, 401, 'unauthorized', 'Invalid CONK API key')

  const vesselId = process.env.CONK_API_VESSEL_ID || process.env.CONK_VESSEL_ID
  if (!vesselId) return fail(res, 503, 'not_configured', 'CONK_API_VESSEL_ID is not configured')

  try {
    const input = normalizeCast(readBody(req))
    const keypair = keypairFromEnv()
    const sender = keypair.getPublicKey().toSuiAddress()
    const client = new SuiClient({ url: SUI_RPC })
    const publishFee = input.mode === modeMap.eyes_only ? 10_000 : 1_000
    const coinId = await getUsdcCoin(client, sender, publishFee)

    const tx = new Transaction()
    const [feeCoin] = tx.splitCoins(tx.object(coinId), [tx.pure.u64(publishFee)])

    tx.moveCall({
      target: `${PACKAGE}::cast::sound`,
      arguments: [
        feeCoin,
        tx.object(ABYSS),
        tx.object(vesselId),
        tx.pure.u8(0),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(input.hook))),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(input.body))),
        tx.pure.option('vector<u8>', null),
        tx.pure.u8(input.mode),
        tx.pure.address(sender),
        tx.pure.u8(input.duration),
        tx.pure.u64(input.price),
        tx.pure.u64(input.maxClaims),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(input.dockDescription))),
        tx.object(CLOCK),
      ],
    })
    tx.setSender(sender)

    const result = await client.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showEffects: true, showObjectChanges: true, showEvents: true },
      requestType: 'WaitForLocalExecution',
    })

    if (result.effects?.status?.status !== 'success') {
      return fail(res, 502, 'transaction_failed', 'Sui transaction failed', { status: result.effects?.status, digest: result.digest })
    }

    const castEvent = result.events?.find((event) => event.type?.endsWith('::cast::CastSounded'))
    const castId = castEvent?.parsedJson?.cast_id || ''

    return res.status(201).json({
      ok: true,
      id: castId,
      castId,
      url: castId ? `https://conk.app/cast/${castId}` : null,
      txDigest: result.digest,
      vesselId,
      sender,
      mode: input.modeLabel,
      duration: input.durationLabel,
      priceMicroUsdc: input.price,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = /hook|body|mode|duration|price|maxClaims/.test(message) ? 400 : 500
    return fail(res, status, status === 400 ? 'invalid_request' : 'cast_failed', message)
  }
}
