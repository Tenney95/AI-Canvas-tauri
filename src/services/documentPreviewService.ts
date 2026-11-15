/** 本地只读预览：Office 内容不进入主文档 DOM，也不加载文档中的外部资源。 */
import type { HElement } from 'docx-preview';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import type { Presentation } from '@web-ppt/core';

export type DocumentPreviewKind = 'pdf' | 'presentation' | 'word' | 'legacy-word';
export type DocumentPreviewResource =
  | { kind: 'pdf'; pageCount: number; document: PDFDocumentProxy; dispose: () => void }
  | { kind: 'presentation'; pageCount: number; renderPage: (page: number, signal: AbortSignal) => Promise<string>; dispose: () => void }
  | { kind: 'word'; pageCount: number; pages: string[]; dispose: () => void };

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_PAGES = 500;
const MAX_OFFICE_NODES = 100_000;
const ZIP_LIMITS = { maxEntries: 2000, maxEntryBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxCompressionRatio: 100 };
const BLOCKED_ELEMENTS = 'script,iframe,object,embed,base,link,meta,form,input,button,textarea,select,audio,video,foreignObject,animate,animateMotion,animateTransform,set';
const FRAME_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

class PreviewError extends Error {}

export function documentPreviewError(reason: unknown): string {
  return reason instanceof PreviewError ? reason.message : '无法预览此文件，请确认格式有效且未加密；复杂版式可先转换为 PDF';
}

function bytesFromBase64(base64: string): Uint8Array<ArrayBuffer> {
  if (base64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw new PreviewError('文件超过 32 MB，无法在工作台内预览');
  const value = atob(base64);
  if (value.length > MAX_FILE_BYTES) throw new PreviewError('文件超过 32 MB，无法在工作台内预览');
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index);
  return bytes;
}

function checkPages(count: number, max: 200 | 500 = MAX_PAGES) {
  if (!Number.isSafeInteger(count) || count < 1) throw new PreviewError('文件中没有可预览的页面');
  if (count > max) throw new PreviewError(max === 200 ? '文件超过 200 页，请拆分后再预览' : '文件超过 500 页，请拆分后再预览');
}

function safeDataImage(value: string): boolean {
  return /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i.test(value);
}

function sanitizeTree(root: ParentNode) {
  root.querySelectorAll(BLOCKED_ELEMENTS).forEach((element) => element.remove());
  const elements = root.querySelectorAll('*');
  if (elements.length > MAX_OFFICE_NODES) throw new PreviewError('文档内容过多，请拆分后再预览');
  elements.forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || ['srcdoc', 'action', 'formaction', 'target', 'srcset', 'poster'].includes(name)
        || name === 'href' || name.endsWith(':href')) {
        // SVG 渐变等本页引用可保留；导航和外部资源全部移除。
        if (!((name === 'href' || name.endsWith(':href')) && attribute.value.startsWith('#'))) element.removeAttribute(attribute.name);
      } else if (name === 'src' && !safeDataImage(attribute.value)) element.removeAttribute(attribute.name);
    }
  });
}

function inertElement(owner: Document, value: HElement | Node | string): Node {
  if (typeof value === 'string') return owner.createTextNode(value);
  if (value instanceof Node) return value.ownerDocument === owner ? value : owner.importNode(value, true);
  const { ns, tagName, className, style, children, ...properties } = value;
  if (tagName === '#comment') return owner.createComment('');
  const result = tagName === '#fragment' ? owner.createDocumentFragment()
    : ns ? owner.createElementNS(ns, tagName) : owner.createElement(tagName);
  if (result instanceof Element) {
    if (className) result.setAttribute('class', className);
    if (style && 'style' in result) {
      if (typeof style === 'string') result.setAttribute('style', style);
      else Object.assign((result as HTMLElement).style, style);
    }
    for (const [key, property] of Object.entries(properties)) {
      if (property === undefined || /^on/i.test(key) || ['innerHTML', 'outerHTML', 'srcdoc', 'href', 'target'].includes(key)) continue;
      if (key === 'src' && (typeof property !== 'string' || !safeDataImage(property))) continue;
      Reflect.set(result, key, property);
    }
  }
  children?.forEach((child) => result.appendChild(inertElement(owner, child)));
  return result;
}

