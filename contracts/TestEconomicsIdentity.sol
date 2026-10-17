// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
/// @notice Local-only identity fixture, never a public identity registry.
contract TestEconomicsIdentity {
    mapping(uint256 => address) public ownerOf;
    constructor() { require(block.chainid == 31337, "local only"); }
    function register(uint256 identityId, address owner) external {
        require(identityId != 0 && owner != address(0) && ownerOf[identityId] == address(0), "invalid identity");
        ownerOf[identityId] = owner;
    }
}
