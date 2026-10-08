import makeWASocket, {
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  extractMessageContent,
  useMultiFileAuthState
} from '@whiskeysockets/baileys'
import P from 'pino'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import youtubedl from 'youtube-dl-exec'
import { fileURLToPath } from 'node:url'
import { sessionKey, sessionPath, getUser, getSessionEntry, upsertSession, setTriggers, setStatusLike, getStatusLike, deleteSessionStorage } from './store.js'
import { brand, bullets } from './style.js'
import { Sticker } from 'wa-sticker-formatter'

const logger = P({ level: process.env.LOG_LEVEL || 'silent' })
const sessions = new Map()
const mediaCache = new Map()
const statusCache = new Map()
const CACHE_LIMIT = 500
const startedAt = Date.now()

function cacheSet(map, key, value) {
  if (!key) return
  map.set(String(key), value)
  while (map.size > CACHE_LIMIT) map.delete(map.keys().next().value)
}

function isViewOnceMessage(message) {
  const raw = message?.message || message
  return Boolean(raw?.viewOnceMessage || raw?.viewOnceMessageV2 || raw?.viewOnceMessageV2Extension)
}

function reactionText(reaction) {
  return String(reaction?.text ?? reaction?.reaction?.text ?? reaction?.reaction ?? '').trim()
}

function isLikeReaction(text) {
  return ['❤️', '❤', '👍', 'LIKE', '♥️', '♥'].includes(String(text).trim().toUpperCase())
}
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

Connected successfully.

${bullets(['Status: Paired', 'Session: Active'])}

Set your vv prefix with:
${bullets(['.vv pr 👀,😂,🔥'])}

