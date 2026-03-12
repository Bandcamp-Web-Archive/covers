/* ============================================================
 *  COVER ART ARCHIVE — gallery.js
 * ============================================================ */

'use strict';

// ============================================================
// STATE
// ============================================================

const state = {
  allReleases:      [],   // flat: { title, artist, service, album_url, jpg6_url, jpg6_thumb, tracks[], _artistKey }
  artistMap:        {},   // artistKey -> [releases]
  filteredReleases: [],
  activeArtists:    new Set(),
  activeServices:   new Set(),
  trackOnly:        false,
  layout:           'grid',   // 'grid' | 'list'
  page:             0,

  // lightbox
  lbIndex:          0,        // index into filteredReleases (or track array)
  lbContext:        null,     // null = main gallery, array = track list

  // artist bar cache
  _artistBarData:   {},
};

const PAGE_SIZE = 80;


// ============================================================
// BOOTSTRAP
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  restorePrefs();
  document.getElementById('search').addEventListener('input', debounce(applyFilters, 180));
  loadData();
  bindLightbox();
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeTrackDrawer();
  });
});

async function loadData() {
  setLoader('Loading data.json…', 10);
  let data;
  try {
    const r = await fetch('data.json');
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
  } catch (e) {
    setLoader('Error loading data.json', 0);
    console.error(e);
    return;
  }

  setLoader('Processing…', 60);

  const services = data.services || {};
  for (const [svcName, artists] of Object.entries(services)) {
    for (const artistEntry of artists) {
      const artistName = artistEntry.artist || 'Unknown Artist';
      const artistId   = artistEntry.artist_id || artistEntry.band_id || '';
      // Unique key: service + id (or name if no id) — prevents same-name artists
      // from different services or with different IDs from being merged.
      const artistKey  = svcName + '::' + (artistId || artistName);
      if (!state.artistMap[artistKey]) state.artistMap[artistKey] = [];

      for (const rel of (artistEntry.releases || [])) {
        const enriched = {
          ...rel,
          service:     svcName,
          _artistKey:  artistKey,
          _artistName: artistName,
        };
        state.artistMap[artistKey].push(enriched);
        state.allReleases.push(enriched);
      }
    }
  }

  // Pre-sort alphabetically by artist then title
  state.allReleases.sort((a, b) =>
  a._artistKey.localeCompare(b._artistKey) || (a.title || '').localeCompare(b.title || ''));

  setLoader('Rendering…', 90);
  buildServiceFilters();
  buildArtistBar();
  updateStats();
  applyFilters();

  document.getElementById('loading').style.display = 'none';
  document.getElementById('content').style.display = '';
  setLoader('', 100);
}


// ============================================================
// FILTERS
// ============================================================

function applyFilters() {
  const q    = document.getElementById('search').value.trim().toLowerCase();
  const sort = document.getElementById('sort-select').value;

  let results = state.allReleases;

  if (q) {
    results = results.filter(r =>
    (r._artistName || '').toLowerCase().includes(q) ||
    (r.title      || '').toLowerCase().includes(q) ||
    (r.artist     || '').toLowerCase().includes(q)
    );
  }

  if (state.activeServices.size > 0) {
    results = results.filter(r => state.activeServices.has(r.service));
  }

  if (state.activeArtists.size > 0) {
    results = results.filter(r => state.activeArtists.has(r._artistKey));
  }

  if (state.trackOnly) {
    results = results.filter(r => r.tracks && r.tracks.length > 0);
  }

  results = [...results];
  switch (sort) {
    case 'artist-asc':  results.sort((a, b) => a._artistKey.localeCompare(b._artistKey)); break;
    case 'artist-desc': results.sort((a, b) => b._artistKey.localeCompare(a._artistKey)); break;
    case 'title-asc':   results.sort((a, b) => (a.title || '').localeCompare(b.title || '')); break;
    case 'title-desc':  results.sort((a, b) => (b.title || '').localeCompare(a.title || '')); break;
  }

  state.filteredReleases = results;
  state.page = 0;

  updateStats();
  render();
}