function wordFrame(styles: string, page: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><style>body{margin:0}img{max-width:100%}${styles.replace(/</g, '\\3c ')}</style></head><body><div class="docx-wrapper">${page}</div></body></html>`;
}

async function loadWord(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<DocumentPreviewResource> {
  const [{ safeUnzipSync }, docx] = await Promise.all([import('@web-ppt/core/zip'), import('docx-preview')]);
  signal.throwIfAborted();
  // JSZip 本身没有实际展开上限，先由同一 Office ZIP 白名单做有界展开检查。
  {
    const parts = safeUnzipSync(bytes, { limits: ZIP_LIMITS });
    const source = parts['word/document.xml'];
    if (!source || source.byteLength > 8 * 1024 * 1024) throw new PreviewError('Word 文档内容过多或格式无效，请转换为 PDF 后预览');
    let tags = 0;
    const decoder = new TextDecoder();
    for (const [name, part] of Object.entries(parts)) {
      if (!name.startsWith('word/') || !name.endsWith('.xml')) continue;
      tags += decoder.decode(part).split('<').length - 1;
      if (tags > MAX_OFFICE_NODES) throw new PreviewError('文档内容过多，请拆分后再预览');
    }
  }
  const owner = document.implementation.createHTMLDocument('');
  const body = owner.createElement('div');
  const style = owner.createElement('div');
  await docx.renderAsync(bytes, body, style, {
    h: (value) => inertElement(owner, value),
    renderAltChunks: false,
    renderComments: false,
    renderChanges: false,
    ignoreFonts: true,
    useBase64URL: true,
    debug: false,
    experimental: false,
    breakPages: true,
    inWrapper: true,
  });
  signal.throwIfAborted();
  sanitizeTree(body);
  const styles = Array.from(style.querySelectorAll('style'), (element) => element.textContent ?? '').join('\n');
  const sections = Array.from(body.querySelectorAll('section.docx'));
  checkPages(sections.length, 200);
  const pages = sections.map((section) => wordFrame(styles, section.outerHTML));
  return { kind: 'word', pageCount: pages.length, pages, dispose: () => { pages.length = 0; } };
}

async function dataImageFromBlob(url: string, signal: AbortSignal): Promise<string> {
  if (!url.startsWith(`blob:${window.location.origin}/`)) return '';
  const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error' });
  const blob = await response.blob();
  if (blob.size > ZIP_LIMITS.maxEntryBytes || !/^image\//i.test(blob.type)) return '';
  const bytes = new Uint8Array(await blob.arrayBuffer());
  signal.throwIfAborted();
  let encoded = '';
  for (let start = 0; start < bytes.length; start += 8192) encoded += String.fromCharCode(...bytes.subarray(start, start + 8192));
  const data = `data:${blob.type};base64,${btoa(encoded)}`;
  return safeDataImage(data) ? data : '';
}

async function presentationImage(presentation: Presentation, page: number, signal: AbortSignal): Promise<string> {
  const { renderSlideToSvg } = await import('@web-ppt/core');
  signal.throwIfAborted();
  const markup = renderSlideToSvg(presentation, presentation.slides[page - 1], { textMode: 'svg', media: 'badge', includeNotes: false, showComments: false });
  if (markup.length > 24 * 1024 * 1024) throw new PreviewError('此页内容过多，无法预览，请转换为 PDF');
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) throw new PreviewError('此页无法预览，请转换为 PDF');
  // 仅将解析器生成的同源 blob 图片内嵌，绝不 fetch 文稿中的 HTTP、文件或任意协议地址。
  const images = Array.from(parsed.querySelectorAll('image'));
  for (const image of images) {
    const source = image.getAttribute('href') ?? image.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '';
    const data = safeDataImage(source) ? source : await dataImageFromBlob(source, signal);
    image.removeAttribute('href'); image.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (data) image.setAttribute('data-preview-image', data);
  }
  sanitizeTree(parsed);
  parsed.querySelectorAll('[data-preview-image]').forEach((image) => {
    image.setAttribute('href', image.getAttribute('data-preview-image')!);
    image.removeAttribute('data-preview-image');
  });
  signal.throwIfAborted();
  return URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(parsed.documentElement)], { type: 'image/svg+xml' }));
}

async function loadPresentation(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<DocumentPreviewResource> {
  const { parse } = await import('@web-ppt/core');
  signal.throwIfAborted();
  const presentation = await parse(bytes, { lazy: true, embeddedFonts: 'source', zip: ZIP_LIMITS });
  try {
    signal.throwIfAborted();
    checkPages(presentation.slides.length);
    if (!Number.isFinite(presentation.width) || !Number.isFinite(presentation.height)
      || presentation.width <= 0 || presentation.height <= 0 || presentation.width > 16_384 || presentation.height > 16_384) {
      throw new PreviewError('演示文稿页面尺寸过大，无法预览');
    }
    presentation.embeddedFonts = [];
    return { kind: 'presentation', pageCount: presentation.slides.length,
      renderPage: (page, currentSignal) => presentationImage(presentation, page, currentSignal), dispose: () => presentation.dispose?.() };
  } catch (reason) { presentation.dispose?.(); throw reason; }
}

export async function loadDocumentPreview(kind: Exclude<DocumentPreviewKind, 'legacy-word'>, base64: string,
  signal: AbortSignal, onPdfLoading: (task: PDFDocumentLoadingTask) => void): Promise<DocumentPreviewResource> {
  signal.throwIfAborted();
  const bytes = bytesFromBase64(base64);
  if (kind === 'word') return loadWord(bytes, signal);
  if (kind === 'presentation') return loadPresentation(bytes, signal);
  const { loadLocalPdf } = await import('./documentPreviewPdf');
  signal.throwIfAborted();
  const task = await loadLocalPdf(bytes);
  onPdfLoading(task);
  try {
    if (signal.aborted) { await task.destroy(); signal.throwIfAborted(); }
    const document = await task.promise;
    signal.throwIfAborted();
    checkPages(document.numPages);
    return { kind: 'pdf', pageCount: document.numPages, document, dispose: () => { void task.destroy().catch(() => {}); } };
  } catch (reason) { void task.destroy().catch(() => {}); throw reason; }
}
