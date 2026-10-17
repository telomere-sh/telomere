// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @notice Add-on fees preserve the host's full posted price. Six-decimal token,
/// immutable roles/rates/recipients, exact transfers, closed-week pull payments.
contract FeeRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint16 public constant CELL_FEE_BPS = 900;
    uint16 public constant SEALED_FEE_BPS = 1200;
    IERC20 public immutable token;
    address public immutable controller;
    address public immutable workAllocator;
    address public immutable treasury;
    address public immutable stakers;
    address public immutable buyAndBurn;
    uint256 public accountedBalance;
    struct Buckets { uint256 work; uint256 treasury; uint256 stakers; uint256 buyAndBurn; }
    struct WorkDistribution { bytes32 root; uint256 allocated; uint256 claimed; }
    mapping(uint64 => Buckets) private buckets;
    mapping(uint64 => WorkDistribution) public workDistribution;
    mapping(uint64 => mapping(address => uint256)) public hostAccrued;
    mapping(uint64 => mapping(address => bool)) public workClaimed;
    mapping(bytes32 => bool) public settledReceipt;
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidSettlement();
    error Unavailable();
    error UnsupportedToken();
    event SettlementRecorded(bytes32 indexed receiptId, address indexed host, uint64 indexed week, uint256 hostAmount, uint256 fee);
    event HostClaimed(uint64 indexed week, address indexed host, uint256 amount);
    event BucketClaimed(uint64 indexed week, uint8 indexed bucket, address indexed recipient, uint256 amount);
    event WorkRootPosted(uint64 indexed week, bytes32 indexed root, uint256 allocated);
    event WorkClaimed(uint64 indexed week, address indexed recipient, uint256 amount);

    constructor(address token_, address controller_, address workAllocator_, address treasury_, address stakers_, address buyAndBurn_) {
        if (token_ == address(0) || token_.code.length == 0 || IERC20Metadata(token_).decimals() != 6
            || controller_ == address(0) || workAllocator_ == address(0) || treasury_ == address(0)
            || stakers_ == address(0) || buyAndBurn_ == address(0) || treasury_ == address(this)
            || stakers_ == address(this) || buyAndBurn_ == address(this)) revert InvalidConfiguration();
        token = IERC20(token_); controller = controller_; workAllocator = workAllocator_;
        treasury = treasury_; stakers = stakers_; buyAndBurn = buyAndBurn_;
    }

    function quoteFee(uint96 hostAmount, bool sealedHost) public pure returns (uint256) {
        return (uint256(hostAmount) * (sealedHost ? SEALED_FEE_BPS : CELL_FEE_BPS) + 9_999) / 10_000;
    }

    function recordSettlement(bytes32 receiptId, address host, uint96 hostAmount, bool sealedHost) external nonReentrant {
        if (msg.sender != controller) revert Unauthorized();
        if (receiptId == bytes32(0) || settledReceipt[receiptId] || host == address(0) || host == address(this) || hostAmount == 0) {
            revert InvalidSettlement();
        }
        uint256 fee = quoteFee(hostAmount, sealedHost); uint256 total = uint256(hostAmount) + fee;
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), total);
        if (token.balanceOf(address(this)) - beforeBalance != total) revert UnsupportedToken();
        settledReceipt[receiptId] = true; accountedBalance += total;
        uint64 week = uint64(block.timestamp / 1 weeks); hostAccrued[week][host] += hostAmount;
        Buckets storage bucket = buckets[week];
        uint256 treasuryShare = fee * 10 / 100; uint256 stakerShare = fee * 5 / 100; uint256 burnShare = fee * 5 / 100;
        bucket.treasury += treasuryShare; bucket.stakers += stakerShare; bucket.buyAndBurn += burnShare;
        bucket.work += fee - treasuryShare - stakerShare - burnShare;
        emit SettlementRecorded(receiptId, host, week, hostAmount, fee);
    }

    function getBuckets(uint64 week) external view returns (Buckets memory) { return buckets[week]; }

    function claimHost(uint64 week) external nonReentrant {
        _closed(week); uint256 amount = hostAccrued[week][msg.sender];
        if (amount == 0) revert Unavailable();
        delete hostAccrued[week][msg.sender]; _pay(msg.sender, amount);
        emit HostClaimed(week, msg.sender, amount);
    }

    /// @notice Anyone can trigger fixed-recipient payments, never redirect them.
    function claimBucket(uint64 week, uint8 which) external nonReentrant {
        _closed(week); Buckets storage bucket = buckets[week]; uint256 amount; address recipient;
        if (which == 1) { amount = bucket.treasury; bucket.treasury = 0; recipient = treasury; }
        else if (which == 2) { amount = bucket.stakers; bucket.stakers = 0; recipient = stakers; }
        else if (which == 3) { amount = bucket.buyAndBurn; bucket.buyAndBurn = 0; recipient = buyAndBurn; }
        else revert Unavailable();
        if (amount == 0) revert Unavailable();
        _pay(recipient, amount); emit BucketClaimed(week, which, recipient, amount);
    }

    function postWorkRoot(uint64 week, bytes32 root, uint256 allocated) external {
        if (msg.sender != workAllocator) revert Unauthorized();
        _closed(week);
        if (root == bytes32(0) || allocated == 0 || allocated > buckets[week].work || workDistribution[week].root != bytes32(0)) {
            revert Unavailable();
        }
        workDistribution[week] = WorkDistribution(root, allocated, 0);
        emit WorkRootPosted(week, root, allocated);
    }

    function workLeaf(uint64 week, address recipient, uint256 amount) public view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(this), week, recipient, amount))));
    }

    function claimWork(uint64 week, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        _closed(week); WorkDistribution storage distribution = workDistribution[week];
        if (amount == 0 || workClaimed[week][msg.sender] || distribution.root == bytes32(0)
            || distribution.claimed + amount > distribution.allocated || amount > buckets[week].work
            || !MerkleProof.verifyCalldata(proof, distribution.root, workLeaf(week, msg.sender, amount))) revert Unavailable();
        workClaimed[week][msg.sender] = true; distribution.claimed += amount; buckets[week].work -= amount;
        _pay(msg.sender, amount); emit WorkClaimed(week, msg.sender, amount);
    }

    function _closed(uint64 week) private view {
        if (week >= block.timestamp / 1 weeks) revert Unavailable();
    }

    function _pay(address to, uint256 amount) private {
        accountedBalance -= amount;
        uint256 beforeSelf = token.balanceOf(address(this)); uint256 beforeRecipient = token.balanceOf(to);
        token.safeTransfer(to, amount);
        if (beforeSelf - token.balanceOf(address(this)) != amount || token.balanceOf(to) - beforeRecipient != amount) {
            revert UnsupportedToken();
        }
    }
}
