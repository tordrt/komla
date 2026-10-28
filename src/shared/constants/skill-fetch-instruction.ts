// Komla puts `komla` on PATH, but login shells (Codex runs `bash -lc`) can reset
// it from /etc/profile; KOMLA_CLI survives. The CLI owns routing and explains
// its own connection errors.
export function buildSkillFetchInstruction(guide: string): string {
  return `Run \`komla skill ${guide}\` and follow it. If \`komla\` isn't found, use the absolute path in \`KOMLA_CLI\`.`;
}
