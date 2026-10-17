/**
 * dsh-widget, browser half.
 *
 * Claims the wire tool name `render_widget` in the keyed `tool.call.toolview`
 * slot, so every call to that tool renders as a live visual instead of the
 * generic tool row.
 *
 * Hand-authored in the `__ModuleLoader__.load` bundle format rather than built
 * from TypeScript: the client module contract is plain lazy-CJS
 * (`factory(require)` returning exports), so this package needs no toolchain to
 * ship. Only `react` is required, and `react` is a member of the shell's frozen
 * platform module table — anything outside that table would have to be declared
 * under `dsh.client.external` in package.json.
 *
 * Isolation is the load-bearing decision here. The fragment is model-authored,
 * so it is treated as untrusted content and rendered through a sandboxed
 * `srcdoc` frame, never through `dangerouslySetInnerHTML` in the app's own DOM.
 * The frame's CSP additionally blocks every network scheme, because a widget
 * that can exfiltrate is a widget that should not exist.
 *
 * @module dsh-widget/client
 */

window.__ModuleLoader__.load({
	id: "dsh-widget",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		const h = React.createElement;
		const { useCallback, useEffect, useMemo, useState } = React;

		/** Frame height used when the call carried no usable `height`. */
		const DEFAULT_HEIGHT = 420;
		/** Keeps a degenerate model-supplied height from producing an unusable card. */
		const MIN_HEIGHT = 80;
		const MAX_HEIGHT = 2000;

		/**
		 * How long an unclosed fragment may stop growing before the view treats
		 * the stream as dead and falls back to salvaging what arrived.
		 *
		 * A step killed by the model's output ceiling leaves its tool call
		 * unexecuted, and the harness never settles it mid-session, so the call
		 * node stays in its streaming phase forever. Chunks otherwise arrive in a
		 * near-continuous trickle once arguments start, so a total silence of this
		 * length means nothing more is coming rather than that the model is slow.
		 * The harness's own stream-idle tolerance is 300s, so this is the shorter,
		 * widget-local patience; recovery is non-destructive, so a false positive
		 * only shows a partial card that a later delta then supersedes.
		 */
		const STALL_MS = 20000;

		/**
		 * Error codes the harness synthesizes for a call it never executed.
		 *
		 * `dsh-session`'s crash/truncation repair closes a dangling call with one
		 * of these, which is why a truncated widget can still be recovered when a
		 * session is reopened even though nothing settled it while it was live.
		 */
		const UNEXECUTED_CODES = new Set(["TOOL_NOT_STARTED", "TOOL_OUTCOME_UNKNOWN"]);

		/** Copy for the two locales the client ships; no locale service dependency. */
		const STRINGS = /^zh/i.test(
			(typeof navigator !== "undefined" && navigator.language) || "",
		)
			? {
				generating: "正在生成可视化…",
				collapse: "收起",
				expand: "展开",
				runFailed: "可视化渲染失败",
				unknownFailure: "工具返回了错误",
				tooLarge: "片段过大，未渲染",
				scriptsOn: "脚本已启用",
				shownAbove: "已在上方显示",
				truncated: "片段未写完",
				truncatedHint: "模型输出在此处到达上限，以下是已收到的部分。",
				truncatedNone: "模型输出在该片段写完前结束，没有可显示的内容。请重新生成，或拆成更小的图。",
			}
			: {
				generating: "Building visual…",
				collapse: "Collapse",
				expand: "Expand",
				runFailed: "Visual failed to render",
				unknownFailure: "The tool reported an error",
				tooLarge: "Fragment too large to render",
				scriptsOn: "scripts enabled",
				shownAbove: "shown above",
				truncated: "fragment cut short",
				truncatedHint: "The model's output hit its limit here; this is the part that arrived.",
				truncatedNone: "The model's output ended before this fragment was written, so there is nothing to show. Ask again, or for a smaller figure.",
			};

		// ── argument recovery ────────────────────────────────────────────────

		/**
		 * Parse a complete JSON payload, or return null.
		 * @param raw - the logged `argsRaw` string.
		 */
		function parseWhole(raw) {
			if (typeof raw !== "string" || raw.length === 0) return null;
			try {
				const value = JSON.parse(raw);
				return value && typeof value === "object" ? value : null;
			} catch {
				return null;
			}
		}

		/**
		 * Pull one *closed* string member out of partially streamed JSON.
		 *
		 * While a call is still running, `argsRaw` is a growing prefix of the
		 * argument object, so `JSON.parse` throws for most of its life. Scanning
		 * for the member's terminating quote and parsing only that slice lets the
		 * visual appear the moment the fragment argument finishes arriving —
		 * before the tool result lands.
		 *
		 * Escapes are handed to `JSON.parse` on the extracted slice rather than
		 * decoded by hand, so `\n`, `\"`, and surrogate pairs all behave.
		 *
		 * @param raw - partial argument JSON.
		 * @param key - member name to recover.
		 * @returns the decoded string, or null when the value has not closed yet.
		 */
		function extractClosedString(raw, key) {
			if (typeof raw !== "string" || raw.length === 0) return null;
			const keyAt = raw.indexOf('"' + key + '"');
			if (keyAt < 0) return null;
			const colonAt = raw.indexOf(":", keyAt + key.length + 2);
			if (colonAt < 0) return null;

			let i = colonAt + 1;
			while (i < raw.length && /\s/.test(raw[i])) i += 1;
			if (raw[i] !== '"') return null;

			const start = i;
			i += 1;
			while (i < raw.length) {
				const ch = raw[i];
				if (ch === "\\") {
					// A backslash as the last received character means the escape
					// sequence straddles two deltas; wait for the next one.
					if (i + 1 >= raw.length) return null;
					i += raw[i + 1] === "u" ? 6 : 2;
					continue;
				}
				if (ch === '"') {
					try {
						return JSON.parse(raw.slice(start, i + 1));
					} catch {
						return null;
					}
				}
				i += 1;
			}
			return null;
		}

		/**
		 * Decode the still-open `html` member of a truncated argument payload.
		 *
		 * `extractClosedString` deliberately refuses a value whose closing quote
		 * never arrived, which is exactly the truncation case. This recovers what
		 * did arrive instead: it walks the escaped prefix and stops at the first
		 * incomplete escape sequence rather than mis-decoding it.
		 *
		 * @param raw - partial argument JSON.
		 * @param key - member name to recover.
		 * @returns the decoded prefix, or null when the member never started.
		 */
		function extractOpenString(raw, key) {
			if (typeof raw !== "string" || raw.length === 0) return null;
			const keyAt = raw.indexOf('"' + key + '"');
			if (keyAt < 0) return null;
			const colonAt = raw.indexOf(":", keyAt + key.length + 2);
			if (colonAt < 0) return null;

			let i = colonAt + 1;
			while (i < raw.length && /\s/.test(raw[i])) i += 1;
			if (raw[i] !== '"') return null;
			i += 1;

			let out = "";
			while (i < raw.length) {
				const ch = raw[i];
				if (ch === "\\") {
					if (i + 1 >= raw.length) break;
					const next = raw[i + 1];
					if (next === "u") {
						if (i + 6 > raw.length) break;
						const hex = raw.slice(i + 2, i + 6);
						if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
						out += String.fromCharCode(Number.parseInt(hex, 16));
						i += 6;
						continue;
					}
					const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" }[next];
					out += simple === undefined ? next : simple;
					i += 2;
					continue;
				}
				if (ch === '"') break;
				out += ch;
				i += 1;
			}
			return out;
		}

		/**
		 * Make a truncated fragment safe to hand to the HTML parser.
		 *
		 * Browsers already tolerate unclosed elements, so balancing tags by hand
		 * would add risk without adding rendering. The one shape that genuinely
		 * corrupts output is a fragment that stops *inside* a tag — an open
		 * attribute quote can swallow every following element — so that partial
		 * tag is cut away. A fragment truncated inside `<style>` loses that block
		 * and renders unstyled, which is still far better than rendering nothing.
		 *
		 * @param text - decoded but incomplete fragment.
		 * @returns usable markup, or null when nothing salvageable arrived.
		 */
		function salvageFragment(text) {
			if (typeof text !== "string") return null;
			let out = text;
			const lastOpen = out.lastIndexOf("<");
			const lastClose = out.lastIndexOf(">");
			if (lastOpen > lastClose) out = out.slice(0, lastOpen);
			out = out.trim();
			if (out === "") return null;
			// A fragment with no complete element yet would render as bare text.
			if (!/^<[a-zA-Z]/.test(out) || !out.includes(">")) return null;
			return out;
		}

		// ── argument sources ─────────────────────────────────────────────────

		/**
		 * Whether a call node carries the harness's per-field argument view.
		 *
		 * DSH 0.2 replaced a *streaming* call's growing `argsRaw` string with
		 * `args`, a `PartialArguments` view that owns the incremental JSON
		 * decoding: `text(name)` answers the decoded string so far and
		 * `complete(name)` whether its closing quote arrived. Both wires have to
		 * keep working — a reopened session replays nodes written by whichever
		 * build produced them — so the readers below accept either.
		 *
		 * @param node - a call or result node, or anything else.
		 * @returns whether `node.args` is the streaming view.
		 */
		function hasArgumentView(node) {
			const view = node && node.args;
			return !!view && typeof view === "object"
				&& typeof view.text === "function"
				&& typeof view.complete === "function";
		}

		/**
		 * Read one string member through the argument view.
		 *
		 * The view's readers are total by its own contract — an absent or
		 * differently typed field answers `undefined` rather than throwing — so
		 * this needs no guard of its own.
		 *
		 * @param view - a `PartialArguments`-shaped object.
		 * @param key - member name.
		 * @returns the decoded text so far, or undefined.
		 */
		function viewText(view, key) {
			const value = view.text(key);
			return typeof value === "string" ? value : undefined;
		}

		/**
		 * Read one non-string member through the argument view.
		 * @param view - a `PartialArguments`-shaped object.
		 * @param key - member name.
		 * @returns the parsed value once it closed, or undefined.
		 */
		function viewValue(view, key) {
			return typeof view.value === "function" ? view.value(key) : undefined;
		}

		/**
		 * Growth signal for the stall watchdog, whichever wire the node uses.
		 *
		 * The watchdog re-arms on every change to this number, so it has to track
		 * the fragment actually arriving. Under the view that is the decoded
		 * length of `html`; there is no JSON string left to measure, and reading
		 * `argsRaw` instead would pin the signal at -1 and let a still-growing
		 * stream be declared stalled.
		 *
		 * @param block - a live call node.
		 * @returns a growing size, or -1 when nothing is readable yet.
		 */
		function argumentSize(block) {
			if (!block || typeof block !== "object") return -1;
			if (typeof block.argsRaw === "string") return block.argsRaw.length;
			if (hasArgumentView(block) && typeof block.args.stringLength === "function") {
				const length = block.args.stringLength("html");
				return typeof length === "number" ? length : -1;
			}
			return -1;
		}

		/**
		 * Reduce a live call whose arguments arrive through that view.
		 *
		 * The view already tracks escapes and closing quotes, so this reads
		 * fields instead of scanning JSON. An unclosed fragment is still not
		 * shown — half-decoded markup in a frame is worse than a placeholder —
		 * unless the stream has stopped growing, which is the truncation case the
		 * salvage path exists for.
		 *
		 * @param view - the call node's `args`.
		 * @param stalled - whether the call has stopped growing.
		 * @returns the same state shape `readWidget` returns.
		 */
		function widgetFromView(view, stalled) {
			const html = viewText(view, "html");
			// `keys()` is what separates "the arguments have not started arriving"
			// from "they arrived and the fragment is missing": only the second can
			// be judged a truncation, the first is still worth waiting on.
			const arrived = typeof view.keys === "function" ? view.keys().length > 0 : true;
			if (typeof html !== "string" || html.trim() === "") {
				return stalled === true && arrived ? { status: "truncated" } : { status: "running" };
			}
			const rest = {
				title: viewText(view, "title"),
				height: viewValue(view, "height"),
				allowScripts: viewValue(view, "allowScripts"),
			};
			if (view.complete("html") === true) {
				return { status: "ready", ...normalize({ html, ...rest }) };
			}
			if (stalled !== true) return { status: "running" };
			const partial = salvageFragment(html);
			if (partial === null) return { status: "truncated" };
			return { status: "ready", ...normalize({ html: partial, ...rest, truncated: true }) };
		}

		/**
		 * Reduce one tool call node to the state the view renders.
		 *
		 * `block` is either a running call (arguments still streaming) or a
		 * settled result node. The fragment is read from the call's arguments in
		 * both cases: the result deliberately carries only an acknowledgement, so
		 * arguments are the single source of truth and the transcript stores the
		 * markup once.
		 *
		 * @param block - the frozen call node supplied by the tool slot.
		 * @param stalled - whether a running call has stopped growing, so what
		 *   arrived should be salvaged rather than waited on.
		 * @returns `{ status, html, title, height, allowScripts, error, truncated }`.
		 */
		function readWidget(block, stalled) {
			if (!block || typeof block !== "object") {
				return { status: "running" };
			}

			/** Recover a partial fragment, marking the card as cut short. */
			const salvaged = (raw) => {
				const partial = salvageFragment(extractOpenString(raw, "html"));
				if (partial === null) return null;
				const rest = parseWhole(raw) || {};
				// `truncated` must ride inside the normalize() input: it is a
				// declared field there, so a flag set on the result instead would be
				// overwritten by its default.
				return { status: "ready", ...normalize({ ...rest, html: partial, truncated: true }) };
			};

			if (block.kind === "tool-result") {
				if (block.isError) {
					// A call the harness closed without ever executing it — the
					// signature of a step cut off by the output ceiling. The
					// arguments still hold however much of the fragment arrived, so
					// recover it rather than discarding a nearly finished card.
					const code = block.error && block.error.code;
					if (UNEXECUTED_CODES.has(code)) {
						const recovered = salvaged(block.call && block.call.argsRaw);
						if (recovered !== null) return recovered;
						return { status: "truncated" };
					}
					return {
						status: "failed",
						error: block.error && (block.error.reason || block.error.code),
					};
				}
				// A window cut can leave the paired call outside the loaded slice.
				const raw = block.call && block.call.argsRaw;
				const args = parseWhole(raw);
				if (args && typeof args.html === "string" && args.html.trim() !== "") {
					return { status: "ready", ...normalize(args) };
				}
				// A window cut can drop the paired call while the node still
				// carries the settled argument view; read that before salvaging.
				if (typeof raw !== "string" && hasArgumentView(block)) {
					const fromView = widgetFromView(block.args, true);
					if (fromView.status !== "running") return fromView;
				}
				// An unexecuted call is settled as an error, but a *successful*
				// result whose arguments no longer parse arrived here through some
				// other cut; salvage what is left before giving up on it.
				const recovered = salvaged(raw);
				if (recovered !== null) return recovered;
				// Arguments were truncated away: recovering the markup from the
				// result content is not possible by design, so say so rather than
				// rendering an empty frame.
				return { status: "empty" };
			}

			// DSH 0.2 hands a streaming call's arguments over as a view rather than
			// a growing string, so read whichever wire this node carries.
			if (hasArgumentView(block)) return widgetFromView(block.args, stalled);

			// Running: prefer a whole parse, fall back to the streaming scan.
			const whole = parseWhole(block.argsRaw);
			if (whole && typeof whole.html === "string" && whole.html.trim() !== "") {
				return { status: "ready", ...normalize(whole) };
			}
			const partial = extractClosedString(block.argsRaw, "html");
			if (typeof partial === "string" && partial.trim() !== "") {
				const rest = parseWhole(block.argsRaw) || {};
				return { status: "ready", ...normalize({ ...rest, html: partial }) };
			}
			// Nothing closed yet. Once the stream has gone quiet, show the prefix
			// that did arrive instead of a placeholder that never resolves.
			// An empty payload is not evidence of truncation — argument streaming
			// may simply not have started — so only a payload that actually
			// arrived can be judged cut short.
			if (stalled === true && typeof block.argsRaw === "string" && block.argsRaw !== "") {
				const recovered = salvaged(block.argsRaw);
				if (recovered !== null) return recovered;
				return { status: "truncated" };
			}
			return { status: "running" };
		}

		/** Apply defaults and clamp the frame height. */
		function normalize(args) {
			const height = typeof args.height === "number" && Number.isFinite(args.height)
				? Math.round(args.height)
				: DEFAULT_HEIGHT;
			return {
				html: args.html,
				title: typeof args.title === "string" ? args.title : "",
				height: Math.min(Math.max(height, MIN_HEIGHT), MAX_HEIGHT),
				allowScripts: args.allowScripts === true,
				truncated: args.truncated === true,
			};
		}

		// ── theme ────────────────────────────────────────────────────────────

		/**
		 * Read the palette the app is currently painting with.
		 *
		 * ui-layout mirrors the resolved theme onto `body[data-ds-dark-theme]`.
		 * That attribute only states the dark case, so absence falls through to
		 * the media query — which is also what the `system` preference resolves to
		 * before the bootstrap script has run.
		 */
		function readDark() {
			if (typeof document === "undefined") return false;
			const marked = (el) =>
				!!el && (el.hasAttribute("data-ds-dark-theme") || el.getAttribute("data-theme") === "dark");
			if (marked(document.body) || marked(document.documentElement)) return true;
			return typeof matchMedia === "function"
				? matchMedia("(prefers-color-scheme: dark)").matches
				: false;
		}

		/** Track the host palette so the frame follows a theme switch live. */
		function useDark() {
			const [dark, setDark] = useState(readDark);
			useEffect(() => {
				const sync = () => setDark(readDark());
				sync();
				const observer = new MutationObserver(sync);
				const opts = { attributes: true, attributeFilter: ["data-ds-dark-theme", "data-theme", "class"] };
				if (document.body) observer.observe(document.body, opts);
				if (document.documentElement) observer.observe(document.documentElement, opts);
				const media = typeof matchMedia === "function"
					? matchMedia("(prefers-color-scheme: dark)")
					: null;
				if (media && media.addEventListener) media.addEventListener("change", sync);
				return () => {
					observer.disconnect();
					if (media && media.removeEventListener) media.removeEventListener("change", sync);
				};
			}, []);
			return dark;
		}

		/**
		 * Whether an unclosed fragment has stopped growing.
		 *
		 * The timer is rearmed on every change to `size`, so a stream that keeps
		 * delivering chunks is never called stalled; only a real gap of `STALL_MS`
		 * trips it. That gap is the whole point: a call killed by the model's
		 * output ceiling is never settled while the session is open, so without
		 * this the card would show a placeholder for as long as the session lives.
		 *
		 * @param live - whether the call is still unclosed.
		 * @param size - current length of the argument payload, the growth signal.
		 * @returns true once the payload has been quiet for `STALL_MS`.
		 */
		function useStalled(live, size) {
			const [stalled, setStalled] = useState(false);
			useEffect(() => {
				if (!live) {
					setStalled(false);
					return undefined;
				}
				setStalled(false);
				const timer = setTimeout(() => setStalled(true), STALL_MS);
				return () => clearTimeout(timer);
			}, [live, size]);
			return stalled;
		}

		// ── frame document ───────────────────────────────────────────────────

		/**
		 * Build the frame document that hosts one fragment.
		 *
		 * The CSP is the hard boundary: `default-src 'none'` means a stray CDN
		 * import, remote font, or `fetch` fails closed instead of silently
		 * exfiltrating. Styles stay inline-only, images must be `data:` or `blob:`,
		 * and scripts are reachable only when the caller opted in — in which case
		 * they still run in an opaque origin because the frame is sandboxed
		 * without `allow-same-origin`.
		 *
		 * The palette is emitted here rather than left to `prefers-color-scheme`
		 * because the frame cannot see the app's explicit light/dark choice.
		 *
		 * @param html - the untrusted fragment.
		 * @param dark - whether the host is painting dark.
		 * @param allowScripts - whether the fragment may execute script.
		 */
		function buildSrcDoc(html, dark, allowScripts) {
			const scheme = dark ? "dark" : "light";
			const bg = dark ? "#14161c" : "#ffffff";
			const fg = dark ? "#e6e8ee" : "#1c1e24";
			const border = dark ? "rgba(255,255,255,.10)" : "rgba(0,0,0,.10)";
			const scriptSrc = allowScripts ? "'unsafe-inline'" : "'none'";

			return [
				"<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">",
				"<meta http-equiv=\"Content-Security-Policy\" content=\"",
				"default-src 'none'; ",
				`script-src ${scriptSrc}; `,
				"style-src 'unsafe-inline'; ",
				"img-src data: blob:; ",
				"font-src data:; ",
				"media-src data: blob:; ",
				"connect-src 'none'; ",
				"form-action 'none'; ",
				"base-uri 'none';\">",
				`<style>
:root{color-scheme:${scheme}}
html,body{margin:0;padding:0;background:${bg};color:${fg};
  font:13px/1.55 system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif;
  -webkit-font-smoothing:antialiased}
body{padding:12px;overflow:auto;overflow-wrap:anywhere}
*,*::before,*::after{box-sizing:border-box}
svg{max-width:100%;height:auto;display:block;margin-inline:auto}
img,canvas,video{max-width:100%;height:auto}
table{border-collapse:collapse;max-width:100%}
th,td{border:1px solid ${border};padding:4px 8px;text-align:left}
a{color:inherit;text-decoration:underline}
</style></head><body>`,
				html,
				"</body></html>",
			].join("");
		}

		// ── view ─────────────────────────────────────────────────────────────

		const HAIRLINE = "1px solid rgba(127,127,127,.28)";
		const MUTED = "rgba(127,127,127,.95)";

		const S = {
			card: {
				border: HAIRLINE,
				borderRadius: 10,
				overflow: "hidden",
				margin: "6px 0",
				color: "inherit",
			},
			head: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "5px 9px",
				borderBottom: HAIRLINE,
				fontSize: 12,
				lineHeight: "18px",
			},
			headButton: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				flex: 1,
				minWidth: 0,
				background: "none",
				border: 0,
				padding: 0,
				margin: 0,
				color: "inherit",
				font: "inherit",
				textAlign: "left",
				cursor: "pointer",
			},
			title: {
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
				fontWeight: 500,
			},
			badge: {
				flex: "none",
				marginLeft: "auto",
				color: MUTED,
				fontSize: 11,
				whiteSpace: "nowrap",
			},
			action: {
				flex: "none",
				background: "none",
				border: 0,
				padding: "0 2px",
				margin: 0,
				color: MUTED,
				font: "inherit",
				cursor: "pointer",
				textDecoration: "underline",
			},
			note: {
				padding: "10px 12px",
				color: MUTED,
				fontSize: 12,
			},
			warn: {
				padding: "6px 9px",
				borderBottom: HAIRLINE,
				color: MUTED,
				fontSize: 11.5,
				lineHeight: "16px",
			},
		};

		/**
		 * One inline visual card, with its own disclosure and frame.
		 *
		 * Shared by both places a widget can appear — the tool row inside the
		 * Turn's process group, and the Turn-level node that stands outside that
		 * group — so the two render identically and only the projection differs.
		 *
		 * @param props - `{ widget, inspect }`; `widget` is a `readWidget` state.
		 */
		function WidgetCard({ widget, inspect }) {
			const dark = useDark();
			const [open, setOpen] = useState(true);

			const srcDoc = useMemo(
				() => (widget.status === "ready"
					? buildSrcDoc(widget.html, dark, widget.allowScripts)
					: ""),
				[widget, dark],
			);

			const toggle = useCallback(() => setOpen((value) => !value), []);
			const onInspect = useCallback(() => {
				if (typeof inspect === "function") inspect();
			}, [inspect]);

			const label = widget.status === "ready" && widget.title
				? widget.title
				: "render_widget";

			const badge = widget.status === "ready"
				? (widget.allowScripts ? STRINGS.scriptsOn : `${Math.round(widget.html.length / 1024)} KB`)
				: "";

			const header = h(
				"div",
				{ style: S.head },
				h(
					"button",
					{
						type: "button",
						style: S.headButton,
						onClick: toggle,
						"aria-expanded": open,
						title: open ? STRINGS.collapse : STRINGS.expand,
					},
					h("span", { style: { flex: "none", width: 8, color: MUTED } }, open ? "\u25be" : "\u25b8"),
					h("span", { style: S.title }, label),
				),
				badge ? h("span", { style: S.badge }, badge) : null,
				typeof inspect === "function"
					? h("button", { type: "button", style: S.action, onClick: onInspect }, "Inspect")
					: null,
			);

			let body;
			if (widget.status === "ready") {
				body = h(
					"div",
					null,
					// A salvaged fragment is worth showing, but not worth passing off
					// as the whole figure: say plainly that it was cut short.
					widget.truncated
						? h("div", { style: S.warn }, `${STRINGS.truncated} — ${STRINGS.truncatedHint}`)
						: null,
					h("iframe", {
						// Never add `allow-same-origin` alongside `allow-scripts`: the pair
						// would let the fragment reach into the host document.
						sandbox: widget.allowScripts ? "allow-scripts" : "",
						srcDoc,
						title: widget.title || "inline visual",
						loading: "lazy",
						style: {
							display: "block",
							width: "100%",
							border: 0,
							height: open ? widget.height : 0,
							background: "transparent",
						},
					}),
				);
			} else if (widget.status === "failed") {
				body = h(
					"div",
					{ style: S.note },
					STRINGS.runFailed + (widget.error ? `: ${widget.error}` : `: ${STRINGS.unknownFailure}`),
				);
			} else if (widget.status === "truncated") {
				// The step was cut off before the fragment was usable at all.
				body = h("div", { style: S.warn }, STRINGS.truncatedNone);
			} else if (widget.status === "empty") {
				body = h("div", { style: S.note }, STRINGS.tooLarge);
			} else {
				body = h("div", { style: S.note }, STRINGS.generating);
			}

			return h("div", { style: S.card, "data-dsh-widget": widget.status }, header, body);
		}

		/**
		 * Whether a widget is drawn at Turn level rather than in this tool row.
		 *
		 * Both sides ask this one question, which is what keeps the card from
		 * appearing twice: the projection creates the Turn-level node exactly when
		 * this is true, and the row collapses to a stand-in exactly when it is.
		 *
		 * @param widget - `readWidget` state.
		 * @returns whether the card lives outside the process group.
		 */
		function projectedToTurn(widget) {
			return cardAtTurnLevel && (widget.status === "ready" || widget.status === "truncated");
		}

		/**
		 * The one-line stand-in a folded process group keeps for a projected call.
		 *
		 * In `compact`, `standard` and `detailed` presentation modes every Turn's
		 * tool calls fold into a process group; the card is projected at Turn level
		 * so it stays visible without expanding that group. This is what remains
		 * inside the group, so expanding it does not show the same figure twice.
		 *
		 * @param props - `{ widget, inspect }`.
		 */
		function CompactWidgetRow({ widget, inspect }) {
			const onInspect = useCallback(() => {
				if (typeof inspect === "function") inspect();
			}, [inspect]);
			const label = widget.status === "ready" && widget.title ? widget.title : "render_widget";
			const size = widget.status === "ready" ? ` · ${Math.round(widget.html.length / 1024)} KB` : "";
			return h(
				"div",
				{ style: { ...S.head, borderBottom: 0 }, "data-dsh-widget-compact": widget.status },
				h(
					"span",
					{ style: { ...S.headButton, cursor: "default" } },
					h("span", { style: { flex: "none", width: 8, color: MUTED, opacity: 0 } }, "\u25be"),
					h("span", { style: S.title }, label),
				),
				h("span", { style: S.badge }, `${STRINGS.shownAbove}${size}`),
				typeof inspect === "function"
					? h("button", { type: "button", style: S.action, onClick: onInspect }, "Inspect")
					: null,
			);
		}

		/**
		 * The tool row's view.
		 *
		 * A settled call node always produces the same card, which keeps it valid
		 * under session-log replay. The one time-dependent input is the watchdog
		 * on a still-streaming call; replay only ever sees settled nodes, since
		 * reopening a session closes any dangling call first.
		 *
		 * @param props - the registered tool view payload.
		 */
		function WidgetView(props) {
			const { block, inspect } = props;

			// A call still in its streaming phase gets a watchdog; a settled one
			// never can stall.
			const live = !!block && typeof block === "object" && block.kind !== "tool-result";
			const size = live ? argumentSize(block) : -1;
			const stalled = useStalled(live, size);

			const widget = useMemo(() => readWidget(block, stalled), [block, stalled]);

			// The card itself is rendered at Turn level; this row only says where.
			if (projectedToTurn(widget)) return h(CompactWidgetRow, { widget, inspect });

			return h(WidgetCard, { widget, inspect });
		}

		/**
		 * The Turn-level view: a widget node's own payload, drawn as the same card.
		 *
		 * Receives the chat node's registered payload rather than a tool block, so
		 * it has nothing to project — `data.widget` is already the state the tool
		 * row computed from the stored arguments.
		 *
		 * @param props - `{ node, inspectCall }` from the chat node slot.
		 */
		function WidgetNode(props) {
			const { node, inspectCall } = props;
			const data = node && node.data;
			if (!data || !data.widget) return null;
			const inspect = typeof inspectCall === "function" && data.callId
				? () => inspectCall(data.callId)
				: undefined;
			return h(WidgetCard, { widget: data.widget, inspect });
		}

		// ── Turn-level projection ────────────────────────────────────────────

		/**
		 * Whether the Turn-level projection registered.
		 *
		 * False until `apply` proves the conversation service accepts our
		 * definition. It decides both whether the node is built and whether the
		 * tool row collapses to a stand-in, so a host that refuses the definition
		 * keeps the card exactly where it has always been.
		 */
		let cardAtTurnLevel = false;

		/** Chat node kind this plugin owns; also the key of its `conversation.chat.node` slot. */
		const WIDGET_NODE_KIND = "dsh-widget-card";

		/** Wire name of the tool this projection mirrors. */
		const WIDGET_TOOL_NAME = "render_widget";

		/**
		 * Call ids this definition saw start.
		 *
		 * A `tool/result` event carries a `callId` but no tool name, so the result
		 * is routed only when its call was already routed as a widget. Without this
		 * the engine would open a context for every tool result in the session and
		 * this Definition would be asked to build a node for all of them.
		 */
		const widgetCallIds = new Set();

		/**
		 * Read one `tool/result` payload defensively.
		 * @param event - a `tool/result` Session event.
		 * @returns `{ callId, isError, error }` or null when the shape is unknown.
		 */
		function resultOf(event) {
			const data = event && event.data;
			const message = data && data.message;
			const source = message && message.source;
			const callId = source && source.callId;
			if (typeof callId !== "string" || callId === "") return null;
			return {
				callId,
				isError: message.isError === true,
				error: data.error,
			};
		}

		/**
		 * Build this plugin's conversation Definition.
		 *
		 * Why a node at all: `compact`, `standard` and `detailed` presentation modes
		 * fold a Turn's tool calls into a process group, and a tool node carries no
		 * `groupTree` — so it always lands inside that group and the card needs an
		 * expand to be seen. A node that declares `groupTree: "turn"` is
		 * at-or-outside `"process"` in the engine's group tree, so the group is
		 * flushed before it and the card renders in the flow.
		 *
		 * The engine permits a second Definition on the same event: a claim is only
		 * exclusive when the match result says `exclusive: true`, and the chat
		 * package's tool Definition never does.
		 *
		 * @returns a Definition for `uiConversation.events.register`.
		 */
		function defineWidgetNode() {
			return {
				kind: WIDGET_NODE_KIND,
				target: "chat",
				match: (event) => {
					if (event.type === "tool/call") {
						const data = event.data;
						if (!data || data.name !== WIDGET_TOOL_NAME) return null;
						const id = String(data.callId);
						widgetCallIds.add(id);
						return { id, role: "start" };
					}
					if (event.type === "tool/result") {
						// A result carries no tool name; route it only for a call this
						// definition started. `buildViewNode` still drops it when the
						// start never produced state (a window cut).
						const result = resultOf(event);
						if (result === null || !widgetCallIds.has(result.callId)) return null;
						return { id: result.callId, role: "update" };
					}
					return null;
				},
				start: (_context, match) => {
					const data = match.event.data;
					return {
						argsRaw: typeof data.arguments === "string" ? data.arguments : "",
						settled: false,
						failed: false,
						error: undefined,
					};
				},
				update: (context, match) => {
					const result = resultOf(match.event);
					if (result === null) return context.state;
					return { ...context.state, settled: true, failed: result.isError, error: result.error };
				},
				publication: () => "immediate",
				buildViewNode: (context) => {
					const state = context.state;
					// Only a settled call is projected: while arguments still stream the
					// tool row is the better surface (it has the stall watchdog and the
					// growing-fragment preview), and a call whose start this definition
					// never matched has no state at all.
					if (state === undefined || state.settled !== true) return null;

					const widget = readWidget({
						kind: "tool-result",
						isError: state.failed,
						error: state.error,
						call: state.argsRaw === "" ? null : { argsRaw: state.argsRaw },
					}, false);

					// Errors and unreadable payloads stay in the group: they are tool
					// diagnostics, not something the reader came for.
					if (widget.status !== "ready" && widget.status !== "truncated") return null;

					return {
						key: context.key,
						kind: WIDGET_NODE_KIND,
						id: context.id,
						target: "chat",
						anchorSeq: context.start ? context.start.event.seq : context.matches[0]?.event.seq ?? 0,
						location: context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" },
						visibility: "visible",
						// The whole point: at-or-outside "process", so the group is
						// flushed before this node instead of swallowing it.
						groupTree: "turn",
						data: { widget, callId: context.id },
					};
				},
			};
		}

		// ── plugin ───────────────────────────────────────────────────────────

		/**
		 * Services this plugin needs.
		 *
		 * `uiConversation` is the chat engine's event registry. It is injected
		 * rather than looked up so the Turn-level projection is registered only
		 * once the service that accepts it exists; the plugin still works without
		 * chat (`slots` alone renders the card in the tool row).
		 */
		const inject = ["slots", "uiConversation"];

		/**
		 * Claim the widget in both places it can render.
		 *
		 * `tool.call.toolview` replaces the generic tool row; `conversation.chat.node`
		 * draws the Turn-level card. `ctx.slots.inject` (not a plain `register`)
		 * defers each registration until the slot's declaring entry is present and
		 * ties its lifetime to this plugin's context — unload and HMR reverse both.
		 *
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.slots.inject("tool.call.toolview", () =>
				ctx.slots.register(
					{
						name: "tool.call.toolview",
						key: WIDGET_TOOL_NAME,
					},
					WidgetView,
				),
			);

			ctx.slots.inject("conversation.chat.node", () =>
				ctx.slots.register(
					{
						name: "conversation.chat.node",
						key: WIDGET_NODE_KIND,
					},
					WidgetNode,
				),
			);

			try {
				ctx.uiConversation.events.register(defineWidgetNode());
				cardAtTurnLevel = true;
			} catch (error) {
				// A conversation API that refuses this definition must cost the card its
				// position, never its existence: the row keeps drawing it.
				cardAtTurnLevel = false;
				if (typeof console !== "undefined" && typeof console.warn === "function") {
					console.warn("dsh-widget: Turn-level card unavailable; keeping the card in the tool row.", error);
				}
			}
		}

		// Function form: named exports only, never a default export alongside.
		exports.apply = apply;
		exports.inject = inject;
		// The pure projections are exposed so they can be exercised without a
		// browser; the module loader ignores every key it does not look up.
		exports.__internals = {
			readWidget,
			normalize,
			extractClosedString,
			extractOpenString,
			salvageFragment,
			buildSrcDoc,
			argumentSize,
			hasArgumentView,
			defineWidgetNode,
			resultOf,
			WIDGET_NODE_KIND,
			WIDGET_TOOL_NAME,
		};
		return module.exports;
	},
});
