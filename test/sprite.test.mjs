import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ManagedClient } from '../dist/client.js';
const eid='22222222-2222-4222-8222-222222222222';
const cid='33333333-3333-4333-8333-333333333333';
const event=(id,name,data)=>`id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
test('sprite follows a finite stream using the cursor without a second submit', async()=>{
 let submitted=0, resumed=0;
 const server=http.createServer((req,res)=>{
  if(req.url==='/v1/execute'){
   submitted++;res.writeHead(200,{'Content-Type':'text/event-stream'});
   res.end(event(1,'started',{execution_id:eid,conversation_id:cid})+event(2,'progress',{text:'Creating the animation.'}));
  }else if(req.url.endsWith('/events')){
   resumed++;assert.equal(req.headers['last-event-id'],'2');
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   res.end(event(3,'asset',{asset_id:eid,download_url:`http://127.0.0.1:${server.address().port}/asset`})+event(4,'done',{status:'completed'}));
  }else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({execution_id:eid,conversation_id:cid,status:'running'}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const api=new ManagedClient('dlr_live_fixture',`http://127.0.0.1:${server.address().port}`);
  const events=[];
  for await(const e of api.follow({operation:'sprite_sheet',input_asset_id:eid,options:{action:'walk'},max_credits:20},{idempotencyKey:'sprite'}))events.push(e);
  assert.equal(events.at(-1).data.status,'completed');assert.equal(submitted,1);assert.equal(resumed,1);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('six minute sprite execution reconnects twice and keeps one charge', async()=>{
 let submitted=0, resumed=0, elapsed=0;
 const realNow=Date.now;
 const start=realNow();
 Date.now=()=>start+elapsed;
 const server=http.createServer((req,res)=>{
  if(req.url==='/v1/execute'){
   submitted++;elapsed=120_000;res.writeHead(200,{'Content-Type':'text/event-stream'});
   res.end(event(1,'started',{execution_id:eid,conversation_id:cid}));
  }else if(req.url.endsWith('/events')){
   resumed++;assert.equal(req.headers['last-event-id'],String(resumed));elapsed+=120_000;
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   res.end(resumed===1?event(2,'progress',{text:'Preparing your bundle.'}):event(3,'asset',{asset_id:eid,download_url:`http://127.0.0.1:${server.address().port}/asset`})+event(4,'done',{status:'completed'}));
  }else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({execution_id:eid,conversation_id:cid,status:'running',credits_used:20}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const api=new ManagedClient('dlr_live_fixture',`http://127.0.0.1:${server.address().port}`);
  const events=[];
  for await(const e of api.follow({operation:'sprite_sheet',input_asset_id:eid,options:{action:'run'},max_credits:20},{idempotencyKey:'six-minute'}))events.push(e);
  assert.equal(events.at(-1).data.status,'completed');assert.equal(submitted,1);assert.equal(resumed,2);assert.equal(elapsed,360_000);
 }finally{Date.now=realNow;server.closeAllConnections();await new Promise(r=>server.close(r));}
});
