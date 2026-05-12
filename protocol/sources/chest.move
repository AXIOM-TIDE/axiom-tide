/// AXIOM TIDE PROTOCOL · v1.0.0
/// PRIMITIVE 8 OF 8 · CHEST
/// Walrus-backed encrypted file vault for Vessels.
/// SEAL encrypted. Walrus stored. CONK settled.
/// Three size tiers: Nano · Standard · Large.
/// Access: 97% author / 3% protocol.
/// Burn destroys the on-chain gate. Blob stays. Unreadable.
/// Copyright © 2026 Axiom Tide LLC · axiomtide.com
module axiom_tide::chest {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::event;
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use 0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC;
    use axiom_tide::abyss::{Self, Abyss};

    // ─── Error codes ──────────────────────────────────────────────────────────
    const E_CHEST_BURNED:       u64 = 1;
    const E_NOT_OWNER:          u64 = 2;
    const E_PRICE_TOO_LOW:      u64 = 3;
    const E_INVALID_TIER:       u64 = 4;
    const E_SIZE_EXCEEDS_TIER:  u64 = 5;
    const E_CHEST_EXPIRED:      u64 = 6;
    const E_INSUFFICIENT_FEE:   u64 = 7;

    // ─── Size tiers ───────────────────────────────────────────────────────────
    const TIER_NANO:     u8 = 0;   // ≤ 100 KB  — JSON, reports, structured data
    const TIER_STANDARD: u8 = 1;   // ≤ 1 MB    — docs, images, datasets
    const TIER_LARGE:    u8 = 2;   // ≤ 10 MB   — rich files, bundles

    const NANO_MAX_BYTES:     u64 = 102_400;     // 100 KB
    const STANDARD_MAX_BYTES: u64 = 1_048_576;   // 1 MB
    const LARGE_MAX_BYTES:    u64 = 10_485_760;  // 10 MB

    // ─── Protocol fees (USDC 6-decimal microunits: 1_000_000 = $1.00) ─────────
    const FEE_OPEN_NANO:     u64 = 50_000;   // $0.05
    const FEE_OPEN_STANDARD: u64 = 100_000;  // $0.10
    const FEE_OPEN_LARGE:    u64 = 250_000;  // $0.25
    const FEE_BURN:          u64 = 20_000;   // $0.02
    const FEE_EXTEND:        u64 = 20_000;   // $0.02 base (Walrus extension handled off-chain)

    const MIN_ACCESS_FEE: u64 = 10_000;      // $0.01 floor for paid chests
    const PROTOCOL_BPS:   u64 = 300;         // 3 % of access fee (30/1000)

    // ─── Storage duration ─────────────────────────────────────────────────────
    const EPOCH_MS:      u64 = 7 * 24 * 60 * 60 * 1000;  // 1 Walrus epoch ≈ 7 days
    const DEFAULT_EPOCHS: u64 = 5;                         // ~35 days default

    // ─── State ────────────────────────────────────────────────────────────────
    const STATE_LIVE:   u8 = 0;
    const STATE_BURNED: u8 = 1;

    // ─── Structs ──────────────────────────────────────────────────────────────

    public struct Chest has key, store {
        id:           UID,
        vessel_id:    ID,
        owner:        address,
        /// Walrus blobId — addresses the encrypted blob on the Walrus network
        blob_id:      vector<u8>,
        /// SEAL policy ID — controls who can receive the decryption key
        seal_id:      vector<u8>,
        size_tier:    u8,
        size_bytes:   u64,
        /// USDC microunits a reader must pay; 0 = free access
        access_fee:   u64,
        state:        u8,
        created_at:   u64,
        expires_at:   u64,
        access_count: u64,
        author:       address,
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    public struct ChestOpened has copy, drop {
        chest_id:   address,
        vessel_id:  address,
        size_tier:  u8,
        size_bytes: u64,
        access_fee: u64,
        expires_at: u64,
        opened_at:  u64,
    }

    public struct ChestAccessed has copy, drop {
        chest_id:     address,
        reader:       address,
        blob_id:      vector<u8>,
        seal_id:      vector<u8>,
        fee_paid:     u64,
        access_count: u64,
        accessed_at:  u64,
    }

