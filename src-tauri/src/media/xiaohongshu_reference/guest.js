(() => {
  const reject = () => Promise.reject(new DOMException('Unavailable in this viewer', 'NotAllowedError'));
  const replace = (target, property, value) => {
    if (target) {
      try { Object.defineProperty(target, property, { value, configurable: false, writable: false }); }
      catch { /* Some browser implementations omit or lock these APIs. */ }
    }
  };
  const restrict = (target, property, value) => {
    if (!target) return;
    const prototype = Object.getPrototypeOf(target);
    if (prototype && Object.hasOwn(prototype, property)) replace(prototype, property, value);
    replace(target, property, value);
  };
  restrict(navigator.mediaDevices, 'getUserMedia', reject);
  restrict(navigator.mediaDevices, 'getDisplayMedia', reject);
  for (const property of ['read', 'readText', 'write', 'writeText']) restrict(navigator.clipboard, property, reject);
  replace(globalThis.Notification, 'requestPermission', () => Promise.resolve('denied'));
  const denyLocation = (_, denied) => { if (typeof denied === 'function') denied({ code: 1, message: 'Permission denied' }); };
  restrict(navigator.geolocation, 'getCurrentPosition', denyLocation);
  restrict(navigator.geolocation, 'watchPosition', (...args) => { denyLocation(...args); return 0; });
  for (const property of ['getUserMedia', 'webkitGetUserMedia']) {
    restrict(navigator, property, (_, _allowed, denied) => {
      if (typeof denied === 'function') denied(new DOMException('Unavailable in this viewer', 'NotAllowedError'));
    });
  }
  addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    const link = event.target instanceof Element ? event.target.closest('a[target="_blank"]') : null;
    if (!link) return;
    const url = new URL(link.href);
    if (url.protocol === 'https:' && ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname)) {
      link.target = '_self';
    }
  }, true);
})()
