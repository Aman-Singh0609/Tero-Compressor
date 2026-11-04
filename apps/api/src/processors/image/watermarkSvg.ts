import opentype from 'opentype.js';
import { openTypeFont } from '../shared/fonts';

const COLORS: Record<string, { fill: string; stroke: string }> = {
  white: { fill: '#ffffff', stroke: '#000000' },
  black: { fill: '#000000', stroke: '#ffffff' },
  red: { fill: '#d92626', stroke: '#ffffff' },
  blue: { fill: '#1a40d9', stroke: '#ffffff' },
};

/**
 * Lay the text out one glyph at a time. opentype.js's own shaping engine chokes on some OpenType
 * tables, and per-glyph layout is fully deterministic (no ligatures or right-to-left shaping, which
 * a family watermark does not need).
 */
export function layoutText(font: opentype.Font, text: string, size: number): { d: string; width: number } {
  const scale = size / font.unitsPerEm;
  const path = new opentype.Path();
  let x = 0;
  for (const ch of Array.from(text)) {
    const glyph = font.charToGlyph(ch);
    path.extend(glyph.getPath(x, 0, size));
    x += (glyph.advanceWidth ?? 0) * scale;
  }
  return { d: path.toPathData(2), width: x };
}

export interface WatermarkSpec {
  text: string;
  position: 'center' | 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'tile';
  opacity: number; // 5..100
  sizePercent: number; // 2..40, relative to the image width
  color: string;
  width: number;
  height: number;
}

/**
 * A full-image SVG overlay with the text turned into vector outlines (using the bundled DejaVu font),
 * so the result is identical on every machine and never depends on system fonts.
 */
export async function buildWatermarkSvg(spec: WatermarkSpec): Promise<Buffer> {
  const font = await openTypeFont('bold');
  const { width, height } = spec;
  let fontSize = Math.max(10, width * (spec.sizePercent / 100) * 0.6);
  const maxTextWidth = width * 0.92;
  const first = layoutText(font, spec.text, fontSize);
  if (first.width > maxTextWidth) fontSize = (fontSize * maxTextWidth) / first.width;
  const { d, width: textWidth } = layoutText(font, spec.text, fontSize);
  const colors = COLORS[spec.color] ?? COLORS.white!;
  const opacity = (spec.opacity / 100).toFixed(2);
  const strokeWidth = (fontSize * 0.035).toFixed(2);
  const glyph = (x: number, y: number, extra = '') =>
    `<use xlink:href="#t" x="${x.toFixed(1)}" y="${y.toFixed(1)}"${extra}/>`;
  const margin = width * 0.02;
  const capHeight = fontSize * 0.72;
  const body: string[] = [];
  switch (spec.position) {
    case 'tile': {
      const stepX = textWidth * 1.5;
      const stepY = fontSize * 3;
      const rows = Math.min(40, Math.ceil((height * 1.6) / stepY) + 1);
      const cols = Math.min(40, Math.ceil((width * 1.6) / stepX) + 1);
      for (let r = -1; r < rows; r++) {
        for (let c = -1; c < cols; c++) body.push(glyph(c * stepX + (r % 2 ? stepX / 2 : 0), r * stepY));
      }
      break;
    }
    case 'center':
      body.push(glyph((width - textWidth) / 2, (height + capHeight) / 2));
      break;
    default: {
      const x = spec.position.endsWith('left') ? margin : width - margin - textWidth;
      const y = spec.position.startsWith('top') ? margin + capHeight : height - margin;
      body.push(glyph(x, y));
    }
  }
  const group =
    spec.position === 'tile'
      ? `<g transform="rotate(-30 ${width / 2} ${height / 2})">${body.join('')}</g>`
      : body.join('');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<defs><path id="t" d="${d}" fill="${colors.fill}" fill-opacity="${opacity}" stroke="${colors.stroke}" stroke-opacity="${(Number(opacity) * 0.6).toFixed(2)}" stroke-width="${strokeWidth}" paint-order="stroke"/></defs>` +
      `${group}</svg>`,
  );
}
