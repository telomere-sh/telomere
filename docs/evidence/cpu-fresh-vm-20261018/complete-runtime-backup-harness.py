import hashlib,importlib.util,json,pathlib,time
root=pathlib.Path('/opt/telomere-mainnet-pilot/private/fresh-vm-772e1085572545b9');fixture=root/'complete-runtime-backup'
spec=importlib.util.spec_from_file_location('tested_runtime_bundle',root/'operator/cpu-launch/mainnet-ops.py');ops=importlib.util.module_from_spec(spec);spec.loader.exec_module(ops)
ops.PRIVATE=fixture;ops.BACKUPS=fixture
began=time.monotonic();result=ops.runtime_bundle();assert result['bytes']<=ops.policy.MAX_RUNTIME_ARCHIVE
result.update(passed=True,maximumCiphertextBytes=ops.policy.MAX_RUNTIME_ARCHIVE,elapsedSeconds=round(time.monotonic()-began,3),productionBackupReceiptChanged=False,productionOperatorUpdated=False,privateFixtureOnly=True)
(root/'complete-runtime-backup-result.json').write_text(json.dumps(result,indent=2)+chr(10));print(json.dumps(result))
