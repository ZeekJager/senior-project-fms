import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { currentSubscription, disablePush, enablePush, endpointKey, pushPermission, pushSupport, type PushSupport } from '@/lib/push'

// S-29 Notification settings (FMS-93): which alerts reach the user on which channel (GET /notifications/channels), and push
// for this browser (POST /notifications/push/subscriptions, /unsubscribe, /test).

export type Severity = 'critical' | 'high' | 'medium' | 'low'
export type Channel = 'in_app' | 'email' | 'sms' | 'push'

export interface Channels {
  rules: { severity: Severity; channels: Channel[] }[]
  email: { available: boolean; address: string }
  sms: { available: boolean; phone: string | null }
  push: { available: boolean; public_key: string | null; devices: number; device_keys: string[] }
}

export const channelKeys = { all: ['notifications', 'channels'] as const }

export function useChannels() {
  const { api } = useAuth()
  return useQuery({ queryKey: channelKeys.all, queryFn: () => api.request<Channels>('/notifications/channels') })
}

/**
 * Push in this browser: what the browser can do, whether the user blocked it, and whether this browser's
 * subscription is the signed-in user's (someone else may have turned it on here before).
 */
export type PushState = { kind: 'unsupported' | 'no-worker' | 'unavailable' | 'denied' | 'off' | 'on' }

export function usePushState(channels: Channels | undefined) {
  const support: PushSupport = pushSupport()
  return useQuery({
    queryKey: ['push-state', support, channels?.push.available, channels?.push.device_keys.join(',')],
    enabled: channels !== undefined,
    queryFn: async (): Promise<PushState> => {
      if (support !== 'supported') return { kind: support }
      if (!channels!.push.available) return { kind: 'unavailable' }
      if (pushPermission() === 'denied') return { kind: 'denied' }
      const subscription = await currentSubscription()
      if (!subscription) return { kind: 'off' }
      return { kind: channels!.push.device_keys.includes(await endpointKey(subscription.endpoint)) ? 'on' : 'off' }
    },
  })
}

export function usePushActions() {
  const { api } = useAuth()
  const client = useQueryClient()
  const refresh = () => client.invalidateQueries({ queryKey: channelKeys.all })
  return {
    enable: useMutation({ mutationFn: (publicKey: string) => enablePush(api, publicKey), onSettled: refresh }),
    disable: useMutation({ mutationFn: () => disablePush(api), onSettled: refresh }),
    test: useMutation({ mutationFn: () => api.request<{ devices: number; sent: number; failed: number }>('/notifications/push/test', { method: 'POST', json: {} }) }),
  }
}
