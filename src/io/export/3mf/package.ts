// Shared 3MF package pieces: [Content_Types].xml, relationships, model XML helpers
// and zipping. Written from the 3MF core spec; no slicer code.

import { zipSync, type Zippable } from 'fflate';

export const NS_CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const REL_MODEL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';

export const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>
`;

export const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="${REL_MODEL}"/>
</Relationships>
`;

export const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Millimetre coordinate with up to 6 decimals and no trailing zeros. */
export function num(v: number): string {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
}

/** Builds a large string from many small parts without one huge concatenation chain. */
export class Chunks {
  private parts: string[] = [];
  private buf: string[] = [];
  push(s: string): void {
    this.buf.push(s);
    if (this.buf.length >= 8192) this.flush();
  }
  private flush(): void {
    if (this.buf.length) this.parts.push(this.buf.join(''));
    this.buf = [];
  }
  bytes(): Uint8Array {
    this.flush();
    const enc = new TextEncoder();
    const encoded = this.parts.map((p) => enc.encode(p));
    const out = new Uint8Array(encoded.reduce((n, e) => n + e.length, 0));
    let o = 0;
    for (const e of encoded) {
      out.set(e, o);
      o += e.length;
    }
    return out;
  }
}

export function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  const enc = new TextEncoder();
  const z: Zippable = {};
  for (const [name, data] of Object.entries(files)) z[name] = typeof data === 'string' ? enc.encode(data) : data;
  return zipSync(z, { level: 6 });
}
