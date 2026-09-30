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
			}
			: {
				generating: "Building visual…",
				collapse: "Collapse",
				expand: "Expand",
				runFailed: "Visual failed to render",
				unknownFailure: "The tool reported an error",
				tooLarge: "Fragment too large to render",
				scriptsOn: "scripts enabled",
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
		 * Reduce one tool call node to the state the view renders.
		 *
		 * `block` is either a running call (arguments still streaming) or a
		 * settled result node. The fragment is read from the call's arguments in
		 * both cases: the result deliberately carries only an acknowledgement, so
		 * arguments are the single source of truth and the transcript stores the
		 * markup once.
		 *
		 * @param block - the frozen call node supplied by the tool slot.
		 * @returns `{ status, html, title, height, allowScripts, error }`.
		 */
		function readWidget(block) {
			if (!block || typeof block !== "object") {
				return { status: "running" };
			}

			if (block.kind === "tool-result") {
				if (block.isError) {
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
				// Arguments were truncated away: recovering the markup from the
				// result content is not possible by design, so say so rather than
				// rendering an empty frame.
				return { status: "empty" };
			}

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
		};

		/**
		 * One inline visual card.
		 *
		 * Pure function of the frozen call node: the same props always produce
		 * the same card, which keeps it valid under session-log replay.
		 *
		 * @param props - the registered tool view payload.
		 */
		function WidgetView(props) {
			const { block, inspect } = props;
			const dark = useDark();
			const [open, setOpen] = useState(true);

			const widget = useMemo(() => readWidget(block), [block]);

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
				body = h("iframe", {
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
				});
			} else if (widget.status === "failed") {
				body = h(
					"div",
					{ style: S.note },
					STRINGS.runFailed + (widget.error ? `: ${widget.error}` : `: ${STRINGS.unknownFailure}`),
				);
			} else if (widget.status === "empty") {
				body = h("div", { style: S.note }, STRINGS.tooLarge);
			} else {
				body = h("div", { style: S.note }, STRINGS.generating);
			}

			return h("div", { style: S.card, "data-dsh-widget": widget.status }, header, body);
		}

		// ── plugin ───────────────────────────────────────────────────────────

		/** The only service this plugin needs: the slot registry. */
		const inject = ["slots"];

		/**
		 * Claim the `render_widget` tool name in the keyed tool view slot.
		 *
		 * `inject` (not a plain `register`) defers registration until the slot's
		 * declaring entry is present, and ties the registration's lifetime to this
		 * plugin's context — unload and HMR both reverse it.
		 *
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.slots.inject("tool.call.toolview", () =>
				ctx.slots.register(
					{
						name: "tool.call.toolview",
						key: "render_widget",
					},
					WidgetView,
				),
			);
		}

		// Function form: named exports only, never a default export alongside.
		exports.apply = apply;
		exports.inject = inject;
		// The pure projections are exposed so they can be exercised without a
		// browser; the module loader ignores every key it does not look up.
		exports.__internals = { readWidget, normalize, extractClosedString, buildSrcDoc };
		return module.exports;
	},
});
