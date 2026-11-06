/** 在作者代码加载前施加 CSP；生产和预览使用不同 bootstrap，不放宽生产协议。 */
export function createPluginUiFrameDocument(document: string, bootstrapPath: string, parameters: URLSearchParams) {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const bootstrap = new URL(bootstrapPath, window.location.href).href.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const marker = `src="${bootstrapPath}"`;
  const html = document.replace(marker, `nonce="${nonce}" src="${bootstrap}"`)
    .replace("script-src 'self' ", `script-src 'nonce-${nonce}' `);
  if (!html.includes(`nonce="${nonce}"`) || !html.includes(`script-src 'nonce-${nonce}' `) || !parameters.size) {
    throw new Error('插件隔离宿主页无效');
  }
  const objectUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  return { objectUrl, src: `${objectUrl}#${parameters}` };
}
