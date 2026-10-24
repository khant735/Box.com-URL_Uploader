// Diagnostic-only. Never cancel downloads or read/store authentication credentials.
const MAX=30;
function relevant(d){const s=[d.url,d.finalUrl,d.filename,d.mime].filter(Boolean).join(' ').toLowerCase();return s.includes('chatgpt.com')||s.includes('estuary/content')||s.includes('.zip')||s.includes('application/zip');}
function safeUrl(u){try{const x=new URL(u);return x.origin+x.pathname;}catch{return '(unavailable)';}}
async function record(entry){const {diagnostics=[]}=await chrome.storage.local.get('diagnostics');diagnostics.unshift({time:new Date().toISOString(),...entry});await chrome.storage.local.set({diagnostics:diagnostics.slice(0,MAX)});console.log('[ZIP diagnostic]',entry);}
chrome.downloads.onCreated.addListener(d=>{if(!relevant(d))return;record({event:'created',id:d.id,url:safeUrl(d.url),finalUrl:safeUrl(d.finalUrl),filename:d.filename||'',mime:d.mime||'',totalBytes:d.totalBytes,state:d.state});});
chrome.downloads.onChanged.addListener(async d=>{if(!d.state&&!d.error&&!d.totalBytes&&!d.filename)return;let item;try{item=(await chrome.downloads.search({id:d.id}))[0]}catch{}if(!item||!relevant(item))return;record({event:'changed',id:d.id,state:d.state?.current||item.state,error:d.error?.current||'',totalBytes:d.totalBytes?.current??item.totalBytes,filename:item.filename||''});});

// On-demand, headers-only diagnostics. Never persist full signed URLs, cookies, or response bodies.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action !== 'probeLatest') return;
  (async () => {
    const entries = await chrome.downloads.search({orderBy:['-startTime'],limit:100});
    const item = entries.find(d => relevant(d) && (d.finalUrl||d.url||'').includes('chatgpt.com'));
    if (!item) throw Error('No recent ChatGPT download found. Start a download and cancel it if disk space is limited.');
    const target = item.finalUrl || item.url;
    if (!target.startsWith('https://chatgpt.com/')) throw Error('Final URL is not on chatgpt.com');
    const output={downloadId:item.id, source:safeUrl(target), browserTotalBytes:item.totalBytes, probes:[]};
    for (const method of ['HEAD','GET']) {
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),12000);
      try {
        const headers = method==='GET' ? {'Range':'bytes=0-0'} : {};
        const response=await fetch(target,{method,headers,credentials:'include',cache:'no-store',redirect:'follow',signal:controller.signal});
        const h=response.headers;
        output.probes.push({method,status:response.status,finalOriginPath:safeUrl(response.url),contentLength:h.get('content-length'),contentRange:h.get('content-range'),acceptRanges:h.get('accept-ranges'),contentType:h.get('content-type'),redirected:response.redirected,warning:method==='GET'&&response.status===200?'Range ignored: response body cancelled immediately':undefined});
        // Do not consume even one response-body byte. Cancel immediately.
        if(response.body) await response.body.cancel();
      } catch(e) {output.probes.push({method,error:String(e.message||e)});}
      finally {clearTimeout(timer);}
    }
    return output;
  })().then(sendResponse,e=>sendResponse({error:String(e.message||e)}));
  return true;
});
