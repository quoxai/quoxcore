# QX Components Index

Every global utility in the Quox dashboard design system. Consume these classes — **do not duplicate them per-view**.

- **Source:** `src/styles/qx-components.css` (primary) + `src/styles/glass.css` (shell/layout)
- **Tokens:** `src/index.css` (`:root` — `--qx-*` and `--m-*`)
- **Live gallery:** `/qx-lab/components` (internal tabs by category)
- **Composed example:** `/qx-lab/application` (Fleet Ops fake page, zero bespoke CSS)
- **Edge cases:** `/qx-lab/edge-cases`

> When refactoring a view, **search this file first.** If the pattern you need is listed, use it. If it isn't, add it to `qx-components.css` and the index — never duplicate in a view file.

---

## Layout / shell (glass.css)

| Class | Purpose |
|---|---|
| `.qx-view` | Root wrapper for any view. Transparent, `flex: 1; min-height: 0; overflow: visible`, flex-col — fills the remaining parent height, it does not itself carry `min-height: 100%`. |
| `.qx-scroll-pane` | The block-flow scroll contract `.qx-pad` doesn't have on its own: `display:block; flex:1 1 0; min-height:0; overflow-y:auto`, no padding. Use for the ONE main document scroller in a bounded flex chain (route → `.qx-view` → workspace → `.qx-scroll-pane`) so natural-height page content (stat tiles, cards, lists) scrolls as a normal document instead of a shrinkable flex child clipping itself. Compose padding/surface via `.qx-pad` or `.qx-card` alongside it; never redefine `.qx-card`/`.qx-stack`. First consumer: InboxQ Overview/Report/Proposals/Settings (`InboxQView.jsx` `.iq-main`, InboxQ layout audit, 2026-09-26). |
| `.qx-card` | Canonical panel (20px radius, 20px pad, glass + 4-edge shimmer + layered shadow). |
| `.qx-card--compact` | 12/14px padding variant for dense grids. |
| `.qx-card--roomy` | 28px padding variant. |
| `.qx-card--lift` | Hover: raise + cyan/purple sheen sweep. Click: sink with inset shadow. Opt-in. |
| `.qx-card--bar` | Compressed padding (12px 20px) for 64px/56px fixed-height header/filter bar panels. |
| `.tools-grid-card` | Fixed min/max-height 180px wrapper for tool cards in Panel D grids. Clips description to 3 lines. |
| `.tool-card` | Unified tool card (180px height, flex-col, hover lift, no left-edge bar). Used inside `ToolCard.jsx`. Sub-elements: `__row1`, `__icon`, `__name`, `__status`, `__desc`, `__meta`. |
| `.tool-cat-row` | Category sidebar row (left panel of /tools). `--active` = purple→cyan gradient bg. Sub-elements: `__icon`, `__label`, `__count`. |
| `.qx-pad` | 16px inner padding with scroll (flex min-height:0). |
| `.qx-stack` | Flex column, 16px gap. `--tight` (8px), `--compact` (12px). |
| `.qx-row` | Flex row, 16px gap. `--tight` (8px), `--apart` (space-between+center), `--end`, `--center`, `--wrap`, `--nowrap` (scroll), `--fill` (children flex:1). |
| `.qx-grid-2` / `-3` / `-4` | Responsive grids, 16px gap. Fixed column count at every width — for a two-pane layout that must *stack* on narrow viewports, use `.qx-split` instead. |
| `.qx-grid-auto` | Content-sized grid: fills the row then wraps, instead of forcing a fixed column count. Use whenever the item count is DATA-DRIVEN and can legitimately be 1 or 2, where `.qx-grid-3` leaves a two-thirds-empty row that reads as broken layout. Card floor via `--qx-grid-min` (default 280px). |
| `.qx-grid-auto--start` | Modifier: cards size to their own content instead of stretching to the tallest in the row. Use when a card's height carries meaning (one card has an extra block and the siblings should NOT grow an empty region to match). Leave it off for uniform tiles. |
| `.qx-split` | Two-pane layout, side by side above 860px, stacked (single column) below it. Use for a "content A / content B" reading pair (e.g. QuoxSignal's proposal text left, transcript right) — `.qx-grid-2` never collapses and would squeeze both panes unreadably thin on a narrow window. |
| `.qx-master-detail` (+ `__list`, `__reader`, `[data-detail-open]`) | Container-query master-detail (list + detail pane), promoted out of InboxQ (`InboxQ UX Pass 3`, 2026-09-26). Closed (`data-detail-open="false"`): list is 100% width at every container width, reader not rendered — no empty "nothing selected" pane squatting in the layout. Open + narrow container: reader swaps in for the list. Open + wide container (`@container` min-width 1120px): split, list `clamp(360px, 34%, 440px)`, reader `flex: 1 1 480px; min-width: 480px`. First consumer: InboxQ (`InboxQView.jsx`). |
| `.qx-popover__panel--float` | Fixed-position popover panel, portalled to `<body>` and placed inline from the trigger rect so a scrolling / `overflow:hidden` ancestor cannot clip it. First consumer: ContactsQ `Popover` (`shared.jsx`). |
| `.glass-panel` | Chrome-sized glass (header/rail/footer/main use this). |
| `.glass-card` / `.glass-btn` / `.glass-nav` / `.glass-input` | Legacy-named aliases, identical specs. |

---

## Status atoms

| Class | Variants | Purpose |
|---|---|---|
| `.qx-dot` | `--online`, `--degraded`, `--offline`, `--loading`, `--idle`, `--info`; sizes `--sm`/`--lg` | Breathing status dot with per-variant animation. |
| `.qx-pill` | `--online`, `--degraded`, `--offline`/`--critical`, `--info`, `--purple`, `--ghost`, `--success`, `--low`, `--medium`, `--high`, `--danger`; sizes `--sm`/`--lg`/`--xs` | Status badge / protocol chip. `--danger` = bright red (drift / error alerts). |
| `.qx-severity` | `--critical`, `--high`, `--medium`, `--low`, `--info` | Compact uppercase severity marker. |
| `.qx-badge` | `--ok`, `--alert` | Small numeric/letter count badge. |
| `.qx-chip` | `--active`, `--brand`, `--xs` | Tag / filter / suggestion. `--xs` = 10px font, 2px 6px padding for card meta strips. |
| `.qx-kind` | `--stream`, `--substream`, `--skill`, `--plugin-feature`, `--alert`, `--fyi` | Coloured, larger (12px, pill) kind tag — one hue per QuoxSignal proposal finding kind, so the eye can tell them apart at a glance instead of one flat grey `.qx-chip`. |
| `.qx-kbd` | `--lg` (device/pairing code display size), `--glow` (cyan halo, "code accepted" moment) | Keyboard-key pill. |

## Buttons + interactive

| Class | Variants |
|---|---|
| `.qx-btn` | `--primary`, `--danger`, `--ghost`, `--success` (green "copied"/confirmed state), `--tint` (colour-accented secondary action, driven by `--qx-btn-tint`, e.g. `style={{ '--qx-btn-tint': '#a855f7' }}` — transparent-tinted 16%/55% mix, hover raises to 26%/75%; fills the gap between `--ghost` (no colour) and `--primary`/`--danger` (fixed colours) for zone/severity-mapped quick actions, first consumer InboxQ's row/reader move buttons); sizes `--sm`/`--lg`. Clunky press state built in. |
| `.qx-row-action` | Icon-only button for hover-revealed row actions. |
| `.qx-tabs` | `--underline`, `--vert` — with `.qx-tab`, `.qx-tab--active`. |
| `.qx-seg` + `.qx-seg__btn` | Segmented control (3-5 options). |
| `.qx-range` | Range slider (volume, thresholds): cyan->purple filled track, glass thumb. Set `--qx-range-fill` (0-100%) inline for the fill. |
| `.qx-btabs` + `.qx-btab` | **Chrome-style conversation tabs** with trapezoidal clip. `.qx-btabs__new` for `+`. |
| `.qx-pag` + `.qx-pag__btn` | Pagination. `--active` modifier. |

## Data tiles + graphs

| Class | Purpose |
|---|---|
| `.qx-stat` | Icon + value + label + delta + sub. The workhorse KPI tile. |
| `.qx-stat-row` | Compact kv row (label left, value right). |
| `.qx-kv` | Wrapper for `.qx-stat-row`s: fixed label column (`--qx-kv-label`, 8.5rem), value left-aligned NEXT to its label. Use for record details; plain stat rows push values to the far edge. |
| `.qx-progress` | Bar; `--success`/`--warn`/`--crit`/`--brand`; heights `--tall`/`--slim`. Shiny fill animation. |
| `.qx-percent` | Circular conic-gradient ring; sizes `--sm`/`--lg`/`--xl`; variants `--success`/`--warn`/`--crit`/`--brand`. |
| `.qx-percent-value` | Hero big-number with gradient-masked text + `<i>%</i>`. `--brand` variant = cyan→purple gradient text (non-metric hero labels, e.g. a growth-band name). |
| `.qx-spark` | Inline sparkline SVG wrapper; variants `--success`/`--warn`/`--crit`; sizes `--lg`/`--xl`. |
| `.qx-bars` + `.qx-bars__bar` | CSS-only bar chart, per-bar `--qx-h: 0..1`. |
| `.qx-hbar` | Horizontal distribution row (label + bar + value). |
| `.qx-trend` | Arrow + delta; `--up`/`--down`/`--flat`. |
| `.qx-segbar` + `.qx-segbar__seg` | Stacked segment bar + `.qx-segbar-legend`. |

## Forms

| Class | Purpose |
|---|---|
| `.qx-input` / `.qx-textarea` / `.qx-select` | Translucent glass input, cyan focus + ambient glow. `--mono` modifier for monospace (URLs, cron, expressions). |
| `.qx-field` + `__label` + `__hint` + `__error` | Label + input + helper wrapper. `--required` modifier on label. |
| `.qx-toggle` + `.qx-toggle__track` | Switch (gradient-on-check, purple glow). |
| `.qx-checkbox` + `.qx-checkbox__box` | Custom check box. |
| `.qx-tagfield` + `__tag` + `__x` + `__input` | Chip-based tag input. |
| `.qx-sticky-actions` | Floating save/discard footer for scrollable forms. |
| `.qx-dropzone` + `__icon` + `__hint` | File drag/drop area (`--active` glow). |
| `.qx-search-wrap` + `__icon` | Icon-left wrapper for `.glass-input`/`.qx-input` search bars. |
| `.qx-form-grid` + `__cells` | Proportional 12-column form layout in an inline-size container. Each child sets `--span` (and `--span-sm` for under 560px). Inputs/selects fill the cell. Use instead of equal-width `.qx-row` fields. |
| `.qx-input--narrow` / `.qx-input--grow` | Fixed (140px) / flexible (`flex:1`) width modifiers for inputs inside a `.qx-row`. |

## Tables + lists

| Class | Purpose |
|---|---|
| `.qx-table` | `thead th` (sticky), `tbody tr:hover`, `__row--active`. Sortable via `__sort`/`--asc`/`--desc`. |
| `.qx-row-actions` | Hover-revealed icon action cluster for table rows. |
| `.qx-host-row` | List item: dot + primary + secondary + meta. |
| `.qx-tree` + `.qx-tree__item` | Indented folder/hierarchy rows (`--qx-tree-depth` inline). `--open`/`--selected` modifiers. |
| `.qx-action-card` | Icon + title + description clickable. Built-in hover lift + sheen. |
| `.qx-result` + `__score` + `__body` + `__snippet` + `__meta` | Scored search result card with `<mark>` highlighting (2-line clamp). |
| `.qx-scroll-list` | Bounded-height (260px) flat scrollable list container inside a card (no glass — avoids glass-on-glass). |

## Feedback

| Class | Purpose |
|---|---|
| `.qx-modal-overlay` + `.qx-modal` | Full-screen overlay + centred glass panel modal. 20px radius, 20px pad, 4-edge shimmer, layered shadow. |
| `.qx-banner` | Inline alert strip; `--info`/`--success`/`--warn`/`--error`. |
| `.qx-toast-stack` | Toast positioning container (6 positions via modifiers). |
| `.qx-toast` + `__icon` + `__body` + `__title` + `__msg` + `__close` + `__progress` | Toast shell with auto-dismiss timer bar; variants `--success`/`--warn`/`--error`/`--purple`. |
| `.qx-tip` | CSS-only tooltip via `data-tip` attr. Positions `--below`/`--right`. |
| `.qx-crumbs` + `__item` + `__sep` | Breadcrumbs; `__item--current`. |
| `.qx-empty` + `__icon` + `__title` + `__body` | Empty state with icon + optional CTA. |
| `.qx-skeleton` | Shimmer loader; `--line-sm/md/lg`, `--block`, `--avatar`. |
| `.qx-spinner` | Conic-gradient ring; `--sm`/`--lg`. |
| `.qx-menu` + `__header` + `__item` + `__sep` + `__kbd` + `__meta` | Dropdown/popover menu. `__item--active` (brand gradient), `__item--danger`. `__item--check` on a `<label>` hosts a checkbox + label + right-aligned `__meta`, e.g. the RepoBrain cross-repo scope picker (multi-select over indexed targets). |
| `.qx-disclosure` + `__head` + `__chev` + `__body` | Collapsible details/summary. |
| `.qx-hint` | Secondary/tertiary caption text line (13px, 0.7 opacity). `--sm` (12px), `--success`, `--danger` modifiers. |

## Avatars

| Class | Variants |
|---|---|
| `.qx-avatar` | Default **rounded square** (10px radius). Sizes `--xs`/`--sm`/`--lg`/`--xl`. `--circle` for round. `--ring` outer glow. `__status` bottom-right dot. |
| `.qx-thumb` + `__placeholder` | Fixed-size (56x40) list thumbnail cell (e.g. QuoxSignal feed thumbnail column). `__placeholder` is a quiet diagonal-hatch fill for the "no thumbnail yet" case — never a broken-image icon, and the box never collapses so rows stay aligned. |

## Code + terminals

| Class | Purpose |
|---|---|
| `.qx-code` | Inline `<code>` pill. |
| `.qx-code-block` | Block code pane (opaque dark, legitimate). |
| `.qx-snippet` (+ `.qx-card`) + `__header` + `__loc` + `__actions` + `__reason` + `__code` + `__score` + `__lines` | Full code-preview result card (unclamped, syntax-highlighted) — use for code search results. Compose as `className="qx-card qx-snippet"`. `__lines` is the left line-number gutter (mono, dim, right-aligned, starts at the snippet's start_line) — render it beside `__code` in a flex row. `--focus` modifier (`.qx-snippet--focus`) marks the keyboard-selected card (j/k nav): intensified cyan top rim + 1px cyan border. |
| `.qx-prompt` + `__toolbar` | Monospace prompt display with absolute copy/expand buttons. |
| `.qx-terminal` + `__header` + `__body` + `__prompt` + `__user` + `__out`/`__err`/`__warn`/`__ok` | Standard terminal shell (opaque `#0a0e14` — xterm readability). |
| `.qx-terminal-v2` + `__head` + `__title` + `__chip` + `__body` + `__prompt` + `__user` + `__cursor` + `__cmdbar` | **Next-level terminal**: animated scanlines + glowing cyan prompt + purple user + blinking cursor + status chip + command bar. |

## Ops / data / evidence

| Class | Purpose |
|---|---|
| `.qx-log-stream` + `__tail` | Live-updating log container with sticky tail-follow pill. |
| `.qx-slot-msg` + `__meta` / `__body` | Stacked message row for NARROW containers (meta line above, wrapping body below). Use instead of `.qx-log-line` when the container is roughly a third of the viewport or less, where the 4-column grid squeezes text to one character per line. |
| `.qx-log-line` + `__ts` + `__level` + `__src` + `__msg` | Log row; `__level--info`/`--warn`/`--error`/`--ok`/`--debug`. |
| `.qx-heatmap` + `__cell` | Auto-fill grid with `--qx-cell-intensity: 0..1`. `--healthy`/`--warn`/`--crit`/`--unknown`. |
| `.qx-diff` + `__line`(`--add`/`--remove`/`--context`) + `__hunk` + `__ln` + `__sign` | Unified diff viewer. |
| `.qx-trail` + `__node` + `__sep` | Chain-of-custody pills; `__node--aee`/`--aocl`/`--volt`/`--ward`. |
| `.qx-evidence` + `__dot` + `__source` + `__ts` + `__sep` | Provenance source + verifier badge. |

## Workflow / canvas

| Class | Purpose |
|---|---|
| `.qx-canvas` + `__toolbar` | Transparent canvas with grid texture + cyan ambient. |
| `.qx-node` + `__head` + `__title` + `__sub` | Node tile with `--qx-node-color` category accent. `--selected` modifier. |
| `.qx-node-handle` | Socket dot. `--qx-handle-color` inline. |
| `.qx-edge` + `--animated` | SVG path styled cyan with flow-dash animation. |
| `.qx-graph-canvas` + `__stage` | Full-bleed WebGL/canvas visualization host (opts out of glass, opaque space-black bg — same rationale as `.qx-terminal`). |
| `.qx-graph-hud` + `__overlay`(`--error`) + `__overlay-title` + `__bar` + `__meta` + `__legend` + `__legend-item` + `__legend-dot` | Floating HUD chrome over `.qx-graph-canvas` (loading/error overlays, filter bar, colour-mode legend). `__legend-dot` reads `--qx-node-color` inline (data-driven, same idiom as `.qx-node`). `__legend-item` is clickable (toggles a repo's nodes/links visible or hidden in the graph); `__legend-item--muted` = 0.35 opacity + the dot goes hollow (transparent fill, colour ring) with a diagonal strike via `::after`. |
| `.qx-graph-node-info` (+ `.qx-card`) + `__id` + `__grid` + `__label` + `__value`(`--accent`) | Selected-node detail panel floating over the graph canvas. |

## Agents

| Class | Purpose |
|---|---|
| `.qx-agent-tile` + `__avatar` + `__body` + `__name` + `__role` + `__sub` | Roster card with `--qx-agent-color` accent. |
| `.qx-cap` + `__dot` | Tool/capability chip; `--read`/`--write`/`--exec` variants. |

## Plugin state

| Class | Purpose |
|---|---|
| `.qx-enableable[data-qx-enabled="true"]` | Ring-burst + radial-flash animation on enable. |
| `.qx-enabled-glow` | Steady-state cyan-purple breathing glow for active tiles. |
| `.qx-plugin-state` | State pill; `--on` variant (green breathing dot + brand gradient + outer glow). |
| `.qx-brain-ambient` | Absolute-positioned backdrop glow, intensity via `--qx-ambient-intensity` (0..1) inline; breathing animation, respects `prefers-reduced-motion`. Used behind the Brain2 growth hero — dims/brightens with the note-growth band. |
| `.qx-locked` | Present-but-locked capability tile: dimmed + desaturated, lifts back to life on hover. Demo: `/qx-lab/store`. |
| `.qx-levelup` | Celebration pulse (two cyan→purple glow waves) for a level-up moment on a panel; apply ~2.4s then remove. Demo: `/qx-lab/store`. |

## The Board (motherboard store)

| Class | Purpose |
|---|---|
| `.qx-board` | PCB substrate surface (legitimate dark, like `.qx-terminal`): grid texture + power glow driven by `--qx-board-power` (0..1). Demo: `/qx-lab/store`. |
| `.qx-trace` / `.qx-trace--lit` | Manhattan-routed trace in an SVG layer; lit variant takes `--trace-c` accent, glows and runs an energy-pulse dash flow toward the core. |
| `.qx-via` / `.qx-via--lit` | Solder via dot at trace bends and pads. |
| `.qx-bchip` | IC package/socket, positioned by left/top %. `--socket` (dashed, unseated, breathes when `--waiting`), `--on` (powered: accent border + glow, `--chip-c`), `--seat` (drop-in seating animation). Children: `__die`, `__silk`, `__tag`, `__amp`. |
| `.qx-bcore` | The central core chip: pin rails, breathing glow scaled by `--qx-board-power`. `--static` (flows in layout, no absolute positioning), `--socket` (unseated: dashed, breathing, no glow). |
| `.qx-board__readout` | Bottom silkscreen hover-readout strip. |
| `.qx-board--flow` | Board variant for sectioned layouts: auto height, content flows (no fixed aspect). Children: `__head` (collapsible header button), `__title`, `__silkname` (mono bus label), `__chev` (+`--closed`). |
| `.qx-busrail` / `--live` | Programmatic wire: the board's power rail. Live variant runs a cyan-purple energy flow. Chips connect via stubs, no coordinates. |
| `.qx-chipgrid` | Responsive auto-fill grid for chip cards (row gap reserves stub space). |
| `.qx-chipcard` | Plugin-page card content in IC-package skin: side pin rails, `__stub` trace + via to the rail (accent-lit when on), `__die`, `__name`, `__silk`, `__desc`, `__act`, `__amp`. States: `--socket` (dashed, dim), `--on` (accent border + glow), `--seat` (drop-in animation). |
| `.qx-minichip` (+ `-row`, `-row__silk`) | Tiny IC package for ships-with-core systems on the hero, and for a self-serve unlock cascade (FreeClaimPanel): dark dashed silicon until `--on` (accent glow + staggered seat, drive the stagger via `setTimeout` or inline `animationDelay`). `__silk` label ellipsis-clips past 68px — fine for short core-system names, and safe for longer plugin display names too. |

## Decorators

| Class / component | Purpose |
|---|---|
| `<QHorn size={N} animated />` | `src/components/ui/QHorn.jsx`. The actual horned-Q brand mark, inline SVG. Sizes: any px. `animated` prop adds float + glow. |
| `.qx-divider` | Thin gradient horizontal rule. |
| `.qx-section-title` | Uppercase label with trailing fade line. |
| `.qx-hr` | Plain horizontal rule between form groups. |
| `.qx-connect-ring` | SVG stroke-dash arc wrapped around a focal element for a connecting/reconnecting state (e.g. the voice popup eye). Consumer renders `<svg class="qx-connect-ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" /></svg>` absolutely positioned over its target. Respects `prefers-reduced-motion`. |

---

## Opaque-backed surfaces (2026-09-25, glass-on-glass fix)

`backdrop-filter` blur needs something solid underneath to composite. Nest a
translucent `.qx-card`/`.qx-tabs` inside another translucent surface (a glass
panel inside a glass sidebar, a dropdown floating over a glass card) and the
inner surface has nothing opaque to blur — it renders transparent/unreadable.
This is the sanctioned narrow exception to the "solid dark panels retired"
rule below: those panels were retired because a flat dark fill looks like a
black hole floating on the cinematic background when used for *outer* chrome.
An *inner*, nested/floating surface has no cinematic background behind it —
it sits on top of an already-blurred parent — so an opaque undercoat is
correct there, not a regression.

| Class | Purpose |
|---|---|
| `.qx-surface--backed` | Modifier, combine with `.qx-card` (e.g. `class="qx-card qx-surface--backed"`). Paints `--qx-surface-base-opaque` + the static `--qx-surface-sheen` gradient instead of blurring; disables `backdrop-filter`. Leaves the base class's border, `--qx-radius`, and 4-edge `::before` rim intact — this is a sibling rule, not an override. Use for nested/floating surfaces: sidebars, dropdowns, proposal cards, reader panes. |
| `.qx-tabs--glass` | Modifier: the tab strip is its own glass surface (card recipe + shimmer). For a page-level nav sitting directly on the cinematic. |
| `.qx-tabs--plain` | Modifier, combine with `.qx-tabs` (e.g. vertical nav embedded inside a `.qx-surface--backed` panel). Strips the tab strip's own background/border/shadow/radius so it reads as flat rows inside the backed parent instead of a second nested chrome layer. |

**Rule of thumb:** keep interiors flat once you're already inside a backed
surface; reserve real translucent blur (`--qx-blur`, `var(--m-bg-base)`) for
eligible OUTER chrome that sits directly on the cinematic background.

---

## Tokens (reference, never hardcode)

### Brand + glass
- `--qx-blur`, `--qx-radius`, `--qx-shimmer`, `--qx-edges`, `--qx-bg-cinematic`, `--qx-vignette`
- `--m-bg-base`, `--m-bg-elevated`, `--m-bg-float`, `--m-bg-deep`
- `--m-border-default`, `--m-text-primary`, `--m-text-secondary`, `--m-text-tertiary`
- `--qx-surface-base-opaque`, `--qx-surface-raised-opaque`, `--qx-surface-sheen` — opaque undercoat + sheen for `.qx-surface--backed` (nested/floating surfaces only, see "Opaque-backed surfaces" above)

### Severity + threshold
- `--qx-sev-info`, `--qx-sev-low`, `--qx-sev-warn`, `--qx-sev-med`, `--qx-sev-high`, `--qx-sev-crit`, `--qx-sev-ok`
- `--qx-thresh-healthy`, `--qx-thresh-warn`, `--qx-thresh-crit`

### Typography
- `--qx-font-mono`

---

## Retired patterns (DO NOT use)

- `rgba(255,255,255,0.02)` flat glass → use `--m-bg-base` (0.08).
- Asymmetric borders (top 0.40 / left 0.31) → uniform 0.18.
- `blur(40px) saturate(2.5)` → `var(--qx-blur)` (32/1.6).
- 12/14/16px panel radii → 20px (`var(--qx-radius)`).
- 105° full-panel diagonal shimmer → 4-edge `var(--qx-edges)`.
- Multi-stack `0 5px 19px... inset 0 1px 2px...` shadows → layered `0 8px 40px + inset top/bottom`.
- `#0c0c0f`, `#0a0a14`, `#111114`, `#18181c`, `#1a1a24`, `rgba(30,30,50,0.95)` solid dark panels → black hole on cinematic. Use `--m-bg-base`.
  - Narrow sanctioned exception: nested/floating surfaces (a glass surface inside another glass surface) can't composite `backdrop-filter` blur. Use `.qx-surface--backed` (see "Opaque-backed surfaces" below) there instead of a hand-rolled dark fill.

---

## WireMap canvas execution overlay (WireMap.css — component-scoped)

These classes exist in `src/components/workflow/WireMap/WireMap.css` only — not in `qx-components.css` because they are tightly coupled to the React Flow canvas rendering model. Do NOT duplicate or use outside the WireMap.

| Class | Purpose |
|---|---|
| `.qx-node--running` | Cyan → purple breathing glow ring + scale pulse (1.5s loop). Applied while a node is actively executing. |
| `.qx-node--completed` | Green flash ring (one-shot via `wb-completed-flash`). Applied when `quox.flow.node.completed` arrives. |
| `.qx-node--failed` | Red shake-and-ring animation (`wb-failed-flash`). Applied on `quox.flow.node.failed`. |
| `.qx-node--queued` | Subtle grey shimmer for queued nodes. |
| `.qx-node--skipped` | Dashed grey ring for skipped nodes. |
| `.qx-node__status-badge` | Absolute-positioned top-right badge (•/✓/✗/◦/—). Spins while running. |

The overlay is data-driven via `useExecutionOverlay(executionId)` hook → WireMap `nodeStatus` prop. No manual class toggle required.

---

## Objective Fabric components (2026-08-10, Fable design pass)

Origin: `docs/RECURSIVE_OBJECTIVE_FABRIC_RESEARCH.md`, QuoxPlan streams QG / DEVSUITE-DEVMODE.
Components: `src/components/objectives/ObjectiveStateVector.jsx`, `src/components/objectives/KnotBadge.jsx`,
`src/components/agents/StandingBadge.jsx`. Not yet wired into any live view — additive, unreferenced
until a real data source (objective state vector, Knot registry, `agent_standing` table) exists.

| Class | Purpose |
|---|---|
| `.qx-osv` | Objective state vector badge — 4-dimension micro bar strip (gap/confidence/stability/risk) + diverging velocity bar + cost bar + headline %. Click opens `.qx-osv-detail` flyout with exact values. |
| `.qx-evtl` | Shared event-timeline list (row grammar matches `.volt-waterfall__row` / `.trace-timeline-row`). Used by both `KnotBadge` and `StandingBadge` flyouts. `.qx-evtl__row--drop` marks a trust/confidence-losing event with a left rule + red tint. |
| `.qx-knot` | Cross-cutting Observer badge. Three-tier consequence ladder: `--evidential` (cyan, can challenge/request-evidence/escalate), `--authoritative` (purple, can interrupt/freeze), `--intervening` (red, live intervention in progress). Capability chips inside the flyout reuse `.qx-cap--read/--write/--exec`. |
| `.qx-standing` | Per-agent trust-score badge. `.qx-percent` ring (existing atom) + `.qx-pill--online`/`--warn` for autonomous/supervised. Flyout: `.qx-spark` history sparkline + `.qx-evtl` event list. |
| `.qx-replay` | LoopReplay (`src/components/objectives/LoopReplay.jsx`) — scrubbable time-travel over one corr's AEE envelopes. PANEL, not flyout (three simultaneous zones: temporal track, reconstructed belief, causal chain). `__track` ticks are time-proportional; `__tick--causal` marks `reply_to` ancestors of the selected envelope (ancestry channel, distinct from position/adjacency). Chain list reuses `.qx-evtl` with new modifiers `.qx-evtl__row--causal` (linking rail), `--gap` (chain truncated before window), `--now` (selected, purple→cyan active gradient). Belief zone reuses `.qx-osv-detail__row` grammar. Step-play transport at fixed per-event cadence, deliberately no wall-clock or speed menu. |

Light-mode handling: scoped `:root[data-theme="light"]` overrides for every literal alpha these
classes introduce (the dashboard has no light token set in `index.css` yet — these components
follow the semantic `--m-*`/`--qx-*` tokens automatically once one lands).

**Not yet done:** no `/qx-lab/components` demo tab added for these yet (pre-flight step 2 below,
still open).

---

## Pre-flight when adding to this index

When you add a new `.qx-*` utility to `qx-components.css`:

1. Append it to this index under the right category.
2. Add a demo to `/qx-lab/components` (appropriate tab) so it's discoverable.
3. If it replaces a recurring pattern, note the retired pattern(s) in the section above.
4. If it's a React component (like `QHorn`), put it in `src/components/ui/` and link from here.

Keep this index the source of truth for "what exists." If a consumer doesn't find what they need here, the answer is "add it here first, then consume." Never duplicate in a view.

- `.qx-row--wrap` / `.qx-row--tight` / `.qx-row--nowrap` — row modifiers
- `.qx-select--auto` — auto-width select for toolbars and filter bars

- `.qx-stage-track` (+ `__node`, `__node--done/--current/--terminal`, `__bar`, `__label`) — position in a pipeline. Use INSTEAD of three coloured pills when the states are ordered: fill level and node shape carry progress, so it survives greyscale. Terminal stage is squared, not just recoloured.

## Calm-layout utilities (ContactsQ UX pass, 2026-10-09)

| Class | Purpose |
|---|---|
| `.qx-card--visible` | Card modifier: `overflow: visible`, so a `.qx-popover` inside it is not clipped. The 4-edge rim still draws. |
| `.qx-popover` + `__panel` (`--end`) | Anchor wrapper + floating opaque panel (compose the panel with `.qx-menu`). Open/close state is the consumer's (see `contactsq/shared.jsx` `Popover`). `.qx-menu__item-text` + `<small>` gives a menu row a title with a one-line explanation. |
| `.qx-dot--static` | Status dot with no breathing/alarm animation, for grids of many dots (consent matrix). |
| `.qx-split--master` | `.qx-split` modifier for ONE card holding a narrow list pane and a wide detail pane, hairline rule between, stacked below 860px. Replaces two side-by-side glass cards. |
| `.qx-table--dense` / `.qx-table__row--muted` | Compact row density / de-emphasised (italic) row, e.g. unreviewed candidates. |

## Chip hues and avatars (ContactsQ restructure, 2026-10-09)

| Class | Purpose |
|---|---|
| `.qx-chip--hue-<name>` | Glassy tinted chip. Hues: `red orange amber yellow lime green teal cyan sky blue indigo violet purple fuchsia pink rose slate`. The hue sets `--chip-rgb`; background, border, glow and near-white tinted text derive from it. Use one hue per MEANING (see `contactsq/lib/chips.js`: relationship, flag severity, status, channel), never a per-view colour. Compose with `.qx-chip .qx-chip--xs`. |
| `.qx-chip--static` | Label-only chip: default cursor, no hover lift. |
| `.qx-chip--toggle` | Chip that toggles: pair with `aria-pressed`. Unlit (faint tint) when false, lit (full tint, ring, glow) when true. Compose with a hue and `.qx-tip` for the explanation. |
| `.qx-avatar--tint` | Avatar tinted from `--qx-avatar-hue` (0 to 359, set inline from a stable id) so every person gets a stable colour. |
| `button.qx-avatar` + `.qx-avatar__edit` | Avatar that is a button (change photo): an edit glyph overlay appears on hover or focus. |
| `.qx-tip--wrap` | Tooltip modifier for a sentence (wraps at 240px). `.qx-tip` now also opens on keyboard focus. |
| `.qx-stat__value--hero` / `--sm` | Size modifiers for `.qx-stat__value`: one big primary metric (48px) with smaller secondary ones (18px) beside it. Use instead of a row of equal tiles. |

## Reading + authoring surfaces (NotesQ, 2026-10-10)

Owner: "the best looking plugin we have made... carry it forward to the other plugins, especially the AssistantQ bundle." The full pattern is in the glass-design-system skill, section "The NotesQ look".

| Class / component | Purpose |
|---|---|
| `.qx-slate` | Obsidian slate: the content body (note, email, draft, transcript) on a sheet of black glass. The ONE sanctioned dark surface (rule 6 exception): content body only, one per view, compose with `.qx-card`. Text scales with `--qx-text-zoom`; inner components with a fixed font size need `font-size: var(--qx-slate-fs)`. |
| `.qx-seg--tint` + `.qx-tint--{sky,violet,teal,amber,fuchsia,green}` + `.qx-tint__btn` | Tinted tool group: a toolbar split into `.qx-seg` groups, one hue per group, bold glyphs, active button lit in its hue. |
| `.qx-pane-rail` + `__icon` / `__label` / `__count` | A collapsed pane as a slim clickable glass strip in its own grid column, label reads like a book spine. Never `display:none` a pane. |
| `TextSizeControl` / `useTextSize(key)` (`src/components/ui/TextSizeControl.jsx`) + `.qx-textsize` | A-, %, A+ text size, remembered per device under the surface's own key (`src/lib/textZoom.js`). Set the zoom as `--qx-text-zoom` on the `.qx-slate`. |

## Sessions overview (QUOXON J3, /sessions)

| Class | Purpose |
|---|---|
| `.qx-qstate` + `--resting` / `--working` / `--waiting` / `--failing` | The perpetual Q status glyph: wraps `<QHorn stops={...}>`; colour and motion carry state (CLI palette: resting dim sky breathing, working sky to violet flow, waiting amber pulse, failing red). Reduced motion stops the animation. |
| `.qx-session-list` + `.qx-session-row` (`__main`, `__name`, `__meta`, `__cell`, `__cell--host`, `__cell--age`, `__attach`, `--failing`) | One live session per row: glyph, name + badges, host, age, attach hint + copy. Container query stacks it below 720px. |
| `.qx-session-agent` (`__swatch`, `__name`) | Agent group heading with a colour swatch (set `color` inline to the agent colour). |
| `.qx-session-tiles` | Five-up stat tile grid (three-up under 640px). |
