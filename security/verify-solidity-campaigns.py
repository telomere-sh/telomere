"""Require complete, source-bound independent Solidity campaigns, not a green label."""
from pathlib import Path
import hashlib,json,re,subprocess
ROOT=Path(__file__).resolve().parents[1]
SUITE='solidity-tests/EscrowConservation.t.sol:EscrowConservationInvariantTest'
INVARIANT='invariant_cashAndReservationHistory()'
FUZZ='testFuzzExactUint96ReservationAndSettlement(uint96,uint64)'
TESTS={INVARIANT,FUZZ,'testExactMaxAndOneAtomicUnitBoundaries()',
       'testOracleRejectsForgedPendingReservation()','testOracleRejectsForgedWalletCash()'}
HANDLERS={'advance','create','deposit','kill','open','refund','replay','settle','stop','update','withdraw'}
def require(value,message):
    if not value:raise ValueError(message)
def pairs(items):
    result={}
    for name,value in items:
        require(name not in result,'Duplicate JSON key');result[name]=value
    return result
def parse(text):return json.loads(text,object_pairs_hook=pairs,parse_constant=lambda value:(_ for _ in ()).throw(ValueError('Non-finite JSON')))
def integer(value):return type(value)is int and 0<=value<=10_000_000
def validate_campaign(report,rows):
    require(set(report)=={SUITE},'Exact invariant suite required')
    tests=report[SUITE]['test_results'];require(set(tests)==TESTS,'Complete oracle, boundary and invariant tests required')
    require(all(t['status']=='Success'and t.get('reason')is None and t.get('counterexample')is None for t in tests.values()),'A Solidity check did not pass')
    invariant=tests[INVARIANT]['kind']['Invariant'];fuzz=tests[FUZZ]['kind']['Fuzz']
    require(invariant['runs']==128 and invariant['calls']==32768 and invariant['reverts']==0
            and invariant['failed_corpus_replays']==0,'Complete invariant schedule required')
    require(fuzz['runs']==256 and fuzz['failed_corpus_replays']==0,'Complete uint96 fuzz examples required')
    metrics=invariant['metrics'];prefix='solidity-tests/EscrowConservation.t.sol:CashHandler.'
    require(set(metrics)=={prefix+h for h in HANDLERS},'Every intended handler must be exercised')
    require(all(integer(m['calls'])and m['calls']>0 and m['reverts']==0 and m['discards']==0 for m in metrics.values()),'Handler failure or discard')
    require(sum(m['calls']for m in metrics.values())==32768,'Handler accounting differs')
    # Pinned Forge 1.7.1 also replays the final sequence's exit hook for its
    # result trace. Require that exact terminal replay, count it only once.
    require(len(rows)==129 and rows[-1]==rows[-2],'128 sequence exits plus one exact terminal replay required')
    rows=rows[:-1]
    require(len({r.get('scheduledTrace')for r in rows})==128,'Independent sequence traces required')
    for row in rows:
        require(set(row)=={'scheduledHandlerCalls','scheduledTrace','protocolCallsIncludingSetupAndExit','expectedEscrowReverts','oracleVerifiedAfterExit'}
            and type(row['scheduledHandlerCalls'])is int and row['scheduledHandlerCalls']==256
            and isinstance(row['scheduledTrace'],str)and re.fullmatch(r'0x[0-9a-f]{64}',row['scheduledTrace'])
            and row['oracleVerifiedAfterExit']is True and integer(row['protocolCallsIncludingSetupAndExit'])
            and 0<row['protocolCallsIncludingSetupAndExit']<=1024 and integer(row['expectedEscrowReverts'])
            and 0<row['expectedEscrowReverts']<=row['protocolCallsIncludingSetupAndExit'],'Invalid protocol/exit telemetry')
    calls=sum(r['protocolCallsIncludingSetupAndExit']for r in rows)
    require(calls>=32768-metrics[prefix+'advance']['calls'],'Missing actual protocol calls')
    return {'sequences':128,'scheduledHandlerCalls':32768,'handlerReverts':0,'discards':0,'rawExitRows':129,
            'verifiedSequenceExits':128,'terminalExitReplaysExcluded':1,
            'uint96FuzzExamples':256,'protocolCallsIncludingSetupAndExit':calls,
            'expectedInnerEscrowReverts':sum(r['expectedEscrowReverts']for r in rows)}
def executable(hexcode):
    code=bytes.fromhex(hexcode.removeprefix('0x'));require(len(code)>2,'Runtime missing')
    metadata=int.from_bytes(code[-2:],'big');require(0<metadata<4096 and metadata+2<len(code),'Solidity metadata envelope')
    require(code[-metadata-2]in(0xa1,0xa2,0xa3),'CBOR metadata map required')
    return code[:-metadata-2]
def read(path):
    require(path.is_file()and not path.is_symlink()and path.stat().st_size<=8*1024*1024,'Bounded regular report required')
    return parse(path.read_text(encoding='utf8'))
def main():
    results=[]
    for seed in ('c0ffee19','5eed2026'):
        report=read(ROOT/'.local/solidity-invariants'/f'{seed}.json')
        path=ROOT/'.local/invariant-metrics'/f'{seed}.jsonl'
        require(path.is_file()and not path.is_symlink()and path.stat().st_size<=1024*1024,'Bounded protocol telemetry required')
        results.append({'seed':'0x'+seed,**validate_campaign(report,[parse(line)for line in path.read_text().splitlines()])})
    canonical=read(ROOT/'contracts/artifacts/TelomereRunEscrow.json');native=read(ROOT/'.local/forge-out/TelomereRunEscrow.sol/TelomereRunEscrow.json')
    a=canonical['deployedBytecode'];b=native['deployedBytecode']['object'];require(executable(a)==executable(b),'Native campaign differs from canonical executable runtime')
    source=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    require(not subprocess.check_output(['git','status','--porcelain'],cwd=ROOT,text=True),'Clean reviewed source required')
    names=['contracts/TelomereRunEscrow.sol','contracts/MockToken.sol','solidity-tests/EscrowConservation.t.sol','solidity-tests/foundry.toml','package-lock.json','security/forge-tools.json']
    print(json.dumps({'sourceCommit':source,'sourceHashes':{n:hashlib.sha256((ROOT/n).read_bytes()).hexdigest()for n in names},
        'campaigns':results,'canonicalAndNativeExecutableEqual':True,'fullRuntimeEqual':a.removeprefix('0x')==b.removeprefix('0x'),
        'executableSha256':hashlib.sha256(executable(a)).hexdigest(),
        'metadataBoundary':'Only the validated CBOR compiler-metadata suffix is excluded; immutable template bytes and all executable bytes match.',
        'mainnetTransactions':0,'passed':True},indent=2))
if __name__=='__main__':main()
