#!/usr/bin/env node
/** Both the GUI and agents use AppManager. Legacy catalog commands stay compatible. */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { AppManager, recipes } from '../lib/app-manager.js'
const exec = promisify(execFile)
const bin = fileURLToPath(new URL('./computer', import.meta.url))
const args = process.argv.slice(2)
const [command = 'list', ...rest] = args
const legacy = async () => {
  const { stdout } = await exec(bin, ['apps','list','--json'], { env: { ...process.env, COMPUTER_APPS_LEGACY: '1' }, maxBuffer: 8*1024*1024 })
  return JSON.parse(stdout).apps
}
const manager = new AppManager({ legacy })
const json = (value) => console.log(JSON.stringify(value))
async function stdinJson() {
  let text = ''
  for await (const chunk of process.stdin) { text += chunk; if(text.length>65536)throw Error('Plan exceeds 64 KiB') }
  return JSON.parse(text)
}
try {
  if(command==='recipes') json({ok:true,recipes})
  else if(command==='prepare') json({ok:true,job:await manager.prepare(await stdinJson())})
  else if(command==='approve') {
    if(rest[2]!=='--trust-publisher')throw Error('Usage: approve <job-id> <approval-hash> --trust-publisher')
    json({ok:true,job:await manager.approve(rest[0],rest[1],true)})
  }
  else if(command==='run') json({ok:true,job:await manager.run(rest[0])})
  else if(command==='jobs') json({ok:true,jobs:await manager.jobs()})
  else if(command==='cancel') json({ok:true,job:await manager.cancel(rest[0])})
  else if(command==='recover') json({ok:true,recovered:await manager.recover()})
  else if(command==='list' || command==='ls') {
    const apps=[...await legacy(),...await manager.list()]
    const ids=new Set()
    for(const app of apps){if(ids.has(app.id))throw Error('Duplicate legacy/installed app id: '+app.id);ids.add(app.id)}
    if(rest.includes('--json'))json({ok:true,schemaVersion:1,apps})
    else { console.log('ID\tNAME\tSTATE\tSOURCE');for(const app of apps)console.log([app.id,app.name,app.state,app.managed?'installed':'catalog'].join('\t')) }
  }else {
    const registry=await manager.registry()
    if(registry.apps[rest[0]] && ['up','down','rm','uninstall','logs','status','url'].includes(command)) {
      if(command==='status'||command==='url')json({ok:true,app:(await manager.list()).find(app=>app.id===rest[0])})
      else json(await manager.action(command,rest[0]))
    }else {
      const child=spawn(bin,['apps',...args],{stdio:'inherit',env:{...process.env,COMPUTER_APPS_LEGACY:'1'}})
      process.exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)})
    }
  }
}catch(error){console.error('computer apps: '+error.message);process.exitCode=1}
