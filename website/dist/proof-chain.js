const guarantees=[
 ['Receipt required','Every billed second has evidence.','Host-signed ticks connect measured running time to a receipt leaf. Settlement follows that record.','RUN RECEIPTS','receipt'],
 ['Unused time returns','Refunds are the default.','Unused escrow and unreceipted time return to the payer. A spending ceiling is a boundary, not the final bill.','RUN ESCROW','settlement'],
 ['Authority has limits','The Leash is enforced on-chain.','Hourly and daily caps, permitted hardware, image and region filters, expiry, and a kill switch stay under owner control.','LEASH REGISTRY','leash'],
 ['State survives','A machine can stop. The work can continue.','Encrypted Cysts are stored off-host and registered by hash, preserving a path to resume on eligible compute.','CYST REGISTRY','cyst'],
 ['The owner decides','Control stays with the owner.','Owners can stop runs, revoke agent authority, and withdraw unspent balances under the protocol rules.','OWNER CONTROL','kill'],
 ['Public verification','Follow the proof to settlement.','Check host signatures, the receipt leaf against its hourly root, and settled amounts against escrow events.','RECEIPT ROOT','root'],
 ['Hardware is measured','The declared class is tested.','Admission benchmarks and a warm check probe hardware performance before a GPU workload is billed.','HOST KIT','compute'],
 ['A public life cycle','Selection leaves a record.','Opt-in agents have a public record of births, income, spending, offspring, dormancy, and deaths.','FOSSIL RECORD','branch']
];
const icon=n=>`<svg viewBox="0 0 40 40" class="icon" aria-hidden="true"><use href="/assets/tech/icons.svg#${n}"/></svg>`;
export function mountGuarantees(root){
 const main=root.querySelector('main');if(!main)return;
 for(const old of root.querySelectorAll('.framer-LzxSd')){let holder=old;while(holder.parentElement&&holder.parentElement!==main)holder=holder.parentElement;if(holder.parentElement!==main)continue;holder.hidden=true;if(root.querySelector('#proof-chain'))continue;
 const section=document.createElement('section');section.id='proof-chain';section.className='proof-chain dark';section.setAttribute('aria-labelledby','proof-chain-title');
 section.innerHTML=`<header class="proof-header"><div><div class="eyebrow">The protocol / 08 safeguards</div><h2 id="proof-chain-title">Guarantees &<br><span>accountability.</span></h2></div><p>A growing chain of evidence.<br>Collect each orange checkpoint.<br>Every safeguard adds to the whole.</p></header><div class="proof-layout"><div class="proof-board"><div class="proof-board-top mono"><span><i></i> THE PROOF CHAIN</span><span class="proof-tally">00 / 08</span></div><canvas width="960" height="640" role="img" aria-label="A segmented proof chain collects eight orange checkpoints and grows with each guarantee."></canvas><div class="proof-board-bottom mono"><span>RUN / VERIFY / CONTINUE</span><span class="proof-segments">06 SEGMENTS</span></div></div><aside class="proof-reading"><div class="proof-reading-top"><span class="mono proof-number">01 / RUN RECEIPTS</span><span class="proof-reading-icon">${icon('receipt')}</span></div><div class="proof-copy"><span class="proof-kicker">Receipt required</span><h3>Every billed second has evidence.</h3><p>Host-signed ticks connect measured running time to a receipt leaf. Settlement follows that record.</p></div><div class="proof-nav" aria-label="Explore the eight guarantees">${guarantees.map(([label],i)=>`<button data-guarantee="${i}" aria-pressed="${i===0}" class="${i===0?'active':''}"><span>0${i+1}</span>${label}<i></i></button>`).join('')}</div></aside></div><footer class="proof-footer"><span class="mono">ONE STANDARD. EVERY RUN.</span><a href="/learn/receipts/">Explore the evidence <span>↗</span></a></footer>`;
 holder.before(section);animateChain(section);
 }
}
function animateChain(section){
 const canvas=section.querySelector('canvas'),ctx=canvas.getContext('2d'),foodSteps=[8,21,33,45,57,70,83,99],points=[[3,3],[25,3],[25,7],[6,7],[6,11],[23,11],[23,16],[3,16],[3,3]],path=[];
 for(let n=0;n<points.length-1;n++){let [x,y]=points[n],to=points[n+1];while(x!==to[0]||y!==to[1]){path.push([x,y]);x+=Math.sign(to[0]-x);y+=Math.sign(to[1]-y)}}
 const cols=29,rows=20,W=960,H=640,cell=30,ox=45,oy=20,reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
 let elapsed=reduced?20:0,last=0,raf=0,visible=false,selected=0,manualUntil=0,lastVisit=-1,total=0;
 const at=n=>path[((n%path.length)+path.length)%path.length];
 function select(index){selected=index;const g=guarantees[index];section.querySelector('.proof-number').textContent=`0${index+1} / ${g[3]}`;section.querySelector('.proof-kicker').textContent=g[0];section.querySelector('.proof-copy h3').textContent=g[1];section.querySelector('.proof-copy p').textContent=g[2];section.querySelector('.proof-reading-icon').innerHTML=icon(g[4]);section.querySelectorAll('[data-guarantee]').forEach(b=>{const active=+b.dataset.guarantee===index;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active))})}
 section.querySelector('.proof-nav').onclick=e=>{const b=e.target.closest('[data-guarantee]');if(!b)return;manualUntil=elapsed+20;select(+b.dataset.guarantee);draw()};
 function apple(x,y,r,active){ctx.save();ctx.translate(x,y);ctx.fillStyle=active?'#FC5D24':'#cecabf';ctx.beginPath();ctx.moveTo(0,-r*.62);ctx.bezierCurveTo(-r*.9,-r*1.2,-r*1.2,-r*.05,-r*.6,r*.7);ctx.quadraticCurveTo(-r*.2,r*1.05,0,r*.8);ctx.quadraticCurveTo(r*.2,r*1.05,r*.6,r*.7);ctx.bezierCurveTo(r*1.2,-r*.05,r*.9,-r*1.2,0,-r*.62);ctx.fill();ctx.strokeStyle=active?'#FC5D24':'#cecabf';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(0,-r*.6);ctx.quadraticCurveTo(1,-r*1.35,r*.6,-r*1.35);ctx.stroke();ctx.restore()}
 function draw(){
 const position=elapsed*5.2,step=Math.floor(position),fraction=position-step,lap=Math.floor(step/path.length),local=step%path.length,visited=foodSteps.filter(n=>n<=local).length;total=reduced?8:Math.min(8,lap*8+visited);const length=6+total*3,visit=lap*8+visited-1;
 if(visit!==lastVisit){lastVisit=visit;if(visit>=0&&elapsed>=manualUntil)select(visit%8);section.querySelector('.proof-tally').textContent=`${String(total).padStart(2,'0')} / 08`;section.querySelector('.proof-segments').textContent=`${String(length).padStart(2,'0')} SEGMENTS`;section.querySelectorAll('[data-guarantee]').forEach((b,i)=>b.classList.toggle('collected',i<total))}
 ctx.clearRect(0,0,W,H);ctx.fillStyle='#F0EEE9';ctx.fillRect(0,0,W,H);
 ctx.strokeStyle='#dfdcd5';ctx.lineWidth=.7;for(let x=0;x<cols;x++){ctx.beginPath();ctx.moveTo(ox+x*cell,oy);ctx.lineTo(ox+x*cell,oy+(rows-1)*cell);ctx.stroke()}for(let y=0;y<rows;y++){ctx.beginPath();ctx.moveTo(ox,oy+y*cell);ctx.lineTo(ox+(cols-1)*cell,oy+y*cell);ctx.stroke()}
 ctx.strokeStyle='#cecabf';ctx.lineWidth=1;ctx.setLineDash([2,6]);ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(ox+x*cell,oy+y*cell):ctx.moveTo(ox+x*cell,oy+y*cell));ctx.stroke();ctx.setLineDash([]);
 const target=foodSteps.findIndex(n=>n>local),next=target<0?0:target;
 foodSteps.forEach((n,i)=>{const [x,y]=at(n);if(i===next){const px=ox+x*cell,py=oy+y*cell;ctx.strokeStyle='#FC5D24';ctx.lineWidth=1;ctx.strokeRect(px-24,py-24,48,48);apple(px,py,11*(1+Math.sin(elapsed*3)*.025),true);ctx.fillStyle='#191919';ctx.font='11px monospace';ctx.fillText(`0${i+1}`,px-7,py+39)}else{ctx.fillStyle=i<total?'#a29e95':'#d5d1c8';ctx.fillRect(ox+x*cell-3,oy+y*cell-3,6,6)}});
 for(let n=length-1;n>=0;n--){const a=at(step-n),b=at(step-n+1),x=ox+(a[0]+(b[0]-a[0])*fraction)*cell,y=oy+(a[1]+(b[1]-a[1])*fraction)*cell;ctx.fillStyle=n===0?'#FC5D24':'#191919';ctx.beginPath();ctx.roundRect(x-12,y-12,24,24,n===0?7:3);ctx.fill();if(n===0){ctx.fillStyle='#191919';ctx.fillRect(x-5,y-5,10,10)}if(n===length-1){ctx.fillStyle='#FC5D24';ctx.fillRect(x-8,y-8,16,16)}}
 ctx.fillStyle='#77736b';ctx.font='11px monospace';ctx.fillText('METERED WORK → RECEIPT → SETTLEMENT',ox,626);
 section.dataset.safeguards=String(total);section.dataset.segments=String(length);
 }
 function frame(now){raf=0;if(!visible||document.hidden||reduced){last=0;return}if(last)elapsed+=Math.min((now-last)/1000,.08);last=now;draw();raf=requestAnimationFrame(frame)}
 function resume(){cancelAnimationFrame(raf);raf=0;last=0;if(visible&&!document.hidden&&!reduced)raf=requestAnimationFrame(frame)}
 const observer=new IntersectionObserver(([e])=>{visible=e.isIntersecting;resume()},{threshold:.3});observer.observe(section.querySelector('.proof-board'));document.addEventListener('visibilitychange',resume);draw();
}
