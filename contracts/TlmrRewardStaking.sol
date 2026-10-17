// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IStakerFeeRouter {
    function token() external view returns (address);
    function stakers() external view returns (address);
    function claimBucket(uint64 week, uint8 which) external;
    function economicsVersion() external view returns (uint16);
}

/// @notice Optional economics-v2 utility staking with exact weekly protocol-fee payouts.
contract TlmrRewardStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint64 public constant UNSTAKE_DELAY = 14 days;
    uint64 public constant MAX_GRACE_EXTENSION = 30 days;
    uint256 public constant FULL_GRACE_STAKE = 1_000 ether;
    // Bounds the lifetime token-second integral over the complete uint64 clock,
    // so even an unusually large fixed supply cannot trap stake on checkpoint.
    uint256 public constant MAX_CUSTODIED_STAKE = (type(uint256).max - 1) / type(uint64).max;
    IERC20 public immutable token;
    IERC20 public immutable paymentToken;
    IStakerFeeRouter public immutable feeRouter;
    bytes32 public immutable feeRouterCodeHash;
    // integral stores cumulative token-seconds + 1. Its nonzero storage cost
    // remains stable if the pending transaction lands one second after estimate.
    struct StakePoint { uint64 timestamp; uint256 active; uint256 integral; }
    struct RewardWeek { uint256 budget; uint256 totalStakeSeconds; uint256 claimed; bool funded; }
    mapping(address => StakePoint[]) private ownerHistory;
    StakePoint[] private totalHistory;
    mapping(uint64 => RewardWeek) public rewardWeeks;
    mapping(uint64 => mapping(address => bool)) public rewardClaimed;
    uint256 public accountedRewards;
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
    event RewardsFunded(uint64 indexed week, uint256 budget, uint256 totalStakeSeconds);
    event RewardClaimed(uint64 indexed week, address indexed owner, uint256 stakeSeconds, uint256 amount);

    constructor(address token_, address paymentToken_, address feeRouter_, bytes32 feeRouterCodeHash_) {
        if (token_ == address(0) || token_.code.length == 0 || IERC20Metadata(token_).decimals() != 18) {
            revert InvalidConfiguration();
        }
        token = IERC20(token_);
        if (paymentToken_ == token_ || paymentToken_.code.length == 0 || IERC20Metadata(paymentToken_).decimals() != 6
            || feeRouter_.code.length == 0 || feeRouter_.codehash != feeRouterCodeHash_
            || IStakerFeeRouter(feeRouter_).economicsVersion() != 2
            || IStakerFeeRouter(feeRouter_).token() != paymentToken_ || IStakerFeeRouter(feeRouter_).stakers() != address(this)) {
            revert InvalidConfiguration();
        }
        paymentToken = IERC20(paymentToken_); feeRouter = IStakerFeeRouter(feeRouter_); feeRouterCodeHash = feeRouterCodeHash_;
        _checkpoint(totalHistory, 0);
    }

    function stake(bytes32 agentId, uint256 amount) external nonReentrant {
        if (agentId == bytes32(0) || amount == 0 || amount > MAX_CUSTODIED_STAKE - totalCustodied) revert InvalidStake();
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedToken();
        positions[msg.sender][agentId].active += amount;
        activeByOwner[msg.sender] += amount; activeByAgent[agentId] += amount;
        totalActive += amount; totalCustodied += amount;
        _checkpoint(ownerHistory[msg.sender], activeByOwner[msg.sender]); _checkpoint(totalHistory, totalActive);
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
        _checkpoint(ownerHistory[msg.sender], activeByOwner[msg.sender]); _checkpoint(totalHistory, totalActive);
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

    /// @notice Fee rewards depend on the stake integral over the full closed
    /// week. Same-block stake/unstake contributes zero; queued stake stops now.
    function stakeSeconds(address owner, uint64 week) public view returns (uint256) {
        uint256 start = uint256(week) * 1 weeks; uint256 end = start + 1 weeks;
        if (end > block.timestamp) revert UnstakeUnavailable();
        return _integralAt(ownerHistory[owner], end) - _integralAt(ownerHistory[owner], start);
    }

    function totalStakeSeconds(uint64 week) public view returns (uint256) {
        uint256 start = uint256(week) * 1 weeks; uint256 end = start + 1 weeks;
        if (end > block.timestamp) revert UnstakeUnavailable();
        return _integralAt(totalHistory, end) - _integralAt(totalHistory, start);
    }

    function fundWeek(uint64 week) external nonReentrant {
        if (rewardWeeks[week].funded || address(feeRouter).codehash != feeRouterCodeHash) revert UnstakeUnavailable();
        uint256 weight = totalStakeSeconds(week);
        if (weight == 0) revert UnstakeUnavailable();
        uint256 beforeBalance = paymentToken.balanceOf(address(this));
        feeRouter.claimBucket(week, 2);
        uint256 budget = paymentToken.balanceOf(address(this)) - beforeBalance;
        if (budget == 0) revert UnstakeUnavailable();
        rewardWeeks[week] = RewardWeek(budget, weight, 0, true); accountedRewards += budget;
        emit RewardsFunded(week, budget, weight);
    }

    function claimReward(uint64 week) external nonReentrant {
        RewardWeek storage reward = rewardWeeks[week];
        if (!reward.funded || rewardClaimed[week][msg.sender]) revert UnstakeUnavailable();
        uint256 weight = stakeSeconds(msg.sender, week);
        uint256 amount = Math.mulDiv(reward.budget, weight, reward.totalStakeSeconds);
        if (amount == 0 || reward.claimed + amount > reward.budget) revert UnstakeUnavailable();
        rewardClaimed[week][msg.sender] = true; reward.claimed += amount; accountedRewards -= amount;
        uint256 beforeSelf = paymentToken.balanceOf(address(this)); uint256 beforeRecipient = paymentToken.balanceOf(msg.sender);
        paymentToken.safeTransfer(msg.sender, amount);
        if (beforeSelf - paymentToken.balanceOf(address(this)) != amount
            || paymentToken.balanceOf(msg.sender) - beforeRecipient != amount) revert UnsupportedToken();
        emit RewardClaimed(week, msg.sender, weight, amount);
    }

    function _checkpoint(StakePoint[] storage history, uint256 active) private {
        uint64 timestamp = uint64(block.timestamp); uint256 integral;
        if (history.length != 0) {
            StakePoint storage previous = history[history.length - 1];
            integral = previous.integral - 1 + previous.active * (timestamp - previous.timestamp);
        }
        // Retain same-second points too: the binary search selects the final
        // active value. Compression would estimate a cheap overwrite then mine
        // an expensive push at a second boundary, risking an out-of-gas unstake.
        history.push(StakePoint(timestamp, active, integral + 1));
    }

    function _integralAt(StakePoint[] storage history, uint256 timestamp) private view returns (uint256) {
        if (history.length == 0 || timestamp < history[0].timestamp) return 0;
        uint256 low; uint256 high = history.length;
        while (low + 1 < high) {
            uint256 middle = (low + high) / 2;
            if (history[middle].timestamp <= timestamp) low = middle; else high = middle;
        }
        StakePoint storage point = history[low];
        return point.integral - 1 + point.active * (timestamp - point.timestamp);
    }
}
