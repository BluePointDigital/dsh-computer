import test from 'node:test'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {AppManager} from '../lib/app-manager.js'
import {ExistingApps} from '../lib/existing-apps.js'
import {durableCatalog} from '../lib/catalog-state.mjs'

async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'existing-app-test-'))
 t.after(()=>fs.rm(root,{recursive:true,force:true}))
 const id='a'.repeat(64),calls=[]
 let info={Id:id,Name:'/dsh-app-hyperframes',Image:'sha256:one',State:{Running:false},Config:{Image:'hyperframes:local',Labels:{'dsh.apps.id':'hyperframes'},ExposedPorts:{'3002/tcp':{}},Env:['PRIVATE=never-return']},HostConfig:{PortBindings:{}},Mounts:[{Name:'original-data',Destination:'/home/agent'}]}
 const docker=async args=>{calls.push(args);if(args[0]==='ps')return {code:0,stdout:id};if(args[0]==='inspect')return info?{code:0,stdout:JSON.stringify([info])}:{code:1,stderr:'No such object'};return {code:0,stdout:''}}
 const manager=new AppManager({root,docker}),existing=new ExistingApps(manager)
 return {root,id,manager,existing,calls,setInfo:v=>info=v,getInfo:()=>info}
}

test('labelled orphan discovered without leaking environment; registration preserves container',async t=>{
 const f=await fixture(t),found=await f.existing.discover()
 assert.equal(found[0].suggestedId,'hyperframes');assert.deepEqual(found[0].ports,[3002]);assert(!JSON.stringify(found).includes('never-return'))
 const body={containerId:f.id,id:'hyperframes',name:'HyperFrames',webPort:3002}
 const review=await f.existing.review(body)
 await assert.rejects(f.existing.add({...body,approval:review.approval}),/trust/)
 await f.existing.add({...body,approval:review.approval,trusted:true})
 assert.equal((await f.existing.list())[0].state,'stopped')
 assert.deepEqual(await f.existing.discover(),[])
 assert(f.calls.every(a=>['ps','inspect'].includes(a[0])))
 await f.existing.action('up','hyperframes');assert.deepEqual(f.calls.at(-1),['start',f.id])
 await assert.rejects(f.existing.action('rm','hyperframes'),/only/)
 f.setInfo(null);assert.equal((await f.existing.list())[0].state,'missing')
 await assert.rejects(f.existing.action('up','hyperframes'),/missing/)
 await f.existing.action('forget','hyperframes');assert.deepEqual(await f.existing.list(),[])
})

test('review binds configuration and immutable identity, rejects duplicate managed names',async t=>{
 const f=await fixture(t),body={containerId:f.id,id:'hyperframes',webPort:3002}
 const review=await f.existing.review(body)
 f.getInfo().Config.Env=['PRIVATE=changed']
 await assert.rejects(f.existing.add({...body,approval:review.approval,trusted:true}),/changed/)
 const next=await f.existing.review(body);f.manager.legacy=async()=>[{id:'hyperframes'}]
 await assert.rejects(f.existing.add({...body,approval:next.approval,trusted:true}),/already/)
 f.setInfo({...f.getInfo(),Id:'b'.repeat(64)})
 await assert.rejects(f.existing.review(body),/identity/)
})

test('auto-remove containers cannot turn Stop into deletion',async t=>{
 const f=await fixture(t);f.getInfo().HostConfig.AutoRemove=true
 await assert.rejects(f.existing.review({containerId:f.id,id:'ephemeral',webPort:80}),/Auto-remove/)
 assert(f.calls.every(a=>a[0]==='inspect'))
})

test('unsupported network modes rejected before registering unusable mount',async t=>{
 const f=await fixture(t)
 for(const mode of ['host','none','container:abc']){f.getInfo().HostConfig.NetworkMode=mode;await assert.rejects(f.existing.review({containerId:f.id,id:'network',webPort:80}),/network mode/)}
})

test('catalog can seed inside mutation lock and concurrent callers agree',async t=>{
 const f=await fixture(t),source=path.join(f.root,'source.yaml');await fs.writeFile(source,'catalog')
 await f.manager.locked(async()=>{const paths=await Promise.all(Array.from({length:4},()=>durableCatalog({root:f.root,source})));assert.equal(new Set(paths).size,1)})
})

test('catalog survives replacement package defaults and explicit file remains supported',async t=>{
 const f=await fixture(t),source=path.join(f.root,'package-apps.yaml')
 await fs.writeFile(source,'original catalog')
 const target=await durableCatalog({root:f.root,source})
 await fs.writeFile(source,'replacement package catalog')
 assert.equal(await durableCatalog({root:f.root,source}),target)
 assert.equal(await fs.readFile(target,'utf8'),'original catalog')
 assert.equal((await fs.stat(target)).mode&0o777,0o600)
 assert.equal(await durableCatalog({root:f.root,source,explicit:source}),source)
})

test('catalog CLI entry works through installed package directory symlink',async t=>{
 const f=await fixture(t),link=path.join(f.root,'package-link')
 await fs.symlink(fileURLToPath(new URL('..',import.meta.url)),link)
 const {stdout}=await promisify(execFile)('node',[path.join(link,'lib/catalog-state.mjs')],{env:{...process.env,COMPUTER_APPS_STATE:f.root,COMPUTER_APPS_FILE:''}})
 assert.equal(stdout.trim(),path.join(f.root,'catalog.yaml'))
})

test('new install cannot overwrite registered existing app id',async t=>{
 const f=await fixture(t),body={containerId:f.id,id:'hyperframes',webPort:3002}
 const review=await f.existing.review(body);await f.existing.add({...body,approval:review.approval,trusted:true})
 await assert.rejects(f.manager.prepare({plan:{id:'hyperframes',image:'nginx:alpine'}}),/already exists/)
})
