(function() {
	// src/shared/config.js
	var BODY_LIMIT = 65536;
	var TEXT_LIMIT = 1e4;
	// src/shared/events.js
	function truncate(text, limit) {
		const s = String(text ?? "");
		return s.length > limit ? {
			value: s.slice(0, limit),
			truncated: true
		} : {
			value: s,
			truncated: false
		};
	}
	function stringify(value) {
		const seen = /* @__PURE__ */ new WeakSet();
		return JSON.stringify(value, (_k, v) => {
			if (typeof v === "object" && v !== null) {
				if (seen.has(v)) return "[Circular]";
				seen.add(v);
			}
			if (typeof v === "bigint") return `${v}n`;
			if (typeof v === "function") return `function ${v.name || "anonymous"}`;
			return v;
		});
	}
	function argToText(arg) {
		if (typeof arg === "string") return arg;
		if (arg === void 0) return "undefined";
		if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
		if (typeof arg === "object" && arg !== null && typeof Node !== "undefined" && arg instanceof Node) return `<${arg.nodeName.toLowerCase()}>`;
		try {
			return typeof arg === "object" && arg !== null ? stringify(arg) : String(arg);
		} catch {
			return String(arg);
		}
	}
	/** What DevTools would roughly show for console.log(...args), capped at TEXT_LIMIT. */
	function consoleArgsToText(args) {
		return truncate(args.map(argToText).join(" "), TEXT_LIMIT).value;
	}
	var FONT = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;
	var MEDIA = /\.(mp4|webm|mp3|ogg|wav|m3u8|mov)(\?|#|$)/i;
	/** PerformanceResourceTiming.initiatorType + URL → the bundle's network `type`. */
	function resourceType(initiatorType, url) {
		if (FONT.test(url)) return "font";
		switch (initiatorType) {
			case "script": return "js";
			case "link":
			case "css": return /\.css(\?|#|$)/i.test(url) || initiatorType === "link" ? "css" : "other";
			case "img":
			case "image":
			case "imageset": return "img";
			case "video":
			case "audio":
			case "track": return "media";
			case "iframe":
			case "frame":
			case "navigation": return "doc";
			default: return MEDIA.test(url) ? "media" : "other";
		}
	}
	/**
	* Bodies we read: text-like ones. Streaming formats (event streams, NDJSON / JSON Lines / JSON text
	* sequences, `+stream` types) and binaries are never read: reading a copy would keep the
	* connection open after the page stops reading.
	*/
	function isTextual(contentType) {
		if (!contentType) return false;
		const ct = contentType.toLowerCase();
		if (/event-stream|ndjson|jsonl|json-seq|stream/.test(ct)) return false;
		return /json|text\/|xml|x-www-form-urlencoded|graphql|javascript/.test(ct);
	}
	/**
	* JSON.stringify that stops once the text passes `limit` characters, so a large JSON response
	* (XMLHttpRequest with responseType 'json') is never serialized whole on the page's main thread.
	*/
	function stringifyCapped(value, limit) {
		const parts = [];
		let length = 0;
		const STOP = {};
		const put = (text) => {
			parts.push(text);
			length += text.length;
			if (length > limit) throw STOP;
		};
		const walk = (v) => {
			if (v === null || typeof v === "number" || typeof v === "boolean" || typeof v === "string") return put(JSON.stringify(v));
			if (Array.isArray(v)) {
				put("[");
				v.forEach((item, i) => {
					if (i) put(",");
					if (item === void 0 || typeof item === "function") put("null");
					else walk(item);
				});
				return put("]");
			}
			if (typeof v === "object") {
				put("{");
				let first = true;
				for (const [key, item] of Object.entries(v)) {
					if (item === void 0 || typeof item === "function") continue;
					if (!first) put(",");
					first = false;
					put(`${JSON.stringify(key)}:`);
					walk(item);
				}
				return put("}");
			}
			return put("null");
		};
		try {
			walk(value);
			return {
				value: parts.join(""),
				truncated: false
			};
		} catch (err) {
			if (err !== STOP) throw err;
			return {
				value: parts.join("").slice(0, limit),
				truncated: true
			};
		}
	}
	// src/shared/selector.js
	var MAX_DEPTH = 4;
	var TEXT_MAX = 80;
	function esc(s) {
		return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&");
	}
	function step(el) {
		const classes = [...el.classList].filter((c) => /^[a-zA-Z_-][\w-]*$/.test(c)).slice(0, 2);
		return el.tagName.toLowerCase() + classes.map((c) => `.${esc(c)}`).join("");
	}
	/** A short selector a developer can recognise: #id, [data-testid], else up to four tag.class steps. */
	function cssSelector(el) {
		if (!el || el.nodeType !== 1) return "";
		if (el.id) return `#${esc(el.id)}`;
		const testId = el.getAttribute("data-testid");
		if (testId) return `[data-testid="${testId.replace(/"/g, "\\\"")}"]`;
		const parts = [];
		let node = el;
		while (node && node.nodeType === 1 && parts.length < MAX_DEPTH && node !== document.body && node !== document.documentElement) {
			if (node !== el && node.id) {
				parts.unshift(`#${esc(node.id)}`);
				break;
			}
			parts.unshift(step(node));
			node = node.parentElement;
		}
		return parts.join(" > ");
	}
	var FIELDS = /* @__PURE__ */ new Set([
		"INPUT",
		"TEXTAREA",
		"SELECT"
	]);
	/** Visible label of an element, collapsed and capped. Never what was typed into a field. */
	function elementText(el) {
		if (!el || el.nodeType !== 1) return "";
		let text;
		if (FIELDS.has(el.tagName) || el.isContentEditable) text = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || "";
		else text = el.getAttribute("aria-label") || el.innerText || el.textContent || "";
		return text.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
	}
	// src/page/main-world.js
	(() => {
		if (window.__midgePatched) return;
		Object.defineProperty(window, "__midgePatched", { value: true });
		const emit = (event) => {
			try {
				window.dispatchEvent(new CustomEvent("midge:event", { detail: JSON.stringify(event) }));
			} catch {}
		};
		const now = () => Date.now();
		const stackOf = (args) => {
			const stack = args.find((a) => a instanceof Error)?.stack ?? (/* @__PURE__ */ new Error()).stack?.split("\n").slice(3).join("\n");
			return stack ? truncate(stack, TEXT_LIMIT).value : void 0;
		};
		for (const level of [
			"log",
			"info",
			"warn",
			"error",
			"debug"
		]) {
			const original = console[level];
			console[level] = function(...args) {
				try {
					emit({
						kind: "console",
						at: now(),
						level,
						text: consoleArgsToText(args),
						...level === "error" ? { stack: stackOf(args) } : {}
					});
				} catch {}
				return original.apply(this, args);
			};
		}
		window.addEventListener("error", (e) => {
			if (e.error || e.message) emit({
				kind: "console",
				at: now(),
				level: "error",
				text: e.error ? `${e.error.name}: ${e.error.message}` : String(e.message),
				stack: e.error?.stack
			});
		});
		window.addEventListener("unhandledrejection", (e) => {
			const r = e.reason;
			emit({
				kind: "console",
				at: now(),
				level: "error",
				text: `Uncaught (in promise) ${r instanceof Error ? `${r.name}: ${r.message}` : consoleArgsToText([r])}`,
				stack: r?.stack
			});
		});
		const headerPairs = (headers) => {
			const out = [];
			try {
				if (!headers) return out;
				if (headers instanceof Headers) headers.forEach((v, k) => out.push([k.toLowerCase(), v]));
				else if (Array.isArray(headers)) for (const [k, v] of headers) out.push([String(k).toLowerCase(), String(v)]);
				else for (const [k, v] of Object.entries(headers)) out.push([k.toLowerCase(), String(v)]);
			} catch {}
			return out;
		};
		const describeBody = (body) => {
			if (body == null) return void 0;
			if (typeof body === "string") return truncate(body, BODY_LIMIT).value;
			if (body instanceof URLSearchParams) return truncate(body.toString(), BODY_LIMIT).value;
			if (body instanceof FormData) return "[form data]";
			const size = body.size ?? body.byteLength;
			return size !== void 0 ? `[binary ${size} bytes]` : void 0;
		};
		const READ_MS = 5e3;
		const readCapped = async (response) => {
			const reader = response.body?.getReader();
			if (!reader) return {
				value: "",
				truncated: false
			};
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				reader.cancel().catch(() => {});
			}, READ_MS);
			const decoder = new TextDecoder();
			let text = "";
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					text += decoder.decode(value, { stream: true });
					if (text.length > 65536) {
						reader.cancel().catch(() => {});
						return {
							value: text.slice(0, BODY_LIMIT),
							truncated: true
						};
					}
				}
			} finally {
				clearTimeout(timer);
			}
			return {
				value: text,
				truncated: timedOut
			};
		};
		const originalFetch = window.fetch;
		window.fetch = function(input, init) {
			const at = now();
			const t0 = performance.now();
			let method = "GET";
			let url = "";
			let requestHeaders = [];
			try {
				const req = input instanceof Request ? input : null;
				method = (init?.method ?? req?.method ?? "GET").toUpperCase();
				url = new URL(req ? req.url : String(input), location.href).href;
				requestHeaders = headerPairs(init?.headers ?? req?.headers);
			} catch {}
			const requestBody = describeBody(init?.body);
			const promise = originalFetch.apply(this, arguments);
			promise.then((response) => {
				const base = {
					kind: "network",
					at,
					method,
					url,
					status: response.status,
					type: "fetch",
					durationMs: Math.round(performance.now() - t0),
					requestHeaders,
					responseHeaders: headerPairs(response.headers),
					...requestBody !== void 0 ? { requestBody } : {}
				};
				if (!isTextual(response.headers.get("content-type"))) return emit(base);
				let copy;
				try {
					copy = response.clone();
				} catch {
					return emit(base);
				}
				readCapped(copy).then((body) => emit({
					...base,
					responseBody: body.value,
					...body.truncated ? { truncated: true } : {}
				}), () => emit(base));
			}, (error) => emit({
				kind: "network",
				at,
				method,
				url,
				status: 0,
				type: "fetch",
				durationMs: Math.round(performance.now() - t0),
				requestHeaders,
				error: String(error?.message ?? error),
				...requestBody !== void 0 ? { requestBody } : {}
			}));
			return promise;
		};
		const XHR = XMLHttpRequest.prototype;
		const { open, send, setRequestHeader } = XHR;
		const META = Symbol("midge");
		XHR.open = function(method, url) {
			try {
				this[META] = {
					method: String(method).toUpperCase(),
					url: new URL(String(url), location.href).href,
					headers: []
				};
			} catch {}
			return open.apply(this, arguments);
		};
		XHR.setRequestHeader = function(name, value) {
			this[META]?.headers.push([String(name).toLowerCase(), String(value)]);
			return setRequestHeader.apply(this, arguments);
		};
		XHR.send = function(body) {
			const meta = this[META];
			if (meta) {
				const at = now();
				const t0 = performance.now();
				const requestBody = describeBody(body);
				this.addEventListener("loadend", () => {
					const responseHeaders = (this.getAllResponseHeaders() || "").trim().split(/\r?\n/).filter(Boolean).map((line) => {
						const i = line.indexOf(":");
						return [line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()];
					});
					let responseBody;
					try {
						if (this.responseType === "" || this.responseType === "text") responseBody = this.responseText;
						else if (this.responseType === "json") responseBody = stringifyCapped(this.response, 65537).value;
					} catch {}
					const body = isTextual(this.getResponseHeader("content-type")) && responseBody != null ? truncate(responseBody, BODY_LIMIT) : null;
					emit({
						kind: "network",
						at,
						method: meta.method,
						url: meta.url,
						status: this.status,
						type: "xhr",
						durationMs: Math.round(performance.now() - t0),
						requestHeaders: meta.headers,
						responseHeaders,
						...requestBody !== void 0 ? { requestBody } : {},
						...body ? {
							responseBody: body.value,
							...body.truncated ? { truncated: true } : {}
						} : {}
					});
				});
			}
			return send.apply(this, arguments);
		};
		const OriginalWS = window.WebSocket;
		if (OriginalWS) {
			const wsData = (data) => typeof data === "string" ? truncate(data, BODY_LIMIT).value : `[binary ${data?.size ?? data?.byteLength ?? 0} bytes]`;
			const originalSend = OriginalWS.prototype.send;
			OriginalWS.prototype.send = function(data) {
				emit({
					kind: "ws",
					at: now(),
					url: this.url,
					direction: "sent",
					data: wsData(data)
				});
				return originalSend.apply(this, arguments);
			};
			window.WebSocket = new Proxy(OriginalWS, { construct(target, args, newTarget) {
				const ws = Reflect.construct(target, args, newTarget);
				ws.addEventListener("message", (e) => emit({
					kind: "ws",
					at: now(),
					url: ws.url,
					direction: "received",
					data: wsData(e.data)
				}));
				return ws;
			} });
		}
		const navigated = () => emit({
			kind: "navigation",
			at: now(),
			url: location.href,
			title: document.title
		});
		for (const name of ["pushState", "replaceState"]) {
			const original = history[name];
			history[name] = function() {
				const result = original.apply(this, arguments);
				navigated();
				return result;
			};
		}
		window.addEventListener("popstate", navigated);
		window.addEventListener("hashchange", navigated);
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", navigated, { once: true });
		else navigated();
		document.addEventListener("click", (e) => {
			const el = e.target instanceof Element ? e.target.closest("button, a, input, select, textarea, [role], label, summary") ?? e.target : null;
			if (el) emit({
				kind: "action",
				at: now(),
				action: "click",
				selector: cssSelector(el),
				text: elementText(el)
			});
		}, true);
		const lastInput = /* @__PURE__ */ new WeakMap();
		document.addEventListener("input", (e) => {
			const el = e.target;
			if (!(el instanceof Element)) return;
			const t = now();
			if (t - (lastInput.get(el) ?? 0) < 1e3) return;
			lastInput.set(el, t);
			emit({
				kind: "action",
				at: t,
				action: "input",
				selector: cssSelector(el),
				text: elementText(el)
			});
		}, true);
		let lastScroll = 0;
		window.addEventListener("scroll", () => {
			const t = now();
			if (t - lastScroll < 1e3) return;
			lastScroll = t;
			emit({
				kind: "action",
				at: t,
				action: "scroll",
				text: `${Math.round(scrollX)},${Math.round(scrollY)}`
			});
		}, {
			passive: true,
			capture: true
		});
		document.addEventListener("visibilitychange", () => emit({
			kind: "action",
			at: now(),
			action: "tab",
			text: document.visibilityState
		}));
		const FAILED = "Didn't load (Safari doesn't report the status code)";
		const failedUrls = /* @__PURE__ */ new Map();
		const SETTLE_MS = 1e3;
		const resourceEvent = (entry, failed) => ({
			kind: "network",
			at: Math.round(performance.timeOrigin + entry.startTime),
			method: "GET",
			url: entry.name,
			status: failed ? 0 : null,
			type: resourceType(entry.initiatorType, entry.name),
			durationMs: Math.round(entry.duration),
			...failed ? { error: FAILED } : {}
		});
		window.addEventListener("error", (e) => {
			if ("responseStatus" in PerformanceResourceTiming.prototype) return;
			const el = e.target;
			if (!(el instanceof HTMLImageElement || el instanceof HTMLScriptElement || el instanceof HTMLLinkElement || el instanceof HTMLMediaElement || el instanceof HTMLSourceElement)) return;
			const url = el instanceof HTMLLinkElement ? el.href : el.currentSrc || el.src;
			if (!url || failedUrls.has(url)) return;
			const at = Date.now();
			failedUrls.set(url, at);
			setTimeout(() => {
				if (failedUrls.get(url) !== at) return;
				failedUrls.delete(url);
				emit({
					kind: "network",
					at,
					method: "GET",
					url,
					status: 0,
					type: resourceType(el.localName === "source" ? "video" : el.localName, url),
					durationMs: 0,
					error: FAILED
				});
			}, SETTLE_MS * 2);
		}, true);
		try {
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					if ([
						"fetch",
						"xmlhttprequest",
						"beacon"
					].includes(entry.initiatorType)) continue;
					if (entry.responseStatus !== void 0) {
						emit({
							kind: "network",
							at: Math.round(performance.timeOrigin + entry.startTime),
							method: "GET",
							url: entry.name,
							status: entry.responseStatus,
							type: resourceType(entry.initiatorType, entry.name),
							durationMs: Math.round(entry.duration)
						});
						continue;
					}
					setTimeout(() => {
						const failed = failedUrls.has(entry.name);
						failedUrls.delete(entry.name);
						emit(resourceEvent(entry, failed));
					}, SETTLE_MS);
				}
			}).observe({
				type: "resource",
				buffered: true
			});
		} catch {}
	})();
	// src/jsc/page.js
	(() => {
		if (typeof window.__midgeEmit !== "function" || window.__midgeForwarding) return;
		Object.defineProperty(window, "__midgeForwarding", { value: true });
		window.addEventListener("midge:event", (e) => {
			try {
				if (typeof e.detail === "string") window.__midgeEmit(e.detail);
			} catch {}
		});
	})();
})();
