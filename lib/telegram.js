import './env.js'
import TelegramBot from 'node-telegram-bot-api'
import { getUser, listUsers, setPremium, updateUser, deleteSessionStorage, deleteAllSessions, findPhoneOwner } from './store.js'
import { createSession, discardIfUnpaired, getSession, requestPairingCode, stopSession, stopAllSessions } from './whatsapp.js'

const clean = value => String(value ?? '').trim().replace(/^[\"']+|[\"']+$/g, '').trim()
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

const send = (chatId, text, options = {}) =>
  telegram.sendMessage(chatId, text, options).catch(e => console.error('[telegram send]', e.message))

const edit = (chatId, messageId, text, options = {}) =>
  telegram.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options })
    .catch(e => console.error('[telegram edit]', e.message))

const answer = query => telegram.answerCallbackQuery(query.id).catch(() => {})
const deny = id => send(id, 'Access denied. Your Telegram ID is not authorized.')

const button = (text, callback_data, style = 'primary') => ({ text, callback_data, style })
const copyButton = (text, value, style = 'success') => ({ text, copy_text: { text: value }, style })

function keyboard(id) {
  const rows = [
    [button('Pair WhatsApp', 'pair', 'success'), button('My Sessions', 'sessions', 'primary')],
    [button('Unpair', 'unpair', 'danger'), button('Help', 'help', 'primary')]
  ]
  if (isOwner(id)) {
    rows.push([button('Add Premium', 'addpremium', 'success'), button('Remove Premium', 'delpremium', 'danger')])
    rows.push([button('Premium Users', 'premium', 'primary'), button('Clear Session', 'clearsession', 'danger')])
  }
  return { inline_keyboard: rows }
}

async function showMenu(chatId, messageId = null) {
  if (!(await authorized(chatId))) return deny(chatId)
  const text = 'Stain Fun Bot 🙀\n\nChoose an action:'
  const options = { reply_markup: keyboard(String(chatId)) }
  if (messageId) return edit(chatId, messageId, text, options)
  return send(chatId, text, options)
}

const sessionOptions = (chatId, phone) => ({
  onConnected: () => {},
  onDisconnected: (_session, info) => {
    if (info.loggedOut) return send(chatId, `${phone} was logged out and the session was cleared. Tap Pair WhatsApp to link it again.`, { reply_markup: keyboard(chatId) })
    if (info.replaced) return send(chatId, `${phone} was replaced by another connection. Tap Pair WhatsApp to link it again.`, { reply_markup: keyboard(chatId) })
    if (!info.registered && info.codeIssued) return send(chatId, `Pairing for ${phone} was not completed. Tap Pair WhatsApp to try again.`, { reply_markup: keyboard(chatId) })
  }
})

async function pair(chatId, messageId) {
  const id = String(chatId)
  if (!(await authorized(id))) return deny(id)
  const used = sessionsOf(await getUser(id)).length
  if (used >= limitOf(id)) {
    return edit(chatId, messageId, `Session limit reached (${used} / ${isOwner(id) ? 'unlimited' : PREMIUM_LIMIT}).`, {
      reply_markup: keyboard(id)
    })
  }
  waiting.set(id, Date.now())
  inputMode.set(id, { mode: 'pair', messageId })
  return edit(chatId, messageId, 'Send the WhatsApp number with country code, digits only.\nExample: 2348012345678', {
    reply_markup: { inline_keyboard: [[button('Cancel', 'cancelinput', 'danger')]] }
  })
}

async function sessions(chatId, messageId) {
  const id = String(chatId)
  if (!(await authorized(id))) return deny(chatId)
  const list = sessionsOf(await getUser(id))
  if (!list.length) {
    return edit(chatId, messageId, 'No WhatsApp numbers are linked.', { reply_markup: {
      inline_keyboard: [[button('Back', 'home', 'primary')]]
    }})
  }
  const rows = list.map(s => [button(`${s.phone} - ${statusOf(id, s.phone)}`, `session:${s.phone}`, statusOf(id, s.phone) === 'connected' ? 'success' : 'primary')])
  rows.push([button('Back', 'home', 'primary')])
  return edit(chatId, messageId, 'Your WhatsApp sessions:', { reply_markup: { inline_keyboard: rows } })
}

