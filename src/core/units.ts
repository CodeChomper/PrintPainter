/** Internal unit is the millimetre. These are the units a source file may be in. */
export type LengthUnit = 'um' | 'mm' | 'cm' | 'm' | 'in' | 'ft';

export const UNIT_TO_MM: Record<LengthUnit, number> = {
  um: 0.001,
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

export const UNIT_LABELS: Record<LengthUnit, string> = {
  um: 'Micrometres',
  mm: 'Millimetres',
  cm: 'Centimetres',
  m: 'Metres',
  in: 'Inches',
  ft: 'Feet',
};

export interface UnitGuess {
  unit: LengthUnit;
  /** True when the file format states its unit (or has a fixed convention). */
  certain: boolean;
  reason: string;
}

/**
 * Guesses the unit of a file that doesn't store one, from its largest extent in
 * file units. Prefers whichever unit gives a printable size (roughly 2–600 mm),
 * trying mm first because that's what most printable models use.
 */
export function guessUnitFromExtent(extent: number): UnitGuess {
  const order: LengthUnit[] = ['mm', 'cm', 'in', 'm'];
  if (!(extent > 0) || !Number.isFinite(extent)) {
    return { unit: 'mm', certain: false, reason: 'The model has no size, so millimetres are assumed.' };
  }
  for (const unit of order) {
    const mm = extent * UNIT_TO_MM[unit];
    if (mm >= 2 && mm <= 600) {
      return {
        unit,
        certain: false,
        reason: `${UNIT_LABELS[unit]} give a printable size.`,
      };
    }
  }
  return {
    unit: 'mm',
    certain: false,
    reason: 'No unit gives a typical printable size, so millimetres are assumed.',
  };
}

/** Parses a 3MF `unit` attribute. */
export function unitFrom3mf(attr: string | null): LengthUnit {
  switch ((attr ?? 'millimeter').toLowerCase()) {
    case 'micron':
      return 'um';
    case 'millimeter':
      return 'mm';
    case 'centimeter':
      return 'cm';
    case 'meter':
      return 'm';
    case 'inch':
      return 'in';
    case 'foot':
      return 'ft';
    default:
      return 'mm';
  }
}

export function formatMm(v: number): string {
  const a = Math.abs(v);
  const digits = a >= 100 ? 1 : a >= 10 ? 2 : 3;
  return `${Number(v.toFixed(digits))}`;
}

export function formatDims(size: readonly number[]): string {
  return `${size.map(formatMm).join(' × ')} mm`;
}
