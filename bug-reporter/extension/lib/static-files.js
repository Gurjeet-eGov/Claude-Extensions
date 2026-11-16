// Map tiles, fonts, images, scripts, style sheets and build files: captured, but rarely
// what a bug report needs. Failed calls are never treated as static.
const STATIC_EXT = /\.(png|jpe?g|gif|svg|webp|ico|bmp|pbf|mvt|woff2?|ttf|otf|eot|css|m?js|map|wasm|mp4|webm|mp3)$/i;
const STATIC_DIR = /\/(fonts?|sprites?|tiles?|styles?|static|assets|images?|icons?|planet)(\/|$)/i;
const STATIC_TYPE = /^(image|font|audio|video)\/|protobuf|octet-stream|text\/css|javascript/i;
export function isStatic(c) {
  if (c.failed) return false;
  let path = '';
  try {
    path = new URL(c.url).pathname;
  } catch {}
  const ct = String(c.resHeaders?.['content-type'] || '');
  return (
    STATIC_EXT.test(path) ||
    STATIC_TYPE.test(ct) ||
    (c.method === 'GET' && (STATIC_DIR.test(path) || /\.json$/i.test(path)))
  );
}