async function unpairMenu(chatId, messageId) {
  const id = String(chatId)
  if (!(await authorized(id))) return deny(chatId)
  const list = sessionsOf(await getUser(id))
  if (!list.length) {
    return edit(chatId, messageId, 'No WhatsApp numbers are linked.', {
      reply_markup: { inline_keyboard: [[button('Back', 'home', 'primary')]] }
    })
  }
  const rows = list.map(s => [button(`Remove ${s.phone}`, `unpair:${s.phone}`, 'danger')])
  rows.push([button('Back', 'home', 'primary')])
  return edit(chatId, messageId, 'Choose a number to unpair:', { reply_markup: { inline_keyboard: rows } })
}

async function adminInput(chatId, messageId, mode, prompt) {
  inputMode.set(String(chatId), { mode, messageId })
  return edit(chatId, messageId, prompt, {
    reply_markup: { inline_keyboard: [[button('Cancel', 'cancelinput', 'danger')]] }
  })
}

telegram.on('callback_query', async query => {
  try {
    const id = String(query.from.id)
    const data = String(query.data || '')
    await answer(query)
    const messageId = query.message?.message_id
    if (!messageId) return

    if (data === 'cancelinput') {
      inputMode.delete(id)
      waiting.delete(id)
      return showMenu(id, messageId)
    }

    if (!(await authorized(id))) return deny(id)

    if (data === 'home' || data === 'help') return showMenu(id, messageId)
    if (data === 'pair') return pair(id, messageId)
    if (data === 'sessions') return sessions(id, messageId)
    if (data === 'unpair') return unpairMenu(id, messageId)

    if (data.startsWith('unpair:')) {
      const phone = data.slice(7).replace(/\D/g, '')
      const user = await getUser(id)
      if (!user?.sessions?.[phone]) return edit(id, messageId, 'That number is not linked.', { reply_markup: keyboard(id) })
      await stopSession(id, phone)
      await deleteSessionStorage(id, phone)
      return showMenu(id, messageId)
    }

    if (data.startsWith('session:')) {
      const phone = data.slice(8).replace(/\D/g, '')
      const entry = (await getUser(id))?.sessions?.[phone]
      if (!entry) return edit(id, messageId, 'Session not found.', { reply_markup: keyboard(id) })
      return edit(id, messageId,
        `Number: ${phone}\nStatus: ${statusOf(id, phone)}\nvv prefixes: ${entry.triggers?.length ? entry.triggers.join(', ') : 'none'}\nStatus saving: ${entry.statusLike ? 'on' : 'off'}`,
        { reply_markup: { inline_keyboard: [
          [button('Unpair this number', `unpair:${phone}`, 'danger')],
          [button('Back', 'sessions', 'primary')]
        ]}}
      )
    }

    if (data === 'addpremium') {
      if (!isOwner(id)) return deny(id)
      return adminInput(id, messageId, 'addpremium', 'Send the Telegram numeric ID to add as premium.')
    }

    if (data === 'delpremium') {
      if (!isOwner(id)) return deny(id)
      return adminInput(id, messageId, 'delpremium', 'Send the Telegram numeric ID to remove from premium.')
    }

    if (data === 'premium') {
      if (!isOwner(id)) return deny(id)
      const users = (await listUsers()).filter(u => u.premium)
      return edit(id, messageId,
        users.length ? `Premium users:\n\n${users.map(u => `- ${u.telegramId} (${sessionsOf(u).length} / ${PREMIUM_LIMIT})`).join('\n')}` : 'No premium users.',
        { reply_markup: { inline_keyboard: [[button('Back', 'home', 'primary')]] } }
      )
    }

    if (data === 'clearsession') {
      if (!isOwner(id)) return deny(id)
      return adminInput(id, messageId, 'clearsession', 'Send: TelegramID or TelegramID WhatsAppNumber')
    }
  } catch (e) {
    console.error('[telegram callback]', e)
    if (query.message?.chat?.id && query.message?.message_id) {
      await edit(query.message.chat.id, query.message.message_id, `Error: ${e.message}`, {
        reply_markup: { inline_keyboard: [[button('Back', 'home', 'primary')]] }
      })
    }
  }
})

