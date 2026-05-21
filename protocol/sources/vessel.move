/// AXIOM TIDE PROTOCOL · v11.0.0
/// PRIMITIVE 2 OF 7 · VESSEL
/// The identity. Mortal by design. Holds no USDC.
/// Ghost · Shadow · Open · fixed at launch.
/// Temp or permanent. 1yr silence then sinks forever.
/// v11: lighthouse_count added. record_lighthouse() is owner-gated.
/// Copyright © 2026 Axiom Tide LLC · axiomtide.com
module axiom_tide::vessel {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::event;
    use sui::clock::{Self, Clock};

    const E_VESSEL_EXPIRED:  u64 = 1;
    const E_NOT_OWNER:       u64 = 2;
    const E_INVALID_TIER:    u64 = 3;
    const E_ALREADY_IN_DOCK: u64 = 4;

    const GHOST:  u8 = 0;
    const SHADOW: u8 = 1;
    const OPEN:   u8 = 2;

    const LIFESPAN_MS: u64 = 365 * 24 * 60 * 60 * 1000;

    public struct Vessel has key, store {
        id:               UID,
        harbor_id:        ID,
        owner:            address,
        tier:             u8,
        created_at:       u64,
        last_cast:        u64,
        cast_count:       u64,
        active_dock:      address,
        burn_after_cast:  bool,
        /// v11: incremented by record_lighthouse() when a Cast published
        /// by this Vessel earns Lighthouse status.
        lighthouse_count: u64,
    }

    public struct VesselCap has key, store {
        id:         UID,
        vessel_id:  ID,
        harbor_id:  ID,
        owner:      address,
        tier:       u8,
    }

    public struct VesselLaunched has copy, drop {
        vessel_id:       address,
        harbor_id:       address,
        tier:            u8,
        launched_at:     u64,
        burn_after_cast: bool,
    }

    public struct VesselActive has copy, drop {
        vessel_id:  address,
        cast_count: u64,
        expires_at: u64,
    }

    public struct VesselSunk has copy, drop {
        vessel_id:  address,
        cast_count: u64,
        sunk_at:    u64,
        reason:     u8,
    }

    public struct VesselDockedIn has copy, drop {
        vessel_id: address,
        dock_id:   address,
        docked_at: u64,
    }

    public struct VesselDockedOut has copy, drop {
        vessel_id:   address,
        dock_id:     address,
        undocked_at: u64,
    }

    /// v11: emitted when a Lighthouse is acknowledged on this Vessel.
    public struct VesselLighthouseEarned has copy, drop {
        vessel_id:        address,
        lighthouse_count: u64,
        earned_at:        u64,
    }

    public fun launch(
        harbor_id:       ID,
        tier:            u8,
        burn_after_cast: bool,
        clock:           &Clock,
        ctx:             &mut TxContext,
    ): VesselCap {
        assert!(
            tier == GHOST || tier == SHADOW || tier == OPEN,
            E_INVALID_TIER
        );
        let owner = tx_context::sender(ctx);
        let now   = clock::timestamp_ms(clock);
        let vessel = Vessel {
            id:               object::new(ctx),
            harbor_id,
            owner,
            tier,
            created_at:       now,
            last_cast:        now,
            cast_count:       0,
            active_dock:      @0x0,
            burn_after_cast,
            lighthouse_count: 0,   // v11
        };
        let vessel_id   = object::id(&vessel);
        let vessel_addr = object::id_to_address(&vessel_id);
        event::emit(VesselLaunched {
            vessel_id:       vessel_addr,
            harbor_id:       object::id_to_address(&harbor_id),
            tier,
            launched_at:     now,
            burn_after_cast,
        });
        let cap = VesselCap {
            id:        object::new(ctx),
            vessel_id,
            harbor_id,
            owner,
            tier,
        };
        transfer::transfer(vessel, owner);
        cap
    }

    /// Increment cast_count and refresh the liveness timer.
    /// Called internally by cast::sound() — not directly by publishers anymore.
    /// Returns burn_after_cast so the SDK can sink the Vessel after sound().
    public fun touch(
        vessel: &mut Vessel,
        cap:    &VesselCap,
        clock:  &Clock,
        _ctx:   &TxContext,
    ): bool {
        assert!(cap.vessel_id == object::id(vessel), E_NOT_OWNER);
        assert!(is_alive(vessel, clock), E_VESSEL_EXPIRED);
        let now           = clock::timestamp_ms(clock);
        vessel.last_cast  = now;
        vessel.cast_count = vessel.cast_count + 1;
        event::emit(VesselActive {
            vessel_id:  object::id_to_address(&object::id(vessel)),
            cast_count: vessel.cast_count,
            expires_at: now + LIFESPAN_MS,
        });
        vessel.burn_after_cast
    }

