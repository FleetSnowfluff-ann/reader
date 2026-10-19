import { planLayout, bounds } from './layout.js';
const make = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const position = (node, box) => Object.assign(node.style, { left: `${box.x*100}%`, top: `${box.y*100}%`, width: `${box.width*100}%` });

// Do not erase graphic ink in a candidate paragraph. Any meaningful residual
// ink after accounting for its source glyphs sends the translation to continuation.
export function hasProtectedInk(canvas, box, rects) {
  const w = canvas.width, h = canvas.height;
  const x = Math.max(0, Math.floor(box.x*w)), y = Math.max(0, Math.floor(box.y*h));
  const width = Math.min(w-x, Math.ceil(box.width*w)), height = Math.min(h-y, Math.ceil(box.height*h));
  if (width < 1 || height < 1) return true;
  const pixels = canvas.getContext('2d').getImageData(x,y,width,height).data;
  let ink = 0;
  const padding = 1.5 / w;
  for (let py = 0; py < height; py += 2) for (let px = 0; px < width; px += 2) {
    const nx = (x+px)/w, ny=(y+py)/h;
    if (rects.some(r => nx>=r.x-padding && nx<=r.x+r.width+padding && ny>=r.y-padding && ny<=r.y+r.height+padding)) continue;
    const i=(py*width+px)*4;
    if (pixels[i+3] && Math.min(pixels[i],pixels[i+1],pixels[i+2])<220 && ++ink>12) return true;
  }
  return false;
}
export function renderMirror({ sources, translations, canvas, textLayer, page, targetCanvas, targetLayer, continuation, zoom }) {
  const width = parseFloat(canvas.style.width), height = parseFloat(canvas.style.height);
  page.style.width = `${width}px`; page.style.height = `${height}px`;
  page.style.setProperty('--scale-factor', textLayer.parentElement.style.getPropertyValue('--scale-factor'));
  page.style.setProperty('--total-scale-factor', textLayer.parentElement.style.getPropertyValue('--total-scale-factor'));
  targetCanvas.width=canvas.width; targetCanvas.height=canvas.height;
  targetCanvas.style.width=`${width}px`; targetCanvas.style.height=`${height}px`;
  const ctx=targetCanvas.getContext('2d'); ctx.drawImage(canvas,0,0);
  targetLayer.replaceChildren(); continuation.replaceChildren();
  const clone=textLayer.cloneNode(true); clone.id='mirror-source-layer'; clone.classList.add('mirror-source-layer'); targetLayer.append(clone);
  const deferred=new Set(), replaced=new Set(), layoutReport=[]; let fitted=0, adapted=0;
  for (const group of planLayout(sources,translations)) {
    if (!group.targets.length) continue;
    let reason=group.reason;
    const rects=group.sources.flatMap(s=>s.rects||[]);
    let room = group.box;
    if (!reason) {
      const other = sources.filter(s=>!group.sources.includes(s)).flatMap(s=>s.rects||[]);
      const next = Math.min(1, ...other.filter(r=>r.x<group.box.x+group.box.width && r.x+r.width>group.box.x && r.y>=group.box.y+group.box.height).map(r=>r.y));
      const extra = Math.max(0, Math.min(.012, next-group.box.y-group.box.height-2/height));
      room = {...group.box, height:group.box.height+extra};
      if (hasProtectedInk(canvas,room,rects)) reason='Graphic ink retained in this region';
    }
    const block=make('div','mirror-block');
    if (!reason) {
      position(block,group.box);
      const heights=rects.map(r=>r.height*height).sort((a,b)=>a-b);
      const font=Math.max(12*zoom, (heights[Math.floor(heights.length/2)]||12)*.95);
      block.style.fontSize=`${font}px`; block.style.lineHeight='1.45';
      for (const run of group.runs) {
        const span=make('span',run.target?'mirror-target':'mirror-english',run.text);
        span.tabIndex=0; span.setAttribute('role','button');
        if (run.target) { span.dataset.targetId=run.target.id; span.lang='zh-CN'; span.title=`${run.target.sourceIds.join(', ')} · ${run.target.confirmed?'Verified by reader':'Unreviewed translation'}`; }
        else span.dataset.sourceId=run.source.id;
        block.append(span,document.createTextNode(' '));
      }
      targetLayer.append(block);
      if (block.scrollHeight>room.height*height+1 || block.scrollWidth>group.box.width*width+1) reason='Translation needs more space at readable type size';
    }
    layoutReport.push({ sourceIds:group.sources.map(s=>s.id), reason, font:block.style.fontSize, requiredHeight:block.scrollHeight, availableHeight:room?.height*height, width:group.box?.width*width });
    if (reason) {
      block.remove();
      for (const t of group.targets) {
        if (deferred.has(t.id)) continue;
        deferred.add(t.id);
        const entry=make('article','continuation-entry'); entry.dataset.targetId=t.id;
        entry.append(make('div','continuation-label',`${t.sourceIds.join(' + ')} · ${reason}`));
        const text=make('p','mirror-target',t.text); text.dataset.targetId=t.id; text.lang='zh-CN'; text.tabIndex=0; text.setAttribute('role','button'); entry.append(text); continuation.append(entry);
      }
    } else {
      fitted++;
      if (block.scrollHeight>group.box.height*height+2) { adapted++; block.dataset.spacing='adapted'; block.title='Spacing extended into verified blank space'; }
      for (const source of group.sources) {
        for (const segment of source.segments||[]) replaced.add(segment.itemIndex);
        for (const r of source.rects||[]) { ctx.fillStyle='white'; ctx.fillRect(r.x*canvas.width-.6,r.y*canvas.height-.6,r.width*canvas.width+1.2,r.height*canvas.height+1.2); }
      }
    }
  }
  for (const span of clone.querySelectorAll('[data-item-index]')) if (replaced.has(Number(span.dataset.itemIndex))) span.style.visibility='hidden';
  for (const t of translations.filter(t=>!t.sourceIds.length)) {
    const item=make('article','continuation-entry'); item.append(make('div','continuation-label','Unaligned · no source match claimed'));
    const text=make('p','mirror-target',t.text); text.dataset.targetId=t.id; text.tabIndex=0; item.append(text); continuation.append(item); deferred.add(t.id);
  }
  continuation.hidden=!continuation.children.length;
  if (continuation.children.length) continuation.prepend(make('h3','', 'Continuation · 译文续读'));
  page.layoutReport=layoutReport;
  return { fitted, adapted, deferred:deferred.size, total:translations.length };
}
export function mirrorMarks(container, sources, { locked=[], hovered=[], notes=[] }) {
  container.replaceChildren();
  const append=(rect,cls,id)=>{ const mark=make('div',cls); position(mark,rect); mark.style.height=`${rect.height*100}%`; if(id) mark.dataset.sourceId=id; container.append(mark); };
  for (const n of notes) for(const r of (n.sourceId?sources.find(s=>s.id===n.sourceId)?.rects:n.rects)||[]) append(r,'pdf-mark');
  for(const s of sources) for(const r of s.rects||[]) { if(locked.includes(s.id))append(r,'pdf-linked-mark',s.id); if(hovered.includes(s.id))append(r,'pdf-hover-mark'); }
}
