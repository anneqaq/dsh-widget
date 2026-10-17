/**
 * dsh-widget, node half.
 *
 * Owns exactly two capabilities:
 *
 * 1. A `render_widget` tool, so the model can hand a self-contained SVG/HTML
 *    fragment to the conversation instead of describing it in prose.
 * 2. One system-prompt section that states the authoring contract, because a
 *    fragment that loads a CDN script or hardcodes a white background renders
 *    as an empty box and the model would have no way to know why.
 *
 * The visual itself is produced by the browser half (`exports["./client"]`),
 * which claims this tool's name in the keyed `tool.call.toolview` slot. Nothing
 * here renders, and the fragment never travels back through the model context:
 * `execute` returns a small acknowledgement and the client reads the fragment
 * from the logged call arguments.
 *
 * The tool is registered as a plain definition rather than through the
 * `defineTool` helper, and this package therefore has **no imports at all**.
 * That is deliberate: a bundle installed under a profile is loaded through its
 * real path, so a bare specifier like `@deepseek-ai/dsh-tools` only resolves if
 * this package carries its own dependencies. Declaring none keeps the plugin
 * installable from any directory — including a symlinked development checkout —
 * and keeps the `parameters` schema in the JSON Schema form the registry
 * already expects. The registry still enforces `output.schema`; the input
 * checks `defineTool` would have generated are written out below instead.
 *
 * @module dsh-widget
 */

/** Cordis plugin name; must be unique in the Loader tree. */
export const name = 'dsh-widget'

/** `tools` supplies the registry; `systemPrompt` supplies the section registry. */
export const inject = ['tools', 'systemPrompt']

/**
 * Hard ceiling on one fragment. The fragment is stored twice — once in the tool
 * call arguments and once in the session log — so this bounds both the wire
 * request and the on-disk transcript.
 */
const MAX_FRAGMENT_BYTES = 512 * 1024

/**
 * Soft ceiling on one fragment, in bytes.
 *
 * The hard ceiling above is unreachable in practice: a 512 KB fragment costs
 * far more output tokens than any model's response budget, so the *real* limit
 * is the step's token ceiling, and hitting it is much worse than being warned.
 * A step cut off by that ceiling has its tool call discarded unexecuted, which
 * costs the whole call. This softer line is the one worth steering by, so the
 * model is told when it has crossed it instead of discovering it by failure.
 */
const SOFT_FRAGMENT_BYTES = 8 * 1024

/**
 * Bytes per output token used for the reported cost estimate.
 *
 * Deliberately conservative. The harness's own meter divides *characters* by 4,
 * which under-counts CJK: a UTF-8 Chinese character is 3 bytes and roughly one
 * token, so a label-heavy SVG costs far more than its character count suggests.
 * Dividing bytes by 3 stays on the safe side of both scripts.
 */
const BYTES_PER_TOKEN = 3

/** Frame height used when the model does not suggest one. */
const DEFAULT_HEIGHT = 420

/**
 * Sort position of this plugin's prompt section. Deliberately inside the tool
 * band, just after the last first-party tool description and before the MCP
 * server block, so widget guidance reads as tool documentation rather than as
 * part of the deployment persona.
 */
const SECTION_ORDER = 3050

