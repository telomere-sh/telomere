// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Disposable local-chain fixture only. Deployment is blocked off local
/// chains. This faucet is never a funding path for a public-chain pilot.
contract MockToken is ERC20 {
    constructor() ERC20("Local Pilot Dollar", "TESTUSD") {
        require(block.chainid == 31337 || block.chainid == 1337, "local chain only");
    }
    function decimals() public pure override returns (uint8) { return 6; }
    function faucet(address to, uint256 amount) external { _mint(to, amount); }
}
