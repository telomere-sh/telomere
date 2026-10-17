// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Distinct disposable receive-capable ERC3009 fixture; not production USDC.
contract LocalReceiveToken is ERC20,EIP712 {
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    mapping(address=>mapping(bytes32=>bool)) public authorizationState;
    event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer,bytes32 indexed nonce);
    constructor() ERC20("Local Receive Fixture","LRCV") EIP712("Local Receive Fixture","1") { require(block.chainid==31337); }
    function decimals() public pure override returns(uint8) { return 6; }
    function faucet(address to,uint256 amount) external { _mint(to,amount); }
    function DOMAIN_SEPARATOR() external view returns(bytes32) { return _domainSeparatorV4(); }
    function receiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s) external {
        require(msg.sender==to,"receive payee"); _use(RECEIVE_WITH_AUTHORIZATION_TYPEHASH,from,to,value,validAfter,validBefore,nonce,v,r,s);
    }
    function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s) external {
        _use(TRANSFER_WITH_AUTHORIZATION_TYPEHASH,from,to,value,validAfter,validBefore,nonce,v,r,s);
    }
    function cancelAuthorization(address authorizer,bytes32 nonce,uint8 v,bytes32 r,bytes32 s) external {
        require(!authorizationState[authorizer][nonce],"used");
        bytes32 tag=keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");
        require(ECDSA.recover(_hashTypedDataV4(keccak256(abi.encode(tag,authorizer,nonce))),v,r,s)==authorizer,"signer");
        authorizationState[authorizer][nonce]=true; emit AuthorizationCanceled(authorizer,nonce);
    }
    function _use(bytes32 tag,address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s) private {
        require(block.timestamp>validAfter && block.timestamp<validBefore,"time"); require(!authorizationState[from][nonce],"used");
        require(ECDSA.recover(_hashTypedDataV4(keccak256(abi.encode(tag,from,to,value,validAfter,validBefore,nonce))),v,r,s)==from,"signer");
        authorizationState[from][nonce]=true; emit AuthorizationUsed(from,nonce); _transfer(from,to,value);
    }
}
