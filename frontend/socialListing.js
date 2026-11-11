/* ALIWEBDESIGN — Standalone Social Media Listing Frontend Module */
(function (global) {
  function escHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  function escapeCsvVal(val) {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/\r\n/g, " ").replace(/[\r\n]/g, " ");
    return `"${str.replace(/"/g, '""')}"`;
  }

  function downloadBlob(blob, filename) {
    if (typeof global.triggerBlobDownload === "function") {
      return global.triggerBlobDownload(blob, filename);
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function getPlatformIconSvg(platform, size = 16) {
    const p = String(platform || "").toLowerCase();
    if (p === "instagram" || p === "ig") {
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;flex-shrink:0;"><rect width="20" height="20" x="2" y="2" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" x2="17.51" y1="6.5" y2="6.5"/></svg>`;
    }
    if (p === "facebook" || p === "fb") {
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block;vertical-align:middle;flex-shrink:0;"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg>`;
    }
    if (p === "pinterest" || p === "pin") {
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block;vertical-align:middle;flex-shrink:0;"><path d="M12.017 2C6.486 2 2 6.486 2 12.017c0 4.237 2.636 7.855 6.356 9.312-.088-.791-.167-2.005.035-2.868.181-.78 1.172-4.97 1.172-4.97s-.299-.6-.299-1.486c0-1.39.806-2.428 1.81-2.428.852 0 1.264.64 1.264 1.408 0 .858-.546 2.14-.828 3.33-.236.995.5 1.807 1.48 1.807 1.778 0 3.144-1.874 3.144-4.58 0-2.393-1.72-4.068-4.177-4.068-2.845 0-4.515 2.135-4.515 4.34 0 .859.331 1.781.745 2.281a.3.3 0 0 1 .069.288l-.278 1.133c-.044.183-.145.223-.335.134-1.249-.581-2.03-2.407-2.03-3.874 0-3.154 2.292-6.052 6.608-6.052 3.469 0 6.165 2.473 6.165 5.776 0 3.447-2.173 6.22-5.19 6.22-1.013 0-1.965-.525-2.291-1.148l-.623 2.378c-.226.869-.835 1.958-1.244 2.621.937.29 1.931.446 2.962.446 5.531 0 10.017-4.486 10.017-10.017S17.548 2 12.017 2z"/></svg>`;
    }
    if (p === "tiktok" || p === "tik") {
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block;vertical-align:middle;flex-shrink:0;"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/></svg>`;
    }
    return "";
  }

  function renderChannelBarHTML(isVisible) {
    const savedStore = localStorage.getItem("magicListing_customStoreUrl") || "";
    const savedHandle = localStorage.getItem("magicListing_customBrandHandle") || "";

    return `
      <div class="ml-social-platforms-row ${isVisible ? "" : "hidden"}" id="mlSocialPlatformsRow">
        <div class="social-platforms-header">
          <span class="social-platforms-title"><i data-lucide="sliders"></i> Target Channels:</span>
          <span class="social-platforms-sub">Click to select or deselect channels — only checked channels are generated for fast results</span>
        </div>
        <div class="social-checkbox-group" id="mlSocialCheckboxGroup">
          <div class="social-checkbox-card active" data-platform-id="instagram" role="button" tabindex="0">
            <input type="checkbox" id="chkSocialIg" value="instagram" checked hidden />
            <span class="social-check-indicator"><i data-lucide="check"></i></span>
            <span class="social-card-icon instagram">${getPlatformIconSvg("instagram", 18)}</span>
            <div class="social-card-text">
              <strong>Instagram</strong>
              <small>Reel caption, CTA &amp; tags</small>
            </div>
          </div>
          <div class="social-checkbox-card active" data-platform-id="facebook" role="button" tabindex="0">
            <input type="checkbox" id="chkSocialFb" value="facebook" checked hidden />
            <span class="social-check-indicator"><i data-lucide="check"></i></span>
            <span class="social-card-icon facebook">${getPlatformIconSvg("facebook", 18)}</span>
            <div class="social-card-text">
              <strong>Facebook</strong>
              <small>Conversational hook &amp; tags</small>
            </div>
          </div>
          <div class="social-checkbox-card active" data-platform-id="pinterest" role="button" tabindex="0">
            <input type="checkbox" id="chkSocialPin" value="pinterest" checked hidden />
            <span class="social-check-indicator"><i data-lucide="check"></i></span>
            <span class="social-card-icon pinterest">${getPlatformIconSvg("pinterest", 18)}</span>
            <div class="social-card-text">
              <strong>Pinterest</strong>
              <small>Pin title (100 ch), desc, tags</small>
            </div>
          </div>
          <div class="social-checkbox-card active" data-platform-id="tiktok" role="button" tabindex="0">
            <input type="checkbox" id="chkSocialTik" value="tiktok" checked hidden />
            <span class="social-check-indicator"><i data-lucide="check"></i></span>
            <span class="social-card-icon tiktok">${getPlatformIconSvg("tiktok", 18)}</span>
            <div class="social-card-text">
              <strong>TikTok</strong>
              <small>Video title, hook, audio, FYP tags</small>
            </div>
          </div>
        </div>

        <div class="social-store-url-row" style="margin-top:0.75rem;padding:0.6rem 0.85rem;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:8px;display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">
          <label for="mlCustomStoreUrl" style="font-size:0.75rem;font-weight:600;color:#94a3b8;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;">
            <i data-lucide="link" style="width:13px;height:13px;color:#38bdf8;"></i> Store Link (Optional):
          </label>
          <input type="url" id="mlCustomStoreUrl" value="${escHtml(savedStore)}" placeholder="https://yourstore.com (custom destination link for Pinterest pins & bio CTAs)" style="flex:1;min-width:240px;background:rgba(15,23,42,0.6);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:0.4rem 0.65rem;color:#f8fafc;font-size:0.78rem;" />
          <label for="mlCustomBrandHandle" style="font-size:0.75rem;font-weight:600;color:#94a3b8;white-space:nowrap;">@Handle (Optional):</label>
          <input type="text" id="mlCustomBrandHandle" value="${escHtml(savedHandle)}" placeholder="@yourbrand" style="width:165px;background:rgba(15,23,42,0.6);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:0.4rem 0.65rem;color:#f8fafc;font-size:0.78rem;" />
        </div>
      </div>`;
  }

  function initChannelBarEvents() {
    const socialGroup = document.getElementById("mlSocialCheckboxGroup");
    socialGroup?.addEventListener("click", (e) => {
      const card = e.target.closest(".social-checkbox-card");
      if (!card) return;
      const chk = card.querySelector("input[type=checkbox]");
      if (!chk) return;

      const checkedBoxes = Array.from(socialGroup.querySelectorAll("input[type=checkbox]:checked"));
      if (chk.checked && checkedBoxes.length <= 1) {
        alert("At least one social channel must remain selected.");
        return;
      }

      chk.checked = !chk.checked;
      card.classList.toggle("active", chk.checked);
    });

    const storeInput = document.getElementById("mlCustomStoreUrl");
    storeInput?.addEventListener("input", (e) => {
      localStorage.setItem("magicListing_customStoreUrl", e.target.value.trim());
    });

    const handleInput = document.getElementById("mlCustomBrandHandle");
    handleInput?.addEventListener("input", (e) => {
      localStorage.setItem("magicListing_customBrandHandle", e.target.value.trim());
    });
  }

  function getSelectedChannels() {
    return [
      document.getElementById("chkSocialIg"),
      document.getElementById("chkSocialFb"),
      document.getElementById("chkSocialPin"),
      document.getElementById("chkSocialTik"),
    ].filter((chk) => chk?.checked).map((chk) => chk.value);
  }

  function getRequestConfig(designs, referenceData) {
    const selectedPlatforms = getSelectedChannels();
    if (selectedPlatforms.length === 0) {
      throw new Error("Please select at least one Social Media channel (Instagram, Facebook, Pinterest, or TikTok).");
    }
    const customStoreUrl = (document.getElementById("mlCustomStoreUrl")?.value || "").trim();
    const customBrandHandle = (document.getElementById("mlCustomBrandHandle")?.value || "").trim();

    return {
      endpoint: "/api/social-listing/batch",
      body: {
        designs,
        referenceData,
        selectedPlatforms,
        customStoreUrl,
        customBrandHandle,
      },
    };
  }

  function defaultCopyBtn(label, text) {
    return `
      <button type="button" class="btn secondary btn-sm ml-copy" data-copy="${escHtml(text)}" title="Copy ${escHtml(label)}">
        <i data-lucide="copy"></i> ${escHtml(label)}
      </button>`;
  }

  function buildPlatformPaneHTML(pKey, isActive, ctx) {
    const {
      data,
      podTitle,
      fileNameMp4,
      igCap,
      fbCap,
      ctaText,
      tagsStr,
      tagsArr,
      destLinkFallback,
      copyBtn = defaultCopyBtn,
    } = ctx;

    const ig = data.instagram || null;
    const fb = data.facebook || null;
    const pin = data.pinterest || null;
    const tik = data.tiktok || null;

    if (pKey === "ig") {
      const cap = ig?.caption || igCap || "";
      const igTagsArr = Array.isArray(ig?.hashtags) ? ig.hashtags : tagsArr;
      const igTagsStr = igTagsArr.join(" ");
      const igCta = ig?.call_to_action || ctaText;
      return `
        <div class="social-tab-pane ${isActive ? "active" : ""}" data-pane="ig">
          <div class="social-field-group">
            <div class="social-field-head">
              <span class="social-field-label">IG Reel Caption (150-250 chars)</span>
              ${copyBtn("Caption", cap)}
            </div>
            <div class="social-field-val">${escHtml(cap)}</div>
          </div>

          <div class="social-field-group">
            <div class="social-field-head">
              <span class="social-field-label">Call To Action</span>
              ${copyBtn("CTA", igCta)}
            </div>
            <div class="social-field-val" style="color:#38bdf8;font-weight:600;">${escHtml(igCta)}</div>
          </div>

          <div class="social-field-group">
            <div class="social-field-head">
              <span class="social-field-label">Hashtags (8-10 niche tags)</span>
              ${copyBtn("Hashtags", igTagsStr)}
            </div>
            <div class="ml-tag-cloud">
              ${igTagsArr.map((t) => `<span class="ml-tag-pill">${escHtml(t)}</span>`).join("")}
            </div>
          </div>
        </div>`;
    }

    if (pKey === "fb") {
      const cap = fb?.caption || fbCap || "";
      const fbTagsArr = Array.isArray(fb?.hashtags) ? fb.hashtags : tagsArr.slice(0, 8);
      const fbTagsStr = fbTagsArr.join(" ");
      const fbCta = fb?.call_to_action || ctaText;
      return `
        <div class="social-tab-pane ${isActive ? "active" : ""}" data-pane="fb">
          <div class="social-field-group">
            <div class="social-field-head">
              <span class="social-field-label">FB Reel / Post Caption (Conversational Hook)</span>
              ${copyBtn("Caption", cap)}
            </div>
            <div class="social-field-val">${escHtml(cap)}</div>
          </div>

          <div class="social-field-group">
            <div class="social-field-head">
              <span class="social-field-label">Call To Action</span>
              ${copyBtn("CTA", fbCta)}
            </div>
            <div class="social-field-val" style="color:#38bdf8;font-weight:600;">${escHtml(fbCta)}</div>
          </div>

          <div class="social-field-group">
            <div class="social-field-head">
              <span class="social-field-label">Hashtags</span>
              ${copyBtn("Hashtags", fbTagsStr)}
            </div>
            <div class="ml-tag-cloud">
              ${fbTagsArr.map((t) => `<span class="ml-tag-pill">${escHtml(t)}</span>`).join("")}
            </div>
          </div>
        </div>`;
    }

    if (pKey === "pin") {
      const pinTitle = pin?.pin_title || `${podTitle} | Graphic T-Shirt`;
      const pinDesc = pin?.pin_description || igCap || "";
      const boardName = pin?.board_name || pin?.board || pin?.recommended_board || "Graphic Tees & Apparel";
      const destLink = pin?.destination_link || destLinkFallback || "https://yourstore.com";
      const pinTags = typeof pin?.tags === "string"
        ? pin.tags
        : (Array.isArray(pin?.tags)
            ? pin.tags.join(", ")
            : (Array.isArray(pin?.search_keywords)
                ? pin.search_keywords.join(", ")
                : (Array.isArray(pin?.hashtags) ? pin.hashtags.map((t) => t.replace(/^#/, "")).join(", ") : "")));
      const pinTagsArr = pinTags.split(",").map((t) => t.trim()).filter(Boolean);
      const pinStatus = pin?.status || "READY";

      const pinRowText = [fileNameMp4, pinTitle, pinDesc, boardName, destLink, pinTags, pinStatus]
        .map(escapeCsvVal)
        .join(",");

      return `
        <div class="social-tab-pane ${isActive ? "active" : ""}" data-pane="pin">
          <div class="social-field-group">
            <div class="social-field-head">
              <span class="social-field-label">Pin_Title (Max 100 chars, SEO Search Optimized)</span>
              ${copyBtn("Title", pinTitle)}
            </div>
            <div class="social-field-val"><strong>${escHtml(pinTitle)}</strong></div>
          </div>

          <div class="social-field-group">
            <div class="social-field-head">
              <span class="social-field-label">Pin_Description (200–450 chars SEO Description)</span>
              ${copyBtn("Description", pinDesc)}
            </div>
            <div class="social-field-val" style="line-height:1.6;">${escHtml(pinDesc)}</div>
          </div>

          <div class="social-field-group">
            <div class="social-field-head">
              <span class="social-field-label">Board Name</span>
              ${copyBtn("Board", boardName)}
            </div>
            <div style="margin-top:0.25rem;">
              <span class="ml-tag-pill" style="font-weight:600;background:rgba(239,68,68,0.12);color:#f87171;border-color:rgba(239,68,68,0.25);display:inline-flex;align-items:center;gap:5px;">
                <i data-lucide="folder" style="width:12px;height:12px;"></i>${escHtml(boardName)}
              </span>
            </div>
          </div>

          <div class="social-field-group">
            <div class="social-field-head">
              <span class="social-field-label">Destination Link</span>
              ${copyBtn("Link", destLink)}
            </div>
            <div class="social-field-val" style="margin-top:0.25rem;">
              <a href="${escHtml(destLink)}" target="_blank" rel="noopener noreferrer" style="color:#38bdf8;font-size:0.8rem;display:inline-flex;align-items:center;gap:6px;text-decoration:none;word-break:break-all;max-width:100%;">
                <i data-lucide="external-link" style="width:12px;height:12px;flex-shrink:0;"></i>
                <span>${escHtml(destLink)}</span>
              </a>
            </div>
          </div>

          <div class="social-field-group">
            <div class="social-field-head">
              <span class="social-field-label">Tags (Pinterest Search Keywords)</span>
              ${copyBtn("Tags", pinTags)}
            </div>
            <div class="ml-tag-cloud">
              ${pinTagsArr.map((t) => `<span class="ml-tag-pill"><i data-lucide="search" style="width:10px;height:10px;margin-right:3px;"></i>${escHtml(t)}</span>`).join("")}
            </div>
          </div>

          <div style="display:flex;align-items:center;justify-content:space-between;margin-top:0.75rem;padding-top:0.5rem;border-top:1px solid rgba(255,255,255,0.06);">
            <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#94a3b8;">
              <span>Status:</span>
              <span class="ml-tag-pill" style="color:#10b981;background:rgba(16,185,129,0.12);border-color:rgba(16,185,129,0.3);font-weight:600;">${escHtml(pinStatus)}</span>
            </div>
            ${copyBtn("Pin Row (CSV)", pinRowText)}
          </div>
        </div>`;
    }

    if (pKey === "tik") {
      const videoTitle = tik?.video_title || tik?.title || podTitle;
      const tikCap = tik?.caption || `${podTitle} — Tap link in bio to check it out!`;
      const onScreenHook = tik?.on_screen_hook || tik?.text_hook || `POV: ${podTitle}`;
      const soundVibe = tik?.sound_vibe || "Trending Upbeat Apparel Audio";
      const tikTagsArr = Array.isArray(tik?.hashtags)
        ? tik.hashtags
        : (typeof tik?.hashtags === "string" ? tik.hashtags.split(/\s+/).filter(Boolean) : tagsArr);
      const tikTags = tikTagsArr.join(" ");
      const tikCta = tik?.call_to_action || "Tap link in bio to shop!";
      const tikStatus = tik?.status || "READY";

      const tikRowText = [fileNameMp4, videoTitle, tikCap, onScreenHook, soundVibe, tikTags, tikCta, tikStatus]
        .map(escapeCsvVal)
        .join(",");

      return `
        <div class="social-tab-pane ${isActive ? "active" : ""}" data-pane="tik">
          <div class="social-field-group">
            <div class="social-field-head">
              <span class="social-field-label">Video Title (Hook under 48 chars)</span>
              ${copyBtn("Title", videoTitle)}
            </div>
            <div class="social-field-val"><strong>${escHtml(videoTitle)}</strong></div>
          </div>

          <div class="social-field-group">
            <div class="social-field-head">
              <span class="social-field-label">TikTok / FYP Caption (100–220 chars)</span>
              ${copyBtn("Caption", tikCap)}
            </div>
            <div class="social-field-val" style="line-height:1.5;">${escHtml(tikCap)}</div>
          </div>

          <div class="social-field-group">
            <div class="social-field-head">
              <span class="social-field-label">On-Screen Text Hook (Opening 2 Seconds)</span>
              ${copyBtn("Hook", onScreenHook)}
            </div>
            <div style="margin-top:0.25rem;">
              <span class="ml-tag-pill" style="font-weight:600;background:rgba(168,85,247,0.12);color:#c084fc;border-color:rgba(168,85,247,0.3);display:inline-flex;align-items:center;gap:5px;">
                <i data-lucide="sparkles" style="width:12px;height:12px;"></i>${escHtml(onScreenHook)}
              </span>
            </div>
          </div>

          <div class="social-field-group">
            <div class="social-field-head">
              <span class="social-field-label">Sound Vibe / Audio Recommendation</span>
              ${copyBtn("Sound", soundVibe)}
            </div>
            <div style="margin-top:0.25rem;">
              <span class="ml-tag-pill" style="font-weight:600;background:rgba(56,189,248,0.12);color:#38bdf8;border-color:rgba(56,189,248,0.25);display:inline-flex;align-items:center;gap:5px;">
                <i data-lucide="music" style="width:12px;height:12px;"></i>${escHtml(soundVibe)}
              </span>
            </div>
          </div>

          <div class="social-field-group">
            <div class="social-field-head">
              <span class="social-field-label">Hashtags (5–8 TikTok tags)</span>
              ${copyBtn("Hashtags", tikTags)}
            </div>
            <div class="ml-tag-cloud">
              ${tikTagsArr.map((t) => `<span class="ml-tag-pill"><i data-lucide="hash" style="width:10px;height:10px;margin-right:2px;"></i>${escHtml(t.replace(/^#/, ""))}</span>`).join("")}
            </div>
          </div>

          <div class="social-field-foot" style="display:flex;justify-content:space-between;align-items:center;margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid rgba(255,255,255,0.06);font-size:0.75rem;color:#94a3b8;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span>Status:</span>
              <span class="ml-tag-pill" style="color:#10b981;background:rgba(16,185,129,0.12);border-color:rgba(16,185,129,0.3);font-weight:600;">${escHtml(tikStatus)}</span>
            </div>
            ${copyBtn("TikTok Row (CSV)", tikRowText)}
          </div>
        </div>`;
    }

    return "";
  }

  function extractSocialCardContext(data, fallbackName = "") {
    const podTitle = data.pod_title || data.title || "Graphic Tee";
    const fileNameMp4 = data.file_name || (fallbackName
      ? fallbackName.replace(/\.[^/.]+$/, "").replace(/[^a-z0-9]+/gi, "_").toLowerCase() + ".mp4"
      : "graphic_tee.mp4");
    const ctaText = data.call_to_action || data.instagram?.call_to_action || "Shop the collection — Link in Bio!";
    const igCap = data.ig_caption || data.instagram?.caption || "";
    const fbCap = data.fb_caption || data.facebook?.caption || "";
    const tagsStr = typeof data.hashtags === "string"
      ? data.hashtags
      : (Array.isArray(data.hashtags)
          ? data.hashtags.join(" ")
          : (Array.isArray(data.instagram?.hashtags) ? data.instagram.hashtags.join(" ") : ""));
    const tagsArr = tagsStr.split(" ").filter(Boolean);
    const destLinkFallback =
      document.getElementById("mlCustomStoreUrl")?.value?.trim() ||
      localStorage.getItem("magicListing_customStoreUrl") ||
      "https://yourstore.com";

    const availableTabs = [
      data.instagram ? { id: "ig", label: "Instagram", svg: getPlatformIconSvg("instagram", 14) } : null,
      data.facebook ? { id: "fb", label: "Facebook", svg: getPlatformIconSvg("facebook", 14) } : null,
      data.pinterest ? { id: "pin", label: "Pinterest", svg: getPlatformIconSvg("pinterest", 14) } : null,
      data.tiktok ? { id: "tik", label: "TikTok", svg: getPlatformIconSvg("tiktok", 14) } : null,
    ].filter(Boolean);

    return {
      data,
      podTitle,
      fileNameMp4,
      ctaText,
      igCap,
      fbCap,
      tagsStr,
      tagsArr,
      destLinkFallback,
      availableTabs,
      defaultTabId: availableTabs[0]?.id || "ig",
    };
  }

  function renderCard(item, { copyBtn = defaultCopyBtn, timeBadge = "" } = {}) {
    const data = item.listing || {};
    const ctx = extractSocialCardContext(data, item.fileName || "");
    ctx.copyBtn = copyBtn;

    const summary = data.summary || `${ctx.podTitle} social media copy`;
    const targetAudience = data.target_audience || "";

    const csvRowText = [
      ctx.fileNameMp4,
      ctx.podTitle,
      ctx.igCap,
      ctx.fbCap,
      ctx.tagsStr,
      ctx.ctaText,
      data.status || "READY",
      "", "", "", "", "",
    ].map(escapeCsvVal).join(",");

    const allSocialText = [
      `File_Name: ${ctx.fileNameMp4}`,
      `POD_Title: ${ctx.podTitle}`,
      ctx.igCap ? `IG_Caption: ${ctx.igCap}` : "",
      ctx.fbCap ? `FB_Caption: ${ctx.fbCap}` : "",
      ctx.tagsStr ? `Hashtags: ${ctx.tagsStr}` : "",
      `Call_To_Action: ${ctx.ctaText}`,
      `Status: ${data.status || "READY"}`,
    ].filter(Boolean).join("\n");

    return `
      <div class="ml-card ml-social-card" data-card-index="${escHtml(item.designIndex)}">
        <div class="ml-card-header">
          <div class="ml-card-title-group">
            <img src="${escHtml(item.thumbnailUrl || "")}" class="ml-card-thumb" alt="${escHtml(item.fileName || "")}" />
            <div class="ml-card-meta">
              <span class="ml-index-badge platform-badge social">Social Media</span>
              <span class="ml-file-name" title="${escHtml(ctx.fileNameMp4)}">${escHtml(ctx.fileNameMp4)}</span>
            </div>
          </div>
          <span class="ml-card-safe ${data.trademark_safe !== false ? "badge-safe" : "badge-warn"}">
            <i data-lucide="shield-check"></i> ${data.trademark_safe !== false ? "Trademark safe" : "Check IP"}
          </span>
        </div>

        <div class="ml-card-body">
          <div class="social-summary-bar">
            <span class="social-summary-badge"><i data-lucide="sparkles"></i> Design Theme &amp; Niche</span>
            <p class="social-summary-text">${escHtml(summary)}</p>
            ${targetAudience ? `<p class="social-persona-sub"><strong>Audience:</strong> ${escHtml(targetAudience)}</p>` : ""}
          </div>

          <div class="social-top-meta-fields" style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:1rem;background:rgba(255,255,255,0.02);padding:0.75rem;border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
            <div>
              <div class="social-field-head" style="margin-bottom:4px;">
                <span class="social-field-label" style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;">File_Name</span>
                ${copyBtn("File Name", ctx.fileNameMp4)}
              </div>
              <code style="font-size:12px;color:#38bdf8;font-family:ui-monospace,Menlo,monospace;word-break:break-all;">${escHtml(ctx.fileNameMp4)}</code>
            </div>
            <div>
              <div class="social-field-head" style="margin-bottom:4px;">
                <span class="social-field-label" style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;">POD_Title (&lt; 45 chars)</span>
                ${copyBtn("Title", ctx.podTitle)}
              </div>
              <strong style="font-size:13px;color:#f8fafc;">${escHtml(ctx.podTitle)}</strong>
            </div>
          </div>

          <div class="social-tabs-nav">
            ${ctx.availableTabs.map((t) => `
              <button type="button" class="social-tab-btn ${t.id === ctx.defaultTabId ? "active" : ""}" data-tab="${t.id}">
                ${t.svg} ${t.label}
              </button>
            `).join("")}
          </div>

          <div class="social-tabs-content">
            ${data.instagram ? buildPlatformPaneHTML("ig", ctx.defaultTabId === "ig", ctx) : ""}
            ${data.facebook ? buildPlatformPaneHTML("fb", ctx.defaultTabId === "fb", ctx) : ""}
            ${data.pinterest ? buildPlatformPaneHTML("pin", ctx.defaultTabId === "pin", ctx) : ""}
            ${data.tiktok ? buildPlatformPaneHTML("tik", ctx.defaultTabId === "tik", ctx) : ""}
          </div>
        </div>
        <div class="ml-card-actions">
          ${copyBtn("12-Col CSV Row", csvRowText)}
          ${copyBtn("All Fields", allSocialText)}
          ${timeBadge}
        </div>
      </div>`;
  }

  function renderLibrarySocialCard(l, socialData, { selectOverlay, headerHtml, isSelected, copyBtn = defaultCopyBtn } = {}) {
    const ctx = extractSocialCardContext(socialData || {}, l.file_name || "");
    ctx.copyBtn = copyBtn;

    const summary = socialData.summary || l.description || `${ctx.podTitle} social media package`;
    const targetAudience = socialData.target_audience || l.brand || "";
    const allSocialText = [
      `--- ${l.file_name || ctx.fileNameMp4} ---`,
      `POD_Title: ${ctx.podTitle}`,
      ctx.igCap ? `IG_Caption: ${ctx.igCap}` : "",
      ctx.fbCap ? `FB_Caption: ${ctx.fbCap}` : "",
      ctx.tagsStr ? `Hashtags: ${ctx.tagsStr}` : "",
      `Call_To_Action: ${ctx.ctaText}`,
    ].filter(Boolean).join("\n");

    return `
      <div class="ml-card ml-social-card listing-card ${isSelected ? "selected" : ""}" data-id="${escHtml(l.id)}">
        ${selectOverlay}
        ${headerHtml}
        <div class="ml-card-body">
          <div class="social-summary-bar">
            <span class="social-summary-badge"><i data-lucide="sparkles"></i> Design Theme &amp; Niche</span>
            <p class="social-summary-text">${escHtml(summary)}</p>
            ${targetAudience ? `<p class="social-persona-sub"><strong>Audience:</strong> ${escHtml(targetAudience)}</p>` : ""}
          </div>

          <div class="social-tabs-nav">
            ${ctx.availableTabs.map((t) => `
              <button type="button" class="social-tab-btn ${t.id === ctx.defaultTabId ? "active" : ""}" data-tab="${t.id}">
                ${t.svg} ${t.label}
              </button>
            `).join("")}
          </div>

          <div class="social-tabs-content">
            ${socialData.instagram ? buildPlatformPaneHTML("ig", ctx.defaultTabId === "ig", ctx) : ""}
            ${socialData.facebook ? buildPlatformPaneHTML("fb", ctx.defaultTabId === "fb", ctx) : ""}
            ${socialData.pinterest ? buildPlatformPaneHTML("pin", ctx.defaultTabId === "pin", ctx) : ""}
            ${socialData.tiktok ? buildPlatformPaneHTML("tik", ctx.defaultTabId === "tik", ctx) : ""}
          </div>
        </div>
        <div class="ml-card-actions">
          ${copyBtn("All", allSocialText)}
          <button type="button" class="btn secondary btn-sm danger danger-btn" data-act="delete" title="Delete listing">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      </div>`;
  }

  async function exportXLSX(listingsData) {
    if (!listingsData || !listingsData.length) return alert("No social listings to export.");
    try {
      const res = await fetch("/api/social-listing/export-social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: listingsData, format: "xlsx" }),
      });
      if (!res.ok) throw new Error("Failed to export spreadsheet");
      const blob = await res.blob();
      const dateStr = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `magic_fabrica_social_listings_${dateStr}.xlsx`);
    } catch (err) {
      console.error("Social export XLSX error:", err);
      alert("Export failed: " + err.message);
    }
  }

  function exportCSV(listingsData) {
    if (!listingsData || !listingsData.length) return alert("No social listings to export.");

    const headers = [
      "File_Name",
      "POD_Title",
      "IG_Caption",
      "FB_Caption",
      "Hashtags",
      "Call_To_Action",
      "Status",
      "Video_ID",
      "Cloudinary_URL",
      "IG_Media_ID",
      "FB_Post_ID",
      "Published_At",
    ];

    const rows = listingsData.map((it) => {
      const l = it.listing || {};
      const podTitle = l.pod_title || l.title || "Graphic Tee";
      const fileName = l.file_name || (it.fileName
        ? it.fileName.replace(/\.[^/.]+$/, "").replace(/[^a-z0-9]+/gi, "_").toLowerCase() + ".mp4"
        : "graphic_tee.mp4");
      const igCap = l.ig_caption || l.instagram?.caption || "";
      const fbCap = l.fb_caption || l.facebook?.caption || "";
      const tags = typeof l.hashtags === "string"
        ? l.hashtags
        : (Array.isArray(l.hashtags) ? l.hashtags.join(" ") : "");
      const cta = l.call_to_action || l.instagram?.call_to_action || "Shop the collection — Link in Bio!";

      return [
        escapeCsvVal(fileName),
        escapeCsvVal(podTitle),
        escapeCsvVal(igCap),
        escapeCsvVal(fbCap),
        escapeCsvVal(tags),
        escapeCsvVal(cta),
        escapeCsvVal(l.status || "READY"),
        '""', '""', '""', '""', '""',
      ].join(",");
    });

    const csvContent = "\uFEFF" + [headers.map(escapeCsvVal).join(","), ...rows].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const dateStr = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `magic_social_listings_${dateStr}.csv`);
  }

  global.SocialListing = {
    getPlatformIconSvg,
    renderChannelBarHTML,
    initChannelBarEvents,
    getRequestConfig,
    renderCard,
    renderLibrarySocialCard,
    exportXLSX,
    exportCSV,
  };
})(window);
