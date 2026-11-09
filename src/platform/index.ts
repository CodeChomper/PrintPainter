import type { PlatformFS } from './PlatformFS';
import { webFS } from './web';

export type { PlatformFS, OpenFileOptions } from './PlatformFS';

export const platform: PlatformFS = webFS;
