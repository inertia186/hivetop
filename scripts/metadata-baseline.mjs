import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {setImmediate as flush} from 'node:timers/promises';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {cpus} from 'node:os';
const root=resolve(new URL('..',import.meta.url).pathname);
const epoch=Date.parse('2026-10-25T12:00:00Z'), start=18, count=50, pollMs=1000;
const workloads=['healthy','startup','boundaries','timeout','side-panels','block-error','failover','gap'];
const p95=a=>[...a].sort((a,b)=>a-b)[Math.ceil(a.length*.95)-1];
async function replay(runtime,path,workload){
 const {HiveRpcClient,FailoverHiveRpcClient}=await import(pathToFileURL(resolve(runtime,'dist/rpc.js')));
 const {BlockFollower}=await import(pathToFileURL(resolve(runtime,'dist/follower.js')));
 const {runFollowLog}=await import(pathToFileURL(resolve(runtime,'dist/cli.js')));
 mock.timers.enable({apis:['Date','setTimeout'],now:epoch});
 const abort=new AbortController(), records=[],requests=[], rounds=new Set(), completedSchedules=new Map();
 let active=0,peak=0,failedBlock=false,complete=false,failure,aborted=0, failedBlockAt;
 const time=()=>Date.now()-epoch, head=()=>start+Math.floor(time()/3000);
 const fetch=endpoint=>async(_url,init)=>{
  const rpc=JSON.parse(init.body), at=time(), capturedHead=head();
  requests.push({at,endpoint,method:rpc.method});peak=Math.max(peak,++active);
  let latency=100, error, result;
  switch(rpc.method){
   case 'condenser_api.get_dynamic_global_properties': result={head_block_number:capturedHead,current_aslot:capturedHead,time:new Date(epoch+(capturedHead-start)*3000).toISOString().slice(0,-1)};break;
   case 'condenser_api.get_witness_schedule': {
    const round=Math.floor(capturedHead/21), first=!rounds.has(round);rounds.add(round);
    if(workload==='startup'&&requests.filter(r=>r.method===rpc.method).length===1||workload==='boundaries'&&first)latency=5000;
    if(workload==='timeout'&&first)latency=15000;
    if(workload==='side-panels')latency=5000;
    const names=offset=>Array.from({length:21},(_,i)=>`w-${offset+i}`);
    result={current_shuffled_witnesses:names(round*21),future_shuffled_witnesses:names((round+1)*21),next_shuffle_block_num:(round+1)*21,num_scheduled_witnesses:21,majority_version:'1.28.0'};break;
   }
   case 'condenser_api.get_block': {
    const n=rpc.params[0];
    if((workload==='block-error'||workload==='failover')&&n===25&&!failedBlock){failedBlock=true;failedBlockAt=time();error='block unavailable';}
    result=workload==='gap'&&n===25?null:{timestamp:new Date(epoch+(n-start)*3000).toISOString().slice(0,-1),witness:`w-${n}`,transactions:[]};break;
   }
   case 'condenser_api.get_ops_in_block': result=[{op:['producer_missed',{producer:`missing-${endpoint}`} ]}];break;
   case 'condenser_api.get_hardfork_version':result='1.28.0';break;
   case 'condenser_api.get_next_scheduled_hardfork':result={};break;
   case 'condenser_api.get_witnesses_by_vote':result=[{owner:'w-18'}];break;
   case 'rc_api.get_rc_stats':result={rc_stats:{vote:1}};break;
   default:throw new Error(rpc.method);
  }
  if(workload==='side-panels'&&!['condenser_api.get_dynamic_global_properties','condenser_api.get_witness_schedule','condenser_api.get_block','condenser_api.get_ops_in_block'].includes(rpc.method))latency=20000;
  return {ok:true,status:200,headers:{},json:()=>new Promise((res,rej)=>{
   const finish=()=>{active--;init.signal.removeEventListener('abort',cancel);};
   const timer=setTimeout(()=>{finish();if(rpc.method==='condenser_api.get_witness_schedule'&&!error)completedSchedules.set(endpoint,{at:time(),boundary:result.next_shuffle_block_num});res(error?{error:{message:error}}:{result});},latency);
   const cancel=()=>{clearTimeout(timer);finish();aborted++;rej(init.signal.reason);};
   init.signal.addEventListener('abort',cancel,{once:true});
  })};
 };
 const client=workload==='failover'?new FailoverHiveRpcClient(['https://first.test','https://second.test'],endpoint=>new HiveRpcClient(endpoint,fetch(endpoint))):new HiveRpcClient('https://first.test',fetch('https://first.test'));
 const originalLog=console.log;
 const receive=record=>{
  const schedule=completedSchedules.get(record.endpoint);
  const boundary=record.schedule??record.reported_next_shuffle_block_num;
  const scheduleAgeMs=schedule&&boundary===schedule.boundary?time()-schedule.at:undefined;
  if(record.type==='block'&&path==='diagnostic')assert.deepEqual(record.missed,[`missing-${record.endpoint}`]);
  records.push({...record,at:time(),scheduleAgeMs});
 };
 console.log=line=>receive(JSON.parse(line));
 const follower=path==='follower'?new BlockFollower(client,{startBlock:start,pollMs,retryMs:1000}):undefined;
 const run=async()=>{
  if(follower){
   for await(const event of follower.follow(abort.signal)){
    if(event.type==='block'){
     assert.equal(event.block.virtualOperationCount,1);
     assert.equal(event.missedBlocks[0].witness,`missing-${client.endpoint}`);
     receive({type:'block',block:event.block.number,head:event.headBlock,endpoint:client.endpoint,schedule:event.witnessSchedule?.next_shuffle_block_num});
     if(event.block.number===start+count-1){abort.abort();break;}
    }else if(event.type==='gap'){
     receive({type:'gap',block:event.blockNumber});
     // Dashboard intentionally retries a null block; record its repeated gap then stop this trace.
     if(records.filter(r=>r.type==='gap').length===3){abort.abort();break;}
    }
   }
  }else await runFollowLog(client,{start,pollMs,follow:true,limit:count,maxGapRetries:2,gapRetryMs:1000},abort.signal);
 };
 try{
  const running=run().then(()=>{complete=true;},error=>{failure=error;complete=true;});
  for(let elapsed=0;elapsed<1000000&&!complete;elapsed+=20){mock.timers.tick(20);await flush();}
  assert.ok(complete,`${path}/${workload}: replay must terminate`);if(failure)assert.ok(path==='diagnostic'&&(workload==='block-error'&&/block unavailable/.test(failure.message)||workload==='timeout'&&/RPC timeout/.test(failure.message)),String(failure));
  abort.abort();await running;await flush();
  assert.equal(active,0,'shutdown must settle all HTTP bodies');
  const produced=records.filter(r=>r.type==='block');
  const expected=Array.from({length:failure&&workload==='timeout'?0:(path==='follower'&&workload==='gap'||path==='diagnostic'&&workload==='block-error')?7:count},(_,i)=>start+i).filter(n=>workload!=='gap'||n!==25);
  assert.deepEqual(produced.map(r=>r.block),expected);
  if(workload==='failover')assert.equal(produced.find(r=>r.block===25).endpoint,'https://second.test');
  let rate=0;
  for(const req of requests)rate=Math.max(rate,requests.filter(r=>r.at<=req.at&&r.at>req.at-1000).length);
  return {path,workload,records,requests:requests.length,peakConcurrency:peak,peakHttpPerSecond:rate,aborted,failure:failure?.message,recoveryAfterBlockFailureMs:failedBlockAt===undefined?undefined:produced.find(r=>r.block===25)?.at-failedBlockAt,worstScheduleAgeMs:Math.max(0,...produced.map(r=>r.scheduleAgeMs??0)),worstHeadLag:Math.max(0,...produced.map(r=>r.head-r.block)),lastAt:time()};
 }finally{abort.abort();console.log=originalLog;mock.timers.reset();}
}
async function main(){
 assert.equal(process.version,'v24.16.0');
 const [beforeArg,outputArg]=process.argv.slice(2);
 assert.ok(beforeArg&&outputArg,'Usage: node scripts/metadata-baseline.mjs BASELINE_RUNTIME OUTPUT');
 const before=resolve(beforeArg), samples=[];
 const paths=['src/follower.ts','src/cli.ts','src/rpc.ts','dist/follower.js','dist/cli.js','dist/rpc.js','scripts/metadata-baseline.mjs'];
 const hashFiles=async()=>Object.fromEntries(await Promise.all(paths.map(async p=>[p,createHash('sha256').update(await readFile(resolve(root,p))).digest('hex')])));
 const initialHashes=await hashFiles();
 const repetitions=before===root?1:7;
 for(const runtime of before===root?[root]:[before,root])for(const path of ['follower','diagnostic'])for(const workload of workloads)await replay(runtime,path,workload);
 console.error('Complete workload warmup finished for each version.');
 for(let pair=0;pair<repetitions;pair++){
  const variants=repetitions===1?[['baseline',before]]:pair%2?[['candidate',root],['baseline',before]]:[['baseline',before],['candidate',root]];
  for(const [variant,runtime]of variants)for(const path of ['follower','diagnostic'])for(const workload of workloads){
   const result=await replay(runtime,path,workload);samples.push({pair:pair+1,variant,...result});
  }
  console.error(`Completed ${pair+1}/${repetitions} paired passes`);
 }
 for(const variant of [...new Set(samples.map(r=>r.variant))])for(const path of ['follower','diagnostic'])for(const workload of workloads){const rows=samples.filter(r=>r.variant===variant&&r.path===path&&r.workload===workload);for(const row of rows.slice(1)){const {pair,...actual}=row;const {pair:ignored,...reference}=rows[0];assert.deepEqual(actual,reference,'Replay must be deterministic');}}
 const limits={};
 for(const path of ['follower','diagnostic']){
  const rows=samples.filter(r=>r.path===path&&r.variant==='baseline');
  limits[path]={requests:Math.max(...rows.map(r=>r.requests)),peakConcurrency:Math.max(...rows.map(r=>r.peakConcurrency))};
 }
 const summary=[];
 for(const variant of [...new Set(samples.map(r=>r.variant))])for(const path of ['follower','diagnostic'])for(const workload of workloads){
  const rows=samples.filter(r=>r.variant===variant&&r.path===path&&r.workload===workload);
  const delay=rows.flatMap(r=>{const healthy=samples.find(h=>h.pair===r.pair&&h.variant===variant&&h.path===path&&h.workload==='healthy');return r.records.filter(b=>b.type==='block').map(b=>b.at-healthy.records.find(h=>h.block===b.block&&h.type==='block').at);});
  summary.push({variant,path,workload,additionalDelayP95Ms:delay.length?p95(delay):null,additionalDelayWorstMs:delay.length?Math.max(...delay):null,requests:Math.max(...rows.map(r=>r.requests)),peakConcurrency:Math.max(...rows.map(r=>r.peakConcurrency)),worstHeadLag:Math.max(...rows.map(r=>r.worstHeadLag))});
 }
 const hashes=await hashFiles();assert.deepEqual(hashes,initialHashes,'Runtime, source and collector must stay fixed during measurement');
 // Frozen from the original capture; paired runs must not depend on ignored local reports.
 if(repetitions>1)assert.deepEqual(limits,{follower:{requests:295,peakConcurrency:6},diagnostic:{requests:454,peakConcurrency:2}},'Limits must match the pre-change capture');
 const violations=[];
 for(const row of summary.filter(row=>row.variant==='candidate')){
  for(const metric of ['requests','peakConcurrency'])if(row[metric]>limits[row.path][metric])violations.push({...row,metric,limit:limits[row.path][metric]});
  if(['startup','boundaries','timeout','side-panels'].includes(row.workload)&&row.additionalDelayWorstMs>pollMs)violations.push({...row,metric:'additionalDelayWorstMs',limit:pollMs});
 }
 if(repetitions>1)for(let pair=1;pair<=repetitions;pair++)for(const path of ['follower','diagnostic']){
  const healthy=variant=>samples.find(r=>r.pair===pair&&r.path===path&&r.variant===variant&&r.workload==='healthy').records;
  assert.deepEqual(healthy('candidate'),healthy('baseline'),'Healthy block and schedule delivery must remain identical');
 }
 const report={violations,date:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDiff:execFileSync('git',['diff','--','src','dist'],{cwd:root,encoding:'utf8'}),node:process.version,cpu:cpus()[0].model,fixture:{epoch,start,count,pollMs,stepMs:20,healthyRpcBodyMs:100,slowScheduleMs:5000,rpcDeadlineMs:10000,repetitions,warmup:'one complete unmeasured replay of every case for each version',workloads},limits,hashes,summary,samples};
 await writeFile(resolve(outputArg),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 assert.deepEqual(violations,[],'Candidate must meet the fixed budgets and slow-metadata delivery target');
 console.table(summary);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
