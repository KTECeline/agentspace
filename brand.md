# Brand: AgentSpace

_Status: active (style A, "cozy low-poly office"), chosen 2026-09-24_

## Idea
A warm, friendly little office where your agents work. It's the opposite of the dark "mission control" dashboards common in AI tools. It should feel like a toy you want to watch, while still being exact about what's happening.

## Color (tokens in `web/app/globals.css`; every UI color comes from these)
| Token | Light | Dark | Use |
|---|---|---|---|
| `--background` | cream `oklch(0.972 0.014 85)` | warm night `oklch(0.2 0.015 55)` | page |
| `--surface` / `--surface-2` | paper / oat | lamp-lit panels | cards, inputs |
| `--foreground` | charcoal ink | warm white | text |
| `--muted` | clay gray | sand | secondary text (≥ 4.5:1) |
| `--accent` | terracotta `oklch(0.55 0.14 38)` | apricot `oklch(0.76 0.12 50)` | primary actions, focus ring |

Status colors (chip background / text / dot, all ≥ 4.5:1 text contrast in both themes):
thinking = periwinkle · using_tool = honey · waiting / blocked = slate blue · waiting_human = lilac (glows) · done = sage · error = coral · idle = warm neutral.

3D scene palette: `web/components/office/palette.ts`. It uses the same hues in pastel tints: cream floor, a pastel rug per team, honey-wood desks, and bean-shaped avatars in one of 10 pastel body colors picked from a hash of the agent id.

## Type
- **Fredoka** (500/600): the wordmark, room labels and speech bubbles. It's rounded and friendly.
- **Geist Sans**: all UI text.
- **Geist Mono**: numbers, timestamps, ids (with `tabular-nums`).

## Motion
Soft and bouncy, never frantic: idle breathing at about 0.25 Hz, and handoff packets arc for about 0.9 s with ease-in-out. With `prefers-reduced-motion`, all motion except status color changes is turned off.

## Voice
Short, plain, active: "Needs you", "Handed off to Engineer", "The office is empty". No hype.
