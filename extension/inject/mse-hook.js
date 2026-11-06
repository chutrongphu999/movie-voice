// Movie Voice - Media Source Extensions (MSE) Hook
// Runs in MAIN world at document_start to intercept audio streams directly from web players
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

  // Preserve native toString so anti-tamper scripts cannot detect the proxy
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

  const origAddSourceBuffer = window.MediaSource.prototype.addSourceBuffer;

  window.MediaSource.prototype.addSourceBuffer = registerNativeStr(
    new Proxy(origAddSourceBuffer, {
      apply(target, mediaSourceInstance, argumentsList) {
        const mimeType = String(argumentsList[0] || "").toLowerCase();
        const sourceBuffer = Reflect.apply(target, mediaSourceInstance, argumentsList);

        // Check if this source buffer carries audio data (or combined audio/video)
        // If it's pure video (e.g. video/mp4 without audio codecs), skip capturing to save CPU/memory
        const isPureVideo = mimeType.startsWith("video/") && !mimeType.includes("mp4a") && !mimeType.includes("opus");
        const isAudio = !isPureVideo;
        const origAppendBuffer = sourceBuffer.appendBuffer;

        let hasFoundInit = false;

        sourceBuffer.appendBuffer = registerNativeStr(
          new Proxy(origAppendBuffer, {
            apply(sbTarget, sbThis, sbArgs) {
              const buffer = sbArgs[0];
              if (buffer && isAudio) {
                try {
                  let chunkData;
                  if (buffer instanceof ArrayBuffer) {
                    chunkData = buffer.slice(0);
                  } else if (ArrayBuffer.isView(buffer)) {
                    chunkData = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
                  }

                  if (chunkData && chunkData.byteLength > 200) {
                    const u8 = new Uint8Array(chunkData);
                    // Detect MP4 initialization segment (ftyp)
                    const isFtyp = u8.length > 8 &&
                                   u8[4] === 0x66 && u8[5] === 0x74 &&
                                   u8[6] === 0x79 && u8[7] === 0x70;

                    const isInit = isFtyp || !hasFoundInit;
                    if (isFtyp) hasFoundInit = true;

                    window.postMessage(
                      {
                        type: "__MOVIE_VOICE_MSE_CHUNK__",
                        mimeType: mimeType,
                        isAudio: true,
                        isInit: isInit,
                        timestamp: Date.now(),
                        byteLength: chunkData.byteLength,
                        buffer: chunkData
                      },
                      "*",
                      [chunkData]
                    );
                  }
                } catch (err) {
                  // Non-fatal, let original video play uninterrupted
                }
              }
              return Reflect.apply(sbTarget, sbThis, sbArgs);
            }
          }),
          origAppendBuffer
        );

        return sourceBuffer;
      }
    }),
    origAddSourceBuffer
  );

  console.log("[Movie Voice] MSE Audio Hook injected successfully in MAIN world.");
})();
