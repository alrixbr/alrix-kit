const LINE_LIMIT = 300

// Keep telemetry compact, remove terminal control sequences, and mask common credential forms.
// Every line of the native bridge's progress (relay.ts) goes through here before it shows in the step.
export function displayText(text: string): string {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]')
    .replace(/(\b[\w]*(?:token|secret|password|api[_-]?key|cookie)[\w]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/(--?(?:token|password|secret|api-key|cookie|authorization)\s+)("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(/([?&](?:key|api_?key|token|access_token|sig|signature|code)=)[^\s&#]+/gi, '$1[redacted]')
    .replace(/(\bapi[\s_-]?key\b[^:=\n]{0,20}[:=]\s*)\S+/gi, '$1[redacted]')
    .trim()
  return clean.length > LINE_LIMIT ? `${clean.slice(0, LINE_LIMIT)}…` : clean
}
