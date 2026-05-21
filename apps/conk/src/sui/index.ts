/**
 * CONK Sui Integration Layer
 * Deployed to Sui Mainnet — April 24, 2026 (v6); upgraded May 8, 2026 (v7 — fee enforcement); upgraded May 10, 2026 (v7 — sound_v2)
 * Package v12: 0x288aa827aafc16a7ae429f8a82fc512597c481950d98bd6161402a52f9e00745 (wreck() — 2026-05-21)
 * Package v11: 0x734b19fa1696dec30f8cae38f1cdbf0ab5a12720735f7c7b0d4935cab31732cc (SUPERSEDED)
 * Treasury: 0xe0117fba317d2267b8d90adca1fe79eceeec756bcf54edf04cc29ee5306ab32e
 * Axiom Tide LLC · Casper, Wyoming
 */

const PROXY = 'https://conk-zkproxy-v2.italktonumbers.workers.dev'

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
  CONK:  '0x288aa827aafc16a7ae429f8a82fc512597c481950d98bd6161402a52f9e00745', // v12 — wreck() (2026-05-21)
  RELAY: '0xb4220c9faa4e6be4b557d3c81772f96ef90d5688009887a1c73ef9b7eaa6917c',
}

export const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'

export const RPC = {
  MAINNET_RPC: 'https://fullnode.mainnet.sui.io:443',
  PROXY,
}

export const SUI_RPC = RPC.MAINNET_RPC

export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '628835024151-6u8eqr51da1ldcteub2986451sg69kpo.apps.googleusercontent.com'
