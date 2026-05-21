/// AXIOM TIDE PROTOCOL · v11.0.0
/// PROTOCOL CONFIG · Dynamic Lighthouse Threshold
/// Threshold = max(FLOOR, lh_count × SCARCITY_MULTIPLIER).
/// Only increases. Scarcity is permanent.
/// Permissionless recalibration — anyone may call recalibrate().
/// Copyright © 2026 Axiom Tide LLC · axiomtide.com
module axiom_tide::config {
    use sui::object::{Self, UID};
    use sui::tx_context::TxContext;
    use sui::transfer;
    use sui::event;
    use sui::clock::{Self, Clock};
    use axiom_tide::drift::{Self, Drift};

    // ─── Constants ────────────────────────────────────────────────────────────
    const MIN_THRESHOLD:       u64 = 1_000;   // $0.001 × 1000 = $1 attack cost floor
    const SCARCITY_MULTIPLIER: u64 = 100;     // threshold = lh_count × 100
    const AGE_GATE_DISABLED:   u64 = 0;       // vessel_age_gate_ms: 0 = disabled

    // ─── Errors ───────────────────────────────────────────────────────────────
    const E_THRESHOLD_BELOW_FLOOR: u64 = 1;   // reserved for future admin floor-change gate

    // ─── Structs ──────────────────────────────────────────────────────────────

    public struct ProtocolConfig has key {
        id:                   UID,
        /// Current Lighthouse read threshold (24h window).
        /// Computed as max(min_threshold, lh_count × scarcity_multiplier).
        /// Monotonically increasing — never decreases.
        lighthouse_threshold: u64,
        /// Hard floor — threshold never drops below this value.
        min_threshold:        u64,
        /// Multiplier applied to lh_count for threshold scaling.
        scarcity_multiplier:  u64,
        /// Reserved: minimum Vessel age in ms for a read to count toward
        /// Lighthouse threshold. 0 = disabled. Future anti-gaming gate.
        vessel_age_gate_ms:   u64,
        /// Timestamp of last recalibration.
        last_recalibrated:    u64,
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    public struct ThresholdRatcheted has copy, drop {
        old_threshold: u64,
        new_threshold: u64,
        lh_count:      u64,
        ratcheted_at:  u64,
    }

    // ─── Init ─────────────────────────────────────────────────────────────────

    fun init(ctx: &mut TxContext) {
        transfer::share_object(ProtocolConfig {
            id:                   object::new(ctx),
            lighthouse_threshold: MIN_THRESHOLD,
            min_threshold:        MIN_THRESHOLD,
            scarcity_multiplier:  SCARCITY_MULTIPLIER,
            vessel_age_gate_ms:   AGE_GATE_DISABLED,
            last_recalibrated:    0,
        });
    }

    // ─── Public entry points ──────────────────────────────────────────────────

    /// Permissionless recalibration.
    ///
    /// Reads drift.lh_count and computes:
    ///   new_threshold = max(min_threshold, lh_count × scarcity_multiplier)
    ///
    /// Updates threshold only if new_threshold > current (ratchet: up only).
    /// Can be called by anyone — typically in the same PTB as the read that
    /// crosses a Lighthouse milestone, so the threshold is current atomically.
    public fun recalibrate(
        config: &mut ProtocolConfig,
        drift:  &Drift,
        clock:  &Clock,
        _ctx:   &TxContext,
    ) {
        let lh_count      = drift::lh_count(drift);
        let scaled        = lh_count * config.scarcity_multiplier;
        let new_threshold = if (scaled > config.min_threshold) { scaled }
                            else { config.min_threshold };

        if (new_threshold > config.lighthouse_threshold) {
            let old = config.lighthouse_threshold;
            config.lighthouse_threshold = new_threshold;
            config.last_recalibrated    = clock::timestamp_ms(clock);
            event::emit(ThresholdRatcheted {
                old_threshold: old,
                new_threshold,
                lh_count,
                ratcheted_at: config.last_recalibrated,
            });
        }
    }

    // ─── View helpers ─────────────────────────────────────────────────────────
    public fun lighthouse_threshold(c: &ProtocolConfig): u64 { c.lighthouse_threshold }
    public fun min_threshold(c: &ProtocolConfig):        u64 { c.min_threshold }
    public fun scarcity_multiplier(c: &ProtocolConfig):  u64 { c.scarcity_multiplier }
    public fun vessel_age_gate_ms(c: &ProtocolConfig):   u64 { c.vessel_age_gate_ms }
    public fun last_recalibrated(c: &ProtocolConfig):    u64 { c.last_recalibrated }

    // ─── Internal (used by cast::check_tide) ──────────────────────────────────
    /// Tide thresholds scale proportionally:
    ///   each tide = lighthouse_threshold / 2
    /// At threshold=1000: each tide = 500
    /// At threshold=10000: each tide = 5000
    public fun tide_threshold(c: &ProtocolConfig): u64 {
        c.lighthouse_threshold / 2
    }
}
