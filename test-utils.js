const assert = require('assert');

function getFilenameFromUrl(url) {
  try {
    const parsed = new URL(url, 'https://example.com');
    const pathname = parsed.pathname || '';
    let name = pathname.split('/').filter(Boolean).pop() || 'image';
    name = decodeURIComponent(name.replace(/\+/g, ' '));
    if (!/\.[a-zA-Z0-9]{1,6}$/.test(name)) {
      name += '.png';
    }
    return name;
  } catch (err) {
    return 'image.png';
  }
}

function cssPixelRatio(canvasWidth, canvasHeight, clientWidth, clientHeight, devicePixelRatio) {
  const logicalW = canvasWidth || Math.max(1, clientWidth || 1);
  const logicalH = canvasHeight || Math.max(1, clientHeight || 1);
  const cssW = clientWidth || logicalW / (devicePixelRatio || 1);
  const cssH = clientHeight || logicalH / (devicePixelRatio || 1);
  return { sx: cssW / logicalW, sy: cssH / logicalH };
}

module.exports = { getFilenameFromUrl, cssPixelRatio };
