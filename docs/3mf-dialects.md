# 3MF dialects (M0 format spike)

Status: **draft, waiting on slicer tests.** The generator is `spikes/m0-3mf/build.mjs` (`node spikes/m0-3mf/build.mjs`, writes to `spikes/m0-3mf/out/`). Everything here is written from the 3MF spec and from looking at real files. No slicer code is reused.

## Triangle state encoding (shared by both dialects)

Bambu/Orca `paint_color` and Prusa `slic3rpe:mmu_segmentation` use the same per-triangle bit stream:

- 2 bits: number of split sides (0 = leaf, i.e. the whole triangle has one state)
- leaf with state < 3: 2 bits of state
- leaf with state ≥ 3: bits `1,1`, then `(state − 3)` in 4-bit groups (`1111` means "add 15 and continue")
- bits are packed 4 per hex digit (first bit = least significant), and the digits are written in **reverse** order

PrintPainter's export cuts the mesh so every output triangle has a single state, so only leaf codes are ever needed:

| State (filament) | 0 | 1 | 2 | 3 | 4 | 5 | … | 16 |
|---|---|---|---|---|---|---|---|---|
| Code | *(omit attribute)* | `4` | `8` | `0C` | `1C` | `2C` | … | `DC` |

State 0 means "unpainted, use the object's filament".

## Test files

All files contain the same welded, watertight 20 mm cube: 6 faces × 2×2 quads = 48 triangles.

| Layout | Painting |
|---|---|
| `c2` | top face = filament 2 (Red), everything else = 1 (White) |
| `c4` | top face quadrants = 1, 2, 3, 4; front (−Y) = 2 Red, right (+X) = 3 Green, back (+Y) = 4 Blue, left (−X) and bottom = 1 White |
| `c16` | the 24 quads cycle through filaments 1–16 (every colour should appear) |

Palette order: White, Red, Green, Blue, Yellow, Black, Orange, Purple, Cyan, Pink, Brown, Grey, Lime, Navy, Teal, Gold.

| Variant | File set |
|---|---|
| **A** | `[Content_Types].xml`, `_rels/.rels`, `3D/3dmodel.model` with `paint_color`. No metadata, no filament colours |
| **B** | A + `Metadata/project_settings.config` (JSON: `filament_colour`, `filament_type`) |
| **C** | B + `BambuStudio:3mfVersion = 1` model metadata + `Metadata/model_settings.config` (object/part extruder = 1) |
| **D** | C in the production-extension layout Bambu Studio writes: root model with a component → `3D/Objects/object_1.model`, `3D/_rels/3dmodel.model.rels`, `p:UUID`s |
| **E** | C with `Application = BambuStudio-02.09.01.70` (tests whether the "from Bambu Lab" check uses the Application field) |
| **F** | A + core-spec `<basematerials>` (one `<base>` per slot with `displaycolor`), triangles carry `pid`/`p1` as well as `paint_color`. Honest `Application` |
| **G** | Core-spec `<basematerials>` colours only, no `paint_color` |
| **P** | Prusa: `slic3rpe:mmu_segmentation`, `slic3rpe:Version3mf = 1`, `slic3rpe:MmPaintingVersion = 1`, `Metadata/Slic3r_PE.config` (`extruder_colour`, `filament_colour`, `filament_type`, `nozzle_diameter` × n) |

## How to test

For each file: **File → Open project** (Ctrl+O) in the slicer. If the slicer asks, choose to load the project/settings rather than geometry only. Then note:

1. Does it open without errors? (Copy any warning text.)
2. Is the cube painted, with the regions in the layout above?
3. How many filaments does the filament list show, and are their colours right?
4. Does it slice? (Wipe tower or flush volumes may be added; that's fine.)

Optional: also try **Import** (Ctrl+I) for A and P, which usually loads geometry and painting without project settings.

## Results

Use ✅ / ❌ / ⚠️ plus a note. "Paint" = regions in the right place. "Filaments" = count and colours right.

| File | Bambu Studio | OrcaSlicer | PrusaSlicer |
|---|---|---|---|
| A-c2 | ✅ Opens with notice "The 3mf is not from Bambu Lab, load geometry data and color data only." Top face painted, 2 filaments listed, slices | | n/a |
| A-c4 | ✅ Same "not from Bambu Lab" notice. All 4 regions correct (extended codes `0C`/`1C` work), 4 filaments listed, slices | | n/a |
| B-c4 | ⚠️ Same notice. `project_settings.config` ignored: filament colours not applied (painting present, existing filament colours used), slices | | n/a |
| C-c4 | ⚠️ Same notice, colours not applied, painting correct, slices. `BambuStudio:3mfVersion` + `model_settings.config` are not enough to count as a Bambu file. (A "Successfully sync your printer / Continue syncing filaments" prompt appeared, which is Bambu Studio's AMS sync, not the file) | | n/a |
| C-c16 | | | n/a |
| D-c4 | | | n/a |
| D-c16 | | | n/a |
| E-c4 | ⚠️ No "not from Bambu Lab" notice, so **the `Application` field is the gate**. Prompt: "The 3mf has following customized filament or printer presets: - Please confirm that the G-codes within these presets are safe to prevent any damage to the machine!" Then it **replaces the printer** with a custom preset named `E-c4.3mf` and creates 4 custom filament presets named after the file, with the right colours (White/Red/Green/Blue). Painting correct, slices. Too intrusive to ship as-is | | n/a |
| E-c16 | skipped (E's behaviour already known) | | n/a |
| F-c4 | ⚠️ Same notice. `<basematerials>` colours ignored (old filament colours kept), printer untouched, painting correct, slices | | n/a |
| F-c16 | skipped (same as F-c4) | | n/a |
| G-c4 | ✅ Same notice, shown inside a 2-step **Import Model** wizard (see below). Exact colours, painting correct, printer untouched, slices. Filament numbers re-ordered, material type not carried | | n/a |
| G-c16 | ⚠️ Wizard detects and keeps all 16 colours, but Filament Matching **auto-matched Pink `#EC407A` to the existing Red filament** (left over from G-c4), and Complete All Filaments only fills empty rows. Result: 15 filaments, the Pink square printed Red. Painting otherwise correct, printer untouched, slices | | n/a |
| P-c4 | (optional) | (optional) | |
| P-c16 | (optional) | (optional) | |

Slicer versions tested: Bambu Studio `…`, OrcaSlicer `…`, PrusaSlicer `…`.

## Conclusions (fill in after testing)

### Bambu Studio 02.09.01.70 (tested 2026-11-08)

- **Painting:** `paint_color` in a plain, single-file 3MF (`[Content_Types].xml`, `_rels/.rels`, `3D/3dmodel.model`) is enough. All codes up to `1C` (filament 4) work. The file opens with the notice *"The 3mf is not from Bambu Lab, load geometry data and color data only."*
- **The "from Bambu Lab" gate is the `Application` metadata.** `BambuStudio:3mfVersion` plus `model_settings.config` don't pass it (C). `Application = BambuStudio-…` does (E).
- **Not from Bambu Lab:** `Metadata/project_settings.config` is ignored (B, C), so filament colours aren't applied and the user's printer and filaments are left alone.
- **From Bambu Lab (E):** the project config is loaded as the whole config. With no preset names in it, Bambu Studio shows a G-code safety prompt, **replaces the user's printer** with a custom preset named after the file, and creates one custom filament preset per slot, named after the file, with the right colours. Too intrusive to ship as-is, and it would also mean claiming Bambu Studio wrote the file.
- **Core-spec `<basematerials>` colours:**
  - ignored when `paint_color` is also present (F).
  - with **no** `paint_color` (G), they trigger a 2-step import wizard:
    1. **Simplify Colors:** colour count slider plus "Auto". It found exactly 4, and simplifying changed nothing. Buttons: Skip / Next.
    2. **Filament Matching:** each file colour (exact hex) maps to one of the user's existing filaments. A "Color mixing" checkbox is offered. **Complete All Filaments** creates new filaments for unmatched colours. Confirm is disabled until every colour has a filament.
  - **Result:** exact colours, correct painting, printer untouched, slices.
  - **Costs:**
    - the wizard runs on every import.
    - filament numbers follow the wizard's own order (1 White, 2 Blue, 3 Green, 4 Red), not the palette order.
    - material type isn't carried: new filaments copy filament 1's preset.
    - two slots with the same colour would merge.
    - **the wizard silently matches file colours to the nearest *existing* filament, even clearly different ones** (G-c16: Pink `#EC407A` became Red `#E53935`). Complete All Filaments doesn't undo this. The result depends on whatever filaments the user's project already has, so the user has to review the Filament Matching page every time.
    - new filament numbers follow no order we control (G-c16: Black 5, Purple 6, Teal 9, Cyan 10, Navy 11, Brown 12).
  - Screenshots: `screenshots/ColorSimplificationPopup.jpg`, `ColorSimplificationPopup2.jpg`, `ColorSimplificationPopup3.jpg` (G-c4) and `ColorSimplificationPopupG.jpg`, `ColorSimplificationPopupG2.jpg`, `ColorSimplificationPopupG3.jpg` (G-c16). Step 1 offers count presets 4 / 8 / 16 / Auto.
- **Also noted:** a "Successfully sync your printer / Continue syncing filaments" prompt can appear on opening. That's Bambu Studio's AMS sync, not the file.

**Export routes for Bambu Studio** (decision pending):

| Route | Painting | Exact colours | Slot order kept | Printer untouched | Honest `Application` | Extra steps for user |
|---|---|---|---|---|---|---|
| `paint_color` only (A) | ✅ | ❌ | ✅ | ✅ | ✅ | pick filament colours by hand |
| `<basematerials>` only (G) | ✅ | ⚠️ unless merged into an existing filament | ❌ | ✅ | ✅ | 2-step wizard, must check matching |
| Bambu project (E) | ✅ | ✅ | ✅ | ❌ | ❌ | G-code prompt, printer reset |

- Minimum file set for Bambu Studio: the core three parts plus `paint_color` (A) for painting only, or plus `<basematerials>` with no `paint_color` (G) for colours too.
- Minimum file set for OrcaSlicer: …
- Minimum file set for PrusaSlicer: …
- Does `Application` metadata matter? **Yes, in Bambu Studio it decides "from Bambu Lab" or not** (see above).
- Does an explicit `4` on base triangles behave differently from omitting the attribute? Not tested yet (every test file writes `4` explicitly).
