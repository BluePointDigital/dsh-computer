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
    // The shell's own component library. It is provided through the platform
    // module table (the shell bundle registers it under this id) and declared in
    // this package's dsh.client.inject. Using it is the difference between a
    // panel that is part of the shell and one that merely sits beside it.
    const { Menu, StateDot, Tag } = require('@deepseek-ai/dsh-client-ui-primitives')

    const API = '/apps/api'
    const PANEL_KEY = 'applications'
    const REGISTRANT = 'dsh-applications'
    const POLL_MS = 5000

    // --------------------------------------------------------------- styles
    // Colours come from the shell's own design tokens, so the panel follows the
    // host theme in light and dark instead of hard-coding a palette that fights
    // it. Only layout lives here: buttons, tags and state come from primitives.
    const STYLE_ID = 'dsh-applications-style'
    const CSS = [
      '.dsha-root{display:flex;flex-direction:column;height:100%;min-height:0;font:inherit;color:inherit}',
      '.dsha-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:0 0 auto}',
      '.dsha-title{font-weight:600;font-size:14px}',
      '.dsha-sub{font-size:12px;opacity:.6}',
      '.dsha-spacer{flex:1 1 auto}',
      // Buttons are still the local class: 17 call sites across the installer and
      // viewer. They move to the primitive Button in one complete pass, with the
      // CSS deleted at the same time — a half-migrated button set looks worse
      // than either end state.
      '.dsha-btn{font:inherit;font-size:12px;padding:5px 11px;border-radius:6px;border:1px solid var(--dsw-alias-border-l3);background:transparent;color:inherit;cursor:pointer}',
      '.dsha-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsha-btn:disabled{opacity:.45;cursor:default}',
      '.dsha-btn-primary{border-color:var(--dsw-alias-brand-primary)}',
      '.dsha-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);border-color:var(--dsw-alias-state-error-primary)}',
      '.dsha-body{flex:1 1 auto;min-height:0;overflow:auto;padding:16px}',
      '.dsha-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}',
      // The app grid is an OS-style picker: icon, name, state, and a kebab that
      // carries everything else. Tiles are buttons, so Enter and Space work as
      // click, and the menu handles its own arrow keys and Escape.
      '.dsha-appgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(146px,1fr));gap:10px}',
      '.dsha-tile-wrap{position:relative;display:flex}',
      '.dsha-tile{display:flex;flex-direction:column;align-items:center;gap:9px;width:100%;padding:16px 10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;text-align:center;cursor:pointer}',
      '.dsha-tile:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}',
      '.dsha-tile:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}',
      '.dsha-tile:disabled{opacity:.5;cursor:default}',
      '.dsha-tile-on{border-color:var(--dsw-alias-state-success-primary)}',
      '.dsha-tile-iconwrap{position:relative;display:flex;align-items:center;justify-content:center;width:46px;height:46px;border-radius:12px;background:var(--dsw-alias-bg-layer-2)}',
      '.dsha-tile-icon{width:26px;height:26px}',
      '.dsha-tile-letter{font-size:18px;font-weight:600}',
      '.dsha-tile-dot{position:absolute;right:-4px;bottom:-4px;display:flex;padding:1px;border-radius:99px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsha-tile-name{font-size:12px;font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsha-tile-sub{font-size:10px;letter-spacing:.04em;text-transform:uppercase;opacity:.55;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsha-tile-more{position:absolute;top:3px;right:3px;padding:2px 6px;border:0;border-radius:6px;background:transparent;color:inherit;font-size:14px;line-height:1;opacity:0;cursor:pointer}',
      '.dsha-tile-wrap:hover .dsha-tile-more,.dsha-tile-more:focus-visible{opacity:.7}',
      '.dsha-tile-more:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover)}',
      // Templates in the Add view: wider than an app tile, because a template has
      // to say what it will create before you commit to it.
      '.dsha-template{justify-content:space-between;gap:10px}',
      '.dsha-template-top{display:flex;align-items:flex-start;gap:10px}',
      '.dsha-template-top .dsha-tile-iconwrap{flex:0 0 auto;width:38px;height:38px;border-radius:10px}',
      '.dsha-template-top .dsha-tile-icon{width:22px;height:22px}',
      '.dsha-template-text{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dsha-note{font-size:11px;line-height:1.5;opacity:.62}',
      '.dsha-section-head{display:flex;align-items:baseline;gap:8px;margin:22px 0 6px}',
      '.dsha-section-head .dsha-title{font-size:13px;letter-spacing:.02em;text-transform:uppercase;opacity:.75}',
      '.dsha-count{font-size:11px;opacity:.5}',
      '.dsha-filter{font:inherit;font-size:12px;padding:4px 8px;min-width:190px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:inherit}',
      '.dsha-card{display:flex;flex-direction:column;gap:8px;padding:13px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}',
      '.dsha-card-top{display:flex;align-items:center;gap:8px}',
      '.dsha-name{font-weight:600;font-size:13px}',
      '.dsha-desc{font-size:12px;opacity:.72;line-height:1.45}',
      '.dsha-img{font-size:11px;opacity:.5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}',
      '.dsha-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px;align-items:center}',
      '.dsha-msg{margin:0 16px 12px;padding:9px 12px;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-word}',
      '.dsha-err{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-state-error-primary)}',
      '.dsha-ok{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-state-success-primary)}',
      '.dsha-viewer{flex:1 1 auto;display:flex;flex-direction:column;min-height:0}',
      '.dsha-viewer-bar{display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:0 0 auto}',
      '.dsha-pw{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;padding:3px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);user-select:all}',
      '.dsha-frame{flex:1 1 auto;width:100%;border:0;background:transparent;min-height:0}',
      // A VNC viewer is a canvas on a black framebuffer, so black is correct
      // there. An HTML dashboard must NOT get a black backdrop: the framed
      // document's own background is not always composited into a screenshot
      // (observed under Xvfb), and a black underlay makes a working page look
      // broken. Transparent lets the host theme show through instead.
      '.dsha-frame-vnc{background:#000}',
      '.dsha-field{display:flex;flex-direction:column;gap:5px;font-size:12px}',
      '.dsha-field input,.dsha-field textarea,.dsha-field select{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;padding:8px;min-width:0}',
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

    // ---------------------------------------------------------------- app icons
    // An app's icon is content, like its name or image tag — not UI chrome — so it
    // is drawn here rather than borrowed from the shell's icon set, which has no
    // monitor/terminal/server glyphs. Keyed by catalog id, with a letter tile as
    // the fallback so a new app always renders something deliberate.
    const ICON_SHAPES = {
      desktop: ['M3 4.5h18v10.5H3z', 'M9 19.5h6', 'M12 15v4.5'],
      shell: ['M4 5h16v14H4z', 'M8 9.5l2.6 2.5L8 14.5', 'M13.4 15h3.6'],
      whoami: ['M12 12.4a3.9 3.9 0 100-7.8 3.9 3.9 0 000 7.8z', 'M5 19.8c1.6-3.5 4.1-5.1 7-5.1s5.4 1.6 7 5.1'],
      nginx: ['M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17z', 'M3.6 12h16.8', 'M12 3.5c3.1 3.4 3.1 13.6 0 17'],
      hyperframes: ['M3.5 5h17v14h-17z', 'M10 9.4l5.6 2.6-5.6 2.6z'],
      'code-server': ['M9 8.5L5.5 12 9 15.5', 'M15 8.5L18.5 12 15 15.5', 'M13.2 6.5l-2.4 11'],
      filebrowser: ['M3.5 6.5h5.4l2 2.5h9.6v10h-17z'],
      'it-tools': ['M14.8 4.7a4.6 4.6 0 00-5.7 5.7L4.4 15.1l2.6 2.6 4.7-4.7a4.6 4.6 0 005.7-5.7l-2.7 2.7-2.3-.6-.6-2.3z'],
      focalboard: ['M4 5.5h4.2v13H4z', 'M9.9 5.5h4.2v9H9.9z', 'M15.8 5.5H20v11h-4.2z'],
      excalidraw: ['M4.5 19.5l1-4 9.6-9.6 3.5 3.5-9.6 9.6z', 'M15.1 4.9l1.4-1.4a1.7 1.7 0 012.4 0l1 1a1.7 1.7 0 010 2.4l-1.4 1.4'],
      box: ['M12 3.6l7.4 4.2v8.4L12 20.4l-7.4-4.2V7.8z', 'M4.6 7.8L12 12l7.4-4.2', 'M12 12v8.4'],
      default: ['M4 4.5h6.6v6.6H4z', 'M13.4 4.5H20v6.6h-6.6z', 'M4 12.9h6.6V19.5H4z', 'M13.4 12.9H20V19.5h-6.6z'],
    }
    function iconKey(app) {
      const id = String((app && app.id) || '').toLowerCase()
      if (ICON_SHAPES[id]) return id
      const name = String((app && app.name) || '').toLowerCase()
      if (/desktop|workstation|vnc/.test(name)) return 'desktop'
      if (/shell|terminal|console|bash/.test(name)) return 'shell'
      if (/whoami|account|profile|user/.test(name)) return 'whoami'
      if (/nginx|proxy|http|web|server/.test(name)) return 'nginx'
      if (/studio|video|film|media|frame/.test(name)) return 'hyperframes'
      if (/code|editor|ide/.test(name)) return 'code-server'
      if (/file|browse|storage/.test(name)) return 'filebrowser'
      if (/tool|util/.test(name)) return 'it-tools'
      if (/board|kanban|task|project/.test(name)) return 'focalboard'
      if (/diagram|draw|sketch|whiteboard/.test(name)) return 'excalidraw'
      return 'default'
    }
    function AppIcon(props) {
      const app = props.app
      const shapes = ICON_SHAPES[iconKey(app)]
      if (!shapes) {
        return h('span', { className: 'dsha-tile-letter' },
          String(app.name || app.id || '?').trim().charAt(0).toUpperCase())
      }
      return h(
        'svg',
        { className: 'dsha-tile-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        shapes.map((d, i) => h('path', {
          key: i, d, fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        })),
      )
    }
    // Running is healthy, an existing stopped app wants attention, and a catalog
    // entry that has never run is simply idle.
    function dotState(state) {
      return state === 'running' ? 'done' : state === 'stopped' ? 'warning' : 'idle'
    }

    // ---------------------------------------------------------------- pieces
    // One app, as a tile in the grid. Clicking it does the obvious thing — open
    // its screen, or launch it — and everything else lives behind the kebab, which
    // is also what right-click opens. That is what an operating system's app grid
    // does, so it is what this does.
    function AppTile(props) {
      const app = props.app
      const running = app.state === 'running'
      const exists = running || app.state === 'stopped'
      const busy = props.busy === app.id
      const canOpen = running && (app.viewer || app.web)
      const disabled = busy || props.anyBusy
      const [menu, setMenu] = React.useState(false)

      const run = (action) => {
        setMenu(false)
        props.onAction(action, app.id)
      }

      const items = []
      if (canOpen) items.push({ id: 'open', label: 'Open screen' })
      items.push(running ? { id: 'down', label: 'Stop' } : { id: 'up', label: 'Launch' })
      if (app.managed) items.push({ id: 'logs', label: 'Logs' })
      if (app.existing) {
        items.push({ type: 'separator', id: 'sep-a' }, { id: 'forget', label: 'Forget listing', danger: true })
      } else if (app.managed) {
        items.push({ type: 'separator', id: 'sep-b' }, { id: 'uninstall', label: 'Uninstall', danger: true })
      } else if (exists) {
        items.push({ type: 'separator', id: 'sep-c' }, { id: 'rm', label: 'Remove container', danger: true })
      }

      const primary = canOpen ? 'open' : running ? null : 'up'
      const subtitle = busy
        ? 'working…'
        : app.existing && !exists ? 'container missing' : app.state

      return h(
        'div',
        { className: 'dsha-tile-wrap' },
        h(
          'button',
          {
            type: 'button',
            className: `dsha-tile${running ? ' dsha-tile-on' : ''}`,
            disabled,
            title: app.description || app.name,
            onClick: () => { if (primary) run(primary) },
            onContextMenu: (event) => {
              event.preventDefault()
              if (!disabled) setMenu(true)
            },
          },
          h(
            'span',
            { className: 'dsha-tile-iconwrap' },
            h(AppIcon, { app }),
            h('span', { className: 'dsha-tile-dot' }, h(StateDot, { state: dotState(app.state), size: 9 })),
          ),
          h('span', { className: 'dsha-tile-name' }, app.name),
          h('span', { className: 'dsha-tile-sub' }, subtitle),
        ),
        h(Menu, {
          open: menu,
          dense: true,
          align: 'end',
          side: 'bottom',
          items,
          onSelect: run,
          onClose: () => setMenu(false),
          anchor: h(
            'button',
            {
              type: 'button',
              className: 'dsha-tile-more',
              'aria-label': `Actions for ${app.name}`,
              disabled,
              onClick: () => setMenu(!menu),
            },
            '⋯',
          ),
        }),
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
            ? h(Tag, { tone: 'quiet' }, 'same origin')
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
              translate: 'no',
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

    // A template is not an app yet: it is a reviewed plan you are about to create.
    // So it gets its own card — what it is, what it will cost, and one action.
    function RecipeCard(props) {
      const recipe = props.recipe
      return h(
        'div',
        { className: 'dsha-card dsha-template' },
        h(
          'div',
          { className: 'dsha-template-top' },
          h('span', { className: 'dsha-tile-iconwrap' }, h(AppIcon, { app: { id: recipe.id, name: recipe.name } })),
          h(
            'div',
            { className: 'dsha-template-text' },
            h('span', { className: 'dsha-name' }, recipe.name),
            h('span', { className: 'dsha-desc' }, recipe.description),
          ),
        ),
        recipe.notes ? h('div', { className: 'dsha-note' }, recipe.notes) : null,
        h(
          'div',
          { className: 'dsha-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsha-btn dsha-btn-primary',
              disabled: props.busy,
              onClick: props.onReview,
            },
            props.busy ? 'Working…' : 'Review install',
          ),
        ),
      )
    }

    function AddApps({ ctx, recipes, jobs, loadError, onChange, onBack }) {
      const [advanced, setAdvanced] = React.useState(false)
      const [asking, setAsking] = React.useState(false)
      const [query, setQuery] = React.useState('')
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
      const needle = query.trim().toLowerCase()
      const shown = needle
        ? recipes.filter((r) => `${r.name} ${r.description} ${r.id}`.toLowerCase().includes(needle))
        : recipes
      const activeJobs = jobs.filter((j) => !['ready', 'cancelled', 'failed'].includes(j.state))
      const pastJobs = jobs.filter((j) => ['ready', 'cancelled', 'failed'].includes(j.state))
      const interrupted = jobs.some((job) => !['review', 'ready', 'cancelled'].includes(job.state))

      return h('div', { className: 'dsha-body' },
        h('button', { className: 'dsha-btn', onClick: onBack }, '← Applications'),
        h('h2', { className: 'dsha-title' }, 'Add an app'),
        h('p', { className: 'dsha-desc' }, 'Everything here runs as a container on this machine. Preparing a plan may download the image so it can be inspected; no container starts until you approve that plan.'),
        error || loadError ? h('div', { className: 'dsha-msg dsha-err' }, error || loadError) : null,

        // An install already in flight is the most important thing on this page.
        activeJobs.length ? h('div', { className: 'dsha-section-head' },
          h('span', { className: 'dsha-title' }, 'In progress'),
          h('span', { className: 'dsha-count' }, String(activeJobs.length))) : null,
        activeJobs.length ? h(InstallJobs, { jobs: activeJobs, onChange }) : null,
        interrupted ? h('button', { className: 'dsha-btn', disabled: busy, onClick: () => task(async () => { await api('recover', {}); await onChange() }) }, 'Recover interrupted installs') : null,

        h('div', { className: 'dsha-section-head' },
          h('span', { className: 'dsha-title' }, 'Templates'),
          h('span', { className: 'dsha-count' }, needle ? `${shown.length} of ${recipes.length}` : String(recipes.length)),
          h('span', { className: 'dsha-spacer' }),
          h('input', { className: 'dsha-filter', value: query, placeholder: 'Filter templates', 'aria-label': 'Filter templates', onChange: (e) => setQuery(e.target.value) })),
        h('p', { className: 'dsha-desc' }, 'Each template is one container with the data volumes it needs. Nothing is published to the network; you reach it from this panel.'),
        shown.length === 0
          ? h('div', { className: 'dsha-empty' }, `No template matches “${query.trim()}”.`)
          : h('div', { className: 'dsha-grid' }, shown.map((recipe) =>
              h(RecipeCard, { key: recipe.id, recipe, busy, onReview: () => task(() => prepare({ recipe: recipe.id })) }))),

        h('div', { className: 'dsha-section-head' }, h('span', { className: 'dsha-title' }, 'Already running here')),
        h(ExistingContainers, { onChange }),

        h('div', { className: 'dsha-section-head' }, h('span', { className: 'dsha-title' }, 'Custom')),
        h('button', { className: 'dsha-btn', onClick: () => setAdvanced(!advanced), 'aria-expanded': advanced }, advanced ? 'Hide custom container install' : 'Custom container install — one container, reviewed'),
        advanced ? h('section', { className: 'dsha-card dsha-add-section' },
          h('strong', null, 'Single-container plan'), h('div', { className: 'dsha-form-grid' },
            field('id', 'App id'), field('name', 'Display name'), field('image', 'Image with explicit tag or digest'), field('webPort', 'Container web port', 'number'), field('webPath', 'Web entry path'), field('cpus', 'CPUs', 'number'), field('memoryMb', 'Memory (MB)', 'number'), field('volumes', 'Persistent data directories (space-separated)'), field('webSockets', 'Exact socket paths'), field('webRewrite', 'JS URL prefixes (ending /)'), field('command', 'Optional command argv (JSON array)')),
          h('label', { className: 'dsha-field' }, 'Environment values (NAME=value, one per line)', h('textarea', { value: form.env, spellCheck: false, autoComplete: 'off', onChange: e => setForm({ ...form, env: e.target.value }) })),
          h('p', { className: 'dsha-desc' }, 'Values go to private app storage, not chat or the plan summary. They remain accessible to the app and Docker administrators. Existing app ids cannot be overwritten.'),
          h('button', { className: 'dsha-btn dsha-btn-primary', disabled: busy, onClick: custom }, 'Prepare review')) : null,

        h('div', { className: 'dsha-section-head' }, h('span', { className: 'dsha-title' }, 'Not in the list?')),
        h('button', { className: 'dsha-btn', onClick: () => setAsking(!asking), 'aria-expanded': asking }, asking ? 'Hide agent-assisted setup' : 'Ask an agent to research it'),
        asking ? h('section', { className: 'dsha-card dsha-add-section' },
          h('strong', null, 'Agent-assisted setup'),
          h('p', { className: 'dsha-desc' }, 'Opens a new thread with your request. The agent researches the app, then prepares a plan that appears under “In progress” above for your approval. Credentials never go in the chat: a plan can carry an environment key, and you supply its value in the review.'),
          h('label', { className: 'dsha-field' }, 'What are you trying to run?', h('input', { value: request, onChange: e => setRequest(e.target.value), placeholder: 'e.g. a wiki the whole team can edit' })),
          h('label', { className: 'dsha-field' }, 'Workspace for the planning thread', h('select', { value: workspace, onChange: e => setWorkspace(e.target.value) },
            h('option', { value: '' }, 'Choose a workspace'), workspaces.map(w => h('option', { key: w.workspaceId, value: w.workspaceId }, w.title || w.path)))),
          h('button', { className: 'dsha-btn dsha-btn-primary', disabled: busy || !workspace || !request.trim(), onClick: () => task(() => openInstallDraft(ctx, workspace, request)) }, 'Open setup conversation'),
          !workspace ? h('p', { className: 'dsha-note' }, 'Choose a workspace to continue.')
            : !request.trim() ? h('p', { className: 'dsha-note' }, 'Describe what you want to run to continue.') : null) : null,

        pastJobs.length ? h('details', { className: 'dsha-add-section' },
          h('summary', null, `Installation history (${pastJobs.length})`),
          h(InstallJobs, { jobs: pastJobs, onChange })) : null,
      )
    }

    function ApplicationsPanel({ ctx }) {
      const [state, reload] = useApps()
      const [busy, setBusy] = React.useState(null)
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
            try {
              setView(await resolveView(target))
            } finally {
              setBusy(null)
            }
            return
          }
          if (action === 'forget' && !window.confirm('Forget this listing? The container and its storage will not be changed.')) return
          if (action === 'uninstall' && !window.confirm('Uninstall this app? Its named data volumes and image will be kept.')) return
          setBusy(id)
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
                  { className: 'dsha-appgrid' },
                  apps.map((app) =>
                    h(AppTile, {
                      key: app.id,
                      app,
                      busy,
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
