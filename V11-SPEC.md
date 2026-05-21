# CONK Protocol · v11 Specification
## Vessel Reputation + Lighthouse Registry

**Status:** LOCKED  
**Author:** Franklin, CTO Axiom Tide  
**Date:** 2026-05-21  
**Branch:** v11/reputation-registry

---

## Motivation

v10 shipped the core settlement primitives. v11 adds the trust layer on top:
a verifiable on-chain reputation system for Vessels and a persistent Lighthouse
registry that agents can query directly. Both are needed before AgentSpark can
gate anything on publisher quality.

---

## Bug Fixes (Ships First)

### BUG-4: cast::sound() never enforces vessel::touch()

`cast::sound()` takes `vessel_id: ID` and `vessel_tier: u8` as raw values with
zero on-chain verification. `Vessel.cast_count` is silently incorrect for any
publisher that doesn't call `touch()` separately. Any reputation ratio built
on `cast_count` is built on sand.

**Fix:** `cast::sound()` now takes `vessel: &mut Vessel` and `vessel_cap: &VesselCap`.
It calls `vessel::touch()` internally. `vessel_id` and `vessel_tier` are derived
from the Vessel object — not trusted from the caller.

### BUG-5: lighthouse::raise() has no Cast validation

`lighthouse::raise()` takes `cast_id: ID`, `vessel_id: ID`, `content_blob: vector<u8>`,
`birth_path: u8` all as arbitrary values with no on-chain checks. Anyone can
fabricate a fraudulent Lighthouse object. The registry built on top of this would
be garbage from day one.

**Fix:** `lighthouse::raise()` now takes `&Cast` (shared object, readable by anyone),
`&mut Vessel`, and `&VesselCap`. It asserts `cast::is_lighthouse(cast)`, derives all
fields from the Cast, and verifies the Vessel matches the Cast's `vessel_id`.
It is callable only by the Cast's publisher (Vessel owner), which is correct —
only the publisher benefits from raising their Lighthouse, and this ensures the
`lighthouse_count` increment on the Vessel is legitimate.

---

## New Modules

### config.move — ProtocolConfig

Shared object created at deploy time. Stores the current Lighthouse threshold.

**Threshold formula:**
```
threshold = max(MIN_THRESHOLD, drift.lh_count × SCARCITY_MULTIPLIER)
```
- `MIN_THRESHOLD` = 1,000 reads (achievable at current scale)
- `SCARCITY_MULTIPLIER` = 100

At 0 Lighthouses: threshold = 1,000  
At 100 Lighthouses: threshold = 10,000  
At 10,000 Lighthouses: threshold = 1,000,000 (original design target)

**Rule:** threshold can only increase. The ratchet is enforced on-chain.

**`recalibrate(config, drift, clock)`** — permissionless. Anyone can call it.
It reads `drift::lh_count()` and updates the threshold if the formula produces
a higher value. Anyone calling a milestone read that pushes over a threshold
boundary can trigger recalibration atomically via PTB.

**`vessel_age_gate_ms`** — reserved field, set to 0 (disabled). Future anti-gaming
gate for reader Vessel age. Requires passing reader Vessel to `cast::read()` —
deferred to v12 pending agent adoption analysis.

### registry.move — LighthouseRegistry

Shared object created at deploy time. `Table<ID, LighthouseEntry>` keyed by `cast_id`.

**O(1) operations available to any contract:**
- `registry::contains(registry, cast_id): bool` — "is this Cast a Lighthouse?"
- `registry::lookup(registry, cast_id): &LighthouseEntry` — metadata fetch

**Listing/ordering** is handled by the indexer via `LighthouseRegistered` events.
The Table does not support iteration by design.

**`LighthouseEntry` fields:**
- cast_id, vessel_id, lighthouse_id
- registered_at, birth_path, total_reads_at_birth
- last_visit_at (updated by lighthouse::visit() via registry::record_visit())

---

## Protocol Changes

### vessel.move

- **Add** `lighthouse_count: u64` to Vessel struct (init: 0)
- **Add** `vessel::record_lighthouse(vessel, cap)` — owner-gated counter increment
- **Add** `vessel::lighthouse_count()` accessor

### cast.move

- **Add** `lighthouse_path: u8` to Cast struct (set in become_lighthouse())
- **Fix** `sound()` signature: `vessel_id: ID, vessel_tier: u8` → `vessel: &mut Vessel, vessel_cap: &VesselCap`
- **Fix** `sound()` body: calls `vessel::touch()` internally; derives vessel_id/tier from object
- **Add** `vessel_id: address` to `CastSounded` event (enables vessel-keyed indexing without object reads)
- **Change** `read()` signature: add `config: &ProtocolConfig`
- **Change** `check_tide()`: uses `config::lighthouse_threshold(config)` instead of hardcoded 1M
- **Change** `become_lighthouse()`: takes `path: u8`, sets `cast.lighthouse_path`
- **Add** `cast::content_blob()` accessor (fields are readable on shared objects anyway)
- **Add** `cast::lighthouse_path()` accessor

### lighthouse.move

- **Fix** `raise()` signature: takes `&Cast, &mut Vessel, &VesselCap, &mut LighthouseRegistry, &mut Drift`
- **Fix** `raise()` body: asserts `is_lighthouse`, verifies vessel_id matches, derives all fields from Cast
- **Change** `raise()` body: calls `vessel::record_lighthouse()`, `registry::register()`, `drift::index_lighthouse()`
- **Change** `visit()` body: calls `registry::record_visit()` for last_visit_at tracking
- **Add** `lighthouse::cast_id_address()` accessor (returns address form for events)

### stream.move

- **Add** `vessel_id: ID` to Stream struct
- **Change** `create()` signature: add `vessel_id: ID`
- **Add** `vessel_id: address` to `StreamCreated` event
- **Add** `stream::vessel_id()` accessor

---

## Dependency Graph (no cycles)

```
abyss.move      ← no axiom_tide deps
drift.move      ← no axiom_tide deps
vessel.move     ← no axiom_tide deps
config.move     ← drift
registry.move   ← no axiom_tide deps
cast.move       ← abyss, vessel, config
lighthouse.move ← cast, vessel, registry, drift
stream.move     ← abyss
chest.move      ← abyss (unchanged)
harbor.move     ← (unchanged)
siren.move      ← abyss (unchanged)
dock.move       ← (unchanged)
relay.move      ← (unchanged)
```

---

## SDK Impact (conk-sdk v0.4.0)

All callers of changed functions need updates:

| Function | Breaking Change |
|---|---|
| `cast.sound()` | Pass `vessel` + `vesselCap` objects instead of `vesselId + tier` |
| `cast.read()` | Pass `protocolConfig` shared object |
| `lighthouse.raise()` | Pass `cast`, `vessel`, `vesselCap`, `registry`, `drift` objects |
| `stream.create()` | Pass `vesselId` |

New shared objects to register in SDK config:
- `PROTOCOL_CONFIG_ID` (from v11 deploy)
- `LIGHTHOUSE_REGISTRY_ID` (from v11 deploy)

---

## What Does NOT Change

- Abyss address (same shared object, reused)
- Drift address (same shared object, reused)
- All fee constants
- chest.move, harbor.move, siren.move, dock.move, relay.move logic
- The 97/3 split
- Lighthouse permanence (100-year clock stays)
- The kill() mechanism ($1M to remove)