// ============================================================
// TOGGLE HELPERS  (called from HTML / chips)
// ============================================================

window.toggleArtist = function (key) {
  if (state.activeArtists.has(key)) state.activeArtists.delete(key);
  else state.activeArtists.add(key);
  document.querySelectorAll('.artist-chip').forEach(c =>
  c.classList.toggle('active', state.activeArtists.has(c.dataset.artist)));
  applyFilters();
};

window.filterArtistChips = function (q) {
  renderArtistChips(q);
};

window.clearArtistFilter = function () {
  state.activeArtists.clear();
  buildArtistBar();
  applyFilters();
};

window.toggleService = function (svc) {
  if (state.activeServices.has(svc)) state.activeServices.delete(svc);
  else state.activeServices.add(svc);
  document.querySelectorAll('.svc-btn').forEach(b =>
  b.classList.toggle('active', state.activeServices.has(b.dataset.svc)));
  applyFilters();
};

window.toggleTrackFilter = function () {
  state.trackOnly = !state.trackOnly;
  document.getElementById('btn-track-only').classList.toggle('active', state.trackOnly);
  applyFilters();
};

window.setLayout = function (layout) {
  state.layout = layout;
  document.getElementById('btn-grid').classList.toggle('active', layout === 'grid');
  document.getElementById('btn-list').classList.toggle('active', layout === 'list');
  try { localStorage.setItem('ca-layout', layout); } catch (_) {}
  render();
};

window.loadMore = function () {
  state.page++;
  renderFlat(document.getElementById('content'), true);
  scheduleLazyLoad();
};

// Called from card HTML
window.openLightbox = function (idx) {
  state.lbContext = null;
  state.lbIndex   = idx;
  showLightboxItem(state.filteredReleases[idx]);
  document.getElementById('lightbox').hidden = false;
};

window.openTrackLightbox = function (rel, trackIdx) {
  state.lbContext = rel.tracks;
  state.lbIndex   = trackIdx;
  showLightboxItem(rel.tracks[trackIdx]);
  document.getElementById('lightbox').hidden = false;
};

window.toggleTrackDrawer = function (idx) {
  const rel = state.filteredReleases[idx];
  if (!rel || !rel.tracks || !rel.tracks.length) return;

  const content  = document.getElementById('content');
  const existing = content.querySelector('.track-drawer');

  // Same card: toggle closed
  if (existing && existing.dataset.forIdx === String(idx)) {
    closeTrackDrawer();
    return;
  }

  if (existing) {
    existing.remove();
    content.querySelectorAll('.release-card.drawer-open').forEach(c => c.classList.remove('drawer-open'));
  }

  const card = content.querySelector(`.release-card[data-idx="${idx}"]`);
  if (!card) return;

  // Build filmstrip items
  const items = rel.tracks.map((t, ti) => {
    const thumb = t.jpg6_thumb || t.jpg6_url || '';
    const img   = thumb
    ? `<img data-src="${escAttr(thumb)}" alt="${escAttr(t.title || '')}" />`
    : `<div class="filmstrip-no-art"></div>`;
    return `<div class="filmstrip-card" onclick="openTrackLightbox(state.filteredReleases[${idx}], ${ti})">
    <div class="filmstrip-img-wrap">${img}</div>
    <div class="filmstrip-title">${esc(t.title || 'Untitled')}</div>
    </div>`;
  }).join('');

  const drawer = document.createElement('div');
  drawer.className    = 'track-drawer';
  drawer.dataset.forIdx = String(idx);
  drawer.innerHTML    = `
  <div class="track-drawer-inner">
  <div class="track-drawer-header">
  <span class="track-drawer-label">Track covers</span>
  <span class="track-drawer-album">${esc(rel.title || 'Untitled')}</span>
  <span class="track-drawer-count">${rel.tracks.length} cover${rel.tracks.length !== 1 ? 's' : ''}</span>
  <button class="track-drawer-close" onclick="closeTrackDrawer()">✕</button>
  </div>
  <div class="track-filmstrip">${items}</div>
  </div>`;

  if (state.layout === 'grid') {
    drawer.style.gridColumn = '1 / -1';
    // Find the last card in the same visual row as the clicked card
    const cardTop  = card.getBoundingClientRect().top;
    const allCards = [...content.querySelectorAll('.release-card[data-idx]')];
    const rowCards = allCards.filter(c => Math.abs(c.getBoundingClientRect().top - cardTop) < 5);
    const anchor   = rowCards[rowCards.length - 1];
    anchor.insertAdjacentElement('afterend', drawer);
  } else {
    // List mode: just insert after the row
    card.insertAdjacentElement('afterend', drawer);
  }

  // Mark active card
  card.classList.add('drawer-open');

  scheduleLazyLoad();
  requestAnimationFrame(() => drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
};

window.closeTrackDrawer = function () {
  const content = document.getElementById('content');
  const drawer  = content && content.querySelector('.track-drawer');
  if (!drawer) return;
  drawer.classList.add('closing');
  drawer.addEventListener('animationend', () => drawer.remove(), { once: true });
  content.querySelectorAll('.release-card.drawer-open').forEach(c => c.classList.remove('drawer-open'));
};

window.collapseArtist = function (id) {
  const sec = document.getElementById(id);
  if (!sec) return;
  sec.classList.toggle('collapsed');
  if (!sec.classList.contains('collapsed') && !sec.dataset.rendered) {
    renderArtistSection(sec);
  }
};


// ============================================================
// RENDER
// ============================================================

// IntersectionObserver for lazily filling artist section cards
let _sectionObserver = null;

function getSectionObserver() {
  if (_sectionObserver) return _sectionObserver;
  _sectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      if (el.dataset.rendered) continue;
      _sectionObserver.unobserve(el);
      renderArtistSection(el);
    }
  }, { rootMargin: '300px' });
  return _sectionObserver;
}

