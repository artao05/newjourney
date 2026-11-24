# v2 UI: the navigation-console look

Plan written 2026-11-24, when v2 became `main`. The aim: make v2 look like
dedicated marine navigation software (a chartplotter or a race-routing desk)
rather than a web app, **without changing what anything does**. Every control,
panel, shortcut and number stays; what changes is how they are drawn.

## What "nautical navigation software" looks like

Dedicated nav software (chartplotters, routing and race-instrument programs)
shares a visual grammar, and v2 currently breaks most of it:

| Nav software | v2 today |
| --- | --- |
| Docked panes with hairline 1 px separators, square or 2–4 px corners | Floating glass cards, 14 px corners, blur and big shadows |
| Instrument boxes: tiny uppercase label, unit at the right, large condensed digits | Mixed-case labels, mono digits, cards with gaps |
| A status bar: clock, position, data source with a status lamp | A web app header with pill tabs |
| Port red / starboard green / amber alarm as the only strong colours | Neon cyan accent everywhere, coloured pills |
| A chart status strip: cursor position, scale, "not for navigation" | A floating scale and a footnote |
| Line icons | Text characters as icons (☀ ☾ ? ✕ ↑ ↓ ⊟ ▶ ❚❚) |

## The plan

1. **Tokens and type.** One set of design tokens for the two existing themes
   (night console, day/sunlight). Surfaces become solid, layered greys-blue;
   one restrained marine-blue accent; port red, starboard green and alarm amber
   reserved for meaning. Corners 3 px, hairline borders, almost no shadow.
   Type: Barlow (a DIN-style face, as on bridge displays) for the interface,
   Barlow Semi Condensed with tabular figures for instrument digits and labels,
   JetBrains Mono kept for positions and times.
2. **Icons.** A small line-icon set (`ui/Icons.tsx`) replaces every text
   character used as an icon. Same buttons, same titles and labels.
3. **Status bar (top).** Square page tabs with an underline for the open page;
   the start-sequence control as a timer module; on the right, a status
   cluster: UTC clock, own-boat position (DDM), data source with a lamp,
   boat, day/night and help as icon buttons.
4. **Instrument panel.** Docked to the chart's corner, the boxes in a grid
   divided by hairlines (no gaps, no cards), each with a small uppercase label,
   unit top-right, big condensed digits, and a red/green bar along the top for
   port/starboard. Race view keeps its larger digits.
5. **Race display, coach tips, legend, chips.** The same console treatment:
   square, solid, hairline borders, label/value grids.
6. **Side panel.** Section headers become full-width title bars; buttons,
   segmented controls, inputs and lists square and tighter, lists read like
   tables.
7. **Timeline.** A transport bar: square play/pause with icons, monospaced
   time readout, ticks styled like a chart scale.
8. **Chart chrome.** Square zoom controls, the scale bar restyled, and a chart
   status strip at the bottom of the map: cursor position (DDM) and "Not for
   navigation".
9. **Phone.** Keep every existing breakpoint and what each hides; check at
   375 px wide and on a desktop window, in both themes.

Out of scope (would change behaviour): a third red night-vision theme,
abbreviated labels (BSP/TWA) in place of words, new data in the instruments.
Good candidates for later.
