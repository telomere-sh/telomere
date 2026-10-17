// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IBurnFeeRouter {
    function token() external view returns (address);
    function buyAndBurn() external view returns (address);
    function economicsVersion() external view returns (uint16);
    function claimBucket(uint64 week, uint8 which) external;
}
interface IBurnableUtilityToken is IERC20 { function burn(uint256 amount) external; }
interface IReviewedV3Router {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Optional v2 fee recipient, restricted to one reviewed exact-input V3
/// route. This does not create liquidity or approve an economic price policy.
contract TlmrBuyAndBurn is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;
    struct Config {
        address paymentToken; address utilityToken; address feeRouter; bytes32 feeRouterCodeHash;
        address swapRouter; bytes32 swapRouterCodeHash; address quoteSigner; uint24 poolFee;
        uint96 maxPerSwap; uint96 maxPerWeek; uint64 maxQuoteLifetime;
    }
    struct BurnQuote { bytes32 operationId; uint64 week; uint96 amountIn; uint256 minAmountOut; uint64 validAfter; uint64 deadline; }
    struct BurnWeek { uint256 funded; uint256 spent; bool fundingRecorded; }
    bytes32 public constant BURN_QUOTE_TYPEHASH = keccak256(
        "BurnQuote(bytes32 operationId,uint64 week,uint96 amountIn,uint256 minAmountOut,uint64 validAfter,uint64 deadline)"
    );
    IERC20 public immutable paymentToken;
    IBurnableUtilityToken public immutable utilityToken;
    IBurnFeeRouter public immutable feeRouter;
    bytes32 public immutable feeRouterCodeHash;
    IReviewedV3Router public immutable swapRouter;
    bytes32 public immutable swapRouterCodeHash;
    address public immutable quoteSigner;
    uint24 public immutable poolFee;
    uint96 public immutable maxPerSwap;
    uint96 public immutable maxPerWeek;
    uint64 public immutable maxQuoteLifetime;
    uint256 public accountedPayment;
    mapping(uint64 => BurnWeek) public burnWeeks;
    mapping(bytes32 => bool) public executedOperation;
    error InvalidConfiguration();
    error InvalidQuote();
    error Unavailable();
    error UnsupportedToken();
    event BurnWeekFunded(uint64 indexed week, uint256 amount);
    event BoughtAndBurned(bytes32 indexed operationId, uint64 indexed week, uint96 paymentAmount, uint256 utilityAmount, bytes32 quoteDigest);

    constructor(Config memory config) EIP712("TelomereBuyAndBurn", "1") {
        if (config.paymentToken.code.length == 0 || IERC20Metadata(config.paymentToken).decimals() != 6
            || config.utilityToken.code.length == 0 || IERC20Metadata(config.utilityToken).decimals() != 18
            || config.paymentToken == config.utilityToken || config.feeRouter.code.length == 0
            || config.feeRouter.codehash != config.feeRouterCodeHash || config.swapRouter.code.length == 0
            || config.swapRouter.codehash != config.swapRouterCodeHash || config.quoteSigner == address(0)
            || config.poolFee == 0 || config.maxPerSwap == 0 || config.maxPerWeek < config.maxPerSwap
            || config.maxQuoteLifetime == 0 || IBurnFeeRouter(config.feeRouter).token() != config.paymentToken
            || IBurnFeeRouter(config.feeRouter).buyAndBurn() != address(this)
            || IBurnFeeRouter(config.feeRouter).economicsVersion() != 2) revert InvalidConfiguration();
        paymentToken = IERC20(config.paymentToken); utilityToken = IBurnableUtilityToken(config.utilityToken);
        feeRouter = IBurnFeeRouter(config.feeRouter); feeRouterCodeHash = config.feeRouterCodeHash;
        swapRouter = IReviewedV3Router(config.swapRouter); swapRouterCodeHash = config.swapRouterCodeHash;
        quoteSigner = config.quoteSigner; poolFee = config.poolFee; maxPerSwap = config.maxPerSwap;
        maxPerWeek = config.maxPerWeek; maxQuoteLifetime = config.maxQuoteLifetime;
    }

    function fundWeek(uint64 week) external nonReentrant {
        if (burnWeeks[week].fundingRecorded || address(feeRouter).codehash != feeRouterCodeHash) revert Unavailable();
        uint256 beforeBalance = paymentToken.balanceOf(address(this));
        feeRouter.claimBucket(week, 3);
        uint256 amount = paymentToken.balanceOf(address(this)) - beforeBalance;
        if (amount == 0) revert Unavailable();
        burnWeeks[week] = BurnWeek(amount, 0, true); accountedPayment += amount;
        emit BurnWeekFunded(week, amount);
    }

    function quoteDigest(BurnQuote calldata quote) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(BURN_QUOTE_TYPEHASH, quote)));
    }

    /// @notice Anyone can execute the exact approved quote. Immutable pair/route,
    /// exact temporary allowance, min-output, short expiry and both budgets apply.
    /// Operation replay protection and swap + supply burn are one atomic tx.
    function execute(BurnQuote calldata quote, bytes calldata signature) external nonReentrant {
        BurnWeek storage week = burnWeeks[quote.week]; bytes32 digest = quoteDigest(quote);
        if (quote.operationId == bytes32(0) || executedOperation[quote.operationId] || quote.amountIn == 0
            || quote.amountIn > maxPerSwap || quote.minAmountOut == 0 || quote.validAfter > block.timestamp
            || quote.deadline < block.timestamp || quote.deadline <= quote.validAfter
            || quote.deadline - quote.validAfter > maxQuoteLifetime || ECDSA.recover(digest, signature) != quoteSigner
            || !week.fundingRecorded || week.spent + quote.amountIn > week.funded
            || week.spent + quote.amountIn > maxPerWeek || address(swapRouter).codehash != swapRouterCodeHash) revert InvalidQuote();
        executedOperation[quote.operationId] = true; week.spent += quote.amountIn; accountedPayment -= quote.amountIn;
        uint256 paymentBefore = paymentToken.balanceOf(address(this));
        uint256 utilityBefore = utilityToken.balanceOf(address(this));
        paymentToken.forceApprove(address(swapRouter), quote.amountIn);
        uint256 bought = swapRouter.exactInputSingle(IReviewedV3Router.ExactInputSingleParams({
            tokenIn: address(paymentToken), tokenOut: address(utilityToken), fee: poolFee, recipient: address(this),
            deadline: quote.deadline, amountIn: quote.amountIn, amountOutMinimum: quote.minAmountOut, sqrtPriceLimitX96: 0
        }));
        paymentToken.forceApprove(address(swapRouter), 0);
        if (paymentBefore - paymentToken.balanceOf(address(this)) != quote.amountIn || bought < quote.minAmountOut
            || utilityToken.balanceOf(address(this)) - utilityBefore != bought) revert UnsupportedToken();
        uint256 supplyBefore = utilityToken.totalSupply(); utilityToken.burn(bought);
        if (utilityToken.totalSupply() != supplyBefore - bought || utilityToken.balanceOf(address(this)) != utilityBefore) {
            revert UnsupportedToken();
        }
        emit BoughtAndBurned(quote.operationId, quote.week, quote.amountIn, bought, digest);
    }
}
