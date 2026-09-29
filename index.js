import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

if (!existsSync('./node_modules/@whiskeysockets/baileys')) {
  console.log('[startup] Installing dependencies...')
  execFileSync('npm', ['install', '--omit=dev'], { stdio: 'inherit' })
}

await import('./app.js')
