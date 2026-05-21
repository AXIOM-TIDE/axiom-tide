/// AXIOM TIDE PROTOCOL · v11.0.0
/// PRIMITIVE 7 OF 7 · LIGHTHOUSE
/// The permanent record. Earned by the tide. Never purchased.
/// 100yr clock. $1M to remove. No human override. Ever.
/// GENESIS LIGHTHOUSE · placed by founder · free · permanent · forever.
/// v11: BUG-5 fixed — raise() now takes &Cast and validates is_lighthouse.
///      vessel_id, content_blob, and birth_path derived from Cast — not caller-trusted.
///      raise() is now publisher-only (requires Vessel + VesselCap).
///      Atomically registers into LighthouseRegistry and indexes into Drift.
///      visit() updates registry last_visit_at.
/// Copyright © 2026 Axiom Tide LLC · axiomtide.com
module axiom_tide::lighthouse {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::TxContext;
    use sui::transfer;
    use sui::event;
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use 0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC;
    use axiom_tide::cast::{Self, Cast};
    use axiom_tide::vessel::{Self, Vessel, VesselCap};
    use axiom_tide::registry::{Self, LighthouseRegistry};
    use axiom_tide::drift::{Self, Drift};

    const E_INSUFFICIENT_KILL: u64 = 1;
    const E_GENESIS_IMMORTAL:  u64 = 2;   // reserved for future GenesisLighthouse kill-gate
    const E_CAST_NOT_LIGHTHOUSE: u64 = 3;  // v11: Cast has not earned Lighthouse status
    const E_VESSEL_MISMATCH:    u64 = 4;   // v11: Cast's vessel_id ≠ provided Vessel

    const LH_LIFESPAN_MS: u64 = 100 * 365 * 24 * 60 * 60 * 1000;
    const KILL_COST:       u64 = 1_000_000_000_000;

    const PATH_MILLION: u8 = 1;
    const PATH_TIDES:   u8 = 2;
    const PATH_GENESIS: u8 = 0;

    public struct Lighthouse has key {
        id:           UID,
        cast_id:      ID,
        vessel_id:    ID,
        content_blob: vector<u8>,
        created_at:   u64,
        last_visit:   u64,
        visit_count:  u64,
        birth_path:   u8,
    }

    public struct GenesisLighthouse has key {
        id:           UID,
        message:      vector<u8>,
        content_blob: vector<u8>,
        placed_at:    u64,
        placed_by:    address,
        visit_count:  u64,
    }

    public struct LighthouseStands has copy, drop {
        lighthouse_id: address,
        cast_id:       address,
        vessel_id:     address,
        birth_path:    u8,
        total_reads:   u64,
        stands_at:     u64,
    }

    public struct LighthouseVisited has copy, drop {
        lighthouse_id: address,
        visit_count:   u64,
        visited_at:    u64,
        expires_at:    u64,
    }

    public struct LighthouseFallen has copy, drop {
        lighthouse_id: address,
        visit_count:   u64,
        stood_for_ms:  u64,
        fallen_at:     u64,
    }

    public struct GenesisPlaced has copy, drop {
        lighthouse_id: address,
        placed_by:     address,
        placed_at:     u64,
    }

    public struct GenesisVisited has copy, drop {
        lighthouse_id: address,
        visit_count:   u64,
        visited_at:    u64,
    }

    // ─── raise() — BUG-5 FIX ──────────────────────────────────────────────────
    //
    // v11 breaking change: no longer takes cast_id/vessel_id/content_blob/birth_path
    // as raw values. Requires:
    //   &Cast      — validates is_lighthouse, derives all fields
    //   &mut Vessel + &VesselCap — verifies publisher identity, increments lighthouse_count
    //   &mut LighthouseRegistry — atomically registers into the on-chain index
    //   &mut Drift — atomically calls index_lighthouse for feed consistency
    //
    // Publisher-only: only the Cast's Vessel owner can call raise().
    // Permissionless to VERIFY (the Cast is readable by anyone), but gated on
    // Vessel ownership to ensure lighthouse_count is credibly incremented.