    public struct ChestBurned has copy, drop {
        chest_id:  address,
        owner:     address,
        burned_at: u64,
    }

    public struct ChestExtended has copy, drop {
        chest_id:    address,
        new_expiry:  u64,
        extended_at: u64,
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    fun open_fee(tier: u8): u64 {
        if      (tier == TIER_NANO)     { FEE_OPEN_NANO     }
        else if (tier == TIER_STANDARD) { FEE_OPEN_STANDARD }
        else if (tier == TIER_LARGE)    { FEE_OPEN_LARGE    }
        else                            { abort E_INVALID_TIER }
    }

    fun max_bytes(tier: u8): u64 {
        if      (tier == TIER_NANO)     { NANO_MAX_BYTES     }
        else if (tier == TIER_STANDARD) { STANDARD_MAX_BYTES }
        else if (tier == TIER_LARGE)    { LARGE_MAX_BYTES    }
        else                            { abort E_INVALID_TIER }
    }

    fun is_alive(chest: &Chest, clock: &Clock): bool {
        chest.state == STATE_LIVE &&
        clock::timestamp_ms(clock) < chest.expires_at
    }

    // ─── Public entry points ──────────────────────────────────────────────────

    /// Open a new Chest.
    ///
    /// Caller uploads the file to Walrus (off-chain), encrypts with SEAL (off-chain),
    /// then commits the resulting blob_id + seal_id on-chain here.
    /// Protocol collects open fee based on size tier.
    ///
    /// blob_id:    Walrus blobId of the SEAL-encrypted file
    /// seal_id:    SEAL policy ID that gates decryption key delivery
    /// size_tier:  TIER_NANO (0), TIER_STANDARD (1), or TIER_LARGE (2)
    /// size_bytes: actual file size — must fit within declared tier
    /// access_fee: USDC microunits per access; 0 = free
    /// epochs:     storage duration in Walrus epochs (0 = default 5 epochs ≈ 35 days)
    public fun open(
        fee_coin:   Coin<USDC>,
        abyss:      &mut Abyss,
        vessel_id:  ID,
        blob_id:    vector<u8>,
        seal_id:    vector<u8>,
        size_tier:  u8,
        size_bytes: u64,
        access_fee: u64,
        epochs:     u64,
        clock:      &Clock,
        ctx:        &mut TxContext,
    ) {
        assert!(size_tier <= TIER_LARGE, E_INVALID_TIER);
        assert!(size_bytes <= max_bytes(size_tier), E_SIZE_EXCEEDS_TIER);
        assert!(access_fee == 0 || access_fee >= MIN_ACCESS_FEE, E_PRICE_TOO_LOW);

        abyss::receive_chest_open(abyss, fee_coin, size_tier, clock, ctx);

        let owner  = tx_context::sender(ctx);
        let now    = clock::timestamp_ms(clock);
        let epochs = if (epochs == 0) { DEFAULT_EPOCHS } else { epochs };

        let chest = Chest {
            id:           object::new(ctx),
            vessel_id,
            owner,
            blob_id,
            seal_id,
            size_tier,
            size_bytes,
            access_fee,
            state:        STATE_LIVE,
            created_at:   now,
            expires_at:   now + epochs * EPOCH_MS,
            access_count: 0,
            author:       owner,
        };

        event::emit(ChestOpened {
            chest_id:   object::id_to_address(&object::id(&chest)),
            vessel_id:  object::id_to_address(&vessel_id),
            size_tier,
            size_bytes,
            access_fee,
            expires_at: chest.expires_at,
            opened_at:  now,
        });

        transfer::share_object(chest);
    }

