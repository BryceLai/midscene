import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';

export async function pack(directory, file) {
  const zip = new yazl.ZipFile();
  let total = 0;
  const add = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('采集目录中不允许符号链接');
      if (entry.isDirectory()) await add(absolute);
      else if (entry.isFile()) {
        total += (await stat(absolute)).size;
        if (total > 256 * 1024 * 1024)
          throw new Error('采集包超过 256 MiB 上限');
        zip.addFile(
          absolute,
          path.relative(directory, absolute).split(path.sep).join('/'),
        );
      }
    }
  };
  await add(directory);
  const done = pipeline(zip.outputStream, createWriteStream(file));
  zip.end();
  await done;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { bytes: (await stat(file)).size, sha256: hash.digest('hex') };
}
