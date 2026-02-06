/* Cooltura — Mosaic + Overlay anchored (premium)
   - NO rompe automatización JSON (/data)
   - Mantiene efecto hover dim/zoom
   - Overlay tipo “hoja” anclada + fondo fantasma por CSS var --overlay-bg-url
   - Swap premium al cambiar de card (sin brusquedad)
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

  // Elementos para overlay anclado
  const sheet  = modal.querySelector('.k-sheet');
  const canvas = document.querySelector('.cooltura-canvas');

  // ---------- CONFIG (NO TOCAR CONTRATO) ----------
  const CFG = {
    directo:   { title:"Conciertos esta semana",        deck:"Una selección breve para escuchar Madrid en directo.",                json:"data/agenda-weekly.json",  mode:"items" },
    ninos:     { title:"Disfrutar Madrid con niños",    deck:"Planes culturales y fáciles para hacerlo con ellos esta semana.",     json:"data/kids-weekly.json",    mode:"items" },
    expos:     { title:"Exposiciones de este mes",      deck:"Salas, museos y montajes que merecen la visita.",                     json:"data/agenda-monthly.json", mode:"group", group:"exhibitions" },
    cartelera: { title:"Obras destacadas",              deck:"Teatro en cartel: propuestas con criterio para este mes.",            json:"data/agenda-monthly.json", mode:"group", group:"theatre" },
    museo:     { title:"Horarios de museos",            deck:"Horarios, días clave y notas útiles para planificar.",                json:"data/museums.json",        mode:"items" },
    alarga:    { title:"Para alargar el paseo",         deck:"Mercados, mesas y barras para seguir con Madrid a otro ritmo.",       json:"data/leisure.json",        mode:"items" }
  };

  // ---------- DIM / ACTIVE (NO CAMBIAR EL EFECTO) ----------
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

  // ---------- OVERLAY: BG + POSITION ----------
  let anchorCard = null;

  function getCardBgUrl(cardEl){
    // Robusto: lee la propiedad exacta (evita "none" por overrides raros)
    const photo = cardEl?.querySelector('.k-photo');
    if(!photo) return null;

    const bg = getComputedStyle(photo).getPropertyValue('background-image');
    if(!bg) return null;

    const v = bg.trim();
    if(v === '' || v === 'none') return null;

    return v; // "url("...")"
  }

  function setOverlayBgFromCard(cardEl){
    if(!sheet) return;
    const bg = getCardBgUrl(cardEl);
    sheet.style.setProperty('--overlay-bg-url', bg || 'none');
  }

  function clamp(n, min, max){
    return Math.max(min, Math.min(max, n));
  }

  function positionSheetToCard(cardEl){
    if(!sheet || !canvas || !cardEl) return;

    const cRect = canvas.getBoundingClientRect();
    const aRect = cardEl.getBoundingClientRect();

    // Importante: medir sheet "real" (aunque esté con blur/opacidad)
    const sRect = sheet.getBoundingClientRect();

    const ax = aRect.left + aRect.width / 2;
    const ay = aRect.top  + aRect.height / 2;

    let left = ax - (sRect.width  / 2);
    let top  = ay - (sRect.height / 2);

    // Nudge editorial para sensación “desplegar”
    top -= 10;

    // Clamp dentro del canvas
    const pad = 14;
    const minLeft = cRect.left + pad;
    const maxLeft = cRect.right - pad - sRect.width;
    const minTop  = cRect.top  + pad;
    const maxTop  = cRect.bottom - pad - sRect.height;

    // Si el sheet es más grande que el canvas en algún eje, evitamos NaN/flip
    const safeMaxLeft = Math.max(minLeft, maxLeft);
    const safeMaxTop  = Math.max(minTop,  maxTop);

    left = clamp(left, minLeft, safeMaxLeft);
    top  = clamp(top,  minTop,  safeMaxTop);

    // NOTA: sheet debe ser position:absolute (lo hará el CSS)
    sheet.style.left = `${left}px`;
    sheet.style.top  = `${top}px`;
  }

  function syncOverlayToCard(cardEl){
    anchorCard = cardEl;
    setOverlayBgFromCard(cardEl);

    // Si ya está abierto, reancla en el próximo frame (por si cambia alto)
    if(modal.classList.contains('is-open')){
      requestAnimationFrame(() => positionSheetToCard(cardEl));
    }
  }

  // ---------- SWAP premium (anti-brusco) ----------
  function beginSwap(){
    if(!sheet) return;
    sheet.classList.add('is-swap');
  }

  function endSwap(){
    if(!sheet) return;
    // doble RAF = asegura que el navegador aplique transiciones con contenido nuevo
    requestAnimationFrame(() => {
      requestAnimationFrame(() => sheet.classList.remove('is-swap'));
    });
  }

  // ---------- MODAL OPEN/CLOSE ----------
  function openModal(){
    if (!modal.classList.contains('is-open')) {
      modal.setAttribute('aria-hidden','false');
      document.body.style.overflow = 'hidden';

      // Reflow
      void modal.offsetWidth;

      requestAnimationFrame(() => {
        modal.classList.add('is-open');

        // Posiciona antes de enfocar para evitar “salto”
        if(anchorCard) positionSheetToCard(anchorCard);

        if(closeBtn) closeBtn.focus({ preventScroll: true });
      });
    } else {
      // ya abierto: reancla sin reanimar el modal completo
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

    // Limpieza overlay
    anchorCard = null;
    if(sheet){
      sheet.classList.remove('is-swap');
      sheet.style.removeProperty('--overlay-bg-url');
      sheet.style.removeProperty('left');
      sheet.style.removeProperty('top');
    }
  }

  // Cierre: redundante a propósito (a prueba de fallos)
  if(closeBtn) closeBtn.addEventListener('click', closeModal);
  modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeModal));

  document.addEventListener('keydown', (e) => {
    if(e.key === 'Escape' && modal.classList.contains('is-open')) closeModal();
  });

  // Reposiciona en resize/scroll si está abierto
  window.addEventListener('resize', () => {
    if(modal.classList.contains('is-open') && anchorCard){
      requestAnimationFrame(() => positionSheetToCard(anchorCard));
    }
  });

  window.addEventListener('scroll', () => {
    if(modal.classList.contains('is-open') && anchorCard){
      requestAnimationFrame(() => positionSheetToCard(anchorCard));
    }
  }, { passive: true });

  // ---------- FORMATTERS / RENDER ----------
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

      return `
        <div class="k-item">
          <h4>${it.title || "—"}</h4>
          <p>${desc || ""}</p>
          ${it.url ? `<a href="${it.url}" target="_blank" rel="noopener">Ver detalles →</a>` : ``}
        </div>
      `;
    }).join('');
  }

  async function loadAndRender(key){
    const cfg = CFG[key];
    if(!cfg) return;

    // Swap suave (solo contenido)
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

      // ancla + bg fantasma (sin tocar automatización)
      syncOverlayToCard(btn);

      // automatización intacta
      loadAndRender(btn.dataset.open);
    });
  });

}
