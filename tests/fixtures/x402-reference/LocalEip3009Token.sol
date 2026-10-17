// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Disposable Anvil-only EIP-3009 compatibility fixture, never a claim about USDG.
contract LocalEip3009Token is ERC20, EIP712 {
    bytes32 private constant TRANSFER_TYPEHASH = keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    constructor() ERC20("Local EIP3009 Fixture", "L3009") EIP712("Local EIP3009 Fixture", "1") {
        require(block.chainid == 31337, "local fixture only");
    }
    function decimals() public pure override returns(uint8) { return 6; }
    function faucet(address to, uint256 amount) external { _mint(to, amount); }
    function DOMAIN_SEPARATOR() external view returns(bytes32) { return _domainSeparatorV4(); }
    function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,
        bytes32 nonce,uint8 v,bytes32 r,bytes32 s) external {
        require(block.timestamp > validAfter && block.timestamp < validBefore, "authorization time");
        require(!authorizationState[from][nonce], "authorization used");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(TRANSFER_TYPEHASH,from,to,value,validAfter,validBefore,nonce)));
        require(ECDSA.recover(digest,v,r,s) == from, "authorization signer");
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from,nonce);
        _transfer(from,to,value);
    }
}
