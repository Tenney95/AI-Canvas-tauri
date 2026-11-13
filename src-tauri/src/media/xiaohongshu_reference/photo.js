(() => {
  if (location.protocol !== 'https:' || !['www.xiaohongshu.com', 'xiaohongshu.com'].includes(location.hostname)) return null;
  if (!/^\/(?:explore|discovery\/item|search_result)\/[0-9a-f]{24}\/?$/i.test(location.pathname)) return null;

  const candidates = new Map();
  for (const image of document.images) {
    const source = image.currentSrc || image.src;
    if (!/^https:\/\/(?:sns-[a-z0-9-]+|ci)\.xhscdn\.com\//i.test(source)
      || source.length > 4096 || !image.complete || image.naturalWidth < 180 || image.naturalHeight < 160) continue;
    const bounds = image.getBoundingClientRect();
    let left = Math.max(0, bounds.left);
    let top = Math.max(0, bounds.top);
    let right = Math.min(innerWidth, bounds.right);
    let bottom = Math.min(innerHeight, bounds.bottom);
    let hidden = false;
    for (let element = image; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none'
        || Number(style.opacity) === 0 || element.getAttribute('aria-hidden') === 'true') {
        hidden = true;
        break;
      }
      if (element === image) continue;
      const clip = element.getBoundingClientRect();
      if (style.overflowX !== 'visible') {
        left = Math.max(left, clip.left);
        right = Math.min(right, clip.right);
      }
      if (style.overflowY !== 'visible') {
        top = Math.max(top, clip.top);
        bottom = Math.min(bottom, clip.bottom);
      }
    }
    const width = right - left;
    const height = bottom - top;
    if (hidden || width < 140 || height < 125) continue;
    const center = document.elementFromPoint(left + width / 2, top + height / 2);
    const slide = image.parentElement?.parentElement;
    if (center !== image && (!center || !slide || slide === document.body || !slide.contains(center))) continue;
    const area = width * height;
    candidates.set(source, Math.max(candidates.get(source) || 0, area));
  }
  const [first, second] = [...candidates].sort((a, b) => b[1] - a[1]);
  if (!first || (second && second[1] >= first[1] * 0.65)) return null;
  return { pageUrl: location.href, imageUrl: first[0] };
})()
