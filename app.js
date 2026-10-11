import './lib/env.js'
import { initStore, listUsers } from './lib/store.js'
import { createSession } from './lib/whatsapp.js'
import { brand } from './lib/style.js'
import { listTelegramAccountIds, restoreTelegramAccount } from './lib/telegram-user.js'
import './lib/telegram.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

await initStore()

// Multi-session: bring back EVERY saved WhatsApp number for EVERY user.
let restored = 0
for (const user of await listUsers()) {
  for (const entry of Object.values(user.sessions)) {
    if (!entry.paired) continue
    try {
      await createSession(user.telegramId, entry.phone)
      restored++
    } catch (error) {
      console.error(`[startup session ${user.telegramId}_${entry.phone}]`, error.message)
    }
    await sleep(500)
  }
}

let telegramRestored = 0
for (const id of await listTelegramAccountIds()) {
  if (await restoreTelegramAccount(id)) telegramRestored++
}

console.log(`${brand} started. Restored ${restored} WhatsApp session(s) and ${telegramRestored} Telegram account(s).`)
