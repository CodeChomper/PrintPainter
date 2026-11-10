# PrintPainter — Implementation Plan

## Context

PrintPainter is an open-source (GPL-3.0-or-later), donation-funded (Ko-fi) **Substance-style painter for multi-material 3D printing**. The user paints with a palette of filaments on common mesh formats **and STEP files**, using layers and smart masks, and exports **slice-ready 3MF files** for Bambu Studio, OrcaSlicer and PrusaSlicer. Existing slicers only offer basic per-triangle painting; this tool brings a real layer/mask workflow without reusing any slicer code.

It ships as a **fully client-side PWA** hosted on **GitHub Pages**. Models never leave the visitor's machine. Electron is a possible later wrapper if performance needs native; the architecture keeps that path open.

Decisions were settled in a grilling session (Q1–Q33). The remaining open items are listed at the end.

> **Folder note:** the project was moved from `A:\FlutterProjects\PrintPainter` to `A:\ElectronApps\PrintPainter` on 2026-11-08 (Step 0 done). Nothing hard-codes the absolute path.

---

## Settled decisions

| Area | Decision |
|---|---|
| Modes | **Filament mode** in v1. Texture/PBR painting mode is a later version |
| Platform | PWA, Chrome/Edge first, Windows first, macOS/Linux kept working. Electron later only if needed |
| Stack | Vue 3 + TypeScript + Vite + Pinia (UI). three.js engine as plain TS, outside Vue reactivity |
| Import | STL, OBJ(+MTL), 3MF, glTF/GLB, PLY, STEP/STP; FBX best-effort |
| Units | Internal unit = mm. Detect on import (STL/3MF = mm, STEP reads its own units, glTF = m, OBJ/FBX: confirm with a bounding-box guess). **Units can be changed after import** |
| Import cleanup | Merge duplicate vertices, remove degenerate triangles, fix inverted normals, then a watertightness check that **warns and highlights open edges only, no repair** |
| STEP | Tessellate with occt-import-js (quality slider), keep B-rep face IDs, assembly parts become separate objects |
| Scene | One project = one scene with several objects. Exports to one 3MF, relative positions kept |
| Paint storage | Separate non-overlapping **xatlas paint atlas** per object (original UVs kept for the future texture mode). **R8 slot-index texture**, 0.1 mm/texel default, 8192² page cap with extra pages as needed, hard-edged |
| Palette | 1–16 slots (name, colour, material type). Slot 1 = base/unpainted. Import Orca/Bambu filament preset JSON; save/load user palettes |
| Tools | Brush and eraser (size in mm, painted through the camera view), bucket fill (angle threshold / UV island / STEP face), straight-line and lasso fills, X/Y/Z symmetry, hide/isolate, undo/redo |
| Layers | Each layer = one slot + a mask stack, combined top-down. v1 masks: painted, angle, height bands, curvature/edge, image/SVG/text decal with threshold. Phase 2: noise/patterns, AO/cavity, world gradients, reusable masks |
| Export | Boundary tracing → smoothing (0.05 mm default, slider) → **exact watertight triangle cutting** → export preview (triangle count + watertightness) → writers: **Bambu/Orca `paint_color`** first, **Prusa `slic3rpe:mmu_segmentation`** later. Filament colours and types included, no printer/process profiles |
| Deferred | One-object-per-filament fallback (so no Cura for now), mesh repair, relief/emboss painting, texture mode/PBR exports, Electron |
| Navigation | Bambu/Orca-style by default; Blender and Substance/Maya presets |
| Project file | `.ppaint` zip: original source file, paint mesh + atlas UVs, layers JSON, mask and slot PNGs, palette, units |
| Persistence | File System Access API (open/save in place) with upload/download fallback; OPFS autosave |
| Repo | Public GitHub, GPL-3.0-or-later, GitHub Actions CI, Ko-fi link in About panel and README, **no telemetry** |
| Hosting | GitHub Pages (static, HTTPS), deployed by GitHub Actions. Single-threaded WASM baseline, threads via a service worker that adds COOP/COEP |

---

## Architecture

