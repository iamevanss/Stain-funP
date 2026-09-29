import 'dotenv/config'
import { initStore, listUsers } from './lib/store.js'
import { createSession } from './lib/whatsapp.js'
import './lib/telegram.js'

await initStore()

for (const user of await listUsers()) {
  if (!user.paired) continue
  try { await createSession(user.telegramId) }
  catch (error) { console.error(`[startup ${user.telegramId}]`, error.message) }
}

console.log('View Once started.')