/** Authoring contract for the model; the renderer enforces it structurally. */
const SECTION_TEXT = `## Inline visual widgets

\`render_widget\` turns one self-contained SVG or HTML fragment into a card the
user sees in place of a paragraph. Prefer it over prose whenever a shape,
a comparison, a sequence, or a small table carries the answer better than
sentences do: flowcharts, architecture diagrams, timelines, bar or line charts,
comparison tables, state machines, annotated layouts.

Reach for it when the user asks to see, draw, diagram, chart, or compare, and
also when you would otherwise write a wall of text that is really a diagram.

The fragment is isolated in a sandboxed frame and is fetched from nowhere.
Follow these rules or the card renders blank or broken:

- Ship one self-contained fragment. There is no network: no CDN script, no
  remote stylesheet, no webfont, no remote image. A blocked request is silent.
- Put CSS in inline \`style\` attributes or one \`<style>\` block; never in a
  separate file. Inline SVG is preferred over raster images.
- Never paint your own page background. The frame supplies it for the active
  theme. Use \`currentColor\` for text and strokes so light and dark both work,
  and pick fills that stay legible on either.
- Use \`width:100%\` and let the frame size the height. Size an \`<svg>\` with a
  \`viewBox\` and no fixed \`width\` attribute.
- Do not use emoji; glyph fonts are not guaranteed. Use plain text or shapes.
- Give an \`<svg>\` \`role="img"\` plus \`<title>\` and \`<desc>\` children.
- Keep text at 11px or larger and keep one idea per widget. A dense wall of
  boxes inside one card reads worse than two cards.
- Scripts are disabled unless you pass \`allowScripts: true\`. Only enable it for
  a figure that must respond to clicks.

Budget, and why it matters more than it looks:

- A fragment is paid for out of the *same* response budget as your prose and your
  reasoning. If a call is still streaming when that budget runs out, the step
  ends and the tool call is discarded **unexecuted** — the card never appears and
  the whole call is wasted. Overshooting is not a slightly-too-long answer; it is
  no answer.
- Aim for one widget under ~8 KB. Above that, split the idea across several
  \`render_widget\` calls in the same step rather than growing one fragment: the
  calls run in parallel and each renders on its own, so an overrun costs one card
  instead of all of them.
- Write the prose first and draw in a later step. Mixing a long explanation and a
  large fragment into one step is what makes the step hit the ceiling.
- Cheapest markup wins. Put styles in one \`<style>\` block and use classes instead
  of repeating \`style="..."\` on every element; define a shape once with \`<defs>\`
  and place it with \`<use>\`; draw one shared coordinate system and \`<g transform>\`
  the rest. Chinese labels cost roughly a token per character, so prefer short ones.
- The acknowledgement reports \`estTokens\` and sets \`overBudget\` past the soft
  line. Treat that as a signal to write smaller next time, not as an error.

After calling the tool, do not repeat or describe the markup. The user can see
it; add at most one sentence of interpretation that the picture does not carry.`

/**
 * Reject a present-but-unusable argument.
 *
 * The helper `defineTool` would have turned these into `INVALID_ARGS`; this
 * package hands the registry a raw definition instead, so the same checks live
 * here. An absent argument is always valid and falls back to a default.
 *
 * @param value - the raw argument.
 * @param label - argument name, quoted back to the model.
 * @param expected - the JSON type the schema declared.
 * @returns the value, when it is already the right shape.
 */
function checkType(value, label, expected) {
  if (value === undefined) return undefined
  const actual = typeof value
  const ok = expected === 'number' ? actual === 'number' && Number.isFinite(value) : actual === expected
  if (!ok) {
    throw new Error(`render_widget: \`${label}\` must be a ${expected === 'number' ? 'finite number' : expected}`)
  }
  return value
}

/**
 * Build the tool definition.
 *
 * Exported so the contract can be asserted without a running harness.
 *
 * @returns a complete definition for `ctx.tools.register`.
 */
