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
const {
  readWidget, normalize, extractClosedString, extractOpenString, salvageFragment, buildSrcDoc,
  argumentSize, hasArgumentView,
} = mod.__internals

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

// ── truncation resilience ────────────────────────────────────────────────────

test('extractOpenString recovers a value that never closed', () => {
  // The truncation case: the closing quote is exactly what is missing.
  assert.equal(extractOpenString('{"html":"<svg><text>x', 'html'), '<svg><text>x')
  assert.equal(extractOpenString('{"title":"t","html":"abc', 'html'), 'abc')
})

test('extractOpenString returns null when the member never started', () => {
  assert.equal(extractOpenString('{"title":"t"', 'html'), null)
  assert.equal(extractOpenString('{"html', 'html'), null)
  assert.equal(extractOpenString('', 'html'), null)
})

test('extractOpenString stops at an incomplete escape instead of mis-decoding it', () => {
  assert.equal(extractOpenString('{"html":"a\\', 'html'), 'a')
  assert.equal(extractOpenString('{"html":"a\\u00', 'html'), 'a')
  assert.equal(extractOpenString('{"html":"a\\q', 'html'), 'aq', 'an unknown escape decodes as its literal char')
})

test('extractOpenString decodes escapes that did complete', () => {
  assert.equal(extractOpenString('{"html":"a\\nb\\u003cc', 'html'), 'a\nb<c')
})

test('salvageFragment cuts a fragment truncated inside a tag', () => {
  // An unterminated attribute quote would otherwise swallow every later element.
  assert.equal(salvageFragment('<svg><rect width="10'), '<svg>')
  assert.equal(salvageFragment('<svg><rect width="10"/>'), '<svg><rect width="10"/>')
})

test('salvageFragment rejects a fragment with nothing renderable', () => {
  assert.equal(salvageFragment(''), null)
  assert.equal(salvageFragment('   '), null)
  assert.equal(salvageFragment('<svg'), null, 'no complete element yet')
  assert.equal(salvageFragment('plain text'), null)
})

test('readWidget salvages a stalled stream instead of running forever', () => {
  const running = { name: 'render_widget', argsRaw: '{"html":"<svg><circle r=\\"4\\"/>' }
  // Before the watchdog trips, the card still waits for a cleaner fragment.
  assert.equal(readWidget(running, false).status, 'running')
  const got = readWidget(running, true)
  assert.equal(got.status, 'ready')
  assert.equal(got.truncated, true)
  assert.equal(got.html, '<svg><circle r="4"/>')
})

test('readWidget reports truncated when a stalled stream never yielded markup', () => {
  const got = readWidget({ name: 'render_widget', argsRaw: '{"html":"<svg' }, true)
  assert.equal(got.status, 'truncated')
})

test('a stalled call that never reached a usable fragment says so', () => {
  // A stalled payload with no recoverable markup is a truncation, not a
  // permanent "generating" placeholder — but an empty payload is not evidence
  // of anything yet, so it keeps waiting.
  assert.equal(readWidget({ name: 'render_widget', argsRaw: '{"title":"' }, true).status, 'truncated')
  assert.equal(readWidget({ name: 'render_widget', argsRaw: '' }, true).status, 'running')
})

test('readWidget recovers an unexecuted call closed as TOOL_NOT_STARTED', () => {
  // This is the signature of a step cut off by the model's output ceiling: the
  // harness settles the call as an error it never ran.
  const got = readWidget({
    kind: 'tool-result',
    isError: true,
    error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' },
    call: { name: 'render_widget', argsRaw: '{"html":"<svg><g><circle r=\\"3\\"/></g>' },
  })
  assert.equal(got.status, 'ready')
  assert.equal(got.truncated, true)
  assert.equal(got.html, '<svg><g><circle r="3"/></g>')
})

test('readWidget recovers an unexecuted call closed as TOOL_OUTCOME_UNKNOWN', () => {
  const got = readWidget({
    kind: 'tool-result',
    isError: true,
    error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
    call: { name: 'render_widget', argsRaw: '{"html":"<svg><text>hi</text>' },
  })
  assert.equal(got.status, 'ready')
  assert.equal(got.truncated, true)
})

test('an unexecuted call with no salvageable markup reports truncated, not failed', () => {
  const got = readWidget({
    kind: 'tool-result',
    isError: true,
    error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' },
    call: { name: 'render_widget', argsRaw: '{"html":"<sv' },
  })
  assert.equal(got.status, 'truncated')
})

test('an ordinary tool error still reports a failure', () => {
  // The truncation-specific recovery must not swallow unrelated errors.
  const got = readWidget({
    kind: 'tool-result',
    isError: true,
    error: { name: 'Error', code: 'E_SOMETHING', reason: 'bad args' },
    call: { name: 'render_widget', argsRaw: '{"html":"<svg></svg>"}' },
  })
  assert.equal(got.status, 'failed')
  assert.equal(got.error, 'bad args')
})