function renderArtistSection(sec) {
  sec.dataset.rendered = '1';
  const key      = sec.dataset.groupKey;
  const releases = state._byGroupCache[key] || [];
  const wrap     = sec.querySelector('.artist-releases');
  if (wrap) {
    if (state.layout === 'grid') {
      wrap.className = 'artist-releases releases-grid';
      wrap.innerHTML = releases.map((r, i) => gridCardHTML(r, state._indexCache[r._uid])).join('');
    } else {
      wrap.className = 'artist-releases releases-list';
      wrap.innerHTML = releases.map((r, i) => listCardHTML(r, state._indexCache[r._uid])).join('');
    }
    scheduleLazyLoad();
  }
}

function render() {
  const content = document.getElementById('content');
  const empty   = document.getElementById('empty');
  const lmWrap  = document.getElementById('load-more-wrap');

  if (state.filteredReleases.length === 0) {
    content.innerHTML    = '';
    content.style.display = '';
    empty.style.display  = 'block';
    lmWrap.style.display = 'none';
    return;
  }

  empty.style.display  = 'none';
  content.style.display = '';

  // Build a uid→filteredIndex cache so cards know their lightbox index
  state._indexCache = {};
  state.filteredReleases.forEach((r, i) => {
    r._uid = r._uid || (r.service + '_' + (r.item_id || i));
    state._indexCache[r._uid] = i;
  });

  renderByArtist(content);
}

