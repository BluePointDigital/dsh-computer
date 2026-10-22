/** Live HTTP/WS auth acceptance. Ephemeral tickets/cookies never printed or persisted. */
import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
const control='https://dev.bluepointdigital.com'
function request(url,{method='GET',headers={},body}={}) {
 return new Promise((resolve,reject)=>{
  const u=new URL(url),transport=u.protocol==='https:'?https:http
  const r=transport.request(u,{method,headers,timeout:15000},s=>{let b='';s.on('data',x=>b+=x);s.on('end',()=>resolve({status:s.statusCode,headers:s.headers,body:b}))})
  r.on('error',reject);r.on('timeout',()=>r.destroy(Error('timeout')));r.end(body)
 })
}
const inventory=JSON.parse((await request('http://127.0.0.1:8080/apps/api/runtime/inventory?refresh=1')).body)
assert(inventory.ok);assert(!inventory.apps.some(a=>a.launch?.mode==='ports'))
const results=[]
for(const id of ['filebrowser','docker-dsh-inner-port-6017b54452']) {
 const app=inventory.apps.find(a=>a.id===id);assert.equal(app.state,'running');assert.equal(app.launch.mode,'isolated')
 const origin=app.launch.origin
 const anonymous=await request(origin+'/');assert.equal(anonymous.status,401)
 // Loopback control proxy is the trusted local operator entry; use the same
 // authenticated top-level open operation as the dashboard's new-tab action.
 const launch=await request('http://127.0.0.1:8080/apps/api/open?id='+encodeURIComponent(id))
 assert.equal(launch.status,303);const url=new URL(launch.headers.location);assert.equal(url.origin,origin)
 const ticket=url.hash.slice(1);assert(ticket);const post={method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({ticket})}
 const exchange=await request(origin+'/__dsh_apps/session',post);assert.equal(exchange.status,200)
 const value=exchange.headers['set-cookie']?.[0];assert(value);for(const flag of ['Secure','HttpOnly','SameSite=None','Partitioned'])assert(value.includes(flag))
 const cookie=value.split(';')[0]
 const authenticated=await request(new URL(JSON.parse(exchange.body).entryPath,origin),{headers:{cookie}});assert.equal(authenticated.status,200)
 const replay=await request(origin+'/__dsh_apps/session',post);assert.equal(replay.status,401)
 const ws=await request(origin+'/socket.io/?EIO=4&transport=websocket',{headers:{connection:'Upgrade',upgrade:'websocket','sec-websocket-version':'13','sec-websocket-key':crypto.randomBytes(16).toString('base64'),origin}});assert.equal(ws.status,401)
 const bad=await request(origin+'/',{headers:{cookie:'__Host-dsh-app-session=invalid'}});assert.equal(bad.status,401)
 results.push({id,anonymous:anonymous.status,authorized:authenticated.status,replay:replay.status,anonymousWebSocket:ws.status,secureCookie:true})
}
const denied=await request(control+'/apps/api/launch',{method:'POST',headers:{origin:control,'content-type':'application/json'},body:JSON.stringify({id:'filebrowser'})});assert.equal(denied.status,401)
console.log(JSON.stringify({restored:true,apps:results,anonymousPublicLaunch:denied.status}))
