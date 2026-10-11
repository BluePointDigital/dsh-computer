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
          running ? btn('Stop', 'down') : btn('Launch', 'up', 'dsha-btn-primary'),
          running && (app.viewer || app.web) ? btn('Open', 'open') : null,
          exists ? btn('Remove', 'rm', 'dsha-btn-danger') : null,
        ),
      )
    }

    /**
     * Decide what to embed.
     *
     * A VNC viewer goes straight in. An HTTP dashboard prefers the same-origin
     * proxy mount, but only after CONFIRMING that route is really mounted: an
     * unmounted `/apps/web/...` falls through to the SPA server, which answers
     * 200 with the app shell — so trusting a bare status code would nest the GUI
     * inside itself. The proxy marks its responses; nothing else does. When the
     * mark is missing we use the app's own published origin instead, which works
     * today and keeps working after the host half is reloaded.
     */
    async function resolveView(app) {
      if (app.viewer) {
        // Supply the VNC password to the EMBEDDED viewer only, so it connects
        // without a prompt. The bar below renders that same password, so inside
        // this authenticated GUI it adds no exposure — and an iframe URL creates
        // no history entry. "New tab" deliberately omits it: that one does.
        const password = app.viewer.password
        const src = password
          ? `${app.viewer.url}${app.viewer.url.includes('?') ? '&' : '?'}password=${encodeURIComponent(password)}`
          : app.viewer.url
        return { app, src, mode: 'viewer', externalUrl: app.viewer.url }
      }

      const web = app.web
      if (web === undefined || typeof web.url !== 'string') {
        return { app, src: 'about:blank', mode: 'none', externalUrl: null }
      }

      if (web.mode !== 'direct' && typeof web.path === 'string' && web.path !== '') {
        try {
          const probe = await fetch(web.path, { method: 'HEAD', credentials: 'same-origin' })
          if (probe.ok && probe.headers.get('x-dsh-app-proxy') !== null) {
            return { app, src: web.path, mode: 'proxy', externalUrl: web.url }
          }
        } catch {
          // Fall through to the published origin.
        }
        return { app, src: web.url, mode: 'direct-fallback', externalUrl: web.url }
      }

      return { app, src: web.url, mode: 'direct', externalUrl: web.url }
    }

    function Viewer(props) {
      const app = props.app
      const password = app.viewer ? app.viewer.password : undefined
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
          props.mode === 'direct-fallback'
            ? h(
                'span',
                { className: 'dsha-sub' },
                'proxy route not mounted yet — using the published port',
              )
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
          props.externalUrl
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsha-btn',
                  onClick: () => window.open(props.externalUrl, '_blank', 'noopener'),
                },
                'New tab ↗',
              )
            : null,
        ),
        h('iframe', {
          className: props.mode === 'viewer' ? 'dsha-frame dsha-frame-vnc' : 'dsha-frame',
          src: props.src,
          title: app.name,
          allow: 'clipboard-read; clipboard-write',
        }),
      )
    }

    function ApplicationsPanel() {
      const [state, reload] = useApps()
      const [busy, setBusy] = React.useState(null)
      const [lastAction, setLastAction] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [view, setView] = React.useState(null)

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

      if (view !== null) return h(Viewer, view)

      return h(
        'div',
        { className: 'dsha-root' },
        h(
          'div',
          { className: 'dsha-head' },
          h('span', { className: 'dsha-title' }, 'Applications'),
          h(
            'span',
            { className: 'dsha-sub' },
            state.loading
              ? 'loading…'
              : `${apps.filter((a) => a.state === 'running').length} running of ${apps.length}`,
          ),
          h('span', { className: 'dsha-spacer' }),
          h('button', { type: 'button', className: 'dsha-btn', onClick: reload }, 'Refresh'),
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
          () => h(ApplicationsPanel),
        ),
      )
    }

    const inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
