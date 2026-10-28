import sanitizeHtml from 'sanitize-html';
import { decodeHTML } from 'entities';

const colors = [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i];
const align = [/^(?:left|center|right|justify)$/];
const styles = {
  p: { 'text-align': align },
  div: { 'text-align': align },
  h2: { 'text-align': align },
  h3: { 'text-align': align },
  h4: { 'text-align': align },
  span: { color: colors, 'background-color': colors, 'font-size': [/^(?:[1-2]?[0-9]|3[0-6])px$/], 'font-family': [/^(?:Arial|Georgia|Times New Roman|sans-serif|serif)(?:,\s*(?:Arial|Georgia|Times New Roman|sans-serif|serif))*$/i] },
  img: { width: [/^(?:[1-9][0-9]{0,3}|10000)px$/] },
  td: { 'text-align': align, 'background-color': colors },
  th: { 'text-align': align, 'background-color': colors },
};

export function plainFromHtml(html) {
  const withBreaks = html.replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote)>/gi, '\n');
  const encoded = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {}, disallowedTagsMode: 'discard' });
  return decodeHTML(encoded).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function cleanRichText(input, maxText = 20000) {
  if (typeof input !== 'string' || input.length > Math.max(maxText * 4, 12000)) throw new Error('Formatierter Text ist zu lang.');
  const html = sanitizeHtml(input, {
    allowedTags: ['p', 'div', 'br', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'ul', 'ol', 'li', 'blockquote', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'span', 'hr'],
    allowedAttributes: { a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'width', 'style'], p: ['style'], div: ['style'], h2: ['style'], h3: ['style'], h4: ['style'], span: ['style'], td: ['colspan', 'rowspan', 'style'], th: ['colspan', 'rowspan', 'style'] },
    allowedStyles: styles,
    allowedSchemes: ['https', 'http', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: 'noopener noreferrer' } }),
      img: (tagName, attribs) => {
        const width = /(?:^|;)\s*width\s*:\s*([1-9][0-9]{0,3})px\s*(?:;|$)/i.exec(attribs.style || '')?.[1] || attribs.width;
        const safeWidth = /^[1-9][0-9]{0,3}$/.test(width || '') ? Math.min(Number(width), 1600) : null;
        return { tagName, attribs: { src: attribs.src, alt: attribs.alt || '', ...(safeWidth ? { style: `width: ${safeWidth}px` } : {}) } };
      },
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !/^\/bbsinfo\/editor-images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(frame.attribs.src || ''),
  }).trim();
  const plain = plainFromHtml(html);
  if (!plain || plain.length > maxText) throw new Error('Text fehlt oder ist zu lang.');
  return { plain, html };
}
