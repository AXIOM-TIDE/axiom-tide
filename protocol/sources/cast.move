/// AXIOM TIDE PROTOCOL · v6.0.0
/// PRIMITIVE 3 OF 7 · CAST
/// The communication primitive. Everything is a cast.
/// Open · Sealed · Eyes Only · Ghost.
/// v5: Dock mechanics — single-claim by default, open-Dock upgrade at $0.01/slot.
/// v5: Author payment routing fixed (97% to author, not recipient).
/// v5: Tide & Lighthouse mechanics preserved on-chain, hidden in CONK UI.
/// Copyright © 2026 Axiom Tide LLC · axiomtide.com
module axiom_tide::cast {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::event;
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use 0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC;
    use axiom_tide::abyss::{Self, Abyss};

    const E_CAST_EXPIRED:             u64 = 1;
    const E_WRONG_RECIPIENT:          u64 = 2;
    const E_ALREADY_BURNED:           u64 = 3;
    const E_PRICE_TOO_LOW:            u64 = 4;
    const E_DOCK_FULL:                u64 = 5;
    const E_INVALID_MAX_CLAIMS:       u64 = 6;
    const E_INSUFFICIENT_UPGRADE_FEE: u64 = 7;
    const E_INSUFFICIENT_FLARE_FEE:   u64 = 8;  // v6: publish fee below Flare minimum

    const MIN_PAID_PRICE:    u64 = 100_000;

    const DOCK_SLOT_PRICE:        u64 = 10_000;
    const MIN_FLARE_PUBLISH_FEE:  u64 = 50_000;  // v6: $0.05 minimum to send a Flare (EYES_ONLY)
    const MIN_MAX_CLAIMS:    u64 = 1;
    const MAX_MAX_CLAIMS:    u64 = 10_000;

    const MODE_OPEN:      u8 = 0;
    const MODE_SEALED:    u8 = 1;
    const MODE_EYES_ONLY: u8 = 2;
    const MODE_GHOST:     u8 = 3;

    const STATE_LIVE:   u8 = 0;
    const STATE_BURNED: u8 = 1;

    const DUR_24H: u8 = 1;
    const DUR_48H: u8 = 2;
    const DUR_72H: u8 = 3;
    const DUR_7D:  u8 = 4;
    const MS_24H:  u64 = 24 * 60 * 60 * 1000;

    public struct Cast has key, store {
        id:                    UID,
        vessel_id:             ID,
        vessel_tier:           u8,
        hook:                  vector<u8>,
        content_blob:          vector<u8>,
        media_blob:            Option<vector<u8>>,
        mode:                  u8,
        recipient:             address,
        state:                 u8,
        created_at:            u64,
        expires_at:            u64,
        read_count:            u64,
        tide_1_count:          u64,
        tide_2_count:          u64,
        tide_3_count:          u64,
        current_tide:          u8,
        is_lighthouse:         bool,
        fee_paid:              u64,
        author:                address,
        max_claims:            u64,
        claims_used:           u64,
        dock_upgrade_fee_paid: u64,
        dock_description:      vector<u8>,
    }

    public struct CastSounded has copy, drop {
        cast_id:    address,
        hook:       vector<u8>,
        mode:       u8,
        duration:   u8,
        created_at: u64,
        expires_at: u64,
    }

    public struct CastRead has copy, drop {
        cast_id:    address,
        read_count: u64,
        read_at:    u64,
    }

    public struct CastBurned has copy, drop {
        cast_id:   address,
        mode:      u8,
        burned_at: u64,
    }

    public struct TideSurvived has copy, drop {
        cast_id:     address,
        tide:        u8,
        read_count:  u64,
        survived_at: u64,
    }

    public struct LighthouseBorn has copy, drop {
        cast_id:    address,
        read_count: u64,
        born_at:    u64,
    }

    public struct DockOpened has copy, drop {
        cast_id:          address,
        max_claims:       u64,
        upgrade_fee_paid: u64,
        opened_at:        u64,
    }

    public struct DockClaimed has copy, drop {
        cast_id:     address,
        claimant:    address,
        claims_used: u64,
        max_claims:  u64,
        claimed_at:  u64,
    }

