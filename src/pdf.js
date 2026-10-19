import * as pdfjs from '../vendor/build/pdf.mjs';
import { extractPage } from './extraction.js';
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/build/pdf.worker.mjs', import.meta.url).href;

export class PDFReader {
  document = null;
  renderTask = null;
  textLayer = null;
  generation = 0;
  async open(bytes, passwordPrompt) {
    const task = pdfjs.getDocument({ data: bytes, cMapUrl: new URL('../vendor/cmaps/', import.meta.url).href, cMapPacked: true, standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).href, wasmUrl: new URL('../vendor/wasm/', import.meta.url).href, isEvalSupported: false, enableXfa: false });
    task.onPassword = (update, reason) => { const password = passwordPrompt(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD); if (password === null) task.destroy(); else update(password); };
    try { this.document = await task.promise; return this.document; } catch (error) { await task.destroy(); throw new Error(`Could not open PDF: ${error.message}`); }
  }
  async extract(number) {
    const page = await this.document.getPage(number);
    const content = await page.getTextContent();
    return { page, content, ...extractPage(content.items, page.getViewport({ scale: 1 }), number) };
  }
  async render(extracted, { canvas, container, textContainer, availableWidth, zoom }) {
    const generation = ++this.generation;
    this.textLayer?.cancel();
    if (this.renderTask) { this.renderTask.cancel(); try { await this.renderTask.promise; } catch {} }
    if (generation !== this.generation) return false;
    const scale = Math.min(1.5, availableWidth / extracted.page.getViewport({ scale: 1 }).width) * zoom;
    const viewport = extracted.page.getViewport({ scale });
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
    container.style.width = `${viewport.width}px`; container.style.height = `${viewport.height}px`;
    container.style.setProperty('--scale-factor', scale); container.style.setProperty('--total-scale-factor', scale);
    textContainer.replaceChildren();
    this.renderTask = extracted.page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
    try { await this.renderTask.promise; } catch (error) { if (error.name === 'RenderingCancelledException') return false; throw error; }
    if (generation !== this.generation) return false;
    this.textLayer = new pdfjs.TextLayer({ textContentSource: extracted.content, container: textContainer, viewport });
    try { await this.textLayer.render(); } catch (error) { if (error.name === 'AbortException') return false; throw error; }
    this.textLayer.textDivs.forEach((span, index) => { span.dataset.itemIndex = index; });
    return generation === this.generation;
  }
  exactRectangles(source, container) {
    const pageRect = container.getBoundingClientRect();
    const rects = [];
    for (const segment of source.segments || []) {
      const span = this.textLayer?.textDivs[segment.itemIndex];
      const text = span?.firstChild;
      if (!text || text.nodeType !== Node.TEXT_NODE || segment.end > text.length) continue;
      const range = document.createRange(); range.setStart(text, segment.start); range.setEnd(text, segment.end);
      for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) rects.push({ x: (rect.left - pageRect.left) / pageRect.width, y: (rect.top - pageRect.top) / pageRect.height, width: rect.width / pageRect.width, height: rect.height / pageRect.height });
    }
    return rects.length ? rects : source.rects;
  }
  async destroy() { this.generation++; this.textLayer?.cancel(); await this.document?.destroy(); }
}
