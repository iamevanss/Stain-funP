import TelegramBot from 'node-telegram-bot-api'
import { getUser, listUsers, setPremium, updateUser, deleteSessionStorage } from './store.js'
import { createSession, getSession, getSessions, requestPairingCode, stopSession } from './whatsapp.js'

const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim()
const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID || '').trim()
if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is missing in .env')
if (!OWNER_ID) throw new Error('TELEGRAM_OWNER_ID is missing in .env')

export const telegram = new TelegramBot(TOKEN, { polling: true })
const waiting = new Map()
const isOwner = id => String(id) === OWNER_ID
const authorized = async id => isOwner(id) || Boolean((await getUser(id))?.premium)
const deny = id => telegram.sendMessage(id, 'Access denied. Your Telegram ID is not authorized.')

async function pair(chatId) {
  const id = String(chatId)
  if (!(await authorized(id))) return deny(chatId)
  const existing = getSession(id)
  if (existing?.connected) return telegram.sendMessage(chatId, 'Your WhatsApp session is already connected.')
  await updateUser(id, { telegramId: id })
  await createSession(id, {
    onConnected: () => telegram.sendMessage(chatId, 'View Once connected successfully.\n\nStatus: Paired\nSession: Active\n\nSet your VVPRO triggers with:\n.vv pr 👀,😂,🔥'),
    onDisconnected: (_s, info) => info.loggedOut && telegram.sendMessage(chatId, 'WhatsApp was logged out. Use /pair again.')
  })
  waiting.set(id, Date.now())
  await telegram.sendMessage(chatId, 'View Once pairing\n\nSend your WhatsApp phone number with country code.\nExample: 2348012345678')
}

telegram.onText(/^\/start(?:@\w+)?$/, async msg => {
  if (!(await authorized(msg.chat.id))) return deny(msg.chat.id)
  telegram.sendMessage(msg.chat.id, 'VIEW ONCE\n\nUse /pair to connect your WhatsApp account.')
})

telegram.onText(/^\/pair(?:@\w+)?$/, msg => pair(msg.chat.id).catch(e => telegram.sendMessage(msg.chat.id, `Pairing error: ${e.message}`)))

telegram.on('message', async msg => {
  const id = String(msg.chat.id)
  if (!waiting.has(id) || !msg.text || msg.text.startsWith('/')) return
  if (!(await authorized(id))) return deny(msg.chat.id)
  if (Date.now() - waiting.get(id) > 300000) { waiting.delete(id); return telegram.sendMessage(msg.chat.id, 'Pairing request expired. Use /pair again.') }
  waiting.delete(id)
  try {
    const code = await requestPairingCode(id, msg.text)
    await telegram.sendMessage(msg.chat.id, `View Once pairing code:\n\n${code}\n\nEnter this code on WhatsApp.`)
  } catch (e) { await telegram.sendMessage(msg.chat.id, `Pairing failed: ${e.message}`) }
})

telegram.onText(/^\/addpremium(?:@\w+)?\s+(\d+)$/, async (msg, m) => {
  if (!isOwner(msg.chat.id)) return deny(msg.chat.id)
  await updateUser(m[1], { telegramId: m[1], premium: true })
  telegram.sendMessage(msg.chat.id, `Premium access added for ${m[1]}.`)
})

telegram.onText(/^\/delpremium(?:@\w+)?\s+(\d+)$/, async (msg, m) => {
  if (!isOwner(msg.chat.id)) return deny(msg.chat.id)
  await setPremium(m[1], false)
  telegram.sendMessage(msg.chat.id, `Premium access removed for ${m[1]}.`)
})

telegram.onText(/^\/premium(?:@\w+)?$/, async msg => {
  if (!isOwner(msg.chat.id)) return deny(msg.chat.id)
  const users = (await listUsers()).filter(u => u.premium)
  telegram.sendMessage(msg.chat.id, users.length ? `Premium users:\n\n${users.map(u => u.telegramId).join('\n')}` : 'No premium users.')
})

telegram.onText(/^\/sessions(?:@\w+)?$/, async msg => {
  if (!isOwner(msg.chat.id)) return deny(msg.chat.id)
  const users = await listUsers()
  const active = getSessions()
  const lines = users.filter(u => u.paired).map(u => `${u.telegramId} - ${active.some(s => s.telegramId === u.telegramId && s.connected) ? 'connected' : 'offline'}`)
  telegram.sendMessage(msg.chat.id, lines.length ? `Sessions:\n\n${lines.join('\n')}` : 'No paired sessions.')
})

telegram.onText(/^\/clearsession(?:@\w+)?\s+(\d+)$/, async (msg, m) => {
  if (!isOwner(msg.chat.id)) return deny(msg.chat.id)
  await stopSession(m[1]); await deleteSessionStorage(m[1])
  telegram.sendMessage(msg.chat.id, `Session cleared for ${m[1]}.`)
})

telegram.on('polling_error', e => console.error('[telegram]', e.message))
