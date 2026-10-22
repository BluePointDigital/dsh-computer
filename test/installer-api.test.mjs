import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { AppManager } from '../lib/app-manager.js'
import { dockerFixture } from './helpers/docker-fixture.mjs'
const { apply }=await import('../lib/index.js')

test('installer API gates all routes, rejects malformed POST, exposes recipes and private review',async t=>{
 const fixture=await dockerFixture(t,{catalog:[{id:'unstarted',image:'fixture:1'}]});const {root}=fixture
 const disposers=[],routes=new Map()
 const ctx={logger:{info(){}},connection:{requestRejection:req=>req.headers['x-auth']==='yes'?undefined:401},effect(fn){const d=fn();if(d)disposers.push(d)},webServer:{register(r){routes.set(r.path,r);return()=>routes.delete(r.path)},registerUpgrade(){return()=>{}}}}
 const server=http.createServer((req,res)=>routes.get('/apps/api').handler(req,res))
 fixture.disposers.push(async()=>{while(disposers.length)await disposers.pop()();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 await apply(ctx,{computerBin:'must-not-execute'})
 const port=await new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server.address().port)))
 const req=(method,route,body,auth=true,type='application/json')=>new Promise((resolve,reject)=>{
  const request=http.request({host:'127.0.0.1',port,path:'/apps/api/'+route,method,headers:{...(auth?{'x-auth':'yes'}:{}),'content-type':type}},res=>{let data='';res.on('data',b=>data+=b);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(data)}))});request.on('error',reject);request.end(method==='GET'||body===undefined?undefined:JSON.stringify(body))
 })
 for(const route of ['recipes','jobs','prepare','approve','recover','retry'])assert.equal((await req(route==='recipes'||route==='jobs'?'GET':'POST',route,{},false)).status,401)
 assert.equal((await req('GET','recipes')).data.recipes.length,8)
 assert.equal((await req('GET','prepare')).status,405)
 assert.equal((await req('POST','prepare',{},true,'text/plain')).status,405)
 const invalid=await req('POST','prepare',{plan:{id:'bad',image:'nginx:1',privileged:true}});assert.equal(invalid.status,500);assert.ok(invalid.data.error.includes('Unsupported'))
 const manager=new AppManager({root,docker:async args=>args[0]==='image'?{code:0,stdout:JSON.stringify([{Id:'sha256:'+'c'.repeat(64)}])}:{code:1,stderr:'No such object'}})
 const job=await manager.prepare({plan:{id:'safe',image:'example:1',env:{API_KEY:'PRIVATE_CANARY'}}})
 const jobs=await req('GET','jobs');assert.equal(jobs.status,200);assert.ok(!JSON.stringify(jobs).includes('PRIVATE_CANARY'));assert.deepEqual(jobs.data.jobs[0].plan.environmentKeys,['API_KEY'])
 assert.equal((await req('POST','approve',{id:job.id,approval:'wrong',trusted:true})).status,500)
 assert.equal((await manager.job(job.id)).state,'review')
 assert.equal((await req('POST','cancel',{id:job.id})).data.job.state,'cancelled')
})
