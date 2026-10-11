import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TelegramClient } from 'teleproto'
import { StringSession } from 'teleproto/sessions'
import { NewMessage } from 'teleproto/events'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA = path.join(ROOT, 'data', 'telegram-sessions')
const API_ID = Number(String(process.env.TELEGRAM_API_ID || '').trim())
const API_HASH = String(process.env.TELEGRAM_API_HASH || '').trim()
const clients = new Map()
const startedAt = Date.now()

const safeId = id => String(id).replace(/[^0-9]/g, '')
const sessionFile = id => path.join(DATA, safeId(id), 'session.txt')

export function telegramApiReady() {
  return Number.isInteger(API_ID) && API_ID > 0 && /^[a-f0-9]{20,}$/i.test(API_HASH)
}

async function readSession(id) {
  try { return await fs.readFile(sessionFile(id), 'utf8') } catch { return '' }
}

async function saveSession(id, session) {
  const file = sessionFile(id)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(file, session, { mode: 0o600 })
  await fs.chmod(file, 0o600).catch(() => {})
}

function attachHandlers(id, client) {
  client.addEventHandler(async event => {
    try {
      const message = event.message
      if (!message || message.out) return
      const text = String(message.message || '').trim()
      if (!text.startsWith('.')) return
      const command = text.split(/\s+/)[0].toLowerCase()
      if (command === '.ping') {
        await client.sendMessage(message.chatId || 'me', { message: 'Stain Fun Bot 🙀 - Telegram is online.' })
      } else if (command === '.uptime') {
        const seconds = Math.floor((Date.now() - startedAt) / 1000)
        const value = seconds < 60 ? seconds + 's' : seconds < 3600 ? Math.floor(seconds / 60) + 'm' : Math.floor(seconds / 3600) + 'h ' + Math.floor(seconds % 3600 / 60) + 'm'
        await client.sendMessage(message.chatId || 'me', { message: 'Stain Fun Bot 🙀 uptime: ' + value })
      } else if (command === '.menu') {
        await client.sendMessage(message.chatId || 'me', { message: 'Stain Fun Bot 🙀\nTelegram account connected.\nCommands: .ping, .uptime, .menu' })
      }
    } catch (error) {
      console.error('[telegram-user message]', error.message)
    }
  }, new NewMessage({ incoming: true }))
}

export async function connectTelegramAccount(ownerId, ask) {
  if (!telegramApiReady()) throw new Error('Telegram personal-account API is not configured. Add TELEGRAM_API_ID and TELEGRAM_API_HASH to .env.')
  const id = safeId(ownerId)
  if (!id) throw new Error('Invalid owner ID.')
  if (clients.has(id)) throw new Error('A Telegram account is already connected for this user.')
  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 5,
    autoReconnect: true,
    requestRetries: 3
  })
  clients.set(id, client)
  try {
    await client.start({
      phoneNumber: async () => String(await ask('phone')).trim(),
      phoneCode: async () => String(await ask('code')).trim(),
      password: async () => String(await ask('password')).trim(),
      onError: error => console.error('[telegram-user auth]', error?.message || error)
    })
    const me = await client.getMe()
    await saveSession(id, client.session.save())
    attachHandlers(id, client)
    return { username: me?.username || '', firstName: me?.firstName || 'Telegram account' }
  } catch (error) {
    clients.delete(id)
    await client.disconnect().catch(() => {})
    throw error
  }
}

export async function restoreTelegramAccount(ownerId) {
  const id = safeId(ownerId)
  if (!id || clients.has(id) || !telegramApiReady()) return false
  const saved = await readSession(id)
  if (!saved) return false
  const client = new TelegramClient(new StringSession(saved), API_ID, API_HASH, {
    connectionRetries: 5,
    autoReconnect: true,
    requestRetries: 3
  })
  try {
    await client.connect()
    await client.getMe()
    clients.set(id, client)
    attachHandlers(id, client)
    return true
  } catch (error) {
    console.error('[telegram-user restore]', id, error.message)
    await client.disconnect().catch(() => {})
    return false
  }
}

export function telegramAccountConnected(ownerId) {
  return clients.has(safeId(ownerId))
}

export async function disconnectTelegramAccount(ownerId) {
  const id = safeId(ownerId)
  const client = clients.get(id)
  if (client) {
    clients.delete(id)
    await client.disconnect().catch(() => {})
  }
  await fs.rm(path.dirname(sessionFile(id)), { recursive: true, force: true })
  return Boolean(client)
}

export async function listTelegramAccountIds() {
  await fs.mkdir(DATA, { recursive: true })
  const result = []
  for (const entry of await fs.readdir(DATA, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && await readSession(entry.name)) result.push(entry.name)
  }
  return result
}
