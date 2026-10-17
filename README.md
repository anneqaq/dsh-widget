# dsh-widget

English | [中文](README.zh.md)

Inline visualization for DeepSeek Harness. The model calls one tool with a
self-contained SVG or HTML fragment, and the fragment renders as a card in the
conversation — diagrams, charts, timelines, comparison tables, annotated
layouts — instead of being described in prose.

[![test](https://github.com/anneqaq/dsh-widget/actions/workflows/test.yml/badge.svg)](https://github.com/anneqaq/dsh-widget/actions/workflows/test.yml)
![license](https://img.shields.io/badge/license-MIT-blue)
![dsh](https://img.shields.io/badge/dsh-0.1.x%20%7C%7C%200.2.x-blue)

## Install

From GitHub:

```bash
dsh plugin --profile web add github:anneqaq/dsh-widget
```

Or from a local checkout:

```bash
dsh plugin --profile web add /absolute/path/to/dsh-widget
```

Then restart `dsh web`. The plugin mounts at startup and has no hot reload.

Verify the row landed in the config tree:

```bash
dsh --profile web --dump-config | grep -A2 dsh-widget
```

If `pnpm` refuses with `ERR_PNPM_ADDING_TO_ROOT` — the shipped `web` profile is
a single-package workspace, so its root check fires — allow the root write:

```bash
npm_config_ignore_workspace_root_check=true dsh plugin --profile web add github:anneqaq/dsh-widget
```

Remove with:

```bash
dsh plugin --profile web remove dsh-widget
```

> This package has **no build step** — `lib/` is committed, so a git install
> needs no `prepare` script and no pnpm `allowBuilds` grant. Installing it runs
> no build code on your machine.

## Use

The model does the work; there is nothing to configure. Ask for something
visual and it calls `render_widget`:

> Draw me the request lifecycle for this service as a timeline.

`render_widget` takes four arguments:

| Argument | Required | Meaning |
|---|---|---|
| `html` | yes | One self-contained SVG or HTML fragment. |
| `title` | no | Caption above the card; also the frame title. |
| `height` | no | Frame height in CSS pixels. Default 420, clamped to 80–2000. |
| `allowScripts` | no | Enable scripts inside the fragment. Off by default. |

The tool returns only a short acknowledgement — including an `estTokens`
estimate and an `overBudget` flag once a fragment passes the 8 KB soft line. The
fragment is **not** echoed back into the model context — the card reads it from
the logged call arguments, so a large diagram costs one copy in the transcript,
not two.

## How it works

Two halves, one name:

```
dsh-widget/
├── package.json        dsh.bundle.patch + dsh.client, no dependencies
├── cordis.patch.yml    inserts this plugin's node-half row
├── icon.svg            plugin icon (display metadata)
├── locale/             display metadata: en.json / zh.json
├── lib/
│   ├── index.js        node half  → registers the tool + one prompt section
│   └── client.js       browser half → renders the tool's calls
└── test/               54 tests, no browser and no harness required
```

**Node half** registers a plain `ToolDefinition` and a system-prompt section
stating the authoring contract. It holds no state and draws nothing.

**Browser half** claims the wire name `render_widget` in the keyed
`tool.call.toolview` slot. Because the slot is keyed by wire tool name, this is
additive: it never touches the shipped tool cards.

**No build step.** The browser half is hand-authored in the
`window.__ModuleLoader__.load({ id, factory })` lazy-CJS format the shell
expects, so the package ships `lib/client.js` directly — no `tsdown`, no
TypeScript, no bundler. `react` is the only module it requires, and `react` is
a member of the shell's frozen platform module table.

**No dependencies at all.** A bundle is loaded through its real path under the
profile, so a bare specifier such as `@deepseek-ai/dsh-tools` resolves only if
the package carries its own `node_modules`. This package imports nothing, which
is what lets it install from any directory — including a symlinked development
checkout. The input checks the `defineTool` helper would have generated are
written out in `lib/index.js` instead.

## Isolation

The fragment is model-authored, so it is treated as untrusted content. It
renders through a **sandboxed `srcdoc` frame**, never through
`dangerouslySetInnerHTML` in the app's own DOM.

- `sandbox=""` — no scripts, opaque origin. `sandbox="allow-scripts"` only when
  the caller asked with `allowScripts: true`, and never together with
  `allow-same-origin` (that pair would let the fragment reach the host
  document).
- The frame's CSP is `default-src 'none'` with `img-src data: blob:`,
  `style-src 'unsafe-inline'`, and `connect-src 'none'`. A stray CDN import or
  a `fetch` fails closed rather than silently exfiltrating.
- Widgets carry no theme state of their own. The frame injects the palette the
  app is currently painting with, tracked via `body[data-ds-dark-theme]` so a
  live theme switch re-renders the frame.

## Limits worth knowing

- **The card appears when the fragment argument closes**, not while it streams.
  Reading a half-arrived fragment would render broken markup, so the view shows
  a placeholder until `html` is complete — which is usually before the tool
  result lands.
- **A cut-off fragment is salvaged, not lost.** A step that exhausts the model's
  output ceiling is killed *before* its tool call executes, so the call is never
  settled while the session is open and its fragment may never close. The view
  recovers the prefix that did arrive, marks the card as cut short, and — when a
  reopen closes the call as `TOOL_NOT_STARTED` — recovers it from the stored
  arguments too. If a still-streaming payload stops growing for 20s it is treated
  as dead and salvaged the same way; recovery is non-destructive, so a late chunk
  simply supersedes the partial card.
- **8 KB soft budget, 512 KB hard ceiling.** The model is told when a fragment
  crosses the soft line, because the real limit is the step's *token* budget: a
  512 KB fragment costs more output tokens than the step can produce, so the
  ceiling is unreachable and the budget is what actually binds. The hard ceiling
  still bounds the transcript and the wire request.
- **No network in the frame**, by design. Inline everything.
- **The card is a tool row, not prose.** It renders where the call sits in the
  turn. Inline-in-the-middle-of-a-paragraph rendering is not available through
  a public extension point; the `tool.call.toolview` slot is the sanctioned
  seam.

## Compatibility

`package.json` declares `engines.dsh` as
`>=0.1.2-rc.1 <0.2.0 || >=0.1.5-alpha.1 <0.2.0 || >=0.1.6-0 <0.2.0 || >=0.1.7-0 <0.2.0 || >=0.2.0 <0.3.0-0`.

The multi-clause `||` form is required by semver's prerelease rule: a
prerelease version only satisfies a comparator set when a comparator in the
same `[major, minor, patch]` tuple carries a prerelease, so a bare
`>=0.1.2-rc.1 <0.2.0` does **not** admit `0.1.5-rc.1`. Every new upstream
prerelease tuple needs its own clause. The 0.2 clause ends at `<0.3.0-0`
rather than `<0.3.0` for the mirror-image reason: a plain upper bound already
admits that line's own prereleases, so `<0.3.0` would silently claim
compatibility with `0.3.0-rc.1`.

**This field is a hard gate, not documentation.** `dsh` evaluates it twice on
the way in. An unsatisfied `engines.dsh` makes `loadProfileDirectory` skip the
whole bundle — so `cordis.patch.yml` never composes and no Loader row is
inserted — and `prepareProfileEntries` disables any row that still reaches the
tree. A range that stops below the running `dsh` therefore makes the plugin
disappear: no `render_widget` tool, no card, and nothing on screen saying why.
The 0.1-only range this package shipped before 0.1.1 did exactly that on
`0.2.1-rc.2`.

Verified against `0.1.7-rc.2` and `0.2.1-rc.2`. Both client argument wires are
read: 0.2 replaced a streaming call's closing `argsRaw` string with an `args`
view that answers per field (`text`, `complete`, `keys`), and the card accepts
either one, because a reopened session replays nodes written by whichever build
produced them.

This package deliberately declares **no `peerDependencies`** on
`@deepseek-ai/dsh-*`: it imports no host package, and `peerDependencies` is an
enforced install gate (`evaluatePluginCompatibility`, fail-closed), so declaring
one would add a gate without adding truth.

## Development

```bash
npm test
```

63 tests, no browser and no harness required. They run the real projections:
the streaming-JSON recovery that decides whether a card renders or is salvaged
after truncation, both argument wires the harness has used, the frame's CSP, and
the tool contract.

Three checks are deliberate regression guards rather than behavior tests — the
module must import nothing, `output.schema` must stay closed, and the client half
must require only `react`. All encode mistakes that fail loudly at harness boot
rather than at unit-test time.

## License

MIT
