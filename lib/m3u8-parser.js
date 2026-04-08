/* ─── Lightweight M3U8 Parser ─── */
/* Parses HLS manifests — master playlists and media playlists.
   No external dependencies. */

class M3U8Parser {
  static parse(text, baseUrl) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);

    if (!lines[0]?.startsWith('#EXTM3U')) {
      throw new Error('Invalid M3U8: missing #EXTM3U header');
    }

    const result = {
      isMaster: false,
      variants: [],
      segments: [],
      totalDuration: 0,
      targetDuration: 0,
      encrypted: false
    };

    // Detect master playlist
    if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
      result.isMaster = true;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
          const attrs = M3U8Parser.parseAttributes(lines[i]);
          const url = M3U8Parser.resolveUrl(lines[i + 1], baseUrl);
          result.variants.push({
            bandwidth: parseInt(attrs.BANDWIDTH) || 0,
            resolution: attrs.RESOLUTION || '',
            codecs: attrs.CODECS || '',
            url
          });
        }
      }
      result.variants.sort((a, b) => b.bandwidth - a.bandwidth);
    } else {
      // Media playlist
      let segDuration = 0;
      for (const line of lines) {
        if (line.startsWith('#EXT-X-TARGETDURATION:')) {
          result.targetDuration = parseFloat(line.split(':')[1]) || 0;
        } else if (line.startsWith('#EXTINF:')) {
          segDuration = parseFloat(line.split(':')[1]) || 0;
        } else if (line.startsWith('#EXT-X-KEY:')) {
          result.encrypted = true;
        } else if (!line.startsWith('#')) {
          const url = M3U8Parser.resolveUrl(line, baseUrl);
          result.segments.push({ url, duration: segDuration });
          result.totalDuration += segDuration;
          segDuration = 0;
        }
      }
    }

    return result;
  }

  static parseAttributes(line) {
    const attrs = {};
    const match = line.match(/#EXT-X-STREAM-INF:(.*)/);
    if (!match) return attrs;
    const regex = /([A-Z-]+)=(?:"([^"]*)"|([^,]*))/g;
    let m;
    while ((m = regex.exec(match[1]))) {
      attrs[m[1]] = m[2] || m[3];
    }
    return attrs;
  }

  static resolveUrl(url, baseUrl) {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    try { return new URL(url, baseUrl).href; } catch { return url; }
  }
}

// Make available globally if not using modules
if (typeof globalThis !== 'undefined') {
  globalThis.M3U8Parser = M3U8Parser;
}
