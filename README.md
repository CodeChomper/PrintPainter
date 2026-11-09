# PrintPainter

A Substance-style painter for multi-material 3D printing. Paint with a palette of filaments on STL, OBJ, 3MF, glTF, PLY and STEP models, using layers and smart masks, then export slice-ready 3MF files for Bambu Studio, OrcaSlicer and PrusaSlicer.

It runs entirely in your browser as an installable web app. Your models never leave your computer, and there's no telemetry.

> **Status:** early development (milestone M1). See [PLAN.md](PLAN.md) for the roadmap and [docs/3mf-dialects.md](docs/3mf-dialects.md) for slicer format findings.

## Development

Requires Node.js 22+.

```sh
npm install
npm run dev        # dev server
npm test           # unit tests (Vitest)
npm run typecheck
npm run build      # production build in dist/
npm run spike:3mf  # regenerate the M0 3MF test files
```

## Licence

[GPL-3.0-or-later](LICENSE).
