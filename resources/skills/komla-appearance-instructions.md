# Komla Appearance

Change Komla's theme, accent color and corner radius through the Komla CLI. Komla previews each
change and saves it only if the user applies it.

1. `komla settings get appearance` returns the current settings, the built-in `themes`, and any
   `problems` with the current custom theme.
2. If the user hasn't said what they want, ask them and wait.
3. For a built-in theme, set `palette` to its id and `accent` to its `accent` from `themes`, unless
   the user wants another. Otherwise write a `customPalette` and set `palette` to `"custom"`.
4. Write the complete settings to a JSON file, without `themes` and `problems`. A `customPalette`
   left out is deleted, so keep the current one unless the user wants it gone.
5. `komla settings apply appearance --file <path>` waits while the user applies or cancels the
   change. On `INVALID_APPEARANCE`, fix what `error.details` names; on `STALE_VERSION`, get the
   settings again and redo the change.

Change the theme only this way. Leave `{{komlaDir}}/settings/theme.json` alone: Komla applies each
save to it right away, without asking the user.

When the user has "Match system appearance" on, Komla keeps a dark and a light theme, so a theme
you apply may not show until the system switches. The result says which theme it replaced.

## Settings

```json
{
  "palette": "custom",
  "customPalette": {
    "name": "Moss",
    "mode": "dark",
    "surfaces": {
      "background": "#0f1410",
      "card": "#18201a",
      "popover": "#1c251e",
      "muted": "#222c24",
      "highlight": "#2a362d",
      "border": "#3a4a3e",
      "sidebar": "#111712"
    },
    "terminal": {
      "background": "#0f1410",
      "foreground": "#c8d8c0",
      "cursor": "#8fd18a",
      "selection": "#2a362d",
      "ansi": { "green": "#8fd18a", "brightGreen": "#b5e8a8" }
    }
  },
  "accent": "oklch(0.7 0.15 145)",
  "borderRadius": 6
}
```

- `accent`: buttons, links and focus rings, as `oklch(L C H)`. Komla adjusts it to stay readable.
- `borderRadius`: 0 to 24 pixels.
- `customPalette`: every color a 6-digit hex value. `mode` is `"dark"` or `"light"` and sets the
  text colors. `surfaces.card` is the title bar, panels and dialogs; `surfaces.sidebar` sits around
  them, so give it a visible step off the card. `popover`, `sidebar`, `cursor`, `selection` and
  `ansi` (`black` … `brightWhite`) are optional. A `customPalette.accent` that Komla saved is the
  theme's own accent; keep it.
- Komla's own light themes keep the terminal dark; do the same unless the user asks otherwise.

Komla rejects a custom theme whose text would be hard to read. Its text colors are fixed per mode
(`#fafafa` and `#aeaeae` in dark, `#0a0a0a` and `#636363` in light), and each needs a WCAG contrast
of 4.5:1 on `background`, `card`, `popover` and `sidebar` (secondary text: `card` and `sidebar`),
as does `terminal.foreground` on `terminal.background`. Adjust the surfaces to fit.
