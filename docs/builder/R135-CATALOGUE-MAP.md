# R135 — visual asset catalogue → layout builder map

Source: the owner's "HELM Event Asset Visual Catalogue" (Nov 2026), 61 asset types in 6 categories.
Every catalogue asset is mapped to exactly one decision:

- **duplicate** — already a builder item (or an existing look of one): nothing new added.
- **variant** — the same product in a different colour / shape / style: a "Look & variant" option on the
  existing item (inspector), read by the 3D model and the photo-render prompt. A look never changes the
  price (it stays the item's catalogue price).
- **new** — a genuinely new builder item, wired everywhere an item is wired (toolbox, search words, default
  price in `builder.js` + `store-api.js` + Settings rate list, price-grid group, 2D symbol, toolbox glyph,
  3D model, photo-render phrase, walkthrough / capture heights).

Totals: **30 duplicates, 24 variants, 7 new items** (= 61).

No database change is needed: the server prices a quote from its stored subtotal (D8), never from a list of
builder item types, and per-studio rate cards (0086) only exist for the 11 spec-priced types. New items use the
in-code default price until a studio types its own rate in Settings → Item pricing.

| Category | Catalogue asset | Decision | Builder item | Look (item.properties) |
|---|---|---|---|---|
| 01 Carpets & Flooring | Single continuous carpet (without barricades) | variant | `redcarpet` | edge=none |
| 01 Carpets & Flooring | Red carpet | duplicate | `redcarpet` | - |
| 01 Carpets & Flooring | White carpet | variant | `redcarpet` | carpet=white |
| 01 Carpets & Flooring | Ivory carpet | variant | `redcarpet` | carpet=ivory |
| 01 Carpets & Flooring | Gold carpet | variant | `redcarpet` | carpet=gold |
| 01 Carpets & Flooring | Curved carpet | variant | `redcarpet` | style=curved |
| 01 Carpets & Flooring | Walkway carpet | duplicate | `redcarpet` | - |
| 01 Carpets & Flooring | Outdoor lawn flooring | new | `lawnfloor` | - |
| 02 Lighting & Truss | Straight lighting truss | duplicate | `lighting` | - |
| 02 Lighting & Truss | Box / square truss | variant | `lighting` | style=squareframe |
| 02 Lighting & Truss | Triangle truss | variant | `lighting` | style=triangle |
| 02 Lighting & Truss | Circular truss | variant | `lighting` | style=circular |
| 02 Lighting & Truss | Arch-shaped truss | variant | `lighting` | style=trussarch |
| 02 Lighting & Truss | Ground support truss | variant | `stageroof` | style=groundsupport |
| 02 Lighting & Truss | Hanging truss | variant | `lighting` | style=flown |
| 02 Lighting & Truss | Roof truss | duplicate | `stageroof` | - |
| 02 Lighting & Truss | Tower truss | duplicate | `truss` | - |
| 02 Lighting & Truss | Adjustable-height truss | variant | `truss` | style=adjustable |
| 02 Lighting & Truss | Moving-head lights | duplicate | `movinghead` | - |
| 02 Lighting & Truss | LED PAR lights | new | `stagelight` | - |
| 02 Lighting & Truss | Beam lights | variant | `stagelight` | style=beam |
| 02 Lighting & Truss | Spotlights | variant | `stagelight` | style=spot |
| 02 Lighting & Truss | Floodlights | variant | `stagelight` | style=flood |
| 02 Lighting & Truss | Fairy lights | duplicate | `fairylights` | - |
| 02 Lighting & Truss | Festoon lights | variant | `fairylights` | style=festoon |
| 02 Lighting & Truss | Hanging chandeliers | duplicate | `chandelier` | - |
| 02 Lighting & Truss | Tree uplights | variant | `uplight` | style=tree |
| 02 Lighting & Truss | Pathway lights | new | `pathlights` | - |
| 02 Lighting & Truss | LED rope lights | variant | `pathlights` | style=rope |
| 03 Furniture | Round banquet tables | duplicate | `table` | - |
| 03 Furniture | Cocktail high tables | duplicate | `cocktail` | - |
| 03 Furniture | Lounge sofas | duplicate | `lounge` | - |
| 03 Furniture | Ottomans | duplicate | `ottoman` | - |
| 03 Furniture | Bar stools | duplicate | `barstool` | - |
| 03 Furniture | Chiavari chairs | duplicate | `chiavari` | - |
| 03 Furniture | Cross-back chairs | duplicate | `chiavari` | style=crossback (existing look) |
| 03 Furniture | VIP seating | variant | `armchair` | style=vip / style=throne |
| 04 Stage & AV | Curved LED screens | variant | `ledscreen` | style=curvedled (also videowall) |
| 04 Stage & AV | LED side screens | new | `sidescreen` | - |
| 04 Stage & AV | Stage extensions | new | `stagedeck` | - |
| 04 Stage & AV | Stage stairs | new | `stagestairs` | - |
| 04 Stage & AV | DJ console variations | variant | `dj` | style=djtable / ledfacade / trussdj |
| 04 Stage & AV | Speaker towers | duplicate | `patower` | - |
| 04 Stage & AV | Subwoofers | duplicate | `subwoofer` | - |
| 04 Stage & AV | Podiums | duplicate | `podium` | - |
| 04 Stage & AV | Projectors | duplicate | `projector` | - |
| 05 Outdoor festival & dinner | Food stalls | duplicate | `stall` | - |
| 05 Outdoor festival & dinner | Beverage counters | duplicate | `bar` | - |
| 05 Outdoor festival & dinner | Outdoor buffet stations | variant | `buffet` | style=outdoorbuffet |
| 05 Outdoor festival & dinner | Canopy tents (multiple styles) | variant | `tent` | style=pagoda / stretch / bell / shamiana (also canopy) |
| 05 Outdoor festival & dinner | Decorative entrance arches | duplicate | `arch` | - |
| 05 Outdoor festival & dinner | Lanterns | duplicate | `lanterns` | - |
| 05 Outdoor festival & dinner | Photo booths | duplicate | `photobooth` | - |
| 05 Outdoor festival & dinner | Welcome signage | duplicate | `welcomeboard` | - |
| 05 Outdoor festival & dinner | Outdoor decorative installations | new | `installation` | - |
| 06 Expo & exhibition | Modular exhibition booths | duplicate | `booth` | - |
| 06 Expo & exhibition | Product display stands | duplicate | `plinth` | - |
| 06 Expo & exhibition | Exhibition counters | duplicate | `counter` | - |
| 06 Expo & exhibition | Digital kiosks | duplicate | `kiosk` | - |
| 06 Expo & exhibition | Roll-up banners | duplicate | `signage` | - |
| 06 Expo & exhibition | Booth partitions | variant | `drape` | style=shellscheme |

## Stage steps and stairs (owner ask)

- **Stage → Built-in steps**: `properties.builtinSteps` = (blank) centre · `left` · `right` · `both` · `none`.
  Blank is the look every stage had before R135, so old layouts are unchanged.
- **Stage Stairs** (`stagestairs`, new): `properties.stairPos` left / centre / right snaps the stairs to the
  front edge of the nearest stage (follows the stage's rotation); `properties.stairSteps` 2–6 sets the tread
  count (depth = steps × 1.1 ft). 2D draws the treads, 3D draws the steps up to the 3 ft deck.

## Stage screen (Screen section)

Applies to the stage backdrop screen and to `ledscreen`, `sidescreen`, `videowall`, `led`, `brandwall`,
`backdrop`. Model (all optional, plain text, 60 characters each): `screenTheme` (corporate / royal / floral /
minimal / neon; blank = the current look), `title`, `brand`, `tagline`, `subtitle`, `dateLine`, and
`screenMirror` (non-stage screens: same as the main stage screen). Code: `public/stage-screen.js`.
With nothing entered the 2D builder shows a "Tap to add name & brand" hint; it is never drawn in exports,
client pictures (capture host), read-only views, 3D or the photo render.
