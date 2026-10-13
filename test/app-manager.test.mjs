import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AppManager, validatePlan, appStateRoot } from '../lib/app-manager.js'

const digest='sha256:'+'a'.repeat(64)
function daemon({failCreate=false, failStart=false, health=true}={}){
  const containers=new Map(),commands=[]
  const run=async(args)=>{
    commands.push(args)
    if(args[0]==='inspect'){
      const info=containers.get(args[1]);return {code:info?0:1,stdout:info?JSON.stringify([info]):'',stderr:info?'':'Error: No such object'}
    }
    if(args[0]==='image')return {code:0,stdout:JSON.stringify([{Id:digest}]),stderr:''}
    if(args[0]==='create'){
      const name=args[args.indexOf('--name')+1],labels={}
      args.forEach((arg,i)=>{if(arg==='--label'){const [key,value]=args[i+1].split('=');labels[key]=value}})
      containers.set(name,{Id:'container-'+name,Config:{Labels:labels},State:{Running:false,Status:'created'},NetworkSettings:{Networks:{bridge:{IPAddress:'127.0.0.1'}}}})
      return {code:failCreate?1:0,stdout:'container-id',stderr:'raw secret should not leak'}
    }
    if(args[0]==='start'){
      const info=containers.get(args[1]) || [...containers.values()].find(info=>info.Id===args[1]);if(!failStart){info.State.Running=true;info.State.Status='running'}
      return {code:failStart?1:0,stdout:'',stderr:''}
    }
    if(args[0]==='rm'){for(const [name,info]of containers)if(name===args.at(-1)||info.Id===args.at(-1))containers.delete(name)}
    if(args[0]==='stop'){const info=containers.get(args[1]) || [...containers.values()].find(info=>info.Id===args[1]);info.State.Running=false;info.State.Status='exited'}
    if(args[0]==='logs')return {code:0,stdout:'value=CANARY_SECRET',stderr:''}
    return {code:0,stdout:'',stderr:''}
  }
  return {run,containers,commands,health:async()=>health}
}
async function manager(t,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-manager-'))
  // Generated private path known at cleanup; never accepts user plan data.
  t.after(async()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),'dsh-manager-')));await fs.rm(root,{recursive:true,force:true})})
  const docker=daemon(options)
  return {m:new AppManager({root,docker:docker.run,health:docker.health,readyMs:50,legacy:options.legacy||(async()=>[])}),docker,root}
}
const plan={id:'example',name:'Example',image:'example/image:1',webPort:80,env:{API_KEY:'CANARY_SECRET'},volumes:[{target:'/data'}]}

