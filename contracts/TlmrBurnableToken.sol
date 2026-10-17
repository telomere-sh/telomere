// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @notice Explicit new fixed-supply deployment for the economics-v2 profile.
/// Holders may destroy their own tokens; there is no external mint or owner.
contract TlmrBurnableToken is ERC20, ERC20Burnable {
    uint256 public immutable fixedSupply;
    error InvalidSupply();
    constructor(address recipient, uint256 supply) ERC20("Telomere", "TLMR") {
        if (recipient == address(0) || supply == 0) revert InvalidSupply();
        fixedSupply = supply; _mint(recipient, supply);
    }
}
