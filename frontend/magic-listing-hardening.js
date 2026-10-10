(function () {
  if (typeof viewMount !== 'function' || typeof views !== 'object') return;

  function getAuthHeaders() {
    const token = localStorage.getItem('aliwebdesign.jwt') || localStorage.getItem('authToken') || '';
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function fetchWithAuth(url, opts = {}) {
    const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
    const headers = {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(opts.headers || {}),
      ...getAuthHeaders(),
    };
    return fetch(url, { ...opts, headers });
  }

  function priceRangeLabel(priceRange) {
    if (!priceRange) return '';
    if (typeof priceRange === 'string') return priceRange;
    return priceRange.label || `${priceRange.currency || 'USD'} ${priceRange.min ?? ''}-${priceRange.max ?? ''}`;
  }

  function buildEditableItem(result, thumbnailUrl, currentPlatform) {
    const listing = result.listing || {};
    const originalReview = {
      title: listing.suggested_title || '',
      category: listing.suggested_category || '',
      priceRange: priceRangeLabel(listing.suggested_price_range),
      bulletPoints: Array.isArray(listing.bullet_points) ? listing.bullet_points.join('\n') : '',
      description: listing.description || '',
    };
    return {
      sessionId: result.sessionId || `${Date.now()}-${Math.random()}`,
      designIndex: result.designIndex,
      fileName: result.fileName,
      thumbnailUrl,
      platform: result.platform || currentPlatform,
      listing,
      originalReview,
      review: { ...originalReview },
      statuses: {
        title: 'suggested',
        category: 'suggested',
        priceRange: 'suggested',
        bulletPoints: 'suggested',
        description: 'suggested',
      },
    };
  }

  function buildPlatformPayload(item) {
    const review = item.review;
    const listing = item.listing || {};
    const bulletLines = String(review.bulletPoints || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
    if (item.platform === 'teepublic') {
      const allTags = bulletLines.map((line) => line.toLowerCase().replace(/[^a-z0-9 ]/g, ' ')).slice(0, 6);
      return {
        title: review.title,
        description: review.description,
        main_tag: allTags[0] || review.category.toLowerCase().split(/[\/ ]+/).slice(0, 2).join(' '),
        supporting_tags: allTags.slice(1),
      };
    }
    if (item.platform === 'etsy') {
      return {
        title: review.title,
        category: review.category,
        attributes: listing.platform_payload?.attributes || {},
        tags: bulletLines.map((line) => line.toLowerCase().replace(/[^a-z0-9 ]/g, ' ')).slice(0, 13),
        description: review.description,
      };
    }
    return {
      title: review.title,
      brand: listing.platform_payload?.brand || 'Aliwebdesign Studio',
      bullet1: bulletLines[0] || '',
      bullet2: bulletLines[1] || '',
      description: review.description,
    };
  }

  function exportListingsToCSV(listingsData) {
    if (!listingsData?.length) return;
    const escapeCSV = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const headers = [
      'Design ID','File Name','Platform','Reviewed Title','Reviewed Category','Reviewed Price Range','Reviewed Bullet Points','Description','Confidence Score','Requires Manual Review','Source','Platform Payload','Generated At'
    ];
    const rows = listingsData.map((item) => [
      escapeCSV(item.designIndex ?? ''),
      escapeCSV(item.fileName || ''),
      escapeCSV(item.platform || 'amazon'),
      escapeCSV(item.review.title),
      escapeCSV(item.review.category),
      escapeCSV(item.review.priceRange),
      escapeCSV(item.review.bulletPoints),
      escapeCSV(item.review.description),
      escapeCSV(item.listing?.confidence_score ?? ''),
      escapeCSV(item.listing?.requires_manual_review ? 'yes' : 'no'),
      escapeCSV(item.listing?.source || ''),
      escapeCSV(JSON.stringify(buildPlatformPayload(item))),
      escapeCSV(new Date().toISOString()),
    ].join(','));
    const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `magic_listings_export_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function magicListingCard(item) {
    const listing = item.listing || {};
    const payload = buildPlatformPayload(item);
    const badgeClass = listing.requires_manual_review ? 'badge-warn' : 'badge-safe';
    const field = (key, label, value, multiline = false) => `
      <div class="ml-review-field status-${esc(item.statuses[key] || 'suggested')}">
        <div class="ml-review-head">
          <strong>${label}</strong>
          <span class="ml-status-pill">${esc(item.statuses[key] || 'suggested')}</span>
        </div>
        ${multiline
          ? `<textarea class="input ml-editor" rows="${key === 'description' ? 4 : 3}" data-session-id="${esc(item.sessionId)}" data-field="${key}">${esc(value)}</textarea>`
          : `<input class="input ml-editor" value="${esc(value)}" data-session-id="${esc(item.sessionId)}" data-field="${key}" />`}
        <div class="ml-review-actions">
          <button type="button" class="btn secondary btn-sm" data-action="accept" data-session-id="${esc(item.sessionId)}" data-field="${key}">Accept</button>
          <button type="button" class="btn ghost btn-sm" data-action="reset" data-session-id="${esc(item.sessionId)}" data-field="${key}">Reset</button>
          <button type="button" class="btn secondary btn-sm ml-copy" data-copy="${esc(value)}" title="Copy ${label}"><i data-lucide="copy"></i> Copy</button>
        </div>
      </div>`;

    return `
      <div class="ml-card ml-card-hardened">
        <div class="ml-card-header">
          <div class="ml-card-title-group">
            <img src="${esc(item.thumbnailUrl || '')}" class="ml-card-thumb" alt="${esc(item.fileName || '')}" />
            <div class="ml-card-meta">
              <span class="ml-index-badge">#${esc(item.designIndex)}</span>
              <span class="ml-file-name" title="${esc(item.fileName || '')}">${esc(item.fileName || `Design #${item.designIndex}`)}</span>
            </div>
          </div>
          <div class="ml-badge-stack">
            <span class="ml-card-safe ${badgeClass}">${listing.requires_manual_review ? 'Manual review' : 'Ready to review'}</span>
            <span class="ml-card-safe badge-safe">${esc(listing.source || 'unknown')}</span>
          </div>
        </div>
        <div class="ml-card-body">
          <div class="ml-insight-grid">
            <div class="ml-insight"><span>Confidence</span><strong>${Math.round((listing.confidence_score || 0) * 100)}%</strong></div>
            <div class="ml-insight"><span>Session</span><strong>${esc(String(item.sessionId).slice(0, 8))}</strong></div>
            <div class="ml-insight"><span>Price</span><strong>${esc(item.review.priceRange)}</strong></div>
          </div>
          ${field('title', 'Suggested title', item.review.title, false)}
          ${field('category', 'Suggested category', item.review.category, false)}
          ${field('priceRange', 'Suggested price range', item.review.priceRange, false)}
          ${field('bulletPoints', 'Bullet points', item.review.bulletPoints, true)}
          ${field('description', 'Description', item.review.description, true)}
          <div class="ml-grounding-box">
            <strong>Grounding notes</strong>
            <ul>${(Array.isArray(listing.grounding_notes) ? listing.grounding_notes : []).map((note) => `<li>${esc(note)}</li>`).join('')}</ul>
          </div>
          <div class="ml-platform-preview">
            <div class="ml-review-head">
              <strong>Platform payload preview</strong>
              <button type="button" class="btn secondary btn-sm ml-copy" data-copy='${esc(JSON.stringify(payload, null, 2))}' title="Copy payload">Copy JSON</button>
            </div>
            <pre>${esc(JSON.stringify(payload, null, 2))}</pre>
          </div>
        </div>
      </div>`;
  }

  views.magicListing = function renderMagicListingPatched() {
    let listingFiles = [];
    let abortController = null;
    let tracker = null;
    let currentPlatform = 'amazon';
    const allListings = [];
    const PLATFORM_SUBTITLES = {
      amazon: 'Image-grounded Amazon-style listing suggestions with confidence scoring.',
      teepublic: 'Reviewable TeePublic suggestions with editable tags and grounded notes.',
      etsy: 'Structured Etsy-ready drafts with category, price range, and manual-review signals.',
    };

    viewMount('magicListing').innerHTML = `
      <div class="view">
        <header class="view-header">
          <div>
            <h1 class="page-title">Magic Listing</h1>
            <p class="view-sub" id="mlSubtitle">${PLATFORM_SUBTITLES[currentPlatform]}</p>
          </div>
        </header>
        <div class="platform-toggle" id="mlPlatformToggle">
          <button type="button" class="platform-toggle-btn active" data-platform="amazon">Amazon</button>
          <button type="button" class="platform-toggle-btn" data-platform="teepublic">TeePublic</button>
          <button type="button" class="platform-toggle-btn" data-platform="etsy">Etsy</button>
        </div>
        <div class="ml-workspace">
          <section class="card panel ml-panel">
            <div class="stage-head"><span class="field-label">Design uploads</span><span class="stage-counter" id="mlCounter">0 / 100</span></div>
            <div class="dropzone" id="mlDrop">
              <input id="mlFileInput" type="file" accept="image/*" multiple class="hidden" />
              <div class="dropzone-content"><strong>Drop design images here</strong><span>or click to browse</span></div>
            </div>
            <div class="ml-stage-actions">
              <button id="mlAddMore" class="btn secondary" type="button">Add files</button>
              <button id="mlFromLibrary" class="btn secondary" type="button">From library</button>
              <button id="mlReplace" class="btn secondary" type="button">Replace</button>
              <button id="mlClearAll" class="btn ghost" type="button">Clear</button>
            </div>
            <div class="thumbs-row hidden" id="mlThumbs"></div>
            <div class="field" style="margin-top:1rem;"><textarea id="mlRefData" class="input" rows="8" placeholder="Optional notes, customer research, keywords, or category hints."></textarea></div>
            <div class="ml-stage-actions" style="margin-top:1rem;">
              <button id="mlGenerate" class="btn primary" type="button">Generate listings</button>
              <button id="mlStop" class="btn secondary" type="button" disabled>Stop</button>
              <a id="mlOpenLibrary" href="#" class="btn ghost">Open library</a>
            </div>
            <div id="mlProgressArea" class="hidden" style="margin-top:1rem;"><div class="progress-line" id="mlProgress"><span>Waiting…</span></div><div class="progress-bar"><span id="mlProgressFill" class="progress-fill" style="width:0%"></span></div></div>
          </section>
          <section class="card panel ml-results-section hidden" id="mlResultsSection">
            <div class="stage-head"><span class="field-label">Review queue</span><div class="ml-results-head-actions"><span class="stage-counter" id="mlOutCount">0 listings</span><button id="btn-download-listings-csv" class="btn secondary hidden" type="button">Download CSV</button></div></div>
            <div class="ml-results-grid" id="mlResults"></div>
          </section>
        </div>
      </div>`;
    renderIcons();

    const dropzone = $('#mlDrop');
    const fileInput = $('#mlFileInput');
    const thumbsRow = $('#mlThumbs');
    const counter = $('#mlCounter');
    const refData = $('#mlRefData');
    const generateBtn = $('#mlGenerate');
    const stopBtn = $('#mlStop');
    const progressArea = $('#mlProgressArea');
    const progressLine = $('#mlProgress');
    const subtitle = $('#mlSubtitle');
    const resultsGrid = $('#mlResults');
    const downloadCsvBtn = $('#btn-download-listings-csv');

    function renderListingGrid() {
      resultsGrid.innerHTML = allListings.map((item) => magicListingCard(item)).join('');
      $('#mlOutCount').textContent = `${allListings.length} listing${allListings.length === 1 ? '' : 's'}`;
      renderIcons();
    }

    async function syncReviewField(item, fieldName) {
      try {
        await fetchWithAuth('/api/magic-listing/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: item.sessionId,
            fieldName,
            aiValue: item.originalReview[fieldName],
            acceptedValue: item.review[fieldName],
            status: item.statuses[fieldName],
            platform: item.platform,
          }),
        });
      } catch (err) {
        console.warn('Could not persist review field', fieldName, err);
      }
    }

    function updateCounter() {
      counter.textContent = `${listingFiles.length} / 100`;
    }

    function renderThumbs() {
      if (listingFiles.length === 0) {
        thumbsRow.classList.add('hidden');
        thumbsRow.innerHTML = '';
      } else {
        thumbsRow.classList.remove('hidden');
        thumbsRow.innerHTML = listingFiles.map((file, idx) => `
          <div class="thumb-card" data-idx="${idx}">
            <img src="${URL.createObjectURL(file)}" alt="thumb" />
            <button type="button" class="thumb-del" data-del="${idx}" title="Remove"><i data-lucide="x"></i></button>
          </div>`).join('');
        renderIcons();
      }
      updateCounter();
    }

    function addFiles(newFiles) {
      listingFiles = [...listingFiles, ...Array.from(newFiles)].slice(0, 100);
      renderThumbs();
    }

    bindDropAndPasteZone({ dropzoneEl: dropzone, inputEl: fileInput, onFileReceived: addFiles });
    $('#mlAddMore').addEventListener('click', () => fileInput.click());
    $('#mlFromLibrary').addEventListener('click', () => openLibraryPicker({ currentCount: listingFiles.length, onConfirm: (files) => addFiles(files) }));
    $('#mlClearAll').addEventListener('click', () => { listingFiles = []; fileInput.value = ''; renderThumbs(); });
    $('#mlReplace').addEventListener('click', () => { listingFiles = []; fileInput.value = ''; fileInput.click(); });
    $('#mlOpenLibrary').addEventListener('click', (e) => { e.preventDefault(); showView('designs'); });
    thumbsRow.addEventListener('click', (e) => {
      const delBtn = e.target.closest('[data-del]');
      if (!delBtn) return;
      listingFiles.splice(Number(delBtn.dataset.del), 1);
      renderThumbs();
    });
    downloadCsvBtn?.addEventListener('click', () => exportListingsToCSV(allListings));

    $('#mlPlatformToggle').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-platform]');
      if (!btn || btn.dataset.platform === currentPlatform) return;
      currentPlatform = btn.dataset.platform;
      $$('#mlPlatformToggle .platform-toggle-btn').forEach((node) => node.classList.toggle('active', node === btn));
      subtitle.textContent = PLATFORM_SUBTITLES[currentPlatform] || '';
    });

    resultsGrid.addEventListener('input', (e) => {
      const field = e.target.closest('[data-field]');
      if (!field) return;
      const item = allListings.find((entry) => String(entry.sessionId) === String(field.dataset.sessionId));
      if (!item) return;
      item.review[field.dataset.field] = field.value;
      item.statuses[field.dataset.field] = field.value === item.originalReview[field.dataset.field] ? 'suggested' : 'edited';
    });

    resultsGrid.addEventListener('click', async (e) => {
      const copyBtn = e.target.closest('.ml-copy');
      if (copyBtn) return copyWithFeedback(copyBtn, copyBtn.dataset.copy, copyBtn.title.replace('Copy ', ''));
      const actionBtn = e.target.closest('[data-action]');
      if (!actionBtn) return;
      const item = allListings.find((entry) => String(entry.sessionId) === String(actionBtn.dataset.sessionId));
      if (!item) return;
      const field = actionBtn.dataset.field;
      if (actionBtn.dataset.action === 'accept') {
        item.statuses[field] = 'accepted';
        await syncReviewField(item, field);
        renderListingGrid();
      }
      if (actionBtn.dataset.action === 'reset') {
        item.review[field] = item.originalReview[field];
        item.statuses[field] = 'suggested';
        await syncReviewField(item, field);
        renderListingGrid();
      }
    });

    generateBtn.addEventListener('click', async () => {
      if (listingFiles.length === 0) return alert('Upload at least one design to generate listings for.');
      abortController = new AbortController();
      generateBtn.disabled = true;
      stopBtn.disabled = false;
      downloadCsvBtn?.classList.add('hidden');
      progressArea.classList.remove('hidden');
      const labelEl = progressLine.querySelector('span');
      tracker = new GenerationProgressTracker({ barEl: $('#mlProgressFill'), labelEl, totalItems: 1, isTextMode: true });
      tracker.stop();
      tracker.startItem('batch');
      labelEl.textContent = 'Preparing designs…';
      $('#mlResultsSection').classList.remove('hidden');
      allListings.length = 0;
      renderListingGrid();
      try {
        const designs = [];
        for (let i = 0; i < listingFiles.length; i++) {
          const file = listingFiles[i];
          labelEl.textContent = `Preparing design ${i + 1} of ${listingFiles.length}…`;
          const thumbnailUrl = await fileToBase64(file);
          const visionBase64 = await optimizeImageForVision(file);
          designs.push({ imageBase64: visionBase64, fileName: file.name, designIndex: i + 1, thumbnailUrl });
        }
        const res = await fetchWithAuth('/api/magic-listing/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            designs: designs.map(({ imageBase64, fileName, designIndex }) => ({ imageBase64, fileName, designIndex })),
            referenceData: refData.value.trim(),
            platform: currentPlatform,
          }),
          signal: abortController.signal,
        });
        if (!res.ok) {
          const errJson = await res.json().catch(() => ({}));
          throw new Error(errJson.error || `Request failed (${res.status})`);
        }
        const data = await res.json();
        tracker.finishItem('batch');
        tracker.completeAll();
        $('#mlProgressFill').style.width = '100%';
        labelEl.textContent = `Completed: ${data.results?.length || 0} listing(s) generated.`;
        (data.results || []).forEach((result) => {
          const prepared = designs.find((d) => d.designIndex === result.designIndex);
          allListings.push(buildEditableItem(result, prepared?.thumbnailUrl || '', currentPlatform));
        });
        renderListingGrid();
        if (allListings.length > 0 && downloadCsvBtn) downloadCsvBtn.classList.remove('hidden');
      } catch (err) {
        if (tracker) tracker.stop();
        labelEl.textContent = err.name === 'AbortError' ? 'Generation cancelled by user.' : `Error: ${err.message || err}`;
        labelEl.style.color = err.name === 'AbortError' ? '#f59e0b' : '#ef4444';
      } finally {
        generateBtn.disabled = false;
        stopBtn.disabled = true;
        abortController = null;
      }
    });

    stopBtn.addEventListener('click', () => {
      stopBtn.disabled = true;
      if (abortController) {
        try { abortController.abort(); } catch (_) {}
      }
      if (tracker?.stop) tracker.stop();
      generateBtn.disabled = false;
      const progressLabel = progressLine.querySelector('span');
      if (progressLabel) progressLabel.textContent = 'Generation stopped';
      fetchWithAuth('/api/generate/cancel', { method: 'POST' }).catch((err) => console.warn('Cancel signal delivery failed:', err));
    });
  };
})();
