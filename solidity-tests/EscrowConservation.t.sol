// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TelomereRunEscrow} from "../contracts/TelomereRunEscrow.sol";
import {MockToken} from "../contracts/MockToken.sol";

interface VmCash {
    function addr(uint256 key) external returns (address);
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function sign(uint256 key, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function mockCall(address target, bytes calldata data, bytes calldata result) external;
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
    function toString(uint256 value) external pure returns (string memory);
    function toString(bytes32 value) external pure returns (string memory);
    function writeLine(string calldata path, string calldata line) external;
}

/// Independent cash-flow model; no expected balance is initialized from escrow storage.
/// Expected escrow reverts are caught here. An unexpected outcome reverts the
/// handler and fails the campaign (fail_on_revert=true); no vm.assume/discards.
contract CashHandler {
    VmCash constant vm = VmCash(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant SIGNER_KEY = 0xA11CE; // Disposable local fixture only.
    MockToken public immutable token;
    TelomereRunEscrow public immutable escrow;
    address[2] public owners = [address(0x1111), address(0x2222)];
    address public constant treasury = address(0x3333);
    uint256[2] public walletCash = [uint256(1_000_000), uint256(1_000_000)];
    uint256[2] public free;
    uint256 public earned;
    uint256 public protocolCalls;
    uint256 public expectedEscrowReverts;
    uint256 public scheduledHandlerCalls;
    bytes32 public scheduledTrace;
    bool private ready;
    bool public finished;
    modifier scheduled() {
        if (ready && !finished) {
            scheduledHandlerCalls++;
            scheduledTrace = keccak256(abi.encode(scheduledTrace, msg.data, block.timestamp));
        }
        _;
    }
    uint256 private serial;
    struct Leash { bytes32 id; uint256 owner; uint96 hour; uint96 day; uint64 expiry; uint64 killedAt; }
    struct Run { TelomereRunEscrow.Quote q; uint256 leash; uint64 opened; uint64 expiry; uint64 stop;
        uint8 state; uint64 settledAt; uint256 charge; bytes32 receipt; uint64 billableSeconds; uint96 inferenceCharge; }
    Leash[] private leashes;
    Run[] private runs;
    mapping(bytes32 => bool) private usedReceipt;
    error OutcomeMismatch(bytes4 selector, bool expected, bool actual);

    constructor() {
        token = new MockToken(); escrow = new TelomereRunEscrow(address(token), vm.addr(SIGNER_KEY), vm.addr(SIGNER_KEY), treasury);
        for (uint256 i; i < 2; i++) {
            token.faucet(owners[i], 1_000_000); vm.prank(owners[i]); token.approve(address(escrow), type(uint256).max);
            _deposit(i, 10_000); _create(i);
        }
        // Guarantee valid payment, release and a rejected protocol call before fuzzing.
        open(0, 1, 1); settle(0, 1, 1); open(1, 1, 2); advance(21_631); refund(1); deposit(0, 0);
        ready = true;
    }
    function _id() private returns (bytes32) { return keccak256(abi.encode("cash-campaign", ++serial)); }
    function _signature(bytes32 hash, bool wrong) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrong ? 0xB0B : SIGNER_KEY, hash); return abi.encodePacked(r, s, v);
    }
    function _invoke(address caller, bytes memory data, bool expected) private {
        vm.prank(caller); (bool ok,) = address(escrow).call(data); protocolCalls++;
        if (ok != expected) revert OutcomeMismatch(bytes4(data), expected, ok);
        if (!ok) expectedEscrowReverts++;
    }
    function _ceiling(Run storage r) private view returns (uint256) { return uint256(r.q.maxSeconds) * r.q.pricePerSecond + r.q.inferencePrice; }
    function _pending(uint256 li) private view returns (uint256 value) {
        for (uint256 i; i < runs.length; i++) if (runs[i].leash == li && runs[i].state == 1) value += _ceiling(runs[i]);
    }
    function _spent(uint256 li, uint256 period) private view returns (uint256 value) {
        for (uint256 i; i < runs.length; i++) if (runs[i].leash == li && runs[i].state == 2
            && uint256(runs[i].settledAt) / period == block.timestamp / period) value += runs[i].charge;
    }
    function _deposit(uint256 owner, uint96 amount) private {
        bool ok = amount != 0 && walletCash[owner] >= amount;
        _invoke(owners[owner], abi.encodeCall(escrow.deposit, (amount)), ok);
        if (ok) { walletCash[owner] -= amount; free[owner] += amount; }
    }
    function deposit(uint256 ownerSeed, uint256 amountSeed) public scheduled { _deposit(ownerSeed % 2, uint96(amountSeed % 2500)); }
    function withdraw(uint256 ownerSeed, uint256 amountSeed) public scheduled {
        uint256 owner = ownerSeed % 2; uint96 amount = uint96(amountSeed % 20_000); bool ok = amount != 0 && free[owner] >= amount;
        _invoke(owners[owner], abi.encodeCall(escrow.withdraw, (amount)), ok);
        if (ok) { free[owner] -= amount; walletCash[owner] += amount; }
    }
    function _create(uint256 owner) private {
        bytes32 id = _id(); uint64 expiry = uint64(block.timestamp + 200_000);
        _invoke(owners[owner], abi.encodeCall(escrow.createLeash, (id, owners[owner], uint96(900), uint96(2000), expiry)), true);
        leashes.push(Leash(id, owner, 900, 2000, expiry, 0));
    }
    function create(uint256 ownerSeed) public scheduled { _create(ownerSeed % 2); }
    function open(uint256 leashSeed, uint256 timeSeed, uint256 priceSeed) public scheduled {
        uint256 li = leashSeed % leashes.length; Leash storage l = leashes[li];
        bool wrong = priceSeed % 7 == 0; bool foreign = timeSeed % 5 == 0;
        TelomereRunEscrow.Quote memory q = TelomereRunEscrow.Quote(_id(), l.id, owners[l.owner], _id(),
            uint64(1 + timeSeed % 125), uint96(1 + priceSeed % 7), uint96(priceSeed % 3 == 0 ? 0 : 7),
            uint64(priceSeed % 9 == 0 ? block.timestamp - 1 : block.timestamp + 100));
        uint256 amount = uint256(q.maxSeconds) * q.pricePerSecond + q.inferencePrice;
        bool ok = !wrong && !foreign && l.killedAt == 0 && block.timestamp < l.expiry && q.maxSeconds <= 120
            && block.timestamp <= q.quoteExpiry && free[l.owner] >= amount
            && _spent(li, 3600) + _pending(li) + amount <= l.hour && _spent(li, 86400) + _pending(li) + amount <= l.day;
        bytes memory signature = _signature(escrow.quoteDigest(q), wrong);
        _invoke(foreign ? owners[1 - l.owner] : owners[l.owner], abi.encodeCall(escrow.openRun, (q, signature)), ok);
        if (ok) { free[l.owner] -= amount; runs.push(Run(q, li, uint64(block.timestamp), l.expiry, 0, 1, 0, 0, bytes32(0), 0, 0)); }
    }
    struct SettlementModel { uint256 cutoff; uint256 permitted; uint64 secondsBilled; uint96 inference; uint256 charge; bytes32 receipt; bool wrong; bool ok; }
    function settle(uint256 runSeed, uint256 chargeSeed, uint256 modeSeed) public scheduled {
        Run storage r = runs[runSeed % runs.length]; Leash storage l = leashes[r.leash]; SettlementModel memory m;
        m.cutoff = block.timestamp;
        if (r.stop != 0 && r.stop < m.cutoff) m.cutoff = r.stop;
        if (l.killedAt != 0 && l.killedAt < m.cutoff) m.cutoff = l.killedAt;
        if (r.expiry < m.cutoff) m.cutoff = r.expiry;
        m.permitted = (m.cutoff > r.opened ? m.cutoff - r.opened : 0) + 1;
        if (m.permitted > r.q.maxSeconds) m.permitted = r.q.maxSeconds;
        m.secondsBilled = uint64(modeSeed % 4 == 0 ? m.permitted + 1 : modeSeed % (m.permitted + 1));
        m.inference = chargeSeed % 4 == 0 ? r.q.inferencePrice + 1 : chargeSeed % 2 == 0 ? 0 : r.q.inferencePrice;
        m.receipt = modeSeed % 17 == 0 ? bytes32(0) : modeSeed % 5 == 0 && runs[0].receipt != bytes32(0) ? runs[0].receipt : _id();
        m.wrong = chargeSeed % 7 == 0; m.charge = uint256(m.secondsBilled) * r.q.pricePerSecond + m.inference;
        m.ok = r.state == 1 && block.timestamp < uint256(r.opened) + r.q.maxSeconds + 21600
            && m.receipt != bytes32(0) && !usedReceipt[m.receipt] && !m.wrong && m.secondsBilled <= m.permitted
            && (m.inference == 0 || m.inference == r.q.inferencePrice) && m.charge <= _ceiling(r);
        TelomereRunEscrow.Settlement memory s = TelomereRunEscrow.Settlement(r.q.runId, m.secondsBilled, m.inference, m.receipt);
        _invoke(owners[1 - l.owner], abi.encodeCall(escrow.settleRun, (s, _signature(escrow.settlementDigest(s), m.wrong))), m.ok);
        if (m.ok) { r.state = 2; r.settledAt = uint64(block.timestamp); r.charge = m.charge; r.receipt = m.receipt;
            r.billableSeconds = m.secondsBilled; r.inferenceCharge = m.inference;
            usedReceipt[m.receipt] = true; earned += m.charge; free[l.owner] += _ceiling(r) - m.charge; }
    }
    function refund(uint256 seed) public scheduled {
        Run storage r = runs[seed % runs.length]; bool ok = r.state == 1 && block.timestamp >= uint256(r.opened) + r.q.maxSeconds + 21600;
        _invoke(owners[1 - leashes[r.leash].owner], abi.encodeCall(escrow.refundRun, (r.q.runId)), ok);
        if (ok) { r.state = 3; free[leashes[r.leash].owner] += _ceiling(r); }
    }
    function stop(uint256 seed, bool foreign) public scheduled {
        Run storage r = runs[seed % runs.length]; uint256 owner = leashes[r.leash].owner; bool ok = r.state == 1 && !foreign;
        _invoke(owners[foreign ? 1 - owner : owner], abi.encodeCall(escrow.requestStop, (r.q.runId)), ok);
        if (ok && r.stop == 0) r.stop = uint64(block.timestamp);
    }
    function kill(uint256 seed, bool foreign) public scheduled {
        Leash storage l = leashes[seed % leashes.length]; bool ok = l.killedAt == 0 && !foreign;
        _invoke(owners[foreign ? 1 - l.owner : l.owner], abi.encodeCall(escrow.killLeash, (l.id)), ok);
        if (ok) l.killedAt = uint64(block.timestamp);
    }
    function update(uint256 seed, uint256 hourSeed, uint256 daySeed, bool foreign) public scheduled {
        uint256 li = seed % leashes.length; Leash storage l = leashes[li]; uint96 hour = uint96(1 + hourSeed % 2000); uint96 day = uint96(1 + daySeed % 4000);
        uint64 expiry = uint64(block.timestamp + 1 + hourSeed % 100_000);
        bool ok = !foreign && l.killedAt == 0 && _spent(li, 3600) + _pending(li) <= hour && _spent(li, 86400) + _pending(li) <= day;
        _invoke(owners[foreign ? 1 - l.owner : l.owner], abi.encodeCall(escrow.updateLeash, (l.id, owners[l.owner], hour, day, expiry)), ok);
        if (ok) { l.hour = hour; l.day = day; l.expiry = expiry; }
    }
    function advance(uint256 seed) public scheduled { vm.warp(block.timestamp + seed % 100_000); }
    function replay(uint256 seed) public scheduled {
        Run storage r = runs[seed % runs.length]; bytes memory sig = _signature(escrow.quoteDigest(r.q), false);
        _invoke(r.q.payer, abi.encodeCall(escrow.openRun, (r.q, sig)), false);
    }
    function check() public view {
        uint256 pending;
        for (uint256 i; i < leashes.length; i++) {
            Leash storage l = leashes[i]; TelomereRunEscrow.Leash memory actual = escrow.getLeash(l.id); uint256 reserved = _pending(i); pending += reserved;
            require(actual.pending == reserved && actual.spentHour == _spent(i, 3600) && actual.spentDay == _spent(i, 86400), "reservation or spending history");
            require(actual.owner == owners[l.owner] && actual.maxPerHour == l.hour && actual.maxPerDay == l.day
                && actual.expiry == l.expiry && actual.killedAt == l.killedAt && actual.killed == (l.killedAt != 0), "leash authority");
        }
        for (uint256 i; i < runs.length; i++) {
            Run storage r = runs[i]; TelomereRunEscrow.Run memory actual = escrow.getRun(r.q.runId);
            require(uint8(actual.status) == r.state && actual.payer == r.q.payer && actual.ceiling == _ceiling(r)
                && actual.acceptedExpiry == r.expiry && actual.stopAt == r.stop && actual.receiptHash == r.receipt
                && actual.billableSeconds == r.billableSeconds && actual.inferenceCharge == r.inferenceCharge, "immutable run history");
            if (r.state == 2) require(escrow.usedReceiptHash(r.receipt), "settlement receipt replay index");
        }
        for (uint256 i; i < 2; i++) {
            require(token.balanceOf(owners[i]) == walletCash[i], "wallet cash");
            require(escrow.availableBalance(owners[i]) == free[i], "available cash");
        }
        require(token.balanceOf(treasury) == earned, "treasury cash");
        require(token.balanceOf(address(escrow)) == free[0] + free[1] + pending, "escrow cash conservation");
        require(walletCash[0] + walletCash[1] + earned + free[0] + free[1] + pending == 2_000_000, "total cash conservation");
    }
    function finish() public {
        // Forge may invoke the final hook again after the last sequence. Recheck
        // that exit, but never count its withdrawals or telemetry twice.
        if (finished) { check(); return; }
        finished = true;
        vm.warp(block.timestamp + 300_000);
        for (uint256 i; i < runs.length; i++) if (runs[i].state == 1) refund(i);
        for (uint256 i; i < 2; i++) if (free[i] != 0) {
            uint96 amount = uint96(free[i]); _invoke(owners[i], abi.encodeCall(escrow.withdraw, (amount)), true);
            free[i] = 0; walletCash[i] += amount;
        }
        check(); require(token.balanceOf(address(escrow)) == 0, "all positions can exit");
        require(protocolCalls != 0 && expectedEscrowReverts != 0, "non-vacuous protocol campaign");
    }
    function firstLeash() external view returns (bytes32) { return leashes[0].id; }
}

