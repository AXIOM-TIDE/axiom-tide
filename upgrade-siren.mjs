#!/usr/bin/env node
/**
 * upgrade-siren.mjs
 * Manual upgrade PTB for axiom_tide — bypasses Sui CLI package_id resolution bug.
 *
 * The CLI walks the linkage table and resolves axiom_tide to 0x23a10fe5 (original)
 * instead of 0xb8fe6a23 (cap.package). This script sets `package:` explicitly.
 *
 * Usage:
 *   export SUI_PRIVATE_KEY="suiprivkey1..."   # from: sui keytool export --key-identity <address> --json
 *   node upgrade-siren.mjs [--dry-run]
 *
 * Or with inline key:
 *   SUI_PRIVATE_KEY="suiprivkey1..." node upgrade-siren.mjs
 */

import { execSync }        from 'child_process';
import { createRequire }   from 'module';
import { fileURLToPath }   from 'url';
import { dirname, join }   from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

// ─── Resolve @mysten/sui from conk-sdk's node_modules ───────────────────────
const SDK_BASE = join(__dirname, '../conk-sdk/node_modules/@mysten/sui/dist/cjs');

const { Transaction }      = require(join(SDK_BASE, 'transactions/index.js'));
const { SuiClient, getFullnodeUrl } = require(join(SDK_BASE, 'client/index.js'));
const { Ed25519Keypair }   = require(join(SDK_BASE, 'keypairs/ed25519/index.js'));

// ─── Constants ───────────────────────────────────────────────────────────────
const UPGRADE_CAP     = '0x45ac8ab33db324f1f6a5cb7fdf726b132846a3ee5fd35c8ec3d2795d747784b2';
const CURRENT_PACKAGE = '0xb8fe6a23c3cd3f5ed4affe2b86f9e589cfa7e955d52c21b478153ee3dc0a437f';
const PROTOCOL_DIR    = join(__dirname, 'protocol');
const DRY_RUN         = process.argv.includes('--dry-run');

// ─── 1. Load keypair ─────────────────────────────────────────────────────────
function loadKeypair() {
  const raw = process.env.SUI_PRIVATE_KEY;
  if (!raw) {
    console.error([
      '❌  SUI_PRIVATE_KEY not set.',
      '',
      '    Export your deployer key:',
      '      sui keytool export --key-identity 0x4c320500...e2ea26 --json',
      '    Copy the "exportedPrivateKey" field (starts with suiprivkey1…), then:',
      '      export SUI_PRIVATE_KEY="suiprivkey1…"',
      '      node upgrade-siren.mjs',
    ].join('\n'));
    process.exit(1);
  }
  if (raw.startsWith('suiprivkey1')) {
    return Ed25519Keypair.fromSecretKey(raw);
  }
  // Fallback: bare 64-char hex or 44-char base64 32-byte key
  console.error('❌  Key must be bech32 suiprivkey1… format. Use: sui keytool export --json');
  process.exit(1);
}

// ─── 2. Build package & extract bytecode ─────────────────────────────────────
function buildPackage() {
  console.log('🔨  Building package (sui move build --dump-bytecode-as-base64)…');
  let raw;
  try {
    raw = execSync(
      'sui move build --dump-bytecode-as-base64 --path .',
      { cwd: PROTOCOL_DIR, stdio: ['pipe', 'pipe', 'inherit'] }
    ).toString().trim();
  } catch (e) {
    console.error('❌  Build failed — fix Move errors before upgrading.');
    process.exit(1);
  }

  // sui CLI sometimes emits extra lines before the JSON blob; find the JSON.
  const jsonStart = raw.indexOf('{');
  if (jsonStart === -1) {
    console.error('❌  Could not find JSON in build output:\n', raw);
    process.exit(1);
  }
  const parsed = JSON.parse(raw.slice(jsonStart));

  // Normalise: modules may be base64 strings or Uint8Arrays depending on SDK version
  const modules      = parsed.modules;      // string[] base64
  const dependencies = parsed.dependencies; // string[]  "0x…"
  const digest       = parsed.digest;       // number[] | string (base64)

  console.log(`✅  Build OK — ${modules.length} module(s), ${dependencies.length} dep(s)`);
  console.log('    Dependencies:', dependencies);
  return { modules, dependencies, digest };
}

// ─── 3. Normalise digest to Uint8Array ───────────────────────────────────────
function toDigestBytes(digest) {
  if (Array.isArray(digest)) return new Uint8Array(digest);
  // base64 string
  return Uint8Array.from(Buffer.from(digest, 'base64'));
}

