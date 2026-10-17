// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Disposable executor used only to exercise the unmodified official
/// Manager's direct account-approved path. This is not a Base smart account,
/// ERC-4337 entrypoint, ERC-6492 validator, or production account implementation.
contract TestSpendFundingAccount {
    address public immutable owner;
    address public immutable manager;
    constructor(address owner_, address manager_) { owner = owner_; manager = manager_; }
    function execute(address target, uint256 value, bytes calldata data) external payable {
        require(msg.sender == owner || msg.sender == manager, "executor authority");
        (bool success, bytes memory result) = target.call{value: value}(data);
        if (!success) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
    }
    receive() external payable {}
}