function renderByArtist(container) {
  if (_sectionObserver) { _sectionObserver.disconnect(); _sectionObserver = null; }

  const byGroup = {};
  for (const r of state.filteredReleases) {
    const k = r._artistKey;
    if (!byGroup[k]) byGroup[k] = [];
    byGroup[k].push(r);
  }

  const sort = document.getElementById('sort-select').value;
  let keys   = Object.keys(byGroup);
  if (sort === 'artist-desc') {
    keys.sort((a, b) => b.localeCompare(a));
  } else {
    keys.sort((a, b) => a.localeCompare(b));
  }

  state._byGroupCache = byGroup;

  const observer = getSectionObserver();

  const html = keys.map(key => {
    const releases = byGroup[key];
    const id       = sectionId(key);
    const svc      = releases[0].service || '';
    const count    = releases.length;
    const nTracks  = releases.filter(r => r.tracks && r.tracks.length > 0).length;
    const tracksBadge = nTracks > 0
    ? `<span class="artist-service-badge" style="color:var(--accent);border-color:var(--accent2)">${nTracks} w/ tracks</span>`
    : '';
    const svcBadge = `<span class="artist-service-badge">${esc(svc)}</span>`;

    return `
    <div class="artist-section collapsed" id="${escAttr(id)}" data-group-key="${escAttr(key)}">
    <div class="artist-header" onclick="collapseArtist('${escAttr(id)}')">
    <span class="artist-name">${esc(releases[0]._artistName || key)}</span>
    <span class="artist-count">${count} release${count !== 1 ? 's' : ''}</span>
    ${svcBadge}
    ${tracksBadge}
    <span class="artist-collapse-icon">▾</span>
    </div>
    <div class="artist-releases ${state.layout === 'grid' ? 'releases-grid' : 'releases-list'}"></div>
    </div>`;
  }).join('');

  container.innerHTML = html;

  container.querySelectorAll('.artist-section[data-group-key]').forEach(el => {
    observer.observe(el);
  });

  document.getElementById('load-more-wrap').style.display = 'none';
}

function renderFlat(container, append) {
  const to    = Math.min((state.page + 1) * PAGE_SIZE, state.filteredReleases.length);
  const slice = state.filteredReleases.slice(0, to);

  if (state.layout === 'grid') {
    container.innerHTML = `<div class="releases-grid">${
      slice.map((r, i) => gridCardHTML(r, i)).join('')
    }</div>`;
  } else {
    container.innerHTML = `<div class="releases-list">${
      slice.map((r, i) => listCardHTML(r, i)).join('')
    }</div>`;
  }

  const remaining = state.filteredReleases.length - to;
  const lmWrap    = document.getElementById('load-more-wrap');
  if (remaining > 0) {
    lmWrap.style.display = 'block';
    lmWrap.querySelector('button').textContent =
    `Load more (${remaining.toLocaleString()} remaining)`;
  } else {
    lmWrap.style.display = 'none';
  }
}


// ============================================================
// CARD TEMPLATES
// ============================================================

const GRID_SVG = (() => {
  let lines = '';
  for (let i = 0; i <= 40; i += 8) {
    lines += `<line x1="${i}" y1="0" x2="${i}" y2="40" stroke="#555560" stroke-width="0.5"/>`;
    lines += `<line x1="0" y1="${i}" x2="40" y2="${i}" stroke="#555560" stroke-width="0.5"/>`;
  }
  return `<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">${lines}</svg>`;
})();

