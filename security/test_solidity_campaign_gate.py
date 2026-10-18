import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('campaign_gate',Path(__file__).with_name('verify-solidity-campaigns.py'))
gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)
def fixture():
    tests={name:{'status':'Success','reason':None,'counterexample':None,'kind':{'Unit':{}}}for name in gate.TESTS}
    counts=[2978]*10+[2988];metrics={'solidity-tests/EscrowConservation.t.sol:CashHandler.'+name:{'calls':count,'reverts':0,'discards':0}for name,count in zip(sorted(gate.HANDLERS),counts)}
    tests[gate.INVARIANT]['kind']={'Invariant':{'runs':128,'calls':32768,'reverts':0,'failed_corpus_replays':0,'metrics':metrics}}
    tests[gate.FUZZ]['kind']={'Fuzz':{'runs':256,'failed_corpus_replays':0}}
    rows=[{'scheduledHandlerCalls':256,'scheduledTrace':f'0x{i+1:064x}','protocolCallsIncludingSetupAndExit':270,'expectedEscrowReverts':70,'oracleVerifiedAfterExit':True}for i in range(128)]
    return {gate.SUITE:{'test_results':tests}},rows+[dict(rows[-1])]
class CampaignGateTests(unittest.TestCase):
    def test_complete_proof(self):
        report,rows=fixture();self.assertEqual(gate.validate_campaign(report,rows)['scheduledHandlerCalls'],32768)
    def test_rejects_partial_failed_skipped_discarded_and_wrong_metrics(self):
        for mode in ('short','missing','failed','discard','wrong_calls','bad_exit','missing_exit','duplicate_exit','short_sequence','bool_count','replay_mismatch','duplicate_sequence'):
            report,rows=fixture();tests=report[gate.SUITE]['test_results'];invariant=tests[gate.INVARIANT]['kind']['Invariant']
            if mode=='short':invariant['runs']=1
            elif mode=='missing':tests.pop('testOracleRejectsForgedWalletCash()')
            elif mode=='failed':tests[gate.FUZZ]['status']='Skipped'
            elif mode=='discard':next(iter(invariant['metrics'].values()))['discards']=1
            elif mode=='wrong_calls':next(iter(invariant['metrics'].values()))['calls']+=1
            elif mode=='bad_exit':rows[0]['oracleVerifiedAfterExit']=False
            elif mode=='duplicate_exit':rows.append(dict(rows[-1]))
            elif mode=='short_sequence':rows[0]['scheduledHandlerCalls']=255
            elif mode=='bool_count':rows[0]['scheduledHandlerCalls']=True
            elif mode=='replay_mismatch':rows[-1]['protocolCallsIncludingSetupAndExit']+=1
            elif mode=='duplicate_sequence':rows[0]['scheduledTrace']=rows[1]['scheduledTrace']
            else:rows.pop()
            with self.subTest(mode=mode),self.assertRaises(ValueError):gate.validate_campaign(report,rows)
    def test_json_and_executable_boundaries(self):
        for text in ['{"calls":1,"calls":2}','{"calls":NaN}']:
            with self.assertRaises(ValueError):gate.parse(text)
        self.assertEqual(gate.executable('6000a100010003'),bytes.fromhex('6000'))
        with self.assertRaises(ValueError):gate.executable('600000000002')