```
printpainter/
  src/
    app/            Vue 3 UI: panels, toolbars, dialogs, Pinia stores (UI state only)
    engine/         three.js viewport, camera presets, picking (three-mesh-bvh), GPU paint passes, preview shaders
    core/           Pure TS, no DOM: mesh cleanup, units, atlas data, slot maps, layer/mask model,
                    tile undo, contour tracing, smoothing, triangle cutting, watertight check
    io/
      import/       Per-format loaders → common SceneMesh (positions, indices, faceIds?, units)
      export/3mf/   Shared 3MF writer core + bambu.ts, prusa.ts dialects
      project/      .ppaint read/write (fflate)
    platform/       PlatformFS interface: web.ts now (FSA + fallback + OPFS); electron.ts later via preload IPC
    workers/        occt.worker, xatlas.worker, export.worker (Comlink)
  public/           PWA manifest, icons
  tests/
    unit/           Vitest
    fixtures/       Golden models: STL, OBJ, glTF, 3MF, PLY, STEP assembly, non-manifold sample
    e2e/            Playwright
  ci/               slicer-check scripts (OrcaSlicer / PrusaSlicer CLI)
```

**Electron readiness:** all file and OS access goes through `src/platform/PlatformFS`. Heavy work runs in Web Workers with WASM, which also runs unchanged in Electron. `core/` has no DOM dependencies, so it could later move into a Node/native process.

### Libraries (all GPL-3-compatible; pin exact versions at scaffold time)
three, three-mesh-bvh (MIT) · occt-import-js (LGPL, WASM) · xatlas WASM build (MIT) · fflate (MIT) · cdt2d or poly2tri (MIT/BSD) for constrained triangulation · comlink (Apache-2.0) · vite-plugin-pwa (MIT) · pinia · vitest · playwright. three.js loaders cover STL/OBJ/MTL/3MF/GLTF/PLY/FBX.

### Key technical approach
- **Paint pipeline (GPU):** after unwrapping, bake per-atlas **world-position, normal and curvature maps** once. Each brush dab runs a pass over the atlas: a texel is painted if its world position is inside the brush radius (in mm), it faces the camera, and it passes a depth test against the camera depth buffer, so occluded areas aren't painted. Slot maps use `R8UI`/nearest sampling. A chart-dilation pass prevents seam bleeding. Symmetry mirrors the brush center.
- **Undo:** dirty-tile snapshots (256² tiles) per layer texture.
- **Layers:** a GPU composite pass, top-down, produces the final slot map. Procedural masks are computed from the baked maps (angle = normal·axis, height bands = world Z, curvature = baked map, decals = projected image/SVG thresholded).
- **Print preview mode:** shows the composite slot map in palette colours. Export preview shows the actual cut mesh.
- **Export (worker):** read back the composite → per-chart multi-label boundary tracing (marching squares) → RDP + Chaikin smoothing to a tolerance in mm → for each triangle, clip boundary polylines in that triangle's UV space. **Crossings on mesh edges are computed once per 3D edge (edge key + parameter t)** and shared by neighbouring triangles, so UV seams stay crack-free. Then constrained triangulation inside each triangle, with each sub-triangle's slot taken from its centroid sample. Watertight check = every edge used exactly twice, matching orientation.
- **3MF writers:** written by us from the 3MF spec plus observed real files, no slicer code. A shared core (zip, `[Content_Types].xml`, rels, model XML, units = mm). The Bambu/Orca dialect adds per-triangle `paint_color` and project config with `filament_colour`/`filament_type`. The Prusa dialect adds `slic3rpe:mmu_segmentation` and extruder colours. Because every output triangle is uniform, only "whole-triangle state" codes are needed (no subdivision trees).

---

## Milestones

**Step 0 (done 2026-11-08):** plan saved as `PLAN.md`, folder moved to `A:\ElectronApps\PrintPainter`.

