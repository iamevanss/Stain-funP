import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
process.chdir(root)

const required = ['@whiskeysockets/baileys', 'node-telegram-bot-api', 'pino', 'dotenv', 'wa-sticker-formatter']
const missing = required.some(name => !existsSync(path.join(root, 'node_modules', ...name.split('/'))))

if (missing) {
  console.log('[startup] Installing dependencies...')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env
  })
  if (result.error) {
    console.error('[FATAL] Could not start npm:', result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error('[FATAL] npm install failed. Check the log above (git must be installed for Baileys).')
    process.exit(result.status || 1)
  }
}

await import('./app.js')
