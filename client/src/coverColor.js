import { useEffect, useState } from 'react';
import { thumbUrl } from './connection.js';

export const DEFAULT_TINT = '#3a3a3a';
const cache = new Map();

/** Colore dominante "vivo" della copertina, scurito quanto basta per tenere leggibile il testo bianco. */
function tintOf(data) {
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

const hsl = (h, s, l) => `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}
/** Luminanza relativa (WCAG) di un colore HSL. */
function luminanza(h, s, l) {
  const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = hslToRgb(h, s, l);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
/** Gialli e verdi chiari sono molto luminosi anche al 55 %: si scuriscono finché la luminanza resta sotto 0,2.
 *  Così con Marcata (40 %) il grigio #a8a8a8 dell'intestazione sul fondo resta sopra 4,5:1. */
function domaLuce(h, s, l) {
  while (l > 0.2 && luminanza(h, s, l) > 0.2) l -= 0.02;
  return l;
}

/**
 * Modalità Ambiente: i 3 colori dominanti della copertina, «addomesticati» (saturazione max 65%,
 * luminosità 30-55%). Le tinte si contano in 12 settori di 30°; vincono i 3 più pesanti. Se la copertina
 * ha un colore solo, gli altri due sono sue varianti più scure; se è grigia o quasi nera, il fondo resta
 * grigio scuro (mai un colore inventato).
 */
function paletteOf(data) {
  const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let nw = 0, nr = 0, ng = 0, nb = 0;
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i], G = data[i + 1], B = data[i + 2];
    const [h, s, l] = rgbToHsl(R, G, B);
    if (s > 0.25 && l > 0.12 && l < 0.92) {
      const k = Math.floor(h / 30) % 12;
      const w = s * s * (1 - Math.abs(l - 0.5));
      const bin = bins[k];
      bin.w += w; bin.r += R * w; bin.g += G * w; bin.b += B * w;
    } else {
      nw += 1; nr += R; ng += G; nb += B;
    }
  }
  const tot = bins.reduce((a, x) => a + x.w, 0);
  const pixels = data.length / 4;
  // Colori veri solo se la parte colorata non è trascurabile (almeno un 4% di peso sulla miniatura).
  const vivi = tot / pixels > 0.04
    ? bins.filter((x) => x.w > 0.12 * Math.max(...bins.map((y) => y.w))).sort((a, b) => b.w - a.w).slice(0, 3)
    : [];
  const out = vivi.map((x) => {
    const [h, s, l] = rgbToHsl(x.r / x.w, x.g / x.w, x.b / x.w);
    const s2 = Math.min(s, 0.65);
    return [h, s2, domaLuce(h, s2, clamp(l, 0.3, 0.55))];
  });
  if (!out.length) {
    // Grigia o quasi nera: la media dei pixel neutri, scura e poco satura.
    const [h, s, l] = nw ? rgbToHsl(nr / nw, ng / nw, nb / nw) : [0, 0, 0.23];
    out.push([h, Math.min(s, 0.2), domaLuce(h, Math.min(s, 0.2), clamp(l, 0.15, 0.4))]);
  }
  const [h0, s0, l0] = out[0];
  while (out.length < 3) out.push([h0, s0, Math.max(l0 - 0.1 * out.length, 0.12)]);
  return out.map(([h, s, l]) => hsl(h, s, l));
}

function extract(img) {
  const size = 24;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  return { tint: tintOf(data), palette: paletteOf(data) };
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

export const DEFAULT_PALETTE = [DEFAULT_TINT, DEFAULT_TINT, DEFAULT_TINT];
const NEUTRO = { tint: DEFAULT_TINT, palette: DEFAULT_PALETTE };

/** { tint, palette }: velo di un colore (come prima) e i 3 colori della Modalità Ambiente. */
export function useCoverColors(src) {
  const [colors, setColors] = useState(() => (src && cache.get(src)) || NEUTRO);
  useEffect(() => {
    if (!src) return setColors(NEUTRO);
    if (cache.has(src)) return setColors(cache.get(src));
    let alive = true;
    const img = new Image();
    img.onload = () => {
      try {
        const col = extract(img);
        cache.set(src, col);
        if (alive) setColors(col);
      } catch {
        /* immagine non leggibile: restano i colori attuali */
      }
    };
    img.src = thumbUrl(src);
    return () => {
      alive = false;
    };
  }, [src]);
  return colors;
}
