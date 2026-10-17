// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PlatformSelectionRegistry} from "./PlatformSelectionRegistry.sol";
import {PlatformAgentVault} from "./PlatformAgentVault.sol";

/// @notice Ciphertext checkpoints for identities in one immutable Selection
/// registry. Only its current agent wallet can mutate a checkpoint. The human
/// owner, controller and Vault have no substitute signing authority.
contract CystRegistry {
    uint64 public constant MAX_CYST_BYTES = 2_147_483_648;
    PlatformSelectionRegistry public immutable selectionRegistry;

    struct Cyst {
        bytes32 cystHash;
        uint64 sizeBytes;
        bytes32 storageRef;
        uint64 revision;
        uint64 committedAt;
        bool retired;
    }

    mapping(bytes32 => Cyst) private cysts;

    error InvalidConfiguration();
    error InvalidAgent();
    error Unauthorized();
    error InvalidLifecycle();
    error InvalidCyst();
    error RevisionMismatch(uint64 expected, uint64 actual);
    error NoLiveCyst();

    event CystCommitted(bytes32 indexed agentId, bytes32 indexed cystHash, uint64 sizeBytes,
        bytes32 storageRef, uint64 revision, uint64 committedAt, address indexed agentWallet);
    event CystRetired(bytes32 indexed agentId, bytes32 indexed cystHash, uint64 revision,
        uint64 retiredAt, address indexed agentWallet);

    constructor(address selectionRegistry_) {
        if (selectionRegistry_ == address(0) || selectionRegistry_.code.length == 0) revert InvalidConfiguration();
        PlatformSelectionRegistry registry = PlatformSelectionRegistry(selectionRegistry_);
        address implementation = registry.vaultImplementation();
        address token = address(registry.token());
        address escrow = address(registry.escrow());
        if (implementation.code.length == 0 || token.code.length == 0 || escrow.code.length == 0
            || address(registry.identityRegistry()).code.length == 0 || address(registry.staking()).code.length == 0
            || address(registry.escrow().token()) != token
            || address(PlatformAgentVault(implementation).registry()) != selectionRegistry_
            || address(PlatformAgentVault(implementation).token()) != token
            || address(PlatformAgentVault(implementation).escrow()) != escrow
            || PlatformAgentVault(implementation).controller() != registry.controller()
            || PlatformAgentVault(implementation).treasury() != registry.treasury()) revert InvalidConfiguration();
        selectionRegistry = registry;
    }

    /// @notice Last-write-wins spec entrypoint. Call commitChecked when a plan
    /// must remain bound to the checkpoint revision observed by its caller.
    function commit(bytes32 agentId, bytes32 cystHash, uint64 sizeBytes, bytes32 storageRef) external {
        _commit(agentId, cystHash, sizeBytes, storageRef, false, 0);
    }

    function commitChecked(bytes32 agentId, bytes32 cystHash, uint64 sizeBytes, bytes32 storageRef,
        uint64 expectedRevision) external
    {
        _commit(agentId, cystHash, sizeBytes, storageRef, true, expectedRevision);
    }

    /// @notice Unknown agents and agents without a checkpoint return the zero
    /// tuple. A retired checkpoint retains its ciphertext hash and locator.
    function latest(bytes32 agentId) external view returns (Cyst memory) {
        return cysts[agentId];
    }

    /// @notice Last-write-wins spec entrypoint. Repeating retire without a live
    /// checkpoint reverts; a later commit starts a new live revision.
    function retire(bytes32 agentId) external {
        _retire(agentId, false, 0);
    }

    function retireChecked(bytes32 agentId, uint64 expectedRevision) external {
        _retire(agentId, true, expectedRevision);
    }

    function _commit(bytes32 agentId, bytes32 cystHash, uint64 sizeBytes, bytes32 storageRef,
        bool checked, uint64 expectedRevision) private
    {
        _authorize(agentId, true);
        Cyst storage cyst = cysts[agentId];
        if (checked && cyst.revision != expectedRevision) revert RevisionMismatch(expectedRevision, cyst.revision);
        if (cystHash == bytes32(0) || storageRef == bytes32(0) || sizeBytes == 0 || sizeBytes > MAX_CYST_BYTES) revert InvalidCyst();
        uint64 revision = cyst.revision + 1;
        uint64 committedAt = uint64(block.timestamp);
        cysts[agentId] = Cyst(cystHash, sizeBytes, storageRef, revision, committedAt, false);
        emit CystCommitted(agentId, cystHash, sizeBytes, storageRef, revision, committedAt, msg.sender);
    }

    function _retire(bytes32 agentId, bool checked, uint64 expectedRevision) private {
        _authorize(agentId, false);
        Cyst storage cyst = cysts[agentId];
        if (checked && cyst.revision != expectedRevision) revert RevisionMismatch(expectedRevision, cyst.revision);
        if (cyst.revision == 0 || cyst.retired) revert NoLiveCyst();
        cyst.revision += 1;
        cyst.retired = true;
        emit CystRetired(agentId, cyst.cystHash, cyst.revision, uint64(block.timestamp), msg.sender);
    }

    function _authorize(bytes32 agentId, bool committing) private view {
        PlatformSelectionRegistry.Agent memory agent = selectionRegistry.getAgent(agentId);
        if (agent.status == PlatformSelectionRegistry.Status.None || agent.agentWallet == address(0)
            || agent.vault == address(0)) revert InvalidAgent();
        if (msg.sender != agent.agentWallet) revert Unauthorized();
        // Freeze, dormancy and a killed Leash restrict compute, not preservation.
        // Death prevents new checkpoints but keeps the agent's retirement right.
        if (committing && agent.status == PlatformSelectionRegistry.Status.Dead) revert InvalidLifecycle();
    }
}
