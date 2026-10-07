import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = path.join(ROOT, 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
const DEFAULT = { users: {} }

// Layout on disk (local storage, nothing leaves this machine):
//   data/users.json                      -> users, premium flags, and their session list
//   data/sessions/<telegramId>/<phone>/  -> one WhatsApp auth folder PER paired number
//
// users.json shape:
//   { users: { "<telegramId>": { telegramId, premium, sessions: { "<phone>": { phone, paired, triggers, addedAt } } } } }

// All writes go through one queue so two updates can never race on the same temp file.
let chain = Promise.resolve()
function locked(task) {
  const run = chain.then(task)
  chain = run.catch(() => {})
  return run
}

async function writeStore(data) {
  const tmp = `${USERS_FILE}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, USERS_FILE)
}

const newUser = id => ({ telegramId: String(id), premium: false, sessions: {} })

function ensureUser(data, id) {
  const key = String(id)
  const user = data.users[key] = { ...newUser(key), ...(data.users[key] || {}) }
  if (!user.sessions || typeof user.sessions !== 'object') user.sessions = {}
  return user
}

const digits = value => String(value ?? '').replace(/\D/g, '')

// Older single-session data (one number per user) is upgraded in place, files included.
async function migrate() {
  await locked(async () => {
    const data = await readStore()
    let changed = false
    for (const user of Object.values(data.users)) {
      if (!user.sessions || typeof user.sessions !== 'object') { user.sessions = {}; changed = true }
      if (user.paired && user.phone) {
        const phone = digits(user.phone)
        const legacyDir = path.join(SESSIONS_DIR, String(user.telegramId))
        const newDir = path.join(legacyDir, phone)
        try {
          await fs.mkdir(newDir, { recursive: true })
          for (const entry of await fs.readdir(legacyDir, { withFileTypes: true })) {
            if (entry.isFile()) await fs.rename(path.join(legacyDir, entry.name), path.join(newDir, entry.name))
          }
        } catch (e) {
          console.error(`[migrate ${user.telegramId}]`, e.message)
        }
        user.sessions[phone] = { phone, paired: true, triggers: user.triggers || [], addedAt: Date.now() }
        changed = true
      }
      for (const legacy of ['paired', 'phone', 'triggers']) {
        if (legacy in user) { delete user[legacy]; changed = true }
      }
    }
    if (changed) await writeStore(data)
  })
}

export async function initStore() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true })
  try {
    await fs.access(USERS_FILE)
  } catch {
    await locked(() => writeStore(structuredClone(DEFAULT)))
  }
  await migrate()
}

export async function readStore() {
  let raw
  try {
    raw = await fs.readFile(USERS_FILE, 'utf8')
  } catch {
    return structuredClone(DEFAULT)
  }
  try {
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') throw new Error('bad shape')
    if (!data.users || typeof data.users !== 'object') data.users = {}
    return data
  } catch {
    // Keep a copy of a damaged file instead of silently overwriting every user.
    await fs.copyFile(USERS_FILE, `${USERS_FILE}.corrupt-${Date.now()}`).catch(() => {})
    return structuredClone(DEFAULT)
  }
}

// ---- users ----------------------------------------------------------------

export async function getUser(id) {
  const data = await readStore()
  const user = data.users[String(id)]
  return user ? ensureUser(data, id) : null
}

export async function listUsers() {
  const data = await readStore()
  return Object.keys(data.users).map(id => ensureUser(data, id))
}

export function updateUser(id, patch) {
  return locked(async () => {
    const data = await readStore()
    const user = ensureUser(data, id)
    Object.assign(user, patch)
    await writeStore(data)
    return user
  })
}

export const setPremium = (id, premium) => updateUser(id, { premium: Boolean(premium) })

// ---- sessions (many per user) ----------------------------------------------

export const sessionKey = (id, phone) => `${id}_${digits(phone)}`
export const sessionPath = (id, phone) => path.join(SESSIONS_DIR, String(id), digits(phone))

export async function getSessionEntry(id, phone) {
  return (await getUser(id))?.sessions?.[digits(phone)] || null
}

export function upsertSession(id, phone, patch = {}) {
  return locked(async () => {
    const data = await readStore()
    const user = ensureUser(data, id)
    const key = digits(phone)
    user.sessions[key] = { phone: key, paired: false, triggers: [], addedAt: Date.now(), ...(user.sessions[key] || {}), ...patch }
    await writeStore(data)
    return user.sessions[key]
  })
}

export const setTriggers = (id, phone, triggers) => upsertSession(id, phone, { triggers })
export const setStatusLike = (id, phone, enabled) => upsertSession(id, phone, { statusLike: Boolean(enabled) })
export const getStatusLike = async (id, phone) => Boolean((await getSessionEntry(id, phone))?.statusLike)

// Which Telegram user (if any) already has this WhatsApp number linked.
export async function findPhoneOwner(phone) {
  const key = digits(phone)
  for (const user of await listUsers()) {
    if (user.sessions[key]) return user.telegramId
  }
  return null
}

function removeEntry(id, phone) {
  return locked(async () => {
    const data = await readStore()
    const user = data.users[String(id)]
    if (!user?.sessions) return
    delete user.sessions[digits(phone)]
    await writeStore(data)
  })
}

export async function deleteSessionStorage(id, phone) {
  await fs.rm(sessionPath(id, phone), { recursive: true, force: true })
  await removeEntry(id, phone)
  await fs.rmdir(path.join(SESSIONS_DIR, String(id))).catch(() => {}) // only succeeds when empty
}

export async function deleteAllSessions(id) {
  await fs.rm(path.join(SESSIONS_DIR, String(id)), { recursive: true, force: true })
  await updateUser(id, { sessions: {} })
}
