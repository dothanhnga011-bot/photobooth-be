import assert from 'node:assert/strict';
import {after,before,beforeEach,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import request from 'supertest';
import {MongoMemoryServer} from 'mongodb-memory-server';
import {app} from '../src/app.js';
import {config} from '../src/config.js';
import {Booking,PrintJob,Room,User} from '../src/models/index.js';
import {readMedia} from '../src/services/media.js';
import {printEvents} from '../src/services/print-events.js';

let memory, server, base, admin, bnStaff, bgStaff, rooms, sheet;
const BN='Bắc Ninh', BG='Bắc Giang';
const cookie=user=>`session=${jwt.sign({sub:String(user._id)},config.secret)}`;
const ask=(user,method,path)=>request(app)[method](path).set('Cookie',user);
before(async()=>{
  config.secret='test-print-queue-branches-no-production';
  config.dnpPrinter='';config.printAgentToken='queue-agent-test-token-0000000000000000';
  memory=await MongoMemoryServer.create();await mongoose.connect(memory.getUri());
  await Promise.all(Object.values(mongoose.models).map(model=>model.init()));
  rooms=await Room.create([{name:'Selfbooth XT3 BN',branch:BN,kind:'selfbooth',active:true},
    {name:'Selfbooth XS20 BG',branch:BG,kind:'selfbooth',active:true}]);
  const users=await User.create([{name:'Admin',email:'queue-admin@local.test',password:'unused',role:'admin'},
    {name:'Quầy BN',email:'queue-bn@local.test',password:'unused',role:'staff',branch:BN},
    {name:'Quầy BG',email:'queue-bg@local.test',password:'unused',role:'staff',branch:BG}]);
  [admin,bnStaff,bgStaff]=users.map(cookie);
  sheet=await sharp({create:{width:2400,height:3600,channels:3,background:'#e9d3bd'}}).png().toBuffer();
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
});
beforeEach(async()=>{await PrintJob.deleteMany({});await Booking.deleteMany({});});
after(async()=>{
  server?.closeAllConnections();await new Promise(resolve=>server?.close(resolve));
  await mongoose.disconnect();await memory?.stop();
});
async function booking(branch){
  const room=rooms.find(room=>room.branch===branch);
  return Booking.create({code:branch===BN?'101010':'202020',accessToken:randomUUID(),room:room._id,roomName:room.name,
    branch,printSize:'large',paid:true,status:'completed',prints:2,photos:[{kind:'original',file:'source.jpg'}]});
}
const addJob=(branch,extra={})=>PrintJob.create({branch,code:branch===BN?'111111':'222222',printSize:'large',
  status:'pending',spoolStatus:'idle',file:'queue.png',sheets:[{file:'queue.png',width:2400,height:3600}],...extra});
const queue=(branch,status='pending')=>`/api/admin/print-jobs?${new URLSearchParams({size:'large',branch,status})}`;

test('guest sends original 20×30 sheet bytes once to its branch and no agent auto-prints it',async()=>{
  for(const branch of [BN,BG]){
    const b=await booking(branch),key=randomUUID();
    const send=()=>request(app).post(`/api/albums/${b.accessToken}/print-pack`).set('Content-Type','application/octet-stream')
      .set('X-Print-Key',key).set('X-Print-Sheets',String(sheet.length)).send(sheet);
    const first=(await send().expect(201)).body;
    assert.equal((await send().expect(200)).body._id,first._id);
    const job=await PrintJob.findById(first._id);
    assert.deepEqual([job.branch,job.printSize,job.spoolStatus,job.status],[branch,'large','idle','pending']);
    assert.deepEqual(await readMedia(job.file),sheet,'no resizing or re-encoding during submission');
    assert.equal((await Booking.findById(b._id)).printSheets,1);
    const own=(await ask(admin,'get',queue(branch)).expect(200)).body;
    assert.deepEqual(own.map(j=>j.branch),[branch]);
    assert.equal(own[0]._id,first._id);assert.ok(own[0].image.includes(b.accessToken));
    const claim=await request(app).post('/api/print-agent/claim').set('Authorization',`Bearer ${config.printAgentToken}`)
      .send({branch}).expect(200);
    assert.equal(claim.body.job,null);
  }
  assert.equal(await PrintJob.countDocuments(),2);
});

test('list and counts separate both branches, expired sheets and RX1 jobs stay out',async()=>{
  const bn=await addJob(BN);await addJob(BG);await addJob(BG,{status:'printed',printedAt:new Date()});
  await addJob(BN,{printSize:'full'});await addJob(BN,{createdAt:new Date(Date.now()-73*3600000)});
  await addJob(undefined,{code:'333333'});
  assert.deepEqual((await ask(admin,'get',queue(BN)).expect(200)).body.map(j=>j._id),[String(bn._id)]);
  assert.equal((await ask(admin,'get',queue(BG)).expect(200)).body.length,1);
  assert.equal((await ask(admin,'get',queue('')).expect(200)).body[0].code,'333333');
  const rows=(await ask(admin,'get','/api/admin/print-jobs/branches?size=large').expect(200)).body;
  assert.deepEqual(rows.find(r=>r.branch===BN),{branch:BN,pending:1,printed:0});
  assert.deepEqual(rows.find(r=>r.branch===BG),{branch:BG,pending:1,printed:1});
  const own=(await ask(bnStaff,'get','/api/admin/print-jobs/branches?size=large').expect(200)).body;
  assert.deepEqual(own,[{branch:BN,pending:1,printed:0}]);
  assert.deepEqual((await ask(bgStaff,'get','/api/admin/print-jobs?size=large').expect(200)).body.map(j=>j.branch),[BG]);
  for(const path of [queue(BG),`/api/admin/print-jobs/stream?${new URLSearchParams({branch:BG})}`,
    `/api/admin/print-jobs/branches?${new URLSearchParams({branch:BG})}`])await ask(bnStaff,'get',path).expect(403);
});

test('only staff of the owning branch can mark its print done',async()=>{
  const bn=await addJob(BN),bg=await addJob(BG);
  await ask(bnStaff,'patch',`/api/admin/print-jobs/${bg._id}`).send({status:'printed'}).expect(403);
  await ask(bnStaff,'patch',`/api/admin/print-jobs/${bn._id}`).send({status:'printed'}).expect(200);
  assert.equal((await PrintJob.findById(bg._id)).status,'pending');
  assert.equal((await ask(bnStaff,'get',queue(BN,'printed')).expect(200)).body[0].printedBy,'Quầy BN');
});

test('selected-branch SSE delivers its own job and filters the other site',async()=>{
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  let reader;
  try{
    const response=await fetch(`${base}/api/admin/print-jobs/stream?${new URLSearchParams({branch:BN,size:'large'})}`,
      {headers:{Cookie:admin},signal:controller.signal});
    assert.equal(response.status,200);reader=response.body.getReader();
    printEvents.emit('print',{_id:'bg-only',branch:BG,printSize:'large'});
    printEvents.emit('print',{_id:'rx1-only',branch:BN,printSize:'full'});
    printEvents.emit('print-updated',{_id:'bn-updated',branch:BN,printSize:'large',status:'printed'});
    printEvents.emit('print',{_id:'bn-delivered',branch:BN,printSize:'large'});
    let data='';const decoder=new TextDecoder();
    while(!data.includes('bn-delivered')){const chunk=await reader.read();if(chunk.done)break;data+=decoder.decode(chunk.value);}
    assert.match(data,/bn-delivered/);assert.match(data,/event: print-updated/);assert.match(data,/bn-updated/);
    assert.doesNotMatch(data,/bg-only|rx1-only/);
  }finally{clearTimeout(timeout);controller.abort();await reader?.cancel().catch(()=>{});}
});

test('old queued DS820 jobs cannot be leased even by an agent asking for large sheets',async()=>{
  const large=await addJob(BN,{spoolStatus:'queued'});
  const full=await addJob(BN,{printSize:'full',spoolStatus:'queued'});
  const claim=body=>request(app).post('/api/print-agent/claim').set('Authorization',`Bearer ${config.printAgentToken}`).send({branch:BN,...body});
  assert.equal((await claim({printSizes:['large']}).expect(200)).body.job,null);
  assert.equal((await claim({}).expect(200)).body.job.id,String(full._id));
  assert.equal((await PrintJob.findById(large._id)).spoolStatus,'queued');
});
