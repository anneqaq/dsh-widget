/**
 * Package-level invariants for dsh-widget.
 *
 * These are the checks unit tests cannot see: the manifest fields the DSH
 * launcher and the plugin market read, the publication coverage of `files`,
 * and the display metadata that ships beside them. Each one fails loudly here
 * rather than at harness boot on a user's machine.
 *
 * Zero dependencies, `node:` builtins only, so CI needs no install step.
 *
 * Run with:
 *
 *   node scripts/check-package.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const readJson = (p) => JSON.parse(read(p))

let checks = 0
const check = (label, fn) => {
  try {
    fn()
    checks += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    console.error(`FAIL ${label}\n     ${error.message}`)
    process.exitCode = 1
  }
}

const pkg = readJson('package.json')

/** Expand the single-`*` globs `files` uses, so coverage can be asserted. */
function expand(pattern) {
  if (!pattern.includes('*')) return [pattern]
  const [head, tail] = pattern.split('*')
  const dir = head.endsWith('/') ? head.slice(0, -1) : dirname(head)
  if (!existsSync(join(root, dir))) return []
  return readdirSync(join(root, dir))
    .filter((name) => name.endsWith(tail.replace(/^\//, '')))
    .map((name) => (dir === '.' ? name : `${dir}/${name}`))
}

// ── manifest shape ───────────────────────────────────────────────────────────

check('manifest declares the bundle patch and the web client half', () => {
  assert.equal(pkg.dsh?.manifestVersion, 1, 'dsh.manifestVersion must be declared as 1')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(existsSync(join(root, 'cordis.patch.yml')), 'the declared patch file must exist')
})

check('the client half is reachable through exports', () => {
  assert.equal(pkg.exports?.['./client']?.default, './lib/client.js')
  assert.equal(pkg.exports?.['.']?.default, './lib/index.js')
  // `main` is written without the exports `./` prefix; compare normalized.
  assert.equal(`./${pkg.main}`, pkg.exports['.'].default, 'main and exports["."] must agree')
  for (const target of [pkg.main, pkg.exports['./client'].default]) {
    assert.ok(existsSync(join(root, target)), `${target} is exported but missing`)
  }
})

check('engines.dsh is a well-formed multi-clause range', () => {
  const range = pkg.engines?.dsh
  assert.ok(typeof range === 'string' && range.trim() !== '', 'engines.dsh must be declared')
  // Both comparators may carry a prerelease. The upper bound's matters as much
  // as the lower one's: `<0.3.0` admits `0.3.0-rc.1` under `includePrerelease`,
  // so an upper bound that has to stop *before* the next line says `<0.3.0-0`.
  for (const clause of range.split('||')) {
    assert.match(
      clause.trim(),
      /^>=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\s+<\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
      `unexpected clause ${JSON.stringify(clause.trim())}`,
    )
  }
  // The prerelease rule is the whole reason for the OR form: a bare first
  // clause silently rejects every later prerelease tuple.
  assert.ok(range.split('||').length > 1, 'a single clause cannot admit later prerelease tuples')
})

check('no host peer dependency is declared', () => {
  // This package imports nothing, so a peer declaration would add a
  // fail-closed install gate without adding a real requirement.
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(pkg[field], undefined, `${field} must stay absent: the package imports nothing`)
  }
})

// ── publication coverage ─────────────────────────────────────────────────────

check('every runtime artifact is published', () => {
  const published = new Set(pkg.files.flatMap(expand))
  const required = [
    'lib/index.js',
    'lib/client.js',
    'cordis.patch.yml',
    'README.md',
    'README.zh.md',
    'LICENSE',
    'icon.svg',
    'locale/en.json',
    'locale/zh.json',
  ]
  for (const file of required) {
    assert.ok(existsSync(join(root, file)), `${file} does not exist`)
    assert.ok(published.has(file), `${file} exists but is not covered by "files"`)
  }
})

check('nothing outside the allowlist is published', () => {
  const published = new Set(pkg.files.flatMap(expand))
  for (const file of published) {
    assert.ok(!file.startsWith('test/'), `${file} is test-only and must not ship`)
    assert.ok(!file.startsWith('scripts/'), `${file} is build-only and must not ship`)
  }
  assert.ok(!published.has('package.json'), 'package.json always ships; listing it is redundant')
})

// ── display metadata ─────────────────────────────────────────────────────────

check('locale files carry non-empty display text', () => {
  for (const lang of ['en', 'zh']) {
    const meta = readJson(`locale/${lang}.json`).meta
    for (const field of ['title', 'description']) {
      assert.equal(typeof meta?.[field], 'string', `locale/${lang}.json meta.${field} must be a string`)
      assert.ok(meta[field].trim() !== '', `locale/${lang}.json meta.${field} must not be empty`)
    }
  }
})

check('the icon is a self-contained SVG within the size limit', () => {
  assert.equal(pkg.icon, './icon.svg')
  const svg = read('icon.svg')
  assert.ok(/<svg[\s>]/.test(svg), 'icon.svg must contain an <svg> element')
  assert.ok(!/<(script|image|use)\b/i.test(svg), 'icon.svg must be self-contained')
  // The xmlns declaration is a namespace identifier, not a fetch; strip the
  // namespace attributes before looking for a genuinely remote reference.
  const withoutNamespaces = svg.replace(/\sxmlns(?::\w+)?="[^"]*"/g, '')
  const remote = withoutNamespaces.match(/https?:\/\/|url\(\s*['"]?(?:https?:)?\/\//i)
  assert.equal(remote, null, `icon.svg must not reference a remote resource (${remote?.[0]})`)
  const bytes = Buffer.byteLength(svg, 'utf8')
  assert.ok(bytes <= 256 * 1024, `icon.svg is ${bytes} bytes, over the 256 KiB limit`)
})

// ── the load-bearing design claim ────────────────────────────────────────────

check('the node half imports nothing', () => {
  const source = read('lib/index.js')
  assert.ok(!/^\s*import\s/m.test(source), 'lib/index.js must not use static import')
  assert.ok(!/\brequire\s*\(/.test(source), 'lib/index.js must not use require()')
})

check('the client half requires only platform modules', () => {
  const source = read('lib/client.js')
  const required = [...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
  for (const id of required) {
    assert.equal(id, 'react', `${id} is not a member of the shell's frozen platform module table`)
  }
})

// ── repo hygiene ─────────────────────────────────────────────────────────────

check('no absolute developer path leaked into a shipped file', () => {
  const shipped = pkg.files.flatMap(expand).filter((f) => !f.endsWith('.svg'))
  const pattern = /[A-Za-z]:[\\/](?:Users|code|AiLearn)[\\/]|\/(?:Users|home)\/[a-z0-9_-]+\//
  for (const file of shipped) {
    const text = read(file)
    const hit = text.match(pattern)
    assert.equal(hit, null, `${file} contains the absolute path ${hit?.[0]}`)
  }
})

if (process.exitCode !== 1) {
  console.log(`\n${checks} package checks passed`)
} else {
  console.error('\npackage checks failed')
}
