/** Browser-only runtime Applications UI. No host imports or implicit ownership changes. */
let terminalAssets

function loadTerminalAssets() {
  if (terminalAssets) return terminalAssets
  terminalAssets = (async () => {
    if (!document.getElementById('dsha-xterm-css')) {
      const link = document.createElement('link')
      link.id = 'dsha-xterm-css'
      link.rel = 'stylesheet'
      link.href = '/apps/assets/xterm.css'
      document.head.appendChild(link)
    }
    const script = (src, available) => available() ? Promise.resolve() : new Promise((resolve, reject) => {
      const element = document.createElement('script')
      element.src = src
      element.onload = () => available() ? resolve() : reject(new Error(`Terminal asset did not initialize: ${src}`))
      element.onerror = () => reject(new Error(`Could not load terminal asset: ${src}`))
      document.head.appendChild(element)
    })
    await script('/apps/assets/xterm.js', () => Boolean(window.Terminal))
    await script('/apps/assets/fit.js', () => Boolean(window.FitAddon?.FitAddon))
  })().catch(error => { terminalAssets = undefined; throw error })
  return terminalAssets
}

const list = value => Array.isArray(value) ? value : []
const text = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
const errorText = error => `${error?.status ? `HTTP ${error.status}: ` : ''}${error?.message || text(error) || 'Request failed'}`
const envText = env => Array.isArray(env) ? env.join('\n') : Object.entries(env || {}).map(([key, value]) => `${key}=${text(value)}`).join('\n')
function parseEnv(source) {
  const env = Object.create(null)
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    const split = raw.indexOf('=')
    const key = raw.slice(0, split).trim()
    if (split < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Environment line ${index + 1}: expected KEY=VALUE`)
    env[key] = raw.slice(split + 1)
  }
  return env
}
function portValue(value) {
  if (value === '' || value == null) return undefined
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Web port must be between 1 and 65535')
  return port
}
const volumeText = volumes => list(volumes).map(volume => typeof volume === 'string' ? volume : volume.target).filter(Boolean).join('\n')
const parseVolumes = source => source.split(/\r?\n/).map(target => target.trim()).filter(Boolean).map(target => {
  if (!target.startsWith('/')) throw new Error('Volume paths must be absolute container paths')
  return { target }
})
function normalizeDefinition(raw) {
  let input = raw || {}
  for (let depth = 0; depth < 5; depth++) {
    const nested = input.input || input.definition
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) break
    input = nested
  }
  return { input, revisions: list(raw?.revisions).length ? raw.revisions : list(input?.revisions) }
}
const deploymentAppId = job => job.appId || job.applicationId || job.input?.id || job.definition?.id || job.app?.id || job.id
const jobState = job => job.state || job.status || 'unknown'
const jobKey = job => job.jobId || job.deploymentId || job.id
function hasDefinition(app, deployments) {
  return Boolean(app?.deployment || app?.savedDefinition || app?.source === 'deployment' ||
    (app?.project?.startsWith('dsh-') && deployments.some(job => deploymentAppId(job) === app.id)))
}

export function createRuntimeUI({ React, h = React.createElement, api, resolveView, Viewer, AppIcon, ctx }) {
  const { useState, useEffect, useRef, useCallback } = React
  // api is supplied by the client so authentication and error handling remain shared.
  async function request(method, body) {
    const result = await api(method, body)
    if (result?.ok === false) throw new Error(result.error || `Application request failed${result.status ? ` (${result.status})` : ''}`)
    return result
  }
  const button = (label, onClick, props = {}) => h('button', { type: 'button', className: 'dsha-btn', onClick, ...props }, label)
  const notice = (message, bad = false) => message ? h('div', { className: bad ? 'dsha-inline-error' : 'dsha-note', role: bad ? 'alert' : 'status' }, message) : null
  function Field({ label, children, ...props }) {
    return h('label', { className: 'dsha-field' }, h('span', null, label), children || h('input', props))
  }
  const empty = message => h('div', { className: 'dsha-empty', role: 'status' }, message)
  const status = app => [app.state || 'unknown', app.health && app.health !== 'none' ? app.health : null].filter(Boolean).join(' · ')
  const serviceLabel = service => service.service || service.name || service.containerId?.slice(0, 12) || 'Service'
  const serviceOptions = services => services.map(service => h('option', { key: service.containerId, value: service.containerId }, `${serviceLabel(service)} · ${service.state || 'unknown'}`))
  function useTask() {
    const [pending, setPending] = useState({})
    const [error, setError] = useState('')
    const [message, setMessage] = useState('')
    const active = useRef(new Set())
    const mounted = useRef(true)
    useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
    const run = async (key, task, success = '') => {
      if (active.current.has(key)) return
      active.current.add(key)
      setPending(old => ({ ...old, [key]: true }))
      setError(''); setMessage('')
      try {
        const result = await task()
        if (mounted.current) setMessage(success)
        return result
      } catch (error) {
        if (mounted.current) setError(errorText(error))
        return undefined
      } finally {
        active.current.delete(key)
        if (mounted.current) setPending(old => ({ ...old, [key]: false }))
      }
    }
    return { pending, error, message, run }
  }

  function DeploymentList({ deployments, appId, onRollback, rollbackPending }) {
    const jobs = deployments.filter(job => !appId || deploymentAppId(job) === appId)
    if (!jobs.length) return empty('No deployments yet.')
    return h('div', { className: 'dsha-jobs', 'aria-label': 'Deployment progress' }, jobs.slice().sort((a, b) => text(b.createdAt).localeCompare(text(a.createdAt))).map((job, index) => {
      const events = list(job.events || job.progress || job.logs)
      const state = jobState(job)
      return h('article', { key: jobKey(job) || index, className: 'dsha-progress' },
        h('div', { className: 'dsha-card-top' },
          h('strong', null, job.name || job.appName || deploymentAppId(job) || 'Deployment'),
          h('span', { role: 'status' }, state),
          job.revision != null ? h('span', { className: 'dsha-note' }, `Revision ${text(job.revision)}`) : null),
        job.error ? notice(typeof job.error === 'object' ? job.error.message || text(job.error) : job.error, true) : null,
        events.length ? h('pre', { className: 'dsha-install-log', 'aria-label': 'Deployment events' }, events.map(event => {
          if (typeof event === 'string') return event
          return [event.time || event.at || event.timestamp, event.message || event.text || event.event || event.state].filter(Boolean).map(text).join(' ')
        }).join('\n')) : null,
        onRollback && job.revision != null && ['ready', 'completed', 'succeeded'].includes(state)
          ? button(`Roll back to revision ${text(job.revision)}`, () => onRollback(job.revision), { disabled: rollbackPending }) : null)
    }))
  }

  function Logs({ id, container }) {
    const [content, setContent] = useState('')
    const [query, setQuery] = useState('')
    const [paused, setPaused] = useState(false)
    const [connection, setConnection] = useState('Connecting…')
    const [error, setError] = useState('')
    const [generation, setGeneration] = useState(0)
    const buffer = useRef('')
    const pauseRef = useRef(paused)
    pauseRef.current = paused
    useEffect(() => {
      if (!container) return
      let alive = true
      buffer.current = ''; setContent(''); setError(''); setConnection('Connecting…')
      const stream = new EventSource(`/apps/api/runtime/logs?${new URLSearchParams({ id, container, tail: '500' })}`)
      stream.onopen = () => { if (alive) setConnection('Live') }
      stream.onmessage = event => {
        if (!alive) return
        try {
          const data = JSON.parse(event.data)
          if (data.error) { setError(text(data.error)); return }
          if (typeof data.text === 'string') {
            buffer.current = (buffer.current + data.text).slice(-200000)
            if (!pauseRef.current) setContent(buffer.current)
          }
        } catch { setError('Invalid log event received') }
      }
      const complete = event => {
        if (alive) {
          setConnection('Stream complete')
          try {
            const result = JSON.parse(event.data)
            if (result.code != null && result.code !== 0) setError(`Log process exited with status ${result.code}`)
          } catch { /* An empty completion event still ends the stream. */ }
        }
        stream.close()
      }
      stream.addEventListener('complete', complete)
      stream.addEventListener('error', event => {
        if (!alive) return
        if (event.data) {
          try { const data = JSON.parse(event.data); setError(data.message || data.error || 'Log stream failed') } catch { setError('Log stream failed') }
        } else setError('Log stream disconnected. Check connection and authentication, then reconnect.')
        setConnection('Disconnected'); stream.close()
      })
      return () => { alive = false; stream.close() }
    }, [id, container, generation])
    if (!container) return empty('Select an available service to view logs.')
    const filtered = query ? content.split('\n').filter(line => line.toLowerCase().includes(query.toLowerCase())).join('\n') : content
    return h('section', { 'aria-label': 'Service logs' },
      h('div', { className: 'dsha-runtime-toolbar' },
        h(Field, { label: 'Search logs', type: 'search', value: query, onChange: event => setQuery(event.target.value) }),
        button(paused ? 'Resume logs' : 'Pause logs', () => { setPaused(!paused); if (paused) setContent(buffer.current) }),
        button('Reconnect logs', () => setGeneration(value => value + 1)),
        h('a', { className: 'dsha-btn', href: `/apps/api/runtime/logs?${new URLSearchParams({ id, container, tail: '5000', download: '1' })}`, download: `${id}-logs.txt` }, 'Download logs'),
        h('span', { className: 'dsha-note', role: 'status' }, paused ? `${connection} · display paused` : connection)),
      notice(error, true),
      h('pre', { className: 'dsha-logview', tabIndex: 0, 'aria-label': 'Log output' }, filtered || (query ? 'No matching log lines.' : 'No log output yet.')),
      h('p', { className: 'dsha-note' }, 'Showing up to the latest 200,000 characters. Logs may contain application secrets.'))
  }

  function TerminalPanel({ id, container }) {
    const element = useRef(null)
    const [shell, setShell] = useState('/bin/sh')
    const [generation, setGeneration] = useState(0)
    const [connection, setConnection] = useState('Connecting…')
    const [error, setError] = useState('')
    useEffect(() => {
      if (!container) return
      let disposed = false, terminal, fit, socket, observer, input, resize, frame
      let ready = false
      setError(''); setConnection('Loading terminal…')
      const sendSize = () => {
        if (disposed || !terminal) return
        try { fit.fit() } catch { /* A hidden panel may not have dimensions yet. */ }
        if (ready && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
      }
      loadTerminalAssets().then(() => {
        if (disposed || !element.current) return
        terminal = new window.Terminal({ cursorBlink: true, convertEol: true, fontSize: 13, scrollback: 5000 })
        fit = new window.FitAddon.FitAddon()
        terminal.loadAddon(fit)
        terminal.open(element.current)
        const url = new URL('/apps/terminal', window.location.href)
        url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        url.search = new URLSearchParams({ id, container, shell }).toString()
        socket = new WebSocket(url.href)
        setConnection('Connecting…')
        input = terminal.onData(data => {
          if (ready && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }))
        })
        resize = terminal.onResize(({ cols, rows }) => {
          if (ready && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }))
        })
        socket.onmessage = event => {
          if (disposed) return
          try {
            const message = JSON.parse(event.data)
            if (message.type === 'output' && typeof message.data === 'string') terminal.write(message.data)
            if (message.type === 'ready') { ready = true; setConnection('Connected'); sendSize(); terminal.focus() }
            if (message.type === 'error') { setError(message.message || 'Terminal session failed'); setConnection('Error') }
          } catch { setError('Invalid terminal message received') }
        }
        socket.onerror = () => { if (!disposed) setError('Terminal connection failed. Check connection, authentication and service state.') }
        socket.onclose = event => {
          ready = false
          if (!disposed) setConnection(`Disconnected (${event.code}${event.reason ? `: ${event.reason}` : ''})`)
        }
        if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(sendSize); observer.observe(element.current) }
        window.addEventListener('resize', sendSize)
        frame = requestAnimationFrame(sendSize)
      }).catch(error => { if (!disposed) { setError(errorText(error)); setConnection('Unavailable') } })
      return () => {
        disposed = true; ready = false
        if (frame) cancelAnimationFrame(frame)
        observer?.disconnect(); window.removeEventListener('resize', sendSize)
        if (socket) { socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.close() }
        input?.dispose(); resize?.dispose(); terminal?.dispose()
      }
    }, [id, container, shell, generation])
    if (!container) return empty('Select an available service to open its terminal.')
    return h('section', { 'aria-label': 'Service terminal' },
      h('div', { className: 'dsha-runtime-toolbar' },
        h(Field, { label: 'Shell' }, h('select', { value: shell, onChange: event => setShell(event.target.value) }, h('option', { value: '/bin/sh' }, '/bin/sh'), h('option', { value: '/bin/bash' }, '/bin/bash'))),
        button('Reconnect terminal', () => setGeneration(value => value + 1)),
        h('span', { role: 'status', className: 'dsha-note' }, connection)),
      notice(error, true), h('div', { ref: element, className: 'dsha-terminal', 'aria-label': 'Interactive terminal' }),
      h('p', { className: 'dsha-note' }, 'Commands run inside the selected service. Reconnect explicitly after a disconnect.'))
  }

  function DeployForm({ onBack, deployments, refresh }) {
    const [mode, setMode] = useState('template')
    const [recipes, setRecipes] = useState([])
    const [recipesError, setRecipesError] = useState('')
    const [recipesLoading, setRecipesLoading] = useState(true)
    const [recipeId, setRecipeId] = useState('')
    const [form, setForm] = useState({ id: '', name: '', image: '', webPort: '', webPath: '/', env: '', volumes: '', compose: '', service: '', autostart: false, cpus: '', memoryMb: '', shmMb: '' })
    const [submitted, setSubmitted] = useState('')
    const task = useTask()
    const fileToken = useRef(0)
    useEffect(() => {
      let alive = true
      request('recipes').then(data => { if (alive) { setRecipes(list(data.recipes || data)); setRecipesError('') } })
        .catch(error => { if (alive) setRecipesError(errorText(error)) })
        .finally(() => { if (alive) setRecipesLoading(false) })
      return () => { alive = false; fileToken.current++ }
    }, [])
    const set = (key, value) => setForm(old => ({ ...old, [key]: value }))
    const field = (key, label, props = {}) => h(Field, { label, value: form[key], onChange: event => set(key, event.target.value), ...props })
    const chooseRecipe = id => {
      setRecipeId(id)
      const recipe = recipes.find(item => item.id === id)
      if (!recipe) return
      setForm(old => ({ ...old, id: recipe.id || '', name: recipe.name || '', image: recipe.image || '', webPort: recipe.webPort || '', webPath: recipe.webPath || '/', env: envText(recipe.env), volumes: volumeText(recipe.volumes), cpus: recipe.cpus || '', memoryMb: recipe.memoryMb || '', shmMb: recipe.shmMb || '', autostart: false }))
    }
    const deploy = event => {
      event.preventDefault()
      task.run('deploy', async () => {
        const recipe = recipes.find(item => item.id === recipeId)
        if (mode === 'template' && !recipe) throw new Error('Choose an application template')
        const payload = {
          ...(mode === 'template' ? recipe : {}),
          kind: mode === 'compose' ? 'compose' : 'image', id: form.id.trim(), name: form.name.trim() || form.id.trim(),
          ...(mode !== 'compose' ? { image: form.image.trim() } : { compose: form.compose, service: form.service.trim() || undefined }),
          webPort: portValue(form.webPort), webPath: form.webPath || '/', env: parseEnv(form.env),
          volumes: parseVolumes(form.volumes), autostart: form.autostart,
          ...(mode === 'template' ? { recipe: recipeId } : {}),
        }
        for (const key of ['cpus', 'memoryMb', 'shmMb']) {
          if (form[key] !== '') {
            const value = Number(form[key])
            if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number`)
            payload[key] = value
          }
        }
        // Template-specific localImage, viewer, command and networking hints survive.
        delete payload.notes; delete payload.description
        await request('runtime/deploy', payload)
        setSubmitted(payload.id)
        await refresh()
      }, 'Deployment submitted. Progress appears below.')
    }
    return h('div', { className: 'dsha-root' },
      h('header', { className: 'dsha-head' }, button('← Applications', onBack), h('h2', { className: 'dsha-title' }, 'Deploy application')),
      h('div', { className: 'dsha-body' },
        h('form', { className: 'dsha-deploy-form', onSubmit: deploy },
          h(Field, { label: 'Deployment source' }, h('select', { value: mode, onChange: event => { fileToken.current++; setMode(event.target.value); setSubmitted('') } },
            h('option', { value: 'template' }, 'Application template'), h('option', { value: 'image' }, 'Container image'), h('option', { value: 'compose' }, 'Docker Compose'))),
          mode === 'template' ? h(React.Fragment, null,
            h(Field, { label: 'Template' }, h('select', { required: true, value: recipeId, onChange: event => chooseRecipe(event.target.value), disabled: recipesLoading },
              h('option', { value: '' }, recipesLoading ? 'Loading templates…' : 'Choose a template'), recipes.map(recipe => h('option', { key: recipe.id, value: recipe.id }, recipe.name || recipe.id)))),
            notice(recipesError, true),
            h('p', { className: 'dsha-note' }, recipes.find(recipe => recipe.id === recipeId)?.notes || 'Select a template to prefill its image, entry point, environment and persistent paths.')) : null,
          h('div', { className: 'dsha-form-grid' },
            field('id', 'Application ID', { required: true, pattern: '[a-z0-9][a-z0-9-]*', maxLength: 32, placeholder: 'my-application' }),
            field('name', 'Display name', { placeholder: 'My application' }),
            mode !== 'compose' ? field('image', 'Container image (tag or digest)', { required: true, placeholder: 'nginx:1.28-alpine' }) : null,
            mode === 'compose' ? field('service', 'Frontend service (optional)', { placeholder: 'web' }) : null,
            field('webPort', 'Web container port (optional)', { type: 'number', min: 1, max: 65535, placeholder: '8080' }),
            field('webPath', 'Web entry path', { placeholder: '/' })),
          mode === 'compose' ? h(React.Fragment, null,
            h(Field, { label: 'Compose YAML' }, h('textarea', { className: 'dsha-deploy-source', required: true, value: form.compose, spellCheck: false, onChange: event => { fileToken.current++; set('compose', event.target.value) }, placeholder: 'services:\n  web:\n    image: nginx:1.28-alpine' })),
            h(Field, { label: 'Upload Compose file' }, h('input', { type: 'file', accept: '.yml,.yaml,text/yaml,application/yaml', onChange: event => {
              const file = event.target.files?.[0]
              if (!file) return
              const token = ++fileToken.current
              task.run('upload', async () => {
                const source = await file.text()
                if (fileToken.current === token) set('compose', source)
              })
              event.target.value = ''
            } }))) : null,
          h(Field, { label: mode === 'compose' ? 'Environment / Compose interpolation (KEY=VALUE, one per line)' : 'Environment (KEY=VALUE, one per line)' }, h('textarea', { value: form.env, onChange: event => set('env', event.target.value), spellCheck: false, autoComplete: 'off' })),
          mode !== 'compose' ? h(Field, { label: 'Persistent data paths (container paths, one per line)' }, h('textarea', { value: form.volumes, onChange: event => set('volumes', event.target.value), placeholder: '/var/lib/application' })) : null,
          h('label', { className: 'dsha-note' }, h('input', { type: 'checkbox', checked: form.autostart, onChange: event => set('autostart', event.target.checked) }), ' Start automatically with the engine (off by default)'),
          h('details', null, h('summary', null, 'Advanced resource limits'), h('div', { className: 'dsha-form-grid', style: { marginTop: 12 } },
            field('cpus', 'CPU limit', { type: 'number', min: 0.1, step: 'any' }), field('memoryMb', 'Memory limit (MiB)', { type: 'number', min: 1 }), field('shmMb', 'Shared memory (MiB)', { type: 'number', min: 1 }))),
          notice(task.error, true), notice(task.message),
          h('div', { className: 'dsha-actions' }, h('button', { type: 'submit', className: 'dsha-btn dsha-btn-primary', disabled: Boolean(task.pending.deploy) }, task.pending.deploy ? 'Deploying…' : 'Deploy'), button('Cancel', onBack)),
          h('p', { className: 'dsha-note' }, 'Deploy creates and starts the application directly. Only deploy images and Compose definitions you trust. Environment values are stored privately, not in this workspace.'),
          submitted ? h(DeploymentList, { deployments, appId: submitted }) : null)))
  }

  function EndpointForm({ app, onSaved }) {
    const services = list(app.services)
    const [container, setContainer] = useState(app.containerId || services[0]?.containerId || '')
    const [port, setPort] = useState(app.web?.containerPort || app.webPort || '')
    const [path, setPath] = useState(app.webPath || '/')
    const task = useTask()
    const selected = services.find(service => service.containerId === container)
    useEffect(() => {
      if (!services.some(service => service.containerId === container)) setContainer(app.containerId || services[0]?.containerId || '')
    }, [services.map(service => service.containerId).join('|'), container, app.containerId])
    const save = event => {
      event.preventDefault()
      task.run('endpoint', async () => {
        const webPort = portValue(port)
        if (!webPort) throw new Error('Choose a web container port')
        await request('runtime/endpoint', { id: app.id, container, webPort, webPath: path || '/' })
        await onSaved()
      }, 'Web entry point saved.')
    }
    return h('form', { onSubmit: save, className: 'dsha-card', style: { marginTop: 20 } },
      h('h3', { className: 'dsha-title' }, 'Web entry point'),
      h('p', { className: 'dsha-note' }, app.web ? 'Choose which service and container port Open should use. This does not recreate containers.' : 'Select a frontend service and container port to enable Open. This only saves the web entry point; it does not change ownership or recreate containers.'),
      app.endpointError ? notice(app.endpointError, true) : null,
      h('div', { className: 'dsha-form-grid' },
        h(Field, { label: 'Frontend service' }, h('select', { value: container, required: true, onChange: event => {
          setContainer(event.target.value)
          const service = services.find(item => item.containerId === event.target.value)
          setPort(list(service?.ports).length === 1 ? text(service.ports[0]) : '')
        } }, h('option', { value: '' }, 'Choose service'), serviceOptions(services))),
        h(Field, { label: `Container port${selected?.ports?.length ? ` · exposed: ${selected.ports.map(text).join(', ')}` : ''}`, type: 'number', min: 1, max: 65535, required: true, value: port, onChange: event => setPort(event.target.value) }),
        h(Field, { label: 'Entry path', value: path, onChange: event => setPath(event.target.value), required: true })),
      h('div', { className: 'dsha-actions' }, h('button', { type: 'submit', className: 'dsha-btn', disabled: Boolean(task.pending.endpoint) || !services.length }, task.pending.endpoint ? 'Saving…' : 'Save web entry point')),
      notice(task.error, true), notice(task.message))
  }

  function Configuration({ app, saved, onUpdated }) {
    const [loaded, setLoaded] = useState(false)
    const [definition, setDefinition] = useState(null)
    const [form, setForm] = useState(null)
    const task = useTask()
    const loadToken = useRef(0)
    useEffect(() => () => { loadToken.current++ }, [])
    const load = () => task.run('load', async () => {
      const token = ++loadToken.current
      const data = await request(`runtime/definition?${new URLSearchParams({ id: app.id })}`)
      if (token !== loadToken.current) return
      const normalized = normalizeDefinition(data.definition)
      const input = normalized.input
      if (!input || !Object.keys(input).length) throw new Error('No saved deployment definition is available')
      setDefinition(normalized)
      setForm({ name: input.name || app.name || '', image: input.image || '', compose: input.compose || '', service: input.service || '', webPort: input.webPort || '', webPath: input.webPath || '/', env: envText(input.env), volumes: volumeText(input.volumes) })
      setLoaded(true)
    })
    const hide = () => { loadToken.current++; setLoaded(false); setDefinition(null); setForm(null) }
    const save = event => {
      event.preventDefault()
      task.run('update', async () => {
        const source = definition.input
        const fields = { ...source, name: form.name, env: parseEnv(form.env), webPort: portValue(form.webPort), webPath: form.webPath || '/' }
        // Only the engine definition is sent, never the enclosing revision metadata.
        delete fields.revisions; delete fields.definition; delete fields.input
        if (source.kind === 'compose' || source.compose) { fields.compose = form.compose; fields.service = form.service.trim() || undefined }
        else { fields.image = form.image.trim(); fields.volumes = parseVolumes(form.volumes) }
        await request('runtime/action', { ...fields, id: app.id, action: 'update' })
        hide()
        await onUpdated()
      }, 'Saved and redeploying. See Deployments for progress.')
    }
    const set = (key, value) => setForm(old => ({ ...old, [key]: value }))
    const inspected = h('div', { className: 'dsha-runtime-list' }, list(app.services).map(service => h('article', { key: service.containerId, className: 'dsha-card' },
      h('h3', { className: 'dsha-title' }, serviceLabel(service)),
      h('pre', { className: 'dsha-code' }, JSON.stringify({ image: service.config?.image || service.image, environmentKeys: service.config?.environmentKeys || [], config: service.config, mounts: service.mounts, networks: service.networks, permissions: service.permissions }, null, 2)))))
    if (!saved) return h('section', { 'aria-label': 'Inspected configuration' },
      h('p', { className: 'dsha-note' }, 'No saved deployment definition. Inspected configuration and environment key names are shown below; existing containers remain fully controllable.'), inspected)
    const isCompose = definition?.input?.kind === 'compose' || Boolean(definition?.input?.compose)
    return h('section', { 'aria-label': 'Saved configuration' },
      h('p', { className: 'dsha-note' }, 'Saved environment values are private. Load configuration explicitly to reveal and edit them. Leaving this tab clears the editor.'),
      !loaded ? button(task.pending.load ? 'Loading configuration…' : 'Load configuration', load, { disabled: Boolean(task.pending.load) }) : null,
      loaded && form ? h('form', { className: 'dsha-deploy-form', onSubmit: save },
        h('div', { className: 'dsha-form-grid' },
          h(Field, { label: 'Display name', value: form.name, onChange: event => set('name', event.target.value) }),
          !isCompose ? h(Field, { label: 'Container image', required: true, value: form.image, onChange: event => set('image', event.target.value) }) : null,
          isCompose ? h(Field, { label: 'Frontend service (optional)', value: form.service, onChange: event => set('service', event.target.value) }) : null,
          h(Field, { label: 'Web container port (optional)', type: 'number', min: 1, max: 65535, value: form.webPort, onChange: event => set('webPort', event.target.value) }),
          h(Field, { label: 'Web entry path', value: form.webPath, onChange: event => set('webPath', event.target.value) })),
        isCompose ? h(Field, { label: 'Compose source' }, h('textarea', { className: 'dsha-deploy-source', required: true, value: form.compose, spellCheck: false, onChange: event => set('compose', event.target.value) })) : null,
        h(Field, { label: 'Environment values (KEY=VALUE, private)' }, h('textarea', { value: form.env, autoComplete: 'off', spellCheck: false, onChange: event => set('env', event.target.value) })),
        !isCompose ? h(Field, { label: 'Persistent container paths (one per line)' }, h('textarea', { value: form.volumes, onChange: event => set('volumes', event.target.value) })) : null,
        h('div', { className: 'dsha-actions' }, h('button', { type: 'submit', className: 'dsha-btn dsha-btn-primary', disabled: Boolean(task.pending.update) }, task.pending.update ? 'Saving and redeploying…' : 'Save and redeploy'), button('Hide configuration', hide)),
        definition.revisions.length ? h('p', { className: 'dsha-note' }, `${definition.revisions.length} saved revision(s). Rollback is available in Deployments.`) : null) : null,
      notice(task.error, true), notice(task.message))
  }

  function AppDetails({ initialApp, deployments, onBack, onOpen, refresh, opening }) {
    const id = initialApp.id
    const [detail, setDetail] = useState(null)
    const [stats, setStats] = useState([])
    const [error, setError] = useState('')
    const [tab, setTab] = useState('Overview')
    const [container, setContainer] = useState(initialApp.containerId || initialApp.services?.[0]?.containerId || '')
    const [actionTarget, setActionTarget] = useState('all')
    const [remove, setRemove] = useState(false)
    const [deleteData, setDeleteData] = useState(false)
    const [rollback, setRollback] = useState(null)
    const [rollbackRevision, setRollbackRevision] = useState('')
    const task = useTask()
    const alive = useRef(true)
    const inFlight = useRef(null)
    const fetchDetails = useCallback(() => {
      if (inFlight.current) return inFlight.current
      const work = request(`runtime/details?${new URLSearchParams({ id })}`).then(data => {
        if (alive.current) { setDetail(data.app); setStats(list(data.stats)); setError('') }
      }).catch(error => { if (alive.current) setError(errorText(error)) })
        .finally(() => { if (inFlight.current === work) inFlight.current = null })
      inFlight.current = work
      return work
    }, [id])
    useEffect(() => {
      alive.current = true; fetchDetails()
      const interval = setInterval(fetchDetails, 5000)
      return () => { alive.current = false; clearInterval(interval) }
    }, [fetchDetails])
    const app = detail ? { ...initialApp, ...detail } : initialApp
    const services = list(app.services)
    const serviceIds = services.map(service => service.containerId).join('|')
    useEffect(() => {
      if (!services.some(service => service.containerId === container)) setContainer(app.containerId || services[0]?.containerId || '')
      if (actionTarget !== 'all' && !services.some(service => service.containerId === actionTarget)) setActionTarget('all')
    }, [serviceIds, container, actionTarget, app.containerId])
    const saved = hasDefinition(app, deployments)
    const changed = async () => { await Promise.all([refresh(), fetchDetails()]) }
    const action = (name, extra = {}) => task.run(name, async () => {
      const options = { ...extra }
      if (name === 'rollback' && /^\d+$/.test(text(options.revision))) options.revision = Number(options.revision)
      await request('runtime/action', { id, action: name, ...(actionTarget !== 'all' && !saved ? { container: actionTarget } : {}), ...options })
      if (name === 'remove') { setRemove(false); setDeleteData(false); await refresh(); if (alive.current) onBack(); return }
      if (name === 'rollback') setRollback(null)
      await changed()
    }, ['redeploy', 'update', 'rollback'].includes(name) ? `${name} queued. See Deployments for progress.` : `${name} completed.`)
    const serviceStats = service => stats.find(stat => {
      const identity = stat.ID || stat.Container || stat.ContainerID || stat.id
      return stat.Name === service.name || (identity && (service.containerId === identity || service.containerId?.startsWith(identity)))
    }) || (services.length === 1 ? stats[0] : null)
    const metric = (label, value) => h('div', { className: 'dsha-runtime-stat' }, h('strong', null, value || '—'), h('span', { className: 'dsha-note' }, label))
    const overview = () => h(React.Fragment, null,
      h('div', { className: 'dsha-runtime-stats' }, metric('Status', status(app)), metric('Services', text(services.length)), metric('Source', app.source || 'container'), metric('Project', app.project || 'Standalone')),
      h('div', { style: { overflowX: 'auto' } }, h('table', { className: 'dsha-table' },
        h('caption', { style: { textAlign: 'left', marginBottom: 10 } }, 'Services and live resource usage'),
        h('thead', null, h('tr', null, ['Service', 'Image', 'State / health', 'Ports', 'CPU', 'Memory'].map(label => h('th', { key: label, scope: 'col' }, label)))),
        h('tbody', null, services.length ? services.map(service => {
          const stat = serviceStats(service)
          return h('tr', { key: service.containerId },
            h('th', { scope: 'row' }, serviceLabel(service), h('div', { className: 'dsha-note' }, service.containerId?.slice(0, 12))),
            h('td', { style: { maxWidth: 320, overflowWrap: 'anywhere' } }, service.image), h('td', null, status(service)),
            h('td', null, list(service.ports).map(text).join(', ') || '—'), h('td', null, stat?.CPUPerc || '—'), h('td', null, stat?.MemUsage || '—', stat?.MemPerc ? ` (${stat.MemPerc})` : ''))
        }) : h('tr', null, h('td', { colSpan: 6 }, 'No current containers.'))))),
      !detail && !error ? notice('Loading inspection and resource usage…') : null,
      h(EndpointForm, { key: id, app, onSaved: changed }))
    return h('div', { className: 'dsha-root' },
      h('header', { className: 'dsha-head' }, button('← Applications', onBack),
        AppIcon ? h(AppIcon, { app, size: 26 }) : null,
        h('h2', { className: 'dsha-title' }, app.name || id), h('span', { className: 'dsha-sub' }, status(app)), h('span', { className: 'dsha-spacer' }),
        button(opening ? 'Opening…' : 'Open', () => onOpen(app), { disabled: opening || !(app.web || app.launch || app.viewer) }),
        button('Refresh', changed)),
      h('div', { className: 'dsha-tabs', role: 'tablist', 'aria-label': 'Application details' }, ['Overview', 'Logs', 'Terminal', 'Configuration', 'Deployments'].map((name, index, tabs) => h('button', {
        type: 'button', role: 'tab', className: 'dsha-tab', key: name, id: `dsha-tab-${id}-${name}`, 'aria-controls': `dsha-panel-${id}`, 'aria-selected': tab === name, tabIndex: tab === name ? 0 : -1,
        onClick: () => setTab(name), onKeyDown: event => {
          let next
          if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length]
          if (event.key === 'ArrowLeft') next = tabs[(index + tabs.length - 1) % tabs.length]
          if (event.key === 'Home') next = tabs[0]
          if (event.key === 'End') next = tabs[tabs.length - 1]
          if (next) { event.preventDefault(); setTab(next); document.getElementById(`dsha-tab-${id}-${next}`)?.focus() }
        },
      }, name))),
      h('div', { className: 'dsha-body' },
        notice(error ? `${error}${detail ? ' · Showing last available details.' : ''}` : '', true),
        h('div', { className: 'dsha-runtime-toolbar' },
          h(Field, { label: 'Action scope' }, h('select', { value: actionTarget, onChange: event => setActionTarget(event.target.value), disabled: saved, title: saved ? 'Saved deployments are controlled as a complete application' : undefined },
            h('option', { value: 'all' }, 'Entire application'), serviceOptions(services))),
          ['start', 'stop', 'restart'].map(name => button(task.pending[name] ? `${name}…` : name.charAt(0).toUpperCase() + name.slice(1), () => action(name), { key: name, disabled: Boolean(task.pending[name]) || (!services.length && !(saved && name === 'start')) })),
          saved ? button(task.pending.redeploy ? 'Redeploying…' : 'Redeploy', () => action('redeploy'), { disabled: Boolean(task.pending.redeploy) }) : null,
          button('Remove', () => { setDeleteData(false); setRemove(true) }, { className: 'dsha-btn dsha-btn-danger', disabled: Boolean(task.pending.remove) })),
        remove ? h('section', { className: 'dsha-card', role: 'alertdialog', 'aria-modal': false, 'aria-label': 'Confirm removal', style: { marginBottom: 16 } },
          h('strong', null, `Remove ${actionTarget === 'all' || saved ? app.name || id : serviceLabel(services.find(service => service.containerId === actionTarget) || {})}?`),
          h('p', { className: 'dsha-note' }, 'Containers will be removed. Persistent volumes are kept by default.'),
          h('label', null, h('input', { type: 'checkbox', checked: deleteData, onChange: event => setDeleteData(event.target.checked) }), ' Also delete application data / volumes (irreversible)'),
          h('div', { className: 'dsha-actions' }, button(task.pending.remove ? 'Removing…' : deleteData ? 'Remove and delete data' : 'Remove, keep volumes', () => action('remove', { deleteData }), { className: 'dsha-btn dsha-btn-danger', disabled: Boolean(task.pending.remove) }), button('Cancel removal', () => { setRemove(false); setDeleteData(false) }))) : null,
        notice(task.error, true), notice(task.message),
        h('section', { id: `dsha-panel-${id}`, role: 'tabpanel', 'aria-labelledby': `dsha-tab-${id}-${tab}` },
          tab === 'Overview' ? overview() : null,
          ['Logs', 'Terminal'].includes(tab) ? h('div', { className: 'dsha-runtime-toolbar' }, h(Field, { label: 'Service' }, h('select', { value: container, onChange: event => setContainer(event.target.value) }, serviceOptions(services)))) : null,
          tab === 'Logs' ? h(Logs, { id, container }) : null,
          tab === 'Terminal' ? h(TerminalPanel, { id, container }) : null,
          tab === 'Configuration' ? h(Configuration, { key: `${id}-config`, app, saved, onUpdated: changed }) : null,
          tab === 'Deployments' ? h(React.Fragment, null,
            !saved ? notice('No saved deployment definition. Existing containers can still be started, stopped, restarted and removed.') : null,
            h(DeploymentList, { deployments, appId: id, onRollback: saved ? revision => setRollback(revision) : undefined, rollbackPending: Boolean(task.pending.rollback) }),
            saved ? h('div', { className: 'dsha-actions' }, h(Field, { label: 'Saved revision' }, h('input', { value: rollbackRevision, placeholder: 'Revision ID', onChange: event => setRollbackRevision(event.target.value) })), button('Roll back…', () => setRollback(rollbackRevision.trim()), { disabled: !rollbackRevision.trim() || Boolean(task.pending.rollback) })) : null,
            rollback != null ? h('div', { className: 'dsha-card', role: 'alertdialog', 'aria-label': 'Confirm rollback', style: { marginTop: 12 } },
              h('p', null, `Redeploy saved revision ${text(rollback)}? Application containers may be replaced; persistent data is retained.`),
              h('div', { className: 'dsha-actions' }, button(task.pending.rollback ? 'Rolling back…' : 'Confirm rollback', () => action('rollback', { revision: rollback }), { disabled: Boolean(task.pending.rollback) }), button('Cancel', () => setRollback(null)))) : null) : null)))
  }

  function RuntimeApplications() {
    const [apps, setApps] = useState([])
    const [deployments, setDeployments] = useState([])
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState('')
    const [query, setQuery] = useState('')
    const [filter, setFilter] = useState('applications')
    const [route, setRoute] = useState({ type: 'list' })
    const [opening, setOpening] = useState('')
    const alive = useRef(true)
    const inFlight = useRef(null)
    const routeRef = useRef(route)
    routeRef.current = route
    const openToken = useRef(0)
    const refresh = useCallback(() => {
      if (inFlight.current) return inFlight.current
      if (alive.current) setRefreshing(true)
      const work = request('runtime/inventory').then(data => {
        if (alive.current) { setApps(list(data.apps)); setDeployments(list(data.deployments)); setError('') }
      }).catch(error => { if (alive.current) setError(errorText(error)) })
        .finally(() => {
          if (alive.current) { setLoading(false); setRefreshing(false) }
          if (inFlight.current === work) inFlight.current = null
        })
      inFlight.current = work
      return work
    }, [])
    useEffect(() => {
      alive.current = true; refresh()
      const interval = setInterval(refresh, 5000)
      return () => { alive.current = false; openToken.current++; clearInterval(interval) }
    }, [refresh])
    const navigate = next => { openToken.current++; setOpening(''); setRoute(next) }
    const open = async app => {
      const token = ++openToken.current
      setOpening(app.id)
      try {
        if (app.state !== 'running') {
          await request('runtime/action', { id: app.id, action: 'start' })
          const latest = await request('runtime/inventory')
          app = list(latest.apps).find(candidate => candidate.id === app.id) || app
          if (alive.current) { setApps(list(latest.apps)); setDeployments(list(latest.deployments)) }
        }
        const view = await resolveView(app)
        if (alive.current && openToken.current === token) setRoute({ type: 'viewer', app, view, returnId: routeRef.current.type === 'detail' ? app.id : null })
      } catch (error) { if (alive.current && openToken.current === token) setError(errorText(error)) }
      finally { if (alive.current && openToken.current === token) setOpening('') }
    }
    const back = () => navigate({ type: 'list' })
    if (route.type === 'viewer') return h('div', { className: 'dsha-root' }, h(Viewer, { ...route.view, app: route.app, onBack: () => navigate(route.returnId ? { type: 'detail', id: route.returnId, app: route.app } : { type: 'list' }) }))
    if (route.type === 'deploy') return h(DeployForm, { onBack: back, deployments, refresh })
    if (route.type === 'detail') {
      const app = apps.find(app => app.id === route.id) || route.app
      if (app) return h(AppDetails, { key: app.id, initialApp: app, deployments, onBack: back, onOpen: open, refresh, opening: opening === app.id })
    }
    const counts = { running: apps.filter(app => app.state === 'running').length, attention: apps.filter(app => app.state !== 'running' || app.health === 'unhealthy').length, infrastructure: apps.filter(app => app.infrastructure).length }
    const visible = apps.filter(app => (filter === 'all' || (filter === 'infrastructure' ? app.infrastructure : !app.infrastructure)) &&
      [app.name, app.id, app.project, app.source, app.state, ...list(app.services).map(service => `${service.name} ${service.service} ${service.image}`)].filter(Boolean).join(' ').toLowerCase().includes(query.toLowerCase()))
    const activeJobs = deployments.filter(job => ['queued', 'running', 'validating', 'pulling', 'starting', 'checking'].includes(jobState(job)))
    return h('div', { className: 'dsha-root' },
      h('header', { className: 'dsha-head' }, h('h2', { className: 'dsha-title' }, 'Applications'), h('span', { className: 'dsha-sub' }, 'Runtime inventory'), h('span', { className: 'dsha-spacer' }),
        button('Deploy application', () => navigate({ type: 'deploy' }), { className: 'dsha-btn dsha-btn-primary' }), button(refreshing ? 'Refreshing…' : 'Refresh', refresh, { disabled: refreshing })),
      h('div', { className: 'dsha-body' },
        h('div', { className: 'dsha-runtime-stats', 'aria-label': 'Runtime summary' },
          [['Applications', apps.length], ['Running', counts.running], ['Stopped / needs attention', counts.attention], ['Infrastructure', counts.infrastructure]].map(([label, count]) => h('div', { key: label, className: 'dsha-runtime-stat' }, h('strong', null, count), h('span', { className: 'dsha-note' }, label)))),
        notice(error ? `${error}${apps.length ? ' · Showing last available inventory; retrying every 5 seconds.' : ' · Retrying every 5 seconds.'}` : '', true),
        h('div', { className: 'dsha-runtime-toolbar' },
          h(Field, { label: 'Search applications', type: 'search', value: query, placeholder: 'Name, image, project or status', onChange: event => setQuery(event.target.value), className: 'dsha-filter' }),
          h(Field, { label: 'Show' }, h('select', { value: filter, onChange: event => setFilter(event.target.value) }, h('option', { value: 'applications' }, 'Applications'), h('option', { value: 'all' }, 'Applications and infrastructure'), h('option', { value: 'infrastructure' }, 'Infrastructure only'))),
          h('span', { className: 'dsha-note' }, `${visible.length} shown · updates every 5 seconds`)),
        activeJobs.length ? h(DeploymentList, { deployments: activeJobs }) : null,
        loading ? empty('Loading runtime inventory…') : !visible.length ? empty(error && !apps.length ? 'Runtime inventory is unavailable. Use Refresh to retry.' : apps.length ? 'No applications match these filters.' : 'No applications yet. Deploy an application to get started.') : h('div', { className: 'dsha-runtime-list' }, visible.map(app => h('article', { className: 'dsha-runtime-row', key: app.id },
          AppIcon ? h(AppIcon, { app, size: 30 }) : null,
          h('button', { type: 'button', className: 'dsha-runtime-row-main', onClick: () => navigate({ type: 'detail', id: app.id, app }), 'aria-label': `Details for ${app.name || app.id}` },
            h('strong', null, app.name || app.id), h('span', { className: 'dsha-note' }, `${status(app)} · ${list(app.services).length} service(s) · ${app.source || 'container'}${app.infrastructure ? ' · infrastructure' : ''}`),
            app.project ? h('div', { className: 'dsha-note' }, `Project: ${app.project}`) : null),
          h('div', { className: 'dsha-actions' }, button(opening === app.id ? 'Opening…' : 'Open', () => open(app), { disabled: opening === app.id || !(app.web || app.launch || app.viewer), 'aria-label': `Open ${app.name || app.id}` }), button('Details', () => navigate({ type: 'detail', id: app.id, app })))))), 
        deployments.length ? h('details', { style: { marginTop: 24 } }, h('summary', null, 'Deployment history'), h('div', { style: { marginTop: 12 } }, h(DeploymentList, { deployments }))) : null))
  }
  return RuntimeApplications
}
