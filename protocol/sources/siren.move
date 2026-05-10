/// AXIOM TIDE PROTOCOL · v1.1.0
/// PRIMITIVE 6 OF 7 · SIREN
/// The open broadcast. Pulls vessels toward a Dock.
/// $0.03 to sound. 30 days from last response.
/// One Siren. One Dock. Always.
/// Copyright © 2026 Axiom Tide LLC · axiomtide.com
module axiom_tide::siren {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::event;
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use 0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC;
    use axiom_tide::abyss::{Self, Abyss};

    const E_SIREN_EXPIRED:      u64 = 1;
    const E_NOT_OWNER:          u64 = 2;
    const E_INSUFFICIENT_FEE:   u64 = 3;   // sound_v2: fee below protocol floor

    const LIFESPAN_MS:   u64 = 30 * 24 * 60 * 60 * 1000;
    const SIREN_FLOOR:   u64 = 30_000;     // $0.03 USDC — must match abyss::FEE_SIREN

    public struct Siren has key {
        id:              UID,
        owner_vessel_id: ID,
        owner:           address,
        dock_id:         ID,
        hook:            vector<u8>,
        created_at:      u64,
        last_response:   u64,
        response_count:  u64,
    }

    public struct SirenSounded has copy, drop {
        siren_id:   address,
        dock_id:    address,
        hook:       vector<u8>,
        sounded_at: u64,
        expires_at: u64,
    }

    public struct SirenAnswered has copy, drop {
        siren_id:    address,
        dock_id:     address,
        answered_at: u64,
        expires_at:  u64,
    }

    public struct SirenDark has copy, drop {
        siren_id: address,
        dark_at:  u64,
    }

    /// Original deployed signature — DO NOT MODIFY.
    /// Compatible upgrades require this to remain exactly as first published.
    public fun sound(
        owner_vessel_id: ID,
        dock_id:         ID,
        hook:            vector<u8>,
        clock:           &Clock,
        ctx:             &mut TxContext,
    ) {
        let owner = tx_context::sender(ctx);
        let now   = clock::timestamp_ms(clock);
        let siren = Siren {
            id:              object::new(ctx),
            owner_vessel_id,
            owner,
            dock_id,
            hook,
            created_at:      now,
            last_response:   now,
            response_count:  0,
        };
        let siren_addr = object::id_to_address(&object::id(&siren));
        let dock_addr  = object::id_to_address(&dock_id);
        event::emit(SirenSounded {
            siren_id:   siren_addr,
            dock_id:    dock_addr,
            hook:       siren.hook,
            sounded_at: now,
            expires_at: now + LIFESPAN_MS,
        });
        transfer::share_object(siren);
    }

    /// sound_v2 — fee-enforced replacement for sound().
    /// Identical behaviour except it asserts the fee coin meets the protocol
    /// floor at the siren layer before delegating to the abyss, matching the
    /// pattern established by cast::sound. Callers should migrate to this
    /// entry point; sound() remains for backwards compatibility only.
    ///
    /// Error codes:
    ///   E_INSUFFICIENT_FEE (3) — fee_coin value < SIREN_FLOOR ($0.03 USDC)
    public fun sound_v2(
        fee_coin:        Coin<USDC>,
        abyss:           &mut Abyss,
        owner_vessel_id: ID,
        dock_id:         ID,
        hook:            vector<u8>,
        clock:           &Clock,
        ctx:             &mut TxContext,
    ) {
        // Siren-layer fee gate — explicit check before touching the abyss.
        // The abyss validates independently; this makes the enforcement
        // visible at the call site and prevents partial-coin exploits where
        // a split produces a coin that satisfies abyss arithmetic edge cases.
        assert!(coin::value(&fee_coin) >= SIREN_FLOOR, E_INSUFFICIENT_FEE);

        abyss::receive_siren(abyss, fee_coin, clock, ctx);

        let owner = tx_context::sender(ctx);
        let now   = clock::timestamp_ms(clock);
        let siren = Siren {
            id:              object::new(ctx),
            owner_vessel_id,
            owner,
            dock_id,
            hook,
            created_at:      now,
            last_response:   now,
            response_count:  0,
        };
        let siren_addr = object::id_to_address(&object::id(&siren));
        let dock_addr  = object::id_to_address(&dock_id);
        event::emit(SirenSounded {
            siren_id:   siren_addr,
            dock_id:    dock_addr,
            hook:       siren.hook,
            sounded_at: now,
            expires_at: now + LIFESPAN_MS,
        });
        transfer::share_object(siren);
    }

    public fun answer(
        siren: &mut Siren,
        clock: &Clock,
        _ctx:  &TxContext,
    ): ID {
        assert!(is_alive(siren, clock), E_SIREN_EXPIRED);
        let now             = clock::timestamp_ms(clock);
        siren.response_count = siren.response_count + 1;
        siren.last_response  = now;
        event::emit(SirenAnswered {
            siren_id:    object::id_to_address(&object::id(siren)),
            dock_id:     object::id_to_address(&siren.dock_id),
            answered_at: now,
            expires_at:  now + LIFESPAN_MS,
        });
        siren.dock_id
    }

    public fun go_dark(
        siren:     Siren,
        vessel_id: ID,
        clock:     &Clock,
        _ctx:      &TxContext,
    ) {
        assert!(siren.owner_vessel_id == vessel_id, E_NOT_OWNER);
        let now        = clock::timestamp_ms(clock);
        let siren_addr = object::id_to_address(&object::id(&siren));
        let Siren { id, owner_vessel_id:_, owner:_, dock_id:_,
                    hook:_, created_at:_, last_response:_,
                    response_count:_ } = siren;
        object::delete(id);
        event::emit(SirenDark { siren_id: siren_addr, dark_at: now });
    }

    public fun is_alive(siren: &Siren, clock: &Clock): bool {
        clock::timestamp_ms(clock) < siren.last_response + LIFESPAN_MS
    }

    public fun dock_id(s: &Siren):        ID         { s.dock_id }
    public fun hook(s: &Siren):           vector<u8> { s.hook }
    public fun response_count(s: &Siren): u64        { s.response_count }
    public fun expires_at(s: &Siren):     u64        { s.last_response + LIFESPAN_MS }
}
