import { vfs as browserVfs, type VirtualFileSystem } from '@/lib/vfs';
import { asText } from '@/lib/vfs/as-text';
import { parseSrc, sourceRef } from './resolution';

/**
 * A `data-osw-src` value as the agent is given it, `/index.html:16:5` (see `sourceRef`). `null`
 * when the value is malformed or its file cannot be read.
 */
export async function sourceRefOf(projectId: string, srcAttr: string, fs: VirtualFileSystem = browserVfs): Promise<string | null> {
  const parts = parseSrc(srcAttr);
  if (!parts) return null;
  try {
    return sourceRef(parts[0], asText((await fs.readFile(projectId, parts[0])).content), parts[1]);
  } catch {
    return null;
  }
}
