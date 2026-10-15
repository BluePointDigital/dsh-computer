/** Durable, single-container application installs. No Docker flag passthrough. */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { recipes, recipePlan } from './recipes.js'

export const APP_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const JOB_ID = /^[a-f0-9-]{36}$/
const SOCKET = /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/
const PREFIX = /^\/(?:[A-Za-z0-9_-]+\/)+$/
const TARGET = /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/
const inputKeys = new Set(['id','name','description','image','webPort','webPath','webSockets','webRewrite','viewer','localImage','cpus','memoryMb','shmMb','volumes','env','command','autostart'])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (condition, message) => { if (!condition) throw new Error(message) }

function integer(value, fallback, min, max, field) {
  const number = value ?? fallback
  check(Number.isInteger(number) && number >= min && number <= max, `${field} must be an integer from ${min} to ${max}`)
  return number
}
function text(value, fallback, max, field) {
  const str = value ?? fallback
  check(typeof str === 'string' && str.length <= max && !/[\u0000-\u001f\u007f]/.test(str), `Invalid ${field}`)
  return str
}
export function validatePlan(input) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'Install plan must be an object')
  for (const key of Object.keys(input)) check(inputKeys.has(key), `Unsupported install field: ${key}`)
  check(typeof input.id === 'string' && APP_ID.test(input.id), 'App id must be a lowercase slug, at most 32 characters')
  const image = text(input.image, '', 240, 'image')
  check(/^[a-z0-9][a-z0-9._/:@-]*$/i.test(image) && !image.startsWith('-'), 'Invalid image reference')
  check(/:[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(image) || /@sha256:[a-f0-9]{64}$/.test(image), 'Select an explicit image tag or sha256 digest')
  const env = {}
  check(input.env === undefined || (input.env && typeof input.env === 'object' && !Array.isArray(input.env)), 'env must be an object')
  check(Object.keys(input.env ?? {}).length <= 40, 'At most 40 environment values')
  for (const [key, value] of Object.entries(input.env ?? {})) {
    check(/^[A-Z_][A-Z0-9_]{0,63}$/.test(key), 'Invalid environment key')
    check(typeof value === 'string' && value.length <= 8192 && !/[\0\r\n]/.test(value), `Invalid environment value for ${key}`)
    env[key] = value
  }
  const paths = (value, pattern, field) => {
    check(value === undefined || (Array.isArray(value) && value.length <= 16), `Invalid ${field}`)
    const out = [...new Set(value ?? [])]
    for (const item of out) check(typeof item === 'string' && pattern.test(item), `Invalid ${field} path`)
    return out
  }
  const volumes = input.volumes ?? []
  check(Array.isArray(volumes) && volumes.length <= 4, 'At most four named data volumes')
  const targets = volumes.map((volume) => {
    check(volume && Object.keys(volume).length === 1 && typeof volume.target === 'string', 'Volume needs target only; host paths are not supported')
    const target = volume.target
    check(TARGET.test(target) && !target.split('/').some((part) => part === '.' || part === '..'), 'Invalid data directory')
    check(!['/proc','/sys','/dev','/run','/var/run','/etc','/bin','/sbin','/usr'].some((root) => target === root || target.startsWith(root+'/')), 'Data volume cannot mask a system directory')
    return { target }
  })
  check(new Set(targets.map((volume) => volume.target)).size === targets.length, 'Duplicate data directory')
  const command = input.command ?? []
  check(Array.isArray(command) && command.length <= 32, 'command must be an argv array, not a shell/flags string')
  command.forEach((value) => { check(typeof value === 'string', 'Command arguments must be strings'); text(value, '', 2048, 'command argument') })
  for (const flag of ['viewer','localImage','autostart']) check(input[flag] === undefined || typeof input[flag] === 'boolean', `${flag} must be boolean`)
  const webPath = text(input.webPath, '/', 200, 'webPath')
  check(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]*\/?$/.test(webPath) && !webPath.split('/').some((part) => part === '.' || part === '..'), 'Invalid web entry path')
  const viewer = input.viewer ?? false
  const webSockets = paths(input.webSockets ?? (viewer ? ['/websockify'] : []), SOCKET, 'webSockets')
  check(!viewer || webSockets.includes('/websockify'), 'Desktop viewer needs /websockify')
  return {
    id: input.id, name: text(input.name, input.id, 80, 'name'), description: text(input.description, '', 400, 'description'), image,
    webPort: integer(input.webPort, 80, 1, 65535, 'webPort'), webPath, webSockets,
    webRewrite: paths(input.webRewrite, PREFIX, 'webRewrite'), viewer, localImage: input.localImage ?? false,
    cpus: integer(input.cpus, 1, 1, 8, 'cpus'), memoryMb: integer(input.memoryMb, 512, 64, 16384, 'memoryMb'),
    shmMb: integer(input.shmMb, viewer ? 1024 : 64, 16, 4096, 'shmMb'), volumes: targets, env, command,
    autostart: input.autostart ?? false,
  }
}
export function publicPlan(plan) {
  const { env, viewer, ...rest } = plan
  return { ...rest, desktop: viewer, environmentKeys: Object.keys(env ?? {}), trustNotice: 'Install only publishers you trust. Legacy embeds share DSH privileges; isolated origins protect the browser boundary, not container or data permissions.' }
}
export function appStateRoot(env = process.env) {
  const root = path.resolve(env.COMPUTER_APPS_STATE || path.join(env.DSH_HOME || os.homedir(), '.dsh-applications'))
  check(!root.startsWith('/workspace/') && root !== '/workspace', 'Private application state must be outside the synced workspace')
  return root
}

