import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const distDir = fileURLToPath(new URL('../dist/', import.meta.url))

const relativeSpecifier = /^\.{1,2}\//
const hasExtension = /\/?[^/]+\.[^/]+$/

const withJsExtension = specifier => {
  if (!relativeSpecifier.test(specifier) || hasExtension.test(specifier)) return specifier
  return `${specifier}.js`
}

const rewriteImports = source => {
  const rewrite = (_match, prefix, quote, specifier, suffix) =>
    `${prefix}${quote}${withJsExtension(specifier)}${suffix}`

  return source
    .replace(/(\bfrom\s+)(['"])(\.{1,2}\/[^'"]+)(\2)/g, rewrite)
    .replace(/(\bimport\s+)(['"])(\.{1,2}\/[^'"]+)(\2)/g, rewrite)
    .replace(/(\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)(\2\s*\))/g, rewrite)
}

async function rewriteFile(path) {
  const before = await readFile(path, 'utf8')
  const after = rewriteImports(before)
  if (after !== before) await writeFile(path, after)
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(path)
    } else if (entry.isFile() && path.endsWith('.js')) {
      await rewriteFile(path)
    }
  }
}

await walk(distDir)
