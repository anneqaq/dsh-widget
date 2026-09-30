/**
 * Headless check of dsh-widget's pure client projections.
 *
 * These functions decide whether a card renders, renders live, or falls back —
 * and they read partially-streamed JSON, which is the easiest place in this
 * package to be silently wrong. Run with:
 *
 *   node --test test/client.test.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Load lib/client.js by standing in for the shell's module loader. */
function loadClientModule() {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  let registered = null
  const fakeRequire = (id) => {
    if (id === 'react') return { createElement: () => null }
    throw new Error(`unexpected require in test harness: ${id}`)
  }
  const window = { __ModuleLoader__: { load: (mod) => { registered = mod } } }
  // eslint-disable-next-line no-new-func
  new Function('window', 'navigator', source)(window, { language: 'en-US' })
  assert.ok(registered, 'client.js did not call window.__ModuleLoader__.load')
  assert.equal(registered.id, 'dsh-widget', 'bundle id must match the package name')
  return registered.factory(fakeRequire)
}

const mod = loadClientModule()
const { readWidget, normalize, extractClosedString, buildSrcDoc } = mod.__internals

test('plugin surface follows the function-form contract', () => {
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots'])
  assert.ok(!('default' in mod), 'function form must not also carry a default export')
})

test('extractClosedString reads a settled member', () => {
  assert.equal(extractClosedString('{"html":"<svg/>"}', 'html'), '<svg/>')
})

test('extractClosedString returns null while the value is still open', () => {
  assert.equal(extractClosedString('{"html":"<svg', 'html'), null)
  assert.equal(extractClosedString('{"html":', 'html'), null)
  assert.equal(extractClosedString('{"ht', 'html'), null)
})

test('extractClosedString does not stop at an escaped quote', () => {
  assert.equal(extractClosedString('{"html":"<b>\\"x\\"</b>"}', 'html'), '<b>"x"</b>')
})

test('extractClosedString decodes escapes rather than returning raw bytes', () => {
  assert.equal(extractClosedString('{"html":"a\\nb"}', 'html'), 'a\nb')
  assert.equal(extractClosedString('{"html":"<\\u003csvg\\u003e"}', 'html'), '<\\u003csvg\\u003e'.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>'))
})

test('extractClosedString preserves multibyte content', () => {
  assert.equal(extractClosedString('{"html":"<text>中文标签</text>"}', 'html'), '<text>中文标签</text>')
})

test('extractClosedString waits when an escape straddles a delta', () => {
  // The fragment ends mid-escape: a naive scan would mis-slice here.
  assert.equal(extractClosedString('{"html":"abc\\', 'html'), null)
  assert.equal(extractClosedString('{"html":"abc\\u00', 'html'), null)
})

test('extractClosedString ignores a member present only in the value', () => {
  // "html" appears inside the fragment; only the key position may match.
  assert.equal(extractClosedString('{"title":"html","x":1}', 'html'), null)
})

test('readWidget renders a running call from complete arguments', () => {
  const got = readWidget({ name: 'render_widget', argsRaw: '{"html":"<p>hi</p>","height":300}' })
  assert.equal(got.status, 'ready')
  assert.equal(got.html, '<p>hi</p>')
  assert.equal(got.height, 300)
})

test('readWidget renders a running call as soon as the fragment closes', () => {
  const got = readWidget({ name: 'render_widget', argsRaw: '{"html":"<p>hi</p>","title":"still stre' })
  assert.equal(got.status, 'ready')
  assert.equal(got.html, '<p>hi</p>')
})

test('readWidget reports running until the fragment closes', () => {
  assert.equal(readWidget({ name: 'render_widget', argsRaw: '{"html":"<p>hi' }).status, 'running')
  assert.equal(readWidget({ name: 'render_widget', argsRaw: '' }).status, 'running')
  assert.equal(readWidget(null).status, 'running')
})

test('readWidget renders a settled call from its paired arguments', () => {
  const got = readWidget({
    kind: 'tool-result',
    isError: false,
    call: { name: 'render_widget', argsRaw: '{"html":"<svg/>","title":"图"}' },
    content: [{ type: 'text', text: 'ack' }],
  })
  assert.equal(got.status, 'ready')
  assert.equal(got.title, '图')
})

test('readWidget reports failure instead of rendering on an error result', () => {
  const got = readWidget({
    kind: 'tool-result',
    isError: true,
    error: { name: 'Error', code: 'E', reason: 'too big' },
    call: { name: 'render_widget', argsRaw: '{"html":"<p>x</p>"}' },
  })
  assert.equal(got.status, 'failed')
  assert.equal(got.error, 'too big')
})

test('readWidget degrades when window truncation dropped the call head', () => {
  const got = readWidget({ kind: 'tool-result', isError: false, call: null, content: [] })
  assert.equal(got.status, 'empty')
})

test('normalize clamps a degenerate frame height', () => {
  assert.equal(normalize({ html: 'x', height: 0 }).height, 80)
  assert.equal(normalize({ html: 'x', height: -5 }).height, 80)
  assert.equal(normalize({ html: 'x', height: 99999 }).height, 2000)
  assert.equal(normalize({ html: 'x', height: Number.NaN }).height, 420)
  assert.equal(normalize({ html: 'x' }).height, 420)
  assert.equal(normalize({ html: 'x', allowScripts: 'yes' }).allowScripts, false)
})

test('buildSrcDoc blocks every network scheme', () => {
  const doc = buildSrcDoc('<p>x</p>', false, false)
  assert.match(doc, /default-src 'none'/)
  assert.match(doc, /connect-src 'none'/)
  assert.match(doc, /script-src 'none'/)
  assert.ok(!doc.includes('unsafe-eval'))
})

test('buildSrcDoc opens the script source only when scripts were requested', () => {
  assert.match(buildSrcDoc('<p>x</p>', true, true), /script-src 'unsafe-inline'/)
})

test('buildSrcDoc follows the palette it was given', () => {
  assert.match(buildSrcDoc('<p>x</p>', true, false), /color-scheme:dark/)
  assert.match(buildSrcDoc('<p>x</p>', false, false), /color-scheme:light/)
})

test('buildSrcDoc places the fragment after the policy and the reset', () => {
  const doc = buildSrcDoc('<p id="mark">x</p>', false, false)
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('<p id="mark">'))
  assert.ok(doc.indexOf('<style>') < doc.indexOf('<p id="mark">'))
})
