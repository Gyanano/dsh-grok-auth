/** Browser half of the Grok Auth bundle. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createGrokAuthRpcClient } from '../rpc-contract.ts'
import { GrokAuthSettings } from './GrokAuthSettings.tsx'
import type { GrokAuthSettingsProps } from './GrokAuthSettings.tsx'
import { en, zh, type GrokAuthKey } from './locales.ts'

export { GrokAuthSettings } from './GrokAuthSettings.tsx'
export type { GrokAuthSettingsProps } from './GrokAuthSettings.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy for the Grok Auth section. */
    'settings.grokAuth': GrokAuthKey
  }
}

const NS = 'settings.grokAuth'

/** Required browser services. */
export const inject = ['slots', 'locale', 'connection']

/** Register the Grok Auth settings section. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'grok-auth: copy dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const rpc = createGrokAuthRpcClient(connection.rpc)
  const t = ctx.locale.bind(NS) as GrokAuthSettingsProps['t']
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const reset = (): void => {
    for (const listener of listeners) listener()
  }
  ctx.effect(() => ctx.on('connection/reset', reset), 'grok-auth: connection invalidation')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'grok-auth',
    order: 21,
    label: () => t('nav'),
    inject: (): GrokAuthSettingsProps => ({ rpc, t, subscribe }),
  }, GrokAuthSettings))
}
