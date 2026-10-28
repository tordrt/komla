// First token of the open command — used to auto-name a custom agent from its CLI.
export function deriveAgentName(openCommand: string): string {
  return openCommand.trim().split(/\s+/)[0] ?? '';
}

const agentListFormat = new Intl.ListFormat('en', { type: 'conjunction' });

// Up to three agent names, then the first two and how many more.
export function listAgentNames(names: string[]): string {
  return agentListFormat.format(
    names.length > 3 ? [...names.slice(0, 2), `${names.length - 2} others`] : names
  );
}
