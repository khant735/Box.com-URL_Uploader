const $=id=>document.getElementById(id);
const MiB=1048576;let BLOCK=8*MiB,PART=249999999;
let cancelled=false,active=false,controller=null;
const fmt=n=>(n/MiB).toFixed(1)+' MiB';
const eta=s=>!Number.isFinite(s)?'Calculating...':s<60?Math.ceil(s)+' sec':s<3600?Math.ceil(s/60)+' min':(s/3600).toFixed(1)+' hours';
function field(id,v){$(id).textContent=v;}
function show(t){field('log',t)}
async function local(path,secret,body,headers={}){
 const r=await fetch('http://127.0.0.1:8765'+path,{method:'POST',headers:{'X-Stream-Secret':secret,...headers},body});
 const t=await r.text();let j;try{j=JSON.parse(t)}catch{throw Error('Local response: '+t.slice(0,300))}
 if(!r.ok)throw Error(path+': '+(j.error||r.status));return j;
}
async function range(url,offset,length,size){
 const end=offset+length-1;controller=new AbortController();
 const r=await fetch(url,{headers:{Range:`bytes=${offset}-${end}`},credentials:'include',cache:'no-store',signal:controller.signal});
 if(r.status!==206)throw Error('Expected HTTP 206, got '+r.status);
 if(r.headers.get('content-range')!==`bytes ${offset}-${end}/${size}`)throw Error('Content-Range mismatch at '+offset);
 const b=await r.arrayBuffer();if(b.byteLength!==length)throw Error('Incorrect block length');return b;
}
function update(offset,size,parts,count,resume,rate,stage){
 const current=Math.min(count,Math.floor(offset/PART)+1);
 const currentStart=(current-1)*PART;
 const currentSize=Math.min(PART,size-currentStart);
 field('parts',parts+' / '+count+' uploaded');
 field('resumeCount',resume+' / '+count);
 field('current',current<=count?window.currentSourceName+'.part'+String(current).padStart(3,'0'):'Complete');
 field('next',current<count?window.currentSourceName+'.part'+String(current+1).padStart(3,'0'):'None');
 field('filesize',fmt(currentSize)+' ('+currentSize.toLocaleString()+' bytes)');
 field('speed',rate>0?(rate/MiB).toFixed(2)+' MiB/s':'Calculating...');
 field('remaining',rate>0?eta((size-offset)/rate):'Calculating...');
 field('percentage',(offset/size*100).toFixed(2)+'%');
 field('stage',stage);$('progress').value=offset/size*100;
}
// Probes are bounded by an explicit traffic budget. These are observed working sizes,
// not an advertised server minimum/maximum. Probe bytes are discarded (never uploaded).
async function probeBlocks(url,size,settings){
 const choices=[1,2,4,8,16,32,64].filter(x=>x>=settings.probeMinMiB && x<=settings.probeMaxMiB && x*MiB<=size);
 let used=0, good=[], failed=[];
 for(const mb of choices){
  const len=mb*MiB;if(used+len>settings.probeBudgetMiB*MiB)break;
  used+=len;const t=performance.now();
  try{await range(url,0,len,size);good.push({mb,bps:len/Math.max(.001,(performance.now()-t)/1000)});}
  catch(e){failed.push(mb+': '+e.message);if(e.message.includes('HTTP 429')||e.message.includes('HTTP 403'))break;}
 }
 if(!good.length)throw Error('No successful probe sizes within budget. Use fixed mode or increase probe budget. '+failed.join('; '));
 const best=good.reduce((a,b)=>b.bps>a.bps?b:a);
 field('probeResult','Observed '+good.map(x=>x.mb).join(', ')+' MiB; fastest '+best.mb+' MiB; '+fmt(used)+' tested'+(failed.length?'; failed '+failed.join('; '):''));
 return best.mb;
}
async function fetchWithFallback(url,offset,maxLen,size,settings,blockMiB){
 let mb=blockMiB,attempt=0;
 while(true){
  const len=Math.min(mb*MiB,maxLen);
  try{const t=performance.now();const data=await range(url,offset,len,size);return {data,len,mb,seconds:Math.max(.001,(performance.now()-t)/1000)};}
  catch(e){
   if(cancelled)throw e;
   if(settings.fallbackBlocks && mb>1){mb=Math.max(1,Math.floor(mb/2));field('stage','Range failed; reducing block to '+mb+' MiB');continue;}
   if(attempt++<settings.rangeRetries){field('stage','Retrying range '+offset+' ('+attempt+')');continue;}
   throw e;
  }
 }
}
$('cancel').onclick=()=>{cancelled=true;controller?.abort();show('Cancelling after current operation...')};
// Persistent backup history: each transfer is pinned to its own URL, name, size and Box settings.
const RECORDS_KEY='backupRecordsV023', SELECTED_KEY='selectedBackupIdV023';
let selectedId=null;
const cleanName=n=>String(n||'').split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g,'_').slice(0,180);
async function allRecords(){const v=await chrome.storage.local.get([RECORDS_KEY,SELECTED_KEY]);return {records:v[RECORDS_KEY]||[],selected:v[SELECTED_KEY]||null};}
async function writeRecords(records,id){await chrome.storage.local.set({[RECORDS_KEY]:records,[SELECTED_KEY]:id});}
async function renderRecords(id){const {records,selected}=await allRecords();selectedId=id||selected||records[0]?.id||null;const el=$('backupHistory');el.replaceChildren();for(const r of records){const o=document.createElement('option');o.value=r.id;o.textContent=r.name+' — '+(r.status||'saved')+' — '+new Date(r.updatedAt||r.createdAt).toLocaleString();el.appendChild(o)}if(selectedId)el.value=selectedId;const r=records.find(x=>x.id===selectedId);$('sourceUrl').value=r?.url||'';$('sourceName').value=r?.name||'';field('backupInfo',r?'Selected: '+r.name+' | '+(r.size?fmt(r.size):'size not yet checked')+' | '+(r.completedParts||0)+' parts recorded. URL and filename restored.':'No saved backup. Select Start New Backup.');return r;}
async function selectRecord(id){await chrome.storage.local.set({[SELECTED_KEY]:id});await renderRecords(id);}
$('backupHistory').onchange=async e=>{if(active)return;await selectRecord(e.target.value)};
async function saveRecord(r){const {records}=await allRecords();const i=records.findIndex(x=>x.id===r.id);if(i>=0)records[i]=r;else records.unshift(r);await writeRecords(records,r.id);selectedId=r.id;await renderRecords(r.id);}
async function getLatest(){const items=await chrome.downloads.search({orderBy:['-startTime'],limit:100});const item=items.find(x=>(x.finalUrl||'').startsWith('https://chatgpt.com/backend-api/estuary/content'));if(!item)throw Error('No recent ChatGPT download; paste a valid source URL instead.');return {url:item.finalUrl,name:cleanName((item.filename||'ChatGPT-backup.zip').split(/[\\/]/).pop())};}
$('captureLatest').onclick=async()=>{try{if(active)throw Error('Cannot change the source during an active transfer');const item=await getLatest();$('sourceUrl').value=item.url;$('sourceName').value=item.name;show('Captured Chrome download as a candidate. Press Start New Backup to create a separate record; existing backups are unchanged.')}catch(e){show('Capture error: '+e.message)}};
$('newBackup').onclick=async()=>{try{if(active)throw Error('A backup is active');let url=$('sourceUrl').value.trim(),name=$('sourceName').value.trim();if(!url)throw Error('Source URL is required. Paste the intended URL or explicitly click Capture latest Chrome download.');const u=new URL(url);if(u.protocol!=='https:' && !(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw Error('Only HTTPS and local HTTP URLs allowed');name=cleanName(name||decodeURIComponent(u.pathname.split('/').pop())||'download.bin');if(!name)throw Error('Enter an output filename');const settings=readSettings();validateSettings(settings);const {records}=await allRecords();if(records.some(r=>r.name===name && r.settings?.folderId===settings.folderId))throw Error('A backup with this filename already exists in the selected Box folder. Select it and Resume instead, or choose a distinct filename.');if(!confirm('Create a NEW backup session for '+name+'? Previous backup records will remain unchanged.'))return;const r={id:crypto.randomUUID(),url,name,settings,size:null,completedParts:0,status:'new',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};await saveRecord(r);show('New backup saved for explicit URL. Starting transfer...');await runTransfer(r);}catch(e){show('New backup error: '+e.message)}};
$('resumePrevious').onclick=async()=>{try{if(active)throw Error('A backup is already active');const {records}=await allRecords();const r=records.find(x=>x.id===selectedId);if(!r)throw Error('No previous backup saved. Use Start New Backup.');if(!r.url)throw Error('Saved source URL is missing. Enter the original URL and save it to this record.');const editedUrl=$('sourceUrl').value.trim(),editedName=cleanName($('sourceName').value.trim());if(editedName!==r.name)throw Error('Filename differs from saved backup. Select Start New Backup for another filename.');if(editedUrl!==r.url)throw Error('Source URL differs from saved backup. Resume is locked to its saved URL. To change an expired URL, use a dedicated recovery procedure; do not overwrite the source automatically.');await runTransfer(r);}catch(e){show('Resume error: '+e.message)}};
async function runTransfer(record){
 if(active)return;active=true;cancelled=false;$('resumePrevious').disabled=true;$('newBackup').disabled=true;let started=false;
 const {sessionSecret:secret}=await chrome.storage.local.get('sessionSecret');
 try{
  if(!secret)throw Error('Set session secret in extension popup');
  const url=record.url,name=record.name;
  if(!url || !name)throw Error('Selected backup has no pinned source URL or filename');
  field('stage','Locked source: '+name);
  show('Using selected backup only: '+name+' (not Chrome latest download)');
  const u=new URL(url);const permission={origins:[u.origin+'/*']};
  if(!(await chrome.permissions.contains(permission)) && !(await chrome.permissions.request(permission)))throw Error('Chrome permission denied for '+u.origin);
  window.currentSourceName=name;
  const h=await fetch(url,{method:'HEAD',credentials:'include',cache:'no-store'});
  if(!h.ok)throw Error('Source HEAD HTTP '+h.status+'; this server requires HEAD and byte-range support');
  let size=Number(h.headers.get('content-length'));
  if(!Number.isSafeInteger(size)||size<=0)throw Error('Missing/invalid Content-Length. Cannot split this source safely.');
  const test=await fetch(url,{headers:{Range:'bytes=0-0'},credentials:'include',cache:'no-store'});
  const expected=`bytes 0-0/${size}`;
  const rangeOK=test.status===206 && test.headers.get('content-range')===expected;
  await test.body?.cancel();
  if(!rangeOK)throw Error('Source does not support reliable byte ranges (HTTP 206 / Content-Range required)');
  const settings={...defaults,...record.settings};
  for(const k of ['blockMiB','partSize','probeMinMiB','probeMaxMiB','probeBudgetMiB','rangeRetries'])settings[k]=Number(settings[k]);
  settings.blockMiB=Number(settings.blockMiB);settings.partSize=Number(settings.partSize);
  validateSettings(settings);
  if(record.size!==null && record.size!==size)throw Error('SOURCE SIZE CHANGED: saved '+record.size+' bytes, current '+size+'. Refusing to mix backups.');
  // Persist a small source fingerprint to catch accidental URL swaps on future resumes.
  const fingerprintLen=Math.min(size,65536);
  const fingerprintBytes=await range(url,0,fingerprintLen,size);
  const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',fingerprintBytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
  if(record.sourceFingerprint && record.sourceFingerprint!==fingerprint)throw Error('SOURCE FINGERPRINT CHANGED. Refusing to mix files.');
  record.sourceFingerprint=fingerprint;
  if(settings.compressionMode!=='original')throw Error('Compressed upload is not implemented yet; select Original backup');
  PART=settings.partSize;BLOCK=settings.blockMiB*MiB;
  let currentBlockMiB=settings.blockMiB;
  if(settings.blockMode!=='fixed')currentBlockMiB=await probeBlocks(url,size,settings);
  BLOCK=currentBlockMiB*MiB;field('activeBlock',currentBlockMiB+' MiB');
  // QUICK AUDIT: verify only the last existing Box part against its original source range.
  // Never allow /start to create sidecars or upload new parts before this completes.
  field('stage','Checking existing Box parts against original source');
  const audit=await local('/audit-start',secret,JSON.stringify({name,size,settings:{partSize:PART,folderId:settings.folderId}}),{'Content-Type':'application/json'});
  try{
   for(let i=0;i<audit.entries.length;i++){
    const part=audit.entries[i];
    for(let pos=0;pos<part.size;){
     if(cancelled)throw Error('Cancelled during source audit');
     const length=Math.min(8*MiB,part.size-pos);
     const bytes=await range(url,part.offset+pos,length,size);
     await local('/audit-block',secret,bytes,{'Content-Type':'application/octet-stream','X-Offset':String(part.offset+pos)});
     pos+=length;
     field('stage','Verifying last Box part '+(i+1)+' / '+audit.entries.length+' ('+(100*pos/part.size).toFixed(1)+'%)');
    }
   }
   const checked=await local('/audit-finish',secret,'');
   if(checked.resume_offset!==audit.bytes)throw Error('Audit offset mismatch');
   show('Last completed part verified ('+checked.verified_parts+' checked). Resume byte '+checked.resume_offset);
  }catch(e){try{await local('/audit-abort',secret,'')}catch{}throw e;}
  if(cancelled)throw Error('Cancelled');
  const initial=await local('/start',secret,JSON.stringify({name,size,settings:{partSize:PART,blockSize:BLOCK,folderId:settings.folderId}}),{'Content-Type':'application/json'});started=true;
  if(initial.resume_offset!==audit.bytes || initial.existing_parts!==audit.parts)throw Error('Box part inventory changed during audit; STOP.');
  let offset=initial.resume_offset||0;const resume=initial.existing_parts||0,count=initial.count;
  record.size=size;record.completedParts=resume;record.status='uploading';record.updatedAt=new Date().toISOString();await saveRecord(record);
  const startedAt=performance.now();let downloaded=0,lastUploadBps=0,fastStreak=0;
  update(offset,size,resume,count,resume,0,'Downloading');
  show('Resumed from part '+resume+'/'+count+' at byte '+offset.toLocaleString()+'; source: '+name);
  while(offset<size){
   if(cancelled)throw Error('Cancelled');
   const maxLen=Math.min(PART-(offset%PART),size-offset);
   const fetched=await fetchWithFallback(url,offset,maxLen,size,settings,currentBlockMiB);
   const {len:length,data:bytes}=fetched;
   if(fetched.mb<currentBlockMiB){currentBlockMiB=fetched.mb;fastStreak=0;}
   else if(settings.blockMode==='adaptive'){
     // Conservative adjustment: only step up after four fast successful blocks.
     fastStreak=fetched.seconds<1.5?fastStreak+1:0;
     if(fastStreak>=4 && currentBlockMiB<settings.probeMaxMiB){currentBlockMiB=Math.min(settings.probeMaxMiB,currentBlockMiB*2);fastStreak=0;}
   }
   field('activeBlock',currentBlockMiB+' MiB');
   if(cancelled)throw Error('Cancelled');
   const boundary=(offset+length)%PART===0 || offset+length===size;
   if(boundary)field('stage','Uploading and verifying current part on Box...');
   const j=await local('/block',secret,bytes,{'Content-Type':'application/octet-stream','X-Offset':String(offset)});
   offset+=length;downloaded+=length;
   if(j.part>record.completedParts){record.completedParts=j.part;record.updatedAt=new Date().toISOString();await saveRecord(record);}
   if(j.last_upload_bps)lastUploadBps=j.average_upload_bps||j.last_upload_bps;
   const elapsed=Math.max(0.001,(performance.now()-startedAt)/1000);
   const effective=downloaded/elapsed;
   update(offset,size,j.part,count,resume,lastUploadBps||effective,'Downloading / uploading');
   show('Transferred '+fmt(offset)+' / '+fmt(size)+'; current RAM buffer '+fmt(j.buffered));
  }
  show('All parts uploaded. Independently re-reading original ChatGPT ZIP for whole-file SHA-1...');
  await local('/verify-start',secret,'');
  let verifyOffset=0;field('stage','Verifying original ZIP SHA-1');
  while(verifyOffset<size){
   if(cancelled)throw Error('Cancelled');
   const length=Math.min(BLOCK,size-verifyOffset);
   const bytes=await range(url,verifyOffset,length,size);
   await local('/verify-block',secret,bytes,{'Content-Type':'application/octet-stream','X-Offset':String(verifyOffset)});
   verifyOffset+=length;
   field('stage','Source verification: '+(100*verifyOffset/size).toFixed(2)+'%');
  }
  show('Source verified. Independently downloading Box parts to calculate reconstructed full-file SHA-1; this can take a while...');
  field('stage','Verifying all Box parts');
  const done=await local('/finish',secret,'');started=false;
  record.status='verified';record.completedParts=count;record.updatedAt=new Date().toISOString();await saveRecord(record);
  field('stage','100% verified');show('VERIFIED COMPLETE: '+done.parts+' parts; missing SHA-1 sidecars created: '+done.sidecars_created+'. Full archive SHA-1: '+done.sha1);
 }catch(e){record.status='interrupted';record.updatedAt=new Date().toISOString();await saveRecord(record);show('ERROR: '+String(e.message||e));if(started){try{const j=await local('/abort',secret,'');show($('log').textContent+'\nCompleted parts retained: '+j.parts_kept)}catch(x){show($('log').textContent+'\nAbort failed: '+x.message)}}}
 finally{active=false;$('resumePrevious').disabled=false;$('newBackup').disabled=false;controller=null;}
};


// Read-only signature inspection. ZIP method is for the first local entry only,
// not a claim about every entry in a potentially mixed-method archive.
function identify(bytes){
 const a=new Uint8Array(bytes),has=(...b)=>b.every((v,i)=>a[i]===v);
 const ascii=(start,n)=>String.fromCharCode(...a.slice(start,start+n));
 if(has(0x50,0x4b,0x03,0x04) && a.length>=30){
   const method=a[8]|(a[9]<<8), flags=a[6]|(a[7]<<8),level=(flags>>1)&3;
   const methods={0:'Stored (no compression)',8:'Deflate',9:'Deflate64',12:'BZIP2',14:'LZMA',93:'Zstandard',95:'XZ',99:'AES-encrypted'};
   return {format:'ZIP',compression:(methods[method]||'ZIP method '+method)+' (first entry)',level:method===8?['Normal','Maximum (hint)','Fast (hint)','Super-fast (hint)'][level]+'; exact level unavailable':'Not specified'};
 }
 if(has(0x50,0x4b,0x05,0x06)||has(0x50,0x4b,0x07,0x08))return {format:'ZIP',compression:'Entry metadata not in initial header',level:'Unknown'};
 if(has(0x37,0x7a,0xbc,0xaf,0x27,0x1c))return {format:'7z',compression:'Method stored in archive metadata (not inspected)',level:'Exact preset unavailable'};
 if(has(0x52,0x61,0x72,0x21,0x1a,0x07))return {format:a[6]===1?'RAR5':'RAR',compression:'Per-file method in archive metadata',level:'Not determined'};
 if(has(0x1f,0x8b))return {format:'GZIP',compression:'Deflate',level:a[8]===2?'Maximum-compression hint':a[8]===4?'Fast-compression hint':'Unspecified'};
 if(has(0xfd,0x37,0x7a,0x58,0x5a,0x00))return {format:'XZ',compression:'Typically LZMA2 (block header not inspected)',level:'Preset not stored explicitly'};
 if(has(0x28,0xb5,0x2f,0xfd))return {format:'Zstandard',compression:'Zstandard',level:'Exact level unavailable'};
 if(has(0x42,0x5a,0x68))return {format:'BZIP2',compression:'Burrows-Wheeler + Huffman',level:'Block size indicator '+String.fromCharCode(a[3]||63)};
 if(a.length>=262 && ascii(257,5)==='ustar')return {format:'TAR',compression:'None (plain TAR)',level:'Not applicable'};
 if(a.length>=0x8006 && ascii(0x8001,5)==='CD001')return {format:'ISO9660',compression:'No archive-level compression',level:'Not applicable'};
 return {format:'Unknown',compression:'Not determined by signature',level:'Unknown'};
}
async function sourceForInspection(){
 const entered=$('sourceUrl').value.trim();let url;
 if(entered){const u=new URL(entered);if(u.protocol!=='https:' && !(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw Error('Only HTTPS or local HTTP URLs allowed');const permission={origins:[u.origin+'/*']};if(!(await chrome.permissions.contains(permission))&&!(await chrome.permissions.request(permission)))throw Error('Site permission denied');url=entered;}
 else {const items=await chrome.downloads.search({orderBy:['-startTime'],limit:100});url=items.find(x=>(x.finalUrl||'').startsWith('https://chatgpt.com/backend-api/estuary/content'))?.finalUrl;if(!url)throw Error('No recent ChatGPT download found');}
 const head=await fetch(url,{method:'HEAD',credentials:'include',cache:'no-store'});if(!head.ok)throw Error('HEAD HTTP '+head.status);const size=Number(head.headers.get('content-length'));if(!Number.isSafeInteger(size)||size<=0)throw Error('Unknown source size');return {url,size};
}
async function inspect(sample){
 if(active)throw Error('Wait for the transfer to finish');
 const {url,size}=await sourceForInspection();
 const len=Math.min(65536,size);const header=await range(url,0,len,size);const result=identify(header);
 field('archiveFormat',result.format);field('archiveCompression',result.compression);field('archiveLevel',result.level);
 if(!sample){show('Archive header inspected without extraction.');return;}
 const {sessionSecret:secret}=await chrome.storage.local.get('sessionSecret');if(!secret)throw Error('Configure the session secret first');
 const settings=await loadSettings();
 const total=Math.min(settings.sampleMiB*MiB,size);
 const segments=settings.sampling==='beginning'?1:settings.sampling==='adaptive'?Math.min(8,Math.max(2,Math.ceil(total/(16*MiB)))):4;
 const sizes=Array.from({length:segments},(_,i)=>Math.floor(total/segments)+(i<total%segments?1:0));
 field('archiveSaving','Sampling '+fmt(total)+'...');
 await local('/estimate-start',secret,JSON.stringify({preset:settings.preset}),{'Content-Type':'application/json'});
 for(let i=0;i<segments;i++){
   const len=sizes[i];if(!len)continue;
   const begin=settings.sampling==='beginning'?sizes.slice(0,i).reduce((a,b)=>a+b,0):Math.floor((size-len)*i/Math.max(1,segments-1));
   for(let j=0;j<len;j+=8*MiB){
     const n=Math.min(8*MiB,len-j);
     const data=await range(url,begin+j,n,size);
     await local('/estimate-block',secret,data,{'Content-Type':'application/octet-stream'});
   }
 }
 const r=await local('/estimate-finish',secret,'');
 const saving=100*(1-r.compressed_bytes/r.original_bytes);
 field('archiveSaving',saving.toFixed(2)+'% measured sample reduction');
 show('Sample '+fmt(r.original_bytes)+' → '+fmt(r.compressed_bytes)+'; '+saving.toFixed(2)+'% reduction. Distributed samples were concatenated for the estimator; whole-file savings may differ.');
}
$('inspect').onclick=async()=>{try{await inspect(false)}catch(e){show('Inspection error: '+e.message)}};
$('sample').onclick=async()=>{try{await inspect(true)}catch(e){field('archiveSaving','Failed');show('Sampling error: '+e.message)}};

const defaults={compressionMode:'original',preset:9,inspect:true,estimator:false,sampleMiB:64,sampling:'distributed',blockMiB:8,blockMode:'fixed',probeMinMiB:1,probeMaxMiB:64,probeBudgetMiB:128,fallbackBlocks:true,rangeRetries:2,partSize:249999999,folderId:'0',sha1:true,sha256:false,fullVerify:true,resume:true,retries:true};
async function loadSettings(){
 const x=await chrome.storage.local.get('streamSettings');
 const s={...defaults,...(x.streamSettings||{})};
 for(const k of ['preset','sampleMiB','blockMiB','partSize','probeMinMiB','probeMaxMiB','probeBudgetMiB','rangeRetries'])s[k]=Number(s[k]);
 // Recover invalid/missing legacy block-size settings without affecting saved backup records.
 if(!Number.isInteger(s.blockMiB)||s.blockMiB<1||s.blockMiB>64)s.blockMiB=8;
 return s;
}
const settingsFields=['blockMode','probeMinMiB','probeMaxMiB','probeBudgetMiB','fallbackBlocks','rangeRetries','compressionMode','preset','inspect','estimator','sampleMiB','sampling','blockMiB','partSize','folderId','sha1','sha256','fullVerify','resume','retries'];
async function renderSettings(){const s=await loadSettings();for(const id of settingsFields){const e=$(id);if(e)e.type==='checkbox'?e.checked=!!s[id]:e.value=String(s[id]);}}
function readSettings(){
 // SELECT values are strings in Chrome. Convert numeric controls explicitly.
 const numeric=new Set(['preset','sampleMiB','blockMiB','partSize','probeMinMiB','probeMaxMiB','probeBudgetMiB','rangeRetries']);
 const o={};
 for(const id of settingsFields){
  const e=$(id);
  o[id]=e.type==='checkbox'?e.checked:numeric.has(id)?Number(e.value):e.value;
 }
 return o;
}
function validateSettings(o){if(!Number.isInteger(o.partSize)||o.partSize<1||o.partSize>249999999)throw Error('Part size must be 1..249,999,999 bytes');if(!Number.isInteger(o.blockMiB)||o.blockMiB<1||o.blockMiB>64)throw Error('Block size must be 1..64 MiB');if(!Number.isInteger(o.sampleMiB)||o.sampleMiB<8||o.sampleMiB>256)throw Error('Sample size must be 8..256 MiB');if(!['fixed','auto','adaptive'].includes(o.blockMode))throw Error('Invalid block mode');if(!Number.isInteger(o.probeMinMiB)||!Number.isInteger(o.probeMaxMiB)||o.probeMinMiB<1||o.probeMaxMiB>64||o.probeMinMiB>o.probeMaxMiB)throw Error('Invalid probe range');if(!Number.isInteger(o.probeBudgetMiB)||o.probeBudgetMiB<8||o.probeBudgetMiB>128)throw Error('Probe budget must be 8..128 MiB');if(!Number.isInteger(o.rangeRetries)||o.rangeRetries<0||o.rangeRetries>3)throw Error('Retries must be 0..3');if(!/^\d+$/.test(o.folderId))throw Error('Box folder ID must be numeric');if(o.compressionMode!=='original')throw Error('LZMA2 upload is not implemented yet');}
$('saveSettings').onclick=async()=>{try{const s=readSettings();validateSettings(s);await chrome.storage.local.set({streamSettings:s});show('Settings saved')}catch(e){show('Settings error: '+e.message)}};
$('resetSettings').onclick=async()=>{await chrome.storage.local.set({streamSettings:defaults});await renderSettings();show('Defaults restored')};
$('exportSettings').onclick=async()=>{const s=await loadSettings();const blob=new Blob([JSON.stringify(s,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='box-stream-settings.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
$('importSettings').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;const s={...defaults,...JSON.parse(await file.text())};validateSettings(s);await chrome.storage.local.set({streamSettings:s});await renderSettings();show('Settings imported')}catch(err){show('Import error: '+err.message)}};
renderSettings();
renderRecords().catch(e=>show('History error: '+e.message));