- **M0 Format spike (Bambu Studio done 2026-11-08; OrcaSlicer deferred to M3, PrusaSlicer to M7).** Findings in `docs/3mf-dialects.md`: `paint_color` in a plain 3MF works; the `Application` field decides "from Bambu Lab"; leaning towards `paint_color`-only as the Bambu default. Original task: hand-build minimal 3MFs (cube, 2–4 colours, including slot ≥ 3 to exercise the extended state codes). Confirm they open in **Bambu Studio and OrcaSlicer** with the right colours and filament slots. Record the minimum required file set and state-code encoding in `docs/3mf-dialects.md`. Repeat for PrusaSlicer.
- **M1 Shell and import (done 2026-11-08; glTF/FBX paths still need a real-file check):** `git init`, Vite + Vue + TS + PWA scaffold, GPL licence, CI skeleton. Viewport with navigation presets. All importers (STEP in a worker), unit detection and the change-units dialog, cleanup and watertightness warning with open-edge highlight, multi-object scene and outliner.
- **M2 Paint core:** xatlas worker, baked maps, slot-index textures, palette panel (1–16, preset import, save/load), brush/eraser in mm, symmetry, tile undo/redo, hide/isolate, print preview mode.
- **M3 Bambu/Orca export → first real print:** tracing, smoothing, exact cutting, watertight check, export preview, Bambu/Orca writer, slicer-check job in CI.
- **M4 Persistence:** `.ppaint` read/write, OPFS autosave and crash recovery, FSA open/save with fallback.
- **M5 Fill tools:** bucket fill (angle / UV island / STEP face), straight-line and lasso fills.
- **M6 Layers and masks:** layer stack UI, painted, angle, height-band, curvature, and image/SVG/text decal masks.
- **M7 PrusaSlicer export.**
- **M8 Release:** offline install polish, icons, docs, Ko-fi links, COOP/COEP service-worker enhancement, production Pages deploy on tag, v1.0 live on GitHub Pages.

---

## Hosting: GitHub Pages
Visitors just open the URL in Chrome/Edge (and can install it as a PWA). Nobody runs a server. Static build, deployed by GitHub Actions (`actions/deploy-pages`): a preview build on `main` and a production build on tagged releases. Pages provides HTTPS and serves `.wasm` as `application/wasm`.

- **Base path:** `https://<user>.github.io/printpainter/` by default, which means Vite `base: '/printpainter/'`. Set through an env var so a custom domain (CNAME, base `/`) can be switched on later with no code change.
- **No custom headers on Pages:** COOP/COEP can't be set, so `SharedArrayBuffer` and multithreaded WASM are unavailable by default. Plan:
  - **Baseline is single-threaded WASM** (occt-import-js and xatlas both run single-threaded in workers). Everything works without isolation.
  - **Progressive enhancement:** our own PWA service worker (vite-plugin-pwa `injectManifest`) adds `Cross-Origin-Opener-Policy: same-origin` / `Cross-Origin-Embedder-Policy: require-corp` to responses it serves, the same technique coi-serviceworker uses, merged into our one SW to avoid two competing service workers. Once `crossOriginIsolated === true` (after the first reload), threaded builds are used where available.
  - All assets are loaded same-origin, so cross-origin isolation blocks nothing.
- Limits (1 GB site, ~100 GB/month soft bandwidth) are well beyond a static app's needs. `public/.htaccess` is dropped.

---

## Verification
- **Unit (Vitest):** unit conversion; cleanup (weld/degenerate/normals); boundary tracing on synthetic label maps; smoothing tolerance; cutting produces **watertight** output (every edge used exactly twice) on fixtures including seam-crossing boundaries; 3MF XML is well-formed and matches the expected dialect structure.
- **Golden fixtures:** each import format loads with the expected triangle count, units and object count. The STEP assembly yields separate parts with face IDs.
- **Real-slicer check (CI):** exported 3MFs are loaded and sliced by the OrcaSlicer and PrusaSlicer CLIs. The build fails if a slicer rejects a file or the filament count is wrong. Manual Bambu Studio check each milestone.
- **E2E (Playwright):** import STL → paint stroke → export 3MF → file downloads and passes the watertight check. Plus project save/load round trip.
- **Manual:** after M3, print a 2–4 colour test model on a real AMS printer.
