import makeWASocket, { DisconnectReason, downloadContentFromMessage, makeCacheableSignalKeyStore, useMultiFileAuthState } from '@whiskeysockets/baileys'
import P from 'pino'
import fs from 'node:fs/promises'
import { sessionPath, getUser, setPaired, setTriggers } from './store.js'

const logger = P({ level: process.env.LOG_LEVEL || 'silent' })
const sessions = new Map()
const startedAt = Date.now()
const cleanJid = jid => String(jid || '').replace(/:.*?(?=@)/, '')

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
  if (x?.imageMessage) return { type:'image', message:x.imageMessage }
  if (x?.videoMessage) return { type:'video', message:x.videoMessage }
  if (x?.audioMessage) return { type:'audio', message:x.audioMessage }
  if (x?.stickerMessage) return { type:'sticker', message:x.stickerMessage }
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

async function sendMedia(sock, jid, media) {
  const buffer = await mediaBuffer(media)
  if (media.type === 'image') return sock.sendMessage(jid, { image:buffer, caption:media.message.caption || '' })
  if (media.type === 'video') return sock.sendMessage(jid, { video:buffer, caption:media.message.caption || '' })
  if (media.type === 'audio') return sock.sendMessage(jid, { audio:buffer, mimetype:media.message.mimetype || 'audio/mpeg' })
  return sock.sendMessage(jid, { sticker:buffer })
}

async function recover(sock, m) {
  const quoted = quotedOf(m.message)
  const media = mediaOf(quoted)
  if (!media) return sock.sendMessage(m.key.remoteJid, { text:'Reply to a view-once media message with .vv.' }, { quoted:m })
  const sender = cleanJid(m.key.participant || m.key.remoteJid)
  try {
    await sendMedia(sock, sender, media)
    if (sender !== cleanJid(m.key.remoteJid)) await sock.sendMessage(m.key.remoteJid, { text:'View-once media sent to your private chat.' }, { quoted:m })
  } catch (e) { await sock.sendMessage(m.key.remoteJid, { text:`VV failed: ${e.message}` }, { quoted:m }) }
}

async function handle(session, m) {
  if (!m.message || m.key?.fromMe) return
  const body = textOf(m.message), lower = body.toLowerCase(), quoted = quotedOf(m.message)
  const sock = session.sock
  if (lower === '.vv') return recover(sock, m)
  if (lower.startsWith('.vv pr')) {
    const raw = body.slice(6).trim(), user = await getUser(session.telegramId)
    if (!raw) return sock.sendMessage(m.key.remoteJid, { text:user?.triggers?.length ? `VVPRO: ${user.triggers.join(', ')}` : 'No VVPRO triggers set.\nUse .vv pr 👀,😂,🔥' }, { quoted:m })
    if (/^(off|clear)$/i.test(raw)) { await setTriggers(session.telegramId, []); return sock.sendMessage(m.key.remoteJid, { text:'VVPRO triggers cleared.' }, { quoted:m }) }
    const triggers = [...new Set(raw.split(',').map(x => x.trim()).filter(Boolean))].slice(0,20)
    await setTriggers(session.telegramId, triggers)
    return sock.sendMessage(m.key.remoteJid, { text:`VVPRO triggers saved:\n${triggers.join('  ')}` }, { quoted:m })
  }
  if (lower === '.ping') return sock.sendMessage(m.key.remoteJid, { text:`Pong: ${Date.now() - startedAt}ms` }, { quoted:m })
  if (lower === '.uptime') {
    let s = Math.floor((Date.now()-startedAt)/1000), d=Math.floor(s/86400); s%=86400; let h=Math.floor(s/3600); s%=3600; let min=Math.floor(s/60); s%=60
    return sock.sendMessage(m.key.remoteJid, { text:`View Once uptime: ${d}d ${h}h ${min}m ${s}s` }, { quoted:m })
  }
  if (lower === '.menu') return sock.sendMessage(m.key.remoteJid, { text:'VIEW ONCE\n\n.vv - recover replied view-once media\n.vv pr - set VVPRO emoji triggers\n.ping - check response\n.uptime - show uptime\n.menu - show this menu' }, { quoted:m })
  const user = await getUser(session.telegramId)
  if (quoted && body && user?.triggers?.includes(body)) {
    const media = mediaOf(quoted), sender = cleanJid(m.key.participant || m.key.remoteJid)
    if (!media) return
    try { await sendMedia(sock, sender, media); if (sender !== cleanJid(m.key.remoteJid)) await sock.sendMessage(m.key.remoteJid, { text:'View-once media sent to your private chat.' }, { quoted:m }) }
    catch (e) { await sock.sendMessage(m.key.remoteJid, { text:`VVPRO failed: ${e.message}` }, { quoted:m }) }
  }
}

export async function createSession(telegramId, options = {}) {
  const id = String(telegramId)
  if (sessions.has(id)) return sessions.get(id)
  const user = await getUser(id)
  if (!user) throw new Error('Telegram user is not authorized.')
  const dir = sessionPath(id)
  await fs.mkdir(dir, { recursive:true })
  const { state, saveCreds } = await useMultiFileAuthState(dir)
  const session = { telegramId:id, sock:null, connected:false, stopped:false, ...options }
  sessions.set(id, session)
  const sock = makeWASocket({ auth:{ creds:state.creds, keys:makeCacheableSignalKeyStore(state.keys, logger) }, logger, markOnlineOnConnect:false, syncFullHistory:false, browser:['View Once','Chrome','1.0.0'] })
  session.sock = sock
  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('messages.upsert', async ({ messages }) => { for (const m of messages) { try { await handle(session,m) } catch(e) { console.error(`[message ${id}]`,e.message) } } })
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      session.connected = true
      const own = cleanJid(sock.user?.id)
      await setPaired(id, { phone:own.split('@')[0] || user.phone })
      try { if (own) await sock.sendMessage(own, { text:'View Once connected successfully.\n\nStatus: Paired\nSession: Active\n\nSet your VVPRO triggers with:\n.vv pr 👀,😂,🔥' }) } catch {}
      if (options.onConnected) await options.onConnected(session)
    }
    if (connection === 'close') {
      session.connected=false; sessions.delete(id)
      const code = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.data?.statusCode
      const loggedOut = code === DisconnectReason.loggedOut
      if (options.onDisconnected) await options.onDisconnected(session,{ loggedOut, code })
      if (!loggedOut && !session.stopped) setTimeout(() => createSession(id, options).catch(e => console.error(`[reconnect ${id}]`,e.message)), 3000)
    }
  })
  return session
}

export async function requestPairingCode(id, phone) {
  const s=sessions.get(String(id)); if (!s?.sock) throw new Error('WhatsApp session is not ready.')
  const number=String(phone).replace(/\D/g,''); if (number.length<8 || number.length>15) throw new Error('Invalid phone number.')
  if (s.sock.authState?.creds?.registered) throw new Error('This session is already paired.')
  return s.sock.requestPairingCode(number)
}
export async function stopSession(id) { const s=sessions.get(String(id)); if (!s) return; s.stopped=true; try{s.sock?.end(new Error('Stopped by owner'))}catch{} sessions.delete(String(id)) }
export const getSession = id => sessions.get(String(id)) || null
export const getSessions = () => [...sessions.values()]
