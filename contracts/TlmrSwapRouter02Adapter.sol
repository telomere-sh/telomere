// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IReviewedSwapRouter02 {
    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Immutable adapter for the Base V3 SwapRouter02 selector (which has no
/// deadline argument). It restores the outer deadline and binds one burner,
/// token pair, pool fee and reviewed underlying router code hash.
contract TlmrSwapRouter02Adapter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    address public immutable executor;
    IReviewedSwapRouter02 public immutable router;
    bytes32 public immutable routerCodeHash;
    IERC20 public immutable paymentToken;
    IERC20 public immutable utilityToken;
    uint24 public immutable poolFee;
    error InvalidConfiguration();
    error InvalidSwap();
    error UnsupportedToken();
    constructor(address router_, bytes32 routerCodeHash_, address executor_, address paymentToken_, address utilityToken_, uint24 poolFee_) {
        if (router_.code.length == 0 || router_.codehash != routerCodeHash_ || executor_ == address(0)
            || paymentToken_.code.length == 0 || utilityToken_.code.length == 0 || paymentToken_ == utilityToken_
            || poolFee_ == 0) revert InvalidConfiguration();
        router = IReviewedSwapRouter02(router_); routerCodeHash = routerCodeHash_; executor = executor_;
        paymentToken = IERC20(paymentToken_); utilityToken = IERC20(utilityToken_); poolFee = poolFee_;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable nonReentrant returns (uint256 amountOut) {
        if (msg.sender != executor || msg.value != 0 || params.tokenIn != address(paymentToken)
            || params.tokenOut != address(utilityToken) || params.fee != poolFee || params.recipient != executor
            || params.amountIn == 0 || params.amountOutMinimum == 0 || params.sqrtPriceLimitX96 != 0
            || params.deadline < block.timestamp || address(router).codehash != routerCodeHash) revert InvalidSwap();
        uint256 beforePayment = paymentToken.balanceOf(address(this)); uint256 beforeOutput = utilityToken.balanceOf(executor);
        paymentToken.safeTransferFrom(executor, address(this), params.amountIn);
        if (paymentToken.balanceOf(address(this)) - beforePayment != params.amountIn) revert UnsupportedToken();
        paymentToken.forceApprove(address(router), params.amountIn);
        amountOut = router.exactInputSingle(IReviewedSwapRouter02.ExactInputSingleParams({ tokenIn: address(paymentToken),
            tokenOut: address(utilityToken), fee: poolFee, recipient: executor, amountIn: params.amountIn,
            amountOutMinimum: params.amountOutMinimum, sqrtPriceLimitX96: 0 }));
        paymentToken.forceApprove(address(router), 0);
        if (paymentToken.balanceOf(address(this)) != beforePayment || amountOut < params.amountOutMinimum
            || utilityToken.balanceOf(executor) - beforeOutput != amountOut) revert UnsupportedToken();
    }
}