    public fun sound(
        fee_coin:         Coin<USDC>,
        abyss:            &mut Abyss,
        vessel_id:        ID,
        vessel_tier:      u8,
        hook:             vector<u8>,
        content_blob:     vector<u8>,
        media_blob:       Option<vector<u8>>,
        mode:             u8,
        recipient:        address,
        duration:         u8,
        fee:              u64,
        max_claims:       u64,
        dock_description: vector<u8>,
        clock:            &Clock,
        ctx:              &mut TxContext,
    ) {
        assert!(max_claims >= MIN_MAX_CLAIMS && max_claims <= MAX_MAX_CLAIMS, E_INVALID_MAX_CLAIMS);

        let dock_upgrade_fee = (max_claims - 1) * DOCK_SLOT_PRICE;
        let paid_amount = coin::value(&fee_coin);
        assert!(paid_amount >= dock_upgrade_fee, E_INSUFFICIENT_UPGRADE_FEE);

        // v6: Flares require $0.05 minimum publish fee
        if (mode == MODE_EYES_ONLY) {
            assert!(paid_amount >= MIN_FLARE_PUBLISH_FEE + dock_upgrade_fee, E_INSUFFICIENT_FLARE_FEE);
        };

        let now     = clock::timestamp_ms(clock);
        let life_ms = if (duration == DUR_24H) MS_24H
                      else if (duration == DUR_48H) MS_24H * 2
                      else if (duration == DUR_72H) MS_24H * 3
                      else MS_24H * 7;

        abyss::receive_cast(abyss, fee_coin, clock, ctx);

        let author_addr = tx_context::sender(ctx);

        let cast = Cast {
            id:                    object::new(ctx),
            vessel_id,
            vessel_tier,
            hook,
            content_blob,
            media_blob,
            mode,
            recipient,
            state:                 STATE_LIVE,
            created_at:            now,
            expires_at:            now + life_ms,
            read_count:            0,
            tide_1_count:          0,
            tide_2_count:          0,
            tide_3_count:          0,
            current_tide:          1,
            is_lighthouse:         false,
            fee_paid:              fee,
            author:                author_addr,
            max_claims,
            claims_used:           0,
            dock_upgrade_fee_paid: dock_upgrade_fee,
            dock_description,
        };
        let cast_id = object::id_to_address(&object::id(&cast));

        event::emit(CastSounded {
            cast_id,
            hook: cast.hook,
            mode,
            duration,
            created_at: now,
            expires_at: now + life_ms,
        });

        if (max_claims > 1) {
            event::emit(DockOpened {
                cast_id,
                max_claims,
                upgrade_fee_paid: dock_upgrade_fee,
                opened_at: now,
            });
        };

        transfer::share_object(cast);
    }

    public fun read(
        cast:     &mut Cast,
        fee_coin: Coin<USDC>,
        abyss:    &mut Abyss,
        reader:   address,
        clock:    &Clock,
        ctx:      &mut TxContext,
    ) {
        let now = clock::timestamp_ms(clock);
        assert!(cast.state == STATE_LIVE, E_ALREADY_BURNED);
        assert!(cast.is_lighthouse || now < cast.expires_at, E_CAST_EXPIRED);

        if (cast.mode == MODE_EYES_ONLY) {
            assert!(cast.claims_used < cast.max_claims, E_DOCK_FULL);
            cast.claims_used = cast.claims_used + 1;
            event::emit(DockClaimed {
                cast_id:     object::id_to_address(&object::id(cast)),
                claimant:    reader,
                claims_used: cast.claims_used,
                max_claims:  cast.max_claims,
                claimed_at:  now,
            });
        } else if (cast.mode == MODE_SEALED) {
            assert!(reader == cast.recipient, E_WRONG_RECIPIENT);
        };

        let paid_amount = coin::value(&fee_coin);
        if (cast.fee_paid == 0) {
            abyss::receive_read(abyss, fee_coin, clock, ctx);
        } else {
            assert!(paid_amount >= MIN_PAID_PRICE, E_PRICE_TOO_LOW);
            let author_amount = (paid_amount * 97) / 100;
            let mut coin_mut = fee_coin;
            let author_payment = coin::split(&mut coin_mut, author_amount, ctx);
            transfer::public_transfer(author_payment, cast.author);
            abyss::receive_read(abyss, coin_mut, clock, ctx);
        };

        cast.read_count = cast.read_count + 1;
        event::emit(CastRead {
            cast_id:    object::id_to_address(&object::id(cast)),
            read_count: cast.read_count,
            read_at:    now,
        });

        if (cast.mode == MODE_GHOST || cast.mode == MODE_EYES_ONLY) {
            if (cast.mode == MODE_GHOST || cast.claims_used >= cast.max_claims) {
                cast.state        = STATE_BURNED;
                cast.content_blob = vector::empty();
                cast.media_blob   = option::none();
                event::emit(CastBurned {
                    cast_id:   object::id_to_address(&object::id(cast)),
                    mode:      cast.mode,
                    burned_at: now,
                });
            };
            return
        };

        if (cast.mode == MODE_OPEN) { check_tide(cast, clock); };
    }

