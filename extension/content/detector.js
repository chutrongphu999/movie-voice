// Movie Voice - Player & Subtitle Detector
// Discovers the primary video element and listens for native textTracks and player DOM subtitles
(function () {
  "use strict";

  const PLAYER_SUBTITLE_SELECTORS = [
    ".art-subtitle",                       // ArtPlayer (Phim4k, RoPhim, KKPhim, Motchill...)
    ".jw-text-track-cue",                  // JWPlayer (Phimmoi, Subnhanh...)
    ".jw-captions",
    ".dplayer-subtitle",                   // DPlayer
    ".vjs-text-track-display",             // VideoJS
    ".vjs-text-track-cue",
    ".plyr__captions",                     // Plyr
    ".shaka-text-container",               // Shaka Player
    ".bpx-player-subtitle-panel-text",     // Bilibili
    ".player-timedtext-text-container",    // Netflix
    ".caption-window",
    ".subtitle-text",
    ".vp-captions"
  ];

  class VideoDetector {
    constructor(onVideoFound, onSubtitleDetected) {
      self = this;
      this.onVideoFound = onVideoFound;
      this.onSubtitleDetected = onSubtitleDetected;
      this.activeVideo = null;
      this.lastSubtitleText = "";
      this.lastSubtitleTime = 0;
      this.init();
    }

    init() {
      this.scanVideos();
      const observer = new MutationObserver(() => this.scanVideos());
      observer.observe(document.documentElement, { childList: true, subtree: true });

      // Observe DOM subtitles
      setInterval(() => this.checkDomSubtitles(), 250);
    }

    scanVideos() {
      const videos = Array.from(document.querySelectorAll("video")).filter(v => {
        // Filter out tiny video ads or hidden elements
        const rect = v.getBoundingClientRect();
        return rect.width > 200 && rect.height > 100;
      });

      if (videos.length === 0) return;

      // Select currently playing or largest video
      let candidate = videos.find(v => !v.paused) || videos.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return (rb.width * rb.height) - (ra.width * ra.height);
      })[0];

      if (candidate && candidate !== this.activeVideo) {
        this.activeVideo = candidate;
        this.bindVideo(candidate);
        if (this.onVideoFound) this.onVideoFound(candidate);
      }
    }

    bindVideo(video) {
      if (video.__mvBound) return;
      video.__mvBound = true;

      // Listen for HTML5 native textTracks
      if (video.textTracks) {
        const bindTrack = (track) => {
          if (!["subtitles", "captions"].includes(track.kind)) return;
          track.mode = "hidden"; // Keep active to receive events
          track.addEventListener("cuechange", () => {
            if (!track.activeCues || track.activeCues.length === 0) return;
            const texts = [];
            for (let i = 0; i < track.activeCues.length; i++) {
              if (track.activeCues[i].text) texts.push(track.activeCues[i].text);
            }
            if (texts.length > 0) {
              const fullText = texts.join(" ").trim();
              const startTime = track.activeCues[0].startTime;
              const endTime = track.activeCues[track.activeCues.length - 1].endTime;
              this.emitSubtitle(fullText, startTime, endTime, true);
            }
          });
        };

        for (let i = 0; i < video.textTracks.length; i++) {
          bindTrack(video.textTracks[i]);
        }
        video.textTracks.addEventListener("addtrack", (e) => bindTrack(e.track));
      }
    }

    checkDomSubtitles() {
      if (!this.activeVideo || this.activeVideo.paused) return;

      const root = this.activeVideo.closest(".plyr, .video-js, .jwplayer, .art-video-player, .dplayer") || this.activeVideo.parentElement;
      if (!root) return;

      for (const sel of PLAYER_SUBTITLE_SELECTORS) {
        const el = root.querySelector(sel);
        if (el && el.innerText && el.innerText.trim().length >= 2) {
          const txt = el.innerText.trim();
          const curr = this.activeVideo.currentTime;
          this.emitSubtitle(txt, curr, curr + 2.5, false);
          return;
        }
      }
    }

    emitSubtitle(text, start, end, isNativeTrack) {
      if (!text || text === this.lastSubtitleText) return;
      this.lastSubtitleText = text;
      this.lastSubtitleTime = Date.now();

      if (this.onSubtitleDetected) {
        this.onSubtitleDetected({
          text: text,
          start: start,
          end: end,
          isNativeTrack: isNativeTrack
        });
      }
    }
  }

  window.MovieVoiceDetector = VideoDetector;
})();
