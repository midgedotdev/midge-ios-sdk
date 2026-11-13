(function() {
	// ../packages/redaction/src/primitives.js
	/** Placeholder written in place of every redacted value. */
	var REDACTED = "[REDACTED]";
	/**
	* Luhn checksum over the digits of `value` (non-digits are ignored).
	* @param {string} value
	* @returns {boolean}
	*/
	function isLuhnValid(value) {
		const digits = value.replace(/\D/g, "");
		if (digits.length === 0) return false;
		let sum = 0;
		let double = false;
		for (let i = digits.length - 1; i >= 0; i--) {
			let n = digits.charCodeAt(i) - 48;
			if (double) {
				n *= 2;
				if (n > 9) n -= 9;
			}
			sum += n;
			double = !double;
		}
		return sum % 10 === 0;
	}
	/**
	* Keeps the first character of the local part and the whole domain.
	* @param {string} email
	* @returns {string}
	*/
	function maskEmail(email) {
		const at = email.lastIndexOf("@");
		if (at < 1) return email;
		return `${email[0]}***${email.slice(at)}`;
	}
	/**
	* Masks an international phone number that starts with '+'.
	* With separators: keeps the country code group, the first national digit,
	* the last two digits and every separator. Without separators: keeps '+',
	* the first three digits and the last two.
	* @param {string} phone
	* @returns {string}
	*/
	function maskPhone(phone) {
		if (!phone.startsWith("+")) return phone;
		const chars = [...phone];
		const digitIdx = [];
		chars.forEach((c, i) => {
			if (c >= "0" && c <= "9") digitIdx.push(i);
		});
		if (digitIdx.length < 4) return phone;
		const keep = new Set(digitIdx.slice(-2));
		if (/[^\d+]/.test(phone)) {
			let i = 1;
			while (i < chars.length && chars[i] >= "0" && chars[i] <= "9") {
				keep.add(i);
				i++;
			}
			const firstNational = digitIdx.find((idx) => idx > i);
			if (firstNational !== void 0) keep.add(firstNational);
		} else digitIdx.slice(0, 3).forEach((idx) => keep.add(idx));
		return chars.map((c, i) => c >= "0" && c <= "9" && !keep.has(i) ? "*" : c).join("");
	}
	/**
	* True for 13–19 digits that pass Luhn AND start like a payment card. The first digit is the
	* ISO/IEC 7812 major industry identifier: 2–6 are bank and payment cards (Mir, Mastercard,
	* Amex, JCB, Diners, Visa, Discover, UnionPay, Maestro); 1 is only UATP, which has 15 digits.
	* This keeps millisecond timestamps, snowflake ids and other Luhn-valid ids readable.
	* @param {string} value
	*/
	function isLikelyCardNumber(value) {
		const digits = String(value).replace(/\D/g, "");
		if (digits.length < 13 || digits.length > 19 || !isLuhnValid(digits)) return false;
		const mii = digits.charCodeAt(0) - 48;
		return mii >= 2 && mii <= 6 || mii === 1 && digits.length === 15;
	}
	// ../packages/redaction/src/report.js
	/**
	* @typedef {'header'|'cookie'|'urlParam'|'urlUserinfo'|'bodyField'|'jwt'|'card'|'apiKey'|'bearer'|'privateKey'|'email'|'phone'|'custom'} RuleId
	*/
	/**
	* @typedef {object} Report
	* @property {(rule: RuleId, n?: number) => void} count
	* @property {() => Partial<Record<RuleId, number>>} toJSON  Only rules with a count above zero.
	*/
	/** @returns {Report} */
	function createReport() {
		/** @type {Partial<Record<RuleId, number>>} */
		const counts = {};
		return {
			count(rule, n = 1) {
				if (n > 0) counts[rule] = (counts[rule] ?? 0) + n;
			},
			toJSON() {
				return { ...counts };
			}
		};
	}
	// ../packages/redaction/src/rules.js
	/** Lower-cases and strips every non-alphanumeric character: `card_number` → `cardnumber`. */
	function normalizeKey(name) {
		return String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
	}
	var SENSITIVE_FIELD_EXACT = /* @__PURE__ */ new Set([
		"pass",
		"pwd",
		"otp",
		"pin",
		"cvv",
		"cvc",
		"card",
		"pan",
		"iban",
		"ssn",
		"sid",
		"auth",
		"authkey"
	]);
	/**
	* Strong stems: a normalized name that CONTAINS one of these is sensitive
	* (password_confirmation, secretKey, tokens, session_id, aws_secret_access_key…).
	* Over-redaction is acceptable by design (spec §5).
	*/
	var SENSITIVE_FIELD_STEMS = [
		"password",
		"passwd",
		"secret",
		"token",
		"apikey",
		"privatekey",
		"session",
		"sessid",
		"cookie",
		"credential",
		"authorization",
		"signature",
		"cardnumber",
		"cvv",
		"cvc"
	];
	/**
	* @param {string} name   Field / parameter name as it appears in the payload.
	* @param {string[]} [extra]  Workspace-defined extra names (any casing / separator style).
	*/
	function isSensitiveField(name, extra = []) {
		const key = normalizeKey(name);
		if (!key) return false;
		if (SENSITIVE_FIELD_EXACT.has(key)) return true;
		if (SENSITIVE_FIELD_STEMS.some((s) => key.includes(s))) return true;
		return extra.some((e) => normalizeKey(e) === key);
	}
	var SENSITIVE_HEADER_EXACT = /* @__PURE__ */ new Set([
		"authorization",
		"proxy-authorization",
		"cookie",
		"set-cookie",
		"x-api-key",
		"x-auth-token",
		"x-csrf-token",
		"x-xsrf-token"
	]);
	var SENSITIVE_HEADER_CONTAINS = [
		"token",
		"secret",
		"key",
		"session",
		"auth",
		"signature",
		"password"
	];
	/** Headers that match a CONTAINS rule but never carry secrets (HTTP/2 pseudo-header = host name). */
	var HEADER_EXCEPTIONS = /* @__PURE__ */ new Set([":authority", "authority"]);
	/**
	* @param {string} name
	* @param {string[]} [extra]  Workspace-defined extra header names (case-insensitive).
	*/
	function isSensitiveHeader(name, extra = []) {
		const lower = String(name).toLowerCase();
		if (HEADER_EXCEPTIONS.has(lower)) return false;
		if (SENSITIVE_HEADER_EXACT.has(lower)) return true;
		if (SENSITIVE_HEADER_CONTAINS.some((s) => lower.includes(s))) return true;
		return extra.some((e) => e.toLowerCase() === lower);
	}
	var SENSITIVE_URL_PARAMS = /* @__PURE__ */ new Set([
		"token",
		"access_token",
		"refresh_token",
		"id_token",
		"code",
		"key",
		"api_key",
		"apikey",
		"signature",
		"sig",
		"password",
		"pass",
		"secret",
		"session",
		"sessionid",
		"auth",
		"jwt"
	]);
	// ../packages/redaction/src/text.js
	/** @typedef {import('./report.js').Report} Report */
	/** @typedef {import('./report.js').RuleId} RuleId */
	var PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
	var JWT = /\beyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g;
	var BEARER = /\b(Bearer)(\s+|%20)[A-Za-z0-9\-._~+/%]+=*/g;
	var TAIL = /\[REDACTED\](?:%[0-9A-Fa-f]{2}|[A-Za-z0-9._~+/=-])[A-Za-z0-9%._~+/=-]*/g;
	var BASIC = /\b(Basic)(\s+|%20)([A-Za-z0-9+/]{6,4096}={0,2})(?![A-Za-z0-9+/=])/g;
	var HEADER_LINE = /(?<![A-Za-z0-9-])((?:proxy-)?authorization|set-cookie|cookie|x-[A-Za-z0-9-]{0,40}(?:token|key|secret|auth|session)[A-Za-z0-9-]{0,40})(\s{0,5}:\s{0,5})([^\r\n"'\\]{1,4096})/gi;
	var PAIR = /"(key|name)"(\s{0,10}:\s{0,10})"([^"\\\n]{1,128})"(\s{0,10},\s{0,10})"value"(\s{0,10}:\s{0,10})"((?:[^"\\\n]|\\.){0,20000})"/g;
	var API_KEYS = [
		/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
		/\bAKIA[0-9A-Z]{16}\b/g,
		/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
		/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
		/\bxox[abposr]-[A-Za-z0-9-]{8,}/g,
		/\bAIza[0-9A-Za-z_-]{30,}/g,
		/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}/g
	];
	var USERINFO = /\b([a-z][a-z0-9+.-]{0,20}:\/\/)([^\s/?#@:]{1,256}):([^\s/?#@]{1,256})@/gi;
	var KEY_VALUE = /(?<![A-Za-z0-9_.\-[\]%])([A-Za-z0-9_.\-[\]%]{1,128})=([^&#;\s"'<>,)]{1,4096})/g;
	var JSON_KEY_VALUE = /"([A-Za-z0-9_.-]{1,128})"(\s{0,10}:\s{0,10})("(?:[^"\\\n]|\\.){0,20000}"|-?\d{1,40}(?:\.\d{1,20})?)/g;
	var ESCAPED_JSON_KEY_VALUE = /\\"([A-Za-z0-9_.-]{1,128})\\"(\s{0,10}:\s{0,10})\\"((?:[^"\\]|\\[^"]){0,20000})\\"/g;
	var CARD = /(?<![\w-])(?:\d[ -]?){12,18}\d(?![\w-])/g;
	var EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g;
	var PHONE = /\+\d[\d ().-]{6,30}\d/g;
	function decodeKey(raw) {
		let k = raw;
		try {
			k = decodeURIComponent(raw.replace(/\+/g, " "));
		} catch {}
		const bracket = /\[([^\]]*)\]$/.exec(k);
		return bracket ? bracket[1] : k;
	}
	/** True for query/form/JSON keys that must lose their value. */
	function isSensitiveKey(rawKey, extra = []) {
		const key = decodeKey(rawKey);
		return SENSITIVE_URL_PARAMS.has(key.toLowerCase()) || isSensitiveField(key, extra);
	}
	/**
	* Applies value patterns (spec §5.4, §5.5) and key-based rules for key=value pairs and
	* embedded JSON to free text.
	* @param {string} text
	* @param {{ report?: Report, extraFieldNames?: string[] }} [opts]
	* @returns {string}
	*/
	function redactText(text, opts = {}) {
		if (typeof text !== "string" || text.length === 0) return text;
		const { report, extraFieldNames = [], extraHeaderNames = [] } = opts;
		/** @param {RuleId} rule */
		const hit = (rule) => report?.count(rule);
		let out = text.replace(PRIVATE_KEY, () => (hit("privateKey"), REDACTED));
		out = out.replace(JWT, () => (hit("jwt"), REDACTED));
		out = out.replace(BEARER, (_m, word, gap) => (hit("bearer"), `${word}${gap === "%20" ? " " : gap}${REDACTED}`));
		out = out.replace(TAIL, () => (hit("bearer"), REDACTED));
		out = out.replace(BASIC, (m, word, gap, token) => {
			if (token.length < 8 || !(/[0-9+/=]/.test(token) || /[A-Z]/.test(token.slice(1)) && /[a-z]/.test(token))) return m;
			hit("bearer");
			return `${word}${gap === "%20" ? " " : gap}${REDACTED}`;
		});
		out = out.replace(HEADER_LINE, (m, name, sep, value) => {
			if (/^([A-Za-z0-9-]{1,30}\s+)?\[REDACTED\]\s*$/.test(value)) return m;
			hit("header");
			const scheme = /^(Basic|Bearer|Digest|Token|Negotiate|NTLM|Hawk|ApiKey|AWS4-HMAC-SHA256)\s/i.exec(value);
			return `${name}${sep}${scheme ? `${scheme[1]} ` : ""}${REDACTED}`;
		});
		out = out.replace(PAIR, (m, label, s1, name, comma, s2) => {
			if (!isSensitiveHeader(name, extraHeaderNames) && !isSensitiveField(name, extraFieldNames)) return m;
			hit("header");
			return `"${label}"${s1}"${name}"${comma}"value"${s2}"${REDACTED}"`;
		});
		for (const re of API_KEYS) out = out.replace(re, () => (hit("apiKey"), REDACTED));
		out = out.replace(USERINFO, (_m, scheme, user) => (hit("urlUserinfo"), `${scheme}${user}:${REDACTED}@`));
		out = out.replace(KEY_VALUE, (m, key, value) => {
			if (value === "[REDACTED]" || !isSensitiveKey(key, extraFieldNames)) return m;
			hit("urlParam");
			return `${key}=${REDACTED}`;
		});
		out = out.replace(JSON_KEY_VALUE, (m, key, sep, value) => {
			if (value === `"[REDACTED]"` || !isSensitiveField(key, extraFieldNames)) return m;
			hit("bodyField");
			return `"${key}"${sep}"${REDACTED}"`;
		});
		out = out.replace(ESCAPED_JSON_KEY_VALUE, (m, key, sep, value) => {
			if (value === "[REDACTED]" || !isSensitiveField(key, extraFieldNames)) return m;
			hit("bodyField");
			return `\\"${key}\\"${sep}\\"${REDACTED}\\"`;
		});
		out = out.replace(CARD, (m) => {
			if (!isLikelyCardNumber(m)) return m;
			hit("card");
			return REDACTED;
		});
		out = out.replace(EMAIL, (m) => (hit("email"), maskEmail(m)));
		out = out.replace(PHONE, (m) => {
			const digits = m.replace(/\D/g, "").length;
			if (digits < 8 || digits > 15) return m;
			hit("phone");
			return maskPhone(m);
		});
		return out;
	}
	// ../packages/redaction/src/body.js
	/**
	* @typedef {object} RedactOptions
	* @property {import('./report.js').Report} [report]
	* @property {string[]} [extraFieldNames]
	* @property {string[]} [extraHeaderNames]
	*/
	/**
	* Recursively redacts a parsed JSON value. A sensitive key loses its whole subtree;
	* every other string goes through the value patterns.
	* @param {unknown} value
	* @param {RedactOptions} [opts]
	* @returns {unknown}
	*/
	function redactJson(value, opts = {}) {
		if (typeof value === "string") {
			const t = value.trimStart();
			if (t.startsWith("{") || t.startsWith("[")) try {
				return JSON.stringify(redactJson(JSON.parse(value), opts));
			} catch {}
			return redactText(value, opts);
		}
		if (typeof value === "number") {
			if (Number.isInteger(value) && isLikelyCardNumber(String(Math.abs(value)))) {
				opts.report?.count("card");
				return REDACTED;
			}
			return value;
		}
		if (Array.isArray(value)) {
			if (value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string" && sensitiveLabel(value[0], opts)) {
				opts.report?.count("header");
				return [value[0], REDACTED];
			}
			return value.map((v) => redactJson(v, opts));
		}
		if (value && typeof value === "object") {
			const record = value;
			const label = [
				"key",
				"name",
				"header",
				"field"
			].map((k) => record[k]).find((v) => typeof v === "string");
			const pairIsSecret = "value" in record && typeof label === "string" && sensitiveLabel(label, opts);
			/** @type {Record<string, unknown>} */
			const out = {};
			for (const [k, v] of Object.entries(value)) {
				let next;
				if (pairIsSecret && k === "value" && v !== null && v !== void 0) {
					opts.report?.count("header");
					next = REDACTED;
				} else if (v !== null && v !== void 0 && isSensitiveField(k, opts.extraFieldNames)) {
					opts.report?.count("bodyField");
					next = REDACTED;
				} else next = redactJson(v, opts);
				Object.defineProperty(out, k, {
					value: next,
					enumerable: true,
					writable: true,
					configurable: true
				});
			}
			return out;
		}
		return value;
	}
	/** A header or field name whose value is a secret. @param {string} name @param {RedactOptions} opts */
	function sensitiveLabel(name, opts) {
		return /^[A-Za-z0-9_.:-]{1,128}$/.test(name) && !/^access-control-/i.test(name) && (isSensitiveHeader(name, opts.extraHeaderNames) || isSensitiveField(name, opts.extraFieldNames));
	}
	/** Encodes a form value but keeps the placeholder readable. */
	function encodeFormValue(v) {
		return encodeURIComponent(v).replaceAll(encodeURIComponent(REDACTED), REDACTED);
	}
	function decodeFormPart(s) {
		try {
			return decodeURIComponent(s.replace(/\+/g, " "));
		} catch {
			return s;
		}
	}
	/** @param {string} body @param {RedactOptions} opts */
	function redactForm(body, opts) {
		return body.split("&").map((pair) => {
			const eq = pair.indexOf("=");
			if (eq < 0) return pair;
			const rawKey = pair.slice(0, eq);
			const rawValue = pair.slice(eq + 1);
			if (isSensitiveField(decodeFormPart(rawKey), opts.extraFieldNames)) {
				opts.report?.count("bodyField");
				return `${rawKey}=${REDACTED}`;
			}
			const value = decodeFormPart(rawValue);
			const redacted = redactText(value, opts);
			return redacted === value ? pair : `${rawKey}=${encodeFormValue(redacted)}`;
		}).join("&");
	}
	/** @param {string} body @param {string} boundary @param {RedactOptions} opts */
	function redactMultipart(body, boundary, opts) {
		const delimiter = `--${boundary}`;
		return body.split(delimiter).map((part, i) => {
			if (i === 0 || part.startsWith("--")) return part;
			const sep = part.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
			const headerEnd = part.indexOf(sep);
			if (headerEnd < 0) return part;
			const headers = part.slice(0, headerEnd);
			const rest = part.slice(headerEnd + sep.length);
			const eol = rest.endsWith("\r\n") ? "\r\n" : rest.endsWith("\n") ? "\n" : "";
			const content = rest.slice(0, rest.length - eol.length);
			const name = /(?<![a-z])name="?([^";\r\n]*)"?/i.exec(headers)?.[1] ?? "";
			let next;
			if (/filename=/i.test(headers)) {
				if (/[\u0000-\u0008\u000e-\u001f]/.test(content)) return part;
				next = redactBody(content, /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1] ?? null, opts);
			} else if (isSensitiveField(name, opts.extraFieldNames)) {
				opts.report?.count("bodyField");
				next = REDACTED;
			} else next = redactText(content, opts);
			return `${headers}${sep}${next}${eol}`;
		}).join(delimiter);
	}
	/**
	* Redacts a request/response body according to its content type.
	* JSON (or anything that parses as a JSON object/array), urlencoded forms and multipart
	* forms are handled structurally; everything else gets the value patterns.
	* @param {string | null | undefined} body
	* @param {string | null} contentType
	* @param {RedactOptions} [opts]
	* @returns {string | null | undefined}
	*/
	function redactBody(body, contentType, opts = {}) {
		if (body === null || body === void 0 || body === "") return body;
		const ct = (contentType ?? "").toLowerCase();
		const trimmed = body.trimStart();
		const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
		if (ct.includes("application/json") || ct.includes("+json") || looksJson) {
			let parsed;
			try {
				parsed = JSON.parse(body);
			} catch {
				return redactText(body, opts);
			}
			const redacted = redactJson(parsed, opts);
			return JSON.stringify(redacted) === JSON.stringify(parsed) ? body : JSON.stringify(redacted);
		}
		if (ct.includes("application/x-www-form-urlencoded")) return redactForm(body, opts);
		if (ct.includes("multipart/form-data")) {
			const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? "");
			const b = boundary?.[1] ?? boundary?.[2];
			if (b) return redactMultipart(body, b, opts);
		}
		return redactText(body, opts);
	}
	// ../packages/redaction/src/headers.js
	/** @typedef {import('./body.js').RedactOptions} RedactOptions */
	/** @param {string} name @param {string} value @param {RedactOptions} opts */
	function redactHeaderValue(name, value, opts) {
		if (isSensitiveHeader(name, opts.extraHeaderNames)) {
			const lower = name.toLowerCase();
			opts.report?.count(lower === "cookie" || lower === "set-cookie" ? "cookie" : "header");
			return REDACTED;
		}
		return typeof value === "string" ? redactText(value, opts) : value;
	}
	/**
	* Redacts headers given either as HAR-style `[{name, value}]` or as a `{name: value}` record.
	* The input shape is preserved; the input is not mutated.
	* @template {Array<{name: string, value: string}> | Record<string, string>} T
	* @param {T} headers
	* @param {RedactOptions} [opts]
	* @returns {T}
	*/
	function redactHeaders(headers, opts = {}) {
		if (Array.isArray(headers)) return headers.map((h) => ({
			...h,
			value: redactHeaderValue(h.name, h.value, opts)
		}));
		if (headers && typeof headers === "object") return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, redactHeaderValue(k, v, opts)]));
		return headers;
	}
	// ../packages/redaction/src/url.js
	/** @typedef {import('./body.js').RedactOptions} RedactOptions */
	function safeDecode(s) {
		try {
			return decodeURIComponent(s.replace(/\+/g, " "));
		} catch {
			return s;
		}
	}
	/** Redacts `a=b&c=d` pairs, rewriting only the pairs whose value changes. */
	function redactParams(params, opts) {
		return params.split("&").map((pair) => {
			const eq = pair.indexOf("=");
			if (eq < 0) return pair;
			const rawKey = pair.slice(0, eq);
			const key = safeDecode(rawKey);
			if (SENSITIVE_URL_PARAMS.has(key.toLowerCase()) || isSensitiveField(key, opts.extraFieldNames)) {
				opts.report?.count("urlParam");
				return `${rawKey}=${REDACTED}`;
			}
			const value = safeDecode(pair.slice(eq + 1));
			const redacted = redactText(value, opts);
			if (redacted === value) return pair;
			return `${rawKey}=${encodeURIComponent(redacted).replaceAll(encodeURIComponent(REDACTED), REDACTED)}`;
		}).join("&");
	}
	/**
	* Redacts sensitive query/fragment parameters, the password in userinfo and value patterns
	* anywhere in the URL. Works on absolute and relative URLs; untouched parts keep their
	* original spelling.
	* @param {string} url
	* @param {RedactOptions} [opts]
	* @returns {string}
	*/
	function redactUrl(url, opts = {}) {
		if (typeof url !== "string" || url === "") return url;
		const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url);
		if (!m) return redactText(url, opts);
		const [, scheme = "", rest = "", query = "", fragment = ""] = m;
		let authority = "";
		let path = rest;
		if (scheme) {
			const slash = rest.indexOf("/");
			authority = slash < 0 ? rest : rest.slice(0, slash);
			path = slash < 0 ? "" : rest.slice(slash);
		}
		const at = authority.lastIndexOf("@");
		if (at >= 0) {
			const userinfo = authority.slice(0, at);
			const host = authority.slice(at + 1);
			const colon = userinfo.indexOf(":");
			let user = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
			user = redactText(user, opts);
			if (colon >= 0) {
				opts.report?.count("urlUserinfo");
				authority = `${user}:${REDACTED}@${host}`;
			} else authority = `${user}@${host}`;
		}
		const newPath = redactText(path, opts);
		const newQuery = query ? `?${redactParams(query.slice(1), opts)}` : "";
		let newFragment = fragment;
		if (fragment) {
			const body = fragment.slice(1);
			newFragment = `#${body.includes("=") ? redactParams(body, opts) : redactText(body, opts)}`;
		}
		return `${scheme}${authority}${newPath}${newQuery}${newFragment}`;
	}
	// ../packages/redaction/src/har.js
	/** @typedef {import('./body.js').RedactOptions} RedactOptions */
	var BINARY_MIME = /^(image|audio|video|font)\/|^application\/(octet-stream|pdf|zip|gzip|x-gzip|wasm|x-protobuf|protobuf|grpc|vnd\.ms-fontobject)\b/i;
	/** Returns the UTF-8 text of a base64 body, or null when it is not valid UTF-8 (binary). */
	function base64ToUtf8(b64) {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			return null;
		}
	}
	function utf8ToBase64(text) {
		const bytes = new TextEncoder().encode(text);
		let bin = "";
		const CHUNK = 32768;
		for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
		return btoa(bin);
	}
	/** @param {Array<{name: string, value: string}>|undefined} cookies @param {RedactOptions} o */
	function redactCookies(cookies, o) {
		if (!Array.isArray(cookies)) return;
		for (const c of cookies) if (c && c.value) {
			c.value = REDACTED;
			o.report?.count("cookie");
		}
	}
	/** @param {{content?: any}} res @param {RedactOptions} o */
	function redactContent(content, o) {
		if (!content || typeof content.text !== "string" || content.text === "") return;
		const mime = content.mimeType ?? "";
		if (content.encoding === "base64") {
			if (BINARY_MIME.test(mime)) return;
			let decoded;
			try {
				decoded = base64ToUtf8(content.text);
			} catch {
				return;
			}
			if (decoded === null) return;
			const redacted = redactBody(decoded, mime, o);
			if (redacted !== decoded) content.text = utf8ToBase64(redacted);
			return;
		}
		content.text = redactBody(content.text, mime, o);
	}
	/** Applies redactText to every string in `node` (in place) except where `skip` says so. */
	function sweep(node, o, skip) {
		if (Array.isArray(node)) {
			for (let i = 0; i < node.length; i++) if (typeof node[i] === "string") node[i] = redactText(node[i], o);
			else if (node[i] && typeof node[i] === "object") sweep(node[i], o, skip);
			return;
		}
		for (const key of Object.keys(node)) {
			if (skip(node, key)) continue;
			const v = node[key];
			if (typeof v === "string") node[key] = redactText(v, o);
			else if (v && typeof v === "object") sweep(v, o, skip);
		}
	}
	/**
	* Redacts a HAR 1.2 document. Returns a deep copy; the input is not mutated.
	* @param {any} har
	* @param {RedactOptions} [opts]
	* @returns {{ har: any, report: Record<string, number> }}
	*/
	function redactHar(har, opts = {}) {
		if (!har || !har.log || !Array.isArray(har.log.entries)) throw new Error("Not a HAR file: missing log.entries");
		const report = opts.report ?? createReport();
		/** @type {RedactOptions} */
		const o = {
			...opts,
			report
		};
		const out = structuredClone(har);
		for (const page of out.log.pages ?? []) if (typeof page?.title === "string") page.title = /^[a-z][a-z0-9+.-]*:\/\//i.test(page.title) ? redactUrl(page.title, o) : redactText(page.title, o);
		for (const e of out.log.entries) {
			const req = e.request ?? {};
			if (typeof req.url === "string") req.url = redactUrl(req.url, o);
			if (req.headers && typeof req.headers === "object") req.headers = redactHeaders(req.headers, o);
			redactCookies(req.cookies, o);
			for (const q of req.queryString ?? []) {
				if (!q || typeof q.value !== "string") continue;
				if (SENSITIVE_URL_PARAMS.has(String(q.name).toLowerCase()) || isSensitiveField(q.name, o.extraFieldNames)) {
					q.value = REDACTED;
					report.count("urlParam");
				} else q.value = redactText(q.value, o);
			}
			if (req.postData) {
				if (typeof req.postData.text === "string") req.postData.text = redactBody(req.postData.text, req.postData.mimeType ?? null, o);
				for (const p of req.postData.params ?? []) {
					if (!p || typeof p.value !== "string") continue;
					if (isSensitiveField(p.name, o.extraFieldNames)) {
						p.value = REDACTED;
						report.count("bodyField");
					} else p.value = redactText(p.value, o);
				}
			}
			const res = e.response ?? {};
			if (res.headers && typeof res.headers === "object") res.headers = redactHeaders(res.headers, o);
			redactCookies(res.cookies, o);
			redactContent(res.content, o);
			if (typeof res.redirectURL === "string" && res.redirectURL) res.redirectURL = redactUrl(res.redirectURL, o);
			for (const msg of e._webSocketMessages ?? []) if (msg && typeof msg.data === "string") msg.data = redactBody(msg.data, null, o);
			sweep(e, o, (obj, key) => key === "text" && obj === res.content && res.content?.encoding === "base64");
		}
		return {
			har: out,
			report: report.toJSON()
		};
	}
	// ../packages/redaction/src/redactor.js
	/**
	* Binds workspace options and one shared report to every redaction function.
	* @param {{ extraFieldNames?: string[], extraHeaderNames?: string[] }} [opts]
	*/
	function createRedactor(opts = {}) {
		const report = createReport();
		const o = {
			...opts,
			report
		};
		return {
			text: (t) => redactText(t, o),
			json: (v) => redactJson(v, o),
			body: (b, ct) => redactBody(b, ct, o),
			headers: (h) => redactHeaders(h, o),
			url: (u) => redactUrl(u, o),
			har: (h) => redactHar(h, o).har,
			report: () => report.toJSON()
		};
	}
	// src/lib/redactionRules.js
	var rules = {
		fields: [],
		headers: []
	};
	function setRedactionRules(next) {
		rules = {
			fields: Array.isArray(next?.fields) ? next.fields.map(String) : [],
			headers: Array.isArray(next?.headers) ? next.headers.map(String) : []
		};
	}
	/** Options for createRedactor(): the extra field and header names. */
	function redactorOptions() {
		return {
			extraFieldNames: rules.fields,
			extraHeaderNames: rules.headers
		};
	}
	// src/lib/bundle.js
	var contentTypeOf = (pairs) => (pairs ?? []).find(([k]) => k === "content-type")?.[1] ?? null;
	/** Every string inside a JSON value through the text rules (the site's metadata can hold anything). */
	function redactDeep(r, value, depth = 0) {
		if (typeof value === "string") return r.text(value);
		if (depth > 8 || value === null || typeof value !== "object") return value;
		if (Array.isArray(value)) return value.map((v) => redactDeep(r, v, depth + 1));
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(r, v, depth + 1)]));
	}
	function redactPairs(r, pairs) {
		if (!Array.isArray(pairs)) return [];
		return r.headers(pairs.map(([name, value]) => ({
			name,
			value
		}))).map((h) => [h.name, h.value]);
	}
	/**
	* @param {object[]} events  Captured events with epoch-ms `at`.
	* @param {{startedAt: number, endedAt: number, device: object}} opts
	*/
	function buildBundle(events, { startedAt, endedAt, device }) {
		const r = createRedactor(redactorOptions());
		const inWindow = events.filter((e) => typeof e?.at === "number" && e.at >= startedAt && e.at <= endedAt).sort((a, b) => a.at - b.at);
		const t = (e) => Math.max(0, Math.round(e.at - startedAt));
		const bundle = {
			version: 1,
			startedAt: new Date(startedAt).toISOString(),
			durationMs: Math.max(0, Math.round(endedAt - startedAt)),
			device: device ?? {},
			console: [],
			network: [],
			websocket: [],
			actions: [],
			navigations: []
		};
		for (const e of inWindow) switch (e.kind) {
			case "console":
				bundle.console.push({
					t: t(e),
					level: e.level,
					text: r.text(e.text ?? ""),
					...e.stack ? { stack: r.text(e.stack) } : {}
				});
				break;
			case "network": {
				const entry = {
					t: t(e),
					method: e.method,
					url: r.url(e.url ?? ""),
					status: e.status === null ? null : e.status ?? 0,
					type: e.type ?? "other",
					durationMs: e.durationMs ?? 0
				};
				if (e.requestHeaders) entry.requestHeaders = redactPairs(r, e.requestHeaders);
				if (e.responseHeaders) entry.responseHeaders = redactPairs(r, e.responseHeaders);
				if (e.requestBody != null) entry.requestBody = r.body(e.requestBody, contentTypeOf(e.requestHeaders));
				if (e.responseBody != null) entry.responseBody = r.body(e.responseBody, contentTypeOf(e.responseHeaders));
				if (e.truncated) entry.truncated = true;
				if (e.error) entry.error = r.text(e.error);
				bundle.network.push(entry);
				break;
			}
			case "ws":
				bundle.websocket.push({
					t: t(e),
					url: r.url(e.url ?? ""),
					direction: e.direction,
					data: r.body(e.data ?? "", null)
				});
				break;
			case "action":
				bundle.actions.push({
					t: t(e),
					kind: e.action,
					...e.selector ? { selector: e.selector } : {},
					...e.text ? { text: r.text(e.text) } : {}
				});
				break;
			case "navigation": bundle.navigations.push({
				t: t(e),
				url: r.url(e.url ?? ""),
				title: r.text(e.title ?? "")
			});
		}
		const meta = events.filter((e) => e?.kind === "metadata" && typeof e.at === "number" && e.at <= endedAt).sort((a, b) => a.at - b.at).at(-1);
		if (meta?.data && typeof meta.data === "object") bundle.metadata = redactDeep(r, meta.data);
		const summary = {
			pageTitles: [...new Set(bundle.navigations.map((n) => n.title.trim()).filter(Boolean))],
			consoleErrors: bundle.console.filter((c) => c.level === "error").length,
			failedRequests: bundle.network.filter((n) => n.status === 0 || n.status >= 400).length
		};
		return {
			bundle,
			report: r.report(),
			summary
		};
	}
	// src/lib/pauses.js
	/** Time spent paused before `at`. */
	function pausedBefore(pauses, at) {
		let sum = 0;
		for (const [from, to] of pauses ?? []) if (from < at) sum += Math.min(to, at) - from;
		return sum;
	}
	/**
	* Captured events on the recording's own clock. Events during a pause are dropped, except a page
	* change, which moves to the moment the recording resumed (the pages that follow still need it).
	*/
	function withoutPauses(events, pauses) {
		if (!pauses?.length) return events;
		const out = [];
		for (const e of events) {
			if (typeof e?.at !== "number") continue;
			const pause = pauses.find(([from, to]) => e.at >= from && e.at < to);
			if (!pause) out.push({
				...e,
				at: e.at - pausedBefore(pauses, e.at)
			});
			else if (e.kind === "navigation") out.push({
				...e,
				at: pause[0] - pausedBefore(pauses, pause[0])
			});
		}
		return out;
	}
	// src/jsc/bundle.js
	/**
	* @param {string} eventsJson  captured events (epoch-ms `at`), as the page script emits them
	* @param {string} optionsJson {startedAt, endedAt, pauses, device, source}
	* @returns {string} {bundle, report, summary}
	*/
	globalThis.midgeBuildBundle = (eventsJson, optionsJson) => {
		const events = JSON.parse(eventsJson);
		const { startedAt, endedAt, pauses = [], device = {}, source, redaction } = JSON.parse(optionsJson);
		setRedactionRules(redaction);
		const { bundle, report, summary } = buildBundle(withoutPauses(events, pauses), {
			startedAt,
			endedAt: endedAt - pausedBefore(pauses, endedAt),
			device
		});
		if (source) for (const name of [
			"console",
			"network",
			"websocket",
			"actions",
			"navigations"
		]) bundle[name] = bundle[name].map((entry) => ({
			...entry,
			source
		}));
		return JSON.stringify({
			bundle,
			report,
			summary
		});
	};
})();
