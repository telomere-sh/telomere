import {describe, expect, it} from 'vitest';
import {mountContractAddress, resolveContractAddress} from '../website/optional/contract-address/contract-address.js';
import config from '../website/optional/contract-address/config.json' with {type:'json'};

describe('published contract address configuration', () => {
  it('publishes exactly the address explicitly approved by the owner', () => {
    const address='0xb200000000000000000000896858dec29c10fc01';
    expect(config).toEqual({enabled:true,address});
    expect(resolveContractAddress(config)).toEqual({address,explorerUrl:'https://basescan.org/address/'+address});
  });
  it('does not touch the DOM when hidden or missing a valid address', () => {
    // Any DOM access on this deliberately empty target would throw.
    const target = Object.freeze({}) as HTMLElement;
    expect(mountContractAddress(target,{enabled:false,address:'0x'+'1'.repeat(40)})).toBeNull();
    expect(mountContractAddress(target,{enabled:true,address:null})).toBeNull();
  });
  it.each([null,'','0x'+'0'.repeat(40),'0x123','https://attacker.invalid/','0x'+'1'.repeat(40)+'<script>'])('does not publish an invalid identity %s', address => {
    expect(resolveContractAddress({enabled:true,address})).toBeNull();
  });
  it('pins the explorer host and keeps the supplied address intact', () => {
    const address='0xA67c6a174409B9b44e67D24cdd386a31D44Edb1d';
    expect(resolveContractAddress({enabled:true,address:' '+address+' '})).toEqual({address,explorerUrl:'https://basescan.org/address/'+address});
    expect(resolveContractAddress({enabled:false,address})).toBeNull();
  });
});