telegram.on('message', async msg => {
  try {
    if (!isPrivate(msg) || !msg.text || msg.text.startsWith('/')) return
    const id = String(msg.chat.id)
    if (!(await authorized(id))) return deny(id)
    const state = inputMode.get(id)
    if (!state) return

    const messageId = state.messageId

    if (state.mode === 'pair') {
      if (Date.now() - (waiting.get(id) || 0) > PAIR_WINDOW) {
        waiting.delete(id)
        inputMode.delete(id)
        return edit(id, messageId, 'Pairing request expired. Tap Pair WhatsApp again.', { reply_markup: keyboard(id) })
      }

      const number = msg.text.replace(/\D/g, '')
      if (number.startsWith('0') || number.length < 8 || number.length > 15) {
        return edit(id, messageId, 'Invalid number. Use country code and digits only.\nExample: 2348012345678', {
          reply_markup: { inline_keyboard: [[button('Cancel', 'cancelinput', 'danger')]] }
        })
      }

      if (busy.has(id)) return
      const used = sessionsOf(await getUser(id)).length
      if (used >= limitOf(id)) {
        waiting.delete(id)
        inputMode.delete(id)
        return edit(id, messageId, 'Session limit reached.', { reply_markup: keyboard(id) })
      }

      const holder = await findPhoneOwner(number)
      if (holder && holder !== id) {
        waiting.delete(id)
        inputMode.delete(id)
        return edit(id, messageId, 'That WhatsApp number is already linked by another user.', { reply_markup: keyboard(id) })
      }

      busy.add(id)
      waiting.delete(id)
      inputMode.delete(id)

      try {
        await edit(id, messageId, 'Requesting your pairing code...')
        await updateUser(id, { telegramId: id })
        await createSession(id, number, sessionOptions(msg.chat.id, number))
        const code = await requestPairingCode(id, number)

        return edit(id, messageId,
          `WhatsApp number: ${number}\n\nYour pairing code is:\n${code}\n\nOpen WhatsApp -> Linked devices -> Link a device -> Link with phone number instead.`,
          { reply_markup: { inline_keyboard: [
            [copyButton(`Copy ${code}`, code, 'success')],
            [button('Back to menu', 'home', 'primary')]
          ]}}
        )
      } catch (e) {
        await discardIfUnpaired(id, number).catch(() => {})
        return edit(id, messageId, `Pairing failed: ${e.message}`, { reply_markup: keyboard(id) })
      } finally {
        busy.delete(id)
      }
    }

    if (state.mode === 'addpremium') {
      if (!isOwner(id)) return deny(id)
      const target = msg.text.replace(/\D/g, '')
      if (!target) return edit(id, messageId, 'Send a numeric Telegram ID.', { reply_markup: { inline_keyboard: [[button('Cancel', 'cancelinput', 'danger')]] } })
      await updateUser(target, { telegramId: target, premium: true })
      inputMode.delete(id)
      return showMenu(id, messageId)
    }

    if (state.mode === 'delpremium') {
      if (!isOwner(id)) return deny(id)
      const target = msg.text.replace(/\D/g, '')
      if (!target) return edit(id, messageId, 'Send a numeric Telegram ID.', { reply_markup: { inline_keyboard: [[button('Cancel', 'cancelinput', 'danger')]] } })
      await stopAllSessions(target)
      await deleteAllSessions(target)
      await setPremium(target, false)
      inputMode.delete(id)
      return showMenu(id, messageId)
    }

    if (state.mode === 'clearsession') {
      if (!isOwner(id)) return deny(id)
      const parts = msg.text.trim().split(/\s+/)
      const target = parts[0].replace(/\D/g, '')
      const phone = parts[1]?.replace(/\D/g, '')
      if (!target) return edit(id, messageId, 'Send a Telegram ID, optionally followed by a WhatsApp number.', {
        reply_markup: { inline_keyboard: [[button('Cancel', 'cancelinput', 'danger')]] }
      })

      if (phone) {
        await stopSession(target, phone)
        await deleteSessionStorage(target, phone)
      } else {
        await stopAllSessions(target)
        await deleteAllSessions(target)
      }
      inputMode.delete(id)
      return showMenu(id, messageId)
    }
  } catch (e) {
    console.error('[telegram message]', e)
    send(msg.chat.id, `Error: ${e.message}`)
  }
})

// /start is the only Telegram command. Every button action edits this message.
telegram.onText(/^\/start(?:@\w+)?$/, msg => {
  if (isPrivate(msg)) showMenu(msg.chat.id)
})

telegram.on('polling_error', e => {
  if (String(e.message).includes('409')) console.error('[telegram] 409 Conflict: another process is using this bot token.')
  else console.error('[telegram]', e.message)
})
