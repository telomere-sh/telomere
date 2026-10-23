(()=>{
 const root=document.documentElement;root.classList.add('assets-pending');let loader,revealed=false;
 // Readiness belongs to the current viewport, not the site's complete asset library.
 const downloaded=Promise.resolve([]);
 function mount(){if(loader||revealed)return;loader=document.createElement('div');loader.id='tl-asset-loader';loader.setAttribute('role','status');loader.innerHTML='<style>#tl-asset-loader .asset-loader-track{overflow:hidden}#tl-asset-loader .asset-loader-track i{width:35%;animation:tl-loader-pass .9s ease-in-out infinite}@keyframes tl-loader-pass{from{transform:translateX(-100%)}to{transform:translateX(300%)}}@media(prefers-reduced-motion:reduce){#tl-asset-loader .asset-loader-track i{animation:none;width:100%}}</style><div class="asset-loader-brand"><img src="/assets/brand/mark.svg" alt=""><span>TELOMERE</span></div><div class="asset-loader-track"><i></i></div><div class="asset-loader-caption"><span>ONE SECOND, PLEASE.</span><b>...</b></div>';document.body.append(loader)}
 function reveal(){if(revealed)return;revealed=true;clearTimeout(deadline);root.classList.remove('assets-pending');root.classList.add('assets-ready');loader?.remove();document.dispatchEvent(new Event('telomere-assets-ready'))}
 // A failed image, font, or module must never leave the whole site behind a loader.
 const deadline=setTimeout(reveal,4000);
 if(document.body)mount();else document.addEventListener('DOMContentLoaded',mount,{once:true});
 async function prepare(scope){
  if(!scope)return;
  const visible=[];
  for(const img of scope.querySelectorAll('img')){
   const box=img.getBoundingClientRect();
   if(box.width<=0||box.height<=0||box.bottom<0||box.top>innerHeight+160)continue;
   // Keep native srcset/sizes selection and let the browser load off-screen media.
   img.loading='eager';
   if(visible.length<4&&typeof img.decode==='function')visible.push(Promise.resolve().then(()=>img.decode()));
  }
  if(visible.length){
   let timer;
   try{await Promise.race([Promise.allSettled(visible),new Promise(resolve=>{timer=setTimeout(resolve,800)})])}finally{clearTimeout(timer)}
  }
  scope.dataset.imagesReady='true';
 }
 window.TelomereAssets={downloaded,prepare,reveal};
})();
