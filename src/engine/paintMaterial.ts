import {
  Color,
  DataTexture,
  DoubleSide,
  MeshStandardMaterial,
  NearestFilter,
  RedFormat,
  ShaderMaterial,
  UnsignedByteType,
  type Texture,
} from 'three';
import { MAX_SLOTS } from '@/core/paint';

/** Palette colours shared by every paint material. Index 0 = unpainted (drawn as slot 1). */
export interface PaletteUniform {
  value: Color[];
}

export function createPaletteUniform(): PaletteUniform {
  return { value: Array.from({ length: MAX_SLOTS + 1 }, () => new Color('#c9ccd3')) };
}

/** R8 slot-index texture over a CPU-side Uint8Array (shared, not copied). */
export function createSlotTexture(data: Uint8Array, width: number, height: number): DataTexture {
  const tex = new DataTexture(data, width, height, RedFormat, UnsignedByteType);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Lit, flat-shaded material whose base colour comes from the slot map: each fragment
 * fetches its texel (no filtering, hard edges) and looks the slot up in the palette.
 * The paint UV varying is `centroid` so MSAA never extrapolates it into a chart gutter.
 */
export function createPaintMaterial(palette: PaletteUniform, slotMap: Texture | null): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({
    flatShading: true,
    roughness: 0.8,
    metalness: 0,
    side: DoubleSide, // open meshes stay visible from inside
    polygonOffset: true, // keeps edge highlights on top of their faces
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const uniforms = {
    slotMap: { value: slotMap },
    hasPaint: { value: slotMap ? 1 : 0 },
    palette,
  };
  mat.userData.paintUniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 paintUv;\ncentroid varying vec2 vPaintUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPaintUv = paintUv;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D slotMap;
uniform float hasPaint;
uniform vec3 palette[${MAX_SLOTS + 1}];
centroid varying vec2 vPaintUv;`,
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `int slot = 0;
if ( hasPaint > 0.5 ) {
  ivec2 size = textureSize( slotMap, 0 );
  ivec2 texel = clamp( ivec2( floor( vPaintUv ) ), ivec2( 0 ), size - 1 );
  slot = int( texelFetch( slotMap, texel, 0 ).r * 255.0 + 0.5 );
}
vec4 diffuseColor = vec4( palette[ clamp( slot, 0, ${MAX_SLOTS} ) ], opacity );`,
      );
  };
  mat.customProgramCacheKey = () => 'printpainter-paint';
  return mat;
}

/** Writes view-space depth (distance along the view axis) to the red channel. */
export function createDepthMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    side: DoubleSide,
    vertexShader: `varying float vDepth;
void main() {
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: `varying float vDepth;
void main() {
  gl_FragColor = vec4( vDepth, 0.0, 0.0, 1.0 );
}`,
  });
}
