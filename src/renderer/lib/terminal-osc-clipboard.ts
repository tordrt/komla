const MAX_OSC52_BASE64_LENGTH = 1_500_000;

export function decodeOsc52Clipboard(data: string): string | null {
  const separator = data.indexOf(';');
  if (separator === -1) return null;

  const encoded = data.slice(separator + 1);
  if (!encoded || encoded === '?' || encoded.length > MAX_OSC52_BASE64_LENGTH) return null;

  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
