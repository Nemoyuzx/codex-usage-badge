'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {compareVersions,selectRelease,verifyArchive,checkForUpdate,getBytes,INTERVAL}=require('../windows/update.cjs');
const data=Buffer.from('synthetic Windows archive');
const hash=crypto.createHash('sha256').update(data).digest('hex');
function release(version,extra={}) {
  const tag='v'+version+'-windows',base='https://github.com/jaykinhoo9/codex-usage-badge/releases/download/'+tag+'/';
  return {tag_name:tag,published_at:'2026-01-01T00:00:00Z',draft:false,assets:[
    {name:`CodexUsageBadge-Windows-${version}.zip`,state:'uploaded',size:data.length,digest:'sha256:'+hash,browser_download_url:base+`CodexUsageBadge-Windows-${version}.zip`},
    {name:'SHA256SUMS.txt',state:'uploaded',size:130,browser_download_url:base+'SHA256SUMS.txt'}
  ],...extra};
}
function server(releases,{badHash=false,error=false}={}) {
  const requests=[];
  const fetcher=async url=>{
    requests.push(url);
    if(error)return new Response('unavailable',{status:503});
    if(url.startsWith('https://api.github.com/'))return new Response(JSON.stringify(releases));
    if(url.endsWith('/SHA256SUMS.txt'))return new Response(`${badHash?'0'.repeat(64):hash}  ${selectRelease(releases,'0.0.0').asset.name}\n`);
    return new Response(data);
  };
  return {fetcher,requests};
}
(async()=>{
  assert.equal(compareVersions('0.10.1','0.10.0'),1);
  assert.equal(compareVersions('0.10.1','0.10.1-dev.1'),1);
  assert.equal(compareVersions('0.10.1-dev.2','0.10.1-dev.10'),-1);
  assert.equal(compareVersions('0.10.1','0.10.1'),0);
  assert.throws(()=>compareVersions('garbage','0.10.1'));
  const wrong=release('5.0.0');wrong.assets[0].browser_download_url='https://example.invalid/update.zip';
  assert.equal(selectRelease([release('0.10.2'),release('0.10.10'),release('9.0.0',{draft:true}),release('8.0.0',{tag_name:'v8.0.0-macos'}),release('7.0.0',{published_at:null}),wrong,release('6.0.0',{assets:[]})],'0.10.1').version,'0.10.10');
  assert.equal(selectRelease([release('0.10.1')],'0.10.1'),null);
  const candidate=selectRelease([release('0.10.2')],'0.10.1'),manifest=Buffer.from(`${hash}  ${candidate.asset.name}\n`);
  assert.equal(verifyArchive(data,manifest,candidate),hash);
  assert.throws(()=>verifyArchive(Buffer.from('corrupt'),manifest,candidate),/size/);
  assert.throws(()=>verifyArchive(data,Buffer.from(manifest+'\n'+manifest),candidate),/duplicated/);
  assert.throws(()=>verifyArchive(data,manifest,{...candidate,asset:{...candidate.asset,digest:'sha256:wrong'}}),/digest/);
  let installs=0,records=[];const api=server([release('0.10.2')]);
  const options={current:'0.10.1',fetcher:api.fetcher,record:async value=>records.push(value),now:()=>100000000,installPackage:async payload=>{assert.equal(payload.hash,hash);assert.equal(payload.version,'0.10.2');assert.deepEqual(payload.data,data);installs++;}};
  assert.equal((await checkForUpdate(options)).event,'updated');
  assert.equal(installs,1);assert.deepEqual(records.map(v=>v.event),['checking','installing','updated']);assert.equal(api.requests.length,3);
  assert.equal((await checkForUpdate({...options,state:records.at(-1)})).event,'not-due');assert.equal(api.requests.length,3);
  const offline=server([],{error:true});records=[];
  await assert.rejects(checkForUpdate({...options,fetcher:offline.fetcher}),/503/);assert.equal(records.at(-1).event,'error');
  assert.equal((await checkForUpdate({...options,state:records.at(-1)})).event,'not-due');
  records=[];await assert.rejects(checkForUpdate({...options,fetcher:server([release('0.10.2')],{badHash:true}).fetcher}),/checksum/);assert.equal(installs,1);
  records=[];await assert.rejects(checkForUpdate({...options,installPackage:async()=>{throw Error('fixture rollback');}}),/rollback/);assert.equal(records.at(-1).event,'error');
  assert.equal((await checkForUpdate({...options,fetcher:server([release('0.10.0')]).fetcher,force:true,state:{checkedAt:100000000}})).event,'up-to-date');
  assert.equal((await checkForUpdate({...options,state:{checkedAt:100000000+INTERVAL}})).event,'updated');
  await assert.rejects(getBytes('fixture',2,async()=>new Response('too large')),/size limit/);
  console.log('PASS Windows update versions, platform filter, trusted asset URLs, SHA-256, interval, offline retry, corruption, failed install, manual check');
})().catch(error=>{console.error(error);process.exitCode=1;});
