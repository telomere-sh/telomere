// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Utility staking only: no return, yield, income or compute balance.
contract TlmrStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint64 public constant UNSTAKE_DELAY = 14 days;
    uint64 public constant MAX_GRACE_EXTENSION = 30 days;
    uint256 public constant FULL_GRACE_STAKE = 1_000 ether;
    IERC20 public immutable token;
    struct Position { uint256 active; uint256 queued; uint64 withdrawAt; }
    mapping(address => mapping(bytes32 => Position)) public positions;
    mapping(address => uint256) public activeByOwner;
    mapping(bytes32 => uint256) public activeByAgent;
    uint256 public totalActive;
    uint256 public totalCustodied;
    error InvalidConfiguration();
    error InvalidStake();
    error UnstakeUnavailable();
    error UnsupportedToken();
    event Staked(address indexed owner, bytes32 indexed agentId, uint256 amount);
    event UnstakeRequested(address indexed owner, bytes32 indexed agentId, uint256 amount, uint64 withdrawAt);
    event Unstaked(address indexed owner, bytes32 indexed agentId, uint256 amount);

    constructor(address token_) {
        if (token_ == address(0) || token_.code.length == 0 || IERC20Metadata(token_).decimals() != 18) {
            revert InvalidConfiguration();
        }
        token = IERC20(token_);
    }

    function stake(bytes32 agentId, uint256 amount) external nonReentrant {
        if (agentId == bytes32(0) || amount == 0) revert InvalidStake();
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedToken();
        positions[msg.sender][agentId].active += amount;
        activeByOwner[msg.sender] += amount; activeByAgent[agentId] += amount;
        totalActive += amount; totalCustodied += amount;
        emit Staked(msg.sender, agentId, amount);
    }

    /// @notice Queuing more resets the delay for this position's entire queue.
    /// Queued tokens immediately stop contributing to grace or priority.
    function requestUnstake(bytes32 agentId, uint256 amount) external {
        Position storage position = positions[msg.sender][agentId];
        if (amount == 0 || amount > position.active) revert InvalidStake();
        position.active -= amount; position.queued += amount;
        position.withdrawAt = uint64(block.timestamp + UNSTAKE_DELAY);
        activeByOwner[msg.sender] -= amount; activeByAgent[agentId] -= amount; totalActive -= amount;
        emit UnstakeRequested(msg.sender, agentId, amount, position.withdrawAt);
    }

    function withdrawStake(bytes32 agentId) external nonReentrant {
        Position storage position = positions[msg.sender][agentId];
        uint256 amount = position.queued;
        if (amount == 0 || block.timestamp < position.withdrawAt) revert UnstakeUnavailable();
        position.queued = 0; position.withdrawAt = 0; totalCustodied -= amount;
        uint256 beforeSelf = token.balanceOf(address(this)); uint256 beforeRecipient = token.balanceOf(msg.sender);
        token.safeTransfer(msg.sender, amount);
        if (beforeSelf - token.balanceOf(address(this)) != amount || token.balanceOf(msg.sender) - beforeRecipient != amount) {
            revert UnsupportedToken();
        }
        emit Unstaked(msg.sender, agentId, amount);
    }

    function graceExtension(bytes32 agentId) external view returns (uint64) {
        uint256 active = activeByAgent[agentId];
        if (active >= FULL_GRACE_STAKE) return MAX_GRACE_EXTENSION;
        return uint64(active * MAX_GRACE_EXTENSION / FULL_GRACE_STAKE);
    }

    /// @notice Mechanism-only tiers; the router must explicitly apply a discount.
    /// Active stake counts, queued stake does not. No future value is implied.
    function feeDiscountBps(address owner) external view returns (uint16) {
        uint256 holdings = token.balanceOf(owner) + activeByOwner[owner];
        if (holdings >= 100_000 ether) return 300;
        if (holdings >= 10_000 ether) return 200;
        if (holdings >= 1_000 ether) return 100;
        return 0;
    }

    /// @notice A ranking input within one price band, not an admission decision.
    function schedulingWeight(address host, uint32 strikes) external view returns (uint256) {
        return activeByOwner[host] / (uint256(strikes) + 1);
    }
}
