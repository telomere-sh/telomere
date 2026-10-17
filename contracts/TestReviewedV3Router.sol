// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
/// @notice Deterministic local-only fixture. This is not a public DEX deployment.
contract TestReviewedV3Router {
    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    struct ExactInputSingleParams02 { address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    uint8 public failureMode;
    uint256 public swaps;
    constructor() { require(block.chainid == 31337, "local only"); }
    function setFailureMode(uint8 mode) external { failureMode = mode; }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        require(block.timestamp <= params.deadline && params.fee == 3000 && msg.value == 0, "wrong route");
        require(failureMode != 1, "local swap rejection");
        uint256 spent = failureMode == 2 ? params.amountIn - 1 : params.amountIn;
        require(IERC20(params.tokenIn).transferFrom(msg.sender, address(this), spent), "payment failed");
        amountOut = params.amountIn * 1e12;
        require(amountOut >= params.amountOutMinimum, "minimum output");
        require(IERC20(params.tokenOut).transfer(params.recipient, amountOut), "output failed");
        swaps++;
        if (failureMode == 3) amountOut++;
    }
    function exactInputSingle(ExactInputSingleParams02 calldata params) external payable returns (uint256 amountOut) {
        require(params.fee == 3000 && msg.value == 0, "wrong route"); require(failureMode != 1, "local swap rejection");
        uint256 spent = failureMode == 2 ? params.amountIn - 1 : params.amountIn;
        require(IERC20(params.tokenIn).transferFrom(msg.sender, address(this), spent), "payment failed");
        amountOut = params.amountIn * 1e12; require(amountOut >= params.amountOutMinimum, "minimum output");
        require(IERC20(params.tokenOut).transfer(params.recipient, amountOut), "output failed"); swaps++;
        if (failureMode == 3) amountOut++;
    }
}