// ─── 4. Main ─────────────────────────────────────────────────────────────────
async function main() {
  const keypair = loadKeypair();
  const address = keypair.getPublicKey().toSuiAddress();
  console.log(`🔑  Deployer: ${address}`);

  const { modules, dependencies, digest } = buildPackage();
  const digestBytes = toDigestBytes(digest);

  const client = new SuiClient({ url: getFullnodeUrl('mainnet') });

  // ── Sanity-check the UpgradeCap on-chain ──────────────────────────────────
  console.log('\n🔍  Verifying UpgradeCap on-chain…');
  const capObj = await client.getObject({
    id: UPGRADE_CAP,
    options: { showContent: true },
  });
  const capFields = capObj.data?.content?.fields;
  if (!capFields) {
    console.error('❌  Could not fetch UpgradeCap. Check RPC or object ID.');
    process.exit(1);
  }
  console.log(`    cap.package : ${capFields.package}`);
  console.log(`    cap.version : ${capFields.version}`);
  console.log(`    cap.policy  : ${capFields.policy}`);

  if (capFields.package !== CURRENT_PACKAGE) {
    console.error(
      `❌  cap.package mismatch!\n` +
      `    on-chain : ${capFields.package}\n` +
      `    script   : ${CURRENT_PACKAGE}\n` +
      `    Update CURRENT_PACKAGE in this script and retry.`
    );
    process.exit(1);
  }
  console.log(`✅  UpgradeCap matches CURRENT_PACKAGE`);

  // ── Build PTB ─────────────────────────────────────────────────────────────
  const tx = new Transaction();

  // authorize_upgrade → UpgradeTicket
  const ticket = tx.moveCall({
    target: '0x2::package::authorize_upgrade',
    arguments: [
      tx.object(UPGRADE_CAP),
      tx.pure.u8(0),                                         // policy: COMPATIBLE
      tx.pure.vector('u8', Array.from(digestBytes)),
    ],
  });

  // Upgrade command — package: explicitly set to cap's current package
  const receipt = tx.upgrade({
    modules,
    dependencies,
    package: CURRENT_PACKAGE,   // ← the fix: CLI gets this wrong, we set it explicitly
    ticket,
  });

  // commit_upgrade
  tx.moveCall({
    target: '0x2::package::commit_upgrade',
    arguments: [tx.object(UPGRADE_CAP), receipt],
  });

  tx.setGasBudget(300_000_000);

  if (DRY_RUN) {
    console.log('\n🟡  DRY RUN — inspecting transaction (not submitting)…');
    const dryResult = await client.dryRunTransactionBlock({
      transactionBlock: await tx.build({ client }),
    });
    console.log('    status :', dryResult.effects.status);
    if (dryResult.effects.status.error) {
      console.error('❌  Dry run error:', dryResult.effects.status.error);
    } else {
      console.log('✅  Dry run succeeded — safe to run without --dry-run');
    }
    return;
  }

  // ── Sign & execute ────────────────────────────────────────────────────────
  console.log('\n🚀  Submitting upgrade transaction…');
  const result = await client.signAndExecuteTransaction({
    signer:      keypair,
    transaction: tx,
    options: {
      showEffects:       true,
      showObjectChanges: true,
    },
  });

  const status = result.effects?.status?.status;
  console.log(`\n    tx digest : ${result.digest}`);
  console.log(`    status    : ${status}`);

  if (status !== 'success') {
    console.error('❌  Transaction failed:', result.effects?.status?.error);
    process.exit(1);
  }

  // Pull new package ID from objectChanges
  const published = result.objectChanges?.find(c => c.type === 'published');
  if (published) {
    console.log(`\n✅  UPGRADE SUCCESSFUL`);
    console.log(`    new package ID : ${published.packageId}`);
    console.log(`    new version    : ${published.version}`);
    console.log(`\n    → Send Franklin the new package ID to update Move.toml + server.js`);
  } else {
    console.log('⚠️   No "published" object change found — check explorer:');
    console.log(`    https://suiscan.xyz/mainnet/tx/${result.digest}`);
  }
}



main().catch(err => {
  console.error('\n❌  Fatal:', err?.message || err);
  if (err?.code)    console.error('    code   :', err.code);
  if (err?.data)    console.error('    data   :', JSON.stringify(err.data, null, 2));
  process.exit(1);
});
