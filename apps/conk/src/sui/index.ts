/**
 * CONK Sui Integration Layer
 * Deployed to Sui Mainnet — April 24, 2026 (v6); upgraded May 8, 2026 (v7 — fee enforcement)
 * Package: 0x92e015ba78f91f40a33d7d023c347cfa7ac0aaa0d35dcd72a1909974e51f7274
 * Treasury: 0xe0117fba317d2267b8d90adca1fe79eceeec756bcf54edf04cc29ee5306ab32e
 * Axiom Tide LLC · Casper, Wyoming
 */

const PROXY = 'https://conk-zkproxy-v2.axiomtide.workers.dev'

export const NETWORK = import.meta.env.VITE_NETWORK || 'mainnet'

export const ADDRESSES = {
  TREASURY:    '0xe0117fba317d2267b8d90adca1fe79eceeec756bcf54edf04cc29ee5306ab32e',
  ABYSS:       '0x392d5f46b5f02fb34cc0cb06c27e89b6e4dacc4cafd41e3b9ac1bc9f02dd1598',
  DRIFT:       '0x289d866bfff98a9811f20a76cea5a4e935ff91931af521189f7f389e509a414c',
  WALRUS_AGG:  'https://aggregator.walrus.site',
  WALRUS_PUB:  'https://publisher.walrus.site',
  SEAL_SERVER: 'https://seal.mystenlabs.com',
}

export const PACKAGES = {
  CONK:  '0x92e015ba78f91f40a33d7d023c347cfa7ac0aaa0d35dcd72a1909974e51f7274', // v2 — fee enforcement (2026-05-08)
  RELAY: '0x92e015ba78f91f40a33d7d023c347cfa7ac0aaa0d35dcd72a1909974e51f7274',
}

export const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'

export const RPC = {
  MAINNET_RPC: 'https://fullnode.mainnet.sui.io:443',
  PROXY,
}

export const SUI_RPC = RPC.MAINNET_RPC

export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '628835024151-6u8eqr51da1ldcteub2986451sg69kpo.apps.googleusercontent.com'
