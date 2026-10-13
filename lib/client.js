/**
 * dsh-applications — client half.
 *
 * Contributes exactly two things, which is all the DSH layout asks for:
 *
 *   1. an entry in the `sidebar.panellist` list slot — the icon. The sidebar
 *      owns the button and the click; it reads `id`/`label`/`order` from this
 *      registration and calls `ctx.layout.selectPanel(id)` itself.
 *   2. an entry in the root-scoped keyed `main` slot under the SAME key, which
 *      is the panel body that gets swapped in.
 *
 * Both go through `slots.inject` rather than a bare `register`, because the
 * parent packages declare those slots and may not have done so yet at the
 * moment this plugin activates. `inject` runs the callback for each declaration
 * lifetime, so activation order never matters.
 *
 * This file is hand-written in the loader's bundle format on purpose: the host
 * supplies `require` for the platform module table (React among them), so a
 * plugin does not need a bundler to exist. Plain `createElement`, no JSX.
 */
window.__ModuleLoader__.load({
  id: 'dsh-applications',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const API = '/apps/api'
    const PANEL_KEY = 'applications'
    const REGISTRANT = 'dsh-applications'
    const POLL_MS = 5000

    // --------------------------------------------------------------- styles
    // Neutral, translucent values so the panel follows the host's light/dark
    // theme instead of hard-coding a palette that will fight it.
    const STYLE_ID = 'dsh-applications-style'
    const CSS = [
      '.dsha-root{display:flex;flex-direction:column;height:100%;min-height:0;font:inherit;color:inherit}',
      '.dsha-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid rgba(127,127,127,.22);flex:0 0 auto}',
      '.dsha-title{font-weight:600;font-size:14px}',
      '.dsha-sub{font-size:12px;opacity:.6}',
      '.dsha-spacer{flex:1 1 auto}',
      '.dsha-btn{font:inherit;font-size:12px;padding:5px 11px;border-radius:6px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;cursor:pointer}',
      '.dsha-btn:hover:not(:disabled){background:rgba(127,127,127,.14)}',
      '.dsha-btn:disabled{opacity:.45;cursor:default}',
      '.dsha-btn-primary{border-color:rgba(90,150,240,.6);background:rgba(90,150,240,.14)}',
      '.dsha-btn-danger:hover:not(:disabled){background:rgba(230,90,90,.16);border-color:rgba(230,90,90,.5)}',
      '.dsha-body{flex:1 1 auto;min-height:0;overflow:auto;padding:16px}',
      '.dsha-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}',
      '.dsha-card{display:flex;flex-direction:column;gap:8px;padding:13px 14px;border-radius:10px;border:1px solid rgba(127,127,127,.22);background:rgba(127,127,127,.06)}',
      '.dsha-card-top{display:flex;align-items:center;gap:8px}',
      '.dsha-name{font-weight:600;font-size:13px}',
      '.dsha-desc{font-size:12px;opacity:.72;line-height:1.45}',
      '.dsha-img{font-size:11px;opacity:.5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}',
      '.dsha-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}',
      '.dsha-badge{font-size:10px;letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:99px;border:1px solid transparent;white-space:nowrap}',
      '.dsha-run{background:rgba(70,180,110,.18);border-color:rgba(70,180,110,.5);color:inherit}',
      '.dsha-stop{background:rgba(220,160,60,.18);border-color:rgba(220,160,60,.5);color:inherit}',
      '.dsha-new{background:rgba(127,127,127,.16);border-color:rgba(127,127,127,.4);color:inherit}',
      '.dsha-msg{margin:0 16px 12px;padding:9px 12px;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-word}',
      '.dsha-err{background:rgba(230,90,90,.14);border:1px solid rgba(230,90,90,.45)}',
      '.dsha-ok{background:rgba(70,180,110,.14);border:1px solid rgba(70,180,110,.45)}',
      '.dsha-viewer{flex:1 1 auto;display:flex;flex-direction:column;min-height:0}',
      '.dsha-viewer-bar{display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid rgba(127,127,127,.22);flex:0 0 auto}',
      '.dsha-pw{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;padding:3px 8px;border-radius:6px;background:rgba(127,127,127,.14);user-select:all}',
      '.dsha-frame{flex:1 1 auto;width:100%;border:0;background:transparent;min-height:0}',
      // A VNC viewer is a canvas on a black framebuffer, so black is correct
      // there. An HTML dashboard must NOT get a black backdrop: the framed
      // document's own background is not always composited into a screenshot
      // (observed under Xvfb), and a black underlay makes a working page look
      // broken. Transparent lets the host theme show through instead.
      '.dsha-frame-vnc{background:#000}',
      '.dsha-field{display:flex;flex-direction:column;gap:5px;font-size:12px}',
      '.dsha-field input,.dsha-field textarea,.dsha-field select{font:inherit;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.35);border-radius:6px;padding:8px;min-width:0}',
      '.dsha-field textarea{min-height:90px}',
      '.dsha-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}',
      '.dsha-add-section{margin-top:16px}',
      '.dsha-jobs{display:flex;flex-direction:column;gap:10px;margin-bottom:16px}',
      '.dsha-install-log{white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:240px;overflow:auto}',
      '.dsha-empty{opacity:.6;font-size:13px;padding:24px;text-align:center}',
    ].join('')

    function installStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }

    // ------------------------------------------------------------------ data
    function useApps() {
      const [state, setState] = React.useState({ loading: true, apps: [], error: null })

      const load = React.useCallback(async () => {
        try {
          const res = await fetch(`${API}/list`, { headers: { accept: 'application/json' } })
          const json = await res.json().catch(() => null)
          if (!res.ok || json === null || json.ok === false) {
            setState({
              loading: false,
              apps: [],
              error: (json && json.error) || `GET ${API}/list failed (HTTP ${res.status})`,
            })
            return
          }
          setState({ loading: false, apps: json.apps || [], error: null })
        } catch (err) {
          setState({ loading: false, apps: [], error: String((err && err.message) || err) })
        }
      }, [])

      React.useEffect(() => {
        load()
        const timer = setInterval(load, POLL_MS)
        return () => clearInterval(timer)
      }, [load])

      return [state, load]
    }

    // ---------------------------------------------------------------- pieces
    function StateBadge(props) {
      const cls =
        props.state === 'running' ? 'dsha-badge dsha-run'
        : props.state === 'stopped' ? 'dsha-badge dsha-stop'
        : 'dsha-badge dsha-new'
      return h('span', { className: cls }, props.state)
    }

    function AppCard(props) {
      const app = props.app
      const running = app.state === 'running'
      const exists = running || app.state === 'stopped'
      const busy = props.busy === app.id

      const btn = (label, action, extra) =>
        h(
          'button',
          {
            type: 'button',
            className: `dsha-btn${extra ? ` ${extra}` : ''}`,
            disabled: busy || props.anyBusy,
            onClick: () => props.onAction(action, app.id),
          },
          busy && action === props.lastAction ? `${label}…` : label,
        )

      return h(
        'div',
        { className: 'dsha-card' },
        h(
          'div',
          { className: 'dsha-card-top' },
          h('span', { className: 'dsha-name' }, app.name),
          h('span', { className: 'dsha-spacer' }),
          h(StateBadge, { state: app.state }),
        ),
        app.description ? h('div', { className: 'dsha-desc' }, app.description) : null,
        h('div', { className: 'dsha-img' }, app.image),
        h(
          'div',
          { className: 'dsha-actions' },
          running ? btn('Stop', 'down') : app.existing && !exists ? h('span', {className:'dsha-desc'}, 'Original container missing — listing retained.') : btn('Launch', 'up', 'dsha-btn-primary'),
          running && (app.viewer || app.web) ? btn('Open', 'open') : null,
          app.managed ? btn('Logs', 'logs') : null,
          app.existing ? btn('Forget listing', 'forget') : app.managed ? btn('Uninstall', 'uninstall', 'dsha-btn-danger') : exists ? btn('Remove container', 'rm', 'dsha-btn-danger') : null,
        ),
      )
    }

    /**
     * Every app load is embedded under a fresh salt, so an app can never come up
     * from a bundle an earlier load cached: the salt versions every asset URL.
     */
    const reloadSalt = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5)

    /** Only same-origin app mounts are launched in the DSH panel. */
    async function resolveView(app) {
      const web = app.web
      const path = web?.path || (app.viewer ? `/apps/web/${app.id}/` : null)
      const blocked = (reason) => ({ app, src: null, mode: 'blocked', reason })
      if (!path) return { app, src: null, mode: 'none' }
      if (web?.mode === 'direct') return blocked('This catalog entry uses legacy direct mode. Set webMode to proxy to launch it inside DSH.')
      const mount = new URL(path, window.location.href)
      if (mount.origin !== window.location.origin || !mount.pathname.startsWith(`/apps/web/${app.id}/`)) {
        return blocked('The application mount is not a valid same-origin DSH route.')
      }
      const sockets = app.webSockets || (app.viewer ? ['/websockify'] : [])
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 10000)
        let probe
        try { probe = await fetch(mount.href, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', signal: controller.signal }) }
        finally { clearTimeout(timer) }
        if (!probe.ok || probe.headers.get('x-dsh-app-proxy') !== app.id) return blocked('The application mount is unavailable. Check that the app is running and the Applications server plugin is active.')
        const features = (probe.headers.get('x-dsh-app-proxy-features') || '').split(/\s+/)
        if (sockets.length && !features.includes('ws')) return blocked('This application needs WebSockets, but its declared socket routes are not available in the installed plugin.')
        if (app.webRewrite?.length && !features.includes('js')) return blocked('This application needs JavaScript URL rewriting. Update the Applications server plugin before opening it.')
        if (app.viewer) {
          mount.pathname += 'vnc.html'
          mount.searchParams.set('autoconnect', '1')
          mount.searchParams.set('resize', 'scale')
          mount.searchParams.set('encrypt', window.location.protocol === 'https:' ? '1' : '0')
          mount.searchParams.set('host', window.location.hostname)
          mount.searchParams.set('port', window.location.port || (window.location.protocol === 'https:' ? '443' : '80'))
          // noVNC constructs origin + '/' + path: it does NOT derive the mount.
          mount.searchParams.set('path', `apps/web/${app.id}${sockets[0]}`)
          if (app.viewer.password) mount.searchParams.set('password', app.viewer.password)
        }
        mount.searchParams.set('dsha', reloadSalt())
        return { app, src: mount.pathname + mount.search, mode: 'proxy' }
      } catch { return blocked('Could not reach the application mount. Retry after checking the running app.') }
    }

    function Viewer(props) {
      const app = props.app
      const password = app.viewer ? app.viewer.password : undefined
      const reason = props.reason || null
      return h(
        'div',
        { className: 'dsha-viewer' },
        h(
          'div',
          { className: 'dsha-viewer-bar' },
          h('button', { type: 'button', className: 'dsha-btn', onClick: props.onBack }, '← All apps'),
          h('span', { className: 'dsha-name' }, app.name),
          props.mode === 'proxy'
            ? h('span', { className: 'dsha-badge dsha-run' }, 'same origin')
            : null,
          reason !== null
            ? h('span', { className: 'dsha-sub' }, reason)
            : null,
          h('span', { className: 'dsha-spacer' }),
          password
            ? h(
                'span',
                { title: 'Type this into the viewer when it asks' },
                h('span', { className: 'dsha-sub' }, 'password '),
                h('span', { className: 'dsha-pw' }, password),
              )
            : null,
        ),
        props.src === null
          ? h(
              'div',
              { className: 'dsha-empty' },
              props.mode === 'none'
                ? 'This app declares neither a viewer nor a web address, so there is nothing to embed.'
                : reason || 'Nothing to embed.',
            )
          : h('iframe', {
              className: app.viewer ? 'dsha-frame dsha-frame-vnc' : 'dsha-frame',
              src: props.src,
              title: app.name,
              allow: 'clipboard-read; clipboard-write',
            }),
      )
    }

    async function api(method, body) {
      const res = await fetch(`${API}/${method}`, {
        credentials: 'same-origin',
        ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) throw new Error(data?.error || data?.output || `Application request failed (${res.status})`)
      return data
    }

    function installPrompt(request) {
      return [
        'Help me install an application inside this DSH instance.',
        `My request: ${request}`,
        '',
        'Read the docker-computer skill. Research the app and propose a single-container AppManager plan.',
        'Use computer apps prepare with JSON on stdin; do not hand-edit package catalogs or run ad-hoc docker run/install scripts.',
        'Installed app definitions must live in the private DSH app registry, never in node_modules or a synced workspace.',
        'The plan may set image (explicit tag/digest), id/name, webPort/webPath, exact webSockets, webRewrite prefixes, resource limits, command argv and named-volume targets.',
        'No host bind mounts, privileged access, Docker socket, host networking, arbitrary Docker flags or external-tab fallback.',
        'Research base-path and socket compatibility. A web health check alone is not proof that the whole embedded UI works.',
        'Explain publisher trust: app JavaScript shares DSH origin. Do not suggest installing an untrusted image merely because it is containerized.',
        'Never put credentials in chat, plan files or logs; ask me to supply environment values using Add / replace environment values on the prepared review in Applications.',
        'Prepare the plan, then tell me to review and approve it in Applications → Add app. Do not approve or execute the installation yourself.',
        'If the app needs multiple containers or unsupported permissions, explain the limitation and stop rather than bypassing the installer.',
      ].join('\n')
    }

    async function openInstallDraft(ctx, workspaceId, request) {
      if (!workspaceId || !request.trim()) throw new Error('Choose a workspace and describe the app first.')
      const id = await ctx.sessions.create({ workspaceId })
      await ctx.sessions.using(id, { source: 'controllerOperation' }, async (ref) => {
        const input = ctx.conversation.input.for(ref.binding.ctx)
        input.setDraft(installPrompt(request.trim()))
        ctx.uiWorkspace.openSession(id)
        requestAnimationFrame(() => {
          if ((ctx.sessions.retainInfo(id).getSnapshot().retainedBy.mainView || 0) > 0) input.focus()
        })
      })
      return id
    }

    function InstallReview({ job, onChange }) {
      const [trusted, setTrusted] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [editingEnv, setEditingEnv] = React.useState(false)
      const [envText, setEnvText] = React.useState('')
      React.useEffect(() => setTrusted(false), [job.approval])
      const saveEnv = async () => {
        setBusy(true); setError(null)
        try {
          const env = {}
          for (const line of envText.split('\n').filter(line => line.trim())) {
            const at = line.indexOf('='); if (at < 1) throw new Error('Use NAME=value, one per line.')
            env[line.slice(0, at).trim()] = line.slice(at + 1)
          }
          await api('credentials', { id: job.id, env }); setEnvText(''); setEditingEnv(false); setTrusted(false); await onChange()
        } catch(error) { setError(error.message) } finally { setBusy(false) }
      }
      const plan = job.plan
      const doAction = async (method) => {
        setBusy(true); setError(null)
        try { await api(method, { id: job.id, approval: job.approval, trusted }); await onChange() }
        catch (err) { setError(err.message) } finally { setBusy(false) }
      }
      return h('section', { className: 'dsha-card', 'aria-label': 'Review installation' },
        h('strong', null, `Review: ${plan.name}`),
        h('div', { className: 'dsha-img' }, plan.image),
        h('div', { className: 'dsha-img' }, `Reviewed content: ${job.imageId}`),
        h('p', { className: 'dsha-desc' }, `${plan.cpus} CPU · ${plan.memoryMb} MB RAM · port ${plan.webPort} inside container only · ${plan.autostart ? 'automatic start enabled' : 'on demand'}`),
        h('div', { className: 'dsha-desc' }, `Storage: ${plan.volumes.length ? plan.volumes.map(v => v.target).join(', ') + ' (named volumes kept on uninstall)' : 'no persistent data volumes'}`),
        h('div', { className: 'dsha-desc' }, `Environment keys: ${plan.environmentKeys.join(', ') || 'none'} (values hidden)`),
        h('button', { className: 'dsha-btn', disabled: busy, onClick: () => setEditingEnv(!editingEnv) }, 'Add / replace environment values'),
        editingEnv ? h('div', null,
          h('label', { className: 'dsha-field' }, 'Complete environment values (replaces this plan’s values)', h('textarea', { value: envText, autoComplete: 'off', spellCheck: false, onChange: e => setEnvText(e.target.value) })),
          h('button', { className: 'dsha-btn', disabled: busy, onClick: saveEnv }, 'Save privately & re-review')) : null,
        h('div', { className: 'dsha-desc' }, `Entry: ${plan.webPath}; sockets: ${plan.webSockets.join(', ') || 'none'}; JS prefixes: ${plan.webRewrite.join(', ') || 'none'}`),
        plan.command.length ? h('div', { className: 'dsha-img' }, `Container command: ${JSON.stringify(plan.command)}`) : null,
        h('p', { className: 'dsha-desc' }, 'No host mounts, added capabilities, host networking or published ports. Container still has Docker default capabilities and outbound network access.'),
        h('label', { className: 'dsha-desc' }, h('input', { type: 'checkbox', checked: trusted, onChange: e => setTrusted(e.target.checked) }), ' I trust this publisher. Its embedded JavaScript shares the DSH origin and can interact with this harness.'),
        h('div', { className: 'dsha-actions' },
          h('button', { className: 'dsha-btn dsha-btn-primary', disabled: busy || !trusted, onClick: () => doAction('approve') }, busy ? 'Working…' : 'Approve & install'),
          h('button', { className: 'dsha-btn', disabled: busy, onClick: () => doAction('cancel') }, 'Cancel plan')),
        error ? h('p', { className: 'dsha-err dsha-msg' }, error) : null,
      )
    }

    function InstallJobs({ jobs, onChange }) {
      return h('div', { className: 'dsha-jobs' }, jobs.map(job => job.state === 'review'
        ? h(InstallReview, { key: job.id, job, onChange })
        : h('details', { key: job.id, className: 'dsha-card', open: !['ready','failed','cancelled'].includes(job.state) },
          h('summary', null, `${job.plan.name}: ${job.state}`),
          h('pre', { className: 'dsha-install-log' }, job.events.join('\n')),
          job.state === 'queued' ? h('button', { className: 'dsha-btn', onClick: async () => { try { await api('retry', { id: job.id }); await onChange() } catch(error) { window.alert(error.message) } } }, 'Retry queued install') : null,
          job.state === 'failed' ? h('p', { className: 'dsha-desc' }, 'Prepare a fresh plan to retry. Images and named data volumes were retained.') : null)))
    }

    function ExistingContainers({ onChange, labelledOnly = false }) {
      const [items,setItems]=React.useState([]), [error,setError]=React.useState(''), [form,setForm]=React.useState(null), [review,setReview]=React.useState(null), [trusted,setTrusted]=React.useState(false), [busy,setBusy]=React.useState(false)
      const load=async()=>{try{setItems((await api('discovery')).containers);setError('')}catch(e){setError(e.message)}}
      React.useEffect(()=>{load();const timer=setInterval(load,10000);return()=>clearInterval(timer)},[])
      const task=async fn=>{setBusy(true);setError('');try{await fn()}catch(e){setError(e.message)}finally{setBusy(false)}}
      const field=(key,label)=>h('label',{className:'dsha-field'},label,h('input',{value:form[key],onChange:e=>{setForm({...form,[key]:e.target.value});setReview(null);setTrusted(false)}}))
      const shown=items.filter(i=>!labelledOnly||i.labelled)
      if(labelledOnly&&!shown.length&&!error)return null
      return h('section',{className:'dsha-card dsha-add-section'},h('strong',null,labelledOnly?'Found existing apps':'Add existing container'),
        h('p',{className:'dsha-desc'},'Register an existing web app without recreating its container or changing storage.'),
        error?h('p',{className:'dsha-msg dsha-err'},error):null,
        shown.map(i=>h('div',{key:i.containerId,className:'dsha-desc'},`${i.containerName} · ${i.state} · ${i.ports.length?i.ports.join(', '):'choose web port'} `,
          h('button',{className:'dsha-btn',disabled:busy,onClick:()=>{setForm({containerId:i.containerId,id:i.suggestedId||'',name:i.suggestedId||i.containerName,webPort:String(i.ports[0]||80),webPath:'/',webSockets:'',webRewrite:''});setReview(null);setTrusted(false)}},'Review listing'))),
        !shown.length?h('p',{className:'dsha-desc'},'No unlisted web containers found.'):null,
        form?h('div',null,field('id','App id'),field('name','Display name'),field('webPort','Container HTTP port'),field('webPath','Web entry path'),field('webSockets','Exact WebSocket paths (space-separated)'),field('webRewrite','JS URL prefixes (space-separated)'),
          h('button',{className:'dsha-btn',disabled:busy,onClick:()=>task(async()=>{const data={...form,webPort:Number(form.webPort),webSockets:form.webSockets.split(/\s+/).filter(Boolean),webRewrite:form.webRewrite.split(/\s+/).filter(Boolean)};setReview({...(await api('review-existing',data)).review,data});setTrusted(false)})},'Review connection'),
          review?h('div',null,h('p',{className:'dsha-desc'},review.notice),h('p',{className:'dsha-desc'},`${review.summary.containerName} · ${review.app.image} · port ${review.app.webPort}`),h('p',{className:'dsha-desc'},`Existing permissions: ${JSON.stringify(review.summary.permissions)}`),
            h('label',{className:'dsha-desc'},h('input',{type:'checkbox',checked:trusted,onChange:e=>setTrusted(e.target.checked)}),' I trust this app to share the harness origin.'),
            h('button',{className:'dsha-btn dsha-btn-primary',disabled:busy||!trusted,onClick:()=>task(async()=>{await api('add-existing',{...review.data,approval:review.approval,trusted});setForm(null);setReview(null);await load();await onChange()})},'Add to My apps')):null):null)
    }

    function AddApps({ ctx, recipes, jobs, loadError, onChange, onBack }) {
      const [advanced, setAdvanced] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [request, setRequest] = React.useState('')
      const [workspaces, setWorkspaces] = React.useState(() => ctx.workspaces.list.getSnapshot().items)
      const [workspace, setWorkspace] = React.useState(() => ctx.workspaces.list.getSnapshot().items[0]?.workspaceId || '')
      const [form, setForm] = React.useState({ id: '', name: '', image: '', webPort: '80', webPath: '/', cpus: '1', memoryMb: '512', volumes: '', webSockets: '', webRewrite: '', env: '', command: '' })
      React.useEffect(() => ctx.workspaces.list.subscribe(() => setWorkspaces(ctx.workspaces.list.getSnapshot().items)), [ctx])
      const task = async (fn) => { setBusy(true); setError(null); try { await fn() } catch(err) { setError(err.message) } finally { setBusy(false) } }
      const field = (key, label, type = 'text') => h('label', { className: 'dsha-field' }, label,
        h('input', { type, value: form[key], autoComplete: 'off', onChange: e => setForm({ ...form, [key]: e.target.value }) }))
      const paths = (value) => value.trim() ? value.trim().split(/\s+/) : []
      const prepare = async (body) => { await api('prepare', body); setForm({ ...form, env: '' }); await onChange() }
      const custom = () => task(async () => {
        const env = {}
        for (const line of form.env.split('\n').filter(line => line.trim())) {
          const at = line.indexOf('='); if (at < 1) throw new Error('Environment needs one NAME=value per line.')
          env[line.slice(0, at).trim()] = line.slice(at + 1)
        }
        await prepare({ plan: { id: form.id, name: form.name || form.id, image: form.image, webPort: Number(form.webPort), webPath: form.webPath,
          cpus: Number(form.cpus), memoryMb: Number(form.memoryMb), volumes: paths(form.volumes).map(target => ({target})),
          webSockets: paths(form.webSockets), webRewrite: paths(form.webRewrite), env, command: form.command ? JSON.parse(form.command) : [] } })
      })
      return h('div', { className: 'dsha-body' },
        h('button', { className: 'dsha-btn', onClick: onBack }, '← My apps'),
        h('h2', { className: 'dsha-title' }, 'Add app'),
        h('p', { className: 'dsha-desc' }, 'Choose a supported recipe, ask an agent to research another app, or prepare a reviewed container configuration. Review preparation may download the image to inspect it; no container starts until you approve.'),
        error || loadError ? h('div', { className: 'dsha-msg dsha-err' }, error || loadError) : null,
        h(InstallJobs, { jobs: jobs.filter(j=>!['ready','cancelled','failed'].includes(j.state)), onChange }),
        jobs.some(j=>['ready','cancelled','failed'].includes(j.state)) ? h('details', {className:'dsha-add-section'}, h('summary', null, 'Installation history'), h(InstallJobs, {jobs:jobs.filter(j=>['ready','cancelled','failed'].includes(j.state)),onChange})) : null,
        h(ExistingContainers, {onChange}),
        jobs.some(job => !['review','ready','cancelled'].includes(job.state)) ? h('button', { className: 'dsha-btn', disabled: busy, onClick: () => task(async () => { await api('recover', {}); await onChange() }) }, 'Recover interrupted installs') : null,
        h('div', { className: 'dsha-grid' }, recipes.map(recipe => h('div', { key: recipe.id, className: 'dsha-card' },
          h('strong', null, recipe.name), h('p', { className: 'dsha-desc' }, recipe.description),
          h('p', { className: 'dsha-desc' }, recipe.notes),
          h('button', { className: 'dsha-btn', disabled: busy, onClick: () => task(() => prepare({recipe: recipe.id})) }, 'Review install')))),
        h('section', { className: 'dsha-card dsha-add-section' },
          h('strong', null, 'Install something else…'),
          h('label', { className: 'dsha-field' }, 'App name, container image or project URL', h('input', { value: request, onChange: e => setRequest(e.target.value), placeholder: 'Describe the app you want' })),
          h('label', { className: 'dsha-field' }, 'Setup workspace', h('select', { value: workspace, onChange: e => setWorkspace(e.target.value) },
            h('option', { value: '' }, 'Choose workspace'), workspaces.map(w => h('option', { key: w.workspaceId, value: w.workspaceId }, w.title || w.path)))),
          h('button', { className: 'dsha-btn dsha-btn-primary', disabled: busy || !workspace || !request.trim(), onClick: () => task(() => openInstallDraft(ctx, workspace, request)) }, 'Open setup conversation'),
          h('p', { className: 'dsha-desc' }, 'Creates a new thread with a draft request. Review it and press Send. The agent prepares a plan; you approve it here. Never paste credentials into the chat.')),
        h('button', { className: 'dsha-btn dsha-add-section', onClick: () => setAdvanced(!advanced), 'aria-expanded': advanced }, advanced ? 'Hide Advanced' : 'Advanced container install'),
        advanced ? h('section', { className: 'dsha-card dsha-add-section' },
          h('strong', null, 'Single-container plan'), h('div', { className: 'dsha-form-grid' },
            field('id', 'App id'), field('name', 'Display name'), field('image', 'Image with explicit tag or digest'), field('webPort', 'Container web port', 'number'), field('webPath', 'Web entry path'), field('cpus', 'CPUs', 'number'), field('memoryMb', 'Memory (MB)', 'number'), field('volumes', 'Persistent data directories (space-separated)'), field('webSockets', 'Exact socket paths'), field('webRewrite', 'JS URL prefixes (ending /)'), field('command', 'Optional command argv (JSON array)')),
          h('label', { className: 'dsha-field' }, 'Environment values (NAME=value, one per line)', h('textarea', { value: form.env, spellCheck: false, autoComplete: 'off', onChange: e => setForm({ ...form, env: e.target.value }) })),
          h('p', { className: 'dsha-desc' }, 'Values go to private app storage, not chat or the plan summary. They remain accessible to the app and Docker administrators. Existing app ids cannot be overwritten.'),
          h('button', { className: 'dsha-btn dsha-btn-primary', disabled: busy, onClick: custom }, 'Prepare review')) : null,
      )
    }

    function ApplicationsPanel({ ctx }) {
      const [state, reload] = useApps()
      const [busy, setBusy] = React.useState(null)
      const [lastAction, setLastAction] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [view, setView] = React.useState(null)
      const [adding, setAdding] = React.useState(false)
      const [installData, setInstallData] = React.useState({ recipes: [], jobs: [], loadError: null })
      const loadInstalls = React.useCallback(async () => {
        try { const [r,j] = await Promise.all([api('recipes'), api('jobs')]); setInstallData({ recipes: r.recipes, jobs: j.jobs, loadError: null }) }
        catch(err) { setInstallData(previous => ({ ...previous, loadError: err.message })); setNote({kind:'error',text:err.message}) }
      }, [])
      React.useEffect(() => { loadInstalls(); const timer = setInterval(loadInstalls, 2000); return () => clearInterval(timer) }, [loadInstalls])
      const changed = async () => { await loadInstalls(); await reload() }

      const apps = state.apps

      const onAction = React.useCallback(
        async (action, id) => {
          if (action === 'open') {
            const target = apps.find((a) => a.id === id)
            if (target === undefined) return
            setBusy(id)
            setLastAction('open')
            try {
              setView(await resolveView(target))
            } finally {
              setBusy(null)
              setLastAction(null)
            }
            return
          }
          if (action === 'forget' && !window.confirm('Forget this listing? The container and its storage will not be changed.')) return
          if (action === 'uninstall' && !window.confirm('Uninstall this app? Its named data volumes and image will be kept.')) return
          setBusy(id)
          setLastAction(action)
          setNote(null)
          try {
            const res = await fetch(`${API}/action`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action, id }),
            })
            const json = await res.json().catch(() => null)
            if (!res.ok || json === null || json.ok === false) {
              setNote({
                kind: 'error',
                text: (json && (json.error || json.output)) || `HTTP ${res.status}`,
              })
            } else {
              setNote({ kind: 'ok', text: `${action} ${id}: ${json.output || 'ok'}` })
            }
          } catch (err) {
            setNote({ kind: 'error', text: String((err && err.message) || err) })
          } finally {
            setBusy(null)
            setLastAction(null)
            await reload()
          }
        },
        [apps, reload],
      )

      const onBack = React.useCallback(() => setView(null), [])

      if (view !== null) return h(Viewer, { ...view, onBack })
      if (adding) return h(AddApps, { ctx, ...installData, onChange: changed, onBack: () => setAdding(false) })

      return h(
        'div',
        { className: 'dsha-root' },
        h(
          'div',
          { className: 'dsha-head' },
          h('span', { className: 'dsha-title' }, 'My apps'),
          h(
            'span',
            { className: 'dsha-sub' },
            state.loading
              ? 'loading…'
              : `${apps.filter((a) => a.state === 'running').length} running of ${apps.length}`,
          ),
          h('span', { className: 'dsha-spacer' }),
          h('button', { type: 'button', className: 'dsha-btn dsha-btn-primary', onClick: () => setAdding(true) }, '+ Add app'),
          h('button', { type: 'button', className: 'dsha-btn', onClick: changed }, 'Refresh'),
        ),
        note
          ? h(
              'div',
              { className: `dsha-msg ${note.kind === 'error' ? 'dsha-err' : 'dsha-ok'}` },
              note.text,
            )
          : null,
        h(
          'div',
          { className: 'dsha-body' },
          h(ExistingContainers, {onChange:changed,labelledOnly:true}),
          h(InstallJobs, { jobs: installData.jobs.filter(job => job.state !== 'cancelled' && job.state !== 'ready'), onChange: changed }),
          state.error
            ? h('div', { className: 'dsha-msg dsha-err' }, state.error)
            : apps.length === 0
              ? h(
                  'div',
                  { className: 'dsha-empty' },
                  state.loading ? 'Loading applications…' : 'No applications in the catalog.',
                )
              : h(
                  'div',
                  { className: 'dsha-grid' },
                  apps.map((app) =>
                    h(AppCard, {
                      key: app.id,
                      app,
                      busy,
                      lastAction,
                      anyBusy: busy !== null,
                      onAction,
                    }),
                  ),
                ),
        ),
      )
    }

    /** Sidebar icon. Receives { size, active } from the sidebar's PanelRow. */
    function ApplicationsIcon(props) {
      const size = (props && props.size) || 16
      const active = !!(props && props.active)
      const box = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, rx: 1.5 }
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          'aria-hidden': 'true',
          style: { display: 'block', opacity: active ? 1 : 0.72 },
        },
        h('rect', Object.assign({}, box, { x: 1.6, y: 1.6, width: 5.2, height: 5.2 })),
        h('rect', Object.assign({}, box, { x: 9.2, y: 1.6, width: 5.2, height: 5.2 })),
        h('rect', Object.assign({}, box, { x: 1.6, y: 9.2, width: 5.2, height: 5.2 })),
        h('rect', Object.assign({}, box, { x: 9.2, y: 9.2, width: 5.2, height: 5.2 })),
      )
    }

    // ------------------------------------------------------------ plugin body
    function apply(ctx) {
      installStyle()

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_KEY,
            order: 12,
            label: () => 'Applications',
            registrant: REGISTRANT,
          },
          (props) => h(ApplicationsIcon, props),
        ),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_KEY,
            id: `${REGISTRANT}:main`,
            order: 12,
            registrant: REGISTRANT,
          },
          () => h(ApplicationsPanel, { ctx }),
        ),
      )
    }

    const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'conversation']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