test('strict plan rejects escalation flags, path and shell injection',()=>{
  for(const patch of [{id:'../evil'},{image:'-v:foo'},{image:'example'},{privileged:true},{volumes:[{target:'/var/run/docker.sock'}]},{volumes:[{target:'/data',source:'/data'}]},{webSockets:['/foo?bar']},{webRewrite:['/api']},{webPort:70000},{command:'sh -lc evil'},{env:{FOO:'bad\nnewline'}}])assert.throws(()=>validatePlan({...plan,...patch}))
  assert.throws(()=>appStateRoot({COMPUTER_APPS_STATE:'/workspace/my-apps'}))
})
test('review protects secrets, approval required, same normalized install used',async t=>{
  const {m,docker,root}=await manager(t)
  const job=await m.prepare({plan})
  assert.equal(job.state,'review');assert.ok(!JSON.stringify(job).includes('CANARY_SECRET'))
  assert.deepEqual(job.plan.environmentKeys,['API_KEY'])
  await assert.rejects(m.run(job.id),/not queued/)
  await assert.rejects(m.approve(job.id,job.approval,false),/Explicit approval/)
  await m.approve(job.id,job.approval,true)
  const done=await m.run(job.id);assert.equal(done.state,'ready')
  const argv=docker.commands.find(args=>args[0]==='create')
  assert.ok(argv.includes('--env-file'));assert.ok(!argv.join(' ').includes('CANARY_SECRET'))
  assert.ok(!argv.includes('-p')&&!argv.includes('--privileged')&&!argv.includes('--network'))
  assert.equal(argv.at(-1),digest)
  assert.equal((await fs.stat(path.join(root,'registry.json'))).mode&0o777,0o600)
  assert.equal((await fs.stat(root)).mode&0o777,0o700)
  assert.ok(!JSON.stringify(await m.list()).includes('CANARY_SECRET'))
  assert.ok(!JSON.stringify(await m.jobs()).includes('CANARY_SECRET'))
  const logs=await m.action('logs','example');assert.ok(logs.output.includes('[REDACTED]'));assert.ok(!logs.output.includes('CANARY_SECRET'))
  await assert.rejects(m.approve(job.id,job.approval,true),/Explicit approval/)
})
test('partial create failure rolls back only its operation-owned container',async t=>{
  const {m,docker}=await manager(t,{failCreate:true})
  const job=await m.prepare({plan});await m.approve(job.id,job.approval,true)
  const done=await m.run(job.id);assert.equal(done.state,'failed')
  assert.equal(docker.containers.size,0)
  assert.deepEqual((await m.registry()).apps,{})
  assert.ok(docker.commands.some(args=>args[0]==='rm'))
  assert.ok(!docker.commands.some(args=>args[0]==='rmi'||args[0]==='volume'&&args[1]==='rm'))
})
test('existing legacy id and foreign container are never adopted or replaced',async t=>{
  const {m,docker}=await manager(t,{legacy:async()=>[{id:'catalog'}]})
  await assert.rejects(m.prepare({plan:{...plan,id:'catalog'}}),/already exists/)
  docker.containers.set('dsh-app-example',{Config:{Labels:{}}})
  await assert.rejects(m.prepare({plan}),/container.*already exists/)
  assert.ok(!docker.commands.some(args=>args[0]==='rm'))
})
test('start failure and health timeout remove owned install and preserve data',async t=>{
  for(const option of [{failStart:true},{health:false}]){
    const {m,docker}=await manager(t,option)
    const job=await m.prepare({plan});await m.approve(job.id,job.approval,true)
    assert.equal((await m.run(job.id)).state,'failed');assert.equal(docker.containers.size,0)
  }
})
test('uninstall keeps volumes and refuses actions on a replaced container',async t=>{
  const {m,docker}=await manager(t)
  const job=await m.prepare({plan});await m.approve(job.id,job.approval,true);await m.run(job.id)
  const info=docker.containers.get('dsh-app-example');info.Config.Labels['dsh.apps.install']='foreign'
  await assert.rejects(m.action('uninstall','example'),/not owned/)
  info.Config.Labels['dsh.apps.install']=job.id
  await m.action('uninstall','example');assert.deepEqual((await m.registry()).apps,{})
  assert.ok(!docker.commands.some(args=>args[0]==='volume'&&args[1]==='rm'))
  assert.equal((await fs.readdir(path.join(m.root,'secrets'))).length,0)
})
test('removed installed container restores its pinned image and same owned volume without a new approval',async t=>{
 const {m,docker}=await manager(t)
 const job=await m.prepare({plan});await m.approve(job.id,job.approval,true);await m.run(job.id)
 const original=docker.commands.find(args=>args[0]==='create').find(args=>typeof args==='string' && args.includes('type=volume'))
 await m.action('rm','example');assert.equal(docker.containers.size,0)
 await m.action('up','example');assert.equal(docker.containers.size,1)
 const creates=docker.commands.filter(args=>args[0]==='create')
 assert.equal(creates.at(-1).find(arg=>typeof arg==='string'&&arg.includes('type=volume')),original)
})
test('occupied reviewed id clears losing job secrets and missing env cannot launch',async t=>{
  const {m,root}=await manager(t)
  const first=await m.prepare({plan});const second=await m.prepare({plan})
  await m.approve(first.id,first.approval,true);await m.run(first.id)
  await m.approve(second.id,second.approval,true);assert.equal((await m.run(second.id)).state,'failed')
  await assert.rejects(fs.access(path.join(root,'secrets',second.id+'.json')))
  const third=await m.prepare({plan:{...plan,id:'missing-env'}})
  await m.approve(third.id,third.approval,true)
  const secret=path.join(root,'secrets',third.id+'.json');assert.equal(path.dirname(secret),path.join(root,'secrets'));await fs.unlink(secret)
  assert.equal((await m.run(third.id)).state,'failed')
})
test('corrupt registry fails closed and concurrent cross-instance lock does not overlap',async t=>{
  const {m,root,docker}=await manager(t)
  await m.init();await fs.writeFile(path.join(root,'registry.json'),'invalid')
  await assert.rejects(m.prepare({plan}))
  await fs.writeFile(path.join(root,'registry.json'),JSON.stringify({version:1,apps:{}}))
  let release;const held=m.locked(()=>new Promise(r=>{release=r}))
  while(!release)await new Promise(r=>setImmediate(r))
  const other=new AppManager({root,docker:docker.run})
  await assert.rejects(other.prepare({plan}),/Another application operation/)
  release();await held
  assert.equal((await other.prepare({plan})).state,'review')
})
