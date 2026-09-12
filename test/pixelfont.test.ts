import { describe, it, expect } from 'vitest';
import { __SMALL_GLYPHS__, __BIG_GLYPHS__, FONT_SMALL_H, FONT_BIG_H } from '@/render/pixelfont';

describe('pixelfont small glyph table', () => {
  it('every glyph is exactly 7 rows of 5 chars', () => {
    for (const [ch, rows] of Object.entries(__SMALL_GLYPHS__)) {
      expect(rows.length, `glyph ${JSON.stringify(ch)} row count`).toBe(7);
      expect(rows.length).toBe(FONT_SMALL_H);
      for (const row of rows) {
        expect(row.length, `glyph ${JSON.stringify(ch)} row "${row}"`).toBe(5);
        expect(/^[.#]+$/.test(row), `glyph ${JSON.stringify(ch)} has only . and # chars`).toBe(true);
      }
    }
  });

  it('covers ASCII 32-126', () => {
    for (let code = 32; code <= 126; code++) {
      const ch = String.fromCharCode(code);
      expect(__SMALL_GLYPHS__[ch], `missing small glyph for ${JSON.stringify(ch)} (${code})`).toBeDefined();
    }
  });

  it('covers lowercase a-z', () => {
    for (let code = 97; code <= 122; code++) {
      const ch = String.fromCharCode(code);
      expect(__SMALL_GLYPHS__[ch]).toBeDefined();
    }
  });
});

describe('pixelfont big glyph table', () => {
  it('every glyph is exactly 11 rows of 7 chars', () => {
    for (const [ch, rows] of Object.entries(__BIG_GLYPHS__)) {
      expect(rows.length, `glyph ${JSON.stringify(ch)} row count`).toBe(11);
      expect(rows.length).toBe(FONT_BIG_H);
      for (const row of rows) {
        expect(row.length, `glyph ${JSON.stringify(ch)} row "${row}"`).toBe(7);
        expect(/^[.#]+$/.test(row), `glyph ${JSON.stringify(ch)} has only . and # chars`).toBe(true);
      }
    }
  });

  it('covers A-Z and 0-9', () => {
    for (let code = 65; code <= 90; code++) {
      expect(__BIG_GLYPHS__[String.fromCharCode(code)]).toBeDefined();
    }
    for (let code = 48; code <= 57; code++) {
      expect(__BIG_GLYPHS__[String.fromCharCode(code)]).toBeDefined();
    }
  });

  it('covers required punctuation . , : - / ( ) ! \' ?', () => {
    for (const ch of ['.', ',', ':', '-', '/', '(', ')', '!', "'", '?']) {
      expect(__BIG_GLYPHS__[ch], `missing big glyph for ${JSON.stringify(ch)}`).toBeDefined();
    }
  });
});
