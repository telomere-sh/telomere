// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Adversarial ERC-20 fixture, restricted to disposable local EVMs.
contract TestAdversarialToken is ERC20 {
    bool public immutable feeMode;
    address public attackTarget;
    bytes public attackData;
    bool public reentrySucceeded;
    constructor(bool feeMode_) ERC20("Adversarial Test Token", "EVILTEST") {
        require(block.chainid == 31337 || block.chainid == 1337, "local chain only");
        feeMode = feeMode_;
    }
    function decimals() public pure override returns (uint8) { return 6; }
    function faucet(address to, uint256 amount) external { _mint(to, amount); }
    function configureAttack(address target, bytes calldata data) external { attackTarget = target; attackData = data; }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (attackTarget != address(0)) (reentrySucceeded,) = attackTarget.call(attackData);
        bool result = super.transferFrom(from, to, amount);
        if (feeMode && amount > 0) _burn(to, 1);
        return result;
    }
}
