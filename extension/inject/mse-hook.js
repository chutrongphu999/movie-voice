// Movie Voice - Media Source Extensions (MSE) & Subtitle Network Hook
// Runs in MAIN world at document_start (inspired by cat-catch & voice-over-translation)
(function () {
  "use strict";

  if (window.__movieVoiceMseHooked) return;
  window.__movieVoiceMseHooked = true;

  const origToString = Function.prototype.toString;
  const nativeStrMap = new WeakMap();

  function registerNativeStr(proxyFn, nativeFn) {
    nativeStrMap.set(proxyFn, origToString.call(nativeFn));
    return proxyFn;
  }

  try {
    Function.prototype.toString = new Proxy(origToString, {
      apply(target, thisArg, args) {
        if (nativeStrMap.has(thisArg)) {
          return nativeStrMap.get(thisArg);
        }
        return Reflect.apply(target, thisArg, args);
      }
    });
  } catch (e) {}

  // ==================== 1. Soft Subtitle (.vtt / .srt) Network Hook ====================
  function parseTimestamp(str) {
    const clean = str.trim().replace(",", ".");
    const parts = clean.split(":").map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return 0;
  }

  function parseSubFileText(rawText) {
    if (!rawText || typeof rawText !== "string") return [];
    const lines = rawText.replace(/\r\n/g, "\n").split("\n");
    const cues = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (line.includes("-->")) {
        const m = line.match(/((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d+:)?\d{2}:\d{2}[.,]\d{3})/);
        if (m) {
          const start = parseTimestamp(m[1]);
          const end = parseTimestamp(m[2]);
          const textLines = [];
          i++;
          while (i < lines.length && lines[i].trim() !== "") {
            textLines.push(lines[i].trim().replace(/<[^>]+>/g, ""));
            i++;
          }
          const text = textLines.join(" ").trim();
          if (text && end > start) {
            cues.push({ start, end, text });
          }
          continue;
        }
      }
      i++;
    }
    return cues;
  }

  function checkAndEmitSubtitleText(url, text) {
    if (!text || text.length < 20 || text.length > 2000000) return;
    const isSubUrl = /\.(vtt|srt)(\?|$)/i.test(url || "");
    const looksLikeSub = text.startsWith("WEBVTT") || (isSubUrl && text.includes("-->"));
    if (!looksLikeSub) return;

    const cues = parseSubFileText(text);
    if (cues.length >= 5) {
      window.postMessage({ type: "__MOVIE_VOICE_SUBTITLE_FILE__", url, cues }, "*");
    }
  }

  try {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = registerNativeStr(
        new Proxy(origFetch, {
          apply(target, thisArg, args) {
            const reqUrl = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
            const p = Reflect.apply(target, thisArg, args);
            if (/\.(vtt|srt)(\?|$)/i.test(reqUrl)) {
              p.then((resp) => {
                if (resp && resp.ok) {
                  resp.clone().text().then((txt) => checkAndEmitSubtitleText(reqUrl, txt)).catch(() => {});
                }
              }).catch(() => {});
            }
            return p;
          }
        }),
        origFetch
      );
    }

    const origXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = registerNativeStr(
      new Proxy(origXhrOpen, {
        apply(target, thisArg, args) {
          const url = String(args[1] || "");
          if (/\.(vtt|srt)(\?|$)/i.test(url)) {
            thisArg.addEventListener("load", function () {
              try {
                if (typeof this.responseText === "string") {
                  checkAndEmitSubtitleText(url, this.responseText);
                }
              } catch (e) {}
            });
          }
          return Reflect.apply(target, thisArg, args);
        }
      }),
      origXhrOpen
    );
  } catch (e) {}

  // ==================== 2. MSE Audio Stream Hook ====================
  if (typeof window.MediaSource === "undefined" || !window.MediaSource.prototype) {
    return;
  }

  function containsAscii(u8, needle) {
    const nLen = needle.length;
    if (u8.length < nLen) return false;
    const c0 = needle.charCodeAt(0);
    const limit = u8.length - nLen;
    for (let i = 0; i <= limit; i++) {
      if (u8[i] === c0) {
        let match = true;
        for (let j = 1; j < nLen; j++) {
          if (u8[i + j] !== needle.charCodeAt(j)) {
            match = false;
            break;
          }
        }
        if (match) return true;
      }
    }
    return false;
  }

  // Walks top-level ISO BMFF (MP4) boxes to cleanly separate [ftyp+moov] init header from [moof+mdat] media fragments
  // and verifies whether the moov header contains an audio track ('soun' / 'mp4a' / 'Opus').
  function parseMp4Buffer(u8) {
    if (!u8 || u8.length < 8) return { type: "unknown" };

    // WebM EBML header: 0x1A 0x45 0xDF 0xA3
    if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) {
      return { type: "pure_init", initBytes: u8, mediaBytes: null, hasAudio: true };
    }

    let offset = 0;
    let moovStart = -1;
    let moovEnd = -1;
    let mediaOffset = -1;

    while (offset + 8 <= u8.length) {
      const size = (
        (u8[offset] << 24) |
        (u8[offset + 1] << 16) |
        (u8[offset + 2] << 8) |
        u8[offset + 3]
      ) >>> 0;
      const boxType = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7]);

      if (size < 8) break;

      if (boxType === "moov") {
        moovStart = offset;
        moovEnd = Math.min(u8.length, offset + size);
      } else if (boxType === "moof" || boxType === "sidx" || boxType === "emsg") {
        if (moovStart !== -1) {
          mediaOffset = offset;
          break;
        }
      }

      if (offset + size > u8.length) break;
      offset += size;
    }

    if (moovStart !== -1) {
      const moovSlice = u8.subarray(moovStart, moovEnd);
      const hasAudio =
        containsAscii(moovSlice, "soun") ||
        containsAscii(moovSlice, "mp4a") ||
        containsAscii(moovSlice, "Opus") ||
        containsAscii(moovSlice, "ac-3") ||
        containsAscii(moovSlice, "ec-3");

      if (mediaOffset !== -1 && mediaOffset > 0) {
        return {
          type: "combined",
          initBytes: u8.slice(0, mediaOffset),
          mediaBytes: u8.slice(mediaOffset),
          hasAudio
        };
      }
      return {
        type: "pure_init",
        initBytes: u8,
        mediaBytes: null,
        hasAudio
      };
    }

    return {
      type: "media",
      initBytes: null,
      mediaBytes: u8,
      hasAudio: null
    };
  }

  function getBufferedRanges(sb) {
    const out = [];
    try {
      const b = sb.buffered;
      for (let i = 0; i < b.length; i++) {
        out.push([b.start(i), b.end(i)]);
      }
    } catch (e) {}
    return out;
  }

  // Diff before/after buffered ranges to find the newly appended segment's [start, end]
  function findAddedRange(prev, next) {
    if (!next || next.length === 0) return null;
    if (!prev || prev.length === 0) {
      const first = next[next.length - 1];
      return { start: first[0], end: first[1] };
    }

    // 1. Check overlapping ranges between prev and next (immune to back-buffer eviction at ns)
    for (let i = 0; i < next.length; i++) {
      const [ns, ne] = next[i];
      for (let j = 0; j < prev.length; j++) {
        const [ps, pe] = prev[j];
        if (ps <= ne + 0.5 && pe >= ns - 0.5) {
          if (ne > pe + 0.05) {
            return { start: pe, end: ne };
          }
          if (ns < ps - 0.05 && Math.abs(ne - pe) < 0.5) {
            return { start: ns, end: ps };
          }
        }
      }
    }

    // 2. Check for a brand new disjoint range (e.g. after seeking to an unbuffered region)
    for (let i = 0; i < next.length; i++) {
      const [ns, ne] = next[i];
      let overlapsAny = false;
      for (let j = 0; j < prev.length; j++) {
        const [ps, pe] = prev[j];
        if (ps <= ne + 0.5 && pe >= ns - 0.5) {
          overlapsAny = true;
          break;
        }
      }
      if (!overlapsAny) {
        return { start: ns, end: ne };
      }
    }

    return null;
  }

  const pendingBatches = [];
  let playerReady = false;

  function emitBatch(batch) {
    if (!playerReady) {
      pendingBatches.push(batch);
      if (pendingBatches.length > 25) pendingBatches.shift();
      return;
    }
    const copy = batch.buffer.slice(0);
    window.postMessage(
      {
        type: "__MOVIE_VOICE_MSE_BATCH__",
        mimeType: batch.mimeType,
        startTime: batch.startTime,
        endTime: batch.endTime,
        byteLength: copy.byteLength,
        buffer: copy
      },
      "*",
      [copy]
    );
  }

  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "__MOVIE_VOICE_PLAYER_READY__") {
      playerReady = true;
      while (pendingBatches.length > 0) {
        emitBatch(pendingBatches.shift());
      }
    }
  });

  let hasDedicatedAudioBuffer = false;
  const origAddSourceBuffer = window.MediaSource.prototype.addSourceBuffer;

  window.MediaSource.prototype.addSourceBuffer = registerNativeStr(
    new Proxy(origAddSourceBuffer, {
      apply(target, mediaSourceInstance, argumentsList) {
        const mimeType = String(argumentsList[0] || "").toLowerCase();
        const sourceBuffer = Reflect.apply(target, mediaSourceInstance, argumentsList);

        const isDedicatedAudio = mimeType.startsWith("audio/");
        const hasAudioCodec = isDedicatedAudio || mimeType.includes("mp4a") || mimeType.includes("opus") || mimeType.includes("vorbis");
        const isVideoOnly = mimeType.startsWith("video/") && !hasAudioCodec;

        if (isDedicatedAudio) {
          hasDedicatedAudioBuffer = true;
        }

        if (isVideoOnly) {
          return sourceBuffer;
        }

        const tracker = {
          mimeType,
          isDedicatedAudio,
          initChunk: null,
          lastInitHasAudio: true,
          fragments: [],
          fragMeta: [],
          totalBytes: 0,
          batchStart: null,
          batchEnd: null,
          hasFlushedFirst: false
        };

        function flushTracker() {
          if (tracker.fragments.length === 0 || tracker.batchStart === null || !tracker.initChunk) {
            tracker.fragments = [];
            tracker.fragMeta = [];
            tracker.totalBytes = 0;
            tracker.batchStart = null;
            tracker.batchEnd = null;
            return;
          }
          if (hasDedicatedAudioBuffer && !tracker.isDedicatedAudio) {
            tracker.fragments = [];
            tracker.fragMeta = [];
            tracker.totalBytes = 0;
            return;
          }

          const parts = [tracker.initChunk, ...tracker.fragments];
          const totalLen = parts.reduce((acc, p) => acc + p.byteLength, 0);
          const merged = new Uint8Array(totalLen);
          let offset = 0;
          for (const p of parts) {
            merged.set(p, offset);
            offset += p.byteLength;
          }

          const startTime = tracker.batchStart;
          const endTime = tracker.batchEnd ?? (startTime + 6.0);

          tracker.fragments = [];
          tracker.fragMeta = [];
          tracker.totalBytes = 0;
          tracker.batchStart = null;
          tracker.batchEnd = null;
          tracker.hasFlushedFirst = true;

          emitBatch({
            mimeType: tracker.mimeType,
            startTime,
            endTime,
            buffer: merged.buffer
          });
        }

        const origAppendBuffer = sourceBuffer.appendBuffer;

        sourceBuffer.appendBuffer = registerNativeStr(
          new Proxy(origAppendBuffer, {
            apply(sbTarget, sbThis, sbArgs) {
              const buffer = sbArgs[0];
              let clonedU8 = null;
              let prevRanges = null;

              if (buffer && (!hasDedicatedAudioBuffer || tracker.isDedicatedAudio)) {
                try {
                  let ab;
                  if (buffer instanceof ArrayBuffer) {
                    ab = buffer.slice(0);
                  } else if (ArrayBuffer.isView(buffer)) {
                    ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
                  }
                  if (ab && ab.byteLength > 100) {
                    clonedU8 = new Uint8Array(ab);
                    prevRanges = getBufferedRanges(sbThis);
                  }
                } catch (e) {}
              }

              const result = Reflect.apply(sbTarget, sbThis, sbArgs);

              if (clonedU8) {
                const parsed = parseMp4Buffer(clonedU8);

                if (parsed.type === "pure_init") {
                  tracker.lastInitHasAudio = Boolean(parsed.hasAudio);
                  if (parsed.hasAudio) {
                    tracker.initChunk = parsed.initBytes;
                  }
                } else {
                  if (parsed.type === "combined") {
                    tracker.lastInitHasAudio = Boolean(parsed.hasAudio);
                    if (parsed.hasAudio && parsed.initBytes) {
                      tracker.initChunk = parsed.initBytes;
                    }
                  }

                  const mediaChunk = parsed.mediaBytes;
                  // Skip video-only fragments when hls.js multiplexes separate init+moof onto one SourceBuffer
                  if (mediaChunk && mediaChunk.byteLength > 0 && tracker.lastInitHasAudio) {
                    const onUpdateEnd = () => {
                      try {
                        const nextRanges = getBufferedRanges(sbThis);
                        const added = findAddedRange(prevRanges, nextRanges);

                        // Never push a fragment whose timestamp range could not be determined when batchStart is null
                        if (!added && tracker.batchStart === null) {
                          return;
                        }

                        if (added && tracker.batchEnd !== null && Math.abs(added.start - tracker.batchEnd) > 2.0) {
                          flushTracker();
                          tracker.hasFlushedFirst = false;
                        }

                        tracker.fragments.push(mediaChunk);
                        tracker.fragMeta.push(added || null);
                        tracker.totalBytes += mediaChunk.byteLength;

                        if (added) {
                          if (tracker.batchStart === null) {
                            tracker.batchStart = added.start;
                          }
                          tracker.batchEnd = Math.max(tracker.batchEnd ?? added.end, added.end);

                          const batchDur = tracker.batchEnd - tracker.batchStart;

                          // First batch after start/seek flushes at ~4.5s; subsequent batches group ~8.0s
                          const shouldFlush =
                            (!tracker.hasFlushedFirst && batchDur >= 4.5) ||
                            (batchDur >= 8.0) ||
                            (tracker.totalBytes >= 3500000);

                          if (shouldFlush) {
                            flushTracker();
                          }
                        }
                      } catch (e) {}
                    };
                    sbThis.addEventListener("updateend", onUpdateEnd, { once: true });
                  }
                }
              }

              return result;
            }
          }),
          origAppendBuffer
        );

        return sourceBuffer;
      }
    }),
    origAddSourceBuffer
  );

  console.log("[Movie Voice] MSE Audio & Subtitle Hook ready.");
})();