    /// v11: Acknowledge that a Cast published by this Vessel earned Lighthouse status.
    /// Owner-gated via VesselCap. Called by lighthouse::raise() after it has already
    /// verified that cast::vessel_id(cast) == object::id(vessel).
    public fun record_lighthouse(
        vessel: &mut Vessel,
        cap:    &VesselCap,
        clock:  &Clock,
    ) {
        assert!(cap.vessel_id == object::id(vessel), E_NOT_OWNER);
        vessel.lighthouse_count = vessel.lighthouse_count + 1;
        event::emit(VesselLighthouseEarned {
            vessel_id:        object::id_to_address(&object::id(vessel)),
            lighthouse_count: vessel.lighthouse_count,
            earned_at:        clock::timestamp_ms(clock),
        });
    }

    public fun enter_dock(
        vessel:  &mut Vessel,
        cap:     &VesselCap,
        dock_id: address,
        clock:   &Clock,
        _ctx:    &TxContext,
    ) {
        assert!(cap.vessel_id == object::id(vessel), E_NOT_OWNER);
        assert!(is_alive(vessel, clock), E_VESSEL_EXPIRED);
        assert!(vessel.active_dock == @0x0, E_ALREADY_IN_DOCK);
        vessel.active_dock = dock_id;
        event::emit(VesselDockedIn {
            vessel_id: object::id_to_address(&object::id(vessel)),
            dock_id,
            docked_at: clock::timestamp_ms(clock),
        });
    }

    public fun leave_dock(
        vessel: &mut Vessel,
        cap:    &VesselCap,
        clock:  &Clock,
        _ctx:   &TxContext,
    ) {
        assert!(cap.vessel_id == object::id(vessel), E_NOT_OWNER);
        let dock_id        = vessel.active_dock;
        vessel.active_dock = @0x0;
        event::emit(VesselDockedOut {
            vessel_id:   object::id_to_address(&object::id(vessel)),
            dock_id,
            undocked_at: clock::timestamp_ms(clock),
        });
    }

    public fun sink(
        vessel: Vessel,
        cap:    VesselCap,
        reason: u8,
        clock:  &Clock,
        _ctx:   &TxContext,
    ) {
        assert!(cap.vessel_id == object::id(&vessel), E_NOT_OWNER);
        let now         = clock::timestamp_ms(clock);
        let vessel_addr = object::id_to_address(&object::id(&vessel));
        let casts       = vessel.cast_count;
        let Vessel { id, harbor_id:_, owner:_, tier:_, created_at:_,
                     last_cast:_, cast_count:_, active_dock:_,
                     burn_after_cast:_, lighthouse_count:_ } = vessel;
        let VesselCap { id: cap_id, vessel_id:_, harbor_id:_,
                        owner:_, tier:_ } = cap;
        object::delete(id);
        object::delete(cap_id);
        event::emit(VesselSunk {
            vessel_id:  vessel_addr,
            cast_count: casts,
            sunk_at:    now,
            reason,
        });
    }

    public fun is_alive(vessel: &Vessel, clock: &Clock): bool {
        clock::timestamp_ms(clock) < vessel.last_cast + LIFESPAN_MS
    }

    public fun assert_alive(vessel: &Vessel, clock: &Clock) {
        assert!(is_alive(vessel, clock), E_VESSEL_EXPIRED);
    }

    public fun in_dock(vessel: &Vessel): bool { vessel.active_dock != @0x0 }

    // ─── View helpers ─────────────────────────────────────────────────────────
    public fun tier(v: &Vessel):              u8      { v.tier }
    public fun owner(v: &Vessel):             address { v.owner }
    public fun harbor_id(v: &Vessel):         ID      { v.harbor_id }
    public fun cast_count(v: &Vessel):        u64     { v.cast_count }
    public fun last_cast(v: &Vessel):         u64     { v.last_cast }
    public fun created_at(v: &Vessel):        u64     { v.created_at }
    public fun expires_at(v: &Vessel):        u64     { v.last_cast + LIFESPAN_MS }
    public fun active_dock(v: &Vessel):       address { v.active_dock }
    public fun burn_after_cast(v: &Vessel):   bool    { v.burn_after_cast }
    public fun lighthouse_count(v: &Vessel):  u64     { v.lighthouse_count }  // v11
    public fun ghost():  u8 { GHOST }
    public fun shadow(): u8 { SHADOW }
    public fun open():   u8 { OPEN }
}
