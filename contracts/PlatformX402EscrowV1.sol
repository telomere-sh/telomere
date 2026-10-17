// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {HostRegistry} from "./HostRegistry.sol";
import {ReceiptRoot} from "./ReceiptRoot.sol";
import {FeeRouter} from "./FeeRouter.sol";

/// @notice Separate platform version. The closed pilot escrow and its balances
/// are unchanged. Quotes, selectors and receipt leaves are intentionally distinct.
interface IReservationReceiveToken {
    function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function receiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,
        bytes32 nonce,uint8 v,bytes32 r,bytes32 s) external;
}
interface IReservationPermitProxy {
    struct TokenPermissions { address token; uint256 amount; }
    struct PermitTransferFrom { TokenPermissions permitted; uint256 nonce; uint256 deadline; }
    struct Witness { address to; address facilitator; uint256 validAfter; }
    function PERMIT2() external view returns (address);
    function WITNESS_TYPE_STRING() external view returns (string memory);
    function settle(PermitTransferFrom calldata permit,uint256 amount,address owner,Witness calldata witness,bytes calldata signature) external;
}

/// @notice Separate domain4 CPU reservation deployment. Funding and admission are
/// atomic; unused reservation funds belong only to the original approving EOA.
contract PlatformX402EscrowV1 is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable permit2;
    bytes32 public immutable permit2CodeHash;
    IReservationPermitProxy public immutable x402UptoProxy;
    bytes32 public immutable x402UptoProxyCodeHash;
    bytes32 public constant X402_RESERVATION_DOMAIN = keccak256("TelomereX402CpuReservationV1");
    bytes32 public constant RECEIVE_AUTHORIZATION_TYPEHASH = keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 public constant X402_WITNESS_TYPE_HASH = keccak256("Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,address facilitator,uint256 validAfter)");
    struct Reservation { bytes32 requestHash; bytes32 salt; bytes32 leashTermsHash; }
    struct ReceiveAuthorization { address from; address to; uint256 value; uint256 validAfter; uint256 validBefore; bytes32 nonce; }
    event X402RunFunded(bytes32 indexed runId,bytes32 indexed authorizationNonce,address indexed payer,
        uint96 amount,uint8 scheme,bytes32 requestHash,bytes32 leashTermsHash);
    uint64 public constant MAX_RUN_SECONDS = 120;
    // Pre-audit hard limits for a six-decimal settlement token.
    uint96 public constant MAX_RUN_CEILING = 250_000_000;
    uint96 public constant MAX_LEASH_DAY = 1_000_000_000;
    uint256 public constant MAX_TOTAL_ESCROW = 500_000_000_000;
    uint64 public constant REFUND_GRACE_SECONDS = 6 hours;
    uint256 public constant MAX_BATCH = 32;
    uint256 public constant REFUND_HOOK_GAS = 100_000;
    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "PlatformQuote(bytes32 runId,bytes32 leashId,bytes32 hostId,address payer,uint16 hwClass,bytes32 regionHash,bytes32 imageHash,bytes32 workloadHash,uint64 maxSeconds,uint96 pricePerSecond,uint96 inferencePrice,uint64 quoteExpiry)"
    );
    struct Config { address token; address quoteSigner; address receiptRoot; address hostRegistry; address feeRouter; address guardian; }
    struct Quote {
        bytes32 runId; bytes32 leashId; bytes32 hostId; address payer; uint16 hwClass;
        bytes32 regionHash; bytes32 imageHash; bytes32 workloadHash;
        uint64 maxSeconds; uint96 pricePerSecond; uint96 inferencePrice; uint64 quoteExpiry;
    }
    struct LeashTerms {
        address agent; uint96 maxPerHour; uint96 maxPerDay; uint64 classMask; bool sealedOnly;
        bytes32 imageAllowRoot; bytes32 regionAllowRoot; uint64 expiry;
    }
    struct Leash {
        address owner; address agent; uint96 maxPerHour; uint96 maxPerDay; uint64 classMask; bool sealedOnly;
        bytes32 imageAllowRoot; bytes32 regionAllowRoot; uint64 expiry; bool killed; uint64 killedAt;
        uint64 hourKey; uint64 dayKey; uint96 spentHour; uint96 spentDay; uint96 pending;
    }
    enum RunStatus { None, Open, Settled, Refunded }
    struct Run {
        address payer; address hostOperator; bytes32 leashId; bytes32 hostId; uint16 hwClass;
        bytes32 regionHash; bytes32 imageHash; bytes32 workloadHash; bool sealedHost;
        uint64 openedAt; uint64 acceptedExpiry; uint64 maxSeconds; uint64 stopAt;
        uint96 pricePerSecond; uint96 inferencePrice; uint96 ceiling;
        RunStatus status; uint64 billableSeconds; uint96 inferenceCharge; bytes32 receiptHash; bool hostReleased;
    }
    struct Settlement { bytes32 runId; uint64 billableSeconds; uint64 endedAt; uint96 inferenceCharge; bytes32 receiptHash; }
    struct SettlementInput { Settlement settlement; uint64 hour; bytes32[] proof; }

    IERC20 public immutable token;
    address public immutable quoteSigner;
    ReceiptRoot public immutable receiptRoot;
    HostRegistry public immutable hostRegistry;
    FeeRouter public immutable feeRouter;
    address public immutable guardian;
    bool public opensPaused;
    uint256 public totalAvailable;
    uint256 public totalReserved;
    mapping(address => uint256) public availableBalance;
    mapping(bytes32 => Leash) private leashes;
    mapping(bytes32 => Run) private runs;
    mapping(bytes32 => bool) public usedReceiptHash;

    error InvalidConfiguration();
    error Unauthorized();
    error InvalidAmount();
    error InvalidLeash();
    error LeashInactive();
    error BudgetExceeded();
    error InvalidQuote();
    error InvalidSignature();
    error InvalidHost();
    error InsufficientBalance();
    error InvalidRun();
    error InvalidSettlement();
    error InvalidReceipt();
    error RefundNotReady();
    error UnsupportedToken();
    event Deposited(address indexed payer, uint96 amount);
    event Withdrawn(address indexed payer, uint96 amount);
    event LeashCreated(bytes32 indexed leashId, address indexed owner, address indexed agent);
    event LeashUpdated(bytes32 indexed leashId, address indexed agent);
    event LeashKilled(bytes32 indexed leashId, uint64 killedAt);
    event OpensPauseChanged(bool paused);
    event RunOpened(bytes32 indexed runId, bytes32 indexed leashId, bytes32 indexed hostId, address payer,
        uint96 ceiling, uint64 openedAt, uint64 maxSeconds);
    event StopRequested(bytes32 indexed runId, uint64 stopAt);
    event RunSettled(bytes32 indexed runId, bytes32 indexed receiptHash, bytes32 receiptLeaf,
        uint96 hostAmount, uint96 platformFee, uint96 returnedAmount);
    event RunRefunded(bytes32 indexed runId, address indexed payer, uint96 amount);
    event HostClosureDeferred(bytes32 indexed runId, bytes32 indexed hostId);
    event HostClosureRetried(bytes32 indexed runId, bytes32 indexed hostId);

    constructor(Config memory config,address permit2_,bytes32 permit2Hash_,address proxy_,bytes32 proxyHash_)
        EIP712("TelomerePlatformEscrow", "4") {
        if (permit2_ == address(0) || permit2_.code.length == 0 || permit2_.codehash != permit2Hash_
            || proxy_ == address(0) || proxy_.code.length == 0 || proxy_.codehash != proxyHash_
            || IReservationPermitProxy(proxy_).PERMIT2() != permit2_
            || keccak256(bytes(IReservationPermitProxy(proxy_).WITNESS_TYPE_STRING())) != X402_WITNESS_TYPE_HASH
            || IReservationReceiveToken(config.token).RECEIVE_WITH_AUTHORIZATION_TYPEHASH() != RECEIVE_AUTHORIZATION_TYPEHASH) revert InvalidConfiguration();
        permit2 = permit2_; permit2CodeHash = permit2Hash_;
        x402UptoProxy = IReservationPermitProxy(proxy_); x402UptoProxyCodeHash = proxyHash_;
        if (config.token == address(0) || config.token.code.length == 0 || IERC20Metadata(config.token).decimals() != 6
            || config.quoteSigner == address(0) || config.guardian == address(0)
            || config.receiptRoot == address(0) || config.receiptRoot.code.length == 0
            || config.hostRegistry == address(0) || config.hostRegistry.code.length == 0
            || config.feeRouter == address(0) || config.feeRouter.code.length == 0) revert InvalidConfiguration();
        HostRegistry registry = HostRegistry(config.hostRegistry); FeeRouter router = FeeRouter(config.feeRouter);
        if (address(registry.token()) != config.token || registry.controller() != address(this)
            || address(registry.evidenceRoot()) != config.receiptRoot || address(router.token()) != config.token
            || router.controller() != address(this)) revert InvalidConfiguration();
        token = IERC20(config.token); quoteSigner = config.quoteSigner; receiptRoot = ReceiptRoot(config.receiptRoot);
        hostRegistry = registry; feeRouter = router; guardian = config.guardian;
        token.forceApprove(config.feeRouter, type(uint256).max);
    }

    function deposit(uint96 amount) external nonReentrant {
        if (amount == 0 || amount > MAX_TOTAL_ESCROW
            || totalAvailable + totalReserved > MAX_TOTAL_ESCROW - amount) revert InvalidAmount();
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedToken();
        availableBalance[msg.sender] += amount; totalAvailable += amount;
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint96 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (availableBalance[msg.sender] < amount) revert InsufficientBalance();
        availableBalance[msg.sender] -= amount; totalAvailable -= amount;
        uint256 beforeSelf = token.balanceOf(address(this)); uint256 beforeRecipient = token.balanceOf(msg.sender);
        token.safeTransfer(msg.sender, amount);
        if (beforeSelf - token.balanceOf(address(this)) != amount || token.balanceOf(msg.sender) - beforeRecipient != amount) {
            revert UnsupportedToken();
        }
        emit Withdrawn(msg.sender, amount);
    }

    function setOpensPaused(bool paused) external {
        if (msg.sender != guardian) revert Unauthorized();
        opensPaused = paused; emit OpensPauseChanged(paused);
    }

    function createLeash(bytes32 leashId, LeashTerms calldata terms) external {
        if (leashId == bytes32(0) || leashes[leashId].owner != address(0)) revert InvalidLeash();
        _validateTerms(terms);
        Leash storage leash = leashes[leashId]; leash.owner = msg.sender;
        _setTerms(leash, terms); leash.hourKey = uint64(block.timestamp / 1 hours); leash.dayKey = uint64(block.timestamp / 1 days);
        emit LeashCreated(leashId, msg.sender, terms.agent);
    }

    function updateLeash(bytes32 leashId, LeashTerms calldata terms) external {
        Leash storage leash = leashes[leashId];
        if (leash.owner == address(0)) revert InvalidLeash();
        if (leash.owner != msg.sender) revert Unauthorized();
        if (leash.killed) revert LeashInactive();
        _validateTerms(terms); _roll(leash);
        if (uint256(leash.spentHour) + leash.pending > terms.maxPerHour
            || uint256(leash.spentDay) + leash.pending > terms.maxPerDay) revert BudgetExceeded();
        // Accepted, still-funded work cannot lose its scope permission retroactively.
        if (leash.pending != 0 && (leash.classMask != terms.classMask || leash.sealedOnly != terms.sealedOnly
            || leash.imageAllowRoot != terms.imageAllowRoot || leash.regionAllowRoot != terms.regionAllowRoot)) revert BudgetExceeded();
        _setTerms(leash, terms); emit LeashUpdated(leashId, terms.agent);
    }

    function killLeash(bytes32 leashId) external {
        Leash storage leash = leashes[leashId];
        if (leash.owner == address(0)) revert InvalidLeash();
        if (leash.owner != msg.sender) revert Unauthorized();
        if (leash.killed) revert LeashInactive();
        leash.killed = true; leash.killedAt = uint64(block.timestamp); emit LeashKilled(leashId, leash.killedAt);
    }

    function openRun(Quote calldata quote, bytes calldata signature, bytes32[] calldata imageProof, bytes32[] calldata regionProof)
        external nonReentrant
    { _openRun(quote, signature, imageProof, regionProof, false); }

    function openRunFromX402Exact(Quote calldata quote,bytes calldata signature,bytes32[] calldata imageProof,
        bytes32[] calldata regionProof,Reservation calldata reservation,ReceiveAuthorization calldata authorization,
        bytes calldata paymentSignature) external nonReentrant {
        _fundExact(quote,reservation,authorization,paymentSignature);
        _openRun(quote,signature,imageProof,regionProof,true);
    }
    function _fundExact(Quote calldata quote,Reservation calldata reservation,ReceiveAuthorization calldata authorization,
        bytes calldata paymentSignature) private {
        uint96 ceiling = _x402Ceiling(quote,reservation);
        if (authorization.from != quote.payer || authorization.to != address(this) || authorization.value != ceiling
            || authorization.validBefore > quote.quoteExpiry || authorization.nonce != x402AuthorizationNonce(quote,reservation,0)
            || paymentSignature.length != 65) revert InvalidQuote();
        uint256 beforeBalance = token.balanceOf(address(this));
        bytes32 r; bytes32 s; uint8 v;
        assembly ("memory-safe") { r := calldataload(paymentSignature.offset) s := calldataload(add(paymentSignature.offset,32)) v := byte(0,calldataload(add(paymentSignature.offset,64))) }
        IReservationReceiveToken(address(token)).receiveWithAuthorization(authorization.from,authorization.to,authorization.value,
            authorization.validAfter,authorization.validBefore,authorization.nonce,v,r,s);
        _creditX402(quote,reservation,authorization.nonce,ceiling,0,beforeBalance);
    }

    function openRunFromX402Upto(Quote calldata quote,bytes calldata signature,bytes32[] calldata imageProof,
        bytes32[] calldata regionProof,Reservation calldata reservation,IReservationPermitProxy.PermitTransferFrom calldata authorization,
        uint256 validAfter,bytes calldata paymentSignature) external nonReentrant {
        _fundUpto(quote,reservation,authorization,validAfter,paymentSignature);
        _openRun(quote,signature,imageProof,regionProof,true);
    }
    function _fundUpto(Quote calldata quote,Reservation calldata reservation,IReservationPermitProxy.PermitTransferFrom calldata authorization,
        uint256 validAfter,bytes calldata paymentSignature) private {
        uint96 ceiling = _x402Ceiling(quote,reservation);
        if (authorization.permitted.token != address(token) || authorization.permitted.amount < ceiling
            || authorization.permitted.amount > MAX_RUN_CEILING || authorization.deadline > quote.quoteExpiry
            || authorization.nonce != uint256(x402AuthorizationNonce(quote,reservation,1))
            || permit2.codehash != permit2CodeHash || address(x402UptoProxy).codehash != x402UptoProxyCodeHash) revert InvalidQuote();
        uint256 beforeBalance = token.balanceOf(address(this));
        x402UptoProxy.settle(authorization,ceiling,quote.payer,IReservationPermitProxy.Witness(address(this),address(this),validAfter),paymentSignature);
        _creditX402(quote,reservation,bytes32(authorization.nonce),ceiling,1,beforeBalance);
    }

    function x402LeashTermsHash(bytes32 leashId) public view returns (bytes32) {
        Leash storage leash = leashes[leashId];
        return keccak256(abi.encode(leash.agent,leash.maxPerHour,leash.maxPerDay,leash.classMask,
            leash.sealedOnly,leash.imageAllowRoot,leash.regionAllowRoot,leash.expiry));
    }
    function x402AuthorizationNonce(Quote calldata quote,Reservation calldata reservation,uint8 scheme) public view returns(bytes32) {
        return keccak256(abi.encode(X402_RESERVATION_DOMAIN,block.chainid,address(this),quoteDigest(quote),
            reservation.leashTermsHash,reservation.requestHash,reservation.salt,scheme));
    }
    function _x402Ceiling(Quote calldata quote,Reservation calldata reservation) private view returns(uint96 ceiling) {
        if (quote.payer == address(0) || quote.payer.code.length != 0 || quote.payer != leashes[quote.leashId].owner
            || quote.hwClass != 0 || quote.inferencePrice != 0 || reservation.requestHash == bytes32(0) || reservation.salt == bytes32(0)
            || reservation.leashTermsHash != x402LeashTermsHash(quote.leashId)) revert Unauthorized();
        HostRegistry.Host memory host = hostRegistry.getHost(quote.hostId);
        if (host.kind == 2) revert InvalidHost();
        ceiling = quoteCeiling(quote,false);
        if (totalAvailable + totalReserved > MAX_TOTAL_ESCROW - ceiling) revert InvalidAmount();
    }
    function _creditX402(Quote calldata quote,Reservation calldata reservation,bytes32 nonce,uint96 ceiling,uint8 scheme,uint256 beforeBalance) private {
        if (token.balanceOf(address(this)) - beforeBalance != ceiling) revert UnsupportedToken();
        availableBalance[quote.payer] += ceiling; totalAvailable += ceiling;
        emit X402RunFunded(quote.runId,nonce,quote.payer,ceiling,scheme,reservation.requestHash,reservation.leashTermsHash);
    }
    function _openRun(Quote calldata quote,bytes calldata signature,bytes32[] calldata imageProof,bytes32[] calldata regionProof,bool funded) private {
        if (opensPaused) revert LeashInactive();
        Leash storage leash = leashes[quote.leashId];
        if (leash.owner == address(0)) revert InvalidLeash();
        if ((!funded && msg.sender != leash.owner && msg.sender != leash.agent) || quote.payer != leash.owner) revert Unauthorized();
        if (leash.killed || block.timestamp >= leash.expiry) revert LeashInactive();
        if (quote.runId == bytes32(0) || runs[quote.runId].status != RunStatus.None || quote.hostId == bytes32(0)
            || quote.imageHash == bytes32(0) || quote.regionHash == bytes32(0) || quote.workloadHash == bytes32(0)
            || quote.maxSeconds == 0 || quote.maxSeconds > MAX_RUN_SECONDS || block.timestamp > quote.quoteExpiry
            || quote.hwClass >= 64 || imageProof.length > 64 || regionProof.length > 64) revert InvalidQuote();
        if (ECDSA.recover(quoteDigest(quote), signature) != quoteSigner) revert InvalidSignature();
        HostRegistry.Host memory host = hostRegistry.getHost(quote.hostId);
        if (host.operator == address(0) || !host.active || host.unbondAt != 0) revert InvalidHost();
        bool sealedHost = host.kind == 2;
        if ((leash.classMask & (uint64(1) << quote.hwClass)) == 0 || (leash.sealedOnly && !sealedHost)
            || (quote.hwClass != 0 && !host.gpu)
            || (leash.imageAllowRoot != bytes32(0) && !MerkleProof.verifyCalldata(imageProof, leash.imageAllowRoot, allowLeaf(quote.imageHash)))
            || (leash.regionAllowRoot != bytes32(0) && !MerkleProof.verifyCalldata(regionProof, leash.regionAllowRoot, allowLeaf(quote.regionHash)))) {
            revert LeashInactive();
        }
        _admit(quote, host.operator, sealedHost);
    }

    function requestStop(bytes32 runId) external {
        Run storage run = runs[runId];
        if (run.status != RunStatus.Open) revert InvalidRun();
        if (msg.sender != run.payer) revert Unauthorized();
        if (run.stopAt == 0) { run.stopAt = uint64(block.timestamp); emit StopRequested(runId, run.stopAt); }
    }

    function settleRun(Settlement calldata settlement, uint64 hour, bytes32[] calldata proof) external nonReentrant {
        _settle(settlement, hour, proof);
    }

    /// @notice Atomic bounded batch. One invalid item reverts the complete batch.
    function settleBatch(SettlementInput[] calldata batch) external nonReentrant {
        if (batch.length == 0 || batch.length > MAX_BATCH) revert InvalidSettlement();
        for (uint256 i; i < batch.length; ++i) _settle(batch[i].settlement, batch[i].hour, batch[i].proof);
    }

    function refundRun(bytes32 runId) external nonReentrant {
        Run storage run = runs[runId];
        if (run.status != RunStatus.Open) revert InvalidRun();
        if (block.timestamp < refundAt(runId)) revert RefundNotReady();
        run.status = RunStatus.Refunded; leashes[run.leashId].pending -= run.ceiling;
        totalReserved -= run.ceiling; availableBalance[run.payer] += run.ceiling; totalAvailable += run.ceiling;
        // A broken host accounting hook must never hold the owner's money. Bound
        // gas and do not copy untrusted return/revert data (including return bombs).
        bytes memory callData = abi.encodeCall(HostRegistry.closeRun, (runId));
        address target = address(hostRegistry); uint256 hookGas = REFUND_HOOK_GAS; bool closed;
        assembly ("memory-safe") { closed := call(hookGas, target, 0, add(callData, 32), mload(callData), 0, 0) }
        run.hostReleased = closed;
        if (!closed) emit HostClosureDeferred(runId, run.hostId);
        emit RunRefunded(runId, run.payer, run.ceiling);
    }

    function retryHostClosure(bytes32 runId) external nonReentrant {
        Run storage run = runs[runId];
        if ((run.status != RunStatus.Refunded && run.status != RunStatus.Settled) || run.hostReleased) revert InvalidRun();
        hostRegistry.closeRun(runId); run.hostReleased = true;
        emit HostClosureRetried(runId, run.hostId);
    }

    /// @notice A committed, amount/incident/registry-bound proof is the authority;
    /// callers and the guardian cannot invent a penalty or choose its recipient.
    function penalizeHost(bytes32 hostId, bytes32 incidentId, uint96 amount, uint64 hour, bytes32[] calldata proof)
        external nonReentrant
    {
        hostRegistry.penalize(hostId, incidentId, amount, hour, proof);
    }

    function getLeash(bytes32 leashId) external view returns (Leash memory leash) {
        leash = leashes[leashId];
        if (leash.hourKey != block.timestamp / 1 hours) { leash.spentHour = 0; leash.hourKey = uint64(block.timestamp / 1 hours); }
        if (leash.dayKey != block.timestamp / 1 days) { leash.spentDay = 0; leash.dayKey = uint64(block.timestamp / 1 days); }
    }
    function getRun(bytes32 runId) external view returns (Run memory) { return runs[runId]; }
    function refundAt(bytes32 runId) public view returns (uint256) {
        Run storage run = runs[runId]; if (run.status == RunStatus.None) revert InvalidRun();
        return uint256(run.openedAt) + run.maxSeconds + REFUND_GRACE_SECONDS;
    }
    function quoteDigest(Quote calldata quote) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(QUOTE_TYPEHASH, quote)));
    }
    function quoteCeiling(Quote calldata quote, bool sealedHost) public view returns (uint96) {
        uint256 base = uint256(quote.maxSeconds) * quote.pricePerSecond + quote.inferencePrice;
        if (base == 0 || base > type(uint96).max) revert InvalidQuote();
        uint256 total = base + feeRouter.quoteFee(uint96(base), sealedHost);
        if (total > MAX_RUN_CEILING) revert InvalidQuote();
        return uint96(total);
    }
    function allowLeaf(bytes32 value) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(value))));
    }

    /// @notice Distinct platform leaf: binds every billable/scoped field, preventing
    /// a receipt-hash-only proof being reused with attacker-selected billed seconds.
    function receiptLeaf(Settlement calldata settlement) public view returns (bytes32) {
        Run storage run = runs[settlement.runId];
        return keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(this), settlement.runId,
            run.hostId, run.payer, run.hwClass, run.regionHash, run.imageHash, run.workloadHash,
            settlement.billableSeconds, settlement.endedAt, settlement.inferenceCharge, settlement.receiptHash))));
    }

    function _settle(Settlement calldata settlement, uint64 hour, bytes32[] calldata proof) private {
        Run storage run = runs[settlement.runId];
        if (run.status != RunStatus.Open) revert InvalidRun();
        if (block.timestamp >= refundAt(settlement.runId) || settlement.receiptHash == bytes32(0)
            || usedReceiptHash[settlement.receiptHash] || settlement.billableSeconds > run.maxSeconds
            || (settlement.inferenceCharge != 0 && settlement.inferenceCharge != run.inferencePrice) || proof.length > 64) {
            revert InvalidSettlement();
        }
        Leash storage leash = leashes[run.leashId];
        uint256 cutoff = block.timestamp;
        if (run.stopAt != 0 && run.stopAt < cutoff) cutoff = run.stopAt;
        if (leash.killed && leash.killedAt < cutoff) cutoff = leash.killedAt;
        if (run.acceptedExpiry < cutoff) cutoff = run.acceptedExpiry;
        if (settlement.endedAt < run.openedAt || settlement.endedAt > cutoff || hour != settlement.endedAt / 1 hours) {
            revert InvalidSettlement();
        }
        uint256 elapsed = settlement.endedAt - run.openedAt;
        if (settlement.billableSeconds > elapsed + 1) revert InvalidSettlement();
        bytes32 leaf = receiptLeaf(settlement);
        if (!receiptRoot.verify(leaf, proof, hour)) revert InvalidReceipt();
        uint256 base = uint256(settlement.billableSeconds) * run.pricePerSecond + settlement.inferenceCharge;
        if (base > type(uint96).max) revert InvalidSettlement();
        uint256 fee = feeRouter.quoteFee(uint96(base), run.sealedHost); uint256 total = base + fee;
        if (total > run.ceiling) revert InvalidSettlement();
        // Effects and both hooks are atomic. Hook failures stop settlement, while
        // the independent timeout refund path always releases the full ceiling.
        run.status = RunStatus.Settled; run.billableSeconds = settlement.billableSeconds;
        run.inferenceCharge = settlement.inferenceCharge; run.receiptHash = settlement.receiptHash;
        usedReceiptHash[settlement.receiptHash] = true;
        _roll(leash); leash.pending -= run.ceiling; leash.spentHour += uint96(total); leash.spentDay += uint96(total);
        totalReserved -= run.ceiling;
        uint96 returnedAmount = run.ceiling - uint96(total);
        availableBalance[run.payer] += returnedAmount; totalAvailable += returnedAmount;
        hostRegistry.closeRun(settlement.runId); run.hostReleased = true;
        if (base != 0) feeRouter.recordSettlement(settlement.receiptHash, run.hostOperator, uint96(base), run.sealedHost);
        emit RunSettled(settlement.runId, settlement.receiptHash, leaf, uint96(base), uint96(fee), returnedAmount);
    }

    function _recordRun(Quote calldata quote, address hostOperator, bool sealedHost, uint96 ceiling) private {
        Run storage run = runs[quote.runId];
        run.payer = quote.payer; run.hostOperator = hostOperator; run.leashId = quote.leashId; run.hostId = quote.hostId;
        run.hwClass = quote.hwClass; run.regionHash = quote.regionHash; run.imageHash = quote.imageHash; run.workloadHash = quote.workloadHash;
        run.sealedHost = sealedHost; run.openedAt = uint64(block.timestamp); run.acceptedExpiry = leashes[quote.leashId].expiry;
        run.maxSeconds = quote.maxSeconds; run.pricePerSecond = quote.pricePerSecond; run.inferencePrice = quote.inferencePrice;
        run.ceiling = ceiling; run.status = RunStatus.Open;
    }
    function _admit(Quote calldata quote, address hostOperator, bool sealedHost) private {
        Leash storage leash = leashes[quote.leashId]; uint96 ceiling = quoteCeiling(quote, sealedHost);
        _roll(leash);
        if (uint256(leash.spentHour) + leash.pending + ceiling > leash.maxPerHour
            || uint256(leash.spentDay) + leash.pending + ceiling > leash.maxPerDay) revert BudgetExceeded();
        if (availableBalance[quote.payer] < ceiling) revert InsufficientBalance();
        availableBalance[quote.payer] -= ceiling; totalAvailable -= ceiling;
        leash.pending += ceiling; totalReserved += ceiling;
        _recordRun(quote, hostOperator, sealedHost, ceiling);
        // Failed admission reverts every ledger/reservation change above.
        hostRegistry.openRun(quote.hostId, quote.runId);
        emit RunOpened(quote.runId, quote.leashId, quote.hostId, quote.payer, ceiling, uint64(block.timestamp), quote.maxSeconds);
    }
    function _validateTerms(LeashTerms calldata terms) private view {
        if (terms.agent == address(0) || terms.maxPerHour == 0 || terms.maxPerDay < terms.maxPerHour
            || terms.maxPerDay > MAX_LEASH_DAY
            || terms.classMask == 0 || terms.expiry <= block.timestamp) revert InvalidLeash();
    }
    function _setTerms(Leash storage leash, LeashTerms calldata terms) private {
        leash.agent = terms.agent; leash.maxPerHour = terms.maxPerHour; leash.maxPerDay = terms.maxPerDay;
        leash.classMask = terms.classMask; leash.sealedOnly = terms.sealedOnly;
        leash.imageAllowRoot = terms.imageAllowRoot; leash.regionAllowRoot = terms.regionAllowRoot; leash.expiry = terms.expiry;
    }
    function _roll(Leash storage leash) private {
        uint64 hour = uint64(block.timestamp / 1 hours); uint64 day = uint64(block.timestamp / 1 days);
        if (leash.hourKey != hour) { leash.hourKey = hour; leash.spentHour = 0; }
        if (leash.dayKey != day) { leash.dayKey = day; leash.spentDay = 0; }
    }
}
