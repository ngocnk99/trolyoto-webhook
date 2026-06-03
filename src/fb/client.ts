import type { SendMessagePayload } from './types'

const FB_GRAPH_VERSION = 'v21.0'
const FB_API_BASE = `https://graph.facebook.com/${FB_GRAPH_VERSION}`

type SenderAction = 'typing_on' | 'typing_off' | 'mark_seen'

async function senderAction(
  recipientId: string,
  action: SenderAction,
  accessToken: string
): Promise<void> {
  const url = `${FB_API_BASE}/me/messages?access_token=${accessToken}`
  const body = JSON.stringify({
    recipient: { id: recipientId },
    sender_action: action
  })
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`[FB] senderAction ${action} error ${res.status}:`, text)
  }
}

export async function sendMessage(
  recipientId: string,
  message: SendMessagePayload['message'],
  accessToken: string
): Promise<void> {
  const body: SendMessagePayload = {
    recipient: { id: recipientId },
    messaging_type: 'RESPONSE',
    message
  }
  const url = `${FB_API_BASE}/me/messages?access_token=${accessToken}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`[FB] sendMessage error ${res.status}:`, text)
  }
}

export async function sendTypingOn(
  recipientId: string,
  token: string
): Promise<void> {
  await senderAction(recipientId, 'typing_on', token)
}

export async function markSeen(
  recipientId: string,
  token: string
): Promise<void> {
  await senderAction(recipientId, 'mark_seen', token)
}
