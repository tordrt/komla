import { useEffect, useState } from 'react';

import { Select } from '@/components/ui/select';

import { BUNDLED_TERMINAL_FONT } from '../../../shared/constants/terminal';

interface FontData {
  family: string;
}

async function getMonospaceFonts(): Promise<string[]> {
  try {
    // queryLocalFonts is a Chromium/Electron API not in lib.dom.
    const queryLocalFonts = (window as Window & { queryLocalFonts?: () => Promise<FontData[]> })
      .queryLocalFonts;
    if (!queryLocalFonts) return [];
    const fonts: FontData[] = await queryLocalFonts();
    const families = new Set<string>();
    for (const font of fonts) {
      families.add(font.family);
    }
    // Filter to monospace fonts by checking if a wide char renders at same width as narrow
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return Array.from(families).sort();

    const mono: string[] = [];
    for (const family of families) {
      ctx.font = `16px "${family}"`;
      const wNarrow = ctx.measureText('i').width;
      const wWide = ctx.measureText('M').width;
      if (Math.abs(wNarrow - wWide) < 0.1) {
        mono.push(family);
      }
    }
    return mono.sort();
  } catch {
    return [];
  }
}

interface FontFamilyPickerProps {
  value: string;
  onChange: (family: string) => void;
}

export function FontFamilyPicker({ value, onChange }: FontFamilyPickerProps) {
  const [fonts, setFonts] = useState<string[]>([]);

  useEffect(() => {
    void getMonospaceFonts().then(setFonts);
  }, []);

  // Ensure the current saved value always appears, even if discovery missed it
  const options = value && !fonts.includes(value) ? [value, ...fonts] : fonts;

  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-64 text-xs">
      <option value="">Default ({BUNDLED_TERMINAL_FONT})</option>
      {options.map((font) => (
        <option key={font} value={font}>
          {font}
        </option>
      ))}
    </Select>
  );
}
