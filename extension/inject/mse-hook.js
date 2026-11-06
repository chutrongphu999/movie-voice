// Movie Voice - Media Source Extensions (MSE) Hook
// Runs in MAIN world at document_start to intercept audio streams with exact buffered timestamps
(function () {
  "use strict";

  if (window.__movieVoiceMseHooked) return;
  window.__movieVoiceMseHooked = true;

  if (typeof window.MediaSource === "undefined" || !window.MediaSource.prototype) {
    return;
  }

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

  // Helper to read buffered TimeRanges into array of [start, end]
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
      return { start: next[0][0], end: next[next.length - 1][1] };
    }
    for (let i = 0; i < next.length; i++) {
      const [ns, ne] = next[i];
      let matched = false;
      for (let j = 0; j < prev.length; j++) {
        const [ps, pe] = prev[j];
        if (Math.abs(ns - ps) < 0.25 && Math.abs(ne - pe) < 0.05) {
          matched = true;
          break;
        }
        // Range extended at the end
        if (Math.abs(ns - ps) < 0.25 && ne > pe + 0.05) {
          return { start: pe, end: ne };
        }
        // Range extended at the start
        if (ns < ps - 0.05 && Math.abs(ne - pe) < 0.25) {
          return { start: ns, end: ps };
        }
      }
      if (!matched) {
        return { start: ns, end: ne };
      }
    }
    const last = next[next.length - 1];
    return { start: Math.max(0, last[1] - 6.0), end: last[1] };
  }

  // Detect MP4 init segment (ftyp / moov) or WebM EBML header
  function isInitSegment(u8) {
    if (!u8 || u8.length < 8) return false;
    // MP4 'ftyp' or 'moov' box in first 64 bytes
    const limit = Math.min(u8.length - 4, 64);
    for (let i = 4; i <= limit; i++) {
      if (
        (u8[i] === 0x66 && u8[i + 1] === 0x74 && u8[i + 2] === 0x79 && u8[i + 3] === 0x70) || // ftyp
        (u8[i] === 0x6d && u8[i + 1] === 0x6f && u8[i + 2] === 0x6f && u8[i + 3] === 0x76)    // moov
      ) {
        // Check if it also contains 'moof' (some players combine init + first moof in one buffer)
        for (let j = i + 4; j < Math.min(u8.length - 4, 4096); j++) {
          if (u8[j] === 0x6d && u8[j + 1] === 0x6f && u8[j + 2] === 0x6f && u8[j + 3] === 0x66) {
            return "combined";
          }
        }
        return "pure_init";
      }
    }
    // WebM EBML header: 0x1A 0x45 0xDF 0xA3
    if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) {
      return "pure_init";
    }
    return false;
  }

  // Queue batches in case content script loads slightly after document_start
  const pendingBatches = [];
  let playerReady = false;

  function emitBatch(batch) {
    if (!playerReady) {
      pendingBatches.push(batch);
      if (pendingBatches.length > 15) pendingBatches.shift();
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
          fragments: [],
          totalBytes: 0,
          batchStart: null,
          batchEnd: null,
          hasFlushedFirst: false
        };

        function flushTracker() {
          if (tracker.fragments.length === 0) return;
          // If a dedicated audio/ buffer exists on this page, skip muxed video/ buffers
          if (hasDedicatedAudioBuffer && !tracker.isDedicatedAudio) {
            tracker.fragments = [];
            tracker.totalBytes = 0;
            return;
          }

          const parts = [];
          if (tracker.initChunk) {
            parts.push(tracker.initChunk);
          }
          for (const f of tracker.fragments) {
            parts.push(f);
          }

          const totalLen = parts.reduce((acc, p) => acc + p.byteLength, 0);
          const merged = new Uint8Array(totalLen);
          let offset = 0;
          for (const p of parts) {
            merged.set(p, offset);
            offset += p.byteLength;
          }

          const startTime = tracker.batchStart ?? 0;
          const endTime = tracker.batchEnd ?? (startTime + 6.0);

          tracker.fragments = [];
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
                const initType = isInitSegment(clonedU8);
                if (initType === "pure_init") {
                  tracker.initChunk = clonedU8;
                } else {
                  if (initType === "combined" && !tracker.initChunk) {
                    // Combined init + first moof
                    tracker.initChunk = null;
                  }
                  const onUpdateEnd = () => {
                    try {
                      const nextRanges = getBufferedRanges(sbThis);
                      const added = findAddedRange(prevRanges, nextRanges);
                      if (added) {
                        // If user seeked or jumped far from current batch, flush old batch first
                        if (tracker.batchEnd !== null && Math.abs(added.start - tracker.batchEnd) > 4.0) {
                          flushTracker();
                        }
                        if (tracker.batchStart === null) {
                          tracker.batchStart = added.start;
                        }
                        tracker.batchEnd = Math.max(tracker.batchEnd ?? added.end, added.end);
                      }

                      tracker.fragments.push(clonedU8);
                      tracker.totalBytes += clonedU8.byteLength;

                      const batchDur = (tracker.batchEnd !== null && tracker.batchStart !== null)
                        ? (tracker.batchEnd - tracker.batchStart)
                        : 0;

                      // Flush immediately on first segment (~4s+) for fast startup, or every ~8s / 90KB afterwards
                      const shouldFlush = (!tracker.hasFlushedFirst && (batchDur >= 3.5 || tracker.totalBytes >= 45000)) ||
                                          (batchDur >= 8.0) ||
                                          (tracker.totalBytes >= 110000);

                      if (shouldFlush) {
                        flushTracker();
                      }
                    } catch (e) {}
                  };
                  sbThis.addEventListener("updateend", onUpdateEnd, { once: true });
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

  console.log("[Movie Voice] MSE Audio Hook v4.1 ready.");
})();
