// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TelomereRunEscrow} from "./TelomereRunEscrow.sol";

interface ISelectionVaultRegistry {
    function canRun(bytes32 agentId) external view returns (bool);
    function recordIncome(bytes32 agentId, address source, uint96 amount, bytes32 paymentRef)
        external returns (uint96 fee);
    function recordBurn(bytes32 agentId, bytes32 runId, uint96 amount, uint64 paidAt) external;
}

/// @notice One EIP-1167 instance per Selection identity. Only this contract is
/// named as the escrow leash's agent, preventing an EOA bypass of lifecycle gates.
contract AgentVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint96 public constant MAX_PER_HOUR = 20_000_000;
    uint96 public constant MAX_PER_DAY = 200_000_000;
    IERC20 public immutable token;
    TelomereRunEscrow public immutable escrow;
    ISelectionVaultRegistry public immutable registry;
    address public immutable controller;
    address public immutable treasury;
    address public owner;
    address public agentWallet;
    bytes32 public agentId;
    bytes32 public leashId;
    bool private initialized;
    uint64 public openRuns;
    mapping(bytes32 => bool) public trackedRun;
    mapping(bytes32 => bool) public finalizedRun;
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidBudget();
    error InvalidRun();
    error RunUnavailable();
    error InsufficientFunds();
    error UnsupportedToken();
    event OwnerWithdrawn(address indexed owner, uint96 amount);
    event FundsReceived(address indexed source, uint96 grossAmount, uint96 incomeFee, bytes32 paymentRef);
    event ChildFunded(address indexed childVault, uint96 amount);
    event RunFunded(bytes32 indexed runId, uint96 ceiling);
    event RunFinalized(bytes32 indexed runId, uint96 charge, bool refunded);

    constructor(address token_, address escrow_, address controller_, address registry_, address treasury_) {
        if (token_ == address(0) || escrow_ == address(0) || registry_ == address(0)
            || controller_ == address(0) || treasury_ == address(0)) revert InvalidConfiguration();
        token = IERC20(token_); escrow = TelomereRunEscrow(escrow_);
        registry = ISelectionVaultRegistry(registry_); controller = controller_; treasury = treasury_;
        // The implementation itself is permanently locked; clone storage starts
        // at zero and only the immutable registry may initialize each clone.
        initialized = true;
    }

    function initialize(address owner_, address agentWallet_, bytes32 agentId_, bytes32 leashId_,
        uint96 maxPerHour, uint96 maxPerDay, uint64 expiry) external
    {
        if (msg.sender != address(registry) || initialized) revert Unauthorized();
        if (owner_ == address(0) || agentWallet_ == address(0) || agentId_ == bytes32(0) || leashId_ == bytes32(0)) {
            revert InvalidConfiguration();
        }
        _budget(maxPerHour, maxPerDay, expiry);
        initialized = true; owner = owner_; agentWallet = agentWallet_; agentId = agentId_; leashId = leashId_;
        token.forceApprove(address(escrow), type(uint256).max);
        escrow.createLeash(leashId_, address(this), maxPerHour, maxPerDay, expiry);
    }

    function setBudget(uint96 maxPerHour, uint96 maxPerDay, uint64 expiry) external {
        if (msg.sender != owner) revert Unauthorized();
        _budget(maxPerHour, maxPerDay, expiry);
        escrow.updateLeash(leashId, address(this), maxPerHour, maxPerDay, expiry);
    }

    function killLeash() external {
        if (msg.sender != owner) revert Unauthorized();
        escrow.killLeash(leashId);
    }

    function requestStop(bytes32 runId) external {
        if (msg.sender != owner) revert Unauthorized();
        if (!trackedRun[runId]) revert InvalidRun();
        escrow.requestStop(runId);
    }

    function spendableBalance() public view returns (uint256) {
        return token.balanceOf(address(this)) + escrow.availableBalance(address(this));
    }

    /// @notice Incoming source is always the actual token payer, never a supplied
    /// identity. Direct ERC20 donations remain withdrawable but are unclassified.
    function receiveFunds(uint96 amount, bytes32 paymentRef) external nonReentrant {
        if (!initialized || amount == 0) revert InvalidConfiguration();
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedToken();
        uint96 fee = registry.recordIncome(agentId, msg.sender, amount, paymentRef);
        if (fee != 0) _pay(treasury, fee);
        emit FundsReceived(msg.sender, amount, fee, paymentRef);
    }

    /// @notice Free cash and escrow available balance are always owner-accessible,
    /// including when frozen, dormant, dead or killed. Reservations stay escrowed.
    function ownerWithdraw(uint96 amount) external nonReentrant {
        if (msg.sender != owner) revert Unauthorized();
        if (amount == 0) revert InsufficientFunds();
        _ensureCash(amount); _pay(owner, amount);
        emit OwnerWithdrawn(owner, amount);
    }

    function fundChild(address childVault, uint96 amount) external nonReentrant {
        if (msg.sender != address(registry)) revert Unauthorized();
        if (childVault == address(0) || childVault == address(this) || amount == 0) revert InvalidConfiguration();
        _ensureCash(amount); _pay(childVault, amount);
        emit ChildFunded(childVault, amount);
    }

    function payRun(TelomereRunEscrow.Quote calldata quote, bytes calldata signature) external nonReentrant {
        if (msg.sender != agentWallet && msg.sender != controller) revert Unauthorized();
        if (!registry.canRun(agentId)) revert RunUnavailable();
        if (quote.payer != address(this) || quote.leashId != leashId || trackedRun[quote.runId]) revert InvalidRun();
        uint256 ceiling = uint256(quote.maxSeconds) * quote.pricePerSecond + quote.inferencePrice;
        if (ceiling == 0 || ceiling > type(uint96).max) revert InvalidRun();
        uint256 available = escrow.availableBalance(address(this));
        if (available < ceiling) {
            uint96 needed = uint96(ceiling - available);
            if (token.balanceOf(address(this)) < needed) revert InsufficientFunds();
            escrow.deposit(needed);
        }
        // Every change above rolls back if the escrow rejects signature/budget.
        escrow.openRun(quote, signature);
        trackedRun[quote.runId] = true; openRuns += 1;
        emit RunFunded(quote.runId, uint96(ceiling));
    }

    /// @notice Permissionless observation of an actual final escrow state.
    /// Delaying this call cannot fabricate a recent paid-run timestamp.
    function syncRun(bytes32 runId) external nonReentrant {
        if (!trackedRun[runId] || finalizedRun[runId]) revert InvalidRun();
        TelomereRunEscrow.Run memory run = escrow.getRun(runId);
        if (run.payer != address(this) || run.leashId != leashId
            || (run.status != TelomereRunEscrow.RunStatus.Settled && run.status != TelomereRunEscrow.RunStatus.Refunded)) {
            revert InvalidRun();
        }
        finalizedRun[runId] = true; openRuns -= 1;
        uint96 charge;
        if (run.status == TelomereRunEscrow.RunStatus.Settled) {
            charge = uint96(uint256(run.billableSeconds) * run.pricePerSecond + run.inferenceCharge);
            uint64 paidAt = run.openedAt + run.billableSeconds;
            if (paidAt > block.timestamp) paidAt = uint64(block.timestamp);
            if (charge != 0) registry.recordBurn(agentId, runId, charge, paidAt);
        }
        emit RunFinalized(runId, charge, run.status == TelomereRunEscrow.RunStatus.Refunded);
    }

    function _budget(uint96 hour, uint96 day, uint64 expiry) private view {
        if (hour == 0 || hour > MAX_PER_HOUR || day < hour || day > MAX_PER_DAY || expiry <= block.timestamp) {
            revert InvalidBudget();
        }
    }

    function _ensureCash(uint96 amount) private {
        uint256 cash = token.balanceOf(address(this));
        if (cash >= amount) return;
        uint96 needed = uint96(amount - cash);
        if (escrow.availableBalance(address(this)) < needed) revert InsufficientFunds();
        escrow.withdraw(needed);
        if (token.balanceOf(address(this)) - cash != needed) revert UnsupportedToken();
    }

    function _pay(address to, uint96 amount) private {
        uint256 beforeSelf = token.balanceOf(address(this)); uint256 beforeRecipient = token.balanceOf(to);
        token.safeTransfer(to, amount);
        if (beforeSelf - token.balanceOf(address(this)) != amount || token.balanceOf(to) - beforeRecipient != amount) {
            revert UnsupportedToken();
        }
    }
}
