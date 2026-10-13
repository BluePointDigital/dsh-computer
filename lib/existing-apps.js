/** Read-only Docker discovery; explicit reviewed registration never creates containers. */
import { createHash } from 'node:crypto'
import { APP_ID, validatePlan } from './app-manager.js'
const CID = /^[a-f0-9]{64}$/
const check = (ok, message) => { if (!ok) throw Error(message) }
export class ExistingApps {
  constructor(manager) { this.manager = manager }
  async registry() {
    const data = await this.manager.read('existing.json', {version:1, apps:{}})
    check(data.version === 1 && data.apps && typeof data.apps==='object' && !Array.isArray(data.apps), 'Invalid existing-app registry')
    for(const [id,app] of Object.entries(data.apps)) check(APP_ID.test(id) && app?.id===id && CID.test(app.containerId), 'Invalid existing-app identity')
    return data
  }
  async inspect(id) {
    check(typeof id === 'string' && CID.test(id), 'Expected immutable container identity')
    const out = await this.manager.docker(['inspect', id], {timeout:10000})
    if (out.code) {
      if (/No such (object|container)/i.test(out.stderr || '')) return null
      throw Error('Docker inspection unavailable; container absence is not proven')
    }
    const info = JSON.parse(out.stdout)[0]
    check(info?.Id === id, 'Container identity changed')
    return info
  }
  summary(info) {
    const label = info.Config?.Labels?.['dsh.apps.id']
    const ports = [...new Set([...Object.keys(info.Config?.ExposedPorts || {}), ...Object.keys(info.HostConfig?.PortBindings || {})].filter(p=>p.endsWith('/tcp')).map(p=>Number(p.split('/')[0])))].filter(p=>p>0&&p<=65535)
    return {containerId:info.Id,containerName:(info.Name || '').replace(/^\//,''),image:info.Config?.Image || '', imageId:info.Image,
      labelled:typeof label === 'string' && APP_ID.test(label), suggestedId:typeof label === 'string' && APP_ID.test(label) ? label : '',
      ports, state:info.State?.Running?'running':'stopped',
      permissions:{privileged:!!info.HostConfig?.Privileged,networkMode:info.HostConfig?.NetworkMode || 'default',addedCapabilities:info.HostConfig?.CapAdd || [],hostMounts:(info.Mounts || []).filter(m=>m.Type==='bind').length,devices:(info.HostConfig?.Devices || []).length}}
  }
  async discover(known = []) {
    const out = await this.manager.docker(['ps','-aq','--no-trunc'],{timeout:10000})
    check(out.code===0, 'Docker discovery unavailable')
    const registry = await this.registry(), registered = new Set(Object.values(registry.apps).map(a=>a.containerId))
    const ids = out.stdout.trim().split(/\s+/).filter(Boolean), found=[]
    for (const id of ids) {
      if (registered.has(id)) continue
      const info=await this.inspect(id);if(!info)continue
      const item=this.summary(info)
      if (known.some(a=>a.containerId===id || (item.containerName===`dsh-app-${a.id}`))) continue
      if (item.labelled || item.ports.length) found.push(item)
    }
    return found
  }
  async list() {
    const registry=await this.registry(), result=[]
    for(const app of Object.values(registry.apps)) {
      const info=await this.inspect(app.containerId)
      result.push({...app,existing:true,managed:false,state:info?(info.State?.Running?'running':'stopped'):'missing',
        ...(info?{web:{containerPort:String(app.webPort),path:`/apps/web/${app.id}${app.webPath}`,mode:'proxy'}}:{})})
    }
    return result
  }
  async review(body) {
    check(body && typeof body==='object', 'Registration required')
    const info=await this.inspect(body.containerId);check(info,'Container no longer exists')
    check(!['host','none'].includes(info.HostConfig?.NetworkMode) && !String(info.HostConfig?.NetworkMode || '').startsWith('container:'),'This network mode cannot be embedded; use a container with its own bridge network')
    check(!info.HostConfig?.AutoRemove,'Auto-remove containers cannot be registered: stopping them deletes their container and may delete anonymous storage')
    const plan=validatePlan({id:body.id,name:body.name,webPort:body.webPort,webPath:body.webPath,webSockets:body.webSockets,webRewrite:body.webRewrite,image:'existing:review'})
    const summary=this.summary(info)
    // Bind approval to identity, chosen embed configuration and current Docker configuration.
    const configHash=createHash('sha256').update(JSON.stringify({image:info.Image,config:info.Config,host:info.HostConfig,mounts:info.Mounts})).digest('hex')
    const app={id:plan.id,name:plan.name,containerId:info.Id,image:summary.image,webPort:plan.webPort,webPath:plan.webPath,webSockets:plan.webSockets,webRewrite:plan.webRewrite}
    const approval=createHash('sha256').update(JSON.stringify({app,configHash})).digest('hex')
    return {app,summary,approval,notice:'Registration only: no container recreation, launch, port publication or storage changes. Existing container permissions are unchanged. Embedded JavaScript shares the harness origin.'}
  }
  async add(body) {
    check(body.trusted===true,'Publisher trust confirmation required')
    return this.manager.locked(async()=>{
      const review=await this.review(body)
      check(body.approval===review.approval,'Container or configuration changed; review again')
      const registry=await this.registry(), managed=await this.manager.registry(), legacy=await this.manager.legacy()
      check(!registry.apps[body.id]&&!managed.apps[body.id]&&!legacy.some(a=>a.id===body.id),'Application id already listed')
      check(!Object.values(registry.apps).some(a=>a.containerId===body.containerId),'Container already listed')
      check(!legacy.some(a=>`dsh-app-${a.id}`===review.summary.containerName)&&!Object.values(managed.apps).some(a=>a.containerId===body.containerId||`dsh-app-${a.plan.id}`===review.summary.containerName),'Container already managed')
      registry.apps[body.id]=review.app
      await this.manager.save('existing.json',registry)
      return review.app
    })
  }
  async action(action,id) {
    check(['up','down','forget'].includes(action),'Existing containers support Launch, Stop or Forget listing only')
    return this.manager.locked(async()=>{
      const registry=await this.registry(),app=registry.apps[id];check(app,'Existing app not found')
      if(action==='forget'){delete registry.apps[id];await this.manager.save('existing.json',registry);return {ok:true,output:'Listing forgotten. Container and storage unchanged.'}}
      const info=await this.inspect(app.containerId);check(info,'Original container is missing; it will not be recreated or replaced')
      check(!info.HostConfig?.AutoRemove,'Refusing lifecycle action on an auto-remove container')
      const out=await this.manager.docker([action==='up'?'start':'stop',app.containerId])
      check(out.code===0,'Container action failed')
      return {ok:true,output:'Existing container action completed; storage unchanged.'}
    })
  }
}
