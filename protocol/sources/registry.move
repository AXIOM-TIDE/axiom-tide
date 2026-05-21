/// AXIOM TIDE PROTOCOL · v11.0.0
/// LIGHTHOUSE REGISTRY
/// Persistent on-chain index of all Lighthouse-status Casts.
/// Append-only. O(1) lookup and existence check — composable from any contract.
/// Listing and ordering handled by indexer via LighthouseRegistered events.
/// Table has no iteration by design: unbounded loops are gas-unsafe on Sui.
/// Copyright © 2026 Axiom Tide LLC · axiomtide.com
module axiom_tide::registry {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::TxContext;
    use sui::transfer;
    use sui::event;
    use sui::table::{Self, Table};

    // ─── Errors ───────────────────────────────────────────────────────────────
    const E_ALREADY_REGISTERED: u64 = 1;
    const E_NOT_FOUND:          u64 = 2;

    // ─── Structs ──────────────────────────────────────────────────────────────

    public struct LighthouseRegistry has key {
        id:            UID,
        /// cast_id → LighthouseEntry. Keyed by cast_id for O(1) composable lookup.
        entries:       Table<ID, LighthouseEntry>,
        /// Running count of registered Lighthouses.
        count:         u64,
        /// Timestamp of the most recent registration.
        last_added_at: u64,
    }

    /// Immutable entry stored per Lighthouse.
    /// last_visit_at is the one mutable field — updated by lighthouse::visit().
    public struct LighthouseEntry has store, copy, drop {
        cast_id:              ID,
        vessel_id:            ID,
        lighthouse_id:        ID,
        registered_at:        u64,
        birth_path:           u8,
        total_reads_at_birth: u64,
        /// Last time lighthouse::visit() was called. Updated in place.
        /// Indexers filter by recency using this field.
        last_visit_at:        u64,
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    public struct LighthouseRegistered has copy, drop {
        cast_id:       ID,
        vessel_id:     ID,
        lighthouse_id: ID,
        birth_path:    u8,
        reads_at_birth: u64,
        registry_size: u64,
        registered_at: u64,
    }

    public struct RegistryVisitRecorded has copy, drop {
        cast_id:       ID,
        lighthouse_id: ID,
        visit_count:   u64,
        last_visit_at: u64,
    }

    // ─── Init ─────────────────────────────────────────────────────────────────

    fun init(ctx: &mut TxContext) {
        transfer::share_object(LighthouseRegistry {
            id:            object::new(ctx),
            entries:       table::new(ctx),
            count:         0,
            last_added_at: 0,
        });
    }

    // ─── Internal writers (called only by lighthouse.move) ────────────────────

    /// Register a new Lighthouse. Called atomically inside lighthouse::raise().
    /// Aborts if already registered — raise() is idempotent on the Cast level.
    public fun register(
        registry:      &mut LighthouseRegistry,
        cast_id:       ID,
        vessel_id:     ID,
        lighthouse_id: ID,
        birth_path:    u8,
        total_reads:   u64,
        now:           u64,
    ) {
        assert!(!table::contains(&registry.entries, cast_id), E_ALREADY_REGISTERED);

        let entry = LighthouseEntry {
            cast_id,
            vessel_id,
            lighthouse_id,
            registered_at:        now,
            birth_path,
            total_reads_at_birth: total_reads,
            last_visit_at:        now,
        };

        table::add(&mut registry.entries, cast_id, entry);
        registry.count         = registry.count + 1;
        registry.last_added_at = now;

        event::emit(LighthouseRegistered {
            cast_id,
            vessel_id,
            lighthouse_id,
            birth_path,
            reads_at_birth: total_reads,
            registry_size:  registry.count,
            registered_at:  now,
        });
    }

    /// Update last_visit_at when lighthouse::visit() is called.
    /// No-op if the cast_id isn't in the registry (defensive; shouldn't happen).
    public fun record_visit(
        registry:      &mut LighthouseRegistry,
        cast_id:       ID,
        lighthouse_id: ID,
        visit_count:   u64,
        now:           u64,
    ) {
        if (!table::contains(&registry.entries, cast_id)) { return };
        let entry          = table::borrow_mut(&mut registry.entries, cast_id);
        entry.last_visit_at = now;
        event::emit(RegistryVisitRecorded {
            cast_id,
            lighthouse_id,
            visit_count,
            last_visit_at: now,
        });
    }

    // ─── Public read interface ─────────────────────────────────────────────────

    /// O(1) existence check — composable from any contract.
    /// Primary use: gate logic that requires Lighthouse status.
    public fun contains(registry: &LighthouseRegistry, cast_id: ID): bool {
        table::contains(&registry.entries, cast_id)
    }

    /// O(1) entry lookup. Aborts with E_NOT_FOUND if not registered.
    public fun lookup(registry: &LighthouseRegistry, cast_id: ID): &LighthouseEntry {
        assert!(table::contains(&registry.entries, cast_id), E_NOT_FOUND);
        table::borrow(&registry.entries, cast_id)
    }

    // ─── Registry-level view helpers ──────────────────────────────────────────
    public fun count(r: &LighthouseRegistry):         u64 { r.count }
    public fun last_added_at(r: &LighthouseRegistry): u64 { r.last_added_at }

    // ─── Entry view helpers ───────────────────────────────────────────────────
    public fun entry_cast_id(e: &LighthouseEntry):      ID  { e.cast_id }
    public fun entry_vessel_id(e: &LighthouseEntry):    ID  { e.vessel_id }
    public fun entry_lighthouse_id(e: &LighthouseEntry): ID { e.lighthouse_id }
    public fun entry_birth_path(e: &LighthouseEntry):   u8  { e.birth_path }
    public fun entry_reads(e: &LighthouseEntry):        u64 { e.total_reads_at_birth }
    public fun entry_registered_at(e: &LighthouseEntry): u64 { e.registered_at }
    public fun entry_last_visit(e: &LighthouseEntry):   u64 { e.last_visit_at }
}
