import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImageSaveQueues } from '../src/services/image-save-queue.js';

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('one small preview can finish while a large image waits, without expanding the large-image decoder limit',async()=>{
  const queue=createImageSaveQueues({fullLimit:1,previewLimit:1,use:()=>.4});
  const held=deferred(),small=deferred(),events=[];
  const full=queue.saveImageTask(async()=>{events.push('full');await held.promise});
  const next=queue.saveImageTask(async()=>events.push('next-full'));
  const preview=queue.savePreviewTask(async()=>{events.push('preview');await small.promise});
  const nextPreview=queue.savePreviewTask(async()=>events.push('next-preview'));
  await turn();
  assert.deepEqual(events,['full','preview']);
  assert.equal(queue.isSaveQueueBusy(),true);
  small.resolve();await Promise.all([preview,nextPreview]);
  assert.deepEqual(events,['full','preview','next-preview']);
  held.resolve();await Promise.all([full,next]);
  assert.equal(queue.isSaveQueueBusy(),false);
  assert.equal(events.at(-1),'next-full');
});

test('memory pressure sends previews back through the bounded normal queue',async()=>{
  const queue=createImageSaveQueues({fullLimit:1,previewLimit:1,use:()=>.75});
  const held=deferred();let began=false;
  const full=queue.saveImageTask(()=>held.promise);
  const preview=queue.savePreviewTask(async()=>{began=true});
  await turn();assert.equal(began,false);
  held.resolve();await Promise.all([full,preview]);
  assert.equal(began,true);assert.equal(queue.isSaveQueueBusy(),false);
});

test('a failed small image releases the preview lane and cannot stall the next customer',async()=>{
  const queue=createImageSaveQueues({fullLimit:1,use:()=>.2});
  const failed=queue.savePreviewTask(async()=>{throw Error('Invalid preview')});
  const next=queue.savePreviewTask(async()=>42);
  await assert.rejects(failed,/Invalid preview/);
  assert.equal(await next,42);assert.equal(queue.isSaveQueueBusy(),false);
});
