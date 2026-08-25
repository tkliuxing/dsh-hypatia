/**
 * Host-side redaction applied before anything is stored or recalled.
 *
 * This runs on the host, unconditionally. A model claiming that content is
 * safe or already redacted is not authoritative, so its proposals pass
 * through the same filter as raw source text.
 *
 * The patterns are deliberately conservative and high-precision. This is a
 * last line of defence against obvious credential capture, not a general DLP
 * engine, and the module does not pretend to be one.
 *
 * @module dsh-hypatia/redaction
 */

/** Replacement marker. Length-stable so payload budgets stay predictable. */
const MARK = '[redacted]'

/**
 * High-precision secret shapes. Each entry keeps a `label` so audit metadata
 * can record *that* something was redacted without retaining the value.
 */
const PATTERNS = [
  { label: 'private-key', re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g },
  { label: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { label: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  // Anthropic before OpenAI: `sk-ant-...` also matches the looser `sk-` shape.
  { label: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { label: 'bearer-header', re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  { label: 'url-credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi },
  // Keeps the key name and redacts only the value, so the surrounding text
  // stays readable: `password: [redacted]` rather than a bare marker.
  // The optional quote before the separator is what makes the JSON spelling
  // match: in `{"password": "..."}` the key's own closing quote sits between
  // the key token and the colon, so a pattern anchored straight to `\s*[:=]`
  // silently misses every pasted JSON or JS config object.
  { label: 'assigned-secret', re: /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b(["']?\s*[:=]\s*)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,;"'}]{4,})/gi, keep: 2 },
]

/**
 * Redact secrets from a string.
 *
 * @param {unknown} value
 * @returns {{text: string, labels: string[]}} redacted text plus the kinds
 *   found, for content-free audit metadata.
 */
export function redactText(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return { text: typeof value === 'string' ? value : '', labels: [] }
  }
  let text = value
  const labels = new Set()
  for (const { label, re, keep } of PATTERNS) {
    re.lastIndex = 0
    if (!re.test(text)) continue
    re.lastIndex = 0
    labels.add(label)
    if (label === 'url-credentials') {
      text = text.replace(re, (_match, scheme) => `${scheme}${MARK}@`)
    } else if (keep) {
      // Preserve the leading capture groups (the key and its separator) and
      // replace only the trailing value group.
      text = text.replace(re, (...args) => args.slice(1, keep + 1).join('') + MARK)
    } else {
      text = text.replace(re, MARK)
    }
  }
  return { text, labels: [...labels] }
}

/**
 * Recursively redact every string in a JSON-shaped value.
 *
 * @param {unknown} value
 * @returns {{value: unknown, labels: string[]}}
 */
export function redactDeep(value) {
  const labels = new Set()
  const walk = (node) => {
    if (typeof node === 'string') {
      const result = redactText(node)
      for (const label of result.labels) labels.add(label)
      return result.text
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const out = {}
      for (const [key, child] of Object.entries(node)) out[key] = walk(child)
      return out
    }
    return node
  }
  return { value: walk(value), labels: [...labels] }
}

/**
 * Truncate a string to a byte budget without splitting a UTF-8 sequence.
 * Returns the original when it already fits.
 */
export function truncateBytes(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return text
  const suffix = '...[truncated]'
  const room = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'))
  // `toString` on a partial buffer emits U+FFFD for a split sequence; drop it.
  return buffer.subarray(0, room).toString('utf8').replace(/�+$/, '') + suffix
}
