// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PlatformAgentVault} from "./PlatformAgentVault.sol";
import {PlatformRunEscrow} from "./PlatformRunEscrow.sol";

/// @notice ERC-8004 identity registries expose their ERC721 ownerOf. The pinned
/// deployment must be independently reviewed; this is not a canonical address.
interface IPlatformSelectionIdentity {
    function ownerOf(uint256 identityId) external view returns (address);
}
interface IPlatformSelectionGrace { function graceExtension(bytes32 agentId) external view returns (uint64); }

/// @notice Separate immutable factory for PlatformAgentVault instances. Legacy
/// SelectionRegistry identities, vaults, balances and selectors are unchanged.
contract PlatformSelectionRegistry is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint96 public constant MAX_PER_HOUR = 20_000_000;
    uint96 public constant MAX_PER_DAY = 200_000_000;
    uint8 public constant MAX_LIVING_CHILDREN = 3;
    uint64 public constant INACTIVITY_DELAY = 24 hours;
    uint64 public constant BASE_DORMANCY = 30 days;
    uint64 public constant MAX_EXTRA_GRACE = 30 days;
    uint16 public constant INCOME_FEE_BPS = 100;
    struct Config {
        address token; address escrow; address controller; address guardian;
        address identityRegistry; address staking; address treasury;
        uint96 entryFee; uint96 vaultFloor;
    }
    struct Entry {
        uint256 identityId; address agentWallet; uint96 maxPerHour; uint96 maxPerDay;
        uint64 expiry; bytes32 cystHash; uint96 endowment;
        PlatformAgentVault.Scope scope;
    }
    enum Status { None, Alive, Dormant, Dead }
    struct Agent {
        uint256 identityId; address owner; address agentWallet; address vault;
        bytes32 leashId; bytes32 parent; bytes32 family; bytes32 cystHash;
        uint64 enteredAt; uint64 dormantAt; uint64 diedAt; uint64 lastPaidRun; uint64 lastActivationAt; uint64 deathAt;
        uint256 lifetimeIncome; uint256 lifetimeBurn; uint256 lifetimeSubsidy; uint256 lifetimeIncomeFees;
        uint8 livingChildren; Status status; bool frozen;
    }
    IERC20 public immutable token;
    PlatformRunEscrow public immutable escrow;
    address public immutable controller;
    address public immutable guardian;
    IPlatformSelectionIdentity public immutable identityRegistry;
    IPlatformSelectionGrace public immutable staking;
    address public immutable treasury;
    uint96 public immutable entryFee;
    uint96 public immutable vaultFloor;
    address public immutable vaultImplementation;
    mapping(bytes32 => Agent) private agents;
    mapping(uint256 => bytes32) public identityAgent;
    mapping(address => bytes32) public vaultAgent;
    mapping(address => bytes32) public agentWalletAgent;
    uint256 public population;
    uint256 public totalBirths;
    uint256 public totalDeaths;
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidAgent();
    error InvalidBudget();
    error InvalidLifecycle();
    error InsufficientEndowment();
    error UnsupportedToken();
    event Birth(bytes32 indexed agentId, bytes32 indexed parent, address indexed owner, uint256 identityId,
        address vault, bytes32 leashId, uint96 endowment, bytes32 cystHash);
    event Income(bytes32 indexed agentId, uint96 amount, uint96 fee, address indexed source, bytes32 paymentRef);
    event Subsidy(bytes32 indexed agentId, uint96 amount, address indexed source, bytes32 paymentRef);
    event Burn(bytes32 indexed agentId, uint96 amount, bytes32 indexed runId, uint64 paidAt);
    event Dormant(bytes32 indexed agentId, uint64 dormantAt, uint64 deathAt);
    event GraceExtended(bytes32 indexed agentId, uint64 deathAt);
    event Death(bytes32 indexed agentId, uint64 lifespan, uint256 lifetimeIncome, uint256 lifetimeBurn, bytes32 cause);
    event Revived(bytes32 indexed agentId);
    event Spawn(bytes32 indexed parentId, bytes32 indexed childId, uint96 endowment, bytes32 cystHash);
    event Frozen(bytes32 indexed agentId, bool frozen, string reason, bytes32 evidence);
    event CystCommitted(bytes32 indexed agentId, bytes32 cystHash);

    constructor(Config memory config) {
        if (config.token == address(0) || config.token.code.length == 0 || IERC20Metadata(config.token).decimals() != 6
            || config.escrow == address(0) || config.escrow.code.length == 0
            || address(PlatformRunEscrow(config.escrow).token()) != config.token
            || PlatformRunEscrow(config.escrow).QUOTE_TYPEHASH() != keccak256(
                "PlatformQuote(bytes32 runId,bytes32 leashId,bytes32 hostId,address payer,uint16 hwClass,bytes32 regionHash,bytes32 imageHash,bytes32 workloadHash,uint64 maxSeconds,uint96 pricePerSecond,uint96 inferencePrice,uint64 quoteExpiry)")
            || config.controller == address(0) || config.guardian == address(0)
            || config.identityRegistry == address(0) || config.identityRegistry.code.length == 0
            || config.staking == address(0) || config.staking.code.length == 0 || config.treasury == address(0)
            || config.treasury == address(this) || config.entryFee == 0 || config.vaultFloor == 0) revert InvalidConfiguration();
        token = IERC20(config.token); escrow = PlatformRunEscrow(config.escrow);
        controller = config.controller; guardian = config.guardian;
        identityRegistry = IPlatformSelectionIdentity(config.identityRegistry); staking = IPlatformSelectionGrace(config.staking);
        treasury = config.treasury; entryFee = config.entryFee; vaultFloor = config.vaultFloor;
        vaultImplementation = address(new PlatformAgentVault(config.token, config.escrow, config.controller, address(this), config.treasury));
    }

    function enter(Entry calldata terms) external nonReentrant returns (bytes32 agentId) {
        _identity(terms.identityId, msg.sender, terms.agentWallet);
        _budget(terms.maxPerHour, terms.maxPerDay, terms.expiry);
        agentId = _birth(msg.sender, terms, bytes32(0), bytes32(0));
        if (entryFee != 0) _transferFromExact(msg.sender, treasury, entryFee);
        if (terms.endowment != 0) {
            _transferFromExact(msg.sender, agents[agentId].vault, terms.endowment);
            PlatformAgentVault(agents[agentId].vault).assertManagedExposure();
            _subsidy(agentId, msg.sender, terms.endowment, bytes32("entry"));
        }
    }

    /// @notice A fresh identity and agent key are required; the child receives a
    /// distinct leash with half the parent's current caps, not signing authority.
    function spawn(bytes32 parentId, uint256 childIdentityId, address childAgentWallet, uint96 endowment, uint64 expiry)
        external nonReentrant returns (bytes32 childId)
    {
        Agent storage parent = agents[parentId];
        if (parent.status != Status.Alive || parent.frozen || parent.livingChildren >= MAX_LIVING_CHILDREN
            || parent.cystHash == bytes32(0)) revert InvalidAgent();
        if (msg.sender != parent.owner && msg.sender != parent.agentWallet && msg.sender != controller) revert Unauthorized();
        if (endowment == 0) revert InsufficientEndowment();
        _identity(childIdentityId, parent.owner, childAgentWallet);
        PlatformRunEscrow.Leash memory parentLeash = escrow.getLeash(parent.leashId);
        if (parentLeash.killed || parentLeash.expiry <= block.timestamp) revert InvalidAgent();
        Entry memory terms = Entry(childIdentityId, childAgentWallet, parentLeash.maxPerHour / 2,
            parentLeash.maxPerDay / 2, expiry, parent.cystHash, endowment,
            PlatformAgentVault.Scope(parentLeash.classMask, parentLeash.sealedOnly, parentLeash.imageAllowRoot, parentLeash.regionAllowRoot));
        _budget(terms.maxPerHour, terms.maxPerDay, expiry);
        if (expiry > parentLeash.expiry) revert InvalidBudget();
        childId = _birth(parent.owner, terms, parentId, parent.family);
        parent.livingChildren += 1;
        // Entry fee also comes from the parent vault; neither the controller nor
        // caller can redirect any part of the child's approved endowment.
        PlatformAgentVault vault = PlatformAgentVault(parent.vault);
        if (entryFee != 0) vault.fundChild(treasury, entryFee);
        vault.fundChild(agents[childId].vault, endowment);
        PlatformAgentVault(agents[childId].vault).assertManagedExposure();
        _subsidy(childId, parent.vault, endowment, bytes32("spawn"));
        emit Spawn(parentId, childId, endowment, parent.cystHash);
    }

    function getAgent(bytes32 agentId) external view returns (Agent memory) { return agents[agentId]; }

    function canRun(bytes32 agentId) external view returns (bool) {
        Agent storage agent = agents[agentId];
        return agent.status == Status.Alive && !agent.frozen;
    }

    function recordIncome(bytes32 agentId, address source, uint96 amount, bytes32 paymentRef) external returns (uint96 fee) {
        Agent storage agent = agents[agentId];
        if (msg.sender != agent.vault || agent.status == Status.None || agent.status == Status.Dead || amount == 0) revert Unauthorized();
        if (_excluded(agent, source)) { _subsidy(agentId, source, amount, paymentRef); return 0; }
        fee = uint96((uint256(amount) * INCOME_FEE_BPS + 9_999) / 10_000);
        agent.lifetimeIncome += amount; agent.lifetimeIncomeFees += fee;
        emit Income(agentId, amount, fee, source, paymentRef);
    }

    function recordBurn(bytes32 agentId, bytes32 runId, uint96 amount, uint64 paidAt) external {
        Agent storage agent = agents[agentId];
        if (msg.sender != agent.vault || agent.status == Status.None || agent.status == Status.Dead || amount == 0
            || paidAt > block.timestamp) revert Unauthorized();
        agent.lifetimeBurn += amount;
        if (paidAt > agent.lastPaidRun) agent.lastPaidRun = paidAt;
        emit Burn(agentId, amount, runId, paidAt);
    }

    function declareDormant(bytes32 agentId) external {
        Agent storage agent = agents[agentId];
        uint64 activity = agent.lastPaidRun > agent.lastActivationAt ? agent.lastPaidRun : agent.lastActivationAt;
        if (agent.status != Status.Alive || block.timestamp < uint256(activity) + INACTIVITY_DELAY
            || PlatformAgentVault(agent.vault).openRuns() != 0 || PlatformAgentVault(agent.vault).spendableBalance() >= vaultFloor) {
            revert InvalidLifecycle();
        }
        agent.status = Status.Dormant; agent.dormantAt = uint64(block.timestamp);
        agent.deathAt = uint64(block.timestamp + BASE_DORMANCY);
        _extendGrace(agentId, agent);
        emit Dormant(agentId, agent.dormantAt, agent.deathAt);
    }

    function extendGrace(bytes32 agentId) external {
        Agent storage agent = agents[agentId];
        if (agent.status != Status.Dormant) revert InvalidLifecycle();
        _extendGrace(agentId, agent);
    }

    function declareDeath(bytes32 agentId) external {
        Agent storage agent = agents[agentId];
        if (agent.status != Status.Dormant) revert InvalidLifecycle();
        _extendGrace(agentId, agent);
        if (block.timestamp < agent.deathAt || PlatformAgentVault(agent.vault).openRuns() != 0
            || PlatformAgentVault(agent.vault).spendableBalance() >= vaultFloor) revert InvalidLifecycle();
        agent.status = Status.Dead; agent.diedAt = uint64(block.timestamp);
        population -= 1; totalDeaths += 1;
        if (agent.parent != bytes32(0)) agents[agent.parent].livingChildren -= 1;
        emit Death(agentId, uint64(block.timestamp - agent.enteredAt), agent.lifetimeIncome, agent.lifetimeBurn, bytes32("balance"));
    }

    function revive(bytes32 agentId) external {
        Agent storage agent = agents[agentId];
        if (msg.sender != agent.owner) revert Unauthorized();
        if (agent.status != Status.Dormant || agent.frozen || PlatformAgentVault(agent.vault).spendableBalance() < vaultFloor) {
            revert InvalidLifecycle();
        }
        agent.status = Status.Alive; agent.dormantAt = 0; agent.deathAt = 0;
        // A revival starts a new inactivity window; it fabricates no paid burn.
        agent.lastActivationAt = uint64(block.timestamp);
        emit Revived(agentId);
    }

    function setFrozen(bytes32 agentId, bool frozen, string calldata reason, bytes32 evidence) external {
        if (msg.sender != guardian) revert Unauthorized();
        Agent storage agent = agents[agentId];
        if (agent.status == Status.None || bytes(reason).length == 0 || bytes(reason).length > 256 || evidence == bytes32(0)) {
            revert InvalidAgent();
        }
        agent.frozen = frozen;
        emit Frozen(agentId, frozen, reason, evidence);
    }

    function setCystHash(bytes32 agentId, bytes32 cystHash) external {
        Agent storage agent = agents[agentId];
        if (msg.sender != agent.owner && msg.sender != agent.agentWallet) revert Unauthorized();
        if (agent.status == Status.None || agent.status == Status.Dead || cystHash == bytes32(0)) revert InvalidAgent();
        agent.cystHash = cystHash; emit CystCommitted(agentId, cystHash);
    }

    function isExcludedIncome(bytes32 agentId, address source) external view returns (bool) {
        if (agents[agentId].status == Status.None) revert InvalidAgent();
        return _excluded(agents[agentId], source);
    }

    function _birth(address owner, Entry memory terms, bytes32 parent, bytes32 family) private returns (bytes32 agentId) {
        agentId = keccak256(abi.encode(block.chainid, address(this), address(identityRegistry), terms.identityId));
        bytes32 leashId = keccak256(abi.encode(agentId, "selection-leash"));
        address vault = Clones.cloneDeterministic(vaultImplementation, agentId);
        Agent storage agent = agents[agentId];
        agent.identityId = terms.identityId; agent.owner = owner; agent.agentWallet = terms.agentWallet;
        agent.vault = vault; agent.leashId = leashId; agent.parent = parent;
        agent.family = family == bytes32(0) ? agentId : family; agent.cystHash = terms.cystHash;
        agent.enteredAt = uint64(block.timestamp); agent.lastActivationAt = uint64(block.timestamp); agent.status = Status.Alive;
        identityAgent[terms.identityId] = agentId; vaultAgent[vault] = agentId; agentWalletAgent[terms.agentWallet] = agentId;
        PlatformAgentVault(vault).initialize(owner, terms.agentWallet, agentId, leashId,
            terms.maxPerHour, terms.maxPerDay, terms.expiry, terms.scope);
        population += 1; totalBirths += 1;
        emit Birth(agentId, parent, owner, terms.identityId, vault, leashId, terms.endowment, terms.cystHash);
    }

    function _identity(uint256 identityId, address owner, address wallet) private view {
        if (wallet == address(0) || wallet == address(this) || wallet == controller || wallet == treasury
            || identityAgent[identityId] != bytes32(0) || agentWalletAgent[wallet] != bytes32(0)
            || identityRegistry.ownerOf(identityId) != owner) revert InvalidAgent();
    }

    function _budget(uint96 hour, uint96 day, uint64 expiry) private view {
        if (hour == 0 || hour > MAX_PER_HOUR || day < hour || day > MAX_PER_DAY || expiry <= block.timestamp) revert InvalidBudget();
    }

    function _excluded(Agent storage agent, address source) private view returns (bool) {
        if (source == agent.owner || source == agent.agentWallet || source == controller || source == treasury || source == address(this)) {
            return true;
        }
        bytes32 related = vaultAgent[source];
        if (related == bytes32(0)) related = agentWalletAgent[source];
        return related != bytes32(0) && agents[related].family == agent.family;
    }

    function _subsidy(bytes32 agentId, address source, uint96 amount, bytes32 paymentRef) private {
        agents[agentId].lifetimeSubsidy += amount;
        emit Subsidy(agentId, amount, source, paymentRef);
    }

    function _extendGrace(bytes32 agentId, Agent storage agent) private {
        uint64 extension = staking.graceExtension(agentId);
        if (extension > MAX_EXTRA_GRACE) extension = MAX_EXTRA_GRACE;
        uint64 candidate = agent.dormantAt + BASE_DORMANCY + extension;
        if (candidate > agent.deathAt) { agent.deathAt = candidate; emit GraceExtended(agentId, candidate); }
    }

    function _transferFromExact(address source, address to, uint96 amount) private {
        uint256 beforeBalance = token.balanceOf(to);
        token.safeTransferFrom(source, to, amount);
        if (token.balanceOf(to) - beforeBalance != amount) revert UnsupportedToken();
    }
}
