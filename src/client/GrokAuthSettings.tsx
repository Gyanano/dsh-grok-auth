/**
 * Settings section for xAI Grok authentication through the shared Grok CLI
 * login state. Credentials never cross the dedicated plugin-owned Connection
 * RPC channel; a pending device-code login is described by its user code and
 * verification link alone.
 *
 * @module dsh-grok-auth/client/settings
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconRefreshOutline16, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GrokAuthRpcClient, GrokAuthStatusView, GrokUsageView } from '../rpc-contract.ts'
import type { GrokAuthKey } from './locales.ts'
import classes from './GrokAuthSettings.module.css'

/** Props injected by the client plugin's slot registration. */
export interface GrokAuthSettingsProps {
  /** Dedicated plugin-owned RPC face. */
  rpc: GrokAuthRpcClient
  /** Localized dictionary reader. */
  t: (key: GrokAuthKey) => string
  /** Subscribe to connection resets that invalidate the current view. */
  subscribe: (listener: () => void) => () => void
}

type LoadState = 'loading' | 'ready' | 'error'

/** Poll cadence while a device-code login awaits approval. */
const PENDING_LOGIN_POLL_MS = 3_000

/** The Grok Auth settings section: one login card over the shared Grok Login State. */
export function GrokAuthSettings({ rpc, t, subscribe }: GrokAuthSettingsProps): ReactNode {
  const [status, setStatus] = useState<GrokAuthStatusView | null>(null)
  const [usage, setUsage] = useState<GrokUsageView | null>(null)
  const [usageBusy, setUsageBusy] = useState(true)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const configuredRef = useRef(false)

  useEffect(() => subscribe(() => { setTick(value => value + 1) }), [subscribe])

  const load = useCallback(async () => {
    setLoadState(previous => previous === 'ready' ? previous : 'loading')
    setError(null)
    try {
      const result = await rpc.status()
      if (!result.ok) {
        setLoadState(previous => previous === 'ready' ? previous : 'error')
        setError(result.error.message || t('statusFailed'))
        return
      }
      configuredRef.current = result.value.status.configured
      setStatus(result.value.status)
      setLoadState('ready')
    } catch (cause) {
      setLoadState(previous => previous === 'ready' ? previous : 'error')
      setError(messageOf(cause, t('statusFailed')))
    }
  }, [rpc, t])

  const loadUsage = useCallback(async () => {
    setUsageBusy(true)
    try {
      const result = await rpc.usage()
      if (result.ok) setUsage(result.value.usage)
    } catch {
      /* usage facts are optional */
    } finally {
      setUsageBusy(false)
    }
  }, [rpc])

  useEffect(() => { void load(); void loadUsage() }, [load, loadUsage, tick])

  // While a device-code login is pending, poll status so approval lands
  // without a manual refresh; a completed login also re-reads usage.
  const pendingLogin = status?.pendingLogin
  useEffect(() => {
    if (pendingLogin === undefined) return
    const wasConfigured = configuredRef.current
    const timer = setInterval(() => {
      void (async () => {
        const result = await rpc.status().catch(() => null)
        if (result === null || !result.ok) return
        configuredRef.current = result.value.status.configured
        setStatus(result.value.status)
        if (!wasConfigured && result.value.status.configured) void loadUsage()
      })()
    }, PENDING_LOGIN_POLL_MS)
    return () => { clearInterval(timer) }
  }, [pendingLogin, rpc, loadUsage])

  const startLogin = useCallback(async (mode: 'browser' | 'device') => {
    setLoginBusy(true)
    setError(null)
    try {
      const result = await rpc.login(mode)
      if (!result.ok) {
        setError(result.error.message || t('loginFailed'))
        return
      }
      // A device login answers the code inline; re-read status so the pending
      // panel renders from the Host's authoritative view.
      await load()
    } catch (cause) {
      setError(messageOf(cause, t('loginFailed')))
    } finally {
      setLoginBusy(false)
    }
  }, [rpc, t, load])

  const state = stateOf(loadState, status)
  const stateLabel = stateText(loadState, status, t)

  return (
    <section className={classes.card}>
      <h2 className={classes.title}>{t('title')}</h2>
      <p className={classes.intro}>{t('intro')}</p>

      <div className={classes.statusSurface}>
        <div className={classes.statusHead}>
          <span className={classes.statusIdentity}>
            <StateDot state={state} />
            <span className={classes.statusLabel}>{stateLabel}</span>
          </span>
          {loadState === 'ready' && status?.configured === true
            ? <span className={classes.statusSummary}>{t('statusAvailable')}</span>
            : null}
        </div>
        {status === null ? null : (
          <dl className={classes.facts}>
            {status.email === undefined ? null : <Fact label={t('email')} value={status.email} />}
            {status.authMode === undefined ? null : <Fact label={t('authMode')} value={status.authMode} />}
            {status.grokVersion === undefined ? null : <Fact label={t('grokVersion')} value={status.grokVersion} />}
            {status.tokenExpiresAt === undefined ? null : <Fact label={t('tokenExpiresAt')} value={localDate(status.tokenExpiresAt)} />}
            {status.createdAt === undefined ? null : <Fact label={t('createdAt')} value={localDate(status.createdAt)} />}
            {status.configured ? <UsageFacts usage={usage} busy={usageBusy} t={t} /> : null}
            <Fact label={t('credentialRef')} value={status.credentialRef} />
          </dl>
        )}
      </div>

      {status?.pendingLogin === undefined ? null : (
        <div className={classes.deviceCode}>
          <h3 className={classes.deviceCodeTitle}>{t('deviceCodeTitle')}</h3>
          <p className={classes.deviceCodeIntro}>{t('deviceCodeIntro')}</p>
          <code className={classes.deviceCodeValue}>{status.pendingLogin.userCode}</code>
          <a
            className={classes.deviceCodeLink}
            href={status.pendingLogin.verificationUri}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t('deviceCodeOpen')}
          </a>
          <p className={classes.deviceCodeMeta}>
            {t('deviceCodeWaiting')}
            {' '}
            {t('deviceCodeExpires')}: {localDate(status.pendingLogin.expiresAt)}
          </p>
        </div>
      )}

      <div className={classes.actions}>
        <Button
          variant="primary"
          disabled={loginBusy || status?.available !== true}
          onClick={() => { void startLogin('browser') }}
        >
          {loginBusy ? t('startingLogin') : status?.configured === true ? t('relogin') : t('login')}
        </Button>
        <Button
          variant="outline"
          disabled={loginBusy}
          onClick={() => { void startLogin('device') }}
        >
          {t('deviceLogin')}
        </Button>
        <Button
          variant="ghost"
          className={classes.refresh}
          icon={<IconRefreshOutline16 size={16} />}
          disabled={loadState === 'loading'}
          onClick={() => { void load(); void loadUsage() }}
        >
          {loadState === 'loading' ? t('refreshing') : t('refresh')}
        </Button>
      </div>

      {error === null ? null : <p className={classes.error} role="alert">{error}</p>}
      {status?.lastLoginError === undefined || error !== null
        ? null
        : <p className={classes.error} role="alert">{status.lastLoginError}</p>}
      {status !== null && !status.available ? <p className={classes.hint}>{t('cliMissing')}</p> : null}
      {status?.available === true && !status.configured && status.pendingLogin === undefined
        ? <p className={classes.hint}>{t('loginHint')}</p>
        : null}
      <p className={classes.privacy}>{t('privacyNotice')}</p>
      <p className={classes.privacy}>{t('unofficialNotice')}</p>
    </section>
  )
}

