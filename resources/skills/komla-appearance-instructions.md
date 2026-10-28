# Komla Appearance

Change Komla's theme, accent color and corner radius through the Komla CLI. Komla previews each
change and saves it only if the user applies it.

## Workflow

1. Run `komla settings get appearance`. It returns the current settings, the built-in `themes`, and
   any `problems` with the current custom theme.
2. If the user hasn't said what they want, ask them, then end your turn and wait.
3. For a theme Komla ships with, set `palette` to its id and `accent` to that theme's `accent` from
   `themes`, unless the user wants a different accent. Otherwise write a `customPalette` and set
   `palette` to `"custom"`, and check every contrast pair under Readability first.
4. Write the complete settings to a JSON file: `palette`, `accent`, `borderRadius`, and
   `customPalette` when there is one. Leave out the read-only `themes` and `problems`. A
   `customPalette` you leave out is deleted, so keep the current one unless the user wants it gone.
5. Run `komla settings apply appearance --file <path>`. It waits while Komla shows the change and the
   user chooses Apply changes or Cancel.
6. Read the result:
   - `"status": "applied"`: the user applied the change.
   - `"status": "cancelled"`: the user cancelled it. Ask what to change.
   - `"status": "unchanged"`: the settings already matched.
   - Error `INVALID_APPEARANCE`: fix each problem in `error.details` and apply again.
   - Error `STALE_VERSION`: the settings changed in the meantime. Get them again and redo your
     change.
7. If this workspace was created only for the theme, tell the user they can delete it.

Change the theme only through `komla settings apply`, which shows the user the change first. Leave
`{{komlaDir}}/settings/theme.json` alone: Komla applies each save to it right away, without asking
the user.

## Settings

| Key             | Value                                               |
| --------------- | --------------------------------------------------- |
| `palette`       | A built-in theme id from `themes`, or `"custom"`    |
| `customPalette` | A theme you define; see below                       |
| `accent`        | Buttons, links and focus rings, as `"oklch(L C H)"` |
| `borderRadius`  | Corner radius in pixels, from 0 to 24               |

Komla lightens the accent in dark themes and darkens it in light ones so it stays readable.

Terminals stay dark in Komla's light themes. Komla Light uses Ghostty's default (`#282c34`), Komla Slate
Light a soft slate (`#252c35`), and the others use their dark sibling's terminal colors.

When the user has "Match system appearance" on, Komla shows one theme while the system is dark and
another while it's light, each with its own accent. Applying a light theme replaces the light one
and its accent, and any other theme the dark one, so the theme you apply may not show until the
system switches. The result of applying describes the theme you replaced.

## customPalette

Every color is a 6-digit hex value.

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

- `name`: the label in Settings → Appearance. Optional.
- `accent`: the accent Komla brings back when the user picks this theme again. Komla saves it when
  they switch away; keep it as it is.
- `mode`: `"dark"` or `"light"`. It sets Komla's text colors and the code editor's syntax colors.
- `surfaces.background`: the window behind everything else.
- `surfaces.card`: the title bar, panels, dialogs and inputs.
- `surfaces.popover`: menus and dropdowns. Optional; defaults to `card`.
- `surfaces.muted`: secondary buttons, tabs and other quiet fills.
- `surfaces.highlight`: hovered and selected items.
- `surfaces.border`: borders and input outlines.
- `surfaces.sidebar`: the workspace sidebar and the window around the work area, which sits on it as
  a card with rounded left corners. Optional. Give it a visible step off `surfaces.card` so the
  card stands out: a little darker than the card in both modes is a good start, and the theme's
  deepest shade (often its `background`) usually works. Left out, Komla uses `surfaces.background`
  when it differs from the card, or else a shade under the card.
- `terminal.background` and `terminal.foreground`: terminals. Keep the terminal dark in a light
  theme too, as Komla's own light themes do, unless the user asks for a light one. A soft dark
  like `#282c34` sits easier beside light surfaces than near-black. The code editor
  uses the terminal background when it suits the mode, and `surfaces.card` otherwise.
- `terminal.cursor` and `terminal.selection`: optional.
- `terminal.ansi`: optional. Any of `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`,
  `white` and their `bright` forms (`brightBlack` … `brightWhite`). Colors you leave out come from
  the Terminal settings.

## Readability

Komla rejects a custom theme whose text would be hard to read. Each pair needs a WCAG contrast ratio
of at least 4.5:1.

| Text           | On                                                                             | Dark mode text | Light mode text |
| -------------- | ------------------------------------------------------------------------------ | -------------- | --------------- |
| Text           | `surfaces.background`, `surfaces.card`, `surfaces.popover`, `surfaces.sidebar` | `#fafafa`      | `#0a0a0a`       |
| Secondary text | `surfaces.card`, `surfaces.sidebar`                                            | `#aeaeae`      | `#636363`       |

`terminal.foreground` on `terminal.background` needs 4.5:1 too.

Komla's text colors are fixed for each mode, so adjust the surface instead: darker in dark mode,
lighter in light mode.
