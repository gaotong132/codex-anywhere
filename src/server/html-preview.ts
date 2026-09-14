import type { ServerResponse } from 'node:http';

// Only the empty renderer crosses HTTP. The parent sends the file directly to
// this opaque-origin frame; the relay never receives the decrypted HTML.
export function serveHtmlPreview(response: ServerResponse, headOnly: boolean, extensionOrigins: readonly string[]) {
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><script>
addEventListener('message', function receive(event) {
  if (event.source !== parent || event.data?.type !== 'anywhere.html-preview'
      || typeof event.data.html !== 'string' || event.data.html.length > 4194304 || !event.ports[0]) return;
  removeEventListener('message', receive);
  const port = event.ports[0];
  document.open();
  document.write(event.data.html);
  document.close();
  document.addEventListener('click', function(event) {
    if (!event.isTrusted) return;
    const link = event.target.closest?.('a[data-anywhere-link]');
    if (!link) return;
    event.preventDefault();
    port.postMessage({ type: 'link', id: Number(link.dataset.anywhereLink) });
  });
  port.onmessage = function(event) {
    if (event.data?.type !== 'image' || !Number.isInteger(event.data.id)
        || typeof event.data.url !== 'string' || !/^data:image\\/(png|jpeg|webp);base64,/.test(event.data.url)) return;
    document.querySelectorAll('img[data-anywhere-image="' + event.data.id + '"]').forEach(img => { img.src = event.data.url; });
  };
  const images = document.querySelectorAll('img[data-anywhere-image]');
  if (typeof IntersectionObserver === 'undefined') {
    images.forEach(img => port.postMessage({ type: 'image', id: Number(img.dataset.anywhereImage) }));
  } else {
    const observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        port.postMessage({ type: 'image', id: Number(entry.target.dataset.anywhereImage) });
      });
    }, { rootMargin: '400px' });
    images.forEach(img => observer.observe(img));
  }
});
</script></body></html>`;
  response.removeHeader('x-frame-options');
  response.setHeader('content-security-policy', [
    "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
    'img-src data: blob:', 'font-src data:', "connect-src 'none'",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", 'sandbox allow-scripts',
    `frame-ancestors 'self'${extensionOrigins.length ? ` ${extensionOrigins.join(' ')}` : ''}`,
  ].join('; '));
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(headOnly ? '' : body);
}
