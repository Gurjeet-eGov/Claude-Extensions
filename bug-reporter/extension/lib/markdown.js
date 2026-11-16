// Small, safe markdown renderer for the issue preview. Everything is escaped;
// only headings, fenced code, paragraphs, bullet lists, images/video, links,
// inline code and bold are rendered. `resolveMedia(src)` maps "./snapshot-1.png"
// to a local blob URL for the preview.

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function inline(text, resolveMedia) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => media(alt, src, resolveMedia));
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

function media(alt, src, resolveMedia) {
  const raw = src.replace(/&amp;/g, '&');
  const url = resolveMedia ? resolveMedia(raw) : null;
  if (!url) return `<span class="md-missing">[${alt || raw}]</span>`;
  if (/\.(mp4|mov|webm)$/i.test(raw)) return `<video class="md-video" src="${escapeHtml(url)}" controls></video>`;
  return `<img class="md-img" src="${escapeHtml(url)}" alt="${alt}">`;
}

export function renderMarkdown(md, { resolveMedia } = {}) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let i = 0;
  let para = [];
  let list = [];
  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(para.join(' '), resolveMedia)}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list.length) html.push(`<ul>${list.map((li) => `<li>${inline(li, resolveMedia)}</li>`).join('')}</ul>`);
    list = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(/^(`{3,})(\w*)\s*$/);
    if (fenceMatch) {
      flushPara();
      flushList();
      const close = fenceMatch[1];
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(close)) code.push(lines[i++]);
      i++;
      html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const level = Math.min(6, h[1].length);
      html.push(`<h${level}>${inline(h[2], resolveMedia)}</h${level}>`);
    } else if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      list.push(line.replace(/^\s*[-*]\s+/, ''));
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
    i++;
  }
  flushPara();
  flushList();
  return html.join('\n');
}