function gridCardHTML(rel, lbIdx) {
  const thumb       = rel.jpg6_thumb || rel.jpg6_url || '';
  const hasTrackArt = rel.tracks && rel.tracks.length > 0;
  const imgTag      = thumb
  ? `<img class="cover-img" data-src="${escAttr(thumb)}" alt="${escAttr(rel.title || '')}" loading="lazy" />`
  : '';

  const trackBtn = hasTrackArt
  ? `<button class="btn-tracks" onclick="event.stopPropagation();toggleTrackDrawer(${lbIdx})">
  ${rel.tracks.length} track${rel.tracks.length !== 1 ? 's' : ''}
  </button>`
  : '';

  return `
  <div class="release-card" data-idx="${lbIdx}" onclick="openLightbox(${lbIdx})">
  <div class="cover-placeholder">${GRID_SVG}</div>
  ${imgTag}
  <div class="card-overlay">
  <div class="card-title">${esc(rel.title || 'Untitled')}</div>
  <div class="card-artist">${esc(rel.artist || rel._artistName || '')}</div>
  <div class="card-actions">
  <button class="btn-view" onclick="event.stopPropagation();openLightbox(${lbIdx})">View</button>
  ${rel.album_url ? `<a class="btn-source" href="${escAttr(rel.album_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Source ↗</a>` : ''}
  ${trackBtn}
  </div>
  </div>
  </div>`;
}

function listCardHTML(rel, lbIdx) {
  const thumb       = rel.jpg6_thumb || rel.jpg6_url || '';
  const hasTrackArt = rel.tracks && rel.tracks.length > 0;
  const imgTag      = thumb
  ? `<img data-src="${escAttr(thumb)}" alt="${escAttr(rel.title || '')}" />`
  : '';

  const trackBtn = hasTrackArt
  ? `<button class="list-tracks-btn" onclick="toggleTrackDrawer(${lbIdx})">
  ${rel.tracks.length} track${rel.tracks.length !== 1 ? 's' : ''}
  </button>`
  : '';

  return `
  <div class="release-card" data-idx="${lbIdx}">
  <div class="list-thumb-wrap" onclick="openLightbox(${lbIdx})">
  <div class="list-thumb-placeholder">${GRID_SVG}</div>
  ${imgTag}
  </div>
  <div class="list-body">
  <span class="list-title">${esc(rel.title || 'Untitled')}</span>
  <span class="list-artist">${esc(rel.artist || rel._artistName || '')}</span>
  </div>
  <div class="list-actions">
  <span class="list-svc-badge">${esc(rel.service || '')}</span>
  ${trackBtn}
  ${rel.album_url
    ? `<a class="list-link" href="${escAttr(rel.album_url)}" target="_blank" rel="noopener">Source ↗</a>`
    : ''}
    </div>
    </div>`;
}




function bindLightbox() {
  const lb = document.getElementById('lightbox');
  lb.addEventListener('click', e => {
    if (e.target === lb) closeLightbox();
  });
    document.getElementById('lb-close').addEventListener('click', closeLightbox);
    document.getElementById('lb-prev').addEventListener('click', () => shiftLightbox(-1));
    document.getElementById('lb-next').addEventListener('click', () => shiftLightbox(+1));
    document.addEventListener('keydown', e => {
      if (lb.hidden) return;
      if (e.key === 'Escape')     closeLightbox();
      if (e.key === 'ArrowLeft')  shiftLightbox(-1);
      if (e.key === 'ArrowRight') shiftLightbox(+1);
    });
}

function showLightboxItem(item) {
  const img = document.getElementById('lb-img');
  img.src = item.jpg6_url || item.jpg6_thumb || '';
  document.getElementById('lb-title').textContent  = item.title || '';
  document.getElementById('lb-artist').textContent = item.artist || item._artistKey || '';
  document.getElementById('lb-source').href = item.album_url || item.track_url || '#';
  document.getElementById('lb-source').style.display = (item.album_url || item.track_url) ? '' : 'none';
}

function shiftLightbox(delta) {
  const list = state.lbContext || state.filteredReleases;
  const next = state.lbIndex + delta;
  if (next < 0 || next >= list.length) return;
  state.lbIndex = next;
  showLightboxItem(list[next]);
}

function closeLightbox() {
  document.getElementById('lightbox').hidden = true;
}


// ============================================================
// COVER LAZY LOADING  (IntersectionObserver on data-src imgs)
// ============================================================

let _imgObserver = null;
let _lazyTimer   = null;

function scheduleLazyLoad() {
  clearTimeout(_lazyTimer);
  _lazyTimer = setTimeout(lazyLoadCovers, 60);
}

function getImgObserver() {
  if (_imgObserver) return _imgObserver;
  _imgObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      const src = el.dataset.src;
      if (!src) continue;
      el.src = src;
      delete el.dataset.src;
      _imgObserver.unobserve(el);
    }
  }, { rootMargin: '400px' });
  return _imgObserver;
}

function lazyLoadCovers() {
  const obs = getImgObserver();
  document.querySelectorAll('img[data-src]').forEach(el => obs.observe(el));
}


// ============================================================
// ARTIST BAR
// ============================================================

function buildArtistBar() {
  const counts = {};
  for (const r of state.allReleases) {
    const k = r._artistKey;
    counts[k] = (counts[k] || 0) + 1;
  }
  state._artistBarData = counts;
  renderArtistChips('');
}

function renderArtistChips(filter) {
  const bar    = document.getElementById('artist-bar');
  const counts = state._artistBarData;

  const sortedKeys = Object.keys(counts).sort((a, b) => {
    const na = (state.artistMap[a] && state.artistMap[a][0] && state.artistMap[a][0]._artistName) || a;
    const nb = (state.artistMap[b] && state.artistMap[b][0] && state.artistMap[b][0]._artistName) || b;
    return na.localeCompare(nb);
  });
  const visible    = filter
  ? sortedKeys.filter(k => {
    const name = (state.artistMap[k] && state.artistMap[k][0] && state.artistMap[k][0]._artistName) || k;
    return name.toLowerCase().includes(filter.toLowerCase());
  })
  : sortedKeys;

  const hasActive = state.activeArtists.size > 0;
  const clearBtn  = hasActive
  ? `<button class="artist-clear-btn" onclick="clearArtistFilter()">✕ clear</button>`
  : '';

  const chips = visible.map(k => {
    // Display just the artist name, not the internal "service::id" compound key
    const releases = state.artistMap[k] || [];
    const displayName = (releases[0] && releases[0]._artistName) || k;
    const svcLabel = (releases[0] && releases[0].service) || '';
    const active = state.activeArtists.has(k) ? ' active' : '';
    return `<button class="artist-chip${active}" data-artist="${escAttr(k)}"
    onclick="toggleArtist('${escAttr(k)}')">${esc(displayName)}<span class="artist-chip-svc">${esc(svcLabel)}</span>
    <span class="artist-chip-count">${counts[k]}</span>
    </button>`;
  }).join('');

  const existingWrap  = bar.querySelector('.artist-chips-wrap');
  const existingInput = bar.querySelector('.artist-search');
  const clearChanged  = !!bar.querySelector('.artist-clear-btn') !== !!clearBtn;
  const phChanged     = !existingInput;

  if (!existingWrap || clearChanged || phChanged) {
    bar.innerHTML = `
    <span class="artist-bar-label">Artists</span>
    <input type="search" class="artist-search" placeholder="filter artists…"
    oninput="filterArtistChips(this.value)"
    autocomplete="off" spellcheck="false"
    value="${escAttr(filter)}" />
    ${clearBtn}
    <div class="artist-chips-wrap">${chips}</div>`;
  } else {
    existingWrap.innerHTML = chips;
  }
}


// ============================================================
// SERVICE FILTER PILLS
// ============================================================

function buildServiceFilters() {
  const services = [...new Set(state.allReleases.map(r => r.service))].sort();
  const wrap     = document.getElementById('service-filters');
  if (services.length <= 1) { wrap.style.display = 'none'; return; }

  wrap.innerHTML = services.map(svc =>
  `<button class="svc-btn" data-svc="${escAttr(svc)}" onclick="toggleService('${escAttr(svc)}')">${esc(svc)}</button>`
  ).join('');
}


// ============================================================
// STATS BAR
// ============================================================

function updateStats() {
  const total   = state.allReleases.length;
  const shown   = state.filteredReleases.length;
  const artists = Object.keys(state.artistMap).length;

  let html = `<b>${artists.toLocaleString()}</b> artists · <b>${total.toLocaleString()}</b> releases`;
  if (shown !== total) html += ` · <b>${shown.toLocaleString()}</b> shown`;
  document.getElementById('stats-bar').innerHTML = html;
}


// ============================================================
// PERSIST PREFERENCES
// ============================================================

function restorePrefs() {
  try {
    const layout = localStorage.getItem('ca-layout');
    if (layout === 'grid' || layout === 'list') {
      state.layout = layout;
      document.getElementById('btn-grid').classList.toggle('active', layout === 'grid');
      document.getElementById('btn-list').classList.toggle('active', layout === 'list');
    }
  } catch (_) {}
}


// ============================================================
// UTILITY
// ============================================================

function setLoader(text, pct) {
  document.getElementById('loader-text').textContent  = text;
  document.getElementById('loader-fill').style.width  = pct + '%';
}

function sectionId(key) {
  return 'section-' + String(key).replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function esc(s) {
  return String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s) {
  return String(s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Expose state to inline onclick handlers that reference it (openTrackLightbox)
window.state = state;
