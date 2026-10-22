import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccessHealth } from '../lib/access-health.js'
import { createAccessHealthBanner } from '../lib/runtime-ui.js'
const domain = 'control.customer.example'
const gateway = { mode: 'isolated', domain }
const snapshot = { configured: true, domain, phase: 'ready', records: [{type:'A',name:`*.${domain}`,value:'192.0.2.10',proxy:'DNS only'},{type:'CNAME',name:`_acme-challenge.${domain}`,value:'unique.auth.example',proxy:'DNS only'}], certificate:{expires:Date.now()+86400000} }
const error = code => { throw Object.assign(Error('private resolver message'), {code}) }
const resolver = {resolve4:async()=>['192.0.2.10'],resolve6:async()=>error('ENODATA'),resolveCname:async()=>['unique.auth.example.']}
const make = extra => new AccessHealth({gateway,tlsManager:{status:async()=>snapshot},listenerReady:()=>true,resolver,...extra})
test('healthy wildcard/delegation disappear warning without claiming global DNS acceptance', async()=>{
 const s=await make().status();assert.deepEqual(s.issues,[]);assert.match(s.dns.probe,/dsh-check-[a-f0-9]+\.control/);assert.match(s.note,/not proof/)
})
test('missing wildcard and delegation provide exact records without worker credentials',async()=>{
 const s=await make({resolver:{resolve4:async()=>error('ENOTFOUND'),resolve6:resolver.resolve6,resolveCname:async()=>error('ENODATA')}}).status()
 assert(s.issues.some(i=>i.title==='Wildcard app DNS is missing'));assert(s.issues.some(i=>i.title.includes('CNAME')));assert.equal(s.records[0].value,'192.0.2.10');assert(!JSON.stringify(s).includes('private resolver'))
})
test('resolver failure is inconclusive not a false missing-record claim',async()=>{
 const s=await make({resolver:{...resolver,resolve4:async()=>error('ETIMEOUT')}}).status();assert.equal(s.dns.state,'unknown');assert(s.issues.some(i=>i.kind==='unknown'));assert(!s.issues.some(i=>i.title==='Wildcard app DNS is missing'))
})
test('wrong ingress and unexpected AAAA have actionable DNS correction',async()=>{
 const s=await make({resolver:{...resolver,resolve4:async()=>['192.0.2.11'],resolve6:async()=>['2001:db8::1']}}).status();assert(s.issues.some(i=>i.instruction.includes('A 192.0.2.10')))
})
test('unprovisioned instance does not invent ingress address or validation delegation',async()=>{
 const s=await make({tlsManager:{status:async()=>({configured:false})},listenerReady:()=>false}).status();assert.equal(s.records[0].value,null);assert(!s.records.some(r=>r.type==='CNAME'));assert(s.issues.some(i=>i.kind==='tls'));assert(s.issues.some(i=>i.kind==='gateway'))
})
test('snapshot mismatch never presents records for another instance',async()=>{
 const s=await make({tlsManager:{status:async()=>({...snapshot,domain:'other.example'})}}).status();assert(!JSON.stringify(s.records).includes('192.0.2.10'));assert(s.issues.some(i=>i.title.includes('another domain')))
})
test('port and legacy access warn about missing authentication, without issuing DNS guesses',async()=>{
 for(const gateway of [null,{mode:'ports'}]){const s=await make({gateway}).status();assert.equal(s.issues[0].kind,'configuration');assert.deepEqual(s.records,[])}
})
test('checks coalesce, ordinary cache lasts 30s, force has a 5s minimum',async()=>{
 let count=0,now=0;const health=make({now:()=>now,resolver:{...resolver,resolve4:async()=>{count++;return ['192.0.2.10']}}});await Promise.all([health.status(),health.status(true)]);assert.equal(count,1);now=4000;await health.status(true);assert.equal(count,1);now=6000;await health.status(true);assert.equal(count,2);now=20000;await health.status();assert.equal(count,2)
})
test('banner renders records as escaped text and retry failures, healthy hidden',()=>{
 function render(health,error=''){
 let i=0;const fake={...React,useState:()=>[[health,error,false][i++],()=>{}],useRef:()=>({}),useCallback:f=>f,useEffect:()=>{}}
 return renderToStaticMarkup(React.createElement(createAccessHealthBanner({React:fake,api:async()=>{}})))
 }
 assert.equal(render({issues:[]}), '');const html=render({issues:[{title:'DNS missing',instruction:'Create wildcard'}],records:[{type:'A',name:'*.control.example',value:'<img src=x>',proxy:'DNS only'}]});assert.match(html,/Application access needs attention/);assert.match(html,/Recheck/);assert.match(html,/&lt;img/);assert(!html.includes('<img'));assert.match(render(null,'unavailable'),/does not confirm a DNS fault/)
})
