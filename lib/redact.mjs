// Secrets out of text that came from servers (logs, metrics labels) before Copilot sees it.
// Known shapes only, each replaced by a marker that says what was there; a log line that leaks
// something no pattern knows still gets through, which is why prod reads ask every time.

const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key removed]'],
  [/\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g, '[JWT removed]'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[AWS key id removed]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g, '[GitHub token removed]'],
  [/\bglsa_[A-Za-z0-9_]{20,}\b/g, '[Grafana token removed]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[Slack token removed]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[API key removed]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[Google key removed]'],
  // Logins in URLs: scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, '$1[login removed]@'],
  // Authorization headers and cookies
  [/\b(authorization|proxy-authorization)(["']?\s*[:=]\s*["']?)(bearer|basic|token|digest)?\s*[^\s"',;]+/gi, '$1$2$3 [removed]'],
  [/\b(cookie|set-cookie)(["']?\s*[:=]\s*["']?)[^\n"]+/gi, '$1$2[removed]'],
  // key=value and "key": "value" for names that hold secrets
  [/\b([\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential)s?)(["']?\s*[:=]\s*)(["']?)([^\s"',;&}]{3,})\3/gi, '$1$2$3[removed]$3'],
];

export function redact(text) {
  let out = String(text ?? ''), n = 0;
  for (const [re, to] of RULES) out = out.replace(re, (...m) => { n++; return to.replace(/\$(\d)/g, (_, i) => m[i] ?? ''); });
  return { text: out, removed: n };
}
