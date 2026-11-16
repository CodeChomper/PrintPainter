// Bambu Studio / OrcaSlicer dialect: a plain single-model 3MF where every triangle
// carries a `paint_color` state code for its filament (docs/3mf-dialects.md, route A).
//
// What Bambu Studio 02.09 does with it (tested in M0): it opens the file as "not from
// Bambu Lab", loads geometry and painting, and keeps the user's printer and filament
// presets. Filament N in the file is slot N of our palette, so slot order is kept;
// the colours themselves are not applied (the user picks matching filaments).
// We write an honest Application name; claiming to be Bambu Studio makes it replace
// the user's printer preset.

import type { PaletteSlot } from '@/core/palette';
import { encodeTriangleState } from './stateCode';
import { Chunks, CONTENT_TYPES, escapeXml, NS_CORE, num, ROOT_RELS, zip } from './package';

export interface ExportObject {
  name: string;
  /** World positions in mm (Z up, plate centred on the origin). */
  positions: Float64Array;
  indices: Uint32Array;
  /** Slot (1..16) per triangle. */
  slots: Uint8Array;
}

export interface BambuOptions {
  /** e.g. "PrintPainter-0.3.0". */
  application: string;
  palette: readonly PaletteSlot[];
  /** Where the plate centre is in slicer coordinates (Bambu X1/P1: 128, 128). */
  plateCentre: [number, number];
  /**
   * Also write Metadata/project_settings.config with filament colours and types.
   * Bambu Studio ignores it for files it didn't write (M0 test B); kept optional
   * until the OrcaSlicer checks show whether Orca uses it.
   */
  filamentSettings?: boolean;
}

export function write3mfBambu(objects: readonly ExportObject[], opts: BambuOptions): Uint8Array {
  const xml = new Chunks();
  xml.push(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="${NS_CORE}">
 <metadata name="Application">${escapeXml(opts.application)}</metadata>
 <resources>
`);
  const items: string[] = [];
  objects.forEach((o, n) => {
    const id = n + 1;
    // Local origin at the object's footprint centre, on its lowest point.
    const P = o.positions;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity;
    for (let i = 0; i < P.length; i += 3) {
      if (P[i]! < x0) x0 = P[i]!;
      if (P[i]! > x1) x1 = P[i]!;
      if (P[i + 1]! < y0) y0 = P[i + 1]!;
      if (P[i + 1]! > y1) y1 = P[i + 1]!;
      if (P[i + 2]! < z0) z0 = P[i + 2]!;
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    xml.push(`  <object id="${id}" type="model" name="${escapeXml(o.name)}">\n   <mesh>\n    <vertices>\n`);
    for (let i = 0; i < P.length; i += 3) {
      xml.push(`     <vertex x="${num(P[i]! - cx)}" y="${num(P[i + 1]! - cy)}" z="${num(P[i + 2]! - z0)}"/>\n`);
    }
    xml.push('    </vertices>\n    <triangles>\n');
    const codes = new Map<number, string>();
    const I = o.indices;
    for (let t = 0; t < o.slots.length; t++) {
      const s = o.slots[t]!;
      let code = codes.get(s);
      if (code === undefined) {
        code = encodeTriangleState(s);
        codes.set(s, code);
      }
      xml.push(`     <triangle v1="${I[t * 3]}" v2="${I[t * 3 + 1]}" v3="${I[t * 3 + 2]}" paint_color="${code}"/>\n`);
    }
    xml.push('    </triangles>\n   </mesh>\n  </object>\n');
    const tx = cx + opts.plateCentre[0], ty = cy + opts.plateCentre[1];
    items.push(`  <item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${num(tx)} ${num(ty)} ${num(z0)}" printable="1"/>`);
  });
  xml.push(` </resources>\n <build>\n${items.join('\n')}\n </build>\n</model>\n`);

  const files: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': ROOT_RELS,
    '3D/3dmodel.model': xml.bytes(),
  };
  if (opts.filamentSettings) {
    files['Metadata/project_settings.config'] = JSON.stringify(
      {
        filament_colour: opts.palette.map((p) => p.color.toUpperCase()),
        filament_type: opts.palette.map((p) => p.material),
      },
      null,
      4,
    );
  }
  return zip(files);
}
