import './env.js'
import TelegramBot from 'node-telegram-bot-api'
import { getUser, listUsers, setPremium, updateUser, deleteSessionStorage, deleteAllSessions, findPhoneOwner } from './store.js'
import { createSession, discardIfUnpaired, getSession, requestPairingCode, stopSession, stopAllSessions } from './whatsapp.js'
import { fancy, brand, bullets, BULLET } from './style.js'

const clean = value => String(value ?? '').trim().replace(/^["']+|["']+$/g, '').trim()
const TOKEN = clean(process.env.TELEGRAM_BOT_TOKEN)
const OWNER_ID = clean(process.env.TELEGRAM_OWNER_ID)
const PREMIUM_LIMIT = Math.max(1, parseInt(clean(process.env.PREMIUM_SESSION_LIMIT), 10) || 3)

function fatal(message) {
  console.error(`[FATAL] ${message}`)
  process.exit(1)
}
if (!TOKEN) fatal('TELEGRAM_BOT_TOKEN is missing (set it in .env or the panel variables).')
if (!/^\d+$/.test(OWNER_ID)) fatal('TELEGRAM_OWNER_ID must be your numeric Telegram ID (digits only).')

export const telegram = new TelegramBot(TOKEN, { polling: true })

const PAIR_WINDOW = 300000
const waiting = new Map()
const busy = new Set()
const isOwner = id => String(id) === OWNER_ID
const authorized = async id => isOwner(id) || Boolean((await getUser(id))?.premium)
const isPrivate = msg => msg.chat?.type === 'private'

// Owner: unlimited WhatsApp sessions. Premium users: PREMIUM_LIMIT (3 by default).
const limitOf = id => (isOwner(id) ? Infinity : PREMIUM_LIMIT)
const slotText = (id, used) => `${used} / ${isOwner(id) ? '∞' : PREMIUM_LIMIT}`
const sessionsOf = user => Object.values(user?.sessions || {})
const statusOf = (id, phone) => (getSession(id, phone)?.connected ? 'connected' : 'offline')
const lineOf = (id, s) => `${BULLET} ${s.phone} - ${fancy(statusOf(id, s.phone))}`

const send = (chatId, text, options) =>
  telegram.sendMessage(chatId, text, options).catch(e => { console.error('[telegram send]', e.message) })
const deny = id => send(id, fancy('Access denied. Your Telegram ID is not authorized.'))

// Every handler is wrapped so a thrown error becomes a message instead of a process crash.
const guard = handler => async (msg, match) => {
  try {
    await handler(msg, match)
  } catch (e) {
    console.error('[telegram handler]', e)
    send(msg.chat.id, `${fancy('Error:')} ${e.message}`)
  }
}

const sessionOptions = (chatId, phone) => ({
  onConnected: () => send(chatId, `${brand}\n\n${fancy(`{{${phone}}} connected successfully.\n\nStatus: Paired\nSession: Active\n\nSet your VVPRO triggers on that WhatsApp with:\n{{.vv pr 👀,😂,🔥}}`) }`),
  onDisconnected: (_session, info) => {
    if (info.loggedOut) return send(chatId, fancy(`{{${phone}}} was logged out and the session was cleared. Use {{/pair}} again.`))
    if (info.replaced) return send(chatId, fancy(`{{${phone}}} was replaced by another connection. Use {{/pair}} again.`))
    if (!info.registered && info.codeIssued) return send(chatId, fancy(`Pairing for {{${phone}}} was not completed (code {{${info.code ?? 'unknown'}}}). The code may have expired or been refused. Use {{/pair}} again.`))
  }
})

async function pair(chatId) {
  const id = String(chatId)
  if (!(await authorized(id))) return deny(chatId)
  const used = sessionsOf(await getUser(id)).length
  if (used >= limitOf(id)) {
    return send(chatId, fancy(`Session limit reached (${used} / ${PREMIUM_LIMIT}).\n\nRemove one with {{/unpair NUMBER}} to link another. See {{/sessions}}.`))
  }
  await updateUser(id, { telegramId: id })
  waiting.set(id, Date.now())
  return send(chatId, `${brand}\n\n${fancy(`Pairing - slots used: ${slotText(id, used)}\n\nSend the WhatsApp number with country code, digits only.\nExample: {{2348012345678}}`) }`)
}

telegram.onText(/^\/(?:start|help)(?:@\w+)?$/, guard(async msg => {
  if (!isPrivate(msg)) return
  if (!(await authorized(msg.chat.id))) return deny(msg.chat.id)
  const id = String(msg.chat.id)
  const lines = isOwner(id)
    ? ['{{/pair}} - link a WhatsApp number (unlimited)', '{{/sessions}} - list all sessions', '{{/unpair NUMBER}} - remove one of your numbers', '{{/addpremium ID}} - give premium', '{{/delpremium ID}} - remove premium', '{{/premium}} - list premium users', '{{/clearsession ID [NUMBER]}} - clear a user\'s session(s)']
    : [`{{/pair}} - link a WhatsApp number (up to ${PREMIUM_LIMIT})`, '{{/sessions}} - list your linked numbers', '{{/unpair NUMBER}} - remove one number']
  await send(msg.chat.id, `${brand}\n\n${bullets(lines.map(x => fancy(x)))}`)
}))

telegram.onText(/^\/pair(?:@\w+)?$/, guard(async msg => {
  if (!isPrivate(msg)) return send(msg.chat.id, fancy('Please use {{/pair}} in a private chat with the bot.'))
  await pair(msg.chat.id)
}))

telegram.onText(/^\/unpair(?:@\w+)?(?:\s+(\S+))?$/, guard(async (msg, m) => {
  if (!isPrivate(msg)) return
  const id = String(msg.chat.id)
  if (!(await authorized(id))) return deny(msg.chat.id)
  waiting.delete(id)
  const list = sessionsOf(await getUser(id))
  if (!list.length) return send(msg.chat.id, fancy('You have no linked WhatsApp numbers.'))
  let phone = (m[1] || '').replace(/\D/g, '')
  if (!phone && list.length === 1) phone = list[0].phone
  if (!phone) {
    return send(msg.chat.id, `${fancy('Which number? Send {{/unpair NUMBER}}.')}\n\n${list.map(s => lineOf(id, s)).join('\n')}`)
  }
  if (!list.some(s => s.phone === phone)) return send(msg.chat.id, fancy(`{{${phone}}} is not linked to your account.`))
  await stopSession(id, phone)
  await deleteSessionStorage(id, phone)
  await send(msg.chat.id, fancy(`{{${phone}}} was removed. Send {{/pair}} to link again.`))
}))

telegram.on('message', guard(async msg => {
  if (!isPrivate(msg)) return
  const id = String(msg.chat.id)
  if (!waiting.has(id) || !msg.text || msg.text.startsWith('/')) return
  if (!(await authorized(id))) return deny(msg.chat.id)
  if (Date.now() - waiting.get(id) > PAIR_WINDOW) {
    waiting.delete(id)
    return send(msg.chat.id, fancy('Pairing request expired. Use {{/pair}} again.'))
  }
  const number = msg.text.replace(/\D/g, '')
  if (number.startsWith('0')) return send(msg.chat.id, fancy('Use the international format with no leading 0 and no +.\nExample: {{2348012345678}}'))
  if (number.length < 8 || number.length > 15) return send(msg.chat.id, fancy('Invalid number. Send digits only with country code.\nExample: {{2348012345678}}'))
  if (busy.has(id)) return

  const used = sessionsOf(await getUser(id)).length
  if (used >= limitOf(id)) {
    waiting.delete(id)
    return send(msg.chat.id, fancy(`Session limit reached (${used} / ${PREMIUM_LIMIT}). Use {{/unpair NUMBER}} first.`))
  }
  const holder = await findPhoneOwner(number)
  if (holder === id) {
    waiting.delete(id)
    return send(msg.chat.id, fancy(`{{${number}}} is already linked to your account (${statusOf(id, number)}). Wait a minute for it to reconnect, or use {{/unpair ${number}}}.`))
  }
  if (holder) {
    waiting.delete(id)
    return send(msg.chat.id, fancy(`{{${number}}} is already linked by another user.`))
  }
  if (getSession(id, number)) {
    waiting.delete(id)
    return send(msg.chat.id, fancy(`A pairing for {{${number}}} is already in progress.`))
  }

  busy.add(id)
  waiting.delete(id)
  try {
    await send(msg.chat.id, fancy('Requesting your pairing code...'))
    await updateUser(id, { telegramId: id })
    await createSession(id, number, sessionOptions(msg.chat.id, number))
    const code = await requestPairingCode(id, number)
    await send(
      msg.chat.id,
      `${brand}\n\n${fancy(`Pairing code for {{${number}}}:`)}\n\n<code>${code}</code>\n\n${fancy('On WhatsApp open Settings → Linked devices → Link a device → Link with phone number instead, then enter this code.')}`,
      { parse_mode: 'HTML' }
    )
  } catch (e) {
    await discardIfUnpaired(id, number).catch(() => {})
    await send(msg.chat.id, `${fancy('Pairing failed:')} ${e.message}\n\n${fancy('Send {{/pair}} to try again.')}`)
  } finally {
    busy.delete(id)
  }
}))

telegram.onText(/^\/sessions(?:@\w+)?$/, guard(async msg => {
  if (!isPrivate(msg)) return
  const id = String(msg.chat.id)
  if (!(await authorized(id))) return deny(msg.chat.id)
  if (isOwner(id)) {
    const users = (await listUsers()).filter(u => sessionsOf(u).length)
    const blocks = users.map(u => `${u.telegramId}${isOwner(u.telegramId) ? ` (${fancy('owner')})` : ''}\n${sessionsOf(u).map(s => lineOf(u.telegramId, s)).join('\n')}`)
    return send(msg.chat.id, blocks.length ? `${fancy('Sessions:')}\n\n${blocks.join('\n\n')}` : fancy('No paired sessions.'))
  }
  const list = sessionsOf(await getUser(id))
  await send(msg.chat.id, `${fancy(`Your sessions (${slotText(id, list.length)}):`)}\n\n${list.length ? list.map(s => lineOf(id, s)).join('\n') : fancy('None yet. Use {{/pair}}.')}`)
}))

telegram.onText(/^\/addpremium(?:@\w+)?\s+(\d+)$/, guard(async (msg, m) => {
  if (!isOwner(msg.chat.id)) return deny(msg.chat.id)
  await updateUser(m[1], { telegramId: m[1], premium: true })
  await send(msg.chat.id, fancy(`Premium access added for {{${m[1]}}}. They can pair up to ${PREMIUM_LIMIT} WhatsApp numbers.`))
}))

telegram.onText(/^\/delpremium(?:@\w+)?\s+(\d+)$/, guard(async (msg, m) => {
  if (!isOwner(msg.chat.id)) return deny(msg.chat.id)
  // Without premium there is no access, so their WhatsApp sessions are shut down and wiped too.
  await stopAllSessions(m[1])
  await deleteAllSessions(m[1])
  await setPremium(m[1], false)
  await send(msg.chat.id, fancy(`Premium access removed for {{${m[1]}}}. Their WhatsApp sessions were cleared.`))
}))

telegram.onText(/^\/premium(?:@\w+)?$/, guard(async msg => {
  if (!isOwner(msg.chat.id)) return deny(msg.chat.id)
  const users = (await listUsers()).filter(u => u.premium)
  await send(msg.chat.id, users.length
    ? `${fancy('Premium users:')}\n\n${users.map(u => `${BULLET} ${u.telegramId} (${sessionsOf(u).length} / ${PREMIUM_LIMIT})`).join('\n')}`
    : fancy('No premium users.'))
}))

telegram.onText(/^\/clearsession(?:@\w+)?\s+(\d+)(?:\s+(\d+))?$/, guard(async (msg, m) => {
  if (!isOwner(msg.chat.id)) return deny(msg.chat.id)
  if (m[2]) {
    await stopSession(m[1], m[2])
    await deleteSessionStorage(m[1], m[2])
    return send(msg.chat.id, fancy(`Session {{${m[2]}}} cleared for {{${m[1]}}}.`))
  }
  await stopAllSessions(m[1])
  await deleteAllSessions(m[1])
  await send(msg.chat.id, fancy(`All sessions cleared for {{${m[1]}}}.`))
}))

// A 409 here means ANOTHER process is polling the same bot token. Telegram then splits
// updates between both, and pairing appears to be "rejected".
let lastPollingLog = 0
telegram.on('polling_error', e => {
  const now = Date.now()
  if (now - lastPollingLog < 30000) return
  lastPollingLog = now
  if (String(e.message).includes('409')) {
    console.error('[telegram] 409 Conflict: another process is using this same bot token. Give this bot its own token from @BotFather.')
  } else {
    console.error('[telegram]', e.message)
  }
})