function UsageFacts({ usage, busy, t }: {
  usage: GrokUsageView | null
  busy: boolean
  t: GrokAuthSettingsProps['t']
}): ReactNode {
  if (busy && usage === null) return <Fact label={t('quotaRemaining')} value={t('queryingQuota')} />
  if (usage === null) return null
  return (
    <>
      {usage.weeklyRemainingPercent === undefined
        ? null
        : <Fact label={t('quotaRemaining')} value={`${usage.weeklyRemainingPercent}%`} />}
      {usage.weeklyResetAt === undefined
        ? null
        : <Fact label={t('weeklyReset')} value={localDate(usage.weeklyResetAt)} />}
    </>
  )
}

function Fact({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className={classes.factRow}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function stateOf(loadState: LoadState, status: GrokAuthStatusView | null): StateDotState {
  if (loadState === 'loading') return 'ongoing'
  if (loadState === 'error' || status === null) return 'error'
  if (status.pendingLogin !== undefined) return 'ongoing'
  if (status.configured) return 'done'
  return 'warning'
}

function stateText(
  loadState: LoadState,
  status: GrokAuthStatusView | null,
  t: GrokAuthSettingsProps['t'],
): string {
  if (loadState === 'loading') return t('refreshing')
  if (loadState === 'error' || status === null) return t('statusFailed')
  if (status.pendingLogin !== undefined) return t('deviceCodeWaiting')
  if (status.configured) return t('loggedIn')
  return status.authFileExists ? t('loggedOut') : t('authFileMissing')
}

function localDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  const message = String(error)
  return message.length > 0 ? message : fallback
}
