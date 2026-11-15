/** PDF.js 资源仅来自随应用打包的白名单，不接受文档提供的 URL。 */
import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import openJpegFallbackUrl from 'pdfjs-dist/wasm/openjpeg_nowasm_fallback.js?url';
import jbig2FallbackUrl from 'pdfjs-dist/wasm/jbig2_nowasm_fallback.js?url';

// 显式纳入依赖目录；小 CMap 也作为同源文件输出，不能被内联为 data URL。
const cMaps = import.meta.glob<string>('../../node_modules/pdfjs-dist/cmaps/*.bcmap', { query: '?url&no-inline', import: 'default', exhaustive: true });
const standardFonts = import.meta.glob<string>('../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', { query: '?url&no-inline', import: 'default', exhaustive: true });

class LocalPdfDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array<ArrayBuffer>> {
    const assets = kind === 'cMapUrl' ? cMaps : kind === 'standardFontDataUrl' ? standardFonts : undefined;
    const directory = kind === 'cMapUrl' ? 'cmaps' : 'standard_fonts';
    if (!assets || !/^[A-Za-z0-9_.-]+$/.test(filename)) throw new Error('PDF 本地资源不可用');
    const load = assets[`../../node_modules/pdfjs-dist/${directory}/${filename}`];
    if (!load) throw new Error('PDF 本地资源不可用');
    const url = new URL(await load(), window.location.href);
    const application = new URL(window.location.href);
    if (url.protocol !== application.protocol || url.host !== application.host) throw new Error('PDF 本地资源不可用');
    const response = await fetch(url, { credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw new Error('PDF 本地资源不可用');
    return new Uint8Array(await response.arrayBuffer());
  }
}

export async function loadLocalPdf(bytes: Uint8Array<ArrayBuffer>): Promise<PDFDocumentLoadingTask> {
  const pdf = await import('pdfjs-dist');
  pdf.GlobalWorkerOptions.workerSrc = workerUrl;
  // PDF.js 按固定文件名加载无 Wasm 解码器；Vite 仅对这两个资源保留名称。
  const fallbackDirectory = new URL('.', new URL(openJpegFallbackUrl, window.location.href));
  if (new URL(jbig2FallbackUrl, window.location.href).href !== new URL('jbig2_nowasm_fallback.js', fallbackDirectory).href
    || new URL(openJpegFallbackUrl, window.location.href).href !== new URL('openjpeg_nowasm_fallback.js', fallbackDirectory).href) {
    throw new Error('PDF 本地资源不可用');
  }
  return pdf.getDocument({
    data: bytes,
    BinaryDataFactory: LocalPdfDataFactory,
    useWorkerFetch: false,
    wasmUrl: fallbackDirectory.href,
    cMapPacked: true,
    useWasm: false,
    disableFontFace: true,
    useSystemFonts: true,
    enableXfa: false,
    disableWorkerRendering: true,
    disableAutoFetch: true,
    disableStream: true,
    maxImageSize: 16_000_000,
    canvasMaxAreaInBytes: 64_000_000,
    verbosity: 0,
  });
}
