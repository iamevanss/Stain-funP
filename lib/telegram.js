import './env.js'
import TelegramBot from 'node-telegram-bot-api'
import { getUser, listUsers, setPremium, updateUser, deleteSessionStorage, deleteAllSessions, findPhoneOwner } from './store.js'
import { createSession, discardIfUnpaired, getSession, requestPairingCode, stopSession, stopAllSessions } from './whatsapp.js'

const clean = value => String(value ?? '').trim().replace(/^["']+|["']+$/g, '').trim()
const TOKEN = clean(process.env.TELEGRAM_BOT_TOKEN)
const OWNER_ID = clean(process.env.TELEGRAM_OWNER_ID)
const PREMIUM_LIMIT = Math.max(1, parseInt(clean(process.env.PREMIUM_SESSION_LIMIT), 10) || 3)

if (!TOKEN) { console.error('[FATAL] TELEGRAM_BOT_TOKEN is missing.'); process.exit(1) }
if (!/^\d+$/.test(OWNER_ID)) { console.error('[FATAL] TELEGRAM_OWNER_ID must contain digits only.'); process.exit(1) }

export const telegram = new TelegramBot(TOKEN, { polling: true })

const PAIR_WINDOW = 300000
const waiting = new Map()
const busy = new Set()
const inputMode = new Map()

const isOwner = id => String(id) === OWNER_ID
const authorized = async id => isOwner(id) || Boolean((await getUser(id))?.premium)
const isPrivate = msg => msg.chat?.type === 'private'
const sessionsOf = user => Object.values(user?.sessions || {})
const limitOf = id => isOwner(id) ? Infinity : PREMIUM_LIMIT
const statusOf = (id, phone) => getSession(id, phone)?.connected ? 'connected' : 'offline'

const send = (chatId, text, options = {}) => telegram.sendMessage(chatId, text, options).catch(e => console.error('[telegram send]', e.message))
const answer = query => telegram.answerCallbackQuery(query.id).catch(() => {})
const deny = id => send(id, 'Access denied. Your Telegram ID is not authorized.')

function keyboard(id) {
  const rows = [
    [{ text: 'Pair WhatsApp', callback_data: 'pair' }, { text: 'My Sessions', callback_data: 'sessions' }],
    [{ text: 'Unpair', callback_data: 'unpair' }, { text: 'Help', callback_data: 'help' }]
  ]
  if (isOwner(id)) {
    rows.push([{ text: 'Add Premium', callback_data: 'addpremium' }, { text: 'Remove Premium', callback_data: 'delpremium' }])
    rows.push([{ text: 'Premium Users', callback_data: 'premium' }, { text: 'Clear Session', callback_data: 'clearsession' }])
  }
  return { inline_keyboard: rows }
}

async function showMenu(chatId) {
  if (!(await authorized(chatId))) return deny(chatId)
  return send(chatId, 'Stain Fun Bot\n\nChoose an action:', { reply_markup: keyboard(String(chatId)) })
}

const sessionOptions = (chatId, phone) => ({
  onConnected: () => send(chatId, `WhatsApp ${phone} connected successfully.\n\nStatus: Paired\nSession: Active\n\nSet your vv prefix on WhatsApp with:\n.vv pr 👀,😂,🔥`),
  onDisconnected: (_session, info) => {
    if (info.loggedOut) return send(chatId, `${phone} was logged out and the session was cleared. Tap Pair WhatsApp to link it again.`)
    if (info.replaced) return send(chatId, `${phone} was replaced by another connection. Tap Pair WhatsApp to link it again.`)
    if (!info.registered && info.codeIssued) return send(chatId, `Pairing for ${phone} was not completed. Tap Pair WhatsApp to try again.`)
  }
})

async function pair(chatId) {
  const id = String(chatId)
  if (!(await authorized(id))) return deny(id)
  const used = sessionsOf(await getUser(id)).length
  if (used >= limitOf(id)) return send(id, `Session limit reached (${used} / ${isOwner(id) ? 'unlimited' : PREMIUM_LIMIT}).`, { reply_markup: keyboard(id) })
  waiting.set(id, Date.now())
  inputMode.set(id, 'pair')
  return send(id, 'Send the WhatsApp number with country code, digits only.\nExample: 2348012345678', {
    reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancelinput' }]] }
  })
}

async function sessions(chatId) {
  const id = String(chatId)
  if (!(await authorized(id))) return deny(id)
  const list = sessionsOf(await getUser(id))
  if (!list.length) return send(id, 'No WhatsApp numbers are linked.', { reply_markup: keyboard(id) })
  const rows = list.map(s => [{ text: `${s.phone} - ${statusOf(id, s.phone)}`, callback_data: `session:${s.phone}` }])
  rows.push([{ text: 'Back', callback_data: 'home' }])
  return send(id, 'Your WhatsApp sessions:', { reply_markup: { inline_keyboard: rows } })
}

async function unpairMenu(chatId) {
  const id = String(chatId)
  if (!(await authorized(id))) return deny(id)
  const list = sessionsOf(await getUser(id))
  if (!list.length) return send(id, 'No WhatsApp numbers are linked.', { reply_markup: keyboard(id) })
  const rows = list.map(s => [{ text: `Remove ${s.phone}`, callback_data: `unpair:${s.phone}` }])
  rows.push([{ text: 'Back', callback_data: 'home' }])
  return send(id, 'Choose a number to unpair:', { reply_markup: { inline_keyboard: rows } })
}

async function adminInput(chatId, mode, prompt) {
  inputMode.set(String(chatId), mode)
  return send(chatId, prompt, { reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancelinput' }]] } })
}

telegram.on('callback_query', async query => {
  try {
    const id = String(query.from.id)
    const data = String(query.data || '')
    await answer(query)
    if (data === 'cancelinput') {
      inputMode.delete(id); waiting.delete(id)
      return showMenu(id)
    }
    if (!(await authorized(id))) return deny(id)
    if (data === 'home' || data === 'help') return showMenu(id)
    if (data === 'pair') return pair(id)
    if (data === 'sessions') return sessions(id)
    if (data === 'unpair') return unpairMenu(id)

    if (data.startsWith('unpair:')) {
      const phone = data.slice(7).replace(/\D/g, '')
      const user = await getUser(id)
      if (!user?.sessions?.[phone]) return send(id, 'That number is not linked.')
      await stopSession(id, phone); await deleteSessionStorage(id, phone)
      return send(id, `${phone} was removed.`, { reply_markup: keyboard(id) })
    }

    if (data.startsWith('session:')) {
      const phone = data.slice(8).replace(/\D/g, '')
      const entry = (await getUser(id))?.sessions?.[phone]
      if (!entry) return send(id, 'Session not found.', { reply_markup: keyboard(id) })
      return send(id, `Number: ${phone}\nStatus: ${statusOf(id, phone)}\nvv prefixes: ${entry.triggers?.length ? entry.triggers.join(', ') : 'none'}\nStatus saving: ${entry.statusLike ? 'on' : 'off'}`, {
        reply_markup: { inline_keyboard: [[{ text: 'Unpair this number', callback_data: `unpair:${phone}` }], [{ text: 'Back', callback_data: 'sessions' }]] }
      })
    }

    if (data === 'addpremium') {
      if (!isOwner(id)) return deny(id)
      return adminInput(id, 'addpremium', 'Send the Telegram numeric ID to add as premium.')
    }
    if (data === 'delpremium') {
      if (!isOwner(id)) return deny(id)
      return adminInput(id, 'delpremium', 'Send the Telegram numeric ID to remove from premium.')
    }
    if (data === 'premium') {
      if (!isOwner(id)) return deny(id)
      const users = (await listUsers()).filter(u => u.premium)
      return send(id, users.length ? `Premium users:\n\n${users.map(u => `- ${u.telegramId} (${sessionsOf(u).length} / ${PREMIUM_LIMIT})`).join('\n')}` : 'No premium users.', { reply_markup: keyboard(id) })
    }
    if (data === 'clearsession') {
      if (!isOwner(id)) return deny(id)
      return adminInput(id, 'clearsession', 'Send: TelegramID or TelegramID WhatsAppNumber')
    }
  } catch (e) {
    console.error('[telegram callback]', e)
    send(query.message?.chat?.id, `Error: ${e.message}`)
  }
})

telegram.on('message', async msg => {
  try {
    if (!isPrivate(msg) || !msg.text || msg.text.startsWith('/')) return
    const id = String(msg.chat.id)
    if (!(await authorized(id))) return deny(id)
    const mode = inputMode.get(id)

    if (mode === 'pair') {
      if (Date.now() - (waiting.get(id) || 0) > PAIR_WINDOW) {
        waiting.delete(id); inputMode.delete(id)
        return send(id, 'Pairing request expired. Tap Pair WhatsApp again.', { reply_markup: keyboard(id) })
      }
      const number = msg.text.replace(/\D/g, '')
      if (number.startsWith('0') || number.length < 8 || number.length > 15) return send(id, 'Invalid number. Use country code and digits only. Example: 2348012345678')
      if (busy.has(id)) return
      const used = sessionsOf(await getUser(id)).length
      if (used >= limitOf(id)) {
        waiting.delete(id); inputMode.delete(id)
        return send(id, 'Session limit reached.', { reply_markup: keyboard(id) })
      }
      const holder = await findPhoneOwner(number)
      if (holder && holder !== id) {
        waiting.delete(id); inputMode.delete(id)
        return send(id, 'That WhatsApp number is already linked by another user.', { reply_markup: keyboard(id) })
      }
      busy.add(id); waiting.delete(id); inputMode.delete(id)
      try {
        await send(id, 'Requesting your pairing code...')
        await updateUser(id, { telegramId: id })
        await createSession(id, number, sessionOptions(msg.chat.id, number))
        const code = await requestPairingCode(id, number)
        await send(id, `Pairing code for ${number}:\n\n${code}\n\nOn WhatsApp: Settings -> Linked devices -> Link a device -> Link with phone number instead, then enter the code.`, { reply_markup: keyboard(id) })
      } catch (e) {
        await discardIfUnpaired(id, number).catch(() => {})
        await send(id, `Pairing failed: ${e.message}`, { reply_markup: keyboard(id) })
      } finally {
        busy.delete(id)
      }
      return
    }

    if (mode === 'addpremium' || mode === 'delpremium') {
      if (!isOwner(id)) return deny(id)
      const target = msg.text.replace(/\D/g, '')
      if (!target) return send(id, 'Send a numeric Telegram ID.')
      if (mode === 'addpremium') {
        await updateUser(target, { telegramId: target, premium: true })
        inputMode.delete(id)
        return send(id, `Premium access added for ${target}.`, { reply_markup: keyboard(id) })
      }
      await stopAllSessions(target); await deleteAllSessions(target); await setPremium(target, false)
      inputMode.delete(id)
      return send(id, `Premium access removed for ${target} and their sessions were cleared.`, { reply_markup: keyboard(id) })
    }

    if (mode === 'clearsession') {
      if (!isOwner(id)) return deny(id)
      const parts = msg.text.trim().split(/\s+/)
      const target = parts[0].replace(/\D/g, '')
      const phone = parts[1]?.replace(/\D/g, '')
      if (!target) return send(id, 'Send a Telegram ID, optionally followed by a WhatsApp number.')
      if (phone) {
        await stopSession(target, phone); await deleteSessionStorage(target, phone)
        inputMode.delete(id)
        return send(id, `Session ${phone} cleared for ${target}.`, { reply_markup: keyboard(id) })
      }
      await stopAllSessions(target); await deleteAllSessions(target)
      inputMode.delete(id)
      return send(id, `All sessions cleared for ${target}.`, { reply_markup: keyboard(id) })
    }
  } catch (e) {
    console.error('[telegram message]', e)
    send(msg.chat.id, `Error: ${e.message}`)
  }
})

// /start is only the entry point. All bot actions are exposed through inline buttons.
telegram.onText(/^\/start(?:@\w+)?$/, msg => {
  if (isPrivate(msg)) showMenu(msg.chat.id)
})

telegram.on('polling_error', e => {
  if (String(e.message).includes('409')) console.error('[telegram] 409 Conflict: another process is using this bot token.')
  else console.error('[telegram]', e.message)
})
