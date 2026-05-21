/// AXIOM TIDE PROTOCOL · v11.0.0
/// PRIMITIVE 9 OF 9 · STREAM
/// Time-gated paid access sessions for live content on Sui.
/// Creators open a Stream. Viewers join and receive a StreamSession.
/// Three payment models: Per-View · Per-Minute · Subscription.
/// Revenue split: 97% to creator / 3% to Abyss on every join.
/// End closes the stream and optionally links a VOD Chest.
/// v11: vessel_id added to Stream struct and StreamCreated event.
///      Enables cross-primitive reputation aggregation in the indexer.
/// Copyright © 2026 Axiom Tide LLC · axiomtide.com
module axiom_tide::stream {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::event;
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use std::option::{Self, Option};
    use 0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC;
    use axiom_tide::abyss::{Self, Abyss};

    const E_STREAM_CLOSED:        u64 = 1;
    const E_NOT_CREATOR:          u64 = 2;
    const E_PRICE_TOO_LOW:        u64 = 3;
    const E_INSUFFICIENT_FEE:     u64 = 4;
    const E_INVALID_PAYMENT_TYPE: u64 = 5;

    const PAYMENT_PER_VIEW:     u8 = 0;
    const PAYMENT_PER_MINUTE:   u8 = 1;
    const PAYMENT_SUBSCRIPTION: u8 = 2;

    const FEE_STREAM_CREATE: u64 = 50_000;
    const MIN_SESSION_PRICE: u64 = 10_000;
    const PROTOCOL_BPS:      u64 = 300;

    const STATE_LIVE:   u8 = 0;
    const STATE_CLOSED: u8 = 1;

    public struct Stream has key, store {
        id:                UID,
        creator:           address,
        /// v11: vessel_id for cross-primitive reputation attribution.
        /// Indexer keys Stream earnings to this Vessel.
        vessel_id:         ID,
        price_per_session: u64,
        duration_ms:       u64,
        payment_type:      u8,
        state:             u8,
        created_at:        u64,
        total_earned:      u64,
        session_count:     u64,
    }

    public struct StreamSession has key, store {
        id:         UID,
        stream_id:  ID,
        viewer:     address,
        paid:       u64,
        expires_at: u64,
        joined_at:  u64,
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    public struct StreamCreated has copy, drop {
        stream_id:         address,
        creator:           address,
        vessel_id:         address,   // v11: added for indexer attribution
        price_per_session: u64,
        duration_ms:       u64,
        payment_type:      u8,
        created_at:        u64,
    }

    public struct SessionJoined has copy, drop {
        stream_id:  address,
        session_id: address,
        viewer:     address,
        paid:       u64,
        expires_at: u64,
        joined_at:  u64,
    }

    public struct StreamEnded has copy, drop {
        stream_id:     address,
        creator:       address,
        vessel_id:     address,   // v11: for indexer completeness
        total_earned:  u64,
        session_count: u64,
        ended_at:      u64,
        vod_chest_id:  Option<ID>,
    }

    // ─── create() — v11: add vessel_id ────────────────────────────────────────

    public fun create(
        fee_coin:          Coin<USDC>,
        abyss:             &mut Abyss,
        vessel_id:         ID,          // v11: new — publisher's Vessel for attribution
        price_per_session: u64,
        duration_ms:       u64,
        payment_type:      u8,
        clock:             &Clock,
        ctx:               &mut TxContext,
    ) {
        assert!(payment_type <= PAYMENT_SUBSCRIPTION, E_INVALID_PAYMENT_TYPE);
        assert!(price_per_session >= MIN_SESSION_PRICE, E_PRICE_TOO_LOW);

        abyss::receive_stream_create(abyss, fee_coin, clock, ctx);

        let creator = tx_context::sender(ctx);
        let now     = clock::timestamp_ms(clock);

        let stream = Stream {
            id:                object::new(ctx),
            creator,
            vessel_id,
            price_per_session,
            duration_ms,
            payment_type,
            state:             STATE_LIVE,
            created_at:        now,
            total_earned:      0,
            session_count:     0,
        };

        event::emit(StreamCreated {
            stream_id:         object::id_to_address(&object::id(&stream)),
            creator,
            vessel_id:         object::id_to_address(&vessel_id),   // v11
            price_per_session,
            duration_ms,
            payment_type,
            created_at:        now,
        });

        transfer::share_object(stream);
    }

