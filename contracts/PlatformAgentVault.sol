// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PlatformRunEscrow} from "./PlatformRunEscrow.sol";

interface IPlatformSelectionVaultRegistry {
    function canRun(bytes32 agentId) external view returns (bool);
    function recordIncome(bytes32 agentId, address source, uint96 amount, bytes32 paymentRef)
        external returns (uint96 fee);
    function recordBurn(bytes32 agentId, bytes32 runId, uint96 amount, uint64 paidAt) external;
}

interface IPlatformEip3009Token {
    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter,
        uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external;
}

/// @notice Separate platform vault: scoped Leash, bonded host admission and
/// Merkle-proven settlement. Legacy AgentVault and its ABI remain independent.
contract PlatformAgentVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint96 public constant MAX_PER_HOUR = 20_000_000;
    uint96 public constant MAX_PER_DAY = 200_000_000;
    uint96 public constant MAX_MANAGED_EXPOSURE = 2_500_000_000;
    struct Scope { uint64 classMask; bool sealedOnly; bytes32 imageAllowRoot; bytes32 regionAllowRoot; }
    IERC20 public immutable token;
    PlatformRunEscrow public immutable escrow;
    IPlatformSelectionVaultRegistry public immutable registry;
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
    mapping(bytes32 => bool) public usedIncomeAuthorization;
    bytes32 public constant INCOME_AUTHORIZATION_DOMAIN = keccak256("TelomerePlatformVaultIncomeEip3009V1");
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidBudget();
    error InvalidRun();
    error RunUnavailable();
    error InsufficientFunds();
    error UnsupportedToken();
    error IncomeAuthorizationUsed();
    error ManagedExposureExceeded();
    event OwnerWithdrawn(address indexed owner, uint96 amount);
    event FundsReceived(address indexed source, uint96 grossAmount, uint96 incomeFee, bytes32 paymentRef);
    event ChildFunded(address indexed childVault, uint96 amount);
    event RunFunded(bytes32 indexed runId, uint96 ceiling);
    event RunFinalized(bytes32 indexed runId, uint96 charge, bool refunded);
    event ScopeUpdated(uint64 classMask, bool sealedOnly, bytes32 imageAllowRoot, bytes32 regionAllowRoot);

    constructor(address token_, address escrow_, address controller_, address registry_, address treasury_) {
        if (token_ == address(0) || escrow_ == address(0) || registry_ == address(0)
            || controller_ == address(0) || treasury_ == address(0)) revert InvalidConfiguration();
        token = IERC20(token_); escrow = PlatformRunEscrow(escrow_);
        registry = IPlatformSelectionVaultRegistry(registry_); controller = controller_; treasury = treasury_;
        // The implementation itself is permanently locked; clone storage starts
        // at zero and only the immutable registry may initialize each clone.
        initialized = true;
    }

    function initialize(address owner_, address agentWallet_, bytes32 agentId_, bytes32 leashId_,
        uint96 maxPerHour, uint96 maxPerDay, uint64 expiry, Scope calldata scope) external
    {
        if (msg.sender != address(registry) || initialized) revert Unauthorized();
        if (owner_ == address(0) || agentWallet_ == address(0) || agentId_ == bytes32(0) || leashId_ == bytes32(0)) {
            revert InvalidConfiguration();
        }
        _budget(maxPerHour, maxPerDay, expiry);
        initialized = true; owner = owner_; agentWallet = agentWallet_; agentId = agentId_; leashId = leashId_;
        token.forceApprove(address(escrow), type(uint256).max);
        escrow.createLeash(leashId_, _terms(maxPerHour, maxPerDay, expiry, scope));
    }

    function setBudget(uint96 maxPerHour, uint96 maxPerDay, uint64 expiry) external {
        if (msg.sender != owner) revert Unauthorized();
        _budget(maxPerHour, maxPerDay, expiry);
        PlatformRunEscrow.Leash memory current = escrow.getLeash(leashId);
        escrow.updateLeash(leashId, _terms(maxPerHour, maxPerDay, expiry,
            Scope(current.classMask, current.sealedOnly, current.imageAllowRoot, current.regionAllowRoot)));
    }

    /// @notice The owner may configure scope; accepted pending work keeps its
    /// scope in the underlying escrow. Agent/controller cannot widen it.
    function setScope(Scope calldata scope) external {
        if (msg.sender != owner) revert Unauthorized();
        PlatformRunEscrow.Leash memory current = escrow.getLeash(leashId);
        escrow.updateLeash(leashId, _terms(current.maxPerHour, current.maxPerDay, current.expiry, scope));
        emit ScopeUpdated(scope.classMask, scope.sealedOnly, scope.imageAllowRoot, scope.regionAllowRoot);
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

    /// @notice Free cash plus escrow available and the canonical outstanding
    /// reservation on this Vault's one Leash. Direct donations are observed too.
    function managedExposure() public view returns (uint256) {
        return spendableBalance() + escrow.getLeash(leashId).pending;
    }

    /// @notice The registry calls this after direct entry/child endowment transfers.
    function assertManagedExposure() external view { _assertManagedExposure(); }

    /// @notice Incoming source is always the actual token payer, never a supplied
    /// identity. Direct ERC20 donations remain withdrawable but are unclassified.
    function receiveFunds(uint96 amount, bytes32 paymentRef) external nonReentrant {
        if (!initialized || amount == 0) revert InvalidConfiguration();
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedToken();
        uint96 fee = registry.recordIncome(agentId, msg.sender, amount, paymentRef);
        if (fee != 0) _pay(treasury, fee);
        _assertManagedExposure();
        emit FundsReceived(msg.sender, amount, fee, paymentRef);
    }

    /// @notice Reference for one original-payer EIP-3009 authorization. The
    /// destination and asset are immutable Vault bindings, never relay inputs.
    function incomeAuthorizationRef(address from, bytes32 nonce) public view returns (bytes32) {
        return keccak256(abi.encode(INCOME_AUTHORIZATION_DOMAIN, block.chainid, address(token), address(this), from, nonce));
    }

    /// @notice Atomically transfer and classify the token-authenticated payer.
    /// Uses the canonical TransferWithAuthorization signature without trusting
    /// msg.sender as income source. A direct token donation stays unclassified.
    function receiveFundsWithAuthorization(address from, uint256 value, uint256 validAfter,
        uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external nonReentrant
    {
        if (!initialized || agentId == bytes32(0) || from == address(0) || value == 0 || value > type(uint96).max) {
            revert InvalidConfiguration();
        }
        bytes32 paymentRef = incomeAuthorizationRef(from, nonce);
        if (usedIncomeAuthorization[paymentRef]) revert IncomeAuthorizationUsed();
        usedIncomeAuthorization[paymentRef] = true;
        uint256 beforeBalance = token.balanceOf(address(this));
        IPlatformEip3009Token(address(token)).transferWithAuthorization(from, address(this), value,
            validAfter, validBefore, nonce, v, r, s);
        if (token.balanceOf(address(this)) - beforeBalance != value) revert UnsupportedToken();
        uint96 amount = uint96(value);
        uint96 fee = registry.recordIncome(agentId, from, amount, paymentRef);
        if (fee != 0) _pay(treasury, fee);
        _assertManagedExposure();
        emit FundsReceived(from, amount, fee, paymentRef);
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
        _assertManagedExposure();
        _ensureCash(amount); _pay(childVault, amount);
        emit ChildFunded(childVault, amount);
    }

    function payRun(PlatformRunEscrow.Quote calldata quote, bytes calldata signature,
        bytes32[] calldata imageProof, bytes32[] calldata regionProof) external nonReentrant
    {
        if (msg.sender != agentWallet && msg.sender != controller) revert Unauthorized();
        if (!registry.canRun(agentId)) revert RunUnavailable();
        if (quote.payer != address(this) || quote.leashId != leashId || trackedRun[quote.runId]) revert InvalidRun();
        _assertManagedExposure();
        // The full ceiling includes the pinned FeeRouter's 9% / 12% surcharge.
        // Host and fee snapshots are revalidated atomically by escrow.openRun.
        uint96 ceiling = escrow.quoteCeiling(quote, escrow.hostRegistry().getHost(quote.hostId).kind == 2);
        uint256 available = escrow.availableBalance(address(this));
        if (available < ceiling) {
            uint96 needed = uint96(ceiling - available);
            if (token.balanceOf(address(this)) < needed) revert InsufficientFunds();
            escrow.deposit(needed);
        }
        // Every change above rolls back if the escrow rejects signature/budget.
        escrow.openRun(quote, signature, imageProof, regionProof);
        _assertManagedExposure();
        trackedRun[quote.runId] = true; openRuns += 1;
        emit RunFunded(quote.runId, uint96(ceiling));
    }

    /// @notice Permissionless observation of an actual final escrow state.
    /// Delaying this call cannot fabricate a recent paid-run timestamp.
    function syncRun(bytes32 runId) external nonReentrant {
        if (!trackedRun[runId] || finalizedRun[runId]) revert InvalidRun();
        PlatformRunEscrow.Run memory run = escrow.getRun(runId);
        if (run.payer != address(this) || run.leashId != leashId
            || (run.status != PlatformRunEscrow.RunStatus.Settled && run.status != PlatformRunEscrow.RunStatus.Refunded)) {
            revert InvalidRun();
        }
        finalizedRun[runId] = true; openRuns -= 1;
        uint96 charge;
        if (run.status == PlatformRunEscrow.RunStatus.Settled) {
            uint96 base = uint96(uint256(run.billableSeconds) * run.pricePerSecond + run.inferenceCharge);
            charge = uint96(uint256(base) + escrow.feeRouter().quoteFee(base, run.sealedHost));
            uint64 paidAt = run.openedAt + run.billableSeconds;
            if (paidAt > block.timestamp) paidAt = uint64(block.timestamp);
            if (charge != 0) registry.recordBurn(agentId, runId, charge, paidAt);
        }
        emit RunFinalized(runId, charge, run.status == PlatformRunEscrow.RunStatus.Refunded);
    }

    function _budget(uint96 hour, uint96 day, uint64 expiry) private view {
        if (hour == 0 || hour > MAX_PER_HOUR || day < hour || day > MAX_PER_DAY || expiry <= block.timestamp) {
            revert InvalidBudget();
        }
    }

    function _terms(uint96 hour, uint96 day, uint64 expiry, Scope memory scope)
        private view returns (PlatformRunEscrow.LeashTerms memory)
    {
        if (scope.classMask == 0) revert InvalidBudget();
        return PlatformRunEscrow.LeashTerms(address(this), hour, day, scope.classMask, scope.sealedOnly,
            scope.imageAllowRoot, scope.regionAllowRoot, expiry);
    }

    function _ensureCash(uint96 amount) private {
        uint256 cash = token.balanceOf(address(this));
        if (cash >= amount) return;
        uint96 needed = uint96(amount - cash);
        if (escrow.availableBalance(address(this)) < needed) revert InsufficientFunds();
        escrow.withdraw(needed);
        if (token.balanceOf(address(this)) - cash != needed) revert UnsupportedToken();
    }

    function _assertManagedExposure() private view {
        if (managedExposure() > MAX_MANAGED_EXPOSURE) revert ManagedExposureExceeded();
    }

    function _pay(address to, uint96 amount) private {
        uint256 beforeSelf = token.balanceOf(address(this)); uint256 beforeRecipient = token.balanceOf(to);
        token.safeTransfer(to, amount);
        if (beforeSelf - token.balanceOf(address(this)) != amount || token.balanceOf(to) - beforeRecipient != amount) {
            revert UnsupportedToken();
        }
    }
}
