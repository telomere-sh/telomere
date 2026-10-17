import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import solc from 'solc';
import type { Abi, Hex } from 'viem';
import { projectRoot } from '../scripts/compile-contracts.js';

export type ReputationPublisherFixtureArtifact = { abi: Abi; bytecode: Hex };
export function compileSelectionReputationPublisherFixture(): Record<string, ReputationPublisherFixtureArtifact> {
  const paths = ['contracts/SelectionRegistry.sol', 'contracts/AgentVault.sol', 'contracts/TelomereRunEscrow.sol', 'contracts/MockToken.sol'];
  const source = 'tests/ReputationPublicationFixture.sol';
  const sources = { ...Object.fromEntries(paths.map(path => [path, { content: readFileSync(resolve(projectRoot, path), 'utf8') }])),
    [source]: { content: `pragma solidity ^0.8.28;
      contract PublisherIdentityFixture {
        mapping(uint256=>address) public ownerOf; mapping(uint256=>address) public getApproved;
        mapping(address=>mapping(address=>bool)) public isApprovedForAll;
        function register(uint256 id,address owner) external { require(block.chainid==31337 && ownerOf[id]==address(0)); ownerOf[id]=owner; }
        function transfer(uint256 id,address nextOwner) external { require(block.chainid==31337 && msg.sender==ownerOf[id] && nextOwner!=address(0)); ownerOf[id]=nextOwner; getApproved[id]=address(0); }
        function approve(address operator,uint256 id) external { require(msg.sender==ownerOf[id]); getApproved[id]=operator; }
        function setApprovalForAll(address operator,bool value) external { isApprovedForAll[msg.sender][operator]=value; }
      }
      contract PublisherIdentityFixtureV2 is PublisherIdentityFixture { function revisionMarker() external pure returns(uint256) { return 2; } }
      contract Publisher1967ProxyFixture {
        bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
        address private immutable upgradeAdmin;
        constructor(address implementation) {
          require(block.chainid==31337 && implementation.code.length>0); upgradeAdmin=msg.sender;
          assembly { sstore(IMPLEMENTATION_SLOT, implementation) }
        }
        function upgradeTo(address implementation) external {
          require(block.chainid==31337 && msg.sender==upgradeAdmin && implementation.code.length>0);
          assembly { sstore(IMPLEMENTATION_SLOT, implementation) }
        }
        fallback() external payable {
          assembly {
            let implementation := sload(IMPLEMENTATION_SLOT)
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result case 0 { revert(0, returndatasize()) } default { return(0, returndatasize()) }
          }
        }
      }
      contract PublisherGraceFixture { function graceExtension(bytes32) external view returns(uint64) { require(block.chainid==31337); return 0; } }
      // A disposable exact-ABI semantics fixture, not an upstream ERC-8004 implementation.
      contract PublisherReputationFixture {
        struct Feedback { int128 value; uint8 decimals; string tag1; string tag2; bool revoked; }
        PublisherIdentityFixture public immutable identity; uint256 public count; uint256 public revocations; uint8 public mode;
        mapping(uint256=>mapping(address=>uint64)) private last;
        mapping(uint256=>mapping(address=>mapping(uint64=>Feedback))) private entries;
        event NewFeedback(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,int128 value,uint8 valueDecimals,
          string indexed indexedTag1,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash);
        event FeedbackRevoked(uint256 indexed agentId,address indexed clientAddress,uint64 indexed feedbackIndex);
        constructor(address target) { identity=PublisherIdentityFixture(target); }
        function getIdentityRegistry() external view returns(address) { return address(identity); }
        function setMode(uint8 value) external { require(block.chainid==31337); mode=value; }
        function getLastIndex(uint256 agentId,address client) external view returns(uint64) { return last[agentId][client]; }
        function readFeedback(uint256 agentId,address client,uint64 index) external view returns(int128,uint8,string memory,string memory,bool) {
          require(index>0 && index<=last[agentId][client]); Feedback storage f=entries[agentId][client][index];
          return(mode==2 ? f.value+1 : f.value,f.decimals,f.tag1,f.tag2,f.revoked);
        }
        function giveFeedback(uint256 agentId,int128 value,uint8 decimals,string calldata tag1,string calldata tag2,
          string calldata endpoint,string calldata uri,bytes32 digest) external {
          address owner=identity.ownerOf(agentId); require(owner!=address(0) && msg.sender!=owner && identity.getApproved(agentId)!=msg.sender
            && !identity.isApprovedForAll(owner,msg.sender) && decimals<=18);
          uint64 index=++last[agentId][msg.sender]; entries[agentId][msg.sender][index]=Feedback(value,decimals,tag1,tag2,false); count++;
          emit NewFeedback(agentId,msg.sender,index,value,decimals,tag1,tag1,tag2,endpoint,uri,mode==1 ? bytes32(uint256(7)) : digest);
        }
        function revokeFeedback(uint256 agentId,uint64 index) external {
          require(index>0 && index<=last[agentId][msg.sender]); Feedback storage f=entries[agentId][msg.sender][index];
          require(!f.revoked); f.revoked=true; revocations++; emit FeedbackRevoked(agentId,msg.sender,index);
        }
      }
      contract PublisherReputationFixtureV2 is PublisherReputationFixture {
        constructor(address target) PublisherReputationFixture(target) {}
        function revisionMarker() external pure returns(uint256) { return 2; }
      }` } };
  // REASON: solc's JSON output is checked for compilation errors before artifact use.
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: { viaIR: true, optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }), {
    import: (path: string) => path.startsWith('@openzeppelin/contracts/') && !path.includes('..')
      ? { contents: readFileSync(resolve(projectRoot, 'node_modules', path), 'utf8') } : { error: 'Unsupported import' },
  })) as { errors?: { severity: string; formattedMessage: string }[]; contracts: Record<string, Record<string,
    { abi: Abi; evm: { bytecode: { object: string } } }>> };
  const errors = output.errors?.filter(value => value.severity === 'error') ?? [];
  if (errors.length) throw new Error(errors.map(value => value.formattedMessage).join('\n'));
  return Object.fromEntries(Object.values(output.contracts).flatMap(values => Object.entries(values).map(([name, value]) =>
    // REASON: solc emits hexadecimal bytecode; an actual Anvil deployment validates it.
    [name, { abi: value.abi, bytecode: ('0x' + value.evm.bytecode.object) as Hex }])));
}