/** Docker executor: never returns raw stdout/stderr to a browser job log. */
export async function dockerCommand(args, { input, timeout = 180000, signal, env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe','pipe','pipe'], signal, ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) })
    const stdout = [], stderr = []
    let bytes = 0
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
    for (const [stream, chunks] of [[child.stdout,stdout],[child.stderr,stderr]]) stream.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 8 * 1024 * 1024) child.kill('SIGTERM')
      else chunks.push(chunk)
    })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }) })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

export class AppManager {
  constructor({ root = appStateRoot(), docker = dockerCommand, legacy = async () => [], health, readyMs = 60000 } = {}) {
    this.root = path.resolve(root)
    this.docker = docker
    this.legacy = legacy
    this.health = health || ((app, ip) => this.probe(app, ip))
    this.readyMs = readyMs
  }
  async init() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    check(await fs.realpath(this.root) === this.root, 'App state cannot resolve through a symlink')
    check(this.root !== '/workspace' && !this.root.startsWith('/workspace/') && !this.root.includes('/node_modules/') && !this.root.endsWith('/node_modules'), 'App state must be outside synced workspace and package directories')
    const stat = await fs.lstat(this.root)
    check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid(), 'App state must be an owner-controlled directory, not a symlink')
    await fs.chmod(this.root, 0o700)
    for (const leaf of ['jobs','secrets']) {
      const directory = path.join(this.root,leaf)
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      const metadata = await fs.lstat(directory)
      check(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === process.getuid(), 'Private app subdirectories must be owner-controlled, not symlinks')
      await fs.chmod(directory, 0o700)
    }
  }
  async read(leaf, fallback) {
    try { return JSON.parse(await fs.readFile(path.join(this.root,leaf),'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
  }
  async save(leaf, value) {
    const dest = path.join(this.root,leaf)
    const temp = `${dest}.${randomUUID()}.tmp`
    const file = await fs.open(temp, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(value,null,2)+'\n'); await file.sync() }
    finally { await file.close() }
    await fs.rename(temp,dest)
    const directory = await fs.open(path.dirname(dest), 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
  async locked(fn, lockName = 'manager.lock') {
    check(['manager.lock', 'ports.lock'].includes(lockName), 'Invalid application lock name')
    await this.init()
    const lock = path.join(this.root, lockName)
    try { const stat = await fs.lstat(lock); check(!stat.isSymbolicLink() && stat.uid === process.getuid(), 'Unsafe application lock file') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    // Kernel flock releases automatically on process death. No PID/stale-file
    // reclamation race; the carrier stays alive while its stdin remains open.
    const holder = spawn('flock', ['--nonblock', '--exclusive', lock, 'sh', '-c', 'printf acquired; cat >/dev/null'], { stdio: ['pipe','pipe','pipe'] })
    holder.stdin.on('error', () => {})
    await new Promise((resolve, reject) => {
      holder.once('error', reject)
      holder.stdout.once('data', () => resolve())
      holder.once('exit', () => reject(new Error('Another application operation is active. Retry when it finishes.')))
    })
    try { return await fn() }
    finally {
      const exited = new Promise((resolve) => holder.once('exit', resolve))
      holder.stdin.end()
      await exited
    }
  }
  async registry() {
    const registry = await this.read('registry.json',{version:1,apps:{}})
    check(registry.version === 1 && registry.apps && typeof registry.apps === 'object' && !Array.isArray(registry.apps), 'Unsupported or corrupt application registry')
    return registry
  }
  async inspect(id) {
    const out = await this.docker(['inspect', `dsh-app-${id}`],{timeout:10000})
    if(out.code) {
      if (/No such (object|container)/i.test(out.stderr ?? '')) return null
      throw new Error('Docker inspection failed; absence is not proven. Check daemon availability before retrying.')
    }
    return JSON.parse(out.stdout)[0]
  }
  owns(info, app) { return info?.Config?.Labels?.['dsh.apps.install'] === app.owner && info.Config.Labels['dsh.apps.id'] === app.plan.id }
  async jobs() {
    await this.init()
    const entries = await fs.readdir(path.join(this.root,'jobs'))
    const result=[]
    for(const leaf of entries.filter((leaf)=>JOB_ID.test(leaf.replace(/\.json$/,'')) && leaf.endsWith('.json'))) {
      const job=await this.read(`jobs/${leaf}`)
      if(job)result.push(this.publicJob(job))
    }
    return result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,30)
  }
  publicJob(job) {
    const { plan, secretRef, environmentKeys, ...publicFields }=job
    return {...publicFields,plan:{...publicPlan(plan),environmentKeys:environmentKeys ?? []}}
  }
  async job(id) { check(JOB_ID.test(id),'Invalid operation id'); const job=await this.read(`jobs/${id}.json`);check(job,'Operation not found');return job }
  async clearSecrets(job) {
    check(JOB_ID.test(job.id) && job.secretRef === `${job.id}.json`, 'Invalid secret reference')
    for (const suffix of ['json','env']) {
      const target = path.join(this.root,'secrets',`${job.id}.${suffix}`)
      check(path.dirname(target) === path.join(this.root,'secrets'), 'Unsafe secret path')
      await fs.unlink(target).catch((error) => { if(error.code !== 'ENOENT') throw error })
    }
  }
  async prepare(input) {
    const plan=validatePlan(input.recipe ? recipePlan(input.recipe) : input.plan ?? input)
    return this.locked(async()=>{
      const registry=await this.registry()
      const legacy=await this.legacy()
      check(!(await this.read('existing.json',{apps:{}})).apps[plan.id] && !registry.apps[plan.id] && !legacy.some(app=>app.id===plan.id), 'This app id already exists. Choose another id; existing apps are never replaced by Install.')
      check(!await this.inspect(plan.id),'A container with this app id already exists; it will not be adopted or replaced.')
      const id=randomUUID(), secretRef=`${id}.json`
      await this.save(`secrets/${secretRef}`,plan.env)
      const job={id,kind:'install',state:'resolving',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),plan:{...plan,env:{}},environmentKeys:Object.keys(plan.env),secretRef,events:['Resolving immutable image content for review. Downloading does not create/start a container.']}
      await this.save(`jobs/${id}.json`,job)
      try {
        let image = await this.docker(['image','inspect',plan.image],{timeout:10000})
        if (image.code && !plan.localImage) {
          await this.event(job,'resolving','Downloading image to inspect its content and declared storage before review.')
          check((await this.docker(['pull',plan.image],{timeout:600000})).code === 0,'Image download failed. Verify image/registry/network.')
          image = await this.docker(['image','inspect',plan.image],{timeout:10000})
        }
        check(image.code === 0,'Selected local image is not present. Build it first; public substitute refused.')
        const info = JSON.parse(image.stdout)[0]
        check(/^sha256:[a-f0-9]{64}$/.test(info.Id),'Image content id is invalid')
        const imageVolumes = Object.keys(info.Config?.Volumes ?? {})
        check(imageVolumes.every(target => plan.volumes.some(volume => volume.target === target)), `Image declares persistent directories: ${imageVolumes.join(', ')}. Include every directory in volumes so storage is reviewed and owned.`)
        job.imageId = info.Id
        job.approval = createHash('sha256').update(id + JSON.stringify(publicPlan(plan)) + info.Id).digest('hex')
        await this.event(job,'review','Image resolved. Review the exact content id, permissions, storage and publisher before approving.')
      } catch(error) {
        await this.event(job,'failed',error.message)
        await this.clearSecrets(job)
      }
      return this.publicJob(job)
    })
  }
  async event(job,state,message) {
    job.state=state;job.updatedAt=new Date().toISOString();job.events=[...job.events,message].slice(-60)
    await this.save(`jobs/${job.id}.json`,job)
  }
  async credentials(id, values) {
    return this.locked(async () => {
      const job = await this.job(id)
      check(job.state === 'review', 'Credentials can only be added before approval')
      const env = validatePlan({ ...job.plan, env: values }).env
      await this.save(`secrets/${job.secretRef}`, env)
      job.environmentKeys = Object.keys(env)
      job.approval = createHash('sha256').update(job.id + JSON.stringify(publicPlan({ ...job.plan, env })) + job.imageId + randomUUID()).digest('hex')
      await this.event(job,'review','Environment values saved privately. Previous approval token invalidated; review the key names again.')
      return this.publicJob(job)
    })
  }
  async approve(id,approval,trusted) {
    return this.locked(async()=>{
      const job=await this.job(id)
      if (job.state === 'queued' && job.approval === approval && trusted === true) return this.publicJob(job)
      check(Date.now()-Date.parse(job.createdAt) < 24*60*60*1000,'Install review expired; prepare a fresh plan')
      check(job.state==='review' && job.approval===approval && trusted===true,'Explicit approval of this reviewed plan and trusted publisher is required')
      await this.event(job,'queued','Approved. Waiting for installer worker.')
      return this.publicJob(job)
    })
  }
  async run(id) {
    return this.locked(async()=>{
      const job=await this.job(id)
      check(job.state==='queued','Operation is not queued; it cannot run twice')
      const registry=await this.registry()
      const plan=job.plan
      if ((await this.read('existing.json',{apps:{}})).apps[plan.id] || registry.apps[plan.id] || (await this.legacy()).some(app=>app.id===plan.id) || await this.inspect(plan.id)) {
        await this.event(job,'failed','Application/container id became occupied after review. Existing app left unchanged; choose another id.')
        await this.clearSecrets(job)
        return this.publicJob(job)
      }
      const app={plan,owner:job.id,secretRef:job.secretRef,environmentKeys:job.environmentKeys,installedAt:new Date().toISOString(),status:'installing'}
      registry.apps[plan.id]=app
      await this.save('registry.json',registry)
      try {
        await this.event(job,'image','Checking the exact image content approved during review.')
        const image=await this.docker(['image','inspect',job.imageId],{timeout:10000})
        check(image.code===0,'Reviewed image content is no longer present. Prepare a new review.')
        app.imageId=JSON.parse(image.stdout)[0].Id
        check(app.imageId===job.imageId,'Image content changed after review')
        await this.save('registry.json',registry)
        await this.event(job,'creating','Creating a resource-limited container. No host mounts or privileged access.')
        const env=await this.read(`secrets/${app.secretRef}`)
        check(env && typeof env === 'object','Reviewed environment credentials are missing. Prepare a new review.')
        check(job.environmentKeys.every(key => typeof env[key] === 'string'), 'Reviewed environment input is incomplete')
        if(plan.viewer){env.VNC_PASSWORD=randomBytes(12).toString('hex');env.SCREEN_GEOMETRY='1440x900x24';await this.save(`secrets/${app.secretRef}`,env)}
        const args=await this.createArgs(app,env)
        const out=await this.docker(args,{timeout:180000})
        check(out.code===0,'Container creation failed; check image support and data directory permissions.')
        await this.event(job,'starting','Starting the container and checking its web entry point.')
        const createdInfo=await this.inspect(plan.id)
        check(this.owns(createdInfo,app),'Created container ownership could not be verified')
        app.containerId=createdInfo.Id
        await this.save('registry.json',registry)
        const start=await this.docker(['start',app.containerId])
        check(start.code===0,'Container did not start')
        if(plan.viewer){
          const setup=await this.docker(['exec',app.containerId,'sh','-lc','for i in $(seq 1 80); do xdpyinfo >/dev/null 2>&1 && exec box-desktop; sleep .25; done; exit 1'],{timeout:45000})
          check(setup.code===0,'Desktop display/viewer did not start')
        }
        const deadline=Date.now()+this.readyMs
        let ready=false
        while(Date.now()<deadline){
          const info=await this.inspect(plan.id)
          check(this.owns(info,app),'Container ownership changed during install')
          if(info.State?.Running){
            const ip=Object.values(info.NetworkSettings?.Networks ?? {}).find(n=>n.IPAddress)?.IPAddress
            if(ip && await this.health(plan,ip)){ready=true;break}
          }else check(!info.State?.Dead && info.State?.Status!=='exited','Application exited before its web UI was ready')
          await sleep(500)
        }
        check(ready,'Web UI did not become ready. This image may need additional configuration.')
        app.status='installed';await this.save('registry.json',registry)
        await this.event(job,'ready','Installed. Open the app inside DSH. If its UI needs base-path adaptation, ask the setup agent before trusting it.')
      }catch(error){
        // create timeout/nonzero can still leave a container: ownership labels,
        // not the command return code, decide whether rollback may remove it.
        let info
        try { info = await this.inspect(plan.id) }
        catch {
          await this.event(job,'failed','Install interrupted and Docker state is uncertain. Ownership record retained; Recover interrupted installs when the daemon is available.')
          return this.publicJob(job)
        }
        if(this.owns(info,app)) {
          const rollback=await this.docker(['rm','-f',info.Id || `dsh-app-${plan.id}`])
          if(rollback.code!==0){app.status='installing';await this.save('registry.json',registry);await this.event(job,'failed','Install failed and owned container cleanup failed. Use Recover interrupted install before retrying.');return this.publicJob(job)}
        }
        delete registry.apps[plan.id];await this.save('registry.json',registry)
        await this.event(job,'failed',`Install failed: ${error.message}. Owned container removed if created; downloaded image and named data volumes kept.`)
        await this.clearSecrets(job)
      }
      return this.publicJob(job)
    })
  }
  async createArgs(app,env) {
    const {plan,owner}=app
    const args=['create','--name',`dsh-app-${plan.id}`,'--label','dsh.apps.managed=1','--label',`dsh.apps.id=${plan.id}`,'--label',`dsh.apps.install=${owner}`,
      '--security-opt','no-new-privileges','--log-driver','json-file','--log-opt','max-size=10m','--log-opt','max-file=2','--pids-limit','2048','--cpus',String(plan.cpus),'--memory',`${plan.memoryMb}m`,'--shm-size',`${plan.shmMb}m`,'--restart',plan.autostart?'unless-stopped':'no']
    // Docker reads a private env file, not credential-bearing command arguments.
    const envFile=path.join(this.root,'secrets',`${owner}.env`)
    await fs.writeFile(envFile,Object.entries(env).map(([key,value])=>`${key}=${value}`).join('\n')+'\n',{mode:0o600})
    args.push('--env-file',envFile)
    plan.volumes.forEach((volume,index)=>args.push('--mount',`type=volume,src=dsh-app-${plan.id}-${owner}-data-${index},dst=${volume.target}`))
    args.push(app.imageId,...plan.command)
    return args
  }
  async probe(plan,ip) {
    return new Promise(resolve=>{
      const req=http.get({hostname:ip,port:plan.webPort,path:plan.webPath,timeout:2000},res=>{res.resume();resolve(res.statusCode>=200 && res.statusCode<400)})
      req.on('error',()=>resolve(false));req.on('timeout',()=>{req.destroy();resolve(false)})
    })
  }
  async list() {
    const registry=await this.registry(), out=[]
    for(const app of Object.values(registry.apps)){
      const info=await this.inspect(app.plan.id)
      const owned=this.owns(info,app)
      const plan=app.plan
      const item={...publicPlan(plan),environmentKeys:app.environmentKeys ?? [],managed:true,installed:true,installStatus:app.status,
        state:owned?(info.State?.Running?'running':'stopped'):'new',
        owner:app.owner,
        ...(owned && info.Id ? {containerId:info.Id} : {}),
        ...(owned ? {web:{containerPort:String(plan.webPort),path:`/apps/web/${plan.id}${plan.webPath}`,mode:'proxy'}} : {}),
        dataVolumes:plan.volumes.map((volume,index)=>({name:`dsh-app-${plan.id}-${app.owner}-data-${index}`,target:volume.target})),
      }
      if(plan.viewer && owned){const env=await this.read(`secrets/${app.secretRef}`,{});item.viewer={password:env.VNC_PASSWORD ?? ''}}
      out.push(item)
    }
    return out
  }
  async action(action,id) {
    check(APP_ID.test(id),'Invalid application id')
    check(['up','down','rm','uninstall','logs'].includes(action),'Unsupported application action')
    if(action==='logs'){
      const registry=await this.registry(),app=registry.apps[id];check(app,'Managed application not found')
      const info=await this.inspect(id);check(this.owns(info,app),'Refusing logs for an unowned container')
      const result=await this.docker(['logs','--tail','80',info.Id],{timeout:10000})
      const env=await this.read(`secrets/${app.secretRef}`,{})
      let output=result.stdout+'\n'+result.stderr
      for(const value of Object.values(env))if(value)output=output.split(value).join('[REDACTED]')
      return {ok:result.code===0,output:output.slice(-16000)}
    }
    return this.locked(async()=>{
      const registry=await this.registry(),app=registry.apps[id];check(app,'Managed application not found')
      const info=await this.inspect(id)
      check(!info || this.owns(info,app),'Refusing action on a container not owned by this install')
      if(action==='up'){
        if (!info) {
          const env = await this.read(`secrets/${app.secretRef}`)
          check(env && typeof env === 'object', 'Installed credentials are unavailable; prepare a fresh review')
          const image = await this.docker(['image','inspect',app.imageId],{timeout:10000})
          check(image.code===0, 'Pinned installed image is missing; restore it before starting')
          const create = await this.docker(await this.createArgs(app,env))
          check(create.code===0, 'Could not restore installed container; no existing app was replaced')
          const restored=await this.inspect(id)
          check(this.owns(restored,app),'Restored container ownership could not be verified')
          app.containerId=restored.Id
          await this.save('registry.json',registry)
          const started=await this.docker(['start',restored.Id]);check(started.code===0,'Could not start restored app')
          if(app.plan.viewer){const setup=await this.docker(['exec',restored.Id,'sh','-lc','for i in $(seq 1 80); do xdpyinfo >/dev/null 2>&1 && exec box-desktop; sleep .25; done; exit 1'],{timeout:45000});check(setup.code===0,'Restored desktop did not become ready')}
          return {ok:true,output:'Restored the installed container from its pinned image and existing owned data volumes.'}
        }
        const result=await this.docker(['start',info.Id]);check(result.code===0,'Could not start app')
        if(app.plan.viewer){const setup=await this.docker(['exec',info.Id,'sh','-lc','for i in $(seq 1 80); do xdpyinfo >/dev/null 2>&1 && exec box-desktop; sleep .25; done; exit 1'],{timeout:45000});check(setup.code===0,'Desktop did not become ready')}
      }else if(action==='down' && info){check((await this.docker(['stop',info.Id])).code===0,'Could not stop app')}
      else if((action==='rm'||action==='uninstall') && info){check((await this.docker(['rm','-f',info.Id])).code===0,'Could not remove app')}
      if(action==='uninstall'){
        delete registry.apps[id];await this.save('registry.json',registry)
        await this.clearSecrets(await this.job(app.owner))
      }
      return {ok:true,output:action==='uninstall'?'Uninstalled. Named data volumes and image kept; no other apps changed.':'Application action completed. Data volumes kept.'}
    })
  }
  async cancel(id) {
    return this.locked(async()=>{const job=await this.job(id);check(['review','queued'].includes(job.state),'Only plans not yet executing can be cancelled');await this.event(job,'cancelled','Plan cancelled. No container was created.');await this.clearSecrets(job);return this.publicJob(job)})
  }
  async recover() {
    return this.locked(async()=>{
      const registry=await this.registry()
      const recovered=[]
      for(const app of Object.values(registry.apps).filter(app=>app.status==='installing')){
        const job=await this.job(app.owner)
        const info=await this.inspect(app.plan.id)
        if(this.owns(info,app))check((await this.docker(['rm','-f',info.Id])).code===0,'Could not clean interrupted install')
        delete registry.apps[app.plan.id]
        await this.event(job,'failed','Installer interrupted. Its owned container was cleaned up; named volumes and images retained. Review a new plan to retry.')
        await this.clearSecrets(job)
        recovered.push(job.id)
      }
      await this.save('registry.json',registry)
      for (const item of await this.jobs()) {
        if (!['resolving','queued','image','pulling','creating','starting'].includes(item.state)) continue
        const job = await this.job(item.id)
        if (registry.apps[job.plan.id]?.owner === job.id && registry.apps[job.plan.id].status === 'installed') {
          await this.event(job,'ready','Install completed before worker interruption; existing installed app retained.')
        } else {
          await this.event(job,'failed','Installer was interrupted before completion. Prepare and approve a fresh plan; nothing is resumed silently.')
          await this.clearSecrets(job)
        }
        recovered.push(job.id)
      }
      return recovered
    })
  }
}

export { recipes }
