import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'
const source=fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8').replace('exports.apply = apply','exports.openInstallDraft = openInstallDraft; exports.installPrompt = installPrompt; exports.apply = apply')
function load(){let module;vm.runInNewContext(source,{window:{__ModuleLoader__:{load({factory}){module=factory(()=>({createElement(){}}))}}},requestAnimationFrame:fn=>fn()});return module}
test('custom setup creates fresh retained session draft, never auto-sends',async()=>{
  const calls=[],input={setDraft:text=>calls.push(['draft',text]),focus:()=>calls.push(['focus'])}
  const ctx={sessions:{create:async args=>{calls.push(['create',args]);return'new-id'},using:async(id,reason,fn)=>{calls.push(['using',id,reason]);return fn({binding:{ctx:{session:'scope'}}})},retainInfo:()=>({getSnapshot:()=>({retainedBy:{mainView:1}})})},conversation:{input:{for:scope=>{assert.equal(scope.session,'scope');return input}}},uiWorkspace:{openSession:id=>calls.push(['open',id])}}
  assert.equal(await load().openInstallDraft(ctx,'workspace-id','Install example'),'new-id')
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])),{workspaceId:'workspace-id'})
  assert.equal(calls[0][1].sessionId,undefined)
  assert.ok(calls.find(c=>c[0]==='draft')[1].includes('Do not approve or execute'))
  assert.ok(calls.some(c=>c[0]==='open'));assert.ok(calls.some(c=>c[0]==='focus'))
  await assert.rejects(load().openInstallDraft(ctx,'','x'),/Choose a workspace/)
})
test('setup prompt directs shared installer and does not invite ad-hoc Docker flags',()=>{
 const text=load().installPrompt('Example project')
 assert.ok(text.includes('computer apps prepare'));assert.ok(text.includes('No host bind mounts'))
 assert.ok(text.includes('Never put credentials in chat'));assert.ok(text.includes('review and approve'))
})
