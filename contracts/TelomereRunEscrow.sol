// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Closed pilot escrow. Receipts are attested by one trusted, immutable
/// signer; they are not cryptographic proof of the underlying computation.
/// All monetary values are integer units of the configured token.
contract TelomereRunEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint64 public constant MAX_RUN_SECONDS = 120;
    uint64 public constant REFUND_GRACE_SECONDS = 6 hours;
    IERC20 public immutable token;
    address public immutable quoteSigner;
    address public immutable receiptSigner;
    address public immutable treasury;

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(bytes32 runId,bytes32 leashId,address payer,bytes32 workloadHash,uint64 maxSeconds,uint96 pricePerSecond,uint96 inferencePrice,uint64 quoteExpiry)"
    );
    bytes32 public constant SETTLEMENT_TYPEHASH = keccak256(
        "Settlement(bytes32 runId,uint64 billableSeconds,uint96 inferenceCharge,bytes32 receiptHash)"
    );

    enum RunStatus { None, Open, Settled, Refunded }
    struct Quote {
        bytes32 runId;
        bytes32 leashId;
        address payer;
        bytes32 workloadHash;
        uint64 maxSeconds;
        uint96 pricePerSecond;
        uint96 inferencePrice;
        uint64 quoteExpiry;
    }
    struct Settlement {
        bytes32 runId;
        uint64 billableSeconds;
        uint96 inferenceCharge;
        bytes32 receiptHash;
    }
    struct Leash {
        address owner;
        address agent;
        uint96 maxPerHour;
        uint96 maxPerDay;
        uint64 expiry;
        bool killed;
        uint64 killedAt;
        uint64 hourKey;
        uint64 dayKey;
        uint96 spentHour;
        uint96 spentDay;
        uint96 pending;
    }
    struct Run {
        address payer;
        bytes32 leashId;
        bytes32 workloadHash;
        uint64 openedAt;
        uint64 acceptedExpiry;
        uint64 maxSeconds;
        uint96 pricePerSecond;
        uint96 inferencePrice;
        uint96 ceiling;
        uint64 stopAt;
        RunStatus status;
        uint64 billableSeconds;
        uint96 inferenceCharge;
        bytes32 receiptHash;
    }

    mapping(address => uint256) public availableBalance;
    mapping(bytes32 => Leash) private leashes;
    mapping(bytes32 => Run) private runs;
    mapping(bytes32 => bool) public usedReceiptHash;

    error InvalidConfiguration();
    error InvalidAmount();
    error InvalidLeash();
    error Unauthorized();
    error LeashInactive();
    error BudgetExceeded();
    error InsufficientBalance();
    error InvalidQuote();
    error InvalidSignature();
    error InvalidRun();
    error InvalidSettlement();
    error RefundNotReady();
    error UnsupportedToken();

    event Deposited(address indexed payer, uint96 amount);
    event Withdrawn(address indexed payer, uint96 amount);
    event LeashCreated(bytes32 indexed leashId, address indexed owner, address agent,
        uint96 maxPerHour, uint96 maxPerDay, uint64 expiry);
    event LeashUpdated(bytes32 indexed leashId, address agent, uint96 maxPerHour, uint96 maxPerDay, uint64 expiry);
    event LeashKilled(bytes32 indexed leashId, uint64 killedAt);
    event RunOpened(bytes32 indexed runId, bytes32 indexed leashId, address indexed payer,
        bytes32 workloadHash, uint96 ceiling, uint64 openedAt, uint64 maxSeconds);
    event StopRequested(bytes32 indexed runId, uint64 stopAt);
    event RunSettled(bytes32 indexed runId, uint64 billableSeconds, uint96 inferenceCharge,
        uint96 amount, uint96 returnedAmount, bytes32 indexed receiptHash);
    event RunRefunded(bytes32 indexed runId, address indexed payer, uint96 amount);

    constructor(address token_, address quoteSigner_, address receiptSigner_, address treasury_)
        EIP712("TelomereRunEscrow", "1")
    {
        if (token_ == address(0) || token_.code.length == 0 || quoteSigner_ == address(0)
            || receiptSigner_ == address(0) || treasury_ == address(0) || treasury_ == address(this)) {
            revert InvalidConfiguration();
        }
        token = IERC20(token_);
        quoteSigner = quoteSigner_;
        receiptSigner = receiptSigner_;
        treasury = treasury_;
    }

    function deposit(uint96 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedToken();
        availableBalance[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint96 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (availableBalance[msg.sender] < amount) revert InsufficientBalance();
        availableBalance[msg.sender] -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function createLeash(bytes32 leashId, address agent, uint96 maxPerHour, uint96 maxPerDay, uint64 expiry) external {
        if (leashId == bytes32(0) || leashes[leashId].owner != address(0)) revert InvalidLeash();
        _validateLeashTerms(agent, maxPerHour, maxPerDay, expiry);
        Leash storage l = leashes[leashId];
        l.owner = msg.sender;
        l.agent = agent;
        l.maxPerHour = maxPerHour;
        l.maxPerDay = maxPerDay;
        l.expiry = expiry;
        l.hourKey = uint64(block.timestamp / 1 hours);
        l.dayKey = uint64(block.timestamp / 1 days);
        emit LeashCreated(leashId, msg.sender, agent, maxPerHour, maxPerDay, expiry);
    }

    function updateLeash(bytes32 leashId, address agent, uint96 maxPerHour, uint96 maxPerDay, uint64 expiry) external {
        Leash storage l = leashes[leashId];
        if (l.owner == address(0)) revert InvalidLeash();
        if (l.owner != msg.sender) revert Unauthorized();
        if (l.killed) revert LeashInactive();
        _validateLeashTerms(agent, maxPerHour, maxPerDay, expiry);
        _rollBuckets(l);
        if (uint256(l.spentHour) + l.pending > maxPerHour || uint256(l.spentDay) + l.pending > maxPerDay) {
            revert BudgetExceeded();
        }
        l.agent = agent;
        l.maxPerHour = maxPerHour;
        l.maxPerDay = maxPerDay;
        l.expiry = expiry;
        emit LeashUpdated(leashId, agent, maxPerHour, maxPerDay, expiry);
    }

    function killLeash(bytes32 leashId) external {
        Leash storage l = leashes[leashId];
        if (l.owner == address(0)) revert InvalidLeash();
        if (l.owner != msg.sender) revert Unauthorized();
        if (l.killed) revert LeashInactive();
        l.killed = true;
        l.killedAt = uint64(block.timestamp);
        emit LeashKilled(leashId, l.killedAt);
    }

    function openRun(Quote calldata q, bytes calldata signature) external nonReentrant {
        Leash storage l = leashes[q.leashId];
        if (l.owner == address(0)) revert InvalidLeash();
        if (msg.sender != l.owner && msg.sender != l.agent) revert Unauthorized();
        if (q.payer != l.owner) revert Unauthorized();
        if (l.killed || block.timestamp >= l.expiry) revert LeashInactive();
        if (q.runId == bytes32(0) || runs[q.runId].status != RunStatus.None || q.workloadHash == bytes32(0)
            || q.maxSeconds == 0 || q.maxSeconds > MAX_RUN_SECONDS || block.timestamp > q.quoteExpiry) {
            revert InvalidQuote();
        }
        uint256 ceiling = uint256(q.maxSeconds) * q.pricePerSecond + q.inferencePrice;
        if (ceiling == 0 || ceiling > type(uint96).max) revert InvalidQuote();
        if (ECDSA.recover(quoteDigest(q), signature) != quoteSigner) revert InvalidSignature();
        _rollBuckets(l);
        // Every unfinished reservation carries into every new bucket. This is
        // deliberately conservative rather than allowing cross-boundary debt.
        if (uint256(l.spentHour) + l.pending + ceiling > l.maxPerHour
            || uint256(l.spentDay) + l.pending + ceiling > l.maxPerDay) revert BudgetExceeded();
        if (availableBalance[q.payer] < ceiling) revert InsufficientBalance();
        availableBalance[q.payer] -= ceiling;
        l.pending += uint96(ceiling);
        runs[q.runId] = Run({payer: q.payer, leashId: q.leashId, workloadHash: q.workloadHash,
            openedAt: uint64(block.timestamp), acceptedExpiry: l.expiry, maxSeconds: q.maxSeconds,
            pricePerSecond: q.pricePerSecond, inferencePrice: q.inferencePrice, ceiling: uint96(ceiling),
            stopAt: 0, status: RunStatus.Open, billableSeconds: 0, inferenceCharge: 0, receiptHash: bytes32(0)});
        emit RunOpened(q.runId, q.leashId, q.payer, q.workloadHash, uint96(ceiling), uint64(block.timestamp), q.maxSeconds);
    }

    function requestStop(bytes32 runId) external {
        Run storage r = runs[runId];
        if (r.status != RunStatus.Open) revert InvalidRun();
        if (msg.sender != r.payer) revert Unauthorized();
        if (r.stopAt == 0) {
            r.stopAt = uint64(block.timestamp);
            emit StopRequested(runId, r.stopAt);
        }
    }

    function settleRun(Settlement calldata s, bytes calldata signature) external nonReentrant {
        Run storage r = runs[s.runId];
        if (r.status != RunStatus.Open) revert InvalidRun();
        if (block.timestamp >= refundAt(s.runId)) revert InvalidSettlement();
        if (s.receiptHash == bytes32(0) || usedReceiptHash[s.receiptHash]
            || s.billableSeconds > r.maxSeconds
            || (s.inferenceCharge != 0 && s.inferenceCharge != r.inferencePrice)) revert InvalidSettlement();
        if (ECDSA.recover(settlementDigest(s), signature) != receiptSigner) revert InvalidSignature();
        uint256 cutoff = block.timestamp;
        if (r.stopAt != 0 && r.stopAt < cutoff) cutoff = r.stopAt;
        Leash storage l = leashes[r.leashId];
        if (l.killed && l.killedAt < cutoff) cutoff = l.killedAt;
        if (r.acceptedExpiry < cutoff) cutoff = r.acceptedExpiry;
        // Block timestamps have whole-second precision. Permit one second of
        // rounding tolerance, always bounded by the signed maxSeconds ceiling.
        uint256 elapsed = cutoff > r.openedAt ? cutoff - r.openedAt : 0;
        if (s.billableSeconds > elapsed + 1) revert InvalidSettlement();
        uint256 charge = uint256(s.billableSeconds) * r.pricePerSecond + s.inferenceCharge;
        if (charge > r.ceiling) revert InvalidSettlement();
        r.status = RunStatus.Settled;
        r.billableSeconds = s.billableSeconds;
        r.inferenceCharge = s.inferenceCharge;
        r.receiptHash = s.receiptHash;
        usedReceiptHash[s.receiptHash] = true;
        _rollBuckets(l);
        l.pending -= r.ceiling;
        l.spentHour += uint96(charge);
        l.spentDay += uint96(charge);
        uint96 returnedAmount = r.ceiling - uint96(charge);
        availableBalance[r.payer] += returnedAmount;
        if (charge != 0) token.safeTransfer(treasury, charge);
        emit RunSettled(s.runId, s.billableSeconds, s.inferenceCharge, uint96(charge), returnedAmount, s.receiptHash);
    }

    /// @notice A stop request never unlocks accepted work before its receipt.
    /// Permissionless full refund is available once settlement grace expires.
    function refundRun(bytes32 runId) external nonReentrant {
        Run storage r = runs[runId];
        if (r.status != RunStatus.Open) revert InvalidRun();
        if (block.timestamp < refundAt(runId)) revert RefundNotReady();
        r.status = RunStatus.Refunded;
        leashes[r.leashId].pending -= r.ceiling;
        availableBalance[r.payer] += r.ceiling;
        emit RunRefunded(runId, r.payer, r.ceiling);
    }

    function getLeash(bytes32 leashId) external view returns (Leash memory l) {
        l = leashes[leashId];
        if (l.hourKey != block.timestamp / 1 hours) { l.spentHour = 0; l.hourKey = uint64(block.timestamp / 1 hours); }
        if (l.dayKey != block.timestamp / 1 days) { l.spentDay = 0; l.dayKey = uint64(block.timestamp / 1 days); }
    }
    function getRun(bytes32 runId) external view returns (Run memory) { return runs[runId]; }
    function refundAt(bytes32 runId) public view returns (uint256) {
        Run storage r = runs[runId];
        if (r.status == RunStatus.None) revert InvalidRun();
        return uint256(r.openedAt) + r.maxSeconds + REFUND_GRACE_SECONDS;
    }
    function quoteDigest(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(QUOTE_TYPEHASH, q.runId, q.leashId, q.payer,
            q.workloadHash, q.maxSeconds, q.pricePerSecond, q.inferencePrice, q.quoteExpiry)));
    }
    function settlementDigest(Settlement calldata s) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(SETTLEMENT_TYPEHASH, s.runId, s.billableSeconds, s.inferenceCharge, s.receiptHash)));
    }
    function _validateLeashTerms(address agent, uint96 maxPerHour, uint96 maxPerDay, uint64 expiry) private view {
        if (agent == address(0) || maxPerHour == 0 || maxPerDay == 0 || expiry <= block.timestamp) revert InvalidLeash();
    }
    function _rollBuckets(Leash storage l) private {
        uint64 hour = uint64(block.timestamp / 1 hours);
        uint64 day = uint64(block.timestamp / 1 days);
        if (l.hourKey != hour) { l.hourKey = hour; l.spentHour = 0; }
        if (l.dayKey != day) { l.dayKey = day; l.spentDay = 0; }
    }
}