    fun check_tide(cast: &mut Cast, clock: &Clock) {
        if (cast.is_lighthouse) return;
        let now    = clock::timestamp_ms(clock);
        let age_ms = now - cast.created_at;
        if (age_ms <= MS_24H && cast.read_count >= 1_000_000) {
            become_lighthouse(cast, now);
            return
        };
        if (cast.current_tide == 1) {
            if (cast.read_count >= 500_000 && age_ms <= MS_24H) {
                cast.tide_1_count = cast.read_count;
                cast.current_tide = 2;
                cast.expires_at   = cast.created_at + (MS_24H * 2);
                event::emit(TideSurvived {
                    cast_id:     object::id_to_address(&object::id(cast)),
                    tide:        1,
                    read_count:  cast.tide_1_count,
                    survived_at: now,
                });
            }
        } else if (cast.current_tide == 2) {
            let tide_2 = cast.read_count - cast.tide_1_count;
            if (tide_2 >= 500_000) {
                cast.tide_2_count = tide_2;
                cast.current_tide = 3;
                cast.expires_at   = cast.created_at + (MS_24H * 3);
                event::emit(TideSurvived {
                    cast_id:     object::id_to_address(&object::id(cast)),
                    tide:        2,
                    read_count:  cast.tide_2_count,
                    survived_at: now,
                });
            }
        } else if (cast.current_tide == 3) {
            let tide_3 = cast.read_count - cast.tide_1_count - cast.tide_2_count;
            if (tide_3 >= 500_000) {
                cast.tide_3_count = tide_3;
                become_lighthouse(cast, now);
            }
        }
    }

    fun become_lighthouse(cast: &mut Cast, now: u64) {
        cast.is_lighthouse = true;
        cast.expires_at    = now + (100 * 365 * 24 * 60 * 60 * 1000);
        event::emit(LighthouseBorn {
            cast_id:    object::id_to_address(&object::id(cast)),
            read_count: cast.read_count,
            born_at:    now,
        });
    }

    public fun hook(c: &Cast):          vector<u8> { c.hook }
    public fun mode(c: &Cast):          u8         { c.mode }
    public fun state(c: &Cast):         u8         { c.state }
    public fun read_count(c: &Cast):    u64        { c.read_count }
    public fun is_lighthouse(c: &Cast): bool       { c.is_lighthouse }
    public fun current_tide(c: &Cast):  u8         { c.current_tide }
    public fun expires_at(c: &Cast):    u64        { c.expires_at }
    public fun vessel_id(c: &Cast):     ID         { c.vessel_id }
    public fun mode_open():      u8 { MODE_OPEN }
    public fun mode_sealed():    u8 { MODE_SEALED }
    public fun mode_eyes_only(): u8 { MODE_EYES_ONLY }
    public fun mode_ghost():     u8 { MODE_GHOST }

    public fun author(c: &Cast):                address    { c.author }
    public fun max_claims(c: &Cast):            u64        { c.max_claims }
    public fun claims_used(c: &Cast):           u64        { c.claims_used }
    public fun claims_remaining(c: &Cast):      u64 {
        if (c.claims_used >= c.max_claims) 0
        else c.max_claims - c.claims_used
    }
    public fun is_dock_full(c: &Cast):          bool       { c.claims_used >= c.max_claims }
    public fun dock_description(c: &Cast):      vector<u8> { c.dock_description }
    public fun dock_upgrade_fee_paid(c: &Cast): u64        { c.dock_upgrade_fee_paid }
}