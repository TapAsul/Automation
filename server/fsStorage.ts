import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  mimeTypeForFilename,
  type StorageBackend,
} from "./storageAdapter.js";

/**
 * Local Node.js filesystem implementation of `StorageBackend` rooted at
 * `.studio-data/`. Used during local development (`npm run dev` / `npm start`)
 * and maintains the exact same directory layout as the R2 bucket keys.
 */
export function createFsStorage(rootDir: string): StorageBackend {
  const resolvedRoot = path.resolve(rootDir);

  function resolveSafePath(key: string): string {
    const normalized = key.replace(/^\/+/, "").replace(/\\/g, "/");
    const target = path.resolve(resolvedRoot, normalized);
    if (
      target !== resolvedRoot &&
      !target.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
      throw new Error("Invalid storage path.");
    }
    return target;
  }

  async function walkDir(dir: string, relPrefix: string, out: string[]) {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walkDir(full, rel, out);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }

  return {
    kind: "filesystem",

    async getText(key) {
      const filePath = resolveSafePath(key);
      try {
        return await fsp.readFile(filePath, "utf8");
      } catch {
        return null;
      }
    },

    async putText(key, value) {
      const filePath = resolveSafePath(key);
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, value, "utf8");
    },

    async getBinary(key, range) {
      const filePath = resolveSafePath(key);
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(filePath);
        if (!stat.isFile()) return null;
      } catch {
        return null;
      }

      const totalSize = stat.size;
      const contentType = mimeTypeForFilename(filePath);

      if (range && totalSize > 0 && range.offset < totalSize) {
        const start = range.offset;
        const end =
          range.length !== undefined
            ? Math.min(totalSize - 1, start + range.length - 1)
            : totalSize - 1;
        const nodeStream = fs.createReadStream(filePath, { start, end });
        return {
          body: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
          contentType,
          totalSize,
          contentLength: end - start + 1,
          range: { start, end },
        };
      }

      const nodeStream = fs.createReadStream(filePath);
      return {
        body: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
        contentType,
        totalSize,
        contentLength: totalSize,
      };
    },

    async putBinary(key, data) {
      const filePath = resolveSafePath(key);
      await fsp.mkdir(path.dirname(filePath), { recursive: true });

      if (data instanceof Uint8Array) {
        await fsp.writeFile(filePath, data);
        return;
      }
      if (data instanceof ArrayBuffer) {
        await fsp.writeFile(filePath, new Uint8Array(data));
        return;
      }
      const nodeReadable = Readable.fromWeb(
        data as Parameters<typeof Readable.fromWeb>[0]
      );
      const writeStream = fs.createWriteStream(filePath);
      await pipeline(nodeReadable, writeStream);
    },

    async copy(sourceKey, targetKey) {
      const src = resolveSafePath(sourceKey);
      const dst = resolveSafePath(targetKey);
      try {
        await fsp.access(src, fs.constants.R_OK);
      } catch {
        return false;
      }
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(src, dst);
      return true;
    },

    async delete(key) {
      const filePath = resolveSafePath(key);
      await fsp.rm(filePath, { force: true });
    },

    async deletePrefix(prefix) {
      const target = resolveSafePath(prefix.replace(/\/+$/, ""));
      if (target === resolvedRoot) {
        throw new Error("Refusing to delete storage root.");
      }
      try {
        await fsp.access(target);
      } catch {
        return false;
      }
      await fsp.rm(target, { recursive: true, force: true });
      return true;
    },

    async listKeys(prefix) {
      const cleanPrefix = prefix.replace(/^\/+/, "").replace(/\\/g, "/");
      const allKeys: string[] = [];
      await walkDir(resolvedRoot, "", allKeys);
      return allKeys.filter((k) => k.startsWith(cleanPrefix)).sort();
    },
  };
}