    public fun join(
        stream:   &mut Stream,
        fee_coin: Coin<USDC>,
        abyss:    &mut Abyss,
        clock:    &Clock,
        ctx:      &mut TxContext,
    ) {
        assert!(stream.state == STATE_LIVE, E_STREAM_CLOSED);

        let paid       = coin::value(&fee_coin);
        assert!(paid >= stream.price_per_session, E_INSUFFICIENT_FEE);

        let viewer     = tx_context::sender(ctx);
        let now        = clock::timestamp_ms(clock);
        let expires_at = now + stream.duration_ms;

        let protocol_cut  = (paid * PROTOCOL_BPS) / 10_000;
        let mut coin_mut  = fee_coin;
        let protocol_coin = coin::split(&mut coin_mut, protocol_cut, ctx);
        abyss::receive_stream_access(abyss, protocol_coin, clock, ctx);
        transfer::public_transfer(coin_mut, stream.creator);

        stream.total_earned  = stream.total_earned  + paid;
        stream.session_count = stream.session_count + 1;

        let session = StreamSession {
            id:        object::new(ctx),
            stream_id: object::id(stream),
            viewer,
            paid,
            expires_at,
            joined_at: now,
        };

        event::emit(SessionJoined {
            stream_id:  object::id_to_address(&object::id(stream)),
            session_id: object::id_to_address(&object::id(&session)),
            viewer,
            paid,
            expires_at,
            joined_at:  now,
        });

        transfer::transfer(session, viewer);
    }

    public fun verify(session: &StreamSession, clock: &Clock): bool {
        clock::timestamp_ms(clock) < session.expires_at
    }

    public fun end(
        stream:       &mut Stream,
        vod_chest_id: Option<ID>,
        clock:        &Clock,
        ctx:          &mut TxContext,
    ) {
        assert!(stream.state == STATE_LIVE, E_STREAM_CLOSED);
        assert!(tx_context::sender(ctx) == stream.creator, E_NOT_CREATOR);

        stream.state = STATE_CLOSED;

        event::emit(StreamEnded {
            stream_id:     object::id_to_address(&object::id(stream)),
            creator:       stream.creator,
            vessel_id:     object::id_to_address(&stream.vessel_id),   // v11
            total_earned:  stream.total_earned,
            session_count: stream.session_count,
            ended_at:      clock::timestamp_ms(clock),
            vod_chest_id,
        });
    }

    // ─── View helpers ─────────────────────────────────────────────────────────
    public fun creator(s: &Stream):           address { s.creator }
    public fun vessel_id(s: &Stream):         ID      { s.vessel_id }   // v11
    public fun price_per_session(s: &Stream): u64     { s.price_per_session }
    public fun duration_ms(s: &Stream):       u64     { s.duration_ms }
    public fun payment_type(s: &Stream):      u8      { s.payment_type }
    public fun state(s: &Stream):             u8      { s.state }
    public fun total_earned(s: &Stream):      u64     { s.total_earned }
    public fun session_count(s: &Stream):     u64     { s.session_count }
    public fun is_live(s: &Stream):           bool    { s.state == STATE_LIVE }

    public fun session_stream_id(ss: &StreamSession): ID      { ss.stream_id }
    public fun session_viewer(ss: &StreamSession):    address { ss.viewer }
    public fun session_paid(ss: &StreamSession):      u64     { ss.paid }
    public fun session_expires_at(ss: &StreamSession): u64    { ss.expires_at }

    public fun payment_per_view():     u8  { PAYMENT_PER_VIEW }
    public fun payment_per_minute():   u8  { PAYMENT_PER_MINUTE }
    public fun payment_subscription(): u8  { PAYMENT_SUBSCRIPTION }
    public fun fee_stream_create():    u64 { FEE_STREAM_CREATE }
    public fun min_session_price():    u64 { MIN_SESSION_PRICE }
}