    public fun raise(
        cast:       &Cast,
        vessel:     &mut Vessel,
        vessel_cap: &VesselCap,
        registry:   &mut LighthouseRegistry,
        drift:      &mut Drift,
        clock:      &Clock,
        ctx:        &mut TxContext,
    ) {
        // BUG-5: verify Cast earned Lighthouse status on-chain
        assert!(cast::is_lighthouse(cast), E_CAST_NOT_LIGHTHOUSE);

        // Verify the provided Vessel is the one that published this Cast
        assert!(cast::vessel_id(cast) == object::id(vessel), E_VESSEL_MISMATCH);

        let cast_id      = object::id(cast);
        let vessel_id    = object::id(vessel);
        let content_blob = cast::content_blob(cast);
        let birth_path   = cast::lighthouse_path(cast);
        let total_reads  = cast::read_count(cast);
        let now          = clock::timestamp_ms(clock);

        // Increment lighthouse_count on the Vessel — protocol-enforced.
        // vessel_id match was already asserted above.
        vessel::record_lighthouse(vessel, vessel_cap, clock);

        let lh = Lighthouse {
            id:           object::new(ctx),
            cast_id,
            vessel_id,
            content_blob,
            created_at:   now,
            last_visit:   now,
            visit_count:  total_reads,
            birth_path,
        };

        let lh_id     = object::id(&lh);
        let lh_addr   = object::id_to_address(&lh_id);
        let cast_addr = object::id_to_address(&cast_id);

        event::emit(LighthouseStands {
            lighthouse_id: lh_addr,
            cast_id:       cast_addr,
            vessel_id:     object::id_to_address(&vessel_id),
            birth_path,
            total_reads,
            stands_at:     now,
        });

        // Atomically register into the on-chain registry
        registry::register(
            registry,
            cast_id,
            vessel_id,
            lh_id,
            birth_path,
            total_reads,
            now,
        );

        // Atomically update Drift feed index
        drift::index_lighthouse(drift, cast_addr, lh_addr, birth_path, clock, ctx);

        transfer::share_object(lh);
    }

    /// Visit a Lighthouse. Updates last_visit (rolling 100yr window) and
    /// records the visit in the registry for recency tracking.
    public fun visit(
        lh:       &mut Lighthouse,
        registry: &mut LighthouseRegistry,
        clock:    &Clock,
        _ctx:     &TxContext,
    ) {
        let now        = clock::timestamp_ms(clock);
        lh.visit_count = lh.visit_count + 1;
        lh.last_visit  = now;

        let lh_addr = object::id_to_address(&object::id(lh));
        event::emit(LighthouseVisited {
            lighthouse_id: lh_addr,
            visit_count:   lh.visit_count,
            visited_at:    now,
            expires_at:    now + LH_LIFESPAN_MS,
        });

        // Update registry last_visit_at for recency filtering
        registry::record_visit(
            registry,
            lh.cast_id,
            object::id(lh),
            lh.visit_count,
            now,
        );
    }

    public fun kill(
        lh:      Lighthouse,
        payment: Coin<USDC>,
        clock:   &Clock,
        _ctx:    &TxContext,
    ): Coin<USDC> {
        assert!(coin::value(&payment) >= KILL_COST, E_INSUFFICIENT_KILL);
        let now       = clock::timestamp_ms(clock);
        let lh_addr   = object::id_to_address(&object::id(&lh));
        let stood_for = now - lh.created_at;
        let visits    = lh.visit_count;
        let Lighthouse { id, cast_id:_, vessel_id:_, content_blob:_,
                         created_at:_, last_visit:_, visit_count:_,
                         birth_path:_ } = lh;
        object::delete(id);
        event::emit(LighthouseFallen {
            lighthouse_id: lh_addr,
            visit_count:   visits,
            stood_for_ms:  stood_for,
            fallen_at:     now,
        });
        payment
    }

    public fun place_genesis(
        message:      vector<u8>,
        content_blob: vector<u8>,
        clock:        &Clock,
        ctx:          &mut TxContext,
    ) {
        let placer  = sui::tx_context::sender(ctx);
        let now     = clock::timestamp_ms(clock);
        let genesis = GenesisLighthouse {
            id:           object::new(ctx),
            message,
            content_blob,
            placed_at:    now,
            placed_by:    placer,
            visit_count:  0,
        };
        let addr = object::id_to_address(&object::id(&genesis));
        event::emit(GenesisPlaced {
            lighthouse_id: addr,
            placed_by:     placer,
            placed_at:     now,
        });
        transfer::share_object(genesis);
    }

    public fun visit_genesis(
        genesis: &mut GenesisLighthouse,
        clock:   &Clock,
        _ctx:    &TxContext,
    ) {
        genesis.visit_count = genesis.visit_count + 1;
        event::emit(GenesisVisited {
            lighthouse_id: object::id_to_address(&object::id(genesis)),
            visit_count:   genesis.visit_count,
            visited_at:    clock::timestamp_ms(clock),
        });
    }

    // ─── View helpers ─────────────────────────────────────────────────────────
    public fun cast_id(lh: &Lighthouse):      ID         { lh.cast_id }
    public fun vessel_id(lh: &Lighthouse):    ID         { lh.vessel_id }
    public fun visit_count(lh: &Lighthouse):  u64        { lh.visit_count }
    public fun birth_path(lh: &Lighthouse):   u8         { lh.birth_path }
    public fun last_visit(lh: &Lighthouse):   u64        { lh.last_visit }
    public fun expires_at(lh: &Lighthouse):   u64        { lh.last_visit + LH_LIFESPAN_MS }
    public fun genesis_visits(g: &GenesisLighthouse): u64        { g.visit_count }
    public fun genesis_message(g: &GenesisLighthouse): vector<u8> { g.message }
    public fun kill_cost():    u64 { KILL_COST }
    public fun path_million(): u8  { PATH_MILLION }
    public fun path_tides():   u8  { PATH_TIDES }
    public fun path_genesis(): u8  { PATH_GENESIS }
    public fun lh_lifespan_ms(): u64 { LH_LIFESPAN_MS }
}
