import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { AppManager, validatePlan } from '../lib/app-manager.js'

const imageId='sha256:'+'b'.repeat(64)
const plan={id:'recover-example',image:'example:1',env:{SECRET:'private'}}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-recovery-'));t.after(async()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),'dsh-recovery-')));await fs.rm(root,{recursive:true,force:true})})
 let inspectError=false,info=null
 const calls=[]
 const docker=async args=>{calls.push(args);if(args[0]==='image')return{code:0,stdout:JSON.stringify([{Id:imageId}])};if(args[0]==='inspect')return inspectError?{code:1,stderr:'Cannot connect to Docker daemon'}:info?{code:0,stdout:JSON.stringify([info])}:{code:1,stderr:'No such object'};return{code:0,stdout:''}}
 const m=new AppManager({root,docker});return{m,calls,setInfo:v=>info=v,setError:v=>inspectError=v,root}
}
test('nonstring IDs and nonstring argv rejected rather than regex coerced',()=>{
 for(const id of [undefined,null,123])assert.throws(()=>validatePlan({...plan,id}))
 assert.throws(()=>validatePlan({...plan,command:[null]}))
})
test('daemon failure cannot be interpreted as no container during uninstall/recovery',async t=>{
 const f=await fixture(t);const job=await f.m.prepare({plan});await f.m.approve(job.id,job.approval,true)
 await f.m.save('registry.json',{version:1,apps:{[plan.id]:{plan:validatePlan(plan),owner:job.id,secretRef:`${job.id}.json`,status:'installing'}}})
 f.setError(true)
 await assert.rejects(f.m.action('uninstall',plan.id),/absence is not proven/)
 await assert.rejects(f.m.recover(),/absence is not proven/)
 assert.ok((await f.m.registry()).apps[plan.id]);assert.ok(!f.calls.some(args=>args[0]==='rm'))
})
test('queued approval interrupted before worker becomes recoverable failed job',async t=>{
 const {m,root}=await fixture(t);const job=await m.prepare({plan});await m.approve(job.id,job.approval,true)
 assert.deepEqual(await m.recover(),[job.id]);assert.equal((await m.job(job.id)).state,'failed')
 assert.equal((await fs.readdir(path.join(root,'secrets'))).length,0)
})
test('recovery cleans only owner-id container and finishes installed journal window',async t=>{
 const f=await fixture(t);const job=await f.m.prepare({plan});await f.m.approve(job.id,job.approval,true)
 const record={plan:validatePlan(plan),owner:job.id,secretRef:`${job.id}.json`,status:'installed'}
 await f.m.save('registry.json',{version:1,apps:{[plan.id]:record}})
 await f.m.event(await f.m.job(job.id),'starting','crash window')
 await f.m.recover();assert.equal((await f.m.job(job.id)).state,'ready');assert.ok((await f.m.registry()).apps[plan.id])
 assert.ok(!f.calls.some(args=>args[0]==='rm'))
})
test('foreign replacement suppresses managed web mount and viewer credential',async t=>{
 const f=await fixture(t);const job=await f.m.prepare({plan})
 await f.m.save('registry.json',{version:1,apps:{[plan.id]:{plan:{...validatePlan(plan),viewer:true},owner:job.id,secretRef:`${job.id}.json`,status:'installed'}}})
 f.setInfo({Id:'foreign',Config:{Labels:{}},State:{Running:true}})
 const app=(await f.m.list())[0];assert.equal(app.state,'new');assert.equal(app.web,undefined);assert.equal(app.viewer,undefined)
})
test('review secret provision rotates approval and requires renewed explicit approval',async t=>{
 const {m}=await fixture(t);const original=await m.prepare({plan:{...plan,env:{}}})
 const updated=await m.credentials(original.id,{API_TOKEN:'SECRET_SECOND'})
 assert.notEqual(updated.approval,original.approval)
 assert.deepEqual(updated.plan.environmentKeys,['API_TOKEN'])
 assert.ok(!JSON.stringify(updated).includes('SECRET_SECOND'))
 await assert.rejects(m.approve(original.id,original.approval,true),/Explicit approval/)
 assert.equal((await m.approve(updated.id,updated.approval,true)).state,'queued')
 await assert.rejects(m.credentials(updated.id,{}),/before approval/)
})

test('private storage root cannot be symlink or workspace and unknown registry version rejected',async t=>{
 const f=await fixture(t);await f.m.init();await f.m.save('registry.json',{version:99,apps:{}})
 await assert.rejects(f.m.registry(),/Unsupported/)
 const link=path.join(f.root,'alias');await fs.symlink(f.root,link)
 await assert.rejects(new AppManager({root:link}).init(),/symlink/)
})
