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
    /** The right-sidebar tab kind this package owns. */
    const SUMMARY_KIND = 'git-summary'
    /** Identity in the tab-type registry; must be unique across registrations. */
    const SUMMARY_ID = 'dsh-git-plugin/summary'

    const DICTS = {
      zh: {
        panel: 'Git',
        summary: 'Git',
        summaryHint: '在右侧边栏打开 Git',
      },
      en: {
        panel: 'Git',
        summary: 'Git',
        summaryHint: 'Open Git in the right sidebar',
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
     * The Git app, framed for one seat: a same-origin iframe over the host's
     * app. The wrapper keeps a real height even where `height: 100%` cannot
     * resolve.
     *
     * The current session id rides along as `?session=`, so the embedded app
     * opens the workspace that session belongs to. The shell rewrites the
     * selection on every navigation, so it is re-read on a timer and the iframe
     * is re-keyed only when the value actually changes.
     * @param props - `minHeight` (defaults to a panel-sized floor).
     */
    function GitAppFrame(props) {
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

      // No title bar of our own: the tab chip (right sidebar) or the sidebar
      // row (main panel) already names this, and the app has its own header.
      return h(
        'div',
        {
          style: {
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: props?.minHeight ?? '70vh',
            width: '100%',
            overflow: 'hidden',
            background: 'var(--dsh-color-bg, transparent)',
          },
        },
        h('iframe', {
          key: embedUrl,
          src: embedUrl,
          title: 'Git',
          style: { flex: '1 1 auto', width: '100%', minHeight: 0, border: '0', background: 'transparent' },
        }),
      )
    }

    /** The main-column Git page: the app frame at panel height. */
    function GitPage() {
      return h(GitAppFrame, {})
    }

    /**
     * The left sidebar's footer action that opens the right-sidebar window.
     * @param props - the sidebar seat share (`wide`), plus `copy` and `onOpen`.
     */
    function SummaryFooterButton(props) {
      const copy = typeof props?.copy === 'function' ? props.copy : (key) => key
      const wide = props?.wide !== false
      return h(
        'button',
        {
          type: 'button',
          title: copy('summaryHint'),
          onClick: () => {
            try {
              props?.onOpen?.()
            } catch (error) {
              console.warn('[dsh-git-plugin] 打开简要窗口失败', error)
            }
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: wide ? 'flex-start' : 'center',
            gap: '8px',
            width: '100%',
            height: '32px',
            padding: wide ? '0 8px' : '0',
            margin: '2px 0',
            background: 'transparent',
            border: 'none',
            borderRadius: '6px',
            color: 'inherit',
            font: 'inherit',
            fontSize: '12px',
            cursor: 'pointer',
            textAlign: 'left',
          },
        },
        h(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            style: { display: 'block', flex: 'none' },
          },
          h('path', { d: 'M4 6h16' }),
          h('path', { d: 'M4 12h10' }),
          h('path', { d: 'M4 18h13' }),
        ),
        wide ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, copy('summary')) : null,
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

      // The brief window lives in the RIGHT sidebar, which is a tab dock rather
      // than a plain slot: a package owns a page tab TYPE plus the body seat that
      // type renders into, and something opens it. Both services come from the
      // right-sidebar package, so a host without one simply skips this block.
      ctx.inject(['sidebarRightTabs', 'sidebarRight'], (sidebarCtx) => {
        sidebarCtx.effect(
          () =>
            sidebarCtx.sidebarRightTabs.register({
              id: SUMMARY_ID,
              kind: SUMMARY_KIND,
              title: () => t('summary'),
              // Without `guide` the type exists but nothing ever offers it: the
              // right sidebar's guide page is where a page type lists its entry
              // box, and the strip's add control opens that page.
              guide: [
                {
                  id: 'summary',
                  order: 60,
                  title: () => t('summary'),
                  description: () => t('summaryHint'),
                  icon: GitPanelIcon,
                },
              ],
            }),
          'dsh-git-plugin: summary tab type',
        )

        sidebarCtx.effect(
          () =>
            sidebarCtx.slots.inject('sidebar.right.pane.tab', () =>
              sidebarCtx.slots.register(
                { name: 'sidebar.right.pane.tab', key: SUMMARY_ID, locale: NS },
                // The same app the left sidebar embeds, so this window carries
                // the full toolbar, tabs, commit graph and operations instead of
                // a hand-built subset of them.
                (props) => h(GitAppFrame, { ...props, minHeight: 0 }),
              ),
            ),
          'dsh-git-plugin: summary tab body',
        )

        // The left sidebar's footer action opens it too — the guide entry above
        // is the discoverable path, this is the shortcut.
        sidebarCtx.slots.inject('sidebar.footer.action', () =>
          sidebarCtx.slots.register({ name: 'sidebar.footer.action', id: 'git-summary', order: 60, locale: NS }, (props) =>
            h(SummaryFooterButton, {
              ...props,
              copy: t,
              onOpen: () => sidebarCtx.sidebarRight.openTab(SUMMARY_KIND),
            }),
          ),
        )
      })
    }

    return { name: 'dsh-git-plugin', inject: ['slots'], apply }
  },
})
