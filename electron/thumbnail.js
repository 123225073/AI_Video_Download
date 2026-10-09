// Bilibili's public metadata commonly uses HTTP or protocol-relative CDN URLs.
// Upgrade those addresses while keeping the renderer's HTTPS-only image policy.
export function thumbnailUrl(value) {
  try {
    const url = new URL(String(value || '').startsWith('//') ? `https:${value}` : value);
    if (url.username || url.password || url.port) return '';
    if (url.protocol === 'http:' && /(^|\.)(hdslb\.com|biliimg\.com|xhscdn\.com)$/.test(url.hostname)) url.protocol = 'https:';
    return url.protocol === 'https:' ? url.href : '';
  } catch { return ''; }
}
