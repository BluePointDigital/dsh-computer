#!/usr/bin/env node
/** Both the GUI and agents use AppManager. Legacy catalog commands stay compatible. */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { AppManager, recipes } from '../lib/app-manager.js'
import { ExistingApps } from '../lib/existing-apps.js'
import { describeApps, gatewayConfig } from '../lib/app-launch.js'
import { AppPorts } from '../lib/app-ports.js'
const exec = promisify(execFile)
const bin = fileURLToPath(new URL('./computer', import.meta.url))
const args = process.argv.slice(2)
const [command = 'list', ...rest] = args
const legacy = async () => {
  const { stdout } = await exec(bin, ['apps','list','--json'], { env: { ...process.env, COMPUTER_APPS_LEGACY: '1' }, maxBuffer: 8*1024*1024 })
  return JSON.parse(stdout).apps
}
const manager = new AppManager({ legacy })
const existing = new ExistingApps(manager)
const launchConfig = async () => {
  const saved = await manager.read('launch-config.json', {})
  const explicit = process.env.DSH_APPS_ACCESS || process.env.DSH_APPS_DOMAIN || process.env.DSH_APPS_CONTROL_ORIGIN
  return explicit ? gatewayConfig() : Object.keys(saved).length ? gatewayConfig(saved, {}) : gatewayConfig()
}
const listApps = async () => {
  const config = await launchConfig()
  return describeApps(await new AppPorts(manager).assign([...await legacy(), ...await manager.list(), ...await existing.list()], config), config)
}
const json = (value) => console.log(JSON.stringify(value))
async function stdinJson() {
  let text = ''
  for await (const chunk of process.stdin) { text += chunk; if(text.length>65536)throw Error('Plan exceeds 64 KiB') }
  return JSON.parse(text)
}
try {
  if(command==='discover-existing') json({ok:true,containers:await existing.discover([...await legacy(),...await manager.list()])})
  else if(command==='review-existing') json({ok:true,review:await existing.review(await stdinJson())})
  else if(command==='add-existing') json({ok:true,app:await existing.add(await stdinJson())})
  else if(command==='recipes') json({ok:true,recipes})
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
    const apps=await listApps()
    if(rest.includes('--json'))json({ok:true,schemaVersion:1,apps})
    else { console.log('ID\tNAME\tSTATE\tSOURCE');for(const app of apps)console.log([app.id,app.name,app.state,app.managed?'installed':'catalog'].join('\t')) }
  }else if(command==='url' && (await launchConfig())?.mode === 'ports') {
    const app = (await listApps()).find(app => app.id === rest[0])
    if (!app) throw Error('Unknown application')
    if (app.launch?.mode === 'ports') console.log(new URL(app.launch.entryPath, app.launch.origin).href)
    else if (app.launch?.mode === 'isolated') console.log(app.launch.origin + app.launch.entryPath)
    else if (app.launch?.mode === 'unavailable') throw Error(app.launch.reason)
    else {
      const child = spawn(bin, ['apps', ...args], { stdio: 'inherit', env: { ...process.env, COMPUTER_APPS_LEGACY: '1' } })
      process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    }
  }else if(command==='status' && (await launchConfig())?.mode === 'ports') {
    const app = (await listApps()).find(app => app.id === rest[0])
    if (!app) throw Error('Unknown application')
    if (app.launch?.mode === 'ports') json({ ok: true, app })
    else {
      const registry = await manager.registry()
      if (app.managed || (await existing.registry()).apps[rest[0]] || registry.apps[rest[0]]) json({ ok: true, app })
      else {
        const child = spawn(bin, ['apps', ...args], { stdio: 'inherit', env: { ...process.env, COMPUTER_APPS_LEGACY: '1' } })
        process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
      }
    }
  }else {
    const registry=await manager.registry()
    if((await existing.registry()).apps[rest[0]]) {
      if(command==='status'||command==='url')json({ok:true,app:(await listApps()).find(a=>a.id===rest[0])})
      else json(await existing.action(command,rest[0]))
    }else if(registry.apps[rest[0]] && ['up','down','rm','uninstall','logs','status','url'].includes(command)) {
      if(command==='status'||command==='url')json({ok:true,app:(await listApps()).find(app=>app.id===rest[0])})
      else json(await manager.action(command,rest[0]))
    }else {
      const child=spawn(bin,['apps',...args],{stdio:'inherit',env:{...process.env,COMPUTER_APPS_LEGACY:'1'}})
      process.exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)})
    }
  }
}catch(error){console.error('computer apps: '+error.message);process.exitCode=1}
