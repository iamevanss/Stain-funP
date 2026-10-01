import makeWASocket, {
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} from '@whiskeysockets/baileys'
import P from 'pino'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionKey, sessionPath, getUser, getSessionEntry, upsertSession, setTriggers, deleteSessionStorage } from './store.js'
import { fancy, brand, bullets } from './style.js'

const logger = P({ level: process.env.LOG_LEVEL || 'silent' })
const sessions = new Map()
const startedAt = Date.now()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const cleanJid = jid => String(jid || '').replace(/:.*?(?=@)/, '')

// Browser tuple used when linking. Kept as-is because WhatsApp validates it during pairing.
const BROWSER = ['Ubuntu', 'Opera', '100.0.4815.0']
const READY_TIMEOUT = 20000
const RETRY_BASE = 3000
const RETRY_MAX = 30000
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const envText = name => String(process.env[name] ?? '').trim().replace(/^["']+|["']+$/g, '').trim()

// Startup message (sent on every bot start/reload for each session), then the owner contact card.
const startupCaption = () => `${brand}

${fancy('Connected successfully.')}

${bullets([fancy('Status: Paired'), fancy('Session: Active')])}

${fancy('Set your VVPRO triggers with:')}
${bullets(['{{.vv pr 👀,😂,🔥}}'].map(x => fancy(x)))}

${fancy('Contact Owner:')}`

async function startupContent() {
  const caption = startupCaption()
  const source = envText('STARTUP_IMAGE')
  if (!source) return { text: caption }
  try {
    if (/^https?:\/\//i.test(source)) return { image: { url: source }, caption }
    return { image: await fs.readFile(path.resolve(ROOT, source)), caption }
  } catch (e) {
    console.error('[startup image]', e.message)
    return { text: caption }
  }
}

function ownerCard() {
  const number = envText('OWNER_NUMBER').replace(/\D/g, '') || '2348132589873'
  const name = envText('OWNER_NAME') || 'Owner'
  const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL;type=VOICE;waid=${number}:+${number}\nEND:VCARD`
  return { contacts: { displayName: name, contacts: [{ vcard }] } }
}

async function sendStartup(session) {
  await dm(session, await startupContent())
  await dm(session, ownerCard())
}

const backoff = n => Math.min(RETRY_BASE * 2 ** Math.max(0, n - 1), RETRY_MAX)
const reasonName = code => Object.entries(DisconnectReason).find(([, value]) => value === code)?.[0] || 'unknown'

// Baileys ships a hard-coded WhatsApp Web version. When WhatsApp moves on, the server
// answers 405/428 and pairing dies before a code is issued. Fetch the current one instead.
let versionCache = null
async function waVersion() {
  if (versionCache && Date.now() - versionCache.at < 600000) return versionCache.version
  try {
    const { version } = await fetchLatestBaileysVersion()
    if (Array.isArray(version) && version.length === 3) {
      versionCache = { version, at: Date.now() }
      return version
    }
  } catch (e) {
    console.error('[version]', e.message)
  }
  return versionCache?.version
}

function unwrap(message) {
  let current = message
  for (let i = 0; i < 8 && current; i++) {
    if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message
    else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
    else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message
    else if (current.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message
    else break
  }
  return current
}

function mediaOf(message) {
  const x = unwrap(message)
  if (x?.imageMessage) return { type: 'image', message: x.imageMessage }
  if (x?.videoMessage) return { type: 'video', message: x.videoMessage }
  if (x?.audioMessage) return { type: 'audio', message: x.audioMessage }
  if (x?.stickerMessage) return { type: 'sticker', message: x.stickerMessage }
  return null
}

function quotedOf(message) {
  const x = unwrap(message)
  const context = x?.extendedTextMessage?.contextInfo || x?.imageMessage?.contextInfo || x?.videoMessage?.contextInfo || x?.audioMessage?.contextInfo || x?.stickerMessage?.contextInfo
  return context?.quotedMessage || null
}

function textOf(message) {
  const x = unwrap(message)
  return String(x?.conversation || x?.extendedTextMessage?.text || x?.imageMessage?.caption || x?.videoMessage?.caption || x?.documentMessage?.caption || '').trim()
}

async function mediaBuffer(media) {
  const stream = await downloadContentFromMessage(media.message, media.type)
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function mediaContent(media) {
  const buffer = await mediaBuffer(media)
  if (media.type === 'image') return { image: buffer, caption: media.message.caption || '' }
  if (media.type === 'video') return { video: buffer, caption: media.message.caption || '' }
  if (media.type === 'audio') return { audio: buffer, mimetype: media.message.mimetype || 'audio/mpeg' }
  return { sticker: buffer }
}

// PRIVATE + SILENT: only the paired account (the owner) can use the bot, and the bot never
// writes into the chat where a command was used. Every output goes to the owner's own DM.
const botSent = new Set()
const ownJid = session => cleanJid(session.sock?.user?.id)

async function dm(session, content) {
  const own = ownJid(session)
  if (!own || !session.sock) return
  try {
    const sent = await session.sock.sendMessage(own, content)
    const id = sent?.key?.id
    if (id) {
      botSent.add(id)
      if (botSent.size > 500) botSent.delete(botSent.values().next().value)
    }
  } catch (e) {
    console.error(`[dm ${session.key}]`, e.message)
  }
}

const report = (session, where, e) => dm(session, { text: `${fancy('Error in')} ${where}:\n${e?.message || e}` })

async function deliver(session, media, label) {
  try {
    await dm(session, await mediaContent(media))
  } catch (e) {
    await report(session, label, e)
  }
}

async function recover(session, quoted) {
  const media = mediaOf(quoted)
  if (!media) return report(session, '.vv', new Error(fancy('Reply to a view-once media message with {{.vv}}')))
  return deliver(session, media, '.vv')
}

async function handle(session, m) {
  if (!m.message || !m.key?.fromMe) return
  if (m.key.remoteJid === 'status@broadcast' || botSent.has(m.key.id)) return
  const body = textOf(m.message)
  if (!body) return
  const quoted = quotedOf(m.message)
  // Commands start with a dot; spaces don't matter: ".ping" and ". ping" both work.
  const dot = /^\.\s*([\s\S]*)$/.exec(body)
  const cmd = dot ? dot[1].trim() : ''
  const name = cmd.toLowerCase().replace(/\s+/g, ' ')
  if (name === 'vv') return recover(session, quoted)
  const pr = /^vv\s*pr(?:\s+([\s\S]*))?$/i.exec(cmd)
  if (pr) {
    const raw = (pr[1] || '').trim()
    const entry = await getSessionEntry(session.telegramId, session.phone)
    if (!raw) return dm(session, { text: entry?.triggers?.length ? `${fancy('VVPRO:')} ${entry.triggers.join(', ')}` : `${fancy('No VVPRO triggers set.')}\n${bullets([fancy('Use {{.vv pr 👀,😂,🔥}}')])}` })
    if (/^(off|clear)$/i.test(raw)) {
      await setTriggers(session.telegramId, session.phone, [])
      return dm(session, { text: fancy('VVPRO triggers cleared.') })
    }
    const triggers = [...new Set(raw.split(',').map(x => x.trim()).filter(Boolean))].slice(0, 20)
    await setTriggers(session.telegramId, session.phone, triggers)
    return dm(session, { text: `${fancy('VVPRO triggers saved:')}\n${triggers.join('  ')}` })
  }
  if (name === 'ping') return dm(session, { text: `${fancy('Pong:')} ${Date.now() - startedAt}ms` })
  if (name === 'uptime') {
    let s = Math.floor((Date.now() - startedAt) / 1000)
    const d = Math.floor(s / 86400); s %= 86400
    const h = Math.floor(s / 3600); s %= 3600
    const min = Math.floor(s / 60); s %= 60
    return dm(session, { text: `${brand} ${fancy('uptime:')} ${d}d ${h}h ${min}m ${s}s` })
  }
  if (name === 'menu') {
    const list = bullets([
      fancy('{{.vv}} - reply to view-once media, it lands in this DM'),
      fancy('{{.vv pr}} - set VVPRO emoji triggers'),
      fancy('{{.ping}} - check response'),
      fancy('{{.uptime}} - show uptime'),
      fancy('{{.menu}} - show this menu')
    ])
    return dm(session, { text: `${brand}\n${fancy('(private, silent)')}\n\n${list}\n\n${fancy('Emoji trigger: reply to view-once media with one of your VVPRO emojis.')}` })
  }
  if (!quoted) return
  const entry = await getSessionEntry(session.telegramId, session.phone)
  if (!entry?.triggers?.includes(body)) return
  const media = mediaOf(quoted)
  if (!media) return
  return deliver(session, media, 'VVPRO')
}

function dropSession(session) {
  clearTimeout(session.timer)
  if (sessions.get(session.key) === session) sessions.delete(session.key)
}

async function notify(session, info) {
  try {
    if (session.onDisconnected) await session.onDisconnected(session, info)
  } catch (e) {
    console.error(`[notify ${session.key}]`, e.message)
  }
}

function scheduleReconnect(session, delay) {
  clearTimeout(session.timer)
  session.timer = setTimeout(async () => {
    if (session.stopped || sessions.get(session.key) !== session) return
    try {
      await connect(session)
    } catch (e) {
      console.error(`[reconnect ${session.key}]`, e.message)
      session.retries += 1
      scheduleReconnect(session, backoff(session.retries))
    }
  }, delay)
}

async function connect(session) {
  const id = session.key
  const { telegramId, phone } = session
  const dir = sessionPath(telegramId, phone)
  await fs.mkdir(dir, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(dir)
  const version = await waVersion()

  let markReady = () => {}
  session.ready = new Promise(resolve => { markReady = resolve })
  session.markReady = markReady
  session.state = state
  session.connected = false

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    browser: BROWSER,
    printQRInTerminal: false,
    keepAliveIntervalMs: 10000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async () => ({ conversation: '' })
  })
  session.sock = sock

  sock.ev.on('creds.update', () => {
    Promise.resolve(saveCreds()).catch(e => console.error(`[creds ${id}]`, e.message))
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (session.sock !== sock || type !== 'notify') return
    for (const m of messages) {
      try { await handle(session, m) } catch (e) { console.error(`[message ${id}]`, e.message); await report(session, 'message handler', e) }
    }
  })

  sock.ev.on('connection.update', async update => {
    if (session.sock !== sock) return
    const { connection, lastDisconnect, qr } = update
    try {
      // A qr event means the handshake finished and WhatsApp accepts a pairing request.
      if (qr) markReady(true)

      if (connection === 'open') {
        session.connected = true
        session.retries = 0
        markReady(true)
        const own = cleanJid(sock.user?.id)
        const before = await getSessionEntry(telegramId, phone)
        const firstTime = !before?.paired
        await upsertSession(telegramId, phone, { paired: true })
        if (own && !session.greeted) {
          session.greeted = true // once per bot start; quiet reconnects don't repeat it
          try { await sendStartup(session) } catch (e) { console.error(`[startup ${id}]`, e.message) }
        }
        if (firstTime) {
          try { if (session.onConnected) await session.onConnected(session) } catch (e) { console.error(`[onConnected ${id}]`, e.message) }
        }
      }

      if (connection === 'close') {
        session.connected = false
        markReady(false)
        const code = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.data?.statusCode
        session.lastCode = code
        console.log(`[wa ${id}] closed: ${code ?? 'no code'} (${reasonName(code)})`)
        if (session.stopped) return

        const registered = Boolean(state.creds.registered)
        const info = {
          code,
          registered,
          codeIssued: Boolean(session.codeIssued),
          loggedOut: code === DisconnectReason.loggedOut,
          replaced: code === DisconnectReason.connectionReplaced
        }

        if (info.loggedOut) {
          // Stale credentials must go, otherwise every later /pair is rejected as "already paired".
          dropSession(session)
          await deleteSessionStorage(telegramId, phone).catch(e => console.error(`[cleanup ${id}]`, e.message))
          await notify(session, info)
          return
        }
        if (info.replaced) {
          dropSession(session)
          await notify(session, info)
          return
        }
        if (code === DisconnectReason.restartRequired) {
          // Normal right after a successful link: reconnect with the freshly saved credentials.
          scheduleReconnect(session, 500)
          return
        }
        if (registered) {
          session.retries += 1
          scheduleReconnect(session, backoff(session.retries))
          return
        }
        // Unpaired socket that timed out, expired or was refused: never loop on it.
        dropSession(session)
        await deleteSessionStorage(telegramId, phone).catch(() => {})
        await notify(session, info)
      }
    } catch (e) {
      console.error(`[connection ${id}]`, e.message)
    }
  })

  return sock
}

export async function createSession(telegramId, phone, options = {}) {
  const tg = String(telegramId)
  const number = String(phone).replace(/\D/g, '')
  const key = sessionKey(tg, number)
  const existing = sessions.get(key)
  if (existing) return Object.assign(existing, options)
  const user = await getUser(tg)
  if (!user) throw new Error('Telegram user is not authorized.')
  const raced = sessions.get(key)
  if (raced) return Object.assign(raced, options)
  const session = {
    key, telegramId: tg, phone: number, sock: null, state: null, connected: false, stopped: false,
    retries: 0, codeIssued: false, greeted: false, ready: null, markReady: null, timer: null, lastCode: undefined,
    ...options
  }
  sessions.set(key, session)
  try {
    await connect(session)
  } catch (e) {
    dropSession(session)
    throw e
  }
  return session
}

export async function requestPairingCode(telegramId, phone) {
  const number = String(phone).replace(/\D/g, '')
  if (number.length < 8 || number.length > 15) throw new Error('Invalid phone number. Use digits with country code, e.g. 2348012345678.')
  const key = sessionKey(telegramId, number)
  const session = sessions.get(key) || await createSession(telegramId, number)
  if (session.state?.creds?.registered) throw new Error(`${number} already has saved credentials. Send /unpair ${number}, then /pair again.`)
  await Promise.race([session.ready, sleep(READY_TIMEOUT)])
  if (sessions.get(key) !== session || !session.sock) {
    throw new Error(`WhatsApp refused or dropped the connection (code ${session.lastCode ?? 'unknown'}).`)
  }
  try {
    const raw = await session.sock.requestPairingCode(number)
    session.codeIssued = true
    return raw?.match(/.{1,4}/g)?.join('-') || raw
  } catch (e) {
    throw new Error(`WhatsApp did not issue a code: ${e.message}`)
  }
}

export async function stopSession(telegramId, phone) {
  const key = sessionKey(telegramId, phone)
  const session = sessions.get(key)
  if (!session) return
  session.stopped = true
  clearTimeout(session.timer)
  if (session.markReady) session.markReady(false)
  sessions.delete(key)
  try { session.sock?.end(new Error('Stopped by owner')) } catch {}
}

export async function stopAllSessions(telegramId) {
  for (const session of getSessionsFor(telegramId)) await stopSession(session.telegramId, session.phone)
}

// Drops a pairing attempt that never finished and removes its half-written credentials.
export async function discardIfUnpaired(telegramId, phone) {
  const session = sessions.get(sessionKey(telegramId, phone))
  if (session && !session.state?.creds?.registered) {
    await stopSession(telegramId, phone)
    await deleteSessionStorage(telegramId, phone)
  }
}

export const getSession = (telegramId, phone) => sessions.get(sessionKey(telegramId, phone)) || null
export const getSessions = () => [...sessions.values()]
export const getSessionsFor = telegramId => getSessions().filter(s => s.telegramId === String(telegramId))
