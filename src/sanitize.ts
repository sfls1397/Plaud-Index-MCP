const SECRET_PATTERN =
  /(PLAUD_API_TOKEN\s*[=:=]\s*)([^\s"',}]+)|(Bearer\s+)([A-Za-z0-9._\-+=/]+)|(authorization["']?\s*[:=]\s*["']?)([^"'\s]+)/gi;

export function redactSecrets(text: string): string {
  if (!text) {
    return text;
  }
  return text.replace(SECRET_PATTERN, (_full, a, _b, c, _d, e) => {
    if (a) return `${a}[REDACTED]`;
    if (c) return `${c}[REDACTED]`;
    if (e) return `${e}[REDACTED]`;
    return "[REDACTED]";
  });
}

export function looksLikeSecret(value: string): boolean {
  return /sk-[A-Za-z0-9]{10,}|Bearer\s+[A-Za-z0-9._\-]{20,}|eyJ[A-Za-z0-9_-]{20,}\./.test(value);
}