contract EscrowConservationInvariantTest {
    VmCash constant vm = VmCash(address(uint160(uint256(keccak256("hevm cheat code")))));
    CashHandler public handler;
    struct FuzzSelector { address addr; bytes4[] selectors; }
    function setUp() public { vm.warp(1_700_000_000); handler = new CashHandler(); handler.check(); }
    function targetContracts() external view returns (address[] memory a) { a = new address[](1); a[0] = address(handler); }
    function targetSelectors() external view returns (FuzzSelector[] memory a) {
        a = new FuzzSelector[](1); bytes4[] memory s = new bytes4[](11);
        s[0] = handler.deposit.selector; s[1] = handler.withdraw.selector; s[2] = handler.create.selector;
        s[3] = handler.open.selector; s[4] = handler.settle.selector; s[5] = handler.refund.selector;
        s[6] = handler.stop.selector; s[7] = handler.kill.selector; s[8] = handler.update.selector;
        s[9] = handler.advance.selector; s[10] = handler.replay.selector; a[0] = FuzzSelector(address(handler), s);
    }
    function invariant_cashAndReservationHistory() public view { handler.check(); }
    function afterInvariant() public {
        if (handler.finished()) { handler.check(); return; }
        handler.finish();
        string memory path = vm.envOr("TELOMERE_INVARIANT_METRICS_PATH", string(""));
        if (bytes(path).length != 0) vm.writeLine(path, string.concat(
            '{"scheduledHandlerCalls":', vm.toString(handler.scheduledHandlerCalls()),
            ',"scheduledTrace":"', vm.toString(handler.scheduledTrace()), '"',
            ',"protocolCallsIncludingSetupAndExit":', vm.toString(handler.protocolCalls()),
            ',"expectedEscrowReverts":', vm.toString(handler.expectedEscrowReverts()),
            ',"oracleVerifiedAfterExit":true}'));
    }
    function testOracleRejectsForgedWalletCash() public {
        MockToken t = handler.token(); address owner = handler.owners(0); uint256 cash = t.balanceOf(owner);
        vm.mockCall(address(t), abi.encodeCall(t.balanceOf, (owner)), abi.encode(cash + 1));
        vm.expectRevert(); handler.check();
    }
    function testOracleRejectsForgedPendingReservation() public {
        TelomereRunEscrow e = handler.escrow(); bytes32 id = handler.firstLeash(); TelomereRunEscrow.Leash memory l = e.getLeash(id); l.pending++;
        vm.mockCall(address(e), abi.encodeCall(e.getLeash, (id)), abi.encode(l));
        vm.expectRevert(); handler.check();
    }
    function testFuzzExactUint96ReservationAndSettlement(uint96 budgetSeed, uint64 durationSeed) public {
        uint96 budget = budgetSeed == 0 ? 1 : budgetSeed; uint64 secondsMax = 1 + durationSeed % 120;
        uint256 signerKey = 0xA11CE; address payer = address(0xBEEF); address recipient = address(0xCAFE);
        MockToken t = new MockToken(); TelomereRunEscrow e = new TelomereRunEscrow(address(t), vm.addr(signerKey), vm.addr(signerKey), recipient);
        t.faucet(payer, budget); vm.prank(payer); t.approve(address(e), type(uint256).max);
        vm.prank(payer); e.deposit(budget); bytes32 leashId = keccak256("uint96-boundary");
        vm.prank(payer); e.createLeash(leashId, payer, budget, budget, uint64(block.timestamp + 10_000));
        TelomereRunEscrow.Quote memory q = TelomereRunEscrow.Quote(keccak256("first"), leashId, payer, keccak256("workload"),
            secondsMax, uint96(budget / secondsMax), uint96(budget % secondsMax), uint64(block.timestamp + 600));
        _openBoundary(e, q, signerKey, payer);
        require(e.availableBalance(payer) == 0 && e.getLeash(leashId).pending == budget, "exact uint96 reservation");
        TelomereRunEscrow.Quote memory second = TelomereRunEscrow.Quote(keccak256("second"), leashId, payer, keccak256("workload"),
            1, 1, 0, uint64(block.timestamp + 600));
        bytes memory secondSig = _boundarySignature(signerKey, e.quoteDigest(second));
        vm.prank(payer); vm.expectRevert(TelomereRunEscrow.BudgetExceeded.selector); e.openRun(second, secondSig);
        vm.warp(block.timestamp + secondsMax);
        TelomereRunEscrow.Settlement memory settlement = TelomereRunEscrow.Settlement(q.runId, secondsMax, q.inferencePrice, keccak256("receipt"));
        e.settleRun(settlement, _boundarySignature(signerKey, e.settlementDigest(settlement)));
        require(t.balanceOf(recipient) == budget && t.balanceOf(address(e)) == 0 && e.availableBalance(payer) == 0, "exact uint96 cash flow");
        TelomereRunEscrow.Leash memory l = e.getLeash(leashId);
        require(l.pending == 0 && l.spentHour == budget && l.spentDay == budget, "uint96 spend accounting");
    }
    function _boundarySignature(uint256 key, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest); return abi.encodePacked(r, s, v);
    }
    function _openBoundary(TelomereRunEscrow e, TelomereRunEscrow.Quote memory q, uint256 key, address payer) private {
        bytes memory signature = _boundarySignature(key, e.quoteDigest(q)); vm.prank(payer); e.openRun(q, signature);
    }
    function testExactMaxAndOneAtomicUnitBoundaries() public {
        testFuzzExactUint96ReservationAndSettlement(type(uint96).max, 119);
        testFuzzExactUint96ReservationAndSettlement(1, 119);
    }
}
