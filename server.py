import argparse, hashlib, json, os, secrets, threading, urllib.parse, time, io, lzma
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import requests

FOLDER='0'
PART=249_999_999
MAX_BLOCK=64*1024*1024
HOST='127.0.0.1'

class State:
    def __init__(self, token):
        self.token=token; self.secret=secrets.token_urlsafe(24); self.active=None; self.lock=threading.Lock()
        self.folder=FOLDER; self.part_size=PART; self.max_block=MAX_BLOCK; self.estimate=None; self.audit=None
        self.http=requests.Session(); self.http.headers.update({'Authorization':'Bearer '+token})
    def existing_parts(self, name, size):
        # Read Box metadata only; no file contents are downloaded.
        matches={}; offset=0
        while True:
            data=self.box('GET',f'https://api.box.com/2.0/folders/{self.folder}/items',
                params={'limit':1000,'offset':offset,'fields':'id,name,size,sha1,type'}).json()
            entries=data.get('entries',[])
            for e in entries:
                if e.get('type')!='file': continue
                m=__import__('re').fullmatch(__import__('re').escape(name)+r'\.part(\d{3,})',e.get('name',''))
                if m: matches.setdefault(int(m.group(1)),[]).append(e)
            offset+=len(entries)
            if not entries or offset>=data.get('total_count',offset): break
        count=(size+self.part_size-1)//self.part_size; parts=[]; received=0
        for i in range(1,count+1):
            group=matches.get(i,[])
            if not group: break
            if len(group)!=1: raise ValueError(f'Duplicate part {i} in Box; resolve manually')
            e=group[0]; expected=min(self.part_size,size-received)
            if e.get('size')!=expected or not e.get('sha1'):
                raise ValueError(f'Existing part {i} has wrong size or missing SHA1')
            parts.append({'name':e['name'],'size':expected,'offset':received,
                          'sha1':e['sha1'],'box_file_id':e['id']})
            received+=expected
        if any(i>len(parts) for i in matches):
            raise ValueError('Non-contiguous existing parts detected; cannot safely resume')
        return parts,received
    def upload_file(self,name,blob,mime):
        attrs=json.dumps({'name':name,'parent':{'id':self.folder}})
        response=self.http.post('https://upload.box.com/api/2.0/files/content',
            files={'attributes':(None,attrs,'application/json'),
                   'file':(name,blob,mime)},timeout=600)
        if not response.ok: raise RuntimeError(f'Box upload {name} HTTP {response.status_code}: {response.text[:500]}')
        return response.json()['entries'][0]
    def box(self, method, url, **kw):
        r=self.http.request(method,url,timeout=180,**kw)
        if not r.ok: raise RuntimeError(f'Box HTTP {r.status_code}: {r.text[:700]}')
        return r

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def headers_common(self):
        self.send_header('Access-Control-Allow-Origin',self.headers.get('Origin','null') if self.headers.get('Origin','').startswith('chrome-extension://') else 'null')
        self.send_header('Access-Control-Allow-Headers','Content-Type,X-Stream-Secret,X-Offset')
        self.send_header('Access-Control-Allow-Methods','POST,OPTIONS,GET')
        self.send_header('Cache-Control','no-store')
    def reply(self, code, obj):
        body=json.dumps(obj).encode(); self.send_response(code); self.headers_common(); self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def do_OPTIONS(self): self.send_response(204);self.headers_common();self.end_headers()
    def do_GET(self):
        if self.path=='/status':
            if self.headers.get('X-Stream-Secret')!=self.server.state.secret: return self.reply(403,{'error':'Invalid session secret'})
            return self.reply(200,{'ready':True,'transfer':({'size':self.server.state.active['size'],'received':self.server.state.active['received'],'buffered':len(self.server.state.active['pending']),'parts':len(self.server.state.active['parts']),'stage':self.server.state.active['stage']} if self.server.state.active else None)})
        self.reply(404,{'error':'not found'})
    def do_POST(self):
        st=self.server.state
        if self.headers.get('X-Stream-Secret')!=st.secret: return self.reply(403,{'error':'Unauthorized local request'})
        try:
            n=int(self.headers.get('Content-Length','0'))
            if n<0 or n>PART+1024*1024: raise ValueError('Invalid request size')
            if self.path=='/estimate-start':
                data=json.loads(self.rfile.read(n)); preset=int(data.get('preset',9))
                if not 0<=preset<=9: raise ValueError('Preset must be 0-9')
                st.estimate={'encoder':lzma.LZMACompressor(format=lzma.FORMAT_XZ,preset=preset),'original':0,'compressed':0,'preset':preset}
                return self.reply(200,{'started':True})
            if self.path=='/estimate-block':
                if not 0<n<=st.max_block or not st.estimate: raise ValueError('Estimator not started or invalid block')
                block=self.rfile.read(n)
                if len(block)!=n: raise ValueError('Incomplete estimator block')
                st.estimate['original']+=n
                st.estimate['compressed']+=len(st.estimate['encoder'].compress(block))
                return self.reply(200,{'sampled_bytes':st.estimate['original']})
            if self.path=='/estimate-finish':
                if not st.estimate: raise ValueError('Estimator not started')
                e=st.estimate; e['compressed']+=len(e['encoder'].flush());st.estimate=None
                return self.reply(200,{'original_bytes':e['original'],'compressed_bytes':e['compressed'],'preset':e['preset']})
            if self.path=='/estimate':
                if not 0<n<=st.max_block: raise ValueError('Sample exceeds configured block size')
                sample=self.rfile.read(n)
                if len(sample)!=n: raise ValueError('Incomplete sample')
                compressed=lzma.compress(sample,format=lzma.FORMAT_XZ,preset=9)
                return self.reply(200,{'original_bytes':n,'compressed_bytes':len(compressed),'format':'XZ/LZMA2','preset':9})
            if self.path=='/audit-start':
                if st.active or st.audit: raise ValueError('Transfer or audit already active')
                data=json.loads(self.rfile.read(n)); name=os.path.basename(data['name']).replace('\\','_')
                size=int(data['size']); cfg=data.get('settings') or {}
                part_size=int(cfg.get('partSize',PART)); folder=str(cfg.get('folderId',FOLDER))
                if not name or size<=0 or not 1<=part_size<=PART or not folder.isdigit(): raise ValueError('Invalid audit parameters')
                st.part_size=part_size; st.folder=folder
                parts,received=st.existing_parts(name,size)
                st.audit={'parts':parts[-1:] if parts else [],'index':0,'position':0,'hash':hashlib.sha1(),'received':received}
                return self.reply(200,{'parts':len(parts),'bytes':received,'entries':[{'size':p['size'],'sha1':p['sha1'],'offset':p['offset']} for p in st.audit['parts']]})
            if self.path=='/audit-block':
                a=st.audit
                if not a or a['index']>=len(a['parts']): raise ValueError('No pending part audit')
                offset=int(self.headers.get('X-Offset','-1'))
                part=a['parts'][a['index']]
                if offset!=part['offset']+a['position'] or not 0<n<=MAX_BLOCK or a['position']+n>part['size']: raise ValueError('Audit range is not contiguous')
                blob=self.rfile.read(n)
                if len(blob)!=n: raise ValueError('Short audit block')
                a['hash'].update(blob);a['position']+=n
                if a['position']==part['size']:
                    digest=a['hash'].hexdigest()
                    if digest.lower()!=part['sha1'].lower():
                        st.audit=None
                        raise ValueError(f'SOURCE MISMATCH in last existing Box part at byte {part["offset"]}: source SHA1 {digest}, Box SHA1 {part["sha1"]}. STOPPED. Do not resume.')
                    a['index']+=1;a['position']=0;a['hash']=hashlib.sha1()
                return self.reply(200,{'verified_parts':a['index']})
            if self.path=='/audit-finish':
                a=st.audit
                if not a or a['index']!=len(a['parts']): raise ValueError('Audit not complete')
                result={'verified_parts':len(a['parts']),'resume_offset':a['received']}
                st.audit=None
                return self.reply(200,result)
            if self.path=='/audit-abort':
                st.audit=None
                return self.reply(200,{'aborted':True})
            if self.path=='/start':
                data=json.loads(self.rfile.read(n)); name=os.path.basename(data['name']).replace('\\','_')
                size=int(data['size'])
                if size<=0 or size>9007199254740991 or not name or name in ('.','..'): raise ValueError('Invalid file name or size')
                if st.active or st.audit: raise ValueError('A transfer or audit is already active')
                config=data.get('settings') or {}
                part_size=int(config.get('partSize',PART))
                max_block=int(config.get('blockSize',MAX_BLOCK))
                folder=str(config.get('folderId',FOLDER))
                if not (1 <= part_size <= PART): raise ValueError('Invalid part size; maximum is 249999999 bytes')
                if not (1 <= max_block <= MAX_BLOCK): raise ValueError('Invalid block size; maximum is 64 MiB')
                if not folder.isdigit(): raise ValueError('Invalid Box folder ID')
                st.part_size=part_size; st.max_block=max_block; st.folder=folder
                count=(size+st.part_size-1)//st.part_size
                parts,received=st.existing_parts(name,size)
                # Existing parts are resumed from Box metadata; sidecars are optional.
                # Missing sidecars are backfilled only after all parts are uploaded.
                st.active={'size':size,'received':received,'name':name,'count':count,'parts':parts,
                           'pending':bytearray(),'resumed_parts':len(parts),'upload_seconds':0.0,'uploaded_bytes':0,'last_upload_bps':0.0,'stage':'download','verification':None}
                print(f'Resuming at byte {received:,} with {len(parts)} verified Box parts',flush=True)
                return self.reply(200,{'part_size':st.part_size,'max_block':st.max_block,'name':name,'size':size,'count':count,
                                       'resume_offset':received,'existing_parts':len(parts),'parts':parts})
            if self.path=='/block':
                a=st.active
                if not a: raise ValueError('No active transfer')
                offset=int(self.headers.get('X-Offset','-1'))
                if offset!=a['received']+len(a['pending']): raise ValueError('Unexpected offset')
                if not 0<n<=st.max_block: raise ValueError('Block exceeds configured limit')
                if offset+n>a['size']: raise ValueError('Block exceeds archive size')
                if len(a['pending'])+n>st.part_size: raise ValueError('Block crosses Box part boundary')
                block=self.rfile.read(n)
                if len(block)!=n: raise ValueError('Incomplete block')
                a['pending'].extend(block)
                completed=len(a['pending'])==st.part_size or offset+n==a['size']
                if completed:
                    chunk=a['pending']
                    index=len(a['parts'])+1
                    partname=f'{a["name"]}.part{index:03d}'
                    # Folder is selected through the State object, not the request handler.
                    digest=hashlib.sha1(chunk).hexdigest()
                    t0=time.monotonic(); a['stage']='upload'
                    entry=st.upload_file(partname,bytes(chunk),'application/octet-stream')
                    elapsed=max(0.001,time.monotonic()-t0)
                    if entry.get('sha1','').lower()!=digest:
                        raise ValueError(f'Part {index} SHA-1 mismatch: source {digest}, Box {entry.get("sha1")}; STOPPED')
                    sha_text=f'{digest}  {partname}\n'.encode('ascii')
                    a['parts'].append({'name':partname,'size':len(chunk),'offset':a['received'],'sha1':digest,'box_file_id':entry['id']})
                    a['upload_seconds']+=elapsed; a['uploaded_bytes']+=len(chunk)
                    a['last_upload_bps']=len(chunk)/elapsed
                    a['received']+=len(chunk)
                    a['pending']=bytearray(); a['stage']='download'
                    print(f'Part {index}/{a["count"]} uploaded; {a["received"]:,}/{a["size"]:,} bytes',flush=True)
                return self.reply(200,{'received':a['received'],'buffered':len(a['pending']),'part':len(a['parts']),'count':a['count'],'last_upload_bps':a['last_upload_bps'],'average_upload_bps':a['uploaded_bytes']/a['upload_seconds'] if a['upload_seconds'] else 0,'stage':a['stage']})
            if self.path=='/verify-start':
                a=st.active
                if not a or a['received']!=a['size'] or a['pending']: raise ValueError('All parts must be uploaded before verification')
                a['source_hasher']=hashlib.sha1(); a['source_verified_bytes']=0
                a['stage']='source-verification'
                return self.reply(200,{'verify_offset':0})
            if self.path=='/verify-block':
                a=st.active
                if not a or 'source_hasher' not in a: raise ValueError('Verification not started')
                offset=int(self.headers.get('X-Offset','-1'))
                if offset!=a['source_verified_bytes']: raise ValueError('Source verification offset mismatch')
                if not 0<n<=st.max_block or offset+n>a['size']: raise ValueError('Invalid source verification block')
                block=self.rfile.read(n)
                if len(block)!=n: raise ValueError('Short source verification block')
                a['source_hasher'].update(block);a['source_verified_bytes']+=n
                return self.reply(200,{'verified_bytes':a['source_verified_bytes'],'size':a['size']})
            if self.path=='/finish':
                a=st.active
                if not a or a['received']!=a['size'] or a['pending']: raise ValueError('Incomplete upload')
                if a.get('source_verified_bytes')!=a['size']: raise ValueError('Source full-file SHA-1 verification not completed')
                source_sha1=a['source_hasher'].hexdigest()
                # Independently read each Box part, sequentially, without creating a combined ZIP.
                a['stage']='box-verification'; box_hasher=hashlib.sha1(); box_total=0
                for i,part in enumerate(a['parts'],1):
                    ph=hashlib.sha1(); bytes_read=0
                    with st.http.get(f'https://api.box.com/2.0/files/{part["box_file_id"]}/content',stream=True,timeout=180,allow_redirects=True) as r:
                        if not r.ok: raise RuntimeError(f'Box download part {i} HTTP {r.status_code}')
                        for block in r.iter_content(chunk_size=1024*1024):
                            if not block: continue
                            ph.update(block);box_hasher.update(block);bytes_read+=len(block);box_total+=len(block)
                    if bytes_read!=part['size'] or ph.hexdigest()!=part['sha1']:
                        raise ValueError(f'Box part {i} failed independent re-download checksum check')
                box_sha1=box_hasher.hexdigest()
                if box_total!=a['size'] or box_sha1!=source_sha1:
                    raise ValueError(f'Full archive mismatch! source={source_sha1}, Box={box_sha1}; parts retained')
                # Backfill sidecars only after successful full verification. Existing
                # sidecars are preserved; no duplicates or overwrite attempts.
                inventory=set()
                page=0
                while True:
                    listing=st.box('GET',f'https://api.box.com/2.0/folders/{st.folder}/items',params={'limit':1000,'offset':page,'fields':'id,name,type'}).json()
                    entries=listing.get('entries',[])
                    inventory.update(e['name'] for e in entries if e.get('type')=='file')
                    page+=len(entries)
                    if not entries or page>=listing.get('total_count',page): break
                sidecars_created=0
                for part in a['parts']:
                    side=part['name']+'.sha1'
                    if side in inventory: continue
                    content=f'{part["sha1"]}  {part["name"]}\n'.encode('ascii')
                    st.upload_file(side,content,'text/plain')
                    inventory.add(side)
                    sidecars_created+=1
                manifest={'format':'chatgpt-box-split-v2','original_name':a['name'],
                    'original_size':a['size'],'source_sha1':source_sha1,'box_reconstructed_sha1':box_sha1,
                    'verified':True,'verification':'Independent sequential source ranged GET and Box part GET SHA-1 comparison',
                    'part_size':st.part_size,'parts':a['parts']}
                blob=json.dumps(manifest,indent=2).encode('utf-8')
                filename=a['name']+'.manifest.json'
                mid=st.upload_file(filename,blob,'application/json')['id']
                full_sha_text=f'{source_sha1}  {a["name"]}\n'.encode('ascii')
                full_id=st.upload_file(a['name']+'.sha1',full_sha_text,'text/plain')['id']
                st.active=None
                print(f'VERIFIED COMPLETE: {len(manifest["parts"])} parts; SHA1 {source_sha1}',flush=True)
                return self.reply(200,{'success':True,'parts':len(manifest['parts']),
                    'manifest_file_id':mid,'sha1_file_id':full_id,'sha1':source_sha1,'verified':True,'sidecars_created':sidecars_created})
            if self.path=='/abort':
                # Keep completed parts for manual recovery; never silently delete backups.
                saved=len(st.active['parts']) if st.active else 0
                st.active=None
                return self.reply(200,{'aborted':True,'parts_kept':saved})
            self.reply(404,{'error':'not found'})
        except Exception as e: self.reply(400,{'error':str(e)})

def main():
    from getpass import getpass
    print('Box developer tokens expire quickly. Never paste tokens into chat.')
    token=getpass('Box developer access token (hidden): ').strip()
    if not token: raise SystemExit('No token supplied')
    st=State(token)
    try: print('Authenticated Box account:',st.box('GET','https://api.box.com/2.0/users/me').json()['name'])
    except Exception as e: raise SystemExit(f'Authentication failed: {e}')
    srv=ThreadingHTTPServer((HOST,8765),Handler);srv.state=st;srv.extension_id=''
    print('Local stream receiver ready at http://127.0.0.1:8765')
    print('Keep this window open. Configure the Chrome extension with the session secret below.')
    print('SESSION SECRET:',st.secret)
    print('Automatic split count for any positive known file size; 249,999,999 bytes per Box file.')
    try: srv.serve_forever()
    except KeyboardInterrupt: pass
if __name__=='__main__': main()
