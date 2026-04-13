// offscreen.js — Page Watchdog canvas image processing
// Connects to the background service worker via port-based messaging

const c1 = document.getElementById('c1');
const ctx1 = c1.getContext('2d', { willReadFrequently: true });

// Store previous crops per watcher as raw pixel data.
// Avoids JPEG round-trips and double-compression artifacts.
const previousCrops = new Map(); // watcherId → ImageData

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
}

// Connect TO the service worker (standard MV3 pattern)
const port = chrome.runtime.connect({ name: 'watchdog-offscreen' });

port.onMessage.addListener(async (msg) => {
  const reqId = msg._reqId;

  if (msg.type === 'CROP_AND_COMPARE') {
    try {
      const { watcherId, dataUrl, rect } = msg;
      const dpr = rect.devicePixelRatio || 1;
      const img = await loadImage(dataUrl);

      const sx = Math.round(rect.x * dpr);
      const sy = Math.round(rect.y * dpr);
      const sw = Math.round(rect.width * dpr);
      const sh = Math.round(rect.height * dpr);

      // Clamp to image bounds
      const csx = Math.max(0, sx);
      const csy = Math.max(0, sy);
      const csw = Math.min(sw, img.width - csx);
      const csh = Math.min(sh, img.height - csy);

      if (csw <= 0 || csh <= 0) {
        port.postMessage({ _reqId: reqId, error: 'Crop region out of bounds' });
        return;
      }

      c1.width = csw;
      c1.height = csh;
      ctx1.drawImage(img, csx, csy, csw, csh, 0, 0, csw, csh);
      const newData = ctx1.getImageData(0, 0, csw, csh);

      const prev = previousCrops.get(watcherId);
      previousCrops.set(watcherId, newData);

      if (!prev) {
        console.log(`[Watchdog offscreen] Baseline captured for ${watcherId} (${csw}x${csh})`);
        port.postMessage({ _reqId: reqId, baseline: true });
        return;
      }

      // Different dimensions = definite change
      if (prev.width !== newData.width || prev.height !== newData.height) {
        console.log(`[Watchdog offscreen] Size changed for ${watcherId}: ${prev.width}x${prev.height} -> ${newData.width}x${newData.height}`);
        port.postMessage({ _reqId: reqId, changed: true, changePercent: 100 });
        return;
      }

      // Pixel comparison on raw decoded pixels (no double-JPEG artifacts)
      const d1 = prev.data;
      const d2 = newData.data;
      const totalPixels = newData.width * newData.height;
      let diffPixels = 0;

      for (let i = 0; i < d1.length; i += 4) {
        const diff = Math.abs(d1[i] - d2[i])
                   + Math.abs(d1[i + 1] - d2[i + 1])
                   + Math.abs(d1[i + 2] - d2[i + 2]);
        if (diff > 30) diffPixels++;
      }

      const changePercent = totalPixels > 0 ? (diffPixels / totalPixels) * 100 : 0;
      const changed = changePercent >= 0.1;
      console.log(`[Watchdog offscreen] Compare ${watcherId}: ${diffPixels}/${totalPixels} px (${changePercent.toFixed(2)}%) -> ${changed ? 'CHANGED' : 'same'}`);
      port.postMessage({ _reqId: reqId, changed, changePercent: Math.round(changePercent * 10) / 10 });
    } catch (e) {
      console.error('[Watchdog offscreen] CROP_AND_COMPARE error:', e);
      port.postMessage({ _reqId: reqId, error: e.message });
    }
  }

  if (msg.type === 'CLEAR_BASELINE') {
    previousCrops.delete(msg.watcherId);
    console.log(`[Watchdog offscreen] Baseline cleared for ${msg.watcherId}`);
    port.postMessage({ _reqId: reqId, ok: true });
  }
});
