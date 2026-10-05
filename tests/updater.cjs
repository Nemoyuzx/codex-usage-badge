'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {compareVersions,selectRelease,readArchive,extractArchive,updateOnce,acquireLock,writeJson,readJson,fetchBytes}=require('../updater/core.cjs');
const repo='jaykinhoo9/codex-usage-badge',version='0.9.5';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function crc(data){let n=0xffffffff;for(const byte of data){n^=byte;for(let i=0;i<8;i++)n=n&1?(n>>>1)^0xedb88320:n>>>1;}return(n^0xffffffff)>>>0;}
function zip(entries){
  let offset=0;const locals=[],central=[];
  for(const [name,data,mode=0o100644] of entries){
    const b=Buffer.isBuffer(data)?data:Buffer.from(data),n=Buffer.from(name),h=Buffer.alloc(30),c=Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt32LE(crc(b),14);h.writeUInt32LE(b.length,18);h.writeUInt32LE(b.length,22);h.writeUInt16LE(n.length,26);
    c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt32LE(crc(b),16);c.writeUInt32LE(b.length,20);c.writeUInt32LE(b.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE((mode<<16)>>>0,38);c.writeUInt32LE(offset,42);
    locals.push(h,n,b);central.push(c,n);offset+=h.length+n.length+b.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
const contents=Object.fromEntries(['agent.cjs','manage.cjs','macos/shortcuts.cjs','macos/startup/bridge','macos/startup/controller.cjs','macos/startup/watch.cjs','updater/core.cjs','updater/worker.cjs','updater/run.sh'].map(n=>[n,Buffer.from('fixture') ]));
contents['update.json']=Buffer.from(JSON.stringify({schema:1,repository:repo,platform:'macOS',version}));
contents['SHA256SUMS.txt']=Buffer.from(Object.entries(contents).map(([n,b])=>`${hash(b)}  ${n}\n`).join(''));
const entries=Object.entries(contents).map(([n,b])=>[`CodexUsageBadge-macOS-${version}/${n}`,b,n.endsWith('bridge')?0o100755:0o100644]);
const archive=zip(entries);
function release(v=version,{platform='macOS',digest=hash(archive),...extra}={}){
  const tag=`v${v}-${platform==='macOS'?'macos':'windows'}`,name=`CodexUsageBadge-${platform}-${v}.zip`;
  return {tag_name:tag,published_at:'2026-01-01',draft:false,prerelease:true,assets:[{name,state:'uploaded',size:archive.length,digest:'sha256:'+digest,browser_download_url:`https://github.com/${repo}/releases/download/${tag}/${name}`}],...extra};
}
assert.equal(compareVersions('0.10.0','0.9.99'),1);assert.equal(compareVersions('1.0.0','1.0.0'),0);assert.throws(()=>compareVersions('1.2','1.2.3'));
assert.equal(selectRelease([release('0.10.1'),release('9.0.0',{platform:'Windows'}),release('0.9.9')],'0.9.4').version,'0.10.1');
assert.equal(selectRelease([release('0.9.4'),release('0.9.3')],'0.9.4'),null);
assert.equal(selectRelease([release(version,{draft:true})],'0.9.4'),null);
assert.equal(selectRelease([release(version,{assets:[]})],'0.9.4'),null);
assert.equal(selectRelease([release(version)],'0.9.4',{allowPrerelease:false}),null);
const foreign=release();foreign.assets[0].browser_download_url='https://example.invalid/package.zip';assert.equal(selectRelease([foreign],'0.9.4'),null);
assert.equal(readArchive(archive,version).size,entries.length);
assert.throws(()=>readArchive(zip([...entries,[`CodexUsageBadge-macOS-${version}/../../escape`,'bad']]),version),/不安全路径/);
assert.throws(()=>readArchive(zip([...entries,[entries[0][0],'bad']]),version),/重复文件/);
assert.throws(()=>readArchive(zip(entries.map((e,i)=>i===0?[e[0],e[1],0o120777]:e)),version),/文件类型/);
assert.throws(()=>readArchive(zip([...entries,[`CodexUsageBadge-macOS-${version}/unexpected.cjs`,'bad']]),version),/未校验文件/);
assert.throws(()=>readArchive(zip(entries.map(e=>e[0].endsWith('/agent.cjs')?[e[0],'altered']:e)),version),/文件校验失败/);
assert.throws(()=>readArchive(archive,'0.9.6'),/不安全路径/);
assert.throws(()=>readArchive(archive.subarray(0,archive.length-1),version));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'badge-updater-'));
function fixture(name){
  const root=path.join(temp,name),installDir=path.join(root,'install'),cacheDir=path.join(root,'cache');fs.mkdirSync(installDir,{recursive:true});
  writeJson(path.join(installDir,'update-settings.json'),{owner:'codex-usage-badge-updater-v1',enabled:true,allowPrerelease:true});
  writeJson(path.join(installDir,'installed-version.json'),{version:'0.9.4',repository:repo,platform:'macOS'});
  return {installDir,cacheDir};
}
function mockFetch(releases,bytes=archive){return async(url,options)=>{
  assert.equal(options.headers.Authorization,undefined,'no local GitHub credential may be forwarded');
  assert.ok(!JSON.stringify(options.headers).includes(process.env.USER||'nobody-known'));
  return new Response(url.startsWith('https://api.github.com')?JSON.stringify(releases):bytes,{status:200});
};}
(async()=>{try{
  const extraction=path.join(temp,'extracted');extractArchive(readArchive(archive,version),extraction);
  assert.equal(fs.readFileSync(path.join(extraction,'agent.cjs'),'utf8'),'fixture');
  if(process.platform!=='win32')assert.ok(fs.statSync(path.join(extraction,'macos/startup/bridge')).mode&0o100);
  const built=path.join(__dirname,`../dist/CodexUsageBadge-macOS-${require('../package.json').version}.zip`);
  if(fs.existsSync(built))assert.ok(readArchive(fs.readFileSync(built),require('../package.json').version).has('安装.command'));
  let installs=0,now=1;
  const f=fixture('success');
  const install=async(stage)=>{installs++;assert.equal(fs.readFileSync(path.join(stage,'agent.cjs'),'utf8'),'fixture');writeJson(path.join(f.installDir,'installed-version.json'),{version,repository:repo,platform:'macOS'});};
  const result=await updateOnce({...f,install,fetchImpl:mockFetch([release()]),now:()=>now});
  assert.equal(result.event,'updated');assert.equal(installs,1);assert.equal(fs.readdirSync(f.cacheDir).some(n=>n.startsWith('stage-')),false);
  assert.equal((await updateOnce({...f,install,fetchImpl:()=>{throw Error('cooldown must not fetch');},now:()=>now})).event,'cooldown');
  now+=7*3600000;assert.equal((await updateOnce({...f,install,fetchImpl:mockFetch([release()]),now:()=>now})).event,'up_to_date');assert.equal(installs,1);
  const check=fixture('check');assert.equal((await updateOnce({...check,fetchImpl:mockFetch([release()]),checkOnly:true,install:()=>{throw Error('check must not install');}})).event,'available');
  const disabled=fixture('disabled');writeJson(path.join(disabled.installDir,'update-settings.json'),{owner:'codex-usage-badge-updater-v1',enabled:false});
  assert.equal((await updateOnce({...disabled,fetchImpl:()=>{throw Error('disabled must not fetch');}})).event,'disabled');
  assert.equal((await updateOnce({...disabled,force:true,checkOnly:true,fetchImpl:mockFetch([release()])})).event,'available');
  for(const [name,fetchImpl,installer] of [
    ['bad-digest',mockFetch([release(version,{digest:'0'.repeat(64)})]),()=>{throw Error('must not install');}],
    ['truncated',mockFetch([release()],archive.subarray(0,20)),()=>{throw Error('must not install');}],
    ['failed-install',mockFetch([release()]),()=>{throw Error('installer rolled back');}],
    ['offline',async()=>{throw Error('network offline');},()=>{throw Error('must not install');}],
    ['rate-limited',async()=>new Response('',{status:403}),()=>{throw Error('must not install');}]
  ]){
    const failed=fixture(name);await assert.rejects(updateOnce({...failed,fetchImpl,install:installer}));
    assert.equal(readJson(path.join(failed.installDir,'installed-version.json')).version,'0.9.4');
    assert.equal(readJson(path.join(failed.cacheDir,'state.json')).event,'error');
    assert.equal(fs.readdirSync(failed.cacheDir).some(n=>n.startsWith('stage-')||n==='check.lock'),false);
  }
  const lock=path.join(temp,'lock');const unlock=acquireLock(lock);assert.equal(acquireLock(lock),null);unlock();
  fs.mkdirSync(lock);writeJson(path.join(lock,'owner.json'),{pid:123456});const recovered=acquireLock(lock,{isAlive:()=>false});assert.equal(typeof recovered,'function');recovered();
  const concurrent=fixture('concurrent');let resolveFetch;
  const first=updateOnce({...concurrent,fetchImpl:()=>new Promise(resolve=>resolveFetch=resolve),install:()=>{throw Error('no update');}});
  assert.equal((await updateOnce({...concurrent,force:true,fetchImpl:()=>{throw Error('busy must not fetch');}})).event,'busy');
  resolveFetch(new Response('[]'));await first;
  for(const kind of ['disabled-while-downloading','newer-installed-while-downloading']){
    const changing=fixture(kind);let calls=0;
    const changingFetch=async(url,options)=>{
      if(!url.startsWith('https://api.github.com')){
        if(kind.startsWith('disabled'))writeJson(path.join(changing.installDir,'update-settings.json'),{owner:'codex-usage-badge-updater-v1',enabled:false});
        else writeJson(path.join(changing.installDir,'installed-version.json'),{version:'0.9.6',repository:repo,platform:'macOS'});
      }
      return mockFetch([release()])(url,options);
    };
    const changed=await updateOnce({...changing,fetchImpl:changingFetch,install:()=>{calls++;}});
    assert.equal(changed.event,kind.startsWith('disabled')?'disabled':'up_to_date');assert.equal(calls,0);
  }
  await assert.rejects(fetchBytes('https://github.com/x/releases/download/v/x.zip',{limit:100,fetchImpl:async()=>{const response=new Response('bad');Object.defineProperty(response,'url',{value:'https://example.invalid/payload'});return response;}}),/非 GitHub/);
  await assert.rejects(fetchBytes('https://api.github.com/test',{limit:2,fetchImpl:async()=>new Response('too big')}),/大小限制/);
  console.log('PASS macOS release selection, no downgrade, opt-out/cooldown, hash and file manifest checks, ZIP traversal/duplicates/symlink refusal, verified extraction, offline/failed install retention, check-only and concurrent/stale locks');
}finally{fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
