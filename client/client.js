/**
 * dsh-git-plugin — browser half.
 *
 * Loaded by the DSH client module system: this file is the package's `./client`
 * export, the host serves it under `/plugins/dsh-git-plugin/client.js`, and
 * executing it registers one factory. The factory resolves `react` from the
 * shell's frozen platform table, so no bundler and no `dsh.client.external`
 * entry is needed.
 *
 * What it registers:
 *   1. `sidebar.panellist` — the sidebar icon that selects the page.
 *   2. `main` keyed by the same id — the page itself, which embeds the
 *      host-served app (`/dsh-git/`) in a same-origin iframe. All git work
 *      happens in the host plugin; this half only claims the seats.
 */
window.__ModuleLoader__.load({
  id: 'dsh-git-plugin',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** The id shared by the sidebar row and the main panel it opens. */
    const PANEL_ID = 'git'
    /** Locale namespace owned by this plugin. */
    const NS = 'dshGit'
    /** Where the host serves the app. */
    const APP_URL = '/dsh-git/'
    /**
     * The store the workspace shell persists the session shown in the main
     * panel under (`createSnapshotStore(..., { persist: { name } })`). Reading
     * it is how this half knows which workspace the user is actually in.
     */
    const CURRENT_SESSION_KEY = 'dsh.sessions.current'

    const DICTS = {
      zh: {
        panel: 'Git',
        title: 'Git 历史与操作',
        open: '在新标签页打开',
        hint: '若面板未渲染，请在新标签页打开。',
      },
      en: {
        panel: 'Git',
        title: 'Git history and operations',
        open: 'Open in a new tab',
        hint: 'If the panel does not render, open it in a new tab.',
      },
    }

    /**
     * The sidebar glyph: a branch with a commit on each end.
     * @param props - the sidebar's icon share (`size`).
     */
    function GitPanelIcon(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 20
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('circle', { cx: 6.5, cy: 5, r: 2.4 }),
        h('circle', { cx: 6.5, cy: 19, r: 2.4 }),
        h('circle', { cx: 17.5, cy: 8.5, r: 2.4 }),
        h('path', { d: 'M6.5 7.4v9.2' }),
        h('path', { d: 'M6.5 12.2c0-3.4 2.2-3.7 5-3.7h3.6' }),
      )
    }

    /**
     * The session the shell currently shows, read from the selection store the
     * workspace shell itself persists. Best effort by design: a missing,
     * unreadable or unexpected entry simply means "no session hint", and the
     * host then falls back to plain workspace detection.
     * @returns the session id, or '' when unknown.
     */
    function readCurrentSession() {
      try {
        const raw = window.localStorage.getItem(CURRENT_SESSION_KEY)
        if (raw === null) return ''
        const value = JSON.parse(raw)
        return typeof value?.sessionId === 'string' ? value.sessionId : ''
      } catch {
        return ''
      }
    }

    /**
     * The Git page: one same-origin iframe over the host's app.
     * The wrapper keeps a real height even where `height: 100%` cannot resolve.
     *
     * The current session id rides along as `?session=`, so the embedded app
     * opens the workspace that session belongs to. The shell rewrites the
     * selection on every navigation, so it is re-read on a timer and the iframe
     * is re-keyed only when the value actually changes.
     */
    function GitPage() {
      const [sessionId, setSessionId] = React.useState(readCurrentSession)
      React.useEffect(() => {
        const timer = window.setInterval(() => {
          const next = readCurrentSession()
          setSessionId((current) => (current === next ? current : next))
        }, 1500)
        return () => window.clearInterval(timer)
      }, [])

      const query = sessionId === '' ? '' : `?session=${encodeURIComponent(sessionId)}`
      const embedUrl = `${APP_URL}${query}${query === '' ? '?' : '&'}embed=1`
      const tabUrl = `${APP_URL}${query}`

      return h(
        'div',
        {
          style: {
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: '70vh',
            width: '100%',
            overflow: 'hidden',
            background: 'var(--dsh-color-bg, transparent)',
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              padding: '6px 10px',
              fontSize: '12px',
              opacity: 0.72,
              borderBottom: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
            },
          },
          h('span', null, 'Git 历史与操作'),
          h(
            'a',
            { href: tabUrl, target: '_blank', rel: 'noreferrer', style: { color: 'inherit' } },
            '在新标签页打开 ↗',
          ),
        ),
        h('iframe', {
          key: embedUrl,
          src: embedUrl,
          title: 'Git',
          style: { flex: '1 1 auto', width: '100%', minHeight: 0, border: '0', background: 'transparent' },
        }),
      )
    }

    /**
     * Register the sidebar row and the panel it opens.
     * @param ctx - the browser plugin context (`inject` guarantees `slots`).
     */
    function apply(ctx) {
      // The locale service is not required for the seats to work, so a host
      // without it keeps a plain-label Git row instead of losing the plugin.
      let t = (key) => DICTS.zh[key] ?? key
      try {
        if (ctx.locale !== undefined && typeof ctx.locale.register === 'function' && typeof ctx.locale.bind === 'function') {
          ctx.effect(() => ctx.locale.register(NS, DICTS), 'dsh-git-plugin: dictionaries')
          t = ctx.locale.bind(NS)
        }
      } catch (error) {
        console.warn('[dsh-git-plugin] locale registration failed, using plain labels', error)
      }

      ctx.slots.inject('main', function* registerGitPage() {
        yield ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          },
          GitPage,
        )
      })

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 40,
            label: () => t('panel') ?? 'Git',
            locale: NS,
          },
          GitPanelIcon,
        ),
      )
    }

    return { name: 'dsh-git-plugin', inject: ['slots'], apply }
  },
})
