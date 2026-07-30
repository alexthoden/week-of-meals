'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Recipe photos live on disk next to the database, and every photo is copied
 * here rather than hot-linked.
 *
 * Hot-linking looks like the cheap option until the recipe site reorganises
 * and the whole library goes grey, or you are cooking on a phone with no
 * signal in a basement kitchen. A copy costs a few hundred kilobytes and the
 * picture is yours.
 *
 * Uploads arrive already resized by the browser (canvas, long edge 1000px,
 * JPEG) so there is no image library to install and nothing to compile.
 *
 * Every household gets its own directory. That is not tidiness: collectGarbage
 * deletes every file in its directory that no recipe refers to, so pointing two
 * households at one directory would make either household's photo tidy-up
 * delete the other household's photos. The isolation is what makes that
 * operation safe to offer at all.
 */

const MAX_BYTES = 6 * 1024 * 1024;

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

/**
 * The only filenames we will read back out.
 *
 * Photos used to be served by express.static, which does its own traversal
 * checking. They are now served by a handler that takes the name from the URL
 * and joins it onto a household's directory, so this pattern is what stops
 * `../` (or another household's id) from walking out of that directory.
 */
const SAFE_NAME = /^[A-Za-z0-9]+\.[a-z0-9]+$/;

/**
 * Photo storage rooted at one directory.
 * @param {string} dir  absolute path; one per household
 */
function createImages(dir) {
  const IMAGE_DIR = dir;

  function ensureDir() {
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
  }

  /** Public URL the browser uses, e.g. "/images/ab12cd34.jpg". */
  function publicPath(filename) {
    return `/images/${filename}`;
  }

  function write(buffer, ext) {
    ensureDir();
    const name = `${crypto.randomBytes(8).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(IMAGE_DIR, name), buffer);
    return publicPath(name);
  }

  /**
   * Store a browser upload sent as a data URL.
   * @returns {string} public path
   */
  function saveDataUrl(dataUrl) {
    const m = String(dataUrl || '').match(/^data:(image\/[a-z+]+);base64,([\s\S]+)$/i);
    if (!m) {
      const err = new Error('That file did not look like an image.');
      err.code = 'BAD_IMAGE';
      throw err;
    }
    const ext = EXT_BY_TYPE[m[1].toLowerCase()];
    if (!ext) {
      const err = new Error(`${m[1]} images are not supported. Try a JPEG or PNG.`);
      err.code = 'BAD_IMAGE';
      throw err;
    }
    const buffer = Buffer.from(m[2], 'base64');
    if (!buffer.length) {
      const err = new Error('That image came through empty.');
      err.code = 'BAD_IMAGE';
      throw err;
    }
    if (buffer.length > MAX_BYTES) {
      const err = new Error('That image is too large. Under 6 MB, please.');
      err.code = 'BAD_IMAGE';
      throw err;
    }
    return write(buffer, ext);
  }

  /**
   * Download a remote image and keep a copy.
   * Never throws: a missing picture must not stop a recipe from being saved,
   * so a failure just hands back the original URL and the browser tries its luck.
   */
  async function cacheRemote(url) {
    if (!/^https?:\/\//i.test(url || '')) return url || '';
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8',
          referer: new URL(url).origin,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return url;

      const type = String(res.headers.get('content-type') || '').split(';')[0].toLowerCase();
      const ext = EXT_BY_TYPE[type] || path.extname(new URL(url).pathname).toLowerCase();
      if (!Object.values(EXT_BY_TYPE).includes(ext)) return url;

      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_BYTES) return url;

      return write(buffer, ext);
    } catch {
      return url;
    }
  }

  /** Absolute path of a stored photo, or null if that is not a name we serve. */
  function fileFor(filename) {
    const name = String(filename || '');
    if (!SAFE_NAME.test(name)) return null;
    return path.join(IMAGE_DIR, name);
  }

  /** Delete a stored image. Ignores anything that isn't ours. */
  function remove(publicUrl) {
    const m = String(publicUrl || '').match(/^\/images\/([A-Za-z0-9]+\.[a-z]+)$/);
    if (!m) return;
    try { fs.unlinkSync(path.join(IMAGE_DIR, m[1])); } catch { /* already gone */ }
  }

  /**
   * Remove any stored image no longer referenced by a recipe.
   *
   * Scoped to this household's directory, and it must stay that way: it deletes
   * everything it finds that is not in `recipes`, so handing it one household's
   * recipes while pointed at a shared directory would wipe every other
   * household's photos.
   */
  function collectGarbage(recipes) {
    ensureDir();
    const keep = new Set(
      recipes.map((r) => String(r.image || '').replace('/images/', '')).filter(Boolean),
    );
    let removed = 0;
    for (const file of fs.readdirSync(IMAGE_DIR)) {
      if (!keep.has(file)) {
        try { fs.unlinkSync(path.join(IMAGE_DIR, file)); removed += 1; } catch { /* ignore */ }
      }
    }
    return removed;
  }

  return {
    IMAGE_DIR, saveDataUrl, cacheRemote, remove, collectGarbage, publicPath, fileFor,
  };
}

module.exports = {
  createImages, MAX_BYTES, EXT_BY_TYPE, SAFE_NAME,
};