    /// Access a Chest.
    ///
    /// Reader pays access_fee. Author receives 97%, protocol 3%.
    /// blob_id and seal_id are emitted in ChestAccessed — reader uses
    /// these to fetch the Walrus blob and request the SEAL decryption key.
    public fun access(
        chest:    &mut Chest,
        fee_coin: Coin<USDC>,
        abyss:    &mut Abyss,
        clock:    &Clock,
        ctx:      &mut TxContext,
    ) {
        assert!(is_alive(chest, clock), E_CHEST_BURNED);

        let reader = tx_context::sender(ctx);
        let paid   = coin::value(&fee_coin);
        let now    = clock::timestamp_ms(clock);

        if (chest.access_fee == 0) {
            // Free chest — return the coin (caller passes zero-value coin)
            transfer::public_transfer(fee_coin, reader);
        } else {
            assert!(paid >= chest.access_fee, E_INSUFFICIENT_FEE);
            // Split: 3% to protocol Abyss, 97% to author
            let protocol_cut  = (paid * PROTOCOL_BPS) / 10_000;
            let mut coin_mut  = fee_coin;
            let protocol_coin = coin::split(&mut coin_mut, protocol_cut, ctx);
            abyss::receive_chest_access(abyss, protocol_coin, clock, ctx);
            transfer::public_transfer(coin_mut, chest.author);
        };

        chest.access_count = chest.access_count + 1;

        event::emit(ChestAccessed {
            chest_id:     object::id_to_address(&object::id(chest)),
            reader,
            blob_id:      chest.blob_id,
            seal_id:      chest.seal_id,
            fee_paid:     paid,
            access_count: chest.access_count,
            accessed_at:  now,
        });
    }

    /// Burn a Chest.
    ///
    /// Zeroes blob_id and seal_id on-chain, marks state BURNED.
    /// The Walrus blob persists on the network but is permanently
    /// undecryptable — the SEAL key reference no longer exists.
    /// Anyone who already accessed and decrypted retains their copy.
    public fun burn(
        chest:    &mut Chest,
        fee_coin: Coin<USDC>,
        abyss:    &mut Abyss,
        clock:    &Clock,
        ctx:      &mut TxContext,
    ) {
        assert!(chest.state == STATE_LIVE, E_CHEST_BURNED);
        assert!(tx_context::sender(ctx) == chest.owner, E_NOT_OWNER);

        abyss::receive_chest_burn(abyss, fee_coin, clock, ctx);

        // Gate destruction: clear on-chain references
        chest.blob_id = vector[];
        chest.seal_id = vector[];
        chest.state   = STATE_BURNED;

        event::emit(ChestBurned {
            chest_id:  object::id_to_address(&object::id(chest)),
            owner:     chest.owner,
            burned_at: clock::timestamp_ms(clock),
        });
    }

    /// Extend Chest storage duration.
    ///
    /// Caller pays FEE_EXTEND to the protocol.
    /// Walrus storage extension must be done off-chain (via publisher API)
    /// before calling this, otherwise on-chain expiry outlives Walrus blob.
    public fun extend(
        chest:    &mut Chest,
        fee_coin: Coin<USDC>,
        abyss:    &mut Abyss,
        epochs:   u64,
        clock:    &Clock,
        ctx:      &mut TxContext,
    ) {
        assert!(is_alive(chest, clock), E_CHEST_EXPIRED);
        assert!(tx_context::sender(ctx) == chest.owner, E_NOT_OWNER);

        abyss::receive_chest_extend(abyss, fee_coin, clock, ctx);

        chest.expires_at = chest.expires_at + epochs * EPOCH_MS;

        event::emit(ChestExtended {
            chest_id:    object::id_to_address(&object::id(chest)),
            new_expiry:  chest.expires_at,
            extended_at: clock::timestamp_ms(clock),
        });
    }

    // ─── View helpers ─────────────────────────────────────────────────────────
    public fun blob_id(c: &Chest):     vector<u8> { c.blob_id }
    public fun seal_id(c: &Chest):     vector<u8> { c.seal_id }
    public fun access_fee(c: &Chest):  u64        { c.access_fee }
    public fun access_count(c: &Chest): u64       { c.access_count }
    public fun size_tier(c: &Chest):   u8         { c.size_tier }
    public fun size_bytes(c: &Chest):  u64        { c.size_bytes }
    public fun is_live(c: &Chest, clock: &Clock): bool { is_alive(c, clock) }
    public fun fee_open_nano():     u64 { FEE_OPEN_NANO     }
    public fun fee_open_standard(): u64 { FEE_OPEN_STANDARD }
    public fun fee_open_large():    u64 { FEE_OPEN_LARGE    }
    public fun fee_burn():          u64 { FEE_BURN          }
    public fun fee_extend():        u64 { FEE_EXTEND        }
    public fun min_access_fee():    u64 { MIN_ACCESS_FEE    }
}