test('a settled call carrying a truncated payload is salvaged rather than dropped', () => {
  const got = readWidget({
    kind: 'tool-result',
    isError: false,
    call: { name: 'render_widget', argsRaw: '{"html":"<svg><text>ok</text>' },
    content: [{ type: 'text', text: 'ack' }],
  })
  assert.equal(got.status, 'ready')
  assert.equal(got.truncated, true)
})

test('normalize carries the truncation flag only when set', () => {
  assert.equal(normalize({ html: 'x', truncated: true }).truncated, true)
  assert.equal(normalize({ html: 'x' }).truncated, false)
  assert.equal(normalize({ html: 'x', truncated: 'yes' }).truncated, false)
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

// ── DSH 0.2 argument view ────────────────────────────────────────────────────

/**
 * Stand-in for the harness's `PartialArguments` view.
 *
 * DSH 0.2 stopped exposing a streaming call's raw argument JSON and exposes a
 * view instead: `text(key)` is the decoded string so far, `complete(key)`
 * whether its closing quote arrived, `keys()` what has appeared at all.
 *
 * @param fields - the decoded fields seen so far.
 * @param options - `closed` whether the fragment's quote arrived, `arrived`
 *   whether any field appeared.
 */
function argumentView(fields, { closed = true, arrived = true } = {}) {
  const keys = Object.keys(fields)
  const isString = (key) => typeof fields[key] === 'string'
  return {
    text: (key) => (isString(key) ? fields[key] : undefined),
    value: (key) => (Object.hasOwn(fields, key) ? fields[key] : undefined),
    complete: (key) => closed && isString(key),
    keys: () => (arrived ? keys : []),
    stringLength: (key) => (isString(key) ? fields[key].length : undefined),
  }
}

test('hasArgumentView recognizes the view and rejects the old string wire', () => {
  assert.equal(hasArgumentView({ args: argumentView({ html: '<p>x</p>' }) }), true)
  assert.equal(hasArgumentView({ argsRaw: '{"html":"x"}' }), false)
  assert.equal(hasArgumentView({ args: {} }), false)
  assert.equal(hasArgumentView(null), false)
})

test('readWidget renders a live call from the argument view', () => {
  const got = readWidget({
    phase: 'start',
    name: 'render_widget',
    args: argumentView({ html: '<p>hi</p>', height: 300, title: 't' }),
  })
  assert.equal(got.status, 'ready')
  assert.equal(got.html, '<p>hi</p>')
  assert.equal(got.height, 300)
  assert.equal(got.title, 't')
  assert.equal(got.truncated, false)
})

test('readWidget waits while the view fragment is still open', () => {
  const got = readWidget({
    phase: 'preparing',
    name: 'render_widget',
    args: argumentView({ html: '<p>hi' }, { closed: false }),
  })
  assert.equal(got.status, 'running')
})

test('readWidget salvages a stalled view fragment instead of waiting forever', () => {
  const block = {
    phase: 'preparing',
    name: 'render_widget',
    args: argumentView({ html: '<svg><circle r="4"/>' }, { closed: false }),
  }
  assert.equal(readWidget(block, false).status, 'running')
  const got = readWidget(block, true)
  assert.equal(got.status, 'ready')
  assert.equal(got.truncated, true)
  assert.equal(got.html, '<svg><circle r="4"/>')
})

test('readWidget reports truncated when a stalled view never yielded markup', () => {
  const cutTag = {
    phase: 'preparing',
    name: 'render_widget',
    args: argumentView({ html: '<svg' }, { closed: false }),
  }
  assert.equal(readWidget(cutTag, true).status, 'truncated')
  const titleOnly = {
    phase: 'preparing',
    name: 'render_widget',
    args: argumentView({ title: 'x' }, { closed: false }),
  }
  assert.equal(readWidget(titleOnly, true).status, 'truncated')
})

test('readWidget keeps waiting on a view that has received nothing', () => {
  const block = { phase: 'preparing', name: 'render_widget', args: argumentView({}, { arrived: false }) }
  assert.equal(readWidget(block, true).status, 'running')
})

test('readWidget renders a settled call that only carries the view', () => {
  const got = readWidget({
    kind: 'tool-result',
    isError: false,
    call: null,
    args: argumentView({ html: '<svg/>', title: '图' }),
    content: [{ type: 'text', text: 'ack' }],
  })
  assert.equal(got.status, 'ready')
  assert.equal(got.html, '<svg/>')
  assert.equal(got.title, '图')
})

test('the old argsRaw wire keeps working alongside the view', () => {
  // A reopened session replays nodes written by whichever harness build produced them.
  assert.equal(readWidget({ name: 'render_widget', argsRaw: '{"html":"<p>hi</p>"}' }).status, 'ready')
})

test('argumentSize follows whichever wire the node carries', () => {
  const raw = '{"html":"<p>'
  assert.equal(argumentSize({ argsRaw: raw }), raw.length)
  assert.equal(argumentSize({ args: argumentView({ html: '<p>hi', title: 't' }, { closed: false }) }), 5)
  assert.equal(argumentSize({}), -1)
  assert.equal(argumentSize(null), -1)
})
