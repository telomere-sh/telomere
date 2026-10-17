// Off-chain, disposable account acceptance. Never uses the operator or owner key,
// never sends an Ethereum transaction, and resets each test workspace before logout.
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
const origin = 'https://telomere.sh';
const report = { scope:'live-public-wallet-auth-and-tenant-isolation', transactions:0, checks:[] };
const accounts = [];
async function request(path, {method='GET',body,cookie,owner}={}) {
  const response = await fetch(origin+path,{method,headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(owner?{'X-Telomere-Owner':owner}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {response,body:await response.json()};
}
function pass(name){report.checks.push(name)}
try {
  const config=await request('/api/config');assert.equal(config.body.walletAccess,'public');assert.equal(config.body.chain.id,8453);assert.equal(config.body.mode,'mainnet');pass('public Base mainnet configuration');
  assert.equal((await request('/api/workspace')).response.status,401);pass('anonymous workspace denied');
  for(let i=0;i<2;i++){
    const wallet=privateKeyToAccount(generatePrivateKey());const challenge=await request('/api/auth/challenge',{method:'POST',body:{address:wallet.address}});assert.equal(challenge.response.status,200);
    const signature=await wallet.signMessage({message:challenge.body.message});
    const verified=await request('/api/auth/verify',{method:'POST',body:{address:wallet.address,nonce:challenge.body.nonce,signature}});assert.equal(verified.response.status,200);
    const header=verified.response.headers.get('set-cookie');assert.match(header,/HttpOnly/i);assert.match(header,/Secure/i);assert.match(header,/SameSite=Strict/i);
    const account={cookie:header.split(';')[0],owner:wallet.address};accounts.push(account);
    const workspace=await request('/api/workspace',account);assert.equal(workspace.body.owner.toLowerCase(),wallet.address.toLowerCase());account.workspace=workspace.body;
    assert.equal((await request('/api/auth/verify',{method:'POST',body:{address:wallet.address,nonce:challenge.body.nonce,signature}})).response.status,401);
  }
  pass('two independently signed new wallets; secure cookies; nonce replay denied');
  const [alice,bob]=accounts;const document=structuredClone(alice.workspace.document);document.budget=137;
  const saved=await request('/api/workspace',{...alice,method:'PUT',body:{revision:alice.workspace.revision,document}});assert.equal(saved.response.status,200);
  const privateRead=await request('/api/workspace',bob);assert.equal(privateRead.body.document.budget,0);pass('private documents separated between wallets');
  assert.equal((await request('/api/workspace',{...alice,method:'PUT',body:{revision:alice.workspace.revision,document}})).response.status,409);pass('stale write rejected');
  assert.equal((await request('/api/workspace',{cookie:bob.cookie,owner:alice.owner})).response.status,409);
  assert.equal((await request('/api/workspace',{cookie:bob.cookie,owner:alice.owner,method:'PUT',body:{revision:privateRead.body.revision,document}})).response.status,409);pass('stale tab blocked after cookie account switch');
  const balance=await request('/api/balance',bob);assert.equal(balance.response.status,200);assert.equal(balance.body.available,'0');
  const runs=await request('/api/runs',bob);assert.equal(runs.response.status,200);assert.deepEqual(runs.body.runs,[]);pass('new wallet has no foreign funds or runs');
  const reset=await request('/api/workspace',{...alice,method:'PUT',body:{revision:saved.body.revision,document:alice.workspace.document}});assert.equal(reset.response.status,200);
  for(const account of accounts){assert.equal((await request('/api/auth/logout',{...account,method:'POST',body:{}})).response.status,200);assert.equal((await request('/api/workspace',account)).response.status,401)}
  pass('logout revokes sessions');report.passed=true;
} finally {
  for(const account of accounts)await request('/api/auth/logout',{cookie:account.cookie,method:'POST',body:{}}).catch(()=>{});
}
report.observedAt=new Date().toISOString();process.stdout.write(JSON.stringify(report,null,2)+'\n');
