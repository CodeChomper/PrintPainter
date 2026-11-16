import type { PlatformFS } from './PlatformFS';
import { webFS } from './web';

export type { FileTarget, OpenedFile, OpenFileOptions, PlatformFS, SavedFile } from './PlatformFS';

export const platform: PlatformFS = webFS;
