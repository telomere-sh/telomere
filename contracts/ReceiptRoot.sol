// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @notice Fixed governance schedules each future UTC epoch week once. Deploy
/// governance as the reviewed timelock; there is no proxy or emergency signer.
contract SignerSet {
    address public immutable governance;
    mapping(uint64 => address) public weeklySigner;
    error Unauthorized();
    error InvalidSchedule();
    event SignerScheduled(uint64 indexed week, address indexed signer);

    constructor(address governance_, address initialSigner) {
        if (governance_ == address(0) || initialSigner == address(0)) revert InvalidSchedule();
        governance = governance_;
        uint64 week = uint64(block.timestamp / 1 weeks);
        weeklySigner[week] = initialSigner;
        emit SignerScheduled(week, initialSigner);
    }

    function scheduleSigner(uint64 week, address signer) external {
        if (msg.sender != governance) revert Unauthorized();
        if (week <= block.timestamp / 1 weeks || signer == address(0) || weeklySigner[week] != address(0)) {
            revert InvalidSchedule();
        }
        weeklySigner[week] = signer;
        emit SignerScheduled(week, signer);
    }

    function currentSigner() external view returns (address) {
        return weeklySigner[uint64(block.timestamp / 1 weeks)];
    }
}

/// @notice One immutable sorted-pair Merkle commitment per closed Unix hour.
/// Root inclusion attests to the publisher's commitment, not computation truth.
contract ReceiptRoot {
    SignerSet public immutable signerSet;
    struct Root { bytes32 root; uint32 count; address signer; uint64 postedAt; }
    mapping(uint64 => Root) private roots;
    error Unauthorized();
    error InvalidRoot();
    event RootPosted(uint64 indexed hour, bytes32 indexed root, uint32 count, address indexed signer);

    constructor(address signerSet_) {
        if (signerSet_ == address(0) || signerSet_.code.length == 0) revert InvalidRoot();
        signerSet = SignerSet(signerSet_);
    }

    function postRoot(uint64 hour, bytes32 root, uint32 count) external {
        if (msg.sender != signerSet.currentSigner()) revert Unauthorized();
        if (hour >= block.timestamp / 1 hours || root == bytes32(0) || count == 0
            || roots[hour].root != bytes32(0)) revert InvalidRoot();
        roots[hour] = Root(root, count, msg.sender, uint64(block.timestamp));
        emit RootPosted(hour, root, count, msg.sender);
    }

    function getRoot(uint64 hour) external view returns (Root memory) { return roots[hour]; }

    function verify(bytes32 leaf, bytes32[] calldata proof, uint64 hour) external view returns (bool) {
        bytes32 root = roots[hour].root;
        return root != bytes32(0) && MerkleProof.verifyCalldata(proof, root, leaf);
    }
}
