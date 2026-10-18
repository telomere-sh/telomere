"""Build/review a declared-state fixture image through a loopback-only registry.

Only the isolated audit daemon is used. No public registry push is performed.
"""
import argparse,hashlib,importlib.util,json,os,re,socket,subprocess,time,urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
REGISTRY='registry@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8'
def require(value,message):
    if not value:raise ValueError(message)
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def main(identifier):
    spec=importlib.util.spec_from_file_location('audit_daemon',Path(__file__).with_name('gvisor-daemon.py'))
    daemon=importlib.util.module_from_spec(spec);spec.loader.exec_module(daemon)
    run,root,public,unit=daemon.locations(identifier);p=json.loads((root/'manifest.json').read_text())
    require(p['fixtureId']==identifier and p['socket']==str(run/'docker.sock')and root.resolve()==root,'Owned isolated fixture')
    docker=['docker','--host','unix://'+p['socket']]
    require(json.loads(daemon.execute(docker+['info','--format','{{json .DockerRootDir}}']).stdout)==str(root/'data'),'Actual isolated daemon')
    git=['git','-c','safe.directory='+str(ROOT)]
    source=daemon.execute(git+['rev-parse','HEAD'],cwd=ROOT).stdout.strip()
    require(re.fullmatch('[a-f0-9]{40}',source)and not daemon.execute(git+['status','--porcelain'],cwd=ROOT).stdout,'Clean source required')
    context=root/'declared-build';context.mkdir(mode=0o700)
    config=root/'docker-client';config.mkdir(mode=0o700)
    env={**os.environ,'DOCKER_CONFIG':str(config),'DOCKER_BUILDKIT':'0'}
    node='node';esbuild=ROOT/'node_modules/esbuild/bin/esbuild'
    require(daemon.execute([node,str(esbuild),'--version'],cwd=ROOT).stdout.strip()=='0.28.2','Reviewed image builder')
    hashes={}
    for name in ('declared-state-cell','declared-state-cell-capture'):
        out=context/(name+'.cjs')
        daemon.execute([node,str(esbuild),'scripts/'+name+'.ts','--bundle','--platform=node','--format=cjs','--outfile='+str(out)],cwd=ROOT)
        out.chmod(0o444);hashes[name+'.cjs']=digest(out)
    dockerfile=ROOT/'infra/host-kit/Dockerfile.declared-state';(context/'Dockerfile').write_bytes(dockerfile.read_bytes())
    with socket.socket()as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    repository='127.0.0.1:'+str(port)+'/telomere-declared';tag=repository+':'+source
    registry='audit-registry-'+identifier;data=root/'registry-data';data.mkdir(mode=0o700)
    daemon.execute(docker+['pull',REGISTRY],timeout=300,env=env)
    try:
        daemon.execute(docker+['run','-d','--name',registry,'--label','telomere.audit='+identifier,'--runtime','runc','--network','host',
          '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--pids-limit','64',
          '--mount','type=bind,src='+str(data)+',dst=/var/lib/registry','--env','REGISTRY_HTTP_ADDR=127.0.0.1:'+str(port),REGISTRY],env=env)
        deadline=time.monotonic()+20
        while True:
            try:
                with urllib.request.urlopen('http://127.0.0.1:'+str(port)+'/v2/',timeout=1)as response:
                    require(response.status==200,'Private registry readiness');break
            except OSError:require(time.monotonic()<deadline,'Private registry deadline');time.sleep(.2)
        with (root/'declared-build.log').open('w')as log:
            subprocess.run(docker+['build','--network=none','--pull=false','--build-arg','BASE_IMAGE='+p['image'],'--tag',tag,str(context)],
              check=True,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=600)
        with (root/'declared-local-store.log').open('w')as log:
            subprocess.run(docker+['push',tag],check=True,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=300)
        images=json.loads(daemon.execute(docker+['image','inspect','--format','{{json .RepoDigests}}',tag],env=env).stdout)
        refs=[x for x in images if x.startswith(repository+'@sha256:')];require(len(refs)==1,'Actual immutable local image digest')
        report={'sourceCommit':source,'image':refs[0],'baseImage':p['image'],'esbuild':'0.28.2','dockerfileSha256':digest(dockerfile),
          'bundles':hashes,'registryImage':REGISTRY,'registryBoundTo':'127.0.0.1','publicPushes':0,'productionChanged':False}
        path=root/'declared-image.json';path.write_text(json.dumps(report,indent=2)+'\n');path.chmod(0o600)
        print(json.dumps(report))
    finally:
        inspected=subprocess.run(docker+['inspect','--format','{{index .Config.Labels "telomere.audit"}}',registry],capture_output=True,text=True,env=env)
        if inspected.returncode==0:
            require(inspected.stdout.strip()==identifier,'Owned registry label');daemon.execute(docker+['rm','-f',registry],env=env)
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('fixture_id');main(parser.parse_args().fixture_id)
