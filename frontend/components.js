'use strict';

/**
 * Returns an <img> element using the WhatsApp logo.
 * Single source of truth for logo sizing and styling across the app.
 *
 * @param {number} size - width & height in px
 * @param {string} [alt]
 * @returns {HTMLImageElement}
 */
export function whatsAppLogo(size, alt = 'WhatsApp') {
  const img = document.createElement('img');
  img.src    = '/static/whatsapp-logo.webp';
  img.alt    = alt;
  img.width  = size;
  img.height = size;
  img.className = 'wa-logo';
  return img;
}
