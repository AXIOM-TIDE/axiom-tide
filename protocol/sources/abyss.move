/// AXIOM TIDE PROTOCOL · v1.0.0
/// THE ABYSS · Protocol Treasury
/// All fees flow here. Nothing returns. Ever.
/// Copyright © 2026 Axiom Tide LLC · axiomtide.com
module axiom_tide::abyss {
    use sui::object::{Self, UID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::event;
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin};
    use 0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC;

    const E_INSUFFICIENT: u64 = 1;

    const FEE_HARBOR:   u64 = 50_000;
    const FEE_VESSEL:   u64 = 10_000;
    const FEE_CAST:     u64 = 1_000;
    const FEE_READ:     u64 = 1_000;
    const FEE_SIREN:    u64 = 30_000;
    const FEE_RETURN_FLARE: u64 = 50_000;
    const FEE_DOCK:     u64 = 500_000;
    const FEE_LH_VISIT: u64 = 1_000;
    const FEE_LH_KILL:  u64 = 1_000_000_000_000;

    public struct Abyss has key {
        id:             UID,
        total_received: u64,
        total_actions:  u64,
    }

    public struct FeeReceived has copy, drop {
        action:         vector<u8>,
        amount:         u64,
        total_received: u64,
        received_at:    u64,
    }

    fun init(ctx: &mut TxContext) {
        transfer::share_object(Abyss {
            id:             object::new(ctx),
            total_received: 0,
            total_actions:  0,
        });
    }

    fun deposit(
        abyss:   &mut Abyss,
        payment: Coin<USDC>,
        minimum: u64,
        action:  vector<u8>,
        clock:   &Clock,
        _ctx:    &TxContext,
    ) {
        let amount = coin::value(&payment);
        assert!(amount >= minimum, E_INSUFFICIENT);
        transfer::public_transfer(payment, @0xe0117fba317d2267b8d90adca1fe79eceeec756bcf54edf04cc29ee5306ab32e);
        abyss.total_received = abyss.total_received + amount;
        abyss.total_actions  = abyss.total_actions  + 1;
        event::emit(FeeReceived {
            action,
            amount,
            total_received: abyss.total_received,
            received_at:    clock::timestamp_ms(clock),
        });
    }

    public fun receive_harbor(a: &mut Abyss, p: Coin<USDC>, c: &Clock, ctx: &TxContext) {
        deposit(a, p, FEE_HARBOR,   b"harbor:open",      c, ctx);
    }
    public fun receive_vessel(a: &mut Abyss, p: Coin<USDC>, c: &Clock, ctx: &TxContext) {
        deposit(a, p, FEE_VESSEL,   b"vessel:launch",    c, ctx);
    }
    public fun receive_cast(a: &mut Abyss, p: Coin<USDC>, c: &Clock, ctx: &TxContext) {
        deposit(a, p, FEE_CAST,     b"cast:sound",       c, ctx);
    }
    public fun receive_read(a: &mut Abyss, p: Coin<USDC>, c: &Clock, ctx: &TxContext) {
        deposit(a, p, FEE_READ,     b"cast:read",        c, ctx);
    }
    public fun receive_siren(a: &mut Abyss, p: Coin<USDC>, c: &Clock, ctx: &TxContext) {
        deposit(a, p, FEE_SIREN,    b"siren:sound",      c, ctx);
    }
    public fun receive_return_flare(a: &mut Abyss, p: Coin<USDC>, c: &Clock, ctx: &TxContext) {
        deposit(a, p, FEE_RETURN_FLARE, b"return_flare:send", c, ctx);
    }
    public fun receive_dock(a: &mut Abyss, p: Coin<USDC>, c: &Clock, ctx: &TxContext) {
        deposit(a, p, FEE_DOCK,     b"dock:open",        c, ctx);
    }
    public fun receive_lh_visit(a: &mut Abyss, p: Coin<USDC>, c: &Clock, ctx: &TxContext) {
        deposit(a, p, FEE_LH_VISIT, b"lighthouse:visit", c, ctx);
    }
    public fun receive_lh_kill(a: &mut Abyss, p: Coin<USDC>, c: &Clock, ctx: &TxContext) {
        deposit(a, p, FEE_LH_KILL,  b"lighthouse:kill",  c, ctx);
    }

    public fun total_received(a: &Abyss): u64 { a.total_received }
    public fun total_actions(a: &Abyss):  u64 { a.total_actions }
    public fun fee_harbor():   u64 { FEE_HARBOR }
    public fun fee_vessel():   u64 { FEE_VESSEL }
    public fun fee_cast():     u64 { FEE_CAST }
    public fun fee_read():     u64 { FEE_READ }
    public fun fee_siren():    u64 { FEE_SIREN }
    public fun fee_return_flare(): u64 { FEE_RETURN_FLARE }
    public fun fee_dock():     u64 { FEE_DOCK }
    public fun fee_lh_visit(): u64 { FEE_LH_VISIT }
    public fun fee_lh_kill():  u64 { FEE_LH_KILL }
}
