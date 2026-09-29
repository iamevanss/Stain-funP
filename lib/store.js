import fs from 'node:fs/promises'
import path from 'node:path'

const DATA_DIR = path.resolve('data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
const DEFAULT = { users: {} }

export async function initStore() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true })
  try { await fs.access(USERS_FILE) } catch { await writeStore(DEFAULT) }
}

async function writeStore(data) {
  const tmp = `${USERS_FILE}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, USERS_FILE)
}

export async function readStore() {
  try {
    const data = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'))
    if (!data.users || typeof data.users !== 'object') data.users = {}
    return data
  } catch { return structuredClone(DEFAULT) }
}

export async function getUser(id) {
  const data = await readStore()
  return data.users[String(id)] || null
}

export async function listUsers() {
  return Object.values((await readStore()).users)
}

export async function updateUser(id, patch) {
  const data = await readStore()
  const key = String(id)
  data.users[key] = {
    telegramId: key, premium: false, phone: null, triggers: [], paired: false,
    ...(data.users[key] || {}), ...patch
  }
  await writeStore(data)
  return data.users[key]
}

export const setPremium = (id, premium) => updateUser(id, { premium: Boolean(premium) })
export const setPaired = (id, patch = {}) => updateUser(id, { paired: true, ...patch })
export const setTriggers = (id, triggers) => updateUser(id, { triggers })
export const sessionPath = id => path.join(SESSIONS_DIR, String(id))

export async function deleteSessionStorage(id) {
  await fs.rm(sessionPath(id), { recursive: true, force: true })
  await updateUser(id, { paired: false, phone: null, triggers: [] })
}
