// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Fixed-supply utility token. No faucet, owner mint, proxy or tax.
contract TlmrToken is ERC20 {
    uint256 public immutable fixedSupply;
    error InvalidSupply();

    constructor(address recipient, uint256 supply) ERC20("Telomere", "TLMR") {
        if (recipient == address(0) || supply == 0) revert InvalidSupply();
        fixedSupply = supply;
        _mint(recipient, supply);
    }
}
