import { useEffect, useState } from 'react';
import { thumbUrl } from './connection.js';

export const DEFAULT_TINT = '#3a3a3a';
const cache = new Map();

/** Colore dominante "vivo" della copertina, scurito quanto basta per tenere leggibile il testo bianco. */
function extract(img) {
  const size = 24;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  let r = 0, g = 0, b = 0, w = 0;
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i], G = data[i + 1], B = data[i + 2];
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    const sat = max ? (max - min) / max : 0;
    const light = max / 255;
    // Pesano di più i pixel saturi e non troppo scuri né bianchi.
    const weight = 0.05 + sat * sat * (light > 0.15 && light < 0.95 ? 1 : 0.2);
    r += R * weight; g += G * weight; b += B * weight; w += weight;
  }
  r /= w; g /= w; b /= w;
  // In HSL: luminosità tra 30% e 42%, saturazione massima 65%.
  const [h, s, l] = rgbToHsl(r, g, b);
  return `hsl(${Math.round(h)} ${Math.round(Math.min(s, 0.65) * 100)}% ${Math.round(Math.min(Math.max(l, 0.3), 0.42) * 100)}%)`;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

export function useCoverColor(src) {
  const [color, setColor] = useState(() => (src && cache.get(src)) || DEFAULT_TINT);
  useEffect(() => {
    if (!src) return setColor(DEFAULT_TINT);
    if (cache.has(src)) return setColor(cache.get(src));
    let alive = true;
    const img = new Image();
    img.onload = () => {
      try {
        const col = extract(img);
        cache.set(src, col);
        if (alive) setColor(col);
      } catch {
        /* immagine non leggibile: resta il colore attuale */
      }
    };
    img.src = thumbUrl(src);
    return () => {
      alive = false;
    };
  }, [src]);
  return color;
}