Contact Owner:`

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
  if (!message) return null
  try {
    const normalized = normalizeMessageContent(message)
    const extracted = extractMessageContent(normalized)
    if (extracted) return extracted
  } catch {}
  let current = message
  for (let i = 0; i < 8 && current; i++) {
    if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message
    else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
    else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message
    else if (current.viewOnceMessageV2Extension?.message) current = current.viewOnceMessageV2Extension.message
    else if (current.groupStatusMessage?.message) current = current.groupStatusMessage.message
    else if (current.groupStatusMessageV2?.message) current = current.groupStatusMessageV2.message
    else if (current.associatedChildMessage?.message) current = current.associatedChildMessage.message
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

const report = (session, where, e) => dm(session, { text: `Error in ${where}:\n${e?.message || e}` })

async function deliver(session, media, label) {
  try {
    await dm(session, await mediaContent(media))
  } catch (e) {
    await report(session, label, e)
  }
}

async function recover(session, quoted) {
  const media = mediaOf(quoted)
  if (!media) return report(session, '.vv', new Error('Reply to a view-once media message with .vv'))
  return deliver(session, media, '.vv')
}

const SOCIAL_URL = /https?:\/\/(?:www\.|m\.)?(?:tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com|instagram\.com)(?:\/[^\s]+)/i

function socialPlatform(url) {
  const value = String(url || '').toLowerCase()
  if (value.includes('tiktok.com')) return 'TikTok'
  if (value.includes('instagram.com')) return 'Instagram'
  return null
}

async function downloadSocial(url) {
  const platform = socialPlatform(url)
  if (!platform) throw new Error('Only public TikTok and Instagram links are supported.')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stain-social-'))
  const output = path.join(dir, '%(id)s.%(ext)s')
  try {
    await youtubedl(url, {
      output,
      format: 'best[ext=mp4][acodec!=none]/best[ext=mp4]/best',
      noPlaylist: true,
      noWarnings: true,
      noCallHome: true,
      noCheckCertificates: true,
      restrictFilenames: true,
      maxFilesize: '60M',
      socketTimeout: 30000,
      retries: 2
    })
    const files = await fs.readdir(dir)
    const mediaFile = files.find(name => /\.(mp4|m4v|webm|mov)$/i.test(name))
    if (!mediaFile) throw new Error('No downloadable video was returned.')
    const filePath = path.join(dir, mediaFile)
    const stat = await fs.stat(filePath)
    if (stat.size > 64 * 1024 * 1024) throw new Error('The video is too large to send through WhatsApp.')
    return { platform, filePath }
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw e
  }
}

async function handleSocialDownload(session, platform, url) {
  if (!url) return dm(session, { text: `Send a ${platform} link after the command.` })
  if (!SOCIAL_URL.test(url) || socialPlatform(url) !== platform) {
    return dm(session, { text: `That is not a valid public ${platform} link.` })
  }
  let download
  try {
    await dm(session, { text: `Downloading ${platform} video...` })
    download = await downloadSocial(url)
    const buffer = await fs.readFile(download.filePath)
    await dm(session, { video: buffer, mimetype: 'video/mp4', caption: `Downloaded from ${platform}` })
  } catch (e) {
    console.error(`[${platform.toLowerCase()} ${session.key}]`, e.message)
    await dm(session, { text: `${platform} download failed: ${e.message || 'unsupported or unavailable link.'}` })
  } finally {
    if (download?.filePath) await fs.rm(path.dirname(download.filePath), { recursive: true, force: true }).catch(() => {})
  }
}

async function stickerFromMedia(media, packName = 'Stain') {
  if (media.type !== 'image' && media.type !== 'video') throw new Error('Sticker needs an image or video.')
  const buffer = await mediaBuffer(media)
  const sticker = new Sticker(buffer, { pack: packName || 'Stain', author: '', type: 'default' })
  return sticker.toBuffer()
}

function cacheKeys(key) {
  const jid = String(key?.remoteJid || '')
  const id = String(key?.id || '')
  const alt = String(key?.remoteJidAlt || '')
  const participant = String(key?.participant || '')
  return [...new Set([
    id,
    id && jid ? `${jid}:${id}` : '',
    id && alt ? `${alt}:${id}` : '',
    id && participant ? `${participant}:${id}` : ''
  ].filter(Boolean))]
}

function findCached(map, key) {
  for (const cacheKey of cacheKeys(key)) {
    const hit = map.get(cacheKey)
    if (hit) return hit
  }
  return null
}

async function handleReaction(session, reactionEvent) {
  // Baileys has emitted reaction events in slightly different shapes across versions.
  // The target message is normally reactionEvent.key, while the reactor is reaction.key.
  // Keep fallbacks so the feature works with both shapes.
  const reaction = reactionEvent?.reaction || reactionEvent?.reactionMessage || reactionEvent
  const targetKey =
    reactionEvent?.key ||
    reaction?.messageKey ||
    reaction?.targetKey ||
    reaction?.key?.targetKey ||
    reaction?.key?.messageKey
  const reactorKey =
    reaction?.key ||
    reactionEvent?.senderKey ||
    reactionEvent?.reactorKey ||
    reactionEvent?.participantKey

  if (!targetKey || !reactorKey) return

  // Only the paired WhatsApp account (the owner) can trigger saving.
  const ownerJid = ownJid(session)
  const reactorJid = cleanJid(
    reactorKey?.participant ||
    reactorKey?.participantAlt ||
    reactorKey?.remoteJid
  )
  if (!ownerJid || reactorKey?.fromMe !== true || (reactorJid && reactorJid !== ownerJid)) return

  const text = reactionText(reaction)
  if (!text || !isLikeReaction(text)) return

  const remoteJid = String(targetKey.remoteJid || '')
  const isStatus = remoteJid === 'status@broadcast' || remoteJid.endsWith('@broadcast')

  if (isStatus) {
    if (!(await getStatusLike(session.telegramId, session.phone))) return

    const target = findCached(statusCache, targetKey)
    if (!target) {
      console.log(`[status reaction ${session.key}] target not cached: ${JSON.stringify(targetKey)}`)
      return
    }

    const media = mediaOf(target.message)
    if (!media) return
    return deliver(session, media, 'status like')
  }

  const target = findCached(mediaCache, targetKey)
  if (!target) {
    console.log(`[reaction ${session.key}] target not cached: ${JSON.stringify(targetKey)}`)
    return
  }

  // A heart/thumbs-up reaction from the paired account is the VV trigger.
  // It does not depend on the configured text prefixes.
  const media = mediaOf(target.message)
  if (!media) return
  return deliver(session, media, 'vv reaction')
}

async function handle(session, m) {
  if (!m.message) return

  // Cache view-once/status media from incoming messages first.
  // The paired account receives the media, while the later reaction is a fromMe event.
  if (m.key?.remoteJid === 'status@broadcast' || String(m.key?.remoteJid || '').endsWith('@broadcast')) {
    const media = mediaOf(m.message)
    if (media) for (const cacheKey of cacheKeys(m.key)) cacheSet(statusCache, cacheKey, m)
  } else if (isViewOnceMessage(m)) {
    for (const cacheKey of cacheKeys(m.key)) cacheSet(mediaCache, cacheKey, m)
  }

  // Reactions are emitted as messages.reaction on some Baileys versions and
  // as reactionMessage inside messages.upsert on others.
  const reactionMessage = unwrap(m.message)?.reactionMessage
  if (reactionMessage && m.key?.fromMe) {
    return handleReaction(session, {
      key: reactionMessage.key || m.key,
      reaction: { key: m.key, text: reactionMessage.text }
    })
  }

  if (!m.key?.fromMe || botSent.has(m.key.id)) return

  const body = textOf(m.message)
  if (!body) return
  const quoted = quotedOf(m.message)
  // Commands accept either no prefix ("vv", "sticker", "ping", etc.)
  // or a single dot (" .vv", ".sticker", ".ping", etc.). No other prefix is used.
  const dot = /^\.\s*([\s\S]*)$/.exec(body)
  const cmd = (dot ? dot[1] : body).trim()
  const name = cmd.toLowerCase().replace(/\s+/g, ' ')

  if (name === 'vv') return recover(session, quoted)

  const pr = /^vv\s*pr(?:\s+([\s\S]*))?$/i.exec(cmd)
  if (pr) {
    const raw = (pr[1] || '').trim()
    const entry = await getSessionEntry(session.telegramId, session.phone)
    if (!raw) {
      return dm(session, { text: entry?.triggers?.length ? `vv prefixes: ${entry.triggers.join(', ')}` : 'No vv prefixes set. Use .vv pr 👀,😂,🔥' })
    }
    if (/^(off|clear)$/i.test(raw)) {
      await setTriggers(session.telegramId, session.phone, [])
      return dm(session, { text: 'vv prefixes cleared.' })
    }
    const triggers = [...new Set(raw.split(',').map(x => x.trim()).filter(Boolean))].slice(0, 20)
    await setTriggers(session.telegramId, session.phone, triggers)
    return dm(session, { text: `vv prefixes saved: ${triggers.join('  ')}` })
  }

  const tt = /^(?:tiktok|tt)\s+(https?:\/\/\S+)$/i.exec(cmd)
  if (tt) return handleSocialDownload(session, 'TikTok', tt[1])

  const ig = /^(?:instagram|insta|ig)\s+(https?:\/\/\S+)$/i.exec(cmd)
  if (ig) return handleSocialDownload(session, 'Instagram', ig[1])
  if (name === 'sticker' || name.startsWith('sticker ')) {
    const packName = cmd.slice(7).trim()
    const source = quoted || m.message
    const media = mediaOf(source)
    if (!media || !['image', 'video'].includes(media.type)) return dm(session, { text: 'Reply to or send an image/video with .sticker.' })
    try {
      return dm(session, { sticker: await stickerFromMedia(media, packName || 'Stain') })
    } catch (e) {
      return report(session, '.sticker', e)
    }
  }

  if (name === 'st on') {
    await setStatusLike(session.telegramId, session.phone, true)
    return dm(session, { text: 'Status saving: on.' })
  }

  if (name === 'st off') {
    await setStatusLike(session.telegramId, session.phone, false)
    return dm(session, { text: 'Status saving: off.' })
  }

  if (name === 'ping') return dm(session, { text: `Pong: ${Date.now() - startedAt}ms` })

  if (name === 'uptime') {
    let s = Math.floor((Date.now() - startedAt) / 1000)
    const d = Math.floor(s / 86400); s %= 86400
    const h = Math.floor(s / 3600); s %= 3600
    const min = Math.floor(s / 60); s %= 60
    return dm(session, { text: `Stain Fun Bot uptime: ${d}d ${h}h ${min}m ${s}s` })
  }

  if (name === 'menu') {
    const list = bullets([
      '.vv - reply to view-once media and save it here',
      '.vv pr <emojis> - set your vv prefix',
      '.sticker - make a sticker from an image/video',
      '.tt <url> - download a TikTok video',
      '.ig <url> - download an Instagram video',
      '.st on - save liked statuses here',
      '.st off - disable status saving',
      '.ping - check response',
      '.uptime - show uptime',
      '.menu - show all commands'
    ])
    return dm(session, { text: `Stain Fun Bot\n\n${list}\n\nVV prefixes work anywhere in a sentence and as reactions to view-once media.` })
  }

  if (!quoted) return
  const entry = await getSessionEntry(session.telegramId, session.phone)
  if (!entry?.triggers?.some(trigger => body.includes(trigger))) return
  const media = mediaOf(quoted)
  if (!media) return
  return deliver(session, media, 'vv prefix')
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
      if ((m.key?.remoteJid === 'status@broadcast' || String(m.key?.remoteJid || '').endsWith('@broadcast')) && m.message) {
        const media = mediaOf(m.message)
        if (media) cacheSet(statusCache, m.key.id, m)
      }
      try { await handle(session, m) } catch (e) { console.error(`[message ${id}]`, e.message); await report(session, 'message handler', e) }
    }
  })

  sock.ev.on('messages.reaction', async reactions => {
    if (session.sock !== sock) return
    for (const reaction of reactions || []) {
      try { await handleReaction(session, reaction) }
      catch (e) { console.error(`[reaction ${id}]`, e.message) }
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