export function defineWidgetTool() {
  return {
    name: 'render_widget',
    description:
      'Render a self-contained SVG or HTML fragment as an inline visual card in the conversation. '
      + 'Use this for diagrams, charts, timelines, comparison tables, and annotated layouts — anything '
      + 'where a picture carries the answer better than prose. The fragment is isolated in a sandboxed '
      + 'frame with no network access, so it must be entirely self-contained: inline or embedded styles '
      + 'only, no CDN scripts, no remote fonts or images. It cannot read the conversation or local storage. '
      + 'Returns only an acknowledgement; the visual appears in the conversation automatically, so never '
      + 'repeat the markup in your reply.',
    parameters: {
      type: 'object',
      properties: {
        html: {
          type: 'string',
          description:
            'One complete, self-contained SVG or HTML fragment. Styles must be inline attributes or a '
            + 'single <style> block. No external resources of any kind.',
        },
        title: {
          type: 'string',
          description: 'Short caption shown above the visual; also the frame title.',
        },
        height: {
          type: 'number',
          description: `Suggested frame height in CSS pixels. Default ${DEFAULT_HEIGHT}.`,
        },
        allowScripts: {
          type: 'boolean',
          description:
            'Allow scripts inside the fragment. Off by default. Enable only for a figure that must '
            + 'respond to clicks; scripts stay in an opaque origin and cannot reach the conversation.',
        },
      },
      required: ['html'],
    },
    output: {
      // The registry enforces this against every successful result. Requiredness
      // is a top-level array here because the registry consumes plain JSON
      // Schema — the `required: true` per-property form belongs to the authoring
      // DSL, which this package does not use.
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rendered: { type: 'boolean' },
          bytes: { type: 'number' },
          height: { type: 'number' },
          scripted: { type: 'boolean' },
          estTokens: { type: 'number' },
          overBudget: { type: 'boolean' },
        },
        required: ['rendered', 'bytes', 'height', 'scripted', 'estTokens', 'overBudget'],
      },
      render(_args, value) {
        if (!value.rendered) {
          return [{ type: 'text', text: 'The widget was not rendered.' }]
        }
        // The cost estimate is advisory and deliberately terse: this text
        // re-enters the model's context on every call, so it must not itself
        // become the thing that fills the budget.
        const budget = value.overBudget
          ? ` Over the ~${SOFT_FRAGMENT_BYTES / 1024} KB soft budget: split the next`
            + ' figure across several calls, reuse styles via classes, and write'
            + ' less markup.'
          : ''
        return [{
          type: 'text',
          text: `Widget rendered inline in the conversation (${value.bytes} bytes, ~${value.estTokens} tokens,`
            + ` ${value.height}px tall${value.scripted ? ', scripts enabled' : ''}).${budget} `
            + 'The user can see it now; do not repeat the markup in your reply.',
        }]
      },
    },
    async execute(args) {
      const html = checkType(args.html, 'html', 'string')
      if (typeof html !== 'string' || html.trim().length === 0) {
        throw new Error('render_widget: `html` is required and must not be empty')
      }

      const bytes = Buffer.byteLength(html, 'utf8')
      if (bytes > MAX_FRAGMENT_BYTES) {
        throw new Error(
          `render_widget: fragment is ${bytes} bytes, over the ${MAX_FRAGMENT_BYTES}-byte limit. `
          + 'Split it into smaller widgets.',
        )
      }

      checkType(args.title, 'title', 'string')
      checkType(args.allowScripts, 'allowScripts', 'boolean')
      const requested = checkType(args.height, 'height', 'number')

      return {
        rendered: true,
        bytes,
        // Clamped here so the client never has to trust the model with a
        // degenerate frame: a 0px or 40000px card is a rendering bug, not a
        // preference.
        height: Math.min(Math.max(Math.round(requested ?? DEFAULT_HEIGHT), 80), 2000),
        scripted: args.allowScripts === true,
        estTokens: Math.ceil(bytes / BYTES_PER_TOKEN),
        overBudget: bytes > SOFT_FRAGMENT_BYTES,
      }
    },
    // Pure projection from frozen arguments: the same call can render
    // concurrently with any sibling.
    isConcurrencySafe: () => true,
  }
}

/**
 * Register the tool and the prompt section.
 * @param ctx - plugin context; both registrations are disposed with it.
 */
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'dsh-widget:authoring',
    order: SECTION_ORDER,
    text: SECTION_TEXT,
  })

  ctx.tools.register(defineWidgetTool())
}
