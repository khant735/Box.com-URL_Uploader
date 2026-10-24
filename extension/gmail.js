let enabled=false;chrome.storage.local.get(['enabled','sessionSecret'],v=>enabled=!!v.enabled&&!!v.sessionSecret);chrome.storage.onChanged.addListener(c=>{if(c.enabled||c.sessionSecret)chrome.storage.local.get(['enabled','sessionSecret'],v=>enabled=!!v.enabled&&!!v.sessionSecret)});
// Capture clicks before Gmail navigation. Only handles links directly targeting chatgpt.com.
document.addEventListener('click',e=>{
 const a=e.target.closest?.('a[href]'); if(!a) return;
 let u; try{u=new URL(a.href)}catch{return}
 if(u.hostname!=='chatgpt.com'||!u.pathname.startsWith('/backend-api/estuary/content'))return;
 if(!u.searchParams.get('id')?.toLowerCase().endsWith('.zip')||!enabled)return;
 e.preventDefault();e.stopImmediatePropagation();
 chrome.runtime.sendMessage({type:'stream',url:u.href},response=>{
   if(chrome.runtime.lastError||response?.error) alert('Streaming could not start: '+(response?.error||chrome.runtime.lastError.message)+'\nThe original link was not downloaded.');
 });
},true);
