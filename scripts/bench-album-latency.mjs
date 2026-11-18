// Actual preview save pipeline, old HEAD vs working tree, synthetic photos only.
// HTTP and MongoDB are isolated locally. --live-r2 opts into temporary R2
// objects under one UUID namespace, journalled before writing and removed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import sharp from 'sharp';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { config } from '../src/config.js';
import { budget } from '../src/services/capacity.js';
import { r2Storage, validateR2Config, R2_REF } from '../src/services/r2.js';

const args=process.argv.slice(2);
if(!args.includes('--live-r2')){console.log('Use --live-r2 to measure the isolated pipeline with temporary R2 preview files. No production API or database is used.');process.exit(0)}
const opt=(name,fallback)=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3)||fallback;
const count=Number(opt('photos','12')),rounds=Number(opt('rounds','2')),busyMs=Number(opt('busy-ms','3000'));
assert.ok(Number.isInteger(count)&&count>=1&&count<=12);
assert.ok(Number.isInteger(rounds)&&rounds>=1&&rounds<=3);
assert.ok(busyMs>=0&&busyMs<=10000);
const root=fileURLToPath(new URL('..',import.meta.url));
const baseline=execFileSync('git',['rev-parse',opt('baseline','HEAD')],{cwd:root,encoding:'utf8'}).trim();
const captureURL=new URL('../src/services/capture.js',import.meta.url);
const queueURL=new URL('../src/services/image-save-queue.js',import.meta.url);
const oldCapture=execFileSync('git',['show',`${baseline}:src/services/capture.js`],{cwd:root,encoding:'utf8'});
const oldQueue=execFileSync('git',['show',`${baseline}:src/services/image-save-queue.js`],{cwd:root,encoding:'utf8'});
const newCapture=await readFile(captureURL,'utf8');
const namespace=`bench-album-latency-${randomUUID()}`;
const originalPrefix=config.r2.prefix;
const prefix=`${R2_REF}${originalPrefix.replace(/\/?$/,'/')}${namespace}/`;
const ledger=resolve(root,'.cache',`${namespace}-cleanup.json`);
const output=resolve(root,opt('output','.cache/bench-album-latency.json'));
const files=new Set(),activeJobs=new Set(),results=[];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const log=(event,detail={})=>console.log(JSON.stringify({event,...detail}));
let memory,server,Booking,currentRun,saveOriginal,journal=Promise.resolve();
function moduleURL(source,original,queueOverride){
  const code=source.replace(/from (["'])([^"']+)\1/g,(_,quote,path)=>
    `from ${JSON.stringify(queueOverride&&path==='./image-save-queue.js'?queueOverride:path.startsWith('.')?new URL(path,original).href:import.meta.resolve(path))}`);
  return 'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
}
const median=values=>{const s=[...values].sort((a,b)=>a-b),i=Math.floor(s.length/2);return s.length%2?s[i]:(s[i-1]+s[i])/2};
async function cleanup(names){
  if(!names.length)return;
  assert.ok(names.every(name=>name.startsWith(prefix)),'refuse deletion outside this benchmark namespace');
  await r2Storage.deleteMany(names);
}
async function listed(){
  const response=await r2Storage.client().send(new ListObjectsV2Command({Bucket:config.r2.bucket,Prefix:prefix.slice(R2_REF.length)}));
  return (response.Contents||[]).map(item=>R2_REF+item.Key);
}
try{
  validateR2Config();
  config.mediaStorageProvider='r2';config.r2.prefix=prefix.slice(R2_REF.length);config.dnpPrinter='';
  process.env.PHOTO_DOWNLOAD_PREWARM='0';
  await mkdir(resolve(root,'.cache'),{recursive:true});
  await writeFile(ledger,JSON.stringify({prefix,files:[],pid:process.pid})+'\n');
  saveOriginal=r2Storage.save.bind(r2Storage);
  r2Storage.save=async(file,bytes,type)=>{
    assert.ok(file.startsWith(prefix));files.add(file);
    journal=journal.then(()=>writeFile(ledger,JSON.stringify({prefix,files:[...files],pid:process.pid})+'\n'));
    await journal;return saveOriginal(file,bytes,type);
  };
  // Same single full-image slot as the constrained server; the preview lane
  // uses the real memory fallback in production, but this case has headroom.
  budget.saves=1;
  const legacy=await import(moduleURL(oldQueue,queueURL));
  const {createImageSaveQueues}=await import(queueURL.href);
  const improved=createImageSaveQueues({fullLimit:1,previewLimit:1,use:()=>.4});
  globalThis.__albumBenchQueues=improved;
  const shim='data:text/javascript;base64,'+Buffer.from('export const {saveImageTask,savePreviewTask,isSaveQueueBusy}=globalThis.__albumBenchQueues;').toString('base64');
  const captures={old:await import(moduleURL(oldCapture,captureURL,moduleURL(oldQueue,queueURL))),new:await import(moduleURL(newCapture,captureURL,shim))};
  const queues={old:legacy,new:improved};
  memory=await MongoMemoryServer.create();await mongoose.connect(memory.getUri());
  Booking=(await import('../src/models/Booking.js')).default;await Booking.init();
  const width=6240,height=4160;
  const camera=await sharp(randomBytes(width*height*3),{raw:{width,height,channels:3}}).jpeg({quality:78}).toBuffer();
  const preview=await sharp(camera).resize({width:1600,height:1600,fit:'inside'}).jpeg({quality:92}).toBuffer();
  const thumbnail=await sharp(preview).resize({width:640,height:640,fit:'inside',withoutEnlargement:true}).jpeg({quality:78}).toBuffer();
  const fixture={cameraBytes:camera.length,cameraSha256:hash(camera),cameraPixels:width*height,previewBytes:preview.length,previewSha256:hash(preview),thumbnailSha256:hash(thumbnail)};
  log('prepared',{namespace,count,rounds,baseline:baseline.slice(0,12),fixture});
  server=createServer(async(req,res)=>{
    if(req.url!=='/preview'||!currentRun){res.writeHead(404).end();return}
    const run=currentRun;
    try{
      const chunks=[];for await(const part of req)chunks.push(part);
      const body=Buffer.concat(chunks);assert.equal(hash(body),fixture.previewSha256);
      const key=String(req.headers['x-photo-key']);assert.ok(key.startsWith(run.name));
      const task=captures[run.variant].appendCapture(run.booking._id,null,{
        clientKey:key,preview:body,previewOnly:true,imported:true,precheck:run.booking,
      });
      activeJobs.add(task);
      let saved;try{saved=await task}finally{activeJobs.delete(task)}
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({photos:saved.photos.length}));
    }catch{res.writeHead(500).end('Benchmark request failed')}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${server.address().port}/preview`;
  async function run(variant,scene,index,total=count){
    const booking=await Booking.create({status:'completed',accessToken:randomUUID(),source:'polaroid'});
    const name=`${variant}-${scene}-${index}`;
    currentRun={variant,scene,booking,name};let firstMs,next=0;
    const prior=new Set(files),start=performance.now();
    const held=queues[variant].saveImageTask(()=>new Promise(resolve=>setTimeout(resolve,scene==='busy'?busyMs:0)));
    try{
      const outcomes=await Promise.allSettled(Array.from({length:2},async()=>{
        while(next<total){
          const i=next++;
          const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'image/jpeg','X-Photo-Key':`${name}-${i}`},body:preview,signal:AbortSignal.timeout(60000)});
          assert.equal(response.status,200);await response.json();firstMs??=performance.now()-start;
        }
      }));
      const allMs=performance.now()-start;
      await held;await Promise.allSettled([...activeJobs]);
      assert.ok(outcomes.every(result=>result.status==='fulfilled'),'a preview request failed');
      const saved=await Booking.findById(booking._id).lean();assert.equal(saved.photos.length,total);
      for(const photo of saved.photos){assert.equal(photo.originalPending,true);assert.equal(photo.file,photo.previewFile)}
      assert.equal(hash(await r2Storage.read(saved.photos[0].previewFile)),fixture.previewSha256);
      assert.equal(hash(await r2Storage.read(saved.photos[0].thumbnailFile)),fixture.thumbnailSha256);
      const result={variant,scene,index,firstMs,allMs,photos:total,checksumVerified:true};log('run',result);return result;
    }finally{
      await held;await Promise.allSettled([...activeJobs]);
      await cleanup([...files].filter(file=>!prior.has(file)));
      await Booking.deleteOne({_id:booking._id});currentRun=null;
    }
  }
  await run('old','warmup',0,1);await run('new','warmup',0,1);
  for(const scene of ['idle','busy'])for(let round=0;round<rounds;round++)
    for(const variant of round%2?['new','old']:['old','new'])results.push(await run(variant,scene,round+1));
  const summary=Object.fromEntries(['idle','busy'].map(scene=>[scene,Object.fromEntries(['old','new'].map(variant=>{
    const rows=results.filter(row=>row.scene===scene&&row.variant===variant);
    return [variant,{firstMs:median(rows.map(row=>row.firstMs)),allMs:median(rows.map(row=>row.allMs))}];
  }))]));
  await cleanup([...files]);assert.deepEqual(await listed(),[]);
  const report={studyDate:'2026-11-18',recordedAt:new Date().toISOString(),baseline,currentCaptureSha256:hash(newCapture),fixture,count,rounds,busyMs,
    method:`Actual HEAD/current appendCapture, synthetic camera-derived preview, 2 concurrent local HTTP requests, MongoMemoryServer only, real R2 writes/reads. One full-image slot with a controlled ${busyMs} ms storage/encode wait and memory headroom. Excludes production Render/Atlas latency, phone rendering, and original transfer throughput.`,
    results,summary,cleanup:{objects:files.size,namespace,remaining:0}};
  await writeFile(output,JSON.stringify(report,null,2)+'\n');log('complete',{summary,output,cleanup:report.cleanup});
}catch(error){log('failed',{name:error.name,code:error.code||null});process.exitCode=1}
finally{
  if(server){server.closeIdleConnections?.();await new Promise(resolve=>server.close(resolve))}
  await Promise.allSettled([...activeJobs]);
  if(files.size){try{await cleanup([...files]);const left=await listed();assert.equal(left.length,0);await unlink(ledger)}catch{log('cleanup-pending',{ledger});process.exitCode=1}}
  else await unlink(ledger).catch(()=>{});
  await mongoose.disconnect();await memory?.stop();
  if(saveOriginal)r2Storage.save=saveOriginal;
  config.r2.prefix=originalPrefix;delete globalThis.__albumBenchQueues;
}
