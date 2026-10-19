# Backurau Design System

## Visual identity

- Warm ivory light theme; warm charcoal dark theme.
- Red wordmark, primary action and selected-plan accents.
- Compact typography, flat sections and restrained borders.
- Subtle paper grain on the shell; clean file lists.
- Frosted glass on titlebar and sidebar, with opaque fallbacks.
- Identical layout, spacing and icon geometry across themes.

## Foundations

| Property                     | Value                        |
| ---------------------------- | ---------------------------- |
| Spacing                      | 4, 8, 12, 16, 24, 32px       |
| Borders                      | 1px                          |
| Control radius               | 6px                          |
| Window radius                | 10px                         |
| Titlebar height              | 48px                         |
| Sidebar width                | 256px                        |
| Main padding                 | 20px horizontal; 12-16px top |
| Standard control height      | 36px minimum                 |
| Primary header action height | 44px                         |
| Folder-pair header height    | 40-42px                      |
| Table header height          | 34px                         |
| File row height              | 36px                         |
| Collapsed activity height    | 36px                         |
| Table interface icons        | 16px                         |
| Toolbar icons                | 20px                         |
| File artwork                 | 24-28px                      |

## Typography

Free and open-source fonts; live text throughout the interface.

| Role                      | Font             | Size | Weight  | Line height |
| ------------------------- | ---------------- | ---- | ------- | ----------- |
| Wordmark                  | DM Serif Display | 28px | 400     | 1.1         |
| Plan heading              | Archivo          | 28px | 700     | 1.2         |
| Controls and navigation   | Archivo          | 14px | 400-500 | 20px        |
| Paths and filenames       | Archivo          | 14px | 400     | 20px        |
| Metadata and table labels | Archivo          | 12px | 400     | 18px        |
| Sidebar group labels      | Archivo          | 11px | 600     | 16px        |
| Activity heading          | Archivo          | 14px | 600     | 20px        |

- Wordmark: uppercase, red; use the approved logo asset when available.
- Group labels: uppercase, 1.2px tracking.
- Numbers: tabular figures for sizes, counts and timestamps.
- Paths: proportional text.
- Fallback: system sans-serif for Archivo.

## Colors

| Token                | Light     | Dark      |
| -------------------- | --------- | --------- |
| `--canvas`           | `#FAF7F0` | `#1C1B19` |
| `--shell`            | `#F3EFE8` | `#25231F` |
| `--surface`          | `#FAF8F4` | `#24221F` |
| `--surface-hover`    | `#EEE9E1` | `#32302B` |
| `--nav-selected`     | `#EAE5DC` | `#36332E` |
| `--text`             | `#171513` | `#F2F0EB` |
| `--text-muted`       | `#68635C` | `#BDB9B1` |
| `--border`           | `#DED8CF` | `#403C35` |
| `--rule`             | `#E8E2D9` | `#37342E` |
| `--brand`            | `#C51F20` | `#E22A29` |
| `--primary-bg`       | `#C62828` | `#B91F20` |
| `--primary-text`     | `#FFFFFF` | `#FFFFFF` |
| `--plan-selected-bg` | `#F9E3E1` | `#382321` |
| `--added-bg`         | `#ECF8EC` | `#1D3026` |
| `--added-fg`         | `#14842F` | `#4ADB69` |
| `--updated-bg`       | `#FFF4DF` | `#352A19` |
| `--updated-fg`       | `#A65B00` | `#F3AE29` |
| `--deleted-bg`       | `#FCE3E3` | `#3A2020` |
| `--deleted-fg`       | `#C72424` | `#FF5B59` |
| `--unchanged-fg`     | `#737373` | `#AAA69F` |

- Apply colors through semantic tokens.
- Status dots may use brighter colors than text.
- Keep normal text contrast at least 4.5:1; large text and meaningful control boundaries at least 3:1.

## Application shell

### Titlebar

- Left: BACKURAU wordmark.
- Right: theme toggle, separator, minimize, maximize, close.

### Sidebar

- Groups: Backup Plans, Navigation, Settings.
- Backup Plans: add button, plan names and right-aligned last-run metadata.
- Selected plan: tinted red background and red label/icon.
- Run history: indented tree with a red guide segment for the selected run.
- Navigation: Compare, Activity, Snapshots; neutral fill for the selected view.
- Settings: parent entry with indented Connections, General and Advanced children.
- Thin rules separate groups.

### Workspace header

- First row: plan title and rename pencil; Compare and Run aligned right.
- Metadata: status dot, last-run timestamp, separator dot, change count.
- Second row: Mode and Method selectors; inline change totals aligned right.
- Totals: colored dots, labels and thin vertical separators.
- Run is the prominent red action; Compare uses a neutral outlined style.

## Folder pairs

- Shallow bordered sections with a single-line header.
- Header: source path, bidirectional separator, destination path.
- Right actions: ellipsis menu, short separator, disclosure chevron.
- Expanded: comparison table directly beneath the header.
- Collapsed: header only, downward chevron.
- Add folder pair: understated inline plus action below the table.
- Activity: collapsible strip with icon, title and inline change count.
- Operation direction follows the selected mode; the path separator identifies the pair.

## Comparison table

Side-by-side file diff with aligned rows, thin rules and full-width state fills.

| Source               | Selection | Operation | Destination          |
| -------------------- | --------- | --------- | -------------------- |
| Name, Size, Modified | Checkbox  | Action    | Name, Size, Modified |
| 44%                  | 5%        | 7%        | 44%                  |

- Equal source/destination Name widths.
- Secondary text for sizes and timestamps.
- Sort indicators adjacent to Name labels.
- Shared row structure keeps both sides and central controls aligned.
- State fills span every column, including the operation gutter.
- Missing values use muted placeholders; an empty document silhouette may occupy the icon slot.

| State            | Fill    | Action symbol     |
| ---------------- | ------- | ----------------- |
| Updated          | Ochre   | Directional arrow |
| Added            | Green   | Plus              |
| Deleted          | Red     | Trash             |
| Unchanged file   | Neutral | Equals            |
| Unchanged folder | Neutral | Dash              |

- Action symbols describe pending operations.
- Checkboxes control selection independently of comparison state.
- Header checkbox supports checked, unchecked and mixed states.

## Icons and materials

- One outline icon family for navigation, actions, sorting and disclosure.
- Consistent stroke weights and optical alignment.
- File artwork: dimensional yellow folders, white documents and small PDF/XLS/DOC labels.
- Preserve artwork colors across themes.
- Opaque main content; grain must not interfere with text or state fills.
- Restrained window shadow; flat internal surfaces.

## Behavior and accessibility

- Compare scans and previews differences; Run executes selected operations.
- Pencil renames the plan; ellipsis opens pair options; chevron toggles expansion.
- Theme changes preserve selection, expansion, scroll position and data without reflow.
- Hover, pressed, disabled and focus states preserve component dimensions.
- Icon-only controls have accessible names and visible keyboard focus.
- Symbols and text accompany state colors.
- Loading, empty and error feedback stays local to the affected area.

## Responsive layout

- Preserve readable text sizes and paired source/destination rows.
- Allow horizontal table scrolling when columns cannot fit.
- Truncate long paths; expose full values on focus or hover.
- Wrap selectors and change totals before they overlap.
