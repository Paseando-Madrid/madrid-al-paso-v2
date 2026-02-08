/* Cooltura — Mosaic + Overlay anchored (premium)
   - NO rompe automatización JSON (/data)
   - Mantiene efecto hover dim/zoom
   - Overlay tipo “hoja” anclada + fondo fantasma (ghost real) + CSS var --overlay-bg-url
   - Swap premium al cambiar de card (sin brusquedad)
   - Museos: render editorial + pin 📍 (Google Maps en nueva pestaña)
*/

const modal  = document.getElementById('kModal');
const mosaic = document.getElementById('kMosaic');

if (!modal || !mosaic) {
  // No rompe nada si Cooltura no existe en otra página
} else {

  const kTitle = document.getElementById('kTitle');
  const kDeck  = document.getElementById('kDeck');
  const kMeta  = document.getElementById('kMeta');
  const kList  = document.getElementById('kList');

  const cards    = Array.from(document.querySelectorAll('.k-card'));
  const closeBtn = modal.querySelector('.k-close');

  const sheet  = modal.querySelector('.k-sheet');
  const canvas = document.querySelector('.cooltura-canvas');
  const ghost  = modal.querySelector('.k-sheet-ghost');

  const tplMuseo = document.getElementById('tpl-museo');
  const tplPin   = document.getElementById('tpl-pin');

  const CFG = {
    directo:   { title:"Conciertos esta semana",     deck:"Una selección breve para escuchar Madrid en directo.",            json:"data/agenda-weekly.json",  mode:"items" },
    ninos:     { title:"Disfrutar Madrid con niños", deck:"Planes culturales y fáciles para hacerlo con ellos esta semana.", json:"data/kids-weekly.json",    mode:"items" },
    expo:      { title:"Exposiciones de este mes",   deck:"Salas, museos y montajes que merecen la visita.",                 json:"data/agenda-monthly.json", mode:"group", group:"exhibitions" },
    cartelera: { title:"Obras destacadas",           deck:"Teatro en cartel: propuestas con criterio para este mes.",        json:"data/agenda-monthly.json", mode:"group", group:"theatre" },
    museos:    { title:"Horarios de museos",         deck:"Horarios, días clave y notas útiles para planificar.",            json:"data/museums.json",        mode:"museos" },
    alargar:   { title:"Para alargar el paseo",      deck:"Mercados, mesas y barras para seguir con Madrid a otro ritmo.",   json:"data/leisure.json",        mode:"items" }
  };

  // ---------- DIM / ACTIVE ----------
  let hoverTimer = null;
  let clearTimer = null;

  function setActiveCard(card){
    cards.forEach(c => c.classList.toggle('is-active', c === card));
    mosaic.classList.add('is-dim');
  }

  function clearActive(){
    cards.forEach(c => c.classList.remove('is-active'));
    mosaic.classList.remove('is-dim');
  }

  function scheduleActive(card){
    clearTimeout(clearTimer);
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => setActiveCard(card), 60);
  }

  function scheduleClear(){
    clearTimeout(hoverTimer);
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      if(!modal.classList.contains('is-open')) clearActive();
    }, 140);
  }

  cards.forEach(btn => {
    btn.addEventListener('pointerenter', () => scheduleActive(btn));
    btn.addEventListener('pointerleave', () => scheduleClear());
    btn.addEventListener('focusin',      () => scheduleActive(btn));
    btn.addEventListener('focusout',     () => scheduleClear());
  });

  mosaic.addEventListener('pointerleave', () => scheduleClear());

  // ---------- OVERLAY: BG + POSITION + HEIGHT ----------
  let anchorCard = null;

  function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }

  function getCardBgUrl(cardEl){
    const photo = cardEl?.querySelector('.k-photo');
    if(!photo) return null;
    const bg = getComputedStyle(photo).getPropertyValue('background-image');
    if(!bg) return null;
    const v = bg.trim();
    if(v === '' || v === 'none') return null;
    return v; // url("...")
  }

  function setOverlayBgFromCard(cardEl){
    if(!sheet) return;
    const bg = getCardBgUrl(cardEl);
    sheet.style.setProperty('--overlay-bg-url', bg || 'none');
    if(ghost) ghost.style.backgroundImage = bg || 'none';
  }

  function sizeSheetToCanvas(){
    if(!sheet || !canvas) return;
    const cRect = canvas.getBoundingClientRect();
    const pad = 14;
    const desiredH = Math.max(320, cRect.height - pad * 2);
    sheet.style.height = `${desiredH}px`;
  }

  function positionSheetToCard(cardEl){
    if(!sheet || !canvas || !cardEl) return;

    sizeSheetToCanvas();

    const cRect = canvas.getBoundingClientRect();
    const aRect = cardEl.getBoundingClientRect();
    const sRect = sheet.getBoundingClientRect();

    const ax = aRect.left + aRect.width / 2;
    const ay = aRect.top  + aRect.height / 2;

    let left = ax - (sRect.width  / 2);
    let top  = ay - (sRect.height / 2);
    top -= 10;

    const pad = 14;
    const minLeft = cRect.left + pad;
    const maxLeft = cRect.right - pad - sRect.width;
    const minTop  = cRect.top  + pad;
    const maxTop  = cRect.bottom - pad - sRect.height;

    left = clamp(left, minLeft, Math.max(minLeft, maxLeft));
    top  = clamp(top,  minTop,  Math.max(minTop,  maxTop));

    sheet.style.left = `${left}px`;
    sheet.style.top  = `${top}px`;
  }

  function syncOverlayToCard(cardEl){
    anchorCard = cardEl;
    setOverlayBgFromCard(cardEl);
    if(modal.classList.contains('is-open')){
      requestAnimationFrame(() => positionSheetToCard(cardEl));
    }
  }

  // ---------- SWAP ----------
  function beginSwap(){ if(sheet) sheet.classList.add('is-swap'); }
  function endSwap(){
    if(!sheet) return;
    requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.remove('is-swap')));
  }

  // ---------- MODAL ----------
  function openModal(){
    if (!modal.classList.contains('is-open')) {
      modal.setAttribute('aria-hidden','false');
      document.body.style.overflow = 'hidden';
      void modal.offsetWidth;

      requestAnimationFrame(() => {
        modal.classList.add('is-open');
        if(anchorCard) positionSheetToCard(anchorCard);
        else sizeSheetToCanvas();
        if(closeBtn) closeBtn.focus({ preventScroll: true });
      });
    } else {
      if(anchorCard) requestAnimationFrame(() => positionSheetToCard(anchorCard));
      if(closeBtn) closeBtn.focus({ preventScroll: true });
    }
  }

  function closeModal(){
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden','true');
    document.body.style.overflow = '';

    if (kList) kList.innerHTML = '';
    clearActive();

    anchorCard = null;
    if(sheet){
      sheet.classList.remove('is-swap');
      sheet.style.removeProperty('--overlay-bg-url');
      sheet.style.removeProperty('left');
      sheet.style.removeProperty('top');
      sheet.style.removeProperty('height');
    }
    if(ghost) ghost.style.backgroundImage = 'none';
  }

  if(closeBtn) closeBtn.addEventListener('click', closeModal);
  modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeModal));

  document.addEventListener('keydown', (e) => {
    if(e.key === 'Escape' && modal.classList.contains('is-open')) closeModal();
  });

  function onViewportChange(){
    if(modal.classList.contains('is-open')){
      requestAnimationFrame(() => {
        if(anchorCard) positionSheetToCard(anchorCard);
        else sizeSheetToCanvas();
      });
    }
  }

  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', () => {
    if(modal.classList.contains('is-open') && anchorCard){
      requestAnimationFrame(() => positionSheetToCard(anchorCard));
    }
  }, { passive: true });

  // ---------- HELPERS ----------
  function fmtDate(d){
    try { return new Date(d).toLocaleDateString('es-ES', { year:'numeric', month:'short', day:'2-digit' }); }
    catch { return "—"; }
  }

  function fmtWhen(start){
    if(!start) return "";
    try {
      return new Date(start).toLocaleString('es-ES', {
        weekday:'short', day:'2-digit', month:'short',
        hour:'2-digit', minute:'2-digit'
      });
    } catch { return ""; }
  }

  function safeText(v){ return (v ?? '').toString(); }

  function mapsUrlFromQuery(q){
    const query = safeText(q).trim();
    if(!query) return "";
    return `https://www.google.com/maps?q=${encodeURIComponent(query)}`;
  }

  function isSafeHttpUrl(url){
    try{
      const u = new URL(url, window.location.href);
      return u.protocol === 'http:' || u.protocol === 'https:';
    }catch{
      return false;
    }
  }

  // ---------- RENDER (GENÉRICO) ----------
  function renderItems(items){
    const max = Math.min(items.length, 8);
    if(!max){
      kList.innerHTML = '<p class="k-empty">Ahora mismo no hay recomendaciones publicadas. Vuelve pronto.</p>';
      return;
    }

    kList.innerHTML = items.slice(0, max).map(it => {
      const place = [it.venue, it.area].filter(Boolean).join(' · ');
      const when  = fmtWhen(it.start);
      const meta  = [place, when].filter(Boolean).join(' · ');
      const desc  = it.excerpt ? it.excerpt : meta;

      const url = it.url && isSafeHttpUrl(it.url) ? it.url : "";

      return `
        <div class="k-item">
          <h4>${safeText(it.title) || "—"}</h4>
          <p>${safeText(desc) || ""}</p>
          ${url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">Ver detalles →</a>` : ``}
        </div>
      `;
    }).join('');
  }

  // ---------- RENDER (MUSEOS) ----------
  function renderMuseos(items){
    const list = Array.isArray(items) ? items : [];
    const max  = Math.min(list.length, 10);

    if(!max){
      kList.innerHTML = '<p class="k-empty">Ahora mismo no hay museos publicados. Sube <code>data/museums.json</code> y se llenará automáticamente.</p>';
      return;
    }

    if(tplMuseo && 'content' in tplMuseo){
      kList.innerHTML = '';
      const frag = document.createDocumentFragment();

      for(let i=0; i<max; i++){
        const it = list[i] || {};
        const node = tplMuseo.content.firstElementChild.cloneNode(true);

        const titleStrong = node.querySelector('.m-title-strong');
        const rowHours    = node.querySelector('.m-hours');
        const rowFree     = node.querySelector('.m-free');
        const addrText    = node.querySelector('.m-addr-text');
        const addrPin     = node.querySelector('.m-addr-pin');

        const name = safeText(it.name || it.title);
        const hours = safeText(it.hours || it.openingHours || it.horario);
        const free  = safeText(it.free || it.freeHours || it.gratis);
        const addr  = safeText(it.address || it.direccion);

        if(titleStrong) titleStrong.textContent = name || "—";
        if(rowHours) rowHours.textContent = hours ? `Horario: ${hours}` : '';
        if(rowFree)  rowFree.textContent  = free  ? `Día gratuito: ${free}` : '';
        if(addrText) addrText.textContent = addr ? `Dirección: ${addr} · ` : '';

        let maps = safeText(it.mapsUrl || it.maps || it.gmaps);
        if(!maps){
          const q = [name, addr, 'Madrid'].filter(Boolean).join(', ');
          maps = mapsUrlFromQuery(q);
        }
        if(!isSafeHttpUrl(maps)) maps = "";

        if(addrPin){
          addrPin.innerHTML = '';
          if(maps){
            if(tplPin && 'content' in tplPin){
              const pin = tplPin.content.firstElementChild.cloneNode(true);
              pin.href = maps;
              pin.setAttribute('aria-label', `Ver ubicación de ${name || 'este lugar'} en Google Maps`);
              addrPin.appendChild(pin);
            } else {
              const a = document.createElement('a');
              a.className = 'pm-pin';
              a.href = maps;
              a.target = '_blank';
              a.rel = 'noopener noreferrer';
              a.setAttribute('aria-label', `Ver ubicación de ${name || 'este lugar'} en Google Maps`);
              a.textContent = '📍';
              addrPin.appendChild(a);
            }
          }
        }

        frag.appendChild(node);
      }

      kList.appendChild(frag);
      return;
    }

    // Fallback
    kList.innerHTML = list.slice(0, max).map(it => {
      const name  = safeText(it.name || it.title) || "—";
      const hours = safeText(it.hours || it.openingHours || it.horario);
      const free  = safeText(it.free || it.freeHours || it.gratis);
      const addr  = safeText(it.address || it.direccion);

      let maps = safeText(it.mapsUrl || it.maps || it.gmaps);
      if(!maps){
        const q = [name, addr, 'Madrid'].filter(Boolean).join(', ');
        maps = mapsUrlFromQuery(q);
      }
      if(!isSafeHttpUrl(maps)) maps = "";

      const pin = maps
        ? `<a class="pm-pin" href="${maps}" target="_blank" rel="noopener noreferrer" aria-label="Ver ubicación de ${name} en Google Maps">📍</a>`
        : ``;

      return `
        <article class="m-item">
          <h4 class="m-title"><strong>${name}</strong></h4>
          ${hours ? `<p class="m-row">Horario: ${hours}</p>` : ``}
          ${free ? `<p class="m-row">Día gratuito: ${free}</p>` : ``}
          ${addr ? `<p class="m-row m-addr">Dirección: ${addr} · ${pin}</p>` : ``}
        </article>
      `;
    }).join('');
  }

  // ---------- LOAD + RENDER ----------
  async function loadAndRender(key){
    const cfg = CFG[key];
    if(!cfg) return;

    beginSwap();

    kTitle.textContent = cfg.title;
    kDeck.textContent  = cfg.deck;
    kMeta.textContent  = 'Cargando…';
    kList.innerHTML = '';

    openModal();

    try{
      const res = await fetch(cfg.json, { cache: 'no-store' });
      if(!res.ok) throw new Error("fetch failed");
      const data = await res.json();

      const updated = data.updatedAt ? fmtDate(data.updatedAt) : "—";
      kMeta.textContent = `Actualizado: ${updated}`;

      if(cfg.mode === "museos"){
        renderMuseos(Array.isArray(data.items) ? data.items : []);
        if(anchorCard) requestAnimationFrame(() => positionSheetToCard(anchorCard));
        endSwap();
        return;
      }

      if(cfg.mode === "items"){
        renderItems(Array.isArray(data.items) ? data.items : []);
        if(anchorCard) requestAnimationFrame(() => positionSheetToCard(anchorCard));
        endSwap();
        return;
      }

      if(cfg.mode === "group"){
        const groups = Array.isArray(data.groups) ? data.groups : [];
        const g = groups.find(x => x.category === cfg.group);

        if(g?.deck) kDeck.textContent = g.deck;
        renderItems(Array.isArray(g?.items) ? g.items : []);

        if(anchorCard) requestAnimationFrame(() => positionSheetToCard(anchorCard));
        endSwap();
        return;
      }

      kList.innerHTML = '<p class="k-empty">No hay datos disponibles.</p>';
      if(anchorCard) requestAnimationFrame(() => positionSheetToCard(anchorCard));
      endSwap();
    } catch {
      kMeta.textContent = 'No se pudo cargar la información.';
      kList.innerHTML = '<p class="k-empty">Cuando subas los JSON en /data, este overlay se llenará automáticamente.</p>';
      if(anchorCard) requestAnimationFrame(() => positionSheetToCard(anchorCard));
      endSwap();
    }
  }

  // ---------- CLICK CARDS ----------
  cards.forEach(btn => {
    btn.addEventListener('click', () => {
      clearTimeout(hoverTimer);
      clearTimeout(clearTimer);

      setActiveCard(btn);
      syncOverlayToCard(btn);

      const family = btn.dataset.family;
      loadAndRender(family);
    });
  });

}

