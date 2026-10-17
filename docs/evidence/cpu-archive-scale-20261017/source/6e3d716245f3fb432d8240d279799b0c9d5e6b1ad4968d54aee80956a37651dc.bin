#!/usr/bin/python3
"""Acceptance-only Docker namespace; cannot inspect/remove production Cells."""
import os,re,subprocess,sys
namespace=os.environ.get('TELOMERE_ACCEPTANCE_NAMESPACE','')
assert re.fullmatch('[0-9a-f]{16}',namespace)
assert os.environ.get('DOCKER_HOST')=='unix:///run/telomere-mainnet-docker/docker.sock'
args=sys.argv[1:];assert args
label='telomere.load.acceptance';verb=args[0]
if verb=='create':
    assert '--name' in args and re.fullmatch(r'telomere-[0-9a-f]{24}-[0-9a-f]{8}',args[args.index('--name')+1])
    args[1:1]=['--label',label+'='+namespace]
elif verb=='ps':args[1:1]=['--filter','label='+label+'='+namespace]
elif verb in ('inspect','start','kill','rm'):
    name=args[-1];assert re.fullmatch(r'telomere-[0-9a-f]{24}-[0-9a-f]{8}',name)
    result=subprocess.run(['/usr/bin/docker','inspect','--format','{{index .Config.Labels "'+label+'"}}',name],capture_output=True)
    if result.returncode or result.stdout.decode().strip()!=namespace:raise SystemExit(65)
else:raise SystemExit(64)
os.execv('/usr/bin/docker',['docker',*args])
