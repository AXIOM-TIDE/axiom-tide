#!/usr/bin/env node
/**
 * upgrade-stream.mjs — CONK v9 upgrade PTB
 *
 * Adds stream.move (Primitive 9 of 9) to axiom_tide on Sui mainnet.
 * Same pattern as upgrade-chest.mjs — bypasses the Sui CLI bug where
 * it resolves package_id to the original address instead of cap.package.
 *
 * Usage (on your MacBook with the deployer key):
 *   cd /path/to/CONK
 *   npm install                    # installs @mysten/sui if not present
 *   sui keytool export --key-identity <deployer-address> --json
 *   export SUI_PRIVATE_KEY="suiprivkey1..."
 *   node upgrade-stream.mjs --dry-run   # simulate first
 *   node upgrade-stream.mjs             # live deploy
 *
 * After success: DM Franklin the new package ID printed at the end.
 */

import { execSync }       from 'child_process';
import { fileURLToPath }  from 'url';
import { dirname, join }  from 'path';

import { Transaction }               from '@mysten/sui/transactions';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair }            from '@mysten/sui/keypairs/ed25519';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Constants ────────────────────────────────────────────────────────────────
const UPGRADE_CAP     = '0x45ac8ab33db324f1f6a5cb7fdf726b132846a3ee5fd35c8ec3d2795d747784b2';
const CURRENT_PACKAGE = '0x5b2581953997faa81c3294d1ed5619ad9f1acf2883197727a54c6a0cbdb067f3'; // v8
const PROTOCOL_DIR    = join(__dirname, 'protocol');
const DRY_RUN         = process.argv.includes('--dry-run');

// ─── Load keypair ─────────────────────────────────────────────────────────────
function loadKeypair() {
  const raw = process.env.SUI_PRIVATE_KEY?.trim();
  if (!raw) {
    console.error([
      '',
      '❌  SUI_PRIVATE_KEY not set.',
      '',
      '    1. Export your deployer key:',
      '         sui keytool export --key-identity <deployer-address> --json',
      '    2. Copy "exportedPrivateKey" (starts with suiprivkey1…)',
      '    3. export SUI_PRIVATE_KEY="suiprivkey1..."',
      '    4. node upgrade-stream.mjs --dry-run',
      '',
    ].join('\n'));
    process.exit(1);
  }
  if (!raw.startsWith('suiprivkey1')) {
    console.error('❌  Key must be bech32 suiprivkey1… format.');
    console.error('    Get it with: sui keytool export --key-identity <address> --json');
    process.exit(1);
  }
  return Ed25519Keypair.fromSecretKey(raw);
}

// ─── Build package ────────────────────────────────────────────────────────────
function buildPackage() {
  console.log('🔨  Building package…');
  let raw;
  try {
    raw = execSync('sui move build --dump-bytecode-as-base64 --path .', {
      cwd:   PROTOCOL_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
  } catch (e) {
    console.error('❌  Build failed:');
    console.error(e.stderr?.toString() || e.message);
    process.exit(1);
  }

  const start = raw.indexOf('{');
  if (start === -1) {
    console.error('❌  No JSON in build output. Raw:\n', raw);
    process.exit(1);
  }

  const { modules, dependencies, digest } = JSON.parse(raw.slice(start));
  console.log(`✅  Build OK — ${modules.length} module(s), ${dependencies.length} dep(s)`);
  return { modules, dependencies, digest };
}

// ─── Normalise digest ─────────────────────────────────────────────────────────
function digestToArray(digest) {
  if (Array.isArray(digest)) return digest;
  return Array.from(Buffer.from(digest, 'base64'));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const keypair = loadKeypair();
  const address = keypair.getPublicKey().toSuiAddress();
  console.log(`🔑  Deployer : ${address}`);

  const { modules, dependencies, digest } = buildPackage();

  const client = new SuiClient({ url: getFullnodeUrl('mainnet') });

  // Verify UpgradeCap on-chain
  console.log('\n🔍  Checking UpgradeCap on-chain…');
  const capObj = await client.getObject({ id: UPGRADE_CAP, options: { showContent: true } });
  const fields = capObj.data?.content?.fields;
  if (!fields) {
    console.error('❌  Could not read UpgradeCap');
    process.exit(1);
  }
  console.log(`    cap.package : ${fields.package}`);
  console.log(`    cap.version : ${fields.version}`);
  console.log(`    cap.policy  : ${fields.policy}`);

  if (fields.package !== CURRENT_PACKAGE) {
    console.error(
      `\n❌  CURRENT_PACKAGE mismatch!\n` +
      `    on-chain : ${fields.package}\n` +
      `    script   : ${CURRENT_PACKAGE}\n` +
      `    Edit CURRENT_PACKAGE at the top of this script and retry.`
    );
    process.exit(1);
  }
  console.log('✅  Cap matches — v8 confirmed, upgrading to v9\n');

  // Build PTB
  const tx = new Transaction();

  const ticket = tx.moveCall({
    target: '0x2::package::authorize_upgrade',
    arguments: [
      tx.object(UPGRADE_CAP),
      tx.pure.u8(0),                                    // COMPATIBLE policy
      tx.pure.vector('u8', digestToArray(digest)),
    ],
  });

  const receipt = tx.upgrade({
    modules,
    dependencies,
    package: CURRENT_PACKAGE,   // ← must be cap.package, not original package ID
    ticket,
  });

  tx.moveCall({
    target: '0x2::package::commit_upgrade',
    arguments: [tx.object(UPGRADE_CAP), receipt],
  });

  tx.setGasBudget(300_000_000);

  if (DRY_RUN) {
    console.log('🟡  Dry run — simulating (no gas spent)…');
    const built = await tx.build({ client });
    const dry   = await client.dryRunTransactionBlock({ transactionBlock: built });
    const status = dry.effects.status;
    if (status.status === 'success') {
      console.log('✅  Dry run SUCCESS — safe to run without --dry-run');
    } else {
      console.error('❌  Dry run FAILED:', status.error);
      process.exit(1);
    }
    return;
  }

  // Execute
  console.log('🚀  Submitting upgrade to mainnet…');
  const result = await client.signAndExecuteTransaction({
    signer:      keypair,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true },
  });

  const status = result.effects?.status?.status;
  console.log(`\n    tx digest : ${result.digest}`);
  console.log(`    status    : ${status}`);

  if (status !== 'success') {
    console.error('❌  Transaction failed:', result.effects?.status?.error);
    console.error(`    Explorer  : https://suiscan.xyz/mainnet/tx/${result.digest}`);
    process.exit(1);
  }

  const published = result.objectChanges?.find(c => c.type === 'published');
  if (published) {
    console.log(`\n✅  CONK v9 DEPLOYED`);
    console.log(`    new package : ${published.packageId}`);
    console.log(`    new version : ${published.version}`);
    console.log(`    Explorer    : https://suivision.xyz/txblock/${result.digest}`);
    console.log('\n    → DM Franklin the new package ID so he can update SDK + Move.toml.');
  } else {
    console.log(`✅  Done. Explorer: https://suiscan.xyz/mainnet/tx/${result.digest}`);
  }
}

main().catch(err => {
  console.error('\n❌  Fatal:', err?.message || err);
  if (err?.data) console.error('    data:', JSON.stringify(err.data, null, 2));
  process.exit(1);
});
