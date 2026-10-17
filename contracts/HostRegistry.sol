// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IHostEvidenceRoot {
    function verify(bytes32 leaf, bytes32[] calldata proof, uint64 hour) external view returns (bool);
}

/// @notice Fixed six-decimal collateral registry. Controller hooks must be wired
/// atomically by the production escrow before this registry admits paid supply.
contract HostRegistry is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint96 public constant CPU_MINIMUM = 300_000_000;
    uint96 public constant GPU_MINIMUM = 1_500_000_000;
    uint64 public constant UNBOND_DELAY = 21 days;
    IERC20 public immutable token;
    address public immutable controller;
    address public immutable guardian;
    address public immutable penaltyTreasury;
    IHostEvidenceRoot public immutable evidenceRoot;
    bool public registrationPaused;
    uint256 public totalCollateral;

    struct Host {
        address operator; bytes32 hostKey; uint8 kind; bytes32 teeMeasurement;
        uint96 collateral; uint32 strikes; uint64 unbondAt; bool active; bool gpu;
        uint64 openRuns;
    }
    mapping(bytes32 => Host) private hosts;
    mapping(address => bytes32) public operatorHost;
    mapping(bytes32 => bool) public usedHostKey;
    mapping(bytes32 => bytes32) public runHost;
    mapping(bytes32 => bool) public usedRun;
    mapping(bytes32 => bool) public usedEvidence;

    error Unauthorized();
    error InvalidConfiguration();
    error InvalidHost();
    error InvalidCollateral();
    error InvalidRun();
    error UnbondUnavailable();
    error InvalidEvidence();
    error UnsupportedToken();
    event Registered(bytes32 indexed hostId, address indexed operator, bytes32 hostKey, bool gpu, uint96 collateral);
    event CollateralAdded(bytes32 indexed hostId, uint96 amount);
    event UnbondRequested(bytes32 indexed hostId, uint64 unbondAt);
    event CollateralWithdrawn(bytes32 indexed hostId, address indexed operator, uint96 amount);
    event RunOpened(bytes32 indexed hostId, bytes32 indexed runId);
    event RunClosed(bytes32 indexed hostId, bytes32 indexed runId);
    event Penalized(bytes32 indexed hostId, bytes32 indexed evidenceLeaf, uint96 amount, uint32 strikes);
    event RegistrationPauseChanged(bool paused);

    constructor(address token_, address controller_, address guardian_, address penaltyTreasury_, address evidenceRoot_) {
        if (token_ == address(0) || token_.code.length == 0 || IERC20Metadata(token_).decimals() != 6
            || controller_ == address(0) || guardian_ == address(0) || penaltyTreasury_ == address(0)
            || penaltyTreasury_ == address(this) || evidenceRoot_ == address(0) || evidenceRoot_.code.length == 0) {
            revert InvalidConfiguration();
        }
        token = IERC20(token_); controller = controller_; guardian = guardian_;
        penaltyTreasury = penaltyTreasury_; evidenceRoot = IHostEvidenceRoot(evidenceRoot_);
    }

    function register(bytes32 hostKey, uint8 kind, bytes32 teeMeasurement, uint96 collateral, bool gpu)
        external nonReentrant returns (bytes32 hostId)
    {
        if (registrationPaused || hostKey == bytes32(0) || usedHostKey[hostKey] || operatorHost[msg.sender] != bytes32(0)
            || kind > 2 || (kind == 2 ? teeMeasurement == bytes32(0) : teeMeasurement != bytes32(0))) revert InvalidHost();
        if (collateral < (gpu ? GPU_MINIMUM : CPU_MINIMUM)) revert InvalidCollateral();
        hostId = keccak256(abi.encode(block.chainid, address(this), msg.sender, hostKey));
        usedHostKey[hostKey] = true; operatorHost[msg.sender] = hostId;
        hosts[hostId] = Host(msg.sender, hostKey, kind, teeMeasurement, collateral, 0, 0, true, gpu, 0);
        totalCollateral += collateral;
        _pull(collateral);
        emit Registered(hostId, msg.sender, hostKey, gpu, collateral);
    }

    function getHost(bytes32 hostId) external view returns (Host memory) { return hosts[hostId]; }

    function setRegistrationPaused(bool paused) external {
        if (msg.sender != guardian) revert Unauthorized();
        registrationPaused = paused;
        emit RegistrationPauseChanged(paused);
    }

    function addCollateral(uint96 amount) external nonReentrant {
        bytes32 hostId = operatorHost[msg.sender];
        Host storage host = hosts[hostId];
        if (host.operator != msg.sender || host.unbondAt != 0) revert InvalidHost();
        if (amount == 0) revert InvalidCollateral();
        host.collateral += amount; totalCollateral += amount;
        host.active = host.collateral >= (host.gpu ? GPU_MINIMUM : CPU_MINIMUM);
        _pull(amount);
        emit CollateralAdded(hostId, amount);
    }

    function openRun(bytes32 hostId, bytes32 runId) external {
        if (msg.sender != controller) revert Unauthorized();
        Host storage host = hosts[hostId];
        if (!host.active || host.operator == address(0) || host.unbondAt != 0) revert InvalidHost();
        if (runId == bytes32(0) || usedRun[runId]) revert InvalidRun();
        usedRun[runId] = true; runHost[runId] = hostId; host.openRuns += 1;
        emit RunOpened(hostId, runId);
    }

    function closeRun(bytes32 runId) external {
        if (msg.sender != controller) revert Unauthorized();
        bytes32 hostId = runHost[runId];
        if (hostId == bytes32(0)) revert InvalidRun();
        delete runHost[runId]; hosts[hostId].openRuns -= 1;
        emit RunClosed(hostId, runId);
    }

    function requestUnbond() external {
        bytes32 hostId = operatorHost[msg.sender]; Host storage host = hosts[hostId];
        if (host.operator != msg.sender || host.unbondAt != 0 || host.openRuns != 0) revert UnbondUnavailable();
        host.active = false; host.unbondAt = uint64(block.timestamp + UNBOND_DELAY);
        emit UnbondRequested(hostId, host.unbondAt);
    }

    function withdrawCollateral() external nonReentrant {
        bytes32 hostId = operatorHost[msg.sender]; Host storage host = hosts[hostId];
        if (host.operator != msg.sender || host.unbondAt == 0 || block.timestamp < host.unbondAt || host.openRuns != 0) {
            revert UnbondUnavailable();
        }
        uint96 amount = host.collateral; host.collateral = 0; host.active = false;
        delete operatorHost[msg.sender]; totalCollateral -= amount;
        if (amount != 0) _push(msg.sender, amount);
        emit CollateralWithdrawn(hostId, msg.sender, amount);
    }

    function penaltyLeaf(bytes32 hostId, bytes32 incidentId, uint96 amount) public view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(this), hostId, incidentId, amount))));
    }

    function penalize(bytes32 hostId, bytes32 incidentId, uint96 amount, uint64 hour, bytes32[] calldata proof)
        external nonReentrant
    {
        if (msg.sender != controller) revert Unauthorized();
        Host storage host = hosts[hostId];
        bytes32 leaf = penaltyLeaf(hostId, incidentId, amount);
        // Incident identity, rather than amount-dependent leaf, prevents replay
        // with a second amount in another committed root.
        bytes32 evidenceId = keccak256(abi.encode(hostId, incidentId));
        if (host.operator == address(0) || operatorHost[host.operator] != hostId || incidentId == bytes32(0)
            || amount == 0 || amount > host.collateral || usedEvidence[evidenceId]
            || !evidenceRoot.verify(leaf, proof, hour)) revert InvalidEvidence();
        usedEvidence[evidenceId] = true; host.collateral -= amount; host.strikes += 1; totalCollateral -= amount;
        if (host.collateral < (host.gpu ? GPU_MINIMUM : CPU_MINIMUM)) host.active = false;
        _push(penaltyTreasury, amount);
        emit Penalized(hostId, leaf, amount, host.strikes);
    }

    function _pull(uint96 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedToken();
    }

    function _push(address to, uint96 amount) private {
        uint256 beforeSelf = token.balanceOf(address(this)); uint256 beforeRecipient = token.balanceOf(to);
        token.safeTransfer(to, amount);
        if (beforeSelf - token.balanceOf(address(this)) != amount || token.balanceOf(to) - beforeRecipient != amount) {
            revert UnsupportedToken();
        }
    }
}
