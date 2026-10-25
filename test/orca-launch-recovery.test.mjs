import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchOrcaRecoverable } from '../dist/orcaLaunchRecovery.js';
const config = { orcaExecutable: 'fixture', orcaTimeoutMs: 5 };
const launch = { requested: {agent:'codex'}, effective:{agent:'codex'} };
function fixture(mode='ready') {
  let starts=0; const requests=new Map();
  const json=(result,exitCode=0)=>({exitCode,stdout:JSON.stringify({ok:true,result}),stderr:''});
  const show={dispatch:{id:'ctx-test',runId:'run-test',taskId:'task-test',creatorHandle:'term-test'},worker:{dispatchId:'ctx-test',worktreeId:'wt-test',state:'ready',agentTerminalHandle:'term-worker',startOptions:{launch}}};
  const process=async(_b,args)=>{
    const key=args.slice(0,2).join(' '), val=f=>args[args.indexOf(f)+1];
    if(key==='status --json') return json({target:{kind:'local'},runtime:{reachable:true,state:'ready'}});
    if(key==='worktree show') return json({worktree:{id:'wt-test',path:workspace,identity:{key:'wt2:local:test',executionHostId:'local'}}});
    if(key==='terminal create') return json({terminal:{handle:'term-test',worktreeId:'wt-test'}});
    if(key==='orchestration run-create'){const r={run:{id:'run-test'}};requests.set(val('--retry-request'),{method:'orchestration.runCreate',receipt:r});return json(r);}
    if(key==='orchestration worker-start'){
      starts++; const r={runId:'run-test',taskId:'task-test',dispatchId:'ctx-test',state:mode==='ready'?'ready':'outcome_unknown',launch};
      if(mode!=='absent' && mode!=='recovery-down')requests.set(val('--retry-request'),{method:'orchestration.workerStart',receipt:r});
      if(mode==='timeout'||mode==='absent'||mode==='recovery-down')throw new Error('timeout_or_signal');
      if(mode==='malformed')return {exitCode:1,stdout:'broken',stderr:'private'};
      return json(r,mode==='ready'?0:1);
    }
    if(key==='orchestration request-show'){
      if(mode==='recovery-down')throw new Error('query down');
      const r=requests.get(val('--request'));return json({requestId:val('--request'),state:r?'completed':'absent',...r});
    }
    if(key==='orchestration worker-show')return json(show);
    if(key==='orchestration task-list')return json({tasks:[{id:'task-test',run_id:'run-test',created_by_terminal_handle:'term-test'}]});
    throw new Error('unexpected '+key);
  };
  let workspace;
  return {process,show,requests,get starts(){return starts;},setWorkspace(w){workspace=w;}};
}
async function setup(mode){const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'launch-recovery-')));const m=fixture(mode);m.setWorkspace(dir);return {dir,m,input:{workspace:dir,plan:'test spec',agent:'codex'},options:{journalDir:path.join(dir,'receipts'),recoveryAttempts:1,recoveryPollMs:1}};}
for(const mode of ['ready','unknown','malformed','timeout'])test('recovers exact launch: '+mode,async()=>{
 const {dir,m,input,options}=await setup(mode);try{
 const r=await launchOrcaRecoverable(config,input,m.process,options);
 assert.equal(r.taskId,'task-test');assert.equal(r.dispatchId,'ctx-test');assert.equal(r.coordinator_handle,'term-test');
 assert.equal(m.starts,1);assert.equal(r.awaited_terminal,false);
 if(mode!=='ready'){assert.equal(r.state,'tracked');assert.equal(r.launch_recovered,true);}
 const again=await launchOrcaRecoverable(config,input,m.process,options);assert.equal(again.dispatchId,'ctx-test');assert.equal(m.starts,1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

for(const mode of ['absent','recovery-down'])test('ambiguous launch stays UNKNOWN: '+mode,async()=>{
 const {dir,m,input,options}=await setup(mode);try{
 for(let i=0;i<2;i++)await assert.rejects(launchOrcaRecoverable(config,input,m.process,options),e=>{
 assert.equal(e.receipt.state,'unknown');assert.equal(e.receipt.retry_allowed,false);return true;});
 assert.equal(m.starts,1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('late creation after timeout recovers without another worker-start',async()=>{
 const {dir,m,input,options}=await setup('absent');try{
 await assert.rejects(launchOrcaRecoverable(config,input,m.process,options));
 const [name]=await fs.readdir(options.journalDir);const row=JSON.parse(await fs.readFile(path.join(options.journalDir,name),'utf8'));
 m.requests.set(row.worker_request_id,{method:'orchestration.workerStart',receipt:{runId:'run-test',taskId:'task-test',dispatchId:'ctx-test'}});
 const r=await launchOrcaRecoverable(config,input,m.process,options);assert.equal(r.state,'tracked');assert.equal(m.starts,1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('concurrent identical requests allocate one worker',async()=>{
 const {dir,m,input,options}=await setup('timeout');try{
 const results=await Promise.allSettled(Array.from({length:8},()=>launchOrcaRecoverable(config,input,m.process,{...options,recoveryAttempts:10,recoveryPollMs:5})));
 assert.equal(m.starts,1);assert.ok(results.some(r=>r.status==='fulfilled'));
 const r=await launchOrcaRecoverable(config,input,m.process,options);assert.equal(r.dispatchId,'ctx-test');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
for(const change of ['dispatch','run','task','workspace','preferences'])test('rejects mismatched '+change,async()=>{
 const {dir,m,input,options}=await setup('timeout');try{
 if(change==='dispatch')m.show.dispatch.id='ctx-old';
 if(change==='run')m.show.dispatch.runId='run-old';
 if(change==='task')m.show.dispatch.taskId='task-old';
 if(change==='workspace')m.show.worker.worktreeId='wt-other';
 if(change==='preferences')m.show.worker.startOptions.launch={requested:{agent:'claude'},effective:{agent:'claude'}};
 await assert.rejects(launchOrcaRecoverable(config,input,m.process,options),e=>e.receipt.state==='unknown');assert.equal(m.starts,1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('same explicit key with changed input fails closed',async()=>{
 const {dir,m,input,options}=await setup();try{
 await launchOrcaRecoverable(config,{...input,requestId:'same-key'},m.process,options);
 await assert.rejects(launchOrcaRecoverable(config,{...input,requestId:'same-key',plan:'different'},m.process,options),/conflict/);
 assert.equal(m.starts,1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('confirmed failure before worker invocation is not_started',async()=>{
 const {dir,m,input,options}=await setup();try{
 const unavailable=async()=>{throw new Error('spawn unavailable');};
 await assert.rejects(launchOrcaRecoverable(config,input,unavailable,options),e=>{
 assert.equal(e.receipt.state,'not_started');assert.equal(e.receipt.retry_allowed,true);return true;});
 assert.equal(m.starts,0);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('completed worker returns tracking identity, never completion verdict',async()=>{
 const {dir,m,input,options}=await setup('timeout');try{
 m.show.worker.state='succeeded';m.show.dispatch.status='completed';
 const r=await launchOrcaRecoverable(config,input,m.process,options);
 assert.equal(r.state,'tracked');assert.equal(r.awaited_terminal,false);assert.equal(r.succeeded,undefined);
 assert.equal(r.completion_authority,'worker_done');assert.equal(r.wait_for_handoff.orca_dispatch_id,'ctx-test');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('pending accepted checkpoint recovers exact worker',async()=>{
 const {dir,m,input,options}=await setup('absent');try{
 await assert.rejects(launchOrcaRecoverable(config,input,m.process,options));
 const [name]=await fs.readdir(options.journalDir);const row=JSON.parse(await fs.readFile(path.join(options.journalDir,name),'utf8'));
 m.requests.set(row.worker_request_id,{state:'pending',method:'orchestration.workerStart',receipt:{accepted:{dispatchId:'ctx-test'}}});
 const r=await launchOrcaRecoverable(config,input,m.process,options);assert.equal(r.dispatchId,'ctx-test');assert.equal(m.starts,1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('separate MCP processes and restarted CLI recover one durable launch',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'launch-process-')));
 try{
 const cli=path.join(dir,'fixture.mjs');
 await fs.writeFile(cli,`
 import fs from 'node:fs/promises';import path from 'node:path';
 const args=process.argv.slice(2), key=args.slice(0,2).join(' '), val=f=>args[args.indexOf(f)+1];
 const root=process.cwd(), db=path.join(root,'orca.json');let state;try{state=JSON.parse(await fs.readFile(db,'utf8'));}catch{state={requests:{},starts:0};}
 const launch={requested:{agent:'codex'},effective:{agent:'codex'}};let r;
 if(key==='status --json')r={runtime:{reachable:true,state:'ready'},target:{kind:'local'}};
 if(key==='worktree show')r={worktree:{id:'wt-test',path:root,identity:{key:'wt2:local:test',executionHostId:'local'}}};
 if(key==='terminal create')r={terminal:{handle:'term-test',worktreeId:'wt-test'}};
 if(key==='orchestration run-create'){r={run:{id:'run-test'}};state.requests[val('--retry-request')]={method:'orchestration.runCreate',receipt:r};}
 if(key==='orchestration worker-start'){
 state.starts++;r={runId:'run-test',taskId:'task-test',dispatchId:'ctx-test',state:'outcome_unknown',launch};
 state.requests[val('--retry-request')]={method:'orchestration.workerStart',receipt:r};process.exitCode=1;}
 if(key==='orchestration request-show'){const found=state.requests[val('--request')];r={requestId:val('--request'),state:found?'completed':'absent',...found};}
 if(key==='orchestration task-list')r={tasks:[{id:'task-test',run_id:'run-test',created_by_terminal_handle:'term-test'}]};
 if(key==='orchestration worker-show')r={dispatch:{id:'ctx-test',runId:'run-test',taskId:'task-test'},worker:{dispatchId:'ctx-test',worktreeId:'wt-test',state:'succeeded',startOptions:{launch}}};
 if(['orchestration run-create','orchestration worker-start'].includes(key))await fs.writeFile(db,JSON.stringify(state));
 if(!r)throw new Error('unexpected '+key);process.stdout.write(JSON.stringify({ok:true,result:r}));
 `);
 const runner=path.join(dir,'runner.mjs');
 await fs.writeFile(runner,`import {launchOrcaRecoverable} from ${JSON.stringify(new URL('../dist/orcaLaunchRecovery.js',import.meta.url).href)};
 try {const r=await launchOrcaRecoverable({orcaExecutable:${JSON.stringify(cli)},orcaTimeoutMs:3000},{workspace:${JSON.stringify(dir)},plan:'cross process',agent:'codex'},undefined,{journalDir:${JSON.stringify(path.join(dir,'receipts'))},recoveryAttempts:10,recoveryPollMs:20});console.log(JSON.stringify(r));}
 catch(e){console.log(JSON.stringify(e.receipt));}`);
 const results=await Promise.all(Array.from({length:4},()=>exec(process.execPath,[runner],{cwd:dir})));
 assert.ok(results.some(r=>JSON.parse(r.stdout).state==='tracked'));
 assert.equal(JSON.parse(await fs.readFile(path.join(dir,'orca.json'),'utf8')).starts,1);
 const restart=JSON.parse((await exec(process.execPath,[runner],{cwd:dir})).stdout);
 assert.equal(restart.dispatchId,'ctx-test');assert.equal(restart.state,'tracked');assert.equal(restart.awaited_terminal,false);
 assert.equal(JSON.parse(await fs.readFile(path.join(dir,'orca.json'),'utf8')).starts,1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('recovered completed worker continues through authoritative worker_done bridge',async()=>{
 const {waitForOrca}=await import('../dist/executionBackend.js');
 const {dir,m,input,options}=await setup('timeout');try{
 m.show.worker.state='succeeded';m.show.dispatch.status='completed';m.show.worker.agentTerminalHandle='term-worker';
 const r=await launchOrcaRecoverable(config,input,m.process,options);
 let delivered=false;
 const process=async(b,args,cwd,t)=>{
  const json=result=>({exitCode:0,stdout:JSON.stringify({ok:true,result}),stderr:''});
  if(args[1]==='worker-show')return json({...m.show,projection:{dispatchId:'ctx-test',outcome:'succeeded',stage:{detail:'done'},liveness:{verdict:'live'}}});
  if(args[1]==='task-list')return json({tasks:[{id:'task-test',run_id:'run-test',status:'completed'}]});
  if(args[1]==='check'){
   if(args.includes('--ack'))return json({runId:r.runId,messages:[],count:0,acknowledged:'delivery-test'});
   if(delivered||args.includes('--all'))return json({runId:r.runId,messages:[],count:0,deliveryId:null});
   delivered=true;return json({runId:r.runId,deliveryId:'delivery-test',messages:[{id:'msg-test',run_id:r.runId,type:'worker_done',from_handle:'term-worker',payload:JSON.stringify({taskId:r.taskId,dispatchId:r.dispatchId,outcome:'succeeded'})}]});
  }
  throw new Error('unexpected');
 };
 const done=await waitForOrca(config,{runId:r.runId,taskId:r.taskId,dispatchId:r.dispatchId,coordinatorHandle:r.coordinator_handle},{workspace:dir,maxWaitMs:1000,pollMs:1},process);
 assert.equal(done.succeeded,true);assert.equal(done.worker_done.message_id,'msg-test');assert.equal(done.awaited_terminal,true);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('directory durability failure fences allocation before any Orca call',async()=>{
 const {dir,m,input,options}=await setup();const original=fs.open;
 try{
 let synced=0;
 fs.open=async function(file,...args){
  if(file===options.journalDir){synced++;throw Object.assign(new Error('directory sync unavailable'),{code:'EIO'});}
  return original.call(this,file,...args);
 };
 await assert.rejects(launchOrcaRecoverable(config,input,m.process,options),e=>e.receipt.state==='unknown'&&e.receipt.retry_allowed===false);
 assert.equal(m.starts,0);assert.ok(synced>0);
 }finally{fs.open=original;await fs.rm(dir,{recursive:true,force:true});}
});
test('claim and checkpoint directory entries are synced',async()=>{
 const {dir,m,input,options}=await setup();const original=fs.open;let syncs=0;
 try{
 fs.open=async function(file,...args){const handle=await original.call(this,file,...args);
 if(file===options.journalDir){const sync=handle.sync.bind(handle);handle.sync=async()=>{syncs++;return sync();};}return handle;};
 await launchOrcaRecoverable(config,input,m.process,options);
 // New directory, initial claim, and before/after each of coordinator, Run, worker mutations.
 assert.ok(syncs>=8);assert.equal(m.starts,1);
 }finally{fs.open=original;await fs.rm(dir,{recursive:true,force:true});}
});

test('bounded polling observes worker creation after timeout in same handoff',async()=>{
 const {dir,m,input,options}=await setup('absent');let reads=0;
 try{
 const proc=async(b,args,cwd,t)=>{
  if(args[1]==='request-show'){
   const key=args[args.indexOf('--request')+1];
   if(++reads===2)m.requests.set(key,{method:'orchestration.workerStart',receipt:{runId:'run-test',taskId:'task-test',dispatchId:'ctx-test'}});
  }
  return m.process(b,args,cwd,t);
 };
 const r=await launchOrcaRecoverable(config,input,proc,{...options,recoveryAttempts:3});
 assert.equal(r.state,'tracked');assert.equal(m.starts,1);assert.ok(reads>=2);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('malformed recovery response cannot turn into a launch success',async()=>{
 const {dir,m,input,options}=await setup('timeout');try{
 const proc=async(b,args,cwd,t)=>args[1]==='request-show'?{exitCode:0,stdout:'{bad-json',stderr:'private'}:m.process(b,args,cwd,t);
 await assert.rejects(launchOrcaRecoverable(config,input,proc,options),e=>e.receipt.state==='unknown'&&e.receipt.retry_allowed===false);
 assert.equal(m.starts,1);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('failed dispatch is recoverable identity, not fabricated completion',async()=>{
 const {dir,m,input,options}=await setup('timeout');try{
 m.show.worker.state='failed';m.show.dispatch.status='failed';
 const r=await launchOrcaRecoverable(config,input,m.process,options);
 assert.equal(r.state,'tracked');assert.equal(r.launch_state,'failed');assert.equal(r.awaited_terminal,false);assert.equal(r.succeeded,undefined);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('concurrent directory initialization cannot bypass ancestor durability',async()=>{
 const {AsyncLocalStorage}=await import('node:async_hooks');const ctx=new AsyncLocalStorage();
 const {dir,m,input,options}=await setup();const original=fs.open, synced=new Map([[1,new Set()],[2,new Set()]]);
 let release, paused;const gate=new Promise(r=>release=r), reached=new Promise(r=>paused=r);let stopped=false;
 const chain=[];for(let current=options.journalDir;;current=path.dirname(current)){chain.push(current);if(path.dirname(current)===current)break;}
 try{
 fs.open=async function(file,...args){const handle=await original.call(this,file,...args);const caller=ctx.getStore();
 if(chain.includes(file)&&caller){const sync=handle.sync.bind(handle);handle.sync=async()=>{
  if(caller===1&&file===dir&&!stopped){stopped=true;paused();await gate;}
  await sync();synced.get(caller).add(file);
 };}return handle;};
 const proc=async(b,args,cwd,t)=>{
  if(args[1]==='worker-start')assert.ok(chain.every(d=>synced.get(ctx.getStore()).has(d)),'worker before complete ancestor sync');
  return m.process(b,args,cwd,t);
 };
 const first=ctx.run(1,()=>launchOrcaRecoverable(config,input,proc,options));
 await reached;
 const second=await ctx.run(2,()=>launchOrcaRecoverable(config,input,proc,options));
 assert.equal(second.dispatchId,'ctx-test');release();await first;assert.equal(m.starts,1);
 }finally{release();fs.open=original;await fs.rm(dir,{recursive:true,force:true});}
});
