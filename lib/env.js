// Must be the FIRST import of the app: loads .env before any other module reads process.env,
// and installs crash guards so one failed promise never kills every paired session.
import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(root, '.env') })

process.on('uncaughtException', e => console.error('[UNCAUGHT]', e))
process.on('unhandledRejection', e => console.error('[UNHANDLED]', e))
