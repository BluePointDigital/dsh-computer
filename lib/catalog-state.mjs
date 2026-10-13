/** Seed once, never overwrite: operator catalog is data, not package content. */
import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { AppManager } from './app-manager.js'

export async function durableCatalog({ root, source = fileURLToPath(new URL('../apps.yaml', import.meta.url)), explicit = process.env.COMPUTER_APPS_FILE } = {}) {
  if (explicit) return path.resolve(explicit)
  const manager = new AppManager(root ? {root} : {})
  await manager.init()
  const destination = path.join(manager.root, 'catalog.yaml')
  const valid = async () => {
    try {
      const stat = await fs.lstat(destination)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('Unsafe durable application catalog')
      return true
    } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  }
  if (await valid()) return destination
  // Atomic no-clobber hard link permits concurrent seeding without recursively
  // taking the mutation lock when a legacy lookup runs inside an install.
  {
    if (await valid()) return destination
    const text = await fs.readFile(source, 'utf8')
    const temporary = destination + `.seed-${randomUUID()}`
    const file = await fs.open(temporary, 'wx', 0o600)
    try { await file.writeFile(text); await file.sync() } finally { await file.close() }
    try { await fs.link(temporary, destination) }
    catch(error) { if(error.code!=='EEXIST')throw error }
    finally { await fs.unlink(temporary) }
    await valid()
    const directory = await fs.open(manager.root, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
  return destination
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(await durableCatalog()) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
