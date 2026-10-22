import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { AppManager } from '../lib/app-manager.js'
import { ApplicationRuntime, resourceStats } from '../lib/application-runtime.js'
const cid = n => n.toString(16).padStart(64, '0')
const info = n => ({ Id: cid(n), Name: `/app-${n}`, Config: { Image: 'example:1', Labels: {}, Env: ['SECRET=private'], ExposedPorts: { '80/tcp': {} } }, State: { Running: true, Status: 'running' }, HostConfig: {}, Mounts: [], NetworkSettings: { Networks: { bridge: { IPAddress: '172.20.0.2' } } } })
async function fixture(t, n = 6) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-service-'))
 let infos = Array.from({length:n}, (_,i)=>info(i+1)), fail = false, active=0, max=0, now=10000
 const calls=[], mutations=[]
 const engine={
  async listContainers(){calls.push('list');if(fail)throw Error('unavailable');return infos.map(i=>({Id:i.Id}))},
  async inspectContainer(id){calls.push(id);active++;max=Math.max(active,max);await new Promise(r=>setImmediate(r));active--;if(fail)throw Error('unavailable');return infos.find(i=>i.Id===id)??null},
  async start(id){mutations.push(id)},async stop(id){mutations.push(id)},async remove(id){mutations.push(id)},async close(){},
 }
 const manager=new AppManager({root,engine,docker:()=>{throw Error('Unexpected Docker CLI')}})
 const runtime=new ApplicationRuntime({manager,engine,catalog:{list:async()=>[]},config:null,clock:()=>now})
 t.after(async()=>{await runtime.close();assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('dsh-runtime-service-'));await fs.rm(root,{recursive:true,force:true})})
 return {runtime,engine,calls,mutations,setInfos:x=>{infos=x},setFail:x=>{fail=x},tick:ms=>{now+=ms},max:()=>max}
}
test('shared snapshot bounds concurrency, deduplicates all callers and never repeats inspection for details',async t=>{
 const f=await fixture(t,100)
 const results=await Promise.all(Array.from({length:20},()=>f.runtime.inventory()))
 assert.equal(results[0].apps.length,100);assert.equal(f.calls.filter(c=>c==='list').length,1);assert.equal(f.calls.length,101);assert.ok(f.max()<=8)
 await f.runtime.details(results[0].apps[0].id);await f.runtime.inventory();assert.equal(f.calls.length,101)
 assert.ok(!JSON.stringify(results[0]).includes('private'))
})
test('failed inspection drains sibling workers before allowing the next refresh',async t=>{
 const f=await fixture(t,100);let active=0,max=0,calls=0
 f.engine.inspectContainer=async id=>{calls++;active++;max=Math.max(max,active);try{await new Promise(r=>setTimeout(r,5));if(id===cid(1))throw Error('read failed');return info(Number.parseInt(id,16))}finally{active--}}
 for(let n=0;n<4;n++)await assert.rejects(f.runtime.inventory())
 assert.equal(active,0);assert.ok(max<=8);assert.equal(calls,32)
})

test('stale reads return snapshot while one refresh proceeds; daemon outage never becomes missing/empty',async t=>{
 const f=await fixture(t),initial=await f.runtime.inventory();f.tick(4000);f.setFail(true)
 const stale=await f.runtime.inventory();assert.equal(stale.apps.length,6)
 await f.runtime.loading?.catch(()=>{})
 const failed=await f.runtime.inventory({fresh:true});assert.equal(failed.inventory.dockerAvailable,false);assert.equal(failed.inventory.stale,true);assert.equal(failed.apps[0].state,'running')
 assert.deepEqual(failed.apps,initial.apps)
 f.setFail(false);assert.equal((await f.runtime.inventory({fresh:true})).inventory.dockerAvailable,true)
})
test('cold daemon outage fails 503 instead of authorizing absence',async t=>{
 const f=await fixture(t);f.setFail(true);await assert.rejects(f.runtime.inventory(),e=>e.status===503)
})
test('invalidation during work never publishes older generation',async t=>{
 const f=await fixture(t);const work=f.runtime.inventory();f.runtime.invalidate();await work
 assert.equal(f.runtime.snapshot.generation,f.runtime.generation);assert.equal(f.calls.filter(c=>c==='list').length,2)
})
test('mutations resolve full IDs and reject cross-app selection and same-name replacement',async t=>{
 const f=await fixture(t),data=await f.runtime.inventory(),app=data.apps[0]
 await assert.rejects(f.runtime.action(app.id,'stop',{container:cid(999)}),/No container/)
 await f.runtime.action(app.id,'start');assert.deepEqual(f.mutations,[app.containerId])
 const replacement={...info(99),Name:'/app-1'};f.setInfos([replacement])
 await assert.rejects(f.runtime.resolve(app.id,app.containerId),/belong/)
 assert.equal(await f.runtime.endpoint(app),null)
})
test('registered identities never adopt a same-name replacement and endpoints preserve query entries',async t=>{
 const f=await fixture(t), first=info(1);first.Name='/dsh-app-known';f.setInfos([first])
 await f.runtime.manager.init()
 await f.runtime.manager.save('existing.json',{version:1,apps:{known:{id:'known',containerId:first.Id,webPort:80,webPath:'/ui?tenant=a'}}})
 await f.runtime.manager.save('runtime-settings.json',{apps:{known:{service:'dsh-app-known',webPort:80,webPath:'/ui?tenant=a'}}})
 const initial=await f.runtime.inventory({fresh:true}),app=initial.apps.find(a=>a.id==='known')
 assert.equal(app.webPath,'/ui?tenant=a');assert.ok(await f.runtime.endpoint(app))
 f.setInfos([{...info(9),Name:first.Name}]);const replaced=await f.runtime.inventory({fresh:true})
 assert.equal(replaced.apps.find(a=>a.id==='known').state,'missing')
 assert.equal(await f.runtime.endpoint(app),null)
})

test('stats for a large stack are bounded and obsolete container metrics are pruned',async t=>{
 const f=await fixture(t,100);const infos=Array.from({length:100},(_,i)=>{const row=info(i+1);row.Config.Labels={'com.docker.compose.project':'suite','com.docker.compose.service':`s${i}`};return row});f.setInfos(infos)
 let active=0,max=0;f.engine.stats=async id=>{active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;return{id,memory_stats:{usage:1}}}
 const app=(await f.runtime.inventory()).apps[0];assert.equal((await f.runtime.stats(app.id)).length,100);assert.ok(max<=8)
 f.setInfos([]);await f.runtime.inventory({fresh:true});assert.equal(f.runtime.metrics.size,0)
})

test('resource counters match Docker CPU and Linux memory semantics without invented zero',()=>{
 assert.deepEqual(resourceStats({id:'x',cpu_stats:{cpu_usage:{total_usage:300},system_cpu_usage:1000,online_cpus:2},precpu_stats:{cpu_usage:{total_usage:100},system_cpu_usage:500},memory_stats:{usage:1024,limit:4096,stats:{inactive_file:256}}}),{ID:'x',Name:'',CPUPerc:'80.00%',MemUsage:'768 B / 4.0 KiB',MemPerc:'18.75%'})
 assert.equal(resourceStats({}).CPUPerc,undefined);assert.equal(resourceStats({}).MemUsage,undefined)
})
