/**
 * Checks dsh-widget's node half.
 *
 * The tool is registered as a plain definition (no `defineTool`), so these
 * tests assert the definition contract directly: the registry consumes
 * `parameters` as JSON Schema and `output.schema` as JSON Schema, and the input
 * checks the helper would have generated are this package's own job now.
 *
 * Run with:
 *
 *   node --test test/index.test.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as mod from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

const sections = []
const tools = []
mod.apply({
  systemPrompt: { section: (section) => sections.push(section) },
  tools: { register: (definition) => tools.push(definition) },
})

const tool = tools[0]

test('node half follows the function-form plugin contract', () => {
  assert.equal(mod.name, 'dsh-widget')
  assert.deepEqual(mod.inject, ['tools', 'systemPrompt'], 'neither service may be used without injection')
  assert.ok(!('default' in mod), 'function form must not also carry a default export')
})

test('the module imports nothing, so it installs from any directory', () => {
  // A bundle is loaded through its real path under the profile, so any bare
  // specifier would need this package to carry its own node_modules. Keeping
  // the module dependency-free is what makes a symlinked install work.
  const specifiers = [...source.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)].map((m) => m[1])
  assert.deepEqual(specifiers, [], `unexpected imports: ${specifiers.join(', ')}`)
  assert.ok(!/\brequire\s*\(/.test(source), 'a zero-dependency plugin must not require() either')
})

test('apply registers exactly one prompt section and one tool', () => {
  assert.equal(sections.length, 1)
  assert.equal(tools.length, 1)
  assert.equal(sections[0].name, 'dsh-widget:authoring')
})

test('the prompt section states the rules the renderer enforces', () => {
  const text = sections[0].text
  for (const rule of ['self-contained', 'no CDN', 'currentColor', 'viewBox', 'emoji', 'allowScripts']) {
    assert.ok(text.includes(rule), `prompt section never mentions "${rule}"`)
  }
  assert.ok(Number.isFinite(sections[0].order), 'a non-finite order throws at registration')
})

test('the tool is registered under its wire name', () => {
  assert.equal(tool.name, 'render_widget')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
  assert.ok(tool.output && tool.output.schema, 'a canonical output declaration is mandatory')
  // `description` is what the model reads to decide whether to call the tool.
  assert.ok(tool.description.length > 100)
})

test('parameters are plain JSON Schema the registry can snapshot', () => {
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['html'])
  assert.equal(tool.parameters.properties.height.type, 'number')
  assert.equal(tool.parameters.properties.allowScripts.type, 'boolean')
  for (const [key, spec] of Object.entries(tool.parameters.properties)) {
    assert.equal(typeof spec.description, 'string', `${key} needs a description the model can read`)
  }
})

test('output.schema is closed and names every required field', () => {
  assert.equal(tool.output.schema.additionalProperties, false)
  assert.deepEqual(
    [...tool.output.schema.required].sort(),
    Object.keys(tool.output.schema.properties).sort(),
    'every declared output field must be required, or the renderer would read undefined',
  )
})

test('execute reports a rendered widget without echoing the fragment', async () => {
  const html = '<svg viewBox="0 0 10 10"/>'
  const value = await tool.execute({ html, height: 300 })
  assert.deepEqual(value, {
    rendered: true,
    bytes: Buffer.byteLength(html, 'utf8'),
    height: 300,
    scripted: false,
    estTokens: Math.ceil(Buffer.byteLength(html, 'utf8') / 3),
    overBudget: false,
  })
  // The acknowledgement is what re-enters the model context, so it must stay small.
  assert.ok(JSON.stringify(value).length < 200)
})

test('execute reports a cost estimate that does not under-count CJK bytes', async () => {
  // A Chinese character is 3 UTF-8 bytes and roughly one token, so counting
  // characters (the harness meter's rule) would understate this by ~3x.
  const value = await tool.execute({ html: '<text>中文标签</text>' })
  assert.equal(value.estTokens, Math.ceil(value.bytes / 3))
  assert.ok(value.estTokens >= '</text>'.length, 'a CJK-heavy fragment must not be priced per character')
})

test('execute flags a fragment past the soft budget without rejecting it', async () => {
  const under = await tool.execute({ html: 'x'.repeat(8 * 1024) })
  assert.equal(under.overBudget, false, 'the soft line is exclusive, matching the hard ceiling')
  const over = await tool.execute({ html: 'x'.repeat(8 * 1024 + 1) })
  assert.equal(over.overBudget, true)
  // Soft means soft: it still renders, so the model gets a signal rather than a failure.
  assert.equal(over.rendered, true)
})

test('render warns the model only when the soft budget was crossed', () => {
  const base = { rendered: true, bytes: 100, height: 420, scripted: false, estTokens: 34 }
  const quiet = tool.output.render({}, { ...base, overBudget: false })[0].text
  const loud = tool.output.render({}, { ...base, overBudget: true })[0].text
  assert.match(quiet, /~34 tokens/)
  assert.ok(!/soft budget/i.test(quiet), 'a fragment inside the budget must not be nagged about')
  assert.match(loud, /soft budget/i)
  assert.match(loud, /split/i)
})

test('render still tells the model not to repeat the markup', () => {
  const blocks = tool.output.render({}, { rendered: true, bytes: 12, height: 420, scripted: false, estTokens: 4, overBudget: false })
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, /do not repeat/i)
  assert.ok(!blocks[0].text.includes('<p>x</p>'), 'the ack must not carry the fragment back to the model')
})

test('execute rejects a missing or empty fragment', async () => {
  await assert.rejects(() => tool.execute({}), /required/)
  await assert.rejects(() => tool.execute({ html: '   ' }), /must not be empty/)
  await assert.rejects(() => tool.execute({ html: '' }), /must not be empty/)
})

test('execute rejects a fragment over the size ceiling', async () => {
  const huge = 'x'.repeat(512 * 1024 + 1)
  await assert.rejects(() => tool.execute({ html: huge }), /over the/)
  // One byte under the ceiling still renders, so the limit is exclusive.
  assert.equal((await tool.execute({ html: 'x'.repeat(512 * 1024) })).rendered, true)
})

test('execute clamps a frame height outside a usable range', async () => {
  assert.equal((await tool.execute({ html: '<p>x</p>' })).height, 420)
  assert.equal((await tool.execute({ html: '<p>x</p>', height: 0 })).height, 80)
  assert.equal((await tool.execute({ html: '<p>x</p>', height: -10 })).height, 80)
  assert.equal((await tool.execute({ html: '<p>x</p>', height: 99999 })).height, 2000)
})

test('execute rejects a present-but-unusable argument', async () => {
  // Absent is fine; wrong is not, because silently substituting a default would
  // leave the model with no signal that its call was mis-shaped.
  await assert.rejects(() => tool.execute({ html: '<p>x</p>', height: Number.NaN }), /finite number/)
  await assert.rejects(() => tool.execute({ html: '<p>x</p>', height: '300' }), /finite number/)
  await assert.rejects(() => tool.execute({ html: '<p>x</p>', allowScripts: 'yes' }), /boolean/)
  await assert.rejects(() => tool.execute({ html: '<p>x</p>', title: 42 }), /string/)
  await assert.rejects(() => tool.execute({ html: 42 }), /string/)
})

test('execute enables scripts only on an explicit true', async () => {
  assert.equal((await tool.execute({ html: '<p>x</p>' })).scripted, false)
  assert.equal((await tool.execute({ html: '<p>x</p>', allowScripts: false })).scripted, false)
  assert.equal((await tool.execute({ html: '<p>x</p>', allowScripts: true })).scripted, true)
})

test('execute counts bytes rather than characters', async () => {
  const fragment = '<p>中文标签</p>'
  const value = await tool.execute({ html: fragment })
  assert.equal(value.bytes, Buffer.byteLength(fragment, 'utf8'))
  assert.notEqual(value.bytes, fragment.length)
})

test('render stays honest when nothing was drawn', () => {
  const blocks = tool.output.render({}, { rendered: false, bytes: 0, height: 420, scripted: false })
  assert.match(blocks[0].text, /not rendered/i)
})

test('the call is declared safe to run alongside siblings', () => {
  assert.equal(tool.isConcurrencySafe?.({ html: '<p>x</p>' }), true)
})
